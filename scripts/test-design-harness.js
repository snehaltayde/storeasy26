// The design harness and the browser runner (P1-HARNESS, spec 8.15).
//   node scripts/test-design-harness.js          (pnpm test:design-harness)
//
// Needs no sqld, no Chrome and no network. The harness's process handling runs
// for real, in a child process, with stand-ins for sqld, the seed and Next
// (small node scripts that record what they were given). The real sqld, Next
// on the edge runtime and Chrome are exercised by `pnpm drill:edge` and
// `pnpm drill:smoke`, which are drills, not test suites.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const H = await import("./design-harness.js");
const D = await import("./drill.js");

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
const ok = (v, msg) => {
  if (!v) throw new Error(msg || "expected true");
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || "values differ"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const throwsPlain = (fn, includes) => {
  try {
    fn();
  } catch (e) {
    ok(e instanceof H.HarnessError || e instanceof D.DrillError, `expected a plain HarnessError/DrillError, got ${e?.name}: ${e?.message}`);
    for (const s of [].concat(includes)) ok(e.message.includes(s), `message should say "${s}": ${e.message}`);
    return e;
  }
  throw new Error("expected it to refuse, but it did not");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn, label, ms = 15_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const work = mkdtempSync(join(tmpdir(), "design-harness-test-"));

// ---------------------------------------------------------------------------
// Ports, lookup and env: pure functions
// ---------------------------------------------------------------------------

await t("ports default to today's 3017 for Next, and three database ports from 18017", () => {
  eq(H.harnessPorts({}), { next: 3017, sqld: { platform: 18017, tenant: 18018, default: 18019 } }, "ports");
});

await t("DESIGN_PORT and DESIGN_SQLD_PORT move every port", () => {
  eq(H.harnessPorts({ DESIGN_PORT: "3027", DESIGN_SQLD_PORT: "18080" }), { next: 3027, sqld: { platform: 18080, tenant: 18081, default: 18082 } }, "ports");
});

await t("NEGATIVE: a port that isn't a number, or is out of range, is refused in plain words", () => {
  throwsPlain(() => H.harnessPorts({ DESIGN_PORT: "abc" }), ["DESIGN_PORT must be a port number", '"abc"']);
  throwsPlain(() => H.harnessPorts({ DESIGN_PORT: "80" }), "from 1024 to 65535");
  throwsPlain(() => H.harnessPorts({ DESIGN_SQLD_PORT: "65535" }), "too high");
});

await t("NEGATIVE: a web port inside the database ports is refused", () => {
  throwsPlain(() => H.harnessPorts({ DESIGN_PORT: "18081", DESIGN_SQLD_PORT: "18080" }), "Pick ports that don't overlap");
});

const fakeFs = (files) => (p) => files.includes(p);
await t("sqld is found through SQLD_BIN first", () => {
  const r = H.findSqld({ env: { SQLD_BIN: "/opt/x/sqld", PATH: "/usr/bin" }, home: "/home/a", exists: fakeFs(["/opt/x/sqld", "/usr/bin/sqld", "/home/a/.turso/sqld"]) });
  eq(r, { bin: "/opt/x/sqld", from: "SQLD_BIN" }, "found");
});

await t("then PATH, in PATH order", () => {
  const r = H.findSqld({ env: { PATH: "/a:/b:/c" }, home: "/home/a", exists: fakeFs(["/b/sqld", "/c/sqld", "/home/a/.turso/sqld"]) });
  eq(r, { bin: "/b/sqld", from: "PATH" }, "found");
});

await t("then ~/.turso/sqld", () => {
  const r = H.findSqld({ env: { PATH: "/a" }, home: "/home/a", exists: fakeFs(["/home/a/.turso/sqld"]) });
  eq(r, { bin: "/home/a/.turso/sqld", from: "~/.turso/sqld" }, "found");
});

await t("NEGATIVE: sqld missing everywhere fails with a plain message that says how to fix it", () => {
  const e = throwsPlain(() => H.findSqld({ env: { PATH: "/a" }, home: "/home/a", exists: () => false }), ["needs sqld", "isn't installed", "SQLD_BIN"]);
  ok(!/at |Error:/.test(e.message), "no stack or jargon in the message");
});

await t("NEGATIVE: SQLD_BIN pointing at nothing is reported, not silently skipped", () => {
  throwsPlain(() => H.findSqld({ env: { SQLD_BIN: "/nope/sqld", PATH: "/a" }, home: "/home/a", exists: fakeFs(["/a/sqld"]) }), ["SQLD_BIN is set to /nope/sqld", "no file there"]);
});

// The bug: the harness gave the edge runtime file: URLs, which its libSQL
// client can't open, so every storefront page failed ("control plane unavailable").
await t("THE BUG: Next is never handed a file: database URL; every database is a local http server", () => {
  const env = H.harnessEnv({ PATH: "/usr/bin" }, { DESIGN_ADMIN_PASSWORD: "x" }, H.harnessPorts({}));
  for (const name of ["DATABASE_URL", "PLATFORM_DB_URL", "DESIGN_TENANT_DB_URL"]) {
    ok(!String(env[name]).startsWith("file:"), `${name} is a file: URL (${env[name]}), which the edge runtime can't open`);
    ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(env[name]), `${name} should be http://127.0.0.1:<port>, got ${env[name]}`);
  }
  eq([env.PLATFORM_DB_URL, env.DESIGN_TENANT_DB_URL, env.DATABASE_URL], ["http://127.0.0.1:18017", "http://127.0.0.1:18018", "http://127.0.0.1:18019"], "one server per database");
  eq(env.TURSO_DB_URL, "", "TURSO_DB_URL would win over DATABASE_URL in lib/db.js, so it must be empty");
});

await t("hosted values from the shell or .env.local are blanked, and Next keeps an empty value over .env.local", () => {
  const shell = {
    TURSO_DB_URL: "libsql://real.example.invalid",
    TURSO_DB_AUTH_TOKEN: "tok",
    RAZORPAY_KEY_SECRET: "live",
    NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_live",
    SHOPIFY_STORE_DOMAIN: "real.myshopify.com",
    TYPESENSE_HOST: "ts.example",
    RESEND_API_KEY: "re_live",
    COOKIE_DOMAIN: ".storeasy.in",
    PATH: "/usr/bin",
  };
  const env = H.harnessEnv(shell, {}, H.harnessPorts({ DESIGN_PORT: "3027" }));
  for (const k of Object.keys(shell).filter((k) => k !== "PATH")) eq(env[k], "", `${k} must be blanked`);
  eq(env.PATH, "/usr/bin", "PATH passes through");
  eq(env.NEXT_PUBLIC_SITE_URL, "http://localhost:3027", "site URL is the harness");
  eq(env.PORT, "3027", "PORT");
  // @next/env only fills a key from .env files when process.env doesn't have
  // it at all, so the blanks above hold against .env.local. Pinned here
  // because the harness relies on it.
  const nextEnvFile = createRequire(realpathSync(join(ROOT, "node_modules/next/package.json"))).resolve("@next/env");
  const src = readFileSync(nextEnvFile, "utf8");
  ok(/if\(typeof \w+\[\w+\]==="undefined"&&typeof \w+\[\w+\]==="undefined"\)\{\w+\[\w+\]=/.test(src), `${nextEnvFile}: @next/env no longer keeps a preset (even empty) value over .env.local; re-check BLANKED_ENV`);
});

// Pinned here on purpose, apart from BLANKED_ENV: dropping a name from that
// list (or moving it to KEPT_ENV) must turn this suite red.
const MUST_BLANK = [
  "TURSO_DB_URL", "TURSO_DB_AUTH_TOKEN", "DATABASE_AUTH_TOKEN", "TURSO_API_TOKEN", "TURSO_ORG", "TURSO_GROUP",
  "RESEND_API_KEY",
  "TYPESENSE_HOST", "TYPESENSE_PORT", "TYPESENSE_PROTOCOL", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION",
  "SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_STOREFRONT_TOKEN", "SHOPIFY_STOREFRONT_PRIVATE_TOKEN", "NEXT_PUBLIC_SHOPIFY_DOMAIN",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "PLATFORM_RAZORPAY_KEY_ID", "PLATFORM_RAZORPAY_KEY_SECRET", "PLATFORM_RAZORPAY_WEBHOOK_SECRET",
  "ALERT_WEBHOOK_URL", "GA4_API_SECRET", "META_CAPI_TOKEN", "META_TEST_EVENT_CODE", "NEXT_PUBLIC_GA4_MEASUREMENT_ID", "NEXT_PUBLIC_META_PIXEL_ID",
  "COOKIE_DOMAIN", "PLATFORM_URL", "PLATFORM_SECRET_NEXT", "VERCEL_URL", "PLATFORM_SITE_HOSTS",
];

await t("every hosted key is blanked even when the shell and .env.local set it, and the database token too", () => {
  const shell = Object.fromEntries([...MUST_BLANK, "PLATFORM_DB_TOKEN"].map((k) => [k, `real-${k}`]));
  const env = H.harnessEnv({ ...shell, PATH: "/usr/bin" }, {}, H.harnessPorts({}));
  const leaked = [...MUST_BLANK, "PLATFORM_DB_TOKEN"].filter((k) => env[k] !== "");
  eq(leaked, [], "names that still carry a value into the harness");
});

await t("NEGATIVE: every variable the app reads, or .env.example lists, is either blanked, set by the harness or kept on purpose", () => {
  const names = new Set();
  const scan = (dir) => {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true })) {
      if (!/\.(m?js|jsx)$/.test(f)) continue;
      for (const m of readFileSync(join(ROOT, dir, f), "utf8").matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
    }
  };
  for (const dir of ["app", "lib", "components"]) scan(dir);
  for (const m of readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^([A-Z][A-Z0-9_]+)=/gm)) names.add(m[1]);
  ok(names.size > 30, `the scan found only ${names.size} names; is it still reading the app?`);
  const setByHarness = Object.keys(H.harnessEnv({}, { DESIGN_ADMIN_PASSWORD: "x", PLATFORM_ADMIN_PASSWORD: "y" }, H.harnessPorts({})));
  const known = new Set([...H.BLANKED_ENV, ...H.KEPT_ENV, ...setByHarness]);
  eq([...names].filter((n) => !known.has(n)).sort(), [], "not classified: add each to BLANKED_ENV (reaches something hosted) or KEPT_ENV (safe to pass) in scripts/design-harness.js");
  eq(H.KEPT_ENV.filter((n) => MUST_BLANK.includes(n)), [], "a hosted key is in KEPT_ENV");
});

