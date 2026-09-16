// Airalo adapter, checked against the field names in Airalo's own PHP SDK (v2.0.1) —
// the same method that caught three real defects in the Reloadly adapter before a cent
// moved. Airalo publishes no machine-readable spec; the SDK's constants, services and
// README response samples are the authority.
import { describe, expect, it, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { AiraloSupplier } from "../src/suppliers/airalo.js";
import { SupplierError } from "../src/suppliers/types.js";

const BASE = "https://partners-api.airalo.com/v2/";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call { url: string; init?: RequestInit }
let calls: Call[] = [];
let responder: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  calls = [];
  responder = (url) => (url.endsWith("token") ? json({ data: { access_token: "TOK", expires_in: 3600 } }) : json({ data: [] }));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as unknown as typeof fetch;
});

const sup = () => new AiraloSupplier("cid", "csecret");

/** The README's package sample, trimmed to the fields the adapter reads. */
const PACKAGE_PAGE = {
  data: [{
    slug: "greece",
    operators: [{
      title: "Meraki Mobile",
      is_roaming: true,
      plan_type: "data",
      activation_policy: "first-usage",
      countries: [{ country_code: "GR" }],
      packages: [{
        id: "meraki-mobile-7days-1gb",
        type: "sim",
        price: 5,
        net_price: 4,
        amount: 1024,
        day: 7,
        is_unlimited: false,
        title: "1 GB - 7 Days",
        data: "1 GB",
        short_info: "This eSIM doesn't come with a phone number.",
        prices: { net_price: { USD: 4.0, GBP: 3.2, EUR: 3.84 } },
      }],
    }],
  }],
  meta: { last_page: 1 },
};

/** The README's order sample, trimmed. */
const ORDER = {
  id: 77670,
  code: "20240514-077670",
  currency: "USD",
  package_id: "change-7days-1gb",
  quantity: 1,
  validity: 7,
  package: "Change-1 GB - 7 Days",
  data: "1 GB",
  net_price: 3.6,
  installation_guides: { en: "https://www.airalo.com/help/getting-started-with-airalo" },
  sims: [{
    id: 102795,
    iccid: "893000000000034143",
    lpa: "lpa.airalo.com",
    matching_id: "TEST",
    qrcode: "LPA:1$lpa.airalo.com$TEST",
    qrcode_url: "https://airalo.com/qr?id=137975",
    apn_type: "automatic",
    apn_value: null,
  }],
};

describe("authentication", () => {
  it("posts form-encoded credentials and signs the payload with HMAC-SHA512", async () => {
    responder = (url) => (url.endsWith("token") ? json({ data: { access_token: "TOK", expires_in: 3600 } }) : json(PACKAGE_PAGE));
    await sup().listOffers({ type: "esim", country: "GR" });

    const token = calls.find((c) => c.url === `${BASE}token`)!;
    expect(token.init?.method).toBe("POST");
    expect(String(token.init?.body)).toContain("grant_type=client_credentials");
    // Signature.php: HMAC-SHA512 of the JSON payload under the client secret.
    const expected = createHmac("sha512", "csecret")
      .update(JSON.stringify({ client_id: "cid", client_secret: "csecret", grant_type: "client_credentials" }))
      .digest("hex");
    expect((token.init?.headers as Record<string, string>)["airalo-signature"]).toBe(expected);
  });

  it("reuses the token rather than re-authenticating per call", async () => {
    responder = (url) => (url.endsWith("token") ? json({ data: { access_token: "TOK", expires_in: 3600 } }) : json(PACKAGE_PAGE));
    const s = sup();
    await s.listOffers({ type: "esim" });
    await s.listOffers({ type: "esim" });
    expect(calls.filter((c) => c.url === `${BASE}token`)).toHaveLength(1);
  });

  it("never echoes the token response body into an error", async () => {
    responder = (url) => (url.endsWith("token") ? json({ error: "bad", client_secret: "csecret" }, 401) : json({}));
    // A credential must not reach a log line via an error message.
    await expect(sup().listOffers({ type: "esim" })).rejects.toThrow(/HTTP 401$/);
  });
});

describe("packages → offers", () => {
  beforeEach(() => {
    responder = (url) => (url.endsWith("token") ? json({ data: { access_token: "TOK" } }) : json(PACKAGE_PAGE));
  });

  it("flattens country → operators → packages and prices from prices.net_price.USD", async () => {
    const [o] = await sup().listOffers({ type: "esim", country: "GR" });
    expect(o).toMatchObject({
      id: "as-meraki-mobile-7days-1gb",
      type: "esim",
      country: "GR",
      brand: "AIRALO",
      brandName: "Meraki Mobile",
      name: "1 GB - 7 Days",
      priceType: "fixed",
      costMicro: 4_000_000, // prices.net_price.USD, NOT the top-level net_price
      dataGB: 1,
      durationDays: 7,
    });
  });

  it("sends the documented query params", async () => {
    await sup().listOffers({ type: "esim", country: "gr", limit: 10 });
    const url = calls.find((c) => c.url.includes("packages"))!.url;
    expect(url).toContain("include=topup");
    expect(decodeURIComponent(url)).toContain("filter[country]=GR");
    expect(url).toContain("limit=10");
  });

  it("REFUSES a package with no USD price rather than inferring FX", async () => {
    // This is the exact defect that makes Zendit unusable: every field name correct and
    // the account denominated in GBP. A package priced only in GBP is skipped, not
    // converted, and not silently sold at a GBP number treated as dollars.
    responder = (url) => url.endsWith("token") ? json({ data: { access_token: "TOK" } }) : json({
      data: [{ slug: "greece", operators: [{ title: "M", countries: [{ country_code: "GR" }], packages: [
        { id: "gbp-only", title: "x", prices: { net_price: { GBP: 3.2 } } },
        { id: "usd-ok", title: "y", prices: { net_price: { USD: 9 } } },
      ] }] }],
    });
    const offers = await sup().listOffers({ type: "esim" });
    // One bad package must not hide the catalogue, and must not be sold.
    expect(offers.map((o) => o.id)).toEqual(["as-usd-ok"]);
  });

  it("marks a multi-country package as WW and keeps the country list", async () => {
    responder = (url) => url.endsWith("token") ? json({ data: { access_token: "TOK" } }) : json({
      data: [{ slug: "global", operators: [{ title: "G", countries: [{ country_code: "GR" }, { country_code: "IT" }], packages: [
        { id: "g1", title: "Global 1GB", prices: { net_price: { USD: 9 } } },
      ] }] }],
    });
    const [o] = await sup().listOffers({ type: "esim" });
    expect(o.country).toBe("WW");
    expect(o.regions).toEqual(["GR", "IT"]);
  });

  it("returns nothing for a product type Airalo does not sell", async () => {
    expect(await sup().listOffers({ type: "topup" })).toEqual([]);
    expect(await sup().getOffer("bill", "as-x")).toBeNull();
  });

  it("declares itself as eSIM-only", () => {
    expect(sup().productTypes).toEqual(["esim"]);
  });
});

