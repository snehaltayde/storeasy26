// Sync the catalog: Shopify → Turso → Typesense. Thin wrapper (Session 21)
// around lib/sync.js — with no tenant context this syncs the DEFAULT tenant
// from env (.env.local), exactly the pre-platform behavior.
//   pnpm sync               # full pull + DB write + search index
//   pnpm sync:search        # reindex Typesense from the local DB
// Per-tenant syncs: pnpm tenant:sync <slug>
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCatalogSync } from "../lib/sync.js";

const here = dirname(fileURLToPath(import.meta.url));
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
  const schemaSql = await readFile(join(here, "../lib/schema.sql"), "utf8");
  const res = await runCatalogSync({ searchOnly: SEARCH_ONLY, log, schemaSql });
  if (lastInline) process.stdout.write("\n");
  if (res.search?.error) console.warn(`! search index degraded: ${res.search.error}`);
  console.log("✓ sync complete");
  process.exit(0);
} catch (err) {
  console.error("\n✗ sync failed:", err.message);
  process.exit(1);
}
