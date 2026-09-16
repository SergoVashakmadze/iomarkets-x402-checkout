// The verifier, which is the one part of this service a stranger is supposed to be able
// to run against us. Two things are being pinned here, and the second is the subtle one:
//
//   1. A tampered receipt fails, and a receipt signed by a DIFFERENT server still
//      verifies against its own key — because a spec other sellers can adopt is worth
//      more than a self-check, and those are distinguishable only by this test.
//   2. An indexer that cannot answer produces "unknown", never "failed". A third
//      party's outage must not be able to make our proof look like a lie — nor, in the
//      other direction, count as a pass.
import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair, signReceipt, type Receipt } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";
import { checkOnChain, verifyFully } from "../src/verify.js";

const kp = generateKeypair();
const other = generateKeypair();

const PAYLOAD = {
  order_id: "ord_test", status: "delivered" as "delivered" | "refunded", product_type: "esim", offer_id: "ea-US_5_30",
  country: "US", brand: "ESIMACCESS", recipient_hash: "abc", amount_usdc: "15.310000",
  payer: "PAYER_ADDRESS", settlement_txid: "TX_SETTLE", supplier: "esimaccess",
  supplier_tx_id: "B1", refund_txid: "", issued_at: "2026-09-02T00:00:00.000Z",
};

const receipt = (privateKey = kp.privateKey, over: Partial<typeof PAYLOAD> = {}) =>
  signReceipt({ ...PAYLOAD, ...over }, privateKey);

/** An indexer that answers with one asset transfer, or with whatever you hand it. */
const indexer = (res: (url: string) => Response) => ({
  indexerUrl: "https://indexer.test",
  usdcAsa: 31566704,
  fetchImpl: (async (url: string) => res(String(url))) as unknown as typeof fetch,
});

