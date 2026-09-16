// The static-file layer that serves the batch payout console at /pay.
//
// Both bugs pinned here shipped and were found by opening the page:
//
//  * the shell was read ONCE at startup, so rebuilding the console under a running
//    process left it naming content-hashed assets that no longer existed;
//  * the SPA fallback answered ANY unmatched /pay/* path with the shell, so a request
//    for one of those replaced scripts came back `200 text/html`. The browser cannot
//    parse HTML as a module and says nothing about it — a blank page with an empty
//    console, which is how the first bug stayed hidden.
//
// The second is the one that matters: it converts a missing file into a silent
// success. Asset requests must fail as asset requests.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mountPayConsole } from "../src/pay-console.js";

// fileURLToPath, not .pathname — the repo path contains a space, which .pathname
// leaves percent-encoded and existsSync then never finds.
const CLIENT_DIR = fileURLToPath(new URL("../web/dist/client", import.meta.url));
const built = existsSync(join(CLIENT_DIR, "_shell.html"));

function build() {
  const app = new Hono<{ Variables: { pendingQuote?: string } }>();
  const ok = mountPayConsole(app);
  return { app, ok };
}

describe.skipIf(!built)("the console is mounted", () => {
  it("serves the prerendered shell at /pay", async () => {
    const { app, ok } = build();
    expect(ok).toBe(true);
    const res = await app.request("/pay");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    // The shell must not be cached: a redeploy would otherwise leave browsers
    // pointing at asset hashes that no longer exist.
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves a client route with the shell, because the router runs in the browser", async () => {
    const { app } = build();
    const res = await app.request("/pay/anything/the/router/owns");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("404s a MISSING asset instead of handing back the shell", async () => {
    const { app } = build();
    for (const p of [
      "/pay/assets/index-DOESNOTEXIST.js",
      "/pay/assets/styles-GONE.css",
      "/pay/some-removed-file.js",
    ]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("content-type") ?? "", p).not.toMatch(/text\/html/);
    }
  });

  it("serves a real asset with an immutable cache header", async () => {
    const { app } = build();
    const shell = readFileSync(join(CLIENT_DIR, "_shell.html"), "utf8");
    const ref = /\/pay\/(assets\/[A-Za-z0-9._-]+)/.exec(shell)?.[1];
    expect(ref, "the shell should reference at least one hashed asset").toBeTruthy();

    const res = await app.request(`/pay/${ref}`);
    expect(res.status).toBe(200);
    // Hashed filenames are immutable by construction, so they may be cached forever.
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
  });

  it("every asset the shell names actually resolves", async () => {
    const { app } = build();
    const shell = readFileSync(join(CLIENT_DIR, "_shell.html"), "utf8");
    const refs = [...new Set([...shell.matchAll(/\/pay\/(assets\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]))];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect((await app.request(`/pay/${r}`)).status, r).toBe(200);
    }
  });

  it("refuses to walk out of the client directory", async () => {
    const { app } = build();
    for (const p of [
      "/pay/../../.env",
      "/pay/assets/../../../../etc/passwd",
      "/pay/%2e%2e%2f%2e%2e%2f.env",
    ]) {
      const res = await app.request(p);
      // Either a 404, or the SPA shell — never a file from outside the directory.
      const body = await res.text();
      expect(body, p).not.toMatch(/PAY_TO|RECEIPT_PRIVATE_KEY|root:x:/);
    }
  });
});
