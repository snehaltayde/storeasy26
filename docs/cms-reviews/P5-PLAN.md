# Phase 5 build plan: commerce blocks (TREE-01, COM-01, COM-02, P0 only), revision 2

**Base:** `cms/phase-1` at `afd7881`. Phases 1 to 4 are done. The gate is 96 suites, all green. The one known flaky case is test:offer-form "200 new ids" (P4-CUTOVER). After P5-SOURCES merges the gate is **98** (adds test:commerce-blocks and test:bundle-form).

**Scope:** TREE-01 (bindings are a table, unknown source is an error); COM-01 (one binding and state contract, built for bundle card and bundle grid only); COM-02 (bundle card and grid sections, a bundle picker, inline create, bounded grid reads); US-28, US-33 and the bundle half of US-34, proved in a desktop Chrome drill.

**Not in scope:** offer callout, quiz, recommendations, upsell slot (their COM-01 rows ship with their own requirements), SURF-05, PV-09 rail notes, DOC-06, and any change to `lib/offers/*` (engine questions are OQ-D).

The item briefs, files and acceptance criteria are in `batches.json` (same folder). A builder sees only their brief plus this file.

## How the critics' mustFix points were answered

| # | Critic point | Answer |
|---|---|---|
| C1-1 | Duplicate variant in one bundle gets double discount | Accepted. Every bundle write (`upsertBundle`, `createBundle`) merges duplicate variantIds into one entry with the summed quantity; BundleForm adds to an existing row instead of a second row; `compatFrom` gives reason `duplicate` (state `not_ready`) for rows already stored with duplicates. Test: merged write, engine discount equals advertised saving (P5-BUNDLEREAD). The engine's per-entry counting itself is OQ-D. |
| C1-2 | Overlapping bundles: cart saving can differ from the card | Accepted. `bundlesByIds` returns `overlapsWith` (from statement 1, which also reads every enabled bundle, so still 3 statements). P5-CHECKS adds non-blocking BUNDLE_OVERLAP; the inspector status line says it; test-commerce-blocks has the overlap fixture. Deterministic engine order is OQ-D. |
| C1-3, C4-1 | Single-save edit turns a live bundle off and wipes description | Accepted, fixed in `lib/bundles.js` (P5-BUNDLEREAD, its owner): on edit, undefined `enable`, `description` and `slug` keep the stored values; an edit that breaks compat on an enabled bundle is refused 422 with no change. The route passes `enable` only when sent. BundleForm keeps Description and the draft / show-to-shoppers choice in full mode. Tests in test-commerce-exp. |
| C1-4, C2-3 | CHECKS "at most 2 statements" impossible | Accepted. BUNDLE_LINK_OFF is dropped (see C3 shouldFix), so CHECKS makes one `bundlesByIds` call: at most 3 statements, the same for 1 and 12 refs, counted after warming the schema probe. |
| C2-1 | Batch 2 breaks test-editor-inspector, which BLOCKS may not edit | Accepted. P5-SETTING (batch 1) applies the `waitingField` skip to the section-field loop too, and derives the section-kind lines of WAITING_PROBLEMS from the registry (inspectorCoverage also reports `section kind "bundle_card": setting "bundle" has no control` once the kinds register; a fixed list would fail in batch 2). P5-EDITOR removes the waiting entries. |
| C2-2 | BLOCKS missing token-usage.js / test-design-doc | Accepted: both added to P5-BLOCKS' files. |
| C2-4, C1 (should) | Drill "unknown" stage cannot be planted through the writer | Accepted. The drill asserts the draft save is refused 422, nothing stored, live home unchanged (labelled a validator regression). The runtime `source_unknown` path is proved only in test-sections (source removed after registration). The remove-then-publish path (C4-4) is proved in test-publish-checks with a named test-only plant. |
| C2-5, C3-3 | SOURCES acceptance sits in a file it does not own | Accepted. Dropped from SOURCES; it points at the existing 'every_product' case. P5-BLOCKS (owner of test-registry-contract in batch 2) adds the explicit negative: define kind, removeSource, checkRegistry names it. |
| C2-6 | Route and render tests have nowhere to run | Accepted. P5-BUNDLEREAD adds the `registerHooks` alias block and next/server shim (copied from test-cms-api.js) to test-commerce-exp. P5-SOURCES pre-registers `test:bundle-form` (SWC loader) as a placeholder, filled by P5-PANEL and extended by P5-EDITOR. PANEL no longer names test-product-editor / test-legacy-routes (they stub CommercePanels). |
| C2-7 | No buildable store-currency source | Accepted. `bundlesByIds` returns `currency` (variants.currency, then products.currency; mixed -> `not_ready`). Blocks format with the bundle's own currency. The console gets `storeCurrency()` through the API and `catalog/page.js` (added to P5-PANEL's files); console code may import lib/offers, blocks may not. |
| C3-1, C4-5 | Dropped grid cells give no preview reason | Accepted. P5-HIDDEN exports `isFounderPreview` and a `FounderNote` part; BundleGridSection renders a note per dropped cell in documents preview only. BundleListControl shows chip and status on every row. Rendered acceptance added. |
| C3-2 | Grid sold-out cell and grid BUNDLE_MISSING untested | Accepted: both added (test-commerce-blocks; test-publish-checks with removeItem for that index only). |
| C4-2 | Founder sees frozen ₹ / "component N:" strings | Accepted. `compatFrom` returns structured `reasons`; new `lib/commerce/bundle-words.js` is the only source of new wording (formatMoney + currency). Legacy `problems` stay for the getBundle snapshot only. Source and render tests forbid ₹, INR, `component N:` and `compat.problems` in new UI. |
| C4-3 | Failed inline create leaves founder stuck and duplicates | Accepted. The Dialog runs the live check and keeps Save disabled until it passes; the server's `mustPass: true` refuses and saves nothing on failure. No failed bundle is ever created, so retries never make gym-kit-2. Drill covers fail, fix, one bundle. |
| C4-4 | BINDING_INVALID message tells founder an impossible fix | Accepted. New text: "This <label> section is set up in a way the editor can't fix. Remove it and add it again." It matches the removeSection action; the bindingFailed preview note for cause `source_unknown` says the same (P5-HIDDEN). |

