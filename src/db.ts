// Persistence on Node's built-in SQLite (node:sqlite, Node ≥ 22.5) — no native
// build step, one file, WAL mode. Money columns are integer micro-USDC.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type OrderStatus = "paid" | "fulfilling" | "delivered" | "failed" | "refunded" | "refund_failed";

import type { AccountRow } from "./accounts.js";
export type { AccountRow };

export interface QuoteRow {
  id: string;
  type: string;
  offer_id: string;
  country: string;
  brand: string;
  recipient_json: string;
  cost_micro: number;
  price_micro: number;
  summary_json: string;
  created_at: string;
  expires_at: string;
  consumed_by: string | null;
}

export interface OrderRow {
  id: string;
  quote_id: string;
  payer: string;
  type: string;
  offer_id: string;
  country: string;
  brand: string;
  recipient_json: string;
  recipient_hash: string;
  cost_micro: number;
  price_micro: number;
  supplier: string;
  supplier_tx_id: string | null;
  status: OrderStatus;
  settlement_txid: string;
  confirmation_json: string | null;
  error: string | null;
  receipt_json: string | null;
  refund_txid: string | null;
  refund_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface PayLinkRow {
  id: string; type: string; offer_id: string; country: string; brand: string; title: string;
  recipient_json: string; amount: number | null; note: string | null; ref: string | null;
  max_uses: number; uses: number; created_at: string; expires_at: string;
}

/** pending = order not yet terminal · owed = delivered, not yet sent · paid · void = refunded or self-referral */
export type ReferralStatus = "pending" | "owed" | "paid" | "void";
export interface ReferralRow {
  order_id: string; ref: string; payer: string; type: string; share_micro: number;
  status: ReferralStatus; txid: string | null; error: string | null; created_at: string; updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, offer_id TEXT NOT NULL, country TEXT NOT NULL, brand TEXT NOT NULL,
  recipient_json TEXT NOT NULL, cost_micro INTEGER NOT NULL, price_micro INTEGER NOT NULL, summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_by TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, payer TEXT NOT NULL, type TEXT NOT NULL, offer_id TEXT NOT NULL,
  country TEXT NOT NULL, brand TEXT NOT NULL, recipient_json TEXT NOT NULL, recipient_hash TEXT NOT NULL,
  cost_micro INTEGER NOT NULL, price_micro INTEGER NOT NULL, supplier TEXT NOT NULL, supplier_tx_id TEXT,
  status TEXT NOT NULL, settlement_txid TEXT NOT NULL UNIQUE, confirmation_json TEXT, error TEXT, receipt_json TEXT,
  refund_txid TEXT, refund_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_payer_created ON orders(payer, created_at);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_recipient_created ON orders(recipient_hash, created_at);
CREATE TABLE IF NOT EXISTS refunds (
  order_id TEXT PRIMARY KEY, payer TEXT NOT NULL, amount_micro INTEGER NOT NULL, txid TEXT, status TEXT NOT NULL,
  error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, kyb_reference TEXT NOT NULL,
  status TEXT NOT NULL, max_order_micro INTEGER, payout_max_micro INTEGER, daily_micro INTEGER,
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_payers (
  payer TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_payers_account ON account_payers(account_id);
-- Growth surfaces (src/growth.ts). Separate tables rather than new columns, so an
-- existing production database picks them up with CREATE IF NOT EXISTS and no migration.
CREATE TABLE IF NOT EXISTS quote_meta (
  quote_id TEXT PRIMARY KEY, ref TEXT, link_id TEXT
);
CREATE TABLE IF NOT EXISTS pay_links (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, offer_id TEXT NOT NULL, country TEXT NOT NULL, brand TEXT NOT NULL,
  title TEXT NOT NULL, recipient_json TEXT NOT NULL, amount REAL, note TEXT, ref TEXT,
  max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  order_id TEXT PRIMARY KEY, ref TEXT NOT NULL, payer TEXT NOT NULL, type TEXT NOT NULL,
  share_micro INTEGER NOT NULL, status TEXT NOT NULL, txid TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS referrals_ref_status ON referrals(ref, status);
`;

export class Db {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.sql.exec(SCHEMA);
  }

  // ── quotes ──
  insertQuote(q: Omit<QuoteRow, "consumed_by">): void {
    this.sql.prepare(
      `INSERT INTO quotes (id,type,offer_id,country,brand,recipient_json,cost_micro,price_micro,summary_json,created_at,expires_at,consumed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).run(q.id, q.type, q.offer_id, q.country, q.brand, q.recipient_json, q.cost_micro, q.price_micro, q.summary_json, q.created_at, q.expires_at);
  }
  getQuote(id: string): QuoteRow | undefined {
    return this.sql.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as QuoteRow | undefined;
  }
  /**
   * Delete quotes that expired without ever being paid.
   *
   * `POST /v1/quote` is free, unauthenticated and rate-limited only per IP, and every
   * call wrote a row that nothing ever removed — recipient JSON plus the full quote
   * view, a few hundred bytes each, forever. The database is a Docker volume on a box
   * that also runs other services, so filling it is not only this
   * service's outage.
   *
   * **Consumed quotes are kept.** They are referenced by `orders.quote_id`, they are
   * bounded by the number of real orders, and they are the record of what a payer was
   * actually promised. Only the free, unpaid ones are transient.
   *
   * The grace period matters: deleting a quote the moment it expires turns a late
   * payment's honest "quote expired — request a new one" into "unknown quoteId", which
   * reads to an agent like the service lost its order rather than like a timeout.
   */
  pruneExpiredQuotes(graceMs = 24 * 60 * 60_000): number {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    // Pay links are free to create too, so the same rule: an expired link nobody paid is
    // garbage, and its quote_meta rows go with the quotes they describe. A paid link stays,
    // because orders were made from it.
    this.sql.prepare("DELETE FROM pay_links WHERE uses = 0 AND expires_at < ?").run(cutoff);
    this.sql.prepare("DELETE FROM quote_meta WHERE quote_id IN (SELECT id FROM quotes WHERE consumed_by IS NULL AND expires_at < ?)").run(cutoff);
    return Number(
      this.sql.prepare("DELETE FROM quotes WHERE consumed_by IS NULL AND expires_at < ?").run(cutoff).changes,
    );
  }

  /** Atomically claim a quote for one order. Returns false if already consumed. */
  consumeQuote(id: string, orderId: string): boolean {
    const r = this.sql.prepare("UPDATE quotes SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL").run(orderId, id);
    return Number(r.changes) === 1;
  }

  // ── orders ──
  insertOrder(o: OrderRow): void {
    const cols = Object.keys(o);
    this.sql.prepare(`INSERT INTO orders (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => (o as unknown as Record<string, unknown>)[c] as string | number | null));
  }
  updateOrder(id: string, patch: Partial<OrderRow>): void {
    const entries = Object.entries({ ...patch, updated_at: new Date().toISOString() });
    this.sql.prepare(`UPDATE orders SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), id);
  }
  getOrder(id: string): OrderRow | undefined {
    return this.sql.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  }
  getOrderBySettlement(txid: string): OrderRow | undefined {
    return this.sql.prepare("SELECT * FROM orders WHERE settlement_txid = ?").get(txid) as OrderRow | undefined;
  }
  /**
   * Supplier cost of orders that have SETTLED on chain but not yet been delivered —
   * money the float is already committed to spending and has not spent yet.
   *
   * `failed` is excluded deliberately: it means the supplier purchase did not happen,
   * so the float was never touched and the payer is owed a refund from the refund
   * wallet, not from the float. `paid` and `fulfilling` are both included — `paid` has
   * not been attempted yet, but it will be, and a ceiling that ignores it lets two
   * orders each pass a check that their sum fails.
   */
  /**
   * Supplier cost of settled-but-undelivered orders, by product type.
   *
   * Returned per type rather than as one total because different types are filled from
   * different wallets, and the caller (OrderService) is the one that knows which types
   * share a wallet — a Zendit account selling both airtime and eSIMs is one float, a
   * Reloadly-plus-Zendit pair is two. Summing here would have to guess.
   *
   * `failed` is excluded deliberately: the supplier purchase did not happen, so the
   * float was never touched and the payer is owed a refund from the refund wallet.
   * `paid` and `fulfilling` are both included — `paid` has not been attempted yet, but
   * it will be, and a ceiling that ignores it lets two orders each pass a check that
   * their sum fails.
   */
  committedCostByType(): Array<{ type: string; micro: number }> {
    return this.sql.prepare(
      "SELECT type, COALESCE(SUM(cost_micro),0) AS micro FROM orders WHERE status IN ('paid','fulfilling') GROUP BY type",
    ).all() as unknown as Array<{ type: string; micro: number }>;
  }

  openOrders(): OrderRow[] {
    return this.sql.prepare("SELECT * FROM orders WHERE status IN ('paid','fulfilling','failed') ORDER BY created_at").all() as unknown as OrderRow[];
  }
  payerSpentTodayMicro(payer: string, type?: string): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const r = (type
      ? this.sql.prepare("SELECT COALESCE(SUM(price_micro),0) AS s FROM orders WHERE payer = ? AND type = ? AND created_at >= ?").get(payer, type, start.toISOString())
      : this.sql.prepare("SELECT COALESCE(SUM(price_micro),0) AS s FROM orders WHERE payer = ? AND created_at >= ?").get(payer, start.toISOString())) as { s: number };
    return Number(r.s);
  }

