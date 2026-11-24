// P3-ROUTES suite (ED-02, PUB-11, PV-01): the new editor's address, the old
// screens that send a documents store to it, the console nav, and the
// Designer's failed-preview message.
//   1. unit: lib/admin/editor-entry.js, which document ?doc= or ?path= opens,
//      round-tripped against lib/documents/paths.js livePath();
//   2. rendered: the real page modules (app/(console)/admin/(authed)/...),
//      compiled with Next's own SWC and called as server components with
//      their data stubbed: /admin/editor in each mode, and each old screen's
//      redirect (documents only) or its unchanged render (legacy, migrating);
//   3. rendered: the console shell (components/admin/shell, Phase 0 line 8)
//      and its nav: the editor link, staff filtering, the badge, the editor
//      route's sheet (P6-NAV: "Logo and colours" after Editor);
//   4. rendered + behaviour: the Designer with a stubbed api, its candidate
//      push failing in each way, through stand-in hooks (no browser).
// No browser drill covers these routes since the Phase 0 drills line (the p3
// drills were retired); the editor is driven in pnpm drill:p5 and drill:p6.
//   pnpm test:editor-routes
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack || e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};

// ---- 1. unit: editor-entry ------------------------------------------------------
console.log("— which document the editor opens (lib/admin/editor-entry.js)");
const E = await import("../lib/admin/editor-entry.js");
const { livePath } = await import("../lib/documents/paths.js");

const DOCS = [
  { id: "doc_home", type: "home", slug: null, label: "Home page" },
  { id: "doc_header", type: "header", slug: null, label: "Header menu" },
  { id: "doc_aaaaaaaaaaaaaaaa", type: "page", slug: "about", label: "About us" },
  { id: "doc_bbbbbbbbbbbbbbbb", type: "page", slug: "contact", label: "Contact" },
  { id: "doc_cccccccccccccccc", type: "page", slug: "x", label: "Policy X" },
  { id: "doc_dddddddddddddddd", type: "campaign", slug: "x", label: "Campaign X" },
  { id: "doc_eeeeeeeeeeeeeeee", type: "journal", slug: "x", label: "Journal X" },
  { id: "doc_ffffffffffffffff", type: "page", slug: "size guide", label: "Size guide" },
  { id: "doc_gggggggggggggggg", type: "campaign", slug: "spring-edit", label: "Spring edit" },
];
const open = (q, docs = DOCS) => E.editorEntry(q, docs);

await t("unit: each listed path opens its document", () => {
  const cases = [
    ["/", "doc_home"],
    ["/about", "doc_aaaaaaaaaaaaaaaa"],
    ["/contact", "doc_bbbbbbbbbbbbbbbb"],
    ["/policies/x", "doc_cccccccccccccccc"],
    ["/campaigns/x", "doc_dddddddddddddddd"],
    ["/journal/x", "doc_eeeeeeeeeeeeeeee"],
  ];
  for (const [path, id] of cases) {
    const r = open({ path });
    eq([r.document.id, r.note], [id, null], `${path}:`);
  }
  // the same slug under three types never crosses over
  ok(new Set(cases.slice(3).map(([p]) => open({ path: p }).document.id)).size === 3, "x opened the same document under two types");
});

await t("unit: an unknown path opens home with a note that names the path", () => {
  for (const path of ["/nowhere", "/campaigns/missing", "/journal/missing", "/policies/a/b", "/About"]) {
    const r = open({ path });
    eq(r.document.id, "doc_home", `${path}:`);
    ok(typeof r.note === "string" && r.note.includes("home page") && r.note.includes(path.replace(/\/$/, "") || "/"), `${path}: note ${r.note}`);
  }
  const bad = open({ path: "https://evil.example/about" });
  ok(bad.document.id === "doc_home" && bad.note && !bad.note.includes("evil"), `an off-site address: ${JSON.stringify(bad)}`);
});

