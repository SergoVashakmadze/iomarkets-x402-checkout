// USDC has 6 decimals. All arithmetic on money is done in integer micro-USDC;
// floats appear only at the edges (display, env parsing).
export const MICRO = 1_000_000;

export const toMicro = (usd: number): number => Math.round(usd * MICRO);
export const fromMicro = (micro: number): number => micro / MICRO;
/** "8.400000" — fixed 6dp string, safe to put in a signed payload. */
export const formatUsdc = (micro: number): string => (micro / MICRO).toFixed(6);
/** "$8.40" — the Money form the x402 SDK parses into the default asset amount. */
export const toPriceString = (micro: number): string => `$${(micro / MICRO).toFixed(2)}`;
/** Round UP to a whole cent (10,000 micro). */
export const ceilCent = (micro: number): number => Math.ceil(micro / 10_000) * 10_000;

export interface PricingParams {
  markupBps: number;
  fixedFeeUsd: number;
  minOrderUsd: number;
  /** How far MIN_ORDER_USD may inflate a price before the offer is unsellable. See
   *  floorInflatesPrice(). Default 2 — the floor may double a price, not multiply it. */
  maxFloorMultiple?: number;
  /** Per-product-type markup, overriding `markupBps` for that type only.
   *  `MARKUP_BPS_BY_TYPE="esim=700"`. See pricingFor(). */
  markupBpsByType?: Readonly<Record<string, number>>;
}

/**
 * The pricing to use for ONE product type.
 *
 * `MARKUP_BPS=400` was a guess made when the only product was airtime, and airtime
 * resale margins genuinely are thin — a buyer can price a top-up against the operator's
 * own app in seconds, and a visible markup on a stated face value is exactly the trap
 * that killed gift cards (docs/SUPPLIERS.md) and that `floorInflatesPrice()` exists to
 * refuse. **eSIMs are not that product.** There is no face value printed on the offer, no
 * local-currency amount to divide by, and no way to price a USDC-denominated travel data
 * plan against anything without shopping the whole market — so the same 400 bps that is
 * honest on airtime is simply money left on the table on a $8–30 eSIM ticket, where the
 * research called for 600–800 bps (docs/REVENUE-SOURCES.md §A4).
 *
 * One markup for four products was never a pricing decision; it was the absence of one.
 * The mechanism is deliberately per TYPE and not per offer or per country: a rule a buyer
 * could discover and describe in one sentence stays defensible, and a per-offer markup is
 * how a catalogue quietly becomes untrustworthy.
 *
 * Unset for a type means the global `markupBps`, which is the behaviour that existed
 * before this function and remains the default for all four types.
 */
export function pricingFor(p: PricingParams, type?: string): PricingParams {
  const override = type ? p.markupBpsByType?.[type] : undefined;
  return override === undefined || override === p.markupBps ? p : { ...p, markupBps: override };
}

/** What we would charge if MIN_ORDER_USD did not exist: cost + markup + fee, to the cent. */
export function naturalPriceMicro(costMicro: number, p: PricingParams): number {
  if (!Number.isFinite(costMicro) || costMicro < 0) throw new Error("bad cost");
  return ceilCent(costMicro + Math.ceil((costMicro * p.markupBps) / 10_000) + toMicro(p.fixedFeeUsd));
}

/** Supplier cost → what the payer is charged. Never below cost, never below the floor. */
export function sellPriceMicro(costMicro: number, p: PricingParams): number {
  return Math.max(naturalPriceMicro(costMicro, p), toMicro(p.minOrderUsd));
}

/**
 * Is `MIN_ORDER_USD` doing the pricing instead of the markup?
 *
 * Measured on production 2026-09-01: **38 of 145 Nigerian offers** priced at the $0.50
 * floor. The worst delivered **49.91 NGN — about $0.036 — for $0.50**, a 13.7× markup, on
 * an offer that prints the local amount next to the price. `GET /v1/fx` publishes the rate,
 * so any buyer can do that arithmetic in two lines.
 *
 * This is precisely why gift cards were refused (docs/SUPPLIERS.md): *a gift card's price
 * IS its face value, and any markup is visible.* Airtime works as a product because a buyer
 * cannot easily price the alternative in USDC — but a **fixed** bundle stating "99.93 NGN"
 * removes exactly that. And it was the cheapest offer in the catalogue, so it is the first
 * thing anyone sorting by price sees.
 *
 * The floor itself is right: below ~$0.50 a refund costs more than the order. The error is
 * *selling into it*. So we do not sell what we cannot price honestly, which is the same
 * rule already applied to deprecated products and unwired suppliers.
 */
export function floorInflatesPrice(costMicro: number, p: PricingParams): boolean {
  const natural = naturalPriceMicro(costMicro, p);
  if (natural <= 0) return true;
  return toMicro(p.minOrderUsd) > natural * (p.maxFloorMultiple ?? 2);
}

/** The smallest supplier cost that can be sold without the floor inflating the price. */
export function minSellableCostMicro(p: PricingParams): number {
  let lo = 0, hi = toMicro(p.minOrderUsd) * 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (floorInflatesPrice(mid, p)) lo = mid + 1; else hi = mid;
  }
  return lo;
}
