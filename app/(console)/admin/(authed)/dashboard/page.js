import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { salesRollup, freshness, coverage, discrepancies, dayInTz } from "@/lib/reporting";
import { listContactMessages } from "@/lib/notifications";
import { buildChecklist } from "@/lib/admin/onboarding";
import { catalogSyncStatus } from "@/lib/sync";
import { roleAllows } from "@/lib/platform/authz";
import SyncProgress from "@/components/admin/SyncProgress";
import { formatMoney } from "@/lib/format";
import { tfetch } from "@/lib/tenant-request";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Stat, EmptyState } from "@/components/console/bits";
import { Badge } from "@/components/console/Badge";
import { Bars } from "@/components/console/charts";
import { cx } from "@/components/console/cx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · Admin", robots: { index: false } };

// Merchant dashboard (S42 / MC04, redesigned S50): reconciled numbers with
// freshness and coverage on one screen, an action queue, honest unknowns —
// and two honesty FIXES: "Today" now really means today in the merchant's
// timezone (it used to show the last ACTIVE day), and the 7-day window cuts
// on merchant-TZ day keys (it used to mix UTC into TZ buckets). The chart
// is a dense series — quiet days render as real gaps, not missing bars.
const ago = (iso) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const RANGES = [7, 30, 90];

export default async function AdminDashboardPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const sp = await searchParams;
  const days = RANGES.includes(Number(sp?.days)) ? Number(sp.days) : 30;

  const [rollup, fresh, cov, issues, inbox, checklist, sync] = await tfetch(async () =>
    Promise.all([
      salesRollup({ days }),
      freshness(),
      coverage({ days }),
      discrepancies(),
      listContactMessages({ limit: 50 }),
      buildChecklist().catch(() => ({ supported: false })),
      catalogSyncStatus().catch(() => null),
    ]),
  );
  // GEN-02: while a store's first products are coming in (or didn't finish),
  // that is the first thing the founder sees, with progress or a plain retry.
  // A refresh of a store that already has its products only shows here when
  // it needs the founder (it failed or stopped); Settings shows the rest.
  const v = sync?.view;
  const syncCard = v && v.state !== "complete" && (v.firstSync || v.state === "failed" || v.state === "stalled") ? v : null;

  const byDay = new Map(rollup.series.map((d) => [d.day, d]));
  const dayKey = (msAgo) => dayInTz(new Date(Date.now() - msAgo).toISOString(), rollup.tz);
  // dense series: every day in the window, zeros included — truthful x-axis
  const dense = Array.from({ length: days }, (_, i) => {
    const key = dayKey((days - 1 - i) * 86400000);
    const d = byDay.get(key);
    return { label: key.slice(5), value: d?.net || 0, title: d ? `${d.orders} order${d.orders === 1 ? "" : "s"}` : "no sales" };
  });
  const today = byDay.get(dayKey(0));
  const last7Keys = new Set(Array.from({ length: 7 }, (_, i) => dayKey(i * 86400000)));
  const w7 = rollup.series.filter((d) => last7Keys.has(d.day)).reduce((acc, d) => ({ orders: acc.orders + d.orders, net: acc.net + d.net }), { orders: 0, net: 0 });
  const money = (v) => formatMoney(v, rollup.currency);

  const actions = [
    ...issues.map((i) => ({ label: `${i.order}: ${i.detail}`, hint: i.action, href: `/admin/orders/${i.order}`, tone: "danger" })),
    ...(inbox.filter((m) => m.notify_status === "failed").length
      ? [{ label: `${inbox.filter((m) => m.notify_status === "failed").length} contact message(s) failed to reach your inbox email`, hint: "Set a support email in Settings", href: "/admin/integrations", tone: "warning" }]
      : []),
    ...(checklist.supported && !checklist.launched
      ? [{ label: `Setup: ${checklist.doneCount}/${checklist.total} done — not launched yet`, hint: "Finish the checklist", href: "/admin/setup", tone: "neutral" }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Sales from your orders ledger (refunds provider-mirrored); behavioural numbers cover consented sessions only. Shopify stays authoritative."
        actions={
          <div className="flex rounded-ctl border border-edge bg-surface p-0.5" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={r === 30 ? "/admin/dashboard" : `/admin/dashboard?days=${r}`}
                aria-current={days === r ? "true" : undefined}
                className={cx("rounded px-2.5 py-1 text-xs font-medium focus-ring", days === r ? "bg-primary text-primary-fg" : "text-fg-muted hover:text-fg")}
              >
                {r}d
              </Link>
            ))}
          </div>
        }
      />

      {syncCard && (
        <div className="mb-4">
          <SyncProgress initial={syncCard} canRun={roleAllows(actor.role, "sync.run")} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Today so far" value={money(today?.net || 0)} sub={today ? `${today.orders} order${today.orders === 1 ? "" : "s"}` : "no sales yet today"} tone={today ? undefined : "muted"} />
        <Stat label="7 days" value={money(w7.net)} sub={`${w7.orders} orders`} />
        <Stat label={`${days} days`} value={money(rollup.net)} sub={`${rollup.orders} orders · ${rollup.refunds ? `${money(rollup.refunds)} refunded` : "no refunds"}`} />
        <Stat label={`Avg order (${days}d)`} value={rollup.aov != null ? money(Math.round(rollup.aov)) : "unknown"} sub={rollup.aov == null ? "needs at least one order" : `days in ${rollup.tz}`} tone={rollup.aov == null ? "muted" : undefined} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Badge tone={fresh.catalog_synced_at ? "neutral" : "warning"}>catalog {fresh.catalog_synced_at ? `synced ${ago(fresh.catalog_synced_at)}` : "never synced"}</Badge>
        <Badge tone="neutral">last order {fresh.last_order_at ? ago(fresh.last_order_at) : "— none yet"}</Badge>
        <Badge tone={cov.push_pct === 100 ? "success" : cov.push_pct == null ? "neutral" : "warning"}>
          {cov.push_pct == null ? "Shopify push: no sales in window" : `${cov.push_pct}% of sales pushed to Shopify`}
        </Badge>
        <Badge tone="neutral">{cov.event_coverage_pct == null ? "event coverage unknown (no sales)" : `analytics sees ~${cov.event_coverage_pct}% of sales (consent)`}</Badge>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Needs attention"
          actions={
            <Link href="/admin/analytics" className="inline-flex items-center gap-1 rounded text-xs font-medium text-fg-muted focus-ring hover:text-fg hover:underline">
              Analytics <ArrowRight size={12} aria-hidden />
            </Link>
          }
        />
        {actions.length === 0 ? (
          <EmptyState title="Nothing needs attention" body="Queues clear, pushes healthy." className="py-6" />
        ) : (
          <ul className="space-y-2">
            {actions.map((a, i) => (
              <li key={i}>
                <Link
                  href={a.href}
                  className={cx(
                    "block rounded-ctl border px-4 py-2.5 text-sm focus-ring motion-safe:transition-colors",
                    a.tone === "danger" ? "border-danger-edge bg-danger-bg text-danger hover:opacity-90" : a.tone === "warning" ? "border-warning-edge bg-warning-bg text-warning hover:opacity-90" : "border-edge bg-surface-sunken text-fg-muted hover:text-fg"
                  )}
                >
                  {a.label}
                  <span className="mt-0.5 block text-xs opacity-75">{a.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader title={`Net revenue — last ${days} days`} description={`Daily buckets in ${rollup.tz}; refunds already netted out.`} />
        {rollup.series.length === 0 ? (
          <EmptyState title="No sales in this window yet" body="The chart appears with the first order." className="py-6" />
        ) : (
          <Bars series={dense} height={130} ariaLabel={`Daily net revenue, last ${days} days`} formatValue={(v) => money(v)} />
        )}
      </Card>
    </>
  );
}
