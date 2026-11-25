import { Skeleton } from "@/components/ui/skeleton";

// The Catalog page while it loads (docs/UI.md "States"): skeletons shaped
// like the header, the two cards, the tabs and the first rows of the table.
export default function CatalogLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the catalog" className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-28 rounded-card" />
      </div>
      <Skeleton className="h-8 w-56" />
      <div className="space-y-2 rounded-card border border-border p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
