// Phase 9 line 1: Reviews' event handler. order.fulfilled makes one invite per
// distinct product on the order (lib/reviews/store.js createInvites; a replay
// adds nothing). The products are read from the order's own lines, not the
// event body, so a long order (whose body drops lines past 100) still gets
// every invite. Invites are made whether or not emails are on: the order page's
// Review links use them too.
import { db } from "../../../db.js";
import { createInvites } from "../../../reviews/store.js";

export async function onOrderFulfilled({ event, install, log }) {
  const orderId = event?.data?.order?.id;
  if (!orderId) return;
  const lines = await db.selectFrom("order_items").select(["product_id"]).where("order_id", "=", String(orderId)).execute();
  const made = await createInvites({
    orderId: String(orderId),
    productIds: lines.map((l) => l.product_id),
    fulfilledAt: event?.created_at,
    sendAfterDays: install?.settings?.send_after_days ?? 7,
  });
  log("invites", { order: String(orderId), made });
}

export default { "order.fulfilled": onOrderFulfilled };
