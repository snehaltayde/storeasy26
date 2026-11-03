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
const FILES = [".test-ps-default.db", ".test-ps-platform.db", ...STORES.map((s) => `.test-ps-${s}.db`)];
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
  raw[s] = c;
  await C.upsertTenant({ id: `ps${s}`, name: `PS ${s}`, domains: [`ps${s}.test`], dbUrl: `file:.test-ps-${s}.db`, config: { site: { name: `PS ${s} Store` }, site_url: `https://ps${s}.test` }, secrets: {} });
  TEN[s] = await C.getTenant(`ps${s}`);
}
const ownerU = await I.createUser({ email: "owner@ps.test", name: "Asha Rao", password: "owner-pass-publish" });
const staffU = await I.createUser({ email: "staff@ps.test", name: "Ravi", password: "staff-pass-publish" });
for (const s of STORES) {
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
const publishApi = async (store, id, { as = OWNER, revision, draftHash } = {}) => {
  const d = await current(store, id);
  return api({ publish: { id, draftHash: draftHash ?? d.draftHash }, revision: revision ?? d.revision }, { store, as });
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

await t("the first publish on a never-published documents store, of one policy page only, goes live; every other getter returns its code default and nothing errors", async () => {
  const before = await pointerOf("first");
  eq(before.pointer, null, "never published:");
  const privacy = await create("first", "page", { body: page("privacy", "Privacy", "We keep little.") });
  const r = published(await publishApi("first", privacy.id), "first publish");
  eq(r.published.map((p) => p.id), [privacy.id], "only the page:");
  const live = await pointerOf("first");
  eq(live.pointer, r.release.id, "the pointer is the new release:");
  for (const t of R.singletonTypes()) eq(live.list.documents[`doc_${t}`], null, `doc_${t} is an explicit null:`);
  eq(live.list.pages.map((p) => [p.slug, p.document]), [["privacy", privacy.id]], "the page row:");
  eq(live.list.indexes.journal, null, "no journal index:");
  for (const [fn, args, want] of defaultsWanted("PS first Store")) {
    let got;
    try {
      got = await inT(() => Res[fn](...args), "first");
    } catch (e) {
      throw new Error(`${fn}(${args.join(",")}) threw ${e.message} ${JSON.stringify(e.detail || "")}`);
    }
    eq(got, want, `${fn}(${args.join(",")}):`);
  }
  eq((await inT(() => Res.resolvedContentPageList(), "first")).find((p) => p.slug === "privacy"), { slug: "privacy", title: "Privacy", enabled: true, source: "custom", family: "page" }, "listed:");
  eq((await inT(() => Res.resolvedContentPage("privacy"), "first")).sections, [{ id: "sec_t1", kind: "text", heading: "Privacy", body: ["We keep little."] }], "the policy page:");
  eq(await inT(() => Res.resolvedJournalEntries(), "first"), [], "no journal:");
  const row = (await sql("SELECT published_version_id, published_hash, draft_hash FROM documents WHERE id = ?", [privacy.id], "first"))[0];
  eq(row.published_version_id, r.published[0].versionId, "documents.published_version_id:");
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
console.log("— the API (storefront.publish, modes, product content)");

await t("API: staff without storefront.publish get 403 with storage unchanged; a legacy-mode tenant gets 409; product_content gives a plain refusal", async () => {
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
  eq([lg.status, lg.body.code], [409, "STORE_USES_LEGACY"], "legacy store:");
  ok(/nothing was published/.test(lg.body.error), "publish words");
  const lgSvc = await inT(() => Pub.publish({ ids: [{ id: "doc_home", revision: 1, draftHash: "x" }] }).then(() => "ran", (e) => e.code), "legacy");
  eq(lgSvc, "STORE_USES_LEGACY", "the service refuses too:");
  await unchanged(legacyBefore, "legacy", "legacy");

  const content = await create("docs", "product_content", { entityId: "gid://shopify/Product/9" });
  const before2 = await dump();
  const pc = await publishApi("docs", content.id);
  eq([pc.status, pc.body.code], [409, "PUBLISH_NOT_AVAILABLE"], "product content:");
  ok(!("issues" in pc.body), "a plain refusal, no issue list");
  ok(/isn't available yet/.test(pc.body.error), pc.body.error);
  await unchanged(before2, "product content");

  // missing revision or draft hash: 428, after authorization
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

  await t("sqld: the first publish of one page goes live; every singleton stays an explicit null", async () => {
    const d = await mk(page("privacy", "Privacy", "Little."));
    const r = await pub([d.id]);
    const [row] = await dsql("SELECT s.live_release_id AS live, r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id");
    eq(row.live, r.release.id, "pointer:");
    const list = JSON.parse(String(row.content));
    for (const ty of R.singletonTypes()) eq(list.documents[`doc_${ty}`], null, `doc_${ty}:`);
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
    eq(proxy.counters.batches, 2, "lib/db.js sent the batch again:");
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
