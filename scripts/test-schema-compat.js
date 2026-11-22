// MIG-05 suite: schema before code.
//   1. The deploy gate, `scripts/tenant-migrate.js --check`, run as the real CLI
//      against LOCAL FILE databases only: one tenant behind fails, every tenant
//      current passes, and the check writes nothing.
//   2. lib/schema-compat.js: a new column is detected once per database, never
//      with a PRAGMA and never per request, and each database answers for itself.
//   3. Cart, product page data, search and order creation against a tenant at
//      the older schema (OLDER_SCHEMA), side by side with a tenant at the current
//      schema. Cart and search go through their real API routes.
//   4. P2-GUARD: a tenant at BEFORE_DOCUMENTS (no cms_state table) still saves
//      legacy content and publishes through the real console handlers.
//   5. P2-READ: a tenant at READ_BEFORE_DOCUMENTS renders legacy content exactly
//      as a current tenant with the same content does, before and after a publish.
//   6. P3-COMMIT: a documents-mode tenant at BEFORE_REFS (no document_refs)
//      creates, saves and publishes through the real console handler, with no
//      refs; once REFS runs, its next publish writes them.
//   7. P4-SCAFFOLD: migration 0024 (content live tables) on a tenant at
//      BEFORE_CONTENT_LIVE, column for column, and re-run; the phase 4 tenant
//      fixture (scripts/support/tenant-fixture.js) at each stage; and
//      `--check --include-env`, which also checks the env store's ledger.
//      P6-FIXTURE: the fixture's documents mode, real syncs (complete,
//      partial, failed), catalog shapes, and phase 6's registered placeholders.
//   pnpm test:schema-compat
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// The tenant at the older schema stops here. Move it to the migration before
// yours when you add one that cart, product page, search or orders depend on.
const OLDER_SCHEMA = "0017_cms_approvals";

// P2-GUARD's own pin, kept apart from OLDER_SCHEMA so moving that one never
// drops this check: the last migration before 0021 (documents, cms_state).
// A store here has no cms_state table and must read as legacy.
const BEFORE_DOCUMENTS = "0020_sync_runs_resumable";

// P2-READ's own pin, kept apart from the two above: a store with no cms_state
// table must read as legacy on the shopper path (drafts before the first
// publish, the frozen legacy reader after it).
const READ_BEFORE_DOCUMENTS = "0020_sync_runs_resumable";

// P3-COMMIT's pin: the last migration before 0023 (document_refs). A store in
// documents mode here still publishes; it just gets no refs rows.
const BEFORE_REFS = "0022_preview_sessions";
const REFS = "0023_document_refs";

// P4-SCAFFOLD's pin: the last migration before 0024 (the content live tables).
const BEFORE_CONTENT_LIVE = "0023_document_refs";
const CONTENT_LIVE = "0024_content_live";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-compat-default.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TYPESENSE_HOST = "";
process.env.TYPESENSE_ADMIN_API_KEY = "";

const GATE_PLATFORM = ".test-compat-gate-platform.db";
const MAIN_PLATFORM = ".test-compat-platform.db";
const dbs = [
  ".test-compat-default.db",
  GATE_PLATFORM,
  MAIN_PLATFORM,
  ".test-compat-empty-platform.db",
  ".test-compat-bare-platform.db",
  ".test-compat-gate-a.db",
  ".test-compat-gate-b.db",
  ".test-compat-gate-c.db",
  ".test-compat-old.db",
  ".test-compat-cur.db",
  ".test-compat-spare.db",
  ".test-compat-pre21.db",
  ".test-compat-read20.db",
  ".test-compat-readcur.db",
  ".test-compat-pre23.db",
  ".test-compat-env.db",
];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

// Plain Node can't resolve the app's "@/…" alias or "next/headers" (next has no
// exports map), so the real routes and lib/content/resolve.js load through this.
// P6-GEN (from the P6-FIXTURE review): the fixture's own import of
// provisioning goes through a thin wrapper, so a test can act on the database
// right before applyContentMode runs (globalThis.__p6BeforeContentMode). The
// wrapper re-exports the real module; with no callback set it changes nothing.
const PROVISION_URL = pathToFileURL(join(ROOT, "lib/platform/provision.js")).href;
const PROVISION_SHIM = "p6-shim:provision";
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    if (spec === "../../lib/platform/provision.js" && String(ctx.parentURL || "").endsWith("/scripts/support/tenant-fixture.js")) return { url: PROVISION_SHIM, shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url !== PROVISION_SHIM) return next(url, ctx);
    const source =
      `import * as real from ${JSON.stringify(PROVISION_URL)};\n` +
      `export * from ${JSON.stringify(PROVISION_URL)};\n` +
      "export async function applyContentMode(client, opts) {\n" +
      "  if (typeof globalThis.__p6BeforeContentMode === 'function') await globalThis.__p6BeforeContentMode(client);\n" +
      "  return real.applyContentMode(client, opts);\n" +
      "}\n";
    return { format: "module", source, shortCircuit: true };
  },
});

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db, libsql, currentDatabase } = await import("../lib/db.js");
const { loadMigrations, runMigrations, checkLedger } = await import("../lib/platform/migrate.js");
const { hasColumns, __schemaCompat } = await import("../lib/schema-compat.js");

