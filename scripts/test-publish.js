// Atomic publish suite (P2-ATOM: PUB-01, DOC-01, PUB-02 batch acceptance).
//   pnpm test:publish
//
// Proves lib/documents/commit.js before anything depends on it:
//   - on a file: database through lib/db.js, and
//   - on a throwaway real sqld, through scripts/support/hrana-fault-proxy.js,
//     both with HEAD's lib/db.js (which retries a batch on "fetch failed") and
//     with a raw, unwrapped @libsql/client that never retries (the policy of
//     the unmerged claude/gallant-keller-7d3213 branch).
// Also: migration 0021 (tables, frozen-version triggers, documents_slug,
// cms_state seed), lib/documents/{ids,release-list}.js, and the tenant export.
//
// sqld is required. If it is missing the suite FAILS; it never skips.
// Install the Turso CLI (puts sqld in ~/.turso) or set SQLD_BIN.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const startedAt = Date.now();

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-pub-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pub-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const FILES = [".test-pub-default.db", ".test-pub-platform.db", ".test-pub-file.db", ".test-pub-x21.db", ".test-pub-x20.db"];
for (const f of FILES) await rm(join(root, f), { force: true });

const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const { stableStringify, sha256Hex } = await import("../lib/releases.js");
const { loadMigrations, runMigrations, checkLedger } = await import("../lib/platform/migrate.js");
const C = await import("../lib/platform/control.js");
const X = await import("../lib/platform/export.js");
const ids = await import("../lib/documents/ids.js");
const L = await import("../lib/documents/release-list.js");
const { commitPublishBatch, publishStatements } = await import("../lib/documents/commit.js");
const { startFaultProxy } = await import("./support/hrana-fault-proxy.js");
const H = await import("./design-harness.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e?.stack || e}`);
  }
}
const ok = (c, m = "assertion failed") => {
  if (!c) throw new Error(m);
};
const eq = (got, want, label = "") => {
  const g = stableStringify(got);
  const w = stableStringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};

