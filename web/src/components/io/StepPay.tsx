import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Panel, StatusChip, stripeBorder } from "./primitives";
import { useBatch } from "@/lib/io/store";
import { fieldLabel } from "@/lib/io/types";
import { shortAddr, usdc, safeHttpUrl } from "@/lib/io/format";

const LIVE = new Set(["queued", "paying", "settling"]);

export function StepPay() {
  const {
    rows,
    fields,
    goStep,
    running,
    runProgress,
    runBatch,
    retryRow,
    payer,
    connect,
    connecting,
    demo,
  } = useBatch();

  const payable = rows.filter((r) => r.status === "quoted" && r.quote);
  const active = rows.filter((r) => LIVE.has(r.status));
  const delivered = rows.filter((r) => r.status === "delivered");
  const failed = rows.filter((r) => r.status === "failed" || r.status === "refunded");
  const started = active.length + delivered.length + failed.length > 0;
  const finished = started && !running && active.length === 0;

  const authorised = useMemo(
    () =>
      rows
        .filter((r) => r.quote && r.status !== "draft" && r.status !== "quote_error")
        .reduce((s, r) => s + (r.quote?.price_usdc ?? 0), 0),
    [rows],
  );
  const settled = useMemo(
    () => delivered.reduce((s, r) => s + (r.quote?.price_usdc ?? 0), 0),
    [delivered],
  );

  const shown = rows.filter((r) => r.status !== "draft" && r.status !== "quote_error");

  /**
   * Virtualised, like steps one and two. This is the screen someone WATCHES — rows
   * animate through paying → settling → delivered — so it re-renders constantly, and
   * a 300-row batch would otherwise keep 300 <tr> in the DOM, each carrying a pulsing
   * animation, for the whole run.
   *
   * Spacer rows rather than absolute positioning: a <table> needs its row/cell
   * structure for column widths and for a screen reader.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const padTop = virtualRows[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0);
  const colCount = fields.length + 3;

  /**
   * Follow the row being paid — but only while the operator has not scrolled away.
   * Watching it work is what builds trust the first time; yanking the viewport back
   * while someone is reading a failure further up destroys it.
   */
  const activeIndex = shown.findIndex((r) => LIVE.has(r.status));
  const followRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Within ~1.5 rows of where the virtualiser would put us counts as "following".
      followRef.current =
        activeIndex < 0 || Math.abs(el.scrollTop - Math.max(0, (activeIndex - 3) * 52)) < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeIndex]);

  useEffect(() => {
    if (activeIndex >= 0 && followRef.current) {
      virtualizer.scrollToIndex(activeIndex, { align: "center", behavior: "auto" });
    }
  }, [activeIndex, virtualizer]);

  return (
    <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <Panel
          title={running ? "Paying now" : finished ? "Batch finished" : "Ready to pay"}
          description={
            running
              ? `${runProgress.done} of ${runProgress.total} payments settled. Failures will not stop the rest.`
              : finished
                ? "Every payment reached a final state."
                : "One approval covers the whole batch. Each payment settles on its own."
          }
          aside={
            finished ? (
              <Button variant="primary" onClick={() => goStep(4)}>
                See receipts
                <ArrowRight className="size-4" />
              </Button>
            ) : null
          }
        >
          {running && (
            <div className="h-0.5 w-full bg-surface-2">
              <div
                className="h-full bg-primary transition-[width] duration-500"
                style={{
                  width: `${runProgress.total ? (runProgress.done / runProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
          )}
          <div ref={scrollRef} className="max-h-[62vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 z-10 bg-surface text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {fields
                    .filter((f) => f !== "amount")
                    .map((f) => (
                      <th key={f} className="border-b border-border px-3 py-2">
                        {fieldLabel(f)}
                      </th>
                    ))}
                  <th className="border-b border-border px-3 py-2 text-right">Paid (USDC)</th>
                  <th className="border-b border-border px-3 py-2">Status</th>
                  <th className="border-b border-border px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {padTop > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount} style={{ height: padTop }} />
                  </tr>
                )}
                {virtualRows
                  .map((v) => shown[v.index]!)
                  .map((r) => (
                    <tr
                      key={r.id}
                      className={cn(
                        LIVE.has(r.status) &&
                          "motion-safe:animate-[io-pulse-row_2s_ease-in-out_infinite]",
                      )}
                    >
                      {fields
                        .filter((f) => f !== "amount")
                        .map((f, i) => (
                          <td
                            key={f}
                            className={cn(
                              "border-b border-border px-3 py-2",
                              i === 0 && `border-l-[3px] ${stripeBorder(r.status)}`,
                            )}
                          >
                            {r.values[f] || "—"}
                          </td>
                        ))}
                      <td className="num border-b border-border px-3 py-2 text-right tabular-nums">
                        {r.quote ? usdc(r.quote.price_usdc) : "—"}
                      </td>
                      <td className="border-b border-border px-3 py-2">
                        <StatusChip status={r.status} />
                      </td>
                      <td className="border-b border-border px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                          <span className="max-w-[42ch]">{r.message ?? "—"}</span>
                          {safeHttpUrl(r.settlementUrl) && (
                            <a
                              href={safeHttpUrl(r.settlementUrl)!}
                              target="_blank"
                              rel="noreferrer"
                              className="num inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              {shortAddr(r.settlementTxid, 5)}
                              <ExternalLink className="size-3" />
                            </a>
                          )}
                          {(r.status === "failed" || r.status === "refunded") && (
                            <Button size="sm" variant="quiet" onClick={() => void retryRow(r.id)}>
                              <RotateCw className="size-3.5" />
                              Retry
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                {padBottom > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount} style={{ height: padBottom }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!shown.length && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              Nothing priced yet — go back to review and lock prices first.
            </p>
          )}
        </Panel>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-[7.5rem] lg:self-start">
        <Panel title="Approval">
          <div className="flex flex-col gap-3 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Paying from</span>
              <span className="num">{demo ? "Demo account" : shortAddr(payer, 5)}</span>
            </div>
            <div className="flex items-baseline justify-between border-t border-border pt-3">
              <span className="font-semibold">{running ? "Authorised" : "Authorising"}</span>
              <span className="num text-lg font-semibold tabular-nums">
                {usdc(authorised)} USDC
              </span>
            </div>
            {!demo && !payer ? (
              <Button variant="primary" onClick={() => void connect()} disabled={connecting}>
                {connecting ? "Connecting…" : "Connect Pera wallet"}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                disabled={!payable.length || running}
                onClick={() => void runBatch()}
              >
                <ShieldCheck className="size-4" />
                {running
                  ? "Paying…"
                  : started
                    ? `Pay remaining ${payable.length}`
                    : `Approve and pay ${payable.length}`}
              </Button>
            )}
            <p className="text-[12px] text-muted-foreground">
              {demo
                ? "Demo mode simulates settlement — no funds move."
                : "You approve once in Pera. Each payment then settles on Algorand via x402."}
            </p>
          </div>
        </Panel>

        <Panel title="Live tally">
          <dl className="flex flex-col gap-2.5 p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Delivered</dt>
              <dd className="num tabular-nums text-settled">{delivered.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">In flight</dt>
              <dd className="num tabular-nums text-pending">{active.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Failed or refunded</dt>
              <dd className="num tabular-nums text-failed">{failed.length}</dd>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
              <dt className="font-semibold">Settled</dt>
              <dd className="num text-lg font-semibold tabular-nums">{usdc(settled)} USDC</dd>
            </div>
          </dl>
        </Panel>

        <div className="flex gap-2">
          <Button variant="quiet" onClick={() => goStep(2)} disabled={running}>
            <ArrowLeft className="size-4" />
            Review
          </Button>
          <Button
            variant={finished ? "primary" : "default"}
            className="flex-1"
            disabled={!started || running}
            onClick={() => goStep(4)}
          >
            Receipts
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </aside>
    </div>
  );
}
