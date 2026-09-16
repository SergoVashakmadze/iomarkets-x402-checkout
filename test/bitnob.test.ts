// Bitnob payout adapter, checked against the published OpenAPI 3.0.3 spec
// ("Bitnob API v2" 2.0.0, bitnob.dev/api-collections/swagger/bitnob-api-v2.openapi.json).
// `fetch` is stubbed: these assert the exact request shapes and the HMAC the spec
// requires, so a live sandbox run only has to confirm semantics (fees, spread,
// mobile-money field names) rather than field names.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitnobPayoutSupplier, balanceMicroOf } from "../src/suppliers/bitnob.js";
import { SupplierError } from "../src/suppliers/types.js";

const BASE = "https://api.bitnob.com";
const CLIENT = "cid_test";
const SECRET = "csecret_test";

type Call = { url: string; path: string; method: string; rawBody?: string; body: any; headers: Record<string, string> };

/** Stub fetch with a canned reply per "METHOD /path" prefix; records every call. */
function stub(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    calls.push({ url, path, method, rawBody: init.body, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && path.startsWith(p);
    });
    const r = key ? routes[key] : undefined;
    if (!r) return new Response(JSON.stringify({ title: "Not Found", detail: `no stub for ${method} ${path}`, code: "NOT_FOUND", status: 404 }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const envelope = (data: unknown) => ({ success: true, message: "ok", data, timestamp: "2026-08-28T00:00:00Z" });

const COUNTRIES = envelope({
  countries: [
    { code: "NG", name: "Nigeria", corridors: [{ currency: "NGN", destination_types: ["bank"] }, { currency: "USD", destination_types: ["swift"] }] },
    { code: "KE", name: "Kenya", corridors: [{ currency: "KES", destination_types: ["bank", "mobile_money"] }] },
    // No published rate for XOF below, so this corridor must not be advertised.
    { code: "CI", name: "Ivory Coast", corridors: [{ currency: "XOF", destination_types: ["mobile_money"] }] },
  ],
});
const LIMITS = envelope({
  limits: [
    { country: "NG", currency: "NGN", min_amount: "1000", max_amount: "5000000" },
    { country: "KE", currency: "KES", min_amount: "100", max_amount: "150000" },
    { country: "CI", currency: "XOF", min_amount: "100", max_amount: "2000000" },
  ],
});
const RATES = envelope({
  base_currency: "USDC",
  rates: [
    { target_currency: "NGN", buy_rate: "1389.41998218", sell_rate: "1375.59771120" },
    { target_currency: "KES", buy_rate: "129.51548194", sell_rate: "128.22703200" },
  ],
});
const NG_DETAIL = envelope({
  code: "NG", name: "Nigeria",
  destination_types: {
    bank: { key: "bank", fields: [{ key: "bank_code", required: true }, { key: "account_number", required: true }] },
  },
});

/** The offer catalogue routes, which every catalogue-facing test needs. */
const CATALOGUE = {
  "GET /api/payouts/supported-countries/NG": { json: NG_DETAIL },
  "GET /api/payouts/supported-countries": { json: COUNTRIES },
  "GET /api/payouts/limits": { json: LIMITS },
  "GET /api/exchange-rates": { json: RATES },
};

const payout = (o: Record<string, unknown> = {}) => ({
  id: "019f2f22-2dad-792b-900d-ccc1c3731874", quote_id: "QT2_21015643", status: "QUOTE", from_asset: "USDC",
  to_currency: "NGN", amount: "10.000000", settlement_amount: "13755", fees: "0",
  exchange_rate: { rate: "1382.5294", effective_rate: "1379.7651915597003702" },
  beneficiary: { destination_type: "bank", country: "NG", account_name: "OKEY JOY CHIDIMMA", account_number: "0123456789", bank_code: "058" },
  reference: "ord_abc", country: "NG", expires_at: "2099-01-01T00:00:00Z", ...o,
});

const sup = (opts: Record<string, unknown> = {}) => new BitnobPayoutSupplier(CLIENT, SECRET, { baseUrl: BASE, log: () => {}, ...opts });

const buyReq = (o: Record<string, unknown> = {}) => ({
  orderId: "ord_abc", type: "payout" as const, offerId: "bn-NG-NGN-bank", costMicro: 10_000_000,
  sender: { name: "Sergo V", country: "GE" },
  recipient: { fields: { account_name: "OKEY JOY CHIDIMMA", account_number: "0123456789", bank_code: "058", payment_reason: "family_support" } },
  ...o,
});

afterEach(() => vi.unstubAllGlobals());

describe("authentication", () => {
  it("signs <client>:<timestamp>:<nonce>:<body> with the client secret, hex, over the exact bytes sent", async () => {
    const calls = stub(CATALOGUE);
    await sup().listOffers({ type: "payout" });
    const c = calls[0];
    expect(c.headers["X-Auth-Client"]).toBe(CLIENT);
    expect(c.headers["X-Auth-Nonce"]).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes, hex
    expect(Number(c.headers["X-Auth-Timestamp"])).toBeCloseTo(Math.floor(Date.now() / 1000), -1); // seconds, not ms
    const expected = createHmac("sha256", SECRET)
      .update(`${CLIENT}:${c.headers["X-Auth-Timestamp"]}:${c.headers["X-Auth-Nonce"]}:`) // GET signs an empty payload
      .digest("hex");
    expect(c.headers["X-Auth-Signature"]).toBe(expected);
  });

  it("signs the identical string it sends as the body — not a re-serialisation of it", async () => {
    const calls = stub({ ...CATALOGUE, "POST /api/payouts/quotes": { json: envelope({ payout: payout() }) }, "POST /api/payouts/QT2_21015643/initialize": { json: envelope({ payout: payout({ status: "INITIATED" }) }) }, "POST /api/payouts/QT2_21015643/finalize": { json: envelope({ payout: payout({ status: "COMPLETED" }) }) } });
    await sup().purchase(buyReq());
    for (const c of calls.filter((x) => x.method === "POST")) {
      const expected = createHmac("sha256", SECRET)
        .update(`${CLIENT}:${c.headers["X-Auth-Timestamp"]}:${c.headers["X-Auth-Nonce"]}:${c.rawBody}`)
        .digest("hex");
      expect(c.headers["X-Auth-Signature"]).toBe(expected);
      expect(c.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("surfaces the partner's error code and correlation id, and marks 5xx/429 retryable", async () => {
    stub({ "GET /api/balances": { status: 401, json: { title: "Unauthorized", detail: "Invalid HMAC signature", code: "UNAUTHORIZED", correlation_id: "req_019d" } } });
    await expect(sup().balanceMicro()).rejects.toThrow(/401 \[UNAUTHORIZED\].*Invalid HMAC signature.*req_019d/);
    vi.unstubAllGlobals();
    stub({ "GET /api/balances": { status: 503, json: { detail: "upstream down" } } });
    await expect(sup().balanceMicro()).rejects.toMatchObject({ retryable: true });
  });
});

describe("catalogue", () => {
  it("joins countries + limits + rates into corridors, priced from the WORSE side of the rate", async () => {
    stub(CATALOGUE);
    const offers = await sup().listOffers({ type: "payout" });
    const ng = offers.find((o) => o.id === "bn-NG-NGN-bank")!;
    expect(ng).toMatchObject({ type: "payout", country: "NG", sendCurrency: "NGN", sendMin: 1000, sendMax: 5_000_000, payoutMethod: "bank", priceType: "range" });
    // sell 1375.59771120 < buy 1389.41998218, so the sell side prices the corridor.
    expect(ng.costPerSendUnitMicro).toBe(Math.ceil(1_000_000 / 1375.5977112));
    expect(ng.costMinMicro).toBe(Math.ceil(1000 * ng.costPerSendUnitMicro!));
  });

  it("drops swift corridors and corridors with no published rate", async () => {
    stub(CATALOGUE);
    const ids = (await sup().listOffers({ type: "payout" })).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["bn-NG-NGN-bank", "bn-KE-KES-bank", "bn-KE-KES-mobile_money"]));
    expect(ids).not.toContain("bn-NG-USD-swift"); // SWIFT is deliberately unlisted
    expect(ids.some((i) => i.startsWith("bn-CI-"))).toBe(false); // no XOF rate ⇒ unpriceable
  });

  it("resolves beneficiary requirements per country, and only when a country is asked for", async () => {
    const calls = stub(CATALOGUE);
    const all = await sup().listOffers({ type: "payout" });
    expect(all.every((o) => o.requiredFields === undefined)).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/api/payouts/supported-countries/"))).toBe(false);

    const ng = await sup().listOffers({ type: "payout", country: "NG" });
    // account_name is required by the initialize body but is not in the country's field
    // list; payment_reason is required on the quote. Both must come from the human.
    expect(ng[0].requiredFields).toEqual(["account_name", "bank_code", "account_number", "payment_reason"]);
  });

  it("getOffer parses the offer id and always carries the required fields", async () => {
    stub(CATALOGUE);
    const s = sup();
    expect(await s.getOffer("payout", "bn-NG-NGN-bank")).toMatchObject({ id: "bn-NG-NGN-bank", requiredFields: ["account_name", "bank_code", "account_number", "payment_reason"] });
    expect(await s.getOffer("payout", "bn-XX-XXX-bank")).toBeNull();
    expect(await s.getOffer("payout", "rl-123")).toBeNull();
    expect(await s.getOffer("topup", "bn-NG-NGN-bank")).toBeNull();
  });

  it("caches the catalogue endpoints rather than re-fetching per listing", async () => {
    const calls = stub(CATALOGUE);
    const s = sup();
    await s.listOffers({ type: "payout", country: "NG" });
    await s.listOffers({ type: "payout", country: "NG" });
    expect(calls.filter((c) => c.path === "/api/payouts/limits")).toHaveLength(1);
  });
});

describe("purchase", () => {
  const happy = {
    ...CATALOGUE,
    "POST /api/payouts/quotes": { json: envelope({ payout: payout() }) },
    "POST /api/payouts/QT2_21015643/initialize": { json: envelope({ payout: payout({ status: "INITIATED" }) }) },
    "POST /api/payouts/QT2_21015643/finalize": { json: envelope({ payout: payout({ status: "COMPLETED", provider_settlement_id: "sandbox_txn_40ac" }) }) },
  };

  it("quotes in the asset we spend, then initializes and finalizes that quote", async () => {
    const calls = stub(happy);
    const r = await sup().purchase(buyReq());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([
      "/api/payouts/quotes",
      "/api/payouts/QT2_21015643/initialize",
      "/api/payouts/QT2_21015643/finalize",
    ]);
    expect(posts[0].body).toEqual({
      from_asset: "USDC", to_currency: "NGN", source: "offchain", country: "NG",
      amount: "10.000000", payment_reason: "family_support", reference: "ord_abc",
    });
    expect(posts[1].body).toEqual({
      quote_id: "QT2_21015643", reference: "ord_abc", payment_reason: "family_support",
      beneficiary: { destination_type: "bank", country: "NG", account_name: "OKEY JOY CHIDIMMA", account_number: "0123456789", bank_code: "058" },
    });
    expect(posts[2].body).toEqual({});
    expect(r).toMatchObject({
      status: "delivered", supplierTxId: "019f2f22-2dad-792b-900d-ccc1c3731874",
      confirmation: { partnerReference: "sandbox_txn_40ac", delivered_amount: "13755", delivered_currency: "NGN", method: "bank" },
    });
  });

  it("passes the corridor's own fields through and adds the callback url when configured", async () => {
    const calls = stub(happy);
    await sup({ callbackUrl: "https://iomarkets.app/webhooks/bitnob" }).purchase(
      buyReq({ recipient: { fields: { account_name: "Jane Doe", account_number: "254712345678", network: "MPESA", payment_reason: "family_support" } }, offerId: "bn-KE-KES-mobile_money" }),
    );
    const init = calls.find((c) => c.path.endsWith("/initialize"))!;
    expect(init.body.beneficiary).toEqual({ destination_type: "mobile_money", country: "KE", account_name: "Jane Doe", account_number: "254712345678", network: "MPESA" });
    expect(init.body.callback_url).toBe("https://iomarkets.app/webhooks/bitnob");
  });

  it("refuses without a sender record, an account name or a payment reason", async () => {
    stub(happy);
    const s = sup();
    await expect(s.purchase(buyReq({ sender: undefined }))).rejects.toThrow(/sender record/);
    await expect(s.purchase(buyReq({ recipient: { fields: { account_number: "1", payment_reason: "x" } } }))).rejects.toThrow(/account_name/);
    await expect(s.purchase(buyReq({ recipient: { fields: { account_name: "A", account_number: "1" } } }))).rejects.toThrow(/payment_reason/);
    await expect(s.purchase(buyReq({ offerId: "rl-999" }))).rejects.toThrow(/not a bitnob payout offer/);
  });

  it("refuses a quote that delivers less than the offer priced, BEFORE initialising it", async () => {
    // 10 USDC at the published sell rate is ~13755 NGN; this quote is ~9% short.
    const calls = stub({ ...happy, "POST /api/payouts/quotes": { json: envelope({ payout: payout({ settlement_amount: "12500" }) }) } });
    await expect(sup().purchase(buyReq())).rejects.toThrow(/below the .* implied by the quoted rate/);
    expect(calls.some((c) => c.path.includes("/initialize"))).toBe(false);
  });

  it("accepts a quote inside the slippage tolerance", async () => {
    stub({ ...happy, "POST /api/payouts/quotes": { json: envelope({ payout: payout({ settlement_amount: "13700" }) }) } });
    await expect(sup().purchase(buyReq())).resolves.toMatchObject({ status: "delivered" });
  });

  it("recovers an already-created payout when a replayed reference is rejected", async () => {
    // `reference` is a deduplication key Bitnob enforces, so a retried create can 400.
    // The first attempt may already have sent the money: resolve it, never refund blind.
    const calls = stub({
      ...CATALOGUE,
      "POST /api/payouts/quotes": { status: 400, json: { detail: "reference already used", code: "DUPLICATE_REFERENCE" } },
      "GET /api/payouts": { json: envelope({ items: [payout({ status: "COMPLETED", provider_settlement_id: "sandbox_txn_40ac" })], has_more: false }) },
    });
    await expect(sup().purchase(buyReq())).resolves.toMatchObject({ status: "delivered", confirmation: { partnerReference: "sandbox_txn_40ac" } });
    expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/payouts?"))).toBe(true);
  });
});

describe("polling and recovery", () => {
  it("polls by the partner's payout id", async () => {
    const calls = stub({ "GET /api/payouts/019f2f22": { json: envelope({ payout: payout({ status: "PENDING" }) }) } });
    await expect(sup().getPurchase("payout", "019f2f22")).resolves.toMatchObject({ status: "pending" });
    expect(calls[0].path).toBe("/api/payouts/019f2f22");
  });

  it("polls by OUR order id — there is no reference filter, so it scans recent payouts", async () => {
    const calls = stub({ "GET /api/payouts": { json: envelope({ items: [payout({ reference: "ord_other" }), payout({ reference: "ord_abc", status: "COMPLETED" })], has_more: false }) } });
    await expect(sup().getPurchase("payout", "ord_abc")).resolves.toMatchObject({ status: "delivered" });
    // Never tries GET /api/payouts/ord_abc: our id is not the partner's id.
    expect(calls.every((c) => c.path.startsWith("/api/payouts?"))).toBe(true);
  });

  it("falls back to the reference scan when the partner 404s an id it should know", async () => {
    // Last chance before a wrong refund: if the id we recorded is not a payout the
    // partner knows, look for one carrying it as our reference before giving up.
    const calls = stub({ "GET /api/payouts?": { json: envelope({ items: [payout({ reference: "019f2f22", status: "COMPLETED" })], has_more: false }) } });
    await expect(sup().getPurchase("payout", "019f2f22")).resolves.toMatchObject({ status: "delivered" });
    expect(calls.map((c) => c.path)).toEqual(["/api/payouts/019f2f22", "/api/payouts?limit=100&offset=0"]);
  });

  it("pages the scan by what came back, not by the page size it asked for", async () => {
    // The endpoint documents a default page of 20 and may cap `limit`. Advancing the
    // offset by the requested size over a smaller page would step over the payout.
    const calls = stub({
      "GET /api/payouts?limit=100&offset=0": { json: envelope({ items: [payout({ reference: "ord_other" })], has_more: true }) },
      "GET /api/payouts?limit=100&offset=1": { json: envelope({ items: [payout({ reference: "ord_abc", status: "COMPLETED" })], has_more: false }) },
    });
    await expect(sup().getPurchase("payout", "ord_abc")).resolves.toMatchObject({ status: "delivered" });
    expect(calls.map((c) => c.path)).toEqual(["/api/payouts?limit=100&offset=0", "/api/payouts?limit=100&offset=1"]);
  });

  it("keeps an unfound payout retryable so the order stays open instead of refunding", async () => {
    stub({ "GET /api/payouts": { json: envelope({ items: [], has_more: false }) } });
    await expect(sup().getPurchase("payout", "ord_missing")).rejects.toMatchObject({ retryable: true });
  });

  it("finalises a payout left INITIATED by a crash between the calls", async () => {
    const calls = stub({
      "GET /api/payouts?": { json: envelope({ items: [payout({ status: "INITIATED" })], has_more: false }) },
      "POST /api/payouts/QT2_21015643/finalize": { json: envelope({ payout: payout({ status: "COMPLETED" }) }) },
    });
    await expect(sup().getPurchase("payout", "ord_abc")).resolves.toMatchObject({ status: "delivered" });
    expect(calls.some((c) => c.path.endsWith("/finalize"))).toBe(true);
  });

  it("calls a quote or an initialised payout failed once its window has closed", async () => {
    stub({ "GET /api/payouts?": { json: envelope({ items: [payout({ status: "INITIATED", expires_at: "2020-01-01T00:00:00Z" })], has_more: false }) } });
    // Nothing was sent, so failing now refunds the payer sooner than the fulfilment timeout would.
    await expect(sup().getPurchase("payout", "ord_abc")).resolves.toMatchObject({ status: "failed", error: "EXPIRED" });
  });

  it("maps the partner's mixed-case status vocabularies, and treats the unknown as pending", async () => {
    for (const [status, expected] of [["success", "delivered"], ["COMPLETED", "delivered"], ["FAILED", "failed"], ["expired", "failed"], ["processing", "pending"], ["SOMETHING_NEW", "pending"]] as const) {
      vi.unstubAllGlobals();
      stub({ "GET /api/payouts/019f2f22": { json: envelope({ payout: payout({ status, expires_at: "2099-01-01T00:00:00Z" }) }) } });
      await expect(sup().getPurchase("payout", "019f2f22")).resolves.toMatchObject({ status: expected });
    }
  });
});

describe("balance and fx", () => {
  it("reads the float for the configured asset in micro-USD", async () => {
    stub({ "GET /api/balances": { json: envelope({ accounts: [
      { currency: "BTC", available_balance: "0", available_balance_formatted: "0.0 BTC" },
      { currency: "USDC", available_balance: "2995328", available_balance_formatted: "2.995328 USDC" },
    ] }) } });
    await expect(sup().balanceMicro()).resolves.toBe(2_995_328);
  });

  it("names the missing account rather than reporting a zero float", async () => {
    stub({ "GET /api/balances": { json: envelope({ accounts: [{ currency: "BTC", available_balance: "0" }] }) } });
    await expect(sup().balanceMicro()).rejects.toThrow(/no USDC account/);
  });

  it("refuses to guess when the raw balance and its formatted form disagree", () => {
    // A wrong divisor here is a 1000x error in a preflight float check.
    expect(() => balanceMicroOf({ available_balance: "2995", available_balance_formatted: "2.995328 USDC" }, "USDC")).toThrow(/ambiguous/);
    expect(balanceMicroOf({ available_balance: "2995328" }, "USDC")).toBe(2_995_328);
    expect(balanceMicroOf({ available_balance_formatted: "2.995328 USDC" }, "USDC")).toBe(2_995_328);
    expect(() => balanceMicroOf({}, "USDC")).toThrow(SupplierError);
  });

  it("quotes fx from the same conservative rate the offers are priced from", async () => {
    stub(CATALOGUE);
    const s = sup();
    await expect(s.fxRate("NGN")).resolves.toBe(1375.5977112);
    await expect(s.fxRate("XOF")).resolves.toBeNull();
  });
});
