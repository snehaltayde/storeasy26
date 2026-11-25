// Order queries for the tenant console (Session 22). Reads only — mutations go
// through the existing state machine (lib/orders.js, lib/shopify-push.js).
import { db } from "../db.js";
import { ORDER_STATUS } from "../orders.js";

export const LIST_LIMIT = 50;

const STATUSES = new Set(Object.values(ORDER_STATUS));
// Phase 2 line 2: the payment filter. "online" is every method but cash on delivery.
export const PAYMENT_FILTERS = Object.freeze(["cod", "online"]);

// Phase 2 line 2: the cursor is the pair (created_at, id) of the previous
// page's last row, as one opaque string, so rows sharing a timestamp are
// neither skipped nor repeated (migration 0029 indexes the pair). The old
// plain ISO `before` is still accepted (created_at only).
export const encodeCursor = (row) => Buffer.from(`${row.created_at}~${row.id}`, "utf8").toString("base64url");
export function decodeCursor(before) {
  const s = typeof before === "string" ? before.trim() : "";
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return { createdAt: s, id: null };
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const cut = raw.indexOf("~");
  if (cut <= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return null; // not ours: no cursor, first page
  return { createdAt: raw.slice(0, cut), id: raw.slice(cut + 1) || null };
}

// The filters the list and its counts share. `q` matches order id, email,
// phone or the Shopify order number (the number the order page shows, the
// tail of shopify_order_id) — contains, case-insensitive via LIKE. piiSearch
// false (Phase 0 line 2, S4): `q` matches the order id only, so a role that
// may not see customer details can't learn them by searching for them.
function filtered(query, { payment = null, q = null, piiSearch = true }) {
  if (payment === "cod") query = query.where("payment_method", "=", "cod");
  else if (payment === "online") query = query.where("payment_method", "!=", "cod");
  const term = String(q ?? "").trim();
  if (term) {
    const needle = `%${term}%`;
    const shopifyNo = term.replace(/^#/, "");
    query = piiSearch
      ? query.where((eb) =>
          eb.or([
            eb("id", "like", needle),
            eb("email", "like", needle),
            eb("phone", "like", needle),
            ...(/^\d+$/.test(shopifyNo) ? [eb("shopify_order_id", "like", `%/${shopifyNo}`)] : []),
          ]),
        )
      : query.where("id", "like", needle);
  }
  return query;
}

// Filterable, searchable, keyset-paginated list, newest first.
export async function listOrders({ status = null, payment = null, q = null, before = null, limit = LIST_LIMIT, piiSearch = true } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || LIST_LIMIT), 100);
  let query = filtered(
    db
      .selectFrom("orders")
      .select(["id", "status", "payment_method", "total", "currency", "email", "phone", "name", "created_at", "paid_at", "shopify_order_id", "sync_attempts", "sync_error"])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(size + 1),
    { payment, q, piiSearch },
  );
  if (status && STATUSES.has(status)) query = query.where("status", "=", status);
  const cursor = decodeCursor(before);
  if (cursor?.id) query = query.where((eb) => eb.or([eb("created_at", "<", cursor.createdAt), eb.and([eb("created_at", "=", cursor.createdAt), eb("id", "<", cursor.id)])]));
  else if (cursor) query = query.where("created_at", "<", cursor.createdAt);
  // libsql rows aren't plain objects — spread before they cross the RSC →
  // client boundary (React refuses classes from Server Components).
  const rows = (await query.execute()).map((r) => ({ ...r }));
  const more = rows.length > size;
  const orders = more ? rows.slice(0, size) : rows;
  return { orders, nextBefore: more ? encodeCursor(orders[orders.length - 1]) : null };
}

// Status → count map for the console's filter tabs (one grouped query), under
// the same payment and search filters as the list, so a tab's count is what
// that tab shows.
export async function orderStatusCounts({ payment = null, q = null, piiSearch = true } = {}) {
  const rows = await filtered(db.selectFrom("orders").select(["status", (eb) => eb.fn.countAll().as("n")]).groupBy("status"), { payment, q, piiSearch }).execute();
  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  counts.all = rows.reduce((s, r) => s + Number(r.n), 0);
  return counts;
}

// Phase 2 line 2: whether an order id exists here (the order route answers an
// unknown order with 404 before any push, reconcile or cancel).
export async function orderExists(id) {
  if (typeof id !== "string" || !id) return false;
  return Boolean(await db.selectFrom("orders").select("id").where("id", "=", id).executeTakeFirst());
}
