// P3-EDITOR suite (ED-02, ED-03, ED-04, PV-01, PV-02, PUB-02, PUB-04, PUB-06,
// PUB-11): the editor shell.
//   pnpm test:editor-shell
// Two kinds of test (phase 3 plan section 1):
//   unit      components/admin/editor/editorModel.js in node, with the real
//             store (store.js), the real publish flow (publishModel.js) and a
//             scripted documents server behind a stub `call`; stand-in timers
//   rendered  DocumentEditor's view and /admin/releases compiled with Next's
//             own SWC and rendered with react-dom/server (no effects, no events)
// No database, no server, no port.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();
const require = createRequire(import.meta.url);

const M = await import("../components/admin/editor/editorModel.js");
const { createDocumentStore } = await import("../components/admin/editor/store.js");
const { createPublishFlow } = await import("../components/admin/editor/publish/publishModel.js");
const { READY_TIMEOUT_MS, PREVIEW_WORDS } = await import("../components/admin/editor/previewMachine.js");

let pass = 0;
let fail = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function t(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.stack?.split("\n").slice(0, 4).join("\n    ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "expected truthy") => {
  if (!cond) throw new Error(label);
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out: ${label}`);
}

// ---- stand-ins ------------------------------------------------------------------------

// Timers the test runs by hand: fire(ms) runs every timer due within ms.
function fakeTimers() {
  let now = 0;
  let id = 0;
  const list = new Map();
  return {
    setTimeout: (fn, ms) => {
      list.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (h) => list.delete(h),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...list.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        list.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await tick();
      }
      now = end;
    },
    get pending() {
      return list.size;
    },
  };
}

// A scripted documents server: one document, saveDraft bumps the revision.
// hold(op) makes the next call of that op wait for release().
function server({ id = "doc_home", type = "home", body = { type: "home", sections: [{ id: "sec_aa", kind: "hero", settings: { title: "Hi" } }] } } = {}) {
  const doc = { id, type, label: "Home page", slug: null, body: clone(body), revision: 3, draftHash: "h3", publishedVersionId: "ver_1", publishedHash: "h1", access: { canPublish: true, reason: null } };
  const calls = [];
  const holds = new Map();
  const answers = new Map();
  const api = {
    async call(op, args, extra) {
      calls.push({ op, args: clone(args ?? null), extra: clone(extra ?? null) });
      if (holds.has(op)) await holds.get(op).promise;
      if (answers.has(op)) {
        const a = answers.get(op);
        return typeof a === "function" ? a(args, extra) : a;
      }
      if (op === "getDocument") return { ok: true, data: { document: clone(doc) } };
      if (op === "saveDraft") {
        if (extra?.revision !== doc.revision) return { conflict: true, code: "DOCUMENT_CHANGED", message: "This page was changed in another tab.", current: clone(doc) };
        doc.body = clone(args.body);
        doc.revision++;
        doc.draftHash = `h${doc.revision}`;
        return { ok: true, data: { document: clone(doc), issues: [] } };
      }
      if (op === "listChanges") return { ok: true, data: { firstPublish: false, rows: [{ kind: "edited", sectionId: "sec_aa", words: "Hero: title changed" }] } };
      if (op === "publish") return { ok: true, data: { published: [{ id: doc.id, versionId: "ver_2", hash: args.draftHash, undo: { id: doc.id, revision: doc.revision, logId: "log_9" } }], setId: "set_1" } };
      if (op === "undo") {
        if (args.dryRun) return { ok: true, data: { willTakeOffline: false, linkers: [], changes: [{ words: "Hero: title changed" }], target: { versionId: "ver_1", name: "the version from 2 Nov" } } };
        doc.revision++;
        doc.draftHash = `h${doc.revision}`;
        return { ok: true, data: { ok: true, message: "Undone.", document: clone(doc) } };
      }
      return { error: true, code: "UNKNOWN", message: `no script for ${op}` };
    },
    sendKeepalive: () => true,
  };
  return {
    api,
    doc,
    calls,
    ops: () => calls.map((c) => c.op),
    hold(op) {
      let release;
      const promise = new Promise((r) => (release = r));
      holds.set(op, { promise });
      return () => {
        holds.delete(op);
        release();
      };
    },
    answer: (op, a) => answers.set(op, a),
  };
}
const memoryStorage = () => {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};
const makeStore = (srv, opts = {}) => createDocumentStore({ api: srv.api, document: clone(srv.doc), tenant: "t1", timers: opts.timers || fakeTimers(), storage: opts.storage || null, pauseMs: 700 });

// =====================================================================================
console.log("— 1. click to select (ED-04)");

await t("unit (editorModel): a pick for another document switches with a visible note and writes nothing to the open document", async () => {
  const srv = server();
  const store = makeStore(srv);
  const before = store.getState();
  const plan = M.pickPlan({ type: "storeasy:pick", doc: "doc_header", sectionId: null, kind: null, field: null, offset: null }, { openId: "doc_home", openLabel: "Home page", labelOf: (id) => (id === "doc_header" ? "Header" : null) });
  eq(plan.kind, "switch", "kind:");
  eq(plan.documentId, "doc_header", "document:");
  eq(plan.note, "You picked “Header” in the preview, so the editor opened it. Nothing changed on “Home page”.", "note:");
  ok(!("ops" in plan) && !("path" in plan), "the plan carries no edit");
  // a pick inside another document's section names its field too
  const p2 = M.pickPlan({ doc: "doc_footer", sectionId: null, field: "text", offset: null }, { openId: "doc_home", openLabel: "Home page" });
  eq([p2.kind, p2.focusRequest], ["switch", { path: "text", offset: null }], "footer pick:");
  ok(/opened it\. Nothing changed on “Home page”\./.test(p2.note), "a note without a known label still reads plainly");
  eq(store.getState(), before, "the open store's state is the same object (nothing was written):");
  await tick();
  eq(srv.calls.length, 0, "no call reached the server:");
});

await t("unit (editorModel): a pick on the open document selects its section and builds focusRequest {path, offset}", () => {
  const sel = M.pickPlan({ doc: "doc_home", sectionId: "sec_rt", kind: "rich_text", field: "html", offset: 2 }, { openId: "doc_home" });
  eq(sel, { kind: "select", sectionId: "sec_rt", focusRequest: { path: "html", offset: 2 } }, "rich text pick:");
  eq(M.pickPlan({ doc: "doc_home", sectionId: "sec_aa", field: "primary.label", offset: null }, { openId: "doc_home" }), { kind: "select", sectionId: "sec_aa", focusRequest: { path: "primary.label", offset: null } }, "button label:");
  eq(M.pickPlan({ doc: "doc_home", sectionId: "sec_aa", field: null }, { openId: "doc_home" }), { kind: "select", sectionId: "sec_aa", focusRequest: null }, "a section without a field:");
  eq(M.pickPlan({ doc: "doc_ab", sectionId: null, field: "meta.title" }, { openId: "doc_ab" }), { kind: "select", sectionId: null, focusRequest: { path: "meta.title", offset: null } }, "the page's own title:");
  eq(M.pickPlan({ sectionId: "sec_aa" }, { openId: "doc_home" }).kind, "select", "a section with no data-doc is the open document's:");
  // a product page: its markup has no section ids, so a click (Add to cart) selects the layout's product section
  eq(M.pickPlan({ doc: "doc_product_layout", sectionId: null, field: null }, { openId: "doc_product_layout", fallbackSectionId: "sec_pmain" }), { kind: "select", sectionId: "sec_pmain", focusRequest: null }, "product page pick:");
  eq(M.pickPlan({ doc: "doc_header", sectionId: null }, { openId: "doc_product_layout", fallbackSectionId: "sec_pmain" }).kind, "switch", "the header from a product page still opens the header:");
  eq(M.pickPlan(null, { openId: "doc_home" }).kind, "none", "nothing:");
  eq(M.pickPlan({ doc: null, sectionId: null }, { openId: "doc_home" }).kind, "none", "an empty pick:");
});

await t("unit: a newly added section shows 'Adding to preview…' until a refresh after its save is shown", () => {
  eq(M.WORDS.adding, "Adding to preview…");
  let p = { sec_new: 4 };
  let r = M.pendingAfterShown(p, 4);
  eq([r.done, r.pending], [[], { sec_new: 4 }], "the frame still shows the save before the add:");
  r = M.pendingAfterShown(p, 5);
  eq([r.done, r.pending], [["sec_new"], {}], "a later save is shown: done:");
});

// =====================================================================================
console.log("— 2. the preview (PV-01, PUB-11)");

function previewRig({ documentId = "doc_home" } = {}) {
  const timers = fakeTimers();
  const minted = [];
  const shows = [];
  const posted = [];
  const srcs = [];
  let at = null;
  let mintAnswer = () => ({ ok: true, sid: `ps_${minted.length}`, expiresAt: null });
  const api = {
    startDocumentsPreview: async (o) => {
      minted.push(o.showDesign);
      return mintAnswer();
    },
    setShowDesign: async (sid, on) => {
      shows.push([sid, on]);
      return { ok: true, data: { ok: true } };
    },
  };
  const views = [];
  const ctl = M.createPreviewController({
    api,
    timers,
    documentId,
    pathFor: (id) => (id === "doc_design" || id === "doc_home" ? "/" : "/about"),
    frame: { setSrc: (p) => (srcs.push(p), (at = p)), post: (m) => posted.push(m), currentPath: () => at },
    onChange: (v) => views.push(v),
  });
  return { ctl, timers, minted, shows, posted, srcs, views, last: () => views.at(-1), setMint: (f) => (mintAnswer = f) };
}
async function connect(rig) {
  rig.ctl.frameLoad();
  rig.ctl.message({ type: "storeasy:ready" });
  eq(rig.posted.at(-1), { type: "storeasy:editor:hello", v: 2 }, "a v1 ready gets the editor's hello:");
  rig.ctl.message({ type: "storeasy:ready", v: 2, ok: true, state: { kind: "documents", docs: {} }, unfinished: [] });
}

await t("unit: showDesign is set when doc_design opens and cleared when another document opens (one session, setShowDesign)", async () => {
  const r = previewRig({ documentId: "doc_design" });
  await r.ctl.start();
  eq(r.minted, [true], "doc_design mints with showDesign on:");
  eq(r.ctl.view().showDesign, true, "view:");
  await connect(r);
  eq(r.last().label, "Up to date", "connected:");
  await r.ctl.openDocument("doc_about");
  eq(r.shows, [["ps_1", false]], "another document turns it off on the same session:");
  eq(r.ctl.view().showDesign, false, "view after:");
  eq(r.srcs.at(-1), "/about", "the frame goes to that document's address:");
  await r.ctl.openDocument("doc_design");
  eq(r.shows.at(-1), ["ps_1", true], "back to doc_design turns it on again:");
  await r.ctl.openDocument("doc_home");
  eq(r.shows.at(-1), ["ps_1", false], "and off again:");
  eq(r.minted.length, 1, "no new session for any of it:");
  // opened first on another document: off from the start
  const r2 = previewRig({ documentId: "doc_home" });
  await r2.ctl.start();
  eq(r2.minted, [false], "home mints with showDesign off:");
  await r2.ctl.openDocument("doc_home");
  eq(r2.shows, [], "the same document again changes nothing:");
  // a failed setShowDesign mints a new session with the right setting
  const r3 = previewRig({ documentId: "doc_home" });
  await r3.ctl.start();
  r3.ctl.message({ type: "noise" });
  const realShow = r3.shows;
  r3.ctl.openDocument; // keep lint quiet
  const failing = M.createPreviewController({ api: { startDocumentsPreview: async (o) => (realShow.push(["mint", o.showDesign]), { ok: true, sid: "ps_x" }), setShowDesign: async () => ({ error: true }) }, timers: fakeTimers(), documentId: "doc_home", frame: { setSrc() {}, post() {}, currentPath: () => "/" } });
  await failing.start();
  await failing.openDocument("doc_design");
  await tick();
  eq(realShow.filter((x) => x[0] === "mint"), [["mint", false], ["mint", true]], "setShowDesign failed: re-minted with showDesign on:");
});

await t("unit: re-mint is requested on ready ok:false (live, revoked, expired) with 'Reconnecting…' meanwhile, then Up to date", async () => {
  for (const reason of ["live", "revoked", "expired", "not_found"]) {
    const r = previewRig();
    let release;
    await r.ctl.start();
    await connect(r);
    eq(r.last().label, "Up to date", `${reason}: connected first:`);
    r.setMint(() => new Promise((res) => (release = () => res({ ok: true, sid: "ps_new" }))));
    // "See the live store": the frame loads the live page, its bridge says live
    r.ctl.frameLoad();
    r.ctl.message({ type: "storeasy:ready" });
    r.ctl.message({ type: "storeasy:ready", v: 2, ok: false, reason, unfinished: [] });
    eq(r.minted.length, 2, `${reason}: a new session is minted:`);
    eq([r.last().label, r.last().words, r.last().reconnecting], ["Updating", PREVIEW_WORDS.reconnecting, true], `${reason}: Reconnecting meanwhile:`);
    release();
    await tick();
    eq(r.srcs.at(-1), "/", `${reason}: the frame loads the address again with the new cookie:`);
    // the founder sees Reconnecting for the whole reconnect, not only the mint
    eq([r.last().label, r.last().words, r.last().reconnecting], ["Updating", PREVIEW_WORDS.reconnecting, true], `${reason}: minted, the new frame loading, still Reconnecting:`);
    r.ctl.frameLoad();
    eq([r.last().words, r.last().reconnecting], [PREVIEW_WORDS.reconnecting, true], `${reason}: the new frame loaded, no ready yet, still Reconnecting:`);
    await connect(r);
    eq([r.last().label, r.last().words, r.last().reconnecting], ["Up to date", null, false], `${reason}: then Up to date:`);
    // the next ordinary update is not a reconnect
    r.ctl.saveAck({ draftHash: "h_next" });
    eq([r.last().label, r.last().words, r.last().reconnecting], ["Updating", PREVIEW_WORDS.loading, false], `${reason}: the next save says Showing your latest changes, not Reconnecting:`);
  }
  const first = previewRig();
  await first.ctl.start();
  eq([first.last().words, first.last().reconnecting], [PREVIEW_WORDS.loading, false], "the first load says Showing your latest changes, not Reconnecting:");
  // the old "legacy" reason is gone (Phase 1): a reason the machine doesn't know re-mints
  const legacy = previewRig();
  await legacy.ctl.start();
  legacy.ctl.frameLoad();
  legacy.ctl.message({ type: "storeasy:ready", v: 2, ok: false, reason: "legacy" });
  eq(legacy.minted.length, 2, "an unknown reason re-mints:");
});

await t("unit: re-mint is requested when no ready arrives within 3 seconds of a frame load", async () => {
  const r = previewRig();
  await r.ctl.start();
  r.ctl.frameLoad();
  eq(r.timers.pending, 1, "a ready timer runs after the load:");
  await r.timers.advance(READY_TIMEOUT_MS - 1);
  eq(r.minted.length, 1, "not before 3 seconds:");
  await r.timers.advance(1);
  eq(r.minted.length, 2, "at 3 seconds without a ready: re-minted:");
  ok(r.views.some((v) => v.reconnecting && v.words === PREVIEW_WORDS.reconnecting), "Reconnecting meanwhile");
  await tick();
  await connect(r);
  eq(r.last().label, "Up to date", "a ready after the new load: Up to date:");
  eq(r.timers.pending, 0, "the timer stopped on the ready:");
  // a ready in time: no re-mint
  const r2 = previewRig();
  await r2.ctl.start();
  r2.ctl.frameLoad();
  await r2.timers.advance(1000);
  r2.ctl.message({ type: "storeasy:ready", v: 2, ok: true, state: {} });
  await r2.timers.advance(10_000);
  eq(r2.minted.length, 1, "a ready within 3 s: no re-mint:");
  // nothing re-mints while the frame is shown (PV-04 is P1)
  await r2.timers.advance(3_600_000);
  eq(r2.minted.length, 1, "no re-mint before expiry:");
});

await t("unit: a save acknowledged while the frame is shown refreshes it in place; the pick goes to onPick; select is posted only to a connected bridge", async () => {
  const picks = [];
  const r = previewRig();
  await r.ctl.start();
  r.ctl.select("sec_aa");
  eq(r.posted.length, 0, "no bridge yet: nothing posted:");
  await connect(r);
  r.ctl.saveAck({ draftHash: "h5", issues: [], ackCount: 2 });
  eq(r.posted.at(-1), { type: "storeasy:refresh" }, "refresh posted:");
  eq(r.last().label, "Updating", "Updating:");
  await connect(r);
  eq([r.last().label, r.last().shownAck], ["Up to date", 2], "shown, with the ack it shows:");
  r.ctl.select("sec_aa");
  eq(r.posted.at(-1), { type: "storeasy:select", sectionId: "sec_aa" }, "select:");
  const c2 = M.createPreviewController({ api: { startDocumentsPreview: async () => ({ ok: true, sid: "s" }) }, timers: fakeTimers(), frame: { setSrc() {}, post() {}, currentPath: () => "/" }, onPick: (p) => picks.push(p) });
  c2.message({ type: "storeasy:pick", doc: "doc_home", sectionId: "sec_aa" });
  eq(picks.length, 1, "pick handed on:");
});

// P3-FIX5 (finding D1) ------------------------------------------------------------------
const OWN = "ps_00000000000000a1";
const OTHER = "ps_00000000000000b2";
const readyWith = (state) => ({ type: "storeasy:ready", v: 2, ok: true, state: { kind: "documents", docs: {}, offline: [], ...state }, unfinished: [] });

await t("P3-FIX5 unit: one editor mount mints one preview session (start, dispose, start: React strict mode's double effect)", async () => {
  // the mint answers after the strict-mode cleanup and re-run
  const r = previewRig();
  let release;
  r.setMint(() => new Promise((res) => (release = () => res({ ok: true, sid: OWN }))));
  r.ctl.start();
  r.ctl.dispose();
  r.ctl.start();
  release();
  await tick();
  eq(r.minted.length, 1, "one session for the mount:");
  eq(r.srcs, ["/"], "the frame loads once, with that session:");
  await connect(r);
  eq(r.last().label, "Up to date", "and it is Up to date:");
  // the mint answers while the controller is disposed (between cleanup and re-run): parked, then applied
  const p = previewRig();
  let release2;
  p.setMint(() => new Promise((res) => (release2 = () => res({ ok: true, sid: OWN }))));
  p.ctl.start();
  p.ctl.dispose();
  release2();
  await tick();
  eq(p.srcs, [], "nothing is applied while disposed:");
  p.ctl.start();
  eq([p.minted.length, p.srcs], [1, ["/"]], "the re-run applies the parked answer, still one session:");
  // a real unmount: never started again, so nothing is applied and nothing more is minted
  const u = previewRig();
  let release3;
  u.setMint(() => new Promise((res) => (release3 = () => res({ ok: true, sid: OWN }))));
  u.ctl.start();
  u.ctl.dispose();
  const seen = u.views.length;
  release3();
  await tick();
  eq([u.minted.length, u.srcs.length, u.views.length], [1, 0, seen], "after a real unmount nothing changes:");
  // PreviewPane keeps one controller per mount (the ref), and starts it in the effect
  const pane = await readFile(join(ROOT, "components/admin/editor/PreviewPane.js"), "utf8");
  ok(/let ctl = ctlRef\.current;\s*if \(!ctl\) \{/.test(pane), "PreviewPane makes the controller only when the ref has none");
  ok(!/ctlRef\.current = null/.test(pane), "PreviewPane's cleanup keeps the controller for the strict-mode re-run");
});

await t("P3-FIX5 unit: showDesign reaches the session the frame renders; the preview never says Up to date while the frame says the new colours are hidden", async () => {
  // the design is open; the frame renders another session (the cookie is a second tab's) with the colours off
  const r = previewRig({ documentId: "doc_design" });
  r.setMint(() => ({ ok: true, sid: OWN }));
  await r.ctl.start();
  eq(r.minted, [true], "minted with the colours on:");
  r.ctl.frameLoad();
  r.ctl.message(readyWith({ sid: OTHER, skipped: ["doc_design"], designShown: false }));
  ok(r.views.every((v) => v.label !== "Up to date"), "never Up to date while the frame says the colours are hidden");
  await tick();
  eq(r.shows, [[OTHER, true]], "showDesign goes to the frame's session (state.sid), not only our own:");
  eq(r.ctl.view().sid, OTHER, "the controller now steers the frame's session:");
  eq(r.srcs.length + r.posted.filter((m) => m.type === "storeasy:refresh").length, 2, "the frame is reloaded after the turn-on:");
  r.ctl.frameLoad();
  r.ctl.message(readyWith({ sid: OTHER, skipped: [], designShown: true }));
  eq([r.last().label, r.ctl.view().showDesign], ["Up to date", true], "the colours are shown: Up to date:");
  eq(r.minted.length, 1, "no new session was needed:");
  // the next document turns it off in the session the frame renders
  await r.ctl.openDocument("doc_home");
  eq(r.shows.at(-1), [OTHER, false], "another document: off in the frame's session:");
  // adopted with nothing hidden (the home page in a second tab's session):
  // opening the design later turns it on where the frame is
  const q = previewRig({ documentId: "doc_home" });
  q.setMint(() => ({ ok: true, sid: OWN }));
  await q.ctl.start();
  q.ctl.frameLoad();
  q.ctl.message(readyWith({ sid: OTHER, skipped: [] }));
  eq([q.last().label, q.ctl.view().sid], ["Up to date", OTHER], "the frame's session is adopted:");
  await q.ctl.openDocument("doc_design");
  eq(q.shows.at(-1), [OTHER, true], "opening the design turns it on in the frame's session:");
  // the turn-on keeps failing to show: Could not update, with words, never Up to date
  const s = previewRig({ documentId: "doc_design" });
  s.setMint(() => ({ ok: true, sid: OWN }));
  await s.ctl.start();
  for (let i = 0; i < 3; i++) {
    s.ctl.frameLoad();
    s.ctl.message(readyWith({ sid: OWN, skipped: ["doc_design"], designShown: false }));
    await tick();
  }
  // P4-EDITOR (P3-FIX5 review): the session's colours ARE on here (minted on,
  // never adopted away), so a draft still skipped is one that can't be read:
  // its own words, not "isn't showing your new colours"
  eq([s.last().label, s.last().words], ["Could not update", M.DESIGN_WORDS.unreadable], "after the tries: Could not update, in words:");
  ok(s.views.every((v) => v.label !== "Up to date"), "never Up to date on the way");
  s.ctl.retry();
  await tick();
  eq(s.minted.length, 2, "Try again opens a new session:");
  // the turn-on is refused (the frame's session is someone else's or gone): a new session of our own
  const shows = [];
  const refusing = M.createPreviewController({
    api: { startDocumentsPreview: async (o) => (shows.push(["mint", o.showDesign]), { ok: true, sid: OWN }), setShowDesign: async (sid, on) => (shows.push([sid, on]), { error: true }) },
    timers: fakeTimers(),
    documentId: "doc_design",
    frame: { setSrc() {}, post() {}, currentPath: () => null },
  });
  await refusing.start();
  refusing.frameLoad();
  refusing.message(readyWith({ sid: OTHER, skipped: ["doc_design"] }));
  await tick();
  await tick();
  eq(shows, [["mint", true], [OTHER, true], ["mint", true]], "refused turn-on: a new session with the colours on:");
  // another document with the design hidden is Up to date (its colours are the live ones by rule)
  const h = previewRig({ documentId: "doc_home" });
  h.setMint(() => ({ ok: true, sid: OWN }));
  await h.ctl.start();
  h.ctl.frameLoad();
  h.ctl.message(readyWith({ sid: OWN, skipped: ["doc_design"] }));
  eq([h.last().label, h.shows], ["Up to date", []], "the home page: Up to date, nothing turned on:");
});

// =====================================================================================
console.log("— 3. leaving (ED-03)");

const anchorEvent = (href, extra = {}) => {
  const a = { getAttribute: (n) => (n === "href" ? href : extra[n] ?? null), hasAttribute: (n) => n in extra, closest: (sel) => (sel === "a[href]" ? a : null) };
  return { target: { closest: (sel) => (sel === "a[href]" ? a : null) }, button: 0, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
};

await t("unit: an in-app navigation while dirty awaits the flush before routing; a clean store routes as usual; a failed flush stays with words", async () => {
  const srv = server();
  const store = makeStore(srv);
  const routed = [];
  const blocked = [];
  const guard = M.createNavGuard({ getStore: () => store, origin: "https://s.test", here: () => "/admin/editor", navigate: (to) => routed.push([to, srv.doc.revision, store.getState().unacknowledged]), onBlocked: (b) => blocked.push(b) });
  // clean: the link works as usual (no preventDefault)
  const clean = anchorEvent("/admin/orders");
  eq(guard.onClickCapture(clean), null, "clean: nothing to wait for:");
  eq(clean.defaultPrevented, false, "clean: the click is the link's own:");
  // typed, then a console link within the pause
  store.setField("sections.sec_aa.settings.title", "Typed then clicked");
  const release = srv.hold("saveDraft");
  const e = anchorEvent("/admin/orders?x=1");
  const going = guard.onClickCapture(e);
  ok(e.defaultPrevented && e.stopped, "dirty: the click is held in the capture phase");
  await tick();
  eq(routed, [], "no routing while the save is in flight:");
  eq(srv.ops(), ["saveDraft"], "the save went out at once, without waiting for the pause:");
  release();
  await going;
  eq(routed, [["/admin/orders?x=1", 4, false]], "routed after the save landed (revision 4, nothing unacknowledged):");
  eq(srv.doc.body.sections[0].settings.title, "Typed then clicked", "nothing lost:");
  // a same-page #anchor, a new tab, another site: never held
  store.setField("sections.sec_aa.settings.title", "Again");
  for (const [href, extra] of [["#f-sec_aa-title", {}], ["/admin/orders", { target: "_blank" }], ["https://other.test/x", {}]]) {
    const ev = anchorEvent(href, extra);
    eq(guard.onClickCapture(ev), null, `${href}: not held:`);
    eq(ev.defaultPrevented, false, `${href}: not prevented:`);
  }
  // a save that fails: stay, with words
  srv.answer("saveDraft", { error: true, code: "INTERNAL_ERROR", message: "Something went wrong on our side." });
  const r = await guard.go("/admin/media");
  eq(r, false, "not routed:");
  eq(blocked.at(-1).message, M.WORDS.leaveBlocked, "the founder is told:");
  eq(routed.length, 1, "still one route:");
});

await t("unit: the switcher's open waits for the same flush; beforeunload uses store.beforeUnload()", async () => {
  const srv = server();
  const store = makeStore(srv);
  const routed = [];
  const guard = M.createNavGuard({ getStore: () => store, origin: "https://s.test", navigate: (to) => routed.push([to, srv.doc.revision]) });
  store.setField("sections.sec_aa.settings.title", "Switch");
  eq(store.beforeUnload(), true, "beforeunload warns while dirty:");
  await guard.go("/admin/editor?doc=doc_header");
  eq(routed, [["/admin/editor?doc=doc_header", 4]], "the switch routed after the save:");
  eq(store.beforeUnload(), false, "nothing to warn about after:");
});

// =====================================================================================
console.log("— 4. the store's call: publish fixes and Undo (P3-PUBLISHUI review)");

function blockedAnswer(id) {
  return {
    issues: [{ level: "blocks", severity: "error", documentId: id, sectionId: "sec_aa", field: "title", message: "The hero's title is too long.", where: "Hero", anchor: "f-sec_aa-title", actions: [{ type: "hideSection", documentId: id, sectionId: "sec_aa" }] }],
    code: "VALIDATION_FAILED",
    message: "Fix these first, then publish.",
  };
}

async function fixRig() {
  const srv = server();
  const store = makeStore(srv);
  let flow;
  const call = M.createStoreCall({ api: srv.api, getStore: () => store, getPinned: (id) => flow.getState().items.find((it) => it.id === id)?.draftHash ?? null });
  flow = createPublishFlow({ call });
  const s = store.getState();
  await flow.open([{ id: s.id, label: "Home page", type: "home", revision: s.revision, draftHash: s.draftHash }]);
  srv.answer("publish", (args) => (srv.calls.filter((c) => c.op === "publish").length === 1 ? blockedAnswer(args.id) : { ok: true, data: { published: [{ id: args.id, versionId: "ver_2", hash: args.draftHash, undo: { id: args.id, revision: srv.doc.revision, logId: "log_9" } }], setId: "set_1" } }));
  await flow.confirm();
  eq(flow.getState().phase, "blocked", "the publish was refused with a fix:");
  return { srv, store, flow };
}

await t("unit: a fix publish ('Hide this section and publish') never includes typing the review did not show", async () => {
  const { srv, store, flow } = await fixRig();
  // typed after the review, before the fix
  store.setField("sections.sec_aa.settings.subtitle", "Typed after the review");
  await flow.act({ type: "hideSection", documentId: "doc_home", sectionId: "sec_aa" });
  const publishes = srv.calls.filter((c) => c.op === "publish");
  eq(publishes.length, 1, "no second publish went out:");
  eq(flow.getState().notice, M.WORDS.changedSinceReview, "the founder is told to look again:");
  ok(srv.doc.body.sections[0].enabled !== false, "the hide was not saved on top of unreviewed typing");
  eq(srv.doc.body.sections[0].settings.subtitle, "Typed after the review", "the typing itself is saved as a draft, not lost:");
});

await t("unit: with nothing typed after the review, the fix is saved through the store and published with the saved hash", async () => {
  const { srv, store, flow } = await fixRig();
  await flow.act({ type: "hideSection", documentId: "doc_home", sectionId: "sec_aa" });
  const ops = srv.ops();
  eq(ops.slice(-2), ["saveDraft", "publish"], "save then publish:");
  const save = srv.calls.at(-2);
  eq(save.args.body.sections[0].enabled, false, "the section is hidden in the saved body:");
  eq(save.extra, { revision: 3 }, "saved on the reviewed revision:");
  eq(srv.calls.at(-1).args.draftHash, "h4", "published with the saved hash:");
  eq(store.getState().revision, 4, "the store took the new revision (no 409 on the next autosave):");
  eq(flow.getState().phase, "done", "published:");
  // and the next autosave goes on revision 4
  store.setField("sections.sec_aa.settings.title", "After");
  await store.flush();
  eq(srv.calls.at(-1).extra, { revision: 4 }, "next save:");
  eq(srv.calls.at(-1).op, "saveDraft", "op:");
});

await t("unit: a publish whose review is older than the saved draft is refused, never sent", async () => {
  const srv = server();
  const store = makeStore(srv);
  const call = M.createStoreCall({ api: srv.api, getStore: () => store });
  store.setField("sections.sec_aa.settings.title", "Unreviewed");
  const r = await call("publish", { id: "doc_home", draftHash: "h3" }, { revision: 3 });
  eq([r.refused, r.message], [true, M.WORDS.changedSinceReview], "refused:");
  eq(srv.ops(), ["saveDraft"], "the typing was saved, and no publish was sent:");
  const ok2 = await call("publish", { id: "doc_home", draftHash: "h4" }, { revision: 4 });
  ok(ok2.ok, "the reviewed hash publishes");
  eq(srv.calls.at(-1).args, { id: "doc_home", draftHash: "h4" }, "sent:");
});

await t("unit: Undo from the publish notice uses the current revision after an autosave, not the publish-time one", async () => {
  const srv = server();
  const store = makeStore(srv);
  const call = M.createStoreCall({ api: srv.api, getStore: () => store });
  const pub = await call("publish", { id: "doc_home", draftHash: "h3" }, { revision: 3 });
  const undoArgs = pub.data.published[0].undo; // { id, revision: 3, logId }
  eq(undoArgs.revision, 3, "publish-time revision:");
  store.setField("sections.sec_aa.settings.title", "Typed after publishing");
  await store.flush();
  eq(srv.doc.revision, 4, "autosaved:");
  await call("undo", { id: undoArgs.id, logId: undoArgs.logId, dryRun: true }, { revision: undoArgs.revision });
  await call("undo", { id: undoArgs.id, logId: undoArgs.logId }, { revision: undoArgs.revision });
  const undos = srv.calls.filter((c) => c.op === "undo");
  eq(undos.map((c) => c.extra.revision), [4, 4], "dry run and Undo both on the current revision:");
  eq(undos[1].args, { id: "doc_home", logId: "log_9" }, "the row the founder clicked:");
  eq(store.getState().revision, 5, "the store took the document Undo answered:");
  // keepLiveSection, restoreVersion, discardDraft and unpublish go through the store too
  for (const [op, args] of [["keepLiveSection", { id: "doc_home", sectionId: "sec_aa" }], ["restoreVersion", { id: "doc_home", versionId: "ver_1" }], ["discardDraft", "doc_home"], ["unpublish", { id: "doc_home", dryRun: true }]]) {
    srv.answer(op, { ok: true, data: { document: clone(srv.doc), willTakeOffline: true, linkers: [], changes: [], target: null } });
    await call(op, args, { revision: 1 });
    eq(srv.calls.at(-1).extra, { revision: store.getState().revision }, `${op} on the current revision:`);
  }
  // whole-set Undo with this page in it: flushed first; text typed while it
  // runs is kept as an earlier draft before the store is replaced
  const replaced = [];
  const call2 = M.createStoreCall({ api: srv.api, getStore: () => store, onReplaced: (d) => replaced.push(d) });
  const release = srv.hold("undoSet");
  srv.answer("undoSet", () => ({ ok: true, data: { ok: true, message: "Undone.", documents: [{ ...clone(srv.doc), revision: 99, live: true }] } }));
  srv.answer("keepAsEarlierDraft", { ok: true, data: { savedVersion: { id: "ver_k", note: "Kept from another tab" } } });
  store.setField("sections.sec_aa.settings.title", "Before the set Undo");
  const going = call2("undoSet", { setId: "set_1", members: [{ id: "doc_home", logId: "log_9" }, { id: "doc_x", logId: "log_8" }] });
  await until(() => srv.ops().includes("undoSet"), "the set Undo is sent");
  eq(srv.calls.filter((c) => c.op === "saveDraft").at(-1).args.body.sections[0].settings.title, "Before the set Undo", "flushed before the set Undo:");
  store.setField("sections.sec_aa.settings.title", "Typed during the set Undo");
  release();
  await going;
  const kept = srv.calls.filter((c) => c.op === "keepAsEarlierDraft");
  eq(kept.length, 1, "one keep:");
  eq(kept[0].args.body.sections[0].settings.title, "Typed during the set Undo", "the text typed during it is kept:");
  eq(replaced.map((d) => d.revision), [99], "then the store is replaced with the answer's document:");
  // a keep that fails: the store is not replaced (its next save meets the 409 choice, text on screen)
  srv.answer("keepAsEarlierDraft", { error: true, code: "TOO_MANY_KEPT", message: "Too many kept." });
  const release2 = srv.hold("undoSet");
  const going2 = call2("undoSet", { setId: "set_1", members: [{ id: "doc_home", logId: "log_9" }] });
  await until(() => srv.calls.filter((c) => c.op === "undoSet").length === 2, "the second set Undo is sent");
  store.setField("sections.sec_aa.settings.title", "Typed again");
  release2();
  await going2;
  eq(replaced.length, 1, "not replaced when the keep failed:");
  eq(store.getState().body.sections[0].settings.title, "Typed again", "the text stays:");
  // another document's calls pass through untouched
  await call("getDocument", "doc_other");
  eq(srv.calls.at(-1), { op: "getDocument", args: "doc_other", extra: null }, "pass-through:");
});

// =====================================================================================
console.log("— 5. the local backup, one key per tab (P3-STORE review)");

await t("unit: two tabs on one document at one revision write two keys; tab B dismissing never removes tab A's only local copy", async () => {
  const srv = server();
  const raw = memoryStorage();
  const tabA = M.createTabStorage(raw, "aaaa");
  const tabB = M.createTabStorage(raw, "bbbb");
  const a = makeStore(srv, { storage: tabA });
  const release = srv.hold("saveDraft");
  a.setField("sections.sec_aa.settings.title", "Tab A's words");
  a.flush(); // A's save is in flight
  const keys = () => [...raw.m.keys()].sort();
  eq(keys(), ["storeasy:unsaved:t1:doc_home:3~aaaa"], "A's backup, under A's own key:");
  // B opens on the same document while A's save is in flight: B is offered A's live backup
  const b = makeStore(srv, { storage: tabB });
  await b.open();
  ok(b.getState().backupOffer, "B is offered the backup");
  b.setField("sections.sec_aa.settings.subtitle", "Tab B types too");
  eq(keys(), ["storeasy:unsaved:t1:doc_home:3~aaaa", "storeasy:unsaved:t1:doc_home:3~bbbb"], "B writes its own key, A's stays:");
  // B dismisses the offer: A's key goes from storage, and the browser tells tab A
  const aBody = raw.getItem("storeasy:unsaved:t1:doc_home:3~aaaa");
  b.dismissBackup();
  eq(raw.getItem("storeasy:unsaved:t1:doc_home:3~aaaa"), null, "B's dismiss removed the key:");
  tabA.onStorage({ key: "storeasy:unsaved:t1:doc_home:3~aaaa", oldValue: aBody, newValue: null });
  eq(raw.getItem("storeasy:unsaved:t1:doc_home:3~aaaa"), aBody, "tab A wrote its copy back at once:");
  ok(JSON.parse(raw.getItem("storeasy:unsaved:t1:doc_home:3~aaaa")).body.sections[0].settings.title === "Tab A's words", "with A's words");
  // the key B wrote is B's: A doesn't touch it, and storage cleared in another tab is rewritten
  tabA.onStorage({ key: "storeasy:unsaved:t1:doc_home:3~bbbb", newValue: null });
  raw.m.clear();
  tabA.onStorage({ key: null });
  tabB.onStorage({ key: null });
  eq(keys(), ["storeasy:unsaved:t1:doc_home:3~aaaa", "storeasy:unsaved:t1:doc_home:3~bbbb"], "a clear() elsewhere: each tab writes its own back:");
  release();
  await until(() => !a.getState().unacknowledged, "A's save lands");
  eq(raw.getItem("storeasy:unsaved:t1:doc_home:3~aaaa"), null, "A clears its own key on acknowledgement:");
  ok(raw.getItem("storeasy:unsaved:t1:doc_home:3~bbbb"), "and leaves B's");
  // a key from an earlier visit (no tab id) is still found and offered
  const raw2 = memoryStorage();
  raw2.setItem("storeasy:unsaved:t1:doc_home:3", JSON.stringify({ v: 1, baseRevision: 3, savedAt: 1, body: { type: "home", sections: [] } }));
  const c = makeStore(server(), { storage: M.createTabStorage(raw2, "cccc") });
  await c.open();
  ok(c.getState().backupOffer, "an older visit's backup is offered");
  c.dismissBackup();
  eq(raw2.length, 0, "and dismissing it removes it:");
});

await t("P3-FIX5 unit: 'Keep them as an earlier draft' from the local backup asks for the backup's note (from: 'backup'); another tab's keep does not", async () => {
  const srv = server();
  srv.answer("keepAsEarlierDraft", (args) => ({ ok: true, data: { ok: true, savedVersion: { id: "ver_k", note: args?.from === "backup" ? "Edits this browser kept" : "Kept from another tab" } } }));
  const raw = memoryStorage();
  raw.setItem("storeasy:unsaved:t1:doc_home:3", JSON.stringify({ v: 1, baseRevision: 3, savedAt: 1, body: { type: "home", sections: [{ id: "sec_aa", kind: "hero", settings: { title: "Never reached the server" } }] } }));
  const s = makeStore(srv, { storage: M.createTabStorage(raw, "dddd") });
  await s.open();
  ok(s.getState().backupOffer, "the backup is offered");
  const r = await s.acceptBackup();
  ok(r.ok, `kept: ${JSON.stringify(r)}`);
  const call = srv.calls.find((c) => c.op === "keepAsEarlierDraft");
  eq([call?.args?.from, call?.args?.body?.sections?.[0]?.settings?.title], ["backup", "Never reached the server"], "the keep says it is the backup, with its text:");
  // the store's other keep (another tab's draft, undoSet) sends no from
  await s.keepAsEarlierDraft({ type: "home", sections: [] });
  eq(Object.hasOwn(srv.calls.filter((c) => c.op === "keepAsEarlierDraft").at(-1).args, "from"), false, "another tab's keep: no from:");
});

// =====================================================================================
console.log("— 6. the tree and the inspector");

await t("unit: tree changes become store operations by section id; the UX ruling keeps the selection where it was after a change on another row", async () => {
  const before = [{ id: "sec_aa", kind: "hero" }, { id: "sec_bb", kind: "text" }, { id: "sec_cc", kind: "faq" }];
  const moved = [before[1], before[0], before[2]];
  eq(M.treeChangeOps(before, moved, { op: "moveUp", id: "sec_bb" }), [{ kind: "move", id: "sec_bb", index: 0 }], "move:");
  eq(M.treeChangeOps(before, [before[0], before[2]], { op: "remove", id: "sec_bb" }), [{ kind: "remove", id: "sec_bb" }], "remove:");
  const added = [before[0], { id: "sec_dd", kind: "banner" }, ...before.slice(1)];
  eq(M.treeChangeOps(before, added, { op: "add", id: "sec_dd" }), [{ kind: "insert", section: added[1], index: 1 }], "add:");
  const hidden = [before[0], { ...before[1], enabled: false }, before[2]];
  eq(M.treeChangeOps(before, hidden, { op: "hide", id: "sec_bb" }), [{ kind: "set", path: "sections.sec_bb.enabled", value: false }], "hide:");
  eq(M.treeChangeOps(before, moved, { op: "bogus", id: "sec_bb" }), null, "unknown:");
  // the ruling
  eq(M.selectionAfterTree({ selectedId: "sec_cc", op: "moveUp", proposed: "sec_bb", after: moved }), "sec_cc", "move of another row: selection stays:");
  eq(M.selectionAfterTree({ selectedId: "sec_cc", op: "remove", proposed: "sec_cc", after: [before[0], before[2]] }), "sec_cc", "delete of another row: stays:");
  eq(M.selectionAfterTree({ selectedId: "sec_bb", op: "remove", proposed: "sec_cc", after: [before[0], before[2]] }), "sec_cc", "delete of the selected row: its neighbour:");
  eq(M.selectionAfterTree({ selectedId: null, op: "hide", proposed: "sec_bb", after: hidden }), null, "nothing selected stays nothing:");
  eq(M.selectionAfterTree({ selectedId: "sec_cc", op: "add", proposed: "sec_dd", after: added }), "sec_dd", "add selects the new section:");
  // on the real store
  const srv = server({ body: { type: "home", sections: clone(before) } });
  const store = makeStore(srv);
  M.applyTreeOps(store, M.treeChangeOps(before, moved, { op: "moveUp", id: "sec_bb" }), moved);
  eq(store.getState().body.sections.map((s) => s.id), ["sec_bb", "sec_aa", "sec_cc"], "the store moved it:");
  M.applyTreeOps(store, M.treeChangeOps(store.getState().body.sections, hidden, { op: "hide", id: "sec_bb" }), hidden);
  eq(store.getState().body.sections[0].enabled, false, "hidden by id, after the move:");
  eq(M.inspectorPath({ sectionId: "sec_aa", path: "primary" }), "sections.sec_aa.settings.primary", "section path:");
  eq(M.inspectorPath({ sectionId: null, path: "meta.title" }), "meta.title", "meta:");
  eq(M.inspectorPath({ sectionId: null, path: "brand" }), "settings.brand", "document setting:");
});

await t("unit: the switcher lists every document by label with name search; products are listProductContent's rows, each opening its own content (P4-EDITOR)", () => {
  const docs = [
    { id: "doc_home", type: "home", label: "Home page", live: true },
    { id: "doc_header", type: "header", label: "Header", live: true },
    { id: "doc_x1", type: "page", label: "Returns policy", slug: "returns", live: false },
    { id: "doc_x2", type: "campaign", label: "Diwali sale", slug: "diwali", live: true, unpublishedChanges: true },
    { id: "doc_ji", type: "journal_index", label: "Journal", live: true },
    { id: "doc_old", type: "page", label: "Old", archivedAt: "2026-01-01" },
    { id: "doc_prod_0123456789abcdef", type: "product_content", label: "Night serum", entityId: "gid://shopify/Product/7", live: true },
    { id: "doc_coll_0123456789abcdef", type: "collection_content", label: "Summer", entityId: "gid://shopify/Collection/5", live: true },
  ];
  const items = [{ productId: "gid://shopify/Product/7", title: "Moon serum", shopifyTitle: "Night serum", edited: true, live: true, inShopify: true, changedInShopify: false }];
  const all = M.switcherRows({ documents: docs, products: items, openId: "doc_home" });
  eq(all.documents.map((d) => d.label), ["Home page", "Header", "Diwali sale", "Returns policy"], "every editable page, home first; product and collection content are not pages:");
  eq(all.documents[0].open, true, "the open one is marked:");
  eq(all.documents.map((d) => d.state), ["Live", "Live", "Changes not published", "Not published yet"], "states:");
  eq(all.products, [{ kind: "product", id: "gid://shopify/Product/7", label: "Moon serum", secondary: "Shopify title: Night serum", state: "Your edits are live", href: "/admin/editor?product=gid%3A%2F%2Fshopify%2FProduct%2F7", open: false }], "products open their own content:");
  ok(!all.products.some((p) => p.state === M.WORDS.productNotEditable), "no product says 'Not yet editable here'");
  eq(M.switcherRows({ documents: docs, products: [], query: "RETURN" }).documents.map((d) => d.id), ["doc_x1"], "name search:");
  eq(M.productListArgs({ query: "  moon ", filter: "changed_in_shopify", cursor: "c1" }), { q: "moon", filter: "changed_in_shopify", cursor: "c1", limit: 30 }, "the product search goes to listProductContent:");
  eq(M.productListArgs({ filter: "bogus" }), { limit: 30 }, "an unknown filter is all:");
  eq(M.collectionRows([{ id: "gid://shopify/Collection/5", title: "Summer" }, { id: "x", missing: true }]).map((c) => [c.label, c.href]), [["Summer", "/admin/editor?collection=gid%3A%2F%2Fshopify%2FCollection%2F5"]], "collections:");
  eq(M.productCounts({ all: 412, changedInShopify: 3, orphaned: 1 }).map((c) => `${c.label} ${c.count}`), ["Products 412", "Changed in Shopify 3", "No longer in Shopify 1"], "the counts line:");
});

await t("P4-EDITOR unit (P3-FIX5 review): designProblem tells colours that are hidden from a design draft that can't be read; each gets its own words", async () => {
  eq(M.designProblem({ skipped: ["doc_design"] }, { sessionShowsDesign: false }), "hidden", "colours off:");
  eq(M.designProblem({ skipped: ["doc_design"] }, { sessionShowsDesign: null }), "hidden", "not known to be on:");
  eq(M.designProblem({ skipped: ["doc_design"] }, { sessionShowsDesign: true }), "unreadable", "on, still skipped:");
  eq(M.designProblem({ skipped: [] }, { sessionShowsDesign: true }), null, "shown:");
  ok(M.DESIGN_WORDS.unreadable !== PREVIEW_WORDS.designHidden && !/isn't showing your new colours/.test(M.DESIGN_WORDS.unreadable), "the unreadable words are not the hidden words");
  // hidden for good: the frame keeps rendering another session (another tab keeps
  // taking over) whose colours are off, so this controller never knows them on
  const r = previewRig({ documentId: "doc_design" });
  r.setMint(() => ({ ok: true, sid: OWN }));
  await r.ctl.start();
  const sids = ["ps_00000000000000c1", "ps_00000000000000c2", "ps_00000000000000c3"];
  for (const sid of sids) {
    r.ctl.frameLoad();
    r.ctl.message(readyWith({ sid, skipped: ["doc_design"], designShown: false }));
    await tick();
  }
  eq([r.last().label, r.last().words], ["Could not update", PREVIEW_WORDS.designHidden], "colours hidden: the hidden words:");
});

await t("P4-EDITOR unit (P3-FIX5 review): 'Hide them' is not offered while the design is open; it is on any other document", async () => {
  const opens = [];
  const ctl = M.createPreviewController({
    api: { startDocumentsPreview: async () => ({ ok: true, sid: OWN }), setShowDesign: async () => ({ ok: true }) },
    timers: fakeTimers(),
    documentId: "doc_design",
    frame: { setSrc() {}, post() {}, currentPath: () => "/", designOpen: (open) => opens.push(open) },
  });
  await ctl.start();
  ctl.frameLoad();
  ctl.message(readyWith({ sid: OWN, skipped: [], designShown: true }));
  eq(opens, [true], "the design is open: the frame is told to hide the toggle:");
  await ctl.openDocument("doc_home");
  await tick();
  ctl.frameLoad();
  ctl.message(readyWith({ sid: OWN, skipped: ["doc_design"] }));
  eq(opens, [true, false], "home: the toggle is offered again:");
  // the frame's document: a style rule hides the bar's design button, removed again
  const els = new Map();
  const head = { kids: [], appendChild(el) { this.kids.push(el); els.set(el.id, el); } };
  const fakeDoc = {
    head,
    getElementById: (id) => els.get(id) || null,
    createElement: (tag) => ({ tag, id: "", textContent: "", remove() { els.delete(this.id); head.kids = head.kids.filter((k) => k !== this); } }),
  };
  eq(M.applyDesignToggle(fakeDoc, true), true, "applied:");
  M.applyDesignToggle(fakeDoc, true);
  eq(head.kids.length, 1, "once, however often it is called:");
  ok(head.kids[0].textContent.includes('[data-preview-note="design"] button') && head.kids[0].textContent.includes("display:none"), "it hides the bar's Hide them button");
  eq(M.applyDesignToggle(fakeDoc, false), false, "removed:");
  eq(head.kids.length, 0, "nothing left:");
  eq(M.applyDesignToggle(null, true), false, "no document (navigating): nothing, no throw:");
  // the real bar's button is the one the rule matches
  const banner = await readFile(join(ROOT, "components/PreviewBanner.js"), "utf8");
  ok(/<form data-preview-note="design"[\s\S]*?<button type="submit"[^>]*>\s*\{overlay\.showDesign \? "Hide them" : "Show them"\}/.test(banner), "PreviewBanner's Hide them is a button inside [data-preview-note=design]");
  const pane = await readFile(join(ROOT, "components/admin/editor/PreviewPane.js"), "utf8");
  ok(/designOpen: \(open\) =>[\s\S]*?applyDesignToggle\(frameRef\.current\?\.contentDocument, open\)/.test(pane), "PreviewPane gives the controller designOpen on the frame's document");
});

await t("P4-EDITOR unit: 'Keep mine', 'Use Shopify's' and 'Discard edits' go through the store: saved first, on the current revision, and the answer replaces the store", async () => {
  const srv = server({ id: "doc_prod_1", type: "product_content", body: { type: "product_content", settings: { title: { value: "Mine", base_hash: "b", base_value: "Old" } }, sections: [] } });
  const store = makeStore(srv);
  await store.open?.();
  store.setField("settings.badge", "New");
  const replaced = [];
  srv.answer("resolveShopifyChange", (args, extra) => ({ ok: true, data: { document: { ...clone(srv.doc), revision: extra.revision + 1, body: { ...srv.doc.body, settings: { ...srv.doc.body.settings, title: null } } } } }));
  const call = M.createStoreCall({ api: srv.api, getStore: () => store, onReplaced: (d) => replaced.push(d) });
  const r = await call("resolveShopifyChange", { id: "doc_prod_1", field: "title", choice: "shopify" });
  ok(r.ok, "answered");
  const ops = srv.ops();
  ok(ops.indexOf("saveDraft") >= 0 && ops.indexOf("saveDraft") < ops.indexOf("resolveShopifyChange"), `saved first: ${ops.join(",")}`);
  const sent = srv.calls.find((c) => c.op === "resolveShopifyChange");
  eq([sent.args, sent.extra], [{ id: "doc_prod_1", field: "title", choice: "shopify" }, { revision: srv.doc.revision }], "on the current revision:");
  eq(replaced.length, 1, "the store is replaced with the answer:");
  eq(replaced[0].body.settings.title, null, "the field follows Shopify again:");
  srv.answer("discardOrphanEdits", () => ({ ok: true, data: { document: { ...clone(srv.doc), body: { type: "product_content", settings: {}, sections: [] } } } }));
  await call("discardOrphanEdits", { id: "doc_prod_1" });
  eq(srv.calls.at(-1).args, { id: "doc_prod_1" }, "discard names only the document:");
  eq(replaced.length, 2, "and replaces the store:");
});

// =====================================================================================
console.log("— 7. rendered");

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const isJsxFile = (file) => /\/(components|app)\//.test(file) && !/(Model|documentsApi|store|previewMachine)\.js$/.test(file);
function world(stubs) {
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const code = await compile(file);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || local.has(id)) continue;
      const target0 = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
      if (!target0) continue;
      const target = target0.endsWith(".js") ? target0 : `${target0}.js`;
      local.set(id, isJsxFile(target) ? await load(target) : await import(target));
    }
    new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  }
  return load;
}
const marker = (name) => (props) => React.createElement("div", { "data-stub": name, "data-props": JSON.stringify(props ?? {}) });
const S = { mode: "documents", actor: { kind: "member", role: "owner" }, rows: [], recentReads: 0 };
class Redirect extends Error {}
const stubs = {
  "next/navigation": { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), redirect: (to) => { throw new Redirect(to); }, usePathname: () => "/admin/editor" },
  "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
  "@/lib/admin-auth": { adminActor: async () => S.actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
  "@/lib/console-request": { tfetch: (fn) => fn() },
  "@/lib/cms-mode": { getCmsMode: async () => S.mode, DOCUMENTS_MESSAGE: "This store publishes from the new editor." },
  "@/lib/releases": {
    listReleases: async () => ({ releases: [] }),
    getLiveRelease: async () => (S.mode === "documents" ? { documents: true, content_hash: "x" } : { content_hash: "abc", content: {} }),
    snapshotContent: async () => ({ content: {}, hash: "abc" }),
    validateRelease: async () => ({ ok: true }),
    releaseDiff: async () => ({ items: [] }),
  },
};
const load = world(stubs);
const Editor = await load(join(ROOT, "components/admin/editor/DocumentEditor.js"));
const html = (el) => renderToStaticMarkup(el);
const h = React.createElement;
const textOf = (m) => m.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const snap = (over = {}) => ({
  id: "doc_pol",
  type: "page",
  body: { type: "page", meta: { slug: "returns", title: "Returns policy" }, sections: [{ id: "sec_r1", kind: "rich_text", settings: { title: "Returns", html: "<p>Thirty days.</p><p>Unworn.</p>" } }] },
  revision: 3,
  draftHash: "h3",
  document: { id: "doc_pol", type: "page", label: "Returns policy", slug: "returns", publishedVersionId: "ver_1", publishedHash: "h3", access: { canPublish: true, reason: null } },
  status: "saved",
  statusWords: "Saved",
  issues: [],
  ackCount: 0,
  ...over,
});
const entryOf = (s) => ({ id: s.id, type: s.type, label: s.document.label, slug: s.document.slug ?? null });
// Phase 2 line 6: the page hands the editor can and role (an owner's here unless a test says)
const view = (props) => html(h(Editor.EditorView, { load: { status: "ready" }, docs: [{ id: "doc_home", type: "home", label: "Home page", live: true }], can: { write: true, publish: true, offersWrite: true }, role: "owner", ...props }));

await t("rendered: a policy (rich text only) opens in the full-width writing view with the preview behind a toggle; a page with other sections opens beside the preview", () => {
  const s = snap();
  const m = view({ entry: entryOf(s), state: s, preview: h("div", { "data-stub-preview": "" }) });
  ok(/data-writing-view=""/.test(m), "the writing view is there");
  ok(/data-writing=""/.test(m), "the editor says it is writing");
  ok(!/data-editor-layout=/.test(m) && !/data-section-tree/.test(m), "no tree and no side-by-side layout");
  ok(textOf(m).includes(M.WORDS.writingView) && textOf(m).includes("Show the preview"), "the toggle is there");
  ok(/id="f-sec_r1-html"/.test(m), "the rich text field is in the writing view");
  const other = snap({ body: { type: "page", meta: { slug: "about" }, sections: [{ id: "sec_r1", kind: "rich_text", settings: { html: "<p>x</p>" } }, { id: "sec_h1", kind: "faq", settings: { items: [] } }] } });
  const m2 = view({ entry: entryOf(other), state: other, preview: h("div", { "data-stub-preview": "" }) });
  ok(/data-editor-layout=""/.test(m2) && /data-section-tree=""/.test(m2) && !/data-writing-view/.test(m2), "a mixed page: tree, inspector and preview side by side");
  ok(M.isWritingDocument("page", s.body) && !M.isWritingDocument("home", { sections: s.body.sections }) && !M.isWritingDocument("page", { sections: [] }), "isWritingDocument");
});

await t("rendered: a closed store shows the opening copy: 'Your store isn't open yet. Publishing your home page opens it.'", () => {
  const s = snap();
  const closed = view({ entry: entryOf(s), state: s, docs: [{ id: "doc_home", type: "home", label: "Home page", live: false }, { id: "doc_pol", type: "page", label: "Returns policy", live: false }] });
  ok(textOf(closed).includes("Your store isn't open yet. Publishing your home page opens it."), `copy: ${textOf(closed).slice(0, 400)}`);
  ok(/data-closed-store=""/.test(closed), "marked");
  const open = view({ entry: entryOf(s), state: s });
  ok(!textOf(open).includes("isn't open yet"), "an open store doesn't say it");
  ok(M.isStoreClosed([]) && !M.isStoreClosed(null) && !M.isStoreClosed([{ live: true }]), "isStoreClosed");
});

await t("rendered: staff see Publish disabled with the reason, and Take offline disabled with the reason; an owner's are enabled", () => {
  const reason = "Only the store owner or an admin can publish. You can edit and preview.";
  const s = snap({ document: { ...snap().document, access: { canPublish: false, reason } } });
  const m = view({ entry: entryOf(s), state: s, can: { write: true, publish: false, offersWrite: true }, role: "staff", publish: { state: { phase: "closed", order: [], lists: {}, items: [] }, canConfirm: false, on: {} } });
  ok(/<button[^>]*disabled=""[^>]*>Publish<\/button>/.test(m), `Publish disabled: ${m.match(/<button[^>]*>Publish<\/button>/)?.[0]}`);
  ok(textOf(m).includes(reason), "the reason is shown");
  ok(/<button[^>]*disabled=""[^>]*>Take this page offline<\/button>/.test(m), "Take offline disabled for staff");
  const owner = view({ entry: entryOf(snap()), state: snap(), publish: { state: { phase: "closed", order: [], lists: {}, items: [] }, canConfirm: false, on: {} } });
  ok(/<button[^>]*>Publish<\/button>/.test(owner) && !/<button[^>]*disabled=""[^>]*>Publish<\/button>/.test(owner), "an owner's Publish is enabled");
  ok(!textOf(owner).includes(reason), "no reason for an owner");
});

await t("rendered: the default export renders P3-ROUTES' markers on the server (data-document-editor, data-doc, the label) and the note", () => {
  const m = html(h(Editor.default, { document: { id: "doc_home", type: "home", label: "Home page", slug: null }, note: "We couldn't find that page." }));
  ok(/data-document-editor=""/.test(m) && /data-doc="doc_home"/.test(m) && m.includes(">Home page</h2>") && m.includes("We couldn&#x27;t find that page."), m.slice(0, 600));
});

await t("rendered: conflict, backup offer and a link held for a failed save show their choices in words", () => {
  const s = snap({ status: "conflict", statusWords: "This page was changed in another tab.", conflict: { words: "This page was changed in another tab.", choices: ["useNewer", "keepMine"] }, backupOffer: { words: "We found edits that weren't saved. Keep them as an earlier draft?" } });
  const m = textOf(view({ entry: entryOf(s), state: s, blocked: { message: M.WORDS.leaveBlocked, to: "/admin/orders" } }));
  for (const w of ["Load theirs", "Keep mine", "We found edits that weren't saved", "Keep them as an earlier draft", M.WORDS.leaveBlocked, "Leave anyway"]) ok(m.includes(w), `missing: ${w}`);
  const changed = snap({ draftHash: "h4" });
  ok(textOf(view({ entry: entryOf(changed), state: changed })).includes("Go back to the live version"), "Go back to the live version when the draft differs from live");
  ok(!textOf(view({ entry: entryOf(snap()), state: snap() })).includes("Go back to the live version"), "not when the draft is the live version");
});

const RELEASES = join(ROOT, "app/(console)/admin/(authed)/releases/page.js");
const Releases = (await load(RELEASES)).default;
const renderReleases = async () => html(await Releases());

await t("rendered: /admin/releases renders RecentlyPublished, with access passed on; it reads no mode (the list's API refuses a store not in documents mode)", async () => {
  S.mode = "documents";
  S.rows = [
    { logId: "log_1", setId: "set_1", documentId: "doc_home", label: "Home page", action: "publish", actionWords: "Published", byName: "Asha", at: "2026-11-02T10:00:00.000Z", summary: [{ words: "Hero: title changed" }], canUndo: true, undo: { id: "doc_home", revision: 3, logId: "log_1" } },
    { logId: "log_2", setId: "set_2", documentId: "doc_x", label: "Diwali sale", action: "undo", actionWords: "Undid", byName: "Asha", at: "2026-11-02T09:00:00.000Z", summary: [], canUndo: false, undo: null, note: "Publish it again from the editor to bring it back." },
  ];
  const page = await renderReleases();
  ok(/data-recently-published-page=""/.test(page) && textOf(page).includes("Loading what was published"), `the page mounts the documents list: ${page.slice(0, 400)}`);
  // the list once its rows are read (listRecentlyPublished through the documents API)
  const m = html(h(Editor.PublishingHistory, { initialRows: S.rows, access: { canPublish: true, reason: null } }));
  ok(/data-recently-published=""/.test(m), `RecentlyPublished: ${m.slice(0, 500)}`);
  ok(textOf(m).includes("Published Home page") && textOf(m).includes("Hero: title changed") && textOf(m).includes("Publish it again from the editor"), "rows");
  eq((m.match(/>Undo</g) || []).length, 1, "Undo only where canUndo:");

  S.mode = "migrating";
  const mig = await renderReleases();
  ok(/data-recently-published-page=""/.test(mig), "no mode branch on the page:");
  S.mode = "documents";
});

await t("unit: PublishingHistory hands access to RecentlyPublished (staff: Undo disabled with the reason, once P3-FIX3's prop lands)", async () => {
  const seen = [];
  const load2 = world({ ...stubs, "./publish/RecentlyPublished": { __esModule: true, default: (p) => (seen.push(p), null) } });
  const E2 = await load2(join(ROOT, "components/admin/editor/DocumentEditor.js"));
  const access = { canPublish: false, reason: "Only the store owner or an admin can publish or undo. You can edit and preview." };
  html(h(E2.PublishingHistory, { initialRows: [], access }));
  eq(seen[0].access, access, "access passed:");
  // the page hands staff access { canPublish: false, reason } to the list
  const load3 = world({ ...stubs, "@/components/admin/editor/DocumentEditor": { PublishingHistory: marker("PublishingHistory") } });
  const R3 = (await load3(RELEASES)).default;
  const propsFor = async (role) => {
    S.actor = { kind: "member", role };
    const out = html(await R3());
    return JSON.parse(out.match(/data-stub="PublishingHistory" data-props="([^"]*)"/)[1].replace(/&quot;/g, '"'));
  };
  eq((await propsFor("staff")).access, { canPublish: false, reason: "Only the store owner or an admin can publish or undo. You can edit and preview." }, "staff:");
  eq((await propsFor("owner")).access, { canPublish: true, reason: null }, "owner:");
  S.actor = { kind: "member", role: "owner" };
});

// P4-FIX3 (P4-EDITOR review): the view while one product's page has moved to
// another and the store still holds the first
await t("P4-FIX3 rendered: while the store still holds product A and the page has moved to product B, no product form is shown (A's draft never meets B's Shopify values); once B is open, B's form is", () => {
  const settings = { title: { value: "Alpha mine", base_hash: "x", base_value: "Alpha" } };
  const a = snap({ id: "doc_prod_aaaaaaaaaaaaaaaa", type: "product_content", body: { type: "product_content", settings, sections: [] }, document: { id: "doc_prod_aaaaaaaaaaaaaaaa", type: "product_content", label: "Alpha mine", entityId: "gid://shopify/Product/1", access: { canPublish: true, reason: null } } });
  const bEntry = { id: "doc_prod_bbbbbbbbbbbbbbbb", type: "product_content", label: "Beta", slug: null };
  const beta = { inShopify: true, shopify: { title: "Beta", handle: "beta", description_html: "", vendor: "", product_type: "", gallery: [] }, titleEditable: true };
  const moving = textOf(view({ entry: bEntry, state: a, entity: beta }));
  ok(!moving.includes("Alpha mine") && !moving.includes("Shopify title: Beta"), `no form while B loads: ${moving.slice(0, 400)}`);
  ok(moving.includes("Opening Beta"), "the editor says it is opening B");
  const settled = textOf(view({ entry: entryOf(a), state: a, entity: { ...beta, shopify: { ...beta.shopify, title: "Alpha" } } }));
  ok(settled.includes("Alpha mine") && settled.includes("Shopify title: Alpha"), `A's own form when A is the entry: ${settled.slice(0, 300)}`);
});

