import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { DomainsList } from "@/components/admin/settings/DomainsList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Domains and SEO · Settings · Admin", robots: { index: false } };

// Settings → Domains and SEO (Phase 2 line 7). The list is read in the browser
// from GET /api/admin/domains (settings.read), so the page hands in only the role.
export default async function SettingsDomainsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Domains and SEO</h2>
      <DomainsList role={actor.role} />
    </>
  );
}