const schema = await readFile(join(root, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");
const M21 = MIGRATIONS.find((m) => m.id === "0021_documents");
const SINGLETONS = ["header", "footer", "announcement", "design", "cart", "home"];

async function migrate(client, migrations = MIGRATIONS) {
  await client.executeMultiple(schema);
  await runMigrations(client, migrations);
}

// ---------- fixtures -----------------------------------------------------------

const NOW = "2026-11-04T10:00:00.000Z";

async function seedDocument(client, { id, type, slug = null, revision = 1 }) {
  await client.execute({
    sql:
      "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    args: [id, type, slug, id, JSON.stringify({ type, sections: [] }), "dh_" + id, revision, NOW, NOW],
  });
}

async function pointerOf(client) {
  const r = await client.execute("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const row = r.rows[0] || {};
  return { pointer: row.live ?? null, list: row.content ? JSON.parse(String(row.content)) : null };
}

async function counts(client) {
  const one = async (sql) => Number((await client.execute(sql)).rows[0].n);
  return {
    versions: await one("SELECT count(*) AS n FROM document_versions"),
    releases: await one("SELECT count(*) AS n FROM releases"),
    log: await one("SELECT count(*) AS n FROM publish_log"),
  };
}

async function documentsSnapshot(client) {
  const r = await client.execute("SELECT id, revision, published_version_id, published_hash FROM documents ORDER BY id");
  return r.rows.map((x) => ({ ...x }));
}

async function snapshot(client) {
  const p = await pointerOf(client);
  return { pointer: p.pointer, counts: await counts(client), documents: await documentsSnapshot(client) };
}

// A publish build: one new version per document, a list made from `prev` with
// only those documents changed, one log row each. Ids are minted once here.
async function makeBuild(client, docIds, { prev, overrides = {} } = {}) {
  const live = prev || (await pointerOf(client));
  const prevList = L.isV4List(live.list) ? live.list : L.emptyList(1, SINGLETONS);
  const setId = ids.setId();
  const versions = [];
  const documents = [];
  const log = [];
  const changes = [];
  for (const id of docIds) {
    const doc = (await client.execute({ sql: "SELECT revision, slug, type FROM documents WHERE id = ?", args: [id] })).rows[0];
    const body = { type: doc.type, sections: [{ id: "s1", type: "rich_text", settings: { text: `${id} ${setId}` } }] };
    const canonical = stableStringify(body);
    const hash = await sha256Hex(canonical);
    const v = { id: ids.verId(), document_id: id, kind: "published", body: canonical, body_hash: hash, schema_version: 1, created_at: NOW };
    versions.push(v);
    documents.push({ id, revision: Number(doc.revision), published_version_id: v.id, published_hash: hash });
    log.push({ id: ids.logId(), document_id: id, action: "publish", from_version_id: prevList.documents[id]?.version ?? null, to_version_id: v.id });
    changes.push({ document: id, entry: { version: v.id, hash }, pages: doc.slug ? [{ slug: doc.slug, type: doc.type, title: id }] : [] });
  }
  const list = L.setEntries(prevList, changes);
  return { releaseId: ids.relId(), setId, pointer: live.pointer, list, versions, documents, log, actor: "test", now: NOW, ...overrides };
}

// Every row this build would write, as present in the database now.
async function rowsOfBuild(client, b) {
  const vq = b.versions.map(() => "?").join(",") || "''";
  const lq = b.log.map(() => "?").join(",") || "''";
  const n = async (sql, args) => Number((await client.execute({ sql, args })).rows[0].n);
  return {
    versions: await n(`SELECT count(*) AS n FROM document_versions WHERE id IN (${vq})`, b.versions.map((v) => v.id)),
    releases: await n("SELECT count(*) AS n FROM releases WHERE id = ?", [b.releaseId]),
    log: await n(`SELECT count(*) AS n FROM publish_log WHERE id IN (${lq})`, b.log.map((l) => l.id)),
  };
}

async function assertAllWritten(client, b, label = "") {
  eq(await rowsOfBuild(client, b), { versions: b.versions.length, releases: 1, log: b.log.length }, `${label} rows of the build:`);
  const p = await pointerOf(client);
  eq(p.pointer, b.releaseId, `${label} pointer:`);
  const rel = (await client.execute({ sql: "SELECT published_at, content_hash, content FROM releases WHERE id = ?", args: [b.releaseId] })).rows[0];
  ok(rel.published_at, `${label} published_at was not stamped`);
  eq(String(rel.content_hash), await L.listHash(b.list), `${label} content_hash:`);
  eq(JSON.parse(String(rel.content)), b.list, `${label} stored list:`);
  for (const d of b.documents) {
    const row = (await client.execute({ sql: "SELECT published_version_id, published_hash FROM documents WHERE id = ?", args: [d.id] })).rows[0];
    eq({ ...row }, { published_version_id: d.published_version_id, published_hash: d.published_hash }, `${label} ${d.id} published_*:`);
  }
}

async function assertNothingWritten(client, b, before, label = "") {
  eq(await rowsOfBuild(client, b), { versions: 0, releases: 0, log: 0 }, `${label} rows of the build:`);
  eq(await snapshot(client), before, `${label} database changed:`);
}

// ---------- the cases that run on every backend ---------------------------------

async function commonCases(name, client, { commit }) {
  await t(`${name}: one commitPublishBatch writes versions, release, pointer, published_at, log and documents.published_* together`, async () => {
    const b = await makeBuild(client, ["doc_home", "doc_p_about"]);
    const r = await commit(b);
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, false, "reconciled:");
    await assertAllWritten(client, b);
    eq((await pointerOf(client)).pointer, b.releaseId, "pointer reads :new:");
  });

  await t(`${name}: a guard miss because the pointer moved writes nothing (changes()=0 aborts the whole batch)`, async () => {
    const b = await makeBuild(client, ["doc_home"]);
    const other = await makeBuild(client, ["doc_footer"]);
    eq((await commit(other)).outcome, "ok", "the other publish:");
    const before = await snapshot(client);
    const r = await commit(b);
    eq(r.outcome, "lost", "outcome:");
    eq(r.pointer, other.releaseId, "lost reports the pointer:");
    eq(r.list, other.list, "lost reports the live list:");
    await assertNothingWritten(client, b, before);
  });

  await t(`${name}: a documents.revision bumped between build and commit loses, with nothing written`, async () => {
    const b = await makeBuild(client, ["doc_home", "doc_footer"]);
    await client.execute("UPDATE documents SET revision = revision + 1 WHERE id = 'doc_footer'");
    const before = await snapshot(client);
    const r = await commit(b);
    eq(r.outcome, "lost", "outcome:");
    await assertNothingWritten(client, b, before);
  });

  await t(`${name}: a version with a null body fails loudly, nothing written, pointer unchanged (no silent skip)`, async () => {
    const b = await makeBuild(client, ["doc_home", "doc_footer"]);
    b.versions[1] = { ...b.versions[1], body: null };
    const before = await snapshot(client);
    const r = await commit(b);
    ok(r.outcome === "failed", `outcome: ${r.outcome} (${r.cause?.message})`);
    ok(/NOT NULL/i.test(String(r.cause?.message)), `cause: ${r.cause?.message}`);
    await assertNothingWritten(client, b, before);
  });

  await t(`${name}: a release with a null content_hash fails loudly, nothing written, pointer unchanged`, async () => {
    const b = await makeBuild(client, ["doc_home"], { overrides: { hash: null } });
    const before = await snapshot(client);
    const r = await commit(b);
    ok(r.outcome === "failed", `outcome: ${r.outcome} (${r.cause?.message})`);
    ok(/NOT NULL/i.test(String(r.cause?.message)), `cause: ${r.cause?.message}`);
    await assertNothingWritten(client, b, before);
  });

  await t(`${name}: a statement failing late in the batch (a log row after the flip) rolls back the earlier INSERTs and the flip`, async () => {
    const b = await makeBuild(client, ["doc_home"]);
    b.log[0] = { ...b.log[0], document_id: null };
    const stmts = await publishStatements(b);
    const flipAt = stmts.findIndex((s) => s.sql.startsWith("UPDATE release_state"));
    const logAt = stmts.findIndex((s) => s.sql.startsWith("INSERT INTO publish_log"));
    ok(flipAt > 0 && logAt > flipAt, "the failing log row must come after the flip");
    const before = await snapshot(client);
    const r = await commit(b);
    eq(r.outcome, "failed", "outcome:");
    await assertNothingWritten(client, b, before);
  });

  await t(`${name}: existing v3 release rows and the pointer are untouched by a failed v4 batch`, async () => {
    const v3 = { v: 3, blocks: {}, pages: [], brand: null };
    const content = stableStringify(v3);
    await client.execute({
      sql: "INSERT INTO releases (id, content, content_hash, created_at, published_at) VALUES ('rel_v3fixture000001', ?, ?, ?, ?)",
      args: [content, await sha256Hex(content), NOW, NOW],
    });
    await client.execute("UPDATE release_state SET live_release_id = 'rel_v3fixture000001' WHERE id = 1");
    const v3Rows = async () => (await client.execute("SELECT * FROM releases WHERE content NOT LIKE '{\"documents\"%' ORDER BY id")).rows.map((x) => ({ ...x }));
    const beforeRows = await v3Rows();
    const b = await makeBuild(client, ["doc_home"]);
    b.versions[0] = { ...b.versions[0], body: null };
    const before = await snapshot(client);
    eq((await commit(b)).outcome, "failed", "outcome:");
    await assertNothingWritten(client, b, before);
    eq(await v3Rows(), beforeRows, "release rows:");
    eq((await pointerOf(client)).pointer, "rel_v3fixture000001", "pointer:");
    // A v4 build on top of a v3 pointer starts from the empty list and commits.
    const b2 = await makeBuild(client, ["doc_home"]);
    eq(b2.list.documents.doc_header, null, "singleton null:");
    eq((await commit(b2)).outcome, "ok", "v4 over v3:");
    eq(await v3Rows().then((r) => r.filter((x) => x.id === "rel_v3fixture000001")), beforeRows.filter((x) => x.id === "rel_v3fixture000001"), "v3 row after the v4 publish:");
  });

  await t(`${name}: UPDATE on document_versions raises; DELETE of a non-checkpoint raises; DELETE of a checkpoint succeeds`, async () => {
    const [anyV] = (await client.execute("SELECT id FROM document_versions WHERE kind = 'published' LIMIT 1")).rows;
    let e = null;
    try {
      await client.execute({ sql: "UPDATE document_versions SET note = 'x' WHERE id = ?", args: [anyV.id] });
    } catch (err) {
      e = err;
    }
    ok(e && /versions are frozen/.test(e.message), `UPDATE: ${e?.message}`);
    e = null;
    try {
      await client.execute({ sql: "DELETE FROM document_versions WHERE id = ?", args: [anyV.id] });
    } catch (err) {
      e = err;
    }
    ok(e && /only checkpoint versions can be deleted/.test(e.message), `DELETE: ${e?.message}`);
    const cp = ids.verId();
    await client.execute({
      sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES (?, 'doc_home', 'checkpoint', '{}', 'h', 1, ?)",
      args: [cp, NOW],
    });
    const r = await client.execute({ sql: "DELETE FROM document_versions WHERE id = ?", args: [cp] });
    eq(Number(r.rowsAffected), 1, "checkpoint deleted:");
  });

  await t(`${name}: documents_slug refuses a second live draft at one slug, and allows the slug of an archived document`, async () => {
    await seedDocument(client, { id: "doc_slug_one", type: "page", slug: "taken" });
    let e = null;
    try {
      await seedDocument(client, { id: "doc_slug_two", type: "page", slug: "taken" });
    } catch (err) {
      e = err;
    }
    ok(e && /UNIQUE/i.test(e.message), `second live draft: ${e?.message}`);
    await client.execute({ sql: "UPDATE documents SET archived_at = ? WHERE id = 'doc_slug_one'", args: [NOW] });
    await seedDocument(client, { id: "doc_slug_two", type: "page", slug: "taken" });
    // Two documents without a slug never collide.
    await seedDocument(client, { id: "doc_noslug_a", type: "header" });
    await seedDocument(client, { id: "doc_noslug_b", type: "footer_x" });
  });
}

async function seedTenant(client) {
  await migrate(client);
  for (const [id, type, slug] of [
    ["doc_home", "home", null],
    ["doc_header", "header", null],
    ["doc_footer", "footer", null],
    ["doc_p_about", "page", "about"],
    ["doc_p_faq", "page", "faq"],
  ]) {
    await seedDocument(client, { id, type, slug });
  }
}

// ---------- pure: ids and the release list ------------------------------------

console.log("— ids and the release list (pure)");

await t("newRouteId: doc_ + 16 base32 characters, no repeat in 10,000 calls", async () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i++) {
    const id = ids.newRouteId();
    ok(/^doc_[a-z2-7]{16}$/.test(id), `shape: ${id}`);
    seen.add(id);
  }
  eq(seen.size, 10_000, "distinct:");
});

