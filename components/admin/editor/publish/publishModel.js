// P3-PUBLISHUI (PUB-02, PUB-03, PUB-04, PUB-05, PUB-09): the logic of the
// publish panel, Undo, take offline, Earlier versions and Recently published.
// Plain JS, no React and no DOM: the components in this folder only render
// what these functions return, so node tests drive every interaction here
// (phase 3 plan B5).
//
// It reads documentsApi results (components/admin/editor/documentsApi.js:
// { ok, data } | { conflict } | { refused } | { issues } | { needsRevision }
// | { notBuilt } | { error }) in the shapes of lib/admin/documents-api-shapes.js.
// The functions that talk to the server take the client as an injected
// `call(op, args, extra)` (documentsApi.call, or the editor store's wrapper of
// it, so autosave is flushed and held around a server rewrite: plan A5).
//
// What the founder sees is always plain words: the server's `message` (which
// documentsApi guarantees is plain), labels, and the words below. A code, a
// hash or an id is never put in the text; ids stay in the state for the next
// request only.
//
//   applyAction(body, action)        the edited body for hideSection,
//                                    removeSection or removeItem
//   stepsFor(action, ctx)            an issue action as client steps:
//     hideSection | removeSection | removeItem
//                                    [saveDraft of the edited body, then the
//                                    same publish again with the saved
//                                    revision and draft hash]
//     publishBoth                    [review every offered document, then
//                                    publishSet with exactly the offer]
//     openField                      [focus the field] (nothing is sent)
//   outcomeOf(result, ctx)           a publish or publishSet result as panel state
//   createPublishFlow(deps)          the panel's controller (review, publish,
//                                    actions, offers, republish confirm,
//                                    unknown publish check)
//   createUndoFlow(deps)             Undo, whole-set Undo and take offline:
//                                    a dry run first, then the confirm
//   historyRowsOf(versions)          Earlier versions rows
//   recentGroupsOf(rows)             Recently published rows, grouped by set
import { documentType, fieldAnchor } from "../../../../lib/registry/index.js"; // relative, so plain node loads it

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const q = (s) => `“${s}”`;
const listWords = (labels) => {
  const l = labels.map(q);
  if (l.length <= 1) return l.join("");
  return `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
};

// ---- words -----------------------------------------------------------------------------

export const WORDS = Object.freeze({
  publish: "Publish",
  publishing: "Publishing…",
  reviewTitle: "What will go live",
  loadingChanges: "Finding what changed…",
  nothingChanged: "Nothing has changed since the last publish, so there is nothing to publish.",
  firstPublish: "This goes live for the first time, with:",
  firstPublishEmpty: "This goes live for the first time.",
  keepLive: "Keep the live version",
  keepLiveDone: "Done: that section is back to how it is on your live store. It stays out of this publish.",
  changesFailed: "We couldn't load what will change, so you can't publish yet. Try again.",
  tryAgain: "Try again",
  cancel: "Cancel",
  close: "Close",
  offerTitle: "Publish these together",
  offerLinks: "Shoppers would reach a page that isn't live. Publish them together, so every link works:",
  offerHome: "Your store opens with its home page, so it goes live with this:",
  offerWaiting: "You can publish once every list below has loaded.",
  offerOtherBlocks: "The other things marked “Must fix” still stop the publish until they are fixed.",
  noHomeTitle: "Make your home page first",
  noHomeAction: "Make your home page",
  republishTitle: "Publish it again?",
  republishAction: "Publish it again",
  checking: "We couldn't confirm the publish. Checking…",
  checkedLive: "It went live. You can undo it from Recently published.",
  checkedNotLive: "Your publish didn't go live. Nothing of it is on your store. Try again.",
  checkedUnknown: "We still couldn't confirm it. Reload the page to see what is live.",
  published: "Published.",
  seeLive: "See it live",
  alreadyLive: "Already live, nothing new to publish:",
  rodeAlong: "A few things to check:",
  blockedTitle: "Not published yet",
  fixIt: "Go to this field",
  staffReason: "Only the store owner or an admin can publish. You can edit and preview.",
  lastSavedBy: (name) => `Last saved by ${name}.`,
  reviewCurrent: "See the current version",
  undo: "Undo",
  undoAll: (n) => `Undo all ${n}`,
  undoTitle: "Undo this publish?",
  undoSetTitle: (n) => `Undo all ${n} pages of this publish?`,
  undoWillChange: "This changes on your live store:",
  undoNoChanges: "Nothing on your live store changes.",
  undoGoesBackTo: (name) => `It goes back to: ${name}.`,
  undoConfirm: "Undo",
  undoLoading: "Checking what Undo changes…",
  undoNothing: "There's nothing earlier to undo.",
  firstVersion: "This is the first published version. Edit it, or go back to your starting design.",
  earlierVersionsLink: "Open Earlier versions",
  liveNow: (labels) => `Live now: ${listWords(labels)}.`,
  offlineNow: (labels) => `Offline now: ${listWords(labels)}. To bring ${labels.length === 1 ? "it" : "them"} back, open ${labels.length === 1 ? "it" : "each one"} in the editor and publish again.`,
  keptInEarlier: "Newer changes are kept in Earlier versions.",
  offlineTitle: (label) => `Take ${q(label)} offline?`,
  offlineWhat: "Shoppers can't open it any more. Your draft keeps its text, so you can publish it again later.",
  offlineLinkers: "These live pages link to it, so their links will stop working:",
  offlineNoLinkers: "No live page links to it.",
  offlineConfirm: "Take it offline",
  undoOfflineTitle: (label) => `Undo takes ${q(label)} offline`,
  restore: "Restore to draft",
  restoreNote: "Restoring puts this version in your draft. It doesn't go live until you publish.",
  historyEmpty: "No earlier versions yet. Each publish and each pause in your editing keeps one.",
  recentEmpty: "Nothing has been published yet.",
  openInEditor: "Open in the editor",
  // P3-FIX3
  staffUndoReason: "Only the store owner or an admin can undo a publish. You can edit and preview.",
  keepsRunning: "This keeps running if you close the panel: the change is saved and published.",
  undoChecking: "We couldn't confirm the Undo. Checking…",
  undoCheckedDone: "It looks like the Undo went through: what is live changed since you asked. Reload the page to see what is live now.",
  undoCheckedNot: "Your Undo didn't go through. Nothing changed on your store. Try again.",
  undoCheckedUnknown: "We still couldn't confirm the Undo. Reload the page to see what is live.",
  undoSetOfflineTitle: (n, labels) => `Undo all ${n} pages of this publish? ${listWords(labels)} ${labels.length === 1 ? "goes" : "go"} offline.`,
});

// P3-FIX3: Undo needs the same right as Publish (storefront.publish). access
// is getDocument's { canPublish, reason }, or { canUndo, reason }.
export const undoDenied = (access) => Boolean(access && (access.canUndo === false || access.canPublish === false));
export const undoDeniedReason = (access) => (undoDenied(access) ? (typeof access.reason === "string" && access.reason) || WORDS.staffUndoReason : null);

export const LEVEL_WORDS = Object.freeze({ blocks: "Must fix", warns: "Check", inherited: "Already live like this" });

// The words of an issue action's button. publishBoth names how many go together.
export function actionLabel(action, { offerSize = 2 } = {}) {
  switch (action?.type) {
    case "hideSection":
      return "Hide this section and publish";
    case "removeSection":
      return "Remove this section and publish";
    case "removeItem":
      return "Remove it and publish";
    case "publishBoth":
      return offerSize > 2 ? `Publish all ${offerSize} together` : "Publish both";
    case "openField":
      return WORDS.fixIt;
    default:
      return WORDS.fixIt;
  }
}
export const ACTION_TYPES = Object.freeze(["hideSection", "removeSection", "removeItem", "publishBoth", "openField"]);

const KIND_WORDS = { published: "Published", checkpoint: "Saved while you edited", undo_saved: "Kept for you", migrated: "Moved to the new editor" };

// "2 Nov, 10:00". timeZone is for tests and for a store's own zone.
export function when(iso, { timeZone } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

// A singleton (home, header, design, …) has no "take offline": its first
// publish has nothing to undo to (spec PUB-04).
export const isRouteType = (type) => documentType(type)?.route === true;
// P3-FIX3: a singleton's id is doc_<type> (validate.js), so its type is known
// even when it came in through an offer that carried no type.
export function typeOfId(id, types) {
  if (isObj(types) && typeof types[id] === "string") return types[id];
  const t = typeof id === "string" && id.startsWith("doc_") ? documentType(id.slice(4)) : null;
  return t?.singleton ? t.type : null;
}

// ---- issue actions: edit the body ------------------------------------------------------

// The object a field path is read from: section fields live in settings
// unless the path starts with one of the section's own keys (lib/registry/
// validate.js walks settings with no prefix); document fields live in the
// body's settings unless the path starts with meta (or another body key).
const OWN_SECTION_KEYS = new Set(["mobile", "show", "bindings", "blocks"]);
const OWN_BODY_KEYS = new Set(["meta"]);
function containerFor(holder, parts, ownKeys) {
  if (ownKeys.has(parts[0]) && !(isObj(holder.settings) && parts[0] in holder.settings)) return holder;
  return isObj(holder.settings) ? holder.settings : null;
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const GONE = "That is no longer in your draft, so nothing was changed. Reload to see the latest.";

// { ok: true, body } with a copy of body edited, or { ok: false, message }.
export function applyAction(body, action) {
  if (!isObj(body) || !Array.isArray(body.sections) || !isObj(action)) return { ok: false, message: GONE };
  const next = clone(body);
  const idx = action.sectionId ? next.sections.findIndex((s) => isObj(s) && s.id === action.sectionId) : -1;
  if (action.type === "hideSection" || action.type === "removeSection") {
    if (idx < 0) return { ok: false, message: GONE };
    if (action.type === "hideSection") next.sections[idx] = { ...next.sections[idx], enabled: false };
    else next.sections.splice(idx, 1);
    return { ok: true, body: next };
  }
  if (action.type === "removeItem") {
    if (typeof action.field !== "string" || !action.field || !Number.isInteger(action.index) || action.index < 0) return { ok: false, message: GONE };
    let holder = next;
    let own = OWN_BODY_KEYS;
    if (action.sectionId) {
      if (idx < 0) return { ok: false, message: GONE };
      holder = next.sections[idx];
      own = OWN_SECTION_KEYS;
    }
    const parts = action.field.split(".");
    let cur = containerFor(holder, parts, own);
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return { ok: false, message: GONE };
      cur = cur[p];
    }
    if (!Array.isArray(cur) || action.index >= cur.length) return { ok: false, message: GONE };
    cur.splice(action.index, 1);
    return { ok: true, body: next };
  }
  return { ok: false, message: GONE };
}

// The request that publishes `items`: one document is `publish` (with its
// revision at the top level), more are `publishSet`. confirmRepublish only
// on the items the founder confirmed.
export function publishRequest(items, { set = false } = {}) {
  const list = (items || []).map((it) => ({ id: it.id, revision: it.revision, draftHash: it.draftHash, ...(it.confirmRepublish === true ? { confirmRepublish: true } : {}) }));
  if (list.length === 1 && !set) {
    const [it] = list;
    return { op: "publish", args: { id: it.id, draftHash: it.draftHash, ...(it.confirmRepublish ? { confirmRepublish: true } : {}) }, extra: { revision: it.revision } };
  }
  return { op: "publishSet", args: list };
}

// The offer as it is sent back: each document with the revision and draft
// hash the server saw, nothing added (no confirmRepublish: an offline
// target is confirmed by the founder, one question at a time).
export const offerItems = (offer) => (isObj(offer) && Array.isArray(offer.publishSet) ? offer.publishSet.map((it) => ({ id: it.id, revision: it.revision, draftHash: it.draftHash, label: it.label })) : []);

// An issue action as client steps.
//   ctx.items   the documents of the publish that was refused ({id, revision,
//               draftHash, label}); the fix publishes the same ones again
//   ctx.bodies  { [id]: body } the current draft bodies, when known
//   ctx.offer   the offer of the refusal (for publishBoth)
//   ctx.issue   the issue the action belongs to (for openField's anchor)
// Steps:
//   { kind: "getDocument", id }                     read the draft when its body isn't known
//   { kind: "saveDraft", id, edit: action }         the edited body, saved with its revision
//   { kind: "publish", items, after: "saved" }      publish again, the saved document's
//                                                   revision and draft hash in place
//   { kind: "review", items }                       load listChanges for every document
//   { kind: "publish", items }                      (publishBoth: exactly the offer)
//   { kind: "focus", anchor, documentId, sectionId, field }
export function stepsFor(action, ctx = {}) {
  const items = ctx.items || [];
  switch (action?.type) {
    case "hideSection":
    case "removeSection":
    case "removeItem": {
      const steps = [];
      if (!isObj(ctx.bodies) || !isObj(ctx.bodies[action.documentId])) steps.push({ kind: "getDocument", id: action.documentId });
      steps.push({ kind: "saveDraft", id: action.documentId, edit: action });
      const again = items.some((it) => it.id === action.documentId) ? items : [...items, { id: action.documentId }];
      steps.push({ kind: "publish", items: again, after: "saved" });
      return steps;
    }
    case "publishBoth": {
      const offered = offerItems(ctx.offer);
      if (!offered.length) return [];
      return [
        { kind: "review", items: offered },
        { kind: "publish", items: offered },
      ];
    }
    case "openField": {
      const issue = ctx.issue || {};
      const sectionId = action.sectionId ?? null;
      const field = action.field ?? null;
      const anchor = issue.anchor || fieldAnchor({ sectionId, field });
      return [{ kind: "focus", anchor, documentId: action.documentId, sectionId, field }];
    }
    default:
      return [];
  }
}

// ---- a publish result as panel state ---------------------------------------------------

const knownLabel = (ctx, id) => {
  for (const list of [ctx.items, ctx.offerItems, ctx.documents]) {
    const hit = (list || []).find((d) => d && d.id === id && d.label);
    if (hit) return hit.label;
  }
  if (isObj(ctx.labels) && ctx.labels[id]) return ctx.labels[id];
  return null;
};
const labelFrom = (ctx, id, fallback = "That page") => knownLabel(ctx, id) || fallback;
// a known name in quotes, else plain words ("this page")
const named = (ctx, id, fallback) => {
  const l = knownLabel(ctx, id);
  return l ? q(l) : fallback;
};

function slugTakenWords(result, ctx, { undo = false } = {}) {
  const slug = typeof result.slug === "string" ? result.slug : "";
  const other = isObj(result.other) ? result.other : null;
  const otherLabel = other ? other.label || other.title || "another page" : null;
  const docId = result.document || (ctx.items?.length === 1 ? ctx.items[0].id : null);
  const doc = docId ? named(ctx, docId, "this page") : "this page";
  const Doc = doc.charAt(0).toUpperCase() + doc.slice(1);
  const address = slug ? `/${slug}` : "that address";
  if (undo) {
    return {
      title: `${Doc} can't go back yet`,
      words: other ? `Its earlier address ${address} is used by ${q(otherLabel)} now.` : `Its earlier address ${address} is used by another page now.`,
      next: other ? `Give ${q(otherLabel)} another address, then Undo again.` : "Give that page another address, then Undo again.",
      otherId: other?.id ?? null,
      otherLabel,
    };
  }
  return {
    title: `${Doc} wasn't published`,
    words: other ? `${Doc} wants the address ${address}, but ${q(otherLabel)} already uses it on your live store.` : `${Doc} wants the address ${address}, but another live page already uses it.`,
    next: other ? `Change the address of ${doc}, then publish again. Or open ${q(otherLabel)} and give it another address first.` : `Change the address of ${doc}, then publish again.`,
    otherId: other?.id ?? null,
    otherLabel,
    fixDocumentId: docId,
    fixAnchor: fieldAnchor({ sectionId: null, field: "meta.slug" }),
  };
}

