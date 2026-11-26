// P4-LIVEROW (OVL-01, OVL-02, OVL-04, OVL-05, OVL-07, ED-12, MED-03, OVL-17):
// product and collection content as real, publishable documents with live
// rows. Real file databases (scripts/support/tenant-fixture.js), the real
// services and the real console API (lib/admin/documents-api.js, real
// sessions); a real sqld behind the Hrana fault proxy for the lost-answer case.
//   1. the registry shape, overlay rules, Shopify-owned fields, the title gate
//   2. openEntityContent, deleted and returning products, discardOrphanEdits
//   3. publish and Undo with live rows; the search outbox; the mode guard
//   4. mixed sets, the title belt, collections, the cart ruling, unpublish
//   5. a sqld behind the fault proxy (commitThenDrop and a retry)
// Typesense: dummy localhost values set in this process only; nothing is ever
// sent to it (P4-SEARCH: a spy client takes every call). sqld is required
// (the suite fails, never skips, without it).
// P4-SEARCH (batch 3) rewrote the title-gate cases to the new rule (the gate is
// open on every store; its shape, refusal and belt stay for a future gate) and
// added the LIVEROW review's cases (section 7).
// Ports: TEST_PRODUCT_CONTENT_PORTS="<sqld>,<proxy>", else free ports.
//   pnpm test:product-content
import "./support/request-cache.js";
import { registerHooks } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
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
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "SHOPIFY_STORE_DOMAIN"]) delete process.env[k];

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("pc");
await rm(join(ROOT, ".test-pc-default.db"), { force: true });
await F.makePlatform({ name: "pc" });
const { createClient } = await import("@libsql/client");
const { withTenant } = await import("../lib/tenant-context.js");
const R = await import("../lib/registry/index.js");
const DT = await import("../lib/registry/document-types.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const U = await import("../lib/documents/undo.js");
const Ch = await import("../lib/documents/changes.js");
const LR = await import("../lib/documents/live-rows.js");
const Ids = await import("../lib/documents/ids.js");
const Gate = await import("../lib/catalog/title-gate.js");
const TS = await import("../lib/typesense-search.js");
const SR = await import("../lib/catalog/search-reindex.js");
const AdminUrl = await import("../lib/admin/shopify-admin-url.js");
const Mode = await import("../lib/cms-mode.js");
const Sync = await import("../lib/sync.js");
const Reader = await import("../lib/content/documents-reader.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { startFaultProxy } = await import("./support/hrana-fault-proxy.js");
const H = await import("./design-harness.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 5).join("\n   ") || e}`);
  } finally {
    Pub.setPublishHooks({});
    Docs.discardHooks.beforeBatch = null;
    Gate.setTitleGateForTest(false);
    TS.setSearchAdminClientForTest(null);
    Docs.openEntityHooks.beforeUnarchive = null;
    for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION"]) delete process.env[k];
  }
}
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const eq = (got, want, label = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${label} expected ${canon(want).slice(0, 900)}, got ${canon(got).slice(0, 900)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const refused = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal, got success");
};

// ---- stores and people ---------------------------------------------------------------
const CONFIG = { site: { name: "PC Store" }, site_url: "https://pc.test", shopify_store_domain: "pc-store.myshopify.com" };
const docs = await F.makeTenant({ name: "pc-docs", id: "pcdocs", products: 20, config: CONFIG });
const legacy = await F.makeTenant({ name: "pc-legacy", id: "pclegacy", products: 2, config: CONFIG });
const moving = await F.makeTenant({ name: "pc-moving", id: "pcmoving", products: 2, config: CONFIG });
const ownTs = await F.makeTenant({ name: "pc-ts", id: "pcts", products: 2, config: { ...CONFIG, typesense_collection: "pcts_products" } });
const noDomain = await F.makeTenant({ name: "pc-nodomain", id: "pcnodomain", products: 1, config: { site: { name: "No domain" } } });
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
for (const fx of [docs, legacy, moving, ownTs, noDomain]) await raw(fx).executeMultiple(schema);
for (const fx of [docs, ownTs, noDomain]) await raw(fx).execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw(legacy).execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
await raw(moving).execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
const setMode = (fx, mode) => raw(fx).execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] });

// a collection with two products
const COL = "gid://shopify/Collection/501";
await raw(docs).execute({ sql: "INSERT INTO collections (id, handle, title, updated_at, synced_at) VALUES (?, 'summer', 'Summer', '2026-01-01', '2026-01-01')", args: [COL] });
for (const [i, n] of [[0, 1], [1, 2]]) await raw(docs).execute({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)", args: [COL, `gid://shopify/Product/${9100 + n}`, i] });

const ownerU = await I.createUser({ email: "owner@pc.test", name: "Asha Rao", password: "owner-pass-content" });
const staffU = await I.createUser({ email: "staff@pc.test", name: "Ravi", password: "staff-pass-content" });
const adminU = await I.createUser({ email: "admin@pc.test", name: "Meera Iyer", password: "admin-pass-content" });
for (const fx of [docs, legacy, moving, ownTs]) {
  await I.addMembership(ownerU.id, fx.id, "owner");
  await I.addMembership(staffU.id, fx.id, "staff");
  await I.addMembership(adminU.id, fx.id, "admin");
}
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const ACTOR = { kind: "merchant", id: ownerU.id };
const ADMIN_ACTOR = { kind: "merchant", id: adminU.id };
// P4-SEARCH: the Typesense client every call reaches here (never a real one)
function spyClient() {
  const calls = [];
  return {
    calls,
    collections(name) {
      if (name === undefined) return { create: async (sch) => (calls.push({ op: "create", name: sch?.name }), {}) };
      return {
        delete: async () => (calls.push({ op: "dropCollection", name }), {}),
        documents(id) {
          if (id === undefined) return { import: async (list, opts) => (calls.push({ op: "import", name, docs: JSON.parse(JSON.stringify(list)), action: opts?.action }), list.map(() => ({ success: true }))) };
          return { delete: async () => (calls.push({ op: "delete", name, id }), {}) };
        },
      };
    },
  };
}
const req = (fx, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (fx, body, as = OWNER) => fx.run(() => handleDocumentsPut(req(fx, as, body)));

const P = (n) => `gid://shopify/Product/${9100 + n}`;
const sec = (kind, id, settings = {}) => {
  const s = R.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings } };
};
const open = (fx, n, type = "product_content") => fx.run(() => Docs.openEntityContent({ type, entityId: typeof n === "string" ? n : P(n), actor: ACTOR }));
const get = (fx, id) => fx.run(() => Docs.getDocument(id));
// a save: settings merged over the current draft's, sections replaced when given
async function save(fx, id, settings = {}, sections) {
  const d = await get(fx, id);
  const body = { ...d.body, settings: { ...d.body.settings, ...settings }, ...(sections ? { sections } : {}) };
  return fx.run(() => Docs.saveDraft({ id, revision: d.revision, body, actor: ACTOR }));
}
async function publish(fx, ids) {
  const items = [];
  for (const id of ids) {
    const d = await get(fx, id);
    items.push({ id, revision: d.revision, draftHash: d.draftHash });
  }
  return fx.run(() => Pub.publish({ ids: items, actor: ACTOR }));
}
const undo = async (fx, id, logId, dryRun = false) => {
  const d = await get(fx, id);
  return fx.run(() => U.undo({ kind: "undo", id, logId, dryRun, hasRevision: true, revision: d.revision }, { actor: ACTOR }));
};
const liveRow = async (fx, n) => (await sql(fx, "SELECT * FROM product_content_live WHERE product_id = ?", [typeof n === "string" ? n : P(n)]))[0] || null;
const outbox = (fx) => sql(fx, "SELECT product_id, handle, reason, done_at FROM search_outbox ORDER BY rowid");
const countOf = async (fx, table) => Number((await sql(fx, `SELECT count(*) AS n FROM ${table}`))[0].n);
// What a live-row write can touch.
const liveDump = async (fx) =>
  canon({
    product: await sql(fx, "SELECT * FROM product_content_live ORDER BY product_id"),
    collection: await sql(fx, "SELECT * FROM collection_content_live ORDER BY collection_id"),
    outbox: await outbox(fx),
    docs: await sql(fx, "SELECT id, revision, draft_hash, published_version_id, published_hash, archived_at FROM documents ORDER BY id"),
    log: await sql(fx, "SELECT id FROM publish_log ORDER BY rowid"),
    releases: await sql(fx, "SELECT id FROM releases ORDER BY rowid"),
    state: await sql(fx, "SELECT live_release_id FROM release_state"),
  });
// The effective read of spec 8.9 (P4-EFFECTIVE's lib/catalog/effective.js is
// built in parallel; this is its COALESCE over the same join).
const effective = async (fx, n) =>
  (
    await sql(
      fx,
      "SELECT COALESCE(c.title, p.title) AS title, COALESCE(c.display_vendor, p.vendor) AS vendor, COALESCE(c.display_type, p.product_type) AS type, COALESCE(c.description_html, p.description_html) AS html, c.badge AS badge FROM products p LEFT JOIN product_content_live c ON c.product_id = p.id WHERE p.id = ?",
      [P(n)],
    )
  )[0] || null;
