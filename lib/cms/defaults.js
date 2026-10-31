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

export const DEFAULT_HOME_SECTIONS = [
  { kind: "collections", title: "Shop by collection", limit: 6, enabled: true },
  { kind: "new", title: "Fresh drops", limit: 8, enabled: true },
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
export const SURFACE_TEMPLATE_CHOICES = { pdp: ["classic", "editorial"], collection: ["standard", "sidebar"] };
export const DEFAULT_SURFACE_TEMPLATES = { pdp: "classic", collection: "standard" };

export const BLOCK_KEYS = ["announcement", "hero", "home_sections", "nav_header", "nav_footer", "collections_index", "pdp_extras", "surface_templates"];