Rejected or narrowed:
- **C2 should: split P5-BLOCKS into data and UI.** Narrowed instead: the bundle sources move into P5-SOURCES (batch 1, tested with a fake repo), so BLOCKS keeps only declarations, DEFAULT_REPO wiring, components and tests. A real split would register kinds without components in one branch and fail checkSectionComponents and test-design-doc, breaking the gate between merges.
- **C1 should: inline create saves the bundle turned off.** Default kept as "turned on when it passes" (OQ-C), because a hidden card right after create confuses the founder; the Dialog now says plainly that the discount and `/bundles/<slug>` are live before publish, and the owner signs that off.
- **C3 should: keep handle acceptance on the legacy `bundle` / `check` actions.** Rejected: their only client is the panel, which no longer types handles. Recorded as deviation 3.10 for sign-off.

## 0. Rules for every item

### 0.1 Branches and merging
- Each item gets branch `cms/p5-<id>` in its own worktree, cut from local `cms/phase-1` (fast-forward first; worktrees from origin/main can be 92 commits stale), merged with `--no-ff`.
- **Merge order:** in batch 1, P5-SOURCES merges first (defineSection starts refusing unknown sources), then SETTING, BUNDLEREAD, HIDDEN. Batch 2: BLOCKS, CHECKS, PANEL.
- **Integration gate:** `pnpm test` runs on `cms/phase-1` after every merge. A failure is fixed on the item's own branch and re-merged before the next merge. The next batch is cut only after the previous batch has fully merged and is green.
- Batch 1 items other than SOURCES see 96 suites on their own branch; 98 after merge.

### 0.2 Shared files (one owner per batch)

