// P3-UNDO suite (PUB-04, PUB-05, PUB-02): Undo of one publish, Undo of a
// whole set, take offline and the Recently published list
// (lib/documents/undo.js), through the real console API
// (lib/admin/documents-api.js: real requireAdmin, real sessions, real tenant
// databases with every migration). Storage is re-read after every refusal.
//
//   1. file: databases through lib/db.js, with the test-only "interleave hook"
//      (setPublishHooks, kept by lib/documents/build.js) to land a publish or
//      an autosave between Undo's read and its batch;
//   2. a throwaway real sqld, through HEAD's lib/db.js.
//
// sqld is required: if it is missing the suite FAILS, it never skips (as
// test:publish). Port: TEST_PUBLISH_UNDO_PORTS="<sqld>" picks it; otherwise a
// free port.
//   pnpm test:publish-undo
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-pu-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pu-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const STORES = ["docs", "list", "sets"];
const FILES = [".test-pu-default.db", ".test-pu-platform.db", ...STORES.map((s) => `.test-pu-${s}.db`)];
for (const f of FILES) await rm(join(ROOT, f), { force: true });

const started = Date.now();
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const U = await import("../lib/documents/undo.js");
const J = await import("../lib/documents/journal-index.js");
const L = await import("../lib/documents/release-list.js");
const V = await import("../lib/documents/versions.js");
const ids = await import("../lib/documents/ids.js");
const { commitPublishBatch } = await import("../lib/documents/commit.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const { SHAPES } = await import("../lib/admin/documents-api-shapes.js");
const R = await import("../lib/registry/index.js");
const Res = await import("../lib/content/resolve.js");
const H = await import("./design-harness.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  Pub.setPublishHooks({});
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 4).join("\n   ") || e}`);
  } finally {
    Pub.setPublishHooks({});
    V.setCheckpointInterval(null);
  }
}
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const eq = (got, want, label = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${label} expected ${canon(want).slice(0, 700)}, got ${canon(got).slice(0, 700)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// The same keys as a shapes example, all the way down (the first element of a
// list), leaving out the optional paths. A document's body is the founder's
// content, not part of the contract.
const FREE = new Set(["document.body", "current.body", "documents[].body"]);
function sameKeys(got, want, optional = [], path = "") {
  if (FREE.has(path)) return;
  if (Array.isArray(want)) {
    ok(Array.isArray(got), `${path || "body"} is a list`);
    if (want.length && got.length) sameKeys(got[0], want[0], optional, `${path}[]`);
    return;
  }
  if (want === null || typeof want !== "object") return;
  if (got === null) return;
  ok(got && typeof got === "object", `${path || "body"} is an object`);
  const opt = (k) => optional.includes(`${path ? `${path}.` : ""}${k}`.replace(/^\./, ""));
  const missing = Object.keys(want).filter((k) => !(k in got) && !opt(k));
  const extra = Object.keys(got).filter((k) => !(k in want));
  ok(!missing.length && !extra.length, `${path || "body"}: missing [${missing}], extra [${extra}]`);
  for (const k of Object.keys(want)) if (k in got) sameKeys(got[k], want[k], optional, path ? `${path}.${k}` : k);
}
const likeShape = (r, o, label) => {
  eq(r.status, o.status, `${label} status (${JSON.stringify(r.body).slice(0, 300)}):`);
  sameKeys(r.body, o.body, o.optional || []);
  if (o.body.code) eq(r.body.code, o.body.code, `${label} code:`);
};

// --- stores and people ------------------------------------------------------------------
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");
const raw = {};
const TEN = {};
const ownerU = await I.createUser({ email: "owner@pu.test", name: "Asha Rao", password: "owner-pass-undo" });
const staffU = await I.createUser({ email: "staff@pu.test", name: "Ravi", password: "staff-pass-undo" });
async function addStore(s, url, client) {
  await client.executeMultiple(schema);
  await runMigrations(client, MIGRATIONS);
  await client.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  raw[s] = client;
  await C.upsertTenant({ id: `pu${s}`, name: `PU ${s}`, domains: [`pu${s}.test`], dbUrl: url, config: { site: { name: `PU ${s} Store` }, site_url: `https://pu${s}.test` }, secrets: {} });
  TEN[s] = await C.getTenant(`pu${s}`);
  await I.addMembership(ownerU.id, `pu${s}`, "owner");
  await I.addMembership(staffU.id, `pu${s}`, "staff");
}
for (const s of STORES) await addStore(s, `file:.test-pu-${s}.db`, createClient({ url: `file:.test-pu-${s}.db` }));
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);

const req = (tenant, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${tenant.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (body, { as = OWNER, store = "docs" } = {}) => withTenant(TEN[store], () => handleDocumentsPut(req(TEN[store], as, body)));
const inT = (fn, store = "docs") => withTenant(TEN[store], fn);
const sql = async (q, args = [], store = "docs") => (await raw[store].execute({ sql: q, args })).rows.map((r) => ({ ...r }));

const dump = async (store = "docs") => {
  const out = {};
  for (const table of ["documents", "document_versions", "publish_log", "release_state", "releases", "document_refs"]) out[table] = await sql(`SELECT * FROM ${table} ORDER BY rowid`, [], store);
  return canon(out);
};
const unchanged = async (before, label, store = "docs") => eq(await dump(store), before, `${label}: storage changed:`);

async function pointerOf(store = "docs") {
  const [row] = await sql("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1", [], store);
  return { pointer: row?.live ?? null, list: row?.content ? JSON.parse(String(row.content)) : null };
}
const versionBody = async (versionId, store = "docs") => JSON.parse(String((await sql("SELECT body FROM document_versions WHERE id = ?", [versionId], store))[0].body));

const body = (type, { settings, sections, meta } = {}) => {
  const b = R.emptyBody(type);
  if (settings) b.settings = { ...(b.settings || {}), ...settings };
  if (sections) b.sections = sections;
  if (meta) b.meta = { ...b.meta, ...meta };
  return b;
};
const sec = (kind, id, settings = {}, extra = {}) => {
  const s = R.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings }, ...extra };
};
const textSec = (id, title, words) => sec("text", id, { title, body: [words] });
const page = (slug, title, words = "Some words.", type = "page", meta = {}) => body(type, { meta: { slug, title, ...meta }, sections: [textSec("sec_t1", title, words)] });
const linkingPage = (slug, title, links, type = "page") =>
  body(type, { meta: { slug, title }, sections: links.map((link, i) => sec("banner", `sec_bn${i}`, { title: `Banner ${i}`, text: "x", button: { label: "Go", link } })) });

