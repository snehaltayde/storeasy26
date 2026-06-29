import { NextResponse } from "next/server";
import { CART_COOKIE, getCart, clearCart } from "@/lib/cart";
import { createOrder, markOrderPaid, getOrderRazorpayId } from "@/lib/orders";
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

export async function POST(request) {
  const cartId = cartIdFrom(request);
  const body = await request.json().catch(() => ({}));
  const { action, contact, address } = body;

  try {
    if (action === "cod") {
      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      const cart = await getCart(cartId);
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });

      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "cod",
        paymentStatus: "cod",
        status: "confirmed",
      });
      await clearCart(cartId);
      return NextResponse.json({ ok: true, orderId: order.id });
    }

    if (action === "razorpay_create") {
      if (!razorpayConfigured())
        return NextResponse.json({ error: "Razorpay is not configured" }, { status: 400 });
      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });

      const cart = await getCart(cartId);
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });

      // One getCart → consistent amount for both the Razorpay order and ours.
      const rzOrder = await createRazorpayOrder({
        amountPaise: Math.round(cart.total * 100),
        receipt: `cart_${cartId.slice(0, 12)}`,
      });
      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "razorpay",
        paymentStatus: "pending",
        status: "pending_payment",
        razorpayOrderId: rzOrder.id,
      });
      return NextResponse.json({
        ok: true,
        orderId: order.id,
        razorpayOrderId: rzOrder.id,
        amount: rzOrder.amount,
        currency: rzOrder.currency,
        keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      });
    }

    if (action === "razorpay_verify") {
      const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
      if (!verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }))
        return NextResponse.json({ error: "Payment signature verification failed" }, { status: 400 });
      // tie the verified Razorpay order back to our pending order
      const stored = await getOrderRazorpayId(orderId);
      if (!stored || stored.razorpay_order_id !== razorpay_order_id)
        return NextResponse.json({ error: "Order mismatch" }, { status: 400 });

      await markOrderPaid(orderId, { razorpayPaymentId: razorpay_payment_id });
      if (cartId) await clearCart(cartId);
      return NextResponse.json({ ok: true, orderId });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
