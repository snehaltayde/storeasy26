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
//
// P4-EDITOR (OVL-04, OVL-01, OVL-06, ED-12, ED-02): a product's and a
// collection's content.
//   productRows(…), collectionRows(…), productListArgs(…), PRODUCT_FILTERS
//                                 the switcher's Products and Collections
//                                 sections (listProductContent, the refs read)
//   entityHref(…)                 where a product or collection row opens
//                                 (lib/admin/editor-entry.js's URL contract)
//   overlayState(…), editOverlay(…), sameAsShopify(…), shopifyChanges(…),
//   productFormModel(…), capNotes(…), moduleOptions(…), PRODUCT_WORDS
//                                 the product form's rules (pure)
//   applyDesignToggle(doc, open)  the preview bar's Hide them, hidden while
//                                 the design is open (P3-FIX5 review)
import { documentType, allowedKinds, stableStringify } from "../../../lib/registry/index.js";
import { livePath } from "../../../lib/documents/paths.js";
import { createPreviewMachine, designHiddenIn, READY_TIMEOUT_MS, PREVIEW_WORDS } from "./previewMachine.js";

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
  productNote: "Pick a product to change its name, images, description and more. Price, variants and stock stay Shopify's.",
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
export function framePathFor(doc, { productHandle = null, collectionHandle = null, entityHandle = null } = {}) {
  if (!isObj(doc)) return "/";
  // P4-EDITOR: a product's or collection's own page (decision 14: the page
  // merges its own draft in a preview session)
  if (doc.type === "product_content") return entityHandle ? `/products/${encodeURIComponent(entityHandle)}` : "/";
  if (doc.type === "collection_content") return entityHandle ? `/collections/${encodeURIComponent(entityHandle)}` : "/collections";
  if (doc.type === "product_layout") return productHandle ? `/products/${encodeURIComponent(productHandle)}` : "/";
  if (doc.type === "collection_layout") return collectionHandle ? `/collections/${encodeURIComponent(collectionHandle)}` : "/collections";
  if (doc.type === "collections_index") return "/collections";
  const slug = isObj(doc.body?.meta) && typeof doc.body.meta.slug === "string" ? doc.body.meta.slug : doc.slug;
  return livePath(doc.type, { slug });
}

// P4-EDITOR: product and collection content are listed in their own sections
// (Products, Collections), never among the pages, and are editable.
export const ENTITY_TYPES = Object.freeze(["product_content", "collection_content"]);
const SYSTEM = (type) => {
  const t = documentType(type);
  return !t || t.system === true || t.editable === false || ENTITY_TYPES.includes(type);
};
const ORDER = ["home", "header", "announcement", "footer", "design", "collections_index", "product_layout", "collection_layout", "cart"];
const rank = (type) => {
  const i = ORDER.indexOf(type);
  return i < 0 ? ORDER.length : i;
};

// The switcher's list: every document by label (search by name or address).
// P4-EDITOR: products are listProductContent's rows (productRows), each one
// opening its own content.
export function switcherRows({ documents = [], products = [], query = "", openId = null, openEntityId = null } = {}) {
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
  // P4-EDITOR: products come from listProductContent (searched there), so
  // they are not filtered here; see productRows
  return { documents: docs, products: productRows(products, { openEntityId }) };
}

// ---- the switcher's Products and Collections (P4-EDITOR) ------------------------------

export const PRODUCT_FILTERS = Object.freeze([
  { key: "all", label: "All products", count: "all" },
  { key: "changed_in_shopify", label: "Changed in Shopify", count: "changedInShopify" },
  { key: "orphaned", label: "No longer in Shopify", count: "orphaned" },
]);
export const LIST_PAGE = 30;

// The listProductContent arguments for the switcher's search box and filter.
export function productListArgs({ query = "", filter = "all", cursor = null, limit = LIST_PAGE } = {}) {
  const q = String(query ?? "").trim();
  const f = PRODUCT_FILTERS.some((x) => x.key === filter) ? filter : "all";
  return { ...(q ? { q: q.slice(0, 120) } : {}), ...(f !== "all" ? { filter: f } : {}), ...(cursor ? { cursor } : {}), limit };
}

// Where a product or a collection row opens (plan section 4).
export const entityHref = ({ product = null, collection = null } = {}) =>
  product ? `/admin/editor?product=${encodeURIComponent(product)}` : collection ? `/admin/editor?collection=${encodeURIComponent(collection)}` : "/admin/editor";

