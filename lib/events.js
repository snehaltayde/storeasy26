import { db } from "./db.js";
import { sendAlert } from "./alerts.js";
import {
  FUNNEL_EVENTS,
  ga4Configured,
  metaConfigured,
  buildGa4Payload,
  buildMetaPayload,
  sendGa4,
  sendMeta,
  hashEmail,
  hashPhone,
  newClientId,
  META_TEST_EVENT_CODE,
} from "./tracking.js";

// ---------------------------------------------------------------------------
// First-party event pipeline (Session 14) — store-then-forward.
//
//   collect → PERSIST (events table, event_id UNIQUE = dedup) → 202
//                └─ after(): forward to GA4 MP + Meta CAPI, exactly-once per
//                   destination (per-destination sent_at); failures retry via
//                   the sweep with bounded backoff; after MAX attempts the row
//                   goes `dead` (payload intact — replayable forever) and the
//                   sweep alerts once per batch of new deaths.
//
// A destination that isn't configured (no creds in env) is NOT an error: the
// event still stores; it counts as forwarded in store-only mode. Purchase rows
// merge their two copies (server-enqueued + browser beacon) into ONE event and
// inherit the buyer's first-party identity through cart_id.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = () => Number(process.env.EVENTS_MAX_ATTEMPTS || 8);
const BACKOFF_BASE_MS = () => Number(process.env.EVENTS_BACKOFF_MS || 60_000);

const now = () => new Date().toISOString();

export function isFunnelEvent(name) {
  return FUNNEL_EVENTS.includes(name);
}

// Persist one event. Idempotent on event_id: a duplicate returns
// { stored: false, deduped: true } — and (purchase identity merge) fills any
// identifier columns the FIRST copy was missing, so server + browser copies
// combine into the richest single record.
export async function storeEvent({
  eventId,
  name,
  clientId = null,
  fbp = null,
  fbc = null,
  gclid = null,
  ip = null,
  userAgent = null,
  url = null,
  referrer = null,
  cartId = null,
  orderId = null,
  payload = {},
}) {
  if (!eventId) throw new Error("eventId is required");
  if (!isFunnelEvent(name)) throw new Error(`Unknown funnel event "${name}"`);

  const res = await db
    .insertInto("events")
    .values({
      event_id: eventId,
      name,
      client_id: clientId,
      fbp,
      fbc,
      gclid,
      ip,
      user_agent: userAgent,
      url,
      referrer,
      cart_id: cartId,
      order_id: orderId,
      payload: JSON.stringify(payload),
      status: "pending",
      attempts: 0,
      created_at: now(),
    })
    .onConflict((oc) => oc.column("event_id").doNothing())
    .executeTakeFirst();

  if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) return { stored: true, eventId };

  // Duplicate copy → merge missing identity into the existing row.
  const existing = await db
    .selectFrom("events")
    .select(["id", "client_id", "fbp", "fbc", "gclid", "ip", "user_agent", "cart_id", "payload", "status"])
    .where("event_id", "=", eventId)
    .executeTakeFirst();
  if (existing) {
    const set = {};
    if (!existing.client_id && clientId) set.client_id = clientId;
    if (!existing.fbp && fbp) set.fbp = fbp;
    if (!existing.fbc && fbc) set.fbc = fbc;
    if (!existing.gclid && gclid) set.gclid = gclid;
    if (!existing.ip && ip) set.ip = ip;
    if (!existing.user_agent && userAgent) set.user_agent = userAgent;
    if (!existing.cart_id && cartId) set.cart_id = cartId;
    try {
      const prev = JSON.parse(existing.payload || "{}");
      if (!prev.user_data && payload.user_data) {
        set.payload = JSON.stringify({ ...prev, user_data: payload.user_data });
      }
    } catch {
      /* keep existing payload */
    }
    if (Object.keys(set).length) {
      await db.updateTable("events").set(set).where("id", "=", existing.id).execute();
    }
  }
  return { stored: false, deduped: true, eventId };
}

