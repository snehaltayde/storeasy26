import Link from "next/link";
import { notFound } from "next/navigation";
import TrackEvent from "@/components/analytics/TrackEvent";
import { PdpClassic, PdpEditorial } from "@/components/pdp/PdpLayouts";
import { getProductByHandle } from "@/lib/repo";
import { resolvedPdpExtras, resolvedPdpPairs, resolvedProductOverride, resolvedSurfaceTemplateFor } from "@/lib/content/resolve";
import { numericId } from "@/lib/ids";
import { abs, siteName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { handle } = await params;
  const p = await tfetch(() => getProductByHandle(handle));
  // Thrown HERE (before streaming starts) so the response is a REAL 404 —
  // inside the page body the loading.js boundary has already committed a 200.
  if (!p) notFound();
  return {
    title: p.title,
    description: p.description ? p.description.slice(0, 160) : undefined,
    alternates: { canonical: `/products/${handle}` },
    openGraph: {
      type: "website",
      title: p.title,
      description: p.description ? p.description.slice(0, 160) : undefined,
      url: `/products/${handle}`,
      ...(p.featured_image ? { images: [{ url: p.featured_image }] } : {}),
    },
  };
}

// Product + BreadcrumbList structured data for rich results.
function productJsonLd(product, brandName) {
  const offers =
    product.price_min === product.price_max
      ? {
          "@type": "Offer",
          price: String(product.price_min ?? 0),
          priceCurrency: product.currency || "INR",
          availability: product.available
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
          url: abs(`/products/${product.handle}`),
        }
      : {
          "@type": "AggregateOffer",
          lowPrice: String(product.price_min ?? 0),
          highPrice: String(product.price_max ?? product.price_min ?? 0),
          priceCurrency: product.currency || "INR",
          availability: product.available
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
          offerCount: String(product.variants?.length || 1),
        };
  return [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.title,
      description: product.description || undefined,
      image: (product.images || []).slice(0, 6).map((i) => i.url),
      brand: { "@type": "Brand", name: product.vendor || brandName },
      url: abs(`/products/${product.handle}`),
      offers,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: abs("/") },
        { "@type": "ListItem", position: 2, name: "Collections", item: abs("/collections") },
        { "@type": "ListItem", position: 3, name: product.title, item: abs(`/products/${product.handle}`) },
      ],
    },
  ];
}

export default async function ProductPage({ params }) {
  const { handle } = await params;
  const { product, pairs, brandName, extras, override, template } = await tfetch(async () => {
    const product = await getProductByHandle(handle);
    if (!product) return { product: null };
    // "Pairs well with" (S23): manual placement, else same-collection auto.
    // S39 (MC05): per-product presentation override — modules + badge.
    // S53 (0B-2): both are release-gated now (drafts stay draft until publish).
    const [pairs, extras, override, surface] = await Promise.all([
      resolvedPdpPairs(product.id, { limit: 4 }),
      resolvedPdpExtras(),
      resolvedProductOverride(product.id),
      resolvedSurfaceTemplateFor("pdp", product.id), // S56/S57: family default or this product's explicit assignment
    ]);
    return { product, pairs, brandName: siteName(), extras, override, template: surface.template };
  });
  if (!product) notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(product, brandName)) }}
      />
      <TrackEvent
        name="view_item"
        data={{
          value: product.price_min,
          currency: product.currency || "INR",
          items: [
            {
              id: numericId(product.id),
              name: product.title,
              price: product.price_min,
              quantity: 1,
            },
          ],
        }}
      />
      <nav className="mb-5 text-sm text-zinc-400">
        <Link href="/" className="hover:text-zinc-600">
          Home
        </Link>{" "}
        / <span className="text-zinc-500">{product.product_type || "Product"}</span> /{" "}
        <span className="text-zinc-600">{product.title}</span>
      </nav>

      {/* S56: template variants over the SAME purchase/gallery components —
          the family default is picked in Theme → Page templates. */}
      {template === "editorial" ? (
        <PdpEditorial product={product} override={override} extras={extras} pairs={pairs} />
      ) : (
        <PdpClassic product={product} override={override} extras={extras} pairs={pairs} />
      )}
    </div>
  );
}
