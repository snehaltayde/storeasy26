# P1 · IMAGES · Library photos through next/image

Branch `cms/p1-images`, cut from `d890d80`. Source of the bug: PERF-04 finding 1 (`docs/cms-reviews/P1-PERF-04.md`, "Findings outside this item") and P1-DRILLS-C finding 3 (`docs/cms-reviews/P1-DRILLS-C.md`, "Finding 1 under `next dev`").

This is the builder's own report. Reviewers should re-read the code.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes. Every `next/image` in the app now goes through `components/StoreImage.js`, which sends library photos (`/api/media/<id>`) unoptimized. Shopify photos still go through the optimizer |
| Locally tested | Yes. `pnpm test`: **56 of 56 suites passed** (the new `test:images` included). `test:images`: 11 passed on this branch, **9 of 11 fail on `d890d80`**. `pnpm build` exit 0 |
| Browser verified | **Yes, on this Mac.** Desktop Chrome 156 (headless) on the design harness with the perf fixture, under `next dev` **and** a production build (`next start`): 63 passed, 0 failed each. `drill:edge` rerun on the production build with the perf fixture: its image checks now pass |
| Staging verified | **NOT DONE. Staging is unverified.** No hosted runtime exists (OQ-19). Owner check 1 below |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What was wrong

On the perf fixture every product photo, collection card photo, search result photo, cart photo and checkout photo was a grey box. Each one was a `next/image`, so the browser asked `/_next/image?url=/api/media/med_…&w=…&q=75`, and that answered **400 "The requested resource isn't a valid image."** This happened under `next dev` and under `next start`. The same photo asked for directly (`/api/media/med_…`) answered 200 `image/webp`.

Shoppers see this on any store whose photos come from the media library rather than the Shopify CDN.

## The cause (proven, not guessed)

1. `/_next/image` with a local url (one starting with `/`) doesn't make a network request. Next calls its own request handler with a made-up request: `fetchInternalImage` in `node_modules/next/dist/server/image-optimizer.js` (Next 16.2.9, lines 1013-1023) calls `createRequestResponseMocks({ url, method, socket, maximumResponseBody })`. It passes no headers, and `createRequestResponseMocks` defaults `headers` to `{}` (`next/dist/server/lib/mock-request.js`). So that request has **no `Host`**.
2. `/api/media/[id]` is wrapped in `tenantHandler` (`lib/tenant-request.js`). It reads `request.headers.get("host")` and calls `resolveHost`. In platform mode `resolveHost` returns `{ outcome: "unknown" }` when the host is missing (`lib/platform/control.js:88`). `tenantHandler` then answers the gate's JSON, `{"error":"Store not found","code":"TENANT_UNKNOWN"}`, status 404.
3. The optimizer doesn't check the status. It sniffs the bytes it got (the JSON), finds no image type, and throws `ImageError(400, "The requested resource isn't a valid image.")` (`image-optimizer.js:1076-1080`).

Seen on the real harness before the fix (`next dev`, perf fixture, `d890d80`), in the server log ([before-dev-server-log.txt](drills/IMAGES/before-dev-server-log.txt)):

```
GET /api/media/med_ae5f4af4b10aec0b01 404 in 551ms        <- the optimizer's own request: no Host, 404
⨯ The requested resource isn't a valid image for /api/media/med_ae5f4af4b10aec0b01 received null
GET /api/media/med_ae5f4af4b10aec0b01 200 in 55ms         <- curl with the store's host: 200
GET /api/media/med_ae5f4af4b10aec0b01 404 in 2ms          <- curl with Host: other-store.example: 404
```

The browser got 400 for `/_next/image?url=%2Fapi%2Fmedia%2Fmed_ae5f4af4b10aec0b01&w=640&q=75`.

## The fix, and why this one

**The choice: library photos skip the optimizer.** `components/StoreImage.js` renders `next/image` with `unoptimized` when the src starts with `/api/media/` (`lib/image-src.js`, `isLibraryMedia`). The browser then asks `/api/media/<id>` itself, with the real `Host`, and the route picks the store as it always has. Every other image (the Shopify CDN) is optimized exactly as before. The 10 files that imported `next/image` now import `@/components/StoreImage`. `test:images` fails if any file in `app/`, `components/` or `lib/` imports `next/image` directly again.

Options considered:

| Option | Verdict | Why |
|---|---|---|
| Make `/api/media` answer the optimizer's host-less request | **Rejected: it opens a cross-tenant hole** | The optimizer's cache key is only `(url, width, quality, type)`: `ImageOptimizerCache.getCacheKey` (`image-optimizer.js:677-685`) has no host. A host-less request also can't say which store it is for. If the route answered it (for example from a default store, or a header Next doesn't send), the first store to show `/api/media/med_x` would fill a cache entry that any other store's host could read back through `/_next/image?url=/api/media/med_x`. There is no safe way to pass the store into that request |
| A custom loader that serves `/api/media/<id>?w=<width>` | Rejected for now | The route can't resize (no image library on the edge or in serverless, and no new dependencies). The `w` param would make one url per width for the same bytes, so the browser would download the same photo more than once. A global `loaderFile` would also take over the Shopify images |
| `unoptimized` for `/api/media` only | **Chosen** | Correct on every host. The request carries the real `Host`, so a photo is only ever served on its own store's hosts. It keeps the route's far-future `immutable` cache and its SVG headers (CSP, `nosniff`). On Vercel, library photos never reach Vercel's image service, so the result doesn't depend on how that service fetches a local url, which host it sends or how it keys its cache. None of that was checked, so not depending on it is the safe choice. It also costs no Vercel image-optimization usage for library photos |

The optimizer path stays closed: `/_next/image?url=/api/media/…` still answers 400 after the fix (shown below). Nothing the app renders uses it any more.

What changed:

