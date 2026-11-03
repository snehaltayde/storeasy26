# P1 · PERF-04 · Measure first, then set budgets (local baseline only)

Branch `cms/p1-perf04`, cut from `8968db3`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:2190-2199` (PERF-04), `:2211-2219` (PERF-06, which the candidates below feed), §8.15 test strategy (`:2845-2890`), OQ-11 (`:3191`) and OQ-19 (`:3197`).

This is the phase 1 part only: a fixture, a local baseline, and a budget check that has no real budgets yet. Hosted numbers and budgets need a hosted runtime (OQ-19), so **no budget is set or claimed from these numbers.**

This is the builder's own report. Reviewers should re-read the code.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, for the local baseline: the perf fixture, the HTTP report, the database-read counter, the budget check with a placeholder budget file, and the first baseline in `docs/perf/` |
| Locally tested | Yes. `pnpm test`: **52 of 52 suites passed, 1,200 tests, 0 failed**. New suite `test:perf-tools`: 26 passed, 0 failed. Mutation check: 27 breaks, 27 caught, plus one equivalent break that survived (explained below) |
| Browser verified | **Partly.** Desktop Chrome 156 (headless) on a production build of the design harness with the perf fixture: every measured page renders the fixture on the edge runtime (`drills/PERF-04/`, 61 passed, 0 failed, 10 known: finding 1). The measurement itself is not a browser test |
| Staging verified | **NOT DONE. Staging is unverified.** No hosted runtime exists (OQ-19). The spec's first acceptance item, hosted before and after numbers, is not met |
| Production enabled | **NOT DONE. Production is unverified.** Nothing pushed, merged or deployed. Nothing in `app/`, `lib/` or `components/` changed (`git diff 8968db3 --stat -- app lib components` prints nothing) |

## Evidence lines, opened before any change

- `scripts/perf-report.js` (the spec's evidence line). At `8968db3` it is library-level only: it calls `lib/repo.js` functions directly against a 5,000-product file database, with no HTTP, no Next and no edge runtime. Its thresholds (`measure(name, budgetMs, …)`, lines 90-106) printed as "budget 150ms" and so on, and it exits 1 when one is exceeded. Those are local numbers labelled as budgets, which the spec's negative item rules out.
- "No real tenant sizes were available to the mapping pass." Still true. No real tenant database was read for this item (OQ-11 is the owner's call).
- Also opened: `docs/cms-reviews/P1-HARNESS.md` and `scripts/design-harness.js` (how the harness starts `sqld` and records processes), `scripts/drills/p1/prod-harness.mjs` (the batch B production-build launcher), `lib/db.js` (the tenant database proxy, not changed), `lib/platform/control.js` (the control plane client, not changed), and `@libsql/hrana-client` 0.10.0 (`openHttp` defaults to protocol version 2, so the app talks Hrana v2 JSON to `sqld` over `/v2/pipeline`). This item has no bug to reproduce.

## What was built

1. **The perf fixture** (`scripts/perf-fixture.js`), a seeding option on the harness:
   ```
   node scripts/dev-design.js seed --fixture perf
   ```
   `buildPerfFixture()` is pure and deterministic: no clock, no `Math.random`, a seeded generator. `seedPerfFixture()` writes the store into the local tenant database. The catalog goes in as rows, the way a finished first sync leaves it. Content, offers, bundles, the quiz, pairs lists, badges and pins go through the same store functions the console uses, after the same validators. It then publishes, so the live storefront serves the fixture. It adds to the demo data and leaves the demo's 8 products, 3 collections, orders, experiments and console states in place.
2. **The HTTP report** (`scripts/perf-http.js`, run as `node scripts/perf-report.js http`). It builds (with `--build`, `next build` using the harness env), then starts its own `sqld` (with `sqld`'s admin API on) and `next start`, and measures 11 requests in three passes:
   - **counts**: Next talks to the databases through counting proxies;
   - **cold**: a fresh `next start` for each route, then one request;
   - **warm**: 5 warm-up rounds, then 50 timed rounds over every route in turn.

   Each response must be the real page (status 200, not the error page, the expected words), or the run stops. It writes `docs/perf/<date>-local-baseline.json` and `.md`.
3. **The database-read counter** (`scripts/perf-dbcount.js`). It is an HTTP proxy in front of each `sqld` that forwards every request and response byte for byte. On the way it counts round trips, statements by kind (read, write, schema, transaction), `sqld`'s own `rows_read`, rows returned, and bytes as sent and as parsed. It also counts reads that ran again with the same arguments in the same request. Nothing in the app changed, and `lib/db.js` is untouched (the database-retries branch rewrites it). Each counted request is checked against `sqld`'s own `query_count`.
4. **The budget check** (`scripts/perf-budget.js`; `node scripts/perf-report.js check <run.json> --budget <file>`, or `http --budget <file>`):
   - It fails (exit 1) when a number is over its budget, or when a budgeted number is missing from the run.
   - It refuses (exit 2) a budget file whose basis is `local`, and hosted budgets checked against a local run.
   - The shipped `docs/perf/budgets.json` holds **no budgets** and says why. `docs/perf/test-budget.json` is a test file with an impossible home page limit (1 ms) that proves the check fails.
5. **`node scripts/perf-report.js fixture`**: prints the seeded data's sizes and a content digest (timestamps and app-minted random ids left out), so two seeds can be compared.
6. **Library mode is unchanged in behaviour.** `pnpm test:perf` still runs its 5,000-product checks and still exits 1 over a threshold. Those thresholds now print as "local guard", not "budget", and its header says they are not budgets. It also prints the queue drain in jobs/s, where it used to say "ms".
7. **A browser drill** (`scripts/drills/p1/perf04.mjs`) for the measured pages on the production build.
8. **Harness plumbing** (`scripts/design-harness.js`):
   - `runHarness({ fixture })` passes `DESIGN_FIXTURE` to the seed and records `fixture` in `.design-data/seeded.json`;
   - `startSqld` is exported and takes `extraArgs`;
   - `writePidfile` and `clearPidfile` are exported, so the report records its processes the way the harness does, and a harness or seed started meanwhile is refused.

### The fixture: sizes, and why

| What | Size | Why |
|---|---|---|
| Products | 400 (the 8 demo products included) | A growing D2C brand's range: big enough for a missing index or an unbounded read to show |
| Variants | 1,142 (about 3 per product: flavour by size, or size only) | Product pages and the cart join variants |
| Product photos | 1,764 rows (3 to 6 per product), pointing at 24 library images | Product pages read photos |
| Collections | 30, from 400 products (`shop-all`) down to 8: 10 by product type (about 39 each), 16 themed (8 to 72) and the 3 demo ones; 1,253 memberships | Collection pages, `/collections` and the header menu read them |
| Content pages | 20 policy and info pages, 3 to 8 sections each (text, FAQ, rich HTML, image) | The live release carries every page |
| Journal posts | 60, 4 to 8 sections, about 1,000 words each | The same reason. A blog this size is common for a content-led brand |
| Campaign pages | 4, with a visibility window | Same |
| Home sections | 12 (4 product rails, plus a collections grid, new arrivals, banners, image-with-text and rich text) | Each section resolves its own data |
| Menus | Header: 6 items, 4 with 4 sub-items. Footer: 10 links | Validated like a founder's save |
| Offers | 5 added (tiered, buy-2-get-1, two coupons, free gift), 8 with the demo's 3, 12 in the table with the bundle offers | The cart runs the offer engine on every read |
| Bundles, quiz | 4 bundles (3 enabled), 1 quiz | Real store features |
| Pairs, badges, pins | 40 pairs lists plus a cart upsell, 24 badges with accordions, 5 collections with pins | They are in the release snapshot and on product and collection pages |
| Media | 32 library images, 4.1 MB, stored in the tenant database | Media is part of a real store's size |
| Measured cart | 3 lines, 4 items | Cart API and checkout |

**This is an engineering estimate, not real data.** It leans to the larger side of mid-size, so local numbers don't flatter the storefront. Real tenant sizes would be better, and reading them is the owner's decision (OQ-11, manual check 1). The library mode's 5,000-product catalog stays as the stress case.

The live release this fixture publishes is **594 KB** (`liveReleaseBytes` 607,929), because it carries all 85 pages, posts and campaigns. That number matters below.

## The baseline (`docs/perf/2026-11-03-local-baseline.md` and `.json`)

**Local numbers, not budgets.**
- Machine and software: Apple M5 Pro (15 cores, 24 GB), macOS 26.5.1, Node 26.0.0, Next 16.2.9, `sqld` 0.24.32.
- Build: `next build` then `next start`, build `nOsn1pbejWya3uI8uIgb6` from commit `8968db3`, with no app changes since.
- Data: fixture content digest `331b3929e7a67fe9`.
- Load average about 4.2 at start and at end. Other agents' work shared this Mac.

| Page | TTFB p50 / p95 ms | Total p50 / p95 ms | Cold total ms | Sent | gzip est. | DB reads (first request) | Round trips | Rows read | From DB as sent (parsed) |
|---|---|---|---|---|---|---|---|---|---|
| Home `/` | 56.2 / 83 | 57.4 / 85.3 | 710.8 | 222.7 KB | 20.4 KB | 24 (26) | 24 | 5,346 | 62.7 KB (648.7 KB) |
| Product (6 variants, 6 photos) | 32 / 46.8 | 37.6 / 54.8 | 417.7 | 84.9 KB | 13.0 KB | 10 (12) | 10 | 1,407 | 58.9 KB (637.7 KB) |
| Collection (Protein, 40 products) | 28.2 / 43.7 | 37.7 / 60.7 | 461 | 173.4 KB | 14.2 KB | 9 (11) | 9 | 1,794 | 57.1 KB (636.7 KB) |
| Collection (shop all, 400) | 27.9 / 45.4 | 40 / 62.8 | 392.9 | 198.9 KB | 19.1 KB | 9 (9) | 9 | 5,766 | 58.0 KB (639.0 KB) |
| `/collections` | 30.4 / 43.4 | 31.3 / 45 | 391.5 | 114.2 KB | 12.2 KB | 4 (6) | 4 | 2,686 | 55.1 KB (623.4 KB) |
| Search `?q=protein` | 31.8 / 42.1 | 33.6 / 42.7 | 419 | 157.1 KB | 14.7 KB | 4 (6) | 4 | 1,797 | 55.2 KB (628.0 KB) |
| CMS page (refund policy) | 27.4 / 35.1 | 28.8 / 36.8 | 370.9 | 53.5 KB | 9.2 KB | 3 (5) | 3 | 1,344 | 54.1 KB (617.1 KB) |
| Journal index (60 posts) | 28.4 / 34 | 29.7 / 35.7 | 384.1 | 90.4 KB | 12.1 KB | 3 (5) | 3 | 1,344 | 54.1 KB (617.1 KB) |
| Cart API read (3 lines) | 4.6 / 6.8 | 4.7 / 6.8 | 383.5 | 1.6 KB | 650 B | 3 (5) | 3 | 29 | 2.2 KB (9.7 KB) |
| Cart API, change a quantity | 5.7 / 7.9 | 5.8 / 8 | 328 | 1.6 KB | 650 B | 3 (3) + 2 writes | 5 | 31 | 2.6 KB (10.3 KB) |
| Checkout, first step | 35.7 / 51.3 | 37.3 / 52.9 | 427.3 | 55.0 KB | 9.7 KB | 9 (11) | 9 | 1,402 | 58.4 KB (636.5 KB) |

The committed markdown has the exact figures and the static JS and CSS a first visit downloads (about 306 KB as sent, 15 files). The JSON has every statement shape with its count and rows read.

### Method

- **Runs.** 5 warm-up rounds, then 50 timed rounds. Each round requests every route once, in turn, one request at a time, over one kept-alive connection. p50 and p95 use the nearest rank: p95 of 50 is the 48th fastest.
- **TTFB and total.** TTFB runs from sending the request to the response headers. Total runs to the last byte.
- **Cold.** A fresh `next start` for each route, then that route's first request on a new connection. That is one sample per route.
- **Bytes.**
  - "Sent" is the body as the local server sent it. Local `next start` sent the edge-runtime responses **uncompressed** (finding 2), so "gzip est." gzips the same body here, as a rough guide to what a compressing CDN sends.
  - Headers are counted apart.
  - First-visit static files are the `/_next/static` URLs the page names, fetched once each. Images are not fetched.
- **Database reads.** 5 counted runs per route through the counting proxies, plus the route's first request after start (in brackets). A round trip is one HTTP request from the page to `sqld`. Every one of the 11 routes was stable across its 5 runs, and agreed with `sqld`'s own `query_count` for each of the three databases.
- **The shopper.** No cookies except the cart cookie on the cart and checkout routes, so the home page sees a first-time visitor. Each request carries its own `x-forwarded-for`, so 50 cart changes in a minute don't trip the in-memory limiter of 60 a minute per address.
- **The edge runtime.**
  - Every page response carries `x-edge-runtime: 1` (recorded in the JSON's `responseHeaders`).
  - The production `.next/server/middleware-manifest.json` lists `/api/cart/route` and all 9 page routes as edge functions built from `server/edge/` chunks.
- **Edge memory is not measurable locally.** Next's local edge sandbox runs inside one Node process, so no per-isolate memory figure exists here. It needs the hosted runtime (OQ-19). The JSON says so under `notMeasured`.

### How much the numbers move

A second full run straight after (same build, same data, written to scratch, not committed):
- **Read counts, round trips and rows read:** identical on all 11 routes.
- **Bytes:** identical, except the home page (about 60 bytes, from the random experiment variant) and ±2 bytes from the database (the timings inside `sqld`'s answers).
- **Total p50:** within 10% on every route.
- **p95:** up to 23% apart.
- **Cold:** up to 34% apart.

So read counts and bytes are firm. p50 is a fair local guide. p95 and cold are rough. An earlier run, before the fixture's variant fix (below), gave the same picture.

### Candidates for PERF-06 (not fixed here)

1. **Every storefront page parses the whole live release.**
   - `select * from releases where id = ?` runs on every page. It returns the 594 KB snapshot (all 85 pages, posts and campaigns), so a policy page parses about 617 KB from the database to show one page. Gzip makes that about 54 KB as sent from local `sqld`.
   - It is the biggest per-request cost by bytes, on every page.
   - This is PERF-03's cache target, and the spec's "Transfer is unmeasured" (`:3316`), now measured.
2. **The layout reads every collection with its product count on every page.** The header menu's query (`select c.handle, … count(cp.product_id) … group by`) reads 1,342 rows on each request. `/collections` runs it twice, for 2,684 rows.
3. **The home page makes 24 reads, each its own round trip.**
   - Each of the 5 product rails costs 3 reads (count, products, pins).
   - The rest: newest products, featured collections, the layout's collections, two catalog counts, collection ids, the running experiment, the release pointer and the release.
   - Hosted, each round trip is a network trip to Turso, unless the reads run in parallel.
4. **The same read twice in one request, with the same arguments:**
   - **Product page:** the product, its photos and its variants each run twice (`generateMetadata` and the page). This is PERF-06's first acceptance item, now measured at 3 repeated reads.
   - **Collection pages:** the collection itself, twice.
   - **Checkout:** the cart, its lines and the enabled offers, each twice.
   - **`/collections`:** the collection list, twice.
5. **Rows grow with collection size, even for a 48-product page.** On the 400-product collection, the type facets read 1,617 rows, the products 1,601 and the count 1,201.
6. **Slowest pages.**
   - Warm: home (57.4 ms p50, 85.3 ms p95), then shop-all (40 ms), product and the category collection (37.6 to 37.7 ms) and checkout (37.3 ms).
   - Cold: 328 to 711 ms. The local edge sandbox loading the route dominates, and cold varies ±34% between runs.

Not measured here: the quiz and bundle pages, and `/api/upsell` (PERF-06's other evidence lines). Adding them is a few lines in `routesFor()`.

## Acceptance

Tags: **unit** = `test:perf-tools` (plain node). **manual** = run by me on this Mac with the exact command shown. **browser** = desktop Chrome through the P1 drill runner on the design harness. Nothing is tagged rendered.

### The spec's items (PERF-04)

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| S1 | Before and after numbers exist on the hosted runtime | manual (owner) | **Not met.** Needs OQ-19 | Local "before" numbers exist (`docs/perf/2026-11-03-local-baseline.*`). There are no hosted numbers, before or after. Manual checks 2 and 3 |
| S2 | Budgets are written down, and fail a check when exceeded | unit + manual | **The check: pass. The budgets: deliberately not written**, because they wait for hosted numbers | Unit: "a run within every budget passes", "NEGATIVE: one number over its budget fails the check, and names it", "NEGATIVE: every metric a budget can name is checked", "NEGATIVE: a budgeted number the run doesn't have fails, never passes", "the check command: the test budget fails the committed baseline (exit 1)…". Manual: `check … --budget docs/perf/test-budget.json` gives `OVER home ttfb.p95: 83 > 1`, exit 1. `http --only home,product,cart-get … --budget docs/perf/test-budget.json` gives `OVER home ttfb.p95: 73.9 > 1`, exit 1 |
| S3 | Negative: no budget is claimed from local measurements alone | unit + manual | **Pass** | Unit: "NEGATIVE: the shipped budget file holds no budget…", "NEGATIVE: no file in docs/perf claims a budget from local numbers", "NEGATIVE: a budget file that says its numbers came from a local run is refused", "NEGATIVE: hosted budgets are not checked against a local run", "NEGATIVE: library mode's thresholds are printed as local guards, never as budgets", "the markdown says plainly that these are local numbers, not budgets". Manual: `check … --budget docs/perf/budgets.json` prints "No budgets are set yet … Nothing was checked." and "not checked: no budgets yet", exit 0, with no "within budget" claim. A file with `"basis": "local"` is refused with "PERF-04 sets budgets only from hosted numbers", exit 2. The baseline JSON's `budgets` field is "None. Budgets wait for hosted numbers…" |

### The brief's items

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| B1 | A fixture sized like a mid-size D2C store, with reasons | unit + manual | Pass | Table above; `PERF_FIXTURE` and `RATIONALE` in `scripts/perf-fixture.js`. Unit: "the fixture has the agreed sizes", "the fixture is internally whole…" (unique handles and ids, no two variants of a product with the same options, every collection member, rail, menu link and photo exists), "the fixture passes the same validators a founder's saves pass", "the measured product reads everything a product page can…" |
| B2 | Built as a seeding option on the harness | manual | Pass | `DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/dev-design.js seed --fixture perf` printed "perf fixture: products 400, variants 1142, productImages 1764, collections 30, collectionMemberships 1253, contentPages 20, journalPosts 60, campaigns 4, homeSections 12, offersAdded 5, bundles 4, quizzes 1, placements 41, productOverrides 24, pinnedCollections 5, media 32 (2.1s)" and "✓ design harness seeded with the perf fixture" |
| B3 | Repeatable | unit + manual | Pass | Unit: "the fixture is the same store every time (deterministic, no clock, no randomness)". Manual: two seeds in a row both gave `contentDigest` `331b3929e7a67fe9` (`node scripts/perf-report.js fixture`). Before the digest left out app-minted random ids, the demo's shipping page section id made two seeds differ. That was found and handled, so the fixture itself was never the cause |
| B4 | Negative: local only, never touches Shopify | unit + manual | Pass | Unit: "NEGATIVE: the fixture never talks to Shopify or the network" (no import of Shopify, sync, platform or network code; no `fetch`, no `SHOPIFY_`, no `process.env`). The existing seed check still refuses any non-local database URL (`test:design-harness`, 46 passed). Manual, with a recorder of every outbound TCP connection and DNS lookup loaded into each Node process: the seed made 11 connections, all to `127.0.0.1` or `::1` on 18220 to 18222. Control: the recorder logs `shop.example.invalid:80`, its DNS lookup and `192.0.2.1:9` when a process tries them |
| B5 | Negative: an unknown fixture is refused before any database opens | unit | Pass | "NEGATIVE: an unknown fixture is refused with a plain message before any database opens": the builder, the seed script (`There is no "huge" fixture`, exit 1) and `dev-design.js seed --fixture huge` (exit 1, before the port checks). `--fixture` with no name is a usage error (exit 2) |
| B6 | Real tenant sizes recorded as the owner's decision (OQ-11) | manual (owner) | Recorded | Manual check 1. The fixture table says it is an estimate |
| B7 | `perf-report.js` measures home, a product, a collection, `/collections`, search, a CMS page, the cart API and checkout's first step | manual + unit | Pass | The 11 routes in the table (two collections, two cart calls, and the journal index added). Unit: "each measured route is the real page, or the run stops…" (route list, plus the checks below) |
| B8 | Against a production build on the edge runtime with local `sqld` | manual + browser | Pass | `next build` (exit 0), then `next start`. Edge proof: `x-edge-runtime: 1` on every page response in the JSON; the production middleware manifest lists all 10 route files as edge functions; the drill checks `x-edge-runtime` on each page in Chrome |
| B9 | TTFB and total, p50 and p95 over a stated number of warm runs, plus one cold run | manual + unit | Pass | 5 warm-up, 50 timed and 1 cold per route (method above). Unit: "p95 is the nearest rank…" |
| B10 | Bytes sent | manual | Pass | The "Sent" and "gzip est." columns, headers counted apart, first-visit static files. Finding 2 explains why "Sent" is uncompressed locally |
| B11 | Database reads per request, through a counting wrapper, without changing behaviour | unit + manual | Pass | Unit: "the real libSQL client through the proxy: every statement, round trip, row and repeat is counted" (the real `@libsql/client` against a stand-in `sqld`, including stored SQL, gzip answers and a batch's skipped ROLLBACK). "NEGATIVE: the proxy changes nothing the app receives" (status, content type, body byte for byte). "NEGATIVE: a request the proxy can't read is still forwarded and counted, and marked unparsed". Manual: all 11 routes agree with `sqld`'s own `query_count` for each database. A broken counter (each statement counted twice) gave `reads 6 … [sqld disagrees]` on both routes tried, and `reads 3` with no flag once restored. Timing passes never go through the proxy |
| B12 | Edge memory: say it isn't measurable locally | manual | Done | `notMeasured` in the JSON, the markdown, the method above |
| B13 | Baseline written to `docs/perf/`, dated JSON plus a short markdown table | manual + unit | Pass | `docs/perf/2026-11-03-local-baseline.json` and `.md`. Unit: "the markdown says plainly that these are local numbers, not budgets" |
| B14 | Method in this packet: machine, Node, build, warm-up, runs | manual | Done | "Method" and the baseline header above |
| B15 | Slowest pages and highest read counts named as PERF-06 candidates, not fixed | manual | Done | "Candidates for PERF-06" above, and `candidatesForPerf06` in the JSON. No app code changed |
| B16 | The report can compare a run to a budget file and fail when over, proven with a test budget file | unit + manual | Pass | S2 |
| B17 | Ships with no real budgets: a placeholder saying budgets wait for hosted numbers | unit | Pass | S3; `docs/perf/budgets.json` |
| B18 | `test:perf` stays out of `pnpm test`; the comparison test is a normal suite | unit | Pass | `scripts/run-tests.js` is unchanged (`NOT_A_GATE` still holds `test:perf`). `test:perf-tools` ran inside `pnpm test` (26/0) |

### Negatives on the report's own behaviour

| Item | Tag | Status | Evidence |
|---|---|---|---|
| An error page, a non-200 answer, the wrong product or an empty cart is never measured | unit | Pass | "each measured route is the real page, or the run stops…" |
| Data that isn't the perf fixture is refused | manual | Pass | After a plain `seed`: `✗ The harness data isn't the perf fixture. Seed it first: node scripts/dev-design.js seed --fixture perf`, exit 1 |
| A running harness in this checkout is refused, and keeps working | manual | Pass | With `prod-harness.mjs start` up: `✗ The design harness is running in this checkout (pid 94788). Stop it first…`, exit 1, for `http` and `fixture`; the harness still answered `GET /` 200 |
| A harness or seed started while the report runs is refused, and the report finishes | manual | Pass | `node scripts/dev-design.js` and `… seed --fixture perf` both gave `✗ The design harness is already running (pid 97074)…`, exit 1; the report exited 0 with normal numbers |
| A build older than the code is refused | manual | Pass | After `touch lib/site.js`: `✗ The production build is older than the code in app/, lib/ or components/. Run again with --build.`, exit 1 |
| Stopping the report mid-run cleans up | manual | Pass | SIGTERM and SIGINT during pass 1: exit 130; the 3 `sqld` and Next it recorded were gone, ports 3203 and 18220 to 18228 were free, and no pid file was left |
| The live database-count check can fail | manual | Pass | B11 |

