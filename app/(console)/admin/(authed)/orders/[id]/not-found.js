import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/kit/empty-state";

// An order id this store doesn't have (docs/plans/phase-2.md "Line 2" §1.3).
export default function OrderNotFound() {
  return (
    <EmptyState
      title="We couldn't find that order"
      description="Check the order id, or search for it from Orders."
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/orders" data-read-control>
            Back to orders
          </Link>
        </Button>
      }
    />
  );
}