const homeId = async (fx) => {
  const exists = (await sql(fx, "SELECT id FROM documents WHERE id = 'doc_home'"))[0];
  if (!exists) await fx.run(() => Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [sec("hero", "sec_hero", { title: "Hello shoppers" })] }, actor: ACTOR }));
  return "doc_home";
};
const v = (value) => ({ value });
Gate.setTitleGateForTest(false);

// =============================================================================
console.log("— 1. the registry, overlay rules, Shopify-owned fields and the title gate");
// =============================================================================

await t("registry: product_content and collection_content are publishable, with the pinned settings; modules offered are rich_text, text and faq while image_with_text stays registered", () => {
  const pc = R.documentType("product_content");
  ok(pc.publishable && pc.sections, "product_content publishable with sections");
  eq(pc.settings.map((s) => [s.key, s.kind, s.of ?? null]), [
    ["title", "overlay", "text"],
    ["description_html", "overlay", "rich_text"],
    ["gallery", "overlay", "gallery"],
    ["display_vendor", "overlay", "text"],
    ["display_type", "overlay", "text"],
    ["badge", "text", null],
    ["template", "choice", null],
    ["pairs", "pairs", null],
    ["keep_variant_images", "boolean", null],
    // Phase 9 line 5 (decision 13): the search title and description
    ["seo_title", "text", null],
    ["seo_description", "text", null],
  ]);
  eq(pc.settings.find((s) => s.key === "badge").max, 30, "badge cap:");
  eq(pc.settings.find((s) => s.key === "template").options, ["classic", "editorial"], "template:");
  const cc = R.documentType("collection_content");
  ok(cc.publishable && !cc.sections, "collection_content publishable");
  eq(cc.settings.map((s) => [s.key, s.kind]), [["pinned", "product_ids"], ["template", "choice"]]);
  ok(R.allowedKinds("product_content").includes("image_with_text"), "image_with_text stays registered");
  eq(DT.offeredKinds("product_content", R.allowedKinds("product_content")).sort(), ["faq", "rich_text", "text"], "offered:");
  eq(R.checkRegistry(), [], "registry contract:");
  eq(Reader.NOT_OVERLAID.filter((x) => x.endsWith("_content")), ["product_content", "collection_content"], "never overlaid:");
});

await t("SHOPIFY_OWNED: writes naming price, handle, tags, product_type or variants are refused (422 SHOPIFY_OWNED, plain words); an empty name gives 422", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 9);
  const before = await liveDump(docs);
  for (const key of ["price", "handle", "tags", "product_type", "variants", "compare_at_price", "inventory", "options"]) {
    const d = await get(docs, o.document.id);
    const e = await refused(docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, [key]: 1 } }, actor: ACTOR })));
    eq([e.status, e.code], [422, "SHOPIFY_OWNED"], `${key}:`);
    ok(/^Shopify owns .+, so it can't be changed here\./.test(e.message) && !/[A-Z]{2,}_/.test(e.message), `${key} words: ${e.message}`);
    ok(e.extra.issues.some((i) => i.code === "SHOPIFY_OWNED" && i.field === key), `${key} issue`);
  }
  // at the top of the body too, and through the API
  const d = await get(docs, o.document.id);
  const r = await api(docs, { saveDraft: { id: d.id, body: { ...d.body, price: 99 } }, revision: d.revision });
  eq([r.status, r.body.code], [422, "SHOPIFY_OWNED"], "API:");
  const empty = await api(docs, { saveDraft: { id: d.id, body: { ...d.body, settings: { ...d.body.settings, title: v("   ") } } }, revision: d.revision });
  eq(empty.status, 422, "empty name status:");
  ok(empty.body.issues.some((i) => i.code === "TITLE_EMPTY"), "TITLE_EMPTY issue");
  eq(await liveDump(docs), before, "nothing stored:");
});

await t("overlay rules: a value equal to Shopify's stores null (image query strings ignored); a new value takes its base from Shopify; a later edit keeps the first base; Reset and Use Shopify's store null", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 2);
  const id = o.document.id;
  let d = (await save(docs, id, { title: v("Fixture product 2") })).document;
  eq(d.body.settings.title, null, "equal to Shopify's:");
  const shopifyImg = "https://cdn.shopify.com/fixture/fixture-product-2.png";
  d = (await save(docs, id, { gallery: v([{ media: `${shopifyImg}?v=17&width=800`, alt: "Fixture product 2" }]) })).document;
  eq(d.body.settings.gallery, null, "the same gallery with a query string:");
  d = (await save(docs, id, { title: v("Mine") })).document;
  const firstBase = d.body.settings.title;
  eq([firstBase.value, firstBase.base_value], ["Mine", "Fixture product 2"], "the base is Shopify's value at first edit:");
  eq(firstBase.base_hash, await Docs.overlayBaseHash("title", "Fixture product 2"), "base_hash:");
  // Shopify renames it; a second edit keeps the FIRST base
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(2, { title: "Shopify renamed" })));
  d = (await save(docs, id, { title: v("Mine again"), badge: "New" })).document;
  eq([d.body.settings.title.value, d.body.settings.title.base_value, d.body.settings.title.base_hash], ["Mine again", "Fixture product 2", firstBase.base_hash], "second edit:");
  // a client can't move the base: the service keeps it
  d = (await save(docs, id, { title: { value: "Mine again", base_hash: "forged", base_value: "Forged" } })).document;
  eq([d.body.settings.title.base_hash, d.body.settings.title.base_value], [firstBase.base_hash, "Fixture product 2"], "a sent base is ignored:");
  // Reset (null) follows Shopify again, never a copy of base_value
  d = (await save(docs, id, { title: null })).document;
  eq(d.body.settings.title, null, "Reset:");
  d = (await save(docs, id, { display_vendor: v("House brand") })).document;
  const r = await docs.run(() => Docs.resolveShopifyChange({ id, revision: d.revision, field: "display_vendor", choice: "shopify", actor: ACTOR }));
  eq(r.document.body.settings.display_vendor, null, "Use Shopify's:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(2)));
});

await t("resolveShopifyChange 'keep' re-bases base_hash and base_value in the draft only: the published body and the live row are unchanged", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 3);
  const id = o.document.id;
  await save(docs, id, { title: v("Kept name") });
  const pub = await publish(docs, [id]);
  const liveBefore = await liveRow(docs, 3);
  const publishedBody = canon((await sql(docs, "SELECT body FROM document_versions WHERE id = ?", [pub.published[0].versionId]))[0]);
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(3, { title: "Shopify changed it" })));
  const d = await get(docs, id);
  eq(d.body.settings.title.base_value, "Fixture product 3", "base before:");
  const r = await api(docs, { resolveShopifyChange: { id, field: "title", choice: "keep" }, revision: d.revision });
  eq(r.status, 200, `keep: ${JSON.stringify(r.body).slice(0, 200)}`);
  const t2 = r.body.document.body.settings.title;
  eq([t2.value, t2.base_value, t2.base_hash], ["Kept name", "Shopify changed it", await Docs.overlayBaseHash("title", "Shopify changed it")], "re-based:");
  eq(r.body.document.revision, d.revision + 1, "a draft write:");
  eq(await liveRow(docs, 3), liveBefore, "the live row:");
  eq(canon((await sql(docs, "SELECT body FROM document_versions WHERE id = ?", [pub.published[0].versionId]))[0]), publishedBody, "the published body:");
  eq((await get(docs, id)).publishedVersionId, pub.published[0].versionId, "still the same live version:");
  // 'keep' on a product that is gone keeps the value and says why
  const bad = await api(docs, { resolveShopifyChange: { id, field: "nope", choice: "keep" }, revision: r.body.document.revision });
  eq([bad.status, bad.body.code], [400, "MALFORMED"], "unknown field:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(3)));
});

