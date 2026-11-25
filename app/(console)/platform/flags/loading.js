import { Skeleton } from "@/components/ui/skeleton";

// The page's shape while it loads: title row, a filter, then the table's frame.
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading feature flags" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mt-6 h-8 w-72 max-w-full" />
      <div className="mt-4 overflow-hidden rounded-card border border-border bg-card">
        <div className="h-10 bg-muted" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-0">
            <Skeleton className="h-3.5 w-[24%]" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-3.5 w-[30%]" />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
