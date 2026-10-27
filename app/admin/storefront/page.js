import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getBlock, getAnnouncement, getHero, getHomeSections, getNav, listContentPages } from "@/lib/cms/store";
import { BLOCK_KEYS } from "@/lib/cms/defaults";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
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

  const [initial, name] = await tfetch(async () => {
    const [announcement, hero, home_sections, nav_header, nav_footer, pages] = await Promise.all([
      getAnnouncement(),
      getHero(),
      getHomeSections(),
      getNav("header"),
      getNav("footer"),
      listContentPages(),
    ]);
    const customized = {};
    for (const key of BLOCK_KEYS) customized[key] = (await getBlock(key)) != null;
    return [
      { blocks: { announcement, hero, home_sections, nav_header, nav_footer }, customized, pages },
      siteName(),
    ];
  });

  return (
    <>
      <AdminNav storeName={name} />
      <StorefrontAdmin initial={initial} />
    </>
  );
}
