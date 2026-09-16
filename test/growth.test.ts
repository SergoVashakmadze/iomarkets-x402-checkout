// Pay links, proof pages and the referral share (src/growth.ts, src/referrals.ts).
//
// The properties pinned here are the ones that would cost money or leak a deliverable
// if they regressed: a single-use link cannot be paid twice, a link never shows the
// full phone number, a referral is a share of MARGIN paid only on delivery and never to
// the payer, the hot wallet's refund reserve is respected, and no public surface —
// proof page, on-chain note — ever carries the order id that reads an eSIM LPA.
import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { ReferralService, referralShareMicro, type ReferralWallet } from "../src/referrals.js";
import { MockSupplier } from "../src/suppliers/mock.js";

const kp = generateKeypair();
const A = (c: string) => c.repeat(58); // a syntactically valid Algorand address
const TX = (c: string) => c.repeat(52); // a syntactically valid txid
const REF = A("R");
const PAYER = A("P");

const fakePayment: MiddlewareHandler = async (c, next) => {
  const pay = c.req.header("x-test-pay");
  if (!pay) return c.json({ error: "payment required" }, 402);
  await next();
  const [transaction, payer] = pay.split(":");
  c.res.headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction, payer })).toString("base64"));
};

class FakeWallet implements ReferralWallet {
  sent: Array<{ to: string; amount: number; note: string }> = [];
  balance: number | null = 1_000_000_000;
  async balanceMicro() { return this.balance; }
  async send(to: string, amount: number, note: string) { this.sent.push({ to, amount, note }); return TX("S"); }
}

function build(opts: { shareBps?: number; reserveMicro?: number } = {}) {
  const db = new Db(":memory:");
  const wallet = new FakeWallet();
  const referrals = new ReferralService(db, wallet, {
    shareBps: opts.shareBps ?? 5000, minPayoutMicro: 100_000, dailyCapMicro: 25_000_000,
    refundReserveMicro: opts.reserveMicro ?? 0, floatAcquisitionBps: 0, notePrefix: "iomarkets.app", log: () => {},
  });
  const orders = new OrderService(db, new MockSupplier(), { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600, blockedCountries: ["CU"],
    payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
    receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    hooks: { onOrderCreated: (o, m) => referrals.onOrderCreated(o, m.ref), onTerminal: (o) => referrals.onTerminal(o) },
  });
  const app = buildApp({ db, supplier: new MockSupplier(), orders, referrals, paymentMiddleware: fakePayment });
  return { app, db, orders, wallet, referrals };
}
const post = (b: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const settle = () => new Promise((r) => setTimeout(r, 40));

async function payQuote(app: ReturnType<typeof build>["app"], quoteId: string, txid: string, payer = PAYER) {
  return app.request("/v1/orders", post({ quoteId }, { "x-test-pay": `${txid}:${payer}` }));
}

describe("referral share arithmetic", () => {
  it("is a share of net margin, never of price, and never negative", () => {
    // $7.54 sale on a $7.20 cost: $0.34 margin, half of it is $0.17.
    expect(referralShareMicro(7_540_000, 7_200_000, 5000)).toBe(170_000);
    // Float acquisition cost comes out of margin before the split.
    expect(referralShareMicro(7_540_000, 7_200_000, 5000, 400)).toBe(26_000);
    expect(referralShareMicro(1_000_000, 1_000_000, 5000)).toBe(0);
    expect(referralShareMicro(1_000_000, 2_000_000, 5000)).toBe(0);
    // A bps above 100% cannot pay out more than the margin.
    expect(referralShareMicro(2_000_000, 1_000_000, 50_000)).toBe(1_000_000);
  });
});

describe("pay links", () => {
  it("a top-up link masks the phone everywhere and cannot be paid twice", async () => {
    const { app } = build();
    const res = await app.request("/v1/links", post({ type: "topup", offerId: "mock-in-jio-1gb-28d", recipient: { phone: "+919876543210" }, note: "for mum" }));
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link).toMatchObject({ type: "topup", max_uses: 1, state: "open", note: "for mum" });
    expect(link.url).toMatch(/\/l\/pl_[a-z0-9]{16}$/);
    expect(JSON.stringify(link)).not.toContain("9876543210");

    const q1 = await (await app.request(`/v1/links/${link.linkId}/quote`, { method: "POST" })).json();
    const q2 = await (await app.request(`/v1/links/${link.linkId}/quote`, { method: "POST" })).json();
    // The quote view is what the 402 body echoes to whoever holds the link.
    expect(JSON.stringify(q1)).not.toContain("9876543210");
    expect((await app.request(`/l/${link.linkId}`)).status).toBe(200);
    expect(await (await app.request(`/l/${link.linkId}`)).text()).not.toContain("9876543210");

    expect((await payQuote(app, q1.quoteId, TX("A"))).status).toBe(202);
    expect((await (await app.request(`/v1/links/${link.linkId}`)).json()).state).toBe("paid");
    // A second payer holding a quote from before the first payment is refused BEFORE paying.
    const second = await payQuote(app, q2.quoteId, TX("B"), A("Q"));
    expect(second.status).toBe(403);
    expect((await second.json()).error).toMatch(/already been paid/);
    expect((await app.request(`/v1/links/${link.linkId}/quote`, { method: "POST" })).status).toBe(409);
  });

  it("an eSIM link is reusable by default, and only sells live, bearer-safe products", async () => {
    const { app } = build();
    const link = await (await app.request("/v1/links", post({ type: "esim", offerId: "mock-esim-in-5gb-30d" }))).json();
    expect(link.max_uses).toBe(0);
    for (const t of ["C", "D"]) {
      const q = await (await app.request(`/v1/links/${link.linkId}/quote`, { method: "POST" })).json();
      expect((await payQuote(app, q.quoteId, TX(t))).status).toBe(202);
    }
    expect((await (await app.request(`/v1/links/${link.linkId}`)).json())).toMatchObject({ uses: 2, state: "open" });

    expect((await app.request("/v1/links", post({ type: "payout", offerId: "mock-payout-ng-bank" }))).status).toBe(400);
    expect((await app.request("/v1/links", post({ type: "topup", offerId: "mock-in-jio-1gb-28d" }))).status).toBe(400);
    expect((await app.request("/v1/links", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: "not-an-address" }))).status).toBe(400);
    expect((await app.request("/v1/links/pl_nope")).status).toBe(404);
    expect((await app.request("/l/pl_0000000000000000")).status).toBe(404);
  });

  it("an expired link refuses to quote", async () => {
    const { app, db } = build();
    const link = await (await app.request("/v1/links", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ttl_hours: 1 }))).json();
    db.sql.prepare("UPDATE pay_links SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), link.linkId);
    expect((await app.request(`/v1/links/${link.linkId}/quote`, { method: "POST" })).status).toBe(410);
  });
});

