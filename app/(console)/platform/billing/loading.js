import { Skeleton } from "@/components/ui/skeleton";

// The Billing page's shape while it loads: title, the six tabs, four figures
// and a table frame.
export default function BillingLoading() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <div className="mt-6 flex flex-wrap gap-1">
        {[88, 112, 64, 120, 92, 64].map((w, i) => (
          <Skeleton key={i} className="h-8" style={{ width: w }} />
        ))}
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-card" />
        ))}
      </div>
      <div className="mt-6 overflow-hidden rounded-card border border-border bg-card">
        <div className="h-10 bg-muted" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-0">
            <Skeleton className="h-3.5 w-[24%]" />
            <Skeleton className="h-3.5 w-[16%]" />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
