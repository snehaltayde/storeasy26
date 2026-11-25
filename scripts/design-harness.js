// Design harness plumbing (P1-HARNESS, spec 8.15). Used by scripts/dev-design.js
// (pnpm dev:design, pnpm seed:design) and scripts/drill.js.
//
// The storefront runs on the edge runtime, and the edge libSQL client only
// speaks http(s)/ws(s), never file:. So the harness runs one local sqld per
// database and hands Next http://127.0.0.1 URLs. `runtime = "edge"` stays as
// it is; nothing in app/ is edited.
//
//   database   port                  holds
//   platform   DESIGN_SQLD_PORT      the control plane: tenants, users, sessions
//   tenant     DESIGN_SQLD_PORT + 1  the "design" store's own data
//   default    DESIGN_SQLD_PORT + 2  the env default (DATABASE_URL), used outside a store
//
// Data lives in .design-data/ (gitignored). Stopping the harness stops sqld.
//
// Phase 1 line 2: dev mode also runs a local stand-in for Turso's Platform API
// (scripts/support/fake-turso-api.js) on DESIGN_SQLD_PORT + 3, and the app is
// pointed at it (TURSO_API_URL on loopback, a random TURSO_API_TOKEN per run,
// TURSO_ORG=local-fake), so a self-serve signup gets a store database of its own:
// one more sqld per new store, on DESIGN_SQLD_PORT + 10 + n, its data under
// .design-data/fake-turso/. Those children are recorded in the pid file and
// stopped by their own handles (or, after a kill -9, by their recorded pids on
// the next start); never by name or port. Seed mode never starts it.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_NAMES } from "./perf-fixture.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_NEXT_PORT = 3017;
export const DEFAULT_SQLD_PORT = 18017;
export const DATA_DIR_NAME = ".design-data";
export const ENV_FILE_NAME = ".design-env";
export const TENANT_ID = "design";
export const DATABASES = [
  { key: "platform", offset: 0 },
  { key: "tenant", offset: 1 },
  { key: "default", offset: 2 },
];
// A harness profile: where its data lives, its ports, and how it treats that
// data. DESIGN_PROFILE is today's design harness (pnpm dev:design and
// pnpm seed:design), and the default everywhere below. The roles store
// (pnpm seed:roles, scripts/dev-roles.js) is a second profile with its own
// folder and ports; keepData makes its seed refuse a folder that holds data
// instead of wiping it, and otherDataDirs are harnesses it must not run beside.
export const DESIGN_PROFILE = Object.freeze({
  name: "design harness",
  dataDirName: DATA_DIR_NAME,
  portEnv: Object.freeze({ next: "DESIGN_PORT", sqld: "DESIGN_SQLD_PORT" }),
  defaultPorts: Object.freeze({ next: DEFAULT_NEXT_PORT, sqld: DEFAULT_SQLD_PORT }),
  keepData: false,
  otherDataDirs: Object.freeze([]),
  credentials: true, // generate .design-env and pass its passwords to the seed and Next
  tenantId: TENANT_ID,
  siteHost: "localhost",
  loginsFile: ENV_FILE_NAME,
  // rebuild: what the messages tell someone to run to rebuild the data
  commands: Object.freeze({ dev: "pnpm dev:design", rebuild: "pnpm seed:design" }),
});
const PIDFILE = "harness.pid.json";
const SEEDED = "seeded.json";

// Values from the shell or .env.local that would reach a hosted service, take
// real payments, send mail or change cookie scope. The harness blanks them.
// Next keeps a value that is already set, even an empty one, over .env.local.
export const BLANKED_ENV = [
  "TURSO_API_URL",
  "TURSO_DB_URL",
  "TURSO_DB_AUTH_TOKEN",
  "DATABASE_AUTH_TOKEN",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "RESEND_API_KEY",
  "TYPESENSE_HOST",
  "TYPESENSE_PORT",
  "TYPESENSE_PROTOCOL",
  "TYPESENSE_ADMIN_API_KEY",
  "TYPESENSE_COLLECTION",
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_STOREFRONT_TOKEN",
  "SHOPIFY_STOREFRONT_PRIVATE_TOKEN",
  "NEXT_PUBLIC_SHOPIFY_DOMAIN",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "PLATFORM_RAZORPAY_KEY_ID",
  "PLATFORM_RAZORPAY_KEY_SECRET",
  "PLATFORM_RAZORPAY_WEBHOOK_SECRET",
  "ALERT_WEBHOOK_URL",
  "GA4_API_SECRET",
  "META_CAPI_TOKEN",
  "META_TEST_EVENT_CODE",
  "NEXT_PUBLIC_GA4_MEASUREMENT_ID",
  "NEXT_PUBLIC_META_PIXEL_ID",
  "COOKIE_DOMAIN",
  "PLATFORM_URL",
  "PLATFORM_SECRET_NEXT",
  "VERCEL_URL",
  // Not hosted, but a value from .env.local naming localhost would turn the
  // harness storefront into the marketing site.
  "PLATFORM_SITE_HOSTS",
];

