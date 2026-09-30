// The notice at the top of every HTML page this server renders.
//
// WHY THIS EXISTS. The site is cited as a technology demonstration, and it is not offered
// as a commercial service until licensing, penetration testing and security audits are
// complete. It has, though, been tested on real data with real money: the service
// settles real USDC on Algorand mainnet (see /v1/ledger). The wording is the owner's
// (2026-09-30) and says both, because "nothing is live" would be false.
//
// One string, one block of markup, included by every page shell (src/landing.ts,
// src/chrome.ts, src/html.ts) so the pages cannot word it differently. The /pay console
// is a separate React build and carries the same text in
// web/src/components/io/DemoBanner.tsx; test/demo-banner.test.ts pins the two together.
//
// Not dismissible, on purpose: it is a statement about the service, not a promo.
// Self-contained styles, because the pages it sits on do not share one set of tokens
// (/fund has none at all). Light and dark follow the same `data-theme` / system rule
// as the rest of the site.

export const DEMO_BANNER_LEAD = "Demonstration only.";
export const DEMO_BANNER_BODY =
  "This is a technology demonstration that has been tested on real data with real money in a limited pilot. It is not offered as a commercial service until the required licences, penetration testing and security audits are complete.";

const CSS = `.iom-demo{background:#F8F0DA;color:#3A2F14;border-bottom:1px solid #B8902A;font:14px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;position:relative;z-index:40}
.iom-demo-in{max-width:1120px;margin:0 auto;padding:.6rem 16px;overflow-wrap:anywhere}
.iom-demo b{font-weight:600;color:#1B1500}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .iom-demo{background:#3A2F14;color:#F4E7C3;border-bottom-color:#D9B85E}:root:not([data-theme="light"]) .iom-demo b{color:#FFF6DC}}
:root[data-theme="dark"] .iom-demo{background:#3A2F14;color:#F4E7C3;border-bottom-color:#D9B85E}:root[data-theme="dark"] .iom-demo b{color:#FFF6DC}`;

/** Goes immediately after `<body>`. */
export const DEMO_BANNER_HTML = `<style>${CSS}</style><div class="iom-demo" role="note" aria-label="Demonstration notice"><div class="iom-demo-in"><b>${DEMO_BANNER_LEAD}</b> ${DEMO_BANNER_BODY}</div></div>`;
