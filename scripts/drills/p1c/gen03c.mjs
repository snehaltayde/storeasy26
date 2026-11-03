// P1-DRILLS-C · batch B re-run: GEN-03 drill 6 (P1-DRILLS finding 1), which
// FIX-C was meant to fix. Reuses the FIX-C journey's own parts (scripts/drills/p1/fixc.mjs):
//   c-settings  Settings: save shipping rates, reload at once (and 4 more, and a new tab)
//   c-brand     Brand: Save brand, open Publishing at once, Publish now answers 200
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs gen03c
// Screenshots and results go to docs/cms-reviews/drills/GEN-03/ (settings-*, brand-*, results-c-*.json).
import { parts as fixc } from "../p1/fixc.mjs";

export const id = "GEN-03";
export const title = "P1-DRILLS-C: GEN-03 drill 6 again (Settings and Brand, at once)";
export const parts = { "c-settings": fixc.settings, "c-brand": fixc.brand };
