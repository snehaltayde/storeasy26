import Link from "next/link";
import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/utils";

// Orders to act on (actionQueue in lib/admin/dashboard.js): each row a count,
// plain words and where to go. A row with order ids links each order; a row
// the server couldn't check says so. Links are reads (support may follow them).
const LINK = "rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
const SHOWN = 5;

function Row({ row }) {
  const Icon = row.unknown ? CircleHelp : CircleAlert;
  return (
    <li className="flex items-start gap-3 py-3" data-queue={row.id}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", row.unknown ? "text-muted-foreground" : "text-warning")} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn("text-sm", row.unknown ? "text-muted-foreground" : "text-foreground")}>
          {row.href ? (
            <Link href={row.href} data-read-control className={LINK}>
              {row.words}
            </Link>
          ) : (
            row.words
          )}
        </p>
        {row.hint && <p className="text-[0.8125rem] text-muted-foreground">{row.hint}</p>}
        {row.orders?.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[0.8125rem]">
            {row.orders.slice(0, SHOWN).map((id) => (
              <li key={id}>
                <Link href={`/admin/orders/${encodeURIComponent(id)}`} data-read-control className={cn(LINK, "font-mono")}>
                  {id}
                </Link>
              </li>
            ))}
            {row.orders.length > SHOWN && <li className="text-muted-foreground">and {row.orders.length - SHOWN} more</li>}
          </ul>
        )}
      </div>
      <span className={cn("min-w-8 text-right font-mono text-sm font-semibold tabular-nums", row.unknown ? "text-muted-foreground" : "text-foreground")}>{row.unknown ? "" : row.count}</span>
    </li>
  );
}

export function ActionQueue({ rows }) {
  return (
    <Card data-dashboard="queue">
      <CardHeader>
        <CardTitle>Orders to act on</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          // Flat inside the card (no box in a box): a calm line, not an alarm.
          <div className="flex items-start gap-3 py-2" data-dashboard="queue-empty">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Nothing needs you right now.</p>
              <p className="text-[0.8125rem] text-muted-foreground">Failed pushes, returns and stuck orders show up here.</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