await t("P3-FIX3 unit: 'Edit this page' on a product or collection opens its layout; no store route with real data says 'Nothing on your store lives at'", async () => {
  const { readdir } = await import("node:fs/promises");
  const p = open({ path: "/products/whey-protein?variant=1" });
  eq([p.document.id, p.document.type, p.note], ["doc_product_layout", "product_layout", E.NOTES.productLayout], "/products/x:");
  const c = open({ path: "/collections/protein/" });
  eq([c.document.id, c.document.type, c.note], ["doc_collection_layout", "collection_layout", E.NOTES.collectionLayout], "/collections/x:");
  eq([open({ path: "/collections" }).document.id, open({ path: "/collections" }).note], ["doc_collections_index", null], "/collections:");
  // a row, when the store has one, is used as it is
  eq(open({ path: "/products/x" }, [...DOCS, { id: "doc_product_layout", type: "product_layout", slug: null, label: "My layout" }]).document.label, "My layout", "the row:");
  for (const path of ["/journal", "/journal/", "/campaigns", "/search", "/search?q=whey", "/cart", "/checkout", "/account/orders", "/wishlist", "/policies"]) {
    const r = open({ path });
    eq([r.document.id, r.note], ["doc_home", E.NOTES.storeData], `${path}:`);
  }
  // /about and /contact before their page exists: the store's own words, not "nothing"
  eq(open({ path: "/about" }, DOCS.filter((d) => d.slug !== "about")).note, E.NOTES.storeData, "/about with no page yet:");
  // every storefront route folder is placed: a document route or a store route
  const folders = (await readdir(join(ROOT, "app/(storefront)"), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("[") && !d.name.startsWith("(")).map((d) => d.name);
  ok(folders.length > 10, `folders: ${folders}`);
  for (const f of folders) {
    ok(E.STORE_ROUTES.has(f), `the storefront route /${f} is in STORE_ROUTES`);
    for (const path of [`/${f}`, `/${f}/x`]) {
      const note = open({ path }).note || "";
      const isDocPage = ["policies", "campaigns", "journal"].includes(f) && path !== `/${f}`;
      ok(isDocPage || !note.includes("Nothing on your store lives at"), `${path}: ${note}`);
    }
  }
  // a page, campaign or post that isn't there is still "nothing"
  ok(open({ path: "/campaigns/missing" }).note.includes("Nothing on your store lives at /campaigns/missing"), "a missing campaign");
});

await t("unit: every document with an address round-trips: livePath(doc) opens that doc", () => {
  let n = 0;
  for (const d of DOCS) {
    const path = livePath(d.type, { slug: d.slug });
    const r = open({ path });
    if (d.type === "header") {
      eq(r.document.id, "doc_home", "a singleton with no address of its own lives at / (home):");
      continue;
    }
    eq([r.document.id, r.note], [d.id, null], `${d.label} at ${path}:`);
    n++;
  }
  ok(n === DOCS.length - 1, `round-tripped ${n}`);
  // and the reverse: what a path places, livePath gives back
  for (const path of ["/", "/about", "/contact", "/policies/x", "/campaigns/x", "/journal/x", "/policies/size%20guide"]) {
    const p = E.placePath(path);
    eq(livePath(p.type, { slug: p.slug }), path, `placePath(${path}) back through livePath:`);
  }
});

await t("unit: ?doc= opens that id; a singleton opens before its row exists; an unknown id opens home with a note", () => {
  eq(open({ doc: "doc_dddddddddddddddd" }).document, { id: "doc_dddddddddddddddd", type: "campaign", label: "Campaign X", slug: "x" }, "a listed id:");
  const design = open({ doc: "doc_design" });
  eq([design.document.id, design.document.type, design.document.label, design.note], ["doc_design", "design", "Brand", null], "doc_design with no row:");
  const gone = open({ doc: "doc_zzzzzzzzzzzzzzzz" });
  eq([gone.document.id, gone.note], ["doc_home", E.NOTES.missingDoc], "an id that isn't there:");
  eq(open({ doc: "doc_nosuchtype" }).document.id, "doc_home", "doc_<unregistered>:");
  eq(open({}).document.id, "doc_home", "no query:");
  eq(open({}, []).document, { id: "doc_home", type: "home", label: "Home page", slug: null }, "a store with no rows yet:");
  eq(open({ doc: ["doc_header", "doc_home"] }).document.id, "doc_header", "a repeated ?doc= takes the first:");
  eq(open({ path: "/campaigns/spring-edit?utm=x#top" }).document.id, "doc_gggggggggggggggg", "query and hash are ignored:");
  eq(open({ path: "/campaigns/spring-edit/" }).document.id, "doc_gggggggggggggggg", "a trailing slash:");
});

await t("unit: every old screen sends a documents store to a real editor address", () => {
  // P4-ED05 adds the product and collection designers and the upsells screen
  eq(
    Object.keys(E.LEGACY_ROUTE_DOCS).sort(),
    ["/admin/brand", "/admin/storefront", "/admin/storefront/designer", "/admin/storefront/home", "/admin/storefront/navigation", "/admin/storefront/pages", "/admin/storefront/product-pages", "/admin/theme", "/admin/storefront/designer/product", "/admin/storefront/designer/collection", "/admin/upsells"].sort(),
    "routes:",
  );
  eq(E.LEGACY_ROUTE_DOCS["/admin/brand"], "doc_design", "brand:");
  eq(E.LEGACY_ROUTE_DOCS["/admin/theme"], "doc_design", "theme:");
  for (const [route, id] of Object.entries(E.LEGACY_ROUTE_DOCS)) {
    const r = open({ doc: id }, []);
    ok(r.document.id === id && r.note === null, `${route} -> ${id} would not open: ${JSON.stringify(r)}`);
    eq(E.editorHref(id), `/admin/editor?doc=${id}`, `${route}:`);
  }
});

// ---- the loader -------------------------------------------------------------------
// Each file is compiled with Next's SWC to CommonJS. Relative and "@/" imports
// load the same way, packages come from node_modules, and stubs replace the
// data, the request and the heavy client editors. One world per stub set.
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
  async function load(file, { source, overrides = {} } = {}) {
    const key = source == null && !Object.keys(overrides).length ? file : null;
    if (key && cache.has(key)) return cache.get(key);
    const mod = { exports: {} };
    if (key) cache.set(key, mod.exports);
    const code = await compile(file, source);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in overrides || id in stubs) continue;
      const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
      if (target) local.set(id, await load(target.endsWith(".js") ? target : `${target}.js`));
    }
    new Function("require", "module", "exports", code)(
      (id) => (id in overrides ? overrides[id] : id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)),
      mod,
      mod.exports
    );
    if (key) cache.set(key, mod.exports);
    return mod.exports;
  }
  return load;
}

