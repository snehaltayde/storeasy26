# Phase 2 local numbers (P2-PERF, PERF-01)

**Kind: local. Not budgets.** One Mac, a production build of the design harness (`next build`, then `next start`), storefront on Next's local edge runtime, databases on local sqld. Hosted numbers are an owner check (OQ-19).

- Taken: 2026-11-03. Machine: Apple M5 Pro, 15 cores, Darwin 25.5.0 (macOS 26.5.1), Node v26.0.0, Next 16.2.9, sqld sqld 0.24.32 (40c272de 2025-02-14).
- Runs (each its own `node scripts/perf-report.js http --extra-routes` on the same build): **Before: legacy, v3 live** (legacy store, live v3 release (the perf seed), build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 4.45/3.21/2.98 at start); **Legacy, no release** (legacy store before its first publish, build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 4.29/3.52/3.13 at start); **v4, 0 posts** (documents store, v4 list, build `5l1hOEW_X9jdtP97Qs80k`, commit `5e5fa58`, load 5.41/4.09/3.45 at start); **v4, 200 posts** (documents store, v4 list, build `5l1hOEW_X9jdtP97Qs80k`, commit `5e5fa58`, load 7.69/4.91/3.78 at start); **v4, 1,000 posts** (documents store, v4 list, build `5l1hOEW_X9jdtP97Qs80k`, commit `5e5fa58`, load 6.9/5.04/3.88 at start).
- Database counts come from scripts/perf-dbcount.js (unchanged) in front of each sqld, checked against sqld's own query counter. Every count below was the same on all 5 counted runs of its route unless marked.

## Round trips and parsed bytes per request (warm)

Each cell: round trips to the databases / what the page parsed from them (all three databases).

| Route | Baseline 2026-11-03 | Before: legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 24 / 648.7 KB | 23 / 648.2 KB | 32 / 66.0 KB | 25 / 59.9 KB | 25 / 60.0 KB | 25 / 60.0 KB |
| product | 10 / 637.7 KB | 9 / 637.2 KB | 19 / 52.7 KB | 11 / 45.2 KB | 11 / 45.3 KB | 11 / 45.4 KB |
| collection | 9 / 636.7 KB | 8 / 636.2 KB | 15 / 49.4 KB | 9 / 43.0 KB | 9 / 43.1 KB | 9 / 43.2 KB |
| collection-all | 9 / 639.0 KB | 8 / 638.5 KB | 15 / 51.6 KB | 9 / 45.4 KB | 9 / 45.5 KB | 9 / 45.5 KB |
| collections | 4 / 623.4 KB | 3 / 622.9 KB | 10 / 36.0 KB | 5 / 34.6 KB | 5 / 34.7 KB | 5 / 34.7 KB |
| search | 4 / 628.0 KB | 3 / 627.5 KB | 9 / 40.1 KB | 4 / 34.0 KB | 4 / 34.1 KB | 4 / 34.1 KB |
| cms-page | 3 / 617.1 KB | 2 / 616.6 KB | 10 / 39.2 KB | 4 / 28.0 KB | 4 / 28.1 KB | 4 / 28.1 KB |
| journal | 3 / 617.1 KB | 2 / 616.6 KB | 69 / 536.1 KB | 3 / 23.2 KB | 4 / 94.4 KB | 4 / 376.6 KB |
| cart-get | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB |
| cart-update | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB |
| checkout | 9 / 636.5 KB | 8 / 636.0 KB | 15 / 66.2 KB | 9 / 42.5 KB | 9 / 42.7 KB | 9 / 42.7 KB |
| sitemap | – | 65 / 38497.5 KB | 190 / 627.8 KB | 4 / 68.3 KB | 5 / 139.6 KB | 5 / 421.8 KB |
| upsell | – | 3 / 613.9 KB | 5 / 5.5 KB | 1 / 12.4 KB | 1 / 12.5 KB | 1 / 12.5 KB |
| offline | – | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 17.0 KB | 2 / 17.0 KB |
| manifest | – | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 17.0 KB | 2 / 17.0 KB |

## Total time, p50 / p95 ms (warm)

