// Business accounts — onboard one counterparty and raise its ceilings.
//
//   pnpm account list
//   pnpm account add --name "Acme Ltd" --country GB --kyb BITNOB-KYB-1234 \
//                    --max-order 500 --max-payout 2000 --daily 10000
//   pnpm account bind acct_a1b2c3d4e5f6 XXXXXXXX…58-char-Algorand-address
//   pnpm account show acct_a1b2c3d4e5f6
//   pnpm account suspend acct_a1b2c3d4e5f6      # and: resume, unbind <address>
//
// There is deliberately NO HTTP admin surface. An account raises the amount of money
// one address may move; that decision is made on the box by someone with a shell, not
// behind a bearer token that can leak.
//
// The one refusal worth knowing about: a ceiling above REFUND_DAILY_CAP_USD is a
// promise the refund float cannot keep — we would accept an order we could not refund,
// and the automatic refund is this product's entire trust claim. `--force` exists for
// the case where the float is being raised in the same sitting, and it says so loudly.

import { config } from "../src/config.js";
import { Db } from "../src/db.js";
import { ACCOUNT_ID_RE, limitsFor, usd, type AccountRow } from "../src/accounts.js";
import { randomBytes } from "node:crypto";

const M = 1_000_000;
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "list";
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`--${name} needs a value`);
  return v;
}
const has = (name: string) => argv.includes(`--${name}`);
function die(msg: string): never { console.error(`✗ ${msg}`); process.exit(1); }
const money = (m: number | null) => (m === null ? "default" : usd(m));

const db = new Db(config.dbPath);
const defaults = {
  maxOrderMicro: config.limits.maxOrderUsd * M,
  payoutMaxMicro: config.payout.maxUsd * M,
  dailyMicro: config.limits.payerDailyUsd * M,
};

function print(a: AccountRow): void {
  const l = limitsFor(a, defaults);
  const payers = db.payersOf(a.id);
  console.log(`\n${a.id}  ${a.name}  (${a.country})  ${a.status === "active" ? "active" : "⛔ SUSPENDED"}`);
  console.log(`  KYB reference   ${a.kyb_reference}`);
  console.log(`  per order       ${money(a.max_order_micro)}   → effective ${usd(l.maxOrderMicro)}`);
  console.log(`  per payout      ${money(a.payout_max_micro)}   → effective ${usd(l.payoutMaxMicro)}`);
  console.log(`  per UTC day     ${money(a.daily_micro)}   → effective ${usd(l.dailyMicro)}`);
  console.log(`  spent today     ${usd(db.accountSpentTodayMicro(a.id))}`);
  console.log(`  addresses       ${payers.length ? payers.join("\n                  ") : "(none bound — the account cannot pay yet)"}`);
  if (a.notes) console.log(`  notes           ${a.notes}`);
}

/** A ceiling the refund float cannot stand behind is a promise we cannot keep. */
function checkAgainstRefundFloat(label: string, micro: number): void {
  const cap = config.refund.dailyCapUsd * M;
  if (micro <= cap) return;
  const msg = `${label} of ${usd(micro)} exceeds REFUND_DAILY_CAP_USD (${usd(cap)}) — a failed order at that size could not be refunded`;
  if (!has("force")) die(`${msg}.\n  Raise the refund float and REFUND_DAILY_CAP_USD first, or pass --force if you are doing that in this same sitting.`);
  console.warn(`⚠️  ${msg}. Proceeding because --force was given. Raise the float TODAY.`);
}

