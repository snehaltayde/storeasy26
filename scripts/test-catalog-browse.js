// The Catalog page (Phase 2 line 3, docs/plans/phase-2.md "Line 3"): browse
// products and collections, open a product's content in the editor.
//   pnpm test:catalog-browse
// 1. Reads, per role (store A: 55 products, two collections; store B: its own
//    product and collection): GET /api/admin/catalog?view=… for owner, admin,
//    staff and support is 200 with no write flags; signed out is 401; store
//    B's product or collection id asked of store A is 404.
// 2. lib/admin/catalog-browse.js: 50 a page by cursor, search, the content
//    and stock filters with counts, the content state, the sheet's facts, a
//    collection's products in position order.
// 3. The page under scripts/support/page-harness.js: support gets no
//    sync control; no role gets a quiz tray (quizzes are /admin/quizzes since
//    Phase 2 line 10); ?product= and
//    ?collection= still redirect to the editor.
// 4. Rendered (Next's SWC, react-dom/server): the sync button is RoleGate's for
//    staff and support and live for an owner; support's sheet says "View
//    content", an owner's "Edit content"; every read control is marked.
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-catb-default.db";
process.env.PLATFORM_SECRET = "catalog-browse-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
const network = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 8).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

// --- the fixture ------------------------------------------------------------------
const B_PRODUCT = "gid://shopify/Product/77001";
const B_COLLECTION = "gid://shopify/Collection/77001";
const SOLD_OUT = [3, 7]; // fixture product numbers that are sold out
const A_PRODUCTS = Array.from({ length: 55 }, (_, i) => {
  const n = i + 1;
  const over = { title: `Fixture product ${String(n).padStart(2, "0")}` };
  if (n === 9) over.title = "Moonlight Whey";
  if (SOLD_OUT.includes(n)) Object.assign(over, { availableForSale: false, totalInventory: 0 });
  return over;
});
const store = await H.makeRoleStore({
  name: "catb",
  a: { products: A_PRODUCTS, collections: 0, sync: "complete" },
  b: { products: [{ id: B_PRODUCT, title: "cnybproduct0", handle: "cnyb-h" }], collections: [{ handle: "cnyb-coll", title: "cnybcollection0" }] },
});
const { call, a, b, cookies } = store;
const P = (n) => `gid://shopify/Product/${9100 + n}`;

// store B's collection gets an id store A doesn't have; store A gets two
// collections whose member order is not their id order
const { writeCollection } = await import("../lib/sync.js");
const { fixtureCollection } = await import("./support/tenant-fixture.js");
const { db } = await import("../lib/db.js");
await b.run(async () => {
  await db.deleteFrom("collection_products").execute();
  await db.deleteFrom("collections").execute();
  await writeCollection(fixtureCollection(1, { id: B_COLLECTION, handle: "cnyb-coll", title: "cnybcollection0", productIds: [B_PRODUCT] }));
});
const BIG = Array.from({ length: 52 }, (_, i) => P(52 - i)); // 52 members, reversed
await a.run(async () => {
  await writeCollection(fixtureCollection(1, { title: "Best sellers", productIds: [P(5), P(2), P(9)] }));
  await writeCollection(fixtureCollection(2, { title: "Everything", productIds: BIG }));
});
const C1 = "gid://shopify/Collection/9201";
const C2 = "gid://shopify/Collection/9202";

// content: product 1 is published (a live row, the draft is what's published),
// product 2 has draft changes (edits never published), product 4 is published
// with newer draft changes; an orphan document for a product Shopify dropped
const NOW = new Date().toISOString();
const draftWith = (title) => JSON.stringify({ settings: { title: { value: title } }, sections: [] });
await a.run(async () => {
  const doc = (id, entity, draft, hash, published) =>
    db.insertInto("documents").values({ id, type: "product_content", entity_id: entity, label: `Label ${id}`, draft, draft_hash: hash, revision: 1, schema_version: 1, published_version_id: published ? `ver_${id}` : null, published_hash: published, created_at: NOW, updated_at: NOW }).execute();
  await doc("doc_catb_one", P(1), draftWith("Founder's one"), "h1", "h1");
  await doc("doc_catb_two", P(2), draftWith("Founder's two"), "h2", null);
  await doc("doc_catb_four", P(4), draftWith("Founder's four v2"), "h4b", "h4a");
  await doc("doc_catb_gone", "gid://shopify/Product/55555", draftWith("Gone product"), "hg", null);
  const live = (pid, docId, title) => db.insertInto("product_content_live").values({ product_id: pid, document_id: docId, version_id: `ver_${docId}`, title, published_at: NOW }).execute();
  await live(P(1), "doc_catb_one", "Founder's one");
  await live(P(4), "doc_catb_four", "Founder's four");
});

