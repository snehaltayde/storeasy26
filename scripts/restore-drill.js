// Backup/restore drill (S34 / BE27).
//   pnpm restore:drill -- --tenant demo            restore a tenant DB into an
//                                                  isolated local file + integrity checks
//   pnpm restore:drill -- --control-plane          same drill for the control plane
//   pnpm restore:drill -- --tenant demo --keep     keep the restored file for inspection
//
// Default mode = logical restore: stream schema + every row out of the live
// (hosted) DB into a fresh local libSQL file, then verify integrity. This
// proves the data is recoverable and measures RTO without touching production.
// Turso PITR (point-in-time clone of the hosted DB) is the production path —
// `turso db create <new> --from-db <db> --timestamp <iso>` — and is documented
// in docs/operations.md; it needs the turso CLI + account auth, so the
// drill script sticks to the logical restore it can prove unattended.
import { createClient } from "@libsql/client";
import { getTenant } from "../lib/platform/control.js";
import fs from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

const t0 = Date.now();
let source, label;
if (has("control-plane")) {
  if (!process.env.PLATFORM_DB_URL) throw new Error("PLATFORM_DB_URL not set");
  source = createClient({ url: process.env.PLATFORM_DB_URL, authToken: process.env.PLATFORM_DB_TOKEN || undefined });
  label = "_control-plane";
} else {
  const slug = flag("tenant");
  if (!slug) {
    console.error("Usage: pnpm restore:drill -- (--tenant <slug> | --control-plane) [--keep]");
    process.exit(1);
  }
  const tenant = await getTenant(slug);
  if (!tenant) throw new Error(`unknown tenant "${slug}"`);
  source = createClient({ url: tenant.dbUrl, authToken: tenant.dbToken || undefined });
  label = slug;
}

const file = `restore-drill-${label}.db`;
for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
const restored = createClient({ url: `file:${file}` });

// 1. Schema: every CREATE statement the source carries (tables, indexes, triggers)
const master = await source.execute(
  "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
);
for (const row of master.rows) await restored.execute(String(row.sql));
const tables = master.rows.filter((r) => r.type === "table").map((r) => String(r.name));

// 2. Data: copy every row, batched
let totalRows = 0;
for (const table of tables) {
  const data = await source.execute(`SELECT * FROM "${table}"`);
  if (!data.rows.length) continue;
  const cols = data.columns;
  const placeholders = `(${cols.map(() => "?").join(",")})`;
  for (let i = 0; i < data.rows.length; i += 200) {
    const chunk = data.rows.slice(i, i + 200);
    await restored.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${placeholders}`,
        args: cols.map((c) => r[c] ?? null),
      })),
      "write",
    );
  }
  totalRows += data.rows.length;
}

// 3. Integrity checks against the SOURCE (not assumptions)
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

for (const table of tables) {
  const [a, b] = await Promise.all([
    source.execute(`SELECT COUNT(*) n FROM "${table}"`),
    restored.execute(`SELECT COUNT(*) n FROM "${table}"`),
  ]);
  const sn = Number(a.rows[0].n);
  const rn = Number(b.rows[0].n);
  if (sn !== rn) check(`rowcount ${table}`, false, `source ${sn} ≠ restored ${rn}`);
}
check("row counts match on every table", failures.length === 0, `${tables.length} tables, ${totalRows} rows`);

if (tables.includes("schema_migrations")) {
  const [a, b] = await Promise.all([
    source.execute("SELECT id, checksum FROM schema_migrations ORDER BY id"),
    restored.execute("SELECT id, checksum FROM schema_migrations ORDER BY id"),
  ]);
  check(
    "migration ledger intact (ids + checksums)",
    JSON.stringify(a.rows) === JSON.stringify(b.rows),
    a.rows.map((r) => r.id).join(", ") || "baseline only",
  );
}
if (tables.includes("orders")) {
  const [a, b] = await Promise.all([
    source.execute("SELECT COALESCE(SUM(total),0) s, MAX(created_at) m FROM orders"),
    restored.execute("SELECT COALESCE(SUM(total),0) s, MAX(created_at) m FROM orders"),
  ]);
  check("order money totals match", Number(a.rows[0].s) === Number(b.rows[0].s), `Σtotal ${a.rows[0].s}`);
  // RPO evidence: how fresh is the newest restorable order?
  if (a.rows[0].m) console.log(`  RPO evidence: newest order in restored copy: ${a.rows[0].m}`);
}
if (tables.includes("tenants")) {
  const [a, b] = await Promise.all([
    source.execute("SELECT id, length(secrets_enc) l FROM tenants ORDER BY id"),
    restored.execute("SELECT id, length(secrets_enc) l FROM tenants ORDER BY id"),
  ]);
  check("tenant secret envelopes intact (ciphertext byte-for-byte lengths)", JSON.stringify(a.rows) === JSON.stringify(b.rows));
}
const fk = await restored.execute("PRAGMA foreign_key_check");
check("restored DB foreign-key check clean", fk.rows.length === 0);
const integ = await restored.execute("PRAGMA integrity_check");
check("restored DB integrity_check ok", String(integ.rows[0]?.[0] ?? integ.rows[0]?.integrity_check) === "ok");

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nRestore drill for ${label}: ${tables.length} tables, ${totalRows} rows → ${file} in ${secs}s (measured RTO for this size).`);
if (!has("keep")) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log("(restored file deleted — pass --keep to inspect it)");
} else {
  console.log(`(kept: ${file} — delete it when done; *.db files are never committed)`);
}
process.exit(failures.length ? 1 : 0);
