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
//                          lose) in every mode, and broken limits or rules
//                          (TOO_LONG, LINK_NOT_STOREFRONT, …) in publish mode
//                          and, in a draft, outside the cases below
//            "incomplete"  in draft mode only: a required field is empty
//                          (DOC-05), and (PV-02, see draftTolerates) a broken
//                          limit or rule inside a section, a page title or
//                          description over its limit, or a menu item's link.
//                          The same issue is an "error" in publish mode
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
import { checkSetting, cap, SLUG_RE, galleryMediaAllowed } from "./settings.js";
import { upgradeBody, SECTION_ID_RE } from "./body.js";
import { isBlank } from "./text.js";
import { SHOPIFY_OWNED_FIELDS, shopifyOwnedMessage } from "./document-types.js";

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

// P3-VALIDATE (PV-02, plan decision 9): in a DRAFT, one half-typed field
// never blocks saving the rest. These "invalid" issues are stored with the
// draft as "incomplete" (the section previews as its unfinished note, and
// publish still refuses them as errors):
//   - any "invalid" issue inside a section (a title over its limit, a button
//     link that isn't a page of the store, a collection that can't be found);
//   - a page's title or description over its length limit;
//   - a link of a menu item (header and footer).
// What stays an error in a draft (saveDraft answers 422 and stores nothing):
// every "structure" issue, and SLUG_INVALID anywhere, because the web address
// is the uniqueness key stored in documents.slug (the editor sends the last
// saved address while the field is invalid, P3-STORE). The class (cls) is
// never changed, so publish's classify() sees exactly what it saw before.
const META_LENGTH_FIELDS = new Set(["meta.title", "meta.description"]);
function draftTolerates(type, where, code, cls) {
  if (cls !== "invalid" || code === "SLUG_INVALID" || DRAFT_CAP_CODES.has(code)) return false;
  if (where.sectionId) return true;
  const field = typeof where.field === "string" ? where.field : "";
  if (META_LENGTH_FIELDS.has(field)) return code === "TOO_LONG";
  // a menu item's link: <nav_items key>.<i>.link… or <key>.<i>.children.<j>.link…
  const m = /^([a-z][a-z0-9_]*)\.\d+(?:\.children\.\d+)?\.link(?:\.|$)/.exec(field);
  return Boolean(m && type?.settings?.some((s) => s.key === m[1] && s.kind === "nav_items"));
}

const count = (n, one, many) => (n === 1 ? `one ${one}` : `${n} ${many}`);

