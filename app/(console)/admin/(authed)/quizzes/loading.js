import { Skeleton } from "@/components/ui/skeleton";

// Phase 2 line 10: the quizzes list while it loads, shaped like the page (the
// title row, the search box, the table's rows).
export default function QuizzesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mt-6 h-8 w-80 max-w-full" />
      <div className="mt-3 space-y-2 rounded-card border border-border p-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
