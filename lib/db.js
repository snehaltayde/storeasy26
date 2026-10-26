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

// Turso over HTTP occasionally throws a transient "fetch failed" under bursty
// load. These are connection-level failures (the request didn't reach Turso),
// so retrying a few times with small backoff is safe and keeps a blip from
// breaking a request — e.g. a payment-verify write.
function isTransient(err) {
  const m = String(err?.message || err).toLowerCase();
  return (
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("timed out") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("connection closed") ||
    m.includes("connection reset")
  );
}

async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i)); // 150, 300, 600ms
    }
  }
  throw lastErr;
}

const RETRY_METHODS = new Set(["execute", "batch", "executeMultiple"]);

function wrapClient(baseClient) {
  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        if (RETRY_METHODS.has(prop)) {
          return (...args) => withRetry(() => value.apply(target, args));
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