const MIGRATIONS = await loadMigrations("tenant");
const NEWEST = MIGRATIONS[MIGRATIONS.length - 1].id;
const upTo = (id) => MIGRATIONS.filter((m) => m.id <= id);
const platformSchema = await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const same = (a, b, m = "") => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n      older: ${A.slice(0, 400)}\n    current: ${B.slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function usePlatform(file) {
  process.env.PLATFORM_DB_URL = `file:${file}`;
  C.__resetPlatformClient();
  await C.migratePlatform(platformSchema);
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
}

// =============================================================================
// 1. The deploy gate: tenant-migrate.js --check, through the real CLI
// =============================================================================
console.log("— the deploy gate (--check), local file databases only");

function cli(args, platformFile = GATE_PLATFORM, env = {}) {
  const r = spawnSync(process.execPath, ["scripts/tenant-migrate.js", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      PLATFORM_DB_URL: `file:${platformFile}`,
      PLATFORM_DB_TOKEN: "",
      PLATFORM_SECRET: process.env.PLATFORM_SECRET,
      TURSO_DB_URL: "",
      DATABASE_URL: "file:.test-compat-default.db",
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "", stderr: r.stderr || "" };
}
const clientFor = (file) => createClient({ url: `file:${file}` });
async function ledger(file) {
  const c = clientFor(file);
  try {
    return (await c.execute("SELECT id, checksum FROM schema_migrations ORDER BY id")).rows.map((r) => `${r.id}:${r.checksum}`);
  } finally {
    c.close();
  }
}
async function tables(file) {
  const c = clientFor(file);
  try {
    return (await c.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).rows.map((r) => `${r.type}:${r.name}:${r.sql}`);
  } finally {
    c.close();
  }
}
async function migrateFile(file, list) {
  const c = clientFor(file);
  try {
    await runMigrations(c, list);
  } finally {
    c.close();
  }
}
const auditRows = async () => Number((await C.platformDb().execute("SELECT COUNT(*) AS n FROM audit_log")).rows[0].n);

await usePlatform(GATE_PLATFORM);
await C.upsertTenant({ id: "ca", name: "Current store", dbUrl: "file:.test-compat-gate-a.db" });
await C.upsertTenant({ id: "cb", name: "Behind store", status: "suspended", dbUrl: "file:.test-compat-gate-b.db" });
await migrateFile(".test-compat-gate-a.db", MIGRATIONS);
await migrateFile(".test-compat-gate-b.db", MIGRATIONS.slice(0, -1));

await t(`one tenant behind (a suspended one): --check exits 1, names it and the missing ${NEWEST}`, async () => {
  const r = cli(["--check"]);
  eq(r.status, 1, `exit code (output: ${r.out.trim()}):`);
  ok(r.stderr.includes(`✗ cb: behind, missing ${NEWEST}`), `cb not named as behind:\n${r.out}`);
  ok(r.stdout.includes(`✓ ca: current, all ${MIGRATIONS.length} migrations up to ${NEWEST}`), `ca not shown current:\n${r.out}`);
  ok(r.stderr.includes("Do not deploy"), `no plain "do not deploy":\n${r.out}`);
  ok(!/Safe to deploy/.test(r.out), "said safe to deploy");
});

await t("--check writes nothing: ledgers, tables and the audit log are unchanged", async () => {
  const before = { b: await ledger(".test-compat-gate-b.db"), bt: await tables(".test-compat-gate-b.db"), at: await tables(".test-compat-gate-a.db"), audit: await auditRows() };
  const r = cli(["--check", "--all"]);
  eq(r.status, 1, "still behind:");
  same(await ledger(".test-compat-gate-b.db"), before.b, "cb ledger changed");
  same(await tables(".test-compat-gate-b.db"), before.bt, "cb tables changed");
  same(await tables(".test-compat-gate-a.db"), before.at, "ca tables changed");
  eq(await auditRows(), before.audit, "audit rows:");
});

await t("deploy order: migrate --all exits 0, then --check exits 0 and says it is safe", async () => {
  const m = cli(["--all"]);
  eq(m.status, 0, `migrate --all (output: ${m.out.trim()}):`);
  ok(m.stdout.includes(`✓ cb: 1 applied (${NEWEST})`), `cb not migrated:\n${m.out}`);
  const r = cli(["--check"]);
  eq(r.status, 0, `--check after migrating (output: ${r.out.trim()}):`);
  ok(r.stdout.includes(`✓ all 2 tenant(s) hold every migration up to ${NEWEST}. Safe to deploy.`), r.out);
});

// P1-FIX-C (MIG-05 review): a ledger AHEAD of this code is the rollback-deploy
// case (newer code migrated the tenant, then an older build is deployed). It
// holds everything this code needs, so it passes, with a note. Nothing tested it.
await t("a tenant whose ledger holds a migration this code doesn't ship (a rollback deploy): --check exits 0, with a note", async () => {
  const c = clientFor(".test-compat-gate-a.db");
  await c.execute({ sql: "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('9999_from_newer_code', 'abc', ?)", args: [new Date().toISOString()] });
  c.close();
  try {
    const one = await (async () => {
      const cc = clientFor(".test-compat-gate-a.db");
      try {
        return await checkLedger(cc, MIGRATIONS);
      } finally {
        cc.close();
      }
    })();
    same([one.current, one.missing, one.edited, one.unknown], [true, [], [], ["9999_from_newer_code"]], "checkLedger");
    const r = cli(["--check"]);
    eq(r.status, 0, `--check (output: ${r.out.trim()}):`);
    ok(r.stdout.includes(`✓ ca: current, all ${MIGRATIONS.length} migrations up to ${NEWEST} (its ledger also holds 9999_from_newer_code, which this code does not ship)`), r.out);
    ok(r.stdout.includes("Safe to deploy."), r.out);
  } finally {
    const d = clientFor(".test-compat-gate-a.db");
    await d.execute("DELETE FROM schema_migrations WHERE id = '9999_from_newer_code'");
    d.close();
  }
});

// A store with no ledger at all, and one whose database can't be opened.
await C.upsertTenant({ id: "cc", name: "Never migrated", dbUrl: "file:.test-compat-gate-c.db" });
{
  const c = clientFor(".test-compat-gate-c.db");
  await c.execute("CREATE TABLE IF NOT EXISTS leftover (x TEXT)");
  c.close();
}

await t("a tenant with no ledger is behind on everything, and --check does not create one", async () => {
  const r = cli(["--check"]);
  eq(r.status, 1, "exit code:");
  ok(r.stderr.includes("✗ cc: behind, missing 0001_baseline, 0002_sync_runs"), r.out);
  ok(r.stderr.includes("✗ 1 of 3 tenant(s) not ready"), r.out);
  same(await tables(".test-compat-gate-c.db"), ["table:leftover:CREATE TABLE leftover (x TEXT)"], "cc gained tables");
});

await t("--check --tenant checks one store only", async () => {
  eq(cli(["--check", "--tenant", "ca"]).status, 0, "ca alone:");
  const r = cli(["--check", "--tenant", "cc"]);
  eq(r.status, 1, "cc alone:");
  ok(!r.out.includes("ca:"), "checked another store");
});

await t("a migration file edited after it ran fails the check", async () => {
  const c = clientFor(".test-compat-gate-a.db");
  const orig = (await c.execute("SELECT checksum FROM schema_migrations WHERE id = '0002_sync_runs'")).rows[0].checksum;
  await c.execute("UPDATE schema_migrations SET checksum = 'edited' WHERE id = '0002_sync_runs'");
  try {
    const r = cli(["--check", "--tenant", "ca"]);
    eq(r.status, 1, "exit code:");
    ok(r.stderr.includes("✗ ca: changed since it ran: 0002_sync_runs"), r.out);
  } finally {
    await c.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = '0002_sync_runs'", args: [orig] });
    c.close();
  }
});

await t("a tenant whose database can't be read fails the check", async () => {
  await C.upsertTenant({ id: "cd", name: "Unreachable", dbUrl: "file:.test-compat-no-such-dir/x.db" });
  try {
    const r = cli(["--check", "--tenant", "cd"]);
    eq(r.status, 1, `exit code (output: ${r.out.trim()}):`);
    ok(r.stderr.includes("✗ cd: could not read its ledger"), r.out);
  } finally {
    await C.platformDb().execute("DELETE FROM tenants WHERE id = 'cd'");
  }
});

await t("a control plane with no tenants, or no tenants table, fails the check", async () => {
  await usePlatform(".test-compat-empty-platform.db");
  const r = cli(["--check"], ".test-compat-empty-platform.db");
  eq(r.status, 1, "empty control plane:");
  ok(r.stderr.includes("no tenants found"), r.out);
  const bare = clientFor(".test-compat-bare-platform.db");
  await bare.execute("CREATE TABLE IF NOT EXISTS unrelated (x TEXT)");
  bare.close();
  const r2 = cli(["--check"], ".test-compat-bare-platform.db");
  eq(r2.status, 1, "no tenants table:");
  ok(r2.stderr.includes("could not list tenants"), r2.out);
});

await t("without --all, --tenant or --check the CLI does nothing and says how to use it", async () => {
  const r = cli([]);
  eq(r.status, 1, "exit code:");
  ok(r.stderr.includes("--check [--tenant <slug>]"), r.out);
});

// =============================================================================
// Tenants for parts 2 and 3: one at OLDER_SCHEMA, one current, one scratch
// =============================================================================
await usePlatform(MAIN_PLATFORM);
for (const [id, file] of [
  ["old", ".test-compat-old.db"],
  ["cur", ".test-compat-cur.db"],
  ["spare", ".test-compat-spare.db"],
]) {
  await C.upsertTenant({ id, name: id.toUpperCase(), domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-secret` } });
}
const inT = async (id, fn) => withTenant(await C.getTenant(id), fn);
await inT("old", () => runMigrations(libsql, upTo(OLDER_SCHEMA)));
await inT("cur", () => runMigrations(libsql, MIGRATIONS));
await inT("spare", () => runMigrations(libsql, MIGRATIONS));

// Every statement sent to one database, for the "asked once, never a PRAGMA" checks.
function spyOn(inst) {
  const seen = [];
  const send = inst.libsql.execute;
  inst.libsql.execute = (stmt, ...rest) => {
    seen.push(typeof stmt === "string" ? stmt : stmt?.sql);
    return send(stmt, ...rest);
  };
  return { seen, stop: () => delete inst.libsql.execute };
}

// =============================================================================
// 2. lib/schema-compat.js
// =============================================================================
console.log("— optional columns, detected once per database");

await inT("cur", () => libsql.execute("CREATE TABLE compat_probe (id TEXT, added_later TEXT)"));
await inT("spare", () => libsql.execute("CREATE TABLE compat_probe (id TEXT)"));

await t("a present column: yes, asked once for 30 callers, with a SELECT and never a PRAGMA", async () => {
  __schemaCompat.forget();
  const inst = await inT("cur", () => currentDatabase());
  const spy = spyOn(inst);
  try {
    const first = await Promise.all(Array.from({ length: 20 }, () => inT("cur", () => hasColumns("order_items", ["title", "variant_title"]))));
    for (let i = 0; i < 10; i++) first.push(await inT("cur", () => hasColumns("order_items", ["title", "variant_title"])));
    ok(first.every((v) => v === true), `answers: ${first}`);
    same(spy.seen, ["SELECT title, variant_title FROM order_items LIMIT 0"], "statements sent");
  } finally {
    spy.stop();
  }
});

await t("an absent column: no, and callers inside the re-check window don't ask again", async () => {
  __schemaCompat.forget();
  const inst = await inT("spare", () => currentDatabase());
  const spy = spyOn(inst);
  try {
    eq(await inT("spare", () => hasColumns("compat_probe", ["id", "added_later"])), false, "first:");
    eq(await inT("spare", () => hasColumns("compat_probe", ["id", "added_later"])), false, "second:");
    eq(spy.seen.length, 1, `statements: ${JSON.stringify(spy.seen)}`);
    ok(!spy.seen.some((s) => /pragma/i.test(s)), "a PRAGMA was sent");
  } finally {
    spy.stop();
  }
});

await t("each database answers for itself", async () => {
  __schemaCompat.forget();
  eq(await inT("cur", () => hasColumns("compat_probe", ["added_later"])), true, "cur:");
  eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), false, "spare:");
  eq(await inT("cur", () => hasColumns("compat_probe", ["added_later"])), true, "cur again:");
});

await t("a column added while the instance is warm is used after the re-check window, then remembered", async () => {
  __schemaCompat.forget();
  __schemaCompat.setRecheckMs(80);
  try {
    eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), false, "before:");
    await inT("spare", () => libsql.execute("ALTER TABLE compat_probe ADD COLUMN added_later TEXT"));
    eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), false, "inside the window (remembered):");
    await sleep(120);
    eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), true, "after the window:");
    const spy = spyOn(await inT("spare", () => currentDatabase()));
    try {
      await sleep(120);
      eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), true, "later:");
      eq(spy.seen.length, 0, "asked again after it was present:");
    } finally {
      spy.stop();
    }
  } finally {
    __schemaCompat.forget();
  }
});

await t("a probe that fails for another reason answers no for that call only, and is asked again", async () => {
  __schemaCompat.forget();
  const inst = await inT("cur", () => currentDatabase());
  const send = inst.libsql.execute;
  let calls = 0;
  inst.libsql.execute = (...a) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("SERVER_ERROR: database is locked"));
    return send(...a);
  };
  try {
    eq(await inT("cur", () => hasColumns("order_items", ["title"])), false, "during the failure:");
    eq(await inT("cur", () => hasColumns("order_items", ["title"])), true, "next call:");
    eq(calls, 2, "probes:");
  } finally {
    delete inst.libsql.execute;
  }
});

await t("only plain table and column names are accepted", async () => {
  for (const [table, cols] of [
    ["order_items; DROP TABLE orders", ["title"]],
    ["order_items", ["title, (SELECT 1)"]],
    ["order_items", []],
    ["Order_Items", ["title"]],
  ]) {
    let threw = false;
    try {
      await inT("cur", () => hasColumns(table, cols));
    } catch {
      threw = true;
    }
    ok(threw, `accepted ${table}(${cols})`);
  }
});

await t("lib/schema-compat.js is edge-safe: no node: imports, only ./db.js and the import-free ./schema-shape.js", async () => {
  const strip = async (f) => (await readFile(join(ROOT, f), "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const importsOf = (src) => [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const src = await strip("lib/schema-compat.js");
  same(importsOf(src), ["./db.js", "./schema-shape.js"], "imports");
  ok(!/\bnode:|\brequire\(|\bprocess\.|\bBuffer\b/.test(src), "uses a Node-only API");
  const shape = await strip("lib/schema-shape.js");
  same(importsOf(shape), [], "schema-shape.js imports");
  ok(!/\bnode:|\brequire\(|\bprocess\.|\bBuffer\b/.test(shape), "schema-shape.js uses a Node-only API");
});

// P1-FIX-C: only the expected pre-migration shape counts as "absent". A view
// or schema that is broken some other way ("no such column: <something else>")
// is not remembered as absent: the caller's own query then meets the real error.
await t("a probe that fails with some OTHER missing column (a broken view) is not remembered as absent", async () => {
  __schemaCompat.forget();
  await inT("spare", () => libsql.executeMultiple("CREATE TABLE compat_view_data (id TEXT, wanted TEXT); CREATE VIEW compat_view AS SELECT id, nosuch_col AS wanted FROM compat_view_data;"));
  const inst = await inT("spare", () => currentDatabase());
  const spy = spyOn(inst);
  try {
    eq(await inT("spare", () => hasColumns("compat_view", ["wanted"])), false, "during the failure:");
    eq(await inT("spare", () => hasColumns("compat_view", ["wanted"])), false, "next call:");
    eq(spy.seen.length, 2, `asked again each time (not remembered as absent): ${JSON.stringify(spy.seen)}`);
  } finally {
    spy.stop();
    await inT("spare", () => libsql.executeMultiple("DROP VIEW compat_view; DROP TABLE compat_view_data;"));
  }
});

await t("the expected shapes, from a local file and from sqld over HTTP, and nothing else", async () => {
  const { notMigratedYet } = await import("../lib/schema-shape.js");
  const drv = (message, cause) => Object.assign(new Error(message), { name: "LibsqlError", code: "SQLITE_ERROR", ...(cause ? { cause } : {}) });
  const spec = { table: "order_items", columns: ["catalog_title", "sku"] };
  for (const msg of [
    "SQLITE_ERROR: no such column: catalog_title",
    "SQL_INPUT_ERROR: SQL input error: no such column: sku (at offset 7)",
    "SQLITE_ERROR: no such column: order_items.sku",
    "SQLITE_UNKNOWN: SQLite error: table order_items has no column named catalog_title",
    "SQLITE_ERROR: no such table: order_items",
    "SQLITE_UNKNOWN: SQLite error: no such table: main.order_items",
  ]) {
    eq(notMigratedYet(drv(msg), spec), true, `${msg}:`);
  }
  for (const msg of [
    "SQLITE_ERROR: no such column: nosuch", // a view naming something gone
    "SQLITE_ERROR: no such column: skus",
    "SQLITE_ERROR: no such table: order_items_data", // the table a view reads is gone
    "SQLITE_UNKNOWN: SQLite error: no such table: main.order_items_old",
    "SQLITE_ERROR: no such column: other_table.sku",
    "SQLITE_BUSY: database is locked",
    "SQLITE_UNKNOWN: SQLite error: malformed JSON",
  ]) {
    eq(notMigratedYet(drv(msg), spec), false, `${msg}:`);
  }
  // only the driver's own errors are read, and a wrapper is read through its cause
  eq(notMigratedYet(new Error("no such column: sku"), spec), false, "our own error quoting the words:");
  eq(notMigratedYet(new Error("snapshot failed", { cause: drv("SQLITE_ERROR: no such column: sku") }), spec), true, "a wrapper with the driver's error as cause:");
  let threw = false;
  try {
    notMigratedYet(drv("x"), { table: "order_items; DROP TABLE x" });
  } catch {
    threw = true;
  }
  ok(threw, "a table name that isn't plain is refused");
});

// =============================================================================
// 3. Cart, product page data, search and order creation at the older schema
// =============================================================================
console.log(`— storefront and order paths: a tenant at ${OLDER_SCHEMA} next to one at ${NEWEST}`);
__schemaCompat.forget();

const P1 = "gid://shopify/Product/101";
const V1 = "gid://shopify/ProductVariant/1011";
const P2 = "gid://shopify/Product/102";
const V2 = "gid://shopify/ProductVariant/1021";
const TS = "2026-01-01T00:00:00.000Z";
async function seedCatalog() {
  const product = (id, handle, title, price) => ({ id, handle, title, description: `${title} for testing`, description_html: `<p>${title}</p>`, product_type: "Protein", vendor: "Test Labs", tags: JSON.stringify(["protein"]), price_min: price, price_max: price, compare_at_min: null, currency: "INR", available: 1, featured_image: `https://cdn.shopify.com/${handle}.png`, featured_image_alt: title, options: "[]", created_at: TS, updated_at: TS, synced_at: TS });
  await db.insertInto("products").values([product(P1, "whey-gold", "Whey Gold", 1000), product(P2, "steel-shaker", "Steel Shaker", 200)]).execute();
  await db
    .insertInto("variants")
    .values([
      { id: V1, product_id: P1, title: "1 kg", sku: "WG-1KG", price: 1000, currency: "INR", available: 1, selected_options: JSON.stringify([{ name: "Size", value: "1 kg" }]), position: 0 },
      { id: V2, product_id: P2, title: "Default Title", sku: "SH-750", price: 200, currency: "INR", available: 1, selected_options: "[]", position: 0 },
    ])
    .execute();
  await db.insertInto("product_images").values({ id: `${P1}::img::0`, product_id: P1, url: "https://cdn.shopify.com/whey-gold.png", alt: "Whey Gold", position: 0 }).execute();
  await db.insertInto("collections").values({ id: "gid://shopify/Collection/1", handle: "all", title: "All", updated_at: TS, synced_at: TS }).execute();
  await db
    .insertInto("collection_products")
    .values([
      { collection_id: "gid://shopify/Collection/1", product_id: P1, position: 0 },
      { collection_id: "gid://shopify/Collection/1", product_id: P2, position: 1 },
    ])
    .execute();
}
await inT("old", seedCatalog);
await inT("cur", seedCatalog);

const cartRoute = await import("../app/api/cart/route.js");
const searchRoute = await import("../app/api/search/route.js");
const { NextRequest } = await import("next/server.js");
const R = await import("../lib/content/resolve.js");
const { getProductByHandle } = await import("../lib/repo.js");
const { getCart } = await import("../lib/cart.js");
const { computeShipping } = await import("../lib/shipping.js");
const O = await import("../lib/orders.js");

await t(`the older tenant really is at ${OLDER_SCHEMA}, a migration this code ships`, async () => {
  ok(MIGRATIONS.some((m) => m.id === OLDER_SCHEMA), `${OLDER_SCHEMA} is not in migrations/tenant`);
  const ids = await inT("old", async () => (await libsql.execute("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id));
  eq(ids[ids.length - 1], OLDER_SCHEMA, "newest in its ledger:");
  const cur = await inT("cur", async () => (await libsql.execute("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].id);
  eq(cur, NEWEST, "current tenant:");
});

// Cart through the real edge route: add, change quantity, add another, read.
async function cartJourney(host) {
  const call = async (method, body, cookie) => {
    const req = new NextRequest(`https://${host}/api/cart`, {
      method,
      headers: { host, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const res = await cartRoute[method](req);
    return { status: res.status, body: await res.json(), cookie: res.cookies.get("cart_session")?.value };
  };
  const add = await call("POST", { action: "add", variantId: V1, quantity: 1 });
  eq(add.status, 200, `${host} add:`);
  const cookie = `cart_session=${add.cookie}`;
  eq((await call("POST", { action: "setQty", variantId: V1, quantity: 3 }, cookie)).status, 200, `${host} setQty:`);
  eq((await call("POST", { action: "add", variantId: V2, quantity: 1 }, cookie)).status, 200, `${host} add 2:`);
  const read = await call("GET", null, cookie);
  eq(read.status, 200, `${host} read:`);
  return { cartId: add.cookie, cart: read.body };
}
const journeys = {};

await t("cart: add, change quantity and read through the real /api/cart route, the same on both schemas", async () => {
  journeys.old = await cartJourney("old.test");
  journeys.cur = await cartJourney("cur.test");
  const shape = (c) => ({ ...c, id: undefined });
  eq(journeys.old.cart.count, 4, "count:");
  eq(journeys.old.cart.subtotal, 3200, "subtotal:");
  same(shape(journeys.old.cart), shape(journeys.cur.cart), "carts differ");
});

const PAGE_LOADERS = ["getProductByHandle", "resolvedPdpExtras", "resolvedPdpPairs", "resolvedProductOverride", "resolvedSurfaceTemplateFor"];
const pageData = (handle) => async () => {
  const product = await getProductByHandle(handle);
  const [pairs, extras, override, surface] = await Promise.all([
    R.resolvedPdpPairs(product.id, { limit: 4 }),
    R.resolvedPdpExtras(),
    R.resolvedProductOverride(product.id),
    R.resolvedSurfaceTemplateFor("pdp", product.id),
  ]);
  return { product, pairs, extras, override, surface };
};

await t("product page data: every loader the page calls returns the same on both schemas", async () => {
  const src = await readFile(join(ROOT, "app/(storefront)/products/[handle]/page.js"), "utf8");
  const called = [...new Set([...src.matchAll(/\b(getProductByHandle|resolved\w+)\(/g)].map((m) => m[1]))].sort();
  same(called, PAGE_LOADERS, "the product page calls a loader this test does not run; add it to pageData()");
  const old = await inT("old", pageData("whey-gold"));
  const cur = await inT("cur", pageData("whey-gold"));
  eq(old.product.title, "Whey Gold", "title:");
  eq(old.product.variants[0].sku, "WG-1KG", "variant:");
  // getPdpPairs swallows errors into an empty list, so check it found the pair
  ok(old.pairs.products.some((p) => p.handle === "steel-shaker"), `pairs: ${JSON.stringify(old.pairs)}`);
  same(old, cur, "product page data differs");
});

await t("search: the real /api/search route finds the product on both schemas", async () => {
  const run = async (host) => {
    const res = await searchRoute.GET(new Request(`https://${host}/api/search?q=whey%20gold`, { headers: { host } }));
    eq(res.status, 200, `${host} status:`);
    return res.json();
  };
  const old = await run("old.test");
  const cur = await run("cur.test");
  eq(old.source, "database", "engine:");
  eq(old.hits[0]?.handle, "whey-gold", "first hit:");
  same(old, cur, "search differs");
});

const CONTACT = { email: "shopper@example.test", phone: "9000000001", name: "Compat Shopper" };
const ADDRESS = { line1: "1 Test Rd", city: "Pune", state: "MH", pincode: "411001", country: "India" };
let keySeq = 0;
// What the COD checkout route does with the cart: the authoritative server cart,
// shipping from the same pure engine, then createOrder.
async function placeOrder(cartId) {
  const cart = await getCart(cartId);
  const shipping = computeShipping({ subtotal: cart.subtotal, discountTotal: cart.discountTotal, paymentMethod: "cod", pincode: ADDRESS.pincode });
  const order = await O.createOrder({ cartId, cart, contact: CONTACT, address: ADDRESS, paymentMethod: "cod", idempotencyKey: `compat-${++keySeq}`, shipping });
  return O.getOrder(order.id);
}
const orderShape = (o) => ({
  status: o.status,
  total: o.total,
  subtotal: o.subtotal,
  items: o.items.map((i) => ({ variant_id: i.variant_id, product_id: i.product_id, title: i.title, quantity: i.quantity, line_total: i.line_total, is_gift: i.is_gift })),
  events: o.events.map((e) => [e.from_status, e.to_status]),
  snapshotItems: o.snapshot.items.map((i) => ({ variantId: i.variantId, title: i.title, quantity: i.quantity })),
});

await t("order creation: the checkout's createOrder saves the order, its lines and first event on both schemas", async () => {
  const old = await inT("old", () => placeOrder(journeys.old.cartId));
  const cur = await inT("cur", () => placeOrder(journeys.cur.cartId));
  eq(old.items.length, 2, "lines:");
  eq(old.status, "cod_pending", "status:");
  same(orderShape(old), orderShape(cur), "orders differ");
  // and the order moves on as usual
  const moved = await inT("old", () => O.beginShopifySync(old.id));
  eq(moved.status, "syncing_shopify", "transition at the older schema:");
});

// ---- OVL-06's columns (migration 0018) at the older schema ---------------------
const columnsOf = async (id, table) => inT(id, async () => (await libsql.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name));
const linesOf = async (id, orderId) => inT(id, async () => (await libsql.execute({ sql: "SELECT * FROM order_items WHERE order_id = ? ORDER BY position", args: [orderId] })).rows.map((r) => ({ ...r })));
const freshCart = async (id) =>
  inT(id, async () => {
    const { createCart, addItem } = await import("../lib/cart.js");
    const cartId = `compat-fresh-${++keySeq}`;
    await createCart(cartId);
    await addItem(cartId, V1, 1);
    return cartId;
  });

await t("older schema: the order's lines leave out catalog_title and sku, and its snapshot still has them", async () => {
  ok(!(await columnsOf("old", "order_items")).includes("catalog_title"), "the older tenant already has catalog_title");
  const order = await inT("old", async () => placeOrder(await freshCart("old")));
  const lines = await linesOf("old", order.id);
  ok(lines.length === 1 && !("catalog_title" in lines[0]) && !("sku" in lines[0]), `lines: ${JSON.stringify(lines)}`);
  same([order.snapshot.items[0].catalog_title, order.snapshot.items[0].sku], ["Whey Gold", "WG-1KG"], "snapshot");
});

await t("current schema: the order's lines carry catalog_title and sku", async () => {
  const order = await inT("cur", async () => placeOrder(await freshCart("cur")));
  const [line] = await linesOf("cur", order.id);
  same([line.catalog_title, line.sku], ["Whey Gold", "WG-1KG"], "line");
});

await t("orders ask about the columns once per database, never per order and never with a PRAGMA", async () => {
  __schemaCompat.forget();
  const spies = { old: spyOn(await inT("old", () => currentDatabase())), cur: spyOn(await inT("cur", () => currentDatabase())) };
  try {
    for (let i = 0; i < 3; i++) {
      for (const id of ["old", "cur"]) await inT(id, async () => placeOrder(await freshCart(id)));
    }
    for (const [id, spy] of Object.entries(spies)) {
      eq(spy.seen.filter((s) => /catalog_title/.test(s) && /^SELECT/.test(s)).length, 1, `${id} probes:`);
      ok(!spy.seen.some((s) => /pragma/i.test(s)), `${id} sent a PRAGMA`);
    }
  } finally {
    spies.old.stop();
    spies.cur.stop();
  }
});

await t("a tenant migrated while the instance is warm: orders get the columns once the re-check window passes", async () => {
  __schemaCompat.forget();
  __schemaCompat.setRecheckMs(400);
  try {
    const before = await inT("old", async () => placeOrder(await freshCart("old")));
    ok(!("catalog_title" in (await linesOf("old", before.id))[0]), "had the column before migrating");
    await inT("old", () => runMigrations(libsql, MIGRATIONS));
    const inside = await inT("old", async () => placeOrder(await freshCart("old")));
    eq((await linesOf("old", inside.id))[0].catalog_title, null, "inside the window, the column exists but is left out:");
    await sleep(450);
    const after = await inT("old", async () => placeOrder(await freshCart("old")));
    same([(await linesOf("old", after.id))[0].catalog_title, (await linesOf("old", after.id))[0].sku], ["Whey Gold", "WG-1KG"], "after the window");
  } finally {
    __schemaCompat.forget();
  }
});

// =============================================================================
// 6. P3-COMMIT: a documents tenant at BEFORE_REFS publishes without refs
// =============================================================================
console.log(`— a documents tenant at ${BEFORE_REFS} (no document_refs) publishes`);
{
  const I = await import("../lib/platform/identity.js");
  const Sess = await import("../lib/platform/sessions.js");
  const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
  const { __forgetRefsTable } = await import("../lib/documents/build.js");
  const Reg = await import("../lib/registry/index.js");
  await C.upsertTenant({ id: "pre23", name: "PRE23", domains: ["pre23.test"], dbUrl: "file:.test-compat-pre23.db", config: {}, secrets: {} });
  await inT("pre23", () => runMigrations(libsql, upTo(BEFORE_REFS)));
  await inT("pre23", () => libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1"));
  const u = await I.createUser({ email: "owner@pre23.test", password: "pre23-owner-pass" });
  await I.addMembership(u.id, "pre23", "owner");
  const tok = (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 60_000 })).token;
  const call = (body) =>
    inT("pre23", () =>
      handleDocumentsPut({ cookies: { get: (n) => (n === "_admin" ? { value: tok } : undefined) }, headers: { get: (k) => ({ host: "pre23.test" })[k.toLowerCase()] ?? null }, json: async () => body }),
    );
  const pageBody = (words) => {
    const b = Reg.emptyBody("page");
    b.meta = { ...b.meta, slug: "pre-refs", title: "Pre refs" };
    const s = Reg.newSection("product_rail", { id: "sec_r1" });
    b.sections = [{ ...s, settings: { ...s.settings, title: words, collection: { handle: "shirts" } } }];
    return b;
  };
  const refsTables = () => inT("pre23", async () => (await libsql.execute("SELECT name FROM sqlite_master WHERE name = 'document_refs'")).rows.length);

  await t(`the tenant really is at ${BEFORE_REFS}, with no document_refs table, in documents mode`, async () => {
    ok(MIGRATIONS.some((m) => m.id === REFS), `${REFS} is not in migrations/tenant`);
    eq(MIGRATIONS.filter((m) => m.id > BEFORE_REFS)[0]?.id, REFS, "the next migration:");
    const ids = await inT("pre23", async () => (await libsql.execute("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id));
    eq(ids[ids.length - 1], BEFORE_REFS, "newest in its ledger:");
    eq(await refsTables(), 0, "document_refs tables:");
  });

  await t(`at ${BEFORE_REFS}: create, save and publish a page through the real handler; no refs; after ${REFS} the next publish writes them`, async () => {
    __forgetRefsTable();
    // P3-CHECKS (PUB-06): a closed store opens with its home page first
    const h = await call({ createDocument: { type: "home", body: { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_schome", kind: "hero", v: 1, enabled: true, settings: { title: "Compat home" }, blocks: [] }] } } });
    eq((await call({ publish: { id: h.body.document.id, draftHash: h.body.document.draftHash }, revision: h.body.document.revision })).status, 200, "the home page opens the store:");
    const c = await call({ createDocument: { type: "page", body: pageBody("Rail") } });
    eq(c.status, 200, `create: ${JSON.stringify(c.body).slice(0, 200)}`);
    const p = await call({ publish: { id: c.body.document.id, draftHash: c.body.document.draftHash }, revision: c.body.document.revision });
    eq(p.status, 200, `publish: ${JSON.stringify(p.body).slice(0, 300)}`);
    eq(p.body.published.length, 1, "published:");
    eq(await refsTables(), 0, "still no table:");
    await inT("pre23", () => runMigrations(libsql, MIGRATIONS));
    const s = await call({ saveDraft: { id: c.body.document.id, body: pageBody("Rail two") }, revision: c.body.document.revision });
    eq(s.status, 200, "save:");
    const p2 = await call({ publish: { id: s.body.document.id, draftHash: s.body.document.draftHash }, revision: s.body.document.revision });
    eq(p2.status, 200, `publish after ${REFS}: ${JSON.stringify(p2.body).slice(0, 300)}`);
    const rows = await inT("pre23", async () => (await libsql.execute({ sql: "SELECT ref_type, ref_id FROM document_refs WHERE version_id = ?", args: [p2.body.published[0].versionId] })).rows.map((r) => ({ ref_type: String(r.ref_type), ref_id: String(r.ref_id) })));
    same(rows, [{ ref_type: "collection", ref_id: "shirts" }], "refs:");
  });
}

// =============================================================================
// 7. P4-SCAFFOLD: 0024 content live tables, the tenant fixture, --include-env
// =============================================================================
console.log(`— P4-SCAFFOLD: ${CONTENT_LIVE} on a tenant at ${BEFORE_CONTENT_LIVE}, the tenant fixture, --check --include-env`);
{
  const F = await import("./support/tenant-fixture.js");
  const M24 = MIGRATIONS.find((m) => m.id === CONTENT_LIVE);
  // [name, type, notnull, pk] for every column, in order: the pinned DDL
  const PINNED = {
    product_content_live: [
      ["product_id", "TEXT", 0, 1],
      ["document_id", "TEXT", 1, 0],
      ["version_id", "TEXT", 1, 0],
      ["title", "TEXT", 0, 0],
      ["description", "TEXT", 0, 0],
      ["description_html", "TEXT", 0, 0],
      ["featured_image", "TEXT", 0, 0],
      ["featured_image_alt", "TEXT", 0, 0],
      ["gallery", "TEXT", 0, 0],
      ["seo_title", "TEXT", 0, 0],
      ["seo_description", "TEXT", 0, 0],
      ["og_image", "TEXT", 0, 0],
      ["display_vendor", "TEXT", 0, 0],
      ["display_type", "TEXT", 0, 0],
      ["badge", "TEXT", 0, 0],
      ["modules", "TEXT", 0, 0],
      ["layout_document_id", "TEXT", 0, 0],
      ["pairs", "TEXT", 0, 0],
      ["keep_variant_images", "INTEGER", 0, 0],
      ["published_at", "TEXT", 1, 0],
      ["pairs_title", "TEXT", 0, 0],
      ["layout_template", "TEXT", 0, 0],
    ],
    collection_content_live: [
      ["collection_id", "TEXT", 0, 1],
      ["document_id", "TEXT", 1, 0],
      ["version_id", "TEXT", 1, 0],
      ["pinned", "TEXT", 0, 0],
      ["layout_document_id", "TEXT", 0, 0],
      ["published_at", "TEXT", 1, 0],
      ["layout_template", "TEXT", 0, 0],
    ],
    search_outbox: [
      ["product_id", "TEXT", 1, 0],
      ["handle", "TEXT", 0, 0],
      ["reason", "TEXT", 1, 0],
      ["created_at", "TEXT", 1, 0],
      ["done_at", "TEXT", 0, 0],
    ],
    cms_migration_runs: [
      ["id", "TEXT", 0, 1],
      ["kind", "TEXT", 1, 0],
      ["step", "TEXT", 1, 0],
      ["source_hash", "TEXT", 0, 0],
      ["dry_run_digest", "TEXT", 0, 0],
      ["backup_ref", "TEXT", 0, 0],
      ["report", "TEXT", 0, 0],
      ["started_at", "TEXT", 1, 0],
      ["finished_at", "TEXT", 0, 0],
      ["outcome", "TEXT", 0, 0],
    ],
    content_live_reversed: [
      ["run_id", "TEXT", 1, 1],
      ["kind", "TEXT", 1, 2],
      ["entity_id", "TEXT", 1, 3],
      ["row_json", "TEXT", 1, 0],
      ["reversed_at", "TEXT", 1, 0],
    ],
  };
  // The spec 8.2 product_content_live column list, verbatim: every one is pinned.
  const SPEC_PRODUCT_COLUMNS = "product_id document_id version_id title description description_html featured_image featured_image_alt gallery seo_title seo_description og_image display_vendor display_type badge modules layout_document_id pairs keep_variant_images published_at".split(" ");
  const NEW_TABLES = Object.keys(PINNED);
  const columnsOf = async (c, table) => (await c.execute(`PRAGMA table_info(${table})`)).rows.map((r) => [String(r.name), String(r.type), Number(r.notnull), Number(r.pk)]);
  const objectsOf = async (c) => (await c.execute(`SELECT type, name FROM sqlite_master WHERE name IN (${[...NEW_TABLES, "product_content_live_document", "search_outbox_pending"].map((n) => `'${n}'`).join(", ")}) ORDER BY name`)).rows.map((r) => `${r.type}:${r.name}`);

  let at23 = null;
  await t(`the fixture builds a tenant at ${BEFORE_CONTENT_LIVE} with no content live tables, its products written by writeProduct inside withTenant`, async () => {
    ok(M24, `${CONTENT_LIVE} is not in migrations/tenant`);
    eq(MIGRATIONS.filter((m) => m.id > BEFORE_CONTENT_LIVE)[0]?.id, CONTENT_LIVE, "the next migration:");
    at23 = await F.makeTenant({ name: "compat-p4-23", stage: "0023", products: 2 });
    eq(at23.migrations[at23.migrations.length - 1], BEFORE_CONTENT_LIVE, "newest migration in the stage:");
    const c = at23.client();
    try {
      eq((await c.execute("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].id, BEFORE_CONTENT_LIVE, "newest in its ledger:");
      same(await objectsOf(c), [], "content live objects before 0024:");
      same((await c.execute("SELECT id, handle, title FROM products ORDER BY id")).rows.map((r) => ({ ...r })), at23.products.map((p) => ({ id: p.id, handle: p.handle, title: p.title })), "products:");
    } finally {
      c.close();
    }
  });

  await t(`a tenant migrated to ${BEFORE_CONTENT_LIVE} then ${CONTENT_LIVE} has every pinned table, column and index; running 0024 again succeeds`, async () => {
    ok(at23, "no 0023 tenant");
    const sql = M24.sql.replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/\b(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW))\s+(\w+)/gi)) ok(/^IF$/i.test(m[2]), `${m[1]} without IF NOT EXISTS`);
    ok(!/\b(DROP|ALTER|UPDATE|DELETE|INSERT|REPLACE)\b/i.test(sql), "a statement that is not CREATE … IF NOT EXISTS");
    const r = await at23.migrateTo("0024");
    same(r.applied, [CONTENT_LIVE], "applied:");
    const c = at23.client();
    try {
      for (const table of NEW_TABLES) same(await columnsOf(c, table), PINNED[table], `${table} columns:`);
      const productCols = PINNED.product_content_live.map((x) => x[0]);
      same(productCols.slice(0, SPEC_PRODUCT_COLUMNS.length), SPEC_PRODUCT_COLUMNS, "spec 8.2 columns first, in spec order:");
      same(productCols.slice(SPEC_PRODUCT_COLUMNS.length), ["pairs_title", "layout_template"], "plus:");
      same(
        await objectsOf(c),
        ["table:cms_migration_runs", "table:collection_content_live", "table:content_live_reversed", "table:product_content_live", "index:product_content_live_document", "table:search_outbox", "index:search_outbox_pending"],
        "objects:",
      );
      same((await c.execute("PRAGMA index_info(product_content_live_document)")).rows.map((x) => String(x.name)), ["document_id"], "product_content_live_document on:");
      same((await c.execute("PRAGMA index_info(search_outbox_pending)")).rows.map((x) => String(x.name)), ["created_at"], "search_outbox_pending on:");
      const pend = String((await c.execute("SELECT sql FROM sqlite_master WHERE name = 'search_outbox_pending'")).rows[0].sql);
      ok(/WHERE\s+done_at\s+IS\s+NULL\s*$/i.test(pend), `search_outbox_pending is not partial on done_at IS NULL: ${pend}`);
      const plan = (await c.execute("EXPLAIN QUERY PLAN SELECT rowid FROM search_outbox WHERE done_at IS NULL ORDER BY created_at")).rows.map((x) => String(x.detail)).join(" ");
      ok(/search_outbox_pending/.test(plan), `the pending read does not use the index: ${plan}`);
      // the kind CHECK: cutover and reverse only
      await c.execute("INSERT INTO cms_migration_runs (id, kind, step, started_at) VALUES ('run_a', 'cutover', 'lock', 'x'), ('run_b', 'reverse', 'lock', 'x')");
      let e = null;
      try {
        await c.execute("INSERT INTO cms_migration_runs (id, kind, step, started_at) VALUES ('run_c', 'other', 'lock', 'x')");
      } catch (err) {
        e = err;
      }
      ok(e && /CHECK/i.test(e.message), `kind 'other' was accepted: ${e?.message}`);
      // the copy-aside key
      await c.execute("INSERT INTO content_live_reversed (run_id, kind, entity_id, row_json, reversed_at) VALUES ('run_b', 'product', 'p1', '{}', 'x')");
      e = null;
      try {
        await c.execute("INSERT INTO content_live_reversed (run_id, kind, entity_id, row_json, reversed_at) VALUES ('run_b', 'product', 'p1', '{}', 'y')");
      } catch (err) {
        e = err;
      }
      ok(e && /UNIQUE|PRIMARY/i.test(e.message), "a second copy of one row was accepted");
      // re-running 0024 (the file twice, then the runner) changes nothing
      const before = await tables(at23.file);
      await c.executeMultiple(M24.sql);
      await c.executeMultiple(M24.sql);
      // P4-MEDIA: the runner up to 0024 (0025 and later are other files)
      same((await runMigrations(c, upTo(CONTENT_LIVE))).applied, [], "runner re-run applied:");
      same(await tables(at23.file), before, "schema after re-running 0024:");
      eq(Number((await c.execute("SELECT count(*) AS n FROM cms_migration_runs")).rows[0].n), 2, "rows kept:");
      ok((await checkLedger(c, upTo(CONTENT_LIVE))).current, "ledger current after 0024");
    } finally {
      c.close();
      await at23.cleanup();
    }
  });

  await t("the tenant fixture refuses non-file URLs and builds tenants at every stage, products written inside withTenant (never the env store)", async () => {
    for (const bad of ["libsql://shop-org.turso.io", "https://shop.turso.io", "ws://127.0.0.1:7100", "http://127.0.0.1:7100", "file://remote-host/x.db", ".test-x.db", "", null]) {
      let e = null;
      try {
        F.assertLocalDbUrl(bad);
      } catch (err) {
        e = err;
      }
      ok(e && /only local file: databases/.test(e.message), `accepted ${JSON.stringify(bad)}`);
    }
    eq(F.assertLocalDbUrl("file:.test-x.db"), "file:.test-x.db", "file: accepted:");
    let e = null;
    try {
      await F.makeTenant({ name: "compat-p4-bad", stage: "0099" });
    } catch (err) {
      e = err;
    }
    ok(e && /unknown stage/.test(e.message), "an unknown stage was accepted");
    ok(!existsSync(join(ROOT, ".test-compat-p4-bad-tenant.db")), "an unknown stage left a database file");
    // the env store must not gain these products: writeProduct ran in the tenant's context
    const envHas = async () => {
      const c = clientFor(".test-compat-default.db");
      try {
        return (await c.execute("SELECT count(*) AS n FROM products WHERE handle LIKE 'fixture-product-%'")).rows[0].n;
      } catch {
        return 0; // no products table: nothing there either
      } finally {
        c.close();
      }
    };
    const newestOf = { "0017": "0017_cms_approvals", "0020": "0020_sync_runs_resumable", "0022": "0022_preview_sessions", "0023": "0023_document_refs", "0024": "0024_content_live", "0025": "0025_media_archived", latest: NEWEST };
    same(Object.keys(newestOf), [...F.STAGES], "every fixture stage is checked here:");
    for (const stage of F.STAGES) {
      const fx = await F.makeTenant({ name: `compat-p4-s${stage}`, stage, products: [{ title: `Stage ${stage} shirt` }, {}] });
      try {
        ok(fx.url.startsWith("file:") && fx.file.startsWith(`.test-compat-p4-s${stage}-`), `file: ${fx.file}`);
        const c = fx.client();
        try {
          eq((await c.execute("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].id, newestOf[stage], `${stage} newest:`);
          eq(Number((await c.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0].n), F.stageMigrations(stage, MIGRATIONS).length, `${stage} ledger size:`);
          const live = (await c.execute("SELECT name FROM sqlite_master WHERE name = 'product_content_live'")).rows.length;
          eq(live, stage >= "0024" ? 1 : 0, `${stage} product_content_live:`);
          // exactly what lib/sync.js writeProduct writes: the product, its images and variants
          same(
            (await c.execute("SELECT p.title, p.handle, p.vendor, (SELECT count(*) FROM product_images i WHERE i.product_id = p.id) AS imgs, (SELECT sku FROM variants v WHERE v.product_id = p.id) AS sku FROM products p ORDER BY p.id")).rows.map((r) => ({ ...r, imgs: Number(r.imgs) })),
            [
              { title: `Stage ${stage} shirt`, handle: "fixture-product-1", vendor: "Fixture Labs", imgs: 1, sku: "FX-1" },
              { title: "Fixture product 2", handle: "fixture-product-2", vendor: "Fixture Labs", imgs: 1, sku: "FX-2" },
            ],
            `${stage} products:`,
          );
        } finally {
          c.close();
        }
        // and the tenant's own context reads them through lib/db.js
        eq(Number(await fx.run(async () => (await libsql.execute("SELECT count(*) AS n FROM products")).rows[0].n)), 2, `${stage} through withTenant:`);
      } finally {
        await fx.cleanup();
      }
    }
    eq(Number(await envHas()), 0, "fixture products in the env store:");
  });

  // --check --include-env, through the real CLI, on file databases only. "ca"
  // on the gate's control plane holds every migration (part 1).
  const ENV_FILE = ".test-compat-env.db";
  const envOpts = { DATABASE_URL: `file:${ENV_FILE}` };
  await rm(join(ROOT, ENV_FILE), { force: true });

  await t("--check without --include-env never opens the env store and prints what it always did", async () => {
    const r = cli(["--check", "--tenant", "ca"], GATE_PLATFORM, envOpts);
    eq(r.status, 0, `exit (output: ${r.out.trim()}):`);
    eq(r.out, `✓ ca: current, all ${MIGRATIONS.length} migrations up to ${NEWEST}\n✓ all 1 tenant(s) hold every migration up to ${NEWEST}. Safe to deploy.\n`, "output:");
    ok(!existsSync(join(ROOT, ENV_FILE)), "the env store file was created");
  });

  await t(`--check --include-env fails when the env file database lacks ${CONTENT_LIVE}, and passes after pnpm migrate; without the flag the output is the same both times`, async () => {
    await migrateFile(ENV_FILE, F.stageMigrations("0023", MIGRATIONS));
    const plainBefore = cli(["--check", "--tenant", "ca"], GATE_PLATFORM, envOpts);
    const r = cli(["--check", "--tenant", "ca", "--include-env"], GATE_PLATFORM, envOpts);
    eq(r.status, 1, `exit (output: ${r.out.trim()}):`);
    ok(r.stderr.includes(`✗ the env store (_default): behind, missing ${CONTENT_LIVE}`), r.out);
    ok(r.stdout.includes(`✓ ca: current`), r.out);
    ok(r.stderr.includes("1 of 2 store(s) (1 tenant(s) and the env store) not ready") && r.stderr.includes("Do not deploy") && r.stderr.includes("pnpm migrate"), r.out);
    ok(!/Safe to deploy/.test(r.out), "said safe to deploy");
    eq((await ledger(ENV_FILE)).length, F.stageMigrations("0023", MIGRATIONS).length, "the check wrote to the env ledger:");
    // the owner step: pnpm migrate (scripts/migrate.js) on the env store
    const m = spawnSync(process.execPath, ["scripts/migrate.js"], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, TURSO_DB_URL: "", DATABASE_URL: `file:${ENV_FILE}` } });
    eq(m.status, 0, `pnpm migrate (output: ${`${m.stdout}${m.stderr}`.trim().slice(0, 400)}):`);
    const r2 = cli(["--check", "--tenant", "ca", "--include-env"], GATE_PLATFORM, envOpts);
    eq(r2.status, 0, `exit after migrating (output: ${r2.out.trim()}):`);
    ok(r2.stdout.includes(`✓ the env store (_default): current, all ${MIGRATIONS.length} migrations up to ${NEWEST}`), r2.out);
    ok(r2.stdout.includes(`✓ all 1 tenant(s) and the env store hold every migration up to ${NEWEST}. Safe to deploy.`), r2.out);
    const plainAfter = cli(["--check", "--tenant", "ca"], GATE_PLATFORM, envOpts);
    same([plainAfter.status, plainAfter.out], [plainBefore.status, plainBefore.out], "--check without the flag:");
    // a behind tenant still fails with the flag, even with the env store current
    const all = cli(["--check", "--include-env"], GATE_PLATFORM, envOpts);
    eq(all.status, 1, "cc is still behind:");
    ok(all.stderr.includes("✗ cc: behind") && all.stdout.includes("✓ the env store (_default): current"), all.out);
  });

  await t("--include-env only goes with --check, and an env store that can't be read fails the check", async () => {
    const r = cli(["--all", "--include-env"], GATE_PLATFORM, envOpts);
    eq(r.status, 1, "exit:");
    ok(r.stderr.includes("--include-env only goes with --check"), r.out);
    ok(!r.out.includes("applied"), "it migrated something");
    const bad = cli(["--check", "--tenant", "ca", "--include-env"], GATE_PLATFORM, { DATABASE_URL: "file:.test-compat-no-such-dir/env.db" });
    eq(bad.status, 1, `unreadable env store (output: ${bad.out.trim()}):`);
    ok(bad.stderr.includes("✗ the env store (_default): could not read its ledger"), bad.out);
  });

  // The runbook's operator commands and the 15 phase 4 suites are registered
  // once, here (package.json is SCAFFOLD's only). A stub is checked only while
  // it is still SCAFFOLD's stub: its owner replaces the file and its tests.
  await t("P4-SCAFFOLD: the active operator commands and suites are registered", async () => {
    const { scripts } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const OPS = [
      ["media:reindex", "scripts/reindex-document-refs.js", "P4-MEDIA"],
    ];
    for (const [name, file] of OPS) {
      eq(scripts[name], `node ${file}`, `${name}:`);
    }
    const SUITES = ["media-refs", "effective-read", "product-content", "search-effective", "media-picker", "product-editor"];
    for (const s of SUITES) eq(scripts[`test:${s}`], `node scripts/test-${s}.js`, `test:${s}:`);
  });

  // ---------------------------------------------------------------------------
  // P6-FIXTURE (GEN-01, GEN-04, PUB-12): the fixture's documents mode, its real
  // syncs and its catalog shapes. Nothing here may depend on CHECKOUT_MODE.
  // ---------------------------------------------------------------------------
  console.log("— P6-FIXTURE: documents-mode fixtures, real catalog syncs, catalog shapes, phase 6 placeholders");
  delete process.env.CHECKOUT_MODE;
  const SYNC = await import("../lib/sync.js");
  const ADAPTER = await import("../lib/commerce/adapter.js");
  const CART = await import("../lib/cart.js");
  const one = async (c, sql, args = []) => (await c.execute({ sql, args })).rows[0];
  const count = async (c, table) => Number((await one(c, `SELECT count(*) AS n FROM ${table}`)).n);
  // What a fixture store holds, read from its own file
  const stateOf = async (fx) => {
    const c = fx.client();
    try {
      return {
        mode: String((await one(c, "SELECT mode FROM cms_state WHERE id = 1"))?.mode ?? "none"),
        liveRelease: (await one(c, "SELECT live_release_id FROM release_state WHERE id = 1"))?.live_release_id ?? null,
        releases: await count(c, "releases"),
        documents: await count(c, "documents"),
        products: await count(c, "products"),
        variants: await count(c, "variants"),
        collections: await count(c, "collections"),
        members: await count(c, "collection_products"),
        runs: (await c.execute("SELECT status FROM sync_runs ORDER BY started_at")).rows.map((r) => String(r.status)),
      };
    } finally {
      c.close();
    }
  };

  await t("P6-FIXTURE: makeTenant({ mode: 'documents', sync: 'complete', catalogShape: 'few' }) is a confirmed, unopened documents store with direct checkout, CHECKOUT_MODE unset", async () => {
    ok(process.env.CHECKOUT_MODE === undefined, "CHECKOUT_MODE is set");
    const fx = await F.makeTenant({ name: "compat-p6-few", mode: "documents", sync: "complete", catalogShape: "few" });
    try {
      const conf = await fx.run(() => SYNC.confirmedCatalogSync());
      eq(conf.confirmed, true, `confirmedCatalogSync (${JSON.stringify(conf)}):`);
      same([conf.products, conf.collections], [4, 2], "confirmed counts:");
      const s = await stateOf(fx);
      same(s, { mode: "documents", liveRelease: null, releases: 0, documents: 0, products: 4, variants: 4, collections: 2, members: 4, runs: ["complete"] }, "the store:");
      eq(fx.tenant.config.checkout_mode, "direct", "tenant config checkout_mode:");
      ok(fx.tenant.config.maintenance === undefined && fx.tenant.config.billing === undefined, `maintenance or billing in the config: ${JSON.stringify(fx.tenant.config)}`);
      eq(await fx.run(() => ADAPTER.checkoutMode()), "direct", "checkoutMode:");
      const cap = await fx.run(() => ADAPTER.checkoutCapability());
      same([cap.available, cap.cod], [true, true], `checkoutCapability (${JSON.stringify(cap)}):`);
      // the run is the real one: injected source, prune and index reached
      const run = fx.syncResult.run;
      same([run.source, run.phase, Number(run.products), Number(run.collections)], ["injected", "done", 4, 2], "the sync_runs row:");
      same([fx.mode, fx.sync, fx.collections.length], ["documents", "complete", 2], "the handle:");
    } finally {
      await fx.cleanup();
    }
  });

  await t("P6-FIXTURE: the documents fixture's checkout_mode is its own: CHECKOUT_MODE=disabled in the env changes nothing, and a caller's checkout_mode still wins", async () => {
    process.env.CHECKOUT_MODE = "disabled";
    const fx = await F.makeTenant({ name: "compat-p6-env", mode: "documents", sync: "complete", catalogShape: "one" });
    const off = await F.makeTenant({ name: "compat-p6-off", mode: "documents", catalogShape: "one", config: { checkout_mode: "disabled" } });
    try {
      eq((await fx.run(() => ADAPTER.checkoutCapability())).available, true, "documents fixture with env disabled:");
      eq((await off.run(() => ADAPTER.checkoutCapability())).available, false, "caller's checkout_mode disabled:");
    } finally {
      delete process.env.CHECKOUT_MODE;
      await fx.cleanup();
      await off.cleanup();
    }
  });

  await t("P6-FIXTURE: a 'few' product synced by the fixture goes into a cart (its variant is in the catalog, priced and available)", async () => {
    const fx = await F.makeTenant({ name: "compat-p6-cart", mode: "documents", sync: "complete", catalogShape: "few" });
    try {
      const [p] = fx.products;
      const vid = p.variants.nodes[0].id;
      const cart = await fx.run(async () => {
        await CART.createCart("fixture-cart");
        await CART.addItem("fixture-cart", vid, 2);
        return CART.getCart("fixture-cart");
      });
      eq(cart.items.length, 1, "lines:");
      const [line] = cart.items;
      same([line.variantId, line.productId, line.handle, line.sku, line.price, line.quantity, line.lineTotal, line.available], [vid, p.id, "fixture-product-1", "FX-1", 100, 2, 200, true], "the line:");
    } finally {
      await fx.cleanup();
    }
  });

  await t("P6-FIXTURE: sync 'partial' and 'failed' leave a latest run that is not complete, so the catalog is not confirmed; the first page is kept", async () => {
    for (const [sync, status, reason] of [
      ["partial", "running", "running"],
      ["failed", "failed", "failed"],
    ]) {
      const fx = await F.makeTenant({ name: `compat-p6-${sync}`, mode: "documents", sync, catalogShape: "few" });
      try {
        const conf = await fx.run(() => SYNC.confirmedCatalogSync());
        same([conf.confirmed, conf.reason], [false, reason], `${sync} confirmedCatalogSync:`);
        const s = await stateOf(fx);
        same([s.mode, s.runs, s.products, s.collections], ["documents", [status], 2, 0], `${sync} store:`);
        eq(fx.syncResult.run.status, status, `${sync} handle run:`);
      } finally {
        await fx.cleanup();
      }
    }
  });

  await t("P6-FIXTURE: catalogShape 'empty' with sync 'complete' is confirmed with 0 products; every shape lands as described", async () => {
    const empty = await F.makeTenant({ name: "compat-p6-empty", mode: "documents", sync: "complete", catalogShape: "empty" });
    try {
      const conf = await empty.run(() => SYNC.confirmedCatalogSync());
      same([conf.confirmed, conf.products, conf.collections], [true, 0, 0], "empty confirmed:");
      same(await stateOf(empty), { mode: "documents", liveRelease: null, releases: 0, documents: 0, products: 0, variants: 0, collections: 0, members: 0, runs: ["complete"] }, "empty store:");
    } finally {
      await empty.cleanup();
    }
    const expect = { one: [1, 1], few: [4, 2], many: [40, 4], all_sold_out: [4, 1], no_images: [4, 1], long_titles: [3, 1], empty: [0, 0], no_collections: [4, 0] };
    same(Object.keys(expect), [...F.CATALOG_SHAPES], "every shape is checked:");
    for (const shape of F.CATALOG_SHAPES) {
      const fx = await F.makeTenant({ name: `compat-p6-shape-${shape.replace(/_/g, "-")}`, mode: "documents", sync: "complete", catalogShape: shape });
      const c = fx.client();
      try {
        const [np, nc] = expect[shape];
        same([await count(c, "products"), await count(c, "collections"), await count(c, "variants"), await count(c, "collection_products")], [np, nc, np, nc ? np : 0], `${shape} counts:`);
        ok((await fx.run(() => SYNC.confirmedCatalogSync())).confirmed, `${shape} not confirmed`);
        const rows = (await c.execute("SELECT p.title, p.available, p.featured_image, (SELECT count(*) FROM product_images i WHERE i.product_id = p.id) AS imgs, (SELECT min(v.available) FROM variants v WHERE v.product_id = p.id) AS vavail FROM products p")).rows;
        if (shape === "all_sold_out") ok(rows.every((r) => Number(r.available) === 0 && Number(r.vavail) === 0), "a sold-out product is available");
        else ok(rows.every((r) => Number(r.available) === 1 && Number(r.vavail) === 1), `${shape}: a product is sold out`);
        if (shape === "no_images") ok(rows.every((r) => r.featured_image == null && Number(r.imgs) === 0), "no_images has an image");
        else ok(rows.every((r) => r.featured_image && Number(r.imgs) === 1), `${shape}: a product has no image`);
        if (shape === "long_titles") {
          ok(rows.every((r) => String(r.title).length > 200 && String(r.featured_image).length > 500), "long_titles: a title of 200 or fewer characters, or an image URL of 500 or fewer");
          const col = await one(c, "SELECT title, image FROM collections");
          ok(String(col.title).length > 200 && String(col.image).length > 500, "long_titles: the collection's title or image is short");
        } else ok(rows.every((r) => String(r.title).length < 200), `${shape}: a long title`);
      } finally {
        c.close();
        await fx.cleanup();
      }
    }
    // without a sync the same shape is written as before (writeProduct, writeCollection), on legacy
    const plain = await F.makeTenant({ name: "compat-p6-plain", catalogShape: "few" });
    try {
      same(await stateOf(plain), { mode: "legacy", liveRelease: null, releases: 0, documents: 0, products: 4, variants: 4, collections: 2, members: 4, runs: [] }, "few without a sync:");
    } finally {
      await plain.cleanup();
    }
    const mine = F.fixtureCollection(3, { title: "Mine", updatedAt: "2026-02-02T00:00:00Z" });
    same([mine.id, mine.handle, mine.title, mine.description, mine.updatedAt], ["gid://shopify/Collection/9203", "fixture-collection-3", "Mine", "Mine description", "2026-02-02T00:00:00Z"], "fixtureCollection(i, over):");
    same(F.fixtureCollection(1, { productIds: ["a"] }).products, { nodes: [{ id: "a" }] }, "fixtureCollection productIds:");
  });

  // P6-GEN (from the P6-FIXTURE review): the fixture moves a store to
  // documents mode through provisioning's applyContentMode, never a raw
  // UPDATE of cms_state. A cms_blocks row planted right before that step (on
  // the database the fixture just migrated) must make the move refuse, as
  // provisioning refuses a database that already holds content.
  await t("P6-GEN: makeTenant({ mode: 'documents' }) creates a documents store and leaves a crashed run's file for the next test to heal", async () => {
    const fx = await F.makeTenant({ name: "compat-p6-planted", mode: "documents" });
    try {
      eq(fx.mode, "documents", "unplanted:");
    } finally {
      await fx.cleanup();
    }
    // a crashed run's leftover file, left in place ON PURPOSE: the next test
    // (bad options are refused before any file is made) must heal it itself
    const c = createClient({ url: "file:.test-compat-p6-bad-tenant.db" });
    await c.execute("CREATE TABLE IF NOT EXISTS leftover (x)");
    c.close();
    ok(existsSync(join(ROOT, ".test-compat-p6-bad-tenant.db")), "the leftover was made");
  });

  await t("P6-FIXTURE: with no new option makeTenant is what it was (legacy, no sync_runs, no collections, the caller's config object); bad options are refused before any file is made", async () => {
    const config = { site: { name: "Plain" } };
    const fx = await F.makeTenant({ name: "compat-p6-old", products: 2, config });
    try {
      same(await stateOf(fx), { mode: "legacy", liveRelease: null, releases: 0, documents: 0, products: 2, variants: 2, collections: 0, members: 0, runs: [] }, "default store:");
      ok(fx.tenant.config === config, "the default path copied the caller's config");
      same([fx.mode, fx.sync, fx.collections, fx.syncResult], ["legacy", "none", [], null], "the handle's new fields:");
    } finally {
      await fx.cleanup();
    }
    const refusals = [
      [{ mode: "documents", stage: "0023" }, /needs stage 0024/],
      [{ sync: "complete", stage: "0017" }, /needs stage 0020/],
      [{ mode: "documentz" }, /unknown mode/],
      [{ sync: "done" }, /unknown sync/],
      [{ catalogShape: "huge" }, /unknown catalogShape/],
      [{ catalogShape: "few", products: 2 }, /not both/],
    ];
    // P6-GEN: a file left by a crashed or mutated run would fail every later
    // run's "left a database file" check; start from none
    await rm(join(ROOT, ".test-compat-p6-bad-tenant.db"), { force: true });
    for (const [opts, re] of refusals) {
      let e = null;
      try {
        await F.makeTenant({ name: "compat-p6-bad", ...opts });
      } catch (err) {
        e = err;
      }
      ok(e && re.test(e.message), `${JSON.stringify(opts)} was accepted (${e?.message})`);
      ok(!existsSync(join(ROOT, ".test-compat-p6-bad-tenant.db")), `${JSON.stringify(opts)} left a database file`);
    }
  });

  // P6-FIXTURE registers phase 6's gate suites and drill once, here (package.json
  // is its only in phase 6). A placeholder is run only while it still is one:
  // its owner replaces the file and its tests.
  await t("P6-FIXTURE: the four phase 6 suites and drill:p6 are registered; each one still a placeholder prints its line and exits 0", async () => {
    const { scripts } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const P6 = [
      ["test:first-run", "scripts/test-first-run.js", "P6-GEN"],
      ["test:brand-step", "scripts/test-brand-step.js", "P6-BRAND"],
      ["test:open-checks", "scripts/test-open-checks.js", "P6-OPEN"],
      ["test:policy-start", "scripts/test-policy-start.js", "P6-POLICY-START"],
      ["drill:p6", "scripts/drills/p6/run.mjs", "P6-DRILLS"],
    ];
    let placeholders = 0;
    for (const [name, file, owner] of P6) {
      eq(scripts[name], `node ${file}`, `${name}:`);
      const src = await readFile(join(ROOT, file), "utf8");
      if (!src.includes(`placeholder: filled by ${owner}`)) continue;
      placeholders++;
      const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH } });
      eq(r.status, 0, `${name} exit:`);
      eq(`${r.stdout}${r.stderr}`, `placeholder: filled by ${owner}\n`, `${name} output:`);
    }
    console.log(`    (${placeholders} of ${P6.length} still placeholders)`);
    eq(scripts["drill:p4"], "node scripts/drills/p4/run.mjs", "drill:p4 kept:");
  });

  // Last in this suite: makePlatform moves this process's control plane.
  await t("the tenant fixture's makePlatform registers a fixture tenant with its file URL; tenant-migrate --check reads it", async () => {
    const plat = await F.makePlatform({ name: "compat-p4" });
    const fx = await F.makeTenant({ name: "compat-p4-reg", stage: "latest", products: 1 });
    try {
      eq(plat.url, "file:.test-compat-p4-platform.db", "platform url:");
      const got = await C.getTenant("compat-p4-reg", { fresh: true });
      eq(got?.dbUrl, "file:.test-compat-p4-reg-tenant.db", "registered url:");
      eq(Number(await fx.run(async () => (await libsql.execute("SELECT count(*) AS n FROM products")).rows[0].n)), 1, "products:");
      const r = cli(["--check"], ".test-compat-p4-platform.db", envOpts);
      eq(r.status, 0, `--check on the fixture platform (output: ${r.out.trim()}):`);
      ok(r.stdout.includes(`✓ compat-p4-reg: current, all ${MIGRATIONS.length} migrations up to ${NEWEST}`), r.out);
    } finally {
      await fx.cleanup();
      await plat.cleanup();
    }
    ok(!existsSync(join(ROOT, ".test-compat-p4-platform.db")) && !existsSync(join(ROOT, ".test-compat-p4-reg-tenant.db")), "cleanup left files");
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
