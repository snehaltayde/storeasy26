// P4-LIVEROW (OVL-01, OVL-05, OVL-17; phase 4 plan decision 1): may a founder
// give a product a new name (title, display_type, display_vendor) yet?
// Edge-safe: no node: imports, no database.
//
//   titleGate() -> { blocked, cause: "typesense" | "readers" | null, reason }
//
// Blocked while either holds:
//   (a) Typesense would still serve Shopify's names: typesenseConfigured() and
//       a products collection for the current tenant. That includes _default,
//       which uses the env collection (lib/typesense-search.js). P4-SEARCH
//       removes this condition once its minimal OVL-17 reindex ships (owner
//       answer OQ-1 (b)).
//   (b) TITLE_READERS_READY is false: not every console reader and the
//       Typesense builder use effective values yet. P4-SEARCH flips it.
//
// How it is used (lib/documents/service.js, publish.js):
//   - a SAVE that sets a new title, display_type or display_vendor is refused
//     with TITLE_GATE_MESSAGE, so a draft never holds a name that can't go
//     live. Clearing them (null, "Use Shopify's") is never gated;
//   - publish checks again (a belt): it can only fire for a name saved
//     before the gate turned on, and names the product (titleBeltMessage).
//   Badge, modules, pairs, gallery, description and template are never gated.
//
// Test seam: setTitleGateForTest(state) forces the gate in unit tests
// (true / "blocked" / { blocked: true, cause } closes it, false / "open"
// opens it, null goes back to the real conditions). Never used outside tests.
import { typesenseConfigured, productsCollection } from "../typesense-search.js";

export const TITLE_READERS_READY = false;

export const GATED_FIELDS = Object.freeze(["title", "display_type", "display_vendor"]);

export const TITLE_GATE_MESSAGE = "Search on your store still shows Shopify's product names, so a new name can't be saved yet.";

export const titleBeltMessage = (name) =>
  `The new name for ${name} can't go live yet, because search on your store still shows Shopify's names. Reset the name or leave this product out of this publish.`;

let forced = null;

export function setTitleGateForTest(state) {
  if (state == null) forced = null;
  else if (state === true || state === "blocked") forced = { blocked: true, cause: "test" };
  else if (state === false || state === "open") forced = { blocked: false, cause: null };
  else if (typeof state === "object") forced = { blocked: !!state.blocked, cause: state.blocked ? state.cause || "test" : null };
  else throw new TypeError("setTitleGateForTest: true, false, 'blocked', 'open', { blocked } or null");
}

export function titleGate() {
  if (forced) return { blocked: forced.blocked, cause: forced.cause, reason: forced.blocked ? TITLE_GATE_MESSAGE : null };
  let searchServes = false;
  try {
    searchServes = typesenseConfigured() && Boolean(productsCollection());
  } catch {
    // no tenant context to read: assume search may serve the old names
    searchServes = typesenseConfigured();
  }
  if (searchServes) return { blocked: true, cause: "typesense", reason: TITLE_GATE_MESSAGE };
  if (!TITLE_READERS_READY) return { blocked: true, cause: "readers", reason: TITLE_GATE_MESSAGE };
  return { blocked: false, cause: null, reason: null };
}
