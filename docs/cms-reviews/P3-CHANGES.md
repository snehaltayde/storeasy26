# P3-CHANGES: the change list, keep the live section, keep as an earlier draft

**Branch:** `cms/p3-changes`, cut from `5bbc819`.
**Requirements:** PUB-09 (what will change, keep the live version of a section), ED-03 (a stale save says who saved, and the founder's text can be kept).
**Migrations:** none.

| Stage | State |
|---|---|
| Implemented | Yes |
| Locally tested | Yes: `pnpm test` passed 81 of 81 suites (132.3 s); `pnpm build` passed |
| Browser verified | NOT DONE. No screen calls these operations yet (PUBLISHUI and EDITOR are batches 3 and 4). Every acceptance item is a unit item. |
| Staging | NOT DONE (owner check below) |

## What changed and why

### `lib/documents/changes.js` (the stubs are replaced)

- **`listChanges({id})`** (storefront.read). There are three answers:
  - The draft is what is live (`draft_hash = published_hash`): `{ok, firstPublish: false, rows: []}`.
  - The page was never published, or it is offline (no published pointer): `{ok, firstPublish: true, sections}`, from `firstPublishRows(type, draft)`.
  - Otherwise: `{ok, firstPublish: false, rows}`, from `diffBodies(type, live body, draft)`. Each row is `{kind, sectionId?, words}`.

  The words come from `diff.js`, so they carry no id and no hash. The `sectionId` is for the editor only.
- **`keepLiveSection({id, sectionId}, revision)`** (storefront.write). It puts the live version of one section back into the draft:
  - an edited section is replaced in place, keeping the draft's id so the editor keeps it selected;
  - a moved section goes back to its live place;
  - a hidden (or shown) section goes back to how it is live (the live copy carries `enabled` and `show`);
  - an added section is removed;
  - a removed section is put back at its live place.

  Sections are paired the way `diff.js` pairs them (its `matchSections` and `movedPairs`), so the section that changes is always the one on the row the founder clicked. That holds even for a migrated live version with no ids. The pure part is exported as `keepLiveBody(live, draft, sectionId)`.
- **`keepAsEarlierDraft({id, body})`** (storefront.write, no revision). It stores the body as an `undo_saved` version with the note "Kept from another tab". The rules are in the service section below.

Both writes log `documents_write` or `documents_kept_draft` and write a best-effort audit row, as the dispatcher does for the other writes.

### `lib/documents/service.js`

- **The stale 409's `current` carries `updatedBy` and `updatedByName`.**
  - `DOC_COLS` gains `updated_by`. `fromRow` keeps it under a non-enumerable symbol, so no other answer carries it (getDocument, saves, publish conflicts and the shapes' `DOCUMENT` are unchanged).
  - `stale()` is now async. It names the person through `versions.namesFor` and `plainName`: the team member's name (or email), "Someone on your team", or "Storeasy" for a write with no actor. It says "another tab" when the stale writer is the same actor.
  - `current()` and `settle()` take the actor, so this holds both for the early refusal and for a stale write that loses inside the batch.
  - The names cost one control-plane read, and only on this refusal, only when the last writer is a merchant.
- **`rewriteDraft({id, revision, actor, note, rewrite})`.** This is the saveDraft path for a draft the server rewrites:
  - `current()` refuses 428, 409 with current, or 409 archived;
  - the cart lock applies;
  - `rewrite(d)` makes the new body;
  - `prepare()` runs the draft-mode validation (422, nothing stored);
  - `replaceDraft()` writes one batch: the checkpoint of the replaced draft first, then the guarded UPDATE and its abort, then the prune.

  keepLiveSection uses it with the note "Before keeping the live version of a section".
- **`keepEarlierDraft({id, body, actor})`**:
  - it validates in draft mode and sanitizes like a save, so a structurally wrong body or another type's body is 422 with nothing stored;
  - it dedupes against every `undo_saved` version of the document by `documentHash` (ids stripped), including versions Undo kept, and hands the existing one back;
  - at 10 versions noted "Kept from another tab" it answers 409 `TOO_MANY_KEPT`: "There are already 10 kept drafts for this page. Open Earlier versions to tidy them.";
  - the store is one `INSERT … SELECT` (`versions.keptStatement`) that checks the cap and an exact `body_hash` duplicate inside the statement. Two tabs at once can't pass 10, and a statement that `lib/db.js` resends after a lost answer adds nothing. A lost answer is settled by reading back the version's own id;
  - the documents row is never written, so the draft, revision, hash and `updated_at` stay as they are.

### `lib/documents/versions.js`

- `pruneStatement(documentId)` binds the document id in every retention check (`p.document_id = ?`, `d.id = ?`, three times each) instead of taking it from the outer row. Every lookup is then an index probe on that one document, whatever plan SQLite picks. The rules are word for word the same: a checkpoint is kept when publish_log names it (from, to or saved) or a document row points at it (published or undone), and the cap stays 20.
- New for keepAsEarlierDraft: `KEPT_NOTE`, `KEPT_CAP`, `undoSavedBodies`, `keptCount`, `keptStatement` and `versionExists`.

### Small edits outside this item's file list (disclosed)

Each one was needed because building the stubs turned an existing check red. Each is a few lines.

- `scripts/test-publish-service.js` (P3-CHECKS owns it in batch 2): the "501 NOT_BUILT from every stub" loop skips the three Changes ops, and its "restored:" check expects `NOT_FOUND` from the real `listChanges` instead of `NOT_BUILT`. The Undo ops are still checked as stubs. P3-UNDO will need the same kind of edit for its ops, so expect a small merge conflict at these lines.
- `scripts/test-api-shapes.js` (P3-COMMIT, then P3-CHECKS):
  - (a) A code in `NEW_CODES` that its owner now emits is no longer an error ("listed as new but the code already emits it"), but its emitted status must still equal the contract's. I checked that this still bites: TOO_MANY_KEPT emitted as 410 fails it.
  - (b) "every DocumentError code of today has an outcome" also counts the p3 outcome of a `NEW_CODES` code.

  P3-CHECKS and P3-UNDO hit the same two lines when they emit REPUBLISH_CONFIRM_NEEDED, FIRST_PUBLISH_NEEDS_HOME, LINKS_TO_UNPUBLISHED and CANNOT_TAKE_OFFLINE.
- `versions.js` `undoSavedBodies` maps rows through a named function. `test-api-shapes.js` reads the keys of `listVersions` from the first `return r.rows.map((v) => ({` in the file, and a second literal of that form would have been read instead.

## Design notes

- **"Its live place".** The brief says a removed section goes back "at its live index clamped to range". I put it right after the nearest section before it on the live store that the draft still has, or, if none, right before the nearest one after it. Only with neither does it fall back to the live index, clamped. When nothing around the section was added or removed, this is exactly the live index. When the founder added a section above it, the plain index would put it in the wrong place; the test "removed, with another section added at the top" shows the difference. A moved section uses the same rule, so the founder's other moves and additions stay as they are.
- **Moved only when the diff says moved.** An edited section stays where the draft has it. It is repositioned only if `movedPairs` lists it as moved, the same rule that writes the "moved" row. A swap of two sections lists one of them as moved, and keeping that one restores the order.
- **No section, or never published, is 404.** The shapes list no other refusal for keepLiveSection, and the dispatcher words a `NotFoundError` as `{error, code: "NOT_FOUND"}`. The words say what happened: "This page has never been published, so there is no live version to keep." or "That section is no longer in this page or on your live store. Reload to see the latest changes."
- **Archived pages can still keep a draft.** keepAsEarlierDraft does not refuse an archived page: keeping the founder's text loses nothing, and the shapes list no archived outcome for it. The cart lock applies as for every document write.

## Acceptance

| # | Item | Status | Evidence (fails without this change: the stubs answer 501, or the base code) |
|---|---|---|---|
| 1 | Home draft with an edited hero title and a half-done banner lists exactly "Hero: title changed" and "Banner: added"; keepLiveSection on the banner removes it; a publish then ships only the hero edit | Pass (unit) | `test-doc-changes` "a home draft with an edited hero title…": rows, kinds and anchors exact. After keepLiveSection the draft is `[sec_hero1]` with "New title", and the new revision and draftHash equal the stored ones. After the real publish the live body is `[["hero","New title"]]` and listChanges gives `[]`. Fails on the base (501). |
| 2 | Negative: migrated document differing only by stamped ids lists none; draft equal to published lists none; offline page lists firstPublish rows | Pass (unit) | "negative: a migrated document…". The live version is a `migrated` row with no ids, and gives `rows: []` both through the hash check and with a mismatched stored hash, through the diff. "negative: a document whose draft equals…": equal gives `[]`. Never published and offline (pointer and hash null, `undone_version_id` set) both give `firstPublish: true` with `['Page title: "…"', "Text 1"]`, the hidden section left out. An unknown id is 404. The words are checked for ids and hashes. Fails on the base. |
| 3 | Removed (re-inserted at its live position), moved and hidden sections each restore correctly | Pass (unit) | "removed: keepLiveSection puts it back…" covers removed below a new top section, removed at the very top, moved to the end, moved and edited at once, hidden, and edited while another edit is kept. Each leaves no row for that section. "keepLiveSection pairs as the change list does" covers a migrated live version with no ids. "the pure part" covers the end, an empty draft, added, and hidden plus edited. Mutations caught: always restoring in place (2 failures), the plain live index (1). |
| 4 | keepLiveSection with a stale revision is 409 with current; a checkpoint is written first | Pass (unit) | "keepLiveSection with a stale revision…": 409 DOCUMENT_CHANGED with current's revision, body and `updatedByName: "Ravi Kumar"`, storage unchanged. Also 428 without a revision, 404 for no section and for never published, and 403 for support. A spy on the batch shows `INSERT INTO document_versions` before `UPDATE documents SET`, and the checkpoint (note "Before keeping the live version of a section") holds the replaced draft. A mutation that drops the note is caught. |
| 5 | keepAsEarlierDraft stores undo_saved visible in listHistory with its note; draft, revision and hash unchanged; dedupes; 409 TOO_MANY_KEPT at 10; 422 on a structurally invalid body; 403 for read-only | Pass (unit) | Two tests in `test-doc-changes`. The version is listed as `undo_saved`, "Kept from another tab", "Asha Rao". It is sanitized (no `<script>`) and kept through 25 later autosaves. `draft`, `revision`, `draft_hash` and `updated_at` are unchanged. The same body, the same body with different stamped ids, and Undo's own kept version all dedupe. The 11th distinct body is 409 with the exact words, while an identical body still dedupes at the cap. An unknown kind and another type's body are 422. Support gets 403, staff 200, an unknown page 404, a legacy store 409. Storage is unchanged after every refusal. "two tabs keeping at the same moment…": five concurrent keeps at 8 give exactly two 200s. A lost answer with a resend stores one version. Mutations caught: no dedupe (2), no cap in the statement (1, the race). |
| 6 | A stale saveDraft 409 includes updatedByName (team member's plain name; "another tab" for the same actor) | Pass (unit) | `test-documents` "P3-CHANGES (ED-03): a stale saveDraft 409 names who saved it" covers the same owner ("another tab"), a named member ("Gone Person"), a system write (null, "Storeasy"), and a stale write losing inside the batch ("Asha Rao"). getDocument and save answers carry no `updatedBy`. The existing stale test now pins `[merchant:<id>, "ravi@zd.test"]` and checks that no raw actor id appears anywhere else. Both fail on the base. Mutation caught: no same-actor rule. |
| 7 | Prune keeps every P2 retention rule under the per-document query; responses match documents-api-shapes.js keys; test-documents stays green | Pass (unit) | New "the prune binds the document id in every check" pins 3× `p.document_id = ?`, 3× `d.id = ?`, no correlated term, and the 10 arguments. It fails on the base. The P2 retention tests pass unchanged: the undo_saved version survives 100 saves, at most 20 checkpoints, publish_log from/to/saved kept, published and undone pointers kept, and the query plan has no SCAN. Every outcome produced is compared key by key with the shapes, and a closing test checks that all 13 were seen (listChanges ok, firstPublish, legacy, notFound; keepLiveSection ok, changed, revisionRequired, notFound; keepAsEarlierDraft ok, tooManyKept, validationFailed, notFound, legacy). `test-documents` passed 42 of 42 and `test-api-shapes` 26 of 26. |

## Tests

- `scripts/test-doc-changes.js` (new, replaces the placeholder): 12 cases, 1.9 s. File databases only, no ports.
- `scripts/test-documents.js`: 42 cases (2 new, 1 tightened), 1.4 s.
- `pnpm test`: 81 of 81 suites, 132.3 s. My ports: `TEST_PUBLISH_PORTS=4840,4841`, `TEST_PUBLISH_SERVICE_PORTS=4842,4843`, `DESIGN_PORT=3840`, `DESIGN_SQLD_PORT=4845`. Nothing was left listening afterwards.
- `pnpm build`: passed.
- Edge safety: `changes.js` is imported only by `lib/admin/documents-api.js` (nodejs route) and named in the shapes comments. No `node:` import was added. `service.js` now imports `tenant-context.js`, which `db.js` already uses.

## Known limits

- **No rate limit exists on the documents route.** The brief says keepAsEarlierDraft "stays under the storefront.write rate limit". `app/api/admin/documents/route.js` has no `rateLimit` call for any operation, and that route is not in this item's files. So keepAsEarlierDraft is limited the same as every other documents write: by authentication and storefront.write, and here also by the cap of 10. Adding a limiter is an owner decision (below).
- **"Open Earlier versions to tidy them" has nothing to tidy with yet.** `undo_saved` versions can't be deleted: the `document_versions_kept` trigger of 0021 refuses it, and there is no delete operation. Once a page has 10 kept drafts, the 11th is refused for good. Restoring a kept draft does not free a place either. The words promise something an editor item must build, or the owner must reword.
- **Dedupe reads every undo_saved body of the document** and hashes each one. That is fine at today's numbers: at most 10 kept drafts plus Undo's. A page with hundreds of Undo saves would make this slower. A stored `document_hash` column would fix it, but needs a migration.
- **The dedupe and the cap are separate.** Two tabs keeping the same id-less body at the same moment can store it twice (their stamped ids differ, so the `body_hash` term doesn't catch it). It still counts against the cap.
- **keepLiveSection on a section that already matches live still writes.** The revision moves on and a checkpoint is made. Another tab open on the page then gets a stale 409.
- **The 422 of keepLiveSection is not exercised.** The live body was valid when published, so in practice it can only come from a later registry change. The code path is the same `prepare()` saveDraft uses.
- **Section pairing inherits diff.js's pass 3 limit** (P3-DIFF Known limits and review). When a migrated section without an id is removed and another section of that kind is edited, the row and the keep act on the section pass 3 paired, which can be the wrong one. Bodies saved through the service always have ids.
- **`updatedBy` is a raw actor id in the 409 body.** The shapes ask for it, for the editor only. The editor must show `updatedByName`, never `updatedBy`.
- **Cross-owner test edits** (above) will conflict with P3-UNDO and P3-CHECKS at the same lines. The resolution is to keep both sides' skips.

From review:

- Test gap, keepLiveBody (lib/documents/changes.js:134). A mutation that puts the edited section back under the live section's id instead of the draft's id passed both test-doc-changes and test-documents. No test pairs two sections that have different valid ids by content, so the rule 'keep the draft's id so the editor keeps it selected' is not proven.
- keepLiveSection can leave a row for the section it restored. The draft must be heavily reordered: in a property probe over about 12,700 random rows, 5 to 6 per seed did this. Example: live [l0,l1,l2,l3,l4], draft [l4,l2,l3,l0]. Keeping l1 puts it after l0, giving [l4,l2,l3,l0,l1], and the list then shows 'Text 5: moved down' for l1. Moved, edited, hidden and added rows always cleared, and no other row's kind or section ever changed. This ties into the owner ruling on placement (nearest live neighbour or live index): neither rule can avoid it once the draft order is scrambled.
- keepEarlierDraft has no test for the cart lock (refuseCart). Removing that line from keepEarlierDraft left every suite green.
- keepEarlierDraft runs the JS cap check before the INSERT, but nothing tests it on its own. Turning it off passed every suite, because the SQL cap and the re-count after the insert still answer 409. It is a redundant guard, not a hole.
- keepEarlierDraft reads and hashes every undo_saved body of the document on each call (undoSavedBodies, then keptLike). undo_saved versions are never pruned, so the cost grows with each Undo and kept draft. It is fine at today's sizes.
- keepEarlierDraft does not refuse an archived document. It will store a kept version on an archived page. The brief does not ask for a refusal, so this is harmless, but it does not match saveDraft.
- keepEarlierDraft runs the full draft-mode prepare, so another tab's body with a mid-typed invalid slug gets 422 SLUG_INVALID and is not kept. This follows the PV-02 rule. The editor (P3-STORE/EDITOR) must send the last saved slug here too, or the backup of that tab is refused.
- keepLiveSection on an offline page answers 404 'This page has never been published…', which is the wrong reason for a page that was published and then taken offline. Only the founder sees it, and it is minor.
- Files outside the item's list were edited, both disclosed: scripts/test-publish-service.js (CHECKS owns it in batch 2) and scripts/test-api-shapes.js. Both edits were needed, because the built ops no longer answer 501. They weaken nothing: a NEW_CODES code must still keep its contract status. Expect merge conflicts with P3-UNDO and P3-CHECKS on the same lines.
- Owner rulings the builder listed, which I confirmed: PUT /api/admin/documents has no rate limit for any operation, so 'stays under the storefront.write rate limit' adds nothing beyond auth plus the cap of 10. The TOO_MANY_KEPT words say 'Open Earlier versions to tidy them', but there is no way to delete undo_saved versions. Restored removed or moved sections go after the nearest live neighbour, not at the plain live index.
- Verified, no defect: pnpm test passed 81 of 81 suites (151.6 s) at a3178d8. Mutations caught: listChanges ignoring the offline state, the same-actor 'another tab' rule removed, the SQL cap removed, the cap counting every undo_saved, prune argument order shifted, names read for the wrong tenant, and dedupe removed. The prune argument count matches its placeholders. No node: APIs were added to lib, and the only importers of changes.js and service.js are nodejs routes. publish.js has its own synchronous stale(), so making service.js stale() async breaks nothing. The updated_by symbol keeps updatedBy out of getDocument and save answers. My worktree rv0 was removed.

## Owner checks

- **Staging (hosted Turso):** run keepLiveSection and keepAsEarlierDraft on a documents-mode staging tenant, including two tabs keeping at once (the cap holds) and a stale keep (409 names the other person).
- **Ruling: the live place of a restored section** (neighbour-anchored, not the plain index; see Design notes).
- **Ruling: tidying kept drafts.** Either build a way to delete `undo_saved` versions noted "Kept from another tab" (this needs a change to the 0021 trigger), or reword the TOO_MANY_KEPT message.
- **Ruling: a rate limit on `PUT /api/admin/documents`.** There is none today for any operation.
- **Wording:** "another tab" (lower case, as the shapes give it) and the two 404 sentences of keepLiveSection.
- **The CI sqld download** still needs the owner's approval of its source and checksum. `.github/` was not touched.
