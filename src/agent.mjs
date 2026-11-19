// StockScout agent core: dual-source verified research for Coinbase tokenized stocks on Base.
//
// Data layer (both sources live, cross-checked on every report):
//  1. Tokenized Stocks API (Coinbase, no key): https://api.coinbase.com/v1/tokenized-stocks
//     -> contract address, name, ISIN, multiplier, total supply, nav_price (Chainlink-based NAV).
//  2. Chainlink total-return feeds on Base mainnet, read onchain via eth_call latestRoundData().
//     -> independent onchain reference price + updatedAt for staleness checks.
//
// A report is only marked VERIFIED when both sources agree within tolerance and the
// feed is inside its staleness bound. Stale or disagreeing data is flagged, never hidden.

export const API_BASE = "https://api.coinbase.com/v1/tokenized-stocks";
export const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
];

// Chainlink Coinbase tokenized-equity feeds on Base mainnet (docs.base.org, verified 2026-11-20).
// All feeds: 8 decimals, total-return values, 0.5% deviation / 24h heartbeat, 24/5 market hours.
export const FEEDS = {
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

const LATEST_ROUND_DATA = "0xfeaf968c"; // latestRoundData()
export const STALE_AFTER_SEC = 26 * 3600; // 24h heartbeat + 2h grace
export const AGREE_TOLERANCE = 0.005; // 0.5% — matches the feeds' deviation threshold

async function fetchJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "stockscout/0.1" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Fetch the full tokenized-stock list from the Coinbase API (paginated). */
export async function listStocks() {
  const out = [];
  let pageToken = null;
  do {
    const u = new URL(API_BASE);
    u.searchParams.set("page_size", "500");
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const page = await fetchJson(u.toString());
    for (const t of page.tokens ?? []) out.push(normalizeToken(t));
    pageToken = page.next_page_token ?? null;
  } while (pageToken);
  return out;
}

function normalizeToken(t) {
  const symbol = String(t.symbol ?? "");
  const underlying = symbol.endsWith("c") ? symbol.slice(0, -1) : symbol;
  return {
    symbol, // e.g. NVDAc
    underlying, // e.g. NVDA
    name: t.name ?? "",
    contract: t.contract_address ?? "",
    isin: t.isin ?? null,
    decimals: t.decimals ?? 18,
    multiplier: t.multiplier != null ? Number(t.multiplier) : 1,
    totalSupply: t.total_supply != null ? Number(t.total_supply) : null,
    navPrice: t.nav_price != null ? Number(t.nav_price) : null,
    navUpdatedAt: t.nav_price_updated_at ?? null,
    description: t.description ?? "",
    feed: FEEDS[underlying] ?? null,
  };
}

async function rpcCall(method, params) {
  let lastErr;
  for (const rpc of BASE_RPCS) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "stockscout/0.1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all Base RPCs failed");
}

/** Read a Chainlink feed's latestRoundData() onchain. Returns { price, updatedAt, roundId }. */
export async function readFeed(feedAddress) {
  const hex = await rpcCall("eth_call", [{ to: feedAddress, data: LATEST_ROUND_DATA }, "latest"]);
  const h = hex.slice(2);
  const word = (i) => BigInt("0x" + h.slice(i * 64, i * 64 + 64));
  let answer = word(1);
  if (answer >= 2n ** 255n) answer -= 2n ** 256n; // int256
  return {
    price: Number(answer) / 1e8,
    updatedAt: Number(word(3)),
    roundId: word(0).toString(),
  };
}

function freshness(updatedAtSec, nowSec) {
  const age = nowSec - updatedAtSec;
  return { ageSec: age, stale: age > STALE_AFTER_SEC };
}

/**
 * Build a research report for one underlying ticker (e.g. "NVDA").
 * Teaser fields are free; the full brief is what the x402 gate sells.
 */