// result: a documentsApi result of publish or publishSet.
// ctx: { items, labels, firstPublish: { [id]: bool }, types: { [id]: type } }
export function outcomeOf(result, ctx = {}) {
  const r = isObj(result) ? result : { error: true, message: "Something went wrong on our side, so nothing was published. Try again." };
  const items = ctx.items || [];
  if (r.ok) {
    const d = r.data || {};
    const published = (Array.isArray(d.published) ? d.published : []).map((p) => {
      const type = typeOfId(p.id, ctx.types);
      const firstOfSingleton = ctx.firstPublish?.[p.id] === true && type && !isRouteType(type);
      return { id: p.id, label: labelFrom(ctx, p.id), liveUrl: typeof p.liveUrl === "string" ? p.liveUrl : null, undo: firstOfSingleton ? null : isObj(p.undo) ? p.undo : null, note: firstOfSingleton ? WORDS.firstVersion : null };
    });
    const skipped = (Array.isArray(d.skipped) ? d.skipped : []).map((id) => labelFrom(ctx, typeof id === "string" ? id : id?.id));
    const warnings = Array.isArray(d.issues) ? d.issues : [];
    const undoable = published.filter((p) => p.undo);
    const undoSet = published.length > 1 && undoable.length > 1 && d.setId ? { setId: d.setId, members: undoable.map((p) => ({ id: p.id, logId: p.undo.logId })), labels: undoable.map((p) => p.label), revisions: undoable.map((p) => p.undo.revision) } : null;
    const title = published.length > 1 ? `Published ${published.length} pages.` : published.length === 1 ? `Published ${q(published[0].label)}.` : "Nothing new to publish: it was all live already.";
    return { phase: "done", title, published, skipped, warnings, undoSet };
  }
  if (Array.isArray(r.issues) && !r.refused && !r.conflict && !r.error) {
    const documents = Array.isArray(r.documents) ? r.documents : [];
    if (r.code === "LINKS_TO_UNPUBLISHED" && isObj(r.offer)) {
      return { phase: "offer", reason: "links", message: r.message, issues: r.issues, offer: r.offer, documents, otherBlocks: false };
    }
    const blocks = r.issues.filter((i) => i.level === "blocks" || (!i.level && i.severity === "error"));
    const linkBlocks = blocks.filter((i) => (i.actions || []).some((a) => a.type === "publishBoth"));
    return { phase: "blocked", message: r.message, issues: r.issues, documents, offer: isObj(r.offer) ? r.offer : null, otherBlocks: blocks.length > linkBlocks.length };
  }
  if (r.refused) {
    if (r.code === "REPUBLISH_CONFIRM_NEEDED") {
      const id = typeof r.id === "string" ? r.id : items.length === 1 ? items[0].id : null;
      const label = labelFrom(ctx, id, "This page");
      return { phase: "republish", id, label, title: WORDS.republishTitle, words: `You took ${named(ctx, id, "this page")} offline. Publish the same content again?` };
    }
    if (r.code === "FIRST_PUBLISH_NEEDS_HOME") {
      if (isObj(r.offer)) return { phase: "offer", reason: "home", message: r.message, issues: [], offer: r.offer, documents: [], otherBlocks: false };
      return { phase: "noHome", title: WORDS.noHomeTitle, message: r.message };
    }
    if (r.code === "SLUG_TAKEN") return { phase: "refused", ...slugTakenWords(r, ctx), message: r.message };
    if (r.code === "NOT_PUBLISHABLE" || r.code === "PUBLISH_NOT_AVAILABLE") {
      const it = named(ctx, r.document, "this part of your store");
      const It = it.charAt(0).toUpperCase() + it.slice(1);
      const next = r.code === "NOT_PUBLISHABLE" ? `Publish without ${it}: it goes live with the pages that use it.` : `Leave ${it} out of this publish, and publish the rest.`;
      return { phase: "refused", title: r.code === "NOT_PUBLISHABLE" ? `${It} can't be published on its own` : `${It} can't be published yet`, words: r.message, next, otherId: null };
    }
    return { phase: "refused", title: WORDS.blockedTitle, words: r.message, next: null, otherId: null };
  }
  if (r.conflict) {
    const conflicts = (Array.isArray(r.conflicts) ? r.conflicts : []).map((c) => ({ id: c.id, label: labelFrom(ctx, c.id), words: c.error || r.message, by: c.current?.updatedByName || null }));
    const by = r.current?.updatedByName || null;
    return { phase: "conflict", title: WORDS.blockedTitle, words: r.message, by, conflicts: conflicts.length > 1 ? conflicts : [], current: r.current || null };
  }
  // P3-FIX3: a lost answer (NETWORK_ERROR) may have gone live too: it is
  // checked like PUBLISH_UNKNOWN, never shown as "nothing was saved"
  if (r.code === "PUBLISH_UNKNOWN" || r.code === "NETWORK_ERROR") {
    return { phase: "checking", words: WORDS.checking, release: isObj(r.release) ? r.release : null };
  }
  const retry = r.retryable === true || r.code === "PUBLISH_BUSY" || r.code === "PUBLISH_FAILED";
  return { phase: "error", title: WORDS.blockedTitle, words: r.message, retry };
}