## Commands, exactly

```
git checkout -B cms/p1-perf04 8968db3
pnpm install --frozen-lockfile --prefer-offline
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/dev-design.js seed --fixture perf
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/perf-report.js fixture
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/perf-report.js http --build      # first build, then measured
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/perf-report.js http              # the committed baseline (build current)
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/perf-report.js http --out <scratch>   # the repeat run
node scripts/perf-report.js check docs/perf/2026-11-03-local-baseline.json --budget docs/perf/test-budget.json   # exit 1
node scripts/perf-report.js check docs/perf/2026-11-03-local-baseline.json --budget docs/perf/budgets.json       # exit 0, not checked
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/perf-report.js http --only home,product,cart-get --runs 3 --warmup 1 --count-runs 1 --no-write --budget docs/perf/test-budget.json   # exit 1
DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/drills/p1/prod-harness.mjs start   # for the drill
DESIGN_PORT=3203 node scripts/drills/p1/run.mjs perf04
node scripts/test-perf-tools.js
node scripts/perf-report.js            # library mode (pnpm test:perf), once, to see it still runs
pnpm test
```

The report uses `DESIGN_PORT` for Next. It uses `DESIGN_SQLD_PORT` to `DESIGN_SQLD_PORT+8` for `sqld` (3), `sqld`'s admin API (3) and the counting proxies (3). A full run takes about 3 to 4 minutes on this Mac, plus about a minute for `--build`.

