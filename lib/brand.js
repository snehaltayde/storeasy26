// Brand design tokens (Session 35 / MC10, TOK-01 and TOK-02). Pure + edge-safe
// (client-safe: no imports). The server layout turns a tenant's
// `config.brand` into CSS variables, the console validates edits, and the
// storefront consumes ONLY the variables, so one config row re-skins the whole
// store.
//
// Resolution order (BE08): platform default (this file's DEFAULT_BRAND = the
// pre-S35 lime look) → theme kit defaults (S37) → tenant config.brand.
// Absent/invalid tenant values fall back per-token, so a broken row can never
// unstyle a storefront.
//
// TOK-01: the storefront's colours are SEMANTIC ROLES (surface, text, muted
// text, border, accent, text on accent, sale, success, danger, and the header
// and hero roles), each a CSS variable `--sf-<role>` that components use
// through Tailwind classes (`bg-sf-surface`, `text-sf-text-muted`, …). The
// role table is ROLES below. With no brand config, every role holds the
// value today's classes had (app/globals.css), so the platform default look is
// unchanged. A brand whose colours differ from the platform default gets
// every role derived from its own background, text and accent (brandRoles),
// so a dark brand gets light text everywhere, not only where `foreground`
// happened to be used.
//
// TOK-02: PAIRS lists every foreground-on-background role pair the storefront
// renders. checkBrand measures each one for a brand and theme kit and, with
// the live release's brand to compare against, says which failing pairs
// block a publish (changed) and which only warn (already live).

export const DEFAULT_BRAND = {
  accent: "#84cc16", // lime-500 — the pre-S35 hardcoded palette
  background: "#ffffff",
  foreground: "#0a0a0b",
  radius: "md", // sm | md | lg | xl  (cards/buttons scale together)
  type_scale: "regular", // compact | regular | large
  // S55 (audit slice 4): composition tokens, not just color. Defaults match
  // the pre-S55 hardcoded look exactly (pill buttons, py-14 sections), so
  // existing tenants render byte-identically until they choose otherwise.
  button_shape: "pill", // pill | rounded | square
  section_spacing: "regular", // compact | regular | airy
};

export const RADIUS_STEPS = { sm: "0.375rem", md: "0.75rem", lg: "1rem", xl: "1.5rem" };
export const TYPE_SCALES = { compact: "0.94", regular: "1", large: "1.08" };
export const BUTTON_SHAPES = { pill: "9999px", rounded: "0.75rem", square: "0.25rem" };
export const SECTION_SPACING = { compact: "2.25rem", regular: "3.5rem", airy: "5rem" };
// Phase 7 line 1: the heading face. Not in DEFAULT_BRAND: absent means the
// kit decides (Pulse sans, Glow serif), so a brand without it renders
// byte-identical CSS. Both faces are self-hosted (app/fonts/fonts.js).
export const HEADING_FONTS = { sans: "var(--font-geist-sans), system-ui, sans-serif", serif: "var(--font-fraunces), Georgia, serif" };
// every key a stored brand may hold (accent_label is worked out, not chosen)
export const BRAND_TOKEN_KEYS = Object.freeze([...Object.keys(DEFAULT_BRAND), "heading_font"]);

const HEX = /^#[0-9a-fA-F]{6}$/;

// ---- color math (hex ↔ HSL) ------------------------------------------------

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r, g, b) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// `from` moved toward `to` by t (0 = from, 1 = to), in sRGB.
export function mixHex(from, to, t) {
  const [a, b] = [hexToRgb(from), hexToRgb(to)];
  return toHex(...a.map((v, i) => v + (b[i] - v) * t));
}

