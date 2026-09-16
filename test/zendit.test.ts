// Zendit adapter, checked against the published OpenAPI 2.0 spec
// (test-api.zendit.io/swagger/doc.json, basePath /v1). `fetch` is stubbed: these
// assert the exact request shapes the spec requires, so a live sandbox run only has
// to confirm semantics (fees, fx) rather than field names.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZenditSupplier, costMinorUnits } from "../src/suppliers/zendit.js";
import { SupplierError } from "../src/suppliers/types.js";

const BASE = "https://test-api.zendit.io/v1";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

/** Stub fetch with a canned reply per path suffix; records every call. */
function stub(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    });
    const key = Object.keys(routes).find((k) => url.startsWith(`${BASE}${k}`));
    const r = key ? routes[key] : undefined;
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const money = (o: Partial<Record<string, number | string>> = {}) => ({ currency: "USD", currencyDivisor: 100, ...o });

/** dto.TopupOffer, RANGE — INR 10–5000 costs $0.12–$60. */
const rangeOffer = {
  offerId: "IN-AIRTEL-RANGE", brand: "AIRTEL", brandName: "Airtel", country: "IN", enabled: true,
  priceType: "RANGE", shortNotes: "Airtel airtime",
  cost: money({ min: 12, max: 6000 }), price: money({ min: 13, max: 6500 }),
  send: { currency: "INR", currencyDivisor: 1, min: 10, max: 5000 },
};
/** dto.TopupOffer, FIXED — a fixed $2.90 bundle. */
const fixedOffer = {
  offerId: "IN-JIO-1GB", brand: "JIO", brandName: "Jio", country: "IN", enabled: true,
  priceType: "FIXED", shortNotes: "Jio 1 GB / 28 days", dataGB: 1, durationDays: 28,
  cost: money({ fixed: 290 }), price: money({ fixed: 310 }),
  send: { currency: "INR", currencyDivisor: 1, fixed: 249 },
};
/** dto.ESimOffer — always FIXED, and has no `send`. */
const esimOffer = {
  offerId: "ESIM-IN-5GB", brand: "ESIM", brandName: "eSIM", country: "IN", enabled: true,
  priceType: "FIXED", shortNotes: "India 5 GB / 30 days", dataGB: 5, durationDays: 30,
  cost: money({ fixed: 700 }), price: money({ fixed: 760 }), regions: ["IN"],
};

const sup = () => new ZenditSupplier("test-key", BASE);

afterEach(() => vi.unstubAllGlobals());

describe("offers", () => {
  it("sends the required _limit/_offset params and the bearer token", async () => {
    const calls = stub({ "/topups/offers": { json: { list: [rangeOffer], limit: 100, offset: 0, total: 1 } } });
    await sup().listOffers({ type: "topup", country: "IN" });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("_limit")).toBe("100");
    expect(u.searchParams.get("_offset")).toBe("0");
    expect(u.searchParams.get("country")).toBe("IN");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
  });

  it("maps a RANGE offer's bounds into micro-USD and a per-send-unit cost", async () => {
    stub({ "/topups/offers": { json: { list: [rangeOffer] } } });
    const [o] = await sup().listOffers({ type: "topup" });
    expect(o.priceType).toBe("range");
    expect(o.costMinMicro).toBe(120_000); // 12 cents
    expect(o.costMaxMicro).toBe(60_000_000); // $60
    expect(o.sendMin).toBe(10);
    expect(o.sendMax).toBe(5000);
    // $0.12 buys INR 10 ⇒ 12_000 micro-USD per INR, rounded up.
    expect(o.costPerSendUnitMicro).toBe(12_000);
  });

  it("maps a FIXED offer and honours a non-100 send divisor", async () => {
    stub({ "/topups/offers": { json: { list: [fixedOffer] } } });
    const [o] = await sup().listOffers({ type: "topup" });
    expect(o.priceType).toBe("fixed");
    expect(o.costMicro).toBe(2_900_000);
    expect(o.sendFixed).toBe(249);
    expect(o.name).toBe("Jio 1 GB / 28 days");
  });

  it("drops disabled offers", async () => {
    stub({ "/topups/offers": { json: { list: [{ ...rangeOffer, enabled: false }] } } });
    expect(await sup().listOffers({ type: "topup" })).toEqual([]);
  });

  it("carries billpay requiredFields and deliverySpeedSeconds through mapOffer", async () => {
    // Reached via esim's path, since bill is refused outright — this pins the mapping
    // itself so re-enabling bills later does not silently lose the fields.
    stub({ "/esim/offers": { json: { list: [{ ...esimOffer, requiredFields: ["account_number"], deliverySpeedSeconds: 90 }] } } });
    const [o] = await sup().listOffers({ type: "esim" });
    expect(o.requiredFields).toEqual(["account_number"]);
    expect(o.settlementSeconds).toBe(90);
  });

  it("rejects a non-USD wallet currency rather than mispricing", async () => {
    stub({ "/topups/offers": { json: { list: [{ ...fixedOffer, cost: { currency: "EUR", currencyDivisor: 100, fixed: 290 } }] } } });
    await expect(sup().listOffers({ type: "topup" })).rejects.toThrow(/EUR/);
  });
});

