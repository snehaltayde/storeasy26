# P3 · COMMIT · One commit core for publish, Undo and take offline, plus the phase 3 API

Branch `cms/p3-commit`, cut from `407b88a`. Plan: `docs/cms-reviews/P3-PLAN.md` (decisions 1 to 4, critiques A1 to A4, B1, B3, B7, B8) and `P3-BATCHES.json`. Requirements: PUB-04, PUB-03, PUB-02, PUB-11, PUB-05. Migration: `0023_document_refs.sql`.

Two commits:
1. `2338e7f`: the pure move of the build helpers into `lib/documents/build.js`, with no change in behaviour.
2. The extensions, the migration, the API, the stubs and the tests.

No real store changes mode. Legacy stores, today's releases, the editors and preview work as before. `releases.js` and the legacy APIs are not touched.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 129.2 s. `pnpm test:publish`: 72 passed in 5.8 s (sqld part 5.2 s). `pnpm test:publish-service`: 58 passed in 1.7 s. `pnpm test:api-shapes`: 26 passed in 0.1 s. `pnpm test:schema-compat`: 34 passed. `pnpm build` passes. After the pure move alone (commit 1), `pnpm test` gave 81 of 81 in 137.3 s, with test:publish at 52 of 52 and test:publish-service at 40 of 40, the same counts as before the move |
| Browser verified | Not applicable. This item has no screen: nothing a shopper or founder sees changed, and every acceptance line is a unit line. No dev server ran. sqld and the proxies ran on ports 4600 to 4607 only, and all of them were stopped |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso (owner check below) |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed |

## What and why

Batch 2 builds Undo, take offline, the publish checks and the changes list at the same time. Each one needs the same guarded commit. Without this item, Undo would need the private helpers in `publish.js`, which P3-CHECKS owns in batch 2, and it would fork the commit core.

This item:
- moves the helpers into one shared module;
- extends the build and the commit with every field Undo and take offline need, inside the same guarded batch;
- adds `document_refs`;
- parses every phase 3 API operation, so no batch 2 item edits the dispatcher.

## Design

### 1. `lib/documents/build.js` (new)

**The pure move (commit 1).** These moved out of `publish.js` as they were: `readLive`, `liveFrom`, `liveEntryOf`, `sameEntry`, `readVersionBodies`, `makeBuild`, `slugClash`, `journalIndexOf`, `failedError`, `pageRow`, `redirectsOf`, the four message constants, `MAX_ATTEMPTS`, and the test hooks (`setBuildHooks`). `publish.js` re-exports `setPublishHooks`, the constants and `__publishInternals` under their old names.

The rebuild loop is now `runGuardedBuild(buildFn, { live, log, items, onLost, done })`:
- `buildFn({ attempt, live, refs })` makes each attempt's build and may throw a refusal, such as a slug clash.
- `onLost({ attempt, live, next, sent })` returns one of this call's own builds that went live late, throws a conflict, or returns null to rebuild.
- The ok, unknown, failed and busy mapping and the log lines are the same as before.

**The extensions (commit 2).**
- **`makeBuild(live, items, ctx)`.** Each item may carry:
  - `action`: publish (the default), unpublish or undo;
  - `offline: true`;
  - `draft {body, hash, slug, label}`;
  - `published {versionId|null, hash|null}`;
  - `undone`;
  - `expectPublished`;
  - `extraVersions`;
  - `undoesLogId`, `savedVersionId` and `note`.

  `ctx` gains `release` (from the slug check) and `refs`. Every version id is fresh. When an item gives no `published`, `published_hash` is `documentHash(body)`, never the version's `body_hash`.
