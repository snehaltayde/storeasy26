"use client";

import { ErrorState } from "@/components/console/bits";

// Segment error boundary (S50): a failing admin page keeps the shell and
// offers a retry, instead of the storefront 500 page.
export default function AdminError({ error, reset }) {
  return (
    <div className="rounded-card border border-edge bg-surface p-6 shadow-card">
      <ErrorState
        title="This page hit an error"
        detail={error?.digest ? `Reference: ${error.digest}` : "Nothing was saved. If it keeps happening, check Settings → Help for diagnostics."}
        onRetry={reset}
      />
    </div>
  );
}
