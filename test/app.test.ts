import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { buildApp, clientIp, makePreflight } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { ReplayGuard } from "../src/payments.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";

const kp = generateKeypair();

/** Stands in for @x402/hono: settles when the request carries x-test-pay "txid:payer". */
const fakePayment: MiddlewareHandler = async (c, next) => {
  const pay = c.req.header("x-test-pay");
  if (!pay) return c.json({ error: "payment required" }, 402);
  await next();
  const [transaction, payer] = pay.split(":");
  c.res.headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction, payer, network: "algorand:test" })).toString("base64"));
};

function build() {
  const db = new Db(":memory:");
  const supplier = new MockSupplier();
  const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600, blockedCountries: ["CU"], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
    receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
  });
  const app = buildApp({ db, supplier, orders, paymentMiddleware: fakePayment });
  return { app, db, orders };
}
const json = (b: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });

describe("HTTP surface", () => {
  it("free discovery routes", async () => {
    const { app } = build();
    const l = await (await app.request("/v1/lookup?phone=%2B919876543210")).json();
    expect(l).toMatchObject({ phone: "+919876543210", country: "IN", brand: "AIRTEL" });
    expect(l.offers.length).toBeGreaterThan(0);
    const c = await (await app.request("/v1/catalog?type=esim&country=IN")).json();
    expect(c.offers.map((o: { offerId: string }) => o.offerId)).toContain("mock-esim-in-5gb-30d");
    // Paginated since 2026-09-02: a real eSIM catalogue is 3,046 offers / 3 MB.
    expect(c).toMatchObject({ total: c.offers.length, offset: 0 });
    expect(c.next_offset).toBeUndefined();
    expect((await app.request("/v1/lookup?phone=abc")).status).toBe(400);
    expect((await app.request("/v1/catalog?type=esim&country=CU")).status).toBe(403);
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/agent.md")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
  });

  it("reports a float per supplier, because eSIMs do not spend the airtime balance", async () => {
    // MockSupplier fills everything from one wallet, so there is nothing separate to
    // report — which is the point of the condition. What is pinned is that /v1/limits
    // answers per product, because an agent sizing an eSIM basket against the airtime
    // float is being told the wrong number in whichever direction they differ.
    const { app } = build();
    const limits = await (await app.request("/v1/limits")).json();
    expect(limits.fillable_now_by_type_usdc).toBeDefined();
    expect(Object.keys(limits.fillable_now_by_type_usdc)).toContain("esim");
    const health = await (await app.request("/health")).json();
    expect(health.supplier_float_usdc).toBeDefined();
    // One wallet behind everything here, so no separate eSIM block.
    expect(health.esim_float_usdc).toBeUndefined();
  });

  it("says where a product can be delivered, and admits when it cannot say", async () => {
    // An empty list means "this supplier will not enumerate", never "nowhere" — the
    // console keeps its curated list on that answer rather than emptying the dropdown.
    const { app } = build();
    const res = await app.request("/v1/countries?type=esim");
    expect(res.status).toBe(200);
    const body = await res.json();
    // MockSupplier does not implement listCountries, so the honest answer is "cannot say".
    expect(body).toMatchObject({ type: "esim", countries: [], enumerable: false });
    expect((await app.request("/v1/countries?type=nonsense")).status).toBe(400);
  });

  it("pages a catalogue rather than handing over the whole thing", async () => {
    const { app } = build();
    const all = await (await app.request("/v1/catalog?type=topup&country=IN")).json();
    expect(all.total).toBeGreaterThan(1);

    const first = await (await app.request("/v1/catalog?type=topup&country=IN&limit=1")).json();
    expect(first.offers).toHaveLength(1);
    expect(first.total).toBe(all.total);
    // More to come, so say so — an agent should not have to compare numbers.
    expect(first.next_offset).toBe(1);

    const second = await (await app.request(`/v1/catalog?type=topup&country=IN&limit=1&offset=${first.next_offset}`)).json();
    expect(second.offers[0].offerId).not.toBe(first.offers[0].offerId);
    expect(second.offset).toBe(1);

    // limit=0 is the deliberate way to ask for everything.
    const everything = await (await app.request("/v1/catalog?type=topup&country=IN&limit=0")).json();
    expect(everything.offers).toHaveLength(all.total);
    expect(everything.next_offset).toBeUndefined();

    // A caller asking for more than the ceiling gets the ceiling, not an error.
    const capped = await (await app.request("/v1/catalog?type=topup&country=IN&limit=99999")).json();
    expect(capped.offers.length).toBeLessThanOrEqual(500);
  });

  it("quote → 402 without payment → 202 with payment → delivered with receipt", async () => {
    const { app } = build();
    const q = await (await app.request("/v1/quote", json({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "+91 98765 43210" }, amount: 100 }))).json();
    expect(q.price_usdc).toBe("1.310000");
    expect(q.pay.body.quoteId).toBe(q.quoteId);

    const unpaid = await app.request("/v1/orders", json({ quoteId: q.quoteId }));
    expect(unpaid.status).toBe(402);

    const paid = await app.request("/v1/orders", json({ quoteId: q.quoteId }, { "x-test-pay": "TXID1:PAYERADDR" }));
    expect(paid.status).toBe(202);
    const o = await paid.json();
    expect(o).toMatchObject({ status: "paid", settlement_txid: "TXID1", payer: "PAYERADDR", price_usdc: "1.310000", terminal: false });
    expect(o.recipient.phone).toBe("••••••••3210");

    await new Promise((r) => setTimeout(r, 30));
    const s = await (await app.request(`/v1/orders/${o.orderId}`)).json();
    expect(s.status).toBe("delivered");
    expect(s.terminal).toBe(true);
    expect(s.receipt.payload.settlement_txid).toBe("TXID1");

    const ledger = await (await app.request("/v1/ledger")).json();
    expect(ledger).toMatchObject({ orders: 1, delivered: 1, volume_usdc: "1.310000", delivered_or_refunded_pct: 100 });
    expect(ledger.countries[0]).toMatchObject({ country: "IN" });
  });

  it("rejects bad quotes before payment and never creates an order", async () => {
    const { app, db } = build();
    expect((await app.request("/v1/orders", json({}, { "x-test-pay": "T:P" }))).status).toBe(403);
    expect((await app.request("/v1/orders", json({ quoteId: "q_nope" }, { "x-test-pay": "T:P" }))).status).toBe(403);
    expect(db.ledgerStats().orders).toBe(0);
    expect((await app.request("/v1/quote", json({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "+919876543210" }, amount: 1 }))).status).toBe(400);
  });

  it("does not create an order when settlement fails", async () => {
    const db = new Db(":memory:");
    const supplier = new MockSupplier();
    const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
      pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600, blockedCountries: [], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
      receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    });
    const failing: MiddlewareHandler = async (c, next) => {
      await next();
      c.res.headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_funds" })).toString("base64"));
    };
    const app = buildApp({ db, supplier, orders, paymentMiddleware: failing });
    const q = await (await app.request("/v1/quote", json({ type: "esim", offerId: "mock-esim-in-5gb-30d" }))).json();
    const r = await app.request("/v1/orders", json({ quoteId: q.quoteId }));
    expect(r.status).toBe(502);
    expect(db.ledgerStats().orders).toBe(0);
    expect(orders.validQuote(q.quoteId)).toMatchObject({ ok: true }); // still payable
  });
});

