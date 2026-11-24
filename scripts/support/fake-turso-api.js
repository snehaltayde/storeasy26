// A local stand-in for Turso's Platform API (Phase 1 line 2, docs/plans/phase-1.md
// §6 item 10). Tests, drills and the design harness talk to this; nothing here
// ever reaches api.turso.tech. Loopback only: it refuses to listen anywhere else.
//
//   startFakeTursoApi({ token, org, dataDir, backend, port, sqldBin, storeBasePort, onChildren })
//     -> { url, port, state, dbs(), children(), addDatabase(name), close() }
//
// Reply shapes follow Turso's documented API:
//   POST   /v1/organizations/{org}/databases {name, group}  -> 200 {database:{DbId,Hostname,Name}}
//                                                             | 409 exists | 400 group not found
//   GET    /v1/organizations/{org}/databases/{name}          -> 200 {database:{…}} | 404
//   POST   /v1/organizations/{org}/databases/{name}/auth/tokens?expiration=&authorization=
//                                                           -> 200 {jwt} | 404
//   DELETE /v1/organizations/{org}/databases/{name}          -> 200 {database:name} | 404
//   a missing or wrong Bearer token -> 401; another organization -> 404.
// Each database reply also carries a test-only `localUrl` (the client honours it
// only when it talks to a loopback API address).
//
// Backends:
//   file  (unit tests) each database is a SQLite file served by an in-process
//         Hrana fake on an ephemeral loopback port that checks the tokens minted
//         here (a 1-hour token really expires).
//   sqld  (harness, drills) one sqld child per database on storeBasePort + index,
//         its data in <dataDir>/fake-turso/<name>.sqld. sqld has no auth, so any
//         token works. Databases are listed in <dataDir>/fake-turso/registry.json
//         and started again on the next start. Children are stopped by their own
//         handles; onChildren(list) reports every change so the harness can
//         record their pids (never kill by name or port).
//
// Faults: POST /_fake/faults {route, status, times, delayMs, commitThenHang, retryAfter}
//   route: create | get | token | delete | * ; times: how many requests it hits (default 1)
//   status: answer with this HTTP status (and Turso-like error JSON) instead
//   delayMs: wait this long first; commitThenHang: do the real work, then never
//   answer (the socket closes after delayMs, default 60 s)
//   retryAfter: seconds, sent as a Retry-After header with the status
// DELETE /_fake/faults clears them; GET /_fake/log returns the request log
// ({at, method, route, name, status}; no tokens). /_fake/* needs no token.
import { createServer, get as httpGet } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, openSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { createClient } from "@libsql/client";
import { fakeTurso } from "./fake-turso.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const isLoopbackHostname = (h) => LOOPBACK.has(String(h || "").toLowerCase());

// Every fetch() to a host that is not loopback throws and is recorded. Loopback
// calls go to the real fetch. -> { blocked: [urls], restore() }
export function loopbackFetchGuard() {
  const real = globalThis.fetch;
  const blocked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      // not a URL: refused below
    }
    if (!isLoopbackHostname(host)) {
      blocked.push(url.slice(0, 120));
      throw new Error(`fetch guard: ${host || "a non-URL"} is not a loopback host; tests never leave this machine`);
    }
    return real(input, init);
  };
  return { blocked, restore: () => (globalThis.fetch = real) };
}

const portBusy = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
    sock.setTimeout(400, () => (sock.destroy(), resolve(false)));
  });

const jwtLike = () => ["eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9", randomBytes(24).toString("base64url"), randomBytes(32).toString("base64url")].join(".");
const EXPIRY = { never: null, "1h": 3600_000, "1d": 86_400_000, "2w": 14 * 86_400_000 };

const waitHealthy = (port, child, timeoutMs = 15_000) =>
  new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    const probe = () => {
      if (child.exitCode != null) return reject(new Error(`fake-turso-api: sqld on ${port} exited (${child.exitCode})`));
      const req = httpGet({ host: "127.0.0.1", port, path: "/health", timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    const retry = () => (Date.now() > until ? reject(new Error(`fake-turso-api: sqld on ${port} never answered`)) : setTimeout(probe, 100));
    probe();
  });

const stopHandle = (child, graceMs = 5000) =>
  new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });

export async function startFakeTursoApi({ token, org = "local-fake", groups = ["default"], dataDir, backend = "file", host = "127.0.0.1", port = 0, sqldBin = null, storeBasePort = null, onChildren = () => {} } = {}) {
  if (!isLoopbackHostname(host)) throw new Error(`fake-turso-api listens on loopback only, not ${host}`);
  if (!token) throw new Error("fake-turso-api needs the API token it should accept");
  if (!dataDir) throw new Error("fake-turso-api needs a data folder");
  if (!["file", "sqld"].includes(backend)) throw new Error("backend must be file or sqld");
  if (backend === "sqld" && (!sqldBin || !storeBasePort)) throw new Error("the sqld backend needs sqldBin and storeBasePort");
  const dir = join(dataDir, "fake-turso");
  mkdirSync(dir, { recursive: true });
  const registryFile = join(dir, "registry.json");

  const state = { log: [], faults: [], minted: [], creates: 0 };
  // name -> { name, dbId, group, index, localUrl, tokens: Map(jwt -> expiresAtMs|null), server?, child?, port? }
  const dbs = new Map();
  const saveRegistry = () =>
    backend === "sqld" &&
    writeFileSync(registryFile, JSON.stringify([...dbs.values()].map((d) => ({ name: d.name, dbId: d.dbId, group: d.group, index: d.index, createdAt: d.createdAt })), null, 2));
  const children = () => [...dbs.values()].filter((d) => d.child?.pid).map((d) => ({ name: d.name, pid: d.child.pid, port: d.port }));

  const tokenOk = (d) => (header) => {
    const m = /^Bearer (.+)$/.exec(header);
    if (!m || !d.tokens.has(m[1])) return false;
    const exp = d.tokens.get(m[1]);
    return exp == null || exp > Date.now();
  };

  async function bringUp(d) {
    if (backend === "file") {
      const backing = createClient({ url: `file:${join(dir, `${d.name}.db`)}` });
      d.backing = backing;
      d.server = fakeTurso(backing, { authorize: tokenOk(d) });
      d.port = await d.server.listen();
    } else {
      d.port = storeBasePort + d.index;
      if (await portBusy(d.port)) throw new Error(`port ${d.port} for the ${d.name} database is already in use`);
      const log = openSync(join(dir, `${d.name}.log`), "a");
      d.child = spawn(sqldBin, ["--no-welcome", "--disable-metrics", "--http-listen-addr", `127.0.0.1:${d.port}`, "--db-path", join(dir, `${d.name}.sqld`)], { stdio: ["ignore", log, log] });
      onChildren(children());
      await waitHealthy(d.port, d.child);
    }
    d.localUrl = `http://127.0.0.1:${d.port}`;
  }
  async function takeDown(d) {
    if (d.server) await d.server.close();
    d.backing?.close();
    if (d.child) await stopHandle(d.child);
    d.child = null;
    onChildren(children());
  }

  async function addDatabase(name, group = "default") {
    const used = new Set([...dbs.values()].map((d) => d.index));
    let index = 0;
    while (used.has(index)) index++;
    const d = { name, group, index, dbId: randomBytes(16).toString("hex"), createdAt: new Date().toISOString(), tokens: new Map() };
    dbs.set(name, d);
    await bringUp(d);
    saveRegistry();
    return d;
  }

  // the sqld backend starts the databases an earlier run made
  if (backend === "sqld" && existsSync(registryFile)) {
    for (const r of JSON.parse(readFileSync(registryFile, "utf8"))) {
      const d = { ...r, tokens: new Map() };
      dbs.set(d.name, d);
      await bringUp(d);
    }
  }

  const dbJson = (d) => ({ DbId: d.dbId, Hostname: `${d.name}-${org}.turso.io`, Name: d.name, group: d.group, regions: ["local"], primaryRegion: "local", type: "logical", version: "fake", localUrl: d.localUrl });
  const send = (res, status, body, headers = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });
  const takeFault = (route) => {
    const at = state.faults.findIndex((f) => f.route === route || f.route === "*");
    if (at < 0) return null;
    const f = state.faults[at];
    if (--f.times <= 0) state.faults.splice(at, 1);
    return f;
  };
  const ERR = { 400: "group not found", 401: "unauthorized", 402: "you have reached your plan limit", 403: "forbidden", 404: "not found", 409: "already exists", 429: "too many requests", 500: "internal error", 502: "bad gateway", 503: "service unavailable" };

  async function handle(req, res) {
    const url = new URL(req.url, "http://fake");
    const path = url.pathname;
    if (path === "/_fake/faults" && req.method === "POST") {
      const f = await readBody(req);
      state.faults.push({ route: String(f.route || "*"), status: f.status ? Number(f.status) : null, times: Math.max(1, Number(f.times) || 1), delayMs: Number(f.delayMs) || 0, commitThenHang: Boolean(f.commitThenHang), retryAfter: f.retryAfter ?? null });
      return send(res, 200, { ok: true, faults: state.faults.length });
    }
    if (path === "/_fake/faults" && req.method === "DELETE") {
      state.faults.length = 0;
      return send(res, 200, { ok: true });
    }
    if (path === "/_fake/log" && req.method === "GET") return send(res, 200, { log: state.log, databases: [...dbs.keys()] });

    const m = /^\/v1\/organizations\/([^/]+)\/databases(?:\/([^/]+))?(\/auth\/tokens)?$/.exec(path);
    const route = !m ? null : m[3] ? "token" : m[2] ? (req.method === "DELETE" ? "delete" : "get") : "create";
    const entry = { at: new Date().toISOString(), method: req.method, route: route || path, name: m?.[2] || null, status: 0 };
    state.log.push(entry);
    const answer = (status, body, headers) => {
      entry.status = status;
      send(res, status, body, headers);
    };
    if (req.headers.authorization !== `Bearer ${token}`) return answer(401, { error: "unauthorized" });
    if (!m || (route === "create" && req.method !== "POST") || (route === "token" && req.method !== "POST")) return answer(404, { error: "not found" });
    if (m[1] !== org) return answer(404, { error: "organization not found" });

    const body = route === "create" ? await readBody(req) : {};
    if (route === "create") entry.name = String(body.name || "") || null;
    const fault = takeFault(route);
    if (fault?.delayMs && !fault.commitThenHang) await new Promise((r) => setTimeout(r, fault.delayMs));
    if (fault?.status) return answer(fault.status, { error: ERR[fault.status] || "error" }, fault.retryAfter != null ? { "retry-after": String(fault.retryAfter) } : {});

    let status;
    let reply;
    if (route === "create") {
      const name = String(body.name || "");
      if (!/^[a-z0-9-]{1,64}$/.test(name)) [status, reply] = [400, { error: "invalid database name" }];
      else if (!groups.includes(String(body.group || "default"))) [status, reply] = [400, { error: "group not found" }];
      else if (dbs.has(name)) [status, reply] = [409, { error: `database with name ${name} already exists` }];
      else {
        state.creates++;
        const d = await addDatabase(name, String(body.group || "default"));
        const { DbId, Hostname, Name } = dbJson(d);
        [status, reply] = [200, { database: { DbId, Hostname, Name, localUrl: d.localUrl } }];
      }
    } else {
      const d = dbs.get(m[2]);
      if (!d) [status, reply] = [404, { error: "database not found" }];
      else if (route === "get") [status, reply] = [200, { database: dbJson(d) }];
      else if (route === "delete") {
        await takeDown(d);
        dbs.delete(d.name);
        rmSync(join(dir, `${d.name}.db`), { force: true });
        rmSync(join(dir, `${d.name}.sqld`), { recursive: true, force: true });
        saveRegistry();
        [status, reply] = [200, { database: d.name }];
      } else {
        const expiration = url.searchParams.get("expiration") || "never";
        if (!(expiration in EXPIRY)) [status, reply] = [400, { error: "invalid expiration" }];
        else {
          const jwt = jwtLike();
          d.tokens.set(jwt, EXPIRY[expiration] == null ? null : Date.now() + EXPIRY[expiration]);
          state.minted.push({ name: d.name, expiration, jwt });
          [status, reply] = [200, { jwt }];
        }
      }
    }
    if (fault?.commitThenHang) {
      entry.status = "hung";
      setTimeout(() => req.socket.destroy(), fault.delayMs || 60_000).unref?.();
      return;
    }
    answer(status, reply);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: String(e?.message || e).slice(0, 200) }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const bound = server.address().port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    state,
    dbs: () => [...dbs.values()].map((d) => ({ name: d.name, localUrl: d.localUrl, index: d.index })),
    children,
    tokensFor: (name) => [...(dbs.get(name)?.tokens.keys() || [])],
    addDatabase: (name, group) => addDatabase(name, group).then((d) => ({ name: d.name, localUrl: d.localUrl })),
    async close() {
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
      for (const d of dbs.values()) await takeDown(d);
    },
  };
}
