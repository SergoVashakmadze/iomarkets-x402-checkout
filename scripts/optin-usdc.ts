// Opt an account into USDC (needed before it can hold/receive it). Fund it with a
// little ALGO first (min balance + fee).
//   pnpm tsx scripts/optin-usdc.ts "<25-word mnemonic>"
//   pnpm tsx scripts/optin-usdc.ts            # uses REFUND_MNEMONIC_FILE / AGENT_MNEMONIC_FILE (see src/keys.ts)
import algosdk from "algosdk";
import { config } from "../src/config.js";
import { loadSecret } from "../src/keys.js";

const algod = new algosdk.Algodv2("", config.algodUrl, "");

async function optIn(mnemonic: string): Promise<void> {
  const acct = algosdk.mnemonicToSecretKey(mnemonic);
  const info = await algod.accountInformation(acct.addr).do();
  if ((info.assets ?? []).some((a) => Number(a.assetId) === config.usdcAsa)) {
    console.log(`✓ ${acct.addr} already opted in to ASA ${config.usdcAsa}`);
    return;
  }
  if (Number(info.amount) === 0) throw new Error(`${acct.addr} has 0 ALGO — fund it first`);
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: acct.addr, receiver: acct.addr, amount: 0, assetIndex: config.usdcAsa, suggestedParams: sp });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log(`✓ ${acct.addr} opted in to ASA ${config.usdcAsa} (${txid})`);
}

const arg = process.argv[2];
const list = arg ? [arg] : [loadSecret("REFUND_MNEMONIC"), loadSecret("AGENT_MNEMONIC")].filter((m) => !!m);
if (!list.length) throw new Error("pass a mnemonic or set REFUND_MNEMONIC_FILE / AGENT_MNEMONIC_FILE");
for (const m of list) await optIn(m);