const Br = await import("../lib/admin/catalog-browse.js");
const ROLES = ["owner", "admin", "staff", "support"];
const WRITE_FLAG = /"(can[A-Z]\w*|editable|writable|canSync|canEdit|canPublish|actions)"\s*:/;

// --- 1. reads per role (written before the page) ------------------------------------
await t("signed out: every browse view is 401", async () => {
  for (const q of ["view=products", `view=product&id=${encodeURIComponent(P(1))}`, "view=collections", `view=collection&id=${encodeURIComponent(C1)}`]) {
    const r = await call("signed-out", "catalog", "GET", { query: q });
    eq(r.status, 401, `${q}:`);
    ok(!/Fixture product|Best sellers/.test(r.text), `${q}: no catalog in a 401`);
  }
});

await t("support (least trusted), staff, admin and owner: GET ?view=products is 200 with the page and no write flags", async () => {
  for (const role of ROLES) {
    const r = await call(role, "catalog", "GET", { query: "view=products" });
    eq(r.status, 200, `${role}:`);
    eq(Object.keys(r.body).sort(), ["counts", "items", "nextCursor", "ok", "total"], `${role} keys:`);
    eq(r.body.items.length, 50, `${role} page size:`);
    ok(!WRITE_FLAG.test(r.text), `${role}: no write flag in ${r.text.match(WRITE_FLAG)?.[0]}`);
    ok(!r.text.includes("cnyb"), `${role}: nothing of store B`);
  }
});

await t("support: the product sheet, the collections and a collection's products are 200, read-only, store A's only", async () => {
  const views = [`view=product&id=${encodeURIComponent(P(1))}`, "view=collections", `view=collection&id=${encodeURIComponent(C1)}`];
  for (const role of ROLES) {
    for (const q of views) {
      const r = await call(role, "catalog", "GET", { query: q });
      eq(r.status, 200, `${role} ${q}:`);
      ok(!WRITE_FLAG.test(r.text), `${role} ${q}: no write flag`);
      ok(!r.text.includes("cnyb"), `${role} ${q}: nothing of store B`);
    }
  }
  const cols = await call("support", "catalog", "GET", { query: "view=collections" });
  eq(cols.body.items.map((c) => c.title), ["Best sellers", "Everything"], "store A's collections only:");
});

await t("another store's ids: ?view=collection&id=<store B's gid> and ?view=product&id=<store B's gid> are 404 for every role, and so is junk", async () => {
  for (const role of ROLES) {
    const c = await call(role, "catalog", "GET", { query: `view=collection&id=${encodeURIComponent(B_COLLECTION)}` });
    eq(c.status, 404, `${role} store B's collection:`);
    ok(!c.text.includes("cnyb"), "the 404 names nothing of store B");
    const p = await call(role, "catalog", "GET", { query: `view=product&id=${encodeURIComponent(B_PRODUCT)}` });
    eq(p.status, 404, `${role} store B's product:`);
  }
  for (const q of ["view=product&id=nope", "view=collection&id=gid%3A%2F%2Fshopify%2FCollection%2F1%3Fx", "view=product"]) eq((await call("support", "catalog", "GET", { query: q })).status, 404, `${q}:`);
  // store B's own owner sees it in store B
  const own = await call("owner-b", "catalog", "GET", { query: `view=collection&id=${encodeURIComponent(B_COLLECTION)}`, host: b.tenant.domains[0] });
  eq([own.status, own.body?.collection?.title], [200, "cnybcollection0"], "store B's owner, on store B:");
});

