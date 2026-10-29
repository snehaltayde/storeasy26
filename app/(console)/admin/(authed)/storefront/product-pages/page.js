import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { tfetch } from "@/lib/tenant-request";
import { PageHeader } from "@/components/console/PageHeader";
import PdpExtrasEditor from "@/components/admin/cms/PdpExtrasEditor";

// S52: Product pages — the global pdp_extras accordions (every PDP), plus an
// honest pointer to the per-product modules/badges that live in Catalog.
// Server shell only: guard, load the one storefront view (blocks + customized
// + CAS revisions), hand it to the client editor.
export const dynamic = "force-dynamic";
export const metadata = { title: "Product pages · Admin", robots: { index: false } };

export default async function ProductPagesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(() => storefrontView());

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Product pages" }]}
        title="Product pages"
        description="Accordions shown under the description on every product page. Saves as a draft — shoppers see it after you publish from Releases."
      />
      <PdpExtrasEditor initial={initial} />
    </>
  );
}
