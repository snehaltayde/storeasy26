// Retry safety in lib/db.js: an unknown-outcome failure on a write must never
// resend it (it may already have committed), a write that never reached the
// server is retried, and reads retry on any transient failure.
//   node scripts/test-db-retry.js          (pnpm test:db-retry)
// Isolated: real @libsql/client + Kysely against a local fake Hrana server, so
// the failures are real socket errors, not mocks. Localhost only.
import { createServer } from "node:http";

process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_AUTH_TOKEN = "";
process.env.DATABASE_URL = "";

// Lets a test bring the server back at the moment a connect fails, so "the retry
// succeeds" doesn't depend on timers. lib/db.js sees the failure unchanged. Only
// the current server's requests count: a closed transaction from an earlier test
// can still be failing against its old port.
const realFetch = globalThis.fetch;
let onFetchFailure = null;
globalThis.fetch = async (...args) => {
  try {
    return await realFetch(...args);
  } catch (e) {
    const hook = onFetchFailure;
    if (hook && String(args[0]?.url).startsWith(process.env.TURSO_DB_URL)) {
      onFetchFailure = null;
      await hook(e);
    }
    throw e;
  }
};

const { libsql, db, isReadOnlySql, neverReachedServer, isTransient } = await import("../lib/db.js");
const { sql } = await import("kysely");

// --- harness ---------------------------------------------------------------

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n  ${e?.message || e}`);
  }
}
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
async function rejects(promise, msg) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error(`${msg}: expected a failure, but it resolved`);
}

// --- fake Hrana server -----------------------------------------------------

// `failures` is consumed one per pipeline request: "drop" (socket closed after
// the request was fully received: the committed-but-response-lost shape), "rst",
// a number (that HTTP status), or undefined (success).
const execOk = { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: null };
const stmtOk = (r) => {
  if (r.type === "execute") return { type: "execute", result: execOk };
  if (r.type === "batch") {
    const n = r.batch.steps.length;
    return { type: "batch", result: { step_results: Array(n).fill(execOk), step_errors: Array(n).fill(null) } };
  }
  return { type: r.type };
};

function fakeHrana() {
  const state = { requests: 0, failures: [], sqlError: null };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.requests++;
      const failure = state.failures.shift();
      if (failure === "drop") return req.socket.destroy();
      if (failure === "rst") return req.socket.resetAndDestroy();
      if (typeof failure === "number") return res.writeHead(failure).end("upstream");
      const { requests } = JSON.parse(raw);
      const results = requests.map((r) => {
        if (state.sqlError && r.type === "execute") {
          return { type: "error", error: { message: state.sqlError, code: "SQLITE_ERROR" } };
        }
        return { type: "ok", response: stmtOk(r) };
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  const listen = (port = 0) => new Promise((r) => server.listen(port, "127.0.0.1", () => r(server.address().port)));
  const close = () =>
    new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  return { state, listen, close };
}

// A fresh client (lib/db.js caches per URL) on a fresh server.
async function setup() {
  const srv = fakeHrana();
  const port = await srv.listen();
  process.env.TURSO_DB_URL = `http://127.0.0.1:${port}`;
  return { ...srv, port };
}

// --- the operations, each through the same path production code uses ------

const WRITES = {
  "libsql.execute string": () => libsql.execute("insert into t values (1)"),
  "libsql.execute {sql,args}": () => libsql.execute({ sql: "update t set a = ?", args: [1] }),
  "libsql.execute leading comment": () => libsql.execute("/* select */ -- select\n delete from t"),
  "libsql.execute CTE write": () => libsql.execute("with x as (select 1) insert into t select * from x"),
  "Kysely insert": () => db.insertInto("t").values({ a: 1 }).execute(),
  "Kysely update": () => db.updateTable("t").set({ a: 1 }).where("a", "=", 2).execute(),
  "Kysely delete": () => db.deleteFrom("t").where("a", "=", 2).execute(),
  "Kysely CTE insert": () =>
    db.with("x", (q) => q.selectFrom("s").select("a")).insertInto("t").columns(["a"]).expression((q) => q.selectFrom("x").select("a")).execute(),
  "Kysely raw write": () => sql`update t set a = a + 1`.execute(db),
  "batch of writes": () => libsql.batch(["insert into t values (1)", "insert into t values (2)"], "write"),
  "batch mixing a read and a write": () => libsql.batch(["select 1", { sql: "insert into t values (?)", args: [1] }], "write"),
  "executeMultiple": () => libsql.executeMultiple("insert into t values (1); insert into t values (2);"),
};

