// Phase 4 line 1: the first-party plugins Storeasy ships, in code. Pure and
// Edge-safe. registerPlugin() is a test-only seam (like
// registerSectionComponent): suites add fixture plugins and undo them.
import { defineManifest, checkManifests } from "./manifest.js";
import { checkDefaults } from "./settings.js";
import trustBadges from "./first-party/trust-badges/manifest.js";
// Phase 9 lines import their manifest at their own anchor (one per line).
// p9: reviews
// p9: subscriptions
// p9: whatsapp
// p9: shiprocket
// p9: ai-copilot

const BUILT_IN = Object.freeze([
  trustBadges,
  // p9: reviews
  // p9: subscriptions
  // p9: whatsapp
  // p9: shiprocket
  // p9: ai-copilot
]);
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
// A custom app's stored id is custom:<16 hex>, and a colon isn't allowed in a
// flag key, so it maps to ff_plugin-custom-<hex>. No first-party id may start
// with custom- (checkCatalog), so the two can't share a switch.
export const killFlag = (pluginId) => `ff_plugin-${String(pluginId).replace(/^custom:/, "custom-")}`;
export const KILL_FLAG_RE = /^ff_[a-z0-9][a-z0-9-]{0,40}$/;

// The catalog's contract: [] when every manifest keeps its promises, and every
// plugin's kill switch is a flag key an operator can set.
export function checkCatalog() {
  const problems = checkManifests(catalog(), checkDefaults);
  for (const m of catalog()) if (m.id.startsWith("custom-")) problems.push(`plugin ${m.id}: ids starting with custom- are kept for custom apps' kill switches`);
  for (const m of catalog()) if (!KILL_FLAG_RE.test(killFlag(m.id))) problems.push(`plugin ${m.id}: its kill switch ${killFlag(m.id)} isn't a valid flag key (keep the id to 34 characters)`);
  return problems;
}
