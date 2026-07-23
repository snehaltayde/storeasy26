import { SITE_URL } from "@/lib/site";

export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // No value in indexing transactional/api surfaces.
        disallow: ["/api/", "/checkout", "/checkout/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