await t("NEGATIVE: the seed writes only to a local harness database", () => {
  eq(H.assertLocalDbUrl("X", "http://127.0.0.1:18018"), "http://127.0.0.1:18018", "local accepted");
  for (const url of ["libsql://shop.example.invalid", "https://shop.example.invalid", "file:.design-tenant.db", "http://10.0.0.5:8080", "http://127.0.0.1"]) {
    throwsPlain(() => H.assertLocalDbUrl("DESIGN_TENANT_DB_URL", url), "must point at a local harness database");
  }
  throwsPlain(() => H.assertLocalDbUrl("DATABASE_URL", undefined), ["DATABASE_URL is missing", "pnpm seed:design"]);
});

await t("NEGATIVE: the real seed script refuses a hosted URL in any of its three database settings before opening any database, and never prints the full URL", () => {
  // Ports 1 to 3: local in form, but nothing listens there, so even a broken
  // check can't write into a harness running on the default ports.
  const local = { PLATFORM_DB_URL: "http://127.0.0.1:1", DESIGN_TENANT_DB_URL: "http://127.0.0.1:2", DATABASE_URL: "http://127.0.0.1:3" };
  for (const name of Object.keys(local)) {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/seed-design-preview.js")], {
      cwd: work,
      encoding: "utf8",
      env: { PATH: process.env.PATH, DESIGN_ADMIN_PASSWORD: "x", ...local, [name]: "libsql://shop.example.invalid?authToken=SECRET-TOKEN-VALUE" },
    });
    eq(r.status, 1, `${name}: exit code (stderr: ${r.stderr})`);
    ok(r.stderr.includes(`${name} must point at a local harness database`), `${name}: ${r.stderr}`);
    ok(!r.stderr.includes("SECRET-TOKEN-VALUE"), `${name}: the query string (where a token could sit) must not be printed`);
  }
  ok(!existsSync(join(work, "platform.db")), "nothing was opened");
});

await t("NEGATIVE: the seed run without the harness says how to run it", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/seed-design-preview.js")], { cwd: work, encoding: "utf8", env: { PATH: process.env.PATH, DESIGN_ADMIN_PASSWORD: "x" } });
  eq(r.status, 1, "exit code");
  ok(r.stderr.includes("pnpm seed:design"), r.stderr);
});

await t("new migrations since the last seed are noticed", () => {
  eq(H.newMigrations({ tenant: ["0001.sql"], platform: [] }, { tenant: ["0001.sql", "0002.sql"], platform: ["0001.sql"] }), ["tenant/0002.sql", "platform/0001.sql"], "added");
  eq(H.newMigrations({ tenant: ["0001.sql"] }, { tenant: ["0001.sql"] }), [], "none");
  ok(H.migrationNames(ROOT).tenant.includes("0017_cms_approvals.sql"), "reads the real migrations folder");
});

