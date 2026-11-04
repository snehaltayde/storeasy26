import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { tfetch } from "@/lib/console-request";
import { getCmsMode } from "@/lib/cms-mode";
import { editorHref, LEGACY_ROUTE_DOCS } from "@/lib/admin/editor-entry";
import { PageHeader } from "@/components/console/PageHeader";
import HomeEditor from "@/components/admin/cms/HomeEditor";

// S52: the HOME PAGE editor — hero, homepage sections and the collections
// index, split out of the old everything-on-one-screen Storefront admin.
// One screen, three anchor-linked cards (#hero, #sections, #collections);
// the Overview and the Publishing diff deep-link straight into them.
export const dynamic = "force-dynamic";
export const metadata = { title: "Home page · Admin", robots: { index: false } };

export default async function StorefrontHomePage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // P3-ROUTES: a documents store edits this in the new editor (a mode read error keeps this screen; its writes refuse)
  const cmsMode = await tfetch(() => getCmsMode()).catch(() => null);
  if (cmsMode === "documents") redirect(editorHref(LEGACY_ROUTE_DOCS["/admin/storefront/home"]));

  const initial = await tfetch(() => storefrontView());

  return (
    <>
      <PageHeader
        title="Home page"
        description="Everything here saves as a draft — publish from Publishing."
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Home page" }]}
        actions={
          <Link
            href="/admin/releases"
            className="inline-flex items-center gap-1.5 rounded-ctl border border-edge bg-surface px-3 py-1.5 text-xs font-semibold text-fg focus-ring hover:bg-surface-sunken"
          >
            Publishing <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      <HomeEditor initial={initial} />
    </>
  );
}