// ---- 2. rendered: the pages -----------------------------------------------------
console.log("— the editor page and the old screens");
const AUTHED = join(ROOT, "app/(console)/admin/(authed)");
class Redirect extends Error {
  constructor(to) {
    super(`NEXT_REDIRECT ${to}`);
    this.to = to;
  }
}
const S = { mode: "legacy", modeThrows: false, modeReads: 0, docs: DOCS, docsReads: 0, actor: { kind: "member", role: "owner" } };
const marker = (name) => {
  const C = (props) => React.createElement("div", { "data-stub": name, "data-props": JSON.stringify(props ?? {}) });
  return C;
};
const VIEW = {
  blocks: { hero: { title: "Skin first" } },
  customized: { hero: true },
  revisions: { hero: 1 },
  blockMeta: { hero: { updated_at: "2026-10-01T10:00:00.000Z" } },
  pages: [{ slug: "about", title: "About us", family: "policy", source: "custom", enabled: true, updated_at: "2026-10-02T10:00:00.000Z" }],
  pageRevisions: { about: 2 },
};
const pageStubs = {
  "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
  "next/navigation": {
    redirect: (to) => {
      throw new Redirect(to);
    },
    usePathname: () => "/admin/editor",
    useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
  },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/lib/admin-auth": { adminActor: async () => S.actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
  "@/lib/console-request": { tfetch: (fn) => fn() },
  "@/lib/cms-mode": {
    getCmsMode: async () => {
      S.modeReads++;
      if (S.modeThrows) throw Object.assign(new Error("We couldn't check which editor this store uses"), { code: "CMS_MODE_UNAVAILABLE" });
      return S.mode;
    },
  },
  "@/lib/documents/service": {
    listDocuments: async () => {
      S.docsReads++;
      return S.docs;
    },
  },
  "@/lib/admin/editor-entry": E,
  "@/lib/cms/issues": await import("../lib/cms/issues.js"),
  "@/lib/cms/view": { storefrontView: async () => VIEW },
  "@/lib/releases": {
    releaseDiff: async () => ({ items: [], dirty: false, firstPublish: false }),
    getLiveRelease: async () => ({ content_hash: "abcdef0123456789", note: null, content: {} }),
    snapshotContent: async () => ({ content: {} }),
    validateRelease: async () => ({ ok: true, issues: [], errors: [], warnings: [], sections: [] }),
  },
  "@/lib/experiments": { runningTestsBySection: async () => ({ hero: { slug: "t1", name: "Hero test" } }) },
  "@/lib/db": { db: { selectFrom: () => ({ select: () => ({ execute: async () => [{ slug: "about", window_start: null, window_end: null }] }) }) } },
  "@/lib/schema-shape": { notMigratedYet: () => false },
  "@/lib/tenant-context": { currentTenant: () => ({ config: S.config ?? { brand: { accent: "#112233" } } }), tenantOwnCfg: () => ({ kit: "pulse" }) },
  // P6-NAV: the editor page's starting-brand modules (a template-literal
  // import there, so this loader doesn't follow it: given here)
  "@/lib/themes/palettes": await import("../lib/themes/palettes.js"),
  "@/lib/brand": { resolveBrand: (b) => ({ accent: b?.accent || "#000000" }), accentShades: () => ({ 500: "#112233" }), DEFAULT_BRAND: { accent: "#000000" } },
  "@/lib/admin/brand-readability": { brandReadability: async () => ({ warnings: [], notes: [] }) },
  "@/lib/themes/kits": { KITS: { pulse: { id: "pulse", version: 1, label: "Pulse", vertical: "beauty", description: "d", fonts: {}, brand: {}, swatch: [] } }, kitUpgradeAvailable: () => false },
  "@/lib/cms/store": { getBlockRow: async () => ({ value: { pdp: "classic" }, revision: 3 }) },
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

// Calls a page module like Next does: -> { redirect } or { html }.
async function run(file, { mode = "legacy", query = {}, modeThrows = false, source } = {}) {
  Object.assign(S, { mode, modeThrows, modeReads: 0, docsReads: 0 });
  const Page = (await loadPage(join(AUTHED, file), source != null ? { source } : {})).default;
  try {
    const el = await Page({ searchParams: Promise.resolve(query) });
    return { html: renderToStaticMarkup(el), modeReads: S.modeReads, docsReads: S.docsReads };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to, modeReads: S.modeReads };
    throw e;
  }
}

