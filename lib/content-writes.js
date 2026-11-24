// Programmatic content draft writer (Documents-only). SERVER-ONLY.
//
// Single door for programmatic writers (experiment adopt, AI insight apply,
// theme kit hero preset). Converts flat shapes through
// lib/registry/legacy.js and saves as drafts of doc_home or doc_announcement
// through lib/documents/service.js (validated, revision-checked, checkpointed).
// Never publishes and never touches legacy tables.
import { getCmsMode, StoreUsesDocumentsError, CmsModeUnavailableError, refusalAnswer } from "./cms-mode.js";
import { audit } from "./platform/audit.js";
import { NotFoundError, isValidationError, validationBody } from "./cms/issues.js";
import { sectionType, defaultSettings, emptyBody } from "./registry/index.js";
import { legacyHeroToSettings, legacyHeroToSection, legacyAnnouncementToSettings, legacyHomeSectionsToSections } from "./registry/legacy.js";
import { slog } from "./log.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ORDER = ["hero", "home_sections", "announcement"];

export const __contentWriteTestHooks = { beforeWrite: null };

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

async function readDoc(docs, id) {
  try {
    return await docs.getDocument(id);
  } catch (e) {
    if (e instanceof NotFoundError || e?.status === 404) return null;
    throw e;
  }
}

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
    else sections = [legacyHeroToSection(value), ...sections];
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

const DOCUMENTS_API = ["getDocument", "createDocument", "saveDraft"];
const hasDocumentsApi = (d) => isObj(d) && DOCUMENTS_API.every((f) => typeof d[f] === "function");

export async function writeContentDrafts(changes, { actor = null, source = "unknown", documents = null } = {}) {
  const keys = plan(changes);
  if (!keys.length) return { mode: null, written: [] };
  const mode = await getCmsMode(); // 500 STORE_MODE_INVALID on any other mode
  if (hasDocumentsApi(documents)) return writeDocuments(keys, changes, { actor, source, documents });
  throw new StoreUsesDocumentsError(mode);
}

export function writeRefusalBody(e) {
  const body = { error: String(e?.message || "").slice(0, 300), ...(e?.code ? { code: e.code } : {}) };
  if (e?.current !== undefined) body.current = e.current;
  if (e?.extra?.current !== undefined) body.current = e.extra.current;
  if (e?.saved) body.saved = e.saved;
  return body;
}

export function contentWriteAnswer(e, { route = "unknown" } = {}) {
  if (!e) return null;
  if (isValidationError(e)) return { status: 422, body: validationBody(e.issues, e.saved ? { saved: e.saved } : {}) };
  if (e instanceof CmsModeUnavailableError) return refusalAnswer(e, { route });
  if (e.expose && e.status >= 400 && e.status < 500) return { status: e.status, body: writeRefusalBody(e) };
  return null;
}
