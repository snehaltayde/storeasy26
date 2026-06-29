import { createClient } from "@libsql/client";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";

// One libSQL client, shared by Kysely (the typed query builder the app uses)
// and by raw DDL / batch writes in the sync + migrate scripts.
//
// Local dev points DATABASE_URL at a `file:` URL and runs on the Node runtime.
// To go edge + Turso, set DATABASE_URL=libsql://<db>.turso.io and
// DATABASE_AUTH_TOKEN — the same client speaks libSQL's HTTP protocol — and add
// `export const runtime = "edge"` to the page/route modules.
// Prefer Turso cloud (TURSO_DB_*) when set; fall back to DATABASE_URL, then a
// local file. The same client speaks libSQL's HTTP protocol to Turso.
const url = process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db";
const authToken =
  process.env.TURSO_DB_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || undefined;

export const libsql = createClient({ url, authToken });

export const db = new Kysely({
  dialect: new LibsqlDialect({ client: libsql }),
});