await t("title gate (P4-SEARCH, OQ-1 (b)): TITLE_READERS_READY is true and the Typesense condition is gone: with Typesense configured on _default (env collection) and on a store with its own collection (dummy config, spy client), saving and publishing a name and display_* succeeds and the spy shows the new name indexed; openEntityContent says the name is editable", async () => {
  Gate.setTitleGateForTest(null); // the real conditions
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
  eq(Gate.TITLE_READERS_READY, true, "readers flag:");
  eq(Gate.CONDITIONS.map((c) => c.cause), ["readers"], "the conditions left:");
  ok(!Gate.CONDITIONS.some((c) => /search|typesense/i.test(`${c.save} ${c.belt("X")} ${c.undo("X")}`)), "no condition speaks of search");
  const spy = spyClient();
  TS.setSearchAdminClientForTest(spy);
  // _default (the env collection, "products") on the pc-ts database, and pc-ts itself
  const defaultTenant = { ...ownTs.tenant, id: "_default", config: {} };
  const inDefault = (fn) => withTenant(defaultTenant, fn);
  for (const [label, run] of [["_default", inDefault], ["own collection", (fn) => ownTs.run(fn)], ["no Typesense namespace", (fn) => docs.run(fn)]]) {
    eq(run(() => Gate.titleGate()), { blocked: false, cause: null, reason: null }, `${label} gate:`);
  }
  const imported = (name) => spy.calls.filter((c) => c.op === "import" && c.name === name).flatMap((c) => c.docs);
  // _default: saved and published through the service, then the fast path
  await inDefault(async () => {
    const o = await Docs.openEntityContent({ type: "product_content", entityId: P(1), actor: ACTOR });
    eq([o.titleEditable, o.titleBlockedReason], [true, null], "_default openEntityContent:");
    const d = await Docs.saveDraft({ id: o.document.id, revision: o.document.revision, body: { ...o.document.body, settings: { ...o.document.body.settings, title: v("Default New Name"), display_type: v("Default Type"), display_vendor: v("Default Brand") } }, actor: ACTOR });
    eq(d.document.body.settings.title.value, "Default New Name", "_default saved:");
    const p = await Pub.publish({ ids: [{ id: o.document.id, revision: d.document.revision, draftHash: d.document.draftHash }], actor: ACTOR });
    eq(p.published.length, 1, "_default published:");
    await SR.kickSearchReindex();
  });
  eq(imported("products").map((x) => [x.id, x.title, x.product_type, x.vendor]), [["fixture-product-1", "Default New Name", "Default Type", "Default Brand"]], "_default indexed into the env collection:");
  // the store with its own collection, through the console API (the fast path runs after the 200)
  const o = await open(ownTs, 2);
  eq([o.titleEditable, o.titleBlockedReason], [true, null], "own collection openEntityContent:");
  const s = await api(ownTs, { saveDraft: { id: o.document.id, body: { ...o.document.body, settings: { ...o.document.body.settings, title: v("Own New Name"), display_vendor: v("Own Brand") } } }, revision: o.document.revision });
  eq(s.status, 200, `own collection save: ${JSON.stringify(s.body).slice(0, 200)}`);
  const pub = await api(ownTs, { publish: { id: o.document.id, draftHash: s.body.document.draftHash }, revision: s.body.document.revision });
  eq(pub.status, 200, `own collection publish: ${JSON.stringify(pub.body).slice(0, 200)}`);
  eq(imported("pcts_products").map((x) => [x.id, x.title, x.vendor]), [["fixture-product-2", "Own New Name", "Own Brand"]], "indexed into its own collection:");
  ok(!spy.calls.some((c) => c.op === "dropCollection" || c.op === "create"), "the reindex never drops or makes a collection");
  eq((await sql(ownTs, "SELECT count(*) AS n FROM search_outbox WHERE done_at IS NULL"))[0].n, 0, "nothing left pending:");
});

await t("title gate forced closed (setTitleGateForTest): the save-time refusal and openEntityContent still answer, each in the words of the condition that blocked; a non-search condition never speaks of search", async () => {
  for (const [state, words] of [
    [{ blocked: true, cause: "readers" }, Gate.CONDITIONS.find((c) => c.cause === "readers").save],
    [true, Gate.TITLE_GATE_MESSAGE],
  ]) {
    Gate.setTitleGateForTest(state);
    const o = await open(docs, 4);
    eq([o.titleEditable, o.titleBlockedReason], [false, words], `openEntityContent (${JSON.stringify(state)}):`);
    for (const field of ["title", "display_type", "display_vendor"]) {
      const d = await get(docs, o.document.id);
      const e = await refused(docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, [field]: v(`New ${field}`) } }, actor: ACTOR })));
      eq([e.status, e.code, e.message], [409, "TITLE_NOT_EDITABLE", words], `${field}:`);
      ok(!/search|typesense/i.test(e.message), `no search words: ${e.message}`);
    }
    const d = await get(docs, o.document.id);
    const r = await api(docs, { saveDraft: { id: d.id, body: { ...d.body, settings: { ...d.body.settings, title: v("Through the API") } } }, revision: d.revision });
    eq([r.status, r.body.code, r.body.error], [409, "TITLE_NOT_EDITABLE", words], "API:");
    // badge and modules still save while it is closed
    const b = await docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, badge: "Still fine" } }, actor: ACTOR }));
    eq(b.document.body.settings.badge, "Still fine", "badge:");
  }
  Gate.setTitleGateForTest(false);
  eq((await open(docs, 4)).titleEditable, true, "forced open:");
});

await t("title gate: with the gate closed, clearing a name saved before is allowed; the description, gallery and template are never gated", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 5);
  await save(docs, o.document.id, { title: v("Before the gate"), display_type: v("Shown type") });
  Gate.setTitleGateForTest(true);
  // an unrelated save keeps the earlier name (it isn't new)
  let d = (await save(docs, o.document.id, { badge: "Still fine" })).document;
  eq(d.body.settings.title.value, "Before the gate", "kept:");
  d = (await save(docs, o.document.id, { title: null, display_type: null })).document;
  eq([d.body.settings.title, d.body.settings.display_type], [null, null], "cleared:");
  d = (await save(docs, o.document.id, { description_html: v("<p>Gate-free words.</p>"), gallery: v([{ media: "/api/media/med_pc1", alt: "Jar" }]), template: "editorial" })).document;
  eq([d.body.settings.description_html.value, d.body.settings.template], ["<p>Gate-free words.</p>", "editorial"], "never gated:");
});

await t("an existing image_with_text module and a 7th module load and save verbatim with inherited warnings, never cut", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 6);
  const longTitle = "T".repeat(95);
  const sections = [
    sec("image_with_text", "sec_iwt", { image: { media: "https://cdn.shopify.com/x.png", alt: "X" }, title: "Old picture module" }),
    ...Array.from({ length: 6 }, (_, i) => sec("rich_text", `sec_m${i}`, { title: i === 0 ? longTitle : `Module ${i}`, html: `<p>Words ${i}</p>` })),
  ];
  const r = await save(docs, o.document.id, {}, sections);
  eq(r.document.body.sections.length, 7, "all seven kept:");
  eq(r.document.body.sections[0].kind, "image_with_text", "image_with_text kept:");
  eq(r.document.body.sections[1].settings.title, longTitle, "the long title kept:");
  const codes = r.issues.filter((i) => i.severity === "warning" && i.code !== "LONG").map((i) => i.code).sort();
  eq(codes, ["MODULES_OVER_LIMIT", "MODULE_NOT_OFFERED", "MODULE_OVER_LIMIT"], "inherited warnings:");
  ok(!r.issues.some((i) => i.severity === "error"), "no error");
  // it loads as it was saved, and publishes with the same warnings
  eq(canon((await get(docs, o.document.id)).body.sections), canon(r.document.body.sections), "loads verbatim:");
  const p = await publish(docs, [o.document.id]);
  ok(p.issues.some((i) => i.code === "MODULE_NOT_OFFERED" && i.level === "warns"), "a publish warning");
  eq(JSON.parse((await liveRow(docs, 6)).modules).length, 7, "seven modules live:");
});

await t("gallery: an image outside the allowlist is refused at publish; gallery media from the library appear in document_refs", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 7);
  const bad = await save(docs, o.document.id, { gallery: v([{ media: "https://images.example.com/jar.png", alt: "Jar" }]) });
  ok(bad.issues.some((i) => i.code === "IMAGE_HOST_NOT_ALLOWED" && i.severity === "warning"), "a draft warns");
  const before = await liveDump(docs);
  const e = await refused(publish(docs, [o.document.id]));
  eq([e.status, e.code], [422, "VALIDATION_FAILED"], "refused:");
  ok(e.extra.issues.some((i) => i.code === "IMAGE_HOST_NOT_ALLOWED" && i.severity === "error"), "the allowlist issue");
  eq(await liveDump(docs), before, "nothing written:");
  eq(R.GALLERY_HOSTS ?? (await import("../lib/registry/settings.js")).GALLERY_HOSTS, ["cdn.shopify.com", "/api/media/<id>"], "the allowlist:");
  await save(docs, o.document.id, { gallery: v([{ media: "/api/media/med_gal1", alt: "One" }, { media: "https://cdn.shopify.com/s/two.png?v=3", alt: "Two" }]) });
  const p = await publish(docs, [o.document.id]);
  const refs = await sql(docs, "SELECT ref_type, ref_id FROM document_refs WHERE version_id = ? AND ref_type = 'media'", [p.published[0].versionId]);
  eq(refs, [{ ref_type: "media", ref_id: "med_gal1" }], "the library image is indexed:");
  const row = await liveRow(docs, 7);
  eq([row.featured_image, row.featured_image_alt, JSON.parse(row.gallery)], ["/api/media/med_gal1", "One", [{ url: "/api/media/med_gal1", alt: "One" }, { url: "https://cdn.shopify.com/s/two.png?v=3", alt: "Two" }]], "the live gallery:");
});

