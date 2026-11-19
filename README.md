# 🔭 StockScout

**A pay-per-report research agent for Coinbase tokenized stocks on Base.**
Built for **Base Stocks Maxxing Season — Agentic Stock Finance track**.

- 🌐 Live showcase: https://internpass.github.io/stockscout/
- 📜 FeeSplitter (Base Sepolia, Sourcify exact match): `0x551f5d693Da23430a2dCaEF69D998dd5520D35A8`
  - deploy tx: `0xd8fd9c72edd9dd31d3de9f96ec33377fe30735d58b2188e8059217d0d8bedad0`
  - ops wallet: `0x00202bb9d5905dac371ae16db12ea91d79cda5a0` · allocation vault: `0x2B80663EF06487414893E5B7dd0806262B846F5A`
- 🖥️ The showcase runs on a data snapshot + live in-browser Chainlink reads; the full agent
  server (`node src/server.mjs`) serves live API data and settles over x402.

StockScout sells one thing: trustworthy research on tokenized stocks. Anyone (human or agent)
picks a ticker, pays a **0.10 USDC micropayment over x402**, and receives a research brief whose
price data is **verified twice** — once from the Coinbase Tokenized Stocks API and once from the
Chainlink total-return feed read directly onchain — with explicit staleness and disagreement flags.
Fees are split by a published rule, **30% agent operations / 70% tokenized-stock allocation**,
mirrored onchain by the `FeeSplitter` contract.

## Why this exists

Tokenized stocks trade 24/7 on Base, but their reference feeds run 24/5, hold the last close on
weekends, and freeze during corporate actions. Most dashboards show one number and hide which
source it came from and how old it is. StockScout's whole job is to not do that: every report
shows both sources, their deviation, their timestamps, and a VERIFIED badge only when they agree
inside the feeds' own 0.5% deviation band and are inside the staleness bound.

## How it works

```
GET  /api/stocks               live board (Tokenized Stocks API, paginated)
GET  /api/report/:ticker       free teaser (headline + dual-source price check)
GET  /api/report/:ticker/full  HTTP 402 + x402 payment requirements
POST /api/pay                  settle 0.10 USDC (demo mode on testnet rails — see below)
GET  /api/report/:ticker/full  with X-PAYMENT-ID header -> full brief
GET  /api/ledger               public allocation ledger (30/70 split per payment)
```

Data sources (both live, no API key):
- Tokenized Stocks API — `https://api.coinbase.com/v1/tokenized-stocks`
  (contract, ISIN, multiplier, supply, Chainlink-based `nav_price`)
- Chainlink Coinbase tokenized-equity feeds on Base mainnet, read onchain via
  `latestRoundData()` (addresses in `src/agent.mjs`, from docs.base.org)

## Run it

```bash
node src/server.mjs          # http://localhost:8930
```

No dependencies — Node 20+ standard library only.

## Contracts

`contracts/FeeSplitter.sol` — receives USDC fees and splits them 30/70 between the agent
operations wallet and the tokenized-stock allocation vault. Fixed wallets, no admin
withdrawal path for the allocation share, no upgradeability. Deploy target for the demo:
Base Sepolia (USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).

## Settlement modes

The x402 handshake (402 response, `accepts` requirements, payment proof on retry) is the
real protocol shape. Settlement currently runs in **demo mode on testnet rails**: a payment
record is issued and split in the public ledger. To go live, point the server at an x402
facilitator and verify the `X-PAYMENT` header — amounts, network and the split rule do not change.

## Compliance notes

Research information only — not financial advice, not an offer or solicitation. Tokenized
stocks are available only to persons in eligible jurisdictions outside the U.S. Reference
values are total-return NAVs, not live execution quotes. No token launch; no claim of any
rights in an underlying public company beyond what the B20 asset itself provides.

## License

MIT
