import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RowStatus } from "@/lib/io/types";

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger" | "quiet";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[background,color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-45 active:translate-y-px",
        size === "sm" && "h-8 px-2.5 text-[13px]",
        size === "md" && "h-9 px-3.5 text-sm",
        size === "lg" && "h-11 px-5 text-[15px]",
        variant === "default" &&
          "border border-border-strong bg-surface text-foreground hover:bg-surface-2",
        variant === "primary" &&
          "bg-primary text-primary-foreground shadow-[0_1px_0_0_rgba(0,0,0,0.06)] hover:brightness-110",
        variant === "ghost" && "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
        variant === "quiet" && "bg-surface-2 text-foreground hover:bg-muted",
        variant === "danger" && "bg-destructive text-destructive-foreground hover:brightness-110",
        className,
      )}
      {...props}
    />
  );
}

export function Panel({
  children,
  className,
  title,
  aside,
  description,
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  aside?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <section className={cn("panel", className)}>
      {(title || aside) && (
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-display text-[15px] font-semibold">{title}</h2>
            {description && (
              <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
            )}
          </div>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const inputClass =
  "h-9 w-full rounded-md border border-input bg-surface px-2.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring";

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border bg-surface-2 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 rounded-[5px] px-3 text-[13px] font-medium transition-colors",
            value === o.value
              ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATUS_META: Record<RowStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "muted" },
  quoting: { label: "Pricing", tone: "pending" },
  quoted: { label: "Priced", tone: "info" },
  quote_error: { label: "Needs fixing", tone: "failed" },
  queued: { label: "Queued", tone: "muted" },
  paying: { label: "Paying", tone: "pending" },
  settling: { label: "Settling", tone: "pending" },
  delivered: { label: "Delivered", tone: "settled" },
  refunded: { label: "Refunded", tone: "refunded" },
  failed: { label: "Failed", tone: "failed" },
};

export function StatusChip({ status, className }: { status: RowStatus; className?: string }) {
  const meta = STATUS_META[status];
  const busy = status === "paying" || status === "settling" || status === "quoting";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap",
        meta.tone === "muted" && "bg-surface-2 text-muted-foreground",
        meta.tone === "info" && "bg-primary/12 text-primary",
        meta.tone === "pending" && "bg-pending-soft text-pending",
        meta.tone === "settled" && "bg-settled-soft text-settled",
        meta.tone === "failed" && "bg-failed-soft text-failed",
        meta.tone === "refunded" && "bg-refunded-soft text-refunded",
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full bg-current", busy && "motion-safe:animate-pulse")}
        aria-hidden
      />
      {meta.label}
    </span>
  );
}

export function statusStripe(status: RowStatus) {
  switch (status) {
    case "delivered":
      return "before:bg-settled";
    case "failed":
    case "quote_error":
      return "before:bg-failed";
    case "refunded":
      return "before:bg-refunded";
    case "paying":
    case "settling":
    case "quoting":
      return "before:bg-pending";
    case "quoted":
      return "before:bg-primary/60";
    default:
      return "before:bg-transparent";
  }
}

export function stripeBorder(status: RowStatus) {
  switch (status) {
    case "delivered":
      return "border-l-settled";
    case "failed":
    case "quote_error":
      return "border-l-failed";
    case "refunded":
      return "border-l-refunded";
    case "paying":
    case "settling":
    case "quoting":
      return "border-l-pending";
    case "quoted":
      return "border-l-primary/60";
    default:
      return "border-l-transparent";
  }
}
