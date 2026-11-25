// Phase 5 step 0: the theme package format `storeasy-theme/1`
// (docs/plans/phase-5.md "Package format"). One JSON file of data only: tokens,
// surfaces, templates and constrained styles. Nothing here runs a theme's code;
// a theme has none. Edge-safe: no node:* imports (the storefront imports this).
import { ROLE_IDS } from "../brand.js";

export const FORMAT = "storeasy-theme/1";

export const LIMITS = Object.freeze({
  bytes: 256 * 1024, // the whole file, UTF-8
  rules: 60, // styles[]
  depth: 12, // nesting levels
  nodes: 5000, // keys + array items + values, all together
  installed: 30, // installed (not archived) packages per store
  issues: 20, // refusals reported per upload
});

// A package's `base` is one of the built-in kits (lib/themes/kits.js KITS ids);
// it supplies the kit surfaces and fonts the package does not set.
export const BASES = Object.freeze(["pulse", "glow"]);

// A package's own id (its `id` key, stored as theme_packages.slug) and the
// data-theme attribute it renders under.
export const THEME_ID_RE = /^[a-z0-9-]{1,40}$/;
// theme_packages.id and doc_design.body.settings.theme.package
export const PACKAGE_ID_RE = /^thm_[0-9a-f]{16}$/;
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export const TOP_KEYS = Object.freeze(["format", "id", "name", "version", "author", "description", "base", "tokens", "surfaces", "templates", "styles"]);
export const SURFACES = Object.freeze({ header: ["bg", "fg", "muted"], hero: ["bg", "fg", "muted"] });
export const TEMPLATE_CHOICES = Object.freeze({
  pdp: ["classic", "editorial"],
  collection: ["standard", "sidebar"],
  header: ["standard", "centered"],
  footer: ["columns", "minimal"],
});
export const DESCRIPTION_MAX = 300;

// Storefront parts a style rule may target. None is inside the buy box, cart
// or checkout: those stay Storeasy's own.
export const PARTS = Object.freeze([
  "header",
  "header-link",
  "announcement",
  "footer",
  "footer-link",
  "hero",
  "hero-title",
  "hero-subtitle",
  "section",
  "section-heading",
  "product-card",
  "product-card-title",
  "product-card-price",
  "collection-card",
  "badge",
]);

// ---- property values ---------------------------------------------------------
// Each property's css(value) returns the CSS value Storeasy writes, or null when
// the value is refused. Values are matched whole by anchored patterns and the
// output is rebuilt from the match, so no character of a theme's own string
// that could end a declaration or a rule (;, }, <, quotes) ever reaches CSS.

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const ROLE_RE = /^role:([a-z][a-z-]*)$/;
const ROLE_SET = new Set(ROLE_IDS);

/** "#abc" → "#aabbcc"; anything else → null. */
export function fullHex(value) {
  if (typeof value !== "string" || !HEX_RE.test(value)) return null;
  const h = value.slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}

/** role:<id> → the role's CSS variable (app/globals.css, lib/brand.js ROLES). */
export const roleVar = (id) => `var(--sf-${id})`;

function color(value) {
  if (typeof value !== "string") return null;
  const hex = fullHex(value);
  if (hex) return hex;
  const m = ROLE_RE.exec(value);
  return m && ROLE_SET.has(m[1]) ? roleVar(m[1]) : null;
}

// A length in one unit within [min, max]; "0" is allowed bare.
function length(unit, min, max) {
  const re = new RegExp(`^(-?\\d{1,2}(?:\\.\\d{1,3})?)${unit}$`);
  return (value) => {
    if (value === "0" || value === 0) return "0";
    if (typeof value !== "string") return null;
    const m = re.exec(value);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= min && n <= max ? `${n}${unit}` : null;
  };
}

const oneOf = (...words) => (value) => (typeof value === "string" && words.includes(value) ? value : null);

export const SHADOWS = Object.freeze({
  none: "none",
  sm: "0 1px 2px rgb(0 0 0 / 0.06)",
  md: "0 4px 12px rgb(0 0 0 / 0.08)",
  lg: "0 12px 32px rgb(0 0 0 / 0.12)",
});

