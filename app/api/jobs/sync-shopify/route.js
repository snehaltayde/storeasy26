import { NextResponse } from "next/server";
import { runSyncSweep, pushOrderToShopify } from "@/lib/shopify-push";
import { sendAlert } from "@/lib/alerts";
import { forEachActiveTenant, runAsTenant } from "@/lib/platform/ops";
import { tenantHandler } from "@/lib/tenant-request";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant } from "@/lib/tenant-context";

// Shopify sync janitor. GET = sweep (Vercel cron daily; the webhook also
// piggybacks a small sweep on every payment, so retries don't wait a day).
// Session 24: the cron sweep LOOPS every active tenant — one tenant's failure
// never blocks another's retries; without a control plane it degrades to the
// single env-tenant sweep (pre-platform behavior).
// POST {orderId, tenant?} = push one order now (ops tool; tenant overrides
// the Host-resolved context for operator use).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}` || request.nextUrl.searchParams.get("secret") === secret;
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // S29 insurance: drain a few due jobs even when no external tick scheduler
  // is configured (daily cadence, but better than never).
  const { runDueJobs } = await import("@/lib/platform/worker");
  await runDueJobs({ limit: 10 }).catch(() => {});
  const limit = Number(request.nextUrl.searchParams.get("limit") || 10);
  const results = await forEachActiveTenant(async () => {
    const summary = await runSyncSweep({ limit });
    // Money-path dead-letter DIGEST: the one-time alert fired at death; the
    // daily cron re-alerts while ANY paid-but-unsynced order remains stuck.
    // sendAlert tags the active tenant automatically.
    if (summary.dead?.length) {
      await sendAlert(`Shopify sync dead-letter digest: ${summary.dead.length} order(s) still stuck`, {
        orders: summary.dead,
      });
    }
    return summary;
  });
  return NextResponse.json({ ok: results.every((r) => r.ok), tenants: results });
}

// allowUnresolved: operators call this on the deployment/platform host with an
// explicit body.tenant. S25 fail-closed: in platform mode a request that
// resolves no tenant AND names none is rejected — no silent env-default push.
export const POST = tenantHandler(
  async (request) => {
    if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    if (!body.orderId) return NextResponse.json({ error: "orderId required" }, { status: 400 });
    if (platformConfigured() && !currentTenant() && !body.tenant) {
      return NextResponse.json({ error: "tenant required on this host", code: "TENANT_REQUIRED" }, { status: 400 });
    }
    try {
      const result = await runAsTenant(body.tenant || null, () => pushOrderToShopify(body.orderId));
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }
  },
  { allowUnresolved: true },
);
