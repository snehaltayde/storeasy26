// Phase 9 line 1: the merchant console's review queue and moderation. Node
// only (audit). Tenant-scoped: every call runs inside withTenant. Reads need
// reviews.read (support and up), writes reviews.moderate (staff and up); the
// route checks both through requireAdmin. Support sees no email and no order
// id (redactReviewForRole). Every write records an audit_log row
// (reviews.<action>) and invalidates the store's "plugins" cache tag, which
// the storefront's stars, list and JSON-LD read through.
import { db } from "../db.js";
import { invalidateTenantCache } from "../cache.js";
import { audit } from "../platform/audit.js";
import { redactsPii } from "../admin/order-view.js";
import { notMigratedYet } from "../schema-shape.js";
import { LIMITS } from "./store.js";

export const STATUSES = Object.freeze(["pending", "approved", "rejected", "hidden"]);
export const BULK_MAX = 50;
export const REASON_MAX = 200;
// action → [the states it applies to, the state it leaves]
export const ACTIONS = Object.freeze({
  approve: [["pending", "rejected"], "approved"],
  reject: [["pending", "approved"], "rejected"],
  hide: [["approved"], "hidden"],
  restore: [["hidden"], "approved"],
});
const BULK_ACTIONS = ["approve", "reject"];

export class ModerationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const missing = (e) => notMigratedYet(e, { table: "reviews" });
const actorString = (actor) => `${actor?.kind ?? "system"}:${actor?.id ?? ""}`;
const oneLine = (v) => String(v ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
const clean = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" ? c : " ")).replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// → { reviews, counts: { pending, approved, rejected, hidden }, products: [{ id, title }] }
export async function listQueue({ status = "pending", rating = null, productId = null, limit = 50 } = {}) {
  const st = STATUSES.includes(status) ? status : "pending";
  try {
    let q = db
      .selectFrom("reviews as r")
      .leftJoin("products as p", "p.id", "r.product_id")
      .leftJoin("orders as o", "o.id", "r.order_id")
      .select(["r.id", "r.product_id", "r.order_id", "r.rating", "r.title", "r.body", "r.display_name", "r.status", "r.reject_reason", "r.reply", "r.reply_at", "r.moderated_at", "r.created_at", "p.title as product_title", "p.handle as product_handle", "o.email as email"])
      .where("r.status", "=", st);
    const stars = Number(rating);
    if (Number.isInteger(stars) && stars >= 1 && stars <= 5) q = q.where("r.rating", "=", stars);
    if (productId) q = q.where("r.product_id", "=", String(productId));
    const rows = await q.orderBy("r.created_at", "desc").orderBy("r.id", "desc").limit(Math.min(200, Math.max(1, limit))).execute();
    const countRows = await db.selectFrom("reviews").select(["status", (eb) => eb.fn.countAll().as("n")]).groupBy("status").execute();
    const counts = { pending: 0, approved: 0, rejected: 0, hidden: 0 };
    for (const c of countRows) if (Object.hasOwn(counts, c.status)) counts[c.status] = Number(c.n);
    const products = await db.selectFrom("reviews as r").innerJoin("products as p", "p.id", "r.product_id").select(["p.id", "p.title"]).distinct().orderBy("p.title").limit(200).execute();
    return {
      reviews: rows.map((r) => ({
        id: String(r.id),
        productId: String(r.product_id),
        productTitle: r.product_title ? String(r.product_title) : "A product no longer in the catalog",
        productHandle: r.product_handle ? String(r.product_handle) : null,
        orderId: String(r.order_id),
        email: r.email ? String(r.email) : null,
        rating: Number(r.rating),
        title: r.title ? String(r.title) : "",
        body: String(r.body),
        name: String(r.display_name),
        status: String(r.status),
        rejectReason: r.reject_reason ? String(r.reject_reason) : null,
        reply: r.reply ? String(r.reply) : "",
        replyAt: r.reply_at ? String(r.reply_at) : null,
        moderatedAt: r.moderated_at ? String(r.moderated_at) : null,
        createdAt: String(r.created_at),
        verified: true,
      })),
      counts,
      products: products.map((p) => ({ id: String(p.id), title: String(p.title) })),
    };
  } catch (e) {
    if (missing(e)) return { reviews: [], counts: { pending: 0, approved: 0, rejected: 0, hidden: 0 }, products: [] };
    throw e;
  }
}

// Support (and an operator under a support grant) sees no email and no order
// id; the reject reason is internal staff text, so it goes too.
export function redactReviewForRole(review, role) {
  if (!review || !redactsPii(role)) return review;
  return { ...review, email: null, orderId: null, rejectReason: null, pii_redacted: true };
}

// moderate({ ids, action, reason?, actor }) → { changed, skipped }
// One id, or up to BULK_MAX for approve and reject. A review not in a state
// the action applies to is skipped (and counted), never forced.
export async function moderate({ ids, action, reason = null, actor }) {
  if (!Object.hasOwn(ACTIONS, action)) throw new ModerationError(400, "BAD_ACTION", "Choose Approve, Reject, Hide or Restore.");
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === "string" && x))];
  if (!list.length) throw new ModerationError(400, "NO_REVIEWS", "Choose at least one review.");
  if (list.length > 1 && !BULK_ACTIONS.includes(action)) throw new ModerationError(400, "ONE_AT_A_TIME", "Hide and Restore work on one review at a time.");
  if (list.length > BULK_MAX) throw new ModerationError(400, "TOO_MANY", `Choose at most ${BULK_MAX} reviews at a time.`);
  const why = action === "reject" ? oneLine(reason) : "";
  if (why.length > REASON_MAX) throw new ModerationError(422, "REASON_TOO_LONG", `The reason is ${why.length} characters, and the limit is ${REASON_MAX}.`);
  const [from, to] = ACTIONS[action];
  const at = new Date().toISOString();
  const patch = { status: to, moderated_by: actorString(actor), moderated_at: at, updated_at: at };
  if (action === "reject") patch.reject_reason = why || null;
  if (action === "approve") patch.reject_reason = null;
  const r = await db.updateTable("reviews").set(patch).where("id", "in", list).where("status", "in", from).executeTakeFirst();
  const changed = Number(r?.numUpdatedRows ?? 0);
  if (!changed && list.length === 1) {
    const row = await db.selectFrom("reviews").select("status").where("id", "=", list[0]).executeTakeFirst();
    if (!row) throw new ModerationError(404, "NOT_FOUND", "This review isn't here any more. Reload the page.");
    throw new ModerationError(409, "WRONG_STATE", `This review is ${row.status}, so it can't be changed that way. Reload the page.`);
  }
  if (changed) {
    await audit({ actor, action: `reviews.${action}`, resource: list.length === 1 ? `review:${list[0]}` : "reviews", diff: { ids: list.slice(0, BULK_MAX), changed, to } });
    await invalidateTenantCache("plugins");
  }
  return { changed, skipped: list.length - changed };
}

// reply({ id, text, actor }): the store's public reply (empty text removes it).
export async function reply({ id, text, actor }) {
  const words = clean(text);
  if (words.length > LIMITS.reply) throw new ModerationError(422, "REPLY_TOO_LONG", `The reply is ${words.length} characters, and the limit is ${LIMITS.reply}.`);
  const at = new Date().toISOString();
  const r = await db
    .updateTable("reviews")
    .set(words ? { reply: words, reply_by: actorString(actor), reply_at: at, updated_at: at } : { reply: null, reply_by: null, reply_at: null, updated_at: at })
    .where("id", "=", String(id || ""))
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new ModerationError(404, "NOT_FOUND", "This review isn't here any more. Reload the page.");
  await audit({ actor, action: "reviews.reply", resource: `review:${id}`, diff: { reply: words ? "set" : "removed", length: words.length } });
  await invalidateTenantCache("plugins");
  return { reply: words };
}
