import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { salesRollup, freshness, coverage, discrepancies } from "@/lib/reporting";
import { listContactMessages } from "@/lib/notifications";
import { buildChecklist } from "@/lib/admin/onboarding";
import { formatMoney } from "@/lib/format";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · Admin", robots: { index: false } };

// Merchant dashboard (S42 / MC04): reconciled numbers with their freshness
// and coverage on the same screen, an action queue, and honest unknowns —
// a metric we can't compute says so instead of rendering 0.
const ago = (iso) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-zinc-200 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-extrabold text-zinc-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

export default async function AdminDashboardPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [name, rollup, fresh, cov, issues, inbox, checklist] = await tfetch(async () =>
    Promise.all([
      siteName(),
      salesRollup({ days: 30 }),
      freshness(),
      coverage({ days: 30 }),
      discrepancies(),
      listContactMessages({ limit: 50 }),
      buildChecklist().catch(() => ({ supported: false })),
    ]),
  );

  const window = (days) => {
    const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = rollup.series.filter((d) => d.day >= cut);
    const orders = rows.reduce((s, d) => s + d.orders, 0);
    const net = rows.reduce((s, d) => s + d.net, 0);
    return { orders, net };
  };
  const today = rollup.series.at(-1);
  const w7 = window(7);
  const cur = rollup.currency;
  const money = (v) => formatMoney(v, cur);

  const actions = [
    ...issues.map((i) => ({ label: `${i.order}: ${i.detail}`, hint: i.action, href: "/admin/orders", tone: "red" })),
    ...(inbox.filter((m) => m.notify_status === "failed").length
      ? [{ label: `${inbox.filter((m) => m.notify_status === "failed").length} contact message(s) failed to reach your inbox email`, hint: "set a support email in Settings", href: "/admin/integrations", tone: "amber" }]
      : []),
    ...(checklist.supported && !checklist.launched
      ? [{ label: `Setup: ${checklist.doneCount}/${checklist.total} done — not launched yet`, hint: "finish the checklist", href: "/admin/setup", tone: "zinc" }]
      : []),
  ];

  return (
    <>
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Sales from your orders ledger (refunds provider-mirrored); behavioural numbers cover consented
          sessions only. Shopify stays authoritative.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Today" value={today ? money(today.net) : "—"} sub={today ? `${today.orders} order${today.orders === 1 ? "" : "s"}` : "no sales yet today"} />
          <Stat label="7 days" value={money(w7.net)} sub={`${w7.orders} orders`} />
          <Stat label="30 days" value={money(rollup.net)} sub={`${rollup.orders} orders · ${rollup.refunds ? `${money(rollup.refunds)} refunded` : "no refunds"}`} />
          <Stat label="Avg order (30d)" value={rollup.aov != null ? money(Math.round(rollup.aov)) : "unknown"} sub={rollup.aov == null ? "needs at least one order" : `${rollup.tz} days`} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className={`rounded-full px-3 py-1 ${fresh.catalog_synced_at ? "bg-zinc-100 text-zinc-600" : "bg-amber-100 text-amber-700"}`}>
            catalog {fresh.catalog_synced_at ? `synced ${ago(fresh.catalog_synced_at)}` : "never synced"}
          </span>
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-zinc-600">last order {fresh.last_order_at ? ago(fresh.last_order_at) : "— none yet"}</span>
          <span className={`rounded-full px-3 py-1 ${cov.push_pct === 100 ? "bg-lime-100 text-lime-700" : cov.push_pct == null ? "bg-zinc-100 text-zinc-500" : "bg-amber-100 text-amber-700"}`}>
            {cov.push_pct == null ? "Shopify push: no sales in window" : `${cov.push_pct}% of sales pushed to Shopify`}
          </span>
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-zinc-600">
            {cov.event_coverage_pct == null ? "event coverage unknown (no sales)" : `analytics sees ~${cov.event_coverage_pct}% of sales (consent)`}
          </span>
        </div>

        <section className="mt-6 rounded-2xl border border-zinc-200 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Needs attention</h2>
            <Link href="/admin/analytics" className="text-xs font-medium text-lime-700 hover:underline">
              Analytics →
            </Link>
          </div>
          {actions.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">Nothing — queues clear, pushes healthy.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {actions.map((a, i) => (
                <li key={i}>
                  <Link href={a.href} className={`block rounded-xl px-4 py-2.5 text-sm ${a.tone === "red" ? "bg-red-50 text-red-700" : a.tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-zinc-50 text-zinc-600"} hover:opacity-90`}>
                    {a.label}
                    <span className="mt-0.5 block text-xs opacity-70">{a.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-zinc-200 p-5">
          <h2 className="text-sm font-bold">Last 30 days</h2>
          {rollup.series.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">No sales in this window yet — numbers appear with the first order.</p>
          ) : (
            <div className="mt-4 flex h-28 items-end gap-1" role="img" aria-label="Daily net revenue, last 30 days">
              {rollup.series.map((d) => {
                const max = Math.max(...rollup.series.map((x) => x.net), 1);
                return (
                  <div key={d.day} className="group relative flex-1">
                    <div className="w-full rounded-t bg-lime-400 transition group-hover:bg-lime-500" style={{ height: `${Math.max(3, Math.round((d.net / max) * 100))}%` }} />
                    <span className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-white group-hover:block">
                      {d.day}: {money(d.net)} · {d.orders} orders
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
