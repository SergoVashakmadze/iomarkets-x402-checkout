// The A2A Agent Card, served at /.well-known/agent-card.json (and the legacy
// /.well-known/agent.json, which is the path most crawlers still request).
//
// WHY THIS EXISTS. Being found is the whole distribution strategy — the Bazaar listing,
// /agent.md, /llms.txt, server.json and the MCP registry entries all exist for the same
// reason. The agent card is the one registry format that was named in docs/PLAN.md's
// distribution list and never shipped. Routers and marketplaces that index agents rather
// than x402 resources (the AgentPay shape: pick a provider mid-task from a directory)
// read this file and nothing else we publish.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM: a transport.
//
// In A2A, `url` + `preferredTransport` mean "POST A2A JSON-RPC (`message/send`) here".
// **This service does not speak A2A JSON-RPC**, and there is no honest way to fill those
// fields without implementing it:
//
//   - `"JSONRPC"` would be a straight lie — a client would POST a method that 404s.
//   - `"HTTP+JSON"` is a valid enum value pointing at a real REST surface, but A2A's
//     HTTP+JSON binding expects its own method paths (/v1/message:send). Valid-looking
//     and still wrong, which is worse than absent.
//   - An invented value like `"MCP"` is not in the spec's enum at all. This service does
//     speak MCP (src/mcp.ts, POST /mcp), so it would be TRUE — but it smuggles a
//     non-conformant value into a closed enum, and a parser is entitled to reject the
//     whole document over it. Truth in a field that is not allowed to hold it is not a
//     fix. (Owner decision, 2026-09-20.)
//
// So the card carries no transport and no `url`. It is not a conformant A2A card and
// does not pretend to be: it is discovery metadata — who this is, what it sells, that
// payment is x402, and where the real documentation lives. Registries and routers that
// index cards get everything they need to decide; a client that wants to CALL us is sent
// to /agent.md, which describes the interface that actually exists. Implementing A2A
// JSON-RPC properly is the only thing that earns those fields back.
//
// The skills render from the product types the wired suppliers can ACTUALLY fulfil, for
// exactly the reason landingHtml and the Bazaar description do (src/landing.ts,
// src/app.ts): a card that advertises payouts while no payout partner is wired sends a
// router a customer we have to refuse at quote time.

import type { ProductType } from "./suppliers/types.js";
import type { PageFacts } from "./landing.js";

/** Kept in step with server.json by test/agent-card.test.ts — one version, two files. */
export const SERVICE_VERSION = "0.2.7";

/** The A2A spec revision this document is shaped for. */
const PROTOCOL_VERSION = "0.3.0";

interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** One skill per sellable product. Absent from the card when no supplier can fill it. */
const PRODUCT_SKILLS: Record<ProductType, Skill> = {
  esim: {
    id: "buy-esim",
    name: "Buy a travel eSIM",
    description:
      "Buy a data eSIM for 200+ destinations and receive the activation QR / LPA string. Paid per order in USDC on Algorand over x402 — no account, no API key, no card. Browse with GET /v1/catalog?type=esim&country=JP, lock a price with POST /v1/quote, pay POST /v1/orders.",
    tags: ["esim", "travel", "connectivity", "real-world", "x402", "algorand"],
    examples: [
      "Buy a 10 GB eSIM for my trip to Japan next week",
      "What data packages can I get for India, under $15?",
    ],
  },
  topup: {
    id: "buy-airtime",
    name: "Top up a mobile number",
    description:
      "Send mobile airtime or data to a phone number in 150+ countries. GET /v1/lookup?phone=+919876543210 detects the country and operator and lists offers; the detected operator is a guess for MVNOs and must be confirmed with the human before buying. Paid per order in USDC on Algorand over x402.",
    tags: ["airtime", "topup", "mobile", "real-world", "x402", "algorand"],
    examples: [
      "Top up +2348012345678 with 1000 naira of airtime",
      "Send my mother in Manila 300 pesos of mobile data",
    ],
  },
  bill: {
    id: "pay-bill",
    name: "Pay a prepaid bill",
    description:
      "Pay a prepaid utility or service bill on behalf of a principal, in the countries the wired supplier reaches. Paid per order in USDC on Algorand over x402.",
    tags: ["bills", "utilities", "real-world", "x402", "algorand"],
    examples: ["Pay this prepaid electricity account for 5000 naira"],
  },
  payout: {
    id: "send-payment",
    name: "Send an international payment",
    description:
      "Send money to a bank account, mobile money wallet or UPI id abroad, executed by a licensed payout partner. Requires a named sender (legal name + country); above $100 per payer per day it requires an onboarded business account, and sanctioned destinations are refused before any signature is spent. Paid per payment in USDC on Algorand over x402.",
    tags: ["payments", "remittance", "payout", "fx", "x402", "algorand"],
    examples: [
      "Send $50 to this Kenyan M-Pesa number",
      "What is the indicative USDC to INR rate for a payout of 50000 rupees?",
    ],
  },
};

