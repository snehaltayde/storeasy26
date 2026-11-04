# P3 · UNDO · Undo, whole-set Undo, take offline and Recently published

Branch `cms/p3-undo`, cut from `5bbc819`. Plan: `docs/cms-reviews/P3-PLAN.md` (decisions 1, 4 and 6, critiques A1 to A3, C2) and `P3-BATCHES.json`. Requirements: PUB-04, PUB-05, PUB-02. No migration.

No real store changes mode. Legacy stores, today's releases, the editors and preview are not touched: the only app file changed is `lib/documents/undo.js`, which only the documents console API imports (a test checks this), and that API refuses every write on a store that isn't in documents mode.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. Fix round 1: `pnpm test`: 81 of 81 suites passed in 134.1 s; `pnpm test:publish-undo`: 20 passed in 1.4 s (sqld part 0.5 s). First round: `pnpm test` 81 of 81 in 154.5 s, `pnpm test:publish-undo` 18 passed. `pnpm test:publish-service`: 58 passed. `pnpm test:api-shapes`: 26 passed. `pnpm build` passes (its one warning, the NFT trace through `lib/platform/migrate.js`, was there before) |
| Browser verified | Not applicable. This item has no screen. The Undo confirm, the Recently published list and the offline line are drawn by P3-PUBLISHUI and P3-EDITOR, whose drills cover them. No dev server ran |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso (owner check below) |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed |

## What and why

Phase 3 needs a founder to step back from a publish they regret, to take a page offline, to step back from a publish of several pages at once, and to see what was published recently and by whom. P3-COMMIT gave one guarded commit core for all of this (`lib/documents/build.js`). This item replaces the four 501 stubs in `lib/documents/undo.js` with the real operations, built only from that core (`makeBuild` overrides, `runGuardedBuild`, `checkSlugs` / `slugClash`, `draftSlugOwner`) and `lib/documents/diff.js`. `build.js`, `commit.js` and `publish.js` are not edited.

## Design

### Which row can be undone (the target rule)

- An undoable row is a `publish_log` row with action `publish`, `unpublish` or `restore` that no `undo` row names in `undoes_log_id`. `undo` and `migrated` rows are never targets.
- A row is **current** when it is the document's latest undoable row and the live state still matches it:
  - `publish` / `restore`: `documents.published_version_id` is the row's `to_version_id`, **or a copy of it that an Undo put live** (below);
  - `unpublish`: `published_version_id IS NULL` and `undone_version_id` is the row's `from_version_id`.
- **Copies (an addition to the brief).** Every build mints fresh version ids, so an Undo back to v puts a fresh copy v′ live, never v itself. With the brief's rule as written, the row that published v would never match again after one Undo, and "Undo three times steps back through three publishes" could not pass. So a publish row whose `to_version_id` is v also matches when the live version is the `to_version_id` of an `undo` row that undid a row whose `from_version_id` matches v (followed forward through the log, so copies of copies count). An Undo that took a page offline adds no copy. This is a pure function, `analyse(rows, doc)`, with its own test.
- Reads: the document row and all of its log rows (two statements, the second through `publish_log_doc`). A `logId` that belongs to another document is 409 `PUBLISHED_ELSEWHERE` (one more statement, only on that path).

### `undo({id, revision, logId, dryRun})`

1. The row must be current, else 409 `PUBLISHED_ELSEWHERE`, "This was changed after that publish. Reload to see the latest.", with `current` (the document plus `updatedBy` and `updatedByName`; "another tab" when it was the same person).
2. Floors: a `migrated` row, or no row at all: 200 `{nothing: true, message: "There's nothing earlier to undo."}`. The target is the row's `from_version_id`. A null target on a singleton: 200 nothing, "This is the first published version. Edit it, or go back to your starting design." A null target on a page, campaign or journal post: take it offline. Nothing is written for a floor.
   - **A publish made while the page was offline (fix round 1).** Take offline leaves a fresh copy of the last live body in the list entry, switched off, so a publish made after it logs that offline copy as `from_version_id`. That copy was never live. So a `publish` or `restore` row whose `from_version_id` is an offline copy (the `to_version_id` of an `unpublish` row, or of an `undo` row that took the page offline) is planned like a first publish: its Undo takes the page offline again (`offline: true`, `undone` the live version, the draft kept), the dry run says `willTakeOffline: true` with "Taken offline" and no target, and the answer is the offline words. `analyse` works out the offline copies by walking the log forward, so publish, Undo, publish, Undo, and so on keeps going offline each time, and Recently published marks each such Undid row "Taken offline" with the note.
