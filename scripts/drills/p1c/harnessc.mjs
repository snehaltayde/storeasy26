// P1-DRILLS-C · batch B re-runs of the P1-HARNESS findings that batch C fixed:
//   c-checkout-width  finding 6: checkout with one item at 320, 360, 375, 390 and
//                     414, no sideways scroll, "Payment" fully visible
//                     (scripts/drills/p1/tok.mjs width part)
//   c-designer        finding 1: the Designer with the hero-promise test running and
//                     the founder's browser in variant b: the preview shows the
//                     founder's words while typing and after Save, and sends no
//                     exposure (scripts/drills/p1/pv08.mjs designer part)
//   DESIGN_PORT=3231 TOK_LABEL=c node scripts/drills/p1c/run.mjs harnessc
// Screenshots and results go to docs/cms-reviews/drills/harness/.
import { parts as tok } from "../p1/tok.mjs";
import { parts as pv08 } from "../p1/pv08.mjs";

export const id = "harness";
export const title = "P1-DRILLS-C: P1-HARNESS findings 1 and 6 again";
export const parts = { "c-checkout-width": tok.width, "c-designer": pv08.designer };