| File | Batch 1 | Batch 2 | Batch 3 |
|---|---|---|---|
| package.json | SOURCES | - | - |
| lib/registry/sources.js (new) | SOURCES | - | - |
| lib/registry/index.js, lib/registry/validate.js | SOURCES | - | - |
| lib/cms/section-data.js | SOURCES | BLOCKS (DEFAULT_REPO only) | - |
| scripts/test-sections.js | SOURCES | BLOCKS | - |
| scripts/test-commerce-blocks.js | SOURCES (placeholder) | BLOCKS | - |
| scripts/test-bundle-form.js | SOURCES (placeholder) | PANEL | EDITOR |
| lib/registry/settings.js, issue-words.js, lib/documents/diff.js, lib/documents/refs.js | SETTING | - | - |
| lib/registry/fixtures.js | SETTING (isList, setting values) | BLOCKS (binding data) | - |
| scripts/test-registry-contract.js | SETTING | BLOCKS | - |
| scripts/test-editor-inspector.js | SETTING | - | EDITOR |
| scripts/test-documents.js, test-doc-diff.js | SETTING | - | - |
| lib/commerce/bundle-compat.js, bundle-words.js, bundle-read.js (new) | BUNDLEREAD | - | - |
| lib/bundles.js, lib/admin/refs.js, scripts/perf-fixture.js, scripts/test-refs.js | BUNDLEREAD | - | - |
| app/api/admin/bundles/route.js | BUNDLEREAD | PANEL | - |
| scripts/test-commerce-exp.js | BUNDLEREAD | PANEL | - |
| components/sections/index.js | HIDDEN | BLOCKS | - |
| components/sections/HomeSections.js, parts.js | HIDDEN | - | - |
| scripts/test-sections-render.js | HIDDEN | BLOCKS | - |
| lib/registry/sections.js, token-usage.js | - | BLOCKS | - |
| lib/documents/checks.js, scripts/test-publish-checks.js | - | CHECKS | - |
| components/admin/bundles/BundleForm.js | - | PANEL | EDITOR |
| components/admin/CommercePanels.js, catalog/page.js | - | PANEL | - |
| editor controls, DocumentEditor.js, editor/page.js | - | - | EDITOR |
| docs/cms-reviews/MANUAL-CHECKS.md | - | - | (DRILLS, batch 4) |
| any other suite that only lists or iterates kinds and fails once the kinds register | - | BLOCKS (named in its packet; never test-publish-checks, test-commerce-exp or test-bundle-form) | - |

### 0.3 Migrations
None. The highest tenant migration is `0025_media_archived.sql`. The `bundles` table (0011, `slug UNIQUE`), `offers`, and `document_refs` (0023, `ref_type` 'bundle' allowed) are enough. A builder who thinks they need 0026 stops and asks.

### 0.4 Legacy tenants
- `bundle_card` and `bundle_grid` live only in `lib/registry`; never in `lib/cms/registry.js`, HOME_LEGACY or HOME_SECTION_KINDS.
- `lib/cms/section-data.js` serves legacy homes too. These stay byte-identical: the a6d028e home-render fixtures, test-release-readers v1 to v4, and legacy `componentFor` declarations (singular `source`).
- The bundle page `/bundles/<slug>` and `getBundle` are unchanged.

### 0.5 Other rules
- Never write to Shopify. No new npm dependencies. Rendered tests use the existing Next SWC + react-dom/server loader, not Vitest.
- A version body never holds a price, title snapshot or stock value. A bundle reference is `{ id }` only.
- Storefront code (sources, the bundle read, section components) is edge-safe: no `node:`.
- `lib/registry/sources.js` is reached by client editor bundles through `lib/registry/index.js`: it imports only pure `lib/registry/*` modules; resolvers call the injected repo. An import scan enforces it.
- No block, source or bundle read imports anything under `lib/offers/`. Plain SQL on the `offers` table inside `bundle-read.js` is allowed. Console routes may import `lib/offers/catalog.js storeCurrency`.
- Money in new copy uses `formatMoney(amount, currency ?? undefined)` with the bundle's currency (blocks) or `storeCurrency()` (console). formatMoney defaults to INR only for `undefined`; `null` would print "null 1500.00". Never a hard-coded ₹ or INR literal (source scans). formatMoney with INR does print ₹, so rendered "no ₹" checks use a non-INR fixture currency (USD). All new bundle-state wording comes from `lib/commerce/bundle-words.js`.
- Statement counts are taken after one warm-up call (the `hasColumns` probe in `lib/schema-compat.js` is excluded).
- Each item writes `docs/cms-reviews/P5-<ID>.md` with Known limits, From review and Owner checks. Only P5-DRILLS edits MANUAL-CHECKS.md.

