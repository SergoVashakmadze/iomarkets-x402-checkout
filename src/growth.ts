// The growth surfaces: pay links, public proof pages, and the referral programme.
//
// Everything else in this service assumes the buyer is an agent that already holds
// USDC on Algorand. These three widen that in the three directions that matter:
//
//   Pay links  (POST /v1/links → /l/:id)
//     An agent with NO wallet — a chat assistant, a planner, a support bot — can still
//     sell: it creates a link and hands it to its human, who approves the exact payment
//     in their own Pera wallet. The key never leaves the wallet and the human sees what
//     they authorise, which is the "agent proposes, human signs" model rather than
//     giving an agent a wallet. A top-up link can also be paid by someone ELSE: "top up
//     my phone" sent to family is a request-to-pay that needs no account on either end.
//
//   Proof pages  (GET /p/:txid)
//     Every delivered order becomes a shareable page — what was bought, what it cost, how
//     fast it arrived, the on-chain settlement and a server-checked signature — with a
//     "get the same one" button that credits the original buyer as referrer. Keyed by the
//     SETTLEMENT TXID, which is already public on /v1/ledger, never by the order id,
//     which is the capability that reads an eSIM LPA.
//
//   Referrals  (?ref=<address> on quotes and links, /v1/referrals, /earn)
//     See src/referrals.ts. Turns every other x402 builder into a reseller.

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { Db, PayLinkRow } from "./db.js";
import { formatUsdc } from "./money.js";
import { maskTail, type OrderService } from "./orders.js";
import { normalizeMsisdn } from "./phone.js";
import { verifyReceipt, type Receipt } from "./receipt.js";
import { ALGORAND_ADDRESS, type ReferralService } from "./referrals.js";
import { payLinkPageHtml, proofPageHtml, earnPageHtml } from "./growth-pages.js";

export interface GrowthDeps {
  db: Db;
  orders: OrderService;
  referrals?: ReferralService;
  base: string;
  receiptPubkey: string;
  network: string;
  explorerTx: (txid: string) => string;
  brand: string;
}

const Address = z.string().regex(ALGORAND_ADDRESS, "must be an Algorand address");
const LINK_ID = /^pl_[a-z0-9]{16}$/;
const TXID = /^[A-Z2-7]{52}$/;

const LinkBody = z.object({
  // Payouts need a named sender and a payer-bound compliance check; bills are
  // supplier-gated. Links sell the two products that are live and bearer-safe.
  type: z.enum(["topup", "esim"]),
  offerId: z.string().min(1).max(200),
  recipient: z.object({ phone: z.string().min(7).max(20).optional() }).default({}),
  amount: z.number().positive().optional(),
  note: z.string().max(140).optional(),
  ref: Address.optional(),
  /** 0 = reusable until expiry. Default: 1 for a top-up (it pays one phone), 0 for an eSIM. */
  max_uses: z.number().int().min(0).max(1000).optional(),
  ttl_hours: z.number().int().min(1).max(24 * 30).optional(),
});

export const DEFAULT_LINK_TTL_HOURS = 24 * 7;

