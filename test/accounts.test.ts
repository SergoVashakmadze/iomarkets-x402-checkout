// Business accounts: the tier that lets one onboarded counterparty move real money
// without loosening the default posture for anonymous agents.
//
// The security property under test is that limits key on the PAYER ADDRESS, which the
// settlement proves, and never on a field in the request body, which anyone can paste.

import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { ceilingMicro, limitsFor, usd, type AccountRow } from "../src/accounts.js";
import { checkPayout } from "../src/compliance.js";
import { checkAccountCeilings } from "../src/preflight.js";
import { parseTypeMax } from "../src/config.js";

const M = 1_000_000;
const D = { maxOrderMicro: 50 * M, payoutMaxMicro: 200 * M, dailyMicro: 200 * M };
const A = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: "acct_aabbccddeeff", name: "Acme Ltd", country: "GB", kyb_reference: "KYB-1",
  status: "active", max_order_micro: null, payout_max_micro: null, daily_micro: null,
  notes: null, created_at: "2026-08-30T00:00:00Z", updated_at: "2026-08-30T00:00:00Z", ...over,
});
const ADDR_A = "A".repeat(58);
const ADDR_B = "B".repeat(58);

describe("limitsFor", () => {
  it("an unknown payer is exactly the pre-existing standard tier", () => {
    const l = limitsFor(undefined, D);
    expect(l).toMatchObject({ tier: "standard", maxOrderMicro: 50 * M, payoutMaxMicro: 200 * M, dailyMicro: 200 * M });
    expect(l.accountId).toBeUndefined();
    expect(l.kybReference).toBeUndefined();
  });

  it("a null column inherits the default; an explicit one overrides it, up OR down", () => {
    expect(limitsFor(A(), D).maxOrderMicro).toBe(50 * M);
    expect(limitsFor(A({ max_order_micro: 500 * M }), D).maxOrderMicro).toBe(500 * M);
    // A deliberately restricted account is a real thing to want, so lower must work too.
    expect(limitsFor(A({ daily_micro: 25 * M }), D).dailyMicro).toBe(25 * M);
  });

  it("a suspended account is REFUSED, not quietly dropped to the standard tier", () => {
    const l = limitsFor(A({ status: "suspended" }), D);
    expect(l.blocked).toMatch(/suspended/);
    // Falling back to $200/day would be a decision nobody made.
    expect(l.tier).toBe("business");
  });

  it("picks the payout ceiling for payouts and the goods ceiling for everything else", () => {
    const l = limitsFor(A({ max_order_micro: 500 * M, payout_max_micro: 2_000 * M }), D);
    expect(ceilingMicro(l, "payout")).toBe(2_000 * M);
    expect(ceilingMicro(l, "topup")).toBe(500 * M);
    expect(ceilingMicro(l, "esim")).toBe(500 * M);
  });
});