## Test results

- **`pnpm test`** on the committed code: **52 of 52 suites passed in 96.3s**, exit 0. That is the 51 suites at `8968db3`, plus `test:perf-tools`.
- The per-suite counts below come from `node scripts/run-tests.js --verbose` just before the last two small edits: library mode's jobs/s label, and the drill's image check applying only to pages with images. It gave 52 of 52 in 96.7s, **1,200 tests passed, 0 failed**. Per suite (passed/failed):

```
test:orders 27/0            test:shipping 12/0          test:shopify-push 13/0
test:shopify-boundary 41/0  test:hardening 11/0         test:offers 27/0
test:offers-admin 8/0       test:offer-form 61/0        test:events 16/0
test:tenancy 9/0            test:platform-sync 15/0     test:admin-console 9/0
test:cms-api 20/0           test:page-editor 61/0       test:refs 8/0
test:sections 15/0          test:cms 11/0               test:platform-ops 9/0
test:tenant-boundary 24/0   test:identity 22/0          test:authz 14/0
test:platform-core 15/0     test:jobs 16/0              test:sync-generations 8/0
test:first-sync 72/0        test:order-projection 14/0  test:commerce 10/0
test:privacy 11/0           test:security 19/0          test:content 19/0
test:releases 25/0          test:themes 10/0            test:storefront 15/0
test:surfaces 15/0          test:billing 14/0           test:provision 9/0
test:reporting 6/0          test:tenant-ops 9/0         test:marketing 4/0
test:customers 9/0          test:commerce-exp 18/0      test:growth 21/0
test:agency 16/0            test:w6 16/0                test:copy 52/0
test:media-upload 119/0     test:design-harness 46/0    test:failure-matrix 82/0
test:schema-compat 25/0     test:order-catalog 15/0     test:editor-layout 31/0
test:perf-tools 26/0
```

