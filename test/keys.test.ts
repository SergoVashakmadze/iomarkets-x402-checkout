import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { loadSecret } from "../src/keys.js";

const NAME = "TEST_SECRET";
const vars = [`${NAME}_FILE`, NAME, "CREDENTIALS_DIRECTORY"];
const dirs: string[] = [];

afterEach(() => {
  for (const v of vars) delete process.env[v];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "keys-test-"));
  dirs.push(d);
  return d;
};

describe("loadSecret", () => {
  it("reads and trims a secret from NAME_FILE", () => {
    const f = join(tmp(), "secret");
    writeFileSync(f, "  word word word \n");
    process.env[`${NAME}_FILE`] = f;
    expect(loadSecret(NAME)).toBe("word word word");
  });

  it("returns empty when nothing is configured", () => {
    expect(loadSecret(NAME)).toBe("");
  });

  // A configured-but-missing file must stay fatal: treating it as "unset" would
  // start the service with refunds silently disabled. But the error has to name
  // the variable and the path — a bare ENOENT out of node:fs does not, and this
  // is the failure a container deploy hits first.
  it("throws a message naming the variable and path when the file is missing", () => {
    const f = join(tmp(), "absent");
    process.env[`${NAME}_FILE`] = f;
    expect(() => loadSecret(NAME)).toThrow(`${NAME}_FILE points at ${f}, which does not exist`);
  });

  it("distinguishes unreadable from missing", () => {
    const f = join(tmp(), "locked");
    writeFileSync(f, "secret");
    chmodSync(f, 0o000);
    process.env[`${NAME}_FILE`] = f;
    // root ignores the mode, so only assert the distinction when it can bite.
    if (process.getuid?.() === 0) return;
    expect(() => loadSecret(NAME)).toThrow(/not readable by this process/);
  });

  it("warns when falling back to the environment variable", () => {
    process.env[NAME] = " from-env ";
    const warnings: string[] = [];
    expect(loadSecret(NAME, { warn: (m) => warnings.push(m) })).toBe("from-env");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(NAME);
  });
});

// A supplier credential is read on FIRST USE, not at import. loadSecret is fatal on a
// configured-but-missing _FILE path, which is right — a refund key that silently
// resolves to empty disables refunds in production with no signal. But src/config.ts is
// imported by everything, and resolving every supplier's secret eagerly meant a dangling
// path for a supplier that is not even selected took down the whole process. Hit on
// 2026-09-01: ZENDIT_API_KEY_FILE was pointed at a file before that file existed, and
// the entire suite stopped loading — with SUPPLIER=reloadly, on a credential nothing
// was going to read.
describe("supplier credentials are resolved lazily", () => {
  const lazy = (o: object, k: string) => typeof Object.getOwnPropertyDescriptor(o, k)?.get === "function";

  it("exposes every supplier secret as a getter, not a resolved value", () => {
    expect(lazy(config.supplier.zendit, "apiKey")).toBe(true);
    expect(lazy(config.supplier.reloadly, "clientSecret")).toBe(true);
    expect(lazy(config.payout, "apiKey")).toBe(true);
  });

  it("keeps non-secret config eager, so a typo still fails at boot", () => {
    // Only credentials are deferred. A malformed ceiling or a bad URL must still stop
    // the process where preflight can see it.
    expect(lazy(config.supplier, "kind")).toBe(false);
    expect(lazy(config.supplier.reloadly, "clientId")).toBe(false);
  });

  it("the refund key stays eager — it is the one that must fail at boot", () => {
    // A refund key resolving to empty disables refunds silently. That fatality is the
    // whole point of loadSecret and must not be deferred with the rest.
    expect(lazy(config.refund, "mnemonic")).toBe(false);
  });
});
