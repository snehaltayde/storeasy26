// The browser drills run on today's code, never on the owner's data (Phase 0 line 6).
//   pnpm test:drills
// No browser, no harness, no network. This suite proves:
//   1. package wiring: drill:p5, p6, smoke, agency-gone and all go through
//      scripts/drills/run-isolated.mjs; drill:edge and drill:p4 are gone;
//      .drill-results/ is gitignored
//   2. the retired drills (p1, p1c, p2, the p3 drills, p4 but its lib, the
//      legacy stages, harness-edge) are gone; the kept ones load, with the
//      stages the plan keeps
//   3. the guard: drill.js, runDrill, p5 and p6 refuse in this checkout
//      unless DRILL_ISOLATED_ROOT is it
//   4. the runner: a dirty tree is refused; ports skip busy and owner ports;
//      the worktree is under the temp folder
//   5. a stand-in run in a temp git repo leaves that repo's .design-data and
//      .design-env byte-identical, copies results, removes its worktree; a
//      stand-in that writes the owner's data fails the run
//   5b. between drills the runner waits for the last harness to exit; smoke
//      seeds --p3 first
//   5c. the warm-up: a next/font/google build error deletes .next and boots
//      again (up to 2 times), then fails "Google Fonts could not be fetched";
//      a drill that failed on a broken build reruns once
//   6. the drill helpers' own checks (p4, p5 and p6 lib.mjs --check)
//   7. every module the seed and drill scripts load (static and import("…")
//      relative paths, followed through scripts/) exists, and each name taken
//      from an import("…") is exported there, so a deleted module or export
//      fails pnpm test instead of the next seed
//   8. sf-styles (Phase 0 line 7): its runner entry, outside drill:all, and
//      the render comparator (identical → no difference; a synthetic style,
//      box and element change is found)
//   9. console-styles (Phase 0 line 8): its runner entry (roles store first,
//      the console set), outside drill:all; the comparator's ignoreProps and
//      ignoreBoxes options
//  10. shell (Phase 0 line 8): its runner entry (roles store, the annex, then
//      the drill), in drill:all
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R = await import("./drills/run-isolated.mjs");
const { assertIsolated, DrillError } = await import("./drill.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.message || e).split("\n").join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};
const throws = (fn, re, m = "") => {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(String(e?.message))) throw new Error(`${m} threw "${e?.message}", not ${re}`);
    return e;
  }
  throw new Error(`${m} did not throw`);
};
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.DRILL_ISOLATED_ROOT;
  return env;
};

await t("package.json: every drill goes through the isolated runner; drill:edge and drill:p4 are gone; test:drills is wired", async () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const name of ["p5", "p6", "smoke", "agency-gone", "all"]) eq(scripts[`drill:${name}`], `node scripts/drills/run-isolated.mjs ${name}`, `drill:${name}:`);
  eq(scripts["drill:edge"], undefined, "drill:edge:");
  eq(scripts["drill:p4"], undefined, "drill:p4:");
  eq(scripts["test:drills"], "node scripts/test-drills.js", "test:drills:");
  ok(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").includes("/.drill-results/"), ".gitignore has /.drill-results/:");
});

await t("the retired drills are gone; the shared libs and the kept drills stay", async () => {
  const gone = [
    "scripts/drills/p1",
    "scripts/drills/p1c",
    "scripts/drills/p2",
    "scripts/drills/harness-edge.js",
    ...["run", "smoke", "routes", "editor", "design", "rte", "matrix"].map((f) => `scripts/drills/p3/${f}.mjs`),
    ...["run", "cutover", "editor", "local-tenants", "media", "picker", "product", "reverse", "routes", "runbook", "seed-p4"].map((f) => `scripts/drills/p4/${f}.mjs`),
    "scripts/drills/p5/legacy.mjs",
    "scripts/drills/p6/legacy.mjs",
  ];
  eq(gone.filter((p) => existsSync(join(ROOT, p))).join(", "), "", "still there:");
  const kept = ["scripts/drills/p3/lib.mjs", "scripts/drills/p4/lib.mjs", "scripts/drills/p5/run.mjs", "scripts/drills/p6/run.mjs", "scripts/drills/smoke.js", "scripts/drills/agency-gone.mjs", "scripts/drill.js", "scripts/drill-maintenance-edge.js"];
  eq(kept.filter((p) => !existsSync(join(ROOT, p))).join(", "), "", "missing:");
  const p4 = readFileSync(join(ROOT, "scripts/drills/p4/lib.mjs"), "utf8");
  for (const name of ["revokeAgency", "moveStore", "rehearse", "makeRoutes", "movedP4Store", "reseedP4", "readP4Seed", "captureShopperRoutes", "migrate-documents", "reverse-documents", "migrate-render"]) ok(!p4.includes(name), `p4/lib.mjs still names ${name}:`);
  ok(!/--p4\b/.test(readFileSync(join(ROOT, "scripts/seed-design-documents.js"), "utf8")), "seed-design-documents.js has no --p4 mode left:");
});

await t("p5 and p6 keep exactly the planned stages (no legacy, baseline-legacy, f or final; p6 h is Phase 1 line 3's onboarding page)", async () => {
  const p5 = await import("./drills/p5/run.mjs");
  eq(p5.STAGES.join(","), "pick,create,states,nosaving,disabled,grid,cart,console,unknown", "p5:");
  const p6 = await import("./drills/p6/run.mjs");
  eq(p6.STAGES.join(","), "baseline,a,b,c,d,e,g,h", "p6:");
  const seed = await import("./drills/p6/seed-p6.mjs");
  eq(seed.P6_STAGES.join(","), "a,b,c,d,e,g,h", "seed-p6 P6_STAGES:");
  throws(() => seed.stagePlan("f"), /--stage/, "stagePlan(f):");
});

