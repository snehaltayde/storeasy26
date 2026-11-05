// P5-DRILLS: the phase 5 drills, in desktop Chrome on the design harness.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 [P5_BASELINE_WORKTREE=<dir>] \
//     node scripts/drills/p5/run.mjs [stage,stage…] [--headed]
//
// Ports: the harness takes DESIGN_PORT and three database ports from
// DESIGN_SQLD_PORT. 3017 (the owner's harness) is refused. Each stage seeds
// the store fresh and starts and stops its own harness.
//
// Stages (all of them, in this order, when none is named):
//   baseline   legacy.mjs: the legacy store's shopper captures and the
//              a6d028e-style home render, from a throwaway read-only worktree
//              at afd7881 (removed after): baseline-legacy/
//   legacy     legacy.mjs: the same captures on this tree, compared byte for
//              byte (after the P4 comparison's own masking); the old editors
//              offer no bundle kinds
//   pick       blocks.mjs: US-28, editor to live Bundle card, timed
//   create     blocks.mjs: COM-02, the inline create
//   states     blocks.mjs: US-33, a component sold out
//   nosaving   blocks.mjs: OQ-B, a price that no longer saves anything
//   disabled   blocks.mjs: US-34 (bundle half), turned off in Catalog > Bundles
//   grid       blocks.mjs: a grid of 4 (available, sold out, off, deleted)
//   cart       blocks.mjs: card and bundle page carts equal; a COD test order,
//              cancelled
//   console    blocks.mjs: Catalog > Bundles, no slug or GID inputs, a price edit
//   unknown    blocks.mjs: TREE-01, a draft with an unknown source is refused
//
// Results: docs/cms-reviews/drills/P5-DRILLS/results-<stage>.json with the
// screenshots, and the summary results-run[-<stages>].json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT, runningHarness } from "../../design-harness.js";
import { DRILL_ID, OUT, p3Ports, runDrill } from "./lib.mjs";

const STAGE_FILES = {
  baseline: ["./legacy.mjs", "baselineStage"],
  legacy: ["./legacy.mjs", "legacyStage"],
  pick: ["./blocks.mjs", "pickStage"],
  create: ["./blocks.mjs", "createStage"],
  states: ["./blocks.mjs", "statesStage"],
  nosaving: ["./blocks.mjs", "nosavingStage"],
  disabled: ["./blocks.mjs", "disabledStage"],
  grid: ["./blocks.mjs", "gridStage"],
  cart: ["./blocks.mjs", "cartStage"],
  console: ["./blocks.mjs", "consoleStage"],
  unknown: ["./blocks.mjs", "unknownStage"],
};
export const STAGES = Object.keys(STAGE_FILES);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

async function main() {
  p3Ports();
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new Error(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). The phase 5 drills seed the store fresh and start their own: stop it first.`);
  const [only] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const wanted = only ? only.split(",") : STAGES;
  for (const w of wanted) if (!STAGES.includes(w)) throw new Error(`There is no stage "${w}". Stages: ${STAGES.join(", ")}.`);
  mkdirSync(OUT, { recursive: true });
  const rows = [];
  const started = new Date().toISOString();
  for (const stage of wanted) {
    console.log(`\n=== ${stage}`);
    const t0 = Date.now();
    const [file, name] = STAGE_FILES[stage];
    const mod = await import(file);
    const code = await runDrill({ id: DRILL_ID, part: stage, title: `${DRILL_ID} — ${stage}` }, mod[name]);
    const res = readJson(join(OUT, `results-${stage}.json`));
    rows.push({ stage, exit: code, seconds: Math.round((Date.now() - t0) / 1000), passed: res?.passed, failed: res?.failed, known: res?.knownFailures, results: `results-${stage}.json` });
  }
  const summary = { ranAt: started, finishedAt: new Date().toISOString(), stages: wanted, rows, failed: rows.filter((r) => r.exit !== 0 || r.failed).length };
  const file = join(OUT, only ? `results-run-${wanted.join("-").slice(0, 60)}.json` : "results-run.json");
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\n=== summary");
  for (const r of rows) console.log(`${r.exit === 0 && !r.failed ? "ok  " : "FAIL"} ${r.stage}: ${r.passed ?? "?"} passed, ${r.failed ?? "?"} failed${r.known ? `, ${r.known} known` : ""} (${r.seconds} s)`);
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✗ ${e.message || e}`);
      process.exit(1);
    },
  );
}
