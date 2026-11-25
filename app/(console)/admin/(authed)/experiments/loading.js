import { Skeleton } from "@/components/ui/skeleton";

// Experiments while they load: the title row, the status tabs and table rows.
export default function ExperimentsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading experiments">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <Skeleton className="mb-3 h-9 w-80 max-w-full" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="mb-1 h-10" />
      ))}
    </div>
  );
}
