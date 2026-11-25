// Phase 6 step 0 suite (docs/plans/phase-6.md): the studio's contract.
//   1. unit: components/admin/studio/studioModel.js (touched, undo/redo with
//      its 50-step cap, restoreOps against the real document store,
//      orderMessage);
//   2. rendered: app/(console)/admin/(authed)/studio/page.js compiled with
//      Next's own SWC and called as a server component with its data stubbed:
//      every role, signed out, the redirects of product and collection
//      content, another store's document id, a store not in documents mode;
//   3. rendered: the studio shell (Studio.js and its slots) per role:
//      support and operator support get no write control, staff no Publish;
//   4. the nav item and the console's page table.
// The instant order and tokens messages are covered in test-preview-frame.
//   pnpm test:studio
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

// ---- 1. studioModel ---------------------------------------------------------------
console.log("— studioModel");
const M = await import("../components/admin/studio/studioModel.js");
const St = await import("../components/admin/editor/store.js");
const Reg = await import("../lib/registry/index.js");

const body = (titles) => ({ settings: {}, sections: titles.map((x, i) => ({ ...Reg.newSection("rich_text", { id: `sec_${i}` }), settings: { title: x } })) });

await t("unit: touched lists each document this session changed once, in the order first touched; record touches too", () => {
  const m = M.createStudioModel();
  eq(m.touched(), [], "fresh:");
  m.touch("doc_home");
  m.touch("doc_design");
  m.touch("doc_home");
  m.touch("");
  m.touch(null);
  eq(m.touched(), ["doc_home", "doc_design"], "touched:");
  m.record({ docId: "doc_ab", before: { a: 1 }, after: { a: 2 } });
  eq(m.touched(), ["doc_home", "doc_design", "doc_ab"], "record touches:");
  ok(m.isTouched("doc_ab") && !m.isTouched("doc_footer"), "isTouched:");
  eq(m.getSnapshot().touched, ["doc_home", "doc_design", "doc_ab"], "snapshot:");
  ok(m.getSnapshot() === m.getSnapshot(), "the snapshot is stable between changes");
});

await t("unit: undo and redo walk the steps across documents; a new step clears redo; an unchanged step or one without a document is not recorded; steps are copies", () => {
  const m = M.createStudioModel();
  let calls = 0;
  const off = m.subscribe(() => calls++);
  const b0 = body(["One"]);
  const b1 = body(["Two"]);
  eq(m.record({ docId: "doc_home", before: b0, after: b0 }), false, "unchanged:");
  eq(m.record({ before: b0, after: b1 }), false, "no document:");
  ok(!m.canUndo() && !m.canRedo(), "nothing to undo:");
  eq(m.undo(), null, "undo on empty:");
  ok(m.record({ docId: "doc_home", before: b0, after: b1 }), "recorded");
  b1.sections[0].settings.title = "mutated later";
  ok(m.record({ docId: "doc_design", before: { brand: { accent: "#111111" } }, after: { brand: { accent: "#222222" } } }), "recorded 2");
  const u1 = m.undo();
  eq([u1.docId, u1.before.brand.accent], ["doc_design", "#111111"], "undo 1:");
  const u2 = m.undo();
  eq([u2.docId, u2.after.sections[0].settings.title], ["doc_home", "Two"], "undo 2 is the copy, not the mutated body:");
  ok(!m.canUndo() && m.canRedo(), "redo available:");
  eq(m.redo().docId, "doc_home", "redo 1:");
  m.record({ docId: "doc_home", before: b0, after: body(["Three"]) });
  ok(!m.canRedo(), "a new step clears redo");
  eq(m.getSnapshot().undo, 2, "two steps:");
  ok(calls >= 6, `listeners told: ${calls}`);
  off();
});

