// PERF-04: the local baseline. Real HTTP requests against a production build
// of the design harness (`next build`, then `next start`), storefront on the
// edge runtime, databases on local sqld, data from the perf fixture.
//
//   node scripts/dev-design.js seed --fixture perf      once, to seed
//   node scripts/perf-report.js http --build             build, then measure
//   node scripts/perf-report.js http                     measure an existing build
//   node scripts/perf-report.js check <run.json> --budget <file>
//
// Options for http: --runs N (warm runs per route, default 50), --warmup N
// (default 5), --count-runs N (default 5), --out DIR (default docs/perf),
// --budget FILE, --only key,key, --no-write.
//
// Three passes, each on its own `next start`:
//   counts  Next talks to the databases through counting proxies
//           (scripts/perf-dbcount.js), and sqld's own counters check them.
//   cold    a fresh `next start` per route, then one request.
//   warm    warm-up requests, then N rounds over every route in turn. Timing
//           runs never go through the counting proxies.
//
// Ports: DESIGN_PORT for Next; DESIGN_SQLD_PORT .. +2 for sqld, +3 .. +5 for
// sqld's admin API, +6 .. +8 for the counting proxies. Local only: nothing
// here reaches a hosted database, Shopify or any other service, and no budget
// is set from these numbers.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join, relative, resolve } from "node:path";
import zlib from "node:zlib";
import {
  DATABASES,
  DATA_DIR_NAME,
  HarnessError,
  ROOT,
  clearPidfile,
  ensureCredentials,
  findSqld,
  harnessEnv,
  harnessPorts,
  isPortBusy,
  migrationNames,
  newMigrations,
  pointTenantAtThisRun,
  processStamp,
  readSeeded,
  runningHarness,
  startSqld,
  stopChild,
  stopLeftovers,
  waitForHealth,
  writePidfile,
} from "./design-harness.js";
import { addCounts, emptyCounts, repeatedReads, sqldQueryCount, startCountingProxy } from "./perf-dbcount.js";
import { BudgetFileError, compareToBudget, readBudgetFile, summarize } from "./perf-budget.js";
import { buildPerfFixture } from "./perf-fixture.js";

const NEXT_BIN = join(ROOT, "node_modules/next/dist/bin/next");
const log = (m) => console.log(m);

// ---------------------------------------------------------------------------
// what gets measured
// ---------------------------------------------------------------------------

export function routesFor(measured) {
  const cartCookie = `cart_session=${measured.cart.id}`;
  const html = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  return [
    { key: "home", label: "Home", path: "/", headers: html, expect: ["Shop by category", "Top rated"] },
    { key: "product", label: "Product page", path: `/products/${measured.productHandle}`, headers: html, expect: [measured.productTitle, "Pairs well with"] },
    { key: "collection", label: "Collection page (one category)", path: `/collections/${measured.categoryCollection}`, headers: html, expect: [measured.categoryTitle] },
    { key: "collection-all", label: "Collection page (shop all, 400 products)", path: `/collections/${measured.allCollection}`, headers: html, expect: [measured.allTitle] },
    { key: "collections", label: "/collections", path: "/collections", headers: html, expect: [measured.allTitle, measured.categoryTitle] },
    { key: "search", label: "Search", path: `/search?q=${encodeURIComponent(measured.searchTerm)}`, headers: html, expect: ["Results for"] },
    { key: "cms-page", label: "CMS page (a policy)", path: `/policies/${measured.policySlug}`, headers: html, expect: [measured.policyTitle] },
    { key: "journal", label: "Journal index (60 posts)", path: "/journal", headers: html, expect: ["Journal"] },
    { key: "cart-get", label: "Cart API, read (3 lines)", path: "/api/cart", headers: { accept: "application/json", cookie: cartCookie }, json: (b) => Array.isArray(b.items) && b.items.length === measured.cart.lines.length },
    {
      key: "cart-update",
      label: "Cart API, change a quantity",
      method: "POST",
      path: "/api/cart",
      headers: { accept: "application/json", "content-type": "application/json", cookie: cartCookie },
      body: JSON.stringify({ action: "setQty", variantId: measured.cart.lines[0].variantId, quantity: measured.cart.lines[0].quantity }),
      json: (b) => Array.isArray(b.items) && b.items.length === measured.cart.lines.length,
    },
    { key: "checkout", label: "Checkout, first step", path: "/checkout", headers: { ...html, cookie: cartCookie }, expect: ["shipping address"] },
  ];
}

// ---------------------------------------------------------------------------
// one HTTP request, timed
// ---------------------------------------------------------------------------

