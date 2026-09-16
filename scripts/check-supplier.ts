// What currency is the configured supplier account actually denominated in?
//
//   pnpm check-supplier            # the goods supplier named by SUPPLIER
//   pnpm check-supplier NG         # …and sample that country's operators/offers
//
// Read-only: it authenticates, reads the account balance and a few offers, and buys
// nothing. Exits non-zero if the account is not denominated in USD.
//
// This exists because it is the failure that cost us a week. We settle in USDC and
// price everything in micro-USD; a supplier wallet denominated in anything else puts
// an FX leg on every order, and neither adapter will learn FX (docs/SUPPLIERS.md).
// Zendit's sandbox authenticated perfectly and every field name was right — the
// account was simply in GBP, which only `/balance` reveals. Ask this question of every
// supplier, in every environment, BEFORE wiring anything downstream of it.

import { config } from "../src/config.js";

const country = (process.argv[2] ?? "NG").toUpperCase();
const M = 1_000_000;

type Report = {
  supplier: string; environment: string; currency: string | null; balance: string; detail: unknown;
  /** Reloadly only: how close the balance is to being forfeited for inactivity. */
  dormancy?: Dormancy;
};

/**
 * Reloadly's Corporate Client Terms of Service, read 2026-09-01:
 *
 *   "If a client's account remains inactive for a period of more than 180 consecutive
 *    days, and has a remaining balance, the balance will be forfeited and reflecting $0"
 *
 * A balance is also slow to recall deliberately — a 14-business-day email procedure
 * paying out to a corporate bank account — so the forfeiture clause is the cheapest
 * way to lose the float, and the one nobody would notice happening. A calendar entry
 * is the wrong home for it: this project has gone quiet for a week at a time and the
 * clock runs while it does. So the script that already reads the balance reports the
 * clock next to it, and anyone who runs it once a month cannot miss it.
 */
const DORMANCY_DAYS = 180;

interface Dormancy { lastActivity: string | null; daysIdle: number | null; daysLeft: number | null; forfeitOn: string | null }

/** Newest transaction date in a Reloadly report page, however the page names it. */
function newestTransactionDate(page: unknown): string | null {
  const rows = (page as { content?: unknown[] })?.content ?? (Array.isArray(page) ? page : []);
  const times = (rows as Array<Record<string, unknown>>)
    .map((r) => r.transactionDate ?? r.date ?? r.createdAt)
    .filter((v): v is string => typeof v === "string")
    // Reloadly returns "2026-08-29 11:02:41"; make it unambiguous before parsing.
    .map((v) => Date.parse(v.includes("T") ? v : `${v.replace(" ", "T")}Z`))
    .filter((n) => Number.isFinite(n));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function dormancyFrom(lastActivity: string | null): Dormancy {
  if (!lastActivity) return { lastActivity: null, daysIdle: null, daysLeft: null, forfeitOn: null };
  const daysIdle = Math.floor((Date.now() - Date.parse(lastActivity)) / 86_400_000);
  const forfeit = new Date(Date.parse(lastActivity) + DORMANCY_DAYS * 86_400_000);
  return { lastActivity, daysIdle, daysLeft: DORMANCY_DAYS - daysIdle, forfeitOn: forfeit.toISOString().slice(0, 10) };
}

/** Reloadly issues credentials PER PRODUCT — Airtime, Gift Cards and Utilities are
 *  separate applications, each with its own client id and secret — and the `audience`
 *  selects both the product and the environment. Asking for one your credentials do not
 *  cover answers "Access Denied", which reads exactly like a wrong secret. Only the
 *  airtime audiences are usable here; the rest are probed solely to tell those two
 *  failures apart. */
const RELOADLY_AUDIENCES = [
  { url: "https://topups-sandbox.reloadly.com", product: "Airtime", env: "sandbox", usable: true },
  { url: "https://topups.reloadly.com", product: "Airtime", env: "production", usable: true },
  { url: "https://giftcards-sandbox.reloadly.com", product: "Gift Cards", env: "sandbox", usable: false },
  { url: "https://giftcards.reloadly.com", product: "Gift Cards", env: "production", usable: false },
  { url: "https://utilities-sandbox.reloadly.com", product: "Utilities", env: "sandbox", usable: false },
  { url: "https://utilities.reloadly.com", product: "Utilities", env: "production", usable: false },
];

async function reloadlyToken(clientId: string, clientSecret: string, audience: string): Promise<{ token?: string; error?: string }> {
  type TokenBody = { access_token?: string; message?: string; error?: string };
  const r: TokenBody = await fetch("https://auth.reloadly.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", audience }),
  }).then((res) => res.json() as Promise<TokenBody>).catch((e: unknown) => ({ message: (e as Error).message }));
  return r.access_token ? { token: r.access_token } : { error: r.message ?? r.error ?? JSON.stringify(r) };
}

