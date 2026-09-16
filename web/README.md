# IoMarkets Pay

Build a **batch payout console** for a cross-border payments product called **IoMarkets**.

## Who uses it

An operations person at a payments company or an iGaming operator. They pay 20–300 people a week —
affiliates, agents, suppliers — into Nigeria, Kenya, Ghana, India and the Philippines. They are competent
with money and spreadsheets and completely uninterested in crypto. They should never see the words
blockchain, wallet address, gas or token unless it is unavoidable, and the one place it is unavoidable
(approving payments in their wallet) should feel like approving a bank batch.

## What the product does

They fund a wallet with USDC once, then spend it down per payment. Each payment settles on-chain in about
three seconds before anything is bought downstream, and returns a cryptographically signed receipt. If the
downstream provider fails to deliver, the money refunds itself automatically. The audit trail is the
product; the technology is not the point and should stay out of the way.

## The flow — four steps, one page, a progress rail across the top

**Step 1 — Recipients.** Choose what they're sending (a segmented control: "Bank & mobile money" /
"Airtime & data"), then destination country, then the corridor. Once a corridor is chosen the app knows
which recipient columns are required, and tells them. They then supply recipients by pasting rows, dragging
a .csv onto the page, or typing into an editable table — support all three, and make drag-and-drop
obvious. Validate every row live, with the specific error on the specific row ("missing bank_code", not
"invalid"). A "Sending as" block captures the payer's own legal name and country, remembered on the device.
Show a running count and a total. The continue button stays disabled, with a sentence saying exactly what
is missing, until the batch is clean.

**Step 2 — Review.** Lock a price for every row by calling the quote API once per recipient, with visible
per-row progress. Show summary figures — recipients, total USDC, average per recipient, destination — and a
table with each row's exact price. Warn clearly if any payment exceeds the account's per-payment ceiling or
the batch exceeds the daily limit. Prices expire in ten minutes: show that, and handle expiry gracefully.

**Step 3 — Pay.** One wallet approval, then the batch executes. Each row moves through paying → settling →
delivered, and the row should visibly change state as it goes. Show progress against the total, the amount
settled so far, and a settlement reference per row that links to the block explorer. Failures do not stop
the batch; they collect at the end with a reason and a retry.

**Step 4 — Receipts.** Delivered / refunded / failed counts, the total settled, a full table, and a CSV
download. Make it feel like the end of a job that went well.

## The real API — call these, do not invent a backend

Same origin as the app, JSON throughout, no API key.

```
GET  /v1/catalog?type=payout|topup&country=NG
     → { offers: [ { offerId, name, brand, brandName, country, payoutMethod,
                     requiredFields: ["full_name","account_number","bank_code"],
                     priceType: "range"|"fixed", sendCurrency, sendMin, sendMax,
                     settlementSeconds } ] }

GET  /v1/limits?payer=<58-char Algorand address>
     → { payer, tier: "standard"|"business", suspended, max_order_usdc,
         max_payout_usdc, daily_usdc, sender_verified }

POST /v1/quote
     { type, offerId, amount, recipient: { fields: {…} } | { phone },
       sender: { name, country }, payer }
     → { quoteId, price_usdc, delivers, expires_at, pay: { endpoint, body } }
     Errors come back as { error: "human readable sentence" } with a 4xx — show
     that sentence on the row verbatim; it is written to be shown.

POST /v1/orders  { quoteId }
     → 402 with a payment-required header on the first call. Sign the payment,
       retry with the signature header, → { orderId, status, status_url }

GET  /v1/orders/:id
     → { status, terminal, settlement_txid, settlement_url, confirmation,
         receipt, refund_txid, error }
     Poll every 2–3 s until terminal is true.
```

Payment uses the **x402** protocol on Algorand with a **Pera** wallet. Load these as ES modules and wire the
Pera wallet to the x402 client through the `ClientAvmSigner` interface (`{ address, signTransactions(txns,
indexesToSign) }`); Pera returns only the transactions it was asked to sign, in order, so the unsigned
slots have to be put back as nulls:

```
https://cdn.jsdelivr.net/npm/@perawallet/connect@1.6.0/+esm
https://cdn.jsdelivr.net/npm/@x402/core@2.23.0/dist/esm/client/index.mjs/+esm
https://cdn.jsdelivr.net/npm/@x402/core@2.23.0/dist/esm/http/index.mjs/+esm
https://cdn.jsdelivr.net/npm/@x402/avm@2.23.0/dist/esm/exact/client/index.mjs/+esm
https://cdn.jsdelivr.net/npm/algosdk@3.1.0/+esm
```