- `pnpm test` was not run at `8968db3` before the change. The 51 existing suites are unchanged by this branch, except that `test:design-harness` now loads the changed harness. It still passes 46 of 46, the count the P1-HARNESS packet records.
- **Library mode** (`node scripts/perf-report.js`, which `test:perf` runs and the gate leaves out): exit 0, 10 local guards passed.
- `next build` (harness env): exit 0.

## Do the tests bite?

A scratch runner applied each break alone, ran `node scripts/test-perf-tools.js`, and put the file back. Each file was compared byte for byte afterwards.

| Break | Result |
|---|---|
| P1 a number equal to its budget fails (`>=`) | caught: 3 budget tests |
| P2 a missing number not reported | caught: "a budgeted number the run doesn't have fails" |
| P3 a `local` basis accepted | caught: "…came from a local run is refused" |
| P4 hosted budgets checked against a local run | caught: "like with like" |
| P5 percentile off by one | caught: "p95 is the nearest rank" |
| P6 the placeholder claims a pass | caught: 3 tests |
| P7 an empty file treated as budgets | caught: 3 tests |
| D1 batch steps not counted | caught: the real-client proxy test |
| D2 a batch's skipped ROLLBACK counted | caught: same |
| D3 stored SQL (`sql_id`) not resolved | caught: same |
| D4 `sqld`'s gzip answers not decoded | caught: same |
| D5 unreadable requests not flagged | caught: "…marked unparsed" |
| D6 repeats ignore the arguments | caught: the real-client proxy test |
| D7 `rows_read` dropped | caught: same |
| D8 round trips not counted | caught: 2 tests |
| F1 randomness in the fixture | caught: "the same store every time" |
| F2a the size-only variant cap removed; F2b the first-draft variant code put back (two variants of one product with the same options) | caught: "the agreed sizes" and "internally whole" |
| F3 the measured product changed to one without 6 variants | caught: "the measured product reads everything…" |
| F4 the builder accepts an unknown fixture | caught: "an unknown fixture is refused…" |
| S1 the seed accepts an unknown fixture; S2 the harness does | caught: same |
| H1 an error page measured; H2 a non-200 answer measured | caught: "each measured route is the real page…" |
| H3 the check command exits 0 when over budget | caught: "the check command…" |
| R1 library mode prints "budget" again | caught: "…local guards, never as budgets" |
| B1 a budget slips into `docs/perf/budgets.json` | caught: 3 tests |
| F2 (first attempt) flavour indexed `k % 3` | **survived, and is equivalent.** With 2 sizes it still gives 6 different combinations, so it isn't a bug. F2a and F2b are the faithful versions of the bug, and both are caught |
| Live: the counter counts each statement twice | caught by the run itself: `[sqld disagrees]` on both routes tried |

