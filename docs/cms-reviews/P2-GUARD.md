# P2-GUARD: today's content system made safe to run next to documents

Branch `cms/p2-guard`, cut from `319a20f`. Requirements: PUB-01 (the v4 marker
for every legacy reader of a release), DOC-02 (old writers refuse instead of
writing tables the new editor no longer reads). Migrations owned: none.

## Where this stands

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` 66 of 66 suites pass; `pnpm build` passes |
| Browser verified | NOT DONE: every acceptance item is proved by a unit test; no desktop Chrome drill was run (owner check OC-G4) |
| Staging | NOT DONE (owner checks below) |

No real store changes mode. Every store stays on `legacy`; only test stores in
the suites are put into `documents` or `migrating`.

## What and why

Phase 2 adds documents and a v4 release (a list of document versions). Until a
store moves, the old editors, releases and preview must keep working exactly
as before. Once a store moves, those same old paths must not write tables the
new editor ignores (the founder's change would look saved and then never show),
must not flip the live pointer back to old content, and must not show a
meaningless legacy diff ("every block customized") against a v4 release.

The old publish also had a gap of its own: the release row, the pointer flip
and the `published_at` stamp were three separate statements, so a publish that
lost a race or failed half way left an orphan row, or a live row with no stamp.

## The design

1. **`lib/cms-mode.js`** (edge-safe, no `node:` imports of its own).
   - `getCmsMode()` reads `cms_state` fresh on every call. A missing table
     (a store before 0021) is `legacy`, found with `notMigratedYet`. A table
     with no row is `legacy` (the migration seeds the row; spec 8.11 says
     `_default` reads as legacy unless its own row says otherwise). Any other
     read error throws `CmsModeUnavailableError` (infrastructure, 5xx).
   - `assertLegacyContentWrites()` throws `StoreUsesDocumentsError` (409
     `STORE_USES_DOCUMENTS`, plain words, `expose`) when the mode is anything
     but `legacy`, including `migrating` and unknown values.
   - `legacyWritesRefusal()` is the same check for routes that answer with
     `NextResponse` themselves: `null` to go ahead, otherwise
     `{status, body}`. An unreadable mode goes through `infraResponse`, so it
     answers the same 503 the route's own database failures do. It never
     answers "go ahead" on an error.
   - `publishBadgeState()`: the mode and the `documents_dirty` count in one
     statement.
2. **The guard, after parse-then-authorize and before any write**:
   - `lib/admin/cms-api.js`: every non-read op (saveBlock, savePage,
     resetBlock, deletePage, saveTemplate, deleteTemplate, previewCandidate).
     It runs before the 428 revision check, so the editor is told the real
     reason first.
   - catalog POST; upsells POST; upsells/[id] PUT and DELETE; brand PUT and
     reset (the brand preview stores nothing and stays open); theme POST;
     experiments POST when it is an adopt; insights POST when it is an apply;
     partners POST when it is a kit apply (the grant is checked first, so an
     agency can't probe another store's mode, then the mode is read inside the
     target store).
   - Reads are unchanged.
3. **`lib/admin/releases-api.js`**: in a store not on legacy, publish,
   schedule, rollback, cancel, preview and approve are 409
   `STORE_USES_DOCUMENTS` ("This store publishes with the new editor …"). GET
   returns `{documents: true, mode, message, live}` and no legacy diff,
   validation or draft hash, also when the live release is v4. Preview keeps
   working when the mode can't be read (see known limits).
4. **`lib/releases.js`: the guarded flip.** Publish, rollback and the
   scheduled flip are one `libsql.batch(stmts, "write")` each, using the
   GEN-02 guard-and-abort pattern that `lib/documents/commit.js` proved:
   1. (publish only) `INSERT INTO releases … ON CONFLICT(id) DO NOTHING`
   2. `UPDATE release_state SET live_release_id = :new … WHERE id = 1 AND
      (live_release_id IS :expected OR live_release_id = :new) AND EXISTS (the
      release row [with this content hash])`
   3. `INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0` (breaks
      `CHECK (id = 1)`, so the whole batch rolls back)
   4. `UPDATE releases SET published_at = :now WHERE id = :new AND
      published_at IS NULL`
   - `createRelease` reads the pointer first (with the live row's `v`), then
     snapshots and validates. A lost race leaves no row and throws 409
     `PUBLISH_RACE` "Another publish just went live, review again"; the API
     answers it with the fresh view, like `DRAFTS_CHANGED`.
   - On any thrown batch error it re-reads the pointer and its own row: the
     pointer names it, or (publish) its row exists → it committed and the
     answer was lost (a `lib/db.js` resend is an idempotent success through
     `OR live_release_id = :new`). A guard abort → lost race. Anything else →
     the database's own error (5xx). If even the re-read fails →
     `PUBLISH_UNKNOWN`, answered 503 "Your publish may have gone live. Reload
     to check." (never "nothing was published").
   - `rollbackRelease` uses the same flip; refuses a store not on legacy, a v4
     target and a v4 pointer.
   - `publishReleaseById` (the scheduled job): refuses a store not on legacy,
     a missing row and a v4 target, without flipping. When the compare-and-set
     loses on a legacy target it re-reads the pointer and tries again, up to 3
     more times (`SCHEDULED_FLIP_RETRIES`), so the scheduled release still wins
     at its time.
   - `createRelease` also refuses when the live pointer is a v4 row: a legacy
     publish must never flip a documents store back to old content.
   - `getLiveRelease()` returns `{id, v: 4, documents: true, content: null,
     content_hash, published_at, note, message}` for a v4 row.
   - The "one atomic UPDATE" comments are fixed in `lib/releases.js`.
     Migration 0007's comment says the same and is left alone: a migration
     that has run is never edited (plan section 3).
   - Test seam: `__releaseTestHooks.beforeFlip`, called after the pointer read
     and before the batch.
5. **The v4 marker's consumers** show "This store publishes with the new
   editor" and skip the legacy diff and brand checks: `releaseDiff` (returns
   `{documents: true, message, items: [], dirty: false}`), `validateRelease`
   (and `liveContentForCheck`), `brandReadability`, the console releases page
   (a plain note instead of the legacy panel), the storefront overview page
   (badge and description), and the platform overview route
   (`release: {id, documents: true, message, …}`).
6. **Console badge** (`app/(console)/admin/(authed)/layout.js` →
   `publishingBadge()`): in documents mode, one statement that counts
   documents where `archived_at IS NULL AND type NOT IN ('blueprint') AND
   draft_hash IS NOT published_hash` (the `documents_dirty` index's own
   condition); the badge is that count, or nothing at 0. Legacy keeps the dot
   from the draft-vs-live hash compare.
7. **`test-schema-compat`**: its own pin, `BEFORE_DOCUMENTS =
   "0020_sync_runs_resumable"`, kept apart from `OLDER_SCHEMA`.

## Acceptance

"Bites" says what happened when the new test ran against the code without this
change: the base worktree at `319a20f` with only the new tests and the new
`lib/cms-mode.js` copied in (so the tests could load), or a named mutation.

| # | Item | Status | Evidence | Bites |
|---|---|---|---|---|
| 1 | Legacy store (`cms_state` 'legacy', or no table at 0020): every existing test-cms-api, test-cms and test-releases case passes unchanged | PASS | `pnpm test`: test-cms-api 27/27 (20 existing unchanged), test-cms passes, test-releases 43/43 (35 existing unchanged); test-schema-compat "at 0020 …" | No-regression item. The 0020 case fails when the missing-table rule is removed (mutation: 503 DATABASE_NOT_READY) |
| 2 | Documents mode: each listed writer is 409 STORE_USES_DOCUMENTS, re-read rows unchanged | PASS | test-cms-api "with cms_state 'documents', every old content writer …": 20 requests (cms-api ops incl. force save and revision-less reset, catalog product and pins, upsells POST/PUT/DELETE, brand PUT and reset, theme apply, experiment adopt, insight apply, partners kit apply) against real rows; a dump of 12 tables plus the store's config is identical before and after. Also "'migrating' refuses the same way" and "reads are unchanged" | Yes: at base most answered 200 and wrote |
| 3 | Documents mode: /api/admin/releases publish, schedule, rollback, cancel, preview, approve are 409; GET is the marker | PASS | test-cms-api "in documents mode /api/admin/releases refuses …" (rows unchanged, no preview URL minted, GET has no diff) | Yes: at base publish, schedule, rollback and preview answered 200 |
| 4 | Two interleaved legacy createRelease calls: one live, one 409, loser leaves no row, pointer = winner | PASS | test-releases "two legacy publishes from the same pointer, interleaved …" | Yes (no seam at base; both would have gone live) |
| 5 | Forced failure of the published_at stamp inside the batch leaves pointer and releases unchanged | PASS | test-releases "a forced failure of the published_at stamp …" (a trigger aborts the stamp) | Yes: at base the pointer had moved |
| 6 | Scheduled job racing a manual publish still goes live; rollback to v4 is 409; the job for a v4 row fails without flipping | PASS | test-releases "a scheduled legacy release whose job races …" (through the real worker, `runJobById`; attempts 1,2), "rollbackRelease to a v4 row …", "rollback and the scheduled job refuse a store not on legacy …" | Yes: at base the rollback to v4 went through. Mutation `SCHEDULED_FLIP_RETRIES = 0`: the job fails |
| 7 | With a v4 pointer, releaseDiff, validateRelease, brandReadability and the platform overview return the marker or message | PASS | test-releases "with a v4 pointer: getLiveRelease, releaseDiff, validateRelease and brandReadability …" and "… the platform overview gives the documents marker …" (the real route, operator token) | Yes: at base getLiveRelease returned the list as content and the overview had no marker |
| 8 | Documents-mode badge is one statement and reflects draft_hash IS NOT published_hash | PASS | test-releases "the documents-mode Publishing badge is one statement …" (`watchStatements`: 1 statement; dirty, clean, never-published, archived and blueprint rows; count 2, then null; legacy store keeps "•") | Yes (no such function at base) |
| 9 | A cms_state read error other than a missing table makes the guard throw infrastructure (5xx), never allow | PASS | test-cms-api "a cms_state read error other than a missing table …" (cms_state a view over a table that's gone: assert throws `CmsModeUnavailableError`; save, catalog POST and publish answer 503; nothing written) | Yes: at base the save answered 200 and wrote |
| 10 | test-schema-compat: a tenant at 0020 can still save legacy content and publish | PASS | test-schema-compat "the tenant really is at 0020 …" and "at 0020: a legacy block and page save, then a publish, all through the real handlers" | Mutation (missing table not legacy): fails |

## Tests

- `scripts/test-cms-api.js`: +7 cases (P2-GUARD block). Now loads the route
  files, so it registers the `@/` alias hook and runs the platform migrations
  for the agency tables.
- `scripts/test-releases.js`: +8 cases (P2-GUARD block).
- `scripts/test-schema-compat.js`: +2 cases and the `BEFORE_DOCUMENTS` pin.
- `pnpm test`: 66 of 66 suites. The first full run caught one regression of
  mine, fixed before commit: failure-matrix "opening a preview needs no
  database" answered 503, because the preview action now read `cms_state`.
  Preview now reads the mode best-effort (see known limits).
- Suite times on this machine: test-cms-api ~2s, test-releases ~6s,
  test-schema-compat ~2.5s, all far under the 2-minute limit.

## Known limits

- **The mode check is a pre-check (MIG-03).** It is a separate statement
  before the write, not part of it. A cutover that lands between the check
  and the write is not caught. MIG-03 must move the check into each write's
  statement or batch before any real store changes mode. Brand and theme write
  the control plane, a different database, so for them a pre-check is the
  most there can be (spec 8.11 accepts that window).
- **Legacy resetBlock and deletePage stay revision-less** when the editor sends
  no revision (DOC-02; recorded for MIG-03 and ED-05). This packet only
  refuses them in documents mode.
- **Every legacy write now costs one more statement** (the `cms_state` read),
  and so do the releases GET, the console releases page and the badge.
  `validateRelease` called without `opts.live` now always reads the live
  release (before, only when the content had a brand or theme); the console
  pages pass `live` so they don't pay it twice.
- **Preview when the mode can't be read**: the releases API's preview action
  mints its legacy token as before (it never needed the database). On a
  documents store P2-PREVIEW gives such a token no overlay. Every write action
  stays fail-closed.
- **The scheduled job** throws (and the queue retries and dead-letters) for a
  documents store, a v4 target or a missing row. After 4 lost
  compare-and-sets in one run it throws and the queue retries later, which can
  put the scheduled release live after its time under a publish storm.
- **The four bypass writers** (experiment adopt, insight apply, agency and
  theme kit apply) are refused at the route only. P2-WRITERS replaces those
  refusals with a mode-aware facade and the grep guard. A caller of
  `adoptVariant`, `applyInsightDraft`, `applyAgencyKit` or `applyKit` that is
  not one of these routes is not guarded.
- **`createRelease` refuses a v4 pointer even in legacy mode**: only a
  cutover reversal (MIG-04) could produce that state, and it has its own path.
- The console releases page in documents mode is a plain note, not the future
  editor link (no editor route exists yet, ED-02).

## Owner checks

- **OC-G1** Hosted Turso: two concurrent legacy publishes on a staging store
  give one live release and one "Another publish just went live, review
  again"; the releases list shows no orphan row.
- **OC-G2** Hosted Turso: schedule a release, publish manually just before its
  time; the scheduled one is live afterwards.
- **OC-G3** Before any store changes mode: MIG-03 tightens the pre-check into
  the write statements (see known limits).
- **OC-G4** Desktop Chrome on the design harness, a test store set to
  `documents`: the Publishing page shows "This store publishes with the new
  editor", the sidebar badge shows the dirty count, the Storefront overview
  shows the note, and saving in any old editor shows the plain refusal. Not run
  in this packet.
- **OC-G5** CI's sqld download (source and checksum) still needs the owner's
  approval; nothing under `.github/` was changed.

## Files

`lib/cms-mode.js` (new), `lib/releases.js`, `lib/admin/cms-api.js`,
`lib/admin/releases-api.js`, `lib/admin/brand-readability.js`,
`app/api/admin/{catalog,upsells,upsells/[id],brand,theme,experiments,insights}/route.js`,
`app/api/partners/route.js`, `app/api/platform/overview/route.js`,
`app/(console)/admin/(authed)/{layout,releases/page,storefront/page}.js`,
`scripts/test-{cms-api,releases,schema-compat}.js`, this packet.

## Commands

```
pnpm test:cms-api && pnpm test:releases && pnpm test:schema-compat
pnpm test
pnpm build
```
