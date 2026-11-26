import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductByHandle } from "@/lib/repo";
import { db } from "@/lib/db";
import { tfetch } from "@/lib/storefront-request";
import { slotBlocks } from "@/lib/plugins/placement";
import { approvedReviews } from "@/lib/reviews/store";
import { averageText, productStats } from "@/lib/reviews/stats";
import Stars from "@/components/plugins/blocks/Stars";
import { Distribution, ReviewItems } from "@/components/plugins/blocks/ReviewList";

// Phase 9 line 1: every approved review of one product, 20 a page, newest
// first ("See all reviews" from the Reviews block). It answers only while
// shoppers see that block: Reviews enabled, not turned off by Storeasy, and
// its Reviews block Live (slotBlocks decides, as on the product page).
// Otherwise, for a product with no approved review, and for a page past the
// last one, it is a 404.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_PAGE = 20;

async function load(handle, page) {
  const product = await getProductByHandle(handle);
  if (!product) return null;
  const block = (await slotBlocks("storefront.pdp.below_fold", product)).find((b) => b.live && b.pluginId === "reviews" && b.blockId === "list");
  if (!block) return null;
  const stats = await productStats(product.id);
  // no approved review, or a page past the last one: a 404
  if (!stats.count || (page - 1) * PER_PAGE >= stats.count) return null;
  const replies = await showsReplies();
  const reviews = await approvedReviews(product.id, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE, replies });
  return { product, stats, reviews };
}

// the install's "Show store replies" setting (on unless the founder turned it off)
async function showsReplies() {
  const row = await db.selectFrom("plugin_installs").select("settings").where("plugin_id", "=", "reviews").where("status", "=", "enabled").executeTakeFirst();
  try {
    return JSON.parse(row?.settings || "{}").show_replies !== false;
  } catch {
    return true;
  }
}

export async function generateMetadata({ params }) {
  const { handle } = await params;
  return { title: "Reviews", alternates: { canonical: `/products/${handle}/reviews` } };
}

export default async function ProductReviewsPage({ params, searchParams }) {
  const { handle } = await params;
  const sp = (await searchParams) ?? {};
  const page = Math.max(1, Math.min(500, Number.parseInt(String(sp.page || "1"), 10) || 1));
  const data = await tfetch(() => load(handle, page));
  if (!data) notFound();
  const { product, stats, reviews } = data;
  const avg = averageText(stats.average);
  const pages = Math.ceil(stats.count / PER_PAGE);
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: stats.distribution[stars] ?? 0 }));
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <nav className="mb-5 text-sm text-sf-text-faint">
        <Link href={`/products/${product.handle}`} className="hover:text-sf-text-muted">
          {product.title}
        </Link>{" "}
        / <span className="text-sf-text-muted">Reviews</span>
      </nav>
      <h1 className="text-2xl font-extrabold tracking-tight">Reviews of {product.title}</h1>
      <div className="mt-6 grid gap-8 sm:grid-cols-[14rem_1fr]">
        <div>
          <p className="flex items-center gap-2">
            <span className="text-3xl font-semibold text-sf-text">{avg}</span>
            <Stars value={Number(avg)} size={18} label={`${avg} out of 5 stars`} />
          </p>
          <p className="mt-1 text-sm text-sf-text-muted">
            {stats.count} {stats.count === 1 ? "review" : "reviews"}
          </p>
          <div className="mt-4">
            <Distribution distribution={distribution} count={stats.count} />
          </div>
        </div>
        <div data-review-list="">
          {reviews.length ? <ReviewItems reviews={reviews.map((r) => ({ ...r, date: r.date.slice(0, 10) }))} /> : <p className="text-sm text-sf-text-muted">No more reviews.</p>}
          {pages > 1 ? (
            <div className="mt-5 flex items-center gap-4 text-sm">
              {page > 1 ? (
                <Link href={`/products/${product.handle}/reviews?page=${page - 1}`} className="font-semibold text-sf-accent-text underline">
                  Newer
                </Link>
              ) : null}
              <span className="text-sf-text-muted">
                Page {page} of {pages}
              </span>
              {page < pages ? (
                <Link href={`/products/${product.handle}/reviews?page=${page + 1}`} className="font-semibold text-sf-accent-text underline">
                  Older
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
