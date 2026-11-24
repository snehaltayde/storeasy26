import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { integrationStatus } from "@/lib/integrations";
import { listNotifications, listContactMessages } from "@/lib/notifications";
import IntegrationsAdmin from "@/components/admin/IntegrationsAdmin";
import MessagesPanel from "@/components/admin/MessagesPanel";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";
import { PermissionNote } from "@/components/console/bits";
import { Card } from "@/components/console/Card";
import { roleAllows } from "@/lib/platform/authz";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations · Admin", robots: { index: false } };

export default async function AdminIntegrationsPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // Phase 0 line 2 (S2): settings data is never fetched for a role without settings.read
  if (!roleAllows(actor.role, "settings.read")) {
    return (
      <>
        <PageHeader title="Integrations" />
        <Card>
          <PermissionNote role={actor.role} need="view integrations" />
        </Card>
      </>
    );
  }

  const [integrations, messages, notifications] = await tfetch(async () => [
    await integrationStatus(),
    await listContactMessages({ limit: 20 }),
    await listNotifications({ limit: 20 }),
  ]);
  // S34: the support role is PII-redacted — shopper emails/messages stay hidden
  const redacted = actor.role === "support";

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Provider connections, health and revocation. Secret values never appear here — reconnect through Settings or the operator connect flow."
      />
      <IntegrationsAdmin initial={integrations} />
      {/* S39 (BE23 + SF15): contact inbox + notification delivery log */}
      {redacted ? (
        <PermissionNote role={actor.role} need="view shoppers' contact messages" className="mt-8" />
      ) : (
        <MessagesPanel messages={messages} notifications={notifications} />
      )}
    </>
  );
}
