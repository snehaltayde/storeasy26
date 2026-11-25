// Phase 4 line 1: a plugin's manifest, checked. Pure and Edge-safe: no React,
// no Next, no node: imports (a storefront file may reach it through line 2).
//
// A manifest (lib/types/ecosystem.ts PluginManifest):
//   { id, name, version, summary, description, icon, author: { name },
//     scopes: [APP_PERMISSIONS keys], settings: [setting] }
// A setting is a registry setting of kind text, number, boolean or choice
// (lib/registry/settings.js checks its values), or
//   { key, kind: "list", label, max, fields: [text|number|boolean|choice settings] }
//   { key, kind: "secret", label, max? }   write-only: stored encrypted, never shown
// checkManifest() returns plain problems ([] when the manifest keeps its
// promises); defineManifest() throws on any (a bug in code, found when the
// module loads) and freezes the result.
import { APP_PERMISSIONS } from "../platform/authz.js";
import { defineSetting } from "../registry/settings.js";
import { SUBSCRIBABLE, requiredScope } from "./topics.js";
import { hostProblem } from "./hosts.js";

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
// The lucide-react icons a plugin may name (components/admin/apps/plugin-icon.js maps them).
export const PLUGIN_ICONS = Object.freeze(["BadgeCheck", "Puzzle", "ShieldCheck", "Truck", "Star", "Megaphone", "MessageCircle", "ChartBar"]);
export const FIELD_KINDS = Object.freeze(["text", "number", "boolean", "choice"]);
export const SETTING_KINDS = Object.freeze([...FIELD_KINDS, "list", "secret"]);
export const SECRET_MAX = 500;
const KNOWN_KEYS = ["id", "name", "version", "summary", "description", "icon", "author", "scopes", "settings", "events", "egress"];
// line 2: blocks
// line 3: events
//   events: [topic]   store events the plugin receives (lib/plugins/topics.js
//                     SUBSCRIBABLE); each needs its topic's scope in scopes.
//                     The handlers live in lib/plugins/handlers.js (code, not data).
//   egress: [host]    the only hosts its handlers may call (safeFetch's
//                     allowlist): plain public DNS names, never Shopify.
function checkEvents(m, where, problems) {
  if (m.events !== undefined) {
    if (!Array.isArray(m.events)) problems.push(`${where}: events must be a list`);
    else {
      for (const t of m.events) {
        if (!SUBSCRIBABLE.includes(t)) problems.push(`${where}: unknown event "${t}"`);
        else if (!Array.isArray(m.scopes) || !m.scopes.includes(requiredScope(t))) problems.push(`${where}: event "${t}" needs the ${requiredScope(t)} scope`);
      }
      if (new Set(m.events).size !== m.events.length) problems.push(`${where}: an event is listed twice`);
    }
  }
  if (m.egress !== undefined) {
    if (!Array.isArray(m.egress) || m.egress.length > 10) problems.push(`${where}: egress must be a list of up to 10 hosts`);
    else for (const h of m.egress) {
      const problem = typeof h === "string" && h === h.toLowerCase() ? hostProblem(h) : "use a lower-case host name";
      if (problem) problems.push(`${where}: egress host "${String(h).slice(0, 80)}": ${problem}`);
    }
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function checkField(s, where, problems) {
  if (!FIELD_KINDS.includes(s?.kind)) {
    problems.push(`${where}: a list field must be text, number, boolean or choice`);
    return;
  }
  try {
    defineSetting(s, where);
  } catch (e) {
    problems.push(e.message);
  }
}

function checkSettings(settings, where, problems) {
  if (!Array.isArray(settings)) {
    problems.push(`${where}: settings must be a list`);
    return;
  }
  const keys = new Set();
  settings.forEach((s, i) => {
    const at = `${where} setting ${i}`;
    if (!isObj(s) || typeof s.key !== "string" || !KEY_RE.test(s.key)) {
      problems.push(`${at}: a setting needs a key of lower-case letters, digits and _`);
      return;
    }
    if (keys.has(s.key)) problems.push(`${at}: the key "${s.key}" is used twice`);
    keys.add(s.key);
    if (!SETTING_KINDS.includes(s.kind)) {
      problems.push(`${at}: "${s.key}" has an unknown kind "${s.kind}"`);
      return;
    }
    if (s.kind === "secret") {
      if (s.default !== undefined) problems.push(`${at}: secret "${s.key}" can't have a default`);
      if (s.max != null && !(Number.isInteger(s.max) && s.max > 0 && s.max <= SECRET_MAX)) problems.push(`${at}: secret "${s.key}" has a bad max`);
      return;
    }
    if (s.kind === "list") {
      if (!(Number.isInteger(s.max) && s.max >= 1 && s.max <= 50)) problems.push(`${at}: list "${s.key}" needs a max from 1 to 50`);
      if (!Array.isArray(s.fields) || !s.fields.length) {
        problems.push(`${at}: list "${s.key}" needs fields`);
        return;
      }
      const fk = new Set();
      s.fields.forEach((f, j) => {
        if (fk.has(f?.key)) problems.push(`${at} field ${j}: the key "${f.key}" is used twice`);
        fk.add(f?.key);
        checkField(f, `${at} field ${j}`, problems);
      });
      return;
    }
    checkField(s, at, problems);
  });
}

export function checkManifest(m) {
  const problems = [];
  if (!isObj(m)) return ["a manifest must be an object"];
  const where = `plugin ${typeof m.id === "string" ? m.id : "?"}`;
  for (const k of Object.keys(m)) if (!KNOWN_KEYS.includes(k)) problems.push(`${where}: unknown field "${k}"`);
  if (typeof m.id !== "string" || !PLUGIN_ID_RE.test(m.id)) problems.push(`${where}: the id must be a slug of 2 to 49 lower-case letters, digits and dashes`);
  if (!str(m.name, 60)) problems.push(`${where}: a name of 1 to 60 characters is needed`);
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) problems.push(`${where}: the version must be semver (1.0.0)`);
  if (!str(m.summary, 160)) problems.push(`${where}: a summary of 1 to 160 characters is needed`);
  if (!str(m.description, 2000)) problems.push(`${where}: a description of 1 to 2000 characters is needed`);
  if (!PLUGIN_ICONS.includes(m.icon)) problems.push(`${where}: the icon must be one of ${PLUGIN_ICONS.join(", ")}`);
  if (!isObj(m.author) || !str(m.author.name, 80)) problems.push(`${where}: author.name is needed`);
  if (!Array.isArray(m.scopes)) problems.push(`${where}: scopes must be a list`);
  else {
    for (const s of m.scopes) if (!Object.hasOwn(APP_PERMISSIONS, s)) problems.push(`${where}: unknown scope "${s}" (APP_PERMISSIONS in lib/platform/authz.js)`);
    if (new Set(m.scopes).size !== m.scopes.length) problems.push(`${where}: a scope is listed twice`);
  }
  checkSettings(m.settings, where, problems);
  checkEvents(m, where, problems);
  return problems;
}

const deepFreeze = (v) => {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

export function defineManifest(m) {
  const problems = checkManifest(m);
  if (problems.length) throw new Error(`Bad plugin manifest: ${problems.join("; ")}`);
  return deepFreeze(structuredClone(m));
}

// The manifests' contract, as checkRegistry() checks the registry: every
// manifest valid, ids unique, every default a value its own check accepts.
// checkDefaults is lib/plugins/settings.js checkDefaults (passed in, so this
// file stays free of it). → [] when all is well.
export function checkManifests(manifests, checkDefaults) {
  const problems = [];
  const ids = new Set();
  for (const m of manifests) {
    problems.push(...checkManifest(m));
    if (ids.has(m?.id)) problems.push(`plugin ${m.id}: the id is used twice`);
    ids.add(m?.id);
    if (checkDefaults) problems.push(...checkDefaults(m));
  }
  return problems;
}