await t("assertIsolated refuses this checkout unless DRILL_ISOLATED_ROOT is it", async () => {
  const e = throws(() => assertIsolated({}, ROOT), /pnpm drill:/, "no env:");
  ok(e instanceof DrillError, "a DrillError:");
  throws(() => assertIsolated({ DRILL_ISOLATED_ROOT: tmpdir() }, ROOT), /throwaway worktree/, "another folder:");
  eq(assertIsolated({ DRILL_ISOLATED_ROOT: ROOT }, ROOT), ROOT, "this checkout named:");
});

await t("seed-design-documents.js refuses to seed or wipe .design-data outside the drill worktree; check stays read-only and allowed", async () => {
  const { assertSeedAllowed } = await import("./seed-design-documents.js");
  for (const argv of [[], ["--p3"], ["--p6", "--stage", "a"], ["--worst-case"], ["--drafts-only"]]) {
    throws(() => assertSeedAllowed(argv, {}, ROOT), /pnpm drill:/, `${argv.join(" ") || "(plain)"} with no env:`);
    throws(() => assertSeedAllowed(argv, { DRILL_ISOLATED_ROOT: tmpdir() }, ROOT), /throwaway worktree/, `${argv.join(" ") || "(plain)"} in another folder:`);
    assertSeedAllowed(argv, { DRILL_ISOLATED_ROOT: ROOT }, ROOT);
  }
  for (const argv of [["check"], ["check", "--p3"], ["check", "--p6"]]) assertSeedAllowed(argv, {}, ROOT);
  // the CLI refuses before anything runs (--p3 with --drafts-only is refused by parseArgs too, so this never seeds)
  const r = spawnSync(process.execPath, ["scripts/seed-design-documents.js", "--p3", "--drafts-only"], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 30_000 });
  eq(r.status, 1, "exit:");
  ok(/pnpm drill:/.test(r.stderr), `says use pnpm drill: ${r.stderr.trim().slice(0, 200)}`);
  // pnpm seed:design (the owner's command) does not go through this file
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  eq(scripts["seed:design"], "node scripts/dev-design.js seed", "seed:design:");
  ok(!readFileSync(join(ROOT, "scripts/dev-design.js"), "utf8").includes("seed-design-documents"), "dev-design.js does not run seed-design-documents.js:");
  // the missing-seed messages send the reader to pnpm drill:<name>, never to a reseed of this checkout
  for (const [file, drill] of [["scripts/drills/p3/lib.mjs", "p5"], ["scripts/drills/p6/lib.mjs", "p6"]]) {
    const src = readFileSync(join(ROOT, file), "utf8");
    ok(!/(Reseed|Seed a stage): node scripts\/seed-design-documents/.test(src), `${file} still tells the reader to seed this checkout:`);
    ok(src.includes(`pnpm drill:${drill}`), `${file} names pnpm drill:${drill}:`);
  }
});

await t("drill.js, p5 and p6 refuse to start in the main checkout (before any seed, server or browser)", async () => {
  for (const [args, code] of [[["scripts/drill.js", "smoke", "--start"], 2], [["scripts/drills/p5/run.mjs"], 1], [["scripts/drills/p6/run.mjs"], 1]]) {
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...cleanEnv(), DESIGN_PORT: "6190", DESIGN_SQLD_PORT: "7190" }, encoding: "utf8", timeout: 60_000 });
    eq(r.status, code, `${args[0]} exit:`);
    ok(/throwaway worktree/.test(r.stderr), `${args[0]} says why: ${r.stderr.trim().slice(0, 200)}`);
  }
});

