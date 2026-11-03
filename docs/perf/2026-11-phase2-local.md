# Phase 2 local numbers (P2-PERF, PERF-01)

**Kind: local. Not budgets.** One Mac, a production build of the design harness (`next build`, then `next start`), storefront on Next's local edge runtime, databases on local sqld. Hosted numbers are an owner check (OQ-19).

- Taken: 2026-11-03. Machine: Apple M5 Pro, 15 cores, Darwin 25.5.0 (macOS 26.5.1), Node v26.0.0, Next 16.2.9, sqld sqld 0.24.32 (40c272de 2025-02-14).
- Runs (each its own `node scripts/perf-report.js http --extra-routes` on the same build): **Before: legacy, v3 live** (legacy store, live v3 release (the perf seed), build `IxZlyCgQffWdXqIxirCCi`, commit `8868fbb`, load 4.77/3.1/3.09 at start); **Legacy, no release** (legacy store before its first publish, build `IxZlyCgQffWdXqIxirCCi`, commit `8868fbb`, load 3.84/3.22/3.13 at start); **v4, 0 posts** (documents store, v4 list, build `IxZlyCgQffWdXqIxirCCi`, commit `8868fbb`, load 3.77/3.31/3.17 at start); **v4, 200 posts** (documents store, v4 list, build `IxZlyCgQffWdXqIxirCCi`, commit `8868fbb`, load 3.52/3.34/3.19 at start); **v4, 1,000 posts** (documents store, v4 list, build `IxZlyCgQffWdXqIxirCCi`, commit `8868fbb`, load 3.26/3.29/3.17 at start).
- Database counts come from scripts/perf-dbcount.js in front of each sqld (P2-PERF fix round 2 added each statement's own result bytes to it; the counts are unchanged), checked against sqld's own query counter. Every count below was the same on all 5 counted runs of its route unless marked.

## Round trips and parsed bytes per request (warm)

Each cell: round trips to the databases / what the page parsed from them (all three databases).

| Route | Baseline 2026-11-03 | Before: legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 24 / 648.7 KB | 12 / 637.5 KB | 21 / 55.4 KB | 14 / 49.2 KB | 14 / 49.3 KB | 14 / 49.3 KB |
| product | 10 / 637.7 KB | 8 / 631.0 KB | 18 / 46.4 KB | 10 / 39.0 KB | 10 / 39.1 KB | 10 / 39.1 KB |
| collection | 9 / 636.7 KB | 7 / 629.9 KB | 14 / 43.2 KB | 8 / 36.8 KB | 8 / 36.9 KB | 8 / 36.9 KB |
| collection-all | 9 / 639.0 KB | 7 / 632.3 KB | 14 / 45.4 KB | 8 / 39.1 KB | 8 / 39.3 KB | 8 / 39.3 KB |
| collections | 4 / 623.4 KB | 2 / 616.6 KB | 9 / 29.8 KB | 4 / 28.3 KB | 4 / 28.4 KB | 4 / 28.4 KB |
| search | 4 / 628.0 KB | 2 / 621.2 KB | 8 / 33.9 KB | 3 / 27.7 KB | 3 / 27.9 KB | 3 / 27.9 KB |
| cms-page | 3 / 617.1 KB | 1 / 610.4 KB | 9 / 32.9 KB | 3 / 21.7 KB | 3 / 21.8 KB | 3 / 21.8 KB |
| journal | 3 / 617.1 KB | 1 / 610.4 KB | 68 / 529.8 KB | 2 / 16.9 KB | 3 / 88.1 KB | 3 / 370.4 KB |
| cart-get | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB | 3 / 9.7 KB |
| cart-update | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB | 5 / 10.3 KB |
| checkout | 9 / 636.5 KB | 7 / 629.8 KB | 14 / 59.9 KB | 8 / 36.3 KB | 8 / 36.4 KB | 8 / 36.4 KB |
| sitemap | – | 65 / 38497.5 KB | 190 / 627.8 KB | 4 / 68.3 KB | 5 / 139.6 KB | 5 / 421.8 KB |
| upsell | – | 3 / 613.9 KB | 5 / 5.5 KB | 1 / 12.4 KB | 1 / 12.5 KB | 1 / 12.5 KB |
| offline | – | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 17.0 KB | 2 / 17.0 KB |
| manifest | – | 1 / 610.4 KB | 2 / 977 B | 2 / 16.9 KB | 2 / 17.0 KB | 2 / 17.0 KB |

## Total time, p50 / p95 ms (warm)

| Route | Baseline 2026-11-03 | Before: legacy, v3 live | Legacy, no release | v4, 0 posts | v4, 200 posts | v4, 1,000 posts |
|---|---|---|---|---|---|---|
| home | 57.4 | 45.1 / 51.5 | 36.5 / 41.7 | 31.9 / 35.5 | 31.7 / 35.6 | 32.6 / 35.8 |
| product | 37.6 | 32.3 / 36.8 | 26.1 / 30.3 | 23.5 / 26.3 | 22.4 / 25.7 | 23.3 / 26.1 |
| collection | 37.7 | 34.4 / 39 | 25.1 / 28 | 20.7 / 23.1 | 20.5 / 22.6 | 21.3 / 24.4 |
| collection-all | 40 | 38.5 / 42.5 | 29 / 31.8 | 24.3 / 27.8 | 23.9 / 27.3 | 25 / 28.3 |
| collections | 31.3 | 28.5 / 31.7 | 21 / 23.4 | 17.2 / 19.3 | 16.8 / 19.1 | 16.7 / 18.9 |
| search | 33.6 | 29.6 / 32 | 22.3 / 24.3 | 17.4 / 19.3 | 17.5 / 19.4 | 17.6 / 19.9 |
| cms-page | 28.8 | 25.4 / 27.9 | 19 / 24.3 | 14.6 / 16 | 14.7 / 16.1 | 15.2 / 17.2 |
| journal | 29.7 | 27.3 / 30 | 78.1 / 88.8 | 13.4 / 14.9 | 24.6 / 27.9 | 72.2 / 80 |
| cart-get | 4.7 | 4.8 / 6.3 | 4.1 / 6.6 | 4.4 / 5.3 | 4.6 / 5.4 | 5.2 / 9.8 |
| cart-update | 5.8 | 5.8 / 8.2 | 5.2 / 6.5 | 5.7 / 7.5 | 5.6 / 7.4 | 6 / 11.9 |
| checkout | 37.3 | 34.8 / 38.3 | 24.4 / 27.2 | 20.2 / 22.4 | 20 / 23.2 | 21 / 23.3 |
| sitemap | – | 957.3 / 1001.1 | 138.1 / 154.4 | 7.4 / 8.9 | 10.8 / 12.9 | 18.8 / 21.7 |
| upsell | – | 18.1 / 20.8 | 4.2 / 5.9 | 2.3 / 3.5 | 2.4 / 4.3 | 2.8 / 3.3 |
| offline | – | 15.5 / 17.5 | 1.9 / 2.2 | 3.3 / 4.9 | 3.2 / 5 | 3.5 / 4.3 |
| manifest | – | 15.5 / 17.4 | 1.8 / 3 | 3.2 / 4.2 | 3.1 / 3.9 | 3.3 / 5.2 |

The baseline column is `docs/perf/2026-11-03-local-baseline.json` (PERF-04, commit `8968db3`, its own build; total time is its p50 only). All five other columns are one build of commit `8868fbb` (P2-PERF fix round 2). Fix round 2 changed catalog reads that legacy stores make too, so the two legacy columns were taken again: they are no longer the code before phase 2. The "before" figure for acceptance 5b is the baseline column (home 648.7 KB). Every count above was the same on all 5 counted runs and agreed with sqld's own query counter. Every page answered with `x-edge-runtime: 1`. 1 KB here is 1,024 bytes, as in the baseline.

## What the numbers say (written by hand, P2-PERF)

1. **The whole-release read is gone.** On a legacy store every page parses the 594 KB snapshot (home 637.5 KB). On a v4 store, home parses 49.2 KB (50,391 bytes) at 0 posts and 49.3 KB (50,502 and 50,519 bytes) at 200 and 1,000 posts, a policy page 21.7 KB, checkout 36.3 KB.
2. **Home is under 50 KB (acceptance 5b), after fix round 2.** Before it, home parsed about 60 KB on v4, about 40 KB of it catalog reads. Fix round 2 cut the catalog reads home made but never showed: the catalog's collections for the header and footer when both have menus of their own (6.3 KB), the five rails' product counts (5 statements), the five rails' pins read one by one (now one statement), the two catalog counts (now one statement), the experiment columns serving doesn't use, and the collection descriptions the grid doesn't show. Home went from 25 round trips to 14. Split of home's 50,519 bytes at 1,000 posts, by statement (perf-dbcount's new per-statement bytes): the pointer and list 12,688; the home and chrome versions 9,608; five rails 18,198; newest products 3,622; the collections grid 1,955; the experiment 873; the rails' collection names 702; pins 425; counts 296; the rest (about 2,150) is the database answers' own framing. The margin under 51,200 bytes is about 680 bytes.
3. **Content reads per request (v4):** home 3 (the pointer and list, the chrome set, the home set), a policy page 3 (pointer, chrome set, its own version), checkout 2 (pointer, chrome set: no page body), `/journal` 3 (pointer, chrome set, the journal index). Statement shapes, with their bytes, are in the JSON.
4. **Reads do not grow with the post count (PERF-01).** Journal posts are listed through the journal index only (fix round 1), so the release list stays about 10.9 KB however many posts are live. Exact parsed bytes at 200 and at 1,000 posts: home 50,502 and 50,519; the policy page 22,346 and 22,349; checkout 37,277 and 37,285; `/api/upsell` 12,825 and 12,826. The cart routes, which read no content at all, move the same way between runs (9,925 and 9,928 bytes): variable-length numbers in each database answer. From 0 to 200 posts every v4 route grows once by about 112 bytes: the list's `indexes.journal` goes from null to one entry.
5. **The sitemap reads the journal index once, no per-post read** (5 round trips at 200 and at 1,000 posts). It reads the pointer twice: the sitemap is a route, so `cache()` does not dedupe its two getters. At 1,000 posts it parses 422 KB (mostly the journal index), in 18.8 ms p50. On a legacy store with a live release the same route makes 65 round trips and parses 38.5 MB (the 594 KB snapshot 63 times), 957 ms p50: that cost was there before phase 2, and it was not in the PERF-04 baseline.
6. **`/journal` grows with the post count by design**: it lists every post (no paging), so it reads the whole index: 88.1 KB at 200 posts, 370.4 KB at 1,000, 72.2 ms p50.
7. **A legacy store with no release** (before its first publish) pays the extra `cms_state` statement once per page request, and once per getter call where `cache()` does nothing: the sitemap makes 63 `cms_state` reads per request, and `/api/upsell`, `/offline` and the manifest one per call.
8. **Route handlers** (`/api/upsell`, `/offline`, `/manifest.webmanifest`): on v4 one pointer read per call (plus the chrome set for offline and the manifest), 12.5 to 17.0 KB parsed per call at any post count.
9. **The product page on v4** reads the product layout version and, with no hand-picked pairs on v4 (plan decision 9), runs the automatic "Pairs well with" query: 10 round trips and 2,415 rows read, against 8 and 65 on legacy with a live release.
10. **Legacy stores gain too.** Every storefront page skips the nav collections read when the store has both menus (the perf seed has), and home skips the rail counts and per-rail pins: legacy home with a live v3 release went from 23 round trips to 12.
