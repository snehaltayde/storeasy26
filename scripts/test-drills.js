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
//   6. the drill helpers' own checks (p4, p5 and p6 lib.mjs --check)
//   7. every module the seed and drill scripts load (static and import("…")
//      relative paths, followed through scripts/) exists, and each name taken
//      from an import("…") is exported there, so a deleted module or export
//      fails pnpm test instead of the next seed
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

await t("p5 and p6 keep exactly the planned stages (no legacy, baseline-legacy, f or final)", async () => {
  const p5 = await import("./drills/p5/run.mjs");
  eq(p5.STAGES.join(","), "pick,create,states,nosaving,disabled,grid,cart,console,unknown", "p5:");
  const p6 = await import("./drills/p6/run.mjs");
  eq(p6.STAGES.join(","), "baseline,a,b,c,d,e,g", "p6:");
  const seed = await import("./drills/p6/seed-p6.mjs");
  eq(seed.P6_STAGES.join(","), "a,b,c,d,e,g", "seed-p6 P6_STAGES:");
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
  const p = await R.choosePorts({ isBusy: async (n) => (asked.push(n), busy.has(n)) });
  eq(JSON.stringify(p), JSON.stringify({ next: 6110, sqld: 7110, rolesNext: 6111, rolesSqld: 7113 }), "block:");
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
    await new Promise((r) => setTimeout(r, 300));
    let calls = 0;
    const running = (dir) => (dir.endsWith(".design-data") && calls++ < 3 ? { launcher: { pid: child.pid } } : null);
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

await t("the drill helpers' own checks pass (p4, p5 and p6 lib.mjs --check; p6 carries the old final stage's selfCheck)", async () => {
  for (const lib of ["p4", "p5", "p6"]) {
    const r = spawnSync(process.execPath, [`scripts/drills/${lib}/lib.mjs`, "--check"], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 60_000 });
    eq(r.status, 0, `${lib} --check: ${r.stdout}${r.stderr}`);
  }
});

await t("every module the seed and drill scripts load exists, with the names they take (seed:design, --p3, --p6, seed:roles, the drills)", async () => {
  const entries = ["scripts/seed-design-preview.js", "scripts/seed-design-documents.js", "scripts/perf-docs-fixture.js", "scripts/dev-design.js", "scripts/dev-roles.js", "scripts/seed-roles.js", "scripts/drill.js", "scripts/drills/run-isolated.mjs", "scripts/drills/smoke.js", "scripts/drills/agency-gone.mjs", "scripts/drills/p5/run.mjs", "scripts/drills/p5/blocks.mjs", "scripts/drills/p6/run.mjs", "scripts/drills/p6/seed-p6.mjs", "scripts/drills/p6/generate.mjs", "scripts/drills/p6/brand.mjs", "scripts/drills/p6/open.mjs", "scripts/drills/p6/empty.mjs", "scripts/drills/p6/setup.mjs", "scripts/drill-maintenance-edge.js", "scripts/perf-report.js"];
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
