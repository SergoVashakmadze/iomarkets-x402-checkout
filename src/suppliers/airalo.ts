// Airalo Partner API adapter — travel eSIMs (`type: "esim"`).
//
// WHY THIS EXISTS. eSIMs have been blocked since 2026-08-28 on Zendit re-denominating a
// GBP account, and they never had to be: Airalo runs a self-serve partner programme with
// a public API. An eSIM is an $8–30 ticket against airtime's $1–5, has no recipient to
// verify and no MVNO voucher trap, and is the most agent-native good in the catalogue —
// the deliverable is an LPA activation string, not something posted to a person.
// docs/REVENUE-SOURCES.md §A1.
//
// ── VERIFIED against Airalo's own PHP SDK (github.com/Airalo/airalo-php-sdk, v2.0.1) ──
//
// The published docs are an Angular app that serves no machine-readable spec — the same
// situation as Reloadly, and the same answer: the vendor's own SDK carries the wire
// field names. Read 2026-09-01 from src/Constants/ApiConstants.php, src/Services/* and
// the README's response samples.
//
//   • Base URL `https://partners-api.airalo.com/v2/` (ApiConstants::PRODUCTION_URL).
//   • Auth: POST `token`, form-encoded {client_id, client_secret, grant_type} plus an
//     `airalo-signature` header = HMAC-SHA512 of the JSON payload under the client
//     secret (Helpers/Signature.php). Token at `data.access_token`.
//   • `GET packages?include=topup&filter[country]=XX&limit=N` → a nested
//     country → operators[] → packages[] shape, paginated via `meta.last_page`.
//   • **Prices are published in USD explicitly** at `prices.net_price.USD`. That is the
//     single reason this adapter can exist and Zendit's cannot: no FX leg, no rate
//     source, no spread to invent. `net_price` (top level) is the account-currency
//     figure; we read the USD map and refuse if it is absent, rather than assuming.
//   • `POST orders` with {package_id, quantity, type:"sim", description}, the same
//     signature header. Response `data.sims[]` carries `iccid`, `lpa`, `matching_id`,
//     `qrcode` (the LPA string, e.g. `LPA:1$lpa.airalo.com$TEST`) and `qrcode_url`.
//   • Quantity is capped at 50 (SdkConstants::ORDER_LIMIT). We only ever order 1.
//
// ── ⚠️ NOT VERIFIED, and one of them is dangerous ─────────────────────────────
//
// **1. There is no idempotency key and no order-lookup endpoint.** The SDK exposes
//    `order`, `orderAsync` and `orderBulk` — and no `getOrder`, no order list, no
//    filter. So if `POST orders` times out, nothing in the documented API answers "did
//    that go through?". Every other adapter here has a recovery path for exactly this:
//    Zendit's `transactionId` is client-supplied and idempotent, and Reloadly's
//    `customIdentifier` is at least *searchable*. Airalo appears to have neither.
//
//    What this adapter does about it: our order id travels in `description`, so the
//    record is reconcilable by a human in the dashboard; and an unknown outcome is
//    reported **pending and retryable** rather than failed, so the order layer keeps
//    polling instead of refunding a payer whose eSIM was in fact issued. It logs loudly
//    with the order id when that happens. **This is a mitigation, not a fix** — confirm
//    on the first live run whether an order lookup exists (ask partner support: "is
//    there an endpoint to fetch an order by id or by description?"). Until then, treat a
//    timeout as needing manual reconciliation.
//
// **2. No balance endpoint exists in the SDK**, so we do not know whether a partner
//    account is prepaid, invoiced monthly, or credit-based. `balanceMicro()` therefore
//    throws rather than guessing a number the float gate would then enforce.
//
// **3. No sandbox base URL is published in the SDK** (only PRODUCTION_URL). Ask.
//
// `ESIM_SUPPLIER` is unset by default until 1 and 3 are answered — the same discipline
// every other adapter in this directory went through, and the reason none of them has
// ever double-charged anyone.

import { createHmac } from "node:crypto";
import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "./types.js";

const M = 1_000_000;

/** One package inside `data[].operators[].packages[]`. */
interface APackage {
  id?: string;
  type?: string;
  title?: string;
  price?: number;
  net_price?: number;
  /** Per-currency maps. `prices.net_price.USD` is the number we price from. */
  prices?: { net_price?: Record<string, number>; recommended_retail_price?: Record<string, number> };
  /** Megabytes. `is_unlimited` true means `amount` is meaningless. */
  amount?: number;
  day?: number;
  is_unlimited?: boolean;
  data?: string;
  short_info?: string;
  voice?: string | null;
  text?: string | null;
}

interface AOperator {
  title?: string;
  is_roaming?: boolean;
  plan_type?: string;
  activation_policy?: string;
  countries?: Array<{ country_code?: string }>;
  packages?: APackage[];
}

interface APackagesPage {
  data?: Array<{ slug?: string; operators?: AOperator[] }>;
  meta?: { last_page?: number };
}

