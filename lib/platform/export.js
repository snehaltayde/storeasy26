// Tenant export & offboarding (Session 43 / BE29). Node-only, control-plane.
//
// Export: a VERSIONED manifest + full JSON dump of the tenant's own tables,
// built from the tenant's database only (another tenant's data cannot leak in
// by construction — one DB per tenant). Media BLOBS are excluded for size
// (metadata exported; the bytes stay in the tenant DB, which survives
// offboarding). Download links are operator-minted, tenant-bound and EXPIRE.
//
// Offboarding is deliberately conservative and reversible-by-stages:
//   suspend (hosts fail closed) → revoke keys (order-link secret + console
//   password rotate, so outstanding tokenized links and bootstrap sessions
//   die) → cancel the local billing subscription → purge PLATFORM-side
//   derived rows (jobs, webhook inbox, usage events). The tenant DB and the
//   control-plane row are KEPT (export stays possible; final deletion is a
//   separate manual act). Other tenants are untouched — suite-proven.
import { createClient } from "@libsql/client";
import { getTenant, patchTenant, platformDb } from "./control.js";
import { audit } from "./audit.js";
import { slog } from "../log.js";

export const EXPORT_VERSION = 1;

// Every table a tenant OWNS. Catalog tables are included (they're a synced
// projection, but it's the tenant's projection); media exports METADATA only.
const EXPORT_TABLES = [
  "products",
  "product_images",
  "variants",
  "collections",
  "collection_products",
  "orders",
  "order_events",
  "order_refunds",
  "order_fulfillments",
  "offers",
  "cms_blocks",
  "cms_pages",
  "placements",
  "releases",
  "release_state",
  "product_overrides",
  "collection_overrides",
  "notifications",
  "contact_messages",
  "privacy_requests",
  "events",
  "sync_runs",
];
const MEDIA_META_COLUMNS = "id, filename, mime, size, width, height, alt, variant, parent_id, sha256, created_at";

export async function buildTenantExport(tenantId) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  const client = createClient({ url: tenant.dbUrl, authToken: tenant.dbToken || undefined });
  const data = {};
  const tables = {};
  for (const table of EXPORT_TABLES) {
    try {
      const r = await client.execute(`SELECT * FROM ${table}`);
      data[table] = r.rows.map((row) => ({ ...row }));
      tables[table] = r.rows.length;
    } catch {
      tables[table] = null; // table absent on this schema vintage — recorded, not invented
    }
  }
  try {
    const r = await client.execute(`SELECT ${MEDIA_META_COLUMNS} FROM media`);
    data.media_metadata = r.rows.map((row) => ({ ...row }));
    tables.media_metadata = r.rows.length;
  } catch {
    tables.media_metadata = null;
  }
  client.close?.();

  const manifest = {
    export_version: EXPORT_VERSION,
    tenant: { id: tenant.id, name: tenant.name, status: tenant.status, domains: tenant.domains || [] },
    generated_at: new Date().toISOString(),
    tables,
    notes: [
      "media blobs are NOT in this file (size) — metadata is; bytes remain in the tenant database",
      "secrets are never exported",
      "orders may contain shopper PII — handle this file under your privacy obligations",
    ],
  };
  return { manifest, data };
}

// ---- expiring, tenant-bound download tokens ----------------------------------

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(message) {
  const secret = process.env.PLATFORM_SECRET || "dev-only";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${secret}|export`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))).slice(0, 32);
}

export async function mintExportToken(tenantId, { ttlMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const exp = Math.floor((now + ttlMs) / 1000);
  return `x.${exp}.${await hmac(`${tenantId}|${exp}`)}`;
}

export async function verifyExportToken(tenantId, token, { now = Date.now() } = {}) {
  const m = /^x\.(\d{1,12})\.([0-9a-f]{32})$/.exec(String(token || ""));
  if (!m) return false;
  const exp = Number(m[1]);
  if (now > exp * 1000) return false;
  const expect = await hmac(`${tenantId}|${exp}`);
  let diff = m[2].length ^ expect.length;
  for (let i = 0; i < expect.length; i++) diff |= (m[2].charCodeAt(i) || 0) ^ expect.charCodeAt(i);
  return diff === 0;
}

// ---- offboarding -------------------------------------------------------------

const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer);

export async function offboardTenant(tenantId, { actor = { kind: "operator", id: "operator" } } = {}) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  const steps = [];

  // 1. suspend — hosts fail closed (S25), storefront + console go dark
  await patchTenant(tenantId, { status: "suspended" });
  steps.push("suspended (hosts fail closed)");

  // 2. key revocation — outstanding order links + bootstrap console sessions die
  await patchTenant(tenantId, { secrets: { order_link_secret: rand(32), admin_password: rand(12) } });
  steps.push("keys revoked (order-link secret + console password rotated)");

  // 3. individual sessions for this tenant's members die with their memberships' tenant —
  //    sessions are user-scoped, so instead revoke via membership removal? NO:
  //    memberships are the merchant's team record and part of their export story.
  //    Suspension already gates every admin route (resolveHost fails closed), so
  //    sessions are inert; recorded rather than deleted.
  steps.push("admin sessions inert via suspension (memberships retained as records)");

  // 4. cancel the local billing subscription record (provider cancellation, if
  //    any, is a user-gated action on the provider account)
  const sub = await platformDb().execute({
    sql: "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE tenant_id = ? AND status NOT IN ('cancelled','completed','expired')",
    args: [new Date().toISOString(), tenantId],
  });
  if (Number(sub.rowsAffected)) steps.push(`billing subscription cancelled (${sub.rowsAffected})`);
  await import("./billing.js").then((B) => B.syncTenantBillingSnapshot(tenantId)).catch(() => {});

  // 5. purge PLATFORM-side derived rows (the tenant DB itself is untouched)
  const purged = {};
  for (const [table, col] of [["jobs", "tenant_id"], ["webhook_inbox", "tenant_id"], ["usage_events", "tenant_id"]]) {
    try {
      const r = await platformDb().execute({ sql: `DELETE FROM ${table} WHERE ${col} = ?`, args: [tenantId] });
      purged[table] = Number(r.rowsAffected);
    } catch {
      purged[table] = null;
    }
  }
  steps.push(`platform-side derived rows purged (${Object.entries(purged).map(([k, v]) => `${k}:${v ?? "n/a"}`).join(", ")})`);

  await audit({ actor, action: "tenant.status", tenantId, diff: { offboarded: true, steps: steps.length } });
  slog("tenant_offboarded", { tenant: tenantId });
  return {
    tenant: tenantId,
    steps,
    kept: ["tenant database (export remains possible; delete manually when retention allows)", "control-plane row (suspended)", "billing ledger + audit history"],
  };
}
