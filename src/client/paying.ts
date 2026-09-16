// A fetch that pays. On 402 it reads the requirements, signs an Algorand USDC
// payment with the agent's key, retries with the signature header. Carries a
// budget so an agent can never overspend by accident.

import algosdk from "algosdk";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";

export class BudgetExceededError extends Error {
  readonly name = "BudgetExceededError";
}

export interface PayingFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
  spentMicroUsdc(): bigint;
}

export interface PayingFetchOptions {
  algodUrl: string;
  /** Hard ceiling on cumulative settled spend, micro-USDC. */
  capMicroUsdc: bigint;
  /** Refuse any single payment above this, micro-USDC. */
  maxPerCallMicroUsdc?: bigint;
}

export function makePayingFetch(account: algosdk.Account, opts: PayingFetchOptions): PayingFetch {
  const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));

  // The SDK carries its OWN per-payment ceiling, `spendControls.maxAmountPerPayment`,
  // which defaults to **$1** — and `new x402Client()` accepts that default silently.
  // Our caller's budget then means nothing: every payment over $1 is rejected inside
  // createPaymentPayload, after the 402 has been fetched, with an error that names the
  // SDK's cap and not ours. Found the hard way on the first real order (a $15.31
  // top-up, budget $25). So the client is built from config, and OUR per-call limit is
  // what the SDK enforces — one number, not two disagreeing ones.
  const perCall = opts.maxPerCallMicroUsdc ?? opts.capMicroUsdc;
  const core = x402Client.fromConfig({
    schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer, { algodUrl: opts.algodUrl }) }],
    // A string `$n` is a USD cap on the assets the SDK recognises, which includes USDC.
    spendControls: { maxAmountPerPayment: `$${(Number(perCall) / 1e6).toFixed(6)}` },
  });

  let spent = 0n;
  let refusal: string | undefined;
  if (opts.maxPerCallMicroUsdc !== undefined) {
    const cap = opts.maxPerCallMicroUsdc;
    // Kept as well as the spend control: this one is denominated in the asset's own
    // atomic units, so it holds even if the SDK's USD conversion ever disagrees.
    core.registerPolicy((_v, reqs) => reqs.filter((r) => BigInt(r.amount) <= cap));
  }
  core.onBeforePaymentCreation(async (ctx) => {
    const price = BigInt(ctx.selectedRequirements.amount);
    if (spent + price > opts.capMicroUsdc) {
      refusal = `budget cap: ${price} would exceed ${opts.capMicroUsdc} (spent ${spent})`;
      return { abort: true, reason: refusal };
    }
    return;
  });
  const http = new x402HTTPClient(core);

  const payingFetch = (async (input: string | URL, init?: RequestInit) => {
    const first = await fetch(input, init);
    if (first.status !== 402) return first;
    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
    let payload;
    try {
      refusal = undefined;
      payload = await http.createPaymentPayload(required);
    } catch (e) {
      if (refusal) throw new BudgetExceededError(refusal);
      if (opts.maxPerCallMicroUsdc !== undefined && !required.accepts?.some((r) => BigInt(r.amount) <= opts.maxPerCallMicroUsdc!)) {
        throw new BudgetExceededError(`every offer exceeds the per-call limit of ${opts.maxPerCallMicroUsdc}`);
      }
      throw e;
    }
    const res = await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> ?? {}), ...http.encodePaymentSignatureHeader(payload) } });
    const authorized = (payload as { accepted?: { amount?: string } }).accepted?.amount;
    if (authorized && res.headers.get("PAYMENT-RESPONSE")) {
      try {
        const settle = http.getPaymentSettleResponse((n) => res.headers.get(n));
        if (settle?.success) spent += BigInt(authorized);
      } catch { /* unreadable settle header — don't guess */ }
    }
    return res;
  }) as PayingFetch;
  payingFetch.spentMicroUsdc = () => spent;
  return payingFetch;
}
