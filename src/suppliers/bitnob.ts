// Bitnob payout adapter — international payments (bank transfer / mobile money)
// executed by Bitnob out of a stablecoin balance we prefund with them.
//
// Verified field-by-field 2026-08-28 against Bitnob's OWN OpenAPI 3.0.3 spec
// ("Bitnob API v2" 2.0.0), published at
//   https://bitnob.dev/api-collections/swagger/bitnob-api-v2.openapi.json
// A copy of what was checked, and what the spec does NOT answer, is in docs/PAYOUTS.md.
//
// Three things about this API shape the adapter:
//
// 1. Auth is HMAC, not a bearer token. Every request carries X-Auth-Client /
//    X-Auth-Timestamp / X-Auth-Nonce / X-Auth-Signature, where the signature is
//    hex(HMAC-SHA256("<client_id>:<unix_seconds>:<nonce>:<body>", client_secret)).
//    The signed body must be the exact bytes sent, so call() serialises ONCE.
//
// 2. A payout is THREE calls, not one: quote → initialize → finalize. Money only
//    leaves on finalize. That makes a crash mid-flow recoverable but not automatic,
//    so getPurchase() can resume a half-built payout (see resumeFrom).
//
// 3. There is no "get payout by my reference" endpoint — GET /api/payouts takes only
//    limit/offset. Our order id travels as `reference` and is recovered by a bounded
//    scan of recent payouts. Bitnob confirmed 2026-08-31 that they will "look into"
//    adding one and that get-by-id works today, so the scan stays until they ship it. The order layer polls by OUR order id when a purchase
//    outcome is unknown (src/orders.ts processOnce), and refunds if that lookup says
//    "failed", so this path is what stops us refunding a payer whose money was sent.

import { createHmac, randomBytes } from "node:crypto";
import { countryOfMsisdn } from "../phone.js";
import { SupplierError, type Offer, type PayoutMethod, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "./types.js";

const M = 1_000_000;

/** Every 2xx body is { success, message, data, timestamp }; errors are RFC-7807-ish. */
type BEnvelope<T> = { success?: boolean; message?: string; data?: T };
type BError = { title?: string; detail?: string; code?: string; status?: number; correlation_id?: string };

type BExchangeRate = { rate?: string; effective_rate?: string; currency?: string };
type BBeneficiary = { destination_type?: string; country?: string; account_name?: string; account_number?: string; bank_code?: string };
/** The one resource the payout endpoints all return, under data.payout. */
type BPayout = {
  id: string; quote_id?: string; status: string; source?: string; from_asset?: string; to_currency?: string;
  amount?: string; settlement_amount?: string; fees?: string; exchange_rate?: BExchangeRate; beneficiary?: BBeneficiary;
  reference?: string; payment_reason?: string; country?: string; provider_settlement_id?: string; expires_at?: string;
};
type BCorridor = { currency: string; destination_types: string[] };
type BCountry = { code: string; name: string; corridors?: BCorridor[] };
type BLimit = { country: string; currency: string; min_amount: string; max_amount: string };
type BField = { key: string; required?: boolean };
type BCountryDetail = { code: string; name: string; destination_types?: Record<string, { fields?: BField[] }> };
type BRate = { target_currency?: string; buy_rate?: string; sell_rate?: string };
type BAccount = { currency: string; available_balance?: string; available_balance_formatted?: string };

/** What one listable corridor is, once the four Bitnob endpoints are joined up. */
type Corridor = {
  country: string; currency: string; destination: BitnobDestination;
  min: number; max: number; rate: number; requiredFields?: string[];
};

/** Bitnob's `destination_type` values, minus `swift`. SWIFT needs a beneficiary
 *  address, an intermediary bank and days of settlement — none of which fits a
 *  $200-capped payment an agent makes on behalf of a named human, so those
 *  corridors are not advertised at all rather than advertised and then refused. */
type BitnobDestination = "bank" | "mobile_money";
const DESTINATIONS: Record<BitnobDestination, { method: PayoutMethod; label: string; settlementSeconds: number }> = {
  // Settlement seconds are Bitnob's DOCUMENTED corridor estimates (mobile money
  // "real-time to under 2 minutes", bank "same day or next day"), not an API field.
  // Quoted conservatively: this number is shown to the payer before they sign.
  bank: { method: "bank", label: "Bank transfer", settlementSeconds: 86_400 },
  mobile_money: { method: "mobile_money", label: "Mobile money", settlementSeconds: 300 },
};

/** Bitnob is inconsistent about case and vocabulary — payouts answer QUOTE/INITIATED/
 *  PENDING/COMPLETED/FAILED, webhooks say initiated/processing/success/expired — so
 *  match case-insensitively and cover both. Anything unrecognised stays pending: the
 *  order layer times out and refunds, which is the safe direction for an unknown state. */
const DELIVERED = new Set(["completed", "complete", "success", "successful", "settled", "paid"]);
const FAILED = new Set(["failed", "failure", "rejected", "cancelled", "canceled", "expired", "reversed", "refunded", "declined"]);

const isUsableRate = (n: number): boolean => Number.isFinite(n) && n > 0;
const num = (s: string | undefined): number => (s === undefined || s === "" ? NaN : Number(s));

/** Cheap TTL cache. The corridor endpoints are catalogue data that changes daily at
 *  most, and /v1/catalog is an unauthenticated route — without this every catalogue
 *  hit would be three or four calls to a partner that rate-limits us. */
class Ttl<T> {
  private readonly v = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private readonly ms: number) {}
  get(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.v.get(key);
    if (hit && Date.now() - hit.at < this.ms) return hit.value;
    const value = make().catch((e) => { this.v.delete(key); throw e; });
    this.v.set(key, { at: Date.now(), value });
    return value;
  }
}

