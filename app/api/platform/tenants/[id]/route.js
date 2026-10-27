import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { patchTenant, getTenant } from "@/lib/platform/control.js";
import { audit } from "@/lib/platform/audit";
import { syncTenantCatalog } from "@/lib/sync.js";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// PATCH {status} — suspend/reactivate a tenant. S25: suspended hosts FAIL
// CLOSED (neutral "temporarily unavailable", 503 on APIs) — see resolveHost.
export async function PATCH(request, { params }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!["active", "suspended"].includes(body.status))
    return NextResponse.json({ error: 'status must be "active" or "suspended"' }, { status: 400 });
  try {
    const t = await patchTenant(id, { status: body.status });
    slog("tenant_status_changed", { tenant: id, status: body.status });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", tenantId: id, diff: { status: body.status } });
    return NextResponse.json({ ok: true, tenant: { id: t.id, status: t.status } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 404 });
  }
}

// POST — full catalog sync for this tenant (operator "sync now").
export async function POST(request, { params }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tenant.status !== "active") {
    return NextResponse.json({ ok: false, error: `tenant is ${tenant.status}` }, { status: 409 });
  }
  try {
    const r = await syncTenantCatalog(tenant);
    slog("tenant_synced", { tenant: id, products: r.products, collections: r.collections, via: "platform-console" });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.sync", tenantId: id, diff: { products: r.products, collections: r.collections } });
    return NextResponse.json({ ok: true, products: r.products, collections: r.collections, searchIndexed: r.search?.indexed ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
