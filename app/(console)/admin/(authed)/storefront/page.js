import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import StorefrontAdmin from "@/components/admin/StorefrontAdmin";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Storefront · Admin", robots: { index: false } };

export default async function AdminStorefrontPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // S50 fix: the page serves the SAME view the API returns — including the
  // CAS revision tokens and the collections_index/pdp_extras blocks the old
  // hand-rolled initial omitted (false first-save 409s; wipe risk).
  const initial = await tfetch(() => storefrontView());

  return (
    <>
      <PageHeader
        title="Storefront"
        description="Merchandising — announcement, hero, home layout, navigation, pages. Everything here saves as a draft."
        actions={
          <Link
            href="/admin/releases"
            className="inline-flex items-center gap-1.5 rounded-ctl border border-info-edge bg-info-bg px-3 py-1.5 text-xs font-medium text-info focus-ring hover:opacity-90"
          >
            Publishing happens in Releases <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      <StorefrontAdmin initial={initial} />
    </>
  );
}
