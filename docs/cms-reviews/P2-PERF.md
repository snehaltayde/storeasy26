# P2-PERF: measuring the version 4 read path

Branch `cms/p2-perf`, cut from `f893710`. Plan: `docs/cms-reviews/P2-PLAN.md` (decision 5, batch 5, sections 2, 3, 4 and 6). Spec: PERF-01 (section 7), section 8.7. Harness: `docs/cms-reviews/P1-HARNESS.md`. Builds on P1-PERF-04 (the perf fixture, `perf-report`, `perf-dbcount`), P2-VGATE (the request-cache stub), P2-READ (the v4 reader) and P2-PUBLISH (`publish.js`). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:perf-docs` 11 passed, 0 failed (about 2 s). `pnpm test`: 66 of 66 suites passed in 117.1 s. 9 deliberate breaks, all caught (see "Do the tests bite?"). `pnpm build` passed, with only the 2 `next.config.mjs` trace warnings that were already there. Real-Next numbers taken on the design harness (ports 3620 and 4620 to 4628) |
| Browser verified | **NOT DONE.** No acceptance item here needs a browser. The real-Next runs did check every measured response: status 200, not the error page, the expected words on the page, and `x-edge-runtime: 1` on every storefront page |
| Staging verified | **NOT DONE. Staging is unverified.** No hosted numbers (OQ-19) |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real store changed mode. Nothing in `app/`, `lib/` or `components/` changed |

No real store moves to documents mode. Only the unit test's own stores and the harness store (for the length of a run) are put in documents mode.

## What and why

P2-READ made shoppers read a v4 release as a small list of document versions, so that a page reads only what it shows (PERF-01). Its unit tests counted statements on a hand-built list. This item measures the same thing on the perf fixture, published through the real publish service, at 0, 200 and 1,000 journal posts, both under the request-cache stub and through a real Next production build. It also reports the extra costs the plan asked for: the `cms_state` read that legacy stores with no release now pay, the journal-index read of an unlisted slug, and the route handlers whose `cache()` does nothing.

**The headline:** the whole-release read is gone (home parses 59.9 KB from the database instead of 648 KB), and the read counts hold: home and a policy page make 3 content statements, checkout and the footer read no page body, the sitemap and `/journal` read the journal index once. **But every v4 request grows with the number of journal posts**, because the publish service lists each post in the release list (finding 1). At 1,000 posts home parses 198.7 KB. Two acceptance items are therefore not met; see Acceptance.

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

## The local numbers (real Next)

One build (`es8ihdvIYpyRLktsdJvbC`) of commit `f893710`, `next build` then `next start` with the harness env, storefront on Next's local edge runtime, three local sqld, perf-dbcount proxies in front. Five counted runs per route, then 5 warm-up rounds and 50 timed rounds. Apple M5 Pro, Node 26.0.0, Next 16.2.9, sqld 0.24.32. Load average 3.6 to 4.5 at the start of each run: other agents shared the Mac, so treat small time differences as noise. Every count was the same on all 5 counted runs and agreed with sqld's own query counter.

Round trips / parsed from the database, per request (warm):

| Route | PERF-04 baseline | Legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 24 / 648.7 KB | 23 / 648.2 KB | 32 / 66.0 KB | 25 / 59.9 KB | 25 / 87.7 KB | 25 / 198.7 KB |
| product | 10 / 637.7 KB | 9 / 637.2 KB | 19 / 52.7 KB | 11 / 45.2 KB | 11 / 73.1 KB | 11 / 184.0 KB |
| collection | 9 / 636.7 KB | 8 / 636.2 KB | 15 / 49.4 KB | 9 / 43.0 KB | 9 / 70.9 KB | 9 / 181.8 KB |
| policy page | 3 / 617.1 KB | 2 / 616.6 KB | 10 / 39.2 KB | 4 / 28.0 KB | 4 / 55.8 KB | 4 / 166.7 KB |
| `/journal` | 3 / 617.1 KB | 2 / 616.6 KB | 69 / 536.1 KB | 3 / 23.2 KB | 4 / 122.1 KB | 4 / 515.3 KB |
| checkout | 9 / 636.5 KB | 8 / 636.0 KB | 15 / 66.2 KB | 9 / 42.5 KB | 9 / 70.4 KB | 9 / 181.3 KB |
| `/sitemap.xml` | not measured | 65 / 38.5 MB | 190 / 627.8 KB | 4 / 68.3 KB | 5 / 195.1 KB | 5 / 699.2 KB |
| `/api/upsell` | not measured | 3 / 613.9 KB | 5 / 5.5 KB | 1 / 12.4 KB | 1 / 40.3 KB | 1 / 151.2 KB |
| `/offline` | not measured | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 44.8 KB | 2 / 155.7 KB |
| manifest | not measured | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 44.8 KB | 2 / 155.7 KB |

Total p50 in ms, warm (baseline / legacy v3 / v4 at 0, 200, 1,000): home 57.4 / 51.8 / 43.4, 40.6, 50.0; policy 28.8 / 26.6 / 16.6, 17.9, 26.7; `/journal` 29.7 / 28.1 / 14.5, 26.9, 83.5; sitemap – / 917.3 / 7.9, 15.1, 42.4. The full tables (p95, all 15 routes, collection-all, collections, search, cart) are in `docs/perf/2026-11-phase2-local.md`.

The "legacy, v3 live" column is the "before" on this same build. It is one round trip below the PERF-04 baseline on every page that reads the release, because P2-VGATE reads the pointer and the release in one join.

## Acceptance

"Break" refers to "Do the tests bite?". Before this item the suite was a placeholder that printed `pending`, so each unit test below is new; the breaks show each one fails when the property it checks is broken.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | unit: the documents fixture builder is deterministic (same hash on two runs) | **Pass** | "the documents fixture builder is deterministic …": a second in-process build gives the same hash, types, singleton ids and slugs; `node scripts/perf-docs-fixture.js hash --posts 200` in two separate processes gives the same hash as this process; counts are 8 singletons, 21 pages, 4 campaigns and N posts; different post counts give different hashes. Break B1 (the layouts' protected section left with `emptyBody`'s random id) fails it |
| 2a | unit (request-cache stub): home and policy issue at most 3 content statements at 0, 200 and 1,000 posts | **Pass** | "home (the REAL layout, its metadata and the home page) …": 3 at every count (the pointer and list, the chrome set, the home set), the same statements at each count, no `cms_state` read. "a policy page (the REAL layout plus the policy page module, metadata included) …": 3 at every count (pointer, its own version, the chrome set), never the journal index. Breaks B2, B5, B6 |
| 2b | unit (request-cache stub): identical read bytes across post counts | **NOT MET** | The version bodies read are byte-identical at 0, 200 and 1,000 posts ("home and policy: every version body read is byte-identical …", break B2). The pointer read is not: it returns the release list, which holds one `documents` entry per published post, so it grows by about 142 bytes per post in the unit stores (12.1 KB at 0 posts, 40.6 KB at 200, 154.2 KB at 1,000). The test "MEASURED, not a pass of the PERF-01 byte claim …" pins exactly that cause: every post is in `list.documents`, and the list without them is the 0-post list. Break B8 (posts left out of `list.documents`) makes that test fail, so a fix will show. See finding 1 |
| 3 | unit: footer links and checkout policy links issue no version-body reads | **Pass** | "the footer (the REAL layout's chromeData) reads only the chrome set, and the REAL checkout's policyLinks reads no version at all …", at 0, 200 and 1,000 posts: the layout makes one version read and every id in it is a chrome version; the footer and checkout show the policy link; checkout reads no version; neither reads the journal index or any page body. Breaks B2, B4 |
| 4 | unit: sitemap.xml and /journal read the journal index once at 200 and 1,000 posts, with no per-post reads | **Pass** | "the REAL sitemap.xml and /journal read the journal index once …": the only version read is the index (`[[index version]]`), 2 content statements, and N posts listed by each. Breaks B3, B7 |
| 5a | local (perf-dbcount through real Next): per-route round trips and parsed bytes recorded before and after | **Pass (recorded)** | `docs/perf/2026-11-phase2-local.json` and `.md`: home, product, collection, policy, checkout, `/journal` and `/sitemap.xml` (and 8 more routes) on legacy with a live v3 release (before), legacy with no release, and v4 at 0, 200 and 1,000 posts, next to the PERF-04 baseline |
| 5b | local: home parsed bytes drop from about 649 KB to under 50 KB | **NOT MET** | 648.2 KB before; 59.9 KB on v4 with 0 posts, 87.7 KB at 200, 198.7 KB at 1,000. At 0 posts most of what is left is catalog reads that legacy makes too (a legacy store with no release parses 66.0 KB on home); the content reads are about 19 KB (the 10.8 KB list plus the chrome and home versions). The growth with posts is finding 1. The 50 KB target is reachable only once finding 1 is fixed and the catalog share is looked at (PERF-06) |
| 5c | local: the sitemap shows no per-post reads | **Pass** | `/sitemap.xml` on v4: 4 round trips at 0 posts, 5 at 200 and at 1,000 (the extra one is the journal index), stable over 5 counted runs. The legacy sitemap, for comparison, makes 65 |

### Requirements

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| PERF-01 | Read counts per request on the perf fixture at 0, 200 and 1,000 posts, unit and real Next: home 3 content statements, policy 3, checkout and footer no page body, sitemap and `/journal` one index read and no per-post read | **Bytes independent of the post count: not met** (finding 1). Hosted numbers: owner check |

## Findings

1. **The release list grows with every journal post, and every v4 request reads it.** `lib/documents/publish.js` (`makeBuild`) gives every document in a publish set a `list.documents` entry, journal posts included, as well as the `indexes.journal` version. `lib/documents/release-list.js` says the journal index exists "so the list stays the same size however many posts there are", and P2-READ's reader never uses a post's `list.documents` entry (it reads posts through the index). The pointer read returns the whole list on every request, so every v4 page, route handler and API that reads content pays about 132 bytes per post: 10.8 KB at 0 posts, 37.4 KB at 200, 143.0 KB at 1,000 on the harness. Effects measured: home 59.9 → 198.7 KB parsed, the policy page 28.0 → 166.7 KB and 16.6 → 26.7 ms p50, `/api/upsell` 12.4 → 151.2 KB, the sitemap pays it twice. **This is the PERF-01 byte claim failing**, so I record it as a blocker for any v4 store with a blog, not as a known limit. I did not fix it here: `publish.js` is P2-PUBLISH's file. Removing the post entries is one line (`for (const p of posts) delete list.documents[p.documentId]` after `setEntries`), and with that line `test:publish-service`, `test:release-readers`, `test:preview-overlay`, `test:documents` and `test:failure-matrix` all still pass. But it is not safe as it stands, because `publish.js` uses a post's list entry in four places, and none of them is tested for posts:
   - the "already live, skip" check (step 5);
   - the live body for the inherited-section rule (step 4);
   - the "someone else published this" check after a loss;
   - commit.js's `liveListHoldsMine` reconcile, which needs every version of the build in a list slot.

   Each must read the post's entry from the journal index instead. Owner: the orchestrator assigns it (P2-PUBLISH's area). When it lands, the "MEASURED" test in `test-perf-docs` fails, and acceptance 2b becomes a plain "identical bytes" assertion.
2. **The sitemap reads the pointer twice on v4.** It is a route, so `cache()` does not dedupe `resolvedContentPageList()` and `resolvedJournalEntries()`. Under the unit stub it is 2 content statements; through real Next it is 3. With finding 1, that is 2 × 143 KB at 1,000 posts.
3. **The legacy sitemap is very expensive, and was before phase 2.** With a live v3 release it makes 65 round trips and parses 38.5 MB per request (the 594 KB snapshot 63 times), 917 ms p50 locally. Each post goes through `resolvedContentPage`, and each call reads the release again because `cache()` does nothing in the sitemap route. P2-READ kept that loop unchanged on purpose (legacy output identical to `a6d028e`). The PERF-04 baseline never measured the sitemap. A PERF-03 or PERF-06 candidate.
4. **The cms_state read on legacy stores with no release** (plan sections 2 and 6, decision 15): one extra statement per page request (home 32 round trips, of which 1 is `SELECT mode FROM cms_state`; the unit test shows exactly 1 on home and on a policy page, and 0 on a store with a live release). Where `cache()` does nothing, it is paid per getter call: the sitemap makes 63 `cms_state` reads per request (plus 63 pointer reads, which were there before), and `/api/upsell`, `/offline` and the manifest one per call. The statement returns 12 bytes.
5. **An unlisted slug on v4 reads the journal index** (plan section 6): a code default page, or any 404 under `/policies/`, reads the whole index once before giving up. Unit bytes: nothing at 0 posts, 72.3 KB at 200, 361.3 KB at 1,000. So every 404 on a store with 1,000 posts parses about 0.5 MB with the list. Real Next was not measured for this (the report only measures 200 answers; the harness store has no code default pages, which are the brand tenant's only). The unit test "REPORTED: on v4, a slug that is not a listed page …" pins one index read per request.
6. **Route handlers** (`/api/upsell`, `/offline`, `/manifest.webmanifest`) on v4: one pointer read per call, plus the chrome set for `/offline` and the manifest; nothing is shared between calls. The unit test calls each twice and sees two pointer reads. Each call parses the whole list (finding 1).
7. **The v4 product page** reads its layout version, and with no hand-picked pairs on v4 (plan decision 9) it runs the automatic "Pairs well with" query: 11 round trips and 3,757 rows read, against 9 and 1,407 on legacy. This is expected until OVL.
8. **`/journal` lists every post**, so at 1,000 posts it parses 515 KB and sends 930 KB of HTML (83.5 ms p50). This is not new (the page has no paging), and it is bounded by the post count by design.

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
| B8 | posts left out of `list.documents` (the naive fix of finding 1) | the "MEASURED" test, by design |
| (earlier) | route ids minted at random when the builder still carried backfill ids | the determinism test (the builder no longer assigns route ids) |

## Tests

- `scripts/test-perf-docs.js`: 11 tests, about 2 s (2.1 s in the gate). It prints its measured figures on one line at the end (`measured: {...}`), which is where the unit byte numbers above come from.
- `scripts/test-perf-tools.js` is unchanged and passes (26) with the `perf-http.js` options added.
- `pnpm test`: 66 of 66 suites passed in 117.1 s. `pnpm build` passed.

## Known limits

- **Two acceptance items are not met** (2b and 5b), both because of finding 1. Nothing here hides it: the unit test asserts the growth and its cause.
- **The 50 KB home target includes the catalog.** At 0 posts the catalog reads (rails, menus, counts) are about 40 KB of home's 59.9 KB. They are the same on legacy, so the target cannot be met by the content path alone.
- **Unit stores have a one-product catalog.** Unit counts are content statements; catalog reads are measured only through real Next.
- **Real-Next numbers are one run per state** on a shared Mac. Counts and bytes are firm (stable over 5 counted runs and checked against sqld); times are a local guide only.
- **No 404 or default-page numbers through real Next** (finding 5): the unit test stands for them.
- **`doc_cart` is not in the fixture**, so `/api/upsell` on v4 answers an empty slot; the PERF-04 store has a cart upsell placement. The read cost is the pointer either way (the cart version would add one small read).
- **Route ids differ between runs** (the write service mints them). The builder's hash covers the bodies, types, slugs and singleton ids. Byte counts are unaffected (every random id has the same length).
- **The harness takeover clears the seeded v3 pointer** on the harness store only; re-seed (`node scripts/dev-design.js seed --fixture perf`) to get the legacy store back.
- `perf-http.js` is not in the plan's file list for this item. The change is additive (three options and five more fixture-size fields), needed to measure the sitemap and the route handlers through the same tool.

## Owner checks

1. **Finding 1**: decide who fixes the post entries in `list.documents` (with tests for the four places listed), and make it a gate before any real store publishes journal posts on v4.
2. **Hosted numbers (OQ-19)**: the same routes on a staging tenant in documents mode at 0, 200 and 1,000 posts, after finding 1 is fixed. Hosted, each round trip is a network trip to Turso, and each pointer read carries the list.
3. **The 50 KB home target**: decide whether it is meant for the content reads only (about 19 KB at 0 posts here) or for everything the page parses (catalog included).
4. **The legacy sitemap** (finding 3): 38.5 MB parsed per request on a store with a live release. Worth a PERF-03 or PERF-06 slot; real stores serve this to crawlers today.
5. **CI sqld** stands (P2-ATOM): `.github/` was not touched. `test-perf-docs` needs no sqld; the real-Next runs need sqld on the machine.
6. **DR-1, DR-2, DR-3** stand. No store must move to documents mode until the cutover gates in the plan are met.
7. Optional: open the v4 harness store in desktop Chrome after `publish --posts 1000` and look at home, a policy page, `/journal` and `/sitemap.xml`.

## Files

- `scripts/perf-docs-fixture.js` (new), `scripts/test-perf-docs.js` (replaces the placeholder)
- `scripts/perf-http.js` (three options, more fixture sizes)
- `docs/perf/2026-11-phase2-local.json`, `docs/perf/2026-11-phase2-local.md` (new)
- `docs/cms-reviews/P2-PERF.md`

## Commands

```
pnpm test:perf-docs
node scripts/perf-docs-fixture.js hash --posts 200

