// P2-REG (DOC-01, DOC-03, DOC-07): the document type declarations (spec 8.3).
// Plain data; the engine in ./index.js checks and registers them. Pure and
// edge-safe.
//
//   type, label, noun        identity; `noun` is how a message names it
//                            ("the home page", "this page")
//   sinceManifest            the release-list manifest a singleton is listed
//                            from (spec 8.4); null for non-singletons
//   singleton                one per store, id doc_<type>, listed in every
//                            release list (emptyList)
//   route                    has a URL: meta carries slug, title and windows
//   publishable              false: may be saved, never published (yet)
//   editable                 false: a system document the founder never edits
//   index                    the release-list index it is published as
//   settings                 document-level settings (header, footer,
//                            announcement, design, cart, layouts)
//   sections                 true when the body holds a section list. WHICH
//                            kinds are allowed comes from each section's own
//                            `documentTypes`, so a new section kind joins a
//                            document type with one declaration (DOC-03).
//   maxBeforeProtected       at most this many sections above the protected
//                            module (product_layout: 1, a hypothesis)
//   rules(body, ctx)         document-level checks: [{ field, code, message, cls }]
//                            ctx: { mode, live }
import { checkBrand, validateBrand, DEFAULT_KIT, KIT_SURFACES } from "../brand.js";
import { isBlank } from "./text.js";

export const HOME_EMPTY_MESSAGE = "Your home page is empty. Add a section or restore the last published version.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const kitOf = (theme) => (isObj(theme) && KIT_SURFACES[`${theme.kit}-${theme.version}`] ? `${theme.kit}-${theme.version}` : DEFAULT_KIT);

const menuSettings = (templates, fallback) => [
  { key: "mode", kind: "choice", label: "Menu", options: ["auto", "custom"], default: "auto", help: "Automatic lists your collections" },
  { key: "items", kind: "nav_items", label: "Menu items", max: 12, default: [] },
  { key: "template", kind: "choice", label: "Layout", options: templates, default: fallback },
];
const menuRules = (body) => {
  const s = body.settings || {};
  return s.mode === "auto" && Array.isArray(s.items) && s.items.length
    ? [{ field: "items", code: "ITEMS_NOT_SHOWN", message: "This menu is set to automatic, so these items aren't shown. Switch it to custom to use them.", cls: "warning" }]
    : [];
};