await t("backfillRouteId is deterministic, slug-keyed, and refuses non-route types or an empty slug", async () => {
  const a = await ids.backfillRouteId("page", "about");
  eq(a, await ids.backfillRouteId("page", "about"), "same input:");
  ok(/^doc_p_[0-9a-f]{16}$/.test(a), `shape: ${a}`);
  ok(a !== (await ids.backfillRouteId("page", "faq")), "different slug, different id");
  eq(await ids.backfillRouteId("campaign", "about"), a, "type is not hashed:");
  // Pinned: a change to the hashing would change every backfilled id.
  eq(a, "doc_p_" + (await sha256Hex("route:about")).slice(0, 16), "pinned:");
  for (const bad of [["home", "about"], ["page", ""]]) {
    let e = null;
    try {
      await ids.backfillRouteId(...bad);
    } catch (err) {
      e = err;
    }
    ok(e, `accepted ${JSON.stringify(bad)}`);
  }
});

await t("singleton ids are doc_<type>; ver/rel/log/set ids are prefixed 16 hex", async () => {
  eq(ids.singletonId("header"), "doc_header", "singleton:");
  for (const [fn, p] of [[ids.verId, "ver_"], [ids.relId, "rel_"], [ids.logId, "log_"], [ids.setId, "set_"]]) {
    ok(new RegExp(`^${p}[0-9a-f]{16}$`).test(fn()), `${p} shape`);
  }
  let e = null;
  try {
    ids.singletonId("Bad Type");
  } catch (err) {
    e = err;
  }
  ok(e, "bad type accepted");
});