| Route | Baseline 2026-11-03 | Before: legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 57.4 | 51.8 / 89.1 | 41.8 / 46.7 | 41.8 / 46.8 | 41.5 / 46.2 | 40.3 / 45.2 |
| product | 37.6 | 32.1 / 42 | 25.4 / 28.5 | 24.9 / 29.2 | 25.1 / 28.5 | 23.4 / 26.5 |
| collection | 37.7 | 34 / 47 | 25 / 32.2 | 23.3 / 25.7 | 22.2 / 25.6 | 22 / 24.4 |
| collection-all | 40 | 37.1 / 41 | 28 / 35.8 | 26.4 / 30.1 | 25.8 / 28.7 | 25.5 / 28.4 |
| collections | 31.3 | 29.1 / 33.2 | 21 / 23.9 | 19.2 / 20.9 | 18.6 / 20.9 | 18.4 / 22.3 |
| search | 33.6 | 29 / 31.7 | 21.6 / 28.6 | 19.8 / 22.4 | 20.5 / 22.5 | 19.4 / 21.1 |
| cms-page | 28.8 | 26.6 / 31.2 | 19.4 / 24 | 16.6 / 19.1 | 16.6 / 18.2 | 16.4 / 18.2 |
| journal | 29.7 | 28.1 / 37.5 | 75.6 / 94.4 | 14.7 / 17.1 | 26.7 / 29.5 | 72.5 / 80.1 |
| cart-get | 4.7 | 4.2 / 6.5 | 3.7 / 9.1 | 4.6 / 5.7 | 4.6 / 5.2 | 4.8 / 9.4 |
| cart-update | 5.8 | 5.4 / 9.4 | 4.9 / 9.3 | 5.8 / 7.1 | 5.6 / 6.6 | 5.7 / 11.1 |
| checkout | 37.3 | 33.7 / 39.1 | 23.7 / 38.5 | 21.8 / 23.7 | 22.9 / 26.3 | 22.4 / 26.1 |
| sitemap | – | 917.3 / 1339.2 | 131 / 229.3 | 7.6 / 9.1 | 10.6 / 12.4 | 18.3 / 20.2 |
| upsell | – | 17.4 / 33.7 | 3.9 / 5.4 | 2.4 / 2.8 | 2.5 / 3 | 2.6 / 3.1 |
| offline | – | 15.4 / 30 | 1.8 / 2.6 | 3.3 / 4.7 | 3.3 / 4 | 3.2 / 4.4 |
| manifest | – | 15.2 / 26.1 | 1.7 / 2.4 | 3.4 / 4.4 | 3.2 / 3.9 | 3.3 / 4.3 |

The baseline column is `docs/perf/2026-11-03-local-baseline.json` (PERF-04, commit `8968db3`, its own build; total time is its p50 only). The two legacy columns are one build of commit `f893710`. The three v4 columns are one build of commit `5e5fa58` (P2-PERF fix round 1: journal posts no longer in `list.documents`), taken again after that fix; the legacy columns were not re-taken, because nothing on the legacy read path changed. Every count above was the same on all 5 counted runs and agreed with sqld's own query counter. Every page answered with `x-edge-runtime: 1`.

## What the numbers say (written by hand, P2-PERF)

1. **The whole-release read is gone.** On a legacy store every page parses the 594 KB snapshot (home 648 KB). On a v4 store, home parses 59.9 KB, a policy page 28.0 KB, checkout 42.5 KB. What is left on home is mostly catalog reads (rails, menus, counts), the same reads a legacy store makes: a legacy store with no release at all parses 66.0 KB on home.
2. **Content reads per request (v4):** home 3 (the pointer and list, the chrome set, the home set), a policy page 3 (pointer, chrome set, its own version), checkout 2 (pointer, chrome set: no page body), `/journal` 3 (pointer, chrome set, the journal index). Statement shapes are in the JSON.
3. **Reads no longer grow with the post count (PERF-01).** Journal posts are listed through the journal index only, so the release list stays about 10.9 KB however many posts are live. Exact parsed bytes at 200 and at 1,000 posts: home 61,398 and 61,428; the policy page 28,745 and 28,747; checkout 43,677 and 43,684; `/api/upsell` 12,825 and 12,826. Those few bytes are not content: the cart routes, which read no content at all, move the same way between runs (9,924 to 9,928 bytes), from the variable-length numbers in each database answer. From 0 to 200 posts every v4 route grows once by about 112 bytes: the list's `indexes.journal` goes from null to one `{version, hash}` entry. Before this fix the list grew by about 132 bytes per post (143 KB at 1,000 posts, home 198.7 KB).
4. **The sitemap reads the journal index once, no per-post read** (5 round trips at 200 and at 1,000 posts). It reads the pointer twice (`repeated 1`): the sitemap is a route, so `cache()` does not dedupe its two getters. At 1,000 posts it parses 422 KB (mostly the journal index of about 365 KB, plus the catalog and two small lists), in 18 ms p50. On a legacy store with a live release the same route makes 65 round trips and parses 38.5 MB (the 594 KB snapshot 63 times: one read per post, no `cache()`), 917 ms p50: that cost was there before phase 2, and it was not in the PERF-04 baseline.
5. **`/journal` grows with the post count by design**: it lists every post (no paging), so it reads the whole index: 94.4 KB at 200 posts, 376.6 KB at 1,000, 72.5 ms p50.
6. **A legacy store with no release** (before its first publish) pays the extra `cms_state` statement once per page request (home 32 round trips against 31 without it), and once per getter call where `cache()` does nothing: the sitemap makes 63 `cms_state` reads per request, and `/api/upsell`, `/offline` and the manifest one per call.
7. **Route handlers** (`/api/upsell`, `/offline`, `/manifest.webmanifest`): on v4 one pointer read per call (plus the chrome set for offline and the manifest), 12.5 to 17.0 KB parsed per call at any post count.
8. **The product page on v4** reads the product layout version and, with no hand-picked pairs on v4 (plan decision 9), runs the automatic "Pairs well with" query: 11 round trips and 3,757 rows read, against 9 and 1,407 on legacy.
9. **Home is still above 50 KB** (about 60 KB at any post count). The content reads are about 20 KB of it; the rest is catalog reads, which a legacy store makes too. See P2-PERF.md, acceptance 5b.
