"use client";

import { useState } from "react";
import Link from "next/link";
import { Inbox, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { StatusBadge } from "@/components/kit/status-badge";
import { orderTime, paymentWords, pushState } from "@/lib/admin/order-view";

// The orders table (docs/plans/phase-2.md "Line 2" §1.1): 50 rows a page from
// the server, newest first; "Load more" asks GET /api/admin/orders for the
// next page with the opaque (created_at, id) cursor and the same filters.
// Loading more is a read, so its button (the kit's footer) and Try again carry
// data-read-control. The customer is masked for a role that may not see it.
//   orders, nextBefore: the first page; total: the current tab's count;
//   filters: orderFilters(); role; piiSearch; timeZone: the store's
export function OrdersList({ orders: first, nextBefore: firstCursor, total, filters, role, piiSearch = true, timeZone }) {
  const [orders, setOrders] = useState(first);
  const [cursor, setCursor] = useState(firstCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const filtered = filters.status !== "all" || Boolean(filters.payment) || Boolean(filters.q);

  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (filters.status !== "all") p.set("status", filters.status);
      if (filters.payment) p.set("payment", filters.payment);
      if (filters.q) p.set("q", filters.q);
      p.set("before", cursor);
      const res = await fetch(`/api/admin/orders?${p}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(res.status === 401 ? "Your session ended. Sign in again to see more orders." : "We couldn't load more orders.");
      setOrders((rows) => [...rows, ...data.orders.filter((o) => !rows.some((r) => r.id === o.id))]);
      setCursor(data.nextBefore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  const columns = [
    { key: "id", header: "Order", cell: (o) => <span className="font-mono text-[0.8125rem]">{o.id}</span> },
    { key: "created_at", header: "Placed", cell: (o) => <span className="whitespace-nowrap text-muted-foreground">{orderTime(o.created_at, timeZone)}</span> },
    {
      key: "customer",
      header: "Customer",
      cell: (o) =>
        piiSearch ? (
          <span className="block max-w-48 truncate" title={o.email || undefined}>
            {o.name || o.email || "—"}
          </span>
        ) : (
          <span className="text-muted-foreground">Hidden for support</span>
        ),
    },
    { key: "payment_method", header: "Payment", cell: (o) => <span className="whitespace-nowrap">{paymentWords(o.payment_method)}</span> },
    { key: "status", header: "Status", cell: (o) => <StatusBadge kind="order" status={o.status} /> },
    { key: "push", header: "Shopify", truncate: true, className: "min-w-40 text-muted-foreground", cell: (o) => pushState(o) },
    // money last, at the right edge, so totals read down one line
    { key: "total", header: "Total", align: "right", className: "w-px pl-6 whitespace-nowrap", cell: (o) => <MoneyCell amount={o.total} currency={o.currency} /> },
  ];

  const empty = filtered ? (
    <EmptyState
      icon={SearchX}
      title="No orders match"
      description={piiSearch ? "Try another status, payment or search." : "Try another status or payment, or search by the full order id."}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/orders" data-read-control>
            Clear filters
          </Link>
        </Button>
      }
    />
  ) : (
    <EmptyState icon={Inbox} title="No orders yet" description="Orders show here the moment a shopper checks out on your storefront." />
  );

  return (
    <div>
      <DataTable
        label="Orders"
        columns={columns}
        rows={orders}
        rowHref={(o) => `/admin/orders/${encodeURIComponent(o.id)}`}
        empty={empty}
        // the kit shows "Load more" while offset + count < total: a cursor means more
        footer={{ total: cursor ? Math.max(total ?? 0, orders.length + 1) : orders.length, onLoadMore: loadMore, loadingMore }}
      />
      {error && (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-[0.8125rem] text-destructive">
          <span>{error} The orders above are still here.</span>
          <Button type="button" variant="outline" size="sm" data-read-control onClick={loadMore} disabled={loadingMore}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
