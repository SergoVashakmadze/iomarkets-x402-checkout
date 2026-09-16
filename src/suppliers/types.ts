// One interface, several suppliers. Prices here are SUPPLIER COST in micro-USD;
// the sale price is derived in money.ts. Recipient identifiers are never logged
// by adapters — the order layer hashes them for receipts.

export type ProductType = "topup" | "esim" | "bill" | "payout";

/** International payment corridors: how a payout reaches the recipient. */
export type PayoutMethod = "bank" | "mobile_money" | "upi" | "wallet";

export interface Offer {
  id: string;
  type: ProductType;
  country: string; // ISO-3166 alpha-2
  brand: string; // supplier brand code, e.g. "JIO"
  brandName: string;
  name: string; // human label, e.g. "Jio — 1 GB/day, 28 days" or "Airtime (any amount)"
  notes?: string;
  priceType: "fixed" | "range";
  /** fixed: what the supplier charges us. */
  costMicro?: number;
  /** range: bounds of what the supplier lets us pay, plus local send bounds. */
  costMinMicro?: number;
  costMaxMicro?: number;
  sendCurrency?: string; // what the recipient receives, e.g. "INR"
  sendFixed?: number; // in sendCurrency (major units)
  sendMin?: number;
  sendMax?: number;
  /** cost per 1 unit of sendCurrency, micro-USD (range offers). */
  costPerSendUnitMicro?: number;
  dataGB?: number;
  durationDays?: number;
  regions?: string[];
  /** payout offers only */
  payoutMethod?: PayoutMethod;
  /** recipient fields the corridor needs (e.g. account_number, bank_code, full_name). */
  requiredFields?: string[];
  /** typical settlement time, seconds */
  settlementSeconds?: number;
}

export interface PhoneLookup {
  msisdn: string;
  country: string | null;
  brand?: string;
  brandName?: string;
}

export interface PurchaseRequest {
  orderId: string; // used as the supplier's idempotency key
  type: ProductType;
  offerId: string;
  recipient: { phone?: string; iccid?: string; fields?: Record<string, string> };
  /** payouts: the (KYC-lite) sender the partner must record. */
  sender?: { name: string; country: string; reference?: string };
  /** For range offers: the supplier cost we are willing to pay, micro-USD. */
  costMicro: number;
}

export type PurchaseStatus = "pending" | "delivered" | "failed";

export interface PurchaseResult {
  supplierTxId: string;
  status: PurchaseStatus;
  /** Delivery evidence handed to the buyer (operator reference, eSIM activation…). */
  confirmation?: Record<string, unknown>;
  error?: string;
}

/** One destination of a product. `offers` only where the supplier can count them. */
export interface SupplierCountry { code: string; offers?: number; name?: string; currency?: string }

export interface Supplier {
  readonly name: string;
  /**
   * The product types this adapter can actually fulfil.
   *
   * Not cosmetic. Reloadly sells airtime and nothing else through the audience we
   * hold; Zendit sells eSIMs and gift cards too. Without this the service had no way
   * to know what it was actually able to sell, so `/agent.md`, the Bazaar description
   * and SKILL.md all advertised the union of everything any adapter might do — four
   * product types, of which one was live. Discovery was honest (`/v1/catalog` returns
   * an empty list for a type nobody can fill); the prose was not, and the prose is
   * what an agent reads first.
   *
   * Optional so a test double need not care: absent means "all four", the old
   * behaviour.
   */
  readonly productTypes?: readonly ProductType[];
  lookupPhone(msisdn: string): Promise<PhoneLookup>;
  listOffers(q: { type: ProductType; country?: string; brand?: string; limit?: number; offset?: number }): Promise<Offer[]>;
  /**
   * Which destinations this supplier can actually serve for a product.
   *
   * Optional, because it is only answerable by a supplier that will enumerate its
   * destinations without being asked for one. eSIM Access lists its whole catalogue, so
   * it can also count offers per country; Reloadly has a plain country list (no offers
   * without a country, so no count). A caller must therefore treat an empty answer as
   * "cannot tell you", not as "no destinations", and fall back to whatever list it
   * already had.
   */
  listCountries?(type: ProductType): Promise<SupplierCountry[]>;
  getOffer(type: ProductType, id: string): Promise<Offer | null>;
  purchase(req: PurchaseRequest): Promise<PurchaseResult>;
  getPurchase(type: ProductType, supplierTxId: string): Promise<PurchaseResult>;
  balanceMicro(): Promise<number>;
  /** Indicative FX: how many units of `currency` 1 USD buys at supplier cost (before our markup). */
  fxRate?(currency: string): Promise<number | null>;
}

export class SupplierError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "SupplierError";
  }
}
