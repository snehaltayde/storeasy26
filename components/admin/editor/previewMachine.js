// P3-STORE (PV-01, PUB-11): what the editor's preview label says, and what
// the editor should do next. Pure: no React, no DOM, no timers. The editor
// feeds it what happened and does what the answer says.
//
// The three labels are spec 7 PV-01's: "Up to date", "Updating", "Could not
// update" (with the reason in plain words and, when there is one, the field
// to go to). The label never says "Up to date" while the frame may hold
// older content: a save acknowledged after the frame started loading makes
// it load again, and a frame whose ready names an older draft is reloaded.
//
// Inputs (send(input) or previewStep(state, input)):
//   {type: "mintOk"}                        a preview session and its cookie
//   {type: "mintFailed", message?}          startDocumentsPreview failed
//   {type: "saveAck", draftHash, issues?}   the store's save (or a server
//                                           replace) was acknowledged
//   {type: "saveFailed", message, field?}   the save failed (network, server)
//   {type: "savePending", message, issues}  the save was refused (422)
//   {type: "refreshSent"}                   the editor posted storeasy:refresh
//   {type: "frameLoad"}                     the frame's load event
//   {type: "ready", ok: true, state?}       the bridge's ready (state.docs
//                                           maps a document id to the draft
//                                           hash the frame shows)
//   {type: "ready", ok: false, reason}      revoked | expired | not_found (the
//                                           session ended), live (the frame
//                                           shows the live store), legacy
//   {type: "readyTimeout"}                  no ready within READY_TIMEOUT_MS
//                                           of a frame load
//   {type: "retry"}                         the founder pressed Try again
//
// Answer: { state, label, words, field, note, remint, reload, armReadyTimer }
//   remint         start a new preview session (startDocumentsPreview)
//   reload         reload the frame (post storeasy:refresh, or set its src)
//   armReadyTimer  start the READY_TIMEOUT_MS timer (after a frame load)
//   fixDesign      P3-FIX5 (finding D1): the design is open, but the frame's
//                  ready says its new colours are hidden (doc_design is in
//                  state.skipped): the session the frame renders (the one
//                  the browser's _preview cookie names, state.sid) must get
//                  showDesign on, then the frame reloads. Never "Up to date"
//                  meanwhile; after MAX_DESIGN_FIXES tries in a row it says
//                  Could not update with PREVIEW_WORDS.designHidden.

export const PREVIEW_LABELS = Object.freeze({
  upToDate: "Up to date",
  updating: "Updating",
  couldNotUpdate: "Could not update",
});
export const READY_TIMEOUT_MS = 3000;
// Re-mints in a row without a good ready before the label gives up.
export const MAX_REMINTS = 2;
// Reloads in a row whose ready still names an older draft.
export const MAX_STALE_RELOADS = 2;
// P3-FIX5: tries in a row to turn the colours on in the frame's session.
export const MAX_DESIGN_FIXES = 2;

export const PREVIEW_WORDS = Object.freeze({
  reconnecting: "Reconnecting…",
  loading: "Showing your latest changes…",
  ended: "Your preview session ended and a new one couldn't be started. Try again.",
  live: "The preview is showing your live store, not your changes, and it couldn't reconnect. Try again.",
  timeout: "The preview didn't answer. Check your internet connection, then try again.",
  legacy: "This store still previews from the current Storefront editor.",
  mintFailed: "We couldn't open the preview. Check your internet connection, then try again.",
  stale: "The preview is still showing an older version of your changes. Try again.",
  saveFailed: "Your latest changes aren't saved yet, so the preview doesn't show them.",
  incomplete: "A section isn't finished yet, so the preview shows a placeholder for it.",
  designHidden: "The preview isn't showing your new colours. Try again.",
});

