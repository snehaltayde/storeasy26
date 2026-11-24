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
import { galleryMediaAllowed } from "./settings.js";

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
      // P6-LOGO-REG (GEN-04): the picture logo. A body without this key (every
      // design saved before phase 6) reads as no logo. Not a singleton, so the
      // release-list manifest and sinceManifest stay as they are.
      { key: "logo", kind: "logo", label: "Logo", default: null },
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
    // P4-LIVEROW (OVL-01, OVL-02, ED-12): what the founder changes about one
    // Shopify product. Published as a product_content_live row, never into the
    // release list. The Shopify-derived fields are overlays (null follows
    // Shopify); the sections are the product page's modules.
    type: "product_content",
    label: "Product content",
    noun: "this product's content",
    sections: true,
    settings: [
      { key: "title", kind: "overlay", of: "text", label: "Name", max: 255, nonEmpty: true, default: null },
      { key: "description_html", kind: "overlay", of: "rich_text", label: "Description", max: 20000, default: null },
      { key: "gallery", kind: "overlay", of: "gallery", label: "Images", max: 30, default: null },
      { key: "display_vendor", kind: "overlay", of: "text", label: "Brand shown", max: 255, default: null },
      { key: "display_type", kind: "overlay", of: "text", label: "Product type shown", max: 255, default: null },
      { key: "badge", kind: "text", label: "Badge", max: 30, default: null },
      { key: "template", kind: "choice", label: "Layout", options: ["classic", "editorial"], default: null },
      { key: "pairs", kind: "pairs", label: "Goes well with", max: 12, default: null },
      { key: "keep_variant_images", kind: "boolean", label: "Keep variant images", default: null },
    ],
    rules: productContentRules,
  },
  {
    // P4-LIVEROW (ED-12): what the founder changes about one Shopify
    // collection. Published as a collection_content_live row.
    type: "collection_content",
    label: "Collection content",
    noun: "this collection's content",
    settings: [
      { key: "pinned", kind: "product_ids", label: "Pinned products", max: 24, default: null },
      { key: "template", kind: "choice", label: "Layout", options: ["standard", "sidebar"], default: null },
    ],
  },
];

// ---- product and collection content (P4-LIVEROW) ------------------------------------

// Types whose publish writes a live row instead of a release list entry.
export const LIVE_ROW_TYPES = Object.freeze(["product_content", "collection_content"]);
export const isLiveRowType = (type) => LIVE_ROW_TYPES.includes(type);

// The fields that follow Shopify until the founder changes them.
export const OVERLAY_FIELDS = Object.freeze({ product_content: Object.freeze(["title", "description_html", "gallery", "display_vendor", "display_type"]), collection_content: Object.freeze([]) });

// The module kinds a founder can ADD to product content. image_with_text stays
// registered for product_content (sections.js) so modules made before still
// load and save, with an inherited warning; it is not offered for new ones.
export const PRODUCT_MODULE_KINDS = Object.freeze(["rich_text", "text", "faq"]);
export const offeredKinds = (type, allowed) => (type === "product_content" ? allowed.filter((k) => PRODUCT_MODULE_KINDS.includes(k)) : allowed);

// The product module limits (as the retired product overrides' validateModules).
// Content beyond them loads and saves verbatim with a warning; never cut.
export const LEGACY_MODULE_LIMITS = Object.freeze({ count: 6, title: 80, html: 10000 });

// Fields Shopify owns. A write naming one is refused (SHOPIFY_OWNED), with
// the words for what it is.
export const SHOPIFY_OWNED_FIELDS = Object.freeze({
  price: "the price",
  compare_at_price: "the compare-at price",
  variants: "the variants",
  inventory: "the stock count",
  availability: "whether it's in stock",
  available: "whether it's in stock",
  handle: "the web address",
  tags: "the tags",
  product_type: "the product type used for filters and offers",
  vendor: "the vendor used for filters and offers",
  options: "the options",
});
export const shopifyOwnedMessage = (key) =>
  `Shopify owns ${SHOPIFY_OWNED_FIELDS[key] || "this"}, so it can't be changed here. Change it in Shopify; your store picks it up with the next catalog update.`;

const moduleTitle = (s) => (isObj(s?.settings) && typeof s.settings.title === "string" ? s.settings.title : "");
function moduleHtmlLength(s) {
  const st = isObj(s?.settings) ? s.settings : {};
  if (s.kind === "rich_text") return typeof st.html === "string" ? st.html.length : 0;
  if (s.kind === "text") return (Array.isArray(st.body) ? st.body : []).filter((p) => typeof p === "string").reduce((n, p) => n + p.length + 7, 0);
  if (s.kind === "faq") return Math.max(0, ...(Array.isArray(st.items) ? st.items : []).map((it) => (isObj(it) && typeof it.a === "string" ? it.a.length : 0)));
  return 0;
}

// The inherited notes of product modules: an image_with_text module (not
// offered any more) and modules beyond today's limits. Warnings only: they
// load, save and publish exactly as they are. Kept out of the type's rules so
// the registry contract (a new section of each kind is clean) still holds;
// lib/documents/service.js and publish.js add them to the issues they return.
// [{ sectionId, field, code, message }]
export function productModuleNotes(body) {
  const out = [];
  if (!isObj(body) || body.type !== "product_content") return out;
  const sections = Array.isArray(body.sections) ? body.sections.filter(isObj) : [];
  for (const s of sections) {
    if (s.kind === "image_with_text") {
      out.push({ sectionId: s.id ?? null, field: null, code: "MODULE_NOT_OFFERED", message: "This image-with-text module was added before product modules changed. It still shows and can be edited, but new ones can't be added to a product." });
    }
    const title = moduleTitle(s);
    if (title.length > LEGACY_MODULE_LIMITS.title || moduleHtmlLength(s) > LEGACY_MODULE_LIMITS.html) {
      out.push({ sectionId: s.id ?? null, field: null, code: "MODULE_OVER_LIMIT", message: `This module is longer than product modules used to allow (a ${LEGACY_MODULE_LIMITS.title}-character title and ${LEGACY_MODULE_LIMITS.html.toLocaleString("en-US")} characters of text). It is kept exactly as it is.` });
    }
  }
  if (sections.length > LEGACY_MODULE_LIMITS.count) {
    out.push({ sectionId: null, field: "sections", code: "MODULES_OVER_LIMIT", message: `This product has ${sections.length} modules, more than the ${LEGACY_MODULE_LIMITS.count} products used to allow. They are all kept and shown.` });
  }
  return out;
}

function productContentRules(body, { mode }) {
  const out = [];
  // OVL-13: only Shopify's image host and the store's own library go live
  const g = isObj(body.settings) ? body.settings.gallery : null;
  if (isObj(g) && Array.isArray(g.value)) {
    g.value.forEach((it, j) => {
      if (isObj(it) && typeof it.media === "string" && !galleryMediaAllowed(it.media)) {
        out.push({
          field: `gallery.value.${j}.media`,
          code: "IMAGE_HOST_NOT_ALLOWED",
          message: "This image is stored on another website, so it can't go live. Choose it from your library, or use one of Shopify's images.",
          cls: mode === "publish" ? "invalid" : "warning",
        });
      }
    });
  }
  return out;
}