describe("the KYB reference satisfies the payout KYC threshold", () => {
  const base = {
    country: "NG", priceMicro: 150 * M, payerPayoutsTodayMicro: 0,
    sender: { name: "Acme Ltd", country: "GB" },
    blockedCountries: ["CU"], maxUsd: 2000, kycAboveUsd: 100,
  };
  it("refuses above the threshold with no reference and no account", () => {
    expect(checkPayout(base)).toMatchObject({ ok: false, status: 403 });
  });
  it("accepts once a business account's KYB reference stands behind it", () => {
    expect(checkPayout({ ...base, account: { id: "acct_aabbccddeeff", kybReference: "KYB-1" } })).toEqual({ ok: true });
  });
  it("still refuses a sanctioned destination and an over-ceiling payment", () => {
    const acct = { id: "acct_aabbccddeeff", kybReference: "KYB-1" };
    expect(checkPayout({ ...base, account: acct, country: "CU" })).toMatchObject({ ok: false });
    expect(checkPayout({ ...base, account: acct, priceMicro: 5_000 * M })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("db binding", () => {
  it("resolves an account from a bound address and nothing from an unbound one", () => {
    const db = new Db(":memory:");
    db.insertAccount(A());
    db.bindPayer(ADDR_A, "acct_aabbccddeeff");
    expect(db.accountForPayer(ADDR_A)?.name).toBe("Acme Ltd");
    expect(db.accountForPayer(ADDR_B)).toBeUndefined();
    expect(db.accountForPayer(undefined)).toBeUndefined();
  });

  it("an address belongs to at most one account; re-binding moves it", () => {
    const db = new Db(":memory:");
    db.insertAccount(A());
    db.insertAccount(A({ id: "acct_111111111111", name: "Other Ltd" }));
    db.bindPayer(ADDR_A, "acct_aabbccddeeff");
    db.bindPayer(ADDR_A, "acct_111111111111");
    expect(db.accountForPayer(ADDR_A)?.id).toBe("acct_111111111111");
    expect(db.payersOf("acct_aabbccddeeff")).toEqual([]);
    expect(db.unbindPayer(ADDR_A)).toBe(true);
    expect(db.unbindPayer(ADDR_A)).toBe(false);
  });

  it("the daily total aggregates every address the account owns", () => {
    const db = new Db(":memory:");
    db.insertAccount(A());
    db.bindPayer(ADDR_A, "acct_aabbccddeeff");
    db.bindPayer(ADDR_B, "acct_aabbccddeeff");
    const order = (payer: string, price: number, type = "payout") => db.insertOrder({
      id: `ord_${payer[0]}${price}`, quote_id: "q", payer, type, offer_id: "o", country: "NG", brand: "b",
      recipient_json: "{}", recipient_hash: "h", cost_micro: price, price_micro: price, supplier: "mock",
      supplier_tx_id: null, status: "delivered", settlement_txid: `TX_${payer[0]}${price}`, confirmation_json: null,
      error: null, receipt_json: null, refund_txid: null, refund_error: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), delivered_at: null,
    });
    order(ADDR_A, 60 * M);
    order(ADDR_B, 70 * M);
    order(ADDR_B, 5 * M, "topup");
    // Rotating wallets must not reset the clock — the account total is what counts.
    expect(db.accountSpentTodayMicro("acct_aabbccddeeff", "payout")).toBe(130 * M);
    expect(db.accountSpentTodayMicro("acct_aabbccddeeff")).toBe(135 * M);
  });
});

describe("checkAccountCeilings", () => {
  it("passes when there are no accounts, or all are within the refund cap", () => {
    expect(checkAccountCeilings([], 100 * M).level).toBe("ok");
    expect(checkAccountCeilings([A({ max_order_micro: 100 * M })], 100 * M).level).toBe("ok");
  });
  it("fails a ceiling the refund float cannot stand behind", () => {
    const r = checkAccountCeilings([A({ payout_max_micro: 2_000 * M })], 100 * M);
    expect(r.level).toBe("fail");
    expect(r.detail).toMatch(/cannot be refunded/);
  });
  it("ignores a suspended account, which cannot spend anything", () => {
    expect(checkAccountCeilings([A({ status: "suspended", payout_max_micro: 9_000 * M })], 100 * M).level).toBe("ok");
  });
});

describe("usd", () => {
  it("says what a human would say", () => {
    expect(usd(200 * M)).toBe("$200");
    expect(usd(12_500_000)).toBe("$12.50");
  });
});

// The security property, end to end: the `payer` on a quote is an unauthenticated
// claim. Anyone could name a business account's address to inherit its ceilings and
// then pay from their own wallet. Preflight re-resolves limits from the REAL settled
// payer and re-checks the per-order ceiling — not just the daily one — which is what
// closes that. This test pays from the wrong wallet and expects a refusal.
describe("a quote's payer is a claim; the settled payer is the fact", () => {
  const build = async () => {
    const algosdk = (await import("algosdk")).default;
    const { OrderService } = await import("../src/orders.js");
    const { makePreflight } = await import("../src/app.js");
    const { ReplayGuard } = await import("../src/payments.js");
    const { MockSupplier } = await import("../src/suppliers/mock.js");
    const { generateKeypair } = await import("../src/receipt.js");

    const db = new Db(":memory:");
    const kp = generateKeypair();
    // A deliberately tiny default so an ordinary $3.90 top-up is over the standard
    // ceiling and inside the account's — the difference the tier exists to make.
    const orders = new OrderService(db, new MockSupplier(), { async send(id: string) { return `RF_${id}`; }, address: () => "R" }, {
      pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 },
      maxOrderUsd: 1, quoteTtlSec: 600, blockedCountries: ["CU"],
      payout: { maxUsd: 1, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 1,
      receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders",
      pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    });

    const partner = algosdk.generateAccount();
    const stranger = algosdk.generateAccount();
    db.insertAccount(A({ max_order_micro: 500 * M, payout_max_micro: 500 * M, daily_micro: 10_000 * M }));
    db.bindPayer(partner.addr.toString(), "acct_aabbccddeeff");

    const header = (acct: ReturnType<typeof algosdk.generateAccount>) => {
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: acct.addr, receiver: acct.addr, amount: 1,
        suggestedParams: { fee: 1000, minFee: 1000, firstValid: 1, lastValid: 1001, genesisID: "t", genesisHash: new Uint8Array(32) },
      });
      const signed = Buffer.from(txn.signTxn(acct.sk)).toString("base64");
      return Buffer.from(JSON.stringify({ payload: { paymentGroup: [signed], paymentIndex: 0 } })).toString("base64");
    };
    return { db, orders, partner, stranger, header, pre: makePreflight(orders, db, new ReplayGuard()) };
  };

  it("lets the bound address buy above the standard ceiling", async () => {
    const { orders, partner, header, pre } = await build();
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 100, payer: partner.addr.toString() });
    expect(Number(q.price_usdc)).toBeGreaterThan(1); // over the $1 standard ceiling
    expect(await pre(q.quoteId, header(partner))).toBeUndefined();
  });

  it("refuses when the money actually arrives from an unbound wallet", async () => {
    const { orders, partner, stranger, header, pre } = await build();
    // Quoted while NAMING the partner's address — which anyone may do.
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 100, payer: partner.addr.toString() });
    // …then paid from a wallet that account never authorised.
    expect(await pre(q.quoteId, header(stranger))).toMatchObject({ abort: true, reason: expect.stringContaining("$1") });
  });

  it("refuses a suspended account even from its own bound address", async () => {
    const { db, orders, partner, header, pre } = await build();
    const q = await orders.quote({ type: "topup", offerId: "mock-in-jio-airtime", recipient: { phone: "919876543210" }, amount: 100, payer: partner.addr.toString() });
    db.updateAccount("acct_aabbccddeeff", { status: "suspended" });
    expect(await pre(q.quoteId, header(partner))).toMatchObject({ abort: true, reason: expect.stringContaining("suspended") });
  });
});

