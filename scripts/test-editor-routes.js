// P3-ROUTES suite (ED-02, PUB-11, PV-01): the new editor's address, the old
// screens that send a documents store to it, the console nav, and the
// Designer's failed-preview message.
//   1. unit: lib/admin/editor-entry.js, which document ?doc= or ?path= opens,
//      round-tripped against lib/documents/paths.js livePath();
//   2. rendered: the real page modules (app/(console)/admin/(authed)/...),
//      compiled with Next's own SWC and called as server components with
//      their data stubbed: /admin/editor in each mode, and each old screen's
//      redirect (documents only) or its unchanged render (legacy, migrating);
//   3. rendered: ConsoleShell and SidebarNav with and without documents mode;
//   4. rendered + behaviour: the Designer with a stubbed api, its candidate
//      push failing in each way, through stand-in hooks (no browser).
// The browser proof is scripts/drills/p3/routes.mjs on the design harness.
//   pnpm test:editor-routes
import { readFile } from "node:fs/promises";
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
  for (const path of ["/nowhere", "/campaigns/missing", "/journal/", "/policies/a/b", "/products/serum"]) {
    const r = open({ path });
    eq(r.document.id, "doc_home", `${path}:`);
    ok(typeof r.note === "string" && r.note.includes("home page") && r.note.includes(path.replace(/\/$/, "") || "/"), `${path}: note ${r.note}`);
  }
  const bad = open({ path: "https://evil.example/about" });
  ok(bad.document.id === "doc_home" && bad.note && !bad.note.includes("evil"), `an off-site address: ${JSON.stringify(bad)}`);
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
  eq(Object.keys(E.LEGACY_ROUTE_DOCS).sort(), ["/admin/brand", "/admin/storefront", "/admin/storefront/designer", "/admin/storefront/home", "/admin/storefront/navigation", "/admin/storefront/pages", "/admin/storefront/product-pages", "/admin/theme"].sort(), "routes:");
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
  "@/lib/tenant-context": { currentTenant: () => ({ config: { brand: { accent: "#112233" } } }), tenantOwnCfg: () => ({ kit: "pulse" }) },
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

