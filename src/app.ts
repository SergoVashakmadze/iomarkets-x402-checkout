// HTTP surface. Free discovery routes + ONE paid route (POST /v1/orders) whose
// price is the quoted amount, settled in USDC on Algorand through x402 before
// any goods move. Everything a buyer needs to trust us is public: the receipt
// signing key, the ledger, and the verifier script.

import { readFileSync } from "node:fs";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
  type RoutesConfig,
  type ProtectedRequestHook,
  type HTTPRequestContext,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { ALGORAND_MAINNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_HASH, USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { z } from "zod";

import { checkPayout } from "./compliance.js";
import { ceilingMicro, usd } from "./accounts.js";
import { config, IS_MAINNET } from "./config.js";
import type { Db, OrderRow } from "./db.js";
import { floorInflatesPrice, formatUsdc, pricingFor, toMicro, toPriceString } from "./money.js";
import { OrderService, QuoteError } from "./orders.js";
import { RateLimiter, ReplayGuard, paymentTxn, settledFromHeader } from "./payments.js";
import { derivePublicKey, type Receipt } from "./receipt.js";
import { verifyFully } from "./verify.js";
import { normalizeMsisdn } from "./phone.js";
import type { ProductType, Supplier, SupplierCountry } from "./suppliers/types.js";
import { SupplierError } from "./suppliers/types.js";
import { landingHtml, agentMd, fundHtml, productList } from "./landing.js";
import { consoleHtml } from "./console.js";
import { verifyPageHtml } from "./verify-page.js";
import { mountPayConsole } from "./pay-console.js";
import { mountBrand } from "./brand.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./mcp-tools.js";
import { mountGrowth } from "./growth.js";
import { offerTouchesBlocked } from "./sanctions.js";
import { ALGORAND_ADDRESS, type ReferralService } from "./referrals.js";

const P = config.apiPrefix;
export const ORDERS_ROUTE = `POST ${P}/orders`;

export type Env = { Variables: { pendingQuote?: string } };

export interface AppDeps {
  db: Db;
  supplier: Supplier;
  orders: OrderService;
  /** Test seam: replace the real x402 middleware. */
  paymentMiddleware?: MiddlewareHandler;
  /** The referral programme (src/referrals.ts). Absent = programme off. */
  referrals?: ReferralService;
}

export const explorerTx = (txid: string) => `https://lora.algokit.io/${IS_MAINNET ? "mainnet" : "testnet"}/transaction/${txid}`;

export function orderView(o: OrderRow, base: string) {
  const recipient = JSON.parse(o.recipient_json) as { phone?: string; iccid?: string };
  const mask = (s?: string) => (s ? `${"•".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : undefined);
  return {
    orderId: o.id,
    status: o.status,
    type: o.type,
    country: o.country,
    brand: o.brand,
    recipient: { phone: mask(recipient.phone), iccid: mask(recipient.iccid) },
    price_usdc: formatUsdc(o.price_micro),
    payer: o.payer,
    settlement_txid: o.settlement_txid,
    settlement_url: explorerTx(o.settlement_txid),
    supplier: o.supplier,
    supplier_tx_id: o.supplier_tx_id,
    confirmation: o.confirmation_json ? JSON.parse(o.confirmation_json) : undefined,
    receipt: o.receipt_json ? JSON.parse(o.receipt_json) : undefined,
    refund_txid: o.refund_txid ?? undefined,
    refund_url: o.refund_txid ? explorerTx(o.refund_txid) : undefined,
    error: o.error ?? o.refund_error ?? undefined,
    created_at: o.created_at,
    delivered_at: o.delivered_at ?? undefined,
    status_url: `${base}${P}/orders/${o.id}`,
    terminal: ["delivered", "refunded", "refund_failed"].includes(o.status),
  };
}

/**
 * The client IP to rate-limit on: the LAST X-Forwarded-For entry, not the first.
 *
 * X-Forwarded-For is client-supplied until a proxy overwrites or appends to it, and
 * the leftmost entry is the part an attacker controls. Reading it meant anyone could
 * rotate the rate-limit key per request — and worse, could mint 50,000 distinct keys
 * to trip RateLimiter's own overflow sweep, clearing everyone else's counters. The
 * free routes call the supplier's API on every request, so the ceiling being lifted is
 * a bill and a supplier-side throttle, not just CPU.
 *
 * The rightmost entry is written by the closest proxy and is the only one it observed
 * rather than inherited, so it is correct whether that proxy replaces the header (what
 * deploy/Caddyfile does today) or appends to it. This is defence in depth for a
 * property currently held by one line of Caddy config — on a box where the running
 * Caddy config has already been found drifted from its file once.
 */
export function clientIp(xff: string | undefined, xRealIp: string | undefined): string {
  const hops = (xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? xRealIp ?? "local";
}

/** A receipt as it travels: the signed payload plus the signature over it. Fields are
 *  validated for SHAPE only — every value is checked cryptographically downstream, and a
 *  receipt that fails verification must return a verdict, not a 400. */
const ReceiptBody = z.object({
  payload: z.object({
    v: z.number(),
    order_id: z.string(),
    status: z.string(),
    product_type: z.string(),
    offer_id: z.string(),
    country: z.string(),
    brand: z.string(),
    recipient_hash: z.string(),
    amount_usdc: z.string(),
    payer: z.string(),
    settlement_txid: z.string(),
    supplier: z.string(),
    supplier_tx_id: z.string(),
    refund_txid: z.string(),
    issued_at: z.string(),
    server_pubkey: z.string(),
  }),
  signature: z.string(),
});

const QuoteBody = z.object({
  type: z.enum(["topup", "esim", "bill", "payout"]),
  offerId: z.string().min(1).max(200),
  sender: z.object({ name: z.string().min(2).max(120), country: z.string().length(2), reference: z.string().max(120).optional() }).optional(),
  payer: z.string().length(58).optional(),
  recipient: z.object({
    phone: z.string().min(7).max(20).optional(),
    iccid: z.string().min(18).max(22).optional(),
    // Bounded on BOTH axes. A quote is free and unauthenticated and its recipient
    // JSON is persisted verbatim, so an unbounded record was a way to write arbitrary
    // amounts into the database without paying for anything. No real offer lists more
    // than a handful of requiredFields.
    fields: z.record(z.string().min(1).max(64), z.string().min(1).max(200))
      .refine((f) => Object.keys(f).length <= 20, { message: "at most 20 recipient fields" })
      .optional(),
  }).default({}),
  amount: z.number().positive().optional(),
  /** A referrer's Algorand address. Earns a share of margin if the order is delivered. */
  ref: z.string().regex(ALGORAND_ADDRESS, "ref must be an Algorand address").optional(),
});

/**
 * Runs before any payment is verified: the quote must be payable and the payer
 * must be inside the daily ceiling. Aborting here costs the payer nothing — no
 * signature has been broadcast.
 */
export function makePreflight(orders: OrderService, db: Db, guard: ReplayGuard) {
  return async (quoteId: unknown, paymentHeader: string | undefined): Promise<{ abort: true; reason: string } | void> => {
    if (typeof quoteId !== "string") return { abort: true, reason: "body.quoteId required — call POST /v1/quote first" };
    const v = orders.validQuote(quoteId);
    if (!v.ok) return { abort: true, reason: v.reason };
    // A single-use pay link (a top-up request) paid by one person must not be paid again
    // by the next person who opens it. Checked before any signature exists, so the second
    // payer is told rather than charged; the link's own quote route refuses too.
    const linkId = db.getQuoteMeta(quoteId)?.link_id;
    if (linkId) {
      const link = db.getPayLink(linkId);
      if (link && link.max_uses > 0 && link.uses >= link.max_uses) return { abort: true, reason: "this pay link has already been paid" };
    }
    const p = paymentTxn(paymentHeader);
    if (!p) return; // unpaid request → normal 402 path
    if (guard.has(p.txid)) return { abort: true, reason: "payment already used" };

    // Limits are resolved from the REAL payer here. The `payer` a quote was made with
    // is an unauthenticated claim, so a caller could name a business account's address
    // to get its ceilings and then pay from their own. Re-resolving — and re-checking
    // the per-order ceiling, not just the daily one — is what closes that.
    const q = db.getQuote(quoteId)!;
    const limits = orders.limitsForPayer(p.sender);
    if (limits.blocked) return { abort: true, reason: limits.blocked };
    const ceiling = ceilingMicro(limits, q.type);
    if (v.priceMicro > ceiling) {
      return { abort: true, reason: `order exceeds the per-order limit of ${usd(ceiling)} for this payer` };
    }
    const spentToday = limits.accountId ? db.accountSpentTodayMicro(limits.accountId) : db.payerSpentTodayMicro(p.sender);
    if (spentToday + v.priceMicro > limits.dailyMicro) {
      return { abort: true, reason: `daily limit of ${usd(limits.dailyMicro)} reached` };
    }
    // Payouts: re-run the compliance check with the REAL payer (the quote may have been made without one).
    if (q.type === "payout") {
      const stored = JSON.parse(q.recipient_json) as { sender?: { name?: string; country?: string; reference?: string }; sender_account?: string };
      // A sender filled in from a business account is only valid for THAT account. The
      // quote-time payer is a claim; this is where it has to be true. Without this a
      // stranger could quote naming a partner's address, inherit the partner's legal
      // name as the sender, and settle the payment from their own wallet.
      if (stored.sender_account && stored.sender_account !== limits.accountId) {
        return { abort: true, reason: "this quote's sender belongs to another account — re-quote with your own sender" };
      }
      const payoutToday = limits.accountId
        ? db.accountSpentTodayMicro(limits.accountId, "payout")
        : db.payerSpentTodayMicro(p.sender, "payout");
      const c = checkPayout({
        country: q.country, priceMicro: q.price_micro, sender: stored.sender, payerPayoutsTodayMicro: payoutToday,
        recipientPayoutsTodayMicro: db.recipientSpentTodayMicro(orders.recipientHash(JSON.parse(q.recipient_json))),
        recipientDailyMaxUsd: config.payout.recipientDailyUsd,
        blockedCountries: config.limits.blockedCountries, maxUsd: ceiling / 1_000_000, kycAboveUsd: config.payout.kycAboveUsd,
        account: limits.accountId && limits.kybReference ? { id: limits.accountId, kybReference: limits.kybReference } : undefined,
      });
      if (!c.ok) return { abort: true, reason: c.reason };
    }
    return;
  };
}

/** `GET /v1/catalog` page size, and the ceiling a caller may ask for. A catalogue of
 *  3,046 eSIM packages is 3 MB of JSON; a default page is a screenful of it. */
const CATALOG_PAGE = 100;
const CATALOG_MAX_PAGE = 500;

/** Read once, on the first request that wants it. "" means "looked and it was not there". */
let receiptsSpec: string | undefined;

export function buildApp(deps: AppDeps): Hono<Env> {
  const { db, supplier, orders } = deps;
  const app = new Hono<Env>();
  const base = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
  const guard = new ReplayGuard();
  const limiter = new RateLimiter(config.limits.freeRoutePerMinute);
  const preflight = makePreflight(orders, db, guard);
  // @x402/avm ≥2.2x exports spec-compliant 32-char CAIP-2 ids ("algorand:wGHE2…N73k"), but the
  // GoPlausible facilitator, the Bazaar and the leaderboard all key on the FULL genesis hash form
  // ("algorand:wGHE2…kit8="). Using the SDK constant makes the facilitator reject the route at
  // startup ("Facilitator does not support scheme exact on network …"). Pin to the facilitator's form.
  const NETWORK_CAIP2 = `algorand:${IS_MAINNET ? ALGORAND_MAINNET_GENESIS_HASH : ALGORAND_TESTNET_GENESIS_HASH}` as Network;
  const USDC_ASSET = IS_MAINNET ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
  /** The Global x402 Challenge's Bazaar marker. See the note on `extra` below for why
   *  it is carried in the payment requirements rather than the resource's `tags`. */
  const CHALLENGE_TAG = "x402-global-challenge";
  const receiptPubkey = config.receipt.publicKey || (config.receipt.privateKey ? derivePublicKey(config.receipt.privateKey) : "");

  // What the wired suppliers can actually sell. CompositeSupplier computes it; a bare
  // Supplier (tests) may not, in which case fall back to the full set.
  const liveTypes: ProductType[] = [...((supplier as { productTypes?: readonly ProductType[] }).productTypes
    ?? (["topup", "esim", "bill", "payout"] as const))];
  const pageFacts = { base, network: config.network, pubkey: receiptPubkey, brand: config.brand.name, site: config.brand.site, products: liveTypes };

  app.use("*", cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["PAYMENT-RESPONSE", "PAYMENT-REQUIRED", "X-PAYMENT-RESPONSE"] }));

  // Nothing else in the stack caps a request body: Caddy does not by default and
  // @hono/node-server does not either, so an unauthenticated POST could ask this
  // process to buffer as much as it liked. 64 KB is orders of magnitude above any
  // real body here (a quote is a few hundred bytes; the largest MCP call is smaller).
  //
  // NOT applied to POST /v1/orders. That body is read by the x402 adapter rather than
  // by Hono, and interposing a reader on the settlement path to defend against a body
  // that can only be `{"quoteId":"…"}` would be trading a live payment path against a
  // vector that the routes below already close.
  const BODY_LIMIT = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) });
  app.post(`${P}/quote`, BODY_LIMIT);
  app.post(`${P}/verify`, BODY_LIMIT);
  app.post(`${P}/links`, BODY_LIMIT);
  app.post("/mcp", BODY_LIMIT);

  // ── free routes: rate limited per client IP ──
  app.use(`${P}/*`, async (c, next) => {
    if (c.req.method === "POST" && c.req.path === `${P}/orders`) return next();
    if (!limiter.allow(clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip")))) {
      return c.json({ error: "rate limited" }, 429);
    }
    await next();
  });

  // The float cache lives on OrderService, not here, so that the number this endpoint
  // publishes and the number quote() refuses on are the same number read at the same
  // time. A monitor that says "fine" while quotes are being refused is worse than no
  // monitor.

  app.get("/health", async (c) => {
    // One float per SUPPLIER, not one per service. Airtime spends Reloadly's balance,
    // eSIMs spend eSIM Access's, payouts spend the partner's — three separate ways to
    // strand an order, and a single number cannot describe them. This was already true
    // for payouts; eSIMs made it true twice, and a health check reporting the airtime
    // float while an agent is buying eSIMs is a monitor that lies politely.
    // Cached per group in OrderService (60s), so this is one supplier call a minute.
    const [{ floatMicro, committedMicro, availableMicro }, payoutFloat, esimFloat] = await Promise.all([
      orders.floatStatus(),
      orders.floatStatus("payout"),
      orders.floatStatus("esim"),
    ]);
    // CompositeSupplier knows which wallet fills which product; a bare Supplier (tests)
    // does not, and then there is only one float to report anyway.
    const groupFor = (supplier as { floatGroupFor?: (t: ProductType) => string }).floatGroupFor?.bind(supplier);
    const esimIsSeparate = liveTypes.includes("esim") && !!groupFor && groupFor("esim") !== groupFor("topup");
    // Two different questions, and they used to be conflated.
    //
    // `float_covers_max_order` asks whether the float covers the largest order we
    // ADVERTISE. That mattered enormously when a quote above the float was accepted and
    // then failed after settlement — it was a silent outage. It no longer is: quote()
    // refuses what the float cannot fill and says how much is left, so this is now a
    // capacity fact, not a fault.
    //
    // `ok` asks whether the service can fill an order AT ALL, which is what a monitor
    // should page on. Keying it on the advertised ceiling would page continuously while
    // the service was happily selling every order it accepted — an alarm that is always
    // on is an alarm nobody reads.
    //
    // Both measure AVAILABLE float, not the raw balance: an order already settled and
    // awaiting delivery has spent its share even though the supplier has not debited it.
    const maxOrderMicro = toMicro(config.limits.maxOrderUsd);
    const minOrderMicro = toMicro(config.pricing.minOrderUsd);
    const coversMaxOrder = availableMicro !== null && availableMicro >= maxOrderMicro;
    return c.json({
      // The container healthcheck keys on the HTTP status, not this field, so a dry
      // float reports the truth without restart-looping the container.
      // Can this service fill ANY order right now? With more than one float, that is a
      // question about the live products, not about airtime — a dry airtime float while
      // eSIMs sell perfectly well is not an outage, and paging on it teaches people to
      // ignore the page.
      ok: [availableMicro, ...(esimIsSeparate ? [esimFloat.availableMicro] : [])]
        .some((a) => a !== null && a >= minOrderMicro),
      network: config.network,
      supplier: supplier.name,
      supplier_ok: floatMicro !== null,
      supplier_float_usdc: floatMicro === null ? null : formatUsdc(floatMicro),
      // Already owed to orders that settled and have not been delivered yet.
      float_committed_usdc: formatUsdc(committedMicro),
      // What the next order can actually be filled from — the number quote() enforces.
      float_available_usdc: availableMicro === null ? null : formatUsdc(availableMicro),
      // Capacity, not a fault: quote() refuses anything above the available float.
      float_covers_max_order: coversMaxOrder,
      max_order_usdc: formatUsdc(maxOrderMicro),
      min_order_usdc: formatUsdc(minOrderMicro),
      // The payout partner's wallet is a SEPARATE balance, and a separate way to
      // strand a $156 ticket. Absent when no partner is wired; 0 means wired and dry.
      ...(payoutFloat.floatMicro === null && payoutFloat.committedMicro === 0
        ? {}
        : {
            payout_float_usdc: payoutFloat.floatMicro === null ? null : formatUsdc(payoutFloat.floatMicro),
            payout_float_available_usdc: payoutFloat.availableMicro === null ? null : formatUsdc(payoutFloat.availableMicro),
          }),
      // eSIMs come out of a different supplier's prepaid balance. Present only when that
      // is a distinct wallet — when eSIMs are served by the goods supplier it would just
      // be the same number twice.
      ...(esimIsSeparate
        ? {
            esim_float_usdc: esimFloat.floatMicro === null ? null : formatUsdc(esimFloat.floatMicro),
            esim_float_available_usdc: esimFloat.availableMicro === null ? null : formatUsdc(esimFloat.availableMicro),
          }
        : {}),
      // Payers who were charged, received nothing, and could not be refunded. Terminal
      // and never retried, so this number only goes down when a human acts on it.
      stranded_orders: db.ledgerStats().stranded,
      receipt_pubkey: receiptPubkey,
    });
  });

  app.get("/", (c) => c.html(landingHtml({ ...pageFacts, payTo: config.payTo })));
  mountBrand(app);
  app.get("/agent.md", (c) => c.text(agentMd(pageFacts)));

  /**
   * The receipt format, served as a spec.
   *
   * `POST /v1/verify` invites other x402 sellers to use our verifier, which is an empty
   * invitation unless the format is written down somewhere they can read without a
   * repository. Served from `docs/RECEIPTS.md` — one source of truth, not a copy pasted
   * into a template string that would drift the first time either changed.
   *
   * If the file is missing (an image built without `docs/`), answer with a pointer
   * rather than a 500: a spec URL that errors is worse than one that says where to look.
   */
  app.get("/receipts.md", (c) => {
    if (receiptsSpec === undefined) {
      try {
        receiptsSpec = readFileSync(new URL("../docs/RECEIPTS.md", import.meta.url), "utf8");
      } catch {
        receiptsSpec = "";
      }
    }
    c.header("content-type", "text/markdown; charset=utf-8");
    return c.body(receiptsSpec || `# Receipt format v1\n\nThe spec file did not ship with this build. Verify a receipt at POST ${base}/v1/verify; the signing key is at ${base}/v1/pubkey.\n`);
  });
  // The original plain console. Kept: it has no build step, so it still works when
  // web/dist is missing, which makes it the fallback when /pay cannot start.
  app.get("/console", (c) => c.html(consoleHtml({ base, network: config.network, algodUrl: config.algodUrl, brand: config.brand.name, products: liveTypes })));

  /** The batch payout console (web/), served from this process. See src/pay-console.ts. */
  if (!mountPayConsole(app)) {
    // Not fatal — the API and the plain /console still work — but it must be visible,
    // because a deploy that forgot `pnpm build:web` otherwise looks fine until someone
    // opens /pay.
    console.warn("⚠ /pay: web/dist/client is missing — run `pnpm build:web`. /console still works.");
  }

  /** The verifier for people. Same endpoint underneath as the CLI and the MCP tool. */
  app.get("/verify", (c) => c.html(verifyPageHtml(base)));
  app.get("/fund", (c) => c.html(fundHtml(pageFacts)));
  app.get("/llms.txt", (c) => c.text(agentMd(pageFacts)));

  /**
   * There was no /robots.txt at all — a 404 — while the console shipped one at
   * /pay/robots.txt, which no crawler ever requests and which allowed everything.
   *
   * The discovery surface (/, /agent.md, /llms.txt, the ledger) is meant to be found:
   * that is the whole distribution strategy. The operator console is not. Its URLs are
   * noise in an index and it sits behind a wallet connection anyway.
   */
  const crawlRules = [
    "Allow: /",
    "Disallow: /pay",
    "Disallow: /console",
    // Pay links carry a masked recipient and a note someone wrote for one person.
    "Disallow: /l/",
  ];
  /**
   * AI crawlers are named and ALLOWED here, unlike the rest of the IoMarkets portfolio,
   * which blocks them: agents finding this service is the distribution strategy. They
   * are listed by name so the policy is explicit (and so the portfolio's SEO audit sees
   * one). A named group replaces the `*` group for that crawler, so each one repeats
   * the same rules; one group per agent is the portfolio's robots.txt convention.
   */
  const aiCrawlers = ["Google-Extended", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User"];
  app.get("/robots.txt", (c) => c.text([
    "User-agent: *",
    ...crawlRules,
    "",
    ...aiCrawlers.flatMap((ua) => [`User-agent: ${ua}`, ...crawlRules, ""]),
    `Sitemap: ${base}/sitemap.xml`,
    // Not a sitemap, but the page an agent should read first.
    `# Agent docs: ${base}/agent.md`,
    "",
  ].join("\n")));

  /** The human-facing pages. Proof pages (/p/:txid) are per order and are not listed. */
  const sitemapPaths = ["/", "/verify", "/fund", "/earn"];
  app.get("/sitemap.xml", (c) => c.body([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemapPaths.map((p) => `  <url><loc>${base}${p}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n"), 200, { "content-type": "application/xml; charset=utf-8" }));

  // ── hosted MCP (Streamable HTTP) ────────────────────────────────────────────
  // Zero-install access for any MCP client: no clone, no local process, no key
  // handed to us. This server holds NO wallet, so `buy` returns the x402 challenge
  // for the caller to pay from its own wallet — see src/mcp-tools.ts.
  //
  // Stateless (no session id, JSON responses) and a fresh server+transport per
  // request: the tools are pure request/response, so there is no session worth
  // keeping, and nothing can leak between callers.
  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ error: "POST JSON-RPC to this endpoint (MCP Streamable HTTP)", docs: `${base}/agent.md` }, 405);
    }
    const server = new McpServer({ name: "iomarkets-topup", version: "0.1.0" });
    registerTools(server, {
      // In-process, so this never depends on PUBLIC_BASE_URL being reachable from the box.
      call: async (path, init) => app.request(path, init),
      apiBase: base,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  mountGrowth(app, {
    db, orders, referrals: deps.referrals, base, receiptPubkey, network: config.network, explorerTx, brand: config.brand.name,
  });

  app.get(`${P}/pubkey`, (c) => c.json({ algorithm: "ed25519", public_key: receiptPubkey, receipt_version: 1 }));

  /**
   * Everything a BROWSER client needs to build a payment, and nothing else.
   *
   * The console runs as static files (src/pay-console.ts), so it cannot have these
   * injected into its HTML the way /console does — and hardcoding them in the bundle
   * would ship a mainnet algod URL to a testnet box. All of it is already public:
   * the algod endpoint is a public node, the ASA id is on chain, and the ceiling is
   * the same number /v1/limits reports.
   *
   * The ceilings are here so the console can warn BEFORE quoting that a row exceeds
   * what this service will accept, rather than after a round trip. They are not the
   * client's spend control: the browser caps each payment at the price that row was
   * quoted and approved at, which is tighter than any category ceiling and refuses a
   * 402 asking for more than was shown on screen. See web/src/lib/io/wallet.ts.
   *
   * Note these are the SERVICE limits. A payer's own ceilings — including the
   * separate, higher payout ceiling — come from /v1/limits, which needs an address.
   */
  /**
   * Which product types are filled by a MOCK supplier right now.
   *
   * `PAYOUT_SUPPLIER=mock` is the correct local value while no licensed partner is
   * wired — it is the only way to exercise the payout path — and `preflight
   * --production` refuses it, so it cannot reach the box. But it renders corridors
   * that look exactly like real ones, with no marking anywhere: screen-share that
   * to a prospect or a partner and you have shown them a product that does not
   * exist. `?demo=1` at least says so on the page; this did not.
   *
   * Derived from the supplier actually routed to each type rather than from the env
   * var, so a mock reached by any path is reported.
   */
  const groupForType = (supplier as { floatGroupFor?: (t: ProductType) => string }).floatGroupFor?.bind(supplier);
  const simulatedTypes = liveTypes.filter((t) =>
    /(^|:)mock$/.test(groupForType?.(t) ?? (supplier.name === "mock" ? "mock" : "")),
  );

  app.get(`${P}/client-config`, (c) => c.json({
    /** Product types served by a mock supplier — nothing here is really delivered. */
    simulated: simulatedTypes,
    network: config.network,
    caip2: NETWORK_CAIP2,
    algod_url: config.algodUrl,
    usdc_asa: USDC_ASSET,
    max_order_usdc: formatUsdc(toMicro(config.limits.maxOrderUsd)),
    min_order_usdc: formatUsdc(toMicro(config.pricing.minOrderUsd)),
  }));

  /**
   * Verify a receipt — **any** receipt, including ones this server did not issue.
   *
   * The strongest claim this service makes is that a stranger can check a delivery
   * without trusting us. That was true and unreachable: the on-chain half of the check
   * lived in a CLI script, so "verifiable by anyone" meant "verifiable by anyone who
   * clones a repo". This is the same code as `pnpm verify --online`, reachable the way
   * the buying is.
   *
   * It verifies against the key named IN THE RECEIPT, and reports separately whether
   * that key is ours. Any other x402 seller who adopts the format (docs/RECEIPTS.md)
   * gets a working verifier out of it — which is the difference between publishing a
   * spec and publishing a self-check.
   *
   * Free, rate-limited with the other free routes by the `/v1/*` middleware above, body
   * capped like the other POSTs, and it writes nothing.
   */
  app.post(`${P}/verify`, async (c) => {
    const body = await c.req.json().catch(() => null);
    // `pnpm verify` accepts either a bare receipt or an order response that contains
    // one; a route that refused the second would be refusing the exact JSON an agent
    // just got back from GET /v1/orders/:id.
    const candidate = (body as { receipt?: unknown })?.receipt ?? body;
    const parsed = ReceiptBody.safeParse(candidate);
    if (!parsed.success) {
      return c.json({ error: "body must be a receipt — {payload, signature} — or an order response containing one", issues: parsed.error.issues }, 400);
    }
    // On-chain checks cost an indexer round trip, so they are opt-out rather than
    // mandatory; the signature alone is the fast path an agent can afford per order.
    const online = c.req.query("online") !== "0";
    const report = await verifyFully(parsed.data as Receipt, {
      ourPubkey: receiptPubkey || undefined,
      chain: online ? { indexerUrl: config.indexerUrl, usdcAsa: config.usdcAsa, timeoutMs: 8_000 } : undefined,
    });
    return c.json({ ...report, indexer: online ? config.indexerUrl : null, spec: `${base}/receipts.md` });
  });

  app.get(`${P}/lookup`, async (c) => {
    const msisdn = normalizeMsisdn(c.req.query("phone") ?? "");
    if (!msisdn) return c.json({ error: "phone must be E.164, e.g. +919876543210" }, 400);
    const l = await supplier.lookupPhone(msisdn);
    if (l.country && config.limits.blockedCountries.includes(l.country)) return c.json({ error: "destination not supported" }, 403);
    const offers = l.country ? await supplier.listOffers({ type: "topup", country: l.country, brand: l.brand }) : [];
    // An auto-detected operator is a GUESS from the number range, and on an MVNO it is
    // reliably WRONG: measured 2026-08-29, a UK Tesco Mobile SIM and the
    // supplier's own auto-detect returns "O2 PIN England", because Tesco rides O2's
    // network. For a voucher product that is not a cosmetic error — a £10 O2 PIN does
    // not redeem on a Tesco SIM, and nothing fails: the order delivers, the receipt
    // verifies, and the buyer holds a code for the wrong network. So when the detected
    // offers are vouchers, say so and hand back the country's other brands to choose
    // from, rather than presenting one guess as the answer.
    const all = l.country ? await supplier.listOffers({ type: "topup", country: l.country }) : [];
    const brands = [...new Map(all.map((o) => [o.brand, o.brandName ?? o.brand])).entries()]
      .filter(([b]) => b !== l.brand)
      .map(([brand, brandName]) => ({ brand, brandName }));
    return c.json({
      phone: `+${msisdn}`, country: l.country, brand: l.brand, brandName: l.brandName,
      offers: offers.filter((o) => !offerTouchesBlocked(o, config.limits.blockedCountries)).map(offerView),
      operator_detection: "auto",
      confirm_operator:
        "The operator was detected from the number range and is a guess. MVNOs (Tesco Mobile, Giff Gaff, Lebara, Voxi, Sky…) are detected as the host network they ride on. CONFIRM the brand with the human before buying — a voucher for the wrong network delivers successfully and cannot be redeemed or refunded.",
      ...(brands.length ? { other_brands: brands } : {}),
    });
  });

  // Indicative FX: 1 USDC → local currency at our SALE rate (supplier cost + markup), so an
  // agent can budget before quoting. The quote is the only binding price.
  app.get(`${P}/fx`, async (c) => {
    const to = (c.req.query("to") ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(to)) return c.json({ error: "to=<ISO-4217>, e.g. to=INR" }, 400);
    // The markup can differ per product type, so an indicative rate has to say which type
    // it is indicative OF — otherwise a payout budgeted at the airtime markup misses.
    // eSIMs never reach here: they have no send currency.
    const type = (c.req.query("type") ?? "payout") as ProductType;
    if (!["topup", "bill", "payout"].includes(type)) return c.json({ error: "type must be topup | bill | payout" }, 400);
    const costRate = (await supplier.fxRate?.(to)) ?? null;
    if (!costRate) return c.json({ error: `no corridor for ${to}` }, 404);
    const saleRate = costRate / (1 + pricingFor(config.pricing, type).markupBps / 10_000);
    const amount = Number(c.req.query("amount") ?? "0");
    return c.json({
      from: "USDC", to, type, rate: Number(saleRate.toFixed(4)), inverse_usdc_per_unit: Number((1 / saleRate).toFixed(6)),
      ...(amount > 0 ? { amount_local: amount, estimate_usdc: formatUsdc(sellPrice(Math.ceil((amount / costRate) * 1e6), type)) } : {}),
      note: "indicative; POST /v1/quote returns the binding price", as_of: new Date().toISOString(),
    });
  });

  /**
   * Where can this product actually be delivered?
   *
   * Free, and answerable only by a supplier that enumerates its destinations without
   * being given one — eSIM Access lists its catalogue (so `offers` is a count per
   * country), Reloadly lists its countries (so `offers` is absent, `name` and `currency`
   * present). **An empty list means "cannot tell you", never "nowhere"**, and callers
   * must fall back rather than conclude the product is unavailable. Both consoles do.
   */
  app.get(`${P}/countries`, async (c) => {
    const type = (c.req.query("type") ?? "esim") as ProductType;
    if (!["topup", "esim", "bill", "payout"].includes(type)) return c.json({ error: "type must be topup | esim | bill | payout" }, 400);
    // A supplier that is down answers the same as one that will not enumerate: the
    // callers keep their fallback list either way, and a free route should not turn a
    // supplier hiccup into a dead picker.
    const list = await (supplier as { listCountries?: (t: ProductType) => Promise<SupplierCountry[]> }).listCountries?.(type)
      .catch((e: unknown) => { console.warn(`countries(${type}): ${(e as Error).message}`); return [] as SupplierCountry[]; }) ?? [];
    const countries = list.filter((x) => !config.limits.blockedCountries.includes(x.code));
    return c.json({ type, countries, total: countries.length, enumerable: countries.length > 0 });
  });

  app.get(`${P}/catalog`, async (c) => {
    const type = (c.req.query("type") ?? "topup") as ProductType;
    if (!["topup", "esim", "bill", "payout"].includes(type)) return c.json({ error: "type must be topup | esim | bill | payout" }, 400);
    const country = c.req.query("country")?.toUpperCase();
    if (country && config.limits.blockedCountries.includes(country)) return c.json({ error: "destination not supported" }, 403);

    // **Paginated, because one supplier's catalogue is 3 MB.** Measured 2026-09-02:
    // eSIM Access lists 3,046 packages across 197 countries when no country is given.
    // Serving that whole array on a free, unauthenticated route — to an agent that reads
    // the first screen of it — is a page nobody wants and a bill somebody pays. The
    // default is a screenful; `limit=0` is the deliberate way to ask for everything.
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? CATALOG_PAGE : Math.min(Math.max(Number(limitRaw) | 0, 0), CATALOG_MAX_PAGE);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) | 0, 0);

    // Filtering happens after the supplier call, so ask for everything and page here:
    // a limit applied before the filters would return short pages of a shorter list.
    const offers = (await supplier.listOffers({ type, country, brand: c.req.query("brand") }))
      .filter((o) => !offerTouchesBlocked(o, config.limits.blockedCountries))
      // A FIXED offer the floor would price is unsellable at any amount — quote()
      // refuses it, so listing it advertises something no one can buy. A RANGE offer
      // stays: the buyer picks the amount, and quote() tells them the minimum.
      .filter((o) => !(o.priceType === "fixed" && o.costMicro !== undefined && floorInflatesPrice(o.costMicro, pricingFor(config.pricing, type))));

    const page = limit ? offers.slice(offset, offset + limit) : offers.slice(offset);
    const nextOffset = offset + page.length;
    return c.json({
      type, country: country ?? null,
      total: offers.length,
      offset,
      // Present only when there is more — an agent should not have to compare numbers.
      ...(nextOffset < offers.length ? { next_offset: nextOffset } : {}),
      offers: page.map(offerView),
    });
  });

  app.post(`${P}/quote`, async (c) => {
    const parsed = QuoteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    if (input.recipient.phone) {
      const m = normalizeMsisdn(input.recipient.phone);
      if (!m) return c.json({ error: "recipient.phone must be E.164" }, 400);
      input.recipient.phone = m;
    }
    const q = await orders.quote({ ...input, recipient: input.recipient, sender: input.sender, payer: input.payer, ref: input.ref });
    q.pay.endpoint = `${base}${P}/orders`;
    return c.json(q);
  });

  app.get(`${P}/orders/:id`, (c) => {
    const o = db.getOrder(c.req.param("id"));
    if (!o) return c.json({ error: "not found" }, 404);
    return c.json(orderView(o, base));
  });

  // What may this address spend? The console reads this before it lets anyone build a
  // batch, and an agent can read it to size an order instead of discovering a ceiling
  // by having a quote refused. Deliberately says nothing about WHO an account is.
  app.get(`${P}/limits`, async (c) => {
    const payer = c.req.query("payer");
    if (payer && !/^[A-Z2-7]{58}$/.test(payer)) return c.json({ error: "payer must be an Algorand address" }, 400);
    const l = orders.limitsForPayer(payer);
    // The float is a ceiling too, and until now the only place it appeared was /health —
    // a monitoring endpoint an agent has no reason to read. A caller pricing a basket
    // against max_order_usdc alone can be refused by quote() for a reason this route
    // never mentioned. Already public on /health, so nothing new is disclosed.
    const { availableMicro } = await orders.floatStatus();
    // Per product, for the same reason /health reports per product: an agent buying an
    // eSIM cannot fill it from the airtime float, and a single number would tell it the
    // wrong thing in whichever direction the two balances happen to differ.
    const fillableByType = Object.fromEntries(
      await Promise.all(liveTypes.map(async (t) => [t, (await orders.floatStatus(t)).availableMicro] as const)),
    ) as Record<string, number | null>;
    // Ceilings only. This route is unauthenticated and anyone can name any address —
    // Algorand addresses are public, and a settlement txid hands you the payer — so
    // returning a counterparty's spend-to-date would publish their live payout volume
    // to whoever asked. Ceilings are far less sensitive (a caller learns them anyway
    // the first time a quote is refused); a running total is business intelligence.
    // The server still enforces the daily cap; the caller simply reads it in a refusal
    // rather than in advance.
    return c.json({
      payer: payer ?? null,
      tier: l.tier,
      suspended: Boolean(l.blocked),
      max_order_usdc: formatUsdc(l.maxOrderMicro),
      max_payout_usdc: formatUsdc(l.payoutMaxMicro),
      daily_usdc: formatUsdc(l.dailyMicro),
      // Types whose effective ceiling is lower than max_order_usdc. An agent that reads
      // this can price a basket before quoting instead of discovering the cap in a 400.
      // Ceilings only, like everything else here — see the note above.
      type_limits_usdc: Object.fromEntries(
        Object.keys(l.typeMaxMicro ?? {})
          .map((t) => [t, ceilingMicro(l, t)] as const)
          .filter(([t, m]) => m < (t === "payout" ? l.payoutMaxMicro : l.maxOrderMicro))
          .map(([t, m]) => [t, formatUsdc(m)]),
      ),
      // What the supplier float can actually fill right now, net of orders already
      // settled and awaiting delivery. `null` = the supplier balance is unreadable, in
      // which case quote() does not enforce it either (it fails open). This is a
      // catalogue-wide ceiling and is NOT per-payer: it binds every caller equally.
      fillable_now_usdc: availableMicro === null ? null : formatUsdc(availableMicro),
      fillable_now_by_type_usdc: Object.fromEntries(
        Object.entries(fillableByType).map(([t, a]) => [t, a === null ? null : formatUsdc(a)]),
      ),
      sender_verified: Boolean(l.kybReference),
    });
  });

  app.get(`${P}/ledger`, (c) => {
    const s = db.ledgerStats();
    return c.json({
      network: config.network,
      orders: s.orders, delivered: s.delivered, refunded: s.refunded,
      in_flight: s.in_flight,
      // Terminal, unresumed, and a payer is out of pocket. Reported on its own because
      // the previous shape folded it into in_flight — see Db.ledgerStats.
      stranded: s.stranded,
      // null, not 100, when nothing has been sold. A fresh deploy publishing
      // "100% delivered or refunded" is a claim about deliveries that never happened,
      // on the page that exists to be checkable.
      delivered_or_refunded_pct: s.orders ? Math.round(((s.delivered + s.refunded) / s.orders) * 1000) / 10 : null,
      volume_usdc: formatUsdc(s.volume_micro),
      countries: s.countries.map((r) => ({ country: r.country, orders: r.orders, volume_usdc: formatUsdc(r.volume_micro) })),
      types: s.types.map((r) => ({ type: r.type, orders: r.orders, volume_usdc: formatUsdc(r.volume_micro) })),
      recent: db.recentOrders(25).map(({ price_micro, ...o }) => ({
        ...o,
        price_usdc: formatUsdc(price_micro),
        settlement_url: explorerTx(o.settlement_txid),
        // The trust table promises a refund is an on-chain transfer anyone can open.
        // /v1/orders/:id has carried this link all along; the public ledger — the one
        // place a stranger checks the promise without holding an order id — did not.
        refund_url: o.refund_txid ? explorerTx(o.refund_txid) : undefined,
        // Shareable proof of delivery, keyed by the (already public) settlement txid.
        ...(o.type !== "payout" ? { proof_url: `${base}/p/${o.settlement_txid}` } : {}),
      })),
    });
  });

  // ── the paid route ──
  const quoteIdOf = async (ctx: HTTPRequestContext): Promise<unknown> => {
    const body = await (ctx.adapter as { getBody?: () => unknown | Promise<unknown> }).getBody?.();
    return (body as { quoteId?: unknown } | undefined)?.quoteId;
  };

  const routes: RoutesConfig = {
    [ORDERS_ROUTE]: {
      accepts: {
        scheme: "exact",
        network: NETWORK_CAIP2,
        payTo: config.payTo,
        price: async (ctx) => {
          const v = orders.validQuote(String(await quoteIdOf(ctx)));
          if (!v.ok) throw new Error(`unpayable quote: ${v.reason}`);
          return toPriceString(v.priceMicro);
        },
        // `tag` is the challenge's ELIGIBILITY marker, and it has to live HERE.
        // Measured against the live Bazaar 2026-08-29: 422 of the first 500 listed
        // resources carry `accepts[0].extra.tag === "x402-global-challenge"`, and
        // ZERO carry a top-level `tags` array or `discoveryInfo.tags` — the
        // facilitator simply does not store the resource-level `tags` below. That
        // field stays for other consumers, but it is not what gets us counted.
        // `pnpm check-bazaar` asserts this on the live listing after the first
        // settled payment; do not remove either the field or the check.
        extra: { asset: USDC_ASSET, tag: CHALLENGE_TAG },
      },
      resource: `${base}${P}/orders`,
      // Rendered from the live product set, not from a hand-written list. This string is
      // what a Bazaar browser — and a judge — reads to decide what this is, and it had
      // been promising four product types while one was fulfillable.
      description:
        `Buy real-world goods for an AI agent's principal in 150+ countries — ${productList(pageFacts)} — paid per order in USDC on Algorand. Flow: GET /v1/lookup?phone=… or GET /v1/catalog?type=${liveTypes[0] ?? "topup"} → POST /v1/quote → pay this route with {quoteId} → poll GET /v1/orders/{id} until delivered. Every delivered or refunded order carries an ed25519-signed receipt naming the on-chain settlement (and refund) txid; failed deliveries are refunded on-chain automatically.`,
      serviceName: config.brand.name,
      tags: [CHALLENGE_TAG, ...liveTypes, "airtime", "agentic-commerce", "real-world", "x402", "algorand"],
      unpaidResponseBody: async (ctx) => {
        const id = String(await quoteIdOf(ctx));
        const q = db.getQuote(id);
        return { contentType: "application/json", body: q ? JSON.parse(q.summary_json) : { error: "unknown quoteId" } };
      },
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          input: { quoteId: "q_… (from POST /v1/quote)" },
          inputSchema: { properties: { quoteId: { type: "string" } }, required: ["quoteId"] },
          output: {
            example: {
              orderId: "ord_…", status: "paid", type: "topup", country: "IN", brand: "JIO", price_usdc: "3.900000",
              settlement_txid: "…", status_url: `${base}${P}/orders/ord_…`, terminal: false,
            },
          },
        }),
      },
    },
  };

  // Settlement happens INSIDE the payment middleware, after the handler. This
  // outer middleware sees the settled txid and only then creates the order.
  const finalizeOrder: MiddlewareHandler<Env> = async (c, next) => {
    await next();
    const quoteId = c.get("pendingQuote");
    if (!quoteId) return;
    const settled = settledFromHeader(c.res.headers.get("PAYMENT-RESPONSE") ?? c.res.headers.get("X-PAYMENT-RESPONSE"));
    if (!settled) {
      if (c.res.status === 200) c.res = c.json({ error: "payment did not settle — no order was created and nothing was charged" }, 502);
      return;
    }
    const payer = settled.payer ?? paymentTxn(c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT"))?.sender ?? "unknown";
    const settleHeader = c.res.headers.get("PAYMENT-RESPONSE");
    // The txid is burned HERE, on a confirmed settlement — never in preflight. A
    // payment that failed to settle must stay replayable, or a dropped connection
    // locks the payer out of the identical (deterministic) transaction they will
    // rebuild on retry. See ReplayGuard.
    guard.record(settled.txid);
    const order = orders.createPaidOrder(quoteId, payer, settled.txid);
    c.res = c.json(orderView(order, base), 202);
    if (settleHeader) c.res.headers.set("PAYMENT-RESPONSE", settleHeader);
  };
  app.use(`${P}/orders`, finalizeOrder);

  if (deps.paymentMiddleware) {
    app.use(`${P}/orders`, deps.paymentMiddleware);
  } else {
    const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitator)
      .registerExtension(bazaarResourceServerExtension)
      .register("algorand:*", new ExactAvmScheme());
    const httpServer = new x402HTTPResourceServer(resourceServer, routes);
    const hook: ProtectedRequestHook = async (ctx) => preflight(await quoteIdOf(ctx), ctx.paymentHeader ?? undefined);
    httpServer.onProtectedRequest(hook);
    app.use(`${P}/orders`, paymentMiddlewareFromHTTPServer(httpServer) as MiddlewareHandler);
  }

  app.post(`${P}/orders`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { quoteId?: unknown };
    const pre = await preflight(body.quoteId, c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT"));
    if (pre) return c.json({ error: pre.reason }, 403);
    c.set("pendingQuote", String(body.quoteId));
    return c.json({ pending: true }); // replaced by finalizeOrder once settled
  });

  app.onError((err, c) => {
    if (err instanceof QuoteError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof SupplierError) return c.json({ error: `supplier: ${err.message}` }, err.retryable ? 503 : 502);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

function offerView(o: import("./suppliers/types.js").Offer) {
  return {
    offerId: o.id, type: o.type, country: o.country, brand: o.brand, brandName: o.brandName, name: o.name, notes: o.notes,
    priceType: o.priceType,
    sendCurrency: o.sendCurrency, sendFixed: o.sendFixed, sendMin: o.sendMin, sendMax: o.sendMax,
    dataGB: o.dataGB, durationDays: o.durationDays, regions: o.regions,
    payoutMethod: o.payoutMethod, requiredFields: o.requiredFields, settlementSeconds: o.settlementSeconds,
    // Indicative — the exact charge is fixed by POST /v1/quote.
    price_usdc_from: o.priceType === "fixed" && o.costMicro !== undefined
      ? formatUsdc(sellPrice(o.costMicro, o.type))
      : o.costMinMicro !== undefined ? formatUsdc(sellPrice(o.costMinMicro, o.type)) : undefined,
  };
}
import { sellPriceMicro } from "./money.js";
const sellPrice = (cost: number, type?: ProductType) => sellPriceMicro(cost, pricingFor(config.pricing, type));
export type { Context };
