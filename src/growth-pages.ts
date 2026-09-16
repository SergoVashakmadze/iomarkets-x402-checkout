// The three human pages behind src/growth.ts. Server-rendered so a shared link unfurls
// with real content on X, WhatsApp and Telegram (crawlers do not run scripts), with a
// small module script each for the parts that need a wallet or a click.
//
// Client scripts are plain string concatenation, never template literals: they live
// inside a TypeScript template literal, and a stray `${` would be evaluated here.
// test/growth.test.ts compiles each one, the same guard test/pages.test.ts keeps on
// the other pages.

import { bootJson, esc, shell } from "./chrome.js";

const regionName = (cc: string): string => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc; } catch { return cc; }
};

// ── /l/:id ─────────────────────────────────────────────────────────────────────

export interface LinkPageView {
  linkId: string; url: string; type: string; title: string; country: string; brand: string;
  recipient: { phone?: string }; note?: string; uses: number; max_uses: number; expires_at: string;
  state: string; delivers_to: string;
}

export function payLinkPageHtml(o: { base: string; link: LinkPageView | null }): string {
  const l = o.link;
  if (!l) {
    return shell({
      title: "Pay link not found · IoMarkets", description: "This pay link does not exist.", base: o.base, path: "/l/", noindex: true,
      body: `<div class="eyebrow">Pay link</div><h1>This link does not exist.</h1><p class="lead">Check the address you were sent, or ask for a new link.</p><p><a class="btn primary" href="/">Go to iomarkets.app</a></p>`,
    });
  }
  const place = regionName(l.country);
  const product = l.type === "esim" ? `${place} travel eSIM` : `Mobile top-up · ${place}`;
  const title = l.type === "esim" ? `${product}: ${l.title}` : `Top up ${l.recipient.phone ?? "a phone"} · ${l.title}`;
  const body = `
<div class="eyebrow">Pay link · settles in USDC on Algorand</div>
<h1>${esc(product)}</h1>
<p class="lead">${l.type === "esim"
    ? "Someone, or their AI agent, put this travel eSIM in front of you. Pay from your own Algorand wallet and the activation code appears on this page within seconds."
    : `Someone has asked for this top-up. Anyone can pay it: the credit goes to <b>${esc(l.recipient.phone ?? "the number on the link")}</b>, not to whoever pays.`}</p>
${l.note ? `<p class="note">“${esc(l.note)}”</p>` : ""}

<div class="grid">
  <div class="card">
    <h2>What you get</h2>
    <dl class="kv" style="margin-top:.8rem">
      <dt>Product</dt><dd>${esc(l.title)}</dd>
      <dt>Where</dt><dd>${esc(place)}${l.type === "topup" ? ` · ${esc(l.brand)}` : ""}</dd>
      <dt>Delivered to</dt><dd>${esc(l.type === "esim" ? "You: the activation code shows on this page" : l.recipient.phone ?? "")}</dd>
      <dt>Link expires</dt><dd class="mono">${esc(new Date(l.expires_at).toUTCString().replace(" GMT", " UTC"))}</dd>
    </dl>
  </div>
  <div class="card" id="paycard">
    <h2>Pay</h2>
    <div id="st-open" ${l.state === "open" ? "" : "hidden"}>
      <p class="muted small">This price is held for 10 minutes. You approve that exact amount in your own Pera wallet, and nothing moves without your signature.</p>
      <div class="price" id="price">…</div>
      <p class="small muted" id="expiry"></p>
      <div class="row" style="margin-top:.6rem">
        <button class="btn primary" id="go">Connect Pera wallet</button>
        <button class="btn gold" id="approve" hidden>Approve in Pera</button>
      </div>
      <p class="small" id="msg" role="status" aria-live="polite"></p>
    </div>
    <div id="st-closed" ${l.state === "open" ? "hidden" : ""}>
      <span class="stamp ${l.state === "paid" ? "ok" : "warn"}">${l.state === "paid" ? "Already paid" : "Expired"}</span>
      <p>${l.state === "paid" ? "Someone has already paid this link. Nothing more is due." : "This link has expired. Ask for a new one."}</p>
    </div>
  </div>
</div>

<div class="card" id="result" hidden>
  <div class="row"><h2 id="r-h">Order</h2><span class="stamp" id="r-stamp"></span></div>
  <div id="r-body" style="margin-top:.8rem"></div>
</div>

<div class="grid">
  <div class="card"><h3>Why this is safe</h3><p class="small">Your USDC settles on-chain <b>before</b> anything is bought. If delivery fails it is refunded to your wallet automatically, on-chain. Every order gets an ed25519-signed receipt you can <a href="/verify">check yourself</a>.</p></div>
  <div class="card"><h3>No USDC on Algorand yet?</h3><p class="small">You need USDCa and about 0.2 ALGO in a Pera wallet. <a href="/fund">Three ways to get it</a>, including a card on-ramp inside Pera.</p></div>
  <div class="card"><h3>Paying from an agent?</h3><p class="small"><code>POST ${esc(o.base)}/v1/links/${esc(l.linkId)}/quote</code> then pay the quote over x402 as in <a href="/agent.md">/agent.md</a>.</p></div>
</div>`;

  const script = `
var L = ${bootJson(l)};
var $ = function (id) { return document.getElementById(id); };
var S = { cfg: null, pera: null, payer: null, quote: null, x402: null };
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var msg = function (t, bad) { $("msg").textContent = t || ""; $("msg").className = "small" + (bad ? " err" : ""); };
var KEY = "iomarkets.linkOrders";
function remembered() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
function remember(orderId) { try { var m = remembered(); m[L.linkId] = orderId; localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) {} }

async function cfg() { if (!S.cfg) S.cfg = await (await fetch("/v1/client-config")).json(); return S.cfg; }

async function connect() {
  var c = await cfg();
  var mod = await import("https://cdn.jsdelivr.net/npm/@perawallet/connect@1.6.0/+esm");
  S.pera = new mod.PeraWalletConnect({ chainId: String(c.network).indexOf("test") >= 0 ? 416002 : 416001 });
  var accounts = [];
  try { accounts = await S.pera.reconnectSession(); } catch (e) {}
  if (!accounts || !accounts.length) accounts = await S.pera.connect();
  S.payer = accounts[0];
}

async function lockPrice() {
  var r = await fetch("/v1/links/" + L.linkId + "/quote", { method: "POST" });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.error || "could not price this link (" + r.status + ")");
  S.quote = j;
  $("price").textContent = Number(j.price_usdc).toFixed(2) + " USDC";
  $("expiry").textContent = "Price held until " + new Date(j.expires_at).toLocaleTimeString() + (S.payer ? " · paying from " + S.payer.slice(0, 6) + "…" + S.payer.slice(-4) : "");
}

async function x402() {
  if (S.x402) return S.x402;
  var mods = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@x402/core@2.23.0/dist/esm/client/index.mjs/+esm"),
    import("https://cdn.jsdelivr.net/npm/@x402/core@2.23.0/dist/esm/http/index.mjs/+esm"),
    import("https://cdn.jsdelivr.net/npm/@x402/avm@2.23.0/dist/esm/exact/client/index.mjs/+esm"),
    import("https://cdn.jsdelivr.net/npm/algosdk@3.1.0/+esm"),
  ]);
  var core = mods[0], http = mods[1], avm = mods[2], algosdk = mods[3].default || mods[3];
  var c = await cfg();
  var signer = {
    address: S.payer,
    signTransactions: async function (txns, indexesToSign) {
      var want = indexesToSign || txns.map(function (_, i) { return i; });
      var group = txns.map(function (b, i) {
        return want.indexOf(i) >= 0 ? { txn: algosdk.decodeUnsignedTransaction(b) } : { txn: algosdk.decodeUnsignedTransaction(b), signers: [] };
      });
      var signed = await S.pera.signTransaction([group]);
      var k = 0;
      return txns.map(function (_, i) { return want.indexOf(i) >= 0 ? signed[k++] : null; });
    },
  };
  // The spend control is the price shown on screen: a 402 asking for more is refused.
  var client = core.x402Client.fromConfig({
    schemes: [{ network: "algorand:*", client: new avm.ExactAvmScheme(signer, { algodUrl: c.algod_url }) }],
    spendControls: { maxAmountPerPayment: "$" + Number(S.quote.price_usdc).toFixed(2) },
  });
  S.x402 = new http.x402HTTPClient(client);
  return S.x402;
}

async function pay() {
  var h = await x402();
  var init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: S.quote.quoteId }) };
  var res = await fetch("/v1/orders", init);
  if (res.status === 402) {
    var body = await res.json().catch(function () { return undefined; });
    var required = h.getPaymentRequiredResponse(function (n) { return res.headers.get(n); }, body);
    var payload = await h.createPaymentPayload(required);
    var headers = Object.assign({}, init.headers, h.encodePaymentSignatureHeader(payload));
    res = await fetch("/v1/orders", Object.assign({}, init, { headers: headers }));
  }
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.error || "payment refused (" + res.status + ")");
  return j.orderId;
}

function el(tag, attrs, text) {
  var e = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
  if (text !== undefined) e.textContent = text;
  return e;
}

async function renderOrder(o) {
  $("result").hidden = false;
  var stamp = $("r-stamp");
  var tone = o.status === "delivered" ? "ok" : o.status === "refunded" ? "warn" : o.terminal ? "bad" : "";
  stamp.className = "stamp " + tone;
  stamp.textContent = o.status;
  $("r-h").textContent = o.status === "delivered" ? "Delivered" : o.terminal ? "Order closed" : "Paid. Delivering…";
  var b = $("r-body");
  b.innerHTML = "";
  var conf = o.confirmation || {};
  if (o.status === "delivered" && L.type === "esim" && (conf.lpa || conf.qrcode_url)) {
    b.appendChild(el("p", {}, "Scan this with the phone that will use the eSIM (Settings → Mobile data → Add eSIM → Use QR code)."));
    var qrBox = el("div", { style: "background:#fff;padding:12px;border-radius:12px;width:min(260px,100%);margin:.6rem 0" });
    b.appendChild(qrBox);
    if (conf.lpa) {
      try {
        var q = (await import("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm")).default(0, "M");
        q.addData(conf.lpa); q.make();
        qrBox.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } catch (e) {
        if (conf.qrcode_url) qrBox.appendChild(el("img", { src: conf.qrcode_url, alt: "eSIM QR code", width: "236" }));
      }
      // One-tap install links. Apple: iOS 17.4+. Google: Play services 25.14+ (April 2025),
      // opened from Chrome, Gmail or SMS — not from an in-app browser such as WhatsApp's.
      // Both hosts must stay lowercase; the activation code keeps its case.
      var carddata = encodeURIComponent(conf.lpa);
      var ua = navigator.userAgent || "";
      var isAndroid = /Android/i.test(ua);
      var isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
      var row = el("div", { class: "row" });
      var ios = el("a", { class: "btn" + (isIOS ? " primary" : ""), href: "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=" + carddata }, "Install on iPhone");
      var android = el("a", { class: "btn" + (isAndroid ? " primary" : ""), href: "https://esimsetup.android.com/esim_qrcode_provisioning?carddata=" + carddata }, "Install on Android");
      var copy = el("button", { class: "btn" }, "Copy activation code");
      copy.onclick = function () { navigator.clipboard.writeText(conf.lpa).then(function () { copy.textContent = "Copied"; }); };
      // This phone's button first; the other platform's stays, for a link forwarded to another device.
      (isAndroid ? [android, ios] : [ios, android]).forEach(function (x) { row.appendChild(x); });
      row.appendChild(copy);
      b.appendChild(row);
      b.appendChild(el("p", { class: "small muted" }, isAndroid
        ? "Android: tap Install from Chrome. If it does not open (older Play services, or you are inside WhatsApp's browser), open this page in Chrome or scan the QR code from Settings → Network & internet → SIMs → Add eSIM."
        : isIOS ? "iPhone: needs iOS 17.4 or later; otherwise scan the QR code from another screen."
        : "On a computer: scan the QR code with the phone, or open this page on the phone and tap its Install button."));
      b.appendChild(el("p", { class: "small muted" }, "Activation code (keep it private, it installs once): " + conf.lpa));
    } else if (conf.qrcode_url) {
      qrBox.appendChild(el("img", { src: conf.qrcode_url, alt: "eSIM QR code", width: "236" }));
    }
  } else if (o.status === "delivered") {
    b.appendChild(el("p", {}, "The top-up was accepted by the operator" + (conf.operatorReference ? " (reference " + conf.operatorReference + ")." : ".")));
  } else if (o.status === "refunded") {
    b.appendChild(el("p", {}, "Delivery failed, so your " + Number(o.price_usdc).toFixed(2) + " USDC was sent back on-chain."));
    if (o.refund_url) b.appendChild(el("a", { href: o.refund_url, target: "_blank", rel: "noopener" }, "Open the refund transaction"));
  } else if (!o.terminal) {
    b.appendChild(el("p", { class: "muted" }, "Payment settled on-chain. Waiting for the supplier to confirm…"));
  } else {
    b.appendChild(el("p", { class: "err" }, "This order needs a human. Keep this order id and contact info@iomarkets.org: " + o.orderId));
  }
  if (o.settlement_txid) {
    var links = el("div", { class: "row", style: "margin-top:.9rem" });
    links.appendChild(el("a", { class: "btn", href: o.settlement_url, target: "_blank", rel: "noopener" }, "Settlement on-chain"));
    if (o.terminal && o.status === "delivered") {
      var proof = location.origin + "/p/" + o.settlement_txid;
      var text = L.type === "esim" ? "Just bought a " + L.title + " eSIM with USDC on Algorand. Settled on-chain, delivered in seconds, signed receipt:" : "Paid a mobile top-up with USDC on Algorand. Settled on-chain, signed receipt:";
      links.appendChild(el("a", { class: "btn x", target: "_blank", rel: "noopener", href: "https://x.com/intent/post?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(proof) }, "Share the proof on X"));
      links.appendChild(el("a", { class: "btn", href: proof }, "Public proof page"));
    }
    b.appendChild(links);
  }
}

async function follow(orderId) {
  for (var i = 0; i < 80; i++) {
    var r = await fetch("/v1/orders/" + orderId);
    if (r.ok) {
      var o = await r.json();
      await renderOrder(o);
      if (o.terminal) return;
    }
    await sleep(2500);
  }
}

$("go") && ($("go").onclick = async function () {
  var go = $("go");
  go.disabled = true;
  try {
    msg("Opening Pera…");
    await connect();
    if (!S.quote || new Date(S.quote.expires_at).getTime() < Date.now() + 60000) { msg("Refreshing the price…"); }
    await lockPrice();
    msg("Check the price, then approve it in Pera.");
    go.hidden = true;
    $("approve").hidden = false;
    $("approve").textContent = "Approve " + Number(S.quote.price_usdc).toFixed(2) + " USDC in Pera";
  } catch (e) {
    msg(String((e && e.message) || e), true);
    go.disabled = false;
  }
});

$("approve") && ($("approve").onclick = async function () {
  var a = $("approve");
  a.disabled = true;
  try {
    if (new Date(S.quote.expires_at).getTime() < Date.now() + 15000) { msg("The price lock ran out. Locking a fresh one…"); await lockPrice(); }
    msg("Waiting for your signature in Pera…");
    var orderId = await pay();
    remember(orderId);
    msg("Paid. Settled on-chain.");
    $("paycard").querySelector("#st-open").hidden = true;
    await follow(orderId);
  } catch (e) {
    msg(String((e && e.message) || e), true);
    a.disabled = false;
  }
});

(async function () {
  if (L.state === "open") { try { await lockPrice(); } catch (e) { msg(String((e && e.message) || e), true); } }
  var prior = remembered()[L.linkId];
  if (prior) await follow(prior);
})();
`;
  return shell({ title: `${title} · pay with USDC · IoMarkets`, description: `${product}. ${l.note ? `“${l.note}” · ` : ""}Pay from your own Algorand wallet; settles on-chain first, refunds on-chain automatically, signed receipt.`, base: o.base, path: `/l/${l.linkId}`, body, script, noindex: true });
}

