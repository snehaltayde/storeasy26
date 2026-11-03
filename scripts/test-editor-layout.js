// Full-width editor suite (ED-01). Two layers:
//   1. unit: the numbers in components/admin/cms/editorLayout.js, which the
//      shell's classes and the preview canvas use: pane widths at each browser
//      width, how each device's page fits, and the negative (Desktop never
//      narrower than Mobile) over every width;
//   2. rendered: the real ConsoleShell, Designer and SurfaceDesigner, compiled
//      with Next's own SWC (plain node has no JSX) and rendered with
//      react-dom/server, checking the layout they produce and that their
//      classes say the same widths as the numbers above.
// Neither layer is a browser. The measured proof is the browser drill,
// scripts/drill-editor-layout.js, run against the design harness.
//   pnpm test:editor-layout
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
    console.error(`✗ ${name}\n   ${e.message}`);
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

const L = await import("../components/admin/cms/editorLayout.js");
const { DEVICES, deviceFor, frameFit, frameStyles, fitCaption, editorGeometry, isEditorRoute } = L;

// ---- 1. the numbers -----------------------------------------------------------
console.log("— the editor's numbers");

await t("at 1440 wide, the Desktop preview is at least 900px", () => {
  const g = editorGeometry(1440);
  const shown = frameFit(deviceFor("desktop").width, g.frameSpace).shown;
  ok(g.treeDocked, "tree docked at 1440");
  ok(shown >= 900, `Desktop shown ${shown}px (preview ${g.preview}px)`);
});

await t("at 1280 wide: tree at least 220, preview at least 600, inspector at least 280", () => {
  const g = editorGeometry(1280);
  ok(g.treeDocked && !g.treeDrawer, "tree docked at 1280");
  ok(g.tree >= 220, `tree ${g.tree}`);
  ok(g.preview >= 600 && frameFit(1280, g.frameSpace).shown >= 600, `preview ${g.preview}, frame ${frameFit(1280, g.frameSpace).shown}`);
  ok(g.inspector >= 280, `inspector ${g.inspector}`);
});

await t("every width from 1024 to 1279: the tree is a drawer and the preview keeps at least 600px", () => {
  for (let w = 1024; w < 1280; w++) {
    const g = editorGeometry(w);
    ok(g.treeDrawer && !g.treeDocked && g.tree === 0, `${w}: tree should be a drawer`);
    const shown = frameFit(1280, g.frameSpace).shown;
    ok(g.preview >= 600 && shown >= 600, `${w}: preview ${g.preview}, frame ${shown}`);
  }
});

await t("below 1024 the inspector goes under the preview, and the preview keeps 600px down to 616 wide", () => {
  for (let w = 616; w < 1024; w++) {
    const g = editorGeometry(w);
    ok(g.treeDrawer, `${w}: tree drawer`);
    ok(g.preview === w && g.inspector === w, `${w}: preview ${g.preview}, inspector ${g.inspector}`);
    ok(frameFit(1280, g.frameSpace).shown >= 600, `${w}: frame ${frameFit(1280, g.frameSpace).shown}`);
  }
  ok(frameFit(1280, editorGeometry(615).frameSpace).shown < 600, "615 is the first width that cannot keep 600 (a phone; ED-10 owns phones)");
});

await t("with no tree (the product and collection designers), nothing is set aside for one", () => {
  for (const w of [1440, 1280, 1100, 1024]) {
    const g = editorGeometry(w, { tree: false });
    ok(!g.treeDocked && !g.treeDrawer && g.tree === 0, `${w}: no tree`);
    eq(g.preview, w - L.INSPECTOR_WIDTH, `${w}: preview`);
  }
});

await t("devices: each renders at a real width, Mobile 375, Tablet 768, Desktop 1280", () => {
  eq(DEVICES.map((d) => [d.key, d.label, d.width]), [["mobile", "Mobile", 375], ["tablet", "Tablet", 768], ["desktop", "Desktop", 1280]], "devices:");
});

await t("a page narrower than the space shows at actual size; a wider one shrinks as a whole to fit", () => {
  eq(frameFit(375, 912), { width: 375, scale: 1, shown: 375, scaled: false }, "mobile in 912:");
  const d = frameFit(1280, 912);
  ok(d.scaled && d.width === 1280 && d.shown === 912 && Math.abs(d.scale - 912 / 1280) < 1e-9, JSON.stringify(d));
  ok(frameFit(768, 752).scaled && frameFit(768, 752).shown === 752, "tablet in 752 shrinks");
  ok(!frameFit(768, 768).scaled, "tablet in exactly 768 is actual size");
});

