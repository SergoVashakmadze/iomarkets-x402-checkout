// The human-facing page and the agent-facing instructions. Both are generated
// from the same facts so they can never disagree.

import type { ProductType } from "./suppliers/types.js";

/** `brand`/`site` come from BRAND_NAME / BRAND_SITE so a rename is a config change,
 *  not an edit to every page. */
export interface PageFacts {
  base: string; network: string; pubkey: string; payTo?: string; brand: string; site: string;
  /**
   * The product types the wired suppliers can actually fulfil right now
   * (CompositeSupplier.availableTypes). Every sentence below that names a product
   * renders from this, so a deprecated or unwired supplier cannot leave a promise
   * behind on the page an agent reads first. Absent = all four, for callers that
   * predate this.
   */
  products?: readonly ProductType[];
}

/** One phrase per product, so the prose and the catalogue cannot disagree. */
const PRODUCT_PHRASE: Record<ProductType, string> = {
  topup: "mobile airtime & data top-ups",
  esim: "travel eSIMs",
  bill: "prepaid bills",
  payout: "international payments (bank, mobile money, UPI)",
};

export function productList(f: PageFacts): string {
  const ts = f.products ?? (["topup", "esim", "bill", "payout"] as const);
  const parts = ts.map((t) => PRODUCT_PHRASE[t]);
  if (parts.length === 0) return "nothing right now — no supplier is wired";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function agentMd(f: PageFacts): string {
  return `# ${f.brand} — real-world checkout for AI agents (x402 on Algorand)

Buy real-world goods for your principal in 150+ countries.
No account, no API key, no card. Pay per order in USDC on Algorand (${f.network}) using x402.

**Live right now: ${productList(f)}.** This list is what the wired suppliers can actually fulfil today, not a
roadmap — \`GET ${f.base}/v1/catalog?type=<type>\` returns an empty list for anything not on it, and a quote
for one is refused rather than accepted and then failed. Other types may return later; re-read this file.

Base URL: ${f.base}

## Flow (4 calls)
1. Discover
   - GET  ${f.base}/v1/lookup?phone=%2B919876543210        → operator + top-up offers for that number
   - GET  ${f.base}/v1/countries?type=esim                   → every destination this product reaches
     (enumerable:false means the supplier will not list them, NOT that there are none)
   - GET  ${f.base}/v1/catalog?type=topup&country=NG        → offers (types live today: ${(f.products ?? ["topup","esim","bill","payout"]).join("|")})
     Paged: &limit=100&offset=0 (limit=0 for everything). The response carries total and,
     while there is more, next_offset. The eSIM catalogue is thousands of offers — ask for a
     country, or a page.
   - GET  ${f.base}/v1/fx?to=INR&amount=5000&type=payout    → indicative USDC↔local rate + estimate (quote is binding)
2. Quote (free, locks the price for 10 minutes)
   - POST ${f.base}/v1/quote
     { "type": "topup", "offerId": "<offerId>", "recipient": { "phone": "+919876543210" }, "amount": 299 }
     { "type": "esim",  "offerId": "<offerId>" }
     { "type": "payout", "offerId": "<offerId>", "amount": 50000, "recipient": { "fields": { "account_number": "…", "bank_code": "…", "full_name": "…" } },
       "sender": { "name": "<principal's legal name>", "country": "GB", "reference": "<partner KYC id, required above $${100}/day>" }, "payer": "<your Algorand address>" }
     → { "quoteId": "q_…", "price_usdc": "3.900000", "delivers": "INR 299 · Jio …", "pay": { "endpoint": "…/v1/orders", "body": { "quoteId": "q_…" } } }
3. Pay (x402)
   - POST ${f.base}/v1/orders  with JSON body { "quoteId": "q_…" }
     First call returns 402 + PAYMENT-REQUIRED (exact USDC amount = the quote). Sign the Algorand USDC payment,
     retry with the PAYMENT-SIGNATURE header. Response 202 → { "orderId": "ord_…", "status": "paid", "status_url": "…" }
4. Poll
   - GET  ${f.base}/v1/orders/<orderId>  every 3 s until "terminal": true
     status: delivered (confirmation + signed receipt) | refunded (refund_txid + signed receipt) | refund_failed (contact support)

## Guarantees
- Money moves first, goods second: an order exists only after the facilitator settles your USDC payment on-chain.
- If the operator/supplier fails, the full amount is refunded to the paying address on-chain automatically.
- Every terminal order carries an ed25519-signed receipt over {order, amounts, payer, settlement txid, refund txid}.
  Public key: ${f.pubkey || "(unset)"} — GET ${f.base}/v1/pubkey.
- Check one yourself, free, without trusting us or installing anything:
   - POST ${f.base}/v1/verify   with the receipt (or the whole order response) as the body
     → signature, whether the signer is this server, and both txids confirmed against an Algorand indexer.
     Add ?online=0 to skip the chain lookup. It verifies receipts from ANY server that uses the format.
- Public ledger: GET ${f.base}/v1/ledger (orders, delivered/refunded %, volume, by country).

## No wallet? Hand the human a pay link
- POST ${f.base}/v1/links  { "type": "esim", "offerId": "<offerId>", "note": "Data for your Tokyo trip" }
                          { "type": "topup", "offerId": "<offerId>", "recipient": { "phone": "+234…" }, "amount": 1000 }
  → { "url": "${f.base}/l/pl_…", "indicative_price_usdc": "…", "share": { "x": "…" } }
  The human opens the url, sees the exact price, and approves it in their own Pera wallet — the key never
  leaves their wallet and you never hold one. An eSIM's activation QR appears on the page; a top-up link
  can be paid by anyone (a "top up my phone" request) and credits only the number on the link.
  Top-up links are single-use by default; eSIM links are reusable until expiry (max_uses, ttl_hours).
- GET  ${f.base}/v1/links/<linkId>          → state: open | paid | expired
- POST ${f.base}/v1/links/<linkId>/quote    → a fresh quote for that link, payable over x402 like any other

## Earn: referral share, paid on-chain
- Add "ref": "<your Algorand address>" to POST /v1/quote or POST /v1/links.
- On every DELIVERED order you referred, you earn a share of our net margin (never of the price), sent to that
  address in USDC on-chain, batched. Refunded orders and self-referrals earn nothing. The address must be
  opted in to USDC. Terms and leaderboard: GET ${f.base}/v1/referrals · your numbers: GET ${f.base}/v1/referrals/<address>
- Humans: ${f.base}/earn

## Proof of delivery, shareable
- Every goods order has a public page at ${f.base}/p/<settlement_txid> (also \`proof_url\` on /v1/ledger rows):
  what was bought, the price, the delivery time, the on-chain settlement and a server-checked receipt signature.
  It never shows the order id — that id is the capability that reads the deliverable. Keep it private.

## Limits
- Goods: max per order $50. International payments: max per payment $200, verified sender (partner KYC reference)
  required once a payer's payouts exceed $100 in a UTC day. Max per payer per UTC day $200 overall. Sanctioned destinations refused.
- International payments are executed by a licensed payout partner; we never hold or move fiat ourselves.
- Quotes expire after 10 minutes and can be paid exactly once.

## Errors
- 400 invalid input · 403 quote unusable / limit reached / destination not supported · 404 unknown · 429 slow down · 502/503 supplier problem (no charge)
`;
}

export function fundHtml(f: PageFacts): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fund your agent with USDC on Algorand — ${f.brand}</title>
<link rel="canonical" href="${f.base}/fund">
<style>body{margin:0;font:16px/1.55 system-ui,sans-serif;background:#0b0f14;color:#e8edf2}main{max-width:820px;margin:0 auto;padding:40px 20px}a{color:#39d98a}
.card{background:#121923;border:1px solid #1f2a37;border-radius:12px;padding:16px;margin:12px 0}code{font-family:ui-monospace,monospace}</style></head><body><main>
<h1>Fund your agent with USDC on Algorand</h1>
<p>Every purchase here is paid in <b>USDC on Algorand (USDCa, ASA 31566704)</b> by the agent's own wallet. Give the wallet a few dollars of USDCa and ~0.2 ALGO (it must opt in to USDC once). Three ways:</p>
<div class="card"><b>1. From an exchange</b> — Kraken supports USDC deposits/withdrawals on Algorand; withdraw USDC choosing the <i>Algorand</i> network to the agent's address.</div>
<div class="card"><b>2. Bridge from another chain</b> — USDC can be bridged to Algorand from Ethereum, Base, Solana, Sui and Stellar (Circle-native USDC on both ends). Your agent can hold USDC on Base today and arrive on Algorand in minutes.</div>
<div class="card"><b>3. Card / bank via a wallet on-ramp</b> — Pera Wallet and Defly include fiat on-ramps; buy ALGO or USDC there and send to the agent's address.</div>
<p>Then: <code>pnpm optin</code> (one-time USDC opt-in) and set the agent's budget (<code>AGENT_BUDGET_USD</code>). The agent can never spend more than its budget or the per-order caps.</p>
<p><a href="${f.base}/agent.md">Agent instructions</a> · <a href="${f.base}/">Home</a> · network: ${f.network}</p>
</main></body></html>`;
}

/** Human labels for the product tabs on the landing page. */
const PRODUCT_LABEL: Record<ProductType, string> = {
  topup: "Mobile top-up",
  esim: "Travel eSIM",
  bill: "Prepaid bill",
  payout: "International payment",
};

/** The pages that share the brand chrome link to each other with these. */
export const BRAND_ASSETS = {
  logo: "/brand/logo.webp",
  og: "/brand/logo-og.png",
  favicon: "/favicon.ico",
  touch: "/apple-touch-icon.png",
} as const;

/** The IoMarkets® ecosystem, in the order and wording the sibling sites use for their
 *  "IoMarkets Ecosystem" dropdown (iomarkets.news header). This site is the `current` row. */
const ECOSYSTEM: ReadonlyArray<{ name: string; description: string; href: string; icon: string; current?: boolean }> = [
  { name: "IoMarkets.org", description: "Organization", href: "https://iomarkets.org", icon: "🏛️" },
  { name: "IoMarkets.io", description: "AI-Native Web3 Capital Markets", href: "https://iomarkets.io", icon: "📈" },
  { name: "IoMarkets.money", description: "Digital Money, Stablecoins & Payments", href: "https://iomarkets.money", icon: "💰" },
  { name: "IoMarkets.app", description: "Real-World Checkout for AI Agents", href: "/", icon: "🛒", current: true },
  { name: "IoMarkets.xyz", description: "Digital Collectibles & NFT Platform", href: "https://iomarkets.xyz", icon: "🎨" },
  { name: "IoMarkets.pro", description: "Universal Exchange - Pro Trading Suite", href: "https://iomarkets.pro", icon: "💹" },
  { name: "IoMarkets.ai", description: "AI-Powered Markets Intelligence", href: "https://iomarkets.ai", icon: "🤖" },
  { name: "IoMarkets.co", description: "Corporate Finance & Investor Relations", href: "https://iomarkets.co", icon: "🏢" },
  { name: "IoMarkets.vc", description: "Venture Capital Investment Fund", href: "https://iomarkets.vc", icon: "🚀" },
  { name: "IoMarkets.fund", description: "Asset Management", href: "https://iomarkets.fund", icon: "📊" },
  { name: "IoMarkets.tv", description: "Global Financial News Television", href: "https://iomarkets.tv", icon: "📺" },
  { name: "IoMarkets.news", description: "Global Online Financial News", href: "https://iomarkets.news", icon: "📰" },
  { name: "IoMarkets.tech", description: "Financial Technology Solutions", href: "https://iomarkets.tech", icon: "⚙️" },
  { name: "DipBuyer AI", description: "AI Agent for Value Investing", href: "https://dipbuyer.ai", icon: "🎯" },
  { name: "Merchants of London", description: "Merchant Bank & MFO", href: "https://merchants.london", icon: "🏦" },
];

/** The footer every IoMarkets® site carries: the four entities, the socials, the credit. */
const ENTITIES: ReadonlyArray<readonly [string, string[]]> = [
  ["LLC", ["30 N Gould St Ste R,", "Sheridan, Sheridan County,", "WY 82801,", "USA"]],
  ["UG", ["Weningstrasse 8,", "94405 Landau,", "Germany"]],
  ["Ltd", ["20-22 Wenlock Road", "London, N1 7GU", "United Kingdom"]],
  ["WLL", ["Office No. 1002, Building 1260, Road 2421, Block 324, Juffair", "Manama / Al Fateh", "Kingdom of Bahrain"]],
];
const SOCIAL: ReadonlyArray<readonly [string, string]> = [
  ["Twitter (X)", "https://x.com/IoMarkets"],
  ["LinkedIn", "https://www.linkedin.com/company/109605371/"],
  ["Facebook", "https://www.facebook.com/IoMarkets/"],
  ["YouTube", "https://youtu.be/Jj8Hx4rACOU"],
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function landingHtml(f: PageFacts): string {
  const md = agentMd(f).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const products = f.products ?? (["topup", "esim", "bill", "payout"] as const);
  const live = productList(f);
  const boot = JSON.stringify({
    network: f.network, payTo: f.payTo ?? "", pubkey: f.pubkey, base: f.base,
    products: products.map((t) => ({ type: t, label: PRODUCT_LABEL[t] })),
  }).replace(/</g, "\\u003c");
  const description = `${f.brand}: real-world checkout for AI agents. ${live[0].toUpperCase()}${live.slice(1)} in 150+ countries, paid per order in USDC on Algorand via x402. Settle first, deliver second, refund on-chain, signed receipts, public ledger. Part of the IoMarkets® ecosystem.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(f.brand)} — real-world checkout for AI agents on Algorand</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(f.brand)} — real-world checkout for AI agents">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${f.base}${BRAND_ASSETS.og}">
<meta property="og:url" content="${f.base}/">
<link rel="canonical" href="${f.base}/">
<meta name="theme-color" content="#0F2557">
<link rel="icon" href="${BRAND_ASSETS.favicon}" type="image/png">
<link rel="apple-touch-icon" href="${BRAND_ASSETS.touch}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;450;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --paper:#F3F5FA;--card:#FFFFFF;--sunk:#E9EDF6;--ink:#0D1B3D;--ink-soft:#3F4F78;--ink-faint:#7A87A8;
  --rule:#D8DEEC;--rule-soft:#E8ECF5;--navy:#0F2557;--navy-2:#16306E;
  --cobalt:#005CBC;--cobalt-ink:#004FAC;--cobalt-soft:#E3EEFB;--circuit:#4FB3D9;
  --gold:#B8902A;--gold-soft:#F8F0DA;--ok:#1F6B4A;--ok-soft:#E3F1E8;--warn:#8A6A1F;--warn-soft:#F4EEDD;--bad:#A3352B;--bad-soft:#F8EAE8;
  --display:"Space Grotesk",system-ui,sans-serif;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  --r:10px;--shadow:0 1px 2px rgba(13,27,61,.06),0 10px 30px -18px rgba(13,27,61,.35);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0A1430;--card:#111D3F;--sunk:#0D1836;--ink:#E8EDF8;--ink-soft:#B3BDD6;--ink-faint:#7F8BAB;
  --rule:#243259;--rule-soft:#1B2749;--navy:#081029;--navy-2:#0F1E4A;
  --cobalt:#7EBBFF;--cobalt-ink:#9CCBFF;--cobalt-soft:#14264F;--circuit:#5FC3E8;
  --gold:#D9B85E;--gold-soft:#3A2F14;--ok:#6FC397;--ok-soft:#15281F;--warn:#D7B45F;--warn-soft:#2A2314;--bad:#E38D82;--bad-soft:#2E1A17;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8);color-scheme:dark;
}}
:root[data-theme="dark"]{
  --paper:#0A1430;--card:#111D3F;--sunk:#0D1836;--ink:#E8EDF8;--ink-soft:#B3BDD6;--ink-faint:#7F8BAB;
  --rule:#243259;--rule-soft:#1B2749;--navy:#081029;--navy-2:#0F1E4A;
  --cobalt:#7EBBFF;--cobalt-ink:#9CCBFF;--cobalt-soft:#14264F;--circuit:#5FC3E8;
  --gold:#D9B85E;--gold-soft:#3A2F14;--ok:#6FC397;--ok-soft:#15281F;--warn:#D7B45F;--warn-soft:#2A2314;--bad:#E38D82;--bad-soft:#2E1A17;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8);color-scheme:dark;
}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:76px}
body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--display);margin:0;text-wrap:balance;letter-spacing:-.02em;line-height:1.12}
h1{font-size:clamp(2.1rem,5vw,3.4rem);font-weight:700}h2{font-size:clamp(1.5rem,3vw,2.05rem);font-weight:600}h3{font-size:1.08rem;font-weight:600;letter-spacing:-.01em}
p{margin:.5em 0}a{color:var(--cobalt-ink);text-decoration:none}a:hover{text-decoration:underline}
button,input,select{font:inherit;color:inherit}:focus-visible{outline:2px solid var(--cobalt);outline-offset:2px;border-radius:4px}
code,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}code{font-size:.9em;background:var(--sunk);padding:.08em .38em;border-radius:4px;word-break:break-all}
.wrap{max-width:1120px;margin:0 auto;padding:0 1.25rem}
section{padding:4.5rem 0}section+section{border-top:1px solid var(--rule-soft)}
.eyebrow{font-family:var(--mono);font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:500;margin-bottom:.9rem}
.lead{font-size:1.14rem;color:var(--ink-soft);max-width:60ch}
.muted{color:var(--ink-faint)}.small{font-size:.86rem}
.btn{display:inline-flex;align-items:center;gap:.5rem;padding:.7rem 1.15rem;border-radius:var(--r);border:1px solid var(--rule);background:var(--card);color:var(--ink);font-weight:500;cursor:pointer;text-decoration:none;transition:transform .12s,box-shadow .12s;white-space:nowrap}
.btn:hover{text-decoration:none;transform:translateY(-1px);box-shadow:var(--shadow)}
.btn.primary{background:var(--cobalt);border-color:var(--cobalt);color:#fff}:root[data-theme="dark"] .btn.primary,:root:not([data-theme="light"]) .btn.primary{color:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .btn.primary{background:#0071D1;border-color:#0071D1}}
:root[data-theme="dark"] .btn.primary{background:#0071D1;border-color:#0071D1}
.btn.gold{background:#CA9D33;border-color:#CA9D33;color:#1B1500}
.btn.sm{padding:.42rem .8rem;font-size:.86rem}
.chip{font-family:var(--mono);font-size:.66rem;text-transform:uppercase;letter-spacing:.1em;padding:.22rem .5rem;border-radius:4px;border:1px solid var(--rule);color:var(--ink-faint);white-space:nowrap}
.chip.live{color:var(--ok);border-color:currentColor;background:var(--ok-soft)}
.chip.live::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:.4rem;vertical-align:1px}
.card{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:1.35rem;box-shadow:var(--shadow)}
.grid{display:grid;gap:1rem}.g3{grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.g4{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}

/* ── header ── */
.bar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--paper) 86%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--rule)}
.bar-in{max-width:1120px;margin:0 auto;padding:.6rem 1.25rem;display:flex;align-items:center;gap:.75rem}
@media(max-width:640px){.bar-in .chip.live{display:none}.bar-in .btn.sm{padding:.42rem .6rem}.bar-in .brand small{display:none}}
.brand{display:flex;align-items:center;gap:.7rem;color:var(--ink);text-decoration:none}.brand:hover{text-decoration:none}
.brand img{width:40px;height:44px;object-fit:cover;border-radius:7px;box-shadow:0 0 0 1px var(--rule)}
.brand b{font-family:var(--display);font-weight:700;font-size:1.15rem;letter-spacing:-.02em;display:block;line-height:1.05}.brand sup{font-size:.5em;font-weight:600}
.brand small{display:block;white-space:nowrap;font-size:.6rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#06B6D4}
nav.top{display:none;gap:1rem;margin-left:.9rem;font-size:.88rem;white-space:nowrap}nav.top a{color:var(--ink-soft)}nav.top a:hover{color:var(--ink)}
@media(min-width:1080px){nav.top{display:flex}}
.spacer{flex:1}
.tbtn{width:36px;height:36px;border-radius:8px;border:1px solid var(--rule);background:transparent;cursor:pointer;display:grid;place-items:center;color:var(--ink-soft)}
.tbtn svg{width:16px;height:16px}

/* ── hero ── */
.hero{position:relative;padding:4.5rem 0 4rem;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:
  radial-gradient(60% 50% at 85% 10%,color-mix(in srgb,var(--cobalt) 16%,transparent),transparent 70%),
  radial-gradient(40% 40% at 10% 90%,color-mix(in srgb,var(--circuit) 14%,transparent),transparent 70%),
  linear-gradient(var(--rule-soft) 1px,transparent 1px),linear-gradient(90deg,var(--rule-soft) 1px,transparent 1px);
  background-size:auto,auto,44px 44px,44px 44px;mask-image:linear-gradient(#000 60%,transparent);pointer-events:none}
.hero .wrap{position:relative;display:grid;gap:3rem;align-items:center}
@media(min-width:900px){.hero .wrap{grid-template-columns:1.15fr .85fr}}
.hero .cta{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:1.6rem}
.hero .facts{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;margin-top:1.8rem;color:var(--ink-faint);font-size:.86rem}
.hero .facts b{color:var(--ink);font-weight:600}
.logo-hero{width:min(340px,70vw);margin:0 auto;display:block;border-radius:18px;box-shadow:0 30px 60px -30px rgba(15,37,87,.6),0 0 0 1px var(--rule)}
.hero-side{display:grid;gap:1rem;justify-items:center}
.ticket{width:100%;max-width:400px;background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:1rem 1.1rem;box-shadow:var(--shadow);font-size:.86rem}
.ticket .row{display:flex;justify-content:space-between;gap:1rem;padding:.3rem 0;border-bottom:1px dashed var(--rule-soft)}.ticket .row:last-child{border:0}
.ticket .k{color:var(--ink-faint)}.ticket .v{font-family:var(--mono);text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-family:var(--mono);font-size:.68rem;text-transform:uppercase;letter-spacing:.08em}
.status.delivered{background:var(--ok-soft);color:var(--ok)}.status.refunded{background:var(--warn-soft);color:var(--warn)}.status.other{background:var(--sunk);color:var(--ink-soft)}

/* ── what / who ── */
.card .ic{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--cobalt-soft);color:var(--cobalt-ink);margin-bottom:.9rem;font-family:var(--mono);font-weight:500}
.card.gold .ic{background:var(--gold-soft);color:var(--gold)}
.card p{color:var(--ink-soft);font-size:.95rem}
.card .more{margin-top:.8rem;font-size:.9rem}

/* ── try it ── */
.try{background:var(--card);border:1px solid var(--rule);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.try-head{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;padding:.9rem 1.1rem;border-bottom:1px solid var(--rule);background:var(--sunk)}
.tabs{display:flex;gap:.3rem;flex-wrap:wrap}.tab{padding:.42rem .85rem;border-radius:8px;border:1px solid transparent;background:transparent;cursor:pointer;color:var(--ink-soft);font-weight:500;font-size:.9rem}
.tab[aria-selected="true"]{background:var(--card);border-color:var(--rule);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.05)}
.try-body{display:grid}@media(min-width:900px){.try-body{grid-template-columns:1fr 1fr}.try-body>div+div{border-left:1px solid var(--rule)}}
.try-body>div{padding:1.1rem}
.field{display:grid;gap:.35rem;margin-bottom:.9rem}.field label{font-size:.78rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint)}
.field select,.field input{padding:.6rem .7rem;border-radius:8px;border:1px solid var(--rule);background:var(--paper);min-width:0}
.offers{display:grid;gap:.5rem;max-height:420px;overflow:auto;padding-right:.2rem}
.offer{display:grid;grid-template-columns:1fr auto;gap:.2rem .9rem;align-items:center;padding:.65rem .8rem;border:1px solid var(--rule);border-radius:10px;background:var(--paper);cursor:pointer;text-align:left}
.offer:hover{border-color:var(--cobalt)}.offer[aria-pressed="true"]{border-color:var(--cobalt);background:var(--cobalt-soft)}
.offer .n{font-weight:500;font-size:.92rem}.offer .d{grid-column:1;color:var(--ink-faint);font-size:.8rem}.offer .p{grid-row:1/3;font-family:var(--mono);font-weight:500;font-size:1rem;white-space:nowrap}
.offer .p small{display:block;font-size:.66rem;color:var(--ink-faint);font-weight:400;text-align:right;letter-spacing:.06em;text-transform:uppercase}
.steps{display:grid;gap:.6rem}
.step{display:grid;grid-template-columns:28px 1fr;gap:.7rem;padding:.7rem .8rem;border-radius:10px;border:1px solid var(--rule-soft);background:var(--paper);opacity:.45;transition:opacity .3s,border-color .3s}
.step.on{opacity:1;border-color:var(--rule)}.step.done .n{background:var(--ok);color:#fff}.step.on:not(.done) .n{background:var(--cobalt);color:#fff}
.step .n{width:26px;height:26px;border-radius:50%;background:var(--sunk);color:var(--ink-faint);display:grid;place-items:center;font-family:var(--mono);font-size:.76rem;font-weight:500}
.step b{display:block;font-size:.9rem}.step pre{margin:.35rem 0 0;font:.74rem/1.45 var(--mono);white-space:pre-wrap;word-break:break-all;color:var(--ink-soft);max-height:0;overflow:hidden;transition:max-height .35s}
.step.on pre{max-height:200px}
.note{font-size:.8rem;color:var(--ink-faint);padding:.6rem .8rem;border-left:3px solid var(--gold);background:var(--gold-soft);border-radius:0 8px 8px 0;margin-top:.9rem}
.err{color:var(--bad);background:var(--bad-soft);padding:.6rem .8rem;border-radius:8px;font-size:.88rem}

/* ── how ── */
.flow{counter-reset:s;display:grid;gap:1rem}.flow .card{position:relative;padding-top:1.2rem}
.flow .card::before{counter-increment:s;content:"0" counter(s);font-family:var(--mono);color:var(--gold);font-size:.78rem;letter-spacing:.1em;display:block;margin-bottom:.5rem}
.guar{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.6rem}.guar span{font-size:.86rem;padding:.35rem .7rem;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-weight:500}

/* ── code / agents ── */
pre.code{background:var(--navy);color:#DCE6FF;border-radius:12px;padding:1rem 1.1rem;overflow:auto;font:.8rem/1.55 var(--mono);margin:0;border:1px solid var(--navy-2)}
pre.code .c{color:#7FA6FF}pre.code .g{color:#6FC397}pre.code .y{color:#E8CB7A}
details{margin-top:1rem}summary{cursor:pointer;color:var(--cobalt-ink);font-weight:500}
details pre{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:1rem;overflow:auto;white-space:pre-wrap;font:.8rem/1.5 var(--mono);color:var(--ink-soft)}

/* ── ledger / trust ── */
.stat b{display:block;font-family:var(--display);font-size:2rem;font-weight:700;letter-spacing:-.03em;color:var(--cobalt-ink);font-variant-numeric:tabular-nums}
.stat span{color:var(--ink-faint);font-size:.86rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{padding:.65rem .6rem;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
th{font-size:.74rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint);font-weight:600}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:.4rem 1rem;box-shadow:var(--shadow)}
#stranded{border-left:3px solid var(--bad);padding:.6rem .8rem;background:var(--bad-soft);color:var(--bad);border-radius:0 8px 8px 0;margin-top:1rem}

/* ── about ── */
.about{background:var(--navy);color:#E8EDF8;border-top:0}.about h2,.about h3{color:#fff}.about .lead{color:#B9C6E6}.about a{color:#A9C4FF}
.about .eyebrow{color:#D9B85E}
.mvv{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:1.6rem}
.mvv div{padding:1rem;border-left:2px solid #D9B85E;font-size:.92rem;color:#C7D2EC}.mvv b{display:block;color:#fff;font-family:var(--display);margin-bottom:.3rem}
/* ── ecosystem dropdown (the pill every IoMarkets site carries, top right) ── */
.eco{position:relative}
.eco>button{display:inline-flex;align-items:center;gap:.5rem;border-radius:999px;background:#1E293B;border:1px solid #334155;color:#fff;font-weight:500;font-size:.875rem;padding:.625rem 1.5rem;cursor:pointer;white-space:nowrap;font-family:var(--sans)}
.eco>button:hover{background:#334155}.eco>button svg{width:16px;height:16px;transition:transform .2s}.eco[aria-expanded="true"]>button svg{transform:rotate(180deg)}
.eco-menu{position:absolute;right:0;top:calc(100% + .5rem);width:20rem;max-height:70vh;overflow-y:auto;border-radius:1rem;background:#1E293B;border:1px solid #334155;box-shadow:0 20px 25px -5px rgba(0,0,0,.3),0 8px 10px -6px rgba(0,0,0,.3);padding:.5rem;z-index:60}
.eco-menu a{display:flex;align-items:center;gap:.75rem;padding:.625rem .875rem;border-radius:.5rem;color:#E5E7EB;text-decoration:none}
.eco-menu a:hover{background:#334155;text-decoration:none}.eco-menu a.cur{background:#334155;border-right:2px solid #F59E0B}
.eco-menu .i{font-size:1.125rem;flex-shrink:0}.eco-menu a>span:last-child{min-width:0;flex:1}.eco-menu b{display:block;font-weight:500;font-size:.875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eco-menu a.cur b{color:#fff}
.eco-menu small{display:block;font-size:.75rem;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eco-menu a.cur small{color:#F59E0B}
@media(max-width:640px){.eco>button{padding:.375rem .75rem;font-size:.75rem;gap:.375rem}.eco>button svg{width:12px;height:12px}.eco>button .full{display:none}.eco-menu{width:18rem;max-height:60vh}}
@media(min-width:641px){.eco>button .short{display:none}}
@media(max-width:1400px){.bar-in .chip.live{display:none}}
@media(max-width:640px){.bar-in .brand>span,.bar-in .tbtn{display:none}}

/* ── footer: the one every IoMarkets site carries ── */
footer{background:linear-gradient(135deg,#F8FAFC,#EFF6FF);border-top:1px solid #E2E8F0;box-shadow:0 -10px 15px -3px rgba(0,0,0,.05);color:#4B5563;font-size:.875rem}
footer .wrap{max-width:80rem;padding:4rem 1.25rem}
footer .cols{display:grid;grid-template-columns:1fr;gap:2rem;margin-bottom:3rem}
@media(min-width:768px){footer .cols{grid-template-columns:repeat(2,1fr)}}@media(min-width:1024px){footer .cols{grid-template-columns:repeat(6,1fr)}}
footer .fbrand{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem;text-decoration:none}footer .fbrand:hover{text-decoration:none}
footer .fbrand img{width:44px;height:44px;object-fit:cover;border-radius:.75rem;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);transition:transform .3s}footer .fbrand:hover img{transform:scale(1.1)}
footer .fbrand .n{font-size:1.25rem;font-weight:700;letter-spacing:-.02em;line-height:1;background:linear-gradient(90deg,#0891B2,#2563EB);-webkit-background-clip:text;background-clip:text;color:transparent}
footer .fbrand .r{color:#C9A962;font-size:.75rem;font-weight:700}
footer .fbrand .sub{display:block;font-size:9px;color:#0891B2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-top:.15rem}
footer h4{margin:0 0 1rem;font-size:.875rem;font-weight:600;color:#0891B2;letter-spacing:.025em;font-family:var(--sans)}footer h4 sup{font-size:.75rem}
footer h4.b{color:#2563EB}
footer p{margin:0 0 .75rem;font-weight:300;line-height:1.6;color:#4B5563}
footer a{color:#0891B2}footer a:hover{color:#06B6D4}
footer ul{list-style:none;margin:0;padding:0}footer li{margin-bottom:.75rem}footer li a{color:#4B5563;font-weight:300}footer li a:hover{color:#0891B2}
footer .bottom{padding-top:2rem;border-top:1px solid #E2E8F0;text-align:center}
footer .bottom .by{font-size:1rem;font-weight:600;color:#374151;margin-bottom:.5rem}footer .bottom .by a{color:#0891B2}footer .bottom .by a:hover{text-decoration:underline}
footer .bottom .cp{font-size:.875rem;color:#4B5563;font-weight:300}footer .bottom .cp sup{font-size:.75rem}
footer .bottom .fine{font-size:.75rem;color:#6B7280;font-weight:300;margin-top:.75rem}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) footer{background:linear-gradient(135deg,#0A1430,#0D1A3C);border-top-color:#243259;color:#B3BDD6}
 :root:not([data-theme="light"]) footer p,:root:not([data-theme="light"]) footer li a,:root:not([data-theme="light"]) footer .bottom .cp{color:#B3BDD6}:root:not([data-theme="light"]) footer .bottom{border-top-color:#243259}:root:not([data-theme="light"]) footer .bottom .by{color:#E8EDF8}:root:not([data-theme="light"]) footer .bottom .fine{color:#7F8BAB}}
:root[data-theme="dark"] footer{background:linear-gradient(135deg,#0A1430,#0D1A3C);border-top-color:#243259;color:#B3BDD6}
:root[data-theme="dark"] footer p,:root[data-theme="dark"] footer li a,:root[data-theme="dark"] footer .bottom .cp{color:#B3BDD6}:root[data-theme="dark"] footer .bottom{border-top-color:#243259}:root[data-theme="dark"] footer .bottom .by{color:#E8EDF8}:root[data-theme="dark"] footer .bottom .fine{color:#7F8BAB}
</style></head><body>
<div class="bar"><div class="bar-in">
  <a class="brand" href="/" aria-label="${esc(f.brand)} home"><img src="${BRAND_ASSETS.logo}" alt="IoMarkets logo" width="40" height="44"><span><b>IoMarkets<sup>®</sup></b><small>App</small></span></a>
  <nav class="top" aria-label="Sections"><a href="#what">What it is</a><a href="#try">Try it</a><a href="#how">How it works</a><a href="#agents">For agents</a><a href="#business">For businesses</a><a href="#share">Share &amp; earn</a><a href="#trust">Trust</a><a href="#about">About</a></nav>
  <span class="spacer"></span>
  <span class="chip live">Algorand ${esc(f.network)}</span>
  <a class="btn primary sm" href="/pay?demo=1">Open the demo</a>
  <button class="tbtn" id="theme" aria-label="Toggle light or dark theme" title="Light / dark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
  <div class="eco" id="eco" aria-expanded="false">
    <button type="button" id="eco-btn" aria-haspopup="menu" aria-controls="eco-menu"><span class="full">IoMarkets Ecosystem</span><span class="short">Ecosystem</span><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg></button>
    <div class="eco-menu" id="eco-menu" role="menu" hidden>
      ${ECOSYSTEM.map((e) => `<a role="menuitem" href="${e.href}"${e.current ? ' class="cur"' : ' target="_blank" rel="noopener noreferrer"'}><span class="i">${e.icon}</span><span><b>${e.name}</b><small>${esc(e.description)}</small></span></a>`).join("\n      ")}
    </div>
  </div>
</div></div>

<main>
<header class="hero"><div class="wrap">
  <div>
    <div class="eyebrow">Part of the IoMarkets® ecosystem · Payments for AI agents</div>
    <h1>Real-world checkout for AI agents.</h1>
    <p class="lead">An AI agent cannot open a bank account, hold a card or file a chargeback. ${esc(f.brand)} is a merchant built for that buyer: it sells <b>${esc(live)}</b> in 150+ countries, paid per order in USDC on Algorand through <a href="https://x402.org">x402</a>. No account, no API key, no card.</p>
    <p class="lead">Money settles on-chain first, goods ship second, anything that fails is refunded on-chain automatically, and every order carries a signed receipt anyone can verify.</p>
    <div class="cta">
      <a class="btn primary" href="#try">Try it live, free</a>
      <a class="btn gold" href="/pay?demo=1">Walk through the payout demo</a>
      <a class="btn" href="/agent.md">Agent docs (4 HTTP calls)</a>
    </div>
    <div class="facts"><span><b>~3 s</b> on-chain settlement</span><span><b>200+</b> eSIM destinations</span><span><b>150+</b> top-up countries</span><span><b>ed25519</b> signed receipts</span><span><b>$50</b> max per order</span></div>
  </div>
  <div class="hero-side">
    <img class="logo-hero" src="${BRAND_ASSETS.logo}" alt="IoMarkets — I@MRKET$ over a circuit board" width="340" height="374">
    <div class="ticket" id="ticket" hidden>
      <div class="row"><span class="k">Latest real order</span><span class="v" id="t-status"></span></div>
      <div class="row"><span class="k">What</span><span class="v" id="t-what"></span></div>
      <div class="row"><span class="k">Paid</span><span class="v" id="t-paid"></span></div>
      <div class="row"><span class="k">Delivered in</span><span class="v" id="t-time"></span></div>
      <div class="row"><span class="k">Settlement</span><span class="v"><a id="t-tx" href="#" rel="noopener"></a></span></div>
    </div>
  </div>
</div></header>

<section id="what"><div class="wrap">
  <div class="eyebrow">What · why · who</div>
  <h2>A shop where the customer is a program.</h2>
  <div class="grid g3" style="margin-top:1.6rem">
    <div class="card"><div class="ic">?</div><h3>What it is</h3><p>A merchant, not a payments API. Every order buys a real thing from a licensed supplier — an eSIM, phone credit, a prepaid bill, a bank or mobile-money payment — and delivers it to a phone number or account. The agent pays the exact quoted amount in USDC, per order, from its own wallet.</p><p class="more"><b>Live today:</b> ${esc(live)}.</p></div>
    <div class="card gold"><div class="ic">!</div><h3>Why it exists</h3><p>Human commerce runs on reversibility: chargebacks, disputes, small claims. An agent paying in stablecoins has none of that — it gets one shot and cannot read the terms. So the product is a settlement discipline that makes a stranger's promise checkable: settle first, deliver second, refund on-chain, sign every receipt, publish the ledger — including the number that makes us look worst.</p></div>
    <div class="card"><div class="ic">@</div><h3>Who it is for</h3><p><b>Agent builders</b> — OpenClaw, Hermes, Claude Code, Codex, any MCP client. Give the agent a wallet; it can buy.</p><p><b>Businesses paying people</b> — paste a spreadsheet into the payout console, approve once, get a receipt for every row.</p><p><b>Anyone with an assistant</b> — top up a relative's phone in Lagos, land in Tokyo with data already on.</p></div>
  </div>
</div></section>

<section id="try"><div class="wrap">
  <div class="eyebrow">Try it · live catalogue, simulated payment</div>
  <h2>Browse what an agent would buy, then watch the four calls.</h2>
  <p class="lead">The offers and prices below come from the real supplier catalogue on this server, right now. The purchase on the right is a simulation — nothing is signed and no USDC moves. To pay for real, use the console or the agent docs.</p>
  <div class="try" style="margin-top:1.4rem">
    <div class="try-head"><div class="tabs" id="tabs" role="tablist"></div><span class="spacer"></span><span class="chip">GET /v1/catalog</span><span class="chip">GET /v1/lookup</span></div>
    <div class="try-body">
      <div>
        <div id="pick"></div>
        <div id="offers" class="offers" aria-live="polite"><p class="muted small">Loading the catalogue…</p></div>
      </div>
      <div>
        <div class="steps" id="steps">
          <div class="step" data-s="1"><span class="n">1</span><div><b>Quote — free, locks the price for 10 minutes</b><pre></pre></div></div>
          <div class="step" data-s="2"><span class="n">2</span><div><b>Pay — POST /v1/orders answers 402 with the exact USDC amount</b><pre></pre></div></div>
          <div class="step" data-s="3"><span class="n">3</span><div><b>Settle — the facilitator confirms the payment on Algorand, ~3 s</b><pre></pre></div></div>
          <div class="step" data-s="4"><span class="n">4</span><div><b>Deliver — the order ships and the receipt is signed</b><pre></pre></div></div>
        </div>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem;align-items:center">
          <button class="btn primary" id="run" disabled>Simulate this purchase</button>
          <a class="btn" href="/pay?demo=1">Real console, demo data</a>
        </div>
        <div class="note" id="simnote">Simulation only. The four calls are the real ones — an agent runs them with a funded wallet and <a href="/agent.md">/agent.md</a>. The txid and receipt shown here are illustrative.</div>
      </div>
    </div>
  </div>
</div></section>

<section id="how"><div class="wrap">
  <div class="eyebrow">How it works</div>
  <h2>Four HTTP calls. No SDK, no signup.</h2>
  <div class="flow grid g4" style="margin-top:1.6rem">
    <div class="card"><h3>Discover</h3><p>Look up a phone number for its operator and offers, list eSIM destinations, or page the catalogue. All free.</p></div>
    <div class="card"><h3>Quote</h3><p>Lock an exact USDC price for one purchase. Free, ten minutes, pays exactly once. If the float cannot fill it, you get a 503 now — not a refund later.</p></div>
    <div class="card"><h3>Pay with x402</h3><p>The first POST answers 402 with the amount. The wallet signs an Algorand USDC transfer and retries. The order exists only after settlement.</p></div>
    <div class="card"><h3>Poll and keep the receipt</h3><p>Delivered, or refunded on-chain to the paying address. Either way, an ed25519-signed receipt naming both transactions.</p></div>
  </div>
  <div class="guar"><span>Settle first, deliver second</span><span>Automatic on-chain refunds</span><span>Exact pricing</span><span>Signed receipts</span><span>Public ledger</span><span>$50 / order · $200 / payer / day</span></div>
</div></section>

<section id="agents"><div class="wrap">
  <div class="grid g2">
    <div>
      <div class="eyebrow">For agents and their builders</div>
      <h2>Point your agent at one file.</h2>
      <p class="lead">Works with OpenClaw, Hermes, Claude Code, Codex and any MCP client. Hosted MCP at <code>/mcp</code>, a shared skill in the repo, and a plain-HTTP flow that needs nothing installed. Need USDC on Algorand? <a href="/fund">How to fund an agent</a>. <b>No wallet at all?</b> Create a <a href="#share">pay link</a> and your human pays from their own Pera wallet — and tag orders with <code>ref</code> to <a href="/earn">earn a share</a>.</p>
      <p><a class="btn primary" href="/agent.md">Read /agent.md</a> <a class="btn" href="/fund">Fund a wallet</a> <a class="btn" href="/v1/ledger">Public ledger JSON</a></p>
      <details><summary>Show the full agent instructions inline</summary><pre>${md}</pre></details>
    </div>
    <div>
<pre class="code"><span class="c"># 1. discover</span>
GET  ${esc(f.base)}/v1/lookup?phone=%2B447700900123
GET  ${esc(f.base)}/v1/catalog?type=esim&amp;country=JP

<span class="c"># 2. quote (free, 10-minute lock)</span>
POST ${esc(f.base)}/v1/quote
{ "type": "esim", "offerId": "ea-…" }
<span class="g">→ { "quoteId": "q_…", "price_usdc": "2.330000" }</span>

<span class="c"># 3. pay (x402)</span>
POST ${esc(f.base)}/v1/orders  { "quoteId": "q_…" }
<span class="y">← 402  PAYMENT-REQUIRED: exact USDC amount</span>
POST …/v1/orders  + PAYMENT-SIGNATURE
<span class="g">→ 202 { "orderId": "ord_…", "status": "paid" }</span>

<span class="c"># 4. poll until terminal</span>
GET  ${esc(f.base)}/v1/orders/ord_…
<span class="g">→ { "status": "delivered", "receipt": { "sig": "…" } }</span></pre>
    </div>
  </div>
</div></section>

<section id="business"><div class="wrap">
  <div class="grid g2">
    <div>
      <div class="eyebrow">For businesses and ops teams</div>
      <h2>Pay a list of people from one wallet, with a receipt for each.</h2>
      <p class="lead">The batch payout console takes a pasted spreadsheet, validates every row, prices it, and settles each payment individually after a single approval from your own wallet — Pera or Defly. Failures refund themselves. Export the signed receipts as CSV for finance.</p>
      <p><a class="btn gold" href="/pay?demo=1">Walk through the demo</a> <a class="btn" href="/pay">Open the console</a> <a class="btn" href="/verify">Verify a receipt</a></p>
      <p class="small muted">International bank, mobile-money and UPI payouts are built and waiting on a licensed partner; the demo runs entirely in your browser with no wallet.</p>
    </div>
    <div class="card">
      <h3>What the console does</h3>
      <table style="margin-top:.6rem"><tr><th>Step</th><th>What happens</th></tr>
      <tr><td>1 Recipients</td><td>Pick a corridor, paste or drop rows; each is validated inline.</td></tr>
      <tr><td>2 Review</td><td>Lock prices for ten minutes; see the batch total in USDC.</td></tr>
      <tr><td>3 Pay</td><td>Approve once. Rows settle one by one with a live tally.</td></tr>
      <tr><td>4 Receipts</td><td>Signed proof per row, on-chain txids, CSV export.</td></tr></table>
    </div>
  </div>
</div></section>

<section id="share"><div class="wrap">
  <div class="eyebrow">New · pay links, proof pages, referral share</div>
  <h2>Sell it without a wallet. Share the proof. Earn when it sells.</h2>
  <p class="lead">Three things that let an agent with no wallet sell, and let every sale bring in the next one.</p>
  <div class="grid g3" style="margin-top:1.4rem">
    <div class="card"><h3>Pay links</h3><p>An agent calls <code>POST /v1/links</code> and hands its human a URL. They see the exact price and approve it in their own Pera wallet, so the agent never holds a key. A top-up link is a <b>“top up my phone”</b> request anyone can pay.</p></div>
    <div class="card"><h3>Proof pages</h3><p>Every delivered order gets a public page at <code>/p/&lt;txid&gt;</code> with the price, the delivery time, the on-chain settlement and a checked signature, ready to post on X. Anyone who opens it can buy the same eSIM in one click.</p></div>
    <div class="card"><h3>Referral share</h3><p>Put <code>ref</code> on any quote or link. On every delivered order you get a share of our margin, sent to your address in USDC on-chain. No signup, no invoice. Built for other x402 builders.</p></div>
  </div>
  <p style="margin-top:1.2rem"><a class="btn gold" href="/earn">Make a share link and earn</a> <a class="btn" href="/v1/referrals">Programme terms (JSON)</a> <a class="btn" href="/agent.md">API: /v1/links</a></p>
</div></section>

<section id="ledger"><div class="wrap">
  <div class="eyebrow">Live · straight from /v1/ledger</div>
  <h2>Every order, in public.</h2>
  <div class="grid g4" style="margin-top:1.4rem">
    <div class="card stat"><b id="s-orders">–</b><span>orders on ${esc(f.network)}</span></div>
    <div class="card stat"><b id="s-pct">–</b><span>delivered or refunded</span></div>
    <div class="card stat"><b id="s-vol">–</b><span>USDC settled</span></div>
    <div class="card stat"><b id="s-countries">–</b><span>countries served</span></div>
  </div>
  <p id="stranded" hidden></p>
  <div class="tw" style="margin-top:1rem"><table id="recent"><tr><th>When</th><th>What</th><th>USDC</th><th>Status</th><th>Settlement</th><th>Proof</th></tr></table></div>
  <p class="small muted">Recipients are hashed. Volume is small and honest: the service went live on mainnet in late August 2026.</p>
</div></section>

<section id="trust"><div class="wrap">
  <div class="eyebrow">Why you can trust it</div>
  <h2>Every claim comes with a way to check it.</h2>
  <div class="tw" style="margin-top:1.4rem"><table><tr><th>Claim</th><th>How you check it</th></tr>
  <tr><td>You were charged exactly the quoted amount</td><td>The 402 challenge carries the exact USDC amount; your wallet signs nothing else.</td></tr>
  <tr><td>No order without a settled payment</td><td>Every order names its Algorand settlement txid — open it in the explorer.</td></tr>
  <tr><td>Failed deliveries are refunded</td><td>The refund is an on-chain USDC transfer to the paying address, noted with the order id.</td></tr>
  <tr><td>Receipts are not forgeable</td><td>ed25519 signature over the canonical payload; public key <code>${esc(f.pubkey || "(unset)")}</code>. <a href="/verify"><b>Check one yourself</b></a> — it works on receipts from <a href="/receipts.md">any service using the format</a>.</td></tr>
  <tr><td>Nothing is hidden</td><td><a href="/v1/ledger">/v1/ledger</a> is public: every order, its outcome and its txids. Including <code>stranded</code> — orders we could neither deliver nor refund. We publish that number rather than making you ask.</td></tr>
  <tr><td>Every delivery can be shown to anyone</td><td>Each goods order has a public proof page at <code>/p/&lt;settlement txid&gt;</code>: what was bought, the price, the delivery time, the on-chain payment and a checked signature. It never shows the order id, which is what unlocks the goods. Linked from every row of the ledger above.</td></tr></table></div>
</div></section>

<section id="about" class="about"><div class="wrap">
  <div class="eyebrow">Where this fits</div>
  <h2>${esc(f.brand)} is the agent-commerce product of IoMarkets®.</h2>
  <p class="lead">IoMarkets® is an AI-native financial technology ecosystem: integrated services across public and private capital markets, asset management, artificial intelligence, digital assets, digital money and financial news. This site is its payments-for-agents line — the place where an AI agent turns stablecoins into things in the physical world. Read more at <a href="https://iomarkets.org/about">iomarkets.org/about</a>.</p>
  <div class="mvv">
    <div><b>Mission</b>Increase liquidity, visibility, transparency and diversification in public and private markets; democratise access; reduce information asymmetry with AI and decentralised ledgers.</div>
    <div><b>Vision</b>A unified global marketplace for all asset classes, bridging traditional finance with artificial intelligence and decentralised ledger technology.</div>
    <div><b>Values</b>Integrity · Intelligence · Innovation · Energy.</div>
  </div>
</div></section>
</main>

<footer><div class="wrap">
  <div class="cols">
    <div>
      <a class="fbrand" href="/"><img src="${BRAND_ASSETS.logo}" alt="IoMarkets" width="44" height="44"><span><span><span class="n">IoMarkets</span><span class="r">®</span></span><span class="sub">App</span></span></a>
      <p>Real-World Checkout for AI Agents</p>
      <p>Email: <a href="mailto:info@iomarkets.org">info@iomarkets.org</a></p>
    </div>
    ${ENTITIES.map(([ent, lines], i) => `<div><h4${i >= 2 ? ' class="b"' : ""}>IoMarkets<sup>®</sup> ${ent}</h4><p>${lines.join("<br>")}</p></div>`).join("\n    ")}
    <div><h4>Follow Us</h4><ul>${SOCIAL.map(([n, u]) => `<li><a href="${u}" target="_blank" rel="noopener noreferrer">${n}</a></li>`).join("")}</ul></div>
  </div>
  <div class="bottom">
    <p class="by">Built with ❤️ by <a href="https://www.linkedin.com/in/sergovashakmadze/" target="_blank" rel="noopener noreferrer">Sergo Vashakmadze</a></p>
    <p class="cp">© 2026 IoMarkets<sup>®</sup> All rights reserved</p>
    <p class="fine">Built for the <a href="https://algorand.co/global-x402-challenge">Global x402 Challenge</a>. Settlement via the GoPlausible x402 facilitator on Algorand ${esc(f.network)}${f.payTo ? ` · payTo <code>${esc(f.payTo)}</code>` : ""}. International payments are executed by licensed partners; IoMarkets never holds or moves fiat. <a href="/agent.md">agent.md</a> · <a href="/receipts.md">Receipt spec</a> · <a href="/verify">Verify</a> · <a href="/v1/ledger">Ledger</a> · <a href="/fund">Fund</a></p>
  </div>
</div></footer>

<script>window.__IOM__=${boot};</script>
<script>
(function(){
var B=window.__IOM__,$=function(id){return document.getElementById(id)};
/* theme: same key as the console so the two agree */
var th=$('theme');try{var st=localStorage.getItem('iomarkets.theme');if(st)document.documentElement.setAttribute('data-theme',st);}catch(e){}
var eco=$('eco'),ecoBtn=$('eco-btn'),ecoMenu=$('eco-menu');
function ecoSet(open){eco.setAttribute('aria-expanded',open?'true':'false');ecoMenu.hidden=!open;}
ecoBtn.onclick=function(e){e.stopPropagation();ecoSet(ecoMenu.hidden);};
document.addEventListener('click',function(e){if(!eco.contains(e.target))ecoSet(false);});
document.addEventListener('keydown',function(e){if(e.key==='Escape')ecoSet(false);});
th.onclick=function(){var d=document.documentElement;var cur=d.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var nx=cur==='dark'?'light':'dark';d.setAttribute('data-theme',nx);try{localStorage.setItem('iomarkets.theme',nx)}catch(e){}};

/* ledger: stats, hero ticket, recent table */
var cell=function(v){var td=document.createElement('td');td.textContent=v;return td;};
var httpOnly=function(u){try{return /^https?:$/.test(new URL(u,location.origin).protocol)?u:'#'}catch(e){return '#'}};
var name=function(cc){try{return new Intl.DisplayNames(['en'],{type:'region'}).of(cc)||cc}catch(e){return cc}};
fetch('/v1/ledger').then(function(r){return r.json()}).then(function(l){
 $('s-orders').textContent=l.orders;
 $('s-pct').textContent=l.delivered_or_refunded_pct===null?'\\u2014':l.delivered_or_refunded_pct+'%';
 $('s-vol').textContent='$'+Number(l.volume_usdc).toFixed(2);
 $('s-countries').textContent=l.countries.length;
 if(l.stranded>0){var c=$('stranded');c.textContent=l.stranded+' order'+(l.stranded===1?'':'s')+' could not be delivered or refunded and need manual resolution. If one is yours, contact us with your order id.';c.hidden=false;}
 var t=$('recent');
 for(var i=0;i<l.recent.length;i++){var o=l.recent[i];var tr=document.createElement('tr');
  tr.appendChild(cell(new Date(o.created_at).toLocaleString()));
  tr.appendChild(cell(o.type+' · '+o.brand+' · '+name(o.country)));
  tr.appendChild(cell(o.price_usdc));
  tr.appendChild(cell(o.status));
  var td=document.createElement('td'),a=document.createElement('a');a.href=httpOnly(o.settlement_url);a.rel='noopener';a.textContent=o.settlement_txid.slice(0,10)+'…';td.appendChild(a);tr.appendChild(td);
  var pd=document.createElement('td');if(o.proof_url){var pa=document.createElement('a');pa.href=httpOnly(o.proof_url);pa.textContent='proof';pd.appendChild(pa);}tr.appendChild(pd);t.appendChild(tr);}
 var f=l.recent[0];if(f){var s=$('t-status');s.innerHTML='';var sp=document.createElement('span');sp.className='status '+(f.status==='delivered'||f.status==='refunded'?f.status:'other');sp.textContent=f.status;s.appendChild(sp);
  $('t-what').textContent=f.type+' · '+f.brand+' · '+name(f.country);$('t-paid').textContent=Number(f.price_usdc).toFixed(2)+' USDC';
  $('t-time').textContent=f.delivered_at?((new Date(f.delivered_at)-new Date(f.created_at))/1000).toFixed(1)+' s':'—';
  var tx=$('t-tx');tx.href=httpOnly(f.settlement_url);tx.textContent=f.settlement_txid.slice(0,12)+'…';$('ticket').hidden=false;}
}).catch(function(){});

/* try it: live catalogue + simulated purchase */
var cur=null,sel=null,run=$('run');
function tab(t){cur=t;var ts=$('tabs').children;for(var i=0;i<ts.length;i++)ts[i].setAttribute('aria-selected',ts[i].dataset.t===t.type?'true':'false');reset();load();}
B.products.forEach(function(p,i){var b=document.createElement('button');b.className='tab';b.role='tab';b.dataset.t=p.type;b.textContent=p.label;b.onclick=function(){tab(p)};$('tabs').appendChild(b);if(i===0)tab(p);});
if(!B.products.length)$('offers').innerHTML='<p class="muted small">No product is live right now — no supplier is wired.</p>';
function field(label,node){var d=document.createElement('div');d.className='field';var l=document.createElement('label');l.textContent=label;d.appendChild(l);d.appendChild(node);return d;}
function load(){var pick=$('pick');pick.innerHTML='';$('offers').innerHTML='<p class="muted small">Loading the catalogue…</p>';
 fetch('/v1/countries?type='+cur.type).then(function(r){return r.json()}).then(function(c){
  if(c.countries&&c.countries.length){var s=document.createElement('select');var pref=['US','JP','GB','TR','AE','IN','FR','TH'];
   var list=c.countries.map(function(x){return {code:x.code,n:name(x.code),k:x.offers}}).sort(function(a,b){return a.n.localeCompare(b.n)});
   list.forEach(function(x){var o=document.createElement('option');o.value=x.code;o.textContent=x.k==null?x.n:x.n+' ('+x.k+')';s.appendChild(o)});
   var d=pref.filter(function(p){return list.some(function(x){return x.code===p})})[0]||list[0].code;s.value=d;
   s.onchange=function(){offers('/v1/catalog?type='+cur.type+'&country='+s.value+'&limit=12')};pick.appendChild(field('Destination · '+list.length+' available',s));offers('/v1/catalog?type='+cur.type+'&country='+d+'&limit=12');
  }else if(cur.type==='topup'){var inp=document.createElement('input');inp.value='+447700900123';inp.placeholder='+91 98765 43210';inp.autocomplete='off';
   var go=function(){offers('/v1/lookup?phone='+encodeURIComponent(inp.value.trim()))};inp.onchange=go;inp.onkeydown=function(e){if(e.key==='Enter')go()};
   pick.appendChild(field('Phone number to top up (any country)',inp));go();
  }else{/* the supplier will not list destinations, but it answers for one — offer the common ones */
   var s2=document.createElement('select'),codes=['US','GB','NG','IN','JP','TR','AE','KE','PH','MX','BR','FR','DE','ES','IT','TH','VN','ID','EG','ZA','GH','PK','BD'];
   codes.map(function(c){return {code:c,n:name(c)}}).sort(function(a,b){return a.n.localeCompare(b.n)}).forEach(function(x){var o=document.createElement('option');o.value=x.code;o.textContent=x.n;s2.appendChild(o)});
   var d2=cur.type==='payout'?'NG':'US';s2.value=d2;s2.onchange=function(){offers('/v1/catalog?type='+cur.type+'&country='+s2.value+'&limit=12')};
   pick.appendChild(field('Destination',s2));offers('/v1/catalog?type='+cur.type+'&country='+d2+'&limit=12');}
 }).catch(function(){$('offers').innerHTML='<p class="err">The catalogue is not reachable right now. Try again in a minute.</p>'});}
function deliver(o){if(o.type==='esim'){var ps=[];if(o.dataGB)ps.push(o.dataGB+' GB');if(o.durationDays)ps.push(o.durationDays+(o.durationDays===1?' day':' days'));if(o.regions&&o.regions.length>1)ps.push(o.regions.length+' countries');return ps.join(' · ');}
 if(o.priceType==='range')return 'any amount '+o.sendMin+'–'+o.sendMax+' '+o.sendCurrency;if(o.sendFixed)return o.sendFixed+' '+o.sendCurrency+' credit';return o.brandName||'';}
function offers(url){$('offers').innerHTML='<p class="muted small">Loading…</p>';reset();
 fetch(url).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(j){var list=j.offers||[];var box=$('offers');box.innerHTML='';
  if(j.brandName){var h=document.createElement('p');h.className='small muted';h.style.margin='0 0 .3rem';h.textContent='Operator: '+j.brandName+' · '+name(j.country);box.appendChild(h);}
  if(!list.length){box.innerHTML='<p class="muted small">No offers here right now.</p>';return;}
  list.slice(0,12).forEach(function(o){var b=document.createElement('button');b.className='offer';b.setAttribute('aria-pressed','false');
   var n=document.createElement('span');n.className='n';n.textContent=o.name;var d=document.createElement('span');d.className='d';d.textContent=(o.brandName?o.brandName+' · ':'')+deliver(o);
   var p=document.createElement('span');p.className='p';p.textContent=(o.priceType==='range'?'from ':'')+Number(o.price_usdc_from).toFixed(2);var sm=document.createElement('small');sm.textContent='USDC';p.appendChild(sm);
   b.appendChild(n);b.appendChild(p);b.appendChild(d);b.onclick=function(){var all=box.querySelectorAll('.offer');for(var i=0;i<all.length;i++)all[i].setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');reset();sel=o;run.disabled=false;};box.appendChild(b);});
 }).catch(function(e){$('offers').innerHTML='<p class="err">'+(String(e.message)==='429'?'Slow down — the free routes are rate limited. Try again in a minute.':'Could not load offers ('+e.message+').')+'</p>'});}
function reset(){sel=null;run.disabled=true;run.textContent='Simulate this purchase';var st=$('steps').children;for(var i=0;i<st.length;i++){st[i].className='step';st[i].querySelector('pre').textContent='';}}
function rnd(n){var a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',s='';for(var i=0;i<n;i++)s+=a[Math.floor(Math.random()*32)];return s;}
function show(i,txt,done){var st=$('steps').children[i];st.className='step on'+(done?' done':'');st.querySelector('pre').textContent=txt;}
run.onclick=function(){if(!sel)return;run.disabled=true;run.textContent='Running…';var o=sel,price=Number(o.priceType==='range'?o.price_usdc_from:o.price_usdc_from).toFixed(6),q='q_'+rnd(8).toLowerCase(),ord='ord_'+rnd(8).toLowerCase(),tx=rnd(52);
 var body={type:o.type,offerId:o.offerId};if(o.type==='topup'){body.recipient={phone:'+447700900123'};if(o.priceType==='range')body.amount=o.sendMin;}
 var st=$('steps').children;for(var i=0;i<st.length;i++){st[i].className='step';}
 show(0,'POST /v1/quote '+JSON.stringify(body)+'\\n→ 200 {"quoteId":"'+q+'","price_usdc":"'+price+'","delivers":"'+(o.name||'')+'","expires_in":600}');
 setTimeout(function(){show(0,st[0].querySelector('pre').textContent,true);show(1,'POST /v1/orders {"quoteId":"'+q+'"}\\n← 402 PAYMENT-REQUIRED {"scheme":"exact","network":"algorand:'+B.network+'","asset":"USDC","amount":"'+Math.round(price*1e6)+'","payTo":"'+(B.payTo||'…')+'"}\\n… wallet signs an Algorand USDC transfer, retries with PAYMENT-SIGNATURE');},700);
 setTimeout(function(){show(1,st[1].querySelector('pre').textContent,true);show(2,'facilitator settles on-chain (simulated)\\ntxid '+tx+'\\n→ 202 {"orderId":"'+ord+'","status":"paid","status_url":"/v1/orders/'+ord+'"}');},1700);
 setTimeout(function(){show(2,st[2].querySelector('pre').textContent,true);show(3,'GET /v1/orders/'+ord+'\\n→ {"status":"delivered","terminal":true,"confirmation":"'+(o.type==='esim'?'LPA:1$…':'operator ref …')+'","receipt":{"alg":"ed25519","pubkey":"'+(B.pubkey||'…').slice(0,16)+'…","sig":"…"}}\\nPOST /v1/verify with that receipt → signature ok, txid confirmed',true);run.disabled=false;run.textContent='Run it again';},3000);
};
})();
</script></body></html>`;
}