await t("agency-gone has no default store (never 3017) and asks for the isolated runner", async () => {
  const env = cleanEnv();
  for (const k of ["ROLES_PORT", "AGENCY_GONE_BASE_URL"]) delete env[k];
  const r = spawnSync(process.execPath, ["scripts/drills/agency-gone.mjs"], { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
  eq(r.status, 2, "exit:");
  ok(/pnpm drill:agency-gone/.test(r.stderr), "message:");
  ok(!readFileSync(join(ROOT, "scripts/drills/agency-gone.mjs"), "utf8").includes("3017"), "no 3017 in the drill:");
});

await t("assertCleanTree refuses tracked changes and new code files; ignores the hands-off docs and other new files", async () => {
  throws(() => R.assertCleanTree(" M lib/format.js\n"), /commit/, "changed:");
  throws(() => R.assertCleanTree("M  package.json\n"), /commit/, "staged:");
  throws(() => R.assertCleanTree("?? scripts/new-thing.js\n"), /new scripts\/new-thing\.js/, "new script:");
  throws(() => R.assertCleanTree("?? app/x/page.js\n"), /commit/, "new page:");
  throws(() => R.assertCleanTree("?? proxy.js\n"), /new proxy\.js/, "new root proxy.js:");
  throws(() => R.assertCleanTree("?? next.config.ts\n"), /commit/, "new root config:");
  R.assertCleanTree("");
  R.assertCleanTree("?? docs/CMS_CLAUDE_DIRECTION_BRIEF.md\n?? docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md\n?? docs/CMS_SESSION_HANDOFF.md\n?? notes.txt\n");
});

await t("choosePorts skips a busy block and every owner port, and never frees anything", async () => {
  const asked = [];
  const busy = new Set([6100]);
  const p = await R.choosePorts({ slot: 0, isBusy: async (n) => (asked.push(n), busy.has(n)) });
  eq(JSON.stringify(p), JSON.stringify({ next: 6110, sqld: 20200, rolesNext: 6111, rolesSqld: 20300 }), "block:");
  // each heavy slot has its own region, so two slots never pick the same block
  const regions = await Promise.all([1, 2, 3].map((slot) => R.choosePorts({ slot, isBusy: async () => false })));
  eq(new Set(regions.flatMap((r) => R.portsOf(r))).size, regions.length * R.portsOf(regions[0]).length, "slot regions overlap");
  eq(R.slotIndex({ HEAVY_SLOT: "2" }), 2, "HEAVY_SLOT read");
  eq(R.slotIndex({}), 0, "no slot → region 0");
  const q = await R.choosePorts({ isBusy: async () => false, site: 3016, db: 7100, step: 1 });
  ok(![q.next, q.rolesNext].some((n) => R.OWNER_PORTS.includes(n)), `owner port chosen: ${JSON.stringify(q)}`);
  eq(q.next, 3019, "first block with no owner port:");
  const r = await R.choosePorts({ isBusy: async () => false, site: 6100, db: 18010, step: 1, tries: 12 });
  ok(![r.sqld, r.sqld + 1, r.sqld + 2, r.rolesSqld, r.rolesSqld + 1, r.rolesSqld + 2].some((n) => R.OWNER_PORTS.includes(n)), `owner db port chosen: ${JSON.stringify(r)}`);
  let err = null;
  await R.choosePorts({ isBusy: async () => true, tries: 3 }).catch((e) => (err = e));
  ok(err instanceof R.RunnerError && /Nothing was stopped/.test(err.message), "all busy:");
});

await t("the worktree goes under the temp folder, never in the repo", async () => {
  const p = R.worktreePath("stamp-1");
  ok(p.startsWith(tmpdir()) && !p.startsWith(ROOT), p);
});

// A temp git repo standing in for the owner's checkout.
function standInRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drills-standin-")));
  const g = (...a) => {
    const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.test", ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  g("init", "-q");
  writeFileSync(join(root, ".gitignore"), "/.design-data/\n/.design-env\n/.design-data-roles/\n/.drill-results/\n");
  writeFileSync(join(root, "README"), "stand-in\n");
  g("add", ".");
  g("commit", "-qm", "init");
  mkdirSync(join(root, ".design-data"));
  writeFileSync(join(root, ".design-env"), "DESIGN_ADMIN_PASSWORD=owner\n");
  writeFileSync(join(root, ".design-data/seeded.json"), '{"owner":true}\n');
  writeFileSync(join(root, ".design-data/p6-seed.json"), '{"owner":"p6"}\n');
  return root;
}
// What a drill does to its own checkout: reseeds .design-data, regenerates .design-env, writes results.
const RESEED = `const fs=require("fs");if(process.env.DRILL_ISOLATED_ROOT!==fs.realpathSync(process.cwd()))process.exit(9);fs.rmSync(".design-data",{recursive:true,force:true});fs.mkdirSync(".design-data");fs.writeFileSync(".design-data/seeded.json","{}");fs.writeFileSync(".design-data/p6-seed.json","{}");fs.writeFileSync(".design-env","X=1");fs.mkdirSync("docs/cms-reviews/drills/STANDIN",{recursive:true});fs.writeFileSync("docs/cms-reviews/drills/STANDIN/results.json",JSON.stringify({ports:process.env.DESIGN_PORT,ai:process.env.ANTHROPIC_API_KEY,shop:process.env.SHOPIFY_STORE_DOMAIN}));`;
const PORTS = { next: 6195, sqld: 7195, rolesNext: 6196, rolesSqld: 7198 };
const worktrees = (root) => spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("worktree ")).length;

await t("a stand-in run reseeds only its worktree: the repo's .design-data and .design-env stay byte-identical, results are copied, the worktree is removed", async () => {
  const root = standInRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "drills-wt-")));
  try {
    const before = R.ownerDataFingerprint(root);
    const bytes = [".design-env", ".design-data/seeded.json", ".design-data/p6-seed.json"].map((f) => readFileSync(join(root, f), "utf8"));
    const s = await R.runIsolated({ root, names: ["standin"], drills: { standin: { id: "STANDIN", run: (c) => c.node(["-e", RESEED], { echo: false }) } }, install: null, ports: PORTS, base, say: () => {} });
    eq(s.rows[0].exit, 0, "stand-in exit (9 = DRILL_ISOLATED_ROOT is not its cwd):");
    eq(s.failed, 0, "failed:");
    eq(JSON.stringify(R.ownerDataFingerprint(root)), JSON.stringify(before), "fingerprint:");
    eq([".design-env", ".design-data/seeded.json", ".design-data/p6-seed.json"].map((f) => readFileSync(join(root, f), "utf8")).join("|"), bytes.join("|"), "bytes:");
    const res = JSON.parse(readFileSync(join(s.rows[0].results, "results.json"), "utf8"));
    eq(res.ports, "6195", "the drill got the runner's port:");
    eq(res.ai, "", "AI key blank:");
    eq(res.shop, "", "Shopify domain blank:");
    ok(s.rows[0].results.startsWith(join(root, ".drill-results")), "results under .drill-results:");
    ok(existsSync(join(root, ".drill-results", s.ranAt, "summary.json")), "summary.json:");
    ok(!existsSync(s.worktree), "worktree folder removed:");
    eq(worktrees(root), 1, "git worktree list:");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

await t("a stand-in that writes the owner's data fails the run, and a dirty stand-in repo is refused before any worktree", async () => {
  const root = standInRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "drills-wt-")));
  try {
    const touch = `require("fs").writeFileSync(${JSON.stringify(join(root, ".design-data/seeded.json"))},"{}")`;
    const s = await R.runIsolated({ root, names: ["bad"], drills: { bad: { id: null, run: (c) => c.node(["-e", touch], { echo: false }) } }, install: null, ports: PORTS, base, say: () => {} });
    eq(s.ownerData.changed.join(","), ".design-data/seeded.json", "changed:");
    ok(s.failed > 0, "the run fails:");
    writeFileSync(join(root, "README"), "edited\n");
    let err = null;
    await R.runIsolated({ root, names: ["bad"], drills: {}, install: null, ports: PORTS, base, say: () => {} }).catch((e) => (err = e));
    ok(err instanceof R.RunnerError, `dirty tree refused: ${err?.message}`);
    eq(worktrees(root), 1, "no worktree made:");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

await t("between drills the runner waits until the last harness has exited (pid file, ports), and a stuck one stops the run clearly", async () => {
  const port = 6197;
  const P = { next: port, sqld: 7290, rolesNext: 6198, rolesSqld: 7293 };
  // a stand-in harness: listens on the site port, exits on its own after 1.5 s
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", `const s=require("net").createServer().listen(${port},"127.0.0.1");setTimeout(()=>{s.close();process.exit(0)},1500)`], { stdio: "ignore" });
  try {
    // wait until the stand-in really listens (a loaded machine can take a while
    // to start node), so the wait below has something to wait for
    const { isPortBusy } = await import("./design-harness.js");
    for (let i = 0; i < 100 && !(await isPortBusy(port)) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    const running = (dir) => (dir.endsWith(".design-data") && child.exitCode === null ? { launcher: { pid: child.pid } } : null);
    const t0 = Date.now();
    const g = await R.waitHarnessGone({ worktree: tmpdir(), ports: P, running, timeoutMs: 10_000, stepMs: 100 });
    eq(g.ok, true, "gone:");
    ok(Date.now() - t0 >= 1000, `waited for the stand-in to exit (${Date.now() - t0} ms)`);
    ok(child.exitCode !== null, "the stand-in exited by itself (nothing was killed):");
  } finally {
    if (child.exitCode === null) child.kill();
  }
  const stuck = await R.waitHarnessGone({ worktree: tmpdir(), ports: P, running: () => ({ launcher: { pid: 4242 } }), isBusy: async (n) => n === 7290, timeoutMs: 300, stepMs: 100 });
  eq(stuck.ok, false, "stuck:");
  ok(/pid 4242/.test(stuck.why) && /7290/.test(stuck.why), `says why: ${stuck.why}`);
  const root = standInRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "drills-wt-")));
  try {
    const ran = [];
    const drills = { one: { id: null, run: async () => (ran.push("one"), 0) }, two: { id: null, run: async () => (ran.push("two"), 0) } };
    const s = await R.runIsolated({ root, names: ["one", "two"], drills, install: null, ports: PORTS, base, say: () => {}, gone: async () => ({ ok: false, why: "ports 7195 still answer" }) });
    eq(ran.join(","), "one", "the next drill is not started:");
    ok(s.failed > 0 && s.rows.some((r) => r.drill === "one (cleanup)" && /7195/.test(r.why)), "the run fails, naming why:");
    eq(worktrees(root), 1, "worktree still removed:");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

await t("results are always this run's: the worktree's committed docs/cms-reviews/drills/<ID>/ is emptied before each drill (worktree only)", async () => {
  const root = standInRepo();
  const g = (...a) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.test", ...a], { encoding: "utf8" });
  mkdirSync(join(root, "docs/cms-reviews/drills/STANDIN"), { recursive: true });
  writeFileSync(join(root, "docs/cms-reviews/drills/STANDIN/old.json"), '{"old":true}\n');
  g("add", ".");
  g("commit", "-qm", "historical results");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "drills-wt-")));
  try {
    const s = await R.runIsolated({ root, names: ["standin"], drills: { standin: { id: "STANDIN", run: (c) => c.node(["-e", RESEED], { echo: false }) } }, install: null, ports: PORTS, base, say: () => {} });
    eq(s.rows[0].exit, 0, "exit:");
    ok(existsSync(join(s.rows[0].results, "results.json")), "this run's results copied:");
    ok(!existsSync(join(s.rows[0].results, "old.json")), "the committed old results are not copied:");
    ok(existsSync(join(root, "docs/cms-reviews/drills/STANDIN/old.json")), "the checkout's own committed file is untouched:");
    throws(() => R.clearResults(root, root, "STANDIN"), /worktree/, "refuses the checkout itself:");
    ok(existsSync(join(root, "docs/cms-reviews/drills/STANDIN/old.json")), "still there after the refusal:");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

await t("Ctrl-C (SIGINT) or SIGTERM: the runner stops its own children and removes its own worktree", async () => {
  const { spawn } = await import("node:child_process");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const root = standInRepo();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "drills-wt-")));
    const pidFile = join(base, "grandchild.pid");
    const slow = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const script = `const R=await import(${JSON.stringify(new URL("./drills/run-isolated.mjs", import.meta.url).href)});await R.runIsolated({root:${JSON.stringify(root)},names:["slow"],drills:{slow:{id:null,run:(c)=>c.node(["-e",${JSON.stringify(slow)}],{echo:false})}},install:null,ports:${JSON.stringify(PORTS)},base:${JSON.stringify(base)},say:()=>{}});`;
    const runner = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    runner.stdout.on("data", (c) => (out += c));
    runner.stderr.on("data", (c) => (out += c));
    let grandchild = null;
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
      ok(existsSync(pidFile), `the drill child started: ${out}`);
      grandchild = Number(readFileSync(pidFile, "utf8"));
      eq(worktrees(root), 2, "worktree made:");
      const exited = new Promise((r) => runner.once("exit", (code, sig) => r({ code, sig })));
      runner.kill(signal);
      const { code } = await exited;
      ok(code !== 0, `${signal}: the runner exits non-zero (${code}): ${out}`);
      for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
      ok(!alive(grandchild), `${signal}: its drill child was stopped:`);
      eq(worktrees(root), 1, `${signal}: worktree removed (git worktree list):`);
      eq(readdirSync(base).filter((f) => f.startsWith("storeasy-drill-")).join(","), "", `${signal}: worktree folder removed:`);
    } finally {
      if (runner.exitCode === null) runner.kill("SIGKILL");
      if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  }
});

