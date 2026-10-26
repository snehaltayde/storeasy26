import { createClient } from "@libsql/client";
import { decryptSecret, decryptJson, encryptSecret, encryptJson } from "./crypto.js";

// Control-plane access (Session 20). Deliberately separate from lib/db.js:
// that module serves TENANT databases; this one serves the single platform DB
// (PLATFORM_DB_URL, local-file fallback for dev). Edge-safe.
//
// Runtime tenant shape handed to lib/tenant-context.js:
//   { id, name, status, dbUrl, dbToken, config: {...}, secrets: {...} }

let client = null;
function platformDb() {
  if (!client) {
    client = createClient({
      url: process.env.PLATFORM_DB_URL || "file:platform.db",
      authToken: process.env.PLATFORM_DB_TOKEN || undefined,
    });
  }
  return client;
}
export const platformConfigured = () => Boolean(process.env.PLATFORM_DB_URL);
// test hook: new env → new client
export function __resetPlatformClient() {
  client = null;
  cache.clear();
  hostIndex = { at: 0, map: new Map() };
}

const TTL_MS = () => Number(process.env.PLATFORM_CACHE_MS || 30_000);
const cache = new Map(); // tenant id → { at, tenant } (decrypted runtime)
let hostIndex = { at: 0, map: new Map() }; // host → tenant id

async function toRuntime(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    domains: JSON.parse(row.domains || "[]"),
    dbUrl: row.db_url,
    dbToken: await decryptSecret(row.db_token_enc),
    config: JSON.parse(row.config || "{}"),
    secrets: await decryptJson(row.secrets_enc),
  };
}

export async function getTenant(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS()) return hit.tenant;
  const res = await platformDb().execute({ sql: "SELECT * FROM tenants WHERE id = ?", args: [id] });
  const row = res.rows[0];
  if (!row) return null;
  const tenant = await toRuntime(row);
  cache.set(id, { at: Date.now(), tenant });
  return tenant;
}

// Host → tenant. The host index refreshes on the same TTL; miss = null (the
// caller falls back to the env-configured default tenant, i.e. BeastLife).
export async function getTenantByHost(host) {
  if (!host) return null;
  const full = String(host).toLowerCase(); // e.g. "localhost:3007"
  const bare = full.split(":")[0]; // e.g. "localhost" — domains may list either
  if (Date.now() - hostIndex.at >= TTL_MS()) {
    try {
      const res = await platformDb().execute("SELECT id, domains, status FROM tenants WHERE status = 'active'");
      const map = new Map();
      for (const row of res.rows) {
        for (const d of JSON.parse(row.domains || "[]")) map.set(String(d).toLowerCase(), row.id);
      }
      hostIndex = { at: Date.now(), map };
    } catch {
      // control plane unreachable → behave as unmapped (env fallback)
      hostIndex = { at: Date.now() - TTL_MS() + 5_000, map: hostIndex.map };
    }
  }
  const id = hostIndex.map.get(full) ?? hostIndex.map.get(bare);
  if (!id) return null;
  const t = await getTenant(id);
  return t && t.status === "active" ? t : null;
}

export async function listTenants() {
  const res = await platformDb().execute("SELECT id, name, status, domains, db_url, created_at, updated_at FROM tenants ORDER BY created_at ASC");
  return res.rows.map((r) => ({ ...r, domains: JSON.parse(r.domains || "[]") }));
}

// Create/update a tenant (secrets encrypted here; config plain).
export async function upsertTenant({ id, name, status = "active", domains = [], dbUrl, dbToken = null, config = {}, secrets = {} }) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id || "")) throw new Error("tenant id must be a slug");
  if (!dbUrl) throw new Error("dbUrl required");
  const now = new Date().toISOString();
  await platformDb().execute({
    sql: `INSERT INTO tenants (id, name, status, domains, db_url, db_token_enc, config, secrets_enc, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, status = excluded.status, domains = excluded.domains,
            db_url = excluded.db_url, db_token_enc = excluded.db_token_enc,
            config = excluded.config, secrets_enc = excluded.secrets_enc, updated_at = excluded.updated_at`,
    args: [
      id,
      name,
      status,
      JSON.stringify(domains),
      dbUrl,
      dbToken ? await encryptSecret(dbToken) : null,
      JSON.stringify(config),
      await encryptJson(secrets),
      now,
      now,
    ],
  });
  cache.delete(id);
  hostIndex.at = 0;
  return getTenant(id);
}

export async function migratePlatform(schemaSql) {
  await platformDb().executeMultiple(schemaSql);
}
