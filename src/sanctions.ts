// ⛔ SANCTIONED JURISDICTIONS — DO NOT REMOVE ANY CODE FROM THIS LIST, AND DO NOT
// ADD ROUTES, SUPPLIERS, CORRIDORS OR MARKETING FOR THEM, UNTIL FURTHER NOTICE FROM
// THE OWNER (instruction of 2026-09-16). This applies to people and to agents alike:
// no "just this corridor", no "the supplier supports it", no pitch deck mentioning it.
//
// The list is a FLOOR. `BLOCKED_COUNTRIES` in the environment can add to it and can
// never remove from it, so a stale .env on the box cannot quietly reopen Russia.
//
// Scope: every country with an active country-level sanctions programme under OFAC,
// the EU, the UK or the UN. Broader than the strict "comprehensive embargo" set on
// purpose: we are not the licensed party, and the cheapest compliance is not selling.
//
// Not expressible as an ISO code, and so NOT covered here: Crimea, Donetsk, Luhansk,
// Zaporizhzhia and Kherson (occupied regions of UA). Do not add region-level products
// for Ukraine without solving that first.
export const SANCTIONED_COUNTRIES: readonly string[] = [
  "RU", // Russia
  "BY", // Belarus
  "IR", // Iran
  "KP", // North Korea
  "SY", // Syria
  "CU", // Cuba
  "VE", // Venezuela
  "MM", // Myanmar
  "AF", // Afghanistan
  "IQ", // Iraq
  "LB", // Lebanon
  "LY", // Libya
  "YE", // Yemen
  "SO", // Somalia
  "SD", // Sudan
  "SS", // South Sudan
  "CF", // Central African Republic
  "CD", // DR Congo
  "ML", // Mali
  "GW", // Guinea-Bissau
  "ER", // Eritrea
  "NI", // Nicaragua
  "ZW", // Zimbabwe
  "HT", // Haiti
];

/** The sanctions floor plus whatever the environment adds. Never less than the floor. */
export function blockedCountryList(extra: string): string[] {
  const added = extra.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return [...new Set([...SANCTIONED_COUNTRIES, ...added])];
}

/**
 * True when an offer delivers into a blocked country — including a regional or global
 * bundle ("Africa", "Gulf", "Global 139") whose coverage list names one. Filtering on
 * `country` alone let those through, because a bundle's country is "WW".
 */
export function offerTouchesBlocked(offer: { country: string; regions?: string[] }, blocked: readonly string[]): boolean {
  if (blocked.includes(offer.country.toUpperCase())) return true;
  return (offer.regions ?? []).some((r) => blocked.includes(r.toUpperCase()));
}
