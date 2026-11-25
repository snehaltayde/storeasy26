// P4-ED05 (DOC-09 partly pulled in; plan decision 12): the store's old saved
// page templates (cms_templates), on a documents store. They are not turned
// into blueprints (DOC-09 is P1). They stay readable, and "Make a page from
// this" starts a new page, campaign or journal post from one.
//
// Pure and edge-safe (no database, no node: imports): the client part runs
// it at the click. The page (app/(console)/admin/(authed)/editor/templates)
// reads the table, and only reads it: nothing here, there or in the client
// part edits or deletes a saved template.
//
//   parseTemplateSections(v)   the stored sections JSON as a list ([] when
//                          unreadable)
//   TEMPLATE_FAMILIES      the families, in the order the page lists them,
//                          with their plain names
//   pageBodyFromTemplate(template, { title })
//                          PURE (also runs in the browser, at the click):
//                          -> { type, body, notes }. A draft body of the
//                          template's family (page, campaign or journal) with
//                          the template's sections, re-validated:
//                            · each section gets a FRESH id (and its blocks),
//                              minted at the call, so two pages made from one
//                              template share nothing;
//                            · old section names go through the registry's
//                              adapter (legacyPageSectionsToSections);
//                            · a section the editor has no kind for, one the
//                              family doesn't take or no longer offers (a
//                              banner, D2), and one whose shape the validator
//                              can't read becomes a text section holding its
//                              words, with a note (notes[]) in plain words;
//                            · the page has the template's name as its title
//                              (or `title`) and no web address yet (the
//                              founder picks one in the editor), so it never
//                              clashes with an existing page.
//                          The server validates the body again when the
//                          draft is created (lib/documents/service.js).
import { legacyPageSectionsToSections } from "../registry/legacy.js";
import { sectionType, isAllowedOn, emptyBody, newSection, validateDocument, mintSectionId, mintBlockId, isBlank } from "../registry/index.js";
import { issueClass, STRUCTURE } from "../registry/validate.js";
import { isOffered } from "../registry/sections.js";

export const TEMPLATE_FAMILIES = Object.freeze([
  Object.freeze({ family: "page", label: "Pages" }),
  Object.freeze({ family: "campaign", label: "Campaign pages" }),
  Object.freeze({ family: "journal", label: "Journal posts" }),
]);
const FAMILY_TYPES = new Set(TEMPLATE_FAMILIES.map((f) => f.family));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const parseTemplateSections = (s) => parse(s);
function parse(s) {
  if (Array.isArray(s)) return s;
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Words a section held, for the text it becomes: every string in it, tags
// taken out, in order, one paragraph each (the text section's limits kept).
const stripTags = (s) =>
  String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
function wordsOf(value, out = []) {
  if (typeof value === "string") {
    const t = stripTags(value);
    if (t && !/^(https?:|\/)/.test(t)) out.push(t.slice(0, 4000));
  } else if (Array.isArray(value)) for (const v of value) wordsOf(v, out);
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) if (k !== "id" && k !== "kind" && k !== "v") wordsOf(v, out);
  return out;
}

const NOTE_UNKNOWN = "A section of a kind the editor doesn't have became text. Check its words before you publish.";
const NOTE_NOT_SHOWN = "A banner became text, because banners don't show on this kind of page yet.";
const NOTE_UNREADABLE = "A section that couldn't be read as it was became text. Check its words before you publish.";

function asText(original, idOf) {
  const s = isObj(original) ? original : { value: original };
  const settings = isObj(s.settings) ? s.settings : s;
  const title = typeof settings.title === "string" ? settings.title : typeof settings.heading === "string" ? settings.heading : "";
  const words = wordsOf(Object.fromEntries(Object.entries(settings).filter(([k]) => k !== "title" && k !== "heading"))).slice(0, 100);
  const text = newSection("text", { id: idOf() });
  return { ...text, settings: { ...text.settings, title: stripTags(title).slice(0, 120), body: words.length || !isBlank(title) ? words : ["(This part of the template was empty.)"] } };
}

