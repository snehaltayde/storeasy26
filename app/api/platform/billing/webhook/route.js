import { NextResponse, after } from "next/server";
import { verifyBillingWebhookSignature } from "@/lib/platform/razorpay-billing";
import { recordWebhook } from "@/lib/platform/jobs";
import { enqueueJob } from "@/lib/platform/jobs";
import { runJobById } from "@/lib/platform/worker";
import { platformConfigured } from "@/lib/platform/control";
import { slog } from "@/lib/log";

// Platform billing webhook (S40 / BE11): Razorpay Subscriptions events from
// the PLATFORM's own account (subscription.*, refund.processed). Same
// discipline as every webhook since S29: HMAC first, PERSIST the receipt
// before the 200, apply through the jobs queue (after() fast path) — a crash
// after ack can always be replayed from the inbox.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!platformConfigured()) return NextResponse.json({ error: "platform mode required" }, { status: 503 });
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";
  const hmacOk = verifyBillingWebhookSignature(rawBody, signature);
  if (!hmacOk) {
    slog("billing_webhook_rejected", { reason: "bad signature" });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let topic = null;
  try {
    topic = JSON.parse(rawBody)?.event || null;
  } catch {
    return NextResponse.json({ error: "unparseable body" }, { status: 400 });
  }

  const inboxId = await recordWebhook({ source: "razorpay-billing", topic, rawBody, headers: { "x-razorpay-signature": "present" }, hmacOk: true });
  const job = await enqueueJob({ type: "billing_apply", payload: { inboxId }, idempotencyKey: `billing_${inboxId}` });

  after(async () => {
    const r = await runJobById(job.id).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (r) slog("billing_webhook_applied", { job: job.id, topic, ok: r.ok !== false });
  });

  return NextResponse.json({ ok: true, topic });
}
