import {
  countryName,
  type Country,
  type Limits,
  type Offer,
  type PayType,
  type Quote,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readError(res: Response) {
  let msg = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) msg = body.error;
  } catch {
    /* non-json */
  }
  return new ApiError(msg, res.status);
}

export async function getCatalog(type: PayType, country: string): Promise<Offer[]> {
  const res = await fetch(`/v1/catalog?type=${type}&country=${country}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { offers?: Offer[] };
  return data.offers ?? [];
}

/**
 * Where a product can be delivered, sorted by name — or `null` when the service cannot
 * say. An empty answer means the supplier will not enumerate, NOT that there are no
 * destinations, so the caller keeps its fallback list rather than emptying the picker.
 */
export async function getCountries(type: PayType): Promise<Country[] | null> {
  const res = await fetch(`/v1/countries?type=${type}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as {
    enumerable?: boolean;
    countries?: Array<{ code: string; name?: string; currency?: string }>;
  };
  if (!data.enumerable || !data.countries?.length) return null;
  return data.countries
    .map((c) => ({ code: c.code, name: c.name ?? countryName(c.code, []), currency: c.currency }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getLimits(payer: string): Promise<Limits> {
  const res = await fetch(`/v1/limits?payer=${encodeURIComponent(payer)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as Limits;
}

export interface QuoteRequest {
  type: PayType;
  offerId: string;
  amount?: number | undefined;
  recipient: { fields?: Record<string, string>; phone?: string };
  sender: { name: string; country: string };
  payer: string;
}

export async function postQuote(req: QuoteRequest): Promise<Quote> {
  const res = await fetch(`/v1/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as Quote;
}

export interface OrderStatus {
  status: string;
  terminal: boolean;
  settlement_txid?: string | undefined;
  settlement_url?: string | undefined;
  confirmation?: string | undefined;
  receipt?: unknown;
  refund_txid?: string | undefined;
  error?: string | undefined;
}

export async function getOrder(id: string): Promise<OrderStatus> {
  const res = await fetch(`/v1/orders/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as OrderStatus;
}

/** Raw order create — returns the raw Response so the x402 402 flow can read headers. */
export function postOrderRaw(quoteId: string, paymentHeader?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (paymentHeader) headers["X-PAYMENT"] = paymentHeader;
  return fetch(`/v1/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ quoteId }),
  });
}

/**
 * Network parameters the browser needs to build a payment. Public values only —
 * a public algod endpoint, the on-chain ASA id, and the same ceiling /v1/limits
 * reports. Fetched rather than bundled so a testnet box does not serve a console
 * hardcoded to mainnet.
 */
export interface ClientConfig {
  /**
   * Product types filled by a MOCK supplier — corridors that render exactly like real
   * ones and deliver nothing. The console must say so on screen: `?demo=1` labels
   * itself, a mock supplier does not, and the difference is a screenshot someone
   * mistakes for settled volume.
   */
  simulated: string[];
  network: string;
  /** CAIP-2 network id, e.g. `algorand:wGHE2…kit8=`. */
  caip2: `${string}:${string}`;
  algod_url: string;
  usdc_asa: string;
  max_order_usdc: string;
  min_order_usdc: string;
}

let clientConfig: Promise<ClientConfig> | undefined;

/** Cached for the life of the page; these values change only on a redeploy. */
export function getClientConfig(): Promise<ClientConfig> {
  if (!clientConfig) {
    clientConfig = (async () => {
      const res = await fetch("/v1/client-config", { headers: { accept: "application/json" } });
      if (!res.ok) throw await readError(res);
      return (await res.json()) as ClientConfig;
    })().catch((e: unknown) => {
      // Do not cache a failure — a transient error would otherwise disable payment
      // for the rest of the session.
      clientConfig = undefined;
      throw e;
    });
  }
  return clientConfig;
}