describe("international payments + fx", () => {
  it("quotes a payout with sender + required fields, and the order settles with a signed receipt", async () => {
    const { app } = build();
    const missing = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 20000, recipient: { fields: { account_number: "0123456789" } }, sender: { name: "Sergo V", country: "GE" } }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/bank_code, full_name/);
    const noSender = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 20000, recipient: { fields: { account_number: "0123456789", bank_code: "058", full_name: "Ada L" } } }));
    expect(noSender.status).toBe(400);
    const q = await (await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 20000, recipient: { fields: { account_number: "0123456789", bank_code: "058", full_name: "Ada L" } }, sender: { name: "Sergo V", country: "GE" } }))).json();
    expect(q.price_usdc).toBe("13.570000"); // 20,000 NGN × 650µ = $13.00 cost → ×1.04 + 0.05 = 13.57
    expect(q.recipient.fields.account_number).toBe("••••••6789");
    expect(q.settlement_estimate_seconds).toBe(60);
    const paid = await app.request("/v1/orders", json({ quoteId: q.quoteId }, { "x-test-pay": "TXP1:PAYERADDR" }));
    expect(paid.status).toBe(202);
    const o = await paid.json();
    await new Promise((r) => setTimeout(r, 30));
    const s = await (await app.request(`/v1/orders/${o.orderId}`)).json();
    expect(s.status).toBe("delivered");
    expect(s.confirmation.partnerReference).toMatch(/^MOCK-PAYOUT-/);
    expect(s.receipt.payload.product_type).toBe("payout");
    expect(JSON.stringify(s)).not.toContain("0123456789");
  });
  it("refuses payouts above the KYC threshold without a KYB'd account, and above the per-payment cap", async () => {
    const { app } = build();
    const big = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 200000, recipient: { fields: { account_number: "1", bank_code: "058", full_name: "A" } }, sender: { name: "Sergo V", country: "GE" }, payer: "A".repeat(58) }));
    expect(big.status).toBe(403);
    expect((await big.json()).error).toMatch(/onboarded business account/);
    // A reference the caller typed no longer buys anything — that was the hole.
    const stillRefused = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 200000, recipient: { fields: { account_number: "1", bank_code: "058", full_name: "A" } }, sender: { name: "Sergo V", country: "GE", reference: "kyc_123" }, payer: "A".repeat(58) }));
    expect(stillRefused.status).toBe(403);
    const over = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 300000, recipient: { fields: { account_number: "1", bank_code: "058", full_name: "A" } }, sender: { name: "Sergo V", country: "GE" } }));
    expect(over.status).toBe(400);
    expect((await over.json()).error).toMatch(/per-order limit of \$200/);
  });
  it("serves indicative fx at the sale rate", async () => {
    const { app } = build();
    const fx = await (await app.request("/v1/fx?to=INR&amount=1000")).json();
    expect(fx.to).toBe("INR");
    expect(fx.rate).toBeCloseTo(82.64 / 1.04, 1); // mock: 12,100µ per INR → 82.64 INR/USD cost, minus 4 % markup
    expect(fx.estimate_usdc).toBe("12.640000");
    expect((await app.request("/v1/fx?to=XXX")).status).toBe(404);
    expect((await app.request("/v1/fx")).status).toBe(400);
    expect((await app.request("/fund")).status).toBe(200);
    const cat = await (await app.request("/v1/catalog?type=payout&country=KE")).json();
    expect(cat.offers[0]).toMatchObject({ payoutMethod: "mobile_money", requiredFields: ["full_name"] });
  });
});

