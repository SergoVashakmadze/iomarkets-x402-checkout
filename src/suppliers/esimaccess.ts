// eSIM Access adapter — travel eSIMs (`type: "esim"`), wholesale white-label.
//
// WHY THIS EXISTS, AND WHY IT IS NOT AIRALO. Airalo's partner API is aimed at
// high-volume partners. eSIM Access is the
// opposite posture: **no MOQ, no contract, self-serve access code** from the developer
// console, deposit what you like. A supplier that lets a business start at zero and
// grow is worth more to us than a bigger catalogue we are not allowed to buy from.
//
// It is also, on the three things that actually matter to this codebase, a strictly
// better API than Airalo's — and those three were the reason `ESIM_SUPPLIER` stayed
// unset while `src/suppliers/airalo.ts` sat finished and unusable:
//
//   1. **A client-supplied idempotency key.** `transactionId` is ours, must be unique,
//      and a repeat is REFUSED with errorCode 310402 rather than silently charged
//      twice. Airalo has no such field, so a timed-out order there could not be
//      resolved in code at all.
//   2. **An order lookup.** `POST /esim/query` by `orderNo` returns the eSIM and echoes
//      our `transactionId`. Recovery after a timeout is an API call, not a human
//      reading a dashboard.
//   3. **A balance endpoint.** `POST /balance/query` returns the prepaid balance, so
//      the float gate applies to eSIMs exactly as it does to airtime and payouts.
//      Airalo publishes none, so `balanceMicro()` there throws.
//
// ── VERIFIED against the vendor's own published API reference ──────────────────
//
// Read 2026-09-02 from github.com/esimaccess/esimaccess-api (MIT, published by eSIM
// Access themselves as an agent skill): `references/api-reference.md` plus the
// 15-test `scripts/test-esim-api.mjs`. Same discipline as every other adapter here —
// Reloadly and Airalo were checked against vendor SDKs, Bitnob against its OpenAPI
// spec, and that method has caught a real money bug in two of the three.
//
//   • Base URL `https://api.esimaccess.com/api/v1/open`. **Every endpoint is POST**,
//     including the read-only ones, and an empty body is `{}` — not absent.
//   • Auth is a signature, not a bearer token: headers `RT-AccessCode`, `RT-Timestamp`
//     (ms), `RT-RequestID` (a UUID per request) and `RT-Signature` =
//     HMAC-SHA256(timestamp + requestId + accessCode + body) keyed by the access code
//     itself, lowercase hex. The body must be signed byte-for-byte as sent, so the
//     serialised string is built once and reused.
//   • ⚠️ **`200010` after an order means "not provisioned yet", not "failed"** — it arrives
//     as `success: false` within seconds of every order. Read as an error it refunds a payer
//     whose eSIM is being issued. Found on the first live order; see the record below.
//   • **Prices are USD × 10,000** (`18000` = $1.80) and every package carries
//     `currencyCode`. We assert it is USD and refuse the offer otherwise — the Zendit
//     trap, where every field name was right and the account was denominated in GBP.
//   • `price` is our wholesale cost; `retailPrice` is their suggested retail, which
//     `money.ts` never sees. Selling at retail is not our pricing model.
//
// ── ⚠️ NOT VERIFIED — read before turning this on ─────────────────────────────
//
// **1. There is no sandbox.** The vendor's own FAQ says so, and the console issues one
//    access code against the live account. Everything below is therefore written to be
//    safe on first contact with real money: read-only calls first (`pnpm check-esim`),
//    duplicate-proof ordering, and a recovery path that never reports "failed" for an
//    outcome it does not know. **The first live order is the integration test**, so buy
//    the cheapest package in the catalogue for it.
//
// **2. `periodNum` is "required only for daily plans" and nothing documents which
//    packages those are.** Sending it on a non-daily plan may be rejected; omitting it
//    on a daily one certainly is. So the order is attempted without it and retried once
//    WITH it on a validation error — safe precisely because `transactionId` is
//    idempotent: a rejected order was never created, and the retry carries the same id,
//    so the worst case is a duplicate error we already handle. Confirm the real rule on
//    the first live daily-plan order and delete the retry if it turns out to be
//    knowable from the catalogue.
//
// **3. `POST /esim/query` is documented to filter by `orderNo` or `iccid` — not by
//    `transactionId`**, even though every row it returns carries one. The recovery path
//    sends `transactionId` anyway and then RE-CHECKS the rows it gets back, falling
//    back to a bounded page scan if the filter was ignored. Never trust a filter the
//    docs do not promise; verify the row.
//
// **4. `location` on a package is undocumented in shape.** A single country code is
//    obvious; a multi-country string is not, so anything that is not exactly one
//    2-letter code becomes "WW" with the raw value preserved in `regions`.
//
// ── Credentials ─────────────────────────────────────────────────────────────
//
// **Treat the access code as a spending credential**: it authorises purchases against
// the prepaid balance. File at 0400 or a systemd credential, never `.env` in production,
// never a log line (`src/keys.ts`). If the account also has a secret key, requests are
// signed with it; otherwise with the access code, as the vendor reference describes.
//
// ── ✅ PROVEN LIVE AT ZERO BALANCE, 2026-09-02 ────────────────────────────────
//
// Ordering the cheapest US package on an unfunded account, against the real API:
//
//   refused:   200007 the balance is insufficient        → mapped non-retryable, correctly:
//                                                          an empty float is final and the
//                                                          payer is owed a refund
//   lookup:    310272 the orderNo doesn't exist          → the refused order created NOTHING
//   balance:   $0.00 before and after
//
// ── ✅ AND THEN THE FIRST REAL ORDER, 2026-09-02 ──────────────────────────────
//
// $0.30, the cheapest package in the catalogue, bought through this adapter:
//
//   orderNo B26090218000021 · iccid 8932042000021434248
//   lpa     LPA:1$rsp-eu.simlessly.com$57204EADFE6D45EEB61BC31279A37DF9
//   balance $50.00 → $49.70   ← exactly the quoted cost, to the cent
//
// **And it found a bug that would have shipped.** Seconds after the order, `/esim/query`
// answered `success:false, 200010` — the ordinary "not provisioned yet" state — and this
// adapter threw a NON-RETRYABLE error, which the order layer reads as "refund the payer".
// The eSIM was being issued at that moment. Fixed: `queryEsims()` maps 200010 to pending.
// Thirty cents to find "we refund people who received their goods".
//
// **Idempotency is now observed rather than asserted:** repeating the purchase with the same
// order id returned the SAME eSIM and did not move the balance.
//
// `docs/SUPPLIERS.md` has the full record, including the part that matters most — **the
// deposit is non-refundable by contract**, so the account is not a float, it is a purchase.

