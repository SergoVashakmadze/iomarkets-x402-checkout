// Replay guard and rate limiter. Both are in-memory and sit in front of the paid
// route, so both are attack surface as much as they are protection.
import { describe, expect, it } from "vitest";
import { RateLimiter, ReplayGuard, settledFromHeader, paymentTxn } from "../src/payments.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

describe("ReplayGuard", () => {
  it("accepts a txid once and rejects it inside the window", () => {
    const g = new ReplayGuard(1000);
    expect(g.has("TX1", 0)).toBe(false);
    g.record("TX1", 0);
    expect(g.has("TX1", 500)).toBe(true);
  });

  it("forgets a txid once its window has passed", () => {
    const g = new ReplayGuard(1000);
    g.record("TX1", 0);
    expect(g.has("TX1", 1001)).toBe(false);
  });

  it("keeps txids independent", () => {
    const g = new ReplayGuard(1000);
    g.record("TX1", 0);
    expect(g.has("TX2", 0)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit, then refuses", () => {
    const l = new RateLimiter(3);
    for (let i = 0; i < 3; i++) expect(l.allow("ip", 0)).toBe(true);
    expect(l.allow("ip", 0)).toBe(false);
  });

  it("opens a fresh window after a minute", () => {
    const l = new RateLimiter(1);
    expect(l.allow("ip", 0)).toBe(true);
    expect(l.allow("ip", 59_999)).toBe(false);
    expect(l.allow("ip", 60_001)).toBe(true);
  });

  it("counts each client separately", () => {
    const l = new RateLimiter(1);
    expect(l.allow("a", 0)).toBe(true);
    expect(l.allow("b", 0)).toBe(true);
    expect(l.allow("a", 0)).toBe(false);
  });

  // Keyed by client IP: without eviction, the thing protecting the box is also the
  // way to exhaust its memory.
  it("evicts finished windows instead of growing without bound", () => {
    const l = new RateLimiter(10, 100);
    for (let i = 0; i < 100; i++) l.allow(`ip-${i}`, 0);
    expect(l.size()).toBe(100);
    l.allow("late", 60_001); // every earlier window has expired by now
    expect(l.size()).toBe(1);
  });

  it("drops everything rather than grow when every window is still live", () => {
    const l = new RateLimiter(10, 100);
    for (let i = 0; i < 100; i++) l.allow(`ip-${i}`, 0);
    l.allow("one-more", 0); // nothing expired yet
    expect(l.size()).toBeLessThanOrEqual(100);
  });
});

describe("settledFromHeader", () => {
  it("reads the txid and payer the facilitator reported", () => {
    expect(settledFromHeader(b64({ success: true, transaction: "TX", payer: "P" }))).toEqual({ txid: "TX", payer: "P" });
  });

  it("accepts the alternative txid field names", () => {
    expect(settledFromHeader(b64({ txid: "TX" }))?.txid).toBe("TX");
    expect(settledFromHeader(b64({ txHash: "TX" }))?.txid).toBe("TX");
  });

  it("treats an unsuccessful, empty or unparseable header as no settlement", () => {
    expect(settledFromHeader(b64({ success: false, transaction: "TX" }))).toBeUndefined();
    expect(settledFromHeader(b64({ success: true }))).toBeUndefined();
    expect(settledFromHeader("not base64 json")).toBeUndefined();
    expect(settledFromHeader(null)).toBeUndefined();
    expect(settledFromHeader(undefined)).toBeUndefined();
  });
});

describe("paymentTxn", () => {
  // Garbage must never poison the replay guard or the payer ledger — it returns
  // undefined and lets the facilitator be the one to reject the payment.
  it("returns undefined for anything it cannot decode", () => {
    expect(paymentTxn(null)).toBeUndefined();
    expect(paymentTxn("!!!")).toBeUndefined();
    expect(paymentTxn(b64({}))).toBeUndefined();
    expect(paymentTxn(b64({ payload: {} }))).toBeUndefined();
    expect(paymentTxn(b64({ payload: { paymentGroup: [], paymentIndex: "0" } }))).toBeUndefined();
    expect(paymentTxn(b64({ payload: { paymentGroup: ["not-a-txn"], paymentIndex: 0 } }))).toBeUndefined();
    expect(paymentTxn(b64({ payload: { paymentGroup: [1], paymentIndex: 0 } }))).toBeUndefined();
  });
});

// Checking and recording are separate because an Algorand `exact` payment is
// deterministic: same sender, receiver, amount and validity window give the SAME txid.
// A client retrying after a failed settle therefore presents the identical transaction.
// The guard used to burn the txid in preflight, before settlement, so a dropped
// connection locked the payer out of a payment that had never been used — three
// attempts, three "payment already used", zero USDC moved (2026-08-29, first real order).
describe("ReplayGuard does not burn a txid that never settled", () => {
  it("has() is read-only — asking twice does not consume it", () => {
    const g = new ReplayGuard();
    expect(g.has("TX")).toBe(false);
    expect(g.has("TX")).toBe(false);
    expect(g.has("TX")).toBe(false);
  });

  it("only record() burns it", () => {
    const g = new ReplayGuard();
    expect(g.has("TX")).toBe(false);
    g.record("TX");
    expect(g.has("TX")).toBe(true);
  });

  it("lets a retry through after a settle that failed", () => {
    const g = new ReplayGuard();
    expect(g.has("TX")).toBe(false);   // attempt 1: preflight passes
    // …settlement fails, nothing recorded…
    expect(g.has("TX")).toBe(false);   // attempt 2 with the SAME deterministic txn
    g.record("TX");                    // …this one settles
    expect(g.has("TX")).toBe(true);    // and now it is genuinely spent
  });

  it("still expires a recorded txid after the window", () => {
    const g = new ReplayGuard(1_000);
    const t = Date.now();
    g.record("TX", t);
    expect(g.has("TX", t + 500)).toBe(true);
    expect(g.has("TX", t + 1_500)).toBe(false);
  });
});
