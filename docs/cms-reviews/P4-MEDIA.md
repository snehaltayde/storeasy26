# P4 · MEDIA · The reference index and the media archive (MED-03, server side)

Branch `cms/p4-media`, cut from `607cde2` (`cms/phase-1`, after P3-FIX5 and P4-SCAFFOLD merged, so `lib/documents/service.js` already carries FIX5). Plan: `docs/cms-reviews/P4-PLAN.md` (decision 6, sections 0 and 3; batch 1) and `P4-BATCHES.json`. Requirement: MED-03. Migration owned: `0025_media_archived.sql`.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed (161.8 s, and 157.5 s on the final tree). `test:media-refs` 19 passed in about 1.5 s. `pnpm build` passes (its two Turbopack warnings about `lib/platform/migrate.js` were there before) |
| Browser verified | Not applicable to this item. Nothing a shopper sees changed, and the console's media screen is unchanged (archive buttons are PICKER and EDITOR work). The route itself is tested through its real handler with a real session. No dev server ran; ports 6120 and 7120 to 7129 were not used |
| Staging verified | **NOT DONE.** Nothing ran against a hosted database. Applying 0025 and running the reindex are owner steps (below) |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

MED-03 says a library file that any kept version, draft, setting or old release still shows must never be deleted, and that the check must be cheap. Before this item:

- `document_refs` held only published versions, and stored a media ref as its raw `src` (`/api/media/med_x`, or a full address with a query string).
- Checkpoints, kept drafts (`undo_saved`) and the first checkpoint of a new document had no refs.
- Images and links written inside rich text, FAQ answers and paragraphs were invisible to the registry.
- `mediaUsage` ran `instr()` over every `document_versions.body` and every `releases.content` on every call, on every store.
- A file could not be archived, only deleted.

## Design

### (1) Extraction

- **`lib/registry/settings.js`.** New `refsOfText(html, field)`: every `<img src>` becomes a media ref, and every `<a href>` a url link ref (`inText: true`). Quotes may be double, single or missing, and `&amp;`, `&quot;`, `&#39;` and `&#47;` are decoded. `refsOfSetting(s, value, path, { text })` uses it for `rich_text`, `paragraphs` and the answers of `qa_list`, **only when `text: true`**. The default is off, so `lib/documents/checks.js` (the publish checks) and `R.refsOf` see exactly what they saw before (see Known limits for why).
- **`lib/documents/refs.js`:**
  - `refRows` asks the registry with `{ text: true }` for every section setting and every document setting, plus each kind's own refs.
  - A **regex belt** over `stableStringify(body)` adds every `/api/media/<id>` the registry missed (an unknown or carried legacy kind, a block, a field nobody declared).
  - **The id form.** `mediaIdOf(src)` reads `<id>` from `/api/media/<id>`, relative, absolute on any host or protocol-relative, ignoring the query and fragment. An image that is not in the library (a Shopify CDN address) gives no row, because there is no file of ours to protect. A media `ref_id` is never the raw src.
  - **Variants** are stored under their own id and folded to their original when usage is read (`media.parent_id`).
  - New exports for CUTOVER: `refRowsForBody(documentId, versionId, body)` takes an object or the stored JSON text, and a text that is not JSON still gets the belt's rows. `releaseRefRows({id, content})` gives the `release:<id>` media rows by regex over the release content. Also `mediaIdOf`, `mediaIdsIn`, `RELEASE_PREFIX`, `refInsertStatements` and `reindexTenant` (see (5)).
- A rich-text link to `/policies/x`, `/products/x` or `/collections/x` now becomes a `document`, `product` or `collection` row. So the take-offline confirm (`linkersStatement`) also names pages that link to this one from inside their text.

### (2) Every version kind is indexed

- **Published:** as before, in the publish batch (`commit.js`).
- **`undo_saved` through Undo:** `makeBuild` now also writes the refs of `extraVersions`. `commit.js` `buildProblems` accepts a ref whose `version_id` is in `versions` or `extraVersions`, and anything else is still BAD_BUILD.
- **Migrated:** a migrated version travels in a build's `versions` (kind `migrated`), so its refs go through the same path. CUTOVER uses `refRowsForBody` for its backfill.
- **Checkpoints and kept drafts written by `service.js`.** Each gets `versionRefsStatements(versionId, body)` in the same batch, which is a conditional `INSERT INTO document_refs … SELECT column1, column2, column3 FROM (VALUES …) WHERE EXISTS (SELECT 1 FROM document_versions WHERE id = ?) ON CONFLICT DO NOTHING`. This covers:
  - `createDocument`'s first checkpoint;
  - the due checkpoint of `saveDraft` (next to `checkpointIfDueStatement`, before the prune);
  - the checkpoint kept before restore, discard and rewrite;
  - `saveVersion`;
  - `keepEarlierDraft` (next to `keptStatement`).

  A checkpoint that was not due, or a kept draft the cap or dedupe refused, leaves no refs (tested). It is never `INSERT OR IGNORE`.