await t("rendered: /admin/editor in documents mode is the editor placeholder at the chosen document", async () => {
  const home = await run("editor/page.js", { mode: "documents" });
  ok(home.html.includes("data-document-editor") && /data-doc="doc_home"/.test(home.html) && home.html.includes(">Home page</h2>"), `home: ${home.html.slice(0, 400)}`);
  ok(home.modeReads === 1 && home.docsReads === 1, `reads: ${JSON.stringify(home)}`);
  const camp = await run("editor/page.js", { mode: "documents", query: { path: "/campaigns/spring-edit" } });
  ok(/data-doc="doc_gggggggggggggggg"/.test(camp.html) && camp.html.includes(">Spring edit</h2>") && !camp.html.includes("couldn"), `?path=: ${camp.html.slice(0, 400)}`);
  const design = await run("editor/page.js", { mode: "documents", query: { doc: "doc_design" } });
  ok(/data-doc="doc_design"/.test(design.html) && design.html.includes(">Brand</h2>"), "?doc=doc_design");
  const lost = await run("editor/page.js", { mode: "documents", query: { path: "/nowhere" } });
  ok(/data-doc="doc_home"/.test(lost.html) && lost.html.includes("Nothing on your store lives at /nowhere yet"), `unknown path: ${lost.html.slice(0, 600)}`);
  ok(!lost.html.includes("data-editor-note"), "the legacy or migrating note shows in documents mode");
});

await t("rendered: /admin/editor in legacy mode is a note linking to the Designer, and reads no documents", async () => {
  const r = await run("editor/page.js", { mode: "legacy", query: { doc: "doc_home" } });
  ok(r.html.includes('data-editor-note="legacy"') && r.html.includes('href="/admin/storefront/designer"'), r.html);
  ok(!r.html.includes("data-document-editor") && r.docsReads === 0, "the editor showed on a legacy store");
});

await t("rendered: /admin/editor in migrating mode is a read-only note: no editor, no link to an editor", async () => {
  for (const mode of ["migrating", "something-else"]) {
    const r = await run("editor/page.js", { mode });
    ok(r.html.includes('data-editor-note="migrating"') && /nothing can be changed/.test(r.html), `${mode}: ${r.html}`);
    ok(!r.html.includes("data-document-editor") && !r.html.includes("<a ") && !r.html.includes("<button") && r.docsReads === 0, `${mode}: something to edit with`);
  }
});

await t("rendered: /admin/editor reads the mode on every request (never cached)", async () => {
  const a = await run("editor/page.js", { mode: "legacy" });
  const b = await run("editor/page.js", { mode: "documents" });
  ok(a.html.includes('data-editor-note="legacy"') && b.html.includes("data-document-editor") && a.modeReads === 1 && b.modeReads === 1, "the second request saw the first one's mode");
  const src = await readFile(join(AUTHED, "editor/page.js"), "utf8");
  ok(/export const runtime = "nodejs"/.test(src) && /export const dynamic = "force-dynamic"/.test(src), "editor page must be nodejs and dynamic");
});

await t("rendered: /admin/editor with a mode that can't be read is an error, never a guess", async () => {
  let threw = null;
  try {
    await run("editor/page.js", { modeThrows: true });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "CMS_MODE_UNAVAILABLE", `no error: ${threw}`);
});

