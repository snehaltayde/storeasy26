// Cancel ONE order on both sides (test-order hygiene / manual cancel flow):
//   pnpm order:cancel BL-XXXXXXXX [reason]
//   pnpm order:cancel BL-XXXXXXXX [reason] --refunded rfnd_XXXX
// 1. If the order synced to Shopify → orderCancel there (restock, no refund,
//    no customer email). 2. Transition our row → cancelled (audit-logged).
// Orders whose money was CAPTURED require --refunded <razorpay_refund_id>:
// do the Razorpay refund manually first (docs/refunds.md), then record it here.
import { db } from "../lib/db.js";
import { transitionOrder, ORDER_STATUS } from "../lib/orders.js";
import { adminGraphql } from "../lib/shopify-admin.js";

const argv = process.argv.slice(2);
const refundedIdx = argv.indexOf("--refunded");
const refundId = refundedIdx >= 0 ? argv[refundedIdx + 1] : null;
const positional = argv.filter(
  (a, i) => a !== "--refunded" && (refundedIdx < 0 || i !== refundedIdx + 1),
);
const orderId = positional[0];
const reason = positional[1] || "test order cleanup";
if (!orderId || (refundedIdx >= 0 && !refundId)) {
  console.error("usage: pnpm order:cancel BL-XXXXXXXX [reason] [--refunded rfnd_XXXX]");
  process.exit(1);
}

const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
if (!order) {
  console.error(`✗ ${orderId} not found`);
  process.exit(1);
}
if (order.status === ORDER_STATUS.CANCELLED) {
  console.log(`• ${orderId} is already cancelled`);
  process.exit(0);
}
const moneyCaptured = order.payment_status === "paid";
if (moneyCaptured && !refundId) {
  console.error(
    `✗ ${orderId} has a CAPTURED payment (${order.razorpay_payment_id || "?"}, ₹${order.total}).\n` +
      `  Refund it in Razorpay first (docs/refunds.md), then re-run with --refunded rfnd_XXXX`,
  );
  process.exit(1);
}

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
  if (errs.length) {
    console.error(`✗ Shopify cancel failed: ${JSON.stringify(errs)}`);
    process.exit(1);
  }
  console.log(`• Shopify order ${order.shopify_order_id} cancelled (restocked, no refund, no email)`);
}

const r = await transitionOrder(orderId, ORDER_STATUS.CANCELLED, {
  meta: {
    reason,
    via: "cancel-order-cli",
    shopify_order_id: order.shopify_order_id || undefined,
    ...(refundId ? { razorpay_refund_id: refundId, refunded_amount: order.total } : {}),
  },
});
console.log(`✓ ${orderId}: ${order.status} → cancelled${r.already ? " (already)" : ""}`);
process.exit(0);