await t("smoke seeds the --p3 documents store (a live release) before it starts its harness", async () => {
  const calls = [];
  await R.DRILLS.smoke.run({ node: async (args) => (calls.push(args.join(" ")), 0), headed: [] });
  eq(calls.join(" | "), "scripts/seed-design-documents.js --p3 | scripts/drill.js smoke --start", "steps:");
});

// A stand-in harness: each boot answers with the pages in `boots` (in turn); the font error is
// what Next 16.2.9 Turbopack served in the 2026-11-24T02-20 run.
const FONT_PAGE = "<html>Build Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'</html>";
function standInHarness(boots, { output = [] } = {}) {
  const calls = { starts: 0, stops: 0, cleans: 0, gones: 0 };
  const start = async () => {
    const i = calls.starts++;
    return { probe: async () => boots[i].map((body, n) => ({ path: ["/", "/admin/login"][n], status: body === FONT_PAGE ? 500 : 200, body })), output: () => output[i] || "", stop: async () => void calls.stops++ };
  };
  return { calls, start, clean: () => void calls.cleans++, gone: async () => (calls.gones++, { ok: true }) };
}

await t("warm-up: a good build boots once; nothing is deleted", async () => {
  const h = standInHarness([["<html>home</html>", "<html>login</html>"]]);
  const w = await R.warmBuild(h);
  eq(w.attempts, 1, "attempts:");
  eq(JSON.stringify(h.calls), JSON.stringify({ starts: 1, stops: 1, cleans: 0, gones: 1 }), "calls:");
});