await t("ids.js and release-list.js are edge-safe: no node: imports, no process, no Buffer", async () => {
  for (const f of ["lib/documents/ids.js", "lib/documents/release-list.js"]) {
    const src = await readFile(join(root, f), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    ok(!/from\s+["']node:/.test(code) && !/require\(/.test(code), `${f} imports node`);
    ok(!/\bprocess\./.test(code) && !/\bBuffer\b/.test(code), `${f} uses a Node global`);
  }
});

await t("emptyList(m) holds an explicit null for every singleton passed in", async () => {
  const l = L.emptyList(3, SINGLETONS);
  eq(l, { v: 4, m: 3, documents: Object.fromEntries(SINGLETONS.map((s) => [`doc_${s}`, null])), pages: [], redirects: [], indexes: { journal: null } }, "list:");
  for (const s of SINGLETONS) ok(Object.hasOwn(l.documents, `doc_${s}`) && l.documents[`doc_${s}`] === null, `doc_${s}`);
});

await t("setEntries keeps the nulls and replaces only the entries, pages and redirects owned by the set", async () => {
  const e = (n) => ({ version: `ver_${String(n).padStart(16, "0")}`, hash: `h${n}` });
  let l = L.emptyList(1, SINGLETONS);
  l = L.setEntries(l, [
    { document: "doc_p_a", entry: e(1), pages: [{ slug: "a", type: "page", title: "A" }], redirects: [{ from_slug: "old-a", to_slug: "a" }] },
    { document: "doc_p_b", entry: e(2), pages: [{ slug: "b", type: "page", title: "B" }], redirects: [{ from_slug: "old-b", to_slug: "b" }] },
  ]);
  const next = L.setEntries(l, [{ document: "doc_p_a", entry: e(3), pages: [{ slug: "a2", type: "page", title: "A2" }] }]);
  for (const s of SINGLETONS) eq(next.documents[`doc_${s}`], null, `doc_${s}:`);
  eq(next.documents.doc_p_a, e(3), "a replaced:");
  eq(next.documents.doc_p_b, e(2), "b kept:");
  eq(next.pages.map((p) => [p.document, p.slug]), [["doc_p_a", "a2"], ["doc_p_b", "b"]], "pages:");
  eq(next.redirects.map((r) => [r.document, r.from_slug]), [["doc_p_b", "old-b"]], "a's redirect went with a:");
  // The input list is not changed in place.
  eq(l.documents.doc_p_a, e(1), "input untouched:");
  // An entry with anything extra keeps only {version, hash}.
  const extra = L.setEntries(l, [{ document: "doc_header", entry: { ...e(9), body: "leak" } }]);
  eq(extra.documents.doc_header, e(9), "only version and hash:");
  // Removing a document drops its entry, pages and redirects.
  const removed = L.setEntries(l, [{ document: "doc_p_b", remove: true }]);
  ok(!("doc_p_b" in removed.documents) && !removed.pages.some((p) => p.document === "doc_p_b") && !removed.redirects.some((r) => r.document === "doc_p_b"), "remove");
  eq(removed.redirects.map((r) => r.document), ["doc_p_a"], "a's redirect stays:");
  // A singleton's explicit null can be set back.
  eq(L.setEntries(extra, [{ document: "doc_header", entry: null }]).documents.doc_header, null, "back to null:");
});

await t("listHash is sha256Hex(stableStringify(list)), independent of key order", async () => {
  const l = L.emptyList(1, SINGLETONS);
  eq(await L.listHash(l), await sha256Hex(stableStringify(l)), "hash:");
  eq(L.listCanonical(l), stableStringify(l), "canonical:");
  const reordered = { indexes: l.indexes, redirects: l.redirects, pages: l.pages, documents: Object.fromEntries(Object.entries(l.documents).reverse()), m: l.m, v: l.v };
  eq(await L.listHash(reordered), await L.listHash(l), "key order:");
});

await t("the list's byte size is the same with 0 and 1,000 journal posts (posts live in the journal index)", async () => {
  const sizeWith = async (n) => {
    const posts = Array.from({ length: n }, (_, i) => ({ document: `doc_j${i}`, version: `ver_${String(i).padStart(16, "0")}`, slug: `post-${i}`, title: `Post ${i}`, description: "d", enabled: true, family: "journal", effective_at: NOW, window_start: null, window_end: null }));
    const body = L.journalIndexBody(posts);
    eq(body.entries.length, n, "entries:");
    const hash = await sha256Hex(stableStringify(body));
    const list = L.setEntries(L.emptyList(1, SINGLETONS), [{ index: "journal", entry: { version: "ver_00000000000000aa", hash } }]);
    return new TextEncoder().encode(L.listCanonical(list)).length;
  };
  eq(await sizeWith(1000), await sizeWith(0), "bytes:");
});

await t("journalIndexBody entries carry slug, title, description, enabled, family, effective_at, window_start, window_end", async () => {
  const body = L.journalIndexBody([{ slug: "b", title: "B", extra: "dropped" }, { slug: "a", title: "A", enabled: false, family: "campaign", window_end: NOW }]);
  eq(body.entries.map((x) => x.slug), ["a", "b"], "sorted:");
  for (const k of ["slug", "title", "description", "enabled", "family", "effective_at", "window_start", "window_end"]) ok(k in body.entries[0], `missing ${k}`);
  ok(!("extra" in body.entries[1]), "unknown fields must not ride in");
  eq(body.entries[0].enabled, false, "enabled:");
  eq(body.entries[1].family, "journal", "default family:");
});

await t("the publish statements are in the planned order and never use INSERT OR IGNORE", async () => {
  const b = { releaseId: "rel_x", pointer: null, list: L.emptyList(1, SINGLETONS), versions: [{ id: "ver_a", document_id: "doc_home", body: "{}", body_hash: "h", schema_version: 1 }], documents: [{ id: "doc_home", revision: 1 }], log: [{ id: "log_a", document_id: "doc_home" }], setId: "set_a" };
  const stmts = await publishStatements(b);
  const kinds = stmts.map((s) => s.sql.split(" (")[0].replace(/ SET.*/, "").replace(/ WHERE.*/, ""));
  eq(kinds, ["INSERT INTO document_versions", "INSERT INTO releases", "UPDATE release_state", "INSERT INTO release_state", "UPDATE releases", "INSERT INTO publish_log", "UPDATE documents"], "order:");
  for (const s of stmts) ok(!/OR IGNORE|OR REPLACE/i.test(s.sql), `forbidden insert: ${s.sql}`);
  for (const s of stmts.filter((x) => x.sql.startsWith("INSERT INTO") && !x.sql.startsWith("INSERT INTO release_state"))) ok(/ON CONFLICT\(id\) DO NOTHING$/.test(s.sql), `no ON CONFLICT: ${s.sql}`);
  ok(/changes\(\) = 0/.test(stmts[3].sql), "abort statement");
  const src = await readFile(join(root, "lib/documents/commit.js"), "utf8");
  ok(!/\.transaction\(/.test(src.replace(/^\s*\/\/.*$/gm, "")), "commit.js must not use transaction()");
});

// ---------- migration 0021 and export -----------------------------------------

console.log("— migration 0021 and the tenant export");

await t("0021 is additive (IF NOT EXISTS / INSERT OR IGNORE only), creates none of the later tables, and re-runs cleanly", async () => {
  ok(M21, "0021_documents is not in migrations/tenant");
  const sql = M21.sql.replace(/--.*$/gm, "");
  for (const m of sql.matchAll(/\b(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER))\s+(\w+)/gi)) ok(/^IF$/i.test(m[2]), `${m[1]} without IF NOT EXISTS`);
  for (const m of sql.matchAll(/\bINSERT\s+(\w+)/gi)) ok(/^OR$/i.test(m[1]), "INSERT without OR IGNORE");
  ok(!/\b(DROP|ALTER|UPDATE|DELETE\s+FROM)\b/i.test(sql.replace(/BEFORE (UPDATE|DELETE)/gi, "")), "destructive statement");
  for (const later of ["document_refs", "document_schedules", "product_content_live", "collection_content_live", "search_outbox", "preview_sessions"]) {
    ok(!new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${later}\\b`, "i").test(sql), `creates ${later}`);
  }
  const c = createClient({ url: "file:.test-pub-x21.db" });
  await migrate(c);
  await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  await c.executeMultiple(M21.sql); // a second run changes nothing
  const rows = (await c.execute("SELECT id, mode, cutover_release_id FROM cms_state")).rows.map((x) => ({ ...x }));
  eq(rows, [{ id: 1, mode: "documents", cutover_release_id: null }], "cms_state after a re-run:");
  c.close();
});

await t("cms_state is seeded 'legacy' with one row; tenant-migrate --check's ledger check is current with 0021", async () => {
  const c = createClient({ url: "file:.test-pub-x20.db" });
  const upTo20 = MIGRATIONS.filter((m) => m.id < "0021");
  await migrate(c, upTo20);
  const at20 = await checkLedger(c, MIGRATIONS);
  eq(at20.missing, ["0021_documents"], "a 0020 tenant is missing exactly 0021:");
  // keep this tenant at 0020 for the export case below; check a fresh one at 0021
  const c21 = createClient({ url: "file:.test-pub-x21.db" });
  const ledger = await checkLedger(c21, MIGRATIONS);
  ok(ledger.current, `ledger not current: ${JSON.stringify(ledger)}`);
  eq(MIGRATIONS[MIGRATIONS.length - 1].id, "0021_documents", "newest migration:");
  const fresh = createClient({ url: "file::memory:" });
  await migrate(fresh);
  eq((await fresh.execute("SELECT id, mode FROM cms_state")).rows.map((x) => ({ ...x })), [{ id: 1, mode: "legacy" }], "seed:");
  let e = null;
  try {
    await fresh.execute("INSERT INTO cms_state (id, mode, updated_at) VALUES (2, 'documents', 'x')");
  } catch (err) {
    e = err;
  }
  ok(e && /CHECK/i.test(e.message), "cms_state must hold one row");
  for (const x of [c, c21, fresh]) x.close();
});

await t("tenant export includes documents, document_versions, publish_log and cms_state; a tenant at 0020 still exports", async () => {
  await C.migratePlatform(await readFile(join(root, "lib/platform/schema.sql"), "utf8"));
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
  await C.upsertTenant({ id: "x21", name: "X21", domains: ["x21.test"], dbUrl: "file:.test-pub-x21.db", config: {}, secrets: {} });
  await C.upsertTenant({ id: "x20", name: "X20", domains: ["x20.test"], dbUrl: "file:.test-pub-x20.db", config: {}, secrets: {} });
  const c = createClient({ url: "file:.test-pub-x21.db" });
  await seedDocument(c, { id: "doc_home", type: "home" });
  c.close();
  const e21 = await X.buildTenantExport("x21");
  eq(e21.manifest.tables.documents, 1, "documents:");
  eq(e21.manifest.tables.document_versions, 0, "document_versions:");
  eq(e21.manifest.tables.publish_log, 0, "publish_log:");
  eq(e21.manifest.tables.cms_state, 1, "cms_state:");
  eq(e21.data.documents[0].id, "doc_home", "documents data:");
  const e20 = await X.buildTenantExport("x20");
  for (const tb of ["documents", "document_versions", "publish_log", "cms_state"]) eq(e20.manifest.tables[tb], null, `${tb} at 0020 is recorded absent:`);
  eq(e20.manifest.tables.releases, 0, "the rest of a 0020 export still works:");
});

// ---------- file: through lib/db.js --------------------------------------------

console.log("— file: database through lib/db.js");
const FILE_TENANT = { id: "pub-file", dbUrl: "file:.test-pub-file.db" };
await withTenant(FILE_TENANT, async () => {
  await seedTenant(libsql);
  await commonCases("file", libsql, { commit: (b) => commitPublishBatch(b) });

  // The reconcile's classification, with a client whose batch throws a chosen
  // error and whose reads are the real database.
  const throwing = (message) => ({ batch: async () => { throw new Error(message); }, execute: (...a) => libsql.execute(...a) });
  await t("file: SQLITE_BUSY or 'database is locked' with the pointer not moved to :new is lost (busy), never ok", async () => {
    for (const msg of ["SQLITE_BUSY: database is locked", "SQLite error: database is locked"]) {
      const b = await makeBuild(libsql, ["doc_home"]);
      const r = await commitPublishBatch(b, { client: throwing(msg) });
      eq(r.outcome, "lost", `${msg}:`);
      eq(r.busy, true, "busy:");
      eq(r.pointer, (await pointerOf(libsql)).pointer, "pointer reported:");
    }
  });
  await t("file: a transport error after which the pointer is :new reconciles to ok", async () => {
    const b = await makeBuild(libsql, ["doc_header"]);
    eq((await commitPublishBatch(b)).outcome, "ok", "real commit:");
    const r = await commitPublishBatch(b, { client: throwing("fetch failed") });
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, true, "reconciled:");
  });
});

// ---------- a real sqld behind the fault proxy ----------------------------------

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let sqld = null;
let proxy = null;
let dataDir = null;
const rawClients = [];
let sqldMs = 0;
try {
  console.log("— a real sqld, through the Hrana fault proxy");
  const found = H.findSqld(); // throws (the suite fails) when sqld is missing: never a skip
  dataDir = await mkdtemp(join(tmpdir(), "storeasy-test-publish-"));
  const sqldStarted = Date.now();
  sqld = H.startSqld({ bin: found.bin, key: "publish", port: await freePort(), dataDir });
  await H.waitForHealth(sqld.url, sqld.child, { logFile: sqld.logFile, label: "test:publish" });
  proxy = startFaultProxy({ listenPort: 0, upstreamPort: sqld.port });
  await proxy.ready;
  const raw = (url = proxy.url) => {
    const c = createClient({ url });
    rawClients.push(c);
    return c;
  };
  const direct = raw(sqld.url); // inspection, never through the proxy
  const noRetry = raw(); // gallant-keller's policy: no retry on an unknown outcome
  const TENANT = { id: "pub-sqld", dbUrl: proxy.url };
  const inT = (fn) => withTenant(TENANT, fn);
  const headCommit = (b) => inT(() => commitPublishBatch(b));

  await seedTenant(direct);

  await t("sqld: the proxy forwards the version probe untouched and counts only pipeline requests", async () => {
    proxy.resetCounters();
    await inT(() => libsql.execute("SELECT 1"));
    const c = proxy.counters;
    eq(c.pipelines, 1, "pipelines:");
    eq(c.executes, 1, "executes:");
    eq(c.batches, 0, "batches:");
  });

  await commonCases("sqld (HEAD lib/db.js)", direct, { commit: headCommit });

  await t("sqld, commit_then_drop once, HEAD lib/db.js: reports ok; 2 batch requests; exactly one version, release and log row", async () => {
    const b = await makeBuild(direct, ["doc_p_faq"]);
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    const r = await headCommit(b);
    proxy.pass();
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, false, "the retry itself succeeded (idempotent), no reconcile needed:");
    eq(proxy.counters.batches, 2, "batch pipeline requests:");
    eq(proxy.counters.committedThenDropped, 1, "dropped after commit:");
    await assertAllWritten(direct, b);
  });

  await t("sqld, commit_then_drop on every attempt, HEAD lib/db.js: the error surfaces, reconcile reads the pointer and reports ok", async () => {
    const b = await makeBuild(direct, ["doc_home"]);
    proxy.resetCounters();
    proxy.commitThenDrop(Infinity);
    const r = await headCommit(b);
    proxy.pass();
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, true, "reconciled:");
    ok(/fetch failed/i.test(String(r.cause?.message)), `cause: ${r.cause?.message}`);
    eq(proxy.counters.batches, 4, "HEAD tried the batch 4 times:");
    await assertAllWritten(direct, b);
  });

  await t("sqld, commit_then_drop once, raw no-retry client: the error surfaces, reconcile reports ok", async () => {
    const b = await makeBuild(direct, ["doc_header"]);
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    const r = await commitPublishBatch(b, { client: noRetry });
    proxy.pass();
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, true, "reconciled:");
    eq(proxy.counters.batches, 1, "no retry:");
    await assertAllWritten(direct, b);
  });

  await t("sqld, the pointer moved on after our commit and before the reconcile: still ok, rows written once", async () => {
    const b = await makeBuild(direct, ["doc_p_about"]);
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    // Our batch commits, the answer is lost, then before the reconcile someone
    // else publishes on top. The no-retry client goes straight to reconcile.
    const orig = noRetry.execute.bind(noRetry);
    let moved = false;
    const client = {
      batch: (...a) => noRetry.batch(...a),
      execute: async (...a) => {
        if (!moved) {
          moved = true;
          const next = await makeBuild(direct, ["doc_footer"]);
          eq((await commitPublishBatch(next, { client: direct })).outcome, "ok", "the publish on top:");
        }
        return orig(...a);
      },
    };
    const r = await commitPublishBatch(b, { client });
    proxy.pass();
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, true, "reconciled:");
    ok((await pointerOf(direct)).pointer !== b.releaseId, "the pointer has moved on");
    eq(await rowsOfBuild(direct, b), { versions: 1, releases: 1, log: 1 }, "our rows:");
  });

  await t("sqld, drop_before once, HEAD lib/db.js: the retried batch succeeds once, with single rows", async () => {
    const b = await makeBuild(direct, ["doc_footer"]);
    proxy.resetCounters();
    proxy.dropBefore(1);
    const r = await headCommit(b);
    proxy.pass();
    eq(r.outcome, "ok", "outcome:");
    eq(proxy.counters.dropped, 1, "dropped:");
    eq(proxy.counters.batches, 2, "batch requests:");
    await assertAllWritten(direct, b);
  });

  await t("sqld, drop_before once, raw no-retry client: the batch never ran, so it is lost with nothing written", async () => {
    const b = await makeBuild(direct, ["doc_footer"]);
    const before = await snapshot(direct);
    proxy.resetCounters();
    proxy.dropBefore(1);
    const r = await commitPublishBatch(b, { client: noRetry });
    proxy.pass();
    eq(r.outcome, "lost", "outcome:");
    eq(r.pointer, before.pointer, "pointer reported:");
    await assertNothingWritten(direct, b, before);
  });

  for (const [label, run] of [
    ["raw no-retry client", (b) => commitPublishBatch(b, { client: noRetry })],
    ["HEAD lib/db.js", headCommit],
  ]) {
    await t(`sqld, the proxy drops everything (${label}): the reconcile re-read fails too, so the outcome is unknown, never lost`, async () => {
      const b = await makeBuild(direct, ["doc_home"]);
      const before = await snapshot(direct);
      proxy.resetCounters();
      proxy.dropBefore(Infinity, "any");
      const r = await run(b);
      proxy.pass();
      eq(r.outcome, "unknown", "outcome:");
      ok(!r.lost && !r.ok, "unknown is neither ok nor lost");
      ok(r.cause && r.readError, "both errors are kept");
      await assertNothingWritten(direct, b, before);
    });
  }

  await t("sqld busy case: a batch sent while a second connection holds a write transaction ends ok or lost, never partial", async () => {
    const holder = raw(sqld.url);
    const b = await makeBuild(direct, ["doc_home", "doc_p_about"]);
    const other = ids.relId();
    const content = stableStringify(L.emptyList(1, SINGLETONS));
    const before = await snapshot(direct);
    const tx = await holder.transaction("write");
    await tx.execute("SELECT 1 FROM release_state");
    await tx.execute({ sql: "INSERT INTO releases (id, content, content_hash, created_at, published_at) VALUES (?, ?, ?, ?, ?)", args: [other, content, await sha256Hex(content), NOW, NOW] });
    const pending = commitPublishBatch(b, { client: noRetry });
    await new Promise((r) => setTimeout(r, 300));
    await tx.execute({ sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", args: [other, NOW] });
    await tx.commit();
    const r = await pending;
    ok(r.outcome === "ok" || r.outcome === "lost", `outcome: ${r.outcome} ${r.cause?.message}`);
    const rows = await rowsOfBuild(direct, b);
    if (r.outcome === "ok") {
      await assertAllWritten(direct, b, "ok:");
    } else {
      eq(rows, { versions: 0, releases: 0, log: 0 }, "lost leaves no rows:");
      eq((await pointerOf(direct)).pointer, other, "the holder's pointer:");
      eq(await documentsSnapshot(direct), before.documents, "documents:");
    }
    console.log(`    (busy case ended ${r.outcome}${r.busy ? ", busy" : ""}: ${String(r.cause?.message || "").slice(0, 80)})`);
  });

  await t("sqld, hold: two builds from one pointer for different documents; the first commits, the second loses with nothing persisted; a rebuild commits and both are live", async () => {
    const start = await pointerOf(direct);
    const a = await makeBuild(direct, ["doc_p_about"], { prev: start });
    const bb = await makeBuild(direct, ["doc_p_faq"], { prev: start });
    proxy.resetCounters();
    proxy.hold("batch");
    const pa = headCommit(a);
    const pb = headCommit(bb);
    await proxy.waitHeld(2);
    const beforeA = await snapshot(direct);
    proxy.release(a.releaseId);
    const ra = await pa;
    eq(ra.outcome, "ok", "first:");
    const afterA = await snapshot(direct);
    ok(stableStringify(afterA) !== stableStringify(beforeA), "the first wrote");
    proxy.release(bb.releaseId);
    const rb = await pb;
    proxy.pass();
    eq(rb.outcome, "lost", "second:");
    eq(rb.pointer, a.releaseId, "lost names the new pointer:");
    await assertNothingWritten(direct, bb, afterA, "second:");
    // Rebuild from what the loss handed back.
    const again = await makeBuild(direct, ["doc_p_faq"], { prev: { pointer: rb.pointer, list: rb.list } });
    eq((await headCommit(again)).outcome, "ok", "rebuild:");
    const live = await pointerOf(direct);
    eq(live.list.documents.doc_p_about, a.list.documents.doc_p_about, "first entry live:");
    eq(live.list.documents.doc_p_faq, again.list.documents.doc_p_faq, "rebuilt entry live:");
    eq(live.list.pages.map((p) => p.slug), ["about", "faq"], "both pages:");
    for (const s of SINGLETONS) eq(live.list.documents[`doc_${s}`] === undefined, false, `doc_${s} kept in the list:`);
  });
  sqldMs = Date.now() - sqldStarted;
} catch (e) {
  fail++;
  console.error(`  ✗ the sqld cases could not run: ${e?.message || e}`);
} finally {
  for (const c of rawClients) {
    try {
      c.close();
    } catch {}
  }
  if (proxy) await proxy.close().catch(() => {});
  if (sqld) await H.stopChild(sqld.child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  for (const f of FILES) await rm(join(root, f), { force: true });
}

console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (sqld part ${(sqldMs / 1000).toFixed(1)}s).`);
process.exit(fail ? 1 : 0);
