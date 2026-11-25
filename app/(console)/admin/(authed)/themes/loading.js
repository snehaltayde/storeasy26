import { Skeleton } from "@/components/ui/skeleton";

// Phase 5: Themes while it loads, shaped like the page (the title row, the two
// built-in look cards with their colour band, the uploaded themes' rows).
export default function ThemesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mt-8 h-6 w-36" />
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-card border border-border p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-8 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-8 h-6 w-40" />
      <div className="mt-3 space-y-2 rounded-card border border-border p-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
