import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { roleAllows } from "@/lib/platform/authz";
import { consoleList } from "@/lib/subscriptions/console";
import { STATUSES } from "@/lib/subscriptions/store";
import { SubscriptionTable } from "@/components/admin/subscriptions/SubscriptionTable";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscriptions · Admin", robots: { index: false } };

// Phase 9 line 2: the store's subscriptions, under subscriptions.read like
// GET /api/admin/subscriptions (support: no customer details). canManage says
// whether the page shows Pause and Cancel; the API refuses them regardless.
export default async function AdminSubscriptionsPage({ searchParams }) {
  const sp = await searchParams;
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "subscriptions.read")) return <NoAccess role={actor.role} page />;
  const status = STATUSES.includes(sp?.status) ? sp.status : null;
  const subscriptions = await tfetch(() => consoleList({ status, role: actor.role }));
  return <SubscriptionTable rows={subscriptions} status={status} role={actor.role} />;
}