export function mountGrowth(app: Hono<any>, d: GrowthDeps): void {
  const { db, orders, referrals, base } = d;

  const linkView = (l: PayLinkRow) => {
    const recipient = JSON.parse(l.recipient_json) as { phone?: string };
    const expired = new Date(l.expires_at).getTime() <= Date.now();
    const exhausted = l.max_uses > 0 && l.uses >= l.max_uses;
    return {
      linkId: l.id,
      url: `${base}/l/${l.id}`,
      type: l.type,
      title: l.title,
      country: l.country,
      brand: l.brand,
      offerId: l.offer_id,
      recipient: { phone: maskTail(recipient.phone ? `+${recipient.phone}` : undefined) },
      amount: l.amount ?? undefined,
      note: l.note ?? undefined,
      referred: Boolean(l.ref),
      uses: l.uses,
      max_uses: l.max_uses,
      expires_at: l.expires_at,
      state: expired ? "expired" : exhausted ? "paid" : "open",
      delivers_to: l.type === "esim" ? "whoever pays — the eSIM activation code is shown to the payer" : "the phone number above, whoever pays",
    };
  };

  // ── pay links ────────────────────────────────────────────────────────────────
  const createLink = async (b: z.infer<typeof LinkBody>): Promise<{ status: 201 | 400; body: Record<string, unknown> }> => {
    let phone: string | undefined;
    if (b.type === "topup") {
      phone = normalizeMsisdn(b.recipient.phone ?? "") ?? undefined;
      if (!phone) return { status: 400, body: { error: "recipient.phone (E.164) required for a top-up link" } };
    }
    // Quote it now: a link to something unsellable is worse than an error. The quote
    // itself is discarded (and swept like any unpaid quote); the link re-quotes on open.
    const q = await orders.quote({ type: b.type, offerId: b.offerId, recipient: { phone }, amount: b.amount, ref: b.ref, maskRecipient: true });
    const now = new Date();
    const id = `pl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const row = {
      id, type: b.type, offer_id: q.offer.id, country: q.offer.country, brand: q.offer.brand,
      title: q.delivers, recipient_json: JSON.stringify(phone ? { phone } : {}), amount: b.amount ?? null,
      note: b.note?.trim() || null, ref: b.ref ?? null,
      max_uses: b.max_uses ?? (b.type === "topup" ? 1 : 0),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (b.ttl_hours ?? DEFAULT_LINK_TTL_HOURS) * 3_600_000).toISOString(),
    };
    db.insertPayLink(row);
    const view = linkView({ ...row, uses: 0 });
    const shareText = b.type === "esim"
      ? `Travel data sorted: ${q.delivers} for ${Number(q.price_usdc).toFixed(2)} USDC on Algorand. No account, pay from your own wallet, signed receipt:`
      : `Top up my phone with USDC on Algorand (${Number(q.price_usdc).toFixed(2)} USDC, signed receipt):`;
    return {
      status: 201,
      body: {
        ...view,
        indicative_price_usdc: q.price_usdc,
        share: { x: `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(view.url)}` },
        next: "Send `url` to the human. They pay from their own Algorand wallet; you never hold a key. Anyone can pay a top-up link; an eSIM link delivers to whoever pays.",
      },
    };
  };

  app.post("/v1/links", async (c) => {
    const parsed = LinkBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const r = await createLink(parsed.data);
    return c.json(r.body, r.status);
  });

  app.get("/v1/links/:id", (c) => {
    const id = c.req.param("id");
    const l = LINK_ID.test(id) ? db.getPayLink(id) : undefined;
    return l ? c.json(linkView(l)) : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/links/:id/quote", async (c) => {
    const id = c.req.param("id");
    const l = LINK_ID.test(id) ? db.getPayLink(id) : undefined;
    if (!l) return c.json({ error: "not found" }, 404);
    const v = linkView(l);
    if (v.state === "expired") return c.json({ error: "this pay link has expired" }, 410);
    if (v.state === "paid") return c.json({ error: "this pay link has already been paid" }, 409);
    const recipient = JSON.parse(l.recipient_json) as { phone?: string };
    const q = await orders.quote({
      type: l.type as "topup" | "esim", offerId: l.offer_id, recipient, amount: l.amount ?? undefined,
      ref: l.ref ?? undefined, linkId: l.id, maskRecipient: true,
    });
    q.pay.endpoint = `${base}/v1/orders`;
    return c.json(q);
  });

  // ── proof ────────────────────────────────────────────────────────────────────
  const proofOf = (txid: string) => {
    if (!TXID.test(txid)) return undefined;
    const o = db.proofBySettlement(txid);
    // Goods only. A payout's payer is usually an onboarded business, and /v1/limits
    // already refuses to publish a counterparty's payout activity — a shareable page
    // naming the payer and the amount would undo that.
    if (!o || o.type === "payout") return undefined;
    const summary = o.summary_json ? (JSON.parse(o.summary_json) as { delivers?: string; offer?: { name?: string } }) : {};
    const receipt = o.receipt_json ? (JSON.parse(o.receipt_json) as Receipt) : undefined;
    const terminal = o.status === "delivered" || o.status === "refunded";
    return {
      status: o.status,
      terminal,
      type: o.type,
      country: o.country,
      brand: o.brand,
      // `delivers` for a top-up reads "INR 299 · Jio …" — the amount and plan, never the number.
      what: summary.delivers ?? summary.offer?.name ?? o.offer_id,
      offerId: o.offer_id,
      price_usdc: formatUsdc(o.price_micro),
      paid_at: o.created_at,
      delivered_at: o.delivered_at ?? undefined,
      delivered_in_seconds: o.delivered_at ? Math.max(0, Math.round((Date.parse(o.delivered_at) - Date.parse(o.created_at)) / 100) / 10) : undefined,
      payer: o.payer,
      settlement_txid: o.settlement_txid,
      settlement_url: d.explorerTx(o.settlement_txid),
      refund_txid: o.refund_txid ?? undefined,
      refund_url: o.refund_txid ? d.explorerTx(o.refund_txid) : undefined,
      // Checked here, against OUR published key. The receipt itself is not published: it
      // names the order id, and the order id reads the deliverable.
      receipt_signature_valid: receipt ? verifyReceipt(receipt) : null,
      // Reported separately, as POST /v1/verify does: a valid signature by a key that is
      // not the one this server publishes is a different finding from an invalid one.
      signed_by_this_server: receipt ? Boolean(d.receiptPubkey) && receipt.payload.server_pubkey === d.receiptPubkey : null,
      receipt_pubkey: d.receiptPubkey,
      network: d.network,
      url: `${base}/p/${o.settlement_txid}`,
      can_reorder: o.type === "esim" && o.status === "delivered",
    };
  };
  app.get("/v1/proof/:txid", (c) => {
    const p = proofOf(c.req.param("txid"));
    return p ? c.json(p) : c.json({ error: "no order settled with that transaction" }, 404);
  });

  /** "Get the same one": a fresh single-product link, crediting the original buyer. */
  app.post("/v1/proof/:txid/reorder", async (c) => {
    const p = proofOf(c.req.param("txid"));
    if (!p) return c.json({ error: "no order settled with that transaction" }, 404);
    if (!p.can_reorder) return c.json({ error: "only a delivered eSIM can be re-ordered from its proof page" }, 400);
    const r = await createLink({
      type: "esim", offerId: p.offerId, recipient: {}, ttl_hours: 24,
      ref: ALGORAND_ADDRESS.test(p.payer) ? p.payer : undefined,
    });
    return c.json(r.body, r.status);
  });

  // ── referrals ────────────────────────────────────────────────────────────────
  const program = () => referrals?.terms() ?? { enabled: false };
  app.get("/v1/referrals", (c) => c.json({
    program: program(),
    how: `Add "ref": "<your Algorand address>" to POST ${base}/v1/quote or POST ${base}/v1/links. Share of NET margin on every delivered order, paid on-chain in USDC.`,
    leaderboard: db.referralLeaderboard(20).map((r) => ({ ref: r.ref, orders: r.orders, earned_usdc: formatUsdc(r.earned_micro) })),
  }));
  app.get("/v1/referrals/:address", (c) => {
    const a = c.req.param("address");
    if (!ALGORAND_ADDRESS.test(a)) return c.json({ error: "not an Algorand address" }, 400);
    return c.json({ program: program(), ...(referrals?.summary(a) ?? { ref: a, orders_referred: 0 }) });
  });

  // ── pages ────────────────────────────────────────────────────────────────────
  app.get("/l/:id", (c) => {
    const id = c.req.param("id");
    const l = LINK_ID.test(id) ? db.getPayLink(id) : undefined;
    if (!l) return c.html(payLinkPageHtml({ base, link: null }), 404);
    return c.html(payLinkPageHtml({ base, link: linkView(l) }));
  });
  app.get("/p/:txid", (c) => {
    const p = proofOf(c.req.param("txid"));
    return c.html(proofPageHtml({ base, brand: d.brand, proof: p ?? null }), p ? 200 : 404);
  });
  app.get("/earn", (c) => c.html(earnPageHtml({ base, program: program() })));
}
