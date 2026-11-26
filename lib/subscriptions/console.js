// Phase 9 line 2: the console's view of subscriptions (subscriptions.read).
// SERVER-ONLY. A role that redacts PII (support) gets no customer name or
// email, and no cancel reason (a shopper's or a staff member's own words).
import { redactsPii } from "../admin/order-view.js";
import { listSubscriptions, subscriptionViewById, cyclesOf, STATUSES } from "./store.js";
import { renewalFigures } from "./renewal.js";
import { db } from "../db.js";

function row(r, figure, role) {
  const pii = !redactsPii(role);
  return {
    id: r.id,
    productTitle: r.product_title || null,
    variantTitle: r.variant_title && r.variant_title !== "Default Title" ? r.variant_title : null,
    quantity: Number(r.quantity),
    interval: Number(r.interval_days),
    percent: Number(r.discount_percent),
    status: r.status,
    nextDueAt: r.status === "cancelled" ? null : r.next_due_at,
    pausedUntil: r.paused_until || null,
    missedInRow: Number(r.missed_in_row),
    next: figure ? { amount: figure.amount, currency: figure.currency } : null,
    customer: pii ? (r.customer_email ? { email: r.customer_email, name: r.customer_name || null } : null) : null,
    cancelReason: pii ? r.cancel_reason || null : null,
    createdAt: r.created_at,
    ...(pii ? {} : { pii_redacted: true }),
  };
}

export async function consoleList({ status = null, role }) {
  const rows = await listSubscriptions({ status: STATUSES.includes(status) ? status : null });
  const live = rows.filter((r) => r.status !== "cancelled");
  const figures = new Map((await renewalFigures(live)).map((f, k) => [live[k].id, f]));
  return rows.map((r) => row(r, figures.get(r.id) ?? null, role));
}

// One subscription with its history (cycles, newest first) and its first order.
export async function consoleDetail(id, { role }) {
  const sub = await subscriptionViewById(id);
  if (!sub) return null;
  const base = sub;
  const cycles = await cyclesOf(id);
  const orders = cycles.map((c) => c.order_id).filter(Boolean);
  const totals = orders.length ? new Map((await db.selectFrom("orders").select(["id", "total", "currency"]).where("id", "in", orders).execute()).map((o) => [o.id, o])) : new Map();
  return {
    ...row(base, sub.status === "cancelled" ? null : (await renewalFigures([sub]))[0], role),
    originOrderId: sub.origin_order_id,
    history: cycles.map((c) => ({
      cycle: Number(c.cycle),
      dueAt: c.due_at,
      status: c.status,
      orderId: c.order_id || null,
      total: c.order_id && totals.get(c.order_id) ? { amount: Number(totals.get(c.order_id).total), currency: totals.get(c.order_id).currency || "INR" } : null,
      remindedAt: c.reminded_at || null,
    })),
  };
}