// Read by the app and passed through to the harness on purpose. None of them
// reaches a hosted service, except ANTHROPIC_API_KEY: AI insights keep working
// if the owner's shell has a key. test:design-harness fails when the app or
// .env.example names a variable that is in neither list, so a new hosted key
// can't slip through unblanked.
export const KEPT_ENV = [
  "ANTHROPIC_API_KEY",
  "SIGNUP_STORE_DOMAIN", // self-serve signup: new stores get <slug>.<this>; the harness sets localhost
  "STORE_DB_DIR", // self-serve signup's file databases; the harness sets <data dir>/stores
  "AI_INSIGHTS_MODEL",
  "ADMIN_PASSWORD", // the env default store's console password; the design store has its own
  "CRON_SECRET", // only compared with incoming requests
  "ORDER_LINK_SECRET", // signs order-status links locally
  "MAIL_FROM",
  "NODE_ENV",
  "SHOPIFY_API_VERSION",
  "PLATFORM_SUPPORT_EMAIL",
  "RATE_LIMIT_DISABLED",
  "GA4_DEBUG_MODE",
  "GA4_MP_EVENTS",
  "ERRORS_ALERT_EVERY_MS",
  "EVENTS_BACKOFF_MS",
  "EVENTS_MAX_ATTEMPTS",
  "FLAG_CACHE_MS",
  "ORDER_LINK_TTL_DAYS",
  "PLATFORM_BILLING_GRACE_DAYS",
  "PLATFORM_CACHE_MS",
  "PLATFORM_STALE_MS",
  "SHOPIFY_SYNC_BACKOFF_MS",
  "SHOPIFY_SYNC_MAX_ATTEMPTS",
  "SHOPIFY_SYNC_STALE_MS",
];

// A problem the person running the harness can fix. Printed as one plain line, no stack.
export class HarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = "HarnessError";
  }
}

// ---------- ports ----------

export function readPort(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new HarnessError(`${name} must be a port number, like ${fallback}. It is set to "${text}".`);
  const n = Number(text);
  if (n < 1024 || n > 65535) throw new HarnessError(`${name} must be a number from 1024 to 65535. It is set to ${text}.`);
  return n;
}

// The Turso stand-in listens right after the databases; new stores' databases
// start STORE_PORT_OFFSET above the first database port (room for STORE_PORTS).
export const STORE_PORT_OFFSET = 10;
export const STORE_PORTS = 50;
export function harnessPorts(env = process.env, profile = DESIGN_PROFILE) {
  const { next: nextEnv, sqld: sqldEnv } = profile.portEnv;
  const next = readPort(env, nextEnv, profile.defaultPorts.next);
  const first = readPort(env, sqldEnv, profile.defaultPorts.sqld);
  const turso = first + DATABASES.length;
  const storeBase = first + STORE_PORT_OFFSET;
  const last = storeBase + STORE_PORTS - 1;
  if (last > 65535) throw new HarnessError(`${sqldEnv} is too high: the harness needs ${last - first + 1} ports starting there (databases, the Turso stand-in and new stores). Use a lower number.`);
  if (next >= first && next <= last) {
    throw new HarnessError(`${nextEnv} (${next}) is one of the database ports (${first} to ${last}). Pick ports that don't overlap.`);
  }
  return { next, sqld: Object.fromEntries(DATABASES.map((d) => [d.key, first + d.offset])), turso, storeBase };
}

export const dbUrl = (port) => `http://127.0.0.1:${port}`;

export function harnessUrls(ports) {
  return Object.fromEntries(Object.entries(ports.sqld).map(([key, port]) => [key, dbUrl(port)]));
}

