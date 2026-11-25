// Phase 4 line 1: the first-party plugins Storeasy ships, in code. Pure and
// Edge-safe. registerPlugin() is a test-only seam (like
// registerSectionComponent): suites add fixture plugins and undo them.
import { defineManifest, checkManifests } from "./manifest.js";
import { checkDefaults } from "./settings.js";
import trustBadges from "./first-party/trust-badges/manifest.js";

const BUILT_IN = Object.freeze([trustBadges]);
let extra = [];

export const catalog = () => [...BUILT_IN, ...extra];
export const pluginById = (id) => catalog().find((m) => m.id === id) || null;

// → an undo function
export function registerPlugin(manifest) {
  const m = defineManifest(manifest);
  if (pluginById(m.id)) throw new Error(`plugin ${m.id} is already in the catalog`);
  extra = [...extra, m];
  return () => {
    extra = extra.filter((x) => x !== m);
  };
}

// The operator kill switch: a feature flag per plugin (lib/platform/flags.js
// KEY_RE, copied here so this file stays Edge-safe; test:apps compares them).
export const killFlag = (pluginId) => `ff_plugin-${pluginId}`;
export const KILL_FLAG_RE = /^ff_[a-z0-9][a-z0-9-]{0,40}$/;

// The catalog's contract: [] when every manifest keeps its promises, and every
// plugin's kill switch is a flag key an operator can set.
export function checkCatalog() {
  const problems = checkManifests(catalog(), checkDefaults);
  for (const m of catalog()) if (!KILL_FLAG_RE.test(killFlag(m.id))) problems.push(`plugin ${m.id}: its kill switch ${killFlag(m.id)} isn't a valid flag key (keep the id to 31 characters)`);
  return problems;
}
