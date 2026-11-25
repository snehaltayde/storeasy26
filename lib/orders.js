import { db, libsql, isTransient } from "./db.js";
import { getCart } from "./cart.js";
import { tenantOwnSecret, currentTenant } from "./tenant-context.js";
import { hasColumns } from "./schema-compat.js";
import { slog } from "./log.js";
import { roundMoney } from "./money.js";

// OVL-06 (migration 0018): Shopify's title and the SKU on each order line.
export const ORDER_ITEM_CATALOG_COLUMNS = ["catalog_title", "sku"];
export const ORDER_PAYMENT_COLUMNS = ["payment_discount", "cod_verified_at"];

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
// is the money state the UI shows. All writes go through lib/db.js, which only
// retries a write when the request never reached Turso: a write whose outcome is
// unknown throws here even if it committed. So every multi-row write below is one
// atomic batch, and createOrder/transitionOrder re-read to learn what happened.
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
  // paid → cancelled = refund territory: scripts/cancel-order.js only allows
  // it with a Razorpay refund id recorded (v1 refunds are manual — docs/refunds.md)
  paid: ["syncing_shopify", "cancelled"],
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

// S51: the order-id prefix is per store — "BL-" was BeastLife's branding
// hardcoded onto every tenant's orders (the first real tenant shipped
// "BL-…" ids). `config.order_prefix` wins; otherwise the tenant id derives
// one (pavos → PAV-). The legacy env store keeps BL-, and beastlife /
// beastlife-staging carry order_prefix "BL" in config for continuity.
function orderPrefix() {
  const t = currentTenant();
  if (!t) return "BL";
  const p = String(t.config?.order_prefix || t.id)
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 3)
    .toUpperCase();
  return p || "ORD";
}

// Phase 2 line 2: <PREFIX>- plus 16 upper-case hex characters (64 random
// bits; 8 characters, 32 bits, met a birthday clash near 77k orders). Older
// 8-character ids stay valid and are never rewritten. Edge-safe (Web Crypto).
export function orderNumber() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `${orderPrefix()}-` + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
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

