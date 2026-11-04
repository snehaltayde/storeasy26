# P4 · GUARD · The mode check moves into every old write's own batch

Branch `cms/p4-guard`, cut from `607cde2` (P3-FIX5 already merged there, so `lib/cms/store.js` is built on FIX5). Requirements: MIG-03, MIG-02, MIG-04, ED-05. Migrations owned: none.

No store changes mode. Every real store stays on `legacy`. Only file-database test stores in the suites are moved to `migrating` or `documents`.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 158 s. `pnpm build` passes. `test:legacy-write-guard` 60 passed (1.2 s), `test:releases` 50 passed, `test:writers` 23 passed, `test:release-readers` 44 passed |
| Browser verified | **NOT DONE.** Nothing a founder sees changes on a legacy store. The new refusal only shows in the short window between the old pre-check and the write, which a browser can't hit without a test hook. Every acceptance item is proved by a unit test on real file databases. No dev server ran; ports 6100 and 7100 to 7109 were not used |
| Staging | **NOT DONE.** Nothing ran against hosted Turso (owner checks below) |

## What and why

P2-GUARD made every old content writer read `cms_state` first and refuse a store that is not on `legacy`. That read was a separate statement before the write. A cutover that lands between the two lets the old write through, into tables the new editor no longer reads (P2-GUARD known limit, OC-G3). The founder's change would look saved and never show. MIG-03 needs the check to be part of the write itself before any real store changes mode.

Later items also need guards of their own: LIVEROW's live-row, publish and Undo batches must refuse a store that is no longer in `documents`, and the cutover and reversal tools must refuse unless the store is `migrating` under their own open run. The MIG-02 data check also needs the catalog to hold still while a store is being moved.

## Design

### (1) `lib/cms-mode.js`: three guard statements and a classifier

Each guard is one statement that goes first in a write's batch. When the store is in the wrong mode it inserts a second `cms_state` row (id 2). `CHECK (id = 1)` refuses that row, so the whole batch rolls back and nothing is written. In the right mode it inserts nothing.

- `legacyGuardStatement()`: `INSERT INTO cms_state (id, mode, cutover_release_id, updated_at) SELECT 2, 'guard', NULL, '' WHERE EXISTS (SELECT 1 FROM cms_state WHERE id = 1 AND mode IS NOT 'legacy')`. The EXISTS form means a table with no row reads as legacy, matching `getCmsMode`.
- `documentsGuardStatement()`: aborts unless `EXISTS (id = 1 AND mode = 'documents')`. For LIVEROW; nothing uses it yet.
- `migratingGuardStatement(runId)`: aborts unless the mode is `migrating` AND a `cms_migration_runs` row with that id and `finished_at IS NULL` exists. For `lib/migrate/*` only. An empty run id is refused.
- Before 0021 there is no `cms_state`. `hasCmsStateTable()` probes `sqlite_master` and remembers only a yes (per database, the `hasRefsTable` pattern), so a store migrated while warm is guarded at once. `legacyGuard()` gives `[]` there and the old writers carry on. The documents and migrating guards fail on such a store ("no such table"), so it can never take a documents or migration write.
- `isGuardAbort(e)`: the CHECK abort. `release_state`'s pointer guard fails with the same text.
- `classifyAbort(client, error, expectedMode)`: `null` for an error that is no guard abort. Otherwise it re-reads `cms_state.mode` fresh: a different mode gives `{kind: 'mode', mode, message}`, the same mode gives `{kind: 'lost'}`. A mode that can't be re-read throws `CmsModeUnavailableError` (5xx), never a guess.
- Words: `migrating` gives "Your store is being updated. Try again in a few minutes." (`MIGRATING_MESSAGE`). `documents` (or anything else) gives today's `STORE_USES_DOCUMENTS` words.
- `modeAbortError(mode, {doing})`: a `StoreUsesDocumentsError` (409, `STORE_USES_DOCUMENTS`, `expose`) with those words. It carries no `cause`: `infraKind` walks `cause`, and the driver's CHECK error would turn this refusal into a 5xx in the routes.
- `runLegacyBatch(queries, {doing})`: the one helper the old writers use. It takes Kysely queries (compiled, never executed) or `{sql, args}`, sends `[legacyGuard..., ...writes]` as one `libsql.batch(…, "write")`, and returns one result per write. A mode abort becomes `modeAbortError`. Any other failure is the database's own error, unchanged (a uniqueness race still reads as a conflict).
- Test seam: `__legacyWriteTestHooks.beforeBatch`, called after the caller's pre-check and right before the batch.

