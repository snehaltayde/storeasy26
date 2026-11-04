// P3-STORE (ED-02, ED-03, PV-02, PUB-04, PUB-09): the editor's store for one
// open document. Plain JS, no React and no DOM. Everything it touches from
// the outside is passed in, so node tests drive it:
//
//   createDocumentStore({
//     api,        documentsApi (components/admin/editor/documentsApi.js):
//                 call(op, args, {revision}) and sendKeepalive(op, args, extra)
//     document,   the document as getDocument answers it (id, type, body,
//                 revision, draftHash, …)
//     tenant,     the store's id, for the local backup's key
//     storage,    localStorage or a stand-in (getItem, setItem, removeItem,
//                 key, length); null for none. Every use is in try/catch.
//     timers,     { setTimeout, clearTimeout }
//     now,        () => milliseconds, for the backup's time
//     pauseMs,    the autosave pause (AUTOSAVE_PAUSE_MS)
//   })
//
// How saving works (ED-03):
//   - Every edit (setField and the section operations) replaces the local
//     body at once, so the editor shows it, and starts the pause again.
//   - When the pause ends, one saveDraft goes out. Only one is ever in
//     flight. Text typed while it is in flight is kept, and saved next.
//   - A save's answer gives the new revision and draftHash. When nothing
//     was typed since it was sent, the server's body (sanitized, ids
//     stamped) becomes the local body too.
//   - A failure keeps the founder's text. It is retried by itself only
//     when the server says it may be (retryable: true), or when the network
//     failed (nothing came back at all).
//
// Server-replace operations (plan A5): undo, keepLiveSection, discardDraft
// ("Go back to the live version"), restoreVersion, and unpublish. Each one
// saves pending edits first (flush), then holds autosave while the server
// works. The answer's document replaces the local body and revision. Edits
// typed during the hold were recorded as operations (a field path and a
// value, or a section added, removed or moved), and are applied again on
// top of the new body, then saved. A full body from before the operation is
// never written over the server's new draft. An edit that can't be applied
// again (its section is gone) is not lost: the founder's whole body is kept
// as an earlier draft first, and the store says so.
//
// Publishing: publish and publishSet flush, hold, then publish with the
// draftHash the server last acknowledged, so what is published is what was
// saved. PUBLISH_UNKNOWN is never a failure: the answer says "check what
// went live" (checkLive: true).
//
// Conflicts (409 DOCUMENT_CHANGED): autosave stops and the store offers the
// choice. useNewer keeps the founder's body as an earlier draft, then takes
// the newer version. keepMine keeps the newer version as an earlier draft,
// then saves the founder's body on top of it. Whichever is not chosen is
// kept as an undo_saved version ("Kept from another tab"), which the
// checkpoint cap never prunes.
//
// The web address (PV-02, plan decision 9): SLUG_INVALID stays a 422 in
// draft mode. While meta.slug is invalid here (or is the address another
// page holds, SLUG_TAKEN), every save sends the last saved address instead,
// so the other edits keep saving, and the field is marked "not saved yet".
//
// Leaving: beforeNavigate() saves first (in-app links, switching document).
// beforeUnload() answers true (warn) while anything is not acknowledged, and
// sends the save with fetch keepalive when the request is at most 60,000
// bytes. Every body that is not acknowledged is also kept in storage, and
// offered on the next open as an earlier draft.
import { SLUG_RE } from "../../../lib/registry/settings.js";
import { documentHash } from "../../../lib/registry/body.js";
import { KEEPALIVE_MAX_BYTES, byteLength } from "./documentsApi.js";

// ED-03's "short pause". The spec gives no number; this is the legacy
// Designer's candidate pause (components/admin/cms/Designer.js, 700 ms).
export const AUTOSAVE_PAUSE_MS = 700;
// Waits between automatic retries of a save that may be retried.
export const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
export const BACKUP_PREFIX = "storeasy:unsaved:";
export const KEPT_NOTE = "Kept from another tab";