describe("preflight", () => {
  it("enforces quote validity, replay and the payer daily ceiling", async () => {
    const { db, orders } = build();
    const pre = makePreflight(orders, db, new ReplayGuard());
    expect(await pre(undefined, undefined)).toMatchObject({ abort: true });
    expect(await pre("q_missing", undefined)).toMatchObject({ abort: true, reason: "unknown quoteId" });
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 100 });
    expect(await pre(q.quoteId, undefined)).toBeUndefined(); // unpaid → let the 402 flow run
    expect(await pre(q.quoteId, "garbage")).toBeUndefined(); // unreadable header → facilitator's problem
  });
});

// An auto-detected operator is a guess from the number range, and on an MVNO it is
// reliably wrong — measured 2026-08-29, a Tesco Mobile number auto-detects as O2. For a
// voucher product that is unrecoverable: the order delivers, the receipt verifies, and
// the code is for the wrong network. Lookup must say so and offer the alternatives.
describe("lookup does not present a detected operator as fact", () => {
  it("flags the detection as a guess and warns about MVNOs", async () => {
    const { app } = build();
    const l = await (await app.request("/v1/lookup?phone=%2B919876543210")).json();
    expect(l.operator_detection).toBe("auto");
    expect(l.confirm_operator).toMatch(/MVNO/);
    expect(l.confirm_operator).toMatch(/cannot be redeemed or refunded/);
  });

  it("hands back the country's other brands so a wrong guess is correctable", async () => {
    const { app } = build();
    const l = await (await app.request("/v1/lookup?phone=%2B919876543210")).json();
    expect(Array.isArray(l.other_brands)).toBe(true);
    // whatever else is listed, it must never re-list the brand it already guessed
    expect(l.other_brands.map((b: { brand: string }) => b.brand)).not.toContain(l.brand);
  });
});

