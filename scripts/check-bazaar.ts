// Is our paid route listed in the facilitator's Bazaar, AND does its entry carry the
// tag the challenge requires? Listing happens automatically on the first SETTLED
// payment through the facilitator, keyed by the advertised resource URL
// (PUBLIC_BASE_URL + /v1/orders).
//
//   PUBLIC_BASE_URL=https://iomarkets.app pnpm check-bazaar
//
// The tag check is not decoration. The challenge's own readiness checklist requires the
// endpoint to "appear in the Bazaar catalog with the x402-global-challenge tag" — an
// ELIGIBILITY condition, not a nicety. We declare that tag in src/app.ts, but declaring
// is not the same as the facilitator storing and echoing it, and the difference is
// invisible from our side. That is the Zendit-GBP lesson applied to the leaderboard:
// ask the question of the system that actually decides, before it matters.
import { config } from "../src/config.js";

const REQUIRED_TAG = "x402-global-challenge";

const base = config.publicBaseUrl || process.argv[2];
if (!base) throw new Error("set PUBLIC_BASE_URL or pass the base URL");
const want = `${base}${config.apiPrefix}/orders`;
let found: Record<string, unknown> | undefined;
for (let offset = 0; offset < 20_000 && !found; offset += 500) {
  const r = await fetch(`${config.facilitatorUrl}/discovery/resources?limit=500&offset=${offset}`);
  const d = (await r.json()) as { items: Array<Record<string, unknown>> };
  if (!d.items?.length) break;
  found = d.items.find((i) => i.resourceUrl === want);
  if (d.items.length < 500) break;
}
if (!found) {
  console.log(`❌ ${want} is NOT in the Bazaar yet. Make one real settled payment to it (pnpm buy …), then re-run.`);
  process.exit(1);
}
console.log(`✅ listed: ${found.resourceUrl}`);
console.log(`   settles: ${found.settleCount}  first: ${found.firstSeen}  last: ${found.lastSeen}`);
console.log(`   description: ${String(found.description).slice(0, 120)}…`);
const info = found.discoveryInfo as Record<string, unknown> | undefined;
console.log(`   discoveryInfo: ${info ? Object.keys(info).join(", ") : "(none — check bodyType/input declaration)"}`);

// WHERE the tag lives, confirmed against our own live listing 2026-08-29: the Bazaar
// stores it at `accepts[].extra.tag` — a single string inside the payment requirements
// — and keeps NO resource-level `tags` array at all, even though we send one. An
// earlier version of this script looked only at `tags`/`discoveryInfo.tags` and so
// reported a correctly-tagged listing as untagged. Read the real location first and
// keep the others as fallbacks, in case the facilitator ever flattens it differently.
const tagsOf = (o: unknown): string[] => (Array.isArray(o) ? o.filter((t): t is string => typeof t === "string") : []);
const accepts = Array.isArray(found.accepts) ? (found.accepts as Array<{ extra?: { tag?: unknown } }>) : [];
const acceptTags = accepts.map((a) => a.extra?.tag).filter((t): t is string => typeof t === "string" && t !== "");
const tags = [...new Set([...acceptTags, ...tagsOf(found.tags), ...tagsOf(info?.tags)])];
console.log(`   tags: ${tags.length ? tags.join(", ") : "(none recorded)"}`);
console.log(`   leaderboard: ${config.facilitatorUrl}/dashboard/leaderboards`);

if (!tags.includes(REQUIRED_TAG)) {
  console.error(
    `\n⛔ The Bazaar entry does NOT carry the "${REQUIRED_TAG}" tag.\n` +
    `   The challenge's readiness checklist requires it, so this is an eligibility problem, not a cosmetic one.\n` +
    `   We declare it at accepts[].extra.tag (src/app.ts), which is where the Bazaar reads it. If it is\n` +
    `   missing here, the listing predates the fix: the entry keeps the accepts it was FIRST listed with,\n` +
    `   so re-advertising alone may not refresh it. Settle one payment and re-run; if it is still absent,\n` +
    `   ask in the Algorand Discord BEFORE the submission window rather than during judging.\n` +
    `   Recorded on this entry: ${tags.length ? tags.join(", ") : "no tags at all"}.`,
  );
  process.exit(1);
}
console.log(`\n✅ tagged "${REQUIRED_TAG}" — the challenge's Bazaar requirement is met.`);
