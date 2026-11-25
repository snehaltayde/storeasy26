import { Skeleton } from "@/components/ui/skeleton";

// The orders list while it loads: the header, the tabs, the filter row and
// table rows, shaped like the page (docs/UI.md "States").
export default function OrdersLoading() {
  return (
    <div aria-busy="true" aria-label="Loading orders">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2 mb-6 h-4 w-96 max-w-full" />
      <div className="mb-4 flex gap-6 border-b border-border pb-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-20" />
      </div>
      <div className="mb-3 flex gap-4 overflow-hidden">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-24 shrink-0" />
        ))}
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-9 w-full sm:w-72" />
      </div>
      <div className="overflow-hidden rounded-card border border-border bg-card">
        <Skeleton className="h-10 w-full rounded-none" />
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-10 items-center gap-4 border-t border-border px-3 pointer-coarse:h-12">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
