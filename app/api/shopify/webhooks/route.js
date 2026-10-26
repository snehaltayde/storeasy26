import { NextResponse, after } from "next/server";
import { getTenantsByShopDomain, patchTenant } from "@/lib/platform/control.js";
import { verifyWebhookHmac, applyWebhook } from "@/lib/platform/shopify-webhooks.js";
import { withTenant } from "@/lib/tenant-context.js";
import { sendAlert } from "@/lib/alerts";
import { slog } from "@/lib/log";

// Shopify webhook receiver (Session 21) — ONE URL for the whole platform.
// Tenant resolution is by X-Shopify-Shop-Domain (NOT Host), fanned out to ALL
// active tenants tracking that store (prod + staging mirrors share one dev
// store). Each tenant has its own custom-dist app, so the raw-body HMAC is
// checked against EACH tenant's client secret — verification doubles as proof
// the delivery belongs to that tenant's app registration.
//
// Shopify wants a fast 2xx (5s timeout, repeated failures disable the
// subscription), so the refetch work runs in after(): deliveries are hints,
// targeted refetch is idempotent, and the full-reconcile sync is the backstop
// for anything dropped.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request) {
  const raw = await request.text();
  const topic = request.headers.get("x-shopify-topic") || "";
  const shop = request.headers.get("x-shopify-shop-domain") || "";
  const hmac = request.headers.get("x-shopify-hmac-sha256") || "";
  const webhookId = request.headers.get("x-shopify-webhook-id") || null;

  if (!topic || !shop || !hmac) return NextResponse.json({ error: "Missing Shopify headers" }, { status: 400 });

  const candidates = await getTenantsByShopDomain(shop);
  if (!candidates.length) {
    // Not a store we track — answering 200 stops pointless redeliveries.
    console.warn(`[shopify-webhook] no tenant for shop ${shop} (${topic})`);
    return NextResponse.json({ ok: true, ignored: "unknown_shop" });
  }

  const tenants = candidates.filter((t) => verifyWebhookHmac(raw, hmac, t.secrets?.shopify_client_secret));
  if (!tenants.length) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // app/uninstalled: flag + alert inline (fast, must not be lost). The tenant
  // stays active — the storefront keeps serving the cached catalog while the
  // operator sorts out the reinstall.
  if (topic === "app/uninstalled") {
    for (const t of tenants) {
      await patchTenant(t.id, { config: { shopify_app_uninstalled_at: new Date().toISOString() } });
      await sendAlert(`Shopify app UNINSTALLED for tenant ${t.id} (${shop}) — catalog sync and order push will fail until reconnected`, { tenant: t.id, shop });
    }
    slog("shopify_app_uninstalled", { shop, tenants: tenants.map((t) => t.id), webhook_id: webhookId });
    return NextResponse.json({ ok: true, tenants: tenants.map((t) => t.id) });
  }

  after(async () => {
    for (const t of tenants) {
      try {
        const result = await withTenant(t, () => applyWebhook(topic, payload));
        slog("shopify_webhook_applied", { tenant: t.id, topic, shop, webhook_id: webhookId, ...result });
      } catch (e) {
        // No redelivery after a 200 — surface loudly; the reconcile sync heals.
        console.error(`[shopify-webhook] ${t.id} ${topic} failed: ${e?.message || e}`);
      }
    }
  });

  return NextResponse.json({ ok: true, topic, tenants: tenants.map((t) => t.id) });
}
