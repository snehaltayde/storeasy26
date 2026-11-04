// P4-SEARCH (OVL-05, OVL-03, OVL-04, OVL-06, OVL-17): search and the console
// read the names shoppers see, and a published name reaches search at once.
// Real file databases (scripts/support/tenant-fixture.js), the real services,
// the real console API (lib/admin/documents-api.js, real sessions), the real
// job worker and the real sync. Typesense is ALWAYS a spy client
// (lib/typesense-search.js setSearchAdminClientForTest) with dummy localhost
// values set in this process only: nothing is ever sent anywhere, and every
// fetch is refused and recorded (no Shopify call either).
//   1. the full sync: buildSearchDoc over indexRows, the outbox marked and pruned
//   2. the fast path: one product reindexed on publish, Undo, Reset, discard
//   3. failures: a throwing or hanging client, the job, a dead queue, coalescing
//   4. tenants without Typesense or a namespace; only the tenant's collection
//   5. console readers: pickers (offers, bundles, upsells), reports
//   6. the editor's product list (listProductContent)
//   pnpm test:search-effective
import "./support/request-cache.js";
import { registerHooks } from "node:module";
import { readFile, rm } from "node:fs/promises";
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
process.env.DATABASE_URL = "file:.test-se-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
const TS_ENV = ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "TYPESENSE_PORT", "TYPESENSE_PROTOCOL"];
for (const k of [...TS_ENV, "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "SHOPIFY_STOREFRONT_TOKEN"]) delete process.env[k];
// dummy local values: the spy client below is what every call reaches
const typesenseOn = () => {
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
};
const typesenseOff = () => {
  for (const k of TS_ENV) delete process.env[k];
};

// No network at all: every fetch is recorded and refused.
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url?.url ?? url));
  throw new Error("test-search-effective: no network in this suite");
};
// slog lines are collected (and kept quiet unless SE_SHOW is set)
const logs = [];
const realLog = console.log;
console.log = (...a) => {
  if (a.length === 1 && typeof a[0] === "string" && a[0].startsWith("{")) {
    try {
      logs.push(JSON.parse(a[0]));
      if (!process.env.SE_SHOW) return;
    } catch {
      /* not a log line */
    }
  }
  realLog(...a);
};

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("se");
await rm(join(ROOT, ".test-se-default.db"), { force: true });
await F.makePlatform({ name: "se" });
const { withTenant, tenantId } = await import("../lib/tenant-context.js");
const R = await import("../lib/registry/index.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const Gate = await import("../lib/catalog/title-gate.js");
const Sync = await import("../lib/sync.js");
const TS = await import("../lib/typesense-search.js");
const SR = await import("../lib/catalog/search-reindex.js");
const SD = await import("../lib/catalog/search-doc.js");
const E = await import("../lib/catalog/effective.js");
const PCL = await import("../lib/admin/product-content-list.js");
const W = await import("../lib/platform/worker.js");
const J = await import("../lib/platform/jobs.js");
const Reporting = await import("../lib/reporting.js");
const OffersCat = await import("../lib/offers/catalog.js");
const { upsertPlacement } = await import("../lib/cms/placements.js");
const { handleRefsGet } = await import("../lib/admin/refs.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    realLog(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 6).join("\n   ") || e}`);
  } finally {
    TS.setSearchAdminClientForTest(null);
    SR.setSearchReindexTestHooks({});
    Gate.setTitleGateForTest(null);
    typesenseOn();
  }
}
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const eq = (got, want, label = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${label} expected ${canon(want).slice(0, 900)}, got ${canon(got).slice(0, 900)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const logsSince = (n, evt) => logs.slice(n).filter((l) => l.evt === evt);

// ---- the spy Typesense client ------------------------------------------------------
// Records every call with the tenant it ran under. Options:
//   onImport(call)   runs inside import (may throw, or return a promise that
//                    never settles: a hang)
function spyClient({ onImport = null } = {}) {
  const calls = [];
  const rec = (c) => calls.push({ ...c, tenant: tenantId() });
  return {
    calls,
    imports: () => calls.filter((c) => c.op === "import"),
    collections(name) {
      if (name === undefined) return { create: async (schema) => (rec({ op: "create", name: schema?.name }), {}) };
      return {
        delete: async () => (rec({ op: "dropCollection", name }), {}),
        documents(id) {
          if (id === undefined) {
            return {
              import: async (docs, opts) => {
                const call = { op: "import", name, docs: JSON.parse(JSON.stringify(docs)), action: opts?.action ?? null };
                rec(call);
                if (onImport) await onImport(call, calls);
                return docs.map(() => ({ success: true }));
              },
            };
          }
          return { delete: async () => (rec({ op: "delete", name, id }), {}) };
        },
      };
    },
  };
}
// every spy made in this suite, for the "only its own collection" check
const allSpies = [];
const spy = (o) => {
  const s = spyClient(o);
  allSpies.push(s);
  return s;
};

// ---- stores and people -----------------------------------------------------------------
const CONFIG = { site: { name: "SE Store" }, site_url: "https://se.test", shopify_store_domain: "se-store.myshopify.com" };
const COLL = "sedocs_products";
const docs = await F.makeTenant({ name: "se-docs", id: "sedocs", products: 260, config: { ...CONFIG, typesense_collection: COLL } });
const nons = await F.makeTenant({ name: "se-nons", id: "senons", products: 3, config: CONFIG });
const legacy = await F.makeTenant({ name: "se-legacy", id: "selegacy", products: 4, config: CONFIG });
const lst = await F.makeTenant({ name: "se-list", id: "selist", products: 45, config: CONFIG });
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
for (const fx of [docs, nons, legacy, lst]) await raw(fx).executeMultiple(schema);
for (const fx of [docs, nons, lst]) await raw(fx).execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");

const ownerU = await I.createUser({ email: "owner@se.test", name: "Asha Rao", password: "owner-pass-search" });
const staffU = await I.createUser({ email: "staff@se.test", name: "Ravi", password: "staff-pass-search" });
for (const fx of [docs, nons, legacy, lst]) {
  await I.addMembership(ownerU.id, fx.id, "owner");
  await I.addMembership(staffU.id, fx.id, "staff");
}
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const ACTOR = { kind: "merchant", id: ownerU.id };
const req = (fx, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (fx, body, as = OWNER) => fx.run(() => handleDocumentsPut(req(fx, as, body)));

const P = (n) => `gid://shopify/Product/${9100 + n}`;
const H = (n) => `fixture-product-${n}`;
const v = (value) => ({ value });
const open = (fx, n) => fx.run(() => Docs.openEntityContent({ type: "product_content", entityId: typeof n === "string" ? n : P(n), actor: ACTOR }));
const get = (fx, id) => fx.run(() => Docs.getDocument(id));
async function save(fx, id, settings = {}) {
  const d = await get(fx, id);
  return fx.run(() => Docs.saveDraft({ id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, ...settings } }, actor: ACTOR }));
}
// a publish through the service: no fast path (the outbox row stays pending)
async function publish(fx, ids) {
  const items = [];
  for (const id of ids) {
    const d = await get(fx, id);
    items.push({ id, revision: d.revision, draftHash: d.draftHash });
  }
  return fx.run(() => Pub.publish({ ids: items, actor: ACTOR }));
}
// a publish through the console API: the fast path runs after it
async function apiPublish(fx, ids) {
  const items = [];
  for (const id of ids) {
    const d = await get(fx, id);
    items.push({ id, revision: d.revision, draftHash: d.draftHash });
  }
  if (items.length === 1) return api(fx, { publish: { id: items[0].id, draftHash: items[0].draftHash }, revision: items[0].revision });
  return api(fx, { publishSet: items });
}
// rename (or set settings) and publish through the service
async function rename(fx, n, settings) {
  const o = await open(fx, n);
  await save(fx, o.document.id, typeof settings === "string" ? { title: v(settings) } : settings);
  return { id: o.document.id, p: await publish(fx, [o.document.id]) };
}
const outbox = (fx) => sql(fx, "SELECT rowid AS rid, product_id, handle, reason, done_at FROM search_outbox ORDER BY rowid");
const pending = async (fx) => (await outbox(fx)).filter((r) => r.done_at == null);
const docFor = async (fx, n) => SD.buildSearchDoc((await fx.run(() => E.indexRows({ ids: [P(n)] }))).rows[0]);
const shopifyNodes = (fx) => fx.products.map((p) => ({ ...p }));
const fetchersFor = (fx) => ({
  products: async ({ onPage } = {}) => {
    const nodes = shopifyNodes(fx);
    if (onPage) await onPage(nodes.length, "cursor-se");
    return nodes;
  },
  collections: async () => [],
});
const fullSync = (fx) => fx.run(() => Sync.runCatalogSync({ fetchers: fetchersFor(fx), startedBy: "test" }));
typesenseOn();
Gate.setTitleGateForTest(null); // the real conditions: the gate is open (P4-SEARCH)

// =============================================================================
realLog("— 1. the full sync");
// =============================================================================

await t("a full sync indexes every product through buildSearchDoc over indexRows: the published name and type shown, never Shopify's name over them and never a draft; pending outbox rows go done and done rows older than 30 days are pruned", async () => {
  await rename(docs, 1, "Founder Name One");
  await rename(docs, 2, { display_type: v("Shown Type Two"), display_vendor: v("House Two") });
  const o3 = await open(docs, 3);
  await save(docs, o3.document.id, { title: v("Draft Three") }); // never published
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, ?)", args: [P(250), H(250), old, old] });
  await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, ?)", args: [P(251), H(251), recent, recent] });
  const before = await pending(docs);
  eq(before.map((r) => r.product_id).sort(), [P(1), P(2)].sort(), "two pending rows from the publishes:");
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const res = await fullSync(docs);
  eq(res.products, 260, "the sync wrote the catalog:");
  eq(s.calls.slice(0, 2).map((c) => [c.op, c.name]), [["dropCollection", COLL], ["create", COLL]], "the collection is rebuilt:");
  const imported = s.imports().flatMap((c) => c.docs);
  ok(s.imports().every((c) => c.action === "upsert" && c.name === COLL), "upserts into the tenant's collection");
  // the expected documents, built independently from indexRows' pages
  const want = [];
  let cursor = null;
  do {
    const page = await docs.run(() => E.indexRows({ cursor, limit: 100 }));
    want.push(...page.rows.map(SD.buildSearchDoc));
    cursor = page.cursor;
  } while (cursor != null);
  eq(imported.length, 260, "every product:");
  eq(imported, want, "every document is buildSearchDoc(indexRows row):");
  const byId = new Map(imported.map((d) => [d.id, d]));
  eq(byId.get(H(1)).title, "Founder Name One", "the published name:");
  eq([byId.get(H(2)).product_type, byId.get(H(2)).vendor, byId.get(H(2)).title], ["Shown Type Two", "House Two", "Fixture product 2"], "type and brand shown:");
  eq(byId.get(H(3)).title, "Fixture product 3", "a draft is never indexed:");
  ok(!imported.some((d) => /Draft Three/.test(JSON.stringify(d))), "no draft anywhere");
  eq(byId.get(H(4)).tags, ["fixture"], "Shopify's tags stay the tags:");
  const after = await outbox(docs);
  ok(after.filter((r) => [P(1), P(2)].includes(r.product_id)).every((r) => r.done_at != null), "the pending rows are done");
  ok(!after.some((r) => r.product_id === P(250)), "a done row older than 30 days is pruned");
  ok(after.some((r) => r.product_id === P(251)), "a done row of 10 days stays");
  eq(await pending(docs), [], "nothing pending:");
  // a second full sync keeps the published name (it never restores Shopify's)
  const s2 = spy();
  TS.setSearchAdminClientForTest(s2);
  await fullSync(docs);
  eq(s2.imports().flatMap((c) => c.docs).find((d) => d.id === H(1)).title, "Founder Name One", "after another full sync:");
});

