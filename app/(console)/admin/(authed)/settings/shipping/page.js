import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { settingsView } from "@/lib/admin/settings";
import { currentTenant } from "@/lib/tenant-context";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { ShippingForm } from "@/components/admin/settings/ShippingForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shipping · Settings · Admin", robots: { index: false } };

// Settings → Shipping (Phase 2 line 7).
export default async function SettingsShippingPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const v = await tfetch(() => settingsView(currentTenant()));
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Shipping</h2>
      <ShippingForm initial={{ readOnly: v.readOnly, shipping: v.shipping, shipping_is_default: v.shipping_is_default, timeZone: v.commerce?.timezone }} role={actor.role} />
    </>
  );
}
