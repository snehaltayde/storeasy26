// Search analytics report (Session 16):  pnpm search:report [days]
// Reads the first-party events store: top queries, no-result queries, and
// click-through rate (select_item clicks / searches) per query.
// Note: consent-gated data — only consenting sessions are counted.
import { db } from "../lib/db.js";

const days = Number(process.argv[2] || 30);
const since = new Date(Date.now() - days * 864e5).toISOString();

const rows = await db
  .selectFrom("events")
  .select(["name", "payload", "created_at"])
  .where("name", "in", ["search", "select_item"])
  .where("created_at", ">=", since)
  .execute();

const stats = new Map(); // term → { searches, zero, clicks, results }
const norm = (t) => String(t || "").trim().toLowerCase();
for (const r of rows) {
  let p = {};
  try {
    p = JSON.parse(r.payload || "{}");
  } catch {
    continue;
  }
  const term = norm(p.params?.search_term);
  if (!term) continue;
  const s = stats.get(term) || { searches: 0, zero: 0, clicks: 0, lastResults: null };
  if (r.name === "search") {
    s.searches++;
    const n = Number(p.params?.results ?? NaN);
    if (!Number.isNaN(n)) {
      s.lastResults = n;
      if (n === 0) s.zero++;
    }
  } else {
    s.clicks++;
  }
  stats.set(term, s);
}

const list = [...stats.entries()].map(([term, s]) => ({
  term,
  searches: s.searches,
  clicks: s.clicks,
  ctr: s.searches ? Number((s.clicks / s.searches).toFixed(2)) : null,
  zeroResultSearches: s.zero,
  lastResults: s.lastResults,
}));

const top = [...list].sort((a, b) => b.searches - a.searches).slice(0, 20);
const noResults = list.filter((l) => l.zeroResultSearches > 0).sort((a, b) => b.zeroResultSearches - a.zeroResultSearches);

console.log(JSON.stringify({ windowDays: days, totalQueries: rows.filter((r) => r.name === "search").length, distinctTerms: stats.size, topQueries: top, noResultQueries: noResults }, null, 2));
process.exit(0);
