// Every HTML page carries the demonstration notice, first thing in <body>, and the /pay
// build carries the same words.
//
// The notice is a statement the owner makes about the service (src/demo-banner.ts). A
// page that renders without it, or a /pay bundle whose copy has drifted from the server's,
// is the failure this pins: it would look like nothing at all.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";
import { DEMO_BANNER_BODY, DEMO_BANNER_LEAD } from "../src/demo-banner.js";

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

describe("the demonstration notice", () => {
  it("says what the owner wrote, verbatim", () => {
    expect(DEMO_BANNER_LEAD).toBe("Demonstration only.");
    expect(DEMO_BANNER_BODY).toBe(
      "This is a technology demonstration that has been tested on real data with real money in a limited pilot. " +
      "It is not offered as a commercial service until the required licences, penetration testing and security audits are complete.",
    );
  });

  // Every route that answers with a document, including the 404 variants of the growth pages.
  const pages = ["/", "/fund", "/verify", "/console", "/earn", "/l/nope", "/p/NOPE"];
  for (const path of pages) {
    it(`${path} opens its <body> with it`, async () => {
      const res = await build().request(path);
      expect(res.headers.get("content-type") ?? "", path).toMatch(/text\/html/);
      const body = (await res.text()).split(/<body[^>]*>/)[1] ?? "";
      expect(body.trimStart().startsWith('<style>.iom-demo'), path).toBe(true);
      expect(body).toContain(`<b>${DEMO_BANNER_LEAD}</b> ${DEMO_BANNER_BODY}`);
    });
  }

  it("the /pay build carries the same words", () => {
    const tsx = readFileSync(new URL("../web/src/components/io/DemoBanner.tsx", import.meta.url), "utf8");
    expect(tsx).toContain(JSON.stringify(DEMO_BANNER_LEAD));
    expect(tsx).toContain(JSON.stringify(DEMO_BANNER_BODY));
    const root = readFileSync(new URL("../web/src/routes/__root.tsx", import.meta.url), "utf8");
    expect(root).toMatch(/<body>\s*<DemoBanner \/>/);
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
