// The shell shared by the growth pages — /l/:id (pay link), /p/:txid (proof), /earn.
//
// Same palette, type and header as the landing page (src/landing.ts), a way back to /,
// the logo, light by default and the same `iomarkets.theme` key, so the pages a buyer
// lands on from a shared link look like the site they came from rather than a tool.

import { BRAND_ASSETS } from "./landing.js";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON for an inline <script>: `<` escaped so no value can close the tag. */
export const bootJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

export interface ShellOpts {
  title: string;
  description: string;
  base: string;
  /** Canonical path of this page, for og:url. */
  path: string;
  body: string;
  /** Inline script, already safe. */
  script?: string;
  noindex?: boolean;
}

const TOKENS = `
:root{
  --paper:#F3F5FA;--card:#FFFFFF;--sunk:#E9EDF6;--ink:#0D1B3D;--ink-soft:#3F4F78;--ink-faint:#6B789A;
  --rule:#D8DEEC;--rule-soft:#E8ECF5;--navy:#0F2557;--cobalt:#005CBC;--cobalt-ink:#004FAC;--cobalt-soft:#E3EEFB;
  --gold:#8F6D17;--gold-soft:#F8F0DA;--ok:#1F6B4A;--ok-soft:#E3F1E8;--warn:#8A6A1F;--warn-soft:#F4EEDD;--bad:#A3352B;--bad-soft:#F8EAE8;
  --display:"Space Grotesk",system-ui,sans-serif;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  --shadow:0 1px 2px rgba(13,27,61,.06),0 10px 30px -18px rgba(13,27,61,.35);color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0A1430;--card:#111D3F;--sunk:#0D1836;--ink:#E8EDF8;--ink-soft:#B3BDD6;--ink-faint:#8B97B6;
  --rule:#243259;--rule-soft:#1B2749;--navy:#081029;--cobalt:#0071D1;--cobalt-ink:#9CCBFF;--cobalt-soft:#14264F;
  --gold:#D9B85E;--gold-soft:#3A2F14;--ok:#6FC397;--ok-soft:#15281F;--warn:#D7B45F;--warn-soft:#2A2314;--bad:#E38D82;--bad-soft:#2E1A17;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8);color-scheme:dark;
}}
:root[data-theme="dark"]{
  --paper:#0A1430;--card:#111D3F;--sunk:#0D1836;--ink:#E8EDF8;--ink-soft:#B3BDD6;--ink-faint:#8B97B6;
  --rule:#243259;--rule-soft:#1B2749;--navy:#081029;--cobalt:#0071D1;--cobalt-ink:#9CCBFF;--cobalt-soft:#14264F;
  --gold:#D9B85E;--gold-soft:#3A2F14;--ok:#6FC397;--ok-soft:#15281F;--warn:#D7B45F;--warn-soft:#2A2314;--bad:#E38D82;--bad-soft:#2E1A17;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8);color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--display);margin:0;text-wrap:balance;letter-spacing:-.02em;line-height:1.15}
h1{font-size:clamp(1.7rem,4.5vw,2.5rem);font-weight:700}h2{font-size:1.25rem;font-weight:600}h3{font-size:1rem;font-weight:600}
p{margin:.45em 0}a{color:var(--cobalt-ink);text-decoration:none}a:hover{text-decoration:underline}
button,input,select{font:inherit;color:inherit}:focus-visible{outline:2px solid var(--cobalt);outline-offset:2px;border-radius:4px}
code,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}code{font-size:.88em;background:var(--sunk);padding:.08em .38em;border-radius:4px;word-break:break-all}
.bar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--rule)}
.bar-in{max-width:880px;margin:0 auto;padding:.55rem 16px;display:flex;align-items:center;gap:.7rem}
.brand{display:flex;align-items:center;gap:.6rem;color:var(--ink)}.brand:hover{text-decoration:none}
.brand img{width:34px;height:37px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px var(--rule)}
.brand b{font-family:var(--display);font-weight:700;font-size:1.05rem;letter-spacing:-.02em;display:block;line-height:1.05}
.brand small{display:block;font-size:.58rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#0891B2}
.spacer{flex:1}
.tbtn{width:36px;height:36px;border-radius:9px;border:1px solid var(--rule);background:var(--card);display:grid;place-items:center;cursor:pointer;color:var(--ink-soft)}
.tbtn svg{width:17px;height:17px}
main{max-width:880px;margin:0 auto;padding:1.8rem 16px 4rem;display:flex;flex-direction:column;gap:1.2rem}
.eyebrow{font-family:var(--mono);font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:500}
.lead{font-size:1.06rem;color:var(--ink-soft);max-width:62ch}
.muted{color:var(--ink-faint)}.small{font-size:.86rem}
.card{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:1.2rem;box-shadow:var(--shadow);min-width:0}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;padding:.65rem 1.05rem;border-radius:10px;border:1px solid var(--rule);background:var(--card);color:var(--ink);font-weight:500;cursor:pointer;white-space:nowrap}
.btn:hover{text-decoration:none;border-color:var(--ink-faint)}.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:var(--cobalt);border-color:var(--cobalt);color:#fff}
.btn.gold{background:#CA9D33;border-color:#CA9D33;color:#1B1500}
.btn.x{background:#0F1419;border-color:#0F1419;color:#fff}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
.kv{display:grid;grid-template-columns:minmax(7rem,auto) 1fr;gap:.45rem 1rem;margin:0}
.kv dt{font-family:var(--mono);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);padding-top:.2rem}
.kv dd{margin:0;overflow-wrap:anywhere}
.stamp{display:inline-block;font-family:var(--mono);font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;padding:.26rem .6rem;border-radius:4px;border:1px solid currentColor}
.stamp.ok{color:var(--ok);background:var(--ok-soft)}.stamp.warn{color:var(--warn);background:var(--warn-soft)}.stamp.bad{color:var(--bad);background:var(--bad-soft)}
.price{font-family:var(--display);font-size:2.1rem;font-weight:700;letter-spacing:-.02em}
.note{border-left:3px solid var(--gold);background:var(--gold-soft);padding:.6rem .85rem;border-radius:0 8px 8px 0}
input[type=text],select{width:100%;padding:.55rem .7rem;border:1px solid var(--rule);border-radius:9px;background:var(--sunk)}
label{display:block;font-family:var(--mono);font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:.25rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--rule-soft)}th{font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);font-weight:500}
.tw{overflow-x:auto}
.err{color:var(--bad)}
footer{max-width:880px;margin:0 auto;padding:0 16px 3rem;font-size:.84rem;color:var(--ink-faint);display:flex;gap:1rem;flex-wrap:wrap}
[hidden]{display:none!important}
`;

