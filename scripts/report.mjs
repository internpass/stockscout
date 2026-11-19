// CLI: node scripts/report.mjs NVDA  -> prints the full research report as JSON.
import { buildReport } from "../src/agent.mjs";
const ticker = (process.argv[2] ?? "NVDA").toUpperCase();
console.log(JSON.stringify(await buildReport(ticker), null, 2));
