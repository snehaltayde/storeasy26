// P3-EDITOR (ED-02, ED-03, ED-04, PV-01, PV-02, PUB-02, PUB-04, PUB-06,
// PUB-11): the editor's interaction logic. Pure: no React, no DOM globals, no
// timers of its own. DocumentEditor.js, Switcher.js, PreviewPane.js and
// StatusLine.js only wire events to these functions, so node drives every
// rule here (scripts/test-editor-shell.js).
//
//   pickPlan(pick, ctx)           a click in the preview: select a section and
//                                 focus its field, or open another document
//                                 with a note (and write nothing to this one)
//   treeChangeOps(before, after, meta)   a tree change as store operations
//   selectionAfterTree(…)         where the selection goes after a tree change
//   inspectorPath(…)              an inspector edit's path in the body
//   createStoreCall(…)            documentsApi.call, with this document's
//                                 writes routed through its store (plan A5)
//   createNavGuard(…)             in-app links wait for the save (ED-03)
//   createTabStorage(…)           local backup keys scoped to this tab
//   createPreviewController(…)    the preview frame: mint, showDesign,
//                                 re-mint, ready timer, refresh (PV-01)
//   switcherRows(…), isStoreClosed(…), isWritingDocument(…), framePathFor(…)
import { documentType } from "../../../lib/registry/index.js";
import { livePath } from "../../../lib/documents/paths.js";
import { createPreviewMachine, READY_TIMEOUT_MS, PREVIEW_WORDS } from "./previewMachine.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const q = (s) => `“${s}”`;

export const WORDS = Object.freeze({
  closedStore: "Your store isn't open yet. Publishing your home page opens it.",
  switched: (picked, from) => `You picked ${picked} in the preview, so the editor opened it. Nothing changed on ${from}.`,
  adding: "Adding to preview…",
  changedSinceReview: "This page changed after you looked at what will go live, so nothing was published. Open Publish again to see the latest changes.",
  notSavedYet: "Your latest changes aren't saved yet, so nothing else was done. They are still here.",
  leaveBlocked: "Your latest changes aren't saved yet, so we stayed on this page. They are still here.",
  leaveAnyway: "Leave anyway",
  productNotEditable: "Not yet editable here",
  productNote: "Product pages share one layout for now. Editing one product's own content comes later.",
  writingView: "This page is all text, so it opens as a writing page. Show the preview to see it on your store.",
  showPreview: "Show the preview",
  hidePreview: "Hide the preview",
  goBackToLive: "Go back to the live version",
  goBackConfirm: "Go back to the live version? Your current draft is kept in Earlier versions.",
  goBackDone: "Your draft is back to the live version. The draft you had is in Earlier versions.",
  notFoundSingleton: (label) => `${label} hasn't been changed on this store yet, so there is nothing to edit until you start it.`,
  start: "Start editing",
  loading: (label) => `Opening ${label}…`,
  loadFailed: "We couldn't open this page. Check your internet connection, then reload.",
});

// ---- documents --------------------------------------------------------------------

// A document whose content is only rich text (a policy page): it opens as a
// full-width writing view, with the preview behind a toggle.
export function isWritingDocument(type, body) {
  if (type !== "page" && type !== "journal") return false;
  const list = isObj(body) && Array.isArray(body.sections) ? body.sections : [];
  return list.length > 0 && list.every((s) => isObj(s) && s.kind === "rich_text");
}

// The store is closed (PUB-06) when nothing has ever gone live: no document
// row is live. listDocuments' rows carry `live`.
export function isStoreClosed(rows) {
  if (!Array.isArray(rows)) return false;
  return !rows.some((r) => isObj(r) && r.live === true);
}

// The address the preview frame shows for a document. A product or a
// collection layout shows one real product or collection page.
export function framePathFor(doc, { productHandle = null, collectionHandle = null } = {}) {
  if (!isObj(doc)) return "/";
  if (doc.type === "product_layout") return productHandle ? `/products/${encodeURIComponent(productHandle)}` : "/";
  if (doc.type === "collection_layout") return collectionHandle ? `/collections/${encodeURIComponent(collectionHandle)}` : "/collections";
  if (doc.type === "collections_index") return "/collections";
  const slug = isObj(doc.body?.meta) && typeof doc.body.meta.slug === "string" ? doc.body.meta.slug : doc.slug;
  return livePath(doc.type, { slug });
}

