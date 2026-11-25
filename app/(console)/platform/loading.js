import { Skeleton } from "@/components/ui/skeleton";

// The Stores list's shape while it loads: title row, the four fleet numbers,
// the search and filters, then the table's frame with 40px rows.
export default function PlatformLoading() {
  return (
    <div aria-busy="true" aria-label="Loading stores" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="mt-6 flex flex-wrap items-end gap-2">
        <Skeleton className="h-8 min-w-60 flex-1" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="mt-3 overflow-hidden rounded-card border border-border bg-card">
        <div className="h-10 bg-muted" />
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-0">
            <Skeleton className="h-3.5 w-[22%]" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-3.5 w-[12%]" />
            <Skeleton className="h-3.5 w-10" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
