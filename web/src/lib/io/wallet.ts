/*
 * Pera wallet + the x402 payment flow.
 *
 * ── Why these are real imports and not CDN modules ───────────────────────────
 * This file previously loaded @perawallet/connect, @x402/core, @x402/avm and
 * algosdk from cdn.jsdelivr.net with dynamic import() at call time. That put a
 * third party in the trust path at the exact moment a person approves a USDC
 * transfer: whatever the CDN served — a hijacked publish, a compromised
 * maintainer account, a DNS answer — would run in this page with full authority
 * to rewrite the recipient address or the amount before it reached the wallet
 * for signing. Bundled dependencies are pinned by bun.lock, verified on install,
 * and covered by the 24h `minimumReleaseAge` guard in bunfig.toml.
 *
 * ── And why the old code could not have worked anyway ────────────────────────
 * Because the CDN module shapes were unknown at build time, it probed for
 * `createX402Client` / `createClient`, `createPayment` / `pay`,
 * `createExactAvmClient`, `encodePaymentHeader` / `encodePayment`. None of those
 * symbols exist in @x402 2.23. The real API is below, and it matches the
 * server-side client in ../../../../src/client/paying.ts, which has settled real
 * money on mainnet.
 */

import { PeraWalletConnect } from "@perawallet/connect";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import algosdk from "algosdk";

import { getClientConfig } from "./api";

/** Algorand mainnet chain id, as Pera names it. */
const PERA_MAINNET = 416001;
const PERA_TESTNET = 416002;

let pera: PeraWalletConnect | null = null;
let connectedAddress: string | null = null;

async function wallet(): Promise<PeraWalletConnect> {
  if (pera) return pera;
  const cfg = await getClientConfig();
  pera = new PeraWalletConnect({
    chainId: cfg.network === "mainnet" ? PERA_MAINNET : PERA_TESTNET,
  });
  return pera;
}

export async function connectWallet(): Promise<string> {
  const p = await wallet();

  // reconnectSession() resolves empty (not throws) when there is no session, but it
  // also throws on a stale/expired one — both mean "ask the user".
  let accounts: string[] = [];
  try {
    accounts = await p.reconnectSession();
  } catch {
    accounts = [];
  }
  if (!accounts.length) accounts = await p.connect();

  p.connector?.on("disconnect", () => {
    connectedAddress = null;
  });

  const addr = accounts[0] ?? null;
  if (!addr) throw new Error("No account returned by the wallet.");
  // A malformed address would otherwise surface as an opaque failure deep inside
  // transaction construction, after the person has already approved.
  if (!algosdk.isValidAddress(addr)) {
    throw new Error("The wallet returned an address Algorand does not recognise.");
  }
  connectedAddress = addr;
  return addr;
}

export async function disconnectWallet() {
  try {
    await pera?.disconnect();
  } catch {
    /* a disconnect that fails still means "forget this session" locally */
  }
  connectedAddress = null;
}

export function currentAddress() {
  return connectedAddress;
}

/**
 * ClientAvmSigner over Pera.
 *
 * Pera returns ONLY the transactions it was asked to sign, in order, so the
 * unsigned slots have to be restored as nulls or the group is misaligned and the
 * network rejects it.
 */
function makeSigner(address: string) {
  return {
    address,
    async signTransactions(
      txns: Uint8Array[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> {
      const p = await wallet();
      const idx = new Set(indexesToSign ?? txns.map((_, i) => i));

      const group = txns.map((t, i) => {
        const txn = algosdk.decodeUnsignedTransaction(t);
        // `signers: []` is how Pera is told "include this in the group for context,
        // but do not sign it" — used for the facilitator's fee-payer transaction.
        return idx.has(i) ? { txn } : { txn, signers: [] };
      });

      const signed = await p.signTransaction([group]);

      const out: (Uint8Array | null)[] = txns.map(() => null);
      let cursor = 0;
      for (let i = 0; i < txns.length; i++) {
        if (idx.has(i)) out[i] = signed[cursor++] ?? null;
      }
      return out;
    },
  };
}

/** Read a human-readable error out of a JSON body, falling back to `fallback`. */
async function errorFrom(res: Response, fallback: string): Promise<string> {
  try {
    const b = (await res.json()) as { error?: string };
    if (typeof b?.error === "string" && b.error) return b.error;
  } catch {
    /* not json */
  }
  return fallback;
}

/**
 * Create one order through the x402 flow: POST → 402 + requirements → sign → retry
 * with the signature header.
 *
 * `quotedUsdc` is the price this row was quoted, reviewed and approved at — the
 * number the operator actually looked at in step 2 — and it becomes the SDK's
 * per-payment ceiling. Two things follow from that:
 *
 *  1. It must be SET. `spendControls.maxAmountPerPayment` DEFAULTS TO $1, and
 *     `x402Client.fromConfig` accepts that default silently, then rejects every
 *     larger payment from inside createPaymentPayload — after the 402 — with an
 *     error naming the SDK's cap rather than ours. src/client/paying.ts learnt this
 *     on a $15.31 top-up.
 *  2. Deriving it from the QUOTE rather than from an account ceiling is the tighter
 *     control. A category ceiling would authorise anything up to $50 (orders) or
 *     $200 (payouts); this authorises exactly the payment that was approved. If the
 *     402 comes back asking for more than was quoted — a bug, a re-price, a
 *     tampered response — it is refused here, before the wallet is ever opened.
 */
export async function payAndCreateOrder(
  quoteId: string,
  address: string,
  quotedUsdc: number,
): Promise<string> {
  if (!Number.isFinite(quotedUsdc) || quotedUsdc <= 0) {
    throw new Error("This row has no locked price. Re-price the batch before paying.");
  }
  const first = await fetch("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ quoteId }),
  });

  // A quote that needs no payment (or was already paid) comes back 2xx.
  if (first.ok) {
    const data = (await first.json()) as { orderId: string };
    return data.orderId;
  }
  if (first.status !== 402) {
    throw new Error(await errorFrom(first, `Payment could not be started (${first.status}).`));
  }

  const cfg = await getClientConfig();
  const signer = makeSigner(address);

  const core = x402Client.fromConfig({
    schemes: [
      {
        network: cfg.caip2,
        client: new ExactAvmScheme(signer, { algodUrl: cfg.algod_url }),
      },
    ],
    spendControls: { maxAmountPerPayment: `$${quotedUsdc.toFixed(6)}` },
  });
  const http = new x402HTTPClient(core);

  const required = http.getPaymentRequiredResponse(
    (n) => first.headers.get(n),
    await first
      .clone()
      .json()
      .catch(() => undefined),
  );

  // Everything from here is the wallet's own UI. A rejection in Pera throws, and the
  // caller turns it into a per-row failure rather than losing the batch.
  const payload = await http.createPaymentPayload(required);

  const retry = await fetch("/v1/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...http.encodePaymentSignatureHeader(payload),
    },
    body: JSON.stringify({ quoteId }),
  });
  if (!retry.ok) {
    throw new Error(await errorFrom(retry, `Payment was declined (${retry.status}).`));
  }
  const data = (await retry.json()) as { orderId: string };
  return data.orderId;
}
