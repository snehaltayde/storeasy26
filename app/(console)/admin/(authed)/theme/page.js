import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { KITS, kitUpgradeAvailable } from "@/lib/themes/kits";
import { tenantOwnCfg } from "@/lib/tenant-context";
import ThemeAdmin from "@/components/admin/ThemeAdmin";
import SurfaceTemplatesCard from "@/components/admin/cms/SurfaceTemplatesCard";
import { getBlockRow } from "@/lib/cms/store";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Theme · Admin", robots: { index: false } };

export default async function AdminThemePage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { initial, surfaceTemplates } = await tfetch(async () => {
    const theme = tenantOwnCfg("theme", null, null) || null;
    const row = await getBlockRow("surface_templates"); // S56: family-default layouts
    return {
      initial: {
        kits: Object.values(KITS).map(({ id, version, label, vertical, description, fonts, brand, swatch }) => ({ id, version, label, vertical, description, fonts, brand, swatch })),
        theme,
        upgradeAvailable: kitUpgradeAvailable(theme),
      },
      surfaceTemplates: { value: row?.value || null, revision: row ? row.revision : null, customized: row != null },
    };
  });

  return (
    <>
      <PageHeader
        title="Theme"
        description="Kits are complete looks for a vertical: surfaces, type, brand defaults and starter copy. Apply one, tweak it in Brand & Storefront, preview, then publish."
      />
      <ThemeAdmin initial={initial} />
      <SurfaceTemplatesCard initial={surfaceTemplates} />
    </>
  );
}