describe("referrals", () => {
  it("pays the referrer's share on delivery, on-chain, with no order id in the note", async () => {
    const { app, wallet } = build();
    const q = await (await app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: REF }))).json();
    const o = await (await payQuote(app, q.quoteId, TX("E"))).json();
    await settle();
    expect(wallet.sent).toHaveLength(1);
    expect(wallet.sent[0]).toMatchObject({ to: REF, amount: 170_000 });
    expect(wallet.sent[0].note).not.toContain(o.orderId);
    expect(wallet.sent[0].note).not.toMatch(/ord_/);

    const mine = await (await app.request(`/v1/referrals/${REF}`)).json();
    expect(mine).toMatchObject({ orders_referred: 1, paid_usdc: "0.170000", owed_usdc: "0.000000" });
    expect(JSON.stringify(mine)).not.toContain(o.orderId);
    const board = await (await app.request("/v1/referrals")).json();
    expect(board.program.enabled).toBe(true);
    expect(board.leaderboard[0]).toMatchObject({ ref: REF, orders: 1, earned_usdc: "0.170000" });
  });

  it("a link's ref is carried to the orders it produces", async () => {
    const { app, wallet } = build();
    const link = await (await app.request("/v1/links", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: REF }))).json();
    const q = await (await app.request(`/v1/links/${link.linkId}/quote`, { method: "POST" })).json();
    await payQuote(app, q.quoteId, TX("F"));
    await settle();
    expect(wallet.sent.map((s) => s.to)).toEqual([REF]);
  });

  it("earns nothing on a refund, on self-referral, or when the programme is off", async () => {
    const refunded = build();
    const q = await (await refunded.app.request("/v1/quote", post({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "+919876540000" }, amount: 500, ref: REF }))).json();
    await payQuote(refunded.app, q.quoteId, TX("G"));
    await settle();
    expect(refunded.wallet.sent).toHaveLength(0);
    expect(refunded.db.referralSummary(REF).orders).toBe(0);

    const self = build();
    const q2 = await (await self.app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: PAYER }))).json();
    await payQuote(self.app, q2.quoteId, TX("H"));
    await settle();
    expect(self.wallet.sent).toHaveLength(0);

    const off = build({ shareBps: 0 });
    const q3 = await (await off.app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: REF }))).json();
    await payQuote(off.app, q3.quoteId, TX("I"));
    await settle();
    expect(off.wallet.sent).toHaveLength(0);
    expect((await (await off.app.request("/v1/referrals")).json()).program.enabled).toBe(false);
  });

  it("defers rather than dipping into the refund reserve, and pays once the wallet is topped up", async () => {
    const { app, wallet, referrals } = build({ reserveMicro: 50_000_000 });
    wallet.balance = 50_100_000; // paying $0.17 would take it below $50
    const q = await (await app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: REF }))).json();
    await payQuote(app, q.quoteId, TX("J"));
    await settle();
    expect(wallet.sent).toHaveLength(0);
    const owed = await (await app.request(`/v1/referrals/${REF}`)).json();
    expect(owed).toMatchObject({ owed_usdc: "0.170000" });
    expect(owed.note).toMatch(/refund reserve/);

    wallet.balance = 80_000_000;
    await referrals.sweepAll();
    expect(wallet.sent).toHaveLength(1);
    expect((await (await app.request(`/v1/referrals/${REF}`)).json()).paid_usdc).toBe("0.170000");
  });

  it("refuses a malformed ref on a quote", async () => {
    const { app } = build();
    expect((await app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", ref: "abc" }))).status).toBe(400);
  });
});

