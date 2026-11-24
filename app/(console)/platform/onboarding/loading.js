import { Skeleton } from "@/components/ui/skeleton";

// The page's shape while it loads: back link, title, view tabs, filters, then
// the table's frame with its header strip and 40px rows.
export default function OnboardingLoading() {
  return (
    <div aria-busy="true" aria-label="Loading signups and onboarding" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="mt-3 h-7 w-64" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <div className="mt-6 flex flex-wrap gap-1 border-b border-border pb-2">
        {[148, 104, 128, 120, 132, 60].map((w, i) => (
          <Skeleton key={i} className="h-8" style={{ width: w }} />
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Skeleton className="h-8 min-w-60 flex-1" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="mt-4 overflow-hidden rounded-card border border-border bg-card shadow-card">
        <div className="h-10 bg-muted" />
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-0">
            <Skeleton className="h-3.5 w-[20%]" />
            <Skeleton className="h-3.5 w-[16%]" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-3.5 w-[22%]" />
            <Skeleton className="ml-auto h-3.5 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
