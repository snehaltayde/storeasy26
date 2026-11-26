// Phase 9 line 2: a subscription's next delivery. SERVER-ONLY, tenant-scoped.
//
// renewalFigure(sub)  what the next delivery costs today: the renewal cart's
//   own pricing (lib/cart.js previewRenewal) through the checkout's payment
//   terms for the address of the order it came from, online payment when the
//   store takes it, else cash on delivery. The reminder email, the account's
//   "Next delivery" and the console's "Next amount" all read this one number,
//   and it is the checkout's total for that cart, method and PIN code today.
// startRenewalCart(sub)  "Pay for this delivery": a cart holding only this
//   subscription's line for its current cycle (the same cart again if one was
//   started for that cycle), which the checkout then prices and places under
//   the cycle's own idempotency key.
import { db, libsql } from "../db.js";
import { previewRenewal } from "../cart.js";
import { paymentTerms } from "../checkout/payment-terms.js";
import { tenantShippingConfig, currentTenant } from "../tenant-context.js";
import { marketPaymentConfig } from "../markets.js";
import { razorpayConfigured } from "../razorpay.js";
import { smsAvailable } from "../messaging/sms.js";
import { DAY } from "./pricing.js";
import { subscriptionClock } from "./store.js";

async function lastPincode(sub) {
  const o = await db.selectFrom("orders").select(["pincode"]).where("id", "=", sub.origin_order_id).executeTakeFirst();
  return o?.pincode || null;
}

// → { amount, currency, method: "prepaid" | "cod", available }
export async function renewalFigure(sub, { pincode } = {}) {
  const cart = await previewRenewal(sub);
  const terms = paymentTerms({
    cart,
    shippingConfig: tenantShippingConfig(),
    paymentConfig: marketPaymentConfig(currentTenant()?.config?.payment_config ?? null, null),
    pincode: pincode === undefined ? await lastPincode(sub) : pincode,
    prepaidAvailable: razorpayConfigured(),
    smsAvailable: smsAvailable(),
    outsideBase: false,
  });
  const prepaid = terms.prepaid.available;
  return {
    amount: prepaid ? terms.prepaid.total : terms.cod.total,
    currency: cart.currency || "INR",
    method: prepaid ? "prepaid" : "cod",
    available: cart.items.length > 0 && cart.items.every((i) => i.available),
  };
}

// Can this delivery be paid for now? Active, and inside the reminder window
// (the sweep marks the cycle due at the same moment).
export function payableNow(sub, settings, now = subscriptionClock.now()) {
  if (!sub || sub.status !== "active" || !settings) return false;
  return Date.parse(sub.next_due_at) - settings.reminderDays * DAY <= now;
}

// → the renewal cart's id
export async function startRenewalCart(sub) {
  const cycle = Number(sub.cycle);
  const existing = await db
    .selectFrom("carts")
    .select(["id"])
    .where("subscription_id", "=", sub.id)
    .where("subscription_cycle", "=", cycle)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  const id = existing?.id || crypto.randomUUID();
  const ts = new Date(subscriptionClock.now()).toISOString();
  const variant = await db.selectFrom("variants").select(["id", "product_id", "price"]).where("id", "=", sub.variant_id).executeTakeFirst();
  if (!variant) throw Object.assign(new Error("variant gone"), { code: "VARIANT_GONE" });
  await libsql.batch(
    [
      existing
        ? { sql: "UPDATE carts SET coupon_code = NULL, updated_at = ? WHERE id = ?", args: [ts, id] }
        : { sql: "INSERT INTO carts (id, coupon_code, created_at, updated_at, subscription_id, subscription_cycle) VALUES (?, NULL, ?, ?, ?, ?)", args: [id, ts, ts, sub.id, cycle] },
      { sql: "DELETE FROM cart_items WHERE cart_id = ?", args: [id] },
      {
        sql: "INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, price_at_add, added_at, subscription_interval) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [id, variant.id, variant.product_id, Number(sub.quantity), Number(variant.price) || null, ts, Number(sub.interval_days)],
      },
    ],
    "write",
  );
  return id;
}

// The checkout's check of a renewal cart (app/api/checkout/route.js): it must
// still be this shopper's, active, payable, and hold exactly the
// subscription's line. → null, or the words for a 409.
export function renewalProblem(cart, sub, customerId, settings) {
  if (!sub || sub.customer_id !== customerId) return "This delivery isn't on your account. Open your account and try again.";
  if (!settings) return "Subscriptions are turned off for this store right now. Nothing was charged.";
  if (sub.status !== "active") return "This subscription isn't active. Resume it from your account first.";
  if (!payableNow(sub, settings)) return "This delivery isn't due yet. You can pay for it from your account once it is.";
  const line = cart.items.find((i) => i.variantId === sub.variant_id);
  if (cart.items.length !== 1 || !line || line.quantity !== Number(sub.quantity) || !line.subscription?.active)
    return "This delivery changed. Open your account and press Pay for this delivery again.";
  return null;
}