export class BitnobPayoutSupplier implements Supplier {
  readonly name = "payout:bitnob";
  private readonly countries = new Ttl<BCountry[]>(10 * 60_000);
  private readonly limits = new Ttl<Map<string, BLimit>>(10 * 60_000);
  private readonly rates = new Ttl<Map<string, number>>(60_000);
  private readonly details = new Ttl<BCountryDetail>(10 * 60_000);

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly opts: {
      baseUrl?: string;
      /** The stablecoin our Bitnob float is held in and payouts are debited from. */
      asset?: string;
      /** Refuse a payout whose quoted local amount falls this far below the rate the
       *  offer was priced from. 0 disables the check. */
      maxSlippageBps?: number;
      callbackUrl?: string;
      log?: (msg: string) => void;
    } = {},
  ) {
    if (!clientId || !clientSecret) throw new Error("PAYOUT_CLIENT_ID / PAYOUT_API_KEY (Bitnob client id + secret) missing");
    this.baseUrl = (opts.baseUrl || "https://api.bitnob.com").replace(/\/$/, "");
    this.asset = (opts.asset || "USDC").toUpperCase();
    this.maxSlippageBps = opts.maxSlippageBps ?? 200;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  private readonly baseUrl: string;
  private readonly asset: string;
  private readonly maxSlippageBps: number;
  private readonly log: (msg: string) => void;

  // ── transport ───────────────────────────────────────────────────────────────

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    // Sign the exact bytes we send. Serialising twice (once to sign, once to send)
    // is how HMAC integrations break: any difference is a 401 with no other symptom.
    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = createHmac("sha256", this.clientSecret)
      .update(`${this.clientId}:${timestamp}:${nonce}:${payload}`)
      .digest("hex");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-Auth-Client": this.clientId,
        "X-Auth-Timestamp": timestamp,
        "X-Auth-Nonce": nonce,
        "X-Auth-Signature": signature,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : payload,
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const e = (json ?? {}) as BError & BEnvelope<unknown>;
      const why = e.detail ?? e.message ?? e.title ?? text.slice(0, 200);
      const code = e.code ? ` [${e.code}]` : "";
      const corr = e.correlation_id ? ` (correlation_id ${e.correlation_id})` : "";
      throw new SupplierError(`bitnob ${method} ${path} → ${res.status}${code}: ${why}${corr}`, res.status >= 500 || res.status === 429);
    }
    const env = (json ?? {}) as BEnvelope<T>;
    if (env.data === undefined) throw new SupplierError(`bitnob ${method} ${path} returned no data envelope`);
    return env.data;
  }

  private payoutOf(data: { payout?: BPayout }, where: string): BPayout {
    const p = data?.payout;
    if (!p?.id) throw new SupplierError(`bitnob ${where} returned no payout id`);
    return p;
  }

  // ── catalogue ───────────────────────────────────────────────────────────────

  /** Local-currency units per 1 unit of our stablecoin, priced conservatively.
   *  Bitnob quotes a two-sided rate; taking the WORSE side means a quote can only
   *  come back better than the offer promised, never worse. */
  private async rateMap(): Promise<Map<string, number>> {
    return this.rates.get(this.asset, async () => {
      const d = await this.call<{ rates?: BRate[] }>("GET", `/api/exchange-rates?base=${encodeURIComponent(this.asset)}`);
      const m = new Map<string, number>();
      for (const r of d.rates ?? []) {
        if (!r.target_currency) continue;
        const sides = [num(r.buy_rate), num(r.sell_rate)].filter(isUsableRate);
        if (sides.length) m.set(r.target_currency.toUpperCase(), Math.min(...sides));
      }
      return m;
    });
  }

  private async limitMap(): Promise<Map<string, BLimit>> {
    return this.limits.get("all", async () => {
      const d = await this.call<{ limits?: BLimit[] }>("GET", "/api/payouts/limits");
      const m = new Map<string, BLimit>();
      for (const l of d.limits ?? []) m.set(`${l.country.toUpperCase()}|${l.currency.toUpperCase()}`, l);
      return m;
    });
  }

  private async countryList(): Promise<BCountry[]> {
    return this.countries.get("all", async () => {
      const d = await this.call<{ countries?: BCountry[] }>("GET", "/api/payouts/supported-countries");
      return d.countries ?? [];
    });
  }

  /** Per-country beneficiary requirements. This is the ONLY authoritative source for
   *  what a corridor needs — the fields differ per country and per destination type
   *  (NG bank wants a 10-digit account_number + bank_code; mobile-money corridors
   *  want their own set), and the spec does not enumerate them. */
  private async countryDetail(country: string): Promise<BCountryDetail> {
    return this.details.get(country, () => this.call<BCountryDetail>("GET", `/api/payouts/supported-countries/${encodeURIComponent(country)}`));
  }

  private async requiredFieldsFor(country: string, destination: BitnobDestination): Promise<string[]> {
    const detail = await this.countryDetail(country);
    const spec = detail.destination_types?.[destination];
    const keys = (spec?.fields ?? []).filter((f) => f.required !== false).map((f) => f.key).filter(Boolean);
    // account_name is required by the initialize body but is not part of the per-country
    // field list, and payment_reason is required on the quote. Both must come from the
    // human principal — an agent must never invent either (docs/PAYOUTS.md).
    return [...new Set(["account_name", ...keys, "payment_reason"])];
  }

  private async corridorsOf(country?: string): Promise<Corridor[]> {
    const [countries, limits, rates] = await Promise.all([this.countryList(), this.limitMap(), this.rateMap()]);
    const wanted = country ? countries.filter((c) => c.code.toUpperCase() === country.toUpperCase()) : countries;
    const out: Corridor[] = [];
    for (const c of wanted) {
      for (const corridor of c.corridors ?? []) {
        const currency = corridor.currency.toUpperCase();
        const rate = rates.get(currency);
        const limit = limits.get(`${c.code.toUpperCase()}|${currency}`);
        // No published rate or no published limit means we cannot price or bound the
        // corridor. Advertising it would produce a quote we cannot honour.
        if (!limit || !rate || !isUsableRate(rate)) continue;
        const min = num(limit.min_amount);
        const max = num(limit.max_amount);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) continue;
        for (const dt of corridor.destination_types ?? []) {
          if (!(dt in DESTINATIONS)) continue;
          out.push({ country: c.code.toUpperCase(), currency, destination: dt as BitnobDestination, min, max, rate });
        }
      }
    }
    // Beneficiary requirements are one extra call PER COUNTRY, so they are resolved
    // only for a country-filtered listing (and always in getOffer, which is what
    // POST /v1/quote validates against). An unfiltered catalogue stays three calls.
    if (country) {
      await Promise.all(out.map(async (c) => { c.requiredFields = await this.requiredFieldsFor(c.country, c.destination); }));
    }
    return out;
  }

  private offerIdOf(c: Pick<Corridor, "country" | "currency" | "destination">): string {
    return `bn-${c.country}-${c.currency}-${c.destination}`;
  }

  private parseOfferId(id: string): { country: string; currency: string; destination: BitnobDestination } | null {
    const m = /^bn-([A-Z]{2})-([A-Z]{3})-(bank|mobile_money)$/.exec(id);
    return m ? { country: m[1], currency: m[2], destination: m[3] as BitnobDestination } : null;
  }

  private toOffer(c: Corridor): Offer {
    const d = DESTINATIONS[c.destination];
    // Cost per 1 unit of local currency, rounded UP so a whole quote can never be
    // priced below what the corridor will actually cost us.
    const costPerSendUnitMicro = Math.ceil(M / c.rate);
    return {
      id: this.offerIdOf(c),
      type: "payout",
      country: c.country,
      brand: c.destination.toUpperCase(),
      brandName: d.label,
      name: `${d.label} · ${c.currency}`,
      notes: `Executed by Bitnob. Bitnob's own fee and rate are locked when the payout is quoted at purchase time; the delivered amount is reported on the receipt.`,
      priceType: "range",
      sendCurrency: c.currency,
      sendMin: c.min,
      sendMax: c.max,
      costPerSendUnitMicro,
      costMinMicro: Math.ceil(c.min * costPerSendUnitMicro),
      costMaxMicro: Math.ceil(c.max * costPerSendUnitMicro),
      payoutMethod: d.method,
      requiredFields: c.requiredFields,
      settlementSeconds: d.settlementSeconds,
    };
  }

  // ── Supplier ────────────────────────────────────────────────────────────────

  readonly productTypes = ["payout"] as const;

  async lookupPhone(msisdn: string): Promise<PhoneLookup> {
    return { msisdn, country: countryOfMsisdn(msisdn) };
  }

  async listOffers(q: { type: ProductType; country?: string; brand?: string }): Promise<Offer[]> {
    if (q.type !== "payout") return [];
    const corridors = await this.corridorsOf(q.country);
    return corridors
      .map((c) => this.toOffer(c))
      .filter((o) => !q.brand || o.brand === q.brand.toUpperCase());
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type !== "payout") return null;
    const parsed = this.parseOfferId(id);
    if (!parsed) return null;
    const corridors = await this.corridorsOf(parsed.country);
    const found = corridors.find((c) => c.currency === parsed.currency && c.destination === parsed.destination);
    return found ? this.toOffer(found) : null;
  }

  /**
   * quote → initialize → finalize.
   *
   * The quote is denominated in the ASSET we spend (like Zendit's `{type: "COST"}`
   * purchases), so the payer is never charged more than the order took. What that
   * buys in local currency is Bitnob's number, checked against the rate the offer was
   * priced from before anything is initialised — see the slippage guard below.
   */
  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    if (req.type !== "payout") throw new SupplierError(`bitnob does not sell ${req.type}`);
    if (!req.sender?.name || !req.sender?.country) throw new SupplierError("payout requires a sender record (name, country)");
    const parsed = this.parseOfferId(req.offerId);
    if (!parsed) throw new SupplierError(`not a bitnob payout offer: ${req.offerId}`);
    const fields = req.recipient.fields ?? {};
    if (!fields.account_name) throw new SupplierError("payout requires recipient.fields.account_name");
    const paymentReason = fields.payment_reason;
    if (!paymentReason) throw new SupplierError("payout requires recipient.fields.payment_reason");

    try {
      const quote = await this.quote(req, parsed, paymentReason);
      const initialized = await this.initialize(quote, req, parsed, fields, paymentReason);
      return this.map(await this.finalize(initialized));
    } catch (e) {
      // `reference` is a deduplication key that Bitnob stores and enforces, so a
      // retried create is REJECTED rather than deduplicated (the Reloadly footgun,
      // see src/suppliers/reloadly.ts). Written defensively from the docs, and
      // **confirmed by Bitnob on Discord 2026-08-31: "Duplicate reference will be
      // rejected."** The first attempt may already have built — or sent — the payout,
      // so resolve the existing one instead of failing into a refund for money that
      // moved. Without this path a timeout on finalize would refund a payer whose
      // beneficiary had already been credited.
      if (!(e instanceof SupplierError) || e.retryable) throw e;
      const existing = await this.findByReference(req.orderId).catch(() => undefined);
      if (!existing) throw e;
      this.log(`[bitnob ${req.orderId}] recovering existing payout ${existing.id} (${existing.status}) after: ${e.message}`);
      return this.map(await this.resumeFrom(existing));
    }
  }

  private async quote(req: PurchaseRequest, parsed: { country: string; currency: string }, paymentReason: string): Promise<BPayout> {
    const d = await this.call<{ payout?: BPayout }>("POST", "/api/payouts/quotes", {
      from_asset: this.asset,
      to_currency: parsed.currency,
      source: "offchain", // debit our prefunded Bitnob balance; "onchain" would make us send crypto per payout
      country: parsed.country,
      amount: (req.costMicro / M).toFixed(6),
      payment_reason: paymentReason,
      reference: req.orderId,
    });
    const quote = this.payoutOf(d, "POST /api/payouts/quotes");
    if (!quote.quote_id) throw new SupplierError("bitnob quote returned no quote_id");
    await this.assertWithinSlippage(quote, req, parsed);
    return quote;
  }

  /**
   * Refuse a quote that buys materially less local currency than the offer promised.
   *
   * The offer is priced from GET /api/exchange-rates; the payout is priced by
   * POST /api/payouts/quotes, which also applies Bitnob's own fee and spread. If the
   * two disagree, the payer signed for one amount and the recipient would get another.
   * Failing here costs nothing — the payer is refunded on chain and no payout exists.
   * (The gap between `rate` and `effective_rate` on the quote is that spread; it is
   * logged on every purchase so the first live run measures it.)
   */
  private async assertWithinSlippage(quote: BPayout, req: PurchaseRequest, parsed: { country: string; currency: string }): Promise<void> {
    const delivered = num(quote.settlement_amount);
    const rate = (await this.rateMap()).get(parsed.currency);
    this.log(
      `[bitnob ${req.orderId}] quote ${quote.quote_id}: ${quote.amount} ${this.asset} → ${quote.settlement_amount} ${parsed.currency}` +
      ` (fees ${quote.fees ?? "?"}, rate ${quote.exchange_rate?.rate ?? "?"}, effective ${quote.exchange_rate?.effective_rate ?? "?"}, published ${rate ?? "?"})`,
    );
    if (!this.maxSlippageBps || !rate || !isUsableRate(rate) || !isUsableRate(delivered)) return;
    const promised = (req.costMicro / M) * rate;
    const floor = promised * (1 - this.maxSlippageBps / 10_000);
    if (delivered < floor) {
      throw new SupplierError(
        `bitnob quote delivers ${delivered} ${parsed.currency} for ${(req.costMicro / M).toFixed(6)} ${this.asset}, ` +
        `below the ${floor.toFixed(2)} implied by the quoted rate (${this.maxSlippageBps} bps tolerance) — refusing before the payout is initialised`,
      );
    }
  }

  private async initialize(quote: BPayout, req: PurchaseRequest, parsed: { country: string; destination: BitnobDestination }, fields: Record<string, string>, paymentReason: string): Promise<BPayout> {
    // Pass through whatever the corridor asked for (bank_code, account_number and any
    // corridor-specific keys from GET /api/payouts/supported-countries/{country}),
    // minus the two we place ourselves. Unknown keys are the partner's to reject.
    const { account_name, payment_reason: _reason, ...rest } = fields;
    const d = await this.call<{ payout?: BPayout }>("POST", `/api/payouts/${encodeURIComponent(quote.quote_id!)}/initialize`, {
      quote_id: quote.quote_id,
      reference: req.orderId,
      payment_reason: paymentReason,
      ...(this.opts.callbackUrl ? { callback_url: this.opts.callbackUrl } : {}),
      beneficiary: {
        destination_type: parsed.destination,
        country: parsed.country,
        account_name,
        ...rest,
      },
    });
    return this.payoutOf(d, "POST /api/payouts/{quoteId}/initialize");
  }

  /** The only step that moves money. */
  private async finalize(initialized: BPayout): Promise<BPayout> {
    const quoteId = initialized.quote_id;
    if (!quoteId) throw new SupplierError("bitnob initialize returned no quote_id to finalize");
    const d = await this.call<{ payout?: BPayout }>("POST", `/api/payouts/${encodeURIComponent(quoteId)}/finalize`, {});
    return this.payoutOf(d, "POST /api/payouts/{quoteId}/finalize");
  }

  /**
   * Poll a payout.
   *
   * Accepts either Bitnob's payout id or OUR order id: the order layer polls with our
   * id whenever the purchase outcome is unknown, and answering "failed" to that would
   * refund a payer whose recipient was already paid.
   */
  async getPurchase(_type: ProductType, id: string): Promise<PurchaseResult> {
    let payout: BPayout | undefined;
    if (!id.startsWith("ord_")) {
      payout = await this.call<{ payout?: BPayout }>("GET", `/api/payouts/${encodeURIComponent(id)}`)
        .then((d) => d?.payout)
        .catch((e) => {
          if (e instanceof SupplierError && !e.retryable) return undefined; // 404: fall through to the reference scan
          throw e;
        });
    }
    payout ??= await this.findByReference(id);
    if (!payout) throw new SupplierError(`bitnob has no payout for reference ${id}`, true);
    // A payout that was quoted or initialised but never finalised is money that never
    // left. Once its window has closed it cannot be finalised, so call it failed now
    // rather than letting the order sit until the fulfilment timeout — the payer gets
    // refunded sooner and the outcome is the same.
    return this.map(await this.resumeFrom(payout));
  }

  /**
   * Carry a half-built payout to its end.
   *
   * quote → initialize → finalize is three calls, and a crash (or a lost response)
   * between them leaves a payout that is real but has not sent anything. Within the
   * quote's window the right move is to continue it, not to abandon a payer's money.
   */
  private async resumeFrom(payout: BPayout): Promise<BPayout> {
    const status = payout.status?.toLowerCase() ?? "";
    if (status !== "quote" && status !== "initiated") return payout;
    if (this.hasExpired(payout)) return { ...payout, status: "EXPIRED" };
    if (status === "quote") {
      this.log(`[bitnob ${payout.reference ?? payout.id}] payout is still a quote; it was never initialised`);
      return payout; // beneficiary details are not on the payout: only purchase() can initialise it
    }
    this.log(`[bitnob ${payout.reference ?? payout.id}] finalising a payout left INITIATED`);
    return this.finalize(payout);
  }

  private hasExpired(p: BPayout): boolean {
    const t = p.expires_at ? Date.parse(p.expires_at) : NaN;
    return Number.isFinite(t) && t < Date.now();
  }

  /**
   * Find a payout by the `reference` we set to our order id.
   *
   * GET /api/payouts takes only limit/offset — there is no reference filter — so this
   * is a bounded scan of recent payouts, newest first. It is a recovery path, not a
   * hot path. If our payout is older than the scan window the caller gets "not found",
   * which is retryable, so the order stays open rather than refunding wrongly.
   */
  private async findByReference(reference: string, maxPages = 5, pageSize = 100): Promise<BPayout | undefined> {
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const d = await this.call<{ items?: BPayout[]; has_more?: boolean }>("GET", `/api/payouts?limit=${pageSize}&offset=${offset}`);
      const items = d.items ?? [];
      const hit = items.find((p) => p.reference === reference);
      if (hit) return hit;
      if (items.length === 0 || d.has_more === false) return undefined;
      // Advance by what came back, NOT by what was asked for: the endpoint documents a
      // default page of 20 and is free to cap `limit`, and paging by the requested size
      // over a smaller page would step straight over the payout we are looking for.
      offset += items.length;
    }
    return undefined;
  }

  /** The float we prefund Bitnob with, in micro-USD. */
  async balanceMicro(): Promise<number> {
    const d = await this.call<{ accounts?: BAccount[] }>("GET", "/api/balances");
    const account = (d.accounts ?? []).find((a) => a.currency?.toUpperCase() === this.asset);
    if (!account) throw new SupplierError(`bitnob has no ${this.asset} account (found: ${(d.accounts ?? []).map((a) => a.currency).join(", ") || "none"})`);
    return balanceMicroOf(account, this.asset);
  }

  async fxRate(currency: string): Promise<number | null> {
    const rate = (await this.rateMap()).get(currency.toUpperCase());
    return rate && isUsableRate(rate) ? rate : null;
  }

  private map(p: BPayout): PurchaseResult {
    const supplierTxId = p.id;
    const status = (p.status ?? "").toLowerCase();
    if (DELIVERED.has(status)) {
      return {
        supplierTxId,
        status: "delivered",
        confirmation: {
          partnerReference: p.provider_settlement_id ?? p.quote_id ?? supplierTxId,
          // What the recipient actually got, at the rate Bitnob locked. The offer's
          // rate was indicative; this is the number that belongs on the receipt.
          delivered_amount: p.settlement_amount,
          delivered_currency: p.to_currency,
          fees: p.fees,
          rate: p.exchange_rate?.effective_rate ?? p.exchange_rate?.rate,
          method: p.beneficiary?.destination_type,
        },
      };
    }
    if (FAILED.has(status)) return { supplierTxId, status: "failed", error: p.status };
    return { supplierTxId, status: "pending" };
  }
}

