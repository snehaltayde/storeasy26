// P2-REG (DOC-03): the document registry, the one source of truth for section
// kinds and document types in documents mode. Pure: no React, no Next, no
// node: imports, so the edge storefront, Node console routes and tests all
// import it.
//
// The legacy registry was retired with the legacy CMS; lib/registry/legacy.js
// keeps its shape adapters.
//
//   defineSection(decl)          check, freeze and register a section kind
//   defineDocumentType(decl)     the same for a document type
//   sectionType(kind)            the declaration, or null
//   documentType(type)           the declaration, or null
//   allowedKinds(type)           the section kinds a document type accepts,
//                                from each section's own documentTypes
//   singletonTypes()             every singleton, for emptyList (plan decision 11)
//   newSection(kind, {id})       a section made from the declared defaults
//   emptyBody(type)              a document body made from the declared defaults
//   controlsFor(kind)            the editor controls, from the settings
//   refsOf(section)              the references and media a section holds
//   checkRegistry()              the contract check: [] when every declaration
//                                keeps its own promises
//
// Validation, ids and hashing, adapters and fixtures live in their own files
// and are re-exported here, as do (P3-VALIDATE) where/fieldAnchor, the plain
// words and field anchor of an issue (./issue-words.js), and starterSection,
// the section the editor adds (./starter.js).
import { defineSetting, controlOf, refsOfSetting, checkSetting } from "./settings.js";
import { SECTION_DECLARATIONS } from "./sections.js";
import { DOCUMENT_TYPE_DECLARATIONS } from "./document-types.js";
import { validateDocument } from "./validate.js";
import { mintSectionId } from "./body.js";
import { isSource, getSource } from "./sources.js";

export const SCHEMA_VERSION = 1;

const KIND_RE = /^[a-z][a-z0-9_]{0,40}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SECTIONS = new Map();
const TYPES = new Map();

function checkSettings(list, where) {
  if (list == null) return Object.freeze([]);
  if (!Array.isArray(list)) throw new Error(`${where}: settings must be a list`);
  const seen = new Set();
  return Object.freeze(
    list.map((s) => {
      const d = defineSetting(s, where);
      if (seen.has(d.key)) throw new Error(`${where}: setting "${d.key}" is declared twice`);
      seen.add(d.key);
      return d;
    }),
  );
}

const optionalInt = (v, name, where, min = 0) => {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < min) throw new Error(`${where}: ${name} must be a whole number of ${min} or more`);
  return v;
};

// P5-SOURCES (TREE-01): a section's bindings, checked against the source table.
// Each is { sources: [names], args: [keys of its settings] }; a declaration
// with a singular `source` is read as `sources: [source]`. A source not in
// lib/registry/sources.js is refused here.
function checkBindings(bindings, settings, where) {
  if (bindings == null) return Object.freeze({});
  if (!isObj(bindings)) throw new Error(`${where}: bindings must be { <field>: { sources, args } }`);
  const keys = new Set(settings.map((s) => s.key));
  const out = {};
  for (const [field, b] of Object.entries(bindings)) {
    const at = `${where}: binding "${field}"`;
    if (!isObj(b)) throw new Error(`${at} must be { sources, args }`);
    // P5-BLOCKS (after the P5-SOURCES review): one or the other, never both
    // (both used to keep `sources` and drop `source` without a word)
    if (b.sources != null && b.source != null) throw new Error(`${at} gives both source and sources: give sources only`);
    const sources = b.sources ?? (b.source != null ? [b.source] : null);
    if (!Array.isArray(sources) || !sources.length || !sources.every((x) => typeof x === "string" && x)) throw new Error(`${at} needs sources: a list of source names`);
    const args = b.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string" && keys.has(a))) throw new Error(`${at}: args must name settings of this section`);
    for (const x of sources) if (!isSource(x)) throw new Error(`${at} names the source "${x}", which is not in the source table`);
    // P5-BLOCKS: a source reads its arguments by their declared names (the
    // bundle sources read "bundle" and "bundles"), so a binding passes each
    // one (the limit has a default, lib/cms/section-data.js)
    for (const x of sources) {
      for (const need of getSource(x).args) if (need !== "limit" && !args.includes(need)) throw new Error(`${at}: the source "${x}" reads "${need}", so args must name a setting "${need}"`);
    }
    out[field] = Object.freeze({ sources: Object.freeze([...sources]), args: Object.freeze([...args]) });
  }
  return Object.freeze(out);
}

