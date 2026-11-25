// Phase 5 line 1: reading an uploaded theme package (docs/plans/phase-5.md
// "Package format"). Pure and Edge-safe.
//   parseThemePackage(text) -> { pkg } | { issues: [{ code, path, message }] }
// Order: size, JSON, the refusal scan (package-guard.js), then the shape:
// unknown keys refused anywhere, tokens through validateBrand, surfaces and
// colour pairs at 4.5:1, templates among the existing layout choices, home
// sections through the registry validator (no pictures or files), styles
// through validateStyles. `pkg` is the normalised package: only known keys,
// in the format's order, so what is stored is exactly what was checked.
import { BRAND_TOKEN_KEYS, brandRoles, contrastRatio, validateBrand } from "../brand.js";
import { KITS } from "./kits.js";
import { BASES, DESCRIPTION_MAX, FORMAT, LIMITS, MESSAGES, MIN_CONTRAST, SURFACES, TEMPLATE_CHOICES, THEME_ID_RE, TOP_KEYS, VERSION_RE, fullHex } from "./package-format.js";
import { scanPackage } from "./package-guard.js";
import { validateStyles } from "./styles.js";
import { allowedKinds, newSection, refsOf, validateDocument, emptyBody, sectionType, isStorefrontHref } from "../registry/index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NAME_MAX = 60;
const AUTHOR_MAX = 80;
const HOME_KINDS = () => allowedKinds("home").filter((k) => k !== "product_main");

export const utf8Bytes = (text) => new TextEncoder().encode(String(text)).length;

function unknownKeys(obj, allowed, path, issues) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.push({ code: "unknown-key", path: path ? `${path}.${k}` : k, message: MESSAGES.unknownKey(k.slice(0, 40)) });
}

function text(v, { path, max, required, words }, issues) {
  if (v == null || v === "") {
    if (required) issues.push({ code: "invalid", path, message: `Add ${words}.` });
    return "";
  }
  if (typeof v !== "string") issues.push({ code: "invalid", path, message: `${words[0].toUpperCase()}${words.slice(1)} must be text.` });
  else if (v.trim().length > max) issues.push({ code: "invalid", path, message: `${words[0].toUpperCase()}${words.slice(1)} can be up to ${max} characters.` });
  return typeof v === "string" ? v.trim() : "";
}

function checkTokens(tokens, issues) {
  if (tokens == null) return {};
  if (!isObj(tokens)) {
    issues.push({ code: "invalid", path: "tokens", message: "Tokens must be your theme's brand settings." });
    return {};
  }
  unknownKeys(tokens, BRAND_TOKEN_KEYS, "tokens", issues);
  for (const e of validateBrand(tokens).errors) {
    const key = e.split(" ")[0];
    issues.push({ code: "invalid", path: `tokens.${key}`, message: `${e[0].toUpperCase()}${e.slice(1).replace(/_/g, " ")}.` });
  }
  return Object.fromEntries(BRAND_TOKEN_KEYS.filter((k) => tokens[k] != null).map((k) => [k, typeof tokens[k] === "string" ? tokens[k].trim().toLowerCase() : tokens[k]]));
}

function checkSurfaces(surfaces, issues) {
  if (surfaces == null) return {};
  if (!isObj(surfaces)) {
    issues.push({ code: "invalid", path: "surfaces", message: "Surfaces must be the header and hero colours." });
    return {};
  }
  unknownKeys(surfaces, Object.keys(SURFACES), "surfaces", issues);
  const out = {};
  for (const [name, keys] of Object.entries(SURFACES)) {
    const s = surfaces[name];
    if (s == null) continue;
    if (!isObj(s)) {
      issues.push({ code: "invalid", path: `surfaces.${name}`, message: `The ${name} colours must be bg, fg and muted.` });
      continue;
    }
    unknownKeys(s, keys, `surfaces.${name}`, issues);
    const c = {};
    for (const k of keys) {
      if (s[k] == null) continue;
      const hex = fullHex(s[k]);
      if (!hex) issues.push({ code: "invalid", path: `surfaces.${name}.${k}`, message: "Use a colour like #1f2937." });
      else c[k] = hex;
    }
    if (c.bg) {
      for (const k of ["fg", "muted"]) {
        if (c[k] && contrastRatio(c[k], c.bg) < MIN_CONTRAST) issues.push({ code: "contrast", path: `surfaces.${name}.${k}`, message: `This ${name} text colour is hard to read on its background (needs ${MIN_CONTRAST}:1 contrast).` });
      }
    }
    out[name] = c;
  }
  return out;
}

