// P2-PUBLISH suite: publishing one document or a set (lib/documents/publish.js)
// on top of the proven commit, through the real console API
// (lib/admin/documents-api.js: real requireAdmin, real sessions, real tenant
// databases with every migration). Storage is re-read after every refusal.
//
//   1. file: databases through lib/db.js, with the test-only "interleave hook"
//      (setPublishHooks) to land another publish or an autosave between the
//      publish's read and its batch, and to force commit outcomes;
//   2. a throwaway real sqld behind P2-ATOM's Hrana fault proxy
//      (scripts/support/hrana-fault-proxy.js), through HEAD's lib/db.js.
//
// sqld is required: if it is missing the suite FAILS, it never skips (as
// test:publish). Ports: TEST_PUBLISH_SERVICE_PORTS="<sqld>,<proxy>" picks
// them; otherwise free ports.
//   pnpm test:publish-service
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
process.env.DATABASE_URL = "file:.test-ps-default.db";
process.env.PLATFORM_DB_URL = "file:.test-ps-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const STORES = ["docs", "first", "legacy", "rel", "busy"];
const FILES = [".test-ps-default.db", ".test-ps-platform.db", ...STORES.map((s) => `.test-ps-${s}.db`), ".test-ps-pre23.db"];
for (const f of FILES) await rm(join(ROOT, f), { force: true });

const started = Date.now();
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const J = await import("../lib/documents/journal-index.js");
const L = await import("../lib/documents/release-list.js");
const ids = await import("../lib/documents/ids.js");
const { commitPublishBatch, __commitInternals } = await import("../lib/documents/commit.js");
const { versionRow } = await import("../lib/documents/versions.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const R = await import("../lib/registry/index.js");
const Res = await import("../lib/content/resolve.js");
const { DEFAULT_ANNOUNCEMENT, defaultHero, DEFAULT_HOME_SECTIONS } = await import("../lib/cms/defaults.js");
const { startFaultProxy } = await import("./support/hrana-fault-proxy.js");
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
for (const s of STORES) {
  const c = createClient({ url: `file:.test-ps-${s}.db` });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS);
  if (s !== "legacy") await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  else await c.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
  raw[s] = c;
  await C.upsertTenant({ id: `ps${s}`, name: `PS ${s}`, domains: [`ps${s}.test`], dbUrl: `file:.test-ps-${s}.db`, config: { site: { name: `PS ${s} Store` }, site_url: `https://ps${s}.test` }, secrets: {} });
  TEN[s] = await C.getTenant(`ps${s}`);
}
// P3-COMMIT: a documents store at 0022 (no document_refs table yet)
{
  const c = createClient({ url: "file:.test-ps-pre23.db" });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS.filter((m) => m.id < "0023"));
  await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  raw.pre23 = c;
  await C.upsertTenant({ id: "pspre23", name: "PS pre23", domains: ["pspre23.test"], dbUrl: "file:.test-ps-pre23.db", config: { site: { name: "PS pre23 Store" }, site_url: "https://pspre23.test" }, secrets: {} });
  TEN.pre23 = await C.getTenant("pspre23");
}
const ownerU = await I.createUser({ email: "owner@ps.test", name: "Asha Rao", password: "owner-pass-publish" });
const staffU = await I.createUser({ email: "staff@ps.test", name: "Ravi", password: "staff-pass-publish" });
for (const s of [...STORES, "pre23"]) {
  await I.addMembership(ownerU.id, `ps${s}`, "owner");
  await I.addMembership(staffU.id, `ps${s}`, "staff");
}
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const ACTOR = { kind: "merchant", id: ownerU.id };

