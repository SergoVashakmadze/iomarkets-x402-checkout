// The distribution manifests are published to third parties and never exercised by
// the running server, so nothing else would notice a typo, a stale URL or a skill
// file that moved. These assertions are cheap and catch exactly that drift.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const readJson = (p: string) => JSON.parse(read(p));

const MCP_URL = "https://iomarkets.app/mcp";

describe("MCP registry manifest (server.json)", () => {
  const s = readJson("server.json");

  it("carries the fields the registry schema requires", () => {
    for (const k of ["name", "description", "version"]) expect(s[k], k).toBeTruthy();
    expect(s.$schema).toMatch(/server\.schema\.json$/);
  });

  // The registry rejects a longer description with a 422 at publish time, and the only
  // place that shows up is `mcp-publisher validate`. Caught once already (2026-08-27).
  it("keeps the description inside the registry's 100-character limit", () => {
    expect(s.description.length).toBeLessThanOrEqual(100);
  });

  // "Must contain exactly one forward slash separating namespace from server name."
  it("uses a reverse-DNS name matching the schema pattern", () => {
    expect(s.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(s.name.split("/")).toHaveLength(2);
  });

  it("points remotes at the hosted Streamable HTTP endpoint", () => {
    expect(s.remotes).toHaveLength(1);
    expect(s.remotes[0]).toEqual({ type: "streamable-http", url: MCP_URL });
  });

  // The repo is private; pointing a public registry at it fails the transparency
  // check that field exists for. Publish a public mirror before adding it.
  it("declares no repository while the source is private", () => {
    expect(s.repository).toBeUndefined();
  });
});

describe("Claude Code plugin (.claude-plugin/plugin.json)", () => {
  const p = readJson(".claude-plugin/plugin.json");

  it("has a kebab-case name, the only required field", () => {
    expect(p.name).toBe("iomarkets-topup");
    expect(p.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("ships the hosted MCP server so installing needs no clone and no wallet", () => {
    expect(p.mcpServers["iomarkets-topup"]).toEqual({ type: "http", url: MCP_URL });
  });

  // Claude Code discovers skills at skills/<skill-name>/SKILL.md.
  it("has its skill where the default layout expects it", () => {
    expect(existsSync(join(root, "skills", p.name, "SKILL.md"))).toBe(true);
  });
});

describe("the skill agrees with the manifests", () => {
  const skill = read("skills/iomarkets-topup/SKILL.md");
  const plugin = readJson(".claude-plugin/plugin.json");

  it("declares the same name as the plugin", () => {
    expect(skill).toMatch(new RegExp(`^name:\\s*${plugin.name}$`, "m"));
  });

  it("documents the hosted endpoint the manifests advertise", () => {
    expect(skill).toContain(MCP_URL);
  });

  // The local install pays from the agent's own wallet; the mnemonic must be
  // referenced as a file, never inlined into a config a user might commit.
  it("never tells anyone to put a mnemonic in the config", () => {
    expect(skill).toContain("AGENT_MNEMONIC_FILE");
    expect(skill).not.toMatch(/AGENT_MNEMONIC"\s*:/);
  });

  it("states the caps the server actually enforces", () => {
    expect(skill).toMatch(/\$50/);
    expect(skill).toMatch(/\$200\/payer\/day/);
  });
});

// The Global x402 Challenge's readiness checklist requires the endpoint to appear in
// the Bazaar "with the x402-global-challenge tag". Where that tag lives is not a
// matter of taste: measured against the live facilitator on 2026-08-29, 422 of the
// first 500 listed resources carry it at `accepts[0].extra.tag`, and NOT ONE carries a
// top-level `tags` array or `discoveryInfo.tags` — the facilitator does not store the
// resource-level field. We shipped only the resource-level one until this test existed,
// which would have listed us untagged and therefore ineligible, with nothing to notice
// it until judging. `pnpm check-bazaar` asserts the same thing against the live listing
// once there is one; this asserts it before there is.
describe("Bazaar challenge tag", () => {
  const app = read("src/app.ts");

  it("carries the challenge tag inside the payment requirements' `extra`", () => {
    expect(app).toMatch(/extra:\s*\{[^}]*\btag:\s*CHALLENGE_TAG/);
  });

  it("defines the tag as the exact string the challenge checks for", () => {
    expect(app).toMatch(/const CHALLENGE_TAG = "x402-global-challenge";/);
  });

  it("still advertises it in the resource tags for other consumers", () => {
    expect(app).toMatch(/tags:\s*\[CHALLENGE_TAG,/);
  });

  it("is asserted by check-bazaar, so a listing that lost it fails loudly", () => {
    const s = read("scripts/check-bazaar.ts");
    expect(s).toContain('REQUIRED_TAG = "x402-global-challenge"');
    expect(s).toMatch(/process\.exit\(1\)/);
  });
});
