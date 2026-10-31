// Default merchandising content (Session 23) — what a tenant's storefront
// shows before anything is edited in the console. Brand-specific copy does
// NOT live here: BeastLife's hero/announcement rows are seeded into ITS
// database (scripts/seed-cms-beastlife.js) and its identity strings into its
// tenant config; these defaults derive from the store name only.

export const DEFAULT_ANNOUNCEMENT = { enabled: false, text: "", href: "" };

// Hero: the `highlight` substring of the title gets the accent color.
export const defaultHero = (name = "our store") => ({
  title: `Shop ${name}.`,
  highlight: name,
  subtitle: "Browse the full catalog at ludicrous speed — fresh drops, live offers and fast checkout.",
  primary: { label: "Shop all collections", href: "/collections" },
  secondary: { label: "See what’s new", href: "#new" },
});

// Stable ids (SECTION_ID_RE shape) so the Designer's tree→preview highlight
// works before the first save — id-less sections render with index keys the
// tree can't address. validateBlock keeps these ids on the first save.
export const DEFAULT_HOME_SECTIONS = [
  { id: "sec_defcollect", kind: "collections", title: "Shop by collection", limit: 6, enabled: true },
  { id: "sec_defnew", kind: "new", title: "Fresh drops", limit: 8, enabled: true },
];

// null = derive from the catalog (header: all collections; footer: top 5) —
// exactly the pre-CMS behavior. A configured array replaces the derived list.
export const DEFAULT_NAV_HEADER = null;
export const DEFAULT_NAV_FOOTER = null;

// S38 (SF02): merchant-curated collection index. null = derive from the
// catalog (alphabetical, featured-by-size on home) — the pre-S38 behavior.
// Shape: { featured: [handle…], order: [handle…], hide: [handle…] }.
export const DEFAULT_COLLECTIONS_INDEX = null;

// S38 (SF04): PDP extras — accordions rendered under the description on every
// product page (shipping, returns, lab reports…). null = none.
export const DEFAULT_PDP_EXTRAS = null;

// S56 (audit slices 3/4): per-surface template assignment, FAMILY DEFAULTS
// first (explicit per-entity assignment is a later, separate step). null =
// the platform defaults below — today's layouts, byte-identical.
// S61 adds the global chrome (audit "Core": header/footer need at least two
// STRUCTURAL variants). Chrome is family-level only — no per-entity maps.
export const SURFACE_TEMPLATE_CHOICES = {
  pdp: ["classic", "editorial"],
  collection: ["standard", "sidebar"],
  header: ["standard", "centered"],
  footer: ["columns", "minimal"],
};
export const DEFAULT_SURFACE_TEMPLATES = { pdp: "classic", collection: "standard", header: "standard", footer: "columns" };

// S57 (audit slice 3): EXPLICIT per-entity assignment. The stored block may
// carry `products` / `collections` maps of entity id → template; precedence
// is explicit entity assignment → family default → platform default (ranked
// RULES are a later slice, per the audit's "explicit first" ordering). Pure —
// both the draft and the live-snapshot reader resolve through this, and the
// returned `source` lets editors explain WHY a template was selected.
export const SURFACE_ENTITY_KEYS = { pdp: "products", collection: "collections" };
export function effectiveSurfaceTemplate(value, surface, entityId) {
  const choices = SURFACE_TEMPLATE_CHOICES[surface] || [];
  const pick = entityId != null ? value?.[SURFACE_ENTITY_KEYS[surface]]?.[String(entityId)] : null;
  if (pick && choices.includes(pick)) return { template: pick, source: "entity" };
  const fam = value?.[surface];
  if (fam && choices.includes(fam)) return { template: fam, source: "family" };
  return { template: DEFAULT_SURFACE_TEMPLATES[surface], source: "platform" };
}

export const BLOCK_KEYS = ["announcement", "hero", "home_sections", "nav_header", "nav_footer", "collections_index", "pdp_extras", "surface_templates"];
