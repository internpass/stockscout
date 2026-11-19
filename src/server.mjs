// StockScout server: dashboard + research API + x402 payment gate.
//
// Flow (the demo the judges see):
//   1. GET  /api/stocks                 -> live tokenized-stock board (API + feed status)
//   2. GET  /api/report/:ticker         -> free teaser
//   3. GET  /api/report/:ticker/full    -> HTTP 402 + x402 payment requirements (no payment yet)
//   4. POST /api/pay { ticker, payer }  -> settle the micropayment (see SETTLEMENT MODE below)
//   5. GET  /api/report/:ticker/full with header X-PAYMENT-ID -> full report
//   6. Every settled payment is split by the allocation rule (30% agent operations /
//      70% tokenized-stock allocation) and written to the public ledger: GET /api/ledger
//
// SETTLEMENT MODE: payments settle in DEMO mode on testnet rails — a payment record is
// created and split in the ledger, and the FeeSplitter contract (contracts/FeeSplitter.sol)
// mirrors the same split onchain once deployed to Base Sepolia. To go live, point
// X402_FACILITATOR_URL at an x402 facilitator and verify the X-PAYMENT header instead
// of issuing demo payment ids. The 402 handshake, amounts and split rule do not change.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listStocks, buildReport, teaserOf, FEEDS } from "./agent.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const LEDGER_FILE = path.join(DATA, "ledger.json");

const PORT = process.env.PORT ?? 8930;
const PAY_TO = process.env.SCOUTS_PAY_TO ?? "0x00202bb9d5905dac371ae16db12ea91d79cda5a0"; // agent EOA (testnet work wallet)
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PRICE_USDC = 0.1; // per full report
const SPLIT = { ops: 0.3, allocation: 0.7 };

let stocksCache = null;
let stocksCacheAt = 0;
async function getStocks() {
  if (!stocksCache || Date.now() - stocksCacheAt > 5 * 60 * 1000) {
    stocksCache = await listStocks();
    stocksCacheAt = Date.now();
  }
  return stocksCache;
}

async function readLedger() {
  if (!existsSync(LEDGER_FILE)) return { payments: [], allocations: [] };
  return JSON.parse(await readFile(LEDGER_FILE, "utf8"));
}
async function writeLedger(l) {
  await mkdir(DATA, { recursive: true });
  await writeFile(LEDGER_FILE, JSON.stringify(l, null, 2));
}

function paymentRequirements(ticker) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: String(Math.round(PRICE_USDC * 1e6)),
        resource: `/api/report/${ticker}/full`,
        description: `StockScout full research report — ${ticker} (tokenized stock on Base)`,
        mimeType: "application/json",
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        asset: USDC_BASE_SEPOLIA,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(data);
}

async function bodyJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/api/stocks") {
      const stocks = await getStocks();
      const majors = stocks
        .filter((s) => FEEDS[s.underlying] || s.navPrice != null)
        .sort((a, b) => (b.tokenomicsSort ?? 0) - (a.tokenomicsSort ?? 0));
      return send(res, 200, {
        count: stocks.length,
        withNav: stocks.filter((s) => s.navPrice != null).length,
        stocks: majors.map((s) => ({
          ticker: s.underlying,
          tokenSymbol: s.symbol,
          name: s.name,
          contract: s.contract,
          navPrice: s.navPrice,
          navUpdatedAt: s.navUpdatedAt,
          multiplier: s.multiplier,
          totalSupply: s.totalSupply,
          hasFeed: !!s.feed,
        })),
      });
    }

    const mReport = p.match(/^\/api\/report\/([A-Za-z.]+)$/);
    if (mReport) {
      const report = await buildReport(mReport[1].toUpperCase(), await getStocks());
      return send(res, 200, teaserOf(report));
    }

    const mFull = p.match(/^\/api\/report\/([A-Za-z.]+)\/full$/);
    if (mFull) {
      const ticker = mFull[1].toUpperCase();
      const paymentId = req.headers["x-payment-id"];
      const ledger = await readLedger();
      const paid = paymentId && ledger.payments.find((x) => x.id === paymentId && x.ticker === ticker);
      if (!paid) return send(res, 402, paymentRequirements(ticker));
      const report = await buildReport(ticker, await getStocks());
      return send(res, 200, { ...report, payment: { id: paid.id, amountUsdc: paid.amountUsdc, mode: paid.mode } });
    }

    if (p === "/api/pay" && req.method === "POST") {
      const { ticker, payer } = await bodyJson(req);
      const t = String(ticker ?? "").toUpperCase();
      if (!t) return send(res, 400, { error: "ticker required" });
      const id = "pay_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const payment = {
        id,
        ticker: t,
        payer: payer ?? "demo-payer",
        amountUsdc: PRICE_USDC,
        network: "base-sepolia",
        asset: USDC_BASE_SEPOLIA,
        payTo: PAY_TO,
        mode: "demo-testnet",
        settledAt: new Date().toISOString(),
      };
      const ledger = await readLedger();
      ledger.payments.push(payment);
      ledger.allocations.push({
        paymentId: id,
        ticker: t,
        opsUsdc: +(PRICE_USDC * SPLIT.ops).toFixed(6),
        allocationUsdc: +(PRICE_USDC * SPLIT.allocation).toFixed(6),
        rule: "30% agent operations / 70% tokenized-stock allocation",
        at: payment.settledAt,
      });
      await writeLedger(ledger);
      return send(res, 200, { ok: true, payment });
    }

    if (p === "/api/ledger") {
      const ledger = await readLedger();
      const totals = ledger.allocations.reduce(
        (a, x) => ({ ops: a.ops + x.opsUsdc, allocation: a.allocation + x.allocationUsdc }),
        { ops: 0, allocation: 0 }
      );
      return send(res, 200, { ...ledger, totals, splitRule: SPLIT });
    }

    // static dashboard
    const file = p === "/" ? "index.html" : p.slice(1);
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !existsSync(full)) return send(res, 404, { error: "not found" });
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    return send(res, 200, await readFile(full, "utf8"), type);
  } catch (e) {
    return send(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`StockScout on http://localhost:${PORT}`));