export function defineSection(decl) {
  if (!isObj(decl) || !KIND_RE.test(String(decl.kind || ""))) throw new Error("defineSection: a section needs a kind of lower-case letters, digits and _");
  const where = `section "${decl.kind}"`;
  if (SECTIONS.has(decl.kind)) throw new Error(`${where} is already registered`);
  const version = optionalInt(decl.version ?? 1, "version", where, 1);
  if (!Array.isArray(decl.documentTypes) || !decl.documentTypes.every((t) => typeof t === "string")) throw new Error(`${where}: documentTypes must be a list of document types`);
  if (decl.allowedPositions != null && !(Array.isArray(decl.allowedPositions) && decl.allowedPositions.every((p) => p === "first" || p === "last" || Number.isInteger(p)))) {
    throw new Error(`${where}: allowedPositions must list "first", "last" or whole numbers`);
  }
  const migrate = decl.migrate ?? {};
  if (!isObj(migrate)) throw new Error(`${where}: migrate must be { <from version>: function }`);
  for (const [from, fn] of Object.entries(migrate)) {
    const n = Number(from);
    if (!Number.isInteger(n) || n < 1 || n >= version || typeof fn !== "function") throw new Error(`${where}: migrate step ${from} must be a function from a version below ${version}`);
  }
  for (const fn of ["rules", "refs"]) if (decl[fn] != null && typeof decl[fn] !== "function") throw new Error(`${where}: ${fn} must be a function`);
  const blocks = decl.blocks ?? { allowed: [], max: 0 };
  if (!isObj(blocks) || !Array.isArray(blocks.allowed) || !Number.isInteger(blocks.max)) throw new Error(`${where}: blocks must be { allowed: [], max }`);
  const settings = checkSettings(decl.settings, where);
  const d = Object.freeze({
    kind: decl.kind,
    version,
    label: String(decl.label || decl.kind),
    documentTypes: Object.freeze([...decl.documentTypes]),
    settings,
    bindings: checkBindings(decl.bindings, settings, where),
    blocks: Object.freeze({ allowed: Object.freeze([...blocks.allowed]), max: blocks.max }),
    maxPerDocument: optionalInt(decl.maxPerDocument, "maxPerDocument", where, 1),
    allowedPositions: decl.allowedPositions ? Object.freeze([...decl.allowedPositions]) : null,
    minItems: optionalInt(decl.minItems, "minItems", where, 1),
    rules: decl.rules || (() => []),
    refs: decl.refs || (() => []),
    migrate: Object.freeze({ ...migrate }),
    placeholder: String(decl.placeholder || ""),
    protected: !!decl.protected,
    startsIncomplete: !!decl.startsIncomplete,
  });
  SECTIONS.set(d.kind, d);
  return d;
}

// For tests that register a throwaway kind: takes it out again.
export function removeSection(kind) {
  return SECTIONS.delete(kind);
}

export function defineDocumentType(decl) {
  if (!isObj(decl) || !KIND_RE.test(String(decl.type || ""))) throw new Error("defineDocumentType: a document type needs a type of lower-case letters, digits and _");
  const where = `document type "${decl.type}"`;
  if (TYPES.has(decl.type)) throw new Error(`${where} is already registered`);
  if (decl.singleton && decl.route) throw new Error(`${where}: a singleton has no route`);
  if (decl.singleton && !Number.isInteger(decl.sinceManifest)) throw new Error(`${where}: a singleton needs sinceManifest`);
  if (decl.rules != null && typeof decl.rules !== "function") throw new Error(`${where}: rules must be a function`);
  const d = Object.freeze({
    type: decl.type,
    label: String(decl.label || decl.type),
    noun: String(decl.noun || `this ${decl.label || decl.type}`.toLowerCase()),
    singleton: !!decl.singleton,
    sinceManifest: decl.singleton ? decl.sinceManifest : null,
    route: !!decl.route,
    publishable: decl.publishable !== false,
    editable: decl.editable !== false,
    system: !!decl.system,
    index: decl.index ?? null,
    settings: checkSettings(decl.settings, where),
    sections: !!decl.sections,
    maxBeforeProtected: optionalInt(decl.maxBeforeProtected, "maxBeforeProtected", where, 0),
    rules: decl.rules || (() => []),
  });
  TYPES.set(d.type, d);
  return d;
}

