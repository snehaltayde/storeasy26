"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "@/components/analytics/ErrorReporter";

// Route-level error boundary — a transient upstream blip (Turso, search)
// should read as "try again", not a stack trace. The digest links this render
// to the server-side capture from instrumentation.js.
export default function Error({ error, reset }) {
  useEffect(() => {
    reportClientError({
      name: error?.name || "RouteError",
      message: error?.message || "route error boundary",
      stack: error?.stack,
      digest: error?.digest,
    });
  }, [error]);
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-sf-text-subtle">
        A temporary error stopped this page from loading. It's usually gone on retry.
      </p>
      {error?.digest && <p className="mt-1 text-xs text-sf-text-faint">Ref: {error.digest}</p>}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          onClick={() => reset()}
          className="rounded-full bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-full border border-sf-border-strong px-6 py-3 text-sm font-semibold hover:bg-sf-surface-muted"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
