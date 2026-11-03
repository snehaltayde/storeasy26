// P2-WRITERS (DOC-02, DOC-05, DOC-07): the one door for the programmatic
// content writers. SERVER-ONLY.
//
// Four writers used to call setBlock directly and skip everything a founder's
// own save goes through: experiment adopt, AI insight apply, agency kit apply
// and the hero preset of a theme kit. They now call writeContentDrafts(), which
// reads the store's mode fresh (getCmsMode) on every call:
//
//   legacy     each block is validated (validateBlock, which also gives
//              id-less home sections durable sec_ ids: the spec 8.11 trap),
//              then written with the revision it was read at (setBlock's
//              compare-and-set). A concurrent edit is a 409 with the current
//              value, never a silent overwrite. Each write is audited and gets
//              a history entry, like a save from the editor.
//   documents  the old flat shapes go through lib/registry/legacy.js and the
//              result is saved as a DRAFT of doc_home or doc_announcement with
//              lib/documents/service.js saveDraft (validated, revision + 1,
//              checkpointed). Nothing publishes: the live list and cms_blocks
//              are never touched.
//   anything else ('migrating', an unknown value)
//              refused with 409 STORE_USES_DOCUMENTS; nothing is written.
//
// Edge: this module is reachable from the storefront (lib/experiments.js is
// imported by the home page, lib/themes/kits.js by lib/releases.js), so it
// imports nothing Node-only. The documents service is (it reaches
// lib/platform/identity.js and node:crypto), so the caller hands it in as
// opts.documents, from a Node console route or a Node-only module. Without it
// a documents store refuses (409, nothing written): fail closed, never a
// legacy write on a documents store.
//
// A mode that can't be read throws CmsModeUnavailableError (5xx), never a
// go-ahead. Known limit (MIG-03, as P2-GUARD): the mode read is a pre-check,
// a separate statement before the write.
//
// changes:
//   hero          { value, merge }  value is the old flat hero shape. merge:
//                 true lays it over the CURRENT hero (the founder's buttons,
//                 badge and image stay unless the payload names them);
//                 false replaces the hero copy (a kit), keeping only the
//                 hero image in documents mode, which the old shape can't hold.
//   home_sections list             the old home section list; replaces every
//                 section but the hero.
//   announcement  value             the old { enabled, text, href } shape;
//                 replaces the bar.
// opts: { actor, source, documents }  documents: lib/documents/service.js
//                 (getDocument, createDocument, saveDraft)
import { getCmsMode, StoreUsesDocumentsError, CmsModeUnavailableError, refusalAnswer } from "./cms-mode.js";
import { getBlockRow, setBlock, CmsConflictError } from "./cms/store.js";
import { validateBlock } from "./cms/validate.js";
import { defaultHero } from "./cms/defaults.js";
import { siteName } from "./site.js";
import { appendHistory } from "./cms/history.js";
import { audit } from "./platform/audit.js";
import { ValidationError, NotFoundError, isValidationError, validationBody } from "./cms/issues.js";
import { sectionType, defaultSettings, emptyBody } from "./registry/index.js";
import { legacyHeroToSettings, legacyHeroToSection, legacyAnnouncementToSettings, legacyHomeSectionsToSections } from "./registry/legacy.js";
import { slog } from "./log.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// as lib/documents/service.js names an actor in history (not imported: see the top)
const actorString = (actor) => (typeof actor === "string" ? actor : isObj(actor) && actor.kind ? `${actor.kind}:${actor.id ?? ""}` : null);

// The order blocks are written in: one fixed order, so a partial failure is
// always reported the same way.
const ORDER = ["hero", "home_sections", "announcement"];

// Test seam: called after every read and before the first write, so a suite
// can land a "colleague's" save in between. Never set outside tests.
export const __contentWriteTestHooks = { beforeWrite: null };

// A concurrent edit landed between our read and our write. 409, with what is
// stored now; `saved` names anything this same call already wrote.
export class ContentWriteConflictError extends Error {
  constructor({ current = null, saved = [] } = {}) {
    super(
      saved.length
        ? `Someone else changed this while it was being saved. ${saved.map(nameOf).join(" and ")} ${saved.length > 1 ? "were" : "was"} saved; the rest was not. Reload and try again.`
        : "Someone else changed this while it was being saved, so nothing was saved. Reload and try again.",
    );
    this.name = "ContentWriteConflictError";
    this.code = "CMS_CONFLICT";
    this.status = 409;
    this.expose = true;
    this.current = current;
    this.saved = saved;
  }
}

