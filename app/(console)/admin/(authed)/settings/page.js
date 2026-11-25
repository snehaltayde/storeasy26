import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { settingsView } from "@/lib/admin/settings";
import { currentTenant } from "@/lib/tenant-context";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { DetailsForm } from "@/components/admin/settings/DetailsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Admin", robots: { index: false } };

// Settings → Details (Phase 2 line 7). Settings data is never read for a role
// without settings.read; the form gets only its part of settingsView (presence
// flags for secrets, never a value).
export default async function SettingsDetailsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const v = await tfetch(() => settingsView(currentTenant()));
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Details</h2>
      <DetailsForm initial={{ readOnly: v.readOnly, identity: v.identity, domains: v.domains, shopify: v.shopify }} role={actor.role} />
    </>
  );
}
