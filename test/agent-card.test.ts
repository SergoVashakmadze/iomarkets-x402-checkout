// The A2A agent card. Two things are worth pinning here.
//
//  1. **It cannot promise a product no supplier can fill.** Every other public surface
//     renders its product list from CompositeSupplier.availableTypes for this reason
//     (landing.ts, the Bazaar description, the console's opening tab — the last of which
//     shipped a payout shop with the shutters down on 2026-09-02). A discovery document
//     read by a router is the worst place to repeat that: the router sends a customer we
//     then refuse at quote time, and it learns not to route here again.
//
//  2. **It must claim no transport at all.** This service does not speak A2A JSON-RPC,
//     so `url` and `preferredTransport` have no honest value — not "JSONRPC" (a lie),
//     not "HTTP+JSON" (valid enum, wrong binding), and not "MCP" (true, but not a value
//     the spec's enum admits). Owner decision, 2026-09-20: the card carries neither
//     field and is discovery metadata, not a callable endpoint. Every one of those three
//     is a plausible "fix" for someone reading the A2A spec rather than this server, so
//     their absence is a test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { agentCard, SERVICE_VERSION } from "../src/agent-card.js";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";

const FACTS = {
  base: "https://iomarkets.app",
  network: "mainnet",
  pubkey: "abc123",
  payTo: "PAYTOADDRESS",
  brand: "IoMarkets Topup",
  site: "https://iomarkets.app",
} as const;

function build() {
  const kp = generateKeypair();
  const db = new Db(":memory:");
  const supplier = new MockSupplier();
  const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600,
    blockedCountries: ["CU"], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
    receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
  });
  return buildApp({ db, supplier, orders, paymentMiddleware: async (c) => c.json({ error: "payment required" }, 402) });
}

describe("the agent card as a document", () => {
  it("is served on both the current and the legacy well-known path, identically", async () => {
    const app = build();
    const bodies: string[] = [];
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/application\/json/);
      bodies.push(JSON.stringify(await res.json()));
    }
    // A router that reads one path and a crawler that reads the other must not be told
    // two different things about the same service.
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("carries every field the spec requires, and no undefined", async () => {
    const card = await (await build().request("/.well-known/agent-card.json")).json() as Record<string, unknown>;
    for (const k of ["protocolVersion", "name", "description", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
      expect(card[k], k).toBeDefined();
    }
    expect(JSON.stringify(card)).not.toContain("undefined");
    expect(Array.isArray(card.skills) && (card.skills as unknown[]).length).toBeGreaterThan(0);
  });

  it("points only at endpoints this server actually serves", async () => {
    const app = build();
    const card = await (await app.request("/.well-known/agent-card.json")).json() as Record<string, string>;
    // Relative-ise the advertised absolute URLs and check each one answers.
    for (const field of ["documentationUrl", "iconUrl"]) {
      const path = new URL(card[field]).pathname;
      expect((await app.request(path)).status, `${field} → ${path}`).toBe(200);
    }
  });

  it("claims no transport, because it implements none of A2A's", () => {
    const card = agentCard(FACTS) as Record<string, unknown>;
    expect(card.url).toBeUndefined();
    expect(card.preferredTransport).toBeUndefined();
    expect(card.additionalInterfaces).toBeUndefined();
    // The three tempting wrong answers, none of which this server can honour.
    const json = JSON.stringify(card);
    for (const claim of ["JSONRPC", "HTTP+JSON", "preferredTransport"]) {
      expect(json, `card must not claim ${claim}`).not.toContain(claim);
    }
    // /agent.md is where a caller is sent for the interface that does exist.
    expect(card.documentationUrl).toBe("https://iomarkets.app/agent.md");
  });

  it("declares x402 as a required capability, with the paid route named", () => {
    const card = agentCard(FACTS) as { capabilities: { extensions: Array<Record<string, unknown>> } };
    const x402 = card.capabilities.extensions.find((e) => e.uri === "https://x402.org");
    expect(x402).toBeDefined();
    expect(x402!.required).toBe(true);
    const params = x402!.params as Record<string, unknown>;
    expect(params.paidRoutes).toEqual(["https://iomarkets.app/v1/orders"]);
    expect(params.payTo).toBe("PAYTOADDRESS");
    expect(params.network).toBe("mainnet");
  });

  // Nothing here is behind a credential — it is behind a payment. A router that reads
  // an empty securitySchemes knows it needs no onboarding, which is the pitch.
  it("asks for no credential", () => {
    const card = agentCard(FACTS);
    expect(card.securitySchemes).toEqual({});
    expect(card.security).toEqual([]);
  });

  it("keeps one version number across the card and server.json", () => {
    const published = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVICE_VERSION).toBe(published.version);
    expect(agentCard(FACTS).version).toBe(published.version);
  });
});

describe("the card sells only what a supplier can fill", () => {
  const ids = (products: readonly string[]) =>
    (agentCard({ ...FACTS, products: products as never }) as { skills: Array<{ id: string }> }).skills.map((s) => s.id);

  it("drops the payout skill when no payout partner is wired", () => {
    const skills = ids(["topup", "esim"]);
    expect(skills).toContain("buy-airtime");
    expect(skills).toContain("buy-esim");
    expect(skills).not.toContain("send-payment");
    expect(skills).not.toContain("pay-bill");
    // …and nothing in the prose reinstates it.
    const card = JSON.stringify(agentCard({ ...FACTS, products: ["topup", "esim"] }));
    expect(card).not.toContain("international payment");
  });

  it("offers a pay link only while something linkable is on sale", () => {
    expect(ids(["esim"])).toContain("create-pay-link");
    // Payouts cannot be sold through a link — POST /v1/links takes topup|esim only.
    expect(ids(["payout"])).not.toContain("create-pay-link");
  });

  it("still verifies receipts when the whole catalogue is dark", () => {
    // Receipt verification reads a signature and a chain, not stock, so it survives a
    // service with no supplier at all — and the description must not claim otherwise.
    const card = agentCard({ ...FACTS, products: [] });
    expect((card as { skills: Array<{ id: string }> }).skills.map((s) => s.id)).toEqual(["verify-receipt"]);
    expect(card.description).toContain("no supplier is wired right now");
  });

  it("names each live product in the description", () => {
    expect(agentCard({ ...FACTS, products: ["esim"] }).description).toContain("travel eSIMs");
    expect(agentCard({ ...FACTS, products: ["topup", "payout"] }).description)
      .toContain("mobile airtime and data top-ups and international payments");
  });
});

describe("robots.txt points at the card", () => {
  it("names it next to the agent docs", async () => {
    const txt = await (await build().request("/robots.txt")).text();
    expect(txt).toMatch(/^# Agent card: \S+\/\.well-known\/agent-card\.json$/m);
  });
});
