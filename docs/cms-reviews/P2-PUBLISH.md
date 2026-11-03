# P2-PUBLISH: publishing one document, or a set, on the proven commit

Branch `cms/p2-publish`, cut from `d36f683`. Plan: `docs/cms-reviews/P2-PLAN.md` (decisions 1, 2, 9, 10, 11 and 13; batch 4; sections 3, 4 and 6). Spec: PUB-01, PUB-02, DOC-05, DOC-07, DOC-08, and in part PUB-03, PUB-05 and DOC-10 (section 7), section 8.6 steps 2 to 7. Builds on P2-ATOM and P2-HARDEN (`commitPublishBatch`), P2-REG (the registry), P2-DOCS (the write service and API) and P2-READ (the v4 reader). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:publish-service` 21 passed, 0 failed, in about 1.2 s (the sqld part about 0.6 s). `pnpm test:failure-matrix` 122 passed (10 new publish rows), 23.7 s. `pnpm test`: 66 of 66 suites passed in 118.2 s. `pnpm build` passed, with only the 2 warnings that were already there |
| Browser verified | **NOT DONE.** There is no Publish button yet (the panel is PUB-09, the editor ED-02), so a founder can't reach this from a screen. The policy-typo browser drill is P2-DRILLS' (batch 6). Every acceptance item below is a unit test |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No tenant changed mode: on every real store the API answers 409 `STORE_USES_LEGACY` to `publish` and `publishSet` |

## What and why

P2-ATOM proved that one batch can write a publish all together or not at all. P2-DOCS made drafts, P2-READ made shoppers read version 4 lists. Nothing yet turned a founder's draft into a live version. This item does that, for one document or a set, so that a typo fix on a policy page goes live alone while a half-finished home page stays a draft (US-09, PUB-02).

The panel (PUB-09), Undo (PUB-04), "take offline", schedules (PUB-07), product and collection content (OVL-02) and reference checks across documents are left out on purpose.

## Design

### `lib/documents/publish.js` (Node console routes only)

`publish({ ids: [{ id, revision, draftHash }], actor })` returns `{ release: {id} | null, setId, published: [{ id, versionId, hash }], skipped: [id], issues }` (issues are the warnings that rode along). Steps, following spec 8.6:

1. **The set.** 1 to 200 documents (`PUBLISH_SET_CAP`; 201 is 400 `SET_TOO_LARGE`), no id twice, each with a whole-number revision (else 428 `REVISION_REQUIRED`) and the draft hash the founder reviewed (else 428 `REVIEW_REQUIRED`). The store must be in documents mode (`getCmsMode()`), else 409 `STORE_USES_LEGACY`. The service checks this itself, not only the API.
2. **Each document, at what the founder saw.** One `SELECT … WHERE id IN (…)`. Gone is 404. `product_content` is a plain 409 `PUBLISH_NOT_AVAILABLE` (until OVL-02); the journal index (a system type) is 409 `NOT_PUBLISHABLE`. Archived, another revision, or another draft hash is 409 (`DOCUMENT_ARCHIVED`, `DOCUMENT_CHANGED`, `DRAFT_CHANGED`) with the current document. In a set, every refusing document is listed in `conflicts: [{id, code, error, current}]`; a single one also carries `current` at the top, as `saveDraft` does.
3. **The live pointer L and its list M,** in one LEFT JOIN. A live version 1 to 3 release is 409 `STORE_USES_RELEASES` "This store still publishes with Releases, so nothing was published here. …". No release yet: `M = emptyList(m, singletonTypes())`, where `m` is the highest `sinceManifest` of any registered singleton, so every other singleton stays an explicit null (code default) after the first publish (plan decision 11). A pointer whose content is not a readable list is a 500.
4. **Validate and re-sanitize** each body with `validateDocument(body, {mode: "publish", live, documentId})`. `live` is the live version's body (one `id IN` read for the whole set), used by the design colour checks and by the inherited rule. The body that is published is the validator's output, so HTML is sanitized again on the way out (DOC-05), whatever is in the draft row.
   - **Minimal inherited rule (PUB-03, partial).** An error in a section that is hidden, or whose id-stripped content equals the live version's section of the same id, becomes a warning, with a plain note ("It was already live like this, so it doesn't stop publishing." or "This section is hidden, …"). Structure and sanitizing never become warnings (`STRUCTURE_CODES`: unknown kind or field, bad shape or ids, composition guards, `WORDS_LOST` and the other sanitizer refusals, `HOME_EMPTY`, `PUBLISH_NOT_AVAILABLE`). Matching is by id on purpose: a copy of a live section with a new id is new content, and blocks.
   - Any remaining error refuses the whole set with 422 `VALIDATION_FAILED`, the full issue list, and `documents: [{id, label}]`; the message names each document ("There's 1 thing to fix in “Set B”, so nothing was published."). An empty home gives `HOME_EMPTY` with P2-REG's exact words.
5. **Skip** a document whose id-stripped hash equals its `published_hash` while its live entry is still its `published_version_id`. If everything is skipped, nothing is written and `release` is null.
6. **Slugs** (DOC-10, partial). The pages a publish would leave live (`M.pages` of documents outside the set, plus the journal index entries of posts outside the set) and the set's own slugs must not share a slug. A clash is 409 `SLUG_TAKEN`: "Another live page already uses /about: About us. Change the address of “About (new)”, then publish again.", with `other: {id, title}`. The journal index body is read only when the set holds a page, campaign or post.
7. **The build.** Every attempt mints fresh ids: release, set, one published version per document (`versionRow`, kind `published`), one log row per document. It never reuses a checkpoint's or any other version's id, and never writes a release row ahead of its flip (plan section 6). A restore followed by a publish therefore writes a new published row. `M2 = setEntries(M, changes)`:
   - each document's entry is `{version, hash: body_hash}`;
   - pages and campaigns get a `list.pages` row; posts never do;
   - `meta.redirect_from` becomes `list.redirects` rows to the new slug;
   - when a post is in the set, a new `indexes.journal` version is built in the **same** build (see below).
   `documents[].published_hash` is the id-stripped hash (the same rule as `draft_hash`), so `publicDocument().unpublishedChanges` reads right after a publish.
8. **The commit**, `commitPublishBatch(build)`, inside a `try`. A throw is `{failed}`, never `{lost}`. The outcomes:

| Outcome | Answer |
|---|---|
| `ok` | 200 with the release, the published versions and the warnings. The API audits it (`storefront.publish`, resource `release:<id>`) |
| `lost` | Re-read the set's documents. Gone: 404 `DOCUMENT_DELETED`. Archived or another revision: 409 with the current document. A document whose entry in the new list M' differs from its entry in M: 409 `PUBLISHED_ELSEWHERE` ("Someone else published this page at the same moment, …") with the current document. Otherwise rebuild from M' with new ids. The third loss is 503 `PUBLISH_BUSY`: "Publishing is busy, try again in a moment: nothing was published. Your live store hasn't changed." |
| `unknown` | 503 `PUBLISH_UNKNOWN` "Your publish may have gone live. Reload to check." No rebuild, never a 409 |
| `failed`, `MISSING_DOCUMENT` | 404 `DOCUMENT_DELETED` "This page was deleted while you were publishing. Reload to see the current pages." |
| `failed`, any other code, or a throw | 500 `PUBLISH_FAILED` "Something went wrong on our side, so nothing was published. Your live store hasn't changed. Try again, and contact support if it keeps happening." (`reason` carries the commit's code; logged and sent to `captureError`). Never 409 |

`MAX_ATTEMPTS` is 3: the first build plus two rebuilds, so "after 3 losses, 503" holds literally.

**The interleave hook.** `setPublishHooks({ beforeCommit, commit })` is a test-only seam: `beforeCommit({attempt, build})` runs after a build and before its batch (to land another publish or an autosave there), and `commit(build)` replaces `commitPublishBatch` (a spy, or a forced outcome). Nothing in the app sets it, and it reads no env var.

### `lib/documents/journal-index.js` (pure, edge-safe)

Builds the journal index body from published post versions: `{schema, type: "journal_index", meta: {}, settings: {entries}}`, the registry's own shape (it validates as a `journal_index` document). Each entry is `{document, version, slug, title, description, enabled, family: "journal", effective_at, window_start, window_end}`, taken from the post's published body, so `/journal`, the sitemap and `campaignVisible()` need no post body (P2-READ's `resolvedJournalEntries`). Entries are sorted by slug. `nextJournalIndexBody(prev, changes)` replaces only the entries of the posts being published and keeps the rest. P2-ATOM's older top-level `entries` shape is still read by `journalEntriesOf` (and by the reader).

The index versions belong to `doc_journal_index`. No `documents` row is created for it (the reader checks the body's type, not a row); see Known limits.

### `lib/admin/documents-api.js` and `app/api/admin/documents/route.js`

Two new operations, both `storefront.publish` (owners and admins; staff don't have it):

| Operation | Body |
|---|---|
| `publish` | `{ publish: { id, draftHash }, revision }` |
| `publishSet` | `{ publishSet: [{ id, revision, draftHash }, …] }` (a top-level `revision` is 400) |

Order: parse (400) → authorize `storefront.publish` (401/403) → mode (409 `STORE_USES_LEGACY`, "nothing was published here") → 428 for a missing revision or draft hash → the service. Infrastructure failures say "nothing was published" (the `failure()` wording for publish). The route file only gained comment lines.

### `scripts/test-documents.js` (one line)

P2-DOCS pinned `{publish: "doc_home"}` as an unknown operation. It is now a known one with a malformed argument, so the case expects `MALFORMED` (still a 400) and `{unpublish: …}` takes over as the unknown operation.

## Acceptance, with evidence

All in `scripts/test-publish-service.js` unless named. At `d36f683` that file is P2-ATOM's placeholder and `lib/documents/publish.js` does not exist, so every case fails there (on import), and the API answers `publish` with 400 `UNKNOWN_OPERATION`. "Mutation" names the one change, applied alone to the finished code, that made the case fail (runner: my scratch folder, `mut/run.py`; results below).

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | The first publish on a never-published documents tenant, of one policy page only, goes live; every other getter returns its code default and nothing errors | DONE | "the first publish on a never-published documents store …": through the API; every singleton is an explicit null in the list; 16 getters equal P2-READ's code-default table (store name included); the page is listed and served; `published_hash` equals `draft_hash`. Also on sqld | P8 (first list without singleton nulls: 4 tests fail) |
| 2 | Publishing a policy-page typo while doc_home has a dirty draft with an incomplete enabled section leaves doc_home's live entry and getter output unchanged, and succeeds | DONE | "publishing a policy-page typo while doc_home has a dirty draft …": `resolvedHero`, `resolvedHomeSections` and `resolvedHomePage` byte-equal before and after; doc_home's list entry equal; the home draft keeps its revision and stays unpublished; publishing the home itself is 422 on the banner | P17 (every build from an empty list), P8 |
| 3 | (interleave hook) Two concurrent publishes of different documents both succeed and both are live | DONE | "two concurrent publishes of different documents …": B is published inside A's `beforeCommit`; A loses once and rebuilds (attempt 2); both entries and page rows live; one log row for A. Also on sqld with real concurrency: both batches held at the proxy from one pointer, released together, one rebuilds (at least 3 batch requests), both live | P17 |
| 4 | (interleave hook) Two concurrent publishes of the same document give one success and one 409; the loser's content is not live | DONE | "two concurrent publishes of the same document …": the loser gets 409 `PUBLISHED_ELSEWHERE` with the current document; the winner's version is live; the loser's version and release rows were never written | P1 (no "published elsewhere" check: the loser rebuilds and succeeds) |
| 5 | A saveDraft landing between the publish read and the batch makes the publish return 409 with nothing written | DONE | "a saveDraft landing between …": real `saveDraft` inside `beforeCommit`; 409 `DOCUMENT_CHANGED` with the current revision; exactly one commit; releases, pointer, log, published versions and `documents.published_*` byte-equal | P18 (revision not compared after a loss) |
| 6 | (sqld, proxy commit_then_drop) A lost response then retry reports success with no duplicate rows | DONE | "sqld (proxy commit_then_drop): …": a real sqld 0.24.32 behind P2-ATOM's proxy, through HEAD's `lib/db.js`; `committedThenDropped` 1, 2 batch requests; exactly one new release, log and published version row; pointer and `published_version_id` are this publish's | Base (no publish). The idempotence itself is P2-ATOM's, tested there |
| 7 | When commitPublishBatch returns {unknown}, the API returns 503 with the reload message and the service makes no rebuild attempt (spy) | DONE | "when commitPublishBatch returns {unknown} …": spy called once; 503 `PUBLISH_UNKNOWN`, exact words, no issue list; storage unchanged | P2 (unknown treated as lost) |
| 8 | A stale revision or changed draftHash gives 409 per document, with nothing changed; a set with one invalid document gives 422 naming it, and none of the set goes live | DONE | "a stale revision or changed draftHash …": single stale (409 `DOCUMENT_CHANGED`), changed hash (409 `DRAFT_CHANGED`), a set of three with two refusing: `conflicts` lists exactly those two with their codes and current revisions; then a set with one incomplete document: 422, `documents` names only it, the message names “Set B”, the issue carries its document and section; full dump unchanged after each, none of the three in the list | P11 (draft hash not compared) |
| 9 | A raw `<script>` written directly into a draft row never appears in the published version | DONE | "a raw <script> written directly into a draft row …": the row is updated by SQL past `saveDraft` (inline script and a `src` script); the published version holds `<p>Hello</p>` and no `<script` | P7 (publishes the stored draft, not the re-sanitized body) |
| 10 | An incomplete enabled new section blocks its own document's publish; a section unchanged from live only warns | DONE | "an incomplete enabled new section blocks …": a live version with an empty banner written through the commit (as a migrated document could be); a title typo publishes with the banner's problems as warnings; a new empty banner is 422 on its own section while the old one still warns; hidden, it warns and publishes; an unknown field in a section unchanged from live still blocks | P5 (no inherited rule), P6 (inherited by content of any live section), P19 (hidden sections block), P20 (structure downgraded too) |
| 11 | Publishing doc_home with zero enabled sections returns the exact 'Your home page is empty…' message | DONE | "publishing doc_home with zero enabled sections …": all sections hidden, and `sections: []`; one `HOME_EMPTY` error with the exact words; storage unchanged. Also a failure-matrix row | Base. The rule is P2-REG's; this proves publish runs it |
| 12 | Publishing a page whose slug equals another live page's slug is refused with a message naming that page | DONE | "publishing a page whose slug equals another live page's slug …": live About at /about, its draft moved to /about-us, a new draft at /about: 409 `SLUG_TAKEN`, exact message naming “About us”, `other`; storage unchanged. Publishing both in one set then succeeds (/about to the new page, /about-us to About) | P4 (no slug check) |
| 13 | restoreVersion and then publish puts the restored body live, with a new published version row | DONE | "restoreVersion and then publish …": v1 published, v2 published, restore v1 into the draft, publish: a third published row with a new id (never v1's), live, and shoppers see "Version one." | P8 (indirectly). The fresh-id rule has no mutation that keeps the rest working; see "One mutation survived" |
| 14 | Publishing a journal post writes a new indexes.journal version in the same batch; list.pages never holds posts | DONE | "publishing a journal post …": the index version belongs to `doc_journal_index`, kind published, same `created_at` as the post's version (same build) and the post's log row names this release; the body validates as a registry `journal_index`; entries carry every visibility field; a second, scheduled post is kept beside the first with its window and is hidden from `resolvedJournalEntries`; a page publish leaves the index alone; no post in `list.pages` | P9 (no index version), P10 (posts listed in list.pages) |
| 15 | (API) Staff without storefront.publish get 403 with storage unchanged; a legacy-mode tenant gets 409; product_content gives a plain refusal | DONE | "API: staff without storefront.publish get 403 …": `publish` and `publishSet` 403 for staff, 401 signed out, dump unchanged; legacy store 409 `STORE_USES_LEGACY` ("nothing was published"), and the service refuses on its own too; `product_content` 409 `PUBLISH_NOT_AVAILABLE`, no issue list; 428 for no revision or no draft hash (staff still hear 403 first). Plus "a documents-mode store whose live release is still version 1 to 3 …" (409 `STORE_USES_RELEASES`) | P12 (capability `storefront.write`), P14 (product content left to validation), P13 |
| 16 | (failure matrix) A forced publish batch failure gives 5xx with a founder-readable message | DONE | `test-failure-matrix`: "the database refuses the publish batch" (only the batch carrying the flip is broken, with a NOT NULL refusal) → 500 `PUBLISH_FAILED`; "the database stays locked through every publish attempt" (`SQLITE_BUSY` each time) → 503 `PUBLISH_BUSY`, words checked. Both pass the matrix's own check (5xx, a code, "nothing was published. Your live store hasn't changed", no issue list), and the full storage dump is unchanged. Plus rows for: database down (503), stale (409), empty home (422), product content (409), legacy store (409), staff (403), no draft hash (428), and a final real publish (200, live) | Base (400 `UNKNOWN_OPERATION` for every row) |

Also proven: a busy storm ends in 503 after exactly 3 commits (P15); `failed` codes `DB_REFUSED`, `VERSION_ID_CLASH`, `BAD_BUILD` and a throw from the commit are each one attempt and a 500, never 409, never "someone else" (P3, P16); `MISSING_DOCUMENT` is the exact "deleted" message (P21); publishing what is already live is skipped with no new release; 201 documents is 400; `journal-index.js` imports only the registry and nothing Node.

**Mutation results** (each alone, then `node scripts/test-publish-service.js`; every other test passed):

| Mutation | Failed tests |
|---|---|
| P1 a loss never checks "published elsewhere" | same document twice |
| P2 `unknown` treated as lost | the unknown spy |
| P3 `failed` answered as 409 | the forced outcomes |
| P4 no slug check | the slug case |
| P5 no inherited rule | the inherited case |
| P6 inherited by content of any live section | the inherited case |
| P7 publish the stored draft, not the validator's body | the script case |
| P8 the first list without singleton nulls | 4 tests |
| P9 no journal index version | the journal case |
| P10 posts in `list.pages` | the journal case |
| P11 draft hash not compared | the 409/422 case |
| P12 API asks `storefront.write` | the API case |
| P13 v1 to v3 pointer not refused | the Releases case |
| P14 product content left to validation | the API case |
| P15 no attempt limit | the forced outcomes |
| P16 a throw read as lost | the forced outcomes |
| P17 every build from an empty list | 5 tests (one on sqld) |
| P18 revision not compared after a loss | the autosave case |
| P19 hidden sections block | the inherited case |
| P20 structure codes downgraded too | the inherited case |
| P21 `MISSING_DOCUMENT` as a 5xx | the forced outcomes |
| P22 the skip ignores the live entry | **survived** |

**One mutation survived.** P22 lets "skip" trust `published_hash` alone. It only differs when a document's `published_*` fields and its live list entry disagree, which nothing in phase 2 can produce (Undo and "take offline" don't exist yet). The live-entry term is defence for PUB-04; a test belongs with Undo.

### Requirements

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| PUB-01 | The first writer of real v4 rows: entries, page rows, redirects, the journal index, explicit singleton nulls on a first publish; shoppers read them through P2-READ | — |
| PUB-02 (service level) | One document goes live alone; concurrent publishes of different documents both land; same document one 409; an autosave makes it lose with 409; a lost answer after commit reports success with single rows (sqld); staff 403; stale revision or hash 409 per document | The Publish button and panel (PUB-09, ED-02); the browser drill (P2-DRILLS); hosted Turso (owner check) |
| DOC-05 | Publish re-validates and re-sanitizes every body; an incomplete enabled new section blocks only its own document | "Cannot be published through schedule" (PUB-07) |
| DOC-07 | The empty-home refusal at publish, exact words | Hero rendering (P2-SECTIONS) |
| DOC-08 | Restore, then publish: a new published version row goes live | The list in the editor (ED-02) |
| **PUB-03 (partial)** | The minimal inherited rule (hidden, or unchanged from the live section of the same id, warns; structure and sanitizing always block); a problem in another document never blocks this one | Reference checks against the live list plus the set (links to pages, rail collections, media existence); "Hide this section and publish" and "Remove it" offers; per-token contrast for the design document beyond P2-REG's rule |
| **PUB-05 (partial)** | `publishSet`, all or none, capped at 200, one invalid document stops the set and is named | "Publish both" for a link to an unpublished page; product and collection content in a set (OVL); whole-set Undo (PUB-04); "publish all" splitting above the cap |
| **DOC-10 (partial)** | Slug uniqueness across the resulting list plus the journal index, naming the other page; `redirect_from` publishes with the new slug in the same release; two pages can trade slugs in one set (after the three draft saves `documents_slug` needs) | Undo restoring the old URL (PUB-04); a one-step swap of draft slugs (plan decision 10) |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish-service` (replaces the P2-ATOM placeholder; `package.json` unchanged) | 21 passed, 0 failed (18 on `file:`, 3 on sqld) | about 1.2 s; sqld part about 0.6 s |
| `pnpm test:failure-matrix` | 122 passed, 0 failed (10 new rows) | 23.7 s |
| `pnpm test:documents` | 29 passed (one expectation changed, see Design) | 0.8 s |
| `pnpm test` | 66 of 66 suites passed | 118.2 s |
| `pnpm build` | passed; the 2 warnings that were already there | |

