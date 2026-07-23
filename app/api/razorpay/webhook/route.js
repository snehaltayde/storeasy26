import { NextResponse, after } from "next/server";
import { clearCart } from "@/lib/cart";
import { markOrderPaid, findOrderByRazorpayOrderId } from "@/lib/orders";
import { webhookConfigured, verifyRazorpayWebhookSignature } from "@/lib/razorpay";
import { enqueueShopifyPush, runSyncSweep } from "@/lib/shopify-push";
import { enqueuePurchaseAndForward } from "@/lib/events";
import { slog } from "@/lib/log";

// Razorpay webhook — the AUTHORITATIVE "paid" signal (Session 11). The browser
// callback is optimistic UX; a captured payment whose callback never lands
// (closed tab, dead network) is recovered here. markOrderPaid is replay-safe,
// so duplicate deliveries and callback-vs-webhook races all collapse to one
// paid transition.
//
// Response contract (Razorpay retries non-2xx with backoff, then disables a
// webhook that keeps failing):
//   400  bad signature / malformed  → not Razorpay, or wrong secret; no retry value
//   200  processed, duplicate, ignored event, or a logic error a redelivery
//        cannot fix (those are logged loudly instead)
//   5xx  transient failure (e.g. DB blip) → let Razorpay redeliver
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!webhookConfigured())
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 503 });

  // Signature is over the exact raw bytes — read text BEFORE parsing.
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature");
  if (!verifyRazorpayWebhookSignature(raw, signature))
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Same id across redeliveries of one event — recorded in the audit trail.
  const eventId = request.headers.get("x-razorpay-event-id") || null;

  if (body.event !== "payment.captured")
    return NextResponse.json({ ok: true, ignored: body.event || "unknown_event" });

  const payment = body?.payload?.payment?.entity || {};
  const { id: paymentId, order_id: razorpayOrderId, amount } = payment;
  if (!paymentId || !razorpayOrderId)
    return NextResponse.json({ error: "Malformed payment payload" }, { status: 400 });

  const order = await findOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) {
    // Not ours (other system on the same account) or long-gone — retrying won't help.
    console.warn(`[rz-webhook] no order for ${razorpayOrderId} (payment ${paymentId})`);
    return NextResponse.json({ ok: true, ignored: "unknown_order" });
  }

  // Defense in depth: the captured amount must match OUR order to the paisa.
  if (Number(amount) !== Math.round(order.total * 100)) {
    console.error(
      `[rz-webhook] AMOUNT MISMATCH ${order.id}: captured ${amount}, expected ${Math.round(order.total * 100)} (payment ${paymentId})`,
    );
    return NextResponse.json({ ok: true, flagged: "amount_mismatch", orderId: order.id });
  }

  try {
    const paid = await markOrderPaid(order.id, {
      razorpayPaymentId: paymentId,
      source: "webhook",
      webhookEventId: eventId,
    });
    slog("payment_verified", {
      order_id: order.id,
      source: "webhook",
      already: !!paid.already,
      razorpay_payment_id: paymentId,
      webhook_event_id: eventId,
    });
    // Kill the lost-callback leftovers: the user's cart still holds the items.
    if (!paid.already && order.cart_id) await clearCart(order.cart_id);
    // Async Shopify push AFTER the response: immediate attempt for this order,
    // then a tiny sweep so failed pushes retry on payment traffic instead of
    // waiting for the daily cron.
    after(async () => {
      if (!paid.already) {
        await enqueueShopifyPush(order.id);
        // durable server-side purchase event — the browser may never come back
        await enqueuePurchaseAndForward(order.id);
      }
      await runSyncSweep({ limit: 2 }).catch((e) =>
        console.error(`[sync-sweep] ${e?.message || e}`),
      );
    });
    return NextResponse.json({
      ok: true,
      orderId: order.id,
      ...(paid.already ? { already: true } : {}),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    // A redelivery can't fix these (wrong payment on a paid order, captured
    // payment for a cancelled order) — surface loudly, answer 200.
    if (/invalid order transition|different payment/i.test(msg)) {
      console.error(`[rz-webhook] NEEDS ATTENTION ${order.id}: ${msg}`);
      return NextResponse.json({ ok: true, flagged: msg, orderId: order.id });
    }
    // Transient (Turso blip after retries, etc.) → 5xx → Razorpay redelivers.
    console.error(`[rz-webhook] transient failure ${order.id}: ${msg}`);
    return NextResponse.json({ error: "Temporary failure, please redeliver" }, { status: 500 });
  }
}
