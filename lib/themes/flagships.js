// Phase 7 line 1 (docs/plans/phase-7.md "Line 1", decision 5): Storeasy's five
// flagship themes, as first-party `storeasy-theme/1` packages. Data only: each
// passes parseThemePackage, checkBrand (its own tokens and all six palettes)
// and validateStyles like any upload (scripts/test-flagship-themes.js), and has
// no pictures or files. lib/themes/packages.js ensureFlagship installs one on
// first use into theme_packages (source 'storeasy') with a deterministic id,
// so every store's Volt 1.0.0 row has the same id. A new version is a new
// entry here (and a new row), never an edit of a shipped one.
//
// Plain module: no imports, client-safe and Edge-safe (the Themes page and the
// onboarding picker show these cards).

const link = (label, href) => ({ label, link: { type: "url", href } });

const VOLT = {
  format: "storeasy-theme/1",
  id: "volt",
  name: "Volt",
  version: "1.0.0",
  author: { name: "Storeasy" },
  description: "Bold and fast for sports nutrition: a near-black header, an electric orange accent, big sans headings and tight, punchy sections.",
  base: "pulse",
  tokens: { accent: "#ea580c", background: "#ffffff", foreground: "#0a0a0b", radius: "md", type_scale: "large", button_shape: "pill", section_spacing: "compact", heading_font: "sans" },
  surfaces: {
    header: { bg: "#0a0a0b", fg: "#ffffff", muted: "#d4d4d8" },
    hero: { bg: "#111111", fg: "#ffffff", muted: "#fdba74" },
  },
  templates: {
    pdp: "classic",
    collection: "standard",
    header: "standard",
    footer: "columns",
    home: {
      sections: [
        { kind: "hero", settings: { title: "Fuel every rep.", highlight: "every rep", subtitle: "Clean fuel, honest labels, delivered fast.", badge: "Lab tested", primary: link("Shop best sellers", "/collections"), image: null } },
        { kind: "new", settings: { title: "Just dropped", limit: 8 } },
        { kind: "banner", settings: { title: "Stack and save", text: "Build your daily stack and the cart takes care of the discount.", button: link("Build my stack", "/collections") } },
        { kind: "collections", settings: { title: "Shop by goal", limit: 6 } },
        { kind: "faq", settings: { title: "Questions, answered", items: [{ q: "Is every batch tested?", a: "Yes. Every batch is tested by an independent lab before it ships." }, { q: "How fast is delivery?", a: "Most orders leave our warehouse within one working day." }] } },
      ],
    },
  },
  styles: [
    { part: "hero-title", set: { "font-weight": 900, "letter-spacing": "-0.03em", "text-transform": "uppercase", color: "role:hero-fg" } },
    { part: "hero-subtitle", set: { color: "role:hero-muted", "font-weight": 500 } },
    { part: "header-link", set: { "text-transform": "uppercase", "letter-spacing": "0.08em", "font-weight": 700 } },
    { part: "announcement", set: { "background-color": "#c2410c", color: "#ffffff", "text-align": "center", "font-weight": 700 } },
    { part: "section-heading", set: { "font-weight": 900, "text-transform": "uppercase", "letter-spacing": "-0.01em" } },
    { part: "product-card", set: { "border-radius": "12px", "border-width": "2px", "border-color": "role:border-soft", "box-shadow": "none" } },
    { part: "product-card-title", set: { "font-weight": 700 } },
    { part: "product-card-price", set: { "font-weight": 800, color: "role:text" } },
    { part: "badge", set: { "text-transform": "uppercase", "letter-spacing": "0.1em", "font-weight": 800, "border-radius": "4px" } },
    { part: "collection-card", set: { "border-radius": "12px", "box-shadow": "md" } },
  ],
};

