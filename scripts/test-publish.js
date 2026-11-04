// Atomic publish suite (P2-ATOM: PUB-01, DOC-01, PUB-02 batch acceptance;
// hardened by P2-HARDEN: version and release id clashes, BAD_BUILD,
// MISSING_DOCUMENT, the reconcile's release-row proof).
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
// Ports: TEST_PUBLISH_PORTS="<sqld>,<proxy>" picks them; otherwise free ports.
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

const FILES = [".test-pub-default.db", ".test-pub-platform.db", ".test-pub-file.db", ".test-pub-x21.db", ".test-pub-x20.db", ".test-pub-x23.db", ".test-pub-x22.db"];
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
const M23 = MIGRATIONS.find((m) => m.id === "0023_document_refs");
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
async function makeBuild(client, docIds, { prev, overrides = {}, verIds = {} } = {}) {
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
    const v = { id: verIds[id] || ids.verId(), document_id: id, kind: "published", body: canonical, body_hash: hash, schema_version: 1, created_at: NOW };
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

  await t(`${name}: a build reusing another document's version id never reports ok, and nothing is written (P2-HARDEN)`, async () => {
    const home = await makeBuild(client, ["doc_home"]);
    eq((await commit(home)).outcome, "ok", "publish doc_home:");
    const taken = home.versions[0].id;
    eq((await pointerOf(client)).list.documents.doc_home.version, taken, "doc_home is live at the reused id:");
    const ownerRow = async () => ({ ...(await client.execute({ sql: "SELECT document_id, body_hash FROM document_versions WHERE id = ?", args: [taken] })).rows[0] });
    const owner = await ownerRow();
    // (a) the id of doc_home's live version, reused for doc_footer with the very
    //     same body, so only the document differs
    const other = await makeBuild(client, ["doc_footer"], { verIds: { doc_footer: taken } });
    other.versions[0] = { ...other.versions[0], body: home.versions[0].body, body_hash: owner.body_hash };
    // (b) the same id reused for doc_home itself, with a different body, so only
    //     the body differs
    const sameDoc = await makeBuild(client, ["doc_home"], { verIds: { doc_home: taken } });
    ok(sameDoc.versions[0].body_hash !== owner.body_hash, "case (b) needs a different body");
    for (const [label, b] of [["other document", other], ["same document, other body", sameDoc]]) {
      const before = await snapshot(client);
      const r = await commit(b);
      ok(r.outcome !== "ok", `${label}: reported ok`);
      eq(r.outcome, "failed", `${label} outcome:`);
      eq(r.code, "VERSION_ID_CLASH", `${label} code:`);
      eq(await snapshot(client), before, `${label} database changed:`);
      eq(Number((await client.execute({ sql: "SELECT count(*) AS n FROM releases WHERE id = ?", args: [b.releaseId] })).rows[0].n), 0, `${label} release row:`);
      eq(Number((await client.execute({ sql: "SELECT count(*) AS n FROM publish_log WHERE id = ?", args: [b.log[0].id] })).rows[0].n), 0, `${label} log row:`);
      eq(await ownerRow(), owner, `${label} the old row:`);
    }
  });

  await t(`${name}: a build reusing an existing release id never reports ok (the content_hash check in the flip guard) (P2-HARDEN)`, async () => {
    const a = await makeBuild(client, ["doc_header"]);
    eq((await commit(a)).outcome, "ok", "publish a:");
    const c = await makeBuild(client, ["doc_p_faq"]);
    eq((await commit(c)).outcome, "ok", "publish c:");
    // (a) an older release id; (b) the live release id (the retry term matches it)
    for (const [label, reused] of [["older release", a.releaseId], ["live release", c.releaseId]]) {
      const b = await makeBuild(client, ["doc_footer"], { overrides: { releaseId: reused } });
      const before = await snapshot(client);
      const relBefore = (await client.execute({ sql: "SELECT content, content_hash, published_at FROM releases WHERE id = ?", args: [reused] })).rows.map((x) => ({ ...x }));
      const r = await commit(b);
      ok(r.outcome !== "ok", `${label}: reported ok`);
      eq(r.outcome, "failed", `${label} outcome:`);
      eq(r.code, "RELEASE_ID_CLASH", `${label} code:`);
      eq(await snapshot(client), before, `${label} database changed:`);
      eq(before.pointer, c.releaseId, `${label} pointer:`);
      eq((await client.execute({ sql: "SELECT content, content_hash, published_at FROM releases WHERE id = ?", args: [reused] })).rows.map((x) => ({ ...x })), relBefore, `${label} the old release row:`);
    }
  });

  await t(`${name}: a build naming a document missing from the documents table fails (MISSING_DOCUMENT), not lost; a real revision race still loses (P2-HARDEN)`, async () => {
    const b = await makeBuild(client, ["doc_home"]);
    b.documents.push({ id: "doc_ghost", revision: 1, published_version_id: null, published_hash: null });
    const before = await snapshot(client);
    const r = await commit(b);
    eq(r.outcome, "failed", "outcome:");
    eq(r.code, "MISSING_DOCUMENT", "code:");
    eq(r.missing, ["doc_ghost"], "missing:");
    await assertNothingWritten(client, b, before);
    const race = await makeBuild(client, ["doc_home"]);
    await client.execute("UPDATE documents SET revision = revision + 1 WHERE id = 'doc_home'");
    const before2 = await snapshot(client);
    const r2 = await commit(race);
    eq(r2.outcome, "lost", "the revision race:");
    ok(!r2.code, "a loss carries no failure code");
    await assertNothingWritten(client, race, before2);
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

// ---------- P3-COMMIT: undo-shaped builds -------------------------------------
// A build as Undo and take offline make it: a fresh published version of the
// target body, the draft rewritten (slug, label, revision + 1), undone_version_id
// set, the pointer fields null (taken offline), an undo_saved extra version, an
// undo log row with undoes_log_id and saved_version_id, and refs rows.

let undoSeq = 0;
async function seedUndoDoc(client, { slug } = {}) {
  undoSeq++;
  const id = `doc_p_undo${String(undoSeq).padStart(4, "0")}`;
  await seedDocument(client, { id, type: "page", slug: slug ?? `undo-${undoSeq}` });
  return id;
}

async function makeUndoBuild(client, id, { prev, slug, label = "Earlier about", expectPublished, savedBody, overrides = {} } = {}) {
  const live = prev || (await pointerOf(client));
  const prevList = L.isV4List(live.list) ? live.list : L.emptyList(1, SINGLETONS);
  const doc = (await client.execute({ sql: "SELECT revision, slug, type FROM documents WHERE id = ?", args: [id] })).rows[0];
  const setId = ids.setId();
  const target = { type: doc.type, meta: { slug: slug ?? String(doc.slug), title: label }, sections: [{ id: "s1", type: "rich_text", settings: { text: `target ${id} ${setId}` } }] };
  const canonical = stableStringify(target);
  const hash = await sha256Hex(canonical);
  const v = { id: ids.verId(), document_id: id, kind: "published", body: canonical, body_hash: hash, schema_version: 1, created_at: NOW };
  const keptText = stableStringify(savedBody === undefined ? { type: doc.type, sections: [], kept: setId } : savedBody);
  const saved = { id: ids.verId(), document_id: id, kind: "undo_saved", body: savedBody === null ? null : keptText, body_hash: await sha256Hex(keptText), schema_version: 1, note: "Kept before Undo", created_at: NOW };
  const undone = prevList.documents[id]?.version ?? null;
  const d = {
    id,
    revision: Number(doc.revision),
    published: { versionId: null, hash: null },
    undone,
    draft: { body: target, hash: `dh_undo_${setId}`, slug: target.meta.slug, label, by: "merchant:u_test", at: NOW },
  };
  if (expectPublished !== undefined) d.expectPublished = expectPublished;
  const list = L.setEntries(prevList, [{ document: id, entry: { version: v.id, hash }, pages: [{ slug: target.meta.slug, type: doc.type, title: label, enabled: false }] }]);
  return {
    releaseId: ids.relId(),
    setId,
    pointer: live.pointer,
    list,
    versions: [v],
    extraVersions: [saved],
    documents: [d],
    log: [{ id: ids.logId(), document_id: id, action: "undo", from_version_id: undone, to_version_id: v.id, undoes_log_id: `log_undone_${setId.slice(4)}`, saved_version_id: saved.id }],
    refs: [
      { version_id: v.id, ref_type: "collection", ref_id: "shirts" },
      { version_id: v.id, ref_type: "document", ref_id: "doc_p_faq" },
    ],
    actor: "test",
    now: NOW,
    ...overrides,
  };
}

const docRow = async (client, id) => ({ ...(await client.execute({ sql: "SELECT * FROM documents WHERE id = ?", args: [id] })).rows[0] });
async function undoRows(client, b) {
  const n = async (sql, args) => Number((await client.execute({ sql, args })).rows[0].n);
  return {
    versions: await n("SELECT count(*) AS n FROM document_versions WHERE id = ?", [b.versions[0].id]),
    saved: await n("SELECT count(*) AS n FROM document_versions WHERE id = ? AND kind = 'undo_saved'", [b.extraVersions[0].id]),
    releases: await n("SELECT count(*) AS n FROM releases WHERE id = ?", [b.releaseId]),
    log: await n("SELECT count(*) AS n FROM publish_log WHERE id = ?", [b.log[0].id]),
    refs: await n("SELECT count(*) AS n FROM document_refs WHERE version_id = ?", [b.versions[0].id]),
  };
}
const NONE = { versions: 0, saved: 0, releases: 0, log: 0, refs: 0 };
const ALL = { versions: 1, saved: 1, releases: 1, log: 1, refs: 2 };

async function assertUndoWritten(client, b, before, label = "") {
  eq(await undoRows(client, b), ALL, `${label} rows:`);
  eq((await pointerOf(client)).pointer, b.releaseId, `${label} pointer:`);
  const d = b.documents[0];
  const row = await docRow(client, d.id);
  eq(
    { draft: JSON.parse(String(row.draft)), draft_hash: row.draft_hash, slug: row.slug, label: row.label, revision: Number(row.revision), updated_at: row.updated_at, updated_by: row.updated_by, undone_version_id: row.undone_version_id, published_version_id: row.published_version_id, published_hash: row.published_hash },
    { draft: d.draft.body, draft_hash: d.draft.hash, slug: d.draft.slug, label: d.draft.label, revision: Number(before.revision) + 1, updated_at: NOW, updated_by: d.draft.by, undone_version_id: d.undone, published_version_id: null, published_hash: null },
    `${label} documents row:`,
  );
  const log = (await client.execute({ sql: "SELECT action, undoes_log_id, saved_version_id, from_version_id, to_version_id FROM publish_log WHERE id = ?", args: [b.log[0].id] })).rows[0];
  eq({ ...log }, { action: "undo", undoes_log_id: b.log[0].undoes_log_id, saved_version_id: b.extraVersions[0].id, from_version_id: b.log[0].from_version_id, to_version_id: b.versions[0].id }, `${label} log row:`);
  const refs = (await client.execute({ sql: "SELECT ref_type, ref_id FROM document_refs WHERE version_id = ? ORDER BY ref_type, ref_id", args: [b.versions[0].id] })).rows.map((x) => ({ ...x }));
  eq(refs, b.refs.map((r) => ({ ref_type: r.ref_type, ref_id: r.ref_id })), `${label} refs:`);
}
async function assertUndoNothing(client, b, before, label = "") {
  eq(await undoRows(client, b), NONE, `${label} rows:`);
  eq(await docRow(client, b.documents[0].id), before, `${label} documents row:`);
}

async function undoCases(name, client, { commit }) {
  await t(`${name}: P3-COMMIT an undo-shaped build (draft rewrite with slug and label, revision+1, undone, published null, undo_saved, undo log row, refs) commits all together`, async () => {
    const id = await seedUndoDoc(client);
    const first = await makeBuild(client, [id]);
    eq((await commit(first)).outcome, "ok", "publish it first:");
    const before = await docRow(client, id);
    const b = await makeUndoBuild(client, id, { slug: `${before.slug}-earlier`, label: "Earlier words" });
    const r = await commit(b);
    eq(r.outcome, "ok", `outcome (${r.code || ""} ${r.cause?.message || ""}):`);
    eq(r.reconciled, false, "reconciled:");
    await assertUndoWritten(client, b, before);
    eq((await pointerOf(client)).list.pages.find((p) => p.document === id)?.enabled, false, "its page row is offline:");
  });

  await t(`${name}: P3-COMMIT an undo-shaped build whose last statement fails writes nothing: no draft change, no undo_saved, no refs, no log row`, async () => {
    const id = await seedUndoDoc(client);
    const before = await docRow(client, id);
    const b = await makeUndoBuild(client, id, { slug: `${before.slug}-x` });
    b.refs = [...b.refs, { version_id: b.versions[0].id, ref_type: "collection", ref_id: "shirts" }]; // a duplicate primary key is absorbed…
    b.log[0] = { ...b.log[0], document_id: null }; // …but a log row without a document is refused
    const r = await commit(b);
    eq(r.outcome, "failed", "outcome:");
    await assertUndoNothing(client, b, before);
  });

  await t(`${name}: P3-COMMIT a lost pointer race leaves no undo_saved, refs or log row and the draft as it was`, async () => {
    const id = await seedUndoDoc(client);
    const b = await makeUndoBuild(client, id);
    const other = await makeBuild(client, ["doc_footer"]);
    eq((await commit(other)).outcome, "ok", "the other publish:");
    const before = await docRow(client, id);
    const r = await commit(b);
    eq(r.outcome, "lost", "outcome:");
    await assertUndoNothing(client, b, before);
  });

  await t(`${name}: P3-COMMIT expectPublished that no longer matches makes the batch lose with nothing written; a matching one commits`, async () => {
    const id = await seedUndoDoc(client);
    const first = await makeBuild(client, [id]);
    eq((await commit(first)).outcome, "ok", "publish it first:");
    const live = first.versions[0].id;
    const stale = await makeUndoBuild(client, id, { expectPublished: "ver_0000000000000bad" });
    const before = await docRow(client, id);
    const r = await commit(stale);
    eq(r.outcome, "lost", "a stale expectPublished:");
    await assertUndoNothing(client, stale, before);
    const nullish = await makeUndoBuild(client, id, { expectPublished: null });
    eq((await commit(nullish)).outcome, "lost", "expectPublished null while one is live:");
    await assertUndoNothing(client, nullish, before);
    const good = await makeUndoBuild(client, id, { expectPublished: live });
    eq((await commit(good)).outcome, "ok", "the matching one:");
    await assertUndoWritten(client, good, before);
  });

  await t(`${name}: P3-COMMIT the flip refuses when an extraVersions row is missing (statement left out, or its id held by another body)`, async () => {
    const id = await seedUndoDoc(client);
    const b = await makeUndoBuild(client, id);
    const stmts = await publishStatements(b);
    const extraAt = stmts.findIndex((s) => s.sql.startsWith("INSERT INTO document_versions") && s.args[0] === b.extraVersions[0].id);
    ok(extraAt >= 0, "the extra version has its own INSERT");
    const flip = stmts.find((s) => s.sql.startsWith("UPDATE release_state"));
    ok(flip.args.includes(b.extraVersions[0].id), "the flip guard names the extra version");
    const before = await docRow(client, id);
    let e = null;
    try {
      await client.batch(stmts.filter((_, i) => i !== extraAt), "write");
    } catch (err) {
      e = err;
    }
    ok(e && /CHECK constraint failed/i.test(e.message), `the batch without the extra row: ${e?.message}`);
    await assertUndoNothing(client, b, before, "without the row:");
    // the extra id already belongs to another body: ON CONFLICT DO NOTHING keeps the old row, the count misses
    const clash = await makeUndoBuild(client, id);
    await client.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES (?, ?, 'undo_saved', '{}', 'other', 1, ?)", args: [clash.extraVersions[0].id, id, NOW] });
    const r = await commit(clash);
    eq(r.outcome, "failed", "outcome:");
    eq(r.code, "VERSION_ID_CLASH", "code:");
    eq({ ...(await undoRows(client, clash)), saved: 1 }, { ...NONE, saved: 1 }, "only the old row:");
    eq(await docRow(client, id), before, "documents row:");
  });

  await t(`${name}: P3-COMMIT P2's 'null body or null hash' still fails whole, and so does an undo_saved with a null body`, async () => {
    const id = await seedUndoDoc(client);
    const before = await docRow(client, id);
    for (const [label, edit] of [
      ["published version body null", (b) => { b.versions[0] = { ...b.versions[0], body: null }; }],
      ["release hash null", (b) => { b.hash = null; }],
      ["undo_saved body null", (b) => { b.extraVersions[0] = { ...b.extraVersions[0], body: null }; }],
    ]) {
      const b = await makeUndoBuild(client, id);
      edit(b);
      const r = await commit(b);
      eq(r.outcome, "failed", `${label} outcome:`);
      ok(/NOT NULL/i.test(String(r.cause?.message)), `${label} cause: ${r.cause?.message}`);
      await assertUndoNothing(client, b, before, `${label}:`);
    }
  });

  await t(`${name}: P3-COMMIT a draft slug another non-archived draft holds is failed SLUG_TAKEN (not DB_REFUSED), nothing written; an archived holder doesn't count`, async () => {
    const holder = await seedUndoDoc(client, { slug: `held-${undoSeq + 1}` });
    const heldSlug = String((await docRow(client, holder)).slug);
    const id = await seedUndoDoc(client);
    const before = await docRow(client, id);
    const b = await makeUndoBuild(client, id, { slug: heldSlug });
    const r = await commit(b);
    eq(r.outcome, "failed", "outcome:");
    eq(r.code, "SLUG_TAKEN", "code:");
    eq(r.slugs, [heldSlug], "slugs:");
    await assertUndoNothing(client, b, before);
    await client.execute({ sql: "UPDATE documents SET archived_at = ? WHERE id = ?", args: [NOW, holder] });
    const again = await makeUndoBuild(client, id, { slug: heldSlug });
    eq((await commit(again)).outcome, "ok", "once the holder is archived:");
    eq(String((await docRow(client, id)).slug), heldSlug, "slug:");
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

// P3-COMMIT: the order with the new parts, and the draft columns.
await t("P3-COMMIT: an undo-shaped build's statements: the extra version beside the versions, the draft in the documents UPDATE, refs last, ON CONFLICT everywhere", async () => {
  const draft = { body: { type: "page", sections: [] }, hash: "dh", slug: "about-old", label: "About", by: "merchant:u", at: NOW };
  const b = {
    releaseId: "rel_x",
    pointer: null,
    list: L.emptyList(1, SINGLETONS),
    versions: [{ id: "ver_a", document_id: "doc_p_a", body: "{}", body_hash: "h", schema_version: 1 }],
    extraVersions: [{ id: "ver_s", document_id: "doc_p_a", kind: "undo_saved", body: "{}", body_hash: "hs", schema_version: 1 }],
    documents: [{ id: "doc_p_a", revision: 4, published: { versionId: null, hash: null }, undone: "ver_old", expectPublished: "ver_old", draft }],
    log: [{ id: "log_a", document_id: "doc_p_a", action: "undo", undoes_log_id: "log_u", saved_version_id: "ver_s" }],
    refs: [{ version_id: "ver_a", ref_type: "collection", ref_id: "shirts" }],
    setId: "set_a",
  };
  const stmts = await publishStatements(b);
  const kinds = stmts.map((x) => x.sql.split(" (")[0].replace(/ SET.*/, "").replace(/ WHERE.*/, "").replace(/ VALUES.*/, ""));
  eq(kinds, ["INSERT INTO document_versions", "INSERT INTO document_versions", "INSERT INTO releases", "UPDATE release_state", "INSERT INTO release_state", "UPDATE releases", "INSERT INTO publish_log", "UPDATE documents", "INSERT INTO document_refs"], "order:");
  for (const x of stmts) ok(!/OR IGNORE|OR REPLACE/i.test(x.sql), `forbidden insert: ${x.sql}`);
  ok(/ON CONFLICT DO NOTHING$/.test(stmts[8].sql), "refs: ON CONFLICT DO NOTHING");
  const flip = stmts[3];
  ok(/\(SELECT revision FROM documents WHERE id = \? AND published_version_id IS \? AND archived_at IS NULL\) = \?/.test(flip.sql), `the document's guard: ${flip.sql}`);
  ok(/= \?\)? AND|\) = \?/.test(flip.sql) && flip.args.includes("ver_s") && flip.args.includes(2), "the flip counts both version rows");
  const upd = stmts[7];
  const set = /^UPDATE documents SET (.*) WHERE id = \?$/.exec(upd.sql)[1].split(", ").map((c) => c.split(" = ")[0]);
  eq(set, ["published_version_id", "published_hash", "undone_version_id", "draft", "draft_hash", "slug", "label", "revision", "updated_at", "updated_by"], "documents UPDATE columns:");
  eq(upd.args, [null, null, "ver_old", JSON.stringify(draft.body), "dh", "about-old", "About", NOW, "merchant:u", "doc_p_a"], "documents UPDATE values:");
});

await t("P3-COMMIT: the commit's draft UPDATE sets exactly the columns service.draftWrite sets", async () => {
  const src = await readFile(join(root, "lib/documents/service.js"), "utf8");
  const m = /function draftWrite\([^)]*\) \{[\s\S]*?sql: "UPDATE documents SET (.*?) WHERE/.exec(src);
  ok(m, "can't read service.js draftWrite");
  const service = m[1].split(", ").map((c) => c.split(" = ")[0].trim());
  const { DRAFT_COLUMNS } = await import("../lib/documents/commit.js");
  eq([...DRAFT_COLUMNS], service, "DRAFT_COLUMNS vs draftWrite:");
  const stmts = await publishStatements({
    releaseId: "rel_x",
    list: L.emptyList(1, SINGLETONS),
    documents: [{ id: "doc_p_a", revision: 1, draft: { body: { type: "page" }, hash: "dh", slug: null, label: "A" } }],
  });
  const upd = stmts.find((x) => x.sql.startsWith("UPDATE documents"));
  const cols = /^UPDATE documents SET (.*) WHERE/.exec(upd.sql)[1].split(", ").map((c) => c.split(" = ")[0]);
  eq(cols.filter((c) => !["published_version_id", "published_hash"].includes(c)), service, "commit's draft columns vs draftWrite:");
});

await t("a malformed build returns {failed, code BAD_BUILD} with no database call (P2-HARDEN)", async () => {
  let calls = 0;
  const spy = { batch: async () => { calls++; return []; }, execute: async () => { calls++; return { rows: [] }; } };
  const good = () => ({
    releaseId: "rel_0000000000000001",
    pointer: null,
    list: L.emptyList(1, SINGLETONS),
    versions: [{ id: "ver_0000000000000001", document_id: "doc_home", body: "{}", body_hash: "h1", schema_version: 1 }],
    documents: [{ id: "doc_home", revision: 1, published_version_id: "ver_0000000000000001", published_hash: "h1" }],
    log: [{ id: "log_0000000000000001", document_id: "doc_home" }],
    setId: "set_0000000000000001",
  });
  const cases = [
    ["undefined revision", (b) => { b.documents[0].revision = undefined; }],
    ["revision as a string", (b) => { b.documents[0].revision = "1"; }],
    ["revision 1.5", (b) => { b.documents[0].revision = 1.5; }],
    ["a document without an id", (b) => { delete b.documents[0].id; }],
    ["a document named twice", (b) => { b.documents.push({ ...b.documents[0] }); }],
    ["no documents", (b) => { b.documents = []; }],
    ["no release id", (b) => { delete b.releaseId; }],
    ["a blank release id", (b) => { b.releaseId = " "; }],
    ["a version without an id", (b) => { delete b.versions[0].id; }],
    ["a version without a document_id", (b) => { b.versions[0].document_id = undefined; }],
    ["a version without a body_hash", (b) => { delete b.versions[0].body_hash; }],
    ["a version id used twice", (b) => { b.versions.push({ ...b.versions[0] }); }],
    ["a log row without an id", (b) => { delete b.log[0].id; }],
    ["a pointer that is a number", (b) => { b.pointer = 7; }],
    ["no list", (b) => { delete b.list; }],
    ["a schema_version of NaN (caught in the arguments)", (b) => { b.versions[0].schema_version = NaN; }],
    ["a note that is an object (caught in the arguments)", (b) => { b.note = { x: 1 }; }],
    // P3-COMMIT
    ["a draft without a body", (b) => { b.documents[0].draft = { hash: "h", slug: null, label: "A" }; }],
    ["a draft without a label", (b) => { b.documents[0].draft = { body: {}, hash: "h", slug: null }; }],
    ["undone that is a number", (b) => { b.documents[0].undone = 3; }],
    ["expectPublished that is an object", (b) => { b.documents[0].expectPublished = {}; }],
    ["published that is a string", (b) => { b.documents[0].published = "ver_x"; }],
    ["an extra version of another kind", (b) => { b.extraVersions = [{ id: "ver_0000000000000002", document_id: "doc_home", kind: "published", body: "{}", body_hash: "h" }]; }],
    ["an extra version reusing a version id", (b) => { b.extraVersions = [{ id: "ver_0000000000000001", document_id: "doc_home", kind: "undo_saved", body: "{}", body_hash: "h" }]; }],
    ["a ref naming a version outside the build", (b) => { b.refs = [{ version_id: "ver_elsewhere", ref_type: "media", ref_id: "m" }]; }],
    ["a ref without a ref_id", (b) => { b.refs = [{ version_id: "ver_0000000000000001", ref_type: "media" }]; }],
    ["not an object", () => null],
  ];
  for (const [label, edit] of cases) {
    let b = good();
    const replaced = edit(b);
    if (replaced === null) b = null;
    calls = 0;
    const r = await commitPublishBatch(b, { client: spy });
    eq(r.outcome, "failed", `${label} outcome:`);
    eq(r.code, "BAD_BUILD", `${label} code:`);
    ok(Array.isArray(r.problems) && r.problems.length > 0, `${label}: no problems listed`);
    eq(calls, 0, `${label} database calls:`);
  }
  let e = null;
  try {
    const b = good();
    b.documents[0].revision = undefined;
    await publishStatements(b);
  } catch (err) {
    e = err;
  }
  eq(e?.code, "BAD_BUILD", "publishStatements throws BAD_BUILD:");
  calls = 0;
  eq((await commitPublishBatch(good(), { client: spy })).outcome, "ok", "the good build:");
  eq(calls, 1, "the good build makes one batch call:");
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
  // P2-PREVIEW: 0022 (preview_sessions) follows 0021; a 0020 tenant misses both
  eq(at20.missing, MIGRATIONS.filter((m) => m.id >= "0021").map((m) => m.id), "a 0020 tenant is missing exactly 0021 and later:");
  eq(at20.missing[0], "0021_documents", "first missing:");
  // keep this tenant at 0020 for the export case below; check a fresh one at 0021
  const c21 = createClient({ url: "file:.test-pub-x21.db" });
  const ledger = await checkLedger(c21, MIGRATIONS);
  ok(ledger.current, `ledger not current: ${JSON.stringify(ledger)}`);
  ok(MIGRATIONS.some((m) => m.id === "0021_documents"), "0021_documents is shipped");
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

await t("P3-COMMIT: 0023 is additive (IF NOT EXISTS only) and applies twice cleanly; its tables and indexes are there", async () => {
  ok(M23, "0023_document_refs is not in migrations/tenant");
  const sql = M23.sql.replace(/--.*$/gm, "");
  for (const m of sql.matchAll(/\b(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER))\s+(\w+)/gi)) ok(/^IF$/i.test(m[2]), `${m[1]} without IF NOT EXISTS`);
  ok(!/\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i.test(sql), "a statement that is not CREATE … IF NOT EXISTS");
  const c = createClient({ url: "file:.test-pub-x23.db" });
  await migrate(c, MIGRATIONS.filter((m) => m.id < "0023"));
  eq((await checkLedger(c, MIGRATIONS)).missing, ["0023_document_refs"], "a 0022 store misses exactly 0023:");
  await runMigrations(c, MIGRATIONS);
  await c.executeMultiple(M23.sql); // a second run changes nothing
  await c.executeMultiple(M23.sql);
  ok((await checkLedger(c, MIGRATIONS)).current, "current after 0023");
  const names = (await c.execute("SELECT name FROM sqlite_master WHERE name IN ('document_refs', 'document_refs_target', 'publish_log_set', 'publish_log_undoes', 'publish_log_recent') ORDER BY name")).rows.map((r) => String(r.name));
  eq(names, ["document_refs", "document_refs_target", "publish_log_recent", "publish_log_set", "publish_log_undoes"], "objects:");
  eq((await c.execute("PRAGMA table_info(document_refs)")).rows.map((r) => [String(r.name), Number(r.pk)]), [["version_id", 1], ["ref_type", 2], ["ref_id", 3]], "columns and primary key:");
  await c.execute("INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ('ver_a', 'media', 'm1') ON CONFLICT DO NOTHING");
  await c.execute("INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ('ver_a', 'media', 'm1') ON CONFLICT DO NOTHING");
  eq(Number((await c.execute("SELECT count(*) AS n FROM document_refs")).rows[0].n), 1, "a repeated row is absorbed:");
  const plan = async (q) => (await c.execute(`EXPLAIN QUERY PLAN ${q}`)).rows.map((r) => String(r.detail)).join(" ");
  // set_id is NOT NULL, and SQLite does not infer "set_id IS NOT NULL" from
  // "set_id = ?" for that column: a query must say it to use publish_log_set
  // (a known limit for P3-UNDO's whole-set read)
  const setPlan = await plan("SELECT * FROM publish_log WHERE set_id = 'set_x' AND set_id IS NOT NULL");
  ok(/publish_log_set/.test(setPlan), `set_id lookups (with IS NOT NULL) use the index: ${setPlan}`);
  const undoesPlan = await plan("SELECT * FROM publish_log WHERE undoes_log_id = 'log_x'");
  ok(/publish_log_undoes/.test(undoesPlan), `undoes_log_id lookups use the index: ${undoesPlan}`);
  const recentPlan = await plan("SELECT * FROM publish_log ORDER BY created_at DESC LIMIT 20");
  ok(/publish_log_recent/.test(recentPlan), `the recent list uses the index: ${recentPlan}`);
  const refsPlan = await plan("SELECT * FROM document_refs WHERE ref_type = 'document' AND ref_id = 'doc_x'");
  ok(/document_refs_target/.test(refsPlan), `linkers use the target index: ${refsPlan}`);
  c.close();
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
  // P3-COMMIT: document_refs (0023)
  eq(e21.manifest.tables.document_refs, 0, "document_refs:");
  ok(Array.isArray(e21.data.document_refs), "document_refs data:");
  eq(e21.data.documents[0].id, "doc_home", "documents data:");
  const e20 = await X.buildTenantExport("x20");
  for (const tb of ["documents", "document_versions", "publish_log", "cms_state", "document_refs"]) eq(e20.manifest.tables[tb], null, `${tb} at 0020 is recorded absent:`);
  // a tenant at 0022: the documents tables export, document_refs is absent
  const c22 = createClient({ url: "file:.test-pub-x22.db" });
  await migrate(c22, MIGRATIONS.filter((m) => m.id < "0023"));
  c22.close();
  await C.upsertTenant({ id: "x22", name: "X22", domains: ["x22.test"], dbUrl: "file:.test-pub-x22.db", config: {}, secrets: {} });
  const e22 = await X.buildTenantExport("x22");
  eq(e22.manifest.tables.document_refs, null, "document_refs at 0022 is recorded absent:");
  eq(e22.manifest.tables.documents, 0, "documents at 0022:");
  eq(e20.manifest.tables.releases, 0, "the rest of a 0020 export still works:");
});

// ---------- file: through lib/db.js --------------------------------------------

console.log("— file: database through lib/db.js");
const FILE_TENANT = { id: "pub-file", dbUrl: "file:.test-pub-file.db" };
await withTenant(FILE_TENANT, async () => {
  await seedTenant(libsql);
  await commonCases("file", libsql, { commit: (b) => commitPublishBatch(b) });
  await undoCases("file", libsql, { commit: (b) => commitPublishBatch(b) });

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
  const [sqldPort, proxyPort] = (process.env.TEST_PUBLISH_PORTS || "").split(",").map((p) => Number(p) || 0);
  sqld = H.startSqld({ bin: found.bin, key: "publish", port: sqldPort || (await freePort()), dataDir });
  await H.waitForHealth(sqld.url, sqld.child, { logFile: sqld.logFile, label: "test:publish" });
  proxy = startFaultProxy({ listenPort: proxyPort || 0, upstreamPort: sqld.port });
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
  await undoCases("sqld (HEAD lib/db.js)", direct, { commit: headCommit });

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

  await t("sqld, reconcile reports ok through this build's release row after a later publish replaced our document (P2-HARDEN)", async () => {
    const b = await makeBuild(direct, ["doc_p_about"]);
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    // Our batch commits and the answer is lost. Before the reconcile, someone
    // publishes doc_p_about again, so neither the pointer nor the live list
    // names this build any more: only its release row proves it committed.
    const orig = noRetry.execute.bind(noRetry);
    let replaced = null;
    const client = {
      batch: (...a) => noRetry.batch(...a),
      execute: async (...a) => {
        if (!replaced) {
          replaced = await makeBuild(direct, ["doc_p_about"]);
          eq((await commitPublishBatch(replaced, { client: direct })).outcome, "ok", "the publish on top:");
        }
        return orig(...a);
      },
    };
    const r = await commitPublishBatch(b, { client });
    proxy.pass();
    eq(proxy.counters.committedThenDropped, 1, "dropped after commit:");
    const live = await pointerOf(direct);
    ok(live.pointer !== b.releaseId, "the pointer has moved on");
    ok(live.list.documents.doc_p_about.version !== b.versions[0].id, "our document was replaced in the live list");
    eq(live.list.documents.doc_p_about.version, replaced.versions[0].id, "the later version is live:");
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, true, "reconciled:");
    eq(await rowsOfBuild(direct, b), { versions: 1, releases: 1, log: 1 }, "our rows, once:");
  });

  // ---- P3-COMMIT: an undo-shaped build through the proxy ----
  const { __commitInternals } = await import("../lib/documents/commit.js");

  await t("sqld, P3-COMMIT commit_then_drop once, HEAD lib/db.js, undo-shaped: the resend loses on the revision it moved, the reconcile reports ok, single rows", async () => {
    const id = await seedUndoDoc(direct);
    const before = await docRow(direct, id);
    const b = await makeUndoBuild(direct, id);
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    const r = await headCommit(b);
    proxy.pass();
    eq(r.outcome, "ok", `outcome (${r.cause?.message || ""}):`);
    eq(proxy.counters.committedThenDropped, 1, "dropped after commit:");
    eq(proxy.counters.batches, 2, "HEAD resent the batch once:");
    await assertUndoWritten(direct, b, before);
  });

  await t("sqld, P3-COMMIT commit_then_drop of an undo-shaped build, then a publish on top: ok through oursPresent (its release row), single rows; liveListHoldsMine is pinned to versions only", async () => {
    const id = await seedUndoDoc(direct);
    const before = await docRow(direct, id);
    const b = await makeUndoBuild(direct, id);
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    const orig = noRetry.execute.bind(noRetry);
    let replaced = null;
    const client = {
      batch: (...a) => noRetry.batch(...a),
      execute: async (...a) => {
        if (!replaced) {
          // someone takes over this document in the list before the reconcile
          replaced = await makeBuild(direct, [id]);
          eq((await commitPublishBatch(replaced, { client: direct })).outcome, "ok", "the publish on top:");
        }
        return orig(...a);
      },
    };
    const r = await commitPublishBatch(b, { client });
    proxy.pass();
    eq(r.outcome, "ok", "outcome:");
    eq(r.reconciled, true, "reconciled:");
    const live = await pointerOf(direct);
    ok(live.pointer !== b.releaseId, "the pointer moved on, so only the release row proves it");
    ok(!__commitInternals.liveListHoldsMine(b.list, live.list, b.versions), "the live list no longer holds our version");
    eq({ ...(await undoRows(direct, b)) }, ALL, "single rows:");
    eq(Number((await direct.execute({ sql: "SELECT count(*) AS n FROM publish_log WHERE set_id = ?", args: [b.setId] })).rows[0].n), 1, "one log row for the set:");
    // The pin: liveListHoldsMine looks at `versions` only. Counting the
    // undo_saved version would make it false even for a build that is live,
    // because no list slot ever names a kept version.
    const fresh = await makeUndoBuild(direct, id, { prev: live });
    eq((await headCommit(fresh)).outcome, "ok", "a fresh undo-shaped build:");
    const now = (await pointerOf(direct)).list;
    eq(__commitInternals.liveListHoldsMine(fresh.list, now, fresh.versions), true, "versions only: held");
    eq(__commitInternals.liveListHoldsMine(fresh.list, now, [...fresh.versions, ...fresh.extraVersions]), false, "with the undo_saved counted it would never be held:");
    void before;
  });

  await t("sqld, P3-COMMIT busy case, undo-shaped: a batch sent while another connection holds the write lock and moves the pointer is lost, with nothing of it written", async () => {
    const holder = raw(sqld.url);
    const id = await seedUndoDoc(direct);
    const b = await makeUndoBuild(direct, id);
    const before = await docRow(direct, id);
    const other = ids.relId();
    const content = stableStringify(L.emptyList(1, SINGLETONS));
    const tx = await holder.transaction("write");
    await tx.execute("SELECT 1 FROM release_state");
    await tx.execute({ sql: "INSERT INTO releases (id, content, content_hash, created_at, published_at) VALUES (?, ?, ?, ?, ?)", args: [other, content, await sha256Hex(content), NOW, NOW] });
    const pending = commitPublishBatch(b, { client: noRetry });
    await new Promise((r) => setTimeout(r, 300));
    await tx.execute({ sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", args: [other, NOW] });
    await tx.commit();
    const r = await pending;
    eq(r.outcome, "lost", `outcome (${r.cause?.message || ""}):`);
    await assertUndoNothing(direct, b, before);
    eq((await pointerOf(direct)).pointer, other, "the holder's pointer:");
    console.log(`    (undo busy case: ${r.busy ? "busy" : "guard"}: ${String(r.cause?.message || "").slice(0, 80)})`);
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
