import { createClient } from "@libsql/client";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";

// Prefer Turso cloud (TURSO_DB_*) when set; fall back to DATABASE_URL, then a
// local file. The same client speaks libSQL's HTTP protocol to Turso.
const url = process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db";
const authToken =
  process.env.TURSO_DB_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || undefined;

const baseClient = createClient({ url, authToken });

// Turso over HTTP occasionally throws a transient "fetch failed" under bursty
// load. These are connection-level failures (the request didn't reach Turso), so
// retrying a few times with small backoff is safe and keeps a blip from breaking
// a request — e.g. a payment-verify write. (Production: also use a webhook.)
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

// Wrap the client so Kysely's queries (and raw DDL/batch) auto-retry transient
// connection failures. Reads + our idempotent writes are safe to retry.
export const libsql = new Proxy(baseClient, {
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

export const db = new Kysely({
  dialect: new LibsqlDialect({ client: libsql }),
});