await t("only rows written before the import read the catalog are marked done: a row written during the import stays pending when the drain after it fails, and the next drain takes it", async () => {
  const { id } = await rename(docs, 4, "Four Before");
  ok(id, "renamed");
  let imports = 0;
  const s = spy({
    onImport: async () => {
      imports++;
      // during the rebuild's import: a publish lands (its row is new)
      if (imports === 1) await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, NULL)", args: [P(5), H(5), new Date().toISOString()] });
      // the drain after the import: search is down
      if (imports > 2) throw new Error("search went down");
    },
  });
  TS.setSearchAdminClientForTest(s);
  await docs.run(() => Sync.indexTypesense());
  const rows = await outbox(docs);
  ok(rows.find((r) => r.product_id === P(4) && r.reason === "publish").done_at, "the row from before the read is done");
  const during = rows.filter((r) => r.product_id === P(5));
  eq(during.map((r) => r.done_at), [null], "the row written during the import stays pending:");
  // the next drain takes it
  const s2 = spy();
  TS.setSearchAdminClientForTest(s2);
  const r = await docs.run(() => SR.drainSearchOutbox());
  eq([r.read, r.done], [1, 1], "drained:");
  eq(s2.imports().flatMap((c) => c.docs).map((d) => d.id), [H(5)], "only that product:");
  eq(await pending(docs), [], "nothing pending:");
});