const NAMES = { hero: "The hero", home_sections: "The home page sections", announcement: "The announcement bar", doc_home: "The home page", doc_announcement: "The announcement bar" };
const nameOf = (k) => NAMES[k] || k;

function plan(changes) {
  if (!isObj(changes)) throw new TypeError("writeContentDrafts: changes must be an object");
  const keys = ORDER.filter((k) => changes[k] !== undefined && changes[k] !== null);
  const unknown = Object.keys(changes).filter((k) => !ORDER.includes(k));
  if (unknown.length) throw new TypeError(`writeContentDrafts: unknown change ${unknown.join(", ")}`);
  return keys;
}

// ---- legacy -------------------------------------------------------------------

function legacyValue(key, change, row) {
  if (key === "hero") {
    const payload = isObj(change.value) ? change.value : {};
    // the hero exactly as the editor shows it: stored value over the defaults
    return change.merge ? { ...defaultHero(siteName()), ...(isObj(row?.value) ? row.value : {}), ...payload } : payload;
  }
  return change; // home_sections: the list; announcement: the { enabled, text, href } value
}

async function writeLegacy(keys, changes, { actor, source }) {
  const reads = {};
  for (const key of keys) reads[key] = await getBlockRow(key, { strict: true });
  // validate everything first: a refused block means nothing is written
  const values = {};
  const issues = [];
  for (const key of keys) {
    const r = validateBlock(key, legacyValue(key, changes[key], reads[key]));
    issues.push(...r.issues);
    values[key] = r.value;
  }
  if (issues.some((i) => i.severity === "error")) throw new ValidationError(issues);
  if (__contentWriteTestHooks.beforeWrite) await __contentWriteTestHooks.beforeWrite({ mode: "legacy", keys });
  const saved = [];
  const by = actorString(actor);
  for (const key of keys) {
    const row = reads[key];
    let res;
    try {
      res = await setBlock(key, values[key], { expectedRevision: row ? row.revision : null });
    } catch (e) {
      if (e instanceof CmsConflictError) throw new ContentWriteConflictError({ current: e.current, saved });
      if (saved.length) e.saved = saved;
      throw e;
    }
    saved.push(key);
    slog("content_write", { mode: "legacy", block: key, source, revision: res.revision });
    await audit({ actor, action: "storefront.write", resource: `block:${key}`, diff: { source } });
    await appendHistory({ kind: "block", key, value: values[key], revision: res.revision, actor: by });
  }
  return { mode: "legacy", written: saved, issues: issues.filter((i) => i.severity !== "error") };
}

// ---- documents ------------------------------------------------------------------

async function readDoc(docs, id) {
  try {
    return await docs.getDocument(id);
  } catch (e) {
    if (e instanceof NotFoundError) return null; // never saved: created below
    throw e;
  }
}

// The hero section's settings after this change. merge keeps everything the
// payload doesn't name; replace starts from the declared defaults and keeps
// only the image (the old flat shape has no image to say otherwise).
export function heroSettingsAfter(currentSettings, payload, { merge }) {
  const cur = isObj(currentSettings) ? currentSettings : {};
  const flat = legacyHeroToSettings(payload);
  if (merge) return { ...defaultSettings(sectionType("hero")), ...cur, ...flat };
  return { ...defaultSettings(sectionType("hero")), ...flat, ...(cur.image !== undefined ? { image: cur.image } : {}) };
}

function homeBody(doc, changes) {
  const body = doc ? structuredClone(doc.body) : emptyBody("home");
  let sections = Array.isArray(body.sections) ? body.sections : [];
  let at = sections.findIndex((s) => isObj(s) && s.kind === "hero");
  if (changes.home_sections != null) {
    const hero = at >= 0 ? sections[at] : null;
    sections = [...(hero ? [hero] : []), ...legacyHomeSectionsToSections(changes.home_sections)];
    at = hero ? 0 : -1;
  }
  if (changes.hero != null) {
    const { value, merge } = changes.hero;
    if (at >= 0) sections[at] = { ...sections[at], settings: heroSettingsAfter(sections[at].settings, value, { merge: Boolean(merge) }) };
    else sections = [legacyHeroToSection(value), ...sections]; // no hero yet: the declared defaults under the payload
  }
  return { ...body, sections };
}

