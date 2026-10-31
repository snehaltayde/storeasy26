import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getBlockRow } from "@/lib/cms/store";
import { tfetch } from "@/lib/tenant-request";
import SurfaceDesigner from "@/components/admin/cms/SurfaceDesigner";

// S59 (audit slice 3): the PRODUCT-PAGE designer — real-product context,
// draft preview, template assignment + presentation override in one place.
export const dynamic = "force-dynamic";
export const metadata = { title: "Product page designer · Admin", robots: { index: false } };

export default async function ProductDesignerPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const row = await tfetch(() => getBlockRow("surface_templates"));
  return <SurfaceDesigner surface="pdp" initial={{ surfaceTemplates: { value: row?.value || null, revision: row ? row.revision : null } }} />;
}
