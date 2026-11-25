import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { catalogView, listInstalls } from "@/lib/plugins/installs";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { PageHeader } from "@/components/kit/page-header";
import { AppsList } from "@/components/admin/apps/AppsList";
import { CustomAppDialog } from "@/components/admin/apps/CustomAppDialog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apps · Admin", robots: { index: false } };

// Apps (Phase 4 line 1): every role reads the installed apps and the catalog
// (apps.read); only admin and owner install or change them (apps.manage, the
// controls RoleGate'd here and refused by the route). No secret reaches here.
export default async function AdminAppsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "apps.read")) return <NoAccess role={actor.role} page />;
  const [installs, catalog] = await tfetch(async () => [await listInstalls(), await catalogView()]);
  return (
    <>
      <PageHeader title="Apps" description="Add features to your store. An app changes nothing on your storefront until you set it up and turn it on." actions={<CustomAppDialog role={actor.role} />} />
      <AppsList installs={installs} catalog={catalog} role={actor.role} />
    </>
  );
}