Also build a **demo mode** (`?demo=1`) that runs the whole four-step flow on realistic canned data with no
wallet connected, with simulated latency so the states are actually visible. This is what gets shown to
prospects, so it has to look identical to the real thing.

## Interaction design — this is where the product is won or lost

The four steps above are the functional spec, not the design. A working version of them already exists and
is deliberately plain; your job is to make this feel like a tool someone is glad to open on a Friday
afternoon with 200 people to pay. Specifics that matter more than the visuals:

**Entering recipients is the whole first impression.** Support all three of paste, drag-and-drop, and an
editable table, and make them the same thing: pasting a block of rows into the page — anywhere, not just a
box — turns them into table rows immediately. Dragging a .csv onto the window shows a full-page drop target.
The table is keyboard-first: tab across cells, Enter adds a row, a row can be deleted without the mouse.
Show a real empty state that teaches the format rather than an empty box.

**When a file doesn't match, offer to map it rather than rejecting it.** A finance export has columns in the
wrong order with names like "Beneficiary Name" and "Acct No". Show a small column-mapping step — their
header on the left, our required field on the right, a best-guess pre-selected — instead of an error. This
one screen is the difference between a pilot that starts today and one that starts never.

**Errors attach to the cell, not to the batch.** Highlight the offending cell, say what is wrong in the
row's own space, and let them fix it in place. Never disable the continue button without a sentence
saying exactly what is blocking it and how many rows are affected. Offer "show only rows with problems"
once a batch is over ~20 rows.

**A running total that never leaves the screen.** As they type, a sticky summary shows recipient count,
total to send, and — once quoted — the exact USDC figure. Money should update visibly when it changes.

**The irreversible moment deserves ceremony.** Before the wallet approval, a confirmation that restates the
count, the total, the destination and the corridor in plain language. Afterwards, per-row states that
actually animate through paying → settling → delivered, because watching it work is what builds trust the
first time. Failures collect at the bottom with a reason and a one-click retry — never a modal that loses
the batch.

**Large batches must stay fast.** 300 rows should scroll and filter without lag; virtualise the table.

**Everything survives a refresh.** A half-built batch, the sender details, the in-flight run — nothing
should be lost by a stray reload mid-way through paying 200 people.

## Design direction

This is a **money movement tool for professionals**, and it should look like one: confident, dense where
density helps, calm everywhere else. Closer to a modern treasury or trading interface than to a consumer
fintech app. The people using it look at spreadsheets all day and will judge it in four seconds.

- **Commit to a real, distinctive palette.** One considered accent, used sparingly — the primary action, the
  active step, nothing else. Neutrals with a slight hue bias rather than flat greys, so the page reads as
  designed rather than defaulted. Semantic colour for state (settled / pending / failed) must be clearly
  distinct from the brand accent. **Avoid** the purple-to-blue gradient hero, neon accents on near-black,
  everything centred, and rounded cards with a coloured left rail — those are the generated-app defaults and
  a payments professional has seen them a hundred times this year.
- **Typography does real work.** Pair a characterful face for headings and large figures with a clean
  workhorse for the interface, and a monospace for money, addresses and references. Tabular figures
  everywhere digits line up. **Do not use Inter.** Set a type scale and stay on it.
- **State readable at a glance** — a status chip, a severity stripe, a progress rail — so someone scanning
  200 rows sees the four that need attention without reading a word.
- **Light and dark both**, as design tokens, with equal care given to each. Test the accent on both grounds.
- Motion only where it carries meaning: rows changing state, progress advancing, a total ticking up. No
  decorative animation, and honour `prefers-reduced-motion`.
- Responsive down to a laptop at least; every table scrolls inside its own container so the page never
  scrolls sideways.
- Accessible: visible keyboard focus, real labels, sensible contrast, and the whole first step operable
  without a mouse.

## What must be true when you're done

1. A person who has never seen it can pay 50 people without being told what to do.
2. Nothing implies a payment succeeded before it settled.
3. Every failure is visible, explained, and retryable.
4. The demo looks exactly like the real thing.
5. Someone who does this weekly would rather use it than their bank's portal — which is a low bar, and still the one that matters.



## Development

This app is part of the `iomarkets-app` repo and is served at `/pay` by the Hono API
process in production. It uses **bun** (see `bun.lock`).

```sh
bun install
bun run dev     # http://127.0.0.1:8080/pay/  — /v1 proxied to the API on :3000
bun run build   # → dist/client, served by the API process
bun run test
```

The API must be running for anything but `?demo=1`: `pnpm dev` from the repo root.
