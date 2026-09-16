// Reloadly adapter, checked against Reloadly's own Java SDK models
// (github.com/Reloadly/reloadly-sdk-java, java-sdk-airtime) — docs.reloadly.com serves
// no machine-readable spec, but the SDK DTOs carry the Jackson annotations that name
// the wire fields exactly. `fetch` is stubbed throughout.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReloadlySupplier, pinConfirmation } from "../src/suppliers/reloadly.js";
import { SupplierError } from "../src/suppliers/types.js";

const SANDBOX = "https://topups-sandbox.reloadly.com";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

function stub(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    if (url.startsWith("https://auth.reloadly.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    // Longest match wins, so "/topups/reports/transactions" beats "/topups".
    const key = Object.keys(routes)
      .filter((k) => url.startsWith(`${SANDBOX}${k}`))
      .sort((a, b) => b.length - a.length)[0];
    const r = key ? routes[key] : undefined;
    if (!r) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const sup = () => new ReloadlySupplier("id", "secret", true);

/** dto/response/Operator.java — the operator's key is `id`; `fx` is @JsonProperty("fx"). */
const rangeOp = {
  id: 341, name: "Airtel India", country: { isoName: "IN", name: "India" }, denominationType: "RANGE",
  senderCurrencyCode: "USD", destinationCurrencyCode: "INR", fx: { rate: 83.5, currencyCode: "INR" },
  minAmount: 1, maxAmount: 60, localMinAmount: 83.5, localMaxAmount: 5010, data: false, bundle: false,
};
const fixedOp = {
  id: 500, name: "Jio", country: { isoName: "IN", name: "India" }, denominationType: "FIXED",
  senderCurrencyCode: "USD", destinationCurrencyCode: "INR",
  fixedAmounts: [1.2, 3.5], localFixedAmounts: [100, 299], data: true, bundle: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("auth and headers", () => {
  it("fetches a client-credentials token for the sandbox audience and reuses it", async () => {
    const calls = stub({ "/accounts/balance": { json: { balance: 25.5, currencyCode: "USD" } } });
    const s = sup();
    await s.balanceMicro();
    await s.balanceMicro();
    const auths = calls.filter((c) => c.url.startsWith("https://auth.reloadly.com"));
    expect(auths).toHaveLength(1); // cached, not re-fetched
    expect(auths[0].body.audience).toBe(SANDBOX);
    expect(auths[0].body.grant_type).toBe("client_credentials");
    const api = calls.find((c) => c.url.includes("/accounts/balance"))!;
    expect(api.headers.Accept).toBe("application/com.reloadly.topups-v1+json");
    expect(api.headers.Authorization).toBe("Bearer tok");
  });

  it("converts the account balance to micro-USD", async () => {
    stub({ "/accounts/balance": { json: { balance: 25.5, currencyCode: "USD" } } });
    expect(await sup().balanceMicro()).toBe(25_500_000);
  });

  it("refuses a non-USD account", async () => {
    stub({ "/accounts/balance": { json: { balance: 25.5, currencyCode: "EUR" } } });
    await expect(sup().balanceMicro()).rejects.toThrow(/EUR/);
  });
});

describe("operator mapping", () => {
  // The operator key is `id`. Reading `operatorId` (a field of a *transaction*) yields
  // undefined, which silently produced offer ids of "rl-undefined".
  it("keys offers off the operator's `id`", async () => {
    stub({ "/operators/countries/IN": { json: [rangeOp] } });
    const [o] = await sup().listOffers({ type: "topup", country: "IN" });
    expect(o.id).toBe("rl-341");
    expect(o.brand).toBe("341");
    expect(o.id).not.toContain("undefined");
  });

  it("maps a RANGE operator using fx.rate for the per-send-unit cost", async () => {
    stub({ "/operators/countries/IN": { json: [rangeOp] } });
    const [o] = await sup().listOffers({ type: "topup", country: "IN" });
    expect(o.priceType).toBe("range");
    expect(o.costMinMicro).toBe(1_000_000);
    expect(o.costMaxMicro).toBe(60_000_000);
    expect(o.sendMin).toBe(83.5);
    expect(o.costPerSendUnitMicro).toBe(Math.ceil(1_000_000 / 83.5)); // 11_977 µUSD per INR
  });

  it("falls back to the bounds when fx is absent", async () => {
    stub({ "/operators/countries/IN": { json: [{ ...rangeOp, fx: undefined }] } });
    const [o] = await sup().listOffers({ type: "topup", country: "IN" });
    expect(o.costPerSendUnitMicro).toBe(Math.ceil(1_000_000 / 83.5));
  });

  it("pairs fixedAmounts (USD) with localFixedAmounts (destination) by position", async () => {
    stub({ "/operators/countries/IN": { json: [fixedOp] } });
    const offers = await sup().listOffers({ type: "topup", country: "IN" });
    expect(offers.map((o) => o.id)).toEqual(["rl-500-1.2", "rl-500-3.5"]);
    expect(offers[0].costMicro).toBe(1_200_000);
    expect(offers[0].sendFixed).toBe(100);
    expect(offers[1].name).toBe("Jio 299 INR");
  });

  it("omits the local amount when the two amount lists disagree in length", async () => {
    stub({ "/operators/countries/IN": { json: [{ ...fixedOp, localFixedAmounts: [100] }] } });
    const offers = await sup().listOffers({ type: "topup", country: "IN" });
    expect(offers[0].sendFixed).toBeUndefined();
    expect(offers[0].name).toBe("Jio $1.2");
  });

  it("filters by brand and refuses a non-USD sender currency", async () => {
    stub({ "/operators/countries/IN": { json: [rangeOp, fixedOp] } });
    expect(await sup().listOffers({ type: "topup", country: "IN", brand: "500" })).toHaveLength(2);

    vi.unstubAllGlobals();
    stub({ "/operators/countries/IN": { json: [{ ...rangeOp, senderCurrencyCode: "GBP" }] } });
    await expect(sup().listOffers({ type: "topup", country: "IN" })).rejects.toThrow(/GBP/);
  });

  it("resolves a single offer by id", async () => {
    stub({ "/operators/500": { json: fixedOp } });
    const o = await sup().getOffer("topup", "rl-500-3.5");
    expect(o?.costMicro).toBe(3_500_000);
    expect(await sup().getOffer("topup", "not-a-reloadly-id")).toBeNull();
  });

  it("auto-detects the operator for a phone number", async () => {
    stub({ "/operators/auto-detect/phone": { json: rangeOp } });
    expect(await sup().lookupPhone("919876543210")).toEqual({ msisdn: "919876543210", country: "IN", brand: "341", brandName: "Airtel India" });
  });
});

describe("purchase", () => {
  it("posts the SDK's topup body and returns Reloadly's numeric transaction id", async () => {
    const calls = stub({ "/topups": { json: { transactionId: 998877, status: "SUCCESSFUL", operatorTransactionId: "OP-1" } } });
    const r = await sup().purchase({
      orderId: "ord_abc", type: "topup", offerId: "rl-341", recipient: { phone: "919876543210" }, costMicro: 3_000_000,
    });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/topups"))!;
    expect(post.body).toEqual({
      operatorId: 341, amount: 3, useLocalAmount: false, customIdentifier: "ord_abc",
      recipientPhone: { countryCode: "IN", number: "919876543210" },
    });
    // Our order id is the customIdentifier — the supplier's id is its own number.
    expect(r.supplierTxId).toBe("998877");
    expect(r.status).toBe("delivered");
    expect(r.confirmation).toEqual({ operatorReference: "OP-1" });
  });

  // customIdentifier is a uniqueness constraint, not an idempotency key: a replay is
  // rejected. Failing here would refund a payer whose airtime already delivered.
  it("resolves the existing transaction when a replay is rejected as a duplicate", async () => {
    stub({
      "/topups/reports/transactions": { json: { content: [{ transactionId: 4242, status: "SUCCESSFUL", customIdentifier: "ord_dup" }] } },
      "/topups": { status: 400, json: { message: "Custom identifier already used" } },
    });
    const r = await sup().purchase({
      orderId: "ord_dup", type: "topup", offerId: "rl-341", recipient: { phone: "919876543210" }, costMicro: 1_000_000,
    });
    expect(r.supplierTxId).toBe("4242");
    expect(r.status).toBe("delivered");
  });

  it("rethrows when the duplicate lookup finds nothing", async () => {
    stub({
      "/topups/reports/transactions": { json: { content: [] } },
      "/topups": { status: 400, json: { message: "Invalid operator" } },
    });
    await expect(sup().purchase({ orderId: "ord_x", type: "topup", offerId: "rl-341", recipient: { phone: "919876543210" }, costMicro: 1_000_000 }))
      .rejects.toThrow(/Invalid operator/);
  });

  it("rejects a malformed offer id or a missing phone before calling out", async () => {
    const calls = stub({});
    await expect(sup().purchase({ orderId: "o", type: "topup", offerId: "nope", recipient: { phone: "1" }, costMicro: 1 })).rejects.toThrow();
    await expect(sup().purchase({ orderId: "o", type: "topup", offerId: "rl-341", recipient: {}, costMicro: 1 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("polling", () => {
  // The status endpoint wraps the transaction; the history endpoint is for settled
  // records and can omit an in-flight topup, which would read as a failure and refund.
  it("uses GET /topups/{id}/status for a numeric id and unwraps the transaction", async () => {
    const calls = stub({ "/topups/998877/status": { json: { status: "PROCESSING", transaction: { transactionId: 998877, status: "PROCESSING" } } } });
    const r = await sup().getPurchase("topup", "998877");
    expect(calls.some((c) => c.url.includes("/topups/998877/status"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/reports/transactions"))).toBe(false);
    expect(r.status).toBe("pending");
    expect(r.supplierTxId).toBe("998877");
  });

  it.each([["SUCCESSFUL", "delivered"], ["PROCESSING", "pending"], ["FAILED", "failed"], ["REFUNDED", "failed"]] as const)(
    "maps %s to %s",
    async (status, expected) => {
      stub({ "/topups/1/status": { json: { status, transaction: { transactionId: 1, status } } } });
      expect((await sup().getPurchase("topup", "1")).status).toBe(expected);
    },
  );

  // The order layer recovers an unknown purchase outcome by polling with OUR order id.
  it("looks a non-numeric id up as a customIdentifier", async () => {
    const calls = stub({ "/topups/reports/transactions": { json: { content: [{ transactionId: 777, status: "SUCCESSFUL", customIdentifier: "ord_abc" }] } } });
    const r = await sup().getPurchase("topup", "ord_abc");
    const q = new URL(calls.find((c) => c.url.includes("/reports/transactions"))!.url);
    expect(q.searchParams.get("customIdentifier")).toBe("ord_abc");
    expect(r.supplierTxId).toBe("777");
    expect(r.status).toBe("delivered");
  });

  it("accepts a bare array as well as a page envelope", async () => {
    stub({ "/topups/reports/transactions": { json: [{ transactionId: 778, status: "SUCCESSFUL", customIdentifier: "ord_z" }] } });
    expect((await sup().getPurchase("topup", "ord_z")).supplierTxId).toBe("778");
  });

  // Retryable, so the order layer keeps polling instead of refunding a live topup.
  it("raises a retryable error when the customIdentifier is not found yet", async () => {
    stub({ "/topups/reports/transactions": { json: { content: [] } } });
    const e = await sup().getPurchase("topup", "ord_missing").catch((x) => x);
    expect(e).toBeInstanceOf(SupplierError);
    expect(e.retryable).toBe(true);
  });
});

// PIN products deliver a voucher code, not credit on the handset. Every one of the 16
// GB operators is a fixed £5 PIN voucher (measured against production 2026-08-29), so
// this is not an edge case — it is the entire UK market, and the first real order was
// about to be one. Reporting "delivered" and signing a receipt for it while dropping
// the code delivers nothing at all.
describe("PIN vouchers", () => {
  it("surfaces the code operators put in `code`", () => {
    expect(pinConfirmation({ code: "1234-5678", serial: "SN1" })).toMatchObject({ voucher_pin: "1234-5678", voucher_serial: "SN1" });
  });

  it("falls back to info1, where many UK vouchers actually carry it", () => {
    expect(pinConfirmation({ info1: "9999-0000" })).toMatchObject({ voucher_pin: "9999-0000" });
  });

  it("keeps the untouched detail, because redemption instructions live in the other fields", () => {
    const pin = { info1: "A", info2: "dial *123#", validity: "90 days" };
    expect(pinConfirmation(pin).voucher_detail).toEqual(pin);
  });

  it("carries redemption route and expiry when the operator states them", () => {
    expect(pinConfirmation({ code: "A", ivr: "150", expiryDate: "2027-01-01" }))
      .toMatchObject({ voucher_redeem_via: "150", voucher_valid_until: "2027-01-01" });
  });

  it("returns nothing for a direct top-up, leaving that confirmation shape unchanged", () => {
    expect(pinConfirmation(undefined)).toEqual({});
    expect(pinConfirmation({})).toEqual({});
  });

  it("treats a blank code as no code rather than delivering an empty string", () => {
    expect(pinConfirmation({ code: "   ", info1: "REAL" })).toMatchObject({ voucher_pin: "REAL" });
  });
});

describe("countries", () => {
  it("lists every destination from GET /countries, named and with its currency, and caches it", async () => {
    // dto/response/Country.java — the "150+ countries" claim on the front page rests on
    // this list; before it existed the console carried five typed by hand.
    const calls = stub({
      "/countries": { json: [
        { isoName: "NG", name: "Nigeria", currencyCode: "NGN", callingCodes: ["+234"] },
        { isoName: "BR", name: "Brazil", currencyCode: "BRL" },
        { isoName: "XX1", name: "not a country" },
      ] },
    });
    const s = sup();
    const list = await s.listCountries("topup");
    expect(list).toEqual([
      { code: "BR", name: "Brazil", currency: "BRL" },
      { code: "NG", name: "Nigeria", currency: "NGN" },
    ]);
    await s.listCountries("topup");
    expect(calls.filter((c) => c.url.includes("/countries"))).toHaveLength(1);
    // Other products are not Reloadly's to answer for.
    expect(await s.listCountries("esim")).toEqual([]);
  });

  it("does not cache an empty answer as the truth", async () => {
    const calls = stub({ "/countries": { json: [] } });
    const s = sup();
    expect(await s.listCountries("topup")).toEqual([]);
    await s.listCountries("topup");
    expect(calls.filter((c) => c.url.includes("/countries"))).toHaveLength(2);
  });
});
