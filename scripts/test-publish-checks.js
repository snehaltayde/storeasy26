// P3-CHECKS suite (PUB-03, PUB-05, PUB-04, PUB-11, PUB-06, TOK-03): the publish
// checks of lib/documents/checks.js and lib/documents/publish.js, through the
// real console API (lib/admin/documents-api.js: real requireAdmin, real
// sessions, real tenant databases with every migration). File databases only;
// the guarded commit itself is proven on sqld by test:publish and
// test:publish-service.
//   pnpm test:publish-checks
//
// What it proves, by acceptance line (docs/cms-reviews/P3-CHECKS.md):
//   - a link to an unpublished campaign: 422 LINKS_TO_UNPUBLISHED and its
//     offer; sending the offer makes both live in one release; a target changed
//     after the offer is 409 DOCUMENT_CHANGED
//   - coverage: links, rails, media, alt text, redirects, code-default pages
//   - scope: another document's draft never blocks, a list-only product warns
//   - the inherited level, and an offline page that is not inherited
//   - every issue has level, anchor, where and an action; hideSection replays
//   - publish again after take offline (REPUBLISH_CONFIRM_NEEDED), and the
//     plain publish clearing undone_version_id
//   - the P22 skip rule
//   - a closed store opens with its home page (FIRST_PUBLISH_NEEDS_HOME)
//   - liveUrl and undo on every published item; the conflicts name who
//   - the design document blocks only changed colour pairs
//   - the P3-COMMIT review pins: draftSlugOwner and archived holders,
//     liveEntryOf's narrower offline rule, the commit.js liveListHoldsMine call
import "./support/request-cache.js";
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
process.env.DATABASE_URL = "file:.test-pc-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pc-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

// store key -> tenant id. "brand" is one of BeastLife's own tenant ids, so the
// code-default pages apply there (lib/brand-tenants.js).
const STORES = { ck: "pcck", closed1: "pcclosed1", closed2: "pcclosed2", closed3: "pcclosed3", nohome: "pcnohome", brand: "beastlife-staging", design: "pcdesign" };
const FILES = [".test-pc-default.db", ".test-pc-platform.db", ...Object.keys(STORES).map((s) => `.test-pc-${s}.db`)];
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
const B = await import("../lib/documents/build.js");
const Checks = await import("../lib/documents/checks.js");
const L = await import("../lib/documents/release-list.js");
const ids = await import("../lib/documents/ids.js");
const { commitPublishBatch } = await import("../lib/documents/commit.js");
const { versionRow } = await import("../lib/documents/versions.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const R = await import("../lib/registry/index.js");
const Res = await import("../lib/content/resolve.js");
const { SHAPES } = await import("../lib/admin/documents-api-shapes.js");
const { watchStatements } = await import("./support/request-cache.js");
const { currentDatabase } = await import("../lib/db.js");

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
  }
}
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const eq = (got, want, label = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${label} expected ${canon(want).slice(0, 700)}, got ${canon(got).slice(0, 700)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- stores and people ------------------------------------------------------------------
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");
const raw = {};
const TEN = {};
for (const [s, id] of Object.entries(STORES)) {
  const c = createClient({ url: `file:.test-pc-${s}.db` });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS);
  await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  raw[s] = c;
  await C.upsertTenant({ id, name: `PC ${s}`, domains: [`${id}.test`], dbUrl: `file:.test-pc-${s}.db`, config: { site: { name: `PC ${s} Store` }, site_url: `https://${id}.test` }, secrets: {} });
  TEN[s] = await C.getTenant(id);
}
const ownerU = await I.createUser({ email: "owner@pc.test", name: "Asha Rao", password: "owner-pass-checks" });
const staffU = await I.createUser({ email: "staff@pc.test", name: "Ravi", password: "staff-pass-checks" });
for (const id of Object.values(STORES)) {
  await I.addMembership(ownerU.id, id, "owner");
  await I.addMembership(staffU.id, id, "staff");
}
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);

