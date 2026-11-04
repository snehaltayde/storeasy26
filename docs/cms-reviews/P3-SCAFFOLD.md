# P3 · SCAFFOLD · The phase 3 suites and the documents API contract

Branch `cms/p3-scaffold`, cut from `92aab13`. Plan: `docs/cms-reviews/P3-PLAN.md` (decision 3; batch 0) and `P3-BATCHES.json`. Requirements it prepares: PUB-02, PUB-04, PUB-11, ED-02. It proves none of them by itself: it gives later items one place to register their tests and one response contract to test against. No migration.

Nothing in the app imports the new file yet. No tenant changes mode. Today's releases, editors and preview are untouched.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 132.9 s (66 before, plus 14 placeholders and `test:api-shapes`). `pnpm test:api-shapes`: 25 passed, 0 failed, in 0.1 to 0.4 s. `pnpm build` passes |
| Browser verified | Not applicable. Nothing a shopper or founder sees changed, and no page imports the new file. No dev server ran, and ports 3600 and 4600 to 4609 were not used |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. Nothing here touches the database |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

Phase 3 has 19 items over 5 batches. Two things must be fixed before batch 1 is cut:

1. **The suites.** `scripts/run-tests.js` fails the gate when a `scripts/test-*.js` file has no `test:*` script in `package.json`. If each item added its own script, every branch would edit `package.json` and they would clash on merge. So every phase 3 suite is registered now, with a placeholder file. Each owner later replaces only its own file. Only P3-RTE may edit `package.json` again, and only if a dependency is approved.
2. **One response contract.** The server items (COMMIT, CHECKS, UNDO, CHANGES) and the client items (SESSION's `documentsApi.js`, PUBLISHUI and the other editor parts) are built in parallel. Without one written contract, each side would guess the other's field names. `lib/admin/documents-api-shapes.js` is that contract. The server tests assert their answers against it, and the client tests feed its examples to the client.

## Design

### `package.json` and the placeholders

15 new scripts, each exactly `node scripts/test-<name>.js`, added after `test:perf-docs`:

| Suite | Owner | File today |
|---|---|---|
| `test:logout-preview` | P3-SESSION | placeholder |
| `test:doc-diff` | P3-DIFF | placeholder |
| `test:publish-checks` | P3-CHECKS | placeholder |
| `test:publish-undo` | P3-UNDO | placeholder |
| `test:doc-changes` | P3-CHANGES | placeholder |
| `test:preview-frame` | P3-FRAME | placeholder |
| `test:editor-store` | P3-STORE | placeholder |
| `test:editor-inspector` | P3-INSPECTOR | placeholder |
| `test:editor-tree` | P3-TREE | placeholder |
| `test:publish-ui` | P3-PUBLISHUI | placeholder |
| `test:editor-routes` | P3-ROUTES | placeholder |
| `test:editor-shell` | P3-EDITOR | placeholder |
| `test:design-doc` | P3-DESIGN | placeholder |
| `test:rich-text` | P3-RTE | placeholder |
| `test:api-shapes` | P3-SCAFFOLD | the real check (below) |

Each placeholder prints `pending: owned by cms/p3-<id>` and exits 0, the same form as phase 2's.

`scripts/test-api-shapes.js` is **one file beyond the plan's list**. The acceptance asks for "a small check in the scaffold commit", and every listed test file belongs to another item, which will replace it. A check placed in one of those would be deleted by its owner. So the check has its own suite, which no later item owns. The orchestrator should add it to this item's files in `P3-BATCHES.json`.

### `lib/admin/documents-api-shapes.js`

This file holds data only. It has no import, no function and no runtime read, so the edge storefront and the console client can both load it. Its parts are:

- `SHAPES_VERSION = 1`.
- `SHAPES[operation]` = `{ access, request, requestOptional?, outcomes }`, for all 17 operations: the 10 that exist today, plus `unpublish`, `undo`, `undoSet`, `listRecentlyPublished`, `listChanges`, `keepLiveSection` and `keepAsEarlierDraft`. `publishSet` says `sameOutcomesAs: "publish"`, because one handler answers both.
- Each outcome is `{ status, since, body, optional?, addedInPhase3? }`:
  - `since: "p2"` means the API answers this today. The code and fields were copied from `lib/admin/documents-api.js`, `lib/documents/*.js` and `lib/cms/issues.js`, and nothing was renamed.
  - `since: "p3"` means the outcome is new, even when its code is reused (for example `PUBLISHED_ELSEWHERE` for Undo).
  - `optional` lists the key paths that may be missing from a real body, such as `rows[].note`. Every other key is always present, even when its value is null. The example still shows each optional key, so its type is known.
  - `addedInPhase3` marks the fields a phase 3 item adds to an outcome that exists today. One example is `published[].liveUrl` and `published[].undo` on the publish 200. A test can drop these keys to compare against today's answer.
- `COMMON.outcomes`: the outcomes any operation can give. These are the four 400 parse codes, 401 and 403 from `requireAdmin` (which send no code), 404 `NOT_FOUND`, the generic 422, the five `failure()` infrastructure answers, and 501 `NOT_BUILT`.
- Named pieces, exported so tests can use them: `ISSUE`, `PUBLISH_ISSUE` (plus `level`, `anchor`, `where`, `actions`), `DOCUMENT`, `ACCESS`, `CURRENT` (the document plus `updatedBy`, `updatedByName`), `OFFER`, `UNDO_ARGS` and `DRY_RUN`.

Every new entry the brief lists is in the file. Here is where each one sits, and the readings I chose where the brief left room. **Later items must follow these readings, or change this file in their own branch and say so:**

| Brief entry | Where | Reading |
|---|---|---|
| publish items gain `liveUrl`, `undo`; `confirmRepublish` | `publish.ok` (`addedInPhase3`), `publish.request`, `publishSet.request` | The "items" are `published[i]` |
| 409 `DOCUMENT_CHANGED`, `PUBLISHED_ELSEWHERE` with `current {id, revision, draftHash, updatedBy, updatedByName}` | `CURRENT`, and every 409 that carries `current` | `current` stays today's whole public document; the two new keys are added. Nothing is removed, so today's readers keep working |
| 409 `SLUG_TAKEN` `other {id, label}` | save, publish and undo `slugTaken` | Today `other` is `{id, title}` (the meta title, else the label). `title` stays and `label` is added (`addedInPhase3: ["other.label"]`). `other` can be null on a save, as it is today |
| 409 `REPUBLISH_CONFIRM_NEEDED {id}` | `publish.republishConfirmNeeded` | |
| 409 `FIRST_PUBLISH_NEEDS_HOME` with `offer` | `publish.firstPublishNeedsHome` | |
| 409 `TOO_MANY_KEPT` | `keepAsEarlierDraft.tooManyKept` | |
| 409 `STORE_USES_LEGACY`, also for the two new reads | `legacy` on every write, publish and new read | The two reads get their own words: "…so this isn't available here yet." |
| 422 issue `level`, `anchor`, `where`, `actions` | `PUBLISH_ISSUE`, `publish.validationFailed` | Only publish issues gain these keys. Draft-save issues (`COMMON.validationFailed`, the save 200s) are unchanged, because CHECKS owns `publish.js` only |
| 422 `LINKS_TO_UNPUBLISHED` with `issues` and `offer` | `publish.linksToUnpublished` | The body is `{error, code, issues, offer}`, without the `errors`, `warnings` and `documents` of `VALIDATION_FAILED` |
| 501 `NOT_BUILT` | `COMMON.notBuilt`, listed on each stubbed operation | |
| undo 200 | `undo.ok` (`savedVersion` optional), `undo.nothing` | `liveUrl` is null when nothing is live at that address afterwards (take offline, nothing) |
| dry run | `DRY_RUN`, on `undo`, `unpublish`, `undoSet` | For `unpublish` and for a set, `target` is null |
| `unpublish` 200, `undoSet` 200 | `unpublish.ok`, `undoSet.ok` | |
| `listRecentlyPublished` 200 | `listRecentlyPublished.ok` | `undo` is null when `canUndo` is false; `note` is optional |
| `listChanges` 200, both forms | `listChanges.ok`, `listChanges.firstPublish` | No changes means `rows: []`. `sectionId` and `affects` are optional |
| `keepLiveSection`, `keepAsEarlierDraft` 200 | their `ok` | |
| `document.access {canPublish, reason}` | `getDocument.ok.document.access`, `listDocuments.ok.documents[].access` | It is on every list row, as the brief says ("document.access"). `reason` is null when `canPublish` is true |

Further choices made here, not spelled out in the brief:

- **Every 200 carries `ok: true`**, including the new reads and the dry runs. Today's 200s all do, and one rule keeps the client mapper simple.
- **`revision` stays a top-level key** on the new writes, as on `saveDraft` and `publish`: `{ undo: { id, logId, dryRun? }, revision }`, `{ unpublish: { id, dryRun? }, revision }` and `{ keepLiveSection: { id, sectionId }, revision }`. `undoSet` and `keepAsEarlierDraft` have none. P3-COMMIT's parser must read it this way.
- **One new code that the brief doesn't name:** `CANNOT_TAKE_OFFLINE` (409) for `unpublish` of a singleton, built like today's `CANNOT_ARCHIVE`. The UNDO brief gives the words but no code.
- **Undo and unpublish answer 409 `DOCUMENT_CHANGED` after 3 losses** (UNDO brief, step 7), and 503 `PUBLISH_UNKNOWN`, `PUBLISH_BUSY` and 500 `PUBLISH_FAILED` like publish.
- **Example words** for the new outcomes use the brief's wording where the brief has some. The Undo success message, the dry-run target name and the closed-store read words are my placeholders. Their owners may change the words but not the keys.

## Acceptance, with evidence

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: `pnpm test` is green with every placeholder; `run-tests.js` reports each new suite as a pass | DONE | `pnpm test`: "81 of 81 suites passed in 132.9s". Each of `test:logout-preview` … `test:rich-text` and `test:api-shapes` is listed with ✓. Each placeholder run on its own prints its `pending: owned by cms/p3-<id>` line | Without the `package.json` entries: removing just `test:rich-text` makes `node scripts/run-tests.js` exit 1 with "scripts/test-rich-text.js has no test:* script in package.json, so it would never run". Writing `node scripts/test-doc-diff.js \|\| true` makes it exit 1 with "test:doc-diff must be: node scripts/<file>.js" |
| 2 | unit: `documents-api-shapes.js` imports nothing, and every example's code matches the code string the API emits today for existing outcomes | DONE | `scripts/test-api-shapes.js` (25 checks). (a) The source, with comments stripped, has no import, dynamic import, re-export, `require`, `node:`, function, arrow, class, `new`, `process`, `globalThis` or `await`. (b) Every `since: "p2"` outcome's code appears as a string in `lib/admin/documents-api.js`, `lib/documents/*.js` or `lib/cms/issues.js`. Where the source pairs that code with a status (`DocumentError(409, "CODE"`, `status: 409 … code: "CODE"`), the status must match. (c) Every code the sources emit today has a p2 outcome. (d) A p3 outcome uses either an existing code or one of the 6 listed new codes, and a "new" code must not already exist. (e) The fields match: `ISSUE` equals `ISSUE_KEYS` and `issue()`; the 422 equals `validationBody()` exactly; the infrastructure bodies equal `failure()` and `infraMessage()`; `DOCUMENT` equals `fromRow()` plus `publicDocument()` (in both `service.js` and `publish.js`); the list and history rows match their mappers; the publish 200 and its items match `documents-api.js` and `done()`; the conflict entries match `stale()`; the extra fields of the slug, deleted, unknown, failed and not-publishable refusals match; 11 fixed messages are found word for word; today's requests parse with today's `parseDocumentsOperation` | Mutation run (`scratchpad/p3-b0/P3-SCAFFOLD/mut/run.py`; each mutation applied alone, then the file restored). No shapes file: exit 1. A p2 code renamed (`DOCUMENT_CHANGED` to `DOC_CHANGED`): caught. `SLUG_TAKEN` given 422: caught ("the code says 409"). An import added: caught by (a). An arrow function added: caught. `undoneVersionId` dropped from `DOCUMENT`: caught. `SHAPES_VERSION` 2: caught. The legacy words changed: caught. `CANNOT_ARCHIVE` renamed in `service.js`: caught. A new code misspelt: caught. The 422 `errors` emptied: caught. An extra key in the publish 200: caught. One mutation is **not** caught: removing `cartLocked` from `createDocument` alone, because the code still has outcomes on other operations. The coverage check works per code, not per operation (known limit) |

## Tests

- `pnpm test:api-shapes`: 25 passed, 0 failed, 0.1 to 0.4 s. It opens no database: it reads source files and imports only `lib/cms/issues.js` and the pure parser in `lib/admin/documents-api.js`. The parser's imports load `lib/db.js`, so the suite sets the database variables to unused local file names. No file is created (checked).
- `pnpm test`: 81 of 81 in 132.9 s. Every suite of phases 1 and 2 is still green, including the legacy ones the plan's section 3 lists.
- `pnpm build`: passes.

## Known limits

- **The contract is examples, not a validator.** It has no types beyond the example values, and no function that checks a body against it, because the file must stay data only. Each later suite writes its own "same keys" compare: walk the example, skip the `optional` paths, and for a phase 2 answer also skip the `addedInPhase3` paths. P3-SESSION could share one helper in a test-support file it owns.
- **The status check reads source patterns.** It pairs a code with a status only where the source writes them together (`DocumentError(<status>, "<code>"` or `status: <n> … code: "<code>"`). `NotFoundError` and `ValidationError` are special-cased. A code built some other way is checked for existence only.
- **Coverage is per code, not per operation** (the one surviving mutation above). An outcome that is missing from one operation, while its code is listed on another, is not caught.
- **The p3 outcomes are a design.** Nothing emits them yet, so nothing proves them except the later items' tests, which must compare against this file. When an owner needs a different key, it changes this file in its own branch, says so in its packet, and keeps `SHAPES_VERSION` at 1 until phase 3 merges. Changing the version is for a contract that has shipped.
- **`documents[].access`** follows the brief literally (on every list row), although canPublish depends only on the role today.
- **`scripts/test-api-shapes.js` is not in the plan's file list** (see Design). It also pins today's source text in a few places, such as the 200 body line of `documents-api.js`, `conflictError()`, and the extra fields of the slug refusals. A later item that changes one of them on purpose must update this check in the same branch, for example P3-CHANGES adding `label` to `slugTaken`. Each check's failure message names what changed.

### From review

These findings are non-blocking.

- The new check, scripts/test-api-shapes.js, copies exact lines of source text from lib/documents/publish.js and lib/admin/documents-api.js. P3-COMMIT and P3-CHECKS are required to change those lines, and neither item owns this file. I tested this on a copy. (a) I moved slugClash and failedError from publish.js into a new build.js, as COMMIT's first 'pure move' commit must do. Two checks fail: 'publish.js slugClash extra changed' and 'PUBLISH_FAILED extra changed'. (b) I added access to the getDocument and listDocuments 200 answers, as COMMIT step 7 requires. One check fails: 'listDocuments 200 body changed'. (c) I added liveUrl to the published items, as CHECKS step 5 requires. One check fails: 'published item: shapes have [hash, id, versionId], the code has [hash, id, liveUrl, versionId]'. So pnpm test goes red in batch 1 and again in batch 2 unless those items edit a file they don't own. The packet's advice ('a later item ... must update this check in the same branch') goes against the plan's one-owner-per-batch rule. Two possible fixes before batch 1 is cut. Fix 1: scan every lib/documents/*.js file instead of publish.js alone, and stop pinning the exact text of the dispatcher's 200 lines. Fix 2: name COMMIT and CHECKS as later owners of scripts/test-api-shapes.js in P3-BATCHES.json and in the plan's table of files that pass between batches. Either way, the owner must also add scripts/test-api-shapes.js to P3-SCAFFOLD's files.
- The anchor example does not use the agreed format. PUBLISH_ISSUE.anchor is 'doc_home/sec_hero/title'. P3-VALIDATE's fieldAnchor() makes 'f-<sectionId|doc>-<path with . turned into ->'. For this issue that would be 'f-sec_hero-title'. The where example 'Hero, title' also differs from VALIDATE's 'Banner · Button' form. These examples are meant to be fed to SESSION's mapper and rendered by PUBLISHUI, so they should use the real formats.
- The listRecentlyPublished comments don't match the publish_log table. The table defines publish_log.set_id as TEXT NOT NULL (migrations/tenant/0021_documents.sql), but the shapes comment says 'setId may be null'. The table's action values are publish | unpublish | undo | scheduled | restore | migrated. The comment lists only publish | unpublish | restore | undo, and gives actionWords for just three of them. A 'migrated' row (the UNDO brief mentions these) has no listed words for PUBLISHUI to show.
- The shapes file leaves updatedBy and updatedByName on publish conflicts to P3-CHECKS ('publish conflicts carry them from P3-CHECKS'). The CHECKS brief doesn't ask for this, and the file also applies it to DRAFT_CHANGED, which the scaffold brief doesn't name. CHECKS' rule 'responses match documents-api-shapes.js keys' will make it do work that isn't in its brief. Either add this to the CHECKS brief or mark those keys optional.
- Today's 401 and 403 words ('Unauthorized', "Your role (staff) can't do that") are not checked against lib/admin-auth.js. When I changed the 401 text in admin-auth.js, the suite still passed 25 of 25. The shapes file now says something the code no longer does, and nothing notices.
- The shapes file's header describes each operation as {request, access, outcomes} but leaves out requestOptional and sameOutcomesAs. publishSet has no outcomes key at all. A mapper test that walks SHAPES[op].outcomes would crash on publishSet unless it knows to follow sameOutcomesAs.
- What I confirmed: I re-ran pnpm test on a clean install of the branch, and 81 of 81 suites passed in 125.8 s. Each of the 14 placeholders prints the right 'pending: owned by cms/p3-<id>' line and exits 0. The shapes file has no imports and is edge-safe (data and object spreads only). It changes nothing a shopper or a legacy tenant sees, because nothing imports it yet. My own changes to the source were caught: a changed status (DOCUMENT_LIVE 400, DOCUMENT_ARCHIVED 410), a renamed code (NOTHING_PUBLISHED), and a new code with no outcome. The one exception is the 401/403 words above. I removed the worktree, nothing listens on ports 3700 or 4700-4709, and no files were pushed or committed.

## Owner checks

- **CI sqld download** (standing): the plan said not to touch `.github/`, and this item doesn't. Approving the source and checksum of the sqld binary for CI is still the owner's call.
- **Ruling on the readings in the Design table:** top-level `revision` on the new writes, `ok: true` on every 200, `CANNOT_TAKE_OFFLINE` as the new code, `other.title` kept beside `other.label`, and `access` on every list row. These are cheap to change before batch 1 is cut and costly after.
- **Add `scripts/test-api-shapes.js`** to P3-SCAFFOLD's files in `P3-BATCHES.json`, so the ownership script doesn't flag it.
