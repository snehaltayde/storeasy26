// Phase 6 line 2 (docs/plans/phase-6.md "Line 2"): the studio's Design tab,
// as plain JS (no React, no DOM, no network), so node suites drive it.
// The tokens are doc_design's settings.brand; the look (settings.theme) is
// only read here: an uploaded theme's surfaces and styles aren't edited.
//
//   brandOf(body) → brand | null           settings.brand of a design body
//   withBrand(body, brand) → body          the same body with that brand
//   kitOf(theme) → "pulse-1"…              the kit attribute the storefront
//                                          draws (lib/registry's kitOf)
//   packageIdOf(theme) → "thm_…" | null    the uploaded theme it names
//   setToken(brand, key, value, start)     one token changed, only to a value
//                                          validateBrand takes (a colour may be
//                                          half typed: kept, not posted); an
//                                          unknown key or step: brand as it was
//   tokensMessage(brand) → msg | null      {type:"storeasy:tokens", brand}
//                                          with validateBrand's value, or null
//                                          (nothing to post) while invalid
//   resetTarget({ theme, packageTokens, startingBrand })
//                                          what Reset writes: an uploaded
//                                          theme's tokens (base kit's under the
//                                          package's), else the store's
//                                          starting brand, else slate's
//   resetWords({ packageName })            the Reset button's words
//   themeWords(name, version)              "Theme: Aurora 1.2.0. Your colours…"
//   readability(brand, { theme, surfaces, live, liveTheme })
//                                          checkBrand with the draft's kit,
//                                          the package surfaces and the live
//                                          brand: { blocking, items: [{
//                                          severity, message, fix: {token,
//                                          value, words} | null }] }
//   applyFix(brand, fix, start)            the brand with a suggestFix applied
//   stepOps(step, dir) → [{path, value}]   an undo step as store.setField
//                                          calls for only what the step changed
//                                          (settings.<key>, or a top-level key),
//                                          never a whole-body snapshot, so a
//                                          change made since (another key, or
//                                          the same store's other edits) stays
import { checkBrand, validateBrand, KIT_SURFACES, DEFAULT_KIT } from "../../../lib/brand.js";
import { BRAND_FIELDS, design } from "../editor/fields/inspectorModel.js";
import { paletteById, DEFAULT_PALETTE_ID } from "../../../lib/themes/palettes.js";

