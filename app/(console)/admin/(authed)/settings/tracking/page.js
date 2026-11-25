import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { settingsView } from "@/lib/admin/settings";
import { currentTenant } from "@/lib/tenant-context";
import { TrackingForm } from "@/components/admin/settings/TrackingForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tracking · Settings · Admin", robots: { index: false } };

// Settings → Tracking (Phase 2 line 7): ids as they are, secrets as has_* flags only.
export default async function SettingsTrackingPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const v = await tfetch(() => settingsView(currentTenant()));
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Tracking</h2>
      <TrackingForm initial={{ readOnly: v.readOnly, tracking: v.tracking }} role={actor.role} />
    </>
  );
}
