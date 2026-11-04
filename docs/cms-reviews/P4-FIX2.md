# P4 · FIX2 · Batch 3 review findings no other batch 4 item owns

Branch `cms/p4-fix2`, cut from `b6110fe` (`cms/phase-1`). Plan: `docs/cms-reviews/P4-PLAN.md` and `P4-BATCHES.json` (item P4-FIX2). Requirements: OVL-07, OVL-17, MED-03 and MIG-01. The findings come from the "From review" lists in `P4-SEARCH.md`, `P4-OVL07.md`, `P4-PICKER.md` and `P4-FIX1.md`.

Files changed:
- Code: `lib/sync.js`, `lib/content/resolve.js`, `lib/content/documents-reader.js`, `lib/media.js`, `lib/migrate/map.js`, `components/admin/MediaAdmin.js`.
- Tests: `scripts/test-search-effective.js`, `scripts/test-entity-content.js`, `scripts/test-preview-overlay.js`, `scripts/test-media-picker.js`, `scripts/test-media-refs.js`, `scripts/test-migrate-map.js`.
- Docs: `docs/cms-reviews/P4-SEARCH.md` (Known limits) and this packet.

In the plan's list but not changed: `lib/catalog/effective.js` and `components/admin/editor/fields/GalleryControl.js`. Their lines (the 24-pin cap, `addImage`) were already right; they only needed tests, and the tests are in the suites above.

Not touched: `DocumentEditor.js`, `editorModel.js`, `lib/admin/editor-entry.js`, `lib/registry/sections.js`, `lib/documents/checks.js`, `lib/migrate/render-compare.js`, `scripts/migrate-documents.js`, `package.json`, `.github/`, `MANUAL-CHECKS.md` and the untracked `docs/CMS_*.md` files. No migration.

Only file databases, one local `sqld` (ports 7160 to 7167, all stopped) and a Typesense spy were used. No case passes `--hosted`. Nothing was written to Shopify.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: see Tests. `pnpm build` passes |
| Browser verified | **NOT DONE.** Every acceptance item is proven by a unit or rendered test that fails without the change. The two founder-visible changes (the media screen's refusal words, the editor frame's report of a product draft) were not looked at in desktop Chrome on the design harness. Owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso or a real Typesense |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed |

## What, why and design

### 1. Search: a failed drain at the end of a full sync now queues a job (OVL-17)

**Why.** The full sync reopens outbox rows written after its read (`reopenAfter`), then drains them (`drainAll`). If that drain failed, the rows stayed pending, but no job covered them. The job the publish had enqueued was already done, and its key is the highest pending rowid, which a reopen does not change. So search could keep an older name until the next publish or full sync.

**Design** (`lib/sync.js`, `indexTypesense`):
- The drain's failure is still caught and logged (`settleOutbox`), and is now also noted.
- After a failed drain, `requeueSearchDrain` reads the highest pending rowid. If there is one, it enqueues a durable `search_reindex` job with the key `search_reindex:<tenant>:<top>:sync:<upTo>:<8 random hex>`.
  - The suffix is needed because job keys are unique for all time.
  - The worker's handler (`lib/platform/worker.js`) is unchanged: it drains everything pending.
