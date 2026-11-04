# P4 · EFFECTIVE · One effective read of product content

Branch `cms/p4-effective`, cut from `17a08b7`. Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 1, 3 and 13; section 3; batch 2) and `P4-BATCHES.json`. Requirements: OVL-03, OVL-05 (the SQL half), OVL-06 (its loose ends) and SHOP-02.

Migrations owned: none. `lib/content/resolve.js` was not edited. No P3-FIX5 file, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `package.json`, `MANUAL-CHECKS.md` or anything under `.github/` was touched.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 163.2 s. `test:effective-read` 38 passed in about 2.5 s. `test:order-catalog` 17 passed; `test:shopify-boundary` 42 passed. `pnpm build` passes (only the existing edge-runtime warnings) |
| Browser verified | Yes, a short drill on the design harness (ports 6100 and 7100 to 7102), in the desktop app's own browser pane, which is narrow (phone-width layout). Not a full desktop Chrome drill, not Safari, not a phone. Details below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso or a real tenant |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

Before this item, every shopper surface read the product's title, description, images, vendor and type straight from the synced catalog tables, each in its own way (`selectAll`, constants, joins). A founder's published edit (`product_content_live`, migration 0024, written by P4-LIVEROW's publish) would have shown in some places and not others, and search would have kept finding the old name. This item adds one module that every shopper path reads product content through, moves every shopper reader onto it, and closes OVL-06's loose ends: gift lines, and Shopify's title and the SKU never reaching a browser.

## Design

### (1) `lib/catalog/effective.js` (new, edge-safe)

Kysely over `lib/db.js`; no `node:` import. Effective values are `COALESCE(c.x, p.x)` over `products p LEFT JOIN product_content_live c`.

- **Shape.** `title`, `description`, `description_html`, `display_type`, `display_vendor`, `featured_image`, `featured_image_alt`, `seo_title`, `seo_description`, `og_image`; `logic_tags` (parsed) and `logic_type` carry Shopify's raw tags and product type for logic. There is no `product_type`, `vendor` or `tags` key, so a component that reads `product_type` gets undefined. modules, badge, pairs and template are not read (P4-OVL07).
- **Rules.** Null follows Shopify; an empty string is a real value. The featured image's alt follows its image: when the founder's image or gallery is live, its own alt is used (possibly null), never Shopify's. A live gallery (`[{url, alt}]`) replaces `product_images` on the product page and its first item is the featured image. A live `description_html` with no plain `description` gets a plain text derived from it (`plainFromHtml`), so the page, the meta description and JSON-LD agree.
- **Selectors.**
  - `cardRows(opts)`: one statement. Options: `ids`, `handles`, `availableOnly`, `collection {handle, sort, inStock, type, pins}` (the type filter is Shopify's raw type by design), `sharedWith` (the automatic pairs, ordered by shared count, then the effective title), `order` (`newest`, `title`), `limit`, `offset`, `logic`.
  - `byIds(ids, {availableOnly, logic})`, `collectionCount({handle, inStock, type})`.
  - `productPage(handle)`: the product, then its variants and (without a live gallery) Shopify's photos together. Three statements at most, as before; two with a live gallery.
  - `cartRows(cartId)`: the cart lines with `title` (effective), `catalog_title` (raw `p.title`), `sku` (variant), `logic_tags`, `logic_type`. One statement.
  - `giftRows(variantIds)`: `live_title` (the founder's published title only), `catalog_title`, `sku`, by variant.
  - `search(q, limit)`: every word must match the effective title, display type or vendor, or a raw tag; ranked in stock first, then effective-title prefix, then effective-title match, then effective title. One statement.
  - `indexRows({cursor, limit, ids})` for P4-SEARCH's `buildSearchDoc`: pages by product id (`{rows, cursor}`, cursor null after the last page); `ids` limits it to those products and skips ids that are not products. Each row: id, handle, effective title, description pair, display type and vendor, featured image and alt, raw `logic_tags` and `logic_type`, prices, currency, availability, `collection_ids`.
  - `displayHits(result)`: maps a Typesense answer's `product_type` to `display_type`, so the search route and page show one shape.
- **Fallback.** Whether a database has the live table is asked once with `hasColumns` (`lib/schema-compat.js`): present is remembered for the life of the instance, absent is asked again after 60 s, per database instance (one per tenant URL). Without the table every selector reads raw with the same shape. If a joined read still fails with "no such table" (a race the probe cannot see), it is retried raw and that database reads raw for the next 60 s.

### (2) The shopper readers moved onto it

- `lib/repo.js`: `getNewestProducts`, `getProductByHandle`, `getProductsInCollection` (cards and the total), `searchProductsInDb`. `getCollectionTypeFacets` stays on the raw type by design.
- `lib/cart.js` `getCart` (lines on `cartRows`; the offer engine gets the raw `logic_type` and `logic_tags`).
- `lib/wishlist.js`, `lib/quiz.js` (results and the quiz email show effective values; scoring reads `logic_tags`; ties order by the title shown; results say `display_type`), `lib/bundles.js` (component title and image).
- `lib/cms/placements.js`: `productsByIds` and the automatic pairs (ordered by the effective title). The strips keep their old keys (no type label added).
- The product page: metadata title and description (founder SEO fields first, then title and trimmed description), Open Graph image (`og_image`, then the featured image), JSON-LD name, description and brand (`display_vendor`), the breadcrumb's `display_type`, the `view_item` event's name. `components/pdp/PdpLayouts.js` vendor line, `components/ProductCard.js` and `components/SearchBox.js` labels (`display_type`), `app/api/search/route.js` and the search page.
- The offer engine, the facets and the collection type filter stay on raw values.

### (3) Gift lines

At cart read, each gift line is resolved by its variant (`giftRows`): when the founder has published a title for that product, the gift line shows it; otherwise the title the offer stored stays (see Known limits for why not Shopify's title). Every gift line now carries `catalog_title` and `sku`, which `lib/orders.js` already freezes on gift rows (no change needed there). A gift whose variant is not in the catalog keeps its stored title with no Shopify title or SKU.

### (4) OVL-06's ends and the cart leak

`shopperCart(cart)` in `lib/cart.js` strips `catalog_title` and `sku` from items and gift lines and changes nothing else. Applied at: every `/api/cart` answer (the route's own `getCart` is the projection), the storefront layout's `initialCart` (CartProvider's prop), the checkout page's CheckoutFlow prop, and the checkout API's price-changed answer (its only answer that carries a cart). `createOrder` keeps the full server-side cart. `test-order-catalog`'s source pin is updated and its fake "retitle" is now a real live row.

### (5) The guard (in `test-effective-read`)

Column-aware. From every storefront page and layout, `app/sitemap.js`, `app/robots.js` and the shopper API routes (`account`, `cart`, `checkout`, `contact`, `errors`, `exp`, `leads`, `media`, `quiz`, `razorpay`, `search`, `track`, `upsell`, `wishlist`), imports are followed function by function (a module's top-level declarations count when imported by name, plus what they use in the same file; namespace and bare dynamic imports count everything). Every statement there that reads `products` or `product_images` is scanned: `selectAll()`, column literals with their table alias, raw SQL text, spread or mapped column constants (resolved in the file), and column lists it cannot read (counted as content). Content columns: title, description, description_html, product_type, vendor, featured_image, featured_image_alt; url and alt of product_images.

Allowlist, exactly five, each checked to exist and to read only its stated columns:

| Statement | Columns | Reason |
|---|---|---|
| `app/sitemap.js` `buildSitemap` | handle, updated_at | addresses only |
| `lib/customers.js` `buildReorder` | id, handle, available | reorder checks existence and stock |
| `lib/cms/placements.js` `resolveHandles` | id, handle | typed handles to ids (the spec's placements.js:62) |
| `lib/repo.js` `getCollectionTypeFacets` | id, product_type | the filter's facets: raw logic by design |
| `lib/content/resolve.js` `cartPlacementRows` | id, handle | the cart slot's handles to ids (the plan's resolve.js:669) |

One scope boundary: `lib/platform/worker.js` (the job runner a shopper route can start after its response). Its catalog reads are the sync's and the Typesense builder's (`lib/sync.js` `indexTypesense`), which P4-SEARCH moves onto `indexRows`.

### (6) Speed

Measured with `helpers/perf.mjs` (scratch, not committed), library level, 500 products with 5 photos each, a 3-line cart, 200 warm calls, local file databases, load average about 3.9, on this branch and on 17a08b7 (the change stashed):

| Case | getCart p50 / p95 ms | statements | product page p50 / p95 ms | statements |
|---|---|---|---|---|
| 17a08b7, newest schema | 0.147 / 0.190 | 3 | 0.149 / 0.186 | 3 |
| this branch, newest schema, no live rows | 0.170 / 0.262 | 3 | 0.198 / 0.271 | 3 |
| this branch, every product with a live row | 0.151 / 0.211 | 3 | 0.192 / 0.235 | 3 |
| this branch, 0023 (no live table) | 0.142 / 0.170 | 3 | 0.176 / 0.221 | 3 |

PERF-04 baseline (MANUAL-CHECKS "Speed baseline", P1-PERF-04, HTTP through Next on the harness): cart API read 3 database reads, total p50 4.7 ms; product page 10 database reads (each product read twice: metadata and page), total p50 37.6 ms. The effective join adds **no statement** to either read (proven in the suite: getCart 3 and product page 3, with and without the live table; 2 with a live gallery). The only extra statements: the live-table probe, once per database per instance (again once a minute while a database has no table), and one statement on a cart whose offers grant a gift. The added work per read is a few hundredths of a millisecond locally; on hosted Turso the cost is the round trips, which are unchanged. Hosted numbers wait for OQ-19.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | The guard passes with exactly the listed allowlist; a planted `selectAll()` from products in a storefront lib file fails it | **DONE** | `test-effective-read` §1: "the guard passes … exactly the listed allowlist", "every allowlist entry is a real statement…", "a planted selectAll() … fails the guard" (lib/wishlist.js), plus spread constant, mapped constant, unreadable list, raw SQL and product_images plants, and narrowness (an extra column on an allowed statement, a content read elsewhere in that file). With the reader changes reverted, the first test fails |
| 2 | With a live row titled 'New': card, product page (title, meta title, JSON-LD), cart, checkout props, confirmation, the shopper order page, search (SQL), wishlist, quiz result and email, bundle, pairs and TrackEvent all show 'New'; search finds 'New' at once and orders by it | **DONE** | §3, eight tests. The product page, confirmation, order status page, checkout page and card are the real files compiled with Next's SWC and rendered; the quiz email goes through the real `/api/quiz/[slug]` route and the queued notification is read back. All fail with the readers reverted |
| 3 | A published description_html renders on the product page and feeds the meta description and JSON-LD description | **DONE** | §4 (also a plain description, and the SEO fields). Fails reverted |
| 4 | A display type or vendor shows on card, search, breadcrumb, vendor line and JSON-LD, and never changes offers, type filter or facets | **DONE** | §5 "a display type and vendor show…" (fails reverted) and "negative: … never changes which offers apply…" (a negative: it also holds before the change) |
| 5 | Orders freeze the effective title and raw catalog_title, normal and gift lines; a past order is unchanged after a later change; a gift line shows the effective title in the cart | **DONE** | §6, three tests (fail reverted). Also `test-order-catalog` with real live rows |
| 6 | No cart reaching the browser contains catalog_title or sku; createOrder still receives them; test-order-catalog and the SHOP-02 sentinel (gift and bundle descriptions) pass | **DONE** | §7: `shopperCart`, every `/api/cart` answer through the real route, the layout's `initialCart` (the real layout compiled, plus a pin that CartProvider gets that cart), the checkout page prop, the checkout API's 409 answer and the order it then places through the real route (lines carry Shopify's title and SKU), and a source check that every `getCart` in `app/` is wrapped. `test-shopify-boundary`: the new SHOP-02 (OVL-03) test builds the cart through the effective read with live titles on a paid line, a gift and both bundle components, checks they are on the order, pushes, and finds none on the wire; the discount description is exactly the offer and bundle titles |
| 7 | A draft-only edit never reaches cart, search, sitemap or email | **DONE** | §8: a `documents` row with a draft title, no live row; cart, SQL search, `indexRows`, the real `app/sitemap.js`, the quiz email, the product page and an order. A negative: it also holds before the change |
| 8 | At stage 0023 the cart, product page, search and order creation work and match today's outputs | **DONE** | §2: a snapshot recorded at 17a08b7 on the same fixture (`helpers/snapshot.mjs`, change stashed) is embedded in the suite; both a 0023 tenant and a newest-schema tenant with no live rows equal it, with only the documented differences (see Known limits). Fails reverted (the shape differs) |
| 9 | An overlay featured image never pairs with Shopify's alt; an empty string is respected; indexRows pages with no gaps; indexRows({ids}) returns exactly those rows and skips gone ids | **DONE** | §9, five tests |
| 10 | No node: import reachable from effective.js; the packet records getCart and product-page timings against PERF-04 | **DONE** | §10: the only one is `lib/tenant-context.js`'s `node:async_hooks` (pre-existing, provided by the edge runtime, as P4-SEAM recorded for resolve.js). `pnpm build` compiles effective.js into the edge cart route and storefront layout. Timings: "Speed" above |

### Browser drill (design harness, edge runtime)

`DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/dev-design.js`. Before: `/products/glow-serum` showed "Radiance Glow Serum 30ml", breadcrumb "Serums". A live row was written into the harness tenant's sqld (port 7101): title "Founder Glow Serum", display type "Night care", display vendor "Founder Labs", description_html "Founder story for the serum.". After a reload (no restart): heading, tab title, breadcrumb "Home / Night care / Founder Glow Serum", vendor line "Founder Labs", details, meta description, JSON-LD name, description and brand all showed the founder's values. Over HTTP on the same harness: `/api/search?q=founder` found it with `display_type` "Night care"; `?q=radiance` found nothing; `/api/cart` add and read answered "Founder Glow Serum" with no `catalog_title` or `sku`; the `/checkout` HTML showed the new title and no `catalog_title`. The row was removed, the harness stopped and ports 6100 and 7100 to 7109 were free afterwards. No screenshot is committed.

## Tests

- `scripts/test-effective-read.js` (replaces SCAFFOLD's placeholder; no `package.json` change): 38 tests, about 2.5 s, three file tenants (newest schema with live rows, newest schema without, stage 0023) plus a throwaway one for the race case.
- `scripts/test-order-catalog.js`: the fake retitle is now a real live row; the P1-FIX-C source pin is now a behaviour test plus the updated pin (cart.js takes catalog_title from effective.js, where it is `p.title`).
- `scripts/test-shopify-boundary.js`: `seedOverlay()` now writes a live row for the catalog product, and a new SHOP-02 (OVL-03) test (above).
- `test-storefront` and `test-surfaces` needed no change and pass.
- Fails-without-the-change: with `lib/repo.js`, `cart.js`, `wishlist.js`, `quiz.js`, `bundles.js`, `cms/placements.js`, `app/` and `components/` put back to 17a08b7 (effective.js kept), `test-effective-read` gave 8 passed, 30 failed. The 8 that still passed are the allowlist self-checks, the two negatives (display type is no logic, drafts are never read), the 0023 table check, and the three tests of effective.js alone (indexRows twice, node imports).

## Known limits

- **The read shapes changed on purpose**, so callers outside this item that read `product_type`, `vendor` or `tags` from these readers now get undefined: cards and search hits say `display_type`; the product page says `display_type`, `display_vendor`, `logic_tags`, `logic_type`; quiz results say `display_type`. Every storefront consumer was moved. Cards no longer carry the always-empty `tags: []` and `options: []`; the product page no longer carries the sync's own `sync_generation`.
- **Gift titles follow the founder's published title only.** The brief says to resolve the gift line's title by variant instead of the offer's stored title. Doing that with Shopify's title too would change what every legacy store's cart shows today (the BeastLife shaker's stored name differs from its Shopify name), which breaks "no live rows equals today". So: published title if any, else the stored title. One line in `lib/cart.js` `giftLines` changes this if the owner prefers Shopify's title.
- **A gift costs one more statement** per cart read, only when a gift applies.
- **Typesense tenants.** The search route and page map Typesense's `product_type` to `display_type`, but the index still holds Shopify's values until P4-SEARCH indexes through `indexRows`. The title gate keeps titles and display fields from being saved on those tenants until then.
- **An empty gallery** (`[]`) shows no photos and no featured image on the product page; cards follow the featured image column, which P4-LIVEROW writes from the gallery.
- **The guard's scope boundary** (`lib/platform/worker.js`) and its function-level reachability are this test's own reading of "shopper paths". A console-only function in a shared module (for example `lib/catalog-overrides.js` `listProductOverrides`, which reads `p.title`) is not a shopper read. The scan is regex-based over prettier-formatted code; a query split in unusual ways could escape it.
- **The speed numbers are library-level and local.** They are not comparable in absolute terms with PERF-04's HTTP numbers; the statement counts are.
- **No first-party publish writer yet.** Tests and the drill write `product_content_live` rows directly, as P4-LIVEROW's publish will.

From review:

- Gift line titles differ from the brief. Brief (3) says to resolve each gift line's title by variant through effective.js instead of the offer's stored title. lib/cart.js giftLines uses the founder's published title when there is one and otherwise keeps the stored title. So on a store with no published rows, a gift whose stored name differs from Shopify's (the fixture's 'Stored Shaker Name' vs 'Steel Shaker') still shows the stored name, which is not the effective title. The builder flags this as a conflict with 'no live rows equals today' in Known limits and lists it as an owner check. It is a real deviation from the acceptance wording, but it is disclosed, so it should stay an owner decision. The gift image also stays the offer's stored image, not the effective featured image. That is not mentioned anywhere.
- Weak test: quiz scoring. The test 'quiz scoring still uses Shopify's tags' never sets a display type that collides with a quiz tag. A mutation that adds display_type to the scoring tags (lib/quiz.js) passes all three suites. The code itself is correct (it scores on logic_tags).
- Weak test: the header search box. The SearchBox.js change to display_type has no test. Reverting it to r.product_type (which would silently hide the type label for every shopper) passes test-effective-read. Only the API hits are checked, not the rendered box.
- Guard blind spot, regex-based as already disclosed: a table name held in a variable, e.g. `const TB = "products"; db.selectFrom(TB).selectAll()`, gets past the guard. Planted raw libsql SQL, sql`title`, eb.ref('p.title'), a product_images url read, a vendor read through a variants join and an extra sitemap column were all caught.
- Typesense tenants: the search route and page only rename product_type to display_type. Hit titles and types stay Shopify's until P4-SEARCH. Disclosed, and the title gate covers it.
- A failed live-table probe (database unreachable) is not remembered, so that one read goes raw and could show Shopify's values for one request. Acceptable, but not stated in the packet.
- Verified: pnpm test passed 96/96 and pnpm build passed. I re-recorded the 17a08b7 snapshot myself, with the base lib/app/components files put back and the builder's snapshot.mjs: all 14 sections match the BASE embedded in the suite. 27 of 31 code mutations fail at least one of test-effective-read, test-order-catalog and test-shopify-boundary. Caught ones include: alt not following its image, raw title in search WHERE or ORDER BY, catalog_title made effective, logic_type made display, type filter or count on the display type, a missing shopperCart in the layout, checkout page, checkout API or on gift lines, gift title or catalog fields, JSON-LD brand, seo_title, og_image, meta description, breadcrumb, vendor line, card type, the gallery lead, the derived description, indexRows ids and cursor, the pairs order and the probe or statement counts. The 4 survivors are the quiz-scoring and SearchBox mutations above and NULLIF on title (empty titles are refused at validation, so harmless). The 2 remaining mutations crashed the suite (exit non-zero, no ✗ line): the type-filter variant that referenced the c alias without the join, and forcing the joined read with no live table. They count as caught, but they don't prove those specific checks bite. Harness on ports 6300 and 7300 to 7302 (edge runtime): after a live row was written, the search API, product page title, JSON-LD name and vendor line showed it, and /api/cart answered the effective title with no catalog_title or sku. The checkout page HTML had no catalog_title or sku either. I deleted the row, stopped the harness, confirmed the ports were free and removed worktree rv0.

## Owner checks

- OQ-7: confirm nothing client-side needs `catalog_title` or `sku` in the cart (they are now stripped from every cart a browser gets; the console order page reads them from the order, unchanged).
- Gift titles: confirm "the founder's published title, else the offer's stored title" (Known limits), or ask for Shopify's title instead.
- Hosted speed: once OQ-19 allows a staging tenant, measure the cart API and a product page there and confirm the read counts match the local ones (3 and 10 per PERF-04).
- CI: the sqld download in `.github/` still needs the owner's approval of its source and checksum; nothing here changed `.github/`.
