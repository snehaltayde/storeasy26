// Phase 9 line 2: subscriptions (migration 0044). SERVER-ONLY, tenant-scoped:
// every call runs inside withTenant() against the store's own database.
//
// A subscription is created from a placed order's subscribed line, in
// runOrderEffects (decision 9), keyed on order + line, so a replay creates
// nothing twice. A renewal order is placed from a renewal cart under the
// idempotency key renewalKey(id, cycle): orders.idempotency_key is UNIQUE, so a
// cycle can have one order however many checkouts race for it. Its effects
// link the order to the cycle and move the subscription on by one interval,
// once (the update names the cycle it moves from).
import { sql } from "kysely";
import { db, libsql } from "../db.js";
import { hasColumns } from "../schema-compat.js";
import { addDays, QUANTITY_MAX } from "./pricing.js";
import { readEffective, effectiveExpr, LIVE_TABLE } from "../catalog/effective.js";

export const subscriptionClock = { now: () => Date.now() };
export const nowIso = () => new Date(subscriptionClock.now()).toISOString();
export const STATUSES = Object.freeze(["active", "paused", "cancelled"]);

const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
export const newSubscriptionId = () => `sub_${hex(8)}`;

// The idempotency key of a cycle's renewal order. A shopper's own key can't
// take this form (the checkout refuses one that starts with "sub:").
export const RENEWAL_KEY_PREFIX = "sub:";
export const renewalKey = (subscriptionId, cycle) => `${RENEWAL_KEY_PREFIX}${subscriptionId}:${cycle}`;
export function parseRenewalKey(key) {
  const m = /^sub:(sub_[0-9a-f]{16}):(\d{1,6})$/.exec(String(key || ""));
  return m ? { subscriptionId: m[1], cycle: Number(m[2]) } : null;
}

export const subscriptionsReady = () => hasColumns("subscriptions", ["id", "origin_line"]);

// Moving a subscription on to its next cycle applies a swap asked for while
// the current delivery was due (actions.js swap): SQL for an UPDATE's SET.
export const MOVE_ON_SWAP = "variant_id = COALESCE(swap_variant_id, variant_id), product_id = COALESCE(swap_product_id, product_id), swap_variant_id = NULL, swap_product_id = NULL";
export const moveOnSwap = { variant_id: sql`COALESCE(swap_variant_id, variant_id)`, product_id: sql`COALESCE(swap_product_id, product_id)`, swap_variant_id: null, swap_product_id: null };

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

const SETTLED = new Set(["paid", "cod_pending", "syncing_shopify", "synced", "sync_failed"]);

// runOrderEffects → here. Repeat-safe. An order that isn't placed (pending
// payment) or was cancelled does nothing. → { created, linked }
export async function createSubscriptionsFor(orderId) {
  if (!(await subscriptionsReady())) return { created: 0, linked: false };
  const order = await db.selectFrom("orders").select(["id", "status", "customer_id", "idempotency_key", "snapshot", "created_at"]).where("id", "=", orderId).executeTakeFirst();
  if (!order || !SETTLED.has(order.status)) return { created: 0, linked: false };
  const renewal = parseRenewalKey(order.idempotency_key);
  if (renewal) return { created: 0, linked: await linkRenewal(order, renewal) };
  if (!order.customer_id) return { created: 0, linked: false };
  const items = (parse(order.snapshot, {})?.items || []).filter((i) => i?.subscription?.active === true && !i.subscription.renewal);
  let created = 0;
  for (const i of items) {
    const ts = nowIso();
    const res = await db
      .insertInto("subscriptions")
      .values({
        id: newSubscriptionId(),
        customer_id: order.customer_id,
        product_id: i.productId,
        variant_id: i.variantId,
        quantity: Math.min(Number(i.quantity), QUANTITY_MAX), // the cart never subscribes more (pricing.js); a guard

        interval_days: Number(i.subscription.interval),
        discount_percent: Number(i.subscription.percent) || 0,
        status: "active",
        next_due_at: addDays(order.created_at, Number(i.subscription.interval)),
        cycle: 2, // the origin order was the first delivery
        missed_in_row: 0,
        origin_order_id: order.id,
        origin_line: i.variantId,
        created_at: ts,
        updated_at: ts,
      })
      .onConflict((oc) => oc.columns(["origin_order_id", "origin_line"]).doNothing())
      .executeTakeFirst();
    created += Number(res?.numInsertedOrUpdatedRows ?? 0);
  }
  return { created, linked: false };
}

// A renewal order's effects: the cycle names its order, and the subscription
// moves on one interval from that cycle's due date (only while it is still on
// that cycle, so a replay or a late payment moves nothing twice).
async function linkRenewal(order, { subscriptionId, cycle }) {
  const sub = await db.selectFrom("subscriptions").selectAll().where("id", "=", subscriptionId).executeTakeFirst();
  if (!sub) return false;
  const ts = nowIso();
  await libsql.batch(
    [
      {
        sql: `INSERT INTO subscription_cycles (subscription_id, cycle, due_at, status, order_id, updated_at) VALUES (?, ?, ?, 'ordered', ?, ?)
              ON CONFLICT (subscription_id, cycle) DO UPDATE SET order_id = excluded.order_id, status = 'ordered', updated_at = excluded.updated_at
              WHERE subscription_cycles.order_id IS NULL`,
        args: [subscriptionId, cycle, sub.next_due_at, order.id, ts],
      },
      {
        sql: `UPDATE subscriptions SET cycle = cycle + 1, next_due_at = ?, missed_in_row = 0, ${MOVE_ON_SWAP}, updated_at = ? WHERE id = ? AND cycle = ? AND status <> 'cancelled'`,
        args: [addDays(sub.next_due_at, Number(sub.interval_days)), ts, subscriptionId, cycle],
      },
    ],
    "write",
  );
  return true;
}

