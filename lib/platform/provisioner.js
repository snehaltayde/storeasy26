// Where a new store's database is made (Phase 1 line 1). Node-only.
//
//   createStoreDatabase(slug, driver) -> { dbUrl, dbToken, created }
//     turso  today's createTenantDatabase (the `turso` CLI, or the Platform
//            API when TURSO_API_TOKEN + TURSO_ORG are set). The default: the
//            CLI and the operator console are unchanged.
//     file   a local SQLite file <STORE_DB_DIR>/storeasy-t-<slug>.db
//            (STORE_DB_DIR defaults to .store-dbs/). For self-serve signup on
//            a laptop or in the harness only: it refuses when NODE_ENV is
//            production, when VERCEL is set, or when STORE_DB_DIR looks like
//            a URL, and it only ever hands back a file: URL. Line 2 swaps
//            signup onto turso and moves it into a job. An existing file
//            is refused unless opts.resumeUrl names it (its own run resuming).
//     turso-api  Phase 1 line 2: self-serve signup through the Turso Platform
//            API only (lib/platform/turso-api.js), never the CLI. Its create
//            and token steps live in provision.js (they need the run's refs).
//
//   signupDbDriver(env) -> "turso-api" when TURSO_API_TOKEN and TURSO_ORG are
//            set, else "file" where the file driver is allowed, else null
//            (production without the API: signups answer 503).
import { mkdir, access } from "node:fs/promises";
import { resolve as resolvePath, join } from "node:path";

export const STORE_DB_DRIVERS = Object.freeze(["turso", "turso-api", "file"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function fileDriverRefusal(env = process.env) {
  if (env.NODE_ENV === "production") return "file databases are for local use only (NODE_ENV is production)";
  if (env.VERCEL) return "file databases are for local use only (this is a Vercel deployment)";
  const dir = String(env.STORE_DB_DIR || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(dir.trim())) return "STORE_DB_DIR must be a folder on this machine, not a URL";
  return null;
}

export function signupDbDriver(env = process.env) {
  if (String(env.TURSO_API_TOKEN || "").trim() && String(env.TURSO_ORG || "").trim()) return "turso-api";
  return fileDriverRefusal(env) ? null : "file";
}

// A file already there is someone else's leftover (an earlier store, a test)
// unless the caller is the provision run that recorded this exact URL in its
// refs and is resuming: only then is it adopted.
async function createFileDatabase(slug, { resumeUrl = null } = {}) {
  const refusal = fileDriverRefusal();
  if (refusal) throw new Error(refusal);
  const dir = resolvePath(process.env.STORE_DB_DIR || ".store-dbs");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `storeasy-t-${slug}.db`);
  // libsql opens the file on first use; a plain path keeps the URL readable
  const dbUrl = `file:${path}`;
  const created = await access(path).then(
    () => false,
    () => true,
  );
  if (!created && resumeUrl !== dbUrl) throw new Error(`a database file for "${slug}" is already there; refusing to reuse it`);
  return { dbUrl, dbToken: null, created };
}

// opts.resumeUrl: the dbUrl a resuming run recorded (file driver only).
export async function createStoreDatabase(slug, driver = "turso", opts = {}) {
  if (!SLUG_RE.test(String(slug || ""))) throw new Error("tenant id must be a slug");
  if (driver === "file") return createFileDatabase(slug, opts);
  if (driver === "turso") {
    const { createTenantDatabase } = await import("./provision.js");
    return createTenantDatabase(slug);
  }
  if (driver === "turso-api") throw new Error("the turso-api driver is run by provision.js's create_db step");
  throw new Error(`dbDriver must be one of ${STORE_DB_DRIVERS.join(", ")}`);
}