await t("warm-up: the next/font/google build error → its own harness stopped, .next deleted, booted again (page or harness output)", async () => {
  const h = standInHarness([[FONT_PAGE, FONT_PAGE], ["ok", "ok"]]);
  const said = [];
  eq((await R.warmBuild({ ...h, say: (m) => said.push(m) })).attempts, 2, "attempts:");
  eq(JSON.stringify(h.calls), JSON.stringify({ starts: 2, stops: 2, cleans: 1, gones: 2 }), "calls:");
  ok(/next\/font\/google \(\/ 500, \/admin\/login 500\)/.test(said[0]), `says what it saw: ${said[0]}`);
  // pages 200 but the harness printed the error: still caught
  const o = standInHarness([["ok", "ok"], ["ok", "ok"], ["ok", "ok"]], { output: [`⨯ Module not found: Can't resolve '@vercel/${R.FONT_BUILD_ERROR}/font'`, "", ""] });
  eq((await R.warmBuild(o)).attempts, 2, "output-only attempts:");
  eq(o.calls.cleans, 1, "output-only cleans:");
});

await t("warm-up: still broken after 2 retries → fails plainly naming the font fetch; the harness is stopped every time", async () => {
  const h = standInHarness([[FONT_PAGE, "ok"], [FONT_PAGE, "ok"], [FONT_PAGE, "ok"], ["ok", "ok"]]);
  let err;
  await R.warmBuild(h).catch((e) => (err = e));
  ok(err instanceof R.RunnerError, "a RunnerError:");
  ok(err.message.startsWith("Google Fonts could not be fetched; check the network"), `message: ${err.message}`);
  eq(JSON.stringify(h.calls), JSON.stringify({ starts: 3, stops: 3, cleans: 2, gones: 3 }), "calls:");
  // a harness that won't stop is reported, never killed by the runner
  let stuck;
  await R.warmBuild({ ...standInHarness([["ok", "ok"]]), gone: async () => ({ ok: false, why: "ports 6100 still answer" }) }).catch((e) => (stuck = e));
  ok(/6100 still answer/.test(stuck?.message), `stuck: ${stuck?.message}`);
  // the stand-in's probe throws: the harness is still stopped
  const s = standInHarness([["ok", "ok"]]);
  await R.warmBuild({ ...s, start: async () => ({ ...(await s.start()), probe: async () => { throw new Error("boom"); } }) }).catch(() => {});
  eq(s.calls.stops, 1, "stopped after a throwing probe:");
});

await t("runner + warm-up: warm drills warm first; a drill that failed on a broken build reruns once; a font failure stops the run; stand-in drills never warm", async () => {
  const root = standInRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "drills-wt-")));
  try {
    const order = [];
    let warms = 0;
    const warm = async () => (order.push(`warm${++warms}`), { attempts: warms === 2 ? 2 : 1 });
    let runs = 0;
    const drills = { a: { id: null, warm: true, run: async () => (order.push(`a${++runs}`), runs === 1 ? 1 : 0) }, b: { id: null, run: async () => (order.push("b"), 0) } };
    const s = await R.runIsolated({ root, names: ["a", "b"], drills, install: null, ports: PORTS, base, say: () => {}, gone: async () => ({ ok: true }), warm });
    eq(order.join(","), "warm1,a1,warm2,a2,b", "order:");
    eq(s.rows[0].exit, 0, "the rerun's exit counts:");
    ok(readFileSync(s.rows[0].log, "utf8").includes("running it once more"), "the log says it reran:");
    const ran = [];
    const fontDrills = { a: { id: null, warm: true, run: async () => (ran.push("a"), 0) }, b: { id: null, warm: true, run: async () => (ran.push("b"), 0) } };
    const failWarm = async () => {
      throw new R.RunnerError(`${R.FONT_FAIL}. stand-in`);
    };
    const f = await R.runIsolated({ root, names: ["a", "b"], drills: fontDrills, install: null, ports: PORTS, base, say: () => {}, gone: async () => ({ ok: true }), warm: failWarm });
    eq(ran.length, 0, "no drill ran against the broken build:");
    eq(f.rows.length, 1, "the run stops after the first:");
    ok(f.failed > 0 && readFileSync(f.rows[0].log, "utf8").includes("Google Fonts could not be fetched; check the network"), "fails with the plain message:");
    eq(worktrees(root), 1, "worktree still removed:");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

await t("the drill helpers' own checks pass (p4, p5 and p6 lib.mjs --check; p6 carries the old final stage's selfCheck)", async () => {
  for (const lib of ["p4", "p5", "p6"]) {
    const r = spawnSync(process.execPath, [`scripts/drills/${lib}/lib.mjs`, "--check"], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 60_000 });
    eq(r.status, 0, `${lib} --check: ${r.stdout}${r.stderr}`);
  }
});

