// Central config. Every knob is an env var; nothing secret is ever defaulted.
import "dotenv/config";
import { loadSecret } from "./keys.js";
import { blockedCountryList } from "./sanctions.js";

const opt = (name: string, fallback: string): string => process.env[name] ?? fallback;
const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
};

/**
 * `"giftcard=25,bill=150"` → `{ giftcard: 25, bill: 150 }`.
 *
 * Throws rather than skipping a malformed entry. A ceiling that silently fails to
 * parse is a ceiling that silently is not there, and this one exists to hold back the
 * riskiest product in the catalogue — a config typo must stop the process at boot,
 * where preflight sees it, not go quiet in production.
 */
export function parseTypeMax(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [type, value] = part.split("=").map((s) => s.trim());
    const n = Number(value);
    if (!type || !value || !Number.isFinite(n) || n <= 0) {
      throw new Error(`env TYPE_MAX_USD: "${part}" is not <type>=<positive number>`);
    }
    out[type] = n;
  }
  return out;
}

/**
 * `MARKUP_BPS_BY_TYPE="esim=700,payout=300"` → per-type markup overriding MARKUP_BPS.
 *
 * Same grammar as TYPE_MAX_USD deliberately — one env format for per-type settings is
 * one thing to remember. Validated here rather than at first quote: a typo in a pricing
 * env var must stop the process, not silently sell at the wrong margin for a week.
 */
export function parseMarkupByType(raw: string): Record<string, number> {
  const types = new Set(["topup", "esim", "bill", "payout"]);
  const out: Record<string, number> = {};
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [type, value] = part.split("=").map((s) => s.trim());
    const n = Number(value);
    if (!type || !value || !Number.isInteger(n) || n < 0 || n > 10_000) {
      throw new Error(`env MARKUP_BPS_BY_TYPE: "${part}" is not <type>=<0-10000 bps>`);
    }
    if (!types.has(type)) throw new Error(`env MARKUP_BPS_BY_TYPE: "${type}" is not one of ${[...types].join(", ")}`);
    out[type] = n;
  }
  return out;
}

/**
 * A supplier credential, read on FIRST USE rather than at import.
 *
 * `loadSecret` is deliberately fatal when a `_FILE` path is configured and missing —
 * a refund key that silently resolves to empty would disable refunds in production
 * with no signal, and that must stay fatal. But this module is imported by everything,
 * and every supplier's secret was being resolved eagerly, so a **dangling path for a
 * supplier that is not even selected** took down the whole process.
 *
 * Hit on 2026-09-01: `ZENDIT_API_KEY_FILE` was pointed at a file before that file
 * existed, and the entire test suite stopped loading — with `SUPPLIER=reloadly`, on a
 * credential nothing was going to read. The fatality was right and its timing was
 * wrong.
 *
 * So each is a getter: the same error, raised by the code that actually needs the
 * credential, naming the supplier being configured. Cached because these are read on
 * every request path and the warning should be printed once.
 */
const secretCache = new Map<string, string>();
function secret(name: string): string {
  const hit = secretCache.get(name);
  if (hit !== undefined) return hit;
  const v = loadSecret(name, { warn: (m) => console.warn(m) });
  secretCache.set(name, v);
  return v;
}

export const NETWORK = opt("NETWORK", "testnet") as "testnet" | "mainnet";
export const IS_MAINNET = NETWORK === "mainnet";

const rawBase = opt("PUBLIC_BASE_URL", "").replace(/\/$/, "");
const publicBaseUrl = /^https?:\/\/[^/]+/.test(rawBase) ? rawBase : "";

export type SupplierKind = "mock" | "zendit" | "reloadly";