// ── /p/:txid ───────────────────────────────────────────────────────────────────

export interface ProofView {
  status: string; terminal: boolean; type: string; country: string; brand: string; what: string;
  price_usdc: string; paid_at: string; delivered_in_seconds?: number; payer: string;
  settlement_txid: string; settlement_url: string; refund_url?: string;
  receipt_signature_valid: boolean | null; signed_by_this_server: boolean | null; receipt_pubkey: string; network: string; url: string; can_reorder: boolean;
}

export function proofPageHtml(o: { base: string; brand: string; proof: ProofView | null }): string {
  const p = o.proof;
  if (!p) {
    return shell({
      title: "No such order · IoMarkets", description: "No order settled with that transaction.", base: o.base, path: "/p/", noindex: true,
      body: `<div class="eyebrow">Proof of delivery</div><h1>No order settled with that transaction.</h1><p class="lead">Proof pages exist for every goods order on the <a href="/v1/ledger">public ledger</a>.</p>`,
    });
  }
  const place = regionName(p.country);
  const product = p.type === "esim" ? `${place} eSIM` : p.type === "topup" ? `${place} mobile top-up` : `${place} ${p.type}`;
  const price = Number(p.price_usdc).toFixed(2);
  const secs = p.delivered_in_seconds === undefined ? undefined : p.delivered_in_seconds < 1 ? "under 1s" : `${p.delivered_in_seconds}s`;
  const headline = p.status === "delivered"
    ? `Delivered: ${product}, ${price} USDC${p.delivered_in_seconds !== undefined ? `, in ${secs}` : ""}`
    : p.status === "refunded" ? `Refunded on-chain: ${product}, ${price} USDC` : `In progress: ${product}, ${price} USDC`;
  const tone = p.status === "delivered" ? "ok" : p.status === "refunded" ? "warn" : "bad";
  const shareText = p.status === "delivered"
    ? `${p.type === "esim" ? p.what : `${product} (${p.what})`} bought for ${price} USDC on Algorand via x402. Settled on-chain first, delivered${p.delivered_in_seconds !== undefined ? ` in ${secs}` : ""}, signed receipt:`
    : `A failed delivery refunded itself on-chain. ${product}, ${price} USDC on Algorand:`;
  const body = `
<div class="eyebrow">Proof of delivery · Algorand ${esc(p.network)}</div>
<div class="row"><span class="stamp ${tone}">${esc(p.status)}</span>${p.receipt_signature_valid && p.signed_by_this_server ? '<span class="stamp ok">signed receipt verified</span>' : ""}</div>
<h1>${esc(headline)}</h1>
<p class="lead">Paid in USDC over <a href="https://x402.org">x402</a> with no account, no API key and no card. The money settled on-chain <b>before</b> the goods were bought${p.status === "refunded" ? ", and when delivery failed it went back to the payer automatically" : ""}.</p>

<div class="grid">
  <div class="card">
    <h2>The order</h2>
    <dl class="kv" style="margin-top:.8rem">
      <dt>Product</dt><dd>${esc(p.what)}</dd>
      <dt>Where</dt><dd>${esc(place)} · ${esc(p.brand)}</dd>
      <dt>Paid</dt><dd class="mono">${esc(price)} USDC</dd>
      ${p.delivered_in_seconds !== undefined ? `<dt>Delivered in</dt><dd class="mono">${esc(secs)} after settlement</dd>` : ""}
      <dt>When</dt><dd class="mono">${esc(new Date(p.paid_at).toUTCString().replace(" GMT", " UTC"))}</dd>
      <dt>Payer</dt><dd class="mono">${esc(p.payer.slice(0, 6))}…${esc(p.payer.slice(-6))}</dd>
    </dl>
  </div>
  <div class="card">
    <h2>Check it yourself</h2>
    <dl class="kv" style="margin-top:.8rem">
      <dt>Settlement</dt><dd><a class="mono" href="${esc(p.settlement_url)}" target="_blank" rel="noopener">${esc(p.settlement_txid.slice(0, 14))}…</a></dd>
      ${p.refund_url ? `<dt>Refund</dt><dd><a href="${esc(p.refund_url)}" target="_blank" rel="noopener">on-chain refund</a></dd>` : ""}
      <dt>Receipt</dt><dd>${p.receipt_signature_valid === null ? "not issued yet" : !p.receipt_signature_valid ? "signature did NOT verify" : p.signed_by_this_server ? "ed25519 signature valid, by this server's published key" : "ed25519 signature valid, but NOT by this server's published key"}</dd>
      <dt>Signing key</dt><dd class="mono small">${esc(p.receipt_pubkey.slice(0, 20))}… (<a href="/v1/pubkey">/v1/pubkey</a>)</dd>
    </dl>
    <p class="small muted">The receipt itself stays with the buyer: it names the order id, and the order id is what unlocks the goods. Buyers verify theirs at <a href="/verify">/verify</a>.</p>
  </div>
</div>

<div class="card">
  <h2>${p.can_reorder ? "Want the same eSIM?" : "Let your agent buy real things"}</h2>
  <p>${p.can_reorder
    ? "Get a checkout link for the same package, pay from your own Pera wallet, and the activation code shows on the page. The original buyer earns a share when you do."
    : "Travel eSIMs for 200+ destinations and top-ups in 150+ countries, four HTTP calls, paid per order in USDC on Algorand."}</p>
  <div class="row" style="margin-top:.7rem">
    ${p.can_reorder ? '<button class="btn primary" id="reorder">Get the same eSIM</button>' : '<a class="btn primary" href="/#try">Browse what agents can buy</a>'}
    <a class="btn x" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${esc(encodeURIComponent(shareText))}&amp;url=${esc(encodeURIComponent(p.url))}">Share on X</a>
    <button class="btn" id="copy">Copy link</button>
    <a class="btn" href="/earn">Earn by sharing</a>
  </div>
  <p class="small err" id="msg" role="status" aria-live="polite"></p>
</div>`;
  const script = `
var TX = ${bootJson(p.settlement_txid)}, URL_ = ${bootJson(p.url)};
var $ = function (id) { return document.getElementById(id); };
$("copy").onclick = function () { navigator.clipboard.writeText(URL_).then(function () { $("copy").textContent = "Copied"; }); };
if ($("reorder")) $("reorder").onclick = async function () {
  this.disabled = true;
  try {
    var r = await fetch("/v1/proof/" + TX + "/reorder", { method: "POST" });
    var j = await r.json();
    if (!r.ok) throw new Error(j.error || "could not create a link");
    location.href = "/l/" + j.linkId;
  } catch (e) { $("msg").textContent = String((e && e.message) || e); this.disabled = false; }
};
`;
  return shell({ title: `${headline} · ${o.brand}`, description: shareText.replace(/:$/, "."), base: o.base, path: `/p/${p.settlement_txid}`, body, script });
}