await t("bad input is 400 in plain words: filter, stock, cursor, view", async () => {
  for (const q of ["view=products&filter=nope", "view=products&stock=maybe", "view=products&cursor=%25%25", `view=collection&id=${encodeURIComponent(C1)}&cursor=%25%25`, "view=everything"]) {
    const r = await call("support", "catalog", "GET", { query: q });
    eq(r.status, 400, `${q}:`);
    ok(typeof r.body?.error === "string" && !/TypeError|at /.test(r.body.error), `${q}: ${r.body?.error}`);
  }
});

await t("with no view, the answer is the old one (keys unchanged)", async () => {
  const r = await call("support", "catalog", "GET");
  eq(r.status, 200, "status:");
  eq(Object.keys(r.body).sort(), ["collections", "ok", "overrides", "products", "shopify_admin"], "keys:");
});

// --- 2. the browse module ------------------------------------------------------------
await t("browseProducts: 50 a page by cursor, ordered by the published name; total and counts; the next page holds the rest", async () => {
  const one = await a.run(() => Br.browseProducts({}));
  eq([one.items.length, one.total, typeof one.nextCursor], [50, 55, "string"], "page 1:");
  eq(one.counts, { all: 55, edited: 3, changedInShopify: 0, orphaned: 1 }, "counts (the whole store):");
  const two = await a.run(() => Br.browseProducts({ cursor: one.nextCursor }));
  eq([two.items.length, two.nextCursor], [5, null], "page 2:");
  const ids = new Set([...one.items, ...two.items].map((i) => i.productId));
  eq(ids.size, 55, "every product once:");
  const names = one.items.map((i) => i.title);
  eq(names.slice(0, 3), ["Fixture product 02", "Fixture product 03", "Fixture product 05"], "by the published name (products 1 and 4 read as the founder's; 2 has only a draft):");
});

await t("browseProducts: the columns' facts (type, price range, stock) and the content state", async () => {
  const all = [...(await a.run(() => Br.browseProducts({}))).items, ...(await a.run(async () => Br.browseProducts({ cursor: (await Br.browseProducts({})).nextCursor }))).items];
  const by = Object.fromEntries(all.map((i) => [i.productId, i]));
  eq([by[P(1)].content, by[P(2)].content, by[P(4)].content, by[P(5)].content], ["published", "draft", "draft", "shopify_only"], "content:");
  eq([by[P(1)].title, by[P(1)].shopifyTitle], ["Founder's one", "Fixture product 01"], "the published name, Shopify's under it:");
  eq([by[P(6)].productType, by[P(6)].priceMin, by[P(6)].priceMax, by[P(6)].currency, by[P(6)].available], ["Fixture", 600, 600, "INR", true], "Shopify's facts:");
  eq([by[P(3)].available, by[P(3)].totalInventory], [false, 0], "a sold-out product:");
});

await t("browseProducts: search matches the published name, Shopify's name and the handle", async () => {
  const titles = async (q) => (await a.run(() => Br.browseProducts({ q }))).items.map((i) => i.productId);
  eq(await titles("moonlight"), [P(9)], "Shopify's name:");
  eq(await titles("founder's one"), [P(1)], "the published name:");
  eq(await titles("founder's two"), [], "never a draft's name:");
  eq(await titles("fixture-product-44"), [P(44)], "the handle:");
  const none = await a.run(() => Br.browseProducts({ q: "zzz-nothing" }));
  eq([none.items.length, none.total, none.counts.all], [0, 0, 55], "no match keeps the store's counts:");
});

await t("browseProducts: Edited, Changed in Shopify, No longer in Shopify, and the stock filter", async () => {
  const run = (o) => a.run(() => Br.browseProducts(o));
  eq((await run({ filter: "edited" })).items.map((i) => i.productId).sort(), [P(1), P(2), P(4)].sort(), "edited:");
  eq((await run({ filter: "changed_in_shopify" })).items.length, 0, "changed in Shopify (no base moved):");
  const gone = await run({ filter: "orphaned" });
  eq([gone.items.length, gone.items[0].content, gone.items[0].inShopify, gone.total], [1, "gone", false, 1], "no longer in Shopify:");
  const sold = await run({ available: false });
  eq([sold.items.map((i) => i.productId).sort(), sold.total], [[P(3), P(7)].sort(), 2], "sold out:");
  const inStock = await run({ available: true });
  eq(inStock.total, 53, "in stock:");
  eq((await run({ filter: "orphaned", available: true })).items.length, 0, "orphans have no stock:");
  eq((await run({ filter: "edited", available: true, q: "founder" })).total, 2, "filters combine (the published names of 1 and 4):");
});

