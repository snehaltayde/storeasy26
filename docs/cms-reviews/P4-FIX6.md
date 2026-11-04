# P4-FIX6: the batch 6 review findings (MIG-04, OVL-17, ED-05)

Branch `cms/p4-fix6`, cut from `08f4b7c` (`cms/phase-1` after batch 6 and its review notes). Plan: `docs/cms-reviews/P4-PLAN.md` and `P4-BATCHES.json` (item P4-FIX6). Requirements: MIG-04, OVL-17, ED-05. Migrations owned: none. The findings come from the "From review" lists in `P4-REVERSE.md` and `P4-FIX5.md`.

This is the author's own report. Reviewers should re-read the code.

Files changed:
- Code: `lib/migrate/flip.js`, `lib/migrate/backfill.js`, `lib/migrate/report.js`, `lib/migrate/reverse.js` (two test hooks only), `lib/platform/provision.js`.
- Tests: `scripts/test-migrate-reverse.js`, `scripts/test-migrate-documents.js`, `scripts/test-product-editor.js`, `scripts/test-provision.js`.
- Docs: `docs/cms-reviews/P4-REVERSE.md` (the orchestrator ruling), this packet.

In the plan's list but not changed: `components/admin/editor/DocumentEditor.js` (its code was already right; the review asked for a test only), `scripts/reverse-documents.js`, `scripts/migrate-documents.js` (its code was already right; the new test runs it as a child process).

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/migrate/cutover.js`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, the runbook, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration. No new dependency.

Safety: only file databases (`.test-*.db` at the worktree root, removed by each suite) and the suites' own local `sqld` on 7121 and 7122 were used. One small page server ran inside the migrate-documents suite on `127.0.0.1:6120` and was closed by the test. No store was moved for real; no `--hosted`; no real Typesense (the reverse suite uses its existing spy with dummy localhost values); the `turso` CLI was never run (the provisioning suite uses its stub). Nothing was written to Shopify. No dev server, no test order. Nothing was left listening on 6120 or 7120 to 7129.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 202.9 s. `pnpm build` passes (its 2 existing Turbopack warnings) |
| Browser verified | **NOT DONE.** Every acceptance item is a unit test that fails without the change (see the mutation table). No desktop Chrome drill was run; owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso, a real `turso` CLI or a real Typesense |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

- **A page that shows as published while shoppers get a 404 (founder-facing).** A page made and published in the new editor, then reversed, then moved again kept `documents.published_version_id` and `published_hash`, although the new live release does not hold it. The editor said "published" with nothing to publish; shoppers got a 404.
- **The reversal dry run's draft line** said "1 unpublished draft stays in the new editor", but after a later move that draft is replaced by the old editor's version and survives only as an older version.
- **Untested guards and steps** in the reversal and the move-again path: each line below could be removed with the whole suite still passing (the review's mutations).
- **The rehearsal command's `heroExperiments` fix** had no unit test.
- **The editor's second `openSeq` guard** (after `await adopt`) had no test.
- **Provisioning:** `sameDbAddress` missed `libsql://` vs `https://`, a different `?authToken=`, and relative vs absolute file paths. A store on another store's database still got registered. The `turso` test seam was an exported setter in the shipped module.

## Design

### (1) Documents the move again leaves out (`backfill.js`, `flip.js`, `report.js`)

- `recutoverPlan` now keeps each published document's `versionId`.
- `applyRestore` sets `mapped.notLive`: every document that holds a published version but is not in the mapping the move puts live (a page made in the new editor, or a page the old editor deleted after the reversal). Entries of `keptPublished` that are also not live carry `notLive: true`.
- `flip.js notLiveStatements(mapped.notLive)`, added to the flip batch right after the mapped documents' own `published_*` updates: `UPDATE documents SET published_version_id = NULL, published_hash = NULL, undone_version_id = NULL WHERE id = ? AND published_version_id IS ?` (guarded on the version planned; nothing can publish while the store is paused). In the flip batch only, so it moves with the pointer or not at all. It also runs in a rehearsal (on the copy it changes nothing shoppers see).
- The editor then shows the page as not published, with its draft still there; publishing it again puts it live (tested).
- The dry run names them. A document already listed under "Published in the new editor before, kept as older versions" gets the extra sentence on that line: "Shoppers won't see it after the move, so the new editor shows it as not published. Publish it there again to show it to shoppers." Any other one (for example a page the old editor deleted after the reversal) is listed under a new heading, "Shown as not published in the new editor after the move", with the same words. The move's own report uses `keptNames`, so it carries the sentence too.

