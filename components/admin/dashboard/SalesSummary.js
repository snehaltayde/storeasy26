import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/kit/empty-state";
import { formatMoney } from "@/lib/format";
import { cn } from "@/components/ui/utils";

// Today so far, 7 days, the chosen range and the average order (salesView in
// lib/admin/dashboard.js). Refunds are already netted out. sales null: the
// numbers couldn't be read, said plainly instead of showing zeros.
const orders = (n) => `${n} order${n === 1 ? "" : "s"}`;

// The figure is the card: label small and quiet, the number at page-title
// size in Geist Mono, the count underneath. Not CardTitle: a small card's
// title is pinned to text-sm by the card's group variant.
function Stat({ label, value, sub, muted = false }) {
  return (
    <Card size="sm" data-dashboard="stat">
      <CardContent className="flex h-full flex-col gap-1">
        <p className="text-[0.8125rem] font-medium text-muted-foreground">{label}</p>
        <p className={cn("font-mono text-[1.375rem] leading-8 font-semibold tracking-tight tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>{value}</p>
        <p className="mt-auto text-[0.8125rem] text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

export function SalesSummary({ sales, newStore = null }) {
  if (!sales) {
    return <EmptyState title="Couldn't read your sales just now." description="Reload the page to try again. Your orders are safe." className="py-6" />;
  }
  const money = (v) => formatMoney(v, sales.currency);
  const { today, week, range, aov } = sales;
  return (
    <section aria-label="Sales" className="space-y-3" data-dashboard="sales">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Today so far" value={money(today.net)} sub={today.orders ? orders(today.orders) : "No sales yet today"} muted={!today.orders} />
        <Stat label="Last 7 days" value={money(week.net)} sub={orders(week.orders)} />
        {range.days === 7 ? (
          // the 7-day card already is the range: this one shows its refunds instead of a second "Last 7 days"
          <Stat label="Refunds, last 7 days" value={money(range.refunds)} sub={range.refunds ? "Already taken off the sales above" : "No refunds"} muted={!range.refunds} />
        ) : (
          <Stat label={`Last ${range.days} days`} value={money(range.net)} sub={`${orders(range.orders)} · ${range.refunds ? `${money(range.refunds)} refunded` : "no refunds"}`} />
        )}
        <Stat label={`Average order, ${range.days} days`} value={aov == null ? "Not yet" : money(aov)} sub={aov == null ? "Shows after your first order" : `Days counted in ${sales.tz}`} muted={aov == null} />
      </div>
      {newStore && (
        <EmptyState
          title="No orders yet."
          description={newStore.open ? "Your store is open. Your first order shows up here as soon as it's placed." : "Finish getting your store ready, then open it to take your first order."}
          action={
            newStore.open ? null : (
              <Link href="/admin/onboarding" data-read-control className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                Go to onboarding
              </Link>
            )
          }
          className="py-6"
        />
      )}
    </section>
  );
}
