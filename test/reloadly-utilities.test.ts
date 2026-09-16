// Reloadly Utilities (bill pay). Field names are not guessed: they were read off the
// live production API on 2026-08-31 with read-only calls and deliberately incomplete
// writes, so this file pins what was actually observed. `fetch` is stubbed throughout.
//
// The request shape in particular is not an assumption. POST /pay was walked field by
// field with bodies that could never complete a payment:
//   {}                                  → MISSING_REQUIRED_BILLER_ID
//   {billerId}                          → MISSING_REQUIRED_SUBSCRIBER_ACCOUNT_NUMBER
//   {billerId, subscriberAccountNumber} → INVALID_AMOUNT
// Three fields, and not one of them is identity — which is the whole reason this
// product is buildable where Zendit's bill pay is not.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReloadlyUtilitiesSupplier, ACCOUNT_FIELD } from "../src/suppliers/reloadly-utilities.js";
import { SupplierError } from "../src/suppliers/types.js";

const HOST = "https://utilities.reloadly.com";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
function stub(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    if (url.startsWith("https://auth.reloadly.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    const key = Object.keys(routes).filter((k) => url.startsWith(`${HOST}${k}`)).sort((a, b) => b.length - a.length)[0];
    const r = key ? routes[key] : undefined;
    if (!r) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}
const sup = () => new ReloadlyUtilitiesSupplier("id", "secret", false);
afterEach(() => vi.unstubAllGlobals());

/** A verbatim biller from the live GET /billers response. */
const EKO_PREPAID = {
  id: 3, name: "Eko Electricity Prepaid", countryCode: "NG", countryName: "Nigeria",
  type: "ELECTRICITY_BILL_PAYMENT", serviceType: "PREPAID",
  localAmountSupported: true, localTransactionCurrencyCode: "NGN",
  minLocalTransactionAmount: 1000.0, maxLocalTransactionAmount: 300000.0,
  localTransactionFee: 0.0, localDiscountPercentage: 0.0, localTransactionFeePercentage: 0.0,
  internationalAmountSupported: true, internationalTransactionCurrencyCode: "USD",
  minInternationalTransactionAmount: 0.654, maxInternationalTransactionAmount: 196.33,
  internationalTransactionFee: 0.0, internationalTransactionFeePercentage: 0.0,
  internationalDiscountPercentage: 0.0, requiresInvoice: false,
  fx: { rate: 1528.0, currencyCode: "USD" }, denominationType: "RANGE",
  localFixedAmounts: null, internationalFixedAmounts: null,
};
const page = (content: unknown[]) => ({ content, last: true });

describe("offers", () => {
  it("maps a live NG prepaid electricity biller, pricing in USD", async () => {
    stub({ "/billers": { json: page([EKO_PREPAID]) } });
    const [o] = await sup().listOffers({ type: "bill", country: "NG" });
    expect(o).toMatchObject({
      id: "rlu-3", type: "bill", country: "NG", brand: "3", brandName: "Eko Electricity Prepaid",
      priceType: "range", sendCurrency: "NGN", sendMin: 1000, sendMax: 300000,
      requiredFields: [ACCOUNT_FIELD],
    });
    // $0.654 – $196.33, the ticket range that makes this worth building at all.
    expect(o.costMinMicro).toBe(654_000);
    expect(o.costMaxMicro).toBe(196_330_000);
    // fx.rate is NGN per USD, so cost per NGN is 1/1528 — rounded UP, in our favour.
    expect(o.costPerSendUnitMicro).toBe(Math.ceil(1_000_000 / 1528));
  });

  it("does not advertise a biller it cannot price in USD", async () => {
    // We always instruct with useLocalAmount:false. Listing a biller we would then be
    // refused on means failing AFTER the payer has settled — better unlisted.
    stub({ "/billers": { json: page([
      { ...EKO_PREPAID, id: 90, internationalAmountSupported: false },
      { ...EKO_PREPAID, id: 91, internationalTransactionCurrencyCode: "GBP" },
      { ...EKO_PREPAID, id: 92, internationalTransactionFee: 0.5 },
      { ...EKO_PREPAID, id: 93, internationalTransactionFeePercentage: 1.5 },
    ]) } });
    expect(await sup().listOffers({ type: "bill", country: "NG" })).toEqual([]);
  });

  it("serves getOffer from the biller list, since there is no GET /billers/{id}", async () => {
    // That endpoint 404s on the live API — confirmed 2026-08-31.
    const calls = stub({ "/billers": { json: page([EKO_PREPAID]) } });
    expect((await sup().getOffer("bill", "rlu-3"))?.brandName).toBe("Eko Electricity Prepaid");
    expect(await sup().getOffer("bill", "rlu-999")).toBeNull();
    expect(calls.every((c) => !/\/billers\/\d/.test(c.url))).toBe(true);
  });

  it("ignores product types that are not bills", async () => {
    stub({ "/billers": { json: page([EKO_PREPAID]) } });
    expect(await sup().listOffers({ type: "topup", country: "NG" })).toEqual([]);
    expect(await sup().getOffer("topup", "rlu-3")).toBeNull();
  });
});

describe("purchase", () => {
  it("sends exactly the three fields the API requires, plus our order id", async () => {
    const calls = stub({
      "/billers": { json: page([EKO_PREPAID]) },
      "/pay": { json: { id: 55, referenceId: "ord_1", status: "SUCCESSFUL", token: "1234-5678-9012-3456", amount: 10 } },
    });
    const r = await sup().purchase({
      orderId: "ord_1", type: "bill", offerId: "rlu-3",
      recipient: { fields: { [ACCOUNT_FIELD]: "45700123456" } }, costMicro: 10_000_000,
    });
    const pay = calls.find((c) => c.method === "POST" && c.url.includes("/pay"))!;
    expect(pay.body).toEqual({
      billerId: 3, subscriberAccountNumber: "45700123456", amount: 10, useLocalAmount: false, referenceId: "ord_1",
    });
    expect(pay.headers.Accept).toBe("application/com.reloadly.utilities-v1+json");
    // For PREPAID electricity the token IS the deliverable, like a PIN voucher.
    expect(r).toMatchObject({ supplierTxId: "55", status: "delivered" });
    expect(r.confirmation?.token).toBe("1234-5678-9012-3456");
  });

  it("refuses before any money moves when the account number is missing", async () => {
    stub({ "/billers": { json: page([EKO_PREPAID]) } });
    await expect(sup().purchase({ orderId: "o", type: "bill", offerId: "rlu-3", recipient: {}, costMicro: 1 }))
      .rejects.toThrow(/account_number/);
  });

  it("recovers a rejected duplicate instead of refunding a bill that was paid", async () => {
    // Whether referenceId is enforced unique is UNVERIFIED, so the adapter assumes the
    // worst: a retry may be rejected while the first attempt already paid.
    let payCalls = 0;
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      if (url.startsWith("https://auth.reloadly.com")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      if (url.includes("/pay")) { payCalls++; return new Response(JSON.stringify({ errorCode: "DUPLICATE_REFERENCE_ID", message: "duplicate" }), { status: 400 }); }
      if (url.includes("/transactions?referenceId=")) return new Response(JSON.stringify(page([{ id: 77, referenceId: "ord_dup", status: "SUCCESSFUL", token: "TKN" }])), { status: 200 });
      return new Response(JSON.stringify({ message: "nope" }), { status: 404 });
    });
    const r = await sup().purchase({
      orderId: "ord_dup", type: "bill", offerId: "rlu-3",
      recipient: { fields: { [ACCOUNT_FIELD]: "1" } }, costMicro: 1_000_000,
    });
    expect(payCalls).toBe(1);
    expect(r).toMatchObject({ supplierTxId: "77", status: "delivered" });
    expect(r.confirmation?.token).toBe("TKN");
  });

  it("keeps the order open when a rejected duplicate cannot be found either", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://auth.reloadly.com")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      if (url.includes("/pay")) return new Response(JSON.stringify({ errorCode: "BAD", message: "bad" }), { status: 400 });
      return new Response(JSON.stringify(page([])), { status: 200 });
    });
    await expect(sup().purchase({ orderId: "o2", type: "bill", offerId: "rlu-3", recipient: { fields: { [ACCOUNT_FIELD]: "1" } }, costMicro: 1 }))
      .rejects.toThrow(SupplierError);
  });
});

