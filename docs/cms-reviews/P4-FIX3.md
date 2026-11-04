# P4 · FIX3 · The P4-EDITOR review findings

Branch `cms/p4-fix3`, cut from `dbce19a` (`cms/phase-1` after batch 4 and its review notes). Plan: `docs/cms-reviews/P4-PLAN.md`, `P4-BATCHES.json` (item P4-FIX3). Requirements: OVL-01, OVL-02, OVL-03, ED-05. Migrations owned: none. The findings are the "From review" list in `docs/cms-reviews/P4-EDITOR.md`.

This is the author's own report. Reviewers should re-read the code.

No store changed mode. No real or hosted store was used: unit tests run on file databases (`scripts/support/tenant-fixture.js`); the drill ran on this worktree's design harness (ports 6140 and 7140 to 7142), whose store was made by the harness's local takeOver (`--p3` seed). `--hosted` was never passed. Typesense was only "configured" with dummy localhost values inside the existing P4-EDITOR test, with `fetch` replaced by a recorder; the harness blanks every Typesense variable. Nothing writes to Shopify: the drill changes Shopify's description in the harness's own local catalog row, as a sync would. No npm dependency. Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `components/admin/editor/editorModel.js`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No test order was placed.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 231.4 s (ports 6140, 7140 to 7149). `test:product-editor` 27 passed (11 new), `test:editor-shell` 31 passed (1 new). `pnpm build` passes (3 Turbopack warnings, as before) |
| Browser verified | Yes, desktop Chrome 156 (headless, the P3 drill library), 1440 px, on the design harness: `docs/cms-reviews/drills/P4-FIX3/fix3.mjs` 5 passed, 0 failed. Not Safari, not a phone |
| Staging | **NOT DONE.** Nothing ran against a hosted store |

## What and why

