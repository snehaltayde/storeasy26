// P3-INSPECTOR (ED-12, AU-02, TOK-03, AU-01, ED-04): the inspector's logic.
// Pure: no React, no DOM (applyFocus takes the document as a parameter), no
// store, no fetch. Edge-safe: it imports only lib/registry, lib/brand.js, and
// (P5-EDITOR) lib/commerce/bundle-words.js and lib/format.js, which are pure.
// The forms in this folder (SettingsForm, controls, MenuControl, DesignForm,
// RichTextField) take everything as props and keep their logic here, so node
// tests drive it without a browser.
//
//   CONTROL_OF_KIND             setting kind (lib/registry/settings.js) ->
//                               the control that edits it
//   controlKindOf(kind)         the control name, or null for an unknown kind
//   inspectorCoverage()         [] when every registered setting kind has a
//                               control and every section kind and document
//                               type has a form; otherwise the problems
//   formOf({ kind } | { type }) which form edits a section kind or a
//                               document type, and its fields
//   fieldsOf(settings, owner)   field descriptors: { key, path, anchor,
//                               control, label, setting }
//   metaFieldsOf(type)          the address, title, dates… of a route document
//   anchorsOf(field, value, ctx) every element id the control for `field`
//                               renders for `value` (its "known" anchors)
//   placeIssues(issues, known)  [{ anchor, issue }]: each issue at
//                               fieldAnchor(issue, { known }), the closest
//                               field the form renders (AU-02)
//   notesAt(placed, anchor)     the issues placed at one anchor
//   menu.*                      the menu control's edits (add, reorder, edit,
//                               remove), ported from NavigationEditor
//   design.*                    the design form's edits (brand tokens, look)
//   linkTargets, railChoices…   the link and collection pickers' options
//   focusAnchor / applyFocus    ED-04: turn a focusRequest {path, offset}
//                               into the field to focus and put the caret
//   bundleView, bundleList…     P5-EDITOR (COM-01, COM-02): the bundle
//                               picker's words and edits
//
// Words: every label is shown exactly as the registry declares it ("FAQ",
// never "faq"; the P3-VALIDATE review). Field ids are fieldAnchor ids
// (lib/registry/issue-words.js): "f-<sectionId|doc>-<path, . as ->".
import { SETTING_KINDS, sectionType, documentType, sectionKinds, documentTypeNames, singletonTypes, fieldAnchor, anchorFor, pickRailCollection, linkHref, PAGE_FAMILIES } from "../../../../lib/registry/index.js";
import { controlOf, BUNDLE_LIST_MAX } from "../../../../lib/registry/settings.js";
import { stateLine, reasonSentence, overlapLine, BUNDLES_HREF, BUNDLES_PLACE } from "../../../../lib/commerce/bundle-words.js";
import { formatMoney } from "../../../../lib/format.js";
import { DEFAULT_BRAND, KIT_SURFACES, RADIUS_STEPS, TYPE_SCALES, BUTTON_SHAPES, SECTION_SPACING, validateBrand } from "../../../../lib/brand.js";

export { linkHref };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (table, k) => (typeof k === "string" && Object.hasOwn(table, k) ? table[k] : undefined);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---- controls ------------------------------------------------------------------

// One entry per kind in SETTING_KINDS. A kind added to the registry without an
// entry here fails inspectorCoverage() and the inspector suite.
export const CONTROL_OF_KIND = Object.freeze({
  text: "text",
  number: "number",
  boolean: "toggle",
  choice: "select",
  rich_text: "rich_text",
  paragraphs: "paragraphs",
  qa_list: "qa_list",
  link: "link",
  cta: "button",
  image: "image",
  collection: "collection",
  product: "product",
  collection_list: "collections",
  product_list: "products",
  nav_items: "menu",
  // P5-EDITOR: a bundle by its id, and a grid's ordered list of them
  bundle: "bundle",
  bundle_list: "bundle_list",
  brand: "brand",
  theme: "theme",
  // a system document's generated list: shown, never edited
  entries: "system",
});

// The controls a route document's details use (they are not settings).
export const META_CONTROLS = Object.freeze(["address", "datetime", "address_list"]);
export const CONTROL_NAMES = Object.freeze([...new Set([...Object.values(CONTROL_OF_KIND), ...META_CONTROLS])]);

export const controlKindOf = (kind) => own(CONTROL_OF_KIND, kind) ?? null;

// ---- forms -----------------------------------------------------------------------

// What a type's form can't do yet, in plain words (ED-12; plan section 4).
export const WAITS = Object.freeze({
  cart: "The cart suggestions can be edited here, but who may change them (the cart permission) waits for the owner's ruling before stores move to this editor.",
  product_content: "Product content is saved as a draft. Publishing it, and editing it per product, waits for the product content work (OVL-02).",
});