// listProductContent's items as switcher rows.
export function productRows(items, { openEntityId = null } = {}) {
  return (Array.isArray(items) ? items : [])
    .filter((p) => isObj(p) && typeof p.productId === "string")
    .map((p) => ({
      kind: "product",
      id: p.productId,
      label: String(p.title || "Untitled product"),
      secondary: typeof p.shopifyTitle === "string" && p.shopifyTitle && p.shopifyTitle !== p.title ? `Shopify title: ${p.shopifyTitle}` : null,
      state: p.inShopify === false ? PRODUCT_WORDS.orphan : p.changedInShopify ? "Changed in Shopify" : p.live ? (p.edited ? "Your edits are live" : "Live") : p.edited ? "Edited, not published" : "Same as Shopify",
      href: entityHref({ product: p.productId }),
      open: openEntityId != null && p.productId === openEntityId,
    }));
}

// The refs read's collections as switcher rows.
export function collectionRows(items, { openEntityId = null } = {}) {
  return (Array.isArray(items) ? items : [])
    .filter((c) => isObj(c) && typeof c.id === "string" && !c.missing)
    .map((c) => ({ kind: "collection", id: c.id, label: String(c.title || c.handle || "Untitled collection"), href: entityHref({ collection: c.id }), open: openEntityId != null && c.id === openEntityId }));
}

