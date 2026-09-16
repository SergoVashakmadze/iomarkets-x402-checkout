// The batch console — the human-facing half of the product.
//
// An ops person at a payments company will never run `pnpm buy` against a mnemonic in
// a file, and that was the real distance between "the API works" and "a counterparty
// can use it". This serves the same page in two modes from ONE file: with
// `window.__IOM__` injected it talks to this server and signs with the viewer's own
// Pera wallet; without it the page runs on canned data, which is what makes
// src/console.html publishable as a walkthrough for someone who has no wallet yet.

import { page, readFragment } from "./html.js";

// The file is authored as an Artifact body fragment — see src/html.ts for why its
// <title> and font <link> have to be lifted into a real <head>.
const FRAGMENT = readFragment(new URL("./console.html", import.meta.url));

export interface ConsoleFacts {
  /** Kept for the page's own copy; the console always calls its own origin, never this. */
  base: string;
  network: string;
  algodUrl: string;
  brand: string;
  /** What the wired suppliers can actually sell. The page opens on one of these and
   *  hides the rest, instead of probing the catalogue to find out what it already knew. */
  products: readonly string[];
}

export function consoleHtml(f: ConsoleFacts): string {
  // The console talks to ITS OWN ORIGIN, never to PUBLIC_BASE_URL. Injecting the public
  // base made every fetch cross-origin the moment the page was opened on 127.0.0.1,
  // and the whole catalogue failed with "Failed to fetch".
  // JSON.stringify escapes </script> as <\/script> only if we ask; do it explicitly so
  // a future field containing markup cannot break out of the tag.
  const cfg = JSON.stringify({ base: "", network: f.network, algod: f.algodUrl, demo: false, products: f.products }).replace(/</g, "\\u003c");
  return page(FRAGMENT, {
    description: "Pay a batch of people in Africa and South Asia from one wallet. Prices locked, money settles on-chain first, every payment returns a signed receipt.",
    inject: `<script>window.__IOM__=${cfg}</script>`,
  });
}
