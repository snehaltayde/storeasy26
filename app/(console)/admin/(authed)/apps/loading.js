import { Skeleton } from "@/components/ui/skeleton";

// Phase 4 line 1: Apps while it loads, shaped like the page (the title row,
// the tabs, the list's rows).
export default function AppsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mt-6 h-8 w-56" />
      <div className="mt-4 space-y-2 rounded-card border border-border p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