export const sectionType = (kind) => (typeof kind === "string" && SECTIONS.get(kind)) || null;
export const documentType = (type) => (typeof type === "string" && TYPES.get(type)) || null;
export const sectionKinds = () => [...SECTIONS.keys()];
export const documentTypeNames = () => [...TYPES.keys()];

export function allowedKinds(type) {
  const t = documentType(type);
  if (!t || !t.sections) return [];
  return [...SECTIONS.values()].filter((s) => s.documentTypes.includes(type)).map((s) => s.kind);
}
export const isAllowedOn = (kind, type) => allowedKinds(type).includes(kind);

// The protected kinds a document type must hold exactly one of.
export const protectedKinds = (type) => allowedKinds(type).filter((k) => SECTIONS.get(k).protected);

// Every registered singleton, in registration order: what emptyList(m, …)
// lists as an explicit null.
export const singletonTypes = () => [...TYPES.values()].filter((t) => t.singleton).map((t) => t.type);
// Singletons a release list with manifest m must carry.
export const singletonTypesAt = (m) => [...TYPES.values()].filter((t) => t.singleton && t.sinceManifest <= m).map((t) => t.type);

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const defaultSettings = (declaration) => Object.fromEntries(declaration.settings.filter((s) => s.default !== undefined).map((s) => [s.key, clone(s.default)]));

export function newSection(kind, { id } = {}) {
  const d = sectionType(kind);
  if (!d) throw new Error(`newSection: "${kind}" is not a registered section kind`);
  return { id: id ?? mintSectionId(), kind, v: d.version, enabled: true, settings: defaultSettings(d), blocks: [] };
}

export function emptyBody(type) {
  const t = documentType(type);
  if (!t) throw new Error(`emptyBody: "${type}" is not a registered document type`);
  const body = { schema: SCHEMA_VERSION, type, meta: t.route ? { slug: "", title: "", description: "", enabled: true, effective_at: null, window_start: null, window_end: null, redirect_from: [] } : {} };
  if (t.settings.length) body.settings = defaultSettings(t);
  if (t.sections) body.sections = protectedKinds(type).map((k) => newSection(k));
  return body;
}

export function controlsFor(kind) {
  const d = sectionType(kind);
  if (!d) throw new Error(`controlsFor: "${kind}" is not a registered section kind`);
  return d.settings.map(controlOf);
}
export function controlsForDocument(type) {
  const t = documentType(type);
  if (!t) throw new Error(`controlsForDocument: "${type}" is not a registered document type`);
  return t.settings.map(controlOf);
}

// [{ field, ref: "link"|"media"|"collection"|"product", … }]
export function refsOf(section) {
  const d = sectionType(section?.kind);
  if (!d) return [];
  const settings = isObj(section.settings) ? section.settings : {};
  const out = [];
  for (const s of d.settings) out.push(...refsOfSetting(s, settings[s.key]));
  for (const extra of d.refs(section) || []) out.push(extra);
  return out;
}

