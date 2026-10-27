import { NextResponse, after } from "next/server";
import { getTenantsByShopDomain, patchTenant } from "@/lib/platform/control.js";
import { verifyWebhookHmac } from "@/lib/platform/shopify-webhooks.js";
import { recordWebhook, enqueueJob } from "@/lib/platform/jobs.js";
import { runJobById } from "@/lib/platform/worker.js";
import { sendAlert } from "@/lib/alerts";
import { slog } from "@/lib/log";

// Shopify webhook receiver (Session 21) — ONE URL for the whole platform.
// Tenant resolution is by X-Shopify-Shop-Domain (NOT Host), fanned out to ALL
// active tenants tracking that store (prod + staging mirrors share one dev
// store). Each tenant has its own custom-dist app, so the raw-body HMAC is
// checked against EACH tenant's client secret — verification doubles as proof
// the delivery belongs to that tenant's app registration.
//
// S29 (BE14): the receipt is PERSISTED BEFORE the 2xx — each verified delivery
// becomes a webhook_inbox row + a durable webhook_apply job per tenant. If the
// receipt can't be persisted we answer 500 and Shopify redelivers (no ack
// without durability). after() immediately runs the just-enqueued jobs (fast
// path); a crash after the ack loses nothing — the tick re-leases the job.
// The full-reconcile sync stays as the final backstop.
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

  try {
    JSON.parse(raw); // reject garbage before persisting it as a replayable receipt
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

  // Persist the receipt per tenant BEFORE acknowledging — the raw text is what
  // we store and replay.
  const jobIds = [];
  try {
    for (const t of tenants) {
      const inboxId = await recordWebhook({
        source: "shopify",
        topic,
        shopDomain: shop,
        tenantId: t.id,
        rawBody: raw,
        headers: { topic, webhook_id: webhookId },
        hmacOk: true,
      });
      const { id } = await enqueueJob({
        type: "webhook_apply",
        tenantId: t.id,
        payload: { inboxId },
        idempotencyKey: `wh:${inboxId}`,
      });
      jobIds.push(id);
    }
  } catch (e) {
    // No durable receipt → no ack. Shopify redelivers with backoff.
    console.error(`[shopify-webhook] receipt persist failed (${topic} ${shop}): ${e?.message || e}`);
    return NextResponse.json({ error: "Receipt not persisted, please redeliver" }, { status: 500 });
  }

  // Fast path: apply now, after the response. The atomic per-job lease means
  // the tick can never double-run these.
  after(async () => {
    for (const id of jobIds) {
      const r = await runJobById(id).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (r) slog("shopify_webhook_applied", { job: id, topic, shop, webhook_id: webhookId, ok: r.ok !== false });
    }
  });

  return NextResponse.json({ ok: true, topic, tenants: tenants.map((t) => t.id) });
}
