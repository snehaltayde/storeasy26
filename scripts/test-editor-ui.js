// The editor in the new shell (docs/plans/phase-2.md "Line 6", package 6a:
// the frame, the page list, the section tree, templates).
//   pnpm test:editor-ui
//   1. the store with readOnly (support): no saveDraft is ever sent, not by
//      autosave, a flush, a backup or the keepalive on pagehide, even when
//      edits are forced
//   2. the page as support, staff and signed out: the props it hands the
//      editor (can, role), the first-store generator only for can.write,
//      another store's doc_ id is not found
//   3. READ_POSTS rows for /admin/editor and /admin/releases: only document
//      reads, never saveDraft; preview-session is storefront.read
//   4. the frame's markup as support and staff: no enabled add, move, hide,
//      copy, delete, new page or archive for support; the three panes, the
//      phone tabs, the tablet preview toggle, the status line, the states
//   5. the page list: groups, badges, the unpublished dot, archived rows
//   6. templates: the list, insert into a page (sections minted fresh,
//      only kinds the page takes)
//   7. the anonymous shopper: a draft is not on the storefront without a
//      preview session
// File databases only; outside services blanked, the network blocked.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-editor-ui-default.db";
process.env.PLATFORM_CACHE_MS = "50";
H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
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
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---- 1. the store, read-only ------------------------------------------------------------
console.log("— 1. the store with readOnly");
const St = await import("../components/admin/editor/store.js");
function fakeApi(doc) {
  const calls = [];
  const keepalives = [];
  return {
    calls,
    keepalives,
    call(op, args, extra) {
      calls.push({ op, args: clone(args), extra: clone(extra) });
      if (op === "getDocument") return Promise.resolve({ ok: true, data: { ok: true, document: doc } });
      if (op === "saveDraft") return Promise.resolve({ ok: true, data: { ok: true, document: { ...doc, revision: doc.revision + 1 }, issues: [] } });
      return Promise.resolve({ ok: true, data: { ok: true } });
    },
    sendKeepalive(op, args, extra) {
      keepalives.push({ op, args: clone(args), extra: clone(extra) });
      return true;
    },
  };
}
function memoryStorage() {
  const m = new Map();
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const textSec = (id, title) => ({ id, kind: "text", v: 1, enabled: true, settings: { title, body: ["Some words."] }, blocks: [] });
const pageBody = (slug, sections) => ({ schema: 1, type: "page", meta: { slug, title: `Page ${slug}`, description: "", enabled: true, effective_at: null, window_start: null, window_end: null, redirect_from: [] }, sections });
const fakeDoc = () => ({ id: "doc_p1", type: "page", slug: "p1", label: "Page p1", body: pageBody("p1", [textSec("sec_t1", "One"), textSec("sec_t2", "Two")]), draftHash: "h3", revision: 3 });
const instantTimers = () => {
  const q = [];
  return { q, setTimeout: (fn) => (q.push(fn), q.length), clearTimeout: () => {}, flush: () => q.splice(0).forEach((f) => f()) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

await t("readOnly: every edit is refused (fields and section operations), the body is unchanged, and no saveDraft is sent by autosave or a flush", async () => {
  const api = fakeApi(fakeDoc());
  const timers = instantTimers();
  const s = St.createDocumentStore({ api, document: fakeDoc(), readOnly: true, timers, pauseMs: 1 });
  await s.open();
  const before = JSON.stringify(s.getState().body);
  eq(
    [s.setField("sections.sec_t1.settings.title", "Changed"), s.insertSection(textSec("sec_new1", "New"), 0), s.removeSection("sec_t2"), s.moveSection("sec_t2", 0), s.setField("meta.title", "x")],
    [false, false, false, false, false],
    "each edit answers false:",
  );
  timers.flush();
  await tick();
  eq(JSON.stringify(s.getState().body), before, "the body:");
  const f = await s.beforeNavigate();
  ok(f.ok, "a flush with nothing to save is fine");
  eq(api.calls.filter((c) => c.op === "saveDraft").length, 0, "saveDraft calls:");
  eq([s.getState().status, s.getState().unacknowledged], ["saved", false], "state:");
});
await t("readOnly: beforeUnload (pagehide) never warns and never calls sendKeepalive, even with forced edits; staff's store does both", async () => {
  const api = fakeApi(fakeDoc());
  const s = St.createDocumentStore({ api, document: fakeDoc(), readOnly: true, timers: instantTimers() });
  await s.open();
  for (let i = 0; i < 5; i++) s.setField("sections.sec_t1.settings.title", `Forced ${i}`);
  eq([s.beforeUnload(), api.keepalives.length], [false, 0], "support:");
  const api2 = fakeApi(fakeDoc());
  const w = St.createDocumentStore({ api: api2, document: fakeDoc(), timers: instantTimers() });
  await w.open();
  w.setField("sections.sec_t1.settings.title", "Typed");
  eq([w.beforeUnload(), api2.keepalives.map((k) => k.op)], [true, ["saveDraft"]], "a writer's store (the same edit):");
});
await t("readOnly: a backup left in this browser is neither offered nor written, so 'Keep them as an earlier draft' can't send anything", async () => {
  const storage = memoryStorage();
  const key = `${St.BACKUP_PREFIX}t1:doc_p1:3`;
  storage.setItem(key, JSON.stringify({ v: 1, baseRevision: 3, savedAt: 1, body: pageBody("p1", [textSec("sec_t1", "From a backup")]) }));
  const api = fakeApi(fakeDoc());
  const s = St.createDocumentStore({ api, document: fakeDoc(), readOnly: true, storage, tenant: "t1", timers: instantTimers() });
  await s.open();
  eq(s.getState().backupOffer, null, "no offer:");
  s.setField("sections.sec_t1.settings.title", "Forced");
  eq([...storage.m.keys()], [key], "storage untouched:");
  await s.acceptBackup();
  eq(api.calls.map((c) => c.op), [], "no request at all:");
});

// ---- 2. the page ------------------------------------------------------------------------
console.log("— 2. the page");
const store = await H.makeRoleStore({ name: "edui" });
const { a, b } = store;
const C = await import("../lib/platform/control.js");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const PAGE = "app/(console)/admin/(authed)/editor/page.js";
const TEMPLATES_PAGE = "app/(console)/admin/(authed)/editor/templates/page.js";
const editorProps = (run) => run.props.find((p) => p.component.endsWith("DocumentEditor#default"))?.props;

await t("as support the editor gets can { write: false, publish: false, offersWrite: false }, its role, readOnly words, and no handlers", async () => {
  const run = await pages.run(PAGE, { cookies: store.cookies.support });
  eq([run.error?.message ?? null, run.unresolved], [null, []]);
  const p = editorProps(run);
  ok(p, `the DocumentEditor: ${run.props.map((x) => x.component)}`);
  eq([p.can, p.role], [{ write: false, publish: false, offersWrite: false }, "support"]);
  ok(Object.values(p).every((v) => typeof v !== "function"), "no handlers:");
});
await t("as staff can is { write: true, publish: false, offersWrite: true }; as the owner all three; signed out goes to the sign-in page", async () => {
  eq(editorProps(await pages.run(PAGE, { cookies: store.cookies.staff })).can, { write: true, publish: false, offersWrite: true }, "staff:");
  eq(editorProps(await pages.run(PAGE, { cookies: store.cookies.owner })).can, { write: true, publish: true, offersWrite: true }, "owner:");
  eq((await pages.run(PAGE, { cookies: {} })).redirect, "/admin/login");
  eq((await pages.run(TEMPLATES_PAGE, { cookies: {} })).redirect, "/admin/login", "templates:");
});
await t("another store's doc_ id opens nothing of that store: the editor gets the home page with a note, never the other document", async () => {
  const c = b.client();
  const other = (await c.execute("SELECT id FROM documents WHERE archived_at IS NULL ORDER BY id LIMIT 1")).rows[0]?.id;
  c.close();
  const id = other ? String(other) : "doc_bonly";
  const ca = a.client();
  const mine = (await ca.execute({ sql: "SELECT count(*) AS n FROM documents WHERE id = ?", args: [id] })).rows[0].n;
  ca.close();
  if (Number(mine) === 0) {
    const p = editorProps(await pages.run(PAGE, { cookies: store.cookies.owner, searchParams: { doc: id } }));
    ok(p.document?.id !== id, `not the other store's document: ${p.document?.id}`);
  }
  const p2 = editorProps(await pages.run(PAGE, { cookies: store.cookies.support, searchParams: { doc: "doc_nothere0000" } }));
  ok(p2.document?.id !== "doc_nothere0000" && typeof p2.note === "string" && p2.note.length > 5, `a note instead: ${JSON.stringify(p2.note)}`);
});

await t("the first-store generator runs only when can.write: support never calls it, staff calls it once (the page compiled with a stubbed generator)", async () => {
  const React = require("react");
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const code = (await swc.transform(read(PAGE), { filename: join(ROOT, PAGE), jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const S = { actor: null, gen: 0 };
  const Authz = await import("../lib/platform/authz.js");
  const stubs = {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "c" }) }) },
    "next/navigation": { redirect: (to) => { throw new Error(`redirect ${to}`); } },
    "@/lib/admin-auth": { adminActor: async () => S.actor, ADMIN_COOKIE: "_a", PLATFORM_COOKIE: "_p" },
    "@/lib/console-request": { tfetch: (fn) => fn() },
    "@/lib/cms-mode": { getCmsMode: async () => "documents" },
    "@/lib/documents/service": { listDocuments: async () => [] },
    "@/lib/admin/editor-entry": await import("../lib/admin/editor-entry.js"),
    "@/lib/admin/entity-entry": { entityEntry: async () => ({}), entityForDocument: async () => null, canEdit: (x) => Authz.roleAllows(x?.role, "storefront.write"), ENTRY_WORDS: { failed: "x", readOnly: "y" } },
    "@/lib/platform/authz": Authz,
    "@/lib/bundles": { bundleCurrency: async () => "INR" },
    "@/lib/log": { slog() {} },
    "@/lib/first-run/generate": { generateFirstStore: async () => (S.gen++, { ran: false }) },
    "@/lib/tenant-context": { currentTenant: () => null },
    "@/lib/themes/palettes": { paletteById: () => ({ brand: {} }), startingPaletteId: () => "slate" },
    "@/components/admin/editor/DocumentEditor": { __esModule: true, default: () => null },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((id) => {
    if (id in stubs) return stubs[id];
    if (id === "react" || id === "react/jsx-runtime") return require(id);
    throw new Error(`the page imports ${id}`);
  }, mod, mod.exports);
  const Page = mod.exports.default;
  for (const [role, want] of [["support", 0], ["staff", 1], ["owner", 1]]) {
    S.actor = { kind: "member", role, id: `u_${role}` };
    S.gen = 0;
    await Page({ searchParams: Promise.resolve({}) });
    eq(S.gen, want, `${role}:`);
  }
  ok(React, "react");
});

// ---- 3. READ_POSTS --------------------------------------------------------------------
console.log("— 3. READ_POSTS");
await t("READ_POSTS rows for /admin/editor and /admin/releases: PUT /api/admin/documents with ops ⊆ DOCUMENT_READS (never saveDraft); preview-session is storefront.read", async () => {
  const { READ_POSTS } = await import("./support/read-controls.js");
  const { ADMIN_ROUTES } = await import("./support/admin-routes.js");
  const { DOCUMENT_READS } = await import("../lib/admin/documents-api.js");
  const rows = READ_POSTS.filter((r) => r.page === "/admin/editor" || r.page === "/admin/releases");
  for (const page of ["/admin/editor", "/admin/releases"]) ok(rows.some((r) => r.page === page && r.path === "/api/admin/documents"), `${page} has a documents row`);
  for (const r of rows.filter((x) => x.path === "/api/admin/documents")) {
    eq(r.method, "PUT", `${r.page} method:`);
    ok(Array.isArray(r.ops) && r.ops.length > 0, `${r.page} lists its ops`);
    eq(r.ops.filter((o) => !DOCUMENT_READS.includes(o)), [], `${r.page} ops outside DOCUMENT_READS:`);
    ok(!r.ops.includes("saveDraft"), `${r.page}: never saveDraft`);
  }
  for (const r of rows.filter((x) => x.path === "/api/admin/preview-session")) eq(r.method, "POST", "preview-session method:");
  const ps = ADMIN_ROUTES.filter((r) => r.path === "preview-session");
  ok(ps.length > 0 && ps.every((r) => r.action === "storefront.read"), `every preview-session variant is storefront.read: ${JSON.stringify(ps.map((r) => [r.method, r.variant, r.action]))}`);
  for (const r of rows) ok(typeof r.reason === "string" && r.reason.length >= 10, "a reason");
});
await t("the shell drill's matcher: a READ_POSTS row with ops passes only a body whose single top-level operation is listed (saveDraft never)", async () => {
  const src = read("scripts/drills/shell/run.mjs");
  ok(/opsOf|bodyOp/.test(src) && /r\.ops/.test(src), "the matcher reads ops:");
  ok(/403/.test(src.slice(src.indexOf("nextLogWrites"))), "the server log counts a 403 on an ops row as a write:");
});

// ---- 4. the frame's markup ---------------------------------------------------------------
console.log("— 4. the frame");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const isJsxFile = (file) => /\/(components|app)\//.test(file) && !/(Model|documentsApi|store|previewMachine)\.js$/.test(file);
const navStub = { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/admin/editor", redirect: () => {} };
const cache = new Map();
async function loadJsx(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  const code = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const local = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (local.has(id) || id === "next/navigation") continue;
    const t0 = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
    if (!t0) continue;
    const target = t0.endsWith(".js") ? t0 : `${t0}.js`;
    local.set(id, isJsxFile(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
  }
  new Function("require", "module", "exports", code)((id) => (id === "next/navigation" ? navStub : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const Editor = await loadJsx(join(ROOT, "components/admin/editor/DocumentEditor.js"));
const Switcher = await loadJsx(join(ROOT, "components/admin/editor/Switcher.js"));
const Tree = (await loadJsx(join(ROOT, "components/admin/editor/tree/SectionTree.js"))).default;
const { TooltipProvider } = await loadJsx(join(ROOT, "components/ui/tooltip.js"));
const h = React.createElement;
const html = (el) => renderToStaticMarkup(h(TooltipProvider, null, el));
const CAN = { owner: { write: true, publish: true, offersWrite: true }, staff: { write: true, publish: false, offersWrite: true }, support: { write: false, publish: false, offersWrite: false } };
const ACCESS = { owner: { canPublish: true, reason: null }, staff: { canPublish: false, reason: "Only the store owner or an admin can publish. You can edit and preview." }, support: { canPublish: false, reason: "Only the store owner or an admin can publish." } };
const homeBody = { schema: 1, type: "home", meta: {}, sections: [textSec("sec_t1", "One"), textSec("sec_t2", "Two")] };
const snap = (role, over = {}) => ({
  id: "doc_home",
  type: "home",
  body: homeBody,
  revision: 3,
  draftHash: "h3",
  document: { id: "doc_home", type: "home", label: "Home page", slug: null, publishedVersionId: "ver_1", publishedHash: "h2", access: ACCESS[role] },
  status: "saved",
  statusWords: "Saved",
  issues: [],
  ackCount: 0,
  ...over,
});
const DOCS = [
  { id: "doc_home", type: "home", label: "Home page", live: true, unpublishedChanges: true, revision: 3 },
  { id: "doc_header", type: "header", label: "Header", live: true, revision: 1 },
  { id: "doc_design", type: "design", label: "Design", live: true, revision: 1 },
  { id: "doc_about", type: "page", slug: "about", label: "About us", live: false, revision: 2 },
  { id: "doc_priv", type: "page", slug: "privacy-policy", label: "Privacy policy", live: true, revision: 1 },
  { id: "doc_gone", type: "page", slug: "old", label: "Old page", live: false, archivedAt: "2026-11-01T00:00:00.000Z", revision: 4 },
];
const view = (role, over = {}) =>
  html(h(Editor.EditorView, { entry: { id: "doc_home", type: "home", label: "Home page" }, load: { status: "ready" }, state: snap(role), docs: DOCS, can: CAN[role], role, preview: h("div", { "data-stub-preview": "" }), ...over }));
const tags = (m, re) => [...m.matchAll(re)].map((x) => x[0]);
const enabledWith = (m, words) => tags(m, /<button[^>]*>[\s\S]*?<\/button>/g).filter((b) => !/disabled=""|aria-disabled="true"/.test(b.slice(0, b.indexOf(">"))) && words.some((w) => b.includes(w)));

await t("support's frame: no enabled Add, Move, Hide, Copy, Delete, New page or Archive; no save line, a read-only line; the tree still lists the sections", () => {
  const m = view("support") + view("support", { showSwitcher: true });
  eq(enabledWith(m, ["Add a section", "Move ", "Hide ", "Copy ", "Delete", "New page", "Archive", "Go back to the live version", "Load theirs", "Keep them as an earlier draft"]), [], "write buttons:");
  ok(!m.includes("data-tree-add") && !m.includes("data-op=") && !m.includes("data-new-page-open") && !m.includes("data-archive="), "no write markers:");
  ok(m.includes('data-save-status="read-only"') && !m.includes('data-save-status="saved"'), "the read-only line:");
  ok((view("support").match(/data-section-row="/g) || []).length === 2 && m.includes("data-page-group"), "the tree and the page list read:");
});
await t("staff's frame: the tree's Add and row buttons, New page and Archive (on a page that isn't live) are there", () => {
  const m = view("staff") + view("staff", { showSwitcher: true });
  ok(m.includes("data-tree-add") && m.includes('data-op="moveUp"') && m.includes('data-op="remove"') && m.includes("data-new-page-open") && m.includes('data-archive="doc_about"'), "writes:");
  ok(!m.includes('data-archive="doc_priv"') && !m.includes('data-archive="doc_home"'), "no Archive on a live page or the home page:");
  ok(m.includes('data-save-status="saved"'), "the save line:");
});
await t("support's tree, rendered alone: rows and select buttons only (every button a marked read); staff's has the five row buttons", () => {
  const sup = html(h(Tree, { type: "home", sections: homeBody.sections, selectedId: "sec_t1", role: "support" }));
  eq(tags(sup, /<button[^>]*>/g).filter((b) => !b.includes("data-read-control")), [], "unmarked buttons:");
  const st = html(h(Tree, { type: "home", sections: homeBody.sections, selectedId: null, role: "staff" }));
  eq((st.match(/data-op="/g) || []).length, 10, "two rows of five:");
});
await t("the frame: three panes (sections, edit, preview), the phone tabs, the tablet preview toggle; the preview mounted once", () => {
  const m = view("owner");
  for (const p of ["sections", "edit", "preview"]) ok(m.includes(`data-pane="${p}"`), `pane ${p}`);
  eq((m.match(/data-stub-preview=""/g) || []).length, 1, "one preview:");
  ok(m.includes("data-editor-tabs") && ["sections", "edit", "preview"].every((p) => m.includes(`data-pane-tab="${p}"`)), "tabs:");
  ok(m.includes("data-tablet-preview"), "the tablet toggle:");
  ok(/data-pane="edit"[^>]*class="[^"]*\bblock\b/.test(m) || /class="[^"]*\bblock\b[^"]*"[^>]*data-pane="edit"/.test(m), "on a phone, Edit shows first:");
  const tab = view("owner", { paneTab: "preview" });
  ok(/class="block [^"]*"[^>]*data-pane="preview"/.test(tab.replace(/<section aria-label="Preview" /, "<section ")), "the Preview tab shows the preview");
});
await t("the states: a skeleton per pane while loading; a failed load with Try again; offline; the conflict banner (Load theirs, Keep mine); a backup offered", () => {
  const loading = view("owner", { state: null, load: { status: "loading" }, preview: null });
  ok((loading.match(/data-pane-skeleton=""/g) || []).length >= 3, "skeletons:");
  const failed = view("owner", { state: null, load: { status: "failed", message: "We couldn't open this page." } });
  ok(failed.includes("data-load-failed") && failed.includes("data-load-retry") && failed.includes("We couldn&#x27;t open this page."), "failed:");
  const off = view("owner", { state: snap("owner", { status: "error", statusWords: "Could not save", error: { code: "NETWORK_ERROR", message: "We couldn't reach Storeasy." } }) });
  ok(off.includes('data-save-status="offline"') && off.includes("Offline."), "offline:");
  const c = view("owner", { state: snap("owner", { status: "conflict", statusWords: "Changed in another tab.", conflict: { words: "Changed in another tab." }, backupOffer: { words: "We found edits that weren't saved." } }) });
  ok(c.includes("data-conflict-banner") && c.includes(">Load theirs<") && c.includes(">Keep mine<") && c.includes("data-backup-offer"), "conflict and backup:");
  const sc = view("support", { state: snap("support", { conflict: { words: "x" }, backupOffer: { words: "y" } }) });
  ok(!sc.includes("data-conflict") && !sc.includes("data-backup-offer"), "support sees neither:");
});
await t("the editor's error page has Try again (reset, no write); the loading page has a skeleton per pane", async () => {
  const Err = (await loadJsx(join(ROOT, "app/(console)/admin/(authed)/editor/error.js"))).default;
  let reset = 0;
  const e = html(h(Err, { error: {}, reset: () => reset++ }));
  ok(e.includes('role="alert"') && e.includes("Try again") && e.includes("data-editor-error"), "the error page:");
  const L = (await loadJsx(join(ROOT, "app/(console)/admin/(authed)/editor/loading.js"))).default;
  ok((html(h(L)).match(/data-slot="skeleton"/g) || []).length >= 8, "the loading page:");
});
await t("no old console part in the 6a files (components/console), and no React warning rendering the frame for every role", () => {
  for (const f of ["components/admin/editor/DocumentEditor.js", "components/admin/editor/Switcher.js", "components/admin/editor/StatusLine.js", "components/admin/editor/tree/SectionTree.js", "components/admin/editor/tree/AddSection.js", "components/admin/editor/templates/TemplatesList.js", "app/(console)/admin/(authed)/editor/templates/page.js"])
    ok(!/from "@\/components\/console\//.test(read(f)), `${f} imports no old console part`);
  const errs = [];
  const orig = console.error;
  console.error = (...x) => errs.push(x.map(String).join(" ").slice(0, 200));
  try {
    for (const role of ["owner", "staff", "support"]) view(role, { showSwitcher: true });
  } finally {
    console.error = orig;
  }
  eq(errs, []);
});

// ---- 4b. the inspector (6b) ----------------------------------------------------------
console.log("— 4b. the inspector");
const heroBody = { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_h1", kind: "hero", v: 1, enabled: true, settings: {}, blocks: [] }, textSec("sec_t1", "One")] };
const inspectorOf = (m) => {
  const at = m.indexOf("data-inspector");
  ok(at >= 0, "the inspector is there");
  return m.slice(m.lastIndexOf("<", at), m.indexOf('data-pane="preview"'));
};
const fieldTags = (m) => tags(m, /<(input|textarea|select)\b[^>]*>/g);
const inspectorView = (role, sel) => view(role, { state: snap(role, { body: heroBody }), selection: sel, pickImage: async () => null });
await t("support's inspector: every field (text, select, textarea) is disabled, and so are the picker's Choose and every Remove; the read-only words show", () => {
  for (const sel of ["sec_h1", "sec_t1"]) {
    const m = inspectorOf(inspectorView("support", sel));
    const fields = fieldTags(m);
    ok(fields.length > 0, `${sel}: fields shown`);
    eq(fields.filter((f) => !/\sdisabled=""/.test(f)), [], `${sel}: enabled fields:`);
    eq(enabledWith(m, ["Choose", "Remove", "Add", "Move ", "Use ", "Reset"]), [], `${sel}: enabled picker or list buttons:`);
    ok(m.includes("You can look at this page but not change it."), `${sel}: the words`);
  }
  const staff = inspectorOf(inspectorView("staff", "sec_h1"));
  ok(fieldTags(staff).some((f) => !/\sdisabled=""/.test(f)) && enabledWith(staff, ["Choose from your library"]).length === 1, "staff can edit and choose");
});
await t("'Create a bundle' shows only with offersWrite; without it the picker says to ask an owner", async () => {
  const B = await loadJsx(join(ROOT, "components/admin/editor/fields/BundleControl.js"));
  const field = { key: "bundle", path: "bundle", label: "Bundle", setting: {} };
  const ctx = (canCreateBundles) => ({ bundles: { status: "ready", items: [] }, canCreateBundles });
  const yes = html(h(B.BundleControl, { field, value: null, onChange() {}, issues: [], context: ctx(true) }));
  const no = html(h(B.BundleControl, { field, value: null, onChange() {}, issues: [], context: ctx(false) }));
  ok(yes.includes("Create a bundle") && !no.includes("Create a bundle") && /Ask an owner/.test(no), `${no.slice(0, 300)}`);
  const lockedPage = view("support", { state: snap("support", { body: heroBody }), selection: "sec_h1" });
  ok(!lockedPage.includes("Create a bundle"), "support's editor never offers it");
});
await t("the 6b files import no old console part (only useToast) and the pickers open in the components/ui dialog", () => {
  const files = ["BundleControl", "DesignForm", "GalleryControl", "MenuControl", "PairsControl", "ProductListControl", "RichTextField", "SettingsForm", "controls", "index"].map((f) => `components/admin/editor/fields/${f}.js`);
  for (const f of [...files, "components/admin/editor/ProductForm.js", "components/admin/editor/CollectionForm.js", "components/admin/shared/MediaPicker.js", "components/admin/shared/RefPicker.js"]) {
    const src = read(f);
    ok(!/from "(@\/components\/console\/(?!Toast")|(\.\.\/)+console\/)/.test(src), `${f}: no old console part`);
    ok(!/\b(text-fg|bg-surface|border-edge|rounded-ctl|focus-ring)\b/.test(src), `${f}: no old tokens`);
  }
  ok(/from "@\/components\/ui\/dialog"/.test(read("components/admin/editor/fields/parts.js")), "parts' Dialog is the ui dialog");
  for (const f of ["components/admin/shared/MediaPicker.js", "components/admin/shared/RefPicker.js"]) ok(/import \{[^}]*\bDialog\b[^}]*\} from "@\/components\/admin\/editor\/fields\/parts"/.test(read(f)), `${f} uses it`);
});

// ---- 4c. preview and publishing (6c) -------------------------------------------------
console.log("— 4c. preview and publishing");
const CLOSED = { state: { phase: "closed", order: [], lists: {}, items: [] }, canConfirm: false, on: {} };
const VERSIONS = { status: "ready", rows: [{ id: "ver_2", kind: "publish", createdAt: "2026-11-02T10:00:00.000Z", by: "Asha", note: null, live: true }, { id: "ver_1", kind: "checkpoint", createdAt: "2026-11-01T10:00:00.000Z", by: "Asha", note: null, live: false }] };
const liveRoute = (role) => snap(role, { id: "doc_about", type: "page", body: { schema: 1, type: "page", meta: { slug: "about", title: "About" }, sections: [] }, document: { ...snap(role).document, id: "doc_about", type: "page", label: "About us", slug: "about" } });
await t("the bar: an owner has Publish and Take offline; staff and support see the publish reason and no Publish, Take offline, Undo or Restore; support's Earlier versions read with no Restore", () => {
  const bar = (role) => view(role, { state: liveRoute(role), publish: CLOSED, versions: VERSIONS, on: { restore() {} } });
  const owner = bar("owner");
  ok(/<button[^>]*>Publish<\/button>/.test(owner) && owner.includes("Take this page offline") && !owner.includes("data-publish-reason"), "owner: Publish and Take offline");
  for (const role of ["staff", "support"]) {
    const m = bar(role);
    eq(enabledWith(m, ["Publish", "Take this page offline", "Undo", ...(role === "support" ? ["Restore"] : [])]), [], `${role}: publish buttons:`);
    ok(!/<button[^>]*>(Publish|Take this page offline|Undo)<\/button>/.test(m), `${role}: none at all, not even disabled`);
    ok(m.includes("data-publish-reason") && m.includes(ACCESS[role].reason), `${role}: the reason`);
  }
  ok(bar("staff").includes(">Restore to draft<"), "staff can restore a version to the draft (storefront.write)");
  const sup = bar("support");
  ok(sup.includes("data-earlier-versions") && sup.includes("Live now") && !sup.includes("Restore"), "support: the versions, no Restore");
  // a page whose access says yes, for a session whose can.publish is false: the page wins
  ok(view("support", { state: snap("owner"), publish: CLOSED }).includes("data-publish-reason"), "can.publish false wins over the document's access");
});
await t("the preview bar: device widths 375/768/1280, Show design changes, Reload, Open in a new tab; every control a marked read; on the design itself the colours stay on", async () => {
  const P = await loadJsx(join(ROOT, "components/admin/editor/PreviewPane.js"));
  eq(P.DEVICES.map((d) => d.width), [375, 768, 1280], "widths:");
  const api = { startDocumentsPreview: async () => ({ ok: true, sid: "ps_0000000000000000" }), setShowDesign: async () => ({ ok: true }) };
  const m = html(h(P.default, { api, documentId: "doc_home", path: "/", label: "Home page" }));
  for (const d of ["phone", "tablet", "desktop"]) ok(m.includes(`data-device="${d}"`), `device ${d}`);
  ok(m.includes("data-show-design") && m.includes("Show design changes") && m.includes("data-preview-reload") && /<a [^>]*href="\/"[^>]*target="_blank"/.test(m), "the bar's controls");
  ok(m.includes('data-preview-device="desktop"') && m.includes("data-preview-frame"), "desktop first, the frame");
  const controls = tags(m, /<(button|a|label)\b[^>]*>/g);
  eq(controls.filter((c) => !c.includes("data-read-control")), [], "unmarked controls:");
  const design = html(h(P.default, { api, documentId: "doc_design", path: "/", label: "Design" }));
  const sw = tags(design, /<button[^>]*data-show-design[^>]*>/g)[0] || "";
  ok(/disabled=""/.test(sw) && /aria-checked="true"/.test(sw), `on the design the switch is on and fixed: ${sw}`);
});
await t("Publishing: Waiting to publish lists drafts (never published, or changed) with links into the editor; an owner ticks and publishes selected; staff and support see the reason, no boxes, no button", async () => {
  const W = await loadJsx(join(ROOT, "components/admin/releases/WaitingList.js"));
  const rows = W.waitingRows(DOCS);
  eq(rows.map((r) => r.id).sort(), ["doc_about", "doc_home"], "the drafts (archived, live and system documents left out):");
  const owner = html(h(W.default, { documents: DOCS, access: ACCESS.owner, call: async () => ({}) }));
  ok((owner.match(/data-waiting-select=""/g) || []).length === 2 && /<button[^>]*disabled=""[^>]*>Publish selected<\/button>/.test(owner), "owner: boxes, Publish selected off until one is ticked");
  ok(owner.includes('href="/admin/editor?doc=doc_about"'), "rows link into the editor");
  for (const role of ["staff", "support"]) {
    const m = html(h(W.default, { documents: DOCS, access: ACCESS[role], call: async () => ({}) }));
    ok(!m.includes("data-waiting-select") && !m.includes("<button") && m.includes(ACCESS[role].reason), `${role}: the reason only`);
    eq(tags(m, /<a [^>]*>/g).filter((a) => !a.includes("data-read-control")), [], `${role}: every link a marked read`);
  }
  ok(html(h(W.default, { documents: [], access: ACCESS.owner })).includes("Nothing is waiting to publish"), "empty");
  const R = await loadJsx(join(ROOT, "components/admin/editor/publish/RecentlyPublished.js"));
  const row = { logId: "log_1", setId: "set_1", documentId: "doc_home", label: "Home page", action: "publish", actionWords: "Published", byName: "Asha", at: "2026-11-02T10:00:00.000Z", summary: [], canUndo: true, undo: { id: "doc_home", revision: 3, logId: "log_1" } };
  const sup = html(h(R.default, { rows: [row], call: async () => ({}), access: ACCESS.support, editorHref: (id) => `/admin/editor?doc=${id}` }));
  ok(!/<button/.test(sup) && sup.includes("data-undo-reason") && sup.includes("data-read-control"), "support's Recently published: the reason, no Undo; the editor link a marked read");
});
await t("the releases page: owner, staff and support get their access; signed out goes to the login; the loading page has skeletons", async () => {
  const Authz = await import("../lib/platform/authz.js");
  const seen = [];
  let actor = null;
  const stubs = {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "c" }) }) },
    "next/navigation": { redirect: (to) => { throw Object.assign(new Error("redirect"), { to }); } },
    "@/lib/admin-auth": { adminActor: async () => actor, ADMIN_COOKIE: "_a", PLATFORM_COOKIE: "_p" },
    "@/lib/platform/authz": Authz,
    "@/lib/console-request": { tfetch: (fn) => fn() },
    "@/components/kit/page-header": { PageHeader: () => null },
    "@/components/admin/releases/PublishingPage": { __esModule: true, default: (p) => (seen.push(p.access), null) },
  };
  const file = join(ROOT, "app/(console)/admin/(authed)/releases/page.js");
  const code = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : require(id)), mod, mod.exports);
  const Page = mod.exports.default;
  for (const role of ["owner", "staff", "support"]) {
    actor = { kind: "member", role };
    renderToStaticMarkup(await Page());
  }
  eq(seen.map((a) => a.canPublish), [true, false, false], "canPublish:");
  ok(seen[1].reason.includes("You can edit") && !seen[2].reason.includes("You can edit"), "staff and support each get their own reason");
  actor = null;
  let to = null;
  await Page().catch((e) => (to = e.to));
  eq(to, "/admin/login", "signed out:");
  const L = (await loadJsx(join(ROOT, "app/(console)/admin/(authed)/releases/loading.js"))).default;
  ok((html(h(L)).match(/data-slot="skeleton"/g) || []).length >= 6, "the loading page");
});
await t("the 6c files import no old console part and use no old tokens", () => {
  const files = ["components/admin/editor/PreviewPane.js", ...["PublishPanel", "EarlierVersions", "RecentlyPublished", "TakeOfflineConfirm", "UndoNotice"].map((f) => `components/admin/editor/publish/${f}.js`), ...["PublishingPage", "WaitingList", "PublishingHistory"].map((f) => `components/admin/releases/${f}.js`), "app/(console)/admin/(authed)/releases/page.js", "app/(console)/admin/(authed)/releases/loading.js"];
  for (const f of files) {
    const src = read(f);
    ok(!/from "(@\/components\/console\/|(\.\.\/)+console\/)/.test(src), `${f}: no old console part`);
    ok(!/\b(text-fg|bg-surface|border-edge|divide-edge|rounded-ctl|rounded-card|focus-ring)\b/.test(src), `${f}: no old tokens`);
  }
  ok(!/export function PublishingHistory/.test(read("components/admin/editor/DocumentEditor.js")), "PublishingHistory moved out of DocumentEditor.js");
});

// ---- 5. the page list -------------------------------------------------------------------
console.log("— 5. the page list");
await t("pageGroups: Home, Pages, Header and footer, Design, Policies in order; Live or Draft, the unpublished dot; archived only with the switch", () => {
  const g = Switcher.pageGroups({ documents: DOCS, openId: "doc_home" });
  eq(g.map((x) => [x.key, x.rows.map((r) => r.id)]), [["home", ["doc_home"]], ["pages", ["doc_about"]], ["chrome", ["doc_header"]], ["design", ["doc_design"]], ["policies", ["doc_priv"]]]);
  const home = g[0].rows[0];
  eq([home.live, home.changed, home.open, home.canArchive], [true, true, true, false], "home:");
  eq(g[1].rows[0].canArchive, true, "a draft page can be archived:");
  const all = Switcher.pageGroups({ documents: DOCS, showArchived: true });
  const gone = all.flatMap((x) => x.rows).find((r) => r.id === "doc_gone");
  eq([gone?.archived, gone?.canArchive], [true, false], "an archived page with the switch:");
  eq(Switcher.pageGroups({ documents: DOCS, query: "priv" }).map((x) => x.key), ["policies"], "search:");
});
await t("isPolicyPage agrees with lib/documents/policy-pages.js kindOfSlug", async () => {
  const { kindOfSlug } = await import("../lib/documents/policy-pages.js");
  for (const slug of ["privacy", "privacy-policy", "terms", "refunds", "returns", "about", "shipping", "", null]) eq(Switcher.isPolicyPage({ type: "page", slug }), kindOfSlug(slug) !== null, `${slug}:`);
});
await t("rendered: the badges, the dot and the archived switch; an archived row can't be opened", () => {
  const m = html(h(Switcher.SwitcherView, { documents: DOCS, openId: "doc_home", role: "owner", showArchived: true }));
  ok(m.includes('data-doc-state="live"') && m.includes('data-doc-state="draft"') && m.includes('data-doc-state="archived"'), "badges:");
  ok((m.match(/data-unpublished=""/g) || []).length === 1, "one dot:");
  ok(/<button[^>]*disabled=""[^>]*data-switcher-doc="doc_gone"/.test(m), "the archived row is disabled");
  ok(m.includes("data-switcher-archived") && m.includes("Show archived pages"), "the switch:");
});

// ---- 6. templates -----------------------------------------------------------------------
console.log("— 6. templates");
const ST = await import("../lib/admin/saved-templates.js");
await t("sectionsFromTemplate: fresh ids not already on the page; kinds the page doesn't take are left out with a note", () => {
  const tpl = { id: "t1", name: "Launch", family: "page", sections: JSON.stringify([{ type: "text", title: "Hi", body: "Words" }, { type: "faq", items: [] }]) };
  const a1 = ST.sectionsFromTemplate(tpl, "page", { taken: ["sec_t1"] });
  const a2 = ST.sectionsFromTemplate(tpl, "page");
  ok(a1.sections.length >= 1, `sections: ${JSON.stringify(a1)}`);
  ok(a1.sections.every((s) => !["sec_t1"].includes(s.id)) && a1.sections.every((s, i) => s.id !== a2.sections[i]?.id), "fresh ids each time:");
  const onHeader = ST.sectionsFromTemplate(tpl, "header");
  eq(onHeader.sections.length, 0, "a header takes none:");
  ok(onHeader.notes.some((n) => /left out/.test(n)), "and says so:");
});
await t("TemplatesList: a writer gets Make a page and Insert into a page; support gets the list only", async () => {
  const TL = await loadJsx(join(ROOT, "components/admin/editor/templates/TemplatesList.js"));
  const tpls = [{ id: "tpl_1", name: "Launch", family: "page", sections: [{}, {}] }];
  const pagesList = [{ id: "doc_about", label: "About us" }];
  const w = html(h(TL.default, { templates: tpls, pages: pagesList, role: "staff", api: { call: async () => ({}) } }));
  ok(w.includes("data-make-page") && w.includes("data-insert-template") && w.includes("data-insert-target"), "writer:");
  const s = html(h(TL.default, { templates: tpls, pages: pagesList, role: "support", api: { call: async () => ({}) } }));
  ok(s.includes("Launch") && !s.includes("data-make-page") && !s.includes("data-insert") && !/<button/.test(s), "support:");
});
await t("insertIntoPage: the template's sections go to the end of the page's draft through saveDraft on its revision; a refusal says so", async () => {
  const TL = await loadJsx(join(ROOT, "components/admin/editor/templates/TemplatesList.js"));
  const doc = { id: "doc_about", type: "page", revision: 4, body: pageBody("about", [textSec("sec_t1", "One")]) };
  const calls = [];
  const api = { call: async (op, args, extra) => (calls.push({ op, args, extra }), op === "getDocument" ? { ok: true, data: { document: doc } } : { ok: true, data: { document: doc } }) };
  const tpl = { id: "tpl_1", name: "Launch", family: "page", sections: JSON.stringify([{ type: "text", title: "Hi", body: "Words" }]) };
  const r = await TL.insertIntoPage(api, tpl, "doc_about");
  eq([r.ok, r.href, calls.map((c) => c.op), calls[1].extra], [true, "/admin/editor?doc=doc_about", ["getDocument", "saveDraft"], { revision: 4 }]);
  const sent = calls[1].args.body.sections;
  eq([sent.length, sent[0].id], [1 + r.added, "sec_t1"], "added at the end:");
  const no = await TL.insertIntoPage({ call: async (op) => (op === "getDocument" ? { ok: true, data: { document: doc } } : { error: true, message: "Refused." }) }, tpl, "doc_about");
  eq([no.ok, no.message], [false, "Refused."]);
});

// ---- 7. the anonymous shopper -------------------------------------------------------------
console.log("— 7. the anonymous shopper");
await t("a draft page made in the editor is not on the storefront without a preview session", async () => {
  const r = await store.call("owner", "documents", "PUT", { body: { createDocument: { type: "page", meta: { title: "Draft only", slug: "draft-only-ui" }, body: null, entityId: null } } });
  eq(r.status, 200, `created: ${JSON.stringify(r.body).slice(0, 200)}`);
  const Res = await import("../lib/content/resolve.js");
  eq(await a.run(() => Res.resolvedContentPage("draft-only-ui")), null, "the shopper's read:");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
await store.cleanup?.();
process.exit(fail ? 1 : 0);
