// Does the tag the challenge grades us on actually reach the wire?
//
// The Global x402 Challenge's readiness checklist requires our endpoint to appear in
// the Bazaar with the `x402-global-challenge` tag, and the Bazaar takes that tag from
// the payment requirements it sees — measured 2026-08-29, 422 of the first 500 listed
// resources carry `accepts[0].extra.tag` and NOT ONE carries a resource-level `tags`
// array. We declare both. Declaring is not emitting: `extra` passes through a
// middleware that rewrites this object (it injects `feePayer`), and an `extra` that
// dropped unknown keys would look identical from our side, list us untagged, and cost
// eligibility silently.
//
// So this builds the app with the REAL @x402/hono middleware — not the stub the rest
// of the HTTP tests use — takes a genuine 402, and decodes the header a facilitator
// would read.
//
// ── Why the facilitator is stubbed, and what its absence taught us ────────────
//
// This test used to reach the LIVE GoPlausible facilitator, because the real middleware
// asks it what it supports. Measured 2026-09-02 on unchanged code: **it fails roughly
// one run in four** — three green, one red, then five green and one red on the
// pre-session commit — and the failure is `expected 500 to be 402`.
//
// Two separate things were hiding in that:
//
//   1. **A flaky test.** What it exists to prove is that OUR `extra` survives the
//      middleware that rewrites it. That question does not need the network, so the one
//      call the middleware makes is served here from a response captured from the real
//      facilitator on 2026-09-02. Whether the facilitator still supports our network is
//      a different question, and `pnpm preflight` already asks it against the live host.
//   2. **A production fact worth knowing:** when the facilitator is slow or unreachable,
//      the paid route answers **500, not 402**. An agent sees a broken server rather than
//      a price. Nothing here can fix that — the call lives inside @x402/hono — but it is
//      the reason /health and preflight both check the facilitator, and it is worth
//      remembering the next time the route looks broken and our code is not.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";

const kp = generateKeypair();

/** `GET /supported`, captured from https://facilitator.goplausible.xyz on 2026-09-02.
 *  Trimmed to the two Algorand entries — the ones this route can be served by — with the
 *  `extra.feePayer` the middleware injects into our payment requirements left intact,
 *  because that injection is precisely what this file is here to survive. */
const SUPPORTED = {
  kinds: [
    {
      x402Version: 2, scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      extra: { feePayer: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" },
    },
    {
      x402Version: 2, scheme: "exact", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
      extra: { feePayer: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" },
    },
  ],
  extensions: [],
  signers: { "algorand:*": ["ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA"] },
};

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Only the discovery call is served locally. Anything else aimed at the facilitator
    // during a 402 would be a change in the middleware worth failing over.
    if (url.startsWith(config.facilitatorUrl) && url.includes("/supported")) {
      return new Response(JSON.stringify(SUPPORTED), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

/** No `paymentMiddleware` override: this is the real one, the one that ships. */
function buildReal() {
  const db = new Db(":memory:");
  const supplier = new MockSupplier();
  const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600,
    blockedCountries: ["CU"], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
    receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
  });
  return buildApp({ db, supplier, orders });
}

async function paymentRequired() {
  const app = buildReal();
  const cat = await (await app.request("/v1/catalog?type=esim&country=IN")).json() as { offers: Array<{ offerId: string }> };
  const q = await (await app.request("/v1/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "esim", offerId: cat.offers[0].offerId, recipient: {} }),
  })).json() as { quoteId: string };

  const res = await app.request("/v1/orders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId: q.quoteId }),
  });
  const header = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
  return { res, header };
}

describe("the challenge tag on the wire", () => {
  it("is present in accepts[].extra of a real 402, where the Bazaar reads it", async () => {
    const { res, header } = await paymentRequired();
    expect(res.status).toBe(402);
    expect(header, "no payment-required header — the real middleware did not run").toBeTruthy();

    const challenge = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as {
      accepts: Array<{ extra?: Record<string, unknown>; asset?: string; payTo?: string }>;
    };
    expect(challenge.accepts.length).toBeGreaterThan(0);
    // The exact assertion the facilitator's listing makes.
    expect(challenge.accepts[0].extra?.tag).toBe("x402-global-challenge");
  });

  it("still carries the asset alongside it, so the tag did not displace anything", async () => {
    const { header } = await paymentRequired();
    const challenge = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as {
      accepts: Array<{ extra?: Record<string, unknown>; asset?: string }>;
    };
    expect(challenge.accepts[0].extra?.asset).toBeTruthy();
    expect(challenge.accepts[0].asset).toBeTruthy();
  });
});