export const WORDS = Object.freeze({
  saving: "Saving",
  saved: "Saved",
  couldNotSave: "Could not save",
  backupOffer: "We found edits that weren't saved. Keep them as an earlier draft?",
  backupKept: "Your edits were kept as an earlier draft. Find them in Earlier versions.",
  slugNotSaved: "Not saved yet: the web address can use lower-case letters, digits and hyphens only, and must start with a letter or digit.",
  notSavedFirst: "Your latest changes aren't saved yet, so nothing else was done. They are still here.",
  busy: "Wait for the last change to finish, then try again.",
  inConflict: "Choose which version to keep first.",
  replayKept: "Some edits you made while that ran couldn't be added back, so we kept your version as an earlier draft. Find it in Earlier versions.",
  replayLocal: "Some edits you made while that ran couldn't be added back. Keep your version as an earlier draft?",
  checkLive: "Your publish may have gone live. Check what is live now.",
});

export function conflictWords(current) {
  const name = current && typeof current.updatedByName === "string" ? current.updatedByName.trim() : "";
  if (!name || name === "another tab") return "This page was changed in another tab.";
  return `This page was changed in another tab or by ${name}.`;
}

// ---- operations on a body (pure) ------------------------------------------------------
// A path is "sections.sec_hero1.settings.title" or the same as an array.
// In a list, a number is a place and any other segment is an item's id, so
// a path still finds its section after sections were added or moved.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const FAILED = Symbol("could not apply");

export function parsePath(path) {
  const segs = Array.isArray(path) ? path : String(path ?? "").split(".");
  return segs.filter((s) => s !== "").map((s) => (typeof s === "number" || /^\d+$/.test(s) ? Number(s) : String(s)));
}

function setIn(node, segs, value) {
  if (!segs.length) return value;
  const [head, ...rest] = segs;
  if (Array.isArray(node)) {
    const i = typeof head === "number" ? head : node.findIndex((el) => isObj(el) && el.id === head);
    if (i < 0 || i > node.length || (i === node.length && rest.length)) return FAILED;
    const next = setIn(node[i], rest, value);
    if (next === FAILED) return FAILED;
    const out = node.slice();
    if (next === undefined && !rest.length) out.splice(i, 1);
    else out[i] = next;
    return out;
  }
  if (node === undefined || node === null) {
    if (typeof head === "number") return FAILED;
    node = {};
  }
  if (!isObj(node)) return FAILED;
  const next = setIn(node[head], rest, value);
  if (next === FAILED) return FAILED;
  const out = { ...node };
  if (next === undefined) delete out[head];
  else out[head] = next;
  return out;
}

const sectionsOf = (body) => (isObj(body) && Array.isArray(body.sections) ? body.sections : null);
const placeAfter = (list, item, afterId, index) => {
  let at;
  if (afterId === null) at = 0;
  else if (typeof afterId === "string") {
    const j = list.findIndex((s) => isObj(s) && s.id === afterId);
    at = j >= 0 ? j + 1 : Math.max(0, Math.min(Number(index) || 0, list.length));
  } else at = Math.max(0, Math.min(Number(index) || 0, list.length));
  const out = list.slice();
  out.splice(at, 0, item);
  return out;
};

// One recorded operation on a body: a new body, or FAILED when it can't
// apply (its section or item is gone). Never changes `body`.
export function applyOp(body, op) {
  if (!isObj(op)) return FAILED;
  if (op.op === "set") return setIn(body, parsePath(op.path), op.value);
  const list = sectionsOf(body);
  if (!list) return FAILED;
  if (op.op === "insertSection") {
    if (!isObj(op.section)) return FAILED;
    if (op.section.id && list.some((s) => isObj(s) && s.id === op.section.id)) return body; // already there
    return { ...body, sections: placeAfter(list, op.section, op.afterId, op.index) };
  }
  if (op.op === "removeSection") {
    // gone already is what the founder wanted
    return list.some((s) => isObj(s) && s.id === op.sectionId) ? { ...body, sections: list.filter((s) => !(isObj(s) && s.id === op.sectionId)) } : body;
  }
  if (op.op === "moveSection") {
    const i = list.findIndex((s) => isObj(s) && s.id === op.sectionId);
    if (i < 0) return body; // a move of a section that is gone loses no text
    const rest = list.filter((_, j) => j !== i);
    return { ...body, sections: placeAfter(rest, list[i], op.afterId, op.index) };
  }
  return FAILED;
}