await t("negative: Desktop is never narrower than Mobile, on screen or inside, at any space 0 to 3000px", () => {
  for (let s = 0; s <= 3000; s++) {
    const m = frameFit(375, s);
    const tb = frameFit(768, s);
    const d = frameFit(1280, s);
    if (!(d.shown >= tb.shown && tb.shown >= m.shown)) throw new Error(`space ${s}: desktop ${d.shown}, tablet ${tb.shown}, mobile ${m.shown}`);
    if (!(d.width >= tb.width && tb.width >= m.width)) throw new Error(`space ${s}: inside widths`);
    if (d.shown > Math.floor(s) || m.shown > Math.floor(s)) throw new Error(`space ${s}: wider than the space`);
  }
});

await t("frame styles: the page renders at the device width, scaled to the box, and fills its height", () => {
  const s = frameStyles("desktop", { w: 912, h: 700 });
  eq(s.box, { width: 912, height: 700 }, "box:");
  eq(s.frame.width, 1280, "inside width:");
  ok(s.frame.transform === `scale(${912 / 1280})`, s.frame.transform);
  ok(Math.abs(s.frame.height * s.fit.scale - 700) < 1, `height ${s.frame.height} × ${s.fit.scale}`);
  ok(s.frame.position === "absolute" && s.frame.border === 0 && s.frame.transformOrigin === "0 0", JSON.stringify(s.frame));
  const m = frameStyles("mobile", { w: 912, h: 700 });
  eq([m.box.width, m.frame.width, m.frame.height, m.frame.transform], [375, 375, 700, "none"], "mobile:");
  eq(frameStyles("desktop", null).frame, null, "no space yet:");
  eq(frameStyles("desktop", { w: 900, h: 0 }).box, null, "no height yet:");
  eq(frameStyles("nonsense", { w: 400, h: 300 }).device.key, "desktop", "unknown key falls back to desktop:");
});

await t("the caption says the real width, and says when the page is shrunk", () => {
  eq(fitCaption("mobile", frameFit(375, 900)), "Mobile, 375 px wide, actual size");
  eq(fitCaption("desktop", frameFit(1280, 912)), "Desktop, 1280 px wide, shown at 71% to fit");
  eq(fitCaption("tablet", frameFit(768, 752)), "Tablet, 768 px wide, shown at 98% to fit");
  eq(fitCaption("desktop", null), "Desktop, 1280 px wide");
});

await t("only the designer routes get the editor layout", () => {
  for (const p of ["/admin/storefront/designer", "/admin/storefront/designer/product", "/admin/storefront/designer/collection"]) ok(isEditorRoute(p), p);
  for (const p of ["/admin/storefront", "/admin/storefront/designerx", "/admin/storefront/home", "/admin/dashboard", "/designer", "", null, undefined]) ok(!isEditorRoute(p), String(p));
});

// ---- 2. rendered ----------------------------------------------------------------
// A small loader: each component file is compiled with Next's SWC to CommonJS,
// relative and "@/" imports load the same way, packages come from node_modules,
// and a few edges (routing, network, toasts, pickers) are stand-ins.
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

let pathname = "/admin/storefront/designer";
const stubs = {
  "next/navigation": { usePathname: () => pathname, useRouter: () => ({ push() {}, refresh() {}, replace() {} }) },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/components/admin/StoreSwitcher": { __esModule: true, default: () => null },
  "@/components/console/Toast": { useToast: () => ({ success() {}, info() {}, error() {} }) },
  "./api": new Proxy({}, { get: () => async () => ({ ok: false }) }),
  "./useDirtyGuard": { useDirtyGuard() {} },
  "./MediaPicker": { MediaPicker: () => null },
  "./RefPicker": { CollectionPicker: () => null, ProductPicker: () => null, refLabel: (x) => x?.title || "" },
  "@/lib/cms/registry": await import("../lib/cms/registry.js"),
  "@/lib/cms/defaults": await import("../lib/cms/defaults.js"),
};
const cache = new Map();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
// resolve every local import first, so the synchronous require has it
async function locals(file, code, skip) {
  const local = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in skip || id in stubs) continue;
    const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
    if (target) local.set(id, await load(target.endsWith(".js") ? target : `${target}.js`));
  }
  return local;
}
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  const code = await compile(file);
  const local = await locals(file, code, {});
  new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
// A second, separate copy of one file, with some of its imports swapped
// (used below to give a component stand-in hooks). Its other imports are the
// shared copies.
async function loadIsolated(file, overrides) {
  const mod = { exports: {} };
  const code = await compile(file);
  const local = await locals(file, code, overrides);
  new Function("require", "module", "exports", code)(
    (id) => (id in overrides ? overrides[id] : id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)),
    mod,
    mod.exports
  );
  return mod.exports;
}
const { ConsoleShell } = await load(join(ROOT, "components/console/nav/ConsoleShell.js"));
const Designer = (await load(join(ROOT, "components/admin/cms/Designer.js"))).default;
const SurfaceDesigner = (await load(join(ROOT, "components/admin/cms/SurfaceDesigner.js"))).default;
const AUTHED = join(ROOT, "app/(console)/admin/(authed)");
const AdminError = (await load(join(AUTHED, "error.js"))).default;
const AdminLoading = (await load(join(AUTHED, "loading.js"))).default;
const DesignerLoading = (await load(join(AUTHED, "storefront/designer/loading.js"))).default;
const { Drawer } = await load(join(ROOT, "components/console/Drawer.js"));