const SYSTEM = (type) => {
  const t = documentType(type);
  return !t || t.system === true || t.editable === false || type === "product_content";
};
const ORDER = ["home", "header", "announcement", "footer", "design", "collections_index", "product_layout", "collection_layout", "cart"];
const rank = (type) => {
  const i = ORDER.indexOf(type);
  return i < 0 ? ORDER.length : i;
};

// The switcher's list: every document by label (search by name or address),
// and the store's products by name, each marked "not yet editable here"
// (product content waits for OVL-02).
export function switcherRows({ documents = [], products = [], query = "", openId = null } = {}) {
  const term = String(query ?? "").trim().toLowerCase();
  const hit = (...words) => !term || words.some((w) => typeof w === "string" && w.toLowerCase().includes(term));
  const docs = (Array.isArray(documents) ? documents : [])
    .filter((d) => isObj(d) && typeof d.id === "string" && !d.archivedAt && !SYSTEM(d.type))
    .filter((d) => hit(d.label, d.slug, documentType(d.type)?.label))
    .sort((a, b) => rank(a.type) - rank(b.type) || String(a.label).localeCompare(String(b.label)))
    .map((d) => ({
      kind: "document",
      id: d.id,
      label: d.label || documentType(d.type)?.label || "Untitled",
      type: d.type,
      typeLabel: documentType(d.type)?.label || "",
      open: d.id === openId,
      state: d.live ? (d.unpublishedChanges ? "Changes not published" : "Live") : "Not published yet",
    }));
  const prods = (Array.isArray(products) ? products : [])
    .filter((p) => isObj(p) && typeof p.title === "string" && hit(p.title, p.handle))
    .map((p) => ({ kind: "product", id: String(p.handle ?? p.id), label: p.title, state: WORDS.productNotEditable }));
  return { documents: docs, products: prods };
}

// ---- click to select (ED-04) -----------------------------------------------------------

// A pick from the frame ({doc, sectionId, kind, field, offset}).
//   another document: { kind: "switch", documentId, sectionId, focusRequest, note }
//                     and nothing is written to the open document
//   the open one:     { kind: "select", sectionId, focusRequest {path, offset} }
//   nothing:          { kind: "none" }
//   fallbackSectionId   the section a pick with none selects on the open
//                       document: a product or collection page's store-owned
//                       section (the page itself is that section; its markup
//                       carries no section id), so a click on Add to cart
//                       there selects it
export function pickPlan(pick, { openId, openLabel = "this page", labelOf = () => null, fallbackSectionId = null } = {}) {
  if (!isObj(pick)) return { kind: "none" };
  const doc = typeof pick.doc === "string" && pick.doc ? pick.doc : null;
  const own = !doc || doc === openId;
  const sectionId = typeof pick.sectionId === "string" && pick.sectionId ? pick.sectionId : own && !pick.field && fallbackSectionId ? fallbackSectionId : null;
  if (!doc && !sectionId) return { kind: "none" };
  const field = typeof pick.field === "string" && pick.field ? pick.field : null;
  const focusRequest = field ? { path: field, offset: Number.isInteger(pick.offset) ? pick.offset : null } : null;
  const target = doc || openId;
  if (target !== openId) {
    const label = labelOf(target) || documentType(String(target).replace(/^doc_/, ""))?.label || "that part of your store";
    return { kind: "switch", documentId: target, sectionId, focusRequest, note: WORDS.switched(q(label), q(openLabel)) };
  }
  return { kind: "select", sectionId, focusRequest };
}

// ---- the tree and the inspector as store operations ------------------------------------

const indexOf = (list, id) => (Array.isArray(list) ? list.findIndex((s) => isObj(s) && s.id === id) : -1);

