"use client";

import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// A store page that failed to load (Phase 3 line 1): plain words and Try again.
export default function StoreError({ error, reset }) {
  return (
    <div className="mx-auto max-w-[640px] px-4 py-12 md:px-6">
      <Alert variant="destructive" role="alert">
        <AlertTitle>We couldn&apos;t load this store just now.</AlertTitle>
        <AlertDescription>
          <p>{error?.digest ? `Reference: ${error.digest}` : "Nothing was changed. Try again, or check the server logs if it keeps happening."}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={reset}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
