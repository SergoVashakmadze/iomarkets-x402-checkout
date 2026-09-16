// The refund daily cap. It exists to bound what a bug or a compromised box can
// drain from the hot wallet, so "roughly right" is not good enough: it has to hold
// under concurrency, and it must not lock itself out when a send fails.
import { describe, expect, it } from "vitest";
import { DailyCap } from "../src/refunds.js";

const USDC = 1_000_000;

describe("DailyCap", () => {
  it("allows spending up to the cap", () => {
    const cap = new DailyCap(100 * USDC, () => 0);
    cap.reserve(60 * USDC);
    cap.reserve(40 * USDC);
    expect(cap.spentTodayMicro()).toBe(100 * USDC);
  });

  it("refuses the amount that would cross the cap, and keeps the rest available", () => {
    const cap = new DailyCap(100 * USDC, () => 0);
    cap.reserve(90 * USDC);
    expect(() => cap.reserve(20 * USDC)).toThrow(/daily cap reached/);
    // The rejected amount was never counted, so the remaining headroom still works.
    expect(cap.spentTodayMicro()).toBe(90 * USDC);
    cap.reserve(10 * USDC);
    expect(cap.spentTodayMicro()).toBe(100 * USDC);
  });

  // The check used to be "read today's total from the db, then send". Two refunds
  // could read the same total, both pass, and together exceed the cap — and because
  // the caller records a refund only after send() resolves, the db total lagged
  // anything still in flight. Reserving up front is what closes that.
  it("counts a reservation immediately, so a concurrent one cannot reuse the headroom", () => {
    let dbTotal = 0; // the db stays at 0 until the caller records the refund
    const cap = new DailyCap(100 * USDC, () => dbTotal);
    cap.reserve(60 * USDC);
    expect(() => cap.reserve(60 * USDC)).toThrow(/daily cap reached/);
    expect(dbTotal).toBe(0);
  });

  // A flaky algod must not eat the day's allowance for refunds that never happened.
  it("gives back a reservation whose send failed", () => {
    const cap = new DailyCap(100 * USDC, () => 0);
    cap.reserve(100 * USDC);
    expect(() => cap.reserve(1)).toThrow();
    cap.release(100 * USDC);
    expect(cap.spentTodayMicro()).toBe(0);
    cap.reserve(100 * USDC); // the whole cap is available again
  });

  it("never releases below zero", () => {
    const cap = new DailyCap(100 * USDC, () => 0);
    cap.reserve(10 * USDC);
    cap.release(50 * USDC);
    expect(cap.spentTodayMicro()).toBe(0);
  });

  it("seeds from the db once per day rather than per reservation", () => {
    let seeds = 0;
    const cap = new DailyCap(100 * USDC, () => { seeds++; return 25 * USDC; });
    cap.reserve(10 * USDC);
    cap.reserve(10 * USDC);
    expect(seeds).toBe(1);
    // Refunds already recorded today count against the cap after a restart.
    expect(cap.spentTodayMicro()).toBe(45 * USDC);
  });

  it("includes refunds recorded before this process started", () => {
    const cap = new DailyCap(100 * USDC, () => 95 * USDC);
    expect(() => cap.reserve(10 * USDC)).toThrow(/daily cap reached/);
    cap.reserve(5 * USDC);
  });
});
