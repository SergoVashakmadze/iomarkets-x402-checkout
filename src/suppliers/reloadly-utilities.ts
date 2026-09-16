// Reloadly Utilities adapter — bill payments (`type: "bill"`).
//
// ⛔ DEPRECATED BY THE SUPPLIER, 2026-09-01. Reloadly customer notice:
//    "the Utility Payments service is currently being deprecated. Please refrain from
//    using the service until further notice."
//
// This adapter is kept, complete and tested, because the notice says "until further
// notice" and not "removed" — but it is now gated behind an explicit acknowledgement
// (see `assertReloadlyUtilitiesAllowed` in ./index.ts's caller) so that BILL_SUPPLIER
// cannot be switched on by someone reading the "one live payment away" note below and
// not the deprecation. **Do not make that live payment.** It would spend real money
// verifying the semantics of a service the vendor has asked us to stop calling, and a
// bill sold on it can be withdrawn mid-order — we would settle the payer's USDC and
// then refund it, which is the exact failure the whole trust layer exists to avoid.
// Nothing below is wrong; it is simply not ours to sell right now. docs/SUPPLIERS.md.
//
// Separate from src/suppliers/reloadly.ts because Reloadly's OAuth `audience` names a
// PRODUCT as well as an environment: an airtime token is not accepted by
// utilities.reloadly.com. Same credentials, different token, different Accept header.
//
// ── What is verified, and what is not (probed 2026-08-31, docs/SUPPLIERS.md) ──
//
// VERIFIED against the live production API with read-only calls and deliberately
// incomplete writes. Nothing was spent:
//   • GET /billers returns 27 billers; every one has `internationalAmountSupported:
//     true` and `internationalTransactionCurrencyCode: "USD"`, so we price in USD and
//     never touch FX. (This is the exact blocker that makes Zendit unusable.)
//   • The biller record carries NO identity fields — no sender, no recipient, no date
//     of birth, no address. Zendit's bill pay demands a full dossier for both parties
//     and is refused up front for that reason; this is not that.
//   • POST /pay requires exactly THREE fields, established by walking the validation
//     chain with requests that could never complete a payment:
//         {}                                   → MISSING_REQUIRED_BILLER_ID
//         {billerId}                           → MISSING_REQUIRED_SUBSCRIBER_ACCOUNT_NUMBER
//         {billerId, subscriberAccountNumber}  → INVALID_AMOUNT
//     `referenceId` was accepted alongside them without complaint.
//   • GET /transactions is a Spring page and accepts a `referenceId` query param.
//     GET /transactions/{id} answers TRANSACTION_NOT_FOUND for an unknown id.
//   • GET /accounts/balance is the SAME wallet as airtime and gift cards — one float
//     across all three products.
//
// NOT VERIFIED, because confirming it costs a real bill payment. One live run settles
// all of it, and until then `BILL_SUPPLIER` is unset by default:
//   • the success response shape (field names below follow Reloadly's transaction
//     model; `map()` is written to tolerate absent fields rather than assume them),
//   • whether `referenceId` is ENFORCED unique, which is what makes a retry safe. The
//     recovery path below assumes it is NOT and looks the transaction up instead —
//     the same defensive posture the airtime adapter takes with `customIdentifier`,
//     which turned out to be right there.

import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "./types.js";

/**
 * The supplier's own words, dated, so nobody has to take a code comment's word for it.
 * Kept next to the adapter rather than in a doc because the guard below reads it and a
 * doc cannot fail a boot.
 */
export const RELOADLY_UTILITIES_DEPRECATION = {
  noticedOn: "2026-09-01",
  source: "Reloadly customer notice",
  quote:
    "We would like to let you know that the Utility Payments service is currently being " +
    "deprecated. Please refrain from using the service until further notice.",
} as const;

/**
 * Throws unless the operator has explicitly acknowledged the deprecation.
 *
 * Deliberately NOT a warning. A warning at boot is read once, by whoever is watching the
 * log, and never again; this product is one env var away from selling something the
 * vendor has asked us not to call, and the cost of getting it wrong is a payer whose
 * USDC settled against a service that was switched off underneath them.
 */
