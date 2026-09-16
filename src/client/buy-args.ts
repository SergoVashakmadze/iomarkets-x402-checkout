// Argument parsing for the payout path of scripts/buy.ts, kept separate so it can be
// tested without importing a script that pays real USDC on import.
//
// These are small functions guarding an irreversible action. A payout that reaches the
// partner missing a beneficiary field, or carrying only the last of three --field
// arguments, is not a usage error caught by a usage message — it is a settled payment
// that has to be refunded, or worse, one that lands somewhere.

/** Repeatable flags: a corridor needs one --field per beneficiary field, so values
 *  accumulate rather than overwrite. A pairwise parser silently keeps only the last. */
export function parseArgs(argv: string[], booleanFlags: ReadonlySet<string> = new Set(["yes"])): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = booleanFlags.has(key) ? "true" : (argv[++i] ?? "");
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

export type Sender = { name: string; country: string; reference?: string };

/** `--sender "Ada Lovelace,GB"` — the human principal the agent acts for. Never invented
 *  by the agent: src/compliance.ts requires a real name and country on every payout.
 *  Split on the LAST comma, because a name may contain one ("Lovelace, Ada") and the
 *  country code never does. */
export function parseSender(raw: string | undefined, reference?: string): Sender {
  if (!raw) throw new Error('--sender "Full Name,CC" is required for a payout — the named human the payment is made on behalf of');
  const i = raw.lastIndexOf(",");
  const name = (i === -1 ? "" : raw.slice(0, i)).trim();
  const country = (i === -1 ? "" : raw.slice(i + 1)).trim().toUpperCase();
  if (name.length < 2 || !/^[A-Z]{2}$/.test(country)) throw new Error(`--sender must be "Full Name,CC" (ISO-3166 alpha-2), got "${raw}"`);
  return { name, country, ...(reference ? { reference } : {}) };
}

/** `--field account_number=0123456789`, once per field. Split on the FIRST `=`: an
 *  account name may legitimately contain one, a key never does. Values are kept
 *  verbatim — a leading zero on an account number is significant. */
export function parseFields(raws: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of raws) {
    const i = raw.indexOf("=");
    if (i < 1) throw new Error(`--field must be key=value, got "${raw}"`);
    const key = raw.slice(0, i).trim();
    if (out[key] !== undefined && out[key] !== raw.slice(i + 1)) throw new Error(`--field ${key} was given twice with different values — refusing to guess which beneficiary you meant`);
    out[key] = raw.slice(i + 1);
  }
  return out;
}

/** The corridor's own required-field list is authoritative and differs per country.
 *  Catching a gap here costs nothing; catching it at initialize costs a settled payment. */
export function missingFields(required: readonly string[] | undefined, fields: Record<string, string>): string[] {
  return (required ?? []).filter((k) => !fields[k]);
}