export const config = {
  network: NETWORK,
  port: num("PORT", 3000),
  publicBaseUrl,
  apiPrefix: "/v1",
  brand: {
    name: opt("BRAND_NAME", "IoMarkets Topup"),
    // The site name Google prints in the grey line above a result. Deliberately
    // NOT `name`: that is the product ("IoMarkets Topup") and belongs in the
    // <title>. Google wants the property's own name, and it printed the bare
    // lowercase domain while this site declared nothing at all.
    siteName: opt("BRAND_SITE_NAME", "IoMarkets.app"),
    site: opt("BRAND_SITE", "https://iomarkets.app"),
    supportEmail: opt("SUPPORT_EMAIL", ""),
  },

  // x402 settlement — Algorand USDC via the GoPlausible facilitator (serves both
  // mainnet and testnet; the route's CAIP-2 id picks the network).
  payTo: opt("PAY_TO", ""),
  facilitatorUrl: opt("FACILITATOR_URL", "https://facilitator.goplausible.xyz"),
  algodUrl: IS_MAINNET
    ? opt("ALGOD_MAINNET_URL", "https://mainnet-api.algonode.cloud")
    : opt("ALGOD_TESTNET_URL", "https://testnet-api.algonode.cloud"),
  indexerUrl: IS_MAINNET
    ? opt("INDEXER_MAINNET_URL", "https://mainnet-idx.algonode.cloud")
    : opt("INDEXER_TESTNET_URL", "https://testnet-idx.algonode.cloud"),
  usdcAsa: IS_MAINNET ? 31566704 : 10458941,

  // ed25519 keypair that signs delivery / refund receipts. Publish the public key.
  receipt: {
    privateKey: opt("RECEIPT_PRIVATE_KEY", ""),
    publicKey: opt("RECEIPT_PUBLIC_KEY", ""),
  },

  // Supplier credentials buy real goods against our float, so they get the same
  // handling as the refund key: *_FILE (0400, root-owned) or a systemd credential in
  // production, and a warning when read from a bare env var. loadSecret falls back to
  // the plain variable, so nothing that worked before stops working.
  supplier: {
    kind: opt("SUPPLIER", "mock") as SupplierKind,
    zendit: {
      /** Lazy — see the note on `secret()` below. */
      get apiKey() { return secret("ZENDIT_API_KEY"); },
      // test-api.zendit.io while onboarding; api.zendit.io in production.
      baseUrl: opt("ZENDIT_BASE_URL", "https://test-api.zendit.io/v1").replace(/\/$/, ""),
    },
    reloadly: {
      clientId: opt("RELOADLY_CLIENT_ID", ""),
      get clientSecret() { return secret("RELOADLY_CLIENT_SECRET"); },
      sandbox: opt("RELOADLY_SANDBOX", "true") !== "false",
    },
  },

  // International payments (payout) partner: "" = disabled, "mock" = demo corridors,
  // anything else = a licensed partner id (kotani | yellowcard | bitnob …) — docs/PAYOUTS.md.
  payout: {
    kind: opt("PAYOUT_SUPPLIER", ""),
    /** Partners that authenticate with an id + secret pair (Bitnob signs each request). */
    clientId: opt("PAYOUT_CLIENT_ID", ""),
    // The partner secret is a live money-moving credential: same handling as the refund
    // key, so PAYOUT_API_KEY_FILE / a systemd credential works and bare env warns.
    get apiKey() { return secret("PAYOUT_API_KEY"); },
    baseUrl: opt("PAYOUT_BASE_URL", "").replace(/\/$/, ""),
    /** Stablecoin the partner float is held in and payouts are debited from. */
    asset: opt("PAYOUT_ASSET", "USDC"),
    /** Optional webhook the partner calls on completion. We poll regardless. */
    callbackUrl: opt("PAYOUT_CALLBACK_URL", ""),
    /** Refuse a partner quote delivering this much less local currency than the offer promised. */
    maxSlippageBps: num("PAYOUT_MAX_SLIPPAGE_BPS", 200),
    maxUsd: num("PAYOUT_MAX_USD", 200),
    /** above this per-payer daily total, payouts require a partner KYC reference */
    kycAboveUsd: num("PAYOUT_KYC_ABOVE_USD", 100),
    /** Ceiling on what one RECIPIENT may be sent per UTC day, across every payer.
     *  A payer address is free to create, so a per-payer counter resets with a new
     *  wallet; the beneficiary does not change when the sender rotates. */
    recipientDailyUsd: num("PAYOUT_RECIPIENT_DAILY_USD", 500),
  },

  // Sale price = supplier cost × (1 + markup) + fixed fee, rounded UP to the cent.
  pricing: {
    markupBps: num("MARKUP_BPS", 400), // 4 %
    /** Per-type overrides: `MARKUP_BPS_BY_TYPE="esim=700"`. 400 bps was set when airtime
     *  was the only product and a buyer could price it against the operator's own app in
     *  seconds; an eSIM has no face value to compare against and carries an $8-30 ticket.
     *  Empty means one markup for everything, which is what shipped. See pricingFor(). */
    markupBpsByType: parseMarkupByType(opt("MARKUP_BPS_BY_TYPE", "")),
    fixedFeeUsd: num("FIXED_FEE_USD", 0.05),
    minOrderUsd: num("MIN_ORDER_USD", 0.5),
    /** How far MIN_ORDER_USD may inflate a price before the offer is unsellable.
     *
     *  ⚠️ **This was documented as "one env var on the box" for two sessions and was not
     *  wired to anything** — `floorInflatesPrice()` read an optional field nothing set, so
     *  the default of 2 was the only value the service could ever have. Found 2026-09-02 by
     *  setting it in production and watching nothing change. A knob nobody can turn is worse
     *  than no knob, because the handover keeps offering it as a decision.
     *
     *  1 means every listed price comes from the markup and never from the floor. */
    maxFloorMultiple: num("MAX_FLOOR_MULTIPLE", 2),
    /** What a dollar of supplier float actually COSTS, in bps over face value —
     *  measured from a real deposit, not assumed. A $50 card deposit that lands as
     *  $47.75 of credit is 471 bps. Zero is the honest value only when the supplier
     *  is funded in the asset we already hold; preflight does the arithmetic and
     *  says whether MARKUP_BPS covers it. See docs/SUPPLIERS.md. */
    floatAcquisitionBps: num("FLOAT_ACQUISITION_BPS", 0),
  },

  /** Bill pay (`type: "bill"`). Empty hides the product; "reloadly" uses the Utilities
   *  API on the same credentials as airtime (a different OAuth audience).
   *
   *  Unset by default, and "reloadly" is additionally REFUSED at boot: Reloadly
   *  deprecated Utility Payments on 2026-09-01 and asked us to stop calling it.
   *  `ALLOW_DEPRECATED_BILL_SUPPLIER=1` is the acknowledgement, and exists so that
   *  re-enabling is a deliberate act by someone who has read why it was disabled —
   *  not a one-character env change. See src/suppliers/reloadly-utilities.ts. */
  bill: {
    kind: opt("BILL_SUPPLIER", "") as "" | "mock" | "reloadly",
    allowDeprecated: opt("ALLOW_DEPRECATED_BILL_SUPPLIER", "") === "1",
  },

  /** eSIMs (`type: "esim"`). Empty routes them to the goods supplier, which is what
   *  happened before this slot existed — and which sells none, because Reloadly has no
   *  eSIM product. All three real options price in USD.
   *
   *  "esimaccess" is the one to reach for: self-serve access code, no minimum order
   *  quantity, and the only eSIM API here with a client-supplied idempotency key, an
   *  order lookup AND a balance endpoint. "airalo" is a bigger catalogue behind a
   *  volume floor aimed at high-volume partners (
   *  2026-09-02) and publishes none of those three. "zendit" reuses SUPPLIER=zendit. */
  esim: {
    kind: opt("ESIM_SUPPLIER", "") as "" | "mock" | "zendit" | "airalo" | "esimaccess",
    airaloClientId: opt("AIRALO_CLIENT_ID", ""),
    get airaloClientSecret() { return secret("AIRALO_CLIENT_SECRET"); },
    /** The identifier, and the HMAC signing key too unless a secret key is set below.
     *  Either way a full credential. */
    get esimAccessCode() { return secret("ESIMACCESS_ACCESS_CODE"); },
    /** Optional. The vendor's published reference signs with the access code; their
     *  console also issues a secret key. Set this and it signs with that instead. */
    get esimAccessSecret() { return secret("ESIMACCESS_SECRET_KEY"); },
    esimAccessBaseUrl: opt("ESIMACCESS_BASE_URL", "https://api.esimaccess.com/api/v1/open"),
  },

  // Abuse / AML posture: small tickets, per-payer daily ceilings, no sanctioned
  // destinations. Tighten freely; loosen only with a KYC story.
  limits: {
    maxOrderUsd: num("MAX_ORDER_USD", 50),
    /** Per-product-type per-order caps: `TYPE_MAX_USD="giftcard=25,bill=150"`.
     *  A cap here binds the standard tier on top of MAX_ORDER_USD and can only lower
     *  it, never raise it. Only a KYB'd business account with a hand-set ceiling
     *  overrides one.
     *
     *  **Empty by default.** It shipped as `giftcard=25`, for a product dropped hours
     *  later on economics (docs/SUPPLIERS.md) — and publishing a ceiling on /v1/limits
     *  for a type we do not sell tells an agent we sell it. The mechanism stays because
     *  it is the right shape for any product whose risk differs from the catalogue
     *  average; it is waiting for the next one. See accounts.ts ceilingMicro. */
    typeMaxUsd: parseTypeMax(opt("TYPE_MAX_USD", "")),
    payerDailyUsd: num("PAYER_DAILY_USD", 200),
    quoteTtlSec: num("QUOTE_TTL_SEC", 600),
    freeRoutePerMinute: num("FREE_ROUTE_PER_MINUTE", 60),
    // ⛔ src/sanctions.ts is a floor this can only add to. Do not weaken it (see that file).
    blockedCountries: blockedCountryList(opt("BLOCKED_COUNTRIES", "")),
  },

  // Refund hot wallet: a SEPARATE account holding a small USDC float. Its spend
  // is capped per UTC day in code; keep the on-chain balance small too.
  refund: {
    // Never in .env in production — see src/keys.ts (file / systemd credential / KMS).
    mnemonic: loadSecret("REFUND_MNEMONIC", { warn: (m) => console.warn(m) }),
    dailyCapUsd: num("REFUND_DAILY_CAP_USD", 100),
  },

  /** Referral share (src/referrals.ts). Off at 0 — shipping the code moves no money. */
  referral: {
    /** Share of NET margin (price − cost − float acquisition), in bps. 2500 = a quarter. */
    shareBps: num("REFERRAL_SHARE_BPS", 0),
    minPayoutUsd: num("REFERRAL_MIN_PAYOUT_USD", 1),
    dailyCapUsd: num("REFERRAL_DAILY_CAP_USD", 25),
    /** The refund hot wallet is never taken below this by a referral payout. */
    refundReserveUsd: num("REFERRAL_REFUND_RESERVE_USD", 20),
  },

  fulfil: {
    pollIntervalMs: num("FULFIL_POLL_MS", 3000),
    timeoutMs: num("FULFIL_TIMEOUT_MS", 10 * 60 * 1000),
  },

  dbPath: opt("DB_PATH", "./data/iomarkets-app.db"),
} as const;
