// Is the payout partner's account usable, and in the asset we settle in?
//
//   pnpm check-payout            # the payout partner named by PAYOUT_SUPPLIER, corridors for NG
//   pnpm check-payout KE         # …for Kenya instead
//
// Read-only: it authenticates, reads the float and the catalogue, and pays nobody.
// Nothing here quotes, initialises or finalises a payout, so no money can move.
//
// This is `check-supplier` for the OTHER half of the catalogue, and it exists for the
// same reason: Zendit authenticated perfectly, every field name was right, and the
// account was denominated in GBP — a fact only /balance revealed, after a week. Reloadly
// was GBP too, off the same UK registration. Bitnob holds a per-asset float, so the
// same question is "is there a USDC account at all", and `balanceMicro()` answers it by
// refusing when there is not.
//
// The second thing it does is make a failure REPORTABLE. Bitnob keys are IP-whitelisted
// and its errors carry a correlation_id; a support ticket that names the endpoint, the
// status, the correlation id and the IP the call actually left from gets fixed, and one
// that says "it doesn't work" does not. Every failure prints that block, and none of it
// contains the secret.

import { config } from "../src/config.js";
import { BitnobPayoutSupplier } from "../src/suppliers/bitnob.js";
import type { Offer } from "../src/suppliers/types.js";

const country = (process.argv[2] ?? "NG").toUpperCase();
const M = 1_000_000;

/** The address the partner actually sees — which is the one that has to be whitelisted.
 *  A box's inbound A record is not proof of its egress, and a residential connection's
 *  address changes without warning; both failures look exactly like a bad key. */
async function egressIp(): Promise<string> {
  return await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5_000) })
    .then((r) => r.text())
    .then((s) => s.trim())
    .catch(() => "unknown (could not reach api.ipify.org)");
}

/** Everything Bitnob support needs to act, and nothing they must not see. */
async function supportBlock(err: unknown): Promise<string> {
  const p = config.payout;
  const clientId = p.clientId ? `${p.clientId.slice(0, 8)}… (${p.clientId.length} chars)` : "NOT SET";
  return [
    ``,
    `── Send this to ${p.kind} support ─────────────────────────────────────────────`,
    `  when            ${new Date().toISOString()}`,
    `  base URL        ${p.baseUrl || "https://api.bitnob.com (adapter default)"}`,
    `  client id       ${clientId}`,
    `  calling from    ${await egressIp()}   ← this address must be on the key's IP whitelist`,
    `  asset requested ${p.asset}`,
    `  error           ${(err as Error).message}`,
    `────────────────────────────────────────────────────────────────────────────`,
    ``,
    `  A 401 with a correct secret is almost always the IP whitelist: the key allows the`,
    `  address you created it from, and this call left from the address above. Add that`,
    `  one, or create the key with no whitelist while testing.`,
  ].join("\n");
}

function describe(o: Offer): string {
  const range = `${o.sendMin}–${o.sendMax} ${o.sendCurrency}`;
  const usd = (n: number | undefined): string => (n === undefined ? "?" : `$${(n / M).toFixed(2)}`);
  const cost = `${usd(o.costMinMicro)}–${usd(o.costMaxMicro)}`;
  const fields = o.requiredFields?.length ? o.requiredFields.join(", ") : "⚠️  none published";
  return `  ${o.id.padEnd(22)} ${range.padEnd(26)} ${cost.padEnd(18)} ${fields}`;
}

async function main(): Promise<void> {
  const p = config.payout;
  if (p.kind === "") {
    console.log("PAYOUT_SUPPLIER is empty — payouts are disabled and there is nothing to check.");
    process.exit(0);
  }
  if (p.kind === "mock") {
    console.log("PAYOUT_SUPPLIER=mock — demo corridors, no partner to check. Set PAYOUT_SUPPLIER=bitnob first.");
    process.exit(0);
  }
  if (p.kind !== "bitnob") {
    console.error(`⛔ PAYOUT_SUPPLIER=${p.kind} still lands on the src/suppliers/payout-partner.ts skeleton — docs/PAYOUTS.md.`);
    process.exit(1);
  }
  if (!p.clientId || !p.apiKey) {
    console.error(
      `⛔ PAYOUT_CLIENT_ID / PAYOUT_API_KEY (or PAYOUT_API_KEY_FILE) are not both set.\n` +
      `   Create the key at app.bitnob.com → Settings → API keys, whitelisting ${await egressIp()}\n` +
      `   and the deploy box's egress address, then put the secret in a 0400 file and point\n` +
      `   PAYOUT_API_KEY_FILE at it.`,
    );
    process.exit(1);
  }

  const supplier = new BitnobPayoutSupplier(p.clientId, p.apiKey, {
    baseUrl: p.baseUrl, asset: p.asset, callbackUrl: p.callbackUrl, maxSlippageBps: p.maxSlippageBps,
  });

  // 1. The float, which is also the denomination check: balanceMicro() refuses unless an
  //    account in PAYOUT_ASSET exists, and names what it found instead if it does not.
  const micro = await supplier.balanceMicro();
  console.log(`\npartner     bitnob`);
  console.log(`base URL    ${p.baseUrl || "https://api.bitnob.com"}`);
  console.log(`calling from ${await egressIp()}`);
  console.log(`float       ${(micro / M).toFixed(6)} ${p.asset}`);

  // 2. The catalogue. Corridors with no published rate or limit are dropped by the
  //    adapter, so an empty list here is a real answer, not a bug.
  const offers = await supplier.listOffers({ type: "payout", country });
  console.log(`\ncorridors   ${country} — ${offers.length} listable`);
  if (offers.length) {
    console.log(`  ${"offer".padEnd(22)} ${"send range".padEnd(26)} ${"cost to us".padEnd(18)} required beneficiary fields`);
    for (const o of offers) console.log(describe(o));
  }

  const currencies = [...new Set(offers.map((o) => o.sendCurrency).filter(Boolean))] as string[];
  for (const c of currencies) console.log(`\nrate        1 ${p.asset} = ${await supplier.fxRate(c) ?? "?"} ${c} (worse side, indicative)`);

  if (micro === 0) {
    console.log(
      `\n⚠️  The ${p.asset} float is zero. Corridors list and quote, but a finalize will fail for want of\n` +
      `   funds. Fund the Bitnob ${p.asset} balance before the first live payout — docs/PAYOUTS.md.`,
    );
  }
  if (!offers.length) {
    console.error(`\n⛔ No listable corridors for ${country}. Either the country is unsupported, or its corridors\n   publish no rate or no limit — both mean we cannot price a quote we would have to honour.`);
    process.exit(1);
  }
  const noFields = offers.filter((o) => !o.requiredFields?.length);
  if (noFields.length) {
    console.error(
      `\n⛔ ${noFields.length} corridor(s) publish no beneficiary fields: ${noFields.map((o) => o.id).join(", ")}.\n` +
      `   The per-country requirements endpoint is the only authoritative source for these, and a payout\n` +
      `   initialised without them is rejected after the payer has already settled on chain.`,
    );
    process.exit(1);
  }
  console.log(`\n✅ bitnob authenticates, holds a ${p.asset} account, and publishes priceable ${country} corridors.`);
}

main().catch(async (e) => {
  console.error(`\n⛔ ${(e as Error).message}`);
  console.error(await supportBlock(e));
  process.exit(1);
});
