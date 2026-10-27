// Every response carries the baseline security headers (src/app.ts, 2026-10-27), and none
// of the cross-origin headers that would stop other sites loading the logo or break the
// wallet popups.
import { describe, expect, it } from "vitest";
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

describe("security headers", () => {
  for (const [method, path] of [["GET", "/"], ["GET", "/c/NOPE"], ["GET", "/health"], ["GET", "/v1/catalog?type=esim"], ["POST", "/v1/orders"]] as const) {
    it(`${method} ${path}`, async () => {
      const res = await build().request(path, { method });
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
      expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  }
});
