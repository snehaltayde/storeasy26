# P1 · DOC-04 · One structured validation result, and errors that say what kind they are

Branch `cms/p1-doc04`, cut from `bdbe1a7`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:284-294` (DOC-04), the status codes in §8.14 (`:2843`), and §8.15 (test strategy). Phase 1 slice: today's home blocks, home sections, page sections, templates, the live-preview candidate and releases. Documents arrive in phase 2.

This packet was updated in **fix round 1** (the commit after `0b98649`). The section "Fix round 1" below says what the independent review found and what changed. The rest of the packet describes the branch as it now stands.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch, including fix round 1 |
| Locally tested | Yes. `pnpm test`: 45 of 45 suites passed. `test:failure-matrix` 82 passed, 0 failed (60 before fix round 1). `test:page-editor` 61 passed, 0 failed (53 at `bdbe1a7`). Exact counts per suite are under Test results |
| Browser verified | **Partly.** Desktop Chrome (headless, over DevTools) on the design harness: drills D1 to D7 (first round) and D8 and D9 (fix round 1, re-checking both blocking findings), with screenshots. The console runs on Node there. The storefront preview pane does not render on the harness at all (edge runtime and file databases, spec §8.15 "Harness fix"), so nothing about the preview frame was seen |
| Staging verified | **NOT DONE.** Unverified |
| Production enabled | **NOT DONE.** Unverified. Nothing pushed, merged or deployed |

## Fix round 1

An independent reviewer found two blocking problems, seven smaller ones, and left two notes (their own `next build` run, which passed, and their own browser measurements, kept under Known limits). I checked each against the code. All of them were right. Every behaviour problem was reproduced with a test before the fix: the final `test:failure-matrix`, run against an unpacked copy of `0b98649` (the branch before this round), gives **62 passed, 20 failed** (`drills/DOC-04/fix1-matrix-before-0b98649.txt`). On this commit it gives 82 passed, 0 failed. The tests that pass on `0b98649` too are the first round's rows, plus the accordion wording and two snapshot rows; those three guard against mutations rather than bugs.

### Blocking 1: a refusal that quoted the founder's words came back as "We couldn't reach your store's data"

The infrastructure classifier searched every error's text for words like "network", "timeout" and "timed out". In the 20 `/api/admin` routes the database check ran before each route's own answers. So a refusal that quoted a product title, page slug or experiment name containing one of those words became a 503 with a false message. The reviewer's two cases, reproduced on `0b98649`:

| Case | `bdbe1a7` | `0b98649` | Now |
|---|---|---|---|
| Enable a bundle whose sold-out component is "Network Switch 8-port" | 422, `problems: ["component 1 (Network Switch 8-port): sold out"]` | **503 `DATABASE_UNAVAILABLE`** | 422, the same body as `bdbe1a7` |
| Delete an image used on the page "partner-network" | 409 `MEDIA_IN_USE`, `usage: [{where: "page:partner-network"}]` | **503 `DATABASE_UNAVAILABLE`**, so the Media screen never showed the "still used" guard, the only way to force-delete | 409, the same body as `bdbe1a7` |

What changed:
- **The classifier reads only what the database driver or the network made** (`lib/cms/issues.js`, `infraKind`). An error counts only if it is one of these:
  - a driver error: named `LibsqlError`, `LibsqlBatchError` or `SqliteError`, or carrying a `SQLITE_*` code;
  - undici's fetch failure: a `TypeError` whose message is exactly `fetch failed` (how `@libsql/client` over HTTP fails when Turso doesn't answer);
  - an error carrying a socket or DNS code (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_*` and the like).

  Only after that is the driver's *own* message read, for "no such table" and similar. Our own errors are never read, whatever they say. The `cause` chain is still followed, so the release snapshot's wrapper still classifies through its cause. That made the old mutation M28 (dropping `{ cause: e }`) a real gap; it is now caught.
- **Each route's own answers come first.** In bundles (`e.problems`), media (`MEDIA_INVALID`, `MEDIA_IN_USE`), offers and offers/[id] (`OFFER_INVALID`), experiments, catalog, quiz and automations (`e.errors`), billing (`BILLING_UNCONFIGURED`) and insights (`AI_UNCONFIGURED`, `AI_UNAVAILABLE`), the known answer is now checked before `infraResponse`. The bodies are the same as at `bdbe1a7`.
- **The source scan now checks that order.** In every `/api/admin` catch-all, only known-answer lines (`if (e?.x …) return …`) may come before `infraResponse(e…)`, and a catch-all must follow it.

Tests that fail on `0b98649` and pass now:
- `✓ a bundle refusal that quotes a product called "Network Switch 8-port" keeps its 422 and its reasons` (through the real bundles route).
- `✓ deleting an image used on the page "partner-network" keeps its 409 "still used" guard` (through the real media route).
- `✓ our own errors are never infrastructure, whatever words they quote`: 9 messages, including an experiment slug with "timeout", "fetch failed" and "SQLITE_BUSY" as plain text, each with and without a code of ours.
- `✓ driver and network errors are classified by their names and codes`: 14 cases.
- The order scan.

### Blocking 2: after Publish now or Schedule, the warnings banner lost where each warning is

`createRelease` returned `warnings` as bare strings, and the Publishing panel showed them as they were. At `bdbe1a7` they said "Announcement: …" and "Home section 4 (banner): …". On `0b98649` the top banner said `"/odd-route" isn't a storefront route…`, while the card below said `Section 4 (Banner / CTA): "/odd-route" …`.

What changed:
- `createRelease` now also returns `issues` (the warnings, in the issue shape) and `sections` (`lib/releases.js`, `riding`).
- `components/admin/ReleasesAdmin.js` words the result banner with `resultWarningLines` (new in `lib/cms/issues.js`) after both Publish now and Schedule. `issueLines` moved into the same module, so the panel's three lists use one wording.

Test: the real `ReleasesAdmin`, compiled by SWC and run on stand-in hooks, with its fetch reaching the real releases handler (the method `test:page-editor` uses for `PageEditor`).
- `✓ Publish now: the warnings banner says where each warning is, as the card does before publishing`.
- `✓ Schedule: the same warnings, worded the same way`.

On `0b98649` both fail, showing the bare lines. This also closes the reviewer's surviving mutation R9 (the panel showing bare messages).

### The smaller findings

