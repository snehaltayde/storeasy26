import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { appErrorAnswer } from "@/lib/plugins/installs";
import { callsView } from "@/lib/plugins/tokens";

// A custom app's API calls (Phase 4 line 4): its last 100 audit rows
// (apps.api_call), audit.read only. → { calls: [{ id, at, method, path, status, tokenId, tokenName }] }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "audit.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  try {
    return NextResponse.json({ ok: true, ...(await callsView(String(id || ""))) });
  } catch (e) {
    const f = appErrorAnswer(e, "admin/apps/[id]/calls");
    return NextResponse.json(f.body, { status: f.status });
  }
});
