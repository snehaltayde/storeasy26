import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { freshness, discrepancies } from "@/lib/reporting";
import { tenantHandler } from "@/lib/tenant-request";

// Help & support diagnostics (S43 / MC27). Builds the EXACT diagnostics
// bundle the merchant can copy into a support message — config PRESENCE
// flags, counts and health watermarks only. NO shopper PII, no secret
// values, nothing is sent anywhere automatically: the merchant sees it
// first and sends it themselves.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();

  const counts = {};
  for (const table of ["products", "orders", "offers", "cms_pages", "media"]) {
    try {
      const r = await db.selectFrom(table).select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
      counts[table] = Number(r?.n ?? 0);
    } catch {
      counts[table] = null;
    }
  }

  const diagnostics = {
    generated_at: new Date().toISOString(),
    store: tenantId(),
    status: tenant?.status || "legacy",
    plan: tenant?.config?.billing?.plan || "none",
    billing_status: tenant?.config?.billing?.status || null,
    theme: tenant?.config?.theme ? `${tenant.config.theme.kit}@${tenant.config.theme.version}` : "default",
    maintenance: Boolean(tenant?.config?.maintenance?.enabled),
    configured: {
      shopify: Boolean(tenant?.secrets?.shopify_admin_token),
      razorpay: Boolean(tenant?.config?.razorpay_key_id),
      ga4: Boolean(tenant?.config?.ga4_measurement_id),
      meta: Boolean(tenant?.config?.meta_pixel_id),
      support_email: Boolean(tenant?.config?.site?.support_email),
      custom_domain: (tenant?.domains || []).some((d) => !/localhost|127\.0\.0\.1|\.vercel\.app$/.test(d)),
    },
    counts,
    freshness: await freshness(),
    open_issues: (await discrepancies()).map((d) => ({ kind: d.kind, order: d.order })), // ids only, no amounts/PII
  };

  return NextResponse.json({ ok: true, diagnostics });
});