const READS = {
  "libsql.execute string": () => libsql.execute("select * from t"),
  "libsql.execute {sql,args}": () => libsql.execute({ sql: "SELECT * FROM t WHERE a = ?", args: [1] }),
  "Kysely select": () => db.selectFrom("t").selectAll().execute(),
  "Kysely CTE select": () => db.with("x", (q) => q.selectFrom("s").select("a")).selectFrom("x").selectAll().execute(),
  "Kysely raw select": () => sql`select 1`.execute(db),
  "batch of reads": () => libsql.batch(["select 1", { sql: "select ?", args: [1] }], "read"),
  "executeMultiple single read": () => libsql.executeMultiple("select 1;"),
};

// --- 1. the core guarantee: unknown outcome on a write is never resent ------

for (const failure of ["drop", "rst", 500, 502, 503, 504]) {
  await t(`write + unknown outcome (${failure}): sent exactly once, error surfaces`, async () => {
    const s = await setup();
    for (const [name, op] of Object.entries(WRITES)) {
      s.state.requests = 0;
      s.state.failures = [failure];
      await rejects(op(), name);
      eq(s.state.requests, 1, `${name} requests`);
    }
    await s.close();
  });
}

await t("write in a transaction: unknown outcome is not resent", async () => {
  const s = await setup();
  const tx = await libsql.transaction("write");
  await tx.execute("select 1"); // opens the stream (BEGIN) before the failure
  s.state.requests = 0;
  s.state.failures = ["drop"];
  await rejects(tx.execute("insert into t values (1)"), "tx.execute");
  eq(s.state.requests, 1, "requests");
  tx.close();
  await s.close();
});

// --- 2. a write that never reached the server IS retried --------------------

await t("write + connection refused: retried, and reaches the server exactly once", async () => {
  const s = await setup();
  const { port } = s;
  for (const [name, op] of Object.entries(WRITES)) {
    await s.close();
    let refusals = 0;
    onFetchFailure = async (e) => {
      refusals++;
      eq(neverReachedServer(e), true, `${name} failure is a pre-connection one`);
      await s.listen(port);
    };
    s.state.requests = 0;
    await op();
    eq(refusals, 1, `${name} refusals`);
    eq(s.state.requests, 1, `${name} requests`);
  }
  await s.close();
});

await t("write: refused, then unknown outcome on the retry → stops there", async () => {
  const s = await setup();
  const { port } = s;
  await s.close();
  onFetchFailure = async () => {
    s.state.failures = ["drop"];
    await s.listen(port);
  };
  s.state.requests = 0;
  await rejects(libsql.execute("insert into t values (1)"), "write");
  eq(s.state.requests, 1, "requests");
  await s.close();
});

await t("write that never connects: gives up after 4 attempts", async () => {
  const s = await setup();
  await s.close();
  let attempts = 0;
  const count = async () => {
    attempts++;
    onFetchFailure = count;
  };
  onFetchFailure = count;
  await rejects(libsql.execute("insert into t values (1)"), "write");
  onFetchFailure = null;
  eq(attempts, 4, "attempts");
});

// --- 3. reads still retry on any transient failure ---------------------------

for (const failure of ["drop", "rst", 500, 502, 503, 504]) {
  await t(`read + transient (${failure}): retried until it succeeds`, async () => {
    const s = await setup();
    for (const [name, op] of Object.entries(READS)) {
      s.state.requests = 0;
      s.state.failures = [failure];
      await op();
      eq(s.state.requests, 2, `${name} requests`);
    }
    await s.close();
  });
}

await t("read + connection refused: retried", async () => {
  const s = await setup();
  const { port } = s;
  await s.close();
  onFetchFailure = () => s.listen(port);
  s.state.requests = 0;
  await libsql.execute("select 1");
  eq(s.state.requests, 1, "requests");
  await s.close();
});

await t("read: a SQL error is not transient, so it is not retried", async () => {
  const s = await setup();
  s.state.sqlError = "no such table: t";
  await rejects(libsql.execute("select * from t"), "read");
  eq(s.state.requests, 1, "requests");
  await s.close();
});

