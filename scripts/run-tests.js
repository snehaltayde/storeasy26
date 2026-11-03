// The test gate (SHOP-06): runs every `test:*` suite in package.json except the
// ones in NOT_A_GATE, one at a time, and exits non-zero if any fails. This is
// the command behind `pnpm test`, .github/workflows/test.yml and the tracked
// pre-commit hook.
//   node scripts/run-tests.js             (pnpm test)
//   node scripts/run-tests.js --verbose   stream suite output as it runs
//
// Suites are discovered, not listed, so a new test:* script joins the gate by
// existing. The per-suite time limit lives here because this Mac has no
// `timeout` command. Override it with TEST_SUITE_TIMEOUT_MS.
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_TIMEOUT_MS = Number(process.env.TEST_SUITE_TIMEOUT_MS || 2 * 60_000);

// test:perf is a measurement. It reports numbers and has nothing to fail on.
const NOT_A_GATE = new Set(["test:perf"]);
const BOUNDARY_COMMAND = "node scripts/test-shopify-boundary.js";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--verbose");
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(" ")}. The only option is --verbose.`);
  process.exit(2);
}
const verbose = args.includes("--verbose");

const { scripts } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const suites = Object.keys(scripts).filter((name) => name.startsWith("test:") && !NOT_A_GATE.has(name));

// A guard that cannot find its suites must fail, never pass by running nothing.
const problems = [];
if (!suites.includes("test:shopify-boundary")) problems.push("test:shopify-boundary is missing from package.json");
// The suite cannot report its own command being weakened (`... || true`), so this does.
else if (scripts["test:shopify-boundary"] !== BOUNDARY_COMMAND) problems.push(`test:shopify-boundary must be exactly: ${BOUNDARY_COMMAND}`);
// A suite file with no test:* script would silently never run.
const commands = Object.values(scripts).join("\n");
for (const file of await readdir(join(ROOT, "scripts"))) {
  if (/^test-.*\.js$/.test(file) && !commands.includes(`scripts/${file}`)) {
    problems.push(`scripts/${file} has no test:* script in package.json, so it would never run`);
  }
}
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}

// detached: each suite leads its own process group, so a hung suite and anything
// it started are killed together. That also takes it out of the terminal's group,
// so Ctrl-C has to be passed on by hand.
let running = null;
const killRunning = () => {
  if (!running) return;
  try {
    process.kill(-running.pid, "SIGKILL");
  } catch {
    running.kill("SIGKILL");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killRunning();
    process.exit(1);
  });
}

function runSuite(name) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["run", "--silent", name], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running = child;
    let output = "";
    const collect = (stream, sink) =>
      stream.on("data", (chunk) => {
        output += chunk;
        if (verbose) sink.write(chunk);
      });
    collect(child.stdout, process.stdout);
    collect(child.stderr, process.stderr);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killRunning();
    }, SUITE_TIMEOUT_MS);

    const finish = (code, spawnError) => {
      clearTimeout(timer);
      running = null;
      resolve({ name, ok: code === 0 && !timedOut && !spawnError, code, timedOut, spawnError, ms: Date.now() - started, output });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

console.log(`Running ${suites.length} test suites.\n`);
const started = Date.now();
const results = [];
for (const name of suites) {
  const result = await runSuite(name);
  results.push(result);
  console.log(`${result.ok ? "✓" : "✗"} ${name} (${seconds(result.ms)})`);
}

const failed = results.filter((r) => !r.ok);
for (const r of failed) {
  const why = r.timedOut
    ? `stopped after ${seconds(SUITE_TIMEOUT_MS)} without finishing`
    : r.spawnError
      ? `could not start: ${r.spawnError}`
      : `exit code ${r.code}`;
  console.error(`\n--- ${r.name} failed: ${why} ---`);
  if (!verbose) console.error(r.output.trimEnd());
}

console.log(`\n${results.length - failed.length} of ${results.length} suites passed in ${seconds(Date.now() - started)}.`);
if (failed.length) console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
