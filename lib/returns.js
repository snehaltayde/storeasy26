// Return requests (Session 46 / SF21). SERVER-ONLY, tenant-scoped.
//
// THE RULE, enforced and stated everywhere: APPROVAL IS NOT A REFUND.
// Approving authorizes the physical return; money moves only through the
// provider refund flow (Shopify/Razorpay per docs/refunds.md), which the
// S31 projection mirrors back onto the order. This module never touches
// money columns.
import { db } from "./db.js";
import { tenantCfg } from "./tenant-context.js";
import { slog } from "./log.js";

const rid = () => "ret_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = () => new Date().toISOString();

export const returnsWindowDays = () => Number(tenantCfg("returns_window_days", null, 14)) || 14;

// Which orders may request a return: money committed + not cancelled, inside
// the window. Fulfilment state is advisory (COD stores often lack it).
export function returnEligibility(order, { now = Date.now(), windowDays = 14 } = {}) {
  if (!order) return { ok: false, reason: "order not found" };
  if (["pending_payment", "cancelled"].includes(order.status)) return { ok: false, reason: "this order was never completed" };
  const ageDays = (now - new Date(order.created_at).getTime()) / 86400000;
  if (ageDays > windowDays) return { ok: false, reason: `the ${windowDays}-day return window has passed` };
  if (Number(order.refunded_total) >= Number(order.total)) return { ok: false, reason: "this order is already fully refunded" };
  return { ok: true };
}

export async function requestReturn({ customerId, orderId, reason }) {
  const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).where("customer_id", "=", customerId).executeTakeFirst();
  const elig = returnEligibility(order, { windowDays: returnsWindowDays() });
  if (!elig.ok) throw new Error(elig.reason);
  const text = String(reason || "").trim().slice(0, 1000);
  if (text.length < 10) throw new Error("Tell us a little more about why (at least 10 characters).");
  const open = await db
    .selectFrom("return_requests")
    .select("id")
    .where("order_id", "=", orderId)
    .where("status", "in", ["requested", "approved"])
    .executeTakeFirst();
  if (open) throw new Error("A return is already open for this order.");

  const row = { id: rid(), order_id: orderId, customer_id: customerId, reason: text, status: "requested", note: null, created_at: nowIso(), updated_at: nowIso() };
  await db.insertInto("return_requests").values(row).execute();

  // merchant heads-up via the notification service (best-effort)
  try {
    const { notify } = await import("./notifications.js");
    const site = tenantCfg("site", null, null) || {};
    await notify({
      type: "return_requested",
      to: site.support_email || "",
      subject: `Return requested on ${orderId}`,
      text: `A shopper requested a return on order ${orderId}.\nReason: ${text}\n\nReview it in the console (Orders tab). Approving authorizes the return — it does NOT move money; refund via the provider as usual.`,
      idempotencyKey: `return_${row.id}`,
    });
  } catch {
    /* notification is a courtesy, never a blocker */
  }
  slog("return_requested", { order: orderId, request: row.id });
  return row;
}

export async function returnsForCustomer(customerId) {
  try {
    const rows = await db.selectFrom("return_requests").selectAll().where("customer_id", "=", customerId).orderBy("created_at", "desc").execute();
    return rows.map((r) => ({ ...r }));
  } catch {
    return [];
  }
}

export async function returnForOrder(customerId, orderId) {
  try {
    const r = await db
      .selectFrom("return_requests")
      .selectAll()
      .where("order_id", "=", orderId)
      .where("customer_id", "=", customerId)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return r || null;
  } catch {
    return null;
  }
}

// ---- merchant side -----------------------------------------------------------

export async function listReturns({ status = null, limit = 50 } = {}) {
  try {
    let q = db
      .selectFrom("return_requests as r")
      .leftJoin("orders as o", "o.id", "r.order_id")
      .select(["r.id", "r.order_id", "r.reason", "r.status", "r.note", "r.created_at", "r.updated_at", "o.total", "o.currency", "o.refunded_total"]);
    if (status) q = q.where("r.status", "=", status);
    const rows = await q.orderBy("r.created_at", "desc").limit(Math.min(limit, 200)).execute();
    return rows.map((r) => ({ ...r }));
  } catch {
    return [];
  }
}

export async function decideReturn(id, { action, note = "" }) {
  if (!["approve", "reject", "complete"].includes(action)) throw new Error("action must be approve, reject or complete");
  const row = await db.selectFrom("return_requests").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new Error("return request not found");
  const next = action === "approve" ? "approved" : action === "reject" ? "rejected" : "completed";
  const allowed = { requested: ["approved", "rejected"], approved: ["completed", "rejected"] };
  if (!(allowed[row.status] || []).includes(next)) throw new Error(`a ${row.status} request can't become ${next}`);
  await db
    .updateTable("return_requests")
    .set({ status: next, note: String(note || "").trim().slice(0, 500) || row.note, updated_at: nowIso() })
    .where("id", "=", id)
    .execute();
  slog("return_decided", { request: id, status: next });
  return { id, status: next, moneyNote: "approval/completion moves NO money — refund via the provider; the order mirrors it" };
}