// PUBLISH_UNKNOWN, resolved. `live`: the live release id now (from the
// releases screen's GET), or undefined when it couldn't be read. `documents`:
// each sent document read again ({ id, publishedHash }), or null.
// It went live when the named release is live, or when every sent document's
// live hash is the draft hash that was sent.
export function resolveUnknown({ release, live, documents, items }) {
  if (release?.id && typeof live === "string" && live === release.id) return { phase: "checked", live: true, words: WORDS.checkedLive };
  if (Array.isArray(documents) && documents.length === items.length && items.length) {
    const byId = new Map(documents.map((d) => [d?.id, d]));
    const all = items.every((it) => byId.get(it.id)?.publishedHash === it.draftHash);
    return all ? { phase: "checked", live: true, words: WORDS.checkedLive } : { phase: "checked", live: false, words: WORDS.checkedNotLive };
  }
  return { phase: "checked", live: null, words: WORDS.checkedUnknown };
}

// ---- change lists ----------------------------------------------------------------------

// One document's listChanges result as a list.
export function changeListOf(result, label) {
  if (result?.ok && isObj(result.data)) {
    const d = result.data;
    if (d.firstPublish) return { status: "loaded", label, firstPublish: true, sections: (d.sections || []).map((s) => s.words), rows: [] };
    // P3-FIX4: a design never published lists rows against the platform
    // default, yet its publish is still a first version (neverPublished)
    return { status: "loaded", label, firstPublish: false, ...(d.neverPublished === true ? { neverPublished: true } : {}), sections: [], rows: (d.rows || []).map((r) => ({ kind: r.kind, sectionId: r.sectionId ?? null, words: r.words, affects: (r.affects || []).map((a) => a.words) })) };
  }
  return { status: "failed", label, message: result?.message || WORDS.changesFailed, rows: [], sections: [] };
}
export const allLoaded = (lists, ids) => ids.length > 0 && ids.every((id) => lists[id]?.status === "loaded");
export const hasChanges = (lists, ids) => ids.some((id) => lists[id]?.firstPublish || (lists[id]?.rows || []).length > 0);

