"use client";

import { ErrorState } from "@/components/console/bits";

// Console error boundary (S50): console failures no longer land on the
// storefront's branded 500 page.
export default function ConsoleError({ error, reset }) {
  return (
    <div data-legacy className="contents">
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <div className="w-full rounded-card border border-edge bg-surface p-6 shadow-card">
          <ErrorState
            title="Something went wrong"
            detail={error?.digest ? `Reference: ${error.digest}` : "The console hit an unexpected error. Your data is safe — nothing was saved."}
            onRetry={reset}
          />
        </div>
      </div>
    </div>
  );
}