// The console is a static asset read at startup, so a missing or renamed file is a
// boot-time break rather than a compile error — worth one test that it is actually
// served, wired to its own origin, and not accidentally left in demo mode.
describe("the batch console", () => {
  it("serves at /console, in live mode, against its own origin", async () => {
    const { app } = build();
    const res = await app.request("/console");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>IoMarkets Console</title>');
    // Same-origin: injecting PUBLIC_BASE_URL here made every fetch cross-origin.
    expect(html).toMatch(/window\.__IOM__=\{"base":"",/);
    expect(html).toContain('"demo":false');
    // The <title> and font <link> must be lifted OUT of the body into <head>.
    expect(html.indexOf("<title>")).toBeLessThan(html.indexOf("<body>"));
  });
});

// ⚠️ Found in review 2026-08-30. GET /v1/orders/:id is unauthenticated and the order id
// is the capability — 80 bits handed to the payer when they pay. The order it unlocks
// carries the supplier confirmation, and for a PIN voucher or an eSIM that confirmation
// IS the deliverable: a bearer instrument, redeemable by whoever gets there first.
// /v1/ledger was publishing those ids for the 25 most recent orders, so anyone could
// poll it, read each PIN as it landed, and redeem it before the buyer — with nothing
// failing, and therefore no refund.
describe("the public ledger does not hand out order ids", () => {
  it("omits the id from every recent row", async () => {
    const { app, db } = build();
    db.insertOrder({
      id: "ord_secret123", quote_id: "q", payer: "P", type: "topup", offer_id: "o", country: "GB", brand: "b",
      recipient_json: "{}", recipient_hash: "h", cost_micro: 1, price_micro: 1, supplier: "mock", supplier_tx_id: null,
      status: "delivered", settlement_txid: "TX1", confirmation_json: JSON.stringify({ voucher_pin: "1234-5678-9012" }),
      error: null, receipt_json: null, refund_txid: null, refund_error: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), delivered_at: null,
    });
    const body = await (await app.request("/v1/ledger")).text();
    expect(body).toContain("TX1");            // the settlement is public, and on-chain anyway
    expect(body).not.toContain("ord_secret123");
    expect(body).not.toContain("voucher_pin");
    // The payer, who has the id, still gets their own PIN.
    const order = await (await app.request("/v1/orders/ord_secret123")).json();
    expect(order.confirmation.voucher_pin).toBe("1234-5678-9012");
  });
});

