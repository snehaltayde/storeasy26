import { db } from "./db.js";
import { getCart } from "./cart.js";

// ---------------------------------------------------------------------------
// Production order model (Session 10).
//
// An order is created at checkout intent with an idempotency key tied to the
// payment attempt — a double submit, network retry, or duplicate payment
// callback re-reads the existing order instead of creating a second one. The
// UNIQUE index on orders.idempotency_key is the hard guarantee; the pre-checks
// are fast paths.
//
// Status state machine (persisted transitions in order_events):
//
//   razorpay ──▶ pending_payment ──▶ paid ──▶ syncing_shopify ──▶ synced
//   cod ───────▶ cod_pending ────────────────▶      ▲   │
//                     │                             │   ▼
//                     ▼                        sync_failed (retry loops back)
//                 cancelled  (also from pending_payment)
//
// `status` is the workflow position; `payment_status` (pending | paid | cod)
// is the money state the UI shows. All writes go through lib/db.js, whose
// client retry-wraps transient Turso connection failures.
// ---------------------------------------------------------------------------

export const ORDER_STATUS = {
  PENDING_PAYMENT: "pending_payment",
  COD_PENDING: "cod_pending",
  PAID: "paid",
  SYNCING_SHOPIFY: "syncing_shopify",
  SYNCED: "synced",
  SYNC_FAILED: "sync_failed",
  CANCELLED: "cancelled",
};

const TRANSITIONS = {
  pending_payment: ["paid", "cancelled"],
  cod_pending: ["syncing_shopify", "cancelled"],
  paid: ["syncing_shopify"],
  syncing_shopify: ["synced", "sync_failed"],
  sync_failed: ["syncing_shopify", "cancelled"],
  // post-sync cancellation is real (customer cancels / test-order hygiene);
  // the Shopify side is cancelled via orderCancel first (scripts/cancel-order.js)
  synced: ["cancelled"],
  cancelled: [],
};

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// Statuses that mean "the money is captured" — a repeat payment callback on any
// of these is an idempotent no-op, not an error.
const PAID_AND_BEYOND = ["paid", "syncing_shopify", "synced", "sync_failed"];

const now = () => new Date().toISOString();