await t("the editor's list is unchanged: no total, LIST_FILTERS has no 'edited', the documents API refuses it", async () => {
  const L = await import("../lib/admin/product-content-list.js");
  const r = await a.run(() => L.listProductContent({}));
  eq(Object.keys(r).sort(), ["counts", "items", "nextCursor"], "keys:");
  eq([...L.LIST_FILTERS], ["all", "changed_in_shopify", "orphaned"], "LIST_FILTERS:");
  for (const role of ["owner", "support"]) {
    const bad = await call(role, "documents", "PUT", { body: { listProductContent: { filter: "edited" } } });
    eq(bad.status, 400, `${role}: the documents API refuses filter "edited":`);
    const fine = await call(role, "documents", "PUT", { body: { listProductContent: { filter: "orphaned" } } });
    eq(fine.status, 200, `${role}: and still takes its own filters:`);
  }
});

await t("productDetail: Shopify's facts (variants with SKU, price, stock; collections; vendor), the content state and the editor link", async () => {
  const d = await a.run(() => Br.productDetail(P(9)));
  eq([d.product.title, d.product.vendor, d.product.productType, d.product.content], ["Moonlight Whey", "Fixture Labs", "Fixture", "shopify_only"], "product:");
  eq(d.variants.map((v) => [v.sku, v.price, v.currency, v.available]), [["FX-9", 900, "INR", true]], "variants:");
  eq(d.collections.map((c) => c.title), ["Best sellers", "Everything"], "collections:");
  eq(d.product.editorHref, `/admin/editor?product=${encodeURIComponent(P(9))}`, "the editor link (entityEditorHref):");
  eq(d.product.storeUrl, "/products/fixture-product-9", "view on store:");
  ok(d.published.state === "ok" || d.published.state === "unavailable", `published: ${JSON.stringify(d.published)}`);
  const one = await a.run(() => Br.productDetail(P(1)));
  eq([one.product.title, one.product.shopifyTitle, one.product.content], ["Founder's one", "Fixture product 01", "published"], "an edited product:");
  eq(await a.run(() => Br.productDetail(B_PRODUCT)), null, "store B's product in store A:");
});

await t("collections: product and pinned counts; a collection's products in position order, 50 a page", async () => {
  const list = await a.run(() => Br.listCollections());
  eq(list.items.map((c) => [c.title, c.products]), [["Best sellers", 3], ["Everything", 52]], "counts:");
  ok(list.items.every((c) => c.pinned === 0 || c.pinned === null), "pinned counts (none pinned):");
  // a membership row whose product left the catalog counts nowhere
  await a.run(() => db.insertInto("collection_products").values({ collection_id: C1, product_id: "gid://shopify/Product/55555", position: 9 }).execute());
  eq((await a.run(() => Br.listCollections())).items.find((c) => c.id === C1).products, 3, "a stale membership is not counted:");
  const best = await a.run(() => Br.collectionProducts(C1));
  eq([best.total, best.nextCursor], [3, null], "so nothing more to load:");
  eq(best.items.map((i) => i.productId), [P(5), P(2), P(9)], "Shopify's order, not the id order:");
  eq(best.collection.editorHref, `/admin/editor?collection=${encodeURIComponent(C1)}`, "Edit collection content (entityEditorHref):");
  const p1 = await a.run(() => Br.collectionProducts(C2));
  eq([p1.items.length, p1.total, p1.items[0].productId, typeof p1.nextCursor], [50, 52, P(52), "string"], "page 1:");
  const p2 = await a.run(() => Br.collectionProducts(C2, p1.nextCursor));
  eq([p2.items.map((i) => i.productId), p2.nextCursor], [[P(2), P(1)], null], "page 2:");
});