await t("unit: history keeps the last 50 steps (HISTORY_LIMIT)", () => {
  eq(M.HISTORY_LIMIT, 50, "limit:");
  const m = M.createStudioModel();
  for (let i = 0; i < 60; i++) m.record({ docId: "doc_home", before: { n: i }, after: { n: i + 1 } });
  let n = 0;
  let last = null;
  while (m.canUndo()) {
    last = m.undo();
    n++;
  }
  eq([n, last.before.n], [50, 10], "50 steps, the oldest kept is the 11th:");
});

await t("unit: undo restores the body: restoreOps written through the real document store's setField turns the edited body back into the step's before (and redo into its after), with no save sent before the pause", async () => {
  const doc = { id: "doc_home", type: "home", slug: null, label: "Home page", body: body(["One", "Two"]), revision: 3, draftHash: "h3" };
  const sent = [];
  const api = { call: async (op, args) => (sent.push(op), { ok: true, data: { ok: true, document: { ...doc, body: args?.body ?? doc.body } } }), sendKeepalive() {} };
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const s = St.createDocumentStore({ api, document: doc, timers, now: () => 0 });
  const m = M.createStudioModel();
  const change = (fn) => {
    const before = s.getState().body;
    fn();
    m.record({ docId: "doc_home", before, after: s.getState().body });
  };
  change(() => s.setField("sections.sec_0.settings.title", "Changed"));
  change(() => s.moveSection("sec_1", 0));
  change(() => s.setField("settings.seo_title", "New"));
  const edited = JSON.stringify(s.getState().body);
  for (let i = 0; i < 3; i++) {
    const st = m.undo();
    for (const o of M.restoreOps(s.getState().body, st.before)) s.setField(o.path, o.value);
  }
  eq(s.getState().body, doc.body, "undone to the opened body:");
  for (let i = 0; i < 3; i++) {
    const st = m.redo();
    for (const o of M.restoreOps(s.getState().body, st.after)) s.setField(o.path, o.value);
  }
  eq(JSON.stringify(s.getState().body), edited, "redone:");
  eq(sent.filter((op) => op === "publish" || op === "publishSet"), [], "undo never publishes:");
  eq(M.restoreOps({ a: 1, b: 2 }, { a: 1, c: 3 }), [{ path: "b", value: undefined }, { path: "c", value: 3 }], "restoreOps keys:");
});

await t("unit: orderMessage gives the frame's storeasy:order for a body: ids in order, hidden = disabled or hidden on both screens", () => {
  const b = body(["A", "B", "C"]);
  b.sections[1].enabled = false;
  eq(M.orderMessage("doc_home", b), { type: "storeasy:order", doc: "doc_home", ids: ["sec_0", "sec_1", "sec_2"], hidden: ["sec_1"] });
  eq(M.orderMessage("doc_x", null), { type: "storeasy:order", doc: "doc_x", ids: [], hidden: [] }, "no body:");
});

// ---- the loader -------------------------------------------------------------------
// As test-editor-routes: each file compiled with Next's SWC to CommonJS;
// relative and "@/" imports load the same way, stubs replace the request and
// the data.
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
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const code = await compile(file);
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
  return load;
}

