import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { OrderService, QuoteError, costFor } from "../src/orders.js";
import { generateKeypair, verifyReceipt } from "../src/receipt.js";
import type { Refunder } from "../src/refunds.js";
import { CompositeSupplier } from "../src/suppliers/composite.js";
import { MockSupplier } from "../src/suppliers/mock.js";

const kp = generateKeypair();

class FakeRefunder implements Refunder {
  sent: Array<{ orderId: string; payer: string; amount: number }> = [];
  fail = false;
  async send(orderId: string, payer: string, amount: number) {
    if (this.fail) throw new Error("hot wallet empty");
    this.sent.push({ orderId, payer, amount });
    return `REFUND_${orderId}`;
  }
  address() { return "REFUNDER"; }
}

function svc(overrides: Partial<ConstructorParameters<typeof OrderService>[3]> = {}, supplier: MockSupplier = new MockSupplier()) {
  const db = new Db(":memory:");
  const refunder = new FakeRefunder();
  const orders = new OrderService(db, supplier, refunder, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 },
    maxOrderUsd: 50, quoteTtlSec: 600, blockedCountries: ["CU"], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200, receiptPrivateKey: kp.privateKey,
    ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {}, ...overrides,
  });
  return { db, refunder, orders };
}

const wait = async (orders: OrderService, id: string) => orders.process(id);

describe("quotes", () => {
  it("prices a range top-up from the local amount", async () => {
    const { orders } = svc();
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 100 });
    // 100 INR × 12,100 micro = $1.21 cost → ×1.04 + 0.05 = 1.3084 → $1.31
    expect(q.price_usdc).toBe("1.310000");
    expect(q.delivers).toContain("INR 100");
    expect(orders.validQuote(q.quoteId)).toEqual({ ok: true, priceMicro: 1_310_000 });
  });
  it("validates range bounds and required amount", async () => {
    const { orders } = svc();
    await expect(orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" } })).rejects.toThrow(QuoteError);
    await expect(orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 5 })).rejects.toThrow(/minimum/);
    await expect(orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 5000 })).rejects.toThrow(/per-order limit/);
  });
  it("refuses blocked destinations and unknown offers", async () => {
    const { orders } = svc({ blockedCountries: ["IN"] });
    await expect(orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} })).rejects.toMatchObject({ status: 403 });
    await expect(orders.quote({ type: "esim", offerId: "nope", recipient: {} })).rejects.toMatchObject({ status: 404 });
  });
  it("expires", async () => {
    const { orders } = svc({ quoteTtlSec: -1 });
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    expect(orders.validQuote(q.quoteId)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    expect(orders.validQuote("nope")).toMatchObject({ ok: false });
  });
  it("costFor fixed offers ignores amount", () => {
    expect(costFor({ id: "x", type: "esim", country: "IN", brand: "E", brandName: "E", name: "n", priceType: "fixed", costMicro: 5 }).costMicro).toBe(5);
  });
});

