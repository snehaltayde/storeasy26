import { Skeleton } from "@/components/ui/skeleton";

// One app while it loads (Phase 4 design sweep), shaped like the page: the
// breadcrumb and title, then the Overview, Settings and Danger zone cards.
const Block = ({ lines = 3, icon = false }) => (
  <div className="rounded-card border border-border bg-card p-6">
    <div className="flex items-center gap-3">
      {icon && <Skeleton className="size-9 rounded-md" />}
      <Skeleton className="h-5 w-40" />
    </div>
    <Skeleton className="mt-3 h-4 w-80 max-w-full" />
    {Array.from({ length: lines }, (_, i) => (
      <Skeleton key={i} className="mt-3 h-4 w-full" />
    ))}
  </div>
);

export default function AppLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the app">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 mb-6 h-7 w-56 max-w-full" />
      <div className="space-y-6">
        <Block icon lines={3} />
        <Block lines={4} />
        <Block lines={1} />
      </div>
    </div>
  );
}
