// The only way the browser drills run (Phase 0 line 6): in a throwaway git
// worktree at HEAD, with its own .next, .design-data, .design-env and
// .design-data-roles, on ports of its own. The owner's checkout, its harness
// and its data are never touched: a drill seeds and wipes only the worktree's
// own folders, and this runner fails if the owner's seed files change anyway.
//
//   node scripts/drills/run-isolated.mjs <p5|p6|smoke|agency-gone|shell|signup|sf-styles|console-styles|all> [stage,…] [--keep] [--headed]
//   (pnpm drill:p5, drill:p6, drill:smoke, drill:agency-gone, drill:shell, drill:signup, drill:sf-styles,
//   drill:console-styles, drill:all; sf-styles and console-styles are not in all)
//
//   stage,…   p5 and p6 only: run just these stages
//   --keep    leave the worktree in place (its path is printed)
//   --headed  show the browser window
//
// Steps:
//   1. refuse when the tree has tracked changes, or new files under app/,
//      components/, lib/, scripts/ or migrations/, or new code or config files
//      at the repo root such as proxy.js (drills test committed HEAD)
//   2. git worktree add --detach <tmpdir>/storeasy-drill-<stamp> HEAD, then
//      pnpm install --frozen-lockfile --prefer-offline there (no .env.local)
//   3. free ports: site from 6100, databases from 7100, the roles store next
//      to them; a busy port moves to the next block; 3017, 3018 and
//      18017–18019, 18027–18029 are never used; nothing is ever killed
//   4. each drill runs from the worktree with DRILL_ISOLATED_ROOT=<worktree>
//      (the drills refuse without it), the ports, PLATFORM_CACHE_MS=1000,
//      STOREASY_TURBOPACK_DEV_CACHE=off (no Turbopack persistent dev cache), and
//      every Shopify, payment, hosted-database and AI key blank
//   5. agency-gone, shell and console-styles first seed and start the
//      worktree's own roles store (withRolesStore); shell adds the Roles Annex
//   6. the worktree's committed docs/cms-reviews/drills/<ID>/ is emptied before
//      each drill, so results are this run's only; they and each
//      drill's output are copied to .drill-results/<stamp>/ here (gitignored),
//      with summary.json
//   7. the worktree is removed (git worktree remove --force, prune) unless --keep;
//      on Ctrl-C or SIGTERM the runner stops its own children first, then removes it
//   5c. before each drill, and after one that fails, a warm-up boot checks the
//      build (warmBuild): a next/font/google build error means .next is deleted
//      and the boot repeated (up to 2 times), else the run stops with
//      "Google Fonts could not be fetched; check the network"; a drill that
//      failed on such a build is run once more
//   8. the owner's .design-env, .design-data/seeded.json, p*-seed.json and
//      roles-seed.json are hashed before and after: any change fails the run
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLANKED_ENV, ROOT, isPortBusy, runningHarness } from "../design-harness.js";

export const OWNER_PORTS = Object.freeze([3017, 3018, 18017, 18018, 18019, 18027, 18028, 18029]);
const HANDS_OFF = new Set(["docs/CMS_CLAUDE_DIRECTION_BRIEF.md", "docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md", "docs/CMS_SESSION_HANDOFF.md"]);
const CODE_DIRS = ["app/", "components/", "lib/", "scripts/", "migrations/"];
// a new file at the root that the build or the drills would load (proxy.js, next.config.ts, tsconfig.json …)
const ROOT_CODE = /^[^/]+\.(?:[cm]?[jt]sx?|json)$/;
const DRILL_TIMEOUT_MS = 90 * 60_000;

export class RunnerError extends Error {}

