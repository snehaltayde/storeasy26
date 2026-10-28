import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { KITS, kitUpgradeAvailable } from "@/lib/themes/kits";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import ThemeAdmin from "@/components/admin/ThemeAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Theme · Admin", robots: { index: false } };

export default async function AdminThemePage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [initial, name] = await tfetch(async () => {
    const theme = tenantOwnCfg("theme", null, null) || null;
    return [
      {
        kits: Object.values(KITS).map(({ id, version, label, vertical, description, fonts, brand, swatch }) => ({ id, version, label, vertical, description, fonts, brand, swatch })),
        theme,
        upgradeAvailable: kitUpgradeAvailable(theme),
      },
      siteName(),
    ];
  });

  return (
    <>
      <AdminNav storeName={name} />
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Theme</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Kits are complete looks for a vertical: surfaces, type, brand defaults and starter copy. Apply one,
          tweak it in Brand &amp; Storefront, preview, then publish.
        </p>
        <div className="mt-5">
          <ThemeAdmin initial={initial} />
        </div>
      </div>
    </>
  );
}
