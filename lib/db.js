import { createClient } from "@libsql/client";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { currentTenant } from "./tenant-context.js";

// Tenant-aware database access (Session 20). `db` and `libsql` are PROXIES
// that resolve the ACTIVE tenant's client per call:
//   • inside withTenant(tenant, …) → that tenant's own Turso DB
//   • no tenant context            → the env-configured client (TURSO_DB_URL /
//     DATABASE_URL / file:local.db) — the pre-S20 behavior, which keeps every
//     existing script, test, and cron working as the BeastLife default.
// Call sites are untouched: `db.selectFrom(…)` everywhere just works.
// One client+Kysely pair is built and cached per distinct database.

// Turso over HTTP occasionally fails under bursty load. A failure means one of:
//   • NEVER REACHED THE SERVER — DNS or the TCP connect failed, so no statement
//     was sent. Nothing can have run; resending is safe for any statement.
//   • OUTCOME UNKNOWN — a timeout, reset, closed socket, HTTP 500/502/503/504, or a bare
//     "fetch failed". These can arrive AFTER a write committed with only the
//     response lost, so resending can run that write twice.
// Reads retry on both. Writes retry only on the first; an unknown-outcome write
// throws, and the caller must re-read to learn what happened.

// Transient failures of either kind — the retry test for READS only. Callers use
// it to spot a failed write they must reconcile by re-reading. A gateway status
// only counts in the client's own wording ("Server returned HTTP status 504"), so
// an order id like BL-50312AB0 inside an error message doesn't read as a blip.
const TRANSIENT =
  /fetch failed|network|econnreset|etimedout|timed out|connection closed|connection reset|\bhttp status 50[0234]\b/;

export function isTransient(err) {
  return TRANSIENT.test(String(err?.message || err).toLowerCase());
}

// Codes that only a failed DNS lookup or TCP connect can produce. Undici hides
// these under `cause` ("fetch failed"), and a dual-stack connect nests them in
// an AggregateError's `errors`. Anything unrecognized counts as outcome unknown:
// that includes runtimes whose fetch errors carry no cause.
const NEVER_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export function neverReachedServer(err) {
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (NEVER_SENT_CODES.has(e.code) || e.syscall === "connect" || e.syscall === "getaddrinfo") return true;
    if (Array.isArray(e.errors) && e.errors.length && e.errors.every(neverReachedServer)) return true;
  }
  return false;
}

// String literals, quoted identifiers and comments, blanked before classifying
// so their contents can't be mistaken for keywords.
const SQL_NOISE = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

// True only for a single statement that cannot change data. Every mistake must
// fall on the write side (a read that isn't retried is merely less resilient),
// so anything unrecognized — PRAGMA included — is a write.
export function isReadOnlySql(sql) {
  if (typeof sql !== "string") return false;
  const s = sql.replace(SQL_NOISE, " ").replace(/[;\s]+$/, "").toLowerCase();
  if (s.includes(";")) return false;
  const first = s.match(/^[\s(]*([a-z]+)/)?.[1];
  if (first === "select" || first === "values" || first === "explain") return true;
  // A CTE can lead into a write: `with x as (…) insert …`.
  return first === "with" && !/\b(insert|update|delete|replace)\b/.test(s);
}

const sqlOf = (stmt) => (typeof stmt === "string" ? stmt : Array.isArray(stmt) ? stmt[0] : stmt?.sql);

// Is this call read-only? Kysely reaches this layer as execute({ sql, args }),
// so the SQL text is what's classified, for raw and Kysely calls alike. A batch
// is one transaction, so a single write makes all of it a write. A multi-statement
// executeMultiple isn't atomic and is always a write. Kysely transactions never
// come through here: transaction() isn't wrapped, so nothing inside one retries.
const READ_ONLY_CHECKS = new Map([
  ["execute", (stmt) => isReadOnlySql(sqlOf(stmt))],
  ["batch", (stmts) => Array.isArray(stmts) && stmts.length > 0 && stmts.every((s) => isReadOnlySql(sqlOf(s)))],
  ["executeMultiple", (sql) => isReadOnlySql(sql)],
]);

async function withRetry(fn, canRetry, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !canRetry(e)) throw e;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i)); // 150, 300, 600ms
    }
  }
  throw lastErr;
}

function wrapClient(baseClient) {
  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        const isReadOnly = READ_ONLY_CHECKS.get(prop);
        if (isReadOnly) {
          return (...args) =>
            withRetry(
              () => value.apply(target, args),
              (e) => (isReadOnly(...args) ? isTransient(e) : neverReachedServer(e)),
            );
        }
        return value.bind(target);
      }
      return value;
    },
  });
}

const instances = new Map(); // cache key → { libsql, db }

function buildInstance(url, authToken) {
  const base = createClient({ url, authToken: authToken || undefined });
  const wrapped = wrapClient(base);
  return { libsql: wrapped, db: new Kysely({ dialect: new LibsqlDialect({ client: wrapped }) }) };
}

function envInstance() {
  const url = process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db";
  const token = process.env.TURSO_DB_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || "";
  const key = `env:${url}`; // env can change between test runs — key on the URL
  if (!instances.has(key)) instances.set(key, buildInstance(url, token));
  return instances.get(key);
}

function activeInstance() {
  const tenant = currentTenant();
  if (!tenant?.dbUrl) return envInstance();
  const key = `tenant:${tenant.id}:${tenant.dbUrl}`;
  if (!instances.has(key)) instances.set(key, buildInstance(tenant.dbUrl, tenant.dbToken));
  return instances.get(key);
}

const forward = (pick) =>
  new Proxy(
    {},
    {
      get(_, prop) {
        const target = pick();
        const value = target[prop];
        if (typeof value !== "function") return value;
        // NOTE: not .bind() — Kysely's `db.fn` is a callable that ALSO carries
        // methods (countAll, count, …); bind would strip them. This wrapper
        // forwards calls with the right `this` AND preserves property access.
        return new Proxy(value, {
          apply: (fnTarget, _this, args) => Reflect.apply(fnTarget, target, args),
          get: (fnTarget, p) => {
            const v = fnTarget[p];
            return typeof v === "function" ? v.bind(fnTarget) : v;
          },
        });
      },
      has(_, prop) {
        return prop in pick();
      },
    },
  );

export const db = forward(() => activeInstance().db);
export const libsql = forward(() => activeInstance().libsql);

// MIG-05: the cached { libsql, db } pair for the ACTIVE database. One stable
// object per database, so lib/schema-compat.js can remember a schema fact once
// per database instead of asking on every request.
export const currentDatabase = () => activeInstance();
