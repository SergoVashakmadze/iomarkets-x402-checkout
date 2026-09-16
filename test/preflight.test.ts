// Preflight checks. Every case here is a way a deploy takes zero money while
// looking healthy, so the assertions are about level (ok/warn/fail), not wording.
import { describe, expect, it } from "vitest";
import {
  MIN_ALGO_MICRO, checkAssetOptIn, checkFacilitatorSupport, checkPayToFormat,
  checkPayConsole, checkPayoutSupplier, checkPricingCoversFloat, checkPublicBaseUrl, checkReceiptKeys, checkRefunder, worst,
} from "../src/preflight.js";
import { generateKeypair } from "../src/receipt.js";

const ADDR = "7ZUECA7HFLZTXENRV24SHLU4AVPUTMTTDUFUBNBD64C73F3UHRTHAIOF6Q";
const USDC = 31566704;

describe("PAY_TO", () => {
  it("accepts a valid Algorand address", () => {
    expect(checkPayToFormat(ADDR).level).toBe("ok");
  });

  it("fails when unset or malformed", () => {
    expect(checkPayToFormat("").level).toBe("fail");
    expect(checkPayToFormat("not-an-address").level).toBe("fail");
    // Right length, wrong checksum — the case a typo actually produces.
    expect(checkPayToFormat(ADDR.slice(0, -1) + "A").level).toBe("fail");
  });
});

describe("PUBLIC_BASE_URL", () => {
  it("accepts a bare https origin", () => {
    expect(checkPublicBaseUrl("https://iomarkets.app", { production: true }).level).toBe("ok");
  });

  it("tolerates localhost only outside production", () => {
    expect(checkPublicBaseUrl("http://127.0.0.1:3000", { production: false }).level).toBe("warn");
    expect(checkPublicBaseUrl("http://127.0.0.1:3000", { production: true }).level).toBe("fail");
  });

  // The Bazaar would list an unreachable resource and quotes would strand agents.
  it("fails on plain http for a real host", () => {
    expect(checkPublicBaseUrl("http://iomarkets.app", { production: false }).level).toBe("fail");
  });

  it("fails on a trailing slash or a path, which corrupt every advertised endpoint", () => {
    expect(checkPublicBaseUrl("https://iomarkets.app/", { production: true }).level).toBe("fail");
    expect(checkPublicBaseUrl("https://iomarkets.app/api", { production: true }).level).toBe("fail");
  });

  it("only blocks an unset origin when deploying", () => {
    expect(checkPublicBaseUrl("", { production: false }).level).toBe("warn");
    expect(checkPublicBaseUrl("", { production: true }).level).toBe("fail");
  });
});

describe("receipt keypair", () => {
  it("accepts a matching pair and derives the public key", () => {
    const { privateKey, publicKey } = generateKeypair();
    const r = checkReceiptKeys(privateKey, publicKey);
    expect(r.level).toBe("ok");
    expect(r.detail).toBe(publicKey);
  });

  // A published key that cannot verify our signatures makes every receipt worthless.
  it("fails when the published public key belongs to a different private key", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(checkReceiptKeys(a.privateKey, b.publicKey).level).toBe("fail");
  });

  it("warns when only the private key is set, and fails when neither is", () => {
    const { privateKey } = generateKeypair();
    expect(checkReceiptKeys(privateKey, "").level).toBe("warn");
    expect(checkReceiptKeys("", "").level).toBe("fail");
  });

  it("fails on a private key that is not a valid ed25519 scalar", () => {
    expect(checkReceiptKeys("zzzz", "").level).toBe("fail");
  });
});

describe("asset opt-in", () => {
  const holding = (usdc: number, algo = 1_000_000) => ({ amount: algo, assets: [{ assetId: USDC, amount: usdc }] });

  it("passes for an opted-in account", () => {
    expect(checkAssetOptIn("PAY_TO", ADDR, holding(0), USDC).level).toBe("ok");
  });

  // The classic Algorand launch failure: transfers to a non-opted-in account fail.
  it("fails when the account is not opted in to the asset", () => {
    expect(checkAssetOptIn("PAY_TO", ADDR, { amount: 1_000_000, assets: [] }, USDC).level).toBe("fail");
    expect(checkAssetOptIn("PAY_TO", ADDR, { amount: 1_000_000, assets: [{ assetId: 999, amount: 5 }] }, USDC).level).toBe("fail");
  });

  it("fails when the account does not exist on chain", () => {
    expect(checkAssetOptIn("PAY_TO", ADDR, null, USDC).level).toBe("fail");
  });

  it("warns when a wallet that pays fees is short of ALGO", () => {
    expect(checkAssetOptIn("refund wallet", ADDR, holding(0, MIN_ALGO_MICRO - 1), USDC, { needsAlgo: true }).level).toBe("warn");
    expect(checkAssetOptIn("refund wallet", ADDR, holding(0, MIN_ALGO_MICRO), USDC, { needsAlgo: true }).level).toBe("ok");
  });

  it("warns when the refund float is below one day's cap", () => {
    expect(checkAssetOptIn("refund wallet", ADDR, holding(50_000_000), USDC, { minUsdcMicro: 100_000_000 }).level).toBe("warn");
    expect(checkAssetOptIn("refund wallet", ADDR, holding(100_000_000), USDC, { minUsdcMicro: 100_000_000 }).level).toBe("ok");
  });

  it("reports both balances", () => {
    expect(checkAssetOptIn("PAY_TO", ADDR, holding(12_340_000, 300_000), USDC).detail).toBe("12.34 USDC, 0.300 ALGO");
  });
});