await t("every module the seed and drill scripts load exists, with the names they take (seed:design, --p3, --p6, seed:roles, the drills)", async () => {
  const entries = ["scripts/seed-design-preview.js", "scripts/seed-design-documents.js", "scripts/perf-docs-fixture.js", "scripts/dev-design.js", "scripts/dev-roles.js", "scripts/seed-roles.js", "scripts/drill.js", "scripts/drills/run-isolated.mjs", "scripts/drills/smoke.js", "scripts/drills/agency-gone.mjs", "scripts/drills/p5/run.mjs", "scripts/drills/p5/blocks.mjs", "scripts/drills/p6/run.mjs", "scripts/drills/p6/seed-p6.mjs", "scripts/drills/p6/generate.mjs", "scripts/drills/p6/brand.mjs", "scripts/drills/p6/open.mjs", "scripts/drills/p6/empty.mjs", "scripts/drills/p6/setup.mjs", "scripts/drills/p6/onboarding.mjs", "scripts/drills/sf-styles/run.mjs", "scripts/drills/shell/run.mjs", "scripts/drill-maintenance-edge.js", "scripts/perf-report.js"];
  const seen = new Set();
  const missing = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), m[1]);
      if (!existsSync(target)) missing.push(`${relative(ROOT, file)} → ${m[1]}`);
      else if (/\.m?js$/.test(target)) walk(target);
    }
    // const { a, b: c } = await import("./x.js"): each name must be exported there
    for (const m of readFileSync(file, "utf8").matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const target = resolve(dirname(file), m[2]);
      if (!existsSync(target)) continue;
      const src = readFileSync(target, "utf8");
      if (/export\s*\*/.test(src)) continue;
      for (const name of m[1].split(",").map((x) => x.split(":")[0].trim()).filter(Boolean)) {
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src);
        if (!exported) missing.push(`${relative(ROOT, file)} → ${m[2]} has no export ${name}`);
      }
    }
  };
  for (const e of entries) walk(join(ROOT, e));
  // p5 and p6 load their stages through a variable import: STAGE_FILES { stage: ["./file.mjs", "export"] }
  for (const run of ["scripts/drills/p5/run.mjs", "scripts/drills/p6/run.mjs"]) {
    const stages = [...readFileSync(join(ROOT, run), "utf8").matchAll(/\[\s*"(\.\/[^"]+\.mjs)",\s*"(\w+)"\s*\]/g)];
    ok(stages.length >= 5, `${run}: found ${stages.length} stage files:`);
    for (const [, file, name] of stages) {
      const target = resolve(dirname(join(ROOT, run)), file);
      if (!existsSync(target)) missing.push(`${run} → ${file}`);
      else if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(readFileSync(target, "utf8"))) missing.push(`${run} → ${file} has no export ${name}`);
      else walk(target);
    }
  }
  ok(seen.size > 50, `followed ${seen.size} files:`);
  eq(missing.join("; "), "", "missing modules:");
});

await t("sf-styles: the runner entry and drill:sf-styles exist, outside drill:all", async () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  eq(scripts["drill:sf-styles"], "node scripts/drills/run-isolated.mjs sf-styles", "drill:sf-styles:");
  const spec = R.DRILLS["sf-styles"];
  eq(spec?.id, "SF-STYLES", "id:");
  eq(spec?.warm, true, "warm:");
  ok(!R.ALL.includes("sf-styles"), "not in ALL:");
  const calls = [];
  await spec.run({ node: async (args) => (calls.push(args.join(" ")), 0), headed: [] });
  eq(calls.join(" | "), "scripts/drills/sf-styles/run.mjs", "runs:");
  const env = R.drillEnv({ SF_STYLES_BASELINE: "/abs/base", SF_STYLES_BITE: "1" }, "/w", { next: 6100, sqld: 7100, rolesNext: 6101, rolesSqld: 7103 });
  eq(env.SF_STYLES_BASELINE, "/abs/base", "the baseline passes through:");
  eq(env.SF_STYLES_BITE, "1", "the bite flag passes through:");
  eq(env.STOREASY_TURBOPACK_DEV_CACHE, "off", "drills run without the Turbopack persistent dev cache:");
});

await t("next.config.mjs: the Turbopack persistent dev cache is off only when STOREASY_TURBOPACK_DEV_CACHE=off", async () => {
  const load = async (v) => {
    const before = process.env.STOREASY_TURBOPACK_DEV_CACHE;
    if (v === undefined) delete process.env.STOREASY_TURBOPACK_DEV_CACHE;
    else process.env.STOREASY_TURBOPACK_DEV_CACHE = v;
    try {
      return (await import(`../next.config.mjs?v=${v}`)).default.experimental?.turbopackFileSystemCacheForDev;
    } finally {
      if (before === undefined) delete process.env.STOREASY_TURBOPACK_DEV_CACHE;
      else process.env.STOREASY_TURBOPACK_DEV_CACHE = before;
    }
  };
  eq(await load("off"), false, "off in a drill:");
  eq(await load(undefined), true, "on otherwise:");
});

