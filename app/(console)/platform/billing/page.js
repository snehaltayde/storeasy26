import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import BillingConsole from "@/components/platform/billing/BillingConsole";
import BillingLoading from "./loading";

// Phase 3 line 3: plans, subscriptions, the billing ledger, overrides and
// costs, with the tab in the URL (?tab=). Operators only; anyone else goes to
// /platform (the sign-in). Data loads client-side through /api/platform/billing
// and /api/platform/costs.
export const dynamic = "force-dynamic";
export const metadata = { title: "Billing · Storeasy platform", robots: { index: false } };

export default async function BillingPage() {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return (
    <Suspense fallback={<BillingLoading />}>
      <BillingConsole />
    </Suspense>
  );
}
