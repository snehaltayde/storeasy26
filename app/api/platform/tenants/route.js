import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { audit } from "@/lib/platform/audit";
import { listTenants, getTenant } from "@/lib/platform/control.js";
import { provisionTenant } from "@/lib/platform/provision.js";
import { withTenant } from "@/lib/tenant-context.js";
import { db } from "@/lib/db";
import { slog } from "@/lib/log";

// Operator tenant API (Session 22). GET = registry + per-tenant health (each
// tenant's DB queried inside its own context; an unreachable DB marks that
// tenant, never fails the list). POST = provision a new tenant (S21 engine) —
// on Vercel this needs TURSO_API_TOKEN; locally it shells out to the authed
// turso CLI.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

async function tenantHealth(row) {
  const tenant = await getTenant(row.id);
  if (!tenant) return { reachable: false, error: "missing" };
  try {
    return await withTenant(tenant, async () => {
      const [p, o] = await Promise.all([
        db.selectFrom("products").select([(eb) => eb.fn.countAll().as("n"), (eb) => eb.fn.max("synced_at").as("last")]).executeTakeFirst(),
        db.selectFrom("orders").select((eb) => eb.fn.countAll().as("n")).where("status", "in", ["paid", "syncing_shopify", "sync_failed"]).executeTakeFirst(),
      ]);
      return {
        reachable: true,
        products: Number(p?.n || 0),
        lastSyncedAt: p?.last || null,
        ordersInFlight: Number(o?.n || 0),
        shopifyConnected: Boolean(tenant.secrets?.shopify_admin_token),
        uninstalledAt: tenant.config?.shopify_app_uninstalled_at || null,
        shopDomain: tenant.config?.shopify_store_domain || null,
        maintenance: Boolean(tenant.config?.maintenance?.enabled),
      };
    });
  } catch (e) {
    return { reachable: false, error: String(e?.message || e).slice(0, 120) };
  }
}

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const rows = await listTenants();
  const health = await Promise.all(rows.map(tenantHealth));
  return NextResponse.json({
    ok: true,
    tenants: rows.map((r, i) => ({ ...r, health: health[i] })),
  });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
    const { tenant, generated } = await provisionTenant({
      id: String(body.id || "").trim(),
      name: String(body.name || "").trim() || undefined,
      domains: Array.isArray(body.domains) ? body.domains.map((d) => String(d).trim()).filter(Boolean) : [],
      shopDomain: String(body.shopDomain || "").trim(),
      clientId: String(body.clientId || "").trim() || null,
      clientSecret: String(body.clientSecret || "").trim() || null,
      supportEmail: String(body.supportEmail || "").trim() || null,
      dbUrl: String(body.dbUrl || "").trim() || null,
      dbToken: String(body.dbToken || "").trim() || null,
    });
    slog("tenant_provisioned", { tenant: tenant.id, via: "platform-console" });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.provision", tenantId: tenant.id });
    // generated.admin_password is shown ONCE to the operator, never stored
    // anywhere readable later.
    return NextResponse.json({ ok: true, tenant: { id: tenant.id, name: tenant.name, domains: tenant.domains, dbUrl: tenant.dbUrl }, generated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 400 });
  }
}