// ---- reads ----------------------------------------------------------------

const VIEW_COLUMNS = [
  "s.id",
  "s.customer_id",
  "s.product_id",
  "s.variant_id",
  "s.quantity",
  "s.interval_days",
  "s.discount_percent",
  "s.status",
  "s.next_due_at",
  "s.paused_until",
  "s.cycle",
  "s.missed_in_row",
  "s.swap_variant_id",
  "s.origin_order_id",
  "s.cancelled_at",
  "s.cancel_reason",
  "s.created_at",
  "s.updated_at",
];

// the product as shoppers see it (the founder's published title and picture,
// lib/catalog/effective.js), with the live join only where the table exists
const withNames = (live) => (q) => {
  let x = q.leftJoin("variants as v", "v.id", "s.variant_id").leftJoin("products as p", "p.id", "s.product_id");
  if (live) x = x.leftJoin(`${LIVE_TABLE} as c`, "c.product_id", "p.id");
  return x.select([effectiveExpr("title", live).as("product_title"), effectiveExpr("featured_image", live).as("featured_image"), "p.handle", "v.title as variant_title", "v.image_url", "v.available"]);
};

// The shopper's own subscriptions only (newest first, cancelled last).
export async function subscriptionsOf(customerId) {
  if (!customerId || !(await subscriptionsReady())) return [];
  return readEffective((live) =>
    db
      .selectFrom("subscriptions as s")
      .select(VIEW_COLUMNS)
      .$call(withNames(live))
      .where("s.customer_id", "=", customerId)
      .orderBy(sql`CASE WHEN s.status = 'cancelled' THEN 1 ELSE 0 END`)
      .orderBy("s.created_at", "desc")
      .limit(50)
      .execute(),
  );
}

// Ownership is in the WHERE: another shopper's id is simply not found.
export async function ownSubscription(customerId, id) {
  if (!customerId || typeof id !== "string" || !(await subscriptionsReady())) return null;
  return (await db.selectFrom("subscriptions").selectAll().where("id", "=", id).where("customer_id", "=", customerId).executeTakeFirst()) || null;
}

// One subscription with the names the console shows (any age).
export async function subscriptionViewById(id) {
  if (typeof id !== "string" || !(await subscriptionsReady())) return null;
  const row = await readEffective((live) =>
    db
      .selectFrom("subscriptions as s")
      .select(VIEW_COLUMNS)
      .$call(withNames(live))
      .leftJoin("customers as cu", "cu.id", "s.customer_id")
      .select(["cu.email as customer_email", "cu.name as customer_name"])
      .where("s.id", "=", id)
      .executeTakeFirst(),
  );
  return row || null;
}

export async function subscriptionById(id) {
  if (typeof id !== "string" || !(await subscriptionsReady())) return null;
  return (await db.selectFrom("subscriptions").selectAll().where("id", "=", id).executeTakeFirst()) || null;
}

// The console's list: newest first, optionally one status.
export async function listSubscriptions({ status = null, limit = 100 } = {}) {
  if (!(await subscriptionsReady())) return [];
  return readEffective((live) => {
    let q = db
      .selectFrom("subscriptions as s")
      .select(VIEW_COLUMNS)
      .$call(withNames(live))
      .leftJoin("customers as cu", "cu.id", "s.customer_id")
      .select(["cu.email as customer_email", "cu.name as customer_name"]);
    if (status && STATUSES.includes(status)) q = q.where("s.status", "=", status);
    return q.orderBy("s.created_at", "desc").limit(Math.min(limit, 200)).execute();
  });
}

export async function cyclesOf(subscriptionId) {
  return db.selectFrom("subscription_cycles").selectAll().where("subscription_id", "=", subscriptionId).orderBy("cycle", "desc").limit(50).execute();
}

export async function customerEmail(customerId) {
  if (!customerId) return null;
  const c = await db.selectFrom("customers").select(["email"]).where("id", "=", customerId).executeTakeFirst();
  return c?.email || null;
}

// Privacy erase (lib/privacy.js): the account's subscriptions are cancelled
// and keep no link to the person. → rows changed
export async function anonymizeSubscriptionsOf(customerId) {
  if (!customerId || !(await subscriptionsReady())) return 0;
  const ts = nowIso();
  const cancelled = await db
    .updateTable("subscriptions")
    .set({ status: "cancelled", cancelled_at: ts, cancel_reason: "privacy_erase", updated_at: ts })
    .where("customer_id", "=", customerId)
    .where("status", "<>", "cancelled")
    .executeTakeFirst();
  await db.updateTable("subscriptions").set({ customer_id: null, updated_at: ts }).where("customer_id", "=", customerId).execute();
  return Number(cancelled?.numUpdatedRows ?? 0);
}