### (2) Every old content write in one guarded batch

- `lib/cms/store.js`: `setBlock` (insert and compare-and-set update), `deleteBlock` (both forms), `upsertContentPage` (insert, update, the `page_redirects` delete and upsert), `deleteContentPage` (both forms). `numUpdatedRows` and `numDeletedRows` become the batch result's `rowsAffected`, so the 409 conflict logic is unchanged.
- `lib/cms/placements.js`: `upsertPlacement`, `deletePlacement`.
- `lib/catalog-overrides.js`: both writes of `setProductOverride` and both of `setCollectionPins`.
- `lib/cms/templates-store.js`: `saveTemplate` insert and update, `deleteTemplate`.
- `lib/cms/approvals.js`: the `cms_approvals` insert.
- `lib/cms/history.js`: the history insert and its prune. History stays best-effort: a refused append writes nothing and never fails the save it trails.
- `lib/content-writes.js`: its legacy path writes only through `setBlock` and `appendHistory`, so it is guarded through them. Only its header comment changed. A refusal after one block went in still names it in `saved`.
- `lib/releases.js`:
  - `guardedFlip` puts the legacy guard first in its batch. After a failed batch it first checks whether the batch committed (unchanged), then calls `classifyAbort`. A mode abort returns `{mode}`, never `{lost}`.
  - `createRelease` and `rollbackRelease` turn `{mode}` into the 409 mode words, never "Another publish just went live".
  - `createRelease`'s scheduled path writes its release row through `runLegacyBatch`.
  - `publishReleaseById` does not retry a mode abort. It returns `{id, skipped: 'mode', mode}`, so the worker completes the job and stops retrying.
  - These helpers stay legacy-only. Cutover and reversal never call them; `lib/migrate/*` writes its own statements under `migratingGuardStatement`.
- Every existing pre-check stays, for its nicer words.
- The brand and theme routes write the control plane, a different database. They keep their pre-check only (spec 8.11 accepts this window): Known limit.

### (3) The grep guard (`scripts/test-writers.js`)

- A raw write (SQL `INSERT/UPDATE/DELETE/REPLACE` or Kysely `insertInto/updateTable/deleteFrom/replaceInto`) to `cms_blocks`, `cms_pages`, `page_redirects`, `placements`, `product_overrides`, `collection_overrides`, `cms_templates`, `cms_approvals` or `release_state` anywhere outside the allowlist fails.
- Inside the guarded helpers (`lib/cms/store.js`, `placements.js`, `catalog-overrides.js`, `templates-store.js`, `approvals.js`, `lib/releases.js`), a Kysely write must not be executed on its own: the text from the write to the end of its statement may not hold `.execute…(`. Raw SQL writes are allowed in `lib/releases.js` only (`guardedFlip`'s `release_state` statements, which sit behind the guard).
- The allowlist, each entry with its reason:
  - `lib/documents/`: documents publish flips `release_state` under the pointer and documents guards;
  - `lib/migrate/`: cutover and reversal, under the migrating guard;
  - `migrations/`: the schema and its seed rows;
  - `scripts/seed-cms-beastlife.js` and `scripts/perf-docs-fixture.js`: fixture scripts on local databases;
  - test files, `scripts/support/*` and `scripts/drills/*` (the existing `isTest` rule).

### (4) The sync pause (MIG-02), `lib/sync.js`

- `requestCatalogSync` starts, resumes and changes nothing while the mode is `migrating`. It returns `{run: <latest run or null>, action: 'skipped', skipped: 'store is being updated', message}`.
- `runCatalogSync` (CLI and inline) throws the plain `SYNC_PAUSED_MESSAGE` for a skipped request or a paused run.
- `runSyncSlice` reads the mode at the start of every slice. While migrating it returns `{done: false, paused: true, run}`. It takes no lease, reads no Shopify page and writes nothing. The first slice after the mode leaves `migrating` carries on from the stored position.
- Belt: every page batch (`commit`) also carries a pause guard (aborts while migrating). A slice already under way when the store starts migrating writes no further page: it frees its lease and returns `paused` with what it had committed.
- Webhook writes (`syncProductByGid`, `deleteProductByGid`, `writeProduct`, the collection ones) carry on. They change products equally for the old and the new side, so the data check should list them as an allowed difference. This is pending the owner's OK (plan OQ-5).

### (5) Test hooks

- `__legacyWriteTestHooks.beforeBatch` (new, `lib/cms-mode.js`) for every `runLegacyBatch` write.
- `__releaseTestHooks.beforeFlip` (existing) now fires after the guard is prepared and before the flip's batch.
- `__contentWriteTestHooks.beforeWrite` (existing) still fires after the door's pre-check.

**Legacy stores:** behaviour is identical, plus one statement in each write's batch and, once per database per isolate, one `sqlite_master` probe. **Documents stores:** the refusals are unchanged (the pre-checks answer first, with today's words and codes).

