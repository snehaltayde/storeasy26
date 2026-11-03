# Local baseline, 2026-11-03 (PERF-04)

**Local numbers, not budgets.** Taken on one Mac against a production build of the design harness. They are a starting point to compare against, nothing more. Budgets wait for hosted numbers (OQ-19). Edge memory is not measurable locally.

- Build: `next build` then `next start` (Next 16.2.9, build `nOsn1pbejWya3uI8uIgb6`), commit `8968db3`. storefront pages and /api/cart on the edge runtime (Next's local edge sandbox, not Vercel's).
- Databases: local sqld over http://127.0.0.1, one per database (platform, tenant, env default), sqld sqld 0.24.32 (40c272de 2025-02-14).
- Machine: Apple M5 Pro, 15 cores, 24 GB, Darwin 25.5.0 (macOS 26.5.1), Node v26.0.0. Load average (1, 5, 15 min) at start 4.16, 3.92, 3.66, at end 4.22, 3.95, 3.68: other work on this Mac shares the CPU, so treat small differences as noise.
- Fixture: perf. 400 products, 1142 variants, 30 collections, 21 pages, 60 journal posts, 12 home sections, 12 offers, 32 media files. Live release: 593.7 KB.
- Runs: 5 warm-up, then 50 timed runs per route (routes in turn, one request at a time). Cold: a fresh next start per route, then that route's first request on a new connection. Percentiles: nearest rank (p95 of 50 runs is the 48th fastest). Reads: 5 counted runs per route.

Times in milliseconds. "Sent" is the response body as this server sent it (local `next start` sent the edge-runtime responses uncompressed); "gzip est." is that body gzipped here, roughly what a compressing CDN would send. "First-visit JS/CSS" is the `/_next/static` files the page names, fetched once each, as sent. Reads are SQL reads per request on a warm server (the route's first request after start in brackets), over all three databases. "Repeated" counts reads that ran again with the same arguments in the same request. A round trip is one HTTP request from the page to a database. "Rows read" is sqld's own count of rows it looked at. "From DB" is the database's answers as sent (sqld gzipped them), with what the page had to parse in brackets.

| Page | Request | TTFB p50 / p95 | Total p50 / p95 | Cold TTFB / total | Sent | gzip est. | First-visit JS/CSS | Reads (first) | Repeated | Round trips | Rows read | From DB (parsed) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Home | `GET /` | 56.2 / 83 | 57.4 / 85.3 | 709.1 / 710.8 | 222.7 KB | 20.4 KB | 306.2 KB | 24 (26) | 0 | 24 | 5346 | 62.7 KB (648.7 KB) |
| Product page | `GET /products/micronised-creatine-12` | 32 / 46.8 | 37.6 / 54.8 | 401.6 / 417.7 | 84.9 KB | 13.0 KB | 308.4 KB | 10 (12) | 3 | 10 | 1407 | 58.9 KB (637.7 KB) |
| Collection page (one category) | `GET /collections/protein` | 28.2 / 43.7 | 37.7 / 60.7 | 437.2 / 461 | 173.4 KB | 14.2 KB | 306.1 KB | 9 (11) | 1 | 9 | 1794 | 57.1 KB (636.7 KB) |
| Collection page (shop all, 400 products) | `GET /collections/shop-all` | 27.9 / 45.4 | 40 / 62.8 | 371 / 392.9 | 198.9 KB | 19.1 KB | 306.1 KB | 9 (9) | 1 | 9 | 5766 | 58.0 KB (639.0 KB) |
| /collections | `GET /collections` | 30.4 / 43.4 | 31.3 / 45 | 390.4 / 391.5 | 114.2 KB | 12.2 KB | 305.0 KB | 4 (6) | 1 | 4 | 2686 | 55.1 KB (623.4 KB) |
| Search | `GET /search?q=protein` | 31.8 / 42.1 | 33.6 / 42.7 | 417.7 / 419 | 157.1 KB | 14.7 KB | 306.0 KB | 4 (6) | 0 | 4 | 1797 | 55.2 KB (628.0 KB) |
| CMS page (a policy) | `GET /policies/refund-policy` | 27.4 / 35.1 | 28.8 / 36.8 | 369.8 / 370.9 | 53.5 KB | 9.2 KB | 306.5 KB | 3 (5) | 0 | 3 | 1344 | 54.1 KB (617.1 KB) |
| Journal index (60 posts) | `GET /journal` | 28.4 / 34 | 29.7 / 35.7 | 383.1 / 384.1 | 90.4 KB | 12.1 KB | 305.0 KB | 3 (5) | 0 | 3 | 1344 | 54.1 KB (617.1 KB) |
| Cart API, read (3 lines) | `GET /api/cart` | 4.6 / 6.8 | 4.7 / 6.8 | 383 / 383.5 | 1.6 KB | 650 B | – | 3 (5) | 0 | 3 | 29 | 2.2 KB (9.7 KB) |
| Cart API, change a quantity | `POST /api/cart` | 5.7 / 7.9 | 5.8 / 8 | 327.3 / 328 | 1.6 KB | 650 B | – | 3 (3) | 0 | 5 | 31 | 2.6 KB (10.3 KB) |
| Checkout, first step | `GET /checkout` | 35.7 / 51.3 | 37.3 / 52.9 | 426.2 / 427.3 | 55.0 KB | 9.7 KB | 310.0 KB | 9 (11) | 3 | 9 | 1402 | 58.4 KB (636.5 KB) |

**Candidates for PERF-06** (not fixed here):
- Slowest on a warm server: home (57.4 ms p50), collection-all (40 ms p50), collection (37.7 ms p50).
- Slowest cold: home (710.8 ms), collection (461 ms), checkout (427.3 ms).
- Most reads: home (24 reads, 24 round trips), product (10 reads, 10 round trips), collection (9 reads, 9 round trips).
- Reads repeated with the same arguments in one request: product: 2× `select * from "products" where "handle" = ?`; 2× `select * from "product_images" where "product_id" = ? order by "position" asc`; 2× `select * from "variants" where "product_id" = ? order by "position" asc`. collection: 2× `select * from "collections" where "handle" = ?`. collection-all: 2× `select * from "collections" where "handle" = ?`. collections: 2× `select "c"."handle", "c"."title", "c"."image", "c"."image_alt", count("cp"."product_id") a`. checkout: 2× `select "id", "coupon_code" from "carts" where "id" = ?`; 2× `select "ci"."variant_id", "ci"."product_id", "ci"."quantity", "ci"."price_at_add", "v"."ti`; 2× `select * from "offers" where "enabled" = ?`.
- Most rows read: collection-all (5766 rows, most by `READ select "p"."product_type", count("p"."id") as "n" from "products" as "p" inner join "` at 1617), home (5346 rows, most by `READ select "c"."handle", "c"."title", "c"."image", "c"."image_alt", count("cp"."product_i` at 1342), collections (2686 rows, most by `READ select "c"."handle", "c"."title", "c"."image", "c"."image_alt", count("cp"."product_i` at 2684).
- Most parsed from the database per request: home (648.7 KB, 62.7 KB as sent), collection-all (639.0 KB, 58.0 KB as sent), product (637.7 KB, 58.9 KB as sent).

Not measured: Edge memory: Next's local edge sandbox runs inside one Node process, so no per-request or per-isolate memory figure exists locally. It needs the hosted runtime (OQ-19). Hosted latency: Turso and the hosted edge add network time between the page and its database; here every database call stays on this Mac. Images: product and page photos (/_next/image, /api/media) are not fetched.
