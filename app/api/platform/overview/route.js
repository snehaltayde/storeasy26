import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { listTenants, getTenant } from "@/lib/platform/control";
import { forEachActiveTenant } from "@/lib/platform/ops";
import { loadMigrations } from "@/lib/platform/migrate";
import { billingOverview } from "@/lib/platform/billing";
import { salesRollup } from "@/lib/reporting";
import { getLiveRelease } from "@/lib/releases";
import { DOCUMENTS_MESSAGE } from "@/lib/cms-mode";
import { kitAttr } from "@/lib/themes/kits";
import { db } from "@/lib/db";
import { withTenant } from "@/lib/tenant-context";

// Platform overview + fleet state (S42 / OP02 + OP06).
//   fleet:   counts + per-tenant 30d net revenue with EXPLICIT coverage —
//            an unreachable tenant is "no data", never a silent zero.
//   releases/migrations: per tenant (suspended included), the migration
//            ledger head vs the repo head (drift flagged) and the live
//            release pointer + theme pin.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await listTenants();
  const repoHead = (await loadMigrations("tenant")).at(-1)?.id || "0001_baseline";

  // OP02: revenue per ACTIVE tenant, coverage explicit
  const revenue = await forEachActiveTenant(async () => {
    const r = await salesRollup({ days: 30 });
    return { orders: r.orders, net: r.net, currency: r.currency };
  });
  const reachable = revenue.filter((r) => r.ok);
  const fleetNet = reachable.reduce((s, r) => s + (r.result?.net || 0), 0);
  const fleetOrders = reachable.reduce((s, r) => s + (r.result?.orders || 0), 0);

  // OP06: migration + release state for EVERY tenant (suspended too — their
  // schema must stay current for reactivation)
  const fleet = [];
  for (const row of rows) {
    const tenant = await getTenant(row.id);
    if (!tenant) continue;
    let state = { reachable: false };
    try {
      state = await withTenant(tenant, async () => {
        const head = await db
          .selectFrom("schema_migrations")
          .select(({ fn }) => fn.max("id").as("head"))
          .executeTakeFirst()
          .catch(() => null);
        const live = await getLiveRelease();
        return {
          reachable: true,
          migrationHead: head?.head || null,
          behind: (head?.head || "") < repoHead,
          // P2-GUARD: a v4 live release is the documents marker, not a legacy snapshot
          release: live
            ? live.documents
              ? { id: live.id, documents: true, message: DOCUMENTS_MESSAGE, hash: String(live.content_hash || "").slice(0, 12), published_at: live.published_at }
              : { id: live.id, hash: live.content_hash.slice(0, 12), published_at: live.published_at }
            : null,
          kit: kitAttr(tenant.config?.theme || null),
        };
      });
    } catch (e) {
      state = { reachable: false, error: String(e?.message || e).slice(0, 120) };
    }
    fleet.push({ tenant: row.id, status: row.status, ...state });
  }

  const billing = await billingOverview();

  return NextResponse.json({
    ok: true,
    repoMigrationHead: repoHead,
    counts: {
      tenants: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      suspended: rows.filter((r) => r.status !== "active").length,
    },
    revenue30d: {
      net: fleetNet,
      orders: fleetOrders,
      covered_tenants: reachable.length,
      uncovered: revenue.filter((r) => !r.ok).map((r) => ({ tenant: r.tenant, error: r.error })),
      note: "sum over REACHABLE active tenants only — uncovered tenants are listed, never counted as zero",
    },
    mrr: billing.mrr,
    fleet,
  });
}
