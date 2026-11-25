import { Skeleton } from "@/components/ui/skeleton";

// Phase 5: one theme while it loads, shaped like the page (breadcrumb and
// title, the colour band, the facts line and actions, the four cards and
// Style rules).
export default function ThemeLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-2 h-7 w-56" />
      <Skeleton className="mt-6 h-10 w-full" />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-4 w-80 max-w-full" />
        <Skeleton className="h-9 w-48" />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-card border border-border p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-3 rounded-card border border-border p-4">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  );
}