await t("no code edit: the storefront still declares the edge runtime, and the harness never touches app/", () => {
  ok(/^export const runtime = "edge";$/m.test(readFileSync(join(ROOT, "app/(storefront)/layout.js"), "utf8")), "app/(storefront)/layout.js must say runtime = \"edge\"");
  for (const f of ["scripts/design-harness.js", "scripts/dev-design.js", "scripts/seed-design-preview.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    ok(!/runtime\s*=\s*["']nodejs["']/.test(src), `${f} mentions a nodejs runtime flip`);
    ok(!/["'`][^"'`]*\bapp\/\(storefront\)/.test(src), `${f} names a storefront source file`);
  }
});

await t("the harness data folder and credentials are gitignored; screenshots are not", () => {
  const ignored = (p) => spawnSync("git", ["check-ignore", "-q", p], { cwd: ROOT }).status === 0;
  ok(ignored(".design-data/platform.sqld/dbs"), ".design-data/ must be ignored");
  ok(ignored(".design-env"), ".design-env must be ignored");
  ok(!ignored("docs/cms-reviews/drills/smoke/product-375.png"), "drill screenshots must be committable");
});

// ---------------------------------------------------------------------------
// The harness's processes, run for real with stand-ins
// ---------------------------------------------------------------------------

const fakes = join(work, "fakes");
mkdirSync(fakes, { recursive: true });
const FAKE_SQLD = join(fakes, "sqld");
writeFileSync(
  FAKE_SQLD,
  `#!/usr/bin/env node
// Stand-in for sqld: answers /health, records how it was started.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const [host, port] = arg("--http-listen-addr").split(":");
const dbPath = arg("--db-path");
fs.mkdirSync(dbPath, { recursive: true });
fs.writeFileSync(path.join(dbPath, "fake.json"), JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
if (process.env.FAKE_PIDS_FILE) fs.appendFileSync(process.env.FAKE_PIDS_FILE, process.pid + "\\n");
if (process.env.FAKE_SQLD_FAIL && dbPath.endsWith(process.env.FAKE_SQLD_FAIL)) { console.error("fake sqld: cannot open the database"); process.exit(3); }
http.createServer((req, res) => { res.writeHead(req.url === "/health" ? 200 : 404); res.end(); }).listen(Number(port), host);
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => process.exit(0));
`,
);
chmodSync(FAKE_SQLD, 0o755);
const FAKE_SEED = join(fakes, "seed.cjs");
writeFileSync(
  FAKE_SEED,
  `const fs = require("node:fs");
const pick = ["DATABASE_URL", "PLATFORM_DB_URL", "DESIGN_TENANT_DB_URL", "DESIGN_ADMIN_PASSWORD", "TURSO_DB_URL", "PORT"];
fs.appendFileSync(process.env.FAKE_LOG_DIR + "/seed.jsonl", JSON.stringify(Object.fromEntries(pick.map((k) => [k, process.env[k]]))) + "\\n");
process.exit(Number(process.env.FAKE_SEED_EXIT || 0));
`,
);
const FAKE_NEXT = join(fakes, "next.cjs");
writeFileSync(
  FAKE_NEXT,
  `const fs = require("node:fs");
const http = require("node:http");
const pick = ["DATABASE_URL", "PLATFORM_DB_URL", "DESIGN_TENANT_DB_URL", "NEXT_PUBLIC_SITE_URL", "PORT", "RAZORPAY_KEY_SECRET"];
fs.writeFileSync(process.env.FAKE_LOG_DIR + "/next.json", JSON.stringify({ pid: process.pid, env: Object.fromEntries(pick.map((k) => [k, process.env[k]])) }));
if (process.env.FAKE_PIDS_FILE) fs.appendFileSync(process.env.FAKE_PIDS_FILE, process.pid + "\\n");
http.createServer((req, res) => { res.writeHead(200); res.end("fake next"); }).listen(Number(process.env.PORT), "127.0.0.1");
if (process.env.FAKE_NEXT_EXIT) setTimeout(() => process.exit(Number(process.env.FAKE_NEXT_EXIT)), 300);
// FAKE_NEXT_SLOW_STOP: take that long to shut down, as real Next does.
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => setTimeout(() => process.exit(0), Number(process.env.FAKE_NEXT_SLOW_STOP || 0)));
`,
);
const WRAPPER = join(fakes, "design-harness-under-test.mjs");
writeFileSync(
  WRAPPER,
  `import { appendFileSync } from "node:fs";
const H = await import(${JSON.stringify(new URL("./design-harness.js", import.meta.url).href)});
const [mode, root] = process.argv.slice(2);
try {
  const code = await H.runHarness({
    mode,
    root,
    log: (m) => console.log(m),
    nextCmd: [process.execPath, [${JSON.stringify(FAKE_NEXT)}]],
    seedCmd: [process.execPath, [${JSON.stringify(FAKE_SEED)}]],
    repoint: async (urls) => appendFileSync(process.env.FAKE_LOG_DIR + "/repoint.jsonl", JSON.stringify(urls) + "\\n"),
  });
  process.exit(code);
} catch (e) {
  if (e instanceof H.HarnessError) { console.error("✗ " + e.message); process.exit(1); }
  throw e;
}
`,
);

const portFree = (port) =>
  new Promise((done) => {
    const s = net.createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
async function freePorts() {
  for (let i = 0; i < 200; i++) {
    const base = 30000 + Math.floor(Math.random() * 20000);
    const all = [base, base + 1, base + 2, base + 3];
    let free = true;
    for (const p of all) free = free && (await portFree(p));
    if (free) return { sqld: base, next: base + 3 };
  }
  throw new Error("no free ports");
}

// Everything a test starts is stopped at the end, even when a test fails half
// way, so a red run leaves no processes behind.
const wrappers = [];
const runDirs = [];
process.on("exit", () => killEverythingStarted());
const PIDS_FILE = join(work, "started-pids.txt"); // every stand-in appends its PID here
function killEverythingStarted() {
  const pids = new Set();
  for (const c of wrappers) if (c.exitCode === null && c.signalCode === null) pids.add(c.pid);
  try {
    for (const l of readFileSync(PIDS_FILE, "utf8").split("\n")) if (Number(l)) pids.add(Number(l));
  } catch {}
  for (const s of runDirs) {
    for (const k of ["platform", "tenant", "default"]) {
      try {
        pids.add(JSON.parse(readFileSync(join(s.dataDir, `${k}.sqld`, "fake.json"), "utf8")).pid);
      } catch {}
    }
    try {
      pids.add(JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8")).pid);
    } catch {}
    try {
      for (const x of JSON.parse(readFileSync(join(s.dataDir, "harness.pid.json"), "utf8")).sqld || []) pids.add(x.pid);
    } catch {}
  }
  for (const pid of pids) {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

let runN = 0;
async function setup({ migrations = ["0001_a.sql"] } = {}) {
  const dir = join(work, `run-${++runN}`);
  const root = join(dir, "root");
  const logs = join(dir, "logs");
  mkdirSync(join(root, "migrations", "tenant"), { recursive: true });
  mkdirSync(join(root, "migrations", "platform"), { recursive: true });
  for (const m of migrations) writeFileSync(join(root, "migrations", "tenant", m), "-- test");
  mkdirSync(logs, { recursive: true });
  const ports = await freePorts();
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    SQLD_BIN: FAKE_SQLD,
    DESIGN_PORT: String(ports.next),
    DESIGN_SQLD_PORT: String(ports.sqld),
    FAKE_LOG_DIR: logs,
    FAKE_PIDS_FILE: PIDS_FILE,
  };
  const s = { dir, root, logs, ports, env, dataDir: join(root, ".design-data") };
  runDirs.push(s);
  return s;
}

// relative: start the harness the way pnpm runs `node scripts/dev-design.js`,
// by a relative script name from its own folder, so its command line doesn't
// hold the absolute path that process.argv[1] has.
// group: the harness leads its own process group, so the test can send a
// signal to the whole group the way a terminal's Ctrl-C does.
function start(mode, s, extraEnv = {}, { relative = false, group = false } = {}) {
  const args = relative ? [WRAPPER.slice(fakes.length + 1), mode, s.root] : [WRAPPER, mode, s.root];
  const child = spawn(process.execPath, args, { cwd: relative ? fakes : undefined, env: { ...s.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: group });
  wrappers.push(child);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const done = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, done, output: () => out };
}
const sqldPids = (s) => ["platform", "tenant", "default"].map((k) => JSON.parse(readFileSync(join(s.dataDir, `${k}.sqld`, "fake.json"), "utf8")));
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const portOpen = (port) =>
  new Promise((done) => {
    const c = net.connect({ port, host: "127.0.0.1" });
    c.once("connect", () => (c.destroy(), done(true)));
    c.once("error", () => done(false));
  });

await t("seed: empties .design-data, starts one database server per database in it, seeds over http, then stops them all", async () => {
  const s = await setup();
  mkdirSync(join(s.dataDir, "tenant.sqld"), { recursive: true });
  writeFileSync(join(s.dataDir, "tenant.sqld", "old-data"), "from an earlier seed");
  const run = start("seed", s);
  const { code } = await run.done;
  eq(code, 0, `exit code\n${run.output()}`);
  const seeds = readJsonl(join(s.logs, "seed.jsonl"));
  eq(seeds.length, 1, "seed ran once");
  eq(seeds[0].PLATFORM_DB_URL, `http://127.0.0.1:${s.ports.sqld}`, "platform URL");
  eq(seeds[0].DESIGN_TENANT_DB_URL, `http://127.0.0.1:${s.ports.sqld + 1}`, "tenant URL");
  eq(seeds[0].DATABASE_URL, `http://127.0.0.1:${s.ports.sqld + 2}`, "default URL");
  eq(seeds[0].TURSO_DB_URL, "", "TURSO_DB_URL blank");
  ok(seeds[0].DESIGN_ADMIN_PASSWORD?.startsWith("design-"), "test credentials generated and passed");
  const servers = sqldPids(s);
  eq(servers.map((x) => x.argv[x.argv.indexOf("--http-listen-addr") + 1]), [0, 1, 2].map((i) => `127.0.0.1:${s.ports.sqld + i}`), "listen addresses");
  eq(servers.map((x) => x.argv[x.argv.indexOf("--db-path") + 1]), ["platform", "tenant", "default"].map((k) => join(s.dataDir, `${k}.sqld`)), "data paths");
  for (const x of servers) ok(!alive(x.pid), `database server ${x.pid} still running after the seed`);
  ok(existsSync(join(s.dataDir, "seeded.json")), "seeded.json written");
  ok(!existsSync(join(s.dataDir, "tenant.sqld", "old-data")), "old data must be gone: a seed starts fresh");
  ok(!existsSync(join(s.dataDir, "harness.pid.json")), "pid file removed");
  ok(existsSync(join(s.root, ".design-env")), "credentials file created");
});

await t("NEGATIVE: a failed seed says so plainly, stops the servers and leaves no seeded marker", async () => {
  const s = await setup();
  const run = start("seed", s, { FAKE_SEED_EXIT: "1" });
  const { code } = await run.done;
  eq(code, 1, "exit code");
  ok(run.output().includes("Seeding failed"), run.output());
  for (const x of sqldPids(s)) ok(!alive(x.pid), "server left running");
  ok(!existsSync(join(s.dataDir, "seeded.json")), "seeded.json must not exist");
});

async function startDev(s, extraEnv, opts) {
  const run = start("dev", s, extraEnv, opts);
  await until(async () => existsSync(join(s.logs, "next.json")) && (await portOpen(s.ports.next)), `the stand-in Next on ${s.ports.next}\n${run.output()}`);
  return run;
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  await t(`dev: Next gets http database URLs; ${signal} to the harness stops Next and every database server`, async () => {
    const s = await setup();
    const run = await startDev(s);
    const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
    eq(next.env.PLATFORM_DB_URL, `http://127.0.0.1:${s.ports.sqld}`, "platform URL");
    eq(next.env.DESIGN_TENANT_DB_URL, `http://127.0.0.1:${s.ports.sqld + 1}`, "tenant URL");
    eq(next.env.DATABASE_URL, `http://127.0.0.1:${s.ports.sqld + 2}`, "default URL");
    eq(next.env.PORT, String(s.ports.next), "PORT");
    eq(next.env.NEXT_PUBLIC_SITE_URL, `http://localhost:${s.ports.next}`, "site URL");
    ok(run.output().includes("no harness data yet"), "first start seeds first");
    eq(readJsonl(join(s.logs, "seed.jsonl")).length, 1, "seeded once");
    eq(readJsonl(join(s.logs, "repoint.jsonl")).at(-1)?.tenant, `http://127.0.0.1:${s.ports.sqld + 1}`, "tenant row pointed at this run");
    const servers = sqldPids(s);
    for (const x of servers) ok(alive(x.pid), "database server should be running");
    eq(JSON.parse(readFileSync(join(s.dataDir, "harness.pid.json"), "utf8")).sqld.map((x) => x.pid), servers.map((x) => x.pid), "pid file lists the servers");
    run.child.kill(signal);
    const { code } = await run.done;
    eq(code, 0, `exit code after ${signal}`);
    await until(() => !alive(next.pid) && servers.every((x) => !alive(x.pid)), "everything to stop", 10_000);
    ok(!(await portOpen(s.ports.next)), "web port closed");
    for (const i of [0, 1, 2]) ok(!(await portOpen(s.ports.sqld + i)), `database port ${s.ports.sqld + i} closed`);
    ok(!existsSync(join(s.dataDir, "harness.pid.json")), "pid file removed");
  });
}

// A terminal's Ctrl-C reaches every process in the group at once, so sqld
// exits on its own SIGINT at the same moment the harness starts stopping. That
// must read as a normal stop, not as "a database server stopped by itself".
await t("dev: a Ctrl-C to the whole process group stops everything, exits 0, and reports no database as stopped by itself", async () => {
  const s = await setup();
  const run = await startDev(s, {}, { group: true });
  const servers = sqldPids(s);
  const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  process.kill(-run.child.pid, "SIGINT");
  const { code } = await Promise.race([run.done, sleep(15_000).then(() => ({ code: "still running 15 seconds after Ctrl-C" }))]);
  eq(code, 0, `exit code\n${run.output()}`);
  ok(!run.output().includes("stopped by itself"), run.output());
  await until(() => !alive(next.pid) && servers.every((x) => !alive(x.pid)), "everything to stop", 10_000);
  ok(!existsSync(join(s.dataDir, "harness.pid.json")), "pid file left behind");
});

// Under pnpm a Ctrl-C arrives twice: from the terminal and passed on by pnpm.
// Seen on a real run: the second one killed the harness half way through
// stopping, and its pid file was left behind.
await t("dev: a second Ctrl-C while stopping doesn't cut the stop short", async () => {
  const s = await setup();
  const run = await startDev(s, { FAKE_NEXT_SLOW_STOP: "1500" });
  const servers = sqldPids(s);
  run.child.kill("SIGINT");
  await sleep(300); // the harness is now waiting for Next to shut down
  run.child.kill("SIGINT");
  const { code, signal } = await run.done;
  eq([code, signal], [0, null], "the harness should finish its own stop and exit 0");
  await until(() => servers.every((x) => !alive(x.pid)), "every database server to stop", 10_000);
  ok(!existsSync(join(s.dataDir, "harness.pid.json")), "pid file left behind");
});

await t("dev: when Next stops by itself, the harness stops the databases and exits with Next's code", async () => {
  const s = await setup();
  const run = start("dev", s, { FAKE_NEXT_EXIT: "7" });
  const { code } = await run.done;
  eq(code, 7, `exit code\n${run.output()}`);
  for (const x of sqldPids(s)) ok(!alive(x.pid), "server left running");
});

await t("dev: an existing seed is reused, and a new migration since then is pointed out", async () => {
  const s = await setup();
  eq((await start("seed", s).done).code, 0, "seed");
  writeFileSync(join(s.root, "migrations", "tenant", "0002_b.sql"), "-- new");
  const run = await startDev(s);
  ok(!run.output().includes("no harness data yet"), "should not seed again");
  eq(readJsonl(join(s.logs, "seed.jsonl")).length, 1, "seed ran only once");
  ok(run.output().includes("1 database change was added since the last seed (tenant/0002_b.sql)") && run.output().includes("pnpm seed:design"), run.output());
  run.child.kill("SIGTERM");
  await run.done;
});

await t("NEGATIVE: a second harness, or a seed, while one is running is refused and leaves the running one alone", async () => {
  const s = await setup();
  const first = await startDev(s);
  const servers = sqldPids(s);
  for (const mode of ["dev", "seed"]) {
    const second = start(mode, s);
    const { code } = await second.done;
    eq(code, 1, `${mode}: exit code`);
    ok(second.output().includes("already running") && second.output().includes("Ctrl-C"), second.output());
  }
  for (const x of servers) ok(alive(x.pid), "the running harness's servers were touched");
  ok(existsSync(join(s.dataDir, "seeded.json")), "the running harness's data was wiped");
  first.child.kill("SIGTERM");
  await first.done;
});

// The review's repro: under pnpm the launcher's command line is
// `node scripts/dev-design.js` (relative), the old check compared it with the
// absolute process.argv[1], decided nothing was running, and killed the
// running harness's sqld as "left over"; the seed then wiped its data.
await t("NEGATIVE: started the way pnpm starts it (a relative script name), a second harness or a seed is refused and the running one keeps working", async () => {
  const s = await setup();
  const first = await startDev(s, {}, { relative: true });
  const servers = sqldPids(s);
  const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  for (const [mode, relative] of [["seed", true], ["dev", true], ["seed", false], ["dev", false]]) {
    const second = start(mode, s, {}, { relative });
    const { code } = await second.done;
    eq(code, 1, `${mode} (${relative ? "relative" : "absolute"} name): exit code\n${second.output()}`);
    ok(second.output().includes("already running") && !second.output().includes("left over"), `${mode}: ${second.output()}`);
  }
  for (const x of servers) ok(alive(x.pid), `the running harness's database server ${x.pid} was stopped`);
  ok(alive(next.pid) && (await portOpen(s.ports.next)), "the running harness's Next was stopped");
  for (const i of [0, 1, 2]) ok(await portOpen(s.ports.sqld + i), `database port ${s.ports.sqld + i} closed under the running harness`);
  ok(existsSync(join(s.dataDir, "seeded.json")), "the running harness's data was wiped");
  eq(readJsonl(join(s.logs, "seed.jsonl")).length, 1, "only the first start seeded");
  ok(first.child.exitCode === null, `the first harness stopped:\n${first.output()}`);
  first.child.kill("SIGTERM");
  eq((await first.done).code, 0, "the first harness still stops cleanly");
});

await t("NEGATIVE: a pid file with no start times (an older harness) still never treats a live harness as left over", async () => {
  const s = await setup();
  mkdirSync(s.dataDir, { recursive: true });
  // A live process whose command line names the launcher script, and a "sqld" naming this data folder.
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "scripts/dev-design.js"], { stdio: "ignore" });
  const db = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(s.dataDir, "platform.sqld")], { stdio: "ignore" });
  wrappers.push(launcher, db);
  await sleep(200);
  writeFileSync(join(s.dataDir, "harness.pid.json"), JSON.stringify({ launcher: { pid: launcher.pid, script: "/elsewhere/scripts/dev-design.js" }, sqld: [{ key: "platform", pid: db.pid, port: s.ports.sqld }] }));
  try {
    const run = start("seed", s);
    eq((await run.done).code, 1, `exit code\n${run.output()}`);
    ok(run.output().includes("already running"), run.output());
    ok(alive(db.pid), "the live harness's database server was signalled");
    ok(H.runningHarness(s.dataDir), "runningHarness should see it");
    eq(await H.stopLeftovers(s.dataDir), [], "stopLeftovers must not stop anything while the harness runs");
    ok(alive(db.pid), "stopLeftovers signalled a live harness's server");
  } finally {
    launcher.kill("SIGKILL");
    db.kill("SIGKILL");
  }
});

// P1-FIX-C (review of round 1): `ps -o lstart=` prints local time. A seed run
// with another TZ read another start time for the running launcher, decided it
// was gone, and stopLeftovers deleted its pid file although it signalled
// nothing. With the pid file gone, a seed on other ports wiped .design-data
// under the running harness.
await t("NEGATIVE: a seed or a second dev run in another time zone is refused, and the running harness keeps its pid file, servers and data", async () => {
  const s = await setup();
  const first = await startDev(s, { TZ: "Asia/Kolkata" });
  const servers = sqldPids(s);
  const pidfile = readFileSync(join(s.dataDir, "harness.pid.json"), "utf8");
  const seeded = readFileSync(join(s.dataDir, "seeded.json"), "utf8");
  try {
    for (const [mode, tz] of [["seed", "UTC"], ["seed", "America/Los_Angeles"], ["dev", "UTC"]]) {
      const second = start(mode, s, { TZ: tz });
      eq((await second.done).code, 1, `${mode} with TZ=${tz}: exit code\n${second.output()}`);
      ok(second.output().includes("already running"), `${mode} with TZ=${tz}: ${second.output()}`);
      ok(existsSync(join(s.dataDir, "harness.pid.json")) && readFileSync(join(s.dataDir, "harness.pid.json"), "utf8") === pidfile, `${mode} with TZ=${tz}: the running harness's pid file was changed or deleted`);
    }
    // the step that wiped the data in the review: a seed on other ports
    const other = await freePorts();
    const away = start("seed", s, { TZ: "UTC", DESIGN_PORT: String(other.next), DESIGN_SQLD_PORT: String(other.sqld) });
    eq((await away.done).code, 1, `a seed on other ports: exit code\n${away.output()}`);
    ok(away.output().includes("already running"), away.output());
    eq(readFileSync(join(s.dataDir, "seeded.json"), "utf8"), seeded, "the running harness's data was re-seeded:");
    for (const x of servers) ok(alive(x.pid), `the running harness's database server ${x.pid} was stopped`);
    ok(first.child.exitCode === null, `the first harness stopped:\n${first.output()}`);
  } finally {
    first.child.kill("SIGTERM");
    await first.done;
  }
});

await t("NEGATIVE: a live launcher whose recorded start time doesn't match still counts as running; stopLeftovers keeps its pid file and signals nothing", async () => {
  const s = await setup();
  mkdirSync(s.dataDir, { recursive: true });
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "scripts/dev-design.js"], { stdio: "ignore" });
  const db = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(s.dataDir, "platform.sqld")], { stdio: "ignore" });
  wrappers.push(launcher, db);
  await sleep(200);
  const wrong = "Thu Jan  1 00:00:00 1970";
  writeFileSync(join(s.dataDir, "harness.pid.json"), JSON.stringify({ launcher: { pid: launcher.pid, started: wrong, script: "/elsewhere/scripts/dev-design.js" }, sqld: [{ key: "platform", pid: db.pid, started: wrong, port: s.ports.sqld }] }));
  try {
    eq(H.sameProcess({ pid: launcher.pid, started: wrong }), false, "the start time doesn't match:");
    ok(H.runningHarness(s.dataDir), "runningHarness should still see the live launcher");
    eq(await H.stopLeftovers(s.dataDir), [], "stopLeftovers stopped something:");
    ok(existsSync(join(s.dataDir, "harness.pid.json")), "stopLeftovers deleted the pid file of a live launcher");
    ok(alive(db.pid), "stopLeftovers signalled a live harness's server");
    // once that launcher is gone, the same pid file is a leftover again
    launcher.kill("SIGKILL");
    await until(() => !alive(launcher.pid), "the stand-in launcher to stop", 5_000);
    eq(H.runningHarness(s.dataDir), null, "a dead launcher:");
  } finally {
    launcher.kill("SIGKILL");
    db.kill("SIGKILL");
  }
});

