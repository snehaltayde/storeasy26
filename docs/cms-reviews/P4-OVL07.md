# P4 · OVL07 · Product and collection content on the shopper side, draft preview per page, and the entity half of the data check

Branch `cms/p4-ovl07`, cut from `509bf57` (`cms/phase-1` with phase 4 batches 0 to 2 merged). Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 3, 8 and 14; section 2; section 3; batch 3) and `P4-BATCHES.json`. Requirements: OVL-07, OVL-02, ED-12, PV-03, MIG-02.

Migrations owned: none. Not touched: `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `lib/content/legacy-release.js`, `scripts/drills/p3/*`, `package.json`, `MANUAL-CHECKS.md`, anything under `.github/`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No store changed mode; nothing ran against a hosted or real store; `--hosted` was never passed; nothing was sent to Typesense or Shopify.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 181.8 s (sqld suites pinned to ports 7120 to 7126). `test:entity-content` 14 passed (1.3 s); `test:preview-overlay` 33 (1.3 s); `test:release-readers` 47 (2.4 s); `test:content-seam` 20 (0.6 s); `test:effective-read` 41 (2.8 s); `test:migrate-map` 47 (13.7 s). `pnpm build` passes (one existing warning about the edge runtime on `/api/errors`) |
| Browser verified | Yes, desktop Chrome 156 (headless, the repo's `launchChrome`) at 1440 px, on the design harness (`DESIGN_PORT=6120`, `DESIGN_SQLD_PORT=7120`, `next dev`, storefront on the edge runtime), the phase 3 documents store re-seeded fresh: 20 passed, 0 failed. Details below. Not Safari, not a phone |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

Until now a documents store could publish product and collection content (P4-LIVEROW) but no shopper page read it: the v4 reader gave neutral empties for modules, badge, pairs, pins and per-entity templates (P2 plan decision 9). The founder had no way to see an unpublished product edit on its page, and the MIG-02 data check skipped every per-product and per-collection answer, so a cutover could not prove those would look the same. MAPPER's entity mapper was a stub, so the dry run refused any store with product extras.

This item:

1. makes the v4 reader serve each product's and collection's live row;
2. lets a founder's documents preview show a product's or collection's draft on its own page;
3. maps the legacy product overrides, pairs, pins and per-entity templates to documents and live rows;
4. adds the entity half of the data check.

## Design

### (1) The v4 reader uses the live rows (`lib/content/resolve.js`, `lib/catalog/effective.js`, `lib/cms/section-data.js`)

- `entityRow(src, kind, id)`: for a v4 source only. A closed store has none and reads nothing. A source carrying `entityRows` (a MIG-02 candidate's rows) is read from its maps only; an id not in the map has no row. Otherwise the live tables, through the new `contentRowFor(productId)` / `collectionRowFor(collectionId)` in `effective.js`: one statement per entity per request (React `cache`, keyed by the database instance and the id), only the entity columns, `null` on a tenant before 0024, any other error thrown (the page fails closed rather than show a product without its published content).
- `resolvedProductOverride`: `{modules, badge}` from the row (`[]` and `""` with none, as before).
- `resolvedPdpPairs`: the row's pairs become the one hand-picked placement handed to `getPdpPairs` (title, products), so the legacy semantics hold: the in-stock picks up to the limit, else the automatic same-collection strip. The placements table is never read.
- `resolvedSurfaceTemplateFor('pdp' | 'collection', id)`: the row's `layout_template` when it is a template the page offers, else the family default (`doc_product_layout` / `doc_collection_layout`), else the platform's. A `layout_template` that is not offered any more renders the default and logs `entity_template_unavailable` (surface, entity, value); the shopper sees nothing of it.
- `resolvedCollectionPins(handle)`: the collection's id from its handle (a catalog read, as the v2 path does), then the row's `pinned`.
- Home rails (`section-data.js`): on a documents store each rail uses the published pins, read for every rail in one statement (`effective.js` `livePinsByHandles`); a collection with none keeps its own order, and `handPicked` says whether pins applied. A repo without that function (tests' fakes) gives no pins, as before.
- `candidateSource` now defaults `entityRows` to `null`: no rows of its own, so the entity getters read the live tables (the check after a backfill). Passed rows are kept as given.
- `legacy-release.js` is untouched, and v1, v2, v3 and draft sources never read the entity live tables.

### (2) Draft preview per page, no heartbeat (PV-03, plan decision 14)

- `previewEntityRow(type, entityId)` (`resolve.js`): only when `contentSource()` is a documents preview (a session token whose `preview_sessions` row counts, already checked there). It reads that entity's document (`documents-reader.js` `readEntityDraft`, by `(type, entity_id)`, not archived), runs the draft through `previewDraftBody` (the same tolerant check as other previews) and returns the row that draft would publish (`liveRowFor`). Anything else is `null`. A read failure is logged and gives `null` (the live page).
- The product page (`productFor`): with a draft row, the product is read again with `effective.js` `productPage(handle, { overlay })`: Shopify's values with the draft row applied by the same rules as the live join, as if that draft were live. So a field the draft sends back to Shopify shows Shopify's value, not the old published one. The modules and badge, the pairs and the template come from `productPreviewView`, which runs the same getters over the request's source with the draft row injected. `generateMetadata` uses the same product, so the tab title previews too.
- The collection page: `collectionPreviewView` gives the draft's pins and template.
- `product_content` and `collection_content` stay in `NOT_OVERLAID`: the list overlay, the cart, search, the sitemap and the home rails never see a draft, in a preview or not. `lib/preview-sessions.js` is not edited and no column was added.
- **Deviation from spec 8.9** ("only when open in the editor"): any valid documents preview session shows the draft, one page at a time (plan section 2 and decision 14).

### (3) The entity mapper (`lib/migrate/map-entities.js`, replaces MAPPER's stub)

- Sides, read as shoppers read them today. The drafts are the live tables (`cms_blocks` for the templates). The published side follows the state: a v2 or v3 release's frozen arrays and its `surface_templates` block; a v1 release's live tables (v1 never froze them) and its own `surface_templates` block; the drafts for a store open with no release; nothing for a store not launched or refused.
- `product_overrides` modules become `rich_text` sections `{title, html}` (`sec_m<i>`, in order). The html goes through today's sanitizer (the one a save uses), so HTML stored before sanitizing at save shows as a difference in the data check. Nothing is cut: a 7th module, long titles and long text are carried, with the editor's inherited notes (`MODULES_OVER_LIMIT`, `MODULE_OVER_LIMIT`). The badge goes to `settings.badge`.
- `pdp_pairs`: the first ENABLED placement by position per source product (`lib/cms/placements.js` `getPdpPairs`) becomes `settings.pairs {title, products}`. A switched-off placement is never published, and later placements of the same product never showed. Both are left out and reported (`notes`, and counted in the holdings).
- `surface_templates.products` / `.collections` become `settings.template` when the value is a layout the page offers (another value never showed: noted). `collection_overrides.pinned` becomes `collection_content.settings.pinned`.
- Ids: an existing `(type, entity_id)` row's id (a phase-3 random id is reused, `reused: true`), else `productDocumentId` / `collectionDocumentId`. Versions are content-addressed (`migratedVersion`), so mapping twice gives the same output.
- Live rows: `liveRowFor(type, body, { documentId, versionId, publishedAt, entityId })`, the function publish uses, so title, description, image, seo and display columns stay null. `published_at` is the live release's.
- `built: true`, so map.js no longer refuses a store for its entity content.

### (4) The entity half of the MIG-02 data check (`lib/migrate/check.js`)

- `entityRoutesFor(mapped)`: for EVERY product and collection with content on either side (the legacy tables, the release's frozen arrays and templates, the mapped documents and live rows, and any row already in the live tables): `resolvedProductOverride`, `resolvedPdpPairs` at the page's limit and at 12, `resolvedSurfaceTemplateFor('pdp')`, `resolvedCollectionPins(handle)` (handle from the catalog) and `resolvedSurfaceTemplateFor('collection')`.
- `dataCheck(mapped, { routes, entities })` always adds those routes. `entities: "mapped"` (default, the dry run) hands the candidate `mapped.liveRows`; `entities: "live"` hands it none, so it reads `product_content_live` and `collection_content_live` back (after a backfill, before the flip). Nothing is skipped any more (`skipped: 0`, `entityRoutes` counts them).
- Rule 7 of the comparison: `resolvedProductOverride` is compared on each module's title and html, in order, and the badge (what the page reads). A v1 or draft store answers the table row (with `product_id`, `updated_at`) or `null`. Module HTML is compared exactly.

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | For each entity fixture (v1, v2, v3, disabled placement, two placements on one source, 6 modules, re-sanitized HTML), mapping then reading through candidateSource gives the same modules (in order, then pdp_extras), badge, pairs title and products, product template, collection pins and template as the legacy outputs, or the check reports the exact difference | **DONE** | `test-entity-content` section 1: on `live_v1`, `live_v2`, `live_v3` and `no_release_open`, 8 products and 2 collections compared view by view (accordions = modules then `pdp_extras`, badge, pairs title, source and products at 4 and 12, template, pins), plus `dataCheck` with no entity difference. Section 2: the switched-off and two-placement cases, 6 modules in order and the 10,000-character module kept, and the re-sanitized fixture: exactly one difference, `resolvedProductOverride(204)`, legacy the stored HTML, candidate the sanitized HTML, same badge. Fails without the change: at base (old `resolve.js`) 7 of 14 fail; mutations: last placement wins (7 fail), switched-off published (7), no sanitizing (1), no entity routes (6) |
| 2 | The entity data check reads back from product_content_live when entityRows are absent (rows written to a file tenant, no flip) and finds a planted mismatch | **DONE** | `test-entity-content` section 4: the mapped rows written with `liveRowStatement` on a v3 file tenant still in legacy mode; `entities: "live"` finds nothing, then a planted badge and planted pins give exactly those two differences; `"mapped"` does not see them; a stray row for another product is found once the source is re-read; the legacy store's shoppers still see the frozen answers. Mutation "live mode ignored" fails it |
| 3 | A v1 release still reads product_overrides, collection_overrides and placements live; the a6d028e baseline in test-release-readers stays green | **DONE** | `test-release-readers` "P4-OVL07: a v1 release still reads…": with entity rows present, the answers come from the tables, each of the three tables is read, no entity live read. The a6d028e test passes unchanged. Mutation (the legacy path reads the row) fails it. A negative: it also holds at base |
| 4 | On a legacy tenant (v3 live) with product_content_live modules/pairs rows present, shoppers see none of those rows | **DONE** | `test-release-readers` "P4-OVL07: on a legacy store (v3 live, and drafts)…": v3 answers stay the frozen empties, drafts read the tables, no entity live read on either, and the legacy home rail reads `collection_overrides`. Same mutation fails it; a negative, it also holds at base |
| 5 | A product draft shows on its product page only for a valid documents preview session; a cookie-less request sees the live row; cart and search ignore the draft even in preview | **DONE** | `test-preview-overlay` section 10, the real product and collection pages compiled with Next's SWC: the draft's name (h1 and meta title), badge, module, pairs and layout show with a session; no cookie, a tampered token and a revoked session see the live row; in the same preview request the cart line and SQL search show the live name; a collection draft's pins and layout likewise; a legacy store's preview never shows one. Fails at base (6 of 33); mutations: no preview row (3 fail), no session check (4 fail). Also the browser drill |
| 6 | A layout_template that is no longer live renders the default layout without a shopper-visible error and logs | **DONE** | `test-preview-overlay` "a layout_template that is no longer offered…": `magazine` renders classic, no error words, one `entity_template_unavailable` line; the family default (editorial) still applies. Mutation (keep the unknown value) fails it. Also the browser drill |
| 7 | A candidate with no doc_home never reads the live store; a pairs limit below the pair count is honoured | **DONE** | `test-content-seam` "a candidate with no doc_home (null)…" (vgl live on v3: the candidate's home is the code default, never v3's sections; SEAM's mutation M16 fails it) and "resolvedPdpPairs through contentGettersFor honours a limit…" (limit 1 of 2; fails at base). `test-release-readers` v4 case also checks limit 1 |
| 8 | Quiz scoring ignores a colliding display type; the rendered search box shows display_type | **DONE** | `test-effective-read` "quiz scoring ignores a display type that collides with a quiz tag…" (adding `display_type` to the scoring tags fails it) and "the rendered header search box shows each hit's display_type…" (`components/SearchBox.js` compiled and rendered with its state stubbed; reverting it to `r.product_type` fails it) |

### Browser drill (design harness, edge runtime)

Script and results are in this item's scratch folder, not committed (`scripts/drills/p4/*` belongs to HARNESS and DRILLS). It uses the phase 3 drill helpers (`runDrill`, `reseed`, `login`, `docsApi`). Store: the phase 3 documents store, re-seeded fresh. Product `whey-protein-isolate-1`, collection `shop-all`.

- Through the real documents API: open the product's content, save a badge, a module and a pair, publish, then save a newer draft (another badge, module and pair, layout editorial).
- A shopper's page shows the published badge, module and pairs in the classic layout, and no draft words.
- In a preview made through `/api/admin/preview-session`, the same page shows the draft's badge, module and pairs, without the published ones, in the editorial layout. Search in the same preview shows the live product. A shopper reloading during the preview still sees the live row.
- Collection: published pins, then a draft with other pins and the sidebar layout. The shopper sees the published pin first in the standard layout; the preview sees the draft pin first in the sidebar layout.
- With `layout_template` set to `magazine` in the tables, the shopper's page answers 200 in the classic layout, with no error words and no page error.

20 passed, 0 failed. The harness was stopped by the runner; ports 6120 and 7120 to 7122 were free afterwards.

## Tests

- `scripts/test-entity-content.js` (replaces SCAFFOLD's placeholder; no `package.json` change): 14 tests, file databases from P4-FIXTURES' builders.
- `scripts/test-preview-overlay.js`: section 10 (6 tests); the section 7 wording now says the pages do the per-page preview.
- `scripts/test-release-readers.js`: 3 tests (v4 live rows with statement counts and the home rail; v1; v3 and drafts). P4-GUARD's `asLegacy` helper is kept.
- `scripts/test-content-seam.js`: the `entityRows` default, the doc_home-null candidate, the pairs limit.
- `scripts/test-effective-read.js`: the page stubs for the new imports, the variable-held table name in the guard (3 plants and a negative), quiz collision, the rendered search box.
- `scripts/test-migrate-map.js` (one fixture line; see Known limits).
- Hand mutations (each reverted, listed under the acceptance rows). All bit.

## Known limits

- **One file beyond the plan's list: `scripts/test-migrate-map.js`.** Its "unchanged store" case deleted the drafts' blocks, pages and cart offer but left the vgate set's product override, pins and pairs placement in the legacy tables, which the v3 release froze as empty. With the entity mapper built, those are real unpublished drafts, so the case became dirty. It now also clears `placements`, `product_overrides` and `collection_overrides`; no assertion changed. The orchestrator should add this file to this item's list.
- **`lib/migrate/report.js` is not this item's** (MAPPER, CUTOVER, REVERSE), and it now reads slightly wrong for entities:
  - its Details line still says the entity getters "wait for P4-OVL07" (now `skipped` is always 0);
  - an entity difference is named "a part of your store";
  - product and collection documents carried as drafts are named "Product content" / "Collection content" without the product (`plainName` uses the type's label);
  - the mapper's notes (pairs not shown, modules re-sanitized, templates not shown) reach the report only as counts in the holdings.

  CUTOVER should name the product and say what changes.
- **Labels.** The mapper has no catalog titles (it reads nothing; `readLegacySource` is map.js's), so entity documents are labelled with the type's label until the founder opens them (`openEntityContent` sets the Shopify name).
- **`published_at`.** Live rows carry the live release's `published_at`; for a store open with no release it is `null`, and CUTOVER must stamp the backfill time (0024 has it NOT NULL).
- **Modules that can't go live.** A legacy module with an empty title or empty html shows today (an accordion), but `liveRowFor` keeps only modules with both (the LIVEROW review's finding), so the data check reports it as a difference. Pairs over 12 products or a pairs title over 80 characters are carried but fail strict validation (the report lists them under what the editor will flag); none are in the fixtures.
- **Sanitized module HTML** is a reported difference by design. Whether it is an allowed difference is CUTOVER's call (`allowed-differences.js`).
- **Ties.** Two enabled pairs placements at the same position: the mapper keeps the order map.js read them in (`ORDER BY kind, position, id`); the old live-table read left ties to SQLite.
- **`entities: "live"` asks for the ids the mapping's source held** (plus the mapped rows). A row written after that read is found only if the source is read again (the test does this). CUTOVER should re-read the source before the check.
- **Statements.** A v4 product page costs one more statement (its row), and a collection page two (the handle's id and its row). A preview costs one more on those pages (the document). Home rails on a documents store cost one (all rails' pins). Shoppers on legacy stores pay nothing new. Hosted numbers wait for OQ-19.
- **A failed entity row read** (other than a missing table) fails the page closed (the error page), where the legacy override read swallowed errors and showed no modules.
- **The preview merge** shows the draft as if it were published over Shopify's values, not laid field by field over the published row. A field the draft resets to Shopify's shows Shopify's value in the preview, which is what publishing it would do.
- **From the P4-EFFECTIVE review, the probe.** `hasColumns` answers false both when the live table is missing and when the probe itself failed (database unreachable), and only the first is remembered. So after a failed probe that one read goes raw and may show Shopify's title for one request. Telling the two apart needs a change to `lib/schema-compat.js`, which is not this item's.
- **From the P4-EFFECTIVE review, the guard.** A table name held in a variable in the same file (`const TB = "products"` or `"products as p"`, then `selectFrom(TB)`, a join on it, or `${TB}` in SQL text) is now caught. Still not followed: a name imported from another module, passed as a function argument, held in an object property or built from an expression.
- **The drill's script and screenshots are not committed** (they are in this item's scratch folder); a reviewer can re-run the same steps.

From review:

- Test gap: in readEntityDraft (lib/content/documents-reader.js), I removed the `archived_at IS NULL` filter and no suite failed (I ran entity-content, preview-overlay, release-readers, content-seam, effective-read, sections, sections-render and surfaces). With the filter gone, a preview could show the draft of an archived product or collection content document. Only the founder would see it, but no test proves the filter is there. Add a test with an archived entity document.
- Test gap: in livePinsByHandles (lib/catalog/effective.js), I removed the `.slice(0, 24)` cap on home-rail pins and no test failed. The code limits rail pins to 24, but nothing checks it.
- Test gap: in entityRow (lib/content/resolve.js), I removed the `src.mode === "closed"` guard and no test failed. The packet says a closed store reads nothing, and that claim has no test.
- Behaviour change on documents stores, recorded as a Known limit: if reading a product's or collection's live row fails for a reason other than a missing table, the shopper gets the error page. On a legacy store, getProductOverride and getPdpPairs swallow read errors. The entityRow call in pdpPairsFrom runs outside getPdpPairs' try, so on a documents store even the pairs strip can't degrade on its own. No real store runs in documents mode today. Owner/CUTOVER should decide whether failing closed here is right, or whether pairs and the template should fall back to the defaults.
- Reported, not silent: legacy modules with an empty title or empty html, and whitespace-only badges, show today but are dropped by liveRowFor. The data check reports these as differences, and the packet records it. The mapper's `holds` does not count them (`modulesLeftOut` only counts modules that are not objects), so CUTOVER's report will not say why they differ. Worth naming for CUTOVER.
- Preview banner: the per-page entity draft is not added to the documents list the editor's frame is told about (`overlay.docs` / `overlay.skipped`), so the P3-FRAME banner does not mention that a product or collection draft is showing. Founder-facing only.
- Process: scripts/test-migrate-map.js is outside the item's file list. It is recorded in the packet; the orchestrator needs to add it to the item's file list. The change only clears the legacy placement, override and pin tables in the 'unchanged store' case; no assertion changed.
- Verification done at 569b3f9 (worktree rv0, now removed; ports 7320-7326 used, nothing left listening). pnpm test: 96 of 96 suites passed. pnpm build: exit 0; it warned only about files traced whole-project in unrelated routes (/api/errors, /api/platform/*); no new edge-runtime problems and no node: APIs in the changed lib or app code. I ran 25 hand mutations: 22 were caught. Among them: the preview session gate removed, the draft row ignored, the draft title not applied, meta tags not previewed, the collection page not previewed, the badge, pair titles and pins dropped, collection templates ignored, unknown templates accepted, home rails losing pins, a v1 store mapped from the release, disabled placements published, no sanitizing, reversed module order, existing ids ignored, live mode ignored, stray live rows not checked, and the limit-12 check route removed. The 3 that survived are the gaps listed above.
- Semantics checked against the code: the mapper picks the first enabled pairs placement by position, which matches both getPdpPairs (the table path) and presentationPlacements (the frozen-array path). The v1 published side reads the live tables plus the release's surface_templates, which matches what legacy readers do. Template source labels ('entity', 'family', 'platform') match effectiveSurfaceTemplate. Preview draft HTML goes through validateDocument in previewDraftBody, and the mapper sanitizes module HTML, so the unescaped PDP accordion HTML gets no new unsanitized input. candidateSource now defaults entityRows to null; its only production caller is check.js, which passes the rows explicitly in mapped mode.

## From review

None yet.

## Owner checks

- **Old module HTML.** For stores whose product modules were saved before sanitizing, the dry run will report a shopper change on those products (cleaned HTML). Decide per store whether that is acceptable, or ask CUTOVER to list it as an allowed difference.
- **Spec 8.9 deviation** (recorded in plan section 2): a product's or collection's draft shows to any valid preview session, on that page only, not only "when open in the editor".
- **Hosted speed** once OQ-19 allows a staging tenant: a documents store's product page and collection page, against the local counts above.
- **Phone and Safari:** the drill ran in desktop Chrome only.
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum; nothing under `.github/` changed.