const req = (tenant, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${tenant.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (body, { as = OWNER, store = "docs" } = {}) => withTenant(TEN[store], () => handleDocumentsPut(req(TEN[store], as, body)));
const inT = (fn, store = "docs") => withTenant(TEN[store], fn);
const sql = async (q, args = [], store = "docs") => (await raw[store].execute({ sql: q, args })).rows.map((r) => ({ ...r }));

// Everything a publish could touch.
const dump = async (store = "docs") => {
  const out = {};
  for (const table of ["documents", "document_versions", "publish_log", "release_state", "releases"]) out[table] = await sql(`SELECT * FROM ${table} ORDER BY rowid`, [], store);
  return canon(out);
};
// What a publish writes (an autosave's own draft and checkpoint left out).
const publishDump = async (store = "docs") =>
  canon({
    releases: await sql("SELECT * FROM releases ORDER BY rowid", [], store),
    state: await sql("SELECT * FROM release_state", [], store),
    log: await sql("SELECT * FROM publish_log ORDER BY rowid", [], store),
    published: await sql("SELECT * FROM document_versions WHERE kind = 'published' ORDER BY rowid", [], store),
    docs: await sql("SELECT id, published_version_id, published_hash FROM documents ORDER BY id", [], store),
  });
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

const create = async (store, type, extra = {}) => {
  const r = await api({ createDocument: { type, ...extra } }, { store });
  eq(r.status, 200, `create ${type}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
};
const save = async (store, d, newBody) => {
  const r = await api({ saveDraft: { id: d.id, body: newBody }, revision: d.revision }, { store });
  eq(r.status, 200, `save ${d.id}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body.document;
};
const current = (store, id) => inT(() => Docs.getDocument(id), store);
const publishApi = async (store, id, { as = OWNER, revision, draftHash, confirmRepublish } = {}) => {
  const d = await current(store, id);
  return api({ publish: { id, draftHash: draftHash ?? d.draftHash, ...(confirmRepublish ? { confirmRepublish: true } : {}) }, revision: revision ?? d.revision }, { store, as });
};
const publishSetApi = async (store, list, { as = OWNER } = {}) => {
  const items = [];
  for (const it of list) {
    const id = typeof it === "string" ? it : it.id;
    const d = await current(store, id);
    items.push({ id, revision: it.revision ?? d.revision, draftHash: it.draftHash ?? d.draftHash });
  }
  return api({ publishSet: items }, { store, as });
};
const published = (r, label = "publish") => {
  eq(r.status, 200, `${label}: ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
};
const page = (slug, title, words = "Some words.", type = "page") => body(type, { meta: { slug, title }, sections: [textSec("sec_t1", title, words)] });

// A live version written straight through the commit, past publish
// validation, as a migrated document could be (kind 'migrated').
async function liveFixture(docId, b, store = "docs") {
  await inT(async () => {
    const live = await pointerOf(store);
    const v = await versionRow({ documentId: docId, kind: "migrated", body: b, schemaVersion: 1, createdAt: new Date().toISOString() });
    const cur = await current(store, docId);
    const list = L.setEntries(live.list || L.emptyList(1, R.singletonTypes()), [{ document: docId, entry: { version: v.id, hash: v.body_hash }, pages: [{ slug: b.meta.slug, type: b.type, title: b.meta.title }] }]);
    const r = await commitPublishBatch({ releaseId: ids.relId(), setId: ids.setId(), pointer: live.pointer, list, versions: [v], documents: [{ id: docId, revision: cur.revision, published_version_id: v.id, published_hash: await R.documentHash(b) }], log: [{ id: ids.logId(), document_id: docId, action: "migrated", to_version_id: v.id }] });
    eq(r.outcome, "ok", "fixture:");
  }, store);
}

// What every getter returns on a store whose list is emptyList plus one page
// (the same table P2-READ checks; the code defaults).
const P1 = "gid://shopify/Product/1";
const COL2 = "gid://shopify/Collection/2";
const defaultsWanted = (name) => [
  ["resolvedAnnouncement", [], DEFAULT_ANNOUNCEMENT],
  ["resolvedHero", [], defaultHero(name)],
  ["resolvedHomeSections", [], DEFAULT_HOME_SECTIONS],
  ["resolvedNav", ["header"], null],
  ["resolvedNav", ["footer"], null],
  ["resolvedCollectionsIndex", [], null],
  ["resolvedPdpExtras", [], []],
  ["resolvedContentPage", ["about"], null],
  ["resolvedBrand", [], null],
  ["resolvedTheme", [], null],
  ["resolvedSurfaceTemplates", [], { header: "standard", footer: "columns" }],
  ["resolvedSurfaceTemplateFor", ["pdp", P1], { template: "classic", source: "platform" }],
  ["resolvedSurfaceTemplateFor", ["collection", COL2], { template: "standard", source: "platform" }],
  ["resolvedProductOverride", [P1], { modules: [], badge: "" }],
  ["resolvedCollectionPins", ["serums"], []],
  ["resolvedSlugRedirect", ["old-about"], null],
];

// =========================================================================================
console.log("— first publish, scoped publish (PUB-01, PUB-02, DOC-05)");

// P3-CHECKS (PUB-06): a closed store opens with its home page, so the first
// publish of a policy page alone is refused with an offer that adds doc_home
// (scripts/test-publish-checks.js has the full case). With the home page in
// the set it goes live, and every other getter keeps its code default.
await t("the first publish on a never-published documents store, of one policy page plus the home page, goes live; every other getter returns its code default and nothing errors", async () => {
  const before = await pointerOf("first");
  eq(before.pointer, null, "never published:");
  const privacy = await create("first", "page", { body: page("privacy", "Privacy", "We keep little.") });
  const alone = await publishApi("first", privacy.id);
  eq([alone.status, alone.body.code], [409, "FIRST_PUBLISH_NEEDS_HOME"], "a policy page alone:");
  const home = await create("first", "home", { body: body("home", { sections: [sec("hero", "sec_hero", { title: "First home" })] }) });
  const r = published(await publishSetApi("first", [privacy.id, home.id]), "first publish");
  eq(r.published.map((p) => p.id).sort(), [home.id, privacy.id].sort(), "the page and the home page:");
  const live = await pointerOf("first");
  eq(live.pointer, r.release.id, "the pointer is the new release:");
  for (const t of R.singletonTypes()) if (t !== "home") eq(live.list.documents[`doc_${t}`], null, `doc_${t} is an explicit null:`);
  eq(live.list.pages.map((p) => [p.slug, p.document]), [["privacy", privacy.id]], "the page row:");
  eq(live.list.indexes.journal, null, "no journal index:");
  for (const [fn, args, want] of defaultsWanted("PS first Store")) {
    if (fn === "resolvedHero" || fn === "resolvedHomeSections") continue; // the home page is live now
    let got;
    try {
      got = await inT(() => Res[fn](...args), "first");
    } catch (e) {
      throw new Error(`${fn}(${args.join(",")}) threw ${e.message} ${JSON.stringify(e.detail || "")}`);
    }
    eq(got, want, `${fn}(${args.join(",")}):`);
  }
  eq((await inT(() => Res.resolvedHero(), "first")).title, "First home", "the home page is live:");
  eq((await inT(() => Res.resolvedContentPageList(), "first")).find((p) => p.slug === "privacy"), { slug: "privacy", title: "Privacy", enabled: true, source: "custom", family: "page" }, "listed:");
  eq((await inT(() => Res.resolvedContentPage("privacy"), "first")).sections, [{ id: "sec_t1", kind: "text", heading: "Privacy", body: ["We keep little."] }], "the policy page:");
  eq(await inT(() => Res.resolvedJournalEntries(), "first"), [], "no journal:");
  const row = (await sql("SELECT published_version_id, published_hash, draft_hash FROM documents WHERE id = ?", [privacy.id], "first"))[0];
  eq(row.published_version_id, r.published.find((p) => p.id === privacy.id).versionId, "documents.published_version_id:");
  eq(row.published_hash, row.draft_hash, "published_hash uses the draft hash rule (ids stripped):");
});

const homeBody = (extra = []) => body("home", { sections: [sec("hero", "sec_hero", { title: "Live hero" }), sec("new", "sec_new1", { title: "New in", limit: 4 }), ...extra] });
let HOME;
let SHIPPING;
await t("publishing a policy-page typo while doc_home has a dirty draft with an incomplete enabled section leaves doc_home's live entry and getter output unchanged, and succeeds", async () => {
  HOME = await create("docs", "home", { body: homeBody() });
  SHIPPING = await create("docs", "page", { body: page("shipping", "Shipping", "We ship in two days.") });
  published(await publishSetApi("docs", [HOME.id, SHIPPING.id]), "home and shipping");
  const liveBefore = await pointerOf();
  const gettersBefore = await inT(async () => ({ hero: await Res.resolvedHero(), sections: await Res.resolvedHomeSections(), home: await Res.resolvedHomePage() }));
  eq(gettersBefore.hero.title, "Live hero", "home is live:");

  // a half-finished home draft: a new, enabled banner with no title or text
  const h = await current("docs", HOME.id);
  const dirty = await save("docs", h, { ...h.body, sections: [...h.body.sections, sec("banner", "sec_banner1", { title: "", text: "" })] });
  const s = await current("docs", SHIPPING.id);
  await save("docs", s, page("shipping", "Shipping", "We ship in two dayz... no: two days, fixed."));

  const r = published(await publishApi("docs", SHIPPING.id), "the typo");
  eq(r.published.map((p) => p.id), [SHIPPING.id], "only the policy page:");
  const liveAfter = await pointerOf();
  eq(liveAfter.list.documents[HOME.id], liveBefore.list.documents[HOME.id], "doc_home's live entry:");
  const gettersAfter = await inT(async () => ({ hero: await Res.resolvedHero(), sections: await Res.resolvedHomeSections(), home: await Res.resolvedHomePage() }));
  eq(gettersAfter, gettersBefore, "home getters:");
  eq((await inT(() => Res.resolvedContentPage("shipping"))).sections[0].body, ["We ship in two dayz... no: two days, fixed."], "the typo fix is live:");
  const hd = await current("docs", HOME.id);
  eq(hd.revision, dirty.revision, "the home draft is untouched:");
  ok(hd.draftHash !== hd.publishedHash, "and still unpublished");
  // and the home draft itself still can't go live
  const refused = await publishApi("docs", HOME.id);
  eq(refused.status, 422, "the incomplete home:");
  ok(refused.body.issues.some((i) => i.sectionId === "sec_banner1" && i.severity === "error"), "names the banner:");
});

// =========================================================================================
console.log("— races (interleave hook)");

const snap = (store = "docs") => publishDump(store);

await t("two concurrent publishes of different documents both succeed and both are live", async () => {
  const a = await create("docs", "page", { body: page("race-a", "Race A", "A words.") });
  const b = await create("docs", "page", { body: page("race-b", "Race B", "B words.") });
  let inner = null;
  let attempts = 0;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (build.documents[0].id !== a.id) return;
      attempts = attempt;
      if (attempt === 1) inner = await publishApi("docs", b.id); // B lands between A's read and A's batch
    },
  });
  const ra = await publishApi("docs", a.id);
  Pub.setPublishHooks({});
  published(inner, "B");
  published(ra, "A");
  eq(attempts, 2, "A lost once and rebuilt from B's list:");
  const live = await pointerOf();
  eq(live.list.documents[a.id]?.version, ra.body.published[0].versionId, "A live:");
  eq(live.list.documents[b.id]?.version, inner.body.published[0].versionId, "B live:");
  ok(live.list.pages.some((p) => p.slug === "race-a") && live.list.pages.some((p) => p.slug === "race-b"), "both page rows");
  // a release row of A's first (lost) build was never written
  eq((await sql("SELECT count(*) AS n FROM publish_log WHERE document_id = ?", [a.id]))[0].n, 1, "one log row for A:");
});

await t("two concurrent publishes of the same document give one success and one 409; the loser's content is not live", async () => {
  const d = await create("docs", "page", { body: page("same-doc", "Same doc", "First words.") });
  let inner = null;
  let loserBuild = null;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (attempt !== 1 || loserBuild) return;
      loserBuild = build;
      Pub.setPublishHooks({}); // the winner runs without the hook
      inner = await publishApi("docs", d.id);
    },
  });
  const loser = await publishApi("docs", d.id);
  published(inner, "winner");
  eq(loser.status, 409, `loser: ${JSON.stringify(loser.body).slice(0, 300)}`);
  eq(loser.body.code, "PUBLISHED_ELSEWHERE", "code:");
  ok(/Someone else published/.test(loser.body.error), "plain words");
  eq(loser.body.current?.id, d.id, "the current document rides along:");
  const live = await pointerOf();
  eq(live.list.documents[d.id].version, inner.body.published[0].versionId, "the winner's version is live:");
  eq(await sql("SELECT id FROM document_versions WHERE id = ?", [loserBuild.versions[0].id]), [], "the loser's version row was never written:");
  eq(await sql("SELECT id FROM releases WHERE id = ?", [loserBuild.releaseId]), [], "nor its release row:");
});

await t("a saveDraft landing between the publish read and the batch makes the publish return 409 with nothing written", async () => {
  const d = await create("docs", "page", { body: page("autosaved", "Autosaved", "Before.") });
  const before = await snap();
  let calls = 0;
  Pub.setPublishHooks({
    beforeCommit: async () => {
      calls++;
      const cur = await current("docs", d.id);
      await inT(() => Docs.saveDraft({ id: d.id, revision: cur.revision, body: page("autosaved", "Autosaved", "Typed meanwhile."), actor: ACTOR }));
    },
  });
  const r = await publishApi("docs", d.id);
  eq(r.status, 409, `status: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(r.body.code, "DOCUMENT_CHANGED", "code:");
  eq(r.body.current?.revision, (await current("docs", d.id)).revision, "the current document:");
  eq(calls, 1, "no rebuild:");
  eq(await snap(), before, "nothing published:");
  eq((await pointerOf()).list.documents[d.id], undefined, "not in the live list:");
});

await t("when commitPublishBatch returns {unknown}, the API returns 503 with the reload message and the service makes no rebuild attempt (spy)", async () => {
  const d = await create("docs", "page", { body: page("unknown-out", "Unknown", "Words.") });
  const before = await dump();
  let calls = 0;
  Pub.setPublishHooks({ commit: async (b) => (calls++, { unknown: true, outcome: "unknown", releaseId: b.releaseId, cause: new Error("fetch failed"), readError: new Error("fetch failed") }) });
  const r = await publishApi("docs", d.id);
  eq(r.status, 503, "status:");
  eq(r.body.error, "Your publish may have gone live. Reload to check.", "message:");
  eq(r.body.code, "PUBLISH_UNKNOWN", "code:");
  eq(calls, 1, "one commit, no rebuild:");
  ok(!("issues" in r.body), "no issue list");
  await unchanged(before, "unknown (the spy wrote nothing)");
});

await t("a SQLITE_BUSY storm (every commit lost, busy) ends in 503 'Publishing is busy, try again in a moment' after 3 attempts; a failed commit is a 5xx, never 409; MISSING_DOCUMENT is the 'deleted' message; a throw is a failure, not a race", async () => {
  const d = await create("docs", "page", { body: page("busy-out", "Busy", "Words.") });
  const before = await dump();
  let calls = 0;
  Pub.setPublishHooks({
    commit: async (b) => {
      calls++;
      const live = await inT(() => pointerOf());
      return { lost: true, outcome: "lost", busy: true, releaseId: b.releaseId, pointer: live.pointer, list: live.list, cause: new Error("SQLITE_BUSY: database is locked") };
    },
  });
  const busy = await publishApi("docs", d.id);
  eq(busy.status, 503, "busy status:");
  eq(busy.body.code, "PUBLISH_BUSY", "busy code:");
  ok(busy.body.error.startsWith("Publishing is busy, try again in a moment"), `busy words: ${busy.body.error}`);
  eq(calls, Pub.MAX_ATTEMPTS, "attempts:");

  const outcomes = [
    [{ failed: true, outcome: "failed", code: "DB_REFUSED", cause: Object.assign(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: releases.id"), { code: "SQLITE_CONSTRAINT" }) }, 500, "PUBLISH_FAILED"],
    [{ failed: true, outcome: "failed", code: "VERSION_ID_CLASH" }, 500, "PUBLISH_FAILED"],
    [{ failed: true, outcome: "failed", code: "BAD_BUILD", problems: ["x"] }, 500, "PUBLISH_FAILED"],
    [{ failed: true, outcome: "failed", code: "MISSING_DOCUMENT", missing: [d.id] }, 404, "DOCUMENT_DELETED"],
    ["throw", 500, "PUBLISH_FAILED"],
  ];
  for (const [outcome, status, code] of outcomes) {
    calls = 0;
    Pub.setPublishHooks({
      commit: async () => {
        calls++;
        if (outcome === "throw") throw new TypeError("listCanonical blew up");
        return outcome;
      },
    });
    const r = await publishApi("docs", d.id);
    const label = outcome === "throw" ? "throw" : outcome.code;
    eq([r.status, r.body.code], [status, code], `${label}:`);
    eq(calls, 1, `${label} is never rebuilt:`);
    ok(r.status !== 409 && !/someone else/i.test(r.body.error), `${label} never says someone else published`);
    if (code === "DOCUMENT_DELETED") eq(r.body.error, "This page was deleted while you were publishing. Reload to see the current pages.", "deleted words:");
    else ok(/nothing was published\. Your live store hasn't changed/.test(r.body.error), `${label} words: ${r.body.error}`);
  }
  await unchanged(before, "forced outcomes");
});

// =========================================================================================
console.log("— per-document checks (PUB-02, PUB-05, DOC-05, DOC-07, DOC-10)");

await t("a stale revision or changed draftHash gives 409 per document, with nothing changed; a set with one invalid document gives 422 naming it, and none of the set goes live", async () => {
  const a = await create("docs", "page", { body: page("set-a", "Set A", "A.") });
  const b = await create("docs", "page", { body: page("set-b", "Set B", "B.") });
  const c = await create("docs", "page", { body: page("set-c", "Set C", "C.") });
  const before = await dump();
  const single = await publishApi("docs", a.id, { revision: a.revision + 5 });
  eq([single.status, single.body.code], [409, "DOCUMENT_CHANGED"], "stale single:");
  eq(single.body.current?.id, a.id, "current:");
  const hash = await publishApi("docs", a.id, { draftHash: "0".repeat(64) });
  eq([hash.status, hash.body.code], [409, "DRAFT_CHANGED"], "changed hash:");
  const set = await publishSetApi("docs", [a.id, { id: b.id, revision: b.revision - 1 }, { id: c.id, draftHash: "f".repeat(64) }]);
  eq(set.status, 409, "set status:");
  eq(set.body.conflicts.map((x) => [x.id, x.code]), [[b.id, "DOCUMENT_CHANGED"], [c.id, "DRAFT_CHANGED"]], "per document:");
  for (const x of set.body.conflicts) eq(x.current?.revision, (await current("docs", x.id)).revision, `${x.id} current:`);
  await unchanged(before, "409s");

  // one invalid document: an enabled section with no text
  const bad = await current("docs", b.id);
  await save("docs", bad, { ...bad.body, sections: [...bad.body.sections, sec("banner", "sec_bad1", { title: "", text: "" })] });
  const before2 = await dump();
  const inv = await publishSetApi("docs", [a.id, b.id, c.id]);
  eq(inv.status, 422, `invalid set: ${JSON.stringify(inv.body).slice(0, 300)}`);
  eq(inv.body.code, "VALIDATION_FAILED", "code:");
  eq(inv.body.documents, [{ id: b.id, label: "Set B" }], "names that document:");
  ok(inv.body.error.includes("“Set B”") && /nothing was published/.test(inv.body.error), `message: ${inv.body.error}`);
  ok(inv.body.issues.some((i) => i.documentId === b.id && i.sectionId === "sec_bad1" && i.severity === "error"), "the issue carries its document and section");
  await unchanged(before2, "422");
  const live = await pointerOf();
  for (const id of [a.id, b.id, c.id]) eq(live.list.documents[id], undefined, `${id} not live:`);
});

await t("a raw <script> written directly into a draft row never appears in the published version", async () => {
  const d = await create("docs", "page", { body: page("scripted", "Scripted", "Hi.") });
  const evil = body("page", { meta: { slug: "scripted", title: "Scripted" }, sections: [sec("rich_text", "sec_rt1", { title: "Words", html: "<p>Hello</p><script>alert(1)</script><script src=\"https://x.test/a.js\"></script>" })] });
  const hash = await R.documentHash(evil);
  // straight into the row, past saveDraft's sanitizer (a bug, a migration, a bypass)
  await raw.docs.execute({ sql: "UPDATE documents SET draft = ?, draft_hash = ?, revision = revision + 1 WHERE id = ?", args: [JSON.stringify(evil), hash, d.id] });
  const r = published(await publishApi("docs", d.id), "scripted");
  const v = (await sql("SELECT body FROM document_versions WHERE id = ?", [r.published[0].versionId]))[0].body;
  ok(!/<script/i.test(String(v)), `no script in the version: ${v}`);
  ok(String(v).includes("<p>Hello</p>"), "the words kept");
  const all = await sql("SELECT body FROM document_versions WHERE kind = 'published' AND document_id = ?", [d.id]);
  ok(all.every((row) => !/<script/i.test(String(row.body))), "no published version holds a script");
});

await t("an incomplete enabled new section blocks its own document's publish; a section unchanged from live (or hidden) only warns", async () => {
  // a live version with an incomplete banner, as a migrated document could
  // have: written through the commit itself, past publish validation
  const d = await create("docs", "page", { body: page("inherited", "Inherited", "Words.") });
  const old = body("page", { meta: { slug: "inherited", title: "Inherited" }, sections: [textSec("sec_t1", "Inherited", "Words."), sec("banner", "sec_old1", { title: "", text: "" })] });
  await liveFixture(d.id, old);
  // a typo fix in the title: the old banner is unchanged from live, so it warns
  const cur = await current("docs", d.id);
  await save("docs", cur, { ...old, meta: { ...old.meta, title: "Inherited (fixed)" } });
  const r = published(await publishApi("docs", d.id), "typo with an inherited problem");
  const w = r.issues.filter((i) => i.sectionId === "sec_old1");
  ok(w.length > 0 && w.every((i) => i.severity === "warning"), `inherited problems warn: ${JSON.stringify(r.issues)}`);
  ok(w.some((i) => /already live like this/.test(i.message)), "says why");

  // a new incomplete enabled section blocks
  const cur2 = await current("docs", d.id);
  await save("docs", cur2, { ...cur2.body, sections: [...cur2.body.sections, sec("banner", "sec_new9", { title: "", text: "" })] });
  const before = await dump();
  const blocked = await publishApi("docs", d.id);
  eq(blocked.status, 422, "a new incomplete section:");
  ok(blocked.body.issues.some((i) => i.sectionId === "sec_new9" && i.severity === "error"), "blocks on its own section");
  ok(blocked.body.issues.filter((i) => i.sectionId === "sec_old1").every((i) => i.severity === "warning"), "the inherited one still only warns");
  await unchanged(before, "blocked");

  // the same new section, hidden: warns, and publishes
  const cur3 = await current("docs", d.id);
  await save("docs", cur3, { ...cur3.body, sections: cur3.body.sections.map((s) => (s.id === "sec_new9" ? { ...s, enabled: false } : s)) });
  const hidden = published(await publishApi("docs", d.id), "hidden");
  ok(hidden.issues.some((i) => i.sectionId === "sec_new9" && i.severity === "warning" && /hidden/.test(i.message)), "the hidden one warns");

  // structure always blocks, even in a section unchanged from live: a live
  // version holding an unknown field (written past validation, as a migrated
  // document could be), then a typo elsewhere
  const cur4 = await current("docs", d.id);
  const structural = { ...cur4.body, sections: cur4.body.sections.map((s) => (s.id === "sec_old1" ? { ...s, settings: { ...s.settings, sparkle: true } } : s)) };
  await liveFixture(d.id, structural);
  const typo = { ...structural, meta: { ...structural.meta, title: "Inherited (typo fixed)" } };
  await raw.docs.execute({ sql: "UPDATE documents SET draft = ?, draft_hash = ?, revision = revision + 1 WHERE id = ?", args: [JSON.stringify(typo), await R.documentHash(typo), d.id] });
  const st = await publishApi("docs", d.id);
  eq(st.status, 422, "structure:");
  ok(st.body.issues.some((i) => i.code === "UNKNOWN_FIELD" && i.sectionId === "sec_old1" && i.severity === "error"), "UNKNOWN_FIELD blocks in a section unchanged from live");
});

await t("publishing doc_home with zero enabled sections returns the exact 'Your home page is empty…' message", async () => {
  const h = await current("docs", HOME.id);
  await save("docs", h, { ...h.body, sections: h.body.sections.map((s) => ({ ...s, enabled: s.kind === "hero" ? false : false })) });
  const before = await dump();
  const r = await publishApi("docs", HOME.id);
  eq(r.status, 422, `status: ${JSON.stringify(r.body).slice(0, 300)}`);
  const home = r.body.issues.filter((i) => i.code === "HOME_EMPTY");
  eq(home.length, 1, "one HOME_EMPTY:");
  eq(home[0].message, "Your home page is empty. Add a section or restore the last published version.", "exact words:");
  eq(home[0].severity, "error", "it blocks:");
  await unchanged(before, "empty home");
  const h2 = await current("docs", HOME.id);
  await save("docs", h2, { ...h2.body, sections: [] });
  const r2 = await publishApi("docs", HOME.id);
  eq(r2.status, 422, "sections []:");
  eq(r2.body.issues.find((i) => i.code === "HOME_EMPTY")?.message, R.HOME_EMPTY_MESSAGE, "same words:");
});

await t("publishing a page whose slug equals another live page's slug is refused with a message naming that page", async () => {
  const about = await create("docs", "page", { body: page("about", "About us", "Who we are.") });
  published(await publishApi("docs", about.id), "about");
  // the About page's DRAFT moves to /about-us (not published), which frees
  // /about for a new draft; the live About still holds /about
  const a = await current("docs", about.id);
  await save("docs", a, page("about-us", "About us", "Who we are."));
  const second = await create("docs", "page", { body: page("about", "About (new)", "Hello.") });
  const before = await dump();
  const r = await publishApi("docs", second.id);
  eq(r.status, 409, `status: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(r.body.code, "SLUG_TAKEN", "code:");
  eq(r.body.error, "Another live page already uses /about: About us. Change the address of “About (new)”, then publish again.", "names the other page:");
  eq(r.body.other, { id: about.id, title: "About us" }, "other:");
  await unchanged(before, "slug");
  // publishing both together moves About to /about-us and frees /about (one set)
  const both = published(await publishSetApi("docs", [about.id, second.id]), "both together");
  eq(both.published.length, 2, "both:");
  const live = await pointerOf();
  eq(live.list.pages.filter((p) => ["about", "about-us"].includes(p.slug)).map((p) => [p.slug, p.document]), [["about", second.id], ["about-us", about.id]], "the result:");
  // a journal post may not take a live page's slug either
  const post = await create("docs", "journal", { body: page("shipping", "A post", "Post words.", "journal") }).catch(() => null);
  ok(post === null, "the draft slug index already refuses a second live draft at /shipping (P2-DOCS)");
});

await t("restoreVersion and then publish puts the restored body live, with a new published version row", async () => {
  const d = await create("docs", "page", { body: page("restore-me", "Restore me", "Version one.") });
  const v1 = published(await publishApi("docs", d.id), "v1").published[0].versionId;
  await save("docs", await current("docs", d.id), page("restore-me", "Restore me", "Version two."));
  published(await publishApi("docs", d.id), "v2");
  const cur = await current("docs", d.id);
  const rr = await api({ restoreVersion: { id: d.id, versionId: v1 }, revision: cur.revision });
  eq(rr.status, 200, "restore:");
  const r = published(await publishApi("docs", d.id), "restore then publish");
  const v3 = r.published[0].versionId;
  ok(v3 !== v1, "a new version id, never the restored one");
  const rows = await sql("SELECT id, kind FROM document_versions WHERE document_id = ? AND kind = 'published' ORDER BY rowid", [d.id]);
  eq(rows.length, 3, "three published rows:");
  eq(rows[2].id, v3, "the newest is the new one:");
  eq((await pointerOf()).list.documents[d.id].version, v3, "live:");
  eq((await versionBody(v3)).sections[0].settings.body, ["Version one."], "the restored words are live:");
  eq((await inT(() => Res.resolvedContentPage("restore-me"))).sections[0].body, ["Version one."], "shoppers see it:");
});

await t("publishing a journal post writes a new indexes.journal version in the same batch; list.pages never holds posts", async () => {
  const p1 = await create("docs", "journal", { body: page("hello-post", "Hello post", "Post one.", "journal") });
  const before = await pointerOf();
  const r = published(await publishApi("docs", p1.id), "post");
  const live = await pointerOf();
  ok(live.list.indexes.journal && live.list.indexes.journal !== before.list.indexes.journal, "a new index entry");
  const idx = live.list.indexes.journal.version;
  const row = (await sql("SELECT document_id, kind, created_at FROM document_versions WHERE id = ?", [idx]))[0];
  eq([row.document_id, row.kind], [J.JOURNAL_INDEX_ID, "published"], "the index version:");
  const post = (await sql("SELECT created_at FROM document_versions WHERE id = ?", [r.published[0].versionId]))[0];
  eq(row.created_at, post.created_at, "written by the same build:");
  const log = await sql("SELECT release_id FROM publish_log WHERE document_id = ?", [p1.id]);
  eq(log.map((l) => l.release_id), [r.release.id], "the same release:");
  const ib = await versionBody(idx);
  eq(ib.type, "journal_index", "index body type:");
  eq(R.validateDocument(ib, { mode: "draft" }).ok, true, "the index body is a valid registry document:");
  eq(J.journalEntriesOf(ib).map((e) => [e.slug, e.document, e.version, e.enabled, e.family]), [["hello-post", p1.id, r.published[0].versionId, true, "journal"]], "entries:");
  for (const k of ["title", "description", "effective_at", "window_start", "window_end"]) ok(k in J.journalEntriesOf(ib)[0], `entry carries ${k}`);
  ok(!live.list.pages.some((p) => p.document === p1.id || p.slug === "hello-post"), "no post in list.pages");
  eq((await inT(() => Res.resolvedJournalEntries())).map((e) => e.slug), ["hello-post"], "shoppers' journal:");

  // a second post, and a scheduled one: the first entry is kept, the window rides along
  const p2 = await create("docs", "journal", { body: body("journal", { meta: { slug: "later-post", title: "Later", window_start: "2099-01-01T00:00:00.000Z" }, sections: [textSec("sec_t1", "Later", "Soon.")] }) });
  published(await publishApi("docs", p2.id), "post 2");
  const ib2 = await versionBody((await pointerOf()).list.indexes.journal.version);
  eq(J.journalEntriesOf(ib2).map((e) => [e.slug, e.window_start]), [["hello-post", null], ["later-post", "2099-01-01T00:00:00.000Z"]], "both entries, with the window:");
  eq((await inT(() => Res.resolvedJournalEntries())).map((e) => e.slug), ["hello-post"], "the scheduled one is not shown yet:");
  const live2 = await pointerOf();
  ok(!live2.list.pages.some((p) => p.type === "journal"), "still no posts in list.pages");
  // publishing a page never writes a new journal index
  const pg = await create("docs", "page", { body: page("plain-page", "Plain", "x") });
  published(await publishApi("docs", pg.id), "plain page");
  eq((await pointerOf()).list.indexes.journal, live2.list.indexes.journal, "the index is untouched by a page publish:");
});

// P2-PERF finding 1 (PERF-01): a journal post is listed through the journal
// index only, never in list.documents, so the list (which every storefront
// request reads) stays the same size however many posts there are. Each place
// publish.js used a post's list entry now reads its index row; each has a test.

// A post made live straight through the commit, the way publish.js lists it:
// through a new journal index version, with no list.documents entry. With
// oldStyle it also gets its own list.documents entry, as a list written before
// the fix holds.
async function livePostFixture(docId, b, { oldStyle = false, store = "docs" } = {}) {
  return inT(async () => {
    const live = await pointerOf(store);
    const list0 = live.list || L.emptyList(1, R.singletonTypes());
    const at = new Date().toISOString();
    const v = await versionRow({ documentId: docId, kind: "migrated", body: b, schemaVersion: 1, createdAt: at });
    const prevIndex = list0.indexes.journal ? await versionBody(list0.indexes.journal.version, store) : null;
    const iv = await versionRow({ documentId: J.JOURNAL_INDEX_ID, kind: "published", body: J.nextJournalIndexBody(prevIndex, [{ documentId: docId, versionId: v.id, body: b }]), schemaVersion: R.SCHEMA_VERSION, createdAt: at });
    const changes = [{ index: "journal", entry: { version: iv.id, hash: iv.body_hash } }];
    if (oldStyle) changes.push({ document: docId, entry: { version: v.id, hash: v.body_hash } });
    const list = L.setEntries(list0, changes);
    const cur = await current(store, docId);
    const r = await commitPublishBatch({ releaseId: ids.relId(), setId: ids.setId(), pointer: live.pointer, list, versions: [v, iv], documents: [{ id: docId, revision: cur.revision, published_version_id: v.id, published_hash: await R.documentHash(b) }], log: [{ id: ids.logId(), document_id: docId, action: "migrated", to_version_id: v.id }] });
    eq(r.outcome, "ok", "post fixture:");
    return v.id;
  }, store);
}
const indexRowOf = async (docId, store = "docs") => {
  const e = (await pointerOf(store)).list.indexes.journal;
  return e ? J.journalEntriesOf(await versionBody(e.version, store)).find((x) => x.document === docId) ?? null : null;
};

await t("PERF-01: a journal post gets no list.documents entry, so the list stays the same size however many posts go live; its redirects stay listed", async () => {
  const before = await pointerOf();
  const posts = [];
  for (const n of [1, 2, 3]) posts.push(await create("docs", "journal", { body: body("journal", { meta: { slug: `size-post-${n}`, title: `Size ${n}`, ...(n === 1 ? { redirect_from: ["old-size-post"] } : {}) }, sections: [textSec("sec_t1", `Size ${n}`, "Words.")] }) }));
  const r = published(await publishSetApi("docs", posts.map((p) => p.id)), "three posts");
  const live = await pointerOf();
  for (const p of posts) ok(!Object.hasOwn(live.list.documents, p.id), `${p.id} has no list.documents entry`);
  eq(Object.keys(live.list.documents).sort(), Object.keys(before.list.documents).sort(), "list.documents holds the same documents as before:");
  eq(live.list.pages, before.list.pages, "list.pages unchanged:");
  ok(live.list.redirects.some((x) => x.document === posts[0].id && x.from_slug === "old-size-post" && x.to_slug === "size-post-1"), "the post's redirect is listed");
  for (const p of r.published) eq((await indexRowOf(p.id))?.version, p.versionId, `${p.id} is live through the index:`);
  eq((await inT(() => Res.resolvedContentPage("size-post-2")))?.title, "Size 2", "shoppers read the post through the index:");
  eq((await inT(() => Res.resolvedSlugRedirect("old-size-post"))), "size-post-1", "and its redirect:");
  // only the index entry and the redirect differ from the list before
  const strip = (l) => canon({ ...l, indexes: null, redirects: l.redirects.filter((x) => !posts.some((p) => p.id === x.document)) });
  eq(strip(live.list), strip(before.list), "the rest of the list:");
});

await t("PERF-01 (the skip check): a post already live through the index is skipped; one live through an older list's own entry is skipped too, and republishing it after an edit drops that entry and logs its previous version", async () => {
  const p = await create("docs", "journal", { body: page("skip-post", "Skip post", "Words.", "journal") });
  const r1 = published(await publishApi("docs", p.id), "first");
  const before = await dump();
  const again = published(await publishApi("docs", p.id), "again");
  eq([again.release, again.published, again.skipped], [null, [], [p.id]], "skipped through the index row:");
  await unchanged(before, "skip");

  const b = page("old-style-post", "Old style", "Words.", "journal");
  const q = await create("docs", "journal", { body: b });
  const vOld = await livePostFixture(q.id, b, { oldStyle: true });
  ok(Object.hasOwn((await pointerOf()).list.documents, q.id), "the older list holds the post's own entry");
  const before2 = await dump();
  const skip2 = published(await publishApi("docs", q.id), "old style, again");
  eq([skip2.release, skip2.skipped], [null, [q.id]], "skipped:");
  await unchanged(before2, "old-style skip");

  const cur = await current("docs", q.id);
  await save("docs", cur, { ...cur.body, meta: { ...cur.body.meta, title: "Old style (edited)" } });
  const r2 = published(await publishApi("docs", q.id), "old style, edited");
  ok(!Object.hasOwn((await pointerOf()).list.documents, q.id), "the post's own entry is dropped");
  eq((await indexRowOf(q.id))?.version, r2.published[0].versionId, "live through the index:");
  eq((await sql("SELECT from_version_id AS f FROM publish_log WHERE to_version_id = ?", [r2.published[0].versionId]))[0].f, vOld, "the log names the previous version:");

  const cur2 = await current("docs", p.id);
  await save("docs", cur2, { ...cur2.body, meta: { ...cur2.body.meta, title: "Skip post (edited)" } });
  const r3 = published(await publishApi("docs", p.id), "edited");
  eq((await sql("SELECT from_version_id AS f FROM publish_log WHERE to_version_id = ?", [r3.published[0].versionId]))[0].f, r1.published[0].versionId, "the log names the previous version (from the index):");
});

await t("PERF-01 (the inherited rule): a post live through the index with an incomplete section publishes a typo fix with a warning; a new incomplete section still blocks", async () => {
  const old = body("journal", { meta: { slug: "inherited-post", title: "Inherited post" }, sections: [textSec("sec_t1", "Inherited post", "Words."), sec("banner", "sec_old1", { title: "", text: "" })] });
  const d = await create("docs", "journal", { body: page("inherited-post", "Inherited post", "Words.", "journal") });
  await livePostFixture(d.id, old);
  ok(!Object.hasOwn((await pointerOf()).list.documents, d.id), "no list.documents entry");
  const cur = await current("docs", d.id);
  await save("docs", cur, { ...old, meta: { ...old.meta, title: "Inherited post (fixed)" } });
  const r = published(await publishApi("docs", d.id), "typo with an inherited problem");
  const w = r.issues.filter((i) => i.sectionId === "sec_old1");
  ok(w.length > 0 && w.every((i) => i.severity === "warning") && w.some((i) => /already live like this/.test(i.message)), `inherited problems warn: ${JSON.stringify(r.issues).slice(0, 300)}`);
  const cur2 = await current("docs", d.id);
  await save("docs", cur2, { ...cur2.body, sections: [...cur2.body.sections, sec("banner", "sec_new9", { title: "", text: "" })] });
  const blocked = await publishApi("docs", d.id);
  eq(blocked.status, 422, "a new incomplete section:");
});

await t("PERF-01 (the lost check): two concurrent publishes of the same post give one success and one 409; of different posts, both go live", async () => {
  const d = await create("docs", "journal", { body: page("race-post", "Race post", "First.", "journal") });
  let inner = null;
  let loserBuild = null;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (attempt !== 1 || loserBuild) return;
      loserBuild = build;
      Pub.setPublishHooks({}); // the winner runs without the hook
      inner = await publishApi("docs", d.id);
    },
  });
  const loser = await publishApi("docs", d.id);
  Pub.setPublishHooks({});
  published(inner, "winner");
  eq([loser.status, loser.body.code], [409, "PUBLISHED_ELSEWHERE"], `loser: ${JSON.stringify(loser.body).slice(0, 300)}`);
  eq((await indexRowOf(d.id))?.version, inner.body.published[0].versionId, "the winner's version is live:");
  eq(await sql("SELECT id FROM releases WHERE id = ?", [loserBuild.releaseId]), [], "the loser's release was never written:");

  const a = await create("docs", "journal", { body: page("race-post-a", "Race A", "A.", "journal") });
  const b = await create("docs", "journal", { body: page("race-post-b", "Race B", "B.", "journal") });
  let innerB = null;
  let attempts = 0;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (build.documents[0].id !== a.id) return;
      attempts = attempt;
      if (attempt === 1) innerB = await publishApi("docs", b.id);
    },
  });
  const ra = await publishApi("docs", a.id);
  Pub.setPublishHooks({});
  published(innerB, "B");
  published(ra, "A");
  eq(attempts, 2, "A lost once and rebuilt:");
  eq((await indexRowOf(a.id))?.version, ra.body.published[0].versionId, "A live:");
  eq((await indexRowOf(b.id))?.version, innerB.body.published[0].versionId, "B live:");
});

await t("PERF-01 (commit.js liveListHoldsMine): a post's version, which has no list slot, counts as live through this build's own index version, and only then", async () => {
  const at = new Date().toISOString();
  const pb = page("held-post", "Held", "Words.", "journal");
  const pv = await versionRow({ documentId: "doc_heldpost", kind: "published", body: pb, schemaVersion: 1, createdAt: at });
  const iv = await versionRow({ documentId: J.JOURNAL_INDEX_ID, kind: "published", body: J.nextJournalIndexBody(null, [{ documentId: "doc_heldpost", versionId: pv.id, body: pb }]), schemaVersion: 1, createdAt: at });
  const ov = await versionRow({ documentId: J.JOURNAL_INDEX_ID, kind: "published", body: J.nextJournalIndexBody(null, []), schemaVersion: 1, createdAt: at });
  const base = L.emptyList(1, R.singletonTypes());
  const ours = L.setEntries(base, [{ index: "journal", entry: { version: iv.id, hash: iv.body_hash } }]);
  const other = L.setEntries(base, [{ index: "journal", entry: { version: ov.id, hash: ov.body_hash } }]);
  const holds = __commitInternals.liveListHoldsMine;
  eq(holds(ours, ours, [pv, iv]), true, "our index is live, and it names the post:");
  eq(holds(ours, other, [pv, iv]), false, "another index is live:");
  eq(holds(ours, base, [pv, iv]), false, "no index is live:");
  // an index of ours that does not name the version proves nothing about it
  const lone = await versionRow({ documentId: "doc_lonepost", kind: "published", body: pb, schemaVersion: 1, createdAt: at });
  eq(holds(ours, ours, [pv, iv, lone]), false, "a version no slot and no index of ours names:");
  // a page's version still needs its own slot
  const pg = await versionRow({ documentId: "doc_heldpage", kind: "published", body: page("held-page", "Held page"), schemaVersion: 1, createdAt: at });
  const withPage = L.setEntries(ours, [{ document: "doc_heldpage", entry: { version: pg.id, hash: pg.body_hash } }]);
  eq(holds(withPage, withPage, [pv, iv, pg]), true, "page slot and post index both live:");
  eq(holds(withPage, ours, [pv, iv, pg]), false, "the page's slot is not live:");
});

await t("publishing what is already live is skipped (no new release); the set is capped at 200", async () => {
  const before = await dump();
  const r = published(await publishApi("docs", SHIPPING.id), "again");
  eq([r.release, r.published, r.skipped], [null, [], [SHIPPING.id]], "skipped:");
  await unchanged(before, "skip");
  const many = Array.from({ length: 201 }, (_, i) => ({ id: `doc_x${i}`, revision: 1, draftHash: "h" }));
  const big = await api({ publishSet: many });
  eq([big.status, big.body.code], [400, "SET_TOO_LARGE"], "201 documents:");
  await unchanged(before, "too large");
  const svc = await inT(() => Pub.publish({ ids: many.slice(0, 200), actor: ACTOR }).then(() => "ran", (e) => e.status));
  eq(svc, 404, "200 is allowed through to the reads (these ids don't exist):");
});

// =========================================================================================
console.log("— P2-FIX4: structure never inherited, a late commit, and the untested rules");

// A draft written straight into the row, past saveDraft (as a bug, a migration
// or a bypass could leave it), at a new revision.
const rawDraft = async (id, b, store = "docs") => raw[store].execute({ sql: "UPDATE documents SET draft = ?, draft_hash = ?, revision = revision + 1 WHERE id = ?", args: [JSON.stringify(b), await R.documentHash(b), id] });
const indexEntries = async (store = "docs") => {
  const e = (await pointerOf(store)).list.indexes.journal;
  return e ? J.journalEntriesOf(await versionBody(e.version, store)) : [];
};

await t("FIX4 structure: a HIDDEN section with a non-string html (and an object title) is refused at publish; nothing goes live and no raw object reaches a version", async () => {
  const d = await create("docs", "page", { body: page("hidden-raw", "Hidden raw", "Words.") });
  const bad = body("page", { meta: { slug: "hidden-raw", title: "Hidden raw" }, sections: [textSec("sec_t1", "Hidden raw", "Words."), sec("rich_text", "sec_hr1", { title: { evil: 1 }, html: { not: "a string" } }, { enabled: false })] });
  await rawDraft(d.id, bad);
  const before = await dump();
  const r = await publishApi("docs", d.id);
  eq(r.status, 422, `status: ${JSON.stringify(r.body).slice(0, 400)}`);
  eq(r.body.code, "VALIDATION_FAILED", "code:");
  const errs = r.body.issues.filter((i) => i.sectionId === "sec_hr1" && i.severity === "error");
  eq(errs.map((i) => [i.code, i.field]).sort(), [["INVALID_VALUE", "html"], ["INVALID_VALUE", "title"]], "both block, though the section is hidden:");
  ok(errs.every((i) => !/hidden, so it doesn't stop publishing/.test(i.message)), "never worded as a warning");
  await unchanged(before, "hidden structure");
  eq((await pointerOf()).list.documents[d.id], undefined, "not live:");
  eq(await sql("SELECT count(*) AS n FROM document_versions WHERE body LIKE '%a string%' AND kind = 'published'"), [{ n: 0 }], "no published version holds the raw object:");
});

await t("FIX4 structure: an enabled section UNCHANGED from live with title 42 is refused at publish (a typo elsewhere doesn't carry it through)", async () => {
  const d = await create("docs", "page", { body: page("title-42", "Title 42", "Words.") });
  const old = body("page", { meta: { slug: "title-42", title: "Title 42" }, sections: [textSec("sec_t1", "Title 42", "Words."), sec("text", "sec_n42", { title: 42, body: ["Live already."] })] });
  await liveFixture(d.id, old); // live through the commit, past publish validation
  const liveEntry = (await pointerOf()).list.documents[d.id];
  await rawDraft(d.id, { ...old, meta: { ...old.meta, title: "Title 42 (typo fixed)" } });
  const before = await dump();
  const r = await publishApi("docs", d.id);
  eq(r.status, 422, `status: ${JSON.stringify(r.body).slice(0, 400)}`);
  const e = r.body.issues.find((i) => i.sectionId === "sec_n42" && i.field === "title");
  eq([e?.code, e?.severity], ["INVALID_VALUE", "error"], "the inherited title 42 blocks:");
  ok(!/already live like this/.test(e.message), "not worded as inherited");
  await unchanged(before, "inherited structure");
  eq((await pointerOf()).list.documents[d.id], liveEntry, "the live entry is unchanged:");
  // the minimal inherited rule still holds for what is not structure (an incomplete banner)
  const ok2 = body("page", { meta: { slug: "title-42", title: "Title 42" }, sections: [textSec("sec_t1", "Title 42", "Words."), sec("banner", "sec_b42", { title: "", text: "" })] });
  await liveFixture(d.id, ok2);
  await rawDraft(d.id, { ...ok2, meta: { ...ok2.meta, title: "Title 42 again" } });
  const w = published(await publishApi("docs", d.id), "an inherited incomplete banner");
  ok(w.issues.some((i) => i.sectionId === "sec_b42" && i.severity === "warning"), "still only warns");
});

await t("FIX4 late commit: a {lost} whose batch actually committed after the read-back is reported as success, never 'someone else published'", async () => {
  const d = await create("docs", "page", { body: page("late-commit", "Late commit", "Words.") });
  const before = await pointerOf();
  let calls = 0;
  let first = null;
  Pub.setPublishHooks({
    commit: async (b) => {
      calls++;
      if (calls > 1) return commitPublishBatch(b);
      first = b;
      const real = await commitPublishBatch(b); // it really commits ...
      eq(real.outcome, "ok", "the first batch commits:");
      // ... and then the answer says lost, with the pointer from before it
      return { lost: true, outcome: "lost", releaseId: b.releaseId, pointer: before.pointer, list: before.list, cause: new Error("fetch failed") };
    },
  });
  const r = await publishApi("docs", d.id);
  Pub.setPublishHooks({});
  eq(r.status, 200, `status: ${JSON.stringify(r.body).slice(0, 400)}`);
  ok(!/someone else/i.test(JSON.stringify(r.body)), "never 'someone else published'");
  eq(r.body.release.id, first.releaseId, "the release that went live:");
  eq(r.body.published, [{ id: d.id, versionId: first.documents[0].published_version_id, hash: first.documents[0].published_hash, liveUrl: "/api/preview?exit=1&to=%2Fpolicies%2Flate-commit", undo: { id: d.id, revision: d.revision, logId: first.log[0].id } }], "its published version (P3-CHECKS: with liveUrl and undo of the build that went live):");
  const live = await pointerOf();
  eq(live.pointer, first.releaseId, "live pointer:");
  eq(live.list.documents[d.id].version, first.documents[0].published_version_id, "live entry:");
  eq(calls, 2, "the second (rebuilt) batch was refused by the guard, then recognised:");
  eq((await sql("SELECT count(*) AS n FROM publish_log WHERE document_id = ?", [d.id]))[0].n, 1, "one log row:");
  eq((await sql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'published'", [d.id]))[0].n, 1, "one published version:");
  // the audit is written for it, as for any success
  eq((await C.platformDb().execute({ sql: "SELECT count(*) AS n FROM audit_log WHERE tenant_id = 'psdocs' AND action = 'storefront.publish' AND resource = ?", args: [`release:${first.releaseId}`] })).rows[0].n, 1, "audited:");
});

await t("FIX4 late commit, journal post (batch 5 merge with PERF-01): a post has no list entry, so its own late batch is found through the journal index and reported as success", async () => {
  const d = await create("docs", "journal", { body: page("late-post", "Late post", "Words.", "journal") });
  const before = await pointerOf();
  let calls = 0;
  let first = null;
  Pub.setPublishHooks({
    commit: async (b) => {
      calls++;
      if (calls > 1) return commitPublishBatch(b);
      first = b;
      const real = await commitPublishBatch(b);
      eq(real.outcome, "ok", "the first batch commits:");
      return { lost: true, outcome: "lost", releaseId: b.releaseId, pointer: before.pointer, list: before.list, cause: new Error("fetch failed") };
    },
  });
  const r = await publishApi("docs", d.id);
  Pub.setPublishHooks({});
  eq(r.status, 200, `status: ${JSON.stringify(r.body).slice(0, 400)}`);
  ok(!/someone else/i.test(JSON.stringify(r.body)), "never 'someone else published'");
  eq(r.body.release.id, first.releaseId, "the release that went live:");
  const live = await pointerOf();
  eq(live.pointer, first.releaseId, "live pointer:");
  ok(!Object.hasOwn(live.list.documents, d.id), "the post has no list entry (PERF-01)");
  eq(calls, 2, "the rebuilt batch was refused by the guard, then the first recognised:");
  eq((await sql("SELECT count(*) AS n FROM publish_log WHERE document_id = ?", [d.id]))[0].n, 1, "one log row:");
});

await t("FIX4 R1: the journal index is re-read on every attempt: a post published while another post's publish rebuilds stays in /journal", async () => {
  const a = await create("docs", "journal", { body: page("r1-post-a", "R1 A", "A.", "journal") });
  const b = await create("docs", "journal", { body: page("r1-post-b", "R1 B", "B.", "journal") });
  let inner = null;
  let attempts = 0;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (build.documents[0].id !== a.id) return;
      attempts = attempt;
      if (attempt === 1) inner = await publishApi("docs", b.id);
    },
  });
  const ra = published(await publishApi("docs", a.id), "post A");
  Pub.setPublishHooks({});
  published(inner, "post B");
  eq(attempts, 2, "A rebuilt once:");
  const entries = (await indexEntries()).filter((e) => e.slug.startsWith("r1-"));
  eq(entries.map((e) => [e.slug, e.version]), [["r1-post-a", ra.published[0].versionId], ["r1-post-b", inner.body.published[0].versionId]], "both posts in the index:");
  ok((await inT(() => Res.resolvedJournalEntries())).some((e) => e.slug === "r1-post-b"), "B in shoppers' journal");
});

await t("FIX4 R2 and R4: republishing a post replaces its index entry (no duplicate); the entry's enabled follows the post", async () => {
  const p = await create("docs", "journal", { body: page("r2-post", "R2 first", "One.", "journal") });
  published(await publishApi("docs", p.id), "first");
  const cur = await current("docs", p.id);
  await save("docs", cur, body("journal", { meta: { slug: "r2-post", title: "R2 second", enabled: false }, sections: [textSec("sec_t1", "R2", "Two.")] }));
  const r = published(await publishApi("docs", p.id), "again, hidden");
  const mine = (await indexEntries()).filter((e) => e.document === p.id);
  eq(mine.map((e) => [e.slug, e.title, e.version, e.enabled]), [["r2-post", "R2 second", r.published[0].versionId, false]], "one entry, the new one, disabled:");
  ok(!(await inT(() => Res.resolvedJournalEntries())).some((e) => e.slug === "r2-post"), "a disabled post is not listed for shoppers");
});

await t("FIX4 R5: an archived document is refused (409 DOCUMENT_ARCHIVED) with nothing written", async () => {
  const d = await create("docs", "page", { body: page("r5-archived", "R5", "Words.") });
  await raw.docs.execute({ sql: "UPDATE documents SET archived_at = ? WHERE id = ?", args: [new Date().toISOString(), d.id] });
  const before = await dump();
  const r = await publishApi("docs", d.id);
  eq([r.status, r.body.code], [409, "DOCUMENT_ARCHIVED"], `refused: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(/was archived, so nothing was published/.test(r.body.error), r.body.error);
  await unchanged(before, "archived");
});

await t("FIX4 R6: a page may not take the slug of a live journal post (the index entries count)", async () => {
  const post = await create("docs", "journal", { body: page("r6-shared", "R6 post", "Post.", "journal") });
  published(await publishApi("docs", post.id), "the post");
  // the post's draft moves away (unpublished), freeing the slug for a new draft
  await save("docs", await current("docs", post.id), page("r6-moved", "R6 post", "Post.", "journal"));
  const pg = await create("docs", "page", { body: page("r6-shared", "R6 page", "Page.") });
  const before = await dump();
  const r = await publishApi("docs", pg.id);
  eq([r.status, r.body.code], [409, "SLUG_TAKEN"], `refused: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(r.body.other, { id: post.id, title: "R6 post" }, "names the post:");
  await unchanged(before, "slug vs post");
});

await t("FIX4 R19: the slug check runs on every attempt: a page made live at the same slug during the first attempt refuses the rebuild", async () => {
  const x = await create("docs", "page", { body: page("r19-slug", "R19 X", "X.") });
  const y = await create("docs", "page", { body: page("r19-other", "R19 Y", "Y.") });
  let attempts = 0;
  Pub.setPublishHooks({
    beforeCommit: async ({ attempt, build }) => {
      if (build.documents[0].id !== x.id) return;
      attempts = attempt;
      if (attempt === 1) await liveFixture(y.id, page("r19-slug", "R19 Y", "Y.")); // Y goes live at /r19-slug past the service
    },
  });
  const r = await publishApi("docs", x.id);
  Pub.setPublishHooks({});
  eq([r.status, r.body.code], [409, "SLUG_TAKEN"], `refused on the rebuild: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(attempts, 1, "no second batch was built:");
  const rows = (await pointerOf()).list.pages.filter((p) => p.slug === "r19-slug");
  eq(rows.map((p) => p.document), [y.id], "one live row at the slug:");
});

await t("FIX4 R11: a successful publish writes its audit row (storefront.publish, release:<id>)", async () => {
  const d = await create("docs", "page", { body: page("r11-audit", "R11", "Words.") });
  const r = published(await publishApi("docs", d.id), "audited");
  const rows = (await C.platformDb().execute({ sql: "SELECT actor, action, resource, diff FROM audit_log WHERE tenant_id = 'psdocs' AND resource = ?", args: [`release:${r.release.id}`] })).rows;
  eq(rows.length, 1, "one audit row:");
  eq([rows[0].actor, rows[0].action], [ownerU.id, "storefront.publish"], "who and what:");
  ok(String(rows[0].diff).includes(d.id), `names the document: ${rows[0].diff}`);
});

await t("FIX4 R15: publish_log.from_version_id records the version that was live before (null on a first publish)", async () => {
  const d = await create("docs", "page", { body: page("r15-from", "R15", "One.") });
  const v1 = published(await publishApi("docs", d.id), "first").published[0].versionId;
  await save("docs", await current("docs", d.id), page("r15-from", "R15", "Two."));
  const v2 = published(await publishApi("docs", d.id), "second").published[0].versionId;
  const log = await sql("SELECT from_version_id, to_version_id FROM publish_log WHERE document_id = ? ORDER BY rowid", [d.id]);
  eq(log.map((l) => [l.from_version_id, l.to_version_id]), [[null, v1], [v1, v2]], "from and to:");
});

await t("FIX4 R16: list.pages keeps a campaign's window_start and window_end (a scheduled campaign is not shown early)", async () => {
  const c = await create("docs", "campaign", { body: body("campaign", { meta: { slug: "r16-sale", title: "R16 sale", window_start: "2099-01-01T00:00:00.000Z", window_end: "2099-02-01T00:00:00.000Z" }, sections: [textSec("sec_t1", "Sale", "Soon.")] }) });
  published(await publishApi("docs", c.id), "campaign");
  const row = (await pointerOf()).list.pages.find((p) => p.slug === "r16-sale");
  eq([row?.window_start, row?.window_end], ["2099-01-01T00:00:00.000Z", "2099-02-01T00:00:00.000Z"], "the window:");
  // the campaign route's own check (app/(storefront)/campaigns/[slug]) on what the reader returns
  const { campaignVisible } = await import("../lib/content/pages.js");
  eq(campaignVisible(await inT(() => Res.resolvedContentPage("r16-sale"))), false, "not shown before its window:");
});

await t("FIX4 R20: a document deleted while a lost publish re-reads answers the 'deleted' message (404), never a skip or a success", async () => {
  const d = await create("docs", "page", { body: page("r20-gone", "R20", "Words.") });
  const other = await create("docs", "page", { body: page("r20-stays", "R20 stays", "Words.") });
  let calls = 0;
  Pub.setPublishHooks({
    commit: async () => {
      calls++;
      await raw.docs.execute({ sql: "DELETE FROM documents WHERE id = ?", args: [d.id] });
      const live = await inT(() => pointerOf());
      return { lost: true, outcome: "lost", pointer: live.pointer, list: live.list, cause: new Error("guard") };
    },
  });
  const written = async () => canon({ releases: await sql("SELECT id FROM releases ORDER BY rowid"), state: await sql("SELECT * FROM release_state"), log: await sql("SELECT id FROM publish_log ORDER BY rowid"), published: await sql("SELECT id FROM document_versions WHERE kind = 'published' ORDER BY rowid") });
  const before = await written();
  const r = await publishSetApi("docs", [d.id, other.id]);
  Pub.setPublishHooks({});
  eq([r.status, r.body.code], [404, "DOCUMENT_DELETED"], `answer: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(r.body.error, Pub.DELETED_MESSAGE, "words:");
  eq(calls, 1, "no rebuild:");
  eq(await written(), before, "nothing published:");
  eq((await pointerOf()).list.documents[other.id], undefined, "the other page of the set is not live:");
});

await t("FIX4 DOC-10: meta.redirect_from publishes a redirect from the old address to the new slug, in the same release", async () => {
  const d = await create("docs", "page", { body: page("old-addr", "Moving page", "Words.") });
  published(await publishApi("docs", d.id), "at the old address");
  await save("docs", await current("docs", d.id), body("page", { meta: { slug: "new-addr", title: "Moving page", redirect_from: ["old-addr"] }, sections: [textSec("sec_t1", "Moving page", "Words.")] }));
  const r = published(await publishApi("docs", d.id), "moved");
  const live = await pointerOf();
  eq(live.pointer, r.release.id, "the same release:");
  eq(live.list.redirects.filter((x) => x.document === d.id).map((x) => [x.from_slug, x.to_slug]), [["old-addr", "new-addr"]], "the redirect row:");
  eq(live.list.pages.filter((p) => p.document === d.id).map((p) => p.slug), ["new-addr"], "the page row moved:");
  eq(await inT(() => Res.resolvedSlugRedirect("old-addr")), "new-addr", "shoppers are sent on:");
});

// =========================================================================================
console.log("— the API (storefront.publish, modes, product content)");

await t("API: staff without storefront.publish get 403 with storage unchanged; a tenant whose stored mode is not documents gets 500 STORE_MODE_INVALID; product_content publishes as a live row with no release (P4-LIVEROW)", async () => {
  const d = await create("docs", "page", { body: page("staff-try", "Staff try", "x") });
  const before = await dump();
  const staff = await publishApi("docs", d.id, { as: STAFF });
  eq(staff.status, 403, "staff publish:");
  const staffSet = await publishSetApi("docs", [d.id], { as: STAFF });
  eq(staffSet.status, 403, "staff publishSet:");
  const signedOut = await api({ publish: { id: d.id, draftHash: "x" }, revision: 1 }, { as: null });
  eq(signedOut.status, 401, "signed out:");
  // staff can still save (storefront.write)
  eq((await api({ getDocument: d.id }, { as: STAFF })).status, 200, "staff can read:");
  await unchanged(before, "403");

  const legacyBefore = await dump("legacy");
  const lg = await api({ publish: { id: "doc_home", draftHash: "x" }, revision: 1 }, { store: "legacy" });
  eq([lg.status, lg.body.code], [500, "STORE_MODE_INVALID"], "a store whose stored mode is 'legacy':");
  ok(/nothing changed/.test(lg.body.error), "plain words");
  const lgSvc = await inT(() => Pub.publish({ ids: [{ id: "doc_home", revision: 1, draftHash: "x" }] }).then(() => "ran", (e) => e.code), "legacy");
  eq(lgSvc, "STORE_MODE_INVALID", "the service refuses too:");
  await unchanged(legacyBefore, "legacy", "legacy");

  // P4-LIVEROW (OVL-02): product content publishes now, as a live row: no
  // release, the release pointer untouched (scripts/test-product-content.js
  // covers the rest)
  // P4-SEARCH: a product's content publishes only while the product is in the catalog
  await sql("INSERT INTO products (id, handle, title, available) VALUES ('gid://shopify/Product/9', 'ps-nine', 'Product nine', 1) ON CONFLICT(id) DO NOTHING");
  const content = await create("docs", "product_content", { entityId: "gid://shopify/Product/9" });
  const releasesBefore = await sql("SELECT id FROM releases ORDER BY rowid");
  const stateBefore = await sql("SELECT live_release_id FROM release_state");
  const pc = await publishApi("docs", content.id);
  eq([pc.status, pc.body.release, pc.body.published.map((x) => x.id)], [200, null, [content.id]], "product content:");
  eq(await sql("SELECT id FROM releases ORDER BY rowid"), releasesBefore, "no release row:");
  eq(await sql("SELECT live_release_id FROM release_state"), stateBefore, "the pointer:");
  eq((await sql("SELECT document_id FROM product_content_live WHERE product_id = ?", ["gid://shopify/Product/9"]))[0]?.document_id, content.id, "the live row:");

  // missing revision or draft hash: 428, after authorization
  const before2 = await dump();
  eq((await api({ publish: { id: d.id, draftHash: "x" } })).status, 428, "no revision:");
  eq((await api({ publish: { id: d.id }, revision: 1 })).body.code, "REVIEW_REQUIRED", "no draft hash:");
  eq((await api({ publish: { id: d.id }, revision: 1 }, { as: STAFF })).status, 403, "staff hear 403 first:");
  eq((await api({ publishSet: [{ id: d.id, draftHash: "x" }] })).status, 428, "set without a revision:");
  eq((await api({ publishSet: [{ id: d.id, revision: 1, draftHash: "x" }], revision: 1 })).status, 400, "a top-level revision with a set:");
  await unchanged(before2, "428s");
});

await t("a documents-mode store whose live release is still version 1 to 3 is refused with 409 'This store still publishes with Releases'", async () => {
  await raw.rel.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_v3', ?, 'h3', '', NULL, '2026-11-01T00:00:00.000Z', NULL, '2026-11-01T00:00:00.000Z')", args: [JSON.stringify({ v: 3, blocks: {}, pages: [] })] });
  await raw.rel.execute("UPDATE release_state SET live_release_id = 'rel_v3' WHERE id = 1");
  const d = await create("rel", "page", { body: page("terms", "Terms", "x") });
  const before = await dump("rel");
  const r = await publishApi("rel", d.id);
  eq([r.status, r.body.code], [409, "STORE_USES_RELEASES"], "refused:");
  ok(r.body.error.startsWith("This store still publishes with Releases"), r.body.error);
  await unchanged(before, "legacy pointer", "rel");
});

await t("journal-index.js is edge-safe: no node: imports, no process, no Buffer", async () => {
  const src = await readFile(join(ROOT, "lib/documents/journal-index.js"), "utf8");
  ok(!/from\s+["']node:|require\(|\bprocess\.|\bBuffer\b/.test(src), "edge-safe");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  eq(imports, ["../registry/index.js"], "imports:");
});

// =========================================================================================
// P3-COMMIT: the shared build (lib/documents/build.js), refs, paths and the API.
console.log("— P3-COMMIT: the build, refs, take offline, after-commit, paths and the new API operations");

const B = await import("../lib/documents/build.js");
const Refs = await import("../lib/documents/refs.js");
const Paths = await import("../lib/documents/paths.js");
const After = await import("../lib/documents/after-commit.js");
const Api = await import("../lib/admin/documents-api.js");
const { SHAPES, COMMON } = await import("../lib/admin/documents-api-shapes.js");
const { watchStatements } = await import("./support/request-cache.js");

// Every log line printed while fn runs, parsed.
async function logsOf(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => {
    const s = a.join(" ");
    try {
      lines.push(JSON.parse(s));
    } catch {
      orig(...a);
    }
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig;
  }
}
// The same keys as a shapes example, all the way down (the first element of a
// list), leaving out the optional paths.
// A document's body is the founder's content, not part of the contract.
const FREE = new Set(["document.body", "current.body", "documents[].body"]);
function sameKeys(got, want, optional = [], path = "") {
  if (FREE.has(path)) return;
  if (Array.isArray(want)) {
    ok(Array.isArray(got), `${path || "body"} is a list`);
    if (want.length && got.length) sameKeys(got[0], want[0], optional, `${path}[]`);
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
const shapeOf = (op, name) => (SHAPES[op].outcomes || SHAPES[SHAPES[op].sameOutcomesAs].outcomes)[name];
const likeShape = (r, o, label) => {
  eq(r.status, o.status, `${label} status:`);
  sameKeys(r.body, o.body, o.optional || []);
  if (o.body.code) eq(r.body.code, o.body.code, `${label} code:`);
};

await t("P3-COMMIT: published_hash is documentHash(body), never the version's body_hash: two bodies whose section ids differ get the same hash", async () => {
  const doc = { id: "doc_hashprobe0000001", type: "page", revision: 1, label: "Probe", publishedVersionId: null };
  const b1 = page("probe", "Probe", "Same words.");
  const b2 = { ...b1, sections: b1.sections.map((s) => ({ ...s, id: "sec_other1" })) };
  ok(b1.sections[0].id !== b2.sections[0].id, "the ids differ");
  const live = { pointer: null, list: L.emptyList(1, R.singletonTypes()) };
  const at = new Date().toISOString();
  const x1 = await B.makeBuild(live, [{ doc, body: b1, liveEntry: null }], { by: "t", at, journal: { body: null } });
  const x2 = await B.makeBuild(live, [{ doc, body: b2, liveEntry: null }], { by: "t", at, journal: { body: null } });
  eq(x1.documents[0].published_hash, await R.documentHash(b1), "build 1:");
  eq(x2.documents[0].published_hash, x1.documents[0].published_hash, "the same content, other ids, the same hash:");
  ok(x1.versions[0].body_hash !== x2.versions[0].body_hash, "the version body_hash keeps the ids, so it differs");
  ok(x1.documents[0].published_hash !== x1.versions[0].body_hash, "published_hash is not the body_hash");
  // and through a real publish
  const d = await create("docs", "page", { body: b1 });
  const r = published(await publishApi("docs", d.id), "probe");
  const row = (await sql("SELECT published_hash, draft_hash FROM documents WHERE id = ?", [d.id]))[0];
  const v = (await sql("SELECT body_hash FROM document_versions WHERE id = ?", [r.published[0].versionId]))[0];
  eq(row.published_hash, row.draft_hash, "documents.published_hash equals the draft hash (both documentHash):");
  ok(row.published_hash !== v.body_hash, "and not the version's body_hash");
});

await t("P3-COMMIT: a draft rewrite onto a slug another non-archived draft holds is 409 SLUG_TAKEN naming it (not DB_REFUSED, not 500); draftSlugOwner names that document", async () => {
  const owner = await create("docs", "page", { body: page("held-address", "Holder page", "x") });
  const mover = await create("docs", "page", { body: page("mover-address", "Mover", "x") });
  eq(await inT(() => B.draftSlugOwner("held-address", mover.id)), { id: owner.id, label: "Holder page" }, "draftSlugOwner:");
  eq(await inT(() => B.draftSlugOwner("held-address", owner.id)), null, "not itself:");
  eq(await inT(() => B.draftSlugOwner("nobody-here", mover.id)), null, "a free slug:");
  const before = await dump();
  const target = page("held-address", "Mover", "earlier words");
  let e = null;
  await inT(async () => {
    const live = await B.readLive();
    const d = await Docs.getDocument(mover.id);
    try {
      await B.runGuardedBuild(
        ({ live: from, refs }) =>
          B.makeBuild(from, [{ doc: d, body: target, action: "undo", draft: { body: target, hash: "dh_x", slug: "held-address", label: "Mover" }, liveEntry: null }], { by: "merchant:x", at: new Date().toISOString(), journal: { body: null }, refs }),
        { live, done: (b) => b, onLost: async () => null },
      );
    } catch (err) {
      e = err;
    }
  });
  ok(e, "refused");
  eq([e.status, e.code], [409, "SLUG_TAKEN"], "refusal:");
  eq(e.extra, { slug: "held-address", other: { id: owner.id, title: "Holder page", label: "Holder page" } }, "names the other page:");
  eq(e.message, "Another page already uses /held-address: Holder page", "words:");
  sameKeys({ error: e.message, code: e.code, ...e.extra }, SHAPES.undo.outcomes.slugTaken.body);
  await unchanged(before, "slug taken");
});

await t("P3-COMMIT: a publish on a documents store without 0023 succeeds, writes no refs and logs document_refs_missing; the probe is one statement per publish until 0023 runs", async () => {
  B.__forgetRefsTable();
  // P3-CHECKS: the store opens with its home page first (FIRST_PUBLISH_NEEDS_HOME)
  const home = await create("pre23", "home", { body: body("home", { sections: [sec("hero", "sec_hero", { title: "Pre refs home" })] }) });
  published(await publishApi("pre23", home.id), "the home page opens the store");
  B.__forgetRefsTable();
  const d = await create("pre23", "page", { body: page("pre-refs", "Pre refs", "x") });
  const { currentDatabase } = await import("../lib/db.js");
  const run = () => inT(() => watchStatements(currentDatabase().libsql, () => publishApi("pre23", d.id)), "pre23");
  const { result: { result: r, statements }, lines } = await logsOf(run);
  published(r, "pre-0023 publish");
  eq(statements.filter((s) => /sqlite_master/.test(s)).length, 1, "one probe statement:");
  ok(!statements.some((s) => /document_refs/.test(s) && !/sqlite_master/.test(s)), "no refs statement was sent");
  ok(lines.some((l) => l.evt === "document_refs_missing"), "document_refs_missing is logged");
  eq((await sql("SELECT count(*) AS n FROM sqlite_master WHERE name = 'document_refs'", [], "pre23"))[0].n, 0, "still no table:");
  // a missing table is asked again: the next publish probes again
  await save("pre23", await current("pre23", d.id), page("pre-refs", "Pre refs", "y"));
  const again = await logsOf(run);
  published(again.result.result, "second");
  eq(again.result.statements.filter((s) => /sqlite_master/.test(s)).length, 1, "probed again:");
  // once 0023 runs, the very next publish writes refs
  await runMigrations(raw.pre23, MIGRATIONS);
  await save("pre23", await current("pre23", d.id), body("page", { meta: { slug: "pre-refs", title: "Pre refs" }, sections: [sec("product_rail", "sec_r1", { title: "Rail", collection: { handle: "shirts" } })] }));
  const third = await logsOf(run);
  const p3 = published(third.result.result, "after 0023");
  eq((await sql("SELECT ref_type, ref_id FROM document_refs WHERE version_id = ?", [p3.published[0].versionId], "pre23")), [{ ref_type: "collection", ref_id: "shirts" }], "refs after 0023:");
  ok(!third.lines.some((l) => l.evt === "document_refs_missing"), "nothing missing any more");
  // and the yes is remembered: no probe on the next publish
  await save("pre23", await current("pre23", d.id), page("pre-refs", "Pre refs", "z"));
  const fourth = await logsOf(run);
  published(fourth.result.result, "fourth");
  eq(fourth.result.statements.filter((s) => /sqlite_master/.test(s)).length, 0, "no probe once seen:");
});

const linkingPage = (slug, title, links, type = "page") =>
  body(type, {
    meta: { slug, title },
    sections: [
      ...links.map((link, i) => sec("banner", `sec_bn${i}`, { title: `Banner ${i}`, text: "x", button: { label: "Go", link } })),
      sec("product_rail", "sec_rl1", { title: "Rail", collection: { handle: "linen" } }),
    ],
  });

await t("P3-COMMIT: with 0023 every published version has refs equal to refRows(body); linkersStatement returns exactly the live documents linking by id or by slug, ignoring drafts and superseded versions", async () => {
  B.__forgetRefsTable();
  const target = await create("docs", "page", { body: page("link-target", "Link target", "x") });
  const byId = await create("docs", "page", { body: linkingPage("links-by-id", "Links by id", [{ type: "page", family: "page", slug: "link-target", document: target.id }]) });
  const bySlug = await create("docs", "campaign", { body: linkingPage("links-by-slug", "Links by slug", [{ type: "page", family: "page", slug: "link-target" }], "campaign") });
  const byUrl = await create("docs", "journal", { body: linkingPage("links-by-url", "Links by url", [{ type: "url", href: "/policies/link-target" }], "journal") });
  const draftOnly = await create("docs", "page", { body: linkingPage("links-draft-only", "Draft only", [{ type: "page", family: "page", slug: "link-target", document: target.id }]) });
  const superseded = await create("docs", "page", { body: linkingPage("links-once", "Linked once", [{ type: "page", family: "page", slug: "link-target", document: target.id }]) });
  const r = published(await publishSetApi("docs", [target.id, byId.id, bySlug.id, byUrl.id, superseded.id]), "the set");
  for (const p of r.published) {
    const want = Refs.refRows(p.versionId, await versionBody(p.versionId));
    eq(await sql("SELECT version_id, ref_type, ref_id FROM document_refs WHERE version_id = ? ORDER BY ref_type, ref_id", [p.versionId]), want, `${p.id} refs:`);
  }
  // the journal index version carries none
  eq((await sql("SELECT count(*) AS n FROM document_refs WHERE version_id = ?", [(await pointerOf()).list.indexes.journal.version]))[0].n, 0, "index refs:");
  // the once-linking page is published again without the link: its old version is superseded
  await save("docs", await current("docs", superseded.id), page("links-once", "Linked once", "no link now"));
  published(await publishApi("docs", superseded.id), "superseded");
  // the draft-only page gets a link in its draft but is never published
  void draftOnly;
  const st = Refs.linkersStatement(target.id, Refs.slugKey("page", "link-target"));
  const rows = (await raw.docs.execute(st)).rows.map((x) => ({ id: String(x.id), label: String(x.label) }));
  eq(rows.map((x) => x.id).sort(), [byId.id, bySlug.id, byUrl.id].sort(), "linkers:");
  ok(rows.every((x) => typeof x.label === "string" && x.label), "each with its label");
  // by id only (no slug key)
  eq((await raw.docs.execute(Refs.linkersStatement(target.id))).rows.map((x) => String(x.id)), [byId.id], "by id only:");
});

await t("P3-COMMIT: refs.js and paths.js are edge-safe (no node:, process or Buffer; refs.js imports only the registry; paths.js imports nothing)", async () => {
  for (const [f, want] of [["lib/documents/refs.js", ["../registry/index.js", "../registry/settings.js"]], ["lib/documents/paths.js", []]]) {
    const src = await readFile(join(ROOT, f), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    ok(!/from\s+["']node:|require\(|\bprocess\.|\bBuffer\b/.test(code), `${f} edge-safe`);
    eq([...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]), want, `${f} imports:`);
  }
});

// Take a document offline straight through the build (P3-UNDO's job later):
// the last live body, a fresh version, enabled false.
async function takeOffline(store, id, { action = "unpublish" } = {}) {
  return inT(async () => {
    const live = await B.readLive();
    const d = await Docs.getDocument(id);
    const journal = live.list.indexes?.journal ? await B.journalIndexOf(live.list) : { body: null };
    const liveEntry = B.liveEntryOf(live.list, journal.body, d);
    const liveBody = (await B.readVersionBodies([liveEntry.version])).get(liveEntry.version).body;
    return B.runGuardedBuild(
      ({ live: from, refs }) =>
        B.makeBuild(from, [{ doc: d, body: liveBody, offline: true, action, undone: d.publishedVersionId, liveEntry }], { by: "merchant:x", at: new Date().toISOString(), journal, refs }),
      { live, done: (b) => b, onLost: async () => null },
    );
  }, store);
}

await t("P3-COMMIT: an offline page writes enabled:false with an unchanged documentHash, drops its redirects, nulls its pointer; liveEntryOf gives liveBody null; shoppers don't see it", async () => {
  const d = await create("docs", "page", { body: body("page", { meta: { slug: "off-page", title: "Off page", redirect_from: ["old-off-page"] }, sections: [textSec("sec_t1", "Off", "Words.")] }) });
  const pub = published(await publishApi("docs", d.id), "live");
  const before = await current("docs", d.id);
  eq(await inT(() => Res.resolvedSlugRedirect("old-off-page")), "off-page", "the redirect is live first:");
  const b = await takeOffline("docs", d.id);
  const live = await pointerOf();
  eq(live.pointer, b.releaseId, "live:");
  const entry = live.list.documents[d.id];
  ok(entry && entry.version !== pub.published[0].versionId, "the entry stays, at a fresh version");
  const offBody = await versionBody(entry.version);
  eq(await R.documentHash(offBody), before.publishedHash, "the body is not edited: documentHash unchanged:");
  eq(live.list.pages.filter((p) => p.document === d.id).map((p) => [p.slug, p.enabled]), [["off-page", false]], "the pages row:");
  eq(live.list.redirects.filter((x) => x.document === d.id), [], "its redirects are dropped:");
  eq(await inT(() => Res.resolvedSlugRedirect("old-off-page")), null, "and shoppers aren't sent on:");
  const now = await current("docs", d.id);
  eq([now.publishedVersionId, now.publishedHash, now.undoneVersionId, now.draftHash, now.revision], [null, null, pub.published[0].versionId, before.draftHash, before.revision], "the documents row:");
  const le = B.liveEntryOf(live.list, null, now);
  eq([le.offline, le.liveBody, le.version], [true, null, entry.version], "liveEntryOf:");
  eq((await sql("SELECT action, from_version_id, to_version_id FROM publish_log WHERE set_id = ?", [b.setId])).map((x) => [x.action, x.from_version_id, x.to_version_id]), [["unpublish", pub.published[0].versionId, entry.version]], "log:");
  eq(await inT(() => Res.resolvedContentPage("off-page")), null, "shoppers don't see the page:");
  // publishing again writes the redirects again from the body, and is live
  // (the same content as taken offline: P3-CHECKS asks for the founder's yes)
  eq((await publishApi("docs", d.id)).body.code, "REPUBLISH_CONFIRM_NEEDED", "the same content needs a yes:");
  const again = published(await publishApi("docs", d.id, { confirmRepublish: true }), "again");
  const l2 = await pointerOf();
  eq(l2.list.pages.filter((p) => p.document === d.id).map((p) => p.enabled), [true], "back on:");
  eq(l2.list.redirects.filter((x) => x.document === d.id).map((x) => x.from_slug), ["old-off-page"], "redirects written again:");
  eq((await current("docs", d.id)).publishedVersionId, again.published[0].versionId, "pointer:");
});

await t("P3-COMMIT: an offline page is not 'inherited': its unchanged incomplete section blocks the next publish (the inherited rule needs a live body)", async () => {
  const d = await create("docs", "page", { body: page("off-inherit", "Off inherit", "Words.") });
  published(await publishApi("docs", d.id), "live");
  // an incomplete section that is live as it is
  const withGap = body("page", { meta: { slug: "off-inherit", title: "Off inherit" }, sections: [textSec("sec_t1", "Off inherit", "Words."), sec("text", "sec_gap1", { title: "", body: [] })] });
  await liveFixture(d.id, withGap);
  await save("docs", await current("docs", d.id), withGap);
  const warns = await publishApi("docs", d.id);
  eq(warns.status, 200, `live as it is: inherited, it only warns (${JSON.stringify(warns.body).slice(0, 200)})`);
  ok(warns.body.skipped.includes(d.id) || warns.body.issues.some((i) => /already live/.test(i.message)), "inherited");
  await takeOffline("docs", d.id);
  const blocked = await publishApi("docs", d.id);
  eq([blocked.status, blocked.body.code], [422, "VALIDATION_FAILED"], "offline: the same section now blocks:");
});

await t("P3-COMMIT: an offline journal post's index entry is enabled:false (the override), its hash unchanged; liveEntryOf gives liveBody null; shoppers' journal leaves it out", async () => {
  const p = await create("docs", "journal", { body: page("off-post", "Off post", "Post words.", "journal") });
  const pub = published(await publishApi("docs", p.id), "post");
  const before = await current("docs", p.id);
  eq((await inT(() => Res.resolvedJournalEntries())).some((e) => e.slug === "off-post"), true, "listed first:");
  await takeOffline("docs", p.id);
  const live = await pointerOf();
  ok(!Object.hasOwn(live.list.documents, p.id), "still no list.documents entry (PERF-01)");
  const ib = await versionBody(live.list.indexes.journal.version);
  const row = J.journalEntriesOf(ib).find((e) => e.document === p.id);
  eq(row.enabled, false, "index entry:");
  ok(row.version !== pub.published[0].versionId, "a fresh version");
  eq(await R.documentHash(await versionBody(row.version)), before.publishedHash, "hash unchanged:");
  const le = B.liveEntryOf(live.list, ib, await current("docs", p.id));
  eq([le.offline, le.liveBody], [true, null], "liveEntryOf:");
  eq((await inT(() => Res.resolvedJournalEntries())).some((e) => e.slug === "off-post"), false, "shoppers' journal:");
  // the override itself, pure
  const pure = J.nextJournalIndexBody(ib, [], { disabled: [] });
  eq(J.journalEntriesOf(pure).find((e) => e.document === p.id).enabled, false, "kept entries keep their state:");
  const on = J.nextJournalIndexBody(null, [{ documentId: p.id, versionId: row.version, body: before.body }], { disabled: [p.id] });
  eq(J.journalEntriesOf(on)[0].enabled, false, "the override disables an added entry:");
  eq(J.journalEntriesOf(J.nextJournalIndexBody(null, [{ documentId: p.id, versionId: row.version, body: before.body }])).at(0).enabled, true, "without it, the body decides:");
});

await t("P3-COMMIT: a non-archived offline page keeps its slug (409 SLUG_TAKEN); once archived, a publish claiming it releases it and drops its entry", async () => {
  const off = await create("docs", "page", { body: page("keep-addr", "Keeper", "x") });
  published(await publishApi("docs", off.id), "live");
  await takeOffline("docs", off.id);
  // its draft moves on to another address, so the old one is free in drafts
  await save("docs", await current("docs", off.id), page("keeper-moved", "Keeper", "x"));
  const claim = await create("docs", "page", { body: page("keep-addr", "Claimer", "y") });
  const before = await dump();
  const refused = await publishApi("docs", claim.id);
  eq([refused.status, refused.body.code], [409, "SLUG_TAKEN"], "the offline page still holds it:");
  eq(refused.body.other.id, off.id, "names the offline page:");
  await unchanged(before, "slug kept");
  // archive the offline page (it is not live: published_version_id is null)
  const ar = await api({ archive: off.id, revision: (await current("docs", off.id)).revision });
  eq(ar.status, 200, `archive: ${JSON.stringify(ar.body).slice(0, 200)}`);
  const r = published(await publishApi("docs", claim.id), "claim");
  const live = await pointerOf();
  ok(!Object.hasOwn(live.list.documents, off.id), "the archived page's entry is removed");
  ok(!live.list.pages.some((p) => p.document === off.id), "and its pages row");
  eq(live.list.pages.filter((p) => p.slug === "keep-addr").map((p) => [p.document, p.enabled]), [[claim.id, true]], "the slug is the claimer's:");
  eq(live.pointer, r.release.id, "one release:");
});

await t("P3-COMMIT: archive is terminal: no code sets archived_at back to NULL (grep over lib, app, components, scripts and migrations)", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(p);
      } else if (/\.(m?js|sql)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ["lib", "app", "components", "scripts", "migrations"]) await walk(d);
  ok(files.length > 100, `only ${files.length} files found: the walk is broken`);
  const writers = [];
  for (const f of files) {
    // P4-MEDIA: media.archived_at (migration 0025) is another table's column,
    // which a founder may set back (unarchive); only documents are terminal
    const src = (await readFile(join(ROOT, f), "utf8")).replace(/UPDATE media SET archived_at[^\n]*/g, "");
    if (/archived_at\s*=\s*NULL/i.test(src.replace(/archived_at\s*=\s*NULL\b[^\n]*grep/gi, ""))) writers.push(`${f}: archived_at = NULL`);
    if (/\bSET\b[^;"`]*\barchived_at\s*=/i.test(src)) writers.push(f);
  }
  // the one writer: service.js archive(), which sets it to the time, and
  // (P4-LIVEROW) openEntityContent, which brings back the content of a
  // product or collection that is in Shopify again (its one statement is
  // checked below; no other line may set it to null)
  eq(writers.filter((w) => !w.startsWith("scripts/test-")), ["lib/documents/service.js: archived_at = NULL", "lib/documents/service.js"], "files that set archived_at:");
  const nulls = (await readFile(join(ROOT, "lib/documents/service.js"), "utf8")).split("\n").filter((l) => /archived_at\s*=\s*NULL/i.test(l));
  eq(nulls.length, 1, "one un-archive statement:");
  ok(/UPDATE documents SET archived_at = NULL, revision = revision \+ 1, updated_at = \?, updated_by = \? WHERE id = \? AND archived_at IS NOT NULL AND EXISTS/.test(nulls[0]), `only openEntityContent, only while the entity exists: ${nulls[0]}`);
  const svc = await readFile(join(ROOT, "lib/documents/service.js"), "utf8");
  ok(/SET archived_at = \?, revision = revision \+ 1, updated_at = \?, updated_by = \? WHERE[^"]*",\s*args: \[at, at, by,/.test(svc), "archive() sets archived_at to the time, never null");
});

await t("P3-COMMIT: an afterCommit handler runs once after ok, never on lost or failed, and a throwing one does not change the publish result", async () => {
  const calls = [];
  const handler = async ({ build, items }) => calls.push({ release: build.releaseId, items: items.map((i) => i.doc.id) });
  After.afterCommit.push(handler);
  try {
    const d = await create("docs", "page", { body: page("after-one", "After one", "x") });
    const r = published(await publishApi("docs", d.id), "ok");
    eq(calls, [{ release: r.release.id, items: [d.id] }], "once, after ok:");
    // lost every time (busy): never
    await save("docs", await current("docs", d.id), page("after-one", "After one", "y"));
    const live = await pointerOf();
    Pub.setPublishHooks({ commit: async () => ({ lost: true, outcome: "lost", pointer: live.pointer, list: live.list, busy: true }) });
    eq((await publishApi("docs", d.id)).body.code, "PUBLISH_BUSY", "lost:");
    Pub.setPublishHooks({ commit: async () => ({ failed: true, outcome: "failed", code: "DB_REFUSED" }) });
    eq((await publishApi("docs", d.id)).body.code, "PUBLISH_FAILED", "failed:");
    Pub.setPublishHooks({ commit: async () => ({ unknown: true, outcome: "unknown" }) });
    eq((await publishApi("docs", d.id)).body.code, "PUBLISH_UNKNOWN", "unknown:");
    Pub.setPublishHooks({});
    eq(calls.length, 1, "never on lost, failed or unknown:");
    // a late commit found through onLost counts once
    let first = true;
    Pub.setPublishHooks({
      commit: async (b) => {
        const real = await commitPublishBatch(b);
        if (first) {
          first = false;
          const now = await inT(() => B.readLive());
          return { lost: true, outcome: "lost", pointer: now.pointer, list: now.list };
        }
        return real;
      },
    });
    const late = published(await publishApi("docs", d.id), "late commit");
    Pub.setPublishHooks({});
    eq(calls.length, 2, "the late commit, once:");
    eq(calls[1].release, late.release.id, "its release:");
    // a throwing handler: logged, the answer is the same
    After.afterCommit.push(async () => {
      throw new Error("handler broke");
    });
    await save("docs", await current("docs", d.id), page("after-one", "After one", "z"));
    const { result, lines } = await logsOf(() => publishApi("docs", d.id));
    const body2 = published(result, "with a throwing handler");
    sameKeys(body2, shapeOf("publish", "ok").body, [...(shapeOf("publish", "ok").addedInPhase3 || []), ...(shapeOf("publish", "ok").optional || [])]);
    eq((await current("docs", d.id)).publishedVersionId, body2.published[0].versionId, "live:");
    ok(lines.some((l) => l.evt === "documents_after_commit_failed" && /handler broke/.test(l.error)), "logged");
    eq(calls.length, 3, "the good handler still ran:");
  } finally {
    After.afterCommit.length = 0;
    Pub.setPublishHooks({});
  }
});

await t("P3-COMMIT: livePath covers home, every singleton, page (about, contact, a policy), campaign and journal; liveExitUrl has no token and passes /api/preview's destination()", async () => {
  for (const t1 of R.singletonTypes()) eq(Paths.livePath(t1, {}), "/", `${t1}:`);
  eq(Paths.livePath("home", null), "/", "home:");
  eq(Paths.livePath("page", { slug: "about" }), "/about", "about:");
  eq(Paths.livePath("page", { slug: "contact" }), "/contact", "contact:");
  eq(Paths.livePath("page", { slug: "refund-policy" }), "/policies/refund-policy", "a policy:");
  eq(Paths.livePath("campaign", { slug: "diwali" }), "/campaigns/diwali", "campaign:");
  eq(Paths.livePath("journal", { slug: "hello" }), "/journal/hello", "journal:");
  eq(Paths.livePath("product_content", { slug: "x" }), "/", "no address of its own:");
  const route = await import(pathToFileURL(join(ROOT, "app/api/preview/route.js")).href);
  for (const path of ["/", "/about", "/contact", "/policies/refund-policy", "/campaigns/diwali", "/journal/hello"]) {
    const url = Paths.liveExitUrl(path);
    ok(url.startsWith("/api/preview?exit=1&to=") && !/token/i.test(url), `${url}`);
    const u = new URL(`https://psdocs.test${url}`);
    const res = await inT(() => route.GET({ headers: new Headers({ host: "psdocs.test" }), nextUrl: u, url: u.href, cookies: { get: () => undefined } }));
    eq([res.status, res.headers.get("location")], [302, `https://psdocs.test${path}`], `${path} lands where it says:`);
    ok(/_preview=;|Max-Age=0/i.test(res.headers.get("set-cookie") || ""), "and clears the preview cookie");
  }
  eq(Paths.liveExitUrl("https://evil.test/"), "/api/preview?exit=1&to=%2F", "only a path:");
});

// ---- the API: the phase 3 operations -----------------------------------------------------------

const adminU = await I.createUser({ email: "admin@ps.test", name: "Meera", password: "admin-pass-publish" });
for (const s of STORES) await I.addMembership(adminU.id, `ps${s}`, "admin");
const ADMIN = await tok(adminU);

const NEW_OPS = {
  unpublish: { good: (id) => ({ unpublish: { id }, revision: 1 }), bad: { unpublish: { id: 7 }, revision: 1 }, module: ["Undo", "unpublish"], publish: true, revision: true },
  undo: { good: (id) => ({ undo: { id, logId: "log_00000000000000aa" }, revision: 1 }), bad: { undo: { id: "doc_x" }, revision: 1 }, module: ["Undo", "undo"], publish: true, revision: true },
  undoSet: { good: (id) => ({ undoSet: { setId: "set_00000000000000aa", members: [{ id, logId: "log_00000000000000aa" }] } }), bad: { undoSet: { setId: "set_x", members: "all" } }, module: ["Undo", "undoSet"], publish: true },
  listRecentlyPublished: { good: () => ({ listRecentlyPublished: { limit: 5 } }), bad: { listRecentlyPublished: { limit: 99 } }, module: ["Undo", "listRecentlyPublished"], read: true },
  listChanges: { good: (id) => ({ listChanges: { id } }), bad: { listChanges: { id: 5 } }, module: ["Changes", "listChanges"], read: true },
  keepLiveSection: { good: (id) => ({ keepLiveSection: { id, sectionId: "sec_t1" }, revision: 1 }), bad: { keepLiveSection: { id: "doc_x" }, revision: 1 }, module: ["Changes", "keepLiveSection"], revision: true },
  keepAsEarlierDraft: { good: (id) => ({ keepAsEarlierDraft: { id, body: { type: "page" } } }), bad: { keepAsEarlierDraft: { id: "doc_x", body: "text" } }, module: ["Changes", "keepAsEarlierDraft"] },
};

await t("P3-COMMIT API: each new operation is 400 when malformed or mixed with another, before any authorization; publish-shaped ones say 'nothing was published'", async () => {
  const before = await dump();
  for (const [name, o] of Object.entries(NEW_OPS)) {
    for (const as of [OWNER, null]) {
      const r = await api(o.bad, { as });
      eq([r.status, r.body.code], [400, "MALFORMED"], `${name} malformed (${as ? "signed in" : "signed out"}):`);
      ok(o.publish ? /nothing was published/.test(r.body.error) : /nothing was saved/.test(r.body.error), `${name} words: ${r.body.error}`);
      likeShape(r, o.publish ? COMMON.outcomes.malformedPublish : COMMON.outcomes.malformed, `${name} malformed`);
      const mixed = await api({ ...o.good("doc_x"), getDocument: "doc_x" }, { as });
      eq([mixed.status, mixed.body.code], [400, "AMBIGUOUS_OPERATION"], `${name} mixed:`);
    }
  }
  // a malformed publish's words say 'published' too
  const mp = await api({ publish: { id: "doc_x", draftHash: 5 }, revision: 1 });
  eq(mp.status, 400, "malformed publish:");
  ok(/so nothing was published/.test(mp.body.error), mp.body.error);
  const ms = await api({ publishSet: [{ id: "doc_x", revision: "1" }] });
  ok(/so nothing was published/.test(ms.body.error), ms.body.error);
  await unchanged(before, "400s");
});

await t("P3-COMMIT API: 401 and 403 come before the mode check; staff get 403 on unpublish, undo and undoSet with storage unchanged; the rest of staff's new operations get past authorization", async () => {
  for (const store of ["docs", "legacy"]) {
    const before = await dump(store);
    for (const [name, o] of Object.entries(NEW_OPS)) {
      const out = await api(o.good("doc_home"), { as: null, store });
      eq(out.status, 401, `${name} signed out on ${store}:`);
      likeShape(out, COMMON.outcomes.unauthorized, `${name} 401`);
      const staff = await api(o.good("doc_home"), { as: STAFF, store });
      if (o.publish) {
        eq(staff.status, 403, `${name} staff on ${store}:`);
        likeShape(staff, COMMON.outcomes.forbidden, `${name} 403`);
      } else ok(staff.status !== 401 && staff.status !== 403, `${name}: staff may (${staff.status})`);
    }
    await unchanged(before, `401/403 on ${store}`, store);
  }
});

await t("P3-COMMIT API: a store whose stored mode is not documents ('legacy', 'migrating') answers 500 STORE_MODE_INVALID for the new writes and the two new reads; getDocument and listDocuments behave as before", async () => {
  const before = await dump("legacy");
  for (const [name, o] of Object.entries(NEW_OPS)) {
    const r = await api(o.good("doc_home"), { store: "legacy" });
    eq([r.status, r.body.code], [500, "STORE_MODE_INVALID"], `${name}:`);
    likeShape(r, SHAPES[name].outcomes.modeInvalid, `${name} modeInvalid`);
  }
  await unchanged(before, "legacy", "legacy");
  // a stored 'migrating' (nothing writes it any more): the two reads refuse the same way
  await raw.busy.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  try {
    for (const name of ["listRecentlyPublished", "listChanges"]) {
      const r = await api(NEW_OPS[name].good("doc_home"), { store: "busy" });
      eq([r.status, r.body.code], [500, "STORE_MODE_INVALID"], `${name} migrating:`);
    }
  } finally {
    await raw.busy.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  }
  // today's reads have no mode check: same answers as the service gives
  const g = await api({ getDocument: "doc_home" }, { store: "legacy" });
  eq([g.status, g.body.code], [404, "NOT_FOUND"], "getDocument on a legacy store (no document there):");
  const l = await api({ listDocuments: true }, { store: "legacy" });
  eq([l.status, l.body.documents], [200, []], "listDocuments on a legacy store:");
  await raw.legacy.execute({ sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_home', 'home', NULL, 'Home page', ?, 'dh', 1, 1, 'x', 'x')", args: [JSON.stringify(R.emptyBody("home"))] });
  const g2 = await api({ getDocument: "doc_home" }, { store: "legacy" });
  eq(g2.status, 200, "getDocument of a row on a legacy store:");
  eq(g2.body.document.id, "doc_home", "the row:");
  await raw.legacy.execute("DELETE FROM documents WHERE id = 'doc_home'");
});

const BUILT_UNDO_OPS = new Set(["unpublish", "undo", "undoSet", "listRecentlyPublished"]);
await t("P3-COMMIT API: 428 without a revision for unpublish, undo and keepLiveSection; 501 NOT_BUILT from every stub; storage unchanged", async () => {
  const d = await create("docs", "page", { body: page("stub-target", "Stub target", "x") });
  const before = await dump();
  for (const [name, o] of Object.entries(NEW_OPS)) {
    const req0 = o.good(d.id);
    if (o.revision) {
      const { revision: _r, ...noRev } = req0;
      const r = await api(noRev);
      eq([r.status, r.body.code], [428, "REVISION_REQUIRED"], `${name} without a revision:`);
      ok(o.publish ? /nothing was published/.test(r.body.error) : /nothing was saved/.test(r.body.error), `${name} 428 words`);
      likeShape(r, SHAPES[name].outcomes.revisionRequired, `${name} 428`);
    }
    // P3-CHANGES built the Changes ops; their answers are tested in
    // scripts/test-doc-changes.js. Only the remaining stubs answer 501.
    if (o.module[0] === "Changes") continue;
    const r = await api(req0);
    // P3-UNDO built these four (scripts/test-publish-undo.js covers them):
    // they no longer answer 501, and on this fixture they refuse or read
    if (BUILT_UNDO_OPS.has(name)) {
      ok(r.status !== 501, `${name} is built: ${r.status}`);
      continue;
    }
    eq([r.status, r.body.code], [501, "NOT_BUILT"], `${name} stub:`);
    likeShape(r, COMMON.outcomes.notBuilt, `${name} 501`);
  }
  await unchanged(before, "stubs");
});

await t("P3-COMMIT API: the whole parsed op reaches the module (dryRun, logId, setId, members, limit, sectionId, body) and the module's {status, body} is sent as it is; confirmRepublish reaches publish", async () => {
  const seen = [];
  const spy = (mod) => new Proxy({}, { get: (_t, fn) => async (op, ctx) => (seen.push({ mod, fn, op, actor: ctx?.actor?.kind }), { status: 299, body: { ok: true, echo: fn } }) });
  Api.setDocumentsApiModules({ Undo: spy("Undo"), Changes: spy("Changes") });
  try {
    const cases = [
      [{ undo: { id: "doc_a", logId: "log_1", dryRun: true }, revision: 4 }, { kind: "undo", id: "doc_a", logId: "log_1", dryRun: true, hasRevision: true, revision: 4 }],
      [{ undo: { id: "doc_a", logId: "log_2" }, revision: 5 }, { kind: "undo", id: "doc_a", logId: "log_2", dryRun: false, hasRevision: true, revision: 5 }],
      [{ unpublish: { id: "doc_a", dryRun: true }, revision: 2 }, { kind: "unpublish", id: "doc_a", dryRun: true, hasRevision: true, revision: 2 }],
      [{ undoSet: { setId: "set_1", members: [{ id: "doc_a", logId: "log_1" }, { id: "doc_b", logId: "log_2" }], dryRun: true } }, { kind: "undoSet", setId: "set_1", members: [{ id: "doc_a", logId: "log_1" }, { id: "doc_b", logId: "log_2" }], dryRun: true, hasRevision: false, revision: null }],
      [{ listRecentlyPublished: {} }, { kind: "listRecentlyPublished", limit: 20, hasRevision: false, revision: null }],
      [{ listRecentlyPublished: { limit: 50 } }, { kind: "listRecentlyPublished", limit: 50, hasRevision: false, revision: null }],
      [{ listChanges: { id: "doc_a" } }, { kind: "listChanges", id: "doc_a", hasRevision: false, revision: null }],
      [{ keepLiveSection: { id: "doc_a", sectionId: "sec_x" }, revision: 3 }, { kind: "keepLiveSection", id: "doc_a", sectionId: "sec_x", hasRevision: true, revision: 3 }],
      [{ keepAsEarlierDraft: { id: "doc_a", body: { type: "page", sections: [] } } }, { kind: "keepAsEarlierDraft", id: "doc_a", body: { type: "page", sections: [] }, hasRevision: false, revision: null }],
    ];
    for (const [reqBody, wantOp] of cases) {
      seen.length = 0;
      const r = await api(reqBody);
      eq([r.status, r.body], [299, { ok: true, echo: wantOp.kind }], `${wantOp.kind} answer as it is:`);
      eq(seen.length, 1, `${wantOp.kind} called once:`);
      eq(seen[0].op, wantOp, `${wantOp.kind} op:`);
      eq(seen[0].actor, "merchant", `${wantOp.kind} actor:`);
    }
    // confirmRepublish reaches publish (and its items)
    const pubSeen = [];
    Api.setDocumentsApiModules({ Publish: { publish: async (a) => (pubSeen.push(a.ids), { release: null, setId: null, published: [], skipped: [], issues: [] }) } });
    eq((await api({ publish: { id: "doc_a", draftHash: "h", confirmRepublish: true }, revision: 1 })).status, 200, "publish:");
    eq((await api({ publishSet: [{ id: "doc_a", revision: 1, draftHash: "h" }, { id: "doc_b", revision: 2, draftHash: "h2", confirmRepublish: true }] })).status, 200, "publishSet:");
    eq(pubSeen, [[{ id: "doc_a", revision: 1, draftHash: "h", confirmRepublish: true }], [{ id: "doc_a", revision: 1, draftHash: "h", confirmRepublish: false }, { id: "doc_b", revision: 2, draftHash: "h2", confirmRepublish: true }]], "the items:");
  } finally {
    Api.setDocumentsApiModules({});
  }
  // back to the real modules
  // (P3-CHANGES: listChanges is built, so the real module answers 404 for an unknown id)
  eq((await api({ listChanges: { id: "doc_a" } })).body.code, "NOT_FOUND", "restored:");
});

await t("P3-COMMIT API: getDocument and listDocuments carry access: staff can't publish (with the plain reason), an admin and the owner can; the answers match the shapes", async () => {
  const d = await create("docs", "page", { body: page("access-page", "Access", "x") });
  for (const [as, who, want] of [
    [STAFF, "staff", { canPublish: false, reason: "Only the store owner or an admin can publish. You can edit and preview." }],
    [ADMIN, "admin", { canPublish: true, reason: null }],
    [OWNER, "owner", { canPublish: true, reason: null }],
  ]) {
    const g = await api({ getDocument: d.id }, { as });
    eq(g.status, 200, `${who} getDocument:`);
    eq(g.body.document.access, want, `${who} getDocument access:`);
    likeShape(g, SHAPES.getDocument.outcomes.ok, `${who} getDocument`);
    const l = await api({ listDocuments: { type: "page" } }, { as });
    eq(l.status, 200, `${who} listDocuments:`);
    ok(l.body.documents.length > 0 && l.body.documents.every((x) => canon(x.access) === canon(want)), `${who} listDocuments access`);
    likeShape(l, SHAPES.listDocuments.outcomes.ok, `${who} listDocuments`);
  }
  // staff really can't publish, as access says
  eq((await publishApi("docs", d.id, { as: STAFF })).status, 403, "staff publish:");
});

// =========================================================================================
// A real sqld behind the fault proxy, through HEAD's lib/db.js.
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
  const [sqldPort, proxyPort] = (process.env.TEST_PUBLISH_SERVICE_PORTS || "").split(",").map((p) => Number(p) || 0);
  dataDir = await mkdtemp(join(tmpdir(), "storeasy-test-publish-service-"));
  const t0 = Date.now();
  sqld = H.startSqld({ bin: found.bin, key: "publish-service", port: sqldPort || (await freePort()), dataDir });
  await H.waitForHealth(sqld.url, sqld.child, { logFile: sqld.logFile, label: "test:publish-service" });
  proxy = startFaultProxy({ listenPort: proxyPort || 0, upstreamPort: sqld.port });
  await proxy.ready;
  const direct = createClient({ url: sqld.url }); // inspection, never through the proxy
  rawClients.push(direct);
  await direct.executeMultiple(schema);
  await runMigrations(direct, MIGRATIONS);
  await direct.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  const TENANT = { id: "ps-sqld", dbUrl: proxy.url };
  const inS = (fn) => withTenant(TENANT, fn);
  const dsql = async (q, args = []) => (await direct.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
  const pub = (list) =>
    inS(async () => {
      const items = [];
      for (const id of list) {
        const d = await Docs.getDocument(id);
        items.push({ id, revision: d.revision, draftHash: d.draftHash });
      }
      return Pub.publish({ ids: items, actor: ACTOR });
    });
  const mk = (b) => inS(async () => (await Docs.createDocument({ type: b.type, body: b, actor: ACTOR })).document);

  await t("sqld: the first publish of one page with the home page goes live; every other singleton stays an explicit null", async () => {
    const d = await mk(page("privacy", "Privacy", "Little."));
    // P3-CHECKS: a closed store opens with its home page
    let refused = null;
    await pub([d.id]).catch((e) => (refused = e));
    eq(refused?.code, "FIRST_PUBLISH_NEEDS_HOME", "a page alone:");
    const h = await mk(body("home", { sections: [sec("hero", "sec_hero", { title: "Sqld home" })] }));
    const r = await pub([d.id, h.id]);
    const [row] = await dsql("SELECT s.live_release_id AS live, r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id");
    eq(row.live, r.release.id, "pointer:");
    const list = JSON.parse(String(row.content));
    for (const ty of R.singletonTypes()) if (ty !== "home") eq(list.documents[`doc_${ty}`], null, `doc_${ty}:`);
    eq(list.documents.doc_home?.version, r.published.find((p) => p.id === "doc_home").versionId, "doc_home:");
  });

  await t("sqld (proxy commit_then_drop): a lost response then retry reports success with no duplicate rows", async () => {
    const d = await mk(page("dropped", "Dropped", "Words."));
    const counts = async () => ({
      releases: (await dsql("SELECT count(*) AS n FROM releases"))[0].n,
      log: (await dsql("SELECT count(*) AS n FROM publish_log WHERE document_id = ?", [d.id]))[0].n,
      versions: (await dsql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'published'", [d.id]))[0].n,
    });
    const before = await counts();
    proxy.resetCounters();
    proxy.commitThenDrop(1);
    const r = await pub([d.id]);
    proxy.pass();
    eq(proxy.counters.committedThenDropped, 1, "the answer was dropped after commit:");
    ok(proxy.counters.batches >= 1, `reconciled without blind write retry (${proxy.counters.batches}):`);
    const after = await counts();
    eq([after.releases - before.releases, after.log - before.log, after.versions - before.versions], [1, 1, 1], "exactly one release, log and version row:");
    const [row] = await dsql("SELECT live_release_id AS live FROM release_state WHERE id = 1");
    eq(row.live, r.release.id, "live:");
    eq((await dsql("SELECT published_version_id AS v FROM documents WHERE id = ?", [d.id]))[0].v, r.published[0].versionId, "documents.published_version_id:");
  });

  await t("sqld: two publishes of different documents sent at once both succeed and both are live", async () => {
    const a = await mk(page("conc-a", "Conc A", "A."));
    const b = await mk(page("conc-b", "Conc B", "B."));
    proxy.resetCounters();
    proxy.hold("batch");
    const pa = pub([a.id]);
    const pb = pub([b.id]);
    await proxy.waitHeld(2); // both built from the same pointer, both batches waiting
    proxy.pass(); // later requests (the rebuild) go straight through
    proxy.release();
    proxy.release();
    const [ra, rb] = await Promise.all([pa, pb]);
    const [row] = await dsql("SELECT r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id");
    const list = JSON.parse(String(row.content));
    eq(list.documents[a.id]?.version, ra.published[0].versionId, "A live:");
    eq(list.documents[b.id]?.version, rb.published[0].versionId, "B live:");
    ok(proxy.counters.batches >= 3, `one of them lost and rebuilt (batches ${proxy.counters.batches})`);
  });
  sqldMs = Date.now() - t0;
} catch (e) {
  fail++;
  console.error(`✗ the sqld cases could not run: ${e?.stack || e}`);
} finally {
  for (const c of rawClients) {
    try {
      c.close();
    } catch {}
  }
  if (proxy) await proxy.close().catch(() => {});
  if (sqld) await H.stopChild(sqld.child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

for (const c of Object.values(raw)) c.close();
for (const f of FILES) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(1)}s (sqld part ${(sqldMs / 1000).toFixed(1)}s).`);
process.exit(fail ? 1 : 0);