await t("shopifyAdminUrl: the product and collection pages in Shopify admin for a configured store, null without a store domain; openEntityContent returns it", async () => {
  eq(docs.run(() => AdminUrl.shopifyAdminBase()), "https://admin.shopify.com/store/pc-store", "base:");
  eq(docs.run(() => AdminUrl.shopifyAdminUrl({ product: P(1) })), "https://admin.shopify.com/store/pc-store/products/9101", "product:");
  eq(docs.run(() => AdminUrl.shopifyAdminUrl({ collection: COL })), "https://admin.shopify.com/store/pc-store/collections/501", "collection:");
  eq(noDomain.run(() => AdminUrl.shopifyAdminUrl({ product: P(1) })), null, "no store domain:");
  eq(docs.run(() => AdminUrl.shopifyAdminUrl({})), null, "nothing named:");
  eq((await open(docs, 1)).shopifyAdminUrl, "https://admin.shopify.com/store/pc-store/products/9101", "openEntityContent product:");
  eq((await open(docs, COL, "collection_content")).shopifyAdminUrl, "https://admin.shopify.com/store/pc-store/collections/501", "openEntityContent collection:");
  eq((await open(noDomain, 1)).shopifyAdminUrl, null, "openEntityContent without a domain:");
});

// =============================================================================
console.log("— 2. openEntityContent, deleted and returning products, discardOrphanEdits");
// =============================================================================

await t("openEntityContent returns the same id as productDocumentId for a new product (and the same row again), and reuses a phase-3 random-id row", async () => {
  const a = await open(docs, 8);
  eq(a.document.id, await Ids.productDocumentId(P(8)), "deterministic id:");
  eq([a.created, a.document.label, a.document.entityId, a.inShopify, a.shopify.title], [true, "Fixture product 8", P(8), true, "Fixture product 8"], "made:");
  const again = await open(docs, 8);
  eq([again.document.id, again.created], [a.document.id, false], "again:");
  const c = await open(docs, COL, "collection_content");
  eq(c.document.id, await Ids.collectionDocumentId(COL), "collection id:");
  // a phase-3 row: random id, made by the old createDocument
  const legacyId = Ids.newRouteId();
  const body = R.emptyBody("product_content");
  await raw(docs).execute({
    sql: "INSERT INTO documents (id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES (?, 'product_content', NULL, ?, 'Product content', ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
    args: [legacyId, P(10), JSON.stringify(body), await R.documentHash(body)],
  });
  const old = await open(docs, 10);
  eq([old.document.id, old.created], [legacyId, false], "reused:");
  // through the API too
  const r = await api(docs, { openEntityContent: { type: "product_content", entityId: P(10) } });
  eq([r.status, r.body.document.id], [200, legacyId], "API:");
  const missing = await api(docs, { openEntityContent: { type: "product_content", entityId: "gid://shopify/Product/404404" } });
  eq([missing.status, missing.body.code], [404, "NOT_FOUND"], "a product not in the catalog:");
});

await t("a product deleted and returned with the same id keeps its edits with no editor visit; its document is never archived by the delete; an archived document is brought back by openEntityContent; a new id leaves the old edits orphaned", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 11);
  await save(docs, o.document.id, { title: v("Survivor"), badge: "Back" });
  await publish(docs, [o.document.id]);
  eq((await effective(docs, 11)).title, "Survivor", "live:");
  await docs.run(() => Sync.deleteProductByGid(P(11)));
  eq(await effective(docs, 11), null, "gone from the catalog:");
  eq((await sql(docs, "SELECT archived_at FROM documents WHERE id = ?", [o.document.id]))[0].archived_at, null, "never archived by the delete:");
  ok(await liveRow(docs, 11), "the live row stays");
  const gone = await open(docs, 11);
  eq([gone.inShopify, gone.shopify], [false, null], "no longer in Shopify, read live:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(11)));
  eq([(await effective(docs, 11)).title, (await effective(docs, 11)).badge], ["Survivor", "Back"], "back with its edits at once:");
  // an archived document (draft edits only) comes back through openEntityContent
  const o12 = await open(docs, 12);
  await save(docs, o12.document.id, { badge: "Draft only" });
  const d12 = await get(docs, o12.document.id);
  await docs.run(() => Docs.archive({ id: d12.id, revision: d12.revision, actor: ACTOR }));
  await docs.run(() => Sync.deleteProductByGid(P(12)));
  const stillArchived = await open(docs, 12);
  ok(stillArchived.document.archivedAt && !stillArchived.unarchived, "gone and archived: answered as it is");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(12)));
  const back = await open(docs, 12);
  eq([back.unarchived, back.document.archivedAt, back.document.body.settings.badge, back.document.id], [true, null, "Draft only", o12.document.id], "un-archived with its edits:");
  // a new id for the same handle: the old edits are orphaned
  await docs.run(() => Sync.deleteProductByGid(P(11)));
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(11, { id: "gid://shopify/Product/77711", handle: "fixture-product-11" })));
  const fresh = await open(docs, "gid://shopify/Product/77711");
  ok(fresh.created && fresh.document.id !== o.document.id, "a new document for the new id");
  const eff = (await sql(docs, "SELECT COALESCE(c.title, p.title) AS title FROM products p LEFT JOIN product_content_live c ON c.product_id = p.id WHERE p.id = 'gid://shopify/Product/77711'"))[0];
  eq(eff.title, "Fixture product 11", "the new product has none of the old edits:");
  eq((await open(docs, 11)).inShopify, false, "the old edits are orphaned:");
});

