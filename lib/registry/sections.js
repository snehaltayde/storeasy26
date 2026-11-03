// P2-REG (DOC-03, DOC-06, DOC-07): the section declarations. Plain data; the
// engine in ./index.js checks and registers them. Pure and edge-safe.
//
// One declaration per section kind (spec 8.5):
//   kind, version, label, documentTypes   identity, and where it may go
//   settings                               [{ key, kind, label, max, softMax,
//                                            required, default, … }]
//   bindings                               the catalog data the renderer resolves
//   blocks                                 reserved (TREE-02): { allowed: [], max: 0 }
//   maxPerDocument, allowedPositions       composition guards
//   minItems                               below this, a founder note
//   rules(section)                         cross-field checks:
//                                            [{ field, code, message, cls }]
//   refs(section)                          extra references, beyond what the
//                                            settings already declare
//   migrate                                { <from version>: (section) => section }
//   placeholder                            the empty-state hint for the editor
//   protected                              a commerce module that can't be
//                                            hidden or removed
//   startsIncomplete                       AU-04: a newly added one is a known
//                                            incomplete state (a banner with no
//                                            text yet); every other kind's
//                                            defaults must publish clean
//
// The merged library (DOC-03, DOC-06): home and page sections share one set of
// kinds. Old names live on only in LEGACY_KIND_NAMES, for adapters and the
// legacy reader: "rich" is rich_text, "image" is image_with_text, and a page
// section's "heading" is "title".
import { isBlank } from "./text.js";

// Where the library's ordinary sections may go.
const CONTENT_DOCS = ["home", "page", "campaign", "journal"];
const LAYOUT_DOCS = ["product_layout", "collection_layout"];

const HERO_SUBTITLE = "Browse the full catalog and check out in a few easy steps.";

