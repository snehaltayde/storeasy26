import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { HelpPanel } from "@/components/admin/settings/HelpPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Help · Settings · Admin", robots: { index: false } };

// Settings → Help (Phase 2 line 7). Read in the browser from GET /api/admin/help
// (settings.read), so the page hands in nothing but the gate.
export default async function SettingsHelpPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Help</h2>
      <HelpPanel />
    </>
  );
}
