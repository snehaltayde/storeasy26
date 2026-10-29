// S53 (0B-2): pure snapshot-selection helpers for the presentation sets a v2
// release freezes (product overrides, collection pins, placements, slug
// redirects). Node-safe on purpose — lib/content/resolve.js (which knows the
// request's draft/live/preview mode) wraps these, and the release suite
// exercises them directly. A v1 snapshot returns `null` = "this release never
// froze that set; fall back to the live tables" (the pre-S53 behavior those
// releases were reviewed under).

const isV2 = (content) => (content?.v ?? 1) >= 2;

export function presentationProductOverride(content, productId) {
  if (!isV2(content)) return null;
  const row = (content.product_overrides || []).find((r) => r.product_id === productId);
  return { found: row ? { modules: row.modules || [], badge: row.badge || "" } : { modules: [], badge: "" } };
}

export function presentationCollectionPins(content, collectionId) {
  if (!isV2(content)) return null;
  const row = (content.collection_pins || []).find((r) => r.collection_id === collectionId);
  return { found: row ? row.pinned || [] : [] };
}

export function presentationPlacements(content, kind) {
  if (!isV2(content)) return null;
  return (content.placements || [])
    .filter((p) => p.kind === kind && p.enabled !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export function presentationSlugRedirect(content, slug) {
  if (!isV2(content)) return null;
  const row = (content.redirects || []).find((r) => r.from_slug === slug);
  return { found: row ? row.to_slug : null };
}