const BLOOM = {
  format: "storeasy-theme/1",
  id: "bloom",
  name: "Bloom",
  version: "1.0.0",
  author: { name: "Storeasy" },
  description: "Soft and glowing for beauty and skincare: blush surfaces, a deep rose accent, serif headings and generous space.",
  base: "glow",
  tokens: { accent: "#be185d", background: "#fffbf7", foreground: "#1c1917", radius: "xl", type_scale: "regular", button_shape: "pill", section_spacing: "airy", heading_font: "serif" },
  surfaces: {
    header: { bg: "#fdf2f8", fg: "#1c1917", muted: "#57534e" },
    hero: { bg: "#fce7f3", fg: "#1c1917", muted: "#57534e" },
  },
  templates: {
    pdp: "editorial",
    collection: "standard",
    header: "centered",
    footer: "minimal",
    home: {
      sections: [
        { kind: "hero", settings: { title: "Skin, in full bloom.", highlight: "full bloom", subtitle: "Gentle formulas for a calm, healthy glow.", primary: link("Discover the ritual", "/collections"), image: null } },
        { kind: "rich_text", settings: { title: "Kind to skin", html: "<p>Fragrance-free where it matters, dermatologist tested, and made in small batches.</p>" } },
        { kind: "new", settings: { title: "New in", limit: 4 } },
        { kind: "collections", settings: { title: "Find your routine", limit: 3 } },
        { kind: "banner", settings: { title: "Not sure where to start?", text: "Our three-step ritual suits most skin types.", button: link("See the ritual", "/collections") } },
      ],
    },
  },
  styles: [
    { part: "hero-title", set: { "font-weight": 400, "font-style": "italic", "letter-spacing": "-0.01em", color: "role:hero-fg" } },
    { part: "hero-subtitle", set: { color: "role:hero-muted" } },
    { part: "header-link", set: { "letter-spacing": "0.04em", "font-weight": 500 } },
    { part: "announcement", set: { "background-color": "#831843", color: "#fdf2f8", "text-align": "center" } },
    { part: "section-heading", set: { "font-weight": 400, "text-align": "center", "letter-spacing": "-0.01em" } },
    { part: "section", set: { "padding-block": "4.5rem", gap: "2rem" } },
    { part: "product-card", set: { "border-radius": "24px", "border-width": "0px", "box-shadow": "sm" } },
    { part: "product-card-title", set: { "font-weight": 500, "text-align": "center" } },
    { part: "product-card-price", set: { "text-align": "center", color: "role:text-muted" } },
    { part: "collection-card", set: { "border-radius": "32px", "box-shadow": "none" } },
    { part: "badge", set: { "border-radius": "16px", "letter-spacing": "0.02em", "font-style": "italic" } },
  ],
};

const LOOM = {
  format: "storeasy-theme/1",
  id: "loom",
  name: "Loom",
  version: "1.0.0",
  author: { name: "Storeasy" },
  description: "Quiet and editorial for apparel: stone and ink, square buttons, serif headings, a filter sidebar and a lookbook product page.",
  base: "glow",
  tokens: { accent: "#292524", background: "#fafaf9", foreground: "#0c0a09", radius: "sm", type_scale: "regular", button_shape: "square", section_spacing: "airy", heading_font: "serif" },
  surfaces: {
    header: { bg: "#fafaf9", fg: "#0c0a09", muted: "#57534e" },
    hero: { bg: "#e7e5e4", fg: "#0c0a09", muted: "#44403c" },
  },
  templates: {
    pdp: "editorial",
    collection: "sidebar",
    header: "centered",
    footer: "minimal",
    home: {
      sections: [
        { kind: "hero", settings: { title: "Made to be worn in.", subtitle: "Natural fibres, considered cuts, nothing extra.", primary: link("Shop the collection", "/collections"), secondary: link("New arrivals", "/search"), image: null } },
        { kind: "collections", settings: { title: "The edit", limit: 4 } },
        { kind: "new", settings: { title: "New arrivals", limit: 8 } },
        { kind: "text", settings: { title: "How we make it", body: ["Every piece is cut in small runs from cotton, linen and wool we can trace.", "If something doesn't fit, exchanges are free."] } },
      ],
    },
  },
  styles: [
    { part: "hero-title", set: { "font-weight": 400, "letter-spacing": "-0.02em", color: "role:hero-fg" } },
    { part: "hero-subtitle", set: { color: "role:hero-muted", "letter-spacing": "0.02em" } },
    { part: "header", set: { "border-width": "1px", "border-color": "role:border-soft" } },
    { part: "header-link", set: { "text-transform": "uppercase", "letter-spacing": "0.16em", "font-weight": 500 } },
    { part: "announcement", set: { "background-color": "#0c0a09", color: "#fafaf9", "text-align": "center", "text-transform": "uppercase", "letter-spacing": "0.12em" } },
    { part: "section-heading", set: { "font-weight": 400, "text-transform": "none", "letter-spacing": "-0.01em", "text-align": "start" } },
    { part: "product-card", set: { "border-radius": "0px", "border-width": "0px", "box-shadow": "none" } },
    { part: "product-card-title", set: { "font-weight": 400, "letter-spacing": "0.01em" } },
    { part: "product-card-price", set: { color: "role:text-muted" } },
    { part: "collection-card", set: { "border-radius": "0px" } },
    { part: "badge", set: { "border-radius": "0px", "text-transform": "uppercase", "letter-spacing": "0.14em" } },
    { part: "footer-link", set: { "text-transform": "uppercase", "letter-spacing": "0.1em" } },
  ],
};

