# P3 · STORE · The editor's store and the preview label

**Branch:** `cms/p3-store`, cut from `64d3d07`.
**Requirements:** ED-02, ED-03, PV-01, PV-02, PUB-04, PUB-09 (the parts this item owns: one client store per open document, and the preview's state machine).
**Migrations:** none.

No tenant changes mode. Nothing imports the new files yet. P3-EDITOR (batch 4) mounts them, so legacy editors, releases and preview are untouched. Only these files change: `components/admin/editor/store.js` (new), `components/admin/editor/previewMachine.js` (new), `scripts/test-editor-store.js` (replaces the placeholder) and this packet. Nothing under `.github/`, nothing in `package.json`.

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:editor-store`: 28 passed, 0 failed, in 0.4 to 0.8 s. `pnpm test`: 81 of 81 suites passed in 144.7 s (sqld suites on my ports 7100 to 7104). `pnpm build` passes |
| Browser verified | **NOT DONE.** No page hosts the store until P3-EDITOR. Every acceptance item is a unit item, proved in node. The desktop Chrome drill is an owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

Today the console has 7 save paths and 3 preview implementations (ED-02). In-app navigation loses typing, and the preview label can say "shows your edits" over older content (PV-01). Phase 3 gives the new editor one store per open document, with one save model, and one machine that decides what the preview label says. Both are plain JS, so node tests can drive every timing case.

### `components/admin/editor/store.js`

`createDocumentStore({ api, document, tenant, storage, timers, now, pauseMs })`. `api` is P3-SESSION's documentsApi. `timers` (`setTimeout`/`clearTimeout`), `storage` (localStorage or a stand-in) and `now` are injected. The editor reads `getState()` and `subscribe()` (a frozen snapshot that changes only on emit, so it fits `useSyncExternalStore`).

- **Edits.** `setField(path, value)`, `insertSection(section, index)`, `removeSection(id)`, `moveSection(id, toIndex)` and `apply(op)` replace the local body at once and restart the pause.
  - A path is relative to the body: `"sections.sec_hero1.settings.title"`. In a list, a number is a place and any other segment is an item's id, so a path still finds its section after other sections were added or moved.
  - `applyOp` is exported and pure. It is used both for editing and for replay.
- **Autosave (ED-03).**
  - One pause (`AUTOSAVE_PAUSE_MS`, 700 ms), then one `saveDraft` with `call("saveDraft", {id, body}, {revision})`. Only one save is ever in flight.
  - Typing while a save is in flight is kept. The next save goes out as soon as the first answers, or when its own pause ends.
  - An answer adopts `revision` and `draftHash`. When nothing was typed since the save was sent, the server's body (sanitized, ids stamped) also becomes the local body. Text typed since is never replaced.
  - Status: `"Saving"` (pending or in flight), `"Saved"`, or `"Could not save: <the server's words>"`.
- **Retries.** A failure keeps the text. It is retried by itself, with waits of 1, 2, 5, 10, then 30 s, only when the server's answer says `retryable: true`, or when the network failed (`NETWORK_ERROR`, see Known limits). Anything else waits for the next edit or `retry()`.
- **Server-replace operations (plan A5).** These are `undo`, `keepLiveSection`, `discardDraft` ("Go back to the live version"), `restoreVersion`, and `unpublish`. Each one runs the same way:
  1. `flush()` saves pending edits first. If that save fails, the operation is not sent at all, and the answer says "Your latest changes aren't saved yet, so nothing else was done. They are still here." Undo's "newer edits are kept as undo_saved" therefore always covers what was typed.
  2. Autosave is held during the call.
  3. The answer's `document` replaces the local body, revision and draftHash.
  4. Edits typed during the hold were recorded as operations. They are applied again on top of the new body, then saved on the new revision.
  - A full body from before the operation is never written.
  - When a recorded edit can't be applied again (its section is gone, for example after keeping the live version of an added section), the founder's whole body is first kept with `keepAsEarlierDraft`, and the store says so. If the server can't keep it either, the body goes into local storage and is offered at once.
  - Dry runs (`undo({logId, dryRun: true})`, `unpublish({dryRun: true})`) are sent as they are, with no hold.
- **Publish.** `publish({confirmRepublish})` and `publishSet(items)` flush, hold, then publish with the acknowledged `draftHash`. This document's entry in a set is always replaced by its acknowledged revision and hash (an offer's entry may be stale). Labels are dropped, and there is no top-level revision.
  - **`PUBLISH_UNKNOWN`** (P3-FIX1 keeps `release`) answers `checkLive: true` with the server's words, never as a failed save.
  - For `undo` and `unpublish`, the store also reads the document again. If its revision moved, that document is taken in, as on success.
- **409 `DOCUMENT_CHANGED`.**
  - Autosave stops. `conflict` exposes `words` ("This page was changed in another tab." for the same person, "This page was changed in another tab or by Asha." otherwise), `current` and `choices: ["useNewer", "keepMine"]`.
  - Typing still shows. Leaving warns, and no keepalive is sent, because it would be refused.
  - `useNewer()`: `keepAsEarlierDraft(mine)`, then the newer version is taken. Autosave resumes.
  - `keepMine()`: `keepAsEarlierDraft(current.body)`, then `saveDraft(mine)` on `current.revision`.
  - If the keep fails (network, `TOO_MANY_KEPT`), nothing else happens and the choice stays open.
  - A lost answer that was resent is recognised: when `current.draftHash` equals `documentHash` of what was sent, it is our own save.
- **The web address (PV-02, decision 9).**
  - While `meta.slug` is invalid here (by `SLUG_RE` from `lib/registry/settings.js`), every save and every kept draft sends the last saved address instead. The other edits keep saving, and `fieldsNotSaved["meta.slug"]` says "Not saved yet: …". The same happens for an address another page holds (409 `SLUG_TAKEN`): the store saves the rest at once with the last saved address, and the field shows the server's words.
  - This covers P3-CHANGES' finding: `keepAsEarlierDraft` runs the draft-mode prepare, so it gets the same substitution.
- **422.** The text and the issues are kept (`pending: {code, message, issues}`), and `unsavedWarning` is set. Nothing is retried until the next edit.
- **Leaving.**
  - `beforeNavigate()` waits for a running operation, then flushes, and answers `{ok}`. The editor uses it for console links and for switching documents.
  - `beforeUnload()` answers true (warn) while anything is unacknowledged: pending edits, a save in flight, a hold, a conflict, or an address not saved. When there are edits, it sends the save with `sendKeepalive` if the whole request is at most 60,000 bytes (UTF-8), also while a save is in flight, because the page's own fetch may be cut off.
- **Local backup.**
  - Every unacknowledged body is written to storage under `storeasy:unsaved:<tenant>:<document>:<base revision>`, and cleared on acknowledgement. Every storage call is in try/catch.
  - `open()` offers a backup whose base revision is not newer than the server's and whose body differs from the draft (by `documentHash`): "We found edits that weren't saved. Keep them as an earlier draft?" `acceptBackup()` keeps it with `keepAsEarlierDraft` (address substituted) and clears it. `dismissBackup()` clears it.

### `components/admin/editor/previewMachine.js`

`previewStep(state, input)` and `createPreviewMachine({documentId})`. It has no imports and no timers. It answers `{state, label, words, field, note, remint, reload, armReadyTimer}`.

- **Labels:** exactly PV-01's three, `"Up to date"`, `"Updating"` and `"Could not update"`, with the reason in words and, for a refused save, the field anchor.
- **Inputs:** `mintOk`, `mintFailed`, `saveAck {draftHash, issues}`, `saveFailed`, `savePending` (422), `refreshSent`, `frameLoad`, `ready {ok: true, state}`, `ready {ok: false, reason}`, `readyTimeout` (`READY_TIMEOUT_MS` = 3000 after a frame load) and `retry`.
- **Never "Up to date" over older content:**
  - a save ack while shown reloads;
  - an ack while the frame loads reloads again after its ready;
  - a ready whose `state.docs[documentId]` names an older draftHash reloads once, then says "Could not update" ("still showing an older version").
- **Re-mint:**
  - on `ready ok:false` with reason `live` (after "See the live store", PUB-11), `revoked`, `expired` or `not_found`, and on no ready within 3 seconds;
  - meanwhile it says "Updating" with "Reconnecting…";
  - after `MAX_REMINTS` (2) in a row without a good ready, "Could not update" with words;
  - `legacy` never re-mints;
  - a late ready from the old frame while re-minting changes nothing.
- **Failures with a message:** PV-01's list is incomplete section, bad link, expired session, network failure and server error. A failed save (network, server error) or a 422 (a bad link) is "Could not update" with the server's words, and a refresh or a ready does not hide it. An expired session re-mints. An incomplete section is a `note` beside "Up to date", because the frame does show it, as a placeholder.

## Acceptance, with evidence

Every item is a unit item in `scripts/test-editor-store.js`. Part 1 runs against a scripted server, Part 2 against the real documents API on file databases, and Part 3 tests the machine. On the base commit the suite was a placeholder that printed "pending", so none of these tests existed. "Mutation" names a one-line break of the new code (list under Tests) that the named test catches.

| # | Acceptance | Status | Evidence |
|---|---|---|---|
| 1 | unit: typing during an in-flight save is kept and saved next; only one save is in flight; a burst within the pause gives one save | DONE | "typing during an in-flight save…": a held first save, the pause ending during it, more typing. The answer does not replace "abc", the next save carries "abc" on revision 4, and `maxActive` is 1. "a burst of typing…": five edits 600 ms apart give no save, then exactly one with "Hello". Mutations M2, M1b |
| 2 | unit (one test each for undo, keepLiveSection, discardDraft and restoreVersion): pending edits flushed before the call; the response body replaces the local body; an edit typed during the hold is replayed onto the new body and saved; the next autosave never writes the pre-operation text | DONE | Four Part 2 tests on the real API (`replaceCase`). The request log is exactly `[saveDraft, <op>]` with the pending edit. No autosave goes out during the hold. The local title becomes the server's ("Live one", "Live words", "Live discard", "Version to restore"). `body.0` typed during the hold sits on top. It is saved on the operation's revision, and no later save carries the pre-operation title. The stored draft holds both. For Undo, the flushed edit is the server's `undo_saved`. Plus Part 1: a replay that can't apply keeps the body as an earlier draft, and a failed flush never sends the operation. Mutations M3, M4, M5, M6, M22 |
| 3 | unit: 409 stops autosave; useNewer and keepMine each leave both bodies stored (one as the draft, one as an undo_saved 'Kept from another tab'), neither as a prunable checkpoint | DONE | Part 1 "409 stops autosave…": one save, then none for 70 s of typing, with the words and the choices. Part 2 "409 then 'Use the newer version'" and "'Keep mine'", on the real API with another tab's real save. Read from `document_versions` and `documents.draft`: useNewer leaves the draft "Theirs" and an `undo_saved` noted "Kept from another tab" holding "Mine, still typing". keepMine leaves the draft "Mine, still typing" and an `undo_saved` "Theirs". Both bodies had a half-typed invalid address, and the kept one carries the last saved address, so it was not refused 422. Mutations M7, M8, M9, M10 |
| 4 | unit: a 422 keeps the text and the issues; a locally invalid slug saves the other edits with the last saved slug | DONE | Part 2 "a 422 keeps…": the real `VALIDATION_FAILED` for `meta.bogus` keeps the text, the issue, `unsavedWarning` and "Could not save: …", and nothing is stored. The next good edit saves. "a locally invalid web address…": the request carries `slug-case`, the title is stored, `fieldsNotSaved` names the address, and leaving warns. A valid address then saves. A real `SLUG_TAKEN` saves the rest with the last saved address and shows the server's words. Mutations M11, M12 |
| 5 | unit: beforeNavigate flushes; beforeUnload warns while unacknowledged and fires keepalive only at or below 60,000 bytes; a backup in a stub storage is offered on the next open and cleared on ack; a throwing storage changes nothing else | DONE | "beforeNavigate flushes…": saved with no pause, nothing unacknowledged. "beforeUnload warns…", through the real `sendKeepalive` with a stubbed fetch: no warning when saved, sent at exactly 60,000 request bytes with `keepalive: true`, not sent at 60,001 (still warns), sent at 60,000 with a two-byte "é", and sent again while a save is in flight. "every unacknowledged body is kept in storage…": the exact key, cleared on ack, re-keyed on the new base revision, offered with the exact words on a later open against revision 6, kept as an earlier draft and cleared. Other stores' and documents' keys are not offered. "a throwing storage changes nothing else": the same calls, keepalives, answers and final state as with no storage and with a memory storage. Mutations M13 to M18 |
| 6 | unit: previewMachine gives the right label and actions for each input, including re-mint on ready ok:false (reason live, ended) and on no ready within 3 seconds | DONE | Part 3, seven tests. Each input's `{label, remint, reload, armReadyTimer}` is checked. `live`, `revoked`, `expired` and `not_found` each re-mint ("Reconnecting…"), then reach "Up to date". `legacy` does not re-mint. `readyTimeout` re-mints twice, then "Could not update". Stale readies, an ack during load, failed and pending saves with the field, and the incomplete note are all covered. Mutations P1 to P8, P3 |

Brief points beyond the list, also tested: retries only on `retryable: true` or a network failure (M19); `PUBLISH_UNKNOWN` as "check what went live" (M20); publish holds autosave and uses the acknowledged hash (M21); `publishSet` replaces this document's stale offer entry; a real publish, then Undo, through the store.

## Tests

`pnpm test:editor-store` takes 0.4 s alone and 0.8 s in `pnpm test`. It starts no server and no sqld, and uses only file databases named `.test-editor-store-*.db`, which are removed afterwards. Mutations were run by `…/scratchpad/p3-b3/P3-STORE/tools/mutate.py`, one at a time, each file restored after:

| Id | Mutation | Caught by |
|---|---|---|
| M1 | remove `startSave`'s in-flight guard | survived alone: the timer path checks `inflight` too |
| M1b | remove both single-flight guards | "typing during an in-flight save…" |
| M2 | the answer's body overwrites text typed since | "typing during an in-flight save…" (and 2 more) |
| M3 | no flush before a server-replace operation or publish | the four `replaceCase` tests, publish, and 2 more (7) |
| M4 | autosave not held during the operation | 5 tests |
| M5 | held edits not replayed | 5 tests |
| M6 | the answer's body not taken | 6 tests |
| M7 | a 409 does not stop autosave | "409 stops autosave…" (and 3 more) |
| M8 / M9 | useNewer / keepMine do not keep the other body | the two Part 2 409 tests |
| M10 | kept draft sent with the half-typed address | "409 then 'Use the newer version'" |
| M11 | no last-saved-address substitution | 3 tests |
| M12 | a 422 drops the text | "a 422 keeps…" |
| M13 | beforeNavigate does not flush | "beforeNavigate flushes…" |
| M14 | keepalive limit `<` instead of `<=` | "beforeUnload warns…" |
| M15 | beforeUnload never warns | 4 tests |
| M16 / M17 | backup not cleared / never offered | "every unacknowledged body…" |
| M18 | storage errors not caught in the mirror | "a throwing storage…" |
| M19 | retry when `retryable` is false | "a save that may be retried…" |
| M20 | `PUBLISH_UNKNOWN` as a plain failure | the publish test |
| M21 | publish without the hold | 2 tests |
| M22 | a replay that can't apply is not kept | "an edit typed during a server-replace operation onto a section…" |
| P1 / P2 | no re-mint on ready ok:false / on no ready in 3 s | the re-mint tests |
| P3 | an ack during the load forgotten | survived at first, masked by the hash check. Fixed with a case whose ready does not list the document, and caught |
| P4 to P8 | stale ready says Up to date; an ack while shown doesn't reload; legacy re-mints; no give-up; a failed save hidden by a ready | each by its test |

**Edge and browser safety.** `previewMachine.js` imports nothing. `store.js` imports only relative modules: `lib/registry/settings.js` and `body.js` (with their own imports, all in the edge-checked registry), and `documentsApi.js` with the shapes file. A walk of the import graph found no package import, no `node:` and no `process.env`. A test also checks that the store uses no `window`, `document`, `localStorage`, `sessionStorage` or `navigator` global.

## Known limits

- **The pause is 700 ms.** Spec ED-03 says "a short pause" with no number. 700 ms is the legacy Designer's candidate pause. It is one exported constant, and the tests use it.
- **`NETWORK_ERROR` is retried** although it carries no `retryable` field. The brief says "retry automatically only when retryable is true". A failed fetch has no server body to say so, and spec ED-03 says "a failed save keeps the founder's text and retries". A resend whose first answer was lost is recognised by its hash, not shown as a conflict. Owner check.
- **A backup at the same revision is offered too,** not only an older one. A lost keepalive leaves the server at the backup's own revision, and plan "Uncovered points" says that case is offered. A backup equal to the draft is dropped silently. With two tabs open on one document, a tab can be offered the other live tab's unsaved body. Keeping it as an earlier draft loses nothing.
- **`TOO_MANY_KEPT` blocks the conflict choice.** With 10 kept drafts, neither "Use the newer version" nor "Keep mine" can keep the other body, so the store stays in the conflict with the server's words. P3-CHANGES recorded that kept drafts can't be deleted yet. Owner ruling.
- **The keepalive during a save in flight** goes on the acknowledged revision. If the save in flight did land, the keepalive is refused 409 and changes nothing; the backup still covers it.
- **The backup is written on every edit** (one `JSON.stringify` of the body). In node it took 0.06 ms for a 508 KB body of short strings, and the storage write comes on top of that. It was not measured in a browser, where a large localStorage write can take longer.
- **Paths are body-relative.** The preview's `data-field` paths are section-relative (validate's, for example `primary.label`, `body.0`). P3-EDITOR and P3-INSPECTOR map them to `sections.<id>.settings.<field>`.
- **Words I chose,** for the owner's ruling: the conflict sentence (the spec's "in another tab or by <name>", with "in another tab." alone for the same person), "Reconnecting…", the preview failure words, "Your latest changes aren't saved yet, so nothing else was done. They are still here.", and the kept-draft notices.
- **A publish 409 `DOCUMENT_CHANGED`** for this document also opens the conflict choice, because the draft was changed elsewhere. `DRAFT_CHANGED` and `PUBLISHED_ELSEWHERE` are returned as they are.

## Owner checks

- **Desktop Chrome, at P3-EDITOR's drill** (the store has no host page before then):
  1. type, then click a console link within the pause, and nothing is lost;
  2. close the tab within the pause: the keepalive PUT shows in the network panel and the warning appears;
  3. reopen after a lost keepalive and see "We found edits that weren't saved. Keep them as an earlier draft?";
  4. two tabs: the 409 choice, both ways, then Earlier versions shows "Kept from another tab";
  5. Undo while typing;
  6. "See the live store", then "Updating" (Reconnecting), then "Up to date".
- **Rulings:** the 700 ms pause; retrying `NETWORK_ERROR`; offering a same-revision backup; `TOO_MANY_KEPT` blocking the conflict choice; the words listed above.
- **Hosted Turso, on a staging tenant:** an Undo racing an autosave from the editor (proved here on local file databases only).
- **CI sqld download** (standing): this item does not touch `.github/`. Approving the sqld binary's source and checksum for CI is still the owner's call.
