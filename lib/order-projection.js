// Order financial/fulfillment projection (Session 31 / BE10). Shopify owns
// refunds and fulfillment; we mirror them by AUTHORITATIVE RECONCILIATION — a
// targeted order fetch rebuilds the whole projection, so duplicate or
// out-of-order webhook deliveries are just extra hints (same philosophy as the
// catalog sync: deliveries hint, refetch decides). An `updatedAt` watermark
// stops interleaved reconciles from writing an older snapshot over a newer one.
//
// The local `status` state machine stays what it always was — payment capture
// + push lifecycle — and NEITHER dimension derives from the other anymore.
import { db } from "./db.js";
import { adminGraphql } from "./shopify-admin.js";
import { roundMoney } from "./money.js";
import { transitionOrder, canTransition, ORDER_STATUS } from "./orders.js";
import { slog } from "./log.js";
import { hasColumns } from "./schema-compat.js";

const ORDER_PROJECTION_QUERY = /* GraphQL */ `
  query ($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        name
        updatedAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        refunds {
          id
          createdAt
          note
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        fulfillments(first: 25) {
          id
          status
          updatedAt
          trackingInfo(first: 5) { company number url }
        }
      }
    }
  }
`;

const lower = (s) => (s == null ? null : String(s).toLowerCase());

