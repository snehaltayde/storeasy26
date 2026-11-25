import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/kit/empty-state";

// The shopping funnel (lib/reporting.js funnel): one bar per step, each a
// share of the biggest step, with the count and that share in Geist Mono
// (on phones the bar drops under its label). Counts are events
// from shoppers who agreed to analytics, not visitors. A visually hidden
// table carries the same numbers for screen readers.
const STEP_WORDS = {
  view_item_list: "Saw a product list",
  view_item: "Opened a product",
  search: "Searched",
  add_to_cart: "Added to cart",
  begin_checkout: "Started checkout",
  add_payment_info: "Chose how to pay",
  purchase: "Bought",
};

export function FunnelCard({ funnel }) {
  const steps = funnel.steps || [];
  const max = Math.max(1, ...steps.map((s) => s.count));
  const empty = steps.every((s) => s.count === 0);
  return (
    <Card data-analytics="funnel">
      <CardHeader>
        <CardTitle>Funnel</CardTitle>
        <CardDescription>From a product list to a purchase. Counts are events from shoppers who agreed to analytics, not visitors.</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <EmptyState title="No shopper activity recorded in this range yet." description="Steps appear once shoppers who agreed to analytics browse your store." className="py-6" />
        ) : (
          <>
            <ol aria-hidden className="space-y-3 sm:space-y-2">
              {steps.map((s) => {
                const share = Math.round((s.count / max) * 100);
                return (
                  <li key={s.name} className="grid grid-cols-[1fr_auto_3rem] items-center gap-x-3 gap-y-1 text-[0.8125rem] sm:grid-cols-[10rem_1fr_4rem_3rem]">
                    <span className="truncate text-foreground">{STEP_WORDS[s.name] || s.name}</span>
                    <span className="col-span-3 row-start-2 h-2 overflow-hidden rounded-full bg-muted sm:col-span-1 sm:row-start-1 sm:col-start-2 sm:h-3">
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                    </span>
                    <span className="text-right font-mono text-foreground tabular-nums">{s.count}</span>
                    <span className="text-right font-mono text-muted-foreground tabular-nums">{share}%</span>
                  </li>
                );
              })}
            </ol>
            <table className="sr-only">
              <caption>Funnel steps</caption>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Events</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={s.name}>
                    <th scope="row">{STEP_WORDS[s.name] || s.name}</th>
                    <td>{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {funnel.conversion_pct != null && (
              <p className="mt-4 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-[0.8125rem] text-muted-foreground">
                <span>Product opens that ended in a purchase</span>
                <span className="font-mono text-base font-semibold text-foreground tabular-nums">{funnel.conversion_pct}%</span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