await t("discardOrphanEdits removes the live row only for an orphan (one 'discard' outbox row, handle null), is refused while the product is in Shopify, and keeps everything when the product comes back between the check and the batch", async () => {
  Gate.setTitleGateForTest(false);
  const id = (await open(docs, 11)).document.id; // orphaned in the case above
  // refused for a product that is in Shopify
  const inShop = (await open(docs, 1)).document;
  const r1 = await api(docs, { discardOrphanEdits: { id: inShop.id }, revision: inShop.revision });
  eq([r1.status, r1.body.code], [409, "PRODUCT_IN_SHOPIFY"], "in Shopify:");
  // the product comes back between the check and the batch
  const before = await liveDump(docs);
  Docs.discardHooks.beforeBatch = async () => docs.run(() => Sync.writeProduct(F.fixtureProduct(11)));
  const d = await get(docs, id);
  const e = await refused(docs.run(() => Docs.discardOrphanEdits({ id, revision: d.revision, actor: ACTOR })));
  eq([e.status, e.code], [409, "PRODUCT_IN_SHOPIFY"], "came back:");
  ok(await liveRow(docs, 11), "the live row is kept");
  eq(JSON.parse(before).outbox.length, (await outbox(docs)).length, "no outbox row:");
  eq((await get(docs, id)).revision, d.revision, "the draft is kept:");
  Docs.discardHooks.beforeBatch = null;
  // gone again: discarded
  await docs.run(() => Sync.deleteProductByGid(P(11)));
  const n0 = (await outbox(docs)).length;
  const d2 = await get(docs, id);
  const r = await api(docs, { discardOrphanEdits: { id }, revision: d2.revision });
  eq(r.status, 200, `discard: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(await liveRow(docs, 11), null, "the live row went:");
  const added = (await outbox(docs)).slice(n0);
  eq(added.map((x) => [x.product_id, x.handle, x.reason]), [[P(11), null, "discard"]], "one discard row, handle null:");
  ok(added[0].done_at, "the fast path after the API's 200 marked it done (no Typesense here)");
  eq([r.body.document.publishedVersionId, r.body.document.body.settings.title, r.body.document.revision], [null, null, d2.revision + 1], "the draft reset:");
  ok((await sql(docs, "SELECT note FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' ORDER BY rowid DESC LIMIT 1", [id]))[0].note === Docs.DISCARD_NOTE, "the old draft is kept as a checkpoint");
  eq((await sql(docs, "SELECT action, release_id FROM publish_log WHERE document_id = ? ORDER BY rowid DESC LIMIT 1", [id]))[0], { action: "discard", release_id: null }, "log:");
  // staff can't discard
  const s = await api(docs, { discardOrphanEdits: { id }, revision: r.body.document.revision }, STAFF);
  eq(s.status, 403, "staff:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(11)));
});

await t("writeProduct (full sync) and syncProductByGid (webhook) after an edit leave the edited fields' effective values unchanged and change the unedited ones", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 1);
  await save(docs, o.document.id, { title: v("Founder's name"), display_type: v("Founder's type"), badge: null });
  await publish(docs, [o.document.id]);
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(1, { title: "Sync title", vendor: "Sync vendor", productType: "Sync type", descriptionHtml: "<p>Sync words</p>" })));
  eq(await effective(docs, 1), { title: "Founder's name", vendor: "Sync vendor", type: "Founder's type", html: "<p>Sync words</p>", badge: null }, "after a full sync:");
  const node = {
    ...F.fixtureProduct(1),
    title: "Webhook title",
    vendor: "Webhook vendor",
    productType: "Webhook type",
    descriptionHtml: "<p>Webhook words</p>",
    status: "ACTIVE",
    priceRangeV2: { minVariantPrice: { amount: "100", currencyCode: "INR" }, maxVariantPrice: { amount: "100", currencyCode: "INR" } },
    options: [],
    variants: { nodes: [{ id: `${P(1)}1`, title: "Default Title", sku: "FX-1", price: "100", compareAtPrice: null, availableForSale: true, inventoryQuantity: 5, selectedOptions: [], image: null }] },
  };
  await docs.run(() => Sync.syncProductByGid(P(1), { gql: async () => ({ node }) }));
  eq(await effective(docs, 1), { title: "Founder's name", vendor: "Webhook vendor", type: "Founder's type", html: "<p>Webhook words</p>", badge: null }, "after a webhook:");
  eq((await sql(docs, "SELECT title FROM products WHERE id = ?", [P(1)]))[0].title, "Webhook title", "Shopify's own value moved:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(1)));
});

// =============================================================================
console.log("— 3. publish and Undo with live rows, the search outbox, the mode guard");
// =============================================================================

await t("publishing one product changes exactly one product_content_live row, inserts no releases row and one 'publish' outbox row; an unpublished draft never appears in product_content_live", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 9);
  await save(docs, o.document.id, { badge: "Draft badge", title: v("Draft-only name") });
  eq(await liveRow(docs, 9), null, "a draft is not live:");
  const before = await sql(docs, "SELECT * FROM product_content_live ORDER BY product_id");
  const releases = await countOf(docs, "releases");
  const ob = (await outbox(docs)).length;
  const p = await publish(docs, [o.document.id]);
  eq(p.release, null, "no release:");
  ok(typeof p.setId === "string" && p.setId.startsWith("set_"), "a set id");
  eq(await countOf(docs, "releases"), releases, "no releases row:");
  const after = await sql(docs, "SELECT * FROM product_content_live ORDER BY product_id");
  const changed = after.filter((r) => canon(r) !== canon(before.find((b) => b.product_id === r.product_id)));
  eq(changed.map((r) => r.product_id), [P(9)], "exactly one row changed:");
  eq(after.length, before.length + 1, "one row added:");
  const row = changed[0];
  eq([row.title, row.badge, row.document_id, row.version_id], ["Draft-only name", "Draft badge", o.document.id, p.published[0].versionId], "the row:");
  eq((await outbox(docs)).slice(ob), [{ product_id: P(9), handle: "fixture-product-9", reason: "publish", done_at: null }], "one outbox row:");
  eq(p.published[0].liveUrl, "/api/preview?exit=1&to=%2Fproducts%2Ffixture-product-9", "liveUrl:");
  // a later draft is not live until published
  await save(docs, o.document.id, { badge: "Next badge" });
  eq((await liveRow(docs, 9)).badge, "Draft badge", "the next draft is not live:");
  eq((await sql(docs, "SELECT action, release_id FROM publish_log WHERE id = ?", [p.published[0].undo.logId]))[0], { action: "publish", release_id: null }, "log:");
});

await t("no releases.content ever holds overlay values (a scan of every release after the publishes in this suite)", async () => {
  const overlays = await sql(docs, "SELECT title, badge, display_type, modules FROM product_content_live");
  const words = new Set();
  for (const r of overlays) for (const v of [r.title, r.badge, r.display_type]) if (typeof v === "string" && v.length > 3) words.add(v);
  ok(words.size >= 5, `enough overlay values to scan: ${[...words].join(", ")}`);
  await homeId(docs);
  await publish(docs, ["doc_home"]);
  const contents = await sql(docs, "SELECT content FROM releases");
  ok(contents.length >= 1, "a release exists");
  for (const { content } of contents) {
    for (const w of words) ok(!String(content).includes(w), `a release holds "${w}"`);
    ok(!/doc_prod_|doc_coll_/.test(String(content)), "a release lists a content document");
  }
});

await t("Undo restores the previous live row, or deletes it after a first publish; each writes one 'undo' outbox row", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 2);
  await save(docs, o.document.id, { badge: "First", title: null, display_vendor: null });
  const p1 = await publish(docs, [o.document.id]);
  const row1 = await liveRow(docs, 2);
  await save(docs, o.document.id, { badge: "Second" });
  const p2 = await publish(docs, [o.document.id]);
  eq((await liveRow(docs, 2)).badge, "Second", "second live:");
  const ob = (await outbox(docs)).length;
  const dry = await undo(docs, o.document.id, p2.published[0].undo.logId, true);
  eq(dry.body.changes, [{ words: "Badge changed" }], "dry run words:");
  const u = await undo(docs, o.document.id, p2.published[0].undo.logId);
  eq(u.status, 200, "undo:");
  const back = await liveRow(docs, 2);
  eq([back.badge, back.title], [row1.badge, row1.title], "the previous row is back:");
  ok(back.version_id !== row1.version_id, "as a fresh version");
  eq((await outbox(docs)).slice(ob).map((r) => [r.product_id, r.reason, r.handle]), [[P(2), "undo", "fixture-product-2"]], "one undo row:");
  // Undo of the first publish deletes the row
  const fresh = await open(docs, 3);
  const d3 = await get(docs, fresh.document.id);
  const p3log = (await sql(docs, "SELECT id FROM publish_log WHERE document_id = ? AND action = 'publish' ORDER BY rowid", [d3.id]))[0].id;
  ok(await liveRow(docs, 3), "product 3 is live (from the keep case)");
  const ob2 = (await outbox(docs)).length;
  const u3 = await undo(docs, d3.id, p3log);
  eq(u3.status, 200, `undo first: ${JSON.stringify(u3.body).slice(0, 200)}`);
  eq(await liveRow(docs, 3), null, "the live row is deleted:");
  eq([u3.body.document.publishedVersionId, u3.body.document.body.settings.title?.value], [null, "Kept name"], "the draft stays:");
  ok(/shows what Shopify sends again/.test(u3.body.message), u3.body.message);
  eq((await outbox(docs)).slice(ob2).map((r) => r.reason), ["undo"], "one undo row:");
  // Recently published lets it be undone and words it
  const list = await docs.run(() => U.listRecentlyPublished({ limit: 50 }, { actor: ACTOR }));
  const row = list.body.rows.find((r) => r.logId === p1.published[0].undo.logId);
  ok(row && row.summary.length, "the product publish is listed with words");
});

await t("a stored mode that stops being documents between the pre-check and the batch ('migrating', then 'legacy') makes a live-row publish, an Undo, a discardOrphanEdits and a mixed-set publish abort with no row changed and 500 STORE_MODE_INVALID", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 4);
  await save(docs, o.document.id, { badge: "Mode test" });
  const p = await publish(docs, [o.document.id]);
  await save(docs, o.document.id, { badge: "Mode test 2" });
  await homeId(docs);
  const h = await get(docs, "doc_home");
  await docs.run(() => Docs.saveDraft({ id: "doc_home", revision: h.revision, body: { ...h.body, sections: [sec("hero", "sec_hero", { title: `Hello ${Date.now()}` })] }, actor: ACTOR }));
  // an orphan to discard
  const orphan = await open(docs, 12);
  await docs.run(() => Sync.deleteProductByGid(P(12)));
  for (const mode of ["migrating", "legacy"]) {
    const before = await liveDump(docs);
    const flip = async () => setMode(docs, mode);
    const cases = [
      ["live-row publish", () => publish(docs, [o.document.id])],
      ["mixed-set publish", () => publish(docs, ["doc_home", o.document.id])],
      ["Undo", () => undo(docs, o.document.id, p.published[0].undo.logId)],
    ];
    for (const [label, run] of cases) {
      Pub.setPublishHooks({ beforeCommit: flip });
      const e = await refused(run());
      Pub.setPublishHooks({});
      await setMode(docs, "documents");
      eq([e.status, e.code, e.message], [500, "STORE_MODE_INVALID", Mode.STORE_MODE_INVALID_MESSAGE], `${mode} ${label}:`);
      ok(!/another|someone else|changed after/i.test(e.message), `${label}: not a race`);
      eq(await liveDump(docs), before, `${mode} ${label}: rows changed:`);
    }
    Docs.discardHooks.beforeBatch = flip;
    const dd = await get(docs, orphan.document.id);
    const e = await refused(docs.run(() => Docs.discardOrphanEdits({ id: dd.id, revision: dd.revision, actor: ACTOR })));
    Docs.discardHooks.beforeBatch = null;
    await setMode(docs, "documents");
    eq([e.status, e.code], [500, "STORE_MODE_INVALID"], `${mode} discard:`);
    eq(await liveDump(docs), before, `${mode} discard: rows changed:`);
  }
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(12)));
});

await t("a publish on a store whose stored mode is 'legacy' or 'migrating' is refused with 500 STORE_MODE_INVALID; a collection-only publish writes collection_content_live.pinned and layout_template and no outbox row", async () => {
  for (const fx of [legacy, moving]) {
    const o = await fx.run(() => Docs.createDocument({ type: "product_content", entityId: P(1), actor: ACTOR }));
    const e = await refused(fx.run(() => Pub.publish({ ids: [{ id: o.document.id, revision: 1, draftHash: o.document.draftHash }], actor: ACTOR })));
    eq([e.status, e.code], [500, "STORE_MODE_INVALID"], `${fx.id}:`);
    const r = await api(fx, { publish: { id: o.document.id, draftHash: o.document.draftHash }, revision: 1 });
    eq([r.status, r.body.code], [500, "STORE_MODE_INVALID"], `${fx.id} API:`);
    eq(await countOf(fx, "product_content_live"), 0, `${fx.id} live rows:`);
    const op = await api(fx, { openEntityContent: { type: "product_content", entityId: P(1) } });
    eq([op.status, op.body.code], [500, "STORE_MODE_INVALID"], `${fx.id} openEntityContent:`);
  }
  const c = await open(docs, COL, "collection_content");
  const r = await save(docs, c.document.id, { pinned: [P(2), P(1)], template: "sidebar" });
  eq(r.document.body.settings.pinned, [P(2), P(1)], "saved:");
  const ob = (await outbox(docs)).length;
  const p = await publish(docs, [c.document.id]);
  eq(p.release, null, "no release:");
  const row = (await sql(docs, "SELECT * FROM collection_content_live WHERE collection_id = ?", [COL]))[0];
  eq([JSON.parse(row.pinned), row.layout_template, row.document_id, row.version_id], [[P(2), P(1)], "sidebar", c.document.id, p.published[0].versionId], "the row:");
  eq((await outbox(docs)).length, ob, "no outbox row for a collection:");
  eq(p.published[0].liveUrl, "/api/preview?exit=1&to=%2Fcollections%2Fsummer", "liveUrl:");
});

await t("unpublish of a product or collection content document is refused with the plain words, leaves the live row and writes no outbox row", async () => {
  for (const id of [(await open(docs, 9)).document.id, (await open(docs, COL, "collection_content")).document.id]) {
    const before = await liveDump(docs);
    const d = await get(docs, id);
    for (const dryRun of [false, true]) {
      const r = await api(docs, { unpublish: { id, dryRun }, revision: d.revision });
      eq([r.status, r.body.code, r.body.error], [422, "CANNOT_TAKE_OFFLINE_CONTENT", "Product content can't be taken offline. To go back to what Shopify sends, choose Use Shopify's on each field and publish."], `${id} dryRun ${dryRun}:`);
    }
    eq(await liveDump(docs), before, "nothing changed:");
  }
});

await t("archive is refused while a live version exists, in words that fit product content", async () => {
  const d = await get(docs, (await open(docs, 9)).document.id);
  const e = await refused(docs.run(() => Docs.archive({ id: d.id, revision: d.revision, actor: ACTOR })));
  eq([e.status, e.code], [409, "DOCUMENT_LIVE"], "refused:");
  ok(/Use Shopify's on each field and publish/.test(e.message), e.message);
});

await t("the cart ruling: doc_cart saves with storefront.write (staff) and publishes with storefront.publish (owner, not staff)", async () => {
  await homeId(docs);
  const c = await api(docs, { createDocument: { type: "cart" } }, STAFF);
  eq(c.status, 200, `create: ${JSON.stringify(c.body).slice(0, 200)}`);
  const s = await api(docs, { saveDraft: { id: "doc_cart", body: { ...c.body.document.body, settings: { ...c.body.document.body.settings, title: "Pairs nicely" } } }, revision: c.body.document.revision }, STAFF);
  eq(s.status, 200, `staff saves: ${JSON.stringify(s.body).slice(0, 200)}`);
  const staffPub = await api(docs, { publish: { id: "doc_cart", draftHash: s.body.document.draftHash }, revision: s.body.document.revision }, STAFF);
  eq(staffPub.status, 403, "staff can't publish:");
  const ownerPub = await api(docs, { publish: { id: "doc_cart", draftHash: s.body.document.draftHash }, revision: s.body.document.revision });
  eq(ownerPub.status, 200, `owner publishes: ${JSON.stringify(ownerPub.body).slice(0, 300)}`);
  const u = await api(docs, { undo: { id: "doc_cart", logId: ownerPub.body.published[0].undo.logId, dryRun: true }, revision: s.body.document.revision });
  eq(u.status, 200, "Undo is offered for the cart too:");
});

// =============================================================================
console.log("— 4. mixed sets and the title belt");
// =============================================================================

await t("a mixed set (doc_home plus a product) publishes all of it in one release batch: the live row, one outbox row, no list entry for the product; Undo of the set puts both back", async () => {
  Gate.setTitleGateForTest(false);
  await homeId(docs);
  const o = await open(docs, 5);
  await save(docs, o.document.id, { badge: "Mixed 1", description_html: null, gallery: null, template: null });
  const h = await get(docs, "doc_home");
  await docs.run(() => Docs.saveDraft({ id: "doc_home", revision: h.revision, body: { ...h.body, sections: [sec("hero", "sec_hero", { title: "Mixed home" })] }, actor: ACTOR }));
  const ob = (await outbox(docs)).length;
  const p = await publish(docs, ["doc_home", o.document.id]);
  ok(p.release?.id, "a release");
  const list = JSON.parse((await sql(docs, "SELECT content FROM releases WHERE id = ?", [p.release.id]))[0].content);
  ok(!Object.hasOwn(list.documents, o.document.id), "the product is not in the list");
  eq((await liveRow(docs, 5)).badge, "Mixed 1", "live row:");
  eq((await outbox(docs)).slice(ob).map((r) => [r.product_id, r.reason]), [[P(5), "publish"]], "outbox:");
  // Undo of the whole set
  const h2 = await get(docs, "doc_home");
  const homeRow = p.published.find((x) => x.id === "doc_home");
  const prodRow = p.published.find((x) => x.id === o.document.id);
  const before = await liveRow(docs, 5);
  const ob2 = (await outbox(docs)).length;
  const r = await docs.run(() => U.undoSet({ kind: "undoSet", setId: p.setId, members: [{ id: "doc_home", logId: homeRow.undo.logId }, { id: o.document.id, logId: prodRow.undo.logId }] }, { actor: ACTOR }));
  eq(r.status, 200, `undoSet: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(h2.publishedVersionId !== (await get(docs, "doc_home")).publishedVersionId, "home moved back");
  ok(canon(await liveRow(docs, 5)) !== canon(before), "the product row moved back");
  eq((await outbox(docs)).slice(ob2).map((x) => [x.product_id, x.reason]), [[P(5), "undo"]], "undoSet outbox:");
});

await t("the title belt: a mixed set (doc_home plus a product whose draft name was saved before the gate closed) is refused, naming the product in plain words; the same set without that product publishes", async () => {
  Gate.setTitleGateForTest(false);
  await homeId(docs);
  const o = await open(docs, 6);
  await save(docs, o.document.id, { title: v("Saved before the gate") });
  const h = await get(docs, "doc_home");
  await docs.run(() => Docs.saveDraft({ id: "doc_home", revision: h.revision, body: { ...h.body, sections: [sec("hero", "sec_hero", { title: "Belt home" })] }, actor: ACTOR }));
  Gate.setTitleGateForTest(true);
  const before = await liveDump(docs);
  const e = await refused(publish(docs, ["doc_home", o.document.id]));
  eq([e.status, e.code], [409, "TITLE_NOT_PUBLISHABLE"], "refused:");
  eq(e.message, "The new name for “Fixture product 6” can't go live right now. Reset the name or leave this product out of this publish.", "words (a forced gate, no condition):");
  // a closed condition names itself, never search
  Gate.setTitleGateForTest({ blocked: true, cause: "readers" });
  const e2 = await refused(publish(docs, ["doc_home", o.document.id]));
  eq(e2.message, "The new name for “Fixture product 6” can't go live yet, because some screens of your store's admin still show Shopify's product names. Reset the name or leave this product out of this publish.", "words (readers):");
  ok(!/search/i.test(e2.message), "never search's words");
  Gate.setTitleGateForTest(true);
  eq(e.extra.documents, [{ id: o.document.id, label: "Fixture product 6" }], "named:");
  eq(await liveDump(docs), before, "nothing written:");
  const p = await publish(docs, ["doc_home"]);
  eq(p.published.map((x) => x.id), ["doc_home"], "without it:");
});

// =============================================================================
console.log("— 7. P4-SEARCH: the LIVEROW review");
// =============================================================================

await t("a description saved back in its cleaned form (Shopify's markup cleaned the same way) follows Shopify: stored null", async () => {
  Gate.setTitleGateForTest(false);
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(13, { descriptionHtml: '<p style="color:red">Soft <span>cotton</span></p>' })));
  const o = await open(docs, 13);
  const d = (await save(docs, o.document.id, { description_html: v("<p>Soft <span>cotton</span></p>") })).document;
  eq(d.body.settings.description_html, null, "cleaned-equal:");
  const mine = (await save(docs, o.document.id, { description_html: v("<p>Soft <span>linen</span></p>") })).document;
  eq([mine.body.settings.description_html.value, mine.body.settings.description_html.base_value], ["<p>Soft <span>linen</span></p>", '<p style="color:red">Soft <span>cotton</span></p>'], "a real change is the founder's, based on Shopify's raw value:");
  await save(docs, o.document.id, { description_html: null });
});