// The order this checkout intent produced FROM THIS CART. An idempotency key is
// a client-chosen string, so on its own it proves nothing: a row made from
// another cart is a conflict (no order fields), never an answer. A genuine retry
// sends the same cart cookie, and orders.cart_id keeps it after the cart is
// cleared. The checkout API never dedups without a cart cookie; a lib caller
// without a cart matches only an order that was made without one.
export async function findOrderByIdempotencyKey(key, cartId = null) {
  if (!key) return null;
  const row = await db
    .selectFrom("orders")
    .selectAll()
    .where("idempotency_key", "=", key)
    .executeTakeFirst();
  if (!row) return null;
  if ((row.cart_id || null) !== (cartId || null)) {
    slog("checkout_idem_foreign_cart");
    throw conflict("Idempotency key was already used by another cart");
  }
  return row;
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

// A Kysely query as a statement for libsql.batch.
const asStatement = (query) => {
  const { sql, parameters } = query.compile();
  return { sql, args: parameters };
};

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
  paymentDiscount = 0, // Phase 8 line 2: the prepaid discount, from lib/checkout/payment-terms.js
  codVerifiedAt = null, // Phase 8 line 2: when a COD order's phone was confirmed by code
}) {
  const cart = providedCart || (await getCart(cartId));
  if (!cart.items.length) throw new Error("Cart is empty");
  if (!idempotencyKey) throw new Error("idempotencyKey is required");

  const shippingTotal = Number(shipping?.total || 0);
  const prepaidOff = Number(paymentDiscount || 0);
  // Phase 8: total = subtotal − discount_total − payment_discount + shipping_total
  const total = roundMoney(cart.total - prepaidOff + shippingTotal, cart.currency || "INR");

  // Fast path: this intent already produced an order (double submit / retry).
  const existing = await findOrderByIdempotencyKey(idempotencyKey, cartId);
  if (existing) {
    if (!sameAmount(existing.total, total))
      throw conflict("Idempotency key was already used for a different cart total");
    return asDedup(existing);
  }

  const status = paymentMethod === "cod" ? ORDER_STATUS.COD_PENDING : ORDER_STATUS.PENDING_PAYMENT;
  const paymentStatus = paymentMethod === "cod" ? "cod" : "pending";
  const id = orderNumber();
  const ts = now();
  // OVL-06 lines freeze catalog_title + sku, but only on a tenant migrated to 0018.
  // One probe per database, not per order (MIG-05, lib/schema-compat.js).
  const freezeCatalog = await hasColumns("order_items", ORDER_ITEM_CATALOG_COLUMNS);
  // Phase 8 line 2 (0036): the prepaid discount and the COD code check get columns.
  const paymentColumns = await hasColumns("orders", ORDER_PAYMENT_COLUMNS);

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
      ...(prepaidOff > 0 ? { paymentDiscount: prepaidOff } : {}),
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

  const orderInsert = db.insertInto("orders").values({
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
    ...(paymentColumns ? { payment_discount: prepaidOff, cod_verified_at: codVerifiedAt } : {}),
    created_at: ts,
    updated_at: ts,
  });

  const rows = cart.items.map((it, i) => ({
    order_id: id,
    variant_id: it.variantId,
    product_id: it.productId,
    title: it.title,
    ...(freezeCatalog ? { catalog_title: it.catalog_title ?? null, sku: it.sku ?? null } : {}),
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
      ...(freezeCatalog ? { catalog_title: g.catalog_title ?? null, sku: g.sku ?? null } : {}),
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
  const statements = [asStatement(orderInsert)];
  for (let i = 0; i < rows.length; i += 50) {
    statements.push(asStatement(db.insertInto("order_items").values(rows.slice(i, i + 50))));
  }
  statements.push(
    asStatement(
      db.insertInto("order_events").values({
        order_id: id,
        from_status: null,
        to_status: status,
        meta: JSON.stringify({
          payment_method: paymentMethod,
          ...(razorpayOrderId ? { razorpay_order_id: razorpayOrderId } : {}),
        }),
        created_at: ts,
      }),
    ),
  );

  // One transaction: an order that exists always has its lines and first event.
  try {
    await libsql.batch(statements, "write");
  } catch (e) {
    if (!isUniqueViolation(e) && !isTransient(e)) throw e;
    // UNIQUE: a concurrent duplicate won the race, so return its order.
    // Transient: outcome unknown. If the order is there now, it is complete, and
    // it may be OURS: `recovered` tells the caller its follow-up work could still
    // be undone. If it isn't, nothing was written, and the same key can retry.
    const winner = await findOrderByIdempotencyKey(idempotencyKey, cartId);
    if (!winner) throw e;
    if (!sameAmount(winner.total, total))
      throw conflict("Idempotency key was already used for a different cart total");
    return { ...asDedup(winner), recovered: isTransient(e) };
  }

  return { id, total, currency: cart.currency, status, razorpayOrderId, deduped: false };
}

// Atomic compare-and-set transition: the status flip and its event row are one
// transaction, so neither exists without the other. Idempotent: if the order is
// ALREADY in `to` (a concurrent duplicate got there first), returns
// { already: true } without logging a second event. Invalid moves throw. `set`
// merges extra column writes into the SAME update, so payment refs land atomically
// with the status flip.
//
// A write that fails with an unknown outcome is reconciled here, not resent
// blindly: the loop re-reads, and the CAS can't apply twice. The order being at
// `to` doesn't say whose write put it there: a concurrent caller's CAS can win
// while ours applies nothing and loses its response. So every event row this call
// writes carries its `write_id`, and that row existing is the proof the write was
// ours. beginShopifySync depends on this: a wrong already: false pushes twice.
export async function transitionOrder(orderId, to, { meta, set } = {}) {
  const writeId = crypto.randomUUID();
  const eventMeta = JSON.stringify({ ...meta, write_id: writeId });
  let unknownOutcome = null;
  for (let attempt = 0; ; attempt++) {
    const row = await db
      .selectFrom("orders")
      .select(["id", "status"])
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!row) throw new Error(`Order ${orderId} not found`);
    // Ours landed, even if the order has moved on since (paid → syncing_shopify).
    const ours = unknownOutcome ? await ownEvent(orderId, writeId) : null;
    if (ours) return { ok: true, orderId, status: to, from: ours.from_status, already: false };
    if (row.status === to) return { ok: true, orderId, status: to, already: true };
    if (!canTransition(row.status, to))
      throw Object.assign(new Error(`Invalid order transition ${row.status} → ${to} (${orderId})`), {
        code: "INVALID_TRANSITION",
      });
    if (attempt === 3) throw unknownOutcome || new Error(`Order ${orderId}: transition to ${to} kept losing races`);

    const ts = now();
    let updated;
    try {
      // The event goes first, selected on the same condition as the CAS below it.
      [, updated] = await libsql.batch(
        [
          {
            sql: `INSERT INTO order_events (order_id, from_status, to_status, meta, created_at)
                  SELECT id, status, ?, ?, ? FROM orders WHERE id = ? AND status = ?`,
            args: [to, eventMeta, ts, orderId, row.status],
          },
          asStatement(
            db
              .updateTable("orders")
              .set({ status: to, updated_at: ts, ...(set || {}) })
              .where("id", "=", orderId)
              .where("status", "=", row.status), // CAS: only if nobody moved it since the read
          ),
        ],
        "write",
      );
    } catch (e) {
      if (!isTransient(e)) throw e;
      unknownOutcome = e;
      continue;
    }

    if (Number(updated.rowsAffected) > 0) {
      return { ok: true, orderId, status: to, from: row.status, already: false };
    }
    // Lost the CAS race — re-read; the loop resolves "now already at `to`".
  }
}

// The event row a transitionOrder call wrote, if any of its attempts committed.
async function ownEvent(orderId, writeId) {
  const { rows } = await libsql.execute({
    sql: "SELECT from_status FROM order_events WHERE order_id = ? AND instr(meta, ?) > 0",
    args: [orderId, writeId],
  });
  return rows[0] || null;
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
  const row = await paymentRow(orderId);
  if (!row) throw new Error(`Order ${orderId} not found`);
  const repeat = paidAlready(row, razorpayPaymentId);
  if (repeat) return repeat;

  const meta = {
    ...(razorpayPaymentId ? { razorpay_payment_id: razorpayPaymentId } : {}),
    ...(source ? { source } : {}),
    ...(webhookEventId ? { webhook_event_id: webhookEventId } : {}),
  };
  // The other path (webhook or browser) can pay the order after the read above, and
  // its follow-up work can move it on (paid → syncing_shopify) before transitionOrder
  // re-reads. Both outcomes are the repeat case above, held to the same payment-id
  // check: already: true or an invalid transition from transitionOrder only says the
  // order is paid, not by which payment. A lost write response widens this gap from
  // milliseconds to seconds.
  let paid;
  try {
    paid = await transitionOrder(orderId, ORDER_STATUS.PAID, {
      set: {
        payment_status: "paid",
        razorpay_payment_id: razorpayPaymentId,
        paid_at: now(),
      },
      meta: Object.keys(meta).length ? meta : undefined,
    });
  } catch (e) {
    if (e?.code !== "INVALID_TRANSITION") throw e;
    const late = paidAlready(await paymentRow(orderId), razorpayPaymentId);
    if (late) return late;
    throw e;
  }
  if (!paid.already) return paid;
  return paidAlready(await paymentRow(orderId), razorpayPaymentId) || paid;
}

const paymentRow = (orderId) =>
  db.selectFrom("orders").select(["id", "status", "razorpay_payment_id"]).where("id", "=", orderId).executeTakeFirst();

// An order that's already paid: the same payment again is a no-op, a DIFFERENT one throws.
function paidAlready(row, razorpayPaymentId) {
  if (!PAID_AND_BEYOND.includes(row?.status)) return null;
  if (razorpayPaymentId && row.razorpay_payment_id && row.razorpay_payment_id !== razorpayPaymentId)
    throw new Error(`Order ${row.id} is already paid with a different payment (${row.razorpay_payment_id})`);
  return { ok: true, orderId: row.id, status: row.status, already: true };
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

// Guest order-status links (Session 18; EXPIRING v2 since S33/SF08): the
// status + confirmation pages are public but the order id alone must never be
// enough. v2 proof = `2.<expEpochSecs>.<hmac20>` — a real HMAC-SHA256 over
// `orderId|exp`, so it is scoped (per order), expiring (default 30 days,
// ORDER_LINK_TTL_DAYS), and tenant-bound via the tenant's own secret.
// Legacy v1 tokens (bare 20-hex, non-expiring) stay accepted until the
// cutover date below, then die.
const LEGACY_TOKEN_CUTOFF = Date.parse("2027-01-31T00:00:00Z");
const linkTtlMs = () => Number(process.env.ORDER_LINK_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;

// The store's own secret signs its links. The public "dev-only-secret" fallback
// exists for local runs only: in production a store without a secret mints no
// link (throws) and verifies none (null here; verify answers false).
export const DEV_LINK_SECRET = "dev-only-secret";
export function storeLinkSecret() {
  const own = tenantOwnSecret("order_link_secret", "ORDER_LINK_SECRET") || tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET");
  if (own) return own;
  return process.env.NODE_ENV === "production" ? null : DEV_LINK_SECRET;
}

function linkSecret() {
  const secret = storeLinkSecret();
  if (!secret) throw new Error("This store has no order link secret");
  return secret;
}

const hex = (buf) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

async function hmac20(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(sig).slice(0, 20);
}

// kept only to verify not-yet-expired LEGACY links
async function legacyToken(orderId, secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${orderId}|${secret}`));
  return hex(digest).slice(0, 20);
}

export async function orderStatusToken(orderId, { now = Date.now() } = {}) {
  const exp = Math.floor((now + linkTtlMs()) / 1000);
  return `2.${exp}.${await hmac20(`${orderId}|${exp}`, linkSecret())}`;
}

// Constant-time comparison, edge-safe (no node:crypto on the edge runtime):
// branch-free loop, length mismatch folded into the accumulator.
function timingSafeEqualStr(a, b) {
  const A = String(a);
  const B = String(b);
  if (!A.length || !B.length) return false;
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= A.charCodeAt(i % A.length) ^ B.charCodeAt(i % B.length);
  return diff === 0;
}

export async function verifyOrderStatusToken(orderId, token, { now = Date.now() } = {}) {
  if (!token) return false;
  const t = String(token);
  const secret = storeLinkSecret();
  if (!secret) return false;
  // v2: expiring HMAC proof
  if (t.startsWith("2.")) {
    const [, expStr, sig] = t.split(".");
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp * 1000 <= now) return false;
    return timingSafeEqualStr(await hmac20(`${orderId}|${exp}`, secret), String(sig || ""));
  }
  // legacy v1 (non-expiring): honored only until the cutover date
  if (/^[0-9a-f]{20}$/.test(t) && now < LEGACY_TOKEN_CUTOFF) {
    return timingSafeEqualStr(await legacyToken(orderId, secret), t);
  }
  return false;
}

export const orderStatusPath = async (orderId) =>
  `/orders/${orderId}?t=${await orderStatusToken(orderId)}`;

// S25 (SF08 containment): the confirmation page is gated by the SAME token as
// the status page — the checkout API hands this path to the client, so the
// order id alone never unlocks PII.
export const orderConfirmationPath = async (orderId) =>
  `/checkout/confirmation/${orderId}?t=${await orderStatusToken(orderId)}`;

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
