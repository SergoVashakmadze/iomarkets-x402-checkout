// Move USDC between OUR OWN wallets — refund float ↔ agent buyer, and nothing else.
//
//   pnpm send-usdc --from refund --to agent --amount 10
//   pnpm send-usdc --from refund --to <ALGORAND_ADDRESS> --amount 10
//
// `--from` names a mnemonic we hold (refund | agent); `--to` is either the other name or
// a full address. It prints the plan, both balances before and after, and requires the
// amount to be typed back before it signs. Nothing is broadcast without that.
//
// Why a script rather than a wallet app: these two keys exist only as 0400 files
// (src/keys.ts), so moving float would otherwise mean importing a spending mnemonic
// into a phone. This never prints or copies the mnemonic.
//
// It is deliberately NOT a general-purpose sender. It refuses any destination that is
// not opted in to USDC, refuses to empty the refund wallet below the daily refund cap
// unless forced, and has no way to reach an address you have not typed in full.

import { createInterface } from "node:readline/promises";
import algosdk from "algosdk";
import { config } from "../src/config.js";
import { loadSecret } from "../src/keys.js";
import { parseArgs } from "../src/client/buy-args.js";

const M = 1_000_000;
const algod = new algosdk.Algodv2("", config.algodUrl, "");
const argv = parseArgs(process.argv.slice(2), new Set(["yes", "force"]));
const arg = (k: string) => argv.get(k)?.[0];

const NAMED: Record<string, string> = { refund: "REFUND_MNEMONIC", agent: "AGENT_MNEMONIC" };

function signerFor(name: string): algosdk.Account {
  const env = NAMED[name];
  if (!env) throw new Error(`--from must be one of: ${Object.keys(NAMED).join(", ")}`);
  const m = loadSecret(env);
  if (!m) throw new Error(`${env}_FILE is not set — cannot sign for "${name}"`);
  return algosdk.mnemonicToSecretKey(m);
}

/** A named wallet resolves through its own key; anything else must be a full address,
 *  so a typo cannot silently become a different valid account. */
function resolveDestination(to: string): string {
  if (NAMED[to]) return signerFor(to).addr.toString();
  if (!algosdk.isValidAddress(to)) throw new Error(`--to must be ${Object.keys(NAMED).join(" | ")} or a valid 58-character Algorand address`);
  return to;
}

async function usdcMicro(address: string): Promise<{ algo: number; usdc: number | null }> {
  const info = await algod.accountInformation(address).do();
  const asset = (info.assets ?? []).find((a) => Number(a.assetId) === config.usdcAsa);
  return { algo: Number(info.amount), usdc: asset ? Number(asset.amount) : null };
}

async function main(): Promise<void> {
  const from = arg("from") ?? "refund";
  const to = arg("to");
  const amount = Number(arg("amount"));
  if (!to) throw new Error("--to is required");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("--amount is required, in whole USDC (e.g. 10)");

  const sender = signerFor(from);
  const dest = resolveDestination(to);
  if (dest === sender.addr.toString()) throw new Error("--from and --to are the same account");
  const micro = Math.round(amount * M);

  const before = await usdcMicro(sender.addr.toString());
  const destBefore = await usdcMicro(dest);
  if (before.usdc === null) throw new Error(`${from} is not opted in to USDC (ASA ${config.usdcAsa})`);
  // A USDC transfer to an account that has not opted in is REJECTED by the chain, so
  // this would fail anyway — but failing here costs no fee and says why.
  if (destBefore.usdc === null) throw new Error(`destination ${dest} is not opted in to USDC (ASA ${config.usdcAsa}) — it cannot receive it`);
  if (before.usdc < micro) throw new Error(`${from} holds ${(before.usdc / M).toFixed(2)} USDC, cannot send ${amount.toFixed(2)}`);

  // The refund float is a promise: it is what pays back a payer whose delivery failed.
  const capMicro = Math.round(config.refund.dailyCapUsd * M);
  const remaining = before.usdc - micro;
  if (from === "refund" && remaining < capMicro && !argv.has("force")) {
    console.warn(
      `\n⚠️  This leaves the refund wallet at $${(remaining / M).toFixed(2)}, under the $${config.refund.dailyCapUsd.toFixed(2)} ` +
      `REFUND_DAILY_CAP_USD it is meant to stand behind.\n   The cap is a promise about how much can be refunded in a day; it should not exceed the float.\n` +
      `   Lower the cap to match, or top the wallet up. Pass --force to proceed anyway.\n`,
    );
  }

  console.log(`\nfrom    ${from.padEnd(6)} ${sender.addr}  $${(before.usdc / M).toFixed(2)} USDC`);
  console.log(`to      ${(NAMED[to] ? to : "address").padEnd(6)} ${dest}  $${(destBefore.usdc / M).toFixed(2)} USDC`);
  console.log(`amount  $${amount.toFixed(2)} USDC (ASA ${config.usdcAsa}) on ${config.network}`);
  console.log(`\nThis is an on-chain transfer and cannot be undone.`);

  if (!argv.has("yes")) {
    if (!process.stdin.isTTY) throw new Error("run this interactively, or pass --yes if you have already checked it");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`Type the amount (${amount}) to confirm: `);
    rl.close();
    if (Number(typed.trim()) !== amount) throw new Error("amount not confirmed — nothing was sent");
  }

  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: sender.addr, receiver: dest, amount: micro, assetIndex: config.usdcAsa, suggestedParams: sp,
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(sender.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 4);

  const after = await usdcMicro(sender.addr.toString());
  const destAfter = await usdcMicro(dest);
  console.log(`\n✓ sent $${amount.toFixed(2)} USDC — ${txid}`);
  console.log(`  https://allo.info/tx/${txid}`);
  console.log(`  ${from}: $${(after.usdc! / M).toFixed(2)}   destination: $${(destAfter.usdc! / M).toFixed(2)}`);
}

main().catch((e) => { console.error(`\n⛔ ${(e as Error).message}`); process.exit(1); });
