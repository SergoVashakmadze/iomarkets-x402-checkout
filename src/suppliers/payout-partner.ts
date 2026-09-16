// International payments partner adapter — SKELETON.
//
// Moving money to a third party's bank / mobile-money account is regulated
// (money transmission / PSP rules). We never do it ourselves: a licensed partner
// with KYC/AML holds the licence and performs the payout; we are the API layer
// that turns an x402 USDC payment into a partner payout order. Candidates with
// stablecoin-in / local-currency-out B2B APIs (Africa + Asia first):
//   • Kotani Pay  (KE/NG/GH/ZA… mobile money + bank; USDC settlement)
//   • Yellow Card (20+ African countries; B2B payments API)
//   • Bitnob      (NG/KE/GH… bank + mobile money)
//   • Coins.ph / Transfi / Onafriq for PH / IN / wider Asia
// The concrete endpoints below are placeholders shaped like a typical partner API;
// fill them in from the partner's docs once credentials exist (docs/PAYOUTS.md).

import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier } from "./types.js";

const M = 1_000_000;

type Corridor = { id: string; country: string; currency: string; method: Offer["payoutMethod"]; name: string; rate: number; minLocal: number; maxLocal: number; fields: string[]; feeBps: number; settlementSeconds: number };

export class PayoutPartnerSupplier implements Supplier {
  readonly name: string;
  constructor(private readonly partner: string, private readonly apiKey: string, private readonly baseUrl: string) {
    if (!apiKey || !baseUrl) throw new Error(`PAYOUT_API_KEY / PAYOUT_BASE_URL missing for partner ${partner}`);
    this.name = `payout:${partner}`;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown; try { json = text ? JSON.parse(text) : undefined; } catch { /* ignore */ }
    if (!res.ok) throw new SupplierError(`${this.name} ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`, res.status >= 500 || res.status === 429);
    return json as T;
  }

  private toOffer(c: Corridor): Offer {
    const costPerUnit = Math.ceil((M / c.rate) * (1 + c.feeBps / 10_000));
    return {
      id: `po-${c.id}`, type: "payout", country: c.country, brand: c.id.toUpperCase(), brandName: c.name, name: `${c.name} · ${c.currency}`,
      priceType: "range", sendCurrency: c.currency, sendMin: c.minLocal, sendMax: c.maxLocal, costPerSendUnitMicro: costPerUnit,
      costMinMicro: Math.ceil(c.minLocal * costPerUnit), costMaxMicro: Math.ceil(c.maxLocal * costPerUnit),
      payoutMethod: c.method, requiredFields: c.fields, settlementSeconds: c.settlementSeconds,
    };
  }

  readonly productTypes = ["payout"] as const;

  async lookupPhone(msisdn: string): Promise<PhoneLookup> { return { msisdn, country: null }; }

  async listOffers(q: { type: ProductType; country?: string }): Promise<Offer[]> {
    if (q.type !== "payout") return [];
    const r = await this.call<{ corridors: Corridor[] }>("GET", `/v1/corridors${q.country ? `?country=${q.country}` : ""}`); // TODO partner path
    return r.corridors.map((c) => this.toOffer(c));
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (type !== "payout" || !id.startsWith("po-")) return null;
    const r = await this.call<{ corridor: Corridor }>("GET", `/v1/corridors/${id.slice(3)}`); // TODO partner path
    return r.corridor ? this.toOffer(r.corridor) : null;
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    if (!req.sender) throw new SupplierError("payout requires a sender record (KYC)");
    const r = await this.call<{ id: string; status: string }>("POST", "/v1/payouts", { // TODO partner path/fields
      reference: req.orderId, corridor: req.offerId.slice(3), amount_usd: req.costMicro / M,
      recipient: req.recipient.fields, sender: req.sender,
    });
    return this.map(r);
  }

  async getPurchase(_t: ProductType, id: string): Promise<PurchaseResult> {
    return this.map(await this.call<{ id: string; status: string; reference?: string }>("GET", `/v1/payouts/${id}`)); // TODO
  }

  async balanceMicro(): Promise<number> {
    const b = await this.call<{ balance_usd: number }>("GET", "/v1/balance"); // TODO
    return Math.round(b.balance_usd * M);
  }

  async fxRate(currency: string): Promise<number | null> {
    const r = await this.call<{ rate: number }>("GET", `/v1/rates?from=USD&to=${currency}`); // TODO
    return r.rate ?? null;
  }

  private map(r: { id: string; status: string; reference?: string }): PurchaseResult {
    const s = r.status.toLowerCase();
    if (["completed", "success", "settled", "paid"].includes(s)) return { supplierTxId: r.id, status: "delivered", confirmation: { partnerReference: r.reference ?? r.id } };
    if (["failed", "rejected", "cancelled", "refunded"].includes(s)) return { supplierTxId: r.id, status: "failed", error: r.status };
    return { supplierTxId: r.id, status: "pending" };
  }
}
