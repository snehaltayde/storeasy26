// P2-DOCS: the document write service (lib/documents/service.js) and its
// console API (lib/admin/documents-api.js, behind PUT /api/admin/documents),
// run for real: real requireAdmin and sessions, real tenant databases with
// every migration, storage re-read after each refusal. Also the media scan of
// documents (lib/media.js), the team names behind "Earlier versions"
// (lib/platform/identity.js teamMemberNames) and a scan that no code outside
// lib/documents/ writes the document tables.
//   pnpm test:documents
import { readFile, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

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
process.env.DATABASE_URL = "file:.test-documents-default.db";
process.env.PLATFORM_DB_URL = "file:.test-documents-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-documents-default.db", ".test-documents-platform.db", ".test-documents-docs.db", ".test-documents-legacy.db", ".test-documents-firstrun.db"];
const cleanup = async () => {
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
};
await cleanup();

const started = Date.now();
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { currentDatabase } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const Docs = await import("../lib/documents/service.js");
const V = await import("../lib/documents/versions.js");
const { handleDocumentsPut, parseDocumentsOperation } = await import("../lib/admin/documents-api.js");
const R = await import("../lib/registry/index.js");
const M = await import("../lib/media.js");
const { issueText } = await import("../lib/cms/issues.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 3).join("\n   ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- fixtures ----------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
const raw = {};
for (const [key, file] of [["docs", ".test-documents-docs.db"], ["legacy", ".test-documents-legacy.db"], ["fr", ".test-documents-firstrun.db"]]) {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(schema);
  await runMigrations(c, migrations);
  raw[key] = c;
}
await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw.legacy.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
await raw.fr.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await C.upsertTenant({ id: "zd", name: "Docs", domains: ["zd.test"], dbUrl: "file:.test-documents-docs.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "zl", name: "Legacy", domains: ["zl.test"], dbUrl: "file:.test-documents-legacy.db", config: {}, secrets: {} });
// P6-GEN-WRITE: a fresh documents store of its own for the first-run writer
await C.upsertTenant({ id: "zf", name: "First run", domains: ["zf.test"], dbUrl: "file:.test-documents-firstrun.db", config: {}, secrets: {} });
const TEN = { docs: await C.getTenant("zd"), legacy: await C.getTenant("zl"), fr: await C.getTenant("zf") };

const ownerU = await I.createUser({ email: "asha@zd.test", name: "Asha Rao", password: "owner-pass-docs" });
const staffU = await I.createUser({ email: "ravi@zd.test", password: "staff-pass-docs" }); // no name: shown as "Someone on your team", never the email
const supportU = await I.createUser({ email: "help@zd.test", name: "Support Person", password: "support-pass-docs" });
const leftU = await I.createUser({ email: "left@zd.test", name: "Gone Person", password: "left-pass-docs" });
for (const tid of ["zd", "zl"]) {
  await I.addMembership(ownerU.id, tid, "owner");
  await I.addMembership(staffU.id, tid, "staff");
  await I.addMembership(supportU.id, tid, "support");
}
await I.addMembership(leftU.id, "zd", "staff");
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const SUPPORT = await tok(supportU);
const LEFT = await tok(leftU);

const req = (tenant, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${tenant.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
// Every issue that reaches the API in this suite, for the wording check.
const SEEN_ISSUES = [];
const api = async (body, { as = OWNER, store = "docs" } = {}) => {
  const r = await withTenant(TEN[store], () => handleDocumentsPut(req(TEN[store], as, body)));
  if (Array.isArray(r.body?.issues)) SEEN_ISSUES.push(...r.body.issues);
  return r;
};
const inT = (fn, store = "docs") => withTenant(TEN[store], fn);
const sql = async (q, args = [], store = "docs") => (await raw[store].execute({ sql: q, args })).rows;
// Everything a write could touch, to prove a refusal changed nothing.
const dump = async (store = "docs") => {
  const out = {};
  for (const table of ["documents", "document_versions", "publish_log", "release_state", "releases", "cms_state"]) {
    out[table] = (await raw[store].execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows.map((r) => ({ ...r }));
  }
  return JSON.stringify(out);
};
const unchanged = async (before, label, store = "docs") => eq(await dump(store), before, `${label}: storage changed:`);

const route = (slug, title, type = "page") => ({ ...R.emptyBody(type), meta: { ...R.emptyBody(type).meta, slug, title } });
const textSection = (id, title = "Hello", body = ["Some words."]) => ({ id, kind: "text", v: 1, enabled: true, settings: { title, body }, blocks: [] });
const create = async (args, opts) => api({ createDocument: args }, opts);
const save = async (id, revision, body, opts) => api({ saveDraft: { id, body }, revision }, opts);
const docRow = async (id) => (await sql("SELECT * FROM documents WHERE id = ?", [id]))[0];

// --- DOC-01: one store for every type ------------------------------------------------------
console.log("— one document store (DOC-01)");
const made = {};
await t("a home, a campaign, a journal post, the product layout and one product's content are rows of one table, created and saved through the same functions", async () => {
  const home = await create({ type: "home" });
  eq(home.status, 200, "home create:");
  eq(home.body.document.id, "doc_home", "a singleton id:");
  const camp = await create({ type: "campaign", meta: { slug: "summer-sale", title: "Summer sale" } });
  const post = await create({ type: "journal", meta: { slug: "our-story", title: "Our story" } });
  const layout = await create({ type: "product_layout" });
  const content = await create({ type: "product_content", entityId: "gid://shopify/Product/1" });
  for (const [name, r] of Object.entries({ camp, post, layout, content })) eq(r.status, 200, `${name} create:`);
  eq(layout.body.document.id, "doc_product_layout", "product layout is a singleton:");
  for (const r of [camp, post]) ok(/^doc_[a-z2-7]{16}$/.test(r.body.document.id), `random route id, got ${r.body.document.id}:`);
  // P4-LIVEROW: product content has its deterministic id (productDocumentId)
  ok(/^doc_prod_[0-9a-f]{16}$/.test(content.body.document.id), `product content id, got ${content.body.document.id}:`);
  Object.assign(made, { home: home.body.document, camp: camp.body.document, post: post.body.document, layout: layout.body.document, content: content.body.document });

  // ...and saved through the same saveDraft
  const withText = (d) => ({ ...d.body, sections: [...(d.body.sections || []), textSection("sec_t1")] });
  for (const [key, d] of Object.entries(made)) {
    const r = await save(d.id, d.revision, withText(d));
    eq(r.status, 200, `${key} save:`);
    eq(r.body.document.revision, 2, `${key} revision bumped:`);
    made[key] = r.body.document;
  }
  const rows = await sql("SELECT id, type, revision FROM documents ORDER BY type");
  eq(rows.map((r) => [r.type, r.revision]), [["campaign", 2], ["home", 2], ["journal", 2], ["product_content", 2], ["product_layout", 2]], "all in documents:");
  eq((await docRow(made.content.id)).entity_id, "gid://shopify/Product/1", "product content keeps its product:");
  const stored = JSON.parse((await docRow("doc_home")).draft);
  eq(stored.sections.map((s) => s.kind), ["text"], "the saved home draft:");
});

await t("an unregistered type is refused and nothing is stored; an unknown section kind gives 422 and nothing is stored", async () => {
  const before = await dump();
  const r = await create({ type: "landing_page", meta: { slug: "x", title: "X" } });
  eq(r.status, 422, "unknown type:");
  eq(r.body.issues.map((i) => i.code), ["UNKNOWN_TYPE"], "issue:");
  const s = await save("doc_home", made.home.revision, { ...made.home.body, sections: [{ id: "sec_zz1", kind: "carousel", v: 1, enabled: true, settings: {}, blocks: [] }] });
  eq(s.status, 422, "unknown kind:");
  ok(s.body.issues.some((i) => i.code === "UNKNOWN_KIND" && i.sectionId === "sec_zz1" && i.documentId === "doc_home"), `UNKNOWN_KIND on its section: ${JSON.stringify(s.body.issues)}`);
  const svc = await inT(() => Docs.createDocument({ type: "nope" }).then(() => "stored", (e) => e.code));
  eq(svc, "VALIDATION_FAILED", "the service itself refuses:");
  await unchanged(before, "refusals");
});

await t("a page's meta.slug change updates documents.slug and keeps the id; after renaming 'about' to 'about-us', a new 'about' can be created; after archiving a page, a page at its slug can be created", async () => {
  const about = (await create({ type: "page", meta: { slug: "about", title: "About us" } })).body.document;
  eq((await docRow(about.id)).slug, "about", "slug cached:");
  const renamed = await save(about.id, about.revision, { ...about.body, meta: { ...about.body.meta, slug: "about-us" } });
  eq(renamed.status, 200, "rename:");
  eq(renamed.body.document.id, about.id, "same id:");
  eq((await docRow(about.id)).slug, "about-us", "documents.slug follows meta.slug:");
  const again = await create({ type: "page", meta: { slug: "about", title: "About (new)" } });
  eq(again.status, 200, "a new 'about':");
  ok(again.body.document.id !== about.id, "a new id:");

  const old = (await create({ type: "page", meta: { slug: "old-offer", title: "Old offer" } })).body.document;
  const arch = await api({ archive: old.id, revision: old.revision });
  eq(arch.status, 200, "archive:");
  ok((await docRow(old.id)).archived_at, "archived_at set:");
  const reuse = await create({ type: "page", meta: { slug: "old-offer", title: "New offer" } });
  eq(reuse.status, 200, "a page at an archived page's slug:");
  made.aboutUs = renamed.body.document;
});

await t("two racing creates at one slug give one success and one 409 SLUG_TAKEN, never 422 or 5xx (10 races)", async () => {
  for (let i = 0; i < 10; i++) {
    const meta = (n) => ({ slug: `race-${i}`, title: `Racer ${n}` });
    const [a, b] = await Promise.all([create({ type: "page", meta: meta("A") }), create({ type: i % 2 ? "campaign" : "page", meta: meta("B") })]);
    const statuses = [a.status, b.status].sort();
    eq(statuses, [200, 409], `race ${i} statuses:`);
    const lost = a.status === 409 ? a : b;
    const won = a.status === 200 ? a : b;
    eq(lost.body.code, "SLUG_TAKEN", "code:");
    eq(lost.body.error, `Another page already uses /race-${i}: ${won.body.document.body.meta.title}`, "names the winner:");
    eq((await sql("SELECT count(*) AS n FROM documents WHERE slug = ?", [`race-${i}`]))[0].n, 1, "one row:");
  }
});

await t("saveDraft moving a page onto a taken slug gives 409 SLUG_TAKEN naming the other page, with storage unchanged", async () => {
  const page = (await create({ type: "page", meta: { slug: "contact", title: "Contact" } })).body.document;
  const before = await dump();
  const r = await save(page.id, page.revision, { ...page.body, meta: { ...page.body.meta, slug: "about-us" } });
  eq(r.status, 409, "status:");
  eq(r.body.code, "SLUG_TAKEN", "code:");
  eq(r.body.error, "Another page already uses /about-us: About us", "message:");
  eq(r.body.other?.id, made.aboutUs.id, "names the other page:");
  await unchanged(before, "slug clash");
});

// --- DOC-02: revisions -------------------------------------------------------------------
console.log("— revisions (DOC-02)");
await t("API: a stale saveDraft returns 409 with the current body and revision, and storage is unchanged", async () => {
  const d = made.camp;
  const theirs = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Theirs" } }, { as: STAFF });
  eq(theirs.status, 200, "their save:");
  const before = await dump();
  const mine = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Mine" } });
  eq(mine.status, 409, "status:");
  eq(mine.body.code, "DOCUMENT_CHANGED", "code:");
  eq(mine.body.current.revision, d.revision + 1, "the current revision rides along:");
  eq(mine.body.current.body.meta.title, "Theirs", "the current body rides along:");
  // P3-CHANGES: the only raw actor id is current.updatedBy, for the editor
  const { updatedBy, updatedByName, ...rest } = mine.body.current;
  ok(!JSON.stringify({ ...mine.body, current: rest }).includes("merchant:"), "no raw actor ids anywhere else:");
  // Phase 0 line 2 (S3): a member without a name is never shown by email
  eq([updatedBy, updatedByName], [`merchant:${staffU.id}`, "Someone on your team"], "who saved it (staff has no name, so never the email):");
  await unchanged(before, "stale save");
  made.camp = theirs.body.document;
});

await t("P3-CHANGES (ED-03): a stale saveDraft 409 names who saved it: a team member by plain name, 'another tab' for the same person, Storeasy for a system write; getDocument and the saved document carry no updatedBy", async () => {
  let d = (await create({ type: "page", meta: { slug: "who-saved", title: "Who saved" } })).body.document;
  const byOwner = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Owner's tab 1" } });
  eq(byOwner.status, 200, "owner saves:");
  ok(!("updatedBy" in byOwner.body.document) && !("updatedByName" in byOwner.body.document), "a save answer has no updatedBy:");
  const g = await api({ getDocument: d.id });
  ok(!("updatedBy" in g.body.document) && !JSON.stringify(g.body).includes("merchant:"), "getDocument has no updatedBy:");
  // the same owner, from a second tab still at the old revision
  const sameTab = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Owner's tab 2" } });
  eq([sameTab.status, sameTab.body.code], [409, "DOCUMENT_CHANGED"], "stale:");
  eq([sameTab.body.current.updatedBy, sameTab.body.current.updatedByName], [`merchant:${ownerU.id}`, "another tab"], "the same person:");
  // a team member with a name
  d = byOwner.body.document;
  const byLeft = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "By Gone Person" } }, { as: LEFT });
  eq(byLeft.status, 200, "the other member saves:");
  const other = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Mine" } });
  eq(other.body.current.updatedByName, "Gone Person", "a team member's plain name:");
  // a write with no actor (a system writer)
  d = byLeft.body.document;
  await inT(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, meta: { ...d.body.meta, title: "System" } }, actor: null }));
  const sys = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Mine again" } });
  eq([sys.body.current.updatedBy, sys.body.current.updatedByName], [null, "Storeasy"], "a system write:");
  // the same holds when the stale write slips past the first read (settle)
  d = (await api({ getDocument: d.id })).body.document;
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.batch;
  inst.libsql.batch = async (stmts, mode) => {
    delete inst.libsql.batch;
    await raw.docs.execute({ sql: "UPDATE documents SET revision = revision + 1, updated_by = ? WHERE id = ?", args: [`merchant:${ownerU.id}`, d.id] });
    return send.call(inst.libsql, stmts, mode);
  };
  let late;
  try {
    late = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Late" } }, { as: STAFF });
  } finally {
    delete inst.libsql.batch;
  }
  eq([late.status, late.body.current.updatedByName], [409, "Asha Rao"], "inside the batch too:");
});

