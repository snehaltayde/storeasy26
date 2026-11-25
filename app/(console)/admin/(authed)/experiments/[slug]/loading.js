import { Skeleton } from "@/components/ui/skeleton";

// One experiment while it loads: the title row, the plan and the results.
export default function ExperimentLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the experiment">
      <Skeleton className="mb-2 h-4 w-40" />
      <Skeleton className="mb-2 h-7 w-56" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
