# IoMarkets Topup — real-world checkout for AI agents on Algorand

**Your AI agent can now buy real things — and send money.** **Live today: travel eSIMs for 200+ destinations
and mobile airtime/data top-ups in 150+ countries.** Prepaid bills and international payments (bank / mobile
money / UPI payouts via a licensed partner) are built and supplier-gated. Everything is
paid per order in USDC on Algorand via [x402](https://x402.org). No account, no API key,
no card. Money settles on-chain first, goods ship second, failures refund on-chain automatically, and every
terminal order carries an ed25519-signed receipt anyone can verify.

Built for the [Global x402 Challenge](https://algorand.co/global-x402-challenge) (Algorand Foundation × GoPlausible).
Live: **https://iomarkets.app** · agent docs: `/agent.md` · ledger: `/v1/ledger` · receipt spec: [`docs/RECEIPTS.md`](docs/RECEIPTS.md)

## How it works
```
agent ── GET /v1/lookup?phone=+91…  ─▶ operator + offers                      (free)
agent ── POST /v1/quote {type, offerId, recipient, amount} ─▶ quoteId, price   (free, 10-min lock)
agent ── POST /v1/orders {quoteId} ─▶ 402 + exact USDC amount                 (x402)
agent ── …signs Algorand USDC payment, retries with PAYMENT-SIGNATURE ─▶ facilitator settles on-chain (~3 s)
server ── order created ONLY after settlement ─▶ supplier purchase ─▶ delivered | failed → on-chain refund
agent ── GET /v1/orders/{id} ─▶ status, confirmation (operator ref / eSIM LPA), signed receipt, txids
```

| Route | Cost | Purpose |
|---|---|---|
| `GET /v1/lookup?phone=` | free | country / operator / offers for a number |
| `GET /v1/catalog?type=topup\|esim\|bill\|payout&country=&limit=&offset=` | free | browse offers / payout corridors with indicative USDC prices (paged: 100 by default, `total` + `next_offset` in the response, `limit=0` for all) |
| `GET /v1/countries?type=esim` | free | every destination a product reaches (200+ for eSIMs); `enumerable:false` = the supplier will not list them |
| `GET /v1/fx?to=INR&amount=&type=` | free | indicative USDC→local rate at our sale price + estimate (`type` = topup \| bill \| payout, since the markup can differ per product) |
| `POST /v1/quote` | free | lock an exact price for one purchase |
| `POST /v1/orders` | **the quoted amount, x402** | pay → order |
| `GET /v1/orders/:id` | free | status, confirmation, signed receipt, refund txid |
| `POST /v1/verify` | free | verify any receipt: signature + both txids on chain (`?online=0` for signature only) |
| `GET /v1/ledger` · `GET /v1/pubkey` · `GET /agent.md` · `GET /fund` | free | public ledger · receipt key · agent instructions · how to get USDCa |
| `GET /v1/client-config` | free | network, CAIP-2 id, algod URL, USDC ASA and the order ceiling — what a browser needs to build a payment (public values only) |
| `GET /pay` | free | **the batch payout console** — paste a spreadsheet, price every row, approve once, export receipts (`web/`, `?demo=1` for canned data) |
| `GET /console` | free | the original single-file console — no build step, works when `web/dist` is absent |
| `POST /v1/links` · `GET /v1/links/:id` · `POST /v1/links/:id/quote` | free | **pay links** — an agent with no wallet hands its human a checkout URL (`/l/:id`); they approve the exact price in their own Pera wallet. A top-up link is a "top up my phone" request anyone can pay |
| `GET /p/:settlement_txid` · `GET /v1/proof/:txid` | free | **proof of delivery** — shareable page per goods order (price, delivery time, on-chain settlement, checked signature), keyed by the public txid, never the order id; "get the same eSIM" credits the original buyer |
| `GET /v1/referrals` · `GET /v1/referrals/:address` · `GET /earn` | free | **referral share** — `ref` on any quote or link earns a share of net margin on delivered orders, paid on-chain in USDC; off until `REFERRAL_SHARE_BPS` > 0 |
| `GET /` · `GET /brand/logo.webp` · `GET /favicon.ico` | free | the human landing page — what, why, who, a live-catalogue explorer with a simulated purchase, the ledger, and where the product sits in the IoMarkets® ecosystem; the logo and icons every page shares (`src/brand.ts`) |

## Trust model (what makes agents use it extensively)
- **No order without a settled payment** — the order row is created from the facilitator's settlement txid.
- **Exact pricing** — the 402 challenge carries the quoted amount; a quote pays once and expires in 10 min.
- **Automatic refunds** — supplier failure ⇒ USDC returned to the paying address on-chain, note = order id.
- **Signed receipts** — `{order, amount, payer, settlement txid, refund txid}` signed with a published ed25519 key
  (`pnpm verify receipts/<id>.json --online` checks the signature *and* both transactions on Algorand).
  The same check is an endpoint anyone can call — `POST /v1/verify` — and it verifies receipts from **any**
  server that adopts the format, not just ours. The format is a spec: [`docs/RECEIPTS.md`](docs/RECEIPTS.md).
- **Public ledger** — every order, outcome and txid (recipients hashed).
- **Abuse posture** — $50/order (goods), $200/payment (payouts), $200/payer/day, sanctioned destinations refused,
  replay guard, rate limits; payouts need a sender record and a partner KYC reference above $100/day (`src/compliance.ts`).
- **Key hygiene** — the server holds one hot key (refund float, daily-capped); `PAY_TO` is an address only;
  secrets come from files / systemd encrypted credentials, never `.env` (see `src/keys.ts`).

## Run it
```bash
pnpm install --frozen-lockfile --ignore-scripts
cp .env.example .env            # PAY_TO, RECEIPT_* (pnpm gen-key), SUPPLIER=mock to start
pnpm dev                        # http://127.0.0.1:3000  (NETWORK=mainnet — the facilitator serves mainnet)
pnpm test && pnpm typecheck

# The batch payout console (web/ — React + TanStack Start, installed with bun).
pnpm install:web && pnpm build:web   # → web/dist/client, served by the SAME process at /pay
pnpm dev:web                         # or: vite with HMR on http://127.0.0.1:8080/pay/ , /v1 proxied to :3000
AGENT_MNEMONIC_FILE=~/.secrets/agent.mnemonic pnpm buy --phone +919876543210 --amount 100   # real USDC
pnpm check-bazaar               # listed after the first settled payment
```
Mock supplier rules for demos: a phone ending `0000` fails (→ refund path), `1111` is delivered after polling.

## Agent integrations
- `.claude-plugin/plugin.json` — Claude Code plugin: this skill + the hosted MCP server, zero setup for the user.
- `server.json` — MCP registry manifest (`remotes` → `https://iomarkets.app/mcp`); needs the deploy live + a DNS TXT record proving the `app.iomarkets` namespace.
- `skills/iomarkets-topup/SKILL.md` — the single shared skill for **OpenClaw**, **Hermes** and **Claude Code** (agentskills format);
  publishing to each hub is a copy, not a fork (`skills/README.md`).
- `pnpm mcp` — MCP server (stdio) with `lookup_phone`, `list_offers`, `quote`, `buy`, `order_status`, `verify_receipt`, `ledger`, `create_pay_link`.
- Bazaar: the paid route declares discovery metadata + the `x402-global-challenge` tag; it is indexed on first settlement.

## Layout
```
src/app.ts          HTTP surface + x402 wiring (dynamic price = quote, preflight hook, post-settle order creation)
src/orders.ts       quote → paid → fulfilling → delivered | failed → refunded   (single-flight, resumable)
src/suppliers/      types · mock · zendit · reloadly · composite (goods + payouts) · payout-partner (skeleton)
src/compliance.ts   payout gate (sanctions, caps, sender, KYC threshold)
src/receipt.ts      ed25519 receipts        src/refunds.ts  on-chain refunds (daily cap)
src/db.ts           node:sqlite             src/keys.ts     secret sources (file / systemd cred / env)
src/growth.ts       pay links · proof pages · referral routes   src/referrals.ts  margin share, reserve-first payouts
src/mcp.ts          MCP server              src/client/paying.ts  x402 paying fetch with budget
scripts/            gen-key · new-wallet · optin-usdc · buy · verify-receipt · check-bazaar
docs/RECEIPTS.md    the signed-receipt format, as a spec other sellers can adopt
deploy/entrypoint.sh  container entrypoint: refuses to start on a config that cannot take money
```
