export type PayType = "payout" | "topup";

export interface Offer {
  offerId: string;
  name: string;
  brand?: string | undefined;
  brandName?: string | undefined;
  country: string;
  payoutMethod?: string | undefined;
  requiredFields: string[];
  priceType: "range" | "fixed";
  sendCurrency: string;
  sendMin?: number | undefined;
  sendMax?: number | undefined;
  settlementSeconds?: number | undefined;
}

export interface Limits {
  payer: string;
  tier: "standard" | "business";
  suspended: boolean;
  max_order_usdc: number;
  max_payout_usdc: number;
  daily_usdc: number;
  sender_verified: boolean;
}

export interface Quote {
  quoteId: string;
  price_usdc: number;
  delivers?: string | undefined;
  expires_at: string;
  pay?: { endpoint: string; body: unknown } | undefined;
}

export type RowStatus =
  | "draft"
  | "quoting"
  | "quoted"
  | "quote_error"
  | "queued"
  | "paying"
  | "settling"
  | "delivered"
  | "refunded"
  | "failed";

export interface Row {
  id: string;
  values: Record<string, string>;
  status: RowStatus;
  quote?: Quote | undefined;
  message?: string | undefined;
  orderId?: string | undefined;
  settlementTxid?: string | undefined;
  settlementUrl?: string | undefined;
  confirmation?: string | undefined;
}

export interface Sender {
  name: string;
  country: string;
}

export interface BatchState {
  step: 1 | 2 | 3 | 4;
  type: PayType;
  country: string;
  offerId: string | null;
  rows: Row[];
  sender: Sender;
  payer: string | null;
  demo: boolean;
}

export interface Country {
  code: string;
  name: string;
  currency?: string | undefined;
}

/**
 * The destinations shown when the service cannot list them (`/v1/countries` answers
 * `enumerable:false`). This is the payout partner's five corridors — it is NOT the
 * top-up footprint, which is 150+ countries and comes from the service. For two
 * sessions this list was the only one the console had, so a buyer could not pick
 * Brazil while the front page promised it.
 */
export const FALLBACK_COUNTRIES: Country[] = [
  { code: "NG", name: "Nigeria", currency: "NGN" },
  { code: "KE", name: "Kenya", currency: "KES" },
  { code: "GH", name: "Ghana", currency: "GHS" },
  { code: "IN", name: "India", currency: "INR" },
  { code: "PH", name: "Philippines", currency: "PHP" },
];

const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

/** English name for an ISO code, from the browser's own region table; the code if unknown. */
export function countryName(code: string, list: Country[] = FALLBACK_COUNTRIES) {
  const known = list.find((c) => c.code === code)?.name;
  if (known) return known;
  try {
    return REGION_NAMES?.of(code) || code;
  } catch {
    return code;
  }
}

export const FIELD_LABELS: Record<string, string> = {
  full_name: "Full name",
  account_number: "Account number",
  bank_code: "Bank code",
  phone: "Phone number",
  amount: "Amount",
  email: "Email",
  address: "Address",
  bank_name: "Bank name",
  ifsc: "IFSC code",
  upi_id: "UPI ID",
  mobile_network: "Mobile network",
};

export function fieldLabel(f: string) {
  return FIELD_LABELS[f] ?? f.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
