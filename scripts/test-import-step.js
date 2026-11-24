// Phase 1 line 5: live import progress in onboarding step 2; a failed import
// says what to do. WP-A (engine and view):
//   1. vetting (pure): every skip reason, its words, the stored list's merge
//   2. the Admin reader: an unreadable node is passed on marked, a failed
//      variant read still throws; collectionsCount is best effort
//   3. the engine on fixture stores (file databases): skips never fail a page
//      or a run, the constraint fallback, a skipped product already in the
//      store survives the prune, a store at 0027 still syncs, collections_total
//   4. faults: 401, 403 (scope), 402, 429, 503, fetch failed, a timeout, a
//      stalled run, anything else: each kind's words and next step; Try again
//      resumes from the cursor
//   5. the view: stages, time left, big catalogs, a finished run's duration,
//      the skipped list
//   6. /api/admin/sync with real sessions: support's GET has exactly the view
//      contract, no raw error, no shop domain, no nudge; every POST refusal
// WP-B (UI): ImportStepBody rendered for every state.
// Nothing here reaches Shopify, Typesense or a hosted database.
//   pnpm test:import-step
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stubUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  // after() needs a request scope; the suite collects the deferred work instead of running it
  "next/server": stubUrl(`export * from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("next/server.js")).href)}; export function after(fn) { (globalThis.__afterQueue ||= []).push(fn); }`),
};
registerHooks({
  resolve(spec, ctx, next) {
    if (STUBS[spec]) return { url: STUBS[spec], shortCircuit: true };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-imp-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
for (const k of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN", "SHOPIFY_ADMIN_TOKEN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]) delete process.env[k];

const started = Date.now();
let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n       ")}`);
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n       expected ${y}\n       got      ${x}`);
};
// the engine's slog lines would bury the results
const realLog = console.log;
const logs = [];
console.log = (...a) => {
  const s = a.join(" ");
  if (s.startsWith('{"ts"')) logs.push(JSON.parse(s));
  else realLog(...a);
};

const V = await import("../lib/admin/sync-view.js");
const Vet = await import("../lib/catalog/sync-vet.js");
const { scanText } = await import("./support/banned-copy.js");

// =========================================================================================
console.log("— 1. vetting (pure)");

const F = await import("./support/tenant-fixture.js");
const P = (i, over = {}) => F.fixtureProduct(i, over);

await t("vetProducts keeps good nodes and skips no title, no handle, a second use of a web address in the page, a marked unreadable node, a non-product id and a non-object", async () => {
  const nodes = [P(1), P(2, { title: "  " }), P(3, { handle: "" }), P(4, { handle: "fixture-product-1" }), { __unreadable: true, id: "gid://shopify/Product/5", handle: "five", title: "Five" }, P(6, { id: "gid://shopify/Collection/6" }), null, P(7)];
  const { keep, skipped } = Vet.vetProducts(nodes);
  eq(keep.map((p) => p.handle), ["fixture-product-1", "fixture-product-7"], "kept:");
  eq(skipped.map((s) => s.reason), ["no_title", "no_handle", "duplicate_handle", "unreadable", "unreadable", "unreadable"], "reasons:");
  eq(Object.keys(skipped[0]), ["type", "id", "handle", "title", "reason"], "a skip's keys:");
  eq([skipped[0].type, skipped[0].id, skipped[3].title], ["product", "gid://shopify/Product/9102", "Five"], "what a skip records:");
});

await t("vetCollections: the same rules for collections", async () => {
  const c = (i, over) => F.fixtureCollection(i, over);
  const { keep, skipped } = Vet.vetCollections([c(1), c(2, { title: "" }), c(3, { handle: null }), c(4, { handle: "fixture-collection-1" }), c(5, { id: "gid://shopify/Product/1" })]);
  eq(keep.length, 1, "kept:");
  eq(skipped.map((s) => [s.type, s.reason]), [["collection", "no_title"], ["collection", "no_handle"], ["collection", "duplicate_handle"], ["collection", "unreadable"]], "reasons:");
});

await t("every reason has a why and a what-to-do, in plain founder words", async () => {
  eq(Object.keys(Vet.SKIP_REASONS).sort(), ["duplicate_handle", "no_handle", "no_title", "unreadable", "wont_save"], "reasons:");
  for (const [k, w] of Object.entries(Vet.SKIP_REASONS)) ok(w.why.endsWith(".") && w.todo.endsWith(".") && w.todo.length > 10, k);
  eq(scanText(JSON.stringify(Vet.SKIP_REASONS)), [], "banned copy:");
});

await t("mergeSkipped deduplicates by id (the later skip wins), keeps at most 50 and counts only new ones", async () => {
  const a = Vet.skipOf("product", P(1), "no_title");
  const first = Vet.mergeSkipped(null, [a]);
  eq([first.list.length, first.added], [1, 1], "first:");
  const again = Vet.mergeSkipped(JSON.stringify(first.list), [{ ...a, reason: "wont_save" }]);
  eq([again.list.length, again.added, again.list[0].reason], [1, 0, "wont_save"], "same id:");
  const many = Vet.mergeSkipped("not json", Array.from({ length: 70 }, (_, i) => Vet.skipOf("product", P(i + 1), "no_title")));
  eq([many.list.length, many.added], [50, 70], "capped list, every new one counted:");
});

// =========================================================================================
console.log("— 2. the Admin reader");

const AC = await import("../lib/shopify-admin-catalog.js");
const adminNode = (i, over = {}) => ({ id: `gid://shopify/Product/${i}`, handle: `p-${i}`, title: `P ${i}`, variants: { pageInfo: { hasNextPage: false }, nodes: [] }, ...over });

await t("fetchProductsPageAdmin: a node reshape can't read comes back marked __unreadable with its id, handle and title; the others are reshaped", async () => {
  const gql = async () => ({ products: { pageInfo: { hasNextPage: false, endCursor: "c1" }, nodes: [adminNode(1), adminNode(2, { variants: { pageInfo: null, nodes: "garbled" } }), null, adminNode(3)] } });
  const page = await AC.fetchProductsPageAdmin({ gql });
  eq(page.nodes.map((n) => (n.__unreadable ? `x:${n.id}` : n.handle)), ["p-1", "x:gid://shopify/Product/2", "x:null", "p-3"], "nodes:");
  eq(Vet.vetProducts(page.nodes).skipped.map((s) => s.reason), ["unreadable", "unreadable"], "the sync skips them:");
});

await t("fetchProductsPageAdmin: a failed variant read still throws (network trouble is never a skip)", async () => {
  let calls = 0;
  const gql = async () => {
    calls++;
    if (calls === 1) return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [adminNode(1, { variants: { pageInfo: { hasNextPage: true, endCursor: "v" }, nodes: [] } })] } };
    throw new Error("fetch failed");
  };
  const r = await AC.fetchProductsPageAdmin({ gql }).then(() => null, (e) => e.message);
  eq(r, "fetch failed", "thrown:");
});

