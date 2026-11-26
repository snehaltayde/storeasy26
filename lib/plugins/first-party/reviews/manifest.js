// Phase 9 line 1: Reviews. A shopper who bought a product reviews it from a
// signed invite link (the order page, and an email when the founder turns
// emails on); the store reads each review before it shows. Three storefront
// blocks, each starting Off: Stars under the price, the Reviews list below the
// details, and Review links on the order page. Every block reads approved
// reviews only (lib/reviews/store.js, lib/reviews/stats.js) and hands plain
// text and numbers to a Storeasy primitive; nothing here runs in the browser.
import { defineManifest } from "../../manifest.js";
import { approvedReviews, inviteLinks } from "../../../reviews/store.js";
import { averageText, productStats } from "../../../reviews/stats.js";

export const REVIEWS_PLUGIN = "reviews";

const distribution = (stats) => [5, 4, 3, 2, 1].map((stars) => ({ stars, count: stats.distribution[stars] ?? 0 }));

export default defineManifest({
  id: REVIEWS_PLUGIN,
  name: "Reviews",
  version: "1.0.0",
  summary: "Let people who bought a product review it, read each review before it shows, and show stars on your product pages.",
  description:
    "Reviews gives every buyer a private link to review what they bought, on their order page and, if you turn it on, in an email a few days after the order is fulfilled. Only buyers can write one, once per product. Nothing shows on your store until you approve it under Reviews, and you can reply, hide or reject any review. Installing it changes nothing on your store by itself: the stars, the list and the order-page links only show once you turn them on.",
  icon: "Star",
  author: { name: "Storeasy" },
  scopes: ["orders.read"],
  events: ["order.fulfilled"],
  settings: [
    { key: "invite_emails", kind: "boolean", label: "Email buyers a review invite", default: false },
    { key: "send_after_days", kind: "number", label: "Days after fulfilment to send it", min: 1, max: 30, default: 7 },
    { key: "show_replies", kind: "boolean", label: "Show store replies", default: true },
  ],
  blocks: [
    {
      id: "stars",
      label: "Stars",
      primitive: "rating_summary",
      slots: ["storefront.pdp.under_price"],
      data: async (ctx) => {
        const s = await productStats(ctx?.id);
        return { average: averageText(s.average), count: s.count, link: "#reviews" };
      },
    },
    {
      id: "list",
      label: "Reviews",
      primitive: "review_list",
      slots: ["storefront.pdp.below_fold"],
      data: async (ctx, { installSettings }) => {
        const [s, reviews] = await Promise.all([productStats(ctx?.id), approvedReviews(ctx?.id, { limit: 10, replies: installSettings?.show_replies !== false })]);
        return {
          average: averageText(s.average),
          count: s.count,
          distribution: distribution(s),
          reviews: reviews.map((r) => ({ rating: r.rating, title: r.title, body: r.body, name: r.name, reply: r.reply, date: r.date.slice(0, 10) })),
          ...(ctx?.handle && s.count ? { see_all: `/products/${ctx.handle}/reviews` } : {}),
        };
      },
    },
    {
      id: "links",
      label: "Review links",
      primitive: "link_list",
      slots: ["storefront.order.status"],
      data: async (ctx) => ({ links: await inviteLinks(ctx?.id) }),
    },
  ],
});