## 1. Key design decisions

1. **The source table (TREE-01).** Pure, edge-safe, client-safe `lib/registry/sources.js`: `name -> { args, resolve(repo, args, ctx), prefetch?(argsList, repo, ctx), argOf? }` with six sources: `featured_collections`, `newest_products`, `collection_products`, `route_product` (known, no home data, no log), `bundle_by_id`, `bundles_by_ids` (one shared prefetch, one `repo.bundlesByIds` call per page). `defineSection` normalises `source` to `sources` and throws on unknown sources; `checkRegistry` reports sources removed after registration. `run()` rejects unknown sources with code `source_unknown`; the bindingFailed path logs `section_binding_failed` with a `cause` and sets `data.bindingFailedCause`. Seams `defineSource` / `removeSource`.
2. **Bodies hold no binding.** Bindings come from the declaration with args from settings. Body-level `section.bindings` stays validate-only (BINDING_INVALID, blocks) and is checked against the table, with the new "Remove it and add it again" message. Live bodies and `documentHash` do not change.
3. **Setting kinds.** `bundle` = `{ id }`, `bundle_list` = `[{ id }]` (max 12, no duplicates). id matches `/^[A-Za-z0-9_-]{1,64}$/` (covers `bun-<hex>` and older raw ids). Any other key is UNKNOWN_FIELD (structure). A structural test proves every object-valued kind refuses price and stock keys. `refsOfSetting` -> `{ ref: 'bundle', id }`; `rowOf` -> `['bundle', id]`; link refs stay keyed by slug (known limit).
4. **One bounded, honest read.** `lib/commerce/bundle-read.js bundlesByIds(ids)`, at most 3 statements for any number of bundles:
   1. `bundles b LEFT JOIN offers o ON o.id = 'bundle-' || b.id WHERE b.id IN (…) OR b.enabled = 1` (gives the requested rows, the offer sync check, and the overlap set);
   2. `variants WHERE id IN (…)`;
   3. `effective.byIds(…)`.

   It returns `{ id, slug, title, description, bundle_price, currency, componentsSum, saving, state, reasons, overlapsWith, components[{ variantId, quantity, title, image, available, state }] }`. A database fault throws.
5. **States.** `available`; `sold_out` (a component unavailable or gone from the catalog); `no_saving`; `not_ready` (fewer than 2 components, duplicate items, bad price, mixed currency, or an enabled bundle whose `bundle-<id>` offer is missing, disabled, scheduled out, or out of sync with the row); `disabled`; `missing`.
6. **Saving, one rule.** Blocks and checks use `saving = sum > 0 && price > 0 ? Math.round(Math.max(0, sum - price)) : 0`, which equals the engine's BUNDLE discount for one set. `checkBundleCompatibility` and `getBundle` keep the legacy `Math.max(0, sum - price)` so the test-effective-read snapshot cannot change.
7. **Sections.** `bundle_card` ('Bundle card', setting 'Bundle') and `bundle_grid` ('Bundle grid', setting 'Bundles to show'), both `documentTypes: ["home"]`, `startsIncomplete: true`, with placeholders. Both reuse `BundleAddButton` with the same props the bundle page passes, and mark each component 'Sold out' / 'No longer available' as the page does.
8. **The state contract (COM-01 rows for bundle card and grid).**

   | State | Shopper | Founder in preview | Publish |
   |---|---|---|---|
   | available | shown, add on | shown | - |
   | sold_out | shown, "Currently unavailable", add off, component marked | same | BUNDLE_UNAVAILABLE |
   | no_saving | as sold_out (OQ-B) | same | BUNDLE_UNAVAILABLE (names the sum) |
   | not_ready | as sold_out | same | BUNDLE_UNAVAILABLE |
   | disabled | hidden (card) / cell dropped (grid) | note with reason (section or per cell) | BUNDLE_DISABLED |
   | missing | hidden / cell dropped | note with reason | BUNDLE_MISSING |
   | grid with nothing showable | grid hidden | note | per-entry warnings |
   | overlaps another enabled bundle | shown | inspector line | BUNDLE_OVERLAP (not removable) |
   | database fault | hidden (bindingFailed) | failed note, reload words | checks-could-not-run |
   | unknown source | hidden (bindingFailed) | "Remove it and add it again" | BINDING_INVALID blocks (body binding) |

   "Expired" and "not started" do not exist for bundles (no schedule; see 3.3).