// ---- the publish panel's controller ----------------------------------------------------

// deps:
//   call(op, args, extra)        documentsApi.call or the store's wrapper
//   loadChanges(id)              listChanges for one document (default: call)
//   checkLive()                  the live release id now, or undefined (optional)
//   readDocument(id)             P4-EDITOR: getDocument straight from the server,
//                                for a lost answer's check (default: call)
//   documentOf(id)               { body, revision } of a draft the host holds
//                                (optional; otherwise it is read with getDocument)
//   keepLiveSection(id, sectionId)  the store's server-replace keepLiveSection
//                                (optional; otherwise call)
//   onDocument(document)         a document the server rewrote (save, keep live)
//   onFocus({anchor, documentId, sectionId, field})
//   onPublished(outcome)
// State (getState): {
//   phase      closed | review | publishing | done | blocked | offer |
//              republish | checking | checked | refused | conflict | error | noHome
//   items      the documents this publish sends [{id, label, type, revision,
//              draftHash, confirmRepublish?}]
//   order      ids whose change lists are shown; lists { [id]: list }
//   outcome    outcomeOf() of the last answer; offer, offerItems
//   busy, notice
// }
export function createPublishFlow(deps = {}) {
  const call = deps.call;
  const loadChanges = deps.loadChanges || ((id) => call("listChanges", { id }));
  // P4-EDITOR (P4-LIVEROW review): a lost answer is checked against what the
  // SERVER holds now. The editor's store call answers getDocument with the
  // store's own copy, which still holds what was live before, so the editor
  // passes readDocument (straight to the documents API).
  const readDocument = deps.readDocument || ((id) => call("getDocument", id));
  let state = { phase: "closed", items: [], order: [], lists: {}, outcome: null, offerItems: [], busy: false, notice: null, firstPublish: {}, types: {} };
  const subs = new Set();
  let seq = 0; // a newer open wins over an older answer
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of subs) fn(state);
  };
  const ctx = () => ({ items: state.items, offerItems: state.offerItems, documents: state.outcome?.documents, labels: deps.labels, firstPublish: state.firstPublish, types: state.types });

  // Loads every list in `ids`. Each document's hash is pinned before its
  // list is read (the hash first, then the list), so what is sent is never
  // newer than what was shown: a newer draft gives DRAFT_CHANGED, never an
  // unseen publish.
  async function loadLists(ids, labels, mine) {
    const lists = { ...state.lists };
    for (const id of ids) lists[id] = { status: "loading", label: labels[id] || "This page", rows: [], sections: [] };
    set({ lists, order: ids });
    await Promise.all(
      ids.map(async (id) => {
        let res;
        try {
          res = await loadChanges(id);
        } catch {
          res = null;
        }
        if (mine !== seq) return;
        const list = changeListOf(res, labels[id] || "This page");
        // a first version: nothing earlier to Undo to (outcomeOf)
        const firstPublish = { ...state.firstPublish, [id]: list.firstPublish === true || list.neverPublished === true };
        set({ lists: { ...state.lists, [id]: list }, firstPublish });
      }),
    );
  }

  // items need revision and draftHash; any without them is read first
  async function pinned(items) {
    const out = [];
    for (const it of items) {
      if (Number.isInteger(it.revision) && typeof it.draftHash === "string") {
        out.push({ ...it });
        continue;
      }
      const r = await call("getDocument", it.id);
      if (!r?.ok) return { error: r?.message || WORDS.changesFailed };
      const d = r.data.document;
      out.push({ ...it, revision: d.revision, draftHash: d.draftHash, label: it.label || d.label, type: it.type || d.type });
    }
    return { items: out };
  }

  async function open(documents, { access } = {}) {
    const mine = ++seq;
    if (access && access.canPublish === false) return; // staff: the button is disabled, nothing opens
    const p = await pinned(documents || []);
    if (mine !== seq) return;
    if (p.error) return set({ phase: "error", outcome: { phase: "error", title: WORDS.blockedTitle, words: p.error, retry: false }, busy: false });
    const items = p.items;
    const labels = Object.fromEntries(items.map((it) => [it.id, it.label]));
    const types = { ...state.types, ...Object.fromEntries(items.map((it) => [it.id, it.type])) };
    set({ phase: "review", items, outcome: null, offerItems: [], notice: null, busy: false, types, lists: {}, order: [] });
    await loadLists(items.map((it) => it.id), labels, mine);
  }

  const canConfirm = (s = state) => {
    if (s.busy) return false;
    if (s.phase === "review") return allLoaded(s.lists, s.order) && hasChanges(s.lists, s.order);
    if (s.phase === "offer") return allLoaded(s.lists, s.order);
    if (s.phase === "republish") return true;
    return false;
  };

  // P3-FIX3: closing the panel while a publish (or a fix) runs doesn't stop
  // it (WORDS.keepsRunning says so). The answer then doesn't open the panel
  // again: onPublished still hears a publish that went live.
  async function send(items, { asSet = false, run = seq } = {}) {
    set({ busy: true, notice: null });
    const req = publishRequest(items, { set: asSet });
    let res;
    try {
      res = await call(req.op, req.args, req.extra);
    } catch {
      res = { error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy. Check your internet connection." };
    }
    if (run !== seq) {
      const late = outcomeOf(res, { ...ctx(), items });
      if (late.phase === "done") deps.onPublished?.(late);
      return late;
    }
    state = { ...state, items };
    const outcome = outcomeOf(res, ctx());
    if (outcome.phase === "offer") return enterOffer(outcome);
    set({ phase: outcome.phase, outcome, busy: false });
    if (outcome.phase === "done") deps.onPublished?.(outcome);
    if (outcome.phase === "checking") await check(outcome, run);
    return outcome;
  }

  async function enterOffer(outcome) {
    const mine = ++seq;
    const offered = offerItems(outcome.offer);
    const types = { ...state.types };
    set({ phase: "offer", outcome, offerItems: offered, busy: false, types, lists: {}, order: [] });
    await loadLists(offered.map((it) => it.id), Object.fromEntries(offered.map((it) => [it.id, it.label])), mine);
    return outcome;
  }

  async function check(outcome, run = seq) {
    const items = state.items;
    let live;
    try {
      live = deps.checkLive ? await deps.checkLive(outcome.release) : undefined;
    } catch {
      live = undefined;
    }
    let documents = null;
    // P4-EDITOR (P4-LIVEROW review): a set of only products and collections
    // has no release (release: null). It is settled by reading each
    // document again: it went live when its published version's hash is the
    // draft hash that was sent (the live row is written in the same batch).
    if (!(outcome.release?.id && live === outcome.release.id)) {
      try {
        const got = await Promise.all(items.map((it) => readDocument(it.id)));
        documents = got.every((g) => g?.ok) ? got.map((g) => g.data.document) : null;
      } catch {
        documents = null;
      }
    }
    const resolved = resolveUnknown({ release: outcome.release, live, documents, items });
    if (run !== seq) return resolved;
    set({ phase: "checked", outcome: { ...outcome, ...resolved } });
    return resolved;
  }

  async function confirm() {
    if (!canConfirm()) return null;
    if (state.phase === "review") return send(state.items);
    if (state.phase === "offer") return send(state.offerItems, { asSet: true });
    if (state.phase === "republish") {
      const id = state.outcome.id;
      return send(state.items.map((it) => (it.id === id ? { ...it, confirmRepublish: true } : it)));
    }
    return null;
  }

  // An issue action: runs stepsFor(action) with this flow's documents.
  async function act(action, issue = null) {
    const local = deps.documentOf?.(action.documentId) || null; // { body, revision } the host already holds
    const bodies = local && isObj(local.body) && Number.isInteger(local.revision) ? { [action.documentId]: local.body } : null;
    const steps = stepsFor(action, { items: state.items, bodies, offer: state.outcome?.offer, issue });
    if (!steps.length) return null;
    if (steps[0].kind === "focus") {
      deps.onFocus?.(steps[0]);
      return steps[0];
    }
    if (steps[0].kind === "review") {
      const otherBlocks = state.outcome?.otherBlocks === true;
      return enterOffer({ phase: "offer", reason: "links", message: state.outcome?.message, issues: state.outcome?.issues || [], offer: state.outcome.offer, documents: state.outcome?.documents || [], otherBlocks });
    }
    const run = seq;
    set({ busy: true, notice: null });
    let body = bodies ? local.body : null;
    let revision = bodies ? local.revision : null;
    for (const step of steps) {
      if (step.kind === "getDocument") {
        const r = await call("getDocument", step.id);
        if (!r?.ok) return run === seq ? set({ busy: false, notice: r?.message || WORDS.changesFailed }) : null;
        body = r.data.document.body;
        revision = r.data.document.revision;
      } else if (step.kind === "saveDraft") {
        const edited = applyAction(body, step.edit);
        if (!edited.ok) return run === seq ? set({ busy: false, notice: edited.message }) : null;
        const r = await call("saveDraft", { id: step.id, body: edited.body }, { revision });
        if (!r?.ok) return run === seq ? set({ busy: false, notice: r?.message || WORDS.changesFailed }) : null;
        const doc = r.data.document;
        deps.onDocument?.(doc);
        const known = state.items.some((it) => it.id === doc.id);
        const items = known ? state.items.map((it) => (it.id === doc.id ? { ...it, revision: doc.revision, draftHash: doc.draftHash } : it)) : [...state.items, { id: doc.id, label: doc.label, type: doc.type, revision: doc.revision, draftHash: doc.draftHash }];
        state = { ...state, items };
      } else if (step.kind === "publish") {
        return send(state.items, { run });
      }
    }
    return null;
  }

  // "Keep the live version" of one section: the server rewrites the draft,
  // then that document's hash is pinned again and its list reloaded.
  async function keepLive(id, sectionId) {
    const it = state.items.find((x) => x.id === id);
    if (!it || !sectionId) return null;
    const mine = seq;
    set({ busy: true, notice: null });
    const r = deps.keepLiveSection ? await deps.keepLiveSection(id, sectionId) : await call("keepLiveSection", { id, sectionId }, { revision: it.revision });
    if (!r?.ok) {
      set({ busy: false, notice: r?.message || WORDS.changesFailed });
      return r;
    }
    const doc = r.data.document;
    deps.onDocument?.(doc);
    state = { ...state, items: state.items.map((x) => (x.id === id ? { ...x, revision: doc.revision, draftHash: doc.draftHash } : x)) };
    set({ busy: false, notice: WORDS.keepLiveDone });
    await loadLists(state.order, Object.fromEntries(state.order.map((x) => [x, state.lists[x]?.label])), mine);
    return r;
  }

  const close = () => {
    seq++;
    set({ phase: "closed", outcome: null, busy: false, notice: null, lists: {}, order: [], offerItems: [] });
  };
  // the publish is still running (a confirm or a fix in flight)
  const running = () => state.busy === true && state.phase !== "closed";

  return {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    canConfirm: () => canConfirm(),
    open,
    confirm,
    act,
    keepLive,
    close,
    running,
    retry: () => send(state.items),
  };
}