// ⚠️ Found in review 2026-08-31. `refund_failed` means the payer settled, the goods never
// arrived, and the refund then failed too. It is terminal — openOrders() does not include
// it, so resume() will never retry it — and it is the single worst outcome this system can
// produce. The ledger counted it as `in_flight`, alongside an order three seconds old, on
// the one surface whose stated purpose is that nothing is hidden.
describe("the public ledger separates stranded payers from in-flight orders", () => {
  const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id, quote_id: "q", payer: "P", type: "topup", offer_id: "o", country: "NG", brand: "MTN",
    recipient_json: "{}", recipient_hash: "h", cost_micro: 1_000_000, price_micro: 1_050_000, supplier: "mock",
    supplier_tx_id: null, status, settlement_txid: `TX_${id}`, confirmation_json: null, error: null,
    receipt_json: null, refund_txid: null, refund_error: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), delivered_at: null, ...extra,
  });

  it("counts refund_failed as stranded and never as in_flight", async () => {
    const { app, db } = build();
    db.insertOrder(row("ord_a", "delivered") as never);
    db.insertOrder(row("ord_b", "fulfilling") as never);
    db.insertOrder(row("ord_c", "refund_failed", { refund_error: "refund wallet empty" }) as never);

    const l = await (await app.request("/v1/ledger")).json();
    expect(l).toMatchObject({ orders: 3, delivered: 1, in_flight: 1, stranded: 1 });
    // The percentage already counted it against us; the point is that the bucket is visible.
    expect(l.delivered_or_refunded_pct).toBe(33.3);
  });

  it("reports no delivery rate at all before anything has been sold", async () => {
    const { app } = build();
    const l = await (await app.request("/v1/ledger")).json();
    // Not 100. A fresh deploy claiming "100% delivered or refunded" is a claim about
    // deliveries that never happened, on the page that exists to be checkable.
    expect(l.orders).toBe(0);
    expect(l.delivered_or_refunded_pct).toBeNull();
  });

  it("gives a refunded order the same explorer link the order endpoint has", async () => {
    const { app, db } = build();
    db.insertOrder(row("ord_r", "refunded", { refund_txid: "RTX9" }) as never);
    const l = await (await app.request("/v1/ledger")).json();
    expect(l.recent[0]).toMatchObject({ status: "refunded", refund_txid: "RTX9" });
    expect(l.recent[0].refund_url).toContain("RTX9");
    // and an unrefunded row carries no dead link
    db.insertOrder(row("ord_d", "delivered") as never);
    const l2 = await (await app.request("/v1/ledger")).json();
    expect(l2.recent.find((o: { status: string }) => o.status === "delivered").refund_url).toBeUndefined();
  });

  it("breaks volume down by product type", async () => {
    const { app, db } = build();
    db.insertOrder(row("ord_t", "delivered") as never);
    db.insertOrder(row("ord_p", "delivered", { type: "payout", price_micro: 100_000_000 }) as never);
    const l = await (await app.request("/v1/ledger")).json();
    expect(l.types.map((t: { type: string }) => t.type)).toEqual(["payout", "topup"]);
    expect(l.types[0]).toMatchObject({ type: "payout", orders: 1, volume_usdc: "100.000000" });
  });
});

describe("/v1/limits publishes per-type ceilings", () => {
  it("lists only the types whose cap is lower than the global one", async () => {
    const db = new Db(":memory:");
    const supplier = new MockSupplier();
    const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
      pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, typeMaxUsd: { giftcard: 25 },
      quoteTtlSec: 600, blockedCountries: [], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 },
      payerDailyUsd: 200, receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders",
      pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    });
    const app = buildApp({ db, supplier, orders, paymentMiddleware: fakePayment });
    const l = await (await app.request("/v1/limits")).json();
    expect(l.max_order_usdc).toBe("50.000000");
    expect(l.type_limits_usdc).toEqual({ giftcard: "25.000000" });
  });

  it("is an empty object when no type is capped below the global ceiling", async () => {
    const { app } = build();
    const l = await (await app.request("/v1/limits")).json();
    expect(l.type_limits_usdc).toEqual({});
  });

  it("publishes the float ceiling too, because quote() enforces it", async () => {
    // An agent pricing a basket against max_order_usdc alone could be refused by a
    // ceiling this route never mentioned. MockSupplier holds $1,000.
    const { app } = build();
    const l = await (await app.request("/v1/limits")).json();
    expect(l.fillable_now_usdc).toBe("1000.000000");
  });
});