/** `data.sims[]` on an order response — the deliverable. */
interface ASim {
  id?: number;
  iccid?: string;
  lpa?: string;
  matching_id?: string;
  /** The full LPA string the buyer installs: `LPA:1$<lpa>$<matching_id>`. */
  qrcode?: string;
  qrcode_url?: string;
  apn_type?: string;
  apn_value?: string | null;
  is_roaming?: boolean;
  confirmation_code?: string | null;
  msisdn?: string | null;
}

interface AOrder {
  id?: number;
  code?: string;
  currency?: string;
  package_id?: string;
  quantity?: number;
  esim_type?: string;
  validity?: number;
  package?: string;
  data?: string;
  price?: number;
  net_price?: number;
  description?: string;
  manual_installation?: string;
  installation_guides?: Record<string, string>;
  sims?: ASim[];
}

export class AiraloSupplier implements Supplier {
  readonly name = "airalo";
  /** eSIMs only. Airalo sells nothing else we resell. */
  readonly productTypes = ["esim"] as const;

  private token: { value: string; expiresAt: number } | null = null;
  /** Offers cached for the quote TTL so purchase() can read a cost without a round trip. */
  private offers: { at: number; byId: Map<string, Offer> } = { at: 0, byId: new Map() };

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly baseUrl = "https://partners-api.airalo.com/v2/",
  ) {
    if (!clientId || !clientSecret) throw new SupplierError("Airalo needs AIRALO_CLIENT_ID and AIRALO_CLIENT_SECRET");
  }

  /**
   * HMAC-SHA512 of the JSON payload under the client secret, sent as `airalo-signature`.
   * Airalo's Signature helper re-encodes a string payload through decode/encode to strip
   * whitespace; we only ever sign objects we serialise ourselves, so `JSON.stringify` is
   * already the canonical form.
   */
  private sign(payload: unknown): string {
    return createHmac("sha512", this.clientSecret).update(JSON.stringify(payload)).digest("hex");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const payload = { client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" };
    const res = await fetch(`${this.baseUrl}token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "airalo-signature": this.sign(payload) },
      body: new URLSearchParams(payload).toString(),
    }).catch((e: unknown) => { throw new SupplierError(`airalo token: ${(e as Error).message}`, true); });

    const body = (await res.json().catch(() => ({}))) as { data?: { access_token?: string; expires_in?: number } };
    const token = body.data?.access_token;
    // Never echo the response body — it is the one place a credential could surface.
    if (!res.ok || !token) throw new SupplierError(`airalo token: HTTP ${res.status}`, res.status >= 500);
    // The SDK caches by a fixed TTL rather than reading expires_in; be conservative.
    this.token = { value: token, expiresAt: Date.now() + Math.min((body.data?.expires_in ?? 3600) * 1000, 3600_000) };
    return token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${await this.accessToken()}` },
    }).catch((e: unknown) => { throw new SupplierError(`airalo GET ${path}: ${(e as Error).message}`, true); });
    if (!res.ok) throw new SupplierError(`airalo GET ${path}: HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    return (await res.json()) as T;
  }

  /**
   * The USD net price, in micro-USD.
   *
   * Reads `prices.net_price.USD` and **refuses anything else**. The top-level
   * `net_price` is denominated in the partner account's own currency, which is exactly
   * the trap that made Zendit unusable: every field name was right and the account was
   * in GBP. A missing USD entry is an error, never a fallback to a number whose
   * currency we are guessing at.
   */
  private static costMicro(p: APackage): number {
    const usd = p.prices?.net_price?.USD;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      throw new SupplierError(`airalo package ${p.id ?? "?"} has no USD net price — we price in USD and will not infer FX`);
    }
    return Math.round(usd * M);
  }

  private static toOffer(pkg: APackage, op: AOperator, slug?: string): Offer | null {
    if (!pkg.id) return null;
    const countries = (op.countries ?? []).map((c) => c.country_code).filter((c): c is string => Boolean(c));
    return {
      id: `as-${pkg.id}`,
      type: "esim",
      // A global/regional package covers many countries; "WW" is the convention the
      // mock catalogue already uses for one.
      country: countries.length === 1 ? countries[0].toUpperCase() : "WW",
      brand: "AIRALO",
      brandName: op.title ?? "Airalo",
      name: pkg.title ?? pkg.data ?? pkg.id,
      notes: [pkg.short_info, op.activation_policy ? `activation: ${op.activation_policy}` : null].filter(Boolean).join(" · ") || undefined,
      priceType: "fixed",
      costMicro: AiraloSupplier.costMicro(pkg),
      // `amount` is megabytes; unlimited packages report an amount that means nothing.
      dataGB: pkg.is_unlimited || !pkg.amount ? undefined : Math.round((pkg.amount / 1024) * 100) / 100,
      durationDays: pkg.day,
      regions: countries.length > 1 ? countries.map((c) => c.toUpperCase()) : slug ? [slug] : undefined,
      // Issued immediately; the buyer installs it themselves.
      settlementSeconds: 30,
    };
  }

  async listOffers(q: { type: ProductType; country?: string; brand?: string; limit?: number }): Promise<Offer[]> {
    if (q.type !== "esim") return [];
    const params = new URLSearchParams({ include: "topup", limit: String(Math.min(q.limit ?? 50, 100)) });
    if (q.country) params.set("filter[country]", q.country.toUpperCase());
    const page = await this.get<APackagesPage>(`packages?${params}`);

    const out: Offer[] = [];
    for (const entry of page.data ?? []) {
      for (const op of entry.operators ?? []) {
        for (const pkg of op.packages ?? []) {
          // One unpriceable package must not hide the rest of the catalogue.
          try {
            const offer = AiraloSupplier.toOffer(pkg, op, entry.slug);
            if (offer) out.push(offer);
          } catch { /* skipped: no USD price */ }
        }
      }
    }
    this.offers = { at: Date.now(), byId: new Map(out.map((o) => [o.id, o])) };
    return out;
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type !== "esim") return null;
    if (Date.now() - this.offers.at < 10 * 60_000) {
      const hit = this.offers.byId.get(id);
      if (hit) return hit;
    }
    // No get-package-by-id endpoint exists, so re-list and match. Cheap: the catalogue
    // is cached for the quote TTL and this only runs on a cold cache.
    const all = await this.listOffers({ type: "esim", limit: 100 });
    return all.find((o) => o.id === id) ?? null;
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    if (req.type !== "esim") throw new SupplierError(`airalo does not sell ${req.type}`);
    const packageId = req.offerId.replace(/^as-/, "");
    const payload = {
      package_id: packageId,
      quantity: 1,
      type: "sim",
      // Our order id, carried into Airalo's own record. It is NOT an idempotency key —
      // see the header — but it is what makes a timed-out order reconcilable by a human.
      description: `iomarkets ${req.orderId}`,
    };

    const res = await fetch(`${this.baseUrl}orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${await this.accessToken()}`,
        "airalo-signature": this.sign(payload),
      },
      body: JSON.stringify(payload),
    }).catch((e: unknown) => {
      // A network failure here is the dangerous case: the order may or may not exist and
      // nothing in the API can tell us. Retryable, so the order layer keeps polling
      // rather than refunding a payer whose eSIM was issued.
      throw new SupplierError(
        `airalo order ${req.orderId} did not complete (${(e as Error).message}). ` +
          `Airalo publishes no order-lookup endpoint, so this needs manual reconciliation — ` +
          `search the dashboard for description "iomarkets ${req.orderId}" before re-ordering.`,
        true,
      );
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupplierError(`airalo order: HTTP ${res.status} ${detail.slice(0, 200)}`, res.status >= 500 || res.status === 429);
    }
    const body = (await res.json().catch(() => ({}))) as { data?: AOrder };
    return AiraloSupplier.map(body.data, req.orderId);
  }

  /** Order response → PurchaseResult. Tolerant of absent fields rather than assuming them. */
  static map(order: AOrder | undefined, orderId: string): PurchaseResult {
    const sim = order?.sims?.[0];
    const supplierTxId = order?.id !== undefined ? String(order.id) : order?.code ?? "";
    if (!sim?.qrcode && !sim?.iccid) {
      // An order that came back without a SIM is not a delivery. Pending rather than
      // failed: `orders-async` exists, so an accepted-but-not-yet-issued state is
      // plausible and refunding it would be wrong.
      return { supplierTxId, status: "pending", error: `airalo order ${orderId} returned no eSIM yet` };
    }
    return {
      supplierTxId,
      status: "delivered",
      confirmation: {
        // The string a phone installs. This IS the deliverable.
        lpa: sim.qrcode ?? (sim.lpa && sim.matching_id ? `LPA:1$${sim.lpa}$${sim.matching_id}` : undefined),
        iccid: sim.iccid,
        smdp_address: sim.lpa,
        activation_code: sim.matching_id,
        qrcode_url: sim.qrcode_url,
        apn: sim.apn_value ?? sim.apn_type,
        package: order?.package,
        data: order?.data,
        validity_days: order?.validity,
        order_code: order?.code,
        install_guide: order?.installation_guides?.en,
      },
    };
  }

  /**
   * Airalo publishes no order-lookup endpoint, so this cannot answer for an id it did
   * not just create. Retryable by design: the order layer keeps polling to its timeout
   * rather than reading "unknown" as "failed" and refunding a delivered eSIM.
   */
  async getPurchase(type: ProductType, supplierTxId: string): Promise<PurchaseResult> {
    if (type !== "esim") throw new SupplierError(`airalo does not sell ${type}`);
    throw new SupplierError(
      `airalo publishes no order-lookup endpoint, so order ${supplierTxId} cannot be confirmed by API — ` +
        `reconcile it in the partner dashboard by its description before treating it as failed.`,
      true,
    );
  }

  /**
   * Unknown, deliberately. No balance endpoint appears in Airalo's SDK, so we do not
   * know whether a partner account is prepaid, invoiced or on credit — and a guessed
   * number here would be enforced by the float gate on every quote.
   */
  async balanceMicro(): Promise<number> {
    throw new SupplierError("airalo publishes no balance endpoint — the float gate cannot apply to eSIMs from this supplier");
  }

  /** eSIMs are not bought against a phone number. */
  async lookupPhone(msisdn: string): Promise<PhoneLookup> {
    return { msisdn, country: null };
  }
}
