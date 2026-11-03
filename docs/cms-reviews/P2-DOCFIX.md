# P2-DOCFIX: review fixes for P2-DOCS and P2-READ

Branch `cms/p2-docfix`, cut from `d36f683`. Plan: `docs/cms-reviews/P2-PLAN.md` (sections 0, 3, 4 and 6). Spec: DOC-01, DOC-02, DOC-08 and PUB-01 (section 7), section 8.6. It fixes the "From review" findings in `docs/cms-reviews/P2-DOCS.md` and `docs/cms-reviews/P2-READ.md`. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:documents`: 38 passed, 0 failed (it was 29), in about 1.2 s. `pnpm test:release-readers`: 33 passed, 0 failed (it was 27), in about 1.6 s. `pnpm test`: 66 of 66 suites passed in 111.4 s. `pnpm build` passed, with only the 2 warnings that were already there |
| Browser verified | **NOT DONE.** Nothing a shopper sees changed, and no store is in documents mode. The founder-facing changes are API answers (a 200 instead of a false 409, a 409 for the cart, a 5xx with a code). There is no editor screen for documents yet (ED-02) where a drill could show them. Every acceptance item is a unit test |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed. No tenant changed mode |

## What changed, and why

### 1. A lost answer on create no longer reports the founder's own page as taken (`lib/documents/service.js`)

**Before:** the batch for a new page committed, but its answer was lost. `lib/db.js` then sent the batch again. On the second try SQLite reported `UNIQUE constraint failed: documents.slug` before the primary-key error. The catch path mapped any slug clash first, so the founder got 409 `SLUG_TAKEN` "Another page already uses /sale: Sale page". That named the page they had just made, and the page really existed.

**Now:** `createDocument` reads the row back first. If the row with this build's id holds this write (the same `created_at` and draft hash), the answer is 200 with that document. A slug clash is mapped only after that check. If the read-back itself fails, a slug clash is still answered 409 `SLUG_TAKEN`, and any other failure is passed on as before. `settle()`, the shared catch path for save, restore and discard, now uses the same order: our own write first, then the slug clash. A resent save cannot actually hit a slug clash, because its guarded UPDATE matches no row, so this part is a safety change. No test bites on it alone.

### 2. The checkpoint prune reads only this document's rows (`lib/documents/versions.js`)

**Before:** `EXPLAIN QUERY PLAN` showed `SCAN p` (publish_log) and `SCAN d` (documents) in all three correlated subqueries. That is about 3 x 21 full table scans on every autosave, and publish_log never shrinks.

**Now:** the log check is `p.document_id = v.document_id AND (from/to/saved = v.id)`, which uses the `publish_log_doc` index. The document check is `d.id = v.document_id AND (published/undone = v.id)`, which uses the primary key. The plan now shows only `SEARCH … USING INDEX` steps. The rules are unchanged: never prune a checkpoint that the log names or that a document row points at, keep at most 20, and newest first.

The change relies on one rule that holds today: a log row, and a document's `published_version_id` or `undone_version_id`, only ever name versions of that same document. `commit.js` writes them per document, and the reader refuses a version of another document (`VERSION_MISMATCH`). See Known limits.

### 3. Tests the review found missing (`scripts/test-documents.js`)

- Saving or restoring into an archived document: there are two tests. One covers the early check. The other is an archive that lands between the read and the batch, at the same revision, so only the batch's `archived_at IS NULL` guard can stop it.
- `teamMemberNames` with two stores: a user who belongs only to the other store is never named.
- Restoring page A from page B's version id gives 404 `NOT_FOUND`.

### 4. `doc_cart` is refused until the owner rules on its capability (`lib/documents/service.js`)

The owner check on `upsells.write` versus `storefront.*` is still open. Until it is decided, `createDocument`, `saveDraft`, `restoreVersion` and `discardDraft` refuse type `cart` with 409 `CART_NOT_AVAILABLE`: "Cart suggestions can't be changed here yet, so nothing was saved. Change them on the Upsells screen for now." The refusal sits in the service, not in `lib/admin/documents-api.js`, because P2-PUBLISH owns that file in this batch. Reads (`getDocument`, `listHistory`) still work. The publish path and the shopper reader are not touched, so a v4 `doc_cart` that is already in a release still renders. None exists for real stores.

### 5. The media usage preview answers a database failure properly (`app/api/admin/media/route.js`)

`PUT /api/admin/media` calls `mediaUsage`, which can now throw, because the document scan fails closed. That call is now wrapped in the route's usual order: `infraResponse(e, {route, doing: "load"})` answers a 5xx with a code and "We couldn't reach your store's data just now, so this couldn't load. Try again in a minute." Anything else gets a 500 `INTERNAL_ERROR` with plain words, and the raw text goes to the log only. Before this change the error escaped the handler, and the console got the framework's generic error. The catch follows the order the failure matrix's route scan checks: the database check first, then a catch-all.

### 6. P2-READ test gaps, tests only (`scripts/test-release-readers.js`)

There are six new tests. `lib/content/*` was not edited, because P2-PREVIEW owns it in this batch. Each test was shown to fail under the mutation the review named. **None of them found a real bug.**

## Acceptance, with evidence

Each mutation (D1 to D13 and R1 to R7) was applied alone to the finished code, the suite was run, and the files were restored. Script: `scratchpad/p2-b4/P2-DOCFIX/mut/run.py`, with mutation lists `docs.py` and `read.py`.

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | A create whose answer is lost and resent answers 200 for the founder's own page, never `SLUG_TAKEN` naming itself | DONE | test-documents "a create of a page with an address whose answer was lost and resent …". It uses the suite's lost-answer pattern: the batch commits, then throws `fetch failed`, and `lib/db.js` really sends it again (the test asserts at least 2 sends). Checks: 200, one row at the address, its words, one "Created" checkpoint. A real clash afterwards is still 409 naming the other page | At `d36f683` (the service from before this item): `409 SLUG_TAKEN "Another page already uses /lost-sale: Sale page"`. Mutation D1 (the slug clash mapped before the read-back) gives the same |
| 2 | `EXPLAIN QUERY PLAN` of the prune shows no SCAN of publish_log or documents; all prune guarantees still pass | DONE | "the checkpoint prune's query plan uses the indexes …" runs on the real migrated tenant database. It asserts no `SCAN` step at all, `publish_log_doc` in all three subqueries, and the documents primary key in all three. The guarantees: the existing cap test (100 saves, at most 20), the undo_saved test, the log-reference test (from, to, saved), and a new test, "pruning still never removes a checkpoint a document row points at (published or undone)", where the 2 pointed-at checkpoints survive 25 saves and the total stays 20 | D2 (back to whole-table subqueries): the plan test. D3 (document pointers ignored): the new pointer test. D4 (log ignored): the existing log test |
| 3 | Save and restore into an archived document are refused with storage unchanged; removing the guards fails the test | DONE | "saving or restoring into an archived document is refused …" (409 `DOCUMENT_ARCHIVED` for both, with a full dump unchanged). "an archive that lands between the read and the batch still refuses the save and the restore …" (the archive is put in at the same revision, between the read and the batch; dump unchanged since then) | D7 (both guards removed): both tests. D6 (only the batch's `archived_at` guard removed): the second test. D5 (only the early check removed) is **not** caught, as expected: the batch guard refuses, and the catch path gives the same 409. The early check is a second line, like the archive-while-live check in P2-DOCS |
| 4 | `teamMemberNames` never returns another tenant's member names | DONE | "teamMemberNames never returns another store's member names …". A user is a member of `zl` only. They are absent from `teamMemberNames("zd")` by id and by name, and present in `zl`'s. A version they made in `zd` lists as "Someone on your team", and their name appears nowhere in the answer | D8 (the `WHERE m.tenant_id = ?` removed) |
| 5 | Restoring page A from page B's version id is refused | DONE | "restoring page A from page B's version id is refused (404) …". `getVersion(A, B's id)` is null, the API answers 404 `NOT_FOUND` "That earlier version no longer exists …", and the dump is unchanged | D9 (`getVersion` skips the document match). The test pins 404, not just "refused", because B's body would otherwise hit `SLUG_TAKEN` |
| 6 | (API) Create or save of `doc_cart` answers 409 with a plain message until the owner ruling | DONE | "API: create or save of doc_cart answers 409 …". Create, save and restore (onto a `doc_cart` row put in directly) each give 409 `CART_NOT_AVAILABLE` with the exact words; the dump is unchanged; `getDocument` is still 200 | D10 (create), D11 (save), D12 (restore). At `d36f683`, create answered 200 |
| 7 | A failing document scan in the media usage preview answers a 5xx with a code, not a generic error | DONE | "PUT /api/admin/media (usage preview): a failing document scan …" calls the real route handler. A working scan gives 200 with `usage: []`. With the document scan failing (`SQLITE_IOERR`): 503 `DATABASE_UNAVAILABLE`, the exact plain words, no raw database text, and no `usage` list. This is the "failure-matrix row". It sits in `test-documents`, because P2-PUBLISH owns `test-failure-matrix.js` in this batch | D13 (the route from before this item): the `LibsqlError` escapes the handler |
| 8 | The six P2-READ gaps are pinned by named tests, each shown to fail under the matching mutation | DONE | See the table below | R1 to R7 |
| 9 | `pnpm test` passes | DONE | 66 of 66 suites passed in 111.4 s. `pnpm build` passed | |

### P2-READ gaps (`scripts/test-release-readers.js`)

| Gap from the review | Test | Mutation that fails it |
|---|---|---|
| A custom menu with zero items renders an empty menu, not the catalog menu | "a custom menu with zero items renders an empty menu on v4 …" (header and footer `[]`; `auto` is still `null`) | R1: `navFromBody` turns a custom `[]` into `null` |
| Hidden page sections never render on v4 | "hidden page sections and hidden PDP accordion sections never render on v4" (a hidden text and a hidden FAQ on a page; none of their words appear) | R2: `pageSectionsFromBody` without `shown()` |
| Hidden PDP accordion sections never render on v4 | the same test (hidden rich text, text and FAQ in `doc_product_layout`; only the shown accordion comes back) | R3: `pdpExtrasFromBody` without the `shown()` skip |
| `cms_state.mode` `'bogus'` fails closed | "cms_state.mode 'bogus' with no release fails closed (UNKNOWN_CMS_MODE) …" (a draft hero is saved; `contentSource` and all 24 getter calls throw `ContentUnavailableError`) | R4: an unknown mode serves legacy drafts |
| A listed page whose `documents` entry is null throws `MISSING_PAGE_VERSION` | "a listed page whose documents entry is null throws MISSING_PAGE_VERSION …" (it names the document and the slug) | R5: serve the code default page instead |
| On v4 a journal post beats a redirect at the same slug | "on v4 a journal post beats a redirect at the same slug" (the post renders, its slug's redirect is `null`, and a redirect with no post still applies) | R6: the journal check removed from `resolvedSlugRedirect` |
| The `schema_version` column check | "a version row whose schema_version column is newer than this code is an error …" (the body says `schema: 1`, the column says `SCHEMA_VERSION + 1`; the test re-reads the stored row to prove both) | R7: `|| row.schema_version > SCHEMA_VERSION` removed |

### Requirements

| Requirement | What this item adds | Left, and for which item |
|---|---|---|
| DOC-01 | A version is restored only into its own document (pinned) | Backfill twice gives the same ids (MIG-01) |
| DOC-02 | A lost answer on create is a success, never a false 409. Archived documents refuse writes, through both guards (pinned) | "The text stays in the editor" (ED-02) |
| DOC-08 | The prune is bounded per document, and every rule about what it keeps is pinned, document pointers included. History names stay inside the store | Pruning against pending schedules (PUB-07) |
| PUB-01 | Six more reader rules are pinned: empty custom menus, hidden sections, unknown mode, a null page entry, post over redirect, and the schema column | Unchanged from P2-READ |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:documents` | 38 passed, 0 failed (9 new) | about 1.2 s |
| `pnpm test:release-readers` | 33 passed, 0 failed (6 new) | about 1.6 s |
| `pnpm test` | 66 of 66 suites passed | 111.4 s |
| `pnpm build` | passed; the 2 warnings that were already there | |

The tests in `test-release-readers` add one tenant (`bg`) to the suite's cleanup list. The schema test publishes a readable announcement afterwards, so the tests after it start from a valid list.

## Known limits

- **The prune trusts that a log row or a document row only names its own document's versions.** If some future writer pointed `publish_log` or `documents.published_version_id` at another document's checkpoint, that checkpoint would no longer be protected from pruning. Today nothing does this: `commit.js` writes the log per document, the reader refuses a version of another document, and published versions are not checkpoints anyway (the trigger keeps them). P2-PUBLISH should keep the rule.
- **The early archived check is not caught on its own** (D5). The batch's `archived_at` guard gives the same 409. This is the same kind of second line as the archive-while-live check in P2-DOCS.
- **The new read-back order in `settle()` has no test of its own.** A resent save, restore or discard can't produce a slug clash, because the guarded UPDATE matches no row on the second try. The change matters only if that ever changes.
- **`doc_cart` writes are refused, and so is a backfilled `doc_cart`**, until the owner ruling. The cart suggestions stay on the Upsells screen. When the ruling is made, remove `refuseCart` and give `doc_cart` the ruled capability in `lib/admin/documents-api.js`.
- **The media usage preview's catch-all** (an error that is not a database error) answers 500 `INTERNAL_ERROR` with its own words. Today `mediaUsage` only throws database errors there.
- **Not done from the P2-READ review:** a v3 release whose `home_sections` is `[]` falling back to `DEFAULT_HOME_SECTIONS` is still not pinned. It was outside this brief's six gaps, and the review thought it unreachable (publish refuses an empty home). The other P2-DOCS review items (`listDocuments` ignoring `includeArchived`, `restoreVersion` skipping `upgradeBody`, and the batch-only archive-while-live guard) were not in this brief and are not covered.
- No browser drill: there is no screen yet.

### From review

Non-blocking findings from the independent review, added at merge.

- Media usage preview test does not prove the existing failure helper is used. With the line `if (infra) return NextResponse.json(infra.body, ...)` removed from the PUT in app/api/admin/media/route.js, a failing document scan answers 500 INTERNAL_ERROR, and scripts/test-documents.js still passes 38/38. The test accepts either `DATABASE_*` or `INTERNAL_ERROR`. The brief asked for an infra 5xx through infraResponse, and the packet claims 503 DATABASE_UNAVAILABLE. That does happen (the suite logs api_infra_failure 503 DATABASE_UNAVAILABLE), but nothing pins it. Tighten the assertion to 503 DATABASE_UNAVAILABLE.
- The settle() reorder in lib/documents/service.js (check our own write first, then the slug clash) has no test. Putting `if (which === "slug" && slug) throw await slugTaken(slug)` back before the read-back leaves test-documents at 38/38, and so does swapping the unread and slug lines. In practice this changes nothing: the save, restore and discard UPDATEs carry a revision guard, so a resent batch never hits the slug index. It is untested code all the same, and the packet should say so or add a lost-answer save that changes the slug.
- The narrower prune (lib/documents/versions.js KEPT) is safe only if every publish_log row and every documents.published_version_id / undone_version_id names a version of its own document. commit.js buildProblems does not enforce that: a log row's document_id and a document's published_version_id are not checked against versions[].document_id. Today's only writers keep the rule, and restoring page A from page B's version id is now refused. But if P2-PUBLISH, or a later migrate step, ever writes a cross-document reference, a referenced checkpoint could be pruned. The new test pins this narrower behaviour ('nor one another document's log row would name only'). Add a buildProblems check, or a note for P2-PUBLISH.
- In createDocument and settle, when the read-back fails and the error was a slug clash, the code still calls slugTaken(). slugTaken does its own read. If the read-back failed but our own row did land, that can still name the founder's own page. This is narrow and was the same before the change. Worth one line in Known limits.
- Merge note, confirmed: refuseCart in the service sits in createDocument, saveDraft and replaceDraft (restore and discard). Discard of doc_cart is covered only through replaceDraft. Removing refuseCart from replaceDraft fails the cart test through restore, so discard is not pinned on its own. If P2-PUBLISH or a later migrate creates doc_cart through createDocument, it will get 409.
- Verified, no issue: I reproduced every acceptance item. My own mutations: M1 and M12 (read-back order and read-back return) caught by the lost-answer test. M5 and M6 (dropping the d.id or p.document_id filters) caught by the query-plan test. M7 to M10 (dropping from, saved, published or undone from KEPT) caught by the prune guarantee tests. M4 and M13 (cart refusal removed from replaceDraft or saveDraft) caught. Reader mutations on an empty custom menu, hidden sections, mode 'bogus' falling to draft, a missing page entry returning null, a redirect beating a journal post, and the schema_version column ignored each failed exactly the matching new P2-READ test. The full suite passed 66 of 66 in 123.2 s, run after a frozen offline pnpm install in the review worktree. No lib/content, .github, migrations or test-failure-matrix edits. No node: APIs added. The review worktree is removed, and none of the processes still running on this machine came from this review: the sqld and next dev on ports 4340 to 4342 and 3340 belong to the P2-PREVIEW worktree.

## Owner checks

1. **The `doc_cart` capability ruling** (still open, plan section 3): `upsells.write` or `storefront.*`. Until then, document writes to the cart are refused with 409 `CART_NOT_AVAILABLE`.
2. **CI sqld install** (carried from P2-ATOM, still open): nothing under `.github/` was touched. Approve the libsql-server release and its SHA-256, then add the step from `docs/cms-reviews/P2-ATOM.md` owner check 1.
3. **Hosted Turso** on a staging tenant in documents mode: create a page while the network drops the answer (it must answer 200, never "Another page already uses …"), and look at the rows read per autosave on a store with many publishes (the prune must stay flat as publish_log grows).

## Files

- `lib/documents/service.js`, `lib/documents/versions.js`
- `app/api/admin/media/route.js`
- `scripts/test-documents.js`, `scripts/test-release-readers.js`
- `docs/cms-reviews/P2-DOCFIX.md`

`lib/platform/identity.js` did not need a change: its tenant filter was correct and only lacked a test.

## Commands

```
pnpm test:documents
pnpm test:release-readers
pnpm test
pnpm build
```