// ---- 2. the page ------------------------------------------------------------------
console.log("— the studio page");
const AUTHED = join(ROOT, "app/(console)/admin/(authed)");
const E = await import("../lib/admin/editor-entry.js");
const { roleAllows } = await import("../lib/platform/authz.js");
class Redirect extends Error {
  constructor(to) {
    super(`NEXT_REDIRECT ${to}`);
    this.to = to;
  }
}
const CANARY = "doc_otherstorecanary1";
const DOCS = [
  { id: "doc_home", type: "home", slug: null, label: "Home page" },
  { id: "doc_design", type: "design", slug: null, label: "Brand" },
  { id: "doc_aaaaaaaaaaaaaaaa", type: "page", slug: "about", label: "About us" },
  { id: "doc_pc1", type: "product_content", slug: null, label: "Serum content" },
];
const S = { actor: null, mode: "documents", docs: DOCS, docsReads: 0 };
const ROLES = {
  owner: { kind: "member", role: "owner" },
  admin: { kind: "member", role: "admin" },
  staff: { kind: "member", role: "staff" },
  support: { kind: "member", role: "support" },
  "operator-support": { kind: "operator-support", id: "op_1", role: "support", grantId: "sg_1" },
};
const marker = (name) => (props) => React.createElement("div", { "data-stub": name, "data-props": JSON.stringify(props ?? {}) });
const pageStubs = {
  "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
  "next/navigation": {
    redirect: (to) => {
      throw new Redirect(to);
    },
  },
  "@/lib/admin-auth": { adminActor: async () => S.actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform", SUPPORT_COOKIE: "_support" },
  "@/lib/console-request": { tfetch: (fn) => fn() },
  "@/lib/cms-mode": {
    getCmsMode: async () => {
      if (S.mode !== "documents") throw Object.assign(new Error("Something is wrong with this store's setup on our side"), { code: "STORE_MODE_INVALID" });
      return S.mode;
    },
  },
  "@/lib/documents/service": { listDocuments: async () => (S.docsReads++, S.docs) },
  "@/lib/admin/editor-entry": E,
  "@/lib/admin/entity-entry": { canEdit: (actor) => roleAllows(actor?.role, "storefront.write") },
  "@/lib/platform/authz": { roleAllows },
  "@/lib/log": { slog() {} },
  "@/lib/tenant-context": { currentTenant: () => ({ config: {} }) },
  "@/lib/themes/palettes": await import("../lib/themes/palettes.js"),
  "@/components/admin/studio/Studio": { __esModule: true, default: marker("Studio") },
};
const loadPage = world(pageStubs);
const Page = (await loadPage(join(AUTHED, "studio/page.js"))).default;
async function run(actor, query = {}, { docs = DOCS, mode = "documents" } = {}) {
  Object.assign(S, { actor, docs, mode, docsReads: 0 });
  try {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
    const m = /data-stub="Studio" data-props="([^"]*)"/.exec(html);
    const props = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x27;/g, "'")) : null;
    return { html, props };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    throw e;
  }
}

await t("rendered: /admin/studio opens for every console role with can = {write: storefront.write, publish: storefront.publish}: owner and admin both, staff write only, support and operator support neither; signed out goes to /admin/login", async () => {
  const want = { owner: [true, true], admin: [true, true], staff: [true, false], support: [false, false], "operator-support": [false, false] };
  for (const [name, actor] of Object.entries(ROLES)) {
    const r = await run(actor);
    ok(r.props, `${name}: no studio: ${r.redirect || r.html?.slice(0, 200)}`);
    eq([r.props.can.write, r.props.can.publish], want[name], `${name} can:`);
    eq(r.props.document?.id, "doc_home", `${name} opens home:`);
    eq(r.props.role, actor.role, `${name} role:`);
    ok(r.props.startingBrand && typeof r.props.startingBrand.accent === "string", `${name} startingBrand:`);
  }
  eq((await run(null)).redirect, "/admin/login", "signed out:");
  const src = await readFile(join(AUTHED, "studio/page.js"), "utf8");
  ok(/export const runtime = "nodejs"/.test(src) && /export const dynamic = "force-dynamic"/.test(src), "nodejs and dynamic");
});

await t("rendered: ?doc= and ?path= open that document; product and collection content redirect to /admin/editor (?product=, ?collection= and a ?doc= of an entity document)", async () => {
  const owner = ROLES.owner;
  eq((await run(owner, { doc: "doc_design" })).props.document.id, "doc_design", "?doc=:");
  eq((await run(owner, { path: "/about" })).props.document.id, "doc_aaaaaaaaaaaaaaaa", "?path=:");
  const gid = "gid://shopify/Product/123";
  eq((await run(owner, { product: gid })).redirect, `/admin/editor?product=${encodeURIComponent(gid)}`, "?product=:");
  const cgid = "gid://shopify/Collection/9";
  eq((await run(ROLES.support, { collection: cgid })).redirect, `/admin/editor?collection=${encodeURIComponent(cgid)}`, "?collection= (support too):");
  eq((await run(owner, { doc: "doc_pc1" })).redirect, "/admin/editor?doc=doc_pc1", "entity ?doc=:");
});

