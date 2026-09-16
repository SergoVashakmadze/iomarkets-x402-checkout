import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Download, ExternalLink, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Panel, StatusChip, stripeBorder } from "./primitives";
import { useBatch } from "@/lib/io/store";
import { countryName, fieldLabel } from "@/lib/io/types";
import { downloadCsv, toCsv } from "@/lib/io/csv";
import { shortAddr, usdc, safeHttpUrl } from "@/lib/io/format";

export function StepReceipts() {
  const { rows, fields, goStep, reset, retryRow, offer, country, countries, demo } = useBatch();

  /**
   * Virtualised, like the other three steps. This is the record of a finished job —
   * the table someone scrolls looking for the four rows that need attention — so it is
   * exactly the case the brief means by "300 rows should scroll and filter without lag".
   * The CSV export still walks every row; only the DOM is windowed.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const padTop = virtualRows[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0);
  const colCount = fields.length + 3;

  const delivered = rows.filter((r) => r.status === "delivered");
  const refunded = rows.filter((r) => r.status === "refunded");
  const failed = rows.filter((r) => r.status === "failed" || r.status === "quote_error");

  const settled = useMemo(
    () => delivered.reduce((s, r) => s + (r.quote?.price_usdc ?? 0), 0),
    [delivered],
  );
  const returned = useMemo(
    () => refunded.reduce((s, r) => s + (r.quote?.price_usdc ?? 0), 0),
    [refunded],
  );

  const exportCsv = () => {
    const header = [...fields, "status", "paid_usdc", "confirmation", "settlement_txid", "detail"];
    const body = rows.map((r) => [
      ...fields.map((f) => r.values[f] ?? ""),
      r.status,
      r.quote?.price_usdc ?? "",
      r.confirmation ?? "",
      r.settlementTxid ?? "",
      r.message ?? "",
    ]);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadCsv(`iomarkets-receipts-${stamp}.csv`, toCsv([header, ...body]));
  };

  const stats = [
    { label: "Delivered", value: delivered.length, tone: "text-settled" },
    { label: "Refunded", value: refunded.length, tone: "text-refunded" },
    { label: "Failed", value: failed.length, tone: "text-failed" },
  ];

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-5 py-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="panel px-4 py-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              {s.label}
            </div>
            <div className={cn("num mt-1 text-3xl font-semibold tabular-nums", s.tone)}>
              {s.value}
            </div>
          </div>
        ))}
        <div className="panel px-4 py-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            Total settled
          </div>
          <div className="num mt-1 text-3xl font-semibold tabular-nums">{usdc(settled)}</div>
          <div className="text-[12px] text-muted-foreground">
            USDC{returned > 0 ? ` · ${usdc(returned)} returned` : ""}
          </div>
        </div>
      </div>

      <Panel
        title="Receipts"
        description={`${rows.length} recipients · ${offer?.name ?? countryName(country, countries)}${demo ? " · demo run" : ""}`}
        aside={
          <div className="flex gap-2">
            <Button onClick={exportCsv} disabled={!rows.length}>
              <Download className="size-4" />
              Download CSV
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                reset();
                goStep(1);
              }}
            >
              New batch
            </Button>
          </div>
        }
      >
        <div ref={scrollRef} className="max-h-[62vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="sticky top-0 z-10 bg-surface text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {fields.map((f) => (
                  <th key={f} className="border-b border-border px-3 py-2">
                    {fieldLabel(f)}
                  </th>
                ))}
                <th className="border-b border-border px-3 py-2 text-right">Paid (USDC)</th>
                <th className="border-b border-border px-3 py-2">Status</th>
                <th className="border-b border-border px-3 py-2">Proof</th>
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && (
                <tr aria-hidden>
                  <td colSpan={colCount} style={{ height: padTop }} />
                </tr>
              )}
              {virtualRows
                .map((v) => rows[v.index]!)
                .map((r) => (
                  <tr key={r.id} className={cn("hover:bg-surface-2/60")}>
                    {fields.map((f, i) => (
                      <td
                        key={f}
                        className={cn(
                          "border-b border-border px-3 py-2",
                          i === 0 && `border-l-[3px] ${stripeBorder(r.status)}`,
                          f === "amount" && "num tabular-nums",
                        )}
                      >
                        {r.values[f] || "—"}
                      </td>
                    ))}
                    <td className="num border-b border-border px-3 py-2 text-right tabular-nums">
                      {r.status === "delivered" && r.quote ? usdc(r.quote.price_usdc) : "—"}
                    </td>
                    <td className="border-b border-border px-3 py-2">
                      <StatusChip status={r.status} />
                    </td>
                    <td className="border-b border-border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                        {r.confirmation && <span className="num">{r.confirmation}</span>}
                        {safeHttpUrl(r.settlementUrl) ? (
                          <a
                            href={safeHttpUrl(r.settlementUrl)!}
                            target="_blank"
                            rel="noreferrer"
                            className="num inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {shortAddr(r.settlementTxid, 5)}
                            <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="max-w-[42ch]">{r.message ?? "—"}</span>
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
        {!rows.length && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No payments in this batch yet.
          </p>
        )}
      </Panel>

      <div>
        <Button variant="quiet" onClick={() => goStep(3)}>
          <ArrowLeft className="size-4" />
          Back to payments
        </Button>
      </div>
    </div>
  );
}
