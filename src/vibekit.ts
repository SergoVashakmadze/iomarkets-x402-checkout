// IoMarkets as an Algorand VibeKit plugin — the third transport for one tool surface.
//
// WHY THIS EXISTS. VibeKit (github.com/initlabsai/vibekit, `@initlabs/vibekit`) is a
// framework for building Algorand agents: a typed tool/query model, an agent loop, an
// MCP adapter, an Algorand Foundation keystore signer — and x402 payment built in.
//
// That matters more than a docs link. This project's binding constraint is not float,
// supply or code: it is that the buyer must hold **USDC on Algorand**, and almost
// nobody does. VibeKit is where the people who do build their agents. A plugin here
// puts a real-world merchant inside the toolkit those agents are assembled from, which
// is the cheapest distribution available to us.
//
// ── Two deliberate design decisions ────────────────────────────────────────────
//
// 1. **No runtime dependency on `@initlabs/vibekit`.** It is 1.0.0-alpha and pulls the
//    AI SDK, the OpenAI and Anthropic clients, the Foundation keystore and two DeFi
//    SDKs. None of that belongs in a service that holds a spending key. So the caller
//    passes VibeKit's own `defineTool` in, and we depend on its *shape* rather than on
//    the package. It also means an alpha bump cannot break this file.
//
// 2. **The tools are not re-declared here.** They are read back out of
//    `registerTools()` — the same function that serves stdio MCP and `POST /mcp` — by
//    handing it a recorder in place of a real server. src/mcp-tools.ts says its purpose
//    is that no transport can drift in what it promises an agent; re-typing eight tool
//    definitions to add a third transport would have quietly ended that. Drift here is
//    impossible by construction rather than by discipline.
//
// ── How a VibeKit agent uses it ────────────────────────────────────────────────
//
//   import { defineTool, createMcpServer } from "@initlabs/vibekit"
//   import { iomarketsPlugin } from "@iomarkets/vibekit"
//
//   createMcpServer({ plugins: [iomarketsPlugin(defineTool)] })
//
// `buy` returns the x402 payment challenge rather than paying: this plugin holds NO
// wallet, and the agent embedding it already has an Algorand signer. It pays the
// challenge itself and re-posts the quote. We never see a key.

import { z } from "zod";
import { registerTools, type McpContext } from "./mcp-tools.js";

/** VibeKit's `defineTool`, structurally. We never import the package. */
export type VibekitDefineTool = (spec: {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
}) => unknown;

/** VibeKit's `ToolPlugin`, structurally — `plugins: [iomarketsPlugin(defineTool)]`. */
export interface VibekitToolPlugin {
  name: string;
  description: string;
  tools: unknown[];
  service?: unknown;
}

export const PLUGIN_NAME = "iomarkets";

export interface IomarketsPluginOptions {
  /** Where the merchant lives. Override only to point at a staging deploy. */
  apiBase?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface Recorded {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Runs `registerTools` against a recorder and keeps what it registered.
 *
 * Depends on one call shape — `registerTool(name, {description, inputSchema}, handler)`
 * — which is our own call site three lines away in src/mcp-tools.ts, not a third
 * party's API. `toolNamesMatchMcp` in the tests pins it.
 */
export function recordTools(ctx: McpContext): Recorded[] {
  const out: Recorded[] = [];
  const recorder = {
    registerTool(
      name: string,
      meta: { description: string; inputSchema: z.ZodRawShape },
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      out.push({ name, description: meta.description, inputSchema: meta.inputSchema, handler });
    },
  };
  registerTools(recorder as never, ctx);
  return out;
}

/**
 * MCP tools answer in a `{ content: [{ type: "text", text }] }` envelope; VibeKit tools
 * return plain JSON. Unwrap rather than re-plumb the handlers: the envelope is a
 * transport detail and this is the transport boundary.
 */
export function unwrapMcpResult(result: unknown): unknown {
  const text = (result as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text; // a tool that answered with prose, not JSON
  }
}

/**
 * The plugin. `defineTool` comes from the caller's own VibeKit — see the note at the
 * top of this file for why it is not imported here.
 */
export function iomarketsPlugin(
  defineTool: VibekitDefineTool,
  opts: IomarketsPluginOptions = {},
): VibekitToolPlugin {
  const apiBase = (opts.apiBase ?? "https://iomarkets.app").replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  // No `pay`, deliberately: a plugin running inside somebody else's agent must never
  // custody their key. `buy` therefore returns the x402 challenge — exact amount, asset,
  // payTo and facilitator — for the agent's own Algorand signer to settle.
  const ctx: McpContext = {
    apiBase,
    call: (path, init) => doFetch(`${apiBase}${path}`, init),
  };

  const tools = recordTools(ctx).map((t) =>
    defineTool({
      name: `iomarkets_${t.name}`, // namespaced: an agent may load a dozen plugins
      description: t.description,
      parameters: z.object(t.inputSchema),
      handler: async (_vibekitCtx, args) => unwrapMcpResult(await t.handler(args)),
    }),
  );

  return {
    name: PLUGIN_NAME,
    description:
      "Buy real-world goods with USDC on Algorand via x402 — mobile airtime and data top-ups in 150+ countries. Settles on chain before it delivers, refunds failures on chain, and signs every terminal order with a receipt naming both transactions.",
    tools,
  };
}
