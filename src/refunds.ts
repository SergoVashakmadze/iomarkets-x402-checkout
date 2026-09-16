// On-chain refunds from a dedicated hot wallet. The wallet holds a SMALL USDC
// float; this module enforces a per-UTC-day ceiling in code so a bug or a
// compromised box cannot drain more than one day's cap. The refund transaction
// carries the order id in its note field so anyone can tie it to the original.

import algosdk from "algosdk";
import type { Db } from "./db.js";

export interface Refunder {
  /** Returns the refund txid. Throws on failure (caller records refund_failed). */
  send(orderId: string, payer: string, amountMicro: number): Promise<string>;
  address(): string | null;
}

export class DisabledRefunder implements Refunder {
  async send(): Promise<string> {
    throw new Error("refund wallet not configured (REFUND_MNEMONIC_FILE or systemd credential) — refund manually");
  }
  address(): string | null { return null; }
}

/**
 * The per-UTC-day refund ceiling, kept as a running total rather than re-queried per
 * send. The caller records a refund only *after* send() resolves, so a fresh db query
 * would miss anything still in flight and let concurrent refunds both pass the check.
 * Seeded from the db on the first reservation of each day; a single process owns it
 * so that is the whole picture.
 */
export class DailyCap {
  private state = { day: "", micro: 0 };
  constructor(private readonly capMicro: number, private readonly seed: () => number) {}

  /** Throws if this amount would breach the cap; otherwise counts it as spent. */
  reserve(amountMicro: number): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.state.day !== day) this.state = { day, micro: this.seed() };
    const total = this.state.micro + amountMicro;
    if (total > this.capMicro) {
      throw new Error(`refund daily cap reached (${total} > ${this.capMicro} micro-USDC) — refund manually`);
    }
    this.state.micro = total;
  }

  /** Give back a reservation whose send failed — no money moved. */
  release(amountMicro: number): void {
    this.state.micro = Math.max(0, this.state.micro - amountMicro);
  }

  spentTodayMicro(): number {
    return this.state.micro;
  }
}

export class AlgorandRefunder implements Refunder {
  private readonly account: algosdk.Account;
  private readonly algod: algosdk.Algodv2;
  /**
   * Sends are serialised so the cap check and the spend cannot interleave. Reading
   * the day's total from the db and then sending is a check-then-act race: two
   * refunds for different orders can both read the same total, both pass, and
   * together exceed the cap. The caller also records the refund only *after* send()
   * resolves, so the db total lags anything still in flight — hence the running
   * counter below rather than a fresh query per send.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cap: DailyCap;

  constructor(
    mnemonic: string,
    algodUrl: string,
    private readonly usdcAsa: number,
    db: Db,
    dailyCapMicro: number,
    /** Prefix of the on-chain note. Permanent and public, so it follows BRAND_SITE. */
    private readonly notePrefix = "iomarkets.app",
  ) {
    this.account = algosdk.mnemonicToSecretKey(mnemonic);
    this.algod = new algosdk.Algodv2("", algodUrl, "");
    this.cap = new DailyCap(dailyCapMicro, () => db.refundsSentTodayMicro());
  }

  address(): string { return this.account.addr.toString(); }

  send(orderId: string, payer: string, amountMicro: number): Promise<string> {
    const run = this.queue.then(
      () => this.sendOne(orderId, payer, amountMicro),
      () => this.sendOne(orderId, payer, amountMicro), // a failed send must not block the next
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendOne(orderId: string, payer: string, amountMicro: number): Promise<string> {
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw new Error("bad refund amount");
    this.cap.reserve(amountMicro);
    try {
      return await this.transfer(orderId, payer, amountMicro);
    } catch (e) {
      // No money moved, so it must not count against the day. Otherwise a flaky
      // algod would eat the cap and block the refunds that follow.
      this.cap.release(amountMicro);
      throw e;
    }
  }

  private async transfer(orderId: string, payer: string, amountMicro: number): Promise<string> {
    return sendUsdc(this.algod, this.account, this.usdcAsa, payer, amountMicro, `${this.notePrefix} refund ${orderId}`);
  }
}

/** One USDC transfer from a hot account, confirmed. Shared by refunds and referral payouts
 *  so there is exactly one piece of code on this box that signs a transfer. */
export async function sendUsdc(
  algod: algosdk.Algodv2, account: algosdk.Account, usdcAsa: number, to: string, amountMicro: number, note: string,
): Promise<string> {
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: to,
    amount: amountMicro,
    assetIndex: usdcAsa,
    note: new TextEncoder().encode(note),
    suggestedParams: sp,
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(account.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 8);
  return txid;
}

/** The refund hot wallet, seen as a payer of referral shares (src/referrals.ts). */
export class HotWallet {
  private readonly account: algosdk.Account;
  private readonly algod: algosdk.Algodv2;
  constructor(mnemonic: string, algodUrl: string, private readonly usdcAsa: number) {
    this.account = algosdk.mnemonicToSecretKey(mnemonic);
    this.algod = new algosdk.Algodv2("", algodUrl, "");
  }
  async balanceMicro(): Promise<number | null> {
    try {
      const r = await this.algod.accountAssetInformation(this.account.addr, this.usdcAsa).do();
      return Number(r.assetHolding?.amount ?? 0);
    } catch {
      return null;
    }
  }
  send(to: string, amountMicro: number, note: string): Promise<string> {
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) return Promise.reject(new Error("bad amount"));
    return sendUsdc(this.algod, this.account, this.usdcAsa, to, amountMicro, note);
  }
}
