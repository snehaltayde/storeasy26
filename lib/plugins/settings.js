// Phase 4 line 1: a plugin install's settings, checked against its manifest
// and split into the plain part (plugin_installs.settings) and the secret part
// (plugin_installs.secrets_enc). Pure and Edge-safe.
//
// Values of kind text, number, boolean and choice are checked by the registry
// (lib/registry/settings.js checkSetting); a list's items are objects whose
// fields are checked the same way. A secret is write-only: in a save, a
// non-empty string sets it, null clears it, and leaving the key out keeps it.
// Errors are plain words per field and never quote a value, so a secret typed
// into the wrong box can't come back in a refusal, a log or an audit row.
import { checkSetting, defineSetting } from "../registry/settings.js";
import { SECRET_MAX } from "./manifest.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const labelOf = (s) => s.label || s.key.charAt(0).toUpperCase() + s.key.slice(1).replace(/_/g, " ");

// A registry setting from a manifest field (the registry fills the label).
const asSetting = (f, where) => defineSetting(f, where);

function checkPlain(s, value, path, errors) {
  const report = (field, _code, message, cls) => {
    if (cls === "warning") return;
    if (!errors[field]) errors[field] = message;
  };
  return checkSetting(asSetting(s, path), value, path, report);
}

function checkList(s, value, errors) {
  const label = labelOf(s);
  if (value == null) {
    if (s.required) errors[s.key] = `The ${lower(label)} list is empty. Add at least one.`;
    return value;
  }
  if (!Array.isArray(value)) {
    errors[s.key] = `The ${lower(label)} couldn't be read. Reload the page and try again.`;
    return value;
  }
  if (value.length > s.max) errors[s.key] = `The ${lower(label)} list has ${value.length} items, and the limit is ${s.max}. Remove ${value.length - s.max}.`;
  const keys = s.fields.map((f) => f.key);
  return value.map((item, i) => {
    const at = `${s.key}.${i}`;
    if (!isObj(item)) {
      errors[at] = "This item couldn't be read. Remove it and add it again.";
      return item;
    }
    if (Object.keys(item).some((k) => !keys.includes(k))) errors[at] = "This item holds something this plugin doesn't use, so nothing was saved. Remove it and add it again.";
    const out = {};
    for (const f of s.fields) {
      const v = checkPlain(f, item[f.key], `${at}.${f.key}`, errors);
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  });
}

// The settings a fresh install starts with: each non-secret default.
export function defaultSettings(manifest) {
  const out = {};
  for (const s of manifest.settings) if (s.kind !== "secret" && s.default !== undefined) out[s.key] = structuredClone(s.default);
  return out;
}

// checkSettings(manifest, input, { settings, secretKeysSet })
//   input: the whole form's values ({ key: value }); a secret key may be
//     absent (keep), null (clear) or a string (set)
//   settings: the install's current plain settings (unused keys keep nothing:
//     a save replaces the plain part whole)
// → { ok, errors: { field: message }, settings, secretUpdates: { key: string|null },
//     changed: [plain keys whose value changed], hiddenChanged: n }
export function checkSettings(manifest, input, { settings: current = {} } = {}) {
  const errors = {};
  if (!isObj(input)) return { ok: false, errors: { _: "The settings couldn't be read. Reload the page and try again." } };
  const declared = new Map(manifest.settings.map((s) => [s.key, s]));
  const unknown = Object.keys(input).filter((k) => !declared.has(k));
  if (unknown.length) errors._ = `This plugin has no setting called ${unknown.map((k) => `"${String(k).slice(0, 40)}"`).join(", ")}, so nothing was saved. Reload the page and try again.`;
  const settings = {};
  const secretUpdates = {};
  for (const s of manifest.settings) {
    const has = Object.hasOwn(input, s.key);
    const value = input[s.key];
    if (s.kind === "secret") {
      if (!has) continue;
      if (value === null) secretUpdates[s.key] = null;
      else if (typeof value !== "string" || !value.trim()) errors[s.key] = `The ${lower(labelOf(s))} must be text. Leave it alone to keep what is saved.`;
      else if (value.length > (s.max ?? SECRET_MAX)) errors[s.key] = `The ${lower(labelOf(s))} is too long (the limit is ${s.max ?? SECRET_MAX} characters).`;
      else secretUpdates[s.key] = value;
      continue;
    }
    const v = s.kind === "list" ? checkList(s, value, errors) : checkPlain(s, value, s.key, errors);
    if (v !== undefined && v !== null) settings[s.key] = v;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const changed = manifest.settings.filter((s) => s.kind !== "secret" && JSON.stringify(settings[s.key] ?? null) !== JSON.stringify(current[s.key] ?? null)).map((s) => s.key);
  return { ok: true, errors: {}, settings, secretUpdates, changed, hiddenChanged: Object.keys(secretUpdates).length };
}

// Which secrets hold a value: { key: true|false } for every secret setting.
export function secretsSet(manifest, secrets) {
  const out = {};
  for (const s of manifest.settings) if (s.kind === "secret") out[s.key] = typeof secrets?.[s.key] === "string" && secrets[s.key].length > 0;
  return out;
}

// For checkManifests: a manifest's defaults pass its own checks.
export function checkDefaults(manifest) {
  const r = checkSettings(manifest, defaultSettings(manifest));
  return r.ok ? [] : [`plugin ${manifest.id}: its defaults fail its own checks (${Object.keys(r.errors).join(", ")})`];
}
