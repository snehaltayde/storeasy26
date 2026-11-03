// P2-REG (DOC-03, DOC-04, DOC-05): validateDocument, the one check for a
// document body in documents mode. Pure and edge-safe.
//
//   validateDocument(body, { mode: "draft" | "publish", live?, documentId? })
//     -> { ok, issues, body }
//
// issues   every problem found, never just the first, each made by
//          lib/cms/issues.js issue():
//            { documentId, sectionId, blockId, field, code, severity, message, autoFix }
//          severity:
//            "error"       structure (unknown kind, unknown field, bad shape,
//                          bad ids, composition guards, words sanitizing would
//                          lose) and broken limits or rules (TOO_LONG,
//                          LINK_NOT_STOREFRONT, …), in every mode
//            "incomplete"  a required field is empty, in draft mode. The same
//                          issue is an "error" in publish mode (DOC-05)
//            "warning"     never blocks
//          No message names a position ("Section 2 (…)"): the editor works out
//          where an issue is from its sectionId and field.
// ok       true when there is no "error" (an incomplete draft is ok)
// body     the body to store: the input with HTML sanitized where sanitizing
//          loses nothing, and old sections upgraded by their `migrate` steps.
//          Nothing is stripped or cut: an unknown field or an over-long title
//          is reported and stays exactly as sent. A caller must not store a
//          body whose `ok` is false.
// live     the live version's body, for checks that compare with what
//          shoppers see now (the design document's colour pairs, TOK-02)
//
// issue() in lib/cms/issues.js accepts only "error" and "warning", and that
// file belongs to the legacy path, so an incomplete issue is made as a
// warning and then marked "incomplete". errorIssues() still finds only errors.
import { issue } from "../cms/issues.js";
import { documentType, sectionType, allowedKinds, protectedKinds, SCHEMA_VERSION } from "./index.js";
import { checkSetting, cap, SLUG_RE } from "./settings.js";
import { upgradeBody, SECTION_ID_RE } from "./body.js";
import { isBlank } from "./text.js";

export const INCOMPLETE = "incomplete";

// Each issue's class (P2-FIX4): "structure" (wrong shape, unknown names,
// composition guards, and every sanitizer refusal), "invalid" (a broken limit
// or rule), "incomplete" or "warning". It is what a caller must use to decide
// whether a problem may ever be let through (publish's inherited rule: a
// "structure" issue never is). It rides on each issue as a NON-enumerable
// property, so the DOC-04 shape (Object.keys, JSON sent to the editor) is
// unchanged; a copy made with spread drops it, so read it with issueClass()
// before copying. An issue made elsewhere has no class: null.
export const STRUCTURE = "structure";
function withClass(i, cls) {
  Object.defineProperty(i, "cls", { value: cls, enumerable: false, writable: false, configurable: false });
  return i;
}
export const issueClass = (i) => (i && typeof i === "object" && typeof i.cls === "string" ? i.cls : null);

