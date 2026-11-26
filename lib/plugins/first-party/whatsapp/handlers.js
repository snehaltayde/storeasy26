// Phase 9 line 3: WhatsApp's order-event handlers (lib/plugins/handlers.js
// BUILT_IN). SERVER-ONLY, run by the plugin_delivery job inside withTenant.
// The event body carries no contact details (topics.js orderSnapshot), so the
// handler reads the order's phone, cart and customer from the store's own
// database. A message goes only when a live "updates" consent covers the
// order's phone and is bound to the order's cart or customer (sendGated
// re-checks it at send time). One message per order and status:
// wa:<kind>:<orderId>, so a replayed event sends nothing new.
import { db } from "../../../db.js";
import { e164 } from "../../../checkout/phone.js";
import { formatMoney } from "../../../format.js";
import { siteName } from "../../../site.js";
import { orderStatusPath } from "../../../orders.js";
import { sendGated, storeUrl } from "../../../messaging/whatsapp.js";

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};
const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0]?.slice(0, 40) || "there";

// the order's phone in its one E.164 form (the shipping country's rules)
export function orderPhone(order) {
  const snap = parse(order.snapshot);
  const cc = String(snap?.address?.country_code ?? "IN").toUpperCase();
  return e164(order.phone, /^[A-Z]{2}$/.test(cc) ? cc : "IN") || "";
}

async function orderMessage(ctx, kind, { link } = {}) {
  const orderId = String(ctx.event?.data?.order?.id ?? "");
  if (!orderId) return { skipped: "no_order" };
  const order = await db.selectFrom("orders").select(["id", "phone", "name", "cart_id", "customer_id", "total", "currency", "snapshot", "redacted_at"]).where("id", "=", orderId).executeTakeFirst();
  if (!order || order.redacted_at) {
    ctx.log?.("skipped", { reason: "no_order" });
    return { skipped: "no_order" };
  }
  return sendGated({
    kind,
    purpose: "updates",
    phone: orderPhone(order),
    cartId: order.cart_id ?? null,
    customerId: order.customer_id ?? null,
    key: `wa:${kind}:${order.id}`,
    vars: { store: siteName(), order: order.id, total: formatMoney(order.total, order.currency || "INR"), first_name: firstName(order.name), link: link ?? storeUrl(await orderStatusPath(order.id)) },
    install: ctx.install,
    secrets: ctx.secrets,
    fetch: ctx.fetch,
  });
}

// a skip is a handled delivery; only a provider failure is a failed attempt
const done = (r) => (r?.skipped === "provider_failed" ? { ok: false, status: r.status ?? null, error: "provider_failed" } : undefined);

export const onOrderCreated = async (ctx) => done(await orderMessage(ctx, "order_confirmed"));

export async function onOrderFulfilled(ctx) {
  const orderId = String(ctx.event?.data?.order?.id ?? "");
  const f = orderId ? await db.selectFrom("order_fulfillments").select(["tracking_url"]).where("order_id", "=", orderId).where("tracking_url", "is not", null).executeTakeFirst().catch(() => null) : null;
  const link = /^https:\/\//.test(String(f?.tracking_url ?? "")) ? String(f.tracking_url) : undefined;
  return done(await orderMessage(ctx, "order_shipped", { link }));
}

// order.delivery_updated (internal, from the Shiprocket line): delivered only
export async function onDeliveryUpdated(ctx) {
  const d = ctx.event?.data ?? {};
  const status = String(d.delivery?.status ?? d.status ?? "").toLowerCase();
  if (status !== "delivered") return undefined;
  return done(await orderMessage(ctx, "order_delivered"));
}

export const HANDLERS = Object.freeze({
  "order.created": onOrderCreated,
  "order.fulfilled": onOrderFulfilled,
  "order.delivery_updated": onDeliveryUpdated,
});