const create = async (store, type, extra = {}) => {
  const r = await api({ createDocument: { type, ...extra } }, { store });
  eq(r.status, 200, `create ${type}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
};
const current = (store, id) => inT(() => Docs.getDocument(id), store);
const save = async (store, id, newBody) => {
  const d = await current(store, id);
  const r = await api({ saveDraft: { id, body: newBody }, revision: d.revision }, { store });
  eq(r.status, 200, `save ${id}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body.document;
};
const publishApi = async (store, id, { as = OWNER } = {}) => {
  const d = await current(store, id);
  return api({ publish: { id, draftHash: d.draftHash }, revision: d.revision }, { store, as });
};
const published = (r, label = "publish") => {
  eq(r.status, 200, `${label}: ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
};
const saveAndPublish = async (store, id, b) => {
  await save(store, id, b);
  return published(await publishApi(store, id), `publish ${b.meta?.slug || b.type}`);
};
const publishSetApi = async (store, list) => {
  const items = [];
  for (const id of list) {
    const d = await current(store, id);
    items.push({ id, revision: d.revision, draftHash: d.draftHash });
  }
  return api({ publishSet: items }, { store });
};
// the log rows of a document, oldest first
const logOf = (store, id) => sql("SELECT * FROM publish_log WHERE document_id = ? ORDER BY created_at, rowid", [id], store);
const lastLog = async (store, id, action = null) => (await logOf(store, id)).filter((r) => !action || r.action === action).at(-1);
const undoApi = async (store, id, logId, { as = OWNER, dryRun = false, revision } = {}) => {
  const d = await current(store, id);
  return api({ undo: { id, logId, ...(dryRun ? { dryRun: true } : {}) }, revision: revision ?? d.revision }, { store, as });
};
const recent = async (store, limit = 50) => {
  const r = await api({ listRecentlyPublished: { limit } }, { store });
  eq(r.status, 200, `listRecentlyPublished: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.rows;
};
// the row Recently published offers to undo for a document
const offered = async (store, id) => (await recent(store)).find((r) => r.documentId === id && r.canUndo) || null;
const liveText = async (store, slug) => (await inT(() => Res.resolvedContentPage(slug), store))?.sections?.[0]?.body ?? null;
const stripped = (b) => canon(R.stripIds(b));

// P3-CHECKS (PUB-06): a closed store's first publish must include the home
// page (FIRST_PUBLISH_NEEDS_HOME). These cases are about an open store, so
// each store opens here with its home page (one publish row on doc_home).
async function openStore(store) {
  const home = await create(store, "home", { body: body("home", { sections: [textSec("sec_h1", "Welcome", "Hello.")] }) });
  published(await publishApi(store, home.id), `open ${store} with its home page`);
}
for (const s of STORES) await openStore(s);

// A live version written straight through the commit with a 'migrated' log
// row, as the migration will write one.
async function migratedFixture(docId, b, store = "docs") {
  await inT(async () => {
    const live = await pointerOf(store);
    const v = await V.versionRow({ documentId: docId, kind: "migrated", body: b, schemaVersion: 1, createdAt: new Date().toISOString() });
    const cur = await current(store, docId);
    const list = L.setEntries(live.list || L.emptyList(1, R.singletonTypes()), [{ document: docId, entry: { version: v.id, hash: v.body_hash }, pages: [{ slug: b.meta.slug, type: b.type, title: b.meta.title }] }]);
    const r = await commitPublishBatch({ releaseId: ids.relId(), setId: ids.setId(), pointer: live.pointer, list, versions: [v], documents: [{ id: docId, revision: cur.revision, published_version_id: v.id, published_hash: await R.documentHash(b) }], log: [{ id: ids.logId(), document_id: docId, action: "migrated", to_version_id: v.id }] });
    eq(r.outcome, "ok", "fixture:");
  }, store);
}

// =========================================================================================
console.log("— Undo of one publish (PUB-04)");

// The core Undo case, run on the file store here and on sqld below.
async function undoBackCase(store) {
  const d = await create(store, "page", { body: page("undo-a-old", "Old title", "Version one.") });
  const p1 = published(await publishApi(store, d.id), "v1");
  const p2 = await saveAndPublish(store, d.id, page("undo-a-new", "New title", "Version two."));
  eq(await liveText(store, "undo-a-new"), ["Version two."], "v2 live first:");
  const before = await current(store, d.id);
  const row2 = await lastLog(store, d.id);
  eq(row2.to_version_id, p2.published[0].versionId, "row 2 is v2's:");
  // the list offers exactly that row
  const off = await offered(store, d.id);
  eq(off.undo, { id: d.id, revision: before.revision, logId: row2.id }, "offered undo args:");
  // the dry run first: the change words and the target, nothing written
  const beforeDry = await dump(store);
  const dry = await undoApi(store, d.id, row2.id, { dryRun: true });
  likeShape(dry, SHAPES.undo.outcomes.dryRun, "dry run");
  eq([dry.body.willTakeOffline, dry.body.linkers], [false, []], "dry run:");
  eq(dry.body.changes.map((c) => c.words), ["Web address changed", "Page title changed", "Text: title and a paragraph changed"], "the change words:");
  eq(dry.body.target.versionId, p1.published[0].versionId, "the target:");
  ok(/^Published \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} by Asha Rao$/.test(dry.body.target.name), `the target's name: ${dry.body.target.name}`);
  await unchanged(beforeDry, "dry run", store);
  const r = await undoApi(store, d.id, row2.id);
  likeShape(r, SHAPES.undo.outcomes.ok, "undo");
  ok(!("savedVersion" in r.body), "the draft was live, so nothing was saved");
  eq(r.body.liveUrl, "/api/preview?exit=1&to=%2Fpolicies%2Fundo-a-old", "liveUrl:");
  ok(/back to the version/.test(r.body.message) && r.body.message.includes("Old title"), `message names it: ${r.body.message}`);
  // the live list serves the previous version
  eq(await liveText(store, "undo-a-old"), ["Version one."], "shoppers see v1 again:");
  eq(await liveText(store, "undo-a-new"), null, "the v2 address is gone:");
  const now = await current(store, d.id);
  const live = await pointerOf(store);
  const entry = live.list.documents[d.id];
  ok(entry.version !== p1.published[0].versionId && entry.version !== p2.published[0].versionId, "a fresh version, never an old id");
  eq(stripped(await versionBody(entry.version, store)), stripped(await versionBody(p1.published[0].versionId, store)), "the fresh version copies v1:");
  eq(now.publishedVersionId, entry.version, "documents.published_version_id:");
  eq(now.publishedHash, await R.documentHash(await versionBody(p1.published[0].versionId, store)), "published_hash is documentHash(target):");
  // the draft equals it, revision + 1, slug and label follow the target
  eq(stripped(now.body), stripped(await versionBody(p1.published[0].versionId, store)), "the draft is v1:");
  eq([now.revision, now.slug, now.label, now.draftHash, now.undoneVersionId], [before.revision + 1, "undo-a-old", "Old title", now.publishedHash, null], "documents row:");
  eq(r.body.document.revision, now.revision, "the response carries the new revision:");
  const u = await lastLog(store, d.id);
  eq([u.action, u.undoes_log_id, u.from_version_id, u.to_version_id, u.saved_version_id], ["undo", row2.id, p2.published[0].versionId, entry.version, null], "the undo log row:");
  // publishing the unchanged draft is skipped as already live
  const again = published(await publishApi(store, d.id), "republish");
  eq([again.release, again.skipped], [null, [d.id]], "skipped as already live:");
  return d;
}

await t("unit (file): after Undo the live list serves the previous version, the draft equals it with revision+1, documents.slug and label follow the target, and publishing the unchanged draft is skipped", async () => {
  await undoBackCase("docs");
});

await t("unit: Undo three times steps back through three publishes; a fourth on the page's first publish takes it offline, the reader 404s it and its redirects are gone", async () => {
  const words = ["One.", "Two.", "Three.", "Four."];
  const d = await create("docs", "page", { body: page("steps", "Steps", words[0], "page", { redirect_from: ["steps-old"] }) });
  published(await publishApi("docs", d.id), "v1");
  for (const w of words.slice(1)) await saveAndPublish("docs", d.id, page("steps", "Steps", w, "page", { redirect_from: ["steps-old"] }));
  eq(await liveText("docs", "steps"), ["Four."], "v4 live:");
  eq(await inT(() => Res.resolvedSlugRedirect("steps-old")), "steps", "the redirect is live:");
  for (const want of ["Three.", "Two.", "One."]) {
    const off = await offered("docs", d.id);
    ok(off, `an undo is offered before going back to ${want}`);
    const r = await undoApi("docs", d.id, off.undo.logId, { revision: off.undo.revision });
    eq(r.status, 200, `undo to ${want}: ${JSON.stringify(r.body).slice(0, 300)}`);
    eq(await liveText("docs", "steps"), [want], "shoppers see:");
    eq(stripped((await current("docs", d.id)).body.sections), stripped(page("steps", "Steps", want).sections), "the draft:");
  }
  // the fourth: the first publish of this page, so it goes offline
  const off = await offered("docs", d.id);
  eq(off.logId, (await logOf("docs", d.id)).find((x) => x.action === "publish").id, "the first publish is offered last:");
  const dry = await undoApi("docs", d.id, off.undo.logId, { dryRun: true });
  likeShape(dry, SHAPES.undo.outcomes.dryRun, "dry run");
  eq([dry.body.willTakeOffline, dry.body.target, dry.body.changes], [true, null, [{ words: "Taken offline" }]], "the dry run says it goes offline:");
  const draftBefore = await current("docs", d.id);
  const r = await undoApi("docs", d.id, off.undo.logId);
  likeShape(r, SHAPES.undo.outcomes.ok, "take offline");
  eq([r.body.message, r.body.liveUrl], [U.OFFLINE_MESSAGE, null], "words:");
  eq(await liveText("docs", "steps"), null, "the reader 404s it:");
  eq(await inT(() => Res.resolvedSlugRedirect("steps-old")), null, "the redirect pointing to it is gone:");
  const live = await pointerOf();
  eq(live.list.redirects.filter((x) => x.to_slug === "steps"), [], "no redirect in the list:");
  eq(live.list.pages.filter((p) => p.document === d.id).map((p) => p.enabled), [false], "its row is switched off:");
  const now = await current("docs", d.id);
  eq([now.publishedVersionId, now.publishedHash, now.undoneVersionId, now.revision, now.draftHash], [null, null, draftBefore.publishedVersionId, draftBefore.revision, draftBefore.draftHash], "documents row (draft kept):");
  // nothing earlier now
  ok(!(await offered("docs", d.id)), "no undo offered once offline");
  const rows = (await recent("docs")).filter((x) => x.documentId === d.id);
  eq(rows[0].note, U.OFFLINE_NOTE, "the offline undo row says how to bring it back:");
  eq(rows[0].summary, [{ words: "Taken offline" }], "and its summary:");
});

// A publish made while the page was offline replaced nothing live: its Undo
// takes the page offline again and never puts the offline copy live (fix
// round 1). Path 1: taken offline by unpublish. Path 2: taken offline by an
// Undo of the first publish.
const republishApi = async (store, id) => {
  const d = await current(store, id);
  return api({ publish: { id, draftHash: d.draftHash, confirmRepublish: true }, revision: d.revision }, { store });
};
async function offlineRepublishCase(slug, takeOffline) {
  const d = await create("docs", "page", { body: page(slug, "Offline again", "One.", "page", { redirect_from: [`${slug}-old`] }) });
  published(await publishApi("docs", d.id), "v1");
  await takeOffline(d);
  eq(await liveText("docs", slug), null, "offline first:");
  await save("docs", d.id, page(slug, "Offline again", "Two.", "page", { redirect_from: [`${slug}-old`] }));
  published(await republishApi("docs", d.id), "publish while offline");
  eq(await liveText("docs", slug), ["Two."], "Two. live:");
  const off = await offered("docs", d.id);
  ok(off, "Recently published offers an Undo of that publish");
  eq(off.logId, (await lastLog("docs", d.id, "publish")).id, "the offered row is that publish:");
  const beforeDry = await dump();
  const dry = await undoApi("docs", d.id, off.undo.logId, { dryRun: true });
  likeShape(dry, SHAPES.undo.outcomes.dryRun, "dry run");
  eq([dry.body.willTakeOffline, dry.body.target, dry.body.changes], [true, null, [{ words: "Taken offline" }]], "the dry run says it goes offline:");
  await unchanged(beforeDry, "dry run");
  const before = await current("docs", d.id);
  const r = await undoApi("docs", d.id, off.undo.logId, { revision: off.undo.revision });
  likeShape(r, SHAPES.undo.outcomes.ok, "undo");
  eq([r.body.message, r.body.liveUrl], [U.OFFLINE_MESSAGE, null], "words:");
  ok(!/back to the version/.test(r.body.message), "never says it's back to a version");
  eq(await liveText("docs", slug), null, "the reader 404s it, never One. again:");
  eq(await inT(() => Res.resolvedSlugRedirect(`${slug}-old`)), null, "no redirect to it:");
  const live = await pointerOf();
  eq(live.list.pages.filter((p) => p.document === d.id).map((p) => p.enabled), [false], "its row is switched off:");
  const now = await current("docs", d.id);
  eq([now.publishedVersionId, now.publishedHash, now.undoneVersionId, now.revision, now.draftHash], [null, null, before.publishedVersionId, before.revision, before.draftHash], "documents row (draft kept):");
  eq(stripped(now.body.sections), stripped(page(slug, "Offline again", "Two.").sections), "the draft still says Two.:");
  ok(!(await offered("docs", d.id)), "no Undo offered once offline");
  const rows = (await recent("docs")).filter((x) => x.documentId === d.id);
  eq([rows[0].action, rows[0].summary, rows[0].note], ["undo", [{ words: "Taken offline" }], U.OFFLINE_NOTE], "the Undid row:");
  // and it can go on: publish again, Undo again, offline again
  published(await republishApi("docs", d.id), "publish again");
  const off2 = await offered("docs", d.id);
  const r2 = await undoApi("docs", d.id, off2.undo.logId, { revision: off2.undo.revision });
  eq([r2.status, r2.body.message], [200, U.OFFLINE_MESSAGE], "second round:");
  eq(await liveText("docs", slug), null, "offline again:");
}

await t("unit (negative): Undo of a publish made after unpublish takes the page offline again, keeps the draft, and never puts the old version back", async () => {
  await offlineRepublishCase("off-again-1", async (d) => {
    const r = await api({ unpublish: { id: d.id }, revision: (await current("docs", d.id)).revision });
    eq(r.status, 200, `unpublish: ${JSON.stringify(r.body).slice(0, 300)}`);
  });
});

await t("unit (negative): Undo of a publish made after an Undo took the page offline takes it offline again, never back to the first version", async () => {
  await offlineRepublishCase("off-again-2", async (d) => {
    const off = await offered("docs", d.id);
    const r = await undoApi("docs", d.id, off.undo.logId, { revision: off.undo.revision });
    eq([r.status, r.body.message], [200, U.OFFLINE_MESSAGE], `undo of the first publish: ${JSON.stringify(r.body).slice(0, 300)}`);
  });
});

await t("unit (negative): tab A publishes v2 while tab B's Undo of v1 is in flight: B answers 409 PUBLISHED_ELSEWHERE and v2 stays live; an Undo of a row that is not the latest undoable row is 409", async () => {
  const d = await create("docs", "page", { body: page("race-undo", "Race", "Zero.") });
  published(await publishApi("docs", d.id), "v0");
  await saveAndPublish("docs", d.id, page("race-undo", "Race", "One."));
  const row1 = await lastLog("docs", d.id);
  const rev = (await current("docs", d.id)).revision;
  let inner = null;
  let attempts = 0;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (build.log[0]?.action !== "undo") return;
      attempts = attempt;
      if (attempt === 1 && !inner) {
        inner = "running";
        await save("docs", d.id, page("race-undo", "Race", "Two."));
        inner = await publishApi("docs", d.id); // tab A
      }
    },
  });
  const r = await api({ undo: { id: d.id, logId: row1.id }, revision: rev });
  Pub.setPublishHooks({});
  published(inner, "tab A");
  likeShape(r, SHAPES.undo.outcomes.publishedElsewhere, "tab B");
  eq(r.body.error, U.ELSEWHERE_MESSAGE, "words:");
  eq(r.body.current.updatedByName, "another tab", "the same person in another tab:");
  eq(attempts, 1, "B lost once and stopped:");
  eq(await liveText("docs", "race-undo"), ["Two."], "v2 stays live:");
  eq((await current("docs", d.id)).publishedVersionId, inner.body.published[0].versionId, "pointer:");
  ok(!(await logOf("docs", d.id)).some((x) => x.action === "undo"), "no undo row");
  // a row that is not the latest undoable row
  const first = (await logOf("docs", d.id))[0];
  const before = await dump();
  const old = await undoApi("docs", d.id, first.id);
  likeShape(old, SHAPES.undo.outcomes.publishedElsewhere, "an older row");
  // the row that was undone in the race is not current either
  eq((await undoApi("docs", d.id, row1.id)).body.code, "PUBLISHED_ELSEWHERE", "v1's row:");
  await unchanged(before, "older rows");
  // another document's row
  const other = await create("docs", "page", { body: page("race-other", "Other", "x") });
  published(await publishApi("docs", other.id), "other");
  eq((await undoApi("docs", d.id, (await lastLog("docs", other.id)).id)).body.code, "PUBLISHED_ELSEWHERE", "another document's row:");
});

