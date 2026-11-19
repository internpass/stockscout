// Build the public showcase: snapshot live stock data + copy the dashboard into docs/
// (GitHub Pages serves docs/). Run: node scripts/snapshot.mjs
import { listStocks } from "../src/agent.mjs";
import { cp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stocks = await listStocks();
await mkdir(path.join(ROOT, "docs"), { recursive: true });
await cp(path.join(ROOT, "public"), path.join(ROOT, "docs"), { recursive: true });
await writeFile(path.join(ROOT, "docs", "stocks.json"), JSON.stringify(stocks, null, 2));
await writeFile(path.join(ROOT, "docs", ".nojekyll"), "");
console.log(`snapshot: ${stocks.length} tokens, ${stocks.filter((s) => s.navPrice != null).length} with NAV -> docs/`);
