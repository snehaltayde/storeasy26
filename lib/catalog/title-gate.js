// P4-LIVEROW (OVL-01, OVL-05, OVL-17; phase 4 plan decision 1): may a founder
// give a product a new name (title, display_type, display_vendor) yet?
// Edge-safe: no node: imports, no database.
//
//   titleGate() -> { blocked, cause, reason }
//
// P4-SEARCH (owner answer OQ-1 (b)): the gate is OPEN on every store,
// _default and Typesense stores included.
//   - The Typesense condition is gone: a published, undone or reset name
//     reaches search through the minimal OVL-17 reindex
//     (lib/catalog/search-reindex.js), and a full sync indexes the effective
//     names (lib/sync.js indexTypesense, buildSearchDoc over indexRows).
//   - TITLE_READERS_READY is true: every console reader shows the published
//     name (the product picker, offers, bundles, upsells, reports, the editor's
//     product list) with Shopify's name beside it.
//
// The shape stays for a future gate. Each condition in CONDITIONS carries its
// own plain words, and the refusal always names the condition that blocked
// (orchestrator ruling: never search's words when search is not the cause):
//   - a SAVE that sets a new title, display_type or display_vendor is refused
//     with the condition's `save` words (lib/documents/service.js), so a draft
//     never holds a name that can't go live. Clearing them (null, "Use
//     Shopify's") is never gated;
//   - publish checks again (a belt, lib/documents/publish.js), and so do Undo
//     and undoSet (lib/documents/undo.js), naming the product with the
//     condition's `belt` words (titleBeltMessage).
//   Badge, modules, pairs, gallery, description and template are never gated.
//
// Test seam: setTitleGateForTest(state) forces the gate in unit tests
// (true / "blocked" / { blocked: true, cause } closes it, false / "open"
// opens it, null goes back to the real conditions). A forced cause that is a
// condition here uses that condition's words; any other cause uses the
// neutral words. Never used outside tests.

export const TITLE_READERS_READY = true;

export const GATED_FIELDS = Object.freeze(["title", "display_type", "display_vendor"]);

// Each condition: when it blocks, and its words. `blocks()` reads only this
// process (no database). A future gate adds an entry here.
export const CONDITIONS = Object.freeze([
  {
    cause: "readers",
    blocks: () => !TITLE_READERS_READY,
    save: "Some screens of your store's admin still show Shopify's product names, so a new name can't be saved yet.",
    belt: (name) => `The new name for ${name} can't go live yet, because some screens of your store's admin still show Shopify's product names. Reset the name or leave this product out of this publish.`,
    undo: (name) => `The earlier name for ${name} can't go live again yet, because some screens of your store's admin still show Shopify's product names. Nothing was changed.`,
  },
]);

// The words when a test forces the gate with a cause that is no condition.
const NEUTRAL = Object.freeze({
  save: "A new product name can't be saved right now, so nothing was saved.",
  belt: (name) => `The new name for ${name} can't go live right now. Reset the name or leave this product out of this publish.`,
  undo: (name) => `The earlier name for ${name} can't go live again right now. Nothing was changed.`,
});

const wordsOf = (cause) => CONDITIONS.find((c) => c.cause === cause) || NEUTRAL;

// The save refusal when no cause is known (kept for callers that need a
// default: lib/documents/service.js TITLE_BLOCKED_REASON).
export const TITLE_GATE_MESSAGE = NEUTRAL.save;
export const titleGateMessage = (cause) => wordsOf(cause).save;
export const titleBeltMessage = (name, cause = null) => wordsOf(cause).belt(name);
export const titleUndoMessage = (name, cause = null) => wordsOf(cause).undo(name);

let forced = null;

export function setTitleGateForTest(state) {
  if (state == null) forced = null;
  else if (state === true || state === "blocked") forced = { blocked: true, cause: "test" };
  else if (state === false || state === "open") forced = { blocked: false, cause: null };
  else if (typeof state === "object") forced = { blocked: !!state.blocked, cause: state.blocked ? state.cause || "test" : null };
  else throw new TypeError("setTitleGateForTest: true, false, 'blocked', 'open', { blocked } or null");
}

export function titleGate() {
  if (forced) return { blocked: forced.blocked, cause: forced.cause, reason: forced.blocked ? titleGateMessage(forced.cause) : null };
  for (const c of CONDITIONS) {
    if (c.blocks()) return { blocked: true, cause: c.cause, reason: c.save };
  }
  return { blocked: false, cause: null, reason: null };
}

// Does `next` (a product_content body) put a name live that `live` (the body
// live now, or null) doesn't show? A name cleared back to Shopify's never
// does. Used by the Undo belt (lib/documents/undo.js); pure.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const overlayValue = (v) => (isObj(v) && v.value !== undefined ? v.value : null);
export function putsNewNameLive(next, live) {
  const a = isObj(next?.settings) ? next.settings : {};
  const b = isObj(live?.settings) ? live.settings : {};
  return GATED_FIELDS.some((f) => {
    const v = overlayValue(a[f]);
    return v != null && JSON.stringify(v) !== JSON.stringify(overlayValue(b[f]));
  });
}
