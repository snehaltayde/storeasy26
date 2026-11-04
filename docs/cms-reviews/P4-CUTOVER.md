# P4 · CUTOVER · Moving a store to the new editor (MIG-01, MIG-02, MIG-03)

Branch `cms/p4-cutover`, cut from `dbce19a` (`cms/phase-1` with batch 4 merged). Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 5, 7, 8, 9, 15 and 16; sections 0 to 3 and 5; batch 5) and `P4-BATCHES.json`. Requirements: MIG-01 (backfill), MIG-02 (the data check as the hard gate, the rehearsal), MIG-03 (preconditions, lock, flip, refusals, resume), MED-03 (`release:<id>` refs at cutover), ED-05 (old screens and writers after the move), OVL-17 (outbox rows at the flip, the reindex kick).

This is the author's own report. Reviewers should re-read the code.

## Files

In the plan's list: `lib/migrate/cutover.js`, `backfill.js`, `preconditions.js`, `flip.js`, `runs.js` (all new), `lib/migrate/check.js`, `report.js`, `map-entities.js`, `scripts/migrate-documents.js`, `scripts/test-migrate-documents.js` (replaces SCAFFOLD's placeholder; no `package.json` change), `scripts/test-legacy-write-guard.js`, `app/api/admin/sync/route.js`, `app/api/jobs/sync-catalog/route.js`, `app/api/platform/tenants/[id]/route.js`, `lib/cms/store.js`, `lib/releases.js`, `docs/cms-reviews/P4-CUTOVER-RUNBOOK.md`, this packet. `lib/cms-mode.js` is in the list and was not changed.