await t("the pid file records each process with its start time, the ports and Next", async () => {
  const s = await setup();
  const run = await startDev(s);
  const info = JSON.parse(readFileSync(join(s.dataDir, "harness.pid.json"), "utf8"));
  const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  eq(info.launcher.pid, run.child.pid, "launcher pid");
  eq(info.next?.pid, next.pid, "Next pid");
  eq(info.ports, { next: s.ports.next, sqld: { platform: s.ports.sqld, tenant: s.ports.sqld + 1, default: s.ports.sqld + 2 } }, "ports");
  for (const x of [info.launcher, info.next, ...info.sqld]) ok(/\d{2}:\d{2}:\d{2}/.test(x.started || ""), `no start time for pid ${x.pid}: ${JSON.stringify(x)}`);
  eq(H.sameProcess(info.launcher), true, "the launcher is recognised as itself");
  eq(H.sameProcess({ pid: info.launcher.pid, started: "Thu Jan  1 00:00:00 1970" }), false, "the same PID with another start time is another process");
  run.child.kill("SIGTERM");
  await run.done;
});

await t("dev: a database server that stops by itself after startup stops the harness with a plain message", async () => {
  const s = await setup();
  const run = await startDev(s);
  const [platform, tenant, def] = sqldPids(s);
  const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  process.kill(tenant.pid, "SIGKILL");
  // Bounded: if the harness doesn't notice, fail here instead of hanging the suite.
  const { code } = await Promise.race([run.done, sleep(10_000).then(() => ({ code: "still running 10 seconds after its tenant database server died" }))]);
  eq(code, 1, `exit code\n${run.output()}`);
  ok(run.output().includes("The local database server for tenant stopped by itself") && run.output().includes("tenant.log") && run.output().includes("pnpm dev:design"), run.output());
  ok(!run.output().includes("    at "), "no stack trace");
  await until(() => !alive(next.pid) && !alive(platform.pid) && !alive(def.pid), "Next and the other database servers to stop", 10_000);
  ok(!existsSync(join(s.dataDir, "harness.pid.json")), "pid file left behind");
});

