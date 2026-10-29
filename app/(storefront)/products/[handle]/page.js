import Link from "next/link";
import { notFound } from "next/navigation";
import ProductGallery from "@/components/ProductGallery";
import ProductPurchase from "@/components/ProductPurchase";
import WishlistButton from "@/components/WishlistButton";
import ProductCard from "@/components/ProductCard";
import TrackEvent from "@/components/analytics/TrackEvent";
import { getProductByHandle } from "@/lib/repo";
import { resolvedPdpExtras, resolvedPdpPairs, resolvedProductOverride } from "@/lib/content/resolve";
import { numericId } from "@/lib/ids";
import { abs, siteName } from "@/lib/site";
import { sanitizeHtml } from "@/lib/sanitize";
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
  const { product, pairs, brandName, extras, override } = await tfetch(async () => {
    const product = await getProductByHandle(handle);
    if (!product) return { product: null };
    // "Pairs well with" (S23): manual placement, else same-collection auto.
    // S39 (MC05): per-product presentation override — modules + badge.
    // S53 (0B-2): both are release-gated now (drafts stay draft until publish).
    const [pairs, extras, override] = await Promise.all([
      resolvedPdpPairs(product.id, { limit: 4 }),
      resolvedPdpExtras(),
      resolvedProductOverride(product.id),
    ]);
    return { product, pairs, brandName: siteName(), extras, override };
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

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <ProductGallery images={product.images} title={product.title} />

        <div>
          {product.vendor || override?.badge ? (
            <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-accent-700">
              {product.vendor}
              {override?.badge ? (
                <span className="rounded-full bg-accent-100 px-2.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-accent-800">
                  {override.badge}
                </span>
              ) : null}
            </p>
          ) : null}
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{product.title}</h1>

          <ProductPurchase product={product} />
          <div className="mt-3">
            <WishlistButton handle={product.handle} />
          </div>

          {product.description_html ? (
            <div className="mt-8 border-t border-zinc-100 pt-8">
              <h2 className="mb-3 text-lg font-bold">Details</h2>
              {/* Merchant-authored HTML from the store's own Shopify catalog —
                  allowlist-sanitized (S35): a compromised catalog must not XSS shoppers. */}
              <div
                className="rte"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(product.description_html) }}
              />
            </div>
          ) : product.description ? (
            <div className="mt-8 border-t border-zinc-100 pt-8">
              <h2 className="mb-3 text-lg font-bold">Details</h2>
              <p className="whitespace-pre-line text-zinc-700">{product.description}</p>
            </div>
          ) : null}

          {/* S39 (MC05): per-product modules (ingredients/usage/specs) lead;
              S38 (SF04): store-wide pdp_extras follow. Both sanitized at save. */}
          {(override?.modules?.length > 0 || extras?.length > 0) && (
            <div className="mt-6 divide-y divide-zinc-100 border-t border-zinc-100">
              {[...(override?.modules || []), ...(extras || [])].map((x) => (
                <details key={x.title} className="group py-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-zinc-800 [&::-webkit-details-marker]:hidden">
                    {x.title}
                    <span className="text-zinc-400 transition group-open:rotate-45">+</span>
                  </summary>
                  <div className="rte mt-2 text-sm text-zinc-600" dangerouslySetInnerHTML={{ __html: x.html }} />
                </details>
              ))}
            </div>
          )}
        </div>
      </div>

      {pairs?.products?.length > 0 && (
        <section className="mt-16 border-t border-zinc-100 pt-10">
          <h2 className="mb-6 text-2xl font-bold tracking-tight">{pairs.title}</h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {pairs.products.map((p) => (
              <ProductCard key={p.handle} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