- **Take offline.** The item's `body` is the last live body. A fresh version of it keeps the list entry. Its pages row is `enabled: false`, or for a journal post its index entry is `enabled: false` (through `nextJournalIndexBody(prev, changes, { disabled: [id] })`). The body is not edited, so its `documentHash` is unchanged. Its redirects are left out of the list. The pointer fields default to null. A later publish writes the redirects again from the body.
- **`liveEntryOf`.** An offline entry comes back as `{ version, hash, offline: true, liveBody: null }`. `publish.js` then gives the validator and `classify` no live body, so the inherited rule never applies to an offline page.
- **Slugs.** `slugClash(list, journalEntries, items, { archived })` returns `{ error, release }`. A disabled entry whose document is archived doesn't hold its slug. When the set claims that slug, the document is listed in `release`, and `makeBuild` removes its entry: `setEntries` remove, plus the index entry for a post. `checkSlugs` reads which holders are archived. That costs one statement, and only when a disabled entry holds a slug the set wants. A disabled entry of a document that is not archived still holds its slug. Archive is terminal: a grep test shows nothing sets `archived_at` back to NULL.
- **`draftSlugOwner(slug, exceptId)`.** One statement: `SELECT id, label FROM documents WHERE slug = ? AND archived_at IS NULL AND id <> ?`.
- **`hasRefsTable()`.** Reads `sqlite_master` once per publish and remembers only a yes, per tenant, in the isolate. `runGuardedBuild` asks once per call and passes `refs` to `buildFn`. When the table is missing, it logs `document_refs_missing`, and the build leaves the refs out.
- **SLUG_TAKEN.** When the commit reports `failed SLUG_TAKEN` (a draft rewrite onto a slug another draft holds), `runGuardedBuild` answers 409 `SLUG_TAKEN` with `{ slug, other: { id, title, label } }`, naming the other page through `draftSlugOwner`. It is never `DB_REFUSED` and never a 500.
- **After commit.** Every build that went live, whether ok or found live after a lost answer, runs `runAfterCommit({ build, items })` once, before the answer.
- **`NotBuiltError`.** A `DocumentError` with 501 `NOT_BUILT`, used by the stubs.

### 2. `lib/documents/commit.js`

These are new per-document fields, all inside the one guarded batch:
- **`published {versionId, hash}`.** The older `published_version_id` and `published_hash` keys still work.
- **`undone`.** Sets `undone_version_id`. When it is absent, the column is left as it is.
- **`expectPublished`.** Adds `published_version_id IS ?` to that document's guard term in the flip: `(SELECT revision FROM documents WHERE id = ? AND published_version_id IS ? [AND archived_at IS NULL]) = ?`.
- **`draft {body, hash, slug, label, by, at}`.** The documents UPDATE sets exactly `service.draftWrite`'s columns (`DRAFT_COLUMNS`: draft, draft_hash, slug, label, `revision = revision + 1`, updated_at, updated_by), in the same statement as the pointer fields. The guard then also needs `archived_at IS NULL`, as `draftWrite`'s own WHERE does.
- **`extraVersions`.** These are `undo_saved` only (BAD_BUILD otherwise). They are inserted `ON CONFLICT(id) DO NOTHING` next to the versions and counted by the flip guard. The reconcile's clash check counts them too. They are kept out of `liveListHoldsMine`, and `runGuardedBuild`'s `sent` map holds `versions` only. A comment in both files and a test pin this.
- **`refs`.** `INSERT INTO document_refs … ON CONFLICT DO NOTHING`, 200 rows per statement, after the documents UPDATE. They must name this build's versions (BAD_BUILD otherwise).
- **Log rows.** These already carried `action`, `undoes_log_id` and `saved_version_id`. `makeBuild` now fills them.
- **SLUG_TAKEN.** A `UNIQUE constraint failed: documents.slug` inside the batch is `{ failed, code: "SLUG_TAKEN", slugs, documents }`, checked before `DB_REFUSED`.

`buildProblems` checks every new field's shape before any database call.

### 3. Migration 0023

`document_refs(version_id, ref_type, ref_id, PRIMARY KEY (all three))`, plus these indexes:
- `document_refs_target(ref_type, ref_id)`;
- `publish_log_set ON publish_log(set_id) WHERE set_id IS NOT NULL`;
- `publish_log_undoes ON publish_log(undoes_log_id) WHERE undoes_log_id IS NOT NULL`;
- `publish_log_recent ON publish_log(created_at)`.

