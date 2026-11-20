const $ = (s) => document.querySelector(s);
let currentTicker = null;
let currentPaymentId = null;
let STATIC = false;
let SNAPSHOT = null;

const FEEDS = {
  AAPL: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  AMZN: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  META: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA: "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
  SPCX: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
};

const DOMAINS = {
  AAPL: "apple.com", AMZN: "amazon.com", ANT: "anthropic.com", CRCL: "circle.com",
  GOOGL: "google.com", INTC: "intel.com", META: "meta.com", MSFT: "microsoft.com",
  MSTR: "microstrategy.com", NVDA: "nvidia.com", SNDK: "sandisk.com",
  SPCX: "spacex.com", TSLA: "tesla.com",
};
const logoUrl = (t) => `logos/${t}.png`;
const logoImg = (t) =>
  `<img class="logo-img" src="${logoUrl(t)}" alt="${t} logo" loading="lazy" onerror="this.onerror=null;this.src='https://icons.duckduckgo.com/ip3/${DOMAINS[t] ?? ""}.ico';this.onerror=()=>this.remove();">`;
const logoTile = (t, cls = "") =>
  `<span class="logo-tile ${cls}"><span class="mono">${t.slice(0, 2)}</span>${logoImg(t)}</span>`;

const fmt = (n, d = 2) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

async function tryFetch(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok && r.status !== 402) throw new Error("HTTP " + r.status);
  return r;
}

async function loadBoard() {
  let stocks;
  try {
    const r = await tryFetch("/api/stocks");
    const j = await r.json();
    stocks = j.stocks;
  } catch {
    STATIC = true;
    const r = await fetch("stocks.json");
    SNAPSHOT = await r.json();
    stocks = SNAPSHOT
      .filter((s) => FEEDS[s.underlying] || s.navPrice != null)
      .map((s) => ({
        ticker: s.underlying, tokenSymbol: s.symbol, name: s.name, contract: s.contract,
        navPrice: s.navPrice, navUpdatedAt: s.navUpdatedAt, multiplier: s.multiplier,
        totalSupply: s.totalSupply, hasFeed: !!s.feed,
      }));
    document.querySelector(".tag").textContent += " · public showcase (snapshot data, live onchain feed checks)";
  }
  ALL_STOCKS = stocks.filter((s) => s.navPrice != null).slice(0, 24);
  renderBoard();
}

let ALL_STOCKS = [];

function renderBoard() {
  const el = $("#board");
  const q = ($("#searchBox")?.value ?? "").trim().toLowerCase();
  const sort = $("#sortSel")?.value ?? "price-desc";
  let shown = ALL_STOCKS.filter((s) => !q || s.ticker.toLowerCase().includes(q) || (s.name ?? "").toLowerCase().includes(q));
  shown = shown.slice().sort((a, b) =>
    sort === "price-asc" ? a.navPrice - b.navPrice :
    sort === "name" ? a.ticker.localeCompare(b.ticker) :
    sort === "supply" ? (b.totalSupply ?? 0) - (a.totalSupply ?? 0) :
    b.navPrice - a.navPrice);
  el.innerHTML = "";
  for (const s of shown) {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `
      <div class="card-top">${logoTile(s.ticker)}
        <div class="card-id"><div class="sym">${s.ticker}</div><div class="tsym">${s.tokenSymbol}</div></div>
        <span class="pill ${s.hasFeed ? "pill-feed" : "pill-api"}">${s.hasFeed ? "Chainlink" : "API NAV"}</span>
      </div>
      <div class="name">${s.name}</div>
      <div class="price">$${fmt(s.navPrice)}</div>
      <div class="meta"><span>Supply ${fmt(s.totalSupply, 0)} tokens</span><span>Multiplier ×${fmt(s.multiplier, 4)}</span></div>
      <div class="card-cta">Open research report <span aria-hidden="true">→</span></div>`;
    card.onclick = () => openReport(s.ticker);
    el.appendChild(card);
  }
  const cnt = $("#boardCount");
  if (cnt) cnt.textContent = `${shown.length} of ${ALL_STOCKS.length} listed`;
  if (!shown.length) el.innerHTML = `<p class="muted">${ALL_STOCKS.length ? "No ticker matches your search." : "No NAV data right now — feeds hold the last close outside market hours."}</p>`;
}

// ---- static-mode report engine (mirrors src/agent.mjs) ----
async function readFeed(addr) {
  const r = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: addr, data: "0xfeaf968c" }, "latest"] }),
  });
  const j = await r.json();
  const h = j.result.slice(2);
  const word = (i) => BigInt("0x" + h.slice(i * 64, i * 64 + 64));
  let ans = word(1);
  if (ans >= 2n ** 255n) ans -= 2n ** 256n;
  return { price: Number(ans) / 1e8, updatedAt: Number(word(3)) };
}