// The seed only ever writes to the harness's own local database servers.
export function assertLocalDbUrl(name, url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    throw new HarnessError(`${name} is missing. Run the seed through pnpm seed:design, which starts the local databases and sets it.`);
  }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || !u.port) {
    throw new HarnessError(`${name} must point at a local harness database (http://127.0.0.1:<port>). It points at ${u.protocol}//${u.host}. The harness never writes anywhere else.`);
  }
  return url;
}

// ---------- sqld ----------

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const MISSING_SQLD =
  "The design harness needs sqld, the local database server, and it isn't installed. " +
  "Install the Turso CLI (it puts sqld in ~/.turso), or download sqld and set SQLD_BIN to its path. Then run the same command again.";

// SQLD_BIN first, then PATH, then ~/.turso/sqld.
export function findSqld({ env = process.env, home = homedir(), exists = isFile } = {}) {
  if (env.SQLD_BIN) {
    if (exists(env.SQLD_BIN)) return { bin: env.SQLD_BIN, from: "SQLD_BIN" };
    throw new HarnessError(`SQLD_BIN is set to ${env.SQLD_BIN}, but there is no file there. Fix the path, or unset SQLD_BIN to use the sqld on your PATH.`);
  }
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(dir, "sqld");
    if (exists(p)) return { bin: p, from: "PATH" };
  }
  const fallback = join(home, ".turso", "sqld");
  if (exists(fallback)) return { bin: fallback, from: "~/.turso/sqld" };
  throw new HarnessError(MISSING_SQLD);
}

export function isPortBusy(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((done) => {
    const socket = net.connect({ port, host });
    const finish = (busy) => {
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function busyPort(ports, { includeNext, portEnv = DESIGN_PROFILE.portEnv }) {
  const list = [
    ...(includeNext ? [["the web server", portEnv.next, ports.next]] : []),
    ...Object.entries(ports.sqld).map(([k, p]) => [`the ${k} database`, portEnv.sqld, p]),
    ...(includeNext && ports.turso ? [["the local Turso stand-in", portEnv.sqld, ports.turso]] : []),
  ];
  for (const [what, name, port] of list) {
    if ((await isPortBusy(port)) || (await isPortBusy(port, "::1"))) return { what, name, port };
  }
  return null;
}

// waitMs: after stopping leftovers, give their ports a moment to close.
async function assertPortsFree(ports, { includeNext, waitMs = 0, portEnv }) {
  const started = Date.now();
  let busy = await busyPort(ports, { includeNext, portEnv });
  while (busy && Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 200));
    busy = await busyPort(ports, { includeNext, portEnv });
  }
  if (busy) {
    throw new HarnessError(`Port ${busy.port}, for ${busy.what}, is already in use. Another harness or app may be running. Stop it, or set ${busy.name} to a free port.`);
  }
}

const tail = (file, lines = 6) => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
};

export async function waitForHealth(url, child, { timeoutMs = 20_000, logFile, label } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode !== null) {
      throw new HarnessError(`The local database server for ${label} stopped while starting. Its log is ${logFile}.\n${tail(logFile)}`);
    }
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new HarnessError(`The local database server for ${label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Its log is ${logFile}.`);
}

// extraArgs: PERF-04's report adds sqld's own admin listener, to read its
// query counters. The harness itself passes none.
// logDir (DRILL_LOG_DIR in a drill run): the log goes there instead, named
// after the data folder, so the runner keeps it after a reseed wipes dataDir.
export function startSqld({ bin, key, port, dataDir, extraArgs = [], logDir = null }) {
  const logFile = logDir ? join(logDir, `${basename(dataDir).replace(/^\./, "")}-${key}.log`) : join(dataDir, `${key}.log`);
  const out = openSync(logFile, "a");
  // Same process group as the harness: a Ctrl-C in the terminal reaches sqld
  // even if this process is gone. The harness also stops it on purpose.
  const child = spawn(bin, ["--no-welcome", "--disable-metrics", "--http-listen-addr", `127.0.0.1:${port}`, "--db-path", join(dataDir, `${key}.sqld`), ...extraArgs], {
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  return { key, port, url: dbUrl(port), child, logFile };
}

export function stopChild(child, { graceMs = 8000 } = {}) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

// ---------- pid file: which processes this harness started ----------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
// LC_ALL and TZ pinned: `lstart` is printed in the caller's locale and local
// time, so a seed run with another TZ read a different start time for the same
// running launcher, thought it was gone, and went on to clear its pid file
// (P1-HARNESS review; fixed in P1-FIX-C).
const ps = (pid, field) => spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout?.trim() || "";
const commandOf = (pid) => ps(pid, "command");
const startTimeOf = (pid) => ps(pid, "lstart");

// A process as the pid file records it: its PID and when it started. A PID can
// later belong to another program; the same PID with the same start time can't.
// The start time is read from ps, so it doesn't matter how the process was
// started (pnpm runs the launcher as `node scripts/dev-design.js`, a relative
// name, while process.argv[1] is an absolute path).
export const processStamp = (pid) => ({ pid, started: startTimeOf(pid) });

// true: the recorded process is still running. false: it is gone, or its PID
// now belongs to something else. null: still a live PID, but the record has no
// start time to compare.
export function sameProcess(rec) {
  if (!rec?.pid || !alive(rec.pid)) return false;
  if (!rec.started) return null;
  return startTimeOf(rec.pid) === rec.started;
}

export function readPidfile(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, PIDFILE), "utf8"));
  } catch {
    return null;
  }
}
// Exported for PERF-04's report, which runs the same databases and records
// them the same way, so a harness started meanwhile is refused.
export const writePidfile = (dataDir, info) => writeFileSync(join(dataDir, PIDFILE), JSON.stringify(info, null, 2));
export const clearPidfile = (dataDir) => rmSync(join(dataDir, PIDFILE), { force: true });