await t("a stale write that slips past the first read still loses inside the batch (the guarded UPDATE and its abort), storage unchanged", async () => {
  const d = made.post;
  // another save lands between our read and our batch
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.batch;
  inst.libsql.batch = async (stmts, mode) => {
    delete inst.libsql.batch;
    await raw.docs.execute({ sql: "UPDATE documents SET revision = revision + 1, draft = ?, updated_at = 'theirs' WHERE id = ?", args: [JSON.stringify({ ...d.body, meta: { ...d.body.meta, title: "Theirs" } }), d.id] });
    snap = await dump();
    return send.call(inst.libsql, stmts, mode);
  };
  let snap = null;
  let r;
  try {
    r = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Mine" } });
  } finally {
    delete inst.libsql.batch;
  }
  ok(snap, "the other save landed between the read and the batch:");
  await unchanged(snap, "the losing batch");
  eq(r.status, 409, "status:");
  eq(r.body.code, "DOCUMENT_CHANGED", "code:");
  eq(r.body.current.body.meta.title, "Theirs", "theirs kept:");
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND body LIKE '%Mine%'", [d.id]))[0].n, 0, "no checkpoint of the losing save:");
  made.post = (await api({ getDocument: d.id })).body.document;
});

await t("a save whose answer was lost after it committed is reported saved (200), never as a conflict or a failure", async () => {
  const d = made.post;
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.batch;
  inst.libsql.batch = async (stmts, mode) => {
    await send.call(inst.libsql, stmts, mode);
    throw Object.assign(new TypeError("fetch failed"), {});
  };
  let r;
  try {
    r = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Committed" } });
  } finally {
    delete inst.libsql.batch;
  }
  eq(r.status, 200, "status:");
  eq((await docRow(d.id)).revision, d.revision + 1, "stored once:");
  made.post = r.body.document;
});

// P2-DOCFIX (1): the same lost answer on a create of a page with an address.
// lib/db.js sends the committed batch again, and SQLite reports the slug clash
// with the founder's own new row first.
await t("a create of a page with an address whose answer was lost and resent answers 200 for the founder's own page, never SLUG_TAKEN naming itself", async () => {
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.batch;
  let sent = 0;
  inst.libsql.batch = async (stmts, mode) => {
    sent++;
    await send.call(inst.libsql, stmts, mode);
    throw Object.assign(new TypeError("fetch failed"), {});
  };
  let r;
  try {
    r = await create({ type: "page", meta: { slug: "lost-sale", title: "Sale page" } });
  } finally {
    delete inst.libsql.batch;
  }
  ok(sent >= 1, `lib/db.js sent the batch (${sent} sends, reconciled without blind write retry):`);
  eq([r.status, r.body.code ?? null], [200, null], `answer ${JSON.stringify(r.body).slice(0, 200)}:`);
  const rows = await sql("SELECT id FROM documents WHERE slug = 'lost-sale'");
  eq(rows.map((x) => x.id), [r.body.document.id], "one row, the one the founder was told about:");
  eq(r.body.document.body.meta.title, "Sale page", "their page:");
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ?", [r.body.document.id]))[0].n, 1, "one 'Created' checkpoint:");
  // a real clash at the same address is still a 409 naming the other page
  const clash = await create({ type: "page", meta: { slug: "lost-sale", title: "Another" } });
  eq([clash.status, clash.body.code, clash.body.error], [409, "SLUG_TAKEN", "Another page already uses /lost-sale: Sale page"], "a real clash:");
});

await t("API: archive, discardDraft and restoreVersion (and saveDraft) with no revision return 428, and storage is unchanged", async () => {
  const before = await dump();
  const vid = (await sql("SELECT id FROM document_versions WHERE document_id = 'doc_home' LIMIT 1"))[0].id;
  for (const body of [{ archive: made.camp.id }, { discardDraft: made.camp.id }, { restoreVersion: { id: "doc_home", versionId: vid } }, { saveDraft: { id: "doc_home", body: made.home.body } }, { archive: made.camp.id, revision: null }]) {
    const r = await api(body);
    eq(r.status, 428, `${Object.keys(body)[0]} status:`);
    eq(r.body.code, "REVISION_REQUIRED", "code:");
  }
  await unchanged(before, "428s");
});

await t("archive is refused on a live document; discardDraft puts the live version back into the draft and keeps the old draft as a checkpoint", async () => {
  const d = made.camp;
  // stand in for P2-PUBLISH: one published version, pointed at by the document
  const pub = await V.versionRow({ documentId: d.id, kind: "published", body: d.body, schemaVersion: 1, createdBy: `merchant:${ownerU.id}`, createdAt: new Date().toISOString() });
  await raw.docs.execute(V.versionStatement(pub));
  await raw.docs.execute({ sql: "UPDATE documents SET published_version_id = ?, published_hash = draft_hash WHERE id = ?", args: [pub.id, d.id] });
  const before = await dump();
  const a = await api({ archive: d.id, revision: d.revision });
  eq([a.status, a.body.code], [409, "DOCUMENT_LIVE"], "archive refused:");
  await unchanged(before, "archive of a live page");

  const edited = await save(d.id, d.revision, { ...d.body, meta: { ...d.body.meta, title: "Unpublished edit" } });
  eq(edited.status, 200, "edit:");
  const disc = await api({ discardDraft: d.id, revision: edited.body.document.revision });
  eq(disc.status, 200, "discard:");
  eq(disc.body.document.body.meta.title, d.body.meta.title, "the draft is the live body again:");
  eq(disc.body.document.unpublishedChanges, false, "no unpublished changes:");
  const kept = await sql("SELECT body FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' ORDER BY created_at DESC, rowid DESC LIMIT 1", [d.id]);
  eq(JSON.parse(kept[0].body).meta.title, "Unpublished edit", "the discarded draft is kept:");
  const never = await api({ discardDraft: made.post.id, revision: made.post.revision });
  eq([never.status, never.body.code], [409, "NOTHING_PUBLISHED"], "never published:");
  made.camp = disc.body.document;
});

// --- DOC-04 / DOC-05: tolerant drafts, strict structure, sanitizing -----------------------
console.log("— drafts are tolerant, structure and sanitizing are not (DOC-04, DOC-05)");
await t("a draft with <script> stores no script", async () => {
  const d = made.post;
  const body = { ...d.body, sections: [{ id: "sec_rt1", kind: "rich_text", v: 1, enabled: true, settings: { title: "", html: "<p>Hello</p><script>alert(1)</script>" }, blocks: [] }] };
  const r = await save(d.id, d.revision, body);
  eq(r.status, 200, "status:");
  const stored = (await docRow(d.id)).draft;
  ok(!/<script/i.test(stored), `no script stored: ${stored}`);
  eq(JSON.parse(stored).sections[0].settings.html, "<p>Hello</p>", "the words are kept:");
  ok(!/<script/i.test((await sql("SELECT group_concat(body) AS b FROM document_versions WHERE document_id = ?", [d.id]))[0].b || ""), "no script in any version either:");
  made.post = r.body.document;
});

await t("a new banner with no text saves (200) with an 'incomplete' issue carrying documentId, sectionId and field", async () => {
  const banner = R.newSection("banner", { id: "sec_bn1" });
  const r = await save("doc_home", made.home.revision, { ...made.home.body, sections: [banner] });
  eq(r.status, 200, "status:");
  const inc = r.body.issues.filter((i) => i.severity === "incomplete");
  ok(inc.length > 0, `incomplete issues: ${JSON.stringify(r.body.issues)}`);
  for (const i of inc) {
    eq(i.documentId, "doc_home", "documentId:");
    eq(i.sectionId, "sec_bn1", "sectionId:");
    ok(typeof i.field === "string" && i.field, "field:");
  }
  made.home = r.body.document;
});

await t("an explicit empty sections list on the home draft is stored and read back as [], never defaults (DOC-07)", async () => {
  const r = await save("doc_home", made.home.revision, { ...made.home.body, sections: [] });
  eq(r.status, 200, "status:");
  eq(JSON.parse((await docRow("doc_home")).draft).sections, [], "stored:");
  const g = await api({ getDocument: "doc_home" });
  eq(g.body.document.body.sections, [], "read back:");
  made.home = g.body.document;
});

