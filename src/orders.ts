// Order lifecycle: money first, then goods, refund on failure.
//
//   quote (free) ──pay via x402──▶ paid ──▶ fulfilling ──▶ delivered  (signed receipt)
//                                             └──▶ failed ──▶ refunded (signed receipt, refund txid)
//                                                         └──▶ refund_failed (manual; surfaced on the order)
//
// An order row is created only AFTER the facilitator reports a settled txid, so
// no goods can ever ship against an unsettled payment. Fulfilment is idempotent
// on the supplier side (our order id is their transaction id), so a crash mid-way
// resumes safely on restart (see resume()).

import { randomUUID } from "node:crypto";
import type { Db, OrderRow } from "./db.js";
import { floorInflatesPrice, formatUsdc, minSellableCostMicro, pricingFor, sellPriceMicro, toMicro, type PricingParams } from "./money.js";
import { checkPayout } from "./compliance.js";
import { ceilingMicro, limitsFor, usd, type Limits } from "./accounts.js";
import { hashRecipient, recipientPepper, signReceipt } from "./receipt.js";
import type { Refunder } from "./refunds.js";
import type { Offer, ProductType, Supplier } from "./suppliers/types.js";

export interface QuoteInput {
  type: ProductType;
  offerId: string;
  recipient: { phone?: string; iccid?: string; fields?: Record<string, string> };
  /** For range offers: amount in the recipient's local currency (major units). */
  amount?: number;
  /** payouts only: who is sending (KYC-lite; partner KYC reference above the threshold). */
  sender?: { name: string; country: string; reference?: string };
  /** payouts only: the paying address, when known at quote time (daily-total check). */
  payer?: string;
  /** Referrer's Algorand address — earns a share of margin if this order is delivered (src/referrals.ts). */
  ref?: string;
  /** The pay link this quote was made from, if any (src/growth.ts). */
  linkId?: string;
  /** Mask the phone in the quote view. A pay link is opened by whoever holds the URL,
   *  and the 402 body echoes the view — so a link must not publish the full number. */
  maskRecipient?: boolean;
}

/** Observers for the growth features. Called after the state change is written, and
 *  never allowed to throw into the order path — a referral bug must not strand a payer. */
export interface OrderHooks {
  onOrderCreated?(o: OrderRow, meta: { ref: string | null; linkId: string | null }): void;
  onTerminal?(o: OrderRow): void | Promise<void>;
}

export interface QuoteView {
  quoteId: string;
  type: ProductType;
  offer: { id: string; name: string; brand: string; brandName: string; country: string };
  recipient: { phone?: string; iccid?: string; fields?: Record<string, string> };
  delivers: string;
  settlement_estimate_seconds?: number; // e.g. "₹ 299 Jio 1 GB/day · 28 days" or "5 GB India eSIM, 30 days"
  price_usdc: string;
  expires_at: string;
  pay: { method: "x402"; endpoint: string; body: { quoteId: string } };
}

export class QuoteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "QuoteError"; }
}

export interface OrderServiceOptions {
  pricing: PricingParams;
  maxOrderUsd: number;
  /** Per-product-type per-order caps in USD; lowers maxOrderUsd for those types only. */
  typeMaxUsd?: Record<string, number>;
  quoteTtlSec: number;
  blockedCountries: string[];
  payout: { maxUsd: number; kycAboveUsd: number; recipientDailyUsd: number };
  /** Default per-payer daily ceiling; a business account may carry its own. */
  payerDailyUsd: number;
  receiptPrivateKey: string;
  ordersEndpoint: string;
  pollIntervalMs: number;
  timeoutMs: number;
  /** How long a supplier balance read is reused. The container healthcheck polls
   *  /health every 30s; an uncached read would be ~2,900 calls a day to learn a
   *  number that only moves when we sell something or top up. */
  floatCacheMs?: number;
  log?: (msg: string) => void;
  hooks?: OrderHooks;
}

/** What a float can actually pay for right now. `null` float = unreadable. */
export interface FloatStatus {
  /** The supplier wallet balance, or null if the supplier could not be reached. */
  floatMicro: number | null;
  /** Cost of settled-but-undelivered orders — already spoken for. */
  committedMicro: number;
  /** floatMicro − committedMicro, floored at 0. Null when the float is unreadable. */
  availableMicro: number | null;
}

