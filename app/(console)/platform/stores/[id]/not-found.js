import { Store } from "lucide-react";
import { EmptyState } from "@/components/kit/empty-state";

// An unknown store id (Phase 3 line 1).
export default function StoreNotFound() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6" data-screen="platform-store-missing">
      <EmptyState
        icon={Store}
        title="No store with that id"
        description="It may have been offboarded, or the link is wrong."
        action={
          <a href="/platform" className="rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Back to Stores
          </a>
        }
      />
    </div>
  );
}