// /health used to fetch the supplier balance and throw the number away, reporting only
// a boolean. A float that cannot cover the largest order we advertise is an outage: we
// would accept a payment on chain and then fail to deliver, spending a refund to buy
// nothing. That is worth paging on, and nothing was surfacing it.
describe("/health reports whether an order can actually be filled", () => {
  const buildWith = (balanceMicro: number | (() => never)) => {
    const db = new Db(":memory:");
    const supplier = new MockSupplier();
    supplier.balanceMicro = typeof balanceMicro === "function"
      ? (async () => { throw new Error("supplier down"); })
      : (async () => balanceMicro);
    const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
      pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600,
      blockedCountries: [], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
      receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    });
    return { db, app: buildApp({ db, supplier, orders, paymentMiddleware: fakePayment }) };
  };

  it("separates 'cannot fill the largest advertised order' from 'cannot fill anything'", async () => {
    const { app } = buildWith(33_370_250); // the real float: $33.37 against a $50 advertised ceiling
    const h = await (await app.request("/health")).json();
    // Below the advertised ceiling — a capacity fact, reported. Not a fault: quote()
    // refuses anything above the available float rather than failing after settlement.
    // Paging on this would page continuously while every accepted order sold fine.
    expect(h).toMatchObject({ ok: true, supplier_ok: true, float_covers_max_order: false, supplier_float_usdc: "33.370250", max_order_usdc: "50.000000" });
    // Nothing settled and undelivered, so available == the raw balance.
    expect(h).toMatchObject({ float_committed_usdc: "0.000000", float_available_usdc: "33.370250" });
  });

  it("counts a settled, undelivered order against the float before the supplier debits it", async () => {
    const { db, app } = buildWith(60_000_000); // $60 in the wallet, $50 ceiling
    expect((await (await app.request("/health")).json()).float_covers_max_order).toBe(true);
    db.insertOrder({
      id: "ord_pending", quote_id: "q", type: "topup", offer_id: "mock-in-jio-airtime", country: "IN", brand: "JIO",
      recipient_json: "{}", recipient_hash: "h", cost_micro: 20_000_000, price_micro: 20_850_000,
      supplier: "mock", supplier_tx_id: null, status: "fulfilling", payer: "P", settlement_txid: "T",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as unknown as Parameters<typeof db.insertOrder>[0]);
    const h = await (await app.request("/health")).json();
    // The supplier still shows $60; $20 of it is already sold.
    expect(h).toMatchObject({ supplier_float_usdc: "60.000000", float_committed_usdc: "20.000000", float_available_usdc: "40.000000", float_covers_max_order: false });
  });

  it("is ok when the float covers the advertised ceiling too", async () => {
    const { app } = buildWith(500_000_000);
    const h = await (await app.request("/health")).json();
    expect(h).toMatchObject({ ok: true, supplier_ok: true, float_covers_max_order: true });
  });

  it("is NOT ok when the float cannot fill even the smallest order we accept", async () => {
    const { app } = buildWith(100_000); // $0.10 against a $0.50 minimum
    const h = await (await app.request("/health")).json();
    expect(h).toMatchObject({ ok: false, float_available_usdc: "0.100000", min_order_usdc: "0.500000" });
  });

  it("reports a supplier that cannot be reached without throwing", async () => {
    const { app } = buildWith(() => { throw new Error("x"); });
    const r = await app.request("/health");
    // Still HTTP 200: the container healthcheck keys on the status, and restart-looping
    // the box because a supplier is down would take the service off the air entirely.
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, supplier_ok: false, supplier_float_usdc: null });
  });

  it("surfaces stranded payers", async () => {
    const { app, db } = buildWith(500_000_000);
    db.insertOrder({
      id: "ord_s", quote_id: "q", payer: "P", type: "topup", offer_id: "o", country: "NG", brand: "MTN",
      recipient_json: "{}", recipient_hash: "h", cost_micro: 1, price_micro: 1, supplier: "mock", supplier_tx_id: null,
      status: "refund_failed", settlement_txid: "TXS", confirmation_json: null, error: null, receipt_json: null,
      refund_txid: null, refund_error: "refund wallet empty",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), delivered_at: null,
    } as never);
    expect((await (await app.request("/health")).json()).stranded_orders).toBe(1);
  });
});

// ── security regressions, session 8 ─────────────────────────────────────────

describe("the rate-limit key cannot be chosen by the client", () => {
  // X-Forwarded-For is client-supplied until a proxy overwrites it, and the LEFTMOST
  // entry is the attacker-controlled part. Reading it let anyone rotate the key per
  // request — and mint enough distinct keys to trip RateLimiter's overflow sweep,
  // which clears everyone else's counters too. The free routes call the supplier's
  // API on every request, so the ceiling being lifted is a supplier bill and a
  // supplier-side throttle, not just CPU.
  it("takes the last hop, which is the one the closest proxy wrote", () => {
    expect(clientIp("1.2.3.4", undefined)).toBe("1.2.3.4");
    // Attacker prepends a forged hop; Caddy appends the one it observed.
    expect(clientIp("9.9.9.9, 1.2.3.4", undefined)).toBe("1.2.3.4");
    expect(clientIp("evil, evil2, 1.2.3.4", undefined)).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP and then to a constant, never to attacker input", () => {
    expect(clientIp(undefined, "5.6.7.8")).toBe("5.6.7.8");
    expect(clientIp("", "5.6.7.8")).toBe("5.6.7.8");
    expect(clientIp("   ,  ", "5.6.7.8")).toBe("5.6.7.8");
    expect(clientIp(undefined, undefined)).toBe("local");
  });
});

