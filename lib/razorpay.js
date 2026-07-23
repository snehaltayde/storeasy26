import crypto from "node:crypto";

// Razorpay helper (SERVER-ONLY, Node runtime). Key id is public; secret never
// leaves the server. Test-mode keys start with rzp_test_.
export function razorpayConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export async function createRazorpayOrder({ amountPaise, receipt, currency = "INR" }) {
  const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
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

export function webhookConfigured() {
  return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
}

// Verify a webhook delivery: HMAC_SHA256 over the RAW request body with the
// WEBHOOK secret — a separate secret chosen when creating the webhook in the
// Razorpay dashboard/API, NOT the key secret. Env-driven: test secret on
// test-mode webhooks, live secret once BeastLife's live account is wired.
export function verifyRazorpayWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
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
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
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
