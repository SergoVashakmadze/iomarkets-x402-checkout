// Referral share — the distribution half of the product.
//
// The binding constraint on volume is that the buyer must already hold USDC on
// Algorand, and the people who most reliably do are the other
// teams building x402 agents. This makes each of them a reseller: any quote or pay
// link may name a `ref` Algorand address, and when that order is DELIVERED the ref
// earns a share of our net margin, sent on-chain in USDC (never with order ids in the note).
//
// The rules that keep it from costing more than it earns:
//
// - **A share of MARGIN, never of price.** price − cost − what the float cost to
//   acquire. An order can never pay out more than it made, so a referral ring built
//   from a buyer's own second wallet is, at worst, a discount bounded by our margin.
// - **Delivered only.** A refunded order voids its share; nothing is owed on money we
//   gave back.
// - **Self-referral is void.** ref === payer earns nothing.
// - **Refunds come first.** Shares are sent from the refund hot wallet (PAY_TO is an
//   address with no key on this box), so a payout that would take that wallet below
//   REFERRAL_REFUND_RESERVE_USD is deferred, not sent. A buyer owed a refund outranks a
//   referrer owed a commission, every time.
// - **Capped per UTC day, separately from refunds**, with the same serialised
//   check-then-send discipline as src/refunds.ts.
// - **Batched per referrer** above REFERRAL_MIN_PAYOUT_USD, so a $0.03 share does not
//   cost a transaction of its own.
// - **Off unless REFERRAL_SHARE_BPS > 0.** Shipping this code moves no money.

import { DailyCap } from "./refunds.js";
import type { Db, OrderRow } from "./db.js";
import { formatUsdc } from "./money.js";

export interface ReferralWallet {
  /** The hot wallet's USDC balance in micro-USDC, or null when it cannot be read. */
  balanceMicro(): Promise<number | null>;
  send(to: string, amountMicro: number, note: string): Promise<string>;
}

export interface ReferralOptions {
  /** Share of NET margin, in bps. 0 disables the programme. */
  shareBps: number;
  minPayoutMicro: number;
  dailyCapMicro: number;
  /** The hot wallet never drops below this on account of a referral payout. */
  refundReserveMicro: number;
  /** Cost of acquiring supplier float (config.pricing.floatAcquisitionBps). */
  floatAcquisitionBps: number;
  notePrefix: string;
  log?: (msg: string) => void;
}

/** What one delivered order pays its referrer. Never negative, never more than margin. */
export function referralShareMicro(priceMicro: number, costMicro: number, shareBps: number, floatAcquisitionBps = 0): number {
  const net = priceMicro - costMicro - Math.ceil((costMicro * floatAcquisitionBps) / 10_000);
  if (net <= 0 || shareBps <= 0) return 0;
  return Math.floor((net * Math.min(shareBps, 10_000)) / 10_000);
}

export const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/;

