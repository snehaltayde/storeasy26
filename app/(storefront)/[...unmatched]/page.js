import { notFound } from "next/navigation";

// Catch-all 404 (S50). With two root layouts there is no root layout for
// Next's implicit not-found, so unmatched URLs are caught here and keep
// rendering the storefront's branded 404 inside storefront chrome, exactly
// as before the route-group split. Real routes always win over this.
export const dynamic = "force-dynamic";

export default function Unmatched() {
  notFound();
}
