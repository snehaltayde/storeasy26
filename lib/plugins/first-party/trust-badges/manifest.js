// Phase 4: Trust badges, the first first-party plugin. Up to four badges, each
// an icon from a fixed set and a short label. It reads nothing of the store
// (no scopes). Its storefront blocks arrive in line 2, switched off.
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
});
