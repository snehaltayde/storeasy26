// Phase 6 (studio): the founder's unsaved tokens as CSS, worked out inside
// the preview frame the way app/(storefront)/layout.js draws a saved brand:
// validateBrand, then brandCssVars with the page's own kit and package
// surfaces (`look`, which the layout hands PreviewBridge). Anything
// validateBrand refuses: null (the bridge ignores it). Extra keys are dropped
// by validateBrand; nothing sent is ever written as CSS itself. A plain
// module (relative imports, Edge-safe) so node suites import it as is.
import { brandCssVars, validateBrand, DEFAULT_KIT } from "../../lib/brand.js";

export function tokensCss(brand, look = null) {
  if (!brand || typeof brand !== "object" || Array.isArray(brand)) return null;
  const r = validateBrand(brand);
  if (!r.ok) return null;
  return brandCssVars(r.value, { kit: typeof look?.kit === "string" && look.kit ? look.kit : DEFAULT_KIT, surfaces: look?.surfaces ?? null });
}
