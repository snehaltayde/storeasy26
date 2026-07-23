// Forward-success monitor (Session 15):  pnpm events:stats
import { eventStats } from "../lib/events.js";

const s = await eventStats();
console.log(JSON.stringify(s, null, 2));
if (s.successRate != null && s.successRate < 0.99) {
  console.error(`⚠ forward success rate ${(s.successRate * 100).toFixed(1)}% — inspect recentErrors / dead rows`);
}
process.exit(0);
