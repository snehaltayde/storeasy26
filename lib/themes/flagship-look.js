// Phase 7 line 1: a flagship theme's look, worked out the same way on the
// server (the onboarding Brand step's save), in the console (theme cards) and
// inside the preview frame (components/preview/PreviewBridge.js brandFor).
// Client-safe and Edge-safe: brand.js, styles.js, palettes.js and the
// flagship data only.
//
//   flagshipBrand(slug, paletteId)  the brand a pick writes: the theme's own
//                                   tokens (shapes and heading font) with a
//                                   palette's three colours over them, or the
//                                   theme's own colours when paletteId is
//                                   null; null for an unknown slug or palette
//   flagshipKit(pkg)                its base kit attribute ("glow-1")
//   flagshipLook(slug, paletteId)   { css, kit, theme } for the preview frame:
//                                   brandCssVars with the theme's surfaces,
//                                   then its compiled style rules
//   themeColoursOf(slug, brand)     the palette id a saved brand's colours
//                                   are, null for the theme's own colours,
//                                   undefined when they are neither
import { KIT_SURFACES, brandCssVars, validateBrand } from "../brand.js";
import { compileStyles } from "./styles.js";
import { paletteById, PALETTES } from "./palettes.js";
import { latestFlagship } from "./flagships.js";

const COLOURS = ["accent", "background", "foreground"];

export function flagshipKit(pkg) {
  const keys = Object.keys(KIT_SURFACES).filter((k) => k.startsWith(`${pkg.base}-`));
  return keys.sort().at(-1) || `${pkg.base}-1`;
}

export function flagshipBrand(slug, paletteId = null) {
  const pkg = latestFlagship(slug);
  if (!pkg) return null;
  const palette = paletteId == null ? null : paletteById(paletteId);
  if (paletteId != null && !palette) return null;
  const brand = { ...pkg.tokens, ...(palette ? Object.fromEntries(COLOURS.map((k) => [k, palette.brand[k]])) : {}) };
  return { ...brand, accent_label: validateBrand(brand).value.accent_label };
}

export function flagshipLook(slug, paletteId = null) {
  const pkg = latestFlagship(slug);
  const brand = flagshipBrand(slug, paletteId);
  if (!pkg || !brand) return null;
  const kit = flagshipKit(pkg);
  return { css: [brandCssVars(brand, { kit, surfaces: pkg.surfaces }), compileStyles(pkg.styles, pkg.id)].filter(Boolean).join("\n"), kit, theme: pkg.id };
}

export function themeColoursOf(slug, brand) {
  const pkg = latestFlagship(slug);
  if (!pkg || !brand || typeof brand !== "object") return undefined;
  const same = (b) => COLOURS.every((k) => String(brand[k] ?? "").toLowerCase() === String(b[k]).toLowerCase());
  if (same(pkg.tokens)) return null;
  return PALETTES.find((p) => same(p.brand))?.id;
}