export function assertReloadlyUtilitiesAllowed(acknowledged: boolean): void {
  if (acknowledged) return;
  throw new Error(
    `BILL_SUPPLIER=reloadly is refused: Reloadly deprecated the Utility Payments service ` +
      `on ${RELOADLY_UTILITIES_DEPRECATION.noticedOn} — "${RELOADLY_UTILITIES_DEPRECATION.quote}" ` +
      `Re-enable only after Reloadly confirms the service is back, by setting ` +
      `ALLOW_DEPRECATED_BILL_SUPPLIER=1 alongside it. See docs/SUPPLIERS.md.`,
  );
}

/** GET /billers — the 27 keys confirmed on the live response. */
type RBiller = {
  id: number; name: string; countryCode: string; countryName: string;
  type: string; serviceType: "PREPAID" | "POSTPAID";
  localTransactionCurrencyCode?: string;
  minLocalTransactionAmount?: number; maxLocalTransactionAmount?: number;
  internationalAmountSupported?: boolean; internationalTransactionCurrencyCode?: string;
  minInternationalTransactionAmount?: number; maxInternationalTransactionAmount?: number;
  internationalTransactionFee?: number; internationalTransactionFeePercentage?: number;
  fx?: { rate: number; currencyCode?: string };
  denominationType?: "FIXED" | "RANGE";
  internationalFixedAmounts?: number[] | null; localFixedAmounts?: number[] | null;
  requiresInvoice?: boolean;
};
type RPage<T> = { content?: T[]; last?: boolean };
/** POST /pay and GET /transactions/{id}. `status` naming follows Reloadly's other
 *  products; unknown values are treated as pending rather than as failure, because
 *  reporting "failed" for a bill that is merely processing refunds a payer whose
 *  electricity was in fact bought. */
type RBillTx = {
  id?: number; transactionId?: number; referenceId?: string; status?: string;
  amount?: number; currencyCode?: string; billDetails?: Record<string, unknown>;
  deliveryStatus?: string; token?: string; utilityToken?: string; message?: string;
};

const M = 1_000_000;
/** The only recipient field a bill needs — confirmed by the validation chain. */
export const ACCOUNT_FIELD = "account_number";

export class ReloadlyUtilitiesSupplier implements Supplier {
  readonly name = "reloadly-utilities";
  private token?: { value: string; exp: number };
  private readonly audience: string;
  /** Billers cached: there is no GET /billers/{id} (it 404s), so getOffer has to read
   *  the list. TTL matches the quote TTL — a biller cannot change price between quote
   *  and payment without the quote expiring first. */
  private billers?: { at: number; list: RBiller[] };
  private static readonly TTL_MS = 10 * 60 * 1000;

  constructor(private readonly clientId: string, private readonly clientSecret: string, sandbox: boolean) {
    if (!clientId || !clientSecret) throw new Error("RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET missing");
    this.audience = sandbox ? "https://utilities-sandbox.reloadly.com" : "https://utilities.reloadly.com";
  }

