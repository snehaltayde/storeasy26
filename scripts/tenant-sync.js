// Full catalog sync for ONE tenant (Session 21):  pnpm tenant:sync <slug>
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getTenant } from "../lib/platform/control.js";
import { syncTenantCatalog } from "../lib/sync.js";

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

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = await readFile(join(here, "../lib/schema.sql"), "utf8");
const log = (msg, inline = false) => (inline ? process.stdout.write(`\r${msg}`) : console.log(msg));

try {
  const res = await syncTenantCatalog(tenant, { log, schemaSql });
  process.stdout.write("\n");
  console.log(`✓ tenant "${slug}": ${res.products} products, ${res.collections} collections` + (res.search?.error ? ` (search degraded: ${res.search.error.slice(0, 60)})` : ` (search indexed: ${res.search.indexed})`));
  process.exit(0);
} catch (e) {
  console.error(`\n✗ tenant sync failed: ${e.message}`);
  process.exit(1);
}