await t("P4-FIX2: when the full sync's drain fails after the reopen, it enqueues a search_reindex job of its own (the publish's job for the same rows is already done), and that job drains the reopened rows", async () => {
  // a publish whose own job ran and finished: its key is taken for good
  const index = new Map();
  await rename(docs, 6, "Six Before Sync");
  const top = (await pending(docs)).at(-1).rid;
  const k = await docs.run(() => SR.kickSearchReindex({ client: indexedSpy(index).s }));
  ok(k.job?.id, "the publish's job");
  TS.setSearchAdminClientForTest(indexedSpy(index).s);
  await W.runDueJobs({ limit: 50 });
  const key = docs.run(() => SR.searchReindexKey(top));
  eq((await J.getJobByKey(key)).status, "done", "the publish's job is done:");
  eq(await pending(docs), [], "nothing pending before the sync:");
  // the full sync: its page import holds Six's old name while a fast drain
  // writes a newer one and marks its row done; the reopen makes that row
  // pending again; then search goes down for the drain
  await rename(docs, 6, "Six V1");
  await docs.run(() => SR.drainSearchOutbox({ client: indexedSpy(index).s }));
  // the rebuild's page imports go through; every import after them (the
  // drain) fails: search went down
  const catalogSize = Number((await sql(docs, "SELECT count(*) AS n FROM products WHERE handle IS NOT NULL AND handle != ''"))[0].n);
  let rebuilt = 0;
  const FS = indexedSpy(index, { holdWhen: (ds) => ds.some((d) => d.id === H(6) && d.title === "Six V1") });
  const failing = spy({
    onImport: async (call) => {
      if (rebuilt >= catalogSize) throw new Error("search went down");
      rebuilt += call.docs.length;
      await FS.s.collections(call.name).documents().import(call.docs, { action: call.action });
    },
  });
  TS.setSearchAdminClientForTest(failing);
  const jobsBefore = (await J.listJobs({ limit: 500 })).filter((j) => j.type === "search_reindex").length;
  const sync = docs.run(() => Sync.indexTypesense());
  await FS.heldNow;
  await rename(docs, 6, "Six V2");
  await docs.run(() => SR.drainSearchOutbox({ client: indexedSpy(index).s }));
  eq(await pending(docs), [], "the fast drain marked its row done:");
  FS.release();
  const r = await sync;
  const left = await pending(docs);
  ok(left.some((x) => x.product_id === P(6)), `the reopened row is pending: ${JSON.stringify(left)}`);
  ok(r.requeued?.key, `the sync says it requeued: ${JSON.stringify(r)}`);
  const top2 = left.at(-1).rid;
  ok(r.requeued.key.startsWith(`search_reindex:sedocs:${top2}:sync:`), `a key of its own: ${r.requeued.key}`);
  const jobs = (await J.listJobs({ limit: 500 })).filter((j) => j.type === "search_reindex");
  eq(jobs.length, jobsBefore + 1, "one new job:");
  eq((await J.getJobByKey(r.requeued.key)).status, "pending", "pending:");
  eq(index.get(H(6)).title, "Six V1", "search holds the old name until the job runs:");
  // the job drains it
  TS.setSearchAdminClientForTest(indexedSpy(index).s);
  await W.runDueJobs({ limit: 50 });
  eq((await J.getJobByKey(r.requeued.key)).status, "done", "the job ran:");
  eq(index.get(H(6)).title, "Six V2", "search holds the live name:");
  eq(await pending(docs), [], "nothing pending:");
});

await t("P4-FIX2: a full sync whose drain succeeds enqueues no extra job", async () => {
  await rename(docs, 7, "Seven Synced");
  const before = (await J.listJobs({ limit: 500 })).length;
  TS.setSearchAdminClientForTest(spy());
  const r = await docs.run(() => Sync.indexTypesense());
  eq(r.requeued, undefined, "no requeue:");
  eq((await J.listJobs({ limit: 500 })).length, before, "no job:");
  eq(await pending(docs), [], "nothing pending:");
});

await t("on a store without Typesense, or without its own namespace, a full sync marks pending rows done and prunes, with no client call", async () => {
  typesenseOff();
  await rename(docs, 6, "Six Without Search");
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const r = await docs.run(() => Sync.indexTypesense());
  eq(r.skipped, "not configured", "skipped:");
  eq(s.calls, [], "no client call:");
  eq(await pending(docs), [], "the row is done:");
  // Typesense on, but this store has no namespace of its own
  typesenseOn();
  await rename(nons, 1, "Nons One");
  ok((await pending(nons)).length === 1, "one pending row");
  const r2 = await nons.run(() => Sync.indexTypesense());
  eq(r2.skipped, "no tenant namespace", "skipped:");
  eq(s.calls, [], "still no client call:");
  eq(await pending(nons), [], "done:");
});

// =============================================================================
realLog("— 2. the fast path");
// =============================================================================

await t("publishing a renamed product alone leaves one pending outbox row; the fast path upserts only that product with the published name from indexRows({ids}), marks the row done, and never drops or recreates the collection (also through the console API)", async () => {
  const before = (await outbox(docs)).length;
  const { p } = await rename(docs, 20, "Twenty Renamed");
  eq(p.release, null, "a products-only publish:");
  const rows = (await outbox(docs)).slice(before);
  eq(rows.map((r) => [r.product_id, r.handle, r.reason, r.done_at]), [[P(20), H(20), "publish", null]], "one pending row:");
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const k = await docs.run(() => SR.kickSearchReindex());
  eq(k.drained.upserted, 1, "one upsert:");
  eq(s.calls.map((c) => [c.op, c.name]), [["import", COLL]], "only an import, into the tenant's collection:");
  eq(s.imports()[0].docs, [await docFor(docs, 20)], "the document indexRows({ids}) gives:");
  eq(s.imports()[0].docs[0].title, "Twenty Renamed", "the new name:");
  eq(s.imports()[0].action, "upsert", "upsert:");
  eq(await pending(docs), [], "the row is done:");
  // through the console API: the answer is the publish's, the drain follows
  const s2 = spy();
  TS.setSearchAdminClientForTest(s2);
  const o = await open(docs, 21);
  await save(docs, o.document.id, { title: v("Twenty One Renamed") });
  const r = await apiPublish(docs, [o.document.id]);
  eq([r.status, r.body.ok, r.body.release], [200, true, null], "the API answer:");
  eq(s2.calls.map((c) => [c.op, c.name, c.docs?.map((d) => [d.id, d.title])]), [["import", COLL, [[H(21), "Twenty One Renamed"]]]], "the fast path:");
  eq(await pending(docs), [], "done:");
});

await t("in a publishSet (two products) each product leaves one outbox row and the fast path upserts exactly those two, once each", async () => {
  const ids = [];
  for (const [n, name] of [[22, "Set Twenty Two"], [23, "Set Twenty Three"]]) {
    const o = await open(docs, n);
    await save(docs, o.document.id, { title: v(name) });
    ids.push(o.document.id);
  }
  const before = (await outbox(docs)).length;
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const r = await apiPublish(docs, ids);
  eq(r.status, 200, `publishSet: ${JSON.stringify(r.body).slice(0, 200)}`);
  const rows = (await outbox(docs)).slice(before);
  eq(rows.map((x) => x.product_id).sort(), [P(22), P(23)].sort(), "one row per product:");
  ok(rows.every((x) => x.done_at), "both done");
  eq(s.imports().length, 1, "one import:");
  eq(s.imports()[0].docs.map((d) => [d.id, d.title]).sort(), [[H(22), "Set Twenty Two"], [H(23), "Set Twenty Three"]], "exactly those two:");
  ok(!s.calls.some((c) => c.op === "dropCollection" || c.op === "create" || c.op === "delete"), "nothing dropped, made or deleted");
});

