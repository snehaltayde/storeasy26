"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/kit/empty-state";

// The orders list or an order page failed to load (docs/UI.md "States"):
// plain words and Try again (a read: it only reloads the page's data, so
// data-read-control). Nothing on these pages is typed before they load.
// Try again refetches the server data (router.refresh) and re-renders the
// segment (reset) in one transition, so a server error can actually clear.
export default function OrdersError({ reset }) {
  const router = useRouter();
  return (
    <EmptyState
      icon={TriangleAlert}
      className="border-solid border-destructive/30"
      title="We couldn't load your orders"
      description="Your orders are safe; this page just didn't load. Try again, and contact support if it keeps happening."
      action={
        <Button type="button" variant="outline" size="sm" data-read-control onClick={() =>
            startTransition(() => {
              router.refresh();
              reset();
            })
          }>
          Try again
        </Button>
      }
    />
  );
}