// The screens in legacy and migrating: the same markup as the same file
// with its one P3-ROUTES redirect line taken out.
const withoutRedirect = (src) => {
  const lines = src.split("\n");
  const kept = lines.filter((l) => !/redirect\(editorHref\(/.test(l));
  if (kept.length !== lines.length - 1) throw new Error(`expected exactly one redirect line, found ${lines.length - kept.length}`);
  return kept.join("\n");
};
await t("rendered: each old screen renders as before in legacy and migrating (same markup as without the redirect line)", async () => {
  for (const [route, file] of Object.entries(ROUTE_FILES)) {
    const src = await readFile(join(AUTHED, file), "utf8");
    const before = await run(file, { mode: "legacy", source: withoutRedirect(src) });
    ok(before.html && before.html.includes(SHOWS[route]), `${route}: the screen's own content is missing: ${String(before.html).slice(0, 300)}`);
    for (const mode of ["legacy", "migrating"]) {
      const r = await run(file, { mode });
      ok(!r.redirect, `${route} (${mode}) redirected to ${r.redirect}`);
      ok(r.html === before.html, `${route} (${mode}) renders differently from before`);
      ok(r.modeReads === 1, `${route} (${mode}): ${r.modeReads} mode reads`);
    }
  }
});

await t("rendered: an old screen whose mode read fails renders as before (its writes still refuse on their own fresh read)", async () => {
  for (const [route, file] of Object.entries(ROUTE_FILES)) {
    const r = await run(file, { modeThrows: true });
    ok(!r.redirect && r.html.includes(SHOWS[route]), `${route}: ${r.redirect || String(r.html).slice(0, 200)}`);
  }
});

// ---- 3. rendered: the console nav ----------------------------------------------
console.log("— the console nav");
let pathname = "/admin/dashboard";
const navLoad = world({
  "next/navigation": { usePathname: () => pathname, useRouter: () => ({ push() {}, refresh() {}, replace() {} }) },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/components/admin/StoreSwitcher": { __esModule: true, default: () => null },
});
const { ConsoleShell } = await navLoad(join(ROOT, "components/console/nav/ConsoleShell.js"));
const Nav = await navLoad(join(ROOT, "components/console/nav/SidebarNav.js"));
const shell = (props, path = "/admin/dashboard") => {
  pathname = path;
  return renderToStaticMarkup(React.createElement(ConsoleShell, { storeName: "Design Demo Co", host: "localhost", role: "owner", actorKind: "member", badges: { publish: "3" }, ...props }, React.createElement("p", null, "page")));
};
const hrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
const LEGACY_STOREFRONT = ["/admin/storefront", "/admin/storefront/home", "/admin/storefront/designer", "/admin/storefront/pages", "/admin/storefront/navigation", "/admin/storefront/product-pages", "/admin/theme", "/admin/brand", "/admin/media", "/admin/releases"];
const LEGACY_ALL = ["/admin/dashboard", "/admin/analytics", "/admin/setup", "/admin/orders", "/admin/catalog", ...LEGACY_STOREFRONT, "/admin/offers", "/admin/upsells", "/admin/experiments", "/admin/insights", "/admin/automations", "/admin/integrations", "/admin/billing", "/admin/settings"];

await t("rendered: SidebarNav in documents mode links the storefront to /admin/editor; Media and Publishing stay", () => {
  pathname = "/admin/editor";
  const html = renderToStaticMarkup(React.createElement(Nav.SidebarNav, { role: "owner", cmsMode: "documents", badges: { publish: "3" } }));
  const links = hrefs(html);
  ok(links.includes("/admin/editor"), `no editor link: ${links}`);
  for (const old of LEGACY_STOREFRONT.slice(0, 8)) ok(!links.includes(old), `still links to ${old}`);
  ok(links.includes("/admin/media") && links.includes("/admin/releases"), "Media or Publishing gone");
  ok(/<a [^>]*href="\/admin\/editor"[^>]*aria-current="page"/.test(html), "the Editor link isn't marked current on /admin/editor");
  ok(html.includes(">Editor<") && /href="\/admin\/releases"[\s\S]*?>3</.test(html), "label or Publishing badge missing");
  // the whole shell, both sidebars (desktop and drawer)
  const s = hrefs(shell({ cmsMode: "documents" })); // the desktop sidebar (the closed drawer renders nothing)
  ok(s.filter((h) => h === "/admin/editor").length === 1 && !s.includes("/admin/storefront/designer") && !s.includes("/admin/brand"), `shell: ${s}`);
});

await t("rendered: SidebarNav outside documents mode is exactly the legacy nav", () => {
  pathname = "/admin/storefront/home";
  const base = renderToStaticMarkup(React.createElement(Nav.SidebarNav, { role: "owner", badges: {} }));
  for (const cmsMode of [null, "legacy", "migrating", "", "DOCUMENTS"]) {
    eq(renderToStaticMarkup(React.createElement(Nav.SidebarNav, { role: "owner", badges: {}, cmsMode })), base, `${cmsMode}:`);
  }
  eq(hrefs(base), LEGACY_ALL, "legacy links in order:");
  ok(Nav.navGroups("legacy") === Nav.NAV_GROUPS && Nav.navGroups(undefined) === Nav.NAV_GROUPS, "legacy groups are not the same object");
  ok(Nav.navGroups("documents") !== Nav.NAV_GROUPS && Nav.NAV_GROUPS.find((g) => g.label === "Storefront").items.length === 10, "documents mode changed NAV_GROUPS itself");
  // staff: role filtering is unchanged in documents mode
  const staff = hrefs(renderToStaticMarkup(React.createElement(Nav.SidebarNav, { role: "staff", cmsMode: "documents" })));
  ok(staff.includes("/admin/editor") && !staff.includes("/admin/settings") && !staff.includes("/admin/setup"), `staff: ${staff}`);
});

await t("rendered: ConsoleShell's legacy output is unchanged by the cmsMode prop", () => {
  for (const path of ["/admin/dashboard", "/admin/storefront", "/admin/storefront/designer", "/admin/storefront/designer/product"]) {
    const base = shell({}, path);
    for (const cmsMode of [null, "legacy", "migrating"]) eq(shell({ cmsMode }, path), base, `${path} ${cmsMode}:`);
  }
  const html = shell({});
  eq(hrefs(html).filter((h) => LEGACY_STOREFRONT.includes(h)), LEGACY_STOREFRONT, "the sidebar carries every legacy storefront link (the drawer renders nothing while closed):");
});

await t("rendered: the (authed) layout passes the mode it reads to the shell, best-effort", async () => {
  const src = await readFile(join(AUTHED, "layout.js"), "utf8");
  const Layout = (
    await world({
      ...pageStubs,
      "@/lib/site": { siteName: () => "Design Demo Co" },
      "@/lib/tenant-context": { currentTenant: () => ({ domains: ["localhost"] }) },
      "@/lib/returns": { listReturns: async () => [] },
      "@/lib/admin/onboarding": { buildChecklist: async () => null },
      "@/lib/releases": { publishingBadge: async () => null },
      "@/components/console/nav/ConsoleShell": { ConsoleShell: (p) => React.createElement("div", { "data-shell": p.cmsMode ?? "none" }, p.children) },
    })(join(AUTHED, "layout.js"), { source: src })
  ).default;
  for (const [mode, throws, want] of [
    ["documents", false, "documents"],
    ["legacy", false, "legacy"],
    ["migrating", false, "migrating"],
    ["documents", true, "none"],
  ]) {
    Object.assign(S, { mode, modeThrows: throws });
    const html = renderToStaticMarkup(await Layout({ children: React.createElement("p", null, "page") }));
    ok(html.includes(`data-shell="${want}"`) && html.includes("<p>page</p>"), `${mode}${throws ? " (read fails)" : ""}: ${html}`);
  }
  S.modeThrows = false;
});

// ---- 4. the Designer: a failed candidate push --------------------------------------
console.log("— the Designer's failed preview push (PV-01)");
let H = null;
const hookReact = new Proxy(React, {
  get: (target, key) => (H && (key === "useState" || key === "useRef" || key === "useEffect" || key === "useContext") ? H[key] : target[key]),
});
function shallow(Component, props) {
  const states = [];
  const refs = [];
  const lastDeps = [];
  let effects = [];
  let ei = 0;
  let si = 0;
  let ri = 0;
  const h = {
    useState(init) {
      const k = si++;
      if (!(k in states)) states[k] = typeof init === "function" ? init() : init;
      return [states[k], (v) => (states[k] = typeof v === "function" ? v(states[k]) : v)];
    },
    useRef(init) {
      const k = ri++;
      if (!(k in refs)) refs[k] = { current: init ?? null };
      return refs[k];
    },
    // runs like React: on the first pass, then only when a dependency changed
    useEffect(fn, deps) {
      const k = ei++;
      const prev = lastDeps[k];
      const changed = !deps || !prev || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      if (changed) effects.push(() => ((lastDeps[k] = deps), fn()));
    },
    useContext: () => null,
  };
  const s = {
    render() {
      si = ri = ei = 0;
      effects = [];
      const prev = H;
      H = h;
      try {
        s.tree = Component(props);
      } finally {
        H = prev;
      }
      return s;
    },
    runEffects: () => effects.map((fn) => fn()),
  };
  return s.render();
}
// every element in the tree, through children AND element-valued props
// (EditorShell gets the tree, preview and inspector as props)
function* walk(node) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!node.props) return;
  yield node;
  for (const v of Object.values(node.props)) if (v && typeof v === "object") yield* walk(v);
}
const find = (tree, pred) => {
  for (const el of walk(tree)) if (pred(el)) return el;
  return null;
};
const textOf = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
};