const decode = (buf, enc) => {
  if (!enc) return buf;
  if (enc === "gzip") return zlib.gunzipSync(buf);
  if (enc === "br") return zlib.brotliDecompressSync(buf);
  if (enc === "deflate") return zlib.inflateSync(buf);
  if (enc === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  throw new Error(`unknown content-encoding ${enc}`);
};

export function timedRequest({ port, route, agent, n = 0 }) {
  return new Promise((resolve, reject) => {
    const headers = {
      host: `localhost:${port}`,
      "user-agent": "storeasy-perf/1 (PERF-04 local baseline)",
      "accept-encoding": "gzip, deflate, br",
      // Each request looks like its own shopper to the in-memory rate limiter
      // (60 cart changes a minute per address), as real traffic would.
      "x-forwarded-for": `10.77.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`,
      ...route.headers,
    };
    const t0 = performance.now();
    let ttfb = null;
    const req = http.request({ host: "127.0.0.1", port, method: route.method || "GET", path: route.path, headers, agent }, (res) => {
      ttfb = performance.now() - t0;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const total = performance.now() - t0;
        const wire = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"] || null;
        let body;
        try {
          body = decode(wire, enc);
        } catch (e) {
          return reject(e);
        }
        const headerBytes = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`.length + res.rawHeaders.reduce((s, x) => s + Buffer.byteLength(x) + 2, 0) + 2;
        resolve({ status: res.statusCode, headers: res.headers, ttfb, total, wireBytes: wire.length, decodedBytes: body.length, headerBytes, encoding: enc, text: body.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`no answer from ${route.path} within 60 seconds`)));
    req.end(route.body || undefined);
  });
}

// The page must be the real page, or its numbers mean nothing.
export function checkResponse(route, r) {
  if (r.status !== 200) return `${route.method || "GET"} ${route.path} answered ${r.status}, not 200`;
  if (/Something went wrong|This page couldn.t load|Application error/i.test(r.text) && !route.json) return `${route.path} answered the error page`;
  if (route.json) {
    let body;
    try {
      body = JSON.parse(r.text);
    } catch {
      return `${route.path} didn't answer JSON`;
    }
    if (!route.json(body)) return `${route.path} answered JSON that isn't the expected cart`;
  }
  for (const e of route.expect || []) {
    const html = e.replace(/&/g, "&amp;");
    if (!r.text.includes(e) && !r.text.includes(html)) return `${route.path} doesn't show "${e}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// processes
// ---------------------------------------------------------------------------

function startNext({ port, env }) {
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HarnessError(`next start didn't say it was ready within 60 seconds. Last lines:\n${lines.slice(-8).join("\n")}`)), 60_000);
    const onLine = (buf) => {
      for (const l of buf.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        lines.push(l);
        if (/Ready in|started server|Local:/.test(l)) {
          clearTimeout(timer);
          resolve();
        }
      }
    };
    child.stdout.on("data", onLine);
    child.stderr.on("data", (b) => lines.push(...b.toString("utf8").split("\n").filter(Boolean)));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new HarnessError(`next start stopped (exit ${code}) before it was ready. Last lines:\n${lines.slice(-8).join("\n")}`));
    });
  });
  return { child, ready, lines };
}

async function waitPortFree(port, ms = 15_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!(await isPortBusy(port)) && !(await isPortBusy(port, "::1"))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new HarnessError(`Port ${port} is still in use after stopping Next.`);
}

function machineInfo() {
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() || null;
  return {
    os: `${os.type()} ${os.release()}${process.platform === "darwin" ? ` (macOS ${sh("sw_vers", ["-productVersion"])})` : ""}`,
    cpu: process.platform === "darwin" ? sh("sysctl", ["-n", "machdep.cpu.brand_string"]) : os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    loadAverageAtStart: os.loadavg().map((x) => Math.round(x * 100) / 100),
  };
}

function gitInfo() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || null;
  const dirty = git(["status", "--porcelain", "--", "app", "lib", "components", "next.config.mjs", "package.json"]);
  return { commit: git(["rev-parse", "--short", "HEAD"]), appCodeChangedSinceCommit: Boolean(dirty) };
}

// Newest mtime among the files a build is made from.
function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of ["app", "lib", "components"]) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return newest;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { runs: 50, warmup: 5, countRuns: 5, out: "docs/perf", budget: null, only: null, build: false, write: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (argv[i + 1] == null) throw new HarnessError(`${a} needs a value.`);
      return argv[++i];
    };
    const int = (v, name) => {
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new HarnessError(`${name} must be a whole number of 1 or more.`);
      return Number(v);
    };
    if (a === "--runs") o.runs = int(next(), "--runs");
    else if (a === "--warmup") o.warmup = int(next(), "--warmup");
    else if (a === "--count-runs") o.countRuns = int(next(), "--count-runs");
    else if (a === "--out") o.out = next();
    else if (a === "--budget") o.budget = next();
    else if (a === "--only") o.only = next().split(",");
    else if (a === "--build") o.build = true;
    else if (a === "--no-write") o.write = false;
    else throw new HarnessError(`Unknown option "${a}" for http.`);
  }
  return o;
}

