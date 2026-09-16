// Third-party receipt verifier — needs nothing from us but the public key.
//   pnpm verify receipts/ord_x.json            # signature only
//   pnpm verify receipts/ord_x.json --online   # + confirm the txids on Algorand
// Env: RECEIPT_PUBLIC_KEY (pin the expected key), INDEXER_URL (default by NETWORK)
//
// The checks themselves live in `src/verify.ts`, shared with `POST /v1/verify`, so the
// answer a person gets at a terminal and the answer an agent gets over HTTP are produced
// by the same code. They used to be two implementations of the same idea, which is one
// more than the number that can be trusted to agree.

import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import type { Receipt } from "../src/receipt.js";
import { verifyFully } from "../src/verify.js";

const file = process.argv[2];
const online = process.argv.includes("--online");
const input = JSON.parse(file && !file.startsWith("--") ? readFileSync(file, "utf8") : readFileSync(0, "utf8"));
const receipt: Receipt = input.receipt ?? input;
const p = receipt.payload;
const expected = process.env.RECEIPT_PUBLIC_KEY || config.receipt.publicKey || undefined;
const indexerUrl = process.env.INDEXER_URL ?? config.indexerUrl;

const report = await verifyFully(receipt, {
  ourPubkey: expected,
  chain: online ? { indexerUrl, usdcAsa: config.usdcAsa } : undefined,
});

const mark = { ok: "✅", failed: "❌", unknown: "⚠️ " } as const;

console.log(`order ${p.order_id}: ${p.status} ${p.product_type} ${p.brand}/${p.country} ${p.amount_usdc} USDC`);
console.log(
  `signer  ${p.server_pubkey}` +
    (expected ? (report.signer_is === "this-server" ? " (matches pinned key)" : " ❌ DOES NOT MATCH pinned key") : ""),
);
console.log(`signature ${report.signature === "ok" ? "✅ VALID" : "❌ INVALID"}`);
console.log(`settlement ${p.settlement_txid}`);
if (p.refund_txid) console.log(`refund     ${p.refund_txid}`);
if (report.signature === "failed") process.exit(2);

if (online) {
  console.log(`on-chain settlement: ${mark[report.settlement.state]} ${report.settlement.detail}`);
  if (report.refund) console.log(`on-chain refund:     ${mark[report.refund.state]} ${report.refund.detail}`);
  for (const note of report.notes) console.log(`\n${note}`);
  // An indexer that could not answer is not a bad receipt, so it is not a failure exit —
  // but it is not a pass either, and a script that treats "unknown" as "verified" is the
  // exact failure this whole trust layer exists to avoid.
  if (report.settlement.state === "failed" || report.refund?.state === "failed") process.exit(3);
  if (!report.verified) process.exit(4);
}