The sqld cases pick their ports from `TEST_PUBLISH_SERVICE_PORTS="<sqld>,<proxy>"`, or free ports when it is unset (as `test:publish`). My runs used 4300 and 4301 (mutations 4302 and 4303). Every sqld and proxy the suite starts is stopped in a `finally`; none was left running. The suite prints `[ALERT:critical]` lines for the forced `failed` outcomes: that is `captureError` doing its job in a test.

## Known limits

- **Autosave can starve publish (ED-03).** An autosave between the publish's read and its batch makes the publish lose (409 `DOCUMENT_CHANGED`), by design. An editor that keeps autosaving while a publish runs can make every publish lose. The editor (ED-02) must hold autosaves until a publish answers (spec 8.6 step 1).
- **A loss that is not a race is retried, then reported as busy.** `commitPublishBatch` reports `{lost}` for a guard miss, a busy lock, and a transport failure before the commit, and also for a database error it can't classify (for example a corrupt database). The service rebuilds up to 3 times and then says "Publishing is busy". Nothing is written either way. A `{lost}` after a transport error is not proof that the batch never commits (P2-ATOM's limit): the rebuild can then republish on top, leaving duplicate version and log rows, never lost data.
- **The mode check is a pre-check** (as P2-GUARD's and P2-DOCS'). A cutover landing between it and the batch is not caught (MIG-03).
- **No reference checks across documents** (PUB-03, PUB-05): a page link to an unpublished page publishes, and renders by the reader's rules.
- **`undone_version_id` is not checked** ("publish again" after Undo needs a confirmation, spec 8.6 step 4). Nothing sets it yet; PUB-04 must add the check.
- **The journal index has no `documents` row.** Its versions belong to `doc_journal_index` and are listed as `indexes.journal`; `documents.published_*` is not kept for it. The reader checks the body's type only. If a later item wants it listed in `listDocuments`, it must create the row.
- **A post's `redirect_from` publishes as a redirect too**, and the reader lets a post at the same slug win over it (P2-READ). Journal redirects were already `page_redirects` rows on legacy.
- **The manifest number of an existing list is kept.** A list made before a new singleton ships keeps its `m`; that singleton then reads as its code default until a list at the new `m` is written (spec PUB-01's rule). Nothing bumps `m` yet.
- **`MAX_ATTEMPTS` is 3** (the first build and two rebuilds), the literal reading of "after 3 losses". The brief can also be read as three rebuilds; changing it is one constant.
- **`MISSING_DOCUMENT` answers 404** with the brief's words. No path deletes a document today (archive only, and a live page can't be archived), so it is reachable only through a direct database change.
- The hidden-section downgrade is a small step beyond the brief's minimal rule; it follows PUB-03 ("only enabled sections block") and is tested.

