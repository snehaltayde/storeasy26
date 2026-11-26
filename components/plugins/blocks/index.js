// Phase 4 line 2: the components that draw each block primitive
// (lib/plugins/blocks.js PRIMITIVES). Storeasy owns every one; a plugin only
// names one. Phase 9 adds its own primitives to this map.
import BadgeRow from "./BadgeRow";
import Notice from "./Notice";
// Phase 9 lines import their block components at their own anchor (one per line).
// p9: reviews
// p9: subscriptions
// p9: whatsapp
// p9: shiprocket
// p9: ai-copilot

export const BLOCK_COMPONENTS = Object.freeze({
  badge_row: BadgeRow,
  notice: Notice,
  // p9: reviews
  // p9: subscriptions
  // p9: whatsapp
  // p9: shiprocket
  // p9: ai-copilot
});