const API = { pushes: [], answers: [] };
const designerLoad = world({
  "next/navigation": { usePathname: () => "/admin/storefront/designer", useRouter: () => ({ push() {}, refresh() {}, replace() {} }) },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/components/admin/StoreSwitcher": { __esModule: true, default: () => null },
  "@/components/console/Toast": { useToast: () => ({ success() {}, info() {}, error() {} }) },
  "./api": {
    getStorefrontView: async () => ({ ok: false }),
    saveBlock: async () => ({ ok: false }),
    resetBlock: async () => ({ ok: false }),
    getHistory: async () => ({ ok: true, history: [] }),
    startPreview: async () => ({ ok: true, url: "/api/preview?token=x", to: "/" }),
    saveCandidate: async (payload) => {
      API.pushes.push(payload);
      return API.answers.shift() ?? { ok: true };
    },
  },
  "./useDirtyGuard": { useDirtyGuard() {} },
  "./MediaPicker": { MediaPicker: () => null },
  "./RefPicker": { CollectionPicker: () => null, ProductPicker: () => null, refLabel: (x) => x?.title || "" },
  "@/lib/cms/registry": await import("../lib/cms/registry.js"),
  "@/lib/cms/defaults": await import("../lib/cms/defaults.js"),
});
const DESIGNER = join(ROOT, "components/admin/cms/Designer.js");
const DesignerMod = await designerLoad(DESIGNER);
const IsoDesigner = (await designerLoad(DESIGNER, { overrides: { react: hookReact } })).default;
const { Banner } = await designerLoad(join(ROOT, "components/console/Banner.js"));
const designerInitial = {
  customized: { hero: true, announcement: false, home_sections: true },
  revisions: { hero: 1, announcement: null, home_sections: 2 },
  blocks: {
    hero: { title: "Skin first", primary: { label: "Shop", href: "/collections" }, secondary: { label: "", href: "" } },
    announcement: { enabled: true, text: "Sale", href: "" },
    home_sections: [{ id: "sec_1", kind: "collections", title: "Shop by collection", enabled: true }],
  },
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// The Designer up to a connected preview with an unsaved hero edit; each
// call to push() runs one candidate push (the 700 ms timer, run at once).
async function designerSession() {
  const listeners = [];
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.window = { location: { origin: "http://localhost" }, addEventListener: (type, fn) => type === "message" && listeners.push(fn), removeEventListener() {}, open() {} };
  const s = shallow(IsoDesigner, { initial: designerInitial, tests: {} });
  s.runEffects(); // mints the preview
  await flush();
  s.render();
  for (const fn of listeners) fn({ origin: "http://localhost", source: undefined, data: { type: "storeasy:ready" } });
  s.render();
  find(s.tree, (el) => el.type === "button" && "data-tree-pick" in el.props && textOf(el).includes("Hero")).props.onClick();
  s.render();
  const pickHero = () => {
    find(s.tree, (el) => el.type === "button" && "data-tree-pick" in el.props && textOf(el).includes("Hero")).props.onClick();
    s.render();
  };
  const typeTitle = (v) => {
    if (!find(s.tree, (el) => el.props?.id === "ins-hero-title")) pickHero();
    find(s.tree, (el) => el.props?.id === "ins-hero-title").props.onChange({ target: { value: v } });
    s.render();
  };
  const push = async () => {
    timers.length = 0;
    globalThis.setTimeout = (fn) => (timers.push(fn), 0);
    try {
      s.runEffects();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    for (const fn of timers) await fn();
    await flush();
    s.render();
  };
  const preview = () => find(s.tree, (el) => typeof el.type === "function" && el.props?.preview)?.props.preview;
  const status = () => textOf(find(preview(), (el) => el.props?.role === "status"));
  const banner = () => find(preview(), (el) => el.type === Banner && el.props.title === "The preview didn't update");
  const done = () => delete globalThis.window;
  return { s, typeTitle, push, status, banner, done };
}

await t("unit: candidateFailure words every failure plainly, never as 'nothing was saved' from a save", () => {
  const F = DesignerMod.candidateFailure;
  ok(typeof F === "function", "Designer does not export candidateFailure");
  const cases = [
    [{ ok: false, error: "We couldn't reach Storeasy, so nothing was saved. …", code: "NETWORK" }, /couldn't reach Storeasy, so the preview didn't update/],
    [{ ok: false, issues: [{ severity: "error", message: "Add a title.", sectionId: "hero" }], errors: ["Hero: Add a title."] }, /something in your edits needs fixing/],
    [{ ok: false, errors: ["Header menu, item 2: that link goes nowhere."] }, /didn't update: Header menu, item 2: that link goes nowhere\./],
    [{ ok: false, error: "The preview isn't open any more. Reopen the preview, then keep editing.", code: "NO_PREVIEW", status: 409 }, /isn't open any more/],
    [{ ok: false, error: "Something failed (DB_DOWN), so nothing was saved.", code: "DB_DOWN", status: 503 }, /went wrong on our side \(error 503\), so the preview didn't update/],
    [{ ok: false, error: "x", code: "UNREADABLE_RESPONSE", status: 502 }, /error 502/],
    [{ ok: false }, /went wrong on our side, so the preview didn't update/],
  ];
  for (const [res, re] of cases) {
    const f = F(res);
    ok(re.test(f.message), `${JSON.stringify(res)} -> ${f.message}`);
    ok(f.message.includes("still shows an earlier version"), `doesn't say the frame is stale: ${f.message}`);
    ok(!/nothing was saved\./.test(f.message), `reads like a failed save: ${f.message}`);
  }
  eq(F(cases[3][0]).reopen, true, "an expired preview offers to reopen:");
  eq(F(cases[0][0]).reopen, false, "a network failure doesn't:");
  eq(F(cases[1][0]).issues.length, 1, "the issues ride along:");
});

await t("rendered: a failed push shows a plain message, and the label stops saying the preview shows the edits", async () => {
  const d = await designerSession();
  try {
    ok(/Preview shows your last save/.test(d.status()), `before: ${d.status()}`);
    d.typeTitle("Skin first, always");
    API.answers.push({ ok: true });
    await d.push();
    ok(/UNSAVED edits/.test(d.status()) && !d.banner(), `after a good push: ${d.status()}`);
    eq(API.pushes.at(-1)?.hero?.title, "Skin first, always", "pushed:");

    d.typeTitle("Skin first, always and");
    API.answers.push({ ok: false, error: "We couldn't reach Storeasy, so nothing was saved.", code: "NETWORK" });
    await d.push();
    const b = d.banner();
    ok(b, "no message after a failed push (it was swallowed)");
    const html = renderToStaticMarkup(b);
    ok(html.includes("We couldn&#x27;t reach Storeasy, so the preview didn&#x27;t update") && html.includes("still shows an earlier version"), html);
    ok(!/UNSAVED edits/.test(d.status()) && /didn't update/.test(d.status()), `the label still claims the edits: ${d.status()}`);

    // the next push that works clears it
    d.typeTitle("Skin first, always and ever");
    API.answers.push({ ok: true });
    await d.push();
    ok(!d.banner() && /UNSAVED edits/.test(d.status()), `after recovering: ${d.status()}`);
  } finally {
    d.done();
  }
});

await t("rendered: an incomplete section names the section and links to it; an expired preview offers Reopen", async () => {
  const d = await designerSession();
  try {
    d.typeTitle("");
    API.answers.push({ ok: false, issues: [{ severity: "error", code: "REQUIRED", message: "Add a title.", sectionId: "sec_1" }], errors: ["Add a title."] });
    await d.push();
    const b = d.banner();
    ok(b, "no message for an incomplete section");
    const link = find(b, (el) => el.type === "button" && /Section 1/.test(textOf(el)));
    ok(link, `the issue doesn't name its section: ${renderToStaticMarkup(b)}`);
    link.props.onClick();
    d.s.render();
    ok(find(d.s.tree, (el) => el.type === "button" && "data-tree-pick" in el.props && el.props["aria-current"] && /Shop by collection/.test(textOf(el))), "clicking the issue didn't select the section");

    API.answers.push({ ok: false, error: "The preview isn't open any more. Reopen the preview, then keep editing.", code: "NO_PREVIEW", status: 409 });
    d.typeTitle("x");
    await d.push();
    const reopen = d.banner()?.props.actions;
    ok(reopen && textOf(reopen) === "Reopen preview", `no Reopen: ${renderToStaticMarkup(d.banner())}`);

    API.answers.push({ ok: false, error: "boom, nothing was saved", code: "INTERNAL", status: 500 });
    d.typeTitle("y");
    await d.push();
    ok(/error 500/.test(renderToStaticMarkup(d.banner())) && !d.banner().props.actions, "a server error");
  } finally {
    d.done();
  }
});

await t("rendered: Designer's static render is unchanged when nothing failed (no banner)", () => {
  const html = renderToStaticMarkup(React.createElement(DesignerMod.default, { initial: designerInitial }));
  ok(!html.includes("data-preview-push-failed") && !html.includes("The preview didn"), "a failure message on first render");
  ok(html.includes("data-editor-shell"), "not the Designer");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