| Finding | Before (`0b98649`) | Now | Test |
|---|---|---|---|
| Publish went live, then the panel's refresh failed | 503 "nothing was published. Your live store hasn't changed", while the live pointer had moved | 200, `code: "RELOAD_NEEDED"`, notice "Published. Your live store has the new version, but this page couldn't refresh, so it may show old details. Reload it." The panel shows the notice in its warnings banner and no error. Same for schedule, undo, cancel and approve (`lib/admin/releases-api.js`, `withView`) | matrix row "published, then the panel's refresh fails" (checks the live pointer moved), and the panel test "Publish now when the panel can't refresh" |
| A save went through, then the editor's refresh failed | 503 "nothing was saved", and the next Save hit a 409 against the founder's own save | 503 `SAVED_RELOAD_FAILED`, `saved: true`, "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes." Covers block, page, reset, page delete and template saves and deletes (`lib/admin/cms-api.js`). The editors' shared client (`components/admin/cms/api.js`) then asks for the view once more; if that works, the editor carries on as after any save, with the new revision, so the next Save doesn't conflict. The editors themselves were not changed | matrix row "saved, then the editor's refresh fails" (checks the hero really is stored); client tests "saved, then the server's refresh failed → it reads the view once more…" and "…the re-read fails too → the answer still says it was saved" |
| Editor load with the page reads failing | 200 with `pages: []` and `pageRevisions: {}` while a page existed. The packet wrongly said this class was fixed | 503 `DATABASE_ERROR`. `listContentPages` and `pageRevisions` take `{ strict }`, and the editors' view uses it. A missing table or column still reads as before. The page editor's own server load (`app/(console)/admin/(authed)/storefront/pages/[slug]/page.js`) is strict too, so a failed read shows the console's error screen with Retry, not a 404 or a built-in default page | four load rows: all page reads failing, only the page list, only the page revisions, and an old store without the page `family` column whose list then fails. The server page has no test (see Known limits) |
| A NOT NULL or CHECK failure on a first save | 409 `CMS_CONFLICT` "edited by someone else", `current: null` | 500 `INTERNAL_ERROR`. Only a UNIQUE or PRIMARY KEY failure is a race | matrix row "a broken rule that isn't a race (NOT NULL)…", and unit cases |
| The AI provider not answering (insights) | 503 "We couldn't reach your store's data…" | 503 `AI_UNAVAILABLE`, "We couldn't reach the AI service just now, so no ideas were made and nothing was stored. Try again in a minute." Named in `lib/ai/insights.js`, where the call is made | "the AI service not answering is named as the AI service" (real insights route, provider fetch stubbed to fail) |
| Two colons in a row | `Hero: Primary button: "/x" …`, `Header menu, item 1: “Shop”: "/x" …` | `Hero: the primary button links to "/x", which isn't a storefront route…` and `Header menu, item 1: “Shop” links to "/x", which isn't…`. Banners and the announcement have no subject and read as before | "each publish warning is filed under its own document and section…, and reads with one colon" |
| `failure()`'s comment said a refusal with `e.expose` keeps its status; only the releases handler did that | | `failure()` itself now does it, so the comment is true | "failure() keeps a deliberate refusal's status and words" |
| Mutation gaps R2, R6, R7, R10 (and R9, above) | survived every suite | caught. R2: the accordion's field path (`items.1.title` → "Product page accordions, accordion 2: …"). R6 and R7: every infrastructure row now checks that its message names the right outcome for what the founder was doing (save, preview, publish, load). R10: the announcement's link issue is filed under `doc_announcement` | see "Mutation check" |
| `next build` not run | | Run on this commit; see Test results | |

Found while fixing, not in the review: `test:releases`' check "links to /journal, /quiz, /bundles, /wishlist, /account no longer warn" had become vacuous on `a33e0a3`. It filtered the bare messages for the word "nav", which they no longer contain, so it could never fail. It now filters on `documentId: "doc_header"` and code, and proves the filter catches a real unknown route.

## Evidence lines, opened before any change

- `lib/cms/validate.js:54-55` (cited at `c47045f`, same at `bdbe1a7`): home-section errors were strings like `` `Section ${i + 1} (banner): link must be a path or URL` ``. There were 8 such templates in that file.
- `lib/cms/store.js:315` (cited at `c47045f`): page sections threw `` `section ${i + 1}: …` `` and stopped at the first problem. AU-05 rewrote the messages, but at `bdbe1a7` it still threw on the first problem with the position built in (`store.js:350-382`).
- `lib/admin/cms-api.js:173`: `return { status: 422, body: { error: String(e?.message || e) } }`. Every error in the storefront API, database errors included, came back as a 422 carrying the raw text.
- `docs/cms-reviews/S59-live-preview.md:52-55`: "a pre-0016 tenant DB surfaced 'no such table: cms_preview_candidates' as a 422". Reproduced, below.

## The bugs, reproduced first (first round)

`scripts/test-failure-matrix.js` drives the real handlers against real tenant databases broken the way production breaks them: unreachable, read-only, never migrated, missing one table, with failing reads, or racing a first save. The first-round suite was run against an unpacked copy of `bdbe1a7` (`git archive bdbe1a7`). Only one shim was needed there: the old releases route body moved verbatim into `lib/admin/releases-api.js` form, with the old catch unchanged. On `bdbe1a7` that suite gave **11 passed, 49 failed** (`drills/DOC-04/baseline-matrix-final-bdbe1a7.txt`), and 60 passed on the first-round branch. The full "before" bodies are in `drills/DOC-04/baseline-matrix-bdbe1a7.txt`, from the first 54-row version of the suite run with `FM_SHOW=1`; there, 43 of 54 failed. The 11 that pass on `bdbe1a7` already behaved: stale revision, no revision, two operations, signed out, support role, no preview open, opening a preview, drafts changed, staff can't publish, and cancel a missing release. The eleventh is the coverage test, which has nothing to compare against there. The fix-round-1 rows were reproduced against `0b98649`, above.

What the founder got before, verbatim from that run:

