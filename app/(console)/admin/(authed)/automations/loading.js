import { Skeleton } from "@/components/ui/skeleton";

// Automations while they load: the title row, the rules and the runs.
export default function AutomationsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading automations">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="mb-1 h-10" />
      ))}
      <Skeleton className="mt-4 h-56" />
    </div>
  );
}
