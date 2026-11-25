"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { cn } from "@/components/ui/utils";
import { formatMoney } from "@/lib/format";
import { RANGES, DEFAULT_RANGE } from "@/lib/admin/dashboard-ranges";
import { CsvButton } from "./CsvButton";

// The analytics screen's parts (Phase 2 line 9, docs/UI.md "Analytics,
// experiments, insights and automations"). Every number is an aggregate:
// sales and top products from the orders ledger, the rest from consented
// events. Nothing here names a shopper. Every control is a read (range
// links, CSV downloads built in the browser, Try again), so each carries
// data-read-control.

export const analyticsHref = (days) => (days === DEFAULT_RANGE ? "/admin/analytics" : `/admin/analytics?days=${days}`);

export function AnalyticsRange({ days }) {
  return (
    <nav aria-label="Date range" className="inline-flex rounded-md border border-border bg-card p-0.5">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={analyticsHref(r)}
          data-read-control
          aria-current={days === r ? "page" : undefined}
          className={cn(
            "inline-flex h-7 items-center rounded-[4px] px-2.5 text-[0.8125rem] font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card focus-visible:outline-none pointer-coarse:h-10",
            days === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r} days
        </Link>
      ))}
    </nav>
  );
}

// A failed read: plain words and Try again (the same range, read again).
export function AnalyticsError({ days }) {
  return (
    <EmptyState
      title="Couldn't read your analytics just now."
      description="Nothing is lost. Try again in a moment."
      action={
        <Link href={analyticsHref(days)} data-read-control className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Try again
        </Link>
      }
    />
  );
}