await t("Undo puts the previous name back in search; Reset then publish indexes Shopify's name; Undo of a first publish indexes Shopify's name", async () => {
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const last = (n) => s.imports().flatMap((c) => c.docs).filter((d) => d.id === H(n)).at(-1);
  const o = await open(docs, 24);
  await save(docs, o.document.id, { title: v("Name A") });
  await apiPublish(docs, [o.document.id]);
  await save(docs, o.document.id, { title: v("Name B") });
  const second = await apiPublish(docs, [o.document.id]);
  eq(last(24).title, "Name B", "B is in search:");
  const d = await get(docs, o.document.id);
  const u = await api(docs, { undo: { id: o.document.id, logId: second.body.published[0].undo.logId }, revision: d.revision });
  eq(u.status, 200, `undo: ${JSON.stringify(u.body).slice(0, 200)}`);
  eq(last(24).title, "Name A", "Undo put A back:");
  // Reset (the draft only), then publish: Shopify's name
  await save(docs, o.document.id, { title: null });
  eq(last(24).title, "Name A", "a Reset alone changes nothing in search:");
  await apiPublish(docs, [o.document.id]);
  eq(last(24).title, "Fixture product 24", "Reset then publish:");
  // Undo of a first publish
  const o2 = await open(docs, 25);
  await save(docs, o2.document.id, { title: v("Twenty Five First") });
  const first = await apiPublish(docs, [o2.document.id]);
  eq(last(25).title, "Twenty Five First", "published:");
  const d2 = await get(docs, o2.document.id);
  const u2 = await api(docs, { undo: { id: o2.document.id, logId: first.body.published[0].undo.logId }, revision: d2.revision });
  eq(u2.status, 200, "undo first:");
  eq(last(25).title, "Fixture product 25", "Shopify's name again:");
  eq(await pending(docs), [], "done:");
  ok(!s.calls.some((c) => c.op === "dropCollection" || c.op === "create"), "the collection was never dropped or made");
});

await t("discardOrphanEdits of a product that left Shopify deletes its search entry by the handle stored before; a row with no handle and none stored before is marked done and left to the full sync", async () => {
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const o = await open(docs, 26);
  await save(docs, o.document.id, { title: v("Twenty Six Gone Soon") });
  await apiPublish(docs, [o.document.id]); // its row stores the handle
  await docs.run(() => Sync.deleteProductByGid(P(26)));
  const d = await get(docs, o.document.id);
  const r = await api(docs, { discardOrphanEdits: { id: o.document.id }, revision: d.revision });
  eq(r.status, 200, `discard: ${JSON.stringify(r.body).slice(0, 200)}`);
  const row = (await outbox(docs)).filter((x) => x.product_id === P(26)).at(-1);
  eq([row.reason, row.handle], ["discard", null], "the discard row (handle null):");
  ok(row.done_at, "done");
  eq(s.calls.filter((c) => c.op === "delete").map((c) => [c.name, c.id]), [[COLL, H(26)]], "deleted by its stored handle:");
  // a product never seen with a handle: nothing to delete, marked done
  const s2 = spy();
  TS.setSearchAdminClientForTest(s2);
  await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES ('gid://shopify/Product/404404', NULL, 'publish', ?, NULL)", args: [new Date().toISOString()] });
  const k = await docs.run(() => SR.drainSearchOutbox());
  eq([k.read, k.done, k.deleted, k.upserted], [1, 1, 0, 0], "a null handle row:");
  eq(s2.calls, [], "no call for it:");
  await docs.run(() => Sync.writeProduct(F.fixtureProduct(26)));
});

// =============================================================================
realLog("— 3. failures, the job, the backstop and coalescing");
// =============================================================================

await t("a client that throws leaves the publish answer unchanged (200), the row pending and a search_reindex_failed line; the search_reindex job then drains it", async () => {
  const s = spy({
    onImport: async () => {
      throw new Error("search is down");
    },
  });
  TS.setSearchAdminClientForTest(s);
  const o = await open(docs, 27);
  await save(docs, o.document.id, { title: v("Twenty Seven Late") });
  const n = logs.length;
  const r = await apiPublish(docs, [o.document.id]);
  eq([r.status, r.body.ok, r.body.published.length], [200, true, 1], "the publish answer:");
  eq((await pending(docs)).map((x) => x.product_id), [P(27)], "the row stays pending:");
  const failed = logsSince(n, "search_reindex_failed");
  eq(failed.length, 1, "one failure line:");
  ok(/search is down/.test(failed[0].error) && failed[0].tenant === "sedocs", JSON.stringify(failed[0]));
  const job = await J.getJobByKey(`search_reindex:sedocs:${(await pending(docs))[0].rid}`);
  eq([job?.type, job?.status, job?.tenant_id], ["search_reindex", "pending", "sedocs"], "a durable job was enqueued:");
  // the job drains it
  const s2 = spy();
  TS.setSearchAdminClientForTest(s2);
  const ran = await W.runDueJobs({ limit: 50 });
  ok(ran.some((x) => x.type === "search_reindex" && x.ok), `the job ran: ${JSON.stringify(ran).slice(0, 300)}`);
  eq(await pending(docs), [], "drained:");
  eq(s2.imports().flatMap((c) => c.docs).filter((d) => d.id === H(27)).map((d) => d.title), ["Twenty Seven Late"], "the new name in search:");
});

await t("a client that hangs leaves the publish answer unchanged (200) within the cap, the row pending and a search_reindex_timeout line; the job then drains it", async () => {
  SR.setSearchReindexTestHooks({ timeoutMs: 80 });
  const s = spy({ onImport: () => new Promise(() => {}) });
  TS.setSearchAdminClientForTest(s);
  const o = await open(docs, 28);
  await save(docs, o.document.id, { title: v("Twenty Eight Slow") });
  const n = logs.length;
  const t0 = Date.now();
  const r = await apiPublish(docs, [o.document.id]);
  const ms = Date.now() - t0;
  eq([r.status, r.body.ok], [200, true], "the publish answer:");
  ok(ms < 2000, `answered within the cap (${ms} ms)`);
  eq(logsSince(n, "search_reindex_timeout").filter((l) => l.stage === "drain").length, 1, "one timeout line:");
  eq((await pending(docs)).map((x) => x.product_id), [P(28)], "pending:");
  SR.setSearchReindexTestHooks({});
  const s2 = spy();
  TS.setSearchAdminClientForTest(s2);
  await W.runDueJobs({ limit: 50 });
  eq(await pending(docs), [], "the job drained it:");
  eq(s2.imports().flatMap((c) => c.docs).find((d) => d.id === H(28))?.title, "Twenty Eight Slow", "in search:");
});

await t("with enqueueDurable returning null (a dead queue) and the inline drain failing, the next full sync converges", async () => {
  const jobsBefore = (await J.listJobs({ limit: 500 })).length;
  SR.setSearchReindexTestHooks({ enqueue: async () => null });
  TS.setSearchAdminClientForTest(spy({ onImport: async () => { throw new Error("search is down"); } }));
  const o = await open(docs, 29);
  await save(docs, o.document.id, { title: v("Twenty Nine Converges") });
  const r = await apiPublish(docs, [o.document.id]);
  eq(r.status, 200, "the publish:");
  eq((await J.listJobs({ limit: 500 })).length, jobsBefore, "no job:");
  eq((await pending(docs)).map((x) => x.product_id), [P(29)], "pending:");
  SR.setSearchReindexTestHooks({});
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  await fullSync(docs);
  eq(s.imports().flatMap((c) => c.docs).find((d) => d.id === H(29)).title, "Twenty Nine Converges", "the full sync indexed it:");
  eq(await pending(docs), [], "converged:");
});

