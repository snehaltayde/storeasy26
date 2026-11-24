// Integration registry (Session 34 / BE24): one place that says, per tenant,
// which providers are connected, with what capability, how healthy, and how to
// revoke them. Presence flags and metadata ONLY — secret values never leave
// the server (same discipline as the settings view).
//
// Node-only (tests + revoke touch the control plane; the shopify test calls
// the Admin API).
import { currentTenant, tenantCfg, tenantOwnCfg, tenantOwnSecret, tenantId } from "./tenant-context.js";
import { patchTenant, platformConfigured, platformDb } from "./platform/control.js";
import { checkoutCapability } from "./commerce/adapter.js";
import { audit } from "./platform/audit.js";
import { slog } from "./log.js";

const has = (v) => Boolean(v);

async function lastWebhookAt() {
  if (!platformConfigured()) return null;
  try {
    const res = await platformDb().execute({
      sql: "SELECT received_at FROM webhook_inbox WHERE tenant_id = ? AND source = 'shopify' ORDER BY received_at DESC LIMIT 1",
      args: [tenantId()],
    });
    return res.rows[0]?.received_at ?? null;
  } catch {
    return null;
  }
}

async function lastForwardAt(column) {
  try {
    const { db } = await import("./db.js");
    const row = await db
      .selectFrom("events")
      .select((eb) => eb.fn.max(column).as("last"))
      .executeTakeFirst();
    return row?.last ?? null;
  } catch {
    return null;
  }
}

