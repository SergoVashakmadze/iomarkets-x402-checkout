import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { demoDriver, realDriver, type Driver } from "./driver";
import { timeLeft } from "./format";
import {
  FALLBACK_COUNTRIES,
  type Country,
  type Limits,
  type Offer,
  type PayType,
  type Row,
  type Sender,
} from "./types";

const STORAGE_KEY = "iomarkets.batch.v1";

/**
 * How long a half-built batch survives on the device.
 *
 * The brief requires that a reload mid-run loses nothing, so this has to persist —
 * but what it persists is recipient PII: legal names, bank account numbers, wallet
 * and mobile-money identifiers for people who are not the user. On a shared
 * operations workstation that is somebody else's data sitting in a browser profile
 * indefinitely, readable by any script that ever runs on this origin.
 *
 * 24h is long enough to survive a reload, a crash, or going home and coming back;
 * short enough that last month's payroll is not still on the machine.
 */
const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const SENDER_KEY = "iomarkets.sender.v1";

export interface Persisted {
  step: 1 | 2 | 3 | 4;
  type: PayType;
  country: string;
  offerId: string | null;
  rows: Row[];
}

const DEFAULTS: Persisted = {
  step: 1,
  type: "payout",
  country: "NG",
  offerId: null,
  rows: [],
};

export function newRow(values: Record<string, string> = {}): Row {
  return {
    id: `r_${Math.random().toString(36).slice(2, 10)}`,
    values,
    status: "draft",
  };
}

/* ------------------------------ validation ------------------------------ */

export function validateCell(field: string, value: string, offer: Offer | null): string | null {
  const v = (value ?? "").trim();
  if (!v) return `missing ${field}`;
  if (field === "amount") {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return "amount must be a number greater than 0";
    if (offer?.sendMin != null && n < offer.sendMin)
      return `amount below the ${offer.sendMin} minimum`;
    if (offer?.sendMax != null && n > offer.sendMax)
      return `amount above the ${offer.sendMax} maximum`;
  }
  if (field === "phone" && !/^\+?[\d][\d\s-]{6,17}$/.test(v))
    return "phone number looks incomplete";
  if (field === "account_number" && !/^\d{6,20}$/.test(v))
    return "account number must be 6–20 digits";
  if (field === "bank_code" && !/^[A-Za-z0-9]{2,11}$/.test(v)) return "bank code looks wrong";
  if (field === "ifsc" && !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(v))
    return "IFSC must look like HDFC0001234";
  if (field === "full_name" && v.length < 2) return "full name is too short";
  return null;
}

export function rowErrors(row: Row, fields: string[], offer: Offer | null): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of fields) {
    const e = validateCell(f, row.values[f] ?? "", offer);
    if (e) errs[f] = e;
  }
  return errs;
}

/* -------------------------------- context ------------------------------- */

interface Ctx {
  demo: boolean;
  driver: Driver;
  step: 1 | 2 | 3 | 4;
  goStep: (s: 1 | 2 | 3 | 4) => void;
  type: PayType;
  country: string;
  /** Destinations for the current product — the service's list, or the fallback five. */
  countries: Country[];
  offerId: string | null;
  offers: Offer[];
  offer: Offer | null;
  offersLoading: boolean;
  offersError: string | null;
  fields: string[];
  rows: Row[];
  sender: Sender;
  setSender: (s: Sender) => void;
  payer: string | null;
  limits: Limits | null;
  walletError: string | null;
  /** Product types served by a mock supplier — nothing on them is really delivered. */
  simulated: string[];
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setType: (t: PayType) => void;
  setCountry: (c: string) => void;
  setOffer: (id: string) => void;
  setRows: (r: Row[] | ((prev: Row[]) => Row[])) => void;
  patchRow: (id: string, patch: Partial<Row>) => void;
  setCell: (id: string, field: string, value: string) => void;
  addRow: (after?: string) => string;
  deleteRow: (id: string) => void;
  reset: () => void;
  errorsFor: (row: Row) => Record<string, string>;
  quoting: boolean;
  quoteProgress: { done: number; total: number };
  quoteAll: () => Promise<void>;
  running: boolean;
  runProgress: { done: number; total: number };
  runBatch: () => Promise<void>;
  retryRow: (id: string) => Promise<void>;
}

const BatchContext = createContext<Ctx | null>(null);

export function useBatch() {
  const ctx = useContext(BatchContext);
  if (!ctx) throw new Error("useBatch must be used inside BatchProvider");
  return ctx;
}