await t("a row written while a drain runs stays pending (only the rowids the drain read are marked done)", async () => {
  await rename(docs, 30, "Thirty Drained");
  const s = spy({
    onImport: async () => {
      await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, NULL)", args: [P(31), H(31), new Date().toISOString()] });
    },
  });
  TS.setSearchAdminClientForTest(s);
  const r = await docs.run(() => SR.drainSearchOutbox());
  eq([r.read, r.done], [1, 1], "the row it read:");
  eq((await pending(docs)).map((x) => x.product_id), [P(31)], "the row written meanwhile stays pending:");
  TS.setSearchAdminClientForTest(spy());
  await docs.run(() => SR.drainSearchOutbox());
});

await t("two kicks for the same pending rows enqueue one job; a kick after a later publish (a new pending rowid) enqueues a second job even though the first is done", async () => {
  TS.setSearchAdminClientForTest(spy({ onImport: async () => { throw new Error("down"); } }));
  await rename(docs, 32, "Thirty Two");
  const top1 = (await pending(docs)).at(-1).rid;
  const k1 = await docs.run(() => SR.kickSearchReindex());
  const k2 = await docs.run(() => SR.kickSearchReindex());
  ok(k1.job?.id && k2.job?.id, "both kicks reached the queue");
  eq([k2.job.id, k2.job.existed], [k1.job.id, true], "coalesced into one job:");
  const key1 = docs.run(() => SR.searchReindexKey(top1));
  eq(key1, `search_reindex:sedocs:${top1}`, "the key:");
  eq((await J.listJobs({ limit: 500 })).filter((j) => j.idempotency_key === key1).length, 1, "one job for those rows:");
  TS.setSearchAdminClientForTest(spy());
  await W.runDueJobs({ limit: 50 });
  eq((await J.getJobByKey(key1)).status, "done", "the first job is done:");
  eq(await pending(docs), [], "drained:");
  // a later publish
  TS.setSearchAdminClientForTest(spy({ onImport: async () => { throw new Error("down"); } }));
  await rename(docs, 33, "Thirty Three");
  const top2 = (await pending(docs)).at(-1).rid;
  ok(top2 > top1, "a new pending rowid");
  const k3 = await docs.run(() => SR.kickSearchReindex());
  ok(k3.job?.id && k3.job.id !== k1.job.id && !k3.job.existed, "a second job");
  eq((await J.getJobByKey(docs.run(() => SR.searchReindexKey(top2)))).status, "pending", "pending:");
  // with nothing pending, no job
  TS.setSearchAdminClientForTest(spy());
  await W.runDueJobs({ limit: 50 });
  const none = await docs.run(() => SR.kickSearchReindex());
  eq([none.queued, none.job], [false, null], "nothing pending, nothing enqueued:");
});

// ---- overlapping writers (fix round 1) ---------------------------------------------
// A stand-in search index whose writes land only when import returns, shared
// by several clients; `holdWhen(docs)` holds that import until released.
function indexedSpy(index, { holdWhen = null } = {}) {
  let release;
  const gate = new Promise((r) => (release = r));
  let held;
  const heldNow = new Promise((r) => (held = r));
  const s = spy({
    onImport: async (call) => {
      if (holdWhen && holdWhen(call.docs)) {
        holdWhen = null;
        held();
        await gate;
      }
      for (const d of call.docs) index.set(d.id, d);
    },
  });
  return { s, release, heldNow };
}

await t("two drains that overlap leave the newest published name in search: drain A holds the old name inside its import while drain B writes the new one and marks both rows done; A re-reads before it marks anything done", async () => {
  const index = new Map();
  await rename(docs, 50, "Name V1");
  const A = indexedSpy(index, { holdWhen: (ds) => ds.some((d) => d.id === H(50) && d.title === "Name V1") });
  const drainA = docs.run(() => SR.drainSearchOutbox({ client: A.s }));
  await A.heldNow;
  await rename(docs, 50, "Name V2");
  const B = indexedSpy(index);
  const rb = await docs.run(() => SR.drainSearchOutbox({ client: B.s }));
  ok(rb.read >= 1, "drain B read rows");
  eq(index.get(H(50)).title, "Name V2", "after drain B:");
  A.release();
  await drainA;
  eq(index.get(H(50)).title, "Name V2", "after drain A finishes, search holds the live name:");
  eq((await docFor(docs, 50)).title, "Name V2", "the live name:");
  eq(await pending(docs), [], "nothing pending:");
});

await t("a full sync whose page import holds an old name while a fast drain writes the new one and marks its row done still ends with the new name in search", async () => {
  const index = new Map();
  await rename(docs, 51, "Sync Name V1");
  const FS = indexedSpy(index, { holdWhen: (ds) => ds.some((d) => d.id === H(51) && d.title === "Sync Name V1") });
  TS.setSearchAdminClientForTest(FS.s);
  const sync = docs.run(() => Sync.indexTypesense());
  await FS.heldNow;
  await rename(docs, 51, "Sync Name V2");
  const fast = indexedSpy(index);
  await docs.run(() => SR.drainSearchOutbox({ client: fast.s }));
  eq(index.get(H(51)).title, "Sync Name V2", "after the fast drain:");
  FS.release();
  await sync;
  eq(index.get(H(51)).title, "Sync Name V2", "after the full sync, search holds the live name:");
  eq(await pending(docs), [], "nothing pending:");
});

await t("a product that keeps changing during every write makes the drain give up after a few re-reads: it throws and every row it read stays pending", async () => {
  await rename(docs, 53, "Busy Fifty Three");
  const s = spy({
    onImport: async () => {
      await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, ?)", args: [P(53), H(53), new Date().toISOString(), new Date().toISOString()] });
    },
  });
  let err = null;
  try {
    await docs.run(() => SR.drainSearchOutbox({ client: s }));
  } catch (e) {
    err = e;
  }
  ok(/kept changing/.test(String(err?.message)), `threw: ${err?.message}`);
  eq(s.imports().length, 5, "five writes, then it stops:");
  eq((await pending(docs)).map((r) => r.product_id), [P(53)], "the row it read stays pending:");
  TS.setSearchAdminClientForTest(spy());
  await docs.run(() => SR.drainSearchOutbox({ client: spy() }));
  eq(await pending(docs), [], "the next drain takes it:");
});

await t("pruning never removes the newest outbox row, so a rowid is never handed out twice", async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await raw(docs).execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, ?)", args: [P(52), H(52), old, old] });
  const top = (await outbox(docs)).at(-1).rid;
  await docs.run(() => SR.pruneOutbox());
  const rows = await outbox(docs);
  eq(rows.at(-1)?.rid, top, "the newest row stays:");
  ok(rows.filter((r) => r.done_at != null).every((r) => r.rid === top || Date.parse(r.done_at) > Date.now() - 31 * 86_400_000), "older done rows are pruned");
});

// =============================================================================
realLog("— 4. stores without Typesense or a namespace; only the store's own collection");
// =============================================================================

await t("on a store without Typesense, or without a namespace, the drain makes no client call and marks the rows done", async () => {
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  typesenseOff();
  await rename(docs, 34, "Thirty Four Off");
  const r = await docs.run(() => SR.drainSearchOutbox());
  eq([r.skipped, r.done], ["not configured", 1], "not configured:");
  typesenseOn();
  await rename(nons, 2, "Nons Two");
  const r2 = await nons.run(() => SR.drainSearchOutbox());
  eq([r2.skipped, r2.done], ["no tenant namespace", 1], "no namespace:");
  eq(s.calls, [], "no client call:");
  eq([await pending(docs), await pending(nons)], [[], []], "done:");
});

