"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

// The console's error page (S50; new UI since Phase 2 line 11): a console
// failure never lands on the storefront's branded 500 page. Try again
// re-renders the segment.
export default function ConsoleError({ error, reset }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4 text-sm text-foreground">
      <div role="alert" className="w-full rounded-card border border-border bg-card p-6 shadow-card">
        <TriangleAlert aria-hidden className="size-5 text-destructive" />
        <p className="mt-3 text-base font-semibold">Something went wrong</p>
        <p className="mt-1 text-muted-foreground">The console hit an unexpected error. Your data is safe: nothing was saved.</p>
        {error?.digest && <p className="mt-2 font-mono text-xs text-muted-foreground">{`Reference: ${error.digest}`}</p>}
        <Button size="sm" variant="outline" className="mt-4" onClick={() => reset?.()}>
          <RotateCcw aria-hidden />
          Try again
        </Button>
      </div>
    </div>
  );
}
