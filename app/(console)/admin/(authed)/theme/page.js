import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { KITS, kitUpgradeAvailable } from "@/lib/themes/kits";
import { tenantOwnCfg } from "@/lib/tenant-context";
import ThemeAdmin from "@/components/admin/ThemeAdmin";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Theme · Admin", robots: { index: false } };

export default async function AdminThemePage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(async () => {
    const theme = tenantOwnCfg("theme", null, null) || null;
    return {
      kits: Object.values(KITS).map(({ id, version, label, vertical, description, fonts, brand, swatch }) => ({ id, version, label, vertical, description, fonts, brand, swatch })),
      theme,
      upgradeAvailable: kitUpgradeAvailable(theme),
    };
  });

  return (
    <>
      <PageHeader
        title="Theme"
        description="Kits are complete looks for a vertical: surfaces, type, brand defaults and starter copy. Apply one, tweak it in Brand & Storefront, preview, then publish."
      />
      <ThemeAdmin initial={initial} />
    </>
  );
}