export const DESIGN_DOC = "doc_design";
export const TOKEN_KEYS = Object.freeze(BRAND_FIELDS.map((f) => f.key));
export const DESIGN_WORDS = Object.freeze({
  intro: "Your colours, type and spacing, for every page. Shoppers see them after you publish.",
  builtIn: "Your colours, type and spacing go on top of your look.",
  readOnly: "You can see your design here but not change it.",
  colours: "Colours",
  type: "Type",
  spacing: "Spacing and shape",
  readable: "Every colour pair is easy to read.",
  blocks: "Fix this before you publish: shoppers couldn't read it.",
  warns: "Your live store already shows this, so it won't stop a publish.",
  loading: "Opening your design…",
  failed: "Your design couldn't be opened. Nothing was changed.",
  halfTyped: "A colour is # and six letters or digits. The preview shows it once it's complete.",
});
// the groups the rail shows, in its order
export const TOKEN_GROUPS = Object.freeze([
  { id: "colours", words: DESIGN_WORDS.colours, keys: ["accent", "background", "foreground"] },
  { id: "type", words: DESIGN_WORDS.type, keys: ["type_scale"] },
  { id: "spacing", words: DESIGN_WORDS.spacing, keys: ["section_spacing", "radius", "button_shape"] },
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const FIELD = new Map(BRAND_FIELDS.map((f) => [f.key, f]));
const TOKEN_WORDS = { accent: "accent colour", background: "background colour", foreground: "text colour" };

export const brandOf = (body) => (isObj(body?.settings) && isObj(body.settings.brand) ? body.settings.brand : null);
export const themeOf = (body) => (isObj(body?.settings) && isObj(body.settings.theme) ? body.settings.theme : null);
export function withBrand(body, brand) {
  const b = isObj(body) ? body : { type: "design", settings: {} };
  return { ...b, settings: { ...(isObj(b.settings) ? b.settings : {}), brand } };
}
export const kitOf = (theme) => (isObj(theme) && KIT_SURFACES[`${theme.kit}-${theme.version}`] ? `${theme.kit}-${theme.version}` : DEFAULT_KIT);
export const packageIdOf = (theme) => (isObj(theme) && typeof theme.package === "string" && theme.package ? theme.package : null);

const startOf = (startingBrand) => (isObj(startingBrand) ? startingBrand : paletteById(DEFAULT_PALETTE_ID).brand);

export function setToken(brand, key, value, startingBrand = null) {
  const f = FIELD.get(key);
  if (!f) return brand;
  const v = typeof value === "string" ? value.trim() : value;
  if (f.kind === "step" && !f.options.includes(v)) return brand;
  if (f.kind === "colour" && typeof v !== "string") return brand;
  return design.setToken(brand, key, f.kind === "colour" ? v.toLowerCase() : v, startOf(startingBrand));
}

export function tokensMessage(brand) {
  if (!isObj(brand)) return null;
  const r = validateBrand(brand);
  return r.ok ? { type: "storeasy:tokens", brand: r.value } : null;
}

export function resetTarget({ theme = null, packageTokens = null, startingBrand = null } = {}) {
  // as applyPackage (withBrand) and DesignForm's Reset write them
  if (packageIdOf(theme) && isObj(packageTokens) && validateBrand(packageTokens).ok) return { ...packageTokens };
  return { ...startOf(startingBrand) };
}

export const resetWords = ({ packageName = null } = {}) => (packageName ? "Reset to the theme's" : "Go back to your starting colours");
export const themeWords = (name, version) => `Theme: ${name}${version ? ` ${version}` : ""}. Your colours, type and spacing go on top of it.`;

// the same brand, token for token (accent_label follows the accent)
export function sameTokens(a, b) {
  const x = validateBrand(isObj(a) ? a : {});
  const y = validateBrand(isObj(b) ? b : {});
  if (!x.ok || !y.ok) return false;
  return TOKEN_KEYS.every((k) => x.value[k] === y.value[k]);
}

export function readability(brand, { theme = null, surfaces = null, live = null, liveTheme = null } = {}) {
  if (brand != null && (!isObj(brand) || !validateBrand(brand).ok)) return { blocking: false, items: [], checked: false };
  const r = checkBrand(brand ?? null, { kit: kitOf(theme), live: isObj(live) ? live : null, liveKit: kitOf(liveTheme), surfaces: packageIdOf(theme) && isObj(surfaces) ? surfaces : null });
  const items = r.issues.map((i) => ({
    severity: i.severity,
    pair: i.pair,
    message: i.message,
    fix: i.suggestion && TOKEN_WORDS[i.suggestion.token] ? { token: i.suggestion.token, value: i.suggestion.value, words: `Use ${i.suggestion.value}` } : null,
  }));
  return { blocking: !r.ok, items, checked: true };
}

export function applyFix(brand, fix, startingBrand = null) {
  if (!isObj(fix) || !TOKEN_WORDS[fix.token]) return brand;
  return setToken(brand, fix.token, fix.value, startingBrand);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export function stepOps(step, dir) {
  if (!isObj(step) || (dir !== "undo" && dir !== "redo")) return [];
  const from = isObj(step.before) ? step.before : {};
  const to = isObj(step.after) ? step.after : {};
  const target = dir === "undo" ? from : to;
  const out = [];
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (same(from[k], to[k])) continue;
    if (k === "settings" && isObj(from[k]) && isObj(to[k])) {
      for (const sk of new Set([...Object.keys(from[k]), ...Object.keys(to[k])])) if (!same(from[k][sk], to[k][sk])) out.push({ path: `settings.${sk}`, value: copy(target[k][sk]) });
    } else out.push({ path: k, value: copy(target[k]) });
  }
  return out;
}