// P6-NAV (owner answer OQ-P6-8): the editor page hands DocumentEditor the
// store's starting palette brand (startingPaletteId of the tenant's
// config.onboarding), read from the tenant already in context: no extra mode
// read and no extra documents read. DocumentEditor is a marker here, so its
// props can be read.
const Palettes = await import("../lib/themes/palettes.js");
async function runEditorWith(config, { mode = "documents", query = {}, overrides = {} } = {}) {
  Object.assign(S, { mode, modeThrows: false, modeReads: 0, docsReads: 0, config });
  try {
    // (descriptors copied, so an override that throws when read stays a getter)
    const ov = Object.defineProperties({ "@/components/admin/editor/DocumentEditor": { __esModule: true, default: marker("DocumentEditor") } }, Object.getOwnPropertyDescriptors(overrides));
    const Page = (await loadPage(join(AUTHED, "editor/page.js"), { overrides: ov })).default;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
    const m = /data-stub="DocumentEditor" data-props="([^"]*)"/.exec(html);
    const props = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x27;/g, "'")) : null;
    return { html, props, modeReads: S.modeReads, docsReads: S.docsReads };
  } finally {
    S.config = undefined;
  }
}
await t("P6-NAV rendered: on a documents store the editor page passes startingBrand = the brand step's palette (forest after a recorded forest pick; slate with no record, an unknown id, or a skip with no earlier pick), with one mode read and one documents read", async () => {
  const forest = { ...Palettes.paletteById("forest").brand };
  const slate = { ...Palettes.paletteById("slate").brand };
  const cases = [
    ["a recorded forest pick", { onboarding: { brand_step: { paletteId: "forest", skipped: false, at: "2026-11-05T10:00:00.000Z" } } }, forest],
    ["a skip that kept an earlier forest pick", { onboarding: { brand_step: { paletteId: "forest", skipped: true } } }, forest],
    ["no onboarding record", { brand: { accent: "#112233" } }, slate],
    ["a skip with no earlier pick", { onboarding: { brand_step: { skipped: true } } }, slate],
    ["an unknown palette id", { onboarding: { brand_step: { paletteId: "lime" } } }, slate],
    ["no config at all", {}, slate],
  ];
  for (const [what, config, want] of cases) {
    const r = await runEditorWith(config);
    ok(r.props, `${what}: DocumentEditor did not render: ${r.html.slice(0, 300)}`);
    eq(r.props.startingBrand, want, `${what}: startingBrand`);
    ok(!Palettes.isLimeAccent(r.props.startingBrand.accent), `${what}: a lime accent`);
    eq([r.modeReads, r.docsReads], [1, 1], `${what}: reads`);
  }
  // the other entries (a product's content, ?doc=) carry it too
  const design = await runEditorWith({ onboarding: { brand_step: { paletteId: "forest" } } }, { query: { doc: "doc_design" } });
  eq(design.props.startingBrand, forest, "?doc=doc_design:");
  eq([design.modeReads, design.docsReads], [1, 1], "?doc=doc_design reads:");
  // the modules can't load: the editor still opens, with null (the form then
  // uses slate), and the failure is logged
  const logged = [];
  const broken = { "@/lib/log": { slog: (ev) => logged.push(ev) } };
  Object.defineProperty(broken, "@/lib/themes/palettes", { enumerable: true, get: () => { throw new Error("chunk failed"); } });
  const r = await runEditorWith({ onboarding: { brand_step: { paletteId: "forest" } } }, { overrides: broken });
  ok(r.props, "the editor still opens");
  eq(r.props.startingBrand, null, "startingBrand when its modules can't load:");
  eq(logged, ["editor_starting_brand_failed"], "logged:");
});
await t("P6-NAV rendered: legacy and migrating editor renders are unchanged (no startingBrand, no documents read), and the page never imports the generator statically", async () => {
  for (const mode of ["legacy", "migrating"]) {
    const plain = await run("editor/page.js", { mode });
    const withRecord = await runEditorWith({ onboarding: { brand_step: { paletteId: "forest" } } }, { mode });
    eq(withRecord.html, plain.html, `${mode}: the markup`);
    ok(!withRecord.html.includes("startingBrand") && !withRecord.html.includes("DocumentEditor"), `${mode}: the editor showed`);
    eq([withRecord.modeReads, withRecord.docsReads], [1, 0], `${mode}: reads`);
  }
  const src = await readFile(join(AUTHED, "editor/page.js"), "utf8");
  ok(!/^import [^\n]*first-run\/generate/m.test(src), "editor/page.js imports lib/first-run/generate.js statically");
  ok(src.includes("import(`@/lib/tenant-context`)") && src.includes("import(`@/lib/themes/palettes`)") && !/^import [^\n]*(themes\/palettes|tenant-context)/m.test(src), "the starting-brand modules are template-literal imports (test-first-run pins the files the page compiles)");
});

await t("rendered: a signed-out visitor goes to the sign-in page first", async () => {
  S.actor = null;
  try {
    eq((await run("editor/page.js", { mode: "documents" })).redirect, "/admin/login", "editor:");
    eq((await run("storefront/designer/page.js", { mode: "documents" })).redirect, "/admin/login", "designer:");
  } finally {
    S.actor = { kind: "member", role: "owner" };
  }
});

const ROUTE_FILES = {
  "/admin/storefront": "storefront/page.js",
  "/admin/storefront/designer": "storefront/designer/page.js",
  "/admin/storefront/home": "storefront/home/page.js",
  "/admin/storefront/navigation": "storefront/navigation/page.js",
  "/admin/storefront/pages": "storefront/pages/page.js",
  "/admin/storefront/product-pages": "storefront/product-pages/page.js",
  "/admin/brand": "brand/page.js",
  "/admin/theme": "theme/page.js",
};
const WANT = {
  "/admin/storefront": "/admin/editor?doc=doc_home",
  "/admin/storefront/designer": "/admin/editor?doc=doc_home",
  "/admin/storefront/home": "/admin/editor?doc=doc_home",
  "/admin/storefront/navigation": "/admin/editor?doc=doc_header",
  "/admin/storefront/pages": "/admin/editor?doc=doc_home",
  "/admin/storefront/product-pages": "/admin/editor?doc=doc_product_layout",
  "/admin/brand": "/admin/editor?doc=doc_design",
  "/admin/theme": "/admin/editor?doc=doc_design",
};
// What each screen shows when it renders: its own editor (stubbed) or its content.
const SHOWS = {
  "/admin/storefront": "Published state",
  "/admin/storefront/designer": 'data-stub="Designer"',
  "/admin/storefront/home": 'data-stub="HomeEditor"',
  "/admin/storefront/navigation": 'data-stub="NavigationEditor"',
  "/admin/storefront/pages": 'data-stub="PagesList"',
  "/admin/storefront/product-pages": 'data-stub="PdpExtrasEditor"',
  "/admin/brand": 'data-stub="BrandAdmin"',
  "/admin/theme": 'data-stub="ThemeAdmin"',
};

