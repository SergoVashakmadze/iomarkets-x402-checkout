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
