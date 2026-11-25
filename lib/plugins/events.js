// Phase 4 line 3: the plugin outbox. SERVER-ONLY, tenant-scoped (withTenant).
// No node: imports: lib/payment-settle.js (checkout) loads it statically.
//
//   emitOrderEvent(topic, orderId)  snapshot the order (no customer details:
//                       lib/plugins/topics.js orderSnapshot) into plugin_events
//                       under "<topic>:<orderId>" and queue its fan-out. Never
//                       throws: an emit must not fail the flow it rides on.
//   fanOut(eventId)     the plugin_fanout job: one plugin_deliveries row per
//                       subscriber (UNIQUE(event_id, install_id)), each with a
//                       plugin_delivery job, then the 30-day prune. Idempotent:
//                       a re-run adds nothing and re-queues nothing new.
//   Subscribers: enabled custom apps subscribed to the topic and holding its
//   scope (a paused endpoint's row is written Skipped), and enabled
//   first-party installs whose manifest lists the event (not turned off by
//   Storeasy). Job payloads carry ids only.
import { db } from "../db.js";
import { currentTenant, tenantId } from "../tenant-context.js";
import { enqueueDurable, enqueueJob } from "../platform/jobs.js";
import { newId } from "../platform/sessions.js";
import { slog } from "../log.js";
import { orderSnapshot, scopeHeld } from "./topics.js";
import { pluginById } from "./catalog.js";
import { isKilled } from "./installs.js";

export const RETAIN_DAYS = 30;
export const PRUNE_LIMIT = 500;
const DAY_MS = 86_400_000;

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
// the jobs table's tenant (null in legacy single-store mode)
export const jobTenant = () => (tenantId() === "_default" ? null : tenantId());
export const deliveryJobKey = (deliveryId) => `plugin_delivery:${tenantId()}:${deliveryId}`;
export const storeHost = () => currentTenant()?.domains?.[0] ?? null;

export const enqueueDelivery = (deliveryId) =>
  enqueueJob({ type: "plugin_delivery", tenantId: jobTenant(), payload: { deliveryId }, idempotencyKey: deliveryJobKey(deliveryId) });

// → { id, existed } | null. key is the event's idempotency key.
export async function emitPluginEvent(topic, { resource = null, key, data }, { now = new Date() } = {}) {
  const id = newId("evt");
  await db
    .insertInto("plugin_events")
    .values({ id, topic, resource, idempotency_key: key, payload: JSON.stringify(data ?? {}), created_at: now.toISOString(), fanned_out_at: null })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
  const row = await db.selectFrom("plugin_events").select("id").where("idempotency_key", "=", key).executeTakeFirst();
  if (!row) return null;
  await enqueueDurable("plugin_fanout", { eventId: row.id }, `plugin_fanout:${tenantId()}:${row.id}`);
  return { id: String(row.id), existed: row.id !== id };
}

const ORDER_COLUMNS = ["id", "status", "payment_method", "financial_status", "fulfillment_status", "currency", "subtotal", "discount_total", "shipping_total", "total", "coupon_code", "created_at", "paid_at"];
const ITEM_COLUMNS = ["product_id", "variant_id", "title", "variant_title", "quantity", "unit_price", "line_total", "line_discount", "is_gift", "position"];

export async function emitOrderEvent(topic, orderId) {
  try {
    // a store with no app turned on records nothing (events are never backfilled)
    const any = await db.selectFrom("plugin_installs").select("id").where("status", "=", "enabled").limit(1).executeTakeFirst();
    if (!any) return null;
    const order = await db.selectFrom("orders").select(ORDER_COLUMNS).where("id", "=", orderId).executeTakeFirst();
    if (!order) return null;
    const items = await db.selectFrom("order_items").select(ITEM_COLUMNS).where("order_id", "=", orderId).execute();
    return await emitPluginEvent(topic, { resource: `order:${orderId}`, key: `${topic}:${orderId}`, data: { order: orderSnapshot(order, items) } });
  } catch (e) {
    slog("plugin_emit_failed", { topic, order_id: orderId, error: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

async function subscribers(topic) {
  const installs = await db.selectFrom("plugin_installs").selectAll().where("status", "=", "enabled").execute();
  const endpoints = await db.selectFrom("plugin_endpoints").select(["install_id", "topics", "status"]).execute();
  const byInstall = new Map(endpoints.map((e) => [String(e.install_id), e]));
  const out = [];
  for (const i of installs) {
    if (!scopeHeld(topic, parse(i.granted_scopes, []))) continue;
    if (i.kind === "custom") {
      const ep = byInstall.get(String(i.id));
      if (!ep || !parse(ep.topics, []).includes(topic)) continue;
      out.push({ installId: String(i.id), target: "http", paused: ep.status === "paused" });
    } else {
      const m = pluginById(i.plugin_id);
      if (!m?.events?.includes(topic) || (await isKilled(i.plugin_id))) continue;
      out.push({ installId: String(i.id), target: "internal", paused: false });
    }
  }
  return out;
}

export const PAUSED_SKIP = "The webhook was paused, so this wasn't sent. Resend it after you resume.";

export async function fanOut(eventId, { now = new Date() } = {}) {
  const event = await db.selectFrom("plugin_events").select(["id", "topic"]).where("id", "=", String(eventId)).executeTakeFirst();
  if (!event) return { missing: true };
  const at = now.toISOString();
  let created = 0;
  for (const s of await subscribers(event.topic)) {
    const r = await db
      .insertInto("plugin_deliveries")
      .values({
        id: newId("dlv"),
        event_id: event.id,
        install_id: s.installId,
        target: s.target,
        status: s.paused ? "skipped" : "pending",
        attempts: 0,
        next_attempt_at: s.paused ? null : at,
        last_error: s.paused ? PAUSED_SKIP : null,
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) => oc.columns(["event_id", "install_id"]).doNothing())
      .executeTakeFirst();
    created += Number(r?.numInsertedOrUpdatedRows ?? 0);
  }
  // every pending row of this event has its job (idempotent keys: a re-run adds none)
  const pending = await db.selectFrom("plugin_deliveries").select("id").where("event_id", "=", event.id).where("status", "=", "pending").execute();
  for (const d of pending) await enqueueDelivery(String(d.id));
  await db.updateTable("plugin_events").set({ fanned_out_at: at }).where("id", "=", event.id).execute();
  const pruned = await prune({ now }).catch((e) => {
    slog("plugin_prune_failed", { error: String(e?.message || e).slice(0, 200) });
    return null;
  });
  return { eventId: String(event.id), topic: String(event.topic), deliveries: created, pending: pending.length, pruned };
}

// Events and deliveries older than RETAIN_DAYS, up to PRUNE_LIMIT of each per run.
export async function prune({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - RETAIN_DAYS * DAY_MS).toISOString();
  const old = (table) => db.selectFrom(table).select("id").where("created_at", "<", cutoff).orderBy("created_at", "asc").limit(PRUNE_LIMIT);
  const d = await db.deleteFrom("plugin_deliveries").where("id", "in", old("plugin_deliveries")).executeTakeFirst();
  const e = await db.deleteFrom("plugin_events").where("id", "in", old("plugin_events")).executeTakeFirst();
  return { deliveries: Number(d?.numDeletedRows ?? 0), events: Number(e?.numDeletedRows ?? 0) };
}