// ---- Undo, whole-set Undo and take offline ----------------------------------------------

// A target:
//   { kind: "one", label, undo: {id, revision, logId} }
//   { kind: "set", setId, members: [{id, logId}], labels, revisions }
//     revisions[i] is members[i]'s revision, from its own undo args: the
//     server refuses an undo without one (428 REVISION_REQUIRED), even a dry
//     run, so each member's own dry run sends it (undoSet takes none)
//   { kind: "offline", label, id, revision }
const requestOf = (t, dryRun) => {
  if (t.kind === "set") return { op: "undoSet", args: { setId: t.setId, members: t.members, ...(dryRun ? { dryRun: true } : {}) } };
  if (t.kind === "offline") return { op: "unpublish", args: { id: t.id, ...(dryRun ? { dryRun: true } : {}) }, extra: { revision: t.revision } };
  return { op: "undo", args: { id: t.undo.id, logId: t.undo.logId, ...(dryRun ? { dryRun: true } : {}) }, extra: { revision: t.undo.revision } };
};
export const undoRequest = requestOf;

// The dry run in words for the confirm.
// P3-FIX3: `members` (a whole-set Undo that takes a page offline) is each
// member's own dry run, [{ label, dry }], so the confirm names the page that
// goes offline, and, when only one member changes, whose changes they are.
export function dryRunView(target, dry, { members = null } = {}) {
  const d = isObj(dry) ? dry : {};
  let changes = (d.changes || []).map((c) => c.words);
  const linkers = (d.linkers || []).map((l) => l.label);
  const empty = !d.willTakeOffline && !changes.length && !d.target;
  let title =
    target.kind === "set" ? WORDS.undoSetTitle(target.members.length) : target.kind === "offline" ? WORDS.offlineTitle(target.label) : d.willTakeOffline ? WORDS.undoOfflineTitle(target.label) : WORDS.undoTitle;
  let offline = [];
  if (target.kind === "set" && Array.isArray(members)) {
    offline = members.filter((m) => m.dry?.willTakeOffline === true).map((m) => m.label);
    const going = members.filter((m) => m.dry?.willTakeOffline === true || (m.dry?.changes || []).length > 0);
    if (going.length === 1) changes = changes.map((w) => (w.startsWith(`${going[0].label}: `) ? w : `${going[0].label}: ${w}`));
    if (offline.length) title = WORDS.undoSetOfflineTitle(target.members.length, offline);
  }
  return { title, willTakeOffline: d.willTakeOffline === true, changes, linkers, goesBackTo: d.target?.name ? WORDS.undoGoesBackTo(d.target.name) : null, empty, offline };
}

