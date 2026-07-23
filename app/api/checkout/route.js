import { NextResponse, after } from "next/server";
import { CART_COOKIE, getCart, clearCart } from "@/lib/cart";
import { computeShipping } from "@/lib/shipping";
import { enqueueShopifyPush } from "@/lib/shopify-push";
import { enqueuePurchaseAndForward } from "@/lib/events";
import { CONSENT_COOKIE } from "@/lib/track/names";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import {
  createOrder,
  markOrderPaid,
  getOrderRazorpayId,
  findOrderByIdempotencyKey,
  ORDER_STATUS,
} from "@/lib/orders";
import { razorpayConfigured, createRazorpayOrder, verifyRazorpaySignature } from "@/lib/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cartIdFrom = (request) => request.cookies.get(CART_COOKIE)?.value || null;

function validate(contact, address) {
  const required = [
    contact?.email,
    contact?.phone,
    contact?.name,
    address?.line1,
    address?.city,
    address?.state,
    address?.pincode,
  ];
  return required.every((v) => v && String(v).trim());
}

const sameAmount = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// If this idempotency key already produced an order, short-circuit BEFORE any
// cart/validation checks — a retry after the first request cleared the cart
// must still return that order, not "Cart is empty". Returns null (no dup),
// a NextResponse to send, or throws nothing. `expectedTotal` is goods+shipping
// for THIS submission (order.total includes shipping since Session 13).
async function dedupByKey(key, cart, expectedTotal) {
  const existing = await findOrderByIdempotencyKey(key);
  if (!existing) return null;
  // Same key but a different (non-empty) cart ⇒ not a retry: the client must
  // rotate its key. 409 tells it to.
  if (cart?.items?.length && !sameAmount(expectedTotal, existing.total)) {
    return NextResponse.json(
      { error: "This checkout attempt no longer matches your cart. Please retry.", code: "IDEMPOTENCY_CONFLICT" },
      { status: 409 },
    );
  }
  return existing;
}

const codResponse = (order, deduped = false) =>
  NextResponse.json({ ok: true, orderId: order.id, ...(deduped ? { deduped: true } : {}) });

function razorpayResponse(order, razorpayOrderId, deduped = false) {
  // An order that already left pending_payment means the payment landed —
  // don't reopen the modal; the client goes straight to confirmation.
  if (order.status && order.status !== ORDER_STATUS.PENDING_PAYMENT) {
    return NextResponse.json({ ok: true, orderId: order.id, status: order.status, alreadyPaid: true });
  }
  return NextResponse.json({
    ok: true,
    orderId: order.id,
    razorpayOrderId,
    amount: Math.round(order.total * 100),
    currency: order.currency || "INR",
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    ...(deduped ? { deduped: true } : {}),
  });
}

export async function POST(request) {
  const limited = rateLimit(request, { name: "checkout", limit: 10 });
  if (limited) return limited;

  const cartId = cartIdFrom(request);
  const body = await request.json().catch(() => ({}));
  const { action, contact, address, idempotencyKey } = body;

  try {
    if (action === "cod") {
      if (!idempotencyKey)
        return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
      const cart = cartId ? await getCart(cartId) : { items: [] };

      // Authoritative shipping: same pure engine the drawer/checkout UI use,
      // now with the real payment method + destination pincode.
      const shipping = computeShipping({
        subtotal: cart.subtotal || 0,
        discountTotal: cart.discountTotal || 0,
        paymentMethod: "cod",
        pincode: address?.pincode,
      });

      const dup = await dedupByKey(idempotencyKey, cart, (cart.total || 0) + shipping.total);
      if (dup instanceof NextResponse) return dup;
      if (dup) {
        // Finish what the first request started if its cart clear didn't land.
        if (cartId && cart.items.length) await clearCart(cartId);
        return codResponse(dup, true);
      }

      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });

      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "cod",
        idempotencyKey,
        shipping,
        consent: request.cookies.get(CONSENT_COOKIE)?.value || null,
      });
      slog(order.deduped ? "order_deduped" : "order_created", {
        order_id: order.id,
        method: "cod",
        total: order.total,
        cart_id: cartId,
      });
      if (!order.deduped) {
        await clearCart(cartId);
        // Async after the response: Shopify push (payment-pending) + the
        // server-side purchase event (durable, browser-independent).
        after(async () => {
          await enqueueShopifyPush(order.id);
          await enqueuePurchaseAndForward(order.id);
        });
      }
      return codResponse(order, order.deduped);
    }

    if (action === "razorpay_create") {
      if (!razorpayConfigured())
        return NextResponse.json({ error: "Razorpay is not configured" }, { status: 400 });
      if (!idempotencyKey)
        return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
      const cart = cartId ? await getCart(cartId) : { items: [] };

      const shipping = computeShipping({
        subtotal: cart.subtotal || 0,
        discountTotal: cart.discountTotal || 0,
        paymentMethod: "prepaid",
        pincode: address?.pincode,
      });

      // Dedup BEFORE creating a Razorpay order, so a retry reopens the SAME
      // payment instead of minting a parallel one.
      const dup = await dedupByKey(idempotencyKey, cart, (cart.total || 0) + shipping.total);
      if (dup instanceof NextResponse) return dup;
      if (dup) return razorpayResponse(dup, dup.razorpay_order_id, true);

      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });

      // One getCart + one shipping compute → the SAME amount for the Razorpay
      // order, our order row, and (later) the Shopify shipping line.
      const rzOrder = await createRazorpayOrder({
        amountPaise: Math.round((cart.total + shipping.total) * 100),
        receipt: `cart_${cartId.slice(0, 12)}`,
      });
      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "razorpay",
        idempotencyKey,
        razorpayOrderId: rzOrder.id,
        shipping,
        consent: request.cookies.get(CONSENT_COOKIE)?.value || null,
      });
      slog(order.deduped ? "order_deduped" : "order_created", {
        order_id: order.id,
        method: "razorpay",
        total: order.total,
        cart_id: cartId,
        razorpay_order_id: order.deduped ? order.razorpayOrderId : rzOrder.id,
      });
      // Lost a same-key insert race: answer with the winner's Razorpay order
      // (this request's rzOrder is an orphan — never paid, expires unused).
      if (order.deduped) return razorpayResponse(order, order.razorpayOrderId, true);
      return razorpayResponse(order, rzOrder.id);
    }

    if (action === "razorpay_verify") {
      const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
      if (!verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }))
        return NextResponse.json({ error: "Payment signature verification failed" }, { status: 400 });
      // tie the verified Razorpay order back to our pending order
      const stored = await getOrderRazorpayId(orderId);
      if (!stored || stored.razorpay_order_id !== razorpay_order_id)
        return NextResponse.json({ error: "Order mismatch" }, { status: 400 });

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
        razorpay_payment_id: razorpay_payment_id,
      });
      if (cartId) await clearCart(cartId);
      if (!paid.already) {
        after(async () => {
          await enqueueShopifyPush(orderId);
          await enqueuePurchaseAndForward(orderId);
        });
      }
      return NextResponse.json({ ok: true, orderId, ...(paid.already ? { already: true } : {}) });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    const status = e?.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
    return NextResponse.json(
      { error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) },
      { status },
    );
  }
}
