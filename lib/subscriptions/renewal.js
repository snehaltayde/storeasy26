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
import { previewRenewals } from "../cart.js";
import { paymentTerms } from "../checkout/payment-terms.js";
import { tenantShippingConfig, currentTenant } from "../tenant-context.js";
import { marketPaymentConfig } from "../markets.js";
import { razorpayConfigured, fetchRazorpayOrder } from "../razorpay.js";
import { smsAvailable } from "../messaging/sms.js";
import { DAY } from "./pricing.js";
import { subscriptionClock } from "./store.js";

// → { amount, currency, method: "prepaid" | "cod", available }
export async function renewalFigure(sub) {
  return (await renewalFigures([sub]))[0];
}

// Many at once (the console's list): one read of the first orders' PIN codes
// and one batched pricing (lib/cart.js previewRenewals).
export async function renewalFigures(subs) {
  if (!subs.length) return [];
  const origins = [...new Set(subs.map((s) => s.origin_order_id).filter(Boolean))];
  const pins = new Map((origins.length ? await db.selectFrom("orders").select(["id", "pincode"]).where("id", "in", origins).execute() : []).map((o) => [o.id, o.pincode || null]));
  const carts = await previewRenewals(subs);
  const shippingConfig = tenantShippingConfig();
  const paymentConfig = marketPaymentConfig(currentTenant()?.config?.payment_config ?? null, null);
  return subs.map((sub, k) => {
    const cart = carts[k];
    const terms = paymentTerms({ cart, shippingConfig, paymentConfig, pincode: pins.get(sub.origin_order_id) ?? null, prepaidAvailable: razorpayConfigured(), smsAvailable: smsAvailable(), outsideBase: false });
    const prepaid = terms.prepaid.available;
    return {
      amount: prepaid ? terms.prepaid.total : terms.cod.total,
      currency: cart.currency || "INR",
      method: prepaid ? "prepaid" : "cod",
      available: cart.items.length > 0 && cart.items.every((i) => i.available),
    };
  });
}

// Phase 9 line 2 review: an online attempt for this cycle that was never paid
// (the shopper closed the payment window) doesn't lock the delivery. The
// checkout asks first (read only); just before placing the new attempt, the
// old one is cancelled and its key renamed in one conditional write, so two
// racing attempts still end with one order under the cycle's key (the loser
// meets the UNIQUE key). → the stale order row, or null
export async function unpaidRenewalAttempt(key, { cartId, method, total, sameAmount }) {
  const row = await db.selectFrom("orders").select(["id", "status", "cart_id", "payment_method", "total", "currency", "razorpay_order_id"]).where("idempotency_key", "=", key).executeTakeFirst();
  if (!row || row.status !== "pending_payment" || row.payment_method !== "razorpay") return null;
  // the same online attempt again reopens the same payment (the checkout's own dedup)
  if (method === "razorpay" && row.cart_id === cartId && sameAmount(row.total, total, row.currency || "INR")) return null;
  return row;
}
// Replaced only when Razorpay says nobody has started paying it ("created"):
// an attempted or paid order may still capture, and a delivery is never paid
// twice. → { ok: true } | { ok: false, pending: true } (then the caller refuses
// in plain words) | { ok: false } (lost a race)
export const PAYMENT_GOING_THROUGH = "Your online payment for this delivery is still going through. Check back in a few minutes.";
export async function supersedeRenewalAttempt(row, key) {
  try {
    const rz = row.razorpay_order_id ? await fetchRazorpayOrder(row.razorpay_order_id) : null;
    if (!rz || rz.status !== "created") return { ok: false, pending: true };
  } catch {
    return { ok: false, pending: true }; // can't tell: never risk a second payment
  }
  const ts = new Date().toISOString();
  const res = await libsql.execute({
    sql: "UPDATE orders SET status = 'cancelled', idempotency_key = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment' AND idempotency_key = ?",
    args: [`${key}:superseded:${row.id}`, ts, row.id, key],
  });
  if (!res.rowsAffected) return { ok: false };
  await libsql.execute({
    sql: "INSERT INTO order_events (order_id, from_status, to_status, meta, created_at) VALUES (?, 'pending_payment', 'cancelled', ?, ?)",
    args: [row.id, JSON.stringify({ reason: "renewal_superseded", note: "an unpaid online attempt replaced by a new attempt for the same delivery" }), ts],
  });
  return { ok: true };
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
        sql: "INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, price_at_add, added_at, subscription_interval, renewal) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
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