await t("rendered: another store's document id opens this store's home with the note and never names it; the documents read is this store's own", async () => {
  for (const name of ["owner", "support", "operator-support"]) {
    const r = await run(ROLES[name], { doc: CANARY });
    ok(r.props, `${name}: rendered`);
    eq(r.props.document.id, "doc_home", `${name} opens home:`);
    ok(typeof r.props.note === "string" && r.props.note.length > 0, `${name} note:`);
    ok(!r.html.includes(CANARY), `${name}: the canary id is in the page`);
    eq(S.docsReads, 1, `${name} one documents read:`);
  }
});

await t("rendered: a writer's store with no home page goes to /admin/editor (which makes the starting store); support still opens the studio; a store not in documents mode is STORE_MODE_INVALID", async () => {
  const noHome = DOCS.filter((d) => d.id !== "doc_home");
  eq((await run(ROLES.owner, {}, { docs: noHome })).redirect, "/admin/editor", "owner:");
  eq((await run(ROLES.staff, {}, { docs: noHome })).redirect, "/admin/editor", "staff:");
  ok((await run(ROLES.support, {}, { docs: noHome })).props, "support opens the studio");
  let code = null;
  try {
    await run(ROLES.owner, {}, { mode: "legacy" });
  } catch (e) {
    code = e.code;
  }
  eq(code, "STORE_MODE_INVALID", "legacy:");
});

// ---- 3. the shell -----------------------------------------------------------------
console.log("— the studio shell");
const shellStubs = {
  "next/navigation": { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/admin/studio" },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
};
const loadShell = world(shellStubs);
const StudioMod = await loadShell(join(ROOT, "components/admin/studio/Studio.js"));
const Rail = (await loadShell(join(ROOT, "components/admin/studio/SectionsRail.js"))).default;
const TopBar = await loadShell(join(ROOT, "components/admin/studio/StudioTopBar.js"));
const DesignRail = (await loadShell(join(ROOT, "components/admin/studio/DesignRail.js"))).default;
const can = (role) => ({ write: roleAllows(role, "storefront.write"), publish: roleAllows(role, "storefront.write") && roleAllows(role, "storefront.publish") });
const studioFor = (role) => ({
  can: can(role),
  role,
  readOnly: !can(role).write,
  history: { undo: 1, redo: 1, touched: [] },
  selection: null,
  state: { id: "doc_home", type: "home", body: body(["Hello", "World"]), issues: [] },
  undo() {},
  redo() {},
  select() {},
  treeChange() {},
  openDocument() {},
});
const WRITE_MARKS = ["data-studio-undo", "data-studio-redo", "data-studio-publish", "Move Rich text", "Hide Rich text", "Copy Rich text", "Delete Rich text"];

await t("rendered: the whole Studio renders the real PreviewPane (fill) in the centre, the rails' tabs and the inspector, for every role", () => {
  for (const role of ["owner", "staff", "support"]) {
    const html = renderToStaticMarkup(React.createElement(StudioMod.default, { document: { id: "doc_home", type: "home", label: "Home page" }, can: can(role), role }));
    ok(html.includes("data-studio=\"\"") && html.includes("data-preview-pane") && html.includes("data-preview-frame"), `${role}: shell with the preview`);
    ok(html.includes('data-studio-tab="sections"') && html.includes('data-studio-tab="design"') && html.includes("data-studio-inspector"), `${role}: tabs and inspector`);
    ok(!/data-preview-stage="" class="[^"]*h-\[70vh\]/.test(html), `${role}: the preview fills (no 70vh stage)`);
    ok(html.includes("Exit studio"), `${role}: exit`);
    eq(html.includes("data-studio-readonly"), role === "support", `${role}: read-only mark`);
  }
});

