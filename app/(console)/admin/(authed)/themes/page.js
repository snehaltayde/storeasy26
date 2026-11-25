import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { builtinLooks, listPackages, themeState } from "@/lib/themes/packages";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { PageHeader } from "@/components/kit/page-header";
import { ThemeLibrary } from "@/components/admin/themes/ThemeLibrary";
import { UploadThemeDialog } from "@/components/admin/themes/UploadThemeDialog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Themes · Admin", robots: { index: false } };

// Themes (Phase 5 line 1): every role reads the built-in looks and the
// uploaded themes (storefront.read); only admin and owner upload (themes.manage,
// the control hidden here and refused by the route).
export default async function AdminThemesPage({ searchParams }) {
  const sp = await searchParams;
  const archived = sp?.status === "archived";
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "storefront.read")) return <NoAccess role={actor.role} page />;
  const [packages, state] = await tfetch(() => Promise.all([listPackages({ archived }), themeState()]));
  return (
    <>
      <PageHeader title="Themes" description="The looks your store can use. Uploading a theme changes nothing on your store until you choose it and publish." actions={<UploadThemeDialog role={actor.role} />} />
      <ThemeLibrary builtins={builtinLooks()} packages={packages} archived={archived} state={state} role={actor.role} />
    </>
  );
}
