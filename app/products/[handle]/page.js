import Link from "next/link";
import { notFound } from "next/navigation";
import ProductGallery from "@/components/ProductGallery";
import ProductPurchase from "@/components/ProductPurchase";
import { getProductByHandle } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { handle } = await params;
  const p = await getProductByHandle(handle);
  if (!p) return { title: "Product not found" };
  return {
    title: p.title,
    description: p.description ? p.description.slice(0, 160) : undefined,
    openGraph: p.featured_image ? { images: [{ url: p.featured_image }] } : undefined,
  };
}

export default async function ProductPage({ params }) {
  const { handle } = await params;
  const product = await getProductByHandle(handle);
  if (!product) notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
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