await t("rendered: each old screen redirects to the editor in documents mode, before loading its data", async () => {
  for (const [route, file] of Object.entries(ROUTE_FILES)) {
    const r = await run(file, { mode: "documents" });
    eq(r.redirect, WANT[route], `${route}:`);
  }
  eq((await run("storefront/designer/page.js", { mode: "documents" })).redirect, "/admin/editor?doc=doc_home", "the Designer is never reached on a documents store:");
});

// Legacy screens now redirect straight to the editor in all modes (Legacy CMS retired).

// ---- 3. rendered: the console nav (the Phase 0 line 8 shell) ----------------
console.log("— the console nav");
let pathname = "/admin/dashboard";
const navLoad = world({
  "next/navigation": { usePathname: () => pathname, useRouter: () => ({ push() {}, refresh() {}, replace() {} }) },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
});
const NavModel = await import("../lib/admin/nav.js");
const { AdminShell } = await navLoad(join(ROOT, "components/admin/shell/AdminShell.js"));
const NavUi = await navLoad(join(ROOT, "components/admin/shell/AdminNav.js"));
const Sb = await navLoad(join(ROOT, "components/ui/sidebar.js"));
const Tt = await navLoad(join(ROOT, "components/ui/tooltip.js"));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const shell = ({ role = "owner", badges = { publish: "3" }, ...props } = {}, path = "/admin/dashboard") => {
  pathname = path;
  return renderToStaticMarkup(React.createElement(AdminShell, { nav: NavModel.navFor(role), badges, actor: { kind: "merchant", role }, account: { name: "Olivia Owner", email: "owner@x.test" }, stores: [], storeName: "Design Demo Co", storeId: "design", ...props }, React.createElement("p", null, "page")));
};
// what the editor's sheet (and the phone sheet) holds: the same groups
const sheetNav = (role, path, badges = {}) => {
  pathname = path;
  return renderToStaticMarkup(React.createElement(Tt.TooltipProvider, null, React.createElement(Sb.SidebarProvider, null, React.createElement(NavUi.NavGroups, { nav: NavModel.navFor(role), badges }))));
};
const hrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
const navHrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*data-nav-item=/g)].map((m) => m[1]);
const LEGACY_STOREFRONT = ["/admin/storefront", "/admin/storefront/home", "/admin/storefront/designer", "/admin/storefront/pages", "/admin/storefront/navigation", "/admin/storefront/product-pages", "/admin/theme", "/admin/brand", "/admin/media", "/admin/releases"];

await t("rendered: the shell's nav links the storefront to /admin/editor; Media and Publishing stay; Editor is current on /admin/editor/templates", () => {
  const html = shell({}, "/admin/editor/templates");
  const links = navHrefs(html);
  ok(links.includes("/admin/editor"), `no editor link: ${links}`);
  for (const old of LEGACY_STOREFRONT.slice(0, 8)) ok(!links.includes(old), `still links to ${old}`);
  ok(links.includes("/admin/media") && links.includes("/admin/releases"), "Media or Publishing gone");
  ok(/<a [^>]*href="\/admin\/editor"[^>]*aria-current="page"/.test(html), "the Editor link isn't marked current on /admin/editor/templates");
  eq((html.match(/aria-current="page"/g) || []).length, 1, "exactly one current item:");
  ok(html.includes(">Editor<") && /data-badge="publish"/.test(html), "label or Publishing badge missing");
  eq(links.filter((h) => h === "/admin/editor").length, 1, "one sidebar (the phone sheet renders nothing on the server):");
  ok(html.includes("<p>page</p>") && /data-legacy[^>]*>(<div[^>]*>)?<p>page<\/p>|data-legacy[^>]*><p>page<\/p>/.test(html), "the page renders inside [data-legacy]:");
});

await t("rendered: on an editor route the shell steps aside; the sheet holds the nav with the editor link", () => {
  const ed = shell({}, "/admin/storefront/designer");
  eq(navHrefs(ed), [], "no sidebar links on the editor route (the closed sheet renders nothing):");
  ok(!ed.includes('data-shell="topbar"') && ed.includes("<p>page</p>"), "no top bar; the page renders:");
  const inSheet = navHrefs(sheetNav("owner", "/admin/editor"));
  ok(inSheet.includes("/admin/editor") && !inSheet.includes("/admin/storefront/designer"), `the sheet's nav: ${inSheet}`);
  ok(read("components/admin/shell/AdminShell.js").includes("<SheetContent") && /onNavigate=\{\(\) => setSheet\(false\)\}/.test(read("components/admin/shell/AdminShell.js")), "the editor's sheet closes on a link:");
});