# real Next, own ports (stop any harness first)
export DESIGN_PORT=3620 DESIGN_SQLD_PORT=4620
node scripts/dev-design.js seed --fixture perf
node scripts/perf-report.js http --build --extra-routes --posts 60 --stem legacy-v3 --out <dir>
node scripts/dev-design.js seed --fixture perf && node scripts/perf-docs-fixture.js unpublish-legacy
node scripts/perf-report.js http --extra-routes --posts 60 --stem legacy-no-release --out <dir>
# for N in 0 200 1000:
node scripts/dev-design.js seed --fixture perf && node scripts/perf-docs-fixture.js publish --posts N
node scripts/perf-report.js http --extra-routes --posts N --stem docs-N --out <dir>
# the combined report
node scripts/perf-docs-fixture.js report baseline=docs/perf/2026-11-03-local-baseline.json "Before: legacy, v3 live|legacy store, live v3 release (the perf seed)|60=<dir>/legacy-v3.json" "Legacy, no release|legacy store before its first publish|60=<dir>/legacy-no-release.json" "v4, 0 posts|documents store, v4 list|0=<dir>/docs-0.json" "v4, 200 posts|documents store, v4 list|200=<dir>/docs-200.json" "v4, 1,000 posts|documents store, v4 list|1000=<dir>/docs-1000.json"
```

The `report` command writes the tables; the "What the numbers say" section of `2026-11-phase2-local.md` was added by hand after it.