export function BatchProvider({ children, demo }: { children: ReactNode; demo: boolean }) {
  const driver = demo ? demoDriver : realDriver;

  const [state, setState] = useState<Persisted>(DEFAULTS);
  const [sender, setSenderState] = useState<Sender>({ name: "", country: "GB" });
  const [hydrated, setHydrated] = useState(false);

  const [countries, setCountries] = useState<Country[]>(FALLBACK_COUNTRIES);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersError, setOffersError] = useState<string | null>(null);

  const [payer, setPayer] = useState<string | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  /**
   * Product types the SERVER says are backed by a mock supplier. Demo mode labels
   * itself; a mock supplier renders corridors indistinguishable from real ones and
   * says nothing — which is how a test batch gets screenshotted as settled volume.
   */
  const [simulated, setSimulated] = useState<string[]>([]);
  useEffect(() => {
    if (demo) return; // demo mode has its own, louder banner
    void import("./api")
      .then((m) => m.getClientConfig())
      .then((c) => setSimulated(c.simulated ?? []))
      .catch(() => setSimulated([]));
  }, [demo]);
  const [connecting, setConnecting] = useState(false);

  const [quoting, setQuoting] = useState(false);
  const [quoteProgress, setQuoteProgress] = useState({ done: 0, total: 0 });
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState({ done: 0, total: 0 });

  /* hydrate from storage after mount (never during SSR/first render) */
  useEffect(() => {
    try {
      const key = demo ? STORAGE_KEY + ".demo" : STORAGE_KEY;
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Persisted & { savedAt?: number };
        // Expired batches are dropped rather than shown. Reading the timestamp before
        // anything else means a stale batch never reaches the screen at all.
        if (typeof parsed.savedAt === "number" && Date.now() - parsed.savedAt > BATCH_TTL_MS) {
          localStorage.removeItem(key);
          setHydrated(true);
          return;
        }
        // in-flight rows are resumed as retryable rather than silently "paying"
        parsed.rows = (parsed.rows ?? []).map((r) =>
          r.status === "paying" || r.status === "settling" || r.status === "quoting"
            ? {
                ...r,
                status: "failed",
                message: "Interrupted by a page reload — retry to finish this payment.",
              }
            : r,
        );
        setState({ ...DEFAULTS, ...parsed });
      }
      const s = localStorage.getItem(SENDER_KEY);
      if (s) setSenderState(JSON.parse(s) as Sender);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, [demo]);

  /**
   * Persist the batch — DEBOUNCED, and that is load-bearing rather than tidy.
   *
   * This effect runs on every state change, and a run produces one per row: quoting
   * 200 recipients patched state 200 times, and each write serialised the WHOLE batch
   * and handed it to a synchronous localStorage.setItem. That is O(n^2) blocking work
   * on the main thread — 200 rows froze the renderer outright, which is exactly the
   * moment the operator is watching prices land.
   *
   * Coalescing to one write per 400ms keeps the guarantee that matters (a reload
   * loses nothing) while making the cost O(n) over the run. The flush on unmount
   * covers the case where the last change lands inside the debounce window.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!hydrated) return;
    const key = demo ? STORAGE_KEY + ".demo" : STORAGE_KEY;
    const write = () => {
      try {
        localStorage.setItem(key, JSON.stringify({ ...stateRef.current, savedAt: Date.now() }));
      } catch {
        /* quota, or storage disabled */
      }
    };
    // NOTE: the cleanup must NOT write. It runs before every re-run of this effect,
    // so writing there would fire on every state change and defeat the debounce
    // entirely — the bug this replaced. The unmount flush lives in its own effect.
    const t = setTimeout(write, 400);
    writeRef.current = write;
    return () => clearTimeout(t);
  }, [state, hydrated, demo]);

  /** Flush once on unmount, for a change still inside the debounce window. */
  const writeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => writeRef.current?.(), []);

  const setSender = useCallback((s: Sender) => {
    setSenderState(s);
    try {
      localStorage.setItem(SENDER_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, []);

  /* demo mode: a pretend connected payer */
  useEffect(() => {
    if (!demo) return;
    setPayer("DEMO" + "7Z4KQ2XW".repeat(6) + "AB");
    void driver.limits("demo").then(setLimits);
  }, [demo, driver]);

  /* destinations — per product, from the service where it can enumerate them */
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    driver
      .countries(state.type)
      .catch(() => null)
      .then((list) => {
        if (cancelled) return;
        const next = list ?? FALLBACK_COUNTRIES;
        setCountries(next);
        // A country picked under one product may not exist under the next; land on
        // the first fixture country the list has, or its first entry.
        setState((s) => {
          if (next.some((c) => c.code === s.country)) return s;
          const first =
            FALLBACK_COUNTRIES.find((f) => next.some((c) => c.code === f.code))?.code ??
            next[0]?.code ??
            s.country;
          return { ...s, country: first, offerId: null };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [driver, state.type, hydrated]);

  /* catalog */
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    setOffersLoading(true);
    setOffersError(null);
    driver
      .catalog(state.type, state.country)
      .then((o) => {
        if (cancelled) return;
        setOffers(o);
        setState((s) => ({
          ...s,
          offerId: o.some((x) => x.offerId === s.offerId) ? s.offerId : (o[0]?.offerId ?? null),
        }));
      })
      .catch((e: Error) => !cancelled && setOffersError(e.message))
      .finally(() => !cancelled && setOffersLoading(false));
    return () => {
      cancelled = true;
    };
  }, [driver, state.type, state.country, hydrated]);

  const offer = useMemo(
    () => offers.find((o) => o.offerId === state.offerId) ?? null,
    [offers, state.offerId],
  );

  const fields = useMemo(() => {
    const base = offer?.requiredFields ?? [];
    return base.includes("amount") ? base : [...base, "amount"];
  }, [offer]);

  const errorsFor = useCallback((row: Row) => rowErrors(row, fields, offer), [fields, offer]);

  /* wallet */
  const connect = useCallback(async () => {
    setConnecting(true);
    setWalletError(null);
    try {
      const { connectWallet } = await import("./wallet");
      const addr = await connectWallet();
      setPayer(addr);
      try {
        setLimits(await driver.limits(addr));
      } catch (e) {
        setWalletError((e as Error).message);
      }
    } catch (e) {
      setWalletError((e as Error).message || "Could not connect your wallet.");
    } finally {
      setConnecting(false);
    }
  }, [driver]);

  const disconnect = useCallback(async () => {
    if (demo) return;
    const { disconnectWallet } = await import("./wallet");
    await disconnectWallet();
    setPayer(null);
    setLimits(null);
  }, [demo]);

  /* row helpers */
  const setRows = useCallback((r: Row[] | ((prev: Row[]) => Row[])) => {
    setState((s) => ({ ...s, rows: typeof r === "function" ? r(s.rows) : r }));
  }, []);

  const patchRow = useCallback((id: string, patch: Partial<Row>) => {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }, []);

  const setCell = useCallback((id: string, field: string, value: string) => {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) =>
        r.id === id
          ? {
              ...r,
              values: { ...r.values, [field]: value },
              status: "draft",
              quote: undefined,
              message: undefined,
            }
          : r,
      ),
    }));
  }, []);

  const addRow = useCallback((after?: string) => {
    const row = newRow();
    setState((s) => {
      const idx = after ? s.rows.findIndex((r) => r.id === after) : -1;
      const rows = [...s.rows];
      rows.splice(idx >= 0 ? idx + 1 : rows.length, 0, row);
      return { ...s, rows };
    });
    return row.id;
  }, []);

  const deleteRow = useCallback((id: string) => {
    setState((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== id) }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({ ...DEFAULTS, type: s.type, country: s.country, offerId: s.offerId }));
    setQuoteProgress({ done: 0, total: 0 });
    setRunProgress({ done: 0, total: 0 });
    // Starting a new batch must actually REMOVE the finished one, not just stop
    // rendering it. The persist effect below will write the empty state back, but
    // only after a render — and if the tab is closed in between, the previous
    // batch's recipient names and account numbers would survive on the device.
    try {
      localStorage.removeItem(demo ? STORAGE_KEY + ".demo" : STORAGE_KEY);
    } catch {
      /* private mode / storage disabled — nothing was written either */
    }
  }, [demo]);

  const goStep = useCallback((step: 1 | 2 | 3 | 4) => setState((s) => ({ ...s, step })), []);

  /* quoting */
  const rowsRef = useRef(state.rows);
  rowsRef.current = state.rows;

  const quoteAll = useCallback(async () => {
    if (!offer || !payer) return;
    const targets = rowsRef.current.filter((r) => r.status !== "quoted");
    setQuoting(true);
    setQuoteProgress({ done: 0, total: targets.length });
    let done = 0;
    const CONCURRENCY = 4;
    const queue = [...targets];

    const worker = async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        patchRow(row.id, { status: "quoting", message: undefined });
        try {
          const amount = Number(row.values["amount"] ?? 0);
          const recipient = offer.requiredFields.includes("phone")
            ? { phone: row.values["phone"] ?? "", fields: row.values }
            : { fields: row.values };
          const quote = await driver.quote({
            type: state.type,
            offerId: offer.offerId,
            amount,
            recipient,
            sender: { name: sender.name, country: sender.country },
            payer,
          });
          patchRow(row.id, { status: "quoted", quote, message: quote.delivers });
        } catch (e) {
          patchRow(row.id, { status: "quote_error", message: (e as Error).message });
        } finally {
          done++;
          setQuoteProgress({ done, total: targets.length });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setQuoting(false);
  }, [driver, offer, payer, patchRow, sender, state.type]);

  /* execution */
  const executeRow = useCallback(
    async (row: Row) => {
      if (!row.quote || !payer) return;

      // A price is locked for QUOTE_TTL_SEC (10 minutes by default) and a long batch
      // can outrun it: 300 rows settling in ~3s each is 15 minutes. The server refuses
      // an expired quote BEFORE any payment, so nothing is lost — but firing the
      // request anyway costs a round trip per row and reports the failure in the
      // server's words rather than in terms of what the operator has to do about it.
      if ((timeLeft(row.quote.expires_at) ?? 1) <= 0) {
        patchRow(row.id, {
          status: "failed",
          message: "Price expired before this row was reached — re-price the batch and retry.",
        });
        return;
      }

      patchRow(row.id, { status: "paying", message: undefined });
      try {
        const orderId = await driver.createOrder(row.quote.quoteId, payer, row.quote.price_usdc);
        patchRow(row.id, { status: "settling", orderId });
        for (;;) {
          await new Promise((r) => setTimeout(r, 2200));
          const st = await driver.order(orderId);
          if (!st.terminal) {
            patchRow(row.id, {
              status: "settling",
              settlementTxid: st.settlement_txid,
              settlementUrl: st.settlement_url,
            });
            continue;
          }
          const status =
            st.status === "delivered" || st.status === "completed" || st.status === "success"
              ? "delivered"
              : st.status === "refunded"
                ? "refunded"
                : "failed";
          patchRow(row.id, {
            status,
            settlementTxid: st.settlement_txid,
            settlementUrl: st.settlement_url,
            confirmation: st.confirmation,
            message:
              status === "delivered"
                ? (st.confirmation ?? "Delivered")
                : (st.error ?? "The provider did not deliver this payment."),
          });
          return;
        }
      } catch (e) {
        patchRow(row.id, { status: "failed", message: (e as Error).message });
      }
    },
    [driver, patchRow, payer],
  );

  const runBatch = useCallback(async () => {
    const targets = rowsRef.current.filter((r) => r.status === "quoted");
    if (!targets.length) return;
    setRunning(true);
    setRunProgress({ done: 0, total: targets.length });
    setState((s) => ({
      ...s,
      step: 3,
      rows: s.rows.map((r) => (r.status === "quoted" ? { ...r, status: "queued" } : r)),
    }));
    let done = 0;
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        await executeRow(row);
        done++;
        setRunProgress({ done, total: targets.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    setRunning(false);
  }, [executeRow]);

  const retryRow = useCallback(
    async (id: string) => {
      const row = rowsRef.current.find((r) => r.id === id);
      if (!row) return;
      if (!row.quote) {
        // re-quote then execute
        await quoteAll();
        const fresh = rowsRef.current.find((r) => r.id === id);
        if (fresh?.quote) await executeRow(fresh);
        return;
      }
      await executeRow(row);
    },
    [executeRow, quoteAll],
  );

  const value: Ctx = {
    demo,
    simulated,
    driver,
    step: state.step,
    goStep,
    type: state.type,
    country: state.country,
    countries,
    offerId: state.offerId,
    offers,
    offer,
    offersLoading,
    offersError,
    fields,
    rows: state.rows,
    sender,
    setSender,
    payer,
    limits,
    walletError,
    connecting,
    connect,
    disconnect,
    // Re-picking the current value must not clear the corridor: nothing else changes, so
    // the offers effect never re-runs to choose one again, and the page sticks on
    // "Choose a corridor" while the dropdown still shows one.
    setType: (t) => setState((s) => (s.type === t ? s : { ...s, type: t, offerId: null })),
    setCountry: (c) => setState((s) => (s.country === c ? s : { ...s, country: c, offerId: null })),
    setOffer: (id) => setState((s) => ({ ...s, offerId: id })),
    setRows,
    patchRow,
    setCell,
    addRow,
    deleteRow,
    reset,
    errorsFor,
    quoting,
    quoteProgress,
    quoteAll,
    running,
    runProgress,
    runBatch,
    retryRow,
  };

  return <BatchContext.Provider value={value}>{children}</BatchContext.Provider>;
}
