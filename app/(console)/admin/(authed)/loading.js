import { Skeleton } from "@/components/ui/skeleton";

// The merchant console while a page reads (Phase 2 line 11, docs/UI.md
// "States"): the shell stays; the content area shows a page-shaped skeleton
// (the page header, two cards, then a wide one) instead of a blank screen.
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2 rounded-card border border-border bg-card p-5">
            {[0, 1, 2, 3].map((j) => (
              <Skeleton key={j} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2 rounded-card border border-border bg-card p-5">
        {[0, 1, 2, 3, 4, 5].map((j) => (
          <Skeleton key={j} className="h-4 w-full" />
        ))}
      </div>
    </div>
  );
}
