import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { tfetch } from "@/lib/tenant-request";
import { PageHeader } from "@/components/console/PageHeader";
import NavigationEditor from "@/components/admin/cms/NavigationEditor";

// S52: Navigation — announcement bar, header menu, footer shop links.
// Server shell only: guard, load the one storefront view (blocks + customized
// + CAS revisions), hand it to the client editor.
export const dynamic = "force-dynamic";
export const metadata = { title: "Navigation · Admin", robots: { index: false } };

export default async function NavigationPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(() => storefrontView());

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Navigation" }]}
        title="Navigation"
        description="Announcement bar, header menu and footer shop links. Everything here saves as a draft — shoppers see it after you publish from Releases."
      />
      <NavigationEditor initial={initial} />
    </>
  );
}
