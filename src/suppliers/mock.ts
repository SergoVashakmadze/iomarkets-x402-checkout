// Deterministic in-memory supplier for development, tests and demos. Behaviour
// is keyed off the recipient so a demo can show every path on purpose:
//   phone ends in 0000 → supplier FAILS  (exercises the refund path)
//   phone ends in 1111 → PENDING once, then delivered (exercises polling)
//   anything else      → delivered immediately

import { countryOfMsisdn } from "../phone.js";
import type { Offer, PhoneLookup, ProductType, PurchaseRequest, PurchaseResult, Supplier } from "./types.js";

const M = 1_000_000;

const OFFERS: Offer[] = [
  { id: "mock-in-jio-airtime", type: "topup", country: "IN", brand: "JIO", brandName: "Jio", name: "Jio airtime (any amount)", priceType: "range",
    sendCurrency: "INR", sendMin: 10, sendMax: 5000, costPerSendUnitMicro: 12_100, costMinMicro: 121_000, costMaxMicro: 60_500_000 },
  { id: "mock-in-jio-1gb-28d", type: "topup", country: "IN", brand: "JIO", brandName: "Jio", name: "Jio 1 GB/day · 28 days", priceType: "fixed",
    costMicro: 3_650_000, sendCurrency: "INR", sendFixed: 299, dataGB: 28, durationDays: 28 },
  { id: "mock-in-airtel-airtime", type: "topup", country: "IN", brand: "AIRTEL", brandName: "Airtel", name: "Airtel airtime (any amount)", priceType: "range",
    sendCurrency: "INR", sendMin: 10, sendMax: 5000, costPerSendUnitMicro: 12_100, costMinMicro: 121_000, costMaxMicro: 60_500_000 },
  { id: "mock-ng-mtn-airtime", type: "topup", country: "NG", brand: "MTN", brandName: "MTN Nigeria", name: "MTN airtime (any amount)", priceType: "range",
    sendCurrency: "NGN", sendMin: 100, sendMax: 50000, costPerSendUnitMicro: 660, costMinMicro: 66_000, costMaxMicro: 33_000_000 },
  { id: "mock-ge-magti-airtime", type: "topup", country: "GE", brand: "MAGTI", brandName: "Magticom", name: "Magti airtime (any amount)", priceType: "range",
    sendCurrency: "GEL", sendMin: 1, sendMax: 200, costPerSendUnitMicro: 370_000, costMinMicro: 370_000, costMaxMicro: 74_000_000 },
  { id: "mock-esim-in-5gb-30d", type: "esim", country: "IN", brand: "ESIM", brandName: "IoMarkets eSIM", name: "India eSIM · 5 GB · 30 days", priceType: "fixed",
    costMicro: 7_200_000, dataGB: 5, durationDays: 30, regions: ["IN"] },
  { id: "mock-esim-global-1gb-7d", type: "esim", country: "WW", brand: "ESIM", brandName: "IoMarkets eSIM", name: "Global eSIM · 1 GB · 7 days", priceType: "fixed",
    costMicro: 4_500_000, dataGB: 1, durationDays: 7, regions: ["WW"] },
  { id: "mock-payout-ng-bank", type: "payout", country: "NG", brand: "NGBANK", brandName: "Nigeria bank transfer (NIP)", name: "Bank transfer · NGN · any bank", priceType: "range",
    sendCurrency: "NGN", sendMin: 1000, sendMax: 300000, costPerSendUnitMicro: 650, costMinMicro: 650_000, costMaxMicro: 195_000_000,
    payoutMethod: "bank", requiredFields: ["account_number", "bank_code", "full_name"], settlementSeconds: 60 },
  { id: "mock-payout-ke-mpesa", type: "payout", country: "KE", brand: "MPESA", brandName: "M-Pesa", name: "M-Pesa · KES", priceType: "range",
    sendCurrency: "KES", sendMin: 100, sendMax: 25000, costPerSendUnitMicro: 7_800, costMinMicro: 780_000, costMaxMicro: 195_000_000,
    payoutMethod: "mobile_money", requiredFields: ["full_name"], settlementSeconds: 30 },
  { id: "mock-payout-in-upi", type: "payout", country: "IN", brand: "UPI", brandName: "UPI", name: "UPI · INR · any VPA", priceType: "range",
    sendCurrency: "INR", sendMin: 100, sendMax: 15000, costPerSendUnitMicro: 12_000, costMinMicro: 1_200_000, costMaxMicro: 180_000_000,
    payoutMethod: "upi", requiredFields: ["vpa", "full_name"], settlementSeconds: 20 },
  { id: "mock-payout-ph-gcash", type: "payout", country: "PH", brand: "GCASH", brandName: "GCash", name: "GCash · PHP", priceType: "range",
    sendCurrency: "PHP", sendMin: 100, sendMax: 10000, costPerSendUnitMicro: 17_500, costMinMicro: 1_750_000, costMaxMicro: 175_000_000,
    payoutMethod: "wallet", requiredFields: ["full_name"], settlementSeconds: 30 },
  { id: "mock-payout-ge-bank", type: "payout", country: "GE", brand: "GEBANK", brandName: "Georgia bank transfer", name: "Bank transfer · GEL · IBAN", priceType: "range",
    sendCurrency: "GEL", sendMin: 10, sendMax: 500, costPerSendUnitMicro: 370_000, costMinMicro: 3_700_000, costMaxMicro: 185_000_000,
    payoutMethod: "bank", requiredFields: ["iban", "full_name"], settlementSeconds: 3600 },
  { id: "mock-ng-ikeja-electric", type: "bill", country: "NG", brand: "IKEDC", brandName: "Ikeja Electric", name: "Ikeja Electric prepaid (any amount)", priceType: "range",
    sendCurrency: "NGN", sendMin: 500, sendMax: 100000, costPerSendUnitMicro: 660, costMinMicro: 330_000, costMaxMicro: 66_000_000 },
];