// An Undo answer in words.
export function undoOutcomeOf(target, result) {
  const r = isObj(result) ? result : {};
  if (r.ok) {
    const d = r.data || {};
    if (d.nothing) return { phase: "done", words: d.message || WORDS.undoNothing, lines: [], savedVersion: false };
    if (target.kind === "set" && Array.isArray(d.documents)) {
      const kept = typeof d.message === "string" && d.message.includes("Earlier versions");
      // P3-FIX3: the server's own words name which pages are live again,
      // which went offline and which stayed as they were (nothing earlier),
      // and say so when nothing was undone at all
      if (typeof d.message === "string" && d.message) return { phase: "done", words: d.message, lines: [], savedVersion: kept };
      const live = d.documents.filter((x) => x.live).map((x) => x.label);
      const off = d.documents.filter((x) => !x.live).map((x) => x.label);
      const lines = [];
      if (live.length) lines.push(WORDS.liveNow(live));
      if (off.length) lines.push(WORDS.offlineNow(off));
      return { phase: "done", words: "Undone.", lines, savedVersion: false };
    }
    return { phase: "done", words: d.message || "Undone.", lines: [], savedVersion: isObj(d.savedVersion), liveUrl: d.liveUrl ?? null };
  }
  if (r.refused && r.code === "SLUG_TAKEN") {
    const w = slugTakenWords(r, { items: target.undo ? [{ id: target.undo.id, label: target.label }] : [] }, { undo: true });
    return { phase: "error", words: `${w.words} ${w.next}`, lines: [] };
  }
  if (r.code === "PUBLISH_UNKNOWN" || r.code === "NETWORK_ERROR") return { phase: "checking", words: WORDS.undoChecking, lines: [] };
  return { phase: "error", words: r.message || "Something went wrong on our side, so nothing changed. Try again.", lines: [], by: r.current?.updatedByName || null };
}

