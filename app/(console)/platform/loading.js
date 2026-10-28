import { Skeleton, SkeletonText } from "@/components/console/bits";

// Route-level loading state (S50): a console-shaped skeleton — sticky-bar
// stand-in plus panel cards — instead of a blank screen.
export default function PlatformLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-6xl px-6 py-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-7 w-40" />
      </div>
      <Skeleton className="mt-3 h-4 w-80" />
      <div className="mt-6 space-y-4">
        <div className="rounded-card border border-edge bg-surface p-5">
          <SkeletonText lines={4} />
        </div>
        <div className="rounded-card border border-edge bg-surface p-5">
          <SkeletonText lines={4} />
        </div>
        <div className="rounded-card border border-edge bg-surface p-5">
          <SkeletonText lines={6} />
        </div>
      </div>
    </div>
  );
}
