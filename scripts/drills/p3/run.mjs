// P3-DRILLS runner: every phase 3 browser drill, in desktop Chrome on the
// design harness, one after another, each on a fresh seed. Not a gate suite
// and not a package.json script: it needs the harness and Chrome.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 DRILL_HTTPS_PORT=7106 \
//     DRILL_TMP=<scratch> DRILL_SCRATCH=<scratch> \
//     node scripts/drills/p3/run.mjs [stage,stage…] [--headed]
//
// Stages (all of them when none is named):
//   items    the per-item drills, each its own process: smoke (P3-HARNESS),
//            routes (P3-ROUTES), editor (P3-EDITOR), design (P3-DESIGN),
//            rte (P3-RTE). They seed the phase 3 store (--p3) themselves.
//   matrix   the cross-item matrix (matrix.mjs), part by part, each part on a
//            fresh --p3 seed
//   legacy   drill:smoke and drill:edge, unchanged, on the plain legacy seed,
//            through the P2 runner's legacy part (scripts/drills/p2/run.mjs)
//   p2       every P2 drill part (scripts/drills/p2/run.mjs) on the P2 seed
//            (the --p3 store refuses the shared setup password the P2 drills
//            sign in with, so the two families run on different seeds)
//
// The per-item drills write their results into their own folders
// (docs/cms-reviews/drills/<ITEM>/); a copy of each goes to
// docs/cms-reviews/drills/P3-DRILLS/items/. The summary of a run is
// docs/cms-reviews/drills/P3-DRILLS/results-run.json.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT, runningHarness } from "../../design-harness.js";
import { p3Ports } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "docs", "cms-reviews", "drills", "P3-DRILLS");

export const ITEMS = [
  { name: "smoke", file: "smoke.mjs", id: "P3-HARNESS", part: "smoke" },
  { name: "routes", file: "routes.mjs", id: "P3-ROUTES", part: "routes" },
  { name: "editor", file: "editor.mjs", id: "P3-EDITOR", part: "editor" },
  { name: "design", file: "design.mjs", id: "P3-DESIGN", part: "design" },
  { name: "rte", file: "rte.mjs", id: "P3-RTE", part: "rte" },
];
export const STAGES = ["items", "matrix", "legacy", "p2"];

function run(args, { timeoutMs = 3_600_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (c) => {
      out += c;
      process.stdout.write(c);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const t = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const counts = (r) => (r ? { passed: r.passed, failed: r.failed, known: r.knownFailures || 0, aborted: r.aborted ? String(r.aborted).slice(0, 300) : undefined } : null);

async function items(rows, list = ITEMS) {
  mkdirSync(join(OUT, "items"), { recursive: true });
  for (const it of list) {
    console.log(`\n=== item drill: ${it.name} (${it.id})`);
    const r = await run([join(here, it.file), ...process.argv.filter((a) => a === "--headed")]);
    const file = join(ROOT, "docs", "cms-reviews", "drills", it.id, `results-${it.part}.json`);
    const res = readJson(file);
    if (res) copyFileSync(file, join(OUT, "items", `${it.id}-results-${it.part}.json`));
    rows.push({ stage: "items", name: it.name, id: it.id, exit: r.code, seconds: r.seconds, ...counts(res), results: `items/${it.id}-results-${it.part}.json` });
  }
}

async function matrix(rows, names) {
  const { PART_NAMES, runParts } = await import("./matrix.mjs");
  for (const part of names || PART_NAMES) {
    console.log(`\n=== matrix: ${part}`);
    const started = Date.now();
    const code = await runParts([part]).catch((e) => (console.error(e), 1));
    const res = readJson(join(OUT, `results-${part}.json`));
    rows.push({ stage: "matrix", name: part, exit: code ? 1 : 0, seconds: Math.round((Date.now() - started) / 1000), ...counts(res), clicks: res?.notes?.filter((n) => /timing|clicks/.test(n)) || [], results: `results-${part}.json` });
  }
}

async function p2(rows, parts) {
  console.log(`\n=== P2 drills${parts ? `: ${parts}` : ""} (the P2 seed)`);
  const r = await run([join(ROOT, "scripts", "drills", "p2", "run.mjs"), ...(parts ? [parts] : []), ...process.argv.filter((a) => a === "--headed")]);
  for (const part of (parts || "sections,hero-image,policy-typo,error-chrome,edge,preview,unfinished,redirect,space,legacy").split(",")) {
    const res = readJson(join(ROOT, "scripts", "drills", "p2", `results-${part}.json`));
    rows.push({ stage: parts === "legacy" ? "legacy" : "p2", name: part, exit: r.code, ...counts(res), results: `scripts/drills/p2/results-${part}.json` });
  }
}

async function main() {
  p3Ports();
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new Error(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). The drills seed the store fresh and start their own: stop it first.`);
  const [only] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const wanted = only ? only.split(",") : STAGES;
  const { PART_NAMES } = await import("./matrix.mjs");
  const matrixParts = wanted.filter((w) => PART_NAMES.includes(w));
  for (const w of wanted) if (!STAGES.includes(w) && !matrixParts.includes(w) && !ITEMS.some((i) => i.name === w)) throw new Error(`There is no stage "${w}". Stages: ${STAGES.join(", ")}; or matrix parts: ${PART_NAMES.join(", ")}.`);
  const rows = [];
  const started = new Date().toISOString();
  if (wanted.includes("items")) await items(rows);
  else if (ITEMS.some((i) => wanted.includes(i.name))) await items(rows, ITEMS.filter((i) => wanted.includes(i.name)));
  if (wanted.includes("matrix")) await matrix(rows);
  else if (matrixParts.length) await matrix(rows, matrixParts);
  if (wanted.includes("legacy")) await p2(rows, "legacy");
  if (wanted.includes("p2")) await p2(rows, null);
  const summary = { ranAt: started, finishedAt: new Date().toISOString(), stages: wanted, rows, failed: rows.filter((r) => r.exit !== 0 || r.failed).length };
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, only ? `results-run-${wanted.join("-").slice(0, 60)}.json` : "results-run.json");
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\n=== summary");
  for (const r of rows) console.log(`${r.exit === 0 && !r.failed ? "ok  " : "FAIL"} ${r.stage}/${r.name}: ${r.passed ?? "?"} passed, ${r.failed ?? "?"} failed${r.known ? `, ${r.known} known` : ""}${r.seconds ? ` (${r.seconds} s)` : ""}`);
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