  /** Sent TO one recipient today, across EVERY payer — the counter a new wallet
   *  cannot reset. `recipient_hash` is already indexed by the orders table's writes. */
  recipientSpentTodayMicro(recipientHash: string, type = "payout"): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const r = this.sql.prepare(
      "SELECT COALESCE(SUM(price_micro),0) AS s FROM orders WHERE recipient_hash = ? AND type = ? AND created_at >= ?",
    ).get(recipientHash, type, start.toISOString()) as { s: number };
    return Number(r.s);
  }

  // ── refunds ──
  recordRefund(r: { order_id: string; payer: string; amount_micro: number; txid: string | null; status: "sent" | "failed"; error?: string }): void {
    this.sql.prepare(
      `INSERT INTO refunds (order_id,payer,amount_micro,txid,status,error,created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(order_id) DO UPDATE SET txid=excluded.txid, status=excluded.status, error=excluded.error, created_at=excluded.created_at`,
    ).run(r.order_id, r.payer, r.amount_micro, r.txid, r.status, r.error ?? null, new Date().toISOString());
  }
  // ── business accounts ──
  // One onboarded counterparty, its KYB reference, and the Algorand addresses that
  // speak for it. Written by `pnpm account`, never over HTTP — see src/accounts.ts.
  insertAccount(a: AccountRow): void {
    this.sql.prepare(
      `INSERT INTO accounts (id,name,country,kyb_reference,status,max_order_micro,payout_max_micro,daily_micro,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(a.id, a.name, a.country, a.kyb_reference, a.status, a.max_order_micro, a.payout_max_micro, a.daily_micro, a.notes, a.created_at, a.updated_at);
  }
  updateAccount(id: string, patch: Partial<Omit<AccountRow, "id" | "created_at">>): void {
    const entries = Object.entries({ ...patch, updated_at: new Date().toISOString() });
    this.sql.prepare(`UPDATE accounts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), id);
  }
  getAccount(id: string): AccountRow | undefined {
    return this.sql.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  }
  listAccounts(): AccountRow[] {
    return this.sql.prepare("SELECT * FROM accounts ORDER BY created_at").all() as unknown as AccountRow[];
  }
  /** The account a settled payer speaks for, or undefined for an ordinary agent. */
  accountForPayer(payer: string | undefined): AccountRow | undefined {
    if (!payer) return undefined;
    return this.sql.prepare(
      "SELECT a.* FROM accounts a JOIN account_payers p ON p.account_id = a.id WHERE p.payer = ?",
    ).get(payer) as AccountRow | undefined;
  }
  /** An address belongs to at most one account; re-binding moves it. */
  bindPayer(payer: string, accountId: string): void {
    this.sql.prepare(
      `INSERT INTO account_payers (payer,account_id,created_at) VALUES (?,?,?)
       ON CONFLICT(payer) DO UPDATE SET account_id = excluded.account_id, created_at = excluded.created_at`,
    ).run(payer, accountId, new Date().toISOString());
  }
  unbindPayer(payer: string): boolean {
    return Number(this.sql.prepare("DELETE FROM account_payers WHERE payer = ?").run(payer).changes) === 1;
  }
  payersOf(accountId: string): string[] {
    return (this.sql.prepare("SELECT payer FROM account_payers WHERE account_id = ? ORDER BY created_at").all(accountId) as unknown as Array<{ payer: string }>).map((r) => r.payer);
  }
  /** Every account's spend since UTC midnight, across all its bound addresses. */
  accountSpentTodayMicro(accountId: string, type?: string): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const sql = `SELECT COALESCE(SUM(o.price_micro),0) AS s FROM orders o
                 JOIN account_payers p ON p.payer = o.payer
                 WHERE p.account_id = ? AND o.created_at >= ?${type ? " AND o.type = ?" : ""}`;
    const r = (type ? this.sql.prepare(sql).get(accountId, start.toISOString(), type)
                    : this.sql.prepare(sql).get(accountId, start.toISOString())) as { s: number };
    return Number(r.s);
  }

  refundsSentTodayMicro(): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const r = this.sql.prepare("SELECT COALESCE(SUM(amount_micro),0) AS s FROM refunds WHERE status = 'sent' AND created_at >= ?").get(start.toISOString()) as { s: number };
    return Number(r.s);
  }

  // ── growth: quote metadata, pay links, referrals ──
  setQuoteMeta(quoteId: string, meta: { ref?: string; linkId?: string }): void {
    if (!meta.ref && !meta.linkId) return;
    this.sql.prepare("INSERT OR REPLACE INTO quote_meta (quote_id, ref, link_id) VALUES (?,?,?)")
      .run(quoteId, meta.ref ?? null, meta.linkId ?? null);
  }
  getQuoteMeta(quoteId: string): { ref: string | null; link_id: string | null } | undefined {
    return this.sql.prepare("SELECT ref, link_id FROM quote_meta WHERE quote_id = ?").get(quoteId) as never;
  }

  insertPayLink(l: Omit<PayLinkRow, "uses">): void {
    this.sql.prepare(
      `INSERT INTO pay_links (id,type,offer_id,country,brand,title,recipient_json,amount,note,ref,max_uses,uses,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    ).run(l.id, l.type, l.offer_id, l.country, l.brand, l.title, l.recipient_json, l.amount, l.note, l.ref, l.max_uses, l.created_at, l.expires_at);
  }
  getPayLink(id: string): PayLinkRow | undefined {
    return this.sql.prepare("SELECT * FROM pay_links WHERE id = ?").get(id) as PayLinkRow | undefined;
  }
  /** Counted when an order is CREATED from a settled payment — never at quote time. */
  usePayLink(id: string): void {
    this.sql.prepare("UPDATE pay_links SET uses = uses + 1 WHERE id = ?").run(id);
  }

  insertReferral(r: Omit<ReferralRow, "txid" | "error" | "updated_at">): void {
    this.sql.prepare(
      `INSERT OR IGNORE INTO referrals (order_id,ref,payer,type,share_micro,status,txid,error,created_at,updated_at)
       VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`,
    ).run(r.order_id, r.ref, r.payer, r.type, r.share_micro, r.status, r.created_at, r.created_at);
  }
  getReferral(orderId: string): ReferralRow | undefined {
    return this.sql.prepare("SELECT * FROM referrals WHERE order_id = ?").get(orderId) as ReferralRow | undefined;
  }
  updateReferrals(orderIds: string[], patch: Partial<Pick<ReferralRow, "status" | "txid" | "error">>): void {
    if (!orderIds.length) return;
    const entries = Object.entries({ ...patch, updated_at: new Date().toISOString() });
    this.sql.prepare(
      `UPDATE referrals SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE order_id IN (${orderIds.map(() => "?").join(",")})`,
    ).run(...entries.map(([, v]) => v as string | null), ...orderIds);
  }
  owedReferrals(ref: string): ReferralRow[] {
    return this.sql.prepare("SELECT * FROM referrals WHERE ref = ? AND status = 'owed' ORDER BY created_at").all(ref) as unknown as ReferralRow[];
  }
  refsWithOwed(): string[] {
    return (this.sql.prepare("SELECT DISTINCT ref FROM referrals WHERE status = 'owed'").all() as unknown as Array<{ ref: string }>).map((r) => r.ref);
  }
  referralsPaidTodayMicro(): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const r = this.sql.prepare("SELECT COALESCE(SUM(share_micro),0) AS s FROM referrals WHERE status = 'paid' AND updated_at >= ?").get(start.toISOString()) as { s: number };
    return Number(r.s);
  }
  referralSummary(ref: string): { orders: number; pending_micro: number; owed_micro: number; paid_micro: number; payouts: Array<{ txid: string; micro: number; at: string }> } {
    const t = this.sql.prepare(
      `SELECT SUM(CASE WHEN status IN ('pending','owed','paid') THEN 1 ELSE 0 END) AS orders,
              COALESCE(SUM(CASE WHEN status='pending' THEN share_micro END),0) AS pending_micro,
              COALESCE(SUM(CASE WHEN status='owed' THEN share_micro END),0) AS owed_micro,
              COALESCE(SUM(CASE WHEN status='paid' THEN share_micro END),0) AS paid_micro
       FROM referrals WHERE ref = ?`,
    ).get(ref) as Record<string, number>;
    const payouts = this.sql.prepare(
      "SELECT txid, SUM(share_micro) AS micro, MAX(updated_at) AS at FROM referrals WHERE ref = ? AND status='paid' GROUP BY txid ORDER BY at DESC LIMIT 20",
    ).all(ref) as unknown as Array<{ txid: string; micro: number; at: string }>;
    return {
      orders: Number(t.orders ?? 0), pending_micro: Number(t.pending_micro), owed_micro: Number(t.owed_micro), paid_micro: Number(t.paid_micro),
      payouts: payouts.map((p) => ({ txid: p.txid, micro: Number(p.micro), at: p.at })),
    };
  }
  /** Earned = delivered orders only (owed or paid). Pending and void never rank anyone. */
  referralLeaderboard(limit = 20): Array<{ ref: string; orders: number; earned_micro: number }> {
    return (this.sql.prepare(
      `SELECT ref, COUNT(*) AS orders, SUM(share_micro) AS earned_micro FROM referrals
       WHERE status IN ('owed','paid') GROUP BY ref ORDER BY earned_micro DESC, orders DESC LIMIT ?`,
    ).all(limit) as unknown as Array<{ ref: string; orders: number; earned_micro: number }>)
      .map((r) => ({ ref: r.ref, orders: Number(r.orders), earned_micro: Number(r.earned_micro) }));
  }

  /** A terminal order by its settlement txid, with the offer name its quote promised.
   *  Public proof pages key on the txid — already public on the ledger — and never on
   *  the order id, which is the capability that reads an eSIM LPA or a voucher PIN. */
  proofBySettlement(txid: string): (OrderRow & { summary_json: string | null }) | undefined {
    return this.sql.prepare(
      "SELECT o.*, q.summary_json FROM orders o LEFT JOIN quotes q ON q.id = o.quote_id WHERE o.settlement_txid = ?",
    ).get(txid) as never;
  }

  // ── public ledger ──
  /**
   * **`refund_failed` is counted separately from `in_flight`, and that distinction is
   * the whole point of this endpoint.**
   *
   * The two are not the same kind of number. `paid` / `fulfilling` / `failed` are
   * transient — `resume()` picks all three up on boot and drives them to a terminal
   * state. `refund_failed` is terminal and is NOT in `openOrders()`: it means the payer
   * settled, the goods never arrived, the refund then failed too, and nothing in this
   * process will try again. It is a stranded payer awaiting manual action.
   *
   * Reporting it as "in flight" put the single worst outcome the system can produce in
   * the same bucket as an order three seconds old, on the one surface whose stated
   * purpose is that nothing is hidden. Do not merge these counts back together.
   */
  ledgerStats(): {
    orders: number; delivered: number; refunded: number; in_flight: number; stranded: number; volume_micro: number;
    countries: Array<{ country: string; orders: number; volume_micro: number }>;
    types: Array<{ type: string; orders: number; volume_micro: number }>;
  } {
    const t = this.sql.prepare(
      `SELECT COUNT(*) AS orders,
              SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) AS refunded,
              SUM(CASE WHEN status IN ('paid','fulfilling','failed') THEN 1 ELSE 0 END) AS in_flight,
              SUM(CASE WHEN status='refund_failed' THEN 1 ELSE 0 END) AS stranded,
              COALESCE(SUM(price_micro),0) AS volume_micro FROM orders`,
    ).get() as Record<string, number>;
    const countries = this.sql.prepare(
      "SELECT country, COUNT(*) AS orders, SUM(price_micro) AS volume_micro FROM orders GROUP BY country ORDER BY volume_micro DESC LIMIT 50",
    ).all() as unknown as Array<{ country: string; orders: number; volume_micro: number }>;
    const types = this.sql.prepare(
      "SELECT type, COUNT(*) AS orders, SUM(price_micro) AS volume_micro FROM orders GROUP BY type ORDER BY volume_micro DESC",
    ).all() as unknown as Array<{ type: string; orders: number; volume_micro: number }>;
    return {
      orders: Number(t.orders), delivered: Number(t.delivered ?? 0), refunded: Number(t.refunded ?? 0),
      in_flight: Number(t.in_flight ?? 0), stranded: Number(t.stranded ?? 0), volume_micro: Number(t.volume_micro),
      countries, types,
    };
  }
  /**
   * The public ledger's rows. **The order id is deliberately NOT selected.**
   *
   * `GET /v1/orders/:id` is unauthenticated and the id is the capability: 80 bits of
   * randomness handed to the payer when they pay. The order it unlocks carries the
   * supplier confirmation, and for a PIN voucher or an eSIM that confirmation IS the
   * deliverable — a `voucher_pin` or an `lpa` is a bearer instrument, redeemable by
   * whoever gets there first. Publishing the ids here let anyone poll the ledger, read
   * the PIN of every order as it landed, and redeem it before the buyer did, with
   * nothing failing and so no refund. Found in review 2026-08-30.
   *
   * Adding `id` back to this SELECT re-opens that. Don't.
   */
  recentOrders(limit = 25): Array<Pick<OrderRow, "type" | "country" | "brand" | "price_micro" | "status" | "settlement_txid" | "refund_txid" | "created_at" | "delivered_at">> {
    return this.sql.prepare(
      "SELECT type,country,brand,price_micro,status,settlement_txid,refund_txid,created_at,delivered_at FROM orders ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as never;
  }
}
