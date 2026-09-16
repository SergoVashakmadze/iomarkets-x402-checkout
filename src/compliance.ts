// Compliance gate for international payments. We are not the licensed party —
// the payout partner is — but we refuse anything the partner would refuse, before
// the payer spends a signature: sanctioned destinations, per-payout ceiling, a
// sender record on every payout, and a partner KYC reference once a payer's
// daily payout total crosses the threshold — which an onboarded business account's
// KYB reference also satisfies. Pure function; unit-tested.

export interface PayoutCheckInput {
  country: string;
  priceMicro: number;
  payerPayoutsTodayMicro: number;
  sender?: { name?: string; country?: string; reference?: string };
  blockedCountries: string[];
  /** Effective per-payment ceiling — the account's, when the payer speaks for one. */
  maxUsd: number;
  kycAboveUsd: number;
  /** Set when the payer is bound to a KYB'd business account (src/accounts.ts).
   *  Its KYB reference satisfies the same threshold a per-payer KYC reference does:
   *  the point of the gate is that SOMEONE verified identity, and for a business
   *  account that happened once at onboarding rather than per payment. */
  account?: { id: string; kybReference: string };
  /** Total already sent TO this recipient today, across every payer. */
  recipientPayoutsTodayMicro?: number;
  recipientDailyMaxUsd?: number;
}

export function checkPayout(i: PayoutCheckInput): { ok: true } | { ok: false; reason: string; status: 400 | 403 } {
  const M = 1_000_000;
  if (i.blockedCountries.includes(i.country)) return { ok: false, reason: "destination not supported", status: 403 };
  if (!i.sender?.name || !i.sender?.country) return { ok: false, reason: "sender { name, country } is required for international payments", status: 400 };
  if (i.blockedCountries.includes(i.sender.country.toUpperCase())) return { ok: false, reason: "sender country not supported", status: 403 };
  if (i.priceMicro > i.maxUsd * M) return { ok: false, reason: `payout exceeds the per-payment limit of $${i.maxUsd}`, status: 400 };
  // Above the threshold, identity has to have been verified by SOMEONE we can name.
  //
  // `sender.reference` is a free-form string in an unauthenticated request body. It
  // used to satisfy this gate on its own, which meant the gate did nothing: quote with
  // reference "x", pay from a fresh address, repeat — unlimited unverified
  // international payouts in $200 slices, each one carrying a signed receipt. Nothing
  // in this codebase has ever validated that string against a partner's KYC system.
  //
  // So only an onboarded business account's KYB reference counts now. That is what the
  // account tier is FOR: above $100/day you are a counterparty we have KYB'd, not a
  // stranger who typed a plausible id. A caller-supplied reference is still stored and
  // still forwarded to the partner — it is useful data — it just proves nothing.
  if (i.payerPayoutsTodayMicro + i.priceMicro > i.kycAboveUsd * M && !i.account?.kybReference) {
    return { ok: false, reason: `payouts above $${i.kycAboveUsd}/day require an onboarded business account — a sender.reference in the request is not a verified identity`, status: 403 };
  }
  // Structuring guard: a payer address is free to create, so a per-payer daily total
  // resets with a new wallet. The RECIPIENT does not change when the sender rotates.
  if (i.recipientPayoutsTodayMicro !== undefined && i.recipientPayoutsTodayMicro + i.priceMicro > i.recipientDailyMaxUsd! * M) {
    return { ok: false, reason: `this recipient has reached the $${i.recipientDailyMaxUsd}/day limit`, status: 403 };
  }
  return { ok: true };
}
