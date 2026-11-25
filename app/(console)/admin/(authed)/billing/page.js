import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { buildBillingView } from "@/lib/admin/billing-view";
import { PageHeader } from "@/components/kit/page-header";
import BackToOnboarding, { fromOnboarding } from "@/components/admin/onboarding/BackToOnboarding";
import { BillingPanel } from "@/components/admin/billing/BillingPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing · Admin", robots: { index: false } };

// Billing on the new UI (Phase 2 line 7): plan, usage, plans and charges from
// buildBillingView. Billing data is never read for a role without settings.read.
export default async function AdminBillingPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const back = fromOnboarding(await searchParams) ? <BackToOnboarding /> : null;
  const initial = await tfetch(buildBillingView);
  return (
    <>
      {back}
      <PageHeader title="Billing" description="Your Storeasy plan, this month's usage and your charges. The numbers come from the payment provider's confirmed payments." />
      <BillingPanel initial={initial} role={actor.role} />
    </>
  );
}
