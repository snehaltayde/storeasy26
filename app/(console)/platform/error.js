"use client";

import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// The operator console's error boundary (Phase 3 line 1, on components/ui):
// a failing page (the Stores list first) says so in plain words and offers
// Try again, instead of the storefront 500 page.
export default function PlatformError({ error, reset }) {
  return (
    <div className="mx-auto max-w-[640px] px-4 py-12 md:px-6" data-screen="platform-error">
      <Alert variant="destructive" role="alert">
        <AlertTitle>This page couldn&apos;t load just now.</AlertTitle>
        <AlertDescription>
          <p>{error?.digest ? `Nothing was saved. Reference: ${error.digest}` : "Nothing was saved. Try again, or check the server logs if it keeps happening."}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={reset}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