const HARVEST = {
  format: "storeasy-theme/1",
  id: "harvest",
  name: "Harvest",
  version: "1.0.0",
  author: { name: "Storeasy" },
  description: "Warm and wholesome for food brands: a deep olive header, a cream page, an amber accent, serif headings and rounded buttons.",
  base: "pulse",
  tokens: { accent: "#b45309", background: "#fffbeb", foreground: "#1c1917", radius: "lg", type_scale: "regular", button_shape: "rounded", section_spacing: "regular", heading_font: "serif" },
  surfaces: {
    header: { bg: "#365314", fg: "#fefce8", muted: "#d9f99d" },
    hero: { bg: "#3f6212", fg: "#ffffff", muted: "#ecfccb" },
  },
  templates: {
    pdp: "classic",
    collection: "sidebar",
    header: "standard",
    footer: "columns",
    home: {
      sections: [
        { kind: "hero", settings: { title: "Good food, grown slowly.", highlight: "grown slowly", subtitle: "From small farms to your kitchen, nothing artificial.", badge: "Farm to pantry", primary: link("Fill your pantry", "/collections"), image: null } },
        { kind: "collections", settings: { title: "Shop the pantry", limit: 6 } },
        { kind: "new", settings: { title: "Fresh this week", limit: 8 } },
        { kind: "banner", settings: { title: "Free delivery on bigger baskets", text: "Stock up once and we deliver it free.", button: link("Start a basket", "/collections") } },
        { kind: "faq", settings: { title: "Good to know", items: [{ q: "Where does it come from?", a: "Every product page names the farm or kitchen it comes from." }, { q: "How long does it keep?", a: "Each pack shows its best-before date; most keep for months unopened." }] } },
      ],
    },
  },
  styles: [
    { part: "hero-title", set: { "font-weight": 600, "letter-spacing": "-0.01em", color: "role:hero-fg" } },
    { part: "hero-subtitle", set: { color: "role:hero-muted" } },
    { part: "header-link", set: { "font-weight": 600, "letter-spacing": "0.02em" } },
    { part: "announcement", set: { "background-color": "#78350f", color: "#fffbeb", "text-align": "center" } },
    { part: "section-heading", set: { "font-weight": 600, "letter-spacing": "-0.01em" } },
    { part: "product-card", set: { "border-radius": "20px", "border-width": "1px", "border-color": "role:border", "box-shadow": "sm" } },
    { part: "product-card-title", set: { "font-weight": 600 } },
    { part: "product-card-price", set: { color: "role:accent-text", "font-weight": 700 } },
    { part: "collection-card", set: { "border-radius": "20px", "box-shadow": "md" } },
    { part: "badge", set: { "border-radius": "12px", "font-weight": 700 } },
  ],
};

