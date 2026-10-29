// The versioned COMPONENT REGISTRY (S54 / audit slice 2). One declaration per
// section type: identity, family, label, defaults, settings contract and data
// bindings — the single authority the validator, the shared renderer's data
// resolver, and (next slice) the visual editor's controls all read. Adding a
// section type means adding a declaration here plus its renderer; nothing
// else may hard-code kind lists.
//
// Durable instance IDs: every section instance carries `id` ("sec_…"),
// independent of its title, position or type. Editors preserve them across
// saves; duplicates mint fresh ones; legacy id-less content upgrades
// DETERMINISTICALLY at read (index-derived — a lazy migrate must never mint
// randomness, or every read would change the release snapshot hash).

export const SECTION_ID_RE = /^sec_[a-z0-9]{2,16}$/;

export const mintSectionId = () =>
  "sec_" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

// Deterministic id for legacy content upgraded at read (stable per position;
// once the merchant saves, the id persists and position no longer matters).
export const legacySectionId = (index) => `sec_l${index}`;

// Stamp a built section list: keep valid, UNIQUE incoming ids; mint for the
// rest (save path — randomness is fine, the result persists).
export function ensureSectionIds(sections) {
  const seen = new Set();
  return sections.map((s) => {
    let id = typeof s?.id === "string" && SECTION_ID_RE.test(s.id) && !seen.has(s.id) ? s.id : null;
    while (!id || seen.has(id)) id = mintSectionId();
    seen.add(id);
    return { ...s, id };
  });
}

// ---- component declarations -------------------------------------------------
// settings: the editor-control contract (next slice renders from it; the
// validator enforces the same bounds today). bindings: what data the shared
// renderer resolves PER INSTANCE (lib/cms/section-data.js) — duplicate
// sections resolve independently, keyed by instance id.
export const COMPONENTS = {
  collections: {
    type: "collections",
    version: 2,
    family: "home",
    label: "Collections grid",
    defaults: { title: "Shop by collection", limit: 6 },
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80 },
      { key: "limit", kind: "number", label: "Items", min: 1, max: 24 },
    ],
    bindings: { collections: { source: "featured_collections", args: ["limit"] } },
  },
  new: {
    type: "new",
    version: 2,
    family: "home",
    label: "Newest products",
    defaults: { title: "Fresh drops", limit: 8 },
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80 },
      { key: "limit", kind: "number", label: "Items", min: 1, max: 24 },
    ],
    bindings: { products: { source: "newest_products", args: ["limit"] } },
  },
  banner: {
    type: "banner",
    version: 2,
    family: "home",
    label: "Banner / CTA",
    defaults: { title: "", text: "", label: "", href: "/collections" },
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80 },
      { key: "text", kind: "text", label: "Text", max: 300 },
      { key: "label", kind: "text", label: "Button label", max: 40 },
      { key: "href", kind: "link", label: "Button link" },
    ],
    bindings: {},
  },
  rich_text: {
    type: "rich_text",
    version: 2,
    family: "home",
    label: "Rich text",
    defaults: { title: "", html: "" },
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80 },
      { key: "html", kind: "html", label: "Content", max: 20000 },
    ],
    bindings: {},
  },
  text: {
    type: "text",
    version: 3,
    family: "page",
    label: "Text",
    defaults: { heading: "", body: [] },
    settings: [
      { key: "heading", kind: "text", label: "Heading", max: 120, required: true },
      { key: "body", kind: "paragraphs", label: "Paragraphs", maxEach: 4000 },
    ],
    bindings: {},
  },
  rich: {
    type: "rich",
    version: 3,
    family: "page",
    label: "Rich HTML",
    defaults: { heading: "", html: "" },
    settings: [
      { key: "heading", kind: "text", label: "Heading", max: 120 },
      { key: "html", kind: "html", label: "Content", max: 20000 },
    ],
    bindings: {},
  },
  image: {
    type: "image",
    version: 3,
    family: "page",
    label: "Image",
    defaults: { src: "", alt: "", caption: "" },
    settings: [
      { key: "src", kind: "media", label: "Image", required: true },
      { key: "alt", kind: "text", label: "Alt text", max: 300, required: true },
      { key: "caption", kind: "text", label: "Caption", max: 300 },
    ],
    bindings: {},
  },
  faq: {
    type: "faq",
    version: 3,
    family: "page",
    label: "FAQ",
    defaults: { heading: "", items: [] },
    settings: [
      { key: "heading", kind: "text", label: "Heading", max: 120 },
      { key: "items", kind: "qa-list", label: "Questions", min: 1, max: 30 },
    ],
    bindings: {},
  },
};

export const kindsForFamily = (family) =>
  Object.values(COMPONENTS)
    .filter((c) => c.family === family)
    .map((c) => c.type);

export const HOME_SECTION_KINDS = kindsForFamily("home");
export const PAGE_SECTION_KINDS = kindsForFamily("page");

export const componentFor = (kind) => COMPONENTS[kind] || null;