// A SectionTree / AddSection change ({op, id}) as store operations, so an
// edit typed during a server-replace hold is replayed by section id, never
// as a whole list. null when the change can't be read (the caller then sets
// the whole list).
export function treeChangeOps(before, after, meta) {
  const op = meta?.op;
  const id = meta?.id;
  if (!Array.isArray(after) || typeof id !== "string") return null;
  switch (op) {
    case "add":
    case "duplicate": {
      const i = indexOf(after, id);
      return i < 0 ? null : [{ kind: "insert", section: after[i], index: i }];
    }
    case "moveUp":
    case "moveDown": {
      const i = indexOf(after, id);
      return i < 0 ? null : [{ kind: "move", id, index: i }];
    }
    case "remove":
      return [{ kind: "remove", id }];
    case "hide":
    case "show": {
      const s = after[indexOf(after, id)];
      if (!isObj(s)) return null;
      const was = Array.isArray(before) ? before[indexOf(before, id)] : null;
      const ops = [{ kind: "set", path: `sections.${id}.enabled`, value: s.enabled }];
      if (JSON.stringify(s.show) !== JSON.stringify(was?.show)) ops.push({ kind: "set", path: `sections.${id}.show`, value: s.show });
      return ops;
    }
    default:
      return null;
  }
}

export function applyTreeOps(store, ops, after) {
  if (!ops) return store.setField("sections", after);
  for (const o of ops) {
    if (o.kind === "insert") store.insertSection(o.section, o.index);
    else if (o.kind === "move") store.moveSection(o.id, o.index);
    else if (o.kind === "remove") store.removeSection(o.id);
    else if (o.kind === "set") store.setField(o.path, o.value);
  }
  return true;
}

// UX ruling (P3-TREE review): after a move, hide, show or delete on a row
// that is not selected, the founder's selection stays where it was. Adding
// or copying selects the new section (ED-04). Deleting the selected row
// selects its neighbour, as the tree proposes.
export function selectionAfterTree({ selectedId = null, op, proposed = null, after = [] } = {}) {
  if (op === "add" || op === "duplicate") return proposed;
  if (selectedId == null) return null;
  return indexOf(after, selectedId) >= 0 ? selectedId : proposed;
}

// An inspector edit's path in the body: a section form's path is under the
// section's settings; a document form's is under its settings, except meta.
export function inspectorPath({ sectionId = null, path }) {
  const p = String(path ?? "");
  if (sectionId) return `sections.${sectionId}.settings.${p}`;
  return p.startsWith("meta.") ? p : `settings.${p}`;
}

// ---- the store's call (plan A5, P3-PUBLISHUI review) -----------------------------------

const idOfArgs = (args) => (typeof args === "string" ? args : isObj(args) && typeof args.id === "string" ? args.id : null);
export const storeDocument = (s) => ({ ...(s.document || {}), id: s.id, type: s.type, body: s.body, revision: s.revision, draftHash: s.draftHash });

