import Link from "next/link";
import { notFound } from "next/navigation";
import ProductGallery from "@/components/ProductGallery";
import ProductPurchase from "@/components/ProductPurchase";
import TrackEvent from "@/components/analytics/TrackEvent";
import { getProductByHandle } from "@/lib/repo";
import { numericId } from "@/lib/ids";
import { abs } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { handle } = await params;
  const p = await getProductByHandle(handle);
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
function productJsonLd(product) {
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
      brand: { "@type": "Brand", name: product.vendor || "BeastLife" },
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
  const product = await getProductByHandle(handle);
  if (!product) notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(product)) }}
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

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <ProductGallery images={product.images} title={product.title} />

        <div>
          {product.vendor ? (
            <p className="text-sm font-semibold uppercase tracking-wide text-lime-700">
              {product.vendor}
            </p>
          ) : null}
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{product.title}</h1>

          <ProductPurchase product={product} />

          {product.description_html ? (
            <div className="mt-8 border-t border-zinc-100 pt-8">
              <h2 className="mb-3 text-lg font-bold">Details</h2>
              {/* Merchant-authored HTML from the store's own Shopify catalog. */}
              <div
                className="rte"
                dangerouslySetInnerHTML={{ __html: product.description_html }}
              />
            </div>
          ) : product.description ? (
            <div className="mt-8 border-t border-zinc-100 pt-8">
              <h2 className="mb-3 text-lg font-bold">Details</h2>
              <p className="whitespace-pre-line text-zinc-700">{product.description}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