const shellHtml = (path, child = React.createElement("p", { id: "page-content" }, "page")) => {
  pathname = path;
  return renderToStaticMarkup(React.createElement(ConsoleShell, { storeName: "Design Demo Co", host: "localhost", role: "owner", actorKind: "member", badges: {} }, child));
};
const designerInitial = {
  customized: { hero: true, announcement: false, home_sections: true },
  revisions: { hero: 1, announcement: null, home_sections: 2 },
  blocks: {
    hero: { title: "Skin first", primary: { label: "Shop", href: "/collections" }, secondary: { label: "", href: "" } },
    announcement: { enabled: true, text: "Sale", href: "" },
    home_sections: [{ id: "sec_1", kind: "collections", title: "Shop by collection", enabled: true }],
  },
};
const designerHtml = () => {
  pathname = "/admin/storefront/designer";
  return renderToStaticMarkup(React.createElement(Designer, { initial: designerInitial }));
};
const surfaceHtml = (surface, ctx) => {
  globalThis.sessionStorage = { getItem: () => (ctx ? JSON.stringify(ctx) : null), setItem() {} };
  pathname = `/admin/storefront/designer/${surface === "pdp" ? "product" : "collection"}`;
  try {
    return renderToStaticMarkup(React.createElement(SurfaceDesigner, { surface, initial: { surfaceTemplates: { value: null, revision: null } } }));
  } finally {
    delete globalThis.sessionStorage;
  }
};
// the opening tag of the element carrying an attribute, and its classes
const tagWith = (html, attr) => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] || "";
const classesOf = (tag) => (tag.match(/class="([^"]*)"/)?.[1] || "").split(/\s+/);
const rem = (cls, prefix) => {
  const c = cls.find((x) => new RegExp(`^${prefix}(\\d+)$`).test(x));
  return c ? Number(c.slice(prefix.length)) * 4 : null; // Tailwind spacing step = 0.25rem = 4px
};

console.log("— ConsoleShell");

await t("on the designer, the console's 1024px cap and sidebar are gone and the page is full width", () => {
  for (const p of ["/admin/storefront/designer", "/admin/storefront/designer/product", "/admin/storefront/designer/collection"]) {
    const html = shellHtml(p);
    ok(!html.includes("max-w-5xl"), `${p}: still capped: ${html.slice(0, 400)}`);
    ok(!/<aside\b/.test(html), `${p}: the sidebar still renders`);
    const main = tagWith(html, "<main");
    ok(/<main\b/.test(html) && html.indexOf('id="page-content"') > html.indexOf("<main"), `${p}: page not inside main`);
    ok(!classesOf(main).some((c) => /^(px|py|p)-/.test(c)), `${p}: main still has padding: ${main}`);
  }
});

await t("the folded navigation opens from the editor, through the shell's menu hook", () => {
  const { useConsoleNav } = cache.get(join(ROOT, "components/console/nav/ConsoleShell.js"));
  ok(typeof useConsoleNav === "function", "ConsoleShell exports useConsoleNav");
  let nav = "unset";
  const Probe = () => {
    nav = useConsoleNav();
    return null;
  };
  shellHtml("/admin/storefront/designer", React.createElement(Probe));
  ok(nav && typeof nav.openNav === "function", `editor route: ${JSON.stringify(nav)}`);
  nav = "unset";
  renderToStaticMarkup(React.createElement(Probe));
  ok(nav !== "unset" && !nav?.openNav, "outside a console shell there is nothing to open");
});

await t("every other console page keeps the sidebar and the 1024px cap", () => {
  for (const p of ["/admin/storefront", "/admin/storefront/home", "/admin/dashboard", "/admin/storefront/designerx"]) {
    const html = shellHtml(p);
    ok(html.includes("max-w-5xl"), `${p}: cap missing`);
    ok(/<aside\b/.test(html) && html.includes('href="/admin/dashboard"'), `${p}: sidebar missing`);
  }
});

