// Phase 9 line 4: a store's parcels as the courier last reported them (tenant
// table shipment_tracking, migration 0041). SERVER-ONLY, tenant-scoped: every
// call runs inside withTenant(). Reads only, and only the database: the order
// page's Tracking block and the admin order view load this file, so it
// reaches no courier, egress, event or install code (the writes are
// lib/couriers/tracking.js).
//   trackingForOrder(orderId)   the order's newest parcel, or null (the sweep's
//                               "unmatched" placeholders are never shown)
import { db } from "./db.js";
import { notMigratedYet } from "./schema-shape.js";
import { STATUSES } from "./couriers/normalize.js";

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const missing = (e) => notMigratedYet(e, { table: "shipment_tracking" });

function view(row) {
  if (!row) return null;
  return {
    awb: String(row.awb),
    orderId: String(row.order_id),
    courier: row.courier ?? null,
    status: STATUSES.includes(row.status) ? row.status : "in_transit",
    statusLabel: row.status_label ?? null,
    etd: row.etd ?? null,
    deliveredAt: row.delivered_at ?? null,
    returnAwb: row.return_awb ?? null,
    scans: parse(row.scans, []),
    lastEventAt: row.last_event_at ?? null,
    fetchedAt: row.fetched_at ?? null,
  };
}

export async function trackingForOrder(orderId) {
  if (typeof orderId !== "string" || !orderId) return null;
  try {
    const row = await db.selectFrom("shipment_tracking").selectAll().where("order_id", "=", orderId).where("source", "<>", "unmatched").orderBy("created_at", "desc").orderBy("awb", "desc").executeTakeFirst();
    return view(row);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