await t("rendered: staff see no Settings; Setup is gone for everyone and Onboarding is there for staff", () => {
  const staff = navHrefs(shell({ role: "staff" }));
  ok(staff.includes("/admin/editor") && !staff.includes("/admin/settings") && !staff.includes("/admin/setup") && staff.includes("/admin/onboarding"), `staff: ${staff}`);
  ok(!navHrefs(shell({})).includes("/admin/setup"), "owner: no Setup");
});

// Phase 1 line 3: the logo and colours moved into onboarding's Brand step
// (/admin/start redirects to /admin/onboarding?step=brand), so the
// Storefront group no longer has its own "Logo and colours" item.
await t("Phase 1 line 3 rendered: the Storefront group is Editor, Media, Publishing (no 'Logo and colours'); Onboarding is in Overview for owners and staff (its own page has no sidebar)", () => {
  const html = shell({ badges: {} }, "/admin/media");
  const links = navHrefs(html);
  const at = links.indexOf("/admin/editor");
  eq(links.slice(at, at + 3), ["/admin/editor", "/admin/media", "/admin/releases"], "the storefront group in order:");
  ok(!links.includes("/admin/start") && !html.includes("Logo and colours"), "no /admin/start link");
  ok(/<a [^>]*href="\/admin\/onboarding"[^>]*>[\s\S]*?Onboarding/.test(html), "the link:");
  eq(navHrefs(shell({ badges: {} }, "/admin/onboarding")), [], "on /admin/onboarding itself the shell shows no sidebar:");
  const store = NavModel.NAV.find((g) => g.label === "Storefront").items;
  eq(store.map((i) => i.id), ["editor", "media", "releases"], "the items:");
  ok(navHrefs(shell({ role: "staff" })).includes("/admin/onboarding"), "staff see Onboarding");
  ok(navHrefs(sheetNav("owner", "/admin/editor")).includes("/admin/onboarding"), "the sheet has it too:");
});

// ---- P4-SCAFFOLD: product and collection addresses, document ids, editability --
console.log("— P4-SCAFFOLD: the editor's product and collection addresses (plan section 4)");
const IDS = await import("../lib/documents/ids.js");
const EDIT = await import("../lib/registry/editability.js");
const Reg = await import("../lib/registry/index.js");

await t("P4-SCAFFOLD unit: entityEditorHref and parseEditorTarget round-trip product and collection gids, encoded", () => {
  const P = "gid://shopify/Product/8123456789";
  const Cn = "gid://shopify/Collection/4455";
  eq(E.entityEditorHref({ product: P }), "/admin/editor?product=gid%3A%2F%2Fshopify%2FProduct%2F8123456789", "product href:");
  eq(E.entityEditorHref({ collection: Cn }), "/admin/editor?collection=gid%3A%2F%2Fshopify%2FCollection%2F4455", "collection href:");
  for (const [target, key] of [
    [{ product: P }, "product"],
    [{ collection: Cn }, "collection"],
    [{ product: "gid://shopify/Product/orphan" }, "product"],
  ]) {
    const href = E.entityEditorHref(target);
    const url = new URL(href, "https://shop.test");
    eq(url.pathname, "/admin/editor", `${key} path:`);
    // both the URLSearchParams form and Next's plain searchParams object
    eq(E.parseEditorTarget(url.searchParams), target, `${key} via URLSearchParams:`);
    eq(E.parseEditorTarget(Object.fromEntries(url.searchParams)), target, `${key} via a plain object:`);
    eq(E.parseEditorTarget({ [key]: [target[key], "gid://shopify/Product/2"] }), target, `${key} first of an array:`);
  }
  eq(E.parseEditorTarget(new URLSearchParams("doc=doc_home")), { doc: "doc_home" }, "doc:");
  eq(E.parseEditorTarget({ doc: "doc_prod_0123456789abcdef" }), { doc: "doc_prod_0123456789abcdef" }, "a product document id:");
});

await t("P4-SCAFFOLD unit: one key wins (doc, then product, then collection); junk gives {} and a junk href is the bare editor", () => {
  const P = "gid://shopify/Product/1";
  const Cn = "gid://shopify/Collection/2";
  eq(E.parseEditorTarget({ doc: "doc_home", product: P, collection: Cn }), { doc: "doc_home" }, "doc first:");
  eq(E.parseEditorTarget({ product: P, collection: Cn }), { product: P }, "product before collection:");
  // the winning key's bad value is {}, never a fall-through
  eq(E.parseEditorTarget({ doc: "../etc", product: P }), {}, "bad doc:");
  eq(E.parseEditorTarget({ product: Cn, collection: Cn }), {}, "a collection gid under product:");
  for (const junk of [
    undefined,
    null,
    "",
    "product=gid://shopify/Product/1",
    42,
    {},
    { product: "" },
    { product: "gid://shopify/Product/" },
    { product: "gid://shopify/Product/1 2" },
    { product: "gid://shopify/Product/1/2" },
    { product: "gid://shopify/Product/1?x=1" },
    { product: `gid://shopify/Product/${"9".repeat(65)}` },
    { product: "gid://shopify/ProductVariant/1" },
    { product: "javascript:alert(1)" },
    { collection: "gid://shopify/Product/1" },
    { collection: ["", Cn] },
    { doc: "DOC_HOME" },
    { doc: "doc_home<script>" },
    { product: 7 },
    { other: P },
    new URLSearchParams("product=gid%3A%2F%2Fshopify%2FProduct%2F1%23x"),
  ]) {
    eq(E.parseEditorTarget(junk), {}, `parse ${JSON.stringify(junk instanceof URLSearchParams ? String(junk) : junk)}:`);
  }
  for (const junk of [undefined, null, {}, [], "x", { product: "1" }, { product: Cn }, { collection: P }, { product: P, collection: Cn }, { product: "gid://shopify/Product/a b" }]) {
    eq(E.entityEditorHref(junk), "/admin/editor", `href ${JSON.stringify(junk)}:`);
  }
  // LEGACY_ROUTE_DOCS is ED05's: the 8 P3-ROUTES screens plus its 3 (scripts/test-legacy-routes.js)
  eq(Object.keys(E.LEGACY_ROUTE_DOCS).length, 11, "LEGACY_ROUTE_DOCS entries:");
});

