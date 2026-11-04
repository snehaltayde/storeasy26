# P4 · EDITOR · The product editor and the collection form

Branch `cms/p4-editor`, cut from `b6110fe` (`cms/phase-1` after batch 3). Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 1 and 4, section 3, R4 "founders can't reach every product", batch 4) and `P4-BATCHES.json`. Requirements: OVL-04, OVL-01, OVL-06, ED-12, ED-02. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

No store changed mode. No real or hosted store was used: unit tests run on file databases (`scripts/support/tenant-fixture.js`); the drill ran on this worktree's design harness (ports 6100 and 7100), whose store was made by the harness's local takeOver (`--p3` seed). `--hosted` was never passed. Typesense was only "configured" with dummy localhost values inside one test, with `fetch` replaced by a recorder (nothing was sent); the harness blanks every Typesense variable. Nothing writes to Shopify. No npm dependency. Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No test order was placed (the drill fills the cart, then empties it).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 180.0 s (ports 6100, 7100 to 7108). `test:product-editor` 16 passed (about 1 s), `test:editor-shell` 30, `test:publish-ui` 42, `test:media-picker` 14, `test:rich-text` 18. `pnpm build` passes (one Turbopack warning; a first attempt failed downloading a Google font, the retry passed with no change) |
| Browser verified | Yes, desktop Chrome 156 (headless, `playwright-core`, the P3 drill library), 1440 px, on the design harness: `scripts/drills/p4/editor.mjs` 14 passed, 0 failed. Not Safari, not a phone |
| Staging | **NOT DONE.** Nothing ran against a hosted store |

## What and why

After batch 3 a product's content could be published, but the editor still listed only 30 products (it read the old catalog route), product content opened as a plain settings form with the gallery, pairs and pins tacked underneath, a read-only person waited forever on "Loading Shopify's images…", and nothing showed what Shopify sends beside a founder's change. This item builds the OVL-04 product editor and the ED-12 collection form, closes the P3-FIX5 preview-bar findings, and settles a lost answer of a products-only publish.

## Design

### (1) Entry (`app/(console)/admin/(authed)/editor/page.js`, `lib/admin/entity-entry.js` new)

- The page reads `parseEditorTarget` (SCAFFOLD). For `?product=<gid>` or `?collection=<gid>` it calls `entityEntry`:
  - a person who can edit (`storefront.write`) goes through `openEntityContent` (found by the deterministic id, a phase-3 random-id row reused, made, or an archived one brought back);
  - anyone else gets `readEntityContent`: reads only (the deterministic id, then `(type, entity_id)`, then what Shopify sends now). Nothing is written; an archived row stays archived; a product with no content yet opens as an empty, read-only form showing Shopify's values, with "You can look at this, but your role can't change it. Ask the store owner or an admin."
  - a product or collection not in the catalog opens the home page with plain words.
- The answer also carries `commerce` (price, variants and stock, read here) and `shopifyAdminUrl`. `?doc=` of a product or collection content document reads the same answer (read only).
- `DocumentEditor` gets this as the `entity` prop and **never calls `openEntityContent`** (P4-PICKER review).

### (2) Switcher (`Switcher.js`, `editorModel.js`, `DocumentEditor.js`)

- Pages as before; product and collection content are no longer listed as pages (`ENTITY_TYPES`), and `product_content` is no longer treated as "not editable".
- **Products** come only from `listProductContent` (search box `q`, filters "All products", "Changed in Shopify", "No longer in Shopify", each with its count, "Show more products" by cursor). A row shows the published name, "Shopify title: …" when it differs, and a state; it opens `/admin/editor?product=<gid>` (the nav guard saves first).
- **Collections** come from the catalog picker's read (`/api/admin/refs?type=collection`) and open `?collection=<gid>`.
- The shell always shows "Products N · Changed in Shopify N · No longer in Shopify N".
- `GET /api/admin/catalog` is no longer fetched. The pickers' first products and collections (for section forms) come from `/api/admin/refs`.

### (3) Product form (`ProductForm.js`, rules in `editorModel.js productFormModel`)

