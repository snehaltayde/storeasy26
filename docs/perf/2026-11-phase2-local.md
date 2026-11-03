# Phase 2 local numbers (P2-PERF, PERF-01)

**Kind: local. Not budgets.** One Mac, a production build of the design harness (`next build`, then `next start`), storefront on Next's local edge runtime, databases on local sqld. Hosted numbers are an owner check (OQ-19).

- Taken: 2026-11-03. Machine: Apple M5 Pro, 15 cores, Darwin 25.5.0 (macOS 26.5.1), Node v26.0.0, Next 16.2.9, sqld sqld 0.24.32 (40c272de 2025-02-14).
- Runs (each its own `node scripts/perf-report.js http --extra-routes` on the same build): **Before: legacy, v3 live** (legacy store, live v3 release (the perf seed), build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 4.45/3.21/2.98 at start); **Legacy, no release** (legacy store before its first publish, build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 4.29/3.52/3.13 at start); **v4, 0 posts** (documents store, v4 list, build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 3.61/3.47/3.14 at start); **v4, 200 posts** (documents store, v4 list, build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 4.1/3.6/3.2 at start); **v4, 1,000 posts** (documents store, v4 list, build `es8ihdvIYpyRLktsdJvbC`, commit `f893710`, load 3.79/3.6/3.22 at start).
- Database counts come from scripts/perf-dbcount.js (unchanged) in front of each sqld, checked against sqld's own query counter. Every count below was the same on all 5 counted runs of its route unless marked.

## Round trips and parsed bytes per request (warm)

Each cell: round trips to the databases / what the page parsed from them (all three databases).

| Route | Baseline 2026-11-03 | Before: legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 24 / 648.7 KB | 23 / 648.2 KB | 32 / 66.0 KB | 25 / 59.9 KB | 25 / 87.7 KB | 25 / 198.7 KB |
| product | 10 / 637.7 KB | 9 / 637.2 KB | 19 / 52.7 KB | 11 / 45.2 KB | 11 / 73.1 KB | 11 / 184.0 KB |
| collection | 9 / 636.7 KB | 8 / 636.2 KB | 15 / 49.4 KB | 9 / 43.0 KB | 9 / 70.9 KB | 9 / 181.8 KB |
| collection-all | 9 / 639.0 KB | 8 / 638.5 KB | 15 / 51.6 KB | 9 / 45.4 KB | 9 / 73.2 KB | 9 / 184.2 KB |
| collections | 4 / 623.4 KB | 3 / 622.9 KB | 10 / 36.0 KB | 5 / 34.6 KB | 5 / 62.4 KB | 5 / 173.4 KB |
| search | 4 / 628.0 KB | 3 / 627.5 KB | 9 / 40.1 KB | 4 / 34.0 KB | 4 / 61.8 KB | 4 / 172.8 KB |
| cms-page | 3 / 617.1 KB | 2 / 616.6 KB | 10 / 39.2 KB | 4 / 28.0 KB | 4 / 55.8 KB | 4 / 166.7 KB |
| journal | 3 / 617.1 KB | 2 / 616.6 KB | 69 / 536.1 KB | 3 / 23.2 KB | 4 / 122.1 KB | 4 / 515.3 KB |
| cart-get | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB |
| cart-update | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB |
| checkout | 9 / 636.5 KB | 8 / 636.0 KB | 15 / 66.2 KB | 9 / 42.5 KB | 9 / 70.4 KB | 9 / 181.3 KB |
| sitemap | – | 65 / 38497.5 KB | 190 / 627.8 KB | 4 / 68.3 KB | 5 / 195.1 KB | 5 / 699.2 KB |
| upsell | – | 3 / 613.9 KB | 5 / 5.5 KB | 1 / 12.4 KB | 1 / 40.3 KB | 1 / 151.2 KB |
| offline | – | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 44.8 KB | 2 / 155.7 KB |
| manifest | – | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 44.8 KB | 2 / 155.7 KB |

## Total time, p50 / p95 ms (warm)