const req = (tenant, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${tenant.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (body, { as = OWNER, store = "ck" } = {}) => withTenant(TEN[store], () => handleDocumentsPut(req(TEN[store], as, body)));
const inT = (fn, store = "ck") => withTenant(TEN[store], fn);
const sql = async (q, args = [], store = "ck") => (await raw[store].execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const dump = async (store = "ck") => {
  const out = {};
  for (const table of ["documents", "document_versions", "publish_log", "release_state", "releases"]) out[table] = await sql(`SELECT * FROM ${table} ORDER BY rowid`, [], store);
  return canon(out);
};
const unchanged = async (before, label, store = "ck") => eq(await dump(store), before, `${label}: storage changed:`);
async function pointerOf(store = "ck") {
  const [row] = await sql("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1", [], store);
  return { pointer: row?.live ?? null, list: row?.content ? JSON.parse(String(row.content)) : null };
}

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
const page = (slug, title, sections, type = "page", meta = {}) => body(type, { meta: { slug, title, ...meta }, sections: sections ?? [textSec("sec_t1", title, "Some words.")] });
const homeBody = (extra = [], title = "Live hero") => body("home", { sections: [sec("hero", "sec_hero", { title }), ...extra] });
const urlLink = (href) => ({ type: "url", href });
const pageLink = (family, slug, document = undefined) => ({ type: "page", family, slug, ...(document ? { document } : {}) });
const bannerTo = (id, link, title = "See this") => sec("banner", id, { title, button: { label: "Go", link } });

const create = async (store, type, extra = {}) => {
  const r = await api({ createDocument: { type, ...extra } }, { store });
  eq(r.status, 200, `create ${type}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
};
const current = (store, id) => inT(() => Docs.getDocument(id), store);
const save = async (store, id, newBody, { as = OWNER } = {}) => {
  const d = await current(store, id);
  const r = await api({ saveDraft: { id, body: newBody }, revision: d.revision }, { store, as });
  eq(r.status, 200, `save ${id}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body.document;
};
const publishApi = async (store, id, { as = OWNER, revision, draftHash, confirmRepublish } = {}) => {
  const d = await current(store, id);
  return api({ publish: { id, draftHash: draftHash ?? d.draftHash, ...(confirmRepublish ? { confirmRepublish: true } : {}) }, revision: revision ?? d.revision }, { store, as });
};
const publishSetApi = async (store, list, { as = OWNER } = {}) => {
  const items = [];
  for (const it of list) {
    const id = typeof it === "string" ? it : it.id;
    const d = await current(store, id);
    items.push({ id, revision: it.revision ?? d.revision, draftHash: it.draftHash ?? d.draftHash, ...(it.confirmRepublish ? { confirmRepublish: true } : {}) });
  }
  return api({ publishSet: items }, { store, as });
};
const published = (r, label = "publish") => {
  eq(r.status, 200, `${label}: ${JSON.stringify(r.body).slice(0, 600)}`);
  return r.body;
};
const issuesOf = (r, code) => (r.body.issues || []).filter((i) => i.code === code);

// The same keys as a shapes example, all the way down (the first element of a
// list), leaving out the optional paths. A document's body is free.
const FREE = new Set(["document.body", "current.body", "documents[].body", "conflicts[].current.body"]);
function sameKeys(got, want, optional = [], path = "") {
  if (FREE.has(path)) return;
  if (Array.isArray(want)) {
    ok(Array.isArray(got), `${path || "body"} is a list`);
    if (want.length && got.length) for (const g of got) sameKeys(g, want[0], optional, `${path}[]`);
    return;
  }
  if (want === null || typeof want !== "object") return;
  if (got === null) return; // a key that may be null is present with null
  ok(got && typeof got === "object", `${path || "body"} is an object`);
  const opt = (k) => optional.includes(`${path ? `${path}.` : ""}${k}`.replace(/^\./, ""));
  const missing = Object.keys(want).filter((k) => !(k in got) && !opt(k));
  const extra = Object.keys(got).filter((k) => !(k in want));
  ok(!missing.length && !extra.length, `${path || "body"}: missing [${missing}], extra [${extra}]`);
  for (const k of Object.keys(want)) if (k in got) sameKeys(got[k], want[k], optional, path ? `${path}.${k}` : k);
}
// actions vary by type: each action is checked against its own keys
const ACTION_KEYS = {
  hideSection: ["type", "documentId", "sectionId"],
  removeSection: ["type", "documentId", "sectionId"],
  removeItem: ["type", "documentId", "field", "index"],
  publishBoth: ["type", "documentId"],
  openField: ["type", "documentId"],
};
const ACTION_OPTIONAL = { removeItem: ["sectionId"], openField: ["sectionId", "field"] };
function checkIssues(list, label) {
  ok(Array.isArray(list), `${label}: issues is a list`);
  for (const i of list) {
    sameKeys({ ...i, actions: [] }, { ...SHAPES.publish.outcomes.validationFailed.body.issues[0], actions: [] }, [], "issue");
    ok(["blocks", "warns", "inherited"].includes(i.level), `${label}: level ${i.level}`);
    ok(typeof i.anchor === "string" && i.anchor.startsWith("f-"), `${label}: anchor ${i.anchor}`);
    ok(typeof i.where === "string" && i.where.length > 0, `${label}: where ${i.where}`);
    ok(Array.isArray(i.actions) && i.actions.length >= 1, `${label}: ${i.code} has no action`);
    for (const a of i.actions) {
      const want = ACTION_KEYS[a.type];
      ok(want, `${label}: action type ${a.type}`);
      const extra = Object.keys(a).filter((k) => !want.includes(k) && !(ACTION_OPTIONAL[a.type] || []).includes(k));
      const missing = want.filter((k) => !(k in a));
      ok(!extra.length && !missing.length, `${label}: action ${JSON.stringify(a)}`);
      ok(SHAPES && Object.keys(ACTION_KEYS).every((ty) => ty), "");
    }
    ok(i.level === "blocks" ? i.severity === "error" : i.severity !== "error", `${label}: level ${i.level} with severity ${i.severity}`);
  }
}
const shapeOf = (name) => SHAPES.publish.outcomes[name];
const likeShape = (r, o, label) => {
  eq(r.status, o.status, `${label} status:`);
  sameKeys({ ...r.body, ...(r.body.issues ? { issues: [] } : {}) }, { ...o.body, ...(o.body.issues ? { issues: [] } : {}) }, o.optional || []);
  if (r.body.issues) checkIssues(r.body.issues, label);
  if (o.body.code) eq(r.body.code, o.body.code, `${label} code:`);
};

// A live version written straight through the commit, past publish
// validation, as a migrated document could be (kind 'migrated').
async function liveFixture(store, docId, b) {
  await inT(async () => {
    const live = await pointerOf(store);
    const v = await versionRow({ documentId: docId, kind: "migrated", body: b, schemaVersion: 1, createdAt: new Date().toISOString() });
    const cur = await current(store, docId);
    const rows = R.documentType(b.type).route ? [{ slug: b.meta.slug, type: b.type, title: b.meta.title, enabled: b.meta.enabled !== false }] : [];
    const list = L.setEntries(live.list || L.emptyList(1, R.singletonTypes()), [{ document: docId, entry: { version: v.id, hash: v.body_hash }, pages: rows }]);
    const r = await commitPublishBatch({ releaseId: ids.relId(), setId: ids.setId(), pointer: live.pointer, list, versions: [v], documents: [{ id: docId, revision: cur.revision, published_version_id: v.id, published_hash: await R.documentHash(b) }], log: [{ id: ids.logId(), document_id: docId, action: "migrated", to_version_id: v.id }] });
    eq(r.outcome, "ok", "fixture:");
  }, store);
}

// Take a page offline through the shared build (as P3-UNDO's unpublish does).
async function takeOffline(store, id) {
  return inT(async () => {
    const live = await B.readLive();
    const d = await Docs.getDocument(id);
    const journal = live.list.indexes?.journal ? await B.journalIndexOf(live.list) : { body: null };
    const liveEntry = B.liveEntryOf(live.list, journal.body, d);
    const liveBody = (await B.readVersionBodies([liveEntry.version])).get(liveEntry.version).body;
    return B.runGuardedBuild(
      ({ live: from, refs }) => B.makeBuild(from, [{ doc: d, body: liveBody, offline: true, action: "unpublish", undone: d.publishedVersionId, liveEntry }], { by: "merchant:x", at: new Date().toISOString(), journal, refs }),
      { live, done: (b) => b, onLost: async () => null },
    );
  }, store);
}

// the catalog: two collections (one with stock, one empty), three products
const CATALOG = async (store) => {
  const c = raw[store];
  const now = new Date().toISOString();
  for (const [id, handle, title, available] of [
    ["gid://shopify/Product/1", "whey", "Whey", 1],
    ["gid://shopify/Product/2", "creatine", "Creatine", 1],
    ["gid://shopify/Product/3", "sold-out-bar", "Sold-out bar", 0],
  ])
    await c.execute({ sql: "INSERT INTO products (id, handle, title, available, synced_at) VALUES (?, ?, ?, ?, ?)", args: [id, handle, title, available, now] });
  for (const [id, handle, title] of [
    ["gid://shopify/Collection/1", "protein", "Protein"],
    ["gid://shopify/Collection/2", "empty-shelf", "Empty shelf"],
  ])
    await c.execute({ sql: "INSERT INTO collections (id, handle, title, synced_at) VALUES (?, ?, ?, ?)", args: [id, handle, title, now] });
  await c.execute({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0), (?, ?, 1)", args: ["gid://shopify/Collection/1", "gid://shopify/Product/1", "gid://shopify/Collection/1", "gid://shopify/Product/2"] });
  await c.execute({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0)", args: ["gid://shopify/Collection/2", "gid://shopify/Product/3"] });
  await c.execute({
    sql: "INSERT INTO media (id, filename, mime, size, width, height, alt, variant, parent_id, sha256, data, created_at) VALUES (?, 'hero.jpg', 'image/jpeg', 3, 10, 10, 'Hero', NULL, NULL, ?, ?, ?)",
    args: ["med_hero1", "sha-hero-1", new Uint8Array([1, 2, 3]), now],
  });
};
for (const s of Object.keys(STORES)) await CATALOG(s);

// Open a store: its first publish, with the home page (FIRST_PUBLISH_NEEDS_HOME).
async function openStore(store, extra = []) {
  const home = await create(store, "home", { body: homeBody(extra) });
  published(await publishApi(store, home.id), `open ${store}`);
  return home;
}
const HOME = await openStore("ck");
await openStore("brand");

// =========================================================================================
console.log("— PUB-05: a link to an unpublished page offers to publish both");

await t("a page linking to an unpublished campaign is 422 LINKS_TO_UNPUBLISHED with a plain message and an offer naming both (revision, draftHash); sending the offer makes both live in one release; a target changed after the offer is 409 DOCUMENT_CHANGED", async () => {
  const camp = await create("ck", "campaign", { body: page("diwali", "Diwali sale", undefined, "campaign") });
  const linker = await create("ck", "page", { body: page("gifts", "Gifts", [textSec("sec_t1", "Gifts", "Words."), bannerTo("sec_bn1", urlLink("/campaigns/diwali"))]) });
  const before = await dump();
  const r = await publishApi("ck", linker.id);
  likeShape(r, shapeOf("linksToUnpublished"), "links to unpublished");
  eq(r.body.error, "This page links to Diwali sale, which isn't published yet.", "plain words:");
  const lc = await current("ck", linker.id);
  const cc = await current("ck", camp.id);
  eq(r.body.offer, { publishSet: [{ id: linker.id, revision: lc.revision, draftHash: lc.draftHash, label: "Gifts" }, { id: camp.id, revision: cc.revision, draftHash: cc.draftHash, label: "Diwali sale" }] }, "the offer:");
  const li = issuesOf(r, "LINKS_TO_UNPUBLISHED");
  eq(li.length, 1, "one link issue:");
  eq([li[0].sectionId, li[0].field, li[0].level, li[0].where, li[0].anchor], ["sec_bn1", "button.link", "blocks", "Banner · Button", "f-sec_bn1-button-link"], "where it is:");
  eq(li[0].actions, [{ type: "publishBoth", documentId: camp.id }, { type: "hideSection", documentId: linker.id, sectionId: "sec_bn1" }], "actions:");
  await unchanged(before, "the refusal");

  // the client sends the offer back as publishSet
  const ok2 = published(await api({ publishSet: r.body.offer.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) }), "the offer");
  eq(ok2.published.map((p) => p.id).sort(), [camp.id, linker.id].sort(), "both published:");
  const live = await pointerOf();
  eq(live.pointer, ok2.release.id, "one release:");
  eq(live.list.documents[camp.id]?.version, ok2.published.find((p) => p.id === camp.id).versionId, "the campaign is live:");
  eq(live.list.documents[linker.id]?.version, ok2.published.find((p) => p.id === linker.id).versionId, "the page is live:");
  eq((await sql("SELECT count(DISTINCT set_id) AS n FROM publish_log WHERE document_id IN (?, ?)", [camp.id, linker.id]))[0].n, 1, "one set:");

  // a second time: the target's draft changes after the offer
  const camp2 = await create("ck", "campaign", { body: page("holi", "Holi sale", undefined, "campaign") });
  const linker2 = await create("ck", "page", { body: page("colours", "Colours", [textSec("sec_t1", "Colours", "Words."), bannerTo("sec_bn1", pageLink("campaign", "holi"))]) });
  const r2 = await publishApi("ck", linker2.id);
  eq(r2.body.code, "LINKS_TO_UNPUBLISHED", "page link form:");
  await save("ck", camp2.id, page("holi", "Holi sale", [textSec("sec_t1", "Holi sale", "New words after the review.")], "campaign"));
  const before2 = await dump();
  const stale = await api({ publishSet: r2.body.offer.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) });
  eq([stale.status, stale.body.code], [409, "DOCUMENT_CHANGED"], "changed after the offer:");
  eq(stale.body.conflicts.map((c) => c.id), [camp2.id], "names the target:");
  likeShape(stale, shapeOf("changed"), "DOCUMENT_CHANGED");
  await unchanged(before2, "the stale offer");
});

await t("sending the offer runs the targets' own checks: a target with its own block gets the normal 422 naming it; an offline target is offered too; other blocks beside a link give VALIDATION_FAILED carrying the offer", async () => {
  const bad = await create("ck", "campaign", { body: page("broken-sale", "Broken sale", [textSec("sec_t1", "Broken sale", "Words."), sec("banner", "sec_empty", { title: "", text: "" })], "campaign") });
  const linker = await create("ck", "page", { body: page("to-broken", "To broken", [textSec("sec_t1", "To broken", "Words."), bannerTo("sec_bn1", urlLink("/campaigns/broken-sale"))]) });
  const r = await publishApi("ck", linker.id);
  eq(r.body.code, "LINKS_TO_UNPUBLISHED", "offered:");
  const r2 = await api({ publishSet: r.body.offer.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) });
  eq([r2.status, r2.body.code], [422, "VALIDATION_FAILED"], "the target's own block:");
  eq(r2.body.documents.map((d) => d.id), [bad.id], "names the target only:");
  ok(issuesOf(r2, "SECTION_EMPTY").some((i) => i.sectionId === "sec_empty" && i.level === "blocks"), "its empty banner blocks");
  likeShape(r2, shapeOf("validationFailed"), "422");

  // an offline page is not live: a link to it is offered (publishing it brings it back)
  const off = await create("ck", "page", { body: page("gone-quiet", "Gone quiet") });
  published(await publishApi("ck", off.id), "live first");
  await takeOffline("ck", off.id);
  const l2 = await create("ck", "page", { body: page("to-quiet", "To quiet", [textSec("sec_t1", "To quiet", "Words."), bannerTo("sec_bn1", urlLink("/policies/gone-quiet"))]) });
  const r3 = await publishApi("ck", l2.id);
  eq(r3.body.code, "LINKS_TO_UNPUBLISHED", "offline target:");
  eq(r3.body.offer.publishSet.map((x) => x.id), [l2.id, off.id], "offers the offline page:");

  // beside another block: VALIDATION_FAILED, with the offer for the link
  const l3 = await create("ck", "page", { body: page("two-problems", "Two problems", [textSec("sec_t1", "Two problems", "Words."), bannerTo("sec_bn1", urlLink("/campaigns/broken-sale")), sec("text", "sec_gap", { title: "", body: [] })]) });
  const r4 = await publishApi("ck", l3.id);
  eq([r4.status, r4.body.code], [422, "VALIDATION_FAILED"], "two kinds of block:");
  eq(r4.body.offer?.publishSet?.map((x) => x.id), [l3.id, bad.id], "the offer rides along:");
  likeShape(r4, shapeOf("validationFailed"), "422 with offer");
});

// =========================================================================================
console.log("— PUB-03: coverage");

await t("coverage: an image_with_text link to a missing page blocks; a product_rail on a deleted collection warns; a hero image whose media row is gone warns; an image with empty alt warns; a redirect_from equal to its own slug blocks; a link to a code-default policy slug passes", async () => {
  // image_with_text with a button to a page that doesn't exist
  const iwt = (id, link, alt = "A jar") => sec("image_with_text", id, { image: { media: "/api/media/med_hero1", alt }, title: "Look", button: { label: "Read", link } });
  const a = await create("ck", "page", { body: page("iwt-missing", "Iwt missing", [iwt("sec_iwt1", urlLink("/policies/no-such-page"))]) });
  const ra = await publishApi("ck", a.id);
  eq([ra.status, ra.body.code], [422, "VALIDATION_FAILED"], "a link to a missing page:");
  const miss = issuesOf(ra, "LINK_TARGET_MISSING");
  eq([miss.length, miss[0]?.sectionId, miss[0]?.field, miss[0]?.level, miss[0]?.where], [1, "sec_iwt1", "button.link", "blocks", "Image with text · Button"], "names it:");
  ok(/\/policies\/no-such-page/.test(miss[0].message) && !/[A-Z]{3,}_/.test(miss[0].message), `plain words: ${miss[0].message}`);
  eq(miss[0].actions, [{ type: "hideSection", documentId: a.id, sectionId: "sec_iwt1" }], "hide this section:");
  likeShape(ra, shapeOf("validationFailed"), "422");
  // the same link through a page link with its document id of an archived page blocks too
  const gone = await create("ck", "page", { body: page("soon-archived", "Soon archived") });
  await api({ archive: gone.id, revision: (await current("ck", gone.id)).revision });
  await save("ck", a.id, page("iwt-missing", "Iwt missing", [iwt("sec_iwt1", pageLink("page", "soon-archived", gone.id))]));
  eq(issuesOf(await publishApi("ck", a.id), "LINK_TARGET_MISSING").length, 1, "an archived target is missing:");

  // a product rail on a collection that was deleted: warns, publishes, removeSection
  const b = await create("ck", "page", { body: page("rail-gone", "Rail gone", [textSec("sec_t1", "Rail gone", "Words."), sec("product_rail", "sec_rail1", { collection: { handle: "deleted-shelf" } })]) });
  const rb = published(await publishApi("ck", b.id), "rail on a deleted collection");
  const cm = rb.issues.filter((i) => i.code === "COLLECTION_MISSING");
  eq([cm.length, cm[0]?.level, cm[0]?.severity, cm[0]?.where], [1, "warns", "warning", "Product rail · Collection"], "warns:");
  eq(cm[0].actions, [{ type: "removeSection", documentId: b.id, sectionId: "sec_rail1" }], "remove it:");
  checkIssues(rb.issues, "rail 200");
  // an empty collection warns; a stocked one is silent
  await save("ck", b.id, page("rail-gone", "Rail gone", [textSec("sec_t1", "Rail gone", "Words."), sec("product_rail", "sec_rail1", { collection: { handle: "empty-shelf" } }), sec("product_rail", "sec_rail2", { collection: { handle: "protein" } })]));
  const rb2 = published(await publishApi("ck", b.id), "rails");
  eq(rb2.issues.filter((i) => /^COLLECTION_/.test(i.code)).map((i) => [i.code, i.sectionId]), [["COLLECTION_EMPTY", "sec_rail1"]], "only the empty one:");

  // a hero image whose media row is gone: warns
  const h = await current("ck", HOME.id);
  await save("ck", HOME.id, { ...h.body, sections: h.body.sections.map((s) => (s.kind === "hero" ? { ...s, settings: { ...s.settings, image: { media: "/api/media/med_hero1", alt: "Our tubs" } } } : s)) });
  const rh = published(await publishApi("ck", HOME.id), "with the image");
  eq(rh.issues.filter((i) => i.code === "MEDIA_MISSING"), [], "the image is there:");
  await raw.ck.execute("DELETE FROM media WHERE id = 'med_hero1'");
  const h2 = await current("ck", HOME.id);
  await save("ck", HOME.id, { ...h2.body, sections: h2.body.sections.map((s) => (s.kind === "hero" ? { ...s, settings: { ...s.settings, title: "Live hero, fixed" } } : s)) });
  const rh2 = published(await publishApi("ck", HOME.id), "media gone");
  const mm = rh2.issues.filter((i) => i.code === "MEDIA_MISSING");
  eq([mm.length, mm[0]?.level, mm[0]?.sectionId, mm[0]?.field, mm[0]?.where], [1, "warns", "sec_hero", "image.media", "Hero · Image"], "media gone warns:");

  // an image with empty alt text: warns (PUB-03), where the validator would block
  const c = await create("ck", "page", { body: page("no-alt", "No alt", [iwt("sec_iwt2", urlLink("/collections"), "")]) });
  const rc = published(await publishApi("ck", c.id), "empty alt");
  const alt = rc.issues.filter((i) => i.field === "image.alt");
  eq([alt.length, alt[0]?.code, alt[0]?.level, alt[0]?.severity], [1, "REQUIRED", "warns", "warning"], "empty alt warns:");
  eq(R.validateDocument((await current("ck", c.id)).body, { mode: "publish" }).issues.find((i) => i.field === "image.alt")?.severity, "error", "(the validator alone would block it):");

  // a redirect_from equal to the page's own slug: blocks, removeItem
  const d = await create("ck", "page", { body: page("self-redirect", "Self redirect", undefined, "page", { redirect_from: ["old-self", "self-redirect"] }) });
  const rd = await publishApi("ck", d.id);
  eq([rd.status, rd.body.code], [422, "VALIDATION_FAILED"], "redirect to itself:");
  const rs = issuesOf(rd, "REDIRECT_SELF");
  eq([rs.length, rs[0]?.field, rs[0]?.where, rs[0]?.anchor], [1, "meta.redirect_from.1", "Page · Old addresses", "f-doc-meta-redirect_from-1"], "names the entry:");
  eq(rs[0].actions, [{ type: "removeItem", documentId: d.id, field: "meta.redirect_from", index: 1 }], "remove it:");

  // a link to a code-default policy slug passes on a store that shows them;
  // the same link on a store with no code defaults is a missing page
  const toShipping = (store) => create(store, "page", { body: page("ship-info", "Ship info", [textSec("sec_t1", "Ship info", "Words."), bannerTo("sec_bn1", urlLink("/policies/shipping"))]) });
  const e = await toShipping("brand");
  const re = published(await publishApi("brand", e.id), "a code-default policy page");
  eq(re.issues.filter((i) => /^LINK/.test(i.code)), [], "no link issue:");
  const e2 = await toShipping("ck");
  eq(issuesOf(await publishApi("ck", e2.id), "LINK_TARGET_MISSING").length, 1, "control: no code defaults there, so it's missing:");
});

await t("coverage, the rest: a link to a missing collection or product blocks; a hidden live page blocks; an old address a live page uses warns; a menu item to a missing page offers removeItem", async () => {
  const p = await create("ck", "page", {
    body: page("cat-links", "Cat links", [bannerTo("sec_b1", { type: "collection", handle: "no-such-collection" }), bannerTo("sec_b2", { type: "product", handle: "no-such-product" }), bannerTo("sec_b3", { type: "product", handle: "whey" })]),
  });
  const r = await publishApi("ck", p.id);
  eq([...issuesOf(r, "LINK_COLLECTION_MISSING"), ...issuesOf(r, "LINK_PRODUCT_MISSING")].map((i) => [i.code, i.sectionId, i.level]), [["LINK_COLLECTION_MISSING", "sec_b1", "blocks"], ["LINK_PRODUCT_MISSING", "sec_b2", "blocks"]], "missing catalog links block:");
  // a page the founder hid (meta.enabled false) is live but hidden: a link to it blocks
  const hidden = await create("ck", "page", { body: page("hidden-one", "Hidden one", undefined, "page", { enabled: false }) });
  published(await publishApi("ck", hidden.id), "hidden page live");
  const l = await create("ck", "page", { body: page("to-hidden", "To hidden", [bannerTo("sec_b1", urlLink("/policies/hidden-one"))]) });
  eq(issuesOf(await publishApi("ck", l.id), "LINK_TARGET_HIDDEN").map((i) => i.level), ["blocks"], "a hidden target:");
  // an old address that a live page already uses: warns
  const sh = await create("ck", "page", { body: page("shadowed", "Shadowed", undefined, "page", { redirect_from: ["gifts"] }) });
  const rs = published(await publishApi("ck", sh.id), "shadowed redirect");
  eq(rs.issues.filter((i) => i.code === "REDIRECT_SHADOWED").map((i) => [i.field, i.level, i.actions[0].type]), [["meta.redirect_from.0", "warns", "removeItem"]], "shadowed:");
  // two hidden pages whose old addresses point at each other. P3-FIX2: a
  // hidden page still holds its address (the storefront's page row wins over
  // an old address and answers "not found"), so each old address is shadowed
  // and shoppers are never sent round in a circle
  const lb = await create("ck", "page", { body: page("loop-b", "Loop b", undefined, "page", { enabled: false, redirect_from: ["loop-a"] }) });
  published(await publishApi("ck", lb.id), "loop b live, hidden");
  const la = await create("ck", "page", { body: page("loop-a", "Loop a", undefined, "page", { enabled: false, redirect_from: ["loop-b"] }) });
  const rl = published(await publishApi("ck", la.id), "loop a: shadowed, not a loop");
  eq(rl.issues.filter((i) => i.code === "REDIRECT_LOOP"), [], "no loop:");
  eq(rl.issues.filter((i) => i.code === "REDIRECT_SHADOWED").map((i) => [i.field, i.level, i.actions[0].type]), [["meta.redirect_from.0", "warns", "removeItem"]], "a hidden page's address shadows the old address:");
  // a header menu item to a missing page: blocks, and removeItem on the menu
  const header = await create("ck", "header", { body: body("header", { settings: { mode: "custom", items: [{ label: "Help", link: urlLink("/policies/help-missing") }] } }) });
  const rh = await publishApi("ck", header.id);
  const mi = issuesOf(rh, "LINK_TARGET_MISSING");
  eq([mi[0]?.field, mi[0]?.where], ["items.0.link", "Header menu · Menu items · item 1"], "the menu item:");
  eq(mi[0]?.actions, [{ type: "removeItem", documentId: header.id, field: "items", index: 0 }], "remove the item:");
});

// =========================================================================================
console.log("— PUB-03: scoped to the document");

await t("negative: a broken link in the dirty home draft does not stop publishing a policy page, and the publish reads no other document's draft", async () => {
  const h = await current("ck", HOME.id);
  await save("ck", HOME.id, { ...h.body, sections: [...h.body.sections, bannerTo("sec_brokenlink", urlLink("/policies/nowhere-at-all"))] });
  try {
    const pol = await create("ck", "page", { body: page("refunds", "Refunds") });
    const d = await current("ck", pol.id);
    const call = () => api({ publish: { id: pol.id, draftHash: d.draftHash }, revision: d.revision });
    const { result: r, statements } = await inT(() => watchStatements(currentDatabase().libsql, call));
    const out = published(r, "the policy page");
    eq(out.published.map((x) => x.id), [pol.id], "only the policy page:");
    eq(out.issues, [], "no issue from the home draft:");
    const draftReads = statements.filter((s) => /FROM documents/.test(s) && /\bdraft\b,/.test(s));
    eq(draftReads.length, 1, `one read of drafts, the set's own (${draftReads.join(" | ")}):`);
    ok(/WHERE id IN \(\?\)$/.test(draftReads[0]), `for the one document of the set: ${draftReads[0]}`);
    // and the home draft itself is refused for its own link
    eq(issuesOf(await publishApi("ck", HOME.id), "LINK_TARGET_MISSING").map((i) => i.sectionId), ["sec_brokenlink"], "the home page's own publish:");
  } finally {
    await save("ck", HOME.id, h.body);
  }
});

await t("negative: a deleted product only in a home list warns and does not block a hero typo publish (a test-only home section with a product list; no shipped home kind holds one yet)", async () => {
  R.defineSection({ kind: "fake_picks", version: 1, label: "Our picks", documentTypes: ["home"], settings: [{ key: "products", kind: "product_list", label: "Products", max: 8, default: [] }] });
  try {
    const h = await current("ck", HOME.id);
    const picks = sec("fake_picks", "sec_picks", { products: [{ handle: "whey" }, { handle: "deleted-in-shopify" }, { handle: "sold-out-bar" }] });
    await save("ck", HOME.id, { ...h.body, sections: [...h.body.sections, picks] });
    published(await publishApi("ck", HOME.id), "the list goes live first");
    const h2 = await current("ck", HOME.id);
    await save("ck", HOME.id, { ...h2.body, sections: h2.body.sections.map((s) => (s.kind === "hero" ? { ...s, settings: { ...s.settings, title: "Live hero, typo fixed" } } : s)) });
    const r = published(await publishApi("ck", HOME.id), "the hero typo");
    const pm = r.issues.filter((i) => i.sectionId === "sec_picks");
    eq(pm.map((i) => [i.code, i.level, i.field]), [["PRODUCT_MISSING", "warns", "products.1"], ["PRODUCT_UNAVAILABLE", "warns", "products.2"]], "warns:");
    eq(pm[0].actions, [{ type: "removeItem", documentId: HOME.id, sectionId: "sec_picks", field: "products", index: 1 }], "remove it:");
    eq(pm[0].where, "Our picks · Products · product 2", "where:");
    eq((await inT(() => Res.resolvedHero())).title, "Live hero, typo fixed", "the typo is live:");
  } finally {
    const h3 = await current("ck", HOME.id);
    await save("ck", HOME.id, { ...h3.body, sections: h3.body.sections.filter((s) => s.kind !== "fake_picks") });
    published(await publishApi("ck", HOME.id), "tidy");
    R.removeSection("fake_picks");
  }
});

// =========================================================================================
console.log("— PUB-03: inherited, and offline");

const migrated = (slug, extra = []) =>
  page(slug, "Migrated", [textSec("sec_t1", "Migrated", "Words."), sec("text", "sec_gap", { title: "", body: [] }), bannerTo("sec_oldlink", urlLink("/policies/long-gone")), ...extra]);

await t("a typo publish on a migrated-shape fixture whose untouched sections carry issues succeeds with those issues as level 'inherited'; the same issues on an offline page block", async () => {
  const d = await create("ck", "page", { body: page("migrated-one", "Migrated") });
  const old = migrated("migrated-one");
  await liveFixture("ck", d.id, old);
  await save("ck", d.id, { ...old, meta: { ...old.meta, title: "Migrated (typo fixed)" } });
  const r = published(await publishApi("ck", d.id), "typo on a migrated page");
  const inh = r.issues.filter((i) => i.sectionId === "sec_gap" || i.sectionId === "sec_oldlink");
  ok(inh.length >= 2, `both carried: ${JSON.stringify(r.issues)}`);
  for (const i of inh) eq([i.level, i.severity], ["inherited", "warning"], `${i.code}:`);
  ok(inh.some((i) => i.code === "LINK_TARGET_MISSING"), "the old broken link is inherited too");
  checkIssues(r.issues, "inherited 200");

  // the same page taken offline: nothing in it is live, so nothing is inherited
  await takeOffline("ck", d.id);
  const before = await dump();
  const off = await publishApi("ck", d.id, { confirmRepublish: true });
  eq([off.status, off.body.code], [422, "VALIDATION_FAILED"], "offline: they block:");
  // P4-ED05: the old banner's "doesn't show on this kind of page" note is a warning, never a block
  const blocks = off.body.issues.filter((i) => (i.sectionId === "sec_gap" || i.sectionId === "sec_oldlink") && i.code !== "SECTION_NOT_SHOWN");
  ok(blocks.length >= 2 && blocks.every((i) => i.level === "blocks"), `blocks: ${JSON.stringify(blocks.map((i) => [i.code, i.level]))}`);
  await unchanged(before, "offline refusal");
});

await t("P3-COMMIT pin: liveEntryOf counts an entry offline only when its row is enabled:false AND the document's pointer moved off that version; a page hidden with its own meta.enabled keeps the inherited rule", async () => {
  const list = { ...L.emptyList(1, []), documents: { doc_x: { version: "ver_a", hash: "h" } }, pages: [{ document: "doc_x", slug: "x", type: "page", enabled: false }] };
  const hiddenLive = B.liveEntryOf(list, null, { id: "doc_x", type: "page", publishedVersionId: "ver_a" });
  eq([hiddenLive.offline ?? false, hiddenLive.version], [false, "ver_a"], "pointer on the version: hidden, still live:");
  const offline = B.liveEntryOf(list, null, { id: "doc_x", type: "page", publishedVersionId: null });
  eq([offline.offline, offline.liveBody], [true, null], "pointer moved off: offline:");
  // service level: a hidden live page with an inherited gap publishes a typo
  const d = await create("ck", "page", { body: page("hidden-migrated", "Migrated") });
  const old = { ...migrated("hidden-migrated"), meta: { ...migrated("hidden-migrated").meta, enabled: false } };
  await liveFixture("ck", d.id, old);
  await save("ck", d.id, { ...old, meta: { ...old.meta, title: "Hidden (typo fixed)" } });
  const r = published(await publishApi("ck", d.id), "typo on a hidden live page");
  ok(r.issues.filter((i) => i.sectionId === "sec_gap").every((i) => i.level === "inherited"), "still inherited");
});

// =========================================================================================
console.log("— PUB-03: every issue says where, how bad, and what to do");

await t("every issue in a 422 has level, anchor, where and at least one action; hideSection, then saveDraft, then publish succeeds (service-level replay)", async () => {
  const d = await create("ck", "page", {
    body: page("many-problems", "Many problems", [
      textSec("sec_ok", "Fine", "Fine words."),
      sec("banner", "sec_empty", { title: "", text: "" }),
      bannerTo("sec_link", urlLink("/policies/not-here")),
      sec("product_rail", "sec_rail", { collection: { handle: "deleted-shelf" } }),
      sec("text", "sec_long", { title: "x".repeat(130), body: ["Words."] }),
    ], "page", { redirect_from: ["many-problems"] }),
  });
  const r = await publishApi("ck", d.id);
  eq([r.status, r.body.code], [422, "VALIDATION_FAILED"], "refused:");
  checkIssues(r.body.issues, "422");
  ok(r.body.issues.length >= 5, `several issues: ${r.body.issues.length}`);
  ok(r.body.issues.some((i) => i.level === "warns") && r.body.issues.some((i) => i.level === "blocks"), "both levels");
  const doc = await current("ck", d.id);
  // replay the founder's clicks: each section-level block's hideSection, and removeItem for the redirect
  let b = doc.body;
  for (const i of r.body.issues.filter((x) => x.level === "blocks")) {
    for (const a of i.actions) {
      if (a.type === "hideSection") b = { ...b, sections: b.sections.map((s) => (s.id === a.sectionId ? { ...s, enabled: false } : s)) };
      if (a.type === "removeItem" && a.field === "meta.redirect_from") b = { ...b, meta: { ...b.meta, redirect_from: b.meta.redirect_from.filter((_, j) => j !== a.index) } };
    }
  }
  const saved = await api({ saveDraft: { id: d.id, body: b }, revision: doc.revision });
  eq(saved.status, 200, "saveDraft:");
  const r2 = published(await publishApi("ck", d.id), "after the actions");
  ok(r2.issues.some((i) => i.sectionId === "sec_empty" && i.level === "warns" && /hidden/.test(i.message)), "the hidden one now only warns");
  checkIssues(r2.issues, "200");
  const liveIds = (await inT(() => Res.resolvedContentPage("many-problems"))).sections.map((s) => s.id);
  ok(liveIds.includes("sec_ok") && !liveIds.includes("sec_empty") && !liveIds.includes("sec_link"), `the hidden sections aren't live: ${liveIds}`);
});

await t("doc-level and structure issues get an action too: a missing title and HOME_EMPTY open the field; a structure block in a section offers removeSection, never hideSection", async () => {
  const d = await create("ck", "page", { body: page("no-title-yet", "") });
  const r = await publishApi("ck", d.id);
  const title = r.body.issues.find((i) => i.field === "meta.title");
  eq([title.level, title.where, title.anchor], ["blocks", "Page · Title", "f-doc-meta-title"], "the title:");
  eq(title.actions, [{ type: "openField", documentId: d.id, field: "meta.title" }], "open the field:");
  const h = await current("ck", HOME.id);
  await save("ck", HOME.id, { ...h.body, sections: h.body.sections.map((s) => ({ ...s, enabled: false })) });
  const he = await publishApi("ck", HOME.id);
  const empty = issuesOf(he, "HOME_EMPTY")[0];
  eq([empty.level, empty.actions[0].type], ["blocks", "openField"], "HOME_EMPTY:");
  checkIssues(he.body.issues, "home 422");
  await save("ck", HOME.id, h.body);
  // a structure problem (written past validation, as a migrated row could be)
  const st = await create("ck", "page", { body: page("structure-one", "Structure one") });
  const sb = { ...page("structure-one", "Structure one"), sections: [{ ...textSec("sec_t1", "Structure one", "Words."), settings: { title: "Structure one", body: ["Words."], sparkle: true } }] };
  await raw.ck.execute({ sql: "UPDATE documents SET draft = ?, draft_hash = ?, revision = revision + 1 WHERE id = ?", args: [JSON.stringify(sb), await R.documentHash(sb), st.id] });
  const sr = await publishApi("ck", st.id);
  const uf = issuesOf(sr, "UNKNOWN_FIELD")[0];
  eq(uf.actions, [{ type: "removeSection", documentId: st.id, sectionId: "sec_t1" }], "structure: remove, not hide:");
});

// =========================================================================================
console.log("— PUB-04: publish again after take offline");

await t("after take-offline (an undone_version_id whose stored body has other section ids), the same content is 409 REPUBLISH_CONFIRM_NEEDED; with confirmRepublish it is live and undone_version_id is null; a changed body publishes with no confirm and clears it too", async () => {
  const d = await create("ck", "page", { body: page("offline-again", "Offline again") });
  const first = published(await publishApi("ck", d.id), "live");
  await takeOffline("ck", d.id);
  // the fixture: the version taken offline holds the same content under other section ids
  const draft = (await current("ck", d.id)).body;
  const reIded = { ...draft, sections: draft.sections.map((s) => ({ ...s, id: "sec_otherid1" })) };
  const v = await versionRow({ documentId: d.id, kind: "published", body: reIded, schemaVersion: 1, createdAt: new Date().toISOString() });
  await raw.ck.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [v.id, d.id, "published", v.body, v.body_hash, 1, null, null, v.created_at] });
  await raw.ck.execute({ sql: "UPDATE documents SET undone_version_id = ? WHERE id = ?", args: [v.id, d.id] });
  const cur = await current("ck", d.id);
  ok(cur.draftHash !== v.body_hash, "the version's body_hash differs from the draft hash (ids kept)");
  eq(await R.documentHash(reIded), cur.draftHash, "documentHash is the same content:");
  ok(first.published[0].versionId !== v.id, "a different version than the one first published");

  const before = await dump();
  const r = await publishApi("ck", d.id);
  likeShape(r, shapeOf("republishConfirmNeeded"), "republish");
  eq([r.body.error, r.body.id], ["You took this page offline. Publish the same content again?", d.id], "words:");
  await unchanged(before, "the confirm");
  const yes = published(await publishApi("ck", d.id, { confirmRepublish: true }), "confirmed");
  eq(yes.published.map((x) => x.id), [d.id], "live:");
  const row = (await sql("SELECT undone_version_id, published_version_id FROM documents WHERE id = ?", [d.id]))[0];
  eq([row.undone_version_id, row.published_version_id], [null, yes.published[0].versionId], "undone cleared:");
  eq((await inT(() => Res.resolvedContentPage("offline-again"))).title, "Offline again", "shoppers see it again:");

  // a changed body after take offline needs no confirm, and clears undone too
  // (the plain publish rule, pinned)
  await takeOffline("ck", d.id);
  ok((await current("ck", d.id)).undoneVersionId, "offline again");
  await save("ck", d.id, page("offline-again", "Offline again", [textSec("sec_t1", "Offline again", "New words.")]));
  const changed = published(await publishApi("ck", d.id), "changed body");
  eq(changed.published.map((x) => x.id), [d.id], "live with no confirm:");
  eq((await sql("SELECT undone_version_id FROM documents WHERE id = ?", [d.id]))[0].undone_version_id, null, "a plain publish clears undone_version_id:");
});

await t("the P22 skip rule: a document whose hash equals publishedHash but whose live entry points to another version is not skipped", async () => {
  const d = await create("ck", "page", { body: page("p22", "P22") });
  const first = published(await publishApi("ck", d.id), "live");
  // the list moves to another version (a migrated write, as a restore could)
  const other = page("p22", "P22", [textSec("sec_t1", "P22", "Other words.")]);
  await liveFixture("ck", d.id, other);
  const listed = (await pointerOf()).list.documents[d.id].version;
  ok(listed !== first.published[0].versionId, "the list points elsewhere");
  // the documents row says the first version, with the draft's hash
  const cur = await current("ck", d.id);
  await raw.ck.execute({ sql: "UPDATE documents SET published_version_id = ?, published_hash = ? WHERE id = ?", args: [first.published[0].versionId, cur.draftHash, d.id] });
  const r = published(await publishApi("ck", d.id), "not skipped");
  eq([r.skipped, r.published.map((x) => x.id)], [[], [d.id]], "published, not skipped:");
  eq((await inT(() => Res.resolvedContentPage("p22"))).sections[0].body, ["Some words."], "the draft is what shoppers see:");
  // and the ordinary case is still skipped
  const again = published(await publishApi("ck", d.id), "again");
  eq(again.skipped, [d.id], "already live: skipped:");
});

// =========================================================================================
console.log("— PUB-06: the first publish opens the store with its home page");

await t("on a closed store, publishing a policy alone is 409 FIRST_PUBLISH_NEEDS_HOME with an offer adding doc_home; publishing home alone, or home with the policy, opens the store", async () => {
  for (const store of ["closed1", "closed2", "closed3"]) {
    eq((await inT(() => Res.contentSource(), store)).mode, "closed", `${store} starts closed:`);
  }
  const home1 = await create("closed1", "home", { body: homeBody([], "Opening home") });
  const pol1 = await create("closed1", "page", { body: page("privacy", "Privacy") });
  const before = await dump("closed1");
  const r = await publishApi("closed1", pol1.id);
  likeShape(r, shapeOf("firstPublishNeedsHome"), "needs home");
  eq(r.body.error, "Publish your home page with this, so the store opens with a home page.", "words:");
  eq(r.body.offer, { publishSet: [{ id: pol1.id, revision: pol1.revision, draftHash: pol1.draftHash, label: "Privacy" }, { id: "doc_home", revision: home1.revision, draftHash: home1.draftHash, label: home1.label }] }, "the offer:");
  await unchanged(before, "needs home", "closed1");
  // the offer, sent back, opens the store with both
  const both = published(await api({ publishSet: r.body.offer.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) }, { store: "closed1" }), "home with the policy");
  eq(both.published.map((x) => x.id).sort(), ["doc_home", pol1.id].sort(), "both:");
  eq((await inT(() => Res.contentSource(), "closed1")).mode !== "closed", true, "open:");
  eq((await inT(() => Res.resolvedHero(), "closed1")).title, "Opening home", "the home page is live:");
  // home alone opens the store
  await create("closed2", "home", { body: homeBody([], "Home alone") });
  published(await publishApi("closed2", "doc_home"), "home alone");
  eq((await inT(() => Res.contentSource(), "closed2")).mode !== "closed", true, "open:");
  // home with the policy in one publishSet
  await create("closed3", "home", { body: homeBody([], "Home and policy") });
  const pol3 = await create("closed3", "page", { body: page("terms", "Terms") });
  published(await publishSetApi("closed3", [pol3.id, "doc_home"]), "home with a policy");
  eq((await inT(() => Res.resolvedContentPage("terms"), "closed3")).title, "Terms", "the policy is live:");
  // and once open, a policy alone is fine
  const pol3b = await create("closed3", "page", { body: page("returns-x", "Returns") });
  published(await publishApi("closed3", pol3b.id), "open store, policy alone");
});

