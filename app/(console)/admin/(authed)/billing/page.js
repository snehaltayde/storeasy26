import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { buildBillingView } from "@/lib/admin/billing-view";
import BillingAdmin from "@/components/admin/BillingAdmin";
import { tfetch } from "@/lib/console-request";
import BackToOnboarding, { fromOnboarding } from "@/components/admin/onboarding/BackToOnboarding";
import { PageHeader } from "@/components/console/PageHeader";
import { Card } from "@/components/console/Card";
import { PermissionNote } from "@/components/console/bits";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing · Admin", robots: { index: false } };

// Billing tab (S40 / MC24, redesigned S50): plan, subscription state
// (grace/degraded shown honestly), quotas with pre-limit warnings, charge
// history, plan changes — now confirmed via dialog before money is involved.
export default async function AdminBillingPage({ searchParams }) {
  const jar = await cookies();
  const back = fromOnboarding(await searchParams) ? <BackToOnboarding /> : null;
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // server-side role gate stays — billing data is never fetched for a denied role
  if (!roleAllows(actor.role, "settings.read")) {
    return (
      <>
        {back}
        <PageHeader title="Billing" />
        <Card>
          <PermissionNote role={actor.role} need="view billing" />
        </Card>
      </>
    );
  }

  const initial = await tfetch(buildBillingView);

  return (
    <>
      {back}
      <PageHeader
        title="Billing"
        description="Your plan, usage and charges. Numbers come from the payment provider's confirmed events — never estimates."
      />
      <BillingAdmin initial={initial} />
    </>
  );
}