// A harness is running if the launcher recorded in the pid file is still the
// same live process. Returns the pid file's contents, or null.
export function runningHarness(dataDir) {
  const info = readPidfile(dataDir);
  const launcher = info?.launcher;
  if (!launcher?.pid || launcher.pid === process.pid) return null;
  const same = sameProcess(launcher);
  if (same === true) return info;
  if (same === false && !alive(launcher.pid)) return null;
  // No start time recorded, or one that doesn't match (P1-FIX-C: the time
  // zone, or ps on Linux working the start out from boot time, can shift it):
  // a live process whose command names the launcher script still counts as
  // running. Refusing to start is the safe mistake; wiping a running harness's
  // data is not.
  const cmd = commandOf(launcher.pid);
  const script = launcher.script ? basename(launcher.script) : "dev-design.js";
  return cmd.includes(script) || cmd.includes("dev-design.js") ? info : null;
}

const stopPid = async (pid) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let i = 0; i < 80 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return true;
};

// Processes a harness started and left behind when it was killed outright:
// its Next and its sqld. Never while that harness is still running. Each is
// stopped by its recorded PID, and only if that PID still has the recorded
// start time and its command line still names what the harness ran (the data
// folder for sqld, the Next script for Next).
export async function stopLeftovers(dataDir, log = () => {}) {
  const info = readPidfile(dataDir);
  if (!info) return [];
  if (runningHarness(dataDir)) return [];
  const targets = [
    ...(info.next ? [{ ...info.next, what: "the web server" }] : []),
    ...(info.sqld || []).map((s) => ({ ...s, what: "a local database server", match: resolve(dataDir) })),
    ...(info.storeSqld || []).map((s) => ({ ...s, what: "a new store's local database server", match: resolve(dataDir) })),
  ];
  const stopped = [];
  for (const t of targets) {
    if (!t?.pid || !t.match || sameProcess(t) === false) continue;
    if (!commandOf(t.pid).includes(t.match)) continue;
    if (!(await stopPid(t.pid))) continue;
    stopped.push(t.pid);
    log(`• stopped ${t.what} left over from an earlier run (pid ${t.pid})`);
  }
  clearPidfile(dataDir);
  return stopped;
}

// ---------- credentials ----------

export function ensureCredentials(root, log = () => {}) {
  const envFile = join(root, ENV_FILE_NAME);
  if (!existsSync(envFile)) {
    writeFileSync(
      envFile,
      [`DESIGN_ADMIN_PASSWORD=design-${randomBytes(6).toString("hex")}`, `PLATFORM_ADMIN_PASSWORD=operator-${randomBytes(6).toString("hex")}`, ""].join("\n"),
      { mode: 0o600 },
    );
    log(`• generated local test credentials → ${ENV_FILE_NAME} (gitignored)`);
  }
  return readCredentials(root);
}