// P4-FIX5 (P4-FIX3 review (a), (b)): while the page has moved to B and the
// store still holds A, A's actions (Publish, Discard…) and A's Earlier
// versions panel are held back with the form
await t("P4-FIX5 rendered: during a switch from product A to B the actions bar and the Earlier versions panel are hidden; once B is open both show again", () => {
  const settings = { title: { value: "Alpha mine", base_hash: "x", base_value: "Alpha" } };
  const a = snap({ id: "doc_prod_aaaaaaaaaaaaaaaa", type: "product_content", body: { type: "product_content", settings, sections: [] }, document: { id: "doc_prod_aaaaaaaaaaaaaaaa", type: "product_content", label: "Alpha mine", entityId: "gid://shopify/Product/1", access: { canPublish: true, reason: null } } });
  const bEntry = { id: "doc_prod_bbbbbbbbbbbbbbbb", type: "product_content", label: "Beta", slug: null };
  const beta = { inShopify: true, shopify: { title: "Beta", handle: "beta", description_html: "", vendor: "", product_type: "", gallery: [] }, titleEditable: true };
  const versions = { status: "ready", rows: [], message: null };
  const moving = view({ entry: bEntry, state: a, entity: beta, versions });
  ok(textOf(moving).includes("Opening Beta"), "the editor says it is opening B");
  ok(!/data-editor-actions=""/.test(moving), "no actions bar while B loads");
  ok(!/data-versions-toggle=""/.test(moving), "no Earlier versions button while B loads");
  ok(!/data-earlier-versions-panel=""/.test(moving), "no Earlier versions panel while B loads");
  // the same view with A as the entry shows both (the check above is not vacuous)
  const settled = view({ entry: entryOf(a), state: a, entity: { ...beta, shopify: { ...beta.shopify, title: "Alpha" } }, versions });
  ok(/data-editor-actions=""/.test(settled), "A's actions bar when A is the entry");
  ok(/data-earlier-versions-panel=""/.test(settled), "A's Earlier versions panel when A is the entry");
});

// edge safety and imports
await t("editorModel imports only the registry, paths and the preview machine (no React, no DOM, no node:)", async () => {
  const src = await readFile(join(ROOT, "components/admin/editor/editorModel.js"), "utf8");
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  eq(imports, ["../../../lib/registry/index.js", "../../../lib/documents/paths.js", "./previewMachine.js"], "imports:");
  ok(!/\bfetch\(/.test(src), "the model fetches nothing");
  ok(!/\bwindow\.|\bdocument\.|localStorage|node:/.test(src.replace(/\/\/.*$/gm, "")), "no DOM globals or node: in the model");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