switch (cmd) {
  case "list": {
    const all = db.listAccounts();
    if (!all.length) {
      console.log("No business accounts. Everyone is on the standard tier:");
      console.log(`  per order ${usd(defaults.maxOrderMicro)} · per payout ${usd(defaults.payoutMaxMicro)} · per payer per UTC day ${usd(defaults.dailyMicro)}`);
      break;
    }
    all.forEach(print);
    console.log();
    break;
  }

  case "add": {
    const name = flag("name") ?? die("--name is required");
    const country = (flag("country") ?? die("--country is required (ISO-3166 alpha-2)")).toUpperCase();
    const kyb = flag("kyb") ?? die("--kyb is required — the KYB record this tier rests on. An account without one is a raised limit with nothing behind it.");
    if (!/^[A-Z]{2}$/.test(country)) die(`--country "${country}" is not an ISO-3166 alpha-2 code`);
    if (config.limits.blockedCountries.includes(country)) die(`--country ${country} is on BLOCKED_COUNTRIES`);

    const num = (n: string) => { const v = flag(n); if (v === undefined) return null; const f = Number(v); if (!Number.isFinite(f) || f <= 0) die(`--${n} must be a positive number of dollars`); return Math.round(f * M); };
    const maxOrder = num("max-order"), maxPayout = num("max-payout"), daily = num("daily");
    if (maxOrder !== null) checkAgainstRefundFloat("--max-order", maxOrder);
    if (maxPayout !== null) checkAgainstRefundFloat("--max-payout", maxPayout);
    // A daily ceiling above the refund cap is a softer problem than a per-order one —
    // it needs several failures on the same day, not one — but it is the same promise:
    // on a bad supplier day the orders past the cap go to refund_failed, which means
    // the payer's money is taken and nothing is delivered. Warn, do not refuse.
    if (daily !== null && daily > config.refund.dailyCapUsd * M) {
      console.warn(`⚠️  --daily of ${usd(daily)} is above REFUND_DAILY_CAP_USD (${usd(config.refund.dailyCapUsd * M)}). One bad supplier day and the orders past the cap cannot be refunded.`);
    }

    const now = new Date().toISOString();
    const row: AccountRow = {
      id: `acct_${randomBytes(6).toString("hex")}`, name, country, kyb_reference: kyb, status: "active",
      max_order_micro: maxOrder, payout_max_micro: maxPayout, daily_micro: daily,
      notes: flag("notes") ?? null, created_at: now, updated_at: now,
    };
    db.insertAccount(row);
    print(row);
    console.log(`\nNext: bind the address it will pay from —\n  pnpm account bind ${row.id} <ALGORAND_ADDRESS>`);
    console.log("Until an address is bound this account has no effect: limits resolve from the payer, not from a request field.\n");
    break;
  }

  case "bind": {
    const [id, payer] = positional;
    if (!id || !ACCOUNT_ID_RE.test(id)) die("usage: pnpm account bind acct_<12 hex> <ALGORAND_ADDRESS>");
    if (!payer || !/^[A-Z2-7]{58}$/.test(payer)) die("that does not look like an Algorand address (58 chars, base32)");
    const a = db.getAccount(id) ?? die(`no such account: ${id}`);
    const existing = db.accountForPayer(payer);
    if (existing && existing.id !== id) console.warn(`⚠️  ${payer.slice(0, 8)}… was bound to ${existing.id} (${existing.name}); moving it.`);
    db.bindPayer(payer, id);
    print(a);
    break;
  }

  case "unbind": {
    const [payer] = positional;
    if (!payer) die("usage: pnpm account unbind <ALGORAND_ADDRESS>");
    console.log(db.unbindPayer(payer) ? `✓ ${payer.slice(0, 8)}… unbound — it is back on the standard tier` : `nothing to do: ${payer.slice(0, 8)}… was not bound`);
    break;
  }

  case "show": {
    const [id] = positional;
    print(db.getAccount(id ?? "") ?? die(`no such account: ${id ?? "(none given)"}`));
    console.log();
    break;
  }

  case "suspend":
  case "resume": {
    const [id] = positional;
    const a = db.getAccount(id ?? "") ?? die(`no such account: ${id ?? "(none given)"}`);
    const status = cmd === "suspend" ? "suspended" : "active";
    db.updateAccount(a.id, { status });
    // Suspension REFUSES rather than dropping to the standard tier: letting a suspended
    // counterparty keep trading at the default ceiling would be a decision nobody made.
    console.log(cmd === "suspend"
      ? `⛔ ${a.id} suspended — every quote and every payment from its addresses is now refused.`
      : `✓ ${a.id} active again.`);
    break;
  }

  default:
    console.error(`unknown command "${cmd}"\n`);
    console.error("  pnpm account list | add | bind | unbind | show | suspend | resume");
    process.exit(1);
}
