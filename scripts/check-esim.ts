// Is the eSIM supplier's account usable, funded, and priced in the asset we settle in?
//
//   pnpm check-esim            # the supplier named by ESIM_SUPPLIER, catalogue for US
//   pnpm check-esim JP         # …for Japan instead
//
// Read-only: it authenticates, reads the balance and the catalogue, and buys nothing.
//
// This matters more here than anywhere else in the repo, because **eSIM Access has no
// sandbox**. There is no environment in which a first order is free, so the only safe
// sequence is: read the balance, read the catalogue, check the prices are USD, and only
// then buy the cheapest package in it as the integration test. This script is the first
// three steps, and it is the same question `check-supplier` and `check-payout` ask —
// Zendit authenticated perfectly for a week while its account was denominated in GBP.

import { config } from "../src/config.js";
import { EsimAccessSupplier } from "../src/suppliers/esimaccess.js";
import { AiraloSupplier } from "../src/suppliers/airalo.js";
import { ZenditSupplier } from "../src/suppliers/zendit.js";
import { SupplierError, type Supplier } from "../src/suppliers/types.js";

const country = (process.argv[2] ?? "US").toUpperCase();
const M = 1_000_000;
const usd = (micro: number) => `$${(micro / M).toFixed(2)}`;

function supplier(): Supplier {
  const e = config.esim;
  switch (e.kind) {
    case "esimaccess": return new EsimAccessSupplier(e.esimAccessCode, e.esimAccessBaseUrl, e.esimAccessSecret);
    case "airalo": return new AiraloSupplier(e.airaloClientId, e.airaloClientSecret);
    case "zendit": return new ZenditSupplier(config.supplier.zendit.apiKey, config.supplier.zendit.baseUrl);
    default:
      throw new Error(
        `ESIM_SUPPLIER is "${e.kind || "(unset)"}" — set it to esimaccess, airalo or zendit before running this.`,
      );
  }
}

/**
 * `fetch failed` is a wrapper, and on one workstation it wrapped something that had
 * nothing to do with the supplier.
 *
 * Measured 2026-09-02: this call failed roughly one time in two with `ETIMEDOUT` after
 * ~250 ms, while `curl` to the same host succeeded 6/6. The cause was Node's Happy
 * Eyeballs (`autoSelectFamily`, on by default since Node 20) racing an IPv4 address
 * against a **NAT64** IPv6 address synthesised by the local resolver — `api.esimaccess.com`
 * resolves to both `18.136.19.137` and `64:ff9b::1288:1389` here — where the NAT64 path
 * is dead. `--dns-result-order=ipv4first` does NOT fix it (4/10). Disabling the race does:
 * **10/10, twice.**
 *
 * It is a defect in one network, not in the supplier or in this code, and it is printed
 * rather than worked around silently — a flag that hides a broken network is how you end
 * up debugging a supplier who was never the problem.
 */
function networkHint(e: unknown): string {
  const msg = (e as Error)?.message ?? "";
  if (!/fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg)) return "";
  return (
    `\n   That is a transport error, not the supplier refusing you. If it happens intermittently\n` +
    `   (roughly every other call) while curl to the same host works, it is Node racing a dead\n` +
    `   IPv6/NAT64 route. Re-run with the race turned off:\n\n` +
    `     NODE_OPTIONS=--no-network-family-autoselection pnpm check-esim\n`
  );
}

async function main(): Promise<void> {
  const s = supplier();
  console.log(`supplier    ${s.name}`);

  // Balance first: it is the cheapest call, it proves the credential, and on a supplier
  // with no sandbox it is the only number that says whether an order can succeed at all.
  let floatMicro: number | null = null;
  try {
    floatMicro = await s.balanceMicro();
    console.log(`float       ${usd(floatMicro)}`);
  } catch (e) {
    // Airalo publishes no balance endpoint. That is a finding, not a crash.
    console.log(`float       unknown — ${(e as Error).message}`);
    const hint = networkHint(e);
    if (hint) console.log(hint);
  }

  const offers = await s.listOffers({ type: "esim", country, limit: 200 });
  console.log(`catalogue   ${offers.length} offer(s) for ${country}`);
  if (!offers.length) {
    console.error(`\n⛔ Nothing listable for ${country}. Either the country is unsupported or nothing in it is priced in USD.`);
    process.exit(1);
  }

  const priced = offers.filter((o) => typeof o.costMicro === "number").sort((a, b) => (a.costMicro ?? 0) - (b.costMicro ?? 0));
  const cheapest = priced[0];
  console.log(`\ncheapest    ${cheapest.id}  ${usd(cheapest.costMicro ?? 0)}  ${cheapest.name}`);
  for (const o of priced.slice(0, 5)) {
    console.log(`  ${usd(o.costMicro ?? 0).padStart(8)}  ${o.id.padEnd(28)} ${o.dataGB ?? "?"}GB / ${o.durationDays ?? "?"}d  ${o.name}`);
  }

  if (floatMicro !== null && cheapest.costMicro && floatMicro < cheapest.costMicro) {
    console.log(
      `\n⚠️  The float (${usd(floatMicro)}) will not cover the cheapest offer (${usd(cheapest.costMicro)}).\n` +
      `   Offers list and quote, but the float gate refuses the order — which is the correct behaviour, and\n` +
      `   also means nothing can be sold until the account is funded.`,
    );
  }
  console.log(
    `\n✅ ${s.name} authenticates and publishes USD-priced offers for ${country}.\n` +
    `   The first live order is the integration test — buy ${cheapest.id} (${usd(cheapest.costMicro ?? 0)}) and nothing larger.`,
  );
}

main().catch((e) => {
  const retryable = e instanceof SupplierError && e.retryable ? " (retryable)" : "";
  console.error(`\n⛔ ${(e as Error).message}${retryable}`);
  console.error(networkHint(e));
  process.exit(1);
});
