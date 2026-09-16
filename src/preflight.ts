// Launch preflight — the checks that decide whether a deploy will take money
// correctly, run BEFORE the first payer arrives rather than discovered by them.
//
// Every failure mode here is silent in normal operation:
//   - PAY_TO not opted in to USDC  → the payer's transfer fails on chain, no order
//   - PUBLIC_BASE_URL http/unset   → the Bazaar lists an unreachable http:// resource
//                                    and every quote hands agents a localhost endpoint
//   - receipt keys disagree        → /v1/pubkey cannot verify the receipts we sign
//   - refund wallet unfunded       → refunds fail at exactly the moment they are needed
//
// The logic is pure and takes already-fetched chain state, so it is testable without
// a network; scripts/preflight.ts does the I/O and the printing.

import algosdk from "algosdk";
import { derivePublicKey } from "./receipt.js";
import { usd, type AccountRow } from "./accounts.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
}

const ok = (name: string, detail: string): CheckResult => ({ name, level: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, level: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, level: "fail", detail });

/** Shape of the bits of algod's account response the checks care about. */
export interface AccountState {
  amount: number | bigint;
  assets?: Array<{ assetId: number | bigint; amount: number | bigint }>;
}

/** Micro-ALGO a bare account needs before it can hold one ASA and pay a few fees. */
export const MIN_ALGO_MICRO = 200_000;

export function checkPayToFormat(payTo: string): CheckResult {
  const name = "PAY_TO format";
  if (!payTo) return fail(name, "unset — nothing can be paid to this service");
  if (!algosdk.isValidAddress(payTo)) return fail(name, `"${payTo.slice(0, 12)}…" is not a valid Algorand address`);
  return ok(name, payTo);
}

/**
 * The public origin is advertised to the Bazaar and baked into every quote's
 * `pay.endpoint`, so getting it wrong strands agents rather than erroring.
 */
export function checkPublicBaseUrl(raw: string, opts: { production: boolean }): CheckResult {
  const name = "PUBLIC_BASE_URL";
  if (!raw) {
    return opts.production
      ? fail(name, "unset — quotes would advertise http://127.0.0.1 and the Bazaar would list a dead resource")
      : warn(name, "unset — fine locally, required before deploying");
  }
  if (raw.endsWith("/")) return fail(name, `"${raw}" has a trailing slash; strip it or paths become "//v1/..."`);
  let u: URL;
  try { u = new URL(raw); } catch { return fail(name, `"${raw}" is not a URL`); }
  if (u.protocol !== "https:") {
    const isLocal = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (opts.production || !isLocal) return fail(name, `"${raw}" is not https — the Bazaar would list an http:// resource`);
    return warn(name, `${raw} (local dev only)`);
  }
  if (u.pathname !== "/") return fail(name, `"${raw}" must be a bare origin, with no path`);
  return ok(name, raw);
}

/** A published key that cannot verify our own signatures makes every receipt useless. */
export function checkReceiptKeys(privateKey: string, publicKey: string): CheckResult {
  const name = "receipt keypair";
  if (!privateKey) return fail(name, "RECEIPT_PRIVATE_KEY unset — run `pnpm gen-key`");
  let derived: string;
  try { derived = derivePublicKey(privateKey); } catch { return fail(name, "RECEIPT_PRIVATE_KEY is not a valid ed25519 key"); }
  if (!publicKey) return warn(name, `RECEIPT_PUBLIC_KEY unset; derived ${derived}`);
  if (publicKey.toLowerCase() !== derived.toLowerCase()) {
    return fail(name, `RECEIPT_PUBLIC_KEY does not match the private key (derived ${derived}) — published receipts would not verify`);
  }
  return ok(name, derived);
}

/**
 * An Algorand account must opt in to an ASA before it can receive it. PAY_TO not
 * being opted in is the classic way for a launch to take zero money while looking fine.
 */
export function checkAssetOptIn(
  label: string,
  address: string,
  state: AccountState | null,
  asa: number,
  opts: { needsAlgo?: boolean; minUsdcMicro?: number } = {},
): CheckResult {
  const name = `${label} opt-in`;
  if (!state) return fail(name, `${address} does not exist on chain (never funded)`);
  const holding = (state.assets ?? []).find((a) => Number(a.assetId) === asa);
  if (!holding) return fail(name, `${address} is not opted in to ASA ${asa} — run \`pnpm optin\`; transfers to it fail`);

  const algo = Number(state.amount);
  const usdc = Number(holding.amount);
  const parts = [`${(usdc / 1e6).toFixed(2)} USDC`, `${(algo / 1e6).toFixed(3)} ALGO`];
  if (opts.needsAlgo && algo < MIN_ALGO_MICRO) {
    return warn(name, `${parts.join(", ")} — under ${MIN_ALGO_MICRO / 1e6} ALGO, may not cover fees`);
  }
  if (opts.minUsdcMicro !== undefined && usdc < opts.minUsdcMicro) {
    return warn(name, `${parts.join(", ")} — under the ${(opts.minUsdcMicro / 1e6).toFixed(2)} USDC float this wallet is meant to hold`);
  }
  return ok(name, parts.join(", "));
}