### (2) The draft line (`report.js`)

- Reversal dry run and report: "1 unpublished draft stays in the new editor for now. If the store moves to the new editor again later, the old editor's version wins and this draft is kept there only as an older version." (plural: "these drafts are").
- The founder message: "Your 1 unpublished draft in the new editor is kept there for now. If your store moves to the new editor again later, the old editor's version wins and that draft is kept only as an older version."

### (3)-(6) Reversal tests (`reverse.js` test hooks)

`__reverseTestHooks` gains `beforeLock` (after every precondition, right before the lock batch) and `beforeAbort` (in `--abort`, after it read the open run, right before its batch), so the suite can race a second run or an `--abort` against each guarded batch. Nothing else in `reverse.js` changed.

### (7) The rehearsal command

No code change. The new test runs `scripts/migrate-documents.js --rehearsal-run` as a child process on a file copy of a store, against a small page server on `127.0.0.1` (port `MIGRATE_DOCUMENTS_TEST_WEB_PORT`, else one the system picks) that answers every route with the same page. The route list holds `heroExperiments: ["fix6-hero-test"]`; both captures' `index.json` must record it, and the rehearsal must pass.

### (8) The editor

No code change. The new test holds B's store `open()` (it is hashing an earlier visit's backup of B; the test's `crypto.subtle.digest` waits only for that body), picks C's hero title in the preview (`onPick`), lets C open with that section selected, its field focused and the switch note, then lets B's open finish.

### (9) Provisioning (`provision.js`)

- `dbAddressKey(u)` and `sameDbAddress(a, b)`: the query and fragment are dropped (`?authToken=`, `?tls=`); a remote address is its host (lower case, no user part, no default port) and path whatever the scheme (`libsql`, `https`, `http`, `wss`, `ws`); a file address is its absolute path (relative paths resolve against the working directory as the libsql client opens them; `file:a.db`, `file:./a.db`, `file:/abs/a.db` and `file:///abs/a.db` can match). Empty addresses never match.
- **A shared database stops provisioning.** `create_db` checks an adopted `--db-url` against every registered tenant (any status) before the schema step touches it: the run fails at `create_db` with "Another registered store ("<id>") already uses this database, so this store was not set up on it and the other store was left as it is. Give this store a database of its own." Nothing is registered; the other store's database is untouched (its `cms_state` and its migration ledger are compared in the test). `content_mode` keeps the same check as a belt (a resumed run, or a store registered on the database since) and stops with the same words. `CONTENT_MODE_REASONS.sharedDb` (the old "keeps the old editor" outcome) is gone.
- **The `turso` seam** is now test-only: the module exports no setter; `turso()` uses a function a test puts on `globalThis[Symbol.for("storeasy.provision.tursoRunnerForTest")]` (exported as `TURSO_TEST_RUNNER`). Nothing in shipped code sets it.
- The existing compensation test used acme's database for a second tenant; it now uses its own file (`.test-prov-beta.db`), since that would now stop the run.

## Acceptance, with evidence

