// Zendit adapter — https://developers.zendit.io
// Verified against the published OpenAPI 2.0 spec (test-api.zendit.io/swagger/doc.json,
// basePath /v1, fetched 2026-08-26); see docs/SUPPLIERS.md for what is spec-checked vs
// still needing a live sandbox run.
//
// Auth: `Authorization: Bearer <api key>` (securityDefinitions.ApiKey).
// Money fields are integers in minor units with an explicit `currencyDivisor`; our
// wallet currency is assumed USD and everything is converted to micro-USD.
// Purchases are async: create → poll status. `transactionId` is OUR order id — the
// docs state it is client-supplied and unique per account+environment, so a retried
// create cannot double-buy.

import { countryOfMsisdn } from "../phone.js";
import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "./types.js";

/** dto.Cost / dto.Price / dto.Zend — `fee`/`feePct`/`discount` exist on dto.Cost only. */
type ZMoney = { currency: string; currencyDivisor: number; fixed?: number; min?: number; max?: number; fx?: number; fee?: number; feePct?: number };
/** dto.TopupOffer / dto.ESimOffer / dto.BillPayOffer (the union of the fields we read). */
type ZOffer = {
  offerId: string; brand: string; brandName: string; country: string; enabled: boolean; notes?: string; shortNotes?: string;
  priceType: "FIXED" | "RANGE"; cost: ZMoney; price: ZMoney; send?: ZMoney; dataGB?: number; durationDays?: number; regions?: string[];
  /** billpay only */ requiredFields?: string[]; deliverySpeedSeconds?: number;
};
/** dto.TransactionStatus */
type ZStatus = "ACCEPTED" | "PENDING" | "AUTHORIZED" | "IN_PROGRESS" | "DONE" | "FAILED";
/** dto.TopupPurchase / dto.ESimPurchase (the fields we read). Note `cost` here is a
 *  flat integer in `costCurrency`/`costCurrencyDivisor` minor units — unlike offers,
 *  where cost is a nested object. */
type ZPurchase = {
  transactionId: string; status: ZStatus; error?: { code?: string; message?: string; description?: string };
  confirmation?: Record<string, unknown>; log?: Array<{ status: ZStatus; statusMessage?: string; dateTime?: string }>;
  cost?: number; costFee?: number; costCurrency?: string; costCurrencyDivisor?: number;
};

const M = 1_000_000;
const divisorOf = (m: ZMoney | undefined): number => m?.currencyDivisor || 100;

/**
 * A `dto.Cost` bound in micro-USD, **inclusive of `fee`**.
 *
 * ⚠️ CONFIRMED 2026-09-01 by Zendit: `cost.fixed` is NOT inclusive of `cost.fee`.
 *
 * That answer is the expensive
 * direction: reading `fixed` alone under-states what Zendit charges us by the fee, **on
 * every order**, and we would have sold each one for less than it cost plus margin.
 * `fee` is added here, at the one place cost enters the system, so pricing, the float
 * gate and the ceilings all see the real number.
 *
 * `feePct` is deliberately NOT applied: `fee` is an absolute in the same minor units,
 * and every offer sampled so far reported both as 0, so the interaction between them
 * has never been exercised. Adding a guessed percentage on top of a confirmed absolute
 * would over-charge — the opposite error, and the one a customer notices.
 *
 * **Still to confirm on the first live delivery**, because this came from a beta
 * assistant and Zendit themselves suggested testing it: `getPurchase()` logs what we
 * were actually charged (`[zendit <tx>] charged $…`). Compare it to `fixed + fee`.
 */
