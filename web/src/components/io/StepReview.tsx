import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowLeft, ArrowRight, RefreshCw, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Field, Panel, StatusChip, inputClass, stripeBorder } from "./primitives";
import { useBatch } from "@/lib/io/store";
import { FALLBACK_COUNTRIES, fieldLabel } from "@/lib/io/types";
import { mmss, timeLeft, usdc } from "@/lib/io/format";

/**
 * A countdown that re-renders ONLY itself.
 *
 * This used to be a `useTick()` in StepReview, bumping state once a second — which
 * re-rendered the whole priced table every second. At 200 rows (7 cells, a status
 * chip and a stripe each) that froze the renderer, which is the opposite of the
 * "300 rows without lag" the console is for. The table now renders when the DATA
 * changes; only these spans tick.
 */
function Countdown({ expiresAt, className }: { expiresAt: string; className?: string }) {
  const [ms, setMs] = useState(() => timeLeft(expiresAt));
  useEffect(() => {
    setMs(timeLeft(expiresAt));
    const t = setInterval(() => setMs(timeLeft(expiresAt)), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (ms == null) return null;
  return <span className={className}>{mmss(Math.max(0, ms))}</span>;
}

export function StepReview() {
  const {
    rows,
    fields,
    offer,
    sender,
    setSender,
    goStep,
    quoting,
    quoteProgress,
    quoteAll,
    payer,
    connect,
    connecting,
    limits,
    demo,
  } = useBatch();

  const priced = rows.filter((r) => r.status === "quoted" && r.quote);
  const errored = rows.filter((r) => r.status === "quote_error");
  const pending = rows.filter((r) => r.status === "draft" || r.status === "quoting");

  const total = useMemo(() => priced.reduce((s, r) => s + (r.quote?.price_usdc ?? 0), 0), [priced]);
  const face = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.values["amount"]) || 0), 0),
    [rows],
  );

  const expired = priced.filter((r) => (timeLeft(r.quote?.expires_at) ?? 1) <= 0);
  const soonestQuote = priced
    .filter((r) => (timeLeft(r.quote?.expires_at) ?? 0) > 0)
    .sort((a, b) => (timeLeft(a.quote?.expires_at) ?? 0) - (timeLeft(b.quote?.expires_at) ?? 0))[0];
  const soonest = timeLeft(soonestQuote?.quote?.expires_at) ?? undefined;

  /**
   * Will this batch outrun its own prices?
   *
   * Each row is one payment plus settlement polling — about 4s in practice, and the
   * rows run in sequence because each needs its own wallet signature. A price holds
   * for ten minutes. Past roughly 150 rows the tail expires mid-run, and the operator
   * finds out one failed row at a time, two hundred rows in, having already approved
   * two hundred payments. Saying so here costs a sentence.
   */
  const SECONDS_PER_ROW = 4;
  const runSeconds = priced.length * SECONDS_PER_ROW;
  const outrunsPrices = soonest != null && runSeconds * 1000 > soonest;

  /**
   * Virtualise the priced table.
   *
   * Step one already did this; this step did not, and it is the step that holds the
   * table longest — 200 rows meant 200 <tr> in the DOM, each re-rendered on every one
   * of 200 quote completions. The renderer froze. "300 rows should scroll and filter
   * without lag" is a requirement, not a nicety: this is the screen where someone
   * checks what 200 people are about to be paid.
   *
   * Spacer rows rather than absolute positioning, because a <table> must keep its
   * row/cell structure for column widths (and for a screen reader) to work at all.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 46,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const padTop = virtualRows[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0);
  const colCount = fields.length + 2;

  const senderReady = sender.name.trim().length > 1;
  const canQuote = Boolean(offer) && senderReady && (demo || Boolean(payer)) && rows.length > 0;
  const overLimit = limits && total > limits.daily_usdc;

  return (
    <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <Panel
          title="Locked prices"
          description={
            quoting
              ? `Pricing ${quoteProgress.done} of ${quoteProgress.total} recipients…`
              : priced.length
                ? `${priced.length} of ${rows.length} recipients have a locked price.`
                : "Lock a price for every recipient before you pay."
          }
          aside={
            <Button
              variant={priced.length ? "default" : "primary"}
              onClick={() => void quoteAll()}
              disabled={!canQuote || quoting}
            >
              <RefreshCw className={cn("size-4", quoting && "motion-safe:animate-spin")} />
              {quoting ? "Pricing…" : priced.length ? "Refresh prices" : "Lock prices"}
            </Button>
          }
        >
          {quoting && (
            <div className="h-0.5 w-full bg-surface-2">
              <div
                className="h-full bg-primary transition-[width] duration-300"
                style={{
                  width: `${quoteProgress.total ? (quoteProgress.done / quoteProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
          )}

          <div ref={scrollRef} className="max-h-[62vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 z-10 bg-surface text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {fields.map((f) => (
                    <th key={f} className="border-b border-border px-3 py-2 font-semibold">
                      {fieldLabel(f)}
                    </th>
                  ))}
                  <th className="border-b border-border px-3 py-2 text-right font-semibold">
                    You pay (USDC)
                  </th>
                  <th className="border-b border-border px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {padTop > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount} style={{ height: padTop }} />
                  </tr>
                )}
                {virtualRows.map((v) => {
                  const r = rows[v.index]!;
                  const ms = timeLeft(r.quote?.expires_at);
                  const isExpired = r.quote && ms != null && ms <= 0;
                  return (
                    <tr key={r.id} className={cn("hover:bg-surface-2/60")}>
                      {fields.map((f, i) => (
                        <td
                          key={f}
                          className={cn(
                            "border-b border-border px-3 py-2 align-top",
                            i === 0 && `border-l-[3px] ${stripeBorder(r.status)}`,
                            f === "amount" && "num tabular-nums",
                          )}
                        >
                          {r.values[f] || <span className="text-muted-foreground">—</span>}
                        </td>
                      ))}
                      <td className="num border-b border-border px-3 py-2 text-right tabular-nums">
                        {r.quote ? (
                          <span className={cn(isExpired && "text-muted-foreground line-through")}>
                            {usdc(r.quote.price_usdc)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="border-b border-border px-3 py-2">
                        <div className="flex flex-col items-start gap-1">
                          <StatusChip status={isExpired ? "draft" : r.status} />
                          {r.status === "quote_error" && r.message && (
                            <span className="max-w-[38ch] text-[12px] text-failed">
                              {r.message}
                            </span>
                          )}
                          {isExpired && (
                            <span className="text-[12px] text-pending">
                              Price expired — refresh to lock a new one.
                            </span>
                          )}
                          {!isExpired && r.quote && (
                            <span className="num inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                              <Timer className="size-3" />
                              <Countdown expiresAt={r.quote.expires_at} />
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {padBottom > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount} style={{ height: padBottom }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!rows.length && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No recipients yet. Go back to step one to add them.
            </p>
          )}
        </Panel>

        {errored.length > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-failed/30 bg-failed-soft px-4 py-3 text-[13px] text-failed">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <strong className="font-semibold">
                {errored.length} recipient{errored.length > 1 ? "s" : ""} could not be priced.
              </strong>{" "}
              Fix them in step one, or continue and pay the rest — they will be left out.
              <button onClick={() => goStep(1)} className="ml-2 underline underline-offset-2">
                Fix now
              </button>
            </div>
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-[7.5rem] lg:self-start">
        <Panel title="Sender" description="Required by the receiving banks.">
          <div className="flex flex-col gap-3 p-4">
            <Field label="Sender name" htmlFor="sender-name">
              <input
                id="sender-name"
                className={inputClass}
                placeholder="Acme Payments Ltd"
                value={sender.name}
                onChange={(e) => setSender({ ...sender, name: e.target.value })}
              />
            </Field>
            <Field label="Sender country" htmlFor="sender-country">
              <select
                id="sender-country"
                className={inputClass}
                value={sender.country}
                onChange={(e) => setSender({ ...sender, country: e.target.value })}
              >
                {["GB", "US", "DE", "AE", "SG", "ZA", ...FALLBACK_COUNTRIES.map((c) => c.code)]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
            </Field>
            {!senderReady && (
              <p className="text-[12px] text-pending">Add a sender name before locking prices.</p>
            )}
          </div>
        </Panel>

        <Panel title="Batch total">
          <dl className="flex flex-col gap-2.5 p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Recipients</dt>
              <dd className="num tabular-nums">{rows.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Face value</dt>
              <dd className="num tabular-nums">{usdc(face)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Priced</dt>
              <dd className="num tabular-nums">
                {priced.length}
                {pending.length > 0 && (
                  <span className="text-muted-foreground"> / {rows.length}</span>
                )}
              </dd>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
              <dt className="font-semibold">You pay</dt>
              <dd className="num text-lg font-semibold tabular-nums">{usdc(total)} USDC</dd>
            </div>
            {soonest != null && (
              <p className="num text-[12px] text-muted-foreground">
                Prices hold for <Countdown expiresAt={soonestQuote!.quote!.expires_at} />.
              </p>
            )}
            {outrunsPrices && expired.length === 0 && (
              <p className="text-[12px] text-pending">
                {priced.length} payments take roughly {Math.ceil(runSeconds / 60)} minutes and the
                prices hold for {mmss(soonest!)} — the last rows will expire mid-run. Pay in smaller
                batches, or re-price the remainder when they fail.
              </p>
            )}
            {expired.length > 0 && (
              <p className="text-[12px] text-pending">
                {expired.length} price{expired.length > 1 ? "s" : ""} expired — refresh before
                paying.
              </p>
            )}
            {overLimit && (
              <p className="text-[12px] text-failed">
                This batch is above your {usdc(limits!.daily_usdc)} USDC daily ceiling.
              </p>
            )}
          </dl>
        </Panel>

        {!demo && !payer && (
          <Panel title="Connect to price this batch">
            <div className="flex flex-col gap-3 p-4">
              <p className="text-[13px] text-muted-foreground">
                Prices are locked against your account, so connect your Pera wallet first.
              </p>
              <Button variant="primary" onClick={() => void connect()} disabled={connecting}>
                {connecting ? "Connecting…" : "Connect Pera wallet"}
              </Button>
            </div>
          </Panel>
        )}

        <div className="flex gap-2">
          <Button variant="quiet" onClick={() => goStep(1)}>
            <ArrowLeft className="size-4" />
            Recipients
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={!priced.length || expired.length > 0 || quoting}
            onClick={() => goStep(3)}
          >
            Pay {priced.length} recipient{priced.length === 1 ? "" : "s"}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </aside>
    </div>
  );
}
