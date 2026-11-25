import { NextResponse, after } from "next/server";
import { markOrderPaid, findOrderByRazorpayOrderId } from "@/lib/orders";
import { clearPaidCart, runOrderEffects } from "@/lib/payment-settle";
import { webhookConfigured, verifyRazorpayWebhookSignature } from "@/lib/razorpay";
import { runSyncSweep } from "@/lib/shopify-push";
import { recordWebhook, markInbox, enqueueJob } from "@/lib/platform/jobs.js";
import { platformConfigured } from "@/lib/platform/control.js";
import { currentTenant } from "@/lib/tenant-context";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

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
//   S29 (BE14): in platform mode the verified delivery is PERSISTED as a
//   webhook_inbox receipt before processing; a transient failure now answers
//   200 {queued:true} with a durable retry job of our own (no dependence on
//   provider redelivery; a crash after the ack loses nothing). "Needs
//   attention" cases dead-letter the receipt, visible in the OP05 inspector.
//   Legacy mode (no control plane) keeps the original 5xx→redeliver contract.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
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

  // Durable receipt BEFORE processing (platform mode). If even the receipt
  // can't be written, fall through — the legacy 5xx path still protects us.
  let inboxId = null;
  if (platformConfigured()) {
    inboxId = await recordWebhook({
      source: "razorpay",
      topic: body.event,
      tenantId: currentTenant()?.id ?? null,
      rawBody: raw,
      headers: { event_id: eventId },
      hmacOk: true,
    }).catch(() => null);
  }

  const order = await findOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) {
    // Not ours (other system on the same account) or long-gone — retrying won't help.
    console.warn(`[rz-webhook] no order for ${razorpayOrderId} (payment ${paymentId})`);
    if (inboxId) await markInbox(inboxId, "ignored", { error: "unknown_order" }).catch(() => {});
    return NextResponse.json({ ok: true, ignored: "unknown_order" });
  }

  // Defense in depth: the captured amount must match OUR order to the paisa.
  const { toMinor } = await import("@/lib/money");
  // Phase 8 line 4: in the order's own currency (a market order was minted in
  // it), so the minor units are that currency's; a capture in any other
  // currency is a mismatch too.
  const expectedMinor = toMinor(order.total, order.currency || "INR");
  const currencyOk = !payment.currency || String(payment.currency).toUpperCase() === String(order.currency || "INR").toUpperCase();
  if (Number(amount) !== expectedMinor || !currencyOk) {
    console.error(
      `[rz-webhook] AMOUNT MISMATCH ${order.id}: captured ${amount} ${payment.currency || ""}, expected ${expectedMinor} ${order.currency || "INR"} (payment ${paymentId})`,
    );
    if (inboxId) await markInbox(inboxId, "dead", { error: "amount_mismatch" }).catch(() => {});
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
    // The payment is recorded, so a failure here isn't worth a redelivery.
    await clearPaidCart(order.id).catch((e) => console.error(`[rz-webhook] cart ${order.id}: ${e?.message || e}`));
    // Async Shopify push AFTER the response: immediate attempt for this order,
    // then a tiny sweep so failed pushes retry on payment traffic instead of
    // waiting for the daily cron. The effects run on a replay too: "already paid"
    // doesn't prove whoever paid it got as far as running them.
    after(async () => {
      await runOrderEffects(order.id);
      await runSyncSweep({ limit: 2 }).catch((e) =>
        console.error(`[sync-sweep] ${e?.message || e}`),
      );
    });
    if (inboxId) await markInbox(inboxId, "done").catch(() => {});
    return NextResponse.json({
      ok: true,
      orderId: order.id,
      ...(paid.already ? { already: true } : {}),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    // A redelivery can't fix these (wrong payment on a paid order, captured
    // payment for a cancelled order) — surface loudly, answer 200. The dead
    // receipt keeps it visible (and replayable) in the OP05 inspector.
    if (/invalid order transition|different payment/i.test(msg)) {
      console.error(`[rz-webhook] NEEDS ATTENTION ${order.id}: ${msg}`);
      if (inboxId) await markInbox(inboxId, "dead", { error: msg.slice(0, 300) }).catch(() => {});
      return NextResponse.json({ ok: true, flagged: msg, orderId: order.id });
    }
    console.error(`[rz-webhook] transient failure ${order.id}: ${msg}`);
    // Platform mode: OUR durable retry owns recovery → ack with queued:true.
    if (inboxId) {
      const queued = await enqueueJob({
        type: "webhook_apply",
        tenantId: currentTenant()?.id ?? null,
        payload: { inboxId },
        idempotencyKey: `wh:${inboxId}`,
      }).catch(() => null);
      if (queued) return NextResponse.json({ ok: true, queued: true, orderId: order.id });
    }
    // Legacy mode (or the queue itself failed): 5xx → Razorpay redelivers.
    return NextResponse.json({ error: "Temporary failure, please redeliver" }, { status: 500 });
  }
});
