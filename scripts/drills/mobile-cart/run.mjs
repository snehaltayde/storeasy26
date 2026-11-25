// MOBILE-CART: `pnpm drill:mobile-cart`, the phone buy bar and the cart drawer
// with tiered offers in a real browser (Phase 7 line 3, docs/plans/phase-7.md).
// Run by scripts/drills/run-isolated.mjs in a throwaway worktree on its own
// roles store; never in the owner's checkout. A 390×844 touch phone with
// reduced motion. Stages (stage-<name>.mjs) run in STAGE_FILES order; the
// drawer stage continues on the page the bar stage left open. A run with no
// stage fails. Never pays: it stops at checkout's total.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port, shopperErrors } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE_FILES = ["stage-bar.mjs", "stage-drawer.mjs"];
for (const file of STAGE_FILES) {
  const path = join(HERE, file);
  if (existsSync(path)) await import(pathToFileURL(path).href);
}

async function mobileCart(drill) {
  if (!port) throw new Error("drill:mobile-cart needs ROLES_PORT (run it as pnpm drill:mobile-cart).");
  drill.check(STAGES.length === STAGE_FILES.length, "every stage file exists", STAGE_FILES);
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  const errors = [...consoleErrors, ...shopperErrors];
  drill.check(errors.length === 0, "no error in the browser console", errors);
}

runDrill({ id: "MOBILE-CART", part: "main", title: "MOBILE-CART — phone buy bar, cart drawer nudges, checkout total" }, mobileCart).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