describe("ordering", () => {
  beforeEach(() => {
    responder = (url) => {
      if (url.endsWith("token")) return json({ data: { access_token: "TOK" } });
      if (url.endsWith("orders")) return json({ data: ORDER });
      return json(PACKAGE_PAGE);
    };
  });

  const req = { orderId: "ord_abc", type: "esim" as const, offerId: "as-change-7days-1gb", recipient: {}, costMicro: 4_000_000 };

  it("posts the documented body and strips our id prefix from the package id", async () => {
    await sup().purchase(req);
    const call = calls.find((c) => c.url === `${BASE}orders`)!;
    expect(JSON.parse(String(call.init?.body))).toEqual({
      package_id: "change-7days-1gb", // "as-" removed
      quantity: 1,
      type: "sim",
      description: "iomarkets ord_abc",
    });
  });

  it("carries our order id in description — the only handle on a timed-out order", async () => {
    // Airalo publishes no idempotency key and no order lookup, so this is what makes an
    // unresolved order reconcilable by a human. See the adapter header.
    await sup().purchase(req);
    const body = JSON.parse(String(calls.find((c) => c.url === `${BASE}orders`)!.init?.body));
    expect(body.description).toContain("ord_abc");
  });

  it("signs the order payload too", async () => {
    await sup().purchase(req);
    const call = calls.find((c) => c.url === `${BASE}orders`)!;
    const headers = call.init?.headers as Record<string, string>;
    const expected = createHmac("sha512", "csecret").update(String(call.init?.body)).digest("hex");
    expect(headers["airalo-signature"]).toBe(expected);
    expect(headers.authorization).toBe("Bearer TOK");
  });

  it("maps the eSIM into a delivery whose confirmation is the LPA string", async () => {
    const r = await sup().purchase(req);
    expect(r.status).toBe("delivered");
    expect(r.supplierTxId).toBe("77670");
    // This string IS the deliverable — it is what a phone installs.
    expect(r.confirmation).toMatchObject({
      lpa: "LPA:1$lpa.airalo.com$TEST",
      iccid: "893000000000034143",
      smdp_address: "lpa.airalo.com",
      activation_code: "TEST",
      validity_days: 7,
    });
  });

  it("rebuilds the LPA string when only its parts come back", () => {
    const r = AiraloSupplier.map({ id: 1, sims: [{ iccid: "89", lpa: "lpa.airalo.com", matching_id: "ABC" }] }, "ord_x");
    expect((r.confirmation as { lpa: string }).lpa).toBe("LPA:1$lpa.airalo.com$ABC");
  });
});

describe("the unresolvable-timeout problem, handled conservatively", () => {
  it("treats an order with no SIM as PENDING, not failed", () => {
    // orders-async exists, so accepted-but-not-yet-issued is plausible. Reporting
    // "failed" would refund a payer whose eSIM is about to arrive.
    const r = AiraloSupplier.map({ id: 5, code: "c", sims: [] }, "ord_x");
    expect(r.status).toBe("pending");
  });

  it("raises a RETRYABLE error on a network failure, naming the reconciliation handle", async () => {
    responder = (url) => { if (url.endsWith("token")) return json({ data: { access_token: "TOK" } }); throw new Error("socket hang up"); };
    globalThis.fetch = (async (url: string) => {
      calls.push({ url: String(url) });
      if (String(url).endsWith("token")) return json({ data: { access_token: "TOK" } });
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    const e = await sup().purchase({ orderId: "ord_zz", type: "esim", offerId: "as-p", recipient: {}, costMicro: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(SupplierError);
    expect(e.retryable).toBe(true);
    // The message has to tell an operator exactly how to reconcile it, because the API cannot.
    expect(e.message).toContain("iomarkets ord_zz");
    expect(e.message).toMatch(/manual reconciliation/);
  });

  it("refuses to answer getPurchase, retryably, rather than reading unknown as failed", async () => {
    const e = await sup().getPurchase("esim", "77670").catch((x) => x);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/no order-lookup endpoint/);
  });

  it("refuses to invent a balance, because the float gate would enforce it", async () => {
    await expect(sup().balanceMicro()).rejects.toThrow(/no balance endpoint/);
  });
});

describe("construction", () => {
  it("will not start without credentials", () => {
    expect(() => new AiraloSupplier("", "")).toThrow(SupplierError);
  });
});
