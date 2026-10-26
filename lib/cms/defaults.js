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

export const BLOCK_KEYS = ["announcement", "hero", "home_sections", "nav_header", "nav_footer"];
