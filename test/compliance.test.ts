import { describe, expect, it } from "vitest";
import { checkPayout } from "../src/compliance.js";
import { blockedCountryList, offerTouchesBlocked } from "../src/sanctions.js";

const base = { country: "NG", priceMicro: 50_000_000, payerPayoutsTodayMicro: 0, sender: { name: "S", country: "GE" }, blockedCountries: ["IR", "KP"], maxUsd: 200, kycAboveUsd: 100 };

describe("payout compliance", () => {
  it("passes a normal payout", () => expect(checkPayout(base)).toEqual({ ok: true }));
  it("blocks sanctioned destination and sender countries", () => {
    expect(checkPayout({ ...base, country: "IR" })).toMatchObject({ ok: false, status: 403 });
    expect(checkPayout({ ...base, sender: { name: "S", country: "kp" } })).toMatchObject({ ok: false, status: 403 });
  });
  it("requires a sender", () => expect(checkPayout({ ...base, sender: undefined })).toMatchObject({ ok: false, status: 400 }));
  it("caps a single payment", () => expect(checkPayout({ ...base, priceMicro: 250_000_000 })).toMatchObject({ ok: false, status: 400 }));
  // CHANGED 2026-08-30, security review. A caller-supplied `sender.reference` used to
  // satisfy this gate on its own — and it is a free-form string in an unauthenticated
  // request body that nothing has ever validated. Quote with reference "x", pay from a
  // fresh address, repeat: unlimited unverified international payouts in $200 slices.
  // Above the threshold, only an onboarded business account's KYB reference counts.
  it("requires a KYB'd account above the daily threshold, cumulatively", () => {
    expect(checkPayout({ ...base, payerPayoutsTodayMicro: 60_000_000 })).toMatchObject({ ok: false, status: 403 });
    expect(checkPayout({ ...base, payerPayoutsTodayMicro: 60_000_000, account: { id: "acct_a", kybReference: "KYB-1" } })).toEqual({ ok: true });
  });
  it("does NOT let a string the caller typed stand in for a verified identity", () => {
    const typed = { ...base, payerPayoutsTodayMicro: 60_000_000, sender: { name: "S", country: "GE", reference: "kyc_1" } };
    expect(checkPayout(typed)).toMatchObject({ ok: false, status: 403 });
  });
  // A payer address is free to mint, so a per-payer daily total resets with a new
  // wallet. The beneficiary does not change when the sender rotates.
  it("caps what one recipient can be sent in a day, across every payer", () => {
    const r = { ...base, recipientDailyMaxUsd: 500, recipientPayoutsTodayMicro: 0 };
    expect(checkPayout(r)).toEqual({ ok: true });
    expect(checkPayout({ ...r, recipientPayoutsTodayMicro: 480_000_000 })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("sanctions floor", () => {
  it("env can add countries but never drop the sanctioned ones", () => {
    const list = blockedCountryList("");
    for (const c of ["RU", "BY", "IR", "KP", "SY", "CU", "VE", "MM"]) expect(list).toContain(c);
    expect(blockedCountryList("xx, ru")).toContain("XX");
    expect(blockedCountryList("GE")).toContain("RU");
  });
  it("blocks a regional bundle that covers a sanctioned country", () => {
    const blocked = blockedCountryList("");
    expect(offerTouchesBlocked({ country: "WW", regions: ["GH", "SD"] }, blocked)).toBe(true);
    expect(offerTouchesBlocked({ country: "WW", regions: ["DE", "FR"] }, blocked)).toBe(false);
    expect(offerTouchesBlocked({ country: "ru" }, blocked)).toBe(true);
  });
});