describe("facilitator support", () => {
  const net = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

  it("passes when the exact scheme is listed for our network and asset", () => {
    expect(checkFacilitatorSupport({ kinds: [{ scheme: "exact", network: net, asset: String(USDC) }] }, { network: net, asset: USDC }).level).toBe("ok");
  });

  // The facilitator keys on the FULL genesis hash, not the SDK's short id.
  it("fails when only the short CAIP-2 id is listed", () => {
    expect(checkFacilitatorSupport({ kinds: [{ scheme: "exact", network: "algorand:wGHE2PwdvdN73k", asset: String(USDC) }] }, { network: net, asset: USDC }).level).toBe("fail");
  });

  it("fails on the wrong asset and warns when /supported is unreadable", () => {
    expect(checkFacilitatorSupport({ kinds: [{ scheme: "exact", network: net, asset: "10458941" }] }, { network: net, asset: USDC }).level).toBe("fail");
    expect(checkFacilitatorSupport(null, { network: net, asset: USDC }).level).toBe("warn");
    expect(checkFacilitatorSupport({ kinds: [] }, { network: net, asset: USDC }).level).toBe("warn");
  });
});

describe("refund wallet and severity roll-up", () => {
  it("only blocks a missing refund key when deploying", () => {
    expect(checkRefunder(null, false).level).toBe("warn");
    expect(checkRefunder(null, true).level).toBe("fail");
    expect(checkRefunder(ADDR, true).level).toBe("ok");
  });

  it("takes the worst level across all checks", () => {
    const r = (level: "ok" | "warn" | "fail") => ({ name: "n", level, detail: "d" });
    expect(worst([r("ok"), r("ok")])).toBe("ok");
    expect(worst([r("ok"), r("warn")])).toBe("warn");
    expect(worst([r("warn"), r("fail"), r("ok")])).toBe("fail");
    expect(worst([])).toBe("ok");
  });
});

// A markup that does not cover what float costs is the one failure mode that leaves
// every log green: the order succeeds, the receipt verifies, and the float drains
// faster than the revenue arrives. Measured on a real deposit 2026-08-29 — $50 by
// debit card became $47.75 of Reloadly credit, i.e. 471 bps against a 400 bps markup.
describe("checkPricingCoversFloat", () => {
  const base = { markupBps: 400, fixedFeeUsd: 0.05, floatAcquisitionBps: 0 };

  it("passes silently when the acquisition cost is unmeasured (0)", () => {
    expect(checkPricingCoversFloat(base, 50).level).toBe("ok");
  });

  it("passes when the markup covers the acquisition cost", () => {
    expect(checkPricingCoversFloat({ ...base, floatAcquisitionBps: 300 }, 50).level).toBe("ok");
  });

  it("warns, and names the breakeven ticket, when it does not", () => {
    const r = checkPricingCoversFloat({ ...base, floatAcquisitionBps: 471 }, 50);
    expect(r.level).toBe("warn");
    // fixedFee / (acq - markup) = 0.05 / 0.0071 = $7.04
    expect(r.detail).toContain("$7.04");
  });

  it("names the worst-case loss at the configured order ceiling", () => {
    const r = checkPricingCoversFloat({ ...base, floatAcquisitionBps: 471 }, 50);
    // 50 * 0.0071 - 0.05 = $0.305
    expect(r.detail).toContain("$0.31");
    expect(r.detail).toContain("MAX_ORDER_USD=50");
  });

  it("recommends a markup that covers acquisition AND margin, not just the gap", () => {
    // 1.0471 * 1.04 = 1.089 -> 890 bps, NOT 471.
    expect(checkPricingCoversFloat({ ...base, floatAcquisitionBps: 471 }, 50).detail).toContain("890");
  });

  it("is a warning, never a failure — selling at a loss may be deliberate, but not silent", () => {
    expect(checkPricingCoversFloat({ ...base, floatAcquisitionBps: 5000 }, 50).level).toBe("warn");
  });
});

// Found live on mainnet 2026-08-29: PAYOUT_SUPPLIER=mock, inherited from the example
// env, publicly advertising a Nigerian bank corridor backed by MockSupplier. An agent
// paying real USDC for it would have received a signed receipt attesting that a
// stranger's bank account was credited, with no refund, because nothing "failed".
describe("checkPayoutSupplier", () => {
  it("is happy when payouts are disabled outright", () => {
    expect(checkPayoutSupplier("", true).level).toBe("ok");
  });

  it("is happy with a real partner", () => {
    expect(checkPayoutSupplier("bitnob", true).level).toBe("ok");
  });

  it("FAILS a production deploy on mock — this one signs a lie about a third-party payment", () => {
    const r = checkPayoutSupplier("mock", true);
    expect(r.level).toBe("fail");
    expect(r.detail).toContain("PAYOUT_SUPPLIER=");
  });

  it("only warns locally, where mock corridors are the point", () => {
    expect(checkPayoutSupplier("mock", false).level).toBe("warn");
  });
});

// The console is a build artefact, not config. It gets a WARNING rather than a failure
// on purpose: unlike every other check here, a missing console cannot take money
// incorrectly — the API and /console are untouched and /pay answers 503 with the fix.
// Promoting this to a failure would block a deploy that is perfectly able to trade.
describe("checkPayConsole", () => {
  it("is happy once web/dist/client exists", () => {
    expect(checkPayConsole(true).level).toBe("ok");
  });

  it("warns — never fails — when the console was not built", () => {
    const r = checkPayConsole(false);
    expect(r.level).toBe("warn");
    expect(r.detail).toContain("build:web");
  });

  it("does not block a production deploy", () => {
    expect(worst([checkPayConsole(false)])).not.toBe("fail");
  });
});
