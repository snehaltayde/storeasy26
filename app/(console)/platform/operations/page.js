import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { operatorFromCookie } from "@/lib/platform/require-operator";
import OperationsTabs from "@/components/platform/operations/OperationsTabs";
import OperationsLoading from "./loading";

// Phase 3 line 6: job queues, provisioning runs, privacy requests, themes and
// case studies on the new UI (the old console's five panels). Operators only;
// anyone else goes to /platform, the sign-in. Each tab loads its data from its
// /api/platform route, which checks the operator again.
export const dynamic = "force-dynamic";
export const metadata = { title: "Operations · Storeasy platform", robots: { index: false } };

export default async function OperationsPage() {
  const operator = await operatorFromCookie((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return (
    <Suspense fallback={<OperationsLoading />}>
      <OperationsTabs />
    </Suspense>
  );
}
