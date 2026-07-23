import { NextResponse } from "next/server";
import { runEventSweep, forwardEventById, eventStats } from "@/lib/events";

// Event-forwarding janitor. GET = sweep pending events (Vercel cron daily; the
// collector piggybacks a mini-sweep on every event, so this only mops up).
// POST {eventId} = re-forward one row (also replays `dead` rows manually).
// Auth mirrors /api/jobs/sync-shopify: CRON_SECRET when set, open in local dev.
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
  try {
    // ?stats=1 → forward-success monitoring instead of a sweep
    if (request.nextUrl.searchParams.get("stats") === "1") {
      return NextResponse.json({ ok: true, ...(await eventStats()) });
    }
    const limit = Number(request.nextUrl.searchParams.get("limit") || 25);
    const summary = await runEventSweep({ limit });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.eventId) return NextResponse.json({ error: "eventId required" }, { status: 400 });
  try {
    return NextResponse.json(await forwardEventById(body.eventId));
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
