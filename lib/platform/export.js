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
import { audit, operatorActor } from "./audit.js";
import { rotateStoreSecrets } from "./store-lifecycle.js";
import { newId } from "./sessions.js";
import { slog } from "../log.js";
import { pruneExportLinks } from "./jobs.js";

export { pruneExportLinks };

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
  // P2-ATOM (DOC-12): the document store, migration 0021. On a tenant still at
  // 0020 these tables are absent; the loop below records them as null.
  "documents",
  "document_versions",
  "publish_log",
  "cms_state",
  // P3-COMMIT: what each published version links to, migration 0023. Absent
  // (recorded as null) on a tenant still at 0022.
  "document_refs",
  // P4-LIVEROW: what shoppers see of the founder's product and collection
  // edits, and the products whose search entry must change (migration 0024;
  // recorded as null on a tenant still at 0023). The live rows can be rebuilt
  // from document versions, but an export must show what was live.
  // cms_migration_runs and content_live_reversed (also 0024) stay out: they
  // are the operator's cutover and reversal records, and this format carries
  // the store's own content and catalog, not operator tooling tables.
  "product_content_live",
  "collection_content_live",
  // Phase 9 line 2: subscriptions and their cycles (migration 0044; null before it)
  "subscriptions",
  "subscription_cycles",
  "search_outbox",
  // Phase 4 line 3: the plugin outbox (migration 0032; null on older stores).
  // Payloads carry no customer details. plugin_endpoints goes out below
  // without its signing secrets.
  "plugin_events",
  "plugin_deliveries",
  // Phase 9 line 1: reviews (migration 0040; null on older stores). No email
  // column: opt-outs are a hash.
  "review_invites",
  "reviews",
  "review_optouts",
  // Phase 9 line 3: WhatsApp consents (the words each shopper agreed to), templates and reminders (0042)
  "messaging_consents",
  "whatsapp_templates",
  "whatsapp_reminders",
];
const ENDPOINT_COLUMNS = "id, install_id, url, host, topics, prev_secret_until, status, paused_reason, paused_at, failing_since, created_by, created_at, updated_by, updated_at";
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
    const r = await client.execute(`SELECT ${ENDPOINT_COLUMNS} FROM plugin_endpoints`);
    data.plugin_endpoints = r.rows.map((row) => ({ ...row }));
    tables.plugin_endpoints = r.rows.length;
  } catch {
    tables.plugin_endpoints = null;
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
  // Phase 3 line 0: fail closed. The link is the only auth on the export GET,
  // so a missing secret must never fall back to a guessable key.
  const secret = process.env.PLATFORM_SECRET;
  if (!secret) throw new Error("PLATFORM_SECRET not set");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${secret}|export`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))).slice(0, 32);
}

// P3-A (Phase 3 audit): a link is single-use and valid for 15 minutes. Its
// token is x.<exp>.<jti>.<hmac(tenant|exp|jti)>; the control plane keeps a row
// per jti (platform migration 0018) that the download spends with one
// conditional UPDATE, so a second or concurrent use finds it spent.
export const EXPORT_LINK_TTL_MS = 15 * 60 * 1000;

export async function mintExportToken(tenantId, { operator = null, ttlMs = EXPORT_LINK_TTL_MS, now = Date.now() } = {}) {
  const exp = Math.floor((now + ttlMs) / 1000);
  const jti = hex(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await hmac(`${tenantId}|${exp}|${jti}`); // throws before any row is written when PLATFORM_SECRET is unset
  await platformDb().execute({
    sql: "INSERT INTO export_links (jti, tenant_id, operator_id, operator_kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [jti, String(tenantId), operator?.id != null ? String(operator.id) : null, operator?.kind != null ? String(operator.kind) : null, new Date(now).toISOString(), new Date(exp * 1000).toISOString()],
  });
  await pruneExportLinks({ now });
  return `x.${exp}.${jti}.${sig}`;
}

// The signature and the token's end only (no row is read or spent): → the jti, or null.
async function checkExportToken(tenantId, token, now) {
  const m = /^x\.(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(String(token || ""));
  if (!m) {
    await hmac(""); // still fail closed (throw) without PLATFORM_SECRET
    return null;
  }
  const exp = Number(m[1]);
  const expect = await hmac(`${tenantId}|${exp}|${m[2]}`);
  let diff = m[3].length ^ expect.length;
  for (let i = 0; i < expect.length; i++) diff |= (m[3].charCodeAt(i) || 0) ^ expect.charCodeAt(i);
  if (diff !== 0 || now > exp * 1000) return null;
  return m[2];
}

export async function verifyExportToken(tenantId, token, { now = Date.now() } = {}) {
  return (await checkExportToken(tenantId, token, now)) !== null;
}

// Spends the link: → { operator: { kind, id } | null } for the one use that
// wins, else null (bad signature, another store, past its end, or used).
// The spend and its tenant.export_downloaded audit row are one write batch
// (one transaction): the row is inserted only when this UPDATE changed the
// link, and if it can't be written the spend rolls back and this throws
// (code EXPORT_AUDIT_FAILED), so no export is served without its audit row.
// Throws when PLATFORM_SECRET is unset, so the caller fails closed.
export async function spendExportToken(tenantId, token, { now = Date.now() } = {}) {
  const jti = await checkExportToken(tenantId, token, now);
  if (!jti) return null;
  const at = new Date(now).toISOString();
  let results;
  try {
    results = await platformDb().batch(
      [
        {
          sql: "UPDATE export_links SET used_at = ? WHERE jti = ? AND tenant_id = ? AND used_at IS NULL AND expires_at > ? RETURNING operator_id, operator_kind",
          args: [at, jti, String(tenantId), at],
        },
        {
          // changes() is the UPDATE's row count: 0 when the link was already spent
          sql: `INSERT INTO audit_log (id, at, actor, actor_kind, tenant_id, action, resource, request_id, diff)
                SELECT ?, ?, COALESCE(operator_id, 'export-link'), COALESCE(operator_kind, 'system'), tenant_id, 'tenant.export_downloaded', ?, NULL, ?
                FROM export_links WHERE jti = ? AND changes() = 1`,
          args: [newId("a"), at, `tenant:${tenantId}`, JSON.stringify({ export_link_used: true }), jti],
        },
      ],
      "write",
    );
  } catch (e) {
    throw Object.assign(new Error("the export download couldn't be recorded"), { code: "EXPORT_AUDIT_FAILED", cause: e });
  }
  const row = results[0].rows[0];
  if (!row) return null;
  return { operator: row.operator_id ? { kind: String(row.operator_kind || "operator"), id: String(row.operator_id) } : null };
}

// ---- offboarding -------------------------------------------------------------

export async function offboardTenant(tenantId, { actor = { kind: "operator", id: "operator" } } = {}) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  const steps = [];

  // 1. suspend — hosts fail closed (S25), storefront + console go dark
  await patchTenant(tenantId, { status: "suspended" });
  steps.push("suspended (hosts fail closed)");

  // 2. key revocation — outstanding order links + bootstrap console sessions die
  // (Phase 3 line 2: the same rotation an operator runs from the store page)
  await rotateStoreSecrets(tenantId, ["order_link_secret", "admin_password"]);
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

  await audit({ actor: operatorActor(actor), action: "tenant.offboard", resource: `tenant:${tenantId}`, tenantId, diff: { offboarded: true, steps: steps.length } });
  slog("tenant_offboarded", { tenant: tenantId });
  return {
    tenant: tenantId,
    steps,
    kept: ["tenant database (export remains possible; delete manually when retention allows)", "control-plane row (suspended)", "billing ledger + audit history"],
  };
}