9. **Words (final text, all in `lib/commerce/bundle-words.js`).**
   - available: "Showing to shoppers."
   - sold_out: "A product in this bundle is sold out: shoppers see Currently unavailable and can't add it."
   - no_saving: "The price no longer saves anything (the products add up to <sum>): shoppers can't add it. Lower the price in Catalog > Bundles."
   - not_ready: "This bundle isn't ready for the cart yet: shoppers can't add it. Open it in Catalog > Bundles and save it again."
   - disabled: "This bundle is turned off, so shoppers don't see it. Turn it on in Catalog > Bundles, or remove it."
   - missing: "This bundle was deleted, so shoppers don't see it. Pick another or remove it."
   - grid empty: "None of the bundles in this grid can be shown, so shoppers don't see it."
   - overlap: "Another bundle uses the same products, so the cart may give a different saving than this block shows."
   - per-component reasons: "Sold out", "No longer available", "Price must be lower than <sum>", "Pick at least two products", "This product is already in the bundle".

   "Catalog > Bundles" links to `/admin/catalog#bundles` in the editor.
10. **Publish warnings** never block. BUNDLE_MISSING, BUNDLE_DISABLED and BUNDLE_UNAVAILABLE carry removeSection (card) or removeItem for that one index (grid). The button words stay those of `publishModel.js actionLabel` ("Remove this section and publish", "Remove it and publish"), which phase 5 does not change; the warning message says what goes. BUNDLE_OVERLAP has openField only. One guarded read, and none when the document has no bundle ref; no `/bundles/<slug>` link checks in phase 5.
11. **Writes.** Duplicate items merge on write. `upsertBundle(id=null)` on a taken slug, and an edit onto another bundle's slug, give SLUG_TAKEN (never overwrite, never 5xx). Edits keep slug, description and enabled when not sent; an edit that breaks compat on an enabled bundle is refused. `createBundle` derives the slug (ASCII, fallback `bundle`, at most 61 characters including `-N`, retry on unique violation); `mustPass` saves nothing on failure.
12. **Inline create.** Name, products (VariantPicker) and price only; Save disabled until the live check passes; saved and turned on (OQ-C) with the live-now sentence; hidden without `offers.write`.

## 2. Batches

- **Batch 1 (foundation, server and pure):** P5-SOURCES (merge first), P5-SETTING, P5-BUNDLEREAD, P5-HIDDEN.
- **Batch 2 (blocks, checks, console form):** P5-BLOCKS, P5-CHECKS, P5-PANEL.
- **Batch 3 (editor):** P5-EDITOR.
- **Batch 4 (drills):** P5-DRILLS.

## 3. Where the spec is wrong against the code (deviations for owner sign-off)

