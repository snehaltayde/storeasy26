# S57 — Explicit per-entity template assignment (audit slice 3, step 2 of the precedence ladder)

Scope: the audit's assignment precedence is **explicit entity assignment →
highest-ranked matching rule → tenant page-family default → theme default**,
with the instruction to "initially implement explicit assignment and family
defaults; add rules after that path is reliable" and to "reject equal-priority
matches instead of choosing unpredictably". S56 shipped family defaults; this
item ships EXPLICIT per-entity assignment. Ranked rules remain a later slice —
with only explicit (a map keyed by entity id) and family levels there are no
equal-priority matches to reject yet; the map key structurally admits one
assignment per entity.

## What changed

- lib/cms/defaults.js: `SURFACE_ENTITY_KEYS` ({pdp: "products", collection:
  "collections"}) and the PURE `effectiveSurfaceTemplate(value, surface,
  entityId)` → `{template, source: "entity"|"family"|"platform"}`. One
  resolver for drafts and live snapshots; `source` exists so editors can
  explain WHY a template was selected (audit requirement).
- lib/cms/validate.js surface_templates: optional `products` / `collections`
  maps of entity id → template. Picks must be valid for THEIR surface; ≤200
  entries per map; blank keys dropped; empty maps normalize away. An entry
  equal to the family default is KEPT — an explicit pin must survive a later
  family-default change (that is what pinning means).
- lib/content/resolve.js: `resolvedSurfaceTemplateFor(surface, entityId)` —
  draft mode reads the table, live mode reads the frozen snapshot block, both
  through effectiveSurfaceTemplate. Entity assignments therefore publish,
  schedule, and roll back with releases automatically (the block was already
  in snapshots); `resolvedSurfaceTemplates` stays for family-level callers.
- Storefront: products/[handle] resolves with `("pdp", product.id)`,
  collections/[handle] with `("collection", collection.id)`. References are
  catalog IDs (not handles) — consistent with pins/overrides and forward-
  compatible with the recorded handle→ID migration.
- components/admin/cms/SurfaceTemplatesCard.js: each surface gains an
  "exceptions" list — add via ProductPicker/CollectionPicker (multi), per-row
  template Select + Remove, titles hydrated through /api/admin/refs with ids
  the catalog no longer has shown as "Missing from catalog" (never silently
  dropped). New rows start at the family value (an explicit pin of today's
  look). Family picks still store only when non-default; exceptions always
  store. Same CAS save + ConflictBanner + dirty guard as before.
- components/admin/cms/RefPicker.js: `fetchRefs` exported for the card's row
  hydration.
- lib/cms/view.js: the editor view's `blocks` now carries the RAW stored
  `surface_templates` value (the omission was an S56 gap of exactly the class
  the file's own header warns about; revisions/customized already covered it
  via BLOCK_KEYS).

## Verification

- scripts/test-sections.js 13/13 (new: entity-map validation incl. cross-
  surface pick rejection + shape rejection + normalization; precedence
  entity→family→platform incl. junk stored picks ignored and null entityId).
- Suites re-run green: cms-api 17, cms 11, content 19, releases 24,
  storefront 15, surfaces 15, admin-console 9, security 13. `pnpm build` ✓.
- Browser (design harness :3017, console routes): Theme → Page templates →
  "Add product exceptions…" opened the ProductPicker, confirming a product
  rendered the exception row with its hydrated title and per-row Select;
  pinning Editorial and saving stored exactly
  `{"products":{"gid://p/3":"editorial"}}` at revision 1 (checked in the
  tenant DB), with family keys correctly absent. Draft reset after the drill.
- NOT browser-verified: the storefront PDP/collection render of an entity
  assignment (the harness storefront runs the edge runtime, which 500s on
  file DBs by design). The render path is the same `template` prop the S57
  browser drill proved for family flips; entity resolution above it is
  covered by the pure-helper tests. Staging/production: UNVERIFIED.

## Next bounded items

1. Surface the "why" in entity editors (Catalog product page / collection
   screens showing "Editorial — assigned to this product" with a jump to the
   Theme card), per the audit's explain-the-reason requirement.
2. Ranked assignment RULES (e.g. by collection membership) with explicit
   ambiguity rejection — only after explicit assignment proves reliable.
3. Designer surfaces for PDP/collection; live unsaved-edit preview;
   handle→ID reference migration (collections_index et al).