// The shell's counts line: "Products 412 · Changed in Shopify 3 · No longer in Shopify 1"
export function productCounts(counts) {
  const c = isObj(counts) ? counts : {};
  return PRODUCT_FILTERS.map((f) => ({ key: f.key, label: f.key === "all" ? "Products" : f.label, count: Number.isFinite(Number(c[f.count])) ? Number(c[f.count]) : 0 }));
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
// P6-OPEN-UI: checkOpening and confirmOpen from a publish request's extra
const openingFlags = (extra) => ({ checkOpening: isObj(extra) && extra.checkOpening === true, confirmOpen: isObj(extra) && extra.confirmOpen === true });
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
//   resolveShopifyChange, discardOrphanEdits (P4-EDITOR)
//                      flushed first, on the current revision; the answer's
//                      document replaces the store (onReplaced)

// Everything else goes to api.call as it is.
// A read-only store (support) sends only these document reads through call();
// every other op (archive, createDocument, startMissing, undoSet, …) is
// refused here with READ_ONLY, so nothing reaches the server
// (test-editor-ui pins STORE_CALL_READS ⊆ DOCUMENT_READS).
export const STORE_CALL_READS = Object.freeze(["getDocument", "listDocuments", "listHistory", "listChanges", "listProductContent", "openingChecks", "listRecentlyPublished"]);
const READ_ONLY_REFUSAL = Object.freeze({ ok: false, error: true, code: "READ_ONLY", message: "You can look at this page but not change it." });
// documentsApi for someone who may only read (support): call() sends only
// STORE_CALL_READS and answers READ_ONLY to anything else, without a request;
// the preview session (a storefront.read) is left as it is.
export function readOnlyApi(api) {
  return { ...api, call: (op, ...rest) => (STORE_CALL_READS.includes(op) ? api.call(op, ...rest) : Promise.resolve({ ...READ_ONLY_REFUSAL })) };
}
export function createStoreCall({ api, getStore, getPinned = () => null, onReplaced = () => {} }) {
  const refusal = { refused: true, code: "DRAFT_CHANGED", message: WORDS.changedSinceReview };
  async function flushed(store) {
    const f = await store.beforeNavigate();
    if (!f || !f.ok) return { error: true, code: f?.code || "NOT_SAVED", message: f?.message || WORDS.notSavedYet };
    return null;
  }
  return async function call(op, args, extra) {
    const store = getStore();
    if (store?.readOnly === true && !STORE_CALL_READS.includes(op)) return { ...READ_ONLY_REFUSAL };
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
        // P6-OPEN-UI: the opening modifiers travel as top-level keys
        return store.publish({ confirmRepublish: args.confirmRepublish === true, ...openingFlags(extra) });
      }
      case "publishSet": {
        const items = Array.isArray(args) ? args : [];
        const entry = items.find((it) => isObj(it) && it.id === openId);
        if (!entry) break;
        const e = await flushed(store);
        if (e) return e;
        const s = store.getState();
        if (s.unacknowledged || s.draftHash !== entry.draftHash) return refusal;
        return store.publishSet(items, openingFlags(extra));
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
      // P4-EDITOR (OVL-04): "Keep mine" / "Use Shopify's" on a Changed in
      // Shopify notice, and "Discard edits" on a product that left Shopify.
      // Saved first, then run on the current revision; the answer's document
      // replaces the store (text typed meanwhile is kept as an earlier draft
      // first, as undoSet does).
      case "resolveShopifyChange":
      case "discardOrphanEdits": {
        if (!mine) break;
        const e = await flushed(store);
        if (e) return e;
        const s = store.getState();
        const r = await api.call(op, op === "resolveShopifyChange" ? { id: openId, field: args.field, choice: args.choice } : { id: openId }, { revision: s.revision });
        if (r && r.ok && store.getState().unacknowledged) {
          const k = await store.keepAsEarlierDraft(store.getState().body);
          if (!k || !k.ok) return r;
        }
        const doc = r && r.ok && isObj(r.data?.document) ? r.data.document : null;
        if (doc && isObj(doc.body)) onReplaced(doc);
        return r;
      }
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

// P4-EDITOR (P3-FIX5 review): why the frame doesn't show the design draft's
// colours. The frame's ready lists doc_design in `skipped` both when the
// session's showDesign is off (the colours are hidden) and when the design
// draft can't be read. The frame's state can't tell them apart, but the
// controller knows whether the session it steers has showDesign on.
//   "hidden"      the session's colours are off (or not known to be on)
//   "unreadable"  showDesign is on in that session, and the draft still isn't
//                 shown: it couldn't be read
//   null          the frame shows them
export const DESIGN_WORDS = Object.freeze({
  hidden: PREVIEW_WORDS.designHidden,
  unreadable: "Your new colours couldn't be read, so the preview shows your live colours. Try again. If it keeps happening, go back to an earlier version of your design in Earlier versions.",
});
export function designProblem(frameState, { sessionShowsDesign = null } = {}) {
  if (!designHiddenIn(frameState)) return null;
  return sessionShowsDesign === true ? "unreadable" : "hidden";
}

// Drives one preview frame across documents.
//   api      { startDocumentsPreview({showDesign}), setShowDesign(sid, on) }
//   frame    { setSrc(path), post(msg), currentPath(), designOpen?(open) }
//            designOpen(open) (P4-EDITOR): hide the frame bar's "Hide them"
//            while the design is open (applyDesignToggle)
//   pathFor(documentId)   the address the frame shows
//   onChange(view)        view: { label, words, field, note, phase, reconnecting, shownAck }
//   onPick(pick)
//   hello    what the controller answers a v1 ready with (default the
//            editor's {type:"storeasy:editor:hello", v:2}; onboarding's brand
//            step adds look:true, Phase 1 line 6)
// showDesign is on while doc_design is open and off otherwise. The session is
// minted again when the bridge reports ok:false (the session ended, or the
// frame shows the live store) or when no ready arrives within 3 seconds of a
// frame load; "Reconnecting…" shows meanwhile. Nothing re-mints before the
// session's expiry (PV-04 is P1).
//
// P3-FIX5 (finding D1):
//   · The session that counts is the one the frame renders. The browser has
//     one _preview cookie, so a second editor tab (or a second mint) can
//     leave the frame on another session than the one this controller made.
//     Every ready ok names that session (state.sid); the controller adopts
//     it, so showDesign goes where the frame is.
//   · While the design is open, a ready whose state says the design draft is
//     not shown (doc_design in skipped) is never "Up to date": the machine
//     answers fixDesign, the controller turns showDesign on in the frame's
//     session and reloads the frame (a failed turn-on mints a new session).
//   · start() is idempotent per controller: start, dispose, start (React
//     strict mode's double effect in next dev, with PreviewPane keeping one
//     controller per mount) mints one session. A dispose parks whatever
//     answer arrives meanwhile; the next start() applies it; a controller
//     never started again (a real unmount) drops it.
export const EDITOR_HELLO = Object.freeze({ type: "storeasy:editor:hello", v: 2 });
export function createPreviewController({ api, frame, pathFor = () => "/", documentId = null, timers = defaultTimers(), onChange = () => {}, onPick = () => {}, hello = EDITOR_HELLO }) {
  let docId = documentId;
  let machine = createPreviewMachine({ documentId: docId, showDesign: showDesignFor(docId) });
  let last = machine.current;
  let sid = null;
  let started = false;
  let parked = null; // an answer that arrived while disposed
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
  function act(a0) {
    if (disposed) return;
    // P4-EDITOR: a design draft that can't be read gets its own words, not
    // "isn't showing your new colours" (showDesign is already on)
    const a = a0.state.phase === "failed" && a0.words === PREVIEW_WORDS.designHidden && shown === true ? { ...a0, words: DESIGN_WORDS.unreadable } : a0;
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
  // run fn now, or (while disposed) keep it for the next start()
  const whenLive = (fn) => {
    if (disposed) parked = fn;
    else fn();
  };
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
    if (mine !== token) return;
    whenLive(() => minted(r, want));
  }
  function minted(r, want) {
    if (r && r.ok) {
      log.push("minted");
      sid = r.sid;
      shown = want;
      act(machine.send({ type: "mintOk" }));
    } else act(machine.send({ type: "mintFailed", message: r?.message }));
  }
  // P3-FIX5: turn the colours on in the session the frame renders (sid: the
  // ready that asked for this already adopted the frame's session)
  async function fixDesign() {
    const mine = ++token;
    const target = sid;
    log.push("fixDesign");
    let r;
    try {
      r = target ? await api.setShowDesign(target, true) : null;
    } catch {
      r = { error: true };
    }
    if (mine !== token) return;
    whenLive(() => {
      if (!r || !r.ok) return mint(); // a new session of our own, with the colours on
      sid = target;
      shown = true;
      act(machine.send({ type: "mintOk" }));
    });
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
    machine = createPreviewMachine({ documentId: docId, showDesign: showDesignFor(docId) });
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
      if (mine !== token) return;
      return whenLive(() => {
        if (!r || !r.ok) return mint(); // a new session with the right setting
        shown = want;
        act(machine.send({ type: "mintOk" }));
      });
    }
    act(machine.send({ type: "mintOk" }));
  }

  return {
    // idempotent: mints once per controller; after a dispose it comes back
    // to life and applies what arrived meanwhile
    start() {
      disposed = false;
      if (started) {
        const fn = parked;
        parked = null;
        if (fn) fn();
        else onChange(view());
        return Promise.resolve();
      }
      started = true;
      return mint();
    },
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
          frame.post({ ...hello });
          return;
        }
        bridge = true;
        clearTimer();
        log.push(`ready:${data.ok === true ? "ok" : data.reason || "live"}`);
        // P4-EDITOR (P3-FIX5 review): while the design is open the bar inside
        // the frame doesn't offer "Hide them" (fixDesign would turn the
        // colours straight back on); on any other document it does
        try {
          frame.designOpen?.(showDesignFor(docId));
        } catch {
          /* the frame is navigating */
        }
        // P3-FIX5: the frame's own session (the cookie's) is the one to steer
        const frameSid = data.ok === true && isObj(data.state) && typeof data.state.sid === "string" && /^ps_[0-9a-f]{16}$/.test(data.state.sid) ? data.state.sid : null;
        if (frameSid && frameSid !== sid) {
          log.push("adopt");
          sid = frameSid;
          shown = null; // not known until the frame says so, or it is set
        }
        const a = machine.send({ type: "ready", ok: data.ok === true, state: data.state, reason: data.reason });
        act(a);
        if (a.fixDesign) fixDesign();
        // an adopted session showing the design (nothing hidden) counts as on
        else if (a.state.phase === "shown" && shown == null && showDesignFor(docId) && !designHiddenIn(data.state)) shown = true;
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

// ---- a product's content (P4-EDITOR: OVL-04, OVL-01, OVL-06) ---------------------------
//
// The stored shape (P4-LIVEROW (3b), enforced by lib/documents/service.js):
// each overlay field is null (follow Shopify) or { value, base_hash,
// base_value } (the founder's own value, and what Shopify sent when it was
// first changed). The rules here mirror the service, so the form never sends
// what the service would turn back:
//   Reset and "Use Shopify's"  the field becomes null (follow Shopify again)
//   a value equal to Shopify's null too (image addresses without their query
//                              string); a description equal once both are
//                              cleaned is made null by the service
//   "Keep mine"                resolveShopifyChange 'keep' (the service
//                              re-bases it; the base is never sent from here)
// A description the founder did not touch is always sent as null: while it
// follows Shopify the box shows Shopify's text and the field never changes it
// on its own (RichTextField), so only a real edit sends a value; one that
// only cleans Shopify's markup is stored null by the service.

export const PRODUCT_WORDS = Object.freeze({
  shopifyOwns: "Price, variants and stock come from Shopify. Change them in Shopify; your store shows the new values after the next catalog update.",
  // the Catalog page's line, same words
  catalogShopify: "Type, vendor, price and stock come from Shopify. Change them in Shopify; your store shows the new values after the next catalog update.",
  changeInShopify: "Change in Shopify",
  noAdminLink: "Your store's Shopify address isn't set, so there is no link to Shopify here.",
  differs: "Differs from Shopify",
  same: "Same as Shopify",
  reset: "Reset to Shopify",
  shopifyTitle: (t) => `Shopify title: ${t == null || t === "" ? "(none)" : t}`,
  shopifySays: (label, v) => `Shopify's ${label}: ${v == null || v === "" ? "(none)" : v}`,
  lastKnown: (label, v) => `Shopify's ${label} when it left: ${v == null || v === "" ? "(none)" : v}`,
  changed: (label, v) => `Shopify changed the ${label} after you edited it. Shopify's ${label} is now: ${v == null || v === "" ? "(none)" : v}.`,
  keepMine: "Keep mine",
  useShopify: "Use Shopify's",
  galleryFirstEdit: "Your images replace Shopify's for this product. New images added in Shopify won't show until you choose Use Shopify's images.",
  galleryChanged: "Shopify's images changed",
  galleryChangedWords: "Shopify's images for this product changed after you made your own list. Shoppers still see your list.",
  useShopifyImages: "Use Shopify's images",
  orphan: "No longer in Shopify",
  orphanWords: "This product isn't in your Shopify catalog any more, so shoppers can't see it. Your edits are kept here until you discard them.",
  orphanReset: "Reset isn't available: there is no Shopify version to go back to.",
  discard: "Discard edits",
  discardConfirm: "Discard every edit of this product? Shoppers can't see it either way. The edits are kept in Earlier versions.",
  discardStaff: "Only an owner or admin can discard these edits.",
  readOnly: "You can look at this, but your role can't change it. Ask the store owner or an admin.",
  untouched: "Nothing has been changed on this product yet. It shows what Shopify sends.",
  galleryCap: (n, max) => `You have ${n} images; a product can show at most ${max} of your own. Remove ${n - max} before you publish, or choose Use Shopify's images.`,
  descriptionCap: (n, max) => `The description is ${n.toLocaleString("en-US")} characters long; at most ${max.toLocaleString("en-US")} can go live. Shorten it before you publish, or choose Reset to Shopify.`,
  descriptionCount: (n, max) => `${n.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} characters`,
  modulesTitle: "Modules on this product's page",
  addModule: "Add a module",
  noModules: "No modules yet.",
  gated: (reason) => reason || "A new name can't be saved right now.",
  variants: "Variants",
  price: "Price",
  stock: "Stock",
  inStock: "In stock",
  soldOut: "Sold out",
});

// Each overlay field: its key, its words and where Shopify's value is in
// openEntityContent's `shopify` answer.
export const PRODUCT_OVERLAYS = Object.freeze([
  Object.freeze({ key: "title", label: "name", shopifyKey: "title", gated: true }),
  Object.freeze({ key: "description_html", label: "description", shopifyKey: "description_html", gated: false }),
  Object.freeze({ key: "gallery", label: "images", shopifyKey: "gallery", gated: false }),
  Object.freeze({ key: "display_vendor", label: "brand", shopifyKey: "vendor", gated: true }),
  Object.freeze({ key: "display_type", label: "product type", shopifyKey: "product_type", gated: true }),
]);
const overlayOf = (key) => PRODUCT_OVERLAYS.find((o) => o.key === key) || null;

const stripQuery = (u) => (typeof u === "string" ? u.replace(/[?#].*$/, "") : u);
function comparableOverlay(field, value) {
  if (field === "gallery") return Array.isArray(value) ? value.map((g) => (isObj(g) ? { media: stripQuery(g.media), alt: g.alt == null ? "" : g.alt } : g)) : value;
  return value;
}
const sameRaw = (field, a, b) => stableStringify({ v: comparableOverlay(field, a) ?? null }) === stableStringify({ v: comparableOverlay(field, b) ?? null });

// Is `value` what Shopify sends now? Compared as sent (image addresses without
// their query string). The client never cleans HTML (the server is the only
// sanitizer, P3-RTE): a description an editor sends back cleaned is turned
// into null by the service (normalizeOverlays compares both cleaned).
export function sameAsShopify(field, value, shopifyValue) {
  return sameRaw(field, value, shopifyValue);
}

export function shopifyValueOf(field, shopify) {
  const o = overlayOf(field);
  if (!o || !isObj(shopify)) return null;
  const v = shopify[o.shopifyKey];
  return v === undefined ? null : v;
}

const overlayValue = (v) => (isObj(v) && v.value !== undefined ? v.value : null);

// One overlay field's state for the form.
//   following         null in the draft: shoppers see Shopify's value
//   value             what shoppers see once published (Shopify's while following)
//   shopifyValue      what Shopify sends now (null when the product is gone)
//   baseValue         what Shopify sent when the founder first changed it
//   differs           the founder's value is not Shopify's ("Differs from Shopify")
//   changedInShopify  the founder changed it AND Shopify changed it since
//   canReset          there is something to reset, and Shopify is there
export function overlayState(field, setting, { shopify = null, inShopify = true } = {}) {
  const following = setting == null || overlayValue(setting) == null;
  const shopifyValue = inShopify ? shopifyValueOf(field, shopify) : null;
  const own = following ? null : overlayValue(setting);
  const baseValue = isObj(setting) && setting.base_value !== undefined ? setting.base_value : null;
  const hasBase = isObj(setting) && typeof setting.base_hash === "string";
  return {
    field,
    following,
    value: following ? shopifyValue : own,
    shopifyValue,
    baseValue,
    differs: !following && !(inShopify && sameAsShopify(field, own, shopifyValue)),
    changedInShopify: !following && inShopify && hasBase && !sameRaw(field, baseValue, shopifyValue),
    canReset: !following && inShopify,
  };
}

// The stored value after the founder edits a field to `next`: null when it
// is (again) what Shopify sends, else the founder's value with the rest of
// the overlay kept (the service keeps the first base).
export function editOverlay(field, current, next, { shopify = null, inShopify = true } = {}) {
  if (next == null) return null;
  if (inShopify && sameAsShopify(field, next, shopifyValueOf(field, shopify))) return null;
  const rest = isObj(current) ? current : {};
  return { ...rest, value: next };
}

// The "Changed in Shopify" notices: one per EDITED field whose Shopify value
// moved since it was edited. Never for a field that follows Shopify, never
// for a product that is gone.
export function shopifyChanges(body, { shopify = null, inShopify = true } = {}) {
  const settings = isObj(body) && isObj(body.settings) ? body.settings : {};
  if (!inShopify) return [];
  return PRODUCT_OVERLAYS.map((o) => ({ o, st: overlayState(o.key, settings[o.key], { shopify, inShopify }) }))
    .filter(({ st }) => st.changedInShopify)
    .map(({ o, st }) =>
      o.key === "gallery"
        ? { field: o.key, title: PRODUCT_WORDS.galleryChanged, words: PRODUCT_WORDS.galleryChangedWords, keep: PRODUCT_WORDS.keepMine, useShopify: PRODUCT_WORDS.useShopifyImages }
        : { field: o.key, title: `Shopify changed the ${o.label}`, words: PRODUCT_WORDS.changed(o.label, st.shopifyValue), keep: PRODUCT_WORDS.keepMine, useShopify: PRODUCT_WORDS.useShopify },
    );
}

// Plain-words caps before publish fails: the gallery (30 of the founder's own
// images) and the description (20,000 characters), from the registry.
export function capNotes(body) {
  const t = documentType("product_content");
  const settings = isObj(body) && isObj(body.settings) ? body.settings : {};
  const decl = (k) => t?.settings.find((s) => s.key === k) || {};
  const out = {};
  const g = overlayValue(settings.gallery);
  const gmax = decl("gallery").max;
  if (Array.isArray(g) && gmax != null && g.length > gmax) out.gallery = PRODUCT_WORDS.galleryCap(g.length, gmax);
  const d = overlayValue(settings.description_html);
  const dmax = decl("description_html").max;
  if (typeof d === "string" && dmax != null && d.length > dmax) out.description_html = PRODUCT_WORDS.descriptionCap(d.length, dmax);
  return out;
}

// The module kinds a founder can add to this document type (offeredKinds:
// rich text, text and FAQ on a product; image-with-text stays editable on
// products that have one, but is never offered).
const PRODUCT_MODULE_KINDS = ["rich_text", "text", "faq"];
export function moduleOptions(type) {
  const all = allowedKinds(type);
  return type === "product_content" ? all.filter((k) => PRODUCT_MODULE_KINDS.includes(k)) : all;
}

// Everything the product form shows, from the draft and the entity answer.
//   access   { canPublish, reason } (getDocument's)
//   readOnly plain words when this person can't change anything
export function productFormModel({ body = null, entity = null, access = null, readOnly = null } = {}) {
  const e = isObj(entity) ? entity : {};
  const inShopify = e.inShopify !== false;
  const shopify = isObj(e.shopify) ? e.shopify : null;
  const settings = isObj(body) && isObj(body.settings) ? body.settings : {};
  const gateClosed = e.titleEditable === false;
  const fields = PRODUCT_OVERLAYS.map((o) => {
    const st = overlayState(o.key, settings[o.key], { shopify, inShopify });
    const disabled = Boolean(readOnly) || (o.gated && gateClosed);
    return {
      ...st,
      key: o.key,
      label: o.label,
      disabled,
      disabledReason: readOnly || (o.gated && gateClosed ? PRODUCT_WORDS.gated(e.titleBlockedReason) : null),
      // Reset clears a field, so it stays available while the name is gated
      resetDisabled: Boolean(readOnly) || !st.canReset,
      resetReason: !inShopify ? PRODUCT_WORDS.orphanReset : null,
      shopifyLine: !inShopify ? (st.following ? null : PRODUCT_WORDS.lastKnown(o.label, o.key === "gallery" ? null : st.baseValue)) : o.key === "title" ? PRODUCT_WORDS.shopifyTitle(st.shopifyValue) : o.key === "gallery" || o.key === "description_html" ? null : PRODUCT_WORDS.shopifySays(o.label, st.shopifyValue),
    };
  });
  const title = fields.find((f) => f.key === "title");
  const canPublish = isObj(access) ? access.canPublish !== false : true;
  return {
    inShopify,
    orphan: !inShopify,
    readOnly: readOnly || null,
    gateClosed,
    gateReason: gateClosed ? PRODUCT_WORDS.gated(e.titleBlockedReason) : null,
    // OVL-06: the editor always shows Shopify's name beside the override
    heading: title.following ? title.shopifyValue : title.value,
    shopifyTitleLine: inShopify ? PRODUCT_WORDS.shopifyTitle(title.shopifyValue) : PRODUCT_WORDS.lastKnown("name", title.baseValue),
    fields,
    notices: inShopify ? shopifyChanges(body, { shopify, inShopify }) : [],
    galleryNote: fields.find((f) => f.key === "gallery").following ? null : PRODUCT_WORDS.galleryFirstEdit,
    caps: capNotes(body),
    adminUrl: typeof e.shopifyAdminUrl === "string" ? e.shopifyAdminUrl : null,
    commerce: isObj(e.commerce) ? e.commerce : null,
    discard: !inShopify ? (canPublish && !readOnly ? { offered: true, reason: null } : { offered: false, reason: PRODUCT_WORDS.discardStaff }) : null,
    modules: moduleOptions("product_content"),
  };
}

// ---- the preview bar's "Hide them" (P3-FIX5 review) ------------------------------------
// While the design document is open its colours are always shown (fixDesign
// turns them straight back on), so the bar inside the frame must not offer
// "Hide them". The frame is this store's own page (same origin): the editor
// marks its document, and a style rule hides the bar's design toggle. Called
// after every frame load (a ready), so a reload never brings it back.
export const DESIGN_TOGGLE_STYLE_ID = "storeasy-editor-design-open";
export const DESIGN_TOGGLE_CSS = '[data-preview-note="design"] button{display:none!important}';
export function applyDesignToggle(doc, open) {
  if (!doc || typeof doc.getElementById !== "function") return false;
  const had = doc.getElementById(DESIGN_TOGGLE_STYLE_ID);
  if (!open) {
    if (had) had.remove();
    return false;
  }
  if (had) return true;
  const el = doc.createElement("style");
  el.id = DESIGN_TOGGLE_STYLE_ID;
  el.textContent = DESIGN_TOGGLE_CSS;
  (doc.head || doc.documentElement)?.appendChild(el);
  return true;
}