describe("purchase bodies", () => {
  it("OMITS value for a FIXED topup (the spec requires value only for RANGE)", async () => {
    const calls = stub({
      "/topups/offers/IN-JIO-1GB": { json: fixedOffer },
      "/topups/purchases": { json: { transactionId: "ord_1", status: "ACCEPTED" } },
    });
    const r = await sup().purchase({
      orderId: "ord_1", type: "topup", offerId: "IN-JIO-1GB",
      recipient: { phone: "+919876543210" }, costMicro: 2_900_000,
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ offerId: "IN-JIO-1GB", recipientPhoneNumber: "+919876543210", transactionId: "ord_1" });
    expect(post.body.value).toBeUndefined();
    expect(r.status).toBe("pending");
    expect(r.supplierTxId).toBe("ord_1");
  });

  it("sends value {type:COST} in the offer's minor units for a RANGE topup", async () => {
    const calls = stub({
      "/topups/offers/IN-AIRTEL-RANGE": { json: rangeOffer },
      "/topups/purchases": { json: { transactionId: "ord_2", status: "ACCEPTED" } },
    });
    await sup().purchase({
      orderId: "ord_2", type: "topup", offerId: "IN-AIRTEL-RANGE",
      recipient: { phone: "+919876543210" }, costMicro: 3_588_000, // $3.588 → 358 cents (floored)
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body.value).toEqual({ type: "COST", value: 358 });
  });

  it("uses our order id as the (client-supplied, idempotent) transactionId", async () => {
    const calls = stub({
      "/topups/offers/IN-JIO-1GB": { json: fixedOffer },
      "/topups/purchases": { json: { status: "ACCEPTED" } }, // no transactionId echoed
    });
    const r = await sup().purchase({
      orderId: "ord_3", type: "topup", offerId: "IN-JIO-1GB",
      recipient: { phone: "+91987" }, costMicro: 2_900_000,
    });
    expect(calls.find((c) => c.method === "POST")!.body.transactionId).toBe("ord_3");
    expect(r.supplierTxId).toBe("ord_3"); // falls back to ours so polling still works
  });

  it("sends only offerId/transactionId/iccid for an eSIM, never a value", async () => {
    const calls = stub({
      "/esim/offers/ESIM-IN-5GB": { json: esimOffer },
      "/esim/purchases": { json: { transactionId: "ord_4", status: "ACCEPTED" } },
    });
    await sup().purchase({
      orderId: "ord_4", type: "esim", offerId: "ESIM-IN-5GB",
      recipient: { iccid: "8991..." }, costMicro: 7_000_000,
    });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ offerId: "ESIM-IN-5GB", transactionId: "ord_4", iccid: "8991..." });
  });

  it("reuses the cached offer instead of re-fetching between quote and purchase", async () => {
    const calls = stub({
      "/topups/offers": { json: { list: [fixedOffer] } },
      "/topups/purchases": { json: { transactionId: "ord_5", status: "ACCEPTED" } },
    });
    const s = sup();
    await s.listOffers({ type: "topup" });
    await s.purchase({ orderId: "ord_5", type: "topup", offerId: "IN-JIO-1GB", recipient: { phone: "+91987" }, costMicro: 2_900_000 });
    expect(calls.filter((c) => c.url.includes("/offers/"))).toHaveLength(0);
  });

  it("refuses a topup with no recipient phone before calling the API", async () => {
    const calls = stub({ "/topups/offers/IN-JIO-1GB": { json: fixedOffer } });
    await expect(sup().purchase({ orderId: "o", type: "topup", offerId: "IN-JIO-1GB", recipient: {}, costMicro: 1 }))
      .rejects.toThrow(/recipient.phone/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("unsupported product types", () => {
  it("refuses payouts", async () => {
    await expect(sup().purchase({ orderId: "o", type: "payout", offerId: "x", recipient: {}, costMicro: 1 }))
      .rejects.toThrow(/does not do payouts/);
  });

  // dto.BillPayPurchaseInput requires full sender AND recipient identity objects
  // (names, DOB, phone, complete postal address). Nothing upstream collects those, so
  // the adapter must refuse BEFORE the payer's USDC settles — not 400 afterwards.
  it("refuses bill pay rather than failing after payment", async () => {
    await expect(sup().purchase({ orderId: "o", type: "bill", offerId: "x", recipient: { phone: "+1" }, costMicro: 1 }))
      .rejects.toThrow(/KYC identity/);
  });

  it("hides bill and payout offers from the catalogue", async () => {
    const s = sup();
    expect(await s.listOffers({ type: "bill" })).toEqual([]);
    expect(await s.listOffers({ type: "payout" })).toEqual([]);
    expect(await s.getOffer("bill", "x")).toBeNull();
  });
});

describe("status mapping", () => {
  const done = (extra: object) => ({ "/topups/purchases/tx": { json: { transactionId: "tx", status: "DONE", ...extra } } });

  it("maps DONE to delivered and passes the confirmation through", async () => {
    stub(done({ confirmation: { confirmationNumber: "C1", externalReferenceId: "E1" } }));
    const r = await sup().getPurchase("topup", "tx");
    expect(r.status).toBe("delivered");
    expect(r.confirmation).toEqual({ confirmationNumber: "C1", externalReferenceId: "E1" });
  });

  it("builds the LPA activation string for a delivered eSIM", async () => {
    stub({ "/esim/purchases/tx": { json: { transactionId: "tx", status: "DONE", confirmation: { smdpAddress: "rsp.truphone.com", activationCode: "AC1", iccid: "8991" } } } });
    const r = await sup().getPurchase("esim", "tx");
    expect(r.confirmation!.lpa).toBe("LPA:1$rsp.truphone.com$AC1");
  });

  it.each(["ACCEPTED", "PENDING", "AUTHORIZED", "IN_PROGRESS"] as const)("treats %s as pending", async (status) => {
    stub({ "/topups/purchases/tx": { json: { transactionId: "tx", status } } });
    expect((await sup().getPurchase("topup", "tx")).status).toBe("pending");
  });

  it("prefers error.message, then error.code, then the last log line", async () => {
    stub({ "/topups/purchases/tx": { json: { transactionId: "tx", status: "FAILED", error: { code: "E12", message: "operator declined" } } } });
    expect((await sup().getPurchase("topup", "tx")).error).toBe("operator declined");

    vi.unstubAllGlobals();
    stub({ "/topups/purchases/tx": { json: { transactionId: "tx", status: "FAILED", log: [{ status: "FAILED", statusMessage: "no route" }] } } });
    expect((await sup().getPurchase("topup", "tx")).error).toBe("no route");
  });
});

describe("errors and balance", () => {
  it("surfaces errorCode and message, and marks 5xx retryable", async () => {
    stub({ "/balance": { status: 500, json: { errorCode: "INTERNAL", message: "boom" } } });
    const e = await sup().balanceMicro().catch((x) => x);
    expect(e).toBeInstanceOf(SupplierError);
    expect(e.message).toMatch(/\[INTERNAL\].*boom/);
    expect(e.retryable).toBe(true);
  });

  it("treats a 400 as non-retryable", async () => {
    stub({ "/balance": { status: 400, json: { errorCode: "BAD", message: "nope" } } });
    const e = await sup().balanceMicro().catch((x) => x);
    expect(e.retryable).toBe(false);
  });

  it("converts the wallet balance to micro-USD", async () => {
    stub({ "/balance": { json: { availableBalance: 12_345, currency: "USD", currencyDivisor: 100 } } });
    expect(await sup().balanceMicro()).toBe(123_450_000); // $123.45
  });

  // Callers normalise to digits first (normalizeMsisdn in src/app.ts), which is what
  // countryOfMsisdn's dial-code table expects — a "+" prefix would defeat the fallback.
  it("falls back to the dial-code country when phone lookup 400s", async () => {
    stub({ "/tools/phonenumberlookup": { status: 400, json: { message: "unknown" } } });
    expect(await sup().lookupPhone("919876543210")).toEqual({ msisdn: "919876543210", country: "IN" });
  });

  it("returns the operator brand the lookup reports", async () => {
    stub({ "/tools/phonenumberlookup": { json: { msisdn: "919876543210", country: "IN", brand: "AIRTEL", mobileCountryCode: "404", mobileNetworkCode: "10" } } });
    expect(await sup().lookupPhone("919876543210")).toEqual({ msisdn: "919876543210", country: "IN", brand: "AIRTEL" });
  });
});

describe("costMinorUnits", () => {
  it("floors so a rounding artefact can never exceed the quoted cost", () => {
    expect(costMinorUnits(3_589_999, { currency: "USD", currencyDivisor: 100 })).toBe(358);
  });

  it("respects a divisor other than 100", () => {
    expect(costMinorUnits(1_500_000, { currency: "USD", currencyDivisor: 1000 })).toBe(1500);
  });

  it("clamps into the offer's cost bounds", () => {
    const cost = { currency: "USD", currencyDivisor: 100, min: 12, max: 6000 };
    expect(costMinorUnits(50_000, cost)).toBe(12); // below min
    expect(costMinorUnits(99_000_000, cost)).toBe(6000); // above max
  });
});

describe("actualCostMicro", () => {
  it("adds the fee to the base cost for margin reconciliation", () => {
    expect(ZenditSupplier.actualCostMicro({ transactionId: "t", status: "DONE", cost: 290, costFee: 10, costCurrency: "USD", costCurrencyDivisor: 100 }))
      .toBe(3_000_000);
  });

  it("returns undefined when the charge is not in USD", () => {
    expect(ZenditSupplier.actualCostMicro({ transactionId: "t", status: "DONE", cost: 290, costCurrency: "EUR", costCurrencyDivisor: 100 }))
      .toBeUndefined();
  });
});

// Zendit confirmed on 2026-09-01 that cost.fixed is not inclusive of cost.fee. The answer is the expensive direction — reading `fixed` alone
// under-states what we are charged by the fee ON EVERY ORDER, so each one would sell
// for less than cost plus margin. The existing suite passed either way, because every
// offer sampled reported fee 0; this pins it.
describe("an offer's cost is inclusive of its fee", () => {
  const sup = (offer: Record<string, unknown>) => {
    const s = new ZenditSupplier("k", "https://z.test");
    globalThis.fetch = (async () => new Response(JSON.stringify({ list: [offer] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    return s;
  };

  it("adds fee to a FIXED offer's cost", async () => {
    const [o] = await sup({
      offerId: "F1", type: "topup", country: "NG", brand: "MTN", brandName: "MTN", priceType: "FIXED",
      cost: { currency: "USD", currencyDivisor: 100, fixed: 500, fee: 25 },
      send: { currency: "NGN", currencyDivisor: 100, fixed: 100000 },
    }).listOffers({ type: "topup", country: "NG" });
    // $5.00 + $0.25 fee = $5.25, not $5.00.
    expect(o.costMicro).toBe(5_250_000);
  });

  it("adds it to BOTH ends of a range — each end is a possible transaction", async () => {
    const [o] = await sup({
      offerId: "R1", type: "topup", country: "NG", brand: "MTN", brandName: "MTN", priceType: "RANGE",
      cost: { currency: "USD", currencyDivisor: 100, min: 100, max: 2000, fee: 25 },
      send: { currency: "NGN", currencyDivisor: 100, min: 20000, max: 400000 },
    }).listOffers({ type: "topup", country: "NG" });
    expect(o.costMinMicro).toBe(1_250_000); // $1.00 + $0.25
    expect(o.costMaxMicro).toBe(20_250_000); // $20.00 + $0.25
  });

  it("is unchanged when there is no fee, which is every offer sampled so far", async () => {
    const [o] = await sup({
      offerId: "F0", type: "topup", country: "NG", brand: "MTN", brandName: "MTN", priceType: "FIXED",
      cost: { currency: "USD", currencyDivisor: 100, fixed: 500, fee: 0 },
      send: { currency: "NGN", currencyDivisor: 100, fixed: 100000 },
    }).listOffers({ type: "topup", country: "NG" });
    expect(o.costMicro).toBe(5_000_000);
  });
});
