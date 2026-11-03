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
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  const { code } = await swc.transform(await readFile(file, "utf8"), {
    filename: file,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  // resolve every local import first, so the synchronous require below has it
  const local = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs) continue;
    const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
    if (target) local.set(id, await load(target.endsWith(".js") ? target : `${target}.js`));
  }
  new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { ConsoleShell } = await load(join(ROOT, "components/console/nav/ConsoleShell.js"));
const Designer = (await load(join(ROOT, "components/admin/cms/Designer.js"))).default;
const SurfaceDesigner = (await load(join(ROOT, "components/admin/cms/SurfaceDesigner.js"))).default;

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
