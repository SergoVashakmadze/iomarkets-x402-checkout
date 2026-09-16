// eSIM Access adapter, checked against the vendor's own published API reference
// (github.com/esimaccess/esimaccess-api, MIT — eSIM Access publish it themselves as an
// agent skill). Same method as every other adapter here: the samples in these tests are
// the vendor's, not invented, because an adapter that agrees with a spec we wrote
// ourselves proves nothing.
import { describe, expect, it, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { EsimAccessSupplier } from "../src/suppliers/esimaccess.js";
import { SupplierError } from "../src/suppliers/types.js";

const CODE = "ACCESS_CODE_123";
const BASE = "https://api.esimaccess.com/api/v1/open";

const ok = (obj: unknown) => new Response(JSON.stringify({ success: true, errorCode: "0", errorMsg: null, obj }), {
  status: 200, headers: { "content-type": "application/json" },
});
const fail = (errorCode: string, errorMsg = "") => new Response(JSON.stringify({ success: false, errorCode, errorMsg }), {
  status: 200, headers: { "content-type": "application/json" },
});

interface Call { path: string; body: Record<string, unknown>; headers: Record<string, string>; raw: string }
let calls: Call[] = [];
let responder: (path: string, body: Record<string, unknown>) => Response;

beforeEach(() => {
  calls = [];
  responder = () => ok({});
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(BASE, "");
    const raw = String(init?.body ?? "{}");
    const headers = init?.headers as Record<string, string>;
    calls.push({ path, body: JSON.parse(raw) as Record<string, unknown>, headers, raw });
    return responder(path, JSON.parse(raw) as Record<string, unknown>);
  }) as unknown as typeof fetch;
});

const sup = () => new EsimAccessSupplier(CODE);

/** The reference's own package sample. */
const PACKAGE = {
  packageCode: "US_5_30",
  slug: "us_5_30",
  name: "United States 5GB 30Days",
  price: 88000,
  retailPrice: 120000,
  currencyCode: "USD",
  volume: 5368709120,
  duration: 30,
  durationUnit: "DAY",
  location: "US",
  speed: "5G/LTE",
  supportTopUpType: 2,
  activeType: 1,
};

/** The reference's own eSIM sample: provisioned, QR issued, not yet installed. */
const ESIM = {
  esimTranNo: "26041021130002",
  orderNo: "B26041021130002",
  transactionId: "ord_1",
  iccid: "89852240810733629810",
  ac: "LPA:1$smdp.io$MATCH123",
  qrCodeUrl: "https://p.qrsim.net/xxx.png",
  shortUrl: "https://p.qrsim.net/xxx",
  smdpStatus: "RELEASED",
  esimStatus: "GOT_RESOURCE",
  expiredTime: "2026-10-07T21:13:01+0000",
  totalVolume: 5368709120,
  totalDuration: 30,
  durationUnit: "DAY",
  packageList: [{ packageName: "United States 5GB 30Days", packageCode: "US_5_30", locationCode: "US" }],
};

describe("auth", () => {
  it("signs timestamp + requestId + accessCode + body with the access code itself", async () => {
    responder = () => ok({ balance: 0 });
    await sup().balanceMicro();

    const { headers, raw } = calls[0];
    expect(headers["RT-AccessCode"]).toBe(CODE);
    expect(headers["RT-RequestID"]).toMatch(/^[0-9a-f-]{36}$/);
    const expected = createHmac("sha256", CODE)
      .update(headers["RT-Timestamp"] + headers["RT-RequestID"] + CODE + raw)
      .digest("hex");
    expect(headers["RT-Signature"]).toBe(expected);
  });

  it("signs the exact bytes it sends — a re-serialised body would break the signature", async () => {
    responder = () => ok({ packageList: [] });
    await sup().listOffers({ type: "esim", country: "jp" });

    const { headers, raw } = calls[0];
    const expected = createHmac("sha256", CODE).update(headers["RT-Timestamp"] + headers["RT-RequestID"] + CODE + raw).digest("hex");
    expect(headers["RT-Signature"]).toBe(expected);
    // Every endpoint is POST, and an empty filter is sent as "", never omitted.
    expect(calls[0].body).toMatchObject({ locationCode: "JP", type: "", slug: "", packageCode: "", iccid: "" });
  });

  it("signs with the secret key when the account has one, and still identifies by the access code", async () => {
    responder = () => ok({ balance: 0 });
    await new EsimAccessSupplier(CODE, BASE, "SECRET_KEY_456").balanceMicro();

    const { headers, raw } = calls[0];
    // The identifier is always the access code; only the signing key changes.
    expect(headers["RT-AccessCode"]).toBe(CODE);
    const signedWithSecret = createHmac("sha256", "SECRET_KEY_456")
      .update(headers["RT-Timestamp"] + headers["RT-RequestID"] + CODE + raw).digest("hex");
    const signedWithCode = createHmac("sha256", CODE)
      .update(headers["RT-Timestamp"] + headers["RT-RequestID"] + CODE + raw).digest("hex");
    expect(headers["RT-Signature"]).toBe(signedWithSecret);
    expect(headers["RT-Signature"]).not.toBe(signedWithCode);
  });

  it("never puts the access code in an error message", async () => {
    responder = () => fail("401001", "auth failed");
    await expect(sup().balanceMicro()).rejects.toThrow(/401001/);
    await expect(sup().balanceMicro()).rejects.not.toThrow(new RegExp(CODE));
  });
});

