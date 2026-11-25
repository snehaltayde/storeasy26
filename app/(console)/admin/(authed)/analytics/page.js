import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { funnel, topProducts, searchTerms, campaignViews, deviceSplit, coverage, salesRollup } from "@/lib/reporting";
import { RANGES, DEFAULT_RANGE } from "@/lib/admin/dashboard-ranges";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/kit/page-header";
import { FunnelCard } from "@/components/admin/analytics/FunnelCard";
import { AnalyticsError, AnalyticsRange, AnalyticsTables, CoverageNote, SalesNumbers } from "@/components/admin/analytics/AnalyticsTables";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · Admin", robots: { index: false } };

// Analytics on the new UI (Phase 2 line 9; lib/admin/new-ui-routes.js lists
// /admin/analytics). ?days= is 7, 30 or 90 (30 is the plain address). Every
// role with orders.read sees the same aggregates: the sales rollup carries
// totals and a daily series, never an order or a shopper, and the screen is
// handed only the fields it shows. A failed read says so with Try again.
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export default async function AdminAnalyticsPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const asked = Number((await searchParams)?.days);
  const days = RANGES.includes(asked) ? asked : DEFAULT_RANGE;

  const data = await tfetch(async () => {
    try {
      const [f, products, terms, campaigns, devices, cov, sales] = await Promise.all([
        funnel({ days }),
        topProducts({ days }),
        searchTerms({ days }),
        campaignViews({ days }),
        deviceSplit({ days }),
        coverage({ days }),
        salesRollup({ days }),
      ]);
      return {
        funnel: pick(f, ["steps", "conversion_pct"]),
        products: { truncated: products.truncated, products: products.products.map((p) => pick(p, ["product_id", "title", "qty", "revenue"])) },
        terms: { terms: terms.terms.map((t) => pick(t, ["term", "searches", "zero_results"])) },
        campaigns: { campaigns: campaigns.campaigns.map((c) => pick(c, ["campaign", "source", "views"])) },
        devices: pick(devices, ["sampled_events", "mobile", "tablet", "desktop", "unknown"]),
        coverage: pick(cov, ["sales", "event_coverage_pct"]),
        sales: pick(sales, ["currency", "orders", "gross", "refunds", "net", "aov"]),
      };
    } catch {
      return null;
    }
  });

  return (
    <>
      <PageHeader title="Analytics" description={`The last ${days} days: what sold, and how shoppers who agreed to analytics found it.`} actions={<AnalyticsRange days={days} />} />
      {data ? (
        <div className="space-y-4">
          <SalesNumbers sales={data.sales} />
          <CoverageNote coverage={data.coverage} />
          <FunnelCard funnel={data.funnel} />
          <AnalyticsTables products={data.products} terms={data.terms} campaigns={data.campaigns} devices={data.devices} currency={data.sales.currency} days={days} />
        </div>
      ) : (
        <AnalyticsError days={days} />
      )}
    </>
  );
}
