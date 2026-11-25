import { Skeleton } from "@/components/ui/skeleton";

// A store page's shape while it loads: breadcrumb and title, the health card,
// then two columns of cards (one on phones).
export default function StoreLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the store" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="mt-2 h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      <Skeleton className="mt-6 h-28 w-full" />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    </div>
  );
}
