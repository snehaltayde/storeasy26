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
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const PIDFILE = "harness.pid.json";
const SEEDED = "seeded.json";

// Values from the shell or .env.local that would reach a hosted service, take
// real payments, send mail or change cookie scope. The harness blanks them.
// Next keeps a value that is already set, even an empty one, over .env.local.
export const BLANKED_ENV = [
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

export function harnessPorts(env = process.env) {
  const next = readPort(env, "DESIGN_PORT", DEFAULT_NEXT_PORT);
  const first = readPort(env, "DESIGN_SQLD_PORT", DEFAULT_SQLD_PORT);
  const last = first + DATABASES.length - 1;
  if (last > 65535) throw new HarnessError(`DESIGN_SQLD_PORT is too high: the harness needs ${DATABASES.length} ports in a row starting there. Use a lower number.`);
  if (next >= first && next <= last) {
    throw new HarnessError(`DESIGN_PORT (${next}) is one of the database ports (${first} to ${last}). Pick ports that don't overlap.`);
  }
  return { next, sqld: Object.fromEntries(DATABASES.map((d) => [d.key, first + d.offset])) };
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

async function assertPortsFree(ports, { includeNext }) {
  const list = [...(includeNext ? [["the web server", "DESIGN_PORT", ports.next]] : []), ...Object.entries(ports.sqld).map(([k, p]) => [`the ${k} database`, "DESIGN_SQLD_PORT", p])];
  for (const [what, name, port] of list) {
    if ((await isPortBusy(port)) || (await isPortBusy(port, "::1"))) {
      throw new HarnessError(`Port ${port}, for ${what}, is already in use. Another harness or app may be running. Stop it, or set ${name} to a free port.`);
    }
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

function startSqld({ bin, key, port, dataDir }) {
  const logFile = join(dataDir, `${key}.log`);
  const out = openSync(logFile, "a");
  // Same process group as the harness: a Ctrl-C in the terminal reaches sqld
  // even if this process is gone. The harness also stops it on purpose.
  const child = spawn(bin, ["--no-welcome", "--disable-metrics", "--http-listen-addr", `127.0.0.1:${port}`, "--db-path", join(dataDir, `${key}.sqld`)], {
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
const commandOf = (pid) => spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout?.trim() || "";

export function readPidfile(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, PIDFILE), "utf8"));
  } catch {
    return null;
  }
}
const writePidfile = (dataDir, info) => writeFileSync(join(dataDir, PIDFILE), JSON.stringify(info, null, 2));
const clearPidfile = (dataDir) => rmSync(join(dataDir, PIDFILE), { force: true });

// A harness is running if the launcher recorded in the pid file is still
// alive and still the same script.
export function runningHarness(dataDir) {
  const info = readPidfile(dataDir);
  if (!info?.launcher?.pid || info.launcher.pid === process.pid) return null;
  if (!alive(info.launcher.pid)) return null;
  const cmd = commandOf(info.launcher.pid);
  return info.launcher.script && cmd.includes(info.launcher.script) ? info.launcher : null;
}

// sqld this harness started earlier and left behind (the launcher was killed
// outright). Each is stopped by its recorded PID, and only if its command line
// still names this harness's data folder.
export async function stopLeftovers(dataDir, log = () => {}) {
  const info = readPidfile(dataDir);
  if (!info) return [];
  const stopped = [];
  for (const s of info.sqld || []) {
    if (!s?.pid || !alive(s.pid)) continue;
    if (!commandOf(s.pid).includes(resolve(dataDir))) continue;
    try {
      process.kill(s.pid, "SIGTERM");
    } catch {
      continue;
    }
    for (let i = 0; i < 50 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive(s.pid)) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {}
    }
    stopped.push(s.pid);
    log(`• stopped a local database server left over from an earlier run (pid ${s.pid})`);
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

export function harnessEnv(baseEnv, fileEnv, ports) {
  const urls = harnessUrls(ports);
  const env = { ...baseEnv, ...fileEnv };
  for (const name of BLANKED_ENV) env[name] = "";
  return {
    ...env,
    DATABASE_URL: urls.default,
    PLATFORM_DB_URL: urls.platform,
    PLATFORM_DB_TOKEN: "",
    PLATFORM_SECRET: "design-preview-secret",
    DESIGN_TENANT_DB_URL: urls.tenant,
    DESIGN_PORT: String(ports.next),
    NEXT_PUBLIC_SITE_URL: `http://localhost:${ports.next}`,
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
export async function runHarness({ mode, root = ROOT, env = process.env, log = console.log, nextCmd, seedCmd, repoint = pointTenantAtThisRun, script = process.argv[1] } = {}) {
  if (mode !== "seed" && mode !== "dev") throw new HarnessError(`Unknown harness mode "${mode}". Use seed or dev.`);
  const ports = harnessPorts(env);
  const sqld = findSqld({ env });
  const dataDir = join(root, DATA_DIR_NAME);

  const other = runningHarness(dataDir);
  if (other) {
    throw new HarnessError(`The design harness is already running (pid ${other.pid}). Stop it with Ctrl-C in its terminal first${mode === "seed" ? ", then seed again" : ""}.`);
  }
  if (existsSync(dataDir)) await stopLeftovers(dataDir, log);
  await assertPortsFree(ports, { includeNext: mode === "dev" });

  const fileEnv = ensureCredentials(root, log);
  const childEnv = harnessEnv(env, fileEnv, ports);
  const seed = seedCmd || [process.execPath, [join(root, "scripts/seed-design-preview.js")]];
  const next = nextCmd || [process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(ports.next)]];

  let servers = [];
  let nextChild = null;
  let stopping = null;
  const stopAll = () =>
    (stopping ??= (async () => {
      if (nextChild) await stopChild(nextChild, { graceMs: 10_000 });
      await Promise.all(servers.map((s) => stopChild(s.child)));
      clearPidfile(dataDir);
    })());

  const startDatabases = async () => {
    mkdirSync(dataDir, { recursive: true });
    servers = DATABASES.map((d) => startSqld({ bin: sqld.bin, key: d.key, port: ports.sqld[d.key], dataDir }));
    writePidfile(dataDir, {
      launcher: { pid: process.pid, script: script || "" },
      sqld: servers.map((s) => ({ key: s.key, pid: s.child.pid, port: s.port })),
      startedAt: new Date().toISOString(),
    });
    try {
      for (const s of servers) await waitForHealth(s.url, s.child, { logFile: s.logFile, label: s.key });
    } catch (e) {
      await stopAll();
      throw e;
    }
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
    rmSync(dataDir, { recursive: true, force: true });
    await startDatabases();
    log(`• seeding the design store over http (databases on ports ${Object.values(ports.sqld).join(", ")})`);
    const r = await runChild(seed[0], seed[1], { cwd: root, env: childEnv, stdio: "inherit" });
    await stopAll();
    stopping = null;
    if (r.code !== 0) {
      throw new HarnessError(`Seeding failed${r.error ? `: ${r.error.message}` : ""}. The harness data is incomplete, so the next pnpm dev:design seeds again. Fix the error above, then run pnpm seed:design.`);
    }
    writeFileSync(join(dataDir, SEEDED), JSON.stringify({ at: new Date().toISOString(), ports: ports.sqld, migrations: migrationNames(root) }, null, 2));
  };

  try {
    if (mode === "seed") {
      await doSeed();
      log(`✓ design harness seeded. Start it with pnpm dev:design (http://localhost:${ports.next}).`);
      return 0;
    }

    if (!readSeeded(dataDir)) {
      log("• no harness data yet, so seeding first (the same as pnpm seed:design)");
      await doSeed();
    }
    const added = newMigrations(readSeeded(dataDir)?.migrations, migrationNames(root));
    if (added.length) {
      log(`! ${added.length} database change${added.length === 1 ? " was" : "s were"} added since the last seed (${added.slice(0, 3).join(", ")}${added.length > 3 ? ", …" : ""}). Run pnpm seed:design to rebuild the harness data.`);
    }

    await startDatabases();
    try {
      await repoint(harnessUrls(ports));
    } catch (e) {
      throw new HarnessError(`The harness data looks incomplete (${String(e?.message || e).slice(0, 120)}). Run pnpm seed:design to rebuild it.`);
    }

    log(`• local databases up: ${servers.map((s) => `${s.key} ${s.port}`).join(", ")} (data in ${DATA_DIR_NAME}/)`);
    log(`• storefront and consoles: http://localhost:${ports.next}  (merchant /admin/login, operator /platform; passwords in ${ENV_FILE_NAME})`);
    nextChild = spawn(next[0], next[1], { cwd: root, env: childEnv, stdio: "inherit" });
    const code = await new Promise((done) => {
      nextChild.once("error", () => done(1));
      nextChild.once("exit", (c, signal) => done(c ?? (signal ? 1 : 0)));
    });
    await stopAll();
    return signalled ? 0 : code;
  } catch (e) {
    await stopAll();
    throw e;
  } finally {
    unhook();
  }
}

// The tenant row records its database URL at seed time. If the ports changed
// since, point it at this run's tenant server.
export async function pointTenantAtThisRun(urls) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: urls.platform });
  try {
    await client.execute({ sql: "UPDATE tenants SET db_url = ? WHERE id = ? AND db_url <> ?", args: [urls.tenant, TENANT_ID, urls.tenant] });
  } finally {
    client.close();
  }
}