await t("Next and the servers left behind by a harness that was killed outright are stopped, by their recorded PID, on the next start", async () => {
  const s = await setup();
  const first = await startDev(s, {}, { relative: true });
  const servers = sqldPids(s);
  const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  first.child.kill("SIGKILL");
  await first.done;
  await sleep(300);
  ok(alive(next.pid) && (await portOpen(s.ports.next)), "a SIGKILLed harness can't stop its Next; it should be left over here");
  for (const x of servers) ok(alive(x.pid), "a SIGKILLed harness can't stop its servers; they should be left over here");
  rmSync(join(s.logs, "next.json")); // so startDev waits for the new Next, not the leftover one
  const again = await startDev(s);
  ok(again.output().includes(`stopped the web server left over from an earlier run (pid ${next.pid})`), again.output());
  ok(again.output().includes("stopped a local database server left over from an earlier run"), again.output());
  ok(!alive(next.pid), `leftover Next ${next.pid} still running`);
  for (const x of servers) ok(!alive(x.pid), `leftover server ${x.pid} still running`);
  const now = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  ok(now.pid !== next.pid && alive(now.pid), "the new harness runs its own Next on the same port");
  again.child.kill("SIGTERM");
  await again.done;
});

// P1-FIX-C: the start times are read in one time zone (UTC) whoever reads them,
// so what a killed harness left behind is still recognised from another TZ.
await t("the servers a killed harness left behind are recognised and stopped by a start in another time zone", async () => {
  const s = await setup();
  const first = await startDev(s, { TZ: "Asia/Kolkata" });
  const servers = sqldPids(s);
  const next = JSON.parse(readFileSync(join(s.logs, "next.json"), "utf8"));
  first.child.kill("SIGKILL");
  await first.done;
  await sleep(300);
  rmSync(join(s.logs, "next.json"));
  const again = await startDev(s, { TZ: "America/Los_Angeles" });
  try {
    ok(again.output().includes(`stopped the web server left over from an earlier run (pid ${next.pid})`), again.output());
    for (const x of servers) ok(!alive(x.pid), `leftover server ${x.pid} still running`);
    ok(!alive(next.pid), `leftover Next ${next.pid} still running`);
  } finally {
    again.child.kill("SIGTERM");
    await again.done;
  }
});

