import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listAudit } from "@/lib/platform/audit";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { platformConfigured } from "@/lib/platform/control";
import { tenantHandler } from "@/lib/tenant-request";

// Tenant audit trail, read-only (S27 / BE16). Scoped to the HOST-RESOLVED
// tenant — a console can never read another store's rows. Owner/admin only
// (action audit.read). The UI tab is MC26 (W4); until then this API + the
// platform console serve operators.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "audit.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(platformConfigured() && currentTenant())) {
    return NextResponse.json({ ok: true, entries: [], note: "audit log needs the platform control plane" });
  }
  const p = request.nextUrl.searchParams;
  const entries = await listAudit({
    tenantId: tenantId(),
    limit: p.get("limit") || 50,
    before: p.get("before"),
  });
  return NextResponse.json({ ok: true, entries });
});
