import {
  getCatalog,
  getCountries,
  getLimits,
  getOrder,
  postQuote,
  type OrderStatus,
  type QuoteRequest,
} from "./api";
import {
  countryName,
  type Country,
  type Limits,
  type Offer,
  type PayType,
  type Quote,
} from "./types";

export interface Driver {
  demo: boolean;
  /** Destinations for a product, or `null` when the service cannot list them. */
  countries(type: PayType): Promise<Country[] | null>;
  catalog(type: PayType, country: string): Promise<Offer[]>;
  limits(payer: string): Promise<Limits>;
  quote(req: QuoteRequest): Promise<Quote>;
  /** `quotedUsdc` becomes the per-payment ceiling — see wallet.payAndCreateOrder. */
  createOrder(quoteId: string, payer: string, quotedUsdc: number): Promise<string>;
  order(id: string): Promise<OrderStatus>;
}

export const realDriver: Driver = {
  demo: false,
  countries: getCountries,
  catalog: getCatalog,
  limits: getLimits,
  quote: postQuote,
  // Lazily imported so Pera + algosdk + the x402 client land in their own chunk,
  // fetched from THIS origin the first time someone actually pays rather than on
  // first paint. store.tsx already does the same for connect/disconnect; importing
  // statically here pulled all of it back into the entry bundle.
  createOrder: (quoteId, payer, quotedUsdc) =>
    import("./wallet").then((m) => m.payAndCreateOrder(quoteId, payer, quotedUsdc)),
  order: getOrder,
};

/* ------------------------------ demo mode ------------------------------ */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.random() * base * 0.6;

const DEMO_OFFERS: Offer[] = [
  {
    offerId: "ng-bank-transfer",
    name: "Nigeria bank transfer (NGN)",
    brandName: "Nigeria Instant Payments",
    country: "NG",
    payoutMethod: "bank",
    requiredFields: ["full_name", "account_number", "bank_code", "amount"],
    priceType: "range",
    sendCurrency: "NGN",
    sendMin: 5,
    sendMax: 2000,
    settlementSeconds: 3,
  },
  {
    offerId: "ng-mobile-money",
    name: "Nigeria mobile money (NGN)",
    country: "NG",
    payoutMethod: "mobile_money",
    requiredFields: ["full_name", "phone", "amount"],
    priceType: "range",
    sendCurrency: "NGN",
    sendMin: 2,
    sendMax: 500,
    settlementSeconds: 3,
  },
  {
    offerId: "ke-mpesa",
    name: "Kenya M-PESA",
    country: "KE",
    payoutMethod: "mobile_money",
    requiredFields: ["full_name", "phone", "amount"],
    priceType: "range",
    sendCurrency: "KES",
    sendMin: 2,
    sendMax: 900,
    settlementSeconds: 3,
  },
  {
    offerId: "gh-bank-transfer",
    name: "Ghana bank transfer (GHS)",
    country: "GH",
    payoutMethod: "bank",
    requiredFields: ["full_name", "account_number", "bank_code", "amount"],
    priceType: "range",
    sendCurrency: "GHS",
    sendMin: 5,
    sendMax: 1200,
    settlementSeconds: 3,
  },
  {
    offerId: "in-imps",
    name: "India IMPS bank transfer",
    country: "IN",
    payoutMethod: "bank",
    requiredFields: ["full_name", "account_number", "ifsc", "amount"],
    priceType: "range",
    sendCurrency: "INR",
    sendMin: 5,
    sendMax: 2500,
    settlementSeconds: 3,
  },
  {
    offerId: "ph-instapay",
    name: "Philippines InstaPay",
    country: "PH",
    payoutMethod: "bank",
    requiredFields: ["full_name", "account_number", "bank_code", "amount"],
    priceType: "range",
    sendCurrency: "PHP",
    sendMin: 5,
    sendMax: 1500,
    settlementSeconds: 3,
  },
  {
    offerId: "ng-airtime-mtn",
    name: "MTN Nigeria airtime",
    brandName: "MTN",
    country: "NG",
    payoutMethod: "airtime",
    requiredFields: ["phone", "amount"],
    priceType: "range",
    sendCurrency: "NGN",
    sendMin: 1,
    sendMax: 60,
    settlementSeconds: 3,
  },
  {
    offerId: "ke-airtime-safaricom",
    name: "Safaricom Kenya airtime",
    brandName: "Safaricom",
    country: "KE",
    payoutMethod: "airtime",
    requiredFields: ["phone", "amount"],
    priceType: "range",
    sendCurrency: "KES",
    sendMin: 1,
    sendMax: 60,
    settlementSeconds: 3,
  },
];

interface DemoOrder {
  createdAt: number;
  outcome: "delivered" | "refunded" | "failed";
  amount: number;
}
const demoOrders = new Map<string, DemoOrder>();
let demoSeq = 0;

