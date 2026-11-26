// Phase 9 line 1: review invites, the shopper's review, opt-outs and the
// storefront's approved-only reads. Tenant-scoped (every call runs inside
// withTenant against the store's own database) and Edge-safe: the storefront
// write page and blocks reach it.
//
// Shopper reads return approved reviews only and never an email, order id or
// customer id. A store one migration behind (no 0040 tables) reads as empty.
import { db, libsql } from "../db.js";
import { newId } from "../platform/sessions.js";
import { notMigratedYet } from "../schema-shape.js";
import { byIds } from "../catalog/effective.js";
import { tenantId } from "../tenant-context.js";
import { flagState } from "../platform/flags.js";
import { killFlag } from "../plugins/catalog.js";
import { INVITE_TTL_DAYS, reviewWritePath, tokenInviteId, verifyInviteToken } from "./tokens.js";

const DAY = 24 * 60 * 60 * 1000;
export const LIMITS = Object.freeze({ title: 80, bodyMin: 20, bodyMax: 2000, name: 40, reply: 1000 });
export const REFUSED = "This review link has already been used or has expired.";

const noTables = (e) => notMigratedYet(e, { table: "reviews" }) || notMigratedYet(e, { table: "review_invites" }) || notMigratedYet(e, { table: "review_optouts" });
async function orEmpty(fn, empty) {
  try {
    return await fn();
  } catch (e) {
    if (noTables(e)) return empty;
    throw e;
  }
}
const stmt = (q) => {
  const { sql, parameters } = q.compile();
  return { sql, args: parameters };
};
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const clean = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" ? c : "")).replace(/\n{3,}/g, "\n\n").trim();
const oneLine = (v) => String(v ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();

// "Priya Sharma" → "Priya S."; nothing → "".
export function displayNameFrom(name) {
  const parts = oneLine(name).split(" ").filter(Boolean);
  if (!parts.length) return "";
  const first = parts[0].slice(0, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : first;
}

// true when the store has Reviews installed and on, and Storeasy hasn't turned
// it off (ff_plugin-reviews). The write page, POST /api/reviews and the
// all-reviews page answer only then. Fails closed: a kill switch that can't be
// read counts as off.
export async function reviewsActive() {
  try {
    const row = await db.selectFrom("plugin_installs").select("id").where("plugin_id", "=", "reviews").where("status", "=", "enabled").executeTakeFirst();
    if (!row) return false;
    return (await flagState(killFlag("reviews"), tenantId())) !== false;
  } catch {
    return false;
  }
}

// ---- invites ----------------------------------------------------------------------

// One invite per distinct product on the order (UNIQUE(order_id, product_id):
// a replayed event adds nothing). → the number of invites made.
export async function createInvites({ orderId, productIds, fulfilledAt, sendAfterDays = 7 }) {
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!orderId || !ids.length) return 0;
  const order = await db.selectFrom("orders").select(["id", "customer_id"]).where("id", "=", String(orderId)).executeTakeFirst();
  if (!order) return 0;
  const at = Number.isFinite(Date.parse(fulfilledAt)) ? Date.parse(fulfilledAt) : Date.now();
  const days = Math.min(30, Math.max(1, Math.round(Number(sendAfterDays) || 7)));
  const rows = ids.map((productId) => ({
    id: newId("rvi"),
    order_id: String(order.id),
    product_id: productId,
    customer_id: order.customer_id ?? null,
    send_after: new Date(at + days * DAY).toISOString(),
    sent_at: null,
    // whole seconds: the link's exp is this time in epoch seconds
    expires_at: new Date(Math.floor((at + INVITE_TTL_DAYS * DAY) / 1000) * 1000).toISOString(),
    used_at: null,
    review_id: null,
    created_at: new Date(at).toISOString(),
  }));
  const r = await libsql.batch(rows.map((row) => stmt(db.insertInto("review_invites").values(row).onConflict((oc) => oc.columns(["order_id", "product_id"]).doNothing()))), "write");
  return r.reduce((n, x) => n + Number(x?.rowsAffected ?? 0), 0);
}

// the product as shoppers see it (the founder's published title and picture)
const productCard = async (id) => (await byIds([String(id)]))[0] ?? null;

// The invite a token opens, with its product and the buyer's suggested name,
// or null (used, expired, tampered, another store's, or no secret). One answer
// for every refusal: the caller shows REFUSED.
export async function openInvite(token, now = Date.now()) {
  const id = tokenInviteId(token);
  if (!id) return null;
  return orEmpty(async () => {
    const invite = await db.selectFrom("review_invites").selectAll().where("id", "=", id).executeTakeFirst();
    if (!invite || invite.used_at || !(await verifyInviteToken(invite, token, now))) return null;
    const [product, order] = await Promise.all([productCard(invite.product_id), db.selectFrom("orders").select(["name"]).where("id", "=", invite.order_id).executeTakeFirst()]);
    if (!product) return null;
    return { invite, product, suggestedName: displayNameFrom(order?.name) };
  }, null);
}

// → { ok, errors: { field: words }, value }
export function validateReview(input) {
  const errors = {};
  const rating = Number(input?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = "Choose from 1 to 5 stars.";
  const title = oneLine(input?.title);
  if (title.length > LIMITS.title) errors.title = `The title is ${title.length} characters, and the limit is ${LIMITS.title}.`;
  const body = clean(input?.body);
  if (body.length < LIMITS.bodyMin) errors.body = `Write at least ${LIMITS.bodyMin} characters.`;
  else if (body.length > LIMITS.bodyMax) errors.body = `The review is ${body.length} characters, and the limit is ${LIMITS.bodyMax}.`;
  const name = oneLine(input?.display_name);
  if (!name) errors.display_name = "Add the name to show with your review.";
  else if (name.length > LIMITS.name) errors.display_name = `The name is ${name.length} characters, and the limit is ${LIMITS.name}.`;
  return { ok: !Object.keys(errors).length, errors, value: { rating, title: title || null, body, display_name: name } };
}

export class ReviewError extends Error {
  constructor(code, message, errors = null) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}

// The shopper's review, status pending. The invite is used in the same batch
// (UPDATE ... WHERE used_at IS NULL, and reviews.invite_id is UNIQUE), so two
// submits of one link make one review. → { id }
export async function submitReview(token, input, { now = Date.now() } = {}) {
  const opened = await openInvite(token, now);
  if (!opened) throw new ReviewError("REFUSED", REFUSED);
  const v = validateReview(input);
  if (!v.ok) throw new ReviewError("INVALID", "Some answers need fixing.", v.errors);
  const { invite } = opened;
  const at = new Date(now).toISOString();
  const id = newId("rev");
  const insert = {
    sql: `INSERT INTO reviews (id, product_id, order_id, invite_id, customer_id, rating, title, body, display_name, status, created_at, updated_at)
          SELECT ?, product_id, order_id, id, customer_id, ?, ?, ?, ?, 'pending', ?, ? FROM review_invites WHERE id = ? AND used_at IS NULL`,
    args: [id, v.value.rating, v.value.title, v.value.body, v.value.display_name, at, at, invite.id],
  };
  const use = stmt(db.updateTable("review_invites").set({ used_at: at, review_id: id }).where("id", "=", invite.id).where("used_at", "is", null));
  try {
    const [ins] = await libsql.batch([insert, use], "write");
    if (!Number(ins?.rowsAffected ?? 0)) throw new ReviewError("REFUSED", REFUSED);
  } catch (e) {
    if (e instanceof ReviewError) throw e;
    if (/UNIQUE constraint/i.test(String(e?.message || "") + String(e?.cause?.message || ""))) throw new ReviewError("REFUSED", REFUSED);
    throw e;
  }
  return { id };
}

// The "Review {product}" links for an order (its order page, after the page's
// own signed-link check): unused, unexpired invites of products still in the
// catalog. Recomputed each time; no token is stored.
export async function inviteLinks(orderId, now = Date.now()) {
  if (!orderId) return [];
  return orEmpty(async () => {
    const rows = await db
      .selectFrom("review_invites")
      .select(["id", "order_id", "product_id", "expires_at"])
      .where("order_id", "=", String(orderId))
      .where("used_at", "is", null)
      .where("expires_at", ">", new Date(now).toISOString())
      .orderBy("created_at")
      .orderBy("id")
      .limit(20)
      .execute();
    const cards = new Map((await byIds(rows.map((r) => r.product_id))).map((p) => [String(p.id), p]));
    const out = [];
    for (const r of rows) {
      const card = cards.get(String(r.product_id));
      const href = card ? await reviewWritePath(r) : null;
      if (href) out.push({ label: `Review ${oneLine(card.title)}`.slice(0, 120), href });
    }
    return out;
  }, []);
}

// ---- opt-outs ---------------------------------------------------------------------

export const recordOptOut = (hash, now = Date.now()) =>
  db.insertInto("review_optouts").values({ email_hash: hash, created_at: new Date(now).toISOString() }).onConflict((oc) => oc.column("email_hash").doNothing()).execute();

export const isOptedOut = async (hash) => !!hash && !!(await db.selectFrom("review_optouts").select("email_hash").where("email_hash", "=", hash).executeTakeFirst());

// ---- the storefront's reads (approved only) ---------------------------------------

const PUBLIC_COLUMNS = ["r.id", "r.rating", "r.title", "r.body", "r.display_name", "r.reply", "r.created_at"];

// → [{ id, rating, title, body, name, reply, date }] newest first
export async function approvedReviews(productId, { limit = 10, offset = 0, replies = true } = {}) {
  if (!productId) return [];
  return orEmpty(async () => {
    const rows = await db
      .selectFrom("reviews as r")
      .select(PUBLIC_COLUMNS)
      .where("r.product_id", "=", String(productId))
      .where("r.status", "=", "approved")
      .orderBy("r.created_at", "desc")
      .orderBy("r.id", "desc")
      .limit(Math.min(50, Math.max(1, limit)))
      .offset(Math.max(0, offset))
      .execute();
    return rows.map((r) => ({ id: String(r.id), rating: Number(r.rating), title: r.title ? String(r.title) : "", body: String(r.body), name: String(r.display_name), reply: replies && r.reply ? String(r.reply) : "", date: String(r.created_at) }));
  }, []);
}