await t("sf-styles compare: identical captures have no differences; a synthetic style, box and element change is found", async () => {
  const C = await import("./drills/sf-styles/compare.js");
  const el = (k, s, b = [0, 0, 100, 20]) => ({ k, s, b });
  const base = [{ page: "home", width: 375, shot: "a", elements: [el("html", { color: "red", "letter-spacing": "normal" }), el("html>body:1", { color: "red" }), el("html>body:1::before", { content: '""' }, null)] }];
  const same = structuredClone(base);
  same[0].elements[0].s = { "letter-spacing": "normal", color: "red" }; // property order never matters
  const d0 = C.diffRuns(base, same);
  eq(JSON.stringify(d0.totals), JSON.stringify({ style: 0, box: 0, added: 0, removed: 0, customChanged: 0, customAdded: 0, ignored: 0, boxReported: 0, frame: 0, shots: 0, missing: 0 }), "identical:");
  ok(C.isClean(d0.totals), "identical is clean:");
  eq(C.elementHash(base[0].elements[0]), C.elementHash(same[0].elements[0]), "hash ignores property order:");
  const next = structuredClone(base);
  next[0].shot = "b";
  next[0].elements[0].s["letter-spacing"] = "0.0375px";
  next[0].elements[1].b = [0, 0, 100.5, 20];
  next[0].elements.pop();
  next[0].elements.push(el("html>body:1>div:1", { color: "red" }));
  const d1 = C.diffRuns(base, next);
  eq(JSON.stringify(d1.totals), JSON.stringify({ style: 1, box: 1, added: 1, removed: 1, customChanged: 0, customAdded: 0, ignored: 0, boxReported: 0, frame: 0, shots: 1, missing: 0 }), "changed:");
  ok(!C.isClean(d1.totals), "changed is not clean:");
  const s = d1.pages[0].samples.find((x) => x.kind === "style");
  eq(`${s.k} ${s.prop} ${s.before} → ${s.after}`, "html letter-spacing normal → 0.0375px", "style sample:");
  // custom properties: a new one is reported, not failed; a changed one fails
  const tok = structuredClone(base);
  tok[0].elements[0].s["--tw-enter-opacity"] = "1";
  const d3 = C.diffRuns(base, tok);
  eq(`${d3.totals.customAdded} ${d3.totals.customChanged} ${d3.customAdded.join(",")} ${C.isClean(d3.totals)}`, "1 0 --tw-enter-opacity true", "a new custom property:");
  const d4 = C.diffRuns(tok, structuredClone(tok).map((c) => ((c.elements[0].s["--tw-enter-opacity"] = "0"), c)));
  eq(`${d4.totals.customChanged} ${C.isClean(d4.totals)}`, "1 false", "a changed custom property:");
  const d2 = C.diffRuns(base, [{ ...base[0], width: 768 }]);
  eq(d2.totals.missing, 2, "a page at another width is missing both ways:");
  eq(C.round(10.26), 10.5, "boxes round to 0.5px:");
  eq(JSON.stringify(C.roundBox({ x: 1.2, y: 2.74, width: 3, height: 4.1 })), "[1,2.5,3,4]", "roundBox:");
});

await t("console-styles: the runner entry seeds and starts the roles store, then runs the console set; drill:console-styles exists, outside drill:all", async () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  eq(scripts["drill:console-styles"], "node scripts/drills/run-isolated.mjs console-styles", "drill:console-styles:");
  const spec = R.DRILLS["console-styles"];
  eq(spec?.id, "CONSOLE-STYLES", "id:");
  eq(spec?.warm, true, "warm:");
  ok(!R.ALL.includes("console-styles"), "not in ALL:");
  const calls = [];
  const stopped = [];
  const c = { worktree: "/w", env: { A: "1" }, ports: { rolesNext: 6101 }, log: [], headed: [], node: async (args, opts = {}) => (calls.push(`${args.join(" ")}${opts.env?.SF_STYLES_SET ? ` [${opts.env.SF_STYLES_SET}]` : ""}`), 0) };
  const fakeStart = () => ({ child: {}, stop: async () => stopped.push("roles") });
  eq(await R.withRolesStore(c, () => c.node(["x"]), { start: fakeStart, up: async (url) => (calls.push(url), true) }), 0, "exit:");
  eq(calls.join(" | "), "scripts/dev-roles.js seed --reset | http://roles.localhost:6101/api/health | x", "seed, wait, run:");
  eq(stopped.join(","), "roles", "the roles store is stopped after:");
  const src = readFileSync(join(ROOT, "scripts/drills/run-isolated.mjs"), "utf8");
  ok(/"console-styles":[^\n]*withRolesStore[^\n]*sf-styles\/run\.mjs[^\n]*SF_STYLES_SET: "console"/.test(src), "console-styles runs run.mjs with SF_STYLES_SET=console inside withRolesStore:");
  ok(/"agency-gone":[^\n]*withRolesStore/.test(src), "agency-gone uses the same helper:");
  calls.length = 0;
  eq(await R.withRolesStore(c, () => c.node(["x"]), { start: fakeStart, up: async () => false }), 1, "a store that never answers fails:");
  ok(!calls.includes("x"), "and the drill is not run:");
});