function staticReport(stock, feed) {
  const now = Math.floor(Date.now() / 1000);
  const stale = (ts) => ts != null && now - ts > 26 * 3600;
  const apiTs = stock.navUpdatedAt ? Math.floor(Date.parse(stock.navUpdatedAt) / 1000) : null;
  const deviation = feed && stock.navPrice ? Math.abs(feed.price - stock.navPrice) / stock.navPrice : null;
  const verified = !!feed && !!stock.navPrice && deviation <= 0.005 && !stale(feed.updatedAt) && !stale(apiTs);
  const shareEq = stock.totalSupply != null ? stock.totalSupply * stock.multiplier : null;
  const navCap = shareEq != null && stock.navPrice ? shareEq * stock.navPrice : null;
  const flags = [];
  if (!feed) flags.push("Chainlink feed unavailable or not listed for this ticker — API NAV only.");
  if (feed && stale(feed.updatedAt)) flags.push("Chainlink feed is STALE (older than its 24h heartbeat bound).");
  if (stale(apiTs)) flags.push("API NAV timestamp is stale — treat the reference value with caution.");
  if (deviation != null && deviation > 0.005) flags.push(`Sources DISAGREE by ${(deviation * 100).toFixed(2)}%.`);
  if (stock.multiplier !== 1) flags.push(`Multiplier is ${stock.multiplier.toFixed(6)} (corporate actions are reflected in the multiplier, not the balance).`);
  const brief = [
    `${stock.name} (${stock.underlying}) trades on Base as the B20 token ${stock.symbol} (${stock.contract}).`,
    stock.navPrice ? `Reference value: $${fmt(stock.navPrice)} per share (total-return, Chainlink-based NAV, updated ${stock.navUpdatedAt ?? "n/a"}).` : "No NAV published for this ticker yet.",
    feed ? `Onchain cross-check: the Chainlink feed reads $${fmt(feed.price)} — ${verified ? "in agreement with the API NAV inside the 0.5% deviation band, and fresh." : "see flags below before relying on it."}` : "No onchain cross-check available for this ticker.",
    shareEq != null ? `Onchain float: ${fmt(shareEq, 4)} share-equivalents (${fmt(stock.totalSupply, 4)} tokens × ${fmt(stock.multiplier, 6)} multiplier), an NAV cap of about $${fmt(navCap, 0)}.` : "No minted supply reported yet.",
    "How to read this: the token trades 24/7 on Base DEXs, but its reference feed runs 24/5 and holds the last close on weekends/holidays and during corporate actions.",
    "Key risks: feed staleness outside market hours, thin secondary liquidity on smaller tickers, multiplier changes from corporate actions, and eligibility restrictions (non-U.S. persons in eligible jurisdictions only).",
  ];
  return {
    ticker: stock.underlying, tokenSymbol: stock.symbol, name: stock.name, contract: stock.contract,
    isin: stock.isin, generatedAt: new Date().toISOString(),
    price: { apiNav: stock.navPrice, chainlink: feed ? feed.price : null, deviationPct: deviation != null ? deviation * 100 : null, verified },
    brief, flags,
    disclaimer: "Research information only — not financial advice. Tokenized stocks are available only to persons in eligible jurisdictions outside the U.S. (Showcase build: data snapshot + live onchain feed read; payments simulated — the agent server settles over x402 on Base Sepolia.)",
  };
}

function verifyGrid(p) {
  const dev = p.deviationPct == null ? "—" : fmt(p.deviationPct, 3) + "%";
  return `<div class="verify-grid">
    <div class="vbox"><div class="vlabel">Tokenized Stocks API</div><div class="vprice">$${fmt(p.apiNav)}</div><div class="vsub">Reference NAV</div></div>
    <div class="vmid"><div class="vbadge ${p.verified ? "ok" : "warn"}">${p.verified ? "✓ VERIFIED" : "! CHECK FLAGS"}</div><div class="vdev">deviation ${dev}</div></div>
    <div class="vbox"><div class="vlabel">Chainlink · read onchain</div><div class="vprice">$${fmt(p.chainlink)}</div><div class="vsub">Total-return feed, Base mainnet</div></div>
  </div>`;
}

let staticCurrentReport = null;

async function openReport(ticker) {
  currentTicker = ticker;
  currentPaymentId = null;
  staticCurrentReport = null;
  $("#reportPanel").hidden = false;
  $("#reportTitle").textContent = `Research — ${ticker}`;
  $("#full").innerHTML = "";
  $("#payStatus").textContent = "";
  if (!STATIC) {
    const r = await fetch(`/api/report/${ticker}`);
    const t = await r.json();
    $("#teaser").innerHTML = `
      <div class="rep-head">${logoTile(ticker, "lg")}<p class="rep-lede">${t.headline}</p></div>
      ${verifyGrid(t.price)}
      <p class="muted">Locked in the full report: ${t.locked.join(" · ")}</p>`;
  } else {
    const stock = SNAPSHOT.find((s) => s.underlying === ticker);
    let feed = null;
    if (FEEDS[ticker]) { try { feed = await readFeed(FEEDS[ticker]); } catch { feed = null; } }
    staticCurrentReport = staticReport(stock, feed);
    const t = staticCurrentReport;
    $("#teaser").innerHTML = `
      <div class="rep-head">${logoTile(ticker, "lg")}<p class="rep-lede">${t.brief[0]}</p></div>
      ${verifyGrid(t.price)}
      <p class="muted">Locked in the full report: Full research brief · Onchain float & NAV-cap analysis · Risk flags & staleness audit</p>`;
  }
  $("#reportPanel").scrollIntoView({ behavior: "smooth" });
}