await t("read: a client-side HTTP status is not retried", async () => {
  const s = await setup();
  for (const status of [400, 401, 404]) {
    s.state.requests = 0;
    s.state.failures = [status];
    await rejects(libsql.execute("select 1"), String(status));
    eq(s.state.requests, 1, `${status} requests`);
  }
  await s.close();
});

// --- 4. the classifiers -------------------------------------------------------

await t("isReadOnlySql: reads", () => {
  for (const q of [
    "select 1",
    "  SELECT * FROM t",
    "select 1;",
    "-- note\nselect 1",
    "/* note */ select 1",
    "(select 1)",
    "values (1)",
    "explain query plan select 1",
    "with x as (select 1) select * from x",
    `with x as (select 'delete' as "update") select * from x`,
    "select 'it''s; insert into t' from t",
    db.selectFrom("t").selectAll().compile().sql,
  ]) {
    eq(isReadOnlySql(q), true, q);
  }
});

await t("isReadOnlySql: everything else counts as a write", () => {
  for (const q of [
    "insert into t values (1)",
    "INSERT OR REPLACE INTO t VALUES (1)",
    "update t set a = 1",
    "delete from t",
    "replace into t values (1)",
    "create table t (a)",
    "drop table t",
    "pragma journal_mode = wal",
    "begin",
    "commit",
    "with x as (select 1) insert into t select * from x",
    "with x as (select 1) update t set a = 1",
    "with x as (select 1) delete from t",
    "/* select */ delete from t",
    "-- select\ndelete from t",
    "select 1; delete from t",
    "",
    undefined,
    null,
    db.insertInto("t").values({ a: 1 }).compile().sql,
    db.updateTable("t").set({ a: 1 }).compile().sql,
    db.deleteFrom("t").compile().sql,
  ]) {
    eq(isReadOnlySql(q), false, String(q));
  }
});

await t("neverReachedServer: only proof of no connection qualifies", () => {
  const fetchFailed = (cause) => Object.assign(new TypeError("fetch failed"), { cause });
  const coded = (code, syscall) => Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
  for (const e of [
    fetchFailed(coded("ECONNREFUSED", "connect")),
    fetchFailed(coded("ENOTFOUND", "getaddrinfo")),
    fetchFailed(coded("EAI_AGAIN", "getaddrinfo")),
    fetchFailed(coded("ETIMEDOUT", "connect")),
    fetchFailed(coded("EHOSTUNREACH", "connect")),
    fetchFailed(Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })),
    fetchFailed(new AggregateError([coded("ETIMEDOUT", "connect"), coded("ENETUNREACH", "connect")])),
  ]) {
    eq(neverReachedServer(e), true, `${e.cause?.code || e.cause?.constructor?.name}`);
  }
  for (const e of [
    new TypeError("fetch failed"), // a runtime that gives no cause: can't prove it
    fetchFailed(coded("ECONNRESET", "read")),
    fetchFailed(coded("ETIMEDOUT", "read")),
    fetchFailed(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })),
    fetchFailed(Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" })),
    fetchFailed(new AggregateError([coded("ECONNREFUSED", "connect"), coded("ECONNRESET", "read")])),
    fetchFailed(new AggregateError([])),
    new Error("SERVER_ERROR: Server returned HTTP status 502"),
    new Error("connection closed"),
    new Error("timed out"),
    null,
  ]) {
    eq(neverReachedServer(e), false, String(e?.cause?.code || e?.message || e));
  }
});

await t("isTransient: an id that happens to contain 502/503 is not a blip", () => {
  for (const m of [
    "fetch failed",
    "SERVER_ERROR: Server returned HTTP status 500",
    "SERVER_ERROR: Server returned HTTP status 504: upstream",
    "read ECONNRESET",
    "connection closed",
  ]) {
    eq(isTransient(new Error(m)), true, m);
  }
  for (const m of [
    "Order BL-50312AB0 not found",
    "Invalid order transition cancelled → paid (PAV-1502AB33)",
    "SERVER_ERROR: Server returned HTTP status 404",
    "SERVER_ERROR: Server returned HTTP status 5031",
    "UNIQUE constraint failed: orders.idempotency_key",
  ]) {
    eq(isTransient(new Error(m)), false, m);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