// The editor routes draw no sidebar: the editor's top bar has the menu. When
// the page throws, Next shows the (authed) error boundary instead of the
// editor, so that page must bring its own menu button, or the founder is left
// with no navigation and no sign-out.
const errorEl = () => React.createElement(AdminError, { error: new Error("boom"), reset() {} });
await t("on the designer, a page that fails to load still has the menu (navigation and sign-out) and the usual padding", () => {
  for (const p of ["/admin/storefront/designer", "/admin/storefront/designer/product", "/admin/storefront/designer/collection"]) {
    const html = shellHtml(p, errorEl());
    ok(html.includes("This page hit an error") && />Try again</.test(html), `${p}: error page not shown`);
    const menu = tagWith(html, 'aria-label="Open menu"');
    ok(menu.startsWith("<button") && menu.includes("data-console-menu"), `${p}: no "Open menu" button: ${html.slice(0, 300)}`);
    ok(html.indexOf('aria-label="Open menu"') < html.indexOf("This page hit an error"), `${p}: the menu should come before the error`);
    ok(html.includes("Design Demo Co"), `${p}: store name missing from the bar`);
    const frameAt = html.indexOf("data-console-page-frame");
    ok(frameAt > 0, `${p}: no page frame`);
    const box = classesOf(html.slice(frameAt).match(/<div class="mx-auto[^"]*"/)?.[0] || "");
    ok(box.includes("max-w-5xl") && box.some((c) => /^px-/.test(c)) && box.some((c) => /^py-/.test(c)), `${p}: error not in the padded page: ${box.join(" ")}`);
  }
});

await t("on the designer, the console's loading skeleton has the menu too", () => {
  const html = shellHtml("/admin/storefront/designer/product", React.createElement(AdminLoading));
  ok(html.includes('aria-busy="true"'), "skeleton not shown");
  ok(tagWith(html, 'aria-label="Open menu"').includes("data-console-menu"), "no menu while loading");
});

await t("the designer's own loading state is editor-shaped, with the menu, and a tree only on the home page", () => {
  const home = shellHtml("/admin/storefront/designer", React.createElement(DesignerLoading));
  ok(home.includes('aria-busy="true"') && home.includes("data-editor-shell"), "not the editor's shape");
  ok(tagWith(home, 'aria-label="Open menu"').includes("data-console-menu"), "no menu while loading");
  ok(home.includes('data-editor-pane="tree"') && home.includes('data-editor-pane="preview"') && home.includes('data-editor-pane="inspector"'), "panes missing");
  const product = shellHtml("/admin/storefront/designer/product", React.createElement(DesignerLoading));
  ok(!product.includes('data-editor-pane="tree"') && !product.includes("data-tree-toggle"), "the product designer has no tree");
});

await t("on every other console page the error and loading pages are as before: no extra bar", () => {
  for (const p of ["/admin/dashboard", "/admin/storefront", "/admin/storefront/designerx"]) {
    for (const child of [errorEl(), React.createElement(AdminLoading)]) {
      const html = shellHtml(p, child);
      ok(!html.includes("data-console-page-frame") && !html.includes("data-console-menu"), `${p}: an editor bar was added`);
      ok(/<aside\b/.test(html) && html.includes("max-w-5xl"), `${p}: sidebar or cap missing`);
    }
  }
  // and outside any console shell the frame is a no-op
  const bare = renderToStaticMarkup(errorEl());
  ok(bare.includes("This page hit an error") && !bare.includes("data-console-page-frame"), "frame outside the shell");
});

console.log("— Designer and SurfaceDesigner in the editor shell");

await t("Designer: tree on the left, preview in the centre, inspector on the right", () => {
  const html = designerHtml();
  const at = (pane) => html.indexOf(`data-editor-pane="${pane}"`);
  ok(at("tree") > 0 && at("preview") > at("tree") && at("inspector") > at("preview"), `order tree ${at("tree")}, preview ${at("preview")}, inspector ${at("inspector")}`);
  ok(html.includes("data-editor-shell"), "no editor shell");
  ok(!html.includes("max-w-5xl") && !html.includes("xl:grid-cols-[16rem"), "old capped grid still present");
});

await t("Designer: the classes say the same widths as the numbers (tree 224, inspector 288, canvas pad 8)", () => {
  const html = designerHtml();
  const tree = classesOf(tagWith(html, 'data-editor-pane="tree"'));
  const inspector = classesOf(tagWith(html, 'data-editor-pane="inspector"'));
  eq(rem(tree, "w-"), L.TREE_WIDTH, "tree width class:");
  ok(tree.includes("hidden") && tree.includes("xl:block") && tree.includes("shrink-0"), `tree is docked only from xl (1280): ${tree.join(" ")}`);
  eq(L.TREE_DOCKED_FROM, 1280, "xl is 1280:");
  eq(rem(inspector, "lg:w-"), L.INSPECTOR_WIDTH, "inspector width class:");
  ok(inspector.includes("shrink-0"), "inspector never shrinks");
  // a long tree or a long form scrolls inside its own pane, never the page
  ok(tree.includes("overflow-y-auto"), `tree pane does not scroll on its own: ${tree.join(" ")}`);
  ok(inspector.includes("overflow-y-auto"), `inspector pane does not scroll on its own: ${inspector.join(" ")}`);
  eq(L.SIDE_BY_SIDE_FROM, 1024, "lg is 1024:");
  const panes = classesOf(tagWith(html, "data-editor-panes"));
  ok(panes.includes("lg:flex-row") && panes.includes("flex-col"), `panes side by side from lg: ${panes.join(" ")}`);
  const canvas = classesOf(tagWith(html, "data-preview-canvas"));
  eq(rem(canvas, "px-"), L.CANVAS_PAD, "canvas side padding:");
});

await t("Designer: below 1280 a Sections button opens the tree in a drawer, and the tree renders once", () => {
  const html = designerHtml();
  const toggle = tagWith(html, "data-tree-toggle");
  ok(toggle.startsWith("<button"), `toggle: ${toggle}`);
  const cls = classesOf(toggle);
  ok(cls.includes("xl:hidden"), `toggle hides from xl: ${cls.join(" ")}`);
  ok(/aria-expanded="false"/.test(toggle) && /aria-haspopup="dialog"/.test(toggle), `toggle aria: ${toggle}`);
  eq((html.match(/>Sections<\/h2>/g) || []).length, 1, "Sections headings:");
  eq((html.match(/>Add section</g) || []).length, 1, "Add section buttons:");
});

await t("Designer: device buttons in order, Desktop pressed, and a caption for the frame", () => {
  const html = designerHtml();
  const group = html.slice(html.indexOf('aria-label="Preview width"'));
  const labels = [...group.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)</g)].slice(0, 3).map((m) => [m[2], m[1]]);
  eq(labels, [["Mobile", "false"], ["Tablet", "false"], ["Desktop", "true"]], "buttons:");
  ok(html.includes("data-frame-caption"), "no caption");
});

