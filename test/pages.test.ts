// Do the pages we serve to humans actually parse?
//
// WHY THIS EXISTS. `src/verify.html` shipped with `class=\\"mono\\"` inside a
// double-quoted JS string. That is a **syntax error**, so the browser threw the entire
// inline script away — every button on the page was inert, silently, with no error
// visible on the page itself. It was found by clicking a button in a real browser and
// noticing that nothing happened, which is the second time this project has found a
// dead console script that way (`parseRows()`'s ReferenceError, session 8).
//
// A browser is the right place to find *behavioural* bugs. It is an absurd place to
// find a syntax error. `new Function(src)` compiles without executing, needs no DOM,
// and takes a millisecond — so a page whose script cannot parse now fails the suite
// rather than a demo.
//
// It deliberately does NOT try to run the scripts: they need a document, a fetch and a
// wallet. Compiling is the whole check, and it is the one that would have caught this.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { generateKeypair } from "../src/receipt.js";
import { MockSupplier } from "../src/suppliers/mock.js";

/** Every inline <script> in a page, with its opening tag so module-ness is visible. */
function inlineScripts(file: string): Array<{ tag: string; src: string }> {
  const html = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    // A <script src="…"> has no body to compile.
    .filter((m) => m[2].trim() && !/\bsrc=/.test(m[1]))
    .map((m) => ({ tag: m[1], src: m[2] }));
}