export const PROPS = Object.freeze({
  color: { hint: "a colour like #1f2937 or role:accent", css: color },
  "background-color": { hint: "a colour like #1f2937 or role:surface", css: color },
  "border-color": { hint: "a colour like #1f2937 or role:border", css: color },
  "border-width": { hint: "0px to 4px", css: length("px", 0, 4) },
  "border-radius": { hint: "0px to 48px", css: length("px", 0, 48) },
  "font-weight": {
    hint: "300 to 900, in steps of 100",
    css: (v) => {
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : NaN;
      return Number.isInteger(n) && n >= 300 && n <= 900 && n % 100 === 0 ? String(n) : null;
    },
  },
  "font-style": { hint: "normal or italic", css: oneOf("normal", "italic") },
  "letter-spacing": { hint: "-0.05em to 0.3em", css: (v) => (v === "normal" ? "normal" : length("em", -0.05, 0.3)(v)) },
  "text-transform": { hint: "none, uppercase, lowercase or capitalize", css: oneOf("none", "uppercase", "lowercase", "capitalize") },
  "text-align": { hint: "left, center, right, start or end", css: oneOf("left", "center", "right", "start", "end") },
  "padding-block": { hint: "0rem to 8rem", css: length("rem", 0, 8) },
  "padding-inline": { hint: "0rem to 8rem", css: length("rem", 0, 8) },
  gap: { hint: "0rem to 4rem", css: length("rem", 0, 4) },
  "box-shadow": { hint: "none, sm, md or lg", css: (v) => (typeof v === "string" && Object.hasOwn(SHADOWS, v) ? SHADOWS[v] : null) },
});

// Contrast a style rule needs when it sets both color and background-color,
// and that surfaces need between fg/muted and bg (lib/brand.js contrastRatio).
export const MIN_CONTRAST = 4.5;

// ---- refusals ------------------------------------------------------------------
// Matched against every key and string AFTER normalisation (entities decoded,
// whitespace and control/zero-width characters stripped, case folded); the
// scanner (line 1) does the normalising and the deep walk. The first match per
// place is reported as "<message> (at <path>)".
export const REFUSALS = Object.freeze([
  { id: "script", re: /<script/, message: "Themes can't contain scripts." },
  { id: "handler", re: /\bon[a-z]+=/, message: "Themes can't contain event handlers like onclick." },
  { id: "javascript", re: /javascript:|vbscript:|data:text\/html/, message: "Themes can't contain javascript: links." },
  { id: "import", re: /@import/, message: "Themes can't import other files." },
  { id: "url", re: /url\(/, message: "Themes can't load files with url(…)." },
  { id: "css-code", re: /expression\(|-moz-binding|behavior:/, message: "Themes can't contain code inside styles." },
  { id: "tag", re: /<(style|iframe|object|embed|link|meta|base|svg)/, message: "Themes can't contain HTML tags like <iframe>." },
  // outside a registry `link` field (the scanner knows which fields those are)
  { id: "external", re: /https?:\/\/|^\/\/[^/]/, message: "Themes can't load anything from other websites." },
]);

// A key named like an event handler (onClick, onload …).
export const EVENT_KEY_RE = /^on[a-z]/i;
export const EVENT_KEY_MESSAGE = "Themes can't contain event handlers like onclick.";

// Keys that would make a package more than data.
export const FORBIDDEN_KEYS = Object.freeze(["script", "scripts", "js", "css", "html", "head", "import", "imports", "__proto__", "constructor", "prototype"]);
export const dataOnlyMessage = (key) => `Themes are data only: remove "${key}".`;

export const MESSAGES = Object.freeze({
  notJson: "This file isn't a theme package: it isn't valid JSON.",
  tooBig: "Theme packages can be up to 256 KB.",
  tooDeep: `This theme is nested more than ${LIMITS.depth} levels deep.`,
  tooManyNodes: `This theme has more than ${LIMITS.nodes.toLocaleString("en-US")} values.`,
  wrongFormat: `This file isn't a theme package: its format must be "${FORMAT}".`,
  unknownKey: (key) => `Themes can't have a "${key}" setting.`,
  noAssets: "Themes can't include pictures or files yet: leave image fields empty.",
});