const BODY_KEYS = ["schema", "type", "meta", "settings", "sections"];
const SECTION_KEYS = ["id", "kind", "v", "enabled", "settings", "mobile", "show", "bindings", "blocks"];
const META_KEYS = ["slug", "title", "description", "enabled", "effective_at", "window_start", "window_end", "redirect_from"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A lookup in a plain table that ignores names inherited from Object.prototype
// ("constructor", "toString", "__proto__"), so they read as unknown.
const own = (table, k) => (typeof k === "string" && Object.hasOwn(table, k) ? table[k] : undefined);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const unknownMessage = (key, where) => `"${key}" isn't a setting of ${where}, so this can't be saved. Nothing was removed: delete it or correct the name.`;

function severityOf(cls, mode) {
  if (cls === "warning") return "warning";
  if (cls === "incomplete") return mode === "publish" ? "error" : INCOMPLETE;
  return "error";
}

const count = (n, one, many) => (n === 1 ? `one ${one}` : `${n} ${many}`);

function checkSettingsObject(declared, value, where, report) {
  if (value === undefined && !declared.length) return value;
  const v = value === undefined ? {} : value;
  if (!isObj(v)) {
    report("settings", "INVALID_SHAPE", `The settings of ${where} couldn't be read. Reload the page and try again.`, "structure");
    return value;
  }
  const keys = new Set(declared.map((s) => s.key));
  for (const k of Object.keys(v)) if (!keys.has(k)) report(k, "UNKNOWN_FIELD", unknownMessage(k, where), "structure");
  const out = { ...v };
  for (const s of declared) {
    const cleaned = checkSetting(s, v[s.key], s.key, report);
    if (Object.hasOwn(v, s.key)) out[s.key] = cleaned;
  }
  return value === undefined ? value : out;
}

function checkMeta(meta, type, report) {
  if (!type.route) {
    if (meta === undefined) return;
    if (!isObj(meta)) return report("meta", "INVALID_SHAPE", `The details of ${type.noun} couldn't be read. Reload the page and try again.`, "structure");
    for (const k of Object.keys(meta)) report(`meta.${k}`, "UNKNOWN_FIELD", unknownMessage(k, type.noun), "structure");
    return;
  }
  if (!isObj(meta)) return report("meta", "INVALID_SHAPE", `The address and title of ${type.noun} couldn't be read. Reload the page and try again.`, "structure");
  for (const k of Object.keys(meta)) if (!META_KEYS.includes(k)) report(`meta.${k}`, "UNKNOWN_FIELD", unknownMessage(k, type.noun), "structure");
  const { slug, title, description } = meta;
  if (slug == null || (typeof slug === "string" && isBlank(slug))) report("meta.slug", "REQUIRED", `${cap(type.noun)} has no web address yet. Add one.`, "incomplete");
  else if (typeof slug !== "string" || !SLUG_RE.test(slug))
    report("meta.slug", "SLUG_INVALID", "The web address can use lower-case letters, digits and hyphens only, and must start with a letter or digit.", "invalid");
  if (title == null || (typeof title === "string" && isBlank(title))) report("meta.title", "REQUIRED", `${cap(type.noun)} has no title yet. Add one.`, "incomplete");
  else if (typeof title !== "string") report("meta.title", "INVALID_VALUE", "The title must be text.", "structure");
  else if (title.length > 120) report("meta.title", "TOO_LONG", `The title is too long (${title.length} characters, the limit is 120).`, "invalid");
  if (description != null) {
    if (typeof description !== "string") report("meta.description", "INVALID_VALUE", "The description must be text.", "structure");
    else if (description.length > 300) report("meta.description", "TOO_LONG", `The description is too long (${description.length} characters, the limit is 300).`, "invalid");
  }
  if (meta.enabled != null && typeof meta.enabled !== "boolean") report("meta.enabled", "INVALID_VALUE", "Whether the page is shown must be on or off.", "structure");
  const when = {};
  for (const k of ["effective_at", "window_start", "window_end"]) {
    const v = meta[k];
    if (v == null) continue;
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isNaN(t)) report(`meta.${k}`, "INVALID_VALUE", "This date couldn't be read. Pick it again.", "invalid");
    else when[k] = t;
  }
  if (when.window_start != null && when.window_end != null && when.window_end <= when.window_start)
    report("meta.window_end", "WINDOW_INVALID", "The end date is before the start date. Pick an end date after the start.", "invalid");
  if (meta.redirect_from != null) {
    if (!Array.isArray(meta.redirect_from)) report("meta.redirect_from", "INVALID_VALUE", "The old addresses couldn't be read. Reload the page and try again.", "structure");
    else
      meta.redirect_from.forEach((r, j) => {
        if (typeof r !== "string" || !SLUG_RE.test(r)) report(`meta.redirect_from.${j}`, "SLUG_INVALID", `An old address isn't valid ("${String(r).slice(0, 60)}"). Remove it.`, "invalid");
      });
  }
}

function positionWords(positions) {
  return positions.map((p) => (p === "first" ? "at the top" : p === "last" ? "at the bottom" : `in place ${p + 1}`)).join(" or ");
}