await t("_default uses the environment's collection; a store with its own uses only its own: every call any spy saw in this suite addressed the calling store's own collection", async () => {
  process.env.TYPESENSE_COLLECTION = "se_default_products";
  const s = spy();
  TS.setSearchAdminClientForTest(s);
  const asDefault = { ...docs.tenant, id: "_default", config: {} };
  await withTenant(asDefault, async () => {
    const o = await Docs.openEntityContent({ type: "product_content", entityId: P(35), actor: ACTOR });
    const d = await Docs.saveDraft({ id: o.document.id, revision: o.document.revision, body: { ...o.document.body, settings: { ...o.document.body.settings, title: v("Default Thirty Five") } }, actor: ACTOR });
    await Pub.publish({ ids: [{ id: o.document.id, revision: d.document.revision, draftHash: d.document.draftHash }], actor: ACTOR });
    await SR.drainSearchOutbox();
  });
  eq(s.calls.map((c) => [c.op, c.name, c.tenant]), [["import", "se_default_products", "_default"]], "_default:");
  delete process.env.TYPESENSE_COLLECTION;
  const own = { sedocs: COLL, _default: "se_default_products" };
  const all = allSpies.flatMap((x) => x.calls);
  ok(all.length > 20, `calls seen: ${all.length}`);
  for (const c of all) eq(c.name, own[c.tenant], `${c.op} under ${c.tenant}:`);
});

// =============================================================================
realLog("— 5. console readers");
// =============================================================================

const refsGet = (fx, qs, as = STAFF) =>
  fx.run(() =>
    handleRefsGet({
      url: `http://${fx.id}.test/api/admin/refs?${qs}`,
      cookies: { get: (name) => (name === "_admin" ? { value: as } : undefined) },
      headers: { get: (k) => ({ host: `${fx.id}.test` })[k.toLowerCase()] ?? null },
    }),
  );
const adminRoute = async (fx, path, method, body) => {
  const route = await import(`../app/api/admin/${path}/route.js`);
  const res = await fx.run(() =>
    route[method]({
      cookies: { get: (n) => (n === "_admin" ? { value: OWNER } : undefined) },
      headers: { get: (k) => ({ host: `${fx.id}.test` })[k.toLowerCase()] ?? null },
      json: async () => body,
      url: `http://${fx.id}.test/api/admin/${path}`,
    }),
  );
  return { status: res.status, body: await res.json() };
};

await t("the offer, bundle and upsell pickers find a renamed product by its new name (the refs picker they share), with Shopify's name beside it; offer names, example carts and the bundle check use it; a draft name is never shown", async () => {
  await rename(docs, 40, "Picker Renamed Forty");
  const o = await open(docs, 41);
  await save(docs, o.document.id, { title: v("Draft Only Forty One") });
  const r = await refsGet(docs, `type=product&q=${encodeURIComponent("Picker Renamed")}`);
  eq(r.status, 200, "refs:");
  eq(r.body.items.map((i) => [i.id, i.title, i.shopify_title]), [[P(40), "Picker Renamed Forty", "Fixture product 40"]], "the product picker:");
  const hydrated = await refsGet(docs, `type=product&ids=${encodeURIComponent(`${P(40)},${P(41)}`)}`);
  eq(hydrated.body.items.map((i) => [i.title, i.shopify_title ?? null]), [["Picker Renamed Forty", "Fixture product 40"], ["Fixture product 41", null]], "selected items:");
  eq((await refsGet(docs, `type=product&q=${encodeURIComponent("Draft Only")}`)).body.items, [], "a draft name finds nothing:");
  // offers: names and example carts
  const variantId = "gid://shopify/ProductVariant/91401";
  const names = await docs.run(() => OffersCat.offerTargetNames([{ target: { kind: "productId", value: P(40) } }, { target: { kind: "handle", value: H(40) } }, { target: { kind: "variantId", value: variantId } }]));
  eq(names, { [P(40)]: "Picker Renamed Forty", [H(40)]: "Picker Renamed Forty", [variantId]: "Picker Renamed Forty" }, "offer names:");
  const cat = await docs.run(() => OffersCat.exampleCatalog({ type: "BXGY", target: { kind: "productId", value: P(40) } }));
  eq(cat.map((c) => c.title), ["Picker Renamed Forty"], "example cart:");
  // the bundle form's check echoes components by the published name
  const b = await adminRoute(docs, "bundles", "POST", { check: { items: [{ variantId, quantity: 1 }, { variantId: "gid://shopify/ProductVariant/91421", quantity: 1 }], bundle_price: 10 } });
  eq(b.status, 200, `bundles: ${JSON.stringify(b.body).slice(0, 200)}`);
  eq(b.body.compat.components.map((c) => c.title), ["Picker Renamed Forty", "Fixture product 42"], "bundle components:");
});

await t("the upsells route lists targets with the published name and Shopify's beside it; with no live rows its answer is as before plus the name", async () => {
  // a legacy store (placements are a legacy write) with a live row written directly
  await legacy.run(() => upsertPlacement({ kind: "cart_upsell", targetProductIds: [P(1), P(2)], title: "Pairs well" }));
  const before = await adminRoute(legacy, "upsells", "GET");
  eq(before.status, 200, "GET:");
  eq(before.body.placements[0].targets, [{ handle: H(1), state: "ok", title: "Fixture product 1" }, { handle: H(2), state: "ok", title: "Fixture product 2" }], "no live rows:");
  await raw(legacy).execute({ sql: "INSERT INTO product_content_live (product_id, document_id, version_id, title, published_at) VALUES (?, 'doc_prod_x', 'ver_x', 'Upsell Renamed One', ?)", args: [P(1), new Date().toISOString()] });
  const after = await adminRoute(legacy, "upsells", "GET");
  eq(after.body.placements[0].targets[0], { handle: H(1), state: "ok", title: "Upsell Renamed One", shopify_title: "Fixture product 1" }, "renamed:");
  eq(after.body.placements[0].target_handles, [H(1), H(2)], "the handles the form edits are unchanged:");
  const pick = await refsGet(legacy, `type=product&q=${encodeURIComponent("Upsell Renamed")}`);
  eq(pick.body.items.map((i) => i.id), [P(1)], "the upsell form's picker finds it:");
  await raw(legacy).execute({ sql: "DELETE FROM product_content_live WHERE product_id = ?", args: [P(1)] });
});