export async function buildReport(underlying, stocksCache = null) {
  const stocks = stocksCache ?? (await listStocks());
  const stock = stocks.find((s) => s.underlying === underlying.toUpperCase());
  if (!stock) throw new Error(`unknown ticker: ${underlying}`);

  const nowSec = Math.floor(Date.now() / 1000);
  let feed = null;
  if (stock.feed) {
    try {
      feed = await readFeed(stock.feed);
    } catch {
      feed = null; // flagged in the report, not hidden
    }
  }

  const apiAge = stock.navUpdatedAt ? freshness(Math.floor(Date.parse(stock.navUpdatedAt) / 1000), nowSec) : null;
  const feedAge = feed ? freshness(feed.updatedAt, nowSec) : null;

  let deviation = null;
  if (feed && stock.navPrice) deviation = Math.abs(feed.price - stock.navPrice) / stock.navPrice;

  const verified =
    !!feed && !!stock.navPrice && deviation <= AGREE_TOLERANCE && !feedAge.stale && !apiAge?.stale;

  const shareEquivSupply =
    stock.totalSupply != null ? stock.totalSupply * stock.multiplier : null;
  const navCap =
    shareEquivSupply != null && stock.navPrice ? shareEquivSupply * stock.navPrice : null;

  const flags = [];
  if (!feed) flags.push("Chainlink feed unavailable or not listed for this ticker — API NAV only.");
  if (feedAge?.stale) flags.push("Chainlink feed is STALE (older than its 24h heartbeat bound) — price may be a held close or frozen for a corporate action.");
  if (apiAge?.stale) flags.push("API NAV timestamp is stale — treat the reference value with caution.");
  if (deviation != null && deviation > AGREE_TOLERANCE) flags.push(`Sources DISAGREE by ${(deviation * 100).toFixed(2)}% — above the 0.5% feed deviation threshold.`);
  if (stock.multiplier !== 1) flags.push(`Multiplier is ${stock.multiplier.toFixed(6)} (corporate actions such as dividends/splits are reflected in the multiplier, not the balance).`);
  if (stock.totalSupply == null) flags.push("No minted supply reported yet — secondary liquidity may not exist.");

  return {
    ticker: stock.underlying,
    tokenSymbol: stock.symbol,
    name: stock.name,
    contract: stock.contract,
    isin: stock.isin,
    generatedAt: new Date().toISOString(),
    price: {
      apiNav: stock.navPrice,
      apiNavUpdatedAt: stock.navUpdatedAt,
      chainlink: feed ? feed.price : null,
      chainlinkUpdatedAt: feed ? new Date(feed.updatedAt * 1000).toISOString() : null,
      deviationPct: deviation != null ? deviation * 100 : null,
      verified,
    },
    tokenomics: {
      totalSupplyTokens: stock.totalSupply,
      multiplier: stock.multiplier,
      shareEquivalentSupply: shareEquivSupply,
      navCapUsd: navCap,
    },
    flags,
    brief: makeBrief(stock, { feed, verified, deviation, navCap, shareEquivSupply }),
    disclaimer:
      "Research information only — not financial advice, not an offer or solicitation. Tokenized stocks are available only to persons in eligible jurisdictions outside the U.S. Prices are total-return reference values (24/5 feeds), not live execution quotes.",
  };
}

function fmt(n, d = 2) {
  return n == null ? "n/a" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

function makeBrief(stock, ctx) {
  const lines = [];
  lines.push(`${stock.name} (${stock.underlying}) trades on Base as the B20 token ${stock.symbol} (${stock.contract}).`);
  if (stock.navPrice) {
    lines.push(
      `Reference value: $${fmt(stock.navPrice)} per share (total-return, Chainlink-based NAV, updated ${stock.navUpdatedAt ?? "n/a"}).`
    );
  }
  if (ctx.feed) {
    lines.push(
      `Onchain cross-check: the Chainlink feed reads $${fmt(ctx.feed.price)} — ${ctx.verified ? "in agreement with the API NAV inside the 0.5% deviation band, and fresh." : "see flags below before relying on it."}`
    );
  }
  if (ctx.shareEquivSupply != null) {
    lines.push(
      `Onchain float: ${fmt(ctx.shareEquivSupply, 4)} share-equivalents (${fmt(stock.totalSupply, 4)} tokens × ${fmt(stock.multiplier, 6)} multiplier), an NAV cap of about $${fmt(ctx.navCap, 0)}.`
    );
  }
  lines.push(
    "How to read this: the token trades 24/7 on Base DEXs, but its reference feed runs 24/5 and holds the last close on weekends/holidays and during corporate actions. A DEX price away from the reference value is a premium/discount to NAV, not a new fundamental price."
  );
  lines.push(
    "Key risks: feed staleness outside market hours, thin secondary liquidity on smaller tickers, multiplier changes from corporate actions, and eligibility restrictions (non-U.S. persons in eligible jurisdictions only)."
  );
  return lines;
}

/** Split a full report into the free teaser and the paid full version. */
export function teaserOf(report) {
  return {
    ticker: report.ticker,
    tokenSymbol: report.tokenSymbol,
    name: report.name,
    contract: report.contract,
    generatedAt: report.generatedAt,
    price: report.price,
    headline: report.brief[0],
    locked: ["Full research brief", "Onchain float & NAV-cap analysis", "Risk flags & staleness audit"],
    priceUsdc: 0.1,
    disclaimer: report.disclaimer,
  };
}
