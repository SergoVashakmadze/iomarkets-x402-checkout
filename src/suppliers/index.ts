import { config } from "../config.js";
import { BitnobPayoutSupplier } from "./bitnob.js";
import { CompositeSupplier } from "./composite.js";
import { MockSupplier } from "./mock.js";
import { PayoutPartnerSupplier } from "./payout-partner.js";
import { ReloadlySupplier } from "./reloadly.js";
import { ReloadlyUtilitiesSupplier, assertReloadlyUtilitiesAllowed } from "./reloadly-utilities.js";
import type { Supplier } from "./types.js";
import { AiraloSupplier } from "./airalo.js";
import { EsimAccessSupplier } from "./esimaccess.js";
import { ZenditSupplier } from "./zendit.js";

function goods(): Supplier {
  const s = config.supplier;
  switch (s.kind) {
    case "zendit": return new ZenditSupplier(s.zendit.apiKey, s.zendit.baseUrl);
    case "reloadly": return new ReloadlySupplier(s.reloadly.clientId, s.reloadly.clientSecret, s.reloadly.sandbox);
    case "mock": return new MockSupplier();
    default: throw new Error(`unknown SUPPLIER=${String(s.kind)}`);
  }
}

function payouts(g: Supplier): Supplier | null {
  const p = config.payout;
  switch (p.kind) {
    case "": return null;
    case "mock": return g instanceof MockSupplier ? g : new MockSupplier();
    // Bitnob is a real, spec-verified adapter (src/suppliers/bitnob.ts). Every other
    // partner id still lands on the generic skeleton and will throw on first use.
    case "bitnob": return new BitnobPayoutSupplier(p.clientId, p.apiKey, {
      baseUrl: p.baseUrl, asset: p.asset, callbackUrl: p.callbackUrl, maxSlippageBps: p.maxSlippageBps,
    });
    default: return new PayoutPartnerSupplier(p.kind, p.apiKey, p.baseUrl);
  }
}

/**
 * Bill pay. Unset by default, and as of 2026-09-01 the only real implementation is also
 * REFUSED unless explicitly acknowledged: Reloadly deprecated the Utility Payments
 * service and asked us to stop calling it (docs/SUPPLIERS.md). The adapter stays because
 * the notice is "until further notice", not "removed".
 *
 * The older reason it was off — the success-response shape was never confirmed, because
 * confirming it costs a real bill payment — still stands, and is now moot: that payment
 * must not be made while the service is being withdrawn.
 */
function bills(g: Supplier): Supplier | null {
  const b = config.bill.kind;
  switch (b) {
    case "": return null;
    case "mock": return g instanceof MockSupplier ? g : new MockSupplier();
    case "reloadly": {
      const s = config.supplier;
      if (s.kind !== "reloadly") throw new Error("BILL_SUPPLIER=reloadly needs the Reloadly credentials (SUPPLIER=reloadly)");
      assertReloadlyUtilitiesAllowed(config.bill.allowDeprecated);
      return new ReloadlyUtilitiesSupplier(s.reloadly.clientId, s.reloadly.clientSecret, s.reloadly.sandbox);
    }
    default: throw new Error(`unknown BILL_SUPPLIER=${String(b)}`);
  }
}

/**
 * eSIMs. Unset routes them to the goods supplier — the behaviour before this slot
 * existed, and one that sells nothing, because Reloadly has no eSIM product at all.
 *
 * Three real options, all USD-denominated (the thing that matters — see the Zendit
 * verification record in docs/SUPPLIERS.md): "zendit" reuses the same credentials as
 * SUPPLIER=zendit; "airalo" is a partner account behind a volume floor we do not meet;
 * and "esimaccess" is self-serve with no minimum order, and the only one of the three
 * that publishes an idempotency key, an order lookup and a balance endpoint at once.
 */
function esims(g: Supplier): Supplier | null {
  const kind = config.esim.kind;
  switch (kind) {
    case "": return null;
    case "mock": return g instanceof MockSupplier ? g : new MockSupplier();
    case "zendit": {
      const z = config.supplier;
      // Reuse the instance when Zendit is already the goods supplier: one offer cache,
      // one balance, and floatGroupFor() then correctly reports one shared wallet.
      if (z.kind === "zendit" && g instanceof ZenditSupplier) return g;
      return new ZenditSupplier(z.zendit.apiKey, z.zendit.baseUrl);
    }
    case "airalo": return new AiraloSupplier(config.esim.airaloClientId, config.esim.airaloClientSecret);
    case "esimaccess": return new EsimAccessSupplier(config.esim.esimAccessCode, config.esim.esimAccessBaseUrl, config.esim.esimAccessSecret);
    default: throw new Error(`unknown ESIM_SUPPLIER=${String(kind)}`);
  }
}

export function makeSupplier(): CompositeSupplier {
  const g = goods();
  return new CompositeSupplier(g, payouts(g), bills(g), esims(g));
}
