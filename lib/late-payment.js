// Phase 9 line 2 review: a payment captured for an order that is cancelled (a
// renewal attempt replaced by another, or any cancelled order) can't be
// applied, and the shopper's money must go back. SERVER-ONLY. Once per
// order + payment: an order event the order page shows as a banner with the
// refund steps (components/admin/orders/LatePaymentBanner.js), and an email to
// the store's support address. Nothing here moves money: the refund is done in
// Razorpay (docs/refunds.md), as for every other refund.
import { db, libsql } from "./db.js";
import { tenantCfg, tenantId } from "./tenant-context.js";
import { formatMoney } from "./format.js";
import { slog } from "./log.js";

export const LATE_PAYMENT_REASON = "payment_on_replaced_order";

export async function recordPaymentOnCancelled(orderId, razorpayPaymentId) {
  const order = await db.selectFrom("orders").select(["id", "status", "total", "currency"]).where("id", "=", orderId).executeTakeFirst();
  if (!order || order.status !== "cancelled" || !razorpayPaymentId) return false;
  const pay = String(razorpayPaymentId).replace(/["\\]/g, "");
  const meta = JSON.stringify({ reason: LATE_PAYMENT_REASON, late_payment: pay, amount: Number(order.total), currency: order.currency || "INR" });
  // one statement: two deliveries of the same capture at once write one flag
  const res = await libsql.execute({
    sql: `INSERT INTO order_events (order_id, from_status, to_status, meta, created_at)
          SELECT ?, 'cancelled', 'cancelled', ?, ? WHERE NOT EXISTS (SELECT 1 FROM order_events WHERE order_id = ? AND instr(meta, ?) > 0)`,
    args: [orderId, meta, new Date().toISOString(), orderId, `"late_payment":"${pay}"`],
  });
  if (!res.rowsAffected) return false;
  slog("payment_on_cancelled_order", { order_id: orderId, razorpay_payment_id: razorpayPaymentId });
  try {
    const { notify } = await import("./notifications.js");
    const site = tenantCfg("site", null, null) || {};
    await notify({
      type: "payment_on_replaced_order",
      to: site.support_email || (await ownerEmail()) || "",
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

// No support address set: the store's owner (a member with the owner role).
async function ownerEmail() {
  try {
    const { platformDb, platformConfigured } = await import("./platform/control.js");
    if (!platformConfigured() || !tenantId()) return null;
    const r = await platformDb().execute({
      sql: "SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = 'owner' ORDER BY m.created_at ASC LIMIT 1",
      args: [tenantId()],
    });
    return r.rows[0]?.email ? String(r.rows[0].email) : null;
  } catch {
    return null;
  }
}