export function readCredentials(root) {
  const envFile = join(root, ENV_FILE_NAME);
  return Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

// ---------- env handed to Next and the seed ----------

// Self-serve signup (Phase 1 line 1) runs on the marketing host
// storeasy.localhost (set after blanking, so a value from .env.local never
// wins) and gives each new store <slug>.localhost and a file database under
// the harness's own data folder (dataDir; the profile's folder by default).
// Line 2: the Turso values point at the harness's own stand-in on loopback,
// with a random API token per run (tursoApiToken), set after blanking so a
// value from the shell or .env.local never wins.
export const FAKE_TURSO_ORG = "local-fake";
export const tursoStandInPort = (ports) => ports.turso ?? Math.max(...Object.values(ports.sqld)) + 1;
export function harnessEnv(baseEnv, fileEnv, ports, { siteHost = DESIGN_PROFILE.siteHost, dataDir = join(ROOT, DESIGN_PROFILE.dataDirName), tursoApiToken = randomBytes(24).toString("hex") } = {}) {
  const urls = harnessUrls(ports);
  const env = { ...baseEnv, ...fileEnv };
  for (const name of BLANKED_ENV) env[name] = "";
  return {
    ...env,
    TURSO_API_URL: `http://127.0.0.1:${tursoStandInPort(ports)}`,
    TURSO_API_TOKEN: tursoApiToken,
    TURSO_ORG: FAKE_TURSO_ORG,
    TURSO_GROUP: "default",
    PLATFORM_SITE_HOSTS: "storeasy.localhost",
    SIGNUP_STORE_DOMAIN: "localhost",
    STORE_DB_DIR: join(dataDir, "stores"),
    DATABASE_URL: urls.default,
    PLATFORM_DB_URL: urls.platform,
    PLATFORM_DB_TOKEN: "",
    PLATFORM_SECRET: "design-preview-secret",
    DESIGN_TENANT_DB_URL: urls.tenant,
    DESIGN_PORT: String(ports.next),
    NEXT_PUBLIC_SITE_URL: `http://${siteHost}:${ports.next}`,
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(ports.next),
  };
}

// ---------- migrations recorded at seed time ----------

export function migrationNames(root) {
  const out = {};
  for (const kind of ["tenant", "platform"]) {
    try {
      out[kind] = readdirSync(join(root, "migrations", kind)).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      out[kind] = [];
    }
  }
  return out;
}

export function newMigrations(recorded, current) {
  const added = [];
  for (const kind of Object.keys(current)) {
    const seen = new Set(recorded?.[kind] || []);
    for (const name of current[kind]) if (!seen.has(name)) added.push(`${kind}/${name}`);
  }
  return added;
}

// The folder exists and has anything in it (a profile with keepData never
// seeds over such a folder without reset).
export function holdsData(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export const readSeeded = (dataDir) => {
  try {
    return JSON.parse(readFileSync(join(dataDir, SEEDED), "utf8"));
  } catch {
    return null;
  }
};

// ---------- the harness itself ----------

const runChild = (cmd, args, opts) =>
  new Promise((done) => {
    const child = spawn(cmd, args, opts);
    child.once("error", (e) => done({ code: 1, error: e }));
    child.once("exit", (code, signal) => done({ code: code ?? (signal ? 1 : 0) }));
  });

// mode "seed": fresh data, seeded over http, then everything stops.
// mode "dev":  start the databases on the existing data (seeding first if
//              there is none), then `next dev`, until Ctrl-C or Next exits.
// nextCmd and seedCmd are [command, args], and repoint updates the tenant
// row; tests swap them for stand-ins.
// fixture: PERF-04's "perf" store on top of the demo data (seeding only; see
// scripts/perf-fixture.js). Recorded in seeded.json.
export const FIXTURES = FIXTURE_NAMES;
// profile: DESIGN_PROFILE unless given (see above). reset: only with a
// keepData profile, the seed deletes that profile's own data folder first.
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// A harness a drill starts is warmed before the drill uses it: boot()
// → { output() → string, stop() }, then each path is loaded, which compiles
// the routes drills use first, before a browser waits on them. Whatever a
// page answers (a 500 included) is left for the drill to see.
//   → the booted handle.
// (It used to boot again on Turbopack's next/font/google build failure; the
// fonts are self-hosted now, app/fonts/fonts.js, and test:fonts keeps
// next/font/google out.)
export async function bootBuilt({ boot, baseUrl, paths, fetchPage = defaultFetchPage }) {
  const h = await boot();
  for (const path of paths) await fetchPage(baseUrl + path);
  return h;
}
async function defaultFetchPage(url) {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(240_000) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: String(e?.message || e) };
  }
}

