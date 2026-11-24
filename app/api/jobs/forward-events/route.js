import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runEventSweep, forwardEventById, eventStats } from "@/lib/events";
import { sendAlert } from "@/lib/alerts";
import { forEachActiveTenant, runAsTenant } from "@/lib/platform/ops";
import { tenantHandler } from "@/lib/tenant-request";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant } from "@/lib/tenant-context";

// Event-forwarding janitor. GET = sweep pending events (Vercel cron daily; the
// collector piggybacks a mini-sweep on every event, so this only mops up).
// Session 24: the cron sweep (and ?stats=1) LOOPS every active tenant; without
// a control plane it degrades to the single env-tenant pass.
// POST {eventId, tenant?} = re-forward one row (replays `dead` rows manually).
// Auth mirrors /api/jobs/sync-shopify: CRON_SECRET when set, open in local dev.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // S29 insurance: drain a few due jobs on the daily cadence too.
  const { runDueJobs } = await import("@/lib/platform/worker");
  await runDueJobs({ limit: 10 }).catch(() => {});
  const stats = request.nextUrl.searchParams.get("stats") === "1";
  const limit = Number(request.nextUrl.searchParams.get("limit") || 25);
  const results = await forEachActiveTenant(async () => {
    if (stats) return eventStats();
    const summary = await runEventSweep({ limit });
    if (summary.dead?.length) {
      await sendAlert(`Event forwarding dead-letter digest: ${summary.dead.length} event(s) still stuck`, {
        count: summary.dead.length,
      });
    }
    return summary;
  });
  return NextResponse.json({ ok: results.every((r) => r.ok), tenants: results });
}

// allowUnresolved + TENANT_REQUIRED guard: same fail-closed contract as the
// sync-shopify POST — operator calls on the platform host must name a tenant.
export const POST = tenantHandler(
  async (request) => {
    if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    if (!body.eventId) return NextResponse.json({ error: "eventId required" }, { status: 400 });
    if (platformConfigured() && !currentTenant() && !body.tenant) {
      return NextResponse.json({ error: "tenant required on this host", code: "TENANT_REQUIRED" }, { status: 400 });
    }
    try {
      return NextResponse.json(await runAsTenant(body.tenant || null, () => forwardEventById(body.eventId)));
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }
  },
  { allowUnresolved: true },
);