await t("a founder can add an image to the hero through the API (DOC-07)", async () => {
  const hero = { ...R.newSection("hero", { id: "sec_hero1" }), settings: { ...R.newSection("hero").settings, image: { media: "/api/media/med_heroimg000000000001", alt: "Our jar" } } };
  const r = await save("doc_home", made.home.revision, { ...made.home.body, sections: [hero] });
  eq(r.status, 200, `status: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(JSON.parse((await docRow("doc_home")).draft).sections[0].settings.image, { media: "/api/media/med_heroimg000000000001", alt: "Our jar" }, "stored:");
  made.home = r.body.document;
});

// --- P3-VALIDATE (PV-02): one half-typed field never blocks saving the rest ----------------
console.log("— one broken section never blocks the rest (PV-02)");
await t("saveDraft of a home body with a banner link that isn't a store page and a hero title edit is 200: the hero edit is stored, the banner's issue is 'incomplete', and publishing that body is 422 naming the banner", async () => {
  const before = made.home;
  const hero = { ...R.newSection("hero", { id: "sec_hero1" }), settings: { ...R.newSection("hero").settings, title: "A brand new hero title" } };
  const banner = { ...R.newSection("banner", { id: "sec_bnbad" }), settings: { title: "Summer sale", text: "", button: { label: "Shop now", link: { type: "url", href: "https://evil.example/sale" } } } };
  const body = { ...made.home.body, sections: [hero, banner] };
  const r = await save("doc_home", made.home.revision, body);
  eq(r.status, 200, `status: ${JSON.stringify(r.body).slice(0, 300)}`);
  const stored = JSON.parse((await docRow("doc_home")).draft);
  eq(stored.sections[0].settings.title, "A brand new hero title", "the hero edit is stored:");
  eq(stored.sections[1].settings.button.link.href, "https://evil.example/sale", "the banner is stored as typed:");
  const link = r.body.issues.filter((i) => i.code === "LINK_NOT_STOREFRONT");
  eq(link.map((i) => [i.sectionId, i.field, i.severity]), [["sec_bnbad", "button.link.href", "incomplete"]], "the banner's issue:");
  eq(R.where(link[0], stored), "Banner · Button", "where:");
  made.home = r.body.document;

  // publishing exactly that body is refused, naming the banner; nothing changes
  const snap = await dump();
  const pub = await api({ publish: { id: "doc_home", draftHash: made.home.draftHash }, revision: made.home.revision });
  eq(pub.status, 422, `publish: ${JSON.stringify(pub.body).slice(0, 300)}`);
  const blocking = pub.body.issues.filter((i) => i.severity === "error");
  ok(blocking.length > 0, "an error blocks");
  ok(blocking.every((i) => i.sectionId === "sec_bnbad"), `only the banner blocks: ${JSON.stringify(blocking.map((i) => [i.sectionId, i.code]))}`);
  ok(blocking.some((i) => i.code === "LINK_NOT_STOREFRONT" && R.where(i, stored) === "Banner · Button" && /isn't a page of your store/.test(i.message)), "the banner is named");
  await unchanged(snap, "a refused publish");
  ok(before.revision < made.home.revision, "revision moved on");
});

await t("saveDraft of a page with a too-long title, or a menu item with a bad link, is 200 with an 'incomplete' issue; SLUG_INVALID or a structure issue is 422 with nothing stored", async () => {
  // a page title over its limit
  const p = (await create({ type: "page", meta: { slug: "pv-long", title: "Short" } })).body.document;
  const longTitle = "T".repeat(130);
  const r1 = await save(p.id, p.revision, { ...p.body, meta: { ...p.body.meta, title: longTitle } });
  eq(r1.status, 200, `long title: ${JSON.stringify(r1.body).slice(0, 300)}`);
  eq(r1.body.issues.filter((i) => i.code === "TOO_LONG").map((i) => [i.field, i.severity]), [["meta.title", "incomplete"]], "the title issue:");
  eq(JSON.parse((await docRow(p.id)).draft).meta.title, longTitle, "stored as typed:");
  let cur = r1.body.document;

  // a header menu item with a link that isn't a page of the store
  const hdr = (await create({ type: "header" })).body.document;
  const items = [{ label: "Admin", link: { type: "url", href: "/admin" } }, { label: "Shop", link: { type: "collection", handle: "all" } }];
  const r2 = await save(hdr.id, hdr.revision, { ...hdr.body, settings: { ...hdr.body.settings, mode: "custom", items } });
  eq(r2.status, 200, `menu link: ${JSON.stringify(r2.body).slice(0, 300)}`);
  eq(r2.body.issues.filter((i) => i.code === "LINK_NOT_STOREFRONT").map((i) => [i.documentId, i.field, i.severity]), [["doc_header", "items.0.link.href", "incomplete"]], "the menu issue:");
  eq(JSON.parse((await docRow(hdr.id)).draft).settings.items, items, "stored as typed:");

  // still refused, nothing stored: an invalid web address, and structure
  for (const [label, body, code] of [
    ["an invalid web address", { ...cur.body, meta: { ...cur.body.meta, slug: "Big Sale!" } }, "SLUG_INVALID"],
    ["a title that isn't text", { ...cur.body, meta: { ...cur.body.meta, title: 42 } }, "INVALID_VALUE"],
    ["an unknown section kind", { ...cur.body, sections: [{ id: "sec_zz2", kind: "carousel", v: 1, enabled: true, settings: {}, blocks: [] }] }, "UNKNOWN_KIND"],
    ["an unknown setting", { ...cur.body, sections: [{ ...textSection("sec_t9"), settings: { title: "T", body: [], colour: "red" } }] }, "UNKNOWN_FIELD"],
  ]) {
    const snap = await dump();
    const r = await save(cur.id, cur.revision, body);
    eq(r.status, 422, `${label}: ${JSON.stringify(r.body).slice(0, 200)}`);
    ok(r.body.issues.some((i) => i.code === code && i.severity === "error"), `${label}: ${code} is an error`);
    await unchanged(snap, label);
  }
  // and createDocument the same way
  const snap = await dump();
  const c = await create({ type: "page", meta: { slug: "Not Valid", title: "x" } });
  eq(c.status, 422, "create with an invalid web address:");
  await unchanged(snap, "create");
  const c2 = await create({ type: "page", meta: { slug: "pv-long-2", title: "D".repeat(130) } });
  eq([c2.status, c2.body.issues?.find((i) => i.field === "meta.title")?.severity], [200, "incomplete"], "create with a too-long title:");
});

// --- DOC-08: versions ---------------------------------------------------------------------
console.log("— earlier versions (DOC-08)");
await t("restoreVersion puts the version into the draft, bumps the revision and leaves release_state (and releases) untouched", async () => {
  V.setCheckpointInterval(0);
  let d;
  try {
    d = (await create({ type: "page", meta: { slug: "our-team", title: "Our team" } })).body.document;
    d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_r1", "First words")] })).body.document;
  } finally {
    V.setCheckpointInterval(null);
  }
  const first = (await sql("SELECT id, body FROM document_versions WHERE document_id = ? AND body LIKE '%First words%'", [d.id]))[0];
  const now = await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_r1", "Changed since")] });
  eq(now.status, 200, "the later edit:");
  const liveBefore = JSON.stringify(await sql("SELECT * FROM release_state")) + JSON.stringify(await sql("SELECT * FROM releases"));
  const r = await api({ restoreVersion: { id: d.id, versionId: first.id }, revision: now.body.document.revision });
  eq(r.status, 200, `status: ${JSON.stringify(r.body).slice(0, 200)}`);
  eq(r.body.document.revision, now.body.document.revision + 1, "revision bumped:");
  eq(r.body.document.body.sections[0].settings.title, "First words", "the version is the draft:");
  eq(JSON.parse((await docRow(d.id)).draft).sections[0].settings.title, "First words", "stored:");
  eq(JSON.stringify(await sql("SELECT * FROM release_state")) + JSON.stringify(await sql("SELECT * FROM releases")), liveBefore, "the live store is untouched:");
  const kept = await sql("SELECT body FROM document_versions WHERE document_id = ? AND note = 'Before restoring an earlier version'", [d.id]);
  eq(kept.length, 1, "the replaced draft is kept:");
  eq(JSON.parse(kept[0].body).sections[0].settings.title, "Changed since", "with its words:");
});

await t("restoring a version whose address another page now uses gives 409 SLUG_TAKEN and changes nothing", async () => {
  const d = made.aboutUs; // created at /about, renamed to /about-us; a new page took /about since
  const first = (await sql("SELECT id, body FROM document_versions WHERE document_id = ? ORDER BY created_at, rowid LIMIT 1", [d.id]))[0];
  eq(JSON.parse(first.body).meta.slug, "about", "the old version's address:");
  const before = await dump();
  const r = await api({ restoreVersion: { id: d.id, versionId: first.id }, revision: d.revision });
  eq([r.status, r.body.code, r.body.error], [409, "SLUG_TAKEN", "Another page already uses /about: About (new)"], "refused:");
  await unchanged(before, "restore onto a taken slug");
});

await t("an undo_saved version survives 100 later autosaves (interval 0) and appears in listHistory; checkpoints never exceed 20 per document", async () => {
  V.setCheckpointInterval(0);
  try {
    let d = (await create({ type: "page", meta: { slug: "busy-page", title: "Busy" } })).body.document;
    const saved = await inT(() => Docs.saveVersion({ documentId: d.id, kind: "undo_saved", actor: { kind: "merchant", id: ownerU.id }, note: "Edits kept by Undo" }));
    let most = 0;
    for (let i = 0; i < 100; i++) {
      const r = await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_b1", `Save ${i}`)] });
      if (r.status !== 200) throw new Error(`save ${i}: ${r.status} ${JSON.stringify(r.body)}`);
      d = r.body.document;
      const n = (await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'checkpoint'", [d.id]))[0].n;
      most = Math.max(most, Number(n));
    }
    eq(most, 20, "checkpoints at most (and reaching) 20:");
    eq((await sql("SELECT kind FROM document_versions WHERE id = ?", [saved.id]))[0]?.kind, "undo_saved", "the undo_saved version is still there:");
    const h = await api({ listHistory: d.id });
    eq(h.status, 200, "history:");
    const it = h.body.versions.find((v) => v.id === saved.id);
    ok(it, "listed:");
    eq([it.kind, it.by, it.note], ["undo_saved", "Asha Rao", "Edits kept by Undo"], "how it is listed:");
    eq(h.body.versions.length, 21, "20 checkpoints plus the undo_saved one:");
    const newest = JSON.parse((await sql("SELECT body FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' ORDER BY created_at DESC, rowid DESC LIMIT 1", [d.id]))[0].body);
    eq(newest.sections[0].settings.title, "Save 99", "the newest checkpoint is the last save:");
    made.busy = d;
  } finally {
    V.setCheckpointInterval(null);
  }
});

await t("at the normal 5-minute interval, autosaves in a row add no checkpoint after the first", async () => {
  let d = (await create({ type: "page", meta: { slug: "calm-page", title: "Calm" } })).body.document;
  for (let i = 0; i < 5; i++) d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_c1", `Edit ${i}`)] })).body.document;
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'checkpoint'", [d.id]))[0].n, 1, "only the one made at create:");
});

await t("pruning never removes a checkpoint referenced by publish_log (from, to or saved); the trigger blocks deleting published, migrated or undo_saved versions", async () => {
  V.setCheckpointInterval(0);
  try {
    let d = made.busy;
    const oldest = await sql("SELECT id FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' ORDER BY created_at, rowid LIMIT 3", [d.id]);
    const [a, b, c] = oldest.map((r) => r.id);
    const at = new Date().toISOString();
    await raw.docs.execute({ sql: "INSERT INTO publish_log (id, set_id, document_id, action, from_version_id, created_at) VALUES ('log_t1', 'set_t1', ?, 'publish', ?, ?)", args: [d.id, a, at] });
    await raw.docs.execute({ sql: "INSERT INTO publish_log (id, set_id, document_id, action, to_version_id, created_at) VALUES ('log_t2', 'set_t1', ?, 'publish', ?, ?)", args: [d.id, b, at] });
    await raw.docs.execute({ sql: "INSERT INTO publish_log (id, set_id, document_id, action, saved_version_id, created_at) VALUES ('log_t3', 'set_t1', ?, 'undo', ?, ?)", args: [d.id, c, at] });
    for (let i = 0; i < 30; i++) d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_b1", `Later ${i}`)] })).body.document;
    const left = (await sql(`SELECT id FROM document_versions WHERE id IN (?, ?, ?)`, [a, b, c])).map((r) => r.id).sort();
    eq(left, [a, b, c].sort(), "all three referenced checkpoints kept:");
    const unref = (await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' AND id NOT IN (?, ?, ?)", [d.id, a, b, c]))[0].n;
    eq(unref, 17, "the rest is still capped (20 newest, minus the 3 old ones kept by the log):");
  } finally {
    V.setCheckpointInterval(null);
  }
  const at = new Date().toISOString();
  for (const kind of ["published", "migrated", "undo_saved"]) {
    const row = await V.versionRow({ documentId: "doc_x", kind, body: { schema: 1 }, schemaVersion: 1, createdAt: at });
    await raw.docs.execute(V.versionStatement(row));
    let refused = null;
    await raw.docs.execute({ sql: "DELETE FROM document_versions WHERE id = ?", args: [row.id] }).catch((e) => (refused = String(e.message)));
    ok(/only checkpoint versions can be deleted/.test(refused || ""), `${kind}: the trigger refuses, got ${refused}`);
  }
});

await t("listHistory shows plain names, never matching /^(user|member|tenant|kind)[:_]/", async () => {
  const d = (await create({ type: "page", meta: { slug: "names", title: "Names" } }, { as: STAFF })).body.document;
  let cur = d;
  for (const as of [OWNER, LEFT]) {
    V.setCheckpointInterval(0);
    cur = (await save(cur.id, cur.revision, { ...cur.body, meta: { ...cur.body.meta, title: `By ${as === OWNER ? "owner" : "left"}` } }, { as })).body.document;
    V.setCheckpointInterval(null);
  }
  await I.removeMembership(leftU.id, "zd"); // they left the store since
  const at = new Date().toISOString();
  for (const [by, note] of [[`operator-support:op_1`, "support"], [null, "system"], ["bootstrap:bootstrap", "bootstrap"], ["user:u_raw", "odd"]]) {
    await raw.docs.execute(V.versionStatement(await V.versionRow({ documentId: d.id, kind: "undo_saved", body: { schema: 1 }, schemaVersion: 1, createdBy: by, createdAt: at, note })));
  }
  const h = await api({ listHistory: d.id }, { as: SUPPORT });
  eq(h.status, 200, "a read-only role can read history:");
  const by = Object.fromEntries(h.body.versions.map((v) => [v.note ?? v.id, v.by]));
  for (const v of h.body.versions) ok(!/^(user|member|tenant|kind)[:_]/.test(v.by) && !/^(merchant|bootstrap|operator)/.test(v.by) && !/\bu_[0-9a-f]+/.test(v.by), `plain name, got "${v.by}"`);
  const names = new Set(h.body.versions.map((v) => v.by));
  for (const want of ["Asha Rao", "Someone on your team", "Storeasy"]) ok(names.has(want), `"${want}" listed: ${JSON.stringify([...names])}`);
  ok(!names.has("ravi@zd.test"), "the nameless member is never shown by email (Phase 0 line 2, S3):");
  eq([by.support, by.system, by.bootstrap, by.odd], ["Storeasy", "Storeasy", "Someone on your team", "Someone on your team"], "fallbacks:");
  ok(!names.has("Gone Person"), "someone who left is not named:");
  eq((await I.teamMemberNames("zd")).get(ownerU.id), "Asha Rao", "teamMemberNames:");
});

// --- media --------------------------------------------------------------------------------
console.log("— media in documents (lib/media.js)");
const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 1, 2, 3, 4, 5, 6, 7]);
await t("a media id used only in a doc_home draft, or only in a retained version body, is reported in use with the right label, and deleteMedia refuses it (even forced); unused media still deletes", async () => {
  const up = (n) => inT(() => M.saveMedia({ filename: `p${n}.png`, mime: "image/png", bytes: PNG(n) }));
  const inDraft = await up(1);
  const inOld = await up(2);
  const inLive = await up(3);
  const unused = await up(4);
  const heroWith = (src) => ({ ...R.newSection("hero", { id: "sec_hero1" }), settings: { ...R.newSection("hero").settings, image: { media: src, alt: "Jar" } } });

  // only in an older version: saved into the home draft, then replaced
  let home = (await save("doc_home", made.home.revision, { ...made.home.body, sections: [heroWith(M.mediaUrl(inOld.id))] })).body.document;
  const oldVersion = await inT(() => Docs.saveVersion({ documentId: "doc_home", kind: "undo_saved" }));
  home = (await save("doc_home", home.revision, { ...home.body, sections: [heroWith(M.mediaUrl(inDraft.id))] })).body.document;
  // only in the live version of the campaign
  const camp = made.camp;
  const live = await V.versionRow({ documentId: camp.id, kind: "published", body: { ...camp.body, sections: [{ id: "sec_iw1", kind: "image_with_text", v: 1, enabled: true, settings: { image: { media: M.mediaUrl(inLive.id), alt: "x" } }, blocks: [] }] }, schemaVersion: 1, createdAt: new Date().toISOString() });
  await raw.docs.execute(V.versionStatement(live));
  // P4-MEDIA: a documents store reads usage from the reference index, which
  // the publish batch writes with every published version; this hand-made
  // live version gets its rows the same way (refRows of its body)
  const Refs = await import("../lib/documents/refs.js");
  for (const st of Refs.refInsertStatements(Refs.refRows(live.id, JSON.parse(live.body)))) await raw.docs.execute(st);
  await raw.docs.execute({ sql: "UPDATE documents SET published_version_id = ? WHERE id = ?", args: [live.id, camp.id] });
  ok(!(await docRow(camp.id)).draft.includes(inLive.id), "the campaign draft doesn't use it:");
  made.home = home;

  const uses = async (m) => (await inT(() => M.mediaUsage(m.id))).map((u) => [u.label, u.document]);
  eq(await uses(inDraft), [["draft", "doc_home"]], "draft only:");
  eq(await uses(inOld), [["older version", "doc_home"]], "older version only:");
  eq(await uses(inLive), [["live", camp.id]], "live only:");
  eq(await uses(unused), [], "unused:");
  ok(oldVersion.id, "the version holding it:");

  for (const [m, label] of [[inDraft, "draft"], [inOld, "older version"], [inLive, "live"]]) {
    for (const force of [false, true]) {
      const code = await inT(() => M.deleteMedia(m.id, { force }).then(() => "deleted", (e) => e.code));
      eq(code, "MEDIA_IN_USE", `${label}${force ? " (forced)" : ""}:`);
    }
    eq((await sql("SELECT count(*) AS n FROM media WHERE id = ?", [m.id]))[0].n, 1, `${label} still stored:`);
  }
  const msg = await inT(() => M.deleteMedia(inDraft.id).catch((e) => e.message));
  ok(/Home page \(draft\)/.test(msg), `the refusal names the page: ${msg}`);
  const gone = await inT(() => M.deleteMedia(unused.id));
  eq(gone.deleted, unused.id, "unused deletes:");
  eq((await sql("SELECT count(*) AS n FROM media WHERE id = ?", [unused.id]))[0].n, 0, "really gone:");
});

await t("an archived document's draft no longer holds media in use, but its kept versions still do", async () => {
  const m = await inT(() => M.saveMedia({ filename: "arch.png", mime: "image/png", bytes: PNG(9) }));
  const p = (await create({ type: "page", meta: { slug: "arch-media", title: "Arch" }, body: { ...route("arch-media", "Arch"), sections: [{ id: "sec_im1", kind: "image_with_text", v: 1, enabled: true, settings: { image: { media: M.mediaUrl(m.id), alt: "x" } }, blocks: [] }] } })).body.document;
  eq((await inT(() => M.mediaUsage(m.id))).map((u) => u.label).sort(), ["draft", "older version"], "draft and the create checkpoint:");
  await api({ archive: p.id, revision: p.revision });
  eq((await inT(() => M.mediaUsage(m.id))).map((u) => u.label), ["older version"], "after archive:");
});

await t("a media scan that can't read the documents tables refuses the delete (5xx path), never lets it through", async () => {
  const m = await inT(() => M.saveMedia({ filename: "scan.png", mime: "image/png", bytes: PNG(11) }));
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.execute;
  inst.libsql.execute = (stmt, ...rest) =>
    /FROM documents WHERE archived_at IS NULL AND \(instr/.test(typeof stmt === "string" ? stmt : stmt?.sql || "")
      ? Promise.reject(Object.assign(new Error("SQLITE_ERROR: disk I/O error"), { name: "LibsqlError", code: "SQLITE_IOERR" }))
      : send.call(inst.libsql, stmt, ...rest);
  let out;
  try {
    out = await inT(() => M.deleteMedia(m.id).then(() => "deleted", (e) => e.code));
  } finally {
    delete inst.libsql.execute;
  }
  eq(out, "SQLITE_IOERR", "the scan's own failure:");
  eq((await sql("SELECT count(*) AS n FROM media WHERE id = ?", [m.id]))[0].n, 1, "not deleted:");
});

// --- the API ------------------------------------------------------------------------------
console.log("— the API (authorization, mode, parsing)");
const WRITE_BODIES = () => [
  { createDocument: { type: "page", meta: { slug: "support-made", title: "S" } } },
  { saveDraft: { id: "doc_home", body: made.home.body }, revision: made.home.revision },
  { discardDraft: made.camp.id, revision: made.camp.revision },
  { restoreVersion: { id: "doc_home", versionId: "ver_x" }, revision: made.home.revision },
  { archive: made.post.id, revision: made.post.revision },
];
await t("API: storefront.read-only staff get 403 on every write op, with storage unchanged; their reads work", async () => {
  const before = await dump();
  for (const body of WRITE_BODIES()) {
    const r = await api(body, { as: SUPPORT });
    eq(r.status, 403, `${Object.keys(body)[0]}:`);
  }
  await unchanged(before, "support writes");
  for (const body of [{ getDocument: "doc_home" }, { listDocuments: true }, { listHistory: "doc_home" }]) eq((await api(body, { as: SUPPORT })).status, 200, `${Object.keys(body)[0]} read:`);
  eq((await api({ listDocuments: true }, { as: null })).status, 401, "signed out:");
});

await t("API: a mixed payload gives 400 before anything is authorized or written, for every role", async () => {
  const before = await dump();
  for (const as of [SUPPORT, OWNER]) {
    for (const body of [
      { getDocument: "doc_home", saveDraft: { id: "doc_home", body: made.home.body }, revision: made.home.revision },
      { listHistory: "doc_home", archive: made.post.id, revision: 1 },
      { saveDraft: { id: "doc_home", body: made.home.body }, block: "hero", value: {}, revision: 1 },
    ]) {
      const r = await api(body, { as });
      eq(r.status, 400, `mixed ${Object.keys(body).join("+")}:`);
      ok(["AMBIGUOUS_OPERATION", "UNKNOWN_OPERATION"].includes(r.body.code), `code ${r.body.code}:`);
    }
  }
  for (const [body, code] of [[{}, "NO_OPERATION"], [null, "NO_OPERATION"], [{ revision: 2 }, "NO_OPERATION"], [{ saveDraft: { id: "doc_home" } }, "MALFORMED"], [{ saveDraft: { id: "doc_home", body: [] } }, "MALFORMED"], [{ archive: "doc_x", revision: "2" }, "MALFORMED"], [{ unpublish: "doc_home" }, "MALFORMED"], [{ schedule: "doc_home" }, "UNKNOWN_OPERATION"], [{ publish: "doc_home" }, "MALFORMED"]]) {
    // P3-COMMIT parses unpublish (a bare id is malformed); schedules are still unknown
    eq(parseDocumentsOperation(body).code, code, `${JSON.stringify(body)}:`);
    eq((await api(body)).status, 400, `${JSON.stringify(body)} answers 400:`);
  }
  await unchanged(before, "mixed payloads");
});

await t("API: a legacy-mode tenant gets 409 STORE_USES_LEGACY on writes (also with no revision) and 200 on reads", async () => {
  const before = await dump("legacy");
  for (const body of [...WRITE_BODIES(), { archive: "doc_home" }]) {
    const r = await api(body, { store: "legacy" });
    eq([r.status, r.body.code], [409, "STORE_USES_LEGACY"], `${Object.keys(body)[0]}:`);
    ok(r.body.error && !/STORE_USES|legacy mode|cms_state/i.test(r.body.error), `plain words: ${r.body.error}`);
  }
  await unchanged(before, "legacy writes", "legacy");
  const list = await api({ listDocuments: true }, { store: "legacy" });
  eq([list.status, list.body.documents], [200, []], "list:");
  eq((await api({ getDocument: "doc_home" }, { store: "legacy" })).status, 404, "a document that isn't there:");
  eq((await api({ listHistory: "doc_home" }, { store: "legacy" })).status, 404, "history of one that isn't there:");
  // migrating is not documents
  await raw.legacy.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  eq((await api({ createDocument: { type: "home" } }, { store: "legacy" })).body.code, "STORE_USES_LEGACY", "migrating:");
  await raw.legacy.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
});

await t("API: a cms_state that can't be read is a 5xx on writes, never a go-ahead", async () => {
  await raw.legacy.executeMultiple("ALTER TABLE cms_state RENAME TO cms_state_data; CREATE VIEW cms_state AS SELECT * FROM cms_state_gone;");
  try {
    const r = await api({ createDocument: { type: "home" } }, { store: "legacy" });
    ok(r.status >= 500, `status ${r.status}:`);
    ok(!("issues" in r.body), "never a validation list:");
    eq((await sql("SELECT count(*) AS n FROM documents", [], "legacy"))[0].n, 0, "nothing written:");
  } finally {
    await raw.legacy.executeMultiple("DROP VIEW cms_state; ALTER TABLE cms_state_data RENAME TO cms_state;");
  }
});

await t("no issue text reaching the API matches /Section \\d+ \\(/ (as sent, and as the editor words it)", async () => {
  // a body with several problems at once, so there is plenty to read
  const r = await save("doc_home", made.home.revision, { ...made.home.body, sections: [R.newSection("banner", { id: "sec_bn9" }), R.newSection("hero", { id: "sec_h2" }), R.newSection("hero", { id: "sec_h3" }), { id: "sec_x9", kind: "carousel", v: 1 }] });
  eq(r.status, 422, "a body with structure problems:");
  ok(r.body.issues.length >= 4, `every issue, not the first: ${JSON.stringify(r.body.issues.map((i) => i.code))}`);
  ok(SEEN_ISSUES.length >= 8 && ["incomplete", "error"].every((s) => SEEN_ISSUES.some((i) => i.severity === s)), `issues seen: ${SEEN_ISSUES.length}`);
  for (const i of SEEN_ISSUES) {
    ok(!/Section \d+ \(/.test(i.message), `message: ${i.message}`);
    ok(!/Section \d+ \(/.test(issueText(i)), `worded: ${issueText(i)}`);
  }
});

// --- P2-DOCFIX: review findings on P2-DOCS ---------------------------------------------------
console.log("— review fixes (P2-DOCFIX)");

// (2) the prune looks only at this document's rows
await t("the checkpoint prune's query plan uses the indexes: no SCAN of publish_log or documents (publish_log_doc and the documents primary key)", async () => {
  const st = V.pruneStatement("doc_plan");
  // its own connection, closed after: an EXPLAIN of a DELETE can hold the write lock
  const c = createClient({ url: "file:.test-documents-docs.db" });
  let plan;
  try {
    plan = (await c.execute({ sql: `EXPLAIN QUERY PLAN ${st.sql}`, args: st.args })).rows.map((r) => String(r.detail));
  } finally {
    c.close();
  }
  const scans = plan.filter((d) => /^SCAN\b/.test(d));
  eq(scans, [], `no table scans in:\n      ${plan.join("\n      ")}\n     `);
  ok(plan.filter((d) => /^SEARCH p USING INDEX publish_log_doc \(document_id=\?\)/.test(d)).length === 3, `publish_log by document, in all three subqueries: ${plan.join(" | ")}`);
  ok(plan.filter((d) => /^SEARCH d USING (?:INDEX sqlite_autoindex_documents_1|INTEGER PRIMARY KEY|PRIMARY KEY) \(id=\?\)/.test(d)).length === 3, `documents by id, in all three subqueries: ${plan.join(" | ")}`);
});

await t("P3-CHANGES: the prune binds the document id in every check (p.document_id = ?, d.id = ?), never the outer row's, and every argument is that id or the cap", async () => {
  const st = V.pruneStatement("doc_bound");
  ok(!/p\.document_id = v\.document_id|d\.id = v\.document_id/.test(st.sql), `no correlated document term: ${st.sql}`);
  eq((st.sql.match(/p\.document_id = \?/g) || []).length, 3, "publish_log by the bound id, three times:");
  eq((st.sql.match(/d\.id = \?/g) || []).length, 3, "documents by the bound id, three times:");
  eq((st.sql.match(/\?/g) || []).length, st.args.length, "one argument per placeholder:");
  eq(st.args, ["doc_bound", "doc_bound", "doc_bound", "doc_bound", "doc_bound", "doc_bound", V.CHECKPOINT_CAP, "doc_bound", "doc_bound", "doc_bound"], "args:");
});

await t("pruning still never removes a checkpoint a document row points at (published or undone), nor one another document's log row would name only by version id", async () => {
  V.setCheckpointInterval(0);
  try {
    let d = (await create({ type: "page", meta: { slug: "pointed-at", title: "Pointed at" } })).body.document;
    for (let i = 0; i < 3; i++) d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_pa1", `Early ${i}`)] })).body.document;
    const [a, b] = (await sql("SELECT id FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' ORDER BY created_at, rowid LIMIT 2", [d.id])).map((r) => r.id);
    // stand-ins: Undo pointed this document at one checkpoint, publish at another
    await raw.docs.execute({ sql: "UPDATE documents SET undone_version_id = ?, published_version_id = ? WHERE id = ?", args: [a, b, d.id] });
    for (let i = 0; i < 25; i++) d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_pa1", `Later ${i}`)] })).body.document;
    eq((await sql("SELECT id FROM document_versions WHERE id IN (?, ?) ORDER BY id", [a, b])).map((r) => r.id), [a, b].sort(), "both kept:");
    eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'checkpoint'", [d.id]))[0].n, 20, "still capped at 20 in all:");
  } finally {
    V.setCheckpointInterval(null);
  }
});

// (3) archived documents
await t("saving or restoring into an archived document is refused (409 DOCUMENT_ARCHIVED), storage unchanged", async () => {
  let d = (await create({ type: "page", meta: { slug: "archived-one", title: "Archived one" } })).body.document;
  d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_ar1", "Before archive")] })).body.document;
  const vid = (await sql("SELECT id FROM document_versions WHERE document_id = ? ORDER BY created_at, rowid LIMIT 1", [d.id]))[0].id;
  const arch = await api({ archive: d.id, revision: d.revision });
  eq(arch.status, 200, "archived:");
  const rev = arch.body.document.revision;
  const before = await dump();
  const s = await save(d.id, rev, { ...d.body, sections: [textSection("sec_ar1", "After archive")] });
  eq([s.status, s.body.code], [409, "DOCUMENT_ARCHIVED"], "save:");
  const r = await api({ restoreVersion: { id: d.id, versionId: vid }, revision: rev });
  eq([r.status, r.body.code], [409, "DOCUMENT_ARCHIVED"], "restore:");
  await unchanged(before, "writes into an archived document");
});

await t("an archive that lands between the read and the batch still refuses the save and the restore (the batch's own archived_at guard), storage unchanged", async () => {
  for (const op of ["save", "restore"]) {
    let d = (await create({ type: "page", meta: { slug: `archived-race-${op}`, title: "Race" } })).body.document;
    d = (await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_ar2", "First")] })).body.document;
    const vid = (await sql("SELECT id FROM document_versions WHERE document_id = ? ORDER BY created_at, rowid LIMIT 1", [d.id]))[0].id;
    const inst = await inT(() => currentDatabase());
    const send = inst.libsql.batch;
    let snap = null;
    inst.libsql.batch = async (stmts, mode) => {
      delete inst.libsql.batch;
      // archived elsewhere, at the same revision, so only archived_at can stop the write
      await raw.docs.execute({ sql: "UPDATE documents SET archived_at = 'elsewhere' WHERE id = ?", args: [d.id] });
      snap = await dump();
      return send.call(inst.libsql, stmts, mode);
    };
    let r;
    try {
      r = op === "save" ? await save(d.id, d.revision, { ...d.body, sections: [textSection("sec_ar2", "Mine")] }) : await api({ restoreVersion: { id: d.id, versionId: vid }, revision: d.revision });
    } finally {
      delete inst.libsql.batch;
    }
    ok(snap, `${op}: the archive landed between the read and the batch:`);
    eq([r.status, r.body.code], [409, "DOCUMENT_ARCHIVED"], `${op}:`);
    await unchanged(snap, `${op} into a document archived meanwhile`);
  }
});

// (3) team names stay inside the store
await t("teamMemberNames never returns another store's member names; their versions read 'Someone on your team'", async () => {
  const otherU = await I.createUser({ email: "other@zl.test", name: "Other Store Owner", password: "other-pass-docs" });
  await I.addMembership(otherU.id, "zl", "owner");
  const zd = await I.teamMemberNames("zd");
  ok(!zd.has(otherU.id), "the other store's owner is not in this store's names:");
  ok(![...zd.values()].includes("Other Store Owner"), "nor their name:");
  eq((await I.teamMemberNames("zl")).get(otherU.id), "Other Store Owner", "they are in their own store's names:");
  const d = (await create({ type: "page", meta: { slug: "names-two-stores", title: "Two stores" } })).body.document;
  await raw.docs.execute(V.versionStatement(await V.versionRow({ documentId: d.id, kind: "undo_saved", body: { schema: 1 }, schemaVersion: 1, createdBy: `merchant:${otherU.id}`, createdAt: new Date().toISOString(), note: "other-store" })));
  const h = await api({ listHistory: d.id });
  eq(h.body.versions.find((v) => v.note === "other-store")?.by, "Someone on your team", "listed without their name:");
  ok(!JSON.stringify(h.body).includes("Other Store Owner"), "the name never reaches the answer:");
});

// (3) a version belongs to its own document
await t("restoring page A from page B's version id is refused (404), storage unchanged", async () => {
  const a = (await create({ type: "page", meta: { slug: "page-a-own", title: "Page A" } })).body.document;
  const b = (await create({ type: "page", meta: { slug: "page-b-own", title: "Page B" }, body: { ...route("page-b-own", "Page B"), sections: [textSection("sec_pb1", "B's words")] } })).body.document;
  const bVer = (await sql("SELECT id FROM document_versions WHERE document_id = ? LIMIT 1", [b.id]))[0].id;
  eq(await inT(() => V.getVersion(a.id, bVer)), null, "getVersion with another document's version:");
  const before = await dump();
  const r = await api({ restoreVersion: { id: a.id, versionId: bVer }, revision: a.revision });
  eq([r.status, r.body.code], [404, "NOT_FOUND"], `answer ${JSON.stringify(r.body).slice(0, 160)}:`);
  ok(/no longer exists/.test(r.body.error), `plain words: ${r.body.error}`);
  await unchanged(before, "restore from another page's version");
});

// (4) doc_cart: P4-LIVEROW applies the owner ruling's default (plan OQ-6):
// it is an ordinary document, saved with storefront.write
await t("API: doc_cart is created, saved and restored like any document (P4-LIVEROW, the OQ-6 default; it used to answer 409 CART_NOT_AVAILABLE)", async () => {
  const c = await create({ type: "cart" });
  eq(c.status, 200, `create: ${JSON.stringify(c.body).slice(0, 200)}`);
  eq(c.body.document.id, "doc_cart", "id:");
  const cartBody = c.body.document.body;
  const s = await save("doc_cart", 1, { ...cartBody, settings: { ...cartBody.settings, title: "Changed" } });
  eq(s.status, 200, "save:");
  eq((await docRow("doc_cart")).revision, 2, "saved:");
  const cp = (await sql("SELECT id FROM document_versions WHERE document_id = 'doc_cart' AND kind = 'checkpoint' ORDER BY rowid LIMIT 1"))[0].id;
  const r = await api({ restoreVersion: { id: "doc_cart", versionId: cp }, revision: 2 });
  eq(r.status, 200, "restore:");
  eq((await api({ getDocument: "doc_cart" })).status, 200, "read:");
});

// (5) the media usage preview
await t("PUT /api/admin/media (usage preview): a failing document scan answers a 5xx with a code and plain words, not a generic error", async () => {
  const media = await import("../app/api/admin/media/route.js");
  const put = (body) =>
    inT(async () => {
      const res = await media.PUT(req(TEN.docs, OWNER, body));
      return { status: res.status, body: await res.json() };
    });
  const m = await inT(() => M.saveMedia({ filename: "usage.png", mime: "image/png", bytes: PNG(13) }));
  const fine = await put({ id: m.id });
  eq([fine.status, fine.body.ok, fine.body.usage], [200, true, []], "a working scan:");
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.execute;
  inst.libsql.execute = (stmt, ...rest) =>
    /FROM documents WHERE archived_at IS NULL AND \(instr/.test(typeof stmt === "string" ? stmt : stmt?.sql || "")
      ? Promise.reject(Object.assign(new Error("SQLITE_ERROR: disk I/O error"), { name: "LibsqlError", code: "SQLITE_IOERR" }))
      : send.call(inst.libsql, stmt, ...rest);
  let r;
  try {
    r = await put({ id: m.id });
  } finally {
    delete inst.libsql.execute;
  }
  ok(r.status >= 500 && r.status < 600, `status ${r.status}: ${JSON.stringify(r.body)}`);
  ok(/^(DATABASE_[A-Z_]+|INTERNAL_ERROR)$/.test(String(r.body.code || "")), `a code: ${JSON.stringify(r.body)}`);
  eq(r.body.error, "We couldn't reach your store's data just now, so this couldn't load. Try again in a minute.", "plain words:");
  ok(!/SQLITE|disk I\/O/i.test(JSON.stringify(r.body)), "no raw database text:");
  ok(!("usage" in r.body), "no usage list that could read as 'not used':");
});

// --- P5-SETTING: bundle refs (COM-02) --------------------------------------------------------
console.log("— bundle references (P5-SETTING)");
await t("P5-SETTING: a section's bundle and bundle-list settings write document_refs rows ('bundle', <id>); a /bundles/<slug> link still writes ('bundle', <slug>)", async () => {
  // a throwaway kind (P5-BLOCKS declares the real bundle_card and bundle_grid)
  R.defineSection({
    kind: "zz_bundlerefs",
    label: "Bundle refs probe",
    documentTypes: ["home"],
    settings: [
      { key: "bundle", kind: "bundle", label: "Bundle", default: null },
      { key: "bundles", kind: "bundle_list", label: "Bundles to show", default: [] },
    ],
  });
  const Refs = await import("../lib/documents/refs.js");
  const versionId = "ver_p5setting_refs";
  try {
    const body = {
      ...R.emptyBody("home"),
      sections: [
        { ...R.newSection("zz_bundlerefs", { id: "sec_bref1" }), settings: { bundle: { id: "bun-0a1b2c3d" }, bundles: [{ id: "bnd_p1c" }, { id: "bun-ffee01" }, { id: "bun-0a1b2c3d" }] } },
        { ...R.newSection("banner", { id: "sec_bref2" }), settings: { ...R.newSection("banner").settings, title: "Kits", button: { label: "See the kit", link: { type: "url", href: "/bundles/gym-kit?ref=home" } } } },
      ],
    };
    ok(R.validateDocument(body, { mode: "publish" }).ok, "the body publishes:");
    // the rows the publish batch writes for a version (lib/documents/build.js
    // refRows, inserted by commit.js), into this store's real document_refs
    for (const st of Refs.refInsertStatements(Refs.refRows(versionId, body))) await raw.docs.execute(st);
    const rows = await sql("SELECT ref_type, ref_id FROM document_refs WHERE version_id = ? ORDER BY ref_type, ref_id", [versionId]);
    eq(
      rows.filter((r) => r.ref_type === "bundle").map((r) => r.ref_id),
      ["bnd_p1c", "bun-0a1b2c3d", "bun-ffee01", "gym-kit"],
      "bundle rows (ids for the settings, the slug for the link, one row per bundle):",
    );
    // and the index reads them back by target, as the reference reads do
    eq((await sql("SELECT version_id FROM document_refs WHERE ref_type = 'bundle' AND ref_id = ?", ["bun-ffee01"])).map((r) => r.version_id), [versionId], "found by bundle id:");
  } finally {
    R.removeSection("zz_bundlerefs");
    await raw.docs.execute({ sql: "DELETE FROM document_refs WHERE version_id = ?", args: [versionId] });
  }
});

// --- P6-GEN-WRITE (GEN-01): the first-run writer ---------------------------------------------
console.log("— the first-run writer (GEN-01)");
{
  const FR = Docs.FIRST_RUN_ACTOR;
  const MERCHANT = { kind: "merchant", id: ownerU.id };
  const frSql = (q, args = []) => sql(q, args, "fr");
  const frIn = (fn) => inT(fn, "fr");
  const gen = (docs, opts = {}) => frIn(() => Docs.createFirstRunDocuments({ docs, actor: FR, ...opts }));
  const homeOf = (title) => ({ ...R.emptyBody("home"), sections: [textSection("sec_fr_text", title)] });
  const designOf = (accent) => ({ ...R.emptyBody("design"), settings: { brand: { accent }, theme: { kit: "pulse", version: 1 } } });
  const both = (h, d) => [
    { type: "home", id: "doc_home", body: h },
    { type: "design", id: "doc_design", body: d },
  ];
  const reset = async () => {
    for (const q of ["DELETE FROM document_refs", "DELETE FROM document_versions", "DELETE FROM documents", "UPDATE release_state SET live_release_id = NULL WHERE id = 1", "UPDATE cms_state SET mode = 'documents' WHERE id = 1"]) await raw.fr.execute(q);
  };
  const rowOf = async (id) => (await frSql("SELECT * FROM documents WHERE id = ?", [id]))[0] ?? null;
  const versionCount = async (id) => Number((await frSql("SELECT count(*) AS n FROM document_versions WHERE document_id = ?", [id]))[0].n);
  const refusal = async (p) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a refusal");
  };
  // counts the batches the writer sends, and lets a test act just before one
  const spyBatches = async (before = null) => {
    const inst = await frIn(() => currentDatabase());
    const send = inst.libsql.batch;
    const seen = [];
    inst.libsql.batch = async (stmts, mode) => {
      seen.push(stmts.length);
      if (before) await before();
      return send.call(inst.libsql, stmts, mode);
    };
    return { seen, restore: () => delete inst.libsql.batch };
  };

  await t("on a fresh documents store it creates doc_home and doc_design in ONE batch, with 'Created' version rows by system:first-run (shown as Storeasy)", async () => {
    await reset();
    const spy = await spyBatches();
    let r;
    try {
      r = await gen(both(homeOf("Welcome"), designOf("#334155")));
    } finally {
      spy.restore();
    }
    eq(r, { written: true, created: ["doc_home", "doc_design"], refilled: [], unchanged: [], skipped: [] }, "the answer:");
    eq(spy.seen.length, 1, "batches sent:");
    for (const id of ["doc_home", "doc_design"]) {
      const row = await rowOf(id);
      eq([row.revision, row.updated_by, row.published_version_id, row.archived_at], [1, "system:first-run", null, null], `${id} row:`);
      const vs = await frSql("SELECT kind, note, created_by FROM document_versions WHERE document_id = ?", [id]);
      eq(vs.map((v) => ({ ...v })), [{ kind: "checkpoint", note: "Created", created_by: "system:first-run" }], `${id} versions:`);
      const hist = await frIn(() => Docs.listHistory(id, { tenant: "zf" }));
      eq(hist.map((h) => h.by), ["Storeasy"], `${id} history names it:`);
    }
    eq(V.plainName(Docs.FIRST_RUN_BY, new Map()), "Storeasy", "plainName:");
    eq(Docs.actorString(FR), Docs.FIRST_RUN_BY, "the actor's string:");
    eq(JSON.parse((await rowOf("doc_home")).draft).sections[0].settings.title, "Welcome", "the stored home:");
  });

  await t("a second call with different bodies refills both (revision + 1, a new version row each); a third with the same bodies is unchanged: no revision bump, no new version row", async () => {
    await reset();
    await gen(both(homeOf("Welcome"), designOf("#334155")));
    const r2 = await gen(both(homeOf("Welcome back"), designOf("#14532d")));
    eq(r2, { written: true, created: [], refilled: ["doc_home", "doc_design"], unchanged: [], skipped: [] }, "second answer:");
    for (const id of ["doc_home", "doc_design"]) {
      eq([(await rowOf(id)).revision, await versionCount(id)], [2, 2], `${id} after the refill:`);
    }
    eq(JSON.parse((await rowOf("doc_design")).draft).settings.brand.accent, "#14532d", "the refilled design:");
    const before = await dump("fr");
    const spy = await spyBatches();
    let r3;
    try {
      r3 = await gen(both(homeOf("Welcome back"), designOf("#14532d")));
    } finally {
      spy.restore();
    }
    eq(r3, { written: false, created: [], refilled: [], unchanged: ["doc_home", "doc_design"], skipped: [] }, "third answer:");
    eq(spy.seen.length, 0, "no batch for an unchanged refill:");
    await unchanged(before, "an unchanged refill", "fr");
  });

  await t("refills prune old version rows the way saveDraft does (at most the checkpoint cap are kept)", async () => {
    await reset();
    await gen(both(homeOf("Title 0"), designOf("#334155")));
    for (let i = 1; i <= V.CHECKPOINT_CAP + 3; i++) await gen([{ type: "home", id: "doc_home", body: homeOf(`Title ${i}`) }]);
    eq((await rowOf("doc_home")).revision, V.CHECKPOINT_CAP + 4, "every refill bumped the revision:");
    eq(await versionCount("doc_home"), V.CHECKPOINT_CAP, "versions kept:");
    // the newest is kept, the oldest went
    const notes = await frSql("SELECT note FROM document_versions WHERE document_id = 'doc_home' AND note = 'Created'");
    eq(notes.length, 0, "the oldest checkpoint was pruned:");
  });

  await t("a founder-saved doc_home is skipped with reason 'founder': its revision, body and versions don't change, and the design is still written", async () => {
    await reset();
    await gen(both(homeOf("Welcome"), designOf("#334155")));
    const h = await frIn(() => Docs.getDocument("doc_home"));
    await frIn(() => Docs.saveDraft({ id: "doc_home", revision: h.revision, body: homeOf("My own words"), actor: MERCHANT }));
    const before = await rowOf("doc_home");
    const nBefore = await versionCount("doc_home");
    const r = await gen(both(homeOf("Generated again"), designOf("#14532d")));
    eq(r, { written: true, created: [], refilled: ["doc_design"], unchanged: [], skipped: [{ id: "doc_home", reason: "founder" }] }, "the answer:");
    eq({ ...(await rowOf("doc_home")) }, { ...before }, "doc_home row:");
    eq(await versionCount("doc_home"), nBefore, "doc_home versions:");
  });

  await t("an empty doc_home made by createDocument under a merchant (revision 1, emptyBody) is refilled; with a section added it is skipped; with allowEmptyRefill:false the empty one is skipped too", async () => {
    await reset();
    await frIn(() => Docs.createDocument({ type: "home", body: R.emptyBody("home"), actor: MERCHANT }));
    eq([(await rowOf("doc_home")).revision, (await rowOf("doc_home")).updated_by], [1, `merchant:${ownerU.id}`], "the founder's empty home:");
    // allowEmptyRefill: false (the sync trigger) leaves it alone
    const before = await dump("fr");
    const off = await gen([{ type: "home", id: "doc_home", body: homeOf("Welcome") }], { allowEmptyRefill: false });
    eq(off, { written: false, created: [], refilled: [], unchanged: [], skipped: [{ id: "doc_home", reason: "founder" }] }, "allowEmptyRefill false:");
    await unchanged(before, "allowEmptyRefill false", "fr");
    const on = await gen([{ type: "home", id: "doc_home", body: homeOf("Welcome") }]);
    eq(on.refilled, ["doc_home"], "refilled:");
    eq([(await rowOf("doc_home")).revision, (await rowOf("doc_home")).updated_by], [2, "system:first-run"], "after the refill:");
    // the same empty home with one section added: the founder's
    await reset();
    await frIn(() => Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [R.newSection("text")] }, actor: MERCHANT }));
    const before2 = await dump("fr");
    const r = await gen([{ type: "home", id: "doc_home", body: homeOf("Welcome") }]);
    eq(r.skipped, [{ id: "doc_home", reason: "founder" }], "one section added:");
    await unchanged(before2, "a home with a section", "fr");
    // emptyBody's hash, not a deep-equal: two empty bodies with different
    // random section ids would hash alike (ids stripped)
    const a = await R.documentHash(R.ensureIds({ ...R.emptyBody("home"), sections: [R.newSection("text")] }));
    const b = await R.documentHash(R.ensureIds({ ...R.emptyBody("home"), sections: [R.newSection("text")] }));
    eq(a, b, "ids don't change a hash:");
  });

  await t("a published document is skipped ('published') and an archived row ('archived', set by hand: singletons can't be archived); nothing of a skipped document changes, no version row", async () => {
    await reset();
    await gen(both(homeOf("Welcome"), designOf("#334155")));
    const v = (await frSql("SELECT id FROM document_versions WHERE document_id = 'doc_home'"))[0].id;
    await raw.fr.execute({ sql: "UPDATE documents SET published_version_id = ?, published_hash = draft_hash WHERE id = 'doc_home'", args: [v] });
    await raw.fr.execute("UPDATE documents SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = 'doc_design'");
    const before = await dump("fr");
    const r = await gen(both(homeOf("Again"), designOf("#14532d")));
    eq(r, { written: false, created: [], refilled: [], unchanged: [], skipped: [{ id: "doc_home", reason: "published" }, { id: "doc_design", reason: "archived" }] }, "the answer:");
    await unchanged(before, "skipped documents", "fr");
  });

  await t("a live store gets 409 FIRST_RUN_STORE_LIVE, nothing written; also after a take-offline set published_version_id back to NULL (the guard, not the column)", async () => {
    await reset();
    await raw.fr.execute("UPDATE release_state SET live_release_id = 'rel_fr_live' WHERE id = 1");
    let before = await dump("fr");
    let e = await refusal(gen(both(homeOf("Welcome"), designOf("#334155"))));
    eq([e.status, e.code], [409, "FIRST_RUN_STORE_LIVE"], "on a fresh live store:");
    ok(!/[A-Z]{2,}_[A-Z_]+/.test(e.message) && /already open/.test(e.message), `plain words: ${e.message}`);
    await unchanged(before, "a live store", "fr");
    // generator-owned, unpublished drafts on a live store (a take-offline
    // cleared published_version_id): still refused
    await reset();
    await gen(both(homeOf("Welcome"), designOf("#334155")));
    await raw.fr.execute("UPDATE release_state SET live_release_id = 'rel_fr_live' WHERE id = 1");
    before = await dump("fr");
    e = await refusal(gen(both(homeOf("Again"), designOf("#14532d"))));
    eq([e.status, e.code], [409, "FIRST_RUN_STORE_LIVE"], "a refill on a live store:");
    await unchanged(before, "a refill on a live store", "fr");
  });

  await t("a legacy store gets 409 STORE_USES_LEGACY and a migrating store 409 STORE_MIGRATING, nothing written", async () => {
    for (const [mode, code, words] of [["legacy", "STORE_USES_LEGACY", /current Storefront editor/], ["migrating", "STORE_MIGRATING", /being updated/]]) {
      await reset();
      await raw.fr.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] });
      const before = await dump("fr");
      const e = await refusal(gen(both(homeOf("Welcome"), designOf("#334155"))));
      eq([e.status, e.code], [409, code], `${mode}:`);
      ok(words.test(e.message), `${mode} words: ${e.message}`);
      await unchanged(before, mode, "fr");
    }
    await reset();
  });

  await t("a revision race (a founder save between classify and batch) aborts the whole batch: neither document changes, 409 FIRST_RUN_RACE", async () => {
    await reset();
    await gen(both(homeOf("Welcome"), designOf("#334155")));
    let snap = null;
    Docs.firstRunHooks.beforeBatch = async ({ plan }) => {
      Docs.firstRunHooks.beforeBatch = null;
      eq(plan, [{ id: "doc_home", kind: "refill", rule: "owned" }, { id: "doc_design", kind: "refill", rule: "owned" }], "the plan:");
      const h = await frIn(() => Docs.getDocument("doc_home"));
      await frIn(() => Docs.saveDraft({ id: "doc_home", revision: h.revision, body: homeOf("The founder's words"), actor: MERCHANT }));
      snap = await dump("fr");
    };
    let e;
    try {
      e = await refusal(gen(both(homeOf("Generated again"), designOf("#14532d"))));
    } finally {
      Docs.firstRunHooks.beforeBatch = null;
    }
    eq([e.status, e.code], [409, "FIRST_RUN_RACE"], "the refusal:");
    await unchanged(snap, "a lost race", "fr");
    eq(JSON.parse((await rowOf("doc_design")).draft).settings.brand.accent, "#334155", "the design kept its draft:");
  });

  await t("the SQL repeats each classified predicate: another writer at the same revision, an edited revision-1 empty home, or a home made meanwhile all abort the batch (FIRST_RUN_RACE)", async () => {
    const raceWith = async (sqlText, args = []) => {
      let snap = null;
      Docs.firstRunHooks.beforeBatch = async () => {
        Docs.firstRunHooks.beforeBatch = null;
        await raw.fr.execute({ sql: sqlText, args });
        snap = await dump("fr");
      };
      try {
        const e = await refusal(gen(both(homeOf("Generated"), designOf("#14532d"))));
        eq([e.status, e.code], [409, "FIRST_RUN_RACE"], `${sqlText.slice(0, 40)}:`);
      } finally {
        Docs.firstRunHooks.beforeBatch = null;
      }
      await unchanged(snap, sqlText.slice(0, 40), "fr");
    };
    // generator-owned at classify; then another writer, same revision
    await reset();
    await gen(both(homeOf("Welcome"), designOf("#334155")));
    await raceWith("UPDATE documents SET updated_by = ? WHERE id = 'doc_home'", [`merchant:${ownerU.id}`]);
    // untouched empty at classify; then the founder's words land at revision 1
    await reset();
    await frIn(() => Docs.createDocument({ type: "home", body: R.emptyBody("home"), actor: MERCHANT }));
    const edited = await R.documentHash(homeOf("The founder's words"));
    await raceWith("UPDATE documents SET draft = ?, draft_hash = ? WHERE id = 'doc_home'", [JSON.stringify(homeOf("The founder's words")), edited]);
    // and the real thing: a founder save on the empty home (revision 2)
    await reset();
    await frIn(() => Docs.createDocument({ type: "home", body: R.emptyBody("home"), actor: MERCHANT }));
    let snap = null;
    Docs.firstRunHooks.beforeBatch = async ({ plan }) => {
      Docs.firstRunHooks.beforeBatch = null;
      eq(plan[0], { id: "doc_home", kind: "refill", rule: "empty" }, "classified empty:");
      await frIn(() => Docs.saveDraft({ id: "doc_home", revision: 1, body: homeOf("Mine"), actor: MERCHANT }));
      snap = await dump("fr");
    };
    try {
      const e = await refusal(gen(both(homeOf("Generated"), designOf("#14532d"))));
      eq(e.code, "FIRST_RUN_RACE", "a founder save on the empty home:");
    } finally {
      Docs.firstRunHooks.beforeBatch = null;
    }
    await unchanged(snap, "the empty-hash race", "fr");
    // absent at classify; the founder's editor makes the home meanwhile
    await reset();
    snap = null;
    Docs.firstRunHooks.beforeBatch = async () => {
      Docs.firstRunHooks.beforeBatch = null;
      await frIn(() => Docs.createDocument({ type: "home", body: homeOf("Mine"), actor: MERCHANT }));
      snap = await dump("fr");
    };
    try {
      const e = await refusal(gen(both(homeOf("Generated"), designOf("#14532d"))));
      eq(e.code, "FIRST_RUN_RACE", "a home made meanwhile:");
    } finally {
      Docs.firstRunHooks.beforeBatch = null;
    }
    await unchanged(snap, "an insert race", "fr");
    eq(await rowOf("doc_design"), null, "no design either:");
  });

  await t("a lost answer (the batch committed, then the call threw) is our own write: success, not a race", async () => {
    await reset();
    const inst = await frIn(() => currentDatabase());
    const send = inst.libsql.batch;
    inst.libsql.batch = async (stmts, mode) => {
      delete inst.libsql.batch;
      await send.call(inst.libsql, stmts, mode);
      throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    };
    let r;
    try {
      r = await gen(both(homeOf("Welcome"), designOf("#334155")));
    } finally {
      delete inst.libsql.batch;
    }
    eq(r.created, ["doc_home", "doc_design"], "success:");
    eq(await versionCount("doc_home"), 1, "one version:");
  });

  await t("any other actor is refused with 400 FIRST_RUN_ACTOR in plain words, nothing written; a body that doesn't validate refuses the whole call (422)", async () => {
    await reset();
    const before = await dump("fr");
    for (const actor of [MERCHANT, null, "system:first-run", { kind: "system", id: "policy-starter" }, { kind: "system" }]) {
      const e = await refusal(frIn(() => Docs.createFirstRunDocuments({ docs: both(homeOf("x"), designOf("#334155")), actor })));
      eq([e.status, e.code], [400, "FIRST_RUN_ACTOR"], `${JSON.stringify(actor)}:`);
      ok(!/[A-Z]{2,}_[A-Z_]+|first-run|system/.test(e.message), `plain words: ${e.message}`);
    }
    const bad = await refusal(gen(both(homeOf("Fine"), { ...R.emptyBody("design"), settings: { brand: { colors: {} }, theme: null } })));
    eq([bad.status, bad.code], [422, "VALIDATION_FAILED"], "a bad design:");
    await unchanged(before, "refusals", "fr");
  });

  // P6-GEN (from the P6-GEN-WRITE review, mutations M1/M1b): the version a
  // create or a refill writes indexes the library files its body uses, so a
  // founder can't delete an image the generated home shows.
  await t("document_refs: the version a create writes, and the version a refill writes, both index the /api/media/<id> files of the body", async () => {
    await reset();
    const heroWith = (media) => ({
      ...R.emptyBody("home"),
      sections: [{ id: "sec_fr_hero", kind: "hero", v: 1, enabled: true, settings: { title: "Welcome", image: { media, alt: "A jar" } }, blocks: [] }],
    });
    const refsOf = async (id) =>
      (await frSql("SELECT r.ref_type AS t, r.ref_id AS id, v.note AS note FROM document_refs r JOIN document_versions v ON v.id = r.version_id WHERE v.document_id = ? ORDER BY v.created_at, r.ref_id", [id])).map((r) => ({ ...r }));
    const c = await gen([{ type: "home", id: "doc_home", body: heroWith("/api/media/med_aaaa1111") }]);
    eq(c.created, ["doc_home"], "created:");
    const afterCreate = await refsOf("doc_home");
    ok(afterCreate.some((r) => r.id === "med_aaaa1111" && r.note === "Created"), `the create's version holds the file: ${JSON.stringify(afterCreate)}`);
    const r = await gen([{ type: "home", id: "doc_home", body: heroWith("/api/media/med_bbbb2222") }]);
    eq(r.refilled, ["doc_home"], "refilled:");
    const afterRefill = await refsOf("doc_home");
    ok(afterRefill.some((x) => x.id === "med_bbbb2222" && x.note !== "Created"), `the refill's version holds the new file: ${JSON.stringify(afterRefill)}`);
    const types = [...new Set(afterRefill.map((x) => x.t))];
    eq(types.length, 1, `one ref type for the files: ${JSON.stringify(types)}`);
  });

  // P6-GEN (from the P6-GEN-WRITE review, mutation M6): the empty-refill rule
  // needs revision 1. A founder who edited the home and later took it back to
  // the empty body has worked on it: skipped as 'founder', never refilled.
  await t("a founder-edited doc_home taken back to the empty body (revision above 1) is skipped as 'founder', even with allowEmptyRefill", async () => {
    await reset();
    await frIn(() => Docs.createDocument({ type: "home", body: R.emptyBody("home"), actor: MERCHANT }));
    await frIn(() => Docs.saveDraft({ id: "doc_home", revision: 1, body: homeOf("My words"), actor: MERCHANT }));
    await frIn(() => Docs.saveDraft({ id: "doc_home", revision: 2, body: R.emptyBody("home"), actor: MERCHANT }));
    const row = await rowOf("doc_home");
    eq(row.revision, 3, "the founder's revision:");
    const empty = await frIn(async () => (await Docs.getDocument("doc_home")).draftHash);
    ok(typeof empty === "string" && empty === row.draft_hash, "stored hash read:");
    const before = await dump("fr");
    const r = await gen([{ type: "home", id: "doc_home", body: homeOf("Generated") }], { allowEmptyRefill: true });
    eq(r, { written: false, created: [], refilled: [], unchanged: [], skipped: [{ id: "doc_home", reason: "founder" }] }, "the answer:");
    await unchanged(before, "a reverted founder home", "fr");
  });

  // --- the shared policy rule (lib/documents/policy-pages.js) ---------------------------------
  const P = await import("../lib/documents/policy-pages.js");
  await t("policy-pages: the slug rule is today's (privacy; terms|refund|return), privacy wins, and the starter actor is system:policy-starter", async () => {
    for (const s of ["terms", "refund-policy", "returns"]) eq(P.isReturnsSlug(s), true, `${s}:`);
    eq([P.isReturnsSlug("about"), P.isPrivacySlug("about"), P.kindOfSlug("about")], [false, false, null], "about:");
    eq(P.kindOfSlug("privacy-terms"), "privacy", "privacy-terms:");
    eq([P.kindOfSlug("privacy-policy"), P.kindOfSlug("terms")], ["privacy", "returns"], "kinds:");
    eq(P.POLICY_KINDS, ["privacy", "returns"], "POLICY_KINDS:");
    eq(Docs.actorString(P.POLICY_STARTER_ACTOR), P.POLICY_STARTER_BY, "POLICY_STARTER_BY:");
    eq(P.POLICY_STARTER_BY, "system:policy-starter", "the mark:");
    ok(Object.isFrozen(P.POLICY_STARTER_ACTOR), "frozen:");
    // the same rule onboarding uses today
    const onboarding = await readFile(join(ROOT, "lib/admin/onboarding.js"), "utf8");
    ok(onboarding.includes("/privacy/") && onboarding.includes("/terms|refund|return/"), "today's rule is still the same:");
  });

  await t("policyStatus (pure): best state per kind, live > inSet > saved > starter > missing, ties to the newest; archived, slugless and non-page rows are ignored", async () => {
    const row = (id, slug, extra = {}) => ({ id, type: "page", slug, label: id, revision: 1, draftHash: "h", publishedVersionId: null, archivedAt: null, updatedBy: `merchant:${ownerU.id}`, updatedAt: "2026-01-01T00:00:00.000Z", ...extra });
    eq(P.policyStatus([]), { privacy: { state: "missing", doc: null }, returns: { state: "missing", doc: null } }, "nothing:");
    const s1 = P.policyStatus([row("a", "privacy", { updatedBy: P.POLICY_STARTER_BY }), row("b", "privacy-policy", { publishedVersionId: "ver_1" }), row("c", "terms", { updatedBy: P.POLICY_STARTER_BY })]);
    eq([s1.privacy.state, s1.privacy.doc.id, s1.returns.state, s1.returns.doc.id], ["live", "b", "starter", "c"], "live wins:");
    eq(P.policyStatus([row("c", "terms", { updatedBy: P.POLICY_STARTER_BY })], ["c"]).returns.state, "inSet", "a starter in the set:");
    eq(P.policyStatus([row("c", "terms", { updatedBy: "system:cutover" })]).returns.state, "saved", "the cutover's text:");
    const tie = P.policyStatus([row("old", "terms", { updatedAt: "2026-01-01T00:00:00.000Z" }), row("new", "refund", { updatedAt: "2026-02-01T00:00:00.000Z" })]);
    eq(tie.returns.doc.id, "new", "ties go to the newest:");
    const ignored = P.policyStatus([row("x", "privacy", { archivedAt: "2026-01-01" }), row("y", null), row("z", "privacy", { type: "campaign" }), row("w", "")]);
    eq([ignored.privacy.state, ignored.returns.state], ["missing", "missing"], "ignored rows:");
    eq(P.COUNTING_STATES, ["live", "inSet", "saved"], "the review rule:");
    eq(["live", "inSet", "saved", "starter", "missing"].map(P.policyCounts), [true, true, true, false, false], "what counts:");
  });

  await t("policyStatus on real rows (readPolicyRows): a starter draft is 'starter' ('inSet' in the set), 'saved' after a merchant saveDraft, 'live' once published; a cutover draft is 'saved'; archived and slugless pages are ignored", async () => {
    await reset();
    const page = (slug, title = "Policy") => ({ ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug, title } });
    const starter = (await frIn(() => Docs.createDocument({ type: "page", body: page("privacy-policy", "Privacy policy"), actor: P.POLICY_STARTER_ACTOR }))).document;
    let rows = await frIn(() => P.readPolicyRows());
    eq(rows.map((r) => [r.id, r.slug, r.updatedBy]), [[starter.id, "privacy-policy", "system:policy-starter"]], "readPolicyRows carries updatedBy:");
    eq(Object.keys(rows[0]).sort(), ["archivedAt", "draftHash", "id", "label", "publishedVersionId", "revision", "slug", "type", "updatedAt", "updatedBy"], "the row shape:");
    eq(P.policyStatus(rows).privacy.state, "starter", "a starter draft:");
    eq(P.policyStatus(rows, [starter.id]).privacy.state, "inSet", "the starter in the set:");
    await frIn(() => Docs.saveDraft({ id: starter.id, revision: 1, body: starter.body, actor: MERCHANT }));
    rows = await frIn(() => P.readPolicyRows());
    eq([P.policyStatus(rows).privacy.state, rows[0].updatedBy], ["saved", `merchant:${ownerU.id}`], "after a merchant save:");
    const v = (await frSql("SELECT id FROM document_versions WHERE document_id = ?", [starter.id]))[0].id;
    await raw.fr.execute({ sql: "UPDATE documents SET published_version_id = ? WHERE id = ?", args: [v, starter.id] });
    eq(P.policyStatus(await frIn(() => P.readPolicyRows())).privacy.state, "live", "published:");
    // the cutover's own text
    const cut = (await frIn(() => Docs.createDocument({ type: "page", body: page("refund-policy"), actor: { kind: "system", id: "cutover" } }))).document;
    eq(P.policyStatus(await frIn(() => P.readPolicyRows())).returns, { state: "saved", doc: (await frIn(() => P.readPolicyRows())).find((r) => r.id === cut.id) }, "a cutover draft:");
    // archived, and no slug: not counted
    await reset();
    const arch = (await frIn(() => Docs.createDocument({ type: "page", body: page("returns"), actor: MERCHANT }))).document;
    await frIn(() => Docs.archive({ id: arch.id, revision: 1, actor: MERCHANT }));
    await frIn(() => Docs.createDocument({ type: "page", body: page(""), actor: MERCHANT }));
    rows = await frIn(() => P.readPolicyRows());
    eq(rows, [], "readPolicyRows leaves them out:");
    eq(P.policyStatus(rows).returns.state, "missing", "archived page:");
    // and the pure rule ignores them even when handed them
    const all = (await frSql("SELECT id, type, slug, archived_at, updated_by FROM documents")).map((d) => ({ id: d.id, type: d.type, slug: d.slug, archivedAt: d.archived_at, updatedBy: d.updated_by, publishedVersionId: null }));
    eq(all.length, 2, "both rows exist:");
    eq([P.policyStatus(all).privacy.state, P.policyStatus(all).returns.state], ["missing", "missing"], "the pure rule ignores them:");
    await reset();
  });
}

