import { describe, expect, it } from "vitest";
import { ceilCent, sellPriceMicro, toPriceString, floorInflatesPrice, naturalPriceMicro, minSellableCostMicro, pricingFor } from "../src/money.js";
import { parseMarkupByType, config } from "../src/config.js";

const P = { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 };

describe("pricing", () => {
  it("adds markup + fixed fee and rounds up to the cent", () => {
    // cost $3.65 → 3.65*1.04 = 3.796 + 0.05 = 3.846 → $3.85
    expect(sellPriceMicro(3_650_000, P)).toBe(3_850_000);
  });
  it("never goes below the floor", () => {
    expect(sellPriceMicro(10_000, P)).toBe(500_000);
  });
  it("never goes below cost", () => {
    for (const c of [1, 999_999, 12_345_678]) expect(sellPriceMicro(c, P)).toBeGreaterThanOrEqual(c);
  });
  it("ceilCent + price string", () => {
    expect(ceilCent(1_234_567)).toBe(1_240_000);
    expect(toPriceString(3_850_000)).toBe("$3.85");
  });
  it("rejects bad cost", () => {
    expect(() => sellPriceMicro(-1, P)).toThrow();
    expect(() => sellPriceMicro(NaN, P)).toThrow();
  });
});

// Measured on production 2026-09-01: 38 of 145 Nigerian offers were priced at the $0.50
// floor rather than by the markup. The worst delivered 49.91 NGN — about $0.036 — for
// $0.50, a 13.7x markup, on an offer that prints the local amount beside the price. That
// is the gift-card lesson again: a visible face value makes a markup indefensible.
describe("the order floor must not become the price", () => {
  const P = { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 };

  it("refuses the real offender: 49.91 NGN of airtime costing ~$0.036", () => {
    expect(floorInflatesPrice(36_000, P)).toBe(true);
    // What it would have been sold for, and what it is actually worth.
    expect(sellPriceMicro(36_000, P)).toBe(500_000); // $0.50
    expect(naturalPriceMicro(36_000, P)).toBe(90_000); // $0.09
  });

  it("refuses the cheapest offer in the live catalogue (~$0.073)", () => {
    expect(floorInflatesPrice(73_000, P)).toBe(true);
    expect(naturalPriceMicro(73_000, P)).toBe(130_000); // $0.13 vs a $0.50 floor
  });

  it("allows one the floor merely nudges, rather than prices", () => {
    // $0.35 cost -> $0.42 natural; the floor lifts it to $0.50, which is defensible.
    expect(floorInflatesPrice(350_000, P)).toBe(false);
    expect(sellPriceMicro(350_000, P)).toBe(500_000);
  });

  it("leaves every normal order untouched", () => {
    for (const cost of [1_000_000, 3_000_000, 8_000_000, 150_000_000]) {
      expect(floorInflatesPrice(cost, P)).toBe(false);
      expect(sellPriceMicro(cost, P)).toBe(naturalPriceMicro(cost, P));
    }
  });

  it("names the smallest cost it can price honestly, for the refusal message", () => {
    const min = minSellableCostMicro(P);
    expect(floorInflatesPrice(min, P)).toBe(false);
    expect(floorInflatesPrice(min - 1, P)).toBe(true);
  });

  it("honours a configured tolerance rather than hard-coding 2x", () => {
    // Stricter: the floor may not inflate a price at all.
    expect(floorInflatesPrice(350_000, { ...P, maxFloorMultiple: 1 })).toBe(true);
    // Looser: tolerate up to 10x, and the 13.7x offender is still refused.
    expect(floorInflatesPrice(350_000, { ...P, maxFloorMultiple: 10 })).toBe(false);
    expect(floorInflatesPrice(36_000, { ...P, maxFloorMultiple: 10 })).toBe(false);
  });
});

