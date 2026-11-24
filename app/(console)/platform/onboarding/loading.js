import { Skeleton } from "@/components/ui/skeleton";

// The page's shape while it loads: title, view tabs, filters, then table rows.
export default function OnboardingLoading() {
  return (
    <div aria-busy="true" aria-label="Loading signups and onboarding" className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <div className="mt-6 flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-28" />
        ))}
      </div>
      <Skeleton className="mt-4 h-8 w-full max-w-md" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
