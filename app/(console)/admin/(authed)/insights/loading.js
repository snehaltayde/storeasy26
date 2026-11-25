import { Skeleton } from "@/components/ui/skeleton";

// Insights while they load: the title row, the budget line and two idea cards.
export default function InsightsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading insights">
      <Skeleton className="mb-2 h-7 w-32" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <Skeleton className="mb-4 h-4 w-64" />
      <Skeleton className="mb-3 h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}