// A section kind or document type -> its form.
//   form   "settings"   the declared settings, one control each
//          "menu"       header and footer: the menu mode, items and layout
//          "design"     doc_design: brand tokens and the look (DesignForm)
//          "protected"  a commerce module Shopify owns (no settings)
//          "sections"   a document whose content is only its section list
//                       (the tree edits it; the inspector edits each section)
//          "page"       a route document: its details, then its sections
//          "system"     made by the store, never edited (the journal index)
export function formOf(target) {
  if (isObj(target) && typeof target.kind === "string") {
    const d = sectionType(target.kind);
    if (!d) return null;
    return {
      of: "section",
      kind: d.kind,
      label: d.label,
      form: d.protected ? "protected" : "settings",
      placeholder: d.placeholder,
      fields: fieldsOf(d.settings, target.sectionId ?? null),
    };
  }
  if (isObj(target) && typeof target.type === "string") {
    const t = documentType(target.type);
    if (!t) return null;
    const form = t.system || !t.editable ? "system" : t.type === "design" ? "design" : t.settings.some((s) => s.kind === "nav_items") ? "menu" : t.settings.length ? "settings" : t.route ? "page" : "sections";
    return {
      of: "document",
      type: t.type,
      label: t.label,
      form,
      meta: t.route ? metaFieldsOf(t.type) : [],
      fields: fieldsOf(t.settings, null),
      sections: t.sections,
      waits: own(WAITS, t.type) ?? null,
    };
  }
  return null;
}

// Field descriptors for a list of declared settings.
export function fieldsOf(settings, sectionId = null) {
  return (settings || []).map((s) => ({
    key: s.key,
    path: s.key,
    anchor: anchorFor(sectionId, s.key),
    control: controlKindOf(s.kind),
    label: s.label,
    setting: controlOf(s),
  }));
}

// A route document's details (validate.js checkMeta), in the editor's words
// (the same as lib/registry/issue-words.js META_WORDS).
const META = [
  { key: "title", control: "text", label: "Title", setting: { max: 120 }, required: true },
  { key: "slug", control: "address", label: "Web address", required: true },
  { key: "description", control: "text", label: "Description", setting: { max: 300 }, multiline: true },
  { key: "enabled", control: "toggle", label: "Shown" },
  { key: "effective_at", control: "datetime", label: "Start date" },
  { key: "window_start", control: "datetime", label: "Start date" },
  { key: "window_end", control: "datetime", label: "End date" },
  { key: "redirect_from", control: "address_list", label: "Old addresses" },
];
// effective_at and window_start share the words "Start date"; the form says
// which one is which in its hint.
const META_HINTS = {
  effective_at: "When this page's current wording takes effect (for policies).",
  window_start: "Shown from this date. Leave empty to show it straight away.",
  window_end: "Hidden after this date. Leave empty to keep it up.",
  slug: "Lower-case letters, digits and hyphens.",
  redirect_from: "Earlier web addresses of this page. Shoppers who use them are sent here.",
};
export function metaFieldsOf(type) {
  const t = documentType(type);
  if (!t?.route) return [];
  return META.map((m) => ({
    key: m.key,
    path: `meta.${m.key}`,
    anchor: anchorFor(null, `meta.${m.key}`),
    control: m.control,
    label: m.label,
    multiline: !!m.multiline,
    setting: { key: m.key, label: m.label, required: !!m.required, ...(m.setting || {}), ...(META_HINTS[m.key] ? { help: META_HINTS[m.key] } : {}) },
  }));
}

// [] when the inspector covers the registry. Each problem is a sentence.
// `kinds` and `controls` are the registry's setting kinds and this file's
// map; a test passes others to prove an unmapped kind is reported.
export function inspectorCoverage({ kinds = SETTING_KINDS, controls = CONTROL_OF_KIND } = {}) {
  const problems = [];
  for (const kind of Object.keys(kinds)) if (!own(controls, kind)) problems.push(`setting kind "${kind}" has no control`);
  for (const kind of Object.keys(controls)) if (!Object.hasOwn(kinds, kind)) problems.push(`the control map names "${kind}", which is not a registered setting kind`);
  for (const kind of sectionKinds()) {
    const f = formOf({ kind });
    if (!f) problems.push(`section kind "${kind}" has no form`);
    else for (const field of f.fields) if (!field.control) problems.push(`section kind "${kind}": setting "${field.key}" has no control`);
  }
  for (const type of documentTypeNames()) {
    const f = formOf({ type });
    if (!f) problems.push(`document type "${type}" has no form`);
    else for (const field of f.fields) if (!field.control) problems.push(`document type "${type}": setting "${field.key}" has no control`);
  }
  for (const type of singletonTypes()) if (!formOf({ type })) problems.push(`singleton "${type}" has no form`);
  return problems;
}

// ---- choice words -----------------------------------------------------------------

// The words a choice's options are shown with, by "<type or kind>.<key>".
// Taken from today's screens (SurfaceTemplatesCard, NavigationEditor).
const CHOICE_WORDS = {
  "header.mode": { auto: "Automatic: every collection, A to Z", custom: "Custom menu" },
  "footer.mode": { auto: "Automatic: your top 5 collections", custom: "Custom menu" },
  "header.template": { standard: "Standard: logo on the left", centered: "Centered: logo in the middle" },
  "footer.template": { columns: "Columns: link groups", minimal: "Minimal: one band" },
  "product_layout.template": { classic: "Classic: two columns", editorial: "Editorial: story-led" },
  "collection_layout.template": { standard: "Standard: filter bar", sidebar: "Sidebar: filter rail" },
  "image_with_text.image_side": { left: "Image on the left", right: "Image on the right" },
};
export function choiceWords(owner, key, option) {
  const words = own(CHOICE_WORDS, `${owner}.${key}`);
  return own(words || {}, option) ?? cap(String(option).replace(/_/g, " "));
}