function txid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let s = "";
  for (let i = 0; i < 52; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * The demo's top-up footprint is the REAL one. `/v1/countries` is a free route on the
 * same origin, so the demo asks it and fabricates an airtime offer for whichever
 * country is picked — a demo that offered five countries under a front page promising
 * 150+ was the inconsistency this exists to remove. Payouts stay on the fixture list:
 * no partner enumerates them, and inventing bank corridors for 150 countries would be
 * the opposite lie.
 */
let demoCountries: Country[] | null = null;

function demoAirtime(country: string): Offer {
  const c = demoCountries?.find((x) => x.code === country);
  const name = countryName(country, demoCountries ?? []);
  return {
    offerId: `demo-airtime-${country.toLowerCase()}`,
    name: `${name} airtime (any amount)`,
    brandName: "Demo operator",
    country,
    payoutMethod: "airtime",
    requiredFields: ["phone", "amount"],
    priceType: "range",
    sendCurrency: c?.currency ?? "USD",
    sendMin: 1,
    sendMax: 60,
    settlementSeconds: 3,
  };
}

export const demoDriver: Driver = {
  demo: true,
  async countries(type) {
    if (type !== "topup") return null;
    try {
      demoCountries = await getCountries("topup");
    } catch {
      demoCountries = null;
    }
    return demoCountries;
  },
  async catalog(type, country) {
    await wait(jitter(320));
    const fixtures = DEMO_OFFERS.filter(
      (o) =>
        o.country === country &&
        (type === "topup"
          ? o.payoutMethod === "airtime"
          : o.payoutMethod === "bank" || o.payoutMethod === "mobile_money"),
    );
    if (type === "topup" && !fixtures.length) return [demoAirtime(country)];
    return fixtures;
  },
  async limits() {
    await wait(jitter(220));
    return {
      payer: "DEMOPAYER" + "X".repeat(49),
      tier: "business",
      suspended: false,
      max_order_usdc: 500,
      max_payout_usdc: 500,
      daily_usdc: 25000,
      sender_verified: true,
    };
  },
  async quote(req) {
    await wait(jitter(260));
    const amount = Number(req.amount ?? 0);
    const name = String(req.recipient.fields?.["full_name"] ?? "");
    const acct = String(req.recipient.fields?.["account_number"] ?? "");
    if (acct && /^0{4,}/.test(acct)) {
      throw new Error(
        "That account number was rejected by the receiving bank. Check the digits and try again.",
      );
    }
    if (amount > 500) {
      throw new Error(
        `This payment of ${amount.toFixed(2)} USDC is above your 500.00 USDC per-payment ceiling.`,
      );
    }
    const fee = Math.max(0.12, amount * 0.009);
    return {
      quoteId: `demo_q_${++demoSeq}_${Math.random().toString(36).slice(2, 8)}`,
      price_usdc: Math.round((amount + fee) * 100) / 100,
      delivers: name ? `${name} — settles in about 3 seconds` : "Settles in about 3 seconds",
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  },
  async createOrder(quoteId) {
    await wait(jitter(400));
    const roll = Math.random();
    const outcome: DemoOrder["outcome"] =
      roll > 0.94 ? "refunded" : roll > 0.9 ? "failed" : "delivered";
    const id = `demo_o_${quoteId.slice(-6)}_${Math.random().toString(36).slice(2, 8)}`;
    demoOrders.set(id, { createdAt: Date.now(), outcome, amount: 0 });
    return id;
  },
  async order(id) {
    const o = demoOrders.get(id);
    if (!o) return { status: "unknown", terminal: true, error: "Order not found." };
    const age = Date.now() - o.createdAt;
    if (age < 1400) return { status: "settling", terminal: false };
    const tx = txid();
    if (o.outcome === "delivered") {
      return {
        status: "delivered",
        terminal: true,
        settlement_txid: tx,
        settlement_url: `https://allo.info/tx/${tx}`,
        confirmation: `REF-${tx.slice(0, 10)}`,
      };
    }
    if (o.outcome === "refunded") {
      return {
        status: "refunded",
        terminal: true,
        settlement_txid: tx,
        settlement_url: `https://allo.info/tx/${tx}`,
        refund_txid: txid(),
        error:
          "The receiving bank did not confirm delivery, so the payment was refunded to your balance.",
      };
    }
    return {
      status: "failed",
      terminal: true,
      error: "The mobile money provider rejected this recipient. The funds were not sent.",
    };
  },
};

export const DEMO_ROWS: Record<string, string>[] = [
  { full_name: "Adaeze Okonkwo", account_number: "0123456789", bank_code: "058", amount: "120" },
  { full_name: "Chinedu Balogun", account_number: "2233445566", bank_code: "011", amount: "85" },
  { full_name: "Fatima Yusuf", account_number: "3344556677", bank_code: "044", amount: "240" },
  { full_name: "Emeka Nwosu", account_number: "4455667788", bank_code: "057", amount: "60" },
  { full_name: "Ngozi Adeyemi", account_number: "5566778899", bank_code: "058", amount: "175" },
  { full_name: "Tunde Bakare", account_number: "6677889900", bank_code: "070", amount: "95" },
  { full_name: "Halima Sule", account_number: "7788990011", bank_code: "011", amount: "310" },
  { full_name: "Obinna Eze", account_number: "8899001122", bank_code: "033", amount: "140" },
  { full_name: "Amaka Nnaji", account_number: "9900112233", bank_code: "058", amount: "70" },
  { full_name: "Segun Alabi", account_number: "1011121314", bank_code: "232", amount: "220" },
  { full_name: "Zainab Ibrahim", account_number: "1213141516", bank_code: "044", amount: "130" },
  { full_name: "Kelechi Okafor", account_number: "1415161718", bank_code: "057", amount: "45" },
];
