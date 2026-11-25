import { Skeleton } from "@/components/ui/skeleton";

// Analytics while it reads: the title row, four number cards, the funnel and
// two tables in the same layout (docs/UI.md "States").
export default function AnalyticsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading analytics">
      <Skeleton className="mb-2 h-7 w-36" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="mb-4 h-56" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
