# Signed delivery receipts for x402 sellers — format v1

**Status:** implemented and in production at `iomarkets.app`. Offered as a format for other
x402 sellers to adopt; nothing in it is specific to what we sell.

A receipt answers one question that x402 itself does not: **the payment settled on chain, but
did the seller deliver?** The chain proves money moved. It cannot prove a top-up reached a
phone, an eSIM was issued, or a refund was owed and paid. A receipt is the seller's signed
statement about that, bound to the on-chain transactions so it cannot be made about a payment
that never happened.

Verify one right now, against ours or against your own:

```
curl -sX POST https://iomarkets.app/v1/verify -H 'content-type: application/json' \
  -d @receipt.json
```

---

## 1. What a receipt is

Two fields:

```json
{
  "payload": { "…the statement…" },
  "signature": "hex ed25519 over canonicalize(payload)"
}
```

### The payload, field by field

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Format version. `1`. |
| `order_id` | string | The seller's order id. Unique per seller. |
| `status` | `"delivered"` \| `"refunded"` | The terminal outcome. **A receipt is only ever issued for a terminal state** — there is no receipt for "in progress", because a statement that might still change is not evidence. |
| `product_type` | string | What was sold (`topup`, `esim`, `bill`, `payout` for us; free text for you). |
| `offer_id` | string | The seller's identifier for the thing bought. |
| `country` | string | ISO-3166 alpha-2 destination, or `WW`. |
| `brand` | string | Supplier/brand code. |
| `recipient_hash` | hex string | **HMAC-SHA256 of the recipient identifier under a server-side pepper.** Not a bare hash — see §5. |
| `amount_usdc` | string | What the payer paid, **fixed 6 decimal places**, e.g. `"15.310000"`. A string, not a float, and fixed-width so a verifier's comparison against on-chain micro-units is exact. |
| `payer` | string | The address that paid. |
| `settlement_txid` | string | The x402 payment transaction. |
| `supplier` | string | Who fulfilled it. Named because a delivery claim with no fulfiller is unfalsifiable. |
| `supplier_tx_id` | string | The supplier's own reference — what a support ticket quotes. |
| `refund_txid` | string | The on-chain refund. `""` unless `status` is `refunded`. |
| `issued_at` | string | ISO-8601, when the receipt was signed. |
| `server_pubkey` | hex string | The signing key. **The payload names its own key**, so a receipt is self-describing and a verifier needs no directory. |

### Canonicalisation

The signed bytes are a JSON **array** in fixed field order, not an object:

```js
JSON.stringify([
  v, order_id, status, product_type, offer_id, country, brand,
  recipient_hash, amount_usdc, payer, settlement_txid, supplier,
  supplier_tx_id, refund_txid, issued_at, server_pubkey,
])
```

An array because JSON object key order is not guaranteed by any parser, and a signature over
bytes that a re-serialisation can permute is a signature over nothing. Adding a field in a
future version means appending to this array and bumping `v` — never inserting.

### Signature

ed25519 over those UTF-8 bytes, hex-encoded, using the key at `server_pubkey`. The seller
publishes the same key at a well-known endpoint (ours: `GET /v1/pubkey`), so a verifier can
decide whether it trusts the signer — a separate question from whether the signature is valid.

---

## 2. How to verify one

Three checks, in this order, and the order matters:

1. **Signature** against `payload.server_pubkey`. If this fails, stop: nothing else in the
   document means anything, and spending a network call on it is wasted.
2. **Signer identity.** Is `server_pubkey` a key you trust — the one published by the seller
   you think you bought from? A valid signature by an unknown key is a valid signature by an
   unknown key. **Keep this separate from validity** rather than folding it in.
3. **On chain**, via any Algorand indexer:
   - `settlement_txid` is an asset transfer of `amount_usdc` (× 10⁶, exactly) in the expected
     USDC asset, **from** `payer`.
   - If `status` is `refunded`, `refund_txid` is a transfer of the same amount **to** `payer`.

