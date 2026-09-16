// Routes each product type to the supplier that can fulfil it: goods (topup /
// eSIM / bill) to the prepaid supplier, international payments (payout) to the
// licensed payout partner. One Supplier interface outwards.
import { SupplierError, type Offer, type PhoneLookup, type ProductType, type PurchaseRequest, type PurchaseResult, type Supplier, type SupplierCountry } from "./types.js";

export class CompositeSupplier implements Supplier {
  readonly name: string;
  constructor(
    private readonly goods: Supplier,
    private readonly payouts: Supplier | null,
    /** Bill pay lives on its own supplier: Reloadly's OAuth audience names a PRODUCT as
     *  well as an environment, so utilities needs a different token from airtime even
     *  on the same credentials. Null hides `type: "bill"` entirely. */
    private readonly bills: Supplier | null = null,
    /** eSIMs get their own slot because the airtime supplier does not sell them:
     *  Reloadly has no eSIM product at all, while Zendit and Airalo do. Null falls
     *  back to `goods`, which is the behaviour before this slot existed. */
    private readonly esims: Supplier | null = null,
  ) {
    const names = [
      goods.name,
      payouts && payouts !== goods ? payouts.name : null,
      bills && bills !== goods ? bills.name : null,
      esims && esims !== goods ? esims.name : null,
    ];
    this.name = names.filter(Boolean).join("+");
  }
  /**
   * What this service can actually sell right now — the union of the wired slots'
   * declared types, intersected with the routing above. Everything public that names
   * products renders from this rather than from a hand-written list, so a supplier
   * being unwired or deprecated cannot leave a promise behind on the landing page,
   * in /agent.md, or in the Bazaar description a judge reads.
   */
  availableTypes(): ProductType[] {
    const all: ProductType[] = ["topup", "esim", "bill", "payout"];
    const declared = (s: Supplier | null, fallback: readonly ProductType[]): readonly ProductType[] =>
      s === null ? [] : (s.productTypes ?? fallback);
    const goods = declared(this.goods, all);
    const payouts = declared(this.payouts, ["payout"]);
    const bills = declared(this.bills, ["bill"]);
    const esims = this.esims ? declared(this.esims, ["esim"]) : null;
    return all.filter((t) => {
      if (t === "payout") return payouts.includes(t);
      if (t === "bill") return bills.includes(t);
      if (t === "esim") return esims ? esims.includes(t) : goods.includes(t);
      return goods.includes(t);
    });
  }

  /**
   * Which wallet fills this product type, as a stable key.
   *
   * The float check has to ask the RIGHT balance and net off only the orders drawing on
   * it: an in-flight $150 payout must not make a $3 top-up unaffordable, and an eSIM
   * bought from Zendit does not spend Reloadly's airtime float.
   *
   * Keyed by **object identity**, not by `name`. Two product types served by the same
   * supplier instance share one float — which is exactly what happens when Zendit sells
   * both airtime and eSIMs — while two different instances stay separate even if they
   * report the same name, which two adapters of the same vendor would.
   */
  private readonly walletIds = new Map<Supplier, string>();
  private walletId(s: Supplier | null): string {
    if (!s) return "none";
    const existing = this.walletIds.get(s);
    if (existing) return existing;
    const id = `w${this.walletIds.size}:${s.name}`;
    this.walletIds.set(s, id);
    return id;
  }
  floatGroupFor(type: ProductType): string {
    if (type === "payout") return this.walletId(this.payouts);
    if (type === "bill") return this.walletId(this.bills);
    if (type === "esim" && this.esims) return this.walletId(this.esims);
    return this.walletId(this.goods);
  }

  /** The balance of whichever wallet fills `type`. Null = no supplier wired for it. */
  balanceMicroForType(type: ProductType): Promise<number> | null {
    if (type === "payout") return this.payouts ? this.payouts.balanceMicro() : null;
    if (type === "bill") return this.bills ? this.bills.balanceMicro() : null;
    if (type === "esim" && this.esims) return this.esims.balanceMicro();
    return this.goods.balanceMicro();
  }

  get productTypes(): readonly ProductType[] { return this.availableTypes(); }

  private pick(type: ProductType): Supplier {
    if (type === "payout") {
      if (!this.payouts) throw new SupplierError("international payments are not enabled (PAYOUT_SUPPLIER unset)");
      return this.payouts;
    }
    if (type === "bill") {
      if (!this.bills) throw new SupplierError("bill payments are not enabled (BILL_SUPPLIER unset)");
      return this.bills;
    }
    if (type === "esim" && this.esims) return this.esims;
    return this.goods;
  }
  private missing(type: ProductType): boolean {
    return (type === "payout" && !this.payouts) || (type === "bill" && !this.bills);
  }
  lookupPhone(m: string): Promise<PhoneLookup> { return this.goods.lookupPhone(m); }
  listOffers(q: { type: ProductType; country?: string; brand?: string; limit?: number; offset?: number }): Promise<Offer[]> {
    if (this.missing(q.type)) return Promise.resolve([]);
    return this.pick(q.type).listOffers(q);
  }
  /** Delegated to whichever supplier fills this product, when it can answer at all. */
  async listCountries(type: ProductType): Promise<SupplierCountry[]> {
    if (this.missing(type)) return [];
    const s = this.pick(type);
    return (await s.listCountries?.(type)) ?? [];
  }
  getOffer(type: ProductType, id: string): Promise<Offer | null> {
    if (this.missing(type)) return Promise.resolve(null);
    return this.pick(type).getOffer(type, id);
  }
  // `async` so an unconfigured product REJECTS rather than throwing synchronously.
  // Both return Promise<PurchaseResult>, so a caller doing `.catch()` on the result —
  // rather than wrapping the call itself in try/catch — would otherwise get an
  // uncaught exception from pick(). The order layer happens to use try/catch, so this
  // never bit; it is a trap left for whoever calls it next.
  async purchase(req: PurchaseRequest): Promise<PurchaseResult> { return this.pick(req.type).purchase(req); }
  async getPurchase(type: ProductType, id: string): Promise<PurchaseResult> { return this.pick(type).getPurchase(type, id); }
  balanceMicro(): Promise<number> { return this.goods.balanceMicro(); }
  async fxRate(currency: string): Promise<number | null> {
    const a = await this.goods.fxRate?.(currency);
    if (a) return a;
    return (await this.payouts?.fxRate?.(currency)) ?? (await this.bills?.fxRate?.(currency)) ?? null;
  }
  /** Balance of the payout partner wallet, if enabled. */
  payoutBalanceMicro(): Promise<number> | null { return this.payouts ? this.payouts.balanceMicro() : null; }
}
