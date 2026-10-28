import { Skeleton, SkeletonText } from "@/components/console/bits";

// Route-level loading state (S50): a page-shaped skeleton instead of a
// blank screen while the agency session resolves.
export default function PartnersLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-8 space-y-4">
        {[4, 3, 3].map((lines, i) => (
          <div key={i} className="rounded-card border border-edge bg-surface p-5 shadow-card">
            <SkeletonText lines={lines} />
          </div>
        ))}
      </div>
    </div>
  );
}
