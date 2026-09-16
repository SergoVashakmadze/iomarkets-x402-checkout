# Skill

`iomarkets-topup/SKILL.md` is the **single source**. It is the agentskills format, which OpenClaw (ClawHub),
the Hermes skill hub and Claude Code all read, so publishing is a copy — not a fork.

There were once per-platform copies under `skills/hermes/` and `skills/openclaw/`. They were
byte-identical to this one and were removed on 2026-08-26: three copies of a file that names
prices, limits and endpoints is three chances to publish stale terms. If a hub ever needs
genuinely different frontmatter, generate it at publish time rather than committing a fork.

It lives one directory down (`skills/iomarkets-topup/SKILL.md`) because that is the layout a
Claude Code plugin expects — `skills/<skill-name>/SKILL.md`. The repo root doubles as the
plugin: `.claude-plugin/plugin.json` declares this skill plus the **hosted** MCP server at
`https://iomarkets.app/mcp`, so installing the plugin needs no clone, no local process and no
wallet handed to anyone.

## Publishing
- **ClawHub / OpenClaw** and the **Hermes skill hub** — upload `SKILL.md` as-is.
- **Claude Code** — `/plugin marketplace add <repo>` needs a **public** git repo, and this one is
  private. Publish a small public mirror containing only `.claude-plugin/` and `skills/` (nothing
  else is needed — the plugin points at the hosted MCP endpoint, not at this source), or make this
  repo public after the competition.

Re-publish whenever the pricing, the per-order/per-payer caps or the endpoints change.

## VibeKit — a fourth surface, and the one aimed at the right buyers

`src/vibekit.ts` exposes the same tools as an **Algorand VibeKit** `ToolPlugin`
(github.com/initlabsai/vibekit, `@initlabs/vibekit`). VibeKit is a framework for building Algorand agents — typed tools, an agent loop,
an MCP adapter, a Foundation keystore signer and x402 payment built in — with a plugin contract and
existing plugins for NFD, Pera, Vestige and Alpha Arcade.

**Why it is the most valuable of the four.** ClawHub, the Hermes hub and the Claude Code marketplace reach
agent builders in general. VibeKit reaches the ones whose agents already hold **USDC on Algorand** — which
is the population that can buy from us.

```ts
import { defineTool, createMcpServer } from "@initlabs/vibekit"
import { iomarketsPlugin } from "@iomarkets/vibekit"

createMcpServer({ plugins: [iomarketsPlugin(defineTool)] })
```

`defineTool` is passed **in** rather than imported: `@initlabs/vibekit` is 1.0.0-alpha and pulls the AI SDK,
the OpenAI and Anthropic clients, the Foundation keystore and two DeFi SDKs, none of which belongs in a
process holding a spending key. We depend on the shape, not the package, so an alpha bump cannot break us.

The plugin holds **no wallet**: `buy` returns the x402 challenge for the embedding agent's own Algorand
signer to settle. A plugin running inside someone else's agent must never custody their key.

### Two ways to ship it, and the second is the point

1. **As `@iomarkets/vibekit` on npm** — a small package wrapping `src/vibekit.ts`, declaring
   `@initlabs/vibekit` as a *peer* dependency. Anyone can `vibekit add` it.
2. **Upstream, as `packages/vibekit/src/plugins/iomarkets/`** — the file is deliberately written in their
   plugin contract (`{ name, description, tools }`, `defineTool`, namespaced tool names), so offering it as
   a PR is a near-verbatim move.
