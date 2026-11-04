// P3-TREE (ED-02, AU-04, ED-04): the section tree's logic. Pure: no React, no
// store, no node: imports. It runs in the console client, in node tests and on
// the edge alike (it imports only lib/registry, which is edge-safe).
//
// Every operation takes the document's sections and returns a new list; it
// never changes the list it was given. Each answers
//   { ok: true,  sections, selectedId, id? }       the new list, and what to select
//   { ok: false, code, message }                   refused, in plain words; the
//                                                  caller keeps its list
//
//   add(sections, kind, index, { type, collections })
//        a new section from starterSection (lib/registry/starter.js), with an
//        id minted here, on the client, so it is selectable in the preview
//        before its first save (ED-04, spec 8.5). The id comes from the
//        registry's Web Crypto minter (lib/registry/body.js mintSectionId;
//        lib/documents/ids.js mints document, version and log ids, not
//        section ids), and is never one the document already uses.
//        It goes at `index` (the end when left out). When the composition
//        rules refuse that place, it goes to the kind's allowed position (a
//        hero: the top), else the end, else the top; the answer's `index`
//        says where. A product rail given `collections` is bound to one with
//        products.
//   move(sections, id, toIndex, { type }), moveUp(…, id, …), moveDown(…, id, …)
//        ids never change on a move: the same section objects, reordered
//   hide(sections, id, { type }), show(sections, id, { type })
//        enabled:false / true. show also clears "hidden on both screens"
//        (TREE-05: hiding on both screens is the normal Hide)
//   duplicate(sections, id, { type })
//        a deep copy right below the original, with a fresh section id and a
//        fresh id for every nested block, none of them used anywhere in the
//        document
//   remove(sections, id, { type })   (also exported as `delete`)
//
// P3-FIX3: add and duplicate also take `body` (the whole draft, optional).
// When the draft with the new section would be over the draft cap
// (validate.js DRAFT_MAX_BYTES, which saveDraft refuses as DRAFT_TOO_LARGE),
// the operation is refused with DRAFT_TOO_LARGE, so the tree never offers a
// copy that can't be saved. Without `body`, the sections alone are measured
// (the rest of a draft is small: settings and meta).
//
// The composition rules are the registry's, not a copy of them: before an
// operation is answered ok, the result is checked with validateDocument in
// draft mode and refused if it would add a "structure" issue the list did not
// already have (a second hero, a hero moved off the top, the product details
// hidden, removed or copied, too many sections above them, a kind the document
// does not take). So every ok answer gives a body that saves (saveDraft
// answers 422 for any structure issue, plan decision 9). The check runs on a
// copy whose sections carry their kind's defaults instead of the founder's
// settings: settings never decide composition, and this keeps the check cheap
// enough to run for every row's buttons.
//
// For the tree's markup:
//   addOptions(type, sections, index)   every registered kind the document
//                                       type takes, with its label and hint,
//                                       and whether it can be added there
//   rowActions(sections, id, type)      which of move up, move down, hide or
//                                       show, duplicate and delete are allowed,
//                                       each with the reason when not
//   rowState(section, issues)           the row's label and its marks: hidden,
//                                       unfinished (an "incomplete" issue in the
//                                       section) and problem (an "error")
//   groupIssues(issues)                 { [sectionId]: issues } from a flat list
import { sectionType, documentType, allowedKinds, newSection, emptyBody, validateDocument, mintSectionId, mintBlockId, starterSection, isBlank } from "../../../../lib/registry/index.js";
import { issueClass, STRUCTURE, INCOMPLETE, DRAFT_MAX_BYTES } from "../../../../lib/registry/validate.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (sections) => (Array.isArray(sections) ? sections : []);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const refuse = (code, message) => ({ ok: false, code, message });

// ---- ids ---------------------------------------------------------------------

// Every section and block id the document already uses.
export function idsInUse(sections) {
  const used = new Set();
  for (const s of list(sections)) {
    if (!isObj(s)) continue;
    if (typeof s.id === "string") used.add(s.id);
    for (const b of Array.isArray(s.blocks) ? s.blocks : []) if (isObj(b) && typeof b.id === "string") used.add(b.id);
  }
  return used;
}