await t("a closed store with no home page document yet: FIRST_PUBLISH_NEEDS_HOME with offer null and words that say what to do", async () => {
  const pol = await create("nohome", "page", { body: page("privacy", "Privacy") });
  const r = await publishApi("nohome", pol.id);
  likeShape(r, shapeOf("firstPublishNoHome"), "no home");
  eq(r.body.offer, null, "nothing to offer:");
  eq(r.body.error, shapeOf("firstPublishNoHome").body.error, "words:");
});

// =========================================================================================
console.log("— PUB-11: see it live, and undo it");

await t("every publish response item has liveUrl starting '/api/preview?exit=1&to=' with no token and undo {id, revision, logId} matching the new log row; responses match documents-api-shapes.js keys", async () => {
  const pg = await create("ck", "page", { body: page("live-url-page", "Live url page") });
  const cp = await create("ck", "campaign", { body: page("live-url-camp", "Live url camp", undefined, "campaign") });
  const jp = await create("ck", "journal", { body: page("live-url-post", "Live url post", undefined, "journal") });
  const ab = await create("ck", "page", { body: page("about", "About us") });
  const h = await current("ck", HOME.id);
  await save("ck", HOME.id, { ...h.body, sections: h.body.sections.map((s) => (s.kind === "hero" ? { ...s, settings: { ...s.settings, title: "Hero for urls" } } : s)) });
  const r = await publishSetApi("ck", [pg.id, cp.id, jp.id, ab.id, HOME.id]);
  likeShape(r, shapeOf("ok"), "publish 200");
  const want = { [pg.id]: "/policies/live-url-page", [cp.id]: "/campaigns/live-url-camp", [jp.id]: "/journal/live-url-post", [ab.id]: "/about", [HOME.id]: "/" };
  for (const item of r.body.published) {
    ok(item.liveUrl.startsWith("/api/preview?exit=1&to="), `liveUrl ${item.liveUrl}`);
    ok(!/token/i.test(item.liveUrl), "no token");
    eq(decodeURIComponent(item.liveUrl.slice("/api/preview?exit=1&to=".length)), want[item.id], `${item.id} goes to:`);
    const [log] = await sql("SELECT id FROM publish_log WHERE set_id = ? AND document_id = ?", [r.body.setId, item.id]);
    const doc = await current("ck", item.id);
    eq(item.undo, { id: item.id, revision: doc.revision, logId: log.id }, `${item.id} undo:`);
  }
  eq(r.body.published.length, 5, "every item:");
});