The P4-EDITOR review found two things a founder sees that were wrong (Shopify's description was missing beside the founder's own, and its "Changed in Shopify" notice put Shopify's raw HTML into a sentence), a moment where one product's draft was shown against another product's Shopify values, a form that would wait forever on "Loading Shopify's images…" if it ever opened without the entity answer, half-wrong Catalog wording on a documents store, a parity list that missed the Upsells Enable/Disable switches and could not notice a missing control, and seven mutations no test caught. This item fixes each one and adds a test for each.

## Design

### (1) Description (`ProductForm.js`)

- New `plainSummary(html, max = 160)`: drops tags (a script's or style's text with them; a block tag ends a word, an inline tag does not), reads the common entities back, folds spaces and cuts at a word with "…". It returns text only; React escapes it, so nothing is ever markup.
- When the founder has their own description: under the box, "Shopify's description: <plain text>", and "Show all of Shopify's description" (a `details`) when the line is cut. For a product that left Shopify: "Shopify's description when it left: <plain text>" (its stored base value).
- The description's "Changed in Shopify" notice now reads "Shopify changed the description after you edited it. Shopify's description now reads: <plain text>". The other fields' notices are unchanged (they are plain text already). `editorModel.js` is not this item's file, so the sentence is made in the form (`DESCRIPTION_WORDS.changed`).

### (2) Switching products (`DocumentEditor.js`, `ProductForm.js`)

- `EditorView` works out `switching`: the store still holds another document than the page's entry, and one of them is product or collection content. While that is so, the product and collection forms (and the writing view, the actions and Earlier versions) are held back, the heading names the product being opened, and the line "Opening <name>…" shows. So A's draft is never drawn against B's Shopify values.
- Each form is also keyed on its document and the entry (`product-<state id>:<entry id>`), so no form state crosses over.
- `ProductForm` with no entity answer shows plain words ("We couldn't read what Shopify sends for this product, so it can't be edited here right now. Reload the page to try again.") and no form, never "Loading Shopify's images…".

### (3) Read-only through ?doc= (`editor/page.js`)

The page already gave a read-only person the read-only view on `?doc=` (`readOnly: editable ? null : ENTRY_WORDS.readOnly`); the review's point was that no test held it. The page is unchanged; a test now opens a product's content through `?doc=<id>` as support (read-only words, Shopify's values), as the owner (editable), and checks it matches `?product=`.

### (4) Catalog wording (`CatalogAdmin.js`, `catalog/page.js`)

- On a documents store the catalog page's header now says: "Your products, synced from Shopify. The name, description, photos, brand and product type shoppers see are set in the editor; only price, stock and Shopify's own type and vendor stay in Shopify. Bundles and quizzes stay here." Its editor block: "Names, descriptions, photos, the brand and product type shoppers see, badges, modules and pairs are set in the editor now. Price, stock and Shopify's own type and vendor stay in Shopify: change those in Shopify."
- `CatalogAdmin` takes `documentsStore`; with it, its Shopify line is `CATALOG_DOCUMENTS_LINE` ("The brand and product type shoppers see are set in the editor. Only price, stock and Shopify's own type and vendor stay in Shopify: …"). Without it (every legacy and migrating store: the page passes no new prop) the line is `PRODUCT_WORDS.catalogShopify`, unchanged, and the legacy page renders exactly as before (`test-legacy-routes` compares it with the `b6110fe` file).

### (5) Parity (`parity.js`)

- NOT_CARRIED is now `{ screen, what, why }`, and gains the two switches:
  - "Pairs: Enable or Disable switch": there is no off switch for a product's Goes well with list that keeps its products. To turn it off, remove every product: shoppers then see the automatic suggestions, as with a strip switched off before. The list stays in Earlier versions.
  - "Cart slot: Enable or Disable switch": the same for the Cart page; with no suggested products the cart shows none, as with the slot switched off before.
  (Checked against `lib/cms/placements.js`: a pairs strip with no manual products falls back to the automatic strip; the cart slot shows only when configured.)
- PARITY's "Pairs: switch off or delete" is now "Pairs: delete" (no switch is passed off as "remove every product"), and "Cart slot: delete" is added.
- `OLD_FORM_CONTROLS` lists every form control the two old screens render, by the identifier `oldFormControls(source)` reads from the file (each `<Input>`, `<Textarea>`, `<Select>`, `<Switch>` and lower-case `input`, `textarea`, `select`, named by its id, else aria-label, else label), each mapped to a PARITY entry, a NOT_CARRIED entry or "finds what to edit". `OLD_CONTROLS` is derived from it plus the row actions, never written twice. The test reads `CatalogAdmin.js` and `UpsellsAdmin.js` and requires their controls to equal the list, so a control added to either file fails it (the test grows each file with one control to prove it).

## Acceptance, with evidence

PE = `scripts/test-product-editor.js`, ES = `scripts/test-editor-shell.js`. "Bites" = the named change was made, the suite failed, the code was restored (runner: the scratch folder's `helpers/mutate.py`, 15 of 15 caught).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | rendered: Shopify's description shows beside the founder's; the description notice has no raw HTML | **DONE** | PE "when the founder has their own description, Shopify's shows beside it as plain text…" (real saves and syncs, `renderToStaticMarkup`; also the orphan line and `plainSummary`). Bites: F1a (line removed), F1b (notice back to `n.words`: the raw `<h2>…` sentence). Drill `fix3.mjs`: "Shopify's description shows beside the founder's, as plain text" and "the notice reads in plain words, no raw HTML" in Chrome (`description-beside-1440.png`, `description-notice-1440.png`) |
| 2 | unit: switching products never shows A's draft against B's Shopify values; a null entity shows plain words | **DONE** | PE "switching products holds the form back…" (the mounted DocumentEditor, B's getDocument held: no product form, A's name not on screen, the heading names B; then B's draft with "Shopify title: Beta"). ES "P4-FIX3 rendered: while the store still holds product A…". PE "a product document opened without the entity answer shows plain words…" (form and EditorView). Bites: F2a (hold removed: PE and ES fail), F2b (null guard removed). Drill: "from A (edited name) to B, A's draft is never shown with B's Shopify title" (a MutationObserver records every heading and Shopify-title pair while B opens); with F2a the drill fails too: it caught "Drill own name" shown with B's "Shopify title" in real Chrome |
| 3 | unit: ?doc= gives a read-only person the read-only view; each of R2, R4, R5, R10, R24, R25, R27 now fails a test | **DONE** | R4 PE "?doc=<id> of a product's content gives a read-only person the read-only view"; R5 PE "the shell re-reads the product counts after 'Keep mine' and after 'Use Shopify's'" (mounted DocumentEditor, both buttons); R24 PE "a read-only person's entry finds a phase-3 random-id document…"; R2 PE "the heading shows the founder's name…"; R10 PE "'Keep mine' and 'Use Shopify's' are disabled for a read-only person"; R25 PE "the read-only view honours the title gate"; R27 PE "'Discard edits' is never offered to a read-only person…". Each mutation as the review described it bites (R2 also fails the switching case). These tests pass at the base too: the code was right, the tests were missing |
| 4 | unit: documents-store catalog wording names what the editor sets; PARITY covers the upsell and cart-slot switches and a new old control fails the parity test | **DONE** | PE "on a documents store the catalog page and CatalogAdmin say…" (the real page in documents mode; CatalogAdmin mounted and its Presentation screen opened, with and without `documentsStore`). PE "the PARITY list covers every CatalogAdmin and UpsellsAdmin control (read from the old files…)" (adds a Field+Input to UpsellsAdmin's source and a Switch to CatalogAdmin's: both reported). Bites: F4a, F4b, F5a (switch unmapped), F5b (cart switch reason dropped) |
| 5 | unit: pnpm test passes | **DONE** | 96 of 96 suites, 231.4 s, ports 6140 and 7140 to 7149. `pnpm build` passes |

## Tests

- `scripts/test-product-editor.js`: section 11 (11 new cases) and two rewritten checks (the Catalog line now names both lines; the parity case reads the old files).
- `scripts/test-editor-shell.js`: one rendered case for the switching hold.
- Drill: `docs/cms-reviews/drills/P4-FIX3/fix3.mjs`, results `results-fix3.json` and three screenshots in the same folder.
- Mutations (15, all caught): R2, R4, R5, R10, R24, R25, R27 as the review described them; F1a no description beside; F1b raw notice; F2a no hold; F2b form without entity; F4a CatalogAdmin legacy line on documents; F4b old catalog header; F5a switch unmapped; F5b cart switch reason dropped.

## Known limits

- **Files outside the plan's list:** `docs/cms-reviews/drills/P4-FIX3/` (this item's drill and its results; the drill lives there so it ships with its evidence and touches no `scripts/drills/` file). The orchestrator should add it to this item's files.
- **CatalogAdmin on a documents store:** the catalog page shows the editor block there, not CatalogAdmin, so `CATALOG_DOCUMENTS_LINE` shows only if a later change renders CatalogAdmin on such a store. The founder reads the same facts in the page's header and block. The words live in two places (the page is a server file and can't read a value from a client file); the test checks both.
- **Shopify's description is shown as plain text,** not a rendered preview: the first 160 characters, the rest behind "Show all of Shopify's description". `plainSummary` is a text extractor, not a sanitizer; nothing it returns is ever used as markup.
- **The "Editing" heading of the shell** still shows the document's label (Shopify's name when the document was made), as before; the product form's own heading shows the founder's name.
- **The switching hold** compares the store's document with the page's entry. If a later change opens product content without changing the page's entry, the form stays held back with "Opening …" until the entry matches.
- **The parity read** finds `Input`, `Textarea`, `Select` and `Switch` tags (and lower-case form tags). A new kind of control (a custom checkbox component, a new picker button) in the old screens would not be noticed. Row buttons (Delete) are listed by hand in `parity.js`.
- **Turning off pairs or the cart's suggestions** now means removing the products from the published list; the old list is only in Earlier versions, not kept beside an off switch.
- **Phone and Safari:** not checked.

From review:

- I reviewed cms/p4-fix3 at 8da16f6 against dbce19a in a detached worktree. It is removed now, and ports 6340 and 7340 to 7349 are free. pnpm test passed 96 of 96 suites on my ports (web server 6340, sqld 7340 to 7349). test-product-editor passed 27 and test-editor-shell passed 31. The code changes add no node: APIs or new imports and leave .github/ and package.json alone. Legacy wording is unchanged and test-legacy-routes passes.
- Mutations: I made 16 of my own and 12 were caught. Caught: the form not held back while switching, the old heading label, the 'Opening <B>' words removed, no script or style stripping, no entity decoding, the left-Shopify line using shopifyValue, the notice using baseValue, the cart-slot switch dropped from the parity list, the old catalog header, the old catalog block, the guard narrowed to entity===undefined, and the cut with no ellipsis. Four survived, and none of them shows a shopper or founder wrong data today. (a) Putting the actions bar back during a switch (`{state && actions}`) passes every test. While the screen says 'Opening B…', the Publish and Discard actions for the previous product A could then show again. The code holds them back correctly, but no test proves it. (b) The same is true of the Earlier versions panel during a switch. (c) Removing the 'Show all of Shopify's description' details is not caught. (d) Narrowing `switching` to the entry type only is not caught. That one does no harm.
- Race that was already there, now visible in a different way: openEntry has no sequence guard. If a founder goes A to B to C quickly and B's getDocument answers after C's, the store holds B while the page is C. Before this fix that showed B's draft against C's Shopify values. Now the form is held back and 'Opening C…' stays on screen until a reload. That is safe (no wrong data, no write) but it can look stuck. A sequence counter in openEntry, like the one productSeq gives loadProducts, would close it.
- CatalogAdmin's new documentsStore prop is never passed in production. The catalog page on a documents store does not render CatalogAdmin; only the tests use the prop. The wording founders actually see on documents stores is the page's CATALOG_DOCUMENTS_WORDS header and block, and those are correct and tested.
- The new parity guard reads only Input, Textarea, Select and Switch tags (upper or lower case) from the old files. A picker (ProductPicker or CollectionPicker), a new Button row action, or a custom control component added to CatalogAdmin.js or UpsellsAdmin.js would not fail the test. OLD_ACTIONS (the Delete actions and the page templates) is still a hand-written list. It covers what the item asked for, but not every way a control could be added.
- Item (3), ?doc= read-only: page.js was not changed. It already gave a read-only person the read-only view through `editable ? null : ENTRY_WORDS.readOnly`, and a test now covers it. For R2, R4, R5, R10, R24, R25 and R27, the builder says the new tests also pass at the base, because only the tests were missing. That is consistent with the review.
- Plain words: the description line for a product that left Shopify says 'when it left' but shows baseValue. baseValue is Shopify's description from when the founder first changed it, which may not be its last value. This matches how the existing lastKnown lines for other fields work. It is minor.
- I did not re-run the Chrome drill docs/cms-reviews/drills/P4-FIX3/fix3.mjs. The orchestrator should add docs/cms-reviews/drills/P4-FIX3/ to P4-FIX3's file list, as the builder asked.

## From review

(Empty: no review yet.)

## Owner checks

- **Desktop Chrome on a staging test tenant:** give a product your own description; Shopify's shows beside it as plain text. Change the description in Shopify, wait for the catalog update and reopen: the notice reads in plain words. Then open another product from the product list: the first product's name never shows with the second's "Shopify title".
- **Catalog page on a documents store:** the header says the brand and product type shoppers see are set in the editor.
- **Phone and Safari:** the product form at phone width.
- **CI:** the sqld download in `.github/` still needs your approval of its source and checksum; nothing under `.github/` was changed.

## Commands

```
pnpm test:product-editor && pnpm test:editor-shell
PORT=6140 DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 SHOPIFY_OAUTH_PORT=7147 TEST_PUBLISH_PORTS=7141,7142 TEST_PUBLISH_SERVICE_PORTS=7143,7144 TEST_PUBLISH_UNDO_PORTS=7145 TEST_PRODUCT_CONTENT_PORTS=7146,7148 TEST_MIGRATE_MAP_SQLD_PORT=7149 pnpm test
DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 node docs/cms-reviews/drills/P4-FIX3/fix3.mjs
pnpm build
```

No server, sqld or browser was left running; ports 6140 and 7140 to 7149 are free.
