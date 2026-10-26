import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { getBlock, getAnnouncement, getHero, getHomeSections, getNav, listContentPages } from "@/lib/cms/store";
import { BLOCK_KEYS } from "@/lib/cms/defaults";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import StorefrontAdmin from "@/components/admin/StorefrontAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Storefront · Admin", robots: { index: false } };

export default async function AdminStorefrontPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const authed = await tfetch(() => verifyAdminToken(token));
  if (!authed) redirect("/admin/login");

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
