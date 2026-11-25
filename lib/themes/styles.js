// Phase 5 step 0: a theme package's constrained styles (docs/plans/phase-5.md).
// A rule is { part, set: { property: value } }; Storeasy writes the selector and
// every value. Pure and Edge-safe: the storefront layout compiles the live
// package's styles with compileStyles on each (cached) render.
import { contrastRatio } from "../brand.js";
import { LIMITS, MIN_CONTRAST, PARTS, PROPS, THEME_ID_RE, fullHex } from "./package-format.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const PART_SET = new Set(PARTS);

// One rule's issues ([{ path, message }]); empty when the rule compiles.
function ruleIssues(rule, path) {
  const issues = [];
  if (!isObj(rule)) return [{ path, message: "Each style must be a part and the settings for it." }];
  for (const key of Object.keys(rule)) {
    if (key !== "part" && key !== "set") issues.push({ path: `${path}.${key}`, message: `Styles can't have a "${key}" setting.` });
  }
  if (typeof rule.part !== "string" || !PART_SET.has(rule.part)) {
    issues.push({ path: `${path}.part`, message: `Themes can't style "${String(rule.part).slice(0, 40)}". Use one of: ${PARTS.join(", ")}.` });
  }
  if (!isObj(rule.set) || !Object.keys(rule.set).length) {
    issues.push({ path: `${path}.set`, message: "Each style needs at least one setting." });
    return issues;
  }
  for (const [prop, value] of Object.entries(rule.set)) {
    const at = `${path}.set.${prop}`;
    if (!Object.hasOwn(PROPS, prop)) issues.push({ path: at, message: `Themes can't set "${prop.slice(0, 40)}". Use one of: ${Object.keys(PROPS).join(", ")}.` });
    else if (PROPS[prop].css(value) === null) issues.push({ path: at, message: `${prop} must be ${PROPS[prop].hint}.` });
  }
  // both colours given as hex: they must stay readable together. Role colours
  // are measured against the store's brand by the package check (line 1).
  const fg = fullHex(rule.set.color);
  const bg = fullHex(rule.set["background-color"]);
  if (fg && bg && contrastRatio(fg, bg) < MIN_CONTRAST) {
    issues.push({ path: `${path}.set.color`, message: `This text colour is hard to read on its background (needs ${MIN_CONTRAST}:1 contrast).` });
  }
  return issues;
}

/**
 * Every issue in a package's styles, each with the path it is at
 * ("styles[3].set.color"). [] means every rule compiles.
 * @param {unknown} styles
 * @returns {{ path: string, message: string }[]}
 */
export function validateStyles(styles) {
  if (styles == null) return [];
  if (!Array.isArray(styles)) return [{ path: "styles", message: "Styles must be a list of rules." }];
  const issues = [];
  if (styles.length > LIMITS.rules) issues.push({ path: "styles", message: `Themes can have up to ${LIMITS.rules} style rules.` });
  styles.forEach((rule, i) => issues.push(...ruleIssues(rule, `styles[${i}]`)));
  return issues;
}

/**
 * The CSS for a package's styles, scoped to its data-theme attribute:
 *   :where([data-theme="<id>"]) [data-part="<part>"]{prop:value;}
 * Every rule is validated again here and an invalid one is skipped whole, so
 * a hand-edited row cannot inject anything; past LIMITS.rules nothing more is
 * written. A theme id that is not /^[a-z0-9-]{1,40}$/ compiles to "".
 * @param {unknown} styles
 * @param {string} themeId
 * @returns {string}
 */
export function compileStyles(styles, themeId) {
  if (typeof themeId !== "string" || !THEME_ID_RE.test(themeId) || !Array.isArray(styles)) return "";
  const out = [];
  for (const [i, rule] of styles.slice(0, LIMITS.rules).entries()) {
    if (ruleIssues(rule, `styles[${i}]`).length) continue;
    const decls = Object.entries(rule.set).map(([prop, value]) => `${prop}:${PROPS[prop].css(value)};`);
    out.push(`:where([data-theme="${themeId}"]) [data-part="${rule.part}"]{${decls.join("")}}`);
  }
  // belt and braces: nothing above can produce "<", but the CSS lands in a
  // <style> element, so it can never close one
  return out.join("\n").replace(/</g, "\\3c ");
}
