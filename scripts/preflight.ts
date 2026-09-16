// Pre-deploy sanity check. Reads .env, asks the chain and the facilitator whether
// this configuration can actually take money, and exits non-zero if it cannot.
//
//   pnpm preflight                 # local: warns about things only a deploy needs
//   pnpm preflight --production    # deploy gate: those warnings become failures
//
// Read-only — it never signs or sends anything.

import algosdk from "algosdk";
import { ALGORAND_MAINNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_HASH } from "@x402/avm";
import { config } from "../src/config.js";
import { toMicro } from "../src/money.js";
import { makeSupplier } from "../src/suppliers/index.js";
import { Db } from "../src/db.js";
import { payConsoleBuilt } from "../src/pay-console.js";
import {
  checkAssetOptIn, checkFacilitatorSupport, checkPayToFormat, checkPublicBaseUrl,
  checkAccountCeilings, checkPayConsole, checkPayoutSupplier, checkPricingCoversFloat, checkReceiptKeys, checkRefunder, worst, type AccountState, type CheckResult,
} from "../src/preflight.js";

const production = process.argv.includes("--production");
const algod = new algosdk.Algodv2("", config.algodUrl, "");

async function accountState(address: string): Promise<AccountState | null> {
  try {
    const info = await algod.accountInformation(address).do();
    return { amount: info.amount, assets: (info.assets ?? []).map((a) => ({ assetId: a.assetId, amount: a.amount })) };
  } catch {
    return null; // 404 = never funded, which the check reports properly
  }
}

async function facilitatorSupported(): Promise<{ kinds?: Array<{ scheme?: string; network?: string; asset?: string }> } | null> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/supported`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as { kinds?: Array<{ scheme?: string; network?: string; asset?: string }> }) : null;
  } catch {
    return null;
  }
}

/**
 * The CAIP-2 id the route advertises. Built from the SAME @x402/avm constants as
 * src/app.ts — the facilitator keys on the full genesis hash, not the SDK's 32-char
 * short id, so this must not be "simplified".
 */
const caip2 = (): string =>
  `algorand:${config.network === "mainnet" ? ALGORAND_MAINNET_GENESIS_HASH : ALGORAND_TESTNET_GENESIS_HASH}`;

async function supplierCheck(): Promise<CheckResult> {
  const name = `supplier (${config.supplier.kind})`;
  try {
    const s = makeSupplier();
    const balance = await s.balanceMicro();
    const detail = `${s.name}: $${(balance / 1e6).toFixed(2)} available`;
    if (production && config.supplier.kind === "mock") return { name, level: "fail", detail: "SUPPLIER=mock delivers nothing real" };
    if (balance <= 0 && config.supplier.kind !== "mock") return { name, level: "warn", detail: `${detail} — fund the supplier wallet` };
    return { name, level: "ok", detail };
  } catch (e) {
    return { name, level: production ? "fail" : "warn", detail: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  results.push(checkPayToFormat(config.payTo));
  results.push(checkPublicBaseUrl(config.publicBaseUrl, { production }));
  results.push(checkReceiptKeys(config.receipt.privateKey, config.receipt.publicKey));

  if (algosdk.isValidAddress(config.payTo)) {
    results.push(checkAssetOptIn("PAY_TO", config.payTo, await accountState(config.payTo), config.usdcAsa));
  }

  const refundAddr = config.refund.mnemonic ? algosdk.mnemonicToSecretKey(config.refund.mnemonic).addr.toString() : null;
  results.push(checkRefunder(refundAddr, production));
  if (refundAddr) {
    results.push(checkAssetOptIn("refund wallet", refundAddr, await accountState(refundAddr), config.usdcAsa, {
      needsAlgo: true,
      minUsdcMicro: toMicro(config.refund.dailyCapUsd),
    }));
  }

  results.push(checkFacilitatorSupport(await facilitatorSupported(), { network: caip2(), asset: config.usdcAsa }));
  results.push(checkPricingCoversFloat(config.pricing, config.limits.maxOrderUsd));
  results.push(checkPayoutSupplier(config.payout.kind, production));
  results.push(checkPayConsole(payConsoleBuilt()));
  results.push(checkAccountCeilings(new Db(config.dbPath).listAccounts(), config.refund.dailyCapUsd * 1_000_000));
  results.push(await supplierCheck());

  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  const width = Math.max(...results.map((r) => r.name.length));
  console.log(`\npreflight — ${config.network}${production ? " (production gate)" : ""}\n`);
  for (const r of results) console.log(`  ${icon[r.level]} ${r.name.padEnd(width)}  ${r.detail}`);

  const level = worst(results);
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(
    level === "fail"
      ? `\n✗ ${fails} blocking problem${fails === 1 ? "" : "s"} — do not deploy this.\n`
      : level === "warn"
        ? `\n! ${warns} warning${warns === 1 ? "" : "s"}${production ? "" : " — re-run with --production before deploying"}.\n`
        : "\n✓ ready.\n",
  );
  process.exit(level === "fail" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