// ⚠️ The vulnerability this guards, found in review 2026-08-30:
//
// A business account is allowed to omit `sender` on a payout, because the account IS
// the sender. The sender was filled in from whatever account the quote's `payer` named
// — and `payer` is an unauthenticated hint. So a stranger could quote a payout naming
// an onboarded company's address, inherit that company's legal name as the sender, and
// then settle it from their own wallet: an international payment to a stranger's bank
// account, attributed to a KYB'd business that never authorised it, and under the
// standard ceiling so nothing else refused it.
//
// The quote now records which account the sender came from, and preflight refuses
// unless the real settled payer belongs to that same account.
describe("a sender inherited from a business account is bound to that account", () => {
  const build = async () => {
    const algosdk = (await import("algosdk")).default;
    const { OrderService } = await import("../src/orders.js");
    const { makePreflight } = await import("../src/app.js");
    const { ReplayGuard } = await import("../src/payments.js");
    const { MockSupplier } = await import("../src/suppliers/mock.js");
    const { generateKeypair } = await import("../src/receipt.js");

    const db = new Db(":memory:");
    const kp = generateKeypair();
    const orders = new OrderService(db, new MockSupplier(), { async send(id: string) { return `RF_${id}`; }, address: () => "R" }, {
      pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 },
      maxOrderUsd: 50, quoteTtlSec: 600, blockedCountries: ["CU"],
      payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
      receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders",
      pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    });

    const partner = algosdk.generateAccount();
    const stranger = algosdk.generateAccount();
    db.insertAccount(A());
    db.bindPayer(partner.addr.toString(), "acct_aabbccddeeff");

    const header = (acct: ReturnType<typeof algosdk.generateAccount>) => {
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: acct.addr, receiver: acct.addr, amount: 1,
        suggestedParams: { fee: 1000, minFee: 1000, firstValid: 1, lastValid: 1001, genesisID: "t", genesisHash: new Uint8Array(32) },
      });
      return Buffer.from(JSON.stringify({ payload: { paymentGroup: [Buffer.from(txn.signTxn(acct.sk)).toString("base64")], paymentIndex: 0 } })).toString("base64");
    };
    const quoteAs = (payer: string, sender?: { name: string; country: string }) => orders.quote({
      type: "payout", offerId: "mock-payout-ke-mpesa", amount: 500,
      recipient: { fields: { full_name: "Grace Wanjiru" } }, payer, sender,
    });
    return { db, orders, partner, stranger, header, quoteAs, pre: makePreflight(orders, db, new ReplayGuard()) };
  };

  it("fills the sender from the account, and lets that account pay", async () => {
    const { db, partner, header, quoteAs, pre } = await build();
    const q = await quoteAs(partner.addr.toString());
    const stored = JSON.parse(db.getQuote(q.quoteId)!.recipient_json);
    expect(stored.sender).toMatchObject({ name: "Acme Ltd", country: "GB" });
    expect(stored.sender_account).toBe("acct_aabbccddeeff");
    expect(await pre(q.quoteId, header(partner))).toBeUndefined();
  });

  it("REFUSES when the money arrives from a wallet that account never authorised", async () => {
    const { stranger, partner, header, quoteAs, pre } = await build();
    const q = await quoteAs(partner.addr.toString());          // anyone may name this address
    const r = await pre(q.quoteId, header(stranger));          // …but not settle it
    expect(r).toMatchObject({ abort: true });
    expect((r as { reason: string }).reason).toMatch(/belongs to another account/);
  });

  it("leaves a caller's own typed sender alone — it claims nothing about anyone onboarded", async () => {
    const { db, stranger, header, quoteAs, pre } = await build();
    const q = await quoteAs(stranger.addr.toString(), { name: "Someone Else Ltd", country: "GB" });
    const stored = JSON.parse(db.getQuote(q.quoteId)!.recipient_json);
    expect(stored.sender_account).toBeUndefined();
    expect(await pre(q.quoteId, header(stranger))).toBeUndefined();
  });

  it("does not let an explicit sender override the binding on an account's quote", async () => {
    const { partner, stranger, header, quoteAs, pre } = await build();
    // An explicit sender means no binding is recorded — so the stranger may pay, but
    // the payment carries the name THEY supplied, not the onboarded company's.
    const q = await quoteAs(partner.addr.toString(), { name: "Stranger Ltd", country: "GB" });
    expect(await pre(q.quoteId, header(stranger))).toBeUndefined();
  });
});