await t("the publish conflicts name who changed it: current.updatedBy and current.updatedByName ('another tab' for the same person); the shapes' keys", async () => {
  const d = await create("ck", "page", { body: page("who-changed", "Who changed") });
  const seen = await current("ck", d.id);
  await save("ck", d.id, page("who-changed", "Who changed", [textSec("sec_t1", "Who changed", "Staff words.")]), { as: STAFF });
  const r = await api({ publish: { id: d.id, draftHash: seen.draftHash }, revision: seen.revision });
  likeShape(r, shapeOf("changed"), "DOCUMENT_CHANGED");
  eq([r.body.current.updatedBy, r.body.current.updatedByName], [`merchant:${staffU.id}`, "Ravi"], "named:");
  eq([r.body.conflicts[0].current.updatedBy, r.body.conflicts[0].current.updatedByName], [`merchant:${staffU.id}`, "Ravi"], "in the conflict too:");
  // the same person in another tab
  const seen2 = await current("ck", d.id);
  await save("ck", d.id, page("who-changed", "Who changed", [textSec("sec_t1", "Who changed", "Owner words.")]));
  const r2 = await api({ publish: { id: d.id, draftHash: seen2.draftHash }, revision: seen2.revision });
  eq(r2.body.current.updatedByName, "another tab", "the same person:");
  // DRAFT_CHANGED: the revision matches, the reviewed hash doesn't
  const cur = await current("ck", d.id);
  const r3 = await api({ publish: { id: d.id, draftHash: "h_not_reviewed" }, revision: cur.revision });
  likeShape(r3, shapeOf("draftChanged"), "DRAFT_CHANGED");
  eq(r3.body.current.updatedByName, "another tab", "named:");
});