/** Which audiences these credentials actually open, so a product mismatch is not
 *  mistaken for a bad secret. Never prints the credentials themselves. */
async function reloadlyDiagnose(clientId: string, clientSecret: string): Promise<never> {
  const lines: string[] = [];
  const opened: typeof RELOADLY_AUDIENCES = [];
  for (const a of RELOADLY_AUDIENCES) {
    const r = await reloadlyToken(clientId, clientSecret, a.url);
    if (r.token) opened.push(a);
    lines.push(`  ${r.token ? "✅" : "❌"} ${a.product.padEnd(10)} ${a.env.padEnd(10)} ${a.url}${r.token ? "" : `  — ${r.error}`}`);
  }
  const shape = `client id: ${clientId.length} chars${/^\s|\s$/.test(clientId) ? " ⚠️ HAS LEADING/TRAILING WHITESPACE" : ""} · secret: ${clientSecret.length} chars${/^\s|\s$/.test(clientSecret) ? " ⚠️ HAS LEADING/TRAILING WHITESPACE" : ""}`;

  // Read the SHAPE of the failure, not just whether anything opened. Reloadly's
  // credentials are per environment first and per product second, so "every production
  // audience opens, every sandbox one is denied" means live keys — a different problem
  // from "one product opens", and the two need opposite fixes.
  const envs = new Set(opened.map((a) => a.env));
  const liveOnly = opened.length > 0 && envs.size === 1 && envs.has("production");
  const sandboxOnly = opened.length > 0 && envs.size === 1 && envs.has("sandbox");
  const airtime = opened.some((a) => a.usable);

  let advice: string;
  if (liveOnly) {
    advice =
      `  These are LIVE credentials — every production audience opened and every sandbox one\n` +
      `  was denied. Reloadly issues SEPARATE sandbox credentials; the same pair does not\n` +
      `  work in both. Either set RELOADLY_SANDBOX=false to use these (⚠️  real money: every\n` +
      `  purchase is a real top-up against a real float), or create sandbox keys in the\n` +
      `  dashboard for end-to-end testing. Production access has clearly been granted.`;
  } else if (sandboxOnly) {
    advice =
      `  These are SANDBOX credentials and RELOADLY_SANDBOX is false. Set RELOADLY_SANDBOX=true,\n` +
      `  or use the live pair once production access is granted.`;
  } else if (opened.length && !airtime) {
    advice =
      `  These credentials belong to a different Reloadly product. Airtime is what this\n` +
      `  service sells — open the Airtime application in the dashboard and use ITS pair.`;
  } else {
    advice =
      `  No audience accepted them, so this is the credentials themselves rather than the\n` +
      `  environment or the product: re-copy both from the dashboard (a truncated secret is\n` +
      `  the usual cause), or confirm the account is activated.`;
  }
  throw new Error(`Reloadly rejected these credentials for airtime ${config.supplier.reloadly.sandbox ? "sandbox" : "production"}.\n\n${lines.join("\n")}\n\n  ${shape}\n\n${advice}`);
}

async function reloadly(): Promise<Report> {
  const { clientId, clientSecret, sandbox } = config.supplier.reloadly;
  if (!clientId || !clientSecret) throw new Error("RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET (or _FILE) are not set");
  const audience = sandbox ? "https://topups-sandbox.reloadly.com" : "https://topups.reloadly.com";
  const auth = await reloadlyToken(clientId, clientSecret, audience).then((r) => ({ access_token: r.token }));
  if (!auth.access_token) await reloadlyDiagnose(clientId, clientSecret);

  const get = (path: string) => fetch(`${audience}${path}`, {
    headers: { Authorization: `Bearer ${auth.access_token!}`, Accept: "application/com.reloadly.topups-v1+json" },
  }).then((r) => r.json() as Promise<any>);

  const balance = await get("/accounts/balance");
  const ops = await get(`/operators/countries/${country}?includeBundles=true&includeData=true&suggestedAmountsMap=false`);
  const sample = (Array.isArray(ops) ? ops : []).slice(0, 5).map((o: any) => ({
    id: o.id, name: o.name, sender: o.senderCurrencyCode, destination: o.destinationCurrencyCode, denomination: o.denominationType,
  }));
  // An operator's senderCurrencyCode is what we would actually be charged in, and the
  // adapter refuses anything but USD. It can differ from the wallet currency, so check both.
  const senders = [...new Set(sample.map((s) => s.sender).filter(Boolean))];

  // Best-effort: an unreadable report must not fail a currency check. A null clock is
  // reported as unknown rather than as safe — see the printout in main().
  const lastActivity = await get("/topups/reports/transactions?page=0&size=50")
    .then(newestTransactionDate)
    .catch(() => null);

  return {
    supplier: "reloadly",
    environment: sandbox ? "sandbox" : "production",
    currency: balance?.currencyCode ?? null,
    balance: balance?.balance === undefined ? "unknown" : `${balance.balance} ${balance.currencyCode ?? "?"}`,
    detail: { operator_sender_currencies: senders, sample },
    dormancy: dormancyFrom(lastActivity),
  };
}