- Header: the name shoppers see, with "Shopify title: X" always under it (OVL-06).
- Overlay fields: name, description (the rich text field), images (GalleryControl), brand shown, product type shown. Each has "Differs from Shopify" / "Same as Shopify", Shopify's value beside it, and "Reset to Shopify".
- The rules mirror the service (P4-LIVEROW (3b)): Reset and "Use Shopify's" send null; a value equal to Shopify's (images without query string) is sent as null; "Keep mine" is `resolveShopifyChange 'keep'`. A description the founder did not touch is never sent: while it follows Shopify the box shows Shopify's text and the field never changes it on its own, so the saved field stays null; an editor's cleaned copy of Shopify's text is made null by the service (the client never sanitizes, P3-RTE's rule).
- "Changed in Shopify" notice: only for an EDITED field whose Shopify value moved since it was edited (base value vs what Shopify sends now), with "Keep mine" and "Use Shopify's". For the images: "Shopify's images changed" with "Use Shopify's images" and "Keep mine". Both go through the store's call (`createStoreCall`): saved first, on the current revision, the answer replaces the store, typing meanwhile kept as an earlier draft.
- Gallery: while the founder's own list is used, the note "Your images replace Shopify's for this product. New images added in Shopify won't show until you choose Use Shopify's images." The caps are said in plain words before publish fails (30 images, 20,000 characters, with a running character count).
- Title gate: when `titleEditable` is false, name, brand and type are disabled with `titleBlockedReason`; Reset on them stays.
- Price, variants and stock: read only, in plain words, with "Change in Shopify" (`shopifyAdminUrl`).
- Badge, layout (the store's layout or Classic/Editorial), keep variant images, "Goes well with" (PairsControl).
- Modules: listed with move, remove and their own settings form; only rich text, text and FAQ can be added (`offeredKinds`); an older image-with-text module stays editable.
- A product that left Shopify: "No longer in Shopify", the values Shopify had when it was edited ("Shopify's name when it left: …"), Reset and the notice off, and "Discard edits" for an owner or admin; staff see "Only an owner or admin can discard these edits." instead of the button.

### (4) Collection form (`CollectionForm.js`)

Pinned products (ProductListControl) and layout (the store's layout, Standard or Sidebar), Shopify's name, and "Change in Shopify".

### (5) Parity (`parity.js`)

| ✓ | Old screen | What the founder changed | Now | Control |
|---|---|---|---|---|
| ✓ | CatalogAdmin | Badge | Editor › a product › Badge | `text` |
| ✓ | CatalogAdmin | Product-page modules (title and text) | Editor › a product › Modules on this product's page | `modules` |
| ✓ | CatalogAdmin | Pinned product handles of a collection | Editor › a collection › Pinned products | `product_ids` |
| ✓ | CatalogAdmin | Product page template | Editor › a product › Layout | `layout` |
| ✓ | CatalogAdmin | Collection page template | Editor › a collection › Layout | `layout` |
| ✓ | UpsellsAdmin | Pairs: title | Editor › the source product › Goes well with: title | `pairs` |
| ✓ | UpsellsAdmin | Pairs: source product and target products | Editor › the source product › Goes well with: products | `pairs` |
| ✓ | UpsellsAdmin | Pairs: switch off or delete | Editor › the source product › remove every product | `pairs` |
| ✓ | UpsellsAdmin | Cart slot: title | Editor › Cart › Suggestions title | `text` |
| ✓ | UpsellsAdmin | Cart slot: target products | Editor › Cart › Suggested products | `products` |

Not carried (deliberate): Upsells' Position (several strips on one product) and its Kind choice; a product has one "Goes well with" list and the cart slot is the Cart page.

### (6) Catalog screen copy

`CatalogAdmin.js`: "Shopify owns these — edit them in Shopify admin; they sync here." is now `PRODUCT_WORDS.catalogShopify`: "Type, vendor, price and stock come from Shopify. Change them in Shopify; your store shows the new values after the next catalog update."

### (7) Review items carried in

- **P3-FIX5, Hide them:** while the design is open, the preview controller tells the frame (`frame.designOpen`, called on every ready) and `applyDesignToggle` adds one style rule to the same-origin frame document that hides the bar's design button; on any other document it is removed.
- **P3-FIX5, designHiddenIn:** `designProblem` separates "hidden" (the session's colours are off, or not known to be on) from "unreadable" (this controller turned showDesign on in that session and the draft is still skipped). The failure words for the second are "Your new colours couldn't be read, so the preview shows your live colours. Try again. If it keeps happening, go back to an earlier version of your design in Earlier versions."
- **P4-LIVEROW, lost products-only answer:** the publish flow takes `readDocument`, and the editor passes the documents API's own `getDocument`. The store's call answered with the store's copy, which still held the old published hash, so a products-only set (release: null) settled as "didn't go live" when it had. After a check that finds it live, the editor takes the server's document into the store.
- **P4-LIVEROW, description null, module kinds, caps:** above (3).
- **P4-PICKER, read-only and loading line:** above (1). **refs `shopify_title`:** confirmed in the drill (pairs and pinned lists).

## Acceptance, with evidence

PE = `scripts/test-product-editor.js`, ES = `test-editor-shell`, PU = `test-publish-ui`. "Bites" = the mutation named under Tests was made, the suite failed, and the code was restored.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | ?product=<gid> opens the deterministic document (or the phase-3 row); ?collection=<gid> opens collection content | **DONE** | PE "?product=<gid> opens the deterministic document…" and "…reuses a phase-3 random-id row; ?collection=…" (the real page module, real reads and writes). Bites: M1. Fails at the base (the page ignores `product`) |
| 2 | Every overlay field has Reset; 'differs' right after edit, reset and a sync; notice only for an edited field changed in Shopify; both choices work | **DONE** | PE "every overlay field has Reset; the 'differs' label…" (real saves and `writeProduct` syncs) and "the notice appears only for an EDITED field…". Bites: M4, M5 |
| 3 | Only allowed overlay fields have controls; price, variants and stock read-only with the Shopify link; no 'Shopify owns these' | **DONE** | PE "only the allowed overlay fields have controls…". Bites: M13 |
| 4 | Gate forced closed: name and display fields disabled with the reason, badge and modules editable; gate open with Typesense configured (dummy): editable | **DONE** | PE "with the gate forced closed…" (also the service refuses a new name and saves the badge) and "with the gate open on a store with Typesense configured…" (no fetch made). Bites: M6, M20 |
| 5 | PARITY covers every CatalogAdmin and UpsellsAdmin control, each a working control; the collection form saves pins and template | **DONE** | PE "the PARITY list covers…" (each entry resolves to a registered setting and its control; badge, layout, pairs title and products, a module added through the mounted form) and "the collection form saves pins and template…" (published into `collection_content_live`) |
| 6 | A shopper render of an edited product contains no 'differs' text (negative) | **DONE** | PE "a shopper render of an edited product…": the real product page and card after a publish show the new name and none of the editor's words; no storefront file imports the editor. A guard, so it passes at the base too |
| 7 | Drill: rename, publish, card, product page, cart, search by new name; reset | **DONE** | `docs/cms-reviews/drills/P4-EDITOR/results-editor.json`: 14 passed, 0 failed. Product opened from the editor's list, renamed, published (live row holds it); a fresh shopper browser sees it on the product page, in search results (card) for the new name, on its collection page's card and in the cart drawer and cart JSON (no `catalog_title`); reset and published: Shopify's name back, search no longer finds the new name. Screenshots in the same folder |
| 8 | Product 31 and later open; a renamed product is found by its new name; the counts render; no /api/admin/catalog fetch | **DONE** | PE "product 31 and later open from the switcher…" (35 products paged through listProductContent, product 31 and 35 open through the page; the mounted DocumentEditor reads listProductContent and `/api/admin/refs`, never the catalog route). Bites: M7, M12, M21 |
| 9 | Reset and 'Use Shopify's' leave the field following Shopify; saving the Shopify value leaves no override; 'Keep mine' and 'Use Shopify's' clear the notice and the count before any publish | **DONE** | PE "Reset and 'Use Shopify's' leave the field following Shopify…" and the notice case (count drops, `publish_log` unchanged). ES "'Keep mine', 'Use Shopify's' and 'Discard edits' go through the store…". Bites: M3, M16 |
| 10 | First gallery edit note; 'Shopify's images changed' with 'Use Shopify's images' | **DONE** | PE "the first gallery edit shows the plain note…" (word for word; a query-string-only change is no change). Bites: M8 |
| 11 | Orphan: stored base values, Reset and notice off, 'Discard edits' for owner or admin, plain reason for staff | **DONE** | PE "an orphan shows its stored base values…" (and staff's discard is 403). Bites: M9, M14 |
| 12 | Hide them not offered while the design is open; an unreadable design draft gets its own words | **DONE** | ES "'Hide them' is not offered while the design is open…" and "designProblem tells colours that are hidden from a design draft that can't be read…"; the P3-FIX5 case now expects the unreadable words. Bites: M17, M18 |
| 13 | A lost products-only publish answer settles; an untouched description is sent as null | **DONE** | PU "a lost products-only publish answer (release: null) settles from the server's document…" (real store and store call; without `readDocument` it said "didn't go live"). PE description case. Bites: M19 |
| 14 | A read-only actor opening product content never triggers a write and never sees an endless loading line | **DONE** | PE "a read-only person opening product content…" (document count and revisions unchanged, an archived row stays archived, the rendered view has the plain words and Shopify's image, no loading line). Bites: M2, M15 |

## Tests

- `scripts/test-product-editor.js`: the suite (was SCAFFOLD's placeholder), 16 cases, file databases, the real editor page, documents API, sync writer and components.
- `scripts/test-editor-shell.js`: the switcher case rewritten for the new product rows; four P4-EDITOR cases; the P3-FIX5 case's last expectation changed to the unreadable words (it is the case the review described: the session's colours were on).
- `scripts/test-publish-ui.js`: the lost products-only answer.
- Mutations, each caught (runner in the scratch folder): M1 the page ignores `?product=`; M2 the read-only entry writes; M3 Shopify's value kept as an override; M4 a notice for unedited fields; M5 Reset sends a copy; M6 the gate ignored; M7 the catalog route back; M8 no gallery note; M9 staff can discard; M10 every module kind offered; M12 the product search not sent; M13 the Catalog copy back; M14 Reset on an orphan; M15 the editor asks openEntityContent; M16 resolve not saved first; M17 the unreadable words gone; M18 Hide them still offered; M19 the lost answer read from the store; M20 Reset off while gated; M21 the counts line missing. 20 of 20.

## Known limits

- **Files outside the plan's list:** `lib/admin/entity-entry.js` (new: the server read the page needs; a page file can't be unit tested on its own), `components/admin/editor/PreviewPane.js` (three lines: `designOpen` on the frame), `scripts/drills/p4/editor.mjs` (this item's drill, run on its own like PICKER's) and `docs/cms-reviews/drills/P4-EDITOR/`. The orchestrator should add them to this item's files.
- **Per-tab overlay:** it has not landed, so "the Home tab must not show another tab's unpublished colours" is not built; the P3-FIX5 known limit stands until it does.
- **"Hide them" is hidden by a style rule the editor puts into the frame,** not by the bar itself (`PreviewBanner.js` is not this item's). Outside the editor's frame the bar is unchanged.
- **"Unreadable" is told by what this controller knows:** if another tab turns the colours off between this controller's turn-on and the frame's next ready, it can be called unreadable. Both words end in "Try again".
- **What Shopify sends now is read when the page opens.** A sync while the editor is open shows on the next open (the switcher reopens through the page).
- **Inspector map:** `inspectorModel.js` still has no controls for `overlay`, `gallery`, `pairs`, `product_ids`, and its `WAITS.product_content` words are stale. They are never shown now (product and collection content use their own forms), but `test-editor-inspector` still allows exactly those gaps; that file is not this item's.
- **Keep variant images** is a switch: once set it is on or off, never back to "not set" (null) from the form.
- **Discard edits** is one click, with no confirm step; the old draft is kept as a checkpoint in Earlier versions.
- **Collections in the switcher** are the first 50 of the catalog picker's read, filtered by the search box locally.
- **A read-only person's preview** still asks for a preview session (unchanged from phase 3 for every document).
- **Phone and Safari:** not checked.

## From review

(Empty: no review yet.)

## Owner checks

- **Desktop Chrome on a staging test tenant:** open a product from the editor's product list, rename it, publish, check the product page, a card, search and the cart; then Reset and publish.
- **Typesense stores:** after a rename, search shows the new name within a few seconds (P4-SEARCH's reindex; drills here have no Typesense).
- **Design editor:** with the design open, the frame's bar no longer offers "Hide them"; on the home page it does.
- **Phone and Safari:** the product form at phone width.
- **CI:** the sqld download in `.github/` still needs your approval of its source and checksum; nothing under `.github/` was changed.

## Commands

```
pnpm test:product-editor && pnpm test:editor-shell && pnpm test:publish-ui
PORT=6100 DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 SHOPIFY_OAUTH_PORT=7107 TEST_PUBLISH_PORTS=7101,7102 TEST_PUBLISH_SERVICE_PORTS=7103,7104 TEST_PUBLISH_UNDO_PORTS=7105 TEST_PRODUCT_CONTENT_PORTS=7106,7108 pnpm test
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p4/editor.mjs
pnpm build
```

No server, sqld or browser was left running; ports 6100 and 7100 to 7109 are free.
