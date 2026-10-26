import crypto from "node:crypto";
import { tenantCfg, tenantSecret } from "./tenant-context.js";

// Razorpay helper (SERVER-ONLY, Node runtime). Key id is public; secret never
// leaves the server. Test-mode keys start with rzp_test_. Session 20: each
// tenant brings their OWN keys (custom-checkout model); env is the fallback.
export const razorpayKeyId = () => tenantCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID");
const razorpayKeySecret = () => tenantSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET");

export function razorpayConfigured() {
  return Boolean(razorpayKeyId() && razorpayKeySecret());
}

export async function createRazorpayOrder({ amountPaise, receipt, currency = "INR" }) {
  const keyId = razorpayKeyId();
  const keySecret = razorpayKeySecret();
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountPaise, currency, receipt, payment_capture: 1 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Razorpay order create failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text); // { id: "order_...", amount, currency, ... }
}

const razorpayWebhookSecret = () => tenantSecret("razorpay_webhook_secret", "RAZORPAY_WEBHOOK_SECRET");

export function webhookConfigured() {
  return Boolean(razorpayWebhookSecret());
}

// Verify a webhook delivery: HMAC_SHA256 over the RAW request body with the
// WEBHOOK secret — a separate secret chosen when creating the webhook in the
// Razorpay dashboard/API, NOT the key secret. Env-driven: test secret on
// test-mode webhooks, live secret once BeastLife's live account is wired.
export function verifyRazorpayWebhookSignature(rawBody, signature) {
  const secret = razorpayWebhookSecret();
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Verify the checkout callback signature: HMAC_SHA256(order_id|payment_id, secret).
export function verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const keySecret = razorpayKeySecret();
  if (!keySecret || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));
  } catch {
    return false;
  }
}
