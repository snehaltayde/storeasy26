// The only way the browser drills run (Phase 0 line 6): in a throwaway git
// worktree at HEAD, with its own .next, .design-data, .design-env and
// .design-data-roles, on ports of its own. The owner's checkout, its harness
// and its data are never touched: a drill seeds and wipes only the worktree's
// own folders, and this runner fails if the owner's seed files change anyway.
//
//   node scripts/drills/run-isolated.mjs <p5|p6|smoke|agency-gone|all> [stage,…] [--keep] [--headed]
//   (pnpm drill:p5, drill:p6, drill:smoke, drill:agency-gone, drill:all)
//
//   stage,…   p5 and p6 only: run just these stages
//   --keep    leave the worktree in place (its path is printed)
//   --headed  show the browser window
//
// Steps:
//   1. refuse when the tree has tracked changes, or new files under app/,
//      components/, lib/, scripts/ or migrations/ (drills test committed HEAD)
//   2. git worktree add --detach <tmpdir>/storeasy-drill-<stamp> HEAD, then
//      pnpm install --frozen-lockfile --prefer-offline there (no .env.local)
//   3. free ports: site from 6100, databases from 7100, the roles store next
//      to them; a busy port moves to the next block; 3017, 3018 and
//      18017–18019, 18027–18029 are never used; nothing is ever killed
//   4. each drill runs from the worktree with DRILL_ISOLATED_ROOT=<worktree>
//      (the drills refuse without it), the ports, PLATFORM_CACHE_MS=1000, and
//      every Shopify, payment, hosted-database and AI key blank
//   5. agency-gone first seeds and starts the worktree's own roles store
//   6. results (docs/cms-reviews/drills/<ID>/ in the worktree) and each
//      drill's output are copied to .drill-results/<stamp>/ here (gitignored),
//      with summary.json
//   7. the worktree is removed (git worktree remove --force, prune) unless --keep
//   8. the owner's .design-env, .design-data/seeded.json, p*-seed.json and
//      roles-seed.json are hashed before and after: any change fails the run
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLANKED_ENV, ROOT, isPortBusy, runningHarness } from "../design-harness.js";

export const OWNER_PORTS = Object.freeze([3017, 3018, 18017, 18018, 18019, 18027, 18028, 18029]);
const HANDS_OFF = new Set(["docs/CMS_CLAUDE_DIRECTION_BRIEF.md", "docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md", "docs/CMS_SESSION_HANDOFF.md"]);
const CODE_DIRS = ["app/", "components/", "lib/", "scripts/", "migrations/"];
const DRILL_TIMEOUT_MS = 90 * 60_000;

export class RunnerError extends Error {}

// 1. `git status --porcelain` output → throws when HEAD is not what would run.
export function assertCleanTree(porcelain) {
  const bad = [];
  for (const line of String(porcelain).split("\n").filter(Boolean)) {
    const path = line.slice(3).replace(/^"|"$/g, "");
    if (HANDS_OFF.has(path)) continue;
    if (line.startsWith("??")) {
      if (CODE_DIRS.some((d) => path.startsWith(d))) bad.push(`new ${path}`);
    } else bad.push(`changed ${path}`);
  }
  if (bad.length) throw new RunnerError(`Drills test committed code only: commit or stash first (${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", …" : ""}).`);
}

// 2. The throwaway worktree's path: under the system temp folder, never in the repo.
export const worktreePath = (stamp, base = tmpdir()) => join(base, `storeasy-drill-${stamp}`);

// 3. One block of ports: the design harness (site + three databases) and the
// roles store (site + three databases). A block with any busy or owner port
// is skipped, never freed.
export async function choosePorts({ isBusy = isPortBusy, site = 6100, db = 7100, step = 10, tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const p = { next: site + i * step, sqld: db + i * step, rolesNext: site + i * step + 1, rolesSqld: db + i * step + 3 };
    const all = [p.next, p.sqld, p.sqld + 1, p.sqld + 2, p.rolesNext, p.rolesSqld, p.rolesSqld + 1, p.rolesSqld + 2];
    if (all.some((n) => OWNER_PORTS.includes(n))) continue;
    let busy = false;
    for (const n of all) if ((await isBusy(n, "127.0.0.1")) || (await isBusy(n, "::1"))) busy = true;
    if (!busy) return p;
  }
  throw new RunnerError(`No free block of ports from ${site} and ${db} (${tries} tried). Nothing was stopped; free some ports and run again.`);
}

// 8. The owner's seed files, hashed: { path: sha256 | null }.
export function ownerDataFingerprint(root) {
  const files = [".design-env", ".design-data/seeded.json", ".design-data-roles/roles-seed.json"];
  const data = join(root, ".design-data");
  if (existsSync(data)) for (const f of readdirSync(data)) if (/^p\d+-seed\.json$/.test(f)) files.push(`.design-data/${f}`);
  const out = {};
  for (const f of files.sort()) {
    try {
      out[f] = createHash("sha256").update(readFileSync(join(root, f))).digest("hex");
    } catch {
      out[f] = null;
    }
  }
  return out;
}