/**
 * A Bitnob balance in micro-USD.
 *
 * `available_balance` is an unscaled integer string and the spec never states its
 * divisor; `available_balance_formatted` ("2.995328 USDC") states it in the open.
 * Six decimals is right for USDC/USDT and matches the paired example, but a silently
 * wrong divisor here is a 1000× error in a preflight balance check, so the two are
 * cross-checked and a disagreement is an error rather than a guess.
 */
export function balanceMicroOf(account: { available_balance?: string; available_balance_formatted?: string }, asset: string): number {
  const raw = num(account.available_balance);
  const formatted = Number(/^\s*(-?[\d.]+)/.exec(account.available_balance_formatted ?? "")?.[1] ?? NaN);
  const fromRaw = Number.isFinite(raw) ? Math.round(raw) : NaN; // already micro-units at 6 dp
  const fromFormatted = Number.isFinite(formatted) ? Math.round(formatted * M) : NaN;
  if (!Number.isFinite(fromRaw) && !Number.isFinite(fromFormatted)) throw new SupplierError(`bitnob ${asset} balance is unreadable`);
  if (!Number.isFinite(fromRaw)) return fromFormatted;
  if (!Number.isFinite(fromFormatted)) return fromRaw;
  if (Math.abs(fromRaw - fromFormatted) > 1) {
    throw new SupplierError(
      `bitnob ${asset} balance is ambiguous: available_balance=${account.available_balance} reads as ` +
      `${(fromRaw / M).toFixed(6)} but available_balance_formatted says "${account.available_balance_formatted}". ` +
      `The minor-unit divisor is not 1e6 — fix balanceMicroOf before trusting any balance check.`,
    );
  }
  return fromFormatted;
}