// P3-FIX1 (PV-02, the P3-VALIDATE review): a draft tolerates a field over its
// limit, but not without bound. In draft mode these are errors (saveDraft
// answers 422 and stores nothing), not "incomplete":
//   - the body, serialized, over DRAFT_MAX_BYTES (512 KB, UTF-8);
//   - any text anywhere in it over DRAFT_MAX_TEXT (20,000 characters, after
//     sanitizing, as publish counts it); 20,000 is the largest publish limit
//     (the custom section's content), so nothing publish takes is refused;
//   - any declared list over DRAFT_LIST_FACTOR (4) times its publish maximum
//     (a menu item's sub-items too: 4 x 8).
// The over-limit "incomplete" issue for the same field is replaced by the
// error, so the founder reads one message. Publish mode is unchanged: there
// every over-limit field is already an error.
export const DRAFT_MAX_BYTES = 512 * 1024;
export const DRAFT_MAX_TEXT = 20_000;
export const DRAFT_LIST_FACTOR = 4;
const DRAFT_CAP_CODES = new Set(["DRAFT_TOO_LARGE", "TOO_LONG_TO_SAVE", "TOO_MANY_TO_SAVE"]);
const NAV_CHILDREN_MAX = 8;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function draftCaps(out, type, push) {
  let bytes = null;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  } catch {
    bytes = null;
  }
  if (bytes != null && bytes > DRAFT_MAX_BYTES) {
    push(
      { field: null },
      "DRAFT_TOO_LARGE",
      `${cap(type.noun)} is too big to save (${thousands(Math.ceil(bytes / 1024))} KB, and a draft can hold up to ${DRAFT_MAX_BYTES / 1024} KB). Nothing was saved: shorten the longest text or remove some sections.`,
      "invalid",
    );
  }
  // every string, with the path validate's own issues use for it
  const texts = (v, path, sectionId) => {
    if (typeof v === "string") {
      if (v.length > DRAFT_MAX_TEXT)
        push(
          { sectionId, field: path || null },
          "TOO_LONG_TO_SAVE",
          `This text is too long to save (${thousands(v.length)} characters, and a draft can hold up to ${thousands(DRAFT_MAX_TEXT)}). Nothing was saved: shorten it.`,
          "invalid",
        );
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => texts(x, path ? `${path}.${i}` : String(i), sectionId));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) texts(x, path ? `${path}.${k}` : k, sectionId);
  };
  const lists = (declared, value, sectionId) => {
    if (!isObj(value)) return;
    for (const d of declared) {
      const v = value[d.key];
      if (!Array.isArray(v)) continue;
      if (d.max != null && v.length > d.max * DRAFT_LIST_FACTOR) {
        push(
          { sectionId, field: d.key },
          "TOO_MANY_TO_SAVE",
          `The ${lower(d.label)} list has ${thousands(v.length)} items, too many to save (a draft can hold up to ${d.max * DRAFT_LIST_FACTOR}, and up to ${d.max} can be published). Nothing was saved: remove some.`,
          "invalid",
        );
      }
      if (d.kind === "nav_items")
        v.forEach((it, j) => {
          if (isObj(it) && Array.isArray(it.children) && it.children.length > NAV_CHILDREN_MAX * DRAFT_LIST_FACTOR)
            push(
              { sectionId, field: `${d.key}.${j}.children` },
              "TOO_MANY_TO_SAVE",
              `This menu item has ${thousands(it.children.length)} sub-items, too many to save (a draft can hold up to ${NAV_CHILDREN_MAX * DRAFT_LIST_FACTOR}, and up to ${NAV_CHILDREN_MAX} can be published). Nothing was saved: remove some.`,
              "invalid",
            );
        });
    }
  };
  for (const [k, v] of Object.entries(out)) {
    if (k === "sections") continue;
    texts(v, k === "settings" ? "" : k, null);
  }
  lists(type.settings, out.settings, null);
  if (Array.isArray(out.sections))
    out.sections.forEach((sec, i) => {
      const sid = isObj(sec) && typeof sec.id === "string" && SECTION_ID_RE.test(sec.id) ? sec.id : null;
      if (!isObj(sec)) return texts(sec, `sections.${i}`, null);
      for (const [k, v] of Object.entries(sec)) texts(v, k === "settings" ? "" : k, sid);
      const decl = sectionType(sec.kind);
      if (decl) lists(decl.settings, sec.settings, sid);
    });
}

// P4-LIVEROW (OVL-01): on product content, a key Shopify owns (price,
// handle, tags, …) is refused as SHOPIFY_OWNED, in plain words, instead of
// as an unknown field.
function unknownOrOwned(k, where, report, path = k, owned = false) {
  if (owned && Object.hasOwn(SHOPIFY_OWNED_FIELDS, k)) report(path, "SHOPIFY_OWNED", shopifyOwnedMessage(k), "structure");
  else report(path, "UNKNOWN_FIELD", unknownMessage(k, where), "structure");
}

function checkSettingsObject(declared, value, where, report, owned = false) {
  if (value === undefined && !declared.length) return value;
  const v = value === undefined ? {} : value;
  if (!isObj(v)) {
    report("settings", "INVALID_SHAPE", `The settings of ${where} couldn't be read. Reload the page and try again.`, "structure");
    return value;
  }
  const keys = new Set(declared.map((s) => s.key));
  for (const k of Object.keys(v)) if (!keys.has(k)) unknownOrOwned(k, where, report, k, owned);
  const out = { ...v };
  for (const s of declared) {
    const cleaned = checkSetting(s, v[s.key], s.key, report);
    if (Object.hasOwn(v, s.key)) out[s.key] = cleaned;
  }
  return value === undefined ? value : out;
}

