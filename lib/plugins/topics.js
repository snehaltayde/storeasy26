// Phase 4 line 3: the store events a plugin can receive, and the bodies they
// carry. Pure and Edge-safe.
//
//   TOPICS              topic → { scope, words }: the permission a subscriber
//                       must hold when the delivery is sent (re-checked at send
//                       time, not at emit time)
//   SUBSCRIBABLE        what a custom app or a manifest may subscribe to
//   orderSnapshot()     the order as every subscriber sees it. Owner decision
//                       (Phase 4): no customer name, email, phone or address
//                       ever, so there is nothing to redact per scope and
//                       nothing a privacy erase has to strip
//   webhookBody()       the JSON body sent, capped at MAX_BODY_BYTES
//   bodyFor()           the body for one subscriber, or null when its scopes
//                       no longer allow the topic

export const TOPICS = Object.freeze({
  "order.created": Object.freeze({ scope: "orders.read", words: "An order is placed (paid, or cash on delivery)" }),
  "order.fulfilled": Object.freeze({ scope: "orders.read", words: "An order is fulfilled" }),
  ping: Object.freeze({ scope: null, words: "A test event you send" }),
  // Phase 9 (internal): Shiprocket emits it, WhatsApp consumes it. Not in
  // SUBSCRIBABLE, so no custom app or manifest can subscribe to it.
  "order.delivery_updated": Object.freeze({ scope: "orders.read", words: "An order's delivery status changes" }),
});
export const SUBSCRIBABLE = Object.freeze(["order.created", "order.fulfilled"]);
export const MAX_LINE_ITEMS = 100;
export const MAX_BODY_BYTES = 256 * 1024;

export const requiredScope = (topic) => TOPICS[topic]?.scope ?? null;
export const scopeHeld = (topic, scopes) => {
  const need = requiredScope(topic);
  return need === null ? Object.hasOwn(TOPICS, topic) : Array.isArray(scopes) && scopes.includes(need);
};

const num = (v) => (v == null || v === "" ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

// order: an orders row; items: its order_items rows. Only the columns named
// here leave Storeasy; contact and address columns are never read.
export function orderSnapshot(order, items = []) {
  const lines = [...items].sort((x, y) => Number(x.position ?? 0) - Number(y.position ?? 0));
  return {
    id: String(order.id),
    status: str(order.status),
    payment_method: str(order.payment_method),
    financial_status: str(order.financial_status),
    fulfillment_status: str(order.fulfillment_status),
    currency: str(order.currency),
    subtotal: num(order.subtotal),
    discount_total: num(order.discount_total),
    shipping_total: num(order.shipping_total),
    total: num(order.total),
    created_at: str(order.created_at),
    paid_at: str(order.paid_at),
    line_items: lines.slice(0, MAX_LINE_ITEMS).map((i) => ({
      product_id: str(i.product_id),
      variant_id: str(i.variant_id),
      title: str(i.title),
      variant_title: str(i.variant_title),
      quantity: num(i.quantity),
      unit_price: num(i.unit_price),
      line_total: num(i.line_total),
      line_discount: num(i.line_discount),
      is_gift: Boolean(Number(i.is_gift ?? 0)),
    })),
    line_items_truncated: lines.length > MAX_LINE_ITEMS,
  };
}

const bytes = (s) => new TextEncoder().encode(s).length;

// event: a plugin_events row (payload is its JSON data); store: the store's host.
export function webhookBody(event, store) {
  const data = typeof event.payload === "string" ? JSON.parse(event.payload) : (event.payload ?? {});
  const body = { id: String(event.id), type: String(event.topic), created_at: String(event.created_at), store: store ?? null, data };
  let text = JSON.stringify(body);
  // over the cap: drop line items from the end until it fits (flagged truncated)
  const items = data?.order?.line_items;
  while (bytes(text) > MAX_BODY_BYTES && Array.isArray(items) && items.length) {
    items.splice(Math.max(0, Math.floor(items.length * 0.75)), Math.ceil(items.length * 0.25) || 1);
    data.order.line_items_truncated = true;
    text = JSON.stringify(body);
  }
  return text;
}

export const bodyFor = (event, scopes, store) => (scopeHeld(event.topic, scopes) ? webhookBody(event, store) : null);

// Why an endpoint is paused (plugin_endpoints.paused_reason). The dashboard
// keys its attention row on the two Storeasy itself sets.
export const PAUSE_REASONS = Object.freeze({
  manual: "Paused by your team",
  gone: "The app's address answered 410 Gone, so sending stopped",
  failing: "The app's address hasn't answered for 3 days, so sending stopped",
});
export const SYSTEM_PAUSE_REASONS = Object.freeze([PAUSE_REASONS.gone, PAUSE_REASONS.failing]);