await t("unit (negative): Undo to a target slug that another document's draft now holds is 409 SLUG_TAKEN naming that page, with a next step, and nothing is written", async () => {
  const d = await create("docs", "page", { body: page("slug-one", "Mover", "One.") });
  published(await publishApi("docs", d.id), "v1");
  await saveAndPublish("docs", d.id, page("slug-two", "Mover", "Two."));
  const holder = await create("docs", "page", { body: page("slug-one", "Holder page", "I hold it now.") });
  const before = await dump();
  const r = await undoApi("docs", d.id, (await lastLog("docs", d.id)).id);
  likeShape(r, SHAPES.undo.outcomes.slugTaken, "slug taken");
  eq([r.body.slug, r.body.other], ["slug-one", { id: holder.id, title: "Holder page", label: "Holder page" }], "names that page:");
  ok(r.body.error.startsWith("Another page already uses /slug-one: Holder page.") && /Change the address of “Holder page”, or take it offline and archive it, then undo again\./.test(r.body.error), `a next step: ${r.body.error}`);
  await unchanged(before, "slug taken");
  // and when the live list holds it (another live page)
  const e = await create("docs", "page", { body: page("live-one", "Live mover", "One.") });
  published(await publishApi("docs", e.id), "e v1");
  await saveAndPublish("docs", e.id, page("live-two", "Live mover", "Two."));
  const claimer = await create("docs", "page", { body: page("live-one-x", "Claimer", "x") });
  published(await publishApi("docs", claimer.id), "claimer");
  // the claimer goes live at live-one while e's draft moved away (the live list now holds it twice is impossible: e's row is at live-two)
  await saveAndPublish("docs", claimer.id, page("live-one", "Claimer", "x"));
  const before2 = await dump();
  const r2 = await undoApi("docs", e.id, (await lastLog("docs", e.id)).id);
  eq([r2.status, r2.body.code, r2.body.other?.id, r2.body.other?.label], [409, "SLUG_TAKEN", claimer.id, "Claimer"], `the live list: ${JSON.stringify(r2.body).slice(0, 300)}`);
  ok(/then undo again\./.test(r2.body.error), "a next step");
  await unchanged(before2, "live slug taken");
});