export class OrderService {
  private readonly log: (msg: string) => void;
  /** Single-flight per order: concurrent process() calls share one run. */
  private readonly inFlight = new Map<string, Promise<OrderRow>>();
  /** One cache per wallet, keyed by the supplier that fills it. */
  private readonly floatCaches = new Map<string, { at: number; micro: number | null }>();
  /** Derived once from the receipt key. See recipientPepper() for why it is derived
   *  rather than configured. */
  private readonly pepper: string;
  constructor(
    private readonly db: Db,
    private readonly supplier: Supplier,
    private readonly refunder: Refunder,
    private readonly opts: OrderServiceOptions,
  ) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.pepper = recipientPepper(opts.receiptPrivateKey);
  }

  /**
   * The recipient identifier as it is stored and published. Peppered, so a receipt —
   * a document this service actively tells agents to keep and hand around — cannot be
   * turned back into a phone number by anyone but us. Exposed so src/app.ts hashes the
   * same way; the per-recipient structuring ceiling only works if it does.
   */
  recipientHash(r: Parameters<typeof recipientKeyOf>[0]): string {
    return recipientHashOf(r, this.pepper);
  }

  /**
   * Effective limits for a payer address. Unknown or absent → the standard tier,
   * i.e. exactly the behaviour before business accounts existed. The `payer` given
   * at quote time is an unauthenticated hint; src/app.ts re-resolves this against
   * the REAL settled payer in preflight, before any money moves.
   */
  limitsForPayer(payer: string | undefined): Limits {
    return limitsFor(this.db.accountForPayer(payer), {
      maxOrderMicro: toMicro(this.opts.maxOrderUsd),
      payoutMaxMicro: toMicro(this.opts.payout.maxUsd),
      dailyMicro: toMicro(this.opts.payerDailyUsd),
      typeMaxMicro: Object.fromEntries(
        Object.entries(this.opts.typeMaxUsd ?? {}).map(([t, usdValue]) => [t, toMicro(usdValue)]),
      ),
    });
  }

  /**
   * Housekeeping on the path that creates the garbage, throttled.
   *
   * Deliberately not a setInterval: a timer has to be created, unref'd and torn down,
   * does not exist in tests, and would not run at all in a process that only ever
   * serves quotes. Sweeping from the writer means the cleanup rate tracks the rate of
   * the thing being cleaned up, which is the property that matters under a flood.
   */
  private lastPruneAt = 0;
  private maybePruneQuotes(intervalMs = 10 * 60_000): void {
    const now = Date.now();
    if (now - this.lastPruneAt < intervalMs) return;
    this.lastPruneAt = now;
    try {
      const n = this.db.pruneExpiredQuotes();
      if (n) this.log(`[housekeeping] pruned ${n} expired unpaid quotes`);
    } catch (e) {
      // Never fail a paying customer's quote because a DELETE did not work.
      this.log(`[housekeeping] quote prune failed: ${(e as Error).message}`);
    }
  }

  // ── the float ───────────────────────────────────────────────────────────────
  /**
   * The supplier balance, cached. Shared by /health and by quote() so that the number
   * the service publishes and the number it refuses on are the same number.
   *
   * Never throws. A supplier that cannot be reached yields `null`, which every caller
   * reads as "unknown" rather than as "empty" — refusing to quote because a balance
   * endpoint blipped would be a self-inflicted outage, and the settle-then-deliver
   * path still refunds a payer whose order cannot be filled.
   */
  /**
   * The balance of the wallet that fills `type`, cached per wallet.
   *
   * Never throws. A supplier that cannot be reached yields `null`, which every caller
   * reads as "unknown" rather than as "empty" — refusing to quote because a balance
   * endpoint blipped would be a self-inflicted outage, and the settle-then-deliver
   * path still refunds a payer whose order cannot be filled.
   */
  async supplierFloatMicro(type: ProductType = "topup"): Promise<number | null> {
    const ttl = this.opts.floatCacheMs ?? 60_000;
    const group = this.floatGroup(type);
    const cached = this.floatCaches.get(group);
    if (cached && Date.now() - cached.at < ttl) return cached.micro;
    let micro: number | null = null;
    try {
      const s = this.supplier as { balanceMicroForType?: (t: ProductType) => Promise<number> | null };
      // `balanceMicroForType` returns null when no supplier is wired for the type,
      // which is a different thing from a balance of zero and must not read as one.
      const read = s.balanceMicroForType ? s.balanceMicroForType(type) : this.supplier.balanceMicro();
      micro = read === null ? null : await read;
    } catch { micro = null; }
    this.floatCaches.set(group, { at: Date.now(), micro });
    return micro;
  }

  /** Which wallet fills this type. Falls back to one shared float for a bare Supplier. */
  private floatGroup(type: ProductType): string {
    const s = this.supplier as { floatGroupFor?: (t: ProductType) => string };
    return s.floatGroupFor?.(type) ?? "default";
  }

  /**
   * The float that fills `type`, what it already owes, and what is left.
   *
   * Commitments are netted per WALLET, not per product type: two types served by one
   * supplier draw on one balance and must be summed, while a payout in flight must not
   * make a top-up unaffordable.
   */
  async floatStatus(type: ProductType = "topup"): Promise<FloatStatus> {
    const floatMicro = await this.supplierFloatMicro(type);
    const group = this.floatGroup(type);
    const committedMicro = this.db.committedCostByType()
      .filter((r) => this.floatGroup(r.type as ProductType) === group)
      .reduce((sum, r) => sum + r.micro, 0);
    return {
      floatMicro,
      committedMicro,
      availableMicro: floatMicro === null ? null : Math.max(0, floatMicro - committedMicro),
    };
  }

  // ── quotes ──────────────────────────────────────────────────────────────────
  async quote(input: QuoteInput): Promise<QuoteView> {
    this.maybePruneQuotes();
    const offer = await this.supplier.getOffer(input.type, input.offerId);
    if (!offer) throw new QuoteError("unknown offer", 404);
    if (this.opts.blockedCountries.includes(offer.country)) throw new QuoteError("destination not supported", 403);

    const recipient: QuoteInput["recipient"] & { sender?: QuoteInput["sender"]; sender_account?: string } = {};
    if (input.type === "topup") {
      if (!input.recipient.phone) throw new QuoteError("recipient.phone required");
      recipient.phone = input.recipient.phone;
    } else if (input.type === "bill" || input.type === "payout") {
      // A bill is identified by a meter or account number, NOT a phone. This branch used
      // to demand `recipient.phone` for bills and never check `requiredFields`, which
      // was backwards on both counts: it refused every valid bill and would have let an
      // account-less one through to the supplier after the payer had settled.
      const fields = input.recipient.fields ?? {};
      const missing = (offer.requiredFields ?? []).filter((f) => !fields[f]);
      if (missing.length) throw new QuoteError(`recipient.fields missing: ${missing.join(", ")}`);
      recipient.fields = fields;
      if (input.recipient.phone) recipient.phone = input.recipient.phone;
    } else if (input.recipient.iccid) {
      recipient.iccid = input.recipient.iccid; // esim
    }
    if (input.type === "payout") {
      // A business account is itself the sender, so a batch file need not repeat it
      // on every row. An explicit sender still wins — a partner paying on behalf of
      // its own client must be able to say so.
      //
      // ⚠️ `input.payer` is an UNAUTHENTICATED HINT at quote time. Filling the sender
      // from the account it names, and stopping there, let a stranger quote a payout
      // carrying an onboarded business's legal name and then settle it from their own
      // wallet — an international payment attributed to a KYB'd company that never
      // authorised it. So the quote records WHICH account the sender came from, and
      // preflight refuses unless the real settled payer belongs to that same account
      // (src/app.ts). A sender the caller typed themselves carries no such binding,
      // because it claims nothing about anyone we have onboarded.
      const l = this.limitsForPayer(input.payer);
      if (input.sender) recipient.sender = input.sender;
      else if (l.senderDefaults && l.accountId) {
        recipient.sender = { name: l.senderDefaults.name, country: l.senderDefaults.country };
        recipient.sender_account = l.accountId;
      }
    }

    const { costMicro, delivers } = costFor(offer, input.amount);
    // The markup can differ per product type — an eSIM is not priced like airtime.
    // Resolved once here so the refusal message, the minimum and the price all agree.
    const pricing = pricingFor(this.opts.pricing, offer.type);

    // Refuse anything the MIN_ORDER_USD floor would price rather than the markup.
    // Measured on production: the cheapest NG offer delivered 49.91 NGN (~$0.036) for
    // $0.50 — a 13.7x markup on an offer that prints the local amount beside the price.
    // The floor is right (below it a refund costs more than the order); selling into it
    // is not. See floorInflatesPrice() for why this is the gift-card lesson again.
    if (floorInflatesPrice(costMicro, pricing)) {
      const min = minSellableCostMicro(pricing);
      throw new QuoteError(
        offer.priceType === "range"
          ? `amount too small to price fairly — the ${usd(toMicro(pricing.minOrderUsd))} order minimum ` +
            `would be most of what you pay. Ask for at least about ${usd(sellPriceMicro(min, pricing))} worth.`
          : `this offer is too small to price fairly against the ${usd(toMicro(pricing.minOrderUsd))} ` +
            `order minimum — pick a larger bundle`,
      );
    }

    const priceMicro = sellPriceMicro(costMicro, pricing);
    const limits = this.limitsForPayer(input.payer);
    if (limits.blocked) throw new QuoteError(limits.blocked, 403);
    const ceiling = ceilingMicro(limits, input.type);
    if (priceMicro > ceiling) throw new QuoteError(`order exceeds the per-order limit of ${usd(ceiling)}`);

    // **Do not quote what the float cannot buy.** Everything else in this service is
    // built on settle-then-deliver: the payer's USDC lands first, and if delivery then
    // fails we refund on chain. That promise is kept, but a refund is not a good
    // outcome — the payer waited, paid a fee, got nothing, and we spent gas to undo it.
    // The float is knowable BEFORE the payer commits, so a quote we cannot fill is a
    // refusal we owe them up front rather than an apology afterwards.
    //
    // Compared against the supplier COST, not the sale price: the float buys goods at
    // cost, and the markup lands in PAY_TO, not here. Net of orders already settled and
    // not yet delivered, or two orders each pass a check their sum fails.
    //
    // Payouts are checked too, against the PARTNER's wallet rather than the goods
    // float. They were exempt when this shipped, on the reasoning that they are filled
    // from a different balance — true, and the wrong conclusion. Measured 2026-09-01:
    // Bitnob authenticates, publishes priceable NG corridors, and holds
    // **0.000000 USDC**. Quoting against that would settle a payer's USDC and then fail
    // to finalise for want of funds — a $156 ticket stranded, which is the largest one
    // we sell. A different wallet needs a different check, not no check.
    {
      const { availableMicro } = await this.floatStatus(input.type);
      if (availableMicro !== null && costMicro > availableMicro) {
        // 503, not 400: the caller did nothing wrong and the same request will work
        // once the float is topped up. `Retry-After` is not knowable, so we say the
        // number instead — an agent can decide whether to shrink the order or leave.
        throw new QuoteError(
          `${input.type === "payout" ? "payout partner" : "supplier"} float is too low to fill this order right now ` +
            `(${usd(availableMicro)} available). Smaller orders may still go through; see /health.`,
          503,
        );
      }
    }

    if (input.type === "payout") {
      // A business account aggregates the daily total across ALL its bound addresses,
      // which is stricter than per-address: rotating wallets must not reset the clock.
      const spentToday = limits.accountId
        ? this.db.accountSpentTodayMicro(limits.accountId, "payout")
        : input.payer ? this.db.payerSpentTodayMicro(input.payer, "payout") : 0;
      const c = checkPayout({
        country: offer.country, priceMicro, sender: recipient.sender,
        payerPayoutsTodayMicro: spentToday,
        recipientPayoutsTodayMicro: this.db.recipientSpentTodayMicro(this.recipientHash(recipient)),
        recipientDailyMaxUsd: this.opts.payout.recipientDailyUsd,
        blockedCountries: this.opts.blockedCountries,
        maxUsd: ceiling / 1_000_000, kycAboveUsd: this.opts.payout.kycAboveUsd,
        account: limits.accountId && limits.kybReference ? { id: limits.accountId, kybReference: limits.kybReference } : undefined,
      });
      if (!c.ok) throw new QuoteError(c.reason, c.status);
    }

    const now = new Date();
    const expires = new Date(now.getTime() + this.opts.quoteTtlSec * 1000);
    const quoteId = `q_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const view: QuoteView = {
      quoteId,
      type: input.type,
      offer: { id: offer.id, name: offer.name, brand: offer.brand, brandName: offer.brandName, country: offer.country },
      recipient: { phone: input.maskRecipient ? maskTail(recipient.phone) : recipient.phone, iccid: recipient.iccid, fields: input.type === "payout" ? maskFields(recipient.fields) : undefined },
      delivers,
      settlement_estimate_seconds: offer.settlementSeconds,
      price_usdc: formatUsdc(priceMicro),
      expires_at: expires.toISOString(),
      pay: { method: "x402", endpoint: this.opts.ordersEndpoint, body: { quoteId } },
    };
    this.db.insertQuote({
      id: quoteId, type: input.type, offer_id: offer.id, country: offer.country, brand: offer.brand,
      recipient_json: JSON.stringify(recipient), cost_micro: costMicro, price_micro: priceMicro,
      summary_json: JSON.stringify(view), created_at: now.toISOString(), expires_at: expires.toISOString(),
    });
    this.db.setQuoteMeta(quoteId, { ref: input.ref, linkId: input.linkId });
    return view;
  }

  /** Is this quote payable right now? Used BEFORE payment (hook + dynamic price). */
  validQuote(quoteId: string): { ok: true; priceMicro: number } | { ok: false; reason: string } {
    const q = this.db.getQuote(quoteId);
    if (!q) return { ok: false, reason: "unknown quoteId" };
    if (q.consumed_by) return { ok: false, reason: "quote already used" };
    if (new Date(q.expires_at).getTime() <= Date.now()) return { ok: false, reason: "quote expired — request a new one" };
    return { ok: true, priceMicro: q.price_micro };
  }

  // ── orders ──────────────────────────────────────────────────────────────────
  /**
   * Called once the facilitator has SETTLED the payment. Creates the order and
   * starts fulfilment in the background. If the quote was consumed by a racing
   * payment, the order is created as `failed` so the refund path returns the money.
   */
  createPaidOrder(quoteId: string, payer: string, settlementTxid: string): OrderRow {
    const existing = this.db.getOrderBySettlement(settlementTxid);
    if (existing) return existing; // idempotent on the settlement txid
    const q = this.db.getQuote(quoteId);
    if (!q) throw new Error("quote vanished after settlement"); // hook guarantees existence
    const id = `ord_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const claimed = this.db.consumeQuote(quoteId, id);
    const recipient = JSON.parse(q.recipient_json) as QuoteInput["recipient"];
    const now = new Date().toISOString();
    const recipientKey = recipientKeyOf(recipient) || q.offer_id;
    const row: OrderRow = {
      id, quote_id: quoteId, payer, type: q.type, offer_id: q.offer_id, country: q.country, brand: q.brand,
      recipient_json: q.recipient_json, recipient_hash: hashRecipient(recipientKey, this.pepper),
      cost_micro: q.cost_micro, price_micro: q.price_micro, supplier: this.supplier.name, supplier_tx_id: null,
      status: claimed ? "paid" : "failed", settlement_txid: settlementTxid, confirmation_json: null,
      error: claimed ? null : "quote already used by another payment", receipt_json: null, refund_txid: null, refund_error: null,
      created_at: now, updated_at: now, delivered_at: null,
    };
    this.db.insertOrder(row);
    const meta = this.db.getQuoteMeta(quoteId);
    if (claimed && meta?.link_id) this.db.usePayLink(meta.link_id);
    this.hook("onOrderCreated", () => this.opts.hooks?.onOrderCreated?.(row, { ref: meta?.ref ?? null, linkId: meta?.link_id ?? null }));
    this.log(`[order ${id}] ${row.status} ${q.type} ${q.brand}/${q.country} ${formatUsdc(q.price_micro)} USDC payer=${payer.slice(0, 8)}… tx=${settlementTxid.slice(0, 8)}…`);
    void this.process(id);
    return row;
  }

  /** Drive one order to a terminal state. Safe to call repeatedly and concurrently. */
  process(orderId: string): Promise<OrderRow> {
    const running = this.inFlight.get(orderId);
    if (running) return running;
    const run = this.processOnce(orderId).finally(() => this.inFlight.delete(orderId));
    this.inFlight.set(orderId, run);
    return run;
  }

  private async processOnce(orderId: string): Promise<OrderRow> {
    let o = this.db.getOrder(orderId)!;
    try {
      if (o.status === "paid") {
        this.db.updateOrder(o.id, { status: "fulfilling" });
        const stored = JSON.parse(o.recipient_json) as QuoteInput["recipient"] & { sender?: QuoteInput["sender"] };
        const { sender, ...recipient } = stored;
        let r;
        try {
          r = await this.supplier.purchase({ orderId: o.id, type: o.type as ProductType, offerId: o.offer_id, recipient, sender, costMicro: o.cost_micro });
        } catch (e) {
          // Unknown outcome (timeout etc.): the supplier may or may not have created the
          // transaction under our id. Poll by our id before deciding it failed.
          this.log(`[order ${o.id}] purchase error: ${(e as Error).message}`);
          r = await this.safeStatus(o, o.id);
          if (!r) throw e;
        }
        this.db.updateOrder(o.id, { supplier_tx_id: r.supplierTxId });
        o = this.db.getOrder(o.id)!;
        await this.settleResult(o, r);
        o = this.db.getOrder(o.id)!;
      }
      if (o.status === "fulfilling") {
        const deadline = new Date(o.created_at).getTime() + this.opts.timeoutMs;
        // Poll at least once BEFORE honouring the deadline. On resume after downtime
        // longer than the timeout it has already passed, and declaring failure without
        // asking would refund a delivery that succeeded while we were down — paying the
        // supplier cost and returning the payer's money for the same order.
        for (;;) {
          const r = await this.supplier.getPurchase(o.type as ProductType, o.supplier_tx_id ?? o.id);
          if (r.status !== "pending") { await this.settleResult(o, r); break; }
          if (Date.now() >= deadline) break;
          await sleep(this.opts.pollIntervalMs);
        }
        o = this.db.getOrder(o.id)!;
        if (o.status === "fulfilling") this.markFailed(o, "delivery timed out at supplier");
        o = this.db.getOrder(o.id)!;
      }
      if (o.status === "failed") {
        await this.refund(o);
        o = this.db.getOrder(o.id)!;
      }
      if (["delivered", "refunded", "refund_failed"].includes(o.status)) {
        const done = o;
        this.hook("onTerminal", () => this.opts.hooks?.onTerminal?.(done));
      }
    } catch (e) {
      this.log(`[order ${o.id}] processing error: ${(e as Error).message}`);
      o = this.db.getOrder(o.id)!;
      if (o.status === "paid" || o.status === "fulfilling") {
        this.markFailed(o, (e as Error).message);
        await this.refund(this.db.getOrder(o.id)!).catch(() => undefined);
      }
    }
    return this.db.getOrder(orderId)!;
  }

  /** Run an observer without letting it fail the order. Async observers are not awaited. */
  private hook(name: string, fn: () => unknown): void {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((e) => this.log(`[hook ${name}] ${(e as Error).message}`));
    } catch (e) {
      this.log(`[hook ${name}] ${(e as Error).message}`);
    }
  }

  /** On boot: pick up anything non-terminal. */
  async resume(): Promise<void> {
    for (const o of this.db.openOrders()) {
      this.log(`[order ${o.id}] resuming from ${o.status}`);
      void this.process(o.id);
    }
  }

  private async safeStatus(o: OrderRow, id: string) {
    try { return await this.supplier.getPurchase(o.type as ProductType, id); } catch { return undefined; }
  }

  private async settleResult(o: OrderRow, r: { status: string; confirmation?: Record<string, unknown>; error?: string; supplierTxId: string }): Promise<void> {
    if (r.status === "delivered") {
      const receipt = signReceipt({
        order_id: o.id, status: "delivered", product_type: o.type, offer_id: o.offer_id, country: o.country, brand: o.brand,
        recipient_hash: o.recipient_hash, amount_usdc: formatUsdc(o.price_micro), payer: o.payer, settlement_txid: o.settlement_txid,
        supplier: o.supplier, supplier_tx_id: r.supplierTxId, refund_txid: "", issued_at: new Date().toISOString(),
      }, this.opts.receiptPrivateKey);
      this.db.updateOrder(o.id, {
        status: "delivered", supplier_tx_id: r.supplierTxId, confirmation_json: JSON.stringify(r.confirmation ?? {}),
        receipt_json: JSON.stringify(receipt), delivered_at: new Date().toISOString(),
      });
      this.log(`[order ${o.id}] delivered (${r.supplierTxId})`);
    } else if (r.status === "failed") {
      this.markFailed({ ...o, supplier_tx_id: r.supplierTxId }, r.error ?? "supplier failed");
    }
  }

  private markFailed(o: OrderRow, error: string): void {
    this.db.updateOrder(o.id, { status: "failed", error, supplier_tx_id: o.supplier_tx_id });
    this.log(`[order ${o.id}] failed: ${error}`);
  }

  private async refund(o: OrderRow): Promise<void> {
    try {
      const txid = await this.refunder.send(o.id, o.payer, o.price_micro);
      const receipt = signReceipt({
        order_id: o.id, status: "refunded", product_type: o.type, offer_id: o.offer_id, country: o.country, brand: o.brand,
        recipient_hash: o.recipient_hash, amount_usdc: formatUsdc(o.price_micro), payer: o.payer, settlement_txid: o.settlement_txid,
        supplier: o.supplier, supplier_tx_id: o.supplier_tx_id ?? "", refund_txid: txid, issued_at: new Date().toISOString(),
      }, this.opts.receiptPrivateKey);
      this.db.recordRefund({ order_id: o.id, payer: o.payer, amount_micro: o.price_micro, txid, status: "sent" });
      this.db.updateOrder(o.id, { status: "refunded", refund_txid: txid, receipt_json: JSON.stringify(receipt) });
      this.log(`[order ${o.id}] refunded ${formatUsdc(o.price_micro)} USDC → ${o.payer.slice(0, 8)}… (${txid})`);
    } catch (e) {
      this.db.recordRefund({ order_id: o.id, payer: o.payer, amount_micro: o.price_micro, txid: null, status: "failed", error: (e as Error).message });
      this.db.updateOrder(o.id, { status: "refund_failed", refund_error: (e as Error).message });
      this.log(`[order ${o.id}] REFUND FAILED — manual action needed: ${(e as Error).message}`);
    }
  }
}