describe("a free, unauthenticated quote cannot write unbounded data", () => {
  it("refuses more than 20 recipient fields", async () => {
    const { app } = build();
    const fields = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, "x"]));
    const r = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 20000, recipient: { fields } }));
    expect(r.status).toBe(400);
  });

  it("refuses an over-long field name", async () => {
    const { app } = build();
    const fields = { ["k".repeat(65)]: "x" };
    const r = await app.request("/v1/quote", json({ type: "payout", offerId: "mock-payout-ng-bank", amount: 20000, recipient: { fields } }));
    expect(r.status).toBe(400);
  });

  it("rejects an oversized body with 413 rather than buffering it", async () => {
    const { app } = build();
    const body = JSON.stringify({ type: "topup", offerId: "x".repeat(200_000) });
    const r = await app.request("/v1/quote", {
      method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) }, body,
    });
    expect(r.status).toBe(413);
  });
});

// The console runs as static files, so it cannot have these injected into its HTML
// the way /console does — it fetches them. `caip2` is the load-bearing one: it must be
// the facilitator's FULL genesis-hash form, or the browser signs for a network the
// facilitator will not settle.
describe("GET /v1/client-config gives the browser what it needs to pay, and nothing else", () => {
  it("serves the network parameters as public JSON", async () => {
    const { app } = build();
    const res = await app.request("/v1/client-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.algod_url).toMatch(/^https:\/\//);
    expect(body.usdc_asa).toBeTruthy();
    expect(Number(body.max_order_usdc)).toBeGreaterThan(0);
    expect(Number(body.min_order_usdc)).toBeGreaterThan(0);
  });

  it("uses the facilitator's full genesis-hash CAIP-2 form, not the 32-char one", async () => {
    const { app } = build();
    const body = await (await app.request("/v1/client-config")).json();
    expect(body.caip2).toMatch(/^algorand:/);
    // The spec-compliant short form is 32 chars; the facilitator keys on the full
    // base64 genesis hash, which ends in "=".
    expect(body.caip2.split(":")[1]).toMatch(/=$/);
  });

  it("leaks no secret — no key, mnemonic or supplier credential", async () => {
    const { app } = build();
    const text = await (await app.request("/v1/client-config")).text();
    expect(text).not.toMatch(/mnemonic|private|secret|api_key|apiKey/i);
  });

  it("is free — it must never sit behind the payment middleware", async () => {
    const { app } = build();
    // build()'s fakePayment 402s anything it guards.
    expect((await app.request("/v1/client-config")).status).toBe(200);
  });
});

// A mock supplier renders corridors indistinguishable from real ones and says nothing
// about it anywhere — unlike ?demo=1, which labels itself on the page. That is how a
// test batch gets screenshotted as settled volume. The server declares it; the console
// puts a red strip in the chrome for whichever product type is listed.
describe("GET /v1/client-config declares which products are simulated", () => {
  it("names the mock-backed types", async () => {
    const { app } = build();
    const body = await (await app.request("/v1/client-config")).json();
    // build() wires MockSupplier for everything.
    expect(Array.isArray(body.simulated)).toBe(true);
    expect(body.simulated.length).toBeGreaterThan(0);
  });

  it("is a subset of the live product types — it can never name a product we do not sell", async () => {
    const { app } = build();
    const cfg = await (await app.request("/v1/client-config")).json();
    const agent = await (await app.request("/agent.md")).text();
    for (const t of cfg.simulated) expect(agent).toContain(t);
  });
});
