// Phase 6 line 1 suite (docs/plans/phase-6.md "Line 1"): dragging sections in
// the studio.
//   1. unit: components/admin/editor/tree/dragModel.js: the pointer's index at
//      the edges and in a scaled pane, refused spots (the registry's reason),
//      the keyboard hold (pick up, move, drop, cancel), the exact live-region
//      words, no pick-up without storefront.write, the rail's auto-scroll;
//   2. rendered: SectionTree with `draggable` per role (handles "Reorder
//      <label>", insert points "Add a section here", disabled during a 409),
//      and without it exactly as the editor had it (no handle, no insert
//      point); SectionsRail's live region and its order posts;
//   3. unit: the studio's publish plan (StudioPublishDialog's publishRows,
//      createPublishRun, fixesOf) and the top bar's undo keys.
//   pnpm test:studio-drag
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
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

const D = await import("../components/admin/editor/tree/dragModel.js");
const Reg = await import("../lib/registry/index.js");
const sec = (kind, id, title) => ({ ...Reg.newSection(kind, { id }), ...(title ? { settings: { ...Reg.newSection(kind, { id }).settings, title } } : {}) });
// a home page of six: Hero first (it may only be first), then five text sections
const SIX = [sec("hero", "sec_hero"), sec("rich_text", "sec_a", "A"), sec("rich_text", "sec_b", "B"), sec("rich_text", "sec_c", "C"), sec("rich_text", "sec_d", "D"), sec("rich_text", "sec_e", "E")];
const ids = (list) => list.map((s) => s.id);
const ROWS = [0, 1, 2, 3, 4, 5].map((i) => ({ top: 100 + i * 40, height: 40 })); // client px

// ---- 1. dragModel ---------------------------------------------------------------
console.log("— dragModel");
await t("unit: indexAt: above the first row is 0, below the last is n-1, a row's midpoint decides, the dragged row's own slot is skipped", () => {
  eq(D.indexAt({ y: -500, rows: ROWS, from: 2 }), 0, "far above:");
  eq(D.indexAt({ y: 99, rows: ROWS, from: 2 }), 0, "top edge:");
  eq(D.indexAt({ y: 5000, rows: ROWS, from: 2 }), 5, "far below:");
  eq(D.indexAt({ y: 339, rows: ROWS, from: 2 }), 5, "bottom edge:");
  eq(D.indexAt({ y: 2 * 40 + 100 + 20, rows: ROWS, from: 2 }), 2, "on its own row: stays:");
  eq(D.indexAt({ y: 3 * 40 + 100 + 21, rows: ROWS, from: 2 }), 3, "past row 3's midpoint:");
  eq(D.indexAt({ y: 3 * 40 + 100 + 19, rows: ROWS, from: 2 }), 2, "before row 3's midpoint:");
  eq(D.indexAt({ y: 100 + 19, rows: ROWS, from: 2 }), 0, "above row 0's midpoint:");
  eq(D.indexAt({ y: 100 + 21, rows: ROWS, from: 2 }), 1, "past row 0's midpoint:");
  eq(D.indexAt({ y: 10, rows: [], from: 0 }), 0, "no rows:");
});

await t("unit: indexAt in a scaled pane: rows in the list's layout px, origin its client top and scale its zoom, give the same answers as client px", () => {
  const layout = [0, 1, 2, 3, 4, 5].map((i) => ({ top: i * 40, height: 40 }));
  // drawn at half size from client y 300: layout row 3's midpoint (140) is client 370
  eq(D.indexAt({ y: 371, rows: layout, from: 0, scale: 0.5, origin: 300 }), 3, "past 3 (scaled):");
  eq(D.indexAt({ y: 369, rows: layout, from: 0, scale: 0.5, origin: 300 }), 2, "before 3 (scaled):");
  eq(D.indexAt({ y: 0, rows: layout, from: 3, scale: 0.5, origin: 300 }), 0, "above (scaled):");
  eq(D.indexAt({ y: 9999, rows: layout, from: 3, scale: 0.5, origin: 300 }), 5, "below (scaled):");
  eq(D.indexAt({ y: 371, rows: layout, from: 0, scale: 0, origin: 300 }), D.indexAt({ y: 371, rows: layout, from: 0, scale: 1, origin: 300 }), "a bad scale is 1:");
});