/** The facilitator must actually settle our (network, asset, scheme) triple. */
export function checkFacilitatorSupport(
  supported: { kinds?: Array<{ scheme?: string; network?: string; asset?: string }> } | null,
  want: { network: string; asset: number },
): CheckResult {
  const name = "facilitator support";
  if (!supported?.kinds?.length) return warn(name, "could not read /supported — check the facilitator is up");
  const match = supported.kinds.find(
    (k) => k.scheme === "exact" && k.network === want.network && (k.asset === undefined || String(k.asset) === String(want.asset)),
  );
  return match
    ? ok(name, `exact/${want.network} asset ${want.asset}`)
    : fail(name, `facilitator does not list exact/${want.network} asset ${want.asset} — payments cannot settle`);
}

/** Refunds are the product's trust claim; without a key they become manual. */
export function checkRefunder(address: string | null, production: boolean): CheckResult {
  const name = "refund wallet";
  if (address) return ok(name, address);
  return production
    ? fail(name, "no refund key — a failed delivery would leave the payer out of pocket until someone refunds by hand")
    : warn(name, "not configured (fine locally; failed orders need manual refunds)");
}


/**
 * Does the markup actually cover what float costs to acquire?
 *
 * Supplier credit is not bought at face value. Measured 2026-08-29, a $50 Reloadly
 * deposit by debit card landed as $47.75 of credit — a 4.5 % processing fee, so a
 * dollar of credit cost $1.0471 against a `MARKUP_BPS` of 400. Sale price is
 * `cost × (1 + markup) + fixedFee`, so:
 *
 *   profit(cost) = fixedFee − cost × (acquisition − markup)
 *
 * When acquisition exceeds markup, the fixed fee carries small orders and every order
 * above the breakeven loses money — worse the bigger the ticket, on a leaderboard that
 * rewards volume. That is invisible in every per-order log: the order succeeds, the
 * receipt verifies, and the float just drains faster than the revenue arrives.
 *
 * `FLOAT_ACQUISITION_BPS` is what a deposit actually costs, measured, not assumed. It
 * defaults to 0 — the honest value for a supplier funded in the asset we already hold.
 * Set it from the last deposit and this check will do the arithmetic.
 */
export function checkPricingCoversFloat(
  pricing: {
    markupBps: number;
    fixedFeeUsd: number;
    floatAcquisitionBps: number;
    markupBpsByType?: Readonly<Record<string, number>>;
  },
  maxOrderUsd: number,
): CheckResult {
  const name = "pricing vs float cost";
  const { fixedFeeUsd, floatAcquisitionBps: acqBps } = pricing;
  // With per-type markups the question is answered by the WORST one: a 700 bps eSIM
  // markup does not make a 300 bps payout markup cover a 471 bps float. Report the
  // lowest, and name the type when it is not the global default.
  const [lowestType, markupBps] = Object.entries(pricing.markupBpsByType ?? {})
    .reduce<[string | null, number]>((low, [t, bps]) => (bps < low[1] ? [t, bps] : low), [null, pricing.markupBps]);
  const which = lowestType ? ` (lowest: ${lowestType})` : "";
  if (acqBps <= 0) return ok(name, `markup ${markupBps} bps${which} + $${fixedFeeUsd.toFixed(2)}; FLOAT_ACQUISITION_BPS unset (float assumed to cost face value)`);
  if (acqBps <= markupBps) return ok(name, `markup ${markupBps} bps${which} covers ${acqBps} bps of float acquisition`);

  // Below breakeven the fixed fee still carries the order; above it, we pay to sell.
  const gap = (acqBps - markupBps) / 10_000;
  const breakevenUsd = fixedFeeUsd / gap;
  const worstLossUsd = maxOrderUsd * gap - fixedFeeUsd;
  const detail =
    `markup ${markupBps} bps${which} does NOT cover ${acqBps} bps of float acquisition — ` +
    `every order above ~$${breakevenUsd.toFixed(2)} supplier cost loses money ` +
    `(up to $${worstLossUsd.toFixed(2)} at MAX_ORDER_USD=${maxOrderUsd}). ` +
    `Raise MARKUP_BPS to at least ${Math.ceil(((1 + acqBps / 10_000) * (1 + markupBps / 10_000) - 1) * 10_000)} to keep the same net margin, or fund the float more cheaply.`;
  // A warning, not a failure: selling at a loss is a bad business decision, not a
  // broken one, and it may be a deliberate one. It must not be a silent one.
  return warn(name, detail);
}


