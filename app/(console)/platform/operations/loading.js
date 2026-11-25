import { Skeleton } from "@/components/ui/skeleton";

// The page's shape while it loads: title, the five tabs, the tab's heading
// and a table frame.
export default function OperationsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading operations" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <div className="mt-6 flex flex-wrap gap-2 border-b border-border pb-2">
        {[72, 136, 128, 64, 104].map((w, i) => (
          <Skeleton key={i} className="h-8" style={{ width: w }} />
        ))}
      </div>
      <Skeleton className="mt-6 h-5 w-48" />
      <div className="mt-4 overflow-hidden rounded-card border border-border bg-card shadow-card">
        <div className="h-10 bg-muted" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-0">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-3.5 w-[22%]" />
            <Skeleton className="h-3.5 w-[16%]" />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
