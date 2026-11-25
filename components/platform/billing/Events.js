"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { EVENT_WORDS, shortDate } from "./billingWords";
import { useBillingData } from "./useBillingData";
import { selectClass } from "./Subscriptions";
import { SignedMoney } from "./Overview";

// Billing events: the provider ledger, newest first, 50 a page, filtered by
// store (or "no store" for orphans), type and month. Amounts are signed
// (charges +, refunds −); events no store matched are marked.
export default function Events({ params, setParams }) {
  const offset = Math.max(0, Number(params.offset) || 0);
  const qs = new URLSearchParams({ view: "events", ...(params.store && { store: params.store }), ...(params.type && { type: params.type }), ...(params.month && { month: params.month }), ...(offset && { offset: String(offset) }) });
  const { loading, error, data } = useBillingData(`/api/platform/billing?${qs}`);
  const stores = useStores();

  const columns = [
    { key: "occurred_at", header: "When", cell: (e) => <span className="whitespace-nowrap">{shortDate(e.occurred_at)}</span> },
    {
      key: "store",
      header: "Store",
      cell: (e) =>
        e.orphan ? (
          <Badge variant="warning" title={e.note || undefined}>
            No store
          </Badge>
        ) : (
          <a href={`/platform/billing?tab=subscriptions&store=${encodeURIComponent(e.tenant_id)}`} title={e.store_name || e.tenant_id} className="block max-w-[10rem] truncate rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring lg:max-w-[16rem]">
            {e.store_name || e.tenant_id}
          </a>
        ),
    },
    { key: "type", header: "Event", cell: (e) => EVENT_WORDS[e.type] || e.type },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (e) => <SignedMoney paise={e.amount} />,
    },
    { key: "ref", header: "Provider reference", truncate: true, cell: (e) => e.payment_id || e.provider_event_id || e.id },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="ev-store" className="mb-1 text-xs text-muted-foreground">
            Store
          </Label>
          <select id="ev-store" className={`${selectClass} max-w-64`} value={params.store || ""} onChange={(e) => setParams({ store: e.target.value, offset: null })}>
            <option value="">Every store</option>
            <option value="orphan">No store (unmatched)</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="ev-type" className="mb-1 text-xs text-muted-foreground">
            Event
          </Label>
          <select id="ev-type" className={selectClass} value={params.type || ""} onChange={(e) => setParams({ type: e.target.value, offset: null })}>
            <option value="">Any event</option>
            {(data?.types || []).map((t) => (
              <option key={t} value={t}>
                {EVENT_WORDS[t] || t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="ev-month" className="mb-1 text-xs text-muted-foreground">
            Month
          </Label>
          <Input id="ev-month" type="month" value={params.month || ""} onChange={(e) => setParams({ month: e.target.value, offset: null })} className="h-8 w-40" />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>We couldn&apos;t load billing events</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DataTable
        label="Billing events"
        columns={columns}
        rows={data?.rows || []}
        loading={loading && !data}
        empty={<EmptyState title={params.store || params.type || params.month ? "No events match." : "No billing events yet."} description="Razorpay's subscription and payment events land here as they arrive." />}
        footer={data && { offset: data.offset, total: data.total, onPrevious: () => setParams({ offset: Math.max(0, offset - 50) || null }), onNext: () => setParams({ offset: offset + 50 }) }}
      />
    </div>
  );
}

// the store list for the filter (from the subscriptions view, which lists every store)
export function useStores() {
  const { data } = useBillingData("/api/platform/billing?view=subscriptions&store=_none");
  return data?.stores || [];
}