// Per-type markup. `MARKUP_BPS=400` was set when airtime was the only product; an eSIM
// carries an $8-30 ticket with no face value a buyer can price it against, and the
// research called for 600-800 bps on that type specifically (docs/REVENUE-SOURCES.md §A4).
describe("per-type markup", () => {
  const PT = { ...P, markupBpsByType: { esim: 700 } };

  it("prices an eSIM at its own markup and airtime at the global one", () => {
    // $10.00 cost: eSIM 10*1.07 + 0.05 = $10.75; airtime 10*1.04 + 0.05 = $10.45
    expect(sellPriceMicro(10_000_000, pricingFor(PT, "esim"))).toBe(10_750_000);
    expect(sellPriceMicro(10_000_000, pricingFor(PT, "topup"))).toBe(10_450_000);
  });

  it("falls back to the global markup for a type with no override, and for no type", () => {
    expect(pricingFor(PT, "payout").markupBps).toBe(400);
    expect(pricingFor(PT).markupBps).toBe(400);
    expect(pricingFor(PT, "bill")).toBe(PT); // same object: nothing to override
  });

  it("changes nothing when no overrides are configured — the shipped behaviour", () => {
    expect(pricingFor(P, "esim")).toBe(P);
    expect(sellPriceMicro(10_000_000, pricingFor(P, "esim"))).toBe(10_450_000);
  });

  it("moves the floor-inflation boundary with the markup, so a refusal and its advice agree", () => {
    // A higher markup reaches the floor's natural price on a smaller cost, so fewer
    // offers are refused — and minSellableCostMicro must move with it, or quote() would
    // refuse an offer while telling the buyer to ask for an amount it still refuses.
    const lowMin = minSellableCostMicro(pricingFor(PT, "esim"));
    const highMin = minSellableCostMicro(pricingFor(PT, "topup"));
    expect(lowMin).toBeLessThan(highMin);
    expect(floorInflatesPrice(lowMin, pricingFor(PT, "esim"))).toBe(false);
  });
});

describe("MAX_FLOOR_MULTIPLE is a knob that turns", () => {
  // It was documented as a production decision for two sessions and was wired to
  // nothing: floorInflatesPrice() read an optional field no config ever set, so 2 was
  // the only value the service could have. Found by setting it in production and
  // watching the catalogue not change.
  it("is read from the environment, not hard-coded", () => {
    expect(config.pricing.maxFloorMultiple).toBeTypeOf("number");
  });

  it("at 1, refuses anything the floor would price at all", () => {
    // $0.30 cost at 1500 bps → natural $0.40, floor $0.50. The floor is doing the pricing.
    const p = { markupBps: 1500, fixedFeeUsd: 0.05, minOrderUsd: 0.5 };
    expect(floorInflatesPrice(300_000, { ...p, maxFloorMultiple: 2 })).toBe(false);
    expect(floorInflatesPrice(300_000, { ...p, maxFloorMultiple: 1 })).toBe(true);
    // …and one whose natural price clears the floor is sellable under both.
    expect(floorInflatesPrice(400_000, { ...p, maxFloorMultiple: 1 })).toBe(false);
  });
});

describe("MARKUP_BPS_BY_TYPE parsing", () => {
  it("reads one or more type=bps pairs", () => {
    expect(parseMarkupByType("esim=700")).toEqual({ esim: 700 });
    expect(parseMarkupByType(" esim=700 , payout=300 ")).toEqual({ esim: 700, payout: 300 });
    expect(parseMarkupByType("")).toEqual({});
  });

  it("refuses a typo at boot rather than selling at the wrong margin for a week", () => {
    expect(() => parseMarkupByType("esmi=700")).toThrow(/not one of/);
    expect(() => parseMarkupByType("esim=7%")).toThrow(/0-10000 bps/);
    expect(() => parseMarkupByType("esim=-100")).toThrow();
    expect(() => parseMarkupByType("esim=20000")).toThrow();
    expect(() => parseMarkupByType("esim")).toThrow();
  });
});