27 breaks caught, 1 equivalent survivor. This shows the tests notice these breaks, not every break.

**A bug found by looking, before any test:** the drill's screenshot of the first fixture showed a product with six variants but only three size buttons. The first-draft generator gave size-only products duplicate variants ("60 tablets" twice). It was fixed before the committed baseline: size-only types are capped at their sizes, and flavoured types use flavour by size. The "no two variants with the same options" test was added. It fails on the first-draft code (F2b).

## Browser drill (`docs/cms-reviews/drills/PERF-04/`)

Desktop Chrome 156 (headless) through `scripts/drills/p1/run.mjs perf04`. The harness was a production build (`prod-harness.mjs start`) on 3203 and 18220 to 18222, seeded with the perf fixture.

| Part | Result | What it checked |
|---|---|---|
| pages | **54 passed, 0 failed, 9 known (finding 1)** | Every measured HTML page at 1440, and home, product and shop-all again at 375: 200, `x-edge-runtime: 1`, not an error page, the expected words. Home shows the hero and all 12 fixture sections (`[data-sec]`). Shop-all shows a full first page (48 product links). The product shows its pairs list. "No broken images" fails on every page with photos: that is finding 1, marked known |
| checkout | **7 passed, 0 failed, 1 known (finding 1)** | With the measured cart's cookie: checkout's first step, on the edge runtime, lists the 3 cart products |

