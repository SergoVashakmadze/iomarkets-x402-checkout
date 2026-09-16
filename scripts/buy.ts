// End-to-end buyer: the exact thing an agent does. Spends REAL USDC on mainnet
// when NETWORK=mainnet, so it carries a budget.
//
//   AGENT_MNEMONIC_FILE=~/.secrets/agent.mnemonic pnpm buy --phone +919876543210 --amount 100
//   AGENT_MNEMONIC_FILE=~/.secrets/agent.mnemonic pnpm buy --esim IN
//   AGENT_MNEMONIC_FILE=~/.secrets/agent.mnemonic pnpm buy --type topup --offer <offerId> --phone +2348030000000 --amount 500
//
// International payout (docs/PAYOUTS.md). --amount is in the DESTINATION currency,
// --sender is the human principal the agent acts for, and --field is repeated once per
// beneficiary field the corridor requires (GET /v1/catalog?type=payout&country=NG lists them):
//
//   AGENT_MNEMONIC_FILE=~/.secrets/agent.mnemonic pnpm buy --type payout \
//     --offer bn-NG-NGN-bank --amount 5000 --sender "Ada Lovelace,GB" \
//     --field account_name=Chidi --field account_number=0123456789 --field bank_code=058
//
// Env: API_URL (default http://127.0.0.1:3000), BUY_BUDGET_USD (default 25)

import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import algosdk from "algosdk";
import { config } from "../src/config.js";
import { makePayingFetch } from "../src/client/paying.js";
import { loadSecret } from "../src/keys.js";
import { missingFields, parseArgs, parseFields, parseSender } from "../src/client/buy-args.js";