function renderFull(rep) {
  $("#full").innerHTML = `
    <div class="rep-head">${logoTile(rep.ticker, "lg")}<h3>${rep.name} (${rep.ticker}) — full brief</h3></div>
    ${rep.brief.map((l) => `<p>${l}</p>`).join("")}
    <h4>Risk & data-quality flags</h4>
    ${rep.flags.length ? `<ul>${rep.flags.map((f) => `<li>${f}</li>`).join("")}</ul>` : "<p>None — both sources agree and are fresh.</p>"}
    <p class="muted">Contract ${rep.contract} · ISIN ${rep.isin ?? "—"} · Generated ${rep.generatedAt}</p>
    <p class="muted">${rep.disclaimer}</p>`;
}

$("#payBtn").onclick = async () => {
  if (!currentTicker) return;
  if (STATIC) {
    $("#payStatus").textContent = "402 Payment Required — 0.10 USDC on base-sepolia. Settling (showcase simulation)…";
    await new Promise((r) => setTimeout(r, 600));
    const led = JSON.parse(localStorage.getItem("scout-ledger") ?? "[]");
    led.push({ ticker: currentTicker, opsUsdc: 0.03, allocationUsdc: 0.07, at: new Date().toISOString() });
    localStorage.setItem("scout-ledger", JSON.stringify(led));
    $("#payStatus").textContent = "Paid 0.1 USDC (showcase simulation) · split 30% ops / 70% stock allocation.";
    renderFull(staticCurrentReport);
    loadLedger();
    return;
  }
  $("#payStatus").textContent = "Contacting the agent…";
  const first = await fetch(`/api/report/${currentTicker}/full`);
  if (first.status !== 402) { $("#payStatus").textContent = "Unexpected response."; return; }
  const req = await first.json();
  const a = req.accepts[0];
  $("#payStatus").textContent = `402 Payment Required — ${Number(a.maxAmountRequired) / 1e6} USDC on ${a.network}. Settling (demo)…`;
  const pay = await fetch("/api/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker: currentTicker, payer: "dashboard-demo" }),
  });
  const pj = await pay.json();
  currentPaymentId = pj.payment.id;
  const full = await fetch(`/api/report/${currentTicker}/full`, { headers: { "X-PAYMENT-ID": currentPaymentId } });
  const rep = await full.json();
  $("#payStatus").textContent = `Paid ${pj.payment.amountUsdc} USDC (demo-testnet) · split 30% ops / 70% stock allocation.`;
  renderFull(rep);
  loadLedger();
};

async function loadLedger() {
  if (STATIC) {
    const led = JSON.parse(localStorage.getItem("scout-ledger") ?? "[]");
    if (!led.length) { $("#ledger").textContent = "No payments yet."; return; }
    const alloc = led.reduce((a, x) => a + x.allocationUsdc, 0);
    const ops = led.reduce((a, x) => a + x.opsUsdc, 0);
    $("#ledger").innerHTML =
      `<p>Total allocated to tokenized stocks: <b>$${fmt(alloc, 3)}</b> · operations: <b>$${fmt(ops, 3)}</b> <span class="muted">(this browser, showcase mode)</span></p>` +
      led.slice().reverse().map((a) =>
        `<div class="led">📄 ${a.ticker} report — fee split: $${fmt(a.allocationUsdc, 3)} → stock allocation, $${fmt(a.opsUsdc, 3)} → ops <span class="muted">${a.at}</span></div>`
      ).join("");
    return;
  }
  const r = await fetch("/api/ledger");
  const j = await r.json();
  if (!j.payments.length) { $("#ledger").textContent = "No payments yet."; return; }
  $("#ledger").innerHTML =
    `<p>Total allocated to tokenized stocks: <b>$${fmt(j.totals.allocation, 3)}</b> · operations: <b>$${fmt(j.totals.ops, 3)}</b></p>` +
    j.allocations.slice().reverse().map((a) =>
      `<div class="led">📄 ${a.ticker} report — fee split: $${fmt(a.allocationUsdc, 3)} → stock allocation, $${fmt(a.opsUsdc, 3)} → ops <span class="muted">${a.at}</span></div>`
    ).join("");
}

$("#searchBox")?.addEventListener("input", renderBoard);
$("#sortSel")?.addEventListener("change", renderBoard);

loadBoard();
loadLedger();
