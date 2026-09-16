import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowRight,
  ClipboardPaste,
  Filter,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Field, Panel, Segmented, inputClass, statusStripe } from "./primitives";
import { newRow, useBatch } from "@/lib/io/store";
import { countryName, fieldLabel, type Row } from "@/lib/io/types";
import { guessMapping, looksLikeHeader, parseDelimited } from "@/lib/io/csv";
import { usdc } from "@/lib/io/format";
import { DEMO_ROWS } from "@/lib/io/driver";

const SENDER_COUNTRIES = [
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "NG", name: "Nigeria" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "MT", name: "Malta" },
  { code: "CY", name: "Cyprus" },
  { code: "ZA", name: "South Africa" },
  { code: "DE", name: "Germany" },
  { code: "SG", name: "Singapore" },
];

interface PendingImport {
  rows: string[][];
  headers: string[];
  hasHeader: boolean;
}

export function StepRecipients() {
  const {
    type,
    setType,
    country,
    setCountry,
    countries,
    offers,
    offer,
    offerId,
    setOffer,
    offersLoading,
    offersError,
    fields,
    rows,
    setRows,
    setCell,
    addRow,
    deleteRow,
    errorsFor,
    sender,
    setSender,
    goStep,
    demo,
  } = useBatch();

  const [dragging, setDragging] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /* ---------------------------- import pipeline --------------------------- */

  const ingest = useCallback(
    (text: string) => {
      const grid = parseDelimited(text);
      if (!grid.length) return;
      const first = grid[0] ?? [];
      const hasHeader = looksLikeHeader(first, fields);
      const width = Math.max(...grid.map((r) => r.length));
      const headers = hasHeader
        ? first
        : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
      const body = hasHeader ? grid.slice(1) : grid;
      if (!body.length) return;

      const exactOrder = !hasHeader && width === fields.length;
      if (exactOrder) {
        const imported = body.map((cells) =>
          newRow(Object.fromEntries(fields.map((f, i) => [f, cells[i] ?? ""]))),
        );
        setRows((prev) => [
          ...prev.filter((r) => Object.values(r.values).some(Boolean)),
          ...imported,
        ]);
        setFlash(`${imported.length} recipients added`);
        return;
      }
      setPending({ rows: body, headers, hasHeader });
      setMapping(guessMapping(headers, fields));
    },
    [fields, setRows],
  );

  const applyMapping = useCallback(() => {
    if (!pending) return;
    const imported = pending.rows.map((cells) =>
      newRow(
        Object.fromEntries(
          fields.map((f) => {
            const idx = mapping[f];
            return [f, idx != null && idx !== "" ? (cells[Number(idx)] ?? "") : ""];
          }),
        ),
      ),
    );
    setRows((prev) => [...prev.filter((r) => Object.values(r.values).some(Boolean)), ...imported]);
    setFlash(`${imported.length} recipients added`);
    setPending(null);
  }, [pending, mapping, fields, setRows]);

  /* paste anywhere */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      const multi = /[\n\t;]/.test(text.trim()) || text.split(",").length > 2;
      if (!multi) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !multi) return;
      e.preventDefault();
      ingest(text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [ingest]);

  /* drag a csv onto the window */
  useEffect(() => {
    let depth = 0;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      void file.text().then(ingest);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [ingest]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  /* ------------------------------- validation ------------------------------ */

  const errorMap = useMemo(() => {
    const m = new Map<string, Record<string, string>>();
    for (const r of rows) m.set(r.id, errorsFor(r));
    return m;
  }, [rows, errorsFor]);

  const badRows = useMemo(
    () => rows.filter((r) => Object.keys(errorMap.get(r.id) ?? {}).length > 0),
    [rows, errorMap],
  );

  const total = useMemo(
    () => rows.reduce((sum, r) => sum + (Number(r.values["amount"]) || 0), 0),
    [rows],
  );

  const visibleRows = onlyProblems ? badRows : rows;

  const blocking = !offer
    ? "Choose a corridor to continue."
    : rows.length === 0
      ? "Add at least one recipient — paste rows, drop a .csv, or type into the table."
      : badRows.length > 0
        ? `${badRows.length} of ${rows.length} row${badRows.length === 1 ? "" : "s"} still ${badRows.length === 1 ? "has" : "have"} a problem to fix.`
        : !sender.name.trim()
          ? "Add the legal name you are sending as."
          : null;

  /* -------------------------------- table -------------------------------- */

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 46,
    overscan: 12,
  });

  const focusCell = (rowId: string, field: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(
        `input[data-row="${rowId}"][data-field="${field}"]`,
      );
      el?.focus();
      el?.select();
    });
  };

  const onCellKeyDown = (e: React.KeyboardEvent, row: Row, fIndex: number) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const id = addRow(row.id);
      focusCell(id, fields[0] ?? "");
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      const idx = rows.findIndex((r) => r.id === row.id);
      deleteRow(row.id);
      const next = rows[idx + 1] ?? rows[idx - 1];
      if (next) focusCell(next.id, fields[fIndex] ?? "");
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const idx = visibleRows.findIndex((r) => r.id === row.id);
      const next = visibleRows[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        focusCell(next.id, fields[fIndex] ?? "");
      }
    }
  };

  const gridTemplate = `44px repeat(${fields.length}, minmax(130px, 1fr)) 40px`;

  return (
    <div className="grid gap-5 pb-40 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* ------------------------------ main column ----------------------------- */}
      <div className="flex min-w-0 flex-col gap-5">
        <Panel title="Corridor" description="What you're sending, and where it lands.">
          <div className="flex flex-wrap items-end gap-5 p-4">
            <Field label="Payment type">
              <Segmented
                ariaLabel="Payment type"
                value={type}
                onChange={(v) => setType(v)}
                options={[
                  { value: "payout", label: "Bank & mobile money" },
                  { value: "topup", label: "Airtime & data" },
                ]}
              />
            </Field>
            <Field label="Destination country" htmlFor="country">
              <select
                id="country"
                className={cn(inputClass, "w-[190px]")}
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              >
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Corridor" htmlFor="corridor">
              <select
                id="corridor"
                className={cn(inputClass, "w-[280px]")}
                value={offerId ?? ""}
                onChange={(e) => setOffer(e.target.value)}
                disabled={offersLoading || !offers.length}
              >
                {offersLoading && <option>Loading corridors…</option>}
                {!offersLoading && !offers.length && (
                  <option value="">No corridors available</option>
                )}
                {offers.map((o) => (
                  <option key={o.offerId} value={o.offerId}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {type === "payout" && (
            <p className="mx-4 mb-4 rounded-md bg-surface-2/60 px-3 py-2 text-[12.5px] text-muted-foreground">
              {countries.length <= 5 ? `${countries.length} sample corridors. ` : ""}
              Bank and mobile-money payouts open country by country as a licensed payout partner is
              connected. <b className="text-foreground">Airtime &amp; data</b> reaches 155 countries
              today, and travel eSIMs 200+.
            </p>
          )}

          {offersError && (
            <p className="mx-4 mb-4 rounded-md bg-failed-soft px-3 py-2 text-[13px] text-failed">
              {offersError} {!demo && "You can explore the whole flow with demo data at ?demo=1."}
            </p>
          )}

          {offer && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/60 px-4 py-3 text-[12px]">
              <span className="text-muted-foreground">Required for each recipient:</span>
              {fields.map((f) => (
                <span
                  key={f}
                  className="num rounded border border-border bg-surface px-1.5 py-0.5 text-[11px]"
                >
                  {f}
                </span>
              ))}
              <span className="ml-auto text-muted-foreground">
                Settles in about {offer.settlementSeconds ?? 3} seconds · priced in USDC
              </span>
            </div>
          )}
        </Panel>

        <Panel
          title={`Recipients${rows.length ? ` · ${rows.length}` : ""}`}
          description="Paste rows anywhere on this page, drop a .csv, or type below."
          aside={
            <div className="flex items-center gap-2">
              {rows.length > 20 && (
                <Button
                  size="sm"
                  variant={onlyProblems ? "primary" : "default"}
                  onClick={() => setOnlyProblems((v) => !v)}
                >
                  <Filter className="size-3.5" />
                  {onlyProblems
                    ? "Showing problems"
                    : `Show only problems${badRows.length ? ` (${badRows.length})` : ""}`}
                </Button>
              )}
              <Button size="sm" onClick={() => fileInput.current?.click()}>
                <Upload className="size-3.5" /> Upload .csv
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => focusCell(addRow(), fields[0] ?? "")}
              >
                <Plus className="size-3.5" /> Add row
              </Button>
              {rows.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setRows([])}>
                  Clear
                </Button>
              )}
            </div>
          }
        >
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then(ingest);
              e.target.value = "";
            }}
          />

          {rows.length === 0 ? (
            <EmptyState
              fields={fields}
              onSample={() =>
                setRows(
                  DEMO_ROWS.slice(0, 8).map((v) =>
                    newRow(Object.fromEntries(fields.map((f) => [f, v[f] ?? v["amount"] ?? ""]))),
                  ),
                )
              }
              onAdd={() => focusCell(addRow(), fields[0] ?? "")}
            />
          ) : (
            <div className="min-w-0">
              <div className="overflow-x-auto">
                <div style={{ minWidth: 120 * fields.length + 120 }}>
                  <div
                    className="grid items-center gap-px border-b-2 border-border-strong bg-surface-2 px-3 py-2.5 text-[10.5px] font-bold tracking-[0.1em] text-muted-foreground uppercase"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    <span>#</span>
                    {fields.map((f) => (
                      <span key={f} className="truncate">
                        {fieldLabel(f)}
                        {f === "amount" && " (USDC)"}
                      </span>
                    ))}
                    <span className="sr-only">Actions</span>
                  </div>

                  <div ref={scrollRef} className="max-h-[520px] overflow-y-auto">
                    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                      {virtualizer.getVirtualItems().map((vi) => {
                        const row = visibleRows[vi.index]!;
                        const errs = errorMap.get(row.id) ?? {};
                        const errKeys = Object.keys(errs);
                        return (
                          <div
                            key={row.id}
                            data-index={vi.index}
                            ref={virtualizer.measureElement}
                            className={cn(
                              "absolute inset-x-0 top-0 border-b border-border/70",
                              "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
                              errKeys.length ? "before:bg-failed" : statusStripe(row.status),
                            )}
                            style={{ transform: `translateY(${vi.start}px)` }}
                          >
                            <div
                              className="grid items-center gap-px px-3 py-1.5"
                              style={{ gridTemplateColumns: gridTemplate }}
                            >
                              <span className="num pl-1 text-[11px] text-muted-foreground">
                                {rows.indexOf(row) + 1}
                              </span>
                              {fields.map((f, fi) => (
                                <input
                                  key={f}
                                  data-row={row.id}
                                  data-field={f}
                                  aria-label={`${fieldLabel(f)} for row ${rows.indexOf(row) + 1}`}
                                  aria-invalid={Boolean(errs[f])}
                                  inputMode={f === "amount" ? "decimal" : undefined}
                                  className={cn(
                                    "h-8 w-full rounded border bg-transparent px-2 text-[13px] outline-none",
                                    f === "amount" || f === "account_number" || f === "phone"
                                      ? "num"
                                      : "",
                                    errs[f]
                                      ? "border-failed/60 bg-failed-soft/50"
                                      : "border-transparent hover:border-border focus:border-ring focus:bg-surface",
                                  )}
                                  value={row.values[f] ?? ""}
                                  placeholder={f === "amount" ? "0.00" : ""}
                                  onChange={(e) => setCell(row.id, f, e.target.value)}
                                  onKeyDown={(e) => onCellKeyDown(e, row, fi)}
                                />
                              ))}
                              <button
                                onClick={() => deleteRow(row.id)}
                                aria-label={`Delete row ${rows.indexOf(row) + 1}`}
                                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-failed-soft hover:text-failed"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                            {errKeys.length > 0 && (
                              <p className="px-3 pb-1.5 pl-12 text-[12px] text-failed">
                                {errKeys.map((k) => errs[k]).join(" · ")}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
              <p className="border-t border-border px-4 py-2 text-[12px] text-muted-foreground">
                <kbd className="num rounded border border-border px-1">Enter</kbd> adds a row ·{" "}
                <kbd className="num rounded border border-border px-1">⌘/Ctrl</kbd>+
                <kbd className="num rounded border border-border px-1">⌫</kbd> deletes one · arrows
                move between rows
              </p>
            </div>
          )}
        </Panel>
      </div>

      {/* ------------------------------- side rail ------------------------------ */}
      <aside className="flex flex-col gap-5">
        <Panel title="Sending as" description="Remembered on this device.">
          <div className="flex flex-col gap-3 p-4">
            <Field label="Legal name" htmlFor="sender-name">
              <input
                id="sender-name"
                className={inputClass}
                placeholder="Acme Operations Ltd"
                value={sender.name}
                onChange={(e) => setSender({ ...sender, name: e.target.value })}
              />
            </Field>
            <Field label="Country" htmlFor="sender-country">
              <select
                id="sender-country"
                className={inputClass}
                value={sender.country}
                onChange={(e) => setSender({ ...sender, country: e.target.value })}
              >
                {SENDER_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Panel>

        <Panel title="How this works">
          <ol className="flex flex-col gap-3 p-4 text-[13px] text-muted-foreground">
            {[
              "Your balance is funded once, then spent down payment by payment.",
              "Every payment settles before anything is bought downstream — about three seconds.",
              "If the provider fails to deliver, the money refunds itself automatically.",
              "Each payment returns a signed receipt you can export.",
            ].map((t, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="num mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-bold text-foreground">
                  {i + 1}
                </span>
                {t}
              </li>
            ))}
          </ol>
        </Panel>
      </aside>

      {/* ------------------------------ sticky bar ------------------------------ */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 shadow-[var(--shadow-bar)] backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-7 gap-y-2 px-5 py-3.5">
          <Stat label="Recipients" value={String(rows.length)} />
          <span className="h-9 w-px bg-border" aria-hidden />
          <Stat
            label="Total to send"
            value={
              <>
                {usdc(total)}
                <span>USDC</span>
              </>
            }
            accent
          />
          <span className="h-9 w-px bg-border" aria-hidden />
          <Stat
            label="Destination"
            value={`${countryName(country, countries)} · ${offer?.name ?? "—"}`}
            small
          />
          <div className="ml-auto flex items-center gap-3">
            {blocking ? (
              <span className="flex max-w-[420px] items-center gap-2 text-[13px] text-muted-foreground">
                <AlertTriangle className="size-4 shrink-0 text-pending" />
                {blocking}
              </span>
            ) : (
              <span className="text-[13px] text-settled">Batch is clean and ready to price.</span>
            )}
            <Button
              variant="primary"
              size="lg"
              disabled={Boolean(blocking)}
              onClick={() => goStep(2)}
            >
              Review prices <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {flash && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background shadow-lg">
          {flash}
        </div>
      )}

      {dragging && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/85 p-10 backdrop-blur-sm">
          <div className="grid w-full max-w-2xl place-items-center gap-3 rounded-xl border-2 border-dashed border-primary bg-surface/70 py-24">
            <Upload className="size-9 text-primary" />
            <p className="font-display text-xl font-semibold">Drop your recipient file</p>
            <p className="text-sm text-muted-foreground">
              .csv or .tsv — we'll map the columns for you if the names don't match.
            </p>
          </div>
        </div>
      )}

      {pending && (
        <MappingDialog
          headers={pending.headers}
          sample={pending.rows.slice(0, 3)}
          fields={fields}
          mapping={mapping}
          setMapping={setMapping}
          count={pending.rows.length}
          onCancel={() => setPending(null)}
          onConfirm={applyMapping}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: ReactNode;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </div>
      <div
        className={cn(
          "num truncate",
          accent
            ? "figure-lg text-[26px] leading-tight text-foreground [&>span]:ml-1 [&>span]:text-[13px] [&>span]:font-medium [&>span]:text-muted-foreground"
            : "text-[17px] font-medium",
          small && "font-sans text-[13px] font-normal text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyState({
  fields,
  onSample,
  onAdd,
}: {
  fields: string[];
  onSample: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="grid gap-6 p-8 md:grid-cols-[1fr_minmax(0,340px)]">
      <div>
        <h3 className="font-display text-lg font-semibold">
          Bring your list in, however you have it
        </h3>
        <p className="mt-1 max-w-prose text-[13.5px] text-muted-foreground">
          Copy the rows straight out of your spreadsheet and press paste — anywhere on this page. Or
          drag the export onto the window. If the column names don't match ours, we'll show you a
          one-screen mapping instead of an error.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={onAdd}>
            <Plus className="size-4" /> Type the first row
          </Button>
          <Button onClick={onSample}>Load a sample batch</Button>
          <span className="inline-flex items-center gap-1.5 self-center text-[12px] text-muted-foreground">
            <ClipboardPaste className="size-3.5" /> ⌘V works from anywhere
          </span>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-dashed border-border-strong bg-surface-2/60">
        <div className="border-b border-border px-3 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Expected columns
        </div>
        <pre className="num overflow-x-auto px-3 py-3 text-[12px] leading-relaxed text-muted-foreground">
          {fields.join(",")}
          {"\n"}
          {fields
            .map((f) =>
              f === "amount"
                ? "120"
                : f === "full_name"
                  ? "Adaeze Okonkwo"
                  : f === "account_number"
                    ? "0123456789"
                    : f === "bank_code"
                      ? "058"
                      : f === "phone"
                        ? "+2348012345678"
                        : "…",
            )
            .join(",")}
        </pre>
      </div>
    </div>
  );
}

function MappingDialog({
  headers,
  sample,
  fields,
  mapping,
  setMapping,
  count,
  onCancel,
  onConfirm,
}: {
  headers: string[];
  sample: string[][];
  fields: string[];
  mapping: Record<string, string>;
  setMapping: (m: Record<string, string>) => void;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const unmapped = fields.filter((f) => !mapping[f]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Match your columns"
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4 backdrop-blur-sm"
    >
      <div className="panel w-full max-w-2xl overflow-hidden shadow-2xl">
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-semibold">Match your columns</h2>
            <p className="text-[13px] text-muted-foreground">
              {count} rows found. We've pre-selected our best guess — change anything that looks
              wrong.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Cancel import"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </header>
        <div className="max-h-[50vh] overflow-y-auto p-5">
          <div className="flex flex-col gap-2.5">
            {fields.map((f) => {
              const idx = mapping[f] ?? "";
              const preview = idx !== "" ? sample.map((r) => r[Number(idx)]).filter(Boolean) : [];
              return (
                <div key={f} className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  <select
                    aria-label={`Column for ${fieldLabel(f)}`}
                    className={cn(inputClass, idx === "" && "border-failed/60")}
                    value={idx}
                    onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}
                  >
                    <option value="">— not in my file —</option>
                    {headers.map((h, i) => (
                      <option key={i} value={String(i)}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <ArrowRight className="hidden size-4 text-muted-foreground sm:block" />
                  <div>
                    <div className="text-[13px] font-semibold">{fieldLabel(f)}</div>
                    <div className="num truncate text-[11px] text-muted-foreground">
                      {preview.length ? preview.join(" · ") : "no preview"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface-2/60 px-5 py-3">
          <p className="text-[12.5px] text-muted-foreground">
            {unmapped.length
              ? `${unmapped.map(fieldLabel).join(", ")} not matched — those cells import blank and you can fill them in.`
              : "Every required field is matched."}
          </p>
          <div className="flex gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={onConfirm}>
              Import {count} rows
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
