// The batch payout console (web/) mounted at /pay.
//
// It is a CLIENT-ONLY build — `web/dist/client` is a prerendered shell plus hashed
// assets — so this process serves it as static files rather than running a second
// SSR server. That is the whole reason the console can call /v1/* without CORS,
// without a proxy, and without a Caddy route list that can drift: it is the same
// origin and the same process. `/` stays the agent-facing landing page.
//
// Build it with `pnpm build:web`. If it has not been built, every /pay route answers
// 503 with that instruction — visibly broken beats a bare 404 that looks like a
// routing bug.

import { readFileSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { Env } from "./app.js";

/** web/dist/client, resolved from this file so cwd does not matter (container or repo). */
const CLIENT_DIR = resolve(fileURLToPath(new URL("../web/dist/client", import.meta.url)));

/** Vite emits content-hashed asset names, so they are immutable and cacheable forever. */
const IMMUTABLE = "public, max-age=31536000, immutable";

const NOT_BUILT = "The payout console is not built. Run `pnpm build:web`.";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * The prerendered SPA shell. Every /pay route returns it and the router takes over on
 * the client. Null when the console has not been built.
 *
 * Cached, but revalidated against the file's mtime, and that is not a nicety. The
 * shell names content-hashed assets. Rebuild the console while the process is running
 * — `pnpm build:web` in dev, or a rebuild-in-place on the host-native deploy path —
 * and a shell held from startup keeps naming asset files that no longer exist. The
 * page then loads and renders nothing. Cost is one stat() per shell request, and
 * shell requests are rare compared to asset requests.
 */
let shellCache: { mtimeMs: number; html: string } | null = null;

function readShell(): string | null {
  const file = join(CLIENT_DIR, "_shell.html");
  try {
    const { mtimeMs } = statSync(file);
    if (shellCache?.mtimeMs !== mtimeMs) {
      shellCache = { mtimeMs, html: readFileSync(file, "utf8") };
    }
    return shellCache.html;
  } catch {
    shellCache = null;
    return null;
  }
}

/**
 * Does this path want a FILE rather than a client route?
 *
 * The SPA fallback exists so /pay/anything renders the app. Applied blindly it also
 * answers a request for a missing script with `200 text/html`, and the browser then
 * fails to parse HTML as a module — silently, with no console error and a blank page.
 * That is exactly how the stale-shell bug above hid itself. Anything under assets/, or
 * anything with a file extension, must 404 as a missing file instead.
 */
function looksLikeAsset(rel: string): boolean {
  return rel.startsWith("assets/") || /\.[a-z0-9]{2,5}$/i.test(rel);
}

/**
 * Resolve a request path to a file inside CLIENT_DIR, or null.
 *
 * The `startsWith` check is the path-traversal guard: `resolve` collapses any `..`
 * the request smuggled in, so a path that escapes the root fails here rather than
 * serving an arbitrary file off the box.
 */
function resolveAsset(rel: string): string | null {
  const full = resolve(join(CLIENT_DIR, rel));
  if (full !== CLIENT_DIR && !full.startsWith(CLIENT_DIR + "/")) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Whether `pnpm build:web` has been run. Used by preflight and by the mount below. */
export function payConsoleBuilt(): boolean {
  return readShell() !== null;
}

export function mountPayConsole(app: Hono<Env>): boolean {
  if (!readShell()) {
    app.all("/pay", (c) => c.text(NOT_BUILT, 503));
    app.all("/pay/*", (c) => c.text(NOT_BUILT, 503));
    return false;
  }

  // Static first: anything that exists on disk under /pay/ is served as a file.
  // Everything else falls through to the shell, because it is a client route.
  app.get("/pay/*", (c, next) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname.slice("/pay/".length));
    } catch {
      return c.text("Not found", 404); // malformed percent-encoding
    }
    const file = rel ? resolveAsset(rel) : null;
    if (!file) return looksLikeAsset(rel) ? c.text("Not found", 404) : next();

    c.header("content-type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    // Only the hashed assets are immutable; the rest may be replaced by a redeploy
    // under the same name, so they must revalidate.
    c.header("cache-control", rel.startsWith("assets/") ? IMMUTABLE : "public, max-age=300");
    return c.body(readFileSync(file));
  });

  // The shell itself must never be cached, or a redeploy leaves browsers pointing at
  // asset hashes that no longer exist.
  app.get("/pay", (c) => {
    const html = readShell();
    if (!html) return c.text(NOT_BUILT, 503);
    c.header("cache-control", "no-cache");
    return c.html(html);
  });
  app.get("/pay/*", (c) => {
    const html = readShell();
    if (!html) return c.text(NOT_BUILT, 503);
    c.header("cache-control", "no-cache");
    return c.html(html);
  });

  return true;
}
