import Link from "next/link";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";
import { ORDER_TABS, PAYMENT_TABS, ordersHref } from "@/lib/admin/order-view";

// The orders list's views and filters (docs/plans/phase-2.md "Line 2" §1.1).
// Every control is a read that only changes the address (?view=, ?status=,
// ?payment=, ?q=): links, and a GET search form, so each carries
// data-read-control (support's stray-control rule on a new-UI route).
//   filters: orderFilters() of the address; counts: orderStatusCounts();
//   piiSearch: false for a role that searches by order id only (support);
//   openReturns: open return requests (the Returns tab's count)
const tabClass = (active) =>
  cn(
    "inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-1 text-[0.8125rem] font-medium whitespace-nowrap focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:h-10",
    active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
  );
// a tab's count: tinted with the accent on the current tab, muted otherwise
// The status tabs: below 640px they wrap as chips, so the current one is
// always in view on a phone (a scrolled row hid it off to the right); from
// 640px they are underlined tabs like the views above, scrolling if crowded.
const statusClass = (active) =>
  cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[0.8125rem] font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:h-10",
    "sm:h-9 sm:rounded-none sm:border-0 sm:border-b-2 sm:px-1 sm:focus-visible:rounded-md sm:pointer-coarse:h-10",
    active ? "border-primary/40 bg-primary/5 text-foreground sm:border-primary sm:bg-transparent" : "border-border text-muted-foreground hover:text-foreground sm:border-transparent",
  );
const Count = ({ n, active = false }) => (
  <span className={cn("min-w-5 rounded-full px-1.5 text-center font-mono text-xs tabular-nums", active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{n}</span>
);

export function ViewTabs({ view, total, openReturns }) {
  return (
    <nav aria-label="Orders views" className="mb-4 flex gap-6 border-b border-border">
      <Link href={ordersHref({})} data-read-control aria-current={view === "orders" ? "page" : undefined} className={tabClass(view === "orders")}>
        Orders {total != null && <Count n={total} active={view === "orders"} />}
      </Link>
      <Link href={ordersHref({ view: "returns" })} data-read-control aria-current={view === "returns" ? "page" : undefined} className={tabClass(view === "returns")}>
        Returns {openReturns > 0 && <Count n={openReturns} active={view === "returns"} />}
      </Link>
    </nav>
  );
}

export function OrderFilters({ filters, counts = {}, piiSearch = true, openReturns = 0 }) {
  const { status, payment, q } = filters;
  return (
    <div className="mb-4 space-y-3">
      <ViewTabs view="orders" total={counts.all ?? 0} openReturns={openReturns} />
      <nav aria-label="Order status" className="flex flex-wrap gap-2 sm:flex-nowrap sm:gap-4 sm:overflow-x-auto">
        {ORDER_TABS.map(([key, label]) => (
          <Link key={key} href={ordersHref({ status: key, payment, q })} data-read-control aria-current={status === key ? "page" : undefined} className={statusClass(status === key)}>
            {label} <Count n={key === "all" ? (counts.all ?? 0) : (counts[key] ?? 0)} active={status === key} />
          </Link>
        ))}
      </nav>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Payment" className="inline-flex w-fit rounded-md border border-border bg-muted p-0.5">
          {PAYMENT_TABS.map(([key, label]) => (
            <Link
              key={key || "any"}
              href={ordersHref({ status, payment: key, q })}
              data-read-control
              aria-current={payment === key ? "page" : undefined}
              className={cn(
                "inline-flex h-7 items-center rounded-[5px] px-2.5 text-[0.8125rem] font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:h-9",
                payment === key ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form method="get" action="/admin/orders" role="search" className="relative w-full sm:w-80">
          {status !== "all" && <input type="hidden" name="status" value={status} data-read-control />}
          {payment && <input type="hidden" name="payment" value={payment} data-read-control />}
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={q}
            maxLength={100}
            data-read-control
            aria-label={piiSearch ? "Search orders by id, email, phone or Shopify number" : "Search orders by order id"}
            placeholder={piiSearch ? "Id, email, phone or Shopify number" : "Order id"}
            className="h-9 pl-8"
          />
        </form>
      </div>
      {!piiSearch && <p className="text-xs text-muted-foreground">Support access searches by order id only; customer details stay hidden.</p>}
    </div>
  );
}
