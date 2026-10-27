// Sync the catalog: Shopify → Turso → Typesense. Thin wrapper (Session 21)
// around lib/sync.js — with no tenant context this syncs the DEFAULT tenant
// from env (.env.local), exactly the pre-platform behavior.
//   pnpm sync               # full pull + DB write + search index
//   pnpm sync:search        # reindex Typesense from the local DB
// Per-tenant syncs: pnpm tenant:sync <slug>
import { runCatalogSync } from "../lib/sync.js";
import { libsql } from "../lib/db.js";
import { loadMigrations, runMigrations } from "../lib/platform/migrate.js";

const SEARCH_ONLY = process.argv.includes("--search-only");

let lastInline = false;
const log = (msg, inline = false) => {
  if (inline) {
    process.stdout.write(`\r${msg}`);
    lastInline = true;
    return;
  }
  if (lastInline) process.stdout.write("\n");
  lastInline = false;
  console.log(msg);
};

try {
  // S30: the versioned ledger replaces the raw schema apply (sync_runs etc.)
  await runMigrations(libsql, await loadMigrations("tenant"));
  const res = await runCatalogSync({ searchOnly: SEARCH_ONLY, log });
  if (lastInline) process.stdout.write("\n");
  if (res.search?.error) console.warn(`! search index degraded: ${res.search.error}`);
  console.log("✓ sync complete");
  process.exit(0);
} catch (err) {
  console.error("\n✗ sync failed:", err.message);
  process.exit(1);
}