export class ReferralService {
  private readonly log: (msg: string) => void;
  private readonly cap: DailyCap;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    /** null = no hot wallet on this box; shares accrue as `owed` and are never sent. */
    private readonly wallet: ReferralWallet | null,
    private readonly opts: ReferralOptions,
  ) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.cap = new DailyCap(opts.dailyCapMicro, () => db.referralsPaidTodayMicro());
  }

  get enabled(): boolean {
    return this.opts.shareBps > 0;
  }

  /** The programme terms, as published on /v1/referrals and in /agent.md. */
  terms() {
    return {
      enabled: this.enabled,
      share_of_net_margin_bps: this.opts.shareBps,
      paid_on: "delivered orders only — refunded orders and self-referrals earn nothing",
      min_payout_usdc: formatUsdc(this.opts.minPayoutMicro),
      payouts: this.wallet ? "automatic, on-chain USDC, batched per referrer" : "accrued; sent manually (no hot wallet on this server)",
      requires: "the ref address must be opted in to USDC (ASA 31566704 on mainnet)",
    };
  }

  /** Called once, when a settled payment becomes an order. */
  onOrderCreated(o: OrderRow, ref: string | null | undefined): void {
    if (!this.enabled || !ref || !ALGORAND_ADDRESS.test(ref)) return;
    const self = ref === o.payer;
    this.db.insertReferral({
      order_id: o.id, ref, payer: o.payer, type: o.type,
      share_micro: self ? 0 : referralShareMicro(o.price_micro, o.cost_micro, this.opts.shareBps, this.opts.floatAcquisitionBps),
      status: self ? "void" : "pending",
      created_at: new Date().toISOString(),
    });
    if (self) this.db.updateReferrals([o.id], { error: "self-referral" });
  }

  /** Called whenever an order reaches a terminal state. Never throws into the order path. */
  onTerminal(o: OrderRow): Promise<void> {
    const r = this.db.getReferral(o.id);
    if (!r || r.status !== "pending") return Promise.resolve();
    if (o.status !== "delivered") {
      this.db.updateReferrals([o.id], { status: "void", error: `order ${o.status}` });
      return Promise.resolve();
    }
    this.db.updateReferrals([o.id], { status: r.share_micro > 0 ? "owed" : "void", error: r.share_micro > 0 ? null : "no margin on this order" });
    return r.share_micro > 0 ? this.sweep(r.ref) : Promise.resolve();
  }

  /** Send everything owed to one referrer, if it clears the minimum, the cap and the reserve. */
  sweep(ref: string): Promise<void> {
    const run = this.queue.then(() => this.sweepOne(ref), () => this.sweepOne(ref));
    this.queue = run.catch(() => undefined);
    return run.catch((e) => this.log(`[referral ${ref.slice(0, 8)}…] ${(e as Error).message}`));
  }

  /** Retry every deferred share — on boot, and on a slow timer from src/server.ts. */
  async sweepAll(): Promise<void> {
    for (const ref of this.db.refsWithOwed()) await this.sweep(ref);
  }

  private async sweepOne(ref: string): Promise<void> {
    if (!this.wallet) return;
    const owed = this.db.owedReferrals(ref);
    const total = owed.reduce((s, r) => s + r.share_micro, 0);
    if (total <= 0 || total < this.opts.minPayoutMicro) return;
    const ids = owed.map((r) => r.order_id);

    const balance = await this.wallet.balanceMicro();
    if (balance === null || balance - total < this.opts.refundReserveMicro) {
      // Deferred, not failed: the next delivery for this referrer tries again.
      this.db.updateReferrals(ids, { error: "deferred — hot wallet at its refund reserve" });
      this.log(`[referral ${ref.slice(0, 8)}…] deferred ${formatUsdc(total)} USDC: hot wallet ${balance === null ? "unreadable" : formatUsdc(balance)} vs reserve ${formatUsdc(this.opts.refundReserveMicro)}`);
      return;
    }
    try {
      this.cap.reserve(total);
    } catch {
      this.db.updateReferrals(ids, { error: "deferred — daily referral cap reached" });
      return;
    }
    try {
      // ⚠️ Never an order id. A refund note carries one safely because a refunded order
      // delivered nothing; these orders DELIVERED, and their id is the capability that
      // reads an eSIM LPA from GET /v1/orders/:id. A note is public forever.
      const note = `${this.opts.notePrefix} referral share · ${ids.length} delivered order${ids.length === 1 ? "" : "s"}`;
      const txid = await this.wallet.send(ref, total, note);
      this.db.updateReferrals(ids, { status: "paid", txid, error: null });
      this.log(`[referral ${ref.slice(0, 8)}…] paid ${formatUsdc(total)} USDC for ${ids.length} order(s) (${txid})`);
    } catch (e) {
      this.cap.release(total);
      // Most often: the referrer never opted in to USDC. Stays owed, visible on /v1/referrals/:ref.
      this.db.updateReferrals(ids, { error: `send failed: ${(e as Error).message}`.slice(0, 300) });
      throw e;
    }
  }

  /** Public summary for one referrer. Everything here is derivable from the chain anyway. */
  summary(ref: string) {
    const s = this.db.referralSummary(ref);
    const lastError = this.db.owedReferrals(ref).find((r) => r.error)?.error ?? null;
    return {
      ref,
      orders_referred: s.orders,
      pending_usdc: formatUsdc(s.pending_micro),
      owed_usdc: formatUsdc(s.owed_micro),
      paid_usdc: formatUsdc(s.paid_micro),
      ...(lastError ? { note: lastError } : {}),
      payouts: s.payouts.map((p) => ({ txid: p.txid, amount_usdc: formatUsdc(p.micro), at: p.at })),
    };
  }
}
