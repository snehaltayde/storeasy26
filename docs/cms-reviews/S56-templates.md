# S56 review packet — PDP + collection template variants (audit slices 3/4 continuation)

**Work item:** the audit's "multiple templates should mean materially
different layouts" for the two core commerce surfaces, via family-default
assignment (explicit per-entity assignment stays future work, per the
audit's own precedence ordering).

## What was built
- **`surface_templates` block** (joined BLOCK_KEYS → automatically
  release-governed, snapshotted, diffed as "Page templates" linking to
  Theme): `{pdp: classic|editorial, collection: standard|sidebar}`, null =
  platform defaults = today's layouts byte-identical. Validation rejects
  unknown choices; default-only picks normalize to null (never falsely
  "customized").
- **PDP variants** (components/pdp/PdpLayouts.js): `classic` is the
  original two-column layout moved VERBATIM; `editorial` is a genuinely
  different composition — full-bleed lead image, centered story header,
  narrative column with details/accordions/secondary gallery, and a STICKY
  buy panel. Both render the SAME ProductPurchase / ProductGallery /
  WishlistButton — commerce behavior (variants, price, availability,
  add-to-cart, JSON-LD, tracking) never forks per template.
- **Collection variants**: `standard` keeps the filter bar; `sidebar` moves
  the SAME link-based facet chips, in-stock toggle, sort controls and
  clear-all into a sticky left rail on desktop (every filter state still a
  URL; mobile stacks). Grid, pagination, empty states shared.
- **Picker**: Theme → "Page templates" card (SurfaceTemplatesCard) — two
  selects with honest descriptions, draft-saved with CAS + the shared
  conflict UX, Customized/Unsaved badges, "publish from Publishing" copy.

## E2E context from this session (same run)
The pavos COD drill that preceded this found and fixed a cross-brand bug
(checkout wordmark hardcoded BEASTLIFE → tenant logo, b23e52f); order
PAV-A5706EA0 went cod_pending → synced into the real Pavos Shopify in 6s
and was cancelled/restocked per test-order hygiene.

## Verification (exact commands, local)
- `pnpm test:sections` → **11** (+1: choice validation, null semantics,
  default merge, reset). Suite set green: cms 11 · cms-api 17 · releases 24
  · content 19 · storefront 15 · surfaces 15 · themes 10 · security 13.
  (`test:cms-api` showed one transient 16/1 during a batched run — not
  reproducible across 5 isolated runs; recorded as a flake to watch.)
- **Live render proof** on pavos (pre-first-publish, drafts serve): setting
  the block flipped `data-pdp-template="editorial"` and
  `data-collection-template="sidebar"` in served HTML; deleting it restored
  classic/standard. Reverted after. `pnpm build` compiles.

## Honestly NOT done
Per-entity template assignment + ranked rules; home template families
beyond the section system; collections-index/campaign/journal layout
variants; template previews in the picker (text descriptions only);
designer-surface integration for PDP/collection (the designer remains
home-only).