## Acceptance, with evidence

"Bites" names what happened when the new test ran with the change taken out. Each mutation was applied to this branch's code, the suite was run, and the code was restored.

| # | Item | Status | Evidence | Bites |
|---|---|---|---|---|
| 1 | For every guarded write site, `guardedFlip`, `createRelease`, `rollbackRelease` and `publishReleaseById`, a hook sets `migrating` (and separately `documents`) after the pre-check. The write is refused with the plain 409 words, the rows are unchanged, `guardedFlip` does not report "lost", and `publishReleaseById` returns `{skipped:'mode'}` after one attempt | **DONE** | `test-legacy-write-guard` part 1 covers 22 sites × 2 modes. Each case runs `assertLegacyContentWrites` (the route's pre-check), the hook flips the mode, and then the write runs. It asserts `409 / STORE_USES_DOCUMENTS / expose`, the exact words, not `PUBLISH_RACE`, and a dump of 11 tables identical before and after. It also has `publishReleaseById` `{skipped:'mode', mode}` with one flip attempt, and `appendHistory` writing nothing and not throwing. `test-releases` has one case per caller of `classifyAbort` per mode: `createRelease`, `rollbackRelease`, and `publishReleaseById` through the real worker (`runJobById`: job `done`, `attempts` 1, pointer unchanged, row not stamped). It also has a case where a lost race on a store still on legacy is still `PUBLISH_RACE` | `legacyGuard()` returning `[]`: 50 of 60 cases fail in `test-legacy-write-guard` and 6 in `test-releases`. Mapping a mode abort to `{lost}` in `guardedFlip`: 6 fail in each suite. Dropping the `{skipped}` return: 2 fail in each |
| 2 | A `cms_state` table with no row is legacy for every guarded writer (EXISTS form); a tenant at 0020 (no `cms_state`) saves through every writer | **DONE** | `test-legacy-write-guard` part 2. "…NO row reads as legacy…" deletes the row and runs every site plus a scheduled flip; each one changes storage. "…at 0020…" uses a fixture tenant at 0020: no `cms_state`, the probe says no, `legacyGuard()` is `[]`, and every site writes. After `migrateTo('latest')` on the warm instance, the next write carries the guard and refuses once the store is `migrating`. "on legacy every site still writes…" checks that the guard is the batch's first statement and the write follows | The guard in `NOT EXISTS … mode = 'legacy'` form: 4 cases fail, including no-row. The probe removed (guard always sent): the 0020 case fails |
| 3 | `documentsGuardStatement` aborts on legacy and migrating; `migratingGuardStatement` aborts without a matching open `cms_migration_runs` row; `classifyAbort` tells a mode abort from a lost pointer race | **DONE** | `test-legacy-write-guard` part 3, on real batches with a following write. Documents guard: legacy, migrating and no-row abort; documents passes; before 0021 it errors ("no such table: cms_state"). Migrating guard: legacy, documents, a missing run and a finished run abort; migrating with an open run passes; before 0024 it errors. Legacy guard: legacy and no-row pass; migrating, documents and an unknown mode abort. `classifyAbort`: a real `release_state` pointer-race abort is `{kind:'lost'}` on legacy and `{kind:'mode'}` once the mode moved. The same error is re-read and becomes lost again after the store returns. A NOT NULL failure gives `null` | New functions: no base to run against. The EXISTS mutation in item 2 also fails the legacy-guard and classifier cases |
| 4 | The grep guard fails on a planted raw write to each listed table outside the allowlist and passes for `lib/documents/*` and `lib/migrate/*` | **DONE** | `test-writers` "P4-GUARD: the grep guard fails on a raw write…". For each of the 9 tables it plants 7 write shapes (Kysely insert, update and delete; SQL UPDATE, INSERT and DELETE via `execute` and `batch`; `insert or replace`). Each is caught in 4 outside paths and allowed in `lib/documents/*`, `lib/migrate/*`, `migrations/`, `scripts/support/` and a test file. An executed Kysely write inside a guarded helper is caught, a compiled one handed to `runLegacyBatch` is not, and raw SQL in a helper other than `lib/releases.js` is caught. The repo scan passes | With the base (`607cde2`) versions of `store.js`, `placements.js`, `catalog-overrides.js`, `templates-store.js` and `approvals.js` put back, the repo scan fails, naming all 5 files |
| 5 | On a migrating tenant `requestCatalogSync` reports skipped and changes no catalog rows. A run started in legacy and flipped to migrating mid-run writes nothing in its next slice and resumes after the mode returns to legacy. Legacy and documents tenants sync as before | **DONE** | `test-legacy-write-guard` part 4, on injected page fetchers and a spy indexer (no Shopify, no Typesense). The migrating case: `{action:'skipped', skipped:'store is being updated'}`, no run row, `runCatalogSync` gives the plain message, catalog identical. Mid-run: slice 1 commits one page and yields. While migrating, the next slice is `paused`, reads no Shopify page, leaves the catalog and the run row identical, and a join is `skipped` with the same run. Back on legacy it completes, with all products and members. The belt case: the store starts migrating while page 2 is being read; that page is not written; the run row shows 1 page and a freed lease; it completes after. A legacy and a documents tenant each run a full sync (4 products, 1 collection). Webhook `writeProduct` and `deleteProductByGid` still write while migrating | Pause removed from `requestCatalogSync`: 3 fail. Slice-start check removed: 2 fail (a Shopify page is read while migrating). Belt removed: the belt case fails |
| 6 | Refusal messages are plain words with no codes or table names (snapshot); all existing suites stay green | **DONE** | `test-legacy-write-guard` "refusal messages are plain words…" pins the exact words for the migrating and documents mode errors (save and publish), the sync pause message and the skip reason. It checks none has an underscore word, a capitalised code, `SQLITE`, `CHECK`, a table name, `id` or a digit, and that `infraKind(modeAbortError(...))` is `null` (routes never read it as 5xx). `pnpm test`: 96 of 96 | A snapshot: changing any word fails it |

## Tests

- `scripts/test-legacy-write-guard.js`: the placeholder is replaced by the real suite. 60 cases, about 1 s, on file-database tenants from `scripts/support/tenant-fixture.js` (all removed at the end).
- `scripts/test-releases.js`: 7 new P4-GUARD cases (50 in all).
- `scripts/test-writers.js`: the grep guard is extended, plus 1 new case (23 in all).
- `scripts/test-release-readers.js`: a fixture change only (see Known limits).
- `pnpm test`: 96 of 96 suites pass. `pnpm build` passes.

## Known limits

- **One file beyond the plan's list: `scripts/test-release-readers.js`.** Its fixtures planted old drafts with `setBlock` and `upsertContentPage` on stores in `documents` (and a `bogus` mode), to prove the readers never show them. The old writers now refuse there, as they should. A small `asLegacy(T, fn)` helper writes those drafts with the mode briefly set back to legacy, then restores it. No assertion changed. The orchestrator should add this file to this item's files.
- **Some routes answer an in-batch refusal with the wrong status.** The catalog POST and upsells POST and PUT answer it with their catch-all 422, using the plain words. Upsells DELETE has no catch and answers 500. These route files are not in this item's list, and their pre-check still answers 409 as before. Only the short window between the pre-check and the write is affected, and nothing is written either way. The routes should map `e.expose` 4xx errors before their catch-all. This is for ED05 or the orchestrator.
- **`upsertContentPage` writes the page and its old-address redirects in separate guarded batches,** as they were separate statements before. A store from before 0011 has no `page_redirects`, and the page write must not depend on it. If the store leaves legacy between the two, the page is saved, the redirect is refused, and the founder sees the refusal words.
- **The two `migrating` messages differ.** The in-batch words are the plan's "Your store is being updated. Try again in a few minutes." The pre-check keeps P2-GUARD's "This store is moving to the new editor right now, …".
- **The scheduled job's pre-check is unchanged.** When `publishReleaseById` starts on a store already off legacy, it still throws (P2-GUARD; "documents tenants: refusals unchanged"), so the queue retries and dead-letters with an alert. Only an abort inside the batch returns `{skipped:'mode'}`. CUTOVER should cancel pending `publish_release` jobs at the lock (P2-GUARD review finding).
- **`cancelScheduledRelease`** deletes a never-published `releases` row with no in-batch guard. `releases` is not in the guarded table list, and the releases API pre-check refuses cancel on a store off legacy.
- **The brand and theme routes** write the control plane and keep their pre-check only (spec 8.11 accepts this window).
- **History is best-effort:** a refused append writes nothing and is silent, as any failed append was.
- **The sync pause and the callers.** `requestCatalogSync` hands back the latest run with `action: 'skipped'`. Its callers read `run.id` (`app/api/admin/sync`, `app/api/jobs/sync-catalog`, `app/api/platform/tenants/[id]`, the connect callback). A migrating store that has never synced would make them answer 500. A store is only moved after its catalog has synced, so this should not happen in practice. Those files are not in this item's list.
- **A paused run in the queue.** `lib/platform/worker.js` (SEARCH owns it in batch 3) requeues a not-done slice at once, so while a store is migrating every tick runs a no-op slice: one `cms_state` read and nothing written. The console's sync view (`lib/admin/sync-view.js`) has no "paused" state, so a long pause can show as slow or stalled.
- **Webhooks carry on while migrating** and are a source of allowed differences for the MIG-02 data check, pending the owner's OK (OQ-5).
- **Cost on legacy stores:** one more statement inside each write's batch (no extra round trip), plus one `sqlite_master` probe per database per isolate. On a store from before 0021 the probe repeats on every write until 0021 is applied. Each sync page batch carries one more statement too.

## From review

None yet.

## Owner checks

- **Hosted Turso batch atomicity (before the first real cutover).** On a staging store, run a legacy save while `cms_state` is set to `migrating`. It must answer the plain refusal with nothing written. This proves the CHECK abort rolls back the whole batch on Turso over HTTP, as it does on the file database and on sqld. This is the plan's section 5 precondition and is not run here.
- **OQ-5:** webhooks keep writing products while a store is migrating. OK, or should they be queued?
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum. Nothing under `.github/` was changed.
- **Desktop Chrome:** no drill was run for this item (see Status). P4-DRILLS can rehearse a store set to `migrating` on the harness: every old editor refuses in plain words, and a sync shows as paused.

## Files

`lib/cms-mode.js`, `lib/cms/store.js`, `lib/cms/placements.js`, `lib/catalog-overrides.js`, `lib/cms/templates-store.js`, `lib/cms/approvals.js`, `lib/cms/history.js`, `lib/releases.js`, `lib/content-writes.js` (comment), `lib/sync.js`, `scripts/test-legacy-write-guard.js`, `scripts/test-writers.js`, `scripts/test-releases.js`, `scripts/test-release-readers.js` (fixture, see Known limits), this packet.

## Commands

```
pnpm test:legacy-write-guard && pnpm test:releases && pnpm test:writers
pnpm test
pnpm build
```
