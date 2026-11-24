import { Skeleton } from "@/components/ui/skeleton";

// The New store form's shape while it loads: back link, title, then the card
// with its three groups (founder, store, Shopify app) and Create store.
const GROUPS = [2, 3, 2];

export default function NewStoreLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the new store form" className="mx-auto max-w-[640px] px-4 py-6 md:px-6 md:py-8">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="mt-3 h-7 w-40" />
      <Skeleton className="mt-2 h-4 w-full max-w-md" />
      <div className="mt-6 space-y-6 rounded-card border border-border bg-card p-4 shadow-card md:p-6">
        {GROUPS.map((n, g) => (
          <div key={g} className={g ? "space-y-5 border-t border-border pt-6" : "space-y-5"}>
            <Skeleton className="h-5 w-28" />
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        ))}
        <div className="border-t border-border pt-6">
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
    </div>
  );
}
