# P1 · DOC-04 · One structured validation result, and errors that say what kind they are

Branch `cms/p1-doc04`, cut from `bdbe1a7`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:284-294` (DOC-04), the status codes in §8.14 (`:2843`), and §8.15 (test strategy). Phase 1 slice: today's home blocks, home sections, page sections, templates, the live-preview candidate and releases. Documents arrive in phase 2.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 45 of 45 suites passed (44 at baseline plus the new `test:failure-matrix`). `test:failure-matrix` 60 passed, 0 failed. `test:page-editor` 61 passed, 0 failed (53 at baseline). Exact counts per suite are under Test results |
| Browser verified | **Partly.** Desktop Chrome (headless, over DevTools) on the design harness, drills D1 to D7 below, with screenshots. The console runs on Node there. The storefront preview pane does not render on the harness at all (edge runtime and file databases, spec §8.15 "Harness fix"), so nothing about the preview frame was seen |
| Staging verified | **NOT DONE.** Unverified |
| Production enabled | **NOT DONE.** Unverified. Nothing pushed, merged or deployed |

## Evidence lines, opened before any change

- `lib/cms/validate.js:54-55` (cited at `c47045f`, same at `bdbe1a7`): home-section errors were strings like `` `Section ${i + 1} (banner): link must be a path or URL` ``. There were 8 such templates in that file.
- `lib/cms/store.js:315` (cited at `c47045f`): page sections threw `` `section ${i + 1}: …` `` and stopped at the first problem. AU-05 rewrote the messages, but at `bdbe1a7` it still threw on the first problem with the position built in (`store.js:350-382`).
- `lib/admin/cms-api.js:173`: `return { status: 422, body: { error: String(e?.message || e) } }`. Every error in the storefront API, database errors included, came back as a 422 carrying the raw text.
- `docs/cms-reviews/S59-live-preview.md:52-55`: "a pre-0016 tenant DB surfaced 'no such table: cms_preview_candidates' as a 422". Reproduced, below.

## The bugs, reproduced first

`scripts/test-failure-matrix.js` drives the real handlers against real tenant databases broken the way production breaks them: unreachable, read-only, never migrated, missing one table, with failing reads, or racing a first save. The same suite was run against an unpacked copy of `bdbe1a7` (`git archive bdbe1a7`). Only one shim was needed there: the old releases route body moved verbatim into `lib/admin/releases-api.js` form, with the old catch unchanged. On `bdbe1a7` the final suite gives **11 passed, 49 failed** (`drills/DOC-04/baseline-matrix-final-bdbe1a7.txt`). On this branch it gives **60 passed, 0 failed**. The full "before" bodies are in `drills/DOC-04/baseline-matrix-bdbe1a7.txt`, from the first 54-row version of the suite run with `FM_SHOW=1`; there, 43 of 54 failed. The 11 that pass on `bdbe1a7` already behaved: stale revision, no revision, two operations, signed out, support role, no preview open, opening a preview, drafts changed, staff can't publish, and cancel a missing release. The eleventh is the coverage test, which has nothing to compare against there.

What the founder got before, verbatim from that run:

| Failure | Before (`bdbe1a7`) | Now |
|---|---|---|
| Database doesn't answer, block save | **409** "edited by someone else since you loaded it", `current: null` | 503 `DATABASE_UNAVAILABLE` |
| Reading the current version fails, block save | **409** "edited by someone else since you loaded it" | 503 `DATABASE_ERROR` |
| Database went read-only, any save | 422 "SQLITE_READONLY: attempt to write a readonly database" | 503 `DATABASE_UNAVAILABLE` |
| Database never migrated | 422 "SQLITE_ERROR: no such table: cms_blocks" | 503 `DATABASE_NOT_READY` |
| Preview table missing (S59's case) | 422 "SQLITE_ERROR: no such table: cms_preview_candidates" | 503 `DATABASE_NOT_READY` |
| Database doesn't answer, page save / preview / publish | 422 "fetch failed" | 503 `DATABASE_UNAVAILABLE` |
| Editor load, database down or reads failing | **200 with code defaults** and null revisions, as if nothing was customized | 503 |
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
   - Missing table or column → 503 `DATABASE_NOT_READY`.
   - Unreachable, locked, read-only, I/O or timeout → 503 `DATABASE_UNAVAILABLE`.
   - Any other driver error → 503 `DATABASE_ERROR`.
   - A uniqueness race → 409 `SAVE_CONFLICT`. On CMS writes it is caught first and answered as `CMS_CONFLICT` with the winner's row.
   - Anything else → 500 `INTERNAL_ERROR`.

   An infrastructure body never carries `issues` or `errors`. Its message says what happened to the founder's work ("nothing was saved. Your changes are still here", or "nothing was published. Your live store hasn't changed"). The raw text goes to `slog`, plus `captureError` for 500s.
4. **The editors word each issue from its id.** No position comes from the server, and each editor computes the number against what is on screen *now*:
   - **Page editor:** keeps AU-05's exact words ("section 3: …", "section 1, question 2: …"). Each line is a button that scrolls to that section's card. The question number now counts the blank rows the save leaves out, which fixes AU-05's known limit "M skips untouched blank rows".
   - **Designer:** "Section 3 (Banner / CTA “Title”): …". Clicking the line selects that section in the tree and highlights it in the preview.
   - **Home editor:** "Section 3 (Banner / CTA): …".
   - **Publishing panel and Storefront overview:** "Section 3 (Banner / CTA): …", from the publish result's `sections` (ids and kinds in the order being published).
   - **Menus and accordions:** "Header menu, item 2: …", worked out on the client from the field path.
5. **Sections get a durable id when they are created.** Adding or duplicating a section, or loading one with no usable id (a built-in template, an old history entry), mints a `sec_…` id in the form (`components/admin/cms/pageSections.js` `newSectionId`, and `mintSectionId` in the Designer and Home editor). Before, a never-saved section had no id until after its first successful save, so a refusal could not name it. The server keeps any valid unique id, as it always has.

## Every place a caught database error became a 4xx or a validation message, and what changed

| At `bdbe1a7` | Now |
|---|---|
| `lib/admin/cms-api.js:173` catch-all 422 (block, page, template, reset and delete saves; the preview push at `:110`) | `failed()` → `failure()` |
| `lib/cms/store.js:119` `setBlock` read the current row non-strictly, so a failed read became "no row" and then a false 409 | strict read; a race on insert (`:137`, `:436`) → `CmsConflictError` with the current row |
| `lib/cms/store.js` `deleteBlock` read after a zero-row delete was non-strict | strict |
| `lib/cms/view.js:43` non-strict revision reads, so the editor load returned 200 with defaults | strict (a missing table still reads as not customized) |
| `app/api/admin/releases/route.js:98` `e.status \|\| 422`; GET (`:42`) had no catch | body moved to `lib/admin/releases-api.js`, every path through `failure()`; deliberate refusals keep their 4xx (`e.expose`) |
| `lib/releases.js:73,86` snapshot errors re-thrown without their cause | `{ cause: e }` kept (the message already carried the driver text, so this is belt and braces) |
| `lib/releases.js` `rollbackRelease` plain `Error` → 422 | `NotFoundError` → 404 |
| 20 `/api/admin` routes with a 4xx catch-all: accept-invite, agency-grants, automations, billing, bundles, catalog, domains, experiments, insights, integrations, media (3 catches), offers, offers/[id], quiz, returns, setup, team, theme, upsells, upsells/[id] | each checks `infraResponse(e)` (`lib/infra-response.js`) first; their own validation answers are unchanged. A source scan in the matrix suite fails if any `/api/admin` catch-all lacks the check |

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
- Rendered, with the real `PageEditor` compiled by SWC on stand-in hooks:
  - `✓ DOC-04: the banner lists every issue, numbers it from the id, renumbers when the section moves, and each line scrolls to its card`
- Browser:
  - D2: clicking a line scrolled to `pe-sec-<id>`.
  - D5: clicking a Designer line selected the new banner.
  - D6: the Publishing panel worded a publish issue from its id.

### 2. A forced database failure returns 5xx, not 422

**Tag: unit. Status: pass.** 24 matrix rows force an infrastructure failure (23 a database failure, one a bug of ours), through the real handlers, real `requireAdmin` and real databases, plus one real `/api/admin` route. Saves cover blocks, pages, reset, templates (save and use) and the editor load. The preview push and publish (including the GET) are covered too, and the route is upsells. Every one answers 5xx with a code and a plain message, never `issues` or `errors`. The raced first save answers 409 `CMS_CONFLICT`, not 422. **Browser:** D7, a real `SQLITE_BUSY` from a locked harness database: 503 `DATABASE_UNAVAILABLE`, server log `{"evt":"cms_api_failure","op":"savePage","status":503,"code":"DATABASE_UNAVAILABLE","error":"SQLITE_BUSY: database is locked"}`.

### 3. A failure matrix lists every known save, preview and publish failure and proves each gives a founder-readable message

**Tag: unit. Status: pass for the 49 rows listed, the 4 client rows, and the 7 guards in the same suite. "Every known" means every failure I found in the code; see Known limits for what is outside it.**

`scripts/test-failure-matrix.js`, 60 tests:
- **Save, 27 rows.** Validation (hero, two sections, page, template, bad redirect). Refusals: stale revision 409, two races 409, no revision 428, two operations 400, page not an object 400, signed out 401, support role 403, template gone 404. Infrastructure: database doesn't answer (block, page), read-only (block, reset, page), never migrated (block, page), templates table missing (save, use), reads fail (block, reset, page), a bug of ours.
- **Load, 2 rows.** Database down; reads failing.
- **Preview, 7 rows.** Both blocks wrong 422, no preview open 409, unknown block 400, table missing (S59), read-only, down, and opening a preview needs no database (200).
- **Publish, 13 rows.** Hero without title 422, dead banner link 422, drafts changed 409, schedule in the past 422, staff 403, undo to a missing version 404, cancel a missing release 404. Infrastructure: down, read-only, reads fail, catalog lookup fails, release table missing, Publishing page load down.
- **Client, 4 rows** (`components/admin/cms/api.js`). No connection, a gateway's HTML page, a 5xx from us, a 422.
- **Guards, 7 tests.** A real admin route, a catch-all source scan, a no-position-text source scan, the editor's wording, duplicate ids, the matrix's own coverage, and every infrastructure message.

Each row checks four things:
- the status;
- the status class (validation = 422 with issues; refusal = another 4xx; infrastructure = 5xx with a code);
- the code;
- that the `error` and every issue message are founder-readable. That means 8 to 400 characters, with no SQLite, driver, table, stack, `undefined`/`null` or HTML text. For 422s, no issue message carries a position, and each issue reads well as the editor words it.

A coverage test fails if any infrastructure code the module can produce has no row, or if save, preview or publish lacks a validation, refusal or infrastructure row.

### 4. Negative: position-based strings no longer reach the editor for new documents

**Tag: unit. Status: pass.**
- Every refusal in `test:page-editor` (the 24-case matrix, the 36 stray-bracket cases, 8 addresses, 15 videos, 6 pictures, limits, templates and the rest) goes through `assertStructured`. That fails if any issue message matches `/\b(section|question|accordion|item)\s+\d/i`, or if an issue lacks exactly the eight keys.
- Every 422 row in the matrix runs the same check.
- `✓ no save, preview or publish validator builds position text any more`: a source scan of `lib/cms/validate.js`, `store.js`, `templates-store.js`, `lib/releases.js` and both handlers. It finds 8 such templates in `validate.js` at `bdbe1a7`, and none now.
- AU-05's words still reach the founder. `test:page-editor` pins each AU-05 refusal *as the editor shows it* (`pageIssueText`), and the strings are identical to before. Examples: `section 1: add a heading or some text, or remove this section.`, `section 1, question 1: saving would lose these words: "<500 and >". …`, `section 1: the content is too long (20003 characters, the limit is 20000)`, `section 2: this page can't show embedded videos or sound yet, so saving would lose "/v". …`. The quoted words, addresses and limits are unchanged.

