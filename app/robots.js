import { headers } from "next/headers";
import { siteUrl } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";
import { isPlatformSiteHost } from "@/lib/platform-site";

// S43 (MC21, quirk #9 closed): per-request and tenant-scoped — the sitemap
// line carries THIS host's origin (it used to bake the build-env origin) and
// the operator console + campaign landers are excluded from indexing.
// S44: the marketing host gets its own simple robots (no tenant sitemap).
export const dynamic = "force-dynamic";

export default async function robots() {
  if (isPlatformSiteHost((await headers()).get("host"))) {
    return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/platform", "/platform/", "/admin", "/admin/"] }] };
  }
  return tenantRobots();
}

function tenantRobots() {
  return tfetch(async () => ({
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // No value in indexing transactional/operator/campaign surfaces.
        disallow: ["/api/", "/checkout", "/checkout/", "/orders/", "/admin", "/admin/", "/platform", "/platform/", "/campaigns/"],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  }));
}