await t("unit: Undo on one document leaves every other document's entry, published_version_id and draft unchanged", async () => {
  const a = await create("docs", "page", { body: page("iso-a", "Iso A", "A1.") });
  const b = await create("docs", "page", { body: page("iso-b", "Iso B", "B1.") });
  const post = await create("docs", "journal", { body: page("iso-post", "Iso post", "P1.", "journal") });
  for (const x of [a, b, post]) published(await publishApi("docs", x.id), x.id);
  await saveAndPublish("docs", a.id, page("iso-a", "Iso A", "A2."));
  await save("docs", b.id, page("iso-b", "Iso B", "B draft."));
  const others = async () => {
    const live = await pointerOf();
    const rows = await sql("SELECT id, draft, draft_hash, revision, published_version_id, published_hash, undone_version_id, slug, label FROM documents WHERE id <> ? ORDER BY id", [a.id]);
    const entries = Object.fromEntries(Object.entries(live.list.documents).filter(([k]) => k !== a.id));
    const pages = live.list.pages.filter((p) => p.document !== a.id);
    const ib = live.list.indexes.journal ? J.journalEntriesOf(await versionBody(live.list.indexes.journal.version)) : [];
    return canon({ rows, entries, pages, redirects: live.list.redirects.filter((x) => x.document !== a.id), journal: ib });
  };
  const before = await others();
  eq((await undoApi("docs", a.id, (await lastLog("docs", a.id)).id)).status, 200, "undo a:");
  eq(await liveText("docs", "iso-a"), ["A1."], "a went back:");
  eq(await others(), before, "every other document:");
});

await t("unit: Undo of a journal post's publish puts the earlier post back through the journal index", async () => {
  const p = await create("docs", "journal", { body: page("undo-post", "Undo post", "Post one.", "journal") });
  published(await publishApi("docs", p.id), "v1");
  await saveAndPublish("docs", p.id, page("undo-post", "Undo post", "Post two.", "journal"));
  eq(await liveText("docs", "undo-post"), ["Post two."], "v2 live:");
  const r = await undoApi("docs", p.id, (await lastLog("docs", p.id)).id);
  likeShape(r, SHAPES.undo.outcomes.ok, "undo post");
  eq(r.body.liveUrl, "/api/preview?exit=1&to=%2Fjournal%2Fundo-post", "liveUrl:");
  eq(await liveText("docs", "undo-post"), ["Post one."], "shoppers read v1 through the index:");
  const live = await pointerOf();
  ok(!Object.hasOwn(live.list.documents, p.id), "still no list.documents entry (PERF-01)");
  const row = J.journalEntriesOf(await versionBody(live.list.indexes.journal.version)).find((e) => e.document === p.id);
  eq(row.version, (await current("docs", p.id)).publishedVersionId, "the index names the fresh version:");
});

await t("unit (negative): newer unpublished edits are kept as an undo_saved version, listed by listHistory with its note, survive 25 later autosaves, and the response names 'Earlier versions'", async () => {
  const d = await create("docs", "page", { body: page("keep-mine", "Keep mine", "One.") });
  published(await publishApi("docs", d.id), "v1");
  await saveAndPublish("docs", d.id, page("keep-mine", "Keep mine", "Two."));
  const newer = page("keep-mine", "Keep mine", "My newer words, not live.");
  await save("docs", d.id, newer);
  const r = await undoApi("docs", d.id, (await lastLog("docs", d.id)).id);
  likeShape(r, SHAPES.undo.outcomes.ok, "undo");
  ok(r.body.savedVersion && r.body.savedVersion.where === "Earlier versions", "savedVersion names Earlier versions");
  ok(r.body.message.includes("Earlier versions"), `the message names it: ${r.body.message}`);
  const saved = await sql("SELECT * FROM document_versions WHERE id = ?", [r.body.savedVersion.id]);
  eq([saved[0].kind, saved[0].note, saved[0].document_id], ["undo_saved", "Saved before Undo", d.id], "the kept version:");
  eq(stripped(JSON.parse(String(saved[0].body))), stripped(newer), "it holds the newer words:");
  eq((await lastLog("docs", d.id)).saved_version_id, r.body.savedVersion.id, "the undo row names it:");
  // 25 later autosaves, each adding a checkpoint
  V.setCheckpointInterval(0);
  for (let i = 0; i < 25; i++) await save("docs", d.id, page("keep-mine", "Keep mine", `Autosave ${i}.`));
  const h = await api({ listHistory: d.id });
  eq(h.status, 200, "listHistory:");
  const kept = h.body.versions.filter((v) => v.id === r.body.savedVersion.id);
  eq(kept.map((v) => [v.kind, v.note]), [["undo_saved", "Saved before Undo"]], "still listed after 25 autosaves:");
  ok(h.body.versions.filter((v) => v.kind === "checkpoint").length <= V.CHECKPOINT_CAP, "the checkpoints were pruned to the cap");
});