// ---- the contract check (DOC-03, AU-04) -------------------------------------------
//
// For each section kind:
//   1. every declared default passes its own setting's checks (nothing but
//      REQUIRED, and only when the kind says it starts incomplete);
//   2. a new section, in a document of each type it names, validates with no
//      issue at all in publish mode, or, when it starts incomplete, with
//      nothing but "incomplete" issues in draft mode;
//   3. it names at least one registered document type that takes sections;
//   4. (P5-SOURCES) every source its bindings name is still in the source
//      table (a removeSource after registration is caught here).
// For each document type, its empty body validates with no error in draft mode.
export function checkSectionContract(kind) {
  const d = sectionType(kind);
  if (!d) return [`"${kind}" is not registered`];
  const problems = [];
  for (const s of d.settings) {
    if (s.default === undefined) continue;
    checkSetting(s, clone(s.default), s.key, (field, code, message, cls) => {
      if (code === "REQUIRED" && d.startsIncomplete) return;
      problems.push(`${kind}: the default of "${s.key}" fails its own rules (${code}${cls === "warning" ? ", a warning" : ""}: ${message})`);
    });
  }
  const types = d.documentTypes.filter((t) => documentType(t)?.sections);
  for (const [field, b] of Object.entries(d.bindings)) {
    for (const x of b.sources) if (!isSource(x)) problems.push(`${kind}: binding "${field}" names the source "${x}", which is not in the source table`);
  }
  if (!types.length) problems.push(`${kind}: none of its document types (${d.documentTypes.join(", ")}) is registered and takes sections`);
  for (const type of types) {
    const body = emptyBody(type);
    if (documentType(type).route) Object.assign(body.meta, { slug: "contract", title: "Contract" });
    const section = newSection(kind, { id: "sec_contract" });
    // a protected kind replaces the one emptyBody added; anything else goes first
    body.sections = d.protected ? [section] : d.allowedPositions?.includes("last") ? [...body.sections, section] : [section, ...body.sections];
    const mode = d.startsIncomplete ? "draft" : "publish";
    const { issues } = validateDocument(body, { mode });
    for (const i of issues) {
      if (d.startsIncomplete && i.severity === "incomplete") continue;
      problems.push(`${kind} on ${type}: a new section is not clean in ${mode} mode (${i.code} on ${i.field}: ${i.message})`);
    }
  }
  return problems;
}

export function checkRegistry() {
  const problems = [];
  for (const kind of SECTIONS.keys()) problems.push(...checkSectionContract(kind));
  for (const t of TYPES.values()) {
    for (const k of SECTIONS.values()) for (const named of k.documentTypes) if (!TYPES.has(named)) problems.push(`${k.kind}: names an unregistered document type "${named}"`);
    if (!t.editable) continue;
    const { issues } = validateDocument(emptyBody(t.type), { mode: "draft" });
    for (const i of issues) if (i.severity === "error") problems.push(`${t.type}: the empty document is not valid in draft mode (${i.code} on ${i.field}: ${i.message})`);
  }
  return [...new Set(problems)];
}

for (const decl of DOCUMENT_TYPE_DECLARATIONS) defineDocumentType(decl);
for (const decl of SECTION_DECLARATIONS) defineSection(decl);

export { validateDocument, INCOMPLETE } from "./validate.js";
export { ensureIds, stripIds, documentHash, upgradeBody, stableStringify, SECTION_ID_RE, BLOCK_ID_RE, mintSectionId, mintBlockId } from "./body.js";
export { isStorefrontHref, linkHref, LINK_TYPES, PAGE_FAMILIES, SETTING_KINDS } from "./settings.js";
export { sanitize, lostBySanitizing, isBlank, isBlankHtml } from "./text.js";
export { LEGACY_KIND_NAMES } from "./sections.js";
export { HOME_EMPTY_MESSAGE } from "./document-types.js";
export {
  legacyHeroToSettings,
  settingsToLegacyHero,
  legacyHeroToSection,
  legacyAnnouncementToSettings,
  legacyHomeSectionsToSections,
  legacyPageSectionsToSections,
} from "./legacy.js";
export { SOURCES, getSource, isSource, sourceNames, defineSource, removeSource } from "./sources.js";
export { worstCase, fixtureDocument, LEGACY_HERO_FIXTURES } from "./fixtures.js";
export { where, fieldAnchor, anchorFor } from "./issue-words.js";
export { starterSection, pickRailCollection } from "./starter.js";