const HAVEN = {
  format: "storeasy-theme/1",
  id: "haven",
  name: "Haven",
  version: "1.0.0",
  author: { name: "Storeasy" },
  description: "Calm and airy for home and living: slate and mist surfaces, a deep teal accent, clean sans headings and roomy sections.",
  base: "glow",
  tokens: { accent: "#0f766e", background: "#f8fafc", foreground: "#0f172a", radius: "lg", type_scale: "regular", button_shape: "rounded", section_spacing: "airy", heading_font: "sans" },
  surfaces: {
    header: { bg: "#f1f5f9", fg: "#0f172a", muted: "#475569" },
    hero: { bg: "#e2e8f0", fg: "#0f172a", muted: "#334155" },
  },
  templates: {
    pdp: "classic",
    collection: "sidebar",
    header: "centered",
    footer: "columns",
    home: {
      sections: [
        { kind: "hero", settings: { title: "Make room for calm.", highlight: "calm", subtitle: "Pieces for the home that are made to stay.", primary: link("Shop by room", "/collections"), image: null } },
        { kind: "collections", settings: { title: "Shop by room", limit: 6 } },
        { kind: "rich_text", settings: { title: "Built to last", html: "<p>Solid materials, simple care and a two-year promise on everything we make.</p>" } },
        { kind: "new", settings: { title: "New for the home", limit: 8 } },
      ],
    },
  },
  styles: [
    { part: "hero-title", set: { "font-weight": 600, "letter-spacing": "-0.025em", color: "role:hero-fg" } },
    { part: "hero-subtitle", set: { color: "role:hero-muted" } },
    { part: "header-link", set: { "font-weight": 500, "letter-spacing": "0.01em" } },
    { part: "announcement", set: { "background-color": "#134e4a", color: "#f0fdfa", "text-align": "center" } },
    { part: "section-heading", set: { "font-weight": 600, "letter-spacing": "-0.02em" } },
    { part: "section", set: { "padding-block": "4rem", gap: "1.75rem" } },
    { part: "product-card", set: { "border-radius": "16px", "border-width": "1px", "border-color": "role:border-soft", "box-shadow": "none" } },
    { part: "product-card-title", set: { "font-weight": 500 } },
    { part: "product-card-price", set: { color: "role:text-muted" } },
    { part: "collection-card", set: { "border-radius": "16px", "box-shadow": "sm" } },
    { part: "footer-link", set: { color: "role:text-muted" } },
  ],
};

// Card words for the Themes page and the onboarding picker (not in the package:
// the format has no vertical key).
const META = {
  volt: { vertical: "Nutrition and fitness" },
  bloom: { vertical: "Beauty and skincare" },
  loom: { vertical: "Apparel" },
  harvest: { vertical: "Food and pantry" },
  haven: { vertical: "Home and living" },
};

const freeze = (o) => {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) freeze(v);
    Object.freeze(o);
  }
  return o;
};

/** Every flagship package, newest version of each last. */
export const FLAGSHIPS = freeze([VOLT, BLOOM, LOOM, HARVEST, HAVEN]);
export const FLAGSHIP_SLUGS = Object.freeze([...new Set(FLAGSHIPS.map((p) => p.id))]);
export const isFlagshipSlug = (slug) => typeof slug === "string" && FLAGSHIP_SLUGS.includes(slug);

const cmpVersion = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
export const compareVersions = cmpVersion;

/** The newest package of a flagship slug, or null. */
export function latestFlagship(slug) {
  const all = FLAGSHIPS.filter((p) => p.id === slug);
  return all.length ? all.reduce((a, b) => (cmpVersion(b.version, a.version) > 0 ? b : a)) : null;
}

/** One flagship package by slug and version, or null. */
export const flagshipOf = (slug, version) => FLAGSHIPS.find((p) => p.id === slug && p.version === version) || null;

/** The newest flagships, one per slug, in FLAGSHIP_SLUGS order. */
export const latestFlagships = () => FLAGSHIP_SLUGS.map(latestFlagship);

/** A flagship's card words: { slug, name, version, vertical, description, base, headingFont, sample }. */
export const flagshipCard = (pkg) => ({ slug: pkg.id, name: pkg.name, version: pkg.version, vertical: META[pkg.id]?.vertical ?? "", description: pkg.description, base: pkg.base, headingFont: pkg.tokens.heading_font, sample: pkg.templates.home.sections[0]?.settings?.title ?? pkg.name });

/** The deterministic row id: thm_ + the first 16 hex of sha256("storeasy:<slug>@<version>"). */
export async function flagshipPackageId(slug, version) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`storeasy:${slug}@${version}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `thm_${hex.slice(0, 16)}`;
}