function Stat({ label, value, sub }) {
  return (
    <Card size="sm" data-analytics="stat">
      <CardContent className="flex h-full flex-col gap-1">
        <p className="text-[0.8125rem] font-medium text-muted-foreground">{label}</p>
        <p className="font-mono text-[1.375rem] leading-8 font-semibold tracking-tight text-foreground tabular-nums">{value}</p>
        {sub && <p className="mt-auto text-[0.8125rem] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// The sales rollup for the range (lib/reporting.js salesRollup).
export function SalesNumbers({ sales }) {
  const money = (v) => (v == null ? "—" : formatMoney(Math.round(v), sales.currency));
  return (
    <section aria-label="Sales" className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-analytics="sales">
      <Stat label="Orders" value={String(sales.orders)} sub={sales.orders ? null : "No sales in this range"} />
      <Stat label="Sales" value={money(sales.gross)} sub="Before refunds" />
      <Stat label="Refunds" value={money(sales.refunds)} />
      <Stat label="Average order" value={money(sales.aov)} />
    </section>
  );
}

// Said when consented events cover little of the store's sales: the event
// numbers below are a part of the picture, the orders-based ones are whole.
export function CoverageNote({ coverage }) {
  const pct = coverage.event_coverage_pct;
  if (pct == null || pct >= 60) return null;
  return (
    <p role="note" data-analytics="coverage" className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 px-3 py-2 text-[0.8125rem] text-foreground">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
      <span>
        Tracking is thin: {pct === 0 ? "none" : `about ${pct}%`} of your sales came from shoppers who agreed to analytics, so the funnel, searches, campaigns and devices show only part of the picture. Sales and top products come from your orders and are complete.
      </span>
    </p>
  );
}

function TableCard({ title, description, csv, children, data }) {
  return (
    <Card data-analytics={data}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {csv && <CardAction>{csv}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const PRODUCT_CSV = [
  { key: "title", header: "Product" },
  { key: "qty", header: "Quantity" },
  { key: "revenue", header: "Revenue" },
];
const TERM_CSV = [
  { key: "term", header: "Search" },
  { key: "searches", header: "Searches" },
  { key: "zero_results", header: "With no results" },
];
const CAMPAIGN_CSV = [
  { key: "campaign", header: "Campaign" },
  { key: "source", header: "Source" },
  { key: "views", header: "Views" },
];
const DEVICE_CSV = [
  { key: "device", header: "Device" },
  { key: "events", header: "Events" },
  { key: "share", header: "Share %" },
];
const DEVICE_WORDS = { mobile: "Phone", desktop: "Computer", tablet: "Tablet", unknown: "Not known" };

export function deviceRows(devices) {
  const total = devices.sampled_events || 0;
  return ["mobile", "desktop", "tablet", "unknown"].map((k) => ({ device: DEVICE_WORDS[k], events: devices[k] || 0, share: total ? Math.round(((devices[k] || 0) / total) * 100) : 0 }));
}

export function AnalyticsTables({ products, terms, campaigns, devices, currency, days }) {
  const productRows = products.products.map((p) => ({ ...p, revenue: Math.round(p.revenue) }));
  const devs = deviceRows(devices);
  return (
    <div className="space-y-4">
      <TableCard
        data="products"
        title="Top products"
        description={`By revenue from your orders${products.truncated ? " (the latest 500 in this range)" : ""}.`}
        csv={<CsvButton rows={productRows} columns={PRODUCT_CSV} filename={`top-products-${days}d.csv`} label="top products" />}
      >
        <DataTable
          label="Top products"
          rows={productRows}
          rowKey={(p) => p.product_id || p.title}
          columns={[
            { key: "title", header: "Product", truncate: true },
            { key: "qty", header: "Quantity", align: "right", cell: (p) => <span className="font-mono tabular-nums">{p.qty}</span> },
            { key: "revenue", header: "Revenue", align: "right", cell: (p) => <MoneyCell amount={p.revenue} currency={currency} /> },
          ]}
          empty={<EmptyState title="No sales in this range." className="py-6" />}
        />
      </TableCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <TableCard
          data="terms"
          title="Searches"
          description="What shoppers searched for. A search with no results is something they wanted and couldn't find."
          csv={<CsvButton rows={terms.terms} columns={TERM_CSV} filename={`searches-${days}d.csv`} label="searches" />}
        >
          <DataTable
            label="Searches"
            rows={terms.terms}
            rowKey={(r) => r.term}
            columns={[
              { key: "term", header: "Search", truncate: true },
              { key: "searches", header: "Searches", align: "right", cell: (r) => <span className="font-mono tabular-nums">{r.searches}</span> },
              {
                key: "zero_results",
                header: "No results",
                align: "right",
                cell: (r) => (r.zero_results > 0 ? <Badge variant="warning">{r.zero_results} with no results</Badge> : <span className="text-muted-foreground">—</span>),
              },
            ]}
            empty={<EmptyState title="No searches recorded in this range." className="py-6" />}
          />
        </TableCard>

        <TableCard
          data="campaigns"
          title="Campaigns"
          description="Campaign page views by where the shopper came from."
          csv={<CsvButton rows={campaigns.campaigns} columns={CAMPAIGN_CSV} filename={`campaigns-${days}d.csv`} label="campaigns" />}
        >
          <DataTable
            label="Campaigns"
            rows={campaigns.campaigns}
            rowKey={(r) => `${r.campaign}|${r.source}`}
            columns={[
              { key: "campaign", header: "Campaign", truncate: true },
              { key: "source", header: "Source", truncate: true },
              { key: "views", header: "Views", align: "right", cell: (r) => <span className="font-mono tabular-nums">{r.views}</span> },
            ]}
            empty={<EmptyState title="No campaign views in this range." className="py-6" />}
          />
        </TableCard>
      </div>

      <TableCard
        data="devices"
        title="Devices"
        description="The kind of device behind each recorded event, not a visitor count."
        csv={devices.sampled_events ? <CsvButton rows={devs} columns={DEVICE_CSV} filename={`devices-${days}d.csv`} label="devices" /> : null}
      >
        {devices.sampled_events ? (
          <DataTable
            label="Devices"
            rows={devs}
            rowKey={(r) => r.device}
            columns={[
              { key: "device", header: "Device" },
              { key: "events", header: "Events", align: "right", cell: (r) => <span className="font-mono tabular-nums">{r.events}</span> },
              { key: "share", header: "Share", align: "right", cell: (r) => <span className="font-mono tabular-nums">{r.share}%</span> },
            ]}
          />
        ) : (
          <EmptyState title="No shopper activity to sort by device yet." className="py-6" />
        )}
      </TableCard>
    </div>
  );
}