// documentsApi.call for the publish panel, Undo and Earlier versions, with
// every write to the open document routed through its store, so autosave is
// flushed and held and the store takes the server's new draft:
//   getDocument        the store's acknowledged document, after a flush
//   saveDraft          (a publish fix) only when the saved draft is still
//                      the one the review showed (getPinned); the edit is
//                      applied through the store and saved
//   publish/publishSet only when, after a flush, the acknowledged draft is
//                      the one the review showed: never typing it didn't show
//   undo, unpublish, keepLiveSection, restoreVersion, discardDraft
//                      the store's server-replace operations, on the
//                      current revision (never the publish-time one)
//   undoSet            flushed first; a returned document for this page
//                      replaces the store (onReplaced)
// Everything else goes to api.call as it is.
export function createStoreCall({ api, getStore, getPinned = () => null, onReplaced = () => {} }) {
  const refusal = { refused: true, code: "DRAFT_CHANGED", message: WORDS.changedSinceReview };
  async function flushed(store) {
    const f = await store.beforeNavigate();
    if (!f || !f.ok) return { error: true, code: f?.code || "NOT_SAVED", message: f?.message || WORDS.notSavedYet };
    return null;
  }
  return async function call(op, args, extra) {
    const store = getStore();
    const openId = store ? store.getState().id : null;
    const id = idOfArgs(args);
    if (!store || !openId) return api.call(op, args, extra);
    const mine = id === openId;
    switch (op) {
      case "getDocument": {
        if (!mine) break;
        const e = await flushed(store);
        if (e) return e;
        return { ok: true, data: { document: storeDocument(store.getState()) } };
      }
      case "saveDraft": {
        if (!mine) break;
        const e = await flushed(store);
        if (e) return e;
        const s = store.getState();
        const pinned = getPinned(openId);
        if (pinned && s.draftHash !== pinned) return refusal;
        const body = isObj(args.body) ? args.body : {};
        for (const k of Object.keys(body)) if (JSON.stringify(body[k]) !== JSON.stringify(s.body?.[k])) store.setField(k, body[k]);
        const f = await store.flush();
        if (!f.ok) return { error: true, code: f.code || "NOT_SAVED", message: f.message || WORDS.notSavedYet };
        return { ok: true, data: { document: storeDocument(store.getState()) } };
      }
      case "publish": {
        if (!mine) break;
        const e = await flushed(store);
        if (e) return e;
        const s = store.getState();
        // synchronous from here to the store's own flush: no typing can land between
        if (s.unacknowledged || s.draftHash !== args.draftHash) return refusal;
        return store.publish({ confirmRepublish: args.confirmRepublish === true });
      }
      case "publishSet": {
        const items = Array.isArray(args) ? args : [];
        const entry = items.find((it) => isObj(it) && it.id === openId);
        if (!entry) break;
        const e = await flushed(store);
        if (e) return e;
        const s = store.getState();
        if (s.unacknowledged || s.draftHash !== entry.draftHash) return refusal;
        return store.publishSet(items);
      }
      case "undo":
        if (!mine) break;
        return store.undo({ logId: args.logId, dryRun: args.dryRun === true });
      case "unpublish":
        if (!mine) break;
        return store.unpublish({ dryRun: args.dryRun === true });
      case "keepLiveSection":
        if (!mine) break;
        return store.keepLiveSection(args.sectionId);
      case "restoreVersion":
        if (!mine) break;
        return store.restoreVersion(args.versionId);
      case "discardDraft":
        if (!mine) break;
        return store.discardDraft();
      case "undoSet": {
        const members = isObj(args) && Array.isArray(args.members) ? args.members : [];
        if (!members.some((m) => isObj(m) && m.id === openId) || args.dryRun) break;
        const e = await flushed(store);
        if (e) return e;
        const r = await api.call(op, args, extra);
        // text typed while the set Undo ran is kept as an earlier draft before
        // the store is replaced. If it can't be kept, the store is not
        // replaced: its next save meets the 409 choice with the text on screen
        if (r && r.ok && store.getState().unacknowledged) {
          const k = await store.keepAsEarlierDraft(store.getState().body);
          if (!k || !k.ok) return r;
        }
        const doc = r && r.ok && Array.isArray(r.data?.documents) ? r.data.documents.find((d) => isObj(d) && d.id === openId) : null;
        if (doc && isObj(doc.body)) onReplaced(doc);
        else if (r && r.ok) {
          const g = await api.call("getDocument", openId);
          if (g && g.ok && isObj(g.data?.document)) onReplaced(g.data.document);
        }
        return r;
      }
      default:
        break;
    }
    return api.call(op, args, extra);
  };
}

// ---- leaving (ED-03) ---------------------------------------------------------------------

const closest = (el, sel) => (el && typeof el.closest === "function" ? el.closest(sel) : null);

