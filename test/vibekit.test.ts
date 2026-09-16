// The VibeKit plugin is the THIRD transport over one tool surface. These tests exist
// to hold the property that makes that safe: it does not re-declare the tools, it reads
// them back out of registerTools(), so it cannot drift from stdio MCP or POST /mcp.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { iomarketsPlugin, recordTools, unwrapMcpResult, PLUGIN_NAME, type VibekitDefineTool } from "../src/vibekit.js";
import { registerTools, type McpContext } from "../src/mcp-tools.js";

/** A minimal stand-in for VibeKit's defineTool — it just keeps the spec. */
interface Spec { name: string; description: string; parameters: z.ZodTypeAny; handler: (c: unknown, a: Record<string, unknown>) => Promise<unknown> }
const specs: Spec[] = [];
const fakeDefineTool: VibekitDefineTool = ((spec: Spec) => { specs.push(spec); return spec; }) as VibekitDefineTool;

/** Records what the real MCP registration path produces, for comparison. */
function mcpToolNames(ctx: McpContext): string[] {
  const names: string[] = [];
  registerTools({ registerTool: (n: string) => { names.push(n); } } as never, ctx);
  return names;
}

const ctx = (call: McpContext["call"]): McpContext => ({ apiBase: "https://x.test", call });
const okJson = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));

describe("the VibeKit plugin cannot drift from the other two transports", () => {
  it("exposes exactly the MCP tool set, namespaced", () => {
    specs.length = 0;
    const c = ctx(() => okJson({}));
    const plugin = iomarketsPlugin(fakeDefineTool, { fetchImpl: (() => okJson({})) as unknown as typeof fetch });
    const fromMcp = mcpToolNames(c);
    expect(fromMcp.length).toBeGreaterThan(5); // sanity: registerTools really ran
    expect(plugin.tools).toHaveLength(fromMcp.length);
    expect(specs.map((s) => s.name)).toEqual(fromMcp.map((n) => `iomarkets_${n}`));
  });

  it("carries each tool's description across verbatim, rather than restating it", () => {
    specs.length = 0;
    iomarketsPlugin(fakeDefineTool, { fetchImpl: (() => okJson({})) as unknown as typeof fetch });
    const recorded = recordTools(ctx(() => okJson({})));
    for (const r of recorded) {
      const spec = specs.find((s) => s.name === `iomarkets_${r.name}`)!;
      expect(spec.description).toBe(r.description);
    }
    // The MVNO warning is the one that costs real money when it goes missing.
    expect(specs.find((s) => s.name === "iomarkets_lookup_phone")!.description).toMatch(/MVNO/);
  });

  it("wraps each tool's input schema into a zod object VibeKit can read", () => {
    specs.length = 0;
    iomarketsPlugin(fakeDefineTool, { fetchImpl: (() => okJson({})) as unknown as typeof fetch });
    const status = specs.find((s) => s.name === "iomarkets_order_status")!;
    expect(status.parameters.safeParse({ orderId: "ord_1" }).success).toBe(true);
    expect(status.parameters.safeParse({}).success).toBe(false);
  });
});

describe("the plugin holds no wallet", () => {
  it("calls the hosted API over HTTP and never signs anything", async () => {
    specs.length = 0;
    const fetchImpl = vi.fn(() => okJson({ phone: "+919876543210", country: "IN" })) as unknown as typeof fetch;
    iomarketsPlugin(fakeDefineTool, { apiBase: "https://iomarkets.app/", fetchImpl });
    const lookup = specs.find((s) => s.name === "iomarkets_lookup_phone")!;
    const out = await lookup.handler({}, { phone: "+919876543210" });
    // Trailing slash trimmed, path appended — not a doubled slash.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe("https://iomarkets.app/v1/lookup?phone=%2B919876543210");
    expect(out).toMatchObject({ country: "IN" });
  });

  it("describes buy as returning a challenge, not as spending money", () => {
    specs.length = 0;
    iomarketsPlugin(fakeDefineTool, { fetchImpl: (() => okJson({})) as unknown as typeof fetch });
    const buy = specs.find((s) => s.name === "iomarkets_buy")!;
    // The stdio transport's wording ("Spends real money from the agent wallet") would be
    // a lie here and a key-custody invitation. ctx.pay is deliberately absent.
    expect(buy.description).toMatch(/holds no wallet/i);
    expect(buy.description).not.toMatch(/Spends real money/);
  });
});

describe("the MCP text envelope is a transport detail", () => {
  it("unwraps JSON answers into plain objects", () => {
    expect(unwrapMcpResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
  });
  it("passes prose through as a string rather than throwing", () => {
    expect(unwrapMcpResult({ content: [{ type: "text", text: "not json" }] })).toBe("not json");
  });
  it("leaves an unrecognised shape alone", () => {
    expect(unwrapMcpResult({ weird: true })).toEqual({ weird: true });
  });
});

describe("plugin identity", () => {
  it("names itself once, for the services bag VibeKit keys on", () => {
    const plugin = iomarketsPlugin(fakeDefineTool, { fetchImpl: (() => okJson({})) as unknown as typeof fetch });
    expect(plugin.name).toBe(PLUGIN_NAME);
    // The description is what an agent author reads when choosing plugins; it must say
    // what is live, not what the repo can theoretically sell.
    expect(plugin.description).toMatch(/airtime and data top-ups/);
    expect(plugin.description).not.toMatch(/eSIM|payout|bill/i);
  });
});