// Fetch the authoritative snapshot and rebuild the projection for ONE order.
// Returns { ok, skipped?, stale?, financial_status?, fulfillment_status?,
// refunded_total?, refunds?, fulfillments? }. gql is injectable for tests.
export async function reconcileOrderProjection(orderId, { gql = adminGraphql } = {}) {
  const order = await db
    .selectFrom("orders")
    // Phase 8 line 4: a market order's base currency (0039), the one Shopify refunds in
    .select(["id", "status", "shopify_order_id", "provider_updated_at", "currency", "fulfillment_status", ...((await hasColumns("orders", ["base_currency"])) ? ["base_currency"] : [])])
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (!order) return { ok: false, skipped: "unknown_order" };
  if (!order.shopify_order_id) return { ok: true, skipped: "not_pushed" };

  const data = await gql(ORDER_PROJECTION_QUERY, { id: order.shopify_order_id });
  const o = data?.node;
  if (!o) return { ok: false, skipped: "shopify_order_missing" };

  // Watermark: never let an older snapshot (interleaved reconcile, delayed
  // worker) overwrite a newer one — no status regression, no revenue rewind.
  if (order.provider_updated_at && o.updatedAt && o.updatedAt < order.provider_updated_at) {
    return { ok: true, stale: true, skipped: "older_snapshot" };
  }

  // Phase 8 line 4: Shopify's refunds are in the shop's (base) currency. A
  // market order was pushed in base money, so its refunds keep their own
  // currency code and precision, and refunded_total is base money too
  // (compared with COALESCE(base_total, total), lib/returns.js).
  const currency = order.base_currency || order.currency || "INR";
  const refunds = (o.refunds || []).map((r) => ({
    id: r.id,
    order_id: orderId,
    amount: roundMoney(Number(r.totalRefundedSet?.shopMoney?.amount || 0), r.totalRefundedSet?.shopMoney?.currencyCode || currency),
    currency: r.totalRefundedSet?.shopMoney?.currencyCode || currency,
    note: r.note || null,
    created_at: r.createdAt || null,
  }));
  const fulfillments = (o.fulfillments || []).flatMap((f) => {
    const tracks = (f.trackingInfo || []).filter((t) => t.number);
    const base = { order_id: orderId, status: f.status || null, updated_at: f.updatedAt || null };
    if (!tracks.length) return [{ id: f.id, ...base, tracking_company: null, tracking_number: null, tracking_url: null }];
    return tracks.map((t, i) => ({
      id: i === 0 ? f.id : `${f.id}::${i}`, // one row per parcel/tracking number
      ...base,
      tracking_company: t.company || null,
      tracking_number: t.number,
      tracking_url: t.url || null,
    }));
  });
  const refundedTotal = roundMoney(
    refunds.reduce((a, r) => a + r.amount, 0),
    currency,
  );
  const financial = o.cancelledAt && lower(o.displayFinancialStatus) === "voided" ? "voided" : lower(o.displayFinancialStatus);

  // authoritative snapshot → replace-all (refund ids are the natural dedup;
  // a replayed reconcile writes the identical rows)
  await db.deleteFrom("order_refunds").where("order_id", "=", orderId).execute();
  for (const r of refunds) await db.insertInto("order_refunds").values(r).execute();
  await db.deleteFrom("order_fulfillments").where("order_id", "=", orderId).execute();
  for (const f of fulfillments) await db.insertInto("order_fulfillments").values(f).execute();
  await db
    .updateTable("orders")
    .set({
      financial_status: financial,
      fulfillment_status: lower(o.displayFulfillmentStatus),
      refunded_total: refundedTotal,
      provider_updated_at: o.updatedAt || null,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", orderId)
    .execute();

  // Phase 4 line 3: apps hear of the move to fulfilled (once per order ever:
  // the event key dedupes); never throws
  if (lower(o.displayFulfillmentStatus) === "fulfilled" && order.fulfillment_status !== "fulfilled") {
    try {
      const { emitOrderEvent } = await import("./plugins/events.js");
      await emitOrderEvent("order.fulfilled", orderId);
    } catch (e) {
      slog("plugin_emit_failed", { topic: "order.fulfilled", order_id: orderId, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // S51: Shopify is authoritative for cancellation too. An order cancelled on
  // the Shopify side (merchant did it there, or ORDERS_CANCELLED arrived)
  // used to keep its local "synced" forever — the two sides must match. Only
  // legal transitions are taken (a mid-push order settles first).
  let adoptedCancellation = false;
  if (o.cancelledAt && order.status !== ORDER_STATUS.CANCELLED && canTransition(order.status, ORDER_STATUS.CANCELLED)) {
    const r = await transitionOrder(orderId, ORDER_STATUS.CANCELLED, {
      meta: { via: "shopify-reconcile", shopify_cancelled_at: o.cancelledAt },
    }).catch(() => null); // lost race → the next reconcile sees the final state
    adoptedCancellation = !!r && !r.already;
  }

  slog("order_projection_reconciled", {
    order_id: orderId,
    financial,
    fulfillment: lower(o.displayFulfillmentStatus),
    refunded: refundedTotal,
    refunds: refunds.length,
    parcels: fulfillments.length,
    ...(adoptedCancellation ? { adopted_cancellation: true } : {}),
  });
  return {
    ok: true,
    financial_status: financial,
    fulfillment_status: lower(o.displayFulfillmentStatus),
    refunded_total: refundedTotal,
    refunds: refunds.length,
    fulfillments: fulfillments.length,
    ...(adoptedCancellation ? { adopted_cancellation: true } : {}),
  };
}

// Webhook entry: the payload names a Shopify order — find ours and reconcile.
export async function reconcileByShopifyOrderGid(gid, { gql } = {}) {
  if (!gid) return { ok: false, skipped: "no_gid" };
  const row = await db
    .selectFrom("orders")
    .select("id")
    .where("shopify_order_id", "=", gid)
    .executeTakeFirst();
  if (!row) return { ok: true, ignored: "no_local_order" }; // not ours (manual Shopify order etc.)
  return reconcileOrderProjection(row.id, { gql });
}

// Read model for the status page + merchant console.
export async function getOrderProjection(orderId) {
  const [refunds, fulfillments] = await Promise.all([
    db.selectFrom("order_refunds").selectAll().where("order_id", "=", orderId).orderBy("created_at", "asc").execute(),
    db.selectFrom("order_fulfillments").selectAll().where("order_id", "=", orderId).orderBy("updated_at", "asc").execute(),
  ]);
  return {
    refunds: refunds.map((r) => ({ ...r })),
    fulfillments: fulfillments.map((f) => ({ ...f })),
  };
}