"Fails without" names a mutation from the table under Tests (one change, the suite run, the file restored; script `…/scratchpad/p4-b7/P4-FIX6/mut/run.py`).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | unit: a page that is not in the live release after a move-again is never shown as published; the reversal dry run's draft line says it becomes an older version | DONE | `test-migrate-reverse` "P4-FIX6 (1)": a page made and published in the new editor, reversal, the dry run names it with the not-published words, the move: `published_version_id`, `published_hash`, `undone_version_id` all NULL, `getDocument` reads it as not published with something to publish, publishing it again puts it live; the announcement (in the release) keeps its published version. "P4-FIX6 (1b)": a page the first move carried, deleted in the old editor after the reversal: listed under "Shown as not published in the new editor after the move", not counted as a new-editor publish, every not-live version is absent from the new live list, NULL after the move. "P4-FIX6 (2)": the dry run's draft line and the founder message, plain words. Fails without: F1 (1, 1b), F2 (2 and part 3) |
| 2 | unit: each surviving REVERSE mutation now fails a test | DONE | Step 2 abort: "P4-FIX6 (3)" (release renamed in `beforeReverse`: `TARGET_MISSING`, unlocked, documents mode, pointer and live rows untouched, nothing copied, no outbox row) fails with R-S2ABORT. Step 2 guard: "(4a)" (`--abort` lands in `beforeReverse`: `LOST_RUN`, store whole) fails with R-S2GUARD. Abort/unlock guard: "(4b)" (`--resume` finishes the reversal inside `beforeAbort`: the abort is refused `NOT_PAUSED`, store legacy, run done) fails with R-UNLOCKGUARD. Lock guard: "(4c)" (a second reversal locks inside `beforeLock`: refused, exactly one reverse run) fails with R-LOCKGUARD. Published, not draft: "(5)" (published "Pub Name", draft "Draft Only Name": shoppers, the live row and the editor's draft carry "Pub Name"; the draft is an older version) fails with R-DRAFT. `restoreStatements` abort: "(6a)" fails with R-RESTOREABORT. `migrated` skip: "(6b)" (the old editor publishes after the reversal: nothing counted as kept) fails with R-MIGSKIP. Gallery entry: "(6c)" fails with R-GALLERY. Rehearsal: "(6d)" (a rehearsal after a reversal writes no restored column and says so) fails with R-REHEARSAL. `heroExperiments`: `test-migrate-documents` part 16 fails with R-HERO |
| 3 | unit: the second openSeq guard is pinned; sameDbAddress catches the libsql/https, authToken and relative-path forms; a shared database stops provisioning | DONE | `test-product-editor` "unit (P4-FIX6): B's store still opening when the founder picks C's section…" fails with the second guard removed (`select` becomes null after B's open). `test-provision` "unit (P4-FIX5, P4-FIX6): provisioning on a database another registered store already uses stops…" (five spellings incl. relative/absolute/`file://`/`?authToken=`, the wrapper too, plus the comparison table) fails with P-CREATEDB, P-QUERY, P-SCHEME, P-RELPATH; "unit (P4-FIX6): a run that resumes after another store was registered…" fails with P-BELT. The `turso` stub test checks no setter is exported |
| 4 | unit: pnpm test passes | DONE | 96 of 96 suites passed in 202.9 s |

## Tests

| What | Result |
|---|---|
| `node scripts/test-migrate-reverse.js` | 26 passed (12 new; one assertion of part 3 changed to the new draft words) |
| `node scripts/test-migrate-documents.js` | 59 passed (1 new) |
| `node scripts/test-product-editor.js` | 29 passed (1 new) |
| `node scripts/test-provision.js` | 33 passed (1 new, 1 rewritten, 2 adjusted) |
| `pnpm test` | 96 of 96 suites passed in 202.9 s |
| `pnpm build` | passes (2 existing Turbopack warnings) |

Mutations, each one change with its suite run and the file restored. Every one failed at least one test:

| # | Mutation | Failed |
|---|---|---|
| F1 | the flip clears no not-live document | FIX6 (1), (1b) |
| F2 | the old draft line | FIX6 (2), part 3 |
| R-S2ABORT | no abort after the pointer move in step 2 | FIX6 (3) |
| R-S2GUARD | no `migratingGuardStatement` in step 2 | FIX6 (4a) |
| R-UNLOCKGUARD | no `migratingGuardStatement` in the abort/unlock batch | FIX6 (4b) |
| R-LOCKGUARD | no `documentsGuardStatement` in the lock batch | FIX6 (4c) |
| R-DRAFT | restore reads `documents.draft` instead of the published version | FIX6 (5) |
| R-RESTOREABORT | `restoreStatements` without the per-product abort | FIX6 (6a) |
| R-MIGSKIP | `applyRestore` counts `migrated` versions as kept | FIX6 (1b), (6b) |
| R-GALLERY | no `gallery` in `OVERLAY_EDITS` | FIX6 (6c) |
| R-REHEARSAL | the rehearsal restores the edits too (`cutover.js`, mutation only) | FIX6 (6d) |
| R-HERO | the command drops `heroExperiments` | migrate-documents part 16 |
| (editor) | the second `openSeq` guard removed | product-editor FIX6 test |
| P-CREATEDB | no shared-database stop at `create_db` | provision shared-database test |
| P-BELT | no shared-database stop at `content_mode` | provision resume test |
| P-QUERY | the query string kept | provision shared-database test |
| P-SCHEME | remote schemes not unified | provision shared-database test |
| P-RELPATH | file paths not resolved | provision shared-database test |

## Known limits

- **The move's own report** (`cutover.js`, not in this item's files) has no "Shown as not published" heading. For a document published in the new editor its "kept as older versions" line carries the not-published sentence; a page the old editor deleted after the reversal is named only in the dry run.
- **Only a move after a reversal** clears unmapped published documents (`recutoverPlan` applies only then). A first move on a legacy store has no new-editor documents to leave out.
- **The design document** is listed as not live when the old editor's newer release holds no design (seen in the fixture after `createRelease`, whose store has no brand or theme tables filled). That is true (shoppers get the standard look either way, and the data check agrees), but the founder may find the line surprising.
- **The guard races are simulated in one process** through the test hooks, one after another. Hosted batch atomicity stays the runbook's owner check.
- **`sameDbAddress` still compares addresses, not databases.** Two different host names for one Turso database (a custom domain or alias), or a file reached through a symbolic link, are not seen as the same. The check reads the tenant list once, before the step: two provisioning runs on one database at the same moment could both pass it (provisioning is an operator action run one at a time).
- **The stop words name the other store's id** to the operator (the CLI and the platform console only; no founder sees them).
- **The `turso` seam** is a registered symbol on `globalThis`: any code in the same process could set it, but nothing does, and no setter is exported.
- **A stopped provisioning run stays `failed`.** Stopped at `create_db`, it has nothing to compensate; the operator starts again with a database of the store's own.

From review:

- Reviewed cms/p4-fix6 at 0b6e326 against 08f4b7c in a detached worktree, which I removed afterwards. pnpm test on ports 6320 and 7320-7329 passed all 96 suites in 198.1 s. Nothing was left listening on those ports. No edge-runtime code changed: report.js, flip.js and backfill.js gained no node: imports, and provision.js already used node: APIs. Its only route callers (app/api/platform/provisions and tenants) are runtime nodejs. A first move (no finished reversal) is unchanged: recutoverPlan returns applies:false and applyRestore exits before it builds notLive.
- I re-ran mutations and the tests catch the ones that matter. Each of these fails a test: the dry run naming a not-live page twice (the dedupe filter removed), the NOT_LIVE_WORDS suffix removed from keptNames, notLive limited to pages made in the new editor (fails 1b), http/ws not unified with libsql/https, and the second openSeq guard after 'await adopt' in DocumentEditor.js removed (test-product-editor: 28 passed, 1 failed). The builder's own 18 mutation results also match the brief's list.
- Mutations no test catches, all minor: (a) flip.js notLiveStatements without its 'AND published_version_id IS ?' guard; (b) not clearing undone_version_id for a not-live document; (c) provision.js dbAddressKey without removing the user part (user@host); (d) without removing the #fragment; (e) without decodeURIComponent on file paths; (f) the reversal dry run's '0 unpublished drafts' line with no drafts. None of these is an acceptance item.
- The move's own result report (cutover.js flipStep, around line 320) fills restored/keptPublished only. It never lists mapped.notLive entries that are not also in keptPublished: case 1b, a carried page deleted in the old editor after the reversal. The dry run names them, as the brief asks. But after the move, the founder report does not repeat that these pages now show as not published. Suggest adding notLiveNames to the run report later.
- In applyRestore, a document that the mapping holds but with no published version (m present, m.publishedHash null) gets a kept line without the 'shows as not published' words. The existing flip loop already sets its published version to NULL. So the editor is right, and only the dry run's wording is less specific. I did not reproduce this path end to end.
- provision.js: the turso test seam moved from an exported setter to a function under Symbol.for on globalThis. The shipped code still reads it at runtime, and any code in the process can set it. It is no stronger than the old setter, only less visible. This is acceptable under the brief's 'if simple'.
- provision.js dbAddressKey resolves relative file paths against process.cwd() at comparison time. A tenant stored with a relative file: address and compared from another working directory would not match. This only affects local file databases. Turso hosts in regional and legacy spellings (for example db-org.turso.io vs db-org.aws-region.turso.io) are also not treated as one database. This is beyond the brief.
- Behaviour change to note for the owner: provisioning on a database another store already uses now fails at create_db (the wizard and the CLI show the plain-words error). Before, it finished and kept the store on the old editor. The compensation test was rightly moved onto its own database (.test-prov-beta.db) because of this.
- The owner checks the builder listed stand as written: the orchestrator ruling in P4-REVERSE.md awaiting sign-off; staging re-move of a page made in the new editor; founder read of the new draft wording; slow-network browser drill of the openSeq race; staging shared-database provisioning in https:// form; CI sqld source and checksum approval; phone and Safari not run.

## From review

(empty until reviewed)

## Owner checks

- **The reversal ruling:** sign off (or not) the orchestrator ruling in `P4-REVERSE.md`: the reversal needs a matching dry-run digest and no rehearsal, against plan section 0's wording. Needed before the first real reversal.
- **Staging, before the first real reversal and move again:** move a staging store, create and publish a new page in the new editor, reverse, run the next move's dry run: the page is named with "Shoppers won't see it after the move…"; after the move the editor shows it as not published, and publishing it puts it live.
- **The reversal dry run's draft words:** read "…kept there only as an older version" with a founder; confirm the wording.
- **Desktop Chrome on the design harness:** open a product B on a slow connection and, while it is opening, pick a section of another page in the preview; that page opens with the section selected and its field focused, and stays so.
- **Staging provisioning:** provision a throwaway tenant with `--db-url` set to an existing staging store's database in its `https://` form; it stops with the plain words and registers nothing (it stops before touching the database).
- **CI:** the `sqld` download in `.github/` still needs your approval of its source and checksum. Nothing under `.github/` was changed.
- **Phone and Safari:** not run.

## Commands

```
node scripts/test-migrate-reverse.js
MIGRATE_DOCUMENTS_TEST_PORTS=7121,7122 MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120 node scripts/test-migrate-documents.js
node scripts/test-product-editor.js
node scripts/test-provision.js
PORT=6120 DESIGN_PORT=6120 DESIGN_SQLD_PORT=7120 SHOPIFY_OAUTH_PORT=7127 TEST_PUBLISH_PORTS=7121,7122 TEST_PUBLISH_SERVICE_PORTS=7123,7124 TEST_PUBLISH_UNDO_PORTS=7125 TEST_PRODUCT_CONTENT_PORTS=7126,7128 TEST_MIGRATE_MAP_SQLD_PORT=7129 MIGRATE_DOCUMENTS_TEST_PORTS=7121,7122 MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120 pnpm test
pnpm build
```
