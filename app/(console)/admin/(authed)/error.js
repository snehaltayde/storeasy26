"use client";

import { ErrorState } from "@/components/console/bits";
import { ConsolePageFrame } from "@/components/admin/shell/AdminShell";

// Segment error boundary (S50): a failing admin page keeps the shell and
// offers a retry, instead of the storefront 500 page. ED-01: on the Designer
// the shell has no sidebar (the editor draws its own top bar), so the frame
// adds the menu button there, keeping navigation and sign-out in reach.
export default function AdminError({ error, reset }) {
  return (
    <ConsolePageFrame>
      <div className="rounded-card border border-edge bg-surface p-6 shadow-card">
        <ErrorState
          title="This page hit an error"
          detail={error?.digest ? `Reference: ${error.digest}` : "Nothing was saved. If it keeps happening, check Settings → Help for diagnostics."}
          onRetry={reset}
        />
      </div>
    </ConsolePageFrame>
  );
}