await t("PUBLISHED_ELSEWHERE on a lost race names who published, and matches the shapes", async () => {
  const d = await create("ck", "page", { body: page("race-who", "Race who") });
  published(await publishApi("ck", d.id), "live");
  await save("ck", d.id, page("race-who", "Race who", [textSec("sec_t1", "Race who", "Mine.")]));
  let landed = false;
  Pub.setPublishHooks({
    beforeCommit: async () => {
      if (landed) return;
      landed = true;
      // someone else's publish of the same document lands first (a migrated-style write)
      await liveFixture("ck", d.id, page("race-who", "Race who", [textSec("sec_t1", "Race who", "Theirs.")]));
      await raw.ck.execute({ sql: "UPDATE documents SET updated_by = ? WHERE id = ?", args: [`merchant:${staffU.id}`, d.id] });
    },
  });
  const r = await publishApi("ck", d.id);
  Pub.setPublishHooks({});
  likeShape(r, shapeOf("publishedElsewhere"), "PUBLISHED_ELSEWHERE");
  eq(r.body.current.updatedByName, "Ravi", "named:");
});

// =========================================================================================
console.log("— TOK-03: the design document blocks only changed colour pairs");

const design = (brand, theme = { kit: "pulse", version: 1 }) => body("design", { settings: { brand, theme } });
const UNREADABLE = { accent: "#ffff00", background: "#ffffff", foreground: "#fefefe" };

await t("design publish blocks only when a changed token pair fails contrast; an unchanged failing pair is inherited", async () => {
  await openStore("design");
  const d = await create("design", "design", { body: design({ ...UNREADABLE }) });
  // a changed failing pair (the live store shows the platform default): blocks
  const r = await publishApi("design", d.id);
  eq([r.status, r.body.code], [422, "VALIDATION_FAILED"], "a changed pair:");
  const un = issuesOf(r, "BRAND_UNREADABLE");
  ok(un.length >= 1 && un.every((i) => i.level === "blocks" && i.where.startsWith("Brand")), `blocks: ${JSON.stringify(un.map((i) => [i.level, i.where]))}`);
  checkIssues(r.body.issues, "design 422");
  // the same failing colours already live (a migrated design): a change of
  // another token publishes, and the unchanged failing pairs are inherited
  await liveFixture("design", d.id, design({ ...UNREADABLE }));
  await save("design", d.id, design({ ...UNREADABLE, radius: "lg" }));
  const ok2 = published(await publishApi("design", d.id), "radius only");
  const inh = ok2.issues.filter((i) => i.code === "BRAND_HARD_TO_READ");
  ok(inh.length >= 1 && inh.every((i) => i.level === "inherited" && i.severity === "warning"), `inherited: ${JSON.stringify(ok2.issues.map((i) => [i.code, i.level]))}`);
  eq(ok2.issues.filter((i) => i.code === "BRAND_UNREADABLE"), [], "nothing blocks:");
  // changing a failing colour to another failing one is a changed pair: blocks
  await save("design", d.id, design({ ...UNREADABLE, radius: "lg", foreground: "#fdfdfd" }));
  const r3 = await publishApi("design", d.id);
  eq([r3.status, issuesOf(r3, "BRAND_UNREADABLE")[0]?.level], [422, "blocks"], "a changed failing colour:");
});

