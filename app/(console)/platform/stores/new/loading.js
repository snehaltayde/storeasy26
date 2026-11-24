import { Skeleton } from "@/components/ui/skeleton";

// The New store form's shape while it loads: back link, title, then the card
// of labelled fields and the Create store button.
export default function NewStoreLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the new store form" className="mx-auto max-w-[640px] px-4 py-6 md:px-6">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="mt-3 h-7 w-40" />
      <Skeleton className="mt-2 h-4 w-full max-w-md" />
      <div className="mt-6 space-y-5 rounded-card border border-border bg-card p-4 shadow-card md:p-6">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
        <Skeleton className="h-8 w-32" />
      </div>
    </div>
  );
}
