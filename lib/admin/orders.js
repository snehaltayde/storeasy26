// Order queries for the tenant console (Session 22). Reads only — mutations go
// through the existing state machine (lib/orders.js, lib/shopify-push.js).
import { db } from "../db.js";
import { ORDER_STATUS } from "../orders.js";

export const LIST_LIMIT = 50;

const STATUSES = new Set(Object.values(ORDER_STATUS));

// Filterable, searchable, keyset-paginated list. `q` matches order id, email,
// or phone (contains, case-insensitive via LIKE); `before` = created_at cursor
// from the previous page's last row. piiSearch false (Phase 0 line 2, S4):
// `q` matches the order id only, so a role that may not see customer details
// can't learn them by searching for them.
export async function listOrders({ status = null, q = null, before = null, limit = LIST_LIMIT, piiSearch = true } = {}) {
  let query = db
    .selectFrom("orders")
    .select([
      "id",
      "status",
      "payment_method",
      "total",
      "currency",
      "email",
      "phone",
      "name",
      "created_at",
      "paid_at",
      "shopify_order_id",
      "sync_attempts",
      "sync_error",
    ])
    .orderBy("created_at", "desc")
    .limit(Math.min(Math.max(1, limit), 100));

  if (status && STATUSES.has(status)) query = query.where("status", "=", status);
  if (before) query = query.where("created_at", "<", before);
  if (q) {
    const needle = `%${String(q).trim()}%`;
    query = piiSearch
      ? query.where((eb) => eb.or([eb("id", "like", needle), eb("email", "like", needle), eb("phone", "like", needle)]))
      : query.where("id", "like", needle);
  }
  // libsql rows aren't plain objects — spread before they cross the RSC →
  // client boundary (React refuses classes from Server Components).
  const rows = (await query.execute()).map((r) => ({ ...r }));
  return {
    orders: rows,
    nextBefore: rows.length >= Math.min(Math.max(1, limit), 100) ? rows[rows.length - 1].created_at : null,
  };
}

// Status → count map for the console's filter tabs (one grouped query).
export async function orderStatusCounts() {
  const rows = await db
    .selectFrom("orders")
    .select(["status", (eb) => eb.fn.countAll().as("n")])
    .groupBy("status")
    .execute();
  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  counts.all = rows.reduce((s, r) => s + Number(r.n), 0);
  return counts;
}