// =========================================================================================
console.log("— P3-COMMIT review pins");

await t("P3-COMMIT pin: draftSlugOwner ignores an archived document holding the slug (the 'AND archived_at IS NULL' term)", async () => {
  const a = await create("ck", "page", { body: page("archived-holder", "Archived holder") });
  const ar = await api({ archive: a.id, revision: (await current("ck", a.id)).revision });
  eq(ar.status, 200, "archived:");
  eq((await sql("SELECT slug, archived_at IS NOT NULL AS archived FROM documents WHERE id = ?", [a.id]))[0], { slug: "archived-holder", archived: 1 }, "it still holds the slug in its row:");
  eq(await inT(() => B.draftSlugOwner("archived-holder", "doc_someoneelse")), null, "an archived holder doesn't count:");
  const b = await create("ck", "page", { body: page("archived-holder", "New holder") });
  eq(await inT(() => B.draftSlugOwner("archived-holder", "doc_someoneelse")), { id: b.id, label: "New holder" }, "the live draft is named:");
});

await t("P3-COMMIT pin: commit.js passes build.versions (never extraVersions) to liveListHoldsMine at its one call site", async () => {
  const src = await readFile(join(ROOT, "lib/documents/commit.js"), "utf8");
  const calls = [...src.matchAll(/liveListHoldsMine\(([^)]*)\)/g)].map((m) => m[1].trim()).filter((a) => !/^buildList, liveList, versions$/.test(a));
  eq(calls, ["buildList, back.list, versions"], "the call site:");
  const fn = src.slice(src.indexOf("export async function commitPublishBatch("));
  const decl = /const versions = ([^;]+);/.exec(fn);
  eq(decl?.[1], "build.versions || []", "versions is build.versions:");
  ok(!/extraVersions/.test(fn.slice(0, fn.indexOf("liveListHoldsMine("))), "extraVersions is never in reach of the call");
});

// =========================================================================================
console.log("— P3-FIX2: links by id, old addresses, hidden holders, the set applied, menus");

const rename = async (store, id, slug, title, type = "page", meta = {}) => {
  await save(store, id, page(slug, title, undefined, type, meta));
  return published(await publishApi(store, id), `rename to ${slug}`);
};

await t("P3-FIX2: a link by document id to a page renamed with no old address that forwards is LINK_TARGET_MISSING naming the new address (alone, and inside one set); a page's old address doesn't forward, a journal post's does", async () => {
  // renamed and published: the link still carries the old slug
  const moved = await create("ck", "page", { body: page("moves", "Moves") });
  published(await publishApi("ck", moved.id), "moves live");
  await rename("ck", moved.id, "moved", "Moves");
  const a = await create("ck", "page", { body: page("to-moves", "To moves", [textSec("sec_t1", "To moves", "Words."), bannerTo("sec_bn1", pageLink("page", "moves", moved.id))]) });
  const before = await dump();
  const r = await publishApi("ck", a.id);
  eq([r.status, r.body.code], [422, "VALIDATION_FAILED"], "a stale link by id blocks:");
  const m = issuesOf(r, "LINK_TARGET_MISSING");
  eq([m.length, m[0]?.sectionId, m[0]?.level], [1, "sec_bn1", "blocks"], "names it:");
  eq(m[0].message, "This link goes to /policies/moves, but “Moves” is at /policies/moved now, so shoppers who click it get “not found”. Choose the page again so the link uses its new address.", "the words:");
  likeShape(r, shapeOf("validationFailed"), "422");
  await unchanged(before, "the refusal");
  // chosen again (the new slug): it passes
  await save("ck", a.id, page("to-moves", "To moves", [textSec("sec_t1", "To moves", "Words."), bannerTo("sec_bn1", pageLink("page", "moved", moved.id))]));
  eq(published(await publishApi("ck", a.id), "the new address").issues.filter((i) => /^LINK/.test(i.code)), [], "no link issue:");

  // inside one set: B renamed in the same publish as A, which links to B's old slug by id
  const b = await create("ck", "page", { body: page("b-before", "B page") });
  published(await publishApi("ck", b.id), "b live");
  await save("ck", b.id, page("b-after", "B page"));
  const a2 = await create("ck", "page", { body: page("to-b", "To b", [textSec("sec_t1", "To b", "Words."), bannerTo("sec_bn1", pageLink("page", "b-before", b.id))]) });
  const rs = await publishSetApi("ck", [a2.id, b.id]);
  eq([rs.status, rs.body.code], [422, "VALIDATION_FAILED"], "in one set:");
  ok(issuesOf(rs, "LINK_TARGET_MISSING").some((i) => i.documentId === a2.id && /\/policies\/b-after/.test(i.message)), `names the new address: ${JSON.stringify(rs.body.issues.map((i) => i.message))}`);

  // a page's old address (redirect_from) doesn't forward /policies/<old>: still blocked, and the words say why
  await save("ck", b.id, page("b-after", "B page", undefined, "page", { redirect_from: ["b-before"] }));
  const rs2 = await publishSetApi("ck", [a2.id, b.id]);
  eq(rs2.status, 422, "a page's old address doesn't forward:");
  ok(issuesOf(rs2, "LINK_TARGET_MISSING").some((i) => /Old addresses only forward shoppers on journal posts/.test(i.message)), "says only posts forward");

  // a journal post renamed with its old address: a link by id to the old slug passes, alone and in one set
  const post = await create("ck", "journal", { body: page("old-post", "Old post", undefined, "journal") });
  published(await publishApi("ck", post.id), "post live");
  await save("ck", post.id, page("new-post", "Old post", undefined, "journal", { redirect_from: ["old-post"] }));
  const a3 = await create("ck", "page", { body: page("to-post", "To post", [textSec("sec_t1", "To post", "Words."), bannerTo("sec_bn1", pageLink("journal", "old-post", post.id))]) });
  const rs3 = published(await publishSetApi("ck", [a3.id, post.id]), "renamed post with its old address, in one set");
  eq(rs3.issues.filter((i) => /^LINK/.test(i.code)), [], "the old address forwards:");
  // and alone, after: the live redirect covers it
  await save("ck", a3.id, page("to-post", "To post", [textSec("sec_t1", "To post (again)", "Words."), bannerTo("sec_bn1", pageLink("journal", "old-post", post.id))]));
  eq(published(await publishApi("ck", a3.id), "alone").issues.filter((i) => /^LINK/.test(i.code)), [], "alone, the live redirect covers it:");
  // the post renamed again with no old address kept: the link by id blocks
  await rename("ck", post.id, "newer-post", "Old post", "journal");
  await save("ck", a3.id, page("to-post", "To post", [textSec("sec_t1", "To post (third)", "Words."), bannerTo("sec_bn1", pageLink("journal", "old-post", post.id))]));
  eq(issuesOf(await publishApi("ck", a3.id), "LINK_TARGET_MISSING").length, 1, "no forwarding old address left:");
});

await t("P3-FIX2: a link to an old address that a live redirect covers passes (/journal/<old>); /policies/<old> with a redirect is still missing; a link to a live journal post passes (needJournal)", async () => {
  const post = await create("ck", "journal", { body: page("first-name", "Renamed post", undefined, "journal") });
  published(await publishApi("ck", post.id), "post live");
  await rename("ck", post.id, "second-name", "Renamed post", "journal", { redirect_from: ["first-name"] });
  const l = await create("ck", "page", { body: page("to-old-addr", "To old addr", [textSec("sec_t1", "To old addr", "Words."), bannerTo("sec_bn1", urlLink("/journal/first-name")), bannerTo("sec_bn2", urlLink("/journal/second-name"))]) });
  const r = published(await publishApi("ck", l.id), "links to an old and a live post address");
  eq(r.issues.filter((i) => /^LINK/.test(i.code)), [], "both pass:");
  // a page with an old address: /policies/<old> isn't forwarded, so it stays missing
  const pg = await create("ck", "page", { body: page("new-addr", "New addr", undefined, "page", { redirect_from: ["old-addr"] }) });
  published(await publishApi("ck", pg.id), "page with old address");
  const l2 = await create("ck", "page", { body: page("to-old-page", "To old page", [textSec("sec_t1", "To old page", "Words."), bannerTo("sec_bn1", urlLink("/policies/old-addr"))]) });
  eq(issuesOf(await publishApi("ck", l2.id), "LINK_TARGET_MISSING").length, 1, "/policies/<old> isn't forwarded:");
});

await t("P3-FIX2: an old address held by a hidden live page warns REDIRECT_SHADOWED (the hidden row wins on the storefront and answers 'not found')", async () => {
  const hid = await create("ck", "page", { body: page("hidden-holder", "Hidden holder", undefined, "page", { enabled: false }) });
  published(await publishApi("ck", hid.id), "hidden holder live");
  const p = await create("ck", "page", { body: page("wants-hidden", "Wants hidden", undefined, "page", { redirect_from: ["hidden-holder"] }) });
  const r = published(await publishApi("ck", p.id), "shadowed by a hidden page");
  const sh = r.issues.filter((i) => i.code === "REDIRECT_SHADOWED");
  eq(sh.map((i) => [i.field, i.level, i.actions[0].type]), [["meta.redirect_from.0", "warns", "removeItem"]], "warns:");
  ok(/hidden from shoppers or offline/.test(sh[0].message), `the words: ${sh[0].message}`);
  // on the storefront, the hidden row wins: the old address forwards nowhere
  eq(await inT(() => Res.resolvedSlugRedirect("hidden-holder")), null, "(resolve.js agrees: no redirect)");
  checkIssues(r.issues, "200");
});

await t("P3-FIX2 pin: the checks read M2, the live list with the set applied (the set's own rows replace its documents' list rows)", async () => {
  // the set hides B while A links to it: blocked as hidden
  const b = await create("ck", "page", { body: page("m2-b", "M2 b") });
  published(await publishApi("ck", b.id), "b live");
  await save("ck", b.id, page("m2-b", "M2 b", undefined, "page", { enabled: false }));
  const a = await create("ck", "page", { body: page("m2-a", "M2 a", [textSec("sec_t1", "M2 a", "Words."), bannerTo("sec_bn1", urlLink("/policies/m2-b"))]) });
  const r = await publishSetApi("ck", [a.id, b.id]);
  eq(issuesOf(r, "LINK_TARGET_HIDDEN").map((i) => [i.documentId, i.level]), [[a.id, "blocks"]], "the set hides b:");
  // the set renames B while A links to its old url: blocked
  await save("ck", b.id, page("m2-b2", "M2 b"));
  const r2 = await publishSetApi("ck", [a.id, b.id]);
  eq(issuesOf(r2, "LINK_TARGET_MISSING").map((i) => i.documentId), [a.id], "the set renames b:");
});