import { createHmac, randomUUID } from "node:crypto";
import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "./types.js";

const M = 1_000_000;
/** Their price unit: USD × 10,000. One unit is therefore 100 micro-USD. */
const PRICE_UNITS_PER_USD = 10_000;
const MICRO_PER_PRICE_UNIT = M / PRICE_UNITS_PER_USD; // 100
/** How long a cached catalogue may price a quote. Matches the default QUOTE_TTL_SEC. */
const CATALOGUE_TTL_MS = 10 * 60_000;

/** Duplicate `transactionId` — the order already exists. Not a failure; a recovery. */
const ERR_DUPLICATE_TRANSACTION = "310402";
const ERR_BALANCE_INSUFFICIENT = "200007";
const ERR_AUTH = "401001";
/** Looked up an order that does not exist. Seen live 2026-09-02 on a refused order. */
const ERR_NO_SUCH_ORDER = "310272";
/**
 * **"the batchOrder has been getting resource, total:[1], success:[0]"** — the order was
 * placed and the profile is not issued yet. Transient, arrives within seconds of every
 * order, and it is the single most dangerous code in this API to misread: it comes back
 * as `success: false`, so the obvious reading is "failed", and the obvious reading would
 * refund a payer whose eSIM is at that moment being provisioned. Seen live on the very
 * first real order, 2026-09-02, which is exactly what the first order was for.
 */
