// Run the tenant-track migrations on registered tenant databases (S28 / BE17).
//   pnpm tenant:migrate -- --all            # every tenant, failure-isolated
//   pnpm tenant:migrate -- --tenant demo    # one tenant
// One tenant's failure never stops the others; the summary names failures and
// the exit code reflects them. Suspended tenants are migrated too (their data
// must stay schema-current for reactivation).
import { createClient } from "@libsql/client";
import { listTenants, getTenant } from "../lib/platform/control.js";
import { loadMigrations, runMigrations } from "../lib/platform/migrate.js";
import { audit } from "../lib/platform/audit.js";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const one = flag("tenant");
const all = process.argv.includes("--all");

if (!one && !all) {
  console.error("Usage: pnpm tenant:migrate -- (--all | --tenant <slug>)");
  process.exit(1);
}

const migrations = await loadMigrations("tenant");
const targets = one ? [{ id: one }] : await listTenants();
let failures = 0;

for (const row of targets) {
  try {
    const tenant = await getTenant(row.id);
    if (!tenant) throw new Error("not found in the control plane");
    const client = createClient({ url: tenant.dbUrl, authToken: tenant.dbToken || undefined });
    const r = await runMigrations(client, migrations);
    console.log(`✓ ${tenant.id}: ${r.applied.length} applied (${r.applied.join(", ") || "none"}), ${r.skipped} recorded`);
    if (r.applied.length) {
      await audit({
        actor: { kind: "cli", id: "cli" },
        action: "tenant.migrate",
        tenantId: tenant.id,
        diff: { applied: r.applied },
      });
    }
  } catch (e) {
    failures++;
    console.error(`✗ ${row.id}: ${String(e?.message || e).slice(0, 300)}`);
  }
}

console.log(failures ? `✗ ${failures} tenant(s) failed` : "✓ all tenants migrated");
process.exit(failures ? 1 : 0);
