import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { resolveBrand, accentShades, DEFAULT_BRAND } from "@/lib/brand";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import BrandAdmin from "@/components/admin/BrandAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brand · Admin", robots: { index: false } };

export default async function AdminBrandPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [initial, name] = await tfetch(async () => {
    const tenantBrand = currentTenant()?.config?.brand || null;
    const brand = resolveBrand(tenantBrand);
    return [{ brand, customized: !!tenantBrand, shades: accentShades(brand.accent), default: DEFAULT_BRAND }, siteName()];
  });

  return (
    <>
      <AdminNav storeName={name} />
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Brand</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Design tokens for your storefront — one accent color drives the whole palette. Text contrast is
          checked against WCAG AA before anything saves.
        </p>
        <div className="mt-5">
          <BrandAdmin initial={initial} />
        </div>
      </div>
    </>
  );
}