const argv = parseArgs(process.argv.slice(2));
const args = { has: (k: string) => argv.has(k), get: (k: string) => argv.get(k)?.[0], all: (k: string) => argv.get(k) ?? [] };
const API = (process.env.API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const budgetUsd = Number(process.env.BUY_BUDGET_USD ?? "25");
const mnemonic = loadSecret("AGENT_MNEMONIC");
if (!mnemonic) throw new Error("AGENT_MNEMONIC_FILE (or AGENT_MNEMONIC) required — the paying wallet");
const account = algosdk.mnemonicToSecretKey(mnemonic);

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
const log = (...a: unknown[]) => console.log(...a);

/**
 * Build a payout quote, and refuse to build a wrong one.
 *
 * A payout is irreversible once the partner finalises it, and the money is gone to a
 * stranger's account rather than to a phone number its owner can be asked about. So
 * everything checkable is checked BEFORE any USDC moves — a missing beneficiary field
 * discovered by the partner after settlement is a refund at best and a misdirected
 * payment at worst.
 */
async function payoutQuote(): Promise<Record<string, unknown>> {
  const offerId = args.get("offer");
  if (!offerId) throw new Error("--offer is required for a payout (list them: GET /v1/catalog?type=payout&country=NG)");
  const amount = Number(args.get("amount"));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("--amount is required for a payout, in the DESTINATION currency (e.g. 5000 for ₦5,000)");

  const country = /^bn-([A-Z]{2})-/.exec(offerId)?.[1] ?? args.get("country")?.toUpperCase();
  if (!country) throw new Error("could not infer the country from --offer; pass --country NG");
  const cat = await j(await fetch(`${API}/v1/catalog?limit=0&type=payout&country=${country}`));
  const offer = (cat.offers ?? []).find((o: { offerId: string }) => o.offerId === offerId);
  if (!offer) throw new Error(`offer ${offerId} is not in the ${country} payout catalogue — ${(cat.offers ?? []).map((o: { offerId: string }) => o.offerId).join(", ") || "it is empty"}`);

  const sender = parseSender(args.get("sender"), args.get("sender-ref"));
  const fields = parseFields(args.all("field"));
  const missing = missingFields(offer.requiredFields, fields);
  if (missing.length) throw new Error(`${offerId} requires ${(offer.requiredFields ?? []).join(", ")} — missing: ${missing.map((k: string) => `--field ${k}=…`).join(" ")}`);
  const extra = Object.keys(fields).filter((k) => !(offer.requiredFields ?? []).includes(k));
  if (extra.length) log(`note: ${extra.join(", ")} is not in this corridor's required fields; it is passed through as-is`);

  if (amount < offer.sendMin || amount > offer.sendMax) {
    throw new Error(`--amount ${amount} is outside ${offerId}'s range ${offer.sendMin}–${offer.sendMax} ${offer.sendCurrency}`);
  }

  // Read the details back before spending. This is the same instruction the skill gives
  // an agent (docs/PAYOUTS.md): a payout cannot be recalled, and a transposed account
  // number is indistinguishable from a correct one until someone else has the money.
  log(`\npayout   ${offer.name} (${offerId})`);
  log(`amount   ${amount} ${offer.sendCurrency} to:`);
  for (const [k, v] of Object.entries(fields)) log(`         ${k.padEnd(18)} ${v}`);
  log(`sender   ${sender.name} (${sender.country})${sender.reference ? ` ref ${sender.reference}` : ""}`);
  log(`\nThis cannot be reversed once the partner settles it.`);
  await confirm();

  return { type: "payout", offerId, amount, sender, recipient: { fields } };
}

/** Typed confirmation, not a keypress: --yes exists for scripts, and a non-interactive
 *  run without it stops rather than assuming consent it cannot obtain. */
async function confirm(): Promise<void> {
  if (args.has("yes")) return void log("(--yes given, not asking)");
  if (!process.stdin.isTTY) throw new Error("payouts need confirmation; re-run interactively, or pass --yes if this is a script you have already checked");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type 'yes' to pay: ");
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") throw new Error("aborted — nothing was paid");
}

async function main() {
  log(`buyer ${account.addr} → ${API} (${config.network}), budget $${budgetUsd}`);
  let quoteReq: Record<string, unknown>;
  if ((args.get("type") ?? "") === "payout") {
    quoteReq = await payoutQuote();
  } else if (args.has("esim")) {
    const country = args.get("esim")!.toUpperCase();
    // limit=0 — this picks an offer out of the list by id, so a page would make a
    // valid --offer look like it does not exist. The catalogue route pages by default.
    const cat = await j(await fetch(`${API}/v1/catalog?limit=0&type=esim&country=${country}`));
    const offer = args.has("offer") ? cat.offers.find((o: { offerId: string }) => o.offerId === args.get("offer")) : cat.offers[0];
    if (!offer) throw new Error(`no eSIM offers for ${country}`);
    log(`offer: ${offer.name} (${offer.offerId}) from $${offer.price_usdc_from}`);
    quoteReq = { type: "esim", offerId: offer.offerId, recipient: {} };
  } else {
    const phone = args.get("phone");
    if (!phone) throw new Error("--phone or --esim required");
    const type = args.get("type") ?? "topup";
    let offerId = args.get("offer");
    if (!offerId) {
      const l = await j(await fetch(`${API}/v1/lookup?phone=${encodeURIComponent(phone)}`));
      log(`lookup: ${l.country} ${l.brandName ?? l.brand ?? ""} — ${l.offers?.length ?? 0} offers`);
      const range = l.offers?.find((o: { priceType: string }) => o.priceType === "range") ?? l.offers?.[0];
      if (!range) throw new Error("no offers for this number");
      offerId = range.offerId;
      log(`offer: ${range.name} (${offerId})`);
    }
    quoteReq = { type, offerId, recipient: { phone }, amount: args.has("amount") ? Number(args.get("amount")) : undefined };
  }

  const q = await j(await fetch(`${API}/v1/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(quoteReq) }));
  if (!q.quoteId) throw new Error(`quote failed: ${JSON.stringify(q)}`);
  log(`quote ${q.quoteId}: ${q.delivers} for ${q.price_usdc} USDC (expires ${q.expires_at})`);

  const pay = makePayingFetch(account, { algodUrl: config.algodUrl, capMicroUsdc: BigInt(Math.round(budgetUsd * 1e6)), maxPerCallMicroUsdc: BigInt(Math.round(budgetUsd * 1e6)) });
  const res = await pay(`${API}/v1/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: q.quoteId }) });
  const order = await j(res);
  if (res.status !== 202) throw new Error(`order failed (${res.status}): ${JSON.stringify(order)}`);
  log(`paid → order ${order.orderId} (${order.status}) settlement ${order.settlement_url}`);

  let o = order;
  for (let i = 0; i < 200 && !o.terminal; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    o = await j(await fetch(o.status_url));
    log(`  ${o.status}${o.error ? " — " + o.error : ""}`);
  }
  mkdirSync("receipts", { recursive: true });
  writeFileSync(`receipts/${o.orderId}.json`, JSON.stringify(o, null, 2));
  log(`final: ${o.status}. ${o.confirmation ? "confirmation: " + JSON.stringify(o.confirmation) : ""}${o.refund_url ? "refund: " + o.refund_url : ""}`);
  log(`receipt saved → receipts/${o.orderId}.json  (verify: pnpm verify receipts/${o.orderId}.json --online)`);
  log(`spent this run: ${Number(pay.spentMicroUsdc()) / 1e6} USDC`);
}

// `fetch failed` is Node's entire message for every transport error — DNS, TLS, refused,
// reset — and this script always talks to a remote endpoint, so that alone is useless.
// The cause chain carries the actual code; print it.
main().catch((e: Error & { cause?: { code?: string; message?: string } }) => {
  const cause = e.cause?.code ? ` (${e.cause.code}${e.cause.message ? `: ${e.cause.message}` : ""})` : e.cause?.message ? ` (${e.cause.message})` : "";
  console.error(`ERR: ${e.message}${cause}`);
  if (e.cause?.code) console.error(`     talking to ${API} — check API_URL, and that the host is reachable from here.`);
  process.exit(1);
});