## Browser drills done

Desktop Chrome, headless at 1280×900, on the design harness (`node scripts/dev-design.js seed`, then the harness's own env on port 3164). Driver, server and lock scripts are in `drills/DOC-04/` with a JSON log per scenario. Screenshots are scaled to 0.7 and are 42–91 KB each.

| Drill | What happened | Screenshot |
|---|---|---|
| D1 | Page editor: added a Text and an Image section (both never saved) and a Rich HTML section holding `Free on orders <500 and >100 rupees.`, then Save. Banner: "section 2: add a heading …", "section 3: choose an image …", "section 4: saving would lose these words: "<500 and >" …". The numbers match the badges | `drills/DOC-04/D1-page-editor-three-issues.png` |
| D2 | Clicked the image line: the page scrolled (scrollY 466) to `pe-sec-sec_dc4cc386`, the image card | `drills/DOC-04/D2-page-editor-line-scrolls-to-image.png` |
| D3 | Moved the image up. With no new request, the lines read "section 3: add a heading …" and "section 2: choose an image …", matching the new badges | `drills/DOC-04/D3-page-editor-renumbered-after-move.png` |
| D4 | Designer: Add section → Banner / CTA, then Save. "Couldn't save the homepage sections: Section 3 (Banner / CTA): needs a title or text" | `drills/DOC-04/D4-designer-refusal.png` |
| D5 | Selected Hero, then clicked the line: the tree selected "Banner / CTA" and the inspector shows its client-minted id `sec_db937afe` | `drills/DOC-04/D5-designer-line-selects-section.png` |
| D6 | Saved a banner linking to `/collections/not-a-collection`. Publishing showed "Fix before publishing: Section 3 (Banner / CTA): "/collections/not-a-collection" points at a collection that doesn't exist in the catalog" | `drills/DOC-04/D6-publish-panel-issue-from-id.png` |
| D7 | Page editor loaded, then another process held an exclusive lock on `.design-tenant.db`, then Save. Banner: "We couldn't reach your store's data just now, so nothing was saved. Your changes are still here. Try again in a minute." The form stayed Unsaved | `drills/DOC-04/D7-page-editor-database-locked.png` |

In D4 and D5 the Designer's preview pane shows "Something went wrong". The server log has `URL_SCHEME_NOT_SUPPORTED … got "file:"`: the storefront runs on the edge runtime, whose libsql client cannot open the harness's file databases. That is the harness gap named in spec §8.15, not this change. The preview was not looked at.

## Mutation check

Scratch runner, not committed: each mutation replaces one exact string, runs `test:failure-matrix` and/or `test:page-editor`, and restores the file. 34 mutations.
- **First pass:** 29 caught and 5 survived.
- **Cases added:** for M18 (a technical network message passed the plain-words check) and M33 (the Designer's hero wording). Both are now caught.
- **Still surviving, 3:**
  - **M28**, dropping `{ cause: e }` from the snapshot wrapper. Equivalent: the wrapper's message already includes the driver's text, which the classifier reads. The cause walk itself has a unit case.
  - **M29**, removing the try/catch around `requireAdmin` in `cms-api.js`. Unreachable today: `verifySession` and `membershipRole` swallow their own errors (see Known limits), so `requireAdmin` does not throw.
  - **M31**, a non-strict read after a zero-row reset. Not isolated: any table broken enough to fail that read also fails the DELETE before it, because SQLite builds the view's columns for the trigger's `OLD` row. A "reset when reads fail" row was added and answers 503, but it would pass with the mutation too.
- **Caught**, among others:
  - the classifier's three patterns and its fallback;
  - the strict reads in `setBlock` and the view;
  - the race catch on blocks and pages;
  - the redirect pre-check;
  - both catch-alls;
  - the preview's collect-all;
  - id stamping for home and page sections;
  - the FAQ row number;
  - wording at save time instead of render time;
  - `api.js`'s 422 branch;
  - `infraResponse`;
  - first-issue-only on pages;
  - a missing key in the issue shape;
  - the hero's `sectionId`, the banner's `sectionId` in publish, and rollback's 404;
  - wording a section by position, and position text put back into a message;
  - the upsells route's check;
  - the releases 422 shape.

## Test results

`pnpm test` on the final code, before this packet was written: **45 of 45 suites passed in 61.0s**. Per suite, from `node scripts/run-tests.js --verbose` on the committed branch (passed/failed):

```
RESULTS_PLACEHOLDER
```

`test:perf` was not run (a measurement). `next build` was not run.

## Deviations from the spec

1. **`documentId` is the §8.3 id the content becomes, or null for pages and templates; `blockId` is always null; `autoFix` is always null.** Documents don't exist in phase 1. The hero's `sectionId` is the literal `"hero"`.
2. **Editors mint section ids when a section is created.** This touches `Designer.js` (add, duplicate, history load), `HomeEditor.js` (add, duplicate) and `PageEditor.js` (duplicate), plus `pageSections.js`. It is needed so that a never-saved section can be named. It is a few lines each, with no layout change.
3. **Issues are shown in the existing banners, with a click to the section.** Showing them beside the field is AU-02's.
4. **`validateRelease`'s `errors` and `warnings` lost their prefixes** ("Hero: …", "Brand: …", "Home section 2 (banner): …"). They are now the bare messages; the panels word `issues` instead. One `test:releases` assertion changed to check `documentId: "doc_design"` rather than the "Brand:" prefix.
5. **The releases route body moved to `lib/admin/releases-api.js`**, the pattern S53 used for the storefront route, so the publish path runs in plain node.
6. **The storefront API's own refusals were reworded into plain words, with their codes kept.** These are `NO_OPERATION`, `AMBIGUOUS_OPERATION`, `MALFORMED` (new: a page or template that isn't an object, 400), `REVISION_REQUIRED`, `NO_PREVIEW`, `UNKNOWN_BLOCK` (the preview's) and template `NOT_FOUND`. The founder can see these words if the editor misbehaves.
7. **The 20 other `/api/admin` routes changed, though they are outside save, preview and publish.** Only their database failures changed. Their own 4xx answers are as before.
8. **Shape-error messages reworded:** "home_sections must be a list" and its kin now read "The homepage sections couldn't be read. Reload the page and try again."
9. **New suite `test:failure-matrix`** (named in §8.15), and a second read-only tenant inside `test:page-editor`.

## Merge notes

- **ED-01 runs in parallel** on `Designer.js`, `PageEditor.js` and the console layout. My edits are small and local:
  - Designer: two imports, the `saveOne` failure branch, the add, duplicate and history-load id lines, and `errorBanner`.
  - PageEditor: imports, `problemText`/`sectionAnchor`, the duplicate's `pid`, the `setProblems` line, the "Couldn't save" banner body, the section `Card`'s `id`, and the template dialog's error line.
  - Expect textual conflicts only there.
- **Batch B validators (OVL-06, COM-03, GEN-02).** Anything that adds a check to `validateBlock`, page sections or `validateRelease` should push `issue({...})` with a `sectionId` and `field`, not a string, and must not put a position in the message. The source scan in `test:failure-matrix` fails on `` `Section ${…}` ``-style messages in those files.
- **Any new `/api/admin` route with a `catch (e)`** must start it with the `infraResponse(e, …)` check, or the matrix suite's scan fails.
- `components/admin/cms/api.js` and `pageSections.js` import `lib/cms/issues.js` and `lib/cms/registry.js` by relative path, so plain node (`test:page-editor`) can load them.
- `test:failure-matrix` takes about 25 seconds, because `lib/db.js` retries the unreachable database 4 times per query. If the retry rules change elsewhere (a separate session is changing database retries), recheck the "database doesn't answer" rows.
- No migration, no new dependency, nothing hosted touched.

## Known limits

**Where failures can still look wrong.**
- **A failed sign-in lookup reads as signed out.** `verifySession` and `membershipRole` (`lib/platform/sessions.js:57-79,106-117`) swallow control-plane errors and return null, so a control-plane database failure during `requireAdmin` answers 401 "Unauthorized", not 5xx. Changing that changes sign-in for every route, so it was left for the owner. `tenantHandler` already answers 503 when the control plane can't resolve the host.
- **`/api/platform/*` (operator console) and the shopper routes are unchanged.** Their catch-alls still answer database errors 400 or 422 with raw text: flags, costs, privacy, tenants, partners, queues, support, provisions, billing, incidents, offboard and export. The shopper routes are `contact`, `leads`, `account`, `approve` and `partners`. These are outside save, preview and publish.
- **Routes with no catch at all still answer an unhandled database failure with Next's HTML 500.** These include brand PUT and upsells GET. That is 5xx, not 4xx, but not JSON. The CMS client words a non-JSON answer as "Something went wrong on our side (error 500) …". Other console screens have their own fetch code and show whatever they show.
- **A uniqueness failure in a non-CMS admin route** (for example a duplicate create) now answers 409 "Someone else saved at the same moment …", which can misdescribe a duplicate. Before, it was a 422 with SQLite's text.
- **The classifier reads driver names and message text.** An error shape it doesn't know becomes 500 `INTERNAL_ERROR`: still 5xx, never 4xx. Hosted Turso errors (Hrana, HTTP statuses, auth failures) were not exercised; only local file databases and an unreachable HTTP URL were. Staging needs to confirm.
- **The page and its redirect are two writes.** If the redirect write fails, the page is saved but the answer is 503 "nothing was saved". DOC-02's single atomic write fixes this.
- **The Designer still ignores a failed preview push** (`components/admin/cms/Designer.js:290-297`). The API now answers correctly (422 with issues, or 503), but the frame silently stays on the last good state. That is PV-01's.

**How issues are shown.**
- After a reorder, the banner's lines stay in the server's order even though their numbers update (D3: "section 3 …" then "section 2 …").
- A section id the screen doesn't know shows as "A section: …" or "A homepage section: …". This happens with an API caller sending no ids, or a section removed after the refusal.
- Issues are not shown beside their fields, and there is no red border on the field (AU-02).
- The Designer, Home editor, Publishing panel and Storefront overview have no automated test of their wording. D4 to D6 cover the Designer and Publishing in a browser once; the Home editor and the overview were not drilled.
- `retryable` in 5xx bodies is not used by any screen yet.
- Older copy that is not plain was kept as it was: "image must be https:// or a library path (/api/media/…)", "link must be a path or URL", "needs a label and a path/URL", "isn't a storefront route this platform serves", "Featured: "x" isn't a collection handle". AU-06 and the copy work own these.

**Not covered by a test.**
- M31 (above): the strict read after a zero-row reset.
- `next build` was not run, so the client bundle importing `lib/cms/issues.js` and `registry.js` was not built for production. Both are import-free plain JS, and the dev server compiled and ran them in D1 to D7.
- Only desktop Chrome. No Safari, no phone, no staging.