function checkSections(doc, type, push) {
  const at = (sectionId) => (field, code, message, cls) => push({ sectionId, field }, code, message, cls);
  const top = at(null);
  if (!type.sections) {
    if (doc.sections !== undefined && !(Array.isArray(doc.sections) && doc.sections.length === 0))
      top("sections", "SECTIONS_NOT_ALLOWED", `${cap(type.noun)} doesn't hold sections. Remove them.`, "structure");
    return doc.sections;
  }
  if (!Array.isArray(doc.sections)) {
    top("sections", "INVALID_SHAPE", "The sections couldn't be read. Reload the page and try again.", "structure");
    return doc.sections;
  }
  const list = doc.sections;
  const allowed = allowedKinds(type.type);
  const seen = new Set();
  const perKind = new Map();
  const out = list.map((s, i) => {
    if (!isObj(s)) {
      top(`sections.${i}`, "INVALID_SHAPE", "A section couldn't be read. Reload the page and try again.", "structure");
      return s;
    }
    const sid = typeof s.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : null;
    const report = at(sid);
    if (!sid) report("id", "SECTION_ID_INVALID", "A section has no usable id. Reload the page and try again.", "structure");
    else if (seen.has(sid)) report("id", "SECTION_ID_DUPLICATE", "Two sections share one id. Reload the page and try again.", "structure");
    if (sid) seen.add(sid);
    const decl = sectionType(s.kind);
    if (!decl) {
      report("kind", "UNKNOWN_KIND", `A section is of a kind we don't know (${JSON.stringify(String(s.kind ?? "")).slice(0, 62)}), so it can't be saved. Remove it.`, "structure");
      return s;
    }
    const label = lower(decl.label);
    for (const k of Object.keys(s)) if (!SECTION_KEYS.includes(k)) report(k, "UNKNOWN_FIELD", unknownMessage(k, `a ${label} section`), "structure");
    if (!allowed.includes(decl.kind)) report("kind", "KIND_NOT_ALLOWED", `A ${label} section can't go on ${type.noun}. Remove it.`, "structure");
    if (!Number.isInteger(s.v) || s.v < 1 || s.v > decl.version)
      report("v", "SECTION_VERSION", `This ${label} section was saved by a version of the editor we don't know. Reload the page and try again.`, "structure");
    else if (s.v < decl.version) report("v", "SECTION_VERSION", `This ${label} section was saved by an older editor and couldn't be brought up to date. Add it again.`, "structure");
    if (s.enabled != null && typeof s.enabled !== "boolean") report("enabled", "INVALID_VALUE", "Whether this section is shown must be on or off.", "structure");
    const settings = checkSettingsObject(decl.settings, s.settings, `a ${label} section`, report);
    if (s.mobile != null) {
      if (!isObj(s.mobile)) report("mobile", "INVALID_SHAPE", "The phone settings of this section couldn't be read. Reload the page and try again.", "structure");
      else for (const k of Object.keys(s.mobile)) report(`mobile.${k}`, "UNKNOWN_FIELD", `"${k}" can't be set separately for phones on a ${label} section. Nothing was removed: delete it.`, "structure");
    }
    if (s.show != null) {
      if (!isObj(s.show)) report("show", "INVALID_SHAPE", "Where this section shows couldn't be read. Reload the page and try again.", "structure");
      else
        for (const [k, v] of Object.entries(s.show)) {
          if (k !== "mobile" && k !== "desktop") report(`show.${k}`, "UNKNOWN_FIELD", `"${k}" isn't a kind of screen. Nothing was removed: delete it.`, "structure");
          else if (typeof v !== "boolean") report(`show.${k}`, "INVALID_VALUE", "Whether this section shows on each screen must be on or off.", "structure");
        }
    }
    if (s.bindings != null) {
      if (!isObj(s.bindings)) report("bindings", "INVALID_SHAPE", "This section's catalog data couldn't be read. Reload the page and try again.", "structure");
      else
        for (const [k, b] of Object.entries(s.bindings)) {
          const declared = own(decl.bindings, k);
          if (!declared) report(`bindings.${k}`, "UNKNOWN_FIELD", unknownMessage(k, `a ${label} section`), "structure");
          else if (!isObj(b) || !declared.sources.includes(b.source))
            report(`bindings.${k}`, "BINDING_INVALID", `This ${label} section asks for catalog data it can't show. Choose its products or collections again.`, "structure");
        }
    }
    if (s.blocks != null) {
      if (!Array.isArray(s.blocks)) report("blocks", "INVALID_SHAPE", "This section's blocks couldn't be read. Reload the page and try again.", "structure");
      else if (s.blocks.length > decl.blocks.max) report("blocks", "BLOCKS_NOT_ALLOWED", `A ${label} section can't hold blocks yet. Remove them.`, "structure");
    }
    if (decl.protected && s.enabled === false) report("enabled", "PROTECTED_HIDDEN", `The ${label} can't be hidden: shoppers need it to buy.`, "structure");

    const n = (perKind.get(decl.kind) || 0) + 1;
    perKind.set(decl.kind, n);
    if (decl.maxPerDocument != null && n > decl.maxPerDocument)
      report("kind", "TOO_MANY_OF_KIND", `${cap(type.noun)} can have only ${count(decl.maxPerDocument, label, `${label} sections`)}. Remove this extra one.`, "structure");
    if (decl.allowedPositions) {
      const fits = decl.allowedPositions.some((p) => (p === "first" ? i === 0 : p === "last" ? i === list.length - 1 : p === i));
      if (!fits) report("kind", "POSITION_NOT_ALLOWED", `The ${label} can only go ${positionWords(decl.allowedPositions)} of ${type.noun}. Move it there.`, "structure");
    }

    const cleaned = settings === s.settings ? s : { ...s, settings };
    for (const r of decl.rules(cleaned) || []) report(r.field ?? null, r.code, r.message, r.cls || "invalid");
    return cleaned;
  });

  for (const pk of protectedKinds(type.type)) {
    if (!perKind.get(pk)) top("sections", "PROTECTED_MISSING", `${cap(type.noun)} needs the ${lower(sectionType(pk).label)}. Add it back, or restore the last published version.`, "structure");
  }
  if (type.maxBeforeProtected != null) {
    const p = list.findIndex((s) => isObj(s) && sectionType(s.kind)?.protected);
    if (p > type.maxBeforeProtected) {
      const what = lower(sectionType(list[p].kind).label);
      for (let i = type.maxBeforeProtected; i < p; i++) {
        const s = list[i];
        const sid = isObj(s) && typeof s.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : null;
        at(sid)(
          "kind",
          "TOO_MANY_BEFORE_PROTECTED",
          `Only ${count(type.maxBeforeProtected, "section", "sections")} can sit above the ${what}. Move this section below it.`,
          "structure",
        );
      }
    }
  }
  return out;
}

