import { Skeleton } from "@/components/ui/skeleton";

// Publishing while the page reads (Phase 2 line 6): the header, then the
// Waiting to publish and Recently published lists as skeleton rows.
export default function ReleasesLoading() {
  return (
    <div aria-busy="true" aria-label="Opening Publishing" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {[3, 4].map((rows, s) => (
        <div key={s} className="space-y-3">
          <Skeleton className="h-5 w-44" />
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
