# P4 · PICKER · The library picker, the gallery, pairs and pinned-products controls, and archive on the media screen

Branch `cms/p4-picker`, cut from `509bf57` (`cms/phase-1`, after batch 2 merged). Plan: `docs/cms-reviews/P4-PLAN.md` (sections 0 and 3, batch 3) and `P4-BATCHES.json`. Requirements: MED-03, OVL-04, ED-12, MED-02. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

No store changed mode. No real or hosted store was touched; `--hosted` was never passed. Nothing writes to Shopify. No npm dependency was added. Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `components/admin/editor/editorModel.js`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No file under `lib/` or `app/` changed: everything is console UI (client components), so nothing new runs on the edge runtime.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed (167.9 s; 202.9 s on the final tree). `test:media-picker` 14 passed in about 1 s. `pnpm build` passes (its two Turbopack warnings about `next.config.mjs` tracing were there before) |
| Browser verified | Yes, desktop Chrome 156 (headless, `playwright-core`), 1440 px, on the design harness (`DESIGN_PORT=6140`, `DESIGN_SQLD_PORT=7140`, `next dev`, the `--p3` documents seed). `scripts/drills/p4/picker.mjs`: 11 passed, 0 failed. Not Safari, not a phone |
| Staging verified | **NOT DONE**. Nothing ran against a hosted store |
| Production enabled | **NOT DONE**. Nothing pushed, merged or deployed |

## What and why

Product and collection content are now publishable documents (P4-LIVEROW), but the editor had no control for a product's images (an overlay of kind `gallery`), its "Goes well with" products (`pairs`) or a collection's pinned products (`product_ids`), and image fields had no way to open the media library. The media screen could not archive a file, although MED-03 says a used file can be archived but never deleted, and the server side for that shipped in P4-MEDIA. This item builds those controls and the media screen's half, so P4-EDITOR (batch 4) can put them into the product and collection forms.

## Design

### (1) The library picker in the editor (`DocumentEditor.js`, `fields/index.js`)

- `createLibraryPicker(onOpenChange)` gives `pick({ path })`, a promise that resolves with the founder's choice or `null` when the picker is closed without one. A second `pick()` closes the first with `null`.
- `mediaPick(selection)` is the adapter: MediaPicker hands back `{ url, alt, id }`; this gives `{ media: "/api/media/<id>", alt }`. It uses the id, or reads `/api/media/<id>` from the address (relative or absolute, any query dropped). Anything that isn't a library file gives `null`.
- `DocumentEditor` keeps one picker, passes `pickImage={picker.pick}` to `EditorView`, which puts it in the inspector's `context`, and renders the existing `MediaPicker` while it is open (`onSelect={picker.select}`, `onClose={picker.close}`). `ImageControl` (P3-INSPECTOR) already showed "Choose from your library" whenever `context.pickImage` exists, so every image field in the editor now offers it.
- Archived files are not offered: MediaPicker reads `GET /api/admin/media`, which leaves them out (P4-MEDIA). The unit test and the drill both check this end to end.

### (2) `fields/GalleryControl.js`

- The value is the overlay: `null` (follow Shopify) or `{ value: [{ media, alt }], base_hash?, base_value? }`. The control only ever changes `value` and passes the rest of the overlay back as it was; the service owns the base (P4-LIVEROW (3b)).
- "Your images": each image with its thumbnail, "Alt text for image N" (a labelled text box), and Move up, Move down and Remove buttons.
- "Add from your library" (`context.pickImage`), "Start from Shopify's images" (copies them, in order, while following Shopify) and "Use Shopify's images" (sets the field to `null`, so the product follows Shopify again).
- "Shopify's images", read-only, under the list, each with "Add Shopify image N to your list". An image already in the list (compared without its query string) can't be added twice. When the product isn't in Shopify any more it says so in plain words.
- The cap comes from the setting (30): "N of 30 images", and the add buttons turn off at the cap with the reason.
- The first-edit notice and "Shopify's images changed" are P4-EDITOR's (its brief).

### (3) `fields/PairsControl.js` and (4) `fields/ProductListControl.js`