const transferOk = (amountMicro = 15_310_000, sender = "PAYER_ADDRESS", receiver = "US") =>
  new Response(JSON.stringify({
    transaction: {
      sender, "confirmed-round": 64544517,
      "asset-transfer-transaction": { amount: amountMicro, "asset-id": 31566704, receiver },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });

describe("signature", () => {
  it("verifies a good receipt and names our key as the signer", async () => {
    const r = await verifyFully(receipt(), { ourPubkey: kp.publicKey });
    expect(r.signature).toBe("ok");
    expect(r.signer_is).toBe("this-server");
  });

  it("fails a receipt whose payload was edited after signing", async () => {
    const r = receipt();
    const tampered: Receipt = { ...r, payload: { ...r.payload, amount_usdc: "1.000000" } };
    const out = await verifyFully(tampered, { ourPubkey: kp.publicKey });
    expect(out.signature).toBe("failed");
    expect(out.verified).toBe(false);
  });

  it("verifies another server's receipt against ITS key, and says whose it is", async () => {
    const out = await verifyFully(receipt(other.privateKey), { ourPubkey: kp.publicKey });
    expect(out.signature).toBe("ok");
    expect(out.signer_is).toBe("another-server");
    expect(out.notes.join(" ")).toMatch(/signed by another server/i);
  });

  it("spends no indexer call on a receipt whose signature already failed", async () => {
    let calls = 0;
    const r = receipt();
    const tampered: Receipt = { ...r, payload: { ...r.payload, payer: "SOMEONE_ELSE" } };
    await verifyFully(tampered, {
      ourPubkey: kp.publicKey,
      chain: indexer(() => { calls++; return transferOk(); }),
    });
    expect(calls).toBe(0);
  });
});

describe("on-chain checks", () => {
  it("confirms a matching USDC transfer", async () => {
    const c = await checkOnChain("TX", { amountUsdc: "15.310000", sender: "PAYER_ADDRESS" }, indexer(() => transferOk()));
    expect(c).toMatchObject({ state: "ok", confirmedRound: 64544517 });
  });

  it("fails a transfer that is on chain but does not match the receipt", async () => {
    const wrongAmount = await checkOnChain("TX", { amountUsdc: "15.310000" }, indexer(() => transferOk(1_000_000)));
    expect(wrongAmount.state).toBe("failed");
    expect(wrongAmount.detail).toMatch(/amount 1000000/);

    const wrongSender = await checkOnChain("TX", { amountUsdc: "15.310000", sender: "PAYER_ADDRESS" }, indexer(() => transferOk(15_310_000, "NOT_THE_PAYER")));
    expect(wrongSender.state).toBe("failed");

    const wrongAsset = await checkOnChain("TX", { amountUsdc: "15.310000" }, indexer(() => new Response(
      JSON.stringify({ transaction: { "asset-transfer-transaction": { amount: 15_310_000, "asset-id": 999 } } }), { status: 200 },
    )));
    expect(wrongAsset.state).toBe("failed");
    expect(wrongAsset.detail).toMatch(/asset 999/);
  });

  it("reports UNKNOWN, not failed, when the indexer cannot answer", async () => {
    const missing = await checkOnChain("TX", { amountUsdc: "1.000000" }, indexer(() => new Response("", { status: 404 })));
    expect(missing.state).toBe("unknown");
    expect(missing.detail).toMatch(/retention/);

    const down = await checkOnChain("TX", { amountUsdc: "1.000000" }, indexer(() => new Response("", { status: 503 })));
    expect(down.state).toBe("unknown");

    const unreachable = await checkOnChain("TX", { amountUsdc: "1.000000" }, {
      indexerUrl: "https://indexer.test", usdcAsa: 31566704,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(unreachable.state).toBe("unknown");
    expect(unreachable.detail).toMatch(/ECONNREFUSED/);
  });

  it("an empty txid is a failure of the receipt, not of the indexer", async () => {
    expect((await checkOnChain("", { amountUsdc: "1.000000" }, indexer(() => transferOk()))).state).toBe("failed");
  });
});

describe("the whole verdict", () => {
  it("is verified only when the signature AND every chain leg check out", async () => {
    const good = await verifyFully(receipt(), { ourPubkey: kp.publicKey, chain: indexer(() => transferOk()) });
    expect(good.verified).toBe(true);
  });

  it("is NOT verified when a leg is unknown, and says the doubt is about the indexer", async () => {
    const out = await verifyFully(receipt(), {
      ourPubkey: kp.publicKey,
      chain: indexer(() => new Response("", { status: 503 })),
    });
    expect(out.signature).toBe("ok");
    expect(out.verified).toBe(false);
    expect(out.notes.join(" ")).toMatch(/statement about the indexer, not about the payment/);
  });

  it("checks the refund leg in the other direction — back TO the payer", async () => {
    const seen: Array<{ url: string }> = [];
    const r = receipt(kp.privateKey, { status: "refunded", refund_txid: "TX_REFUND" });
    const out = await verifyFully(r, {
      ourPubkey: kp.publicKey,
      chain: indexer((url) => {
        seen.push({ url });
        // The refund must land ON the payer's address; the settlement came FROM it.
        return url.includes("TX_REFUND") ? transferOk(15_310_000, "OUR_FLOAT", "PAYER_ADDRESS") : transferOk();
      }),
    });
    expect(seen).toHaveLength(2);
    expect(out.refund?.state).toBe("ok");
    expect(out.verified).toBe(true);
  });

  it("catches a refund that went somewhere other than the payer", async () => {
    const r = receipt(kp.privateKey, { status: "refunded", refund_txid: "TX_REFUND" });
    const out = await verifyFully(r, {
      ourPubkey: kp.publicKey,
      chain: indexer((url) => (url.includes("TX_REFUND") ? transferOk(15_310_000, "OUR_FLOAT", "SOMEONE_ELSE") : transferOk())),
    });
    expect(out.refund?.state).toBe("failed");
    expect(out.verified).toBe(false);
  });
});

/** Stands in for @x402/hono; the verify route never touches it. */
const fakePayment: MiddlewareHandler = async (c) => c.json({ error: "payment required" }, 402);

function build() {
  const db = new Db(":memory:");
  const supplier = new MockSupplier();
  const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600,
    blockedCountries: ["CU"], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
    receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
  });
  return buildApp({ db, supplier, orders, paymentMiddleware: fakePayment });
}
const post = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

describe("POST /v1/verify", () => {
  it("takes a bare receipt", async () => {
    const res = await build().request("/v1/verify?online=0", post(receipt()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signature: "ok", order_id: "ord_test", verified: false });
  });

  it("also takes the order response an agent already has, which contains one", async () => {
    const res = await build().request("/v1/verify?online=0", post({ order_id: "x", status: "delivered", receipt: receipt() }));
    expect(res.status).toBe(200);
    expect((await res.json()).signature).toBe("ok");
  });

  it("returns a verdict for a bad signature — not an error", async () => {
    const r = receipt();
    const res = await build().request("/v1/verify?online=0", post({ ...r, payload: { ...r.payload, order_id: "ord_other" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signature: "failed", verified: false });
  });

  it("serves the format it invites other sellers to adopt", async () => {
    const res = await build().request("/receipts.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const body = await res.text();
    // Served from docs/RECEIPTS.md itself, so the spec and the served copy cannot drift.
    expect(body).toContain("Signed delivery receipts for x402 sellers");
    expect(body).toContain("canonicalize");
    // And the verifier points at it, so a caller can find the rules from a verdict.
    const verdict = await (await build().request("/v1/verify?online=0", post(receipt()))).json();
    expect(verdict.spec).toMatch(/\/receipts\.md$/);
  });

  it("rejects a body that is not a receipt at all", async () => {
    for (const body of [{ hello: "world" }, { payload: { order_id: "x" }, signature: "ab" }, "nonsense"]) {
      expect((await build().request("/v1/verify", post(body))).status).toBe(400);
    }
  });
});