// The per-tenant provider table the console renders.
export async function integrationStatus() {
  const cfg = currentTenant()?.config || {};
  const razorpayKey = tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID", "");
  const capability = checkoutCapability();
  return [
    {
      provider: "shopify",
      kind: "commerce source of truth",
      connected: has(tenantOwnSecret("shopify_admin_token", "SHOPIFY_ADMIN_TOKEN")),
      store_domain: tenantOwnCfg("shopify_store_domain", "SHOPIFY_STORE_DOMAIN", "") || null,
      scopes: cfg.shopify_scopes || null,
      connected_at: cfg.shopify_connected_at || null,
      uninstalled_at: cfg.shopify_app_uninstalled_at || null,
      last_event_at: await lastWebhookAt(),
      actions: ["test", "revoke"],
      token_expires_at: cfg.shopify_token_expires_at || null,
      reauth_needed_at: cfg.shopify_reauth_needed_at || null,
      connect_hint: "The founder connects from onboarding step 1; operator connect flow: /api/connect/shopify/start?tenant=<slug> (or pnpm webhooks:register)",
    },
    {
      provider: "razorpay",
      kind: "payments",
      connected: has(razorpayKey) && has(tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET")),
      mode: razorpayKey.startsWith("rzp_live_") ? "live" : razorpayKey ? "test" : null,
      webhook: has(tenantOwnSecret("razorpay_webhook_secret", "RAZORPAY_WEBHOOK_SECRET")),
      checkout_mode: capability.mode,
      actions: ["test", "revoke"],
      connect_hint: "Settings → Payments",
    },
    {
      provider: "ga4",
      kind: "analytics (consent purpose: analytics)",
      connected: has(tenantOwnCfg("ga4_measurement_id", "NEXT_PUBLIC_GA4_MEASUREMENT_ID")) && has(tenantOwnSecret("ga4_api_secret", "GA4_API_SECRET")),
      last_forward_at: await lastForwardAt("ga4_sent_at"),
      actions: ["revoke"],
      connect_hint: "Settings → Tracking",
    },
    {
      provider: "meta",
      kind: "marketing (consent purpose: marketing)",
      connected: has(tenantOwnCfg("meta_pixel_id", "NEXT_PUBLIC_META_PIXEL_ID")) && has(tenantOwnSecret("meta_capi_token", "META_CAPI_TOKEN")),
      last_forward_at: await lastForwardAt("meta_sent_at"),
      actions: ["revoke"],
      connect_hint: "Settings → Tracking",
    },
    {
      provider: "typesense",
      kind: "search (SQL fallback when down)",
      connected: has(process.env.TYPESENSE_HOST),
      collection: tenantCfg("typesense_collection", "TYPESENSE_COLLECTION", "products"),
      platform_level: true, // cluster creds are platform env until the de-env phase
      actions: ["test"],
      connect_hint: "Platform env (TYPESENSE_*)",
    },
    {
      provider: "mail",
      kind: "transactional mail (invites, resets)",
      connected: has(process.env.RESEND_API_KEY),
      mock: !has(process.env.RESEND_API_KEY),
      platform_level: true,
      actions: [],
      connect_hint: "Platform env (RESEND_API_KEY, MAIL_FROM)",
    },
  ];
}

// Exercise a provider's credentials with the cheapest real call. Honest about
// what cannot be tested without side effects.
export async function testIntegration(provider) {
  try {
    if (provider === "shopify") {
      const { adminGraphql } = await import("./shopify-admin.js");
      const d = await adminGraphql(`query { shop { name myshopifyDomain } }`);
      return { ok: true, detail: `connected to ${d?.shop?.name} (${d?.shop?.myshopifyDomain})` };
    }
    if (provider === "razorpay") {
      const keyId = tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID", "");
      const secret = tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET", "");
      if (!keyId || !secret) return { ok: false, detail: "keys not configured" };
      const res = await fetch("https://api.razorpay.com/v1/orders?count=1", {
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` },
      });
      return res.ok
        ? { ok: true, detail: `credentials valid (${keyId.startsWith("rzp_live_") ? "LIVE" : "test"} mode)` }
        : { ok: false, detail: `Razorpay answered ${res.status} — check the key pair` };
    }
    if (provider === "typesense") {
      const host = process.env.TYPESENSE_HOST;
      if (!host) return { ok: false, detail: "not configured (SQL fallback active)" };
      const res = await fetch(`${process.env.TYPESENSE_PROTOCOL || "https"}://${host}:${process.env.TYPESENSE_PORT || 443}/health`);
      return res.ok ? { ok: true, detail: "cluster healthy" } : { ok: false, detail: `cluster answered ${res.status}` };
    }
    if (provider === "ga4" || provider === "meta") {
      return { ok: false, detail: "no side-effect-free test exists — watch the next event's forward stamps instead" };
    }
    if (provider === "mail") {
      const { sendMail, mailConfigured } = await import("./mail.js");
      if (!mailConfigured()) return { ok: false, detail: "mock mode (RESEND_API_KEY not set) — links print to server logs" };
      const r = await sendMail({ to: "delivered@resend.dev", subject: "storeasy mail test", text: "integration test" });
      return { ok: r.ok, detail: r.ok ? "provider accepted the message" : r.error };
    }
    return { ok: false, detail: `unknown provider "${provider}"` };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 200) };
  }
}

// Which tenant config/secret keys each revocable provider owns.
const REVOKE_MAP = {
  shopify: { secrets: ["shopify_admin_token", "shopify_refresh_token", "shopify_storefront_token"], config: ["shopify_scopes", "shopify_connected_at", "shopify_connected_by", "shopify_token_expires_at", "shopify_refresh_expires_at"] },
  razorpay: { secrets: ["razorpay_key_secret", "razorpay_webhook_secret"], config: ["razorpay_key_id"] },
  ga4: { secrets: ["ga4_api_secret"], config: ["ga4_measurement_id"] },
  meta: { secrets: ["meta_capi_token"], config: ["meta_pixel_id", "meta_test_event_code"] },
};

// Revoke = clear the tenant's stored credentials for the provider. Queued jobs
// that needed them start failing loudly into backoff/dead-letter (visible in
// OP05) instead of running on revoked credentials.
export async function revokeIntegration(provider, { actor }) {
  const map = REVOKE_MAP[provider];
  if (!map) throw new Error(`"${provider}" cannot be revoked from here`);
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("env-configured store — revoke by rotating the env vars");
  const secrets = Object.fromEntries(map.secrets.map((k) => [k, null]));
  const config = Object.fromEntries(map.config.map((k) => [k, null]));
  await patchTenant(tenant.id, { secrets, config });
  await audit({ actor, action: "integration.revoke", resource: `integration:${provider}`, diff: { cleared: [...map.secrets, ...map.config] } });
  slog("integration_revoked", { provider });
  return { revoked: provider, cleared: map.secrets.length + map.config.length };
}
