import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { patchTenant, getTenant, platformDb } from "@/lib/platform/control.js";
import { audit } from "@/lib/platform/audit";
import { syncTenantCatalog } from "@/lib/sync.js";
import { withTenant } from "@/lib/tenant-context.js";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// GET — tenant DETAIL (S41 / OP03): lifecycle, config summary, secrets as a
// PRESENCE MAP (which keys exist — values never leave the envelope), billing
// snapshot, onboarding progress, provisioning history.
export async function GET(request, { params }) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const secretsPresent = Object.fromEntries(Object.keys(tenant.secrets || {}).map((k) => [k, true]));
  const runs = (
    await platformDb().execute({ sql: "SELECT id, status, steps, error, created_at FROM provision_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10", args: [id] })
  ).rows.map((r) => {
    let steps = [];
    try {
      steps = JSON.parse(r.steps || "[]").map((s) => ({ name: s.name, status: s.status }));
    } catch { /* malformed */ }
    return { id: r.id, status: r.status, steps, error: r.error, created_at: r.created_at };
  });
  let onboarding = null;
  try {
    const { buildChecklist } = await import("@/lib/admin/onboarding.js");
    onboarding = await withTenant(tenant, buildChecklist);
  } catch { /* tenant db unreachable */ }

  return NextResponse.json({
    ok: true,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      domains: tenant.domains || [],
      config: {
        shop_domain: tenant.config?.shopify_store_domain || null,
        site_name: tenant.config?.site?.name || null,
        support_email: tenant.config?.site?.support_email || null,
        checkout_mode: tenant.config?.checkout_mode || "direct",
        theme: tenant.config?.theme || null,
        billing: tenant.config?.billing || null,
        onboarding_manual: tenant.config?.onboarding?.manual || {},
      },
      secretsPresent,
    },
    onboarding: onboarding && onboarding.supported ? { doneCount: onboarding.doneCount, total: onboarding.total, launched: onboarding.launched, items: onboarding.items.map((i) => ({ id: i.id, done: i.done })) } : null,
    runs,
  });
}

// PATCH {status} — suspend/reactivate a tenant (S25: suspended hosts FAIL
// CLOSED). PATCH {maintenance: {enabled, message?}} — S43 (OP12): branded
// maintenance page for shoppers, console stays reachable, checkout closes.
export async function PATCH(request, { params }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.maintenance !== undefined) {
      const m = body.maintenance;
      const maintenance = m?.enabled
        ? { enabled: true, message: String(m.message || "").slice(0, 300), since: new Date().toISOString() }
        : null;
      const t = await patchTenant(id, { config: { maintenance } });
      slog("tenant_maintenance", { tenant: id, enabled: !!maintenance });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", tenantId: id, diff: { maintenance: !!maintenance } });
      return NextResponse.json({ ok: true, tenant: { id: t.id, maintenance: t.config?.maintenance || null } });
    }
    if (!["active", "suspended"].includes(body.status))
      return NextResponse.json({ error: 'status must be "active" or "suspended" (or pass maintenance)' }, { status: 400 });
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