await t("Designer: the header keeps the title, the surface tabs, the save status, Publishing and Save", () => {
  const html = designerHtml();
  const header = html.slice(html.indexOf("data-editor-shell"), html.indexOf('data-editor-panes'));
  ok(/<h1[^>]*>Designer<\/h1>/.test(header), "title");
  ok(header.includes('aria-label="Designer surfaces"'), "tabs");
  ok(header.includes("No unsaved changes") && header.includes('href="/admin/releases"') && />Save</.test(header), "status, Publishing, Save");
  ok(header.includes('href="/admin/storefront"'), "breadcrumb back to Storefront");
});

await t("SurfaceDesigner (product): the same shell, preview then inspector, no tree", () => {
  const html = surfaceHtml("pdp", { id: "gid://p/1", handle: "glow-serum", title: "Radiance Glow Serum 30ml" });
  const at = (pane) => html.indexOf(`data-editor-pane="${pane}"`);
  ok(html.includes("data-editor-shell"), "no editor shell");
  ok(at("preview") > 0 && at("inspector") > at("preview"), `order preview ${at("preview")}, inspector ${at("inspector")}`);
  ok(at("tree") < 0 && !html.includes("data-tree-toggle"), "a product page has no section tree");
  eq(rem(classesOf(tagWith(html, 'data-editor-pane="inspector"')), "lg:w-"), L.INSPECTOR_WIDTH, "inspector width:");
  ok(!html.includes("xl:grid-cols-[1fr_22rem]"), "old grid still present");
  ok(html.includes("Radiance Glow Serum 30ml") && html.includes('aria-label="Preview width"') && html.includes("data-frame-caption"), "context, devices and caption");
});

await t("SurfaceDesigner (collection, nothing picked yet): the shell asks for a collection, with no empty inspector", () => {
  const html = surfaceHtml("collection", null);
  ok(html.includes("data-editor-shell"), "no editor shell");
  ok(html.includes("Pick a collection to design"), "empty state");
  ok(!html.includes('data-editor-pane="inspector"'), "an empty inspector pane is shown");
});

// ---- 3. behaviour, without a browser --------------------------------------------
// A small shallow renderer. The component is called as a plain function with
// stand-in hooks (state, refs, effects recorded, not run); its returned
// elements are searched, their handlers called, and it is called again with
// the new state. Child components are not rendered. This covers the clicks
// and window changes the static render above cannot; the measured proof is
// still the browser drill.
console.log("— behaviour (stand-in hooks, no browser)");

