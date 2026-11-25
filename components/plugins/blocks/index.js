// Phase 4 line 2: the components that draw each block primitive
// (lib/plugins/blocks.js PRIMITIVES). Storeasy owns every one; a plugin only
// names one. Phase 9 adds its own primitives to this map.
import BadgeRow from "./BadgeRow";
import Notice from "./Notice";

export const BLOCK_COMPONENTS = Object.freeze({ badge_row: BadgeRow, notice: Notice });
