import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { funnel, topProducts, searchTerms, campaignViews, deviceSplit, coverage, salesRollup } from "@/lib/reporting";
import { formatMoney } from "@/lib/format";
import ExportCsv from "@/components/admin/ExportCsv";
import { tfetch } from "@/lib/tenant-request";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { EmptyState } from "@/components/console/bits";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · Admin", robots: { index: false } };

// Analytics tab (S42 / MC17, redesigned S50): funnel, products, search,
// campaigns, devices — every section carries its coverage badge and a
// definition, exports are the aggregated rows only. Currency FIX: product
// revenue now formats in the store's real order currency (from the sales
// rollup) instead of a hardcoded "INR".

const Definition = ({ children }) => <p className="mt-4 border-t border-edge pt-3 text-[11px] leading-snug text-fg-subtle">{children}</p>;

const PRODUCT_COLUMNS = [
  { key: "title", header: "Product" },
  { key: "qty", header: "Qty", align: "right", width: "4rem" },
  { key: "revenue", header: "Revenue", align: "right", width: "8rem" },
];

const TERM_COLUMNS = [
  { key: "term", header: "Term" },
  { key: "searches", header: "Searches", align: "right", width: "5rem" },
  { key: "zero_results", header: "Zero results", align: "right", width: "6.5rem" },
];

export default async function AdminAnalyticsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [f, prods, terms, camps, dev, cov, rollup] = await tfetch(async () =>
    Promise.all([funnel({ days: 30 }), topProducts({ days: 30 }), searchTerms({ days: 30 }), campaignViews({ days: 30 }), deviceSplit({ days: 30 }), coverage({ days: 30 }), salesRollup({ days: 30 })]),
  );

  // the orders ledger knows the real currency — never hardcode it
  const currency = rollup.currency;
  const consentBadge = <Badge tone="neutral">{cov.event_coverage_pct == null ? "consented sessions" : `~${cov.event_coverage_pct}% of sales visible`}</Badge>;
  const funnelMax = Math.max(...f.steps.map((x) => x.count), 1);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Last 30 days. Behavioural data exists only for shoppers who consented to analytics — these are directional numbers, not a census; money truth lives on the Dashboard."
      />

      <div className="space-y-4">
        <Card>
          <CardHeader title="Funnel" badge={consentBadge} />
          {f.steps.every((s) => s.count === 0) ? (
            <EmptyState title="No consented events in this window yet" className="py-6" />
          ) : (
            <>
              <div className="space-y-1.5">
                {f.steps.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-2 text-xs">
                    <span className="w-32 shrink-0 text-fg-muted">{s.name.replace(/_/g, " ")}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-surface-sunken">
                      <div
                        className="h-full rounded bg-primary motion-safe:transition-[width]"
                        style={{ width: `${Math.round((s.count / funnelMax) * 100)}%`, opacity: Math.max(0.35, 1 - i * 0.15) }}
                      />
                    </div>
                    <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-fg">{s.count}</span>
                  </div>
                ))}
              </div>
              {f.conversion_pct != null && (
                <p className="mt-2 text-xs text-fg-muted">
                  View → purchase: <span className="font-semibold text-fg">{f.conversion_pct}%</span>
                </p>
              )}
            </>
          )}
          <Definition>Each step counts consented events, not unique visitors. Conversion = purchase events ÷ product views.</Definition>
        </Card>

        <Card>
          <CardHeader
            title="Top products"
            badge={<Badge tone="neutral">{prods.truncated ? "last 500 orders" : `${prods.sampled_orders} orders`}</Badge>}
            actions={<ExportCsv rows={prods.products} columns={["title", "qty", "revenue"]} filename="top-products.csv" />}
          />
          <Table
            columns={PRODUCT_COLUMNS}
            rows={prods.products}
            rowKey={(p) => p.title}
            dense
            empty={<EmptyState title="No sales in this window" className="py-6" />}
            renderCell={(p, col) => {
              switch (col.key) {
                case "title":
                  return (
                    <span className="block max-w-60 truncate" title={p.title}>
                      {p.title}
                    </span>
                  );
                case "qty":
                  return <span className="text-xs text-fg-muted">×{p.qty}</span>;
                case "revenue":
                  return <span className="font-medium">{formatMoney(Math.round(p.revenue), currency)}</span>;
                default:
                  return p[col.key];
              }
            }}
          />
          <Definition>Quantity and revenue from order snapshots (sale-status orders), ranked by revenue. This is the orders ledger, not events — consent doesn&rsquo;t limit it.</Definition>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Search terms"
              badge={consentBadge}
              actions={<ExportCsv rows={terms.terms} columns={["term", "searches", "zero_results"]} filename="search-terms.csv" />}
            />
            <Table
              columns={TERM_COLUMNS}
              rows={terms.terms}
              rowKey={(t) => t.term}
              dense
              empty={<EmptyState title="No searches recorded" className="py-6" />}
              renderCell={(t, col) => {
                switch (col.key) {
                  case "term":
                    return (
                      <span className="block max-w-40 truncate" title={t.term}>
                        {t.term}
                      </span>
                    );
                  case "searches":
                    return <span className="text-xs text-fg-muted">{t.searches}×</span>;
                  case "zero_results":
                    return t.zero_results > 0 ? <Badge tone="warning">{t.zero_results} empty</Badge> : <span className="text-xs text-fg-subtle">—</span>;
                  default:
                    return t[col.key];
                }
              }}
            />
            <Definition>Consented search events; zero-result terms are merchandising gaps worth filling.</Definition>
          </Card>

          <Card>
            <CardHeader
              title="Campaigns"
              badge={consentBadge}
              actions={<ExportCsv rows={camps.campaigns} columns={["campaign", "source", "views"]} filename="campaigns.csv" />}
            />
            {camps.campaigns.length === 0 ? (
              <EmptyState title="No campaign views" body="Publish one under /campaigns." className="py-6" />
            ) : (
              <ul className="space-y-1 text-sm">
                {camps.campaigns.map((c, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate text-fg">
                      {c.campaign} <span className="text-xs text-fg-subtle">via {c.source}</span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-fg-muted">{c.views} views</span>
                  </li>
                ))}
              </ul>
            )}
            <Definition>view_campaign events by landing slug and utm_source (S39 pages keep UTMs on click-through).</Definition>
          </Card>
        </div>

        <Card>
          <CardHeader title="Devices" badge={<Badge tone="neutral">{dev.sampled_events} events sampled</Badge>} />
          {dev.sampled_events === 0 ? (
            <EmptyState title="No consented events to classify" className="py-6" />
          ) : (
            <div className="flex flex-wrap gap-3 text-sm">
              {["mobile", "desktop", "tablet", "unknown"].map((k) => (
                <span key={k} className="rounded-ctl bg-surface-sunken px-3 py-2 text-fg-muted">
                  {k}: <span className="font-semibold tabular-nums text-fg">{dev.sampled_events ? Math.round((dev[k] / dev.sampled_events) * 100) : 0}%</span>
                </span>
              ))}
            </div>
          )}
          <Definition>{dev.note}</Definition>
        </Card>
      </div>
    </>
  );
}
