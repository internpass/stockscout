const $ = (s) => document.querySelector(s);
let currentTicker = null;
let currentPaymentId = null;

const fmt = (n, d = 2) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

async function loadBoard() {
  const r = await fetch("/api/stocks");
  const j = await r.json();
  const el = $("#board");
  el.innerHTML = "";
  const shown = j.stocks.filter((s) => s.navPrice != null).slice(0, 24);
  for (const s of shown) {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `<div class="sym">${s.ticker} <span class="muted">${s.tokenSymbol}</span></div>
      <div class="name">${s.name}</div>
      <div class="price">$${fmt(s.navPrice)}</div>
      <div class="meta">${s.hasFeed ? "⛓ Chainlink feed" : "API NAV"} · supply ${fmt(s.totalSupply, 0)} · ×${fmt(s.multiplier, 4)}</div>`;
    card.onclick = () => openReport(s.ticker);
    el.appendChild(card);
  }
  if (!shown.length) el.textContent = "No NAV data right now — feeds hold the last close outside market hours.";
}

async function openReport(ticker) {
  currentTicker = ticker;
  currentPaymentId = null;
  $("#reportPanel").hidden = false;
  $("#reportTitle").textContent = `Research — ${ticker}`;
  $("#full").innerHTML = "";
  $("#payStatus").textContent = "";
  const r = await fetch(`/api/report/${ticker}`);
  const t = await r.json();
  $("#teaser").innerHTML = `
    <p>${t.headline}</p>
    <p>Reference value: <b>$${fmt(t.price.apiNav)}</b> · Chainlink onchain: <b>$${fmt(t.price.chainlink)}</b> ·
    deviation ${t.price.deviationPct == null ? "—" : fmt(t.price.deviationPct, 3) + "%"} ·
    ${t.price.verified ? "✅ dual-source verified & fresh" : "⚠️ check flags in the full report"}</p>
    <p class="muted">Locked in the full report: ${t.locked.join(" · ")}</p>`;
  $("#reportPanel").scrollIntoView({ behavior: "smooth" });
}

$("#payBtn").onclick = async () => {
  if (!currentTicker) return;
  $("#payStatus").textContent = "Contacting the agent…";
  // Step 1: ask for the full report -> expect HTTP 402 with x402 requirements
  const first = await fetch(`/api/report/${currentTicker}/full`);
  if (first.status !== 402) { $("#payStatus").textContent = "Unexpected response."; return; }
  const req = await first.json();
  const a = req.accepts[0];
  $("#payStatus").textContent = `402 Payment Required — ${Number(a.maxAmountRequired) / 1e6} USDC on ${a.network}. Settling (demo)…`;
  // Step 2: settle (demo mode on testnet rails)
  const pay = await fetch("/api/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker: currentTicker, payer: "dashboard-demo" }),
  });
  const pj = await pay.json();
  currentPaymentId = pj.payment.id;
  // Step 3: retry with the payment proof
  const full = await fetch(`/api/report/${currentTicker}/full`, { headers: { "X-PAYMENT-ID": currentPaymentId } });
  const rep = await full.json();
  $("#payStatus").textContent = `Paid ${pj.payment.amountUsdc} USDC (demo-testnet) · split 30% ops / 70% stock allocation.`;
  $("#full").innerHTML = `
    <h3>${rep.name} (${rep.ticker}) — full brief</h3>
    ${rep.brief.map((l) => `<p>${l}</p>`).join("")}
    <h4>Risk & data-quality flags</h4>
    ${rep.flags.length ? `<ul>${rep.flags.map((f) => `<li>${f}</li>`).join("")}</ul>` : "<p>None — both sources agree and are fresh.</p>"}
    <p class="muted">Contract ${rep.contract} · ISIN ${rep.isin ?? "—"} · Generated ${rep.generatedAt}</p>
    <p class="muted">${rep.disclaimer}</p>`;
  loadLedger();
};

async function loadLedger() {
  const r = await fetch("/api/ledger");
  const j = await r.json();
  if (!j.payments.length) { $("#ledger").textContent = "No payments yet."; return; }
  $("#ledger").innerHTML =
    `<p>Total allocated to tokenized stocks: <b>$${fmt(j.totals.allocation, 3)}</b> · operations: <b>$${fmt(j.totals.ops, 3)}</b></p>` +
    j.allocations.slice().reverse().map((a) =>
      `<div class="led">📄 ${a.ticker} report — fee split: $${fmt(a.allocationUsdc, 3)} → stock allocation, $${fmt(a.opsUsdc, 3)} → ops <span class="muted">${a.at}</span></div>`
    ).join("");
}

loadBoard();
loadLedger();
