import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { resolveBrand, accentShades, DEFAULT_BRAND } from "@/lib/brand";
import BrandAdmin from "@/components/admin/BrandAdmin";
import { brandReadability } from "@/lib/admin/brand-readability";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/console-request";
import { getCmsMode } from "@/lib/cms-mode";
import { editorHref, LEGACY_ROUTE_DOCS } from "@/lib/admin/editor-entry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brand · Admin", robots: { index: false } };

export default async function AdminBrandPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // P3-ROUTES: a documents store edits this in the new editor (a mode read error keeps this screen; its writes refuse)
  const cmsMode = await tfetch(() => getCmsMode()).catch(() => null);
  if (cmsMode === "documents") redirect(editorHref(LEGACY_ROUTE_DOCS["/admin/brand"]));

  const initial = await tfetch(async () => {
    const tenantBrand = currentTenant()?.config?.brand || null;
    const brand = resolveBrand(tenantBrand);
    // TOK-02: what is hard to read shows on arrival too, not only after an edit,
    // and for a store with no brand of its own (its theme kit can still move
    // the header and hero accents)
    const { warnings, notes } = await brandReadability(tenantBrand ? brand : null);
    return { brand, customized: !!tenantBrand, shades: accentShades(brand.accent), default: DEFAULT_BRAND, warnings, notes };
  });

  return (
    <>
      <PageHeader
        title="Brand"
        description="Your store's colours, corners and type. One accent colour drives the whole palette. Anything hard to read is flagged here, and publishing waits until it's fixed."
      />
      <BrandAdmin initial={initial} />
    </>
  );
}
