// P1-RATES: FIX-C's c-rates drill again, with its results under drills/RATES/.
//   DESIGN_PORT=3251 node scripts/drills/p1c/run.mjs ratesd c-rates
import { parts as fixc } from "./fixc-c.mjs";

export const id = "RATES";
export const title = "P1-RATES: the amount charged is the amount on the button pressed";
export const parts = { "c-rates": fixc["c-rates"] };