await t("P3-FIX2: an unchanged header menu item to a page taken offline is inherited as a warning that says 'menu'; a new menu item to an offline page blocks with menu words; a footer says footer", async () => {
  const tgt = await create("ck", "page", { body: page("menu-tgt", "Menu tgt") });
  published(await publishApi("ck", tgt.id), "menu target live");
  const header = await current("ck", "doc_header");
  await save("ck", header.id, body("header", { settings: { mode: "custom", items: [{ label: "Help", link: urlLink("/policies/menu-tgt") }] } }));
  published(await publishApi("ck", header.id), "header live with the item");
  await takeOffline("ck", tgt.id);
  // only an unrelated item added: publishes, the old item is inherited
  await save("ck", header.id, body("header", { settings: { mode: "custom", items: [{ label: "Help", link: urlLink("/policies/menu-tgt") }, { label: "Shop", link: urlLink("/collections") }] } }));
  const r = published(await publishApi("ck", header.id), "an unrelated item added");
  const inh = r.issues.filter((i) => i.code === "LINKS_TO_UNPUBLISHED");
  eq(inh.map((i) => [i.field, i.level, i.severity]), [["items.0.link", "inherited", "warning"]], "inherited:");
  eq(inh[0].message, "Your header menu links to Menu tgt, which isn't published yet. It was already live like this, so it doesn't stop publishing.", "the words say menu:");
  ok(!/This page/.test(inh[0].message), "not 'page'");
  eq(inh[0].actions, [{ type: "removeItem", documentId: header.id, field: "items", index: 0 }], "it can still be removed:");
  checkIssues(r.issues, "inherited menu 200");
  // a new item to another offline page blocks, with menu words, and offers both
  const tgt2 = await create("ck", "page", { body: page("menu-tgt2", "Menu tgt two") });
  published(await publishApi("ck", tgt2.id), "second target live");
  await takeOffline("ck", tgt2.id);
  await save("ck", header.id, body("header", { settings: { mode: "custom", items: [{ label: "Help", link: urlLink("/policies/menu-tgt") }, { label: "Shop", link: urlLink("/collections") }, { label: "New", link: urlLink("/policies/menu-tgt2") }] } }));
  const r2 = await publishApi("ck", header.id);
  likeShape(r2, shapeOf("linksToUnpublished"), "a new menu item");
  eq(r2.body.error, "Your header menu links to Menu tgt two, which isn't published yet.", "the answer's words:");
  const nb = issuesOf(r2, "LINKS_TO_UNPUBLISHED");
  eq(nb.map((i) => [i.field, i.level]), [["items.0.link", "inherited"], ["items.2.link", "blocks"]], "old inherited, new blocks:");
  eq(r2.body.offer.publishSet.map((x) => x.id), [header.id, tgt2.id], "offers the new target only:");
  // a footer's menu says footer (and a fresh footer has nothing live, so nothing is inherited)
  const footer = await current("ck", "doc_footer").catch(() => null) || (await create("ck", "footer"));
  await save("ck", footer.id, body("footer", { settings: { mode: "custom", items: [{ label: "Help", link: urlLink("/policies/menu-tgt") }] } }));
  const rf = await publishApi("ck", footer.id);
  eq(rf.body.error, "Your footer menu links to Menu tgt, which isn't published yet.", "footer words:");
  // the words' lead, on its own
  eq([Checks.linkLead("header", null, "x"), Checks.linkLead("announcement", null, "x"), Checks.linkLead("header", "sec_1", "x"), Checks.linkLead("page", null, "x")], ["Your header menu links to", "Your announcement bar links to", "x", "x"], "linkLead:");
});

await t("P3-FIX2 fix 1: an unchanged menu item is not inherited when this same set is what breaks it (the set hides its page, or renames it by id or by address); an announcement bar too", async () => {
  const header = await current("ck", "doc_header");
  const menu = (items) => body("header", { settings: { mode: "custom", items } });
  // hidden inside the set
  const x = await create("ck", "page", { body: page("rv-x", "Rv x") });
  published(await publishApi("ck", x.id), "x live");
  await save("ck", header.id, menu([{ label: "X", link: urlLink("/policies/rv-x") }]));
  published(await publishApi("ck", header.id), "header live with the x item");
  await save("ck", header.id, menu([{ label: "X", link: urlLink("/policies/rv-x") }, { label: "Shop", link: urlLink("/collections") }]));
  await save("ck", x.id, page("rv-x", "Rv x", undefined, "page", { enabled: false }));
  let before = await dump();
  const r = await publishSetApi("ck", [header.id, x.id]);
  eq([r.status, r.body.code], [422, "VALIDATION_FAILED"], `the set hides x: ${JSON.stringify((r.body.issues || []).map((i) => [i.code, i.level]))}`);
  const h = issuesOf(r, "LINK_TARGET_HIDDEN");
  eq(h.map((i) => [i.documentId, i.field, i.level]), [[header.id, "items.0.link", "blocks"]], "blocks:");
  ok(!/already live/.test(h[0].message), `no 'already live' words: ${h[0].message}`);
  checkIssues(r.body.issues, "hide in set");
  await unchanged(before, "the refusal");
  // x hidden on its own first: then the header's unchanged item is inherited, as before
  published(await publishApi("ck", x.id), "x hidden alone");
  const ri = published(await publishApi("ck", header.id), "header after x was hidden");
  eq(issuesOf({ body: ri }, "LINK_TARGET_HIDDEN").map((i) => i.level), ["inherited"], "inherited once x was already hidden:");

  // renamed inside the set, a link by id
  const y = await create("ck", "page", { body: page("rv-y", "Rv y") });
  published(await publishApi("ck", y.id), "y live");
  await save("ck", header.id, menu([{ label: "Y", link: pageLink("page", "rv-y", y.id) }]));
  published(await publishApi("ck", header.id), "header live with the y item");
  await save("ck", header.id, menu([{ label: "Y", link: pageLink("page", "rv-y", y.id) }, { label: "Shop", link: urlLink("/collections") }]));
  await save("ck", y.id, page("rv-y2", "Rv y"));
  before = await dump();
  const r2 = await publishSetApi("ck", [header.id, y.id]);
  eq([r2.status, r2.body.code], [422, "VALIDATION_FAILED"], `the set renames y: ${JSON.stringify((r2.body.issues || []).map((i) => [i.code, i.level]))}`);
  const m = issuesOf(r2, "LINK_TARGET_MISSING");
  eq(m.map((i) => [i.documentId, i.field, i.level]), [[header.id, "items.0.link", "blocks"]], "blocks:");
  ok(/\/policies\/rv-y2/.test(m[0].message) && !/already live/.test(m[0].message), `the words: ${m[0].message}`);
  await unchanged(before, "the refusal");

  // renamed inside the set, a link by address
  const z = await create("ck", "page", { body: page("rv-z", "Rv z") });
  published(await publishApi("ck", z.id), "z live");
  await save("ck", header.id, menu([{ label: "Z", link: urlLink("/policies/rv-z") }]));
  published(await publishApi("ck", header.id), "header live with the z item");
  await save("ck", header.id, menu([{ label: "Z", link: urlLink("/policies/rv-z") }, { label: "Shop", link: urlLink("/collections") }]));
  await save("ck", z.id, page("rv-z2", "Rv z"));
  const r3 = await publishSetApi("ck", [header.id, z.id]);
  eq([r3.status, issuesOf(r3, "LINK_TARGET_MISSING").map((i) => [i.documentId, i.level])], [422, [[header.id, "blocks"]]], `the set renames z: ${JSON.stringify((r3.body.issues || []).map((i) => [i.code, i.level]))}`);

  // the announcement bar: hidden inside the set
  const w = await create("ck", "page", { body: page("rv-w", "Rv w") });
  published(await publishApi("ck", w.id), "w live");
  const ann = (await current("ck", "doc_announcement").catch(() => null)) || (await create("ck", "announcement"));
  const bar = (text) => ({ ...R.emptyBody("announcement"), settings: { ...(R.emptyBody("announcement").settings || {}), enabled: true, text, link: urlLink("/policies/rv-w") } });
  await save("ck", ann.id, bar("Sale on"));
  published(await publishApi("ck", ann.id), "bar live");
  await save("ck", ann.id, bar("Sale on now"));
  await save("ck", w.id, page("rv-w", "Rv w", undefined, "page", { enabled: false }));
  const r4 = await publishSetApi("ck", [ann.id, w.id]);
  eq([r4.status, issuesOf(r4, "LINK_TARGET_HIDDEN").map((i) => [i.documentId, i.level])], [422, [[ann.id, "blocks"]]], `the set hides w: ${JSON.stringify((r4.body.issues || []).map((i) => [i.code, i.level, i.field]))}`);
});

// =========================================================================================
console.log("— P3-FIX3: an unchanged section's link, the journal old-address probe, stale ids");

const withBanner = (slug, title, words, link) => page(slug, title, [textSec("sec_t1", title, words), bannerTo("sec_bn1", link)]);

await t("P3-FIX3: an unchanged section linking to a page the same set hides, renames by id or renames by address blocks (never 'already live'); alone first, it is inherited", async () => {
  // hidden inside the set
  const s1 = await create("ck", "page", { body: page("fx3-s1", "Fx3 s1") });
  published(await publishApi("ck", s1.id), "s1 live");
  const a = await create("ck", "page", { body: withBanner("fx3-a", "Fx3 a", "Words.", urlLink("/policies/fx3-s1")) });
  published(await publishApi("ck", a.id), "a live with the banner");
  await save("ck", a.id, withBanner("fx3-a", "Fx3 a", "Other words.", urlLink("/policies/fx3-s1")));
  await save("ck", s1.id, page("fx3-s1", "Fx3 s1", undefined, "page", { enabled: false }));
  let before = await dump();
  const r = await publishSetApi("ck", [a.id, s1.id]);
  eq([r.status, r.body.code], [422, "VALIDATION_FAILED"], `the set hides s1: ${JSON.stringify((r.body.issues || []).map((i) => [i.code, i.level]))}`);
  const h = issuesOf(r, "LINK_TARGET_HIDDEN");
  eq(h.map((i) => [i.documentId, i.sectionId, i.level]), [[a.id, "sec_bn1", "blocks"]], "blocks:");
  ok(!/already live/.test(h[0].message), `no 'already live' words: ${h[0].message}`);
  checkIssues(r.body.issues, "hide in set");
  await unchanged(before, "the refusal");
  // s1 hidden on its own first: the unchanged banner is then inherited
  published(await publishApi("ck", s1.id), "s1 hidden alone");
  const ri = published(await publishApi("ck", a.id), "a after s1 was hidden");
  eq(ri.issues.filter((i) => i.code === "LINK_TARGET_HIDDEN").map((i) => i.level), ["inherited"], "inherited once s1 was already hidden:");

  // renamed inside the set, a link by id
  const s2 = await create("ck", "page", { body: page("fx3-s2", "Fx3 s2") });
  published(await publishApi("ck", s2.id), "s2 live");
  const b = await create("ck", "page", { body: withBanner("fx3-b", "Fx3 b", "Words.", pageLink("page", "fx3-s2", s2.id)) });
  published(await publishApi("ck", b.id), "b live");
  await save("ck", b.id, withBanner("fx3-b", "Fx3 b", "Other words.", pageLink("page", "fx3-s2", s2.id)));
  await save("ck", s2.id, page("fx3-s2b", "Fx3 s2"));
  before = await dump();
  const r2 = await publishSetApi("ck", [b.id, s2.id]);
  const m2 = issuesOf(r2, "LINK_TARGET_MISSING");
  eq([r2.status, m2.map((i) => [i.documentId, i.sectionId, i.level])], [422, [[b.id, "sec_bn1", "blocks"]]], `the set renames s2 (by id): ${JSON.stringify((r2.body.issues || []).map((i) => [i.code, i.level]))}`);
  ok(/\/policies\/fx3-s2b/.test(m2[0].message) && !/already live/.test(m2[0].message), `the words: ${m2[0].message}`);
  await unchanged(before, "the refusal");

  // renamed inside the set, a link by address
  const s3 = await create("ck", "page", { body: page("fx3-s3", "Fx3 s3") });
  published(await publishApi("ck", s3.id), "s3 live");
  const c = await create("ck", "page", { body: withBanner("fx3-c", "Fx3 c", "Words.", urlLink("/policies/fx3-s3")) });
  published(await publishApi("ck", c.id), "c live");
  await save("ck", c.id, withBanner("fx3-c", "Fx3 c", "Other words.", urlLink("/policies/fx3-s3")));
  await save("ck", s3.id, page("fx3-s3b", "Fx3 s3"));
  const r3 = await publishSetApi("ck", [c.id, s3.id]);
  eq([r3.status, issuesOf(r3, "LINK_TARGET_MISSING").map((i) => [i.documentId, i.sectionId, i.level])], [422, [[c.id, "sec_bn1", "blocks"]]], `the set renames s3 (by address): ${JSON.stringify((r3.body.issues || []).map((i) => [i.code, i.level]))}`);
  // a hidden section still only warns, set or not (shoppers don't see it)
  await save("ck", c.id, page("fx3-c", "Fx3 c", [textSec("sec_t1", "Fx3 c", "Other words."), { ...bannerTo("sec_bn1", urlLink("/policies/fx3-s3")), enabled: false }]));
  const r4 = published(await publishSetApi("ck", [c.id, s3.id]), "the banner hidden");
  eq(r4.issues.filter((i) => i.code === "LINK_TARGET_MISSING").map((i) => i.level), ["warns"], "a hidden section warns:");
});