// ── /earn ──────────────────────────────────────────────────────────────────────

export function earnPageHtml(o: { base: string; program: { enabled: boolean; share_of_net_margin_bps?: number; min_payout_usdc?: string } }): string {
  const pr = o.program;
  const pct = pr.share_of_net_margin_bps !== undefined ? `${pr.share_of_net_margin_bps / 100}%` : "";
  const body = `
<div class="eyebrow">Referral programme · paid on-chain in USDC</div>
<h1>Your agent sells eSIMs. You earn USDC.</h1>
<p class="lead">Building on x402? Put <code>"ref": "your Algorand address"</code> on any quote or pay link. When that order is delivered you get ${pr.enabled ? `<b>${esc(pct)} of our net margin</b>` : "a share of our net margin"}, sent to your address on-chain. No signup, no dashboard, no invoice.</p>
${pr.enabled ? "" : '<p class="note">The programme is not switched on yet on this server. Referred orders are not being recorded until it is.</p>'}

<div class="grid">
  <div class="card"><h3>1 · Tag the order</h3><p class="small">Add <code>ref</code> to <code>POST /v1/quote</code>, or create a checkout link with <code>POST /v1/links</code>. The MCP tools take it too.</p></div>
  <div class="card"><h3>2 · It gets delivered</h3><p class="small">Delivered orders only. Refunds and self-referrals earn nothing. The share is of margin, never of price.</p></div>
  <div class="card"><h3>3 · USDC lands on-chain</h3><p class="small">Batched per address${pr.min_payout_usdc ? ` once you are owed ${esc(Number(pr.min_payout_usdc).toFixed(2))} USDC` : ""}. Your address must be opted in to USDC.</p></div>
</div>

<div class="card">
  <h2>Make a share link</h2>
  <p class="small muted">Pick an eSIM, paste your address, get a link anyone can pay from their own wallet. Post it, and every sale through it pays you.</p>
  <div class="grid" style="margin-top:.7rem">
    <div><label for="cc">Destination</label><select id="cc"><option>Loading…</option></select></div>
    <div><label for="offer">Package</label><select id="offer"></select></div>
  </div>
  <div class="grid" style="margin-top:.7rem">
    <div><label for="addr">Your Algorand address</label><input type="text" id="addr" placeholder="58 characters, A–Z and 2–7" autocomplete="off" spellcheck="false"></div>
    <div><label for="note">Note (optional)</label><input type="text" id="note" maxlength="140" placeholder="Heading to Devcon? Sort your data first."></div>
  </div>
  <div class="row" style="margin-top:.8rem"><button class="btn primary" id="make">Create my link</button><span class="small err" id="err" role="status" aria-live="polite"></span></div>
  <div id="made" hidden style="margin-top:.8rem">
    <p><code id="url"></code></p>
    <div class="row"><a class="btn x" id="tw" target="_blank" rel="noopener">Post it on X</a><button class="btn" id="copy">Copy</button><a class="btn" id="open">Open it</a></div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Check your earnings</h2>
    <div class="row" style="margin-top:.6rem"><input type="text" id="look" placeholder="Algorand address" spellcheck="false" style="flex:1;min-width:0"><button class="btn" id="lookgo">Look up</button></div>
    <div id="mine" class="small" style="margin-top:.7rem"></div>
  </div>
  <div class="card">
    <h2>Leaderboard</h2>
    <div class="tw"><table id="board"><tr><th>Referrer</th><th>Orders</th><th>Earned</th></tr></table></div>
    <p class="small muted" id="board-empty">Nobody has earned yet. The first line is yours.</p>
  </div>
</div>

<div class="card">
  <h2>For agents</h2>
<pre style="overflow-x:auto;background:var(--sunk);padding:.8rem;border-radius:10px;font-size:.8rem;margin:.6rem 0 0"><code>curl -X POST ${esc(o.base)}/v1/links -H 'content-type: application/json' \\
  -d '{"type":"esim","offerId":"&lt;from /v1/catalog?type=esim&gt;","ref":"&lt;your address&gt;"}'
# → { "url": "${esc(o.base)}/l/pl_…", "share": { "x": "…" } }</code></pre>
  <p class="small muted" style="margin-top:.5rem">Terms as JSON: <a href="/v1/referrals">/v1/referrals</a> · your numbers: <code>/v1/referrals/&lt;address&gt;</code> · full API: <a href="/agent.md">/agent.md</a></p>
</div>`;
  const script = `
var $ = function (id) { return document.getElementById(id); };
var ADDR = /^[A-Z2-7]{58}$/;
var name = function (cc) { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc; } catch (e) { return cc; } };
var usd = function (s) { return Number(s).toFixed(2) + " USDC"; };
try { var saved = localStorage.getItem("iomarkets.refAddr"); if (saved) { $("addr").value = saved; $("look").value = saved; } } catch (e) {}

async function loadOffers() {
  var sel = $("offer");
  sel.innerHTML = "<option>Loading…</option>";
  var j = await (await fetch("/v1/catalog?type=esim&limit=200&country=" + $("cc").value)).json();
  sel.innerHTML = "";
  (j.offers || []).sort(function (a, b) { return Number(a.price_usdc_from) - Number(b.price_usdc_from); }).forEach(function (o) {
    var opt = document.createElement("option");
    opt.value = o.offerId;
    opt.textContent = o.name + " · " + usd(o.price_usdc_from);
    sel.appendChild(opt);
  });
  if (!sel.options.length) sel.innerHTML = "<option value=''>Nothing sellable here right now</option>";
}

(async function () {
  try {
    var c = await (await fetch("/v1/countries?type=esim")).json();
    var sel = $("cc");
    sel.innerHTML = "";
    var list = (c.countries || []).map(function (x) { return { code: x.code, n: name(x.code) }; }).sort(function (a, b) { return a.n.localeCompare(b.n); });
    if (!list.length) list = ["US", "JP", "GB", "IN", "TR", "AE", "FR", "TH"].map(function (cc) { return { code: cc, n: name(cc) }; });
    list.forEach(function (x) { var o = document.createElement("option"); o.value = x.code; o.textContent = x.n; sel.appendChild(o); });
    sel.value = list.some(function (x) { return x.code === "IN"; }) ? "IN" : list[0].code;
    sel.onchange = loadOffers;
    await loadOffers();
  } catch (e) { $("err").textContent = "Could not load the catalogue."; }
})();

$("make").onclick = async function () {
  $("err").textContent = "";
  var addr = $("addr").value.trim();
  if (!ADDR.test(addr)) { $("err").textContent = "That is not an Algorand address."; return; }
  if (!$("offer").value) { $("err").textContent = "Pick a package."; return; }
  try { localStorage.setItem("iomarkets.refAddr", addr); } catch (e) {}
  this.disabled = true;
  try {
    var body = { type: "esim", offerId: $("offer").value, ref: addr, ttl_hours: 720 };
    if ($("note").value.trim()) body.note = $("note").value.trim();
    var r = await fetch("/v1/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok) throw new Error(j.error || "could not create the link");
    $("url").textContent = j.url; $("tw").href = j.share.x; $("open").href = j.url;
    $("copy").onclick = function () { navigator.clipboard.writeText(j.url).then(function () { $("copy").textContent = "Copied"; }); };
    $("made").hidden = false;
  } catch (e) { $("err").textContent = String((e && e.message) || e); }
  this.disabled = false;
};

$("lookgo").onclick = async function () {
  var a = $("look").value.trim(), out = $("mine");
  if (!ADDR.test(a)) { out.textContent = "That is not an Algorand address."; return; }
  var j = await (await fetch("/v1/referrals/" + a)).json();
  out.textContent = (j.orders_referred || 0) + " referred orders · paid " + usd(j.paid_usdc || 0) + " · owed " + usd(j.owed_usdc || 0) + " · pending delivery " + usd(j.pending_usdc || 0) + (j.note ? " · " + j.note : "");
};

(async function () {
  var j = await (await fetch("/v1/referrals")).json();
  var t = $("board");
  (j.leaderboard || []).forEach(function (r) {
    var tr = document.createElement("tr");
    [r.ref.slice(0, 6) + "…" + r.ref.slice(-4), String(r.orders), usd(r.earned_usdc)].forEach(function (v) { var td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
    t.appendChild(tr);
  });
  $("board-empty").hidden = (j.leaderboard || []).length > 0;
})();
`;
  return shell({
    title: "Earn USDC selling eSIMs from your agent · IoMarkets",
    description: `Tag any x402 order with your Algorand address and earn ${pct ? `${pct} of` : "a share of"} net margin on every delivered eSIM or top-up, paid on-chain in USDC. No signup.`,
    base: o.base, path: "/earn", body, script,
  });
}
