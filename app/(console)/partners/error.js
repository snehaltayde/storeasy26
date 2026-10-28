"use client";

import { ErrorState } from "@/components/console/bits";

// Segment error boundary (S50): a failing partners page offers a retry in a
// console-styled card instead of bubbling to the root boundary.
export default function PartnersError({ error, reset }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-card border border-edge bg-surface p-6 shadow-card">
        <ErrorState
          title="The partner console hit an error"
          detail={error?.digest ? `Reference: ${error.digest}` : "Nothing was saved. Reload to try again — client grants are unaffected."}
          onRetry={reset}
        />
      </div>
    </div>
  );
}
