// The hosted MCP endpoint (POST /mcp, Streamable HTTP). The property that matters
// most: this server holds no wallet, so `buy` must hand back the x402 challenge and
// never attempt to spend on the caller's behalf.
import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";
import { decodePaymentRequired, registerTools } from "../src/mcp-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const kp = generateKeypair();

/** Unpaid requests 402 with the requirements in the header, as the real middleware does. */
const fakePayment: MiddlewareHandler = async (c, next) => {
  if (!c.req.header("x-test-pay")) {
    c.header("payment-required", Buffer.from(JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "algorand:test", amount: "7540000", asset: "31566704", payTo: "PAYTO" }],
    })).toString("base64"));
    return c.json({ error: "payment required" }, 402);
  }
  await next();
};

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

type App = ReturnType<typeof build>;

let nextId = 1;
async function rpc(app: App, method: string, params?: unknown): Promise<any> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return res.json();
}

/** Tool results arrive as a text block holding JSON. */
async function callTool(app: App, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await rpc(app, "tools/call", { name, arguments: args });
  const body = r.result.content[0].text;
  try { return JSON.parse(body); } catch { return body; }
}

describe("hosted MCP transport", () => {
  it("completes the initialize handshake", async () => {
    const r = await rpc(build(), "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
    });
    expect(r.result.serverInfo).toEqual({ name: "iomarkets-topup", version: "0.1.0" });
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it("advertises the full tool surface", async () => {
    const r = await rpc(build(), "tools/list");
    expect(r.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["buy", "create_pay_link", "fx", "ledger", "list_offers", "lookup_phone", "order_status", "quote", "verify_receipt"],
    );
  });

  it("rejects non-POST with a pointer to the docs", async () => {
    const res = await build().request("/mcp");
    expect(res.status).toBe(405);
    expect((await res.json()).docs).toMatch(/agent\.md$/);
  });

  it("keeps no session between requests (stateless)", async () => {
    const app = build();
    await rpc(app, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
    });
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((await res.json()).result.tools.length).toBe(9);
  });
});

describe("tools reach the real API in-process", () => {
  it("looks up a phone and lists offers", async () => {
    const app = build();
    expect(await callTool(app, "lookup_phone", { phone: "+919876543210" })).toMatchObject({ country: "IN", brand: "AIRTEL" });
    const offers = await callTool(app, "list_offers", { type: "esim", country: "IN" });
    expect(offers.offers.map((o: { offerId: string }) => o.offerId)).toContain("mock-esim-in-5gb-30d");
  });

  it("quotes a price", async () => {
    const q = await callTool(build(), "quote", { type: "esim", offerId: "mock-esim-in-5gb-30d" });
    expect(q.quoteId).toMatch(/^q_/);
    expect(q.price_usdc).toBe("7.540000");
  });
});

describe("hosted buy never spends the caller's money", () => {
  it("returns the x402 challenge rather than paying", async () => {
    const app = build();
    const q = await callTool(app, "quote", { type: "esim", offerId: "mock-esim-in-5gb-30d" });
    const r = await callTool(app, "buy", { quoteId: q.quoteId });

    expect(r.http_status).toBe(402);
    // The caller gets everything it needs to pay from its own wallet...
    expect(r.payment_required.accepts[0]).toMatchObject({ scheme: "exact", amount: "7540000", payTo: "PAYTO" });
    expect(r.how_to_pay).toMatch(/your own Algorand wallet/);
    // ...and nothing was ordered, because nothing was paid.
    expect(r.orderId).toBeUndefined();
    expect(r.spent_this_session_usdc).toBeUndefined();
  });

  // Driven through a stub rather than the app: the fake payment middleware above
  // 402s every unpaid request, so it can never exercise the passthrough branch.
  it("passes a non-402 response straight through, with no payment fields", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, {
      apiBase: "http://x",
      call: async () => new Response(JSON.stringify({ error: "quote already used" }), { status: 403, headers: { "content-type": "application/json" } }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientSide);

    const res = await client.callTool({ name: "buy", arguments: { quoteId: "q_used" } });
    const r = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(r).toEqual({ http_status: 403, error: "quote already used" });
    expect(r.payment_required).toBeUndefined();
    await client.close();
  });
});

describe("decodePaymentRequired", () => {
  it("decodes the base64 header", () => {
    const payload = { x402Version: 2, accepts: [{ scheme: "exact" }] };
    expect(decodePaymentRequired(Buffer.from(JSON.stringify(payload)).toString("base64"))).toEqual(payload);
  });

  it("returns null for a missing or malformed header rather than throwing", () => {
    expect(decodePaymentRequired(null)).toBeNull();
    expect(decodePaymentRequired("!!!not-base64-json!!!")).toBeNull();
  });
});