await t("NEGATIVE: a recorded PID that now belongs to some other program is never signalled", async () => {
  const s = await setup();
  mkdirSync(s.dataDir, { recursive: true });
  // A process that isn't this harness's sqld, sitting on a PID the pid file names
  // (what PID reuse after a reboot would look like), and a launcher that is gone.
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  wrappers.push(other);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(join(s.dataDir, "harness.pid.json"), JSON.stringify({ launcher: { pid: gone, script: WRAPPER }, sqld: [{ key: "platform", pid: other.pid, port: s.ports.sqld }] }));
  try {
    const { code } = await start("seed", s).done;
    eq(code, 0, "the seed still runs");
    await sleep(300);
    ok(alive(other.pid), "an unrelated process named in the pid file was killed");
  } finally {
    other.kill("SIGKILL");
  }
});

await t("NEGATIVE: sqld missing: plain message, nothing started, no data folder made", async () => {
  const s = await setup();
  const run = start("dev", s, { SQLD_BIN: "", PATH: "/usr/bin:/bin" });
  const { code } = await run.done;
  eq(code, 1, "exit code");
  ok(run.output().includes(H.MISSING_SQLD), run.output());
  ok(!run.output().includes("    at "), "no stack trace");
  ok(!existsSync(s.dataDir), "no data folder");
  ok(!existsSync(join(s.logs, "next.json")), "Next not started");
});

