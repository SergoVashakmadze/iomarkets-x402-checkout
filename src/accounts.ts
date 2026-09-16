// Business accounts — the tier that makes a partner possible.
//
// The default posture (MAX_ORDER_USD 50, PAYOUT_MAX_USD 200, PAYER_DAILY_USD 200)
// is an abuse posture for anonymous agents, and it is the right default. It is also
// the reason a counterparty funding $10k stops on their third payout of the first
// morning. A business account raises those ceilings for ONE onboarded counterparty,
// against a KYB record we hold, and leaves the default untouched for everyone else.
//
// Two design decisions worth keeping:
//
//  1. **Accounts bind to Algorand ADDRESSES, not to a field in the request body.**
//     `sender.reference` is an unauthenticated claim — anyone could paste a partner's
//     reference and inherit their ceilings. A payer address is proven by the settlement
//     signature. So the address is the identity, and the quote-time `payer` hint is
//     re-checked against the real settled payer before any money moves (src/app.ts).
//
//  2. **A ceiling is a promise the refund float has to stand behind.** Raising a limit
//     above what we can refund means accepting an order we cannot make good on, which
//     is the one thing this product must never do. `checkAccountCeilings` in
//     src/preflight.ts fails the production gate on it, and `pnpm account` refuses to
//     write it without --force.

/** A KYB'd counterparty. NULL limits mean "use the global default". */
export interface AccountRow {
  id: string;
  name: string;
  /** ISO-3166 alpha-2 of the business itself — the sender country on its payouts. */
  country: string;
  /** The KYB record this tier rests on: the partner's reference, or our own file id. */
  kyb_reference: string;
  status: "active" | "suspended";
  max_order_micro: number | null;
  payout_max_micro: number | null;
  daily_micro: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LimitDefaults {
  maxOrderMicro: number;
  payoutMaxMicro: number;
  dailyMicro: number;
  /** Per-product-type per-order caps, micro-USD, keyed by ProductType. See ceilingMicro. */
  typeMaxMicro?: Record<string, number>;
}

export interface Limits {
  tier: "standard" | "business";
  accountId?: string;
  maxOrderMicro: number;
  payoutMaxMicro: number;
  dailyMicro: number;
  typeMaxMicro?: Record<string, number>;
  /** True when a business account has a per-order ceiling set by hand, not inherited. */
  explicitMaxOrder?: boolean;
  /** Set only for a business account: satisfies the payout KYC-reference threshold. */
  kybReference?: string;
  /** Set only for a business account: the sender a payout is from, when the caller omits it. */
  senderDefaults?: { name: string; country: string };
  /** Populated when the account is suspended — the caller must refuse, not downgrade. */
  blocked?: string;
}

/**
 * Effective limits for a payer. An unknown or absent payer gets the standard tier,
 * which is exactly the behaviour before business accounts existed.
 *
 * A suspended account is REFUSED rather than quietly dropped to the standard tier:
 * suspension is a decision someone made, and silently letting them keep trading at
 * $200/day would be a different decision made by accident.
 */
export function limitsFor(account: AccountRow | undefined, d: LimitDefaults): Limits {
  const standard: Limits = {
    tier: "standard",
    maxOrderMicro: d.maxOrderMicro,
    payoutMaxMicro: d.payoutMaxMicro,
    dailyMicro: d.dailyMicro,
    typeMaxMicro: d.typeMaxMicro,
  };
  if (!account) return standard;
  if (account.status === "suspended") {
    return { ...standard, tier: "business", accountId: account.id, blocked: `account ${account.id} is suspended` };
  }
  return {
    tier: "business",
    accountId: account.id,
    // A null column means "inherit"; an explicit value may be higher OR lower than the
    // default, because a deliberately restricted account is a real thing to want.
    maxOrderMicro: account.max_order_micro ?? d.maxOrderMicro,
    payoutMaxMicro: account.payout_max_micro ?? d.payoutMaxMicro,
    dailyMicro: account.daily_micro ?? d.dailyMicro,
    typeMaxMicro: d.typeMaxMicro,
    explicitMaxOrder: account.max_order_micro !== null,
    kybReference: account.kyb_reference,
    senderDefaults: { name: account.name, country: account.country },
  };
}

/**
 * The ceiling that applies to one order, by product type.
 *
 * **Why a per-type cap exists on top of the per-payer one.** The risk a ceiling manages
 * is not uniform across the catalogue. An airtime top-up is delivered to one phone
 * number in one country and is worthless to anyone else; a payout has a named sender, a
 * recipient ceiling and a sanctions check in front of it. A **gift card is a bearer
 * instrument** — crypto in, redeemable code out is the standard laundering shape, and it
 * does not become safer because the buyer bought more of it. Capping the whole catalogue
 * at the gift-card number would cripple the products that carry the volume; capping
 * nothing at the product level means the safest ceiling we can set is the one the
 * riskiest product needs.
 *
 * So the cap binds the standard (anonymous, unverified) tier absolutely. A **business
 * account whose per-order ceiling was set by hand overrides it** — that account went
 * through KYB, and the raise is a decision with a name and a reference attached, which
 * is exactly the circumstance in which a higher gift-card ceiling is reasonable. An
 * account that merely *inherits* the default does not override it: inheriting is not
 * deciding.
 */
export function ceilingMicro(limits: Limits, type: string): number {
  const base = type === "payout" ? limits.payoutMaxMicro : limits.maxOrderMicro;
  const cap = limits.typeMaxMicro?.[type];
  if (cap === undefined) return base;
  if (limits.tier === "business" && limits.explicitMaxOrder) return base;
  return Math.min(base, cap);
}

/** Micro-USD as a human ceiling: "$200", "$12.50" — the form a refusal should say. */
export function usd(micro: number): string {
  const v = micro / 1_000_000;
  return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

export const ACCOUNT_ID_RE = /^acct_[0-9a-f]{12}$/;
