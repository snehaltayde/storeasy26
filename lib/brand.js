// Brand design tokens (Session 35 / MC10). Pure + edge-safe (client-safe: no
// imports) — the server layout turns a tenant's `config.brand` into CSS
// variables, the console validates edits, and the storefront consumes ONLY
// the variables (components reference accent-* utilities, never a hardcoded
// palette), so one config row re-skins the whole store.
//
// Resolution order (BE08): platform default (this file's DEFAULT_BRAND = the
// pre-S35 lime look) → theme kit defaults (S37, none yet) → tenant
// config.brand. Absent/invalid tenant values fall back per-token, so a broken
// row can never unstyle a storefront.

export const DEFAULT_BRAND = {
  accent: "#84cc16", // lime-500 — the pre-S35 hardcoded palette
  background: "#ffffff",
  foreground: "#0a0a0b",
  radius: "md", // sm | md | lg | xl  (cards/buttons scale together)
  type_scale: "regular", // compact | regular | large
};

export const RADIUS_STEPS = { sm: "0.375rem", md: "0.75rem", lg: "1rem", xl: "1.5rem" };
export const TYPE_SCALES = { compact: "0.94", regular: "1", large: "1.08" };

const HEX = /^#[0-9a-fA-F]{6}$/;

// ---- color math (hex ↔ HSL) ------------------------------------------------

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r, g, b) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

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

// ---- validation (console writes) --------------------------------------------

// Returns { ok, errors, warnings, value } — value normalized for storage.
// BLOCKS (errors) when core body text fails WCAG AA (4.5:1); accent-on-white
// button text is a WARNING (buttons use dark-on-accent at light accents), and
// we also compute which button text color (white/near-black) is readable.
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

  if (!errors.length) {
    const core = contrastRatio(v.foreground, v.background);
    if (core < 4.5) errors.push(`Body text contrast is ${core.toFixed(2)}:1 — WCAG AA needs 4.5:1. Pick a darker foreground or lighter background.`);
    const accentOnBg = contrastRatio(v.accent, v.background);
    if (accentOnBg < 3) warnings.push(`Accent-on-background contrast is ${accentOnBg.toFixed(2)}:1 (<3:1) — accent text/links may be hard to read; buttons still use readable label colors.`);
    // which label color works on a solid accent button? (buttons render on the
    // 400 shade, so measure against that, not the raw accent)
    const surface = accentShades(v.accent)[400];
    v.accent_label = contrastRatio("#0a0a0b", surface) >= contrastRatio("#ffffff", surface) ? "#0a0a0b" : "#ffffff";
  }
  return { ok: !errors.length, errors, warnings, value: v };
}

// ---- CSS variable emission (server layout) ----------------------------------

// Effective brand: tenant values merged over the platform default, per token.
export function resolveBrand(tenantBrand) {
  const r = validateBrand(tenantBrand || {});
  return r.ok ? r.value : { ...DEFAULT_BRAND, accent_label: "#0a0a0b" };
}

export function brandCssVars(brand) {
  const b = brand.accent_label ? brand : resolveBrand(brand);
  const shades = accentShades(b.accent);
  const lines = Object.entries(shades).map(([step, hex]) => `--accent-${step}:${hex};`);
  lines.push(
    `--background:${b.background};`,
    `--foreground:${b.foreground};`,
    `--accent-label:${b.accent_label};`,
    `--brand-radius:${RADIUS_STEPS[b.radius]};`,
    `--type-scale:${TYPE_SCALES[b.type_scale]};`,
  );
  return `:root{${lines.join("")}}`;
}
