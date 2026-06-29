import { db } from "./db.js";
import { getCart } from "./cart.js";

function orderNumber() {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-x`;
  return "BL-" + uuid.replace(/-/g, "").slice(0, 8).toUpperCase();
}

// Create an order from the SERVER cart (authoritative totals + offers — the same
// getCart the drawer uses). Snapshots paid items + gift lines so the order is
// immutable. Caller (checkout API) supplies contact/address/payment + clears the
// cart on success.
export async function createOrder({
  cartId,
  cart: providedCart,
  contact,
  address,
  paymentMethod,
  paymentStatus,
  status,
  razorpayOrderId = null,
}) {
  const cart = providedCart || (await getCart(cartId));
  if (!cart.items.length) throw new Error("Cart is empty");

  const id = orderNumber();
  const now = new Date().toISOString();

  await db
    .insertInto("orders")
    .values({
      id,
      email: contact?.email || null,
      phone: contact?.phone || null,
      name: contact?.name || null,
      address_line1: address?.line1 || null,
      address_line2: address?.line2 || null,
      city: address?.city || null,
      state: address?.state || null,
      pincode: address?.pincode || null,
      country: address?.country || "India",
      subtotal: cart.subtotal,
      discount_total: cart.discountTotal,
      total: cart.total,
      currency: cart.currency,
      coupon_code: cart.couponStatus?.valid ? cart.couponStatus.code : null,
      applied_offers: JSON.stringify(cart.appliedOffers || []),
      payment_method: paymentMethod,
      payment_status: paymentStatus,
      status,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: null,
      created_at: now,
    })
    .execute();

  const rows = cart.items.map((it, i) => ({
    order_id: id,
    variant_id: it.variantId,
    product_id: it.productId,
    title: it.title,
    variant_title: it.variantTitle,
    image: it.image,
    unit_price: it.price,
    quantity: it.quantity,
    line_total: it.lineTotal,
    line_discount: it.discount || 0,
    is_gift: 0,
    position: i,
  }));
  (cart.gifts || []).forEach((g, i) => {
    rows.push({
      order_id: id,
      variant_id: g.variantId,
      product_id: g.productId || null,
      title: g.title,
      variant_title: null,
      image: g.image,
      unit_price: 0,
      quantity: 1,
      line_total: 0,
      line_discount: 0,
      is_gift: 1,
      position: rows.length + i,
    });
  });
  for (let i = 0; i < rows.length; i += 50) {
    await db.insertInto("order_items").values(rows.slice(i, i + 50)).execute();
  }

  return { id, total: cart.total, currency: cart.currency };
}

export async function markOrderPaid(orderId, { razorpayPaymentId } = {}) {
  await db
    .updateTable("orders")
    .set({
      payment_status: "paid",
      status: "confirmed",
      razorpay_payment_id: razorpayPaymentId || null,
    })
    .where("id", "=", orderId)
    .execute();
}

export async function getOrderRazorpayId(orderId) {
  const row = await db
    .selectFrom("orders")
    .select(["razorpay_order_id", "total", "payment_status"])
    .where("id", "=", orderId)
    .executeTakeFirst();
  return row || null;
}

export async function getOrder(orderId) {
  const order = await db
    .selectFrom("orders")
    .selectAll()
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (!order) return null;
  const items = await db
    .selectFrom("order_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .orderBy("position", "asc")
    .execute();

  let appliedOffers = [];
  try {
    appliedOffers = JSON.parse(order.applied_offers || "[]");
  } catch {
    appliedOffers = [];
  }
  return {
    ...order,
    appliedOffers,
    items: items.map((it) => ({ ...it, is_gift: !!it.is_gift })),
  };
}
