// CHECKOUT: `pnpm drill:checkout`, the shopper's checkout in a real browser
// (Phase 8, docs/plans/phase-8.md "Order and parallelism", step 0). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store; never in the owner's checkout. Stages (stage-<name>.mjs) run in
// STAGE_FILES order; lines 1, 2, 3 and 5 append theirs (append-only file).
// A run with no stage fails. Only cash on delivery: never enters card details.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port, shopperErrors } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE_FILES = ["stage-baseline.mjs", "stage-cod.mjs", "stage-pincode.mjs"];
for (const file of STAGE_FILES) {
  const path = join(HERE, file);
  if (existsSync(path)) await import(pathToFileURL(path).href);
}

async function checkout(drill) {
  if (!port) throw new Error("drill:checkout needs ROLES_PORT (run it as pnpm drill:checkout).");
  drill.check(STAGES.length === STAGE_FILES.length, "every stage file exists", STAGE_FILES);
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  const errors = [...consoleErrors, ...shopperErrors];
  drill.check(errors.length === 0, "no error in the browser console", errors);
}

runDrill({ id: "CHECKOUT", part: "main", title: "CHECKOUT — address, review, cash on delivery order placed" }, checkout).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
