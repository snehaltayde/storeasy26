// Tenant provisioning (Session 21): create a tenant's own Turso database,
// apply the commerce schema, seed default offers, and register the tenant in
// the control plane.
//
// Database creation prefers the operator's authenticated `turso` CLI (no
// standing platform-wide API token on disk). If TURSO_API_TOKEN + TURSO_ORG
// are set, the Platform HTTP API is used instead (CI/automation opt-in).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { upsertTenant, getTenant } from "./control.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const tenantDbName = (slug) => `storeasy-t-${slug}`;

async function turso(args) {
  const { stdout } = await run("turso", args, { timeout: 120_000 });
  return stdout.trim();
}

// ---- database creation -------------------------------------------------------

async function createDbViaCli(slug) {
  const name = tenantDbName(slug);
  const existing = await turso(["db", "list"]).catch(() => "");
  if (!existing.includes(name)) {
    await turso(["db", "create", name]);
  }
  const dbUrl = await turso(["db", "show", name, "--url"]);
  const dbToken = await turso(["db", "tokens", "create", name]);
  return { dbUrl, dbToken, created: !existing.includes(name) };
}

async function createDbViaApi(slug) {
  const org = process.env.TURSO_ORG;
  const apiToken = process.env.TURSO_API_TOKEN;
  const name = tenantDbName(slug);
  const api = (path, init = {}) =>
    fetch(`https://api.turso.tech/v1/organizations/${org}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", ...init.headers },
    });

  let res = await api("/databases", {
    method: "POST",
    body: JSON.stringify({ name, group: process.env.TURSO_GROUP || "default" }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Turso create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const show = await api(`/databases/${name}`);
  if (!show.ok) throw new Error(`Turso show failed (${show.status})`);
  const { database } = await show.json();
  const tok = await api(`/databases/${name}/auth/tokens`, { method: "POST" });
  if (!tok.ok) throw new Error(`Turso token mint failed (${tok.status})`);
  const { jwt } = await tok.json();
  return { dbUrl: `libsql://${database.Hostname}`, dbToken: jwt, created: res.status !== 409 };
}

export async function createTenantDatabase(slug) {
  if (process.env.TURSO_API_TOKEN && process.env.TURSO_ORG) return createDbViaApi(slug);
  return createDbViaCli(slug);
}

// ---- schema + seed -----------------------------------------------------------

// Apply the commerce schema + one-time offer seed to ANY libsql client — the
// same bootstrap scripts/migrate.js runs for the default tenant. INSERT OR
// IGNORE keeps re-provisioning safe (admin-edited offers never overwritten).
export async function applyTenantSchema(client) {
  const schema = await readFile(join(here, "../schema.sql"), "utf8");
  await client.executeMultiple(schema);

  const { OFFERS } = await import("../offers/config.js");
  let seeded = 0;
  const now = new Date().toISOString();
  for (const offer of OFFERS) {
    const res = await client.execute({
      sql: "INSERT OR IGNORE INTO offers (id, type, label, enabled, config, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
      args: [offer.id, offer.type, offer.title || offer.id, JSON.stringify(offer), now, now],
    });
    seeded += Number(res.rowsAffected || 0);
  }
  return { seededOffers: seeded };
}

// ---- full flow ---------------------------------------------------------------

// Create (or adopt) the tenant database, bootstrap it, and register the tenant.
// Pass dbUrl/dbToken to adopt an existing database instead of creating one.
// Razorpay/GA4/Meta creds are intentionally absent — merchants add them in the
// console (S22); checkout stays COD-only until then.
export async function provisionTenant({
  id,
  name,
  domains = [],
  shopDomain,
  clientId = null,
  clientSecret = null,
  siteName = null,
  supportEmail = null,
  dbUrl = null,
  dbToken = null,
  force = false,
  log = () => {},
}) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id || "")) throw new Error("tenant id must be a slug");
  if (!shopDomain) throw new Error("shopDomain required (x.myshopify.com)");
  // upsertTenant REPLACES config/secrets — re-provisioning an onboarded tenant
  // would wipe its Shopify token and rotate its admin password. Use patchTenant
  // for edits; --force only for deliberate rebuilds.
  if (!force && (await getTenant(id))) throw new Error(`tenant "${id}" already exists (use force to re-provision)`);

  if (!dbUrl) {
    log(`→ creating Turso database ${tenantDbName(id)}…`);
    ({ dbUrl, dbToken } = await createTenantDatabase(id));
    log(`  ✓ ${dbUrl}`);
  }

  log("→ applying schema + seeding default offers…");
  const client = createClient({ url: dbUrl, authToken: dbToken || undefined });
  const { seededOffers } = await applyTenantSchema(client);
  client.close?.();
  log(`  ✓ schema applied (${seededOffers} offers seeded)`);

  // Per-tenant operational secrets the storefront needs from day one.
  const adminPassword = randomBytes(9).toString("base64url");
  const orderLinkSecret = randomBytes(32).toString("hex");

  const tenant = await upsertTenant({
    id,
    name: name || id,
    domains,
    dbUrl,
    dbToken,
    config: {
      shopify_store_domain: shopDomain,
      shopify_api_version: process.env.SHOPIFY_API_VERSION || "2025-10",
      ...(clientId ? { shopify_client_id: clientId } : {}),
      typesense_collection: `products_${id}`,
      site_url: domains[0] ? `https://${domains[0]}` : null,
      site: { name: siteName || name || id, ...(supportEmail ? { support_email: supportEmail } : {}) },
    },
    secrets: {
      ...(clientSecret ? { shopify_client_secret: clientSecret } : {}),
      admin_password: adminPassword,
      order_link_secret: orderLinkSecret,
    },
  });
  log(`✓ tenant "${id}" registered`);
  return { tenant, generated: { admin_password: adminPassword } };
}