Beyond the list (see Known limits): `scripts/test-writers.js` and `scripts/test-documents.js` (one allowlist line each), `docs/cms-reviews/drills/P4-CUTOVER/` (the drill script, its results and screenshots).

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js` (imported only), `scripts/drills/p3/*`, `lib/migrate/map.js`, `state.js`, `ids.js`, `render-compare.js`, `allowed-differences.js`, `scripts/migrate-render.mjs`, the untracked `docs/CMS_*.md` files, the two named `.claude/worktrees`. No migration. No new dependency. Nothing under `lib/migrate/` uses a `node:` API, and no storefront route imports it; the three routes changed are `nodejs` routes and only gained a branch.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 177.6 s. `test:migrate-documents` 57 passed, 0 failed (about 13 s, one local sqld behind the Hrana fault proxy included). `test:legacy-write-guard` 66 passed. `pnpm build` passes (its one warning is the old `next.config.mjs` NFT trace) |
| Browser verified | Yes, on the design harness in desktop Chrome (`next dev` on `localhost:6100`, sqld on 7100 to 7103, seeded `--p4`): the rehearsal on a copy passed (75 routes compared, 357 getter calls), then the real-shaped move of the harness store passed, and the canaries showed the same text, sections and templates before and after in Chrome at 1440 px; 19 passed, 0 failed (`docs/cms-reviews/drills/P4-CUTOVER/results-cutover.json`) |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. `--hosted` was never passed. The staging batch-atomicity check and every real move are owner steps (runbook) |
| Production enabled | **NOT DONE.** Nothing pushed or merged; no real or hosted store moved |

## What and why

MIG-01 to MIG-03 need a command that moves one existing store from the old editor to the new one with nothing a shopper notices, that refuses when it isn't safe, and that can be resumed or stopped from any step. MAPPER built the mapping and a read-only dry run; SEAM, OVL07 and EQUIV built the comparisons. This item is the move itself, the owner's runbook, and the fixes the earlier reviews assigned to it.

## Design

### The steps (`lib/migrate/cutover.js`)

Each step is recorded in the run row (`cms_migration_runs.step`, `lib/migrate/runs.js`), so a run resumes from any of them.

**Preconditions, checked by the tool before anything is written** (`lib/migrate/preconditions.js`), each a plain refusal with a code for tests:
- the mode: a store already on the new editor is refused with "This store already uses the new editor, so there is nothing to move…" (every new store after P4-PROVISION); an open move needs `--resume`; any other open run (a reversal) is "being updated by another run";
- hosted: a database (or control plane) not on this machine needs `--hosted --confirm <id> --backup-ref <iso>`; the backup time must be a full ISO time, not in the future, at most a day old; `--hosted` on a local store is refused;
- the ledger holds 0021 to 0025; no catalog sync run is `running`;
- the dry run (`report.js dryRun`, the very function the command's `--dry-run` prints): its refusals (pending schedule, live read in error, approvals, agency access, a type with content and no editor, the "no release" flag, a slug collision) under their own codes and words, then its verdict must be "Ready to move";
- an archived document holding a mapped id (archive is terminal; see Known limits);
- the digest given equals this dry run's digest;
- the rehearsal report: this tool's, this store's, passed, its data check clean and its page comparison clean (compared more than 0 pages, every canary 2xx/3xx before), and its `sourceHash` equal to the store's current one. A store not open yet passes with "nothing published" and every page "Opening soon" after.

**a. Lock.** One batch: `legacyGuardStatement()`, a check that the pointer is still the one read (else nothing happens: "Someone published on the old editor just now"), `cms_state` → `migrating` (an upsert, so a table with no row works), and the run row, whose report JSON holds the live release id read at the lock (0024 is pinned). A lost answer whose resend meets its own lock is found by reading the run row back.

**b. Recheck after the lock.** The pending schedule and the live read, with `classifyState`; the pointer still the one read; and (fix round 1) the source hash: the store is mapped again after the lock (`mapForRun`) and its `sourceHash` must equal the one the dry run, its digest and the rehearsal were checked against before the lock (`report.sourceHash`, also the run row's `source_hash`). An edit or a publish on the old editor in the window between that read and the lock (the whole precondition dry run, data check included) is caught here: "The store changed since the dry run, ... Run the dry run and the rehearsal again, then start the move again." (`RECHECK_SOURCE_MOVED`). That mapping is reused by the backfill. `mapForRun` reads the paused store as the legacy store it still is in both `state.mode` and the raw `cms_state` row, so with nothing changed its hash is the dry run's. A failure finishes the run (`stopped`) and puts the store back on `legacy` in one batch under `migratingGuardStatement(run)`, then refuses in plain words. Then this store's pending `publish_release` jobs are deleted from the queue (their releases can't publish any more; the queue would only dead-letter them). Done after the recheck, so a refused move never cancels a founder's real schedule.

**c. Backfill** (`lib/migrate/backfill.js`), from a fresh mapping of the current legacy source (`mapForRun`: the store reads as migrating, which this run holds, so it is mapped as the legacy store it still is). In chunks, every batch led by `migratingGuardStatement(run)` and ended by the step update (`backfill:<n>`):
- documents: an UPSERT per document, draft and draft hash from legacy. A row already there whose draft differs is first saved as a kept version (kind `undo_saved`, note "Kept from before the move to the new editor", id content-addressed in its own namespace), only while the row still has the revision and draft read; the update is guarded by that revision and leaves an equal draft untouched (no revision bump), so a re-run writes nothing. `published_*` is not written here.
- versions (kind `migrated`) with `ON CONFLICT(id) DO NOTHING` (content-addressed ids), their refs via `refRowsForBody`, the kept versions' refs, and `release:<id>` rows (`releaseRefRows`) for every retained release row.
- live rows: an UPSERT of the legacy-derived columns only (`modules`, `badge`, `pairs`, `pairs_title`, `layout_template`; `pinned`, `layout_template`) from `liveRowFor` (via `map-entities.js`); `published_at` is the release's or the lock time. A live row the plan doesn't hold (left by an aborted run) is deleted when it has no overlay column, else only its legacy-derived columns are cleared.
- never `INSERT OR IGNORE`. After each chunk its rows are read back and compared with the plan (ids, hashes, bodies, columns); a mismatch stops the run with a report, the store still paused.

**d. Data check (MIG-02, the hard gate).** `check.js dataCheck` with `entities: "live"` (the entity getters read the backfilled live rows) over `routesFor` plus `entityRoutesFor`, legacy against the candidate, run while catalog sync is parked. Any difference finishes the run as `stopped`, puts the store back on legacy, and names the changes by page and product in plain words.

**e. Flip** (`lib/migrate/flip.js`), ONE batch under `migratingGuardStatement(run)`: the v4 release `rel_mig_<list hash>`; the pointer flip guarded on the pointer still being the live release at the lock, the release row holding this list, and every listed version present with its document and body (then the `release_state` id 2 abort when it matched nothing); `published_at`; one `migrated` log row per published document (ids from release, document, version and lock time; `release_id` null for product and collection content); `documents.published_*` for every mapped document; a hook for REVERSE's overlay restore; one `search_outbox` row (reason `cutover`) per product whose live row was written or cleared; `cms_state` → `documents` with `cutover_release_id` = the release at the lock (or NULL); the run step `flipped`. A store not open yet keeps no pointer (the same guard checks it is still NULL) and is closed until its first publish. A failed batch is read back: landed (the answer was lost) is a success; a guard abort with the run still open is "the live store changed after the update started", nothing switched, the store still paused.

**f. theme_pin.** `{ versions: [the doc_design version], releaseId, now }` through `after-commit.js themePin` (imported, not edited) in the store's context (never `_default`), then RE-READ from the control plane (`json_type` tells a null pin from none), one retry. A failure is reported, the run stays open at `flipped`, and `--resume` writes it again. Skipped on a rehearsal copy.

**Search.** `kickSearchReindex()` (P4-SEARCH) after the flip and again on resume; its answer is reported; a failure never undoes the move (the rows wait for the next full sync).

**g. Finish.** The run row gets the report and outcome `done`: counts (documents new, changed and same, versions, kept, refs, release refs, live rows written and cleared, log rows, outbox rows, publish jobs cancelled), the kept drafts by name, unresolved redirects, the `cms_templates` count, dropped product extras, the theme pin and search results, and the flip time. `renderCutoverText` prints it in the plain layout, then Details.

**h. Stuck in "migrating".** `--status` (read only) prints the mode, the open run's step in plain words, when it started and how long, and what to run next (the command line itself is added by `scripts/migrate-documents.js`; `lib/` text carries no developer words, `test:copy` checks that). `--resume` continues an open run from its step (a pre-flip step whose mapping still hashes the same skips ahead; otherwise backfill, check and flip run again); with no open run it starts a new one with the full preconditions. `--abort`, before the flip only, is one batch under `migratingGuardStatement(run)`: mode `legacy`, run `aborted`. Backfilled rows stay (legacy wins next time; shoppers never read them on a legacy store). After the flip it refuses and names the reversal tool.

### The rehearsal (`--rehearsal-run`)

`runRehearsal` runs every precondition except the digest and the rehearsal report, captures the "before" pages right before the lock, runs steps a to g on the copy (no control-plane write: no theme pin, no job cancel, no search), captures "after", and compares them with `render-compare.js` and `ALLOWED_DIFFERENCES`. It checks itself that more than 0 pages were compared and that every canary of the before capture answered 2xx/3xx (P4-EQUIV's finding), whatever P4-FIX4 adds to the CLI. The command (`--db <local copy> --base <harness> --routes --out`) uses `scripts/migrate-render.mjs`'s capture and writes `rehearsal.json`: tool, store, `sourceHash`, digest, data check and page results, `passed`.

### The command (`scripts/migrate-documents.js`)

`--dry-run` (MAPPER's, now through the shared `dryRun`), `--rehearsal-run`, the move (`--dry-run-digest`, `--rehearsal`, and for a hosted store `--hosted --confirm --backup-ref`), `--status`, `--resume`, `--abort`. With no database address set it refuses in plain words (and creates no file): `TURSO_DB_URL`/`DATABASE_URL` for `_default`, `PLATFORM_DB_URL` for any other store. The move asks for its digest and rehearsal before reading anything. The runbook gives `node --env-file=.env.local scripts/migrate-documents.js …`.

### The review findings assigned to this item

- **P4-GUARD:** the three sync routes handle `action: "skipped"` (no `run.id` read; the admin and platform routes answer 409 with `SYNC_PAUSED_MESSAGE` and audit it as skipped; the jobs route reports `skipped`). `upsertContentPage` sends the page and its redirect statements in ONE `runLegacyBatch`; each redirect statement acts only when the statement before it changed a row (`changes() > 0`), so a lost compare-and-set changes no redirect either (a first version keyed on revision and time failed its own test: two saves in one millisecond). The `page_redirects` probe counts a view too, so a view over a missing table still fails the save (`test:failure-matrix`). `cancelScheduledRelease`'s delete rides behind the legacy guard. Pending `publish_release` jobs are cancelled at the lock. A test pins that `modeAbortError` never carries a cause (infraKind null) for every mode and wording.
- **P4-SEAM:** `dataCheck` refuses a bodies map with a null or undefined entry (`assertHeldBodies`).
- **P4-FIX1:** the cart handle stays in the cart document, so rehearsal and cutover release ids are not compared; only `sourceHash` is. The digest precondition uses the same `dryRun` (routesFor plus entityRoutesFor, once each) as the printed dry run; tested.
- **P4-OVL07:** modules with an empty title or html and badges of only spaces are counted (`holds.modulesEmpty`, `badgesBlank`, `dropped` by product and side) and named by product in "What shoppers will see change". Old module HTML that today's sanitizer rewrites is NOT added to `allowed-differences.js` (not mine, and not accepted by the owner): such a store is "Not ready" and the report names the product.
- **P4-EQUIV:** the rehearsal checks compared > 0 and the before canaries itself.
- **P4-FIX2/OVL07:** the runbook's post-checks say what shoppers see on a documents store when a live-row read fails.

## Acceptance, with evidence

"Fails without" names a mutation from the table under Tests, or a case that was red before the code.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Unit: on each 8.11 state fixture (v1, v2, v3, open with --store-open, not launched), the move ends in documents mode and every resolved* getter and the rendered canaries equal the legacy outputs; ALLOWED_DIFFERENCES imported and asserted | **DONE** | `test-migrate-documents` part 1: a real rehearsal on a file copy (seen under its own host) passes, then the move; 77 getter routes compared with `check.js sameAnswer`; 9 canaries (home, about, journal, four products, two collections) rendered in-process from the real page modules with Next's SWC and compared with `render-compare` and `ALLOWED_DIFFERENCES`; the not-launched store is closed (no pointer, every canary "Opening soon", nothing published, drafts carried). The list itself is asserted (ids, reasons, fixtures that differ without and match with). Interpretation: for "not launched" the legacy outputs are drafts the operator says nobody sees, so the expected result is the closed store (spec 8.11) |
| 2 | Unit: twice and crash-resumed after every step pair and every backfill chunk: identical rows, no extra versions or log rows; with the fault proxy shoppers see old or new at every point | **DONE** | Part 2: a crash after `locked`, `rechecked`, each of the 4 chunks, `backfilled`, `checked`, `flipped`, `pinned`, `searched`, then `--resume`: every table the move writes equals one clean move's, row for row; an abort after the backfill then a new run equals one run. A local sqld behind `hrana-fault-proxy`: every batch of the move loses its first answer after committing (lib/db.js resends; 8 or more), the move finishes once (one release, one log row per published document, one run), and a shopper snapshot after every step and chunk equals the old store or the new one; a second case drops the flip batch before it reaches the database. Fails without: M7 (lock reconcile) |
| 3 | Unit: stale backfill takes the NEWER legacy content; the older draft kept and counted; a phase-3 random-id row reused; a slug collision refuses before the lock | **DONE** | Part 3 (on a v1 store, where the overrides and pins are live): newer hero, page title, badge, modules and pins move; kept versions for the home, about page and product (holding the older bodies), counted and named in the report. The phase-3 product row is the one document and its live row names its id. The collision refuses with no run row and nothing written. Fails without: M3 |
| 4 | Unit: every refusal by test, before and after the lock | **DONE** | Part 4, one case each: missing 0025, a sync running, a pending schedule and a live read error before the lock and planted after it (unlocked to legacy, run `stopped`, nothing backfilled), approvals, agency, a type with content and no editor (cart ruled off), an edit and a publish on the old editor between the proofs' read and the lock (the `beforeLock` seam: unlocked to legacy, run `stopped` with the approved source hash, nothing backfilled, the old editor saves again, a fresh dry run and rehearsal then move the store), no flag, stale and missing digest, missing/failing/other-store/bad/stale-hash rehearsal (passed false, pages differ, 0 pages, a broken canary, a data difference), hosted without `--hosted`, wrong `--confirm`, missing or bad `--backup-ref`. Fails without: M2, M6, M19, M21 |
| 5 | Unit: a planted data-check difference stops before the flip, back to legacy, no live release change; the check runs while catalog sync is parked | **DONE** | Part 5: a badge changed in a live row before the check: stopped, legacy, pointer unchanged, no v4 release, the change named ("Badge Serum"); a sync requested inside the check answers `skipped` with no run. Fails without: M4 |
| 6 | Unit: release:<id> rows after the move; a file used only in a v3 rollback target is reported used and can't be deleted | **DONE** | Part 6: `document_refs` holds `release:rel_old_v3` for the file; `mediaUsage` lists it; `deleteMedia` refuses with and without force; the file stays. Fails without: M5 |
| 7 | Unit: theme_pin written for a design with a kit (setThemePinWriter + makePlatform), re-read, reported; a failed write reported and redone on resume | **DONE** | Part 7: one write, for this store, read back from the control plane (kit, version, release); "Recorded." A throwing writer: run open at `flipped`, `--status` says the last steps didn't finish, `--resume` writes it. Fails without: M8 |
| 8 | Unit: after the move old screens redirect (ED05), legacy writers refuse in-batch, /api/admin/releases 409 for publish, schedule, rollback | **DONE** | Part 8: the mode is `documents` (ED05's redirect condition); every legacy page's `legacyPageHref` names a document that exists; the upsells destination is the cart document; `setBlock` and a page save refuse in their own batch (`inBatch`, 409) with nothing written; `handleReleasesPost` answers 409 with the new-editor words for all three |
| 9 | Unit: --status, --abort before the flip, --abort after it, --resume after an abort | **DONE** | Part 9: the status words (step, "2026-11-04 10:00 UTC, 42 minutes ago", what to run, plain, read only); abort: legacy, run `aborted`, the live release never changed, an old writer saves, a sync starts again, `--resume` starts a second run that takes the newer legacy edit; after the flip: refused, names the reversal tool; nothing open: "nothing to stop"; an open run refuses a new move without `--resume`. Fails without: M15 |
| 10 | Unit: a pointer moved after the lock makes the flip abort with no change | **DONE** | Part 10: every table equal to its state at the hook; still paused; no v4 release. Fails without: M1 |
| 11 | Runbook check | **DONE** | Part 11 reads the runbook for the PITR command and `--backup-ref`, the quiet window and the founder warning, status/resume/abort, `pnpm reverse:documents` and "supported way back", "loses every order", "verification copy, not a backup", the `--env-file` command, `tenant:migrate -- --all`, `--check --include-env`, batch atomicity |
| 12 | Unit: a store already in documents mode refused before the lock with the plain words; the flip's outbox rows drained by the spy client | **DONE** | Part 12: refused, nothing written, no run. With a spy Typesense client and dummy localhost values: one `cutover` outbox row per live product, all done, every moved product's handle upserted, only this store's collection; a failing client is reported and the move stands. Fails without: M14, M20 |
| 13 | Unit: the CLI refuses with plain words when no database URL is set and never creates local.db | **DONE** | Part 13: four commands in an empty folder with no database variables: exit 1, the words and the `--env-file` hint, nothing printed, the folder still empty |
| 14 | Unit: a sync request on a migrating store with no earlier run answers the paused words, no 500; a page save with a mode flip writes nothing; pending publish_release jobs cancelled at the lock | **DONE** | Part 14: the admin route answers 409 with `SYNC_PAUSED_MESSAGE`, audited `skipped`, no run; jobs: this store's gone, another store's kept. `test-legacy-write-guard` 1b: one batch for the page and its old addresses, a flip right before it writes nothing (both modes), a lost compare-and-set writes no redirect, `cancelScheduledRelease` refused in its batch. Fails without: M9, M10, M11, M16, M17 |
| 15 | Unit: the precondition reproduces the dry run's digest; dropped empty modules are named | **DONE** | Part 15: the digest printed by the command is accepted; routesFor alone gives another digest (refused). Two empty modules and a blank badge: counted (4 and 2, both sides), `modulesLeftOut` unchanged, the sentence names "Empty Module Tee", the move refuses (`NOT_READY`). Fails without: M13 |
| 16 | Drill (harness --p4): rehearsal on a local copy passes, then the real-shaped run passes; canaries match before and after in desktop Chrome | **DONE** | `docs/cms-reviews/drills/P4-CUTOVER/drill.mjs`, results 19 passed, 0 failed: the store copied into a second local sqld (58 tables, 4,922 rows) and its control-plane row pointed at it; `--rehearsal-run` passed (75 pages the same, `hero-test-variant` set aside for the running hero test, 357 getter calls, 0 differences) with the store's own database untouched; the row pointed back; Chrome at 1440 px before; dry run "Ready to move"; the move with the digest and rehearsal report: v4 release live, `cutover_release_id` the old live release, one finished run, "Recorded.", "Search is being updated."; Chrome after: the home page, the chosen product (editorial template, badge), the pinned collection (sidebar), the journal and the redirected post show the same text, sections and templates; a shopper capture of all 75 routes before and after compares the same; `--status` "uses the new editor". The demo seed's agency access was removed first, as the dry run asked |

## Tests

| What | Result |
|---|---|
| `node scripts/test-migrate-documents.js` | 58 passed, 0 failed (about 13 s) |
| `node scripts/test-legacy-write-guard.js` | 66 passed, 0 failed |
| `node scripts/test-migrate-map.js` | 62 passed, 0 failed (MAPPER's suite, unchanged, through the shared dry run) |
| `pnpm test` | 96 of 96 suites passed in 176.0 s after fix round 1 (first build: 177.6 s; a first run failed `test:copy`, developer words in `lib/migrate` text, and `test:failure-matrix`, a `page_redirects` view skipped by the table probe; both fixed, see Design) |
| `pnpm build` | passes; one warning, the old `next.config.mjs` NFT trace |
| Drill | 19 passed, 0 failed |

Mutations (`…/scratchpad/p4-b5/P4-CUTOVER/mut/run.py`: one change, the suite, the file restored). Every one failed at least one case:

| # | Mutation | Failed |
|---|---|---|
| M1 | flip: no pointer guard | the pointer-moved case |
| M2 | no recheck after the lock | the schedule and live-read-error cases |
| M3 | no kept version | stale backfill (and three cases that build on it) |
| M4 | data-check differences ignored | the planted difference |
| M5 | no `release:<id>` refs | the rollback-target file |
| M6 | rehearsal source hash not checked | the rehearsal refusals; the CLI case |
| M7 | lock: no lost-answer reconcile | the fault-proxy case |
| M8 | pin read back always "same" | the failed pin case |
| M9 | publish jobs not cancelled | the jobs case |
| M10 | page and redirects in separate batches | the one-batch case (`test-legacy-write-guard`) |
| M11 | the sync route reads `run.id` when skipped | the paused-sync route case |
| M12 | bodies map not checked | the null-body case |
| M13 | empty modules not counted | the dropped-modules case |
| M14 | a documents store not refused | the already-documents case |
| M15 | abort keeps the store migrating | five cases (abort, twice, the after-lock refusals) |
| M16 | `cancelScheduledRelease` unguarded | both modes (`test-legacy-write-guard`) |
| M17 | redirect statements not gated on the page write | the lost compare-and-set case |
| M18 | the backfill writes the overlay `title` | the legacy-columns-only case (added after this mutation first survived) |
| M19 | the digest not compared | the stale digest and the digest-reproduction cases |
| M20 | the flip writes no outbox rows | both search cases |
| M21 | the source hash not compared after the lock (fix round 1) | the edit-or-publish-in-the-gap case ("edit: not moved: expected false, got true"); the case was red on the round-0 code the same way |

## Known limits

- **Two files beyond the plan's list, one allowlist line each.** `scripts/test-writers.js` (GUARD's) and `scripts/test-documents.js` (MEDIA's) scan for writes to `documents`, `document_versions` and `publish_log` outside `lib/documents/`. The cutover writes them by design (decision 5: `lib/migrate/*` writes its own statements under the migrating guard), so `lib/migrate/` is allowlisted in the first and `lib/migrate/backfill.js` and `flip.js` by name in the second. The orchestrator should add both files to this item.
- **A third: `docs/cms-reviews/drills/P4-CUTOVER/`** (the drill script, its results JSON and ten screenshots). The drill script sits there, not under `scripts/drills/p4/` (DRILLS' stages in batch 7); DRILLS may move it into `run.mjs`.
- **Serving a restore-drill copy to the harness is done by hand.** The rehearsal needs the copy served by a local Next server under the store's own id and config (so its `sourceHash` matches). The drill loads the copy into a second local sqld and points the store's control-plane row at it; the runbook (step 3) says what to do but there is no one-command tool for the owner's own copy (a restore-drill file plus a copy of the store's control-plane row). DRILLS' literal runbook drill should turn this into exact commands.
- **"Kept" versions are kind `undo_saved`** with the note "Kept from before the move to the new editor": `VERSION_KINDS` (0021) has no `kept` kind. They show in the editor's earlier versions and don't count toward `KEPT_CAP`.
- **An archived document under a mapped id refuses the move** (`ARCHIVED_DOCUMENT`). Archive is terminal (P3), so the backfill never brings one back. It can only happen on a re-cutover after a page was deleted in the new editor; P4-REVERSE may want its own answer.
- **In-process canaries render the page modules, not the layout.** Header, footer, menus, brand and the announcement are compared as getters; the real layout is in the Chrome drill. A closed store is rendered as the layout's `StoreClosed` branch.
- **Resume redoes rather than trusts.** A resume from a pre-flip step re-maps the store; if the mapping hashes differently (a webhook changed a cart product's handle, for example) it backfills and checks again. The counts in the report add up across passes as an approximation (a second pass sees the first pass's rows as "same").
- **Webhooks carry on while a store is migrating** (OQ-5). A catalog change mid-move that alters the plan stops the run before the flip ("the store's content changed while it was being copied"); `--resume` carries on.
- **Old module HTML the sanitizer rewrites is not an allowed difference** (not accepted by the owner): such a store's dry run says "Not ready" and names the product; it can't move until that module is saved again in the old editor.
- **The not-launched store's data check doesn't run** (nothing is published), and its rehearsal passes on "every page shows Opening soon after".
- **`--rehearsal-run` accepts any database on this machine as `--db`**, including a local store's own (the harness store, in the drill, is the real-shaped store). A hosted store is never local, so a rehearsal can't write one.
- **`--resume` and `--status` on a hosted store** need `--hosted --confirm` (the command's own check) but not a new backup time; the run keeps the one it started with.
- **The control plane writes (theme pin, the job cancel, the search job) are not in the store's batch**, as spec 8.11 accepts for brand and theme: a failure is reported and redone on `--resume` (the pin) or by the next full sync (search).
- **Hosted batch atomicity** (the guards, `changes()` gating) is proven on file databases and sqld only; the staging check is an owner step.

## From review

- **Fix round 1 (blocker): the move could carry content the dry run and rehearsal never saw.** The digest and the rehearsal's source hash were checked against a read taken before the lock, the backfill mapped the store again after it, and nothing compared the two: an edit (`Store.setBlock` in `beforeLock`) moved with the report and `cms_migration_runs.source_hash` still naming the old hash; a publish in the window would have gone live unrehearsed. Fixed in the recheck step (b): the post-lock mapping's `sourceHash` must equal `report.sourceHash`, or the store goes back to the old editor with plain words. Making that comparison exposed that `mapForRun` hashed the raw `cms_state` row as `migrating`, so it never equalled the dry run's hash; it now reads it as `legacy` like `state.mode`. Test: part 4, the edit-or-publish-in-the-gap case (red before, M21).

## Owner checks

- **Staging, before the first real move:** hosted Turso batch atomicity (runbook step 0.3).
- **PITR:** confirm the Turso plan has point-in-time restore; record the time just before each real move (`--backup-ref`).
- **Per store:** the dry run read with the founder, a rehearsal on a restore-drill copy served by the local harness, the real move, the post-checks (runbook steps 1 to 7). The serving of the copy needs the store's control-plane row copied locally (Known limits).
- **OQ-5:** webhooks keep writing products while a store is migrating. OK?
- **Sanitized module HTML:** accept it as an allowed difference, or have the founder save those modules again before the move.
- **Hosted theme pin:** the move writes the control plane (the founder's store look for the operator screens); check the platform console shows the kit after each move.
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum (nothing under `.github/` changed).
- **Phone and Safari:** not run (desktop Chrome only).

## Commands

```
node scripts/test-migrate-documents.js            # pnpm test:migrate-documents
node scripts/test-legacy-write-guard.js
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 COPY_SQLD_PORT=7103 PLATFORM_CACHE_MS=1000 \
  node docs/cms-reviews/drills/P4-CUTOVER/drill.mjs
pnpm test
pnpm build
```
