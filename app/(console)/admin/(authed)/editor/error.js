"use client";

import { Button } from "@/components/ui/button";

// The editor's error page (Phase 2 line 6): the page throws when the store's
// mode can't be read or the store isn't in documents mode (500
// STORE_MODE_INVALID), never a guess. Try again re-renders the segment (a
// re-read, no write).
export default function EditorError({ error, reset }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-12" data-editor-error="">
      <div role="alert" className="rounded-card border border-border bg-card p-6 shadow-card">
        <p className="text-base font-semibold text-foreground">The editor couldn&apos;t open</p>
        <p className="mt-1 text-sm text-muted-foreground">We couldn&apos;t read how this store publishes, so nothing was opened and nothing was changed.</p>
        {error?.digest && <p className="mt-2 text-xs text-muted-foreground">{`Reference: ${error.digest}`}</p>}
        <Button size="sm" variant="outline" className="mt-4" onClick={() => reset?.()} data-read-control="">
          Try again
        </Button>
      </div>
    </div>
  );
}
