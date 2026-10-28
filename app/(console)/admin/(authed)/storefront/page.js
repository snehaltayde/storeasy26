import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { siteName } from "@/lib/site";
import StorefrontAdmin from "@/components/admin/StorefrontAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Storefront · Admin", robots: { index: false } };

export default async function AdminStorefrontPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // S50 fix: the page now serves the SAME view the API returns — including
  // the CAS revision tokens and the collections_index/pdp_extras blocks the
  // old hand-rolled initial omitted (false first-save 409s; wipe risk).
  const [initial, name] = await tfetch(async () => [await storefrontView(), siteName()]);

  return (
    <>
      <StorefrontAdmin initial={initial} />
    </>
  );
}
