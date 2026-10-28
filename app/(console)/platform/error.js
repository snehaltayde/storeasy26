"use client";

import { ErrorState } from "@/components/console/bits";

// Segment error boundary (S50): a failing platform page keeps console
// styling and offers a retry, instead of the storefront 500 page.
export default function PlatformError({ error, reset }) {
  return (
    <div className="mx-auto max-w-md px-6 py-24">
      <div className="rounded-card border border-edge bg-surface p-6 shadow-card">
        <ErrorState
          title="The platform console hit an error"
          detail={error?.digest ? `Reference: ${error.digest}` : "Nothing was saved. Retry, or check the server logs if it keeps happening."}
          onRetry={reset}
        />
      </div>
    </div>
  );
}
