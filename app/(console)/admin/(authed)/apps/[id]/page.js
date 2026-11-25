import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { getInstall } from "@/lib/plugins/installs";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { PageHeader } from "@/components/kit/page-header";
import { AppDetail } from "@/components/admin/apps/AppDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "App · Admin", robots: { index: false } };

// One installed app (Phase 4 line 1); [id] is the install id. An unknown or
// uninstalled id is a not-found. Activity is read only for audit.read holders.
export default async function AdminAppPage({ params }) {
  const { id } = await params;
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "apps.read")) return <NoAccess role={actor.role} page />;
  const found = await tfetch(() => getInstall(String(id || ""), { withActivity: roleAllows(actor.role, "audit.read") }));
  if (!found) notFound();
  return (
    <>
      <PageHeader title={found.install.name} breadcrumb={[{ label: "Apps", href: "/admin/apps" }, { label: found.install.name }]} />
      <AppDetail install={found.install} plugin={found.plugin} activity={found.activity ?? null} role={actor.role} />
    </>
  );
}