| Failure | Before (`bdbe1a7`) | Now |
|---|---|---|
| Database doesn't answer, block save | **409** "edited by someone else since you loaded it", `current: null` | 503 `DATABASE_UNAVAILABLE` |
| Reading the current version fails, block save | **409** "edited by someone else since you loaded it" | 503 `DATABASE_ERROR` |
| Database went read-only, any save | 422 "SQLITE_READONLY: attempt to write a readonly database" | 503 `DATABASE_UNAVAILABLE` |
| Database never migrated | 422 "SQLITE_ERROR: no such table: cms_blocks" | 503 `DATABASE_NOT_READY` |
| Preview table missing (S59's case) | 422 "SQLITE_ERROR: no such table: cms_preview_candidates" | 503 `DATABASE_NOT_READY` |
| Database doesn't answer, page save / preview / publish | 422 "fetch failed" | 503 `DATABASE_UNAVAILABLE` |
| Editor load, database down or reads failing | **200 with code defaults** and null revisions, as if nothing was customized | 503 (block reads since the first round; page reads since fix round 1) |
| Publish, reading drafts fails | 422 "SQLITE_ERROR: no such function: nosuch_fn" (via "release snapshot failed reading …") | 503 `DATABASE_ERROR` |
| Publish, catalog lookup behind link checks fails | 422 with the same raw SQLite text | 503 `DATABASE_ERROR` |
| Publish, `releases` table missing | 422 "SQLITE_ERROR: no such table: releases" | 503 `DATABASE_NOT_READY` |
| Publishing page load, database down | unhandled, so Next's HTML 500 page | 503 JSON with a code |
| Two first saves race | 422 "SQLITE_CONSTRAINT: UNIQUE constraint failed: cms_blocks.key" | 409 `CMS_CONFLICT` with the winner's row |
| A bug of ours (a throwing getter) | 422 with the exception's text | 500 `INTERNAL_ERROR`, raw text only in the log |
| `{ page: null }` | 422 "Cannot destructure property 'slug' of 'object null'" | 400 `MALFORMED` |
| Undo to a version that doesn't exist | 422 | 404 |
| A bad "redirect from" on a journal page | 422, **but the page row was already written** | 422 before anything is written |
| Two homepage sections wrong | 422 `errors: ["Section 1 (banner): …", …]` (position text) | 422 with `issues`, each naming `sectionId` and `field` |
| Page with no title and an empty section | 422 "title required" only (first problem) | 422 with both issues |
| Preview push, hero and sections both wrong | 422 for the hero only (first failing block) | 422 with the issues of both |
| An `/api/admin` route (upsells) with the database down | 422 "fetch failed" | 503 |

The two 409s are the worst of these. A database that was down looked like a colleague's edit. The founder was offered "Load their version" and "Overwrite", and both would also fail. The editor load that returned 200 with defaults showed a customized store as if it were untouched.

## What was built

1. **One issue shape, in one module.** `lib/cms/issues.js` defines `{ documentId, sectionId, blockId, field, code, severity, message, autoFix }` (`issue()`), `ValidationError` (422, carries every issue), `NotFoundError` (404), and `failure(e)`, the single mapping from any caught error to its answer. It has no server imports, so the server, the edge storefront and the console editors all use the same file.
   - `documentId`: the §8.3 document the content becomes. `doc_home` covers the hero and home sections. The others are `doc_announcement`, `doc_header`, `doc_footer`, `doc_design`, `doc_collections_index` and `doc_product_layout`. It is null for content pages and templates, whose ids DOC-01 mints.
   - `sectionId`: the durable `sec_…` id, or `"hero"` for the hero (the preview bridge already calls it that, and DOC-07 makes it a real section).
   - `blockId`: null until TREE-02 ships nested blocks. `autoFix`: null. Nothing offers one in phase 1.
   - `field`: the setting key, or a path into a list (`items.2.label`, `items.0.children.1.href`).
   - `message`: plain words with **no position**.
2. **All issues are collected.** This covers `validateBlock` (every block), page sections (`checkPageSections` in `lib/cms/store.js`; `validatePageSections` still throws, now a `ValidationError` carrying every issue), the whole page save (slug, title, dates, family, windows, redirect, sections), templates, the preview push (every candidate block), and publish (`validateRelease`). Ids are stamped *before* checking, so each issue names the id its section is saved under, including when two sections arrive with the same id.
3. **422 for validation, 5xx for infrastructure.** `failure(e)` decides the answer:
   - `ValidationError` → 422 `{ error: "There are N things to fix", code: "VALIDATION_FAILED", issues, errors, warnings }`. `errors` and `warnings` are the messages alone, for older readers.
   - `NotFoundError` → 404. A deliberate refusal with `e.expose` and a 4xx `e.status` keeps both.
   - Then, **only for driver and network errors** (fix round 1, above): a missing table or column → 503 `DATABASE_NOT_READY`; unreachable, locked, read-only, I/O, out of space, or the hosted database's server or connection failing → 503 `DATABASE_UNAVAILABLE`; a UNIQUE or PRIMARY KEY failure → 409 `SAVE_CONFLICT` (on CMS writes it is caught first and answered as `CMS_CONFLICT` with the winner's row); any other broken rule (NOT NULL, CHECK) → 500 `INTERNAL_ERROR`; any other driver error → 503 `DATABASE_ERROR`.
   - Anything else → 500 `INTERNAL_ERROR`.

   An infrastructure body never carries `issues` or `errors`. Its message says what happened to the founder's work ("nothing was saved. Your changes are still here", "the preview didn't update", "nothing was published. Your live store hasn't changed", or "this couldn't load"). If the write went through and only the refresh after it failed, the answer says so (`SAVED_RELOAD_FAILED`, `RELOAD_NEEDED`). The raw text goes to `slog`, plus `captureError` for 500s.
4. **The editors word each issue from its id.** No position comes from the server, and each editor computes the number against what is on screen *now*:
   - **Page editor:** keeps AU-05's exact words ("section 3: …", "section 1, question 2: …"). Each line is a button that scrolls to that section's card. The question number now counts the blank rows the save leaves out, which fixes AU-05's known limit "M skips untouched blank rows".
   - **Designer:** "Section 3 (Banner / CTA “Title”): …". Clicking the line selects that section in the tree and highlights it in the preview.
   - **Home editor:** "Section 3 (Banner / CTA): …".
   - **Publishing panel and Storefront overview:** "Section 3 (Banner / CTA): …", from the publish result's `sections` (ids and kinds in the order being published). Since fix round 1 this includes the warnings shown after Publish now and Schedule.
   - **Menus and accordions:** "Header menu, item 2: …", "Product page accordions, accordion 2: …", worked out on the client from the field path.
5. **Sections get a durable id when they are created.** Adding or duplicating a section, or loading one with no usable id (a built-in template, an old history entry), mints a `sec_…` id in the form (`components/admin/cms/pageSections.js` `newSectionId`, and `mintSectionId` in the Designer and Home editor). Before, a never-saved section had no id until after its first successful save, so a refusal could not name it. The server keeps any valid unique id, as it always has.

## Every place a caught database error became a 4xx or a validation message, and what changed

