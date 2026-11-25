"use client";

import { RotateCcw } from "lucide-react";
import { StoreasyMark } from "@/components/kit/storeasy-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// The console's error page (S50; new UI since Phase 2 line 11): a console
// failure never lands on the storefront's branded 500 page. The sign-in
// frame's shape (the mark, the h1 and a line, above one 384px card). Try
// again re-renders the segment (a re-read, no write).
export default function ConsoleError({ error, reset }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12 text-sm text-foreground">
      <div role="alert" className="w-full max-w-sm space-y-6">
        <div className="flex items-start gap-3">
          <StoreasyMark className="size-8" />
          <div className="min-w-0 space-y-0.5">
            <h1 className="text-lg leading-8 font-semibold">Something went wrong</h1>
            <p className="text-muted-foreground">The console hit an unexpected error. Nothing was saved.</p>
          </div>
        </div>
        <Card>
          <CardContent className="space-y-4 px-6 py-2">
            <p className="text-muted-foreground">Try again to reload this page. If it keeps happening, send the reference below to Storeasy support.</p>
            {error?.digest && <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-muted-foreground">{`Reference: ${error.digest}`}</p>}
            <Button className="h-10 w-full" onClick={() => reset?.()}>
              <RotateCcw aria-hidden />
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