const rowToEvent = (row) => {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    payload = {};
  }
  return {
    name: row.name,
    event_id: row.event_id,
    value: payload.value,
    currency: payload.currency,
    items: payload.items,
    params: payload.params,
    user_data: payload.user_data || {},
  };
};

// Forward one stored row to every CONFIGURED destination that hasn't been sent
// yet. Never throws; updates the row (sent_ats / attempts / status). Senders
// are injectable so tests can simulate outages without touching GA4/Meta.
export async function forwardEvent(row, { ga4Send = sendGa4, metaSend = sendMeta } = {}) {
  if (row.status === "forwarded") return { ok: true, eventId: row.event_id, already: true };
  const event = rowToEvent(row);

  const need = {
    ga4: ga4Configured() && !row.ga4_sent_at,
    meta: metaConfigured() && !row.meta_sent_at,
  };
  const set = { last_attempt_at: now() };
  const errors = [];

  if (need.ga4) {
    try {
      const payload = buildGa4Payload({
        clientId: row.client_id || newClientId(),
        event,
      });
      const r = await ga4Send({ payload });
      if (r?.status && r.status >= 400) throw new Error(`GA4 HTTP ${r.status}`);
      set.ga4_sent_at = now();
    } catch (e) {
      errors.push(`ga4: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  if (need.meta) {
    try {
      const payload = buildMetaPayload({
        event,
        userData: {
          emailHash: event.user_data.em || null,
          phoneHash: event.user_data.ph || null,
          fbp: row.fbp || null,
          fbc: row.fbc || null,
          ip: row.ip || null,
          userAgent: row.user_agent || null,
        },
        eventSourceUrl: row.url || undefined,
        testCode: META_TEST_EVENT_CODE() || undefined,
      });
      const r = await metaSend({ payload });
      if (r?.status && r.status >= 400)
        throw new Error(`Meta HTTP ${r.status}: ${JSON.stringify(r.response || {}).slice(0, 150)}`);
      set.meta_sent_at = now();
    } catch (e) {
      errors.push(`meta: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  const ga4Done = !ga4Configured() || row.ga4_sent_at || set.ga4_sent_at;
  const metaDone = !metaConfigured() || row.meta_sent_at || set.meta_sent_at;

  if (errors.length) {
    const attempts = (row.attempts || 0) + 1;
    set.attempts = attempts;
    set.last_error = errors.join(" | ");
    if (attempts >= MAX_ATTEMPTS()) set.status = "dead"; // payload intact — replayable
  } else if (ga4Done && metaDone) {
    set.status = "forwarded";
    set.forwarded_at = now();
    set.last_error = null;
    if (!ga4Configured() && !metaConfigured()) set.last_error = "store-only: no destinations configured";
  }

  await db.updateTable("events").set(set).where("id", "=", row.id).execute();
  return {
    ok: errors.length === 0,
    eventId: row.event_id,
    ...(set.status === "forwarded" ? { forwarded: true } : {}),
    ...(set.status === "dead" ? { dead: true } : {}),
    ...(errors.length ? { errors, attempts: set.attempts } : {}),
  };
}

export async function forwardEventById(eventId, senders) {
  const row = await db.selectFrom("events").selectAll().where("event_id", "=", eventId).executeTakeFirst();
  if (!row) throw new Error(`Event ${eventId} not found`);
  return forwardEvent(row, senders);
}

const dueAt = (row) =>
  row.attempts === 0
    ? 0
    : new Date(row.last_attempt_at || row.created_at).getTime() +
      BACKOFF_BASE_MS() * 2 ** Math.max(0, row.attempts - 1);

// Replay the queue: pending rows whose backoff has elapsed, oldest first.
// Dead rows are reported every sweep (visible, never lost); newly-dead rows
// trigger ONE aggregated alert per sweep.
export async function runEventSweep({ limit = 25, ga4Send, metaSend } = {}) {
  const nowMs = Date.now();
  const rows = await db
    .selectFrom("events")
    .selectAll()
    .where("status", "=", "pending")
    .orderBy("id", "asc")
    .limit(500)
    .execute();
  const deadRows = await db
    .selectFrom("events")
    .select(["event_id", "name", "attempts"])
    .where("status", "=", "dead")
    .execute();

  const summary = { pending: rows.length, forwarded: 0, failed: 0, deferred: 0, newlyDead: [], dead: deadRows };
  for (const row of rows) {
    if (summary.forwarded + summary.failed >= limit) break;
    if (nowMs < dueAt(row)) {
      summary.deferred++;
      continue;
    }
    const r = await forwardEvent(row, { ga4Send, metaSend });
    if (r.ok) summary.forwarded++;
    else {
      summary.failed++;
      if (r.dead) summary.newlyDead.push({ eventId: row.event_id, name: row.name, attempts: r.attempts });
    }
  }
  if (summary.newlyDead.length) {
    await sendAlert(`Event forwarding DEAD-LETTER: ${summary.newlyDead.length} event(s) exhausted retries`, {
      events: summary.newlyDead,
    });
  }
  return summary;
}

// Fire-and-forget for next/server after(): store-side is already durable, so
// a forwarding hiccup here just leaves the row for the sweep.
export function enqueueForward(eventId) {
  return forwardEventById(eventId).catch((e) =>
    console.error(`[events] forward ${eventId}: ${e?.message || e}`),
  );
}

// Server-side purchase — fired when an order is paid (or COD-placed), so the
// conversion never depends on the buyer's browser reaching the confirmation
// page. event_id = order id: the browser copy beacons the same id and both
// collapse into this row. First-party identity (client_id/fbp/fbc/gclid) is
// inherited from the buyer's latest stored event on the same cart.
export async function enqueuePurchaseEvent(orderId) {
  const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
  if (!order) throw new Error(`Order ${orderId} not found`);

  let snap = {};
  try {
    snap = JSON.parse(order.snapshot || "{}");
  } catch {
    snap = {};
  }
  const identity = order.cart_id
    ? await db
        .selectFrom("events")
        .select(["client_id", "fbp", "fbc", "gclid", "ip", "user_agent", "url"])
        .where("cart_id", "=", order.cart_id)
        .where("client_id", "is not", null)
        .orderBy("id", "desc")
        .executeTakeFirst()
    : null;

  const numeric = (gid) => String(gid || "").split("/").pop();
  const items = [
    ...(snap.items || []).map((it) => ({
      id: numeric(it.variantId),
      name: it.title,
      price: it.price,
      quantity: it.quantity,
    })),
    ...(snap.gifts || []).map((g) => ({ id: numeric(g.variantId), name: g.title, price: 0, quantity: 1 })),
  ];

  const stored = await storeEvent({
    eventId: order.id, // = GA4 transaction_id = Meta event_id
    name: "purchase",
    clientId: identity?.client_id || null,
    fbp: identity?.fbp || null,
    fbc: identity?.fbc || null,
    gclid: identity?.gclid || null,
    ip: identity?.ip || null,
    userAgent: identity?.user_agent || null,
    url: identity?.url || null,
    cartId: order.cart_id,
    orderId: order.id,
    payload: {
      value: order.total,
      currency: order.currency || "INR",
      items,
      params: {
        coupon: order.coupon_code || undefined,
        shipping: order.shipping_total || 0,
        payment_type: order.payment_method,
      },
      user_data: {
        em: hashEmail(order.email),
        ph: hashPhone(order.phone),
      },
    },
  });
  return { ...stored, orderId: order.id };
}

// after()-safe wrapper: store + immediate forward + tiny sweep.
export function enqueuePurchaseAndForward(orderId) {
  return enqueuePurchaseEvent(orderId)
    .then(() => forwardEventById(orderId))
    .then(() => runEventSweep({ limit: 3 }))
    .catch((e) => console.error(`[events] purchase ${orderId}: ${e?.message || e}`));
}
