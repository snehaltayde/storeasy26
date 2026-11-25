"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";

// The dashboard couldn't load (Phase 2 line 1): plain words and Try again.
// The page title stays, so the founder knows where they are. Nothing on this
// page is typed, so nothing is lost. Try again only re-reads.
export default function DashboardError({ error, reset }) {
  return (
    <>
      <PageHeader title="Dashboard" />
      <EmptyState
        icon={CircleAlert}
        title="Your dashboard couldn't load."
        description={error?.digest ? `Nothing was changed. If it keeps happening, tell support this reference: ${error.digest}` : "Nothing was changed. Check your connection, then try again."}
        action={
          <Button type="button" variant="outline" data-read-control onClick={() => reset()}>
            Try again
          </Button>
        }
      />
    </>
  );
}