  private async auth(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch("https://auth.reloadly.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials", audience: this.audience }),
    });
    if (!res.ok) throw new SupplierError(`reloadly-utilities auth → ${res.status}`, res.status >= 500);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.audience}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, Accept: "application/com.reloadly.utilities-v1+json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown; try { json = text ? JSON.parse(text) : undefined; } catch { /* ignore */ }
    if (!res.ok) {
      const e = json as { message?: string; errorCode?: string } | undefined;
      const msg = e?.errorCode ? `${e.errorCode}: ${e.message ?? ""}` : e?.message ?? text.slice(0, 200);
      throw new SupplierError(`reloadly-utilities ${method} ${path} → ${res.status}: ${msg}`, res.status >= 500 || res.status === 429);
    }
    return json as T;
  }

  private async allBillers(): Promise<RBiller[]> {
    if (this.billers && Date.now() - this.billers.at < ReloadlyUtilitiesSupplier.TTL_MS) return this.billers.list;
    const list: RBiller[] = [];
    for (let page = 0; page < 20; page++) {
      const r = await this.call<RPage<RBiller>>("GET", `/billers?size=200&page=${page}`);
      const content = r.content ?? [];
      list.push(...content);
      if (r.last || content.length === 0) break;
    }
    this.billers = { at: Date.now(), list };
    return list;
  }

  /**
   * A biller becomes one Offer. We always instruct in USD (`useLocalAmount: false`),
   * so a biller that cannot take an international amount is not advertised at all —
   * better unlisted than listed and then refused after the payer has settled.
   */
  private mapBiller(b: RBiller): Offer | null {
    if (!b.internationalAmountSupported) return null;
    if (b.internationalTransactionCurrencyCode !== "USD") return null;
    // A fee on top of the amount makes our quoted cost wrong, so these are not listed.
    //
    // ⚠️ Know what this costs before removing it. On the live catalogue (2026-08-31) it
    // drops 5 of 27 billers — and those 5 are the whole of ZA, ZW, SL, MZ and MW, so
    // coverage falls from 8 countries to 3 (NG, SN, ML). NG is 17 of the 22 that
    // remain, so no volume is lost; breadth is.
    //
    // The 5 carry BOTH an `internationalTransactionFee` and an
    // `internationalDiscountPercentage`, and which way they net out is not documented
    // and has not been observed on a real transaction. Pricing them by guessing costs
    // us money on every order in a way no test would catch. Once Reloadly confirms
    // whether the fee is charged on top of `amount` and whether the discount is netted
    // against it, price them properly here instead of hiding them — that is a strictly
    // better outcome than this. See docs/SUPPLIERS.md.
    if ((b.internationalTransactionFee ?? 0) > 0 || (b.internationalTransactionFeePercentage ?? 0) > 0) return null;
    const base = {
      id: `rlu-${b.id}`, type: "bill" as const, country: b.countryCode, brand: String(b.id), brandName: b.name,
      name: `${b.name} (${b.serviceType.toLowerCase()})`,
      notes: b.requiresInvoice ? "this biller requires an invoice reference" : undefined,
      sendCurrency: b.localTransactionCurrencyCode,
      requiredFields: [ACCOUNT_FIELD],
    };
    const fixed = b.internationalFixedAmounts ?? [];
    if (b.denominationType === "FIXED" && fixed.length) {
      // Not seen live — every one of the 27 is RANGE — but the field exists, so handle
      // it rather than mis-price a biller that changes.
      return { ...base, priceType: "fixed", costMicro: Math.round(fixed[0] * M) };
    }
    // RANGE. `fx.rate` is destination units per 1 USD, same convention as the airtime
    // adapter's Operator.fx; the international bounds are the fallback when it is absent.
    const rate = b.fx?.rate
      ?? (b.minLocalTransactionAmount && b.minInternationalTransactionAmount
        ? b.minLocalTransactionAmount / b.minInternationalTransactionAmount : undefined);
    return {
      ...base, priceType: "range",
      costMinMicro: Math.round((b.minInternationalTransactionAmount ?? 0) * M),
      costMaxMicro: Math.round((b.maxInternationalTransactionAmount ?? 0) * M),
      sendMin: b.minLocalTransactionAmount, sendMax: b.maxLocalTransactionAmount,
      costPerSendUnitMicro: rate ? Math.ceil(M / rate) : undefined,
    };
  }

  /** Bills have no phone number. The order layer only calls this for topups. */
  readonly productTypes = ["bill"] as const;

  async lookupPhone(msisdn: string): Promise<PhoneLookup> { return { msisdn, country: null }; }

  async listOffers(q: { type: ProductType; country?: string; brand?: string }): Promise<Offer[]> {
    if (q.type !== "bill") return [];
    const list = await this.allBillers();
    return list
      .filter((b) => (!q.country || b.countryCode === q.country) && (!q.brand || String(b.id) === q.brand))
      .map((b) => this.mapBiller(b))
      .filter((o): o is Offer => o !== null);
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type !== "bill") return null;
    const m = /^rlu-(\d+)$/.exec(id);
    if (!m) return null;
    const b = (await this.allBillers()).find((x) => String(x.id) === m[1]);
    return b ? this.mapBiller(b) : null;
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    const m = /^rlu-(\d+)$/.exec(req.offerId);
    const account = req.recipient.fields?.[ACCOUNT_FIELD];
    if (!m || !account) throw new SupplierError(`bad reloadly-utilities offer/recipient (${ACCOUNT_FIELD} required)`);
    try {
      const r = await this.call<RBillTx>("POST", "/pay", {
        billerId: Number(m[1]),
        subscriberAccountNumber: account,
        amount: req.costMicro / M,
        useLocalAmount: false,
        referenceId: req.orderId,
      });
      return this.map(r, req.orderId);
    } catch (e) {
      // Whether `referenceId` is enforced unique is UNVERIFIED. If it is, a resumed or
      // retried order is rejected here and the first attempt may already have paid the
      // bill — so look for it before letting the order fail into a refund. This is the
      // path that stops us refunding a payer whose electricity was actually bought.
      if (!(e instanceof SupplierError) || e.retryable) throw e;
      const existing = await this.findByReference(req.orderId).catch(() => undefined);
      if (!existing) throw e;
      return this.map(existing, req.orderId);
    }
  }

  /** Accepts Reloadly's own numeric id or our `referenceId`, like the airtime adapter. */
  async getPurchase(_type: ProductType, supplierTxId: string): Promise<PurchaseResult> {
    if (/^\d+$/.test(supplierTxId)) {
      const r = await this.call<RBillTx>("GET", `/transactions/${supplierTxId}`);
      return this.map(r, r.referenceId);
    }
    const found = await this.findByReference(supplierTxId);
    if (!found) throw new SupplierError(`reloadly-utilities has no transaction for referenceId ${supplierTxId}`, true);
    return this.map(found, supplierTxId);
  }

  private async findByReference(referenceId: string): Promise<RBillTx | undefined> {
    const r = await this.call<RPage<RBillTx> | RBillTx[]>("GET", `/transactions?referenceId=${encodeURIComponent(referenceId)}`);
    const list = Array.isArray(r) ? r : r.content ?? [];
    return list.find((t) => t.referenceId === referenceId);
  }

  async balanceMicro(): Promise<number> {
    const b = await this.call<{ balance: number; currencyCode: string }>("GET", "/accounts/balance");
    if (b.currencyCode !== "USD") throw new SupplierError(`reloadly account currency ${b.currencyCode} unsupported`);
    return Math.round(b.balance * M);
  }

  async fxRate(currency: string): Promise<number | null> {
    const b = (await this.allBillers()).find((x) => x.localTransactionCurrencyCode === currency && x.fx?.rate);
    return b?.fx?.rate ?? null;
  }

  /**
   * Reloadly's bill statuses are not documented in a machine-readable spec, so this
   * maps the ones we can name and treats EVERYTHING ELSE as pending. That asymmetry is
   * deliberate: a wrong "failed" refunds a payer whose bill was paid — we lose the
   * money and they get the electricity — while a wrong "pending" only costs another
   * poll, and the order layer times out into a refund on its own.
   */
  private map(r: RBillTx, referenceId?: string): PurchaseResult {
    const id = r.id ?? r.transactionId;
    if (id === undefined || id === null) {
      // No id means we cannot poll it. Retryable, so the order stays open and is
      // recovered by referenceId rather than refunded against a payment that may exist.
      throw new SupplierError(`reloadly-utilities response carried no transaction id (referenceId ${referenceId ?? "?"})`, true);
    }
    const supplierTxId = String(id);
    const status = (r.status ?? r.deliveryStatus ?? "").toUpperCase();
    if (status === "SUCCESSFUL" || status === "COMPLETED" || status === "DELIVERED") {
      const confirmation: Record<string, unknown> = { transaction_id: supplierTxId };
      // For PREPAID electricity the token IS the deliverable, exactly like a PIN
      // voucher on the airtime side. An order that reports delivered without
      // surfacing it has delivered nothing.
      if (r.token) confirmation.token = r.token;
      if (r.utilityToken) confirmation.token = r.utilityToken;
      if (r.billDetails) confirmation.bill = r.billDetails;
      if (r.amount !== undefined) confirmation.amount = r.amount;
      return { supplierTxId, status: "delivered", confirmation };
    }
    if (status === "FAILED" || status === "REFUNDED" || status === "REVERSED") {
      return { supplierTxId, status: "failed", error: r.message ?? `reloadly-utilities status ${status || "unknown"}` };
    }
    return { supplierTxId, status: "pending" };
  }
}
