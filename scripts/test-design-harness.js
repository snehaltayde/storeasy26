// Design harness suite, Phase 1 line 2 part (docs/plans/phase-1.md §6 item 11,
// §8 risks 2 and 5): the harness points the app at its own local Turso
// stand-in, and only there. Every Turso value it hands Next is loopback (a
// value from the shell or .env.local never wins), the API token is random per
// run, the stand-in's per-store sqld children are recorded in the pid file and
// stopped by their own handles, or after a kill -9 by their recorded pids,
// never by name or port. Everything runs in a temporary folder with its own
// ports; the owner's .design-data/ and .design-env are never touched, and a
// fetch guard fails on any host that is not loopback.
//   pnpm test:design-harness
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loopbackFetchGuard, startFakeTursoApi } from "./support/fake-turso-api.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = loopbackFetchGuard();
const H = await import("./design-harness.js");
const A = await import("../lib/platform/turso-api.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms = 10_000) => {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

// a hostile shell: every Turso value set to something real-looking
const HOSTILE = {
  TURSO_API_URL: "https://api.turso.tech",
  TURSO_API_TOKEN: "real-looking-platform-token",
  TURSO_ORG: "real-org",
  TURSO_GROUP: "real-group",
  TURSO_DB_URL: "libsql://real-db.turso.io",
  TURSO_DB_AUTH_TOKEN: "real-db-token",
};

await t("TURSO_API_URL, TURSO_API_TOKEN, TURSO_ORG and TURSO_GROUP are blanked before the harness sets its own", () => {
  for (const k of ["TURSO_API_URL", "TURSO_API_TOKEN", "TURSO_ORG", "TURSO_GROUP", "TURSO_DB_URL", "TURSO_DB_AUTH_TOKEN"]) ok(H.BLANKED_ENV.includes(k), k);
});

await t("ports: the Turso stand-in is DESIGN_SQLD_PORT + 3 and new stores start at + 10; both move with DESIGN_SQLD_PORT; overlaps and too-high values are refused", () => {
  const d = H.harnessPorts({});
  eq(`${d.turso},${d.storeBase}`, "18020,18027", "defaults");
  const m = H.harnessPorts({ DESIGN_SQLD_PORT: "40000" });
  eq(`${m.turso},${m.storeBase}`, "40003,40010", "moved");
  let err = null;
  try {
    H.harnessPorts({ DESIGN_SQLD_PORT: "40000", DESIGN_PORT: "40003" });
  } catch (e) {
    err = e;
  }
  ok(err instanceof H.HarnessError && /overlap/.test(err.message), `next on the stand-in's port: ${err?.message}`);
  err = null;
  try {
    H.harnessPorts({ DESIGN_SQLD_PORT: "65500" });
  } catch (e) {
    err = e;
  }
  ok(err instanceof H.HarnessError && /too high/.test(err.message), `too high: ${err?.message}`);
});

await t("THE RULE: whatever the shell or .env.local says, every Turso value handed to Next and the seed is loopback; the token is new each run; production refuses that address", () => {
  const ports = H.harnessPorts({ DESIGN_SQLD_PORT: "40000" });
  const a = H.harnessEnv(HOSTILE, { TURSO_API_URL: "https://api.turso.tech", TURSO_API_TOKEN: "from-env-file" }, ports);
  const b = H.harnessEnv(HOSTILE, {}, ports);
  eq(a.TURSO_API_URL, "http://127.0.0.1:40003", "the stand-in");
  ok(A.isLoopbackUrl(a.TURSO_API_URL), "loopback");
  eq(A.tursoApiBase(a), "http://127.0.0.1:40003", "the client accepts it outside production");
  let err = null;
  try {
    A.tursoApiBase({ ...a, NODE_ENV: "production" });
  } catch (e) {
    err = e;
  }
  ok(err && /production/.test(err.message), "production would refuse it");
  ok(/^[0-9a-f]{48}$/.test(a.TURSO_API_TOKEN) && a.TURSO_API_TOKEN !== b.TURSO_API_TOKEN, "random per run");
  ok(![HOSTILE.TURSO_API_TOKEN, "from-env-file"].includes(a.TURSO_API_TOKEN), "never the shell's token");
  eq(a.TURSO_ORG, "local-fake", "org");
  eq(a.TURSO_GROUP, "default", "group");
  eq(a.TURSO_DB_URL, "", "TURSO_DB_URL blank");
  eq(a.TURSO_DB_AUTH_TOKEN, "", "TURSO_DB_AUTH_TOKEN blank");
  for (const [k, v] of Object.entries(a)) {
    if (!/turso|_DB_URL$|DATABASE_URL/i.test(k) || !v || !/^[a-z]+:\/\//i.test(v)) continue;
    ok(A.isLoopbackUrl(v), `${k}=${v} is not loopback`);
  }
  ok(!Object.values(a).some((v) => /turso\.(tech|io)/.test(String(v))), "nothing names Turso's hosts");
  // an old pid file's ports (no turso entry) still give a loopback address
  const old = H.harnessEnv(HOSTILE, {}, { next: 3017, sqld: { platform: 18017, tenant: 18018, default: 18019 } });
  eq(old.TURSO_API_URL, "http://127.0.0.1:18020", "derived");
});

await t("every TURSO_* name in .env.example is blanked by the harness (and the ones the app needs are set by it)", () => {
  const names = [...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^(TURSO_[A-Z_]+)=/gm)].map((m) => m[1]);
  ok(names.includes("TURSO_API_URL") && names.includes("TURSO_API_TOKEN"), names.join());
  for (const n of names) ok(H.BLANKED_ENV.includes(n), `${n} is not blanked`);
});

// --- the stand-in's sqld children ----------------------------------------------------------
const SQLD = H.findSqld({ env: process.env }).bin;
const basePort = 41000 + Math.floor(Math.random() * 8000);

await t("a store sqld left by a killed harness is stopped by its recorded pid on the next start; a record whose start time doesn't match is never signalled", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storeasy-harness-left-"));
  const children = [];
  const fake = await startFakeTursoApi({ token: "t", dataDir, backend: "sqld", sqldBin: SQLD, storeBasePort: basePort, onChildren: (l) => children.splice(0, children.length, ...l) });
  let stray = null;
  try {
    await fake.addDatabase("storeasy-t-leftover");
    eq(children.length, 1, "one child reported");
    const pid = children[0].pid;
    ok(alive(pid), "running");
    // a process that names the data folder but isn't what the pid file says
    stray = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", dataDir], { stdio: "ignore" });
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.once("exit", r));
    H.writePidfile(dataDir, {
      launcher: { pid: dead.pid, started: "gone" },
      storeSqld: [{ key: "storeasy-t-leftover", ...H.processStamp(pid), port: children[0].port }, { key: "stray", pid: stray.pid, started: "Mon Jan  1 00:00:00 2001", port: 1 }],
    });
    const stopped = await H.stopLeftovers(dataDir);
    eq(stopped.join(), String(pid), "only the recorded sqld");
    ok(await waitGone(pid), "stopped");
    ok(alive(stray.pid), "the stray process was left alone");
    ok(!existsSync(join(dataDir, "harness.pid.json")), "pid file cleared");
  } finally {
    stray?.kill();
    await fake.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

await t("the stand-in refuses a non-loopback address to listen on", async () => {
  let err = null;
  await startFakeTursoApi({ token: "t", dataDir: tmpdir(), host: "0.0.0.0" }).catch((e) => (err = e));
  ok(err && /loopback/.test(err.message), err?.message);
});

await t("dev mode end to end (stub Next and seed, a temporary root): the stand-in runs on +3, a signup-style create gets its own sqld on +10, recorded in the pid file; stopping the harness stops it and clears the pid file", async () => {
  const root = mkdtempSync(join(tmpdir(), "storeasy-harness-dev-"));
  const sqldPort = basePort + 100;
  const out = join(root, "next-stub.json");
  const nextStub = join(root, "next-stub.mjs");
  writeFileSync(
    nextStub,
    `import { readFileSync, writeFileSync } from "node:fs";
const env = process.env;
const api = (path, init = {}) => fetch(env.TURSO_API_URL + "/v1/organizations/" + env.TURSO_ORG + path, { ...init, headers: { Authorization: "Bearer " + env.TURSO_API_TOKEN, "content-type": "application/json" } });
const made = await (await api("/databases", { method: "POST", body: JSON.stringify({ name: "storeasy-t-stub-shop", group: env.TURSO_GROUP }) })).json();
const health = await fetch(made.database.localUrl + "/health");
const pidfile = JSON.parse(readFileSync(${JSON.stringify(join(root, ".design-data", "harness.pid.json"))}, "utf8"));
const wrongToken = await fetch(env.TURSO_API_URL + "/v1/organizations/" + env.TURSO_ORG + "/databases", { headers: { Authorization: "Bearer nope" } });
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: { url: env.TURSO_API_URL, org: env.TURSO_ORG, tokenLength: env.TURSO_API_TOKEN.length, dbUrl: env.TURSO_DB_URL }, made, health: health.status, storeSqld: pidfile.storeSqld || [], wrongToken: wrongToken.status }));
`,
  );
  const logs = [];
  let code;
  try {
    code = await H.runHarness({
      mode: "dev",
      root,
      env: { ...process.env, ...HOSTILE, DESIGN_SQLD_PORT: String(sqldPort), DESIGN_PORT: String(sqldPort - 7) },
      log: (l) => logs.push(l),
      seedCmd: [process.execPath, ["-e", ""]],
      nextCmd: [process.execPath, [nextStub]],
      repoint: async () => {},
      script: "test-design-harness",
    });
    eq(code, 0, `exit ${code}: ${logs.join("\n")}`);
    const r = JSON.parse(readFileSync(out, "utf8"));
    eq(r.env.url, `http://127.0.0.1:${sqldPort + 3}`, "the stand-in's address");
    eq(`${r.env.org}:${r.env.tokenLength}:${r.env.dbUrl}`, "local-fake:48:", "org, a fresh token, no hosted database");
    eq(r.made.database.Name, "storeasy-t-stub-shop", "created");
    eq(r.made.database.localUrl, `http://127.0.0.1:${sqldPort + 10}`, "its own sqld on +10");
    eq(r.health, 200, "the store's sqld answers");
    eq(r.wrongToken, 401, "a wrong token is refused");
    eq(r.storeSqld.length, 1, "recorded in the pid file while running");
    ok(await waitGone(r.storeSqld[0].pid), "stopped with the harness");
    ok(!existsSync(join(root, ".design-data", "harness.pid.json")), "pid file cleared");
    ok(existsSync(join(root, ".design-data", "fake-turso", "registry.json")), "the registry is kept for the next start");
    ok(logs.some((l) => /Turso stand-in on/.test(l)), "says so");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await t("no call left this machine", () => {
  eq(guard.blocked.length, 0, guard.blocked.join(", "));
});

guard.restore();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