Screenshots (17 to 43 KB each, about 340 KB in all): [home-1440](drills/PERF-04/home-1440.png), [home-375](drills/PERF-04/home-375.png), [product-1440](drills/PERF-04/product-1440.png), [product-375](drills/PERF-04/product-375.png), [collection-1440](drills/PERF-04/collection-1440.png), [collection-all-1440](drills/PERF-04/collection-all-1440.png), [collection-all-375](drills/PERF-04/collection-all-375.png), [collections-1440](drills/PERF-04/collections-1440.png), [search-1440](drills/PERF-04/search-1440.png), [cms-page-1440](drills/PERF-04/cms-page-1440.png), [journal-1440](drills/PERF-04/journal-1440.png), [checkout-1440](drills/PERF-04/checkout-1440.png). Results: `results-pages.json`, `results-checkout.json`.

## Findings outside this item (for the owner)

1. **Library images through `next/image` break on a self-hosted `next start`.**
   - What happens: `/_next/image?url=/api/media/med_…` answers 400 "The requested resource isn't a valid image".
   - Why: Next fetches a local image through a mocked request with no `Host` header (`node_modules/next/dist/server/image-optimizer.js:1013-1023`). So `tenantHandler` can't tell which store it is, and `/api/media` answers 404.
   - What still works: `/api/media/<id>` served directly is fine (200, `image/webp`, 123 KB).
   - Where it shows: every fixture photo on the harness's production build. Any library image shown through `next/image` would break the same way, for example image sections on content pages.
   - Not checked: whether Vercel's separate image service is affected. `next dev` was not checked either.
   - The baseline fetches no images, so its numbers don't depend on this. Not fixed here.
2. **Local `next start` didn't compress the edge-runtime pages.**
   - What happens: no `Content-Encoding` and no `Vary: Accept-Encoding`, so the home page went out as 223 KB where gzip would make it about 20 KB.
   - Static files were compressed (11 or 12 of the 14 or 15 each page names).
   - Vercel's CDN compresses, so this matters only for a self-hosted deploy. Not checked on hosting.

## Deviations

1. **Two collection pages and two cart calls, plus the journal index.** The brief named one of each. The category page (40 products) and shop-all (400) show how reads grow with collection size. The cart read and the cart change are different paths. The journal index lists the 60 posts.
2. **Counting is a proxy on the wire, not a wrapper in `lib/db.js`.** That needs no app change, keeps clear of the database-retries branch's rewrite of `lib/db.js`, and counts the control plane too (it is not behind `lib/db.js`). `sqld`'s own counter checks it.
3. **`sqld` runs with its admin API during the report** (`--admin-listen-addr`, through the new `extraArgs`). The plain harness is unchanged.
4. **Library mode's thresholds were relabelled "local guard"**, and its queue-drain line prints jobs/s. Behaviour and exit codes are unchanged. It would otherwise print local numbers as budgets, which S3 rules out.
5. **The fixture publishes a release.** So after `--fixture perf`, the demo's unpublished Winter hero draft is live, and the Publishing screen shows no pending changes. A plain `seed` is unchanged.
6. **`perf-report.js fixture` and the content digest** were added to prove the fixture repeats.
7. **Each request carries its own `x-forwarded-for`**, so the cart-change row isn't cut off by the 60-a-minute limiter.
8. **The test budget sits in `docs/perf/test-budget.json`**, beside the placeholder. It is named `test-`, its basis is `test`, and the check prints "TEST BUDGET: … not a real budget". A unit test enforces that only `test-*` files there may hold test budgets.

## Merge notes

- **Nothing in `app/`, `lib/` or `components/` changed.** So nothing here conflicts with `claude/gallant-keller-7d3213` (`lib/db.js`, `lib/orders.js`, `CheckoutFlow.js`) or `claude/musing-williamson-4c86b3` (storefront `tfetch` imports, layout `generateMetadata`, the maintenance curtain, `not-found.js`).
- **But both change what gets measured.**
  - The maintenance branch changes the storefront layout, which every page runs, so read counts may change.
  - The retries branch changes how `lib/db.js` retries.
  - After both merge, rebuild and take a new dated baseline: `node scripts/perf-report.js http --build`. The report refuses a build older than `app/`, `lib/` or `components/`.
- `package.json`: one line, `test:perf-tools`, after `test:perf`. Other batch C branches adding `test:*` lines near there will conflict textually. Keep both sides.
- `scripts/design-harness.js`:
  - new exports (`startSqld`, `writePidfile`, `clearPidfile`, `FIXTURES`);
  - a `fixture` option on `runHarness`;
  - an import of `./perf-fixture.js`;
  - one new key in `seeded.json`.

  A branch editing `runHarness`'s signature, `doSeed` or `startSqld` will conflict. The P1-HARNESS review's open `TZ` fix touches `ps` and `stopLeftovers`, not these lines.
- `scripts/dev-design.js`: argument parsing rewritten (`seed`, `--fixture <name>`). `scripts/seed-design-preview.js`: a fixture check at the top and a fixture block at the end.
- A new tenant migration (0021 or 0022 in this batch) makes the report refuse the old harness data, until `node scripts/dev-design.js seed --fixture perf`.
- `test:perf-tools` reads `docs/perf/*-local-baseline.json`, `docs/perf/test-budget.json` and `docs/perf/budgets.json`. Deleting the last committed baseline turns it red on purpose. A new baseline needs no test change.
- The orchestrator can copy the manual checks below into `docs/cms-reviews/MANUAL-CHECKS.md` under batch C. That file is not edited here, to avoid conflicts between parallel branches.
- No migration, no new dependency, nothing hosted touched. No secrets read or printed. `.env.local` was not used. The harness writes `.design-env` with local test passwords, which is gitignored.