const toMicroUsd = (m: ZMoney | undefined, field: "fixed" | "min" | "max"): number | undefined => {
  const v = m?.[field];
  if (v === undefined || v === null) return undefined;
  if (m!.currency !== "USD") throw new SupplierError(`zendit wallet currency ${m!.currency} unsupported (expected USD)`);
  // The fee is charged once per transaction, so it applies to a fixed cost and to both
  // ends of a range alike — a range's min and max are each a possible transaction.
  return Math.round(((v + (m!.fee ?? 0)) / divisorOf(m)) * M);
};
const major = (m: ZMoney | undefined, field: "fixed" | "min" | "max"): number | undefined => {
  const v = m?.[field];
  return v === undefined || v === null ? undefined : v / divisorOf(m);
};

const TYPE_PATH: Record<Exclude<ProductType, "payout">, string> = { topup: "topups", esim: "esim", bill: "billpay" };
const path = (t: ProductType) => {
  if (t === "payout") throw new SupplierError("zendit does not do payouts — configure PAYOUT_SUPPLIER");
  // dto.BillPayPurchaseInput requires `sender` AND `recipient` as full identity objects
  // (first/last name, date of birth, phone and a complete postal address for both).
  // This service collects none of that, so a bill purchase would be rejected by Zendit
  // AFTER the payer's USDC has settled — refuse it here instead. docs/SUPPLIERS.md.
  if (t === "bill") throw new SupplierError("zendit bill pay needs sender/recipient KYC identity this service does not collect — see docs/SUPPLIERS.md");
  return TYPE_PATH[t];
};

export class ZenditSupplier implements Supplier {
  readonly name = "zendit";
  /** Raw offers seen recently, so purchase() knows priceType + cost divisor without
   *  an extra round trip. TTL matches the quote TTL: an offer cannot change price
   *  between quote and payment without the quote expiring first. */
  private readonly offerCache = new Map<string, { at: number; offer: ZOffer }>();
  private static readonly OFFER_TTL_MS = 10 * 60 * 1000;