/** Compile without running. Top-level await is legal in a module, so allow for it. */
function compiles(src: string, isModule: boolean): string | null {
  try {
    if (isModule) new Function(`return (async () => { ${src} })`);
    else new Function(src);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("served pages", () => {
  for (const file of ["console.html", "verify.html"]) {
    it(`${file}: every inline script compiles`, () => {
      const scripts = inlineScripts(file);
      expect(scripts.length).toBeGreaterThan(0);
      for (const { tag, src } of scripts) {
        const error = compiles(src, /type\s*=\s*["']module["']/.test(tag));
        expect(error, `${file} inline script does not parse: ${error}`).toBeNull();
      }
    });
  }
});

function build() {
  const kp = generateKeypair();
  const db = new Db(":memory:");
  const supplier = new MockSupplier();
  const orders = new OrderService(db, supplier, { async send(id) { return `RF_${id}`; }, address: () => "R" }, {
    pricing: { markupBps: 400, fixedFeeUsd: 0.05, minOrderUsd: 0.5 }, maxOrderUsd: 50, quoteTtlSec: 600,
    blockedCountries: ["CU"], payout: { maxUsd: 200, kycAboveUsd: 100, recipientDailyUsd: 500 }, payerDailyUsd: 200,
    receiptPrivateKey: kp.privateKey, ordersEndpoint: "http://x/v1/orders", pollIntervalMs: 1, timeoutMs: 2000, log: () => {},
  });
  return buildApp({ db, supplier, orders, paymentMiddleware: async (c) => c.json({ error: "payment required" }, 402) });
}

describe("the pages are served as real documents", () => {
  it("/verify has one <head>, its title, and the controls it promises", async () => {
    const res = await build().request("/verify");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The fragment is authored without <head>; src/html.ts lifts the title into one.
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.match(/<head>/g)).toHaveLength(1);
    expect(html).toContain("<title>Check a receipt · IoMarkets</title>");
    // The title must not still be sitting in the body where it was authored.
    expect(html.split("<body>")[1]).not.toContain("<title>");
    for (const id of ['id="doc"', 'id="go"', 'id="oid"', 'id="fetch"']) expect(html).toContain(id);
  });

  it("/console still survives the same treatment", async () => {
    const html = await (await build().request("/console")).text();
    expect(html.match(/<head>/g)).toHaveLength(1);
    expect(html).toContain("<title>IoMarkets Console</title>");
    // Live mode is switched on by this injection; without it the page is the demo.
    expect(html).toContain("window.__IOM__=");
  });

  it("the console points at the verifier it claims exists", async () => {
    const html = await (await build().request("/console")).text();
    expect(html).toContain('href="/verify"');
  });

  it("opens on a product that can actually be sold", async () => {
    // MockSupplier sells everything, so the injected set is the full four and the page
    // keeps its original default. What is pinned here is that the server TELLS it —
    // a live console whose first screen said "No corridors here yet" was a shop with
    // the shutters down and the lights on, and it said exactly that on 2026-09-02
    // because payouts have no supplier wired and the page still opened on them.
    const html = await (await build().request("/console")).text();
    expect(html).toMatch(/"products":\[/);
    expect(html).toContain('"payout"');
    // And the page must choose from that set rather than hard-coding one.
    expect(html).toContain("const FIRST_TYPE =");
    expect(html).toContain("type: FIRST_TYPE,");
  });

  it("reconciles the page to its product at boot, not on the first click", async () => {
    // The markup is authored for the payout flow. Opening on airtime without this left
    // the heading reading "Who are you paying?" above a sender-name field, live.
    const html = await (await build().request("/console")).text();
    expect(html).toContain("applyType(S.type);");
  });

  it("the console asks for a whole country, not a page of one", async () => {
    // /v1/catalog pages by default since the eSIM catalogue turned out to be 3,046
    // offers. A picker showing the first hundred of a country would hide packages a
    // buyer came here to choose, and it would do it silently.
    const html = await (await build().request("/console")).text();
    expect(html).toContain('"/v1/catalog?limit=0&type="');
    // …except the tab-hiding probe, which only needs to know whether anything exists.
    expect(html).toContain('"/v1/catalog?limit=1&type="');
  });
});

describe("the landing page says what this is, and carries the brand", () => {
  it("renders the story, the live demo, the ecosystem and the logo", async () => {
    const res = await build().request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>IoMarkets Topup — real-world checkout for AI agents on Algorand</title>");
    // The three questions a first-time visitor has, each with its own section.
    for (const id of ['id="what"', 'id="try"', 'id="how"', 'id="agents"', 'id="business"', 'id="trust"', 'id="about"']) expect(html).toContain(id);
    // Where it fits: the parent organisation, by link, not by claim.
    expect(html).toContain('href="https://iomarkets.org/about"');
    // The footer every IoMarkets site carries: the four entities and the credit line.
    for (const ent of ["IoMarkets<sup>®</sup> LLC", "IoMarkets<sup>®</sup> UG", "IoMarkets<sup>®</sup> Ltd", "IoMarkets<sup>®</sup> WLL"]) expect(html).toContain(ent);
    expect(html).toContain("30 N Gould St Ste R,");
    expect(html).toContain("Built with ❤️ by");
    // The ecosystem pill, top right, with this site as the current row.
    expect(html).toContain("IoMarkets Ecosystem");
    expect(html).toContain('<a role="menuitem" href="/" class="cur">');
    expect(html).toContain('href="https://iomarkets.money" target="_blank"');
    // The newest ecosystem row, added 2026-09-19. Pinned because the list is a
    // hand-maintained copy of the one every sibling site carries, and the public
    // mirror silently went a day without it — a missing row looks like nothing.
    expect(html).toContain('href="https://merchants.london" target="_blank"');
    expect(html).toContain("Merchants of London");
    // The logo, on the page and in the social card.
    expect(html).toContain('src="/brand/logo.webp"');
    expect(html).toMatch(/property="og:image" content="http[^"]*\/brand\/logo-og\.png"/);
    // The demo is one click from the top of the page.
    expect(html).toContain('href="/pay?demo=1"');
    // Products still render from what the supplier can fill — MockSupplier via
    // CompositeSupplier-less buildApp declares all four here.
    expect(html).toContain("mobile airtime &amp; data top-ups, travel eSIMs, prepaid bills and international payments");
    // The interactive explorer gets the same product list, as data.
    expect(html).toMatch(/window\.__IOM__=\{.*"products":\[\{"type":"topup"/);
    expect(html).not.toContain("undefined");
  });

  it("serves the brand assets with the right types", async () => {
    const app = build();
    for (const [path, type] of [["/brand/logo.webp", "image/webp"], ["/brand/logo-og.png", "image/png"], ["/favicon.ico", "image/png"], ["/apple-touch-icon.png", "image/png"]]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect((await res.arrayBuffer()).byteLength, path).toBeGreaterThan(1000);
    }
  });
});

// The footer's social links were bare text here while every sibling site drew the
// glyph beside the name. These are iomarkets.org's own paths (its
// src/components/icons/social.tsx) copied in, so pin a distinctive slice of each:
// if .org redraws a glyph and this copy is not updated, the two sites diverge
// silently — which is exactly how they diverged in the first place.
describe("the footer draws the same social glyphs as iomarkets.org", () => {
  it("renders an icon beside each name, from the shared paths", async () => {
    const html = await (await build().request("/")).text();
    for (const [name, head] of [
      ["Twitter (X)", "M14.234 10.162 22.977 0h-2.072"],
      ["LinkedIn", "M20.447 20.452h-3.554v-5.569"],
      ["Facebook", "M9.101 23.691v-7.98H6.627v-3.667"],
      ["YouTube", "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136"],
    ]) {
      expect(html, name).toContain(`<path d="${head}`);
      // glyph first, then the name, inside the one link
      expect(html, name).toMatch(new RegExp(`<svg[^>]*><path d="${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"/></svg>${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</a>`));
    }
    // sized and aligned like .org's h-4 w-4 / gap-2 row
    expect(html).toContain("footer li a.soc svg{width:1rem;height:1rem;flex:none}");
  });
});

describe("landing: simulate this purchase", () => {
  // Clicking an offer set `sel` and THEN called reset(), which nulls it — so the button
  // was enabled and did nothing, on the live page, until 2026-09-16. Found by recording
  // the demo video, not by any test.
  it("selects the offer after resetting, not before", async () => {
    const { landingHtml } = await import("../src/landing.js");
    const html = landingHtml({ base: "http://x", network: "mainnet", pubkey: "", brand: "B", siteName: "B.app", site: "http://x" });
    expect(html).not.toContain("sel=o;reset()");
    expect(html).toContain("reset();sel=o;run.disabled=false");
  });
});

// A phone found this, not a test: the page scrolled sideways and left a strip of empty
// paper down the right edge. The cause was one <code> in the footer holding the 58-char
// payTo address — an unbreakable 384px token on a 378px viewport, which widens the whole
// document because nothing above it is a scroll container. Every OTHER long thing on the
// page is already contained (pre.code and the ledger's div.tw both scroll on their own),
// so this was the single escapee. src/chrome.ts has carried the break rule since the
// growth pages shipped; src/landing.ts never got it.
describe("the landing page fits a phone", () => {
  it("lets an unbreakable token wrap instead of widening the document", async () => {
    const html = await (await build().request("/")).text();
    const rule = html.match(/code\{[^}]*\}/)?.[0] ?? "";
    expect(rule, "landing <code> needs a break rule").toMatch(/word-break:break-all|overflow-wrap:anywhere/);
  });

  it("still renders the address that caused it", async () => {
    // If the footer stops printing payTo the rule above is untested rather than wrong,
    // so pin the thing it protects. Rendered directly with an explicit payTo rather
    // than through build(): config.payTo comes from PAY_TO in the environment, so going
    // through the app made this pass only on a machine with a populated .env and fail
    // on a clean checkout. Caught by the public repo, which has no .env.
    const { landingHtml } = await import("../src/landing.js");
    const html = landingHtml({
      base: "http://x", network: "mainnet", pubkey: "", brand: "B", siteName: "B.app", site: "http://x",
      payTo: "FVEJDCQFCHVG4Y6M2JVAD4L447E2R2OHJKT5APXV7AZI7XXOQU6RUVSKCA",
    });
    expect(html).toMatch(/payTo <code>/);
  });
});

// The 2026-09-18 SEO audit found no sitemap (robots.txt pointed "Sitemap:" at /agent.md),
// no canonical on any page, and a `?query` variant of / served as an indexable clone.
describe("what search engines read", () => {
  const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];

  it("every sitemap page declares itself canonical, ignoring the query string", async () => {
    const app = build();
    const xml = await (await app.request("/sitemap.xml")).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.map((l) => new URL(l).pathname)).toEqual(["/", "/verify", "/fund", "/earn"]);
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      const res = await app.request(`${path}?utm_source=spam`);
      expect(res.status, path).toBe(200);
      expect(canonical(await res.text()), path).toBe(loc);
    }
  });

  it("robots.txt names the AI crawlers, allows them, and points at the real sitemap", async () => {
    const txt = await (await build().request("/robots.txt")).text();
    for (const ua of ["Google-Extended", "GPTBot", "ClaudeBot"]) {
      const group = txt.split(`User-agent: ${ua}\n`)[1]?.split("\n\n")[0] ?? "";
      expect(group, ua).toContain("Allow: /");
      expect(group, ua).toContain("Disallow: /pay");
      expect(group, ua).not.toMatch(/^Disallow: \/$/m);
    }
    expect(txt).toMatch(/^Sitemap: \S+\/sitemap\.xml$/m);
  });
});