// ---- anchors and issues ------------------------------------------------------------

// The id of a field path under one owner (a section id, or null for the
// document itself).
export const idOf = (owner, path) => anchorFor(owner ?? null, path);
// The id of the element that holds the notes for an anchor.
export const notesId = (anchor) => `${anchor}--notes`;

// The link paths a link control renders for a value: the link itself, plus
// the part that says where it goes.
function linkPaths(path, v) {
  const out = [path];
  if (!isObj(v)) return out;
  if (v.type === "url") out.push(`${path}.href`);
  else if (v.type === "collection" || v.type === "product") out.push(`${path}.handle`);
  else if (v.type === "page") out.push(`${path}.family`, `${path}.slug`);
  return out;
}

// Every field path the control for `field` renders for `value`. The ids are
// these paths as anchors: anchorsOf(...) = pathsOf(...).map(idOf).
export function pathsOf(field, value) {
  const p = field.path;
  const list = (v) => (Array.isArray(v) ? v : []);
  switch (field.control) {
    case "button": {
      const v = isObj(value) ? value : null;
      return v ? [p, `${p}.label`, ...linkPaths(`${p}.link`, v.link)] : [p];
    }
    case "link":
      return linkPaths(p, value);
    case "image":
      return [p, `${p}.media`, `${p}.alt`];
    case "paragraphs":
    case "collections":
    case "products":
    case "address_list":
    case "bundle_list":
      return [p, ...list(value).map((_, j) => `${p}.${j}`)];
    case "qa_list":
      return [p, ...list(value).flatMap((_, j) => [`${p}.${j}`, `${p}.${j}.q`, `${p}.${j}.a`])];
    case "menu":
      return [
        p,
        ...list(value).flatMap((it, j) => {
          const at = `${p}.${j}`;
          const kids = isObj(it) && Array.isArray(it.children) ? it.children : [];
          return [
            at,
            `${at}.label`,
            ...linkPaths(`${at}.link`, isObj(it) ? it.link : null),
            ...(kids.length ? [`${at}.children`] : []),
            ...kids.flatMap((c, k) => [`${at}.children.${k}`, `${at}.children.${k}.label`, ...linkPaths(`${at}.children.${k}.link`, isObj(c) ? c.link : null)]),
          ];
        }),
      ];
    case "brand":
      return [p, ...BRAND_FIELDS.map((b) => `${p}.${b.key}`)];
    default:
      return [p];
  }
}
export const anchorsOf = (field, value, owner = null) => pathsOf(field, value).map((path) => idOf(owner, path));

// The issues that belong to one owner: a section's (by its id) or the
// document's own (no section).
export const issuesOf = (issues, sectionId = null) => (Array.isArray(issues) ? issues : []).filter((i) => isObj(i) && (i.sectionId ?? null) === (sectionId ?? null));

// Each issue at the closest anchor the form renders. `known` is a Set of the
// anchors the form renders. An issue whose own field isn't rendered (a
// section's kind, an unknown setting) lands at its top-level anchor, which
// the form then renders as a note of its own (orphanAnchors).
export function placeIssues(issues, known) {
  return (Array.isArray(issues) ? issues : []).filter(isObj).map((issue) => ({ anchor: fieldAnchor(issue, { known }), issue }));
}
export const notesAt = (placed, anchor) => (Array.isArray(placed) ? placed : []).filter((p) => p.anchor === anchor).map((p) => p.issue);
export const orphanAnchors = (placed, known) => [...new Set((placed || []).map((p) => p.anchor).filter((a) => !known.has(a)))];

// How a note looks: an error blocks, "incomplete" needs finishing, a warning
// is advice.
export const noteTone = (issue) => (issue?.severity === "error" ? "danger" : issue?.severity === "incomplete" ? "warning" : "muted");
export const blocks = (notes) => (notes || []).some((i) => i?.severity === "error");

// ---- values --------------------------------------------------------------------------

// Set one path inside a settings object (or a body), returning a new object.
// Paths are validate.js's: "title", "primary.link.href", "items.2.q",
// "meta.title". Array steps are numbers.
export function setAt(root, path, value) {
  const parts = String(path).split(".");
  const step = (node, i) => {
    const k = parts[i];
    const isIndex = /^\d+$/.test(k);
    const base = Array.isArray(node) ? [...node] : isObj(node) ? { ...node } : isIndex ? [] : {};
    if (i === parts.length - 1) {
      if (value === undefined) {
        if (Array.isArray(base)) base.splice(Number(k), 1);
        else delete base[k];
      } else base[isIndex && Array.isArray(base) ? Number(k) : k] = value;
      return base;
    }
    const key = isIndex && Array.isArray(base) ? Number(k) : k;
    base[key] = step(base[key], i + 1);
    return base;
  };
  return step(root, 0);
}
export function getAt(root, path) {
  let node = root;
  for (const k of String(path).split(".")) {
    if (node == null) return undefined;
    node = Array.isArray(node) ? node[Number(k)] : node[k];
  }
  return node;
}