// Next's stdout and stderr, to this process's own and appended to file, with a
// header per start (a drill starts the harness many times).
export function teeNext(child, file, port, { out = process.stdout, err = process.stderr } = {}) {
  const fd = openSync(file, "a");
  writeSync(fd, `\n=== ${new Date().toISOString()} next dev on ${port} (pid ${child.pid})\n`);
  let open = 2;
  const pipe = (stream, to) => {
    stream.on("data", (c) => {
      to.write(c);
      writeSync(fd, c);
    });
    stream.once("close", () => {
      if (--open === 0) closeSync(fd);
    });
  };
  pipe(child.stdout, out);
  pipe(child.stderr, err);
}

export async function runHarness({ mode, root = ROOT, env = process.env, log = console.log, nextCmd, seedCmd, repoint = pointTenantAtThisRun, script = process.argv[1], fixture = null, profile = DESIGN_PROFILE, reset = false } = {}) {
  // A drill child (DRILL_ISOLATED_ROOT names its throwaway worktree) never runs
  // a harness anywhere else: refused before any folder, file or process is made.
  if (env.DRILL_ISOLATED_ROOT && realOr(env.DRILL_ISOLATED_ROOT) !== realOr(root)) {
    throw new HarnessError(`This run is a drill in ${env.DRILL_ISOLATED_ROOT}, so it won't start a harness in ${root}. Nothing was touched.`);
  }
  if (mode !== "seed" && mode !== "dev") throw new HarnessError(`Unknown harness mode "${mode}". Use seed or dev.`);
  if (fixture != null && !FIXTURES.includes(fixture)) throw new HarnessError(`There is no "${fixture}" fixture. The fixtures are: ${FIXTURES.join(", ")}.`);
  if (reset && !profile.keepData) throw new HarnessError(`reset only applies to a harness that keeps its data; ${profile.commands.rebuild} always starts fresh.`);
  const ports = harnessPorts(env, profile);
  const sqld = findSqld({ env });
  const dataDir = join(root, profile.dataDirName);
  // A drill run (run-isolated.mjs) names a folder for this harness's server
  // logs: Next's output is copied there as well as to stdout, and sqld writes there.
  const logDir = env.DRILL_LOG_DIR || null;

  const other = runningHarness(dataDir);
  if (other) {
    throw new HarnessError(`The ${profile.name} is already running (pid ${other.launcher.pid}). Stop it with Ctrl-C in its terminal first${mode === "seed" ? ", then seed again" : ""}.`);
  }
  // Other harnesses' folders are only read (their pid files), never changed.
  for (const name of profile.otherDataDirs) {
    const sibling = runningHarness(join(root, name));
    if (sibling) throw new HarnessError(`The harness using ${name}/ is running (pid ${sibling.launcher.pid}). Stop it with Ctrl-C in its terminal first; the two don't run side by side.`);
  }
  // keepData: a seed (or a dev run with nothing seeded) over a folder that holds
  // data is refused here, before anything in it is touched (leftovers included).
  if (profile.keepData && !reset && (mode === "seed" || !readSeeded(dataDir)) && holdsData(dataDir)) {
    throw new HarnessError(`${profile.dataDirName}/ already holds data, and this seed never deletes it. ${profile.commands.rebuild} deletes it and seeds again; run that only if the data can go.`);
  }
  const leftovers = existsSync(dataDir) ? await stopLeftovers(dataDir, log) : [];
  await assertPortsFree(ports, { includeNext: mode === "dev", waitMs: leftovers.length ? 10_000 : 0, portEnv: profile.portEnv });

  const fileEnv = profile.credentials ? ensureCredentials(root, log) : {};
  const childEnv = harnessEnv(env, fileEnv, ports, { siteHost: profile.siteHost, dataDir });
  const seedEnv = { ...childEnv, DESIGN_FIXTURE: fixture || "" };
  const seed = seedCmd || [process.execPath, [join(root, "scripts/seed-design-preview.js")]];
  const next = nextCmd || [process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(ports.next)]];

  let servers = [];
  let nextChild = null;
  let fake = null;
  let stopping = null;
  const stopAll = () =>
    (stopping ??= (async () => {
      for (const s of servers) s.stopping = true;
      if (nextChild) await stopChild(nextChild, { graceMs: 10_000 });
      // the stand-in stops each store database by its own handle
      if (fake) await fake.close().catch(() => {});
      fake = null;
      await Promise.all(servers.map((s) => stopChild(s.child)));
      clearPidfile(dataDir);
    })());

  // What the pid file says this harness started, so a later start can tell a
  // running harness from one that was killed outright and left processes behind.
  const pidInfo = { launcher: { ...processStamp(process.pid), script: script || "" }, ports };
  const savePidfile = () => writePidfile(dataDir, { ...pidInfo, startedAt: new Date().toISOString() });

  // A database server that stops by itself after it came up (a crash, or
  // something else killing it) stops the harness with a plain message, instead
  // of Next serving errors with nothing said.
  let died = null;
  let onDied = () => {};
  const diedMessage = (s) =>
    `The local database server for ${s.key} stopped by itself${s.exit.code != null ? ` (exit code ${s.exit.code})` : s.exit.signal ? ` (${s.exit.signal})` : ""}. Its log is ${s.logFile}.` +
    (tail(s.logFile, 4) ? `\n${tail(s.logFile, 4)}` : "");
  const watchDatabases = () => {
    for (const s of servers) {
      s.child.once("exit", (code, signal) => {
        // A Ctrl-C in the terminal reaches sqld directly too. Give the
        // harness's own signal handler a moment to say it is stopping.
        setTimeout(() => {
          if (s.stopping || signalled || died) return;
          s.exit = { code, signal };
          died = s;
          onDied(s);
        }, 500);
      });
    }
  };

  const startDatabases = async () => {
    // keepData (the roles store's logins live here): 0700 from the start
    if (profile.keepData) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
    } else mkdirSync(dataDir, { recursive: true });
    died = null;
    if (logDir) mkdirSync(logDir, { recursive: true });
    servers = DATABASES.map((d) => startSqld({ bin: sqld.bin, key: d.key, port: ports.sqld[d.key], dataDir, logDir }));
    pidInfo.sqld = servers.map((s) => ({ key: s.key, ...processStamp(s.child.pid), port: s.port }));
    delete pidInfo.next;
    savePidfile();
    try {
      for (const s of servers) await waitForHealth(s.url, s.child, { logFile: s.logFile, label: s.key });
    } catch (e) {
      await stopAll();
      throw e;
    }
    watchDatabases();
  };

  // A Ctrl-C reaches this process twice under pnpm (once from the terminal,
  // once passed on by pnpm), so the handler stays on: a repeat signal must not
  // kill the process half way through stopping.
  let signalled = false;
  const onSignal = (signal) => {
    if (!signalled) log(`\n• ${signal}: stopping the harness`);
    signalled = true;
    stopAll().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  const unhook = () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  };

  const doSeed = async () => {
    // keepData: reached only with reset or an empty folder (checked above); either way only this profile's own folder
    rmSync(dataDir, { recursive: true, force: true });
    await startDatabases();
    log(`• seeding the ${profile.tenantId} store over http (databases on ports ${Object.values(ports.sqld).join(", ")})${fixture ? `, with the ${fixture} fixture` : ""}`);
    const r = await runChild(seed[0], seed[1], { cwd: root, env: seedEnv, stdio: "inherit" });
    await stopAll();
    stopping = null;
    if (r.code !== 0) {
      throw new HarnessError(
        profile.keepData
          ? `${died ? `${diedMessage(died)}\n` : ""}Seeding failed${r.error ? `: ${r.error.message}` : ""}. The data in ${profile.dataDirName}/ is incomplete and is kept. Fix the error above, then run ${profile.commands.rebuild}.`
          : `${died ? `${diedMessage(died)}\n` : ""}Seeding failed${r.error ? `: ${r.error.message}` : ""}. The harness data is incomplete, so the next ${profile.commands.dev} seeds again. Fix the error above, then run ${profile.commands.rebuild}.`,
      );
    }
    writeFileSync(join(dataDir, SEEDED), JSON.stringify({ at: new Date().toISOString(), ports: ports.sqld, migrations: migrationNames(root), fixture: fixture || null }, null, 2));
  };

  try {
    if (mode === "seed") {
      await doSeed();
      log(`✓ ${profile.name} seeded${fixture ? ` with the ${fixture} fixture` : ""}. Start it with ${profile.commands.dev} (http://${profile.siteHost}:${ports.next}).`);
      return 0;
    }

    if (!readSeeded(dataDir)) {
      log(`• no harness data yet, so seeding first (the same as ${profile.commands.rebuild}${fixture ? ` --fixture ${fixture}` : ""})`);
      await doSeed();
    } else if (fixture && readSeeded(dataDir)?.fixture !== fixture) {
      log(`! The harness data wasn't seeded with the ${fixture} fixture. Run node scripts/dev-design.js seed --fixture ${fixture} first to get it.`);
    }
    const added = newMigrations(readSeeded(dataDir)?.migrations, migrationNames(root));
    if (added.length) {
      log(`! ${added.length} database change${added.length === 1 ? " was" : "s were"} added since the last seed (${added.slice(0, 3).join(", ")}${added.length > 3 ? ", …" : ""}). Run ${profile.commands.rebuild} to rebuild the harness data.`);
    }

    await startDatabases();
    try {
      const { startFakeTursoApi } = await import("./support/fake-turso-api.js");
      fake = await startFakeTursoApi({
        token: childEnv.TURSO_API_TOKEN,
        org: FAKE_TURSO_ORG,
        dataDir,
        backend: "sqld",
        port: ports.turso,
        sqldBin: sqld.bin,
        storeBasePort: ports.storeBase,
        onChildren: (list) => {
          pidInfo.storeSqld = list.map((c) => ({ key: c.name, ...processStamp(c.pid), port: c.port }));
          savePidfile();
        },
      });
    } catch (e) {
      throw new HarnessError(`The local Turso stand-in didn't start (${String(e?.message || e).slice(0, 160)}). Stop whatever uses ports ${ports.turso} and ${ports.storeBase}+, or set ${profile.portEnv.sqld} to other free ports.`);
    }
    try {
      await repoint(harnessUrls(ports), profile.tenantId, fake.dbs());
    } catch (e) {
      throw new HarnessError(`The harness data looks incomplete (${String(e?.message || e).slice(0, 120)}). Run ${profile.commands.rebuild} to rebuild it.`);
    }

    log(`• local databases up: ${servers.map((s) => `${s.key} ${s.port}`).join(", ")} (data in ${profile.dataDirName}/)`);
    log(`• local Turso stand-in on ${ports.turso}: new stores from signup get their own database (${fake.dbs().length} so far)`);
    log(`• storefront and consoles: http://${profile.siteHost}:${ports.next}  (merchant /admin/login, operator /platform; passwords in ${profile.loginsFile})`);
    nextChild = spawn(next[0], next[1], { cwd: root, env: childEnv, stdio: logDir ? ["ignore", "pipe", "pipe"] : "inherit" });
    if (logDir) teeNext(nextChild, join(logDir, `${profile.dataDirName.replace(/^\./, "")}-next.log`), ports.next);
    if (nextChild.pid) {
      pidInfo.next = { ...processStamp(nextChild.pid), port: ports.next, match: next[1][0] };
      savePidfile();
    }
    const outcome = await new Promise((done) => {
      nextChild.once("error", () => done({ code: 1 }));
      nextChild.once("exit", (c, signal) => done({ code: c ?? (signal ? 1 : 0) }));
      onDied = (s) => done({ died: s });
      if (died) done({ died });
    });
    await stopAll();
    if (outcome.died && !signalled) {
      throw new HarnessError(`${diedMessage(outcome.died)}\nThe harness stopped Next too. Start it again with ${profile.commands.dev}.`);
    }
    return signalled ? 0 : outcome.code;
  } catch (e) {
    await stopAll();
    throw e;
  } finally {
    unhook();
  }
}

// The tenant row records its database URL at seed time. If the ports changed
// since, point it at this run's tenant server. Line 2: stores made through the
// Turso stand-in (stores: [{ name: storeasy-t-<slug>, localUrl }]) are pointed
// at this run's address for their database too.
export async function pointTenantAtThisRun(urls, tenantId = TENANT_ID, stores = []) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: urls.platform });
  try {
    await client.execute({ sql: "UPDATE tenants SET db_url = ? WHERE id = ? AND db_url <> ?", args: [urls.tenant, tenantId, urls.tenant] });
    for (const s of stores) {
      const id = String(s.name || "").replace(/^storeasy-t-/, "");
      if (!id || id === s.name || !s.localUrl) continue;
      assertLocalDbUrl(`the ${id} store's database`, s.localUrl);
      await client.execute({ sql: "UPDATE tenants SET db_url = ? WHERE id = ? AND db_url <> ?", args: [s.localUrl, id, s.localUrl] });
    }
  } finally {
    client.close();
  }
}