const freshId = (mint, used) => {
  let id = mint();
  while (used.has(id)) id = mint();
  used.add(id);
  return id;
};

const indexOf = (sections, id) => list(sections).findIndex((s) => isObj(s) && s.id === id);

// ---- the composition check ---------------------------------------------------

const nounOf = (type) => documentType(type)?.noun || "this document";
const labelOf = (kind) => sectionType(kind)?.label || "section";

// A section reduced to what composition reads: its id, kind, version and
// whether it shows. A kind we don't know is kept as it is, so it is still
// reported (and stays reported the same way before and after).
function probeSection(s) {
  if (!isObj(s) || !sectionType(s.kind)) return s;
  const p = newSection(s.kind, { id: s.id });
  if (s.v !== undefined) p.v = s.v;
  if (s.enabled !== undefined) p.enabled = s.enabled;
  if (s.show !== undefined) p.show = s.show;
  if (s.blocks !== undefined) p.blocks = s.blocks;
  return p;
}

function probeBody(type, sections) {
  const body = emptyBody(type);
  if (documentType(type)?.route) Object.assign(body.meta, { slug: "tree-probe", title: "Tree probe" });
  body.sections = list(sections).map(probeSection);
  return body;
}

// The structure issues of a section list, each keyed by what it says (its
// code and field, not which section), so a list and its reordering compare.
function structureIssues(type, sections) {
  const { issues } = validateDocument(probeBody(type, sections), { mode: "draft" });
  return issues.filter((i) => issueClass(i) === STRUCTURE);
}
const keyOf = (i) => `${i.code}|${i.field ?? ""}`;

// The first structure issue `after` has that `before` did not, or null.
function addedIssue(type, before, after) {
  const had = new Map();
  for (const i of structureIssues(type, before)) had.set(keyOf(i), (had.get(keyOf(i)) || 0) + 1);
  for (const i of structureIssues(type, after)) {
    const n = had.get(keyOf(i)) || 0;
    if (n > 0) had.set(keyOf(i), n - 1);
    else return i;
  }
  return null;
}