// An Undo whose answer was lost (NETWORK_ERROR, PUBLISH_UNKNOWN), resolved by
// asking the same dry run again: an Undo that went through leaves its row no
// longer current (409 PUBLISHED_ELSEWHERE) or nothing left to undo; one that
// didn't gives the same dry run.
export function resolveUndo(target, dry) {
  const r = isObj(dry) ? dry : {};
  if (r.ok) {
    const view = dryRunView(target, r.data);
    if (view.empty && target.kind !== "offline") return { phase: "checked", done: true, words: WORDS.undoCheckedDone, lines: [] };
    return { phase: "checked", done: false, words: WORDS.undoCheckedNot, lines: [], retry: true };
  }
  if (r.conflict || r.code === "PUBLISHED_ELSEWHERE" || r.code === "DOCUMENT_CHANGED") return { phase: "checked", done: true, words: WORDS.undoCheckedDone, lines: [] };
  return { phase: "checked", done: null, words: WORDS.undoCheckedUnknown, lines: [] };
}

const lostAnswer = (r) => !isObj(r) || r.code === "NETWORK_ERROR" || r.code === "PUBLISH_UNKNOWN";
const safeCall = async (call, req) => {
  try {
    return await call(req.op, req.args, req.extra);
  } catch {
    return { error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy. Check your internet connection." };
  }
};

// deps: call, onDocument, onUndone, access (P3-FIX3: without the right to
// undo, start() sends nothing)
export function createUndoFlow(deps = {}) {
  const call = deps.call;
  let state = { phase: "idle", target: null, view: null, outcome: null, busy: false };
  const subs = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of subs) fn(state);
  };
  async function start(target) {
    if (undoDenied(deps.access)) return null;
    set({ phase: "loading", target, view: null, outcome: null, busy: true });
    const req = requestOf(target, true);
    const r = await safeCall(call, req);
    if (state.target !== target) return null;
    if (lostAnswer(r)) return set({ phase: "result", outcome: { phase: "error", words: r?.message || WORDS.changesFailed, lines: [] }, busy: false });
    if (!r?.ok) return set({ phase: "result", outcome: undoOutcomeOf(target, r), busy: false });
    // P3-FIX3: a whole-set Undo that takes a page offline asks each member's
    // own dry run, so the confirm can name that page
    let members = null;
    if (target.kind === "set" && r.data?.willTakeOffline === true) {
      // P3-FIX3 round 1: with its revision; a member without one is not asked
      const each = await Promise.all(target.members.map((m, i) => (Number.isInteger(target.revisions?.[i]) ? safeCall(call, requestOf({ kind: "one", undo: { id: m.id, logId: m.logId, revision: target.revisions[i] } }, true)) : null)));
      if (state.target !== target) return null;
      members = target.members.map((m, i) => ({ label: target.labels?.[i] || "That page", dry: each[i]?.ok ? each[i].data : null }));
    }
    const view = dryRunView(target, r.data, { members });
    if (view.empty && target.kind !== "offline") return set({ phase: "result", view, outcome: { phase: "done", words: WORDS.undoNothing, lines: [] }, busy: false });
    set({ phase: "confirm", view, busy: false });
    return view;
  }
  async function confirm() {
    if (state.phase !== "confirm" || state.busy) return null;
    const target = state.target;
    set({ busy: true });
    const req = requestOf(target, false);
    const r = await safeCall(call, req);
    if (state.target !== target) return null;
    if (lostAnswer(r)) {
      // P3-FIX3: "Checking…", then the dry run again
      set({ phase: "checking", outcome: undoOutcomeOf(target, r) });
      const again = await safeCall(call, requestOf(target, true));
      if (state.target !== target) return null;
      const outcome = resolveUndo(target, again);
      set({ phase: "result", outcome, busy: false });
      if (outcome.done) deps.onUndone?.(outcome, target);
      return outcome;
    }
    const outcome = undoOutcomeOf(target, r);
    if (r?.ok && r.data?.document) deps.onDocument?.(r.data.document);
    if (r?.ok && Array.isArray(r.data?.documents)) for (const d of r.data.documents) deps.onDocument?.(d);
    set({ phase: "result", outcome, busy: false });
    if (r?.ok) deps.onUndone?.(outcome, target);
    return outcome;
  }
  return {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    start,
    confirm,
    cancel: () => set({ phase: "idle", target: null, view: null, outcome: null, busy: false }),
  };
}

