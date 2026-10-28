import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { integrationStatus } from "@/lib/integrations";
import { listNotifications, listContactMessages } from "@/lib/notifications";
import { siteName } from "@/lib/site";
import IntegrationsAdmin from "@/components/admin/IntegrationsAdmin";
import MessagesPanel from "@/components/admin/MessagesPanel";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations · Admin", robots: { index: false } };

export default async function AdminIntegrationsPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [integrations, name, messages, notifications] = await tfetch(async () => [
    await integrationStatus(),
    siteName(),
    await listContactMessages({ limit: 20 }),
    await listNotifications({ limit: 20 }),
  ]);
  // S34: the support role is PII-redacted — shopper emails/messages stay hidden
  const redacted = actor.role === "support";

  return (
    <>
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Provider connections, health and revocation. Secret values never appear here — reconnect through
          Settings or the operator connect flow.
        </p>
        <div className="mt-5">
          <IntegrationsAdmin initial={integrations} />
        </div>
        {/* S39 (BE23 + SF15): contact inbox + notification delivery log */}
        {redacted ? (
          <p className="mt-8 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
            Contact messages are hidden for the support role (shopper PII).
          </p>
        ) : (
          <MessagesPanel messages={messages} notifications={notifications} />
        )}
      </div>
    </>
  );
}
