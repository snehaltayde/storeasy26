import { NextResponse } from "next/server";
import { runSyncSweep, pushOrderToShopify } from "@/lib/shopify-push";
import { sendAlert } from "@/lib/alerts";

// Shopify sync janitor. GET = sweep (Vercel cron hits this daily; the webhook
// also piggybacks a small sweep on every payment, so retries don't wait a day).
// POST {orderId} = push one order now (ops tool).
//
// Auth: when CRON_SECRET is set, require it — Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>` automatically; manual callers may use
// ?secret=. Without CRON_SECRET set (local dev), the endpoint is open.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}` || request.nextUrl.searchParams.get("secret") === secret;
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = Number(request.nextUrl.searchParams.get("limit") || 10);
  try {
    const summary = await runSyncSweep({ limit });
    // Money-path dead-letter DIGEST: the one-time alert fired at death; the
    // daily cron re-alerts while ANY paid-but-unsynced order remains stuck.
    if (summary.dead?.length) {
      await sendAlert(`Shopify sync dead-letter digest: ${summary.dead.length} order(s) still stuck`, {
        orders: summary.dead,
      });
    }
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.orderId) return NextResponse.json({ error: "orderId required" }, { status: 400 });
  try {
    const result = await pushOrderToShopify(body.orderId);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
