import { Skeleton } from "@/components/ui/skeleton";

// The studio while the page reads: the top bar, then the rail, the preview
// and the inspector (one column below 1024px), as the studio lays out.
export default function StudioLoading() {
  return (
    <div aria-busy="true" aria-label="Opening the studio" className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <div className="hidden space-y-2 border-r border-border p-3 lg:block">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
        <div className="p-3">
          <Skeleton className="h-full min-h-80 w-full" />
        </div>
        <div className="hidden space-y-3 border-l border-border p-3 lg:block">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
