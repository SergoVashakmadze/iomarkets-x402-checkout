// MCP server, stdio transport — runs on the agent's own machine and, when an agent
// key is provided (AGENT_MNEMONIC_FILE), pays with the agent's Algorand wallet under a
// budget. The tools themselves live in mcp-tools.ts and are shared with the hosted
// endpoint at POST /mcp, which holds no wallet.
//
//   AGENT_MNEMONIC_FILE=~/.secrets/agent.mnemonic API_URL=https://iomarkets.app pnpm mcp
//   (register it in your client's MCP config — see skills/SKILL.md)
//
// Agents that would rather not run anything locally can point their client at
// https://iomarkets.app/mcp instead and pay the returned 402 from their own wallet.

import algosdk from "algosdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makePayingFetch, type PayingFetch } from "./client/paying.js";
import { loadSecret } from "./keys.js";
import { registerTools } from "./mcp-tools.js";

const API = (process.env.API_URL ?? "https://iomarkets.app").replace(/\/$/, "");
const NETWORK = process.env.NETWORK ?? "mainnet";
const ALGOD = NETWORK === "mainnet" ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud";
const BUDGET_USD = Number(process.env.AGENT_BUDGET_USD ?? "20");
const MAX_ORDER_USD = Number(process.env.AGENT_MAX_ORDER_USD ?? "20");

let paying: PayingFetch | undefined;
let payerAddress: string | undefined;
const agentMnemonic = loadSecret("AGENT_MNEMONIC");
if (agentMnemonic) {
  const account = algosdk.mnemonicToSecretKey(agentMnemonic);
  payerAddress = account.addr.toString();
  paying = makePayingFetch(account, {
    algodUrl: ALGOD,
    capMicroUsdc: BigInt(Math.round(BUDGET_USD * 1e6)),
    maxPerCallMicroUsdc: BigInt(Math.round(MAX_ORDER_USD * 1e6)),
  });
}

const server = new McpServer({ name: "iomarkets-topup", version: "0.1.0" });

registerTools(server, {
  call: (path, init) => fetch(`${API}${path}`, init),
  apiBase: API,
  pay: paying,
  payerAddress,
  budgetUsd: BUDGET_USD,
  maxOrderUsd: MAX_ORDER_USD,
});

await server.connect(new StdioServerTransport());