describe("catalogue", () => {
  it("prices from price ÷ 10,000 USD, not retailPrice", async () => {
    responder = () => ok({ packageList: [PACKAGE] });
    const [offer] = await sup().listOffers({ type: "esim", country: "US" });

    // 88000 units = $8.80 = 8,800,000 micro-USD. retailPrice (120000) is theirs, not ours.
    expect(offer.costMicro).toBe(8_800_000);
    expect(offer).toMatchObject({ id: "ea-US_5_30", type: "esim", country: "US", brand: "ESIMACCESS", priceType: "fixed" });
    expect(offer.dataGB).toBe(5);
    expect(offer.durationDays).toBe(30);
    expect(offer.notes).toContain("top-up supported");
  });

  it("refuses a package priced in anything but USD rather than converting it", () => {
    expect(() => EsimAccessSupplier["costMicro"]({ packageCode: "X", price: 1000, currencyCode: "EUR" })).toThrow(SupplierError);
    expect(() => EsimAccessSupplier["costMicro"]({ packageCode: "X", price: 1000, currencyCode: "EUR" })).toThrow(/not USD/);
  });

  it("drops an unpriceable package without hiding the rest of the catalogue", async () => {
    responder = () => ok({ packageList: [{ ...PACKAGE, packageCode: "EUR_1", currencyCode: "EUR" }, PACKAGE, { name: "no code" }] });
    const offers = await sup().listOffers({ type: "esim" });
    expect(offers.map((o) => o.id)).toEqual(["ea-US_5_30"]);
  });

  it("treats a multi-country location as a region, never as one country", async () => {
    responder = () => ok({ packageList: [{ ...PACKAGE, packageCode: "EU_3_30", location: "FR,DE,ES" }] });
    const [offer] = await sup().listOffers({ type: "esim" });
    expect(offer.country).toBe("WW");
    expect(offer.regions).toEqual(["FR", "DE", "ES"]);
  });

  it("fetches one package by code instead of the whole catalogue", async () => {
    responder = () => ok({ packageList: [PACKAGE] });
    const offer = await sup().getOffer("esim", "ea-US_5_30");
    expect(offer?.id).toBe("ea-US_5_30");
    expect(calls[0].body).toMatchObject({ packageCode: "US_5_30", locationCode: "" });
  });

  it("reads the 3 MB unfiltered catalogue once, then serves it from cache", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...PACKAGE, packageCode: `P${i}` }));
    responder = () => ok({ packageList: many });
    const s = sup();

    expect(await s.listOffers({ type: "esim" })).toHaveLength(5);
    expect(await s.listOffers({ type: "esim" })).toHaveLength(5);
    // One call for two reads: the second came from the cache.
    expect(calls.filter((c) => c.path === "/package/list")).toHaveLength(1);
  });

  it("still calls out for a country, because that read is small and specific", async () => {
    responder = () => ok({ packageList: [PACKAGE] });
    const s = sup();
    await s.listOffers({ type: "esim" });
    await s.listOffers({ type: "esim", country: "JP" });
    expect(calls.filter((c) => c.path === "/package/list")).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ locationCode: "JP" });
  });

  it("pages with limit and offset without re-reading the catalogue", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...PACKAGE, packageCode: `P${i}` }));
    responder = () => ok({ packageList: many });
    const s = sup();

    const first = await s.listOffers({ type: "esim", limit: 3 });
    const second = await s.listOffers({ type: "esim", limit: 3, offset: 3 });
    expect(first.map((o) => o.id)).toEqual(["ea-P0", "ea-P1", "ea-P2"]);
    expect(second.map((o) => o.id)).toEqual(["ea-P3", "ea-P4", "ea-P5"]);
    expect(calls.filter((c) => c.path === "/package/list")).toHaveLength(1);
  });

  it("can still price an offer the caller paged past", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...PACKAGE, packageCode: `P${i}` }));
    responder = () => ok({ packageList: many });
    const s = sup();
    await s.listOffers({ type: "esim", limit: 2 });
    // Page 1 never showed ea-P9, but a quote for it must not need another catalogue read.
    expect((await s.getOffer("esim", "ea-P9"))?.id).toBe("ea-P9");
    expect(calls.filter((c) => c.path === "/package/list")).toHaveLength(1);
  });

  it("enumerates every destination in the catalogue, counting regional bundles under each", async () => {
    responder = () => ok({ packageList: [
      { ...PACKAGE, packageCode: "US_1", location: "US" },
      { ...PACKAGE, packageCode: "US_2", location: "US" },
      { ...PACKAGE, packageCode: "EU_1", location: "FR,DE,ES" },
      { ...PACKAGE, packageCode: "JP_1", location: "JP" },
    ] });
    const countries = await sup().listCountries("esim");
    expect(countries).toEqual([
      { code: "DE", offers: 1 }, { code: "ES", offers: 1 }, { code: "FR", offers: 1 },
      { code: "JP", offers: 1 }, { code: "US", offers: 2 },
    ]);
    // One catalogue read, shared with listOffers' cache.
    expect(calls.filter((c) => c.path === "/package/list")).toHaveLength(1);
    expect(await sup().listCountries("topup")).toEqual([]);
  });

  it("sells nothing but eSIMs", async () => {
    expect(await sup().listOffers({ type: "topup" })).toEqual([]);
    expect(await sup().getOffer("bill", "x")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("purchase", () => {
  it("uses OUR order id as the idempotency key and returns the provisioned eSIM", async () => {
    responder = (path) => (path === "/esim/order"
      ? ok({ orderNo: "B26041021130002", transactionId: "ord_1" })
      : ok({ esimList: [ESIM], pager: { total: 1 } }));

    const res = await sup().purchase({ orderId: "ord_1", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 8_800_000 });

    expect(calls[0].body).toEqual({ transactionId: "ord_1", packageInfoList: [{ packageCode: "US_5_30", count: 1 }] });
    expect(calls[1]).toMatchObject({ path: "/esim/query", body: { orderNo: "B26041021130002" } });
    expect(res.status).toBe("delivered");
    expect(res.supplierTxId).toBe("B26041021130002");
    expect(res.confirmation).toMatchObject({
      lpa: "LPA:1$smdp.io$MATCH123",
      iccid: "89852240810733629810",
      qrcode_url: "https://p.qrsim.net/xxx.png",
      validity_days: 30,
    });
  });

  it("reports pending, not failed, while the profile is still being issued", async () => {
    responder = (path) => (path === "/esim/order" ? ok({ orderNo: "B1" }) : ok({ esimList: [] }));
    const res = await sup().purchase({ orderId: "ord_2", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 8_800_000 });
    expect(res).toMatchObject({ supplierTxId: "B1", status: "pending" });
  });

  it("treats 200010 as 'not provisioned yet', because it is — and reading it as failure refunds a delivered eSIM", async () => {
    // Live, on the first real order: /esim/query answered `success:false` with
    // "200010 the batchOrder has been getting resource, total:[1], success:[0]" within
    // seconds of a purchase that went on to deliver. An adapter that reads that as an
    // error refunds a payer whose eSIM is at that moment being issued.
    responder = (path) => (path === "/esim/order"
      ? ok({ orderNo: "B1" })
      : fail("200010", "the batchOrder has been getting resource, total:[1], success:[0]"));

    const res = await sup().purchase({ orderId: "ord_5", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 8_800_000 });
    expect(res).toMatchObject({ supplierTxId: "B1", status: "pending" });
    // …and the same on a later poll, rather than throwing at the order layer.
    expect(await sup().getPurchase("esim", "B1")).toMatchObject({ status: "pending" });
  });

  it("still throws on an unsuccessful query that is NOT the provisioning code", async () => {
    responder = () => fail("400001", "invalid parameters");
    await expect(sup().getPurchase("esim", "B1")).rejects.toThrow(/400001/);
  });

  it("recovers a duplicate transactionId instead of ordering a second eSIM", async () => {
    responder = (path, body) => {
      if (path === "/esim/order") return fail("310402", "duplicate transactionId");
      if (body.transactionId === "ord_1") return ok({ esimList: [ESIM] });
      return ok({ esimList: [] });
    };

    const res = await sup().purchase({ orderId: "ord_1", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 8_800_000 });
    expect(res.status).toBe("delivered");
    expect(res.supplierTxId).toBe("B26041021130002");
    expect(calls.filter((c) => c.path === "/esim/order")).toHaveLength(1);
  });

  it("verifies the rows when the transactionId filter is ignored, and scans instead", async () => {
    // The docs promise a filter on orderNo and iccid only. A server that ignores
    // transactionId and returns everything must not hand us somebody else's eSIM.
    responder = (path, body) => {
      if (path === "/esim/order") return fail("310402", "duplicate");
      if (body.transactionId) return ok({ esimList: [{ ...ESIM, transactionId: "someone_else", orderNo: "B_OTHER" }] });
      return ok({ esimList: [{ ...ESIM, transactionId: "someone_else", orderNo: "B_OTHER" }, ESIM] });
    };

    const res = await sup().purchase({ orderId: "ord_1", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 8_800_000 });
    expect(res.supplierTxId).toBe("B26041021130002");
  });

  it("stays retryable when a duplicate cannot be found — never refunds a delivered eSIM", async () => {
    responder = (path) => (path === "/esim/order" ? fail("310402", "duplicate") : ok({ esimList: [] }));
    await expect(sup().purchase({ orderId: "ord_9", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 1 }))
      .rejects.toMatchObject({ retryable: true });
  });

  it("retries once with periodNum when a daily plan rejects the order as invalid", async () => {
    let ordered = 0;
    responder = (path, body) => {
      if (path === "/package/list") return ok({ packageList: [PACKAGE] });
      if (path === "/esim/order") {
        ordered++;
        return (body.packageInfoList as Array<Record<string, unknown>>)[0].periodNum ? ok({ orderNo: "B2" }) : fail("000105", "periodNum required");
      }
      return ok({ esimList: [{ ...ESIM, orderNo: "B2", transactionId: "ord_3" }] });
    };

    const res = await sup().purchase({ orderId: "ord_3", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 8_800_000 });
    expect(ordered).toBe(2);
    // Same transactionId on the retry: a rejected order was never created.
    expect(calls.filter((c) => c.path === "/esim/order").every((c) => c.body.transactionId === "ord_3")).toBe(true);
    expect(res.status).toBe("delivered");
  });

  it("treats an empty supplier float as final, not retryable — the payer is owed a refund", async () => {
    responder = () => fail("200007", "balance insufficient");
    await expect(sup().purchase({ orderId: "ord_4", type: "esim", offerId: "ea-US_5_30", recipient: {}, costMicro: 1 }))
      .rejects.toMatchObject({ retryable: false });
  });

  it("looks an order up by the supplier's order number", async () => {
    responder = () => ok({ esimList: [ESIM] });
    const res = await sup().getPurchase("esim", "B26041021130002");
    expect(calls[0].body).toMatchObject({ orderNo: "B26041021130002" });
    expect(res.status).toBe("delivered");
  });
});

describe("float", () => {
  it("reads the prepaid balance in micro-USD so the float gate applies to eSIMs", async () => {
    responder = () => ok({ balance: 2230180 });
    // 2,230,180 units = $223.018
    expect(await sup().balanceMicro()).toBe(223_018_000);
    expect(calls[0]).toMatchObject({ path: "/balance/query", raw: "{}" });
  });

  it("refuses to guess a balance", async () => {
    responder = () => ok({});
    await expect(sup().balanceMicro()).rejects.toThrow(SupplierError);
  });
});
