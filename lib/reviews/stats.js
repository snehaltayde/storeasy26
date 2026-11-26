// Phase 9 line 1: a product's rating from its approved reviews only. Edge-safe.
// Cached per product under the store's "plugins" tag
// (cachedTenantRead("plugins", ["reviews", productId])); every moderation
// write invalidates that tag, so an approval or a hide shows at once.
//
//   productStats(productId) → { count, average, distribution: { 1..5: n } }
//     average is the exact mean (null when count is 0); display rounds it.
//   ratingJsonLd(stats) → schema.org AggregateRating, or null when count is 0
import { db } from "../db.js";
import { cachedTenantRead } from "../cache.js";
import { notMigratedYet } from "../schema-shape.js";

export const EMPTY_STATS = Object.freeze({ count: 0, average: null, distribution: Object.freeze({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }) });

export async function readProductStats(productId) {
  try {
    const rows = await db
      .selectFrom("reviews")
      .select(["rating", (eb) => eb.fn.countAll().as("n")])
      .where("product_id", "=", String(productId))
      .where("status", "=", "approved")
      .groupBy("rating")
      .execute();
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let sum = 0;
    for (const r of rows) {
      const stars = Number(r.rating);
      const n = Number(r.n);
      if (!Object.hasOwn(distribution, stars)) continue;
      distribution[stars] = n;
      count += n;
      sum += stars * n;
    }
    return { count, average: count ? sum / count : null, distribution };
  } catch (e) {
    if (notMigratedYet(e, { table: "reviews" })) return { ...EMPTY_STATS, distribution: { ...EMPTY_STATS.distribution } };
    throw e;
  }
}

export const productStats = (productId) => (productId ? cachedTenantRead("plugins", ["reviews", String(productId)], () => readProductStats(productId)) : Promise.resolve({ ...EMPTY_STATS, distribution: { ...EMPTY_STATS.distribution } }));

// "4.3": one decimal for display
export const averageText = (avg) => (avg == null ? "" : (Math.round(avg * 10) / 10).toFixed(1));

export function ratingJsonLd(stats) {
  const count = Number(stats?.count);
  const avg = Number(stats?.average);
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(avg)) return null;
  return { "@type": "AggregateRating", ratingValue: Math.round(avg * 100) / 100, reviewCount: count, bestRating: 5, worstRating: 1 };
}