// ---- Earlier versions ------------------------------------------------------------------

// listHistory versions as rows. A kept version shows its own note ("Saved
// before Undo", "Kept from another tab"); `by` is already a plain name.
export function historyRowsOf(versions, { timeZone } = {}) {
  return (Array.isArray(versions) ? versions : []).map((v) => ({
    id: v.id,
    title: v.kind === "undo_saved" && v.note ? v.note : KIND_WORDS[v.kind] || "Saved",
    note: v.kind !== "undo_saved" && v.note ? v.note : null,
    when: when(v.createdAt, { timeZone }),
    by: v.by || null,
    live: v.live === true,
    kind: v.kind,
  }));
}

export function restoreOutcomeOf(result, row) {
  if (result?.ok) return { ok: true, words: `Your draft is now the version from ${row?.when || "then"}. It isn't live until you publish.` };
  return { ok: false, words: result?.message || "Something went wrong on our side, so nothing was restored. Try again." };
}

// ---- Recently published ----------------------------------------------------------------

// Rows newest first; the rows of one set (one publish) are grouped. A group
// offers whole-set Undo when two or more of its rows can be undone; Undo
// is offered only on a row whose canUndo is true.
export function recentGroupsOf(rows, { timeZone } = {}) {
  const groups = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = {
      logId: r.logId,
      documentId: r.documentId,
      label: r.label,
      actionWords: r.actionWords,
      byName: r.byName,
      when: when(r.at, { timeZone }),
      summary: (r.summary || []).map((s) => s.words),
      canUndo: r.canUndo === true && isObj(r.undo),
      undo: r.canUndo === true && isObj(r.undo) ? r.undo : null,
      note: typeof r.note === "string" && r.note ? r.note : null,
    };
    // the Undo target of this row, made once, so the active one is found by identity
    row.target = row.canUndo ? { kind: "one", label: row.label, undo: row.undo } : null;
    const last = groups[groups.length - 1];
    if (last && last.setId === r.setId) last.rows.push(row);
    else groups.push({ setId: r.setId, rows: [row] });
  }
  for (const g of groups) {
    const undoable = g.rows.filter((x) => x.canUndo);
    g.undoSet = g.rows.length > 1 && undoable.length > 1 ? { kind: "set", setId: g.setId, members: undoable.map((x) => ({ id: x.undo.id, logId: x.undo.logId })), labels: undoable.map((x) => x.label), revisions: undoable.map((x) => x.undo.revision) } : null;
  }
  return groups;
}
