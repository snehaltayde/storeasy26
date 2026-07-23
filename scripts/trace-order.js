// End-to-end order trace (Session 17):  pnpm order:trace BL-XXXXXXXX
// Merges the durable timelines — order_events (state machine), the purchase
// event pipeline row, Shopify refs — into one chronological view. The same
// order id is the grep key for Vercel's structured logs (slog lines).
import { db } from "../lib/db.js";

const orderId = process.argv[2];
if (!orderId) {
  console.error("usage: pnpm order:trace BL-XXXXXXXX");
  process.exit(1);
}

const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
if (!order) {
  console.error(`✗ ${orderId} not found`);
  process.exit(1);
}

const events = await db
  .selectFrom("order_events")
  .selectAll()
  .where("order_id", "=", orderId)
  .orderBy("id", "asc")
  .execute();
const pipeline = await db
  .selectFrom("events")
  .selectAll()
  .where("event_id", "=", orderId)
  .executeTakeFirst();

console.log(`═══ ${order.id} ═══`);
console.log(
  `  ${order.payment_method} · ₹${order.total} (goods ₹${order.total - (order.shipping_total || 0)} + ship ₹${order.shipping_total || 0}) · ${order.email}`,
);
console.log(
  `  status ${order.status} · payment ${order.payment_status} · attempts ${order.sync_attempts}${order.sync_error ? ` · last error: ${order.sync_error.slice(0, 80)}` : ""}`,
);
console.log(
  `  refs: rz_order ${order.razorpay_order_id || "—"} · rz_payment ${order.razorpay_payment_id || "—"} · shopify ${order.shopify_order_id || "—"}`,
);
console.log(`  cart ${order.cart_id || "—"} · idempotency ${order.idempotency_key || "—"}`);

console.log(`\n— state machine (${events.length} transitions) —`);
for (const e of events) {
  const meta = e.meta ? ` ${e.meta}` : "";
  console.log(`  ${e.created_at}  ${(e.from_status ?? "∅").padEnd(16)} → ${e.to_status.padEnd(16)}${meta}`);
}

console.log(`\n— purchase event pipeline —`);
if (!pipeline) {
  console.log("  (no purchase event — pre-S14 order, or consent not granted)");
} else {
  console.log(
    `  ${pipeline.status} · created ${pipeline.created_at} · ga4 ${pipeline.ga4_sent_at || "—"} · meta ${pipeline.meta_sent_at || "—"} · attempts ${pipeline.attempts}${pipeline.last_error ? ` · ${pipeline.last_error.slice(0, 60)}` : ""}`,
  );
  console.log(
    `  identity: cid ${pipeline.client_id ? "✓" : "—"} fbp ${pipeline.fbp ? "✓" : "—"} fbc ${pipeline.fbc ? "✓" : "—"} gclid ${pipeline.gclid || "—"} · consent snapshotted on order`,
  );
}

console.log(`\n— log trace —`);
console.log(`  Vercel logs: search "${order.id}" (slog lines: order_created / payment_verified / shopify_push_*)`);
process.exit(0);