export function pageBodyFromTemplate(template, { title = null } = {}) {
  const tpl = isObj(template) ? template : {};
  const type = FAMILY_TYPES.has(tpl.family) ? tpl.family : "page";
  const used = new Set();
  const fresh = (mint) => () => {
    let id = mint();
    while (used.has(id)) id = mint();
    used.add(id);
    return id;
  };
  const sectionId = fresh(mintSectionId);
  const blockId = fresh(mintBlockId);
  const notes = [];
  const raw = parse(tpl.sections);
  const sections = legacyPageSectionsToSections(raw).map((s, i) => {
    const d = isObj(s) ? sectionType(s.kind) : null;
    if (!d || !isAllowedOn(s.kind, type)) {
      notes.push(NOTE_UNKNOWN);
      return asText(raw.filter(Boolean)[i] ?? s, sectionId);
    }
    if (!isOffered(s.kind, type)) {
      notes.push(NOTE_NOT_SHOWN);
      return asText(s, sectionId);
    }
    return { ...s, id: sectionId(), blocks: Array.isArray(s.blocks) ? s.blocks.map((b) => (isObj(b) ? { ...b, id: blockId() } : b)) : [] };
  });
  const base = emptyBody(type);
  const name = typeof title === "string" && title.trim() ? title.trim() : String(tpl.name ?? "").trim();
  let body = { ...base, meta: { ...base.meta, title: name.slice(0, 120) }, sections };
  // re-validated: a section whose shape the validator can't read becomes text
  const r = validateDocument(body, { mode: "draft" });
  const broken = new Set(r.issues.filter((i) => issueClass(i) === STRUCTURE && i.sectionId).map((i) => i.sectionId));
  if (broken.size) {
    body = { ...body, sections: body.sections.map((s) => (broken.has(s.id) ? (notes.push(NOTE_UNREADABLE), asText(s, sectionId)) : s)) };
  }
  return { type, body, notes };
}

// Phase 2 line 6 (6a), "Insert into a page": a saved template's sections for
// a page that already exists, of document type `type` (page, campaign,
// journal, home, …). pageBodyFromTemplate makes them (fresh section and block
// ids, unknown or unreadable parts as text, with notes); a section the page's
// type doesn't take or no longer offers is left out, with a note, and every
// id already on the page (`taken`) is minted again.
//   -> { sections, notes }
// Which of `candidates` can go after the page's `existing` sections: the
// server's saveDraft refuses (422, TOO_MANY_OF_KIND or POSITION_NOT_ALLOWED)
// a draft over a kind's maxPerDocument (one hero) or with a kind away from
// its allowed place (the hero first), so those are left out, with words.
// Today no template can carry such a kind (the hero is home-only and
// templates are pages, campaigns and journal posts); the guard keeps it so.
export function placeableSections(candidates, existing = []) {
  const have = Array.isArray(existing) ? existing.filter(isObj) : [];
  const count = new Map();
  for (const s of have) count.set(s.kind, (count.get(s.kind) || 0) + 1);
  const kept = [];
  const skipped = new Map(); // label -> its maxPerDocument, or "place"
  for (const s of Array.isArray(candidates) ? candidates : []) {
    const decl = sectionType(s?.kind);
    const n = count.get(s.kind) || 0;
    const at = have.length + kept.length; // where it would go
    const fits = !decl?.allowedPositions || decl.allowedPositions.some((p) => (p === "first" ? at === 0 : p === "last" ? false : p === at));
    const over = decl?.maxPerDocument != null && n >= decl.maxPerDocument;
    if (over || !fits) {
      skipped.set(decl?.label || s.kind, over ? decl.maxPerDocument : "place");
      continue;
    }
    count.set(s.kind, n + 1);
    kept.push(s);
  }
  const notes = [...skipped].map(([label, why]) =>
    why === "place" ? `A ${label} can only go at the top of the page, so the template's ${label} was left out.` : `The page can have only ${why === 1 ? "one" : why} ${label} and already has ${why === 1 ? "it" : "them"}, so the template's ${label} was left out.`,
  );
  return { kept, notes };
}

// existing: the page's sections now (the template's go after them; their ids
// are taken too).
export function sectionsFromTemplate(template, type, { taken = [], existing = [] } = {}) {
  const { body, notes } = pageBodyFromTemplate(template);
  const used = new Set(Array.isArray(taken) ? taken : []);
  for (const s of Array.isArray(existing) ? existing : []) if (isObj(s) && typeof s.id === "string") used.add(s.id);
  let left = 0;
  const allowed = [];
  for (const s of Array.isArray(body?.sections) ? body.sections : []) {
    if (!isObj(s) || !isAllowedOn(s.kind, type) || !isOffered(s.kind, type)) left++;
    else allowed.push(s);
  }
  const { kept, notes: limits } = placeableSections(allowed, existing);
  const out = kept.map((s) => {
    let id = s.id;
    while (used.has(id)) id = mintSectionId();
    used.add(id);
    return { ...s, id };
  });
  if (left) notes.push(`${left} part${left === 1 ? "" : "s"} of the template can't go on this page, so ${left === 1 ? "it was" : "they were"} left out.`);
  notes.push(...limits);
  return { sections: out, notes };
}
