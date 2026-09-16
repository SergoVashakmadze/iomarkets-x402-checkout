// Reloadly adapter (airtime / data only). OAuth2 client-credentials; sandbox and
// production are different audiences.
//
// Field names verified 2026-08-26 against Reloadly's own Java SDK models
// (github.com/Reloadly/reloadly-sdk-java, java-sdk-airtime) — docs.reloadly.com is a
// JS app that serves no machine-readable spec, and the SDK DTOs carry the Jackson
// annotations that name the wire fields exactly. See docs/SUPPLIERS.md.

import { countryOfMsisdn } from "../phone.js";
import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier, type SupplierCountry } from "./types.js";

/** dto/response/Operator.java. The operator's own key is `id` — `operatorId` is a
 *  field of a *transaction*, not of an operator. `fx` is Operator.fxRate, which
 *  carries @JsonProperty("fx"). Plain amounts are in the sender currency (USD);
 *  `local*` amounts are in the destination currency. */
type ROperator = {
  id: number; name: string; country: { isoName: string; name: string }; denominationType: "FIXED" | "RANGE";
  senderCurrencyCode: string; destinationCurrencyCode: string; fx?: { rate: number; currencyCode?: string }; minAmount?: number; maxAmount?: number;
  localMinAmount?: number; localMaxAmount?: number; fixedAmounts?: number[]; localFixedAmounts?: number[]; supportsLocalAmounts?: boolean;
  data?: boolean; bundle?: boolean;
};
/** dto/response/TopupTransaction.java */
type RTopup = { transactionId: number; status: RStatus; operatorTransactionId?: string; customIdentifier?: string; pinDetail?: RPinDetail };

/** PIN-based products deliver a VOUCHER, not credit on the number. Reloadly returns the
 *  code here and nothing reaches the handset — so for these the pin IS the delivery, and
 *  an order that reports "delivered" without surfacing it has delivered nothing. Whole
 *  markets are PIN-only: every one of the 16 GB operators is a fixed £5 PIN voucher
 *  (measured 2026-08-29). Field names follow Reloadly's Java SDK model `PinDetail`. */
type RPinDetail = { serial?: string; info1?: string; info2?: string; info3?: string; value?: string; code?: string; ivr?: string; validity?: string; expiryDate?: string };
/** dto/response/Country.java — GET /countries, every destination the account can top up. */
type RCountry = { isoName: string; name: string; currencyCode?: string };
/** enums/AirtimeTransactionStatus.java */
type RStatus = "SUCCESSFUL" | "PROCESSING" | "REFUNDED" | "FAILED";
/** dto/response/AirtimeTransactionStatusResponse.java — GET /topups/{id}/status wraps
 *  the transaction and repeats the status at the top level. */
type RStatusResponse = { code?: string; message?: string; status?: RStatus; transaction?: RTopup };
/** Spring-style page used by the transaction-history endpoints. */
type RPage<T> = { content?: T[] };

const M = 1_000_000;
/** The country list changes when Reloadly signs an operator, not between page loads. */
const COUNTRIES_TTL_MS = 60 * 60 * 1000;

export class ReloadlySupplier implements Supplier {
  readonly name = "reloadly";
  private token?: { value: string; exp: number };
  private countries?: { list: SupplierCountry[]; exp: number };
  private readonly audience: string;
  constructor(private readonly clientId: string, private readonly clientSecret: string, sandbox: boolean) {
    if (!clientId || !clientSecret) throw new Error("RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET missing");
    this.audience = sandbox ? "https://topups-sandbox.reloadly.com" : "https://topups.reloadly.com";
  }

