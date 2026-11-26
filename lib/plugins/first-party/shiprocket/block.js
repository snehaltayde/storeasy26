// Phase 9 line 4: the Tracking block's props for one order. Server-only. ctx
// is the storefront.order.status slot context, so ctx.id is the order the
// page has already let this shopper see (its signed link or their session);
// no other order is ever read. Reads only the store's own tables: no courier
// call happens while a shopper waits.
import { trackingForOrder } from "../../../shipments.js";
import { getOrder } from "../../../orders.js";
import { tenantCfg } from "../../../tenant-context.js";
import { DEFAULT_TIME_ZONE, dayLabel, expectedLine, localDay } from "../../../delivery-estimate.js";

export const HEADLINES = Object.freeze({
  placed: "Packed, waiting for the courier",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  returning: "Returning to the store",
  cancelled: "Shipment cancelled",
  exception: "The courier reported a delay",
});

const stepTime = (iso, timeZone) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(iso));

export async function trackingProps(ctx) {
  const id = typeof ctx?.id === "string" ? ctx.id : null;
  if (!id) return {};
  const t = await trackingForOrder(id);
  if (!t) return {};
  const timeZone = tenantCfg("timezone", null, DEFAULT_TIME_ZONE) || DEFAULT_TIME_ZONE;
  let expected = null;
  if (t.status === "delivered" && t.deliveredAt) expected = `Delivered ${dayLabel(localDay(new Date(t.deliveredAt), timeZone))}`;
  else if (["in_transit", "out_for_delivery"].includes(t.status) && t.etd) expected = `Expected by ${dayLabel(localDay(new Date(t.etd), timeZone))}`;
  else if (t.status === "placed") {
    const order = await getOrder(id);
    expected = expectedLine(order?.snapshot?.shipping?.estimate, { from: new Date(order?.created_at || Date.now()), timeZone });
  }
  return {
    status: t.status,
    headline: HEADLINES[t.status] || HEADLINES.in_transit,
    expected,
    courier: t.courier,
    awb: t.awb,
    steps: [...t.scans].reverse().map((s) => ({ at: stepTime(s.at, timeZone), hub: s.hub, activity: s.activity })),
  };
}