await t("unit (negative): an autosave between Undo's read and its batch makes the batch lose; Undo re-reads and succeeds on the new revision with the autosaved text kept as undo_saved; no undo_saved orphan; three such losses are 409 DOCUMENT_CHANGED with nothing written", async () => {
  const d = await create("docs", "page", { body: page("race-save", "Race save", "One.") });
  published(await publishApi("docs", d.id), "v1");
  await saveAndPublish("docs", d.id, page("race-save", "Race save", "Two."));
  await save("docs", d.id, page("race-save", "Race save", "Typed before Undo."));
  const sent = [];
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (build.log[0]?.action !== "undo") return;
      sent.push({ attempt, saved: build.extraVersions?.[0]?.id ?? null, revision: build.documents[0].revision });
      if (attempt === 1) await save("docs", d.id, page("race-save", "Race save", "Autosaved in the gap."));
    },
  });
  const r = await undoApi("docs", d.id, (await lastLog("docs", d.id)).id);
  Pub.setPublishHooks({});
  eq(r.status, 200, `undo: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(sent.length, 2, "lost once, rebuilt once:");
  eq(sent[1].revision, sent[0].revision + 1, "the rebuild guards on the new revision:");
  ok(sent[0].saved && sent[1].saved && sent[0].saved !== sent[1].saved, "a fresh undo_saved id per attempt");
  eq(r.body.savedVersion.id, sent[1].saved, "the response names the second one:");
  eq((await sql("SELECT id FROM document_versions WHERE id = ?", [sent[0].saved])).length, 0, "no orphan from the lost attempt:");
  const kept = await sql("SELECT body FROM document_versions WHERE document_id = ? AND kind = 'undo_saved'", [d.id]);
  eq(kept.length, 1, "one undo_saved row:");
  eq(JSON.parse(String(kept[0].body)).sections[0].settings.body, ["Autosaved in the gap."], "it keeps the autosaved text:");
  eq(await liveText("docs", "race-save"), ["One."], "v1 live:");
  // three losses, each from an autosave: 409 DOCUMENT_CHANGED, nothing written
  const e = await create("docs", "page", { body: page("starve", "Starve", "One.") });
  published(await publishApi("docs", e.id), "v1");
  await saveAndPublish("docs", e.id, page("starve", "Starve", "Two."));
  const rowE = await lastLog("docs", e.id);
  const rev = (await current("docs", e.id)).revision;
  let n = 0;
  Pub.setPublishHooks({
    beforeCommit: async ({ build }) => {
      if (build.log[0]?.action !== "undo") return;
      n++;
      await save("docs", e.id, page("starve", "Starve", `Gap ${n}.`));
    },
  });
  const before = await sql("SELECT count(*) AS n FROM document_versions WHERE kind <> 'checkpoint'");
  const starved = await api({ undo: { id: e.id, logId: rowE.id }, revision: rev });
  Pub.setPublishHooks({});
  likeShape(starved, SHAPES.undo.outcomes.changed, "three losses");
  eq(n, 3, "three attempts:");
  eq(await sql("SELECT count(*) AS n FROM document_versions WHERE kind <> 'checkpoint'"), before, "no published or undo_saved rows:");
  ok(!(await logOf("docs", e.id)).some((x) => x.action === "undo"), "no undo row");
  eq(await liveText("docs", "starve"), ["Two."], "v2 still live:");
  // a stale start revision is refused before anything is read further
  const stale = await undoApi("docs", e.id, rowE.id, { revision: rev });
  likeShape(stale, SHAPES.undo.outcomes.changed, "stale start");
});

await t("unit: an old-schema target body is upgraded before it becomes the draft and the fresh version", async () => {
  const decl = { kind: "fake_undo", label: "Versioned", documentTypes: ["page"], settings: [{ key: "title", kind: "text", label: "Title", max: 80, default: "Hi" }] };
  R.defineSection({ ...decl, version: 1 });
  let d;
  let v1;
  try {
    d = await create("docs", "page", { body: body("page", { meta: { slug: "old-schema", title: "Old schema" }, sections: [{ id: "sec_fk1", kind: "fake_undo", v: 1, enabled: true, settings: { title: "hello" }, blocks: [] }] }) });
    v1 = published(await publishApi("docs", d.id), "v1 (section at v1)");
    await saveAndPublish("docs", d.id, page("old-schema", "Old schema", "Two."));
  } finally {
    R.removeSection("fake_undo");
  }
  // the schema moves on: version 2 renames nothing but upper-cases the title
  R.defineSection({ ...decl, version: 2, migrate: { 1: (s) => ({ ...s, settings: { title: String(s.settings.title).toUpperCase() } }) } });
  try {
    eq((await versionBody(v1.published[0].versionId)).sections[0].v, 1, "the stored target is at v1:");
    const r = await undoApi("docs", d.id, (await lastLog("docs", d.id)).id);
    eq(r.status, 200, `undo: ${JSON.stringify(r.body).slice(0, 300)}`);
    const now = await current("docs", d.id);
    eq([now.body.sections[0].v, now.body.sections[0].settings.title], [2, "HELLO"], "the draft is upgraded:");
    const fresh = await versionBody(now.publishedVersionId);
    eq([fresh.sections[0].v, fresh.sections[0].settings.title], [2, "HELLO"], "the fresh version is upgraded:");
    eq(now.draftHash, await R.documentHash(fresh), "draft and live hash agree:");
  } finally {
    R.removeSection("fake_undo");
  }
});

await t("unit (negative): staff calling undo, undoSet or unpublish get 403 with storage unchanged; the singleton first-version and migrated floors say so and write nothing", async () => {
  const d = await create("docs", "page", { body: page("staff-no", "Staff no", "One.") });
  const p = published(await publishApi("docs", d.id), "v1");
  await saveAndPublish("docs", d.id, page("staff-no", "Staff no", "Two."));
  const row = await lastLog("docs", d.id);
  const rev = (await current("docs", d.id)).revision;
  const before = await dump();
  for (const reqBody of [{ undo: { id: d.id, logId: row.id }, revision: rev }, { undoSet: { setId: row.set_id, members: [{ id: d.id, logId: row.id }] } }, { unpublish: { id: d.id }, revision: rev }, { undo: { id: d.id, logId: row.id, dryRun: true }, revision: rev }]) {
    const r = await api(reqBody, { as: STAFF });
    likeShape(r, { status: 403, body: { error: "Your role (staff) can't do that" } }, `staff ${Object.keys(reqBody)[0]}`);
  }
  await unchanged(before, "staff");
  ok(p, "published");
  // a singleton's first publish: nothing earlier
  // (the store opened with doc_home's first publish: see openStore)
  const home = await current("docs", "doc_home");
  const hb = await dump();
  const first = await undoApi("docs", home.id, (await lastLog("docs", home.id)).id);
  likeShape(first, SHAPES.undo.outcomes.nothing, "singleton first version");
  eq(first.body.message, "This is the first published version. Edit it, or go back to your starting design.", "words:");
  await unchanged(hb, "singleton floor");
  // a migrated row, and no row at all
  const m = await create("docs", "page", { body: page("migrated-one", "Migrated", "From the old editor.") });
  await migratedFixture(m.id, page("migrated-one", "Migrated", "From the old editor."));
  const mrow = await lastLog("docs", m.id);
  eq(mrow.action, "migrated", "the fixture row:");
  const mb = await dump();
  const floor = await undoApi("docs", m.id, mrow.id);
  likeShape(floor, SHAPES.undo.outcomes.nothing, "migrated floor");
  eq(floor.body.message, "There's nothing earlier to undo.", "words:");
  eq((await undoApi("docs", m.id, "log_0000000000000000")).body.message, "There's nothing earlier to undo.", "no row:");
  await unchanged(mb, "migrated floor");
  // P4-LIVEROW (OVL-02): product content is undone like any document now: a
  // log row that isn't there is the "nothing earlier" floor, and nothing is written
  const pc = await create("docs", "product_content", { entityId: "gid://shopify/Product/9" });
  const pb = await dump();
  const pr = await undoApi("docs", pc.id, "log_0000000000000000");
  eq([pr.status, pr.body.nothing, pr.body.message], [200, true, "There's nothing earlier to undo."], "product content:");
  await unchanged(pb, "product content floor");
});

console.log("— Undo of a whole set (PUB-05)");

await t("unit: whole-set Undo after a 3-document publishSet restores all three in one release even when one member autosaved since (kept as undo_saved); one member published since is 409 with nothing changed; a single-document Undo of a set member works", async () => {
  const st = "sets";
  const docs = [];
  for (const n of ["a", "b", "c"]) docs.push(await create(st, "page", { body: page(`set-${n}`, `Set ${n}`, `${n} one.`) }));
  published(await publishSetApi(st, docs.map((x) => x.id)), "set 1");
  for (const x of docs) await save(st, x.id, page(x.slug, x.label, `${x.slug} two.`));
  const s2 = published(await publishSetApi(st, docs.map((x) => x.id)), "set 2");
  await save(st, docs[1].id, page("set-b", "Set b", "b typed after."));
  const rows = await recent(st);
  const setRows = rows.filter((r) => r.setId === s2.setId);
  eq(setRows.length, 3, "the set's three rows, together:");
  ok(setRows.every((r) => r.canUndo), "each current");
  const members = setRows.map((r) => ({ id: r.documentId, logId: r.logId }));
  const dry = await api({ undoSet: { setId: s2.setId, members, dryRun: true } }, { store: st });
  likeShape(dry, SHAPES.undoSet.outcomes.dryRun, "set dry run");
  ok(dry.body.changes.length >= 3 && dry.body.changes.every((c) => /^Set [abc]: /.test(c.words)), `changes name each page: ${JSON.stringify(dry.body.changes)}`);
  const releasesBefore = (await sql("SELECT count(*) AS n FROM releases", [], st))[0].n;
  const beforeDry = await dump(st);
  await api({ undoSet: { setId: s2.setId, members, dryRun: true } }, { store: st });
  await unchanged(beforeDry, "set dry run", st);
  const r = await api({ undoSet: { setId: s2.setId, members } }, { store: st });
  likeShape(r, SHAPES.undoSet.outcomes.ok, "undoSet");
  eq(r.body.message, "“Set a”, “Set b” and “Set c” are live again, as they were before that publish. Newer changes to “Set b” are kept in Earlier versions.", "message:");
  eq((await sql("SELECT count(*) AS n FROM releases", [], st))[0].n, releasesBefore + 1, "one release:");
  for (const n of ["a", "b", "c"]) eq(await liveText(st, `set-${n}`), [`${n} one.`], `set-${n} back:`);
  const undoRows = await sql("SELECT set_id, document_id, saved_version_id FROM publish_log WHERE action = 'undo' AND undoes_log_id IN (?, ?, ?)", members.map((m) => m.logId), st);
  eq(new Set(undoRows.map((x) => x.set_id)).size, 1, "one set for the three undo rows:");
  eq(undoRows.filter((x) => x.saved_version_id).map((x) => x.document_id), [docs[1].id], "only b's autosave was kept:");
  const kept = await sql("SELECT body, note FROM document_versions WHERE id = ?", [undoRows.find((x) => x.saved_version_id).saved_version_id], st);
  eq([JSON.parse(String(kept[0].body)).sections[0].settings.body, kept[0].note], [["b typed after."], "Saved before Undo"], "b's kept draft:");

  // set 3, then one member published again alone: the whole-set Undo is 409
  for (const x of docs) await save(st, x.id, page(x.slug, x.label, `${x.slug} three.`));
  const s3 = published(await publishSetApi(st, docs.map((x) => x.id)), "set 3");
  await save(st, docs[2].id, page("set-c", "Set c", "c four."));
  published(await publishApi(st, docs[2].id), "c alone");
  const m3 = (await sql("SELECT id, document_id FROM publish_log WHERE set_id = ?", [s3.setId], st)).map((x) => ({ id: String(x.document_id), logId: String(x.id) }));
  const before = await dump(st);
  const refused = await api({ undoSet: { setId: s3.setId, members: m3 } }, { store: st });
  likeShape(refused, SHAPES.undoSet.outcomes.publishedElsewhere, "a member published since");
  eq(refused.body.error, "“Set c” was changed after that publish. Reload to see the latest.", "names the member:");
  eq(refused.body.current.id, docs[2].id, "current is that member:");
  await unchanged(before, "set refused", st);
  // a single-document Undo of a set member still works
  const one = await undoApi(st, docs[0].id, m3.find((x) => x.id === docs[0].id).logId);
  eq(one.status, 200, `single member undo: ${JSON.stringify(one.body).slice(0, 300)}`);
  // set 2 was undone, so what was live before set 3 is set 1's words
  eq(await liveText(st, "set-a"), ["a one."], "a is back to what was live before set 3:");
  eq(await liveText(st, "set-b"), ["set-b three."], "b untouched:");
});

console.log("— take offline (PUB-04, decision 4)");

await t("P3-FIX2 unit: a whole-set Undo where one member goes offline names which pages are live again and which are offline, and says 'open it and publish it again'", async () => {
  const st = "sets";
  const p = await create(st, "page", { body: page("mix-p", "Mix p", "p one.") });
  const q = await create(st, "page", { body: page("mix-q", "Mix q", "q one.") });
  published(await publishApi(st, p.id), "p first, alone");
  await save(st, p.id, page("mix-p", "Mix p", "p two."));
  const s = published(await publishSetApi(st, [p.id, q.id]), "p again with q's first publish");
  const members = (await sql("SELECT id, document_id FROM publish_log WHERE set_id = ?", [s.setId], st)).map((x) => ({ id: String(x.document_id), logId: String(x.id) }));
  const r = await api({ undoSet: { setId: s.setId, members } }, { store: st });
  likeShape(r, SHAPES.undoSet.outcomes.ok, "undoSet");
  eq(r.body.message, "“Mix p” is live again, as it was before that publish. “Mix q” is offline now, as it was before that publish. To bring it back, open it and publish it again.", "message:");
  eq(await liveText(st, "mix-p"), ["p one."], "p is back:");
  ok(!/\d+ pages? (is|are) back/.test(r.body.message), "no count that reads as if every page is live");
  // both offline: plural words
  const u = await create(st, "page", { body: page("mix-u", "Mix u", "u one.") });
  const v = await create(st, "page", { body: page("mix-v", "Mix v", "v one.") });
  const s2 = published(await publishSetApi(st, [u.id, v.id]), "two first publishes");
  const m2 = (await sql("SELECT id, document_id FROM publish_log WHERE set_id = ?", [s2.setId], st)).map((x) => ({ id: String(x.document_id), logId: String(x.id) }));
  const r2 = await api({ undoSet: { setId: s2.setId, members: m2 } }, { store: st });
  ok(/^“Mix [uv]” and “Mix [uv]” are offline now, as they were before that publish\. To bring them back, open each one and publish it again\.$/.test(r2.body.message), `plural: ${r2.body.message}`);
});

await t("unit: unpublish of a live page and of a journal post writes an 'unpublish' row, 404s it, keeps its draft, nulls published_version_id (archive allowed), sets undone_version_id; dryRun returns linkers and change words and writes nothing; Undo of that row brings it back with redirects and refs and clears undone", async () => {
  // P3-CHECKS: a link to a collection the store doesn't have blocks a
  // publish (LINK_COLLECTION_MISSING), so the store has the linen collection
  await raw.docs.execute({ sql: "INSERT OR IGNORE INTO collections (id, handle, title, synced_at) VALUES (?, ?, ?, ?)", args: ["gid://shopify/Collection/linen", "linen", "Linen", new Date().toISOString()] });
  const target = await create("docs", "page", { body: page("off-target", "Off target", "Live words.", "page", { redirect_from: ["off-target-old"] }) });
  // the page itself links somewhere, so its versions have refs
  await save("docs", target.id, { ...page("off-target", "Off target", "Live words.", "page", { redirect_from: ["off-target-old"] }), sections: [textSec("sec_t1", "Off target", "Live words."), sec("banner", "sec_bnx", { title: "B", text: "x", button: { label: "Go", link: { type: "collection", handle: "linen" } } })] });
  published(await publishApi("docs", target.id), "target");
  const linker = await create("docs", "campaign", { body: linkingPage("links-off", "Links to it", [{ type: "page", family: "page", slug: "off-target", document: target.id }], "campaign") });
  published(await publishApi("docs", linker.id), "linker");
  await save("docs", target.id, { ...(await current("docs", target.id)).body, sections: [textSec("sec_t1", "Off target", "Draft words.")] });
  const before = await current("docs", target.id);
  const all = await dump();
  const dry = await api({ unpublish: { id: target.id, dryRun: true }, revision: before.revision });
  likeShape(dry, SHAPES.unpublish.outcomes.dryRun, "dry run");
  eq([dry.body.willTakeOffline, dry.body.linkers, dry.body.changes, dry.body.target], [true, [{ id: linker.id, label: "Links to it" }], [{ words: "Taken offline" }], null], "dry run:");
  await unchanged(all, "dry run");
  const r = await api({ unpublish: { id: target.id }, revision: before.revision });
  likeShape(r, SHAPES.unpublish.outcomes.ok, "unpublish");
  eq(r.body.message, U.OFFLINE_MESSAGE, "words:");
  eq(await liveText("docs", "off-target"), null, "404s:");
  eq(await inT(() => Res.resolvedSlugRedirect("off-target-old")), null, "its redirect is gone:");
  const now = await current("docs", target.id);
  eq([now.publishedVersionId, now.publishedHash, now.undoneVersionId, now.draftHash, now.revision], [null, null, before.publishedVersionId, before.draftHash, before.revision], "documents row:");
  const urow = await lastLog("docs", target.id);
  eq([urow.action, urow.from_version_id], ["unpublish", before.publishedVersionId], "the unpublish row:");
  // the unpublish row is current and offered
  const off = await offered("docs", target.id);
  eq(off.logId, urow.id, "offered:");
  eq((await recent("docs")).find((x) => x.logId === urow.id).summary, [{ words: "Taken offline" }], "its summary:");
  // Undo of the unpublish row: back, with redirects and refs, undone cleared
  const back = await undoApi("docs", target.id, urow.id);
  likeShape(back, SHAPES.undo.outcomes.ok, "bring back");
  eq(await liveText("docs", "off-target"), ["Live words."], "back for shoppers:");
  eq(await inT(() => Res.resolvedSlugRedirect("off-target-old")), "off-target", "the redirect is back:");
  const after = await current("docs", target.id);
  eq([after.undoneVersionId, after.draftHash, after.revision], [null, before.draftHash, before.revision], "undone cleared, draft kept:");
  const refs = await sql("SELECT ref_type, ref_id FROM document_refs WHERE version_id = ? ORDER BY ref_type, ref_id", [after.publishedVersionId]);
  eq(refs.map((x) => [x.ref_type, x.ref_id]), [["collection", "linen"]], "refs of the fresh version:");
  eq((await recent("docs")).find((x) => x.documentId === target.id).summary, [{ words: "Back on your store" }], "the bring-back summary:");

  // a journal post
  const post = await create("docs", "journal", { body: page("off-post-u", "Off post", "Post words.", "journal") });
  published(await publishApi("docs", post.id), "post");
  const pb = await current("docs", post.id);
  const pr = await api({ unpublish: { id: post.id }, revision: pb.revision });
  eq(pr.status, 200, `post: ${JSON.stringify(pr.body).slice(0, 300)}`);
  ok(!(await inT(() => Res.resolvedJournalEntries())).some((e) => e.slug === "off-post-u"), "not in shoppers' journal");
  eq(await liveText("docs", "off-post-u"), null, "the post 404s:");
  const pn = await current("docs", post.id);
  eq([pn.publishedVersionId, pn.undoneVersionId, pn.draftHash], [null, pb.publishedVersionId, pb.draftHash], "the post's row:");
  eq((await lastLog("docs", post.id)).action, "unpublish", "row:");
  // archive is allowed now
  const ar = await api({ archive: post.id, revision: pn.revision });
  eq(ar.status, 200, `archive: ${JSON.stringify(ar.body).slice(0, 200)}`);
  // singletons can't be taken offline
  const header = await create("docs", "header");
  published(await publishApi("docs", header.id), "header");
  const hr = await api({ unpublish: { id: header.id }, revision: (await current("docs", header.id)).revision });
  likeShape(hr, SHAPES.unpublish.outcomes.cannotTakeOffline, "singleton");
  eq(hr.body.error, "This part of the store can't be taken offline.", "words:");
});

console.log("— Recently published (PUB-04)");

await t("unit: listRecentlyPublished gives plain names, labels and summaries (never raw actor ids or hashes), newest first, grouped by set, canUndo only on current rows; the answers match documents-api-shapes.js", async () => {
  const st = "list";
  const a = await create(st, "page", { body: page("list-a", "List A", "A one.") });
  const b = await create(st, "page", { body: page("list-b", "List B", "B one.") });
  published(await publishApi(st, a.id), "a1");
  await save(st, a.id, page("list-a", "List A", "A one and a half."));
  const set = published(await publishSetApi(st, [a.id, b.id]), "a+b");
  eq(set.published.length, 2, "both in the set:");
  await save(st, a.id, page("list-a", "List A", "A two."));
  const a2 = published(await publishApi(st, a.id), "a2");
  const rows = await recent(st);
  const shape = SHAPES.listRecentlyPublished.outcomes.ok;
  likeShape({ status: 200, body: { ok: true, rows } }, shape, "list");
  for (const row of rows) sameKeys(row, shape.body.rows[0], ["note"]);
  // newest first
  for (let i = 1; i < rows.length; i++) ok(rows[i - 1].at >= rows[i].at, "newest first");
  eq(rows[0].documentId, a.id, "a's latest publish first:");
  eq(rows[0].setId, a2.setId, "its set:");
  // grouped by set
  const order = rows.map((r) => r.setId);
  for (const s of new Set(order)) {
    const at = order.map((x, i) => (x === s ? i : -1)).filter((i) => i >= 0);
    eq(at, at.map((_, k) => at[0] + k), `set ${s} is together:`);
  }
  ok(rows.filter((r) => r.setId === set.setId).length === 2, "the set's two rows");
  // names, labels and words
  for (const r of rows) {
    eq(r.byName, "Asha Rao", "plain name:");
    // "Home page" is the publish that opened the store (openStore)
    ok(["List A", "List B", "Home page"].includes(r.label), `label ${r.label}`);
    eq(r.actionWords, "Published", "action words:");
    const text = JSON.stringify([r.byName, r.label, r.actionWords, r.summary, r.note ?? null]);
    ok(!/merchant:|usr_|[0-9a-f]{32,}|\b(?:doc|ver|log|set|rel)_[A-Za-z0-9]/.test(text), `no raw ids or hashes: ${text}`);
  }
  // canUndo only on current rows: a's latest, and b's set row
  const can = rows.filter((r) => r.canUndo).map((r) => r.logId).sort();
  const aLatest = rows.find((r) => r.setId === a2.setId);
  const bSet = rows.find((r) => r.setId === set.setId && r.documentId === b.id);
  // (plus the home page's publish that opened the store: see openStore)
  // P3-FIX2: the home page's first publish is current, but its Undo would
  // only say "This is the first published version", so it is not offered
  const homeOpen = rows.find((r) => r.documentId === "doc_home");
  eq(can, [aLatest.logId, bSet.logId].sort(), "current rows:");
  eq([homeOpen.canUndo, homeOpen.undo], [false, null], "a singleton's first publish is not offered:");
  eq((await undoApi(st, "doc_home", homeOpen.logId)).body.nothing, true, "(its Undo would only say nothing)");
  for (const r of rows) eq(r.undo === null, !r.canUndo, "undo args only when it can:");
  eq(aLatest.undo, { id: a.id, revision: (await current(st, a.id)).revision, logId: aLatest.logId }, "undo args:");
  eq(aLatest.summary, [{ words: "Text: a paragraph changed" }], "the summary of a2:");
  // after an Undo: an 'Undid' row, and the next row back becomes current
  const u = await undoApi(st, a.id, aLatest.logId);
  eq(u.status, 200, "undo:");
  const rows2 = await recent(st);
  eq([rows2[0].action, rows2[0].actionWords, rows2[0].canUndo, rows2[0].undo], ["undo", "Undid", false, null], "the undo row:");
  ok(rows2.find((r) => r.setId === set.setId && r.documentId === a.id).canUndo, "a's set row is current again");
  // a legacy store answers 409 STORE_USES_LEGACY (the dispatcher)
  await raw[st].execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
  try {
    const lg = await api({ listRecentlyPublished: {} }, { store: st });
    likeShape(lg, SHAPES.listRecentlyPublished.outcomes.legacy, "legacy");
  } finally {
    await raw[st].execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  }
});

await t("unit: the Recently published summary of a first publish and of a take-offline row has no 'Search description changed' or 'reordered' rows", async () => {
  const st = "list";
  const d = await create(st, "page", { body: page("summary-first", "Summary first", "Words.") });
  published(await publishApi(st, d.id), "first");
  const firstRow = (await recent(st)).find((r) => r.documentId === d.id);
  eq(firstRow.summary, [{ words: 'Page title: "Summary first"' }, { words: "Text" }], "a first publish lists what went live:");
  const r = await api({ unpublish: { id: d.id }, revision: (await current(st, d.id)).revision }, { store: st });
  eq(r.status, 200, `unpublish: ${JSON.stringify(r.body).slice(0, 300)}`);
  const p = await create(st, "campaign", { body: page("summary-camp", "Summary camp", "Words.", "campaign") });
  published(await publishApi(st, p.id), "camp");
  eq((await undoApi(st, p.id, (await lastLog(st, p.id)).id)).status, 200, "undo of a first publish:");
  const rows = (await recent(st)).filter((x) => x.documentId === d.id || x.documentId === p.id);
  ok(rows.length === 4, `four rows (${rows.length})`);
  for (const row of rows) for (const s of row.summary) ok(!/Search description|reordered/i.test(s.words), `no false meta row: ${s.words}`);
  eq(rows.find((x) => x.action === "unpublish").summary, [{ words: "Taken offline" }], "take offline:");
  eq(rows.find((x) => x.action === "undo").summary, [{ words: "Taken offline" }], "an undo that took it offline:");
});

await t("unit: the target rule follows Undo's copies, and never counts an offline Undo as a copy (pure)", async () => {
  const doc = (pub, undone = null) => ({ publishedVersionId: pub, undoneVersionId: undone });
  const rows = [
    { id: "l1", action: "publish", from: null, to: "v1" },
    { id: "l2", action: "publish", from: "v1", to: "v2" },
    { id: "u2", action: "undo", undoes: "l2", from: "v2", to: "v1b" },
  ];
  let a = U.analyse(rows, doc("v1b"));
  eq(a.latest.id, "l1", "l2 is undone, so l1 is the latest undoable row:");
  ok(a.isCurrent(a.byId.get("l1")), "v1b is a copy of v1");
  ok(!a.isCurrent(a.byId.get("l2")), "an undone row is never current");
  ok(!a.isCurrent(a.byId.get("u2")), "an undo row is never a target");
  a = U.analyse([...rows, { id: "u1", action: "undo", undoes: "l1", from: "v1b", to: "voff" }], doc(null, "v1b"));
  eq(a.latest, null, "nothing left after the offline undo:");
  ok(a.tookOffline(a.byId.get("u1")), "u1 took it offline");
  a = U.analyse([{ id: "l1", action: "publish", from: null, to: "v1" }, { id: "p", action: "unpublish", from: "v1", to: "voff" }], doc(null, "v1"));
  ok(a.isCurrent(a.byId.get("p")), "an unpublish row is current while it is offline with that version undone");
  ok(!U.analyse([{ id: "p", action: "unpublish", from: "v1", to: "voff" }], doc(null, "v9")).isCurrent({ id: "p", action: "unpublish", from: "v1" }), "not when another version is undone");
  // a publish made while offline (from = an offline copy) plans as take offline
  const page_ = { type: "page" };
  const viaUnpublish = [{ id: "l1", action: "publish", from: null, to: "v1" }, { id: "p", action: "unpublish", from: "v1", to: "voff" }, { id: "l2", action: "publish", from: "voff", to: "v2" }];
  a = U.analyse(viaUnpublish, doc("v2", "v1"));
  ok(a.isCurrent(a.byId.get("l2")), "the publish made while offline is current");
  eq(U.__undoInternals.planOf(page_, a.byId.get("l2"), a), { mode: "offline" }, "its Undo takes the page offline (via unpublish):");
  const viaUndo = [{ id: "l1", action: "publish", from: null, to: "v1" }, { id: "u1", action: "undo", undoes: "l1", from: "v1", to: "voff" }, { id: "l2", action: "publish", from: "voff", to: "v2" }];
  a = U.analyse(viaUndo, doc("v2", "v1"));
  eq(U.__undoInternals.planOf(page_, a.byId.get("l2"), a), { mode: "offline" }, "its Undo takes the page offline (via an offline Undo):");
  const twice = [...viaUndo, { id: "u2", action: "undo", undoes: "l2", from: "v2", to: "voff2" }, { id: "l3", action: "publish", from: "voff2", to: "v3" }];
  a = U.analyse(twice, doc("v3", "v2"));
  ok(a.tookOffline(a.byId.get("u2")), "an Undo of a publish made while offline took it offline");
  eq(U.__undoInternals.planOf(page_, a.byId.get("l3"), a), { mode: "offline" }, "and the next publish's Undo goes offline too:");
  a = U.analyse([{ id: "l1", action: "publish", from: null, to: "v1" }, { id: "l2", action: "publish", from: "v1", to: "v2" }], doc("v2"));
  eq(U.__undoInternals.planOf(page_, a.byId.get("l2"), a), { mode: "restore", targetId: "v1" }, "a publish over a live version still steps back:");
});

await t("unit: the whole-set read uses 'WHERE set_id = ? AND set_id IS NOT NULL', so the publish_log_set index serves it; nothing but the console API imports undo.js (node only)", async () => {
  const { readdir } = await import("node:fs/promises");
  const src = await readFile(join(ROOT, "lib/documents/undo.js"), "utf8");
  const q = /"(SELECT id, document_id FROM publish_log WHERE set_id = \? AND set_id IS NOT NULL)"/.exec(src);
  ok(q, "the whole-set statement is written in that form");
  const planRows = await sql(`EXPLAIN QUERY PLAN ${q[1]}`, ["set_x"]);
  ok(planRows.some((r) => /publish_log_set/.test(String(r.detail))), `the plan uses publish_log_set: ${JSON.stringify(planRows)}`);
  const importers = [];
  const walk = async (dir) => {
    for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(p);
      } else if (/\.(m?js|jsx)$/.test(e.name) && /documents\/undo(\.js)?["']/.test(await readFile(join(ROOT, p), "utf8"))) importers.push(p);
    }
  };
  for (const d of ["app", "components", "lib"]) await walk(d);
  eq(importers, ["lib/admin/documents-api.js"], "importers:");
});

// P3-FIX4 (the FIX3 reviewer's probe, kept): the editor's whole-set Undo,
// end to end. createUndoFlow runs through the real client (createDocumentsApi)
// into the real handler (handleDocumentsPut: parser, revision rule, session,
// undo.js); only the HTTP hop between them is a plain JSON copy. Page X is published alone, then edited, then X and a new page Y go
// out as one set (Y's first publish). Both ways the editor builds the set
// target (the publish answer through outcomeOf, Recently published through
// recentGroupsOf) must give the confirm that names Y, each member's dry run
// must pass the real handler (no 428), and Confirm runs the real undoSet. A
// later change to what a dry-run undo needs fails here.
await t("P3-FIX4 unit (real handler): a set dry-run Undo from the editor passes createDocumentsApi and handleDocumentsPut; the confirm names the page that goes offline, and Confirm undoes the set", async () => {
  const M = await import("../components/admin/editor/publish/publishModel.js");
  const { createDocumentsApi } = await import("../components/admin/editor/documentsApi.js");
  const st = "sets";
  const sent = [];
  const fetch = async (_url, init) => {
    const reqBody = JSON.parse(init.body);
    // the handler answers { status, body }; the route sends that as JSON
    const res = await api(reqBody, { store: st });
    const data = JSON.parse(JSON.stringify(res.body));
    sent.push({ op: Object.keys(reqBody).find((k) => k !== "revision"), body: reqBody, status: res.status, data });
    return { status: res.status, json: async () => data };
  };
  const { call } = createDocumentsApi({ fetch });
  const x = await create(st, "page", { body: page("fix4-x", "Fix4 X", "X one.") });
  published(await publishApi(st, x.id), "X alone");
  await save(st, x.id, page("fix4-x", "Fix4 X", "X two."));
  const y = await create(st, "page", { body: page("fix4-y", "Fix4 Y", "Y one.") });
  const setAnswer = published(await publishSetApi(st, [x.id, y.id]), "X and Y as a set");
  const labels = { [x.id]: "Fix4 X", [y.id]: "Fix4 Y" };
  const items = [x.id, y.id].map((id) => ({ id, label: labels[id], type: "page" }));
  const fromPublish = M.outcomeOf({ ok: true, data: setAnswer }, { items, labels }).undoSet;
  ok(fromPublish?.revisions?.length === 2, `the publish answer's set target: ${JSON.stringify(fromPublish)}`);
  const rows = await recent(st);
  const groups = M.recentGroupsOf(rows, { timeZone: "UTC" });
  const fromRecent = groups.find((g) => g.undoSet?.setId === setAnswer.setId)?.undoSet;
  ok(fromRecent?.revisions?.length === 2, `Recently published's set target: ${JSON.stringify(fromRecent)}`);
  const title = "Undo all 2 pages of this publish? “Fix4 Y” goes offline.";
  for (const [name, target] of [
    ["the publish answer", { kind: "set", ...fromPublish }],
    ["Recently published", fromRecent],
  ]) {
    const before = await dump(st);
    sent.length = 0;
    const flow = M.createUndoFlow({ call });
    await flow.start(target);
    const v = flow.getState().view;
    eq([v?.title, v?.offline], [title, ["Fix4 Y"]], `${name}: the confirm: ${JSON.stringify(sent.map((r) => [r.op, r.status, r.data])).slice(0, 600)}`);
    eq(sent.map((r) => [r.op, r.status]), [["undoSet", 200], ["undo", 200], ["undo", 200]], `${name}: every dry run passes the real handler:`);
    ok(sent.every((r) => (r.body.undoSet || r.body.undo).dryRun === true), `${name}: dry runs only`);
    ok(sent.filter((r) => r.op === "undo").every((r) => Number.isInteger(r.body.revision)), `${name}: each member's dry run carries its revision`);
    await unchanged(before, `${name}: a dry run`, st);
  }
  // an autosave moves X's revision: a dry run still names Y (it doesn't compare revisions)
  await save(st, x.id, page("fix4-x", "Fix4 X", "X two, typed again."));
  const flow = M.createUndoFlow({ call });
  await flow.start(fromRecent);
  eq(flow.getState().view?.title, title, "after an autosave:");
  // Confirm: the real undoSet
  sent.length = 0;
  const done = await flow.confirm();
  eq(sent.map((r) => [r.op, r.status, r.body.undoSet?.dryRun ?? null]), [["undoSet", 200, null]], "Confirm sends the real undoSet:");
  ok(/Fix4 X/.test(done?.words) && /Fix4 Y/.test(done?.words) && /offline/.test(done?.words), `the server's words: ${done?.words}`);
  eq(await liveText(st, "fix4-x"), ["X one."], "X is back to its first version:");
  eq(await liveText(st, "fix4-y"), null, "Y is offline:");
});

