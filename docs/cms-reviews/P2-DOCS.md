# P2-DOCS: the document write service and its console API

Branch `cms/p2-docs`, cut from `2009c8f`. Plan: `docs/cms-reviews/P2-PLAN.md` (decisions 1, 10, 13; batch 3; sections 3 and 6). Spec: DOC-01, DOC-02, DOC-04, DOC-05, DOC-07, DOC-08 (section 7.1), sections 8.2, 8.5, 8.6 ("Draft save") and 8.14. Builds on P2-ATOM (tables, ids, triggers), P2-REG (`lib/registry/`), P2-GUARD (`lib/cms-mode.js`) and P2-HARDEN. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:documents` 29 passed, 0 failed, in about 1 s. `pnpm test:failure-matrix` 112 passed, 0 failed (11 new rows), about 22 s. `pnpm test`: 66 of 66 suites passed in 116.9 s. `pnpm build` passed (only the 2 warnings that were already there); `/api/admin/documents` is in the route list |
| Browser verified | **NOT DONE.** Nothing a founder or shopper sees changed: there is no editor for documents yet (ED-02), and no store is in documents mode. Every acceptance item is a unit test |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed or deployed. No tenant changed mode: the documents API answers 409 `STORE_USES_LEGACY` to every write on every real store |

## What and why

Phase 2 needs one place that writes documents, so that every save validates, sanitizes, stores and bumps the revision together, and so a stale tab, a racing create or a broken database each give the founder a true answer. P2-ATOM made the tables and the publish commit, P2-REG made the validator; nothing yet wrote a draft. This item adds that writer, its API, the "Earlier versions" list with plain names, and teaches the media library that documents use images too (otherwise deleting an image used only in a document would break that page).

Publishing is P2-PUBLISH's. Nothing here writes `releases`, `release_state` or `publish_log`.

## Design

### `lib/documents/service.js` (Node console routes only)

| Function | What it does |
|---|---|
| `createDocument({type, meta, body, entityId, actor})` | The type must be registered (else 422 `UNKNOWN_TYPE`) and editable (`journal_index` is refused). Singletons get `doc_<type>`; every other type gets `newRouteId()`. `product_content` needs `entityId`. The body defaults to the registry's `emptyBody(type)`, with `meta` laid over it for route types. One batch: a plain `INSERT INTO documents` plus a first checkpoint ("Created"). A `documents_slug` clash is 409 `SLUG_TAKEN` "Another page already uses /<slug>: <title>" (the other page is read again to name it); a primary-key clash on a singleton is 409 `DOCUMENT_EXISTS`; a second content document for one product is 409 `DOCUMENT_EXISTS` (the `documents_entity` index). Never 5xx or 422 for these |
| `saveDraft({id, revision, body, actor})` | Read once (404, 409 archived, 409 stale with the current document). Validate in draft mode: any error is 422 with every issue, nothing stored; incomplete issues and warnings ride along with the 200. The stored body is the validator's (HTML sanitized, old sections upgraded, ids made sure by `ensureIds`). Then ONE `libsql.batch(…, "write")`: the guarded `UPDATE documents SET draft, draft_hash, slug, label, revision + 1 … WHERE id = ? AND revision = ? AND archived_at IS NULL`; the abort; a checkpoint `INSERT … SELECT … WHERE NOT EXISTS (a checkpoint newer than the interval)`; the prune |
| `restoreVersion({id, versionId, revision, actor})` | The version's body, upgraded and validated in draft mode, goes into the draft only. Same batch shape, with the draft it replaces kept first as a checkpoint ("Before restoring an earlier version"), so nothing typed is lost. `release_state` and `releases` are never touched |
| `discardDraft({id, revision, actor})` | The draft goes back to the published version's body; the replaced draft is kept as a checkpoint first (spec 8.14). A document never published is 409 `NOTHING_PUBLISHED` |
| `archive({id, revision, actor})` | Refused for singletons (409 `CANNOT_ARCHIVE`) and for a live document (409 `DOCUMENT_LIVE`, "Take it offline first"). The UPDATE is also guarded on `published_version_id IS NULL`, so a publish that lands between the read and the batch still wins |
| `saveVersion({documentId, kind: "undo_saved", body?, actor, note})` | Internal, for PUB-04: keeps the current draft (or `body`) as an `undo_saved` version, which the cap never prunes. Any other kind throws |
| `getDocument`, `listDocuments`, `listHistory` | Reads. `listDocuments` on a store from before 0021 is `[]` |

**The abort.** `INSERT INTO cms_state (id, mode, updated_at) SELECT 2, 'abort', 'abort' WHERE changes() = 0`. `cms_state` has `CHECK (id = 1)`, so when the guarded UPDATE changed nothing, this insert fails and the whole batch rolls back (the GEN-02 pattern P2-ATOM proved on sqld). `discardDraft` and `restoreVersion` put their checkpoint insert *before* the UPDATE, so `changes()` is always the UPDATE's own.

**After a batch throws** (`settle`): a `documents.slug` unique violation is `SLUG_TAKEN`. Otherwise the row is read once more: if it already holds this very write (revision + 1, our `updated_at`, our hash) the answer was lost after commit and the save is reported done (200); gone is 404; archived or another revision is 409 with the current document; anything else goes on to `failure()` as a 5xx with a code. A re-read that itself fails reports the original error.

**Checkpoints** (`lib/documents/versions.js`). `CHECKPOINT_INTERVAL` is 5 minutes (`setCheckpointInterval(ms)` for tests, no env var). The decision is made inside the save's own batch, with no extra read. The prune deletes the oldest checkpoints beyond 20, and never a version that `publish_log` names as `from_version_id`, `to_version_id` or `saved_version_id`, or that a document row points at as published or undone. Those count against the 20, so the newest unreferenced ones fill what is left. Publish never points the log at a checkpoint (plan section 6: it always mints a fresh published version), so in practice this is simply the newest 20. Release lists only name published and migrated versions, which the 0021 trigger already refuses to delete. The SQL uses `NOT EXISTS` (a `NULL` inside `NOT IN` would make it delete nothing).

**Names.** `created_by` holds `<actor kind>:<actor id>`. `listHistory` resolves it through the new `teamMemberNames(tenantId)` in `lib/platform/identity.js` (one statement: memberships joined to users; the name, or the email when no name is set). A merchant who has left, the bootstrap password and any unknown actor read "Someone on your team"; our support operators, `system`, `cli` and a missing value read "Storeasy". A control plane that can't be read gives the fallbacks and a log line, not a failed list.

**Explicit empty.** A home draft saved with `sections: []` is stored and read back as `[]` (the validator keeps it; nothing swaps in defaults).

### `lib/admin/documents-api.js` and `app/api/admin/documents/route.js` (`runtime = "nodejs"`)

`PUT /api/admin/documents` with exactly one operation key, parsed before it is authorized (the A1 rule of `lib/admin/cms-api.js`). Any key that is not an operation or `revision` is 400 `UNKNOWN_OPERATION`, so a legacy `block` key mixed in can't ride along.

| Operation | Capability | Body |
|---|---|---|
| `getDocument`, `listHistory` | `storefront.read` | `{getDocument: id}` |
| `listDocuments` | `storefront.read` | `{listDocuments: true}` or `{type, includeArchived}` |
| `createDocument` | `storefront.write` | `{createDocument: {type, meta?, body?, entityId?}}` |
| `saveDraft` | `storefront.write` | `{saveDraft: {id, body}, revision}` |
| `discardDraft`, `archive` | `storefront.write` | `{archive: id, revision}` |
| `restoreVersion` | `storefront.write` | `{restoreVersion: {id, versionId}, revision}` |

Order for writes: parse (400) → authorize (401/403) → mode: 409 `STORE_USES_LEGACY` unless `getCmsMode()` is `documents` (an unreadable mode is a 5xx, never a go-ahead) → 428 `REVISION_REQUIRED` for saveDraft, discardDraft, restoreVersion and archive → the service. The mode is checked before the revision, so the founder hears the real reason first (as P2-GUARD does). Errors: `DocumentError` keeps its status, code and extras (`current`, `other`); everything else goes through `failure()` (422 with `validationBody`, 404, 5xx with a code and "nothing was saved"; raw text only in the log). Writes are audited (best-effort).

### `lib/media.js`

`mediaUsage` now also scans `documents.draft` (archived documents left out) and `document_versions.body` for the media URL and its variants' URLs, and labels each document once per label: `draft`, `live` (the version `published_version_id` names) or `older version` (any other kept version). `deleteMedia` refuses while any hit exists, and a hit in a document refuses **even with `force`**: versions are frozen, so the image would be missing from that page, or from Restore, for good. Legacy hits keep today's `force` behaviour. A store from before 0021 reports no document hits; any other read failure of the new scan throws (so the delete is refused with a 5xx), unlike the older scans, which still swallow errors (unchanged, see Known limits).

### `scripts/test-failure-matrix.js`

A `failingBatch(name, pattern, fn)` helper breaks only `libsql.batch`, only for a batch carrying a matching statement, so the reads before it and the re-read after it still work. New rows on a documents-mode store: the save, create and restore batches refused by the database (503 `DATABASE_ERROR`, "nothing was saved", storage re-read unchanged); the database not answering (503 `DATABASE_UNAVAILABLE`); an unknown section kind (422 with the section id); stale (409 `DOCUMENT_CHANGED` with the current document); a taken slug (409 `SLUG_TAKEN`, exact words); no revision (428); a legacy store (409 `STORE_USES_LEGACY`); two operations (400); support (403).

## Acceptance, with evidence

"Fails without" says what proves the test bites. At `2009c8f` `scripts/test-documents.js` was the placeholder and none of the service, API, `teamMemberNames` or the media scan existed, so every test below fails there on import. The named mutations (M1 to M17) were each applied alone to the finished code and the suite run (script: `scratchpad/p2-b3/P2-DOCS/mut/run.py`, files restored after each).

| # | Item | Status | Evidence (`test-documents` unless named) | Fails without |
|---|---|---|---|---|
| 1 | A home, a campaign, a journal post, the product_layout and one product_content are document rows created and saved through the same functions | DONE | "a home, a campaign, a journal post, …": all five through `createDocument` then `saveDraft` via the API; one table; singleton ids `doc_home`, `doc_product_layout`, random ids for the rest; `entity_id` kept | The base (no service) |
| 2 | Changing a page's meta.slug updates documents.slug and keeps the id; after renaming 'about' to 'about-us', creating a new 'about' succeeds; after archiving a page, creating a page at its slug succeeds | DONE | "a page's meta.slug change …" | Base; M17 |
| 3 | Two racing creates at one slug give one success and one 409 SLUG_TAKEN, never 422 or 5xx; saveDraft moving a page onto a taken slug gives 409 SLUG_TAKEN naming the other page, storage unchanged | DONE | "two racing creates …" (10 races with `Promise.all`, page against page and page against campaign; the loser's message names the winner exactly; one row each); "saveDraft moving a page onto a taken slug …" (exact message "Another page already uses /about-us: About us", `other.id`, full dump of documents, versions, log, release tables and cms_state unchanged). Also "restoring a version whose address another page now uses …" | M4 (slug clash not mapped: 409 `SAVE_CONFLICT` with no name) |
| 4 | API: a stale saveDraft returns 409 with the current body and revision, storage unchanged | DONE | "API: a stale saveDraft …" (staff saves first, owner's save is 409 `DOCUMENT_CHANGED` with `current.revision` and `current.body`; no raw actor id in the answer; dump unchanged). "a stale write that slips past the first read still loses inside the batch …" lands the other save between the read and the batch: 409, the other save kept, no checkpoint of the losing save, dump taken after the other save unchanged | M1 (no abort: the losing save overwrote) |
| 5 | API: archive, discardDraft and restoreVersion with no revision return 428, storage unchanged | DONE | "API: archive, discardDraft and restoreVersion (and saveDraft) with no revision …" (also `revision: null`) | Base. Note: the service refuses a non-integer revision with the same 428, so removing only the API's check does not fail this test; it is a second line |
| 6 | An unregistered type is refused and nothing is stored; an unknown section kind gives 422 and nothing is stored | DONE | "an unregistered type is refused …" (API and service; `UNKNOWN_KIND` on the section's id; dump unchanged) | Base |
| 7 | A draft with `<script>` stores no script; a new banner with no text saves (200) with an 'incomplete' issue carrying documentId, sectionId and field | DONE | "a draft with <script> stores no script" (draft and every version row checked; the words kept); "a new banner with no text saves …" | M12 (unsanitized body stored) |
| 8 | No issue text reaching the API matches `/Section \d+ \(/` | DONE | "no issue text reaching the API …": every issue in every API answer of the suite (incomplete and error severities, at least 8, including a body with two heroes, a banner and an unknown kind that returns all its issues), checked as sent and as `issueText` words it | Base. The positional wording itself is P2-REG's tested rule |
| 9 | Failure matrix: a forced batch failure on save, create or restore gives 5xx with a code and a founder-readable message, never 422 | DONE | `test-failure-matrix` "save: documents: the database refuses the saveDraft / createDocument / restoreVersion batch → 503 DATABASE_ERROR": `check()` asserts 5xx, a code, "nothing was saved. Your changes are still here", no issue list; the helper asserts the batch was really sent and refused; storage re-read unchanged | M11 (batch failure answered as a conflict): the save and restore rows fail. The create row has its own catch path; at base it fails on import |
| 10 | A home draft with sections [] reads back as [] | DONE | "an explicit empty sections list on the home draft …" (stored and via `getDocument`) | Base |
| 11 | restoreVersion puts the version into the draft, bumps the revision and leaves release_state untouched | DONE | "restoreVersion puts the version into the draft …" (release_state and releases byte-equal; the replaced draft kept as a checkpoint with its words) | M9 (no copy of the replaced draft) |
| 12 | An undo_saved version survives 100 later autosaves (interval 0) and appears in listVersions; checkpoints never exceed 20 per document | DONE | "an undo_saved version survives 100 later autosaves …" (count checked after every save: the maximum is exactly 20; the undo_saved row still there; listed via `listHistory` with kind, plain name and note; 21 entries; newest checkpoint is save 99). "at the normal 5-minute interval …" proves the interval | M3 (no cap), M13 (interval ignored), M10 |
| 13 | Pruning never removes a checkpoint referenced by publish_log; the trigger blocks deleting published, migrated or undo_saved versions | DONE | "pruning never removes a checkpoint referenced by publish_log (from, to or saved) …": the three oldest checkpoints named by log rows (one per column) survive 30 more saves, and the rest stays within the cap (17 unreferenced plus 3 kept); each of the three kinds' DELETE raises "only checkpoint versions can be deleted" | M2 (prune ignores the log) |
| 14 | listHistory shows plain names, never matching `/^(user|member|tenant|kind)[:_]/` | DONE | "listHistory shows plain names …": a named owner ("Asha Rao"), a staff member with no name (their email), a member who has since left, a support operator, bootstrap, null and an odd `user:u_raw` value; none raw; exact fallbacks asserted; read by a support (read-only) session | M10 (raw ids) |
| 15 | A media id used only in a doc_home draft, or only in a retained version body, is reported in use with the right label, and deleteMedia refuses it; unused media still deletes | DONE | "a media id used only in a doc_home draft, …": `draft`, `older version` and `live` each reported alone and refused, also forced; the refusal names "Home page (draft)"; unused media really deleted. Also "an archived document's draft no longer holds media in use …" and "a media scan that can't read the documents tables refuses the delete …" | M5 (no document scan), M6 (force deletes), M15 (archived drafts scanned) |
| 16 | API: storefront.read-only staff get 403 on every write op with storage unchanged; a mixed payload gives 400; a legacy-mode tenant gets 409 STORE_USES_LEGACY on writes and 200 on reads | DONE | "API: storefront.read-only staff get 403 …" (all five writes; dump unchanged; their reads 200; signed out 401); "API: a mixed payload gives 400 …" (support and owner; also a legacy `block` key mixed in; malformed bodies; dump unchanged); "API: a legacy-mode tenant gets 409 …" (all writes, also with no revision, and `migrating`; legacy dump unchanged; list 200 `[]`; get 404). "API: a cms_state that can't be read is a 5xx …" | M7 (mode ignored), M16 (first of two operations taken) |
| 17 | A scan finds no INSERT, UPDATE or DELETE on documents, document_versions or publish_log outside lib/documents/ (test files allowlisted) | DONE | "a scan finds no INSERT, UPDATE or DELETE …": walks lib, app, components, scripts and migrations (raw SQL and Kysely forms, `INSERT OR …`, `REPLACE INTO`); allowlist is `scripts/test-*.js`; the test also proves the pattern catches five write shapes and passes reads | The scan's own bite cases |

Also proven: "a save whose answer was lost after it committed is reported saved (200)" (M8 fails it); "archive is refused on a live document; discardDraft …" (the live body comes back, the discarded draft kept as a checkpoint, `NOTHING_PUBLISHED` for a never-published page).

**One mutation not caught on its own:** M14 removes the early "archive refused on a live page" check. The test still passes because the batch's own guard (`published_version_id IS NULL`) refuses the archive and the catch path answers the same 409 `DOCUMENT_LIVE`. The early check is a second line, not the only one.

### Requirements, and what is left

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| DOC-01 | One table and one set of functions for five types; ids kept across a slug change; unregistered types refused at write; versions can't be updated or deleted through the service (it has no such path; the trigger refuses the rest) | Backfill ids twice (MIG-01) |
| DOC-02 | One service, one batch per write; 428 with no revision; 409 with the current document; racing creates 409, never 422; the write scan | "The text stays in the editor" (ED-02); the four bypass writers (P2-WRITERS) |
| DOC-04 | Issues with document and section ids; database failures are 5xx with a code (failure matrix); no positional words | Preview and publish rows for documents (P2-PREVIEW, P2-PUBLISH) |
| DOC-05 | Incomplete drafts save; structure refused; script stripped on every write | Publish re-validation (P2-PUBLISH); schedule (PUB-07) |
| DOC-07 | An empty home draft stays empty; an image can be added to the hero through the API | Rendering (P2-SECTIONS); the empty-home refusal at publish (P2-PUBLISH, rule from P2-REG) |
| DOC-08 | Checkpoints capped at 20 with a 5-minute interval; undo_saved kept and listed; restore into the draft; pruning safe against the log; plain names | The list in the editor (ED-02); pruning against pending schedules (PUB-07); restore then publish (P2-PUBLISH) |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:documents` (replaces the P2-ATOM placeholder; `package.json` unchanged) | 29 passed, 0 failed | about 1 s (1.1 s in the gate) |
| `pnpm test:failure-matrix` | 112 passed, 0 failed (11 new rows) | about 22 s |
| `pnpm test` | 66 of 66 suites passed | 116.9 s |
| `pnpm build` | passed; 2 warnings that were already there | |

The suites print one `documents_write` log line per write (about 200 in `test:documents`); that is the service's normal `slog`.

## Known limits

- **The mode check is a pre-check** (as P2-GUARD's). The API reads `cms_state` before the write; a cutover landing in between is not caught (MIG-03). The service itself does not check the mode: P2-WRITERS' facade must only call it in documents mode.
- **`createDocument` takes no revision**: there is nothing to compare against. A second create of a singleton is 409 `DOCUMENT_EXISTS`.
- **`product_content` ids are random** (`newRouteId()`), not `doc_prod_<hash>` as spec 8.3 says. One document per product comes from the `documents_entity` index. The backfill (MIG-01) decides its own ids.
- **Media used in any kept version can never be deleted**, even forced, until retention (PERF-05) removes unreferenced versions; published and Undo-saved versions are kept for good today. An owner decision (below).
- **The media scan reads every draft and version body** (`instr`), a full scan per check. Fine at today's sizes; `document_refs` (MED-03) replaces it. The scan matches by prefix, as the legacy one does: `/api/media/med_1` would also match `med_12`. Real ids have a fixed length.
- **The older legacy media scans still swallow every read error** (unchanged code). Only the new document scan fails closed.
- **A version that no longer passes today's draft rules can't be restored** (422 with its issues), for example one holding an external link (P2-REG's link rule). The founder sees why.
- **`discardDraft` and `restoreVersion` always add a checkpoint**, even when the replaced draft equals the newest checkpoint.
- **A save whose re-read fails after a lost answer** is reported as a 5xx "nothing was saved" even though it may have committed (the same limit as the legacy save). With `lib/db.js`'s retry, the resent batch loses its guard and the re-read recognises the first write as ours, which the "lost answer" test covers.
- **Not built** (spec 8.14 lists them; later items): `listChanges`, `createFromBlueprint`, `resetField`, and every publish operation.
- `listDocuments` has no paging.
- No browser drill: there is no screen yet.

### From review

Non-blocking findings from the independent review, added at merge.

- The report says every write treats a lost answer as a success, but that is false for createDocument on a page that has an address (lib/documents/service.js, createDocument catch block). I reproduced it the same way the suite's own 'lost answer' test does: the batch commits, then throws 'fetch failed', and lib/db.js sends it again. On the second try SQLite reports 'UNIQUE constraint failed: documents.slug' before the primary-key error, so uniqueBroken() returns 'slug' and slugTaken() runs before the 'is this row ours?' check. The founder gets 409 SLUG_TAKEN 'Another page already uses /sale: Sale page', which names the page they just made, and that page really exists. The same retry with no address, a singleton create, restore and archive all came back 200. Fix: read the row and do the createdAt/draftHash 'mine' check before mapping the slug error, and add a lost-answer create test for a page with an address. Nothing is lost, so this does not block, but the founder is told something false.
- The checkpoint prune scans whole tables on every autosave. EXPLAIN QUERY PLAN for pruneStatement shows 'SCAN p' (publish_log) and 'SCAN d' (documents) as correlated subqueries for each checkpoint, in all three subqueries. That is about 3 x 21 full scans of publish_log and documents per save, and publish_log never shrinks. On Turso, which bills by rows read, this grows with every publish. Fix: limit the publish_log check to p.document_id = v.document_id (publish_log_doc index), and the documents check to d.id = v.document_id. Hand this to P2-PERF or PERF-05.
- Tests miss several lines; each of these changes, applied alone, left test-documents at 29 of 29. (h/k/l) Removing the early archived check, the 'archived_at IS NULL' guard in the UPDATE, or both: no test saves or restores into an archived document. (a) Removing 'WHERE m.tenant_id = ?' from teamMemberNames: names from other stores' members would resolve and nothing notices. (r) Letting getVersion skip the document_id match: one page could restore another page's version, and nothing tests it (it is correctly refused today; I checked by probe, 404). (e) listDocuments ignoring includeArchived. (f) restoreVersion skipping upgradeBody: no difference until the schema version moves. (j) The 'published_version_id IS NULL' archive guard inside the batch, which is the only guard against a publish landing between the read and the archive.
- The API lets any storefront.write user create and save doc_cart (cart suggestion title and products). P2-REG's packet said 'nothing writes doc_cart in phase 2', and the doc_cart capability ruling (upsells.write or storefront.*) is still an open owner check. Today's staff role has both, so this only matters for custom roles, and no tenant is in documents mode yet. The P2-DOCS packet should either refuse cart writes until the ruling or carry the owner check.
- The console's media screen (components/admin/MediaAdmin.js) lists usage by u.where. A hit in a document now shows the raw 'draft:doc_home' or 'older version:doc_xxx'. Its 'force delete' path will also always fail for a document hit with 'Still referenced — the server refused the forced delete'. Only documents-mode stores see this, and none exist yet. The editor UI work should show u.name and u.label instead.
- The packet does not mention that the media usage preview (PUT /api/admin/media) now calls a mediaUsage that can throw (the new document scan fails closed) and has no try/catch. A read failure there turns into the tenantHandler's generic error instead of an infraResponse 5xx with a code.
- What I verified: the 29/29 suite result; pnpm test (65 of 66 suites passed; the one failure was test-documents' write scan flagging my own probe file, which shows the scan bites, and after I removed the probe test-documents passed 29/29); pnpm build passes. The 18 changes I tried in total: the other 9 were caught (prune ignoring publish_log 'to' or 'saved', cap 21, no 'live' media label, no version scan, unsanitized body, discard/restore without the kept checkpoint, create ignoring meta, operator named as a team member). By probe: legacy stores get 409 STORE_USES_LEGACY on writes; a duplicate product_content gives 409 DOCUMENT_EXISTS; a second create of home gives 409 DOCUMENT_EXISTS; a revision sent as a string gives 400; restoring another document's version gives 404; uppercase addresses give 422 SLUG_INVALID. The new code is reached only from a nodejs route, and lib/media.js stays nodejs-only. Nothing under .github/, package.json or the migrations changed. The worktree is removed and no server was started.

## Owner checks

1. **CI sqld install** (carried from P2-ATOM, still open): `.github/` was not touched. Approve the libsql-server release and its SHA-256, then add the step from `docs/cms-reviews/P2-ATOM.md` owner check 1.
2. **Media in old versions**: decide whether an image used only in an older version (not live, not the draft) may be force-deleted, accepting that restoring that version shows a missing image. Today it is refused.
3. **Names in "Earlier versions"**: confirm "Someone on your team" for people who left and for the shared store password, and "Storeasy" for support and automatic changes, and that showing a teammate's email when they set no name is fine.
4. **Hosted Turso** on a staging tenant in documents mode: a save, two saves racing from one revision (one 409), two creates racing at one slug (one 409 `SLUG_TAKEN`), and a save while another connection holds `BEGIN IMMEDIATE`.
5. **The checkpoint interval** is 5 minutes (spec: "exact value at build time"). Confirm, or give the number.