await t("NEGATIVE: a busy database port: plain message naming the port and the setting, nothing started", async () => {
  const s = await setup();
  const blocker = net.createServer().listen(s.ports.sqld + 1, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  try {
    const run = start("dev", s);
    const { code } = await run.done;
    eq(code, 1, "exit code");
    ok(run.output().includes(`Port ${s.ports.sqld + 1}, for the tenant database, is already in use`) && run.output().includes("DESIGN_SQLD_PORT"), run.output());
    ok(!existsSync(join(s.dataDir, "platform.sqld")), "no server started");
  } finally {
    blocker.close();
  }
});

await t("NEGATIVE: a busy web port stops dev with a plain message naming DESIGN_PORT; a seed doesn't need that port", async () => {
  const s = await setup();
  const blocker = net.createServer().listen(s.ports.next, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  try {
    const run = start("dev", s);
    const { code } = await run.done;
    eq(code, 1, "exit code");
    ok(run.output().includes(`Port ${s.ports.next}, for the web server, is already in use`) && run.output().includes("DESIGN_PORT"), run.output());
    ok(!existsSync(join(s.dataDir, "platform.sqld")), "no server started");
    const seed = start("seed", s);
    eq((await seed.done).code, 0, `seed with the web port busy\n${seed.output()}`);
  } finally {
    blocker.close();
  }
});

await t("NEGATIVE: a database server that dies while starting: plain message pointing at its log, the others stopped", async () => {
  const s = await setup();
  const run = start("seed", s, { FAKE_SQLD_FAIL: "tenant.sqld" });
  const { code } = await run.done;
  eq(code, 1, "exit code");
  ok(run.output().includes("The local database server for tenant stopped while starting") && run.output().includes("tenant.log"), run.output());
  ok(run.output().includes("fake sqld: cannot open the database"), "the log's last lines are shown");
  for (const k of ["platform", "default"]) {
    const x = JSON.parse(readFileSync(join(s.dataDir, `${k}.sqld`, "fake.json"), "utf8"));
    ok(!alive(x.pid), `${k} server left running`);
  }
  ok(!existsSync(join(s.logs, "seed.jsonl")), "the seed must not run");
});

// ---------------------------------------------------------------------------
// The browser runner (scripts/drill.js)
// ---------------------------------------------------------------------------

await t("drills use the installed Chrome: CHROME_BIN first, then the usual places, never a download", () => {
  eq(D.chromePath({ env: { CHROME_BIN: "/x/chrome" }, exists: fakeFs(["/x/chrome", D.CHROME_PATHS[0]]) }), "/x/chrome", "CHROME_BIN");
  eq(D.chromePath({ env: {}, exists: fakeFs([D.CHROME_PATHS[0], D.CHROME_PATHS[2]]) }), D.CHROME_PATHS[0], "first known place");
  throwsPlain(() => D.chromePath({ env: {}, exists: () => false }), ["need desktop Google Chrome", "never downloads"]);
  throwsPlain(() => D.chromePath({ env: { CHROME_BIN: "/nope" }, exists: fakeFs([D.CHROME_PATHS[0]]) }), "CHROME_BIN is set to /nope");
  const src = readFileSync(join(ROOT, "scripts/drill.js"), "utf8");
  ok(/chromium\.launch\(\{ executablePath: chromePath\(/.test(src), "the one launch passes executablePath");
  ok(!/playwright install|downloadBrowser|PLAYWRIGHT_BROWSERS_PATH/.test(src), "no browser download path");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  ok(/^\d+\.\d+\.\d+$/.test(pkg.devDependencies["playwright-core"] || ""), "playwright-core is an exact devDependency");
  ok(!pkg.dependencies["playwright-core"] && !pkg.devDependencies.playwright && !pkg.dependencies.playwright, "only playwright-core, as a devDependency (the playwright package downloads browsers)");
  eq([pkg.scripts["drill:smoke"], pkg.scripts["drill:edge"]], ["node scripts/drill.js smoke", "node scripts/drill.js harness-edge"], "drill scripts");
  ok(!Object.keys(pkg.scripts).some((k) => k.startsWith("test:") && pkg.scripts[k].includes("drill")), "drills are not test:* suites");
});

await t("NEGATIVE: a drill with no harness running says how to start one", async () => {
  const { next } = await freePorts();
  let err = null;
  try {
    await D.connectHarness({ env: { DESIGN_PORT: String(next) } });
  } catch (e) {
    err = e;
  }
  ok(err instanceof D.DrillError, `expected a DrillError, got ${err}`);
  ok(err.message.includes(`isn't running at http://localhost:${next}`) && err.message.includes(`DESIGN_PORT=${next} pnpm dev:design`) && err.message.includes("--start"), err.message);
});

const serveRobots = (port) =>
  new Promise((done) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end("User-agent: *");
    });
    server.listen(port, "127.0.0.1", () => done(server));
  });

await t("NEGATIVE: a drill never attaches to a server that isn't this checkout's harness (another checkout's, or another app)", async () => {
  const { next } = await freePorts();
  const server = await serveRobots(next);
  const root = join(work, "attach-foreign");
  mkdirSync(root, { recursive: true });
  try {
    for (const start of [false, true]) {
      let err = null;
      try {
        await D.connectHarness({ env: { DESIGN_PORT: String(next) }, root, start, log: () => {} });
      } catch (e) {
        err = e;
      }
      ok(err instanceof D.DrillError, `start ${start}: expected a DrillError, got ${err}`);
      ok(err.message.includes(`Something is answering at http://localhost:${next}, but it isn't this checkout's design harness`), err.message);
    }
  } finally {
    server.close();
  }
});

await t("a drill attaches to this checkout's own running harness on that port", async () => {
  const { next } = await freePorts();
  const server = await serveRobots(next);
  const root = join(work, "attach-own");
  mkdirSync(join(root, ".design-data"), { recursive: true });
  writeFileSync(join(root, ".design-env"), "DESIGN_ADMIN_PASSWORD=design-test\n");
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  wrappers.push(launcher);
  await sleep(200);
  try {
    const pid = (port) => writeFileSync(join(root, ".design-data", "harness.pid.json"), JSON.stringify({ launcher: H.processStamp(launcher.pid), ports: { next: port } }));
    pid(next);
    const h = await D.connectHarness({ env: { DESIGN_PORT: String(next) }, root, log: () => {} });
    eq([h.baseUrl, h.started, h.creds.DESIGN_ADMIN_PASSWORD], [`http://localhost:${next}`, false, "design-test"], "attached");
    pid(next + 1); // this checkout's harness runs, but on another port
    const err = await D.connectHarness({ env: { DESIGN_PORT: String(next) }, root, log: () => {} }).catch((e) => e);
    ok(err instanceof D.DrillError && err.message.includes("isn't this checkout's design harness"), String(err?.message || err));
  } finally {
    launcher.kill("SIGKILL");
    server.close();
  }
});

// pageFacts runs inside Chrome; here it runs against a stand-in DOM, so the
// error-page and sideways-scroll facts every drill check rests on are covered
// without a browser.
await t("drill page facts: an error page, sideways scroll and broken images are noticed; a normal page is not flagged", () => {
  const run = ({ text = "", innerWidth = 375, scrollWidth = 375, images = [] }) => {
    const saved = ["document", "window", "location"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { body: { innerText: text }, title: "T", querySelectorAll: (sel) => (sel === "h1" ? [{ innerText: " Heading " }] : []), documentElement: { scrollWidth }, images },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth } });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname: "/p", search: "?q=1" } });
    try {
      return D.pageFacts();
    } finally {
      for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    }
  };
  const normal = run({ text: "Radiance Glow Serum ₹1,299" });
  eq([normal.errorPage, normal.overflowX, normal.path, normal.h1], [false, false, "/p?q=1", ["Heading"]], "normal page");
  for (const text of ["Something went wrong", "This page couldn’t load", "This page couldn't load", "Application error: a client-side exception"]) {
    ok(run({ text }).errorPage, `"${text}" should be an error page`);
  }
  eq(run({ scrollWidth: 376 }).overflowX, false, "1px of rounding is not sideways scroll");
  eq(run({ scrollWidth: 377 }).overflowX, true, "2px wider than the window is sideways scroll");
  eq(run({ innerWidth: 1440, scrollWidth: 1600 }).scrollWidth, 1600, "scroll width reported");
  const imgs = run({ images: [{ complete: true, naturalWidth: 0, currentSrc: "/broken.jpg" }, { complete: true, naturalWidth: 10, src: "/ok.jpg" }, { complete: false, naturalWidth: 0, src: "/loading.jpg" }] });
  eq([imgs.images, imgs.brokenImages], [3, ["/broken.jpg"]], "broken images");
});