function orderNumber() {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-x`;
  return "BL-" + uuid.replace(/-/g, "").slice(0, 8).toUpperCase();
}

// Same key + different cart ⇒ the caller's "retry" isn't a retry. Surfaced as
// HTTP 409 by the checkout API; the client rotates its key and resubmits.
const conflict = (msg) => Object.assign(new Error(msg), { code: "IDEMPOTENCY_CONFLICT" });
const isUniqueViolation = (e) => /unique constraint/i.test(String(e?.message || e));
const sameAmount = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Enough of an existing order for the checkout API to rebuild its response.
const asDedup = (row) => ({
  id: row.id,
  total: row.total,
  currency: row.currency,
  status: row.status,
  razorpayOrderId: row.razorpay_order_id,
  deduped: true,
});

export async function findOrderByIdempotencyKey(key) {
  if (!key) return null;
  const row = await db
    .selectFrom("orders")
    .selectAll()
    .where("idempotency_key", "=", key)
    .executeTakeFirst();
  return row || null;
}

// Webhook path: a payment.captured delivery only knows the Razorpay order id.
export async function findOrderByRazorpayOrderId(razorpayOrderId) {
  if (!razorpayOrderId) return null;
  const row = await db
    .selectFrom("orders")
    .selectAll()
    .where("razorpay_order_id", "=", razorpayOrderId)
    .executeTakeFirst();
  return row || null;
}

async function logEvent(orderId, fromStatus, toStatus, meta) {
  await db
    .insertInto("order_events")
    .values({
      order_id: orderId,
      from_status: fromStatus,
      to_status: toStatus,
      meta: meta ? JSON.stringify(meta) : null,
      created_at: now(),
    })
    .execute();
}

// Create an order from the SERVER cart (authoritative totals + offers — the same
// getCart the drawer uses). Snapshots paid items + gift lines + the full engine
// output so the order is immutable and the Session-12 Shopify push can reproduce
// the exact discount representation. Idempotent on idempotencyKey.
export async function createOrder({
  cartId,
  cart: providedCart,
  contact,
  address,
  paymentMethod, // "cod" | "razorpay"
  idempotencyKey,
  razorpayOrderId = null,
  shipping = { method: "free", total: 0 },
  consent = null, // "granted" | "denied" | null — gates the purchase event later
}) {
  const cart = providedCart || (await getCart(cartId));
  if (!cart.items.length) throw new Error("Cart is empty");
  if (!idempotencyKey) throw new Error("idempotencyKey is required");

  const shippingTotal = Number(shipping?.total || 0);
  const total = cart.total + shippingTotal;

  // Fast path: this intent already produced an order (double submit / retry).
  const existing = await findOrderByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (!sameAmount(existing.total, total))
      throw conflict("Idempotency key was already used for a different cart total");
    return asDedup(existing);
  }

  const status = paymentMethod === "cod" ? ORDER_STATUS.COD_PENDING : ORDER_STATUS.PENDING_PAYMENT;
  const paymentStatus = paymentMethod === "cod" ? "cod" : "pending";
  const id = orderNumber();
  const ts = now();

  // Full reproducible record. Session 12 rebuilds the Shopify representation
  // from this: lines at catalog price, gifts as 100%-off lines, ONE order-level
  // FIXED_AMOUNT discount = totals.discountTotal, custom shipping line.
  const snapshot = {
    v: 1,
    items: cart.items,
    gifts: cart.gifts || [],
    appliedOffers: cart.appliedOffers || [],
    coupon: cart.couponStatus || null,
    totals: {
      subtotal: cart.subtotal,
      discountTotal: cart.discountTotal,
      shippingTotal,
      total,
      currency: cart.currency,
    },
    shipping,
    contact: contact || null,
    address: address || null,
    payment: { method: paymentMethod, razorpay_order_id: razorpayOrderId },
    consent,
  };

  try {
    await db
      .insertInto("orders")
      .values({
        id,
        idempotency_key: idempotencyKey,
        cart_id: cartId || null, // lets the webhook clear the cart when the browser callback never lands
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
        shipping_total: shippingTotal,
        total,
        currency: cart.currency,
        coupon_code: cart.couponStatus?.valid ? cart.couponStatus.code : null,
        applied_offers: JSON.stringify(cart.appliedOffers || []),
        snapshot: JSON.stringify(snapshot),
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        status,
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: null,
        sync_attempts: 0,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
  } catch (e) {
    // Concurrent duplicate lost the UNIQUE(idempotency_key) race — return the
    // winner's order. (Its items/event rows are the winner's to write.)
    if (isUniqueViolation(e)) {
      const winner = await findOrderByIdempotencyKey(idempotencyKey);
      if (winner) {
        if (!sameAmount(winner.total, total))
          throw conflict("Idempotency key was already used for a different cart total");
        return asDedup(winner);
      }
    }
    throw e;
  }

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

  await logEvent(id, null, status, {
    payment_method: paymentMethod,
    ...(razorpayOrderId ? { razorpay_order_id: razorpayOrderId } : {}),
  });

  return { id, total, currency: cart.currency, status, razorpayOrderId, deduped: false };
}

// Atomic compare-and-set transition. Idempotent: if the order is ALREADY in
// `to` (a concurrent duplicate got there first), returns { already: true }
// without logging a second event. Invalid moves throw. `set` merges extra
// column writes into the SAME update, so payment refs land atomically with
// the status flip.
export async function transitionOrder(orderId, to, { meta, set } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .selectFrom("orders")
      .select(["id", "status"])
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!row) throw new Error(`Order ${orderId} not found`);
    if (row.status === to) return { ok: true, orderId, status: to, already: true };
    if (!canTransition(row.status, to))
      throw new Error(`Invalid order transition ${row.status} → ${to} (${orderId})`);

    const res = await db
      .updateTable("orders")
      .set({ status: to, updated_at: now(), ...(set || {}) })
      .where("id", "=", orderId)
      .where("status", "=", row.status) // CAS: only if nobody moved it since the read
      .executeTakeFirst();

    if (Number(res.numUpdatedRows) > 0) {
      await logEvent(orderId, row.status, to, meta);
      return { ok: true, orderId, status: to, from: row.status, already: false };
    }
    // Lost the CAS race — re-read; the loop resolves "now already at `to`".
  }
  throw new Error(`Order ${orderId}: transition to ${to} kept losing races`);
}

// Payment captured (Razorpay verify / webhook). Idempotent: a duplicate
// callback with the same payment id is a no-op; a DIFFERENT payment id on an
// already-paid order is an error worth hearing about. `source` records WHICH
// path won ("browser_callback" | "webhook") in the audit trail — the webhook
// is the source of truth, the callback is optimistic UX.
export async function markOrderPaid(
  orderId,
  { razorpayPaymentId = null, source = null, webhookEventId = null } = {},
) {
  const row = await db
    .selectFrom("orders")
    .select(["id", "status", "razorpay_payment_id"])
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (!row) throw new Error(`Order ${orderId} not found`);

  if (PAID_AND_BEYOND.includes(row.status)) {
    if (razorpayPaymentId && row.razorpay_payment_id && row.razorpay_payment_id !== razorpayPaymentId)
      throw new Error(
        `Order ${orderId} is already paid with a different payment (${row.razorpay_payment_id})`,
      );
    return { ok: true, orderId, status: row.status, already: true };
  }

  const meta = {
    ...(razorpayPaymentId ? { razorpay_payment_id: razorpayPaymentId } : {}),
    ...(source ? { source } : {}),
    ...(webhookEventId ? { webhook_event_id: webhookEventId } : {}),
  };
  return transitionOrder(orderId, ORDER_STATUS.PAID, {
    set: {
      payment_status: "paid",
      razorpay_payment_id: razorpayPaymentId,
      paid_at: now(),
    },
    meta: Object.keys(meta).length ? meta : undefined,
  });
}

// --- Shopify sync lifecycle (consumed by Session 12) ------------------------

export async function beginShopifySync(orderId) {
  const row = await db
    .selectFrom("orders")
    .select(["sync_attempts"])
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (!row) throw new Error(`Order ${orderId} not found`);
  const attempt = (row.sync_attempts || 0) + 1;
  return transitionOrder(orderId, ORDER_STATUS.SYNCING_SHOPIFY, {
    set: { sync_attempts: attempt },
    meta: { attempt },
  });
}

export async function completeShopifySync(orderId, { shopifyOrderId }) {
  return transitionOrder(orderId, ORDER_STATUS.SYNCED, {
    set: { shopify_order_id: shopifyOrderId || null, synced_at: now(), sync_error: null },
    meta: { shopify_order_id: shopifyOrderId },
  });
}

export async function failShopifySync(orderId, { error }) {
  const msg = String(error || "unknown").slice(0, 500);
  return transitionOrder(orderId, ORDER_STATUS.SYNC_FAILED, {
    set: { sync_error: msg },
    meta: { error: msg },
  });
}

// ---------------------------------------------------------------------------

export async function getOrderRazorpayId(orderId) {
  const row = await db
    .selectFrom("orders")
    .select(["razorpay_order_id", "total", "payment_status", "status"])
    .where("id", "=", orderId)
    .executeTakeFirst();
  return row || null;
}

const parseJson = (s, fallback = null) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

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
  const events = await db
    .selectFrom("order_events")
    .selectAll()
    .where("order_id", "=", orderId)
    .orderBy("id", "asc")
    .execute();

  return {
    ...order,
    appliedOffers: parseJson(order.applied_offers, []),
    snapshot: parseJson(order.snapshot),
    items: items.map((it) => ({ ...it, is_gift: !!it.is_gift })),
    events: events.map((e) => ({ ...e, meta: parseJson(e.meta) })),
  };
}