Everything uses `IF NOT EXISTS`. There is no backfill: phase 2 versions have no refs rows. P3-HARNESS re-seeds through publish, and MIG-01 owns the legacy backfill.

### 4. `lib/documents/refs.js` (new; pure and edge-safe)

**`refRows(versionId, body)`.** Reads every section through the registry's `refsOf`, plus the document's own settings through `refsOfSetting` (menus, the announcement link, the collections lists). The rows are unique and sorted. The ref types are:

| ref_type | Made from |
|---|---|
| `document` | A page link: its document id when it carries one, else `slug:<family>:<slug>`. The family comes from the link's href, because the registry's ref leaves it out. A url link to `/about`, `/contact`, `/policies/x`, `/campaigns/x` or `/journal/x` gives the same slug key |
| `collection`, `product` | Links, pickers and lists, by handle |
| `media` | The media src |
| `bundle`, `quiz` | Url links to `/bundles/<x>` or `/quiz/<x>` |
| `offer` | Listed, but no setting refers to an offer yet |

**`linkersStatement(documentId, slugKey)`.** One statement over `document_refs JOIN documents ON version_id = published_version_id`, without the document itself and without archived documents.

### 5. `lib/documents/paths.js` (new; pure, no imports)

`livePath(type, meta)` gives:
- `/` for home and every singleton;
- `/about` and `/contact` for those two page slugs, else `/policies/<slug>` for a page;
- `/campaigns/<slug>` for a campaign;
- `/journal/<slug>` for a journal post;
- `/` for a type with no address of its own.

`liveExitUrl(path)` is `/api/preview?exit=1&to=` + `encodeURIComponent(path)`, and only a root path is accepted.

### 6. `lib/admin/documents-api.js`

The order stays parse (400) → authorize (401/403) → mode (409) → 428 → module.
- **New operations.**
  - `unpublish {id, dryRun?}` and `undo {id, logId, dryRun?}` need a top-level revision.
  - `undoSet {setId, members: [{id, logId}], dryRun?}` is refused (400) with a top-level revision.
  - These three are under `storefront.publish`, so staff get 403.
  - `listRecentlyPublished {limit?}` (1 to 50, default 20; `true` also works) and `listChanges {id}` are under `storefront.read`.
  - `keepLiveSection {id, sectionId}` (needs a revision) and `keepAsEarlierDraft {id, body}` (no 428) are under `storefront.write`.
- **Pass-through.** The parser copies `dryRun`, `logId` and `confirmRepublish`. A malformed value is a 400. For the seven new operations, the dispatcher passes the whole parsed op and `{ actor }` to `lib/documents/undo.js` or `changes.js` and sends their `{ status, body }` as it is. `publish` and `publishSet` items carry `confirmRepublish` through to `publish.js` (`checkSet` keeps it; nothing reads it yet).
- **Mode.** Writes are checked as today, with the publish words for the publish-shaped ones. The two new reads call `getCmsMode` themselves and answer 409 `STORE_USES_LEGACY` ("…so this isn't available here yet.") on a legacy or migrating store. `getDocument`, `listDocuments` and `listHistory` have no mode check, as today.
- **Access.** `getDocument`'s document and every `listDocuments` row carry `access { canPublish, reason }`, from `roleAllows(role, "storefront.publish")`. The staff reason is "Only the store owner or an admin can publish. You can edit and preview." Support gets "Only the store owner or an admin can publish."
- **Words.** A malformed publish, publishSet, unpublish, undo or undoSet says "…so nothing was published…".
- **Test hook.** `setDocumentsApiModules({...})` lets a test spy on a module, like `setPublishHooks`. Production never calls it.

### 7. Stubs

`lib/documents/undo.js` (`undo`, `undoSet`, `unpublish`, `listRecentlyPublished`) and `lib/documents/changes.js` (`listChanges`, `keepLiveSection`, `keepAsEarlierDraft`) throw `NotBuiltError` (501). Each header copies the signature, the op shape and the outcomes from the shapes file.