  private async auth(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch("https://auth.reloadly.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials", audience: this.audience }),
    });
    if (!res.ok) throw new SupplierError(`reloadly auth → ${res.status}`, res.status >= 500);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.audience}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, Accept: "application/com.reloadly.topups-v1+json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown; try { json = text ? JSON.parse(text) : undefined; } catch { /* ignore */ }
    if (!res.ok) {
      const msg = (json as { message?: string })?.message ?? text.slice(0, 200);
      throw new SupplierError(`reloadly ${method} ${path} → ${res.status}: ${msg}`, res.status >= 500 || res.status === 429);
    }
    return json as T;
  }

  private mapOperator(op: ROperator): Offer[] {
    if (op.id === undefined || op.id === null) throw new SupplierError("reloadly operator has no id");
    const iso = op.country.isoName;
    const base = { type: "topup" as const, country: iso, brand: String(op.id), brandName: op.name, sendCurrency: op.destinationCurrencyCode };
    if (op.senderCurrencyCode !== "USD") throw new SupplierError(`reloadly account currency ${op.senderCurrencyCode} unsupported`);
    if (op.denominationType === "RANGE") {
      // fx.rate is destination units per 1 sender (USD) unit; the bounds are the fallback.
      const rate = op.fx?.rate ?? (op.localMinAmount && op.minAmount ? op.localMinAmount / op.minAmount : undefined);
      return [{
        ...base, id: `rl-${op.id}`, name: `${op.name} ${op.data ? "data" : "airtime"} (any amount)`, priceType: "range",
        costMinMicro: Math.round((op.minAmount ?? 0) * M), costMaxMicro: Math.round((op.maxAmount ?? 0) * M),
        sendMin: op.localMinAmount, sendMax: op.localMaxAmount,
        costPerSendUnitMicro: rate ? Math.ceil(M / rate) : undefined,
      }];
    }
    // fixedAmounts (USD) and localFixedAmounts (destination) are separate sorted sets
    // paired by position. If they disagree in length the pairing is meaningless, so
    // quote without a local amount rather than promise the wrong one.
    const fixed = op.fixedAmounts ?? [];
    const local = op.localFixedAmounts ?? [];
    const paired = local.length === fixed.length;
    return fixed.map((usd, i) => ({
      ...base, id: `rl-${op.id}-${usd}`,
      name: paired ? `${op.name} ${local[i]} ${op.destinationCurrencyCode}` : `${op.name} $${usd}`,
      priceType: "fixed" as const, costMicro: Math.round(usd * M), sendFixed: paired ? local[i] : undefined,
    }));
  }

  /** Airtime and data bundles. Gift Cards and Utilities are separate Reloadly
   *  products on separate OAuth audiences; Utilities was deprecated by Reloadly on
   *  2026-09-01 and gift cards were dropped on economics. */
  readonly productTypes = ["topup"] as const;

  async lookupPhone(msisdn: string): Promise<PhoneLookup> {
    const country = countryOfMsisdn(msisdn);
    if (!country) return { msisdn, country: null };
    try {
      const op = await this.call<ROperator>("GET", `/operators/auto-detect/phone/${msisdn}/countries/${country}?suggestedAmountsMap=false`);
      return { msisdn, country, brand: op.id === undefined ? undefined : String(op.id), brandName: op.name };
    } catch (e) {
      if (e instanceof SupplierError && !e.retryable) return { msisdn, country };
      throw e;
    }
  }

  async listOffers(q: { type: ProductType; country?: string; brand?: string }): Promise<Offer[]> {
    if (q.type !== "topup" || !q.country) return [];
    const ops = await this.call<ROperator[]>("GET", `/operators/countries/${q.country}?includeBundles=true&includeData=true&suggestedAmountsMap=false`);
    return ops.filter((op) => !q.brand || String(op.id) === q.brand).flatMap((op) => this.mapOperator(op));
  }

  /**
   * Every country Reloadly will top up — the "150+ countries" the front page claims,
   * from the supplier that backs the claim. The console used to carry a hand-typed list
   * of five because this was thought unanswerable; `GET /countries` answers it in one
   * call. No per-country offer count: that would be one operator call per country.
   */
  async listCountries(type: ProductType): Promise<SupplierCountry[]> {
    if (type !== "topup") return [];
    if (this.countries && this.countries.exp > Date.now()) return this.countries.list;
    const raw = await this.call<RCountry[]>("GET", "/countries");
    const list = (Array.isArray(raw) ? raw : [])
      .filter((c) => /^[A-Z]{2}$/.test(c.isoName ?? ""))
      .map((c) => ({ code: c.isoName, name: c.name, ...(c.currencyCode ? { currency: c.currencyCode } : {}) }))
      .sort((a, b) => a.code.localeCompare(b.code));
    // An empty answer is "cannot tell you" to every caller, so never cache one as truth.
    if (list.length) this.countries = { list, exp: Date.now() + COUNTRIES_TTL_MS };
    return list;
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type !== "topup") return null;
    const m = /^rl-(\d+)(?:-([\d.]+))?$/.exec(id);
    if (!m) return null;
    const op = await this.call<ROperator>("GET", `/operators/${m[1]}?suggestedAmountsMap=false`);
    return this.mapOperator(op).find((o) => o.id === id) ?? null;
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    const m = /^rl-(\d+)/.exec(req.offerId);
    if (!m || !req.recipient.phone) throw new SupplierError("bad reloadly offer/recipient");
    const country = countryOfMsisdn(req.recipient.phone);
    try {
      // POST /topups is the synchronous endpoint and answers with a TopupTransaction.
      const r = await this.call<RTopup>("POST", "/topups", {
        operatorId: Number(m[1]), amount: req.costMicro / M, useLocalAmount: false, customIdentifier: req.orderId,
        recipientPhone: { countryCode: country, number: req.recipient.phone },
      });
      return this.map(r);
    } catch (e) {
      // `customIdentifier` is a uniqueness constraint, NOT an idempotency key: a replay
      // (a resumed order after a restart, a retried request) is REJECTED rather than
      // deduplicated. The first attempt may well have delivered, so resolve the existing
      // transaction instead of failing into a refund.
      if (!(e instanceof SupplierError) || e.retryable) throw e;
      const existing = await this.findByCustomIdentifier(req.orderId).catch(() => undefined);
      if (!existing) throw e;
      return this.map(existing);
    }
  }

  /**
   * Poll a transaction.
   *
   * Reloadly's transaction id is ITS OWN number — unlike Zendit, our order id goes in
   * `customIdentifier`, not in the id. The order layer recovers from an unknown purchase
   * outcome by polling with OUR order id, so accept both forms:
   *  - numeric → GET /topups/{id}/status, the purpose-built status endpoint. (The
   *    transaction-history record used previously is for settled transactions; a
   *    still-processing topup can be absent from it, which would read as "failed" and
   *    trigger a refund for airtime that then delivers.)
   *  - anything else → treat it as our customIdentifier and search the history for it.
   *    Without this, a timeout on POST /topups is unrecoverable: we would refund the
   *    payer while Reloadly delivers, paying twice.
   */
  async getPurchase(_type: ProductType, supplierTxId: string): Promise<PurchaseResult> {
    if (/^\d+$/.test(supplierTxId)) {
      const r = await this.call<RStatusResponse>("GET", `/topups/${supplierTxId}/status`);
      const tx = r.transaction ?? ({} as RTopup);
      return this.map({ ...tx, transactionId: tx.transactionId ?? Number(supplierTxId), status: r.status ?? tx.status });
    }
    const found = await this.findByCustomIdentifier(supplierTxId);
    if (!found) throw new SupplierError(`reloadly has no transaction for customIdentifier ${supplierTxId}`, true);
    return this.map(found);
  }

  /** The order id we sent as `customIdentifier`, looked up in the transaction history. */
  private async findByCustomIdentifier(customIdentifier: string): Promise<RTopup | undefined> {
    const r = await this.call<RPage<RTopup> | RTopup[]>(
      "GET",
      `/topups/reports/transactions?customIdentifier=${encodeURIComponent(customIdentifier)}`,
    );
    const list = Array.isArray(r) ? r : r.content ?? [];
    return list.find((t) => t.customIdentifier === customIdentifier) ?? list[0];
  }

  async balanceMicro(): Promise<number> {
    const b = await this.call<{ balance: number; currencyCode: string }>("GET", "/accounts/balance");
    if (b.currencyCode !== "USD") throw new SupplierError(`reloadly account currency ${b.currencyCode} unsupported`);
    return Math.round(b.balance * M);
  }

  private map(r: RTopup): PurchaseResult {
    if (r.transactionId === undefined || r.transactionId === null) throw new SupplierError("reloadly response carried no transactionId");
    const supplierTxId = String(r.transactionId);
    if (r.status === "SUCCESSFUL") {
      return {
        supplierTxId,
        status: "delivered",
        confirmation: { operatorReference: r.operatorTransactionId ?? supplierTxId, ...pinConfirmation(r.pinDetail) },
      };
    }
    if (r.status === "FAILED" || r.status === "REFUNDED") return { supplierTxId, status: "failed", error: r.status };
    return { supplierTxId, status: "pending" };
  }
}