## Known limits

**What the numbers are.**
- **Local only.** This is Next's local edge sandbox under `next start`, not Vercel's edge, and `sqld` is on the same Mac, so a database round trip costs about a millisecond. Hosted, each round trip is a network trip to Turso. Round-trip counts and bytes carry over to hosting far better than milliseconds do.
- **A shared, busy machine.** Other agents' builds and tests ran at the same time (load average about 4 on 15 cores). Between two runs, p50 moved up to 10%, p95 up to 23% and cold up to 34%. Counts and bytes did not move.
- **One cold sample per route.** A cold run here is a fresh local `next start`, so it includes loading the route's edge bundle. It is not a Vercel cold start.
- **"Sent" is uncompressed locally** (finding 2). The gzip column is an estimate made here at zlib's default level, not what a CDN sends (often Brotli).
- **Images are not measured**, and fixture photos don't render on the production harness (finding 1). Page weight with images is a browser drill.
- **The quiz, bundle and upsell routes are not measured** (PERF-06's other evidence lines).
- **Edge memory is not measured**, because it can't be locally.

**How the counting works.**
- **It counts what reaches `sqld`.** A value the app caches in memory is correctly not counted. The control plane's tenant lookup, cached for 30 seconds per edge sandbox, shows only in the first-request column.
- **It reads Hrana v2 JSON**, which `@libsql/client` 0.17.4 sends over http by default. Another protocol (v3 protobuf, a cursor stream) would still be forwarded and counted as round trips, but flagged `unparsed`, with statements counted from the request only.
- **It waits for 120 ms of quiet** after each response before taking the counts. A database call that started later would land on the next request. None did: counts were identical across runs and matched `sqld`.
- **Some first-request counts are already warm.** `collection-all` shares its code with `collection`, and `cart-update` with `cart-get`, so their bracketed first-request counts come from a warm sandbox.
- **The proxy runs only in the counting pass.** Timing passes go straight to `sqld`.

**What a run depends on.**
- **The home page sees a new visitor each time**, so the running hero experiment picks a variant at random. Its size varies by tens of bytes, and its timing may too.
- **The stale-build check looks only at `app/`, `lib/` and `components/` file times**, not `next.config.mjs` or `package.json`.
- **The budget check compares against fixed limits**, with no allowance for noise. Hosted budgets will need one, and the format can grow a tolerance then.
- **`check` trusts the run JSON's `environment.kind`.** A hand-edited file could mislabel a run.
- **Only `next build` with the harness env was run.** Not a hosted env, which the brief forbids.

**About the fixture.**
- **The sizes are an estimate, not real tenant data** (OQ-11).
- **The fixture keeps the demo data,** so the catalog is 392 generated products plus the 8 demo ones, and 21 content pages including the demo's shipping page.
- **What differs between seeds:** bundle ids, release ids, timestamps and the demo's shipping-page section id. The content digest leaves them out.
- **The photos are generated** soft gradients with grain (24 product, 8 page). They aren't real product shots, but they compress like photos.
- **A full report holds 9 ports for about 4 minutes**, and starts and stops `next start` 13 times.

### From review

Non-blocking findings from the independent review, added at merge. All are still open.

- **Stopping the report while `next start` is booting leaves processes behind.** Reproduced on ports 3213 and 18260: a SIGTERM 100 ms after "pass 2 of 3" made the report exit 1 (not 130) with "✗ next start stopped (exit null) before it was ready". The three `sqld` processes were still listening on 18260 to 18265 (HTTP and admin ports), and `.design-data/harness.pid.json` was still there. Cause: the signal handler's clean-up kills Next, which rejects `next.ready`; `runHttp` then throws, `main` returns 1, and `perf-report.js` calls `process.exit(1)` before the clean-up has stopped the proxies and `sqld`. The window opens on all 13 Next launches. The next run's `stopLeftovers` recovered it ("stopped a local database server left over" three times). A SIGTERM during counting, 3 seconds into pass 1, cleaned up correctly (exit 130, all ports free, no pid file). This packet scopes its claim to "during pass 1" and is accurate, but the report summary's "SIGTERM or SIGINT mid-run: exit 130, no processes left" claims too much. Fix: make the error path wait for the clean-up already running (or skip `process.exit` while interrupted).
- **The budget check does not refuse hosted budgets against a local run**, despite "What was built" item 4 above. A file with `"basis": "hosted"` and `"runKind": "local"` is accepted and compared with the local baseline: "ok home ttfb.p95: 83 ≤ 100000 / ✓ within budget", exit 0. Only a `runKind` mismatch is refused. Either refuse `basis` hosted with `runKind` local, or reword this packet and the report's "hosted budgets are not compared with a local run".
- **A run whose counts disagree with `sqld`, or vary across counted runs, still exits 0 and writes the dated baseline.** The markdown table carries no flag; only the JSON's `sqldAgrees` and `stableAcrossRuns` and the console line show it. Reproduced with a counter that skipped statements returning no rows: home printed "reads 20 … [sqld disagrees]", cart-update the same, and the exit was 0. Consider exit 1, or refusing to write, when any route disagrees.
- **Gaps in the unit tests.** Of the reviewer's 41 mutations (each restored byte for byte), 9 were caught (R1 local basis, R7 budgets list, C1 `WITH`, C10 `rowsReturned`, H9 edge-memory wording, F5/F6/F10 sizes, L1 "budget" label) and 32 survived. Survivors on reported numbers or guard lines:
  - `summarize`'s p95 changed to the 90th percentile: the reported p95 is not pinned; only `percentile()` is tested.
  - The proxy forcing `accept-encoding: identity` upstream survives the "proxy changes nothing the app receives" test, which only compares identity requests.
  - `bytesDown` and `bytesDownDecoded` not counted, and `db.bytesDown ?? 0`.
  - `environment.kind` hard-coded "hosted" on a local run.
  - The command line exiting 0 when a budgeted number is only missing (`compareToBudget` handles it; the command-line path is untested).
  - The fixture never reaching the seed (`seedEnv` `DESIGN_FIXTURE` blanked, the seed block disabled, `seeded.json` always "perf") and the release not published.
  - `sqldAgrees` hard-coded true.
  - The non-fixture and stale-build refusals disabled.
  - The expected words for checkout, `/collections` and search removed; the status check weakened to >= 500; the `&amp;` branch; the candidates' sort order; the `runKind` requirement.

  The runtime checks and the manual runs cover most of these, so no committed number is wrong.
- **A missing run file gives a raw error.** `node scripts/perf-report.js check <missing run file> --budget …` prints a raw ENOENT stack (`node:fs readFileUtf8`) and exits 1, instead of a plain one-line message. A missing budget file gets a plain message.
- **`test:perf-tools` will turn red at this packet's own next steps.** "NEGATIVE: no file in docs/perf claims a budget from local numbers" asserts that every `storeasy-perf-baseline` JSON in `docs/perf` has `environment.kind` "local" and a budgets string starting "None.", but owner check 3 asks for a hosted run in `docs/perf` with kind "hosted". "the shipped budget file holds no budget" asserts `budgets.json` is empty, which owner check 4 changes. These tests have to change when hosted numbers land.
- **Misleading message during a report run.** While the report runs, its pid file makes a concurrent `dev-design` or seed print "The design harness is already running (pid N). Stop it with Ctrl-C in its terminal…". It is the perf report, not the harness, that is running. A wording nit in a developer tool.
- **Timing varies more than this packet says.** On the reviewer's rerun (same fixture digest, fresh build), against the committed baseline: total p50 up to +14% (cart routes); p95 up to +45% (cart-update) and +41% (journal); cold up to +33%. That is wider than "p50 within 10%, p95 up to 23%", though consistent with this packet's own "p95 and cold are rough" caveat. Read counts, round trips, rows read, duplicate reads and decoded bytes were identical on all 11 routes.
- **Findings 1 and 2 (outside this item) reproduce on the reviewer's production harness.** `/_next/image?url=/api/media/med_db4c43f623b0f0943a` gives 400 (43 bytes), while `/api/media/med_db4c43f623b0f0943a` directly gives 200 image/webp, 123,538 bytes; Next's `fetchInternalImage` builds the mocked request with no headers (`image-optimizer.js:1013-1023`). `GET /` with `Accept-Encoding: gzip, br` has no `Content-Encoding`. Both are app or hosting behaviour that was already there, not regressions from this branch.
- **The `/api/cart` responses do not carry `x-edge-runtime`** (only HTML pages do). The proof that the cart API runs on the edge rests on `.next/server/middleware-manifest.json`, which the reviewer confirmed lists `/api/cart/route` among the edge functions. This packet's wording ("every page response") is accurate.
- **The "fixture never touches Shopify" check was verified by reading, not rerun.** The reviewer could not rerun the outbound-connection recorder: their sandbox refused `NODE_OPTIONS` preloads. Instead they read the seed's write paths (`lib/cms/store.js`, `offers/store.js`, `bundles.js`, `quiz.js`, `cms/placements.js`, `catalog-overrides.js`, `releases.js`), whose only mentions of Shopify are comments. The seed also refuses non-local database URLs before any import, and the unit test's import scan passes.

## Browser drills still needed

Desktop Chrome on the design harness can check these. An agent can run them later.

1. **The console with a realistic store.** Seed with `--fixture perf`, sign in, and open Products, Collections, Storefront pages, Journal, Media, Offers and Publishing. Pass: each screen loads with the fixture's data (400 products, 30 collections, 85 pages, 32 media) and no error page. Record how long each list takes to load. That is founder-facing speed on a realistic store, which this baseline doesn't measure.
2. **The baseline after the two bug-fix branches merge.** Rebuild, then run `node scripts/perf-report.js http --build` and `node scripts/drills/p1/run.mjs perf04`. Pass: the run completes, every route agrees with `sqld`, and the drill has 0 failed. Commit the new dated baseline, and note which counts moved against 2026-11-03, and why.
3. **Finding 1 in `next dev`.** On `pnpm dev:design` with the perf fixture, open `/products/micronised-creatine-12` and a content page with an image section. Pass: record whether the photos show. If they do, the fault is `next start` only.
4. **Page weight with images, in Chrome.** For each measured page, load it with the cache disabled and sum the transferred bytes from the Network log, images included. Pass: the numbers are recorded beside the baseline. This needs finding 1 fixed, or real remote photos.
5. **The existing drills on the perf fixture.** Run `drill:smoke` and `drill:edge` on a harness seeded with `--fixture perf` (the demo products are still there). Pass: the same results as on the plain seed, or a recorded list of checks that depend on the demo-only state (deviation 5).

## Checks only the owner can do

1. **OQ-11: may engineers read real tenant sizes?** Counts only: products, variants, collections, content pages, posts, media, offers. Pass: a yes or no. If yes, the fixture's numbers (`PERF_FIXTURE` in `scripts/perf-fixture.js`) are set to match a real store.
2. **OQ-19: a private staging deploy of one test tenant, for measurement.** Pass: a decision. Without it, hosted numbers, budgets, PERF-03, PERF-05 and PERF-07 wait for the hosting phase.
3. **Hosted before numbers, once staging exists.** Measure the same 11 requests on staging: TTFB, total, bytes, database reads (Turso's stats) and edge memory (the host's function metrics). Pass: a hosted run in `docs/perf/` with `environment.kind` set to "hosted". That is the spec's first acceptance item.
4. **Set the first budgets from those hosted numbers.** Write them into `docs/perf/budgets.json` with `"basis": "hosted"` and `"runKind": "hosted"`. Pass: the check passes on that run, and fails when one number is pushed over its budget.
5. **Do the fixture sizes look like a store you'd onboard?** 400 products with about 3 options each, 30 collections, 20 pages, 60 blog posts, 12 home sections, 8 offers, 4 bundles. Pass: you agree, or give better numbers.
6. **Finding 1: library photos on staging.** On Vercel staging, open a page that shows a library image. Pass: the photo shows. If it doesn't, the image fix becomes urgent.
7. **Finding 2: compression on staging.** Check that the home page's response on staging has `Content-Encoding` br or gzip. Pass: compressed.