| Route | Baseline 2026-11-03 | Before: legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 57.4 | 51.8 / 89.1 | 41.8 / 46.7 | 43.4 / 58.2 | 40.6 / 47 | 50 / 54.9 |
| product | 37.6 | 32.1 / 42 | 25.4 / 28.5 | 25 / 35.5 | 24.5 / 27.1 | 34.6 / 38.8 |
| collection | 37.7 | 34 / 47 | 25 / 32.2 | 22.6 / 32.3 | 22.2 / 26.4 | 32.4 / 36.2 |
| collection-all | 40 | 37.1 / 41 | 28 / 35.8 | 26.7 / 34 | 25.6 / 28.4 | 35.9 / 39.9 |
| collections | 31.3 | 29.1 / 33.2 | 21 / 23.9 | 18.9 / 23.4 | 19.5 / 21.4 | 29.3 / 32 |
| search | 33.6 | 29 / 31.7 | 21.6 / 28.6 | 19.7 / 27.9 | 20 / 23 | 28.8 / 31 |
| cms-page | 28.8 | 26.6 / 31.2 | 19.4 / 24 | 16.6 / 21.1 | 17.9 / 20.6 | 26.7 / 29.2 |
| journal | 29.7 | 28.1 / 37.5 | 75.6 / 94.4 | 14.5 / 17.8 | 26.9 / 40.4 | 83.5 / 91.8 |
| cart-get | 4.7 | 4.2 / 6.5 | 3.7 / 9.1 | 5 / 11.1 | 4.4 / 6.7 | 4.3 / 5.5 |
| cart-update | 5.8 | 5.4 / 9.4 | 4.9 / 9.3 | 6.2 / 14.4 | 5.1 / 8.3 | 5 / 5.9 |
| checkout | 37.3 | 33.7 / 39.1 | 23.7 / 38.5 | 22 / 36.8 | 22.2 / 30.3 | 31.6 / 33.8 |
| sitemap | – | 917.3 / 1339.2 | 131 / 229.3 | 7.9 / 12.3 | 15.1 / 17.8 | 42.4 / 49 |
| upsell | – | 17.4 / 33.7 | 3.9 / 5.4 | 2.5 / 3.9 | 4.5 / 6.1 | 14.1 / 15.8 |
| offline | – | 15.4 / 30 | 1.8 / 2.6 | 3.5 / 6.2 | 5.4 / 7.8 | 15.3 / 18 |
| manifest | – | 15.2 / 26.1 | 1.7 / 2.4 | 3.3 / 5.5 | 5.3 / 7.7 | 14.5 / 16.6 |

The baseline column is `docs/perf/2026-11-03-local-baseline.json` (PERF-04, commit `8968db3`, its own build; total time is its p50 only). Every other column is one build of commit `f893710` (no app, lib or components change in P2-PERF). Every count above was the same on all 5 counted runs and agreed with sqld's own query counter. Every page answered with `x-edge-runtime: 1`.

## What the numbers say (written by hand, P2-PERF)

1. **The whole-release read is gone.** On a legacy store every page parses the 594 KB snapshot (home 648 KB). On a v4 store with no posts, home parses 59.9 KB, a policy page 28.0 KB, checkout 42.5 KB. What is left on home is mostly catalog reads (rails, menus, counts), the same reads a legacy store makes: a legacy store with no release at all parses 66.0 KB on home.
2. **Content reads per request (v4):** home 3 (the pointer and list, the chrome set, the home set), a policy page 3 (pointer, chrome set, its own version), checkout 2 (pointer, chrome set: no page body), `/journal` 3 (pointer, chrome set, the journal index). Statement shapes are in the JSON.
3. **But every v4 request grows with the post count.** The pointer read returns the release list, and the list holds one `documents` entry per published journal post (about 132 bytes each): 10.8 KB at 0 posts, 37.4 KB at 200, 143.0 KB at 1,000. Every v4 route pays it: home 59.9 → 87.7 → 198.7 KB parsed; the policy page 28.0 → 55.8 → 166.7 KB; `/api/upsell` 12.4 → 40.3 → 151.2 KB. Times follow (policy page p50 16.6 → 26.7 ms). See P2-PERF.md, finding 1.
4. **The sitemap reads the journal index once, no per-post read** (5 round trips at 200 and at 1,000 posts). It reads the pointer twice (`repeated 1`): the sitemap is a route, so `cache()` does not dedupe its two getters. At 1,000 posts it parses 699 KB (two lists of 143 KB, the journal index of about 365 KB, and the catalog), in 42 ms p50. On a legacy store with a live release the same route makes 65 round trips and parses 38.5 MB (the 594 KB snapshot 63 times: one read per post, no `cache()`), 917 ms p50: that cost was there before phase 2, and it was not in the PERF-04 baseline.
5. **A legacy store with no release** (before its first publish) pays the extra `cms_state` statement once per page request (home 32 round trips against 31 without it), and once per getter call where `cache()` does nothing: the sitemap makes 63 `cms_state` reads per request, and `/api/upsell`, `/offline` and the manifest one per call.
6. **Route handlers** (`/api/upsell`, `/offline`, `/manifest.webmanifest`): on v4 one pointer read per call (plus the chrome set for offline and the manifest); each call parses the whole list, so 151 to 156 KB at 1,000 posts.
7. **The product page on v4** reads the product layout version and, with no hand-picked pairs on v4 (plan decision 9), runs the automatic "Pairs well with" query: 11 round trips and 3,757 rows read, against 9 and 1,407 on legacy.
