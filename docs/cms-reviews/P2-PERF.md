# P2-PERF: measuring the version 4 read path

Branch `cms/p2-perf`, cut from `f893710`. Plan: `docs/cms-reviews/P2-PLAN.md` (decision 5, batch 5, sections 2, 3, 4 and 6). Spec: PERF-01 (section 7), section 8.7. Harness: `docs/cms-reviews/P1-HARNESS.md`. Builds on P1-PERF-04 (the perf fixture, `perf-report`, `perf-dbcount`), P2-VGATE (the request-cache stub), P2-READ (the v4 reader) and P2-PUBLISH (`publish.js`). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes (fix round 2, commit `8868fbb`). `pnpm test:perf-docs` 14 passed, 0 failed (2.4 s in the gate). `pnpm test:surfaces` 16 passed. `pnpm test:perf-tools` 26 passed. `pnpm test:publish-service` 26 passed. `pnpm test`: 66 of 66 suites passed in 118.7 s. Every new test was run against the code before its fix and fails there (see "Fix round 1" and "Fix round 2"). `next build` passed (through `perf-report http --build`). All five real-Next columns taken again on one build of `8868fbb` on the design harness (ports 3620 and 4620 to 4628) |
| Browser verified | **NOT DONE.** No acceptance item here needs a browser. The real-Next runs did check every measured response: status 200, not the error page, the expected words on the page, and `x-edge-runtime: 1` on every storefront page |
| Staging verified | **NOT DONE. Staging is unverified.** No hosted numbers (OQ-19) |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real store changed mode. Fix round 1 changed `lib/documents/publish.js` and `lib/documents/commit.js` (console publish only). Fix round 2 changed storefront catalog reads that every store makes, legacy included: `app/(storefront)/layout.js`, `lib/repo.js`, `lib/cms/section-data.js`, `lib/experiments.js`. Shoppers see the same pages (see "Fix round 2") |

No real store moves to documents mode. Only the unit test's own stores and the harness store (for the length of a run) are put in documents mode.

## What and why

P2-READ made shoppers read a v4 release as a small list of document versions, so that a page reads only what it shows (PERF-01). Its unit tests counted statements on a hand-built list. This item measures the same thing on the perf fixture, published through the real publish service, at 0, 200 and 1,000 journal posts, both under the request-cache stub and through a real Next production build. It also reports the extra costs the plan asked for: the `cms_state` read that legacy stores with no release now pay, the journal-index read of an unlisted slug, and the route handlers whose `cache()` does nothing.

**The headline:** the whole-release read is gone (home parses 49.3 KB from the database instead of 648.7 KB), and the read counts hold: home and a policy page make 3 content statements, checkout and the footer read no page body, the sitemap and `/journal` read the journal index once. After fix round 1, journal posts are no longer in the release list, so what a page reads no longer grows with the number of posts. After fix round 2, home no longer reads catalog it never shows, so it is under 50 KB: 50,391 bytes at 0 posts, 50,502 at 200 and 50,519 at 1,000 (1 KB = 1,024 bytes, as in the baseline; the limit is 51,200 bytes). All acceptance items pass.

## Design