await t("the header: last synced and the product count", async () => {
  const h = await a.run(() => Br.catalogHeader({ products: 55 }));
  eq(h.products, 55, "count:");
  ok(typeof h.lastSyncedAt === "string" && h.lastSynced === "just now", `last synced: ${JSON.stringify(h)}`);
});

// --- 3. the page as each role -------------------------------------------------------------
const C = await import("../lib/platform/control.js");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const PAGE = "app/(console)/admin/(authed)/catalog/page.js";
const runs = {};
for (const role of ROLES) runs[role] = await pages.run(PAGE, { cookies: cookies[role] });
const propsOf = (run, name) => run.props.filter((p) => p.component.endsWith(`#${name}`)).map((p) => p.props);

await t("the page runs for every role with no unresolved import", () => {
  for (const role of ROLES) {
    ok(!runs[role].error, `${role}: ${runs[role].error?.message}`);
    eq(runs[role].unresolved, [], `${role} unresolved:`);
    ok(!runs[role].redirect, `${role} redirect ${runs[role].redirect}`);
  }
});

await t("support: no sync control", () => {
  const s = runs.support;
  const sync = propsOf(s, "SyncHeader");
  eq(sync.length, 1, "one header:");
  eq(sync[0].canSync, false, "support may not sync:");
  ok(!s.text.includes("cnyb"), "nothing of store B in support's props");
  ok(!s.text.includes("/admin/editor?list=products"), "no link into the editor's list for support (support opens content from the sheet)");
  ok(runs.owner.text.includes("/admin/editor?list=products"), "the owner's card opens the editor's Products list");
});

await t("no role gets a quiz tray or QuizPanel (Phase 2 line 10 moved quizzes to /admin/quizzes); sync for owner and admin only", () => {
  for (const role of ROLES) eq([propsOf(runs[role], "QuizPanel").length, propsOf(runs[role], "QuizTray").length], [0, 0], `${role}:`);
  ok(!/QuizPanel|QuizTray|CommercePanels|listQuizzes/.test(readFileSync(join(ROOT, "app/(console)/admin/(authed)/catalog/page.js"), "utf8")), "the page imports no quiz part:");
  eq(ROLES.map((r) => propsOf(runs[r], "SyncHeader")[0].canSync), [true, true, false, false], "canSync:");
});

await t("the page hands the table its first page, counts and the store currency; the header its facts", () => {
  const tabs = propsOf(runs.support, "CatalogTabs")[0];
  ok(tabs, "CatalogTabs rendered");
  eq([tabs.initial.items.length, tabs.initial.total, tabs.initial.counts.all], [50, 55, 55], "first page:");
  eq(tabs.currency, "INR", "currency:");
  eq(tabs.role, "support", "role:");
  const head = propsOf(runs.support, "SyncHeader")[0];
  eq(head.products, 55, "header count:");
});

await t("?product= and ?collection= still redirect to the editor; junk stays on the page", async () => {
  const p = await pages.run(PAGE, { cookies: cookies.support, searchParams: { product: P(1) } });
  eq(p.redirect, `/admin/editor?product=${encodeURIComponent(P(1))}`, "product:");
  const c = await pages.run(PAGE, { cookies: cookies.support, searchParams: { collection: C1 } });
  eq(c.redirect, `/admin/editor?collection=${encodeURIComponent(C1)}`, "collection:");
  const j = await pages.run(PAGE, { cookies: cookies.support, searchParams: { product: "junk" } });
  ok(!j.redirect, `junk: ${j.redirect}`);
  const anon = await pages.run(PAGE, { cookies: {} });
  eq(anon.redirect, "/admin/login", "signed out:");
});

await t("an empty catalog: the page hands the table an empty first page (the table says Connect Shopify in onboarding)", async () => {
  await a.run(() => db.deleteFrom("products").execute());
  const run = await pages.run(PAGE, { cookies: cookies.support });
  const tabs = propsOf(run, "CatalogTabs")[0];
  eq([tabs.initial.items.length, tabs.initial.counts.all], [0, 0], "empty:");
});