await t("top products: renaming a product keeps one row with the current published name; a store with no live rows reads Shopify's names as before", async () => {
  const at = new Date().toISOString();
  const order = (id, title) =>
    raw(docs).execute({
      sql: "INSERT INTO orders (id, status, total, currency, snapshot, created_at) VALUES (?, 'paid', 100, 'INR', ?, ?)",
      args: [id, JSON.stringify({ items: [{ productId: P(43), title, qty: 1, lineTotal: 100 }] }), at],
    });
  await order("SE-1", "Fixture product 43");
  await rename(docs, 43, "Forty Three Renamed");
  await order("SE-2", "Forty Three Renamed");
  const top = await docs.run(() => Reporting.topProducts({ days: 30, limit: 50 }));
  const rows = top.products.filter((p) => p.product_id === P(43));
  eq(rows.map((p) => [p.title, p.qty, p.revenue]), [["Forty Three Renamed", 2, 200]], "one row, the current name:");
  // legacy: no live rows, Shopify's current name
  await raw(legacy).execute({ sql: "INSERT INTO orders (id, status, total, currency, snapshot, created_at) VALUES ('SE-L1', 'paid', 50, 'INR', ?, ?)", args: [JSON.stringify({ items: [{ productId: P(3), title: "Old name", qty: 1, lineTotal: 50 }] }), at] });
  const ltop = await legacy.run(() => Reporting.topProducts({ days: 30, limit: 50 }));
  eq(ltop.products.map((p) => [p.product_id, p.title]), [[P(3), "Fixture product 3"]], "legacy:");
  eq(await legacy.run(() => OffersCat.offerTargetNames([{ target: { kind: "productId", value: P(3) } }])), { [P(3)]: "Fixture product 3" }, "legacy offer names:");
  const lr = await refsGet(legacy, "type=product&limit=2");
  eq(Object.keys(lr.body.items[0]).sort(), ["currency", "handle", "id", "price_min", "status", "thumb", "title"], "legacy refs items keep their keys:");
});

