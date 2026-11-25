"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/kit/empty-state";

// The orders list or an order page failed to load (docs/UI.md "States"):
// plain words and Try again (a read: it only reloads the page's data, so
// data-read-control). Nothing on these pages is typed before they load.
export default function OrdersError({ reset }) {
  return (
    <EmptyState
      icon={TriangleAlert}
      className="border-solid border-destructive/30"
      title="We couldn't load your orders"
      description="Your orders are safe; this page just didn't load. Try again, and contact support if it keeps happening."
      action={
        <Button type="button" variant="outline" size="sm" data-read-control onClick={() => reset()}>
          Try again
        </Button>
      }
    />
  );
}