// --- the write guard -----------------------------------------------------------------------
console.log("— one writer");
const WRITE_RE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`]?(documents|document_versions|publish_log)\b|\b(?:insertInto|updateTable|deleteFrom|replaceInto)\(\s*["'`](documents|document_versions|publish_log)["'`]/i;
export function writesOutsideService(files) {
  return files.filter(({ path, text }) => !path.startsWith("lib/documents/") && WRITE_RE.test(text)).map((f) => f.path);
}
await t("a scan finds no INSERT, UPDATE or DELETE on documents, document_versions or publish_log outside lib/documents/ (test files allowlisted)", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!["node_modules", ".next"].includes(e.name)) await walk(p);
      } else if (/\.(m?js|jsx|ts|tsx|sql)$/.test(e.name)) files.push({ path: p, text: await readFile(join(ROOT, p), "utf8") });
    }
  };
  for (const d of ["lib", "app", "components", "scripts", "migrations"]) await walk(d);
  ok(files.length > 100, `files scanned: ${files.length}`);
  ok(files.some((f) => f.path === "lib/documents/service.js"), "the service is in the scan:");
  // P4-FIXTURES: the legacy tenant builders write leftover document rows on
  // purpose (re-run fixtures for CUTOVER and REVERSE), on local file databases
  // only; that one support file is test code like the suites
  // P4-CUTOVER: the cutover writes the backfill and the flip itself, under
  // the migrating guard (lib/migrate/backfill.js and flip.js only)
  const allowed = (p) => /^scripts\/test-[\w.-]+\.js$/.test(p) || p === "scripts/support/legacy-tenants.js" || p === "lib/migrate/backfill.js" || p === "lib/migrate/flip.js";
  const found = writesOutsideService(files).filter((p) => !allowed(p));
  eq(found, [], "writers outside lib/documents/:");
  // the scan itself bites: each of these shapes is caught
  for (const text of ['await db.execute("UPDATE documents SET draft = 1")', "INSERT INTO document_versions (id) VALUES (1)", 'db.deleteFrom("publish_log")', "await db.updateTable('documents')", "INSERT OR REPLACE INTO documents VALUES (1)"]) {
    eq(writesOutsideService([{ path: "lib/cms/x.js", text }]), ["lib/cms/x.js"], `caught: ${text}`);
  }
  eq(writesOutsideService([{ path: "lib/cms/x.js", text: 'SELECT * FROM documents; db.selectFrom("documents")' }]), [], "reads are fine:");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
for (const c of Object.values(raw)) c.close();
await cleanup();
process.exit(fail ? 1 : 0);