const ERR_STILL_PROVISIONING = "200010";
/** Validation errors, one of which may mean "this is a daily plan, send periodNum". */
const ERR_VALIDATION = new Set(["000105", "400001"]);

interface Envelope<T> {
  success?: boolean;
  errorCode?: string | null;
  errorMsg?: string | null;
  obj?: T;
}

interface EPackage {
  packageCode?: string;
  slug?: string;
  name?: string;
  /** Wholesale cost to us, USD × 10,000. */
  price?: number;
  /** Their suggested retail. Recorded as a note, never used to price. */
  retailPrice?: number;
  currencyCode?: string;
  /** Bytes. */
  volume?: number;
  duration?: number;
  durationUnit?: string;
  location?: string;
  speed?: string;
  supportTopUpType?: number;
  activeType?: number;
}

interface EEsim {
  esimTranNo?: string;
  orderNo?: string;
  transactionId?: string;
  iccid?: string;
  /** The activation string a phone installs — `LPA:1$smdp$matchingId`. THE deliverable. */
  ac?: string;
  qrCodeUrl?: string;
  shortUrl?: string;
  smdpStatus?: string;
  esimStatus?: string;
  expiredTime?: string | null;
  totalVolume?: number;
  totalDuration?: number;
  durationUnit?: string;
  packageList?: Array<{ packageName?: string; packageCode?: string; locationCode?: string }>;
}

export class EsimAccessSupplier implements Supplier {
  readonly name = "esimaccess";
  /** eSIMs only. They sell data plans and nothing else we resell. */
  readonly productTypes = ["esim"] as const;

  /** Offers cached for the quote TTL so purchase() can price without a round trip. */
  private offers: { at: number; byId: Map<string, Offer> } = { at: 0, byId: new Map() };

  /**
   * The WHOLE catalogue, cached, because an unfiltered read is not a cheap call.
   *
   * Measured 2026-09-02 against the live API: `locationCode: ""` returns **3,046 packages
   * across 197 countries — 3.0 MB in 3.4 seconds.** `GET /v1/catalog?type=esim` with no
   * country passes straight through to it, and that route is free, unauthenticated and
   * rate-limited at 60/minute per IP. Sixty of those a minute is 180 MB of supplier
   * traffic for a page of results nobody reads to the end.
   *
   * So the unfiltered read happens at most once per TTL and every country filter is
   * served from it. A country-filtered read is small and stays a live call, because it is
   * the fast path and it is what an agent actually asks for.
   *
   * TTL matches the quote lock: a price older than the window in which we would honour it
   * is not a price we should be showing.
   */
  private all: { at: number; offers: Offer[] } = { at: 0, offers: [] };

  /**
   * The HMAC key: the secret when one is configured, otherwise the access code, which is
   * what the vendor's published reference describes.
   *
   * **Measured: it makes no difference** — the API accepts an empty signature (see the
   * header). The default is therefore the documented behaviour, the override is kept for
   * the day they start enforcing and it turns out to be the other one, and neither is
   * load-bearing today. Do not read this as the credential that protects the account:
   * that is `RT-AccessCode`, on its own.
   */
  private readonly signingKey: string;

  constructor(
    private readonly accessCode: string,
    private readonly baseUrl = "https://api.esimaccess.com/api/v1/open",
    signingKey = "",
  ) {
    if (!accessCode) throw new SupplierError("eSIM Access needs ESIMACCESS_ACCESS_CODE");
    this.signingKey = signingKey || accessCode;
  }

