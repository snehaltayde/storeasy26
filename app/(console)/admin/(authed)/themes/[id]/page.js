import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { getPackage } from "@/lib/themes/packages";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { PageHeader } from "@/components/kit/page-header";
import { ThemeDetail } from "@/components/admin/themes/ThemeDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Theme · Admin", robots: { index: false } };

// One uploaded theme (Phase 5 line 1); [id] is thm_ + 16 hex. An unknown id
// is a not-found. Archive is shown to themes.manage holders only.
export default async function AdminThemePage({ params }) {
  const { id } = await params;
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "storefront.read")) return <NoAccess role={actor.role} page />;
  const found = await tfetch(() => getPackage(String(id || "")));
  if (!found) notFound();
  return (
    <>
      <PageHeader title={found.package.name} breadcrumb={[{ label: "Themes", href: "/admin/themes" }, { label: found.package.name }]} />
      <ThemeDetail pkg={found.package} content={found.content} role={actor.role} />
    </>
  );
}