  constructor(private readonly apiKey: string, private readonly baseUrl: string) {
    if (!apiKey) throw new Error("ZENDIT_API_KEY missing");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      // dto.ResponseError = { errorCode, fields, message }
      const e = json as { message?: string; errorCode?: string } | undefined;
      const msg = e?.message ?? text.slice(0, 200);
      const code = e?.errorCode ? ` [${e.errorCode}]` : "";
      throw new SupplierError(`zendit ${method} ${path} → ${res.status}${code}: ${msg}`, res.status >= 500 || res.status === 429);
    }
    return json as T;
  }

  private remember(type: ProductType, o: ZOffer): ZOffer {
    this.offerCache.set(`${type}:${o.offerId}`, { at: Date.now(), offer: o });
    return o;
  }

  /** Cached raw offer, else fetched. Needed before a purchase to build a valid body. */
  private async rawOffer(type: ProductType, offerId: string): Promise<ZOffer> {
    const hit = this.offerCache.get(`${type}:${offerId}`);
    if (hit && Date.now() - hit.at < ZenditSupplier.OFFER_TTL_MS) return hit.offer;
    const o = await this.call<ZOffer>("GET", `/${path(type)}/offers/${encodeURIComponent(offerId)}`);
    if (!o?.offerId) throw new SupplierError(`zendit offer ${offerId} not found`);
    return this.remember(type, o);
  }

  private mapOffer(type: ProductType, o: ZOffer): Offer {
    const base: Offer = {
      id: o.offerId, type, country: o.country, brand: o.brand, brandName: o.brandName,
      name: o.shortNotes || o.notes || `${o.brandName} ${type}`, notes: o.notes,
      priceType: o.priceType === "FIXED" ? "fixed" : "range",
      sendCurrency: o.send?.currency, dataGB: o.dataGB, durationDays: o.durationDays, regions: o.regions,
      // dto.BillPayOffer only; the quote layer validates recipient.fields against this.
      requiredFields: o.requiredFields?.length ? o.requiredFields : undefined,
      settlementSeconds: o.deliverySpeedSeconds,
    };
    if (o.priceType === "FIXED") {
      base.costMicro = toMicroUsd(o.cost, "fixed");
      base.sendFixed = major(o.send, "fixed");
    } else {
      base.costMinMicro = toMicroUsd(o.cost, "min");
      base.costMaxMicro = toMicroUsd(o.cost, "max");
      base.sendMin = major(o.send, "min");
      base.sendMax = major(o.send, "max");
      base.costPerSendUnitMicro = costPerSendUnit(o, base);
    }
    return base;
  }

  /** Zendit is the only supplier we hold credentials for that sells eSIMs. Bills
   *  are refused up front (they demand a full identity dossier for both parties —
   *  see the verification record in docs/SUPPLIERS.md), so they are not listed. */
  readonly productTypes = ["topup", "esim"] as const;

  async lookupPhone(msisdn: string): Promise<PhoneLookup> {
    try {
      // dto.PhoneNumberLookupResponse = { brand, country, mobileCountryCode, mobileNetworkCode, msisdn }
      const r = await this.call<{ msisdn: string; country: string; brand: string }>("GET", `/tools/phonenumberlookup/${encodeURIComponent(msisdn)}`);
      return { msisdn, country: r.country || countryOfMsisdn(msisdn), brand: r.brand || undefined };
    } catch (e) {
      if (e instanceof SupplierError && !e.retryable) return { msisdn, country: countryOfMsisdn(msisdn) };
      throw e;
    }
  }

  async fxRate(currency: string): Promise<number | null> {
    // Indicative only: taken from any range top-up offer in that currency.
    const r = await this.call<{ list: ZOffer[] }>("GET", `/topups/offers?_limit=200&_offset=0`);
    for (const raw of r.list ?? []) {
      const o = this.mapOffer("topup", raw);
      if (o.priceType === "range" && o.sendCurrency === currency && o.costPerSendUnitMicro) return M / o.costPerSendUnitMicro;
    }
    return null;
  }

  async listOffers(q: { type: ProductType; country?: string; brand?: string; limit?: number; offset?: number }): Promise<Offer[]> {
    if (q.type === "payout" || q.type === "bill") return [];
    // _limit and _offset are REQUIRED query params on every offers endpoint.
    const p = new URLSearchParams({ _limit: String(q.limit ?? 100), _offset: String(q.offset ?? 0) });
    if (q.country) p.set("country", q.country);
    if (q.brand) p.set("brand", q.brand);
    const r = await this.call<{ list: ZOffer[] }>("GET", `/${path(q.type)}/offers?${p}`);
    return (r.list ?? []).filter((o) => o.enabled !== false).map((o) => this.mapOffer(q.type, this.remember(q.type, o)));
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type === "payout" || type === "bill") return null;
    try {
      const o = await this.rawOffer(type, id);
      return o.enabled === false ? null : this.mapOffer(type, o);
    } catch (e) {
      if (e instanceof SupplierError && !e.retryable) return null;
      throw e;
    }
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    const purchasePath = `/${path(req.type)}/purchases`;
    const offer = await this.rawOffer(req.type, req.offerId);

    let body: Record<string, unknown>;
    if (req.type === "esim") {
      // dto.ESimPurchaseMakeInput = { offerId*, transactionId*, iccid? } — no `value`.
      body = { offerId: req.offerId, transactionId: req.orderId, ...(req.recipient.iccid ? { iccid: req.recipient.iccid } : {}) };
    } else {
      // dto.TopupPurchaseMakeInput = { offerId*, recipientPhoneNumber*, transactionId*, value?, sender? }.
      // `value` is required for RANGE offers and must be OMITTED for FIXED ones.
      if (!req.recipient.phone) throw new SupplierError("zendit topup needs recipient.phone");
      body = { offerId: req.offerId, recipientPhoneNumber: req.recipient.phone, transactionId: req.orderId };
      if (offer.priceType === "RANGE") body.value = { type: "COST", value: costMinorUnits(req.costMicro, offer.cost) };
    }

    const r = await this.call<{ transactionId: string; status: ZStatus }>("POST", purchasePath, body);
    return this.mapStatus({ transactionId: r.transactionId || req.orderId, status: r.status });
  }

  async getPurchase(type: ProductType, supplierTxId: string): Promise<PurchaseResult> {
    const p = await this.call<ZPurchase>("GET", `/${path(type)}/purchases/${encodeURIComponent(supplierTxId)}`);
    if (p.status === "DONE") {
      // What we were ACTUALLY charged, so the fee question (is offer cost.fixed
      // inclusive of cost.fee?) is answered by the first sandbox delivery rather than
      // by guessing. Server-side log only — never handed to the buyer, it is our margin.
      const actual = ZenditSupplier.actualCostMicro(p);
      if (actual !== undefined) console.log(`[zendit ${supplierTxId}] charged $${(actual / M).toFixed(6)} (cost=${p.cost} fee=${p.costFee ?? 0} /${p.costCurrencyDivisor || 100})`);
    }
    return this.mapStatus(p, type);
  }

  async balanceMicro(): Promise<number> {
    // dto.BalanceResponse = { availableBalance, currency, currencyDivisor }
    const b = await this.call<{ availableBalance: number; currency: string; currencyDivisor: number }>("GET", "/balance");
    if (b.currency !== "USD") throw new SupplierError(`zendit wallet currency ${b.currency} unsupported`);
    return Math.round((b.availableBalance / (b.currencyDivisor || 100)) * M);
  }

  /** What the supplier actually charged, micro-USD — for margin reconciliation in logs. */
  static actualCostMicro(p: ZPurchase): number | undefined {
    if (p.cost === undefined || p.costCurrency !== "USD") return undefined;
    return Math.round(((p.cost + (p.costFee ?? 0)) / (p.costCurrencyDivisor || 100)) * M);
  }

  private mapStatus(p: ZPurchase, type?: ProductType): PurchaseResult {
    const supplierTxId = p.transactionId;
    if (p.status === "DONE") {
      // dto.Confirmation for topups/bills; dto.ESimConfirmation for eSIMs.
      const c = { ...(p.confirmation ?? {}) } as Record<string, unknown>;
      if (type === "esim" && c.smdpAddress && c.activationCode) c.lpa = `LPA:1$${c.smdpAddress}$${c.activationCode}`;
      return { supplierTxId, status: "delivered", confirmation: c };
    }
    if (p.status === "FAILED") {
      // dto.Error = { code, description, message }
      const last = p.log?.at(-1)?.statusMessage;
      return { supplierTxId, status: "failed", error: p.error?.message ?? p.error?.code ?? last ?? "FAILED" };
    }
    return { supplierTxId, status: "pending" };
  }
}

