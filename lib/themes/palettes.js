// Curated palettes (P6-PALETTE: GEN-01, GEN-04, TOK-02). Pure and edge-safe:
// its only import is lib/brand.js (itself import-free and edge-safe; the plan
// allows nothing else), for paletteIdOfBrand's validateBrand, so the
// storefront, the console and the Node-only first-run generator can all load
// it.
//
// Six full brands a founder picks from in the brand step (/admin/start), and
// the palette a generated store starts on (GEN-01: never the platform's lime
// DEFAULT_BRAND). Each brand carries every key validateBrand reads, plus the
// accent_label validateBrand works out for it, so a palette is stored exactly
// as the editor would store it.
//
// Every palette sets its own text colour (never the platform's #0a0a0b), so
// lib/brand.js brandRoles takes its neutralDerived branch and derives each
// grey from the palette's own background and text. A palette on the
// platform's own white and #0a0a0b would keep the platform's greys, whose
// faint text and marks fail the TOK-02 matrix (PLATFORM_DEFAULT_FAILS in
// scripts/test-tokens.js). scripts/test-tokens.js proves every palette passes
// the whole matrix on every theme kit, with 0 checkBrand errors and
// publishBlocked false, and that none of them is lime.
//
// The kit is the KIT_SURFACES key ("pulse-1"). The design document's theme
// setting holds it as { kit: "pulse", version: 1 } (designBodyFor), the shape
// lib/themes/kits.js KITS holds; this file may not import kits.js, so
// test-tokens checks the version against KITS.pulse.version.
//
// Every palette object and brand is frozen. Build a design body with
// designBodyFor (fresh copies) or a spread; never hand out or change
// paletteById(...).brand itself (it throws in strict mode).

import { validateBrand } from "../brand.js";

const SHAPES = Object.freeze({ radius: "md", type_scale: "regular", button_shape: "pill", section_spacing: "regular" });

const palette = (id, label, colours, accent_label, kit = "pulse-1") =>
  Object.freeze({ id, label, brand: Object.freeze({ ...colours, ...SHAPES, accent_label }), kit });

export const PALETTES = Object.freeze([
  palette("ink", "Ink", { accent: "#18181b", background: "#ffffff", foreground: "#09090b" }, "#ffffff"),
  palette("slate", "Slate", { accent: "#334155", background: "#ffffff", foreground: "#0f172a" }, "#ffffff"),
  palette("navy", "Navy", { accent: "#1e3a8a", background: "#ffffff", foreground: "#0f172a" }, "#ffffff"),
  palette("stone", "Stone", { accent: "#44403c", background: "#fafaf9", foreground: "#1c1917" }, "#ffffff"),
  palette("forest", "Forest", { accent: "#166534", background: "#fffbf7", foreground: "#1c1917" }, "#0a0a0b"),
  palette("clay", "Clay", { accent: "#9a3412", background: "#fffbf7", foreground: "#1c1917" }, "#0a0a0b"),
]);

// The palette GEN-01's generator and PUB-12's design rule write in phase 6.
export const DEFAULT_PALETTE_ID = "slate";

const BY_ID = new Map(PALETTES.map((p) => [p.id, p]));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function paletteById(id) {
  return (typeof id === "string" && BY_ID.get(id)) || null;
}

// "pulse-1" -> { kit: "pulse", version: 1 }
function themeOf(kitKey) {
  const at = kitKey.lastIndexOf("-");
  return { kit: kitKey.slice(0, at), version: Number(kitKey.slice(at + 1)) };
}

// The design document's settings for a palette, in the shapes the brand and
// theme setting kinds accept. Fresh objects every call (the caller may edit
// them). Unknown id: null.
export function designBodyFor(paletteId) {
  const p = paletteById(paletteId);
  if (!p) return null;
  return { brand: { ...p.brand }, theme: themeOf(p.kit) };
}

// The palette whose brand this is, else null. P6-BRAND (P6-PALETTE review):
// the brand is compared as it DRAWS, through validateBrand(brand).value, the
// value the storefront renders from (lib/brand.js brandCssVars). So a partial
// stored brand (the brand kind allows one: { accent, background, foreground }
// with no shape keys) whose missing keys fill in to the palette's is that
// palette, colours compare without case, and accent_label is the worked-out
// one whatever the stored value says (validateBrand recomputes it). A brand
// validateBrand refuses, or one that draws in any other way (another colour,
// radius or button shape), is null. DEFAULT_BRAND is null.
export function paletteIdOfBrand(brand) {
  if (!isObj(brand)) return null;
  const v = validateBrand(brand);
  if (!v.ok) return null;
  for (const p of PALETTES) {
    const keys = new Set([...Object.keys(p.brand), ...Object.keys(v.value)]);
    let same = true;
    for (const k of keys) {
      if (v.value[k] !== p.brand[k]) {
        same = false;
        break;
      }
    }
    if (same) return p.id;
  }
  return null;
}

// Owner answer OQ-P6-8 (revision 4): the store's starting palette, which the
// design settings' Reset goes back to. The brand step's recorded paletteId
// when it is a known palette (whether the step was saved or later skipped),
// else the default. Never null, never lime. Pure: it reads only the tenant's
// config.onboarding object it is given (or null).
export function startingPaletteId(onboarding) {
  const step = isObj(onboarding) && isObj(onboarding.brand_step) ? onboarding.brand_step : null;
  return step && paletteById(step.paletteId) ? step.paletteId : DEFAULT_PALETTE_ID;
}

// Lime, the platform default's accent family (#84cc16 and its ladder:
// #a3e635, #a8eb43, #588a0c, #456c09), and near shades: a hue between 65 and
// 105 degrees with real colour in it (saturation 0.3 or more), at any
// lightness short of near-white or near-black. Not a hex colour: false.
// Both edges count as lime (65 and 105 inclusive). Olive (#808000, hue 60)
// is a yellow-brown, not the lime family: false (decided in P6-BRAND, pinned
// in test-tokens with colours just inside and outside each edge).
const HEX = /^#[0-9a-f]{6}$/;
export function isLimeAccent(hex) {
  const h6 = typeof hex === "string" ? hex.trim().toLowerCase() : "";
  if (!HEX.test(h6)) return false;
  const n = parseInt(h6.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return false;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h >= 65 && h <= 105 && s >= 0.3 && l >= 0.08 && l <= 0.95;
}