await t("P4-SCAFFOLD unit: productDocumentId and collectionDocumentId are async, deterministic, shaped and differ per id", async () => {
  const P1 = "gid://shopify/Product/101";
  const P2 = "gid://shopify/Product/102";
  const C1 = "gid://shopify/Collection/101";
  const pending = IDS.productDocumentId(P1);
  ok(pending instanceof Promise, "productDocumentId returns a Promise");
  ok(IDS.collectionDocumentId(C1) instanceof Promise, "collectionDocumentId returns a Promise");
  const a = await pending;
  ok(/^doc_prod_[0-9a-f]{16}$/.test(a), `product id shape: ${a}`);
  eq(a, await IDS.productDocumentId(P1), "same product, same id:");
  ok(a !== (await IDS.productDocumentId(P2)), "a different product gets a different id");
  // doc_prod_ + the first 16 hex of SHA-256(productId), as the brief pins it
  const { createHash } = await import("node:crypto");
  eq(a, `doc_prod_${createHash("sha256").update(P1).digest("hex").slice(0, 16)}`, "the hash:");
  const c = await IDS.collectionDocumentId(C1);
  ok(/^doc_coll_[0-9a-f]{16}$/.test(c), `collection id shape: ${c}`);
  eq(c, await IDS.collectionDocumentId(C1), "same collection, same id:");
  ok(c !== (await IDS.collectionDocumentId("gid://shopify/Collection/102")), "a different collection gets a different id");
  eq((await IDS.collectionDocumentId(P1)).slice(9), a.slice(9), "same input string, same hash, different prefix:");
  eq(c, `doc_coll_${createHash("sha256").update(C1).digest("hex").slice(0, 16)}`, "the collection hash:");
  // both open through ?doc= (the parser accepts them)
  eq(E.parseEditorTarget({ doc: a }), { doc: a }, "parse product doc id:");
  eq(E.parseEditorTarget({ doc: c }), { doc: c }, "parse collection doc id:");
  for (const bad of ["", null, undefined, 5]) {
    let threw = 0;
    await IDS.productDocumentId(bad).catch(() => threw++);
    await IDS.collectionDocumentId(bad).catch(() => threw++);
    eq(threw, 2, `refuses ${JSON.stringify(bad)}:`);
  }
  // backfillRouteId is unchanged by the shared helper
  eq(await IDS.backfillRouteId("page", "about"), `doc_p_${createHash("sha256").update("route:about").digest("hex").slice(0, 16)}`, "backfillRouteId:");
});

await t("P4-SCAFFOLD unit: typeHasEditor and cartEditable are pure; the system journal index and unknown types have no editor", () => {
  for (const type of Reg.documentTypeNames()) {
    const d = Reg.documentType(type);
    eq(EDIT.typeHasEditor(type), d.editable && !d.system, `${type}:`);
  }
  eq(EDIT.typeHasEditor("journal_index"), false, "journal_index:");
  for (const yes of ["home", "header", "page", "cart", "product_content", "design"]) eq(EDIT.typeHasEditor(yes), true, `${yes}:`);
  for (const no of ["", null, undefined, "nope", "__proto__", "constructor", 3]) eq(EDIT.typeHasEditor(no), false, `${String(no)}:`);
  eq(EDIT.CART_EDITABLE, true, "CART_EDITABLE:");
  eq(EDIT.cartEditable(), true, "cartEditable():");
  eq(EDIT.cartEditable(), EDIT.cartEditable(), "stable:");
  // pure: no database, no request, no node: import
  const src = readFileSync(join(ROOT, "lib/registry/editability.js"), "utf8");
  ok(!/from\s+["']node:/.test(src) && !/\b(libsql|db|cookies|headers|fetch)\s*\(/.test(src) && !/lib\/db\.js/.test(src), "editability.js is not pure");
  const ids = readFileSync(join(ROOT, "lib/documents/ids.js"), "utf8");
  ok(!/from\s+["']node:/.test(ids), "ids.js imports node:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
