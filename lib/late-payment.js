// Phase 9 line 2 review: a payment captured for an order that is cancelled (a
// renewal attempt replaced by another, or any cancelled order) can't be
// applied, and the shopper's money must go back. SERVER-ONLY. Once per
// order + payment: an order event the order page shows as a banner with the
// refund steps (components/admin/orders/LatePaymentBanner.js), and an email to
// the store's support address. Nothing here moves money: the refund is done in
// Razorpay (docs/refunds.md), as for every other refund.
import { db } from "./db.js";
import { tenantCfg } from "./tenant-context.js";
import { formatMoney } from "./format.js";
import { slog } from "./log.js";

export const LATE_PAYMENT_REASON = "payment_on_replaced_order";

export async function recordPaymentOnCancelled(orderId, razorpayPaymentId) {
  const order = await db.selectFrom("orders").select(["id", "status", "total", "currency"]).where("id", "=", orderId).executeTakeFirst();
  if (!order || order.status !== "cancelled" || !razorpayPaymentId) return false;
  const marker = `"late_payment":"${String(razorpayPaymentId).replace(/"/g, "")}"`;
  const seen = await db.selectFrom("order_events").select(["id"]).where("order_id", "=", orderId).where("meta", "like", `%${marker}%`).executeTakeFirst();
  if (seen) return false;
  await db
    .insertInto("order_events")
    .values({ order_id: orderId, from_status: "cancelled", to_status: "cancelled", meta: JSON.stringify({ reason: LATE_PAYMENT_REASON, late_payment: String(razorpayPaymentId), amount: Number(order.total), currency: order.currency || "INR" }), created_at: new Date().toISOString() })
    .execute();
  slog("payment_on_cancelled_order", { order_id: orderId, razorpay_payment_id: razorpayPaymentId });
  try {
    const { notify } = await import("./notifications.js");
    const site = tenantCfg("site", null, null) || {};
    await notify({
      type: "payment_on_replaced_order",
      to: site.support_email || "",
      subject: `A payment arrived for a replaced order; refund it (${orderId})`,
      text: [
        `A payment arrived for a replaced order; refund it.`,
        `Order ${orderId} was cancelled (it was replaced by another order for the same delivery), and then Razorpay captured payment ${razorpayPaymentId} of ${formatMoney(Number(order.total), order.currency || "INR")} for it.`,
        "To refund it: open your Razorpay dashboard, go to Transactions → Payments, search for the payment id above, and press Refund for the full amount. The shopper's other order for this delivery is unaffected.",
      ].join("\n\n"),
      idempotencyKey: `latepay:${orderId}:${razorpayPaymentId}`,
    });
  } catch (e) {
    slog("payment_on_cancelled_notify_failed", { order_id: orderId, error: String(e?.message || e).slice(0, 200) });
  }
  return true;
}