await t("a rich text or text module with no title is incomplete in a draft and an error at publish, in words naming the module; with a title it publishes and shows", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 14);
  for (const [kind, settings, what] of [["rich_text", { title: "", html: "<p>Care: wash cold.</p>" }, "rich text"], ["text", { title: "  ", body: ["Care: wash cold."] }, "text"]]) {
    const r = await save(docs, o.document.id, {}, [sec(kind, "sec_untitled", settings)]);
    const i = r.issues.find((x) => x.code === "MODULE_TITLE_MISSING");
    ok(i && i.severity === "incomplete" && i.sectionId === "sec_untitled" && i.field === "title", `${kind} draft: ${JSON.stringify(r.issues)}`);
    eq(i.message, `This ${what} module has no title, so shoppers won't see it: on the product page a module shows as a title they tap to open. Add a title.`, `${kind} words:`);
    const before = await liveDump(docs);
    const e = await refused(publish(docs, [o.document.id]));
    eq([e.status, e.code], [422, "VALIDATION_FAILED"], `${kind} publish:`);
    ok(e.extra.issues.some((x) => x.code === "MODULE_TITLE_MISSING" && x.severity === "error"), `${kind}: the error`);
    eq(await liveDump(docs), before, `${kind}: nothing written:`);
  }
  await save(docs, o.document.id, {}, [sec("rich_text", "sec_titled", { title: "Care", html: "<p>Care: wash cold.</p>" })]);
  await publish(docs, [o.document.id]);
  eq(JSON.parse((await liveRow(docs, 14)).modules), [{ title: "Care", html: "<p>Care: wash cold.</p>" }], "a titled module goes live:");
});