export class MockSupplier implements Supplier {
  readonly name = "mock";
  private polls = new Map<string, number>();
  private outcomes = new Map<string, PurchaseResult>();

  /** The mock exists to exercise every path, so it claims all four. */
  readonly productTypes = ["topup", "esim", "bill", "payout"] as const;

  async lookupPhone(msisdn: string): Promise<PhoneLookup> {
    const country = countryOfMsisdn(msisdn);
    const brand = country === "IN" ? (msisdn.startsWith("917") ? "JIO" : "AIRTEL") : country === "NG" ? "MTN" : country === "GE" ? "MAGTI" : undefined;
    const brandName = OFFERS.find((o) => o.brand === brand)?.brandName;
    return { msisdn, country, brand, brandName };
  }

  async listOffers(q: { type: ProductType; country?: string; brand?: string }): Promise<Offer[]> {
    return OFFERS.filter((o) => o.type === q.type && (!q.country || o.country === q.country || o.country === "WW") && (!q.brand || o.brand === q.brand));
  }

  async getOffer(type: ProductType, id: string): Promise<Offer | null> {
    return OFFERS.find((o) => o.type === type && o.id === id) ?? null;
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    const supplierTxId = `mock_${req.orderId}`;
    const phone = req.recipient.phone ?? "";
    let r: PurchaseResult;
    if (phone.endsWith("0000")) r = { supplierTxId, status: "failed", error: "MOCK_OPERATOR_REJECTED" };
    else if (phone.endsWith("1111")) { this.polls.set(supplierTxId, 0); r = { supplierTxId, status: "pending" }; }
    else r = { supplierTxId, status: "delivered", confirmation: this.confirmation(req) };
    this.outcomes.set(supplierTxId, r);
    return r;
  }

  async getPurchase(type: ProductType, supplierTxId: string): Promise<PurchaseResult> {
    const known = this.outcomes.get(supplierTxId);
    if (known && known.status !== "pending") return known;
    const n = (this.polls.get(supplierTxId) ?? 0) + 1;
    this.polls.set(supplierTxId, n);
    if (n < 2) return { supplierTxId, status: "pending" };
    return { supplierTxId, status: "delivered", confirmation: { operatorReference: `MOCK-${supplierTxId.slice(-8).toUpperCase()}`, type } };
  }

  async balanceMicro(): Promise<number> {
    return 1000 * M;
  }

  async fxRate(currency: string): Promise<number | null> {
    const o = OFFERS.find((x) => x.priceType === "range" && x.sendCurrency === currency && x.costPerSendUnitMicro);
    return o ? M / o.costPerSendUnitMicro! : null;
  }

  private confirmation(req: PurchaseRequest): Record<string, unknown> {
    if (req.type === "payout") {
      return { partnerReference: `MOCK-PAYOUT-${req.orderId.slice(-8).toUpperCase()}`, method: OFFERS.find((o) => o.id === req.offerId)?.payoutMethod, settled: true };
    }
    if (req.type === "esim") {
      return {
        iccid: "8991000000000000000",
        smdpAddress: "rsp.example.net",
        activationCode: `MOCK-${req.orderId.slice(-8).toUpperCase()}`,
        lpa: `LPA:1$rsp.example.net$MOCK-${req.orderId.slice(-8).toUpperCase()}`,
        instructions: "Settings → Mobile Data → Add eSIM → scan / enter the LPA string.",
      };
    }
    return { operatorReference: `MOCK-${req.orderId.slice(-8).toUpperCase()}` };
  }
}