- **The 0023 probe** (`hasRefsTable`) moved from `build.js` into `service.js`, and `build.js` re-exports it. Saves and publishes share one per-isolate memory of it. A store without 0023 writes no refs and saves as before.

### (3) Usage

`mediaUsage(id)` reads the mode (`getCmsMode`).

**Documents mode** (`documentsModeUsage`) runs:
- the file's variants: `SELECT id FROM media WHERE parent_id = ?`;
- `document_refs` JOIN `document_versions` (a ref of a pruned checkpoint never counts), LEFT JOIN `documents` for the name and the live flag. Labels are `live` and `older version`;
- the drafts: `instr(documents.draft, …)` over non-archived documents, one row per document, labelled `draft`;
- `release:<id>` rows JOIN `releases` on `rel.id = substr(version_id, 9)`, so a pruned release never counts. Labels are `live release:`, `scheduled release:` and `retained release:`, as the legacy scan words them;
- the store's brand and site settings, read live (`tenantCfg('brand'|'site')`, through the belt), labelled `brand settings` and `store settings`.

No statement reads `document_versions.body` or `releases.content`, and a counting client proves it. A documents store without 0023 (`no such table: document_refs`) falls back to the old scan.

**Every other store** (`legacy`, `migrating`, or a store from before 0021) runs `legacyMediaUsage`, which is today's code unchanged. Its output is pinned byte for byte against HEAD (see the acceptance table). `scripts/test-releases.js` is untouched and green.

### (4) Migration 0025, archive and delete

- **`migrations/tenant/0025_media_archived.sql`:** `ALTER TABLE media ADD COLUMN archived_at TEXT;`, alone in its file.
- **`archiveMedia(id)` and `unarchiveMedia(id)`** (`lib/media.js`):
  - On a store without the column: 409 `MEDIA_ARCHIVE_UNAVAILABLE`, "Archiving files isn't available for your store yet, so nothing changed. Try again after your store's next update."
  - On a missing file: 404 `MEDIA_NOT_FOUND`.
- **`listMedia({ includeArchived = false })`** leaves out archived originals and their variants. On a store without the column it runs the old select, with the same rows and shape as before.
- **`getMediaFile`** and `/api/media/<id>` are unchanged, so archived files are still served.
- **Re-uploading an archived file** (a content dedupe) brings it back to the library.
- **Route `/api/admin/media`:**
  - `GET ?archived=include` lists archived files too;
  - `PATCH {id, archived: true|false}` archives or brings back;
  - the route's own refusals (`MediaError`) come before `infraResponse`.
- **`deleteMedia(id, {force})`:**
  - **migrating:** always refused, forced or not, with 409 `STORE_MIGRATING`: "Your store is being updated to the new editor right now, so this file wasn't deleted. Try again once the update is done."
  - **documents:** any use refuses, forced or not, with `MEDIA_IN_USE` in plain words. It names the page and its state, "an earlier published version of your store", or "your brand settings", with no ids.
  - **legacy:** force keeps today's meaning, and today's message.
  - **The DELETE guards itself.** `DELETE FROM media WHERE (id = ? OR parent_id = ?) AND coalesce((SELECT mode FROM cms_state WHERE id = 1), 'legacy') = <mode read>`. In documents mode it adds `AND NOT EXISTS` (an indexed version ref, a `release:` ref, a draft using it). A cutover or a publish that lands between the check and the DELETE therefore deletes nothing, and the answer is the refusal. A store with no `cms_state` deletes as before.

### (5) The reindex

- **`reindexTenant(client, { releases, dryRun })`** in `lib/documents/refs.js`. It takes a `@libsql/client`, so it has no database import of its own.
- It reads `document_versions` in rowid chunks of 200 and computes `refRowsForBody`. It deletes that chunk's src-form media rows (`instr(ref_id, '/') > 0`; an id never holds `/`) and inserts the missing rows with `ON CONFLICT DO NOTHING`, one batch per chunk.
- With `releases` it does the same for every `releases` row (`release:<id>`).
- It returns `{ versions, releases, added, rewritten, dryRun }`. It never removes a row it can still find, and never touches documents, versions, releases or media.
- **`scripts/reindex-document-refs.js`** (`pnpm media:reindex`) replaces SCAFFOLD's stub:
  - flags: `--tenant <id>` (required), `--dry-run`, `--releases`;
  - it reads the tenant's database URL from the control plane;
  - it allows `file:` and databases on this machine (localhost, 127.0.0.1, `[::1]`);
  - it refuses anything else unless `--hosted --confirm <that tenant id>` is given, and refuses `--hosted` on a local store;
  - it never prints the address or the token.

