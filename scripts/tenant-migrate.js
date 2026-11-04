// Run the tenant-track migrations on registered tenant databases (S28 / BE17).
//   pnpm tenant:migrate -- --all            # every tenant, failure-isolated
//   pnpm tenant:migrate -- --tenant demo    # one tenant
//   pnpm tenant:migrate -- --check          # MIG-05: read only, every tenant
//   pnpm tenant:migrate -- --check --tenant demo
//   pnpm tenant:migrate -- --check --include-env   # also the env store (_default)
// One tenant's failure never stops the others; the summary names failures and
// the exit code reflects them. Suspended tenants are migrated too (their data
// must stay schema-current for reactivation).
//
// --check (MIG-05, the deploy gate) changes nothing. It reads each tenant's
// ledger and exits 0 only if every tenant, suspended ones included, holds every
// migration this code ships, unedited. Deploy order: `--all` exits 0, then
// `--check` exits 0, then deploy (migrations/README.md, docs/operations.md).
//
// --include-env (P4-SCAFFOLD, MIG-05; only with --check) also reads the ledger
// of the env store: the database the app uses with no tenant context (the
// "_default" store, TURSO_DB_URL / DATABASE_URL, as lib/db.js picks it). That
// store is migrated with `pnpm migrate`, not `--all`. Without the flag the
// check is exactly what it was.
import { createClient } from "@libsql/client";
import { listTenants, getTenant } from "../lib/platform/control.js";
import { loadMigrations, runMigrations, checkLedger } from "../lib/platform/migrate.js";
import { audit } from "../lib/platform/audit.js";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const one = flag("tenant");
const all = process.argv.includes("--all");
const check = process.argv.includes("--check");
const includeEnv = process.argv.includes("--include-env");

if (!one && !all && !check) {
  console.error("Usage: pnpm tenant:migrate -- (--all | --tenant <slug> | --check [--tenant <slug>] [--include-env])");
  process.exit(1);
}
if (includeEnv && !check) {
  console.error("✗ --include-env only goes with --check. Migrate the env store with pnpm migrate.");
  process.exit(1);
}

const migrations = await loadMigrations("tenant");

if (check) process.exit(await checkAll());

// S42 (OP06): --canary <slug> migrates that tenant FIRST and pauses the whole
// rollout if it fails — the rest of the fleet is never touched by a migration
// that just broke the canary.
const canary = flag("canary");
let targets = one ? [{ id: one }] : await listTenants();
if (canary && all) {
  const rest = targets.filter((t) => t.id !== canary);
  if (rest.length === targets.length) {
    console.error(`✗ canary "${canary}" is not a registered tenant`);
    process.exit(1);
  }
  targets = [{ id: canary, canary: true }, ...rest];
}
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
    if (row.canary) {
      console.error(`✗ CANARY FAILED — rollout paused, ${targets.length - 1} tenant(s) untouched`);
      process.exit(1);
    }
  }
}

console.log(failures ? `✗ ${failures} tenant(s) failed` : "✓ all tenants migrated");
process.exit(failures ? 1 : 0);

// MIG-05: read every ledger, write nothing. Returns the exit code.
async function checkAll() {
  const newest = migrations[migrations.length - 1].id;
  let targets;
  try {
    targets = one ? [{ id: one }] : await listTenants();
  } catch (e) {
    console.error(`✗ could not list tenants from the control plane: ${String(e?.message || e).slice(0, 300)}`);
    return 1;
  }
  // An empty list proves nothing (a wrong PLATFORM_DB_URL looks exactly like this).
  if (!targets.length) {
    console.error("✗ no tenants found. Is PLATFORM_DB_URL the real control plane? Not safe to deploy.");
    return 1;
  }
  let notReady = 0;
  let checked = targets.length;
  if (includeEnv) {
    checked++;
    if (!(await checkEnvStore(newest))) notReady++;
  }
  for (const row of targets) {
    let client;
    try {
      const tenant = await getTenant(row.id);
      if (!tenant) throw new Error("not found in the control plane");
      client = createClient({ url: tenant.dbUrl, authToken: tenant.dbToken || undefined });
      const r = await checkLedger(client, migrations);
      const ahead = r.unknown.length ? ` (its ledger also holds ${r.unknown.join(", ")}, which this code does not ship)` : "";
      if (r.current) {
        console.log(`✓ ${row.id}: current, all ${migrations.length} migrations up to ${newest}${ahead}`);
        continue;
      }
      notReady++;
      if (r.missing.length) console.error(`✗ ${row.id}: behind, missing ${r.missing.join(", ")}${ahead}`);
      if (r.edited.length) console.error(`✗ ${row.id}: changed since it ran: ${r.edited.join(", ")}`);
    } catch (e) {
      notReady++;
      console.error(`✗ ${row.id}: could not read its ledger: ${String(e?.message || e).slice(0, 300)}`);
    } finally {
      client?.close();
    }
  }
  if (notReady) {
    const what = includeEnv ? `${notReady} of ${checked} store(s) (${targets.length} tenant(s) and the env store)` : `${notReady} of ${targets.length} tenant(s)`;
    console.error(
      `✗ ${what} not ready for code that needs ${newest}. ` +
        `Do not deploy. Run pnpm tenant:migrate -- --all${includeEnv ? " and pnpm migrate" : ""} until ${includeEnv ? "they exit" : "it exits"} 0, then --check again.`,
    );
    return 1;
  }
  if (includeEnv) console.log(`✓ all ${targets.length} tenant(s) and the env store hold every migration up to ${newest}. Safe to deploy.`);
  else console.log(`✓ all ${targets.length} tenant(s) hold every migration up to ${newest}. Safe to deploy.`);
  return 0;
}

// --include-env: the env store's ledger, read only. Returns true when current.
// The URL is printed without its query string or credentials.
async function checkEnvStore(newest) {
  const url = process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db";
  const token = process.env.TURSO_DB_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || "";
  const label = "the env store (_default)";
  let client;
  try {
    client = createClient({ url, authToken: token || undefined });
    const r = await checkLedger(client, migrations);
    const ahead = r.unknown.length ? ` (its ledger also holds ${r.unknown.join(", ")}, which this code does not ship)` : "";
    if (r.current) {
      console.log(`✓ ${label}: current, all ${migrations.length} migrations up to ${newest}${ahead}`);
      return true;
    }
    if (r.missing.length) console.error(`✗ ${label}: behind, missing ${r.missing.join(", ")}${ahead}. Run pnpm migrate.`);
    if (r.edited.length) console.error(`✗ ${label}: changed since it ran: ${r.edited.join(", ")}`);
    return false;
  } catch (e) {
    console.error(`✗ ${label}: could not read its ledger: ${String(e?.message || e).slice(0, 300)}`);
    return false;
  } finally {
    client?.close();
  }
}
