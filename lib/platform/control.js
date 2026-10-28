import { createClient } from "@libsql/client";
import { decryptSecret, decryptJson, encryptSecret, encryptJson } from "./crypto.js";

// Control-plane access (Session 20). Deliberately separate from lib/db.js:
// that module serves TENANT databases; this one serves the single platform DB
// (PLATFORM_DB_URL, local-file fallback for dev). Edge-safe.
//
// Runtime tenant shape handed to lib/tenant-context.js:
//   { id, name, status, dbUrl, dbToken, config: {...}, secrets: {...} }

let client = null;
// Exported since S26: lib/platform/sessions.js + identity.js query the same
// control-plane database (users/sessions/memberships).
export function platformDb() {
  if (!client) {
    client = createClient({
      url: process.env.PLATFORM_DB_URL || "file:platform.db",
      authToken: process.env.PLATFORM_DB_TOKEN || undefined,
    });
  }
  return client;
}
export const platformConfigured = () => Boolean(process.env.PLATFORM_DB_URL);
// test hook: new env → new client. preserveCaches keeps the host index and
// tenant cache so outage behavior (stale-if-fresh) can be exercised.
export function __resetPlatformClient({ preserveCaches = false } = {}) {
  client = null;
  if (!preserveCaches) {
    cache.clear();
    hostIndex = { at: 0, freshAt: 0, map: new Map() };
  }
}

const TTL_MS = () => Number(process.env.PLATFORM_CACHE_MS || 30_000);
// During a control-plane outage the last good snapshot keeps serving for at most
// PLATFORM_STALE_MS (then everything fails "unavailable" — never env fallback).
const STALE_MS = () => Number(process.env.PLATFORM_STALE_MS || 300_000);
const cache = new Map(); // tenant id → { at, tenant } (decrypted runtime; entries kept past TTL for stale-serve)
let hostIndex = { at: 0, freshAt: 0, map: new Map() }; // host → { id, name, status }

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

// Host → resolution outcome. FAIL-CLOSED in platform mode (S25 / BE01):
//   legacy      PLATFORM_DB_URL unset — single-tenant mode, caller uses the env
//               default everywhere (current production + pre-S20 local dev).
//   resolved    active tenant found for this host (tenant is non-null).
//   unknown     no tenant maps to this host — NEVER the default store.
//   suspended   the host's tenant is not active (name = control-plane display name).
//   unavailable control plane unreachable and the last good snapshot is older
//               than PLATFORM_STALE_MS (or never loaded).
// Never throws.
export async function resolveHost(host) {
  if (!platformConfigured()) return { outcome: "legacy", tenant: null, name: null };
  const none = { outcome: "unknown", tenant: null, name: null };
  if (!host) return none;
  const full = String(host).toLowerCase(); // e.g. "localhost:3007"
  const bare = full.split(":")[0]; // e.g. "localhost" — domains may list either
  if (Date.now() - hostIndex.at >= TTL_MS()) {
    try {
      // ALL statuses: a suspended host must be distinguishable from an unknown one.
      const res = await platformDb().execute("SELECT id, name, domains, status FROM tenants");
      const map = new Map();
      for (const row of res.rows) {
        for (const d of JSON.parse(row.domains || "[]")) {
          map.set(String(d).toLowerCase(), { id: row.id, name: row.name, status: row.status });
        }
      }
      const now = Date.now();
      hostIndex = { at: now, freshAt: now, map };
    } catch {
      // control plane unreachable → keep the stale snapshot, retry in ~5s
      hostIndex = { at: Date.now() - TTL_MS() + 5_000, freshAt: hostIndex.freshAt, map: hostIndex.map };
    }
  }
  const fresh = hostIndex.freshAt > 0 && Date.now() - hostIndex.freshAt <= STALE_MS();
  if (!fresh) return { outcome: "unavailable", tenant: null, name: null };
  const entry = hostIndex.map.get(full) ?? hostIndex.map.get(bare);
  if (!entry) return none;
  if (entry.status !== "active") return { outcome: "suspended", tenant: null, name: entry.name ?? null };
  let t;
  try {
    t = await getTenant(entry.id);
  } catch {
    const stale = cache.get(entry.id);
    if (stale && Date.now() - stale.at <= STALE_MS()) t = stale.tenant;
    else return { outcome: "unavailable", tenant: null, name: entry.name ?? null };
  }
  if (!t) return none; // index row vanished between refreshes
  if (t.status !== "active") return { outcome: "suspended", tenant: null, name: t.name ?? null };
  return { outcome: "resolved", tenant: t, name: t.name ?? null };
}

// Compat wrapper: tenant for an actively-resolved host, else null. In legacy
// mode this is always null (callers then use the env default); in platform mode
// a null means the request must be gated — see lib/tenant-gate.js.
export async function getTenantByHost(host) {
  const r = await resolveHost(host);
  return r.outcome === "resolved" ? r.tenant : null;
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

// S41 (BE26): deregister a tenant ROW (compensation for failed provisioning;
// never touches the tenant's database). Busts the resolver caches like every
// registry write.
export async function deleteTenant(id) {
  await platformDb().execute({ sql: "DELETE FROM tenants WHERE id = ?", args: [id] });
  cache.delete(id);
  hostIndex.at = 0;
}

export async function migratePlatform(schemaSql) {
  await platformDb().executeMultiple(schemaSql);
}

// Merge-update config/secrets/domains without resupplying everything —
// used by OAuth callbacks (store the admin token) and the console later.
export async function patchTenant(id, { config, secrets, domains, status, name } = {}) {
  const res = await platformDb().execute({ sql: "SELECT * FROM tenants WHERE id = ?", args: [id] });
  const row = res.rows[0];
  if (!row) throw new Error(`tenant ${id} not found`);
  const current = await toRuntime(row);
  return upsertTenant({
    id,
    name: name ?? current.name,
    status: status ?? current.status,
    domains: domains ?? current.domains,
    dbUrl: current.dbUrl,
    dbToken: current.dbToken,
    config: { ...current.config, ...(config || {}) },
    secrets: { ...current.secrets, ...(secrets || {}) },
  });
}

// Shopify webhooks arrive at ONE platform URL; the shop domain header picks
// the tenant(s). Several tenants may track the same store (staging mirrors,
// demo tenants) — return ALL active matches so each stays fresh.
export async function getTenantsByShopDomain(shopDomain) {
  if (!shopDomain) return [];
  const want = String(shopDomain).toLowerCase();
  const res = await platformDb().execute("SELECT id, config, status FROM tenants WHERE status = 'active'");
  const ids = res.rows
    .filter((r) => {
      try {
        return String(JSON.parse(r.config || "{}").shopify_store_domain || "").toLowerCase() === want;
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
  const tenants = [];
  for (const id of ids) {
    const t = await getTenant(id);
    if (t) tenants.push(t);
  }
  return tenants;
}
