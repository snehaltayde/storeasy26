"use client";

import { useState } from "react";
import Link from "next/link";
import { Repeat } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { PageHeader } from "@/components/kit/page-header";
import { StatusBadge } from "@/components/kit/status-badge";
import { SubscriptionDetail } from "./SubscriptionDetail";

// Phase 9 line 2: the subscriptions list. A filter per status (links: the
// server filters), each row's product, quantity and interval, status, next
// due date and next amount (today's price; the checkout confirms it), and the
// customer (hidden for support). A row opens its detail with its history.
const FILTERS = [
  { status: null, label: "All" },
  { status: "active", label: "Active" },
  { status: "paused", label: "Paused" },
  { status: "cancelled", label: "Cancelled" },
];
export const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
export const productText = (r) => `${r.productTitle || "Product no longer in the store"}${r.variantTitle ? ` · ${r.variantTitle}` : ""}`;

export function SubscriptionTable({ rows, status, role }) {
  const [open, setOpen] = useState(null);
  const columns = [
    { key: "product", header: "Product", cell: (r) => productText(r), truncate: true },
    { key: "plan", header: "Delivery", cell: (r) => `${r.quantity} every ${r.interval} days${r.percent ? ` · ${r.percent}% off` : ""}` },
    { key: "status", header: "Status", cell: (r) => <StatusBadge kind="subscription" status={r.status} /> },
    { key: "next", header: "Next due", cell: (r) => (r.status === "paused" ? (r.pausedUntil ? `Paused until ${dateText(r.pausedUntil)}` : "Paused") : dateText(r.nextDueAt)) },
    { key: "amount", header: "Next amount", align: "right", cell: (r) => (r.next ? <MoneyCell amount={r.next.amount} currency={r.next.currency} /> : "—") },
    { key: "customer", header: "Customer", cell: (r) => (r.customer ? r.customer.name || r.customer.email : r.pii_redacted ? "Hidden for your role" : "—"), truncate: true },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Subscriptions" description="Shoppers pay for each delivery when it's due, at that day's price. Nothing is charged automatically." />
      <nav aria-label="Filter by status" className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.status ? `/admin/subscriptions?status=${f.status}` : "/admin/subscriptions"}
            aria-current={status === f.status ? "page" : undefined}
            data-read-control=""
            className={cn("rounded-md px-3 py-1.5 text-sm", status === f.status ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      <DataTable
        label="Subscriptions"
        columns={columns}
        rows={rows}
        rowActions={(r) => (
          <button type="button" data-subscription-open={r.id} data-read-control="" onClick={() => setOpen(r.id)} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            View
          </button>
        )}
        empty={<EmptyState icon={Repeat} title={status ? `No ${status} subscriptions` : "No subscriptions yet"} description="When shoppers subscribe on a product page, their subscriptions show here." />}
      />
      <SubscriptionDetail id={open} role={role} onClose={() => setOpen(null)} />
    </div>
  );
}
