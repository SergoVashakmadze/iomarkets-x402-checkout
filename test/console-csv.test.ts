// The console's CSV parser, tested against the page it actually ships in.
//
// This is the most dangerous code on the console: it decides WHO gets paid and HOW
// MUCH. The first version split on a bare comma, so a payee whose name contains one —
// "Okonkwo, Adebayo" out of any ordinary spreadsheet export — shifted every field one
// place left and the surplus field was silently reinterpreted as a per-row amount. The
// row validated clean and the money went to a different account for a different sum.
//
// src/console.html has no build step and no module boundary, so the function is lifted
// out of the shipped file by name. If someone renames or removes it, this test fails
// loudly rather than silently testing a copy that no longer runs in the browser.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/console.html", import.meta.url), "utf8");
const start = page.indexOf("function parseCsvLine");
const end = page.indexOf("function readSender");
expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);
const parseCsvLine = new Function(`${page.slice(start, end)}; return parseCsvLine;`)() as
  (line: string) => { parts: string[]; unterminated: boolean };

const parts = (l: string) => parseCsvLine(l).parts;

describe("parseCsvLine", () => {
  it("splits a plain row", () => {
    expect(parts("Bob,1234567890,044")).toEqual(["Bob", "1234567890", "044"]);
  });

  it("keeps a quoted comma inside its field — the bug that misdirected money", () => {
    expect(parts('"Okonkwo, Adebayo",1234567890,044')).toEqual(["Okonkwo, Adebayo", "1234567890", "044"]);
  });

  it("unescapes a doubled quote", () => {
    expect(parts('"Ann ""Anna"" Lee",123,044')).toEqual(['Ann "Anna" Lee', "123", "044"]);
  });

  it("reports an unterminated quote instead of guessing", () => {
    expect(parseCsvLine('"Bob,123,044').unterminated).toBe(true);
    expect(parseCsvLine('"Bob",123,044').unterminated).toBe(false);
  });

  // Deliberately stricter than RFC 4180, which preserves padding inside quotes: a
  // bank account number with a stray leading space is a failed payment, and a name
  // with one is noise. Every field is trimmed, quoted or not.
  it("trims padding on every field, quoted or not", () => {
    expect(parts(" Bob , 123 ")).toEqual(["Bob", "123"]);
    expect(parts('" Bob ",123')).toEqual(["Bob", "123"]);
    expect(parts('"Okonkwo, Adebayo" , 123')).toEqual(["Okonkwo, Adebayo", "123"]);
  });

  it("treats a quote that is not at the start of a field as literal", () => {
    // 5" is a measurement, not the start of a quoted field.
    expect(parts('Pipe 5" long,123')).toEqual(['Pipe 5" long', "123"]);
  });

  it("keeps empty fields, so a missing column is caught rather than shifted away", () => {
    expect(parts("Bob,,044")).toEqual(["Bob", "", "044"]);
  });

  // The hostile case: a name chosen to look like two columns. With proper parsing an
  // unquoted comma now yields the WRONG COLUMN COUNT, which the caller refuses.
  it("gives a mis-shaped row a detectably wrong column count", () => {
    expect(parts("Bob,999,1234567890,044")).toHaveLength(4);
  });
});
