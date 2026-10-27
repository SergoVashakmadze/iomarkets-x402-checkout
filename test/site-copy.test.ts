// What the served pages say about the service.
//
// The pilot notice that opened every page (src/demo-banner.ts) was removed at the owner's
// request on 2026-10-27. The first test pins that it stays gone everywhere, including the
// /pay build; the others pin the owner's 2026-09-30 wording rules, which still apply.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";

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

describe("site copy", () => {
  const pages = ["/", "/fund", "/verify", "/console", "/earn", "/l/nope", "/p/NOPE"];
  for (const path of pages) {
    it(`${path} carries no pilot notice`, async () => {
      const res = await build().request(path);
      expect(res.headers.get("content-type") ?? "", path).toMatch(/text\/html/);
      const html = await res.text();
      expect(html, path).not.toContain("iom-demo");
      expect(html, path).not.toContain("Demonstration only.");
    });
  }

  it("the /pay build carries no pilot notice", () => {
    const root = readFileSync(new URL("../web/src/routes/__root.tsx", import.meta.url), "utf8");
    expect(root).not.toContain("DemoBanner");
  });

  it("no page still says the service simply went live", async () => {
    const html = await (await build().request("/")).text();
    expect(html).not.toContain("went live on mainnet");
    expect(html).toContain("tested on mainnet with real data and real money since late August 2026");
  });

  // Owner, 2026-09-30: neutral wording, no coverage or performance figures as marketing.
  // Technical limits an agent must know (per-order caps, the quote lock) stay in /agent.md.
  it("no page or agent-facing text markets coverage counts", async () => {
    const app = build();
    for (const path of ["/", "/agent.md", "/llms.txt", "/.well-known/agent-card.json", "/earn"]) {
      const text = await (await app.request(path)).text();
      expect(text, path).not.toMatch(/\b\d{2,3}\+/);
      expect(text, path).not.toMatch(/~3 ?s\b/);
    }
  });
});
