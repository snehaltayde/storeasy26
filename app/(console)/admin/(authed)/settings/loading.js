import { Skeleton } from "@/components/ui/skeleton";

// A settings tab while it loads (docs/UI.md "States"): the tab's title and
// two form-shaped cards. The layout's title and nav are already drawn.
export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading settings" className="space-y-4">
      <Skeleton className="h-6 w-48" />
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-card border border-border p-4">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((j) => (
              <Skeleton key={j} className="h-12 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