// The in-app address a click on a console link goes to, or null (another
// site, a new tab, a download, a same-page #anchor, a modified click).
export function consoleLinkOf(event, { origin, here = "" } = {}) {
  if (!event || event.defaultPrevented) return null;
  if ((event.button ?? 0) !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const a = closest(event.target, "a[href]");
  if (!a) return null;
  const target = a.getAttribute("target");
  if (target && target !== "_self") return null;
  if (a.hasAttribute?.("download")) return null;
  let url;
  try {
    url = new URL(a.getAttribute("href"), origin + (here || "/"));
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const to = url.pathname + url.search;
  if (url.hash && to === here) return null; // a jump on this page
  return to + url.hash;
}

// Capture-phase click handler on console anchors: while the store holds
// anything unacknowledged, the click waits for store.beforeNavigate() and
// only then routes. A save that fails keeps the founder here, with words.
export function createNavGuard({ getStore, navigate, origin, here = () => "", onBlocked = () => {} }) {
  async function go(to) {
    const store = getStore();
    if (store && store.getState().unacknowledged) {
      const r = await store.beforeNavigate();
      if (!r || !r.ok) {
        onBlocked({ to, message: r?.conflict ? r.message : WORDS.leaveBlocked });
        return false;
      }
    }
    navigate(to);
    return true;
  }
  function onClickCapture(event) {
    const store = getStore();
    if (!store || !store.getState().unacknowledged) return null; // nothing to wait for: the link works as usual
    const to = consoleLinkOf(event, { origin, here: here() });
    if (!to) return null;
    event.preventDefault();
    event.stopPropagation();
    return go(to);
  }
  return { onClickCapture, go };
}

// ---- local backup, one key per tab (P3-STORE review) -------------------------------------

export const BACKUP_PREFIX = "storeasy:unsaved:";
// A storage for the store whose backup keys carry this tab's id, so two tabs
// on one document at one revision never write the same key. Keys found from
// earlier visits (or other tabs) are read and removed as they are. When
// another tab removes a key this tab still needs (it dismissed or accepted
// our live backup), onStorage writes it again.
export function createTabStorage(storage, tabId) {
  if (!storage || !tabId) return storage || null;
  const suffix = `~${tabId}`;
  const own = new Map();
  const mapKey = (k) => (typeof k === "string" && k.startsWith(BACKUP_PREFIX) && !k.includes("~") ? `${k}${suffix}` : k);
  // A key this tab wrote is read and removed under its tab name; any other key
  // (found by key(i): an earlier visit's, another tab's) is used as it is.
  const known = (k) => {
    const m = mapKey(k);
    return own.has(m) ? m : k;
  };
  return {
    getItem: (k) => storage.getItem(known(k)),
    setItem(k, v) {
      const m = mapKey(k);
      storage.setItem(m, v);
      if (m.endsWith(suffix)) own.set(m, String(v));
    },
    removeItem(k) {
      const m = known(k);
      own.delete(m);
      storage.removeItem(m);
    },
    key: (i) => storage.key(i),
    get length() {
      return storage.length;
    },
    // window "storage" event from another tab
    onStorage(e) {
      if (!e) return;
      const rewrite = (k, v) => {
        try {
          storage.setItem(k, v);
        } catch {
          /* storage that throws: the text is still on screen */
        }
      };
      if (e.key == null) {
        for (const [k, v] of own) rewrite(k, v);
        return;
      }
      if (own.has(e.key) && e.newValue !== own.get(e.key)) rewrite(e.key, own.get(e.key));
    },
    ownKeys: () => [...own.keys()],
  };
}

// ---- "Adding to preview…" ----------------------------------------------------------------

// pending: { [sectionId]: ackCount when it was added }. A section is in the
// frame once the frame shows a save acknowledged after it was added.
export function pendingAfterShown(pending, shownAck) {
  const left = {};
  const done = [];
  for (const [id, since] of Object.entries(isObj(pending) ? pending : {})) {
    if (Number.isFinite(shownAck) && shownAck > since) done.push(id);
    else left[id] = since;
  }
  return { pending: left, done };
}

// ---- the preview frame (PV-01, PUB-11) ---------------------------------------------------

const defaultTimers = () => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
});
export const showDesignFor = (documentId) => documentId === "doc_design";