const ENDED = new Set(["revoked", "expired", "not_found"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function initialPreviewState({ documentId = null, showDesign = false } = {}) {
  return Object.freeze({
    phase: "minting", // minting | loading | shown | failed
    documentId,
    wantDesign: Boolean(showDesign), // the design is open: its colours must show
    designFixes: 0,
    expectHash: null, // the draftHash the frame should show
    ackDuringLoad: false,
    readySinceLoad: false,
    remints: 0,
    stale: 0,
    failure: null, // { kind, words, field }
    note: null, // { words, field }
  });
}

function labelOf(phase) {
  if (phase === "shown") return PREVIEW_LABELS.upToDate;
  if (phase === "failed") return PREVIEW_LABELS.couldNotUpdate;
  return PREVIEW_LABELS.updating;
}

const fieldOfIssue = (i) => (isObj(i) ? i.anchor || (i.field ? { sectionId: i.sectionId ?? null, field: i.field } : null) : null);
function noteOf(issues) {
  const list = Array.isArray(issues) ? issues : [];
  const first = list.find((i) => isObj(i) && i.severity === "incomplete");
  return first ? { words: PREVIEW_WORDS.incomplete, field: fieldOfIssue(first) } : null;
}

function answer(state, actions = {}) {
  const s = Object.freeze(state);
  const words =
    s.phase === "failed"
      ? s.failure?.words ?? PREVIEW_WORDS.mintFailed
      : (s.phase === "minting" || s.phase === "loading") && s.remints > 0
        ? PREVIEW_WORDS.reconnecting // the whole reconnect: the mint, then the new frame's load, until a ready ok resets remints
        : s.phase === "loading" || s.phase === "minting"
          ? PREVIEW_WORDS.loading
          : null;
  return {
    state: s,
    label: labelOf(s.phase),
    words,
    field: s.phase === "failed" ? s.failure?.field ?? null : null,
    note: s.phase === "shown" ? s.note : null,
    remint: Boolean(actions.remint),
    reload: Boolean(actions.reload),
    armReadyTimer: Boolean(actions.armReadyTimer),
    fixDesign: Boolean(actions.fixDesign),
  };
}

// P3-FIX5: the frame's ready says the design draft is not shown (the layout
// lists doc_design in skipped when that session's showDesign is off).
export function designHiddenIn(frameState) {
  return isObj(frameState) && Array.isArray(frameState.skipped) && frameState.skipped.includes("doc_design");
}

// The session or the frame let us down: re-mint, unless that has already
// failed MAX_REMINTS times in a row.
function remintOr(s, failWords) {
  if (s.remints >= MAX_REMINTS) return answer({ ...s, phase: "failed", failure: { kind: "session", words: failWords, field: null } });
  return answer({ ...s, phase: "minting", remints: s.remints + 1, readySinceLoad: false, ackDuringLoad: false }, { remint: true });
}

export function previewStep(state, input) {
  const s = isObj(state) ? state : initialPreviewState();
  const type = isObj(input) ? input.type : null;
  switch (type) {
    case "mintOk":
      return answer({ ...s, phase: "loading", readySinceLoad: false, ackDuringLoad: false, failure: null }, { reload: true });
    case "mintFailed":
      return answer({ ...s, phase: "failed", failure: { kind: "mint", words: input.message || PREVIEW_WORDS.mintFailed, field: null } });
    case "saveAck": {
      const next = { ...s, expectHash: input.draftHash ?? s.expectHash, note: noteOf(input.issues) };
      if (s.phase === "shown") return answer({ ...next, phase: "loading", readySinceLoad: false, ackDuringLoad: false, stale: 0 }, { reload: true });
      if (s.phase === "loading") return answer({ ...next, ackDuringLoad: true });
      if (s.phase === "failed") {
        if (s.failure?.kind === "save") return answer({ ...next, phase: "loading", failure: null, readySinceLoad: false, ackDuringLoad: false, stale: 0 }, { reload: true });
        if (s.failure?.kind === "legacy") return answer(next);
        // the session or the frame failed: a new save is a reason to try again
        return remintOr({ ...next, remints: 0 }, s.failure?.words ?? PREVIEW_WORDS.ended);
      }
      return answer(next); // minting: the new frame loads the latest draft
    }
    case "saveFailed":
    case "savePending": {
      const firstIssue = Array.isArray(input.issues) ? input.issues.find(isObj) : null;
      const field = input.field ?? (firstIssue ? fieldOfIssue(firstIssue) : null);
      const words = input.message || firstIssue?.message || PREVIEW_WORDS.saveFailed;
      if (s.phase === "failed" && s.failure?.kind !== "save") return answer(s); // the session's failure says more
      return answer({ ...s, phase: "failed", failure: { kind: "save", words, field } });
    }
    case "refreshSent":
      // a failed state stays failed: a reload shows nothing newer
      if (s.phase !== "shown" && s.phase !== "loading") return answer(s);
      return answer({ ...s, phase: "loading", readySinceLoad: false, ackDuringLoad: false });
    case "frameLoad":
      if (s.phase !== "loading") return answer(s);
      return answer({ ...s, readySinceLoad: false }, { armReadyTimer: true });
    case "ready": {
      // a late ready from the frame before the re-mint says nothing new
      if (s.phase === "minting") return answer(s);
      if (input.ok === true) {
        const base = { ...s, readySinceLoad: true, remints: 0 };
        if (s.phase === "failed" && s.failure?.kind === "save") return answer(base); // still not saved
        if (s.ackDuringLoad) return answer({ ...base, phase: "loading", ackDuringLoad: false, readySinceLoad: false }, { reload: true });
        const docs = isObj(input.state) && isObj(input.state.docs) ? input.state.docs : null;
        const shows = docs && s.documentId && Object.hasOwn(docs, s.documentId) ? docs[s.documentId] : undefined;
        if (s.wantDesign && designHiddenIn(input.state)) {
          // finding D1: never Up to date while the frame shows the old colours
          if (s.designFixes >= MAX_DESIGN_FIXES) return answer({ ...base, phase: "failed", designFixes: 0, failure: { kind: "frame", words: PREVIEW_WORDS.designHidden, field: null } });
          return answer({ ...base, phase: "loading", designFixes: s.designFixes + 1, readySinceLoad: false }, { fixDesign: true });
        }
        if (s.expectHash && shows !== undefined && shows !== s.expectHash) {
          if (s.stale + 1 >= MAX_STALE_RELOADS) return answer({ ...base, phase: "failed", stale: 0, failure: { kind: "frame", words: PREVIEW_WORDS.stale, field: null } });
          return answer({ ...base, phase: "loading", stale: s.stale + 1, readySinceLoad: false }, { reload: true });
        }
        return answer({ ...base, phase: "shown", stale: 0, designFixes: 0, failure: null });
      }
      const reason = typeof input.reason === "string" ? input.reason : "live";
      if (reason === "legacy") return answer({ ...s, phase: "failed", readySinceLoad: true, failure: { kind: "legacy", words: PREVIEW_WORDS.legacy, field: null } });
      return remintOr({ ...s, readySinceLoad: true }, reason === "live" ? PREVIEW_WORDS.live : PREVIEW_WORDS.ended);
    }
    case "readyTimeout":
      if (s.phase !== "loading" || s.readySinceLoad) return answer(s);
      return remintOr(s, PREVIEW_WORDS.timeout);
    case "retry":
      return answer({ ...s, phase: "minting", remints: 0, stale: 0, designFixes: 0, failure: null, readySinceLoad: false, ackDuringLoad: false }, { remint: true });
    default:
      return answer(s);
  }
}

// A small holder for the editor: send(input) keeps the state.
export function createPreviewMachine({ documentId = null, showDesign = false } = {}) {
  let state = initialPreviewState({ documentId, showDesign });
  let last = answer(state);
  return {
    send(input) {
      last = previewStep(state, input);
      state = last.state;
      return last;
    },
    get state() {
      return state;
    },
    get current() {
      return last;
    },
  };
}
