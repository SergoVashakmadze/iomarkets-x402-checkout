// Entry point: wire config → supplier → db → orders → app, resume in-flight
// orders, listen.
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { Db } from "./db.js";
import { toMicro } from "./money.js";
import { OrderService } from "./orders.js";
import { AlgorandRefunder, DisabledRefunder, HotWallet } from "./refunds.js";
import { ReferralService } from "./referrals.js";
import { makeSupplier } from "./suppliers/index.js";

function assertConfig(): void {
  const missing: string[] = [];
  if (!config.payTo) missing.push("PAY_TO");
  if (!config.receipt.privateKey) missing.push("RECEIPT_PRIVATE_KEY (pnpm gen-key)");
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
}

async function main(): Promise<void> {
  assertConfig();
  const db = new Db(config.dbPath);
  const supplier = makeSupplier();
  const refunder = config.refund.mnemonic
    ? new AlgorandRefunder(config.refund.mnemonic, config.algodUrl, config.usdcAsa, db, toMicro(config.refund.dailyCapUsd),
        config.brand.site.replace(/^https?:\/\//, ""))
    : new DisabledRefunder();
  const base = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
  const referrals = new ReferralService(
    db,
    config.refund.mnemonic ? new HotWallet(config.refund.mnemonic, config.algodUrl, config.usdcAsa) : null,
    {
      shareBps: config.referral.shareBps,
      minPayoutMicro: toMicro(config.referral.minPayoutUsd),
      dailyCapMicro: toMicro(config.referral.dailyCapUsd),
      refundReserveMicro: toMicro(config.referral.refundReserveUsd),
      floatAcquisitionBps: config.pricing.floatAcquisitionBps,
      notePrefix: config.brand.site.replace(/^https?:\/\//, ""),
    },
  );
  const orders = new OrderService(db, supplier, refunder, {
    hooks: {
      onOrderCreated: (o, meta) => referrals.onOrderCreated(o, meta.ref),
      onTerminal: (o) => referrals.onTerminal(o),
    },
    pricing: config.pricing,
    maxOrderUsd: config.limits.maxOrderUsd,
    typeMaxUsd: config.limits.typeMaxUsd,
    quoteTtlSec: config.limits.quoteTtlSec,
    blockedCountries: config.limits.blockedCountries,
    payout: { maxUsd: config.payout.maxUsd, kycAboveUsd: config.payout.kycAboveUsd, recipientDailyUsd: config.payout.recipientDailyUsd },
    payerDailyUsd: config.limits.payerDailyUsd,
    receiptPrivateKey: config.receipt.privateKey,
    ordersEndpoint: `${base}${config.apiPrefix}/orders`,
    pollIntervalMs: config.fulfil.pollIntervalMs,
    timeoutMs: config.fulfil.timeoutMs,
  });
  const app = buildApp({ db, supplier, orders, referrals });

  await orders.resume();
  // Deferred referral shares (hot wallet at its reserve, cap reached, send failed) are
  // retried on boot and hourly. unref'd: this timer must never keep the process alive.
  if (referrals.enabled) {
    void referrals.sweepAll();
    setInterval(() => void referrals.sweepAll(), 60 * 60_000).unref();
  }
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`iomarkets-app listening on :${info.port} (${config.network}) supplier=${supplier.name} payouts=${config.payout.kind || "off"} refunds=${refunder.address() ?? "DISABLED"} payTo=${config.payTo} referrals=${referrals.enabled ? `${config.referral.shareBps}bps` : "off"}`);
    if (!config.refund.mnemonic) console.warn("⚠️  no refund key (REFUND_MNEMONIC_FILE / systemd credential) — failed orders will need manual refunds");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