function announcementBody(doc, value) {
  const body = doc ? structuredClone(doc.body) : emptyBody("announcement");
  const settings = { ...emptyBody("announcement").settings, ...legacyAnnouncementToSettings(value) };
  return { ...body, settings };
}

async function saveDoc(docs, id, type, doc, body, actor) {
  if (doc) return (await docs.saveDraft({ id, revision: doc.revision, body, actor })).document;
  return (await docs.createDocument({ type, body, actor })).document;
}

async function writeDocuments(keys, changes, { actor, source, documents: docs }) {
  const targets = [];
  if (keys.includes("hero") || keys.includes("home_sections")) targets.push({ id: "doc_home", type: "home" });
  if (keys.includes("announcement")) targets.push({ id: "doc_announcement", type: "announcement" });
  const current = {};
  for (const t of targets) current[t.id] = await readDoc(docs, t.id);
  const bodies = {};
  for (const t of targets) bodies[t.id] = t.type === "home" ? homeBody(current[t.id], changes) : announcementBody(current[t.id], changes.announcement);
  if (__contentWriteTestHooks.beforeWrite) await __contentWriteTestHooks.beforeWrite({ mode: "documents", keys });
  const saved = [];
  const out = {};
  for (const t of targets) {
    try {
      out[t.id] = await saveDoc(docs, t.id, t.type, current[t.id], bodies[t.id], actor);
    } catch (e) {
      if (saved.length) e.saved = saved;
      throw e;
    }
    saved.push(t.id);
    slog("content_write", { mode: "documents", document: t.id, source, revision: out[t.id].revision });
    await audit({ actor, action: "storefront.write", resource: `document:${t.id}`, diff: { source, revision: out[t.id].revision } });
  }
  return { mode: "documents", written: keys, documents: saved, revisions: Object.fromEntries(saved.map((id) => [id, out[id].revision])) };
}

// ---- the door -----------------------------------------------------------------------

const DOCUMENTS_API = ["getDocument", "createDocument", "saveDraft"];
const hasDocumentsApi = (d) => isObj(d) && DOCUMENTS_API.every((f) => typeof d[f] === "function");

export async function writeContentDrafts(changes, { actor = null, source = "unknown", documents = null } = {}) {
  const keys = plan(changes);
  if (!keys.length) return { mode: null, written: [] };
  const mode = await getCmsMode();
  if (mode === "legacy") return writeLegacy(keys, changes, { actor, source });
  // a caller that can't reach the documents service refuses (fail closed)
  if (mode === "documents" && hasDocumentsApi(documents)) return writeDocuments(keys, changes, { actor, source, documents });
  throw new StoreUsesDocumentsError(mode);
}

// For routes that answer with their own catch-all.
// writeRefusalBody(e): the body for a deliberate refusal this door raised
// (e.expose, a 4xx status): its words, code, the current value or document
// when there is one, and what this call already saved.
export function writeRefusalBody(e) {
  const body = { error: String(e?.message || "").slice(0, 300), ...(e?.code ? { code: e.code } : {}) };
  if (e?.current !== undefined) body.current = e.current;
  if (e?.extra?.current !== undefined) body.current = e.extra.current;
  if (e?.saved) body.saved = e.saved;
  return body;
}

// contentWriteAnswer(e): the whole answer for an error this door raised, or
// null when it is someone else's (the route goes on to its own answer).
// Validation is 422 with every issue; a deliberate refusal keeps its status,
// code and words; a mode that can't be read is the same 5xx P2-GUARD gives.
export function contentWriteAnswer(e, { route = "unknown" } = {}) {
  if (!e) return null;
  if (isValidationError(e)) return { status: 422, body: validationBody(e.issues, e.saved ? { saved: e.saved } : {}) };
  if (e instanceof CmsModeUnavailableError) return refusalAnswer(e, { route });
  if (e.expose && e.status >= 400 && e.status < 500) return { status: e.status, body: writeRefusalBody(e) };
  return null;
}
