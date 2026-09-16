import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeypair, hashRecipient, recipientPepper, signReceipt, verifyReceipt } from "../src/receipt.js";

const kp = generateKeypair();
const pepper = recipientPepper(kp.privateKey);
const base = {
  order_id: "ord_1", status: "delivered" as const, product_type: "topup", offer_id: "o", country: "IN", brand: "JIO",
  recipient_hash: hashRecipient("919876543210", pepper), amount_usdc: "3.850000", payer: "PAYER", settlement_txid: "TX1",
  supplier: "mock", supplier_tx_id: "mock_ord_1", refund_txid: "", issued_at: "2026-08-25T00:00:00.000Z",
};

describe("receipts", () => {
  it("signs and verifies", () => {
    const r = signReceipt(base, kp.privateKey);
    expect(r.payload.server_pubkey).toBe(kp.publicKey);
    expect(verifyReceipt(r)).toBe(true);
    expect(verifyReceipt(r, kp.publicKey)).toBe(true);
  });
  it("rejects tampering and wrong pinned key", () => {
    const r = signReceipt(base, kp.privateKey);
    const tampered = { ...r, payload: { ...r.payload, amount_usdc: "0.010000" } };
    expect(verifyReceipt(tampered)).toBe(false);
    expect(verifyReceipt(r, generateKeypair().publicKey)).toBe(false);
  });
  it("never embeds the raw recipient", () => {
    const r = signReceipt(base, kp.privateKey);
    expect(JSON.stringify(r)).not.toContain("919876543210");
  });
});

describe("the recipient hash is peppered, not a bare sha256", () => {
  // A phone number is drawn from ~10^10 values. An unsalted sha256 of one is reversible
  // on a laptop, and the receipt is a document this service tells agents to keep and
  // pass around. The old implementation was sha256(number) under a comment claiming the
  // raw number was never published, which is the worst kind of privacy control: one
  // that looks handled.
  it("does not equal the plain sha256 an attacker would precompute", () => {
    const plain = createHash("sha256").update("919876543210").digest("hex");
    expect(hashRecipient("919876543210", pepper)).not.toBe(plain);
  });

  it("is stable for one key and different across keys", () => {
    expect(hashRecipient("919876543210", pepper)).toBe(hashRecipient("919876543210", pepper));
    const other = recipientPepper(generateKeypair().privateKey);
    expect(hashRecipient("919876543210", other)).not.toBe(hashRecipient("919876543210", pepper));
  });

  it("derives the pepper one-way, so a hash never leaks the signing key", () => {
    expect(pepper).not.toContain(kp.privateKey);
    expect(recipientPepper(kp.privateKey)).toBe(pepper);
  });

  it("still separates different recipients, which is what the ceiling counts on", () => {
    expect(hashRecipient("919876543210", pepper)).not.toBe(hashRecipient("919876543211", pepper));
    // Trimmed, so " 91…" and "91…" are one recipient rather than two.
    expect(hashRecipient(" 919876543210 ", pepper)).toBe(hashRecipient("919876543210", pepper));
  });
});
