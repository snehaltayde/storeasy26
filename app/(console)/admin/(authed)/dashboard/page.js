import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { salesRollup, freshness, coverage } from "@/lib/reporting";
import { salesView, actionQueue, storeStatus, RANGES } from "@/lib/admin/dashboard";
import { catalogSyncStatus } from "@/lib/sync";
import { roleAllows } from "@/lib/platform/authz";
import { gateAction } from "@/lib/onboarding/open-step";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/kit/page-header";
import { RangeSwitch } from "@/components/admin/dashboard/RangeSwitch";
import { SalesSummary } from "@/components/admin/dashboard/SalesSummary";
import { SalesChart } from "@/components/admin/dashboard/SalesChart";
import { ActionQueue } from "@/components/admin/dashboard/ActionQueue";
import { StoreStatus, StoreBanner } from "@/components/admin/dashboard/StoreStatus";
import { SyncCard } from "@/components/admin/dashboard/SyncCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · Admin", robots: { index: false } };

// The merchant dashboard on the new UI (Phase 2 line 1, docs/plans/phase-2.md).
// Sales come from lib/reporting.js (the orders ledger, refunds netted out,
// days in the store's timezone); the action queue and the store status from
// lib/admin/dashboard.js. Each read is caught on its own: a part that fails
// says it couldn't check, the rest of the page still shows. Everything here
// is a read; the one write, "Run again" on the first import, is gated on
// sync.run (ImportStepBody's gate).
const ago = (iso, nowMs) => {
  if (!iso) return null;
  const mins = Math.round((nowMs - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
};
const quiet = (p) => p.then((v) => v, () => null);

export default async function AdminDashboardPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "storefront.read")) redirect("/admin/login");
  const role = actor.role;
  const canOrders = roleAllows(role, "orders.read");

  const sp = await searchParams;
  const days = RANGES.includes(Number(sp?.days)) ? Number(sp.days) : 30;
  const nowMs = Date.now();

  const [rollup, fresh, cov, queue, status, sync] = await tfetch(() =>
    Promise.all([
      canOrders ? quiet(salesRollup({ days })) : null,
      quiet(freshness()),
      canOrders ? quiet(coverage({ days })) : null,
      actionQueue({ role, nowMs }),
      storeStatus({ role }),
      quiet(catalogSyncStatus()),
    ]),
  );
  const sales = rollup ? salesView(rollup, { days, nowMs }) : null;

  // GEN-02: while a store's first products are coming in (or didn't finish),
  // that is the first thing the founder sees, with progress or a plain retry.
  // A refresh of a store that already has its products only shows here when
  // it needs the founder (it failed or stopped); Settings shows the rest.
  const v = sync?.view;
  const syncCard = v && v.state !== "complete" && (v.firstSync || v.state === "failed" || v.state === "stalled") ? v : null;

  const syncedWords = fresh?.catalog_synced_at ? `synced ${ago(fresh.catalog_synced_at, nowMs)}` : fresh ? "never synced" : "sync time unknown";
  const freshWords = fresh
    ? [
        fresh.last_order_at ? `Last order ${ago(fresh.last_order_at, nowMs)}.` : "No orders yet.",
        fresh.catalog_synced_at ? `Catalog ${syncedWords}.` : "Catalog never synced.",
        cov?.event_coverage_pct == null ? "Analytics coverage shows after your first sale." : `Analytics sees about ${cov.event_coverage_pct}% of sales (shoppers who allowed it).`,
      ].join(" ")
    : "Couldn't check how fresh these numbers are.";
  const newStore = sales && fresh && !fresh.last_order_at ? { open: status.open.open === true } : null;

  return (
    <>
      <PageHeader title="Dashboard" description="Sales from your orders, what needs you, and how your store is doing." actions={<RangeSwitch days={days} />} />
      <div className="space-y-4">
        <StoreBanner status={status} />
        {syncCard && <SyncCard initial={syncCard} gate={gateAction("sync.run", role)} canReconnect={roleAllows(role, "settings.write")} />}
        {canOrders && <SalesSummary sales={sales} newStore={newStore} />}
        <p className="text-[0.8125rem] text-muted-foreground" data-dashboard="freshness">
          {freshWords}
        </p>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-w-0 space-y-4">
            {canOrders && <ActionQueue rows={queue} />}
            {canOrders && sales && <SalesChart sales={sales} />}
          </div>
          <StoreStatus status={status} pushPct={cov?.push_pct ?? null} syncedWords={syncedWords} />
        </div>
      </div>
    </>
  );
}
