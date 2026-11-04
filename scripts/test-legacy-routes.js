// P4-ED05 suite (ED-05, MIG-03, DOC-06; spec 8.13): the old console routes,
// the frozen-table readers, the setup and help links, the saved templates and
// the D2 ruling, on a documents store and unchanged on legacy and migrating.
//   1. unit: lib/admin/editor-entry.js, where each old address leads.
//   2. rendered: the real page modules, compiled with Next's own SWC and
//      called as server components with their data stubbed: on a documents
//      store each old URL redirects to its destination (catalog, upsells,
//      designer/product, designer/collection, pages/[slug] existing and
//      missing, plus the nine P3-ROUTES ones: the eight old screens and
//      /admin/releases, which stays the "Recently published" page); on legacy
//      and migrating (and a mode that can't be read) each renders exactly as
//      the same file did at b6110fe (git show).
//   3. links: onboarding, ReleasesAdmin and PreviewFrame on a documents store
//      point at editor destinations and are unchanged on legacy; a grep of
//      hard-coded hrefs in components/admin and lib/admin never targets
//      /admin/catalog, /admin/home, /admin/upsells or a bare
//      /admin/storefront outside its allowlist (a planted one fails).
//   4. the READ guard (spec 8.13): getBlock, getBlockRow, getHero, getNav,
//      listContentPages, listTemplates and direct reads of the frozen tables
//      only in allowlisted files, each with its reason (a planted one fails).
//   5. real file-database stores (scripts/support/tenant-fixture.js): the
//      readers (insights, onboarding, the catalog route, cms/view) on a
//      documents and a legacy store; the catalog and upsells writes refused
//      inside their batch answer 409 with the plain words; "Make a page from
//      this"; the D2 ruling, with the campaign, journal and page routes
//      rendered over the published documents.
// No network, no Typesense, no Shopify, no sqld.
//   pnpm test:legacy-routes
import "./support/request-cache.js";
import { registerHooks, createRequire } from "node:module";
import { readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const LIB = join(ROOT, "lib") + sep;
const BASE = "b6110fe"; // the commit this item was cut from: "as today"
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
process.env.DATABASE_URL = "file:.test-lr-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "SHOPIFY_STORE_DOMAIN", "ANTHROPIC_API_KEY"]) delete process.env[k];
globalThis.fetch = async (url) => {
  throw new Error(`test-legacy-routes: no network (${String(url?.url ?? url).slice(0, 80)})`);
};
const realLog = console.log;
const SLOGS = []; // P4-FIX4: the slog lines, for the cases that check what was logged
console.log = (...a) => {
  if (a.length === 1 && typeof a[0] === "string" && a[0].startsWith("{")) {
    try {
      SLOGS.push(JSON.parse(a[0]));
      if (SLOGS.length > 2000) SLOGS.splice(0, 1000);
    } catch {
      /* not JSON */
    }
    return; // slog lines
  }
  realLog(...a);
};
const logged = (evt, since = 0) => SLOGS.slice(since).filter((l) => l.evt === evt);

const require = createRequire(import.meta.url);
const started = Date.now();
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    realLog(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 4).join("\n   ") || e}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w.slice(0, 900)}, got ${g.slice(0, 900)}`);
};
const baseSource = (rel) => execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

// ---- 1. unit: editor-entry ------------------------------------------------------------
realLog("— 1. where each old address leads (lib/admin/editor-entry.js)");
const E = await import("../lib/admin/editor-entry.js");
const Ids = await import("../lib/documents/ids.js");
const P1 = "gid://shopify/Product/9101";
const C1 = "gid://shopify/Collection/501";
const ped = (gid) => `/admin/editor?product=${encodeURIComponent(gid)}`;

await t("unit: catalog -> the Products list, or the product (collection) asked for; upsells -> the product's pairs or the cart's offer", () => {
  eq(E.catalogHref({}), "/admin/editor?list=products", "bare catalog:");
  eq(E.catalogHref({ product: P1 }), ped(P1), "?product=:");
  eq(E.catalogHref(new URLSearchParams(`product=${encodeURIComponent(P1)}`)), ped(P1), "URLSearchParams:");
  eq(E.catalogHref({ collection: C1 }), `/admin/editor?collection=${encodeURIComponent(C1)}`, "?collection=:");
  for (const junk of [{ product: "x" }, { product: C1 }, { product: ["", P1] }, null, "x"]) eq(E.catalogHref(junk), E.PRODUCTS_LIST_HREF, `junk ${JSON.stringify(junk)}:`);
  eq(E.upsellsHref({}), "/admin/editor?doc=doc_cart", "bare upsells:");
  eq(E.upsellsHref({ product: P1 }), ped(P1), "pairs:");
  eq(E.upsellsHref({ product: "javascript:alert(1)" }), "/admin/editor?doc=doc_cart", "junk product:");
  eq(E.LEGACY_ROUTE_HREFS, { "/admin/catalog": "/admin/editor?list=products", "/admin/releases": "/admin/releases" }, "LEGACY_ROUTE_HREFS:");
  eq(E.LEGACY_ROUTE_DOCS["/admin/storefront/designer/product"], "doc_product_layout", "designer/product:");
  eq(E.LEGACY_ROUTE_DOCS["/admin/storefront/designer/collection"], "doc_collection_layout", "designer/collection:");
  eq(E.LEGACY_ROUTE_DOCS["/admin/upsells"], "doc_cart", "upsells:");
  // every document a redirect names opens in the editor (singletons before their row exists)
  for (const id of new Set(Object.values(E.LEGACY_ROUTE_DOCS))) eq([E.editorEntry({ doc: id }, []).document.id, E.editorEntry({ doc: id }, []).note], [id, null], `${id}:`);
});

await t("unit: pages/[slug] -> that page's document (backfill id, or an editor-made one by type and slug); a missing one -> its backfill id, which the editor opens as home with the missing-page note", async () => {
  const about = await Ids.backfillRouteId("page", "about");
  const docs = [
    { id: about, type: "page", slug: "about", label: "About" },
    { id: "doc_cccccccccccccccc", type: "campaign", slug: "spring", label: "Spring" },
    { id: "doc_jjjjjjjjjjjjjjjj", type: "journal", slug: "hello", label: "Hello" },
  ];
  eq(await E.legacyPageHref("about", docs), `/admin/editor?doc=${about}`, "backfilled:");
  eq(await E.legacyPageHref("spring", docs), "/admin/editor?doc=doc_cccccccccccccccc", "editor-made campaign:");
  eq(await E.legacyPageHref("hello", docs), "/admin/editor?doc=doc_jjjjjjjjjjjjjjjj", "journal post:");
  eq(await E.legacyPageHref("size%20guide", [{ id: "doc_ssssssssssssssss", type: "page", slug: "size guide", label: "S" }]), "/admin/editor?doc=doc_ssssssssssssssss", "an encoded slug:");
  eq(await E.legacyPageHref("new", docs), "/admin/editor", "new:");
  const gone = await E.legacyPageHref("gone", docs);
  eq(gone, `/admin/editor?doc=${await Ids.backfillRouteId("page", "gone")}`, "missing:");
  const opened = E.editorEntry(Object.fromEntries(new URL(gone, "https://x.test").searchParams), docs);
  eq([opened.document.id, opened.note], ["doc_home", E.NOTES.missingDoc], "the editor at a missing page:");
});

await t("unit: editorDestination maps every old screen link to its editor destination; other links are unchanged", () => {
  const cases = [
    ["/admin/storefront", "/admin/editor?doc=doc_home"],
    ["/admin/storefront/home#hero", "/admin/editor?doc=doc_home"],
    ["/admin/storefront/navigation#announcement", "/admin/editor?doc=doc_header"],
    ["/admin/storefront/product-pages", "/admin/editor?doc=doc_product_layout"],
    ["/admin/storefront/designer/collection", "/admin/editor?doc=doc_collection_layout"],
    ["/admin/theme#page-templates", "/admin/editor?doc=doc_design"],
    ["/admin/brand", "/admin/editor?doc=doc_design"],
    ["/admin/catalog", "/admin/editor?list=products"],
    [`/admin/catalog?product=${encodeURIComponent(P1)}`, ped(P1)],
    ["/admin/upsells", "/admin/editor?doc=doc_cart"],
    ["/admin/storefront/pages/about", "/admin/storefront/pages/about"], // its route finds the document
    ["/admin/releases", "/admin/releases"],
    ["/admin/media", "/admin/media"],
  ];
  for (const [from, to] of cases) eq(E.editorDestination(from), to, `${from}:`);
  eq(E.editorPathHref("/policies/terms?x=1"), "/admin/editor?path=%2Fpolicies%2Fterms", "editorPathHref:");
  eq(E.editorPathHref("https://evil.test/"), "/admin/editor", "an off-site path:");
});

// ---- the loader ----------------------------------------------------------------------------
// app/ and components/ files are compiled with Next's SWC to CommonJS (stubs
// replace the data and the heavy client parts); lib/ files are the real ES
// modules, so a page and the suite share one copy of each (one tenant scope).
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const compile = async (file, source) =>
  (
    await swc.transform(source ?? (await readFile(file, "utf8")), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
function world(stubs) {
  const cache = new Map();
  async function load(file, { source } = {}) {
    const key = source == null ? file : null;
    if (key && cache.has(key)) return cache.get(key);
    const mod = { exports: {} };
    if (key) cache.set(key, mod.exports);
    const code = await compile(file, source);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || local.has(id)) continue;
      const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
      if (!target) continue;
      const full = /\.(m?js)$/.test(target) ? target : `${target}.js`;
      local.set(id, full.startsWith(LIB) ? await import(pathToFileURL(full).href) : await load(full));
    }
    new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
    if (key) cache.set(key, mod.exports);
    return mod.exports;
  }
  return load;
}
class Redirect extends Error {
  constructor(to) {
    super(`NEXT_REDIRECT ${to}`);
    this.to = to;
  }
}
class NotFound extends Error {}
const marker = (name) => (props) => React.createElement("div", { "data-stub": name, "data-props": JSON.stringify(props ?? {}) });
const nav = {
  redirect: (to) => {
    throw new Redirect(to);
  },
  permanentRedirect: (to) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound("not found");
  },
  usePathname: () => "/admin",
  useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
};
const linkStub = { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) };

// ---- 2. rendered: the pages -----------------------------------------------------------------
realLog("— 2. the old routes, rendered");
const AUTHED = join(ROOT, "app/(console)/admin/(authed)");
const S = { mode: "legacy", modeThrows: false, modeReads: 0, docs: [] };
const chain = (rows) => {
  const c = new Proxy(
    {},
    {
      get: (_, k) => (k === "execute" ? async () => rows : k === "executeTakeFirst" ? async () => rows[0] : k === "then" ? undefined : () => c),
    },
  );
  return c;
};
const PRODUCTS = [{ id: P1, handle: "whey", title: "Whey", product_type: "Protein", price_min: 100, currency: "INR", available: 1, featured_image: null }];
const TABLES = {
  products: PRODUCTS,
  collections: [{ id: C1, handle: "protein", title: "Protein" }],
  cms_pages: [{ slug: "about", title: "About us", description: "", sections: '[{"kind":"text","heading":"Hi","body":["Hello"]}]', enabled: 1, effective_at: null, family: "page", window_start: null, window_end: null }],
};
const ABOUT_ID = await Ids.backfillRouteId("page", "about");
const DOCS = [
  { id: "doc_home", type: "home", slug: null, label: "Home page" },
  { id: ABOUT_ID, type: "page", slug: "about", label: "About us" },
  { id: "doc_cccccccccccccccc", type: "campaign", slug: "spring", label: "Spring" },
];
S.docs = DOCS;
const pageStubs = {
  "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
  "next/navigation": nav,
  "next/link": linkStub,
  "@/lib/admin-auth": { adminActor: async () => ({ kind: "member", role: "owner" }), ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
  "@/lib/console-request": { tfetch: (fn) => fn() },
  "@/lib/cms-mode": {
    DOCUMENTS_MESSAGE: "This store publishes with the new editor",
    getCmsMode: async () => {
      S.modeReads++;
      if (S.modeThrows) throw Object.assign(new Error("We couldn't check which editor this store uses"), { code: "CMS_MODE_UNAVAILABLE" });
      return S.mode;
    },
  },
  "@/lib/documents/service": { listDocuments: async () => S.docs },
  "@/lib/admin/editor-entry": E,
  "@/lib/db": { db: { selectFrom: (t) => chain(TABLES[t] || []) }, libsql: { execute: async () => ({ rows: [{ id: "tpl_1", name: "Size guide", family: "page", sections: '[{"kind":"text","heading":"Sizes","body":["S M L"]}]', updated_at: "2026-10-01" }] }) } },
  "@/lib/schema-shape": { notMigratedYet: () => false },
  "@/lib/catalog-overrides": { listProductOverrides: async () => [{ product_id: P1, modules: [], badge: "New" }], getCollectionPins: async () => [P1] },
  "@/lib/bundles": { listBundles: async () => [{ id: "b1", title: "Stack" }] },
  "@/lib/quiz": { listQuizzes: async () => [{ id: "q1", title: "Finder" }] },
  "@/components/admin/CatalogAdmin": { __esModule: true, default: marker("CatalogAdmin") },
  "@/components/admin/CommercePanels": { BundlesPanel: marker("BundlesPanel"), QuizPanel: marker("QuizPanel") },
  "@/lib/cms/placements": { listPlacements: async () => [{ id: "pl1", kind: "pdp_pairs", source_product_id: P1, target_product_ids: [P1], title: null, enabled: true, position: 0 }] },
  "@/components/admin/UpsellsAdmin": { __esModule: true, default: marker("UpsellsAdmin") },
  "@/lib/cms/store": {
    getBlockRow: async () => ({ value: { pdp: "classic" }, revision: 3 }),
    getContentPage: async (slug) => (slug === "faq" ? { slug, title: "FAQ", description: "", sections: [], family: "page" } : null),
    pageRevisions: async () => ({ about: 4 }),
  },
  "@/lib/cms/templates-store": { listTemplates: async () => [{ id: "tpl_1", name: "Size guide", family: "page" }] },
  "@/components/admin/cms/SurfaceDesigner": { __esModule: true, default: marker("SurfaceDesigner") },
  "@/components/admin/cms/PageEditor": { PageEditor: marker("PageEditor") },
  "@/lib/platform/authz": { roleAllows: () => true },
  "@/lib/releases": {
    listReleases: async () => ({ releases: [] }),
    getLiveRelease: async () => ({ content_hash: "abcdef0123456789", note: null, content: {} }),
    snapshotContent: async () => ({ content: {}, hash: "abc" }),
    validateRelease: async () => ({ ok: true, issues: [], errors: [], warnings: [], sections: [] }),
    releaseDiff: async () => ({ items: [], dirty: false, firstPublish: false }),
  },
  "@/components/admin/ReleasesAdmin": { __esModule: true, default: marker("ReleasesAdmin") },
  "@/components/admin/editor/DocumentEditor": { PublishingHistory: marker("PublishingHistory") },
  "@/components/admin/SavedTemplates": { __esModule: true, default: marker("SavedTemplates") },
  // the eight P3-ROUTES screens (as scripts/test-editor-routes.js stubs them)
  "@/lib/cms/issues": await import("../lib/cms/issues.js"),
  "@/lib/cms/view": {
    storefrontView: async () => ({ blocks: { hero: { title: "Skin first" } }, customized: { hero: true }, revisions: { hero: 1 }, blockMeta: { hero: { updated_at: "2026-10-01T10:00:00.000Z" } }, pages: [{ slug: "about", title: "About us", family: "policy", source: "custom", enabled: true, updated_at: "2026-10-02T10:00:00.000Z" }], pageRevisions: { about: 2 } }),
  },
  "@/lib/experiments": { runningTestsBySection: async () => ({}) },
  "@/lib/tenant-context": { currentTenant: () => ({ config: { brand: { accent: "#112233" } } }), tenantOwnCfg: () => ({ kit: "pulse" }) },
  "@/lib/brand": { resolveBrand: (b) => ({ accent: b?.accent || "#000000" }), accentShades: () => ({ 500: "#112233" }), DEFAULT_BRAND: { accent: "#000000" } },
  "@/lib/admin/brand-readability": { brandReadability: async () => ({ warnings: [], notes: [] }) },
  "@/lib/themes/kits": { KITS: { pulse: { id: "pulse", version: 1, label: "Pulse", vertical: "beauty", description: "d", fonts: {}, brand: {}, swatch: [] } }, kitUpgradeAvailable: () => false },
  "@/components/admin/cms/Designer": { __esModule: true, default: marker("Designer") },
  "@/components/admin/cms/HomeEditor": { __esModule: true, default: marker("HomeEditor") },
  "@/components/admin/cms/NavigationEditor": { __esModule: true, default: marker("NavigationEditor") },
  "@/components/admin/cms/PdpExtrasEditor": { __esModule: true, default: marker("PdpExtrasEditor") },
  "@/components/admin/cms/PagesList": { PagesList: marker("PagesList") },
  "@/components/admin/BrandAdmin": { __esModule: true, default: marker("BrandAdmin") },
  "@/components/admin/ThemeAdmin": { __esModule: true, default: marker("ThemeAdmin") },
  "@/components/admin/cms/SurfaceTemplatesCard": { __esModule: true, default: marker("SurfaceTemplatesCard") },
};
const loadPage = world(pageStubs);

// Calls a page module like Next does: -> { redirect } | { html } | { notFound }.
async function run(file, { mode = "legacy", query = {}, params = {}, modeThrows = false, source } = {}) {
  Object.assign(S, { mode, modeThrows, modeReads: 0 });
  const Page = (await loadPage(join(AUTHED, file), source != null ? { source } : {})).default;
  try {
    const el = await Page({ params: Promise.resolve(params), searchParams: Promise.resolve(query) });
    return { html: renderToStaticMarkup(el), modeReads: S.modeReads };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to, modeReads: S.modeReads };
    if (e instanceof NotFound) return { notFound: true };
    throw e;
  }
}
const at = (file) => `app/(console)/admin/(authed)/${file}`;

// Every old URL on a documents store: [label, file, query, params, want]
const ROUTES = [
  ["/admin/catalog?product=", "catalog/page.js", { product: P1 }, {}, ped(P1)],
  ["/admin/catalog?collection=", "catalog/page.js", { collection: C1 }, {}, `/admin/editor?collection=${encodeURIComponent(C1)}`],
  ["/admin/upsells", "upsells/page.js", {}, {}, "/admin/editor?doc=doc_cart"],
  ["/admin/upsells?product=", "upsells/page.js", { product: P1 }, {}, ped(P1)],
  ["/admin/storefront/designer/product", "storefront/designer/product/page.js", {}, {}, "/admin/editor?doc=doc_product_layout"],
  ["/admin/storefront/designer/collection", "storefront/designer/collection/page.js", {}, {}, "/admin/editor?doc=doc_collection_layout"],
  ["/admin/storefront/pages/about (exists)", "storefront/pages/[slug]/page.js", {}, { slug: "about" }, `/admin/editor?doc=${ABOUT_ID}`],
  ["/admin/storefront/pages/spring (an editor-made campaign)", "storefront/pages/[slug]/page.js", {}, { slug: "spring" }, "/admin/editor?doc=doc_cccccccccccccccc"],
  ["/admin/storefront/pages/gone (missing)", "storefront/pages/[slug]/page.js", {}, { slug: "gone" }, `/admin/editor?doc=${await Ids.backfillRouteId("page", "gone")}`],
  ["/admin/storefront/pages/new", "storefront/pages/[slug]/page.js", {}, { slug: "new" }, "/admin/editor"],
  // the nine P3-ROUTES addresses
  ["/admin/storefront", "storefront/page.js", {}, {}, "/admin/editor?doc=doc_home"],
  ["/admin/storefront/designer", "storefront/designer/page.js", {}, {}, "/admin/editor?doc=doc_home"],
  ["/admin/storefront/home", "storefront/home/page.js", {}, {}, "/admin/editor?doc=doc_home"],
  ["/admin/storefront/navigation", "storefront/navigation/page.js", {}, {}, "/admin/editor?doc=doc_header"],
  ["/admin/storefront/pages", "storefront/pages/page.js", {}, {}, "/admin/editor?doc=doc_home"],
  ["/admin/storefront/product-pages", "storefront/product-pages/page.js", {}, {}, "/admin/editor?doc=doc_product_layout"],
  ["/admin/brand", "brand/page.js", {}, {}, "/admin/editor?doc=doc_design"],
  ["/admin/theme", "theme/page.js", {}, {}, "/admin/editor?doc=doc_design"],
];

await t("rendered: on a documents store every old URL redirects to its listed destination (before loading its data)", async () => {
  for (const [label, file, query, params, want] of ROUTES) {
    const r = await run(file, { mode: "documents", query, params });
    eq(r.redirect, want, `${label}:`);
  }
});

await t("rendered: /admin/catalog on a documents store keeps Bundles and Quiz, links to the editor's Products list, and shows no old product editor; /admin/releases stays the Recently published page", async () => {
  const r = await run("catalog/page.js", { mode: "documents" });
  ok(r.html, `redirected: ${r.redirect}`);
  ok(r.html.includes('data-stub="BundlesPanel"') && r.html.includes('data-stub="QuizPanel"'), "Bundles or Quiz missing");
  ok(r.html.includes('href="/admin/editor?list=products"'), "no link to the Products list");
  ok(!r.html.includes("CatalogAdmin"), "the old product editor (its saves refuse) still shows");
  const rel = await run("releases/page.js", { mode: "documents" });
  ok(!rel.redirect && rel.html.includes("data-recently-published-page") && rel.html.includes('data-stub="PublishingHistory"'), `releases: ${rel.redirect || rel.html}`);
});

// [file, params, query] rendered on legacy and migrating, against the b6110fe file
const RENDERS = [
  ["catalog/page.js", {}, {}, "CatalogAdmin"],
  ["catalog/page.js", {}, { product: P1 }, "CatalogAdmin"],
  ["upsells/page.js", {}, {}, "UpsellsAdmin"],
  ["storefront/designer/product/page.js", {}, {}, "SurfaceDesigner"],
  ["storefront/designer/collection/page.js", {}, {}, "SurfaceDesigner"],
  ["storefront/pages/[slug]/page.js", { slug: "about" }, {}, "PageEditor"],
  ["storefront/pages/[slug]/page.js", { slug: "new" }, {}, "PageEditor"],
  ["storefront/pages/[slug]/page.js", { slug: "faq" }, {}, "PageEditor"],
  ["releases/page.js", {}, {}, "ReleasesAdmin"],
  ["storefront/page.js", {}, {}, "Published state"],
  ["storefront/designer/page.js", {}, {}, "Designer"],
  ["storefront/home/page.js", {}, {}, "HomeEditor"],
  ["storefront/navigation/page.js", {}, {}, "NavigationEditor"],
  ["storefront/pages/page.js", {}, {}, "PagesList"],
  ["storefront/product-pages/page.js", {}, {}, "PdpExtrasEditor"],
  ["brand/page.js", {}, {}, "BrandAdmin"],
  ["theme/page.js", {}, {}, "ThemeAdmin"],
];
await t("rendered: on legacy and migrating stores (and when the mode can't be read) every old URL renders exactly as the same file did at b6110fe", async () => {
  for (const [file, params, query, shows] of RENDERS) {
    const before = await run(file, { mode: "legacy", params, query, source: baseSource(at(file)) });
    ok(before.html && before.html.includes(shows), `${file} at ${BASE}: ${before.redirect || String(before.html).slice(0, 200)}`);
    for (const [mode, modeThrows] of [
      ["legacy", false],
      ["migrating", false],
      ["documents", true],
    ]) {
      if (file === "releases/page.js" && modeThrows) continue; // its mode read is its data read (an error page, as before)
      const r = await run(file, { mode, params, query, modeThrows });
      ok(!r.redirect, `${file} (${mode}${modeThrows ? ", unreadable" : ""}) redirected to ${r.redirect}`);
      if (file === "releases/page.js" && mode === "migrating") {
        ok(r.html.includes("data-documents-mode"), "releases on migrating: the note, as before");
        continue;
      }
      ok(r.html === before.html, `${file} (${mode}${modeThrows ? ", unreadable" : ""}) renders differently from ${BASE}:\n${r.html.slice(0, 300)}\n${before.html.slice(0, 300)}`);
    }
  }
});

await t("rendered: the saved templates page lists by family on a documents store, and is a note (no list, no action) on legacy and migrating", async () => {
  const d = await run("editor/templates/page.js", { mode: "documents" });
  ok(d.html.includes("data-saved-templates") && d.html.includes('data-stub="SavedTemplates"'), d.html);
  const props = JSON.parse(d.html.match(/data-props="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  eq(props.templates.map((x) => [x.id, x.name, x.family, x.sections.length]), [["tpl_1", "Size guide", "page", 1]], "templates:");
  for (const mode of ["legacy", "migrating"]) {
    const r = await run("editor/templates/page.js", { mode });
    ok(r.html.includes(`data-templates-note="${mode}"`) && !r.html.includes("SavedTemplates"), `${mode}: ${r.html}`);
  }
});

// ---- 3. links -------------------------------------------------------------------------------
realLog("— 3. setup, diff and help links");
const FORBIDDEN = /^\/admin\/(?:catalog|home|upsells)(?:[/?#]|$)|^\/admin\/storefront(?:[?#]|$)/;
const forbidden = (href) => typeof href === "string" && FORBIDDEN.test(href);
const hrefsIn = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const isEditorDestination = (href) => href.startsWith("/admin/editor") || href === "/admin/releases" || /^\/admin\/storefront\/pages\/[^/?#]+$/.test(href);

const compStubs = {
  "next/link": linkStub,
  "next/navigation": nav,
  "@/components/admin/cms/api": { startPreview: async () => ({ ok: true }), NETWORK_ERROR: "We couldn't reach Storeasy, so nothing was saved." },
  "@/components/console/Toast": { useToast: () => ({ success() {}, error() {} }) },
};
const loadComp = world(compStubs);
const DIFF_ITEMS = [
  ...["announcement", "hero", "home_sections", "nav_header", "nav_footer", "collections_index", "pdp_extras", "surface_templates", "mystery"].map((key) => ({ type: "block", key, change: "edited" })),
  { type: "page", key: "about", change: "edited" },
  { type: "page", key: "old", change: "removed" },
  { type: "brand", key: "brand", change: "edited" },
  { type: "theme", key: "theme", change: "edited" },
  { type: "overrides", key: "overrides", change: "edited" },
  { type: "pins", key: "pins", change: "edited" },
  { type: "placements", key: "placements", change: "edited" },
  { type: "redirects", key: "redirects", change: "edited" },
  { type: "envelope", key: "v2", change: "upgrade" },
  { type: "other", key: "x", change: "edited" },
];
const RELEASES_INITIAL = { releases: [], liveHash: "abcdef0123456789", draftHash: "0123456789abcdef", dirty: true, diff: { items: DIFF_ITEMS, dirty: true, firstPublish: false }, validation: { ok: true, issues: [], errors: [], warnings: [], sections: [] } };

await t("links: ReleasesAdmin's diff chips point at editor destinations on a documents store and are unchanged on legacy (same markup as b6110fe)", async () => {
  const RA = (await loadComp(join(ROOT, "components/admin/ReleasesAdmin.js"))).default;
  const Base = (await loadComp(join(ROOT, "components/admin/ReleasesAdmin.js"), { source: baseSource("components/admin/ReleasesAdmin.js") })).default;
  const docs = renderToStaticMarkup(React.createElement(RA, { initial: RELEASES_INITIAL, cmsMode: "documents" }));
  const chips = hrefsIn(docs);
  ok(chips.length >= DIFF_ITEMS.length, `chips: ${chips}`);
  for (const h of chips) {
    ok(!forbidden(h), `a documents-store chip targets ${h}`);
    ok(isEditorDestination(h), `a documents-store chip is not an editor destination: ${h}`);
  }
  ok(chips.includes("/admin/editor?list=products") && chips.includes("/admin/editor?doc=doc_cart") && chips.includes("/admin/editor?doc=doc_design"), `chips: ${chips}`);
  const base = renderToStaticMarkup(React.createElement(Base, { initial: RELEASES_INITIAL }));
  for (const cmsMode of [undefined, null, "legacy", "migrating"]) eq(renderToStaticMarkup(React.createElement(RA, { initial: RELEASES_INITIAL, cmsMode })), base, `${cmsMode}:`);
  ok(hrefsIn(base).some(forbidden), "the legacy chips should still be the old screens");
});

await t("links: PreviewFrame links to the editor at the same page on a documents store and is today's card on legacy", async () => {
  const PF = (await loadComp(join(ROOT, "components/admin/cms/PreviewFrame.js"))).default;
  const Base = (await loadComp(join(ROOT, "components/admin/cms/PreviewFrame.js"), { source: baseSource("components/admin/cms/PreviewFrame.js") })).default;
  for (const to of ["/", "/policies/terms"]) {
    const html = renderToStaticMarkup(React.createElement(PF, { to, cmsMode: "documents" }));
    eq(hrefsIn(html), [`/admin/editor?path=${encodeURIComponent(to)}`], `${to}:`);
    ok(!html.includes("Open preview"), "the old preview button shows on a documents store");
    for (const cmsMode of [undefined, "legacy", "migrating"]) {
      eq(renderToStaticMarkup(React.createElement(PF, { to, cmsMode })), renderToStaticMarkup(React.createElement(Base, { to })), `${to} ${cmsMode}:`);
    }
  }
});

await t("links: the redirects table and every redirect destination never target an old screen", async () => {
  const all = [
    ...Object.values(E.LEGACY_ROUTE_DOCS).map(E.editorHref),
    ...Object.values(E.LEGACY_ROUTE_HREFS),
    ...ROUTES.map((r) => r[4]),
    E.PRODUCTS_LIST_HREF,
    E.PAGES_LIST_HREF,
    E.EDITOR_PUBLISH_HREF,
  ];
  for (const h of all) {
    ok(!forbidden(h), `targets ${h}`);
    ok(isEditorDestination(h), `${h} is not an editor destination`);
  }
});

// The hard-coded hrefs of components/admin and lib/admin. Each hit outside
// the allowlist fails; each allowlisted file says why, and the ones that are
// "behind a mode check" are checked for it.
const HREF_LITERAL = /["'`](\/admin\/(?:catalog|home|upsells)(?:[/?#][^"'`$]*)?|\/admin\/storefront(?:[?#][^"'`$]*)?)["'`$]/g;
// an old screen that sends a documents store away before reading anything
const redirectsOn = (src) => /if \(cmsMode === "documents"\) redirect\(/.test(src);
const HREF_ALLOW = {
  "lib/admin/editor-entry.js": { why: "the redirect table's own keys: the old addresses it maps, never a link", check: (s) => s.includes("LEGACY_ROUTE_DOCS") },
  "lib/admin/onboarding.js": { why: "the legacy store's links, behind the documents check (documents ? editor : old)", check: (s) => /href: documents \? PAGES_LIST_HREF : "\/admin\/storefront"/.test(s) && /href: documents \? EDITOR_PATH : "\/admin\/storefront"/.test(s) },
  "components/admin/OffersAdmin.js": { why: "a bundle offer is changed with its bundle, and Bundles stay on /admin/catalog on a documents store (until ED-06), so this link works there", check: () => true },
  "components/admin/cms/labels.js": { why: "the old diff's links; ReleasesAdmin maps them with editorDestination on a documents store (tested above), and the Storefront overview redirects there", check: async () => (await readFile(join(ROOT, "components/admin/ReleasesAdmin.js"), "utf8")).includes("editorDestination(info.href)") },
  "components/admin/cms/PdpExtrasEditor.js": { why: "shown only by /admin/storefront/product-pages, which redirects a documents store", screens: ["storefront/product-pages/page.js"] },
  "components/admin/cms/Designer.js": { why: "shown only by /admin/storefront/designer, which redirects a documents store", screens: ["storefront/designer/page.js"] },
  "components/admin/cms/SurfaceDesigner.js": { why: "shown only by the product and collection designers, which redirect a documents store", screens: ["storefront/designer/product/page.js", "storefront/designer/collection/page.js"] },
};
async function walk(dir) {
  const out = [];
  for (const d of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) out.push(...(await walk(rel)));
    else if (/\.(m?js)$/.test(d.name)) out.push(rel);
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
async function hrefScan(files, allow) {
  const problems = [];
  for (const { path, text } of files) {
    const hits = [...stripComments(text).matchAll(HREF_LITERAL)].map((m) => m[1]);
    if (!hits.length) continue;
    const entry = allow[path];
    if (!entry) {
      problems.push(`${path}: ${hits.join(", ")}`);
      continue;
    }
    if (entry.check && !(await entry.check(text))) problems.push(`${path}: its allowlist reason no longer holds (${entry.why})`);
    for (const page of entry.screens || []) if (!redirectsOn(await readFile(join(AUTHED, page), "utf8"))) problems.push(`${path}: ${page} no longer redirects a documents store`);
  }
  return problems;
}
const consoleFiles = async () => Promise.all([...(await walk("components/admin")), ...(await walk("lib/admin"))].map(async (path) => ({ path, text: await readFile(join(ROOT, path), "utf8") })));

await t("links: no hard-coded console link in components/admin or lib/admin targets /admin/catalog, /admin/home, /admin/upsells or a bare /admin/storefront outside the allowlist; a planted one fails", async () => {
  const files = await consoleFiles();
  eq(await hrefScan(files, HREF_ALLOW), [], "the repo:");
  // every allowlisted file still has a hit (a stale entry hides nothing)
  for (const path of Object.keys(HREF_ALLOW)) ok(files.find((f) => f.path === path && stripComments(f.text).match(HREF_LITERAL)), `${path} is allowlisted but has no such link`);
  for (const planted of ['<Link href="/admin/catalog">x</Link>', "router.push(`/admin/upsells`)", "{ href: '/admin/storefront' }", 'href="/admin/home#hero"', 'href="/admin/storefront?x=1"']) {
    const p = await hrefScan([...files, { path: "components/admin/editor/Planted.js", text: planted }], HREF_ALLOW);
    eq(p.length, 1, `planted ${planted}:`);
  }
  eq(await hrefScan([{ path: "components/admin/editor/Fine.js", text: 'href="/admin/storefront/pages/about" href="/admin/editor" href="/admin/catalogue-x"' }], HREF_ALLOW), [], "fine links:");
  // an allowlisted screen that stops redirecting fails its entry
  const p = await hrefScan([{ path: "components/admin/cms/Designer.js", text: 'href="/admin/storefront"' }], { "components/admin/cms/Designer.js": { why: "x", screens: ["upsells/page.js", "catalog/page.js"] } });
  ok(p.length === 1 && p[0].includes("catalog/page.js"), `the catalog page keeps rendering, so it can't vouch: ${p}`);
});

// ---- 4. the read guard ------------------------------------------------------------------------
realLog("— 4. the read guard (spec 8.13)");
const FROZEN = "cms_blocks|cms_pages|placements|product_overrides|collection_overrides|page_redirects|cms_templates";
// P4-FIX4: the wrapper readers over the same tables (announcement and home
// sections blocks, one page, a product's modules, a collection's pins, the
// upsell placements) count as reads too.
const READ_FNS = "getBlock|getBlockRow|getHero|getNav|listContentPages|listTemplates|getAnnouncement|getHomeSections|getContentPage|getProductOverride|getCollectionPins|listPlacements";
const READS = [
  new RegExp(`\\b(${READ_FNS})\\s*\\(`, "g"),
  new RegExp(`\\b(?:selectFrom|innerJoin|leftJoin|join)\\(\\s*["'\`](?:${FROZEN})\\b`, "g"),
  new RegExp(`\\b(?:FROM|JOIN)\\s+(?:${FROZEN})\\b`, "g"),
];
const modeChecked = (re) => (s) => re.test(s);
const READ_ALLOW = {
  "lib/cms/store.js": { why: "the legacy content module itself (the old getters and writers)" },
  "lib/cms/templates-store.js": { why: "the legacy saved templates module (the old page editor's)" },
  "lib/cms/placements.js": { why: "the legacy upsell placements module" },
  "lib/catalog-overrides.js": { why: "the legacy product modules and collection pins module" },
  "lib/releases.js": { why: "legacy releases: snapshot, diff and validate; a documents store is refused before them (P2-GUARD)" },
  "lib/content/resolve.js": { why: "draft reads only for a legacy or migrating store (src.mode === 'draft'), and the v1 fallbacks of a legacy release", check: modeChecked(/src\.mode === "draft"/) },
  "lib/content/legacy-release.js": { why: "the frozen legacy reader (v1 to v3)" },
  "lib/repo.js": { why: "the pins read of the draft and v1 paths (resolve.js); v4 reads the live rows (P4-OVL07)" },
  "lib/media.js": { why: "the legacy media usage scan; a documents store uses document_refs (P4-MEDIA)", check: modeChecked(/mode === "documents"/) },
  "lib/cms/view.js": { why: "the legacy view, behind the documents check (documentsView)", check: modeChecked(/getCmsMode\(\)\)\s*===\s*"documents"\)\s*return documentsView/) },
  "lib/ai/insights.js": { why: "the legacy hero, behind the documents check (the published home's hero)", check: modeChecked(/getCmsMode\(\)\)\s*===\s*"documents"\)\s*\{[\s\S]*publishedGetters/) },
  "lib/admin/onboarding.js": { why: "the legacy page list, behind the documents check (the published page documents)", check: modeChecked(/documents \? documentsPages\(\) : listContentPages\(\)/) },
  "app/api/admin/catalog/route.js": { why: "the legacy template, behind the documents check (the live rows)", check: modeChecked(/if \(live\) \{[\s\S]*resolvedSurfaceTemplateFor\("pdp"/) },
  "lib/admin/cms-api.js": { why: "the old storefront API: its writes refuse on a documents store (P2-GUARD), its page and history reads answer the published page and no history there (P4-FIX4) and its view is cms/view's; its template list only reads the saved templates, as the saved templates page does", check: modeChecked(/if \(DOCUMENTS_READS\.has\(op\.kind\)\) \{[\s\S]*?if \(\(await getCmsMode\(\)\) === "documents"\) \{[\s\S]*?publishedGetters/) },
  // P4-FIX4: the wrapper readers' call sites
  "app/(console)/admin/(authed)/catalog/page.js": {
    why: "the old product editor's lists (product modules, collection pins), after the documents branch has returned (Bundles and Quiz only there)",
    check: (s) => {
      const i = s.search(/if \(cmsMode === "documents"\) \{/);
      const j = s.indexOf("getCollectionPins(c.id)");
      return i >= 0 && j > i && /\n\s*return \(/.test(s.slice(i, j));
    },
  },
  "app/(console)/admin/(authed)/upsells/page.js": { why: "the old upsells screen: a documents store is redirected before any read", check: (s) => /if \(cmsMode === "documents"\) redirect\(/.test(s) },
  "app/api/admin/upsells/route.js": { why: "the old upsells API: GET refuses on a documents store before reading (P4-FIX4), POST reads only after the write refusal", check: modeChecked(/if \(mode === "documents"\) return NextResponse\.json\(\{ error: UPSELLS_IN_EDITOR[\s\S]*listWithHandles\(\) \}\);\n\}\);\n\nexport const POST[\s\S]*if \(refused\) return[\s\S]*listPlacements\(\)/) },
  "app/api/admin/upsells/[id]/route.js": { why: "the old upsells toggle reads the row it writes, only after the write refusal", check: modeChecked(/if \(refused\) return [^\n]*\n\s*const row = \(await listPlacements\(\)\)/) },
  "app/(console)/admin/(authed)/editor/templates/page.js": { why: "the read-only saved templates page reads cms_templates on a documents store by design (DOC-09 partly pulled in)" },
  "app/(console)/admin/(authed)/storefront/pages/page.js": { why: "the old pages screen: a documents store is redirected before any read", check: redirectsOn },
  "app/(console)/admin/(authed)/storefront/pages/[slug]/page.js": { why: "the old page editor: a documents store is redirected before any read", check: redirectsOn },
  "app/(console)/admin/(authed)/storefront/designer/product/page.js": { why: "the old product page designer: a documents store is redirected before any read", check: redirectsOn },
  "app/(console)/admin/(authed)/storefront/designer/collection/page.js": { why: "the old collection page designer: a documents store is redirected before any read", check: redirectsOn },
  "lib/content-writes.js": { why: "the write door's legacy branch reads the block it writes; it runs only when the mode is legacy", check: modeChecked(/if \(mode === "legacy"\) return writeLegacy/) },
  "app/(console)/admin/(authed)/theme/page.js": { why: "the old theme screen: a documents store is redirected before any read", check: redirectsOn },
  "lib/platform/agency.js": { why: "KNOWN LIMIT (P4-ED05 packet): the agency kit export still reads the old hero, announcement and home sections on a documents store; not this item's file" },
};
const READ_ALLOW_PREFIX = { "lib/migrate/": "the cutover, its dry run and the reversal read the old tables by design" };
function readScan(files, allow = READ_ALLOW, prefixes = READ_ALLOW_PREFIX) {
  const problems = [];
  for (const { path, text } of files) {
    const body = stripComments(text).replace(new RegExp(`\\b(?:async\\s+)?function\\s+(${READ_FNS})\\s*\\(`, "g"), "function_def(");
    const hits = READS.flatMap((re) => [...body.matchAll(re)].map((m) => m[0]));
    if (!hits.length) continue;
    if (Object.keys(prefixes).some((p) => path.startsWith(p))) continue;
    const entry = allow[path];
    if (!entry) problems.push(`${path}: ${[...new Set(hits)].join(", ")}`);
    else if (entry.check && !entry.check(text)) problems.push(`${path}: its reason no longer holds (${entry.why})`);
  }
  return problems;
}
const codeFiles = async () => Promise.all([...(await walk("app")), ...(await walk("lib")), ...(await walk("components"))].map(async (path) => ({ path, text: await readFile(join(ROOT, path), "utf8") })));

await t("read guard: frozen-table reads only in allowlisted files, each with its reason; a planted getBlock in a documents-path file fails and passes once allowlisted", async () => {
  const files = await codeFiles();
  ok(files.length > 300, `files: ${files.length}`);
  eq(readScan(files), [], "the repo:");
  for (const [path, entry] of Object.entries(READ_ALLOW)) ok(typeof entry.why === "string" && entry.why.length > 20, `${path}: no reason`);
  const planted = { path: "lib/documents/planted.js", text: 'export const x = async () => (await getBlock("hero")) ?? null;' };
  eq(readScan([...files, planted]), ['lib/documents/planted.js: getBlock('], "planted:");
  eq(readScan([...files, planted], { ...READ_ALLOW, "lib/documents/planted.js": { why: "a planted read, allowlisted for this test" } }), [], "allowlisted:");
  for (const text of ['db.selectFrom("cms_blocks")', "db.selectFrom('placements')", 'libsql.execute("SELECT * FROM product_overrides")', 'q.innerJoin("collection_overrides as co", "a", "b")', "await getHero()", "await listContentPages({ strict: true })", 'await getBlockRow("surface_templates")', "await listTemplates()", 'db.selectFrom(`page_redirects`)']) {
    eq(readScan([{ path: "components/admin/editor/X.js", text }]).length, 1, `${text}:`);
  }
  // a read moved out from behind its mode check fails its entry
  eq(readScan([{ path: "lib/ai/insights.js", text: "const hero = await getHero();" }]).length, 1, "insights without its check:");
  eq(readScan([{ path: "app/(console)/admin/(authed)/storefront/designer/product/page.js", text: 'await getBlockRow("surface_templates")' }]).length, 1, "a designer that stops redirecting:");
  // definitions and comments are not reads
  eq(readScan([{ path: "lib/x.js", text: "// getHero() is old\nexport async function getHero() { return 1; }\n/* listTemplates() */" }]), [], "definitions:");
});

await t("P4-FIX4: read guard: READS includes the wrapper readers (announcement, home sections, a page, a product's modules, a collection's pins, placements); each planted call fails, a definition does not", async () => {
  for (const text of ["await getAnnouncement()", "await getHomeSections()", 'await getContentPage("about")', "await getProductOverride(p.id)", "await getCollectionPins(c.id)", "await listPlacements()"]) {
    eq(readScan([{ path: "components/admin/editor/X.js", text }]).length, 1, `${text}:`);
  }
  eq(readScan([{ path: "lib/x.js", text: "export async function getContentPage(slug) { return slug; }\nexport async function listPlacements() { return []; }" }]), [], "definitions:");
  // the routes this item changed: a documents refusal moved after the read fails its entry
  eq(readScan([{ path: "app/api/admin/upsells/route.js", text: "export const GET = async () => NextResponse.json({ ok: true, placements: await listPlacements() });" }]).length, 1, "upsells GET without its refusal:");
  eq(readScan([{ path: "lib/admin/cms-api.js", text: "if (op.kind === \"getPage\") return { status: 200, body: { ok: true, page: await getContentPage(op.slug) } };" }]).length, 1, "cms-api without its documents branch:");
});

// ---- 5. real stores ---------------------------------------------------------------------------
realLog("— 5. real file-database stores");
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("lr");
for (const n of ["lr-docs", "lr-legacy", "lr-closed"]) await F.removeFixtureFiles(n);
await rm(join(ROOT, ".test-lr-default.db"), { force: true });
await F.makePlatform({ name: "lr" });
const R = await import("../lib/registry/index.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const Store = await import("../lib/cms/store.js");
const Tpl = await import("../lib/cms/templates-store.js");
const Mode = await import("../lib/cms-mode.js");
const View = await import("../lib/cms/view.js");
const Insights = await import("../lib/ai/insights.js");
const Onb = await import("../lib/admin/onboarding.js");
const Releases = await import("../lib/releases.js");
const AdminUrl = await import("../lib/admin/shopify-admin-url.js");
const Tree = await import("../components/admin/editor/tree/treeModel.js");
const Sections = await import("../lib/registry/sections.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const Sess = await import("../lib/platform/sessions.js");
const Ident = await import("../lib/platform/identity.js");

const CONFIG = { site: { name: "LR Store" }, site_url: "https://lr.test", shopify_store_domain: "lr-store.myshopify.com" };
const docs = await F.makeTenant({ name: "lr-docs", id: "lrdocs", products: 3, config: CONFIG });
const legacy = await F.makeTenant({ name: "lr-legacy", id: "lrlegacy", products: 3, config: CONFIG });
const closed = await F.makeTenant({ name: "lr-closed", id: "lrclosed", products: 1, config: CONFIG });
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const setMode = (fx, mode) => raw(fx).execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] });
const ownerU = await Ident.createUser({ email: "owner@lr.test", name: "Asha Rao", password: "owner-pass-legacy-routes" });
for (const fx of [docs, legacy, closed]) await Ident.addMembership(ownerU.id, fx.id, "owner");
const OWNER = (await Sess.createSession({ userId: ownerU.id, kind: "merchant", ttlMs: 600_000 })).token;
const ACTOR = { kind: "merchant", id: ownerU.id };
const req = (fx, body, url = `http://${fx.id}.test/api/admin/x`) => ({
  url,
  cookies: { get: (n) => (n === "_admin" ? { value: OWNER } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (fx, body) => fx.run(() => handleDocumentsPut(req(fx, body)));
const route = async (fx, path, method, { body, query = "", params } = {}) => {
  const mod = await import(`../app/api/admin/${path}/route.js`);
  const res = await fx.run(() => mod[method](req(fx, body, `http://${fx.id}.test/api/admin/${path}${query}`), params ? { params: Promise.resolve(params) } : undefined));
  return { status: res.status, body: await res.json() };
};
const get = (fx, id) => fx.run(() => Docs.getDocument(id));
async function publish(fx, ids) {
  const items = [];
  for (const id of ids) {
    const d = await get(fx, id);
    items.push({ id, revision: d.revision, draftHash: d.draftHash });
  }
  return fx.run(() => Pub.publish({ ids: items, actor: ACTOR }));
}
const sec = (kind, id, settings = {}) => {
  const s = R.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings } };
};
const routeBody = (type, slug, title, sections) => {
  const b = R.emptyBody(type);
  return { ...b, meta: { ...b.meta, slug, title }, sections };
};
const homeBody = (title) => ({ ...R.emptyBody("home"), sections: [sec("hero", "sec_hero", { title })] });

// The legacy store: old content written while legacy, as today.
const PROD = (n) => `gid://shopify/Product/${9100 + n}`;
await legacy.run(async () => {
  await Store.setBlock("hero", { title: "Legacy hero", subtitle: "Old words" });
  await Store.setBlock("surface_templates", { pdp: "editorial" });
  await Store.upsertContentPage({ slug: "privacy", title: "Privacy", sections: [{ kind: "text", heading: "P", body: ["x"] }] });
  await Store.upsertContentPage({ slug: "terms", title: "Terms", sections: [{ kind: "text", heading: "T", body: ["y"] }] });
});
// The documents store: old content written while it was legacy (now frozen),
// then documents published over it.
await docs.run(async () => {
  await Store.setBlock("hero", { title: "FROZEN hero", subtitle: "frozen" });
  await Store.setBlock("surface_templates", { pdp: "editorial", pdp_entities: { [PROD(1)]: "editorial" } });
  await Store.upsertContentPage({ slug: "privacy", title: "FROZEN privacy", sections: [{ kind: "text", heading: "P", body: ["x"] }] });
  await Store.upsertContentPage({ slug: "terms", title: "FROZEN terms", sections: [{ kind: "text", heading: "T", body: ["y"] }] });
  await Tpl.saveTemplate({ name: "Size guide", family: "page", sections: [{ kind: "text", heading: "Sizes", body: ["S M L"] }, { kind: "rich", heading: "Care", html: "<p>Wash cold</p>" }, { kind: "faq", heading: "Q", items: [{ q: "Fit?", a: "True to size" }] }] });
  await Tpl.saveTemplate({ name: "Launch", family: "campaign", sections: [{ kind: "text", heading: "New", body: ["Out now"] }] });
});
await sql(docs, "UPDATE cms_templates SET sections = ? WHERE name = 'Launch'", [JSON.stringify([{ kind: "text", heading: "New", body: ["Out now"] }, { kind: "countdown", heading: "Ends soon", ends: "2026-12-01", note: "<b>Hurry</b>" }])]);
await setMode(docs, "documents");
await setMode(closed, "documents");
const home = await docs.run(() => Docs.createDocument({ type: "home", body: homeBody("Published hero"), actor: ACTOR }));
await publish(docs, [home.document.id]);
// a later draft that is NOT published: never what the readers show
const h1 = await get(docs, "doc_home");
await docs.run(() => Docs.saveDraft({ id: "doc_home", revision: h1.revision, body: homeBody("DRAFT hero"), actor: ACTOR }));

await t("readers: AI insights' hero fact is the published home's on a documents store (never the frozen block or a draft), none on a closed store, and the hero block on legacy", async () => {
  const heroFact = async (fx) => (await fx.run(() => Insights.gatherTenantFacts())).find((f) => f.kind === "content")?.text ?? null;
  eq(await heroFact(docs), 'current hero: title "Published hero", subtitle "Browse the full catalog and check out in a few easy steps."', "documents:");
  eq(await heroFact(closed), null, "closed:");
  eq(await heroFact(legacy), 'current hero: title "Legacy hero", subtitle "Old words"', "legacy:");
});

await t("readers: cms/view is the published documents on a documents store (no frozen block, no draft, no revisions) and the legacy blocks on legacy", async () => {
  const v = await docs.run(() => View.storefrontView());
  eq([v.documents, v.blocks.hero?.title, v.revisions.hero, v.customized.hero], [true, "Published hero", null, false], "documents:");
  ok(!JSON.stringify(v).includes("FROZEN") && !JSON.stringify(v).includes("DRAFT"), "frozen or draft content in the documents view");
  const l = await legacy.run(() => View.storefrontView());
  eq([l.documents, l.blocks.hero.title, l.customized.hero, typeof l.revisions.hero], [undefined, "Legacy hero", true, "number"], "legacy:");
  eq(l.pages.map((p) => p.slug), ["privacy", "terms"], "legacy pages:");
});

await t("readers + links: onboarding's legal-pages step reads the published page documents on a documents store (not the frozen pages), and its steps link to editor destinations; legacy is unchanged", async () => {
  const items = async (fx) => (await fx.run(() => Onb.buildChecklist())).items;
  const before = await items(docs);
  eq(before.find((i) => i.id === "policies").done, false, "frozen privacy and terms don't count:");
  const hrefs = Object.fromEntries(before.map((i) => [i.id, i.href]));
  eq([hrefs.policies, hrefs.preview, hrefs.launch, hrefs.brand], ["/admin/editor?list=pages", "/admin/editor", "/admin/editor?doc=doc_home", "/admin/editor?doc=doc_design"], "editor destinations:");
  for (const i of before) ok(!forbidden(i.href) && !i.href.startsWith("/admin/theme"), `${i.id}: ${i.href}`);
  // a draft privacy page is not enough; published privacy and terms are
  const priv = await docs.run(() => Docs.createDocument({ type: "page", body: routeBody("page", "privacy", "Privacy", [sec("text", "sec_p1", { title: "Privacy", body: ["We keep little."] })]), actor: ACTOR }));
  const terms = await docs.run(() => Docs.createDocument({ type: "page", body: routeBody("page", "terms", "Terms", [sec("text", "sec_t1", { title: "Terms", body: ["Be kind."] })]), actor: ACTOR }));
  eq((await items(docs)).find((i) => i.id === "policies").done, false, "drafts only:");
  await publish(docs, [priv.document.id, terms.document.id]);
  eq((await items(docs)).find((i) => i.id === "policies").done, true, "published:");
  // legacy: exactly today's links and the old pages decide the step
  const l = await items(legacy);
  eq(
    l.map((i) => [i.id, i.href]),
    [
      ["connect", "/admin/integrations"],
      ["catalog", "/admin/settings#catalog-sync"],
      ["brand", "/admin/theme"],
      ["policies", "/admin/storefront"],
      ["billing", "/admin/billing"],
      ["domain", "/admin/settings"],
      ["preview", "/admin/storefront"],
      ["test_order", "/checkout"],
      ["launch", "/admin/releases"],
    ],
    "legacy links:",
  );
  eq([l.find((i) => i.id === "policies").done, l.find((i) => i.id === "policies").hint, l.find((i) => i.id === "launch").hint], [true, "Privacy + terms/refund — templates scaffold them; checkout links them.", "Unlocks when everything above is done."], "legacy step:");
});

await t("catalog route: GET answers 200 on a documents store with the template from the live rows (never the frozen block), and the legacy block on legacy; it uses the shared shopifyAdminBase", async () => {
  // a live row for product 2 picks "editorial"; product 1's frozen pick is ignored
  await sql(docs, "INSERT INTO product_content_live (product_id, document_id, version_id, layout_template, badge, modules, published_at) VALUES (?, 'doc_prod_x', 'ver_x', 'editorial', 'Hot', ?, '2026-11-01')", [PROD(2), JSON.stringify([{ title: "Care", html: "<p>Wash</p>" }])]);
  const one = await route(docs, "catalog", "GET", { query: `?product=${encodeURIComponent(PROD(1))}` });
  eq([one.status, one.body.surface, one.body.override], [200, { template: "classic", source: "platform" }, { modules: [], badge: "" }], "documents, product 1:");
  const two = await route(docs, "catalog", "GET", { query: `?product=${encodeURIComponent(PROD(2))}` });
  eq([two.status, two.body.surface, two.body.override.badge, two.body.override.modules.length], [200, { template: "editorial", source: "entity" }, "Hot", 1], "documents, product 2:");
  eq(two.body.product.shopify_url, "https://admin.shopify.com/store/lr-store/products/9102", "shopify url:");
  const list = await route(docs, "catalog", "GET");
  eq([list.status, list.body.overrides, list.body.products.filter((p) => p.customized).map((p) => p.id)], [200, [], [PROD(2)]], "documents list:");
  const shared = await docs.run(() => AdminUrl.shopifyAdminBase());
  eq([list.body.shopify_admin, shared], ["https://admin.shopify.com/store/lr-store", "https://admin.shopify.com/store/lr-store"], "shopify_admin:");
  const lg = await route(legacy, "catalog", "GET", { query: `?product=${encodeURIComponent(PROD(1))}` });
  eq([lg.status, lg.body.surface], [200, { template: "editorial", source: "family" }], "legacy:");
  ok(lg.body.product.shopify_url === `https://admin.shopify.com/store/lr-store/products/${9101}`, `legacy url: ${lg.body.product.shopify_url}`);
  const src = await readFile(join(ROOT, "app/api/admin/catalog/route.js"), "utf8");
  ok(/import \{ shopifyAdminBase \} from "@\/lib\/admin\/shopify-admin-url"/.test(src) && !/const shopifyAdminBase\s*=/.test(src) && !src.includes("tenantOwnCfg"), "the route still has its own shopifyAdminBase");
});

await t("P4-FIX4: catalog route: the documents-store list's pins come from the live collection rows (live wins over a frozen collection_overrides row; a frozen-only pin is not counted)", async () => {
  const C = (n) => `gid://shopify/Collection/77${n}`;
  for (const [n, handle] of [[1, "frozen-only"], [2, "live-only"], [3, "both"]]) await sql(docs, "INSERT INTO collections (id, handle, title) VALUES (?, ?, ?)", [C(n), handle, `Col ${handle}`]);
  await sql(docs, "INSERT INTO collection_overrides (collection_id, pinned, updated_at) VALUES (?, ?, '2026-10-01'), (?, ?, '2026-10-01')", [C(1), JSON.stringify([PROD(1), PROD(2)]), C(3), JSON.stringify([PROD(1), PROD(2), PROD(3)])]);
  await sql(docs, "INSERT INTO collection_content_live (collection_id, document_id, version_id, pinned, published_at) VALUES (?, 'doc_coll_a', 'ver_a', ?, '2026-11-01'), (?, 'doc_coll_b', 'ver_b', ?, '2026-11-01')", [C(2), JSON.stringify([PROD(3)]), C(3), JSON.stringify([PROD(2)])]);
  const list = await route(docs, "catalog", "GET");
  eq(list.status, 200, "status:");
  const pins = Object.fromEntries(list.body.collections.map((c) => [c.handle, c.pinned]));
  eq([pins["frozen-only"], pins["live-only"], pins.both], [0, 1, 1], "pins (frozen-only, live-only, both):");
  eq(list.body.published, undefined, "a readable release gives no notice:");
  // legacy reads the old table, as before
  await sql(legacy, "INSERT INTO collections (id, handle, title) VALUES (?, 'legacy-col', 'Legacy col')", [C(9)]);
  await sql(legacy, "INSERT INTO collection_overrides (collection_id, pinned, updated_at) VALUES (?, ?, '2026-10-01')", [C(9), JSON.stringify([PROD(1), PROD(2)])]);
  const lg = await route(legacy, "catalog", "GET");
  eq(lg.body.collections.find((c) => c.handle === "legacy-col")?.pinned, 2, "legacy pins:");
});

await t("P4-FIX4: catalog route: when the live release can't be read, the product and collection picker list still answers (the catalog with no overlays, never the frozen tables), with a plain note, and it is logged", async () => {
  const [{ live_release_id: liveId }] = await sql(docs, "SELECT live_release_id FROM release_state WHERE id = 1");
  ok(liveId, "the documents store has a live release");
  const [{ content }] = await sql(docs, "SELECT content FROM releases WHERE id = ?", [liveId]);
  const NOTE = "We couldn't read what's published right now, so modules, badges, templates and pinned products aren't shown here. The products themselves are listed.";
  await sql(docs, "UPDATE releases SET content = ? WHERE id = ?", ["{not json", liveId]);
  try {
    const since = SLOGS.length;
    const list = await route(docs, "catalog", "GET");
    eq(list.status, 200, `the list answers: ${JSON.stringify(list.body).slice(0, 200)}`);
    eq(list.body.products.length, 3, "products:");
    eq(list.body.products.filter((p) => p.customized).length, 0, "no overlays (customized):");
    eq(list.body.collections.map((c) => c.pinned), list.body.collections.map(() => 0), "no overlays (pins), never the frozen ones:");
    eq([list.body.overrides, list.body.published, list.body.note], [[], "unavailable", NOTE], "the notice:");
    ok(logged("catalog_published_unreadable", since).some((l) => l.part === "release" && /not valid JSON/.test(l.detail)), `logged: ${JSON.stringify(SLOGS.slice(since))}`);
    // one product, too
    const one = await route(docs, "catalog", "GET", { query: `?product=${encodeURIComponent(PROD(2))}` });
    eq([one.status, one.body.product.id, one.body.override, one.body.surface, one.body.published], [200, PROD(2), { modules: [], badge: "" }, null, "unavailable"], "one product:");
  } finally {
    await sql(docs, "UPDATE releases SET content = ? WHERE id = ?", [content, liveId]);
  }
  // a live-row read that fails (the release reads, a live table doesn't): the same
  // (a view that fails on every row, not "no such table", which reads as no row)
  await sql(docs, "ALTER TABLE collection_content_live RENAME TO collection_content_live_hidden");
  await sql(docs, "CREATE VIEW collection_content_live AS SELECT json_extract('{not json', '$') AS collection_id, document_id, version_id, pinned, layout_document_id, published_at, layout_template FROM collection_content_live_hidden");
  try {
    const since = SLOGS.length;
    const list = await route(docs, "catalog", "GET");
    eq([list.status, list.body.published, list.body.products.length], [200, "unavailable", 3], "a failing live-row read:");
    ok(logged("catalog_published_unreadable", since).some((l) => l.part === "list"), "logged (list)");
  } finally {
    await sql(docs, "DROP VIEW collection_content_live");
    await sql(docs, "ALTER TABLE collection_content_live_hidden RENAME TO collection_content_live");
  }
  // and back to normal
  const again = await route(docs, "catalog", "GET");
  eq([again.status, again.body.published, again.body.products.filter((p) => p.customized).map((p) => p.id)], [200, undefined, [PROD(2)]], "restored:");
});

await t("P4-FIX4: upsells GET never reads the frozen placements on a documents store (409, plain words, even with the table gone); legacy and migrating list as before", async () => {
  await sql(docs, "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position) VALUES ('pl_frozen', 'pdp_pairs', ?, ?, 'FROZEN pairs', 1, 0)", [PROD(1), JSON.stringify([PROD(2)])]);
  const WORDS = "This store now uses the new editor, so its upsells are there: a product's pairs on that product, and the cart's offer in the cart. Open them in the editor.";
  const r = await route(docs, "upsells", "GET");
  eq([r.status, r.body.code, r.body.error, r.body.placements], [409, "STORE_USES_DOCUMENTS", WORDS, undefined], "documents:");
  ok(!JSON.stringify(r.body).includes("FROZEN"), "frozen content in the answer");
  // proof it reads nothing: with the table renamed away the answer is the same
  await sql(docs, "ALTER TABLE placements RENAME TO placements_hidden");
  try {
    const gone = await route(docs, "upsells", "GET");
    eq([gone.status, gone.body.code], [409, "STORE_USES_DOCUMENTS"], "documents, table gone:");
  } finally {
    await sql(docs, "ALTER TABLE placements_hidden RENAME TO placements");
  }
  const lg = await route(legacy, "upsells", "GET");
  eq([lg.status, Array.isArray(lg.body.placements)], [200, true], "legacy:");
  await setMode(legacy, "migrating");
  try {
    const mg = await route(legacy, "upsells", "GET");
    eq([mg.status, Array.isArray(mg.body.placements)], [200, true], "migrating:");
  } finally {
    await setMode(legacy, "legacy");
  }
});

await t("P4-FIX4: cms-api's page and history reads never read the frozen tables on a documents store (the published page, no history, even with the tables gone); legacy answers as before; templates stay readable", async () => {
  const { handleStorefrontPut, HISTORY_IN_EDITOR } = await import("../lib/admin/cms-api.js");
  const put = (fx, body) => fx.run(() => handleStorefrontPut(req(fx, body)));
  const frozen = (await sql(docs, "SELECT title FROM cms_pages WHERE slug = 'privacy'"))[0]?.title;
  eq(frozen, "FROZEN privacy", "the frozen row is there:");
  const check = async (label) => {
    const page = await put(docs, { getPage: "privacy" });
    eq([page.status, page.body.page?.title, page.body.documents], [200, "Privacy", true], `${label} getPage (the published page document):`);
    ok(!JSON.stringify(page.body).includes("FROZEN"), `${label}: frozen page in the answer`);
    const hist = await put(docs, { history: { kind: "page", key: "privacy" } });
    eq([hist.status, hist.body.history, hist.body.note], [200, [], HISTORY_IN_EDITOR], `${label} history:`);
  };
  await check("documents");
  // proof neither reads the frozen tables: with them renamed away the answers are the same
  await sql(docs, "ALTER TABLE cms_pages RENAME TO cms_pages_hidden");
  await sql(docs, "ALTER TABLE cms_history RENAME TO cms_history_hidden");
  try {
    await check("tables gone");
  } finally {
    await sql(docs, "ALTER TABLE cms_pages_hidden RENAME TO cms_pages");
    await sql(docs, "ALTER TABLE cms_history_hidden RENAME TO cms_history");
  }
  // a store not open yet: no page (never a frozen one)
  const cl = await put(closed, { getPage: "privacy" });
  eq([cl.status, cl.body.page], [200, null], "closed:");
  const tpl = await put(docs, { listTemplates: true });
  eq([tpl.status, tpl.body.templates.length >= 2], [200, true], "templates stay readable:");
  const lp = await put(legacy, { getPage: "privacy" });
  eq([lp.status, lp.body.page?.slug, lp.body.page?.title, lp.body.documents], [200, "privacy", "Privacy", undefined], "legacy getPage:");
  const lh = await put(legacy, { history: { kind: "page", key: "privacy" } });
  eq([lh.status, Array.isArray(lh.body.history), lh.body.note], [200, true, undefined], "legacy history:");
});

await t("P4-FIX4: publishedSource's closed branch: a documents store that never published is 'closed' (not an error), so insights gives no hero fact and logs no failure; a broken release is an error, logged", async () => {
  const src = await closed.run(() => View.publishedSource());
  eq([src.mode, src.releaseId, src.preview], ["closed", null, false], "closed source:");
  const g = await closed.run(() => View.publishedGetters());
  eq(g.closed, true, "getters closed:");
  eq((await docs.run(() => View.publishedGetters())).closed, false, "an open store is not closed:");
  const since = SLOGS.length;
  const facts = await closed.run(() => Insights.gatherTenantFacts());
  eq(facts.find((f) => f.kind === "content") ?? null, null, "no hero fact:");
  eq(logged("insights_hero_unavailable", since).length, 0, `a closed store is not a failure: ${JSON.stringify(SLOGS.slice(since))}`);
  // the error branch, for contrast: a live release that can't be read
  const [{ live_release_id: liveId }] = await sql(docs, "SELECT live_release_id FROM release_state WHERE id = 1");
  const [{ content }] = await sql(docs, "SELECT content FROM releases WHERE id = ?", [liveId]);
  await sql(docs, "UPDATE releases SET content = ? WHERE id = ?", ["{not json", liveId]);
  try {
    let threw = null;
    try {
      await docs.run(() => View.publishedSource());
    } catch (e) {
      threw = e;
    }
    ok(threw && threw.name !== "TypeError", `a broken release throws: ${threw}`);
    const s2 = SLOGS.length;
    const f2 = await docs.run(() => Insights.gatherTenantFacts());
    eq(f2.find((f) => f.kind === "content") ?? null, null, "no hero fact on a broken release:");
    eq(logged("insights_hero_unavailable", s2).length, 1, "logged:");
  } finally {
    await sql(docs, "UPDATE releases SET content = ? WHERE id = ?", [content, liveId]);
  }
});

await t("writes: catalog POST and upsells POST, PUT and DELETE refused by the mode guard inside their batch answer 409 with the plain words (never 422 or 500), and write nothing", async () => {
  const dump = async () => JSON.stringify([await sql(legacy, "SELECT * FROM product_overrides ORDER BY product_id"), await sql(legacy, "SELECT * FROM placements ORDER BY id")]);
  await legacy.run(() => Store.setBlock("announcement", { text: "seed" })); // warm the guard probe
  const pl = await route(legacy, "upsells", "POST", { body: { kind: "pdp_pairs", sourceHandle: "fixture-product-1", targetHandles: ["fixture-product-2"], title: "Pairs" } });
  eq(pl.status, 200, "seed placement:");
  const id = pl.body.id;
  const WORDS = { migrating: Mode.MIGRATING_MESSAGE, documents: Mode.modeAbortError("documents").message };
  for (const mode of ["migrating", "documents"]) {
    const cases = [
      ["catalog POST", () => route(legacy, "catalog", "POST", { body: { product: { handle: "fixture-product-1", modules: [{ title: "M", html: "<p>m</p>" }], badge: "B" } } })],
      ["catalog POST pins", () => route(legacy, "catalog", "POST", { body: { collection: { handle: "nope", pinnedHandles: [] } } })],
      ["upsells POST", () => route(legacy, "upsells", "POST", { body: { kind: "pdp_pairs", sourceHandle: "fixture-product-1", targetHandles: ["fixture-product-3"] } })],
      ["upsells PUT", () => route(legacy, "upsells/[id]", "PUT", { body: { enabled: false }, params: { id } })],
      ["upsells DELETE", () => route(legacy, "upsells/[id]", "DELETE", { params: { id } })],
    ];
    for (const [label, call] of cases) {
      if (label === "catalog POST pins") continue; // an unknown collection is refused (422) before any write
      const before = await dump();
      Mode.__legacyWriteTestHooks.beforeBatch = async () => setMode(legacy, mode);
      let r;
      try {
        r = await call();
      } finally {
        Mode.__legacyWriteTestHooks.beforeBatch = null;
        await setMode(legacy, "legacy");
      }
      eq([r.status, r.body.error, r.body.code], [409, WORDS[mode], "STORE_USES_DOCUMENTS"], `${label} (${mode}):`);
      eq(await dump(), before, `${label} (${mode}) wrote:`);
    }
  }
  // the pre-check answers as before
  await setMode(legacy, "documents");
  const pre = await route(legacy, "catalog", "POST", { body: { product: { handle: "fixture-product-1", modules: [], badge: "" } } });
  await setMode(legacy, "legacy");
  eq([pre.status, pre.body.code], [409, "STORE_USES_DOCUMENTS"], "the pre-check:");
});

await t("saved templates: 'Make a page from this' creates a draft document with fresh ids from a cms_templates row (unknown kinds become text, with a note) and leaves cms_templates unchanged", async () => {
  const dump = async () => JSON.stringify(await sql(docs, "SELECT * FROM cms_templates ORDER BY id"));
  const before = await dump();
  const rows = (await sql(docs, "SELECT id, name, family, sections FROM cms_templates ORDER BY name")).map((r) => ({ ...r, sections: JSON.parse(r.sections) }));
  const fakeFetch = async (_url, init) => {
    const res = await api(docs, JSON.parse(init.body));
    return { ok: res.status < 300, status: res.status, json: async () => res.body, text: async () => JSON.stringify(res.body) };
  };
  const { createDocumentsApi } = await import("../components/admin/editor/documentsApi.js");
  const client = createDocumentsApi({ fetch: fakeFetch });
  const ST = await world({ ...compStubs, "@/components/admin/editor/documentsApi": { createDocumentsApi } })(join(ROOT, "components/admin/SavedTemplates.js"));
  const guide = rows.find((r) => r.name === "Size guide");
  const a = await ST.makePageFromTemplate(client, guide);
  const b = await ST.makePageFromTemplate(client, guide);
  ok(a.ok && b.ok && a.id !== b.id, `made: ${JSON.stringify([a, b])}`);
  eq(a.href, `/admin/editor?doc=${a.id}`, "href:");
  const da = await get(docs, a.id);
  const db2 = await get(docs, b.id);
  eq([da.type, da.publishedVersionId, da.body.meta.title, da.body.meta.slug, da.body.sections.map((s) => s.kind)], ["page", null, "Size guide", "", ["text", "rich_text", "faq"]], "the draft:");
  eq(da.body.sections.map((s) => s.settings.title), ["Sizes", "Care", "Q"], "titles:");
  const idsA = da.body.sections.map((s) => s.id);
  const idsB = db2.body.sections.map((s) => s.id);
  ok(idsA.every((x) => /^sec_[a-z0-9]{2,16}$/.test(x) && !/^sec_l\d+$/.test(x)) && idsA.every((x) => !idsB.includes(x)), `ids not fresh: ${idsA} / ${idsB}`);
  eq(a.notes, [], "notes:");
  const launch = await ST.makePageFromTemplate(client, rows.find((r) => r.name === "Launch"));
  const dl = await get(docs, launch.id);
  eq([dl.type, dl.body.sections.map((s) => s.kind), dl.body.sections[1].settings.title, dl.body.sections[1].settings.body], ["campaign", ["text", "text"], "Ends soon", ["2026-12-01", "Hurry"]], "the unknown kind:");
  eq(launch.notes, ["A section of a kind the editor doesn't have became text. Check its words before you publish."], "its note:");
  eq(await dump(), before, "cms_templates changed:");
  // the server re-validates: a body it can't take is refused, and nothing is made
  const count = (await sql(docs, "SELECT count(*) AS n FROM documents"))[0].n;
  const bad = await ST.makePageFromTemplate({ call: async (op, args) => client.call(op, { ...args, body: { ...args.body, sections: [{ id: "sec_bad", kind: "nope", v: 1, settings: {} }] } }) }, guide);
  ok(!bad.ok && typeof bad.message === "string" && !/[A-Z_]{6,}/.test(bad.message), `bad: ${JSON.stringify(bad)}`);
  eq((await sql(docs, "SELECT count(*) AS n FROM documents"))[0].n, count, "a refused body made a document:");
  // on a legacy store the API refuses (the page itself shows only a note there)
  const lclient = createDocumentsApi({ fetch: async (_u, init) => {
    const res = await api(legacy, JSON.parse(init.body));
    return { ok: res.status < 300, status: res.status, json: async () => res.body, text: async () => "" };
  } });
  const lr = await ST.makePageFromTemplate(lclient, guide);
  ok(!lr.ok && /current Storefront editor|still uses/.test(lr.message), `legacy: ${JSON.stringify(lr)}`);
});

// D2: banners on page, campaign and journal documents.
const ROUTE_TYPES = ["page", "campaign", "journal"];
await t("D2: a page, campaign or journal document no longer offers the banner (add list, add, copy); home and the layouts still do", () => {
  for (const type of ROUTE_TYPES) {
    ok(R.allowedKinds(type).includes("banner"), `${type}: the banner must stay allowed, so old ones load and save`);
    const opts = Tree.addOptions(type, [], 0);
    ok(opts.length > 3 && !opts.some((o) => o.kind === "banner"), `${type}: offered ${opts.map((o) => o.kind)}`);
    const r = Tree.add([], "banner", 0, { type });
    eq([r.ok, r.code, r.message], [false, "KIND_NOT_OFFERED", "Banners don't show on this kind of page yet. Add a text section instead."], `${type} add:`);
    const c = Tree.duplicate([sec("banner", "sec_b1", { title: "Old" })], "sec_b1", { type });
    eq([c.ok, c.code], [false, "KIND_NOT_OFFERED"], `${type} copy:`);
    ok(Tree.add([], "text", 0, { type }).ok, `${type}: text can't be added`);
  }
  for (const type of ["home", "product_layout", "collection_layout"]) {
    ok(Tree.addOptions(type, R.emptyBody(type).sections, 0).some((o) => o.kind === "banner"), `${type}: banner no longer offered`);
  }
  eq(Sections.NOT_SHOWN_MESSAGE, "Banners don't show on this kind of page yet.", "words:");
});

// The storefront routes, rendered over the published documents (lib/ real,
// app/ and components/ compiled). tfetch runs in the store's scope.
let routeFx = docs;
const shopLoad = world({
  "next/navigation": nav,
  "next/link": linkStub,
  "@/lib/tenant-request": { tfetch: (fn) => routeFx.run(fn) },
});
async function renderRoute(fx, file, slug) {
  routeFx = fx;
  const Page = (await shopLoad(join(ROOT, "app/(storefront)", file))).default;
  try {
    return { html: renderToStaticMarkup(await Page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) })) };
  } catch (e) {
    if (e instanceof NotFound) return { notFound: true };
    if (e instanceof Redirect) return { redirect: e.to };
    throw e;
  }
}
const ROUTE_FILE = { page: "policies/[slug]/page.js", campaign: "campaigns/[slug]/page.js", journal: "journal/[slug]/page.js" };

await t("D2: an existing banner on a page, campaign and journal post saves and publishes with the inherited note; each route renders without error and shows no banner, so the note matches what it shows", async () => {
  for (const type of ROUTE_TYPES) {
    const slug = `d2-${type}`;
    const body = routeBody(type, slug, `D2 ${type}`, [sec("banner", "sec_ban", { title: `BANNER-${type}-TITLE`, text: "Banner words" }), sec("text", "sec_txt", { title: `Visible ${type}`, body: ["Shown text"] })]);
    const made = await docs.run(() => Docs.createDocument({ type, body, actor: ACTOR }));
    const note = made.issues.filter((i) => i.code === "SECTION_NOT_SHOWN");
    eq(note.map((i) => [i.sectionId, i.severity, i.message]), [["sec_ban", "warning", "Banners don't show on this kind of page yet."]], `${type} create:`);
    // a later save through the API keeps it, with the note
    const d = await get(docs, made.document.id);
    const saved = await api(docs, { saveDraft: { id: d.id, body: { ...d.body, meta: { ...d.body.meta, description: "saved again" } } }, revision: d.revision });
    eq(saved.status, 200, `${type} save:`);
    eq(saved.body.issues.filter((i) => i.code === "SECTION_NOT_SHOWN").map((i) => i.message), ["Banners don't show on this kind of page yet."], `${type} save note:`);
    const after = await get(docs, d.id);
    ok(after.body.sections.some((s) => s.kind === "banner" && s.settings.title === `BANNER-${type}-TITLE`), `${type}: the banner was dropped`);
    const p = await publish(docs, [d.id]);
    ok(p.published.length === 1, `${type}: not published ${JSON.stringify(p)}`);
    const pn = p.issues.filter((i) => i.code === "SECTION_NOT_SHOWN");
    eq(pn.map((i) => [i.level, i.sectionId, i.message, i.actions.map((a) => a.type)]), [["inherited", "sec_ban", "Banners don't show on this kind of page yet.", ["removeSection"]]], `${type} publish note:`);
    const r = await renderRoute(docs, ROUTE_FILE[type], slug);
    ok(r.html, `${type}: ${JSON.stringify(r)}`);
    ok(r.html.includes(`Visible ${type}`) && r.html.includes("Shown text"), `${type}: the page's own text is missing`);
    const shown = r.html.includes(`BANNER-${type}-TITLE`) || r.html.includes("Banner words");
    eq(shown, false, `${type}: the route shows the banner, so the note would be wrong:`);
  }
});

await t("D2: a page with no banner gets no note; a hidden banner still gets it (it can't show when shown again)", async () => {
  const plain = await docs.run(() => Docs.createDocument({ type: "page", body: routeBody("page", "d2-plain", "Plain", [sec("text", "sec_a", { title: "A", body: ["b"] })]), actor: ACTOR }));
  eq(plain.issues.filter((i) => i.code === "SECTION_NOT_SHOWN"), [], "plain:");
  const hidden = await docs.run(() => Docs.createDocument({ type: "journal", body: routeBody("journal", "d2-hidden", "Hidden", [{ ...sec("banner", "sec_hb", { title: "H" }), enabled: false }, sec("text", "sec_t", { title: "T", body: ["t"] })]), actor: ACTOR }));
  eq(hidden.issues.filter((i) => i.code === "SECTION_NOT_SHOWN").length, 1, "hidden:");
  const homeNotes = Sections.notShownNotes({ type: "home", sections: [sec("banner", "sec_h1", { title: "x" })] });
  eq(homeNotes, [], "home:");
});

// ---- the end ----------------------------------------------------------------------------
for (const c of raws.values()) c.close();
for (const fx of [docs, legacy, closed]) await fx.cleanup().catch(() => {});
await F.removeFixtureFiles("lr");
await rm(join(ROOT, ".test-lr-default.db"), { force: true });
realLog(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