// =========================================================================================
// A real sqld, through HEAD's lib/db.js.
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
let dataDir = null;
let sqldMs = 0;
try {
  console.log("— a real sqld");
  const found = H.findSqld(); // throws (the suite fails) when sqld is missing: never a skip
  const [sqldPort] = (process.env.TEST_PUBLISH_UNDO_PORTS || "").split(",").map((p) => Number(p) || 0);
  dataDir = await mkdtemp(join(tmpdir(), "storeasy-test-publish-undo-"));
  const t0 = Date.now();
  sqld = H.startSqld({ bin: found.bin, key: "publish-undo", port: sqldPort || (await freePort()), dataDir });
  await H.waitForHealth(sqld.url, sqld.child, { logFile: sqld.logFile, label: "test:publish-undo" });
  await addStore("sqld", sqld.url, createClient({ url: sqld.url }));
  await openStore("sqld");

  await t("unit (sqld): after Undo the live list serves the previous version, the draft equals it with revision+1, documents.slug and label follow the target, and publishing the unchanged draft is skipped", async () => {
    await undoBackCase("sqld");
  });

  await t("unit (sqld): an autosave between Undo's read and its batch makes it lose; it rebuilds on the new revision and keeps the autosave as undo_saved, with no orphan", async () => {
    const d = await create("sqld", "page", { body: page("sqld-race", "Sqld race", "One.") });
    published(await publishApi("sqld", d.id), "v1");
    await saveAndPublish("sqld", d.id, page("sqld-race", "Sqld race", "Two."));
    const sent = [];
    Pub.setPublishHooks({
      beforeCommit: async ({ attempt, build }) => {
        if (build.log[0]?.action !== "undo") return;
        sent.push(build.extraVersions?.[0]?.id ?? null);
        if (attempt === 1) await save("sqld", d.id, page("sqld-race", "Sqld race", "Gap."));
      },
    });
    const r = await undoApi("sqld", d.id, (await lastLog("sqld", d.id)).id);
    Pub.setPublishHooks({});
    eq(r.status, 200, `undo: ${JSON.stringify(r.body).slice(0, 300)}`);
    eq([sent.length, sent[0], typeof sent[1]], [2, null, "string"], "the first attempt had nothing to keep, the second keeps the autosave:");
    eq(r.body.savedVersion.id, sent[1], "saved:");
    eq(JSON.parse(String((await sql("SELECT body FROM document_versions WHERE id = ?", [sent[1]], "sqld"))[0].body)).sections[0].settings.body, ["Gap."], "its words:");
    eq(await liveText("sqld", "sqld-race"), ["One."], "v1 live:");
  });
  sqldMs = Date.now() - t0;
} catch (e) {
  fail++;
  console.error(`✗ the sqld cases could not run: ${e?.stack || e}`);
} finally {
  try {
    raw.sqld?.close();
  } catch {}
  if (sqld) await H.stopChild(sqld.child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

for (const s of STORES) raw[s].close();
for (const f of FILES) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(1)}s (sqld part ${(sqldMs / 1000).toFixed(1)}s).`);
process.exit(fail ? 1 : 0);
