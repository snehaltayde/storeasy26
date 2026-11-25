// Phase 6 line 1 (docs/plans/phase-6.md, features 3 to 5): the logic of
// dragging a section in the studio's Sections rail. Plain JS: no React, no
// DOM, no network, so node suites drive every case (scripts/test-studio-drag.js).
//
//   DRAG_THRESHOLD_PX                 a pointer drag starts after 4px
//   canGrab(role)                     storefront.write: support and operator
//                                     support never pick anything up
//   indexAt({ y, rows, from, scale, origin })
//                                     the index the dragged row would take for
//                                     a pointer at client y. rows: the rows'
//                                     {top, height} as measured (client px, or
//                                     the list's layout px with `origin` its
//                                     client top and `scale` its zoom). The
//                                     dragged row's own slot is skipped, so the
//                                     answer is the final index (0 … n-1).
//   checkMove(sections, id, to, { type })
//                                     treeModel.move's verdict for that spot:
//                                     { ok, sections, reason }
//   grab / keyMove / drop / cancel    the keyboard hold (Space or Enter picks
//                                     up, arrows / Home / End move, Space or
//                                     Enter drops, Escape returns it). Each
//                                     returns { hold, sections, say, done? }:
//                                     hold is the state (null when let go),
//                                     sections the order to show, say the
//                                     live-region text.
//   SAY                               the announcements, exactly the plan's
import { move } from "./treeModel.js";
import { roleAllows } from "../../../../lib/platform/authz.js";
import { sectionType } from "../../../../lib/registry/index.js";

export const DRAG_THRESHOLD_PX = 4;
export const EDGE_PX = 32; // the rail scrolls when the pointer is this close to its edge
export const NO_DROP = "Can't drop here";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plain = (reason) => String(reason || "That spot isn't allowed").replace(/[.\s]+$/, "");

export const SAY = Object.freeze({
  pickedUp: (label, pos, total) => `Picked up ${label}, position ${pos} of ${total}. Arrow keys move it, Space drops it, Escape cancels.`,
  moved: (label, pos, total) => `${label}, position ${pos} of ${total}.`,
  refused: (reason) => `Can't go there: ${plain(reason)}.`,
  dropped: (label, pos, total) => `${label} dropped at position ${pos} of ${total}.`,
  cancelled: (label, pos) => `Move cancelled. ${label} is back at position ${pos}.`,
});

export const canGrab = (role) => roleAllows(role, "storefront.write");

export const labelOf = (section) => (isObj(section) && sectionType(section.kind)?.label) || "This section";
const indexOf = (sections, id) => (Array.isArray(sections) ? sections.findIndex((s) => isObj(s) && s.id === id) : -1);

export function indexAt({ y, rows, from, scale = 1, origin = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // rows are in the list's own layout px from `origin` (its client top); with
  // the defaults (scale 1, origin 0) they are plain client px
  const local = (Number(y) - origin) / k;
  // the midpoints of every row but the dragged one, in order
  let to = 0;
  for (let i = 0; i < list.length; i++) {
    if (i === from) continue;
    const r = list[i];
    if (local > r.top + r.height / 2) to++;
  }
  return Math.max(0, Math.min(list.length - 1, to));
}

export function checkMove(sections, id, to, { type } = {}) {
  const r = move(sections, id, to, { type });
  return r.ok ? { ok: true, sections: r.sections, reason: null } : { ok: false, sections: null, reason: r.message || null };
}

// ---- the keyboard hold ----------------------------------------------------------------

export function grab(sections, id, { role, type } = {}) {
  const from = indexOf(sections, id);
  if (!canGrab(role) || from < 0) return null;
  const total = sections.length;
  return { hold: { id, from, at: from, type, original: sections }, sections, say: SAY.pickedUp(labelOf(sections[from]), from + 1, total) };
}

// dir: "up" | "down" | "first" | "last"
export function keyMove(hold, dir) {
  if (!hold) return null;
  const total = hold.original.length;
  const want = dir === "up" ? hold.at - 1 : dir === "down" ? hold.at + 1 : dir === "first" ? 0 : dir === "last" ? total - 1 : hold.at;
  const label = labelOf(hold.original[hold.from]);
  const current = checkMove(hold.original, hold.id, hold.at, { type: hold.type }).sections || hold.original;
  if (want < 0 || want >= total || want === hold.at) return { hold, sections: current, say: SAY.moved(label, hold.at + 1, total) };
  const r = checkMove(hold.original, hold.id, want, { type: hold.type });
  if (!r.ok) return { hold, sections: current, say: SAY.refused(r.reason) };
  return { hold: { ...hold, at: want }, sections: r.sections, say: SAY.moved(label, want + 1, total) };
}

// done: the move to send (null when it ends where it started)
export function drop(hold) {
  if (!hold) return null;
  const total = hold.original.length;
  const label = labelOf(hold.original[hold.from]);
  const r = checkMove(hold.original, hold.id, hold.at, { type: hold.type });
  const moved = r.ok && hold.at !== hold.from;
  return { hold: null, sections: moved ? r.sections : hold.original, done: moved ? r.sections : null, say: SAY.dropped(label, (moved ? hold.at : hold.from) + 1, total) };
}

export function cancel(hold) {
  if (!hold) return null;
  return { hold: null, sections: hold.original, done: null, say: SAY.cancelled(labelOf(hold.original[hold.from]), hold.from + 1) };
}

// a key while a section is held → the hold's next step, or null (not ours)
export function holdKey(hold, key) {
  if (!hold) return null;
  if (key === "ArrowUp") return keyMove(hold, "up");
  if (key === "ArrowDown") return keyMove(hold, "down");
  if (key === "Home") return keyMove(hold, "first");
  if (key === "End") return keyMove(hold, "last");
  if (key === " " || key === "Enter") return drop(hold);
  if (key === "Escape") return cancel(hold);
  return null;
}

// ---- the pointer drag -------------------------------------------------------------------

// where a pointer drag stands: { to, ok, reason, sections } for the rail and
// the frame (sections: the order to show; the original when refused)
export function pointerTarget(sections, id, y, rows, { type, scale = 1, origin = 0 } = {}) {
  const from = indexOf(sections, id);
  const to = indexAt({ y, rows, from, scale, origin });
  const r = checkMove(sections, id, to, { type });
  return { from, to, ok: r.ok, reason: r.ok ? null : r.reason, sections: r.ok ? r.sections : sections };
}

// the rail's auto-scroll step near its edges: px to scroll (negative is up)
export function edgeScroll(y, box, { edge = EDGE_PX, step = 12 } = {}) {
  if (!box) return 0;
  if (y < box.top + edge) return -step;
  if (y > box.bottom - edge) return step;
  return 0;
}
