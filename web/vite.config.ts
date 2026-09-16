// Build config for the IoMarkets batch payout console.
//
// This replaced `@lovable.dev/vite-tanstack-config`. That preset bundles a nitro build
// (targeting a Cloudflare Worker), a redirected SSR server entry, Lovable devtools, an
// asset proxy for their preview sandbox, and host/port detection for it. None of that
// applies here — the console ships as static files inside the existing Hono container —
// and two pieces of it actively prevented the client-only build:
//
//   • nitro rewrites the output layout to .output/, while the SPA prerender step looks
//     for dist/server/server.js;
//   • `server: { entry: "server" }` pointed the build at an SSR error wrapper that a
//     client-only build never executes.
//
// Owning the config is four plugins and removes a dependency from the build path.
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The console calls the IoMarkets API same-origin (/v1/*). In production the Hono
// server serves both; in dev the API is on its own port, so proxy it.
const API_ORIGIN = process.env["IOMARKETS_API"] ?? "http://127.0.0.1:3000";

// Mounted under /pay by the Hono server — `/` is the agent-facing landing page.
// `base` and the router's basepath must agree; see src/router.tsx.
const BASE_PATH = "/pay";

export default defineConfig({
  base: `${BASE_PATH}/`,
  plugins: [
    tailwindcss(),
    tanstackStart({
      // Client-only: one route, behind a wallet connection, with no SEO surface. The
      // shell is prerendered once and every route hydrates from it.
      spa: { enabled: true },
    }),
    viteReact(),
  ],
  resolve: {
    // Vite 8 reads tsconfig `paths` natively — this is the `@/*` alias, and it is why
    // vite-tsconfig-paths is no longer a dependency.
    tsconfigPaths: true,
    // React and the TanStack packages must resolve to ONE copy each. Two copies of
    // React is the classic "invalid hook call"; two routers silently break context.
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
  },
  server: {
    port: 8080,
    proxy: {
      "/v1": { target: API_ORIGIN, changeOrigin: true },
      "/brand": { target: API_ORIGIN, changeOrigin: true },
    },
  },
});
