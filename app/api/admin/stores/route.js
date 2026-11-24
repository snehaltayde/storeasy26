import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";
import { listMyStores } from "@/lib/admin/stores";

// Store switcher (S41 / MC03): the stores this signed-in USER belongs to
// (lib/admin/stores.js listMyStores, shared with the console shell since
// Phase 0 line 8). Bootstrap and operator-support sessions get [].
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const stores = await listMyStores(auth.actor);
  return NextResponse.json({ ok: true, stores, current: currentTenant()?.id || null });
});
