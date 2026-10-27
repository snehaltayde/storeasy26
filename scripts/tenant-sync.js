// Full catalog sync for ONE tenant (Session 21):  pnpm tenant:sync <slug>
import { getTenant } from "../lib/platform/control.js";
import { syncTenantCatalog } from "../lib/sync.js";
import { libsql } from "../lib/db.js";
import { withTenant } from "../lib/tenant-context.js";
import { loadMigrations, runMigrations } from "../lib/platform/migrate.js";

const slug = process.argv[2];
if (!slug) {
  console.error("usage: pnpm tenant:sync <slug>");
  process.exit(1);
}
const tenant = await getTenant(slug);
if (!tenant) {
  console.error(`✗ tenant "${slug}" not found in the control plane`);
  process.exit(1);
}

const log = (msg, inline = false) => (inline ? process.stdout.write(`\r${msg}`) : console.log(msg));

try {
  // S30: bring the tenant DB up to the migration ledger before syncing
  await withTenant(tenant, async () => runMigrations(libsql, await loadMigrations("tenant")));
  const res = await syncTenantCatalog(tenant, { log });
  process.stdout.write("\n");
  console.log(`✓ tenant "${slug}": ${res.products} products, ${res.collections} collections` + (res.search?.error ? ` (search degraded: ${res.search.error.slice(0, 60)})` : ` (search indexed: ${res.search.indexed})`));
  process.exit(0);
} catch (e) {
  console.error(`\n✗ tenant sync failed: ${e.message}`);
  process.exit(1);
}
