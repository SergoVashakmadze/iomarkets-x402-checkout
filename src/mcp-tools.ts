// The MCP tool surface, registered once and served over two transports:
//
//   stdio  (src/mcp.ts)  — runs on the agent's own machine, holds the agent's wallet,
//                          so `buy` pays the quote itself under a budget.
//   hosted (POST /mcp)   — runs on our box and holds NO wallet, so `buy` hands back the
//                          x402 challenge for the calling agent to pay from its own
//                          wallet. A hosted server must never custody a caller's key.
//
// Everything else is identical, which is the point of this module: one definition, so
// the two transports cannot drift in what they promise an agent.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyReceipt, type Receipt } from "./receipt.js";
import type { PayingFetch } from "./client/paying.js";

export interface McpContext {
  /** Call a path on this service. In-process for the hosted server, HTTP for stdio. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /** The public base URL, for links and instructions shown to the agent. */
  apiBase: string;
  /** Present only when this server holds a wallet (stdio + AGENT_MNEMONIC_FILE). */
  pay?: PayingFetch;
  payerAddress?: string;
  budgetUsd?: number;
  maxOrderUsd?: number;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

/** The 402 body carries the payment requirements base64-encoded in this header. */
export function decodePaymentRequired(header: string | null): unknown {
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { return null; }
}

export function registerTools(server: McpServer, ctx: McpContext): void {
  const getJson = async (path: string) => (await ctx.call(path)).json();
  const postJson = async (path: string, body: unknown) =>
    (await ctx.call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  server.registerTool("lookup_phone", {
    description: "Identify the country and mobile operator of a phone number and list the top-up offers available for it. Free. The operator is DETECTED from the number range and is a guess: MVNOs (Tesco Mobile, Giff Gaff, Lebara, Voxi, Sky…) resolve to the host network they ride on. Read the detected brand back to the human and have them confirm it before buying, and use `other_brands` to correct it — a voucher bought for the wrong network delivers successfully and cannot be redeemed or refunded.",
    inputSchema: { phone: z.string().describe("E.164, e.g. +919876543210") },
  }, async ({ phone }) => text(await getJson(`/v1/lookup?phone=${encodeURIComponent(phone)}`)));

  server.registerTool("list_offers", {
    description: "Browse purchasable offers: mobile top-ups, travel eSIMs, prepaid bills, or international payment corridors (bank / mobile money / UPI) for a country. Free. Prices shown are indicative; the quote fixes them.",
    inputSchema: {
      type: z.enum(["topup", "esim", "bill", "payout"]).describe("payout = international payment (bank / mobile money / UPI)"),
      country: z.string().length(2).optional().describe("ISO-3166 alpha-2, e.g. IN"),
      brand: z.string().optional(),
      // The eSIM catalogue is 3,046 offers across 197 countries. A page, or a country.
      limit: z.number().int().min(0).max(500).optional().describe("page size, default 100; 0 means all"),
      offset: z.number().int().min(0).optional().describe("use next_offset from the previous page"),
    },
  }, async ({ type, country, brand, limit, offset }) => {
    const p = new URLSearchParams({ type });
    if (country) p.set("country", country);
    if (brand) p.set("brand", brand);
    if (limit !== undefined) p.set("limit", String(limit));
    if (offset !== undefined) p.set("offset", String(offset));
    return text(await getJson(`/v1/catalog?${p}`));
  });

  server.registerTool("quote", {
    description: "Lock a price (10 minutes) for one purchase. Returns quoteId, exact USDC price and what will be delivered. Free. ALWAYS show the human the price and the recipient before buying.",
    inputSchema: {
      type: z.enum(["topup", "esim", "bill", "payout"]), offerId: z.string(),
      phone: z.string().optional().describe("recipient phone for topup/bill (E.164)"),
      amount: z.number().positive().optional().describe("for range offers: amount in the recipient's local currency"),
      iccid: z.string().optional().describe("existing eSIM to top up (optional)"),
      fields: z.record(z.string(), z.string()).optional().describe("bill-pay / payout recipient fields the offer lists in requiredFields (account_number, bank_code, full_name, vpa, iban…)"),
      sender: z.object({ name: z.string(), country: z.string().length(2), reference: z.string().optional() }).optional().describe("payouts only: the principal (legal name + country); reference = partner KYC id, required above $100/day"),
      payer: z.string().optional().describe("the Algorand address you will pay from (required for payout compliance when this server holds no wallet)"),
      ref: z.string().optional().describe("referrer's Algorand address — earns a share of margin if the order is delivered (GET /v1/referrals)"),
    },
  }, async ({ type, offerId, phone, amount, iccid, fields, sender, payer, ref }) =>
    text(await postJson("/v1/quote", { type, offerId, recipient: { phone, iccid, fields }, amount, sender, payer: payer ?? ctx.payerAddress, ref })));

  server.registerTool("create_pay_link", {
    description:
      "Create a checkout link a HUMAN pays from their own Algorand wallet (Pera). Use this when you have no wallet, or when the person should approve and pay themselves: " +
      "they open the link, see the exact price, sign in their wallet, and the result (the eSIM QR code, or the top-up confirmation) appears on the page. You never hold a key. " +
      "A top-up link can be paid by anyone — send it to family as 'top up my phone'. An eSIM link delivers to whoever pays. Free. Add `ref` (your Algorand address) to earn a share of margin on each delivered order.",
    inputSchema: {
      type: z.enum(["topup", "esim"]),
      offerId: z.string(),
      phone: z.string().optional().describe("topup only: recipient phone, E.164"),
      amount: z.number().positive().optional().describe("for range top-up offers: amount in local currency"),
      note: z.string().max(140).optional().describe("shown on the link page, e.g. 'Your Tokyo trip data'"),
      ref: z.string().optional().describe("your Algorand address, to earn referral share"),
      max_uses: z.number().int().min(0).max(1000).optional().describe("0 = reusable until expiry; default 1 for topup, 0 for esim"),
      ttl_hours: z.number().int().min(1).max(720).optional().describe("default 168 (7 days)"),
    },
  }, async ({ type, offerId, phone, amount, note, ref, max_uses, ttl_hours }) =>
    text(await postJson("/v1/links", { type, offerId, recipient: { phone }, amount, note, ref, max_uses, ttl_hours })));

  server.registerTool("buy", {
    description: ctx.pay
      ? `Pay a quote with USDC on Algorand (x402) and place the order. Spends real money from the agent wallet (budget $${ctx.budgetUsd}/session, max $${ctx.maxOrderUsd}/order). Requires prior human confirmation of the quote. Returns the order with its on-chain settlement txid; then poll order_status.`
      : "Get the x402 payment challenge for a quote. This hosted server holds no wallet, so it does NOT spend your money: it returns the exact amount, asset, payTo address and facilitator for you to pay from your own Algorand wallet, then you POST the quote again with your payment signature. Requires prior human confirmation of the quote.",
    inputSchema: { quoteId: z.string() },
  }, async ({ quoteId }) => {
    const body = JSON.stringify({ quoteId });
    const headers = { "content-type": "application/json" };

    if (!ctx.pay) {
      // No wallet here by design. Surface the challenge so the caller can pay itself.
      const res = await ctx.call("/v1/orders", { method: "POST", headers, body });
      const parsed = await res.json().catch(() => ({}));
      if (res.status !== 402) return text({ http_status: res.status, ...parsed });
      return text({
        http_status: 402,
        payment_required: decodePaymentRequired(res.headers.get("payment-required")),
        quote: parsed,
        how_to_pay: `Pay the amount named above with your own Algorand wallet using the x402 "exact" scheme, then POST ${ctx.apiBase}/v1/orders again with {"quoteId":"${quoteId}"} and your payment signature header. Then poll order_status.`,
      });
    }

    const res = await ctx.pay(`${ctx.apiBase}/v1/orders`, { method: "POST", headers, body });
    const parsed = await res.json().catch(() => ({}));
    return text({ http_status: res.status, ...parsed, spent_this_session_usdc: Number(ctx.pay.spentMicroUsdc()) / 1e6 });
  });

  server.registerTool("order_status", {
    description: "Check an order. Poll every ~3 s until `terminal` is true: delivered (confirmation + signed receipt), refunded (refund txid + signed receipt) or refund_failed.",
    inputSchema: { orderId: z.string() },
  }, async ({ orderId }) => text(await getJson(`/v1/orders/${encodeURIComponent(orderId)}`)));

  server.registerTool("verify_receipt", {
    description:
      "Verify an ed25519-signed receipt: the signature, and — unless you pass onChain:false — both txids against an Algorand indexer. " +
      "Give it an orderId to check one of this service's own orders, or a receipt object to check ANY receipt in this format, including one issued by another server.",
    inputSchema: {
      orderId: z.string().optional().describe("an order on this service"),
      receipt: z.unknown().optional().describe("a receipt {payload, signature}, or an order response containing one"),
      onChain: z.boolean().optional().describe("confirm the txids on chain; default true"),
    },
  }, async ({ orderId, receipt, onChain }) => {
    // A receipt handed to us directly goes through the public verifier, which checks it
    // against the key named IN the receipt — so an agent can check a counterparty's
    // receipt with the same tool it checks ours, and be told which server signed it.
    if (receipt) return text(await postJson(`/v1/verify${onChain === false ? "?online=0" : ""}`, receipt));
    if (!orderId) return text({ error: "pass either orderId or receipt" });

    const [o, k] = await Promise.all([getJson(`/v1/orders/${encodeURIComponent(orderId)}`), getJson("/v1/pubkey")]);
    if (!o.receipt) return text({ valid: false, reason: `order is ${o.status}; no receipt yet` });
    const r = o.receipt as Receipt;
    // The signature is checked locally first — it needs no network and it is the half
    // that must never depend on a third party being reachable.
    const local = { valid: verifyReceipt(r, k.public_key), signer: r.payload.server_pubkey,
      settlement_txid: r.payload.settlement_txid, refund_txid: r.payload.refund_txid || null, explorer: o.settlement_url };
    if (onChain === false || !local.valid) return text(local);
    return text({ ...local, on_chain: await postJson("/v1/verify", r) });
  });

  server.registerTool("fx", {
    description: "Indicative USDC → local-currency rate at our sale price, with an estimate for an amount. The quote is the binding price.",
    inputSchema: {
      to: z.string().length(3).describe("ISO-4217, e.g. INR"),
      amount: z.number().positive().optional(),
      // The markup can differ per product type, so a rate is indicative of a type.
      type: z.enum(["topup", "bill", "payout"]).optional().describe("what the rate is for; default payout"),
    },
  }, async ({ to, amount, type }) => text(await getJson(
    `/v1/fx?to=${to}${amount ? `&amount=${amount}` : ""}${type ? `&type=${type}` : ""}`,
  )));

  server.registerTool("ledger", {
    description: "Public delivery ledger: totals, delivered-or-refunded %, volume, countries, recent orders.",
    inputSchema: {},
  }, async () => text(await getJson("/v1/ledger")));
}
