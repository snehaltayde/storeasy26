// P1-DRILLS-C · batch B re-run: the DOC-04 extra (P1-DRILLS finding 5). With
// every cms_pages read failing "no such column", the page editor must show
// "This page hit an error", not 404, and a Designer save must say it saved but
// couldn't refresh. Reuses scripts/drills/p1/fixc.mjs's missingcol part.
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs doc04c
// Screenshots and results go to docs/cms-reviews/drills/DOC-04/ (missingcol-*, results-c-missingcol.json).
import { parts as fixc } from "../p1/fixc.mjs";

export const id = "DOC-04";
export const title = "P1-DRILLS-C: DOC-04 extra again (a missing column is not a missing page)";
export const parts = { "c-missingcol": fixc.missingcol };