await t("the order page's Shopify-title line uses the console's muted text, 4.5:1 or better on its white card (it was the subtle text, 2.56:1)", async () => {
  const OV = await import("../lib/admin/order-view.js");
  const { contrastRatio } = await import("../lib/brand.js");
  const css = await readFile(join(ROOT, "app/console.css"), "utf8");
  const token = (name) => new RegExp(`--c-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
  eq(OV.SHOPIFY_LINE_CLASS, "text-xs text-fg-muted", "the class:");
  const page = await readFile(join(ROOT, "app/(console)/admin/(authed)/orders/[id]/page.js"), "utf8");
  ok(/\{shopifyLines\[i\] && <p className=\{SHOPIFY_LINE_CLASS\}>\{shopifyLines\[i\]\}<\/p>\}/.test(page), "the page draws the line with that class");
  ok(!/text-fg-subtle">\{shopifyLines/.test(page), "no longer the subtle text");
  const ratio = contrastRatio(token("fg-muted"), token("surface"));
  ok(ratio >= 4.5, `fg-muted on surface is ${ratio.toFixed(2)}:1`);
  ok(contrastRatio(token("fg-subtle"), token("surface")) < 4.5, "the old token was below 4.5:1 (the bite)");
  realLog(`   contrast: fg-muted ${token("fg-muted")} on ${token("surface")} = ${ratio.toFixed(2)}:1; fg-subtle ${token("fg-subtle")} = ${contrastRatio(token("fg-subtle"), token("surface")).toFixed(2)}:1`);
});

// =============================================================================
realLog("— 6. the editor's product list");
// =============================================================================

const list = (fx, opts) => fx.run(() => PCL.listProductContent(opts));
async function allPages(fx, opts = {}) {
  const out = [];
  let cursor = null;
  let pages = 0;
  let counts;
  do {
    const r = await list(fx, { ...opts, cursor, limit: opts.limit ?? 10 });
    out.push(...r.items);
    counts = r.counts;
    cursor = r.nextCursor;
    if (++pages > 50) throw new Error("cursor loop");
  } while (cursor);
  return { items: out, counts, pages };
}
const changedIds = async (fx) => (await allPages(fx, { filter: "changed_in_shopify" })).items.map((i) => i.productId);
const L = (n) => P(n); // the list store uses the same fixture ids

await t("listProductContent pages through a catalog over 30 with no gaps or repeats, in the order of the published name; it shows the published name, Shopify's beside it, the edited flag and the document id, never a draft", async () => {
  const one = await rename(lst, 1, "Zebra Renamed");
  const o2 = await open(lst, 2);
  await save(lst, o2.document.id, { title: v("Draft Only Two") });
  const all = await allPages(lst, { limit: 7 });
  eq(all.items.length, 45, "every product:");
  eq(new Set(all.items.map((i) => i.productId)).size, 45, "no repeats:");
  ok(all.pages >= 7, `paged (${all.pages})`);
  const titles = all.items.map((i) => i.title);
  eq(titles, [...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "ordered by the published name:");
  const z = all.items.find((i) => i.productId === L(1));
  eq([z.title, z.shopifyTitle, z.edited, z.live, z.documentId, z.inShopify], ["Zebra Renamed", "Fixture product 1", true, true, one.id, true], "a renamed product:");
  eq(titles.at(-1), "Zebra Renamed", "sorted on the published name:");
  const two = all.items.find((i) => i.productId === L(2));
  eq([two.title, two.shopifyTitle, two.edited, two.live, two.documentId], ["Fixture product 2", null, true, false, o2.document.id], "a draft is never shown:");
  const plain = all.items.find((i) => i.productId === L(3));
  eq([plain.edited, plain.documentId, plain.live], [false, null, false], "an untouched product:");
  eq(all.counts, { all: 45, edited: 2, changedInShopify: 0, orphaned: 0 }, "counts:");
  // through the console API, read by staff
  const r = await api(lst, { listProductContent: { limit: 5 } }, STAFF);
  eq([r.status, r.body.items.length, typeof r.body.nextCursor, r.body.counts.all], [200, 5, "string", 45], "the API:");
  const next = await api(lst, { listProductContent: { limit: 5, cursor: r.body.nextCursor } }, STAFF);
  ok(next.body.items[0].productId !== r.body.items[0].productId, "the cursor moves on");
  eq((await api(lst, { listProductContent: { filter: "nope" } })).status, 400, "a bad filter:");
  eq((await api(legacy, { listProductContent: true })).body.code, "STORE_USES_LEGACY", "a legacy store:");
});

await t("listProductContent q finds a renamed product by its new name and by its Shopify name", async () => {
  const byNew = await list(lst, { q: "zebra" });
  eq(byNew.items.map((i) => i.productId), [L(1)], "by the new name:");
  const byShopify = await list(lst, { q: "Fixture product 1" });
  ok(byShopify.items.some((i) => i.productId === L(1) && i.title === "Zebra Renamed"), "by Shopify's name");
  eq((await list(lst, { q: "Draft Only" })).items, [], "never by a draft name:");
  eq((await list(lst, { q: "100%_" })).items, [], "LIKE characters are plain:");
});

await t("changed_in_shopify: after writeProduct (full sync) or syncProductByGid (webhook) changes an edited field, the product and its count are in; an unedited field is not; a query-string-only image change triggers nothing; deleting the product moves it to orphaned", async () => {
  // product 5: name and gallery edited; product 6: only the badge
  const o5 = await open(lst, 5);
  const img = `https://cdn.shopify.com/fixture/${H(5)}.png`;
  await save(lst, o5.document.id, { title: v("Five Mine"), gallery: v([{ media: img, alt: "Mine" }]) });
  const o6 = await open(lst, 6);
  await save(lst, o6.document.id, { badge: "Six" });
  eq(await changedIds(lst), [], "nothing yet:");
  // Shopify changes an UNEDITED field of 5 (vendor) and the name of 6 (unedited there)
  await lst.run(() => Sync.writeProduct(F.fixtureProduct(5, { vendor: "Other vendor" })));
  await lst.run(() => Sync.writeProduct(F.fixtureProduct(6, { title: "Six in Shopify" })));
  eq(await changedIds(lst), [], "unedited fields never count:");
  // only the image's query string changes
  await lst.run(() => Sync.writeProduct(F.fixtureProduct(5, { featuredImage: { url: `${img}?v=99`, altText: "Fixture product 5" }, images: { nodes: [{ url: `${img}?v=99&width=800`, altText: "Fixture product 5", width: 800, height: 800 }] } })));
  eq(await changedIds(lst), [], "a query-string-only image change:");
  // a full sync changes the edited name (the photo and its alt stay)
  const samePhoto = { featuredImage: { url: img, altText: "Fixture product 5" }, images: { nodes: [{ url: img, altText: "Fixture product 5", width: 800, height: 800 }] } };
  await lst.run(() => Sync.writeProduct(F.fixtureProduct(5, { title: "Five in Shopify", ...samePhoto })));
  let r = await list(lst, { filter: "changed_in_shopify" });
  eq(r.items.map((i) => [i.productId, i.changedFields]), [[L(5), ["title"]]], "the name changed:");
  eq(r.counts.changedInShopify, 1, "count:");
  // a webhook changes the other edited field (the gallery)
  const node = {
    ...F.fixtureProduct(5, { title: "Five in Shopify" }),
    status: "ACTIVE",
    priceRangeV2: { minVariantPrice: { amount: "500", currencyCode: "INR" }, maxVariantPrice: { amount: "500", currencyCode: "INR" } },
    images: { nodes: [{ url: "https://cdn.shopify.com/fixture/new-photo.png", altText: "New", width: 800, height: 800 }] },
    featuredImage: { url: "https://cdn.shopify.com/fixture/new-photo.png", altText: "New" },
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/91051", title: "Default Title", sku: "FX-5", price: "500", compareAtPrice: null, availableForSale: true, inventoryQuantity: 5, selectedOptions: [], image: null }] },
  };
  await lst.run(() => Sync.syncProductByGid(L(5), { gql: async () => ({ node }) }));
  r = await list(lst, { filter: "changed_in_shopify" });
  eq(r.items.map((i) => [i.productId, i.changedFields.sort()]), [[L(5), ["gallery", "title"]]], "after the webhook:");
  ok((await list(lst, {})).items.find((i) => i.productId === L(5))?.changedInShopify, "flagged in the full list too");
  // deleted: orphaned, out of changed
  await lst.run(() => Sync.deleteProductByGid(L(5)));
  r = await list(lst, { filter: "orphaned" });
  eq(r.items.map((i) => [i.productId, i.documentId, i.title, i.inShopify, i.handle]), [[L(5), o5.document.id, "Fixture product 5", false, null]], "orphaned:");
  eq([r.counts.orphaned, r.counts.changedInShopify, r.counts.all], [1, 0, 44], "counts:");
  // back in Shopify
  await lst.run(() => Sync.writeProduct(F.fixtureProduct(5, { title: "Five in Shopify" })));
  eq((await list(lst, { filter: "orphaned" })).counts.orphaned, 0, "back:");
});

await t("after resolveShopifyChange 'keep' or 'shopify', or a Reset, the product leaves changed_in_shopify and its count at once, with no publish", async () => {
  const setup = async (n) => {
    const o = await open(lst, n);
    await save(lst, o.document.id, { title: v(`Mine ${n}`), display_vendor: v(`Brand ${n}`) });
    await lst.run(() => Sync.writeProduct(F.fixtureProduct(n, { title: `Shopify ${n}`, vendor: `Shopify brand ${n}` })));
    return o.document.id;
  };
  const a = await setup(10);
  const b = await setup(11);
  const c = await setup(12);
  eq((await changedIds(lst)).filter((x) => [L(10), L(11), L(12)].includes(x)).sort(), [L(10), L(11), L(12)].sort(), "all three changed:");
  const n0 = (await list(lst, {})).counts.changedInShopify;
  const logRows = async () => Number((await sql(lst, "SELECT count(*) AS n FROM publish_log"))[0].n);
  const logs0 = await logRows();
  for (const [id, choice] of [[a, "keep"], [b, "shopify"]]) {
    for (const field of ["title", "display_vendor"]) {
      const d = await get(lst, id);
      const r = await api(lst, { resolveShopifyChange: { id, field, choice }, revision: d.revision });
      eq(r.status, 200, `${choice} ${field}:`);
    }
  }
  await save(lst, c, { title: null, display_vendor: null }); // Reset
  const r = await list(lst, { filter: "changed_in_shopify" });
  ok(![L(10), L(11), L(12)].some((x) => r.items.some((i) => i.productId === x)), "all three left at once");
  eq(r.counts.changedInShopify, n0 - 3, "the count dropped by three:");
  eq(await logRows(), logs0, "with no publish:");
  // 'keep' kept the founder's value, re-based
  eq((await get(lst, a)).body.settings.title.value, "Mine 10", "kept:");
});

await t("measure: listProductContent on a 400-product store with 24 edited products (the perf seed's size), first page and the changed filter", async () => {
  const perf = await F.makeTenant({ name: "se-perf", id: "seperf", products: 400, config: CONFIG });
  await raw(perf).executeMultiple(schema);
  await raw(perf).execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  for (let n = 1; n <= 24; n++) {
    const o = await open(perf, n);
    await save(perf, o.document.id, { title: v(`Perf ${n}`), badge: "New" });
    if (n % 2) await publish(perf, [o.document.id]);
  }
  for (let n = 1; n <= 6; n++) await perf.run(() => Sync.writeProduct(F.fixtureProduct(n, { title: `Shopify perf ${n}` })));
  const time = async (opts) => {
    const ms = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await list(perf, opts);
      ms.push(performance.now() - t0);
    }
    ms.sort((x, y) => x - y);
    return { p50: ms[14], p95: ms[28] };
  };
  const first = await time({});
  const changed = await time({ filter: "changed_in_shopify" });
  const q = await time({ q: "perf 1" });
  const r = await list(perf, { filter: "changed_in_shopify" });
  eq(r.counts, { all: 400, edited: 24, changedInShopify: 6, orphaned: 0 }, "counts:");
  realLog(`   list timings (ms, local file db): first page p50 ${first.p50.toFixed(2)} p95 ${first.p95.toFixed(2)}; changed p50 ${changed.p50.toFixed(2)} p95 ${changed.p95.toFixed(2)}; q p50 ${q.p50.toFixed(2)} p95 ${q.p95.toFixed(2)}`);
  ok(first.p95 < 500 && changed.p95 < 500, "well under half a second locally");
  raws.get(perf.id)?.close();
});

await t("no Shopify call, and no network call at all, was made anywhere in this suite", async () => {
  eq(fetchCalls, [], "fetch calls:");
});

for (const c of raws.values()) c.close();
await F.removeFixtureFiles("se");
await rm(join(ROOT, ".test-se-default.db"), { force: true });
realLog(`\n${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
process.exit(fail ? 1 : 0);