describe("status", () => {
  it("polls by Reloadly's numeric id and by our own referenceId", async () => {
    const calls = stub({
      "/transactions/55": { json: { id: 55, referenceId: "ord_1", status: "SUCCESSFUL" } },
      "/transactions": { json: page([{ id: 56, referenceId: "ord_2", status: "SUCCESSFUL" }]) },
    });
    expect(await sup().getPurchase("bill", "55")).toMatchObject({ supplierTxId: "55", status: "delivered" });
    expect(await sup().getPurchase("bill", "ord_2")).toMatchObject({ supplierTxId: "56", status: "delivered" });
    expect(calls.some((c) => c.url.includes("referenceId=ord_2"))).toBe(true);
  });

  it("treats an unrecognised status as pending, never as failed", async () => {
    // The asymmetry is deliberate. A wrong "failed" refunds a payer whose electricity
    // was bought — we lose the money and they keep the token. A wrong "pending" costs
    // one more poll, and the order layer times out into a refund on its own.
    stub({ "/transactions/1": { json: { id: 1, status: "SOMETHING_NEW" } } });
    expect(await sup().getPurchase("bill", "1")).toMatchObject({ status: "pending" });
  });

  it("maps the failure statuses it does recognise", async () => {
    for (const status of ["FAILED", "REFUNDED", "REVERSED"]) {
      stub({ "/transactions/2": { json: { id: 2, status, message: "biller declined" } } });
      expect(await sup().getPurchase("bill", "2")).toMatchObject({ status: "failed", error: "biller declined" });
    }
  });

  it("stays retryable when a response carries no transaction id", async () => {
    // Without an id we cannot poll. Failing hard here would refund against a payment
    // that may well exist, so the order stays open and is recovered by referenceId.
    stub({ "/transactions/3": { json: { status: "PROCESSING" } } });
    await expect(sup().getPurchase("bill", "3")).rejects.toMatchObject({ retryable: true });
  });

  it("is retryable when a referenceId is not found yet", async () => {
    stub({ "/transactions": { json: page([]) } });
    await expect(sup().getPurchase("bill", "ord_missing")).rejects.toMatchObject({ retryable: true });
  });
});

describe("balance", () => {
  it("reads the shared account balance and refuses a non-USD wallet", async () => {
    stub({ "/accounts/balance": { json: { balance: 33.37025, currencyCode: "USD" } } });
    expect(await sup().balanceMicro()).toBe(33_370_250);
    stub({ "/accounts/balance": { json: { balance: 100, currencyCode: "GBP" } } });
    await expect(sup().balanceMicro()).rejects.toThrow(/GBP/);
  });
});
