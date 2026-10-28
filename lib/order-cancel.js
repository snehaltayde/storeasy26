// Cancel ONE order on both sides (S51) — the shared engine behind the admin
// console action (POST /api/admin/orders/[id] {action:"cancel"}) and
// scripts/cancel-order.js. Policy is unchanged from the CLI era:
//   1. Only transitions the state machine allows (lib/orders.js TRANSITIONS).
//   2. CAPTURED money is never dropped: a paid order needs a Razorpay refund
//      done first (docs/refunds.md) and its refund id recorded here.
//   3. If the order reached Shopify, it is cancelled THERE first — restock,
//      no refund, no customer email — so the two sides never diverge.
// Returns { ok, status, … } instead of throwing for expected refusals, so the
// API route can pass the result straight through.
import { db } from "./db.js";
import { transitionOrder, canTransition, ORDER_STATUS } from "./orders.js";
import { adminGraphql } from "./shopify-admin.js";

export async function cancelOrder(orderId, { reason = "cancelled by merchant", refundId = null, via = "admin-console" } = {}) {
  const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
  if (!order) return { ok: false, status: 404, error: "Order not found" };
  if (order.status === ORDER_STATUS.CANCELLED)
    return { ok: true, status: 200, already: true, from: ORDER_STATUS.CANCELLED };
  if (!canTransition(order.status, ORDER_STATUS.CANCELLED))
    return {
      ok: false,
      status: 409,
      code: "INVALID_TRANSITION",
      error: `A ${order.status} order can't be cancelled — wait for the Shopify push to settle, then retry.`,
    };

  const moneyCaptured = order.payment_status === "paid";
  if (moneyCaptured && !refundId)
    return {
      ok: false,
      status: 409,
      code: "REFUND_REQUIRED",
      error: `Payment is captured (${order.razorpay_payment_id || "?"}, ₹${order.total}). Refund it in Razorpay first (docs/refunds.md), then record the rfnd_… id with the cancellation.`,
    };

  // Shopify first: if this fails, our row stays untouched and a retry is safe.
  let shopifyCancelled = false;
  if (order.shopify_order_id) {
    const data = await adminGraphql(
      `mutation($id: ID!, $reason: OrderCancelReason!, $staffNote: String) {
        orderCancel(orderId: $id, reason: $reason, refund: false, restock: true, notifyCustomer: false, staffNote: $staffNote) {
          job { id }
          orderCancelUserErrors { field message }
        }
      }`,
      { id: order.shopify_order_id, reason: "OTHER", staffNote: `storeasy26: ${reason}` },
    );
    const errs = data?.orderCancel?.orderCancelUserErrors || [];
    if (errs.length)
      return { ok: false, status: 502, code: "SHOPIFY_CANCEL_FAILED", error: `Shopify cancel failed: ${errs.map((e) => e.message).join("; ")}` };
    shopifyCancelled = true;
  }

  const r = await transitionOrder(orderId, ORDER_STATUS.CANCELLED, {
    meta: {
      reason,
      via,
      shopify_order_id: order.shopify_order_id || undefined,
      ...(refundId ? { razorpay_refund_id: refundId, refunded_amount: order.total } : {}),
    },
  });
  return { ok: true, status: 200, already: !!r.already, from: order.status, shopifyCancelled };
}