- `ProductPicks` (in `ProductListControl.js`) is the shared ordered list: each product by its effective title, with "Shopify title: X" as secondary text when Shopify's name differs, a product no longer in the catalog as "No longer in your Shopify catalog", and Move up, Move down and Remove on each row. "Choose products" (or "Change the products") opens the existing catalog picker (`ProductPicker` from `components/admin/cms/RefPicker.js`, several at once, with the cap), which reads `/api/admin/refs`. What it confirms becomes the list, in its order.
- Names are looked up with `context.lookupProducts(ids)` (the refs read's `ids=` hydration; `DocumentEditor` passes it). Only ids are stored.
- `PairsControl`: a title text box labelled "Goes well with: title above these products", with "Pairs well with" (the storefront's default, `lib/cms/placements.js`) as its placeholder and the hint "Leave it empty to use “Pairs well with”". An empty title is stored as `null`; no title and no product stores `null`.
- `ProductListControl` (`collection_content.pinned`): an empty list stores `null` (no pins).

### Showing them in the editor until P4-EDITOR

`inspectorModel.js` is not this item's, so the inspector's own map still has no control for these kinds. `fields/index.js` exports `ENTITY_CONTROLS`, `entityFieldsOf(type)` and `EntityFields`, and `DocumentEditor` renders `EntityFields` under the document's settings form for product and collection content. For a product it also asks `openEntityContent` once for what Shopify sends now (the gallery's Shopify side). Each issue on these fields is shown under its own element (AU-02): the controls render the anchors of their paths (`gallery.value.0.media`, `pairs.products.1` and so on). P4-EDITOR replaces this with its product and collection forms.

### (5) `components/admin/MediaAdmin.js`

- **Archive** and **Unarchive** on each file (`PATCH { id, archived }`). Archived files leave the list, with the words "… is archived. It's hidden from the image picker, and pages that use it still show it." The server's refusals (archive not available yet, file gone) are shown in its plain words.
- **"Show archived files"**, a labelled checkbox: lists them too (`GET ?archived=include`), marked "Archived", with what that means.
- **"Where it's used"** on each file (`PUT { id }`, the usage read): a list in plain words (`usageLine`), such as "Home page (live)", "A page (an earlier version)", "What your store shows now", "An earlier published version of your store", "Your brand settings". Never an id, a table name or a code (P2-PLAN section 6: name and label, not `where`).
- **Delete of a used file**: the first delete is never forced. On a documents store the server refuses any delete of a used file (P4-MEDIA). The screen then shows "This file can't be deleted", the server's plain reason, where it is used, and "Archive it instead". There is no "Delete anyway".
  - On a legacy store the server still allows a forced delete, so today's "delete anyway" choice stays there, now in plain words. The two are told apart by the usage rows: on a documents store every row names a page, an old published version or the settings (`documentsUsage`).
  - Any other refusal (the store is being moved) shows its plain words with nothing to press but Close.
- `refresh()` keeps its old shape, because `test-media-upload` runs its body on its own; the "Show archived" choice is read from a ref there.

## Acceptance, with evidence

All unit cases are in `scripts/test-media-picker.js` (`pnpm test:media-picker`). "Fails without" means that the named file was put back as it is at `509bf57` (or the named mutation was made), the suite was rerun and the file restored.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Unit (test-media-picker): choosing a library image in ImageControl stores `{media: '/api/media/<id>', alt}`; archived files are not offered | **DONE** | "choosing a library image in ImageControl stores …": the real `MediaPicker`, its fetch answered by the real `GET /api/admin/media` handler on a documents file store holding one kept and one archived file. It offers the kept one and not the archived one. "Choose from your library" in the real `ImageControl` opens the picker; choosing the kept file gives `onChange({ media: "/api/media/<id>", alt: "Amber jar" })`, which validates. Also "mediaPick …", "createLibraryPicker …", and "rendered: the editor passes pickImage to the forms …". **Fails without:** with no `fields/index.js` the suite can't load; with `509bf57`'s `DocumentEditor.js` the two editor cases fail (no library button, no gallery or pairs); mutation M5 (`mediaPick` passes the address through) fails "mediaPick". The archived-file part passes on P4-MEDIA's route alone; it guards that this picker stays on that read |
| 2 | Unit: GalleryControl adds, reorders, removes and edits alt, and 'Use Shopify's images' clears the overlay; PairsControl and ProductListControl keep order and show effective titles with the Shopify title as secondary text | **DONE** | "GalleryControl adds from the library and from Shopify, reorders by buttons, removes and edits alt; 'Use Shopify's images' clears the overlay" (the base is kept; the stored gallery validates). "GalleryControl 'Start from Shopify's images' …" (copy, cap at 30, a closed library adds nothing, a product gone from Shopify). "ProductListControl keeps the order …" (rows "1. Bamboo lid", "2. Amber jar (Shopify title: AMBER JAR 250ML)", "3. No longer in your Shopify catalog"; move, remove, the catalog picker's order; empty is `null`; validates). "PairsControl keeps the order …" (the default title, typed title, order, empty title `null`, nothing at all `null`; validates). **Fails without:** the controls are new files (the suite can't load). Mutations: M3 ("Use Shopify's images" keeps an empty list), M7 (reorder does nothing), M4 (no Shopify title line, fails both list cases), M8 (an empty title kept) |
| 3 | Unit: MediaAdmin archive and unarchive call the API and the archived filter shows them; delete of a used file shows the plain reason | **DONE** | The real `MediaAdmin`, its fetches answered by the real `/api/admin/media` route on file stores. "archive and unarchive call the API and the archived filter shows them": PATCH bodies, `archived_at` in the database, hidden, then shown and marked with the filter, Unarchive, the filter off. "delete of a used file shows the plain reason …": "Where it's used" lists "Home page (draft)" with no ids; Delete sends one unforced DELETE; the refusal shows the server's words "This file is still used by Home page (draft)…, so it wasn't deleted. Remove it from there first.", the list, "Archive it instead" and no "Delete anyway"; the file is kept, then archived instead. "on a legacy store keeps today's choice …" (plain words, forced only after the choice; a moving store's words). "usageLine says every kind of use in plain words". **Fails without:** with `509bf57`'s `MediaAdmin.js`, 5 cases fail. Mutation M6 (documents usage treated as legacy, so "Delete anyway" is offered) fails 2 |
| 4 | Drill (desktop Chrome, harness): pick a library image into a product gallery and archive an unused file | **DONE** | `docs/cms-reviews/drills/P4-PICKER/results-picker.json`: 11 passed, 0 failed. On the `--p3` documents seed, as the owner, at 1440 px: a product's content opens with Shopify's images. "Add from your library" takes the keyboard focus and Enter opens the media picker. Choosing a photo autosaves `{ media: "/api/media/<id>", alt }` in the draft's gallery, and the photo shows. A fresh upload is "Not used anywhere"; Archive hides it, the store holds `archived_at`, "Show archived files" shows it marked, and the editor's picker no longer offers it. Deleting the photo the gallery uses is refused in plain words naming the product, with "Archive it instead", no "Delete anyway", and the file kept. No page errors. Screenshots: `editor-gallery-following-1440.png`, `editor-media-picker-1440.png`, `editor-gallery-library-image-1440.png`, `media-archived-shown-1440.png`, `media-delete-refused-1440.png` |

