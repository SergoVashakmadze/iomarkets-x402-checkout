// Small helpers around the x402 wire format: what the facilitator told us after
// settlement, and what the payer signed before it.

import { decodeSignedTransaction } from "algosdk";

export interface Settled { txid: string; payer?: string }

/** Parse the PAYMENT-RESPONSE header the middleware sets once the facilitator has settled. */
export function settledFromHeader(raw: string | null | undefined): Settled | undefined {
  if (!raw) return undefined;
  try {
    const d = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    if (d.success === false) return undefined;
    const txid = (d.transaction ?? d.txid ?? d.txHash) as string | undefined;
    if (!txid) return undefined;
    return { txid, payer: typeof d.payer === "string" ? d.payer : undefined };
  } catch {
    return undefined;
  }
}

/** Algorand txid + sender of the payment inside a payment header (before settlement). */
export function paymentTxn(header: string | null | undefined): { txid: string; sender: string } | undefined {
  if (!header) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload?: { paymentGroup?: unknown; paymentIndex?: unknown };
    };
    const group = decoded.payload?.paymentGroup;
    const index = decoded.payload?.paymentIndex;
    if (!Array.isArray(group) || typeof index !== "number") return undefined;
    const signed = group[index];
    if (typeof signed !== "string") return undefined;
    const txn = decodeSignedTransaction(Buffer.from(signed, "base64")).txn;
    return { txid: txn.txID(), sender: txn.sender.toString() };
  } catch {
    return undefined; // unreadable → let the facilitator reject it; never poison state with garbage
  }
}

/** Replay guard: remember payment txids for the validity window; reject repeats. */
/**
 * Refuses a settlement txid that has already been spent here.
 *
 * **Checking and recording are separate on purpose, and it matters.** The guard used to
 * record a txid the moment it was *presented*, in preflight, before the payment had
 * settled. If settlement then failed — a dropped connection, a facilitator hiccup —
 * the payer was permanently locked out: the abort said "payment already used" about a
 * payment that had never been used at all, and no order existed either.
 *
 * That is not a rare race. An Algorand `exact` payment is deterministic — same sender,
 * receiver, amount and validity window give the same txid — so a client that retries
 * inside the same round window presents *the identical transaction*, which is exactly
 * what a retry after a failed settle looks like. Hit on the first real order
 * (2026-08-29): three attempts, three "payment already used", zero USDC moved.
 *
 * So: `has()` asks, `record()` commits, and only a confirmed settlement commits.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = 15 * 60_000) {}

  /** Has this txid already been SETTLED here, inside the window? Read-only. */
  has(txid: string, now = Date.now()): boolean {
    const exp = this.seen.get(txid);
    return exp !== undefined && exp > now;
  }

  /** Burn this txid. Call only once the payment has actually settled. */
  record(txid: string, now = Date.now()): void {
    this.seen.set(txid, now + this.ttlMs);
    if (this.seen.size > 5_000) for (const [k, e] of this.seen) if (e <= now) this.seen.delete(k);
  }
}

/** Tiny fixed-window rate limiter for the free routes. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly perMinute: number, private readonly maxKeys = 50_000) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      // Keyed by client IP, so without this the map grows without bound and the
      // limiter meant to protect the box becomes the way to exhaust its memory.
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      this.hits.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    if (h.n >= this.perMinute) return false;
    h.n++;
    return true;
  }

  /** Drop finished windows; if they were all live, drop everything rather than grow. */
  private sweep(now: number): void {
    for (const [k, h] of this.hits) if (h.reset <= now) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }

  size(): number {
    return this.hits.size;
  }
}