await t("an image-with-text module's image from another website warns in a draft and is refused at publish (the gallery's allowlist); Shopify's host and the library go live", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 15);
  const bad = await save(docs, o.document.id, {}, [sec("image_with_text", "sec_iwtbad", { image: { media: "https://evil.example.com/a.png", alt: "A" }, title: "Look" })]);
  ok(bad.issues.some((i) => i.code === "IMAGE_HOST_NOT_ALLOWED" && i.severity === "warning" && i.sectionId === "sec_iwtbad"), `draft warns: ${JSON.stringify(bad.issues)}`);
  const before = await liveDump(docs);
  const e = await refused(publish(docs, [o.document.id]));
  eq([e.status, e.code], [422, "VALIDATION_FAILED"], "refused:");
  ok(e.extra.issues.some((i) => i.code === "IMAGE_HOST_NOT_ALLOWED" && i.severity === "error" && i.sectionId === "sec_iwtbad"), "the allowlist error");
  eq(await liveDump(docs), before, "nothing written:");
  ok(!JSON.stringify(await liveRow(docs, 15)).includes("evil.example.com"), "the image never went live");
  for (const media of ["https://cdn.shopify.com/s/files/look.png", "/api/media/med_iwt1"]) {
    await save(docs, o.document.id, {}, [sec("image_with_text", "sec_iwtok", { image: { media, alt: "A" }, title: "Look" })]);
    const p = await publish(docs, [o.document.id]);
    eq(p.published.length, 1, `${media} publishes:`);
    ok((await liveRow(docs, 15)).modules.includes(media), `${media} is live`);
  }
});

await t("a product that is no longer in Shopify can't be published: 409 in plain words pointing to Discard edits, nothing written", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 16);
  await save(docs, o.document.id, { badge: "Gone soon" });
  await docs.run(() => Sync.deleteProductByGid(P(16)));
  const before = await liveDump(docs);
  const e = await refused(publish(docs, [o.document.id]));
  eq([e.status, e.code], [409, "PRODUCT_NOT_IN_SHOPIFY"], "refused:");
  eq(e.message, "“Fixture product 16” is no longer in Shopify, so its edits can't go live. Open it and choose Discard edits, or leave it out of this publish.", "words:");
  eq(e.extra.documents, [{ id: o.document.id, label: "Fixture product 16" }], "named:");
  eq(await liveDump(docs), before, "no live row, no outbox row:");
  // in a mixed set too
  await homeId(docs);
  const e2 = await refused(publish(docs, ["doc_home", o.document.id]));
  eq(e2.code, "PRODUCT_NOT_IN_SHOPIFY", "mixed set:");
  eq(await liveDump(docs), before, "mixed set: nothing written:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(16)));
});

await t("Undo and undoSet can't put a name live while the gate is closed (the belt, in the blocking condition's words); Undo of a first publish (Shopify's names) still works", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 17);
  await save(docs, o.document.id, { title: v("Secret name") });
  await publish(docs, [o.document.id]);
  await save(docs, o.document.id, { title: null });
  const p2 = await publish(docs, [o.document.id]);
  eq((await liveRow(docs, 17)).title, null, "Shopify's name is live:");
  Gate.setTitleGateForTest({ blocked: true, cause: "readers" });
  const before = await liveDump(docs);
  const e = await refused(undo(docs, o.document.id, p2.published[0].undo.logId));
  eq([e.status, e.code], [409, "TITLE_NOT_PUBLISHABLE"], "Undo refused:");
  eq(e.message, "The earlier name for “Fixture product 17” can't go live again yet, because some screens of your store's admin still show Shopify's product names. Nothing was changed.", "words:");
  ok(!/search/i.test(e.message), "never search's words");
  const dry = await refused(undo(docs, o.document.id, p2.published[0].undo.logId, true));
  eq(dry.code, "TITLE_NOT_PUBLISHABLE", "the dry run says so too:");
  const es = await refused(docs.run(() => U.undoSet({ kind: "undoSet", setId: p2.setId, members: [{ id: o.document.id, logId: p2.published[0].undo.logId }] }, { actor: ACTOR })));
  eq(es.code, "TITLE_NOT_PUBLISHABLE", "undoSet refused:");
  eq(await liveDump(docs), before, "nothing changed:");
  eq((await liveRow(docs, 17)).title, null, "the secret name never went live:");
  // a first publish's Undo (back to Shopify's names) is not a new name
  const o2 = await open(docs, 18);
  Gate.setTitleGateForTest(false);
  await save(docs, o2.document.id, { title: v("Eighteen") });
  const first = await publish(docs, [o2.document.id]);
  Gate.setTitleGateForTest({ blocked: true, cause: "readers" });
  const u = await undo(docs, o2.document.id, first.published[0].undo.logId);
  eq([u.status, await liveRow(docs, 18)], [200, null], "Undo of a first publish:");
});

await t("two people publishing the same product in a products-only set: the second to commit gets 409 PUBLISHED_ELSEWHERE naming the person who published, never 503 busy", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 19);
  await save(docs, o.document.id, { badge: "Race" });
  const d = await get(docs, o.document.id);
  let raced = false;
  Pub.setPublishHooks({
    beforeCommit: async () => {
      if (raced) return;
      raced = true;
      // Meera publishes the same draft first
      await docs.run(() => Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }], actor: ADMIN_ACTOR }));
    },
  });
  const e = await refused(docs.run(() => Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }], actor: ACTOR })));
  Pub.setPublishHooks({});
  eq([e.status, e.code], [409, "PUBLISHED_ELSEWHERE"], `refused: ${e.message}`);
  eq(e.extra.current.updatedByName, "Meera Iyer", "names who published:");
  eq((await liveRow(docs, 19)).badge, "Race", "Meera's publish is live:");
  eq((await sql(docs, "SELECT count(*) AS n FROM publish_log WHERE document_id = ? AND action = 'publish'", [d.id]))[0].n, 1, "one publish:");
});

await t("discardOrphanEdits of a product that only had a draft writes no outbox row", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 20);
  await save(docs, o.document.id, { badge: "Draft only" });
  eq(await liveRow(docs, 20), null, "never published:");
  await docs.run(() => Sync.deleteProductByGid(P(20)));
  const before = (await outbox(docs)).length;
  const d = await get(docs, o.document.id);
  const r = await docs.run(() => Docs.discardOrphanEdits({ id: d.id, revision: d.revision, actor: ACTOR }));
  eq(r.removedLive, false, "no live row:");
  eq((await outbox(docs)).length, before, "no outbox row:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(20)));
});

await t("openEntityContent's un-archive checks the mode in its own batch: a store whose stored mode stops being documents meanwhile gets 500 STORE_MODE_INVALID and the document stays archived", async () => {
  Gate.setTitleGateForTest(false);
  const o = await open(docs, 12);
  const d = await get(docs, o.document.id);
  if (!d.archivedAt) await docs.run(() => Docs.archive({ id: d.id, revision: d.revision, actor: ACTOR }));
  ok((await get(docs, o.document.id)).archivedAt, "archived");
  for (const mode of ["migrating", "legacy"]) {
    Docs.openEntityHooks.beforeUnarchive = async () => setMode(docs, mode);
    const e = await refused(open(docs, 12));
    Docs.openEntityHooks.beforeUnarchive = null;
    await setMode(docs, "documents");
    eq([e.status, e.code], [500, "STORE_MODE_INVALID"], `${mode}:`);
    ok((await get(docs, o.document.id)).archivedAt, `${mode}: still archived`);
  }
  const back = await open(docs, 12);
  eq([back.unarchived, back.document.archivedAt], [true, null], "in documents mode it comes back:");
});