- `lib/image-src.js` (new): `isLibraryMedia(src)`, `imageSrcPath(src)`. Pure, no imports, safe on the edge and in the browser.
- `components/StoreImage.js` (new): the wrapper. No hooks, so server and client components both use it. An explicit `unoptimized` still wins.
- The 10 files that used `next/image`: `components/FadeImage.js` (product cards and the product page's main photo), `ProductGallery.js`, `CollectionCard.js`, `SearchBox.js`, `QuizRunner.js`, `cart/CartDrawer.js`, `checkout/CheckoutFlow.js`, and the bundle, order and order confirmation pages under `app/(storefront)/`. Only the import line changed in each.
- `scripts/test-copy.js`: its stub tables stubbed `next/image`. They now stub `@/components/StoreImage` the same way (it failed with `unstubbed import "@/components/StoreImage"` until then).
- `scripts/test-images.js` (new, `pnpm test:images`) and `scripts/drills/p1/images.mjs` (new browser drill).
- The media route, `lib/tenant-request.js`, `lib/media.js` and `next.config.mjs` are **not** changed.

## Acceptance

Tags: **unit** = `test:images` (plain node, real `next/image` rendered with react-dom/server). **browser** = desktop Chrome 156 (headless) through `scripts/drills/p1/run.mjs images` on this checkout's design harness, ports 3261 and 18310-18312, seeded with `node scripts/dev-design.js seed --fixture perf`. **manual** = curl on the same harness.

| # | Item | How | Result | Evidence |
|---|---|---|---|---|
| 1 | Product page photos are drawn, under `next dev` | browser | Pass | `/products/micronised-creatine-12`: 10 of 10 images drawn at 1440 and at 375, all as `/api/media/…`, 0 failed image responses. [dev-product-1440](drills/IMAGES/dev-product-1440.png), [dev-product-375](drills/IMAGES/dev-product-375.png), `results-dev.json` |
| 2 | Same, on a production build (`next start`) | browser | Pass | Same numbers. [prod-product-1440](drills/IMAGES/prod-product-1440.png), [prod-product-375](drills/IMAGES/prod-product-375.png), `results-prod.json` |
| 3 | Every `next/image` library photo shows: home, both collection pages, `/collections`, search, cart drawer, checkout | browser | Pass, dev and prod | Per page, images drawn / total: home 58/58 (1440 and 375), collection 40/40 (1440 and 375), shop-all 40/40, `/collections` 27/27, search 36/36, cart drawer after Add to cart 14/14, checkout 1/1. No library photo went through `/_next/image`. No 4xx or 5xx from `/_next/image` or `/api/media` on any page. 63 passed, 0 failed in each of `results-dev.json` and `results-prod.json` |
| 4 | A content page's image section (plain `<img>`, not `next/image`) still shows | browser | Pass, dev and prod | `/policies/<a fixture page with an image section>`: 1 of 1 drawn. [prod-cms-page-1440](drills/IMAGES/prod-cms-page-1440.png) |
| 5 | Shopify CDN photos still go through the optimizer | unit | Pass | "StoreImage: a Shopify photo still goes through the optimizer" and "product page gallery: Shopify photos still go through the optimizer": src `/_next/image?url=https%3A%2F%2Fcdn.shopify.com…`, srcset kept. Not browser-checked: the perf fixture has no Shopify photos |
| 6 | NEGATIVE: a store's photo is never served on another store's host | manual + unit | Pass | `/api/media/med_ae5f4af4b10aec0b01` with `Host: other-store.example` → 404 `TENANT_UNKNOWN`, under dev and prod ([after-dev-curl.txt](drills/IMAGES/after-dev-curl.txt), [after-prod-curl.txt](drills/IMAGES/after-prod-curl.txt)). Unit: "NEGATIVE: the media route still answers only for the store whose host asked" (GET still wrapped in `tenantHandler`, no `allowUnresolved`; no `dangerouslyAllowSVG`, no global loader). The route is unchanged (`git diff d890d80 -- 'app/api/media'` is empty) |
| 7 | NEGATIVE: the optimizer can't be used to read a library photo | manual | Pass | `/_next/image?url=%2Fapi%2Fmedia%2Fmed_ae5f4af4b10aec0b01&w=640&q=75` → 400 under dev and prod, after the fix (same files). So the host-less cache can't be filled with a store's photo |
| 8 | Private/unpublished media rules unchanged | code | Pass | `lib/media.js`, `app/api/media/[id]/route.js` and `lib/tenant-request.js` are untouched. The fix only changes which url the page writes into `<img src>` |
| 9 | Edge runtime | manual + build | Pass | The new code imports only `next/image` and a pure module (no `node:` APIs). On the production build the product page answers with `x-edge-runtime: 1` ([after-prod-curl.txt](drills/IMAGES/after-prod-curl.txt)). `pnpm build` exit 0. `/api/media/[id]` stays on its existing `nodejs` runtime, as before |
| 10 | Tests fail on `d890d80` and pass after | unit | Pass | `test:images` on a clean export of `d890d80` (same `node_modules`): **2 passed, 9 failed** ([test-images-on-d890d80.txt](drills/IMAGES/test-images-on-d890d80.txt)). The key one fails for the real reason: "a library photo went to the optimizer: /_next/image?url=%2Fapi%2Fmedia%2Fmed_ae5f4af4b10aec0b01&w=3840&q=75 …" from the real `ProductGallery`. On this branch: 11 passed, 0 failed |
| 11 | `pnpm test` and `pnpm build` | unit | Pass | 56 of 56 suites; build exit 0 |
| 12 | `drill:edge` on the perf fixture | browser | See below | |

### `drill:edge` on the perf fixture, rerun

Production build, perf fixture, after the commit (so its "git diff HEAD -- app is empty" check holds): **134 passed, 4 failed** ([edge-perf-prod.log](drills/IMAGES/edge-perf-prod.log), [edge-perf-prod.json](drills/IMAGES/edge-perf-prod.json)). The run wrote into the committed `drills/P1-HARNESS/` folder; its log and `results.json` were copied here and that folder was put back with `git checkout`.

- **Now passing** (they failed in P1-DRILLS-C's run on the perf fixture, because of the 400s): "storefront: no console errors or page errors on any page above" and "storefront: no failed requests and no 4xx/5xx answers on any page above".
- **Still failing, not image related, the same as P1-DRILLS-C:** the home page's "shows one of 'Makeup second' / 'Visibly brighter'" at 1440, 768 and 375 (the drill expects the demo's live hero words, which the fixture's home page doesn't carry), and the drill stopping in the product page designer because "Radiance Glow Serum 30ml" isn't on the picker's first page of 400 products. P1-DRILLS-C finding 5 covers both as drill changes.
- P1-DRILLS-C's run was under `next dev` (132 passed, 6 failed). This one is on a production build. I did not rerun it under `next dev`; the IMAGES drill covers dev.

### Mutation check on `test:images`

Each break was made by hand, the suite run, the file put back:

| Break | Caught |
|---|---|
| M1 the wrapper never sets `unoptimized` | Yes, 3 failed |
| M2 `isLibraryMedia` matches `/api/media` anywhere in the url | Yes, 1 failed |
| M3 the wrapper makes every image unoptimized (Shopify too) | Yes, 2 failed |
| M4 `SearchBox.js` imports `next/image` directly again | Yes, 2 failed |
| M5 a static-import object `{ src }` is ignored | Yes, 1 failed |

## Known limits

1. **Library photos are sent at full size.** No resizing, no WebP/AVIF conversion, no `srcset`. A 48 px cart thumbnail downloads the whole photo (the fixture's are about 120 KB; the upload cap is 1.5 MB). `loading="lazy"` still applies, and the photo is cached for a year, so a photo seen once costs nothing after. The uploader already makes smaller copies in the browser (variant rows in `media`), so a later item could pick the right copy per width. That belongs with PERF-06; it is not done here.
2. **Absolute urls to a store's own `/api/media`** (`https://shop.example/api/media/…`) are not treated as library photos. The app never writes them (`mediaUrl` and the pickers write `/api/media/<id>`), and `next.config.mjs` doesn't allow such hosts anyway.
3. **Vercel not checked.** The reasoning above says the fix doesn't depend on Vercel's image service, but staging has not shown it (owner check 1).
4. The harness has one store, so the cross-store check uses a host that resolves to no store rather than a second real store. The route itself is unchanged. No suite tests `/api/media` with two real stores; that was true before this item too, and owner check 2 covers it on staging.
5. The quiz, bundle and order pages also use the wrapper, but the drill didn't open them. They're covered by the source check in `test:images` only.

### From review

Non-blocking findings from the independent review, added at merge.

- Library photos are now sent at full size with no srcset, so the product gallery and cards download the original bytes at every width. Before this change they were broken (400), so nothing got worse. Matching the uploader's smaller copies to each width belongs in PERF-06, as the builder says.
- The perf fixture has only library photos, so no Shopify CDN photo was checked in a browser after the change. The only proof that Shopify photos still go through /_next/image with a srcset is the unit render in test:images (StoreImage and ProductGallery). That test passed, and the builder did not change next.config.mjs.
- In single-tenant mode (PLATFORM_DB_URL unset), resolveHost returns 'legacy' and the optimizer's host-less request would have worked. In that mode library photos now also skip resizing. This is harmless, but the report's root-cause text only describes platform mode.
- My drill:edge run on the production build gave 137 passed, 1 failed. The builder reported 134 passed, 4 failed. The one failure left is the same stop at the product picker seen in batch C ('locator.click: Timeout 30000ms'). The 3 home hero failures the builder listed did not happen in my run. Both runs agree that the console-error and failed-request checks now pass. The difference is in checks that have nothing to do with images, so the report's counts are slightly stale and nothing more.
- 'Edge runtime compatible' holds for the storefront pages and the new code (lib/image-src.js is pure, and the product page answers with x-edge-runtime: 1). The /api/media route itself still runs as runtime 'nodejs', as it did before. The report could say this more clearly.
- isLibraryMedia trims leading spaces, so a src like ' /api/media/x' is treated as a library photo but passed to `<img>` with the space still in it. No test covers this case. It is cosmetic only and has no security effect.

## Owner checks

These belong in `docs/cms-reviews/MANUAL-CHECKS.md` when this branch merges (not added there here, to keep this branch from clashing with the other batch D branches).

1. **Library photos on Vercel staging** (replaces PERF-04 owner check 6). Open a product whose photos come from the media library, a collection page and the cart. Pass: every photo shows, and in the browser's Network tab the photos load from `/api/media/…` (200), not `/_next/image`.
2. **Same photo, two stores.** With two stores on staging, open store A's `/api/media/<id>` on store B's domain. Pass: 404.
3. **Page weight on a phone** (PERF-04 owner check 4, now possible). On a mid-range phone, open a collection page with library photos and note the transferred bytes. Pass: you find it acceptable; if not, the per-width copies (known limit 1) move up.

## How to rerun

```
node scripts/dev-design.js seed --fixture perf
DESIGN_PORT=3261 DESIGN_SQLD_PORT=18310 node scripts/dev-design.js                       # next dev
DESIGN_PORT=3261 node scripts/drills/p1/run.mjs images dev
# stop it, then
DESIGN_PORT=3261 DESIGN_SQLD_PORT=18310 node scripts/drills/p1/prod-harness.mjs build
DESIGN_PORT=3261 DESIGN_SQLD_PORT=18310 node scripts/drills/p1/prod-harness.mjs start    # next start
DESIGN_PORT=3261 node scripts/drills/p1/run.mjs images prod
pnpm test:images
```

Every server started for this item was stopped (ports 3261 and 18310-18315 closed at the end).
