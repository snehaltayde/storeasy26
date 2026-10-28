import { siteUrl } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// S43 (MC21, quirk #9 closed): per-request and tenant-scoped — the sitemap
// line carries THIS host's origin (it used to bake the build-env origin) and
// the operator console + campaign landers are excluded from indexing.
export const dynamic = "force-dynamic";

export default function robots() {
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
