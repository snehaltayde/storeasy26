// Phase 9 line 2: what a shopper (their own subscriptions only) and the store
// (staff and up, with a reason) can do to a subscription. SERVER-ONLY.
// Every change is one conditional UPDATE naming the state it moves from, so a
// double press or two tabs change it once. Nothing is ever deleted: a
// cancelled subscription stays as cancelled.
import { db } from "../db.js";
import { addDays, eligibleFor, subscriptionSettings, QUANTITY_MAX } from "./pricing.js";
import { ownSubscription, subscriptionById, nowIso, subscriptionClock, moveOnSwap } from "./store.js";
import { payableNow } from "./renewal.js";

export class SubscriptionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
// another shopper's id answers exactly as a missing one
export const NOT_FOUND = () => new SubscriptionError(404, "NOT_FOUND", "subscription not found");
const conflict = (words) => new SubscriptionError(409, "CONFLICT", words);
const invalid = (words) => new SubscriptionError(422, "INVALID", words);
const OFF = "Subscriptions are turned off for this store right now. You can still cancel.";
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

async function changed(id, from, patch) {
  const res = await db.updateTable("subscriptions").set({ ...patch, updated_at: nowIso() }).where("id", "=", id).where("status", "in", from).executeTakeFirst();
  if (!Number(res?.numUpdatedRows ?? 0)) throw conflict("This subscription changed while you were looking at it. Reload and try again.");
  return db.selectFrom("subscriptions").selectAll().where("id", "=", id).executeTakeFirst();
}

async function liveSettings() {
  const s = await subscriptionSettings();
  if (!s) throw conflict(OFF);
  return s;
}

// Skip next: the cycle is marked skipped and the due date moves one interval.
async function skip(sub) {
  if (sub.status !== "active") throw conflict("Only an active subscription can skip a delivery.");
  await liveSettings();
  const ts = nowIso();
  const cycle = Number(sub.cycle);
  const res = await db
    .updateTable("subscriptions")
    .set({ cycle: cycle + 1, next_due_at: addDays(sub.next_due_at, Number(sub.interval_days)), missed_in_row: 0, ...moveOnSwap, updated_at: ts })
    .where("id", "=", sub.id)
    .where("cycle", "=", cycle)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!Number(res?.numUpdatedRows ?? 0)) throw conflict("This delivery was already skipped or paid for. Reload to see the next one.");
  await db
    .insertInto("subscription_cycles")
    .values({ subscription_id: sub.id, cycle, due_at: sub.next_due_at, status: "skipped", order_id: null, reminded_at: null, updated_at: ts })
    .onConflict((oc) => oc.columns(["subscription_id", "cycle"]).doUpdateSet({ status: "skipped", updated_at: ts }).where("subscription_cycles.order_id", "is", null))
    .execute();
  return db.selectFrom("subscriptions").selectAll().where("id", "=", sub.id).executeTakeFirst();
}

// Pause until a date (YYYY-MM-DD, after today, within a year) or until resumed.
async function pause(sub, { until = null } = {}) {
  let pausedUntil = null;
  if (until != null && until !== "") {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(String(until)) ? Date.parse(`${until}T00:00:00.000Z`) : NaN;
    const now = subscriptionClock.now();
    if (!Number.isFinite(t) || t <= now || t > now + YEAR_MS) throw invalid("Pick a date after today and within a year, or pause until you resume.");
    pausedUntil = new Date(t).toISOString();
  }
  return changed(sub.id, ["active"], { status: "paused", paused_until: pausedUntil });
}

// Resume: active again; a due date already passed becomes today.
async function resume(sub) {
  await liveSettings();
  const now = nowIso();
  return changed(sub.id, ["paused"], { status: "active", paused_until: null, missed_in_row: 0, next_due_at: sub.next_due_at < now ? now : sub.next_due_at });
}

// Swap: another variant of this product or of an eligible product, at its
// price today, from the next delivery (the locked percent stays).
async function swap(sub, { variantId } = {}) {
  if (sub.status === "cancelled") throw conflict("A cancelled subscription can't be changed.");
  const settings = await liveSettings();
  if (typeof variantId !== "string" || !variantId) throw invalid("Pick what to swap to.");
  const v = await db
    .selectFrom("variants as v")
    .innerJoin("products as p", "p.id", "v.product_id")
    .select(["v.id", "v.product_id", "v.available", "p.tags"])
    .where("v.id", "=", variantId)
    .executeTakeFirst();
  let tags = [];
  try {
    tags = JSON.parse(v?.tags ?? "[]");
  } catch {
    tags = [];
  }
  if (!v || !(v.product_id === sub.product_id || eligibleFor(settings, tags))) throw invalid("That product can't be subscribed to. Pick another.");
  if (!v.available) throw invalid("That one is sold out right now. Pick another.");
  // from the next delivery: one already due (payable now) keeps what it was
  if (payableNow(sub, settings)) return changed(sub.id, ["active"], { swap_variant_id: v.id, swap_product_id: v.product_id });
  return changed(sub.id, ["active", "paused"], { variant_id: v.id, product_id: v.product_id, swap_variant_id: null, swap_product_id: null });
}

// Change interval (one the store offers, or the current one) or quantity (1–10).
async function change(sub, { interval, quantity } = {}) {
  if (sub.status === "cancelled") throw conflict("A cancelled subscription can't be changed.");
  const settings = await liveSettings();
  const patch = {};
  if (interval !== undefined) {
    const d = Number(interval);
    if (!(Number.isInteger(d) && (settings.intervals.includes(d) || d === Number(sub.interval_days)))) throw invalid("Pick one of the delivery intervals shown.");
    patch.interval_days = d;
  }
  if (quantity !== undefined) {
    const q = Number(quantity);
    if (!(Number.isInteger(q) && q >= 1 && q <= QUANTITY_MAX)) throw invalid(`The quantity must be a whole number from 1 to ${QUANTITY_MAX}.`);
    patch.quantity = q;
  }
  if (!Object.keys(patch).length) throw invalid("Nothing to change.");
  return changed(sub.id, ["active", "paused"], patch);
}

async function cancel(sub, { reason = "customer" } = {}) {
  return changed(sub.id, ["active", "paused"], { status: "cancelled", cancelled_at: nowIso(), cancel_reason: String(reason).slice(0, 200) });
}

const SHOPPER = { skip, pause, resume, swap, change, cancel };

// The shopper's own subscription, or 404 (another shopper's id included; that
// row is never read further, so it can't change).
export async function shopperAction(customerId, action, id, args = {}) {
  if (!Object.hasOwn(SHOPPER, action)) throw invalid("Unknown action.");
  const sub = await ownSubscription(customerId, id);
  if (!sub) throw NOT_FOUND();
  if (action === "cancel") return cancel(sub, { reason: "customer" });
  return SHOPPER[action](sub, args);
}

// The store (subscriptions.manage): pause or cancel for a customer, with a
// reason the caller audits.
export async function merchantAction(action, id, { reason } = {}) {
  if (action !== "pause" && action !== "cancel") throw invalid("Unknown action.");
  const words = String(reason ?? "").trim();
  if (!words || words.length > 200) throw invalid("Say why, in up to 200 characters.");
  const sub = await subscriptionById(id);
  if (!sub) throw NOT_FOUND();
  return action === "pause" ? pause(sub) : cancel(sub, { reason: `store: ${words}` });
}
