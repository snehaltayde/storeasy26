import { Skeleton } from "@/components/ui/skeleton";

// The editor while the page reads (Phase 2 line 6, docs/UI.md "States"): the
// editing bar, then a skeleton per pane (sections, settings, preview); one
// pane below 768px, two to 1023px, three from 1024px, as the frame lays out.
export default function EditorLoading() {
  return (
    <div aria-busy="true" aria-label="Opening the editor" className="flex min-h-[calc(100svh-3.5rem)] flex-col">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(20rem,26rem)_minmax(0,1fr)]">
        <div className="hidden space-y-2 border-r border-border p-3 md:block">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
        <div className="space-y-3 p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="hidden bg-muted/40 p-3 lg:block">
          <Skeleton className="h-full min-h-80 w-full" />
        </div>
      </div>
    </div>
  );
}
