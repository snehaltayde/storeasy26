// The only way the browser drills run (Phase 0 line 6): in a throwaway git
// worktree at HEAD, with its own .next, .design-data, .design-env and
// .design-data-roles, on ports of its own. The owner's checkout, its harness
// and its data are never touched: a drill seeds and wipes only the worktree's
// own folders, and this runner fails if the owner's seed files change anyway.
//
//   node scripts/drills/run-isolated.mjs <p5|p6|orders|smoke|agency-gone|shell|flags-incidents|editor|signup|connect|operator-onboarding|operator-create-store|platform-shell|store-lifecycle|sf-styles|console-styles|all> [stage,…] [--keep] [--headed]
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
//   5c. before each drill, a warm-up boot loads / and /admin/login (compiling
//      them) and stops (warmUp)
//   6b. each drill's harnesses (design and roles) write their Next output and
//      sqld logs to <worktree>/.drill-logs/<drill>/ (DRILL_LOG_DIR); after the
//      drill, and before the worktree goes (Ctrl-C too), they are joined into
//      .drill-results/<stamp>/<drill>/server.log; a failed drill prints its tail
//   2b. pnpm install runs under a machine-wide lock (<tmpdir>/storeasy-drill-install.lock),
//      so two runners never install into worktrees from the shared pnpm store at once
//   8. the owner's .design-env, .design-data/seeded.json, p*-seed.json and
//      roles-seed.json are hashed before and after: any change fails the run
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLANKED_ENV, HarnessError, ROOT, bootBuilt, isPortBusy, runningHarness } from "../design-harness.js";

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
// Each heavy slot (~/.claude/bin/heavy exports HEAVY_SLOT=1..3) gets its own port
// region, so drills running at the same time in different slots can never pick the
// same block (choosing a free block is check-then-use, so two runners checking at
// once would otherwise race). Inside a block the design harness owns sqld..sqld+59
// (databases, the Turso stand-in at +3, new stores from +10) and the roles harness
// owns rolesSqld..rolesSqld+59, 100 apart, so the two never overlap either.
export function slotIndex(env = process.env) {
  const n = Number(env.HEAVY_SLOT);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 0;
}
export async function choosePorts({ isBusy = isPortBusy, slot = slotIndex(), site = 6100 + slot * 100, db = 20000 + slot * 2000, step = 10, dbStep = 200, tries = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    const p = { next: site + i * step, sqld: db + i * dbStep, rolesNext: site + i * step + 1, rolesSqld: db + i * dbStep + 100 };
    const all = portsOf(p);
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

// 6b. The server logs of one drill: every file in logDir (sqld first, Next
// last, so the tail printed on a failure is Next's) plus the Turso stand-in's store databases under .design-data*/fake-turso/,
// joined into outFile. → outFile, or null when there was nothing to keep.
export function keepServerLog(logDir, outFile, worktree) {
  const files = [];
  if (existsSync(logDir)) for (const f of readdirSync(logDir).sort((a, b) => Number(a.endsWith("-next.log")) - Number(b.endsWith("-next.log")) || a.localeCompare(b))) files.push(join(logDir, f));
  if (worktree)
    for (const d of [".design-data", ".design-data-roles"]) {
      const fake = join(worktree, d, "fake-turso");
      if (existsSync(fake)) for (const f of readdirSync(fake).sort()) if (f.endsWith(".log")) files.push(join(fake, f));
    }
  if (!files.length) return null;
  mkdirSync(join(outFile, ".."), { recursive: true });
  writeFileSync(outFile, files.map((f) => `##### ${basename(f)}\n${readFileSync(f, "utf8")}`).join("\n"));
  return outFile;
}
export const tailLines = (text, n = 40) => String(text).trimEnd().split("\n").slice(-n).join("\n");

// 2b. One pnpm install at a time on this machine: the lock is a directory
// (mkdir is atomic) holding the owner's pid. A lock whose pid is gone is
// stale and taken over; a live one is waited for. Never kills anything.
export const INSTALL_LOCK = join(tmpdir(), "storeasy-drill-install.lock");
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
export async function withInstallLock(fn, { dir = INSTALL_LOCK, timeoutMs = 30 * 60_000, stepMs = 1000, alive = pidAlive, say = () => {} } = {}) {
  const end = Date.now() + timeoutMs;
  let told = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = NaN;
      try {
        pid = Number(readFileSync(join(dir, "pid"), "utf8"));
      } catch {}
      // no pid yet: the owner is between mkdir and writing it; a dead pid: stale
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= end) throw new RunnerError(`Another drill run's pnpm install (pid ${pid || "?"}) held ${dir} for ${Math.round(timeoutMs / 60_000)} min. Nothing was stopped.`);
      if (!told) say(`• waiting for another drill run's pnpm install (pid ${pid || "?"}) to finish`);
      told = true;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Before the next drill: the last one's harnesses (design and roles) have
// fully exited: no pid file names a live launcher and every port of this run
// is free. → { ok: true } or { ok: false, why } after timeoutMs. Never kills.
export const portsOf = (p) => [p.next, p.sqld, p.sqld + 1, p.sqld + 2, p.sqld + 3, p.sqld + 10, p.rolesNext, p.rolesSqld, p.rolesSqld + 1, p.rolesSqld + 2, p.rolesSqld + 3, p.rolesSqld + 10];
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

// Before each drill: a warm-up boot of the worktree's design harness that
// loads / and /admin/login, so Turbopack has compiled them before a drill's
// browser waits on them. (It used to retry on a next/font/google build
// failure; the fonts are self-hosted now, see app/fonts/fonts.js.)
const WARM_PATHS = ["/", "/admin/login"];

// start() → { probe() → [{ path, status, body }], output() → string, stop() };
// gone() → { ok, why }. A page answering 500 or more, or not at all (status
// 0), is said (the drill still runs and sees it). Its own harness is stopped
// even when probe() throws; one that does not go is reported, never killed.
export async function warmUp({ start, gone, say = () => {} }) {
  const h = await start();
  try {
    const bad = (await h.probe()).filter((p) => p.status === 0 || p.status >= 500);
    if (bad.length) say(`! warm-up: ${bad.map((p) => `${p.path} ${p.status || "no answer"}`).join(", ")}`);
  } finally {
    await h.stop();
  }
  const g = await gone();
  if (!g.ok) throw new RunnerError(`After the warm-up harness: ${g.why}. Nothing was stopped.`);
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

const realWarm = (c, say) => warmUp({ start: warmHarness(c), gone: () => waitHarnessGone({ worktree: c.worktree, ports: c.ports }), say });

const node = process.execPath;

// Seeds this worktree's roles store fresh (dev-roles.js seed --reset: only the
// worktree's own .design-data-roles), starts it, runs fn() while it answers, then
// stops it (its own handle only). → fn's exit code.
export async function withRolesStore(c, fn, { start = startChild, up = waitUp, built = bootBuilt } = {}) {
  const seeded = await c.node(["scripts/dev-roles.js", "seed", "--reset"]);
  if (seeded !== 0) return seeded;
  const base = `http://roles.localhost:${c.ports.rolesNext}`;
  // its own output (also kept in the drill's log); /admin/login is loaded
  // (compiled) before the drill runs (bootBuilt)
  const boot = async () => {
    const own = [];
    const log = { push: (x) => (own.push(x), c.log.push(x)) };
    const server = start(node, ["scripts/dev-roles.js"], { cwd: c.worktree, env: c.env, log });
    if (!(await up(`${base}/api/health`, server.child))) {
      await server.stop();
      throw new HarnessError("the roles store did not come up");
    }
    return { output: () => own.join(""), stop: server.stop };
  };
  let server;
  try {
    server = await built({ boot, baseUrl: base, paths: ["/admin/login"] });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    c.log.push(`✗ ${e.message}\n`);
    return 1;
  }
  try {
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
  // the dashboard on the new UI (Phase 2 line 1 §5 item 6), on the roles store
  dashboard: { id: "DASHBOARD", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/dashboard/run.mjs", ...c.headed])) },
  p5: { id: "P5-DRILLS", warm: true, run: (c) => c.node(["scripts/drills/p5/run.mjs", ...c.stages, ...c.headed]) },
  // the orders console on the new UI (Phase 2 line 2): the roles store and its seeded order
  orders: { id: "ORDERS", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/orders/run.mjs", ...c.headed])) },
  p6: { id: "P6-DRILLS", warm: true, run: (c) => c.node(["scripts/drills/p6/run.mjs", ...c.stages, ...c.headed]) },
  // the Catalog page on the new UI (Phase 2 line 3), on the roles store
  catalog: { id: "CATALOG", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/catalog/run.mjs", ...c.headed])) },
  // the storefront render comparison (Phase 0 line 7); SF_STYLES_BASELINE and
  // SF_STYLES_BITE pass through the env. A tool, not part of drill:all.
  "sf-styles": { id: "SF-STYLES", warm: true, run: (c) => c.node(["scripts/drills/sf-styles/run.mjs", ...c.headed]) },
  // offers and bundles on the new console UI (Phase 2 line 4 §5 item 7), on the roles store
  offers: { id: "OFFERS", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/offers/run.mjs", ...c.headed])) },
  "agency-gone": { id: null, warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/agency-gone.mjs"])) },
  // Phase 2 line 5: the media screen on the roles store (staff, support); evidence in docs/cms-reviews/drills/MEDIA/
  media: { id: "MEDIA", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/media/run.mjs", ...c.headed])) },
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
  // Phase 3 line 4: feature flags and incidents on the operator console; the
  // incident banner is checked on the roles store's own console
  "flags-incidents": { id: "FLAGS-INCIDENTS", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/flags-incidents/run.mjs", ...c.headed])) },
  // Phase 2 line 6: the editor in the new shell, on the roles store (owner,
  // staff, support; 375, 768, 1280); evidence in docs/cms-reviews/drills/EDITOR/
  editor: { id: "EDITOR", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/editor/run.mjs", ...c.headed])) },
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
  // Phase 3 line 3: the operator's Billing screen (tabs, plans, subscriptions,
  // costs), on the --p3 design store like platform-shell
  "platform-billing": {
    id: "PLATFORM-BILLING",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/platform-billing/run.mjs", ...c.headed]);
    },
  },
  // settings, integrations and billing (Phase 2 line 7): the roles store; the
  // drill opens an operator's support grant in its control plane for the banner check
  settings: { id: "SETTINGS", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/settings/run.mjs", ...c.headed])) },
  // a founder connects Shopify from onboarding step 1 (Phase 1 line 4 §5 item 14):
  // the roles store plus the Roles Annex; the drill starts the Shopify stand-in
  // on SHOPIFY_FAKE_PORT (a free slot in this run's block), and the harness gets
  // SHOPIFY_API_ORIGIN for it, set here after drillEnv's blanking
  connect: {
    id: "P1-CONNECT",
    warm: true,
    run: (c) => {
      const fakePort = c.ports.rolesSqld + 5;
      const env = { ...c.env, SHOPIFY_API_ORIGIN: `http://127.0.0.1:${fakePort}`, SHOPIFY_FAKE_PORT: String(fakePort) };
      const cc = { ...c, env, node: (args, opts = {}) => c.node(args, { env, ...opts }) };
      return withRolesStore(cc, async () => {
        const annex = await cc.node(["scripts/dev-roles.js", "annex"]);
        return annex !== 0 ? annex : cc.node(["scripts/drills/connect/run.mjs", ...c.headed]);
      });
    },
  },
  // Phase 3 line 2: suspend -> storefront closed -> resume, and maintenance, from the store page, on the --p3 design store
  "store-lifecycle": {
    id: "STORE-LIFECYCLE",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/store-lifecycle/run.mjs", ...c.headed]);
    },
  },
  // Phase 2 line 8: the team screen on the roles store (invite, accept, roles, transfer); evidence in docs/cms-reviews/drills/TEAM/
  team: { id: "TEAM", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/team/run.mjs", ...c.headed])) },
  // Phase 3 line 6: the operator's Operations page (queues, provisioning runs, privacy requests, themes, case studies), on the --p3 design store
  "platform-ops": {
    id: "PLATFORM-OPS",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/platform-ops/run.mjs", ...c.headed]);
    },
  },
  // the operator's Signups & onboarding screen (Phase 1 line 8 §5 item 16), on
  // the --p3 design store like signup
  "operator-onboarding": {
    id: "OPS-ONBOARDING",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/operator-onboarding/run.mjs", ...c.headed]);
    },
  },
  // Phase 3 line 1: the operator's Stores list and store page, on the --p3 design store
  "platform-stores": {
    id: "PLATFORM-STORES",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/platform-stores/run.mjs", ...c.headed]);
    },
  },
  // Phase 2 line 9: analytics, experiments, insights and automations on the roles store (admin, staff, support); evidence in docs/cms-reviews/drills/GROWTH/
  growth: { id: "GROWTH", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/growth/run.mjs", ...c.headed])) },
  // an operator creates a store for a founder (Phase 1 line 9 §5 item 21), on
  // the --p3 design store like operator-onboarding
  "operator-create-store": {
    id: "OPS-CREATE-STORE",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/operator-create-store/run.mjs", ...c.headed]);
    },
  },
  // Phase 3 line 0: the operator sign-in (a real authenticator code) and shell, on the --p3 design store
  "platform-shell": {
    id: "PLATFORM-SHELL",
    warm: true,
    async run(c) {
      const seeded = await c.node(["scripts/seed-design-documents.js", "--p3"]);
      return seeded !== 0 ? seeded : c.node(["scripts/drills/platform-shell/run.mjs", ...c.headed]);
    },
  },
  // Phase 2 line 10: product-finder quizzes on the roles store (staff, admin, support); evidence in docs/cms-reviews/drills/QUIZZES/
  quizzes: { id: "QUIZZES", warm: true, run: (c) => withRolesStore(c, () => c.node(["scripts/drills/quizzes/run.mjs", ...c.headed])) },
};
// Phase 2 line 11 (phase end): every merchant console screen's drill joins the block suite
export const ALL = ["smoke", "p5", "p6", "agency-gone", "shell", "signup", "connect", "operator-onboarding", "operator-create-store", "dashboard", "orders", "catalog", "offers", "media", "editor", "settings", "team", "growth", "quizzes", "console-styles"];

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

export async function runIsolated({ root = ROOT, names, stages = [], keep = false, headed = false, drills = DRILLS, install = ["pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]], ports = null, base = tmpdir(), say = console.log, gone = waitHarnessGone, warm = realWarm, installLock = null } = {}) {
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
  let current = null;
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    say(`\n✗ ${signal}: stopping this run's ${LIVE.size} child process(es)${keep ? "" : " and removing its worktree"}`);
    const children = [...LIVE];
    for (const c of children) c.kill("SIGTERM");
    const end = Date.now() + 15_000;
    while (children.some((c) => c.exitCode === null && !c.signalCode) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    for (const c of children) if (c.exitCode === null && !c.signalCode) c.kill("SIGKILL");
    if (current) keepServerLog(current.logDir, current.serverLog, worktree);
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
      const code = await withInstallLock(() => runChild(install[0], install[1], { cwd: worktree, env: { ...process.env, ...env }, log, echo: false, timeoutMs: 15 * 60_000 }), { say, ...(installLock ? { dir: installLock } : {}) });
      writeFileSync(join(resultsDir, "install.log"), log.join(""));
      if (code !== 0) throw new RunnerError(`pnpm install failed in the worktree (exit ${code}); see ${join(resultsDir, "install.log")}`);
    }
    for (const name of names) {
      const spec = drills[name];
      const log = [];
      const t0 = Date.now();
      say(`\n=== ${name}`);
      current = { logDir: join(worktree, ".drill-logs", name), serverLog: join(resultsDir, name, "server.log") };
      const denv = { ...env, DRILL_LOG_DIR: current.logDir };
      const ctx = {
        worktree,
        env: denv,
        ports: chosen,
        log,
        stages: stages.length ? [stages.join(",")] : [],
        headed: headed ? ["--headed"] : [],
        node: (args, opts = {}) => runChild(node, args, { cwd: worktree, env: denv, log, ...opts }),
      };
      let exit;
      try {
        if (spec.id) clearResults(worktree, root, spec.id);
        if (spec.warm) await warm(ctx, (m) => (log.push(`${m}\n`), say(m)));
        exit = await spec.run(ctx);
      } catch (e) {
        log.push(`✗ ${e instanceof RunnerError ? e.message : e.stack || e}\n`);
        if (e instanceof RunnerError) say(`✗ ${e.message}`);
        exit = 1;
      }
      writeFileSync(join(resultsDir, `${name}.log`), log.join(""));
      const copied = spec.id ? copyResults(worktree, root, stamp, spec.id) : null;
      const serverLog = keepServerLog(current.logDir, current.serverLog, worktree);
      current = null;
      rows.push({ drill: name, exit, seconds: Math.round((Date.now() - t0) / 1000), results: copied, log: join(resultsDir, `${name}.log`), serverLog });
      say(`--- ${name}: ${exit === 0 ? "passed" : `FAILED (exit ${exit})`} in ${Math.round((Date.now() - t0) / 1000)} s`);
      if (exit !== 0) say(serverLog ? `--- the last lines of ${serverLog}:\n${tailLines(readFileSync(serverLog, "utf8"))}` : "--- no server log was written");
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