// --- 4. rendered ---------------------------------------------------------------------------
// Next's SWC compiles components/{admin/catalog,kit,ui} (CommonJS out); lib/
// is imported as itself; next/link, next/navigation and the console toast are stand-ins.
const swc = require("next/dist/build/swc/index.js");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const h = React.createElement;
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...p }) => h("a", { href, ...p }, children) },
  "next/navigation": { useRouter: () => ({ refresh() {}, push() {}, replace() {} }) },
  "@/components/console/Toast": { useToast: () => ({ success() {}, error() {}, info() {} }) },
};
let swcReady = null;
const loaded = new Map();
const resolveLocal = (rel) => [`${rel}.js`, rel].find((c) => {
  try {
    readFileSync(join(ROOT, c));
    return true;
  } catch {
    return false;
  }
});
async function load(rel) {
  await (swcReady ??= swc.loadBindings());
  const file = join(ROOT, rel);
  if (loaded.has(file)) return loaded.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (STUBS[id]) deps.set(id, STUBS[id]);
    else if (id.startsWith("@/lib/")) deps.set(id, await import(join(ROOT, resolveLocal(id.slice(2))))); // lib/ is plain ESM: the real module
    else if (id.startsWith("./")) deps.set(id, await load(resolveLocal(join(dirname(rel), id))));
    else if (/^@\/components\/(ui|kit|admin\/catalog)\//.test(id)) deps.set(id, await load(resolveLocal(id.slice(2))));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  loaded.set(file, mod.exports);
  return mod.exports;
}
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(h(TooltipProvider, null, el));
const CAT = "components/admin/catalog";
const [SH, PS, PT, CT] = await Promise.all(["SyncHeader", "ProductSheet", "ProductsTable", "CatalogTabs"].map((n) => load(`${CAT}/${n}.js`)));
const SYNC = { state: "complete", linked: true };

await t("rendered: Sync from Shopify is live for owner and admin, RoleGate's (disabled, with the reason) for staff and support", () => {
  for (const role of ROLES) {
    const s = html(h(SH.SyncHeader, { role, canSync: ["owner", "admin"].includes(role), lastSynced: "2 hours ago", products: 55, sync: SYNC }));
    ok(s.includes("Last synced 2 hours ago") && s.includes("55 products"), `${role}: the facts: ${s}`);
    const btn = s.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Sync from Shopify/)?.[0] || "";
    ok(btn, `${role}: the button is shown`);
    if (["owner", "admin"].includes(role)) ok(!/aria-disabled|data-role-gate/.test(btn) && /data-sync-button/.test(btn), `${role}: live: ${btn}`);
    else ok(/aria-disabled="true"/.test(btn) && /data-role-gate="disabled"/.test(btn), `${role}: gated: ${btn}`);
  }
  ok(SH.SYNC_REASON.length > 20 && /owner|admin/.test(SH.SYNC_REASON), "the reason says who can");
});