/**
 * A mock PAYOUT partner on a production box is worse than a mock goods supplier.
 *
 * Found live on mainnet 2026-08-29: `PAYOUT_SUPPLIER=mock` was inherited from the
 * example env, so `https://iomarkets.app/v1/catalog?type=payout&country=NG` publicly
 * advertised a Nigerian bank corridor backed by `MockSupplier`. An agent could have
 * paid real USDC for it, and `MockSupplier` reports delivery — so the order would have
 * settled on chain, reported `delivered`, and issued an ed25519-signed receipt
 * attesting that a stranger's bank account had been credited. Nothing would have been
 * sent, and there would have been no refund, because nothing failed.
 *
 * `SUPPLIER=mock` at least fails a top-up nobody received. This one signs a lie about
 * a payment to a third party, which is the single worst thing this codebase could do.
 * `PAYOUT_SUPPLIER=` (empty) hides the product; that is the correct value until a real
 * partner's credentials are in.
 */
export function checkPayoutSupplier(kind: string, production: boolean): CheckResult {
  const name = "payout partner";
  if (kind === "") return ok(name, "disabled (PAYOUT_SUPPLIER empty) — the payout product is hidden");
  if (kind !== "mock") return ok(name, kind);
  return production
    ? fail(name, "PAYOUT_SUPPLIER=mock on a production box would advertise REAL corridors that send NOTHING, and sign a receipt saying they were paid. Set PAYOUT_SUPPLIER= (empty) to hide payouts until a licensed partner is wired.")
    : warn(name, "mock — demo corridors only; never deploy this value");
}

export const worst = (results: CheckResult[]): CheckLevel =>
  results.some((r) => r.level === "fail") ? "fail" : results.some((r) => r.level === "warn") ? "warn" : "ok";

/**
 * A business account's ceiling is a promise the refund float has to keep. If an
 * account may spend more on one order than we can refund in a day, we will accept
 * an order we cannot make good on — and the automatic on-chain refund is the whole
 * trust claim. `pnpm account` refuses to write this without --force; this is the
 * check that catches the --force, and the one that catches a refund cap LOWERED
 * afterwards, which nothing else would notice.
 */
/**
 * The batch payout console (web/) is a build artefact, not config: `pnpm build:web`
 * produces web/dist/client and src/pay-console.ts serves it at /pay.
 *
 * This is a WARNING, not a failure, and the distinction is the point. Every other
 * check here guards a way of taking money incorrectly; a missing console cannot do
 * that — the API, the agent landing page and the plain /console all still work, and
 * /pay answers 503 saying what to run. It is a deploy defect, not a money defect.
 *
 * In the container it cannot happen: the Dockerfile builds it in its own stage, so a
 * failed build fails the image. It is the host-native path (deploy/install.sh, a
 * `git pull` + restart) where someone restarts the service without rebuilding and
 * only finds out when a customer opens the console.
 */
export function checkPayConsole(built: boolean): CheckResult {
  const name = "payout console";
  return built
    ? ok(name, "web/dist/client present — served at /pay")
    : warn(name, "web/dist/client is missing — /pay will answer 503. Run `pnpm build:web`. The API and /console are unaffected.");
}

export function checkAccountCeilings(accounts: AccountRow[], refundDailyCapMicro: number): CheckResult {
  const name = "business account ceilings";
  const active = accounts.filter((a) => a.status === "active");
  if (!active.length) return ok(name, "none — everyone is on the standard tier");
  const over = active.flatMap((a) => [
    ...(a.max_order_micro && a.max_order_micro > refundDailyCapMicro ? [`${a.id} per-order ${usd(a.max_order_micro)}`] : []),
    ...(a.payout_max_micro && a.payout_max_micro > refundDailyCapMicro ? [`${a.id} per-payout ${usd(a.payout_max_micro)}`] : []),
  ]);
  if (over.length) {
    return fail(name, `${over.join(", ")} exceeds the refund daily cap of ${usd(refundDailyCapMicro)} — a failure at that size cannot be refunded. Raise REFUND_DAILY_CAP_USD and the refund float, or lower the account.`);
  }
  // A daily ceiling above the cap needs several failures rather than one, so it warns
  // rather than fails — but it is caught here as well as in the CLI, because the cap
  // can be lowered after the account was written and nothing else would notice.
  const dailyOver = active.filter((a) => a.daily_micro && a.daily_micro > refundDailyCapMicro);
  if (dailyOver.length) {
    return warn(name, `${dailyOver.map((a) => `${a.id} daily ${usd(a.daily_micro!)}`).join(", ")} is above the refund daily cap of ${usd(refundDailyCapMicro)} — a bad supplier day leaves the orders past the cap unrefundable.`);
  }
  return ok(name, `${active.length} active, all within the ${usd(refundDailyCapMicro)} refund cap`);
}