`src/verify.ts` in this repo is a complete implementation in ~150 lines, with no dependency
on anything else here except the signature primitive.

### The rule that matters most: three states, not two

A check is `ok`, `failed`, or **`unknown`** — and an indexer that times out, returns 503, or
has pruned the round is `unknown`. Never `failed`.

Collapsing `unknown` into `failed` means a third party's outage makes an honest seller look
like a liar. Collapsing it into `ok` means an outage becomes a way to launder a fake receipt.
Both are worse than saying "I could not check". Our verifier reports `verified: true` only
when every check is `ok`.

---

## 3. What a receipt proves — and what it does not

Being precise about this is the difference between a trust mechanism and a badge.

**It proves:**

- The seller **stated**, in a way they cannot later deny or quietly edit, that this order
  reached this terminal state.
- That statement is **bound to a specific on-chain payment** of a specific amount from a
  specific payer. A seller cannot issue a delivery claim for a payment that did not happen.
- For refunds, that the money **went back to the payer** — the direction is checked, so a
  refund paid to the wrong address fails verification rather than passing on the seller's word.

**It does not prove:**

- That the goods were *good*. A top-up that reached the wrong number still produces a valid
  "delivered" receipt. The receipt is the seller's claim, made permanent and attributable —
  not an oracle.
- That the seller is solvent, licensed, or honest. It makes dishonesty **detectable and
  attributable**, which is a different and more achievable property.
- Anything at all, if you do not check who signed it.

That last point is why `signer_is` is reported separately from `signature` throughout.

---

## 4. Why a seller would want this

The reason we built it, in one line: **an agent that cannot verify delivery has to trust a
stranger, and agents transacting with strangers is the entire premise of x402.**

- **Disputes become checkable.** "Where is my order" is answered by a document with a
  signature and two transaction ids, not by a support conversation.
- **Refunds become provable.** Anyone can confirm the money went back, to the right address,
  without asking the seller anything.
- **Reconciliation stops being a spreadsheet.** Every payment carries its own audit record,
  and a buyer's records and a seller's records are the same artefact.
- **It costs almost nothing.** One ed25519 signature per terminal order, and a published key.

---

## 5. `recipient_hash`, and a mistake worth not repeating

This field was originally `sha256(phone_number)`. **That is not a privacy measure.** A phone
number is drawn from a space of about 10¹⁰ values; an unsalted hash of one is reversible on a
laptop in seconds. The receipt is a document meant to be kept, forwarded and published — so
publishing an instantly-reversible hash of a customer's number, under a comment claiming it
was "never the raw number", was worse than publishing nothing, because it looked handled.

It is now an HMAC under a server-side pepper. Everything a third party legitimately needs is
unchanged: the signature verifies, the transactions check out, and the holder of the order id
can see the masked identifier from the seller. What is no longer possible is enumeration.

**If you adopt this format, do not publish a bare hash of a low-entropy identifier.** The
field is the same shape either way, and only one of them is honest.

---

## 6. Adopting it

You need three things:

1. **An ed25519 keypair**, published at a stable URL. Rotating it invalidates historical
   receipts, so treat it as long-lived and keep the private half where your other secrets live.
2. **Sign on terminal states only** — delivered and refunded. Not on paid, not on pending.
3. **A verify endpoint, or none at all.** If you publish the key, anyone can already verify
   offline; an endpoint is a convenience, not a requirement. If you do publish one, verify
   against the key **in the receipt** rather than your own, so it is useful to more than you.

Ours accepts any receipt in this format, including yours:
`POST https://iomarkets.app/v1/verify` (add `?online=0` for a signature-only check).

Questions, corrections, or a second implementation: the reference implementation is
`src/receipt.ts` (signing, canonicalisation) and `src/verify.ts` (the three checks) in this
repo. **The format itself is free to use** — it is a data format and this document is the
whole of it; nothing here needs our permission or our code.