await t("rendered: support and operator support (role support) get no write control: no undo, redo or publish, no tree buttons that write, a read-only inspector note; staff get undo and the tree but no Publish (\"Ask an admin to publish.\"); owner and admin get Publish", () => {
  for (const role of ["owner", "admin", "staff", "support"]) {
    const st = studioFor(role);
    const top = renderToStaticMarkup(React.createElement(TopBar.default, { studio: st, label: "Home page" }));
    const rail = renderToStaticMarkup(React.createElement(Rail, { studio: st }));
    const html = top + rail;
    if (role === "support") {
      for (const mark of WRITE_MARKS) ok(!html.includes(mark), `support: ${mark}`);
      ok(!html.includes(TopBar.TOP_WORDS.askAdmin), "support: no ask-admin line either");
      ok(rail.includes("Hello"), "support still reads the sections");
    } else {
      for (const mark of ["data-studio-undo", "data-studio-redo", "Move Rich text", "Hide Rich text", "Delete Rich text"]) ok(html.includes(mark), `${role}: ${mark}`);
      eq(html.includes("data-studio-publish"), role !== "staff", `${role} publish:`);
      eq(html.includes(TopBar.TOP_WORDS.askAdmin), role === "staff", `${role} ask admin:`);
    }
  }
  const support = renderToStaticMarkup(React.createElement(StudioMod.default, { document: { id: "doc_home", type: "home", label: "Home page" }, can: { write: false, publish: false }, role: "support" }));
  for (const mark of WRITE_MARKS) ok(!support.includes(mark), `support studio: ${mark}`);
  // an inconsistent can never shows Publish without write
  const odd = renderToStaticMarkup(React.createElement(StudioMod.default, { document: { id: "doc_home", type: "home", label: "Home page" }, can: { write: false, publish: true }, role: "support" }));
  ok(!odd.includes("data-studio-publish"), "publish without write");
  ok(renderToStaticMarkup(React.createElement(DesignRail, { studio: studioFor("support") })).includes("data-studio-design"), "the Design tab renders (its controls: test-studio-tokens)");
});

await t("source: the studio's writes go through the read-only api and store without storefront.write; the slots get one `studio` prop", async () => {
  const src = await readFile(join(ROOT, "components/admin/studio/Studio.js"), "utf8");
  ok(src.includes("canWrite ? givenApi : readOnlyApi(givenApi)"), "readOnlyApi");
  ok(src.includes("readOnly: !canWrite"), "a read-only store");
  ok(src.includes("<SectionsRail studio={studio} />") && src.includes("<DesignRail studio={studio} />") && src.includes("<StudioTopBar studio={studio}"), "slots");
  ok(src.includes("onFrame={(p) => (postRef.current = p)}") && src.includes("fill"), "PreviewPane fill and onFrame");
});

// ---- 4. nav and pages -------------------------------------------------------------
console.log("— nav");
const Nav = await import("../lib/admin/nav.js");
const { ADMIN_PAGES } = await import("./support/admin-pages.js");
await t("nav: the editor item reads Studio and opens /admin/studio for every role; the studio has its page row", () => {
  const item = Nav.navItems(Nav.NAV).find((i) => i.id === "editor");
  eq([item.label, item.href, item.page, item.action], ["Studio", "/admin/studio", "studio", "storefront.read"], "item:");
  for (const role of ["owner", "admin", "staff", "support"]) ok(Nav.navItems(Nav.navFor(role)).some((i) => i.href === "/admin/studio"), `${role} sees Studio`);
  ok(ADMIN_PAGES.some((r) => r.page === "studio" && r.action === "storefront.read"), "page row");
  eq(Nav.activeItem("/admin/studio", Nav.navItems(Nav.NAV))?.id, "editor", "active:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
