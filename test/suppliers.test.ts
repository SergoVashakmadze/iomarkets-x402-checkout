// CompositeSupplier routes each product type to the supplier that can fulfil it.
// Bills got their own slot when Reloadly Utilities landed: Reloadly's OAuth audience
// names a PRODUCT as well as an environment, so utilities needs a different token from
// airtime even on the same credentials — it cannot just be the goods supplier.
import { describe, expect, it } from "vitest";
import { CompositeSupplier } from "../src/suppliers/composite.js";
import { MockSupplier } from "../src/suppliers/mock.js";
import { ReloadlySupplier } from "../src/suppliers/reloadly.js";
import { productList } from "../src/landing.js";
import { RELOADLY_UTILITIES_DEPRECATION, assertReloadlyUtilitiesAllowed } from "../src/suppliers/reloadly-utilities.js";
import { SupplierError, type Offer, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "../src/suppliers/types.js";

function tagged(name: string): Supplier & { seen: string[] } {
  const seen: string[] = [];
  return {
    name, seen,
    async lookupPhone(msisdn) { seen.push("lookupPhone"); return { msisdn, country: null }; },
    async listOffers(q) { seen.push(`list:${q.type}`); return [{ id: `${name}-1`, type: q.type, country: "NG", brand: "b", brandName: "B", name: "n", priceType: "fixed", costMicro: 1 } as Offer]; },
    async getOffer(type: ProductType, id: string) { seen.push(`get:${type}`); return { id, type, country: "NG", brand: "b", brandName: "B", name: "n", priceType: "fixed", costMicro: 1 } as Offer; },
    async purchase(req: PurchaseRequest) { seen.push(`buy:${req.type}`); return { supplierTxId: name, status: "delivered" } as PurchaseResult; },
    async getPurchase(type: ProductType) { seen.push(`poll:${type}`); return { supplierTxId: name, status: "delivered" } as PurchaseResult; },
    async balanceMicro() { seen.push("balance"); return 1; },
  };
}

describe("product-type routing", () => {
  it("sends bills to the bill supplier, not to goods", async () => {
    const goods = tagged("goods"), payouts = tagged("payouts"), bills = tagged("bills");
    const c = new CompositeSupplier(goods, payouts, bills);
    await c.listOffers({ type: "bill", country: "NG" });
    await c.getOffer("bill", "rlu-3");
    await c.purchase({ orderId: "o", type: "bill", offerId: "rlu-3", recipient: { fields: { account_number: "1" } }, costMicro: 1 });
    await c.getPurchase("bill", "1");
    expect(bills.seen).toEqual(["list:bill", "get:bill", "buy:bill", "poll:bill"]);
    expect(goods.seen).toEqual([]);
    expect(payouts.seen).toEqual([]);
  });

  it("still sends topups and esims to goods, and payouts to the partner", async () => {
    const goods = tagged("goods"), payouts = tagged("payouts"), bills = tagged("bills");
    const c = new CompositeSupplier(goods, payouts, bills);
    await c.listOffers({ type: "topup", country: "NG" });
    await c.listOffers({ type: "esim" });
    await c.listOffers({ type: "payout", country: "NG" });
    expect(goods.seen).toEqual(["list:topup", "list:esim"]);
    expect(payouts.seen).toEqual(["list:payout"]);
    expect(bills.seen).toEqual([]);
  });

  it("hides bills entirely when no bill supplier is configured", async () => {
    // Same posture as payouts with PAYOUT_SUPPLIER unset: discovery returns nothing
    // rather than erroring, so an agent browsing the catalogue simply does not see it.
    const c = new CompositeSupplier(tagged("goods"), null, null);
    expect(await c.listOffers({ type: "bill", country: "NG" })).toEqual([]);
    expect(await c.getOffer("bill", "rlu-3")).toBeNull();
    // But an actual attempt to buy says why, rather than routing it to airtime.
    await expect(c.purchase({ orderId: "o", type: "bill", offerId: "x", recipient: {}, costMicro: 1 }))
      .rejects.toThrow(/BILL_SUPPLIER/);
  });

  it("names itself after the suppliers actually wired in", async () => {
    expect(new CompositeSupplier(tagged("reloadly"), tagged("bitnob"), tagged("reloadly-utilities")).name)
      .toBe("reloadly+bitnob+reloadly-utilities");
    expect(new CompositeSupplier(tagged("reloadly"), null, null).name).toBe("reloadly");
    // A mock standing in for every role should not be reported three times.
    const m = new MockSupplier();
    expect(new CompositeSupplier(m, m, m).name).toBe("mock");
  });

  it("reports the goods float as the balance, which is the one that gates delivery", async () => {
    const goods = tagged("goods"), bills = tagged("bills");
    await new CompositeSupplier(goods, null, bills).balanceMicro();
    expect(goods.seen).toContain("balance");
    expect(bills.seen).toEqual([]);
  });
});

describe("SupplierError", () => {
  it("carries retryability, which decides refund versus keep-trying", () => {
    expect(new SupplierError("x").retryable).toBe(false);
    expect(new SupplierError("x", true).retryable).toBe(true);
  });
});

describe("Reloadly Utilities deprecation guard", () => {
  // Reloadly Support, 2026-09-01: "the Utility Payments service is currently being
  // deprecated. Please refrain from using the service until further notice." The
  // adapter is complete and the repo's own notes said it was one live payment away
  // from being switched on, so the refusal has to live in code, not in a doc.
  it("refuses the deprecated supplier when it has not been acknowledged", () => {
    expect(() => assertReloadlyUtilitiesAllowed(false)).toThrow(/deprecated/i);
    // The error carries the supplier's own words and the way back, so whoever hits it
    // at boot does not have to go looking for the reason.
    expect(() => assertReloadlyUtilitiesAllowed(false)).toThrow(/ALLOW_DEPRECATED_BILL_SUPPLIER=1/);
  });

  it("allows it once acknowledged, so a reversal is one deliberate flag", () => {
    expect(() => assertReloadlyUtilitiesAllowed(true)).not.toThrow();
  });

  it("keeps the notice quotable and dated", () => {
    expect(RELOADLY_UTILITIES_DEPRECATION.noticedOn).toBe("2026-09-01");
    expect(RELOADLY_UTILITIES_DEPRECATION.quote).toMatch(/refrain from using the service/);
  });
});

describe("the service knows what it can actually sell", () => {
  // /agent.md, the landing page and the Bazaar description all advertised four product
  // types while exactly one was fulfillable: Reloadly sells airtime and nothing else on
  // the audience we hold, Utilities was deprecated by the vendor and gift cards were
  // dropped. Discovery was honest — /v1/catalog returns [] for a type nobody can fill —
  // but the prose was not, and the prose is what an agent and a judge read first.
  it("reports only the types a wired supplier declares", () => {
    const reloadly = new ReloadlySupplier("id", "secret", true);
    expect(new CompositeSupplier(reloadly, null, null).availableTypes()).toEqual(["topup"]);
    expect(new CompositeSupplier(reloadly, tagged("bitnob"), null).availableTypes()).toEqual(["topup", "payout"]);
  });

  it("hides payouts and bills whose slot is empty, whatever goods declares", () => {
    const m = new MockSupplier(); // declares all four
    expect(new CompositeSupplier(m, null, null).availableTypes()).toEqual(["topup", "esim"]);
    expect(new CompositeSupplier(m, m, m).availableTypes()).toEqual(["topup", "esim", "bill", "payout"]);
  });

  it("falls back to all four for a supplier that declares nothing, which is the old behaviour", () => {
    expect(new CompositeSupplier(tagged("legacy"), null, null).availableTypes()).toEqual(["topup", "esim"]);
  });

  it("renders prose from that list rather than from a hand-written sentence", () => {
    const f = { base: "b", network: "mainnet", pubkey: "", brand: "x", site: "s" };
    expect(productList({ ...f, products: ["topup"] })).toBe("mobile airtime & data top-ups");
    expect(productList({ ...f, products: ["topup", "esim"] })).toBe("mobile airtime & data top-ups and travel eSIMs");
    expect(productList({ ...f, products: [] })).toMatch(/no supplier is wired/);
  });
});

describe("which wallet fills which product", () => {
  // The float check must ask the right balance and net off only the orders drawing on
  // it. Keyed by object identity, not name: one Zendit account selling both airtime and
  // eSIMs is ONE float, while two adapters of the same vendor are two.
  it("gives each distinct supplier instance its own wallet", () => {
    const goods = tagged("mock"), payouts = tagged("mock"), esims = tagged("mock");
    const c = new CompositeSupplier(goods, payouts, null, esims);
    const ids = new Set([c.floatGroupFor("topup"), c.floatGroupFor("payout"), c.floatGroupFor("esim")]);
    // Same `name`, three wallets — a name collision must not merge two balances.
    expect(ids.size).toBe(3);
  });

  it("shares one wallet when one supplier fills two slots", () => {
    // Zendit sells airtime AND eSIMs off one balance; both must net against each other.
    const z = tagged("zendit");
    const c = new CompositeSupplier(z, null, null, z);
    expect(c.floatGroupFor("esim")).toBe(c.floatGroupFor("topup"));
  });

  it("routes eSIMs to their own slot, and to goods when none is wired", async () => {
    const goods = tagged("goods"), esims = tagged("esims");
    await new CompositeSupplier(goods, null, null, esims).listOffers({ type: "esim" });
    expect(esims.seen).toEqual(["list:esim"]);
    expect(goods.seen).toEqual([]);

    const g2 = tagged("goods");
    await new CompositeSupplier(g2, null, null, null).listOffers({ type: "esim" });
    expect(g2.seen).toEqual(["list:esim"]);
  });

  it("reads the balance of whichever wallet fills the type", async () => {
    const goods = tagged("goods"), payouts = tagged("payouts"), esims = tagged("esims");
    const c = new CompositeSupplier(goods, payouts, null, esims);
    await c.balanceMicroForType("esim");
    expect(esims.seen).toContain("balance");
    expect(goods.seen).toEqual([]);
    await c.balanceMicroForType("payout");
    expect(payouts.seen).toContain("balance");
  });

  it("reports null for a type with no supplier, which is not the same as zero", async () => {
    const c = new CompositeSupplier(tagged("goods"), null, null, null);
    expect(c.balanceMicroForType("payout")).toBeNull();
    expect(c.balanceMicroForType("bill")).toBeNull();
  });
});