await t("console-styles compare: ignoreProps (names and prefixes) and ignoreBoxes count apart; anything else still fails", async () => {
  const C = await import("./drills/sf-styles/compare.js");
  const el = (k, s, b = [0, 0, 100, 20]) => ({ k, s, b });
  const base = [{ page: "owner-orders", width: 1280, shot: "a", elements: [el("root>div:1", { width: "800px", top: "0px", color: "red" })] }];
  const wide = structuredClone(base);
  wide[0].elements[0].s.width = "980px";
  wide[0].elements[0].s.top = "56px";
  wide[0].elements[0].b = [0, 0, 980, 20];
  const strict = C.diffRuns(base, wide);
  ok(!C.isClean(strict.totals), "without options the wider column fails:");
  const opts = { ignoreProps: ["width", "top", "--tw-*"], ignoreBoxes: true };
  const d = C.diffRuns(base, wide, opts);
  eq(`${d.totals.style} ${d.totals.box} ${d.totals.ignored} ${d.totals.boxReported} ${C.isClean(d.totals)}`, "0 0 2 1 true", "ignored and reported, clean:");
  const bitten = structuredClone(wide);
  bitten[0].elements[0].s["letter-spacing"] = "0.16px";
  bitten[0].elements[0].s["--tw-x"] = "1";
  const d2 = C.diffRuns(base, bitten, opts);
  eq(`${d2.totals.style} ${d2.totals.customAdded} ${d2.totals.ignored} ${C.isClean(d2.totals)}`, "1 0 3 false", "a bite still fails; a prefix entry skips --tw-x:");
  eq(C.ignoreMatcher(["--*"])("--c-bg") && !C.ignoreMatcher(["--*"])("color"), true, "a prefix entry matches only its prefix:");
  // frameOutside: outside an old region (l falsy in the next capture) differences are reported as frame; inside they fail
  const doc = [{ page: "admin-login", width: 1280, shot: "a", elements: [el("html>body:2", { "background-color": "white" }), el("html>body:2>div:1", { color: "black" })] }];
  const after = structuredClone(doc);
  after[0].elements[0].s["background-color"] = "paper";
  after[0].elements[0].l = 0;
  after[0].elements[1].l = 1;
  const d3 = C.diffRuns(doc, after, { frameOutside: true });
  eq(`${d3.totals.style} ${d3.totals.frame} ${C.isClean(d3.totals)}`, "0 1 true", "the frame is reported:");
  after[0].elements[1].s.color = "blue";
  const d4 = C.diffRuns(doc, after, { frameOutside: true });
  eq(`${d4.totals.style} ${d4.totals.frame} ${C.isClean(d4.totals)}`, "1 1 false", "inside a region a difference fails:");
});

await t("console-styles: topShiftCheck passes only on the sticky preview moving 16px to 72px inside the region", async () => {
  const C = await import("./drills/sf-styles/compare.js");
  const el = (k, position, top, l = 1) => ({ k, s: { position, top }, l });
  const base = { elements: [el("root>div:1", "static", "auto"), el("root>div:1>div:2", "sticky", "16px"), el("root>div:1>div:3", "absolute", "8px"), el("root>div:1>div:4", "relative", "0px")] };
  const good = structuredClone(base);
  good.elements[1].s.top = "72px";
  good.elements[3].s.top = "4px"; // a relative element's top is listed, not failed
  const r = C.topShiftCheck(base, good);
  eq(`${r.ok} ${r.moved?.k} ${r.placed} ${r.others}`, "true root>div:1>div:2 1 1", "the preview alone moved:");
  eq(C.topShiftCheck(base, structuredClone(base)).ok, false, "no move at all fails (the preview must be found):");
  const two = structuredClone(good);
  two.elements[2].s.top = "64px";
  eq(`${C.topShiftCheck(base, two).ok} ${C.topShiftCheck(base, two).placed}`, "false 2", "a second positioned element moving fails:");
  const wrong = structuredClone(base);
  wrong.elements[1].s.top = "56px";
  eq(C.topShiftCheck(base, wrong).ok, false, "the wrong offset fails:");
  const fixed = structuredClone(base);
  fixed.elements[2].s.top = "72px";
  fixed.elements[2].s.position = "fixed";
  eq(C.topShiftCheck(base, fixed).ok, false, "a non-sticky element moving to 72px fails:");
  const outside = structuredClone(good);
  outside.elements[2].s.top = "64px";
  outside.elements[2].l = 0;
  eq(C.topShiftCheck(base, outside).ok, true, "outside [data-legacy] (the frame) is not counted:");
});

await t("shell: drill:shell runs the roles store, adds the annex, then the drill; it is in drill:all", async () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  eq(scripts["drill:shell"], "node scripts/drills/run-isolated.mjs shell", "drill:shell:");
  const spec = R.DRILLS.shell;
  eq(`${spec?.id} ${spec?.warm}`, "SHELL true", "id and warm:");
  ok(R.ALL.includes("shell"), "in ALL:");
  const calls = [];
  const src = readFileSync(join(ROOT, "scripts/drills/run-isolated.mjs"), "utf8");
  ok(/shell: \{[\s\S]*?withRolesStore\(c, async \(\) => \{[\s\S]*?"scripts\/dev-roles\.js", "annex"[\s\S]*?"scripts\/drills\/shell\/run\.mjs"/.test(src), "inside withRolesStore: annex, then the drill:");
  const c = { worktree: "/w", env: {}, ports: { rolesNext: 6101 }, log: [], headed: [], node: async (args) => (calls.push(args.join(" ")), args.includes("annex") ? 3 : 0) };
  // a failing annex stops before the drill (exercised through the helper with stand-ins)
  const run = (fn) => R.withRolesStore(c, fn, { start: () => ({ child: {}, stop: async () => {} }), up: async () => true });
  eq(await run(async () => {
    const annex = await c.node(["scripts/dev-roles.js", "annex"]);
    return annex !== 0 ? annex : c.node(["scripts/drills/shell/run.mjs"]);
  }), 3, "a failed annex fails the drill:");
  ok(!calls.includes("scripts/drills/shell/run.mjs"), "and the drill is not run:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