### 8. Export, schema compat, the contract

- `document_refs` is in `EXPORT_TABLES`. On a tenant without it, it is recorded as null.
- `scripts/test-schema-compat.js` gains `BEFORE_REFS = "0022_preview_sessions"` and `REFS = "0023_document_refs"`, and a documents tenant at 0022 that creates, saves and publishes through the real handler. It gets no refs before 0023 and refs after it.
- `lib/admin/documents-api-shapes.js`, following the From review list in `P3-SCAFFOLD.md`:
  - the header describes `requestOptional` and `sameOutcomesAs`;
  - the anchor example is `f-sec_hero-title` and `where` is "Hero · Title";
  - `setId` is never null;
  - every `publish_log` action has its words: publish "Published", unpublish "Took offline", undo "Undid", scheduled "Published on schedule", restore "Restored", migrated "Moved to the new editor";
  - `updatedBy` and `updatedByName` are optional on publish conflicts until P3-CHECKS adds them;
  - `COMMON.malformedPublish` is new.
- `scripts/test-api-shapes.js`:
  - reads every `lib/documents/*.js` file together for its source checks;
  - compares the dispatcher's 200 bodies by the keys of their object literals, where a key added in phase 3 may be present or not, so adding `liveUrl` in batch 2 is a shapes question, not a red suite;
  - checks the 401 and 403 words against `lib/admin-auth.js`;
  - checks the new words (legacy read, malformed publish, NOT_BUILT, the access reason);
  - checks that every request example now parses, and that `dryRun`, `logId` and `confirmRepublish` are copied;
  - checks the status of a p3 outcome that reuses a code of today.

  `NOT_BUILT` is no longer a "new" code, since `NotBuiltError` emits it.

## Acceptance, with evidence

