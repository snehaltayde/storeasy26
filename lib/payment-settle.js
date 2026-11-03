// What happens around a captured payment, shared by the browser callback, the
// Razorpay webhook and the durable jobs. SERVER-ONLY.
//
// "Already paid" doesn't prove the work after the payment was done: the request
// that flipped the status can die first, or lose the response. So runOrderEffects
// runs on replays too, and each step is safe to repeat on its own terms.
import { db } from "./db.js";
import { clearCart } from "./cart.js";
import { enqueueShopifyPush } from "./shopify-push.js";
import { enqueuePurchaseAndForward } from "./events.js";
import { recordConversions } from "./experiments.js";
import { runAutomationsFor } from "./automations.js";
import {
  getOrderRazorpayId,
  findOrderByRazorpayOrderId,
  markOrderPaid,
  orderConfirmationPath,
  ORDER_STATUS,
} from "./orders.js";
import { verifyRazorpaySignature } from "./razorpay.js";
import { enqueueDurable } from "./platform/jobs.js";
import { tenantId } from "./tenant-context.js";
import { slog } from "./log.js";

const paidOrder = (orderId) => db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();

// Clears the cart that paid for this order, unless the customer has touched it
// since paying: a late replay must not wipe what they have added after.
export async function clearPaidCart(orderId) {
  const order = await paidOrder(orderId);
  if (!order?.cart_id || !order.paid_at) return;
  const cart = await db.selectFrom("carts").select("updated_at").where("id", "=", order.cart_id).executeTakeFirst();
  if (cart && cart.updated_at <= order.paid_at) await clearCart(order.cart_id);
}

// The work after an order is placed (COD) or paid. Repeat-safe: the cart clear above
// is guarded, a push only starts from a never-pushed status (a replay mustn't use up
// a failed push's retries), the purchase event dedupes on event_id, and conversions
// and automations are keyed per order.
export async function runOrderEffects(orderId, { expUnit = null } = {}) {
  const logFailure = (step) => (e) => console.error(`[paid-effects] ${step} ${orderId}: ${e?.message || e}`);
  await clearPaidCart(orderId).catch(logFailure("cart"));
  const order = await paidOrder(orderId).catch(logFailure("read"));
  if (order?.status === ORDER_STATUS.PAID || order?.status === ORDER_STATUS.COD_PENDING) await enqueueShopifyPush(orderId);
  await enqueuePurchaseAndForward(orderId);
  await recordConversions(expUnit, orderId, order?.total ?? 0).catch(logFailure("conversions"));
  await runAutomationsFor("order_placed", { key: `order_placed:${orderId}`, order }).catch(logFailure("automations"));
}

// The order is in a state this payment can't apply to. No retry will change that.
const isPaymentRefusal = (e) => /invalid order transition|different payment/i.test(String(e?.message || e));

// The browser callback. `settled` means the order is paid and the caller should
// schedule runOrderEffects. A database failure is never the customer's error:
// their money is captured, so it answers 202 for the browser to retry, and queues
// a durable job in case the browser never does.
export async function verifyBrowserPayment(body, { expUnit = null } = {}) {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }))
    return { status: 400, body: { error: "Payment signature verification failed" } };

  let ownsOrder = false;
  try {
    // tie the verified Razorpay order back to our pending order
    const stored = await getOrderRazorpayId(orderId);
    if (!stored || stored.razorpay_order_id !== razorpay_order_id)
      return { status: 400, body: { error: "Order mismatch" } };
    ownsOrder = true;

    // Idempotent: a duplicate callback for the same payment is a no-op. The
    // webhook (/api/razorpay/webhook) is the source of truth; this browser
    // callback is optimistic UX — whichever lands first wins, the other no-ops.
    const paid = await markOrderPaid(orderId, {
      razorpayPaymentId: razorpay_payment_id,
      source: "browser_callback",
    });
    slog("payment_verified", {
      order_id: orderId,
      source: "browser_callback",
      already: !!paid.already,
      razorpay_payment_id,
    });
    await clearPaidCart(orderId).catch((e) => console.error(`[paid-effects] cart ${orderId}: ${e?.message || e}`));
    return {
      status: 200,
      settled: true,
      body: {
        ok: true,
        orderId,
        confirmationPath: await orderConfirmationPath(orderId),
        ...(paid.already ? { already: true } : {}),
      },
    };
  } catch (e) {
    if (isPaymentRefusal(e)) return { status: 400, body: { error: String(e.message) } };
    slog("payment_confirm_deferred", {
      order_id: orderId,
      razorpay_payment_id,
      error: String(e?.message || e).slice(0, 200),
    });
    // Keyed on the signed Razorpay ids, never on the request's orderId: that id
    // hasn't been checked if the failure was the read above. The same goes for the
    // status link, which would otherwise open anybody's order.
    await enqueueDurable(
      "payment_confirm",
      { razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, expUnit },
      `paycfm:${tenantId()}:${razorpay_order_id}:${razorpay_payment_id}`,
    );
    return {
      status: 202,
      body: {
        ok: false,
        pending: true,
        orderId,
        ...(ownsOrder ? { confirmationPath: await orderConfirmationPath(orderId) } : {}),
      },
    };
  }
}

// The durable job behind a 202 above: the signature was verified before queueing.
export async function confirmVerifiedPayment({ razorpayOrderId, razorpayPaymentId, expUnit = null }) {
  const order = await findOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) return { ignored: "unknown_order" };
  const paid = await markOrderPaid(order.id, { razorpayPaymentId, source: "verify_retry" });
  await runOrderEffects(order.id, { expUnit });
  return { orderId: order.id, already: !!paid.already };
}