### From review

Non-blocking findings from the independent review, added at merge.

- Reproduced: test:publish-service 21/21 passed (my ports 4400/4401). Full `pnpm test`: 66 of 66 suites passed in 114.3 s. `pnpm build` passed, with the same 2 warnings as before. The diff does not touch .github/, migrations or package.json. publish.js and documents-api.js are imported only by the nodejs-runtime route app/api/admin/documents/route.js. journal-index.js imports only the registry and has no node:, process or Buffer use. Legacy suites (test-releases and the rest) still pass. The review worktree has been removed, no listener is left on ports 4400-4409, and the branch is still at 75ed4f5.
- PUB-03 and DOC-05 are overclaimed: 'structure and sanitizing always block' is not true. classify() in lib/documents/publish.js decides by code (STRUCTURE_CODES), but the validator also emits INVALID_VALUE, LINK_INVALID, TOO_DEEP and SECTIONS_NOT_ALLOWED with class 'structure', and none of those codes are in the set. I reproduced two cases. (a) A draft row written by SQL with a hidden rich_text section whose title is {evil:1} and whose html is {not:'a string'} publishes with 200. The issues come back as warnings, and the published version holds the raw objects (checkHtml returns non-string values untouched). (b) An enabled section left unchanged from a live fixture with title: 42 publishes with 200 and a warning. Shoppers are not exposed: the reader drops hidden sections, and in (b) the content was already live. But the packet's PUB-03 and DOC-05 'proven' rows say otherwise. Fix: have validateDocument expose each issue's class (cls) and never downgrade class 'structure'. Or narrow the claim in the packet and add a test.
- Packet claim with no test behind it: the DOC-10 row says 'redirect_from publishes with the new slug in the same release'. Mutation R3 (redirectsOf always returns []) survives both test-publish-service and test-failure-matrix. My probe shows the code itself works: resolvedSlugRedirect('old-addr') gives 'new-addr'. Add a test, or move the claim out of 'proven'.
- Reviewer mutations on behaviour that is correct today but untested. All of these survive test-publish-service: R1 (journal index read once outside the retry loop, so a rebuild after a concurrent post publish would drop the other post from /journal and the sitemap; a probe shows both posts survive today); R2 (republishing a post keeps its old index entry, giving a duplicate; a probe shows no duplicate today); R4 (index entry always enabled:true; the journal test only checks a value of true); R5 (archived documents not refused); R6 (slug check ignores journal index entries; a probe shows the page-vs-live-post clash is refused today); R11 (no audit on {ok}, which the brief requires; it also survives test-failure-matrix); R15 (publish_log.from_version_id is always null, which Undo will need); R16 (list.pages drops window_start and window_end, so a scheduled campaign would show early; it also survives the failure matrix); R19 (slug check only on the first attempt); R20 (a document deleted during a loss is skipped instead of answering 404). Killed: R8 (rebuild from the old list), R9 (cap >=200), R17 (index window dropped), R18 (inherited match by content of any section), R21 (unknown answered as 500), R22 (service mode check removed). Suggest adding cases for R1, R2, R4, R11 and R16 at least.
- The packet's limit text is inaccurate. If a batch reported {lost} actually commits after commitPublishBatch's read-back, the rebuild does not 'republish on top, leaving duplicates'. It sees its own earlier entry in M', and the founder gets 409 PUBLISHED_ELSEWHERE 'Someone else published this page at the same moment, so your publish didn't go live' while the content is live. I reproduced this with a commit hook that commits for real and then returns {lost} with the old pointer. Rare: it needs a server commit that lands after the client's read-back. It is not data loss, but the known-limits text should say this, or the lost path could treat an M' entry whose version is one of this service's earlier build ids as ok.
- The plan and brief ask to validate 'against the live list plus the set'. The code passes only the live body (validateDocument has no list input). The packet records 'no reference checks across documents' as a known limit, and PUB-03 is marked partial. That is acceptable, and noted here so the gap stays visible.
- Wording: a malformed `publish` request (for example a top-level revision of '1', or a non-string draftHash) gets the shared parse message '…so nothing was saved…', where it should say 'nothing was published'. publishSet errors raised by the service (MALFORMED, a duplicate id) do say 'published'.
- Owner decisions the builder already lists, and I agree they need sign-off: 3 attempts (the first build plus 2 rebuilds); 404 for MISSING_DOCUMENT; hidden sections never block, which goes slightly past the brief's minimal rule; set cap of 200. Also still open: the CI sqld install owner check (test:publish-service now needs sqld too) and the hosted Turso drills.