**`scripts/perf-docs-fixture.js`** (new).
- `buildDocumentsFixture({ posts })` is pure and deterministic. It takes the PERF-04 fixture (`buildPerfFixture` with `journalPosts: posts`) and turns its content into registry bodies through the P2-REG adapters (`legacyHeroToSection`, `legacyHomeSectionsToSections`, `legacyPageSectionsToSections`, `legacyAnnouncementToSettings`):
  - 8 singletons: announcement (the demo's live bar), header and footer (the fixture's menus, as custom menus), design (the demo tenant's accent), home (the demo's live hero plus the fixture's 12 home sections), collections index, product layout, collection layout. `doc_cart` is left out: the write service refuses cart writes (P2-PREVIEW), so it stays the explicit null of `emptyList`.
  - 21 pages (the fixture's 20 plus the demo's shipping page), 4 campaigns, `posts` journal posts.
  - Every section id is fixed (the layouts' protected module too, which `emptyBody` would mint at random). Every body must pass `validateDocument` in publish mode, or the builder throws.
  - `hash` is sha256 of the stable JSON of all documents.
- `publishDocumentsFixture(fx)` creates each document through the write service (`createDocument`, so no table is written directly and the grep guards of `test-documents` and `test-writers` stay clean), then publishes them through `publish()` in sets of up to 200. The journal index is made by `publish` itself. Route ids come from the service (random, plan decision 10).
- `takeOverHarnessStore` (harness only) clears the seeded v3 pointer and sets `cms_state` to documents, as a cutover would. The publish service rightly refuses a store whose live release is v1 to v3.
- A CLI for the harness: `hash`, `publish --posts N`, `unpublish-legacy` (clears the pointer and leaves the store legacy: a store before its first publish) and `report` (writes `docs/perf/2026-11-phase2-local.json` and `.md` from perf-report runs). The CLI starts the harness's platform and tenant sqld on `DESIGN_SQLD_PORT`, refuses when the harness is running or the data isn't the perf fixture, and checks the database URLs are local.

**`scripts/test-perf-docs.js`** (replaces the P2-ATOM placeholder; `package.json` unchanged). Five stores on file databases: the fixture at 0, 200 and 1,000 posts (published through `publish.js`), a legacy store with a live v3 release, and a legacy store with no release. It loads the REAL `app/(storefront)/layout.js` (its `generateMetadata` too), `page.js`, `policies/[slug]/page.js` (both `generateMetadata` and the page), `checkout/page.js`, `journal/page.js` and `app/sitemap.js`, compiled with Next's SWC as `test-release-readers` does, and runs each request inside one `runRequest` of the request-cache stub. Components below the pages are stubbed; the pages' own reads are what is counted. A statement watcher records each statement's SQL, arguments and the bytes it returned. "Content statements" are P2-READ's: release, documents and CMS tables; catalog reads are not content.

**`scripts/perf-http.js`** (small, additive). Three options: `--extra-routes` adds `/sitemap.xml`, `/api/upsell`, `/offline` and `/manifest.webmanifest` to the measured routes, `--posts N` puts the post count in the journal route's label, and `--stem NAME` names the output files. The fixture sizes now also record the store's `cms_state` mode, the live release's `v` and the document counts. Without the new options a run is the PERF-04 run, unchanged (`test:perf-tools` 26 passed, its route-list check included). `scripts/perf-dbcount.js` is unchanged.

**`docs/perf/2026-11-phase2-local.json` and `.md`**: the five runs side by side, with the PERF-04 baseline, and the notes below. Kind: local. No budgets.

## Fix round 1

Two blockers from review, both fixed in commit `5e5fa58`.

**1. The CLI did nothing in a checkout whose path has a space.** `scripts/perf-docs-fixture.js` decided whether it was run as a CLI with ``import.meta.url === `file://${process.argv[1]}` ``. `import.meta.url` writes a space as `%20`, so in the owner's checkout (`.../Projects 2026/storeasy26`) the check was false: every command (`hash`, `publish`, `unpublish-legacy`, `report`) exited 0 with no output, and `test-perf-docs` failed there. It now uses the repo's pattern (`scripts/drill.js`): `process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]`.
- New test: "the CLI runs from a checkout whose path has a space …". It copies the script into a temp folder `.../Projects 2026/storeasy26/scripts/` (everything it imports is linked back to this checkout), runs `hash --posts 0` and checks the hash, and checks that an unknown command exits 2. With the old line it fails ("the hash command printed nothing"); with the fix it passes. The temp folder is resolved with `realpath`, because on macOS the temp folder sits behind a `/var` symlink and Node names the running script by its real path.

**2. Journal posts were in `list.documents`, so every v4 read grew with the post count (was finding 1).** `lib/documents/publish.js` (`makeBuild`) now drops each published post's `list.documents` entry after `setEntries`; the post is listed through the new `indexes.journal` version only, and its redirects stay in `list.redirects`. The four places that used a post's list entry now read the post's row in the live journal index (`liveEntryOf`; a post's index row carries its version, and no hash):
- the "already live, skip" check (step 5);
- the live body for the inherited-section rule (step 4);
- the "someone else published this" check after a lost commit (it now reads the journal index of the new live list as well, once, only when the set holds a post);
- `commit.js` `liveListHoldsMine` (the reconcile after a thrown batch): a version with no list slot counts as live only when one of this build's own journal index versions is held in the live list and its body names that version. The index version is minted fresh for each build, so it can only be live if this batch committed.
- The publish log's `from_version_id` for a post also comes from its index row.
- A list written before this rule (a post with its own `list.documents` entry) is still read: the index row is used first, the list entry if the index has none. The entry is dropped the next time that post is published. No real store has a v4 list today, so this only matters for test and harness data.
- The journal index body is read at most once per index version per publish (it was read again on every attempt before).

New tests in `scripts/test-publish-service.js` (P2-PUBLISH's suite), run three ways:

| Test | Before the fix | The one-line fix alone (drop the entries, nothing else) | After |
|---|---|---|---|
| PERF-01: a post gets no `list.documents` entry; the list holds the same documents and pages; its redirect stays listed and works | fails | passes | passes |
| the skip check: a post live through the index is skipped; one live through an older list's own entry is skipped; republishing it drops the entry; the log names the previous version | fails | fails | passes |
| the inherited rule: a post live through the index with an incomplete section publishes a typo fix with a warning; a new incomplete section still blocks | fails (422) | fails | passes |
| the lost check: two publishes of the same post at once give one success and one 409 `PUBLISHED_ELSEWHERE`; two different posts both go live | passes | fails (the loser silently overwrote the winner) | passes |
| `liveListHoldsMine`: a post version counts as live through this build's own index version, and only then (another index live, no index live, a version no index names, a page slot not live) | fails | fails | passes |

In `scripts/test-perf-docs.js` the "MEASURED" test (which pinned the growth) is replaced by "home and policy: the pointer read, and every content statement, returns identical bytes at 200 and 1,000 posts; at 0 posts the only difference is the journal index entry itself". It checks that no post is in `list.documents`, that the 200- and 1,000-post lists are the 0-post list plus its index entry, and that home's and the policy page's pointer bytes and content bytes are equal at 200 and 1,000 posts. Before the fix it fails. Unit numbers after the fix: the list is 10,849 bytes at 0 posts and 10,953 at 200 and at 1,000; home's pointer read 12,062 / 12,174 / 12,174 bytes; home's content bytes 20,457 / 20,569 / 20,569.

## Fix round 2

One blocker from review: acceptance 5b ("home parsed bytes drop from about 649 KB to under 50 KB") was not met at `0577a0d`. Home parsed about 60 KB on v4, about 40 KB of it catalog reads that legacy stores make too. Round 1 required the fix to land or the owner to waive the target. This round cuts the catalog share instead (commit `8868fbb`); no waiver is needed.

**How the bytes were found.** `scripts/perf-dbcount.js` now also records each statement shape's own result bytes (`shapeBytes`: its columns and rows as JSON), and `scripts/perf-http.js` writes them as `bytes` on each statement. The counts are unchanged. Before the fix, home at 1,000 posts was: five rails 18,198 bytes, the pointer and list 12,688, the home and chrome versions 9,608, the header's and footer's collection list 6,263, newest products 3,621, the collections grid 2,513, the experiment 1,534, five pins reads 1,110, five rail counts 1,084, the rails' collection names 702, two catalog counts 434, plus about 150 bytes of answer framing per round trip (25 round trips).

**What changed.** Each cut is something home read and never showed:
- `app/(storefront)/layout.js`: the catalog's collections are only the Header's and Footer's fallback when the store has no menu of its own (`nav` null; both components ignore `collections` when `nav` is a list). The layout now reads them only when the header or the footer menu is not a list. This holds on every storefront page, not only home. The cost: a store without its own menus starts this read once its chrome is known, instead of alongside it (one database trip later; see Known limits).
- `lib/repo.js` `getProductsInCollection`: a new option `withTotal: false` skips the count (`total` is then null). The home rails (`lib/cms/section-data.js`) use it; they only show products. The collection page still counts (default `true`).
- `lib/repo.js` `collectionPinsByHandles` (new): every rail's pins in one statement, the same values `collectionPinsByHandle` gives (at most 24; `[]` for none, bad JSON or a pre-migration tenant). `section-data.js` reads it once and passes `pins` to each rail. A repo without it (the tests' fakes) keeps each rail's own read.
- `lib/repo.js` `getCatalogStats`: both counts in one statement.
- `lib/experiments.js` `runningExperimentFor`: selects `id, slug, name, target_kind, status, variants, salt` instead of every column. Serving uses slug, name, variants and salt (`heroVariantFor`, `assignVariant`); home is its only caller (test-preview-experiments checks that).
- `lib/repo.js` `getFeaturedCollections`: no description (`CollectionCard` shows handle, title, image, alt and the count). Its only callers are the home grid and `perf-report`'s library mode.

**Result** (real Next, one build of `8868fbb`): home on v4 parses 50,391 / 50,502 / 50,519 bytes at 0 / 200 / 1,000 posts (49.2 / 49.3 / 49.3 KB), in 14 round trips instead of 25. Split at 1,000 posts: rails 18,198, pointer and list 12,688, versions 9,608, newest 3,622, grid 1,955, experiment 873, collection names 702, pins 425, counts 296, framing about 2,150. Content is 22,296 bytes of it; the catalog 26,071.

New tests, each run against the code before the fix:

| Test | Before the fix | After |
|---|---|---|
| `test-perf-docs` "home on v4 reads no catalog it doesn't show …": at 0, 200 and 1,000 posts, no nav collections read (both menus custom) while both menus show, no rail count, one pins statement for 5 rails, one stats statement, an experiment read with no `*` and no `hypothesis`, no collection description | fails (nav collections read 1) | passes |
| `test-perf-docs` "a store without its own menus still lists the catalog's collections …": legacy with no release, legacy with a live v3 release, and a new legacy store with a header menu only each read the collections once; the `/collections/protein` link shows in header and footer, or in the footer only beside the header menu | passes (guards the fallback) | passes |
| `test-surfaces` "P2-PERF: home rails read all pins in one statement and keep the pinned order; no count is read": the batch equals the per-collection pins; a pinned rail shows the pinned product first, on two rails of the same collection; a missing collection gives none; one pins statement and no count for three rails; the collection page still counts 2; with no pins, Shopify order | fails (`collectionPinsByHandles` missing) | passes |
| `test-perf-tools`, the proxy test: a byte count for every shape, all above zero, adding up to no more than the bytes parsed | (new assertions; the field did not exist) | passes |

Each cut was also undone alone (script `mut2/run.py` in my scratch folder) and the suites run:

| # | Break | Caught by |
|---|---|---|
| B11 | the layout always reads the nav collections | test-perf-docs, the v4 catalog test |
| B12 | the rails keep the count | test-perf-docs and test-surfaces |
| B13 | pins read per rail | test-perf-docs and test-surfaces |
| B14 | the stats back to two statements | test-perf-docs |
| B15 | the experiment back to `selectAll` | test-perf-docs |
| B16 | the grid reads the description again | test-perf-docs |
| B17 | the nav collections skipped when only one menu is the store's own | test-perf-docs, the fallback test |

## The local numbers (real Next)

All five columns were taken again after fix round 2: one build (`IxZlyCgQffWdXqIxirCCi`) of commit `8868fbb`. `next build` then `next start` with the harness env, storefront on Next's local edge runtime, three local sqld, perf-dbcount proxies in front. Five counted runs per route, then 5 warm-up rounds and 50 timed rounds. Apple M5 Pro, Node 26.0.0, Next 16.2.9, sqld 0.24.32. Load average 3.3 to 4.8 at the start of each run (other agents shared the Mac). Every count was the same on all 5 counted runs and agreed with sqld's own query counter. Fix round 2 changed catalog reads legacy stores make too, so the legacy columns are not the code before phase 2 any more: the "before" for 5b is the PERF-04 baseline column.

Round trips / parsed from the database, per request (warm; 1 KB = 1,024 bytes):

| Route | PERF-04 baseline | Legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 24 / 648.7 KB | 12 / 637.5 KB | 21 / 55.4 KB | 14 / 49.2 KB | 14 / 49.3 KB | 14 / 49.3 KB |
| product | 10 / 637.7 KB | 8 / 631.0 KB | 18 / 46.4 KB | 10 / 39.0 KB | 10 / 39.1 KB | 10 / 39.1 KB |
| collection | 9 / 636.7 KB | 7 / 629.9 KB | 14 / 43.2 KB | 8 / 36.8 KB | 8 / 36.9 KB | 8 / 36.9 KB |
| policy page | 3 / 617.1 KB | 1 / 610.4 KB | 9 / 32.9 KB | 3 / 21.7 KB | 3 / 21.8 KB | 3 / 21.8 KB |
| `/journal` | 3 / 617.1 KB | 1 / 610.4 KB | 68 / 529.8 KB | 2 / 16.9 KB | 3 / 88.1 KB | 3 / 370.4 KB |
| checkout | 9 / 636.5 KB | 7 / 629.8 KB | 14 / 59.9 KB | 8 / 36.3 KB | 8 / 36.4 KB | 8 / 36.4 KB |
| `/sitemap.xml` | not measured | 65 / 38.5 MB | 190 / 627.8 KB | 4 / 68.3 KB | 5 / 139.6 KB | 5 / 421.8 KB |
| `/api/upsell` | not measured | 3 / 613.9 KB | 5 / 5.5 KB | 1 / 12.4 KB | 1 / 12.5 KB | 1 / 12.5 KB |
| `/offline` | not measured | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 17.0 KB | 2 / 17.0 KB |
| manifest | not measured | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 17.0 KB | 2 / 17.0 KB |

Exact parsed bytes at 200 and at 1,000 posts: home 50,502 and 50,519; policy page 22,346 and 22,349; checkout 37,277 and 37,285; `/api/upsell` 12,825 and 12,826. These few bytes are not content: the cart routes, which read no content, move the same way between runs (`cart-get` 9,925 and 9,928 bytes), from variable-length numbers in each database answer. From 0 to 200 posts each v4 route grows once by about 112 bytes: the list's `indexes.journal` goes from null to one entry. The harness's live release list is 10,953 bytes at 200 and at 1,000 posts.

Total p50 in ms, warm (baseline / legacy v3 / v4 at 0, 200, 1,000): home 57.4 / 45.1 / 31.9, 31.7, 32.6; policy 28.8 / 25.4 / 14.6, 14.7, 15.2; `/journal` 29.7 / 27.3 / 13.4, 24.6, 72.2; sitemap – / 957.3 / 7.4, 10.8, 18.8. The full tables (p95, all 15 routes) are in `docs/perf/2026-11-phase2-local.md`.

## Acceptance

"Break" refers to "Do the tests bite?". Before this item the suite was a placeholder that printed `pending`, so each unit test below is new; the breaks show each one fails when the property it checks is broken.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | unit: the documents fixture builder is deterministic (same hash on two runs) | **Pass** | "the documents fixture builder is deterministic …": a second in-process build gives the same hash, types, singleton ids and slugs; `node scripts/perf-docs-fixture.js hash --posts 200` in two separate processes gives the same hash as this process; counts are 8 singletons, 21 pages, 4 campaigns and N posts; different post counts give different hashes. Break B1 (the layouts' protected section left with `emptyBody`'s random id) fails it |
| 2a | unit (request-cache stub): home and policy issue at most 3 content statements at 0, 200 and 1,000 posts | **Pass** | "home (the REAL layout, its metadata and the home page) …": 3 at every count (the pointer and list, the chrome set, the home set), the same statements at each count, no `cms_state` read. "a policy page (the REAL layout plus the policy page module, metadata included) …": 3 at every count (pointer, its own version, the chrome set), never the journal index. Breaks B2, B5, B6 |
| 2b | unit (request-cache stub): identical read bytes across post counts | **Pass** (fix round 1) | "home and policy: every version body read is byte-identical at 0, 200 and 1,000 posts …" (break B2), and "home and policy: the pointer read, and every content statement, returns identical bytes at 200 and 1,000 posts; at 0 posts the only difference is the journal index entry itself". Home's pointer read is 12,174 bytes at 200 and at 1,000 posts, its content bytes 20,569 at both. At 0 posts the list holds `indexes.journal: null` instead of one entry, which the test checks to the byte (112 bytes): a fixed difference, not one that grows with posts. The test fails on the code before the fix (B8) |
| 3 | unit: footer links and checkout policy links issue no version-body reads | **Pass** | "the footer (the REAL layout's chromeData) reads only the chrome set, and the REAL checkout's policyLinks reads no version at all …", at 0, 200 and 1,000 posts: the layout makes one version read and every id in it is a chrome version; the footer and checkout show the policy link; checkout reads no version; neither reads the journal index or any page body. Breaks B2, B4 |
| 4 | unit: sitemap.xml and /journal read the journal index once at 200 and 1,000 posts, with no per-post reads | **Pass** | "the REAL sitemap.xml and /journal read the journal index once …": the only version read is the index (`[[index version]]`), 2 content statements, and N posts listed by each. Breaks B3, B7 |
| 5a | local (perf-dbcount through real Next): per-route round trips and parsed bytes recorded before and after | **Pass (recorded)** | `docs/perf/2026-11-phase2-local.json` and `.md`: home, product, collection, policy, checkout, `/journal` and `/sitemap.xml` (and 8 more routes) on legacy with a live v3 release (before), legacy with no release, and v4 at 0, 200 and 1,000 posts, next to the PERF-04 baseline |
| 5b | local: home parsed bytes drop from about 649 KB to under 50 KB | **Pass** (fix round 2) | 648.7 KB before (PERF-04 baseline, 664,223 bytes). After fix round 2, through real Next on one build of `8868fbb`: 50,391 bytes (49.2 KB) on v4 at 0 posts, 50,502 (49.3 KB) at 200 and 50,519 (49.3 KB) at 1,000, stable over 5 counted runs and checked against sqld. 1 KB = 1,024 bytes, as in the baseline's 648.7 KB; the limit is 51,200 bytes, so the margin is about 680 bytes. Everything home parses is counted, catalog included. The catalog statements are pinned by the new unit tests (see "Fix round 2") |
| 5c | local: the sitemap shows no per-post reads | **Pass** | `/sitemap.xml` on v4: 4 round trips at 0 posts, 5 at 200 and at 1,000 (the extra one is the journal index), stable over 5 counted runs. The legacy sitemap, for comparison, makes 65 |

### Requirements

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| PERF-01 | Read counts per request on the perf fixture at 0, 200 and 1,000 posts, unit and real Next: home 3 content statements, policy 3, checkout and footer no page body, sitemap and `/journal` one index read and no per-post read. Bytes independent of the post count (fix round 1): identical in the unit test at 200 and 1,000 posts; through real Next within 30 bytes of answer noise. Home under 50 KB, catalog included (fix round 2) | Hosted numbers: owner check |

## Findings

1. **Fixed in round 1: the release list grew with every journal post.** `publish.js` gave every post a `list.documents` entry as well as its row in the journal index, so every v4 request paid about 132 bytes per post (home 198.7 KB at 1,000 posts). Posts are now listed through the journal index only, and the four places that used a post's list entry read the index row instead. See "Fix round 1".
2. **The sitemap reads the pointer twice on v4.** It is a route, so `cache()` does not dedupe `resolvedContentPageList()` and `resolvedJournalEntries()`. Under the unit stub it is 2 content statements; through real Next it is 3. After fix round 1 each pointer read is about 11 KB, so the second one costs little.
3. **The legacy sitemap is very expensive, and was before phase 2.** With a live v3 release it makes 65 round trips and parses 38.5 MB per request (the 594 KB snapshot 63 times), 917 ms p50 locally. Each post goes through `resolvedContentPage`, and each call reads the release again because `cache()` does nothing in the sitemap route. P2-READ kept that loop unchanged on purpose (legacy output identical to `a6d028e`). The PERF-04 baseline never measured the sitemap. A PERF-03 or PERF-06 candidate.
4. **The cms_state read on legacy stores with no release** (plan sections 2 and 6, decision 15): one extra statement per page request (home 32 round trips, of which 1 is `SELECT mode FROM cms_state`; the unit test shows exactly 1 on home and on a policy page, and 0 on a store with a live release). Where `cache()` does nothing, it is paid per getter call: the sitemap makes 63 `cms_state` reads per request (plus 63 pointer reads, which were there before), and `/api/upsell`, `/offline` and the manifest one per call. The statement returns 12 bytes.
5. **An unlisted slug on v4 reads the journal index** (plan section 6): a code default page, or any 404 under `/policies/`, reads the whole index once before giving up. Unit bytes: nothing at 0 posts, 72.3 KB at 200, 361.3 KB at 1,000. So every 404 on a store with 1,000 posts parses about 0.37 MB. Real Next was not measured for this (the report only measures 200 answers; the harness store has no code default pages, which are the brand tenant's only). The unit test "REPORTED: on v4, a slug that is not a listed page …" pins one index read per request.
6. **Route handlers** (`/api/upsell`, `/offline`, `/manifest.webmanifest`) on v4: one pointer read per call, plus the chrome set for `/offline` and the manifest; nothing is shared between calls. The unit test calls each twice and sees two pointer reads. Each call parses the list (about 11 KB, at any post count after fix round 1).
7. **The v4 product page** reads its layout version, and with no hand-picked pairs on v4 (plan decision 9) it runs the automatic "Pairs well with" query: 10 round trips and 2,415 rows read, against 8 and 65 on legacy with a live release (after fix round 2, which dropped the nav collections read on both). This is expected until OVL.
8. **`/journal` lists every post**, so at 1,000 posts it parses 370 KB and sends about 930 KB of HTML (72.2 ms p50). This is not new (the page has no paging), and it is bounded by the post count by design.
9. **Fixed in round 2: home read catalog it never showed** (acceptance 5b). See "Fix round 2". Legacy stores gain too: legacy home with a live v3 release went from 23 round trips to 12, and every storefront page of a store with both menus skips the nav collections read (about 6 KB).
10. **Home's 50 KB margin is small** (about 680 bytes on the perf fixture). The rest of home is the rails' product rows (18.2 KB for 40 cards), the release list (12.7 KB) and the home and chrome versions (9.6 KB), all of which a shopper sees. A store with more sections, longer menus or more pages will be above 50 KB: the target is met for the perf fixture, not for every store. Merging the five rails into one statement (about 2 KB of column headers and framing) is the next cut if one is wanted; it is not done here.

## Do the tests bite?

Each break was applied alone, the suite run, then the file restored (script in my scratch folder, `mut/run.py`).

| # | Break | Caught by |
|---|---|---|
| B1 | the layouts' protected section keeps `emptyBody`'s random id | the determinism test |
| B2 | `resolvedContentPageList()` also loads the journal index on v4 | home count, policy count, version bytes, footer and checkout (4 tests) |
| B3 | the sitemap reads each post after listing it | the sitemap and `/journal` test |
| B4 | checkout's `policyLinks` reads every page body | the footer and checkout test |
| B5 | `cms_state` read on every request, release or not | home, policy, sitemap, legacy cms_state, route handlers (5 tests) |
| B6 | the home page reads every listed page's body | the home count |
| B7 | `/journal` reads each post | the sitemap and `/journal` test |
| B8 | (round 1) the code before the fix: posts kept in `list.documents` | the identical-bytes test in `test-perf-docs`; in `test-publish-service` the list-size, skip, inherited-rule and `liveListHoldsMine` tests |
| B9 | (round 1) the naive fix: post entries dropped, nothing else changed | in `test-publish-service` the skip, inherited-rule, lost-check and `liveListHoldsMine` tests (the lost check alone with `commit.js` fixed) |
| B10 | (round 1) the CLI check back to the `file://` string compare | "the CLI runs from a checkout whose path has a space …" |
| (earlier) | route ids minted at random when the builder still carried backfill ids | the determinism test (the builder no longer assigns route ids) |

## Tests

- `scripts/test-perf-docs.js`: 14 tests (2 new in round 2), 2.4 s in the gate. It prints its measured figures on one line at the end (`measured: {...}`), which is where the unit byte numbers above come from.
- `scripts/test-publish-service.js`: 26 tests (5 new in round 1), 1.4 s in the gate.
- `scripts/test-surfaces.js`: 16 tests (1 new in round 2).
- `scripts/test-perf-tools.js`: 26 tests; round 2 added the per-statement byte assertions to the proxy test.
- `pnpm test`: 66 of 66 suites passed in 118.7 s (round 2). `next build` passed (through `perf-report http --build`).

## Known limits

- **Home is under 50 KB with a small margin** (about 680 bytes, finding 10), on the perf fixture only. A store with more on its home page can be above it.
- **A store without its own header or footer menu now reads the catalog's collections one database trip later** (fix round 2): the layout needs the chrome first to know whether the fallback list is shown. Its pages are the same; only the timing moves, by up to one database round trip (hosted, one Turso trip). Stores with both menus skip the read altogether. Not measured: the perf harness store has both menus in every column, so no run here shows a store without them (owner check 2).
- **The home rails' pins are read in one statement**, but still from the draft table (`collection_overrides`), as before: the rails never used release-frozen pins, and this round does not change that.
- **The legacy columns were taken again on the round 2 build**, because round 2 changed catalog reads legacy makes too. The "before" for 5b is the PERF-04 baseline.
- **The real-Next byte figures at 200 and 1,000 posts differ by up to 30 bytes**, as routes that read no content do between runs. The unit test is the exact proof.
- **Older-style v4 lists** (a post with its own `list.documents` entry) are read and cleaned per post on its next publish, not all at once. No real store has one.
- **Fix round 1 touched P2-PUBLISH's files** (`lib/documents/publish.js`, `lib/documents/commit.js`, `scripts/test-publish-service.js`), as the review asked.
- **Unit stores have a one-product catalog.** Unit counts are content statements; catalog reads are measured only through real Next.
- **Real-Next numbers are one run per state** on a shared Mac. Counts and bytes are firm (stable over 5 counted runs and checked against sqld); times are a local guide only.
- **No 404 or default-page numbers through real Next** (finding 5): the unit test stands for them.
- **`doc_cart` is not in the fixture**, so `/api/upsell` on v4 answers an empty slot; the PERF-04 store has a cart upsell placement. The read cost is the pointer either way (the cart version would add one small read).
- **Route ids differ between runs** (the write service mints them). The builder's hash covers the bodies, types, slugs and singleton ids. Byte counts are unaffected (every random id has the same length).
- **The harness takeover clears the seeded v3 pointer** on the harness store only; re-seed (`node scripts/dev-design.js seed --fixture perf`) to get the legacy store back.
- `perf-http.js` and `perf-dbcount.js` are not in the plan's file list for this item. The changes are additive (three options, five more fixture-size fields and, in round 2, per-statement bytes), needed to measure the sitemap, the route handlers and where home's bytes go through the same tool.
- **Round 2 touched files other items own** (`app/(storefront)/layout.js`, `lib/repo.js`, `lib/cms/section-data.js`, `lib/experiments.js`), because the 5b target counts catalog reads.

### From review

Non-blocking findings from the independent review, added at merge.

- The earlier blocker is closed. Acceptance 5b is now met through real Next. I rebuilt 5f8f549 in a detached worktree (removed afterwards) on ports 3720 and 4720 to 4729, with the perf fixture published as v4 at 1,000 posts. Home made 14 round trips and parsed 50,518 bytes, which matches the packet (50,519). The status was 200 with x-edge-runtime: 1. Per statement: rails 18,198, pointer and list 12,688, versions 4,465 + 5,143, newest 3,622, grid 1,955, experiment 873, collection names 702, pins 424, stats 296. The sitemap made 5 round trips with no per-post reads, the policy page 3, checkout 8. The target is read as KiB, and that matches the acceptance's own 'about 649 KB': the baseline home is 664,223 bytes, which is 648.7 KiB. So 'under 50 KB' means under 51,200 bytes. The margin is only about 680 bytes, and it was measured on the perf fixture only. In decimal KB, home is 50.5 KB. The packet states all of this (finding 10). The owner may want to know that one more hero sentence or rail product would push it over.
- pnpm test at 5f8f549: 66 of 66 suites passed in 118.1 s.
- Fix round 2 changes catalog reads on every store, legacy included. I checked each against what shoppers see. In layout.js, the nav-collections skip uses the same Array.isArray(nav) test that Header.js and Footer.js use for their fallback, so nothing shoppers see changes. getFeaturedCollections drops description, which neither CollectionCard nor any section reads. runningExperimentFor keeps slug, name, variants and salt, which is everything heroVariantFor and assignVariant use, and the salt column was already selected at experiments.js:422. collectionPinsByHandles matches collectionPinsByHandle: collection_overrides has collection_id as its primary key, so each collection has at most one row. Home rails used draft pins before this round too, so that behaviour is unchanged. withTotal:false is used only by the home rails, and the collection page still counts. No node: imports were added to storefront code.
- Test gap: nothing checks the values of the getCatalogStats rewrite. I swapped the products and collections columns, which puts a wrong 'N products · M collections' hero badge in front of shoppers. test-copy, test-surfaces, test-perf-docs, test-release-readers, test-growth and test-preview-experiments all still passed. I also made the stats query count collections twice, and test-perf-docs still passed. The code as written is correct (the aliases match), but a regression here would go unnoticed. Add a test that the two counts are correct and in the right order.
- Test gap: nothing checks that each rail gets its own collection's pins. I gave every rail the first rail's pins (pinsByHandle.get(railHandles[0])), and test-surfaces and test-perf-docs still passed. The test-surfaces case uses rails on 'all', 'nope', 'all', and 'nope' has no products, so the mix-up never shows. Add a case with two rails on different collections, each with its own pins. Dropping the 24-pin cap in collectionPinsByHandles was not caught either (minor). Clearing all pins on the rails (pins: []) is caught by test-surfaces but not by test-perf-docs.
- Latency trade-off, documented in Known limits: a store without both menus of its own now reads the nav collections one round trip after chromeData, where before the two ran side by side. No run measures this, because the harness store has both menus. It belongs with the owner checks (packet owner check 2).
- The packet's mutation claims B11 to B17 were not all repeated here. The mutations I added are above. Removing salt or name from the experiment select is caught by test-preview-experiments (2 failed in each case).
- Merge note (batch 5 integration): merged after P2-SECTIONS, which makes a documents store read no pins (plan decision 9). On the v4 perf fixture the home's pins statement (424 bytes) is therefore gone, so home makes 13 round trips, not 14, and parses about 424 bytes less than the numbers above. Legacy stores keep the one batched pins read for every rail. scripts/test-perf-docs.js now expects 0 pins statements on v4 and at most 1 on legacy home. Real Next was not re-run after the merge.

## Owner checks

1. **Finding 1 (fixed in round 1)**: review the change to `publish.js` and `commit.js` as P2-PUBLISH's owner would; the reconcile rule for post versions (`liveListHoldsMine`) is proven by a unit test only, not by a hosted thrown-batch run.
2. **Hosted numbers (OQ-19)**: the same routes on a staging tenant in documents mode at 0, 200 and 1,000 posts. Hosted, each round trip is a network trip to Turso.
3. **Fix round 2 (5b)**: review the catalog cuts in `layout.js`, `repo.js`, `section-data.js` and `experiments.js` as their owners would. Optional: open home, a collection page and a policy page of the perf harness in desktop Chrome, on a store with both menus and on one without, and check the header and footer look as before. The 50 KB target is met on everything home parses, so no ruling on its meaning is needed now; the margin is small (finding 10).
4. **The legacy sitemap** (finding 3): 38.5 MB parsed per request on a store with a live release. Worth a PERF-03 or PERF-06 slot; real stores serve this to crawlers today.
5. **CI sqld** stands (P2-ATOM): `.github/` was not touched. `test-perf-docs` needs no sqld; the real-Next runs need sqld on the machine.
6. **DR-1, DR-2, DR-3** stand. No store must move to documents mode until the cutover gates in the plan are met.
7. Optional: open the v4 harness store in desktop Chrome after `publish --posts 1000` and look at home, a policy page, `/journal` and `/sitemap.xml`.

## Files

- `scripts/perf-docs-fixture.js` (new), `scripts/test-perf-docs.js` (replaces the placeholder)
- Fix round 1: `lib/documents/publish.js`, `lib/documents/commit.js`, `scripts/test-publish-service.js`
- Fix round 2: `app/(storefront)/layout.js`, `lib/repo.js`, `lib/cms/section-data.js`, `lib/experiments.js`, `scripts/perf-dbcount.js` (per-statement bytes), `scripts/test-perf-docs.js`, `scripts/test-surfaces.js`, `scripts/test-perf-tools.js`, `scripts/perf-docs-fixture.js` (the report's wording about perf-dbcount)
- `scripts/perf-http.js` (three options, more fixture sizes, per-statement bytes)
- `docs/perf/2026-11-phase2-local.json`, `docs/perf/2026-11-phase2-local.md` (new)
- `docs/cms-reviews/P2-PERF.md`

## Commands

```
pnpm test:perf-docs
pnpm test:publish-service
node scripts/perf-docs-fixture.js hash --posts 200

# real Next, own ports (stop any harness first)
export DESIGN_PORT=3620 DESIGN_SQLD_PORT=4620
node scripts/dev-design.js seed --fixture perf
node scripts/perf-report.js http --build --extra-routes --posts 60 --stem legacy-v3 --out <dir>
node scripts/dev-design.js seed --fixture perf && node scripts/perf-docs-fixture.js unpublish-legacy
node scripts/perf-report.js http --extra-routes --posts 60 --stem legacy-no-release --out <dir>
# for N in 0 200 1000:
node scripts/dev-design.js seed --fixture perf && node scripts/perf-docs-fixture.js publish --posts N
node scripts/perf-report.js http --extra-routes --posts N --stem docs-N --out <dir>   # add --build to the first run after a code change
# the combined report
node scripts/perf-docs-fixture.js report baseline=docs/perf/2026-11-03-local-baseline.json "Before: legacy, v3 live|legacy store, live v3 release (the perf seed)|60=<dir>/legacy-v3.json" "Legacy, no release|legacy store before its first publish|60=<dir>/legacy-no-release.json" "v4, 0 posts|documents store, v4 list|0=<dir>/docs-0.json" "v4, 200 posts|documents store, v4 list|200=<dir>/docs-200.json" "v4, 1,000 posts|documents store, v4 list|1000=<dir>/docs-1000.json"
```

The `report` command writes the tables; the "What the numbers say" section of `2026-11-phase2-local.md` was added by hand after it.