function checkHome(home, issues) {
  if (home == null) return null;
  if (!isObj(home)) {
    issues.push({ code: "invalid", path: "templates.home", message: "The home template must be a list of sections." });
    return null;
  }
  unknownKeys(home, ["sections"], "templates.home", issues);
  if (!Array.isArray(home.sections)) {
    issues.push({ code: "invalid", path: "templates.home.sections", message: "The home template must be a list of sections." });
    return null;
  }
  const kinds = HOME_KINDS();
  const body = emptyBody("home");
  const at = new Map(); // section id -> index
  const out = [];
  home.sections.forEach((s, i) => {
    const path = `templates.home.sections[${i}]`;
    if (!isObj(s)) return issues.push({ code: "invalid", path, message: "Each home section must be a kind and its settings." });
    unknownKeys(s, ["kind", "settings"], path, issues);
    if (typeof s.kind !== "string" || !kinds.includes(s.kind)) {
      return issues.push({ code: "invalid", path: `${path}.kind`, message: `Home sections can be: ${kinds.join(", ")}.` });
    }
    if (s.settings != null && !isObj(s.settings)) return issues.push({ code: "invalid", path: `${path}.settings`, message: "A section's settings must be a set of values." });
    const section = newSection(s.kind);
    section.settings = { ...section.settings, ...(s.settings || {}) };
    for (const ref of refsOf(section)) {
      if (ref.ref === "media") issues.push({ code: "assets", path: `${path}.settings.${ref.field}`, message: MESSAGES.noAssets });
      // the links a founder's Publish allows: a page on the store only
      if (ref.ref === "link" && typeof ref.href === "string" && !isStorefrontHref(ref.href)) issues.push({ code: "external", path: `${path}.settings.${ref.field}.href`, message: "Theme links can only go to a page on your store, like /collections." });
    }
    if (JSON.stringify(s.settings || {}).includes('"med_')) issues.push({ code: "assets", path: `${path}.settings`, message: MESSAGES.noAssets });
    at.set(section.id, i);
    body.sections.push(section);
  });
  if (body.sections.length) {
    // publish mode: what a founder's Publish would refuse is refused here,
    // and what is stored is the registry's sanitised settings, not the file's
    const checked = validateDocument(body, { mode: "publish" });
    for (const s of checked.body?.sections ?? []) out.push({ kind: s.kind, settings: s.settings });
    for (const issue of checked.issues) {
      if (issue.severity !== "error") continue;
      const i = at.get(issue.sectionId);
      const path = i == null ? "templates.home.sections" : `templates.home.sections[${i}]${issue.field ? `.settings.${issue.field}` : ""}`;
      issues.push({ code: "section", path, message: issue.message });
    }
  }
  return { sections: out };
}

function checkTemplates(templates, issues) {
  if (templates == null) return {};
  if (!isObj(templates)) {
    issues.push({ code: "invalid", path: "templates", message: "Templates must be your layout choices." });
    return {};
  }
  unknownKeys(templates, [...Object.keys(TEMPLATE_CHOICES), "home"], "templates", issues);
  const out = {};
  for (const [k, choices] of Object.entries(TEMPLATE_CHOICES)) {
    if (templates[k] == null) continue;
    if (!choices.includes(templates[k])) issues.push({ code: "invalid", path: `templates.${k}`, message: `The ${k} layout can be ${choices.join(" or ")}.` });
    else out[k] = templates[k];
  }
  const home = checkHome(templates.home, issues);
  if (home) out.home = home;
  return out;
}

// role: colours resolved against the package's own tokens, base kit and surfaces
export function packageRoles(pkg) {
  const kit = KITS[pkg.base] || KITS.pulse;
  const { roles } = brandRoles(Object.keys(pkg.tokens || {}).length ? pkg.tokens : null, `${kit.id}-${kit.version}`);
  const r = { ...roles };
  for (const name of ["header", "hero"]) {
    const s = pkg.surfaces?.[name] || {};
    if (s.bg) r[name] = s.bg;
    if (s.fg) r[`${name}-fg`] = s.fg;
    if (s.muted) r[`${name}-muted`] = s.muted;
  }
  return r;
}

