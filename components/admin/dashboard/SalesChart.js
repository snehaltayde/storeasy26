import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";

// Daily net revenue for the range, every day drawn (a quiet day is a zero
// bar, not a gap in the axis). The bars are decoration for sighted readers;
// the same numbers are in a visually hidden table for screen readers.
const dayWords = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function SalesChart({ sales }) {
  if (!sales) return null;
  const { series, currency, tz } = sales;
  const max = Math.max(0, ...series.map((d) => d.net));
  const money = (v) => formatMoney(v, currency);
  const every = series.length > 30 ? 15 : series.length > 7 ? 5 : 1;
  return (
    <Card data-dashboard="chart">
      <CardHeader>
        <CardTitle>Net revenue, last {series.length} days</CardTitle>
        <CardDescription>Each day in {tz}, refunds taken off.</CardDescription>
      </CardHeader>
      <CardContent>
        <div aria-hidden className="flex h-32 items-end gap-px">
          {series.map((d) => (
            <div key={d.day} className="flex h-full min-w-0 flex-1 items-end">
              <div className={d.net > 0 ? "w-full rounded-t-[2px] bg-primary" : "w-full bg-border"} style={{ height: d.net > 0 && max > 0 ? `${Math.max(2, Math.round((d.net / max) * 100))}%` : "1px" }} />
            </div>
          ))}
        </div>
        <div aria-hidden className="mt-1 flex gap-px text-xs text-muted-foreground">
          {series.map((d, i) => (
            <span key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
              {i % every === 0 ? dayWords(d.day) : ""}
            </span>
          ))}
        </div>
        <table className="sr-only">
          <caption>Net revenue each day, last {series.length} days</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Net revenue</th>
              <th scope="col">Orders</th>
            </tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day}>
                <th scope="row">{dayWords(d.day)}</th>
                <td>{money(d.net)}</td>
                <td>{d.orders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