function rgbToHsl(r, g, b) {
  (r /= 255), (g /= 255), (b /= 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// Shade ladder: the tenant picks ONE accent; we derive the 50–900 scale by
// interpolating lightness FROM the input's own lightness (hue/saturation
// kept) — anchored this way the ladder stays monotonic whatever the input,
// where fixed lightness positions would invert around a very dark or very
// light pick. The given hex IS the 500 step.
const LIGHT_T = { 50: 0.94, 100: 0.86, 200: 0.72, 300: 0.52, 400: 0.28 }; // toward 0.97
const DARK_T = { 600: 0.18, 700: 0.34, 800: 0.48, 900: 0.6 }; // toward 0

export function accentShades(hex) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const shades = { 500: hex.toLowerCase() };
  for (const [step, t] of Object.entries(LIGHT_T)) shades[step] = toHex(...hslToRgb(h, s, l + (0.97 - l) * t));
  for (const [step, t] of Object.entries(DARK_T)) shades[step] = toHex(...hslToRgb(h, Math.min(1, s * 1.05), Math.max(0.02, l * (1 - t))));
  return shades;
}

// ---- WCAG contrast ----------------------------------------------------------

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA, hexB) {
  const [la, lb] = [relativeLuminance(hexA), relativeLuminance(hexB)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const isDarkHex = (hex) => contrastRatio(hex, "#000000") < contrastRatio(hex, "#ffffff");

// ---- TOK-01 role table ------------------------------------------------------

// Tailwind v4 palette entries the default roles come from. `css` is the exact
// value in tailwindcss/theme.css (globals.css carries it, so a role renders
// exactly as the class it replaced did); `hex` is its sRGB value for the
// contrast maths here.
export const PALETTE = {
  white: { css: "#fff", hex: "#ffffff" },
  black: { css: "#000", hex: "#000000" },
  "zinc-50": { css: "oklch(98.5% 0 0)", hex: "#fafafa" },
  "zinc-100": { css: "oklch(96.7% 0.001 286.375)", hex: "#f4f4f5" },
  "zinc-200": { css: "oklch(92% 0.004 286.32)", hex: "#e4e4e7" },
  "zinc-300": { css: "oklch(87.1% 0.006 286.286)", hex: "#d4d4d8" },
  "zinc-400": { css: "oklch(70.5% 0.015 286.067)", hex: "#9f9fa9" },
  "zinc-500": { css: "oklch(55.2% 0.016 285.938)", hex: "#71717b" },
  "zinc-600": { css: "oklch(44.2% 0.017 285.786)", hex: "#52525c" },
  "zinc-700": { css: "oklch(37% 0.013 285.805)", hex: "#3f3f46" },
  "zinc-800": { css: "oklch(27.4% 0.006 286.033)", hex: "#27272a" },
  "zinc-900": { css: "oklch(21% 0.006 285.885)", hex: "#18181b" },
  "zinc-950": { css: "oklch(14.1% 0.005 285.823)", hex: "#09090b" },
  "lime-50": { css: "oklch(98.6% 0.031 120.757)", hex: "#f7fee7" },
  "lime-100": { css: "oklch(96.7% 0.067 122.328)", hex: "#ecfcca" },
  "lime-700": { css: "oklch(53.2% 0.157 131.589)", hex: "#497d00" },
  "lime-800": { css: "oklch(45.3% 0.124 130.933)", hex: "#3c6300" },
  "amber-50": { css: "oklch(98.7% 0.022 95.277)", hex: "#fffbeb" },
  "amber-100": { css: "oklch(96.2% 0.059 95.617)", hex: "#fef3c6" },
  "amber-200": { css: "oklch(92.4% 0.12 95.746)", hex: "#fee685" },
  "amber-700": { css: "oklch(55.5% 0.163 48.998)", hex: "#bb4d00" },
  "amber-800": { css: "oklch(47.3% 0.137 46.201)", hex: "#973c00" },
  "red-50": { css: "oklch(97.1% 0.013 17.38)", hex: "#fef2f2" },
  "red-200": { css: "oklch(88.5% 0.062 18.334)", hex: "#ffc9c9" },
  "red-600": { css: "oklch(57.7% 0.245 27.325)", hex: "#e7000b" },
};

// Status hues as full ladders (light → dark), for correcting a status colour
// on a brand's own background without leaving its hue.
const STATUS_LADDERS = {
  lime: ["#f7fee7", "#ecfcca", "#d8f999", "#bbf451", "#9ae600", "#7ccf00", "#5ea500", "#497d00", "#3c6300", "#35530e", "#192e03"],
  amber: ["#fffbeb", "#fef3c6", "#fee685", "#ffd230", "#ffb900", "#fe9a00", "#e17100", "#bb4d00", "#973c00", "#7b3306", "#461901"],
  red: ["#fef2f2", "#ffe2e2", "#ffc9c9", "#ffa2a2", "#ff6467", "#fb2c36", "#e7000b", "#c10007", "#9f0712", "#82181a", "#460809"],
};
const STEP_INDEX = { 50: 0, 100: 1, 200: 2, 300: 3, 400: 4, 500: 5, 600: 6, 700: 7, 800: 8, 900: 9, 950: 10 };

// The accent ladder globals.css carries when no brand is set (Tailwind v3
// lime as hex; a set brand emits accentShades(accent) instead).
export const DEFAULT_ACCENT_LADDER = {
  50: "#f7fee7", 100: "#ecfccb", 200: "#d9f99d", 300: "#bef264", 400: "#a3e635",
  500: "#84cc16", 600: "#65a30d", 700: "#4d7c0f", 800: "#3f6212", 900: "#365314",
};

// Header and hero surfaces per theme kit (the [data-kit] blocks in
// globals.css; the two must stay in step).
export const KIT_SURFACES = {
  "pulse-1": { header: { bg: "#09090b", fg: "#ffffff", muted: "#d4d4d8" }, hero: { bg: "#09090b", fg: "#ffffff", muted: "#d4d4d8" } },
  "glow-1": { header: { bg: "#fffbf7", fg: "#1c1917", muted: "#78716c" }, hero: { bg: "#fff1ee", fg: "#1c1917", muted: "#57534e" } },
};
export const DEFAULT_KIT = "pulse-1";
// Phase 5 line 2: an uploaded theme package's own `surfaces` (header and hero
// bg/fg/muted) laid over its kit's. Only #rrggbb values count; anything else
// keeps the kit's value, so a hand-edited row can't put text into the CSS.
const SURFACE_HEX = /^#[0-9a-f]{6}$/i;
export const kitSurfaces = (kit, surfaces = null) => {
  const base = KIT_SURFACES[kit] || KIT_SURFACES[DEFAULT_KIT];
  if (!surfaces || typeof surfaces !== "object") return base;
  const out = {};
  for (const part of Object.keys(base)) {
    out[part] = { ...base[part] };
    for (const key of Object.keys(base[part])) {
      const v = surfaces[part]?.[key];
      if (typeof v === "string" && SURFACE_HEX.test(v)) out[part][key] = v.toLowerCase();
    }
  }
  return out;
};

// Every storefront colour role. `css` is the default in globals.css (today's
// value: no brand config renders exactly as before TOK-01). `from` says how a
// brand derives it:
//   bg / fg               the brand's background / text colour
//   mix:t                 background mixed t of the way to the text colour
//                         (t taken from where today's zinc step sits between
//                         white and #0a0a0b), then darkened or lightened just
//                         enough that every pair it is used in passes
//   ladder:N              accent ladder step N, moved to the nearest step that
//                         passes every pair it is used in (ladder:N:fixed never
//                         moves; ladder:N:hover moves until the button label
//                         on it passes)
//   tint:t                light background: ladder step as `ladder`; dark
//                         background: the accent mixed t into the background
//   status:hue:N[:tint]   like ladder/tint, on a fixed status hue
//   kit:part.key          the theme kit's header/hero surface
//   fixed                 never derived (photo overlays, media placeholders)
//   alias:role            always equals another role (CSS var alias)
export const ROLES = [
  // surfaces
  { id: "surface", css: "var(--background)", hex: "#ffffff", from: "bg", label: "page background", replaces: "bg-white" },
  { id: "surface-muted", css: PALETTE["zinc-50"].css, hex: PALETTE["zinc-50"].hex, from: "mix:0.0204", label: "muted surface (panels, footer)", replaces: "bg-zinc-50" },
  { id: "surface-sunken", css: PALETTE["zinc-100"].css, hex: PALETTE["zinc-100"].hex, from: "mix:0.0436", label: "sunken surface (image wells, steppers)", replaces: "bg-zinc-100" },
  { id: "surface-strong", css: PALETTE["zinc-200"].css, hex: PALETTE["zinc-200"].hex, from: "mix:0.106", label: "strong surface (inactive steps, disabled fills)", replaces: "bg-zinc-200" },
  { id: "surface-disabled", css: PALETTE["zinc-300"].css, hex: PALETTE["zinc-300"].hex, from: "mix:0.170", label: "disabled button fill", replaces: "bg-zinc-300" },
  // text
  { id: "foreground", css: "var(--foreground)", hex: "#0a0a0b", from: "brandfg", label: "inherited text (no colour class: headings, labels)", replaces: "(inherited from body text-foreground)" },
  { id: "text", css: PALETTE["zinc-900"].css, hex: PALETTE["zinc-900"].hex, from: "fg", label: "text (titles, prices, headings)", replaces: "text-zinc-900" },
  { id: "text-soft", css: PALETTE["zinc-800"].css, hex: PALETTE["zinc-800"].hex, from: "mix:0.880", label: "soft text", replaces: "text-zinc-800" },
  { id: "text-body", css: PALETTE["zinc-700"].css, hex: PALETTE["zinc-700"].hex, from: "mix:0.775", label: "body copy", replaces: "text-zinc-700" },
  { id: "text-muted", css: PALETTE["zinc-600"].css, hex: PALETTE["zinc-600"].hex, from: "mix:0.695", label: "muted text", replaces: "text-zinc-600" },
  { id: "text-subtle", css: PALETTE["zinc-500"].css, hex: PALETTE["zinc-500"].hex, from: "mix:0.572", label: "subtle text", replaces: "text-zinc-500" },
  { id: "text-faint", css: PALETTE["zinc-400"].css, hex: PALETTE["zinc-400"].hex, from: "mix:0.381", label: "faint text (captions, old prices)", replaces: "text-zinc-400" },
  { id: "placeholder", css: null, hex: "#898a8b", from: "mix:0.5", label: "placeholder text in fields", replaces: "(Tailwind's default: half the field's text colour)" },
  { id: "mark", css: PALETTE["zinc-300"].css, hex: PALETTE["zinc-300"].hex, from: "mix:0.170", label: "marks (arrows, separators, icon buttons)", replaces: "text-zinc-300" },
  // borders
  { id: "border-soft", css: PALETTE["zinc-100"].css, hex: PALETTE["zinc-100"].hex, from: "mix:0.0436", label: "soft border and dividers", replaces: "border-zinc-100, divide-zinc-100" },
  { id: "border", css: PALETTE["zinc-200"].css, hex: PALETTE["zinc-200"].hex, from: "mix:0.106", label: "border", replaces: "border-zinc-200" },
  { id: "border-strong", css: PALETTE["zinc-300"].css, hex: PALETTE["zinc-300"].hex, from: "mix:0.170", label: "strong border", replaces: "border-zinc-300" },
  { id: "border-hover", css: PALETTE["zinc-400"].css, hex: PALETTE["zinc-400"].hex, from: "mix:0.381", label: "hover and focus border", replaces: "border-zinc-400" },
  // inverse (solid neutral buttons and selected chips)
  { id: "inverse", css: PALETTE["zinc-900"].css, hex: PALETTE["zinc-900"].hex, from: "fg", label: "solid button / selected chip", replaces: "bg-zinc-900, border-zinc-900, ring-zinc-900" },
  { id: "inverse-hover", css: PALETTE["zinc-800"].css, hex: PALETTE["zinc-800"].hex, from: "mix:0.880:hover", label: "solid button hover", replaces: "hover:bg-zinc-800" },
  { id: "on-inverse", css: PALETTE.white.css, hex: PALETTE.white.hex, from: "bg", label: "text on a solid button", replaces: "text-white (on zinc-900)" },
  { id: "on-inverse-muted", css: PALETTE["zinc-300"].css, hex: PALETTE["zinc-300"].hex, from: "mix:0.170", label: "muted text on a solid chip", replaces: "text-zinc-300 (on zinc-900)" },
  // accent
  { id: "accent", css: "var(--accent-400)", hex: null, from: "ladder:400:fixed", label: "accent (buttons, badges, announcement bar)", replaces: "bg-accent-400" },
  { id: "accent-hover", css: "var(--accent-300)", hex: null, from: "ladder:300:hover", label: "accent hover", replaces: "hover:bg-accent-300" },
  { id: "on-accent", css: "var(--accent-label)", hex: null, from: "label", label: "text on accent", replaces: "text-accent-label" },
  { id: "accent-text", css: "var(--accent-700)", hex: null, from: "ladder:700", label: "accent text and links", replaces: "text-accent-700, .rte a (was lime on every store)" },
  { id: "accent-strong", css: "var(--accent-600)", hex: null, from: "ladder:600", label: "accent in the footer wordmark", replaces: "text-accent-600" },
  { id: "accent-mark", css: "var(--accent-500)", hex: null, from: "ladder:500", label: "accent marks (selected thumbnail, checkout wordmark)", replaces: "text-accent-500, border-accent-500" },
  { id: "accent-soft", css: "var(--accent-100)", hex: null, from: "tint:100:0.22", label: "accent tint (chips, banner)", replaces: "bg-accent-100" },
  { id: "on-accent-soft", css: "var(--accent-800)", hex: null, from: "ladder:800", label: "text on accent tint", replaces: "text-accent-800" },
  { id: "on-accent-soft-strong", css: "var(--accent-900)", hex: null, from: "ladder:900", label: "heading on accent tint", replaces: "text-accent-900" },
  { id: "accent-subtle", css: "var(--accent-50)", hex: null, from: "tint:50:0.12", label: "faint accent tint (applied coupon)", replaces: "bg-accent-50" },
  { id: "accent-border", css: "var(--accent-200)", hex: null, from: "tint:200:0.4", label: "accent tint border", replaces: "border-accent-200" },
  // sale (aliases of accent today, so a palette can give sale its own colour later)
  { id: "sale", css: "var(--sf-accent)", hex: null, from: "alias:accent", label: "sale badge", replaces: "bg-accent-400 (discount badge)" },
  { id: "on-sale", css: "var(--sf-on-accent)", hex: null, from: "alias:on-accent", label: "text on sale badge", replaces: "text-accent-label (discount badge)" },
  { id: "sale-soft", css: "var(--sf-accent-soft)", hex: null, from: "alias:accent-soft", label: "savings chip", replaces: "bg-accent-100 (Save N%)" },
  { id: "on-sale-soft", css: "var(--sf-on-accent-soft)", hex: null, from: "alias:on-accent-soft", label: "text on savings chip", replaces: "text-accent-800 (Save N%)" },
  // status
  { id: "success", css: PALETTE["lime-700"].css, hex: PALETTE["lime-700"].hex, from: "status:lime:700", label: "success text", replaces: "text-lime-700" },
  { id: "success-strong", css: PALETTE["lime-800"].css, hex: PALETTE["lime-800"].hex, from: "status:lime:800", label: "strong success text", replaces: "text-lime-800" },
  { id: "success-surface", css: PALETTE["lime-50"].css, hex: PALETTE["lime-50"].hex, from: "status:lime:50:0.14", label: "success panel", replaces: "bg-lime-50" },
  { id: "success-soft", css: PALETTE["lime-100"].css, hex: PALETTE["lime-100"].hex, from: "status:lime:100:0.22", label: "success chip", replaces: "bg-lime-100" },
  { id: "warning", css: PALETTE["amber-700"].css, hex: PALETTE["amber-700"].hex, from: "status:amber:700", label: "warning text", replaces: "text-amber-700, text-amber-600" },
  { id: "warning-strong", css: PALETTE["amber-800"].css, hex: PALETTE["amber-800"].hex, from: "status:amber:800", label: "strong warning text", replaces: "text-amber-800" },
  { id: "warning-surface", css: PALETTE["amber-50"].css, hex: PALETTE["amber-50"].hex, from: "status:amber:50:0.14", label: "warning panel", replaces: "bg-amber-50" },
  { id: "warning-soft", css: PALETTE["amber-100"].css, hex: PALETTE["amber-100"].hex, from: "status:amber:100:0.22", label: "warning chip", replaces: "bg-amber-100" },
  { id: "warning-border", css: PALETTE["amber-200"].css, hex: PALETTE["amber-200"].hex, from: "status:amber:200:0.4", label: "warning border", replaces: "border-amber-200" },
  { id: "danger", css: PALETTE["red-600"].css, hex: PALETTE["red-600"].hex, from: "status:red:600", label: "error text", replaces: "text-red-600, text-red-500" },
  { id: "danger-surface", css: PALETTE["red-50"].css, hex: PALETTE["red-50"].hex, from: "status:red:50:0.14", label: "error panel", replaces: "bg-red-50" },
  { id: "danger-border", css: PALETTE["red-200"].css, hex: PALETTE["red-200"].hex, from: "status:red:200:0.4", label: "error border", replaces: "border-red-200" },
  // header and hero (the kit's surfaces, plus the accent shown on them)
  { id: "header", css: "var(--header-bg)", hex: null, from: "kit:header.bg", label: "header background", replaces: "bg-header" },
  { id: "header-fg", css: "var(--header-fg)", hex: null, from: "kit:header.fg", label: "header text", replaces: "text-header-fg, text-white (cart icon)" },
  { id: "header-muted", css: "var(--header-muted)", hex: null, from: "kit:header.muted", label: "header links", replaces: "text-header-muted" },
  { id: "header-accent", css: "var(--accent-400)", hex: null, from: "ladder:400", label: "accent in the header wordmark", replaces: "text-accent-400 (header)" },
  { id: "hero", css: "var(--hero-bg)", hex: null, from: "kit:hero.bg", label: "hero background", replaces: "bg-hero" },
  { id: "hero-fg", css: "var(--hero-fg)", hex: null, from: "kit:hero.fg", label: "hero text", replaces: "text-hero-fg" },
  { id: "hero-muted", css: "var(--hero-muted)", hex: null, from: "kit:hero.muted", label: "hero subtitle", replaces: "text-hero-muted" },
  { id: "hero-accent", css: "var(--accent-400)", hex: null, from: "ladder:400", label: "hero highlight and badge", replaces: "text-accent-400, bg-accent-400 (hero)" },
  { id: "hero-glow", css: "var(--accent-500)", hex: null, from: "ladder:500:fixed", label: "hero glow (decoration)", replaces: "bg-accent-500/20" },
  // photos and media placeholders: never brand-driven
  { id: "overlay", css: PALETTE.black.css, hex: PALETTE.black.hex, from: "fixed", label: "scrim over the page or a photo", replaces: "bg-black/40, from-black/75, via-black/10" },
  { id: "on-overlay", css: PALETTE.white.css, hex: PALETTE.white.hex, from: "fixed", label: "text on a photo", replaces: "text-white (on images)" },
  { id: "media", css: PALETTE["zinc-900"].css, hex: PALETTE["zinc-900"].hex, from: "fixed", label: "behind a collection photo", replaces: "bg-zinc-900 (collection card)" },
  { id: "media-from", css: PALETTE["zinc-800"].css, hex: PALETTE["zinc-800"].hex, from: "fixed", label: "image placeholder, top", replaces: "from-zinc-800" },
  { id: "media-to", css: PALETTE["zinc-950"].css, hex: PALETTE["zinc-950"].hex, from: "fixed", label: "image placeholder, bottom", replaces: "to-zinc-950" },
];
export const ROLE_IDS = ROLES.map((r) => r.id);
const ROLE = Object.fromEntries(ROLES.map((r) => [r.id, r]));

// Radius roles (TOK-01 "radii"): each a fixed multiple of the brand radius,
// so the default md radius (0.75rem) gives exactly today's Tailwind steps.
export const RADIUS_ROLES = {
  card: { css: "calc(var(--brand-radius) * 4 / 3)", replaces: "rounded-2xl" },
  control: { css: "var(--brand-radius)", replaces: "rounded-xl" },
  small: { css: "calc(var(--brand-radius) * 2 / 3)", replaces: "rounded-lg" },
  xs: { css: "calc(var(--brand-radius) / 2)", replaces: "rounded-md" },
  "2xs": { css: "calc(var(--brand-radius) / 3)", replaces: "rounded" },
};

// ---- TOK-02 pairing matrix --------------------------------------------------

// Every foreground-on-background role pair a storefront renderer draws.
// kind: text (needs 4.5:1), large (3:1: 24px+, or 18.66px+ bold), mark (3:1:
// an icon or an outline that carries meaning), decorative and disabled (listed
// and measured, never enforced: WCAG exempts them). `fix` is the founder's
// colour that moves the pair. `where` names a renderer that draws it.
export const PAIRS = [
  { id: "body", fg: "text", bg: "surface", kind: "text", fix: "foreground", label: "Product titles, prices and body text", where: "components/ProductCard.js" },
  { id: "inherited", fg: "foreground", bg: "surface", kind: "text", fix: "foreground", label: "Headings and labels with no colour of their own", where: "components/checkout/CheckoutFlow.js" },
  { id: "inherited-panel", fg: "foreground", bg: "surface-muted", kind: "text", fix: "foreground", label: "Headings on light panels", where: "components/cart/CartDrawer.js" },
  { id: "inherited-sunken", fg: "foreground", bg: "surface-sunken", kind: "text", fix: "foreground", label: "Labels on grey chips", where: "components/ProductPurchase.js" },
  { id: "text-muted-surface", fg: "text", bg: "surface-muted", kind: "text", fix: "foreground", label: "Text on light panels", where: "components/cart/CartDrawer.js" },
  { id: "text-sunken", fg: "text", bg: "surface-sunken", kind: "text", fix: "foreground", label: "Text on grey chips and steppers", where: "components/ProductPurchase.js" },
  { id: "text-soft", fg: "text-soft", bg: "surface", kind: "text", fix: "foreground", label: "Menu items and questions", where: "components/FaqSection.js" },
  { id: "text-soft-muted", fg: "text-soft", bg: "surface-muted", kind: "text", fix: "foreground", label: "Menu items on hover", where: "components/Header.js" },
  { id: "text-body", fg: "text-body", bg: "surface", kind: "text", fix: "foreground", label: "Body copy and option labels", where: "components/ProductPurchase.js" },
  { id: "text-body-sunken", fg: "text-body", bg: "surface-sunken", kind: "text", fix: "foreground", label: "Body copy on grey chips", where: "components/SearchBox.js" },
  { id: "text-body-panel", fg: "text-body", bg: "surface-muted", kind: "text", fix: "foreground", label: "Body copy on light panels (no search results, buttons on hover)", where: "components/cart/CartDrawer.js" },
  { id: "text-muted", fg: "text-muted", bg: "surface", kind: "text", fix: "foreground", label: "Muted text", where: "components/cart/CartDrawer.js" },
  { id: "text-muted-panel", fg: "text-muted", bg: "surface-muted", kind: "text", fix: "foreground", label: "Muted text on light panels", where: "components/Footer.js" },
  { id: "text-muted-sunken", fg: "text-muted", bg: "surface-sunken", kind: "text", fix: "foreground", label: "Muted text on grey chips", where: "components/SearchBox.js" },
  { id: "text-subtle", fg: "text-subtle", bg: "surface", kind: "text", fix: "foreground", label: "Secondary text (labels, notes)", where: "components/checkout/CheckoutFlow.js" },
  { id: "text-subtle-panel", fg: "text-subtle", bg: "surface-muted", kind: "text", fix: "foreground", label: "Secondary text on light panels (footer links)", where: "components/Footer.js" },
  { id: "text-subtle-sunken", fg: "text-subtle", bg: "surface-sunken", kind: "text", fix: "foreground", label: "Secondary text on grey chips", where: "components/ProductPurchase.js" },
  { id: "text-subtle-strong", fg: "text-subtle", bg: "surface-strong", kind: "text", fix: "foreground", label: "Step numbers still to come in checkout", where: "components/checkout/CheckoutFlow.js" },
  { id: "text-faint", fg: "text-faint", bg: "surface", kind: "text", fix: "foreground", label: "Small grey text (product types, old prices, captions)", where: "components/ProductCard.js" },
  { id: "text-faint-panel", fg: "text-faint", bg: "surface-muted", kind: "text", fix: "foreground", label: "Small grey text on light panels", where: "components/Footer.js" },
  { id: "text-faint-sunken", fg: "text-faint", bg: "surface-sunken", kind: "text", fix: "foreground", label: "Small grey text on grey chips and image wells", where: "components/ProductCard.js" },
  { id: "mark", fg: "mark", bg: "surface", kind: "text", fix: "foreground", label: "Arrows, separators and small symbol buttons (× + →)", where: "components/cart/CartDrawer.js" },
  { id: "placeholder", fg: "placeholder", bg: "surface", kind: "text", fix: "foreground", label: "Placeholder text in fields (coupon code, address)", where: "components/cart/CartDrawer.js" },
  { id: "placeholder-muted", fg: "placeholder", bg: "surface-muted", kind: "text", fix: "foreground", label: "Placeholder text in the search box", where: "components/SearchBox.js" },
  { id: "disabled-option", fg: "mark", bg: "surface", kind: "disabled", fix: "foreground", label: "Sold-out options (struck through)", where: "components/ProductPurchase.js" },
  { id: "disabled-solid-button", fg: "on-inverse", bg: "surface-disabled", kind: "disabled", fix: "foreground", label: "Disabled Continue button in checkout", where: "components/checkout/CheckoutFlow.js" },
  { id: "disabled-button", fg: "text-faint", bg: "surface-strong", kind: "disabled", fix: "foreground", label: "Disabled buttons", where: "components/BundleAddButton.js" },
  { id: "on-inverse", fg: "on-inverse", bg: "inverse", kind: "text", fix: "foreground", label: "Text on dark buttons and selected chips", where: "components/checkout/CheckoutFlow.js" },
  { id: "on-inverse-hover", fg: "on-inverse", bg: "inverse-hover", kind: "text", fix: "foreground", label: "Text on dark buttons, on hover", where: "components/checkout/CheckoutFlow.js" },
  { id: "on-inverse-muted", fg: "on-inverse-muted", bg: "inverse", kind: "text", fix: "foreground", label: "Counts on selected chips", where: "app/(storefront)/collections/[handle]/page.js" },
  { id: "inverse-mark", fg: "inverse", bg: "surface", kind: "mark", fix: "foreground", label: "Selected option outline", where: "components/checkout/CheckoutFlow.js" },
  { id: "accent-text", fg: "accent-text", bg: "surface", kind: "text", fix: "accent", label: "Links and accent text", where: "components/sections/HomeSections.js" },
  { id: "accent-text-panel", fg: "accent-text", bg: "surface-muted", kind: "text", fix: "accent", label: "Links on light panels", where: "components/cart/CartDrawer.js" },
  { id: "accent-text-sunken", fg: "accent-text", bg: "surface-sunken", kind: "text", fix: "accent", label: "Links on grey chips (the search box's View all, on hover)", where: "components/SearchBox.js" },
  { id: "accent-text-soft", fg: "accent-text", bg: "accent-soft", kind: "text", fix: "accent", label: "Accent text on accent tint (order confirmed tick)", where: "app/(storefront)/checkout/confirmation/[orderId]/page.js" },
  { id: "accent-text-subtle", fg: "accent-text", bg: "accent-subtle", kind: "text", fix: "accent", label: "The saving on an applied coupon", where: "components/cart/CartDrawer.js" },
  { id: "text-muted-accent-subtle", fg: "text-muted", bg: "accent-subtle", kind: "text", fix: "foreground", label: "Words on an applied coupon (Coupon, Remove)", where: "components/cart/CartDrawer.js" },
  { id: "text-soft-accent-subtle", fg: "text-soft", bg: "accent-subtle", kind: "text", fix: "foreground", label: "Remove on an applied coupon, on hover", where: "components/cart/CartDrawer.js" },
  { id: "accent-strong", fg: "accent-strong", bg: "surface-muted", kind: "large", fix: "accent", label: "Footer wordmark accent", where: "components/Footer.js" },
  { id: "accent-mark", fg: "accent-mark", bg: "surface", kind: "large", fix: "accent", label: "Checkout wordmark accent and the selected photo outline", where: "components/checkout/CheckoutFlow.js" },
  { id: "on-accent", fg: "on-accent", bg: "accent", kind: "text", fix: "accent", label: "Button text on the accent colour", where: "components/ProductPurchase.js" },
  { id: "on-accent-hover", fg: "on-accent", bg: "accent-hover", kind: "text", fix: "accent", label: "Button text on the accent colour, on hover", where: "components/ProductPurchase.js" },
  { id: "on-accent-soft", fg: "on-accent-soft", bg: "accent-soft", kind: "text", fix: "accent", label: "Text on accent chips", where: "components/pdp/PdpLayouts.js" },
  { id: "on-accent-soft-strong", fg: "on-accent-soft-strong", bg: "accent-soft", kind: "large", fix: "accent", label: "Banner heading", where: "components/sections/HomeSections.js" },
  { id: "on-accent-subtle", fg: "on-accent-soft", bg: "accent-subtle", kind: "text", fix: "accent", label: "Applied coupon code", where: "components/cart/CartDrawer.js" },
  { id: "on-sale", fg: "on-sale", bg: "sale", kind: "text", fix: "accent", label: "Sale badge", where: "components/ProductCard.js" },
  { id: "on-sale-soft", fg: "on-sale-soft", bg: "sale-soft", kind: "text", fix: "accent", label: "Savings chip", where: "components/ProductPurchase.js" },
  { id: "success", fg: "success", bg: "success-surface", kind: "text", fix: "background", label: "Success messages", where: "components/account/ProfileForm.js" },
  { id: "success-chip", fg: "success", bg: "success-soft", kind: "text", fix: "background", label: "Success chips", where: "components/account/ReturnRequest.js" },
  { id: "success-plain", fg: "success", bg: "surface", kind: "text", fix: "background", label: "Success text on the page", where: "components/QuizRunner.js" },
  { id: "success-strong", fg: "success-strong", bg: "success-surface", kind: "text", fix: "background", label: "Wishlist notes", where: "components/WishlistPage.js" },
  { id: "warning", fg: "warning", bg: "warning-soft", kind: "text", fix: "background", label: "Warning chips", where: "components/account/ReturnRequest.js" },
  { id: "warning-panel", fg: "warning", bg: "warning-surface", kind: "text", fix: "background", label: "Warning notes", where: "app/(storefront)/orders/[orderId]/page.js" },
  { id: "warning-plain", fg: "warning", bg: "surface", kind: "text", fix: "background", label: "Warning text on the page", where: "components/WishlistPage.js" },
  { id: "warning-strong", fg: "warning-strong", bg: "warning-surface", kind: "text", fix: "background", label: "Warning panels", where: "components/cart/CartDrawer.js" },
  { id: "danger", fg: "danger", bg: "danger-surface", kind: "text", fix: "background", label: "Error messages", where: "components/checkout/CheckoutFlow.js" },
  { id: "danger-plain", fg: "danger", bg: "surface", kind: "text", fix: "background", label: "Error text on the page", where: "app/(storefront)/account/orders/[orderId]/page.js" },
  { id: "danger-panel", fg: "danger", bg: "surface-muted", kind: "text", fix: "background", label: "A cancelled shipment on the order page", where: "app/(storefront)/orders/[orderId]/page.js" },
  { id: "header-fg", fg: "header-fg", bg: "header", kind: "text", fix: null, label: "Header text and icons", where: "components/Header.js" },
  { id: "header-muted", fg: "header-muted", bg: "header", kind: "text", fix: null, label: "Header links", where: "components/Header.js" },
  { id: "header-accent", fg: "header-accent", bg: "header", kind: "large", fix: "accent", label: "Header wordmark accent", where: "components/Header.js" },
  { id: "hero-fg", fg: "hero-fg", bg: "hero", kind: "text", fix: null, label: "Hero title and second button", where: "app/(storefront)/page.js" },
  { id: "hero-muted", fg: "hero-muted", bg: "hero", kind: "text", fix: null, label: "Hero subtitle", where: "app/(storefront)/page.js" },
  { id: "hero-accent", fg: "hero-accent", bg: "hero", kind: "text", fix: "accent", label: "Hero highlight and badge", where: "app/(storefront)/page.js" },
  { id: "on-overlay", fg: "on-overlay", bg: "media-from", kind: "text", fix: null, label: "Collection names on their cards", where: "components/CollectionCard.js" },
  { id: "on-overlay-media", fg: "on-overlay", bg: "media", kind: "text", fix: null, label: "Collection names on the card behind the photo", where: "components/CollectionCard.js" },
  { id: "quiz-progress", fg: "accent", bg: "surface-sunken", kind: "decorative", fix: "accent", label: "Quiz progress bar (the step count is also written out)", where: "components/QuizRunner.js" },
  { id: "hero-dot", fg: "hero-accent", bg: "hero", kind: "decorative", fix: "accent", label: "Dot in the hero badge", where: "app/(storefront)/page.js" },
  { id: "hero-glow", fg: "hero-glow", bg: "hero", kind: "decorative", fix: "accent", label: "Glow behind the hero", where: "app/(storefront)/page.js" },
  { id: "hero-button", fg: "on-accent", bg: "accent", kind: "text", fix: "accent", label: "Hero button", where: "app/(storefront)/page.js" },
];
export const PAIR_NEEDS = { text: 4.5, large: 3, mark: 3, decorative: 0, disabled: 0 };
const enforced = (p) => PAIR_NEEDS[p.kind] > 0;

// ---- validation (console writes) --------------------------------------------

// Returns { ok, errors, warnings, value } — value normalized for storage.
// TOK-02: only a malformed value is an error here (a bad hex, an unknown
// step). Readability is the pairing matrix's job (checkBrand): a save never
// fails midway through a custom colour; publishing refuses a changed pair
// that fails. We also compute which button text colour (white/near-black) is
// readable on the accent button.
export function validateBrand(input) {
  const errors = [];
  const warnings = [];
  const v = { ...DEFAULT_BRAND };

  for (const key of ["accent", "background", "foreground"]) {
    const raw = String(input?.[key] ?? "").trim().toLowerCase();
    if (!raw) continue; // keep default
    if (!HEX.test(raw)) errors.push(`${key} must be a 6-digit hex color (e.g. #84cc16)`);
    else v[key] = raw;
  }
  if (input?.radius != null) {
    if (!Object.hasOwn(RADIUS_STEPS, input.radius)) errors.push(`radius must be one of ${Object.keys(RADIUS_STEPS).join("/")}`);
    else v.radius = input.radius;
  }
  if (input?.type_scale != null) {
    if (!Object.hasOwn(TYPE_SCALES, input.type_scale)) errors.push(`type_scale must be one of ${Object.keys(TYPE_SCALES).join("/")}`);
    else v.type_scale = input.type_scale;
  }
  if (input?.button_shape != null) {
    if (!Object.hasOwn(BUTTON_SHAPES, input.button_shape)) errors.push(`button_shape must be one of ${Object.keys(BUTTON_SHAPES).join("/")}`);
    else v.button_shape = input.button_shape;
  }
  if (input?.section_spacing != null) {
    if (!Object.hasOwn(SECTION_SPACING, input.section_spacing)) errors.push(`section_spacing must be one of ${Object.keys(SECTION_SPACING).join("/")}`);
    else v.section_spacing = input.section_spacing;
  }
  if (input?.heading_font != null) {
    if (!Object.hasOwn(HEADING_FONTS, input.heading_font)) errors.push(`heading_font must be one of ${Object.keys(HEADING_FONTS).join("/")}`);
    else v.heading_font = input.heading_font;
  }

  if (!errors.length) {
    // which label color works on a solid accent button? (buttons render on the
    // 400 shade, so measure against that, not the raw accent)
    const surface = accentShades(v.accent)[400];
    v.accent_label = contrastRatio("#0a0a0b", surface) >= contrastRatio("#ffffff", surface) ? "#0a0a0b" : "#ffffff";
  }
  return { ok: !errors.length, errors, warnings, value: v };
}

// ---- role derivation (TOK-01) ------------------------------------------------

// The constraints a foreground role must meet: every enforced pair it is the
// foreground of, against that pair's (already derived) background. Derived
// roles aim 0.05 above the line, so a rounding step in the browser never
// lands a derived colour just under it.
const MARGIN = 0.05;
function needsOf(roleId, roles) {
  return PAIRS.filter((p) => p.fg === roleId && enforced(p)).map((p) => ({ bg: roles[p.bg], need: PAIR_NEEDS[p.kind] + MARGIN }));
}
const passesAll = (hex, needs) => needs.every((n) => !n.bg || contrastRatio(hex, n.bg) >= n.need);

// A ladder (light → dark) and a starting index: the nearest step that passes
// every constraint; ties go to the side with more contrast against the first
// background. None passes: push toward black or white until it does (or stop
// at black/white, and the matrix reports the pair).
function nearestPassing(ladder, start, needs, { towardIfNone } = {}) {
  if (passesAll(ladder[start], needs)) return ladder[start];
  const away = needs[0]?.bg && isDarkHex(needs[0].bg) ? -1 : 1; // lighter on dark backgrounds
  for (let d = 1; d < ladder.length; d++) {
    for (const i of [start + d * away, start - d * away]) {
      if (i >= 0 && i < ladder.length && passesAll(ladder[i], needs)) return ladder[i];
    }
  }
  const target = towardIfNone || (away < 0 ? "#ffffff" : "#000000");
  const from = ladder[Math.max(0, Math.min(ladder.length - 1, start))];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mixHex(from, target, Math.min(1, t));
    if (passesAll(c, needs)) return c;
  }
  return target;
}

// Every role's colour for a brand (null = no brand config) on a theme kit.
// Returns { roles: { id: hex }, ladder, derived, corrections: [{ role, from, to }] }.
// What the storefront renders and what the matrix measures both come from
// here, so they cannot disagree.
export function brandRoles(brandInput = null, kit = DEFAULT_KIT, surfaces = null) {
  const k = kitSurfaces(kit, surfaces);
  const brand = brandInput ? resolveBrand(brandInput) : null;
  const b = brand || { ...DEFAULT_BRAND, accent_label: "#0a0a0b" };
  const ladder = brand ? accentShades(b.accent) : { ...DEFAULT_ACCENT_LADDER };
  const ladderArr = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((s) => ladder[s]);
  const LADDER_INDEX = { 50: 0, 100: 1, 200: 2, 300: 3, 400: 4, 500: 5, 600: 6, 700: 7, 800: 8, 900: 9 };
  // No brand: every role is today's value (globals.css), with no correction,
  // so the platform default look never changes. A brand with the platform's
  // own background and text keeps today's greys and status colours too.
  // Accent roles of ANY brand move off their ladder step when it is
  // unreadable (TOK-02): a brand renders its accent through accentShades, and
  // even the Pulse kit's own lime then gives links at 4.15:1.
  const derived = Boolean(brand);
  // No brand on a theme kit: the default look's header and hero accents are
  // still the system's choice, so they are corrected against THAT kit's
  // surfaces (the lime 400 is 1.46:1 on the Glow kit's cream header). On the
  // Pulse kit they already read, so nothing changes there.
  const onKitOnly = (roleId) => {
    const bgs = PAIRS.filter((p) => p.fg === roleId && enforced(p)).map((p) => ROLE[p.bg]);
    return bgs.length > 0 && bgs.every((r) => r.from.startsWith("kit:"));
  };
  const neutralDerived = derived && !(b.background === DEFAULT_BRAND.background && b.foreground === DEFAULT_BRAND.foreground);
  const dark = isDarkHex(b.background);
  const roles = {};
  const corrections = [];
  const kitValue = (spec) => {
    const [part, key] = spec.split(".");
    return k[part][key];
  };

  // pass 1: backgrounds and fixed values; pass 2: foregrounds (they need the
  // backgrounds they sit on)
  const order = [...ROLES].sort((x, y) => (PAIRS.some((p) => p.fg === x.id && enforced(p)) ? 1 : 0) - (PAIRS.some((p) => p.fg === y.id && enforced(p)) ? 1 : 0));
  for (const r of order) {
    const [kind, a1, a2, a3] = r.from.split(":");
    if (kind === "alias") continue;
    if (kind === "fixed") {
      roles[r.id] = r.hex;
      continue;
    }
    if (kind === "kit") {
      roles[r.id] = kitValue(a1);
      continue;
    }
    if (kind === "brandfg") {
      roles[r.id] = b.foreground;
      continue;
    }
    if (kind === "label") {
      roles[r.id] = b.accent_label;
      continue;
    }
    if (kind === "bg") {
      roles[r.id] = neutralDerived || r.id === "surface" ? b.background : r.hex;
      continue;
    }
    if (kind === "fg") {
      roles[r.id] = neutralDerived ? b.foreground : r.hex;
      continue;
    }
    if (kind === "mix") {
      if (!neutralDerived) {
        roles[r.id] = r.hex;
        continue;
      }
      // a hover fill keeps the text on it (the background colour) readable;
      // any other role keeps every pair it is the foreground of readable
      const needs = a2 === "hover" ? [{ bg: b.background, need: PAIR_NEEDS.text + MARGIN }] : needsOf(r.id, roles);
      const t0 = Number(a1);
      // nearest passing mix: step away from the template in both directions,
      // toward the text colour first (more contrast on the page), then back
      // toward the background (a role that sits on the solid button)
      let c = mixHex(b.background, b.foreground, t0);
      for (let d = 0.01; !passesAll(c, needs) && d <= 1.0001; d += 0.01) {
        const up = Math.min(1, t0 + d);
        const down = Math.max(0, t0 - d);
        if (passesAll(mixHex(b.background, b.foreground, up), needs)) c = mixHex(b.background, b.foreground, up);
        else if (passesAll(mixHex(b.background, b.foreground, down), needs)) c = mixHex(b.background, b.foreground, down);
        else if (up === 1 && down === 0) c = mixHex(b.background, b.foreground, 1);
      }
      roles[r.id] = c;
      continue;
    }
    if (kind === "ladder") {
      const start = LADDER_INDEX[a1];
      const want = ladderArr[start];
      if (a2 === "fixed" || (!derived && !onKitOnly(r.id))) {
        roles[r.id] = want;
        continue;
      }
      // a hover fill must keep the button label readable: the label is the
      // constraint (contrast is symmetric), so walk the fill instead
      const needs = a2 === "hover" ? [{ bg: b.accent_label, need: PAIR_NEEDS.text + MARGIN }] : needsOf(r.id, roles);
      const got = nearestPassing(ladderArr, start, needs);
      roles[r.id] = got;
      if (got !== want) corrections.push({ role: r.id, from: want, to: got });
      continue;
    }
    if (kind === "tint") {
      const start = LADDER_INDEX[a1];
      roles[r.id] = derived && dark ? mixHex(b.background, ladder[500], Number(a2)) : ladderArr[start];
      continue;
    }
    if (kind === "status") {
      const lad = STATUS_LADDERS[a1];
      const start = STEP_INDEX[a2];
      if (!neutralDerived) {
        roles[r.id] = r.hex;
        continue;
      }
      if (a3) {
        roles[r.id] = dark ? mixHex(b.background, lad[5], Number(a3)) : lad[start];
        continue;
      }
      roles[r.id] = nearestPassing(lad, start, needsOf(r.id, roles));
      continue;
    }
    throw new Error(`role ${r.id}: unknown source ${r.from}`);
  }
  for (const r of ROLES) if (r.from.startsWith("alias:")) roles[r.id] = roles[r.from.slice(6)];
  return { roles, ladder, derived, corrections };
}

// ---- the matrix (TOK-02) -------------------------------------------------------

export function pairMatrix(brand = null, kit = DEFAULT_KIT, surfaces = null) {
  const { roles } = brandRoles(brand, kit, surfaces);
  return PAIRS.map((p) => {
    const fg = roles[p.fg];
    const bg = roles[p.bg];
    const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
    const need = PAIR_NEEDS[p.kind];
    return { ...p, fgHex: fg, bgHex: bg, ratio, need, enforced: need > 0, pass: need === 0 || ratio >= need };
  });
}

// The platform default look (no brand) on a kit, pair by pair. Its failing
// pairs are the platform's own (faint grey text, the footer wordmark, red on
// its tint: an owner decision, see the TOK review packet), never the founder's.
const baseMemo = new Map();
function baseMatrix(kit, surfaces = null) {
  const key = kit + JSON.stringify(kitSurfaces(kit, surfaces));
  if (!baseMemo.has(key)) baseMemo.set(key, new Map(pairMatrix(null, kit, surfaces).map((p) => [p.id, p])));
  return baseMemo.get(key);
}
const samePair = (a, b) => Boolean(a && b && a.fgHex === b.fgHex && a.bgHex === b.bgHex);

// Each failing enforced pair of `brand` on `kit`, with its verdict:
//   inherited  its colours are the platform default look's on this kit (a
//              store with no brand shows exactly this): never blocks, not
//              reported to the founder. Only pairs a founder colour moves;
//              a kit's own surfaces (fix: null) are judged against live.
//   warning    the live store already shows exactly this pair
//   error      anything else: publishing it would make the store worse
function pairVerdicts(brand, { kit = DEFAULT_KIT, live = null, liveKit = DEFAULT_KIT, surfaces = null, liveSurfaces = null } = {}) {
  const draft = pairMatrix(brand, kit, surfaces);
  const before = new Map(pairMatrix(live, liveKit, liveSurfaces).map((p) => [p.id, p]));
  const base = baseMatrix(kit, surfaces);
  const failing = draft
    .filter((p) => p.enforced && !p.pass)
    .map((p) => ({ p, severity: p.fix && samePair(base.get(p.id), p) ? "inherited" : samePair(before.get(p.id), p) ? "warning" : "error" }));
  return { draft, failing };
}

const KIND_WORDS = { text: "small text", large: "large text", mark: "an icon or outline" };
const TOKEN_WORDS = { foreground: "text colour", background: "background colour", accent: "accent colour" };
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

// The nearest colour (same hue, lightness moved) for `token` that makes every
// failing enforced pair it can fix pass without breaking another one.
// `forFix` (default: the same colour) names the group being fixed: product
// titles on a mid-tone background may have no readable text colour at all,
// and then the background is what moves (checkBrand asks for both).
export function suggestFix(brand, kit, token, forFix = token, surfaces = null) {
  const b = resolveBrand(brand);
  if (!TOKEN_WORDS[token]) return null;
  const [h, s, l] = rgbToHsl(...hexToRgb(b[token]));
  const covered = (p) => p.fix === token || p.fix === forFix;
  const okFor = (candidate) => {
    const m = pairMatrix({ ...b, [token]: candidate, accent_label: undefined }, kit, surfaces);
    return m.every((p) => !p.enforced || p.pass || !covered(p)) && m.filter((p) => p.enforced && !p.pass).length <= pairMatrix(b, kit, surfaces).filter((p) => p.enforced && !p.pass && !covered(p)).length;
  };
  for (let d = 0.01; d <= 1.0001; d += 0.01) {
    for (const nl of [l - d, l + d]) {
      if (nl < 0 || nl > 1) continue;
      const c = toHex(...hslToRgb(h, s, nl));
      if (okFor(c)) return { token, value: c };
    }
  }
  return null;
}

// TOK-02 at save and at publish. `live` is the brand the shoppers see now
// (null: the platform default) on `liveKit`. A failing enforced pair is:
//   blocking  when its colours differ from the same pair on the live store
//   warning   when the live store already shows exactly that pair
// Failing pairs with the same cause (the same colour to change, blocking or
// not) become ONE issue: it names the worst pair in plain words, gives its
// ratio and what it needs, counts the others, and suggests the nearest colour
// that fixes them all. `failing` keeps every pair, one by one.
// `surfaces` / `liveSurfaces` (Phase 5 line 2, optional): an uploaded theme
// package's header and hero surfaces over the kit's, for the draft and live.
export function checkBrand(brand, { kit = DEFAULT_KIT, live = null, liveKit = DEFAULT_KIT, surfaces = null, liveSurfaces = null } = {}) {
  const { draft, failing: verdicts } = pairVerdicts(brand, { kit, live, liveKit, surfaces, liveSurfaces });
  const suggestions = {};
  const failing = verdicts.map(({ p, severity }) => ({ pair: p.id, label: p.label, kind: p.kind, fix: p.fix, severity, ratio: p.ratio, need: p.need, fg: p.fgHex, bg: p.bgHex }));
  // a store with no brand is suggested a change to the platform's colours
  const subject = brand || DEFAULT_BRAND;
  const OTHER = { foreground: "background", background: "foreground" };
  const groups = new Map();
  for (const f of failing) {
    if (f.severity === "inherited") continue;
    const key = `${f.severity}|${f.fix || "kit"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const issues = [...groups.values()].map((list) => {
    // the first in PAIRS order: the list starts with what a shopper meets most
    const worst = list[0];
    if (worst.fix && !(worst.fix in suggestions))
      suggestions[worst.fix] = suggestFix(subject, kit, worst.fix, worst.fix, surfaces) || (OTHER[worst.fix] ? suggestFix(subject, kit, OTHER[worst.fix], worst.fix, surfaces) : null);
    const s = worst.fix ? suggestions[worst.fix] : null;
    const more = list.length - 1;
    const message =
      `${worst.label}: ${worst.fg} on ${worst.bg} has a contrast of ${fmt(worst.ratio)} to 1, and ${KIND_WORDS[worst.kind]} needs at least ${worst.need} to 1` +
      (more ? ` (${more} more colour pair${more === 1 ? "" : "s"} on your store ${more === 1 ? "has" : "have"} the same problem).` : ".") +
      (s ? ` Try ${TOKEN_WORDS[s.token]} ${s.value}.` : worst.fix ? "" : " These colours come from your theme's look; try another look.") +
      (worst.severity === "warning" ? " Your live store already shows this, so it won't stop a publish." : "");
    return { severity: worst.severity, fix: worst.fix, pair: worst.pair, pairs: list.map((f) => f.pair), ratio: worst.ratio, need: worst.need, fg: worst.fg, bg: worst.bg, suggestion: s, message };
  });
  const { corrections } = brandRoles(brand, kit, surfaces);
  const WHERE = { "hero-accent": ["The hero highlight and badge", "on the hero"], "header-accent": ["The accent in your header wordmark", "in the header"], "accent-text": ["Links and accent text", "on your pages"] };
  const notes = corrections
    .filter((c) => WHERE[c.role])
    .map((c) => {
      const [what, where] = WHERE[c.role];
      const lighter = relativeLuminance(c.to) > relativeLuminance(c.from);
      return `${what} would be ${c.from}, too ${lighter ? "dark" : "light"} to read ${where}, so your store uses ${c.to}, a ${lighter ? "lighter" : "darker"} shade of ${brand ? "your" : "the"} accent.`;
    });
  return { ok: !issues.some((i) => i.severity === "error"), issues, failing, inherited: failing.filter((f) => f.severity === "inherited"), errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning"), notes, matrix: draft };
}

// The cheap form of checkBrand for the storefront's own use (no suggestion
// search): would publishing this brand be refused, compared with `live`?
// Remembers its last answers, since a store asks on every request.
const blockedMemo = new Map();
export function publishBlocked(brand, { kit = DEFAULT_KIT, live = null, liveKit = DEFAULT_KIT } = {}) {
  const key = JSON.stringify([brand, kit, live, liveKit]);
  if (blockedMemo.has(key)) return blockedMemo.get(key);
  const blocked = pairVerdicts(brand, { kit, live, liveKit }).failing.some((f) => f.severity === "error");
  if (blockedMemo.size > 64) blockedMemo.clear();
  blockedMemo.set(key, blocked);
  return blocked;
}

// ---- CSS variable emission (server layout) ----------------------------------

// Effective brand: tenant values merged over the platform default, per token.
// Only a malformed value falls back (TOK-02: readability never does; the
// publish gate refuses a changed pair that fails).
export function resolveBrand(tenantBrand) {
  const r = validateBrand(tenantBrand || {});
  return r.ok ? r.value : { ...DEFAULT_BRAND, accent_label: "#0a0a0b" };
}

// `kit` is the theme kit attribute ("pulse-1", "glow-1"): header and hero
// accents are corrected against that kit's surfaces.
// A store with no brand (null) gets only the role corrections its kit needs
// (header and hero accents), or "" when there are none.
// `surfaces` (Phase 5 line 2): an uploaded theme package's header and hero
// colours. They replace the kit block's --header-* / --hero-* values under
// :root[data-theme] (more specific than [data-kit]), and the accents on them
// are corrected against them.
export function brandCssVars(brand, { kit = DEFAULT_KIT, surfaces = null } = {}) {
  const surfaceCss = surfaceCssRule(kit, surfaces);
  if (brand == null) {
    const lines = roleCssLines(null, kit, surfaces);
    return (lines.length ? `:root{${lines.join("")}}` : "") + surfaceCss;
  }
  const b = brand.accent_label ? brand : resolveBrand(brand);
  const shades = accentShades(b.accent);
  const lines = Object.entries(shades).map(([step, hex]) => `--accent-${step}:${hex};`);
  lines.push(
    `--background:${b.background};`,
    `--foreground:${b.foreground};`,
    `--accent-label:${b.accent_label};`,
    `--brand-radius:${RADIUS_STEPS[b.radius]};`,
    `--type-scale:${TYPE_SCALES[b.type_scale]};`,
    `--btn-radius:${BUTTON_SHAPES[b.button_shape] || BUTTON_SHAPES.pill};`,
    `--section-pad-y:${SECTION_SPACING[b.section_spacing] || SECTION_SPACING.regular};`,
  );
  lines.push(...roleCssLines(b, kit, surfaces));
  // under :root[data-kit] so it beats the kit block's own --display-font
  const heading = Object.hasOwn(HEADING_FONTS, b.heading_font ?? "") ? `:root[data-kit]{--display-font:${HEADING_FONTS[b.heading_font]};}` : "";
  return `:root{${lines.join("")}}` + heading + surfaceCss;
}

function surfaceCssRule(kit, surfaces) {
  if (!surfaces) return "";
  const k = kitSurfaces(kit, surfaces);
  const lines = Object.entries(k).flatMap(([part, v]) => [`--${part}-bg:${v.bg};`, `--${part}-fg:${v.fg};`, `--${part}-muted:${v.muted};`]);
  return `:root[data-theme]{${lines.join("")}}`;
}

// TOK-01: the role variables a brand overrides. Only what differs from the
// globals.css default is written: neutral and status roles when the brand's
// background or text differ from the platform's, an accent role only when it
// had to move off its ladder step to stay readable (or, on a dark
// background, an accent tint). Kit surfaces stay with the kit's CSS block,
// aliases follow their target, photo overlays never change. No brand (null):
// only an accent role corrected against the kit's own surfaces.
export function roleCssLines(brand, kit = DEFAULT_KIT, surfaces = null) {
  const b = brand == null ? null : brand.accent_label ? brand : resolveBrand(brand);
  const { roles, ladder } = brandRoles(b, kit, surfaces);
  const neutral = b !== null && !(b.background === DEFAULT_BRAND.background && b.foreground === DEFAULT_BRAND.foreground);
  const out = [];
  for (const r of ROLES) {
    const [kind, step] = r.from.split(":");
    let emit = false;
    if (["mix", "fg", "status"].includes(kind)) emit = neutral;
    else if (kind === "bg") emit = neutral && r.id !== "surface"; // surface is var(--background)
    else if (kind === "ladder" || kind === "tint") emit = roles[r.id] !== ladder[step];
    if (emit) out.push(`--sf-${r.id}:${roles[r.id]};`);
  }
  return out;
}