// A number input's text -> the stored value (null when empty). A value that
// isn't a whole number is kept as typed, so the founder sees the note.
export function numberFrom(text) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

// A stored ISO date <-> a datetime-local input's text, in the founder's time.
export function dateInputOf(iso) {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}
export function dateFromInput(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
}

// Move one item of a list by d places; the same list when it can't move.
export function moveIn(list, i, d) {
  const j = i + d;
  if (!Array.isArray(list) || i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const c = [...list];
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}
export const removeAt = (list, i) => (Array.isArray(list) ? list.filter((_, j) => j !== i) : list);

// The counter under a text field: "48/120". Over the limit it says so; the
// text stays as typed (the registry never cuts it).
export function counterOf(text, setting) {
  const n = typeof text === "string" ? text.length : 0;
  const max = setting?.max;
  if (max == null) return null;
  return n > max ? `${n}/${max} characters, ${n - max} over the limit` : `${n}/${max} characters`;
}

// ---- links and pickers ------------------------------------------------------------

export const LINK_KIND_WORDS = Object.freeze({
  collection: "A collection",
  product: "A product",
  page: "One of your pages",
  url: "An address on your store",
});
export const PAGE_FAMILY_WORDS = Object.freeze({ page: "Page (/policies/…)", campaign: "Campaign page (/campaigns/…)", journal: "Journal post (/journal/…)" });
export const PAGE_FAMILY_KEYS = Object.freeze(Object.keys(PAGE_FAMILIES));

// The link a founder made by picking a kind and a target. A kind with no
// target yet is not a link: the control keeps the kind in its own state and
// sends nothing until a target is picked (so autosave never stores a link
// that points nowhere).
export function linkFrom(kind, target) {
  if (kind === "url") return { type: "url", href: String(target ?? "") };
  if (kind === "collection" || kind === "product") {
    if (!isObj(target) || !target.handle) return null;
    return target.id ? { type: kind, handle: target.handle, id: target.id } : { type: kind, handle: target.handle };
  }
  if (kind === "page") {
    if (!isObj(target) || !target.slug) return null;
    const out = { type: "page", slug: target.slug, family: own(PAGE_FAMILIES, target.family) ? target.family : "page" };
    if (typeof target.document === "string" && target.document) out.document = target.document;
    return out;
  }
  return null;
}
// A page link's target from a web name and a kind of page. The document id is
// looked up again in the editor's pages every time, so a link never keeps the id
// of a page with another web name or kind (P3-INSPECTOR fix round 1).
export function pageLinkTarget(pages, slug, family) {
  const s = String(slug ?? "").trim();
  const f = own(PAGE_FAMILIES, family) ? family : "page";
  const known = Array.isArray(pages) ? pages.find((p) => isObj(p) && p.slug === s && (p.family || "page") === f) : null;
  return typeof known?.document === "string" && known.document ? { slug: s, family: f, document: known.document } : { slug: s, family: f };
}
// What a link shows as, in words ("Collection: Summer sale").
export function linkWords(link, context = {}) {
  if (!isObj(link)) return "No link";
  if (link.type === "collection") return `Collection: ${titleOf(context.collections, link.handle) ?? link.handle ?? ""}`;
  if (link.type === "product") return `Product: ${titleOf(context.products, link.handle) ?? link.handle ?? ""}`;
  return linkHref(link) ?? "A link we can't read";
}
const titleOf = (list, handle) => (Array.isArray(list) ? list.find((c) => isObj(c) && c.handle === handle)?.title : null) ?? null;

// The available count of a catalog collection row: a real count or null.
// product_count never stands in for it (P3-FIX1, the P3-VALIDATE review).
export function availableOf(c) {
  const v = isObj(c) ? (c.available_count ?? c.availableProducts ?? null) : null;
  return v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
}

// A collection picker's options, from the catalog rows the editor passes in:
// [{ handle, id, title, available }], the current value kept even when the
// catalog no longer lists it.
export function collectionChoices(collections, current = null) {
  const rows = (Array.isArray(collections) ? collections : []).filter((c) => isObj(c) && typeof c.handle === "string" && c.handle);
  const out = rows.map((c) => ({ handle: c.handle, id: typeof c.id === "string" ? c.id : null, title: typeof c.title === "string" && c.title ? c.title : c.handle, available: availableOf(c), missing: false }));
  const h = isObj(current) ? current.handle : null;
  if (typeof h === "string" && h && !out.some((c) => c.handle === h)) out.unshift({ handle: h, id: current.id ?? null, title: h, available: null, missing: true });
  return out;
}
export function choiceLabel(c) {
  if (c.missing) return `${c.title} (not in your catalog now)`;
  return c.available == null ? c.title : `${c.title} (${c.available} available)`;
}

// The collection an empty product rail suggests. pickRailCollection gets the
// real available count of each row (available_count), never product_count in
// its place: a row with no count is "unknown", not "full".
export function railSuggestion(collections, minItems = 1) {
  const rows = (Array.isArray(collections) ? collections : [])
    .filter((c) => isObj(c) && typeof c.handle === "string")
    .map((c) => ({ handle: c.handle, ...(typeof c.id === "string" ? { id: c.id } : {}), available_count: availableOf(c), product_count: c.product_count ?? null, title: c.title ?? c.handle }));
  return pickRailCollection(rows, minItems);
}

// ---- bundles (P5-EDITOR: COM-01, COM-02) -------------------------------------------
//
// The bundle picker (BundleControl.js) reads the rows of GET
// /api/admin/refs?type=bundle (lib/admin/refs.js bundleItem: { id, slug,
// title, state, reasons, enabled, bundle_price, saving, currency,
// overlapsWith, missing? }), which come from the same bounded read the blocks
// use, so a chip says what the preview shows. The editor hands them in as
// context.bundles = { status: "loading" | "ready" | "failed", items,
// pending? }.
//
// P5-FIX2 (the P5-EDITOR review): `pending` lists the picked ids the editor
// has not had an answer for yet (bundlesWithPending: not in the list and not
// answered by an ids= read). Such an id reads "Checking this bundle…", never
// "deleted": only an id the server was asked about, and that is still not in
// the list, is a deleted bundle.
//
// What a shopper sees follows the blocks' own rule
// (components/sections/BundleCardSection.js isShown / savesNothing, which
// this file can't import: it is a server component). A bundle that saves
// nothing is hidden whatever its state says (OQ-B), and gets the no-saving
// words, unless it is turned off or deleted (those keep their own). The
// inspector suite checks this rule against the blocks' for every state.
// Every state sentence is lib/commerce/bundle-words.js stateLine.

export const BUNDLE_WORDS = Object.freeze({
  cantSee: "You can't see bundles here.",
  duplicate: "This bundle is already in the grid.",
  askOwner: "Ask an owner to create bundles.",
  checking: "Checking this bundle…",
  none: "No bundle picked yet.",
  noMatch: "No bundles match that search.",
  noBundles: "You have no bundles yet.",
  full: (max) => `A grid shows at most ${max} bundles.`,
  // a turned-off draft whose check fails: never offered as ready to turn on
  // (the P5-BUNDLEREAD review)
  offNotReady: (said) => `This bundle is turned off, so shoppers don't see it. It can't be turned on yet: ${said}. Fix it in ${BUNDLES_PLACE}, or remove it.`,
  // OQ-C: inline create turns the bundle on at once
  liveNow: (slug) =>
    `The bundle is saved and turned on now: its discount works in the cart and its page /bundles/${slug} opens right away, even if you don't publish. It shows on your home page after you publish.`,
});
export { BUNDLES_HREF, BUNDLES_PLACE };

// The chip on a bundle, by the state a founder should read (bundleView).
export const BUNDLE_CHIPS = Object.freeze({
  available: { tone: "success", words: "Showing" },
  sold_out: { tone: "warning", words: "Sold out" },
  not_ready: { tone: "warning", words: "Not ready" },
  no_saving: { tone: "danger", words: "Hidden: no saving" },
  disabled: { tone: "neutral", words: "Turned off" },
  missing: { tone: "danger", words: "Deleted" },
});

const SHOWN = new Set(["available", "sold_out", "not_ready"]);
const reasonsOf = (b) => (isObj(b) && Array.isArray(b.reasons) ? b.reasons : []);
export const bundleSavesNothing = (b) => reasonsOf(b).some((r) => r?.kind === "no_saving");
// The blocks' rule: a bundle card shows (and a grid keeps its cell) only for
// these states, and never when it saves nothing.
export const bundleShows = (b) => isObj(b) && SHOWN.has(b.state) && !bundleSavesNothing(b);
// The state whose words the founder reads: the no-saving words for any
// hidden bundle that saves nothing, unless it is turned off or deleted.
export function bundleWordsState(b) {
  if (!isObj(b) || typeof b.state !== "string" || !Object.hasOwn(BUNDLE_CHIPS, b.state)) return "missing";
  if (b.state !== "disabled" && b.state !== "missing" && bundleSavesNothing(b)) return "no_saving";
  return b.state;
}

const reasonText = (r, currency) => reasonSentence(r, { currency }) || (typeof r?.words === "string" ? r.words : "");

// What the picker shows for one picked bundle id.
//   entry      the refs row for that id (undefined: not read yet)
//   status     context.bundles.status
//   pending    context.bundles.pending: ids still being read (P5-FIX2)
// -> { id, title, chip | null, line, overlap | null, canReplace }
// `line` may name "Catalog > Bundles"; the control makes that a link.
export function bundleView(id, entry, { status = "ready", pending = [] } = {}) {
  const base = { id: typeof id === "string" ? id : null, title: null, chip: null, line: "", overlap: null, canReplace: true, price: null };
  if (status === "failed") return { ...base, line: BUNDLE_WORDS.cantSee, canReplace: false };
  if (!isObj(entry)) {
    const waiting = Array.isArray(pending) && pending.includes(base.id);
    return status === "ready" && base.id && !waiting ? { ...base, chip: BUNDLE_CHIPS.missing, line: stateLine("missing") } : { ...base, line: BUNDLE_WORDS.checking };
  }
  const currency = entry.currency ?? undefined;
  const state = bundleWordsState(entry);
  const reasons = reasonsOf(entry);
  const title = typeof entry.title === "string" && entry.title ? entry.title : null;
  const price = entry.bundle_price != null && state !== "missing" ? formatMoney(entry.bundle_price, currency) || null : null;
  let line = stateLine(state, reasons, { currency });
  if (state === "disabled" && reasons.length) {
    const said = [...new Set(reasons.map((r) => reasonText(r, currency)).filter(Boolean))].join("; ");
    if (said) line = BUNDLE_WORDS.offNotReady(said);
  }
  const chip = state === "disabled" && reasons.length ? { tone: "neutral", words: "Turned off, not ready" } : BUNDLE_CHIPS[state];
  const overlap = bundleShows(entry) && Array.isArray(entry.overlapsWith) && entry.overlapsWith.length ? overlapLine() : null;
  return { ...base, title, price, chip, line, overlap };
}

// A line split around "Catalog > Bundles", so that part can be a link.
export function linkParts(line) {
  const s = String(line ?? "");
  const out = [];
  let at = 0;
  for (let i = s.indexOf(BUNDLES_PLACE); i >= 0; i = s.indexOf(BUNDLES_PLACE, at)) {
    if (i > at) out.push({ text: s.slice(at, i) });
    out.push({ text: BUNDLES_PLACE, href: BUNDLES_HREF });
    at = i + BUNDLES_PLACE.length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

// The picker's options: the bundles the editor read (or a search's answer),
// filtered by the typed words. Each says its title, price (formatMoney with
// the bundle's own currency) and chip; one already picked is marked `picked`
// (picking it again rewrites it as { id }; a grid refuses it).
export function bundleOptions(items, q = "", picked = []) {
  const words = String(q ?? "").trim().toLowerCase();
  const taken = new Set(picked);
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter((b) => isObj(b) && typeof b.id === "string" && b.state !== "missing" && !b.missing && !seen.has(b.id) && seen.add(b.id))
    .filter((b) => !words || String(b.title ?? "").toLowerCase().includes(words))
    .map((b) => {
      const v = bundleView(b.id, b);
      return { id: b.id, title: v.title || b.id, price: v.price, chip: v.chip, picked: taken.has(b.id), label: [v.title || b.id, v.price, v.chip?.words].filter(Boolean).join(" · ") };
    });
}

// One bundle picked: the value is { id } and nothing else (a version body never
// holds a title, price or stock). It replaces whatever was there, an old
// { id, title } included.
export const pickBundle = (id) => (typeof id === "string" && id ? { id } : null);

const idOfChoice = (x) => (isObj(x) && typeof x.id === "string" ? x.id : null);
// The bundles of a grid, in order. Each edit returns { list, error }: the
// list unchanged and a sentence when it is refused.
export const bundleList = {
  ids: (list) => (Array.isArray(list) ? list : []).map(idOfChoice),
  add(list, id, max = BUNDLE_LIST_MAX) {
    const cur = Array.isArray(list) ? list : [];
    if (!pickBundle(id)) return { list: cur, error: null };
    if (bundleList.ids(cur).includes(id)) return { list: cur, error: BUNDLE_WORDS.duplicate };
    if (cur.length >= max) return { list: cur, error: BUNDLE_WORDS.full(max) };
    return { list: [...cur, pickBundle(id)], error: null };
  },
  // pick again for one row (an unreadable or deleted one)
  replace(list, j, id) {
    const cur = Array.isArray(list) ? list : [];
    if (!pickBundle(id) || j < 0 || j >= cur.length) return { list: cur, error: null };
    if (bundleList.ids(cur).some((x, k) => k !== j && x === id)) return { list: cur, error: BUNDLE_WORDS.duplicate };
    return { list: cur.map((x, k) => (k === j ? pickBundle(id) : x)), error: null };
  },
  move: (list, j, d) => ({ list: moveIn(Array.isArray(list) ? list : [], j, d), error: null }),
  remove: (list, j) => ({ list: removeAt(Array.isArray(list) ? list : [], j), error: null }),
};

// P5-FIX2: the editor's bundles with `pending`: the picked ids (in order)
// that are neither in the list nor answered by an ids= read yet
// (bundles.answered). While the list itself is loading every id is pending
// anyway; a failed read has none (it says "You can't see bundles here.").
export function bundlesWithPending(bundles, picked = []) {
  const b = isObj(bundles) ? bundles : { status: "loading", items: [] };
  const items = Array.isArray(b.items) ? b.items : [];
  const answered = Array.isArray(b.answered) ? b.answered : [];
  const ids = (Array.isArray(picked) ? picked : []).filter((id) => typeof id === "string" && id);
  const pending = b.status === "ready" ? ids.filter((id) => !items.some((x) => x?.id === id) && !answered.includes(id)) : [];
  return { ...b, items, pending };
}

// P5-FIX2: a grid row (or a card's value) stored in an older shape, such as
// { id, title }: it can be picked again in place (bundleList.replace with its
// own id), which writes { id } and keeps its position.
// The most bundles a grid setting takes (the registry's own default).
export const bundleGridMax = (setting) => (Number.isInteger(setting?.max) ? setting.max : BUNDLE_LIST_MAX);

export const isOldBundleChoice = (x) => isObj(x) && typeof x.id === "string" && x.id !== "" && Object.keys(x).some((k) => k !== "id");

// Every bundle id a document's sections pick (bundle and bundle_list
// settings), in order, once each: the editor reads these by ids= when its
// first page of bundles doesn't hold them.
export function pickedBundleIds(body) {
  const out = [];
  const add = (v) => {
    const id = idOfChoice(v);
    if (id && !out.includes(id)) out.push(id);
  };
  const sections = isObj(body) && Array.isArray(body.sections) ? body.sections : [];
  for (const s of sections) {
    const decl = isObj(s) ? sectionType(s.kind) : null;
    if (!decl || !isObj(s.settings)) continue;
    for (const st of decl.settings) {
      const v = s.settings[st.key];
      if (st.kind === "bundle") add(v);
      else if (st.kind === "bundle_list" && Array.isArray(v)) v.forEach(add);
    }
  }
  return out;
}

// The page a new bundle will most likely get: its name in lower-case ASCII
// letters and digits with hyphens (lib/bundles.js createBundle may add "-2"
// when that is taken; the Dialog says the page as the name gives it).
export function bundleSlugGuess(title) {
  const s = String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // lib/bundles.js slugWithSuffix(slugBase(title), 1): at most 61 characters
  return (s || "bundle").slice(0, 61).replace(/-+$/g, "") || "bundle";
}

// ---- the menu (ported from components/admin/cms/NavigationEditor.js) -----------
//
// Behaviour kept from the legacy screen: two modes (Automatic, Custom menu);
// up to 12 items, each with up to 8 sub-items one level deep; add, edit,
// move up and down, and remove (an item goes with its sub-items). Changed on
// purpose: links are typed (a collection, a product, one of your pages or an
// address on the store, never another site), switching to Automatic keeps the
// items (the registry warns they aren't shown) instead of throwing them away
// on save, and a custom menu with no items is a menu with no items, as the
// documents reader renders it.
export const MENU_LIMITS = Object.freeze({ items: 12, children: 8 });
const blankItem = () => ({ label: "", link: null });
const cleanItem = (it) => {
  if (!isObj(it)) return it;
  if (Array.isArray(it.children) && it.children.length === 0) {
    const { children: _gone, ...rest } = it;
    return rest;
  }
  return it;
};
export const menu = {
  add(items) {
    const list = Array.isArray(items) ? items : [];
    return list.length >= MENU_LIMITS.items ? list : [...list, blankItem()];
  },
  addChild(items, i) {
    const list = Array.isArray(items) ? items : [];
    const it = list[i];
    if (!isObj(it)) return list;
    const kids = Array.isArray(it.children) ? it.children : [];
    if (kids.length >= MENU_LIMITS.children) return list;
    return list.map((x, j) => (j === i ? { ...x, children: [...kids, blankItem()] } : x));
  },
  // at: [i] for an item, [i, j] for sub-item j of item i
  edit(items, at, patch) {
    const list = Array.isArray(items) ? items : [];
    const [i, j] = at;
    return list.map((x, n) => {
      if (n !== i || !isObj(x)) return x;
      if (j == null) return cleanItem({ ...x, ...patch });
      const kids = Array.isArray(x.children) ? x.children : [];
      return { ...x, children: kids.map((c, k) => (k === j ? { ...c, ...patch } : c)) };
    });
  },
  move(items, at, d) {
    const list = Array.isArray(items) ? items : [];
    const [i, j] = at;
    if (j == null) return moveIn(list, i, d);
    return list.map((x, n) => (n === i && isObj(x) && Array.isArray(x.children) ? { ...x, children: moveIn(x.children, j, d) } : x));
  },
  remove(items, at) {
    const list = Array.isArray(items) ? items : [];
    const [i, j] = at;
    if (j == null) return removeAt(list, i);
    return list.map((x, n) => (n === i && isObj(x) && Array.isArray(x.children) ? cleanItem({ ...x, children: removeAt(x.children, j) }) : x));
  },
  // What the menu card says above the rows.
  view(settings, type) {
    const s = isObj(settings) ? settings : {};
    const items = Array.isArray(s.items) ? s.items : [];
    const auto = s.mode !== "custom";
    return {
      auto,
      items,
      count: `${items.length} of ${MENU_LIMITS.items} items`,
      canAdd: items.length < MENU_LIMITS.items,
      autoText:
        type === "footer"
          ? "The footer's Shop column lists your top 5 collections from the catalog."
          : "The header lists every collection in your catalog, A to Z. New collections appear on their own.",
      keptNote: auto && items.length ? "These items are kept, but shoppers don't see them while the menu is automatic. Switch to Custom menu to use them." : null,
      emptyNote: !auto && items.length === 0 ? "This custom menu has no items, so shoppers see no menu here. Add an item, or switch to Automatic." : null,
      childNote: type === "footer" ? "The footer has no dropdowns: sub-items show under their parent." : "Sub-items show as a dropdown under their parent, one level deep.",
    };
  },
};

// ---- the design form (doc_design, TOK-03) ------------------------------------------

// The brand tokens a founder sets, in the words of today's brand screen.
export const BRAND_FIELDS = Object.freeze([
  { key: "accent", label: "Accent colour", kind: "colour", help: "One colour; the lighter and darker shades come from it." },
  { key: "background", label: "Background colour", kind: "colour" },
  { key: "foreground", label: "Text colour", kind: "colour", help: "Text must stay easy to read on your background. Publishing checks it." },
  { key: "radius", label: "Corners", kind: "step", options: Object.keys(RADIUS_STEPS) },
  { key: "type_scale", label: "Text size", kind: "step", options: Object.keys(TYPE_SCALES) },
  { key: "button_shape", label: "Button shape", kind: "step", options: Object.keys(BUTTON_SHAPES) },
  { key: "section_spacing", label: "Space between sections", kind: "step", options: Object.keys(SECTION_SPACING) },
]);
const STEP_WORDS = { sm: "Small", md: "Medium", lg: "Large", xl: "Extra large", compact: "Compact", regular: "Regular", large: "Large", airy: "Airy", pill: "Pill", rounded: "Rounded", square: "Square" };
export const stepWords = (v) => own(STEP_WORDS, v) ?? cap(String(v));
const HEX = /^#[0-9a-fA-F]{6}$/;

// The looks a store can pick: every kit in lib/brand.js KIT_SURFACES.
export function lookChoices() {
  return Object.keys(KIT_SURFACES).map((id) => {
    const m = /^(.*)-(\d+)$/.exec(id);
    return { id, kit: m ? m[1] : id, version: m ? Number(m[2]) : 1, label: cap(m ? m[1] : id) };
  });
}
export const lookIdOf = (theme) => (isObj(theme) && KIT_SURFACES[`${theme.kit}-${theme.version}`] ? `${theme.kit}-${theme.version}` : isObj(theme) ? `${theme.kit}-${theme.version}` : "");

export const design = {
  // The brand the form shows: the stored one, or the platform default when
  // the store has none (null), with `usingDefault` so the form can say so.
  brandView(brand) {
    const b = isObj(brand) ? brand : null;
    return { usingDefault: !b, values: { ...DEFAULT_BRAND, ...(b || {}) } };
  },
  // One token changed. The first change of a store with no brand starts from
  // the platform default. accent_label (the text colour on accent buttons) is
  // worked out from the accent by validateBrand; the storefront uses a stored
  // one as it is, so it is worked out again here whenever the brand reads,
  // and dropped while a colour is half typed (the storefront then works it
  // out itself). A stale one would keep the old button text colour.
  setToken(brand, key, value) {
    const base = isObj(brand) ? { ...brand } : { ...DEFAULT_BRAND };
    base[key] = value;
    const { accent_label: _old, ...rest } = base;
    const checked = validateBrand(rest);
    return checked.ok ? { ...rest, accent_label: checked.value.accent_label } : rest;
  },
  // Back to the platform default look: no brand stored.
  reset() {
    return null;
  },
  setLook(theme, id) {
    const pick = lookChoices().find((l) => l.id === id);
    if (!pick) return theme;
    return { kit: pick.kit, version: pick.version };
  },
  colourOk: (v) => HEX.test(String(v ?? "")),
};

// ---- focus (ED-04) ---------------------------------------------------------------------

// focusRequest { path, offset? }: path is a field path as validate.js and the
// preview's data-field name it ("title", "body.2", "items.1.a", "meta.title"),
// under the open section (sectionId) or the document. The anchor is the
// closest field the form renders.
export function focusAnchor(focusRequest, { sectionId = null, known = null } = {}) {
  if (!isObj(focusRequest) || typeof focusRequest.path !== "string" || !focusRequest.path) return null;
  return fieldAnchor({ sectionId, field: focusRequest.path }, known ? { known } : {});
}

// The character index where block child `offset` of some HTML starts, for a
// rich text field shown as text: the n-th top-level element. Past the end it
// is the end; with no offset it is null (the caret is left alone).
export function blockStart(html, offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  const s = String(html ?? "");
  const VOID = /^(br|hr|img|wbr|input|meta|link|source|col|area|base|embed|track|param)$/i;
  let depth = 0;
  let count = -1;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const closing = m[1] === "/";
    const selfClosing = m[3] === "/" || VOID.test(m[2]);
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      count++;
      if (count === offset) return m.index;
    }
    if (!selfClosing) depth++;
  }
  return s.length;
}

// Focus the element with this id and, for a text box, put the caret at
// `caret` (clamped). Takes the document as a parameter, so tests pass a stub.
// Returns true when an element was focused.
export function applyFocus(doc, anchor, caret = null) {
  if (!doc || typeof doc.getElementById !== "function" || !anchor) return false;
  const el = doc.getElementById(anchor);
  if (!el) return false;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  if (caret != null && typeof el.setSelectionRange === "function" && typeof el.value === "string") {
    const n = Math.max(0, Math.min(Number(caret) || 0, el.value.length));
    el.setSelectionRange(n, n);
  }
  return true;
}