export function validateDocument(body, { mode = "draft", live = null, documentId } = {}) {
  if (mode !== "draft" && mode !== "publish") throw new Error(`validateDocument: mode must be "draft" or "publish", not ${JSON.stringify(mode)}`);
  const issues = [];
  const type = isObj(body) ? documentType(body.type) : null;
  const docId = documentId ?? (type?.singleton ? `doc_${type.type}` : null);
  const push = (where, code, message, cls) => {
    const severity = severityOf(cls, mode);
    const fields = { documentId: docId, sectionId: where.sectionId ?? null, blockId: where.blockId ?? null, field: where.field ?? null, code, message };
    const made = severity === INCOMPLETE ? { ...issue({ ...fields, severity: "warning" }), severity: INCOMPLETE } : issue({ ...fields, severity });
    issues.push(withClass(made, cls || "invalid"));
  };
  const top = (field, code, message, cls) => push({ field }, code, message, cls);
  const result = (out) => ({ ok: !issues.some((i) => i.severity === "error"), issues, body: out });

  if (!isObj(body)) {
    top(null, "INVALID_SHAPE", "This document couldn't be read. Reload the page and try again.", "structure");
    return result(body);
  }
  if (!type) {
    top("type", "UNKNOWN_TYPE", `This is a kind of document the store doesn't know (${JSON.stringify(String(body.type ?? "")).slice(0, 62)}), so it can't be saved.`, "structure");
    return result(body);
  }

  const doc = upgradeBody(body);
  for (const k of Object.keys(doc)) if (!BODY_KEYS.includes(k)) top(k, "UNKNOWN_FIELD", unknownMessage(k, type.noun), "structure");
  if (doc.schema !== SCHEMA_VERSION) top("schema", "SCHEMA_UNSUPPORTED", `${cap(type.noun)} was saved by a version of the editor we don't know. Reload the page and try again.`, "structure");
  checkMeta(doc.meta, type, top);

  const out = { ...doc };
  const settings = checkSettingsObject(type.settings, doc.settings, type.noun, top);
  if (settings !== undefined) out.settings = settings;
  const sections = checkSections(doc, type, push);
  if (sections !== undefined) out.sections = sections;

  for (const r of type.rules(out, { mode, live }) || []) push({ sectionId: r.sectionId ?? null, field: r.field ?? null }, r.code, r.message, r.cls || "invalid");
  if (mode === "publish" && !type.publishable)
    top(null, "PUBLISH_NOT_AVAILABLE", `${cap(type.noun)} is saved as a draft. Publishing it isn't available yet.`, "structure");

  return result(out);
}
