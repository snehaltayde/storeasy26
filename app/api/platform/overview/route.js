import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listTenants, getTenant } from "@/lib/platform/control";
import { forEachActiveTenant } from "@/lib/platform/ops";
import { loadMigrations } from "@/lib/platform/migrate";
import { billingOverview } from "@/lib/platform/billing";
import { salesRollup } from "@/lib/reporting";
import { getLiveRelease } from "@/lib/releases";
import { DOCUMENTS_MESSAGE } from "@/lib/cms-mode";
import { kitAttr, themePinOf } from "@/lib/themes/kits";
import { db } from "@/lib/db";
import { withTenant } from "@/lib/tenant-context";
import { probeStore, withTimeout, storesHooks } from "@/lib/platform/stores-list";

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
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const rows = await listTenants();
  const repoHead = (await loadMigrations("tenant")).at(-1)?.id || "0001_baseline";

  // OP02: revenue per ACTIVE tenant, coverage explicit
  // Phase 3 line 1: at most 5 seconds a store; a slow or unreachable one is
  // uncovered, never counted
  const revenue = await forEachActiveTenant(() =>
    withTimeout(
      (async () => {
        await probeStore();
        const r = await salesRollup({ days: 30 });
        return { orders: r.orders, net: r.net, currency: r.currency };
      })(),
      storesHooks.timeoutMs,
    ),
  );
  const reachable = revenue.filter((r) => r.ok);
  const fleetNet = reachable.reduce((s, r) => s + (r.result?.net || 0), 0);
  const fleetOrders = reachable.reduce((s, r) => s + (r.result?.orders || 0), 0);

  // OP06: migration + release state for EVERY tenant (suspended too — their
  // schema must stay current for reactivation)
  // Phase 3 line 1: every store at once, each bounded by 5 seconds and a probe
  // that fails when its database can't be reached (the reads below swallow
  // their own errors), so a slow or unreachable store is reachable: false
  const fleet = (await Promise.all(rows.map(async (row) => {
    const tenant = await getTenant(row.id).catch(() => null);
    if (!tenant) return null;
    let state = { reachable: false };
    try {
      state = await withTimeout(withTenant(tenant, async () => {
        await probeStore();
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
          // P3-DESIGN (TOK-03): the live look's pin (theme_pin), not the draft
          kit: kitAttr(themePinOf(tenant.config)),
        };
      }), storesHooks.timeoutMs);
    } catch {
      // the raw error can name the database: it never leaves the server
      state = { reachable: false, error: "Can't reach the store's database" };
    }
    return { tenant: row.id, status: row.status, ...state };
  }))).filter(Boolean);

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
      // the raw error can name the database: it never leaves the server
      uncovered: revenue.filter((r) => !r.ok).map((r) => ({ tenant: r.tenant, error: "Can't reach the store's database" })),
      note: "sum over REACHABLE active tenants only — uncovered tenants are listed, never counted as zero",
    },
    mrr: billing.mrr,
    fleet,
  });
}