await t("P3-FIX3 (FIX2 reviewer's probe): a live post at rvp-new with old address rvp-old, a live header item to /journal/rvp-old; publishSet [header with a new item, the post without that old address] is 422 LINK_TARGET_MISSING", async () => {
  const post = await create("ck", "journal", { body: page("rvp-old", "Rvp post", undefined, "journal") });
  published(await publishApi("ck", post.id), "post live at rvp-old");
  await rename("ck", post.id, "rvp-new", "Rvp post", "journal", { redirect_from: ["rvp-old"] });
  const header = await current("ck", "doc_header");
  const menu = (items) => body("header", { settings: { mode: "custom", items } });
  await save("ck", header.id, menu([{ label: "Story", link: urlLink("/journal/rvp-old") }]));
  const live = published(await publishApi("ck", header.id), "header live with the old address");
  eq(live.issues.filter((i) => /^LINK/.test(i.code)), [], "the old address forwards today:");
  await save("ck", header.id, menu([{ label: "Story", link: urlLink("/journal/rvp-old") }, { label: "Shop", link: urlLink("/collections") }]));
  await save("ck", post.id, page("rvp-new", "Rvp post", undefined, "journal"));
  const before = await dump();
  const r = await publishSetApi("ck", [header.id, post.id]);
  eq([r.status, r.body.code], [422, "VALIDATION_FAILED"], `the probe: ${JSON.stringify((r.body.issues || []).map((i) => [i.code, i.level]))}`);
  const m = issuesOf(r, "LINK_TARGET_MISSING");
  eq(m.map((i) => [i.documentId, i.field, i.level]), [[header.id, "items.0.link", "blocks"]], "blocks:");
  ok(!/already live/.test(m[0].message), `no 'already live' words: ${m[0].message}`);
  await unchanged(before, "the refusal");
  // reset for later tests: the header back to a plain menu
  await save("ck", header.id, menu([{ label: "Shop", link: urlLink("/collections") }]));
  published(await publishApi("ck", header.id), "header reset");
});

await t("P3-FIX3 pin: a menu item by id that was already stale blocks when its page is in the set (the id term of targetInSet), and is inherited when it isn't", async () => {
  const qd = await create("ck", "page", { body: page("fx3-q1", "Fx3 q") });
  published(await publishApi("ck", qd.id), "q live");
  const header = await current("ck", "doc_header");
  const menu = (items) => body("header", { settings: { mode: "custom", items } });
  await save("ck", header.id, menu([{ label: "Q", link: pageLink("page", "fx3-q1", qd.id) }]));
  published(await publishApi("ck", header.id), "header live with the q item");
  await rename("ck", qd.id, "fx3-q2", "Fx3 q"); // the live menu item is stale from here on
  await save("ck", header.id, menu([{ label: "Q", link: pageLink("page", "fx3-q1", qd.id) }, { label: "Shop", link: urlLink("/collections") }]));
  await save("ck", qd.id, page("fx3-q2", "Fx3 q (new title)"));
  const r = await publishSetApi("ck", [header.id, qd.id]);
  eq([r.status, issuesOf(r, "LINK_TARGET_MISSING").map((i) => [i.documentId, i.level])], [422, [[header.id, "blocks"]]], `q in the set: ${JSON.stringify((r.body.issues || []).map((i) => [i.code, i.level]))}`);
  const ri = published(await publishApi("ck", header.id), "header alone");
  eq(ri.issues.filter((i) => i.code === "LINK_TARGET_MISSING").map((i) => i.level), ["inherited"], "alone, inherited:");
  await save("ck", header.id, menu([{ label: "Shop", link: urlLink("/collections") }]));
  published(await publishApi("ck", header.id), "header reset");
});

await t("P3-FIX3: a page link saved with a stale document id is reported: the id's page now lives at another address, is another kind, or is an unpublished page elsewhere (never offered as the fix)", async () => {
  // the id's page lives at another address now
  const moved = await create("ck", "page", { body: page("fx3-m1", "Fx3 moved") });
  published(await publishApi("ck", moved.id), "moved live");
  await rename("ck", moved.id, "fx3-m2", "Fx3 moved");
  const a = await create("ck", "page", { body: withBanner("fx3-stale-a", "Stale a", "Words.", pageLink("page", "fx3-m1", moved.id)) });
  const r = await publishApi("ck", a.id);
  eq(issuesOf(r, "LINK_TARGET_MISSING").map((i) => [i.sectionId, i.level]), [["sec_bn1", "blocks"]], "another address:");
  // the id is a campaign's, the link says /policies/<its slug>
  const camp = await create("ck", "campaign", { body: page("fx3-kind", "Fx3 kind", undefined, "campaign") });
  published(await publishApi("ck", camp.id), "campaign live");
  const b = await create("ck", "page", { body: withBanner("fx3-stale-b", "Stale b", "Words.", pageLink("page", "fx3-kind", camp.id)) });
  const rb = await publishApi("ck", b.id);
  const mb = issuesOf(rb, "LINK_TARGET_MISSING");
  eq(mb.map((i) => [i.sectionId, i.level]), [["sec_bn1", "blocks"]], "another kind:");
  ok(/\/policies\/fx3-kind/.test(mb[0].message) && /\/campaigns\/fx3-kind/.test(mb[0].message), `the words: ${mb[0].message}`);
  // the id is a never-published campaign at another address: the link's own
  // address decides, and that campaign is not offered (publishing it wouldn't fix the link)
  const draftOnly = await create("ck", "campaign", { body: page("fx3-elsewhere", "Fx3 elsewhere", undefined, "campaign") });
  const c = await create("ck", "page", { body: withBanner("fx3-stale-c", "Stale c", "Words.", pageLink("page", "fx3-nothing-here", draftOnly.id)) });
  const rc = await publishApi("ck", c.id);
  eq([rc.status, rc.body.code], [422, "VALIDATION_FAILED"], `not an offer: ${JSON.stringify(rc.body).slice(0, 300)}`);
  eq(issuesOf(rc, "LINKS_TO_UNPUBLISHED"), [], "no 'publish both' for the wrong page:");
  eq(issuesOf(rc, "LINK_TARGET_MISSING").map((i) => i.sectionId), ["sec_bn1"], "missing:");
  eq(rc.body.offer ?? null, null, "no offer:");
  // the id is a live page hidden at another address: the link is missing, not
  // "hidden" (showing that page wouldn't fix the link)
  const hid = await create("ck", "page", { body: page("fx3-hidden-at", "Fx3 hidden", undefined, "page", { enabled: false }) });
  published(await publishApi("ck", hid.id), "hidden page live");
  const e = await create("ck", "page", { body: withBanner("fx3-stale-e", "Stale e", "Words.", pageLink("page", "fx3-gone", hid.id)) });
  const re = await publishApi("ck", e.id);
  eq([issuesOf(re, "LINK_TARGET_HIDDEN").length, issuesOf(re, "LINK_TARGET_MISSING").map((i) => i.sectionId)], [0, ["sec_bn1"]], "a hidden page elsewhere:");
  // the same id at its own address is still offered (unchanged)
  await save("ck", c.id, withBanner("fx3-stale-c", "Stale c", "Words.", pageLink("campaign", "fx3-elsewhere", draftOnly.id)));
  const rd = await publishApi("ck", c.id);
  eq([rd.status, rd.body.code, rd.body.offer?.publishSet?.map((x) => x.id)], [422, "LINKS_TO_UNPUBLISHED", [c.id, draftOnly.id]], "at its own address, offered:");
});

// =========================================================================================
console.log("— the checks module on its own");

await t("checks.js: linkTarget reads page links, store urls and catalog links; listItemOf finds the last list index; decorate keeps the issue keys", async () => {
  eq(Checks.linkTarget({ ref: "link", type: "url", href: "/campaigns/diwali?x=1#top" }), { page: { family: "campaign", slug: "diwali", document: null } }, "url:");
  eq(Checks.linkTarget({ ref: "link", type: "page", href: "/journal/hello", slug: "hello", document: "doc_x" }), { page: { family: "journal", slug: "hello", document: "doc_x" } }, "page link:");
  eq(Checks.linkTarget({ ref: "link", type: "url", href: "/collections" }), null, "a listing isn't checked:");
  eq(Checks.linkTarget({ ref: "link", type: "url", href: "#new" }), null, "an anchor:");
  eq(Checks.linkTarget({ ref: "link", type: "collection", handle: "protein" }), { catalog: "collection", handle: "protein" }, "collection:");
  eq(Checks.listItemOf("items.0.children.2.link"), { field: "items.0.children", index: 2 }, "nested:");
  eq(Checks.listItemOf("title"), null, "no list:");
  const i = { documentId: "doc_home", sectionId: null, blockId: null, field: "sections", code: "HOME_EMPTY", severity: "error", message: "x", autoFix: null };
  eq(Object.keys(Checks.decorate(i, { body: { type: "home", sections: [] } })), Object.keys(SHAPES.publish.outcomes.validationFailed.body.issues[0]), "keys:");
});

for (const c of Object.values(raw)) c.close();
for (const f of FILES) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
process.exit(fail ? 1 : 0);