function* walk(node, parent) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, parent);
    return;
  }
  if (!node.props) return;
  yield { el: node, parent };
  yield* walk(node.props.children, node);
}
let H = null; // the shallow render in progress
const hookReact = new Proxy(React, {
  get: (target, key) => (H && (key === "useState" || key === "useRef" || key === "useEffect" || key === "useContext") ? H[key] : target[key]),
});
function shallow(Component, props, { nav = null } = {}) {
  const states = [];
  const refs = [];
  let effects = [];
  let si = 0;
  let ri = 0;
  const h = {
    nav,
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
    useEffect(fn) {
      effects.push(fn);
    },
    // the one context these components read is the console shell's nav
    useContext: () => nav,
  };
  const s = {
    refs,
    tree: null,
    render() {
      si = ri = 0;
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
    // every element under `root` (default: the whole returned tree), with its parent element
    all: (root = s.tree) => walk(root, null),
    find(pred) {
      for (const hit of s.all()) if (pred(hit.el)) return hit;
      return null;
    },
    has: (pred, root) => {
      for (const { el } of s.all(root)) if (pred(el)) return true;
      return false;
    },
  };
  return s.render();
}
const hookOverrides = {
  react: hookReact,
  "@/components/console/nav/ConsoleShell": { useConsoleNav: () => H?.nav ?? null },
};
const Iso = await loadIsolated(join(ROOT, "components/admin/cms/EditorShell.js"), hookOverrides);
const IsoShell = await loadIsolated(join(ROOT, "components/console/nav/ConsoleShell.js"), { react: hookReact });
const marker = (name) => React.createElement("p", { "data-marker": name }, name);
const isMarker = (name) => (el) => el.props?.["data-marker"] === name;
const shellProps = { title: "Designer", tree: marker("tree"), preview: marker("preview"), inspector: marker("inspector") };
const drawerOf = (s) => s.find((el) => el.type === Drawer)?.el;
const treePane = (s) => s.find((el) => el.props?.["data-editor-pane"] === "tree")?.el;

await t("the Sections button opens the tree in its drawer, and the tree leaves the pane while it is open", () => {
  const s = shallow(Iso.EditorShell, shellProps, { nav: { openNav() {} } });
  eq(drawerOf(s).props.open, false, "drawer at first:");
  ok(s.has(isMarker("tree"), treePane(s)), "tree should be in its pane at first");
  const toggle = s.find((el) => el.props?.["data-tree-toggle"])?.el;
  ok(toggle && typeof toggle.props.onClick === "function", "no Sections button");
  toggle.props.onClick();
  s.render();
  eq(drawerOf(s).props.open, true, "drawer after a click:");
  eq(s.find((el) => el.props?.["data-tree-toggle"]).el.props["aria-expanded"], true, "aria-expanded:");
  ok(!s.has(isMarker("tree"), treePane(s)), "the tree is still in the pane while the drawer holds it");
  ok(s.has(isMarker("tree"), drawerOf(s)), "the drawer does not hold the tree");
  eq(drawerOf(s).props.closeLabel, "Close sections", "close button:");
  drawerOf(s).props.onClose();
  s.render();
  eq(drawerOf(s).props.open, false, "drawer after Close:");
});

await t("widening the window past 1280 closes the tree drawer (the tree docks)", () => {
  const s = shallow(Iso.EditorShell, shellProps, { nav: { openNav() {} } });
  s.find((el) => el.props?.["data-tree-toggle"]).el.props.onClick();
  s.render();
  const mq = { matches: false, query: null, fns: new Set(), addEventListener: (_, f) => mq.fns.add(f), removeEventListener: (_, f) => mq.fns.delete(f) };
  globalThis.window = { matchMedia: (q) => ((mq.query = q), mq) };
  try {
    s.runEffects();
  } finally {
    delete globalThis.window;
  }
  eq(mq.query, `(min-width: ${L.TREE_DOCKED_FROM}px)`, "watched width:");
  ok(mq.fns.size === 1, "nothing listens for the window widening");
  mq.matches = false;
  for (const f of mq.fns) f();
  eq(s.render().find((el) => el.type === Drawer).el.props.open, true, "narrowing must not close it:");
  mq.matches = true;
  for (const f of mq.fns) f();
  eq(drawerOf(s.render()).props.open, false, "drawer after widening:");
});

await t("picking a section in the tree drawer closes it, so its settings are in reach; other clicks keep it open", () => {
  const s = shallow(Iso.EditorShell, shellProps, { nav: { openNav() {} } });
  const open = () => {
    s.find((el) => el.props?.["data-tree-toggle"]).el.props.onClick();
    return s.render();
  };
  const body = () => s.find((el) => el.props?.["data-tree-drawer"])?.el;
  open();
  ok(body() && typeof body().props.onClick === "function", "the drawer's tree has no click handler");
  body().props.onClick({ target: { closest: () => null } }); // e.g. Move up, Add section
  eq(drawerOf(s.render()).props.open, true, "a click that is not a pick:");
  body().props.onClick({ target: { closest: (sel) => (sel === "[data-tree-pick]" ? {} : null) } });
  eq(drawerOf(s.render()).props.open, false, "after a pick:");
  // and Designer marks each row's own button (not its controls) as a pick
  const html = designerHtml();
  const picks = html.match(/<button[^>]*data-tree-pick[^>]*>/g) || [];
  eq(picks.length, 3, "rows marked as picks (hero, announcement, 1 section):");
  ok(!/data-tree-pick[^>]*aria-label="(Move|Hide|Show|Duplicate|Remove)/.test(html), "a row control is marked as a pick");
});

await t("the menu button opens the console navigation; with no console around it there is none", () => {
  const openNav = () => {};
  const s = shallow(Iso.EditorShell, shellProps, { nav: { openNav, editor: true, storeName: "Design Demo Co" } });
  const menu = s.find((el) => el.props?.["data-console-menu"])?.el;
  ok(menu && menu.props.onClick === openNav && menu.props.label === "Open menu", "menu button missing or not wired");
  const name = s.find((el) => el.props?.["data-store-name"])?.el;
  ok(name && name.props.children === "Design Demo Co" && name.props.className.includes("xl:inline") && name.props.className.includes("truncate"), "store name not in the bar from 1280");
  const bare = shallow(Iso.EditorShell, shellProps);
  ok(!bare.find((el) => el.props?.["data-console-menu"]) && !bare.find((el) => el.props?.["data-store-name"]), "a menu with nothing to open");
});

await t("on the designer, the console's menu really opens the store navigation drawer", () => {
  pathname = "/admin/storefront/designer";
  const s = shallow(IsoShell.ConsoleShell, { storeName: "Design Demo Co", host: "localhost", role: "owner", actorKind: "member", badges: {}, children: marker("page") });
  const nav = s.tree.props.value;
  ok(nav && typeof nav.openNav === "function" && nav.editor === true && nav.storeName === "Design Demo Co", `context: ${JSON.stringify(nav)}`);
  const drawer = () => s.find((el) => el.type === Drawer && el.props.title === "Design Demo Co")?.el;
  ok(drawer(), "the navigation drawer is not rendered on the designer");
  eq(drawer().props.open, false, "closed at first:");
  ok(drawer().props.children?.props?.onNavigate, "the drawer does not hold the navigation");
  nav.openNav();
  s.render();
  eq(drawer().props.open, true, "after the menu button:");
  drawer().props.onClose();
  eq(drawerOf(s.render()).props.open, false, "after Close:");
});

// P1-FIX-C (ED-01 review of fix round 1): the error page's menu button was
// only checked to exist. Wired to do nothing, or given `hidden`, it passed.
await t("on the designer, the error page's menu button is visible and its click opens the store navigation", () => {
  for (const p of ["/admin/storefront/designer", "/admin/storefront/designer/product", "/admin/storefront/designer/collection"]) {
    const menu = classesOf(tagWith(shellHtml(p, errorEl()), 'aria-label="Open menu"'));
    ok(menu.length > 0, `${p}: no menu button`);
    const hiding = menu.filter((c) => /^(?:[a-z0-9]+:)?(?:hidden|invisible|sr-only|opacity-0)$/.test(c));
    eq(hiding, [], `${p}: classes that hide the menu button:`);
  }
  let opened = 0;
  const openNav = () => opened++;
  const s = shallow(IsoShell.ConsolePageFrame, { children: marker("error") }, { nav: { editor: true, openNav, storeName: "Design Demo Co" } });
  const menu = s.find((el) => el.props?.["data-console-menu"])?.el;
  ok(menu && menu.props.label === "Open menu", "the frame has no menu button");
  ok(menu.props.onClick === openNav, "the menu button's click is not the shell's openNav");
  menu.props.onClick();
  eq(opened, 1, "a click opened the navigation this many times:");
  ok(!/(^|\s)(hidden|invisible|sr-only)(\s|$)/.test(String(menu.props.className || "")), `hidden by a class: ${menu.props.className}`);
  ok(s.has(isMarker("error")), "the error page is not inside the frame");
  // outside an editor route the frame adds nothing
  const plain = shallow(IsoShell.ConsolePageFrame, { children: marker("error") }, { nav: null });
  ok(!plain.find((el) => el.props?.["data-console-menu"]), "a menu button outside the designer");
});

// P1-FIX-C (DOC-04 review, R4 and R5): the Designer and the Home editor give a
// section its durable id the moment it is added or duplicated, so a refusal
// can name it before its first save. Nothing tested that. Each editor runs on
// stand-in hooks; its Save goes to a stand-in for the API that keeps what it
// was sent.
{
  const sent = [];
  const apiStub = {
    saveBlock: async (block, value, revision) => {
      sent.push({ block, value, revision });
      return { ok: false, error: "stand-in" };
    },
    getStorefrontView: async () => ({ ok: false }),
    resetBlock: async () => ({ ok: false }),
    startPreview: async () => ({ ok: false }),
    getHistory: async () => ({ ok: false }),
    saveCandidate: async () => ({ ok: true }),
  };
  const { SECTION_ID_RE, COMPONENTS } = await import("../lib/cms/registry.js");
  const COMPONENTS_LABEL = { banner: COMPONENTS.banner.label };
  // every element in the tree, including those handed to a component as a prop
  // (EditorShell's tree and inspector, a card's actions)
  function* deep(node, seen = new Set()) {
    if (node == null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const n of node) yield* deep(n, seen);
      return;
    }
    if (!node.props || typeof node.props !== "object") return;
    yield node;
    for (const v of Object.values(node.props)) yield* deep(v, seen);
  }
  const textOf = (el) => (typeof el === "string" ? el : Array.isArray(el) ? el.map(textOf).join("") : el?.props ? textOf(el.props.children) : "");
  const click = (s, pred, label) => {
    const el = [...deep(s.tree)].find(pred);
    ok(el && typeof el.props.onClick === "function", `no ${label}`);
    el.props.onClick();
    return s.render();
  };
  const homeSections = (initialSections) => ({
    customized: { hero: false, announcement: false, home_sections: true },
    revisions: { hero: null, announcement: null, home_sections: 3 },
    blocks: { hero: { title: "Skin first" }, announcement: { enabled: false, text: "", href: "" }, home_sections: initialSections, nav_header: [], nav_footer: [], collections_index: null, pdp_extras: [] },
  });
  const checkSent = (label, originalId) => {
    const last = sent.filter((x) => x.block === "home_sections").at(-1);
    ok(last, `${label}: Save sent no homepage sections`);
    const ids = last.value.map((sec) => sec.id);
    eq(ids.length, 3, `${label}: sections sent:`);
    ok(ids.every((id) => typeof id === "string" && SECTION_ID_RE.test(id)), `${label}: a section went without a durable id: ${JSON.stringify(ids)}`);
    eq(new Set(ids).size, 3, `${label}: two sections share an id: ${JSON.stringify(ids)}`);
    eq(ids[0], originalId, `${label}: the original keeps its id:`);
  };

  const IsoDesigner = (await loadIsolated(join(ROOT, "components/admin/cms/Designer.js"), { react: hookReact, "./api": apiStub })).default;
  const IsoHome = (await loadIsolated(join(ROOT, "components/admin/cms/HomeEditor.js"), { react: hookReact, "./api": apiStub })).default;

  await t("Designer: a section added or duplicated has its own durable id before its first save", async () => {
    sent.length = 0;
    pathname = "/admin/storefront/designer";
    const s = shallow(IsoDesigner, { initial: homeSections([{ id: "sec_orig1", kind: "collections", title: "Shop by collection", enabled: true }]) });
    click(s, (el) => el.props["aria-label"] == null && textOf(el.props.children) === "Add section" && "aria-expanded" in el.props, "Add section button");
    click(s, (el) => el.type === "button" && textOf(el.props.children).includes(COMPONENTS_LABEL.banner), "Banner / CTA in the add menu");
    click(s, (el) => el.props.label === "Duplicate section", "Duplicate on the first section");
    await click(s, (el) => textOf(el.props.children) === "Save" && el.props.variant === "primary", "Save").tree;
    await new Promise((r) => setTimeout(r, 0));
    checkSent("Designer", "sec_orig1");
  });

  await t("Home editor: a section added or duplicated has its own durable id before its first save", async () => {
    sent.length = 0;
    pathname = "/admin/storefront/home";
    const s = shallow(IsoHome, { initial: homeSections([{ id: "sec_orig2", kind: "collections", title: "Shop by collection", enabled: true }]) });
    click(s, (el) => textOf(el.props.children) === "Duplicate", "Duplicate on the first section");
    click(s, (el) => el.props.title === "Accent panel with a headline and button", "Banner / CTA add button");
    const sectionsCard = [...deep(s.tree)].find((el) => el.props.title === "Homepage sections" && el.props.actions);
    ok(sectionsCard, "no Homepage sections card");
    const save = [...deep(sectionsCard.props.actions)].find((el) => textOf(el.props.children) === "Save");
    ok(save && typeof save.props.onClick === "function", "no Save on the sections card");
    await save.props.onClick();
    // the order here: original, its duplicate, then the added banner
    checkSent("Home editor", "sec_orig2");
  });
}

await t("the preview's box positions and clips the page inside it, at the measured size", () => {
  const frame = (style) => React.createElement("iframe", { "data-marker": "frame", style });
  const s = shallow(Iso.PreviewCanvas, { device: "desktop", frame });
  ok(!s.find(isMarker("frame")), "no frame before the space is measured");
  let report = null;
  globalThis.ResizeObserver = class {
    constructor(cb) {
      report = cb;
    }
    observe() {}
    disconnect() {}
  };
  try {
    s.refs[0].current = {}; // the canvas element
    s.runEffects();
  } finally {
    delete globalThis.ResizeObserver;
  }
  ok(typeof report === "function", "the canvas does not measure its space");
  report([{ contentRect: { width: 912, height: 700 } }]);
  s.render();
  const hit = s.find(isMarker("frame"));
  ok(hit, "no frame after measuring");
  const box = hit.parent;
  const cls = box.props.className.split(/\s+/);
  ok(cls.includes("relative"), `the box does not position the page (it is absolutely placed): ${box.props.className}`);
  ok(cls.includes("overflow-hidden"), `the box does not clip the page: ${box.props.className}`);
  eq(box.props.style, { width: 912, height: 700 }, "box:");
  eq([hit.el.props.style.width, hit.el.props.style.position, hit.el.props.style.transform], [1280, "absolute", `scale(${912 / 1280})`], "page:");
  const caption = s.find((el) => el.props?.["data-frame-caption"]).el;
  eq(caption.props.children, "Desktop, 1280 px wide, shown at 71% to fit", "caption:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
