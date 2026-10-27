// Versioned migration runner (Session 28 / BE17). Node-only (fs + crypto);
// callers are CLIs, provisioning and tests — never request paths.
//
// Sources of truth:
//   tenant   0001_baseline = lib/schema.sql, then migrations/tenant/NNNN_*.sql
//   platform 0001_baseline = lib/platform/schema.sql, then migrations/platform/NNNN_*.sql
// The baselines are FROZEN as of S28 — every schema change from here is a new
// numbered file. Each database carries its own `schema_migrations` ledger
// (id, checksum, applied_at): applied files are checksum-locked (editing one
// is a hard error), un-applied files run in order and are recorded on success.
//
// libsql's executeMultiple is NOT transactional across statements, so write
// migrations expand → backfill → contract and idempotently (IF NOT EXISTS /
// ADD COLUMN guards) where possible — a retry after a mid-file failure re-runs
// the whole file. See migrations/README.md.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const BASELINES = {
  tenant: join(root, "lib/schema.sql"),
  platform: join(root, "lib/platform/schema.sql"),
};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export async function loadMigrations(kind) {
  if (!BASELINES[kind]) throw new Error(`unknown migration kind "${kind}"`);
  const list = [{ id: "0001_baseline", sql: await readFile(BASELINES[kind], "utf8") }];
  const dir = join(root, "migrations", kind);
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(f)).sort();
  } catch {
    // no directory yet → baseline only
  }
  for (const f of files) {
    const id = f.replace(/\.sql$/, "");
    if (id === "0001_baseline") throw new Error("0001_baseline is reserved for the frozen schema file");
    list.push({ id, sql: await readFile(join(dir, f), "utf8") });
  }
  return list.map((m) => ({ ...m, checksum: sha256(m.sql) }));
}

// Run a migration list against any libsql client (or the db.js proxy).
// Returns { applied: [ids], skipped: n }. Throws on checksum mismatch or SQL
// failure — nothing is recorded for a failed file, so a retry re-runs it.
export async function runMigrations(client, migrations, { log = () => {} } = {}) {
  await client.executeMultiple(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
  );
  const res = await client.execute("SELECT id, checksum FROM schema_migrations");
  const done = new Map(res.rows.map((r) => [r.id, r.checksum]));
  const applied = [];
  let skipped = 0;
  for (const m of migrations) {
    const prior = done.get(m.id);
    if (prior) {
      if (prior !== m.checksum) {
        throw new Error(
          `migration "${m.id}" was edited after being applied (checksum ${prior.slice(0, 8)} → ${m.checksum.slice(0, 8)}). ` +
            "Applied migrations are frozen — write a new numbered migration instead.",
        );
      }
      skipped++;
      continue;
    }
    await client.executeMultiple(m.sql);
    await client.execute({
      sql: "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
      args: [m.id, m.checksum, new Date().toISOString()],
    });
    applied.push(m.id);
    log(`✓ applied ${m.id}`);
  }
  return { applied, skipped };
}