async function zendit(): Promise<Report> {
  const { apiKey, baseUrl } = config.supplier.zendit;
  if (!apiKey) throw new Error("ZENDIT_API_KEY (or ZENDIT_API_KEY_FILE) is not set");
  const get = (path: string) => fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  }).then(async (r) => {
    const body = await r.text();
    if (!r.ok) throw new Error(`Zendit GET ${path} → ${r.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body) as any;
  });

  const balance = await get("/balance");
  const offers = await get(`/topups/offers?_limit=5&_offset=0&country=${country}`);
  const sample = (offers?.list ?? []).slice(0, 5).map((o: any) => ({
    id: o.offerId, brand: o.brandName, cost: o.cost?.currency, send: o.send?.currency, priceType: o.priceType,
  }));
  const costs = [...new Set(sample.map((s: any) => s.cost).filter(Boolean))];
  return {
    supplier: "zendit",
    environment: baseUrl.includes("test-api") ? "sandbox" : "production",
    currency: balance?.currency ?? null,
    balance: balance?.availableBalance === undefined ? "unknown" : `${balance.availableBalance / (balance.currencyDivisor || 100)} ${balance.currency ?? "?"}`,
    detail: { offer_cost_currencies: costs, sample },
  };
}

async function main(): Promise<void> {
  const kind = config.supplier.kind;
  if (kind === "mock") {
    console.log("SUPPLIER=mock — nothing to check. Set SUPPLIER=zendit or SUPPLIER=reloadly first.");
    process.exit(0);
  }
  const report = kind === "reloadly" ? await reloadly() : await zendit();
  console.log(`\nsupplier    ${report.supplier} (${report.environment})`);
  console.log(`account     ${report.balance}`);
  console.log(`currency    ${report.currency ?? "unknown"}`);
  console.log(`sample      ${country}`);
  console.dir(report.detail, { depth: 4 });

  // ── the dormancy clock ────────────────────────────────────────────────────
  const d = report.dormancy;
  const hasBalance = !/^0(\.0+)?\s/.test(report.balance) && report.balance !== "unknown";
  if (d && hasBalance) {
    if (d.daysLeft === null) {
      console.warn(
        `\n⚠️  Could not read the last transaction date, so the ${DORMANCY_DAYS}-day dormancy clock is UNKNOWN.\n` +
        `   Reloadly forfeits the balance of an account inactive for more than ${DORMANCY_DAYS} consecutive days.\n` +
        `   Check the dashboard's transaction report by hand. docs/SUPPLIERS.md.`,
      );
    } else if (d.daysLeft <= 30) {
      console.error(
        `\n⛔ DORMANCY: ${d.daysIdle} days idle. The balance is FORFEITED on ${d.forfeitOn} (${d.daysLeft} days).\n` +
        `   One real transaction of any size resets the clock. Do it now, or recall the balance —\n` +
        `   recalling takes 14 business days plus settlement, so it does not fit inside 30.`,
      );
    } else {
      console.log(`\ndormancy    ${d.daysIdle}d idle · balance forfeited ${d.forfeitOn} unless used (${d.daysLeft}d left)`);
    }
  }

  const wrong = [report.currency, ...(((report.detail as any).operator_sender_currencies ?? (report.detail as any).offer_cost_currencies) as string[])]
    .filter((c): c is string => Boolean(c))
    .filter((c) => c.toUpperCase() !== "USD");
  if (wrong.length) {
    console.error(
      `\n⛔ NOT USD: ${[...new Set(wrong)].join(", ")}.\n` +
      `   We settle in USDC and price in micro-USD. Ask ${report.supplier} to re-denominate the account to USD\n` +
      `   in BOTH environments before wiring anything downstream. The adapter must not learn FX — docs/SUPPLIERS.md.`,
    );
    process.exit(1);
  }
  console.log(`\n✅ ${report.supplier} is denominated in USD. Safe to price against.`);
}

main().catch((e) => { console.error(`\n⛔ ${(e as Error).message}`); process.exit(1); });
