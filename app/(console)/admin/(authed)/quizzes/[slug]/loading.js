import { Skeleton } from "@/components/ui/skeleton";

// Phase 2 line 10: one quiz while it loads, shaped like the editor (the title
// row, the details card, two question cards, the "Try it" column).
export default function QuizLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          {["h-40", "h-56", "h-56"].map((h, i) => (
            <Skeleton key={i} className={`${h} w-full rounded-card`} />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-card" />
      </div>
    </div>
  );
}