// 6. <worktree>/docs/cms-reviews/drills/<id>/ → <root>/.drill-results/<stamp>/<id>/
export function copyResults(worktree, root, stamp, id) {
  const from = join(worktree, "docs", "cms-reviews", "drills", id);
  const dir = join(root, ".drill-results", stamp);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(from)) return null;
  cpSync(from, join(dir, id), { recursive: true });
  return join(dir, id);
}

// Before the next drill: the last one's harnesses (design and roles) have
// fully exited: no pid file names a live launcher and every port of this run
// is free. → { ok: true } or { ok: false, why } after timeoutMs. Never kills.
export const portsOf = (p) => [p.next, p.sqld, p.sqld + 1, p.sqld + 2, p.rolesNext, p.rolesSqld, p.rolesSqld + 1, p.rolesSqld + 2];
export async function waitHarnessGone({ worktree, ports, isBusy = isPortBusy, running = runningHarness, timeoutMs = 60_000, stepMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  let why = "";
  for (;;) {
    const live = [".design-data", ".design-data-roles"].map((d) => [d, running(join(worktree, d))]).filter(([, info]) => info);
    const busy = [];
    for (const n of portsOf(ports)) if ((await isBusy(n, "127.0.0.1")) || (await isBusy(n, "::1"))) busy.push(n);
    if (!live.length && !busy.length) return { ok: true };
    why = [...live.map(([d, info]) => `a harness in ${d} (pid ${info.launcher?.pid}) is still running`), ...(busy.length ? [`ports ${busy.join(", ")} still answer`] : [])].join("; ");
    if (Date.now() >= end) return { ok: false, why };
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// The env every drill child gets.
export function drillEnv(base, worktree, ports) {
  const env = { ...base };
  for (const k of [...BLANKED_ENV, "ANTHROPIC_API_KEY"]) env[k] = "";
  return {
    ...env,
    DRILL_ISOLATED_ROOT: worktree,
    DESIGN_PORT: String(ports.next),
    DESIGN_SQLD_PORT: String(ports.sqld),
    ROLES_PORT: String(ports.rolesNext),
    ROLES_SQLD_PORT: String(ports.rolesSqld),
    PLATFORM_CACHE_MS: "1000",
  };
}

// Runs one child to the end, its output appended to a log. → exit code.
function runChild(cmd, args, { cwd, env, log, timeoutMs = DRILL_TIMEOUT_MS, echo = true }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = (c) => {
      log.push(String(c));
      if (echo) process.stdout.write(c);
    };
    child.stdout.on("data", out);
    child.stderr.on("data", out);
    const t = setTimeout(() => {
      out(`\n✗ timed out after ${Math.round(timeoutMs / 60_000)} min\n`);
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      out(`✗ ${e.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

// A server child (the roles store) until stop(); only this handle is ever stopped.
function startChild(cmd, args, { cwd, env, log }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => log.push(String(c)));
  child.stderr.on("data", (c) => log.push(String(c)));
  return {
    child,
    stop: () =>
      new Promise((done) => {
        if (child.exitCode !== null || child.signalCode) return done();
        const t = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.once("exit", () => {
          clearTimeout(t);
          done();
        });
        child.kill("SIGTERM");
      }),
  };
}

async function waitUp(url, child, ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try {
      await fetch(url, { redirect: "manual" });
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const node = process.execPath;
// name → { id (results folder or null), run(ctx) → exit code }
export const DRILLS = {
  // the --p3 documents store first (it has a live release), as p5's lib seeds it
  smoke: {
    id: "smoke",
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drill.js", "smoke", "--start", ...c.headed]);
    },
  },
  p5: { id: "P5-DRILLS", run: (c) => c.node(["scripts/drills/p5/run.mjs", ...c.stages, ...c.headed]) },
  p6: { id: "P6-DRILLS", run: (c) => c.node(["scripts/drills/p6/run.mjs", ...c.stages, ...c.headed]) },
  "agency-gone": {
    id: null,
    async run(c) {
      const seeded = await c.node(["scripts/dev-roles.js", "seed"]);
      if (seeded !== 0) return seeded;
      const server = startChild(node, ["scripts/dev-roles.js"], { cwd: c.worktree, env: c.env, log: c.log });
      try {
        if (!(await waitUp(`http://roles.localhost:${c.ports.rolesNext}/api/health`, server.child))) {
          c.log.push("✗ the roles store did not come up\n");
          return 1;
        }
        return await c.node(["scripts/drills/agency-gone.mjs"]);
      } finally {
        await server.stop();
      }
    },
  },
};
export const ALL = ["smoke", "p5", "p6", "agency-gone"];

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

export async function runIsolated({ root = ROOT, names, stages = [], keep = false, headed = false, drills = DRILLS, install = ["pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]], ports = null, base = tmpdir(), say = console.log, gone = waitHarnessGone } = {}) {
  const status = git(root, ["status", "--porcelain"]);
  if (status.status !== 0) throw new RunnerError(`git status failed: ${status.stderr.trim()}`);
  assertCleanTree(status.stdout);
  const before = ownerDataFingerprint(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const chosen = ports || (await choosePorts());
  const path = worktreePath(stamp, base);
  const add = git(root, ["worktree", "add", "--detach", path, "HEAD"]);
  if (add.status !== 0) throw new RunnerError(`git worktree add failed: ${add.stderr.trim()}`);
  const worktree = realpathSync(path);
  const resultsDir = join(root, ".drill-results", stamp);
  mkdirSync(resultsDir, { recursive: true });
  const env = drillEnv(process.env, worktree, chosen);
  const head = git(root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  say(`• drills ${names.join(", ")} at ${head} in ${worktree} (site ${chosen.next}, databases ${chosen.sqld}–${chosen.sqld + 2}, roles ${chosen.rolesNext}/${chosen.rolesSqld})`);
  const rows = [];
  try {
    if (install) {
      const log = [];
      const code = await runChild(install[0], install[1], { cwd: worktree, env: { ...process.env, ...env }, log, echo: false, timeoutMs: 15 * 60_000 });
      writeFileSync(join(resultsDir, "install.log"), log.join(""));
      if (code !== 0) throw new RunnerError(`pnpm install failed in the worktree (exit ${code}); see ${join(resultsDir, "install.log")}`);
    }
    for (const name of names) {
      const spec = drills[name];
      const log = [];
      const t0 = Date.now();
      say(`\n=== ${name}`);
      const ctx = {
        worktree,
        env,
        ports: chosen,
        log,
        stages: stages.length ? [stages.join(",")] : [],
        headed: headed ? ["--headed"] : [],
        node: (args, opts = {}) => runChild(node, args, { cwd: worktree, env, log, ...opts }),
      };
      let exit;
      try {
        exit = await spec.run(ctx);
      } catch (e) {
        log.push(`✗ ${e.stack || e}\n`);
        exit = 1;
      }
      writeFileSync(join(resultsDir, `${name}.log`), log.join(""));
      const copied = spec.id ? copyResults(worktree, root, stamp, spec.id) : null;
      rows.push({ drill: name, exit, seconds: Math.round((Date.now() - t0) / 1000), results: copied, log: join(resultsDir, `${name}.log`) });
      say(`--- ${name}: ${exit === 0 ? "passed" : `FAILED (exit ${exit})`} in ${Math.round((Date.now() - t0) / 1000)} s`);
      const g = await gone({ worktree, ports: chosen });
      if (!g.ok) {
        rows.push({ drill: `${name} (cleanup)`, exit: 1, seconds: 0, results: null, log: null, why: g.why });
        say(`✗ after ${name}: ${g.why}. Nothing was stopped; the remaining drills are not run.`);
        break;
      }
    }
  } finally {
    if (!keep) {
      git(root, ["worktree", "remove", "--force", path]);
      git(root, ["worktree", "prune"]);
    } else say(`• kept the worktree: ${worktree}`);
    const after = ownerDataFingerprint(root);
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    const summary = { ranAt: stamp, head, worktree, kept: keep, ports: chosen, rows, ownerData: { before, after, changed }, failed: rows.filter((r) => r.exit !== 0).length + (changed.length ? 1 : 0) };
    writeFileSync(join(resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    if (changed.length) say(`✗ the owner's data changed during the run: ${changed.join(", ")}`);
    say(`\n${rows.map((r) => `${r.exit === 0 ? "ok  " : "FAIL"} ${r.drill} (${r.seconds} s)`).join("\n")}\nResults: ${resultsDir}`);
    runIsolated.last = summary;
  }
  return runIsolated.last;
}

async function main(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const [name, ...rest] = argv.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => !["--keep", "--headed"].includes(f));
  const names = name === "all" ? ALL : DRILLS[name] ? [name] : null;
  if (!names || unknown.length || (rest.length && !["p5", "p6"].includes(name)) || rest.length > 1) {
    console.error(`Use: node scripts/drills/run-isolated.mjs <${[...ALL, "all"].join("|")}> [stage,…] (p5, p6) [--keep] [--headed]`);
    return 2;
  }
  const summary = await runIsolated({ names, stages: rest, keep: flags.includes("--keep"), headed: flags.includes("--headed") });
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✗ ${e instanceof RunnerError ? e.message : e.stack || e}`);
      process.exit(1);
    },
  );
}