| At `bdbe1a7` | Now |
|---|---|
| `lib/admin/cms-api.js:173` catch-all 422 (block, page, template, reset and delete saves; the preview push at `:110`) | `failed()` → `failure()`; after a write has gone through, `SAVED_RELOAD_FAILED` |
| `lib/cms/store.js:119` `setBlock` read the current row non-strictly, so a failed read became "no row" and then a false 409 | strict read; a race on insert (`:137`, `:436`) → `CmsConflictError` with the current row; only a UNIQUE or PRIMARY KEY failure counts as a race |
| `lib/cms/store.js` `deleteBlock` read after a zero-row delete was non-strict | strict |
| `lib/cms/view.js:43` non-strict revision reads, so the editor load returned 200 with defaults | strict block reads, page list and page revisions (a missing table still reads as not customized) |
| `app/(console)/admin/(authed)/storefront/pages/[slug]/page.js` page load swallowed every read error (a 404, or a built-in default in place of the founder's page, with revision null) | strict, except a missing table (fix round 1) |
| `app/api/admin/releases/route.js:98` `e.status \|\| 422`; GET (`:42`) had no catch | body moved to `lib/admin/releases-api.js`, every path through `failure()`; deliberate refusals keep their 4xx (`e.expose`); after a write has gone through, `RELOAD_NEEDED` |
| `lib/releases.js:73,86` snapshot errors re-thrown without their cause | `{ cause: e }` kept. Since fix round 1 the classifier needs it: it reads the driver's error, not the wrapper's text |
| `lib/releases.js` `rollbackRelease` plain `Error` → 422 | `NotFoundError` → 404 |
| 20 `/api/admin` routes with a 4xx catch-all: accept-invite, agency-grants, automations, billing, bundles, catalog, domains, experiments, insights, integrations, media (3 catches), offers, offers/[id], quiz, returns, setup, team, theme, upsells, upsells/[id] | each answers its own known refusals first, then checks `infraResponse(e)` (`lib/infra-response.js`), then its catch-all. Their own 4xx answers are as at `bdbe1a7`. A source scan in the matrix suite checks that order in every catch-all |

Not a database error, but on the same path: `lib/cms/store.js:445` validated `redirect_from` after the page row was written. It is now validated with everything else, before the write.

## Acceptance

Commands: `node scripts/test-failure-matrix.js` (alias `pnpm test:failure-matrix`) and `node scripts/test-page-editor.js`.

### 1. Every issue names a section id and field when one applies, so the editor can jump to it

**Tags: unit, rendered (stand-in), browser. Status: pass.**
- Unit, `test:page-editor`:
  - `✓ every problem in the page is reported at once, each naming its own section id and field`. Seven issues in one save, each with the `sectionId` of the form row that caused it and its `field` (`body`, `src`, `items.1.q`, `items.2.a`, `heading`, `html`), or `null`/`title` for the page title.
  - `✓ every issue names the id the section is stored under, also for a section the form never saved`
  - `✓ two sections sent with the same id: each issue names the id its own section would be saved under`
- Unit, `test:failure-matrix`:
  - Rows "two homepage sections wrong at once", "hero with no title" (`sectionId: "hero"`), "unsaved hero and sections both wrong", and "banner links to a collection that isn't in the catalog" (publish names `sec_ee55`, `href`).
  - `✓ two sections sent with the same id …` (home sections).
  - Fix round 1: `✓ each publish warning is filed under its own document and section`: hero `primary.href`, announcement `doc_announcement` `href`, menu `doc_header` `items.0.href`, banner `sec_ban1` `href`. `✓ a product-page accordion issue names its accordion from the field path`.
- Rendered, with the real components compiled by SWC on stand-in hooks:
  - `PageEditor`: `✓ DOC-04: the banner lists every issue, numbers it from the id, renumbers when the section moves, and each line scrolls to its card`.
  - `ReleasesAdmin` (fix round 1): the warnings after Publish now and Schedule name their place.
- Browser:
  - D2: clicking a line scrolled to `pe-sec-<id>`.
  - D5: clicking a Designer line selected the new banner.
  - D6: the Publishing panel worded a publish issue from its id.
  - D9 (fix round 1): after Publish now, the banner at the top named each warning's place, the same lines as the card below.

### 2. A forced database failure returns 5xx, not 422

**Tag: unit. Status: pass.** 24 matrix rows from the first round force an infrastructure failure (23 a database failure, one a bug of ours), through the real handlers, real `requireAdmin` and real databases, plus one real `/api/admin` route. Saves cover blocks, pages, reset, templates (save and use) and the editor load. The preview push and publish (including the GET) are covered too, and the route is upsells. Fix round 1 adds four page-read load rows, two snapshot-read publish rows, the NOT NULL row and the save-then-refresh row. Every one answers 5xx with a code and a plain message, never `issues` or `errors`. The raced first save answers 409 `CMS_CONFLICT`, not 422. **Browser:** D7, a real `SQLITE_BUSY` from a locked harness database: 503 `DATABASE_UNAVAILABLE`, server log `{"evt":"cms_api_failure","op":"savePage","status":503,"code":"DATABASE_UNAVAILABLE","error":"SQLITE_BUSY: database is locked"}`.

The converse, added in fix round 1: a refusal of ours is never answered as a database failure, whatever it quotes (the bundle, media and AI rows, and the two unit tests in "Blocking 1").

### 3. A failure matrix lists every known save, preview and publish failure and proves each gives a founder-readable message

**Tag: unit. Status: pass for the 58 rows listed, the 6 client rows, the 4 route tests, the 3 panel tests and the 11 guards in the same suite. "Every known" means every failure I found in the code; see Known limits for what is outside it.**

`scripts/test-failure-matrix.js`, 82 tests:
- **Save, 29 rows.** Validation (hero, two sections, page, template, bad redirect). Refusals: stale revision 409, two races 409, no revision 428, two operations 400, page not an object 400, signed out 401, support role 403, template gone 404. Infrastructure: database doesn't answer (block, page), read-only (block, reset, page), never migrated (block, page), templates table missing (save, use), reads fail (block, reset, page), a bug of ours, a NOT NULL failure, and saved-then-refresh-failed.
- **Load, 6 rows.** Database down; reads failing; only the page reads failing; only the page list; only the page revisions; a store without the page `family` column whose list then fails.
- **Preview, 7 rows.** Both blocks wrong 422, no preview open 409, unknown block 400, table missing (S59), read-only, down, and opening a preview needs no database (200).
- **Publish, 16 rows.** Hero without title 422, dead banner link 422, drafts changed 409, schedule in the past 422, staff 403, undo to a missing version 404, cancel a missing release 404. Infrastructure: down, read-only, reads fail, only the pages fail, only the slug redirects fail, catalog lookup fails, release table missing, Publishing page load down. Published-then-refresh-failed (200 with a notice).
- **Client, 6 rows** (`components/admin/cms/api.js`). No connection, a gateway's HTML page, a 5xx from us, a 422, and saved-then-refresh-failed with the re-read working and with it failing too.
- **Other `/api/admin` routes, 4 tests.** Upsells with the database down (503); bundles and media refusals that quote "network" (422, 409); the AI service not answering (503 `AI_UNAVAILABLE`).
- **Publishing panel, 3 tests** (fix round 1, above).
- **Guards, 11 tests.** The catch-all order scan, the no-position-text source scan, the editor's wording, two classifier unit tests, `failure()`'s refusal and NOT NULL cases, duplicate ids, where each publish warning is filed, the accordion wording, the matrix's own coverage, and every infrastructure message.

Each row checks four things:
- the status;
- the status class (validation = 422 with issues; refusal = another 4xx; infrastructure = 5xx with a code);
- the code;
- that the `error` and every issue message are founder-readable. That means 8 to 400 characters, with no SQLite, driver, table, stack, `undefined`/`null` or HTML text. For 422s, no issue message carries a position, and each issue reads well as the editor words it. **Since fix round 1, an infrastructure message must also name the right outcome for what the founder was doing** (save, preview, publish, load, or saved-but-not-refreshed), not just be readable.

A coverage test fails if any infrastructure code the module can produce has no row, or if save, preview or publish lacks a validation, refusal or infrastructure row.

### 4. Negative: position-based strings no longer reach the editor for new documents

**Tag: unit. Status: pass.**
- Every refusal in `test:page-editor` (the 24-case matrix, the 36 stray-bracket cases, 8 addresses, 15 videos, 6 pictures, limits, templates and the rest) goes through `assertStructured`. That fails if any issue message matches `/\b(section|question|accordion|item)\s+\d/i`, or if an issue lacks exactly the eight keys.
- Every 422 row in the matrix runs the same check.
- `✓ no save, preview or publish validator builds position text any more`: a source scan of `lib/cms/validate.js`, `store.js`, `templates-store.js`, `lib/releases.js` and both handlers. It finds 8 such templates in `validate.js` at `bdbe1a7`, and none now.
- AU-05's words still reach the founder. `test:page-editor` pins each AU-05 refusal *as the editor shows it* (`pageIssueText`), and the strings are identical to before. Examples: `section 1: add a heading or some text, or remove this section.`, `section 1, question 1: saving would lose these words: "<500 and >". …`, `section 1: the content is too long (20003 characters, the limit is 20000)`, `section 2: this page can't show embedded videos or sound yet, so saving would lose "/v". …`. The quoted words, addresses and limits are unchanged.

## Browser drills done

Desktop Chrome, headless at 1280×900, on the design harness (`node scripts/dev-design.js seed`, then the harness's own env on a private port). Driver, server and lock scripts are in `drills/DOC-04/` with a JSON log per scenario. Screenshots are scaled to 0.7.

First round (port 3164), 42–91 KB each:

| Drill | What happened | Screenshot |
|---|---|---|
| D1 | Page editor: added a Text and an Image section (both never saved) and a Rich HTML section holding `Free on orders <500 and >100 rupees.`, then Save. Banner: "section 2: add a heading …", "section 3: choose an image …", "section 4: saving would lose these words: "<500 and >" …". The numbers match the badges | `drills/DOC-04/D1-page-editor-three-issues.png` |
| D2 | Clicked the image line: the page scrolled (scrollY 466) to `pe-sec-sec_dc4cc386`, the image card | `drills/DOC-04/D2-page-editor-line-scrolls-to-image.png` |
| D3 | Moved the image up. With no new request, the lines read "section 3: add a heading …" and "section 2: choose an image …", matching the new badges | `drills/DOC-04/D3-page-editor-renumbered-after-move.png` |
| D4 | Designer: Add section → Banner / CTA, then Save. "Couldn't save the homepage sections: Section 3 (Banner / CTA): needs a title or text" | `drills/DOC-04/D4-designer-refusal.png` |
| D5 | Selected Hero, then clicked the line: the tree selected "Banner / CTA" and the inspector shows its client-minted id `sec_db937afe` | `drills/DOC-04/D5-designer-line-selects-section.png` |
| D6 | Saved a banner linking to `/collections/not-a-collection`. Publishing showed "Fix before publishing: Section 3 (Banner / CTA): "/collections/not-a-collection" points at a collection that doesn't exist in the catalog" | `drills/DOC-04/D6-publish-panel-issue-from-id.png` |
| D7 | Page editor loaded, then another process held an exclusive lock on `.design-tenant.db`, then Save. Banner: "We couldn't reach your store's data just now, so nothing was saved. Your changes are still here. Try again in a minute." The form stayed Unsaved | `drills/DOC-04/D7-page-editor-database-locked.png` |

Fix round 1 (re-seeded harness, port 3291, Chrome DevTools port 9391; `node docs/cms-reviews/drills/DOC-04/drill.mjs "$PWD" 3291 9391 docs/cms-reviews/drills/DOC-04 media`, then `warnings`). Logs: `drill-log-media.json`, `drill-log-warnings.json`. The server and both Chrome instances were stopped afterwards.

| Drill | What happened | Screenshot |
|---|---|---|
| D8 | Uploaded `partners-doc04.png` through the real upload route (200), saved a page "partner-network" showing it (200), then on the Media screen clicked Delete on that file and confirmed. The second dialog opened: "Still referenced — delete anyway? This file is still referenced: page:partner-network", with "Delete anyway". "We couldn't reach your store's data" appears nowhere on the page. The reviewer saw that message here on `0b98649` | `drills/DOC-04/D8-media-delete-still-referenced.png` (64 KB) |
| D9 | Saved the announcement link `/another-odd`, the hero's primary button link `/x-odd`, and a third home section, a Banner / CTA linking to `/odd-route` (all 200). Publishing, before publishing, the card listed: "Hero: the primary button links to "/x-odd", which isn't a storefront route this platform serves — double-check it", "Announcement bar: "/another-odd" isn't a storefront route …", "Section 3 (Banner / CTA): "/odd-route" isn't a storefront route …". Clicked Publish now and confirmed: toast "Published — live now.", and the banner at the top showed **the same three lines**, plus the two policy-page warnings, which have no place | `drills/DOC-04/D9-publish-result-warnings-located.png` (96 KB) |

In D4 and D5 the Designer's preview pane shows "Something went wrong". The server log has `URL_SCHEME_NOT_SUPPORTED … got "file:"`: the storefront runs on the edge runtime, whose libsql client cannot open the harness's file databases. That is the harness gap named in spec §8.15, not this change. The preview was not looked at.

## Mutation check

Scratch runners, not committed: each mutation replaces one exact string, runs the named suite, and restores the file.

**First round, 34 mutations.**
- **First pass:** 29 caught and 5 survived.
- **Cases added:** for M18 (a technical network message passed the plain-words check) and M33 (the Designer's hero wording). Both are now caught.
- **Still surviving then, 3:** M28 (dropping `{ cause: e }` from the snapshot wrapper; now caught, see below), M29 (removing the try/catch around `requireAdmin` in `cms-api.js`; unreachable, because `verifySession` and `membershipRole` swallow their own errors), M31 (a non-strict read after a zero-row reset; not isolated, because any table broken enough to fail that read also fails the DELETE before it).

**Fix round 1, 28 mutations, all caught in the end.** The first pass ran 24: 20 caught, 4 survived (F10, F11, F13, F23). I added cases for those, then ran them again with 4 more (F13b, F25 to F27): 7 caught, and F26 survived. One more case, and F26 was caught too.

| # | Mutation | Caught by |
|---|---|---|
| F1 | Free text back in the classifier (`network`, `timeout`, `timed out` in any message) | "our own errors are never infrastructure…" |
| F2 | Any `TypeError` counts as a network failure | row "a bug on our side" |
| F3 | Media: the database check ahead of `MEDIA_IN_USE` again | the catch-all order scan |
| F4 | Bundles: the `problems` answer removed | "a bundle refusal that quotes … Network Switch 8-port…" |
| F5, F6 | Panel shows bare warnings after Publish now / Schedule (the reviewer's R9) | the two panel tests |
| F7 | `createRelease` returns no `issues` | the Publish now panel test |
| F8 | Publish's refresh failure answered as a failure again | row "published, then the panel's refresh fails" |
| F9 | A block save not marked as written | row "saved, then the editor's refresh fails" |
| F10, F11 | The view reads the page list / the page revisions non-strictly | **survived the first pass** (each hid the other). Now: rows "only the page list can't be read", "only the page versions can't be read" |
| F12 | Any broken rule counts as a race | row "a broken rule that isn't a race (NOT NULL)…" |
| F13 | The snapshot's pages wrapper drops its cause (the first round's M28) | **survived the first pass** (no row reached that wrapper: the broken tenant fails on blocks first). Now: row "reading the pages fails (blocks read fine)" |
| F13b | The snapshot's other-tables wrapper drops its cause | row "reading the slug redirects fails" (new) |
| F14 | The AI call's failure not named | "the AI service not answering…" |
| F15 | Insights drops its `AI_UNAVAILABLE` answer | same |
| F16, F17 | Two colons back (hero; menu) | "each publish warning is filed…, and reads with one colon" |
| F18 | Accordion issue loses its field path (the reviewer's R2) | "a product-page accordion issue names its accordion…" |
| F19 | Announcement issue filed under `doc_home` (R10) | "each publish warning is filed…" |
| F20, F21 | Publish / preview infrastructure messages say "nothing was saved" (R6, R7) | rows "publish: database doesn't answer", "preview: preview table missing" (the outcome-words check) |
| F22 | `failure()` ignores `e.expose` | row "cancel a release that isn't scheduled" |
| F23 | `test:releases`' menu filter made vacuous again | **survived the first pass** (the check that the filter works had its own copy of the filter). Now one shared filter; `test:releases` |
| F24 | Menu issues filed under the wrong document | `test:releases` |
| F25 | The client doesn't re-read the view after `SAVED_RELOAD_FAILED` | client test "…it reads the view once more…" |
| F26 | The page list's fallback read (stores without the `family` column) ignores `strict` | **survived when first run.** Now: row "a store from before page families, when the page list can't be read" |
| F27 | `pageRevisions` ignores `strict` | row "only the page versions can't be read" |

Every mutated file was restored and compared byte for byte with the saved working copy after each run.

The reviewer's own runner reported R4 and R5 (the Home editor and Designer not minting ids) surviving. They still would: neither component has an automated test (see Known limits).

## Test results

`pnpm test` on the final code: **45 of 45 suites passed in 61.9s**. A second run, `node scripts/run-tests.js --verbose`, gave 45 of 45 in 58.3s: **920 tests passed, 0 failed**. Per suite (passed/failed):

```
test:orders 27/0            test:shipping 12/0          test:shopify-push 13/0
test:shopify-boundary 41/0  test:hardening 11/0         test:offers 27/0
test:offers-admin 8/0       test:events 16/0            test:tenancy 9/0
test:platform-sync 15/0     test:admin-console 9/0      test:cms-api 20/0
test:page-editor 61/0       test:refs 8/0               test:sections 15/0
test:cms 11/0               test:platform-ops 9/0       test:tenant-boundary 24/0
test:identity 22/0          test:authz 14/0             test:platform-core 15/0
test:jobs 12/0              test:sync-generations 8/0   test:order-projection 14/0
test:commerce 10/0          test:privacy 11/0           test:security 19/0
test:content 19/0           test:releases 25/0          test:themes 10/0
test:storefront 15/0        test:surfaces 15/0          test:billing 14/0
test:provision 9/0          test:reporting 6/0          test:tenant-ops 9/0
test:marketing 4/0          test:customers 9/0          test:commerce-exp 18/0
test:growth 21/0            test:agency 16/0            test:w6 16/0
test:copy 52/0              test:media-upload 119/0     test:failure-matrix 82/0
```

Before fix round 1 (`0b98649`): the same 45 suites passed, 898 tests, with `test:failure-matrix` at 60. Only `test:failure-matrix` (60 → 82) and one test inside `test:releases` changed. Baseline `bdbe1a7` before any change: 44 of 44 suites; `test:page-editor` was 53/0 there, and `test:failure-matrix` did not exist.

`test:perf` was not run (a measurement).

**`next build`** passes on this commit, run with local file databases only (there is no `.env.local` in this worktree): "Compiled successfully". The only warnings are the two NFT trace warnings from `lib/platform/migrate.js` through the `/api/platform` routes, which this branch does not touch. The modules changed in this round that a shopper's page can reach (`lib/cms/issues.js`, `lib/cms/store.js`, `lib/releases.js`) use no `node:` APIs. No shopper-facing behaviour changed: `listContentPages()` without `strict` (the sitemap) reads as before.

## Deviations from the spec

1. **`documentId` is the §8.3 id the content becomes, or null for pages and templates; `blockId` is always null; `autoFix` is always null.** Documents don't exist in phase 1. The hero's `sectionId` is the literal `"hero"`.
2. **Editors mint section ids when a section is created.** This touches `Designer.js` (add, duplicate, history load), `HomeEditor.js` (add, duplicate) and `PageEditor.js` (duplicate), plus `pageSections.js`. It is needed so that a never-saved section can be named. It is a few lines each, with no layout change.
3. **Issues are shown in the existing banners, with a click to the section.** Showing them beside the field is AU-02's.
4. **`validateRelease`'s `errors` and `warnings` lost their prefixes** ("Hero: …", "Brand: …", "Home section 2 (banner): …"). They are now the bare messages, kept for older readers. Every console screen that shows publish issues words them from `issues`: the Publishing panel's "Fix before publishing" and warnings card, its warnings banner after Publish now and Schedule (since fix round 1; before that it showed the bare messages), and the Storefront overview. One `test:releases` assertion changed to check `documentId: "doc_design"` rather than the "Brand:" prefix, and one, which had become vacuous, now filters on `documentId`.
5. **The releases route body moved to `lib/admin/releases-api.js`**, the pattern S53 used for the storefront route, so the publish path runs in plain node.
6. **The storefront API's own refusals were reworded into plain words, with their codes kept.** These are `NO_OPERATION`, `AMBIGUOUS_OPERATION`, `MALFORMED` (new: a page or template that isn't an object, 400), `REVISION_REQUIRED`, `NO_PREVIEW`, `UNKNOWN_BLOCK` (the preview's) and template `NOT_FOUND`. The founder can see these words if the editor misbehaves.
7. **The 20 other `/api/admin` routes changed, though they are outside save, preview and publish.** Their database failures now answer 5xx. Their own 4xx answers are as at `bdbe1a7`: since fix round 1 each route answers its known refusals before the database check, and the check no longer reads our errors' words. One non-database answer changed too: in insights, the AI provider not answering was 422 "fetch failed" at `bdbe1a7` and is now 503 `AI_UNAVAILABLE` with a plain message.
8. **Shape-error messages reworded:** "home_sections must be a list" and its kin now read "The homepage sections couldn't be read. Reload the page and try again."
9. **New suite `test:failure-matrix`** (named in §8.15), and a second read-only tenant inside `test:page-editor`. Since fix round 1 the matrix also applies the platform migrations to its own local test control plane (the job queue a schedule writes to), as `test:releases` and `test:jobs` do.
10. **New answer codes from fix round 1:** `SAVED_RELOAD_FAILED` (503, `saved: true`) and `RELOAD_NEEDED` (200, with `notice`). They fit §8.14's classes (5xx infrastructure with a code; a success), but the codes are new. Both exist so the answer never claims a failure for a write that went through.

## Merge notes

- **ED-01 runs in parallel** on `Designer.js`, `PageEditor.js` and the console layout. My edits are small and local:
  - Designer: two imports, the `saveOne` failure branch, the add, duplicate and history-load id lines, and `errorBanner`.
  - PageEditor: imports, `problemText`/`sectionAnchor`, the duplicate's `pid`, the `setProblems` line, the "Couldn't save" banner body, the section `Card`'s `id`, and the template dialog's error line.
  - Expect textual conflicts only there. Fix round 1 touched neither file.
- **Batch B validators (OVL-06, COM-03, GEN-02).** Anything that adds a check to `validateBlock`, page sections or `validateRelease` should push `issue({...})` with a `sectionId` and `field`, not a string, and must not put a position in the message. The source scan in `test:failure-matrix` fails on `` `Section ${…}` ``-style messages in those files.
- **Any new `/api/admin` route with a `catch (e)`** must answer its own known refusals first (`if (e?.code === "X") return …`), then check `infraResponse(e, …)`, then fall back. The matrix suite's scan fails otherwise.
- **Any new code that wraps a database error** must keep it as `cause` (`new Error(msg, { cause: e })`). The classifier reads the driver's error, not the wrapper's words, so a wrapper without its cause answers 500 instead of 503.
- `components/admin/cms/api.js` and `pageSections.js` import `lib/cms/issues.js` and `lib/cms/registry.js` by relative path, so plain node (`test:page-editor`) can load them.
- **The parallel database-retries branch** (`claude/gallant-keller-7d3213`, "stop retrying writes whose outcome is unknown") rewrites `lib/db.js`'s retry. This branch does not touch `lib/db.js`. The classifier treats undici's `TypeError: fetch failed` as "database unavailable", which that branch still throws. `test:failure-matrix` takes about 25 seconds, because `lib/db.js` retries the unreachable database 4 times per query; after that merge, recheck the "database doesn't answer" rows and the run time.
- No migration, no new dependency, nothing hosted touched.

## Known limits

**Where failures can still look wrong.**
- **Another service failing can read as the store's database.** A bare `fetch failed` looks the same whether Turso or another service didn't answer. The AI insights call now names itself. Any other outside call that a console route makes without catching its own network failure still answers 503 "We couldn't reach your store's data…" when that service is down. The one I found is choosing a plan in Billing, which calls Razorpay (`lib/platform/razorpay-billing.js`). The integration checks and emails catch their own failures. Before this branch such a failure answered 422 "fetch failed". The real fix is to mark the database's own failures where the clients are made (`lib/db.js`, `lib/platform/control.js`). I left that, because the parallel retries branch is rewriting `lib/db.js`.
- **"Nothing was saved" in the other `/api/admin` routes is a default, not checked per route.** `infraResponse` says "nothing was saved" for any database failure. A route that wrote something and then failed on a later read (a refresh, a list) would say that falsely. The CMS save and publish paths now tell those apart (`SAVED_RELOAD_FAILED`, `RELOAD_NEEDED`); the other routes don't.
- **When the client's second look at the view fails too, the editors show "saved" under their "Couldn't save" title.** The Designer, for example, would show "Couldn't save the homepage sections" over "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes." The words are true, but the title contradicts them. A second Save without reloading then meets a conflict with the founder's own save, because the editor never learned the new revision. Fixing the titles means editing `Designer.js` and `PageEditor.js`, which ED-01 is changing in parallel, so I left it. This needs the database to fail twice in a row right after a write that went through.
- **The page and its redirect are two writes.** If the redirect write fails, the page is saved but the answer is 503 "nothing was saved". DOC-02's single atomic write fixes this.
- **A scheduled release is stored before its job.** If queueing the job fails, the answer is "nothing was published. Your live store hasn't changed" (true), but the history keeps a scheduled release that will never run until it is cancelled. That is older than this branch.
- **A failed sign-in lookup reads as signed out.** `verifySession` and `membershipRole` (`lib/platform/sessions.js:57-79,106-117`) swallow control-plane errors and return null, so a control-plane database failure during `requireAdmin` answers 401 "Unauthorized", not 5xx. Changing that changes sign-in for every route, so it was left for the owner. `tenantHandler` already answers 503 when the control plane can't resolve the host.
- **`/api/platform/*` (operator console) and the shopper routes are unchanged.** Their catch-alls still answer database errors 400 or 422 with raw text: flags, costs, privacy, tenants, partners, queues, support, provisions, billing, incidents, offboard and export. The shopper routes are `contact`, `leads`, `account`, `approve` and `partners`. These are outside save, preview and publish.
- **Routes with no catch at all still answer an unhandled database failure with Next's HTML 500.** These include brand PUT and upsells GET. That is 5xx, not 4xx, but not JSON. The CMS client words a non-JSON answer as "Something went wrong on our side (error 500) …". Other console screens have their own fetch code and show whatever they show.
- **A uniqueness failure in a non-CMS admin route** (for example a duplicate create) answers 409 "Someone else saved at the same moment …", which can misdescribe a duplicate. Before, it was a 422 with SQLite's text.
- **Hosted Turso errors were not exercised.** The classifier knows `@libsql/client` 0.17.4's codes (`SERVER_ERROR`, `HRANA_*` and the `SQLITE_*` codes a hosted database sends back). Only local file databases and an unreachable HTTP URL were run. An unknown driver error shape becomes 503 `DATABASE_ERROR`; an unknown error that isn't a driver's becomes 500. Staging needs to confirm.
- **The media library's usage check swallows read failures** (`lib/media.js` `mediaUsage`, "pre-migration"). If those reads fail, a delete is not warned that the file is in use. The delete itself would usually fail too. That is older than this branch and outside DOC-04's paths; noted for the owner.
- **The Designer still ignores a failed preview push** (`components/admin/cms/Designer.js:290-297`). The API now answers correctly (422 with issues, or 503), but the frame silently stays on the last good state. That is PV-01's.

**How issues are shown.**
- After a reorder, the banner's lines stay in the server's order even though their numbers update (D3: "section 3 …" then "section 2 …").
- A section id the screen doesn't know shows as "A section: …" or "A homepage section: …". This happens with an API caller sending no ids, or a section removed after the refusal.
- Issues are not shown beside their fields, and there is no red border on the field (AU-02).
- `retryable` in 5xx bodies is not used by any screen yet.
- Older copy that is not plain was kept as it was: "image must be https:// or a library path (/api/media/…)", "link must be a path or URL", "needs a label and a path/URL", "isn't a storefront route this platform serves", "Featured: "x" isn't a collection handle". AU-06 and the copy work own these.

**Not covered by a test.**
- The Designer and Home editor have no automated test of their wording or their id minting (the reviewer's R4 and R5 survive). D4 and D5 covered the Designer in a browser once. The reviewer drilled the Home editor once (below). The Storefront overview's wording was not drilled.
- The page editor's server load (`storefront/pages/[slug]/page.js`) is a server component; its strict read has no test. A failed read there now shows the console's error screen.
- `SAVED_RELOAD_FAILED` and `RELOAD_NEEDED` were tested through the handlers, the shared client and, for publish, the real panel on stand-ins. Neither was seen in a browser: forcing a failure *between* a write and the read after it needs a broken harness database.
- M29 and M31 (above).
- Only desktop Chrome. No Safari, no phone, no staging.

**The reviewer's own browser measurements of fix round 0** (headless Chrome, harness, port 3048), kept here because they cover screens I did not drill: the Home editor, adding a blank Banner / CTA as row 3 and saving, showed "Section 3 (Banner / CTA): needs a title or text", and after Move up "Section 2 (Banner / CTA): …", matching the row labels. The Designer under a database lock showed "Couldn't save the homepage sections — We couldn't reach your store's data…", with no conflict banner (server log: `saveBlock` 503 `SQLITE_BUSY`). PDP and Navigation wording were not drilled by either of us.

### From review

Non-blocking findings from the independent reviews, added at merge. The first nine came from the first review and are answered in "Fix round 1" above; they are kept here so the list is complete. The rest came from the review of fix round 1 and are still open.

**First review (answered in "Fix round 1").**
- **Published, then the panel's refresh failed, and the answer said nothing was published.** The live pointer had moved, but the founder read "nothing was published. Your live store hasn't changed". Saves had the same shape: a save that went through could answer "nothing was saved", and the next Save then hit a conflict with the founder's own save. Fix round 1 says publish now answers `RELOAD_NEEDED` and saves answer `SAVED_RELOAD_FAILED`.
- **The packet overclaimed that "editor load returned 200 with defaults" was fixed.** With the page reads broken, the storefront view still answered 200 with no pages while a page existed. Fix round 1 says those reads are strict now.
- **Mutation gaps.** The reviewer's runner found that the accordion field path, the "nothing was saved" wording on publish and preview failures, and the announcement issue filed under the wrong document all went untested. Fix round 1 says R2, R6, R7, R10 and R9 are caught now. R4 and R5 (Home editor and Designer not minting ids) still have no test; already listed above.
- **A comment in `lib/cms/issues.js` described `failure()` wrongly.** Fix round 1 says `failure()` now does what the comment says.
- **A NOT NULL or CHECK failure on a first save read as "edited by someone else".** Fix round 1 says only a UNIQUE or PRIMARY KEY failure counts as a race now.
- **The AI provider failing blamed the store's database.** Fix round 1 says it now answers `AI_UNAVAILABLE` and names the AI service.
- **Publishing copy had two colons in a row** ("Hero: Primary button: …"). Fix round 1 says it reads with one colon now.
- **`next build` was not run by the builder.** The reviewer ran it with local file databases and it passed. The only warning was the existing trace warning from `lib/platform/migrate.js`. The changed storefront modules use no `node:` APIs, and no shopper-facing change was found.
- **The reviewer's own browser checks** of the Home editor renumbering and the Designer under a database lock are recorded in the last paragraph above.

**Review of fix round 1 (still open).**
- **One harmless mutation survives.** Making `createRelease` return every issue instead of only warnings fails no test. It makes no difference, because `createRelease` only gets that far when there are no errors.
- **The order scan in `test:failure-matrix` is weaker than the packet says.** A known answer moved after the database check is caught only through a count of at least 11 known answers, and there are exactly 11 today. If a route adds one, one known answer could be moved after the database check unnoticed. That is harmless now, because the classifier no longer reads our own error words. The line "The source scan now checks that order" says more than the scan does.
- **A wrong or revoked database token is treated as "try again in a minute".** A hosted database answering 401 comes back as `DATABASE_UNAVAILABLE` with `retryable: true`. Retrying won't fix a bad token. Probed through `@libsql/client` 0.17.4 against a local fake server: 401, 500 and 502 all come back the same way. This narrows "Hosted Turso errors were not exercised" a little (the HTTP error shapes match), but real Turso is still untested.
- **A database failure during a media delete says "nothing was saved. Your changes are still here."** That wording is off for a delete. It falls under the known limit that "nothing was saved" is a default in the other `/api/admin` routes.
- **Not done, for the owner's list:** real hosted Turso or staging failure shapes; Safari and a real phone for the Publishing warnings banner and the Media "Still referenced" dialog. The reviewer also did not repeat these builder drills in a browser: saved-then-refresh-failed in an editor (`SAVED_RELOAD_FAILED` under the "Couldn't save" title), publish-then-refresh-failed (the `RELOAD_NEEDED` notice), the page editor load with the page reads broken, the Navigation and product page accordion wording, the Home editor renumbering, and the Storefront overview section number.
