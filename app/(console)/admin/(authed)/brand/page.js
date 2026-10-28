import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { resolveBrand, accentShades, DEFAULT_BRAND } from "@/lib/brand";
import BrandAdmin from "@/components/admin/BrandAdmin";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brand · Admin", robots: { index: false } };

export default async function AdminBrandPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(async () => {
    const tenantBrand = currentTenant()?.config?.brand || null;
    const brand = resolveBrand(tenantBrand);
    return { brand, customized: !!tenantBrand, shades: accentShades(brand.accent), default: DEFAULT_BRAND };
  });

  return (
    <>
      <PageHeader
        title="Brand"
        description="Design tokens for your storefront — one accent color drives the whole palette. Text contrast is checked against WCAG AA before anything saves."
      />
      <BrandAdmin initial={initial} />
    </>
  );
}
