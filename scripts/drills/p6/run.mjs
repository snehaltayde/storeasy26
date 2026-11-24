// P6-DRILLS: `pnpm drill:p6`, the phase 6 drills (GEN-01, GEN-04, PUB-12;
// US-01, US-04, US-41), in desktop Chrome on the design harness
// (docs/cms-reviews/P1-HARNESS.md).
//
//   pnpm drill:p6 [-- stage,stage…] [--headed]
//
// Only in a throwaway worktree (scripts/drills/run-isolated.mjs): runDrill
// refuses anywhere else. The runner picks DESIGN_PORT and three database
// ports from DESIGN_SQLD_PORT; 3017 (the owner's harness) is refused. Every stage stops
// the harness, seeds (seed-design-documents.js --p3, or --p6 --stage <s>),
// starts it again and drives Chrome: withHarnessStore refuses a write while
// the harness runs. Shopify, payment and AI keys are blank for the seed and the
// harness (lib.mjs stageEnv), and a stage is refused if this shell names one.
//
// Stages, in this order (all of them when none is named):
//   baseline  generate.mjs: seed --p3, the P3-CLOSED RSC probe on the P3
//             closed store (closed.localhost), with an open-store control
//   a         generate.mjs: US-01, /admin/onboarding?step=brand makes the store with no AI
//             key; the preview; the closed storefront; the probe again on the
//             generated, unpublished p6 store
//   b         brand.mjs: GEN-04, Forest, a PNG logo, a description; Reset to
//             the starting colours; the Skip variant on a re-seed
//   c         open.mjs: US-41, "Before you open your store" until both policy
//             pages are read or saved; a COD test order, cancelled; open
//   d         open.mjs: checkout off blocks opening; turned on in Settings
//   e         empty.mjs: US-04, an empty catalog, a later refill, no collections
//   g         setup.mjs: onboarding step 4's policy starters
//   h         onboarding.mjs: the four-step onboarding page (states, resume
//             via ?step=, support read-only with reasons, an open store all done)
//   j         open-step.mjs: Phase 1 line 7, the store opened from onboarding
//             step 4 (checkout on, Back to onboarding, both policies read in
//             the reader, contact details, the open dialog; the shopper sees
//             home; support sees everything disabled)
//
// Results: docs/cms-reviews/drills/P6-DRILLS/results-<stage>.json with the
// screenshots, and the summary results.json (results-run-<stages>.json for a
// partial run).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT, runningHarness } from "../../design-harness.js";
import { DRILL_ID, OUT, assertIsolated, blankKeysHere, p3Ports, runDrill } from "./lib.mjs";
import { realKeysSet } from "./seed-p6.mjs";

const STAGE_FILES = {
  baseline: ["./generate.mjs", "baselineStage"],
  a: ["./generate.mjs", "generateStage"],
  b: ["./brand.mjs", "brandStage"],
  c: ["./open.mjs", "openStage"],
  d: ["./open.mjs", "paymentStage"],
  e: ["./empty.mjs", "emptyStage"],
  g: ["./setup.mjs", "setupStage"],
  h: ["./onboarding.mjs", "onboardingStage"],
  j: ["./open-step.mjs", "openStepStage"],
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
  assertIsolated(process.env, ROOT);
  p3Ports();
  const real = realKeysSet();
  if (real.length) throw new Error(`This shell names a Shopify store or a payment secret (${real.join(", ")}). The phase 6 drill only runs with them blank: unset them first.`);
  blankKeysHere(); // the harness this run starts gets no AI key either
  if (!process.env.PLATFORM_CACHE_MS) process.env.PLATFORM_CACHE_MS = "1000";
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new Error(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). The phase 6 drills seed the stores fresh and start their own: stop it first.`);
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
    const fn = (await import(file))[name];
    const code = await runDrill({ id: DRILL_ID, part: stage, title: `${DRILL_ID} — ${stage}` }, fn);
    const res = readJson(join(OUT, `results-${stage}.json`));
    rows.push({ stage, exit: code, seconds: Math.round((Date.now() - t0) / 1000), passed: res?.passed, failed: res?.failed, known: res?.knownFailures, results: `results-${stage}.json` });
  }
  const summary = { id: DRILL_ID, ranAt: started, finishedAt: new Date().toISOString(), stages: wanted, rows, passed: rows.reduce((n, r) => n + (r.passed || 0), 0), failed: rows.filter((r) => r.exit !== 0 || r.failed).length };
  const file = join(OUT, only ? `results-run-${wanted.join("-").slice(0, 60)}.json` : "results.json");
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