function checkMeta(meta, type, report, owned = false) {
  if (!type.route) {
    if (meta === undefined) return;
    if (!isObj(meta)) return report("meta", "INVALID_SHAPE", `The details of ${type.noun} couldn't be read. Reload the page and try again.`, "structure");
    for (const k of Object.keys(meta)) unknownOrOwned(k, type.noun, report, `meta.${k}`, owned);
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
    // P3-FIX3 (TREE-05): hidden on both screens is hidden too. It is "invalid",
    // so a draft keeps it as incomplete (the founder can show it again) and
    // publish refuses it; PROTECTED_HIDDEN always blocks at publish
    // (publish.js STRUCTURE_CODES), so an unchanged live copy isn't inherited.
    else if (decl.protected && isObj(s.show) && s.show.mobile === false && s.show.desktop === false)
      report("show", "PROTECTED_HIDDEN", `The ${label} can't be hidden on both phones and computers: shoppers need it to buy. Show it on at least one.`, "invalid");

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

// P4-SEARCH (P4-LIVEROW review): what a product's modules need to reach
// shoppers.
//   - A rich text or text module shows as a heading the shopper taps to open
//     (the product page's accordion), so one with no title never shows
//     (lib/content/documents-reader.js pdpExtrasFromBody keeps only titled
//     ones). It is incomplete in a draft and an error at publish
//     (MODULE_TITLE_MISSING), so "published" never hides a module.
//   - An image-with-text module's image follows the gallery's OVL-13 allowlist
//     (galleryMediaAllowed: Shopify's image host or the store's own library):
//     a warning in a draft, an error at publish (IMAGE_HOST_NOT_ALLOWED).
// Kept here, not in the type's rules, beside the section checks they read.
const TITLED_MODULES = { rich_text: "rich text", text: "text" };
function productModuleChecks(sections, mode, push) {
  if (!Array.isArray(sections)) return;
  for (const s of sections) {
    if (!isObj(s) || typeof s.id !== "string" || !SECTION_ID_RE.test(s.id)) continue;
    const st = isObj(s.settings) ? s.settings : {};
    const what = own(TITLED_MODULES, s.kind);
    if (what && (typeof st.title !== "string" || isBlank(st.title))) {
      push(
        { sectionId: s.id, field: "title" },
        "MODULE_TITLE_MISSING",
        `This ${what} module has no title, so shoppers won't see it: on the product page a module shows as a title they tap to open. Add a title.`,
        "incomplete",
      );
    }
    if (s.kind === "image_with_text" && isObj(st.image) && typeof st.image.media === "string" && !galleryMediaAllowed(st.image.media)) {
      push(
        { sectionId: s.id, field: "image" },
        "IMAGE_HOST_NOT_ALLOWED",
        "This module's image is stored on another website, so it can't go live. Choose it from your library, or use one of Shopify's images.",
        mode === "publish" ? "invalid" : "warning",
      );
    }
  }
}

export function validateDocument(body, { mode = "draft", live = null, documentId } = {}) {
  if (mode !== "draft" && mode !== "publish") throw new Error(`validateDocument: mode must be "draft" or "publish", not ${JSON.stringify(mode)}`);
  const issues = [];
  const type = isObj(body) ? documentType(body.type) : null;
  const docId = documentId ?? (type?.singleton ? `doc_${type.type}` : null);
  const push = (where, code, message, cls) => {
    const severity = mode === "draft" && draftTolerates(type, where, code, cls || "invalid") ? INCOMPLETE : severityOf(cls, mode);
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
  const owned = type.type === "product_content";
  for (const k of Object.keys(doc)) if (!BODY_KEYS.includes(k)) unknownOrOwned(k, type.noun, top, k, owned);
  if (doc.schema !== SCHEMA_VERSION) top("schema", "SCHEMA_UNSUPPORTED", `${cap(type.noun)} was saved by a version of the editor we don't know. Reload the page and try again.`, "structure");
  checkMeta(doc.meta, type, top, owned);

  const out = { ...doc };
  const settings = checkSettingsObject(type.settings, doc.settings, type.noun, top, owned);
  if (settings !== undefined) out.settings = settings;
  const sections = checkSections(doc, type, push);
  if (sections !== undefined) out.sections = sections;

  for (const r of type.rules(out, { mode, live }) || []) push({ sectionId: r.sectionId ?? null, field: r.field ?? null }, r.code, r.message, r.cls || "invalid");
  if (type.type === "product_content") productModuleChecks(out.sections, mode, push);
  // P4-LIVEROW: product and collection content publish now (OVL-02). The
  // refusal stays for any type declared publishable: false.
  if (mode === "publish" && !type.publishable)
    top(null, "PUBLISH_NOT_AVAILABLE", `${cap(type.noun)} is saved as a draft. Publishing it isn't available yet.`, "structure");

  if (mode === "draft") {
    const before = issues.length;
    draftCaps(out, type, push);
    // one message per field: the cap's error replaces the over-limit note
    const capped = new Set(issues.slice(before).map((i) => `${i.sectionId ?? ""}|${i.field ?? ""}`));
    if (capped.size) {
      const keep = issues.filter((i, n) => n >= before || !(i.severity === INCOMPLETE && (i.code === "TOO_LONG" || i.code === "TOO_MANY") && capped.has(`${i.sectionId ?? ""}|${i.field ?? ""}`)));
      issues.length = 0;
      issues.push(...keep);
    }
  }

  return result(out);
}