await t("unit: pointerTarget and checkMove use treeModel.move: a spot the registry refuses is not ok, with its reason, and shows the original order", () => {
  const above = D.pointerTarget(SIX, "sec_c", 0, ROWS, { type: "home" });
  eq([above.from, above.to, above.ok], [3, 0, false], "above the hero:");
  ok(/hero can only go at the top/i.test(above.reason), `reason: ${above.reason}`);
  eq(ids(above.sections), ids(SIX), "snapped back:");
  const mid = D.pointerTarget(SIX, "sec_e", 150, ROWS, { type: "home" });
  eq([mid.to, mid.ok], [1, true], "e to 1:");
  eq(ids(mid.sections), ["sec_hero", "sec_e", "sec_a", "sec_b", "sec_c", "sec_d"], "order:");
  const hero = D.checkMove(SIX, "sec_hero", 3, { type: "home" });
  ok(!hero.ok && hero.reason, "the hero can't leave the top");
  ok(D.checkMove(SIX, "sec_a", 4, { type: "home" }).ok, "a to 4");
});

await t("unit: the live region's words are exactly the plan's", () => {
  eq(D.SAY.pickedUp("Hero", 2, 6), "Picked up Hero, position 2 of 6. Arrow keys move it, Space drops it, Escape cancels.");
  eq(D.SAY.moved("Hero", 3, 6), "Hero, position 3 of 6.");
  eq(D.SAY.refused("The hero can only go at the top of the home page."), "Can't go there: The hero can only go at the top of the home page.");
  eq(D.SAY.dropped("Hero", 3, 6), "Hero dropped at position 3 of 6.");
  eq(D.SAY.cancelled("Hero", 2), "Move cancelled. Hero is back at position 2.");
});

await t("unit: keyboard hold: Space picks up, arrows move the section, Home/End go to the ends, a refused spot is said and kept, Space drops with the moved order, Escape returns it", () => {
  const g = D.grab(SIX, "sec_b", { role: "owner", type: "home" });
  eq(g.say, "Picked up Rich text, position 3 of 6. Arrow keys move it, Space drops it, Escape cancels.", "pick up:");
  let h = g.hold;
  let s = D.holdKey(h, "ArrowDown");
  eq(s.say, "Rich text, position 4 of 6.", "down:");
  eq(ids(s.sections), ["sec_hero", "sec_a", "sec_c", "sec_b", "sec_d", "sec_e"], "down order:");
  h = s.hold;
  s = D.holdKey(h, "End");
  eq(s.say, "Rich text, position 6 of 6.", "end:");
  h = s.hold;
  s = D.holdKey(h, "ArrowDown");
  eq([s.say, s.hold.at], ["Rich text, position 6 of 6.", 5], "past the end stays:");
  s = D.holdKey(h, "Home");
  eq(s.say, "Can't go there: The hero can only go at the top of the home page.", "home refused:");
  eq(s.hold.at, 5, "kept its spot:");
  eq(ids(s.sections), ["sec_hero", "sec_a", "sec_c", "sec_d", "sec_e", "sec_b"], "still shown at its spot:");
  for (let i = 0; i < 3; i++) h = D.holdKey(h, "ArrowUp").hold;
  s = D.holdKey(h, "ArrowUp");
  eq(s.say, "Rich text, position 2 of 6.", "up to 2:");
  s = D.holdKey(s.hold, "ArrowUp");
  eq([s.say, s.hold.at], ["Can't go there: The hero can only go at the top of the home page.", 1], "above the hero refused:");
  const dropped = D.holdKey(s.hold, " ");
  eq([dropped.hold, dropped.say], [null, "Rich text dropped at position 2 of 6."], "drop:");
  eq(ids(dropped.done), ["sec_hero", "sec_b", "sec_a", "sec_c", "sec_d", "sec_e"], "the move sent:");
  const entered = D.holdKey(D.holdKey(D.grab(SIX, "sec_a", { role: "staff", type: "home" }).hold, "ArrowDown").hold, "Enter");
  eq(entered.say, "Rich text dropped at position 3 of 6.", "Enter drops too:");
  const back = D.holdKey(D.holdKey(g.hold, "ArrowDown").hold, "Escape");
  eq([back.hold, back.done, back.say], [null, null, "Move cancelled. Rich text is back at position 3."], "escape:");
  eq(ids(back.sections), ids(SIX), "escape order:");
  const still = D.drop(g.hold);
  eq([still.done, still.say], [null, "Rich text dropped at position 3 of 6."], "dropped where it was: nothing sent:");
  eq(D.holdKey(g.hold, "a"), null, "another key is not the hold's");
  eq(D.holdKey(null, " "), null, "no hold");
});