/**
 * Micro-USD cost → the integer minor units Zendit expects in `value`, using the
 * offer's own `currencyDivisor` rather than assuming cents. Rounded DOWN so a
 * rounding artefact can never push the charge above the cost the quote was priced on.
 */
export function costMinorUnits(costMicro: number, cost: ZMoney): number {
  const v = Math.floor((costMicro / M) * divisorOf(cost));
  const min = cost.min;
  const max = cost.max;
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

/**
 * Cost in micro-USD per 1 unit of the send currency, for RANGE offers — derived
 * from the offer's own cost/send bounds and rounded UP, so the recipient never
 * receives less than the quote promised.
 *
 * dto.Cost and dto.Zend both also carry an `fx` number, which would be the direct
 * source for this, but the spec gives it no description and the API guide does not
 * say which way round it points. Deriving from the bounds is self-consistent within
 * one payload; cross-check `fx` against this on the first sandbox run before
 * switching over (docs/SUPPLIERS.md).
 */
export function costPerSendUnit(_o: ZOffer, mapped: Pick<Offer, "costMinMicro" | "sendMin">): number | undefined {
  if (mapped.costMinMicro !== undefined && mapped.sendMin) return Math.ceil(mapped.costMinMicro / mapped.sendMin);
  return undefined;
}