// The unauthenticated limits route must not publish a counterparty's live volume.
describe("GET /v1/limits discloses ceilings, never spend", () => {
  it("omits spend-to-date and remaining-today entirely", async () => {
    const { buildApp } = await import("../src/app.js");
    const { OrderService } = await import("../src/orders.js");
    const { MockSupplier } = await import("../src/suppliers/mock.js");
    const { generateKeypair } = await import("../src/receipt.js");
    const algosdk = (await import("algosdk")).default;

    const db = new Db(":memory:");
    const supplier = new MockSupplier();
    const orders = new OrderService(db, supplier, { async send(id: string) { return `RF_${id}`; }, address: () => "R" }, {
      pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 },
      maxOrderUsd: 50, quoteTtlSec: 600, blockedCountries: ["CU"],
      payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
      receiptPrivateKey: generateKeypair().privateKey, ordersEndpoint: "http://x/v1/orders",
      pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
    });
    const app = buildApp({ db, supplier, orders });
    const addr = algosdk.generateAccount().addr.toString();
    db.insertAccount(A({ payout_max_micro: 2_000 * M }));
    db.bindPayer(addr, "acct_aabbccddeeff");

    const body = await (await app.request("/v1/limits?payer=" + addr)).json();
    expect(body.tier).toBe("business");
    expect(body.max_payout_usdc).toBe("2000.000000");
    expect(body).not.toHaveProperty("spent_today_usdc");
    expect(body).not.toHaveProperty("remaining_today_usdc");
    // And it still says nothing about WHO the account is.
    expect(JSON.stringify(body)).not.toContain("Acme");
    expect(JSON.stringify(body)).not.toContain("KYB-1");
    expect((await app.request("/v1/limits?payer=notanaddress")).status).toBe(400);
  });
});