export async function runHttp(argv) {
  const opt = parseArgs(argv);
  const env = process.env;
  const ports = harnessPorts(env);
  const first = ports.sqld.platform;
  const admin = Object.fromEntries(DATABASES.map((d) => [d.key, first + 3 + d.offset]));
  const proxyPorts = Object.fromEntries(DATABASES.map((d) => [d.key, first + 6 + d.offset]));
  const sqld = findSqld({ env });
  const dataDir = join(ROOT, DATA_DIR_NAME);

  const other = runningHarness(dataDir);
  if (other) throw new HarnessError(`The design harness is running in this checkout (pid ${other.launcher.pid}). Stop it first: the report starts its own databases and server.`);
  await stopLeftovers(dataDir, log);
  const seeded = readSeeded(dataDir);
  if (seeded?.fixture !== "perf") throw new HarnessError("The harness data isn't the perf fixture. Seed it first: node scripts/dev-design.js seed --fixture perf");
  const added = newMigrations(seeded.migrations, migrationNames(ROOT));
  if (added.length) throw new HarnessError(`The harness data is older than the code (${added.join(", ")}). Seed again: node scripts/dev-design.js seed --fixture perf`);
  for (const p of [ports.next, ...Object.values(ports.sqld), ...Object.values(admin), ...Object.values(proxyPorts)]) {
    if (await isPortBusy(p)) throw new HarnessError(`Port ${p} is already in use. The report needs DESIGN_PORT and DESIGN_SQLD_PORT to DESIGN_SQLD_PORT+8 free.`);
  }

  const fileEnv = ensureCredentials(ROOT, log);
  const baseEnv = harnessEnv(env, fileEnv, ports);
  if (opt.build) {
    log("• next build (production), with the harness env");
    const r = spawnSync(process.execPath, [NEXT_BIN, "build"], { cwd: ROOT, env: baseEnv, stdio: "inherit" });
    if (r.status !== 0) throw new HarnessError("next build failed. See the output above.");
  }
  const buildIdFile = join(ROOT, ".next", "BUILD_ID");
  if (!existsSync(buildIdFile)) throw new HarnessError("There is no production build. Run with --build, or run next build with the harness env first.");
  const build = { id: readFileSync(buildIdFile, "utf8").trim(), builtAt: new Date(statSync(buildIdFile).mtimeMs).toISOString() };
  if (newestSource() > statSync(buildIdFile).mtimeMs) throw new HarnessError("The production build is older than the code in app/, lib/ or components/. Run again with --build.");

  const machineAtStart = machineInfo();
  const fx = buildPerfFixture();
  let routes = routesFor(fx.measured);
  if (opt.only) routes = routes.filter((r) => opt.only.includes(r.key));
  if (!routes.length) throw new HarnessError("--only matched no route.");

  const servers = [];
  const proxies = {};
  let next = null;
  const stopNext = async () => {
    if (!next) return;
    await stopChild(next.child, { graceMs: 10_000 });
    next = null;
    await waitPortFree(ports.next);
  };
  const cleanup = async () => {
    await stopNext().catch(() => {});
    for (const p of Object.values(proxies)) await p.close().catch(() => {});
    if (servers.length) await pointTenantAtThisRun({ platform: `http://127.0.0.1:${ports.sqld.platform}`, tenant: `http://127.0.0.1:${ports.sqld.tenant}` }).catch(() => {});
    await Promise.all(servers.map((s) => stopChild(s.child)));
    clearPidfile(dataDir);
  };
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    log("\n• stopping: Next, the proxies and the databases");
    cleanup().then(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // databases, recorded the way the harness records them
    for (const d of DATABASES) {
      servers.push(startSqld({ bin: sqld.bin, key: d.key, port: ports.sqld[d.key], dataDir, extraArgs: ["--admin-listen-addr", `127.0.0.1:${admin[d.key]}`] }));
    }
    const pidInfo = { launcher: { ...processStamp(process.pid), script: process.argv[1] || "" }, ports, sqld: servers.map((s) => ({ key: s.key, ...processStamp(s.child.pid), port: s.port })), startedAt: new Date().toISOString() };
    writePidfile(dataDir, pidInfo);
    for (const s of servers) await waitForHealth(s.url, s.child, { logFile: s.logFile, label: s.key });
    for (const d of DATABASES) {
      proxies[d.key] = startCountingProxy({ listenPort: proxyPorts[d.key], upstreamPort: ports.sqld[d.key] });
      await proxies[d.key].ready;
    }
    const direct = Object.fromEntries(DATABASES.map((d) => [d.key, `http://127.0.0.1:${ports.sqld[d.key]}`]));
    const counted = Object.fromEntries(DATABASES.map((d) => [d.key, proxies[d.key].url]));
    const fixtureSizes = await readFixtureSizes(direct.tenant);

    const launch = async (urls) => {
      await pointTenantAtThisRun({ platform: direct.platform, tenant: urls.tenant });
      next = startNext({ port: ports.next, env: { ...baseEnv, PLATFORM_DB_URL: urls.platform, DATABASE_URL: urls.default } });
      writePidfile(dataDir, { ...pidInfo, next: { ...processStamp(next.child.pid), port: ports.next, match: NEXT_BIN } });
      await next.ready;
    };
    const fail = (route, r) => {
      const why = checkResponse(route, r);
      if (why) throw new HarnessError(`Measurement stopped: ${why}. Numbers for a wrong page would mislead.`);
    };
    let n = 0;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // ---- pass 1: database reads, through the counting proxies ----------------
    log(`• pass 1 of 3: database reads per request (${opt.countRuns} counted runs per route, through counting proxies)`);
    await launch(counted);
    const takeAll = () => Object.fromEntries(DATABASES.map((d) => [d.key, proxies[d.key].take()]));
    const settleAll = async () => {
      for (const d of DATABASES) await proxies[d.key].settle();
    };
    const sqldCounts = async () => Object.fromEntries(await Promise.all(DATABASES.map(async (d) => [d.key, await sqldQueryCount(admin[d.key])])));
    const countOne = async (route) => {
      await settleAll();
      takeAll();
      const before = await sqldCounts();
      const r = await timedRequest({ port: ports.next, route, agent, n: n++ });
      fail(route, r);
      await settleAll();
      const after = await sqldCounts();
      const byDb = takeAll();
      const sqldDelta = Object.fromEntries(DATABASES.map((d) => [d.key, after[d.key].queries - before[d.key].queries]));
      return { byDb, sqldDelta };
    };
    const countsByRoute = {};
    for (const route of routes) {
      const firstReq = await countOne(route); // the first request this route's code has served
      await countOne(route); // one more, discarded
      const runs = [];
      for (let k = 0; k < opt.countRuns; k++) runs.push(await countOne(route));
      countsByRoute[route.key] = { first: firstReq, runs };
    }
    await stopNext();

    // ---- pass 2: cold ----------------------------------------------------------
    log("• pass 2 of 3: one cold request per route, each on a fresh next start");
    const cold = {};
    for (const route of routes) {
      await launch(direct);
      const r = await timedRequest({ port: ports.next, route, agent: false, n: n++ });
      fail(route, r);
      cold[route.key] = { ttfb: Math.round(r.ttfb * 10) / 10, total: Math.round(r.total * 10) / 10 };
      await stopNext();
    }

    // ---- pass 3: warm timing -----------------------------------------------------
    log(`• pass 3 of 3: ${opt.warmup} warm-up then ${opt.runs} timed runs per route, routes in turn`);
    await launch(direct);
    for (let w = 0; w < opt.warmup; w++) for (const route of routes) fail(route, await timedRequest({ port: ports.next, route, agent, n: n++ }));
    const samples = Object.fromEntries(routes.map((r) => [r.key, []]));
    for (let i = 0; i < opt.runs; i++) {
      for (const route of routes) {
        const r = await timedRequest({ port: ports.next, route, agent, n: n++ });
        fail(route, r);
        samples[route.key].push(r);
      }
    }
    // static files a first visit downloads (JS, CSS, fonts), once per page
    const assets = {};
    for (const route of routes.filter((r) => !r.json)) {
      const page = samples[route.key][0];
      const urls = [...new Set([...page.text.matchAll(/["'(](\/_next\/static\/[^"'()\s\\]+)/g)].map((m) => m[1]))];
      let wire = 0;
      let decoded = 0;
      let compressed = 0;
      for (const u of urls) {
        const a = await timedRequest({ port: ports.next, route: { path: u, headers: { accept: "*/*" } }, agent, n: n++ });
        if (a.status !== 200) continue;
        wire += a.wireBytes + a.headerBytes;
        decoded += a.decodedBytes;
        if (a.encoding) compressed++;
      }
      assets[route.key] = { files: urls.length, compressed, wire, decoded };
    }
    agent.destroy();
    await stopNext();

    // ---- results -------------------------------------------------------------------
    const results = routes.map((route) => {
      const s = samples[route.key];
      const c = countsByRoute[route.key];
      const flat = (byDb) => {
        const all = Object.values(byDb).reduce((acc, x) => addCounts(acc, x), emptyCounts());
        return {
          reads: all.statements.read,
          writes: all.statements.write,
          txStatements: all.statements.tx,
          statements: Object.values(all.statements).reduce((a, b) => a + b, 0),
          roundTrips: all.roundTrips,
          rowsRead: all.rowsRead,
          rowsReturned: all.rowsReturned,
          bytesDown: all.bytesDown,
          bytesDownDecoded: all.bytesDownDecoded,
          queryMs: Math.round(all.queryMs * 100) / 100,
          unparsed: all.unparsed,
          errors: all.errors,
          byDb: Object.fromEntries(
            Object.entries(byDb).map(([k, v]) => [k, { reads: v.statements.read, writes: v.statements.write, roundTrips: v.roundTrips, rowsRead: v.rowsRead, bytesDown: v.bytesDown }]),
          ),
          duplicateReads: repeatedReads(all).reduce((a, x) => a + x.times - 1, 0),
          shapes: all.shapes,
          shapeRows: all.shapeRows,
          duplicates: repeatedReads(all),
        };
      };
      const runs = c.runs.map((x) => flat(x.byDb));
      const mid = runs[Math.floor(runs.length / 2)];
      const sig = (x) => `${x.statements}/${x.roundTrips}/${x.reads}/${x.writes}`;
      const stable = runs.every((x) => sig(x) === sig(runs[0]));
      const sqldAgrees = c.runs.every((x) => DATABASES.every((d) => Object.values(x.byDb[d.key].statements).reduce((a, b) => a + b, 0) === x.sqldDelta[d.key]));
      const repeated = mid.duplicates.slice(0, 6);
      const top = Object.entries(mid.shapes)
        .map(([shape, times]) => ({ times, rowsRead: mid.shapeRows[shape] || 0, shape }))
        .sort((a, b) => b.rowsRead - a.rowsRead || b.times - a.times);
      const firstFlat = flat(c.first.byDb);
      for (const k of ["shapes", "shapeRows", "duplicates"]) delete firstFlat[k];
      const warm = { ...mid };
      for (const k of ["shapes", "shapeRows", "duplicates"]) delete warm[k];
      const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      return {
        key: route.key,
        label: route.label,
        method: route.method || "GET",
        path: route.path,
        status: s[0].status,
        contentType: String(s[0].headers["content-type"] || ""),
        contentEncoding: s[0].encoding,
        responseHeaders: Object.fromEntries(["content-type", "content-encoding", "cache-control", "transfer-encoding", "vary", "x-edge-runtime"].filter((h) => s[0].headers[h] != null).map((h) => [h, String(s[0].headers[h])])),
        ttfb: summarize(s.map((x) => x.ttfb)),
        total: summarize(s.map((x) => x.total)),
        cold: cold[route.key],
        bytes: {
          wire: median(s.map((x) => x.wireBytes)),
          decoded: median(s.map((x) => x.decodedBytes)),
          gzipEstimate: zlib.gzipSync(Buffer.from(s[0].text, "utf8")).length,
          headers: median(s.map((x) => x.headerBytes)),
          firstVisitStatic: assets[route.key] || null,
        },
        db: { warm, first: firstFlat, stableAcrossRuns: stable, sqldAgrees, repeatedStatements: repeated, statements: top },
      };
    });

    const run = {
      kind: "storeasy-perf-baseline",
      version: 1,
      takenAt: new Date().toISOString(),
      environment: {
        kind: "local",
        machine: machineAtStart,
        node: process.version,
        next: JSON.parse(readFileSync(join(ROOT, "node_modules/next/package.json"), "utf8")).version,
        sqld: spawnSync(sqld.bin, ["--version"], { encoding: "utf8" }).stdout?.trim() || null,
        git: gitInfo(),
        build: { ...build, how: "next build, then next start (production), the design harness env" },
        runtime: "storefront pages and /api/cart on the edge runtime (Next's local edge sandbox, not Vercel's)",
        databases: "local sqld over http://127.0.0.1, one per database (platform, tenant, env default)",
        platformCacheMs: Number(baseEnv.PLATFORM_CACHE_MS || 30_000),
      },
      fixture: { name: "perf", sizes: fixtureSizes, seededAt: seeded.at },
      method: {
        warmRuns: opt.runs,
        warmup: opt.warmup,
        countedRuns: opt.countRuns,
        order: "warm runs go round the routes in turn, one request at a time, over one kept-alive connection",
        cold: "a fresh next start per route, then that route's first request on a new connection",
        ttfb: "from sending the request to receiving the response headers",
        total: "from sending the request to the last byte of the body",
        percentile: "nearest rank (p95 of 50 runs is the 48th fastest)",
        bytes: "response body as sent (gzip when offered), median; headers counted apart; firstVisitStatic is the /_next/static files the HTML names, fetched once each",
        db: "counted on the wire by a proxy in front of each sqld (scripts/perf-dbcount.js) and checked against sqld's own query counter; warm = the middle counted run, first = the first request that route's code served after next start (collection-all shares its code with collection, and cart-update with cart-get, so theirs is already warm); rowsRead is sqld's own rows_read; bytesDown is the database's answers as sent (sqld gzips them when the client asks), bytesDownDecoded what the page had to parse",
        shopper: "no cookies except the cart cookie on the cart and checkout routes, so the home page sees a first-time visitor; each request carries its own x-forwarded-for",
      },
      notMeasured: [
        "Edge memory: Next's local edge sandbox runs inside one Node process, so no per-request or per-isolate memory figure exists locally. It needs the hosted runtime (OQ-19).",
        "Hosted latency: Turso and the hosted edge add network time between the page and its database; here every database call stays on this Mac.",
        "Images: product and page photos (/_next/image, /api/media) are not fetched.",
      ],
      budgets: "None. Budgets wait for hosted numbers (PERF-04, OQ-19). These local numbers are a baseline, not a budget.",
      routes: results,
    };
    run.candidatesForPerf06 = candidates(results);
    // Other work on the machine skews local numbers; say how busy it was.
    run.environment.machine.loadAverageAtEnd = os.loadavg().map((x) => Math.round(x * 100) / 100);

    if (opt.write) {
      const outDir = resolve(ROOT, opt.out);
      mkdirSync(outDir, { recursive: true });
      const stem = `${run.takenAt.slice(0, 10)}-local-baseline`;
      writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(run, null, 2)}\n`);
      writeFileSync(join(outDir, `${stem}.md`), markdown(run));
      log(`✓ wrote ${relative(ROOT, join(outDir, `${stem}.json`))} and ${stem}.md`);
    }
    printTable(run);
    if (opt.budget) return checkAgainst(run, opt.budget);
    return 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (!interrupted) await cleanup();
  }
}

async function readFixtureSizes(tenantUrl) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: tenantUrl });
  try {
    const out = {};
    for (const [k, sql] of [
      ["products", "SELECT count(*) n FROM products"],
      ["variants", "SELECT count(*) n FROM variants"],
      ["productImages", "SELECT count(*) n FROM product_images"],
      ["collections", "SELECT count(*) n FROM collections"],
      ["collectionMemberships", "SELECT count(*) n FROM collection_products"],
      ["contentPages", "SELECT count(*) n FROM cms_pages WHERE family = 'page'"],
      ["journalPosts", "SELECT count(*) n FROM cms_pages WHERE family = 'journal'"],
      ["campaigns", "SELECT count(*) n FROM cms_pages WHERE family = 'campaign'"],
      ["offers", "SELECT count(*) n FROM offers"],
      ["bundles", "SELECT count(*) n FROM bundles"],
      ["placements", "SELECT count(*) n FROM placements"],
      ["media", "SELECT count(*) n FROM media"],
      ["mediaBytes", "SELECT coalesce(sum(size), 0) n FROM media"],
      ["liveReleaseBytes", "SELECT length(r.content) n FROM releases r JOIN release_state s ON s.live_release_id = r.id"],
    ]) {
      try {
        out[k] = Number((await c.execute(sql)).rows[0]?.n ?? 0);
      } catch {
        out[k] = null;
      }
    }
    const home = await c.execute("SELECT value FROM cms_blocks WHERE key = 'home_sections'").catch(() => null);
    try {
      out.homeSections = JSON.parse(home?.rows?.[0]?.value || "[]").length;
    } catch {
      out.homeSections = null;
    }
    // A digest of the store's content, leaving out what a seed can't repeat
    // (timestamps, and ids the app mints at random: the demo's upsell, bundle
    // ids, release ids). Two seeds of the same fixture give the same digest.
    const hash = createHash("sha256");
    for (const sql of [
      "SELECT id, handle, title, description, description_html, product_type, tags, price_min, price_max, compare_at_min, available, featured_image, options FROM products ORDER BY id",
      "SELECT id, product_id, title, sku, price, compare_at_price, available, selected_options, position FROM variants ORDER BY id",
      "SELECT id, product_id, url, alt, position FROM product_images ORDER BY id",
      "SELECT id, handle, title, description, image FROM collections ORDER BY id",
      "SELECT collection_id, product_id, position FROM collection_products ORDER BY collection_id, product_id",
      "SELECT slug, title, description, sections, enabled, family, window_start, window_end FROM cms_pages ORDER BY slug",
      "SELECT key, value FROM cms_blocks WHERE key IN ('home_sections', 'nav_header', 'nav_footer', 'announcement') ORDER BY key",
      "SELECT id, type, label, enabled, config FROM offers WHERE id NOT LIKE 'bundle-%' ORDER BY id",
      "SELECT slug, title, items, bundle_price, enabled FROM bundles ORDER BY slug",
      "SELECT slug, title, questions FROM quizzes ORDER BY slug",
      "SELECT id, kind, source_product_id, target_product_ids, title, enabled FROM placements WHERE id LIKE 'pp-perf-%' OR id LIKE 'cu-perf-%' ORDER BY id",
      "SELECT product_id, modules, badge FROM product_overrides ORDER BY product_id",
      "SELECT collection_id, pinned FROM collection_overrides ORDER BY collection_id",
      "SELECT id, sha256, size FROM media ORDER BY id",
      "SELECT cart_id, variant_id, product_id FROM cart_items WHERE cart_id = 'perf-cart-1' ORDER BY variant_id",
    ]) {
      const r = await c.execute(sql);
      hash.update(sql);
      // section ids the app mints at random (the demo's shipping page) are left out
      hash.update(JSON.stringify(r.rows.map((row) => r.columns.map((k) => row[k]))).replace(/\\"id\\":\\"sec_[a-z0-9]+\\",?/g, ""));
    }
    out.contentDigest = hash.digest("hex").slice(0, 16);
    return out;
  } finally {
    c.close();
  }
}

// `node scripts/perf-report.js fixture`: the sizes and content digest of the
// seeded harness data, without measuring anything.
export async function runFixtureInfo() {
  const ports = harnessPorts(process.env);
  const sqld = findSqld({ env: process.env });
  const dataDir = join(ROOT, DATA_DIR_NAME);
  const other = runningHarness(dataDir);
  if (other) throw new HarnessError(`The design harness is running in this checkout (pid ${other.launcher.pid}). Stop it first.`);
  await stopLeftovers(dataDir, log);
  const seeded = readSeeded(dataDir);
  if (!seeded) throw new HarnessError("There is no harness data. Seed it first: node scripts/dev-design.js seed --fixture perf");
  if (await isPortBusy(ports.sqld.tenant)) throw new HarnessError(`Port ${ports.sqld.tenant} is already in use.`);
  const s = startSqld({ bin: sqld.bin, key: "tenant", port: ports.sqld.tenant, dataDir });
  try {
    await waitForHealth(s.url, s.child, { logFile: s.logFile, label: "tenant" });
    const sizes = await readFixtureSizes(s.url);
    log(JSON.stringify({ fixture: seeded.fixture, seededAt: seeded.at, sizes }, null, 2));
    return 0;
  } finally {
    await stopChild(s.child);
  }
}

export function candidates(results) {
  const by = (f) => [...results].sort((a, b) => f(b) - f(a));
  return {
    slowestWarm: by((r) => r.total?.p50 ?? 0)
      .slice(0, 3)
      .map((r) => ({ route: r.key, totalP50: r.total.p50, totalP95: r.total.p95 })),
    slowestCold: by((r) => r.cold?.total ?? 0)
      .slice(0, 3)
      .map((r) => ({ route: r.key, coldTotal: r.cold.total })),
    mostReads: by((r) => r.db.warm.reads)
      .slice(0, 3)
      .map((r) => ({ route: r.key, reads: r.db.warm.reads, roundTrips: r.db.warm.roundTrips, rowsRead: r.db.warm.rowsRead })),
    repeatedReads: results.filter((r) => r.db.repeatedStatements.length).map((r) => ({ route: r.key, repeated: r.db.repeatedStatements.slice(0, 4) })),
    mostRowsRead: by((r) => r.db.warm.rowsRead)
      .slice(0, 3)
      .map((r) => ({ route: r.key, rowsRead: r.db.warm.rowsRead, bytesFromDb: r.db.warm.bytesDown, bytesFromDbDecoded: r.db.warm.bytesDownDecoded, topStatement: r.db.statements[0] || null })),
  };
}

const kb = (b) => (b == null ? "–" : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

export function markdown(run) {
  const e = run.environment;
  const rows = run.routes.map(
    (r) =>
      `| ${r.label} | \`${r.method} ${r.path}\` | ${r.ttfb.p50} / ${r.ttfb.p95} | ${r.total.p50} / ${r.total.p95} | ${r.cold.ttfb} / ${r.cold.total} | ${kb(r.bytes.wire)}${r.contentEncoding ? ` ${r.contentEncoding}` : ""} | ${kb(r.bytes.gzipEstimate)} | ${r.bytes.firstVisitStatic ? kb(r.bytes.firstVisitStatic.wire) : "–"} | ${r.db.warm.reads} (${r.db.first.reads}) | ${r.db.warm.duplicateReads} | ${r.db.warm.roundTrips} | ${r.db.warm.rowsRead} | ${kb(r.db.warm.bytesDown)} (${kb(r.db.warm.bytesDownDecoded)}) |`,
  );
  const c = run.candidatesForPerf06;
  return `# Local baseline, ${run.takenAt.slice(0, 10)} (PERF-04)

**Local numbers, not budgets.** Taken on one Mac against a production build of the design harness. They are a starting point to compare against, nothing more. Budgets wait for hosted numbers (OQ-19). Edge memory is not measurable locally.

- Build: \`next build\` then \`next start\` (Next ${e.next}, build \`${e.build.id}\`), commit \`${e.git.commit}\`${e.git.appCodeChangedSinceCommit ? " with uncommitted app changes" : ""}. ${e.runtime}.
- Databases: ${e.databases}, ${e.sqld}.
- Machine: ${e.machine.cpu}, ${e.machine.cores} cores, ${e.machine.memoryGB} GB, ${e.machine.os}, Node ${e.node}. Load average (1, 5, 15 min) at start ${e.machine.loadAverageAtStart.join(", ")}, at end ${(e.machine.loadAverageAtEnd || []).join(", ")}: other work on this Mac shares the CPU, so treat small differences as noise.
- Fixture: perf. ${run.fixture.sizes.products} products, ${run.fixture.sizes.variants} variants, ${run.fixture.sizes.collections} collections, ${run.fixture.sizes.contentPages} pages, ${run.fixture.sizes.journalPosts} journal posts, ${run.fixture.sizes.homeSections} home sections, ${run.fixture.sizes.offers} offers, ${run.fixture.sizes.media} media files. Live release: ${kb(run.fixture.sizes.liveReleaseBytes)}.
- Runs: ${run.method.warmup} warm-up, then ${run.method.warmRuns} timed runs per route (routes in turn, one request at a time). Cold: ${run.method.cold}. Percentiles: ${run.method.percentile}. Reads: ${run.method.countedRuns} counted runs per route.

Times in milliseconds. "Sent" is the response body as this server sent it (local \`next start\` sent the edge-runtime responses uncompressed); "gzip est." is that body gzipped here, roughly what a compressing CDN would send. "First-visit JS/CSS" is the \`/_next/static\` files the page names, fetched once each, as sent. Reads are SQL reads per request on a warm server (the route's first request after start in brackets), over all three databases. "Repeated" counts reads that ran again with the same arguments in the same request. A round trip is one HTTP request from the page to a database. "Rows read" is sqld's own count of rows it looked at. "From DB" is the database's answers as sent (sqld gzipped them), with what the page had to parse in brackets.

| Page | Request | TTFB p50 / p95 | Total p50 / p95 | Cold TTFB / total | Sent | gzip est. | First-visit JS/CSS | Reads (first) | Repeated | Round trips | Rows read | From DB (parsed) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

**Candidates for PERF-06** (not fixed here):
- Slowest on a warm server: ${c.slowestWarm.map((x) => `${x.route} (${x.totalP50} ms p50)`).join(", ")}.
- Slowest cold: ${c.slowestCold.map((x) => `${x.route} (${x.coldTotal} ms)`).join(", ")}.
- Most reads: ${c.mostReads.map((x) => `${x.route} (${x.reads} reads, ${x.roundTrips} round trips)`).join(", ")}.
- Reads repeated with the same arguments in one request: ${c.repeatedReads.length ? c.repeatedReads.map((x) => `${x.route}: ${x.repeated.map((s) => `${s.times}× \`${s.shape.slice(0, 90)}\``).join("; ")}`).join(". ") : "none"}.
- Most rows read: ${c.mostRowsRead.map((x) => `${x.route} (${x.rowsRead} rows${x.topStatement ? `, most by \`${x.topStatement.shape.slice(0, 90)}\` at ${x.topStatement.rowsRead}` : ""})`).join(", ")}.
- Most parsed from the database per request: ${[...run.routes]
    .sort((a, b) => b.db.warm.bytesDownDecoded - a.db.warm.bytesDownDecoded)
    .slice(0, 3)
    .map((r) => `${r.key} (${kb(r.db.warm.bytesDownDecoded)}, ${kb(r.db.warm.bytesDown)} as sent)`)
    .join(", ")}.

Not measured: ${run.notMeasured.join(" ")}
`;
}

function printTable(run) {
  log("\n=== PERF-04 local baseline (not budgets) ===");
  for (const r of run.routes) {
    log(
      `${r.key.padEnd(15)} ttfb ${String(r.ttfb.p50).padStart(6)}/${String(r.ttfb.p95).padStart(6)}  total ${String(r.total.p50).padStart(6)}/${String(r.total.p95).padStart(6)}  cold ${String(r.cold.total).padStart(7)}  sent ${kb(r.bytes.wire).padStart(9)}  reads ${String(r.db.warm.reads).padStart(3)} (first ${r.db.first.reads}, repeated ${r.db.warm.duplicateReads})  trips ${String(r.db.warm.roundTrips).padStart(3)}  rows ${String(r.db.warm.rowsRead).padStart(6)}${r.db.stableAcrossRuns ? "" : "  [counts varied]"}${r.db.sqldAgrees ? "" : "  [sqld disagrees]"}`,
    );
  }
}

export function checkAgainst(run, budgetPath) {
  const file = join(ROOT, budgetPath);
  if (!existsSync(file) && !existsSync(budgetPath)) throw new HarnessError(`There is no budget file at ${budgetPath}.`);
  const text = readFileSync(existsSync(budgetPath) ? budgetPath : file, "utf8");
  let budget;
  let result;
  try {
    budget = readBudgetFile(text, budgetPath);
    result = compareToBudget(run, budget);
  } catch (e) {
    if (e instanceof BudgetFileError) {
      console.error(`✗ ${e.message}`);
      return 2;
    }
    throw e;
  }
  log(`\n=== budget check: ${budgetPath} ===`);
  for (const l of result.lines) log(l);
  if (result.status === "fail") {
    console.error(`✗ ${result.over.length} over budget, ${result.missing.length} missing.`);
    return 1;
  }
  log(result.status === "pass" ? "✓ within budget" : "• not checked: no budgets yet");
  return 0;
}

export async function runCheck(argv) {
  const runPath = argv[0];
  const i = argv.indexOf("--budget");
  if (!runPath || runPath.startsWith("--") || i < 0 || !argv[i + 1]) throw new HarnessError("Use: node scripts/perf-report.js check <run.json> --budget <budget.json>");
  const run = JSON.parse(readFileSync(existsSync(runPath) ? runPath : join(ROOT, runPath), "utf8"));
  return checkAgainst(run, argv[i + 1]);
}

export async function main(argv) {
  const [mode, ...rest] = argv;
  try {
    if (mode === "http") return await runHttp(rest);
    if (mode === "check") return await runCheck(rest);
    if (mode === "fixture") return await runFixtureInfo();
    throw new HarnessError(`Unknown mode "${mode}". Use http, check or fixture.`);
  } catch (e) {
    if (e instanceof HarnessError) {
      console.error(`✗ ${e.message}`);
      return 1;
    }
    throw e;
  }
}