/** Available whatever the suppliers are doing: it reads chain and signature, not stock. */
function alwaysOnSkills(f: PageFacts): Skill[] {
  return [
    {
      id: "verify-receipt",
      name: "Verify a delivery receipt",
      description:
        `Verify an ed25519-signed proof-of-delivery receipt: the signature, which server signed it, and both the settlement and refund transactions against an Algorand indexer. Free, unauthenticated, and it verifies receipts from ANY server that adopts the format — not only this one. POST ${f.base}/v1/verify with the receipt as the body (add ?online=0 to skip the chain lookup). Format: ${f.base}/receipts.md`,
      tags: ["receipts", "verification", "proof-of-delivery", "ed25519", "algorand"],
      examples: [
        "Check that this receipt is genuine and both transactions are on chain",
        "Did the refund for this failed order actually settle?",
      ],
    },
  ];
}

/** Only topup and esim can be sold through a link — see POST /v1/links in mcp-tools.ts. */
const LINKABLE: readonly ProductType[] = ["topup", "esim"];

function payLinkSkill(f: PageFacts): Skill {
  return {
    id: "create-pay-link",
    name: "Create a checkout link for a human",
    description:
      `For an agent that holds no wallet, or when the principal should approve the spend themselves: POST ${f.base}/v1/links returns a URL the human opens, where they see the exact price and sign it in their own Pera wallet. The key never leaves their wallet and the agent never holds one. The deliverable (an eSIM's activation QR, a top-up confirmation) appears on the same page.`,
    tags: ["checkout", "human-in-the-loop", "pay-link", "wallet", "algorand"],
    examples: [
      "I have no wallet — give my user a link to pay for this eSIM themselves",
      "Send my family a 'top up my phone' link they can pay",
    ],
  };
}

/**
 * The card. `products` gates the catalogue skills exactly as it gates every other
 * sentence this service publishes about what it sells.
 */
export function agentCard(f: PageFacts): Record<string, unknown> {
  const products = f.products ?? (["topup", "esim", "bill", "payout"] as const);
  const skills: Skill[] = [
    ...products.map((t) => PRODUCT_SKILLS[t]).filter(Boolean),
    ...(products.some((t) => LINKABLE.includes(t)) ? [payLinkSkill(f)] : []),
    ...alwaysOnSkills(f),
  ];

  return {
    protocolVersion: PROTOCOL_VERSION,
    name: f.brand,
    description:
      `Real-world checkout for AI agents. Buys physical-world goods and services for an agent's principal in 150+ countries — currently ${skillSummary(products)} — paid per order in USDC on Algorand (${f.network}) over x402. No account, no API key, no card. Money settles on-chain before anything is bought; a failed delivery is refunded to the paying address on-chain automatically; every terminal order carries an ed25519-signed receipt naming both transaction ids, and the full order ledger is public.`,
    // No `url` and no `preferredTransport` — see the header note. The interface a caller
    // should actually use is documented, in prose, at documentationUrl.
    provider: { organization: "IoMarkets", url: f.site },
    version: SERVICE_VERSION,
    documentationUrl: `${f.base}/agent.md`,
    iconUrl: `${f.base}/brand/logo.webp`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      // Payment is not an auth scheme, so it does not belong in securitySchemes — a
      // caller needs no credential, it needs USDC. Declared as an extension so a router
      // can filter on "can my agent pay for this" before it ever calls.
      extensions: [
        {
          uri: "https://x402.org",
          description:
            "Ordering is paid per request over x402: POST /v1/orders answers 402 with the exact USDC amount from a quote, and the order is created only once the facilitator settles it on-chain.",
          required: true,
          params: {
            network: f.network,
            asset: "USDC",
            chain: "algorand",
            payTo: f.payTo ?? null,
            // Free routes are the whole funnel; only ordering costs anything.
            paidRoutes: [`${f.base}/v1/orders`],
            pricing: "per-order, quoted exactly and locked for 10 minutes",
            limits: `${f.base}/v1/limits`,
            fundingGuide: `${f.base}/fund`,
          },
        },
      ],
    },
    // Nothing here is behind a credential. Everything is behind a payment.
    securitySchemes: {},
    security: [],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills,
  };
}

/** "travel eSIMs, mobile top-ups and international payments" — for the description. */
function skillSummary(products: readonly ProductType[]): string {
  const phrase: Record<ProductType, string> = {
    esim: "travel eSIMs",
    topup: "mobile airtime and data top-ups",
    bill: "prepaid bills",
    payout: "international payments",
  };
  const parts = products.map((t) => phrase[t]).filter(Boolean);
  if (parts.length === 0) return "nothing — no supplier is wired right now";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