## Owner checks

1. **CI sqld install** (still open, unchanged from P2-ATOM owner check 1). `.github/` was not touched. `test:publish-service` now needs sqld too, like `test:publish`; CI fails on both until the pinned, checksum-verified step is approved and added.
2. **Hosted Turso** on a staging tenant in documents mode: one publish; two publishes of different pages at once (both live); two of the same page (one 409); a publish while another connection holds `BEGIN IMMEDIATE` (it ends live or "busy", never half-written); a lost answer after commit (success, single rows); a publish, then load the page right away from another region (replica lag: P2-READ's one re-read).
3. **Wording**: "Publishing is busy, try again in a moment: nothing was published. Your live store hasn't changed.", "Your publish may have gone live. Reload to check.", the slug message, and "Someone else published this page at the same moment, …". Confirm or change.
4. **Decisions to confirm**: the set cap of 200 (spec hypothesis); 3 attempts; 404 for `MISSING_DOCUMENT`; that a hidden section never blocks its document's publish; that `storefront.publish` (owners and admins) is the right capability for both operations.
5. **DR-1, DR-2, DR-3** stand (P2-VGATE, P2-ATOM): no real store is in documents mode, and none must be moved until the cutover gates in plan section 6 are met (P2-SECTIONS' home-page gate, OVL before MIG).

## Files

- `lib/documents/publish.js` (new), `lib/documents/journal-index.js` (new)
- `lib/admin/documents-api.js`, `app/api/admin/documents/route.js` (comment only)
- `scripts/test-publish-service.js` (replaces the placeholder), `scripts/test-failure-matrix.js`, `scripts/test-documents.js` (one expectation)
- `docs/cms-reviews/P2-PUBLISH.md`

## Commands

```
pnpm test:publish-service
TEST_PUBLISH_SERVICE_PORTS=4300,4301 pnpm test:publish-service
pnpm test:failure-matrix
pnpm test
pnpm build
```