Every control is reachable by keyboard and labelled: "rendered: every new control's text box has a visible label, and every action is a button with a name" checks the gallery, pairs, pinned and media markup (every input has a `label for=`, apart from the media screen's existing alt box with its `aria-label`; every action is a `type="button"` with a name; nothing clickable that isn't a button). The drill presses the library button with Enter.

Mutations (each restored after): M3, M4, M5, M6, M7, M8 as named above. Each fails at least one case.

## Tests

- `scripts/test-media-picker.js`: the suite (it was SCAFFOLD's placeholder), 14 cases, about 1 s. It uses file databases only (`tenant-fixture`), the real media route handler, Next's SWC for the JSX, `react-dom/server` for markup, and a small hook driver (each component called as a function with its own hook slots, effects run after each render) to press buttons and type.
- `scripts/drills/p4/picker.mjs`: the drill (see Known limits).
- `scripts/test-media-upload.js` (not changed) still passes: it runs `MediaAdmin`'s `refresh()` and `upload()` bodies on their own.

## Known limits

- **One file outside the plan's list:** `scripts/drills/p4/picker.mjs`, this item's drill, plus its results folder `docs/cms-reviews/drills/P4-PICKER/`. It is a new stage file, not `run.mjs` (HARNESS's, then DRILLS'), so it is run on its own: `DESIGN_PORT=… DESIGN_SQLD_PORT=… node scripts/drills/p4/picker.mjs`. The orchestrator should add it to this item's files. P4-DRILLS may fold it into its 'media' and 'product' stages.
- **The controls are shown under the settings form, not in a product form.** `EntityFields` is a stopgap in `DocumentEditor.js` until P4-EDITOR's ProductForm and CollectionForm (batch 4) place them. The inspector's own map (`inspectorModel.js`) still has no entry for `overlay`, `gallery`, `pairs` or `product_ids`, so `test-editor-inspector` still allows exactly those gaps. `fields/index.js` exports `ENTITY_CONTROLS` for EDITOR to wire in.
- **The editor calls `openEntityContent` once for each open product or collection document**, to read what Shopify sends now. For a document that exists this only reads (the one write it can do is to bring back an archived row of a product that is in Shopify again, which the editor would not have open). It needs `storefront.write`, which everyone who can edit has. P4-EDITOR's entry (`?product=`) makes this call anyway and can pass the answer down instead.
- **The product title shown is whatever `/api/admin/refs` returns as `title`.** At this base that is still Shopify's title, and `shopify_title` is not sent, so the secondary line shows only once P4-SEARCH (same batch) moves the refs read onto effective titles with `shopify_title`. The control reads exactly those two fields, and the unit test proves the display with a stand-in lookup. The catalog picker's own dialog (`RefPicker.js`, not this item's) lists the `title` only.
- **"Start from Shopify's images"** is an extra button beyond the brief. It lets a founder reorder or trim Shopify's images without adding them one by one. The first library or Shopify image added while following Shopify starts a list of that one image, and the control says "Shoppers see your images" from then on.
- **A forced delete stays on legacy stores**, as the server allows it there. A legacy store whose usage rows happen to come only from its document tables is treated as a documents store (no "Delete anyway"); that refuses more, never less.
- **The media screen's server page** (`app/(console)/admin/(authed)/media/page.js`) still lists without archived files at first load; the filter starts off, so that matches.
- **MED-02** (keep media in the database and measure it) has no code here: its acceptance is a measurement on a real tenant. Nothing in this item changes an `/api/media/<id>` address; archived files are still served (P4-MEDIA).
- **Phone and Safari** were not checked.

## From review

(Empty: no review yet.)

## Owner checks

- **Phone and Safari:** open a product's content in the editor, add a library image to its images, and archive an unused file on Media.
- **After P4-SEARCH merges:** in the pairs and pinned lists, a renamed product shows its new name with "Shopify title: …" under it.
- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need your approval (carried from P4-SCAFFOLD).

## Commands

```
pnpm test:media-picker
DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 node scripts/drills/p4/picker.mjs
pnpm test
pnpm build
```

## Files

- `components/admin/editor/DocumentEditor.js`: the picker, `lookupProducts`, the entity answer, `EntityFields` under product and collection content
- `components/admin/editor/fields/index.js` (new): `mediaPick`, `createLibraryPicker`, `ENTITY_CONTROLS`, `entityFieldsOf`, `EntityFields`
- `components/admin/editor/fields/GalleryControl.js`, `PairsControl.js`, `ProductListControl.js` (new)
- `components/admin/MediaAdmin.js`: archive, unarchive, the filter, "Where it's used", the refused delete
- `scripts/test-media-picker.js`, `scripts/drills/p4/picker.mjs` (new), `docs/cms-reviews/drills/P4-PICKER/`
- `docs/cms-reviews/P4-PICKER.md`
