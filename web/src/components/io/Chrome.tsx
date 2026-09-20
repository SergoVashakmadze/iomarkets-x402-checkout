import { useEffect, useState } from "react";
import { ArrowLeft, Moon, Sun, Wallet, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./primitives";
import { useBatch } from "@/lib/io/store";
import { shortAddr } from "@/lib/io/format";

const STEPS = [
  { n: 1, label: "Recipients", hint: "Who gets paid" },
  { n: 2, label: "Review", hint: "Lock prices" },
  { n: 3, label: "Pay", hint: "Approve once" },
  { n: 4, label: "Receipts", hint: "Proof of payment" },
] as const;

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("iomarkets.theme");
    const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = stored ? stored === "dark" : prefers;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
  return (
    <button
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("iomarkets.theme", next ? "dark" : "light");
      }}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="grid size-8 place-items-center rounded-md border border-ink-border text-ink-muted transition-colors hover:bg-white/10 hover:text-ink-foreground"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function TopBar() {
  const { demo, simulated, payer, connect, connecting, disconnect, type } = useBatch();
  // Only warn about the product the operator is actually looking at.
  const isSimulated = !demo && simulated.includes(type);
  return (
    <header className="ink-bar sticky top-0 z-30 border-b border-ink-border">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-4 px-5">
        {/* The mark and the way back. The console is one product of the site; the
            landing page (/) is where a visitor learns what the site is, so the brand
            is a link there rather than a label. Same asset the landing page serves. */}
        <a
          href="/"
          title="IoMarkets — back to the site"
          className="flex items-center gap-3 rounded-md text-ink-foreground no-underline hover:opacity-90"
        >
          <img
            src="/brand/logo.webp"
            alt="IoMarkets logo"
            width={36}
            height={40}
            className="size-9 rounded-[7px] object-cover ring-1 ring-ink-border"
          />
          <div className="leading-tight">
            <div className="font-display text-[17px] font-semibold tracking-[-0.02em] text-ink-foreground">
              IoMarkets
            </div>
            <div className="text-[10.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
              Batch payouts
            </div>
          </div>
        </a>
        {/* The way out of the console, and it must survive a phone. This was
            `hidden … sm:inline-flex`, so below 640px the only route back to the site
            was the logo — which does not look like a link — and a visitor who opened
            the demo from the landing page had no visible way back. The label is what
            collapses on a narrow screen now, not the control: an icon-only chip with
            an accessible name, widening to the full sentence from `sm` up. */}
        <a
          href="/"
          aria-label="Back to iomarkets.app"
          title="Back to iomarkets.app"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/40 px-2 py-1.5 text-[12px] font-medium text-accent transition-colors hover:border-accent hover:bg-accent/10 sm:px-2.5"
        >
          <ArrowLeft className="size-3.5" />
          <span className="hidden sm:inline">Back to iomarkets.app</span>
        </a>

        {/* The one number worth carrying in the chrome: what this account may spend. */}
        <div className="ml-6 hidden items-center gap-5 border-l border-ink-border pl-6 lg:flex">
          <div className="leading-tight">
            <div className="text-[10px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
              Settles in
            </div>
            <div className="num text-[13px] font-semibold text-ink-foreground">~3s on-chain</div>
          </div>
          <div className="leading-tight">
            <div className="text-[10px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
              Priced in
            </div>
            <div className="num text-[13px] font-semibold text-ink-foreground">USDC</div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          {isSimulated && (
            <span
              title="This product has no licensed partner wired. Corridors are placeholders and nothing is delivered."
              className="inline-flex items-center gap-2 rounded-full border border-failed/50 bg-failed/15 px-3 py-1.5 text-[12px] font-semibold text-failed"
            >
              <span className="size-1.5 rounded-full bg-failed" aria-hidden />
              Simulated supplier — {type} corridors are not real
            </span>
          )}
          {demo ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-pending/50 bg-pending/15 px-3 py-1.5 text-[12px] font-semibold text-pending">
              <span className="size-1.5 rounded-full bg-pending" aria-hidden />
              Demo mode — no real money moves
            </span>
          ) : payer ? (
            <button
              onClick={() => void disconnect()}
              title="Disconnect"
              className="num inline-flex items-center gap-2 rounded-md border border-ink-border px-3 py-2 text-[12px] text-ink-foreground transition-colors hover:bg-white/10"
            >
              <Check className="size-3.5 text-settled" />
              {shortAddr(payer, 6)}
            </button>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={() => void connect()}
              disabled={connecting}
            >
              <Wallet className="size-4" />
              {connecting ? "Connecting…" : "Connect account"}
            </Button>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function ProgressRail() {
  const { step, goStep, rows } = useBatch();
  const reachable = (n: number) => n < step || (n === 2 && rows.length > 0 && step < 3);
  return (
    <nav
      aria-label="Progress"
      className="border-b border-border bg-surface shadow-[var(--shadow-panel)]"
    >
      <ol className="mx-auto flex max-w-[1500px] items-stretch px-5">
        {STEPS.map((s, i) => {
          const state = s.n === step ? "current" : s.n < step ? "done" : "todo";
          return (
            /* `min-w-0` is load-bearing: a flex child defaults to `min-width:auto`, so
               these four items refused to shrink below the width of their own label and
               pushed the rail — and the whole document — 57px wider than a 390px phone.
               The `truncate` further down could never fire, because nothing ever asked
               the item to be narrower. */
            <li key={s.n} className="flex min-w-0 flex-1 items-center">
              <button
                onClick={() => reachable(s.n) && goStep(s.n as 1 | 2 | 3 | 4)}
                disabled={!reachable(s.n)}
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "group relative flex w-full items-center gap-3 py-4 pr-4 text-left transition-colors",
                  reachable(s.n) ? "cursor-pointer" : "cursor-default",
                )}
              >
                {/* The rail itself: a 3px underline that fills on the active step. */}
                <span
                  className={cn(
                    "absolute inset-x-0 bottom-0 h-[3px] transition-colors",
                    state === "current" && "bg-primary",
                    state === "done" && "bg-settled/40",
                    state === "todo" && "bg-transparent",
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    "num grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold transition-all",
                    state === "current" &&
                      "bg-primary text-primary-foreground ring-4 ring-primary/15",
                    state === "done" && "bg-settled text-white",
                    state === "todo" &&
                      "border border-border-strong bg-surface-2 text-muted-foreground",
                  )}
                >
                  {state === "done" ? <Check className="size-4" strokeWidth={3} /> : s.n}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block truncate text-[13.5px] font-semibold tracking-[-0.01em]",
                      state === "current" && "text-foreground",
                      state === "done" && "text-foreground",
                      state === "todo" && "text-muted-foreground",
                    )}
                  >
                    {s.label}
                  </span>
                  <span className="hidden truncate text-[11.5px] text-muted-foreground sm:block">
                    {s.hint}
                  </span>
                </span>
              </button>
              {i < STEPS.length - 1 && <span className="h-8 w-px shrink-0 bg-border" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