### (6) The MANUAL-CHECKS.md:44 decision ("mediaUsage swallows read failures")

The default is recorded here:
- **The documents path fails closed.** Every read in `documentsModeUsage` throws on failure, except `no such table: document_refs`, which falls back to the full scan. A mode read that fails also throws (`CmsModeUnavailableError`). So a delete is never let through on a scan that did not run.
- **The legacy scan's empty `catch { /* pre-migration */ }` blocks are unchanged**, which keeps the legacy output byte-identical. The legacy scan's document part already failed closed (P2-DOCFIX).

## Acceptance, with evidence

All in `scripts/test-media-refs.js` (`pnpm test:media-refs`). "Fails without" means the named HEAD (`607cde2`) file was put back and the suite rerun.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | A rich_text `<img src=/api/media/med_x>` and a FAQ-answer image each give media ref `med_x`; `https://host/api/media/med_x?w=400` is stored as `med_x` | **DONE** | "a rich_text <img src=/api/media/med_x> and a FAQ-answer image each give media ref med_x…": through `refRows` and through the registry (`refsOfSetting` with `{ text: true }`). Also "links and images inside text…". Both fail with HEAD's `settings.js`, and the suite fails to load with HEAD's `refs.js` |
| 2 | Across every section fixture, the registry's media set is a subset of the belt's | **DONE** | "across every section fixture (worstCase of every kind, plus text images and an unknown kind)…" covers 55 fixtures (15 with registry media), each also with images written into its rich text, paragraphs and FAQ answers, plus an unknown kind that only the belt catches. It fails with HEAD's `refs.js` (no belt, so the suite can't load) |
| 3 | A file used only by an older published version shows as used; a ref from a pruned checkpoint is not counted; after Undo to an old version its images are found; an undo_saved version's images are indexed | **DONE** | "a file used only by an older published version…" uses real `publish` and `undo`: `[["older version","doc_home"]]`, then after Undo `draft`, `live` and `older version`, and the Undo-saved draft's file is `[["older version","doc_home"]]` with its refs row. "a ref from a pruned checkpoint is not counted…" prunes after 22 saves and checks that the ref row is still there, usage is `[]` and the file deletes. "createDocument's first checkpoint, a due checkpoint, saveVersion and keepEarlierDraft are indexed by id…". These fail with HEAD's `build.js` + `commit.js` (1 case) and with HEAD's `service.js` (4 cases) |
| 4 | With `force: true`, deleting a file used by a retained version or a `release:<id>` row (written by `reindexTenant --releases`) is refused on a documents tenant; any delete is refused on a migrating tenant | **DONE** | "documents store, force: true: a file used by a retained version is refused, in plain words…"; "documents store: a release:<id> row written by reindexTenant --releases refuses a forced delete…"; "a store being moved: every delete is refused, forced or not, used or not…". Also "the DELETE guards itself…" (a ref, or the move, landing just before the DELETE) and the route test (409 `STORE_MIGRATING`). These fail with HEAD's `media.js` |
| 5 | On a documents tenant a counted client shows usage issues no statement reading `document_versions.body` or `releases.content`; legacy usage output is byte-identical to before, and `scripts/test-releases.js` is unchanged and green | **DONE** | "on a documents store a counted client shows usage issues no statement reading…" (`watchStatements` on the tenant's client, for usage and for a forced delete) fails with HEAD's `media.js`. "legacy usage output is byte-identical to before (frozen from HEAD…)" compares a string literal taken from HEAD on a fixture with blocks, pages, product modules, live, scheduled and retained releases, a draft, live and older versions, and a thumb. It **passes with HEAD's `media.js` too**, which is the proof that the output is the same. `git diff 607cde2 -- scripts/test-releases.js` is empty, and `test:releases` passed 43 of 43 |
| 6 | A tenant at stage 0024 (no `archived_at`) lists and deletes as before, and archive is refused with a plain message; after 0025 an archived file is hidden from `listMedia` and still served by `/api/media/<id>` | **DONE** | "a store at 0024 (no archived_at) lists and deletes as before…": the same row shape, the delete and the dedupe; archive and unarchive give 409 with the plain message; then `migrateTo('latest')`, archive, hidden, listed with `includeArchived`, and **the real `app/api/media/[id]/route.js` GET** through `tenantHandler` and the store's host answers 200 with the bytes. The console route test covers PATCH, GET `?archived=include` and the 0024 409. It fails without 0025 and with HEAD's `media.js` |
| 7 | reindex-document-refs run twice gives identical rows; it refuses a `libsql://` URL without `--hosted --confirm` | **DONE** | "reindex-document-refs: --dry-run writes nothing; a run rewrites src-form media rows…; run twice gives identical rows" runs the CLI as a child process against a fixture platform and tenant, then `reindexTenant` twice more. "reindex-document-refs refuses a libsql:// store without --hosted --confirm <id> (and a wrong confirm)…" checks four refusals, `--hosted` on a local store, no `--tenant` and an unknown store. With HEAD's stub, every CLI case fails (the stub exits 1 with "not built yet") |

## Tests

- **`scripts/test-media-refs.js`:** the suite (it was a placeholder), 19 cases, about 1.5 s, file databases only (`tenant-fixture`).
- **`scripts/test-documents.js`:** one case built a "live" version by hand with a raw INSERT, so on a documents store it had no refs. It now writes that version's refs the same way the publish batch does (`refRows`). The assertion is unchanged.
- **Two files outside this item's list,** each a one-line scope fix (see Known limits): `scripts/test-schema-compat.js` and `scripts/test-publish-service.js`.
- **Proof that the tests fail without the change:** each of HEAD's `media.js`; `refs.js`; `settings.js`; `build.js` + `commit.js`; and `service.js` + `build.js` was put back in turn, and 0025 was removed. The cases named above failed, then passed again with this branch's files.

## Known limits

- **Text refs are off by default in `refsOfSetting`.** If they were on for every caller, `lib/documents/checks.js` would start blocking publishes on links inside rich text that it has never checked (`LINK_TARGET_MISSING` and the like). It would also offer "Remove it" for a missing image in rich text, which acts on the whole field or section. That would be a regression for founders with existing content. The index asks for them (`{ text: true }`). Whether the publish checks should see text links too is for LIVEROW or ED05 (owners of `checks.js`).
- **Documents-mode stores that existed before this code** have no refs for their checkpoints and kept drafts, and published versions from before have media rows stored by src. Their usage reads only the index, so a file used only by such an old checkpoint would read as unused until the reindex runs. Today only test, harness and staging stores are in documents mode (no real tenant has been cut over). **Run `pnpm media:reindex -- --tenant <id> --releases` on every documents-mode store once this deploys** (owner check). CUTOVER's backfill writes the rows for every store it moves.
- **Two test files outside the plan's list were changed,** each a scope fix forced by 0025, with no assertion weakened:
  - `scripts/test-schema-compat.js` (SCAFFOLD's 0024 case): "the runner re-run applies nothing" and "ledger current" now run up to 0024 (`upTo(CONTENT_LIVE)`), because 0025 is a later file.
  - `scripts/test-publish-service.js` (P3-COMMIT's "archive is terminal" grep): it now ignores `UPDATE media SET archived_at…` lines. That grep is about `documents.archived_at`, and a media file can be brought back by design.

  The orchestrator should add both to this item's files.
- **`lib/platform/export.js`** exports media metadata with a fixed column list, so `archived_at` is not in a store export. That file is not this item's; name an owner (it already needs one for the 0024 tables).
- **`package.json`'s `media:reindex`** has no `--env-file=.env.local` (SCAFFOLD's, recorded in its packet). For the owner's hosted run, `PLATFORM_DB_URL` and the token variables must be set in the shell.
- **The console media screen** (`components/admin/MediaAdmin.js`, the picker) has no archive button yet. The picker now simply no longer lists archived files. PICKER and EDITOR own the UI.
- **`mediaUsage` reads the mode first** (one extra statement on every store). If the mode can't be read, a usage preview or a delete now answers with a 5xx instead of scanning. That is the fail-closed default.
- **Refs of pruned checkpoints stay in `document_refs`** as orphans. They never count, because usage joins `document_versions`. The reindex does not prune them.
- **The brand and site settings** are read from the store's config as this request resolved it. Console routes read it fresh.

## From review

(none yet)

## Owner checks

- **Apply 0025** with 0023 and 0024 on every tenant and on the env store before this code deploys: `pnpm tenant:migrate -- --all`, `pnpm migrate`, then `pnpm tenant:migrate -- --check --include-env` must exit 0 (`migrations/README.md`, "Phase 4"). The code also works on a store without 0025: it lists as before, and archive is refused in plain words.
- **Reindex every documents-mode store once after deploy** (staging, the harness store and any test store): `pnpm media:reindex -- --tenant <id> --releases --dry-run`, then without `--dry-run`. On a hosted store add `--hosted --confirm <id>`. Pass: the second run reports `added 0` and `rewrote 0`.
- **On staging, after the reindex:** in a documents-mode store, try to delete an image that only an older version uses. Pass: the dialog lists the page with "(older version)" and the forced delete is refused too.
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum. This item changed nothing under `.github/`.
- **MANUAL-CHECKS.md:44 decision:** confirm the default in Design (6), or ask for the legacy catch blocks to fail closed as well. That would change legacy usage output, and so `test-releases`, which GUARD owns.