// The refusal for an issue the operation would add, in words about the
// operation (validate's own words are about fixing a saved body).
function refusalFor(issue, type, sections, after, verb) {
  const s = list(after).find((x) => isObj(x) && x.id === issue.sectionId) || null;
  const label = s ? labelOf(s.kind) : "section";
  const noun = nounOf(type);
  switch (issue.code) {
    case "TOO_MANY_OF_KIND": {
      const max = sectionType(s?.kind)?.maxPerDocument ?? 1;
      return refuse(issue.code, max === 1 ? `${cap(noun)} already has a ${lower(label)}. It can have only one.` : `${cap(noun)} can have only ${max} ${lower(label)} sections.`);
    }
    case "POSITION_NOT_ALLOWED":
      return refuse(issue.code, issue.message.replace(/ Move it there\.$/, "."));
    case "KIND_NOT_ALLOWED":
      return refuse(issue.code, `A ${lower(label)} section can't go on ${noun}.`);
    case "PROTECTED_HIDDEN":
      return refuse(issue.code, `The ${lower(label)} can't be hidden: shoppers need it to buy.`);
    case "PROTECTED_MISSING":
      return refuse(issue.code, `${cap(noun)} needs its ${lower(labelOf(protectedKindIn(sections)))}, so it can't be deleted.`);
    case "TOO_MANY_BEFORE_PROTECTED": {
      const max = documentType(type)?.maxBeforeProtected ?? 0;
      const what = lower(labelOf(protectedKindIn(sections)));
      return refuse(issue.code, `Only ${max === 1 ? "one section" : `${max} sections`} can sit above the ${what}.`);
    }
    default:
      return refuse(issue.code, verb ? `This section can't be ${verb}: ${lower(issue.message)}` : issue.message);
  }
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const protectedKindIn = (sections) => list(sections).find((s) => isObj(s) && sectionType(s.kind)?.protected)?.kind ?? null;

function guarded(type, before, after, verb, extra) {
  if (!documentType(type)?.sections) return refuse("SECTIONS_NOT_ALLOWED", `${cap(nounOf(type))} doesn't hold sections.`);
  const issue = addedIssue(type, before, after);
  if (issue) return refusalFor(issue, type, before, after, verb);
  return { ok: true, sections: after, ...extra };
}

// ---- operations --------------------------------------------------------------

// Where a kind may go, nearest first to the index asked for.
function candidateIndexes(kind, index, length) {
  const d = sectionType(kind);
  const at = Number.isInteger(index) && index >= 0 && index <= length ? index : length;
  const out = [at];
  for (const p of d?.allowedPositions || []) out.push(p === "first" ? 0 : p === "last" ? length : Math.min(Math.max(p, 0), length));
  out.push(length, 0);
  return [...new Set(out)];
}

// The draft's size in bytes (UTF-8 JSON), as validate.js draftCaps measures it.
function draftBytes(type, body, sections) {
  try {
    return new TextEncoder().encode(JSON.stringify({ ...(isObj(body) ? body : { schema: 1, type }), sections })).length;
  } catch {
    return 0;
  }
}
const tooLarge = (verb) => refuse("DRAFT_TOO_LARGE", `This section can't be ${verb}: the page would be too big to save. Shorten some text or remove a section first.`);

export function add(sections, kind, index, { type, collections = null, body = null } = {}) {
  const before = list(sections);
  const d = sectionType(kind);
  if (!d) return refuse("UNKNOWN_KIND", "That kind of section isn't one we know.");
  if (!allowedKinds(type).includes(kind)) return refuse("KIND_NOT_ALLOWED", `A ${lower(d.label)} section can't go on ${nounOf(type)}.`);
  const id = freshId(mintSectionId, idsInUse(before));
  const section = starterSection(kind, { collections, id });
  let first = null;
  for (const at of candidateIndexes(kind, index, before.length)) {
    const after = [...before.slice(0, at), section, ...before.slice(at)];
    const r = guarded(type, before, after, "added", { selectedId: id, id, index: at });
    if (r.ok) return draftBytes(type, body, after) > DRAFT_MAX_BYTES ? tooLarge("added") : r;
    first ??= r;
  }
  return first;
}

export function move(sections, id, toIndex, { type } = {}) {
  const before = list(sections);
  const from = indexOf(before, id);
  if (from < 0) return refuse("NOT_FOUND", "That section isn't on this page any more.");
  const to = Math.min(Math.max(Number.isInteger(toIndex) ? toIndex : from, 0), before.length - 1);
  if (to === from) return { ok: true, sections: before, selectedId: id };
  const after = [...before];
  const [s] = after.splice(from, 1);
  after.splice(to, 0, s);
  return guarded(type, before, after, "moved there", { selectedId: id });
}
export const moveUp = (sections, id, opts) => (indexOf(sections, id) <= 0 ? refuse("AT_TOP", "This section is already at the top.") : move(sections, id, indexOf(sections, id) - 1, opts));
export const moveDown = (sections, id, opts) => {
  const i = indexOf(sections, id);
  return i < 0 || i >= list(sections).length - 1 ? refuse("AT_BOTTOM", "This section is already at the bottom.") : move(sections, id, i + 1, opts);
};

const hiddenOnBoth = (s) => isObj(s.show) && s.show.mobile === false && s.show.desktop === false;
export const isHidden = (s) => isObj(s) && (s.enabled === false || hiddenOnBoth(s));

function replaceAt(before, i, next) {
  const after = [...before];
  after[i] = next;
  return after;
}

export function hide(sections, id, { type } = {}) {
  const before = list(sections);
  const i = indexOf(before, id);
  if (i < 0) return refuse("NOT_FOUND", "That section isn't on this page any more.");
  if (sectionType(before[i].kind)?.protected) return refuse("PROTECTED_HIDDEN", `The ${lower(labelOf(before[i].kind))} can't be hidden: shoppers need it to buy.`);
  if (before[i].enabled === false) return { ok: true, sections: before, selectedId: id };
  return guarded(type, before, replaceAt(before, i, { ...before[i], enabled: false }), "hidden", { selectedId: id });
}

export function show(sections, id, { type } = {}) {
  const before = list(sections);
  const i = indexOf(before, id);
  if (i < 0) return refuse("NOT_FOUND", "That section isn't on this page any more.");
  const next = { ...before[i], enabled: true };
  if (hiddenOnBoth(next)) next.show = { ...next.show, mobile: true, desktop: true };
  return guarded(type, before, replaceAt(before, i, next), "shown", { selectedId: id });
}

export function duplicate(sections, id, { type, body = null } = {}) {
  const before = list(sections);
  const i = indexOf(before, id);
  if (i < 0) return refuse("NOT_FOUND", "That section isn't on this page any more.");
  const original = before[i];
  const d = sectionType(original.kind);
  if (d?.protected) return refuse("PROTECTED_COPY", `The ${lower(d.label)} can't be copied: a page has only one.`);
  const used = idsInUse(before);
  const copy = clone(original);
  copy.id = freshId(mintSectionId, used);
  if (Array.isArray(copy.blocks)) copy.blocks = copy.blocks.map((b) => (isObj(b) ? { ...b, id: freshId(mintBlockId, used) } : b));
  const after = [...before.slice(0, i + 1), copy, ...before.slice(i + 1)];
  const r = guarded(type, before, after, "copied", { selectedId: copy.id, id: copy.id });
  return r.ok && draftBytes(type, body, after) > DRAFT_MAX_BYTES ? tooLarge("copied") : r;
}

export function remove(sections, id, { type } = {}) {
  const before = list(sections);
  const i = indexOf(before, id);
  if (i < 0) return refuse("NOT_FOUND", "That section isn't on this page any more.");
  const d = sectionType(before[i].kind);
  if (d?.protected) return refuse("PROTECTED_MISSING", `The ${lower(d.label)} can't be deleted: shoppers need it to buy.`);
  const after = before.filter((_, n) => n !== i);
  const neighbour = after[i] ?? after[i - 1] ?? null;
  return guarded(type, before, after, "deleted", { selectedId: isObj(neighbour) ? neighbour.id ?? null : null });
}
export { remove as delete };

// ---- what the tree shows -----------------------------------------------------

export function addOptions(type, sections, index, { body = null } = {}) {
  return allowedKinds(type).map((kind) => {
    const d = sectionType(kind);
    const r = add(sections, kind, index, { type, body });
    return { kind, label: d.label, placeholder: d.placeholder, ok: r.ok, reason: r.ok ? null : r.message, index: r.ok ? r.index : null };
  });
}

const allow = (r) => ({ ok: r.ok, reason: r.ok ? null : r.message, code: r.ok ? null : r.code });

export function rowActions(sections, id, type, { body = null } = {}) {
  const s = list(sections)[indexOf(sections, id)];
  return {
    moveUp: allow(moveUp(sections, id, { type })),
    moveDown: allow(moveDown(sections, id, { type })),
    hide: isHidden(s) ? { ok: false, reason: "This section is hidden.", code: "HIDDEN" } : allow(hide(sections, id, { type })),
    show: isHidden(s) ? allow(show(sections, id, { type })) : { ok: false, reason: "This section is shown.", code: "SHOWN" },
    duplicate: allow(duplicate(sections, id, { type, body })),
    remove: allow(remove(sections, id, { type })),
  };
}

// The words a row shows after the kind: the section's own title, when it has one.
function titleOf(s) {
  const t = isObj(s?.settings) ? s.settings.title : null;
  if (typeof t !== "string" || isBlank(t)) return "";
  const plain = t.replace(/\s+/g, " ").trim();
  return plain.length > 48 ? `${plain.slice(0, 47)}…` : plain;
}

export function rowState(section, issues = []) {
  const known = isObj(section) ? sectionType(section.kind) : null;
  const mine = Array.isArray(issues) ? issues : [];
  return {
    id: isObj(section) ? section.id ?? null : null,
    label: known ? known.label : "A section we don't know",
    title: titleOf(section),
    placeholder: known?.placeholder || "",
    hidden: isHidden(section),
    protected: !!known?.protected,
    unfinished: mine.some((i) => i?.severity === INCOMPLETE),
    problem: mine.some((i) => i?.severity === "error"),
  };
}

export function groupIssues(issues) {
  const out = {};
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!isObj(i) || typeof i.sectionId !== "string") continue;
    (out[i.sectionId] ??= []).push(i);
  }
  return out;
}
