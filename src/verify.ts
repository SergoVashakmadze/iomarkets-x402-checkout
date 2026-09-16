// Receipt verification, as a thing anyone can run — including against receipts we did
// not issue.
//
// WHY THIS IS ITS OWN MODULE. The signature check has always been pure and shared
// (`verifyReceipt` in receipt.ts), but the half that actually convinces someone — *did
// that money really move on Algorand* — lived only inside `scripts/verify-receipt.ts`,
// where nothing but a person at a terminal could reach it. So the strongest claim this
// project makes was the least reachable thing in it.
//
// The claim is: **a receipt is checkable by a stranger, offline, without trusting us.**
// That is only true if the checking is available the way the buying is — as an endpoint,
// with a documented format behind it (docs/RECEIPTS.md). Same function behind
// `pnpm verify`, `POST /v1/verify` and anyone's own implementation of the spec.
//
// Two rules this module holds to, both of which matter more than they look:
//
//   1. **A receipt is verified against ITS OWN `server_pubkey`, not ours.** Anyone
//      adopting the format gets a working verifier here, which is the entire difference
//      between publishing a spec and publishing a self-check. Whether the signer is a
//      key *we* publish is reported separately, as a fact, not folded into "valid".
//   2. **A failed on-chain lookup is not a failed receipt.** An indexer that is down, or
//      pruned, or on the wrong network says nothing about the payment. It reports
//      `unknown` and says why — never `false`, which would let a third party's outage
//      make our proof look like a lie.

import { verifyReceipt, type Receipt } from "./receipt.js";

/** A check that can be true, false, or genuinely unknown — the third being the point. */
export type CheckState = "ok" | "failed" | "unknown";

export interface ChainCheck {
  state: CheckState;
  txid: string;
  detail: string;
  confirmedRound?: number;
}

export interface VerificationReport {
  order_id: string;
  status: string;
  amount_usdc: string;
  signer: string;
  /** The signature over the canonical payload. This one is never "unknown". */
  signature: "ok" | "failed";
  /** Whether the signer is a key this server publishes at /v1/pubkey. */
  signer_is: "this-server" | "another-server";
  settlement: ChainCheck;
  /** Present only when the receipt claims a refund. */
  refund?: ChainCheck;
  /** True only when everything checkable checked out. `unknown` is not `true`. */
  verified: boolean;
  notes: string[];
}

