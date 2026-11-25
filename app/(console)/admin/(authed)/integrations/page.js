import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { integrationStatus } from "@/lib/integrations";
import { listNotifications, listContactMessages } from "@/lib/notifications";
import { PageHeader } from "@/components/kit/page-header";
import { IntegrationsList } from "@/components/admin/integrations/IntegrationsList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations · Admin", robots: { index: false } };

// Integrations on the new UI (Phase 2 line 7). Nothing is read for a role
// without settings.read; the list holds presence flags and metadata, never a
// secret value (integrationStatus).
export default async function AdminIntegrationsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const [integrations, messages, notifications] = await tfetch(async () => [
    await integrationStatus(),
    await listContactMessages({ limit: 20 }),
    await listNotifications({ limit: 20 }),
  ]);
  return (
    <>
      <PageHeader title="Integrations" description="The services your store is connected to, and whether they work. Saved keys are never shown here." />
      <IntegrationsList initial={integrations} messages={messages} notifications={notifications} role={actor.role} />
    </>
  );
}