3. A start revision other than the document's is 409 `DOCUMENT_CHANGED` (the founder decided on an older view). Product content is 409 `PUBLISH_NOT_AVAILABLE` (OVL-02), the cart 409 `CART_NOT_AVAILABLE` (as every other cart write), and an archived document 409 `DOCUMENT_ARCHIVED`.
4. The target body is `upgradeBody(target version body)`, so the draft and the fresh version are in the current schema.
5. Slugs, on every attempt: the target's slug against the live list (`checkSlugs`, which is `slugClash` plus the archived-slug release) and, when it differs from the current draft's slug, against every other draft (`draftSlugOwner`). A clash is 409 `SLUG_TAKEN` with `{slug, other: {id, title, label}}` and nothing written. The words now end with a next step: "Another page already uses /about: About us. Change the address of “About us”, or take it offline and archive it, then undo again." A `SLUG_TAKEN` that the commit itself finds (another draft took the slug during the batch) gets the same words (P3-COMMIT review finding).
6. A current draft whose `draft_hash` differs from both the live hash and `documentHash(target)` is kept as an `undo_saved` version ("Saved before Undo") through `extraVersions`, inside the same guarded batch, with an id minted for that attempt only.
7. One guarded build:
   - **Back to an earlier version:** a fresh published version of the target; the entry, pages row or journal index entry and redirects from its meta; the draft rewritten to the target (`{body, hash, slug, label}`, revision + 1); `published` the fresh version with `documentHash(target)`; `undone` null; `expectPublished` the live version; an `undo` log row with `undoes_log_id` and `saved_version_id`; refs for the fresh version.
   - **Take offline:** `offline: true`, the draft unchanged, `published` null, `undone` the live version, `expectPublished` the live version. The answer: "It's offline now. To bring it back, open it and publish it again." `liveUrl` is null.
   - **Undo of an `unpublish` row:** the target is that row's `from_version_id`. The entry is switched on again, redirects and refs are written, `published` is the fresh version, `undone` is cleared, and the draft is kept as it is.
8. `runGuardedBuild`. On a lost batch: if one of this call's own builds is live after all, that is success. Otherwise the documents are read again, and the row must still be current (else 409 `PUBLISHED_ELSEWHERE`); then the build is made again on the new revision (a newer autosave is then the one kept as `undo_saved`). When the revision moved on the third loss: 409 `DOCUMENT_CHANGED`. A busy database is still 503 `PUBLISH_BUSY`, an unknown outcome 503 `PUBLISH_UNKNOWN`.

The answer is `{ok, message, savedVersion?: {id, where: "Earlier versions"}, liveUrl, document}`. The message names the page and when the version went live ("“About us” is back to the version that went live on 2 Nov, 10:00. Your newer changes are kept in Earlier versions."), in the store's time zone (Asia/Kolkata unless `merchant_timezone` says otherwise). After a success the document row is read once more for the answer, and an audit row is written (best effort), since the dispatcher doesn't audit the pass-through operations.

### Dry runs

`dryRun: true` on `undo`, `unpublish` or `undoSet` writes nothing and answers `{ok, willTakeOffline, linkers, changes, target}`:
- `linkers`: the live documents whose published version links to this one, from `linkersStatement` (by id and by slug key), only for pages, campaigns and posts, and only when `document_refs` exists.
- `changes`: `diffBodies(type, live body, target body)` words for a step back; a fixed "Taken offline" row for take offline; `firstPublishRows(target)` for bringing a page back. `diffBodies` is only ever called with two bodies (P3-DIFF review finding; P3-FIX1 fixes the null side in `diff.js`).
- `target`: `{versionId, name: "Published 2 Nov, 10:00 by Asha"}`, or null when it goes offline (and for a set). The name never carries a raw actor id.

### `unpublish({id, revision})`

Take offline as its own publish, with action `unpublish`, guarded by `expectPublished` = the live version and the revision. Refused for singletons and the other types with no address: 409 `CANNOT_TAKE_OFFLINE`, "This part of the store can't be taken offline." A page that isn't live gets the same code with "This page isn't live, so there's nothing to take offline." On a lost batch, a live version that moved is 409 `PUBLISHED_ELSEWHERE`.