export interface ChainOptions {
  indexerUrl: string;
  usdcAsa: number;
  /** An indexer that hangs must not hang the caller. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Shape of the one indexer response we read. Everything is optional on purpose. */
interface IndexerTx {
  transaction?: {
    sender?: string;
    "confirmed-round"?: number;
    "asset-transfer-transaction"?: { amount?: number | string; "asset-id"?: number | string; receiver?: string };
  };
}

/**
 * Is this txid a USDC transfer of exactly this amount, from/to the expected addresses?
 *
 * The amount comparison is in integer micro-USDC on both sides. A receipt's
 * `amount_usdc` is a fixed-6dp string precisely so that this comparison is exact rather
 * than a float tolerance — `Number(x) * 1e6` on "15.310000" is safe, on an arbitrary
 * decimal string it would not be, and the format pins it.
 */
export async function checkOnChain(
  txid: string,
  expect: { amountUsdc: string; sender?: string; receiver?: string },
  o: ChainOptions,
): Promise<ChainCheck> {
  if (!txid) return { state: "failed", txid, detail: "no txid on the receipt" };
  const idx = o.indexerUrl.replace(/\/$/, "");
  const doFetch = o.fetchImpl ?? fetch;

  let body: IndexerTx;
  try {
    const res = await doFetch(`${idx}/v2/transactions/${encodeURIComponent(txid)}`, {
      signal: AbortSignal.timeout(o.timeoutMs ?? 8_000),
    });
    // 404 from an indexer is genuinely ambiguous: a transaction that never existed and
    // one outside this indexer's retention look identical. Say so rather than accuse.
    if (res.status === 404) return { state: "unknown", txid, detail: `not found on ${idx} — it may be outside this indexer's retention window` };
    if (!res.ok) return { state: "unknown", txid, detail: `indexer returned HTTP ${res.status}` };
    body = (await res.json()) as IndexerTx;
  } catch (e) {
    return { state: "unknown", txid, detail: `could not reach the indexer: ${(e as Error).message}` };
  }

  const t = body.transaction;
  if (!t) return { state: "unknown", txid, detail: "indexer response carried no transaction" };
  const a = t["asset-transfer-transaction"];
  const problems: string[] = [];
  if (!a) problems.push("not an asset transfer");
  else {
    const expectedMicro = Math.round(Number(expect.amountUsdc) * 1e6);
    if (Number(a.amount) !== expectedMicro) problems.push(`amount ${a.amount} ≠ ${expectedMicro} micro-USDC`);
    if (Number(a["asset-id"]) !== o.usdcAsa) problems.push(`asset ${a["asset-id"]} ≠ USDC ${o.usdcAsa}`);
    if (expect.sender && t.sender !== expect.sender) problems.push(`sender ${t.sender} ≠ ${expect.sender}`);
    if (expect.receiver && a.receiver !== expect.receiver) problems.push(`receiver ${a.receiver} ≠ ${expect.receiver}`);
  }
  // A transaction that IS on chain and does not match the receipt is a real failure —
  // the one case where "failed" is the honest word.
  return problems.length
    ? { state: "failed", txid, detail: problems.join("; "), confirmedRound: t["confirmed-round"] }
    : { state: "ok", txid, detail: `confirmed in round ${t["confirmed-round"]}`, confirmedRound: t["confirmed-round"] };
}

/**
 * The whole check: signature, then both on-chain legs.
 *
 * `ourPubkey` is used only to report *whose* key signed it. It is deliberately not an
 * input to validity — a receipt from another server that verifies against its own key
 * is a valid receipt, and saying otherwise would make this a self-check wearing a
 * spec's clothes.
 */
export async function verifyFully(
  receipt: Receipt,
  opts: { ourPubkey?: string; chain?: ChainOptions },
): Promise<VerificationReport> {
  const p = receipt.payload;
  const notes: string[] = [];
  const signature = verifyReceipt(receipt) ? "ok" : "failed";
  const signerIs = opts.ourPubkey && p.server_pubkey === opts.ourPubkey ? "this-server" : "another-server";
  if (signerIs === "another-server") {
    notes.push("This receipt was signed by another server. The signature is checked against the key named in the receipt itself; whether you trust that key is your decision.");
  }

  const report: VerificationReport = {
    order_id: p.order_id, status: p.status, amount_usdc: p.amount_usdc,
    signer: p.server_pubkey, signature, signer_is: signerIs,
    settlement: { state: "unknown", txid: p.settlement_txid, detail: "on-chain check not requested" },
    verified: false, notes,
  };

  if (signature === "failed") {
    // Do not spend an indexer round trip on a payload whose bytes have been altered.
    notes.push("The signature does not verify, so nothing else about this receipt can be relied on.");
    return report;
  }

  if (opts.chain) {
    report.settlement = await checkOnChain(p.settlement_txid, { amountUsdc: p.amount_usdc, sender: p.payer }, opts.chain);
    if (p.status === "refunded") {
      // The refund travels the other way: back to the payer, from our float.
      report.refund = await checkOnChain(p.refund_txid, { amountUsdc: p.amount_usdc, receiver: p.payer }, opts.chain);
    }
  }

  const checks = [report.settlement, ...(report.refund ? [report.refund] : [])];
  report.verified = signature === "ok" && checks.every((c) => c.state === "ok");
  if (!report.verified && checks.some((c) => c.state === "unknown")) {
    notes.push("The signature is valid. One or more on-chain checks could not be completed, which is a statement about the indexer, not about the payment — re-run against an indexer you trust.");
  }
  return report;
}