"Fails without" names a mutation from the scratch runner (`…/scratchpad/p3-b1/P3-COMMIT/mut/run.py`). Each mutation was applied alone, the named suites were run, and the file was restored. All 26 were caught.

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: every existing test:publish and test-publish-service case is green after the move to build.js and before any extension (two commits; the first is the pure move) | DONE | Commit `2338e7f` changes only `build.js` (new), `publish.js`, the `test-api-shapes.js` file scan and the `test-publish.js` port option. On it, test:publish gave 52 of 52, test:publish-service 40 of 40 (both the same as before), and `pnpm test` 81 of 81 | Not a new behaviour: the proof is that the old cases still pass |
| 2 | unit (sqld): an undo-shaped build commits all or nothing; a lost pointer race leaves no undo_saved, refs or log row | DONE | `test-publish.js` `undoCases`, run on a file database and on sqld through HEAD `lib/db.js`. The case "commits all together" checks the draft, draft_hash, slug, label, revision+1, updated_at, updated_by, undone_version_id, null pointer fields, the undo_saved row, the undo log row with undoes_log_id and saved_version_id, and the refs rows. "Last statement fails" writes nothing. "A lost pointer race" writes no undo_saved, refs or log row and leaves the draft as it was | M1, M4 (the draft column set) |
| 3 | unit (sqld): commit_then_drop replay of an undo-shaped build reports ok through oursPresent with single rows; the busy case gives lost; the flip refuses when an extraVersions row is missing; the P2 'null body or null hash' case still fails whole | DONE | sqld cases: "commit_then_drop once, HEAD lib/db.js, undo-shaped" (the resend loses on the revision it moved, the reconcile says ok, single rows). "commit_then_drop … then a publish on top: ok through oursPresent" (the pointer moved and the list no longer holds the version, so only the release row proves it; single rows; plus the `liveListHoldsMine` pin). "busy case, undo-shaped" (lost, nothing written). "the flip refuses when an extraVersions row is missing" (the statement left out gives the CHECK abort; an id held by another body gives VERSION_ID_CLASH). "null body or null hash" (version body, release hash, undo_saved body) | M1 (the extra version isn't counted) |
| 4 | unit: the commit's draft UPDATE sets the same column set as service.draftWrite; published hash equals documentHash(body) for a body whose section ids differ from another version with equal content | DONE | `test-publish.js` "the commit's draft UPDATE sets exactly the columns service.draftWrite sets" reads `draftWrite`'s SET out of `service.js` and compares it with `DRAFT_COLUMNS` and with the real statement. `test-publish-service.js` "published_hash is documentHash(body)": two bodies with other section ids get one hash, which differs from both versions' body_hash, also through a real publish | M4, M11 |
| 5 | unit: expectPublished that no longer matches makes the batch lose with nothing written | DONE | `test-publish.js` "expectPublished that no longer matches…" (a stale id, and null while a version is live, both lose with nothing written; the matching one commits), on file and sqld | M2 |
| 6 | unit: a draft slug that another non-archived document's draft holds gives refusal SLUG_TAKEN (409), not DB_REFUSED or 500; draftSlugOwner names that document | DONE | `test-publish.js` "…is failed SLUG_TAKEN (not DB_REFUSED)…" (and an archived holder doesn't count). `test-publish-service.js` "a draft rewrite onto a slug…" goes through `runGuardedBuild`: 409 `SLUG_TAKEN`, `other {id, title, label}`, the plain words, the shape of `SHAPES.undo.outcomes.slugTaken`, storage unchanged. `draftSlugOwner` names the holder, not itself, and null for a free slug | M3 |
| 7 | unit: a publish on a documents tenant without 0023 succeeds, writes no refs, logs document_refs_missing; with 0023 every published version has refs equal to refRows(body); linkersStatement returns exactly the live documents linking by id or by slug and ignores drafts and superseded versions | DONE | `test-publish-service.js` "a publish on a documents store without 0023…": exactly one `sqlite_master` statement per publish (counted with `watchStatements`), no refs statement, the log line, and probed again on the next publish. After 0023 the refs are written; once seen, there is no probe. "with 0023 every published version has refs equal to refRows(body)…": a set of 5 (page, campaign, journal post), linkers by id, by slug key and by url, a draft-only linker and a superseded linker ignored, by id only without the slug key. `test-schema-compat.js` repeats it through the real handler on a 0022 tenant | M8, M20, M21 |
| 8 | unit: an offline item (page and journal post) writes enabled:false, keeps documentHash(body) unchanged, drops that document's redirects; liveEntryOf of it returns liveBody null; an archived offline page's slug is released and its entry dropped; a non-archived offline page's slug is still taken; a grep finds no code setting archived_at back to NULL | DONE | `test-publish-service.js`: "an offline page…" (pages row, hash, redirects gone for shoppers too, null pointer, undone set, the unpublish log row, `resolvedContentPage` null; publishing again writes the redirects again). "an offline page is not 'inherited'" (the same live-as-it-is incomplete section warns while live and blocks once offline). "an offline journal post's index entry…" (and the pure override). "a non-archived offline page keeps its slug…; once archived…" (409 naming it, then the entry and row are removed and the slug is the claimer's). "archive is terminal" (a walk over lib, app, components, scripts and migrations: only `service.js` `archive()` writes archived_at, and it writes the time) | M5, M6, M7, M10, M22 |
| 9 | unit: an afterCommit handler runs once after ok, never on lost or failed, and a throwing handler does not change the publish result | DONE | `test-publish-service.js` "an afterCommit handler runs once…": once after ok; never on busy-lost, failed or unknown; once for a late commit found through `onLost`; a throwing handler is logged (`documents_after_commit_failed`), the answer still has the publish 200 shape, and the good handler still ran | M9 |
| 10 | unit: livePath covers home, every singleton, page (about, contact, a policy), campaign and journal; liveExitUrl never contains 'token' and passes the P2-FIX4 destination() check | DONE | `test-publish-service.js` "livePath covers…": every `singletonTypes()`, home, about, contact, a policy, campaign, journal, a type with no address. Each `liveExitUrl` goes through the real `app/api/preview/route.js` GET: a 302 to exactly that path on the store's origin, with the cookie cleared. An absolute URL becomes `/` | M19 |
| 11 | unit (test-publish-service): each new op is 400 when malformed or mixed, 401/403 before mode, 409 STORE_USES_LEGACY on a legacy store (writes and the two new reads), 428 without revision where required, 501 NOT_BUILT from the stub; dryRun, logId and confirmRepublish reach the module; staff get 403 on unpublish, undo and undoSet with storage unchanged; getDocument on a legacy store behaves as before | DONE | Five "P3-COMMIT API:" cases over all seven operations, on documents and legacy stores (and a migrating one for the reads). Each answer is also compared with the shapes file, key by key. A spy module (`setDocumentsApiModules`) receives the exact parsed op, and its `{status, body}` comes back as it is. confirmRepublish reaches publish and publishSet. getDocument on a legacy store gives 404 for no row and 200 for a row, as before | M12, M13, M23, M24 |
| 12 | unit: access.canPublish is false with the plain reason for staff and true for an admin; a malformed publish body's message says 'published' | DONE | "getDocument and listDocuments carry access…" covers staff, admin and owner, on both reads, against the shapes. "each new operation is 400…" covers the publish, publishSet and four publish-shaped malformed bodies | M14, M24, M26 |
| 13 | unit: migration 0023 applies twice cleanly; export includes document_refs and skips it when absent; pnpm test green | DONE | `test-publish.js` "0023 is additive … applies twice cleanly" (IF NOT EXISTS only, a 0022 store misses exactly 0023, two re-runs, the objects, the primary key, the query plans). "tenant export includes…" (document_refs 0 on a current tenant, null at 0020 and at 0022). `pnpm test` 81 of 81 | M15 |
| 14 | unit: scripts/test-api-shapes.js passes against the changed code, and still catches a renamed code or a dropped field | DONE | 26 of 26 against this branch. The pure move itself is the proof that a move between files keeps it green | M16 (renamed `DOCUMENT_DELETED`), M17 (dropped `reason`), M18 (dropped the published item's `hash`), M25 (401 words drifting in admin-auth.js) |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish` | 72 passed (52 before; 20 new) | 5.8 s, of which sqld 5.2 s |
| `pnpm test:publish-service` | 58 passed (40 before; 18 new) | 1.7 s, of which sqld 0.6 s |
| `pnpm test:api-shapes` | 26 passed | 0.1 s |
| `pnpm test:schema-compat` | 34 passed (2 new) | 2.5 s |
| `pnpm test` | 81 of 81 suites, including the legacy ones: test-releases, test-cms-api, test-admin-console, test-sections, test-sections-render | 129.2 s |
| `pnpm build` | passes. Its one warning (the NFT trace through `lib/platform/migrate.js` and the overview route) was there before this branch | |

Ports: `TEST_PUBLISH_PORTS` (new, the same form as `TEST_PUBLISH_SERVICE_PORTS`) and `TEST_PUBLISH_SERVICE_PORTS` were set to 4600 to 4603, and the mutation runner used 4604 to 4607. Other suites in `pnpm test` pick free ports of their own.

## Known limits

- **Two test files outside this item's list were edited, each by a few lines, because this item's own required changes break them.** The orchestrator must merge them with their batch 1 owners.
  - `scripts/test-preview-overlay.js` (P3-CLOSED) pinned 0022 as the newest migration: "a 0021 store misses exactly 0022" and "up to 0022_preview_sessions". It now says "0022 and later", and the newest is read from the list.
  - `scripts/test-documents.js` (P3-VALIDATE) expected `{ unpublish: "doc_home" }` to be `UNKNOWN_OPERATION`. It is now parsed, so a bare id is `MALFORMED` (still 400), and `{ schedule: … }` keeps the unknown case.

  Neither touches lines those owners' briefs name.
- **`publish_log_set` as the brief writes it isn't used by `WHERE set_id = ?` alone.** `set_id` is NOT NULL, and SQLite does not infer "IS NOT NULL" for the partial index. A query must say `WHERE set_id = ? AND set_id IS NOT NULL` to use it. The test pins that form, and P3-UNDO's whole-set read must use it. `publish_log_undoes`, `publish_log_recent` and `document_refs_target` are used as written (the query plans are tested).
- **`liveEntryOf` treats an entry as offline only when its row is `enabled: false` AND the document no longer points at that version.** This is narrower than the brief's wording. A page the founder hid with its own `meta.enabled: false` is still published (its pointer is that version), so the inherited rule still applies to it, as in phase 2. Without the second term, a hidden live page would lose the inherited rule (a regression). Owner ruling below.
- **The registry's `refsOfSetting` drops a page link's `family`** (that file belongs to P3-VALIDATE). `refs.js` reads the family back from the link's href. No section setting refers to an offer or a bundle picker yet, so `offer` rows can't occur, and `bundle` and `quiz` come only from url links. Blocks are not scanned (no kind allows them yet). The refs of the offline copy version are written too, because it is a published version.
- **Refs exist only for versions published after 0023.** Phase 2 versions and the legacy releases have none: P3-HARNESS re-seeds through publish, and MIG-01 backfills. Until then `linkersStatement` misses links that only phase 2 versions hold.
- **The refs probe is one extra statement per publish until 0023 has run, and then none.** The yes is remembered per tenant id in the isolate. A table dropped later would make publishes fail with DB_REFUSED until the isolate restarts. That never happens: migrations are additive.
- **`slugClash` now returns `{ error, release }` instead of a `DocumentError` or null.** The only caller is `publish.js`, and `__publishInternals.slugClash` is not used by any test.
- **Only pages are tested for the slug release.** The code path for an archived offline journal post (removing its index entry) is written but not tested.
- **The commit's draft UPDATE has no revision term of its own.** It relies on the flip's guard in the same batch, which is also why a resent batch loses on the moved revision and then reconciles to ok. `undone_version_id` is left as it is by a plain publish. P3-CHECKS and P3-UNDO decide whether a republish clears it.
- **`makeBuild` mints an extra version's id when none is given.** Undo needs the id for `savedVersionId`, so it must mint fresh ids on every `buildFn` call, never reuse one across attempts.
- **After-commit handlers run before the answer**, so a slow handler slows the publish. They are best effort, and their errors are only logged.
- **`setDocumentsApiModules` is a test hook in production code**, like `setPublishHooks`.
- **`NotBuiltError` lives in `build.js`**, so both stubs and later owners import it from one file that no batch 2 item owns.
- **Support's access reason** ("Only the store owner or an admin can publish.") is my wording. The brief names only the staff reason.
- **The contract is still examples.** `test-publish-service.js` now compares the real answers of the new operations, the access rows and the publish 200 with the shapes, key by key. `test-api-shapes.js` reads object literals from source, so a body built some other way (a helper's return) is checked only by the service suite.

## Owner checks

- **CI sqld download** (standing): `.github/` was not touched. Approving the source and checksum of the sqld binary for CI is still the owner's call.
- **Hosted Turso, on a staging tenant:** one undo-shaped batch (draft rewrite, undo_saved, refs, log) commits all or nothing, and one that loses a pointer race writes nothing. Proven here on a local file database and on local sqld only.
- **Deploy order:** run `tenant:migrate --all --check` (0023) before batch 2's Undo relies on `linkersStatement`. Publishing works without 0023, but refs need it. Re-seed the design harness after 0023 (P3-HARNESS).
- **Ruling:** the narrower offline rule in `liveEntryOf` (above). Should a page hidden by its own meta keep the inherited rule? This branch says yes.
- **Ruling:** the support role's access reason wording.
- **Orchestrator:** merge the two out-of-list test edits with P3-CLOSED (`test-preview-overlay.js`) and P3-VALIDATE (`test-documents.js`). P3-UNDO's whole-set query must add `AND set_id IS NOT NULL` to use `publish_log_set`.