### `undoSet({setId, members: [{id, logId}]})`

- The set's rows are read with `WHERE set_id = ? AND set_id IS NOT NULL`, so the `publish_log_set` partial index serves it (a test reads that statement out of `undo.js` and checks its query plan).
- Every member's row must be its own row of this set and current, else 409 `PUBLISHED_ELSEWHERE` naming the member ("“Home page” was changed after that publish. Reload to see the latest.") and nothing changes.
- Each member's current revision is read and guarded in the batch. A member whose draft differs from both its live version and its target gets its own `undo_saved` row.
- One build for every member, all or none. A singleton member whose row was its first publish stays as it is, and the message says so.

### `listRecentlyPublished({limit})`

- `publish_log ORDER BY created_at DESC, rowid DESC LIMIT n`, joined to `documents.label`. The rows' documents and all of their log rows are read (two statements) to work out `canUndo`. The summary bodies are read in one `IN` statement, and the team's names come from `versions.namesFor`.
- Each row: `{logId, setId, documentId, label, action, actionWords, byName, at, summary: [{words}], canUndo, undo: {id, revision, logId} | null, note?}`. Action words: Published, Took offline, Undid, Published on schedule, Restored, Moved to the new editor.
- `summary`: `diffBodies(from body, to body)`; `firstPublishRows(to body)` for a first publish; "Taken offline" for an unpublish row and for an Undo that took a page offline; "Back on your store" for an Undo of an unpublish row.
- An `undo` row that took a page offline carries `note: "Publish it again from the editor to bring it back."`
- `canUndo` is true only when the row is current (and the document isn't archived); `undo` is null otherwise.
- Rows are grouped by set: each set's rows together, the sets newest first.
- Offer changes (COM-03) are not included (recorded gap).

## Acceptance, with evidence

Every test is in `scripts/test-publish-undo.js`. "Fails without" names the mutation from the scratch runner (`…/scratchpad/p3-b2/P3-UNDO/mut/run.py`), each applied alone with the suite run and the file restored. **M0** puts back the P3-COMMIT stub (the state before this change): all 18 tests fail.

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit (sqld and file): after Undo the live list serves the previous version, the draft equals it with revision+1, documents.slug and label follow the target, and publishing the unchanged draft is skipped as already live | DONE | `undoBackCase`, run on a file store and on a real sqld: shoppers read v1 at its old address and the v2 address is gone; the entry is a fresh version copying v1; `published_hash = documentHash(target)`; draft = v1, revision + 1, slug and label from v1, `undone` null; the undo log row (`undoes_log_id`, from, to); a republish is `skipped`; the answer matches `SHAPES.undo.outcomes.ok`. Its dry run gives the change words and the target name, and writes nothing | M0, M13 |
| 2 | unit: Undo three times steps back through three publishes; a fourth on a page whose first publish it was takes it offline and the reader 404s that slug; redirects pointing to it are gone | DONE | "Undo three times…": four publishes, each Undo taken from the row Recently published offers. Shoppers and the draft step Four, Three, Two, One. The fourth takes it offline: `resolvedContentPage` null, `resolvedSlugRedirect` null and no redirect in the list, its row switched off, the draft kept, `undone` set, no Undo offered after, the note on the Undid row | M1 (no copies), M4, M7 |
| 3 | unit (negative): tab A publishes v2 while tab B's Undo of v1 is in flight: B answers 409 PUBLISHED_ELSEWHERE and v2 stays live; an Undo with a logId that is not the latest undoable row is 409 | DONE | "tab A publishes v2…": the interleave hook lands A's save and publish between B's read and B's batch. B loses once, re-checks and answers 409 with the brief's words and `current` ("another tab"); v2 stays live; no undo row. An older row, the raced row and another document's row are each 409 with storage unchanged | M5, M14 |
| 4 | unit (negative): Undo to a target slug that another document's draft now holds is 409 SLUG_TAKEN naming that page, nothing written | DONE | "Undo to a target slug…": names the holder `{id, title, label}`, the words with the next step, storage unchanged (every table, refs included). A second case where a live page holds the slug in the live list gives the same refusal | M6 |
| 5 | unit: Undo on one document leaves every other document's entry, published_version_id and draft unchanged | DONE | "Undo on one document…": the other documents' rows (draft, hashes, revision, pointers, slug, label), their list entries, page rows, redirects and journal index entries compare equal before and after | M0 |
| 6 | unit (negative): newer unpublished edits are saved as an undo_saved version listed by listHistory with its note, survive 25 later autosaves, and the response names 'Earlier versions' | DONE | "newer unpublished edits…": `savedVersion {id, where: "Earlier versions"}` and the message; the row's kind, note, document and body; the undo log row's `saved_version_id`; 25 autosaves with a checkpoint each, then `listHistory` still lists it with its note while the checkpoints are pruned to the cap | M2 |
| 7 | unit (negative): an autosave committing between Undo's read and its batch makes the batch lose; Undo re-reads and succeeds on the new revision with the autosaved text kept as undo_saved; no undo_saved orphan after a lost attempt | DONE | "an autosave between Undo's read…" (file) and "unit (sqld): an autosave…": two attempts, the second guarding on revision + 1, a fresh `undo_saved` id per attempt, the first one absent from the database, exactly one kept row with the autosaved text. Three such losses give 409 `DOCUMENT_CHANGED` with no published, `undo_saved` or log row written; a stale start revision is 409 too | M2, M9, M12 |
| 8 | unit: an old-schema target body is upgraded before it becomes the draft and the fresh version | DONE | "an old-schema target body…": a section kind registered at version 1, published, then re-registered at version 2 with a migrate step. After Undo the draft and the fresh version both hold the section at v2 with the migrated setting, and their hashes agree | M3 |
| 9 | unit (negative): staff calling undo, undoSet or unpublish get 403 with storage unchanged; singleton first-version and migrated-floor notes as specified | DONE | "staff calling…": 403 for undo, undoSet, unpublish and an undo dry run, storage unchanged. The home page's first publish gives the singleton words; a migrated row and a missing row give "There's nothing earlier to undo."; nothing written. Product content is 409 `PUBLISH_NOT_AVAILABLE` | M0 (the 403 itself comes from the dispatcher, which P3-COMMIT proved; this pins it with the real module behind it) |
| 10 | unit: whole-set Undo after a 3-document publishSet restores all three in one release even when one member autosaved since (its draft saved as undo_saved); if one member was published since, 409 and nothing changes; a single-document Undo of a set member works | DONE | "whole-set Undo…": one new release, all three back for shoppers, the three undo rows share one set id, only the autosaved member has `saved_version_id`, its kept body and note. A member published again alone: 409 naming it with `current`, storage unchanged. A single member's Undo of the same set works and leaves the others. The set dry run names each page and writes nothing | M2, M13 |
| 11 | unit: unpublish of a live page and of a journal post writes an 'unpublish' row, 404s it, keeps its draft, nulls published_version_id (archive then allowed), sets undone_version_id; dryRun returns linkers from document_refs and the change words, and writes nothing; Undo of that unpublish row brings it back with redirects and refs and clears undone | DONE | "unpublish of a live page…": the dry run gives the linking campaign from `document_refs`, "Taken offline", target null, storage unchanged. The page 404s and its redirect goes; the documents row; the unpublish row is offered for Undo; bringing it back restores shoppers' view, the redirect, the refs of the fresh version, clears `undone` and keeps the draft. The journal post leaves shoppers' journal and 404s; archive then succeeds. A singleton is 409 `CANNOT_TAKE_OFFLINE` | M8 |
| 12 | unit: listRecentlyPublished returns plain names, labels and summaries, never raw actor ids or hashes, newest first, grouped by set, canUndo true only on current rows; responses match documents-api-shapes.js keys | DONE | "listRecentlyPublished gives plain names…": every row matches the shape's row keys (`note` optional); newest first; each set's rows together; "Asha Rao", the labels and words with no `merchant:`, id or hash; `canUndo` exactly on the two current rows, `undo` args only there; after an Undo the Undid row can't be undone and the row before it can. A legacy store is 409 `STORE_USES_LEGACY` | M1, M4 |
| 14 | fix round 1 (negative): Undo of a publish made after the page was taken offline takes it offline again, never back online with the old content | DONE | "Undo of a publish made after unpublish…" and "Undo of a publish made after an Undo took the page offline…": publish One., take offline (by unpublish, or by Undo of the first publish), save Two., publish with `confirmRepublish`, Undo the row Recently published offers. The dry run says `willTakeOffline: true`, "Taken offline", target null, and writes nothing; the answer is the offline words with `liveUrl` null; the reader 404s the page (never One. again) and its redirect; its row is switched off; `published_version_id` null, `undone` the version that was live, the draft still Two. with its revision and hash; no Undo offered after; the Undid row says "Taken offline" with the note. A second publish and Undo goes offline again. The pure target-rule test adds both paths, a twice-repeated path, and that a publish over a live version still steps back | Without the fix all three fail (the real `undo.js` at `5233a18` put back, suite run, file restored): the dry run said `willTakeOffline: false` with a target and "Text: a paragraph changed", and `planOf` gave `restore` to the offline copy |
| 13 | unit: the Recently published summary for a first publish and a take-offline row has no 'Search description changed' or 'reordered' rows | DONE | "the Recently published summary…": a first publish lists the title and the section; an unpublish row and an Undo that took a page offline each say "Taken offline"; no row anywhere says "Search description" or "reordered" | M7, M10 |

Two more tests: the pure target rule (copies, never an offline Undo as a copy, unpublish rows), and the whole-set statement form plus its query plan, plus a walk showing only `lib/admin/documents-api.js` imports `undo.js` (M11 is caught there).

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish-undo` | 20 passed after fix round 1 (18 in the first round; replaces the scaffold placeholder) | 1.4 s, of which sqld 0.5 s |
| `pnpm test:publish-service` | 58 passed | 2.7 s |
| `pnpm test:api-shapes` | 26 passed | 0.2 s |
| `pnpm test` | 81 of 81 suites after fix round 1 | 134.1 s |
| `pnpm build` | passes | |
| Mutations (`mut/run.py`) | 15 of 15 caught (M0 to M14), first round; not rerun in fix round 1 (the fix's own check is the unfixed file, row 14) | |

Ports: `TEST_PUBLISH_UNDO_PORTS=4822` (new, the sqld port; free port otherwise), `TEST_PUBLISH_PORTS=4823,4824`, `TEST_PUBLISH_SERVICE_PORTS=4825,4826`, `PORT`/`DESIGN_PORT` 3820, and the mutation runner 4821. Every sqld the suites started was stopped. The suite's file databases are `.test-pu-*.db`, removed at the end.

## Known limits

- **Two test files outside this item's list were edited, because this item's change turns them red.** Both belong to P3-CHECKS in this batch; the orchestrator must merge them with that branch.
  - `scripts/test-api-shapes.js`: `CANNOT_TAKE_OFFLINE` was listed as a code nobody emits yet. Now `undo.js` emits it, so it moves from `NEW_CODES` to a new `NOW_EMITTED` set, which also lets its p3 outcome count as its contract outcome. 7 lines.
  - `scripts/test-publish-service.js`: the P3-COMMIT case expected 501 `NOT_BUILT` from every stub. For the four operations built here it now checks only that they are no longer 501 (storage unchanged still holds); the `changes.js` stubs keep the 501 check. 9 lines.
- **The copies rule is wider than the brief's words** (see Design). Without it the second Undo in a row is refused.
- **`expectPublished` is defence in depth here.** Every interleaving the API can make also moves the pointer or the revision, which the flip already guards, so no test can show it alone; removing it would not be caught.
- **The `draftSlugOwner` pre-check gives the same answer as the commit's own `SLUG_TAKEN`** (which this item now words the same). It saves a batch; removing it would not be caught.
- **`undoSet` accepts a subset of the set's members.** Each member's row must be its own row of that set; members left out stay as they are.
- **Two set members swapping slugs** in one whole-set Undo are refused with `SLUG_TAKEN` by the commit's unique index (the updates run one by one).
- **`canUndo` is true on a singleton's first-publish row** (it is current); Undo then answers the "first published version" note and writes nothing.
- **An `undo` row is never a target**, so a logId of one is 409 `PUBLISHED_ELSEWHERE`. The Undid row that took a page offline says to publish again instead.
- **The message's time is when the target version went live.** For a copy that an earlier Undo made, that is the time of that Undo.
- **The Recently published list can cut a set at the limit**, showing only some of its rows.
- **`updatedByName` says "another tab" for the same person**, which may be another device.
- **Undo reads all of a document's log rows** (through `publish_log_doc`). That is fine at today's sizes; a document with thousands of publishes would want a narrower read.
- **Bringing a page back logs the offline copy as `from_version_id`**, since that is what the list held. A publish made while offline logs it too; its Undo takes the page offline again (row 14).
- **After the Undo of a publish made while offline, nothing earlier is offered.** The `unpublish` row before it no longer matches (`undone` is now the version that was live just before), so to go further back the founder publishes again or restores from Earlier versions.
- **The Recently published summary of a publish made while offline** compares it with the offline copy, which is the last body that was live, so it lists what changed since the page was last on the store.
- **Publishing again after take offline** does not ask for `confirmRepublish` here; that confirm is P3-CHECKS's.
- **Linkers come only from versions published after 0023** (P3-COMMIT's limit), so links held only by phase 2 versions are missed until MIG-01 backfills.
- **A dry run does not check the start revision.** It writes nothing.

From review:

- The earlier blocker is fixed at 583d4ae. I reproduced both paths through the real console API. Path 1: publish One., unpublish, save Two., publish with confirmRepublish, then Undo the offered row. Path 2: the same, but the page is first taken offline by Undo of the first publish. In both, the dry run now says willTakeOffline:true with 'Taken offline' and target null. The page 404s and never serves One. again, the draft keeps Two., published_version_id is null and undone_version_id is the version that was live. The message is the offline words, not 'back to the version that went live on…'. The new tests caught all 4 mutations I made to the fix: dropping the offline copy that an offline Undo leaves, dropping unpublish rows from the offline copies, putting the old 'from == null' check back, and making tookOffline always false.
- My extra probes all behaved correctly. (a) Bring back by Undo of the unpublish row, publish Three., Undo: One. is live again, which is right because the brought-back copy was live. (b) Publish at a new slug while offline, then Undo: neither slug is served. The old slug is free for another page, and the offline entry keeps the new slug as plan decision 4 says. (c) Unpublish, publish Two., publish Three., Undo gives Two. and a second Undo takes the page offline, never One. (d) Whole-set Undo where one member was published while offline: that member goes offline and the other steps back, in one release. (e) A publish that lands while an Undo of a publish-made-while-offline is in flight gives 409 PUBLISHED_ELSEWHERE, and the new publish stays live.
- Wording, not blocking: for a set where one member goes offline, the undoSet message says '2 pages are back to how they were before that publish. “Pr4a” is offline now. To bring it back, publish again.' This is true, since offline is how that page was before, but a founder may read the first sentence as both pages being live. The single-document text says 'open it and publish it again'; the set text drops 'open it'.
- Recorded limit, now in Known limits: after Undo of a publish made while offline, the earlier unpublish row can no longer be undone, so nothing earlier is offered. The founder has to publish again or restore from Earlier versions. This is acceptable and documented.
- Mutations were not rerun as a whole set in fix round 1. The packet says so, and my 4 targeted mutations on the fix lines were all caught.
- Checks: pnpm test on the worktree passed 81 of 81 suites in 131.0 s (ports 4020 and 5023 to 5027). pnpm test:publish-undo passed 20 of 20, file and sqld. build.js, commit.js, publish.js and .github are unchanged against 5bbc819. undo.js has no node: imports and is imported only by the console API. Nothing writes 'restore' log rows yet, so restore rows that point at an offline copy are covered only by the pure test. The worktree is removed and no listeners are left on my ports.

## Owner checks

- **Hosted Turso, on a staging tenant:** Undo, take offline, whole-set Undo, an Undo racing an autosave and an Undo racing a publish (409) are all atomic. Proven here on a local file database and on local sqld only.
- **Deploy order:** run `tenant:migrate --all --check` (0023) before relying on the dry run's linkers. Undo works without 0023; linkers are then empty.
- **CI sqld download** (standing): `.github/` was not touched. Approving the source and checksum of the sqld binary for CI is still the owner's call.
- **Wording:** "Back on your store", "Taken offline", the `SLUG_TAKEN` next step ("Change the address of “X”, or take it offline and archive it, then undo again."), "This page isn't live, so there's nothing to take offline.", and "another tab" for the same person.
- **Time zone:** messages and target names use `merchant_timezone`, else Asia/Kolkata. Confirm that default.
- **Ruling:** the copies rule, and `undoSet` accepting a subset of a set.
- **Phones:** the Undo confirm and Recently published at 375 px wait for P3-PUBLISHUI and P3-EDITOR.
- **Orchestrator:** merge the two out-of-list test edits with P3-CHECKS (`scripts/test-api-shapes.js`, `scripts/test-publish-service.js`).