await t("a known issue's check fails visibly without failing the drill, and says so when it starts passing", () => {
  const root = join(work, "known-root");
  const lines = [];
  const d = new D.Drill({ id: "known", harness: { baseUrl: "http://localhost:1" }, browser: { version: () => "test" }, root, log: (l) => lines.push(l) });
  d.check(true, "plain pass");
  d.check(false, "leaks content", "found 3", { known: "finding 5" });
  d.check(true, "fixed already", undefined, { known: "finding 9" });
  let res = d.finish();
  eq([res.passed, res.failed, res.knownFailures, d.failures.length], [2, 0, 1, 0], "counts");
  ok(lines.some((l) => l.startsWith("KNOWN leaks content") && l.includes("[finding 5]")), lines.join("\n"));
  ok(res.notes.some((n) => n.includes("finding 9 looks fixed")), JSON.stringify(res.notes));
  d.check(false, "a real failure");
  res = d.finish();
  eq([res.failed, d.failures.length], [1, 1], "an unmarked failure still fails");
});

await t("screenshots are scaled down until they fit in 300KB", async () => {
  const sharp = (await import("sharp")).default;
  const w = 1440;
  const h = 2400;
  const noise = randomBytes(w * h * 3); // the worst case: nothing to compress
  const raw = await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  ok(raw.length > D.MAX_SHOT_BYTES, `fixture should start over the limit (${raw.length})`);
  const out = await D.compressShot(raw);
  ok(out.length <= D.MAX_SHOT_BYTES, `compressed to ${out.length} bytes`);
  const meta = await sharp(out).metadata();
  ok(meta.width <= 720, `width ${meta.width}`);
  const small = await sharp({ create: { width: 375, height: 812, channels: 3, background: "#fff" } }).png().toBuffer();
  eq((await sharp(await D.compressShot(small)).metadata()).width, 375, "a phone-width shot is not enlarged");
});

await t("a drill writes into docs/cms-reviews/drills/<id>/, and a re-run removes only screenshots its earlier run made", async () => {
  const root = join(work, "drill-root");
  const dir = join(root, "docs", "cms-reviews", "drills", "unit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "someone-else.png"), "x");
  const fakeBrowser = { version: () => "test" };
  const page = (path) => ({ screenshot: async () => (await import("sharp")).default({ create: { width: 400, height: 300, channels: 3, background: "#eee" } }).png().toBuffer(), viewportSize: () => ({ width: 400, height: 300 }), url: () => `http://localhost:1${path}`, evaluate: async () => 300 });
  const first = new D.Drill({ id: "unit", harness: { baseUrl: "http://localhost:1" }, browser: fakeBrowser, root, log: () => {} });
  await first.shoot(page("/a"), "a");
  await first.shoot(page("/b"), "b");
  first.check(true, "fine");
  first.finish();
  const second = new D.Drill({ id: "unit", harness: { baseUrl: "http://localhost:1" }, browser: fakeBrowser, root, log: () => {} });
  await second.shoot(page("/a"), "a");
  second.check(false, "broken");
  const res = second.finish();
  ok(existsSync(join(dir, "a.png")) && !existsSync(join(dir, "b.png")), "b.png came from the earlier run and should be gone");
  ok(existsSync(join(dir, "someone-else.png")), "a file the drill didn't make was removed");
  const saved = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  eq([saved.passed, saved.failed, saved.screenshots.map((x) => x.file)], [0, 1, ["docs/cms-reviews/drills/unit/a.png"]], "results.json");
  eq(res.failed, 1, "returned results");
  throwsPlain(() => new D.Drill({ id: "../escape", harness: {}, browser: fakeBrowser, root }), "can only hold letters");
  let bad = null;
  await second.shoot(page("/x"), "../x").catch((e) => (bad = e));
  ok(bad instanceof D.DrillError, "a screenshot name with a path is refused");
});

// ---------------------------------------------------------------------------
killEverythingStarted();
rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