export const DOCUMENT_TYPE_DECLARATIONS = [
  {
    type: "announcement",
    label: "Announcement bar",
    noun: "the announcement bar",
    singleton: true,
    sinceManifest: 1,
    settings: [
      { key: "enabled", kind: "boolean", label: "Show the bar", default: false },
      { key: "text", kind: "text", label: "Text", max: 200, softMax: 90, default: "" },
      { key: "link", kind: "link", label: "Link", default: null },
    ],
    rules: (body) => {
      const s = body.settings || {};
      return s.enabled === true && (s.text == null || (typeof s.text === "string" && isBlank(s.text)))
        ? [{ field: "text", code: "REQUIRED", message: "The announcement bar is switched on but has no text. Write it, or switch the bar off.", cls: "incomplete" }]
        : [];
    },
  },
  {
    type: "header",
    label: "Header menu",
    noun: "the header",
    singleton: true,
    sinceManifest: 1,
    settings: menuSettings(["standard", "centered"], "standard"),
    rules: menuRules,
  },
  {
    type: "footer",
    label: "Footer menu",
    noun: "the footer",
    singleton: true,
    sinceManifest: 1,
    settings: menuSettings(["columns", "minimal"], "columns"),
    rules: menuRules,
  },
  {
    // Plan decision 8: a thin type. The brand and theme routes, the logo and
    // the console editor move here at TOK-03.
    type: "design",
    label: "Brand",
    noun: "your brand",
    singleton: true,
    sinceManifest: 1,
    settings: [
      { key: "brand", kind: "brand", label: "Brand colours and shapes", default: null },
      { key: "theme", kind: "theme", label: "Look", default: null },
    ],
    // TOK-02: readability is checked at publish, against the live pair.
    rules: (body, { mode, live }) => {
      if (mode !== "publish") return [];
      const s = body.settings || {};
      // a malformed brand is already reported by its setting check
      if (s.brand != null && (!isObj(s.brand) || validateBrand(s.brand).errors.length)) return [];
      const liveSettings = isObj(live?.settings) ? live.settings : {};
      const check = checkBrand(s.brand ?? null, { kit: kitOf(s.theme), live: liveSettings.brand ?? null, liveKit: kitOf(liveSettings.theme) });
      return check.issues.map((i) => ({ field: "brand", code: i.severity === "error" ? "BRAND_UNREADABLE" : "BRAND_HARD_TO_READ", message: i.message, cls: i.severity === "error" ? "invalid" : "warning" }));
    },
  },
  {
    type: "home",
    label: "Home page",
    noun: "the home page",
    singleton: true,
    sinceManifest: 1,
    sections: true,
    // DOC-07: a draft may be empty; publishing an empty home is refused. Keeps
    // the guard of lib/releases.js:172.
    rules: (body, { mode }) => {
      if (mode !== "publish" || !Array.isArray(body.sections)) return [];
      return body.sections.some((s) => isObj(s) && s.enabled !== false) ? [] : [{ field: "sections", code: "HOME_EMPTY", message: HOME_EMPTY_MESSAGE, cls: "invalid" }];
    },
  },
  {
    type: "collections_index",
    label: "Collections page",
    noun: "the collections page",
    singleton: true,
    sinceManifest: 1,
    settings: [
      { key: "featured", kind: "collection_list", label: "Featured collections", max: 6, default: [] },
      { key: "order", kind: "collection_list", label: "Collection order", max: 50, default: [] },
      { key: "hide", kind: "collection_list", label: "Hidden collections", max: 50, default: [] },
    ],
    rules: (body) => {
      const s = body.settings || {};
      const handles = (list) => (Array.isArray(list) ? list.filter(isObj).map((c) => c.handle) : []);
      const shownSet = new Set([...handles(s.featured), ...handles(s.order)]);
      return handles(s.hide)
        .filter((h) => shownSet.has(h))
        .map((h) => ({ field: "hide", code: "SHOWN_AND_HIDDEN", message: `"${h}" is both shown and hidden. Take it out of one list.`, cls: "invalid" }));
    },
  },
  {
    type: "product_layout",
    label: "Product page layout",
    noun: "the product page layout",
    singleton: true,
    sinceManifest: 1,
    sections: true,
    maxBeforeProtected: 1,
    settings: [{ key: "template", kind: "choice", label: "Layout", options: ["classic", "editorial"], default: "classic" }],
  },
  {
    type: "collection_layout",
    label: "Collection page layout",
    noun: "the collection page layout",
    singleton: true,
    sinceManifest: 1,
    sections: true,
    settings: [{ key: "template", kind: "choice", label: "Layout", options: ["standard", "sidebar"], default: "standard" }],
  },
  {
    // The doc_cart capability ruling (upsells.write or storefront.*) is an
    // owner check (plan section 3).
    type: "cart",
    label: "Cart",
    noun: "the cart",
    singleton: true,
    sinceManifest: 1,
    settings: [
      { key: "title", kind: "text", label: "Suggestions title", max: 80, default: "You might also like" },
      { key: "products", kind: "product_list", label: "Suggested products", max: 8, default: [] },
    ],
  },
  { type: "page", label: "Page", noun: "this page", route: true, sections: true },
  { type: "campaign", label: "Campaign page", noun: "this campaign page", route: true, sections: true },
  { type: "journal", label: "Journal post", noun: "this journal post", route: true, sections: true },
  {
    // Generated from live posts at publish. Founders never edit it.
    type: "journal_index",
    label: "Journal index",
    noun: "the journal index",
    editable: false,
    system: true,
    index: "journal",
    settings: [{ key: "entries", kind: "entries", label: "Entries", default: [] }],
  },
  {
    // Stored and versioned now; publishing waits for OVL-02.
    type: "product_content",
    label: "Product content",
    noun: "this product's content",
    publishable: false,
    sections: true,
  },
];
