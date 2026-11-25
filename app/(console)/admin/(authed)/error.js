"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

// The merchant console's error page (Phase 2 line 11): a failing page keeps
// the shell and offers Try again, which re-renders the segment (a re-read,
// no write), instead of the storefront's 500 page.
export default function AdminError({ error, reset }) {
  return (
    <div role="alert" data-console-error="" className="mx-auto max-w-xl rounded-card border border-border bg-card p-6 shadow-card">
      <TriangleAlert aria-hidden className="size-5 text-destructive" />
      <h1 className="mt-3 text-base font-semibold text-foreground">This page hit an error</h1>
      <p className="mt-1 text-sm text-muted-foreground">Nothing was saved. If it keeps happening, Settings → Help has the diagnostics.</p>
      {error?.digest && <p className="mt-2 font-mono text-xs text-muted-foreground">{`Reference: ${error.digest}`}</p>}
      <Button size="sm" variant="outline" className="mt-4" onClick={() => reset?.()} data-read-control="">
        <RotateCcw aria-hidden />
        Try again
      </Button>
    </div>
  );
}