// 1. `git status --porcelain` output → throws when HEAD is not what would run.
export function assertCleanTree(porcelain) {
  const bad = [];
  for (const line of String(porcelain).split("\n").filter(Boolean)) {
    const path = line.slice(3).replace(/^"|"$/g, "");
    if (HANDS_OFF.has(path)) continue;
    if (line.startsWith("??")) {
      if (CODE_DIRS.some((d) => path.startsWith(d)) || ROOT_CODE.test(path)) bad.push(`new ${path}`);
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

// 6. Before a drill: empty the worktree's results folder for <id> (it holds
// committed historical results). Never the checkout itself.
export function clearResults(worktree, root, id) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (real(worktree) === real(root)) throw new RunnerError(`clearResults empties a drill worktree's results, never this checkout (${root}).`);
  rmSync(join(worktree, "docs", "cms-reviews", "drills", id), { recursive: true, force: true });
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
    // next.config.mjs: no Turbopack persistent dev cache in a drill worktree.
    // Restored across the many harness restarts of a run, it sometimes came
    // back without most routes (the "/admin/login 404" flake).
    STOREASY_TURBOPACK_DEV_CACHE: "off",
  };
}

// The children this process started and that have not exited yet: the only
// processes a Ctrl-C or SIGTERM ever stops.
const LIVE = new Set();
function track(child) {
  LIVE.add(child);
  child.once("exit", () => LIVE.delete(child));
  child.once("error", () => LIVE.delete(child));
  return child;
}

// Runs one child to the end, its output appended to a log. → exit code.
function runChild(cmd, args, { cwd, env, log, timeoutMs = DRILL_TIMEOUT_MS, echo = true }) {
  return new Promise((resolve) => {
    const child = track(spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
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
  const child = track(spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
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

// Before each drill (and after one that failed): a warm-up boot of the
// worktree's design harness that loads / and /admin/login. Turbopack keeps its
// dev build in .next/cache across restarts, and a next/font/google failure
// there ("Can't resolve '@vercel/turbopack-next/internal/font/google/font'")
// turns every later page into a 500 for every harness started from that .next.
// When the warm-up sees it, it stops its own harness, deletes the worktree's
// .next and boots again, up to 2 times; then the run fails plainly. A drill
// never runs silently against that broken build.
export const FONT_BUILD_ERROR = "turbopack-next/internal/font/google";
export const FONT_FAIL = "Google Fonts could not be fetched; check the network";
const WARM_PATHS = ["/", "/admin/login"];

// start() → { probe() → [{ path, status, body }], output() → string, stop() };
// clean() deletes .next; gone() → { ok, why }. → { attempts } or throws RunnerError.
export async function warmBuild({ start, clean, gone, attempts = 3, say = () => {} }) {
  for (let i = 1; i <= attempts; i++) {
    const h = await start();
    let bad = [];
    try {
      const pages = await h.probe();
      bad = pages.filter((p) => p.body.includes(FONT_BUILD_ERROR)).map((p) => `${p.path} ${p.status}`);
      if (!bad.length && h.output().includes(FONT_BUILD_ERROR)) bad = ["the harness output"];
    } finally {
      await h.stop();
    }
    const g = await gone();
    if (!g.ok) throw new RunnerError(`After the warm-up harness: ${g.why}. Nothing was stopped.`);
    if (!bad.length) return { attempts: i };
    say(`✗ warm-up ${i}/${attempts}: the build failed on next/font/google (${bad.join(", ")})${i < attempts ? "; deleting the worktree's .next and starting again" : ""}`);
    if (i < attempts) clean();
  }
  throw new RunnerError(`${FONT_FAIL}. The storefront build failed on next/font/google (${FONT_BUILD_ERROR}) in ${attempts} warm-up boots, each after deleting the worktree's .next; no drill ran against that build.`);
}

// The real warm-up harness: this worktree's dev-design.js on this run's ports, own handle only.
function warmHarness(c) {
  return async () => {
    const log = [];
    const server = startChild(node, ["scripts/dev-design.js"], { cwd: c.worktree, env: c.env, log });
    const base = `http://localhost:${c.ports.next}`;
    if (!(await waitUp(`${base}/api/health`, server.child, 300_000))) {
      await server.stop();
      throw new RunnerError(`The warm-up harness did not come up at ${base}: ${log.join("").trim().split("\n").slice(-6).join(" | ")}`);
    }
    return {
      output: () => log.join(""),
      stop: server.stop,
      probe: async () => {
        const out = [];
        for (const path of WARM_PATHS) {
          try {
            const r = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(240_000) });
            out.push({ path, status: r.status, body: await r.text() });
          } catch (e) {
            out.push({ path, status: 0, body: String(e?.message || e) });
          }
        }
        return out;
      },
    };
  };
}

const realWarm = (c, say) =>
  warmBuild({ start: warmHarness(c), clean: () => rmSync(join(c.worktree, ".next"), { recursive: true, force: true }), gone: () => waitHarnessGone({ worktree: c.worktree, ports: c.ports }), say });

const node = process.execPath;

// Seeds this worktree's roles store fresh (dev-roles.js seed --reset: only the
// worktree's own .design-data-roles, so a drill run a second time after a
// broken build starts clean too), starts it, runs fn() while it answers, then
// stops it (its own handle only). → fn's exit code.
export async function withRolesStore(c, fn, { start = startChild, up = waitUp } = {}) {
  const seeded = await c.node(["scripts/dev-roles.js", "seed", "--reset"]);
  if (seeded !== 0) return seeded;
  const server = start(node, ["scripts/dev-roles.js"], { cwd: c.worktree, env: c.env, log: c.log });
  try {
    if (!(await up(`http://roles.localhost:${c.ports.rolesNext}/api/health`, server.child))) {
      c.log.push("✗ the roles store did not come up\n");
      return 1;
    }
    return await fn();
  } finally {
    await server.stop();
  }
}

// name → { id (results folder or null), warm (boot-check the build first), run(ctx) → exit code }
export const DRILLS = {
  // the --p3 documents store first (it has a live release), as p5's lib seeds it
  smoke: {
    id: "smoke",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drill.js", "smoke", "--start", ...c.headed]);
    },
  },
  p5: { id: "P5-DRILLS", warm: true, run: (c) => c.node(["scripts/drills/p5/run.mjs", ...c.stages, ...c.headed]) },
  p6: { id: "P6-DRILLS", warm: true, run: (c) => c.node(["scripts/drills/p6/run.mjs", ...c.stages, ...c.headed]) },
  // the storefront render comparison (Phase 0 line 7); SF_STYLES_BASELINE and
  // SF_STYLES_BITE pass through the env. A tool, not part of drill:all.
  "sf-styles": { id: "SF-STYLES", warm: true, run: (c) => c.node(["scripts/drills/sf-styles/run.mjs", ...c.headed]) },
  "agency-gone": { id: null, warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/agency-gone.mjs"])) },
  // the old console screens inside the new shell (Phase 0 line 8 §3), on the
  // roles store; SF_STYLES_BASELINE and SF_STYLES_BITE pass through. A tool, not in drill:all.
  "console-styles": { id: "CONSOLE-STYLES", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/sf-styles/run.mjs", ...c.headed], { env: { ...c.env, SF_STYLES_SET: "console" } })) },
  // the new console shell (Phase 0 line 8 §5): the roles store plus the Roles Annex
  shell: {
    id: "SHELL",
    warm: true,
    run: (c) =>
      withRolesStore(c, async () => {
        const annex = await c.node(["scripts/dev-roles.js", "annex"]);
        return annex !== 0 ? annex : c.node(["scripts/drills/shell/run.mjs", ...c.headed]);
      }),
  },
  // self-serve signup (Phase 1 line 1 §5): the --p3 design store (the harness
  // the drill starts), then signup on storeasy.localhost into a new store
  signup: {
    id: "SIGNUP",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/signup/run.mjs", ...c.headed]);
    },
  },
};
export const ALL = ["smoke", "p5", "p6", "agency-gone", "shell", "signup"];

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

export async function runIsolated({ root = ROOT, names, stages = [], keep = false, headed = false, drills = DRILLS, install = ["pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]], ports = null, base = tmpdir(), say = console.log, gone = waitHarnessGone, warm = realWarm } = {}) {
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
  const removeWorktree = () => {
    git(root, ["worktree", "remove", "--force", path]);
    git(root, ["worktree", "prune"]);
  };
  // Ctrl-C / SIGTERM: stop this run's own children (SIGTERM, then SIGKILL after
  // 15 s), remove its own worktree unless --keep, and exit. Nothing else is touched.
  let stopping = false;
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    say(`\n✗ ${signal}: stopping this run's ${LIVE.size} child process(es)${keep ? "" : " and removing its worktree"}`);
    const children = [...LIVE];
    for (const c of children) c.kill("SIGTERM");
    const end = Date.now() + 15_000;
    while (children.some((c) => c.exitCode === null && !c.signalCode) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    for (const c of children) if (c.exitCode === null && !c.signalCode) c.kill("SIGKILL");
    if (!keep) removeWorktree();
    else say(`• kept the worktree: ${worktree}`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const signals = ["SIGINT", "SIGTERM"];
  for (const sig of signals) process.on(sig, onSignal);
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
      let fontFail = false;
      try {
        if (spec.id) clearResults(worktree, root, spec.id);
        if (spec.warm) await warm(ctx, say);
        exit = await spec.run(ctx);
        // a failed drill: was the build broken under it? Then once more on a fresh .next.
        if (exit !== 0 && spec.warm && (await warm(ctx, say)).attempts > 1) {
          const again = `• ${name} failed on a broken next/font/google build; .next was rebuilt, running it once more\n`;
          log.push(again);
          say(again.trim());
          if (spec.id) clearResults(worktree, root, spec.id);
          exit = await spec.run(ctx);
        }
      } catch (e) {
        fontFail = e instanceof RunnerError && e.message.startsWith(FONT_FAIL);
        log.push(`✗ ${e instanceof RunnerError ? e.message : e.stack || e}\n`);
        if (e instanceof RunnerError) say(`✗ ${e.message}`);
        exit = 1;
      }
      writeFileSync(join(resultsDir, `${name}.log`), log.join(""));
      const copied = spec.id ? copyResults(worktree, root, stamp, spec.id) : null;
      rows.push({ drill: name, exit, seconds: Math.round((Date.now() - t0) / 1000), results: copied, log: join(resultsDir, `${name}.log`) });
      say(`--- ${name}: ${exit === 0 ? "passed" : `FAILED (exit ${exit})`} in ${Math.round((Date.now() - t0) / 1000)} s`);
      if (fontFail) {
        say("✗ the remaining drills are not run.");
        break;
      }
      const g = await gone({ worktree, ports: chosen });
      if (!g.ok) {
        rows.push({ drill: `${name} (cleanup)`, exit: 1, seconds: 0, results: null, log: null, why: g.why });
        say(`✗ after ${name}: ${g.why}. Nothing was stopped; the remaining drills are not run.`);
        break;
      }
    }
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
    if (!keep) removeWorktree();
    else say(`• kept the worktree: ${worktree}`);
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
  const names = name === "all" ? ALL : Object.hasOwn(DRILLS, name ?? "") ? [name] : null;
  if (!names || unknown.length || (rest.length && !["p5", "p6"].includes(name)) || rest.length > 1) {
    console.error(`Use: node scripts/drills/run-isolated.mjs <${[...Object.keys(DRILLS), "all"].join("|")}> [stage,…] (p5, p6) [--keep] [--headed]`);
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
