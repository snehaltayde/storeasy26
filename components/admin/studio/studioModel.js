// Phase 6 (studio, step 0): what the studio remembers about this session.
// Plain JS: no React, no DOM, no network. Lines 1 and 2 build on it.
//
//   createStudioModel({ limit })      one per studio session
//     touch(docId)                    this session changed docId
//     touched() → [docId…]            in the order first touched
//     isTouched(docId) → boolean
//     record({docId, before, after})  one undo step (bodies, copied). A step
//                                     whose before equals its after, or with
//                                     no docId, is not recorded (false).
//                                     Touches docId, clears redo, keeps the
//                                     last `limit` steps (50).
//     undo() → step | null            the step to take back: the caller
//     redo() → step | null            writes step.before (undo) or step.after
//                                     (redo) as a normal draft save, never a
//                                     publish; neither records a new step
//     canUndo(), canRedo() → boolean
//     onStep(docId, fn) → unsubscribe  (Phase 6 line 2) a document kept in
//                                     its own store outside the studio's
//                                     (doc_design, DesignRail.js) applies its
//                                     own steps: undo()/redo() call
//                                     fn(step, "undo"|"redo") for that docId
//                                     before returning the step
//     subscribe(fn) → unsubscribe     fn() after every change
//     getSnapshot() → {touched, undo, redo}  (counts; stable between changes)
//
//   restoreOps(current, target) → [{path, value}]
//     the top-level keys of a body that differ, as store.setField(path,
//     value) calls that turn `current` into `target` (value undefined: the
//     key is removed).
//
//   orderMessage(docId, body) → {type:"storeasy:order", doc, ids, hidden}
//     the frame's instant reorder and hide (components/preview/bridge-core.js)
//     for a body's sections: ids in the body's order, hidden = isHidden ones.
import { isHidden } from "../editor/tree/treeModel.js";

export const HISTORY_LIMIT = 50;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createStudioModel({ limit = HISTORY_LIMIT } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : HISTORY_LIMIT;
  const touchedIds = [];
  let past = [];
  let future = [];
  const listeners = new Set();
  const appliers = new Map();
  let snap = null;
  const applied = (step, dir) => {
    const out = { docId: step.docId, before: copy(step.before), after: copy(step.after) };
    const fn = appliers.get(step.docId);
    if (fn) fn({ docId: out.docId, before: copy(out.before), after: copy(out.after) }, dir);
    return out;
  };
  const changed = () => {
    snap = null;
    for (const fn of [...listeners]) fn();
  };

  const touch = (docId) => {
    if (typeof docId !== "string" || !docId || touchedIds.includes(docId)) return;
    touchedIds.push(docId);
    changed();
  };
  const record = ({ docId, before, after } = {}) => {
    if (typeof docId !== "string" || !docId || same(before, after)) return false;
    if (!touchedIds.includes(docId)) touchedIds.push(docId);
    past = [...past, Object.freeze({ docId, before: copy(before), after: copy(after) })].slice(-max);
    future = [];
    changed();
    return true;
  };
  const undo = () => {
    const step = past.at(-1);
    if (!step) return null;
    past = past.slice(0, -1);
    future = [...future, step];
    changed();
    return applied(step, "undo");
  };
  const redo = () => {
    const step = future.at(-1);
    if (!step) return null;
    future = future.slice(0, -1);
    past = [...past, step];
    changed();
    return applied(step, "redo");
  };

  return {
    touch,
    touched: () => [...touchedIds],
    isTouched: (docId) => touchedIds.includes(docId),
    record,
    undo,
    redo,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    onStep(docId, fn) {
      if (typeof docId !== "string" || !docId || typeof fn !== "function") return () => {};
      appliers.set(docId, fn);
      return () => appliers.get(docId) === fn && appliers.delete(docId);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot() {
      snap ??= Object.freeze({ touched: Object.freeze([...touchedIds]), undo: past.length, redo: future.length });
      return snap;
    },
  };
}

export function restoreOps(current, target) {
  const a = isObj(current) ? current : {};
  const b = isObj(target) ? target : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => !same(a[k], b[k])).map((k) => ({ path: k, value: copy(b[k]) }));
}

export function orderMessage(docId, body) {
  const list = isObj(body) && Array.isArray(body.sections) ? body.sections.filter((x) => isObj(x) && typeof x.id === "string") : [];
  return { type: "storeasy:order", doc: docId, ids: list.map((x) => x.id), hidden: list.filter(isHidden).map((x) => x.id) };
}
