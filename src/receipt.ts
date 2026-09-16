// Signed receipts — the trust layer. Every terminal order state (delivered or
// refunded) is signed with the server's ed25519 key over a canonical payload that
// names the on-chain settlement (and, for refunds, the on-chain refund). A
// third party verifies offline: (1) signature vs the published public key,
// (2) the txids exist on Algorand. Nothing here depends on trusting us.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { createHash, createHmac } from "node:crypto";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export const RECEIPT_VERSION = 1;

export interface ReceiptPayload {
  v: number;
  order_id: string;
  status: "delivered" | "refunded";
  product_type: string; // topup | esim | bill
  offer_id: string;
  country: string;
  brand: string;
  recipient_hash: string; // HMAC of the recipient identifier under a server pepper — see hashRecipient
  amount_usdc: string; // fixed 6dp, what the payer paid
  payer: string; // Algorand address that paid
  settlement_txid: string; // the x402 USDC payment on Algorand
  supplier: string;
  supplier_tx_id: string;
  refund_txid: string; // "" unless status === refunded
  issued_at: string; // ISO-8601
  server_pubkey: string; // hex — payload is self-describing
}

export interface Receipt {
  payload: ReceiptPayload;
  signature: string; // hex ed25519 over canonicalize(payload)
}

/** Fixed field order — the bytes a verifier hashes must equal the bytes signed. */
export function canonicalize(p: ReceiptPayload): string {
  return JSON.stringify([
    p.v, p.order_id, p.status, p.product_type, p.offer_id, p.country, p.brand,
    p.recipient_hash, p.amount_usdc, p.payer, p.settlement_txid, p.supplier,
    p.supplier_tx_id, p.refund_txid, p.issued_at, p.server_pubkey,
  ]);
}

/**
 * The recipient identifier, one-way, for the `recipient_hash` a receipt carries.
 *
 * **This used to be a bare `sha256(phone)`, which is not a privacy measure.** A phone
 * number is drawn from a space of maybe 10^10 values; an unsalted hash of one is
 * reversible on a laptop in seconds. The receipt is not a private document — it is the
 * proof of delivery, `skills/iomarkets-topup/SKILL.md` tells agents to keep it, and it
 * ends up in files, support threads and wherever an agent puts things. Publishing an
 * instantly-reversible hash of a customer's phone number, under a comment claiming it
 * is "never the raw number", was worse than publishing nothing: it looked handled.
 *
 * Now an HMAC under a server-side pepper. What a third party can still do is unchanged
 * for every legitimate purpose — the signature verifies, the txids check out on chain,
 * and `GET /v1/orders/:id` shows the masked number to whoever holds the order id. What
 * they can no longer do is enumerate the number.
 */
export const hashRecipient = (recipient: string, pepper: string): string =>
  createHmac("sha256", pepper).update(recipient.trim()).digest("hex");

/**
 * The pepper, derived from the receipt signing key rather than configured separately.
 *
 * A separate secret is a separate thing to generate, mount, back up and lose — and
 * losing it silently breaks the per-recipient structuring ceiling, which is a control
 * that fails quietly. The receipt private key is already mandatory, already secret and
 * already the thing whose rotation invalidates historical receipts, so tying the two
 * together means there is exactly one key whose rotation is a breaking change instead
 * of two. One-way, so nothing about the signing key is recoverable from a hash.
 */
export const recipientPepper = (receiptPrivateKeyHex: string): string =>
  createHash("sha256").update(`iomarkets/recipient-hash/v1|${receiptPrivateKeyHex}`).digest("hex");

export function derivePublicKey(privHex: string): string {
  return toHex(ed.getPublicKey(fromHex(privHex)));
}

export function generateKeypair(): { privateKey: string; publicKey: string } {
  const priv = ed.utils.randomPrivateKey();
  return { privateKey: toHex(priv), publicKey: toHex(ed.getPublicKey(priv)) };
}

export function signReceipt(
  payload: Omit<ReceiptPayload, "server_pubkey" | "v">,
  privHex: string,
): Receipt {
  const full: ReceiptPayload = { ...payload, v: RECEIPT_VERSION, server_pubkey: derivePublicKey(privHex) };
  const signature = toHex(ed.sign(enc.encode(canonicalize(full)), fromHex(privHex)));
  return { payload: full, signature };
}

/** Pure signature check; does NOT confirm the txids on-chain (see scripts/verify-receipt.ts). */
export function verifyReceipt(r: Receipt, expectedPubkey?: string): boolean {
  try {
    if (expectedPubkey && r.payload.server_pubkey !== expectedPubkey) return false;
    return ed.verify(fromHex(r.signature), enc.encode(canonicalize(r.payload)), fromHex(r.payload.server_pubkey));
  } catch {
    return false;
  }
}