/** Supplier cost for an offer (+ what the recipient gets), validating range amounts. */
export function costFor(offer: Offer, amount?: number): { costMicro: number; delivers: string } {
  const what = offer.dataGB ? `${offer.name}` : offer.name;
  if (offer.priceType === "fixed") {
    if (offer.costMicro === undefined) throw new QuoteError("offer has no price");
    const local = offer.sendFixed && offer.sendCurrency ? `${offer.sendCurrency} ${offer.sendFixed} · ` : "";
    return { costMicro: offer.costMicro, delivers: `${local}${what}` };
  }
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) throw new QuoteError("amount (in recipient's local currency) required for this offer");
  if (offer.sendMin !== undefined && amount < offer.sendMin) throw new QuoteError(`amount below minimum ${offer.sendMin} ${offer.sendCurrency}`);
  if (offer.sendMax !== undefined && amount > offer.sendMax) throw new QuoteError(`amount above maximum ${offer.sendMax} ${offer.sendCurrency}`);
  if (offer.costPerSendUnitMicro === undefined) throw new QuoteError("offer has no rate");
  const costMicro = Math.ceil(amount * offer.costPerSendUnitMicro);
  if (offer.costMaxMicro !== undefined && costMicro > offer.costMaxMicro) throw new QuoteError("amount above supplier maximum");
  return { costMicro, delivers: `${offer.sendCurrency} ${amount} · ${what}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const maskTail = (s?: string): string | undefined => (s ? `${"•".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : undefined);

/** Show only the last 4 characters of each recipient field (account numbers, VPAs…). */
export function maskFields(f?: Record<string, string>): Record<string, string> | undefined {
  if (!f) return undefined;
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === "full_name" ? v : `${"•".repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`]));
}

/**
 * The recipient's identity for counting purposes. Derived in ONE place so the daily
 * per-recipient ceiling checked at quote time and the `recipient_hash` written on the
 * order can never disagree about who was paid.
 */
export function recipientKeyOf(r: { phone?: string; iccid?: string; fields?: Record<string, string> }): string {
  return r.phone ?? r.iccid ?? Object.values(r.fields ?? {}).join("|") ?? "";
}
/** Peppered — see OrderService.recipientHash and receipt.ts. */
export const recipientHashOf = (r: Parameters<typeof recipientKeyOf>[0], pepper: string): string =>
  hashRecipient(recipientKeyOf(r), pepper);