// Drives one preview frame across documents.
//   api      { startDocumentsPreview({showDesign}), setShowDesign(sid, on) }
//   frame    { setSrc(path), post(msg), currentPath() }
//   pathFor(documentId)   the address the frame shows
//   onChange(view)        view: { label, words, field, note, phase, reconnecting, shownAck }
//   onPick(pick)
// showDesign is on while doc_design is open and off otherwise. The session is
// minted again when the bridge reports ok:false (the session ended, or the
// frame shows the live store) or when no ready arrives within 3 seconds of a
// frame load; "Reconnecting…" shows meanwhile. Nothing re-mints before the
// session's expiry (PV-04 is P1).
export function createPreviewController({ api, frame, pathFor = () => "/", documentId = null, timers = defaultTimers(), onChange = () => {}, onPick = () => {} }) {
  let docId = documentId;
  let machine = createPreviewMachine({ documentId: docId });
  let last = machine.current;
  let sid = null;
  let shown = null; // the showDesign the session has
  let bridge = false; // a v2 ready since the last load
  let timer = null;
  let token = 0;
  let expectAck = 0;
  let shownAck = 0;
  let disposed = false;
  const log = []; // what the controller did, for tests and the drill

  const view = () => ({
    label: last.label,
    words: last.words,
    field: last.field,
    note: last.note,
    phase: last.state.phase,
    reconnecting: last.words === PREVIEW_WORDS.reconnecting,
    shownAck,
    documentId: docId,
    sid,
    showDesign: shown,
  });
  const clearTimer = () => {
    if (timer != null) timers.clearTimeout(timer);
    timer = null;
  };
  function act(a) {
    if (disposed) return;
    last = a;
    if (a.state.phase === "shown") shownAck = expectAck;
    onChange(view());
    if (a.remint) mint();
    if (a.reload) reload();
    if (a.armReadyTimer) {
      clearTimer();
      log.push("armReadyTimer");
      timer = timers.setTimeout(() => {
        timer = null;
        log.push("readyTimeout");
        act(machine.send({ type: "readyTimeout" }));
      }, READY_TIMEOUT_MS);
    }
  }
  async function mint() {
    const mine = ++token;
    const want = showDesignFor(docId);
    log.push(`mint:${want}`);
    let r;
    try {
      r = await api.startDocumentsPreview({ showDesign: want });
    } catch {
      r = { error: true, message: PREVIEW_WORDS.mintFailed };
    }
    if (disposed || mine !== token) return;
    if (r && r.ok) {
      log.push("minted");
      sid = r.sid;
      shown = want;
      act(machine.send({ type: "mintOk" }));
    } else act(machine.send({ type: "mintFailed", message: r?.message }));
  }
  function reload() {
    const path = pathFor(docId);
    let at = null;
    try {
      at = frame.currentPath();
    } catch {
      at = null;
    }
    if (bridge && at === path) {
      bridge = false;
      log.push("refresh");
      frame.post({ type: "storeasy:refresh" });
      act(machine.send({ type: "refreshSent" }));
      return;
    }
    bridge = false;
    log.push(`src:${path}`);
    frame.setSrc(path);
  }
  async function openDocument(next) {
    if (next === docId && sid) return;
    docId = next;
    machine = createPreviewMachine({ documentId: docId });
    last = machine.current;
    clearTimer();
    onChange(view());
    if (!sid) return mint();
    const want = showDesignFor(docId);
    if (want !== shown) {
      const mine = ++token;
      log.push(`setShowDesign:${want}`);
      let r;
      try {
        r = await api.setShowDesign(sid, want);
      } catch {
        r = { error: true };
      }
      if (disposed || mine !== token) return;
      if (!r || !r.ok) return mint(); // a new session with the right setting
      shown = want;
    }
    act(machine.send({ type: "mintOk" }));
  }

  return {
    start: () => mint(),
    openDocument,
    // the same document at a new address (its slug changed, or the product
    // the frame shows was only known later): load it there
    pathChanged() {
      if (!sid || last.state.phase === "minting") return;
      act(machine.send({ type: "mintOk" }));
    },
    frameLoad() {
      bridge = false;
      log.push("frameLoad");
      act(machine.send({ type: "frameLoad" }));
    },
    message(data) {
      if (!isObj(data) || typeof data.type !== "string") return;
      if (data.type === "storeasy:ready") {
        if (data.v !== 2) {
          frame.post({ type: "storeasy:editor:hello", v: 2 });
          return;
        }
        bridge = true;
        clearTimer();
        log.push(`ready:${data.ok === true ? "ok" : data.reason || "live"}`);
        act(machine.send({ type: "ready", ok: data.ok === true, state: data.state, reason: data.reason }));
        return;
      }
      if (data.type === "storeasy:pick") onPick(data);
    },
    saveAck({ draftHash, issues, ackCount }) {
      if (Number.isFinite(ackCount)) expectAck = ackCount;
      act(machine.send({ type: "saveAck", draftHash, issues }));
    },
    saveFailed({ message, field }) {
      act(machine.send({ type: "saveFailed", message, field }));
    },
    savePending({ message, issues }) {
      act(machine.send({ type: "savePending", message, issues }));
    },
    retry() {
      act(machine.send({ type: "retry" }));
    },
    select(sectionId) {
      if (bridge) frame.post({ type: "storeasy:select", sectionId: sectionId || null });
    },
    view,
    get log() {
      return log;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
