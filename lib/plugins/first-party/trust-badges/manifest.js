// Phase 4: Trust badges, the first first-party plugin. Up to four badges, each
// an icon from a fixed set and a short label. It reads nothing of the store
// (no scopes). Its two storefront blocks (line 2), Badges and a Guarantee note, start
// switched off.
import { defineManifest } from "../../manifest.js";

export const BADGE_ICONS = Object.freeze(["truck", "shield", "return", "leaf", "award", "heart"]);

export default defineManifest({
  id: "trust-badges",
  name: "Trust badges",
  version: "1.0.0",
  summary: "Show up to four short promises, like free shipping or secure checkout, to reassure shoppers.",
  description:
    "Trust badges shows a row of up to four small badges, each an icon and a few words, such as \"Free shipping\" or \"Easy returns\". You choose the icons and the words here. Installing it changes nothing on your store by itself: you choose where the badges appear, and they only show once you turn them on.",
  icon: "BadgeCheck",
  author: { name: "Storeasy" },
  scopes: [],
  settings: [
    {
      key: "badges",
      kind: "list",
      label: "Badges",
      max: 4,
      fields: [
        { key: "icon", kind: "choice", label: "Icon", options: [...BADGE_ICONS], required: true },
        { key: "label", kind: "text", label: "Label", max: 40, required: true },
      ],
      default: [
        { icon: "truck", label: "Free shipping" },
        { icon: "shield", label: "Secure checkout" },
        { icon: "return", label: "Easy returns" },
      ],
    },
  ],
  // line 2: blocks
  blocks: [
    {
      id: "badges",
      label: "Badges",
      primitive: "badge_row",
      slots: ["storefront.pdp.under_atc", "storefront.pdp.below_fold"],
      // the badges chosen in this plugin's settings, the same on every product
      data: (_ctx, { installSettings }) => ({ badges: Array.isArray(installSettings?.badges) ? installSettings.badges : [] }),
    },
    {
      id: "guarantee",
      label: "Guarantee note",
      primitive: "notice",
      slots: ["storefront.pdp.below_fold", "storefront.footer.above"],
      settings: [
        { key: "title", kind: "text", label: "Title", max: 80, default: "Our promise" },
        { key: "text", kind: "text", label: "Text", max: 400, required: true, default: "If something isn't right with your order, tell us and we'll make it right." },
        { key: "link_label", kind: "text", label: "Link text", max: 40 },
        { key: "link", kind: "text", label: "Store link", max: 200, placeholder: "/policies/refund-policy" },
      ],
    },
  ],
});