await t("unit: no pick-up without storefront.write: support (and operator support, role support) and no role get null; owner, admin and staff pick up", () => {
  for (const role of ["support", null, "nobody"]) {
    eq(D.canGrab(role), false, `${role} canGrab:`);
    eq(D.grab(SIX, "sec_a", { role, type: "home" }), null, `${role} grab:`);
  }
  for (const role of ["owner", "admin", "staff"]) ok(D.grab(SIX, "sec_a", { role, type: "home" }), `${role} grabs`);
  eq(D.grab(SIX, "sec_nothere", { role: "owner", type: "home" }), null, "an unknown id:");
});

await t("unit: the rail auto-scrolls near its edges only", () => {
  const box = { top: 100, bottom: 500 };
  ok(D.edgeScroll(105, box) < 0, "near the top scrolls up");
  ok(D.edgeScroll(495, box) > 0, "near the bottom scrolls down");
  eq(D.edgeScroll(300, box), 0, "the middle:");
  eq(D.edgeScroll(300, null), 0, "no box:");
  eq(D.DRAG_THRESHOLD_PX, 4, "threshold:");
});

// ---- 2. rendered ----------------------------------------------------------------
console.log("— rendered");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const cache = new Map();
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  const code = await compile(file);
  const local = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
    if (target) local.set(id, await load(target.endsWith(".js") ? target : `${target}.js`));
  }
  const stubs = { "next/navigation": { useRouter: () => ({ push() {} }) }, "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) } };
  new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const Tree = (await load(join(ROOT, "components/admin/editor/tree/SectionTree.js"))).default;
const Rail = (await load(join(ROOT, "components/admin/studio/SectionsRail.js"))).default;
const tree = (props) => renderToStaticMarkup(React.createElement(Tree, { type: "home", sections: SIX, ...props }));

await t("rendered: with draggable, owner, admin and staff get a 24px handle per row, a button named \"Reorder <label>\" with touch-action:none, and \"Add a section here\" insert points; support gets none of them", () => {
  for (const role of ["owner", "admin", "staff"]) {
    const html = tree({ role, draggable: true });
    eq((html.match(/data-tree-handle="/g) || []).length, 6, `${role} handles:`);
    ok(html.includes('aria-label="Reorder Hero"') && html.includes('aria-label="Reorder Rich text"'), `${role}: handle names`);
    ok(/data-tree-handle="sec_hero"[^>]*class="[^"]*size-6/.test(html) || /class="[^"]*size-6[^"]*"[^>]*data-tree-handle="sec_hero"/.test(html), `${role}: 24px handle`);
    ok(html.includes("touch-action:none"), `${role}: touch-action`);
    eq((html.match(/data-tree-insert="/g) || []).length, 6, `${role} insert points (before the first and between rows):`);
    ok(html.includes("Add a section here"), `${role}: insert words`);
  }
  const support = tree({ role: "support", draggable: true });
  for (const mark of ["data-tree-handle", "data-tree-insert", "Reorder", "Add a section", "data-op="]) ok(!support.includes(mark), `support: ${mark}`);
  ok(support.includes("data-tree-select"), "support still selects rows");
});

await t("rendered: without draggable the tree is the editor's: no handle, no insert point, the same markup as passing draggable={false}", () => {
  const plain = tree({ role: "owner" });
  eq(plain, tree({ role: "owner", draggable: false }), "draggable off:");
  for (const mark of ["data-tree-handle", "data-tree-insert", "Reorder", "Add a section here", "data-drop-line", "data-tree-dragging"]) ok(!plain.includes(mark), `editor: ${mark}`);
  ok(plain.includes("Move Rich text up") && plain.includes("data-tree-add"), "the editor's own buttons stay");
});

await t("rendered: during a 409 (dragBlocked) the handles are there but disabled, titled with the reason", () => {
  const html = tree({ role: "owner", draggable: true, dragBlocked: "Choose which version to keep before moving sections." });
  eq((html.match(/<button[^>]*disabled=""[^>]*data-tree-handle=/g) || []).length, 6, "disabled handles:");
  ok(html.includes('title="Choose which version to keep before moving sections."'), "reason");
});

await t("rendered: SectionsRail has one aria-live=\"assertive\" region; drag on for writers, off for support; a 409 blocks it", () => {
  const studio = (role, extra = {}) => ({ role, can: { write: role !== "support" }, selection: null, select() {}, treeChange() {}, post() {}, state: { id: "doc_home", type: "home", body: { sections: SIX }, issues: [], ...extra } });
  const owner = renderToStaticMarkup(React.createElement(Rail, { studio: studio("owner") }));
  eq((owner.match(/aria-live="assertive"/g) || []).length, 1, "one live region:");
  ok(owner.includes("data-tree-handle") && !owner.includes("disabled=\"\" aria-pressed"), "owner drags");
  const sup = renderToStaticMarkup(React.createElement(Rail, { studio: studio("support") }));
  ok(!sup.includes("data-tree-handle") && sup.includes('aria-live="assertive"'), "support: no handle, still the region");
  const conflict = renderToStaticMarkup(React.createElement(Rail, { studio: studio("owner", { conflict: { code: "DOCUMENT_CHANGED" } }) }));
  ok(/<button[^>]*disabled=""[^>]*data-tree-handle=/.test(conflict), "409: handles disabled");
});

await t("source: the tree's keyboard hold stops the row-focus keys, keeps focus on the held handle, and the pointer drag captures the pointer after the 4px threshold", async () => {
  const src = await readFile(join(ROOT, "components/admin/editor/tree/SectionTree.js"), "utf8");
  ok(src.includes("e.stopPropagation()") && src.includes("holdKey(hold, e.key)"), "keys while held are the hold's");
  ok(src.includes("el.focus()") && src.includes("keep.current"), "focus stays on the handle");
  ok(src.includes("setPointerCapture") && src.includes("DRAG_THRESHOLD_PX"), "pointer capture and threshold");
  ok(src.includes('window.addEventListener("keydown", onKey, true)') && src.includes('e.key !== "Escape"'), "Escape cancels a pointer drag");
  const rail = await readFile(join(ROOT, "components/admin/studio/SectionsRail.js"), "utf8");
  ok(rail.includes("orderMessage(st.id") && rail.includes('"storeasy:select"'), "the rail posts the order and outlines the held section");
});

// ---- 3. publish plan and undo keys -------------------------------------------------
console.log("— publish plan");
const P = await load(join(ROOT, "components/admin/studio/StudioPublishDialog.js"));
const Top = await load(join(ROOT, "components/admin/studio/StudioTopBar.js"));

await t("unit: publishRows ticks only touched documents that still differ from live; the rest are Other drafts, described; live-equal and archived documents aren't listed", () => {
  const docs = [
    { id: "doc_home", label: "Home page", type: "home", unpublishedChanges: true },
    { id: "doc_about", label: "About us", type: "page", unpublishedChanges: true },
    { id: "doc_design", label: "Brand", type: "design", unpublishedChanges: false },
    { id: "doc_old", label: "Old", type: "page", unpublishedChanges: true, archivedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const r = P.publishRows(docs, { touched: ["doc_design", "doc_home"] });
  eq(r.ticked.map((x) => [x.id, x.why]), [["doc_home", "Changed in this session"]], "ticked:");
  eq(r.other.map((x) => [x.id, x.why]), [["doc_about", "Has other edits"]], "other:");
  eq(P.publishRows(docs, { touched: [] }).ticked, [], "nothing touched: nothing ticked:");
});

await t("unit: createPublishRun flushes every open store first, sends each ticked document's fresh revision and draftHash (an open one's from its store, another's read fresh), through the open store in the set", async () => {
  const calls = [];
  const mk = (id, rev, hash) => {
    const st = { id, revision: rev, draftHash: hash, unacknowledged: true };
    return {
      st,
      getState: () => st,
      async beforeNavigate() {
        calls.push(`flush:${id}`);
        st.revision++;
        st.draftHash = `${st.draftHash}+`;
        return { ok: true };
      },
      async publishSet(list) {
        calls.push(`publishSet:${id}`);
        return { ok: true, data: { published: list.map((x) => ({ id: x.id })) }, sent: list };
      },
    };
  };
  const home = mk("doc_home", 3, "h_home");
  const design = mk("doc_design", 7, "h_design");
  const api = {
    async call(op, arg) {
      calls.push(`${op}:${typeof arg === "string" ? arg : ""}`);
      if (op === "listDocuments") return { ok: true, data: { documents: [{ id: "doc_home", unpublishedChanges: true }, { id: "doc_about", unpublishedChanges: true }] } };
      if (op === "getDocument") return { ok: true, data: { document: { id: arg, revision: 11, draftHash: "h_about" } } };
      return { ok: true, data: {} };
    },
  };
  const run = P.createPublishRun({ api, stores: () => [home, design], current: () => home });
  const prep = await run.prepare();
  ok(prep.ok, "prepared");
  eq(calls.slice(0, 3), ["flush:doc_home", "flush:doc_design", "listDocuments:"], "flushed before listing:");
  calls.length = 0;
  const r = await run.publish(["doc_home", "doc_design", "doc_about"], { doc_home: "Home page" });
  eq(r.result.sent, [
    { id: "doc_home", revision: 5, draftHash: "h_home++" },
    { id: "doc_design", revision: 9, draftHash: "h_design++" },
    { id: "doc_about", revision: 11, draftHash: "h_about" },
  ], "fresh revisions:");
  eq(calls, ["flush:doc_home", "flush:doc_design", "getDocument:doc_about", "publishSet:doc_home"], "calls:");
  eq(r.outcome.phase, "done", "outcome:");
  // no open store in the set: the api sends it
  calls.length = 0;
  await P.createPublishRun({ api, stores: () => [home], current: () => home }).publish(["doc_about"]);
  eq(calls, ["getDocument:doc_about", "publishSet:"], "api publishSet:");
});

await t("unit: a save that fails stops the publish with plain words and sends nothing; blockers and 409s give \"Go to the fix\" targets", async () => {
  const sent = [];
  const bad = { getState: () => ({ id: "doc_home" }), beforeNavigate: async () => ({ ok: false, conflict: true, message: "Choose which version to keep first." }), publishSet: async () => sent.push("x") };
  const run = P.createPublishRun({ api: { call: async (op) => (sent.push(op), { ok: true, data: { documents: [] } }) }, stores: () => [bad], current: () => bad });
  const prep = await run.prepare();
  eq([prep.ok, prep.message], [false, "Choose which version to keep first."], "prepare:");
  eq(sent, [], "nothing sent:");
  const blocked = { phase: "blocked", issues: [{ documentId: "doc_home", sectionId: "sec_hero", level: "blocks", message: "Add a title." }, { documentId: "doc_home", level: "warns", message: "Check." }] };
  eq(P.fixesOf(blocked), [{ id: "doc_home", sectionId: "sec_hero", words: "Add a title." }], "blockers:");
  eq(P.fixesOf({ phase: "conflict", conflicts: [], current: { id: "doc_about" }, words: "Changed in another tab." }), [{ id: "doc_about", sectionId: null, words: "Changed in another tab." }], "409:");
  eq(P.fixesOf(null), [], "none:");
});

await t("unit: undo keys: ⌘Z undoes, ⇧⌘Z and Ctrl+Y redo, never inside a text field; the switcher lists pages, home, layouts, header, footer and design only", () => {
  const k = (o) => Top.undoKey({ key: "z", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: { tagName: "DIV" }, ...o });
  eq([k({ metaKey: true }), k({ metaKey: true, shiftKey: true }), k({ ctrlKey: true }), k({ key: "y", ctrlKey: true }), k({}), k({ metaKey: true, target: { tagName: "INPUT" } }), k({ metaKey: true, target: { isContentEditable: true } })], ["undo", "redo", "undo", "redo", null, null, null], "keys:");
  const docs = ["home", "page", "product_layout", "header", "footer", "design", "product_content", "collection_content", "cart"].map((type, i) => ({ id: `d${i}`, type }));
  eq(Top.switcherDocs(docs).map((d) => d.type), ["home", "page", "product_layout", "header", "footer", "design"], "switcher:");
});

await t("unit: allStores: the nav guard waits for every open document's save, and stops at the first that fails", async () => {
  const seen = [];
  const s = (id, okay, unack) => ({ getState: () => ({ unacknowledged: unack }), beforeNavigate: async () => (seen.push(id), { ok: okay }), beforeUnload: () => unack });
  const all = Top.allStores([s("a", true, false), s("b", false, true), s("c", true, false)]);
  eq(all.getState().unacknowledged, true, "any unacknowledged:");
  eq((await all.beforeNavigate()).ok, false, "a failed save stops:");
  eq(seen, ["a", "b"], "in order:");
  eq(all.beforeUnload(), true, "warns:");
});

await t("unit: studioStores lists each open document's store once (the open one, kept ones, and DesignRail's design store when it has one), so Publish flushes the design too", async () => {
  const st = (id) => ({ getState: () => ({ id }) });
  const home = st("doc_home");
  const about = st("doc_about");
  eq(Top.studioStores({ stores: () => [home, about, home], model: {} }).map((s) => s.getState().id), ["doc_home", "doc_about"], "deduped:");
  eq(Top.studioStores({ store: home }).map((s) => s.getState().id), ["doc_home"], "only the open one:");
  const src = await readFile(join(ROOT, "components/admin/studio/StudioTopBar.js"), "utf8");
  ok(src.includes("designStoreFor(studio)") && src.includes("createPublishRun({ api: studio?.api, stores,"), "the design store is in the publish run's stores");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