describe("orders", () => {
  it("delivers immediately and signs a receipt anchored to the settlement", async () => {
    const { orders } = svc();
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    const o = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_A");
    expect(o.status).toBe("paid");
    const done = await wait(orders, o.id);
    expect(done.status).toBe("delivered");
    const receipt = JSON.parse(done.receipt_json!);
    expect(verifyReceipt(receipt, kp.publicKey)).toBe(true);
    expect(receipt.payload).toMatchObject({ order_id: o.id, status: "delivered", settlement_txid: "TX_A", payer: "PAYER1", amount_usdc: q.price_usdc });
    expect(JSON.parse(done.confirmation_json!).lpa).toMatch(/^LPA:1\$/);
  });
  it("polls a pending delivery to completion", async () => {
    const { orders } = svc();
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919800001111" }, amount: 50 });
    const o = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_B");
    expect((await wait(orders, o.id)).status).toBe("delivered");
  });
  it("refunds a failed delivery on-chain and signs a refund receipt", async () => {
    const { orders, refunder } = svc();
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919800000000" }, amount: 50 });
    const o = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_C");
    const done = await wait(orders, o.id);
    expect(done.status).toBe("refunded");
    expect(done.refund_txid).toBe(`REFUND_${o.id}`);
    expect(refunder.sent).toEqual([{ orderId: o.id, payer: "PAYER1", amount: o.price_micro }]);
    const receipt = JSON.parse(done.receipt_json!);
    expect(verifyReceipt(receipt, kp.publicKey)).toBe(true);
    expect(receipt.payload).toMatchObject({ status: "refunded", refund_txid: `REFUND_${o.id}` });
  });
  it("surfaces refund failure instead of losing it", async () => {
    const { orders, refunder } = svc();
    refunder.fail = true;
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919800000000" }, amount: 50 });
    const o = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_D");
    const done = await wait(orders, o.id);
    expect(done.status).toBe("refund_failed");
    expect(done.refund_error).toContain("hot wallet empty");
  });
  it("a quote pays exactly once; a racing second payment is refunded", async () => {
    const { orders, refunder } = svc();
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    const a = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_E1");
    const b = orders.createPaidOrder(q.quoteId, "PAYER2", "TX_E2");
    expect(a.status).toBe("paid");
    expect(b.status).toBe("failed");
    expect((await wait(orders, b.id)).status).toBe("refunded");
    expect(refunder.sent[0]).toMatchObject({ payer: "PAYER2" });
    expect(orders.validQuote(q.quoteId)).toMatchObject({ ok: false, reason: "quote already used" });
  });
  it("is idempotent on the settlement txid", async () => {
    const { orders } = svc();
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    const a = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_F");
    expect(orders.createPaidOrder(q.quoteId, "PAYER1", "TX_F").id).toBe(a.id);
  });
  // A crash mid-fulfilment leaves the order `fulfilling`. If the box is down longer
  // than FULFIL_TIMEOUT_MS (10 min by default), the deadline has already passed by the
  // time resume() runs — and declaring failure without asking the supplier refunds the
  // payer for a top-up that may well have been delivered while we were down. We would
  // pay the supplier cost AND return the money.
  it("asks the supplier at least once when resuming after the timeout has passed", async () => {
    const { orders, db, refunder } = svc({ timeoutMs: 60_000 });
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    const o = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_STALE");
    await orders.process(o.id);

    // Rewind into the state a crash would leave behind: still fulfilling, created long ago.
    db.updateOrder(o.id, { status: "fulfilling" });
    db.sql.prepare("UPDATE orders SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3_600_000).toISOString(), o.id);

    await orders.process(o.id);

    expect(db.getOrder(o.id)!.status).toBe("delivered");
    expect(refunder.sent).toHaveLength(0);
  });
  it("resume() picks up in-flight orders and the ledger counts them", async () => {
    const { orders, db } = svc();
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    const o = orders.createPaidOrder(q.quoteId, "PAYER1", "TX_G");
    db.updateOrder(o.id, { status: "paid" }); // pretend we crashed before fulfilling
    await orders.resume();
    await new Promise((r) => setTimeout(r, 20));
    expect(db.getOrder(o.id)!.status).toBe("delivered");
    const s = db.ledgerStats();
    expect(s).toMatchObject({ orders: 1, delivered: 1, refunded: 0 });
    expect(db.payerSpentTodayMicro("PAYER1")).toBe(o.price_micro);
  });
});

describe("the float gates the quote, not just the health check", () => {
  // Everything else here is settle-then-deliver: the payer's USDC lands first and a
  // failed delivery is refunded on chain. That promise is kept — but a refund is a bad
  // outcome, not a good one. The float is knowable BEFORE the payer commits, so an
  // order we cannot fill is a refusal we owe them up front.
  const withFloat = (micro: number | (() => never)) => {
    const supplier = new MockSupplier();
    supplier.balanceMicro = typeof micro === "function"
      ? (async () => { micro(); }) as unknown as () => Promise<number>
      : (async () => micro);
    return svc({ floatCacheMs: 0 }, supplier);
  };

  it("refuses a quote the float cannot fill, and says how much is left", async () => {
    const { orders } = withFloat(1_000_000); // $1
    await expect(orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} }))
      .rejects.toMatchObject({ status: 503 });
    await expect(orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} }))
      .rejects.toThrow(/\$1 available/);
  });

  it("quotes normally when the float covers the supplier cost", async () => {
    const { orders } = withFloat(1_000 * 1_000_000);
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    expect(q.price_usdc).toBeTruthy();
  });

  it("compares against COST, not the sale price — the markup lands in PAY_TO, not the float", async () => {
    // The mock eSIM costs $8.00 and prices at $8.37 (4% + $0.05). A float holding
    // exactly the cost can fill it; keying the check off the price would refuse.
    const { orders } = withFloat(8_000_000);
    await expect(orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} })).resolves.toBeTruthy();
  });

  it("nets off orders that have settled and not yet delivered", async () => {
    const { db, orders } = withFloat(20_000_000);
    const row = {
      id: "ord_x", quote_id: "q_x", type: "topup", offer_id: "mock-in-jio-airtime", country: "IN", brand: "JIO",
      recipient_json: "{}", recipient_hash: "h", cost_micro: 15_000_000, price_micro: 15_650_000,
      supplier: "mock", supplier_tx_id: null, status: "fulfilling", payer: "P", settlement_txid: "T",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.insertOrder(row as unknown as Parameters<typeof db.insertOrder>[0]);
    expect(db.committedCostByType()).toEqual([{ type: "topup", micro: 15_000_000 }]);
    await expect(orders.floatStatus()).resolves.toMatchObject({ availableMicro: 5_000_000 });
    // $20 in the wallet, $15 already spoken for — the $8 eSIM no longer fits.
    await expect(orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("fails OPEN when the balance cannot be read — a blip must not stop trading", async () => {
    const { orders } = withFloat(() => { throw new Error("supplier down"); });
    await expect(orders.floatStatus()).resolves.toMatchObject({ floatMicro: null, availableMicro: null });
    await expect(orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} })).resolves.toBeTruthy();
  });

  it("checks each product type against the wallet that actually fills it", async () => {
    // Measured 2026-09-01: Bitnob authenticates, publishes priceable NG corridors, and
    // holds 0.000000 USDC. Exempting payouts — as this gate originally did — would
    // settle a payer's USDC on the largest ticket we sell and then fail to finalise for
    // want of funds. A different wallet needs a different check, not no check.
    const goods = new MockSupplier();
    const partner = new MockSupplier();
    goods.balanceMicro = (async () => 1_000_000) as () => Promise<number>; // $1 of goods float
    partner.balanceMicro = (async () => 0) as () => Promise<number>; // wired and dry
    const { orders } = svc({ floatCacheMs: 0 }, new CompositeSupplier(goods, partner, null) as unknown as MockSupplier);
    const payoutArgs = {
      type: "payout" as const, offerId: "mock-payout-ng-bank", amount: 20_000,
      recipient: { fields: { account_number: "0123456789", bank_code: "058", full_name: "Ada L" } },
      sender: { name: "A Payer", country: "GB" },
    };

    await expect(orders.quote(payoutArgs)).rejects.toMatchObject({ status: 503 });
    await expect(orders.quote(payoutArgs)).rejects.toThrow(/payout partner float/);

    // The $1 goods float is irrelevant to a funded partner.
    partner.balanceMicro = (async () => 500_000_000) as () => Promise<number>;
    await expect(orders.quote(payoutArgs)).resolves.toBeTruthy();
  });

  it("does not let one wallet's in-flight orders block another's", async () => {
    const goods = new MockSupplier();
    const partner = new MockSupplier();
    goods.balanceMicro = (async () => 20_000_000) as () => Promise<number>;
    partner.balanceMicro = (async () => 500_000_000) as () => Promise<number>;
    const { db, orders } = svc({ floatCacheMs: 0 }, new CompositeSupplier(goods, partner, null) as unknown as MockSupplier);
    const row = (id: string, type: string, cost: number) => ({
      id, quote_id: `q_${id}`, type, offer_id: "o", country: "NG", brand: "B",
      recipient_json: "{}", recipient_hash: id, cost_micro: cost, price_micro: cost,
      supplier: "mock", supplier_tx_id: null, status: "fulfilling", payer: "P", settlement_txid: id,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // A $150 payout in flight against the partner's wallet...
    db.insertOrder(row("b", "payout", 150_000_000) as unknown as Parameters<typeof db.insertOrder>[0]);
    // ...must leave the whole $20 goods float available.
    await expect(orders.floatStatus("topup")).resolves.toMatchObject({ committedMicro: 0, availableMicro: 20_000_000 });
    await expect(orders.floatStatus("payout")).resolves.toMatchObject({ committedMicro: 150_000_000, availableMicro: 350_000_000 });
  });

});

describe("expired unpaid quotes do not accumulate forever", () => {
  // POST /v1/quote is free, unauthenticated and rate-limited only per IP, and every
  // call wrote a row nothing ever deleted. The database is a Docker volume on a box
  // that also runs other services, so filling it is not only this
  // service's outage.
  it("deletes expired, unconsumed quotes past the grace period", async () => {
    const { db, orders } = svc({ quoteTtlSec: -1 });
    await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    await orders.quote({ type: "esim", offerId: "mock-esim-global-1gb-7d", recipient: {} });
    // Nothing yet: the grace period keeps a late payment's error honest ("expired"
    // rather than "unknown quoteId").
    expect(db.pruneExpiredQuotes()).toBe(0);
    expect(db.pruneExpiredQuotes(-1)).toBe(2);
  });

  it("keeps quotes that were paid for — they are the record of what was promised", async () => {
    const { db, orders } = svc({ quoteTtlSec: -1 });
    const q = await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    db.consumeQuote(q.quoteId, "ord_real");
    expect(db.pruneExpiredQuotes(-1)).toBe(0);
    expect(db.getQuote(q.quoteId)).toBeTruthy();
  });

  it("sweeps from the writer, so cleanup tracks the rate of the thing being cleaned", async () => {
    const { db, orders } = svc({ quoteTtlSec: -1 });
    await orders.quote({ type: "esim", offerId: "mock-esim-in-5gb-30d", recipient: {} });
    // The first quote of a process primes the throttle; a later one does the sweep.
    // Reach past the 10-minute throttle rather than waiting for it.
    let swept = false;
    (orders as unknown as { lastPruneAt: number }).lastPruneAt = 0;
    (db as unknown as { pruneExpiredQuotes: (ms?: number) => number }).pruneExpiredQuotes =
      ((ms?: number) => { void ms; swept = true; return 0; });
    await orders.quote({ type: "esim", offerId: "mock-esim-global-1gb-7d", recipient: {} });
    expect(swept).toBe(true);
  });
});

describe("an order the floor would price is refused, not sold", () => {
  // The mock's Jio airtime is a RANGE offer at 12,100 micro per INR, so a tiny amount
  // produces a cost far below the $0.50 floor — the same shape as the real NG bundles.
  it("refuses a range amount too small to price fairly, and says what to ask for", async () => {
    const { orders } = svc();
    const e = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 10 }).catch((x) => x);
    expect(e).toBeInstanceOf(QuoteError);
    expect(e.message).toMatch(/too small to price fairly/);
    // The message must name a number the caller can act on, not just say no.
    expect(e.message).toMatch(/\$\d/);
  });

  it("still quotes a normal amount", async () => {
    const { orders } = svc();
    await expect(orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 100 }))
      .resolves.toMatchObject({ price_usdc: "1.310000" });
  });

  it("lets a looser tolerance through, so the rule is policy and not a hard-coded law", async () => {
    const { orders } = svc({ pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5, maxFloorMultiple: 100 } });
    await expect(orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 10 }))
      .resolves.toMatchObject({ price_usdc: "0.500000" });
  });
});