const THEME_JS = `(function(){var d=document.documentElement;try{var s=localStorage.getItem('iomarkets.theme');if(s)d.setAttribute('data-theme',s)}catch(e){}
var b=document.getElementById('theme');if(b)b.onclick=function(){var c=d.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var n=c==='dark'?'light':'dark';d.setAttribute('data-theme',n);try{localStorage.setItem('iomarkets.theme',n)}catch(e){}}})();`;

export function shell(o: ShellOpts): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:image" content="${esc(o.base)}${BRAND_ASSETS.og}">
<meta property="og:url" content="${esc(o.base)}${esc(o.path)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@IoMarkets">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(o.base)}${BRAND_ASSETS.og}">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(o.base)}${esc(o.path)}">`}
<meta name="theme-color" content="#0F2557">
<link rel="icon" href="${BRAND_ASSETS.favicon}" type="image/png">
<link rel="apple-touch-icon" href="${BRAND_ASSETS.touch}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${TOKENS}</style></head><body>
<div class="bar"><div class="bar-in">
  <a class="brand" href="/" aria-label="IoMarkets home"><img src="${BRAND_ASSETS.logo}" alt="IoMarkets logo" width="34" height="37"><span><b>IoMarkets®</b><small>App</small></span></a>
  <span class="spacer"></span>
  <a class="btn" href="/earn" style="padding:.4rem .75rem;font-size:.86rem">Earn USDC</a>
  <button class="tbtn" id="theme" aria-label="Toggle light or dark theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
</div></div>
<main>
${o.body}
</main>
<footer><a href="/">iomarkets.app</a><a href="/agent.md">Agent docs</a><a href="/verify">Verify a receipt</a><a href="/v1/ledger">Public ledger</a><a href="/fund">Get USDC on Algorand</a><a href="/pay?demo=1">Payout demo</a></footer>
<script>${THEME_JS}</script>
${o.script ? `<script type="module">${o.script}</script>` : ""}
</body></html>`;
}