// A ceiling that is right for the whole catalogue is wrong for every product in it.
// An airtime top-up lands on one phone number and is worthless to anyone else; a gift
// card is a bearer instrument, and crypto in / redeemable code out is the standard
// laundering shape. Capping everything at the gift-card number cripples the products
// that carry the volume; capping nothing per product means the safest global ceiling is
// whatever the riskiest product needs.
describe("per-product-type ceilings", () => {
  const defaults = {
    maxOrderMicro: 50_000_000, payoutMaxMicro: 200_000_000, dailyMicro: 200_000_000,
    typeMaxMicro: { giftcard: 25_000_000 },
  };

  it("caps the capped type and leaves everything else at the global ceiling", () => {
    const l = limitsFor(undefined, defaults);
    expect(ceilingMicro(l, "giftcard")).toBe(25_000_000);
    expect(ceilingMicro(l, "topup")).toBe(50_000_000);
    expect(ceilingMicro(l, "bill")).toBe(50_000_000);
    expect(ceilingMicro(l, "payout")).toBe(200_000_000);
  });

  it("can only lower the ceiling, never raise it", () => {
    // A type cap above the global one must not become a way to buy more.
    const l = limitsFor(undefined, { ...defaults, maxOrderMicro: 10_000_000 });
    expect(ceilingMicro(l, "giftcard")).toBe(10_000_000);
  });

  it("still binds a business account that merely inherits the default", () => {
    // Inheriting is not deciding. A KYB'd account with no hand-set ceiling gets the
    // same gift-card cap as anyone else.
    const account = {
      id: "acc_1", name: "N", country: "GB", kyb_reference: "KYB1", status: "active" as const,
      max_order_micro: null, payout_max_micro: null, daily_micro: null, notes: null,
      created_at: "", updated_at: "",
    };
    const l = limitsFor(account, defaults);
    expect(l.tier).toBe("business");
    expect(ceilingMicro(l, "giftcard")).toBe(25_000_000);
  });

  it("is overridden by a business account whose ceiling was set by hand", () => {
    // The raise is a decision with a KYB reference and a name attached — which is
    // exactly the circumstance in which a higher gift-card ceiling is reasonable.
    const account = {
      id: "acc_2", name: "N", country: "GB", kyb_reference: "KYB2", status: "active" as const,
      max_order_micro: 500_000_000, payout_max_micro: null, daily_micro: null, notes: null,
      created_at: "", updated_at: "",
    };
    const l = limitsFor(account, defaults);
    expect(ceilingMicro(l, "giftcard")).toBe(500_000_000);
  });

  it("refuses a malformed TYPE_MAX_USD at boot rather than dropping the ceiling", () => {
    expect(parseTypeMax("giftcard=25,bill=150")).toEqual({ giftcard: 25, bill: 150 });
    expect(parseTypeMax("")).toEqual({});
    // A ceiling that silently fails to parse is a ceiling that silently is not there.
    expect(() => parseTypeMax("giftcard=abc")).toThrow(/TYPE_MAX_USD/);
    expect(() => parseTypeMax("giftcard")).toThrow(/TYPE_MAX_USD/);
    expect(() => parseTypeMax("giftcard=-5")).toThrow(/TYPE_MAX_USD/);
    expect(() => parseTypeMax("giftcard=0")).toThrow(/TYPE_MAX_USD/);
  });
});