await t("countCollectionsAdmin: Shopify's exact count; AT_LEAST flagged; null when it doesn't answer", async () => {
  eq(await AC.countCollectionsAdmin({ gql: async (q) => (ok(/collectionsCount/.test(q), q), { collectionsCount: { count: 7, precision: "EXACT" } }) }), { count: 7, atLeast: false }, "exact:");
  eq(await AC.countCollectionsAdmin({ gql: async () => ({ collectionsCount: { count: 10000, precision: "AT_LEAST" } }) }), { count: 10000, atLeast: true }, "at least:");
  eq(await AC.countCollectionsAdmin({ gql: async () => { throw new Error("Field 'collectionsCount' doesn't exist"); } }), null, "unknown field:");
  eq(await AC.countCollectionsAdmin({ gql: async () => ({}) }), null, "no answer:");
});

// =========================================================================================
console.log("— 3. the engine on fixture stores");

await F.removeFixtureFiles("imp");
const plat = await F.makePlatform({ name: "imp" });
const C = plat.control;
const S = await import("../lib/sync.js");
const { withTenant } = await import("../lib/tenant-context.js");
const stores = {};
const mk = async (key, opts = {}) => (stores[key] = await F.makeTenant({ name: `imp-${key}`, id: `imp${key}`, mode: "documents", ...opts }));
await mk("eng");
await mk("keep");
await mk("old", { stage: "0027" });
await mk("count");
await mk("fault");
await mk("resume");
await mk("route", { config: { shopify_store_domain: "improute.myshopify.com", shopify_client_id: "imp-client-id-canary" }, secrets: { shopify_client_secret: "imp-client-secret-canary" } });
await mk("other");
await mk("blind");
await mk("old2", { stage: "0027" });
await mk("probe");
await mk("late");
const inS = async (key, fn) => withTenant(await C.getTenant(`imp${key}`, { fresh: true }), fn);
const raw = async (key, q, args = []) => {
  const c = stores[key].client();
  try {
    return (await c.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
  } finally {
    c.close();
  }
};
const latest = async (key) => (await raw(key, "SELECT * FROM sync_runs ORDER BY started_at DESC, rowid DESC LIMIT 1"))[0];
const count = async (key, table) => Number((await raw(key, `SELECT COUNT(*) AS n FROM ${table}`))[0].n);
// page-shaped readers over a list, `size` a page; `seen` records each cursor asked for
const pager = (list, size, seen = []) => async (cursor) => {
  seen.push(cursor);
  const at = cursor == null ? 0 : Number(cursor);
  const nodes = list.slice(at, at + size);
  const next = at + size;
  return { nodes, endCursor: String(next), hasNextPage: next < list.length };
};
const NO_INDEX = async () => ({ indexed: 0 });
const fullSync = (key, fetchers) => inS(key, () => S.runCatalogSync({ fetchers, indexer: NO_INDEX }).catch((e) => ({ error: e.message })));
const viewOf = async (key) => (await inS(key, () => S.catalogSyncStatus())).view;

// the "many" catalog (40 products, 4 collections) with one of each bad kind
const many = F.catalogFor("many");
const broken = many.products.map((p, i) => {
  if (i === 3) return { ...p, title: null };
  if (i === 5) return { ...p, handle: "" };
  if (i === 7) return { ...p, handle: many.products[6].handle };
  if (i === 9) return { __unreadable: true, id: p.id, handle: p.handle, title: p.title };
  if (i === 11) return { ...p, images: { nodes: [{ url: null, altText: "x" }] } }; // product_images.url NOT NULL: only the database refuses it
  if (i === 13) return { ...p, variants: { nodes: "garbled" } }; // statements can't be built
  return p;
});
const brokenCols = many.collections.map((c, i) => (i === 2 ? { ...c, title: "" } : c));

await t("skips never fail a page or a run: 6 products and 1 collection skipped, every other one in, the run complete, the reasons recorded", async () => {
  const res = await fullSync("eng", { productsPage: pager(broken, 10), collectionsPage: pager(brokenCols, 2) });
  ok(!res.error, `finished: ${res.error}`);
  const run = await latest("eng");
  eq([run.status, Number(run.products), Number(run.collections), Number(run.skipped_count)], ["complete", 34, 3, 7], "run:");
  eq(await count("eng", "products"), 34, "products in the store:");
  const skipped = JSON.parse(run.skipped);
  eq(skipped.map((s) => s.reason).sort(), ["duplicate_handle", "no_handle", "no_title", "no_title", "unreadable", "unreadable", "wont_save"].sort(), "reasons:");
  eq(skipped.find((s) => s.reason === "wont_save").id, many.products[11].id, "the constraint fallback skipped the row the database refused:");
  const page2 = await raw("eng", "SELECT COUNT(*) AS n FROM products WHERE id IN (" + many.products.slice(10, 20).map(() => "?").join(",") + ")", many.products.slice(10, 20).map((p) => p.id));
  eq(Number(page2[0].n), 8, "the rest of that page committed once (10 less the refused and the garbled one):");
  const sl = logs.filter((l) => l.evt === "sync_skipped" && l.run === run.id);
  eq(sl.reduce((n, l) => n + l.count, 0), 7, "a sync_skipped line per page with skips:");
  const fin = logs.filter((l) => l.evt === "sync_finished" && l.run === run.id);
  eq(fin.map((l) => [l.status, l.products, l.collections, l.skipped, typeof l.ms]), [["complete", 34, 3, 7, "number"]], "one sync_finished line:");
});

await t("the view of that run: Done words, 7 couldn't come in, each with its name, why and what to do", async () => {
  const v = await viewOf("eng");
  eq([v.state, v.skipped.count, v.skipped.items.length, v.skipped.more], ["complete", 7, 7, 0], "skipped:");
  const noTitle = v.skipped.items.find((i) => i.reason === "no_title" && i.type === "product");
  eq(noTitle.name, many.products[3].handle, "no title: named by its web address:");
  eq(Object.keys(noTitle), ["type", "name", "reason", "why", "todo", "kept"], "an item's keys (no id):");
  eq(V.SKIPPED_WORDS(v.skipped), "7 items couldn't come in", "words (a collection among them):");
  eq(V.SKIPPED_WORDS({ count: 3, products: 3 }), "3 products couldn't come in", "only products:");
  ok(!JSON.stringify(v.skipped).includes("gid://"), "no Shopify ids in the view");
});

await t("the constraint fallback runs only on a constraint, with the run still ours: a lost lease is still a lost lease", async () => {
  // a runner whose lease was taken: its page must not be written, fallback or not
  await mk("lost");
  const run = (await inS("lost", () => S.requestCatalogSync({ fetchers: {} }))).run;
  const steal = async () => raw("lost", "UPDATE sync_runs SET lease_owner = 'thief', lease_until = ? WHERE id = ?", [new Date(Date.now() + 600_000).toISOString(), run.id]);
  let stolen = false;
  const productsPage = async (cursor) => {
    const page = await pager(broken, 15)(cursor);
    if (!stolen) {
      stolen = true;
      await steal();
    }
    return page;
  };
  const res = await inS("lost", () => S.runSyncSlice(run.id, { fetchers: { productsPage, collectionsPage: pager([], 5) }, indexer: NO_INDEX, mode: "inline" }));
  eq([res.lost, await count("lost", "products")], [true, 0], "lost, nothing written:");
  eq((await latest("lost")).lease_owner, "thief", "the thief keeps it:");
});

await t("a skipped product already in the store keeps its last good copy through the prune; one gone from Shopify is pruned", async () => {
  const list = F.catalogFor("few").products;
  ok(!(await fullSync("keep", { productsPage: pager(list, 10), collectionsPage: pager([], 5) })).error, "first sync");
  eq(await count("keep", "products"), 4, "four in:");
  const second = [{ ...list[0], title: "" }, list[1], list[2]]; // list[3] gone upstream
  ok(!(await fullSync("keep", { productsPage: pager(second, 10), collectionsPage: pager([], 5) })).error, "second sync");
  const rows = await raw("keep", "SELECT id, title FROM products ORDER BY id");
  eq(rows.map((r) => [r.id, r.title]), list.slice(0, 3).map((p) => [p.id, p.title]), "the skipped one kept its title; the gone one pruned:");
  const v = await viewOf("keep");
  eq([v.skipped.count, v.skipped.items[0].kept], [1, true], "the list says it kept its copy:");
  eq(V.KEPT_WORDS, "Your store keeps its last good copy.", "words:");
});

await t("a store at 0027 (no progress columns) still syncs: skips skip and are only logged", async () => {
  eq(await inS("old", () => S.hasProgressColumns()), false, "no columns:");
  const res = await fullSync("old", { productsPage: pager(broken, 10), collectionsPage: pager(brokenCols, 2), countCollections: async () => ({ count: 4 }) });
  ok(!res.error, `finished: ${res.error}`);
  const run = await latest("old");
  eq([run.status, Number(run.products), "skipped_count" in run], ["complete", 34, false], "run:");
  const v = await viewOf("old");
  eq([v.state, v.skipped.count, v.collections.total], ["complete", 0, null], "view:");
  ok(logs.some((l) => l.evt === "sync_skipped" && l.run === run.id && l.recorded === false), "logged, not recorded");
  // and once 0028 lands the same database records them
  await stores.old.migrateTo("latest");
  eq(await inS("old", () => S.hasProgressColumns()), false, "the answer is cached per database:");
  await inS("old", () => S.resetProgressColumns());
  eq(await inS("old", () => S.hasProgressColumns()), true, "columns after migrating (and a reset):");
});

await t("a node Shopify sends with no usable id (null) holds the product prune for that run: the product it may be is still there, and so is one gone upstream; the next clean run prunes", async () => {
  const list = F.catalogFor("few").products;
  ok(!(await fullSync("blind", { productsPage: pager(list, 10), collectionsPage: pager([], 5) })).error, "first sync");
  const second = [null, list[1], list[2]]; // list[0] came back null, list[3] is gone upstream
  const res = await fullSync("blind", { productsPage: pager(second, 10), collectionsPage: pager([], 5) });
  ok(!res.error, `finished: ${res.error}`);
  const run = await latest("blind");
  eq([run.status, Number(run.no_prune), Number(run.pruned_products), Number(run.skipped_count)], ["complete", 1, 0, 1], "run:");
  eq(await count("blind", "products"), 4, "nothing pruned:");
  ok(logs.some((l) => l.evt === "sync_prune_held" && l.run === run.id && l.products === true), "logged");
  ok(!(await fullSync("blind", { productsPage: pager(list.slice(0, 3), 10), collectionsPage: pager([], 5) })).error, "a clean run");
  eq([await count("blind", "products"), Number((await latest("blind")).no_prune)], [3, 0], "the next clean run prunes:");
});

await t("without 0028 a node with no usable id can't hold the prune, so its page fails as before line 5 (nothing of it written)", async () => {
  const list = F.catalogFor("few").products;
  const res = await fullSync("old2", { productsPage: pager([list[0], null, list[2]], 10), collectionsPage: pager([], 5) });
  eq(res.error, S.BLIND_SKIP, "failed:");
  eq([await count("old2", "products"), (await latest("old2")).status], [0, "failed"], "nothing written:");
});

const refusedPage = () => F.catalogFor("few").products.map((p, i) => (i === 1 ? { ...p, images: { nodes: [{ url: null }] } } : p));

await t("the constraint fallback: a lease stolen between the failed batch and the probe is still a lost lease; nothing of the page is written", async () => {
  const { run } = await inS("probe", () => S.requestCatalogSync({ fetchers: {} }));
  S.__syncTestHooks.beforeProbe = async () => {
    await raw("probe", "UPDATE sync_runs SET lease_owner = 'thief', lease_until = ? WHERE id = ?", [new Date(Date.now() + 600_000).toISOString(), run.id]);
  };
  try {
    const res = await inS("probe", () => S.runSyncSlice(run.id, { fetchers: { productsPage: pager(refusedPage(), 10), collectionsPage: pager([], 5) }, indexer: NO_INDEX, mode: "queued" }).catch((e) => ({ threw: e.message })));
    eq([res.lost, await count("probe", "products"), (await latest("probe")).lease_owner, (await latest("probe")).cursor], [true, 0, "thief", null], "lost, nothing written:");
  } finally {
    S.__syncTestHooks.beforeProbe = null;
  }
});

await t("the constraint fallback checks the slice's deadline in its probe: out of time, it stops; nothing is written, the lease is freed and the next slice retries the page", async () => {
  const { run } = await inS("late", () => S.requestCatalogSync({ fetchers: {} }));
  let late = false;
  S.__syncTestHooks.beforeProbe = async () => {
    late = true;
  };
  const fetchers = { productsPage: pager(refusedPage(), 10), collectionsPage: pager([], 5) };
  try {
    const res = await inS("late", () => S.runSyncSlice(run.id, { fetchers, indexer: NO_INDEX, mode: "queued", deadline: 1e12, now: () => (late ? 1e13 : 0) }));
    const row = await latest("late");
    eq([res.yielded, await count("late", "products"), row.lease_owner, row.cursor, Number(row.pages_done)], [true, 0, null, null, 0], "yielded, nothing written:");
  } finally {
    S.__syncTestHooks.beforeProbe = null;
  }
  const again = await inS("late", () => S.runSyncSlice(run.id, { fetchers, indexer: NO_INDEX, mode: "queued" }));
  eq([again.status, await count("late", "products")], ["complete", 3], "the next slice brings the page in, less the refused one:");
});

await t("collections_total: Shopify's exact count on the first collections page; 'at least' is no total; no counter, no total", async () => {
  const cat = F.catalogFor("many");
  const seen = { n: 0 };
  ok(!(await fullSync("count", { productsPage: pager(cat.products, 20), collectionsPage: pager(cat.collections, 2), countCollections: async () => (seen.n++, { count: 4, atLeast: false }) })).error, "sync");
  eq([Number((await latest("count")).collections_total), seen.n], [4, 1], "total, counted once:");
  ok(!(await fullSync("count", { productsPage: pager(cat.products, 20), collectionsPage: pager(cat.collections, 2), countCollections: async () => ({ count: 4, atLeast: true }) })).error, "sync 2");
  eq((await latest("count")).collections_total, null, "at least:");
  ok(!(await fullSync("count", { productsPage: pager(cat.products, 20), collectionsPage: pager(cat.collections, 2) })).error, "sync 3");
  eq((await latest("count")).collections_total, null, "no counter:");
});

// =========================================================================================
console.log("— 4. faults");

const SECRET_BODY = 'Admin GraphQL HTTP 401: {"errors":"[API] Invalid API key or access token (unrecognized login or wrong password) shpat_imp_canary_9f3"}';
const FAULTS = [
  { name: "401", error: SECRET_BODY, state: "failed", kind: "reconnect", next: ["reconnect", "retry"] },
  { name: "403 scope", error: 'Admin GraphQL HTTP 403: {"errors":"This action requires merchant approval for read_products scope."}', state: "failed", kind: "reconnect", next: ["reconnect", "retry"], words: /permission/ },
  { name: "ACCESS_DENIED", error: 'Admin GraphQL errors: [{"message":"Access denied","extensions":{"code":"ACCESS_DENIED"}}]', state: "failed", kind: "reconnect", next: ["reconnect", "retry"] },
  { name: "402", error: "Admin GraphQL HTTP 402: Payment Required", state: "failed", kind: "shop", next: ["retry"], words: /Check your Shopify plan/ },
  { name: "429", error: "Admin GraphQL HTTP 429: Throttled", state: "retrying", kind: "busy", next: ["retry"], label: "Try now" },
  { name: "503", error: "Admin GraphQL HTTP 503: Service Unavailable (mentions 401 in its body)", state: "retrying", kind: "busy", next: ["retry"] },
  { name: "fetch failed", error: "fetch failed", state: "retrying", kind: "busy", next: ["retry"] },
  { name: "timeout", error: "The operation was aborted due to timeout", state: "retrying", kind: "busy", next: ["retry"] },
  { name: "anything else", error: "something odd", state: "retrying", kind: "unknown", next: ["retry"] },
];

for (const f of FAULTS) {
  await t(`${f.name}: the run is ${f.state}, kind ${f.kind}, next ${f.next.join(" + ")}; it keeps what came in and never shows the raw text`, async () => {
    await raw("fault", "DELETE FROM sync_runs");
    const cat = F.catalogFor("many").products;
    let calls = 0;
    const productsPage = async (cursor) => {
      if (calls++ === 1) throw new Error(f.error);
      return pager(cat, 10)(cursor);
    };
    const { run } = await inS("fault", () => S.requestCatalogSync({ fetchers: {} }));
    const res = await inS("fault", () => S.runSyncSlice(run.id, { fetchers: { productsPage, collectionsPage: pager([], 5) }, indexer: NO_INDEX, mode: "queued" }).catch((e) => ({ threw: e.message })));
    eq(Boolean(res.threw), f.state === "retrying", "a retryable error goes back to the queue:");
    const v = await viewOf("fault");
    eq([v.state, v.problem?.kind, v.problem?.next.map((n) => n.id)], [f.state, f.kind, f.next], "view:");
    if (f.label) eq(v.problem.next[0].label, f.label, "label:");
    if (f.words) ok(f.words.test(v.problem.words), v.problem.words);
    if (f.kind === "reconnect") eq(v.problem.next[0].label, "Reconnect Shopify", "reconnect label:");
    if (f.state === "failed") ok(v.detail.includes(V.SYNC_WORDS.kept), `kept words: ${v.detail}`);
    if (f.state === "retrying") ok(/try again by itself/.test(v.problem.words), v.problem.words);
    eq(v.products.done, 10, "the first page stays:");
    const text = JSON.stringify(v);
    for (const bit of [f.error.slice(0, 30), "shpat_", "Admin GraphQL", "HTTP"]) ok(!text.includes(bit), `raw text in the view: ${bit}`);
    eq(scanText(v.problem.words), [], "banned copy:");
  });
}

await t("busy, given up (failed 503): 'Try again in a few minutes' + Try again; a failed run's view always says the store keeps what came in", async () => {
  await raw("fault", "DELETE FROM sync_runs");
  const now = new Date().toISOString();
  await raw("fault", "INSERT INTO sync_runs (id, kind, status, phase, started_at, updated_at, finished_at, products_fetched, error) VALUES ('sync_busy', 'full', 'failed', 'products', ?, ?, ?, 30, 'Admin GraphQL HTTP 503: x')", [now, now, now]);
  const v = await viewOf("fault");
  eq([v.problem.kind, v.problem.words, v.problem.next], ["busy", "Shopify is busy right now. Try again in a few minutes.", [{ id: "retry", label: "Try again" }]], "busy failed:");
  ok(v.detail.includes(V.SYNC_WORDS.kept), v.detail);
  eq(V.syncProblem({ error: "Admin GraphQL HTTP 500: x" }, "failed").kind, "busy", "a 500:");
  eq(V.syncProblem({ error: "No Shopify credentials for this tenant" }, "failed").words, "Storeasy isn't linked to your Shopify store. Reconnect Shopify, then try again.", "no link:");
  eq(V.syncProblem({ error: "Admin GraphQL HTTP 404: Not Found" }, "failed").kind, "reconnect", "404:");
  eq(V.syncProblem({ error: "Admin GraphQL HTTP 423: Locked" }, "failed").kind, "shop", "423:");
  eq(V.syncProblem({ error: "x" }, "failed").words, "Something went wrong while bringing in your products. Try again. If it keeps happening, contact support.", "unknown failed:");
  eq([V.syncProblem({}, "running"), V.syncProblem({}, "complete"), V.syncProblem(null, "failed")], [null, null, null], "no problem:");
});

await t("stalled: kind stopped, 'Try again picks up where it left off'", async () => {
  await raw("fault", "DELETE FROM sync_runs");
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  await raw("fault", "INSERT INTO sync_runs (id, kind, status, phase, started_at, updated_at, products_fetched) VALUES ('sync_stall', 'full', 'running', 'products', ?, ?, 30)", [old, old]);
  const v = await viewOf("fault");
  eq([v.state, v.problem.kind, v.problem.next.map((n) => n.id)], ["stalled", "stopped", ["retry"]], "view:");
  ok(/Try again picks up where it left off/.test(v.problem.words), v.problem.words);
});

await t("retrying with a known next try: retryAt is on the view (the step shows 'Next try at about …')", async () => {
  const run = { id: "r", status: "running", phase: "products", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: "Admin GraphQL HTTP 429: x", products_fetched: 30 };
  const at = new Date(Date.now() + 120_000).toISOString();
  const v = V.syncView(run, { retryAt: at });
  eq([v.state, v.retryAt, v.problem.next[0].label], ["retrying", at, "Try now"], "retrying:");
});

await t("Try again resumes from the cursor: a failed run picks up at the page it stopped on and finishes", async () => {
  const cat = F.catalogFor("many").products;
  const { run } = await inS("resume", () => S.requestCatalogSync({ fetchers: {} }));
  let calls = 0;
  const failing = async (cursor) => {
    if (calls++ === 2) throw new Error("Admin GraphQL HTTP 401: nope");
    return pager(cat, 10)(cursor);
  };
  await inS("resume", () => S.runSyncSlice(run.id, { fetchers: { productsPage: failing, collectionsPage: pager([], 5) }, indexer: NO_INDEX, mode: "queued" }));
  const failed = await latest("resume");
  eq([failed.status, failed.cursor, Number(failed.products_fetched)], ["failed", "20", 20], "failed after two pages:");
  const again = await inS("resume", () => S.requestCatalogSync({ retry: true, fetchers: {} }));
  eq(again.action, "resumed", "resumed:");
  const seen = [];
  const res = await inS("resume", () => S.runSyncSlice(run.id, { fetchers: { productsPage: pager(cat, 10, seen), collectionsPage: pager([], 5) }, indexer: NO_INDEX, mode: "queued" }));
  eq([res.status, seen[0], Number(res.run.products)], ["complete", "20", 40], "picked up at page 3, all in:");
});

// =========================================================================================
console.log("— 5. the view");

const at = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const live = (over = {}) => ({ id: "s", status: "running", phase: "products", products_fetched: 120, products_total: 480, collections_fetched: 0, pages_done: 4, started_at: at(5), updated_at: at(0), lease_owner: "x", lease_until: new Date(Date.now() + 60_000).toISOString(), error: null, ...over });

await t("stages: four, in order, in the founder's words; members reads as collections; none and complete have none", async () => {
  eq(V.SYNC_STAGES.map((s) => s.label), ["Bringing in products", "Bringing in collections", "Tidying up", "Getting search ready"], "labels:");
  for (const [phase, label, index] of [["products", "Bringing in products", 1], ["collections", "Bringing in collections", 2], ["members", "Bringing in collections", 2], ["prune", "Tidying up", 3], ["index", "Getting search ready", 4]]) {
    eq(V.syncView(live({ phase })).stage, { id: V.SYNC_STAGES[index - 1].id, label, index, of: 4 }, phase);
  }
  eq([V.syncView(null).stage, V.syncView({ status: "complete", products: 3, collections: 1, finished_at: at(1) }).stage], [null, null], "none, complete:");
});

await t("time left: only while products come in, with an exact total, a minute and two pages in, never while retrying; rounded", async () => {
  eq(V.syncView(live()).eta, { ms: 900_000, words: "About 15 minutes left" }, "120 of 480 in 5 minutes:");
  eq(V.syncView(live({ started_at: at(0.5) })).eta, null, "under a minute:");
  eq(V.syncView(live({ pages_done: 1 })).eta, null, "one page:");
  eq(V.syncView(live({ error: "Admin GraphQL HTTP 429: x" })).eta, null, "retrying:");
  eq(V.syncView(live({ products_total: null })).eta, null, "no total:");
  eq(V.syncView(live({ phase: "collections" })).eta, null, "collections:");
  eq(V.syncView(live({ products_fetched: 480 })).eta, null, "all in:");
  eq([1.5, 7, 12, 70, 125].map((m) => V.etaWords(m * 60_000)), ["About a minute or two left", "About 7 minutes left", "About 10 minutes left", "About an hour left", "About 2 hours left"], "rounding:");
});

await t("big catalogs: above 1,000 products while they come in; never once finished", async () => {
  eq([V.syncView(live({ products_total: 1500 })).big, V.syncView(live({ products_total: 1000 })).big, V.syncView(live({ products_total: null, products_fetched: 1200 })).big], [true, false, true], "running:");
  eq(V.syncView({ status: "complete", products: 5000, collections: 1, finished_at: at(1) }).big, false, "complete:");
  eq(V.SYNC_WORDS.big, "Big catalogs take a while. You can close this page, it keeps going.", "words:");
});

await t("times: elapsed while active, duration once finished; duration words", async () => {
  const v = V.syncView(live());
  ok(Math.abs(v.elapsedMs - 300_000) < 2_000 && v.durationMs === null, `elapsed ${v.elapsedMs}`);
  const done = V.syncView({ status: "complete", products: 3, collections: 1, started_at: at(11), finished_at: at(5) });
  eq([done.elapsedMs, Math.round(done.durationMs / 60_000)], [null, 6], "complete:");
  eq([V.durationWords(20_000), V.durationWords(60_000), V.durationWords(6 * 60_000), V.durationWords(65 * 60_000), V.durationWords(150 * 60_000)], ["less than a minute", "1 minute", "6 minutes", "about an hour", "about 3 hours"], "words:");
});

await t("progress counts skips as read: done + skipped of total, so the bar can reach 100%; the time left is unchanged", async () => {
  const v = V.syncView(live({ products_fetched: 117, skipped_count: 3 }));
  eq([v.products.done, v.products.skipped, v.eta.words], [117, 3, V.syncView(live({ products_fetched: 117 })).eta.words], "products:");
  const c = V.syncView(live({ phase: "collections", collections_fetched: 5, collections_total: 6, skipped_count: 2, skipped: JSON.stringify([{ type: "product", id: "a" }, { type: "collection", id: "b" }]) }));
  eq([c.products.skipped, c.collections.skipped], [1, 1], "split by type later:");
});

await t("the skipped list shows at most 20 and counts the rest", async () => {
  const list = Array.from({ length: 50 }, (_, i) => Vet.skipOf("product", P(i + 1, { title: `T${i}` }), "no_title"));
  const v = V.syncView({ status: "complete", products: 3, collections: 0, finished_at: at(1), skipped_count: 73, skipped: JSON.stringify(list) });
  eq([v.skipped.count, v.skipped.items.length, v.skipped.more, v.skipped.items[0].name], [73, 20, 53, "T0"], "skipped:");
  eq(V.syncView({ status: "complete", products: 3, collections: 0, finished_at: at(1), skipped_count: 2, skipped: "garbled" }).skipped.items, [], "an unreadable list shows none, still counted");
});

await t("the view keeps every field the dashboard, Settings and SyncProgress read", async () => {
  const keys = Object.keys(V.syncView(live()));
  for (const k of ["state", "firstSync", "linked", "runId", "phase", "products", "collections", "startedAt", "finishedAt", "retryAt", "message", "canRetry", "canStart", "headline", "detail"]) ok(keys.includes(k), k);
});

await t("every word in the view module is plain founder copy", async () => {
  const words = [JSON.stringify(V.SYNC_WORDS), JSON.stringify(V.SKIP_REASONS), V.KEPT_WORDS, ...V.SYNC_STAGES.map((s) => s.label), ...["failed", "retrying", "stalled"].flatMap((st) => ["x", "Admin GraphQL HTTP 401: x", "Admin GraphQL HTTP 429: x", "Admin GraphQL HTTP 402: x", "scope", "No Shopify credentials"].map((e) => V.syncProblem({ error: e }, st).words))].join(" ");
  eq(scanText(words), [], "banned copy:");
  ok(!/sync_runs|cursor|lease|tenant|GraphQL/i.test(words), "no internal names");
});

// =========================================================================================
console.log("— 6. /api/admin/sync with real sessions");

const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const route = await import("../app/api/admin/sync/route.js");
const mkUser = async (email, role, store = "improute") => {
  const u = await I.createUser({ email, name: role, password: `${role}-imp-pass-1` });
  await I.addMembership(u.id, store, role);
  return { u, tok: (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token };
};
const users = {};
for (const role of ["owner", "staff", "support"]) users[role] = await mkUser(`${role}@imp.test`, role);
users.otherOwner = await mkUser("other-owner@imp.test", "owner", "impother");
const HOST = "improute.test";
const req = (method, { tok, body, origin, host = HOST } = {}) => ({
  method,
  cookies: { get: (n) => (n === "_admin" && tok ? { name: n, value: tok } : undefined) },
  headers: { get: (k) => ({ host, ...(origin ? { origin } : {}) })[k.toLowerCase()] ?? null },
  url: `https://${host}/api/admin/sync`,
  nextUrl: new URL(`https://${host}/api/admin/sync`),
  json: async () => body,
});
const call = async (method, o) => {
  const res = await route[method](req(method, o), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
};
const VIEW_KEYS = Object.keys(V.syncView(live())).sort();
const jobs = async () => Number((await C.platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM jobs WHERE type = 'catalog_sync'", args: [] })).rows[0].n);

for (const [label, status] of [["a retrying run (the nudge branch)", "running"], ["a failed run", "failed"]]) {
  await t(`least-trusted: support's GET on ${label}: 200, exactly { ok, sync } with the view's keys, no raw error or token, no shop domain or Shopify URL, no job queued, the run unchanged`, async () => {
    await raw("route", "DELETE FROM sync_runs");
    const now = new Date().toISOString();
    await raw("route", "INSERT INTO sync_runs (id, kind, status, phase, started_at, updated_at, finished_at, products_fetched, products_total, error, skipped_count, skipped) VALUES ('sync_route', 'full', ?, 'products', ?, ?, ?, 30, 90, ?, 1, ?)", [status, now, now, status === "failed" ? now : null, SECRET_BODY, JSON.stringify([{ type: "product", id: "gid://shopify/Product/77", handle: "secret-handle", title: "A product", reason: "no_title" }])]);
    const before = [await jobs(), JSON.stringify(await latest("route"))];
    const r = await call("GET", { tok: users.support.tok });
    eq([r.status, Object.keys(r.body)], [200, ["ok", "sync"]], "answer:");
    eq(Object.keys(r.body.sync).sort(), VIEW_KEYS, "the view contract:");
    eq(r.body.sync.state, status === "failed" ? "failed" : "retrying", "state:");
    const text = JSON.stringify(r.body);
    for (const c of ["shpat_", "Invalid API key", "Admin GraphQL", "improute.myshopify.com", "myshopify", "https://", "imp-client-secret-canary", "imp-client-id-canary", "gid://shopify"]) ok(!text.includes(c), `support: ${c} leaked`);
    eq([await jobs(), JSON.stringify(await latest("route"))], before, "no job queued, the run unchanged:");
  });
}

await t("positive control: the owner's GET on a retrying run queues its job (the nudge); staff's GET doesn't", async () => {
  await raw("route", "DELETE FROM sync_runs");
  const now = new Date().toISOString();
  await raw("route", "INSERT INTO sync_runs (id, kind, status, phase, started_at, updated_at, products_fetched, error) VALUES ('sync_nudge', 'full', 'running', 'products', ?, ?, 30, 'Admin GraphQL HTTP 503: x')", [now, now]);
  const before = await jobs();
  eq((await call("GET", { tok: users.staff.tok })).status, 200, "staff:");
  eq(await jobs(), before, "staff queues nothing:");
  eq((await call("GET", { tok: users.owner.tok })).status, 200, "owner:");
  eq(await jobs(), before + 1, "the owner's GET queued the run's job:");
  globalThis.__afterQueue = [];
});

await t("GET signed out 401; another store's owner 401", async () => {
  eq((await call("GET", {})).status, 401, "signed out:");
  eq((await call("GET", { tok: users.otherOwner.tok })).status, 401, "another store:");
});

await t("POST refusals change nothing: support 403, staff 403, signed out 401, another store's owner 401, cross-origin 403", async () => {
  const before = [await jobs(), JSON.stringify(await latest("route"))];
  eq((await call("POST", { tok: users.support.tok, body: {} })).status, 403, "support:");
  eq((await call("POST", { tok: users.staff.tok, body: { retry: true } })).status, 403, "staff:");
  eq((await call("POST", { body: {} })).status, 401, "signed out:");
  eq((await call("POST", { tok: users.otherOwner.tok, body: {} })).status, 401, "another store:");
  eq((await call("POST", { tok: users.owner.tok, body: {}, origin: "https://evil.test" })).status, 403, "cross-origin:");
  eq([await jobs(), JSON.stringify(await latest("route"))], before, "nothing changed:");
});

// =========================================================================================
console.log("— 7. ImportStepBody (WP-B)");

const ui = await import("./support/import-step-render.js").catch((e) => ({ missing: e }));
if (ui.missing) {
  await t("components/admin/onboarding/ImportStep.js renders", async () => {
    throw ui.missing;
  });
} else {
  await ui.run({ t, ok, eq, V, live, at, scanText });
}

console.log = realLog;
await plat.cleanup();
for (const s of Object.values(stores)) await s.cleanup();
await F.removeFixtureFiles("imp");
console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