describe("proof pages", () => {
  it("publishes a delivered order by its settlement txid, never its order id", async () => {
    const { app } = build();
    const q = await (await app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d" }))).json();
    const o = await (await payQuote(app, q.quoteId, TX("K"))).json();
    await settle();

    const p = await (await app.request(`/v1/proof/${TX("K")}`)).json();
    expect(p).toMatchObject({ status: "delivered", type: "esim", price_usdc: "7.540000", receipt_signature_valid: true, can_reorder: true });
    expect(JSON.stringify(p)).not.toContain(o.orderId);
    expect(JSON.stringify(p)).not.toContain("LPA:");

    const html = await (await app.request(`/p/${TX("K")}`)).text();
    expect(html).toContain('property="og:title"');
    expect(html).not.toContain(o.orderId);
    expect(html).not.toContain("LPA:");

    const ledger = await (await app.request("/v1/ledger")).json();
    expect(ledger.recent[0].proof_url).toMatch(new RegExp(`/p/${TX("K")}$`));

    // "Get the same eSIM" makes a link that credits the original buyer.
    const re = await app.request(`/v1/proof/${TX("K")}/reorder`, { method: "POST" });
    expect(re.status).toBe(201);
    expect(await re.json()).toMatchObject({ type: "esim", offerId: "mock-esim-in-5gb-30d", referred: true });

    expect((await app.request(`/v1/proof/${TX("Z")}`)).status).toBe(404);
    expect((await app.request("/p/not-a-txid")).status).toBe(404);
  });

  it("does not publish payouts", async () => {
    const { app, db, orders } = build();
    const q = await orders.quote({ type: "payout", offerId: "mock-payout-ng-bank", amount: 10000, recipient: { fields: { account_number: "0123456789", bank_code: "058", full_name: "Ada Obi" } }, sender: { name: "Acme Ltd", country: "GB" } });
    orders.createPaidOrder(q.quoteId, PAYER, TX("L"));
    expect(db.proofBySettlement(TX("L"))).toBeDefined();
    expect((await app.request(`/v1/proof/${TX("L")}`)).status).toBe(404);
  });
});

describe("growth pages", () => {
  /** Every inline script on a served page must at least compile — see test/pages.test.ts. */
  async function scriptsOf(app: ReturnType<typeof build>["app"], path: string) {
    const html = await (await app.request(path)).text();
    return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => m[2].trim()).map((m) => m[2]);
  }
  it("serve, carry the brand, and their scripts compile", async () => {
    const { app } = build();
    const link = await (await app.request("/v1/links", post({ type: "esim", offerId: "mock-esim-in-5gb-30d", note: "</script><script>alert(1)</script>" }))).json();
    const q = await (await app.request("/v1/quote", post({ type: "esim", offerId: "mock-esim-in-5gb-30d" }))).json();
    await payQuote(app, q.quoteId, TX("M"));
    await settle();
    for (const path of [`/l/${link.linkId}`, `/p/${TX("M")}`, "/earn"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("/brand/logo.webp");
      expect(html, path).not.toContain("<script>alert(1)");
      for (const src of await scriptsOf(app, path)) {
        expect(() => new Function(`return (async () => { ${src} })`), path).not.toThrow();
      }
    }
    expect(await (await app.request("/robots.txt")).text()).toContain("Disallow: /l/");
  });
});