function roleContrast(pkg, issues) {
  if (!Array.isArray(pkg.styles)) return;
  const roles = packageRoles(pkg);
  const hexOf = (v) => fullHex(v) || (typeof v === "string" && v.startsWith("role:") ? fullHex(roles[v.slice(5)]) : null);
  pkg.styles.forEach((rule, i) => {
    const fgRaw = rule?.set?.color;
    const bgRaw = rule?.set?.["background-color"];
    if (fullHex(fgRaw) && fullHex(bgRaw)) return; // validateStyles measured it
    const fg = hexOf(fgRaw);
    const bg = hexOf(bgRaw);
    if (fg && bg && contrastRatio(fg, bg) < MIN_CONTRAST) issues.push({ code: "contrast", path: `styles[${i}].set.color`, message: `This text colour is hard to read on its background (needs ${MIN_CONTRAST}:1 contrast).` });
  });
}

// A key directly under templates.home.sections[i].settings that the section's
// kind declares as a setting (rich_text's "html").
const SETTINGS_PATH_RE = /^templates\.home\.sections\[(\d+)\]\.settings$/;
const declaredSettingKey = (root) => (path, key) => {
  const m = SETTINGS_PATH_RE.exec(path);
  if (!m) return false;
  const kind = root?.templates?.home?.sections?.[Number(m[1])]?.kind;
  const decl = typeof kind === "string" && HOME_KINDS().includes(kind) ? sectionType(kind) : null;
  return Boolean(decl?.settings.some((s) => s.key === key));
};

/** Parse, scan and check one uploaded package's text. */
export function parseThemePackage(textIn) {
  const raw = String(textIn ?? "");
  if (utf8Bytes(raw) > LIMITS.bytes) return { issues: [{ code: "too-big", path: "", message: MESSAGES.tooBig }], status: 413 };
  let value;
  try {
    value = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return { issues: [{ code: "not-json", path: "", message: MESSAGES.notJson }] };
  }
  if (!isObj(value)) return { issues: [{ code: "not-json", path: "", message: MESSAGES.wrongFormat }] };
  const refused = scanPackage(value, { declaredKey: declaredSettingKey(value) });
  if (refused.length) return { issues: refused };

  const issues = [];
  unknownKeys(value, TOP_KEYS, "", issues);
  if (value.format !== FORMAT) issues.push({ code: "format", path: "format", message: MESSAGES.wrongFormat });
  if (typeof value.id !== "string" || !THEME_ID_RE.test(value.id)) issues.push({ code: "invalid", path: "id", message: "The theme's id must be 1 to 40 lowercase letters, digits or dashes." });
  const name = text(value.name, { path: "name", max: NAME_MAX, required: true, words: "a name" }, issues);
  if (typeof value.version !== "string" || !VERSION_RE.test(value.version)) issues.push({ code: "invalid", path: "version", message: "The version must look like 1.2.0." });
  let author = "";
  if (value.author != null) {
    if (!isObj(value.author)) issues.push({ code: "invalid", path: "author", message: "The author must be a name." });
    else {
      unknownKeys(value.author, ["name"], "author", issues);
      author = text(value.author.name, { path: "author.name", max: AUTHOR_MAX, words: "the author's name" }, issues);
    }
  }
  const description = text(value.description, { path: "description", max: DESCRIPTION_MAX, words: "the description" }, issues);
  if (!BASES.includes(value.base)) issues.push({ code: "invalid", path: "base", message: `The base look must be ${BASES.join(" or ")}.` });
  const tokens = checkTokens(value.tokens, issues);
  const surfaces = checkSurfaces(value.surfaces, issues);
  const templates = checkTemplates(value.templates, issues);
  const styleIssues = validateStyles(value.styles);
  issues.push(...styleIssues.map((x) => ({ code: "style", ...x })));
  const pkg = {
    format: FORMAT,
    id: value.id,
    name,
    version: value.version,
    ...(author ? { author: { name: author } } : {}),
    ...(description ? { description } : {}),
    base: value.base,
    tokens,
    surfaces,
    templates,
    styles: Array.isArray(value.styles) ? value.styles.map((r) => ({ part: r?.part, set: { ...(r?.set || {}) } })) : [],
  };
  if (!styleIssues.length && BASES.includes(value.base)) roleContrast(pkg, issues);
  if (issues.length) return { issues: issues.slice(0, LIMITS.issues) };
  return { pkg };
}
