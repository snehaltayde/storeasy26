// Razorpay Subscriptions client (S40 / BE11). Node-only, PLATFORM-scoped:
// the platform bills merchants from ITS OWN Razorpay account —
// PLATFORM_RAZORPAY_KEY_ID / PLATFORM_RAZORPAY_KEY_SECRET /
// PLATFORM_RAZORPAY_WEBHOOK_SECRET — entirely separate from any tenant's
// checkout keys. Unconfigured is a first-class state: callers get
// { configured: false } and surface honest copy instead of mocking money.
import crypto from "node:crypto";

export const billingProviderConfigured = () =>
  Boolean(process.env.PLATFORM_RAZORPAY_KEY_ID && process.env.PLATFORM_RAZORPAY_KEY_SECRET);

async function rp(path, { method = "GET", body = null } = {}) {
  const auth = Buffer.from(`${process.env.PLATFORM_RAZORPAY_KEY_ID}:${process.env.PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64");
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

// Webhook HMAC (same scheme as checkout webhooks, PLATFORM secret).
export function verifyBillingWebhookSignature(rawBody, signature) {
  const secret = process.env.PLATFORM_RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
