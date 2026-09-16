export function usdc(n: number, opts: { sign?: boolean } = {}) {
  const v = Number.isFinite(n) ? n : 0;
  const s = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return opts.sign ? `${v >= 0 ? "" : "-"}${s}` : s;
}

export function shortAddr(a: string | null | undefined, size = 5) {
  if (!a) return "—";
  return `${a.slice(0, size)}…${a.slice(-size)}`;
}

export function timeLeft(iso: string | undefined) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return ms;
}

export function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Only ever hand http(s) to an href.
 *
 * `settlement_url` arrives from the API and is rendered directly as a block-explorer
 * link. React 19 blocks `javascript:` hrefs, but that is one framework version's
 * behaviour standing between server-controlled text and script execution in a page
 * that signs payments — too thin a margin to rely on, and it says nothing about
 * `data:` or `blob:`. Returns null for anything else so the caller renders plain
 * text instead of a link.
 */
export function safeHttpUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, window.location.origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
