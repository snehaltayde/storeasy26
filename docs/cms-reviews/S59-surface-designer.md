# S59 — Surface designer: PDP + collection paths (audit slice 3)

Scope: extend the visual workflow beyond the home page. The audit's slice-3
target is "editor shell plus a full home and PDP path, then collection path".
Home shipped in S54/55; this item adds the product-page and collection-page
designers in real entity context.

## What was built

- Routes: /admin/storefront/designer/product and …/designer/collection
  (same guard + load pattern as the home designer), with a shared surface
  tab strip (components/admin/cms/DesignerTabs.js) now rendered on all three
  designer routes.
- components/admin/cms/SurfaceDesigner.js (one component, surface prop):
  - Context: pick a REAL product/collection (RefPicker single); the choice
    persists per tab (sessionStorage, try/catch, pure convenience).
  - Preview: the same cookie-gated saved-draft preview as the home designer,
    deep-linked at /products/<handle> or /collections/<handle> via
    startPreview(to), with device widths, refresh, open-in-tab, and the
    PreviewBridge handshake. [data-sec] regions were added to the storefront
    for click-to-jump: pdp-modules + pdp-pairs (components/pdp/PdpLayouts.js)
    and collection-products (both collection template variants). Clicking a
    region scrolls to and flashes the matching inspector card.
  - Template card: shows the EFFECTIVE template and why ("assigned to this
    product" / "your store default" / "the platform default" — S57's
    effectiveSurfaceTemplate), and assigns/clears the per-entity exception
    with a select that saves immediately as a draft (CAS on the
    surface_templates revision, ConflictBanner on 409, preview refresh after
    save since the template changes the previewed page). Store defaults
    link to Theme → Page templates.
  - PDP "Modules & badge" card: this product's catalog presentation override
    (same fields and API as Catalog → Presentation: GET/POST
    /api/admin/catalog), honest draft toast, preview refresh on save.
  - Pointer cards for what other editors own: store-wide accordions
    (Product pages), "Pairs well with" (Upsells), pinned order (Catalog),
    /collections curation (Home page editor) — stated, not duplicated.

## Verification

- `pnpm build` ✓ (both new routes compile); security gate 13/13 (the client
  component imports only pure lib/cms/defaults).
- All CMS suites re-run green earlier this session; this slice adds NO new
  server logic — every save path (surface_templates saveBlock CAS, catalog
  override POST) is an existing, suite-covered API.
- Browser drill: DONE (2026-11-01, design harness, temporary Node-runtime
  flip reverted after). Product designer: picked Radiance Glow Serum →
  preview rendered /products/glow-serum with the handshake label; Template
  card read "Renders Classic — two columns — the platform default"; picking
  Editorial saved as a draft, flipped the badge to "Assigned", updated the
  reason to "assigned to this product" and auto-refreshed the preview to
  data-pdp-template="editorial". Modules card: added a module + badge, Save
  → preview rendered the new accordion inside [data-sec="pdp-modules"];
  clicking that region in the frame selected it (bridge outline) AND
  scrolled/flashed the matching card (click-to-jump). Collection designer:
  picked Bestsellers → preview rendered with [data-sec="collection-products"];
  assigning Sidebar re-rendered data-collection-template="sidebar". All
  drill drafts reset afterwards (surface_templates reset, override cleared).
- An earlier attempt to verify against the running :3007 via the demo tenant
  was stopped at the credential step (password rotation is the user's call)
  — no tenant credentials were changed.

## Boundaries / follow-ups

- The PDP/collection designers assign templates and per-product presentation;
  they do NOT yet compose arbitrary sections on those surfaces (the audit's
  full section model for non-home families is a later slice, after the
  home-family model proves out).
- Next roadmap item: live unsaved-edit preview (Designer currently previews
  the last SAVE).
