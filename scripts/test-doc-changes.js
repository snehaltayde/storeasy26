// P3-CHANGES (PUB-09, ED-03): the change list and the two ways to act on it,
// run for real through the documents console API (lib/admin/documents-api.js):
// real requireAdmin and sessions, real tenant databases with every migration,
// the real publish, storage re-read after each refusal.
//   listChanges          lib/documents/changes.js over lib/documents/diff.js
//   keepLiveSection      changes.js keepLiveBody + service.rewriteDraft
//   keepAsEarlierDraft   service.keepEarlierDraft
// Every answer is compared with lib/admin/documents-api-shapes.js, key by key.
//   pnpm test:doc-changes
import { readFile, rm } from "node:fs/promises";
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
process.env.DATABASE_URL = "file:.test-doc-changes-default.db";
process.env.PLATFORM_DB_URL = "file:.test-doc-changes-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-doc-changes-default.db", ".test-doc-changes-platform.db", ".test-doc-changes-docs.db", ".test-doc-changes-legacy.db"];
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
const V = await import("../lib/documents/versions.js");
const Ch = await import("../lib/documents/changes.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const R = await import("../lib/registry/index.js");
const { SHAPES, COMMON } = await import("../lib/admin/documents-api-shapes.js");

let pass = 0;
let fail = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function t(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 4).join("\n   ") || e.message}`);
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

// The same keys as a shapes example, all the way down (the first element of a
// list), leaving out the optional paths. A document's body is the founder's
// content, not part of the contract. (As scripts/test-publish-service.js.)
const FREE = new Set(["document.body", "current.body"]);
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
const SEEN_SHAPES = new Set();
const likeShape = (r, op, name, label = `${op}.${name}`) => {
  const o = SHAPES[op].outcomes[name];
  ok(o, `${op}.${name} is in the shapes`);
  eq(r.status, o.status, `${label} status (${JSON.stringify(r.body).slice(0, 300)}):`);
  sameKeys(r.body, o.body, o.optional || []);
  if (o.body.code) eq(r.body.code, o.body.code, `${label} code:`);
  SEEN_SHAPES.add(`${op}.${name}`);
};

// --- fixtures ----------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
const raw = {};
for (const [key, file] of [["docs", ".test-doc-changes-docs.db"], ["legacy", ".test-doc-changes-legacy.db"]]) {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(schema);
  await runMigrations(c, migrations);
  raw[key] = c;
}
await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw.legacy.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
await C.upsertTenant({ id: "zc", name: "Changes", domains: ["zc.test"], dbUrl: "file:.test-doc-changes-docs.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "zcl", name: "Legacy", domains: ["zcl.test"], dbUrl: "file:.test-doc-changes-legacy.db", config: {}, secrets: {} });
const TEN = { docs: await C.getTenant("zc"), legacy: await C.getTenant("zcl") };

const ownerU = await I.createUser({ email: "asha@zc.test", name: "Asha Rao", password: "owner-pass-changes" });
const staffU = await I.createUser({ email: "ravi@zc.test", name: "Ravi Kumar", password: "staff-pass-changes" });
const supportU = await I.createUser({ email: "help@zc.test", name: "Support Person", password: "support-pass-changes" });
for (const tid of ["zc", "zcl"]) {
  await I.addMembership(ownerU.id, tid, "owner");
  await I.addMembership(staffU.id, tid, "staff");
  await I.addMembership(supportU.id, tid, "support");
}
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const SUPPORT = await tok(supportU);

const req = (tenant, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${tenant.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = async (body, { as = OWNER, store = "docs" } = {}) => withTenant(TEN[store], () => handleDocumentsPut(req(TEN[store], as, body)));
const inT = (fn, store = "docs") => withTenant(TEN[store], fn);
const sql = async (q, args = [], store = "docs") => (await raw[store].execute({ sql: q, args })).rows;
const dump = async (store = "docs") => {
  const out = {};
  for (const table of ["documents", "document_versions", "publish_log", "release_state", "releases", "cms_state"]) {
    out[table] = (await raw[store].execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows.map((r) => ({ ...r }));
  }
  return JSON.stringify(out);
};
const unchanged = async (before, label, store = "docs") => eq(await dump(store), before, `${label}: storage changed:`);
const docRow = async (id) => (await sql("SELECT * FROM documents WHERE id = ?", [id]))[0];

const hero = (title, id = "sec_hero1") => ({ ...R.newSection("hero", { id }), settings: { ...R.newSection("hero").settings, title } });
const text = (id, title, body = ["Some words."]) => ({ id, kind: "text", v: 1, enabled: true, settings: { title, body }, blocks: [] });
const route = (slug, title) => ({ ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug, title } });

const create = async (args, opts) => {
  const r = await api({ createDocument: args }, opts);
  if (r.status !== 200) throw new Error(`create: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
};
const save = async (d, body, opts) => {
  const r = await api({ saveDraft: { id: d.id, body }, revision: d.revision }, opts);
  if (r.status !== 200) throw new Error(`save: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
};
const publish = async (d) => {
  const r = await api({ publish: { id: d.id, draftHash: d.draftHash }, revision: d.revision });
  if (r.status !== 200) throw new Error(`publish: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  return (await api({ getDocument: d.id })).body.document;
};
const changes = async (id, opts) => api({ listChanges: { id } }, opts);
const keepLive = async (d, sectionId, opts) => api({ keepLiveSection: { id: d.id, sectionId }, revision: d.revision }, opts);
const keep = async (id, body, opts) => api({ keepAsEarlierDraft: { id, body } }, opts);
const words = (r) => r.body.rows.map((x) => x.words);
const liveBody = async (d) => JSON.parse((await sql("SELECT body FROM document_versions WHERE id = ?", [(await docRow(d.id)).published_version_id]))[0].body);
const draftOf = async (id) => JSON.parse((await docRow(id)).draft);
const ids = (body) => body.sections.map((s) => s.id);
// No hash, no id in founder words
const NO_IDS_RE = /\b(?:sec|doc|ver|log|set|blk)_[\w-]+|\b[0-9a-f]{12,}\b|hash/i;
const plainWords = (list) => {
  for (const w of list) ok(!NO_IDS_RE.test(w), `plain words, got "${w}"`);
};

// A page published with [hero? no: text sections], for the restore cases.
async function publishedPage(slug, sections) {
  let d = await create({ type: "page", meta: { slug, title: `Page ${slug}` } });
  d = await save(d, { ...route(slug, `Page ${slug}`), sections });
  return publish(d);
}

// --- PUB-09: the change list ----------------------------------------------------------
console.log("— the change list (PUB-09)");

await t("a home draft with an edited hero title and a half-done new banner lists exactly 'Hero: title changed' and 'Banner: added'; keepLiveSection on the banner removes it; a publish then ships only the hero edit", async () => {
  let home = await create({ type: "home" });
  home = await save(home, { ...home.body, sections: [hero("Old title")] });
  home = await publish(home);
  const live0 = await liveBody(home);
  eq(live0.sections.map((s) => s.settings.title ?? null), ["Old title"], "live before:");

  const banner = { ...R.newSection("banner", { id: "sec_newban1" }), settings: { title: "", text: "", button: null } };
  home = await save(home, { ...home.body, sections: [hero("New title"), banner] });
  const r = await changes(home.id);
  likeShape(r, "listChanges", "ok");
  eq(r.body.firstPublish, false, "firstPublish:");
  eq(words(r), ["Hero: title changed", "Banner: added"], "rows:");
  eq(r.body.rows.map((x) => [x.kind, x.sectionId]), [["edited", "sec_hero1"], ["added", "sec_newban1"]], "kinds and anchors:");
  plainWords(words(r));

  const k = await keepLive(home, "sec_newban1");
  likeShape(k, "keepLiveSection", "ok");
  eq(k.body.document.revision, home.revision + 1, "revision moved on:");
  ok(k.body.document.draftHash !== home.draftHash, "a new draftHash:");
  eq(k.body.document.draftHash, (await docRow(home.id)).draft_hash, "the answer's draftHash is the stored one:");
  eq(ids(await draftOf(home.id)), ["sec_hero1"], "the banner is gone from the draft:");
  eq((await draftOf(home.id)).sections[0].settings.title, "New title", "the hero edit stays:");
  eq(words(await changes(home.id)), ["Hero: title changed"], "rows after:");
  home = k.body.document;

  home = await publish(home);
  const live1 = await liveBody(home);
  eq(live1.sections.map((s) => [s.kind, s.settings.title]), [["hero", "New title"]], "only the hero edit went live:");
  const after = await changes(home.id);
  likeShape(after, "listChanges", "ok");
  eq(after.body.rows, [], "nothing left to publish:");
});

await t("negative: a migrated document whose draft differs only by lazily stamped ids lists no changes, through the hash check and through the diff", async () => {
  let d = await publishedPage("migrated-one", [text("sec_mig1", "First"), text("sec_mig2", "Second")]);
  // the live version as a migration wrote it: the same content, no ids
  const at = new Date().toISOString();
  const noIds = { ...(await liveBody(d)), sections: (await liveBody(d)).sections.map(({ id: _id, ...s }) => s) };
  const row = await V.versionRow({ documentId: d.id, kind: "migrated", body: noIds, schemaVersion: 1, createdAt: at });
  await raw.docs.execute(V.versionStatement(row));
  // published_hash as documentHash would give it (ids stripped): equal to the draft's
  await raw.docs.execute({ sql: "UPDATE documents SET published_version_id = ?, published_hash = ? WHERE id = ?", args: [row.id, await R.documentHash(noIds), d.id] });
  eq((await docRow(d.id)).draft_hash, (await docRow(d.id)).published_hash, "hashes equal:");
  let r = await changes(d.id);
  likeShape(r, "listChanges", "ok");
  eq(r.body, { ok: true, firstPublish: false, rows: [] }, "through the hash check:");
  // a stored hash that disagrees (written some other way): the diff
  // still pairs the sections by content and lists nothing
  await raw.docs.execute({ sql: "UPDATE documents SET published_hash = 'h_written_some_other_way' WHERE id = ?", args: [d.id] });
  ok((await docRow(d.id)).draft_hash !== (await docRow(d.id)).published_hash, "hashes differ now:");
  r = await changes(d.id);
  eq(r.body, { ok: true, firstPublish: false, rows: [] }, "through the diff:");
});

await t("negative: a document whose draft equals its published version lists none; a never-published page and an offline page list firstPublish rows; an unknown id is 404", async () => {
  const d = await publishedPage("equal-one", [text("sec_eq1", "Same")]);
  const r = await changes(d.id);
  eq(r.body, { ok: true, firstPublish: false, rows: [] }, "equal:");

  const fresh = await create({ type: "page", meta: { slug: "never-live", title: "Never live" } });
  await save(fresh, { ...route("never-live", "Never live"), sections: [text("sec_nl1", "One"), { ...text("sec_nl2", "Hidden one"), enabled: false }] });
  const f = await changes(fresh.id);
  likeShape(f, "listChanges", "firstPublish");
  eq(f.body.firstPublish, true, "never published:");
  eq(f.body.sections.map((x) => x.words), ['Page title: "Never live"', "Text 1"], "what goes live (the hidden one left out):");

  // offline (decision 4): no published pointer, no published hash, undone set
  const live = (await docRow(d.id)).published_version_id;
  await raw.docs.execute({ sql: "UPDATE documents SET published_version_id = NULL, published_hash = NULL, undone_version_id = ? WHERE id = ?", args: [live, d.id] });
  const o = await changes(d.id);
  likeShape(o, "listChanges", "firstPublish");
  eq(o.body.sections.map((x) => x.words), ['Page title: "Page equal-one"', "Text"], "offline:");
  plainWords(o.body.sections.map((x) => x.words));

  const nf = await changes("doc_NOPE0000000000000");
  likeShape(nf, "listChanges", "notFound");
});

await t("listChanges is a read: read-only roles may list; a store whose stored mode is 'legacy' answers 500 STORE_MODE_INVALID", async () => {
  const d = await publishedPage("support-reads", [text("sec_sr1", "One")]);
  const r = await changes(d.id, { as: SUPPORT });
  eq(r.status, 200, "support reads:");
  const l = await changes("doc_home", { store: "legacy" });
  likeShape(l, "listChanges", "modeInvalid");
});

// --- PUB-09: keep the live version of a section ---------------------------------------
console.log("— keep the live version of a section (PUB-09)");

await t("removed: keepLiveSection puts it back at its live place (after its live neighbour, with a section added above); moved: back to its live place; hidden: shown again as live; each leaves no row for it", async () => {
  // removed, with another section added at the top
  let d = await publishedPage("restore-removed", [text("sec_ra", "A"), text("sec_rb", "B"), text("sec_rc", "C")]);
  d = await save(d, { ...d.body, sections: [text("sec_rnew", "New on top"), text("sec_ra", "A"), text("sec_rc", "C")] });
  let rows = (await changes(d.id)).body.rows;
  ok(rows.some((x) => x.kind === "removed" && x.sectionId === "sec_rb"), `removed row: ${JSON.stringify(rows)}`);
  let k = await keepLive(d, "sec_rb");
  likeShape(k, "keepLiveSection", "ok");
  eq(ids(await draftOf(d.id)), ["sec_rnew", "sec_ra", "sec_rb", "sec_rc"], "B back after A:");
  eq((await draftOf(d.id)).sections[2].settings.title, "B", "with its live content:");
  rows = (await changes(d.id)).body.rows;
  eq(rows.map((x) => x.words), ["Text 1: added"], "only the addition is left:");

  // removed at the very top, nothing before it
  d = await publishedPage("restore-first", [text("sec_fa", "A"), text("sec_fb", "B")]);
  d = await save(d, { ...d.body, sections: [text("sec_fb", "B")] });
  k = await keepLive(d, "sec_fa");
  eq(ids(await draftOf(d.id)), ["sec_fa", "sec_fb"], "A back at the top:");

  // moved
  d = await publishedPage("restore-moved", [text("sec_ma", "A"), text("sec_mb", "B"), text("sec_mc", "C")]);
  d = await save(d, { ...d.body, sections: [text("sec_mb", "B"), text("sec_mc", "C"), text("sec_ma", "A")] });
  rows = (await changes(d.id)).body.rows;
  eq(rows.map((x) => [x.kind, x.sectionId]), [["moved", "sec_ma"]], "one moved row:");
  k = await keepLive(d, "sec_ma");
  eq(ids(await draftOf(d.id)), ["sec_ma", "sec_mb", "sec_mc"], "A back at the top:");
  eq((await changes(d.id)).body.rows, [], "no row left:");

  // moved down in the middle, and edited too: back in place with the live text
  d = await publishedPage("restore-moved2", [text("sec_na", "A"), text("sec_nb", "B"), text("sec_nc", "C"), text("sec_nd", "D")]);
  d = await save(d, { ...d.body, sections: [text("sec_na", "A"), text("sec_nc", "C"), text("sec_nd", "D"), text("sec_nb", "B edited")] });
  rows = (await changes(d.id)).body.rows;
  ok(rows.some((x) => x.kind === "moved" && x.sectionId === "sec_nb"), `moved row: ${JSON.stringify(rows)}`);
  k = await keepLive(d, "sec_nb");
  eq(ids(await draftOf(d.id)), ["sec_na", "sec_nb", "sec_nc", "sec_nd"], "B back after A:");
  eq((await draftOf(d.id)).sections[1].settings.title, "B", "live text:");
  eq((await changes(d.id)).body.rows, [], "no row left:");

  // hidden
  d = await publishedPage("restore-hidden", [text("sec_ha", "A"), text("sec_hb", "B")]);
  d = await save(d, { ...d.body, sections: [text("sec_ha", "A"), { ...text("sec_hb", "B"), enabled: false }] });
  rows = (await changes(d.id)).body.rows;
  eq(rows.map((x) => [x.kind, x.sectionId, x.words]), [["hidden", "sec_hb", "Text 2: hidden"]], "hidden row:");
  k = await keepLive(d, "sec_hb");
  eq((await draftOf(d.id)).sections.map((s) => s.enabled), [true, true], "shown again:");
  eq((await changes(d.id)).body.rows, [], "no row left:");

  // edited, among others the founder keeps: only that one goes back
  d = await publishedPage("restore-edited", [text("sec_ea", "A"), text("sec_eb", "B")]);
  d = await save(d, { ...d.body, sections: [text("sec_ea", "A changed"), text("sec_eb", "B changed")] });
  k = await keepLive(d, "sec_eb");
  eq((await draftOf(d.id)).sections.map((s) => s.settings.title), ["A changed", "B"], "only B went back:");
  eq(words(await changes(d.id)), ["Text 1: title changed"], "A's edit is still listed:");
});

await t("keepLiveSection pairs as the change list does: an edited section of a migrated live version without ids goes back under the draft's id", async () => {
  let d = await publishedPage("restore-migrated", [text("sec_ga", "A"), text("sec_gb", "B")]);
  const live = await liveBody(d);
  const noIds = { ...live, sections: live.sections.map(({ id: _id, ...s }) => s) };
  const row = await V.versionRow({ documentId: d.id, kind: "migrated", body: noIds, schemaVersion: 1, createdAt: new Date().toISOString() });
  await raw.docs.execute(V.versionStatement(row));
  await raw.docs.execute({ sql: "UPDATE documents SET published_version_id = ?, published_hash = ? WHERE id = ?", args: [row.id, await R.documentHash(noIds), d.id] });
  d = (await api({ getDocument: d.id })).body.document;
  d = await save(d, { ...d.body, sections: [text("sec_ga", "A"), text("sec_gb", "B edited")] });
  eq(words(await changes(d.id)), ["Text 2: title changed"], "listed as an edit:");
  await keepLive(d, "sec_gb");
  const draft = await draftOf(d.id);
  eq(draft.sections.map((s) => [s.id, s.settings.title]), [["sec_ga", "A"], ["sec_gb", "B"]], "live text under the draft's id:");
  eq((await changes(d.id)).body.rows, [], "no row left:");
});

await t("keepLiveSection with a stale revision is 409 with current (and storage unchanged); without a revision 428; never published or no such section 404; the checkpoint of the replaced draft is the batch's first statement", async () => {
  let d = await publishedPage("keep-stale", [text("sec_ka", "A"), text("sec_kb", "B")]);
  d = await save(d, { ...d.body, sections: [text("sec_ka", "A"), text("sec_kb", "B changed")] });
  const theirs = await save(d, { ...d.body, sections: [text("sec_ka", "A theirs"), text("sec_kb", "B changed")] }, { as: STAFF });
  const fresh = await create({ type: "page", meta: { slug: "keep-never", title: "Never" } });
  let before = await dump();
  const r = await keepLive(d, "sec_kb");
  likeShape(r, "keepLiveSection", "changed");
  eq(r.body.current.revision, theirs.revision, "current revision:");
  eq(r.body.current.body.sections[0].settings.title, "A theirs", "current body:");
  eq(r.body.current.updatedByName, "Ravi Kumar", "who saved it:");
  await unchanged(before, "stale keepLiveSection");

  const { revision: _r, ...noRev } = { keepLiveSection: { id: d.id, sectionId: "sec_kb" }, revision: 1 };
  likeShape(await api(noRev), "keepLiveSection", "revisionRequired");
  d = theirs;
  likeShape(await keepLive(d, "sec_nothere"), "keepLiveSection", "notFound");
  const nf = await keepLive(fresh, "sec_whatever");
  likeShape(nf, "keepLiveSection", "notFound");
  ok(/never been published/.test(nf.body.error), `words: ${nf.body.error}`);
  await unchanged(before, "refused keepLiveSection");

  // the checkpoint goes first, in the same batch, and holds the replaced draft
  const inst = await inT(() => currentDatabase());
  const send = inst.libsql.batch;
  let seen = null;
  inst.libsql.batch = async (stmts, mode) => {
    seen = stmts.map((s) => String(s.sql).split(" ").slice(0, 3).join(" "));
    return send.call(inst.libsql, stmts, mode);
  };
  let k;
  try {
    k = await keepLive(d, "sec_kb");
  } finally {
    delete inst.libsql.batch;
  }
  eq(k.status, 200, "kept:");
  eq(seen.slice(0, 2), ["INSERT INTO document_versions", "UPDATE documents SET"], "statements:");
  const cp = await sql("SELECT kind, note, body FROM document_versions WHERE document_id = ? AND note = ? ORDER BY rowid DESC LIMIT 1", [d.id, Ch.KEEP_LIVE_NOTE]);
  eq(cp.length, 1, "a checkpoint with the note:");
  eq(cp[0].kind, "checkpoint", "kind:");
  eq(JSON.parse(cp[0].body).sections[1].settings.title, "B changed", "it holds the draft before the keep:");
  eq((await draftOf(d.id)).sections[1].settings.title, "B", "the draft has the live version:");

  // staff may keep (storefront.write); support may not
  before = await dump();
  const s = await keepLive(k.body.document, "sec_ka", { as: SUPPORT });
  eq(s.status, 403, "support:");
  await unchanged(before, "support keepLiveSection");
});

await t("keepLiveSection, the pure part: every case on plain bodies, and a section neither side has gives null", async () => {
  const L = { sections: [text("sec_pa", "A"), text("sec_pb", "B"), text("sec_pc", "C")] };
  const at = (draft, id) => Ch.keepLiveBody(L, { sections: draft }, id)?.sections.map((s) => `${s.id}:${s.settings.title}:${s.enabled}`);
  eq(at([text("sec_pa", "A"), text("sec_pc", "C")], "sec_pb"), ["sec_pa:A:true", "sec_pb:B:true", "sec_pc:C:true"], "removed in the middle:");
  eq(at([text("sec_pa", "A"), text("sec_pb", "B")], "sec_pc"), ["sec_pa:A:true", "sec_pb:B:true", "sec_pc:C:true"], "removed at the end:");
  eq(at([], "sec_pb"), ["sec_pb:B:true"], "into an empty draft (clamped):");
  eq(at([text("sec_pc", "C"), text("sec_pa", "A"), text("sec_pb", "B")], "sec_pc"), ["sec_pa:A:true", "sec_pb:B:true", "sec_pc:C:true"], "moved to the top, put back at the end:");
  eq(at([text("sec_pa", "A"), text("sec_px", "X"), text("sec_pb", "B"), text("sec_pc", "C")], "sec_px"), ["sec_pa:A:true", "sec_pb:B:true", "sec_pc:C:true"], "added:");
  eq(at([text("sec_pa", "A"), { ...text("sec_pb", "B2"), enabled: false }, text("sec_pc", "C")], "sec_pb"), ["sec_pa:A:true", "sec_pb:B:true", "sec_pc:C:true"], "hidden and edited:");
  eq(Ch.keepLiveBody(L, { sections: [text("sec_pa", "A")] }, "sec_none"), null, "unknown:");
  const meta = { type: "page", meta: { slug: "x", title: "Draft title" }, sections: [text("sec_pa", "A")] };
  eq(Ch.keepLiveBody(L, meta, "sec_pb").meta, meta.meta, "the rest of the draft is untouched:");
});

await t("P3-FIX2: keepLiveBody keeps the draft's id for a section paired by content under another valid id (moved back, never renamed to the live id)", async () => {
  const L = { sections: [text("sec_la", "A"), text("sec_lb", "B")] };
  // the draft has A's content under a new id, after B: paired by content, one of them moved
  const D = { sections: [text("sec_lb", "B"), text("sec_dx", "A")] };
  const { diffBodies } = await import("../lib/documents/diff.js");
  const before = diffBodies("page", { type: "page", ...L }, { type: "page", ...D });
  ok(before.some((r) => r.sectionId === "sec_dx" && r.kind === "moved"), `listed as moved: ${JSON.stringify(before)}`);
  const out = Ch.keepLiveBody(L, D, "sec_dx");
  eq(out.sections.map((s) => [s.id, s.settings.title]), [["sec_dx", "A"], ["sec_lb", "B"]], "back in its live place, under the draft's id:");
  eq(diffBodies("page", { type: "page", ...L }, { type: "page", ...out }), [], "no row left:");
});

await t("P3-FIX2: keepLiveSection never leaves a row for the section it restored, even when the draft's order is scrambled (live [l0..l4], draft [l4,l2,l3,l0], keep l1); and over every keep in a small exhaustive sweep", async () => {
  const { diffBodies } = await import("../lib/documents/diff.js");
  const ls = [0, 1, 2, 3, 4].map((n) => text(`sec_l${n}`, `T${n}`));
  const L = { type: "page", sections: ls };
  const D = { type: "page", sections: [4, 2, 3, 0].map((n) => ls[n]) };
  const out = Ch.keepLiveBody(L, D, "sec_l1");
  const rows = diffBodies("page", L, out);
  eq(rows.filter((r) => r.sectionId === "sec_l1"), [], `no row for l1 (got ${JSON.stringify(rows)}, order ${out.sections.map((s) => s.id)}):`);
  ok(out.sections.some((s) => s.id === "sec_l1"), "l1 is back");
  // every permutation of a 4-section subset of live, every live section kept
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  let cases = 0;
  for (let drop = 0; drop < 5; drop++) {
    const rest = [0, 1, 2, 3, 4].filter((n) => n !== drop);
    for (const order of perms(rest)) {
      const draft = { type: "page", sections: order.map((n) => ls[n]) };
      for (let keepN = 0; keepN < 5; keepN++) {
        const kept = Ch.keepLiveBody(L, draft, `sec_l${keepN}`);
        const left = diffBodies("page", L, kept).filter((r) => r.sectionId === `sec_l${keepN}`);
        if (left.length) throw new Error(`draft [${order}] keep l${keepN}: ${JSON.stringify(left)}`);
        cases++;
      }
    }
  }
  ok(cases === 5 * 24 * 5, `swept ${cases}`);
});

await t("P3-FIX2: keepLiveSection on a page taken offline is 404 with words that say it's offline (not 'never been published')", async () => {
  let d = await publishedPage("keep-offline", [text("sec_oa", "A")]);
  const off = await api({ unpublish: { id: d.id }, revision: d.revision });
  eq(off.status, 200, `taken offline: ${JSON.stringify(off.body).slice(0, 200)}`);
  d = (await api({ getDocument: d.id })).body.document;
  const before = await dump();
  const r = await keepLive(d, "sec_oa");
  likeShape(r, "keepLiveSection", "notFound");
  eq(r.body.error, "This page is offline, so there is no live version to keep. Publish it again to bring it back.", "the words:");
  await unchanged(before, "offline keepLiveSection");
});

// --- ED-03: keep as an earlier draft -----------------------------------------------------
console.log("— keep as an earlier draft (ED-03)");

await t("keepAsEarlierDraft stores an undo_saved version listed in listHistory with its note, sanitized, and leaves draft, revision and hash unchanged", async () => {
  const d = await publishedPage("kept-one", [text("sec_k1", "Live")]);
  const before = await docRow(d.id);
  const body = { ...route("kept-one", "Page kept-one"), sections: [text("sec_k1", "From the other tab"), { id: "sec_krt", kind: "rich_text", v: 1, enabled: true, settings: { title: "", html: "<p>Hello</p><script>alert(1)</script>" }, blocks: [] }] };
  const r = await keep(d.id, body);
  likeShape(r, "keepAsEarlierDraft", "ok");
  eq(r.body.savedVersion.note, "Kept from another tab", "note:");
  const after = await docRow(d.id);
  eq([after.draft, after.revision, after.draft_hash, after.updated_at], [before.draft, before.revision, before.draft_hash, before.updated_at], "the draft is untouched:");
  const v = (await sql("SELECT kind, note, body, created_by FROM document_versions WHERE id = ?", [r.body.savedVersion.id]))[0];
  eq([v.kind, v.note, v.created_by], ["undo_saved", "Kept from another tab", `merchant:${ownerU.id}`], "stored:");
  ok(!/<script/i.test(String(v.body)), `sanitized: ${v.body}`);
  ok(/From the other tab/.test(String(v.body)) && /<p>Hello<\/p>/.test(String(v.body)), "the text is kept:");
  const h = await api({ listHistory: d.id });
  const it = h.body.versions.find((x) => x.id === r.body.savedVersion.id);
  eq([it?.kind, it?.note, it?.by], ["undo_saved", "Kept from another tab", "Asha Rao"], "in Earlier versions:");
  // it survives later autosaves (undo_saved is never pruned)
  V.setCheckpointInterval(0);
  try {
    let cur = (await api({ getDocument: d.id })).body.document;
    for (let i = 0; i < 25; i++) cur = await save(cur, { ...cur.body, sections: [text("sec_k1", `Save ${i}`)] });
  } finally {
    V.setCheckpointInterval(null);
  }
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE id = ?", [r.body.savedVersion.id]))[0].n, 1, "kept after 25 saves:");
});

await t("P3-FIX5: a version kept from the local backup (from: 'backup') reads 'Edits this browser kept', never 'Kept from another tab', and counts toward the cap of 10", async () => {
  const d = await publishedPage("kept-backup", [text("sec_kb", "Live")]);
  const body = (n) => ({ ...route("kept-backup", "Page kept-backup"), sections: [text("sec_kb", `Never reached the server ${n}`)] });
  const r = await api({ keepAsEarlierDraft: { id: d.id, body: body(0), from: "backup" } });
  likeShape(r, "keepAsEarlierDraft", "ok");
  eq(r.body.savedVersion.note, "Edits this browser kept", "note:");
  const v = (await sql("SELECT kind, note, body FROM document_versions WHERE id = ?", [r.body.savedVersion.id]))[0];
  eq([v.kind, v.note], ["undo_saved", "Edits this browser kept"], "stored:");
  ok(/Never reached the server 0/.test(String(v.body)), "the unsent text is in the stored version");
  const it = (await api({ listHistory: d.id })).body.versions.find((x) => x.id === r.body.savedVersion.id);
  ok(it && it.note === "Edits this browser kept" && !/another tab/.test(it.note), `in Earlier versions: ${JSON.stringify(it)}`);
  // without from, the other-tab note as before
  eq((await keep(d.id, body(1))).body.savedVersion.note, "Kept from another tab", "another tab's keep:");
  // the two kinds share the cap
  for (let n = 2; n < 10; n++) eq((await api({ keepAsEarlierDraft: { id: d.id, body: body(n), from: n % 2 ? "backup" : undefined } })).status, 200, `kept ${n + 1}:`);
  const full = await api({ keepAsEarlierDraft: { id: d.id, body: body(10), from: "backup" } });
  likeShape(full, "keepAsEarlierDraft", "tooManyKept");
  // anything else in from is refused before it is read
  const bad = await api({ keepAsEarlierDraft: { id: d.id, body: body(11), from: "tab" } });
  eq([bad.status, bad.body.code], [400, "MALFORMED"], "from must be 'backup':");
});

await t("keepAsEarlierDraft dedupes an identical body (and one that differs only by stamped ids), answers 409 TOO_MANY_KEPT at 10 with nothing stored, refuses a structurally invalid body with 422, is 403 for read-only callers, 404 for an unknown page and 500 STORE_MODE_INVALID on a store whose stored mode is legacy", async () => {
  const d = await publishedPage("kept-many", [text("sec_km", "Live")]);
  const body = (n) => ({ ...route("kept-many", "Page kept-many"), sections: [text("sec_km", `Tab copy ${n}`)] });
  const first = await keep(d.id, body(0));
  eq(first.status, 200, "first:");
  let before = await dump();
  const again = await keep(d.id, body(0));
  likeShape(again, "keepAsEarlierDraft", "ok");
  eq(again.body.savedVersion, first.body.savedVersion, "the same version back:");
  const noIds = { ...body(0), sections: body(0).sections.map(({ id: _id, ...s }) => s) };
  eq((await keep(d.id, noIds)).body.savedVersion.id, first.body.savedVersion.id, "ids stamped differently, same version:");
  await unchanged(before, "dedupe");

  // an undo_saved version Undo kept dedupes too
  const undoKept = await inT(() => import("../lib/documents/service.js").then((S2) => S2.saveVersion({ documentId: d.id, body: body(99), note: "Edits kept by Undo" })));
  eq((await keep(d.id, body(99))).body.savedVersion, { id: undoKept.id, note: "Edits kept by Undo" }, "Undo's kept version:");

  for (let n = 1; n < 10; n++) eq((await keep(d.id, body(n))).status, 200, `kept ${n + 1}:`);
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND note = 'Kept from another tab'", [d.id]))[0].n, 10, "ten kept:");
  before = await dump();
  const full = await keep(d.id, body(10));
  likeShape(full, "keepAsEarlierDraft", "tooManyKept");
  eq(full.body.error, "There are already 10 kept drafts for this page. Open Earlier versions to tidy them.", "words:");
  eq((await keep(d.id, body(3))).status, 200, "an identical body still dedupes at the cap:");
  await unchanged(before, "at the cap");

  // structure
  const bad = await keep(d.id, { ...body(0), sections: [{ id: "sec_bad1", kind: "no_such_kind", v: 1, enabled: true, settings: {}, blocks: [] }] });
  likeShape(bad, "keepAsEarlierDraft", "validationFailed");
  const wrongType = await keep(d.id, { type: "home", sections: [] });
  eq(wrongType.status, 422, "another type's body:");
  await unchanged(before, "invalid bodies");

  // who and where
  eq((await keep(d.id, body(50), { as: SUPPORT })).status, 403, "support:");
  likeShape(await keep("doc_NOPE0000000000000", body(0)), "keepAsEarlierDraft", "notFound");
  likeShape(await keep("doc_home", { type: "home", sections: [] }, { store: "legacy" }), "keepAsEarlierDraft", "modeInvalid");
  await unchanged(before, "refusals");
  // staff may keep
  const other = await publishedPage("kept-staff", [text("sec_ks", "Live")]);
  eq((await keep(other.id, { ...route("kept-staff", "x"), sections: [text("sec_ks", "Staff tab")] }, { as: STAFF })).status, 200, "staff:");
});

await t("P3-FIX2: keepAsEarlierDraft refuses an archived page (409 DOCUMENT_ARCHIVED, like saveDraft), storing nothing; the cart keeps one like any document (P4-LIVEROW, plan OQ-6)", async () => {
  const d = await create({ type: "page", meta: { slug: "kept-archived", title: "Kept archived" } });
  const a = await api({ archive: d.id, revision: d.revision });
  eq(a.status, 200, `archived: ${JSON.stringify(a.body).slice(0, 200)}`);
  let before = await dump();
  const r = await keep(d.id, { ...route("kept-archived", "Kept archived"), sections: [text("sec_ar", "Tab copy")] });
  likeShape(r, "keepAsEarlierDraft", "archived");
  await unchanged(before, "archived keep");
  // P4-LIVEROW: the cart's old refusal is gone; it keeps an earlier draft too
  const cartBody = R.emptyBody("cart");
  const now = new Date().toISOString();
  await raw.docs.execute({ sql: "INSERT INTO documents (id, type, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_cart', 'cart', 'Cart', ?, ?, 1, ?, ?, ?)", args: [JSON.stringify(cartBody), await R.documentHash(cartBody), cartBody.schema ?? 1, now, now] });
  const c = await keep("doc_cart", { ...cartBody, settings: { ...cartBody.settings, title: "Another tab's title" } });
  likeShape(c, "keepAsEarlierDraft", "ok");
  await raw.docs.execute("DELETE FROM documents WHERE id = 'doc_cart'");
});

await t("keepAsEarlierDraft: two tabs keeping at the same moment can't pass the cap, and a statement resent after a lost answer stores one version", async () => {
  const d = await publishedPage("kept-race", [text("sec_kr", "Live")]);
  const body = (n) => ({ ...route("kept-race", "Page kept-race"), sections: [text("sec_kr", `Race ${n}`)] });
  for (let n = 0; n < 8; n++) await keep(d.id, body(n));
  const results = await Promise.all([8, 9, 10, 11, 12].map((n) => keep(d.id, body(n))));
  eq(results.map((r) => r.status).sort(), [200, 200, 409, 409, 409], "two more fit:");
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND note = 'Kept from another tab'", [d.id]))[0].n, 10, "never over 10:");

  // a lost answer: the INSERT ran, the driver throws, the version is found
  const d2 = await publishedPage("kept-lost", [text("sec_kl", "Live")]);
  const inst = await inT(() => currentDatabase());
  const exec = inst.libsql.execute;
  inst.libsql.execute = async (st) => {
    const out = await exec.call(inst.libsql, st);
    if (typeof st === "object" && /^INSERT INTO document_versions/.test(st.sql) && /Kept|note = \?/.test(st.sql)) {
      delete inst.libsql.execute;
      // the resend lib/db.js would make: adds nothing
      const resent = await exec.call(inst.libsql, st);
      eq(resent.rowsAffected, 0, "the resend adds nothing:");
      throw new Error("fetch failed: the answer was lost");
    }
    return out;
  };
  let r;
  try {
    r = await keep(d2.id, { ...route("kept-lost", "x"), sections: [text("sec_kl", "Lost answer")] });
  } finally {
    delete inst.libsql.execute;
  }
  eq(r.status, 200, `kept: ${JSON.stringify(r.body).slice(0, 200)}`);
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'undo_saved'", [d2.id]))[0].n, 1, "one version:");
});

await t("every listChanges, keepLiveSection and keepAsEarlierDraft outcome this suite produced matched documents-api-shapes.js; no NOT_BUILT left", async () => {
  for (const want of ["listChanges.ok", "listChanges.firstPublish", "listChanges.modeInvalid", "listChanges.notFound", "keepLiveSection.ok", "keepLiveSection.changed", "keepLiveSection.revisionRequired", "keepLiveSection.notFound", "keepAsEarlierDraft.ok", "keepAsEarlierDraft.tooManyKept", "keepAsEarlierDraft.validationFailed", "keepAsEarlierDraft.notFound", "keepAsEarlierDraft.modeInvalid"]) {
    ok(SEEN_SHAPES.has(want) || only, `${want} was checked`);
  }
  const d = await publishedPage("built", [text("sec_bt", "x")]);
  for (const body of [{ listChanges: { id: d.id } }, { keepLiveSection: { id: d.id, sectionId: "sec_bt" }, revision: d.revision }, { keepAsEarlierDraft: { id: d.id, body: { ...route("built", "x"), sections: [] } } }]) {
    const r = await api(body);
    ok(r.status !== COMMON.outcomes.notBuilt.status, `${Object.keys(body)[0]}: ${r.status}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
for (const c of Object.values(raw)) c.close();
await cleanup();
process.exit(fail ? 1 : 0);
