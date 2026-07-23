// Cancel ONE order on both sides (test-order hygiene / future cancel flow):
//   pnpm order:cancel BL-XXXXXXXX [reason]
// 1. If the order synced to Shopify → orderCancel there (restock, no refund,
//    no customer email). 2. Transition our row → cancelled (audit-logged).
// Refuses paid-but-unsynced Razorpay orders (that's refund territory).
import { db } from "../lib/db.js";
import { transitionOrder, ORDER_STATUS } from "../lib/orders.js";
import { adminGraphql } from "../lib/shopify-admin.js";

const orderId = process.argv[2];
const reason = process.argv[3] || "test order cleanup";
if (!orderId) {
  console.error("usage: pnpm order:cancel BL-XXXXXXXX [reason]");
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
if (order.status === ORDER_STATUS.PAID) {
  console.error(`✗ ${orderId} is paid but not synced — cancelling captured money means a refund; not automated`);
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
  meta: { reason, via: "cancel-order-cli", shopify_order_id: order.shopify_order_id || undefined },
});
console.log(`✓ ${orderId}: ${order.status} → cancelled${r.already ? " (already)" : ""}`);
process.exit(0);
