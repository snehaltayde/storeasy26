import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/kit/empty-state";

// The shopping funnel (lib/reporting.js funnel): one bar per step, each a
// share of the biggest step, with the count in Geist Mono. Counts are events
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
            <ol aria-hidden className="space-y-1.5">
              {steps.map((s) => (
                <li key={s.name} className="grid grid-cols-[9.5rem_1fr_4rem] items-center gap-2 text-[0.8125rem]">
                  <span className="truncate text-muted-foreground">{STEP_WORDS[s.name] || s.name}</span>
                  <span className="h-3 overflow-hidden rounded-sm bg-muted">
                    <span className="block h-full rounded-sm bg-primary" style={{ width: `${Math.round((s.count / max) * 100)}%` }} />
                  </span>
                  <span className="text-right font-mono tabular-nums text-foreground">{s.count}</span>
                </li>
              ))}
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
              <p className="mt-3 text-[0.8125rem] text-muted-foreground">
                Opened a product → bought: <span className="font-mono font-semibold text-foreground tabular-nums">{funnel.conversion_pct}%</span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
