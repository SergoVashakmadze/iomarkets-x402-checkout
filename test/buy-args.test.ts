// The payout path of scripts/buy.ts, where a parsing slip is not a usage error but a
// settled, irreversible payment to the wrong place.
import { describe, expect, it } from "vitest";
import { missingFields, parseArgs, parseFields, parseSender } from "../src/client/buy-args.js";

describe("parseArgs", () => {
  it("accumulates a repeated flag instead of overwriting it", () => {
    const a = parseArgs(["--field", "a=1", "--field", "b=2", "--field", "c=3"]);
    expect(a.get("field")).toEqual(["a=1", "b=2", "c=3"]);
  });

  it("treats --yes as a boolean without swallowing the next argument", () => {
    const a = parseArgs(["--yes", "--amount", "5000"]);
    expect(a.get("yes")).toEqual(["true"]);
    expect(a.get("amount")).toEqual(["5000"]);
  });

  it("keeps a value that looks like a flag out of the key space", () => {
    expect(parseArgs(["--offer", "bn-NG-NGN-bank"]).get("offer")).toEqual(["bn-NG-NGN-bank"]);
  });
});

describe("parseSender", () => {
  it("splits on the LAST comma, so a name may contain one", () => {
    expect(parseSender("Lovelace, Ada,GB")).toEqual({ name: "Lovelace, Ada", country: "GB" });
  });

  it("upper-cases the country and carries an optional KYC reference", () => {
    expect(parseSender("Ada Lovelace,gb", "kyc_123")).toEqual({ name: "Ada Lovelace", country: "GB", reference: "kyc_123" });
  });

  it.each([undefined, "", "Ada Lovelace", "Ada Lovelace,GBR", "A,GB"])("rejects %p", (raw) => {
    expect(() => parseSender(raw)).toThrow();
  });
});

describe("parseFields", () => {
  it("splits on the first = only, and keeps the value verbatim", () => {
    // A leading zero on an account number is significant, and an account name may
    // contain an '='. Both are the kind of silent mangling that pays a stranger.
    expect(parseFields(["account_number=0123456789", "account_name=A=B Ltd"])).toEqual({
      account_number: "0123456789",
      account_name: "A=B Ltd",
    });
  });

  it("refuses a field given twice with different values rather than picking one", () => {
    expect(() => parseFields(["account_number=1", "account_number=2"])).toThrow(/twice/);
  });

  it("tolerates a field repeated identically", () => {
    expect(parseFields(["bank_code=058", "bank_code=058"])).toEqual({ bank_code: "058" });
  });

  it.each(["novalue", "=orphan"])("rejects %p", (raw) => {
    expect(() => parseFields([raw])).toThrow(/key=value/);
  });
});

describe("missingFields", () => {
  it("names every field the corridor requires and did not get", () => {
    expect(missingFields(["account_name", "account_number", "bank_code"], { account_name: "Chidi" }))
      .toEqual(["account_number", "bank_code"]);
  });

  it("treats an empty string as missing — a blank account number is not an account number", () => {
    expect(missingFields(["bank_code"], { bank_code: "" })).toEqual(["bank_code"]);
  });

  it("is satisfied when the corridor publishes no fields", () => {
    expect(missingFields(undefined, {})).toEqual([]);
  });
});
