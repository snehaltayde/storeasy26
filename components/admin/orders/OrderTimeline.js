import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { orderTime } from "@/lib/admin/order-view";
import { statusWords } from "@/components/kit/status-badge";

// Shipments with tracking, refunds and the order's timeline (docs/plans/
// phase-2.md "Line 2" §1.3). Shopify is authoritative for shipments and
// refunds (lib/order-projection.js); "Refresh from Shopify" updates them.
// Tracking links open the carrier's page: a read, so data-read-control.
const word = (s) => (s ? statusWords("order", s).label : null);
const metaOf = (e) => {
  if (typeof e.meta !== "string") return e.meta || null;
  try {
    return JSON.parse(e.meta);
  } catch {
    return null;
  }
};

export function OrderTimeline({ fulfillments = [], refunds = [], events = [], currency, timeZone }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-[1.125rem]">Shipments ({fulfillments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {fulfillments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shipments yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {fulfillments.map((f, i) => (
                <li key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs text-muted-foreground">#{i + 1}</span>
                  {f.tracking_company && <span>{f.tracking_company}</span>}
                  {f.tracking_url ? (
                    <a href={f.tracking_url} target="_blank" rel="noopener noreferrer" data-read-control className="rounded-md font-mono font-medium text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      {f.tracking_number || "Track"}
                    </a>
                  ) : (
                    <span className="font-mono">{f.tracking_number || "No tracking yet"}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {f.status ? String(f.status).toLowerCase().replace(/_/g, " ") : ""}
                    {f.updated_at ? ` · ${orderTime(f.updated_at, timeZone)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-[1.125rem]">Refunds</CardTitle>
          <CardDescription>Refunds happen in your payment provider; Shopify&apos;s record shows here.</CardDescription>
        </CardHeader>
        <CardContent>
          {refunds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No refunds recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {refunds.map((r) => (
                <li key={r.id} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    {orderTime(r.created_at, timeZone)}
                    {r.note ? <span className="ml-2 text-xs">{r.note}</span> : null}
                  </span>
                  <span className="font-mono tabular-nums text-destructive">−{formatMoney(r.amount, currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-[1.125rem]">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {events.map((e) => {
                const meta = metaOf(e);
                const detail = meta && (meta.note || meta.reason || meta.error);
                return (
                  <li key={e.id} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                    <span className="w-44 shrink-0 text-xs text-muted-foreground">{orderTime(e.created_at, timeZone)}</span>
                    <span className="font-medium text-foreground">{e.from_status ? `${word(e.from_status)} → ${word(e.to_status)}` : word(e.to_status)}</span>
                    {detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{String(detail)}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
