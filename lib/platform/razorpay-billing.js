// Razorpay Subscriptions client (S40 / BE11). Node-only, PLATFORM-scoped:
// the platform bills merchants from ITS OWN Razorpay account —
// PLATFORM_RAZORPAY_KEY_ID / PLATFORM_RAZORPAY_KEY_SECRET /
// PLATFORM_RAZORPAY_WEBHOOK_SECRET — entirely separate from any tenant's
// checkout keys. Unconfigured is a first-class state: callers get
// { configured: false } and surface honest copy instead of mocking money.
// Edge-bundle-safe: node:crypto loads lazily inside the HMAC verify (its only
// caller, the webhook route, runs on Node).

export const billingProviderConfigured = () =>
  Boolean(process.env.PLATFORM_RAZORPAY_KEY_ID && process.env.PLATFORM_RAZORPAY_KEY_SECRET);

async function rp(path, { method = "GET", body = null } = {}) {
  const auth = btoa(`${process.env.PLATFORM_RAZORPAY_KEY_ID}:${process.env.PLATFORM_RAZORPAY_KEY_SECRET}`);
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay ${res.status}: ${json?.error?.description || JSON.stringify(json).slice(0, 200)}`);
  return json;
}

// Mirror a catalog plan into Razorpay (lazily, once per plan version).
export async function createProviderPlan(plan) {
  if (!billingProviderConfigured()) return { configured: false };
  const r = await rp("/plans", {
    method: "POST",
    body: {
      period: plan.interval === "year" ? "yearly" : "monthly",
      interval: 1,
      item: { name: `${plan.name} (v${plan.version})`, amount: plan.price, currency: plan.currency },
      notes: { plan_id: plan.id, plan_version: String(plan.version) },
    },
  });
  return { configured: true, razorpayPlanId: r.id };
}

// Create the provider subscription the merchant authorizes via short_url.
export async function createProviderSubscription(plan, { tenantId }) {
  if (!billingProviderConfigured()) return { configured: false };
  const r = await rp("/subscriptions", {
    method: "POST",
    body: {
      plan_id: plan.razorpay_plan_id,
      total_count: plan.interval === "year" ? 10 : 120, // provider requires a horizon
      customer_notify: 1,
      notes: { tenant_id: tenantId, plan_id: plan.id, plan_version: String(plan.version) },
    },
  });
  return { configured: true, id: r.id, status: r.status, shortUrl: r.short_url || null };
}

// Cancel a provider subscription (Phase 3 line 3). POST
// /v1/subscriptions/{id}/cancel; Razorpay's own default is to cancel NOW, so
// cancel_at_cycle_end is always sent, true unless the caller asks otherwise
// (checked in Razorpay's docs 2026-11-25). The subscription's status still
// moves only through the webhook that follows (subscription.cancelled).
export async function cancelProviderSubscription(razorpaySubscriptionId, { atCycleEnd = true } = {}) {
  if (!billingProviderConfigured()) return { configured: false };
  if (!razorpaySubscriptionId) throw new Error("no provider subscription to cancel");
  const r = await rp(`/subscriptions/${encodeURIComponent(razorpaySubscriptionId)}/cancel`, {
    method: "POST",
    body: { cancel_at_cycle_end: atCycleEnd !== false },
  });
  return { configured: true, id: r.id, status: r.status || null };
}

// Webhook HMAC (same scheme as checkout webhooks, PLATFORM secret). Async +
// Web Crypto since S42 (edge-bundle-safe), constant-time compare.
export async function verifyBillingWebhookSignature(rawBody, signature) {
  const secret = process.env.PLATFORM_RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(rawBody)));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = String(signature);
  let diff = expected.length ^ given.length;
  const n = Math.max(expected.length, given.length);
  for (let i = 0; i < n; i++) diff |= (expected.charCodeAt(i % expected.length) || 0) ^ (given.charCodeAt(i % given.length) || 0);
  return diff === 0;
}
