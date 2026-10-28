import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { funnel, topProducts, searchTerms, campaignViews, deviceSplit, coverage } from "@/lib/reporting";
import { formatMoney } from "@/lib/format";
import { siteName } from "@/lib/site";
import ExportCsv from "@/components/admin/ExportCsv";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · Admin", robots: { index: false } };

// Analytics tab (S42 / MC17): funnel, products, search, campaigns, devices —
// every section carries its coverage badge and a definition, exports are the
// aggregated rows only.
const Card = ({ title, badge, exportEl, children, definition }) => (
  <section className="rounded-2xl border border-zinc-200 p-5">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-bold">
        {title}
        {badge && <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">{badge}</span>}
      </h2>
      {exportEl}
    </div>
    <div className="mt-3">{children}</div>
    {definition && <p className="mt-3 border-t border-zinc-100 pt-2 text-[11px] text-zinc-400">{definition}</p>}
  </section>
);

const Empty = ({ children }) => <p className="py-3 text-sm text-zinc-400">{children}</p>;

export default async function AdminAnalyticsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [name, f, prods, terms, camps, dev, cov] = await tfetch(async () =>
    Promise.all([siteName(), funnel({ days: 30 }), topProducts({ days: 30 }), searchTerms({ days: 30 }), campaignViews({ days: 30 }), deviceSplit({ days: 30 }), coverage({ days: 30 })]),
  );

  const consentBadge = cov.event_coverage_pct == null ? "consented sessions" : `~${cov.event_coverage_pct}% of sales visible`;

  return (
    <>
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Last 30 days. Behavioural data exists only for shoppers who consented to analytics — these are
          directional numbers, not a census; money truth lives on the Dashboard.
        </p>

        <div className="mt-5 space-y-4">
          <Card title="Funnel" badge={consentBadge} definition="Each step counts consented events, not unique visitors. Conversion = purchase events ÷ product views.">
            {f.steps.every((s) => s.count === 0) ? (
              <Empty>No consented events in this window yet.</Empty>
            ) : (
              <>
                <div className="space-y-1.5">
                  {f.steps.map((s) => {
                    const max = Math.max(...f.steps.map((x) => x.count), 1);
                    return (
                      <div key={s.name} className="flex items-center gap-2 text-xs">
                        <span className="w-32 shrink-0 text-zinc-500">{s.name.replace(/_/g, " ")}</span>
                        <div className="h-4 flex-1 overflow-hidden rounded bg-zinc-100">
                          <div className="h-full bg-lime-400" style={{ width: `${Math.round((s.count / max) * 100)}%` }} />
                        </div>
                        <span className="w-14 shrink-0 text-right font-semibold text-zinc-700">{s.count}</span>
                      </div>
                    );
                  })}
                </div>
                {f.conversion_pct != null && <p className="mt-2 text-xs text-zinc-500">View → purchase: <span className="font-bold text-zinc-800">{f.conversion_pct}%</span></p>}
              </>
            )}
          </Card>

          <Card
            title="Top products"
            badge={prods.truncated ? "last 500 orders" : `${prods.sampled_orders} orders`}
            exportEl={<ExportCsv rows={prods.products} columns={["title", "qty", "revenue"]} filename="top-products.csv" />}
            definition="Quantity and revenue from order snapshots (sale-status orders), ranked by revenue. This is the orders ledger, not events — consent doesn't limit it."
          >
            {prods.products.length === 0 ? (
              <Empty>No sales in this window.</Empty>
            ) : (
              <table className="w-full text-left text-sm">
                <tbody>
                  {prods.products.map((p) => (
                    <tr key={p.title} className="border-t border-zinc-100">
                      <td className="max-w-0 truncate py-1.5 pr-3">{p.title}</td>
                      <td className="py-1.5 pr-3 text-xs text-zinc-400">×{p.qty}</td>
                      <td className="py-1.5 text-right font-semibold">{formatMoney(Math.round(p.revenue), "INR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card
              title="Search terms"
              badge={consentBadge}
              exportEl={<ExportCsv rows={terms.terms} columns={["term", "searches", "zero_results"]} filename="search-terms.csv" />}
              definition="Consented search events; zero-result terms are merchandising gaps worth filling."
            >
              {terms.terms.length === 0 ? (
                <Empty>No searches recorded.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {terms.terms.map((t) => (
                    <li key={t.term} className="flex justify-between">
                      <span className="truncate">{t.term}</span>
                      <span className="shrink-0 text-xs text-zinc-400">
                        {t.searches}×{t.zero_results > 0 && <span className="ml-1 font-bold text-amber-600">{t.zero_results} empty</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Campaigns"
              badge={consentBadge}
              exportEl={<ExportCsv rows={camps.campaigns} columns={["campaign", "source", "views"]} filename="campaigns.csv" />}
              definition="view_campaign events by landing slug and utm_source (S39 pages keep UTMs on click-through)."
            >
              {camps.campaigns.length === 0 ? (
                <Empty>No campaign views — publish one under /campaigns.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {camps.campaigns.map((c, i) => (
                    <li key={i} className="flex justify-between">
                      <span className="truncate">
                        {c.campaign} <span className="text-xs text-zinc-400">via {c.source}</span>
                      </span>
                      <span className="shrink-0 text-xs text-zinc-400">{c.views} views</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Devices" badge={`${dev.sampled_events} events sampled`} definition={dev.note}>
            {dev.sampled_events === 0 ? (
              <Empty>No consented events to classify.</Empty>
            ) : (
              <div className="flex gap-4 text-sm">
                {["mobile", "desktop", "tablet", "unknown"].map((k) => (
                  <span key={k} className="rounded-xl bg-zinc-50 px-3 py-2">
                    {k}: <span className="font-bold">{dev.sampled_events ? Math.round((dev[k] / dev.sampled_events) * 100) : 0}%</span>
                  </span>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
