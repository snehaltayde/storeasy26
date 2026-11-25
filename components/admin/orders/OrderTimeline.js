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

// Phase 8 line 2: `codVerifiedAt` is when a COD order's code was checked and
// `codCheck` says what it proved ("Phone confirmed by code" for SMS, "Email
// confirmed by code" for email). A time, not the number, so every role
// (support included) sees it.
export function OrderTimeline({ fulfillments = [], refunds = [], events = [], codVerifiedAt = null, codCheck = null, currency, timeZone }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
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
                    {[f.status ? String(f.status).toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null, f.updated_at ? orderTime(f.updated_at, timeZone) : null].filter(Boolean).join(", ")}
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
      <Card className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
        <CardHeader>
          <CardTitle className="text-[1.125rem]">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {codVerifiedAt && codCheck && (
            <p data-order="cod-verified" className="mb-3 text-sm text-foreground">
              {codCheck} <span className="text-xs text-muted-foreground">{orderTime(codVerifiedAt, timeZone)}</span>
            </p>
          )}
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            // a sequence, oldest first: a rail with one mark per change; the
            // latest change gets the accent mark
            <ol className="text-sm">
              {events.map((e, i) => {
                const meta = metaOf(e);
                const detail = meta && (meta.note || meta.reason || meta.error);
                const last = i === events.length - 1;
                return (
                  <li key={e.id} className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                    {!last && <span aria-hidden className="absolute top-3 bottom-0 left-[0.4375rem] w-px bg-border" />}
                    <span aria-hidden className={`relative mt-1.5 size-2 justify-self-center rounded-full ${last ? "bg-primary ring-4 ring-primary/15" : "bg-muted-foreground/50"}`} />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{e.from_status ? `${word(e.from_status)} → ${word(e.to_status)}` : word(e.to_status)}</p>
                      <p className="text-xs text-muted-foreground">{orderTime(e.created_at, timeZone)}</p>
                      {detail && <p className="mt-1 text-xs break-words text-muted-foreground">{String(detail)}</p>}
                    </div>
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