/**
 * The redeemable part of a PIN voucher, or nothing.
 *
 * For a PIN product this is the entire deliverable: no credit reaches the phone, and a
 * buyer holding only a transaction id has bought a receipt for nothing. Reloadly spreads
 * the code across differently-named fields depending on the operator (`code`, or `info1`
 * for many UK vouchers), so take the first that carries something rather than trusting
 * one name — and pass the untouched detail alongside it, because the redemption
 * instructions live in the other fields and we cannot know which per operator.
 *
 * Returns an empty object for a normal top-up, so the confirmation shape is unchanged
 * for the direct-credit path.
 */
export function pinConfirmation(pin: RPinDetail | undefined): Record<string, unknown> {
  if (!pin || typeof pin !== "object") return {};
  const code = [pin.code, pin.info1, pin.info2, pin.info3, pin.value].find((v) => typeof v === "string" && v.trim() !== "");
  if (!code && !pin.serial) return {};
  return {
    // Named so it is obvious in a receipt that this is what the buyer must redeem.
    voucher_pin: code,
    ...(pin.serial ? { voucher_serial: pin.serial } : {}),
    ...(pin.ivr ? { voucher_redeem_via: pin.ivr } : {}),
    ...(pin.validity || pin.expiryDate ? { voucher_valid_until: pin.expiryDate ?? pin.validity } : {}),
    voucher_detail: pin,
  };
}