await t("rendered: support's sheet links say View content; writers' say Edit content; every sheet link is a marked read", () => {
  eq(ROLES.map((r) => PS.editorLinkLabel(r)), ["Edit content", "Edit content", "Edit content", "View content"], "product:");
  eq(ROLES.map((r) => PS.editorLinkLabel(r, "collection")), ["Edit collection content", "Edit collection content", "Edit collection content", "View collection content"], "collection:");
  const s = html(h(PS.SheetLinks, { editorHref: `/admin/editor?product=${encodeURIComponent(P(1))}`, editorLabel: PS.editorLinkLabel("support"), storeUrl: "/products/fixture-product-1", shopifyUrl: "https://admin.shopify.com/store/x/products/9101" }));
  const links = [...s.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
  eq(links.length, 3, "three links:");
  ok(links.every((l) => l.includes('data-read-control="true"')), `all marked: ${links.join(" ")}`);
  ok(s.includes(`href="/admin/editor?product=${encodeURIComponent(P(1))}"`) && s.includes(">View content<"), "support's editor link:");
  ok(/View on store/.test(s) && /View in Shopify/.test(s), "store and Shopify links");
  ok(/Price and stock change in Shopify/.test(PS.PRICE_NOTE), "the price note");
  const D = require("radix-ui").Dialog;
  const close = html(h(D.Root, { open: false }, h(PS.SheetCloseButton)));
  ok(/<button[^>]*data-read-control="true"[^>]*aria-label="Close"/.test(close), `the sheet's own close button is a marked read: ${close}`);
});

const firstPage = await a.run(async () => {
  const L = await import("../lib/admin/catalog-browse.js");
  return L.browseProducts({});
}).catch(() => null);
await t("rendered: the Products tab: a marked search box, the content filters with counts, the stock filter, a row name that opens the sheet, a price range and a content badge", () => {
  const items = [
    { productId: P(1), handle: "a", title: "Founder's one", shopifyTitle: "Fixture product 01", thumb: null, inShopify: true, productType: "Fixture", priceMin: 100, priceMax: 250, currency: "INR", available: true, totalInventory: 10, content: "published" },
    { productId: P(3), handle: "b", title: "Fixture product 03", shopifyTitle: null, thumb: null, inShopify: true, productType: "Fixture", priceMin: 300, priceMax: 300, currency: "INR", available: false, totalInventory: 0, content: "draft" },
  ];
  const s = html(h(PT.ProductsTable, { initial: { items, nextCursor: "c", total: 55, counts: { all: 55, edited: 3, changedInShopify: 1, orphaned: 1 } }, currency: "INR", onOpen() {} }));
  ok(/<form[^>]*method="get"[^>]*>[\s\S]*<input[^>]*data-read-control="true"/.test(s), "the search box sits in a GET form, marked:");
  for (const w of ["All", "Edited", "Changed in Shopify", "No longer in Shopify", "Any stock", "In stock", "Sold out"]) ok(new RegExp(`<button type="button" data-read-control="true" aria-pressed="(true|false)"[^>]*>${w}`).test(s), `filter ${w}:`);
  ok(/>55<\/span>/.test(s) && />3<\/span>/.test(s), "counts shown");
  ok(/<button type="button" data-read-control="true"[^>]*title="Founder&#x27;s one"/.test(s), "the row name is a marked button:");
  ok(s.includes("Shopify: Fixture product 01"), "Shopify's name under it");
  ok(s.includes("₹100") && s.includes("₹250"), `a price range: ${s.match(/money-cell[^<]*<|₹[\d,]+/g)}`);
  ok(s.includes(">Published<") && s.includes(">Draft changes<") && s.includes("Sold out"), "badges and stock");
  ok(s.includes("1–2 of 55"), "the footer");
  ok(!/<button(?![^>]*data-read-control)(?![^>]*disabled)[^>]*>/.test(s), `every enabled button is a marked read: ${(s.match(/<button(?![^>]*data-read-control)(?![^>]*disabled)[^>]*>/g) || []).join(" ")}`);
  ok(firstPage && firstPage.items.length === 0, "(the fixture's catalog was emptied above)");
});

await t("rendered: an empty catalog says Connect Shopify in onboarding; a search with no match offers Clear", () => {
  const empty = html(h(PT.ProductsTable, { initial: { items: [], nextCursor: null, total: 0, counts: { all: 0, edited: 0, changedInShopify: 0, orphaned: 0 } }, currency: "INR", onOpen() {} }));
  ok(empty.includes("Connect Shopify in onboarding") && /href="\/admin\/onboarding"[^>]*data-read-control="true"|data-read-control="true"[^>]*href="\/admin\/onboarding"/.test(empty), `empty: ${empty.slice(0, 400)}`);
  const none = html(h(PT.ProductsTable, { initial: { items: [], nextCursor: null, total: 0, counts: { all: 5, edited: 0, changedInShopify: 0, orphaned: 0 } }, currency: "INR", onOpen() {} }));
  ok(none.includes("No products match") && none.includes("Clear search and filters"), "no match:");
});

await t("rendered: the tabs are marked reads", () => {
  const s = html(h(CT.CatalogTabs, { initial: { items: [], nextCursor: null, total: 0, counts: { all: 0, edited: 0, changedInShopify: 0, orphaned: 0 } }, currency: "INR", role: "support" }));
  const tabs = [...s.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  eq(tabs.length, 2, "two tabs:");
  ok(tabs.every((x) => x.includes('data-read-control="true"')), `marked: ${tabs.join(" ")}`);
});

await t("no fetch() left the suite", () => eq(network, [], "network calls:"));
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
