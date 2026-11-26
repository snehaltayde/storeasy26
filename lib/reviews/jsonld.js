// Phase 9 line 1: the product page's review rating for its structured data
// (app/(storefront)/products/[handle]/page.js productJsonLd). Edge-safe.
import { slotBlocks } from "../plugins/placement.js";
import { productStats, ratingJsonLd } from "./stats.js";
import { slog } from "../log.js";

// Phase 9 line 1: AggregateRating from approved reviews only, and only while
// shoppers see the stars: the Reviews plugin enabled and not turned off by
// Storeasy, its Stars block Live (slotBlocks answers those three, as the slot
// itself does), and at least one approved review. Anything unreadable: none.
export async function reviewRating(product) {
  try {
    const live = (await slotBlocks("storefront.pdp.under_price", product)).some((b) => b.live && b.pluginId === "reviews" && b.blockId === "stars");
    return live ? ratingJsonLd(await productStats(product.id)) : null;
  } catch (e) {
    if (e?.digest) throw e;
    slog("review_rating_unreadable", { error: String(e?.name || "Error") });
    return null;
  }
}

// The script body never holds a raw "<", so no product title or review
// number can close the tag.
export const ldJson = (data) => JSON.stringify(data).replace(/</g, "\\u003c");
