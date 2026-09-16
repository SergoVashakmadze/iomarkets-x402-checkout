// The brand assets every human-facing page shares: the logo, the favicon, the
// social-card image. Read once at startup — the files ship inside the image (the
// Dockerfile copies src/ whole) and are immutable for the life of the process.
//
// Served from here rather than from web/dist so that /, /console, /verify and /fund
// carry the same mark whether or not the console build exists on the box.

import { readFileSync } from "node:fs";
import type { Hono } from "hono";

const ASSETS: ReadonlyArray<readonly [route: string, file: string, type: string]> = [
  ["/brand/logo.webp", "logo.webp", "image/webp"],
  ["/brand/logo-og.png", "logo-og.png", "image/png"],
  // Browsers ask for /favicon.ico unprompted; the bytes are PNG and every browser
  // that matters sniffs the type, and the content-type says so anyway.
  ["/favicon.ico", "icon-32.png", "image/png"],
  ["/favicon.png", "icon-64.png", "image/png"],
  ["/apple-touch-icon.png", "icon-180.png", "image/png"],
];

export function mountBrand(app: Hono<any>): void {
  for (const [route, file, type] of ASSETS) {
    const bytes = readFileSync(new URL(`./assets/${file}`, import.meta.url));
    app.get(route, (c) => {
      c.header("content-type", type);
      c.header("cache-control", "public, max-age=86400");
      return c.body(bytes);
    });
  }
}
