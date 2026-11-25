import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listTenants, getTenant } from "@/lib/platform/control.js";
import { withTenant } from "@/lib/tenant-context.js";
import { db } from "@/lib/db";

// Operator tenant API (Session 22). GET = registry + per-tenant health (each
// tenant's DB queried inside its own context; an unreachable DB marks that
// tenant, never fails the list). Phase 1 line 9 retired POST (provision a new
// tenant): operators create stores through /api/platform/stores; the CLI
// (scripts/provision-tenant.js) keeps provisionTenant for adopting a database.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const rows = await listTenants();
  const health = await Promise.all(rows.map(tenantHealth));
  return NextResponse.json({
    ok: true,
    tenants: rows.map((r, i) => ({ ...r, health: health[i] })),
  });
}
