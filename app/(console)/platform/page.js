import { cookies } from "next/headers";
import { Suspense } from "react";
import { verifyPlatformToken, platformAdminConfigured, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { platformConfigured } from "@/lib/platform/control";
import { operatorsExist } from "@/lib/platform/sessions";
import PlatformLogin from "@/components/platform/PlatformLogin";
import StoresTable from "@/components/platform/stores/StoresTable";

// The operator console's home (Phase 3 line 1): the Stores list for a
// signed-in operator, the sign-in (or "not set up") for anyone else. The list
// loads client-side through the operator-gated GET /api/platform/tenants, so
// this page renders no store data itself.
export const dynamic = "force-dynamic";
export const metadata = { title: "Stores · Storeasy platform", robots: { index: false } };

// "Not set up" only when nobody could sign in: no setup password AND no
// active operator account. A failed operator lookup shows the sign-in (the
// sign-in itself still fails closed).
async function consoleSetUp() {
  if (platformAdminConfigured()) return true;
  if (!platformConfigured()) return false;
  try {
    return await operatorsExist();
  } catch {
    return true;
  }
}

export default async function PlatformPage() {
  if (!(await consoleSetUp())) return <PlatformLogin configured={false} />;
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (!(await verifyPlatformToken(token))) return <PlatformLogin />;
  return (
    <Suspense>
      <StoresTable />
    </Suspense>
  );
}