1. **TREE-01:** "an unknown source silently returns collections" is stale since 6f952be; it now resolves silently to `undefined` with no log and no registry check. Evidence lines `section-data.js:21-61`, `:42` are stale.
2. **Spec 8.5:** the binding shape there (body-level `bindings: { source, args:{…} }`, declarations with `required`) does not match the code (`{ sources, args: [settingKeys] }`; body bindings validated, never read). Phase 5 keeps the code's shape; "binds by id" is a setting of kind `bundle`.
3. **COM-01:** the bundle row's "not started" and "expired" cannot happen (no `starts_at` / `ends_at` on bundles or their synced offer, hard delete). Phase 5 tests disabled and missing and records the others as not applicable.
4. **US-34:** "my offer ends" needs the offer callout (COM-04, P1). Only the bundle half ships.
5. **COM-02 "any composable page":** page, campaign and journal resolve no bindings and drop non-PAGE_LEGACY kinds (P4-ED05, DOC-06). P0 bundle kinds are home only; SURF-05 and DOC-06 bring them to pages.
6. **COM-02 "the slug is derived":** unsafe with today's overwrite-by-slug; fixed first (SLUG_TAKEN).
7. **Spec 8.15 Vitest:** the repo renders with Next SWC + react-dom/server in node suites; no dependency added.
8. **Test table "callout matches engine":** not applicable at P0.
9. **"unknown source fails the registry test":** the explicit negative lands in test-registry-contract via P5-BLOCKS (its batch-2 owner); test-sections carries the seam tests.
10. **Spec 8.15 "cart, offers and bundles must not change":** phase 5 changes bundle behaviour on purpose: SLUG_TAKEN instead of overwrite; handles refused on the bundle API; edits keep enabled and description; duplicate items merged on write; an edit that breaks compat on an enabled bundle is refused. Each is listed for sign-off.
11. **`/bundles/<slug>` links:** keyed by slug in `document_refs` and not checked at publish (BUNDLE_LINK_OFF dropped; links are not COM-01 bindings).

## 4. Owner checks (P5-DRILLS adds these to MANUAL-CHECKS)

- **Prerequisite:** phase 5 deployed to staging and a documents-mode tenant there (a new tenant, or an owner-run cutover).
- Phone widths (375 and 768) and Safari for bundle card and bundle grid, including the per-cell preview notes.
- One real test order through a bundle block on staging, to snehal@mediastic.in, then cancelled; confirm the bundle discount line on the order pushed to Shopify.
- Sign-off for deviations 3.5 (home only), 3.10 (bundle behaviour changes), 3.11 (slug-keyed links, unchecked), 3.3 (no expired state).
- Bundles are not versioned: an edit or turn-off in Catalog > Bundles changes every live home card at once, with no publish.
- Inline create turns the bundle on immediately: its discount and `/bundles/<slug>` are live before publish, and stay if the draft is discarded (OQ-C).
- An exclusive coupon (combinable: false) suppresses the BUNDLE saving the card shows; the cart does not explain why.
- Stock depth: a component with quantity 2 and one unit left shows as available (same as the bundle page today).
- Existing bundles stored with duplicate items show "not ready" until re-saved; overlapping bundles may give a different cart saving (OQ-D).
- A decision on BundleAddButton's non-atomic add (unchanged).

## 5. Known limits carried into the packets

- getBundle and the bundle page do not check the offer sync (`not_ready`); only blocks and checks do.
- `/bundles/<slug>` link refs: keyed by slug, unchecked.
- Product rail still hides silently in preview (PV-09, P1).
- A bundle the founder cannot list (403) can be removed but not replaced in the inspector.
- Bundle currency is null when no variant or product has one; callers pass `currency ?? undefined`, so formatMoney uses its own INR default (the same as Price.js and the bundle page today).

## 6. Open questions (each with the default the build uses)

- **OQ-A:** who may list and create bundles in the editor. Default: listing needs `storefront.read`; inline create needs `offers.write`.
- **OQ-B:** a bundle whose price no longer saves. Default: shown as "Currently unavailable", add off (not hidden).
- **OQ-C:** inline create turns the bundle on at once when it passes. Default: yes, with the live-now sentence; the alternative is saved off with a "Turn it on" action.
- **OQ-D:** engine changes outside the blocks: count bundle sets per merged variant (fixes the duplicate-entry double discount for old rows) and a deterministic BUNDLE offer order (for example `ORDER BY id`). Default: not in phase 5; phase 5 prevents new duplicates, flags old ones as `not_ready`, and warns on overlap.
- **OQ-E:** home only for P0 bundle kinds. Default: yes.
- **OQ-F:** refuse handles on the legacy `bundle` and `check` API actions. Default: yes.
- **OQ-G:** BundleAddButton's non-atomic add. Default: unchanged.
- **OQ-H:** new dependencies. Default: none are needed.
