# S58 — Handle→ID reference migration (rename-proof collection curation)

Scope: the audit's reference model wants catalog references by ID ("Collection
reference"; "map legacy ... handle references" additively). After S53-B2 the
two remaining handle-only stores were `collections_index` (featured/order/
hide) and `home_sections` product_rail (`collection`). A Shopify handle
rename silently orphaned both.

## Design: additive id sidecar + render-time healing

Stored values KEEP the human/URL handle as the canonical wire format — every
existing consumer, snapshot and release stays byte-compatible — and picker
saves now also record the catalog ID:

- product_rail gains optional `collection_id`.
- collections_index gains an optional `ids` sidecar: `{handle-at-save: id}`,
  validation keeping only entries whose handle is actually in a list.

At RENDER time (`lib/cms/store.js`): `healHomeSections` / `healCollectionsIndex`
look up the ids' CURRENT handles (one `collections` query, best-effort — a
lookup failure just renders the stored handles) and substitute them. So:

- Rename in Shopify → next sync updates the catalog → rails and curated
  lists follow automatically, draft AND live (live snapshots stay immutable;
  the catalog was never release-owned, so healing against the current
  catalog is the correct reading of an old snapshot).
- Deleted collection → id lookup misses → stored handle is the fallback,
  which then renders nothing, exactly as an orphaned handle does today.
- Hand-typed handles carry no id (and typing in the Designer CLEARS a
  recorded id — a stale id must never override a deliberate handle).

Wiring: `getHomeSections` + `resolvedHomeSections` (live), and
`getCollectionsIndex` + `resolvedCollectionsIndex` (live) heal; the ids
sidecar never reaches renderers. Editors read RAW values — new
`getCollectionsIndexRaw` feeds the view (editors must show what is stored),
`getHomeSectionsRaw` already did. Pickers record ids: Designer's collection
control (`onCollectionPick` writes `<key>_id`) and HomeEditor's curated-list
picker (`addHandle(list, handle, id)`); manual adds record none.

## Files

lib/repo.js (getCollectionHandlesByIds), lib/cms/validate.js,
lib/cms/store.js, lib/content/resolve.js, lib/cms/view.js,
components/admin/cms/Designer.js, components/admin/cms/HomeEditor.js,
scripts/test-sections.js.

## Verification

- scripts/test-sections.js 15/15 — new: id round-trip + hand-clear drop +
  ids filtering; rename heals rail + index (and dedupes), ids never reach
  renderers, raw editor view keeps stored handle + sidecar, deletion falls
  back to the stored handle.
- Suites green: cms 11, cms-api 17, content 19, releases 24, storefront 15,
  surfaces 15, admin-console 9, security 13. `pnpm build` ✓.
- NOT browser-verified this slice (the mechanism is pure server-side read
  path; the Designer/HomeEditor picker changes reuse the exact pick handlers
  drilled in S57). Staging/production: UNVERIFIED.

## Boundaries / follow-ups

- Product references (pins, upsells, overrides, template exceptions) were
  already ID-based; nothing to migrate there.
- Existing stored content gets ids only when next touched through a picker —
  deliberate: no bulk rewrite of merchant drafts without an actor. A later
  backfill (resolve current handles → ids at sync) can be offered as an
  explicit console action if wanted.
- Next roadmap item: Designer surfaces for PDP/collection pages.