// ---- the store --------------------------------------------------------------------

const defaultTimers = () => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
});

export function createDocumentStore({
  api,
  document: initial,
  tenant = "",
  storage = null,
  timers = defaultTimers(),
  now = () => Date.now(),
  pauseMs = AUTOSAVE_PAUSE_MS,
  retryDelays = RETRY_DELAYS_MS,
} = {}) {
  if (!api || typeof api.call !== "function") throw new TypeError("createDocumentStore needs documentsApi");
  if (!isObj(initial) || typeof initial.id !== "string") throw new TypeError("createDocumentStore needs the document");
  const id = initial.id;

  let doc = { ...initial }; // the server's document as last acknowledged
  let savedBody = initial.body; // the body the server holds (last acknowledged)
  let body = initial.body; // the local body, what the founder sees
  let revision = initial.revision;
  let draftHash = initial.draftHash ?? null;

  let seq = 0; // bumped on every local edit
  let ackedSeq = 0; // the edit the server has acknowledged
  let inflight = null; // the save in flight (a promise)
  let again = false; // the pause ended while a save was in flight
  let pauseTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  let hold = 0; // a server-replace operation or a publish is running
  let busyOp = null;
  let opPromise = null;
  let heldOps = [];
  let conflict = null; // { code, message, words, current }
  let error = null; // { code, message, retryable }
  let pending = null; // a 422: { code, message, issues }
  let issues = Array.isArray(initial.issues) ? initial.issues : [];
  let slugHeld = false; // the last save sent the last saved address instead
  let taken = null; // { slug, message } from a SLUG_TAKEN
  let backupOffer = null;
  let ownKeys = new Set(); // the backup keys this tab wrote (only these does mirror clear)
  let choosing = false; // useNewer or keepMine is running
  let notice = null;
  let ackCount = 0;
  let disposed = false;

  const listeners = new Set();
  let snapshot = null;

  // ---- state for the editor ----
  const unsavedEdits = () => seq !== ackedSeq;
  function statusOf() {
    if (conflict) return "conflict";
    if (busyOp) return "busy";
    if (inflight) return "saving";
    if (error || pending) return "error";
    if (unsavedEdits()) return "pending";
    return "saved";
  }
  function statusWordsOf(status) {
    if (status === "error") return `${WORDS.couldNotSave}: ${(pending || error).message}`;
    if (status === "conflict") return conflict.words;
    if (status === "saving" || status === "pending" || status === "busy") return WORDS.saving;
    return WORDS.saved;
  }
  function fieldsNotSaved() {
    const out = {};
    const s = slugProblem(body);
    if (s) out["meta.slug"] = s;
    return out;
  }
  function build() {
    const status = statusOf();
    return Object.freeze({
      id,
      type: doc.type,
      body,
      revision,
      draftHash,
      document: doc,
      status,
      statusWords: statusWordsOf(status),
      saving: Boolean(inflight),
      unacknowledged: unacknowledged(),
      error,
      pending,
      unsavedWarning: Boolean(pending) || Boolean(slugProblem(body)),
      issues,
      fieldsNotSaved: fieldsNotSaved(),
      conflict: conflict && { code: conflict.code, message: conflict.message, words: conflict.words, current: conflict.current, choices: ["useNewer", "keepMine"] },
      busy: busyOp,
      backupOffer,
      notice,
      ackCount,
    });
  }
  function emit() {
    snapshot = null;
    mirror();
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* a listener's fault is not the store's */
      }
    }
  }
  const getState = () => (snapshot ||= build());
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  // ---- the web address ----
  function slugProblem(b) {
    const slug = isObj(b) && isObj(b.meta) ? b.meta.slug : undefined;
    if (typeof slug !== "string" || !slug.trim()) return null;
    if (!SLUG_RE.test(slug)) return WORDS.slugNotSaved;
    if (taken && taken.slug === slug) return `Not saved yet: ${taken.message}`;
    return null;
  }
  // What a save (or a kept draft) sends: the body, with the last saved
  // address in place of one the server would refuse.
  function outgoing(b) {
    if (!slugProblem(b)) return { body: b, held: false };
    const meta = { ...b.meta };
    const last = isObj(savedBody) && isObj(savedBody.meta) ? savedBody.meta.slug : undefined;
    if (last === undefined || slugProblem({ meta: { slug: last } })) delete meta.slug;
    else meta.slug = last;
    return { body: { ...b, meta }, held: true };
  }
  const unacknowledged = () => unsavedEdits() || Boolean(inflight) || hold > 0 || Boolean(conflict) || Boolean(slugProblem(body));

  // ---- timers ----
  function clearPause() {
    if (pauseTimer != null) timers.clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  function clearRetry() {
    if (retryTimer != null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }
  const canAutosave = () => !disposed && !hold && !conflict;
  function schedule() {
    clearPause();
    if (!canAutosave()) return;
    pauseTimer = timers.setTimeout(() => {
      pauseTimer = null;
      if (!canAutosave() || !unsavedEdits()) return;
      if (inflight) again = true;
      else startSave();
    }, pauseMs);
  }
  function scheduleRetry() {
    clearRetry();
    if (!canAutosave()) return;
    const wait = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
    retryCount++;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (canAutosave() && !inflight && unsavedEdits()) startSave();
    }, wait);
  }

  // ---- adopting the server's document ----
  function adopt(d) {
    doc = { ...doc, ...d };
    savedBody = d.body;
    revision = d.revision;
    draftHash = d.draftHash ?? null;
    ackCount++;
  }
  async function hashOf(b) {
    try {
      return await documentHash(b);
    } catch {
      return null;
    }
  }

  // ---- one save ----
  function startSave() {
    if (inflight) return inflight;
    clearRetry();
    clearPause(); // this save carries everything typed so far
    inflight = saveOnce().finally(() => {
      inflight = null;
      const more = again || (unsavedEdits() && pauseTimer == null && retryTimer == null && !error && !pending);
      again = false;
      if (more && canAutosave() && unsavedEdits()) startSave();
      emit();
    });
    emit();
    return inflight;
  }

  async function saveOnce() {
    const sentSeq = seq;
    const out = outgoing(body);
    const r = await api.call("saveDraft", { id, body: out.body }, { revision });
    if (disposed) return r;
    if (r.ok && isObj(r.data?.document)) {
      const d = r.data.document;
      adopt(d);
      ackedSeq = sentSeq;
      // nothing typed since: the server's body (sanitized, ids stamped) is
      // the local body. An address held back stays as the founder typed it.
      if (seq === sentSeq && !out.held) body = d.body;
      issues = Array.isArray(r.data.issues) ? r.data.issues : [];
      error = null;
      pending = null;
      retryCount = 0;
      slugHeld = out.held;
      return { ok: true };
    }
    if (r.conflict && r.code === "DOCUMENT_CHANGED") {
      // a resend whose first answer was lost: the server holds exactly what
      // we sent, so this is our own save
      if (isObj(r.current) && r.current.draftHash && r.current.draftHash === (await hashOf(out.body))) {
        adopt(r.current);
        ackedSeq = sentSeq;
        error = null;
        pending = null;
        slugHeld = out.held;
        return { ok: true };
      }
      enterConflict(r);
      return r;
    }
    if (r.refused && r.code === "SLUG_TAKEN" && isObj(out.body.meta) && typeof out.body.meta.slug === "string") {
      // another page holds this address: save the rest with the last saved one
      taken = { slug: out.body.meta.slug, message: r.message };
      error = null;
      again = true;
      return r;
    }
    if (Array.isArray(r.issues)) {
      pending = { code: r.code, message: r.message, issues: r.issues };
      error = null;
      return r;
    }
    error = { code: r.code || "REQUEST_FAILED", message: r.message || WORDS.couldNotSave, retryable: r.retryable === true };
    pending = null;
    if (r.retryable === true || r.code === "NETWORK_ERROR") scheduleRetry();
    return r;
  }

  function enterConflict(r) {
    conflict = { code: r.code, message: r.message, current: isObj(r.current) ? r.current : null, words: conflictWords(r.current) };
    clearPause();
    clearRetry();
    again = false;
  }

  // Everything typed so far, saved. { ok: true } or the failure.
  async function flush() {
    clearPause();
    for (let i = 0; i < 50; i++) {
      if (inflight) {
        await inflight;
        continue;
      }
      if (conflict) return { ok: false, conflict: true, code: conflict.code, message: WORDS.inConflict };
      if (!unsavedEdits()) return { ok: true, slugNotSaved: Boolean(slugProblem(body)) };
      const r = await startSave();
      if (!r.ok && !(r.refused && r.code === "SLUG_TAKEN")) return { ok: false, ...r };
    }
    return { ok: false, error: true, code: "NOT_SAVED", message: WORDS.notSavedFirst };
  }

  // ---- edits ----
  function edit(op) {
    if (disposed) return false;
    const next = applyOp(body, op);
    if (next === FAILED) return false;
    body = next;
    seq++;
    if (hold) heldOps.push(op);
    notice = null;
    schedule();
    emit();
    return true;
  }
  const setField = (path, value) => edit({ op: "set", path: parsePath(path), value });
  function insertSection(section, index) {
    const list = sectionsOf(body) || [];
    const at = Math.max(0, Math.min(Number.isInteger(index) ? index : list.length, list.length));
    return edit({ op: "insertSection", section, index: at, afterId: at === 0 ? null : list[at - 1]?.id ?? undefined });
  }
  const removeSection = (sectionId) => edit({ op: "removeSection", sectionId });
  function moveSection(sectionId, toIndex) {
    const list = (sectionsOf(body) || []).filter((s) => !(isObj(s) && s.id === sectionId));
    const at = Math.max(0, Math.min(Number(toIndex) || 0, list.length));
    return edit({ op: "moveSection", sectionId, index: at, afterId: at === 0 ? null : list[at - 1]?.id ?? undefined });
  }

  // ---- holding autosave around a server call ----
  async function held(name, fn) {
    if (disposed) return { error: true, code: "CLOSED", message: WORDS.notSavedFirst };
    if (conflict) return { ok: false, conflict: true, code: conflict.code, message: WORDS.inConflict };
    if (opPromise) return { error: true, code: "BUSY", message: WORDS.busy };
    let release;
    opPromise = new Promise((res) => (release = res));
    busyOp = name;
    emit();
    try {
      const f = await flush();
      if (!f.ok) return { ...f, notDone: true, reason: f.message ?? null, message: f.conflict ? f.message : WORDS.notSavedFirst };
      hold++;
      heldOps = [];
      const holdSeq = seq;
      let r;
      try {
        r = await fn();
      } finally {
        hold--;
      }
      const ops = heldOps;
      heldOps = [];
      return await settleHeld(r, ops, holdSeq);
    } finally {
      busyOp = null;
      opPromise = null;
      release();
      if (canAutosave() && unsavedEdits() && !inflight) startSave();
      emit();
    }
  }

  // After the held call: a document in the answer replaces the local body
  // and revision, and the edits typed meanwhile are applied again on top.
  async function settleHeld(r, ops, holdSeq) {
    const d = r && r.ok && isObj(r.data) && isObj(r.data.document) ? r.data.document : null;
    if (r && r.conflict && r.code === "DOCUMENT_CHANGED" && (!r.current || r.current.id === id)) {
      enterConflict(r);
      return r;
    }
    if (!d) return r;
    let next = d.body;
    let lost = false;
    for (const op of ops) {
      const n = applyOp(next, op);
      if (n === FAILED) lost = true;
      else next = n;
    }
    if (lost) {
      // keep the founder's whole body before it is replaced: on the server
      // when it answers, else in this browser, offered as an earlier draft
      const before = body;
      const k = await keepBody(before);
      if (k.ok) notice = WORDS.replayKept;
      else offerLocal(before, revision);
    }
    adopt(d);
    body = next;
    ackedSeq = holdSeq;
    error = null;
    pending = null;
    return r;
  }

  const rev = () => ({ revision });
  const undo = ({ logId, dryRun = false } = {}) =>
    dryRun ? api.call("undo", { id, logId, dryRun: true }, rev()) : held("undo", async () => checkUnknown(await api.call("undo", { id, logId }, rev())));
  const unpublish = ({ dryRun = false } = {}) =>
    dryRun ? api.call("unpublish", { id, dryRun: true }, rev()) : held("unpublish", async () => checkUnknown(await api.call("unpublish", { id }, rev())));
  const keepLiveSection = (sectionId) => held("keepLiveSection", () => api.call("keepLiveSection", { id, sectionId }, rev()));
  const discardDraft = () => held("discardDraft", () => api.call("discardDraft", id, rev()));
  const restoreVersion = (versionId) => held("restoreVersion", () => api.call("restoreVersion", { id, versionId }, rev()));

  // PUBLISH_UNKNOWN: it may have gone live. Never a failure: read the
  // document again, so a draft the server rewrote is taken in.
  async function checkUnknown(r) {
    if (!(r && r.code === "PUBLISH_UNKNOWN")) return r;
    const out = { ...r, checkLive: true, message: r.message || WORDS.checkLive };
    const g = await api.call("getDocument", id);
    if (g.ok && isObj(g.data?.document) && g.data.document.revision !== revision) return { ...out, ok: true, unknown: true, data: { document: g.data.document } };
    return out;
  }

  function markPublished(r) {
    const items = r && r.ok && Array.isArray(r.data?.published) ? r.data.published : [];
    const mine = items.find((p) => p && p.id === id);
    if (mine) {
      doc = { ...doc, publishedVersionId: mine.versionId ?? doc.publishedVersionId, publishedHash: mine.hash ?? doc.publishedHash, live: true, unpublishedChanges: false };
      ackCount++;
    }
  }
  const publishResult = (r) => (r && r.code === "PUBLISH_UNKNOWN" ? { ...r, checkLive: true, message: r.message || WORDS.checkLive } : r);

  const publish = ({ confirmRepublish = false } = {}) =>
    held("publish", async () => {
      const r = await api.call("publish", { id, draftHash, ...(confirmRepublish ? { confirmRepublish: true } : {}) }, rev());
      markPublished(r);
      return publishResult(r);
    });

  // items: [{id, revision, draftHash, confirmRepublish?}] (an offer's
  // publishSet). This document's entry is always the acknowledged one.
  const publishSet = (items = []) =>
    held("publishSet", async () => {
      const list = [];
      let mineIn = false;
      for (const it of Array.isArray(items) ? items : []) {
        if (!isObj(it) || typeof it.id !== "string") continue;
        if (it.id === id) {
          mineIn = true;
          list.push({ id, revision, draftHash, ...(it.confirmRepublish ? { confirmRepublish: true } : {}) });
        } else list.push({ id: it.id, revision: it.revision, draftHash: it.draftHash, ...(it.confirmRepublish ? { confirmRepublish: true } : {}) });
      }
      if (!mineIn) list.unshift({ id, revision, draftHash });
      const r = await api.call("publishSet", list);
      markPublished(r);
      return publishResult(r);
    });

  // ---- kept drafts and the conflict choice ----
  const keepBody = (b) => api.call("keepAsEarlierDraft", { id, body: outgoing(b).body });

  async function useNewer() {
    if (!conflict) return { ok: true, nothing: true };
    if (choosing) return { error: true, code: "BUSY", message: WORDS.busy };
    const current = conflict.current;
    if (!isObj(current) || !isObj(current.body)) return { error: true, code: "NO_CURRENT", message: conflict.message };
    choosing = true;
    let k;
    try {
      // Text typed while a keep is in flight is not in the kept body: keep
      // again until the kept body is the newest one, so nothing is dropped.
      for (let i = 0; ; i++) {
        const keptSeq = seq;
        k = await keepBody(body);
        if (!k.ok || disposed) {
          emit();
          return k;
        }
        if (seq === keptSeq) break;
        if (i >= 20) {
          emit();
          return { error: true, code: "NOT_KEPT", message: WORDS.notSavedFirst };
        }
      }
    } finally {
      choosing = false;
    }
    adopt(current);
    body = current.body;
    ackedSeq = seq;
    conflict = null;
    error = null;
    pending = null;
    taken = null;
    notice = WORDS.backupKept;
    emit();
    return { ok: true, kept: k.data?.savedVersion ?? null };
  }

  async function keepMine() {
    if (!conflict) return { ok: true, nothing: true };
    if (choosing) return { error: true, code: "BUSY", message: WORDS.busy };
    const current = conflict.current;
    if (!isObj(current) || !isObj(current.body)) return { error: true, code: "NO_CURRENT", message: conflict.message };
    choosing = true;
    let k;
    try {
      k = await keepBody(current.body);
    } finally {
      choosing = false;
    }
    if (!k.ok) {
      emit();
      return k;
    }
    // save mine on top of the newer revision
    const { body: newer, ...rest } = current;
    doc = { ...doc, ...rest };
    savedBody = newer;
    revision = current.revision;
    draftHash = current.draftHash ?? null;
    conflict = null;
    emit();
    const r = await startSave();
    if (r && r.ok) notice = WORDS.backupKept;
    emit();
    return r && r.ok ? { ok: true, kept: k.data?.savedVersion ?? null } : r;
  }

  // ---- leaving ----
  async function beforeNavigate() {
    if (opPromise) await opPromise;
    const f = await flush();
    return f;
  }

  // true: warn. Sends the save with fetch keepalive when it fits. A backup
  // offered and not answered yet also warns.
  function beforeUnload() {
    const warn = unacknowledged() || Boolean(backupOffer);
    if (warn && unsavedEdits() && !conflict && typeof api.sendKeepalive === "function") {
      const args = { id, body: outgoing(body).body };
      const extra = { revision };
      let bytes = Infinity;
      try {
        bytes = byteLength(JSON.stringify({ ...extra, saveDraft: args }));
      } catch {
        bytes = Infinity;
      }
      if (bytes <= KEEPALIVE_MAX_BYTES) {
        try {
          api.sendKeepalive("saveDraft", args, extra);
        } catch {
          /* the backup is still there */
        }
      }
    }
    return warn;
  }

  // ---- the local backup ----
  const docPrefix = () => `${BACKUP_PREFIX}${tenant}:${id}:`;
  function backupKeys() {
    const out = [];
    try {
      const n = Number(storage.length) || 0;
      for (let i = 0; i < n; i++) {
        const k = storage.key(i);
        if (typeof k === "string" && k.startsWith(docPrefix())) out.push(k);
      }
    } catch {
      /* storage we can't read */
    }
    return out;
  }
  // Only this tab's own keys are ever cleared here. A backup found on open
  // (or another tab's) stays until acceptBackup or dismissBackup answers it.
  function mirror() {
    if (!storage) return;
    try {
      const keep = unsavedEdits() || Boolean(slugProblem(body)) || Boolean(conflict);
      const key = `${docPrefix()}${revision}`;
      for (const k of [...ownKeys]) {
        if (keep && k === key) continue;
        storage.removeItem(k);
        ownKeys.delete(k);
      }
      if (!keep || disposed) return;
      if (backupOffer && backupOffer.key === key && !ownKeys.has(key)) {
        // the offered backup sits where this tab's own would go: move it first
        const moved = `${docPrefix()}found-${backupOffer.baseRevision}-${backupOffer.savedAt ?? 0}`;
        const raw = storage.getItem(key);
        storage.setItem(moved, raw ?? JSON.stringify({ v: 1, baseRevision: backupOffer.baseRevision, savedAt: backupOffer.savedAt, body: backupOffer.body }));
        backupOffer = { ...backupOffer, key: moved };
      }
      storage.setItem(key, JSON.stringify({ v: 1, baseRevision: revision, savedAt: now(), body }));
      ownKeys.add(key);
    } catch {
      /* storage that throws changes nothing else */
    }
  }

  // On open: a backup from an earlier visit (its base revision is not newer
  // than the server's) that differs from the draft is offered.
  async function open() {
    if (!storage) return getState();
    let found = null;
    try {
      for (const k of backupKeys()) {
        const v = JSON.parse(storage.getItem(k));
        if (!isObj(v) || !isObj(v.body) || !Number.isFinite(v.baseRevision)) {
          storage.removeItem(k);
          continue;
        }
        if (v.baseRevision > revision) continue;
        if (!found || (v.savedAt ?? 0) > (found.savedAt ?? 0)) found = { ...v, key: k };
      }
    } catch {
      found = null;
    }
    if (found) {
      const same = (await hashOf(found.body)) === draftHash && draftHash != null;
      if (same) {
        try {
          storage.removeItem(found.key);
        } catch {
          /* nothing */
        }
      } else backupOffer = { body: found.body, baseRevision: found.baseRevision, savedAt: found.savedAt ?? null, words: WORDS.backupOffer, key: found.key };
    }
    emit();
    return getState();
  }

  // A body the server couldn't keep: in this browser, and offered now.
  function offerLocal(b, baseRevision) {
    const key = `${docPrefix()}held-${baseRevision}-${now()}`;
    const savedAt = now();
    try {
      storage?.setItem(key, JSON.stringify({ v: 1, baseRevision, savedAt, body: b }));
    } catch {
      /* still offered below */
    }
    backupOffer = { body: b, baseRevision, savedAt, words: WORDS.replayLocal, key };
  }

  async function acceptBackup() {
    if (!backupOffer) return { ok: true, nothing: true };
    const offer = backupOffer;
    const r = await keepBody(offer.body);
    if (r.ok) {
      try {
        storage.removeItem(offer.key);
      } catch {
        /* nothing */
      }
      backupOffer = null;
      notice = WORDS.backupKept;
    }
    emit();
    return r;
  }
  function dismissBackup() {
    if (!backupOffer) return;
    try {
      storage.removeItem(backupOffer.key);
    } catch {
      /* nothing */
    }
    backupOffer = null;
    emit();
  }

  function retry() {
    error = null;
    pending = null;
    retryCount = 0;
    clearRetry();
    if (canAutosave() && !inflight) return startSave();
    return inflight || Promise.resolve({ ok: true });
  }

  function dispose() {
    clearPause();
    clearRetry();
    disposed = true;
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    setField,
    insertSection,
    removeSection,
    moveSection,
    apply: edit,
    flush,
    retry,
    undo,
    unpublish,
    keepLiveSection,
    discardDraft,
    restoreVersion,
    publish,
    publishSet,
    useNewer,
    keepMine,
    keepAsEarlierDraft: keepBody,
    beforeNavigate,
    beforeUnload,
    open,
    acceptBackup,
    dismissBackup,
    dispose,
  };
}