// =============================================================================
console.log("— 5. a real sqld behind the fault proxy");
// =============================================================================

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
let direct = null;
try {
  const found = H.findSqld(); // throws (the suite fails) when sqld is missing: never a skip
  const [sqldPort, proxyPort] = (process.env.TEST_PRODUCT_CONTENT_PORTS || "").split(",").map((p) => Number(p) || 0);
  dataDir = await mkdtemp(join(process.env.TEST_PRODUCT_CONTENT_DATA || tmpdir(), "storeasy-test-product-content-"));
  sqld = H.startSqld({ bin: found.bin, key: "product-content", port: sqldPort || (await freePort()), dataDir });
  await H.waitForHealth(sqld.url, sqld.child, { logFile: sqld.logFile, label: "test:product-content" });
  proxy = startFaultProxy({ listenPort: proxyPort || 0, upstreamPort: sqld.port });
  await proxy.ready;
  direct = createClient({ url: sqld.url }); // inspection, never through the proxy
  await direct.executeMultiple(schema);
  await runMigrations(direct, await loadMigrations("tenant"));
  await direct.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  const TENANT = { id: "pcsqld", dbUrl: proxy.url, config: CONFIG, secrets: {} };
  const fx = { id: "pcsqld", run: (fn) => withTenant(TENANT, fn) };
  for (const n of [1, 2]) await fx.run(() => Sync.writeProduct(F.fixtureProduct(n)));
  const dsql = async (q, args = []) => (await direct.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
  const counts = async (docId) => ({
    releases: Number((await dsql("SELECT count(*) AS n FROM releases"))[0].n),
    log: Number((await dsql("SELECT count(*) AS n FROM publish_log WHERE document_id = ?", [docId]))[0].n),
    versions: Number((await dsql("SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND kind = 'published'", [docId]))[0].n),
    outbox: Number((await dsql("SELECT count(*) AS n FROM search_outbox"))[0].n),
  });

  await t("sqld (commitThenDrop): a live-row publish whose answer is lost reports success once lib/db.js resends it, with one version, one log row and one outbox row", async () => {
    Gate.setTitleGateForTest(false);
    const o = await fx.run(() => Docs.openEntityContent({ type: "product_content", entityId: P(1), actor: ACTOR }));
    const d = (await fx.run(() => Docs.saveDraft({ id: o.document.id, revision: o.document.revision, body: { ...o.document.body, settings: { ...o.document.body.settings, badge: "Dropped" } }, actor: ACTOR }))).document;
    const before = await counts(d.id);
    proxy.resetCounters();
    proxy.commitThenDrop(1, "batch");
    const p = await fx.run(() => Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }], actor: ACTOR }));
    proxy.pass();
    eq(proxy.counters.committedThenDropped, 1, "the answer was dropped after commit:");
    ok(proxy.counters.batches >= 1, `reconciled without blind write retry (${proxy.counters.batches})`);
    const after = await counts(d.id);
    eq([after.releases - before.releases, after.log - before.log, after.versions - before.versions, after.outbox - before.outbox], [0, 1, 1, 1], "one of each, no release:");
    eq((await dsql("SELECT version_id, badge FROM product_content_live WHERE product_id = ?", [P(1)]))[0], { version_id: p.published[0].versionId, badge: "Dropped" }, "live:");
  });

  await t("sqld (commitThenDrop): a mixed set (doc_home plus a product) is all-or-none: the lost answer is found as this publish, the retry adds nothing; then an aborted mixed batch (mode change) leaves no row and no outbox row", async () => {
    Gate.setTitleGateForTest(false);
    const home = (await fx.run(() => Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [sec("hero", "sec_hero", { title: "Sqld home" })] }, actor: ACTOR }))).document;
    const o = await fx.run(() => Docs.openEntityContent({ type: "product_content", entityId: P(2), actor: ACTOR }));
    const d = (await fx.run(() => Docs.saveDraft({ id: o.document.id, revision: o.document.revision, body: { ...o.document.body, settings: { ...o.document.body.settings, badge: "Mixed sqld" } }, actor: ACTOR }))).document;
    const before = await counts(d.id);
    const ids = [
      { id: home.id, revision: home.revision, draftHash: home.draftHash },
      { id: d.id, revision: d.revision, draftHash: d.draftHash },
    ];
    proxy.resetCounters();
    proxy.commitThenDrop(1, "batch");
    const p = await fx.run(() => Pub.publish({ ids, actor: ACTOR }));
    proxy.pass();
    eq(proxy.counters.committedThenDropped, 1, "dropped after commit:");
    const after = await counts(d.id);
    eq([after.releases - before.releases, after.log - before.log, after.versions - before.versions, after.outbox - before.outbox], [1, 1, 1, 1], "one of each:");
    eq((await dsql("SELECT live_release_id AS l FROM release_state"))[0].l, p.release.id, "the pointer:");
    eq((await dsql("SELECT badge, version_id FROM product_content_live WHERE product_id = ?", [P(2)]))[0], { badge: "Mixed sqld", version_id: p.published.find((x) => x.id === d.id).versionId }, "the live row:");
    // an aborted mixed batch: nothing, no outbox row
    const d2 = (await fx.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, badge: "Never live" } }, actor: ACTOR }))).document;
    const h2 = await fx.run(() => Docs.getDocument(home.id));
    const h3 = (await fx.run(() => Docs.saveDraft({ id: home.id, revision: h2.revision, body: { ...h2.body, sections: [sec("hero", "sec_hero", { title: "Sqld home 2" })] }, actor: ACTOR }))).document;
    const mid = await counts(d.id);
    Pub.setPublishHooks({ beforeCommit: async () => direct.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1") });
    const e = await refused(fx.run(() => Pub.publish({ ids: [{ id: home.id, revision: h3.revision, draftHash: h3.draftHash }, { id: d.id, revision: d2.revision, draftHash: d2.draftHash }], actor: ACTOR })));
    Pub.setPublishHooks({});
    await direct.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
    eq([e.status, e.code, e.message], [500, "STORE_MODE_INVALID", Mode.STORE_MODE_INVALID_MESSAGE], "mode refusal:");
    eq(await counts(d.id), mid, "nothing written:");
    eq((await dsql("SELECT badge FROM product_content_live WHERE product_id = ?", [P(2)]))[0].badge, "Mixed sqld", "the live row is unchanged:");
  });
} catch (e) {
  fail++;
  console.error(`✗ the sqld cases could not run: ${e?.stack || e}`);
} finally {
  try {
    direct?.close();
  } catch {}
  if (proxy) await proxy.close().catch(() => {});
  if (sqld) await H.stopChild(sqld.child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

// =============================================================================
console.log("— 6. pure parts");
// =============================================================================

await t("liveRowFor maps a body to the live columns (modules as the product page reads them, plain description, first gallery image featured)", () => {
  const body = {
    ...R.emptyBody("product_content"),
    settings: {
      ...R.emptyBody("product_content").settings,
      title: { value: "Name", base_hash: "h", base_value: "Old" },
      description_html: { value: "<p>Fast &amp; <b>clean</b></p><p>Two</p>", base_hash: null, base_value: null },
      gallery: { value: [{ media: "/api/media/med_a", alt: "A" }, { media: "https://cdn.shopify.com/b.png", alt: null }], base_hash: null, base_value: null },
      badge: "",
      pairs: { title: "Goes with", products: [P(1), P(2)] },
      template: "editorial",
      keep_variant_images: false,
    },
    sections: [sec("faq", "sec_f", { items: [{ q: "Q?", a: "<p>A.</p>" }] })],
  };
  const row = LR.liveRowFor("product_content", body, { documentId: "doc_prod_x", versionId: "ver_x", publishedAt: "2026-11-04T00:00:00.000Z", entityId: P(1) });
  eq(
    [row.product_id, row.title, row.description, row.featured_image, row.featured_image_alt, row.badge, JSON.parse(row.modules), JSON.parse(row.pairs), row.pairs_title, row.layout_template, row.keep_variant_images],
    [P(1), "Name", "Fast & clean Two", "/api/media/med_a", "A", null, [{ title: "Q?", html: "<p>A.</p>" }], [P(1), P(2)], "Goes with", "editorial", 0],
  );
  eq(Object.keys(row).sort(), [...LR.PRODUCT_LIVE_COLUMNS].sort(), "every column:");
  const empty = LR.liveRowFor("product_content", R.emptyBody("product_content"), { documentId: "d", versionId: "v", publishedAt: "x" });
  eq([empty.title, empty.gallery, empty.modules, empty.pairs], [null, null, null, null], "an empty body follows Shopify:");
  ok(Ch.describeChanges("product_content", body, { ...body, settings: { ...body.settings, title: null } }).some((r) => r.words === "Name: back to Shopify's"), "change words");
});

for (const c of raws.values()) c.close();
await F.removeFixtureFiles("pc");
await rm(join(ROOT, ".test-pc-default.db"), { force: true });
console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
process.exit(fail ? 1 : 0);
