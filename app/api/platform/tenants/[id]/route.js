import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { patchTenant, getTenant } from "@/lib/platform/control.js";
import { syncTenantCatalog } from "@/lib/sync.js";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// PATCH {status} — suspend/reactivate a tenant (suspended hosts fall back to
// the default store rather than 500ing; see getTenantByHost).
export async function PATCH(request, { params }) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!["active", "suspended"].includes(body.status))
    return NextResponse.json({ error: 'status must be "active" or "suspended"' }, { status: 400 });
  try {
    const t = await patchTenant(id, { status: body.status });
    slog("tenant_status_changed", { tenant: id, status: body.status });
    return NextResponse.json({ ok: true, tenant: { id: t.id, status: t.status } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 404 });
  }
}

// POST — full catalog sync for this tenant (operator "sync now").
export async function POST(request, { params }) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const r = await syncTenantCatalog(tenant);
    slog("tenant_synced", { tenant: id, products: r.products, collections: r.collections, via: "platform-console" });
    return NextResponse.json({ ok: true, products: r.products, collections: r.collections, searchIndexed: r.search?.indexed ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