- The full sync's answer gains `requeued: { job, key }`.
- With no job queue, or a failed enqueue, the rows wait for the next publish or full sync, as before. Both are logged. The catalog sync itself never fails because of search.
- `lib/catalog/search-reindex.js` (SEARCH's) is not edited. `sync.js` uses its exported `highestPendingRowid`, `searchReindexKey` and `SEARCH_REINDEX_JOB`, and `enqueueDurable` from `lib/platform/jobs.js` (imported on demand, as `search-reindex.js` does).

The two races the review asked to record (the raw-title drain racing a full sync; rowids renumbered by a VACUUM or an export/import rewrite) are now in `P4-SEARCH.md` Known limits.

### 2. Shopper reads: three lines pinned, and pairs and template degrade (OVL-07)

**Three surviving mutations, now caught:**
- **`readEntityDraft`'s `archived_at IS NULL`.** An archived product content document's draft never previews. The product page in a founder's preview shows the live row, and the frame does not list the draft (`test-preview-overlay`).
- **`livePinsByHandles`' 24-pin cap.** A collection with 30 published pins gives the home rail the first 24, in order (`test-entity-content`, part 6).
- **`entityRow`'s closed-store guard.** On a closed store (PUB-06) the getters read no live row, even with rows in the tables: no modules, no badge, no hand-picked pairs, no pins, and not the entity's own template. A control case shows the same reads on an open candidate do see the rows (`test-entity-content`, part 6).

**Degrading on a failed live-row read** (`lib/content/resolve.js`):
- New `entityRowOrNone(src, kind, id, part)`. It calls `entityRow`. On a read error it logs `entity_row_read_failed` (kind, part, entity, error) and answers "no row".
- **The pairs strip** (`pdpPairsFrom`) uses it. With no row, `getPdpPairs` gives what it gives a product without hand-picked pairs:
  - the automatic strip when the catalog reads work;
  - its own read-error answer (an empty "Pairs well with" strip) when they fail too.

  That is exactly the legacy reader's behaviour on a read error.
- **The template** (`surfaceTemplateForFrom`, product and collection) uses it. With no row, the family default from the layout document applies.
- **The product's own modules and badge** (`productOverrideFrom`) still call `entityRow` directly and fail closed.
- **The test** breaks `product_content_live` and `collection_content_live` with a view that fails on every row ("malformed JSON", not "no such table"). It then checks:
  - the pairs and both templates degrade, and each degraded read is logged;
  - `resolvedProductOverride` throws.

### 3. Preview: the frame is told a product or collection draft is showing (OVL-07, PV-03)

**Why.** The editor's frame compares `overlay.docs[<open document>]` with the draft hash it saved, to know whether the preview shows its latest save. Product and collection drafts are never in the list overlay, so they were never in `docs`. The frame on a product page could not say "your draft is showing".

**Why not only the page's own draft.** The layout hands the frame its state before the page runs (it builds the state from `contentSource().overlay`). The page cannot add to it afterwards.

**Design:**
- `documentsPreview` now also reads every dirty, non-archived product and collection content draft. That is one statement, in a founder's preview only: `readDirtyEntityDrafts` in `documents-reader.js`.
- Each one is checked with `previewDraftBody`, the same check `previewEntityRow` makes.
  - A readable draft goes into `overlay.docs` with its draft hash. It shows on its own page.
  - An unreadable draft goes into `overlay.skipped`. Its page shows the live row.
- Neither goes into `overlay.documents` (the list overlay), so the cart, search and the sitemap still never see a draft.
- If that read fails, it is logged (`preview_entity_drafts_read_failed`) and the preview carries on without them. Shoppers get no overlay at all, as before.

### 4. Picker and media (MED-03)

- **`addImage`'s duplicate check and 30-image cap** now have unit cases:
  - the same library file, or the same Shopify image at another size, is refused, and the same list comes back;
  - 30 images is full;
  - an old list over the cap gains nothing and loses nothing;
  - 29 images take one more;
  - with no cap, there is no limit.

  Through the control, a library pick of an image already in the list changes nothing (`test-media-picker`).
- **"Delete anyway" on a legacy store** (`components/admin/MediaAdmin.js`) is offered only when the server can do it. The new `canForceDelete(usage)` requires:
  - usage rows exist;
  - none of them is a page document;
  - they are not all documents, releases and settings (the stricter rule from before, kept).

  `deleteMedia` refuses a forced delete whenever any row is a document, so a file used by an old section and a page draft now gets the refusal dialog instead of a choice that can never succeed.
- **No raw refusal text.** `refusalWords(code, message)`:
  - A used file shows the fixed words "This file is still used, so it wasn't deleted. Remove it from the places below first." The places are listed below in plain words (`usageLines`).
  - The server's message for a used file is never shown. On a legacy store it held codes such as `block:promo`.
  - The moving-store and changed-file refusals keep the server's words. Those are fixed plain sentences in `lib/media.js`.
  - Any other refusal shows the plain "Something went wrong" line.

  A forced delete that the server refuses after the choice (a page started using the file meanwhile) now closes the choice and shows the same fixed words. Before, it threw the server's text into the confirm dialog.
- **The byte dedupe and archived files** (`lib/media.js` `saveMedia`). The choice is **un-archive on purpose**, which P4-MEDIA already did quietly.
  - `unarchiveQuietly` now reports whether it brought the file back.
  - `saveMedia`'s answer carries `unarchived: true` when it did. The upload route spreads that answer, so the flag reaches the browser.
  - The media screen says "<file> was archived. It's back in your library now."
  - If the un-archive fails (other than on a store without migration 0025), the upload fails with it. An archived row is never handed back.

### 5. Mapper (MIG-01)

- **`mapPages`** now works out the normalized section list once (a kind-less row is a text section, empty rows dropped) and maps that same list. So "stored" (`storedId(normalized[j])`) and the section it renames (`mapped[j]`) always come from one list. A length check guards the pairing. `legacyPageSectionsToSections` normalizes the same way, so handing it the normalized list changes nothing it returns.
- **The weak "local sqld control plane is accepted" case is replaced by two cases:**
  - **A real local `sqld` control plane.** On port `TEST_MIGRATE_MAP_SQLD_PORT`, 7160 in my runs, else a free port. The case applies the platform schema and migrations, then copies the store `mmapcli`'s control-plane row into it. The command then runs that store (not `_default`) with `PLATFORM_DB_URL` pointing at the sqld:
    - it exits 0 and reports the same digest as through the file control plane;
    - a store only the file control plane holds is "no store", which proves the sqld is the one read;
    - the sqld is stopped and its folder removed afterwards.
  - **A hosted control plane with a local store.** The store `mmapcpl` runs with no flags against the local control plane (the control case). With the control plane set to `libsql://mmap-platform.invalid` it is refused, and the refusal names the control plane (not the store) and `--hosted --confirm mmapcpl`. This holds with no flags, with `--confirm` alone, and with `--confirm` for another store. Nothing is printed, the URL and token are not shown, and the store's file is byte-identical.

## Acceptance, with evidence

| Acceptance item | Status | Evidence |
|---|---|---|
| unit: a failed drainAll in the full sync enqueues a search_reindex job | Pass | `test-search-effective`: "P4-FIX2: when the full sync's drain fails after the reopen…". A publish's job runs and is done. Then a full sync's page import holds the old name while a fast drain writes the new one; the reopen makes that row pending; the drain fails. One new job, with a key of its own, is pending; running it puts the live name in search with nothing pending. On the base `lib/sync.js` this case **fails** (`{"indexed":260,"failed":0}`, no `requeued`). A second case: a full sync whose drain succeeds enqueues no job |
| unit: the archived-draft filter, the 24-pin cap and the closed-store guard each fail a test when removed; pairs and template degrade while the content row fails closed | Pass | Removing `archived_at IS NULL` from `readEntityDraft` fails "P4-FIX2: an archived product content document's draft never previews" (`test-preview-overlay`). Removing `.slice(0, 24)` fails "home rail pins on a documents store…". Removing `src.mode === "closed" \|\|` from `entityRow` fails "a closed store (PUB-06) reads no live row…". Putting `entityRow` back in pairs and template fails "a failing live-row read…" (`test-entity-content`, part 6; each mutation run: 16 passed, 1 failed) |
| unit: the preview overlay lists a showing product or collection draft | Pass | `test-preview-overlay`: "P4-FIX2: the frame is told a product or collection draft is showing…": `overlay.docs` holds the product draft (`dh_ovl07`) and the collection draft with their hashes; an unreadable draft is in `skipped`, not `docs`, and its page shows the live row; none is in `overlay.documents`. On the base `resolve.js` it **fails** |
| unit: gallery duplicate and cap; a legacy mixed-usage delete never offers a choice that cannot succeed and shows no raw codes; an archived file is never handed back silently by the byte dedupe | Pass | `test-media-picker`: removing either line of `addImage` fails "addImage refuses an image already in the list…". With the base `MediaAdmin.js`, the two new legacy cases and the updated documents-store case **fail** (3 failed). `test-media-refs`: "P4-FIX2: bytes that match an archived file bring it back on purpose and say so…" **fails** on the base `lib/media.js` (no `unarchived`), and with the un-archive removed altogether it fails along with P4-MEDIA's own case |
| unit: mapPages stored ids align; the control-plane cases run a non-_default tenant | Pass | `test-migrate-map`: "P4-FIX2: mapPages reads 'stored' from the same list it renames…" fails when `stored` is read from the unfiltered list (61 passed, 1 failed). It **passes on the base `map.js` too**: the old code was aligned already, because `legacyPageSectionsToSections` happened to filter the same way; the change makes it one list by construction. The sqld case fails when `127.0.0.1` stops counting as local in `migrate-documents.js`; the hosted case fails when the control-plane check is removed (each tried, then restored) |
| unit: pnpm test passes | Pass | See Tests |

## Tests

- `pnpm test` (sqld ports: `TEST_PUBLISH_PORTS=7161,7162`, `TEST_PRODUCT_CONTENT_PORTS=7163,7164`, `TEST_PUBLISH_SERVICE_PORTS=7165,7166`, `TEST_PUBLISH_UNDO_PORTS=7167`, `TEST_MIGRATE_MAP_SQLD_PORT=7160`): 96 of 96 suites passed in 178.6 s.
- `pnpm build`: exit 0. Turbopack printed only its 2 existing warnings (files traced whole-project in `/api/errors` and `/api/platform/*`). No `node:` import was added to `lib/` or `components/`; `lib/sync.js` imports `lib/platform/jobs.js` on demand, as `lib/catalog/search-reindex.js` already does.
- New cases: `test-search-effective` 2, `test-entity-content` 3, `test-preview-overlay` 2, `test-media-picker` 3 (and one case's words updated to the fixed words), `test-media-refs` 1, `test-migrate-map` 3 (one weak case replaced).
- Mutations tried (each restored): the sync change reverted; the archived filter, the pin cap and the closed guard removed; the degrade reverted; the overlay change reverted; each `addImage` line removed; `MediaAdmin.js` and `lib/media.js` reverted; the un-archive removed; `stored` read from the unfiltered list; and two CLI checks in `migrate-documents.js`. Each was caught as listed above, except the `mapPages` revert (see Acceptance).

## Known limits

- **The product page still shows the error page when its live row can't be read.** The modules and badge read the same row in the same request, and they fail closed by design. So `entityRowOrNone` keeps the pairs strip and the template from failing on their own, but the row's own read failure still fails that page. The MIG-02 check, the collection template and any page that reads only pairs or the template now degrade.
- **Collection pins still fail closed.** `collectionPinsFrom` calls `entityRow` directly, as the brief named only pairs and the template. The legacy `collectionPinsByHandle` swallows errors, so a failing `collection_content_live` read still gives a collection page the error page.
- **The data check and a degraded read.** In the MIG-02 check, a failing live-table read now makes the pairs and template routes answer as "no row" instead of erroring. If the legacy side has none either, that difference is not seen. The product override route still errors, so the check is not silent about a broken table.
- **The frame lists every dirty product and collection draft**, not only the page's own. The editor only reads its own document's entry, and each listed draft is the one that shows on its own page. The cost is one statement plus a `previewDraftBody` check per dirty entity draft, in a founder's preview only.
- **A full sync whose drain keeps failing** enqueues one new job each time it runs. Each job retries with the queue's backoff. The number is bounded by how often full syncs run.
- **The picker's own upload** (`MediaPicker.js`, not this item's) does not show the "back in your library" words. The file it gets is never archived, and the media screen does show them.
- **On a legacy store whose file is used only by page documents**, the refusal dialog still offers "Archive it instead". A store without migration 0025 refuses that in plain words (P4-PICKER's limit, unchanged).
- **`mapPages`.** Its new test does not fail on the old code, which was already aligned. It pins the alignment against a future change.
- **`--hosted` is never passed.** The accepted path (a hosted control plane with `--hosted --confirm`) is shown only by the code. The tests prove it is needed: refused without it, and with `--confirm` alone or for another store.
- **The sqld case needs `sqld`**, as `test:publish` does. When `sqld` is missing the case fails; it never skips.

## Owner checks

- On the design harness or staging, in desktop Chrome:
  - **The media screen of a legacy store.** Delete a file used by an old home section and by a page draft. Expect no "Delete anyway", the fixed words, and the places in plain words.
  - **The media screen of any store.** Upload a file whose bytes match an archived file. Expect "<file> was archived. It's back in your library now."
  - **The editor.** Open a product with an unpublished draft in the editor, and save. Expect the frame to report the preview as up to date once the product page shows the draft.
- **Typesense tenants:** after a search outage that overlaps a full sync, check that a `search_reindex` job with a `:sync:` key runs and that search shows the published names.
- **CI sqld download** (unchanged by this item): `test:migrate-map` now starts a `sqld`, as `test:publish` does. CI already needs the sqld download. Its source and checksum need the owner's approval; nothing under `.github/` was changed.

## From review

(empty until reviewed)