  /**
   * HMAC-SHA256(timestamp + requestId + accessCode + body), keyed by the access code.
   *
   * Signed with the secret key if the account has one, otherwise with the access code
   * itself (see the constructor). Either way both are full credentials: neither ever
   * appears in a log line or an error message here, and `keys.ts` should hold them in
   * files or systemd credentials, not `.env`.
   */
  private headers(body: string): Record<string, string> {
    const timestamp = Date.now().toString();
    const requestId = randomUUID();
    const signature = createHmac("sha256", this.signingKey)
      .update(timestamp + requestId + this.accessCode + body)
      .digest("hex")
      .toLowerCase();
    return {
      "content-type": "application/json",
      "RT-AccessCode": this.accessCode,
      "RT-Timestamp": timestamp,
      "RT-RequestID": requestId,
      "RT-Signature": signature,
    };
  }

  /**
   * One POST. The body string is serialised once and both signed and sent, because a
   * signature over a re-serialised object is a signature over a different byte string.
   */
  private async post<T>(path: string, payload: Record<string, unknown> = {}): Promise<Envelope<T>> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: this.headers(body), body })
      .catch((e: unknown) => { throw new SupplierError(`esimaccess POST ${path}: ${(e as Error).message}`, true); });

    if (!res.ok) throw new SupplierError(`esimaccess POST ${path}: HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    return (await res.json().catch(() => ({}))) as Envelope<T>;
  }

  /** A POST whose envelope must report success. Errors are classified, not flattened. */
  private async call<T>(path: string, payload: Record<string, unknown> = {}): Promise<T> {
    const env = await this.post<T>(path, payload);
    if (env.success !== true) throw EsimAccessSupplier.envelopeError(path, env);
    return (env.obj ?? {}) as T;
  }

  private static envelopeError(path: string, env: Envelope<unknown>): SupplierError {
    const code = env.errorCode ?? "?";
    const msg = `esimaccess ${path}: ${code} ${env.errorMsg ?? ""}`.trim();
    // An empty supplier wallet is not a transient condition — retrying it inside an
    // order's lifetime just delays the refund the payer is owed. The float gate is
    // supposed to make this unreachable; if it fires, the gate was stale.
    if (code === ERR_BALANCE_INSUFFICIENT) return new SupplierError(`${msg} (supplier float is empty — fund the eSIM Access account)`, false);
    if (code === ERR_AUTH) return new SupplierError(`${msg} (check ESIMACCESS_ACCESS_CODE and the request signature)`, false);
    return new SupplierError(msg, false);
  }

  /**
   * Wholesale cost in micro-USD, and a refusal for anything not priced in USD.
   *
   * The same rule as the Airalo adapter, for the same reason: we settle in USDC and
   * price in micro-USD, and no adapter in this directory is allowed to learn FX. A
   * package whose `currencyCode` is not USD is skipped from the catalogue, not
   * converted at a rate we invented.
   */
  private static costMicro(p: EPackage): number {
    if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 0) {
      throw new SupplierError(`esimaccess package ${p.packageCode ?? "?"} has no usable price`);
    }
    const currency = (p.currencyCode ?? "").toUpperCase();
    if (currency && currency !== "USD") {
      throw new SupplierError(`esimaccess package ${p.packageCode ?? "?"} is priced in ${currency}, not USD — we will not infer FX`);
    }
    return Math.round(p.price * MICRO_PER_PRICE_UNIT);
  }

  private static toOffer(p: EPackage): Offer | null {
    if (!p.packageCode) return null;
    // Undocumented shape: one ISO code is a country, anything else is treated as a
    // region label rather than guessed at.
    const raw = (p.location ?? "").trim();
    const codes = raw.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
    const single = codes.length === 1 ? codes[0] : null;
    const days = (p.durationUnit ?? "").toUpperCase() === "DAY" ? p.duration : undefined;

    return {
      id: `ea-${p.packageCode}`,
      type: "esim",
      country: single ?? "WW",
      brand: "ESIMACCESS",
      brandName: "eSIM Access",
      name: p.name ?? p.packageCode,
      notes: [p.speed, p.supportTopUpType === 2 ? "top-up supported" : null].filter(Boolean).join(" · ") || undefined,
      priceType: "fixed",
      costMicro: EsimAccessSupplier.costMicro(p),
      // Bytes → GB, two decimals. GiB, matching how the plans are named ("5GB").
      dataGB: p.volume ? Math.round((p.volume / 1_073_741_824) * 100) / 100 : undefined,
      durationDays: days,
      regions: codes.length > 1 ? codes : raw && !single ? [raw] : undefined,
      // Provisioning is documented as 3–10 seconds, then the profile is installed by
      // the buyer. The order layer polls; this is the hint it starts from.
      settlementSeconds: 30,
    };
  }

  async listOffers(q: { type: ProductType; country?: string; limit?: number; offset?: number }): Promise<Offer[]> {
    if (q.type !== "esim") return [];
    const country = q.country?.toUpperCase();

    // No country: the 3 MB read. Serve it from cache when we have one that is still
    // inside the quote window.
    if (!country && Date.now() - this.all.at < CATALOGUE_TTL_MS && this.all.offers.length) {
      return EsimAccessSupplier.paginate(this.all.offers, q);
    }

    // Every filter field is optional but must be PRESENT as an empty string.
    const obj = await this.call<{ packageList?: EPackage[] }>("/package/list", {
      locationCode: country ?? "",
      type: "",
      slug: "",
      packageCode: "",
      iccid: "",
    });

    const out: Offer[] = [];
    for (const p of obj.packageList ?? []) {
      // One unpriceable or non-USD package must not hide the rest of the catalogue.
      try {
        const offer = EsimAccessSupplier.toOffer(p);
        if (offer) out.push(offer);
      } catch { /* skipped: unpriceable or not USD */ }
    }
    // Cache the full list, not the page: getOffer() must find an id the caller paged past.
    this.offers = { at: Date.now(), byId: new Map([...this.offers.byId, ...out.map((o) => [o.id, o] as const)]) };
    if (!country) this.all = { at: Date.now(), offers: out };
    return EsimAccessSupplier.paginate(out, q);
  }

  /** offset/limit over an already-materialised list. Absent limit means everything. */
  private static paginate(offers: Offer[], q: { limit?: number; offset?: number }): Offer[] {
    const from = Math.max(0, q.offset ?? 0);
    return q.limit ? offers.slice(from, from + q.limit) : offers.slice(from);
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type !== "esim") return null;
    if (Date.now() - this.offers.at < 10 * 60_000) {
      const hit = this.offers.byId.get(id);
      if (hit) return hit;
    }
    // Unlike Airalo, a single package can be fetched directly — `packageCode` is a
    // documented filter — so a cold cache costs one small call, not the catalogue.
    const obj = await this.call<{ packageList?: EPackage[] }>("/package/list", {
      locationCode: "", type: "", slug: "", packageCode: id.replace(/^ea-/, ""), iccid: "",
    });
    for (const p of obj.packageList ?? []) {
      const offer = EsimAccessSupplier.toOffer(p);
      if (offer?.id === id) return offer;
    }
    return null;
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    if (req.type !== "esim") throw new SupplierError(`esimaccess does not sell ${req.type}`);
    const packageCode = req.offerId.replace(/^ea-/, "");
    const order = (periodNum?: number) => ({
      // OUR order id is the idempotency key. This is the whole reason this adapter
      // exists in preference to Airalo's: a repeat is refused, not charged.
      transactionId: req.orderId,
      packageInfoList: [{ packageCode, count: 1, ...(periodNum ? { periodNum } : {}) }],
    });

    // One attempt normally; a second only if the first is rejected as a validation
    // error and the package has a day count to send as `periodNum`.
    const attempts: Array<Record<string, unknown>> = [order()];
    let obj: { orderNo?: string; transactionId?: string } | null = null;

    for (const payload of attempts) {
      try {
        obj = await this.callOrder(payload);
        break;
      } catch (e) {
        const err = e as SupplierError;
        // Already placed — recover it rather than paying twice or refunding a
        // delivered eSIM. Reachable on either attempt.
        if (err.message.includes(ERR_DUPLICATE_TRANSACTION)) return this.recoverByTransactionId(req.orderId);
        // "Required only for daily plans", with no documented way to know which those
        // are. Safe to retry under the same transactionId: a rejected order never
        // existed, and if it somehow did, the retry comes back as a duplicate.
        const days = attempts.length === 1 && EsimAccessSupplier.isValidationError(err)
          ? (await this.getOffer("esim", req.offerId))?.durationDays
          : undefined;
        if (!days || days <= 0) throw err;
        attempts.push(order(days));
      }
    }

    const orderNo = obj?.orderNo;
    if (!orderNo) {
      // Accepted with no order number is not something the documented API does. Do not
      // call it failed — an unknown outcome refunds a payer whose eSIM may exist.
      throw new SupplierError(
        `esimaccess order ${req.orderId} returned no orderNo; query /esim/query by transactionId before re-ordering`,
        true,
      );
    }
    // The ICCID is not in the order response — it arrives 3–10s later. Report the order
    // as pending and let the order layer poll getPurchase(); that is the same contract
    // Zendit's adapter uses and the one `orders.ts` is built around.
    return this.esimResult(orderNo, await this.queryByOrderNo(orderNo));
  }

  /** The order call. Its envelope error carries the code the caller branches on. */
  private async callOrder(payload: Record<string, unknown>): Promise<{ orderNo?: string; transactionId?: string }> {
    return this.call<{ orderNo?: string; transactionId?: string }>("/esim/order", payload);
  }

  private static isValidationError(e: SupplierError): boolean {
    return [...ERR_VALIDATION].some((code) => e.message.includes(code));
  }

  /**
   * `/esim/query`, tolerating "ordered, not yet provisioned".
   *
   * Returns the rows, or **null meaning "not ready yet"** — which the callers turn into a
   * pending result rather than a failure. Any other unsuccessful envelope still throws.
   */
  private async queryEsims(payload: Record<string, unknown>): Promise<EEsim[] | null> {
    const env = await this.post<{ esimList?: EEsim[] }>("/esim/query", payload);
    if (env.success === true) return env.obj?.esimList ?? [];
    if ((env.errorCode ?? "") === ERR_STILL_PROVISIONING) return null;
    throw EsimAccessSupplier.envelopeError("/esim/query", env);
  }

  private async queryByOrderNo(orderNo: string): Promise<EEsim | null> {
    const rows = await this.queryEsims({ orderNo, iccid: "", pager: { pageNum: 1, pageSize: 20 } });
    return (rows ?? [])[0] ?? null;
  }

  /**
   * The duplicate-transactionId recovery.
   *
   * `transactionId` is not a documented filter on `/esim/query`, so this sends it,
   * then VERIFIES every row it gets back actually carries our id — a filter the server
   * ignores would otherwise hand us somebody else's eSIM. If that yields nothing, it
   * scans a bounded number of recent pages, which is the same limit/offset scan the
   * Bitnob adapter has to do for its own reference.
   */
  private async recoverByTransactionId(transactionId: string): Promise<PurchaseResult> {
    const match = (rows: EEsim[]) => rows.find((r) => r.transactionId === transactionId);

    const filtered = await this.queryEsims({
      transactionId, orderNo: "", iccid: "", pager: { pageNum: 1, pageSize: 20 },
    }).catch(() => [] as EEsim[]);
    const hit = match(filtered ?? []);
    if (hit?.orderNo) return this.esimResult(hit.orderNo, hit);

    for (let pageNum = 1; pageNum <= 5; pageNum++) {
      const rows = (await this.queryEsims({ orderNo: "", iccid: "", pager: { pageNum, pageSize: 50 } })) ?? [];
      const found = match(rows);
      if (found?.orderNo) return this.esimResult(found.orderNo, found);
      if (rows.length < 50) break;
    }

    // Known to exist (the API refused it as a duplicate) and not found. Retryable, so
    // the order layer keeps polling rather than refunding an eSIM that was issued.
    throw new SupplierError(
      `esimaccess refused order ${transactionId} as a duplicate but it was not found in the last 250 eSIMs — ` +
        `reconcile it in the console before re-ordering`,
      true,
    );
  }

  /** An eSIM row → PurchaseResult. Absent evidence is pending, never failed. */
  private esimResult(orderNo: string, e: EEsim | null): PurchaseResult {
    const lpa = e?.ac?.trim();
    const qr = e?.qrCodeUrl?.trim();
    if (!e || !e.iccid || (!lpa && !qr)) {
      return { supplierTxId: orderNo, status: "pending", error: `esimaccess order ${orderNo} has not been provisioned yet` };
    }
    return {
      supplierTxId: orderNo,
      status: "delivered",
      confirmation: {
        // The string a phone installs. This IS the deliverable.
        lpa: lpa || undefined,
        iccid: e.iccid,
        qrcode_url: qr || undefined,
        short_url: e.shortUrl || undefined,
        esim_tran_no: e.esimTranNo,
        smdp_status: e.smdpStatus,
        esim_status: e.esimStatus,
        expires_at: e.expiredTime ?? undefined,
        data_bytes: e.totalVolume,
        validity_days: (e.durationUnit ?? "").toUpperCase() === "DAY" ? e.totalDuration : undefined,
        package: e.packageList?.[0]?.packageName,
      },
    };
  }

  /** Recovery by the supplier's own order number — a real lookup, unlike Airalo's. */
  async getPurchase(type: ProductType, supplierTxId: string): Promise<PurchaseResult> {
    if (type !== "esim") throw new SupplierError(`esimaccess does not sell ${type}`);
    return this.esimResult(supplierTxId, await this.queryByOrderNo(supplierTxId));
  }

  /** Prepaid balance in micro-USD. The float gate applies to eSIMs because of this. */
  async balanceMicro(): Promise<number> {
    const obj = await this.call<{ balance?: number }>("/balance/query");
    if (typeof obj.balance !== "number" || !Number.isFinite(obj.balance)) {
      throw new SupplierError("esimaccess /balance/query returned no balance", true);
    }
    return Math.round(obj.balance * MICRO_PER_PRICE_UNIT);
  }

  /**
   * Every destination in the catalogue, from the cache the catalogue already builds.
   *
   * The console shipped with twelve hand-picked eSIM destinations because nothing could
   * tell it any better. There are **197**. A traveller going to Georgia should not be
   * told the product does not exist because a hard-coded list was written before anyone
   * had read the catalogue.
   */
  async listCountries(type: ProductType): Promise<Array<{ code: string; offers: number }>> {
    if (type !== "esim") return [];
    // Fills (and reuses) the same 10-minute catalogue cache the offer list uses.
    const all = await this.listOffers({ type: "esim" });
    const counts = new Map<string, number>();
    for (const o of all) {
      // A regional bundle covers many countries and is offered under each of them.
      for (const code of o.country === "WW" ? o.regions ?? [] : [o.country]) {
        if (/^[A-Z]{2}$/.test(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return [...counts].map(([code, offers]) => ({ code, offers })).sort((a, b) => a.code.localeCompare(b.code));
  }

  /** eSIMs are not bought against a phone number. */
  async lookupPhone(msisdn: string): Promise<PhoneLookup> {
    return { msisdn, country: null };
  }
}