export const SECTION_DECLARATIONS = [
  {
    kind: "hero",
    version: 1,
    label: "Hero",
    documentTypes: ["home"],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 120, softMax: 60, required: true, default: "Welcome to our store" },
      { key: "highlight", kind: "text", label: "Highlighted words", max: 60, default: "", help: "Words from the title shown in your accent colour" },
      { key: "subtitle", kind: "text", label: "Subtitle", max: 300, default: HERO_SUBTITLE },
      { key: "primary", kind: "cta", label: "Primary button", default: { label: "Shop all collections", link: { type: "url", href: "/collections" } } },
      { key: "secondary", kind: "cta", label: "Secondary button", default: null },
      { key: "badge", kind: "text", label: "Badge", max: 80, default: "" },
      { key: "image", kind: "image", label: "Image", default: null },
    ],
    maxPerDocument: 1,
    allowedPositions: ["first"],
    rules: (section) => {
      const { title, highlight } = section.settings || {};
      if (typeof highlight === "string" && !isBlank(highlight) && typeof title === "string" && !title.includes(highlight.trim())) {
        return [{ field: "highlight", code: "HIGHLIGHT_NOT_IN_TITLE", message: "The highlighted words aren't in the title any more, so nothing will be highlighted. Pick words from the title.", cls: "warning" }];
      }
      return [];
    },
    placeholder: "Write the first thing shoppers read",
  },
  {
    kind: "collections",
    version: 1,
    label: "Collections grid",
    documentTypes: CONTENT_DOCS,
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80, softMax: 50, default: "Shop by collection" },
      { key: "limit", kind: "number", label: "Collections shown", min: 1, max: 24, default: 6 },
    ],
    bindings: { collections: { sources: ["featured_collections"], args: ["limit"] } },
    placeholder: "Shows your collections",
  },
  {
    kind: "new",
    version: 1,
    label: "Newest products",
    documentTypes: CONTENT_DOCS,
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80, softMax: 50, default: "New arrivals" },
      { key: "limit", kind: "number", label: "Products shown", min: 1, max: 24, default: 8 },
    ],
    bindings: { products: { sources: ["newest_products"], args: ["limit"] } },
    placeholder: "Shows your newest products",
  },
  {
    kind: "banner",
    version: 1,
    label: "Banner",
    documentTypes: [...CONTENT_DOCS, ...LAYOUT_DOCS],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80, softMax: 50, default: "" },
      { key: "text", kind: "text", label: "Text", max: 300, default: "" },
      { key: "button", kind: "cta", label: "Button", default: null },
    ],
    rules: (section) => {
      const { title, text } = section.settings || {};
      const blank = (v) => v == null || (typeof v === "string" && isBlank(v));
      return blank(title) && blank(text) ? [{ field: "title", code: "SECTION_EMPTY", message: "This banner has no title or text yet. Write one, or remove the banner.", cls: "incomplete" }] : [];
    },
    placeholder: "Write a short message, with an optional button",
    startsIncomplete: true,
  },
  {
    kind: "rich_text",
    version: 1,
    label: "Rich text",
    documentTypes: [...CONTENT_DOCS, ...LAYOUT_DOCS, "product_content"],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 120, softMax: 60, default: "" },
      { key: "html", kind: "rich_text", label: "Content", max: 20000, required: true, default: "" },
    ],
    placeholder: "Write anything: a story, a size guide, a note",
    startsIncomplete: true,
  },
  {
    kind: "image_with_text",
    version: 1,
    label: "Image with text",
    documentTypes: [...CONTENT_DOCS, ...LAYOUT_DOCS, "product_content"],
    settings: [
      { key: "image", kind: "image", label: "Image", required: true, default: null },
      { key: "image_side", kind: "choice", label: "Image side", options: ["left", "right"], default: "left" },
      { key: "title", kind: "text", label: "Title", max: 120, softMax: 60, default: "" },
      { key: "text", kind: "text", label: "Text", max: 600, default: "" },
      { key: "caption", kind: "text", label: "Caption", max: 300, default: "" },
      { key: "button", kind: "cta", label: "Button", default: null },
    ],
    placeholder: "Choose an image and say something about it",
    startsIncomplete: true,
  },
  {
    kind: "product_rail",
    version: 1,
    label: "Product rail",
    documentTypes: [...CONTENT_DOCS, ...LAYOUT_DOCS],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80, softMax: 50, default: "Featured products" },
      { key: "collection", kind: "collection", label: "Collection", required: true, default: null },
      { key: "limit", kind: "number", label: "Products shown", min: 1, max: 12, default: 8 },
    ],
    bindings: { products: { sources: ["collection_products"], args: ["collection", "limit"] } },
    minItems: 3,
    rules: (section) => {
      const { limit } = section.settings || {};
      return Number.isInteger(limit) && limit >= 1 && limit < 3
        ? [{ field: "limit", code: "FEW_ITEMS", message: "A rail looks best with at least 3 products. Shoppers will still see what you chose.", cls: "warning" }]
        : [];
    },
    placeholder: "Pick a collection to show its products",
    startsIncomplete: true,
  },
  {
    kind: "text",
    version: 1,
    label: "Text",
    documentTypes: [...CONTENT_DOCS, ...LAYOUT_DOCS, "product_content"],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 120, softMax: 60, default: "" },
      { key: "body", kind: "paragraphs", label: "Paragraphs", maxEach: 4000, max: 100, default: [] },
    ],
    // AU-05: a heading OR a paragraph
    rules: (section) => {
      const { title, body } = section.settings || {};
      const hasTitle = typeof title === "string" && !isBlank(title);
      const hasBody = Array.isArray(body) && body.some((p) => typeof p === "string" && !isBlank(p));
      return hasTitle || hasBody ? [] : [{ field: "body", code: "SECTION_EMPTY", message: "Add a title or some text, or remove this section.", cls: "incomplete" }];
    },
    placeholder: "Write a heading and a few paragraphs",
    startsIncomplete: true,
  },
  {
    kind: "faq",
    version: 1,
    label: "FAQ",
    documentTypes: [...CONTENT_DOCS, ...LAYOUT_DOCS, "product_content"],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 120, softMax: 60, default: "" },
      { key: "items", kind: "qa_list", label: "Questions", max: 30, required: true, default: [] },
    ],
    placeholder: "Add the questions shoppers ask most",
    startsIncomplete: true,
  },
  // The protected commerce module of a product page: the gallery, price,
  // variants and buy button. Shopify owns its data; the layout only places it.
  {
    kind: "product_main",
    version: 1,
    label: "Product details and buy button",
    documentTypes: ["product_layout"],
    settings: [],
    bindings: { product: { sources: ["route_product"], args: [] } },
    maxPerDocument: 1,
    protected: true,
    placeholder: "The product's photos, price, options and buy button",
  },
];

// Old concept names, readable forever through the legacy reader and the
// adapters in ./legacy.js. Bodies written from now on use the new names only.
export const LEGACY_KIND_NAMES = Object.freeze({
  rich: { kind: "rich_text", fields: { heading: "title", html: "html" } },
  image: { kind: "image_with_text", fields: { src: "image.media", alt: "image.alt", caption: "caption" } },
  text: { kind: "text", fields: { heading: "title", body: "body" } },
  faq: { kind: "faq", fields: { heading: "title", items: "items" } },
});
