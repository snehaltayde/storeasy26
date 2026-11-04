# P4 · SEARCH · Search and the console read the names shoppers see

Branch `cms/p4-search`, cut from `509bf57` (`cms/phase-1` after batch 2). Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 1 and 15, section 3; batch 3) and `P4-BATCHES.json`. Requirements: OVL-05, OVL-03, OVL-04, OVL-06, OVL-17 (minimal, owner answer OQ-1 (b)). Migrations owned: none.

No store changes mode. No real or hosted store was used: every case runs on file databases (`scripts/support/tenant-fixture.js`), and the two browser drills ran on this worktree's design harness (ports 6100 and 7107 to 7109). Typesense was only ever "configured" with dummy localhost values inside a test process, and every call went to a spy client; the main suite refuses and records every `fetch`, and none was made. Nothing writes to Shopify. `lib/catalog/effective.js`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `package.json`, `MANUAL-CHECKS.md` and `.github/` were not touched.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 159.2 s after fix round 1 (sqld suites on 7100 to 7106). `test:search-effective` 28 passed (about 1.4 s), `test:product-content` 35 passed (about 1.7 s, its sqld part included), `test:refs` 11, `test:api-shapes` 33, `test:registry-contract` 35. `pnpm build` passes (its one Turbopack warning traces through `lib/platform/migrate.js`, as before this item) |
| Browser verified | Yes, two drills in desktop Chrome 156 (headless, `playwright-core`, the P3 drill library) on the design harness: the order page's Shopify-title line (computed contrast 7.73:1) and the product list on the perf seed (timed through the real console API). Not Safari, not a phone. Details below |
| Staging | **NOT DONE.** Nothing ran against hosted Turso or a real Typesense (owner checks below) |

## What and why

After batch 2 a founder's published product name reached every shopper page (P4-EFFECTIVE), but three things still showed or served Shopify's name: Typesense search (the full sync rebuilt it from `products`, and nothing reindexed a product after a publish), the console's own readers (the product picker, offers, upsells, reports) and nothing let the editor list every product. So the title gate (P4-LIVEROW) kept names closed everywhere. This item:

1. makes the full sync index the effective values through one builder;
2. reindexes one product within seconds of a publish, an Undo or a published Reset (the minimal OVL-17 the owner pulled in), with a durable retry and the full sync as the backstop;
3. moves every console reader onto the published name, with Shopify's name beside it;
4. adds the editor's product list (`listProductContent`);
5. fixes the order page's hard-to-read Shopify-title line;
6. then opens the title gate on every store, `_default` and Typesense stores included;
7. and closes the gaps the batch 2 review found in LIVEROW.

## Design

### (1) One search document builder; the full sync (`lib/catalog/search-doc.js`, `lib/sync.js`)

- `buildSearchDoc(row)` (new, pure, edge-safe) turns one `effective.js indexRows()` row into the document the collection schema holds: id and handle = the handle, `title` the effective name, `description` the effective plain text, `product_type` the type shown, `vendor` the brand shown, `tags` Shopify's raw tags (logic stays raw), image, price, currency, availability.
- `indexTypesense` (full sync) still drops and recreates the collection, then pages through `indexRows({ cursor, limit: 250 })` and imports each page with `buildSearchDoc`. A draft is never read; a published name is never replaced by Shopify's.
- The outbox, after the import:
  - the highest outbox rowid is read **before** the import reads the catalog; after an import with no refused document, pending rows up to it are marked done. A row written while the import ran has a higher rowid and stays pending;
  - every row written after that read, pending **or done**, is made pending again (`reopenAfter`, fix round 1): a fast drain may have written a newer name and marked its row done while a page the sync read earlier was still being imported, and that page then put the older name back;
  - then the one-product drain runs (`drainAll`), so such a row, or rows a dead queue or failed fast path left, converge here (the backstop);
  - done rows older than 30 days are deleted on every full sync, except the newest row of the table (the table has no AUTOINCREMENT, so deleting the highest rowid would let the next insert reuse it, and the drain's check below relies on rowids only growing);
  - a store without Typesense, or without its own namespace, marks every pending row done (bounded growth) and makes no client call.
- The Typesense admin client has a test seam in `lib/typesense-search.js` (`setSearchAdminClientForTest`), read by the full sync and the drain. Production never sets it.

### (2) The one-product reindex (`lib/catalog/search-reindex.js`, new)

- `drainSearchOutbox({ client, limit = 100, log })`, for the current store:
  - reads up to `limit` pending rows (rowid, product, handle), oldest first;
  - with Typesense not configured or no namespace: no client call, the rows are marked done;
  - reads the effective values with `indexRows({ ids })`, builds with `buildSearchDoc`, upserts them in one `documents().import(…, { action: "upsert" })` into `productsCollection()` (never another collection, never a drop or create); a refused document throws;
  - deletes the old entry of a product that is gone (or whose handle moved) by the handle its row stored. A `discard` row is written after the product left, so its handle is null (LIVEROW): the handle an earlier row of the same product stored is used. With none (pruned), the row is done and the next full sync rebuilds. A handle another product holds now is never deleted; a 404 on delete counts as done;
  - **before marking anything done (fix round 1)** it asks whether any outbox row, pending or done, was written for those products after the point where it read their values (the highest rowid, read just before `indexRows`). Several drains can run at once (the inline fast path keeps going after its 2.5 s cap, the job, the full sync's drain), and a write lands when its import returns, not when its values were read, so an overlapping drain may have written a newer name and marked its row done in between. If there is such a row, those products are read and written again. The last write to land for a product is then always one whose read saw every row before it; a row written after it is pending and drained later. After 5 rounds of this it throws ("these products kept changing…") and every row it read stays pending, for the job's backoff and the full sync;
  - marks done exactly the rowids it read.
- `kickSearchReindex()` (never throws): reads the highest pending rowid; with none, does nothing. Otherwise enqueues a durable `search_reindex` job (`enqueueDurable`) keyed `search_reindex:<tenant>:<rowid>`, so kicks for the same pending rows coalesce and a later publish gets its own job even though the first is done. Then it drains inline, awaited for at most `SEARCH_REINDEX_TIMEOUT_MS` (2.5 s; the pattern of `after-commit.js`, which is not edited). A throw is logged `search_reindex_failed`, a timeout `search_reindex_timeout`; the answer never changes.
- Triggers: `lib/admin/documents-api.js` calls it after a 200 (not a dry run) of publish, publishSet, unpublish, undo, undoSet and discardOrphanEdits. The job handler `search_reindex` in `lib/platform/worker.js` runs `drainAll()` under the job's store; a failure throws into the job's backoff. CUTOVER and REVERSE import the same `kickSearchReindex()`.
- Also in `worker.js` (P4-GUARD review): a catalog sync slice parked while the store is being updated is requeued 60 s later instead of on every tick.

### (3) Console readers

- `lib/admin/refs.js` (the picker the bundle, upsell, offer and editor forms share): products are read, searched (the published name, Shopify's name, the handle, a SKU) and sorted on `COALESCE(c.title, p.title)`; the cursor encodes that value and the id. `shopify_title` is added only when it differs, so a store with no live rows answers exactly as before.
- `lib/offers/catalog.js`: offer target names and example carts use the published name; logic (type, tags, which variants) stays raw.
- `app/api/admin/upsells/route.js`: each target carries `title` (published) and `shopify_title` when it differs. `app/api/admin/bundles/route.js` needed no change: its check echoes components through `lib/bundles.js`, which P4-EFFECTIVE moved onto `byIds`, and its picker is the refs variant picker.
- `lib/reporting.js` `currentProductTitles`: `effective.js byIds`, grouped by product id as before, so a renamed product keeps one row with its current name.

### (4) The editor's product list (`lib/admin/product-content-list.js`, new; `listProductContent` in `documents-api.js`)

`{ listProductContent: { q?, filter?, cursor?, limit? } }` (or `true`), storefront.read, checked for documents mode like `listChanges`. Every product, paged (1 to 100, default 30) in the order of the published name, each with the published name, Shopify's name when it differs, the edited flag (a live row, or a draft holding any setting or module), the live flag, the document id (null until opened) and `changedInShopify` / `changedFields`. `q` matches the published name, Shopify's name or the handle (LIKE characters are plain).

- `changed_in_shopify`: for each overlay field the DRAFT holds a value for, its `base_hash` is compared with `overlayBaseHash` of what Shopify sends now (image addresses without their query string, `service.js`). A field null in the draft never counts, so "Keep mine", "Use Shopify's" and Reset clear it at once, with no publish.
- `orphaned`: content documents (not archived, with edits or a live row) whose product is gone.
- `counts { all, edited, changedInShopify, orphaned }` for the shell, whatever the filter says. Shape in `documents-api-shapes.js`.

### (5) The order page

The "Shopify title: X, SKU: Y" line uses `SHOPIFY_LINE_CLASS = "text-xs text-fg-muted"` (`lib/admin/order-view.js`): `#52525b` on the white card, 7.73:1 (it was `text-fg-subtle`, `#a1a1aa`, 2.56:1).

### (6) The title gate (`lib/catalog/title-gate.js`)

- `TITLE_READERS_READY = true`, and the Typesense condition is gone (owner answer OQ-1 (b)). On every store the gate is open.
- The shape stays for a future gate: `CONDITIONS`, each with its own plain words for the save refusal, the publish belt and the Undo belt. The refusal always names the condition that blocked (orchestrator ruling); no condition speaks of search any more. `setTitleGateForTest` stays; a forced cause that is no condition gets neutral words.
- `TITLE_GATE_MESSAGE` is now those neutral words.

### (7) The LIVEROW review, closed

- `service.js normalizeOverlays`: a description is "the same as Shopify's" also when both are equal after the registry's sanitizer (what `prepare()` uses), so a description sent back cleaned follows Shopify (stored null).
- `validate.js`: a rich text or text product module with no title is incomplete in a draft and an error at publish (`MODULE_TITLE_MISSING`, "This rich text module has no title, so shoppers won't see it: …"). An image-with-text module's image follows the gallery's OVL-13 allowlist: a warning in a draft, an error at publish (`IMAGE_HOST_NOT_ALLOWED`). Pages are not affected.
- `undo.js`: Undo and undoSet apply the title belt (a dry run says so too): an Undo that would put a name live while the gate is closed is 409 `TITLE_NOT_PUBLISHABLE`, naming the product, nothing changed. Undo of a first publish (back to Shopify's names) is never refused.
- `publish.js`: a product no longer in Shopify can't be published: 409 `PRODUCT_NOT_IN_SHOPIFY`, "“X” is no longer in Shopify, so its edits can't go live. Open it and choose Discard edits, or leave it out of this publish.", the whole set refused, nothing written. The drain tolerates null-handle rows anyway.
- `publish.js`: a `PUBLISHED_ELSEWHERE` conflict on product or collection content names the person who published (their `publish_log` row), not the last person who saved: a publish moves no revision.
- `service.js openEntityContent`: the un-archive runs in one batch behind `documentsGuardStatement`; a mode change answers the plain mode words and the document stays archived. Test seam `openEntityHooks.beforeUnarchive`.
- Pinned by tests: the same-product race in a products-only set (409 naming the other person, never 503), and `discardOrphanEdits` with no live row writing no outbox row.

## Acceptance, with evidence

"Bites" = the named change was undone in this branch's code, the suite rerun, and the code restored (a scratch script; the list is below the table). Suites: SE = `test-search-effective`, PC = `test-product-content`, RF = `test-refs`.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | A spy shows indexTypesense builds every document with buildSearchDoc from indexRows; after a full sync the effective title is indexed, not Shopify's; a draft is never indexed; pending outbox rows are marked done and old done rows pruned | **DONE** | SE "a full sync indexes every product…" (260 products over two pages through `runCatalogSync` with injected fetchers; every imported document equals `buildSearchDoc` of an independently paged `indexRows`; the published name, type and brand shown; the draft name nowhere; pending rows done; a 40-day done row pruned, a 10-day one kept; a second full sync keeps the name) and "only rows written before the import read the catalog are marked done…". Bites: M1 (base read), M2, M8 |
| 2 | Refs picker finds a renamed product by its new name, shows Shopify's as secondary, never a draft; cursor paging over 61 products with mixed overrides has no duplicates or gaps | **DONE** | RF "P4-SEARCH: the product picker finds…" and "…cursor paging over 61 products…" (limits 7, 25 and 50 equal the expected order exactly, ties broken by id; a paged search too); "a store with no live rows answers exactly as before". Bites: M16, M17 |
| 3 | The offer, bundle and upsell pickers find a renamed product by its new name | **DONE** | SE "the offer, bundle and upsell pickers…" (the shared refs picker, offer names by product, handle and variant, the example cart, the real bundles route's check) and "the upsells route lists targets…" (the real route). Bites: M11, M14 |
| 4 | In top products, renaming a product keeps one row with the current title | **DONE** | SE "top products: …" (two orders under the old and new names: one row, the new name, qty 2; a legacy store reads Shopify's names). Bites: M10 |
| 5 | After writeProduct or syncProductByGid changes an edited field, changed_in_shopify and its count include the product; an unedited field does not; deleting moves it to orphaned; a query-string-only image change triggers nothing; the list pages through a catalog over 30 | **DONE** | SE "changed_in_shopify: …" (full sync changes the name: `["title"]`; a webhook changes the gallery: `["gallery","title"]`; vendor and an unedited name don't count; `?v=99&width=800` alone doesn't; delete moves it to orphaned with counts 1/0/44, and back) and "listProductContent pages through a catalog over 30…" (45 products, pages of 7, ordered, the API by staff). Bites: M13 |
| 6 | TITLE_READERS_READY true, condition (a) gone: Typesense on _default (env collection) and on a store with its own collection (dummy config, spy), saving and publishing a title or display_* succeeds and the spy shows it indexed; with the gate forced closed the save refusal and the publish belt still fire with their words | **DONE** | PC "title gate (P4-SEARCH, OQ-1 (b)): …" (the gate open under `_default`, an own collection and no namespace; name, type and brand saved and published under `_default` and through the API on the own-collection store; the spy imports them into `products` and `pcts_products`), "title gate forced closed…" and "the title belt…". Bites: M18, M19 |
| 7 | Rendered: the order page's Shopify-title line has computed contrast of at least 4.5:1 | **DONE** | Drill `docs/cms-reviews/drills/P4-SEARCH/results-order-contrast.json` (Chrome 156): `rgb(82, 82, 91)` on `rgb(255, 255, 255)`, 7.73:1, class `text-xs text-fg-muted`, screenshot `order-shopify-line.png`. Unit: SE "the order page's Shopify-title line uses the console's muted text…" (the tokens from `app/console.css`). Bites: M15 |
| 8 | listProductContent q finds a renamed product by its new name and its Shopify name; after resolveShopifyChange 'keep' or 'shopify', or a Reset, the product leaves changed_in_shopify and its count at once, with no publish | **DONE** | SE "listProductContent q finds…" and "after resolveShopifyChange 'keep' or 'shopify', or a Reset…" (three products, the count drops by three, `publish_log` unchanged) |
| 9 | Publishing a renamed product (alone and in a publishSet) leaves one pending outbox row; the fast path upserts only that product with the new effective title from indexRows({ids}), marks the row done, never deletes or recreates the collection; Undo puts the previous title back; Reset then publish indexes Shopify's title; Undo of a first publish indexes Shopify's title; discardOrphanEdits of a gone product deletes it by its stored handle | **DONE** | SE "publishing a renamed product alone…", "in a publishSet…", "Undo puts the previous name back…" and "discardOrphanEdits of a product that left Shopify…" (the spy sees one import of exactly the expected documents and a delete of `fixture-product-26` in the store's own collection; never a drop or create). Bites: M5, M7 |
| 10 | A client that throws or hangs leaves the answer 200, the row pending and a search_reindex_failed / search_reindex_timeout line; the job then drains it; with enqueueDurable null and the inline drain failing, the next full sync converges; a row written during a drain stays pending; two kicks with the same rows enqueue one job, a later publish a second; no Shopify call anywhere | **DONE** | SE section 3 (five cases, through the real API, the real job worker `runDueJobs` and the real full sync) and "no Shopify call, and no network call at all…" (every `fetch` refused and recorded: none). Bites: M3, M4, M6 |
| 10a | (fix round 1) Two drains that overlap, and a full sync that overlaps a fast drain, end with the live name in search; a product that keeps changing makes the drain give up with its rows pending; pruning never frees the newest rowid | **DONE** | SE section 3: "two drains that overlap leave the newest published name in search…" (a stand-in index whose writes land only when import returns: drain A holds "Name V1" inside its import, the product is renamed "Name V2", drain B writes V2 and marks both rows done, A is released; the index holds "Name V2", nothing pending), "a full sync whose page import holds an old name while a fast drain writes the new one…" (the same through `indexTypesense`), "a product that keeps changing during every write…" (five imports, then a throw, the row pending, the next drain takes it) and "pruning never removes the newest outbox row…". The first, second and fourth failed on the code before the fix (index held "Name V1" and "Sync Name V1"; the newest row was pruned) |
| 11 | On a store without Typesense or without a namespace the drain makes no client call and marks rows done; the drain only addresses the current store's productsCollection() | **DONE** | SE "on a store without Typesense, or without a namespace…" and "_default uses the environment's collection…" (every call any spy saw in the suite, more than 20, addressed the calling store's own collection). Bites: M9 |
| 12 | With the gate forced closed by a non-Typesense condition, the refusal words name that condition, not search | **DONE** | PC "title gate forced closed…" (the readers condition's words at save, in openEntityContent and through the API, none matching /search/), "the title belt…" (the readers belt words) and the Undo belt case. Bites: M19 |
| 13 | A cleaned-equal description is stored null; an untitled text module is an error at publish; undo cannot put a gated name live; an orphan product publish is refused; module images outside the allowlist are refused | **DONE** | PC section 7 (five cases) and `test-registry-contract` "P4-SEARCH: a rich text or text product module…". Bites: M20, M21, M22, M23, M28 |
| 14 | The same-product concurrent publish gives 409 naming the other person; discardOrphanEdits with no live row writes no outbox row | **DONE** | PC "two people publishing the same product…" (Meera publishes between Asha's read and commit: 409 `PUBLISHED_ELSEWHERE`, `updatedByName` "Meera Iyer", one publish row) and "discardOrphanEdits of a product that only had a draft…". Bites: M24, M25 (the review's rowMoved mutation), M26 (the review's `WHERE 1`) |

Mutations (each restored after; the runner is a scratch script): M1 the full sync reads raw `products`; M2 the full sync marks every pending row done; M3 the drain marks every pending row done; M4 one fixed job key per store; M5 no fast path in the API; M6 no `search_reindex` handler; M7 no stored-handle lookup for a discard row; M8 no prune; M9 the drain calls the client without Typesense; M10 reports on Shopify's title; M11 offer names on Shopify's title; M13 image addresses compared with their query; M14 upsell targets on Shopify's name; M15 the order line back on the subtle token; M16 refs search on Shopify's title; M17 the refs cursor on Shopify's title; M18 `TITLE_READERS_READY` false; M19 every gate refusal in search's words; M20 the description compared raw only; M21 no module checks; M22 no Undo belt; M23 an orphan publishes; M24 the race names the last saver; M25 `rowMoved` without the published-version check; M26 the discard outbox insert `WHERE 1`; M27 the un-archive without the guard; M28 module images not checked. All 27 caught. M12 (the changed filter's "null in the draft" test removed) survived: it is equivalent, because the service never stores a field as `{value: null, base_hash}` (it stores null), so the base hash is null whenever the value is.

### Browser drills (design harness, desktop Chrome 156 headless)

`DESIGN_PORT=6100 DESIGN_SQLD_PORT=7107 node docs/cms-reviews/drills/P4-SEARCH/<drill>.mjs <worktree>` (each reseeds the P3 store, which is the PERF-04 perf seed, starts the harness, and stops it).

- `order-contrast`: an order whose line was sold as "Morning Whey" and whose Shopify title is "Whey Gold Isolate", SKU WGI-1KG, written into the harness store; signed in as the owner through the real form; `/admin/orders/DRILL-OVL06`. The line's computed colour `rgb(82, 82, 91)` on the card's `rgb(255, 255, 255)`: 7.73:1 at 12 px. 3 passed. The order was deleted afterwards.
- `list-perf`: `listProductContent` through `PUT /api/admin/documents` in the signed-in page, 25 calls each, perf seed (400 products, no product content documents in that seed): first page p50 13.4 ms / p95 20.9 ms; `q=serum` p50 13.1 / p95 19.0; `changed_in_shopify` p50 10.3 / p95 18.2 (Next dev, local sqld, edge proxy included). 2 passed.
- Library level (SE "measure: …", a 400-product file store with 24 edited products, 12 published, 6 changed in Shopify): first page p50 1.05 ms / p95 1.16; changed p50 0.86 / p95 0.94; `q` p50 0.91 / p95 0.98. Load average about 3.

Ports 6100 and 7100 to 7109 were free before and after; nothing was left running.

## Tests

- `scripts/test-search-effective.js` (replaces SCAFFOLD's placeholder; no `package.json` change): 28 cases (four added in fix round 1), four file stores (260, 3, 4 and 45 products) plus one of 400 for the measure, the real API, job worker and sync, a spy Typesense client.
- `scripts/test-product-content.js` (this item's file in batch 3): the Typesense title-gate case rewritten to the new rule, a forced-closed case added, the belt case's words updated, the discard case's `done_at` (the fast path now marks it done), 20 products instead of 12, and section 7 (eight review cases). 35 cases.
- `scripts/test-refs.js`: three P4 cases on a migrated store with 61 products.
- `scripts/test-api-shapes.js`: `listProductContent` (parse, access, mode read, 200 keys from the dispatcher and the list module) and the new words.
- `scripts/test-registry-contract.js`: one case for the two module rules.

## Known limits

- **Three test files outside the plan's list were changed**, each forced by a required change, no assertion weakened: `scripts/test-order-catalog.js` (its pin of the order page's JSX line now matches `SHOPIFY_LINE_CLASS`), `scripts/test-publish-service.js` and `scripts/test-failure-matrix.js` (each published product content for a product that was never in the catalog; the orphan refusal now refuses that, so each inserts the product first). The orchestrator should add them to this item's files.
- **The picker UI** (`components/admin/cms/RefPicker.js`, not this item's) does not draw `shopify_title` yet; the API sends it. P4-PICKER or P4-EDITOR draws it.
- **The upsells route** adds `title` to each target even on a store with no live rows (Shopify's name there): an additive key, nothing removed or changed.
- **The fast path is awaited** inside the publish request: a slow Typesense can add up to 2.5 s to the answer, and a slow control plane up to 2.5 s more for the enqueue. The answer itself never changes.
- **A discard of a product whose earlier rows were pruned** (more than 30 days) leaves its old search entry until the next full sync rebuilds the collection. A product deleted by a Shopify webhook was never removed from search before a full sync either (unchanged).
- **A collection whose collection is gone** can still be published (the orphan refusal is for products only, as the review asked).
- **The readers condition can't block in production** (`TITLE_READERS_READY` is a constant true). It stays as the template a future gate copies; tests force it through `setTitleGateForTest`.
- **`PRODUCT_NOT_IN_SHOPIFY`** now also answers a publish (409, as it already did for `resolveShopifyChange`).
- **The product list's `edited`** means a live row or a draft holding any setting or module. The orphaned filter lists only such documents; an untouched document of a deleted product is not listed.
- **The list's search** is SQLite LIKE (case-insensitive for ASCII letters only).
- **A product whose handle changed in Shopify** gets its old entry deleted by the drain only when it is in the outbox; otherwise the next full sync rebuilds.
- **Overlapping drains do extra work instead of taking a lock** (fix round 1): a drain that sees a newer row re-reads and rewrites those products, and the full sync re-drains every product published while it ran. Two drains can still write the same product twice; the last write to land is always a current one. A drain that keeps losing to new publishes of the same product gives up after 5 rounds and leaves its rows pending (the job retries with backoff). The check relies on rowids only growing; pruning now keeps the newest row so a rowid is never reused.
- **The reopened rows after a full sync** are drained by the full sync's own `drainAll`. If that drain fails, the full sync now enqueues a `search_reindex` job of its own (P4-FIX2), keyed `search_reindex:<tenant>:<highest pending rowid>:sync:<upTo>:<random>`, because the job a publish enqueued for the same rows may already be done and job keys are unique for all time. With no job queue (no control plane) or a failed enqueue, the rows wait for the next publish or full sync, as before; that is logged.
- **A drain holding an old Shopify title can race a full sync** (from the review, recorded by P4-FIX2). The recheck only sees changes that write an outbox row. A product with no name override has no row when Shopify renames it, so a drain that read the old raw title can land after a full sync that indexed the new one, and nothing re-reads it. It needs a drain to overlap a full sync, and it heals on the next full sync. Webhooks do not write Typesense, so only the full sync and the drain can race.
- **Rowids can be renumbered by a rewrite of the table** (from the review, recorded by P4-FIX2). `search_outbox` has an implicit rowid (0024 has no INTEGER PRIMARY KEY). A `VACUUM`, or an export and import that rewrites the table (`lib/platform/export.js` includes `search_outbox`), can renumber rowids, and a drain running across such a rewrite could then miss a newer row. Nothing in `lib/` vacuums. After an import, the next full sync rebuilds the collection and settles the outbox.

From review:

- Earlier blocker (overlapping drains leave the old name in search) is fixed at 5f7108d. After its write lands, drainSearchOutbox now checks for any outbox row, pending or done, written for those products after its read point. If it finds one, it re-reads and rewrites those products (5 rounds at most, then it throws with its rows still pending). The full sync makes every row newer than its upTo pending again before its drainAll, and pruning keeps the newest row so a rowid is never reused. Checks: (1) the builder's two overlap tests pass. (2) Six mutations were each caught by the suite: no recheck, no reopenAfter, prune allowed to remove the newest row, rowsAfter limited to pending rows, `since` read after the write instead of before, and RECHECK_ROUNDS set to 1. (3) Two scenarios of my own pass on the real drain with a stand-in index: three overlapping drains (V1 and V2 held, V3 written, then released in reverse order) end on V3 with nothing pending; a held V1 drain followed by a V2 rename with no other drain ends on V2. (4) pnpm test: 96 of 96 suites passed (sqld on ports 7300-7306). (5) search-reindex.js and search-doc.js import no node: modules.
- When the full sync's drainAll fails after reopenAfter, the reopened rows stay pending, but no job covers them: their earlier search_reindex job already finished, and its key is the rowid. The packet's Known limit says these rows stay pending 'for the job or the next full sync'. In fact only the next publish's kick or the next full sync drains them, so search can keep an older name until then. This needs a Typesense failure in the middle of a full sync. Suggestion: in indexTypesense, enqueue a search_reindex job when drainAll fails, or correct the packet's wording.
- The recheck only sees changes that write an outbox row. A drain holding an old Shopify raw title (product without a name override) can land after a full sync that indexed the newer raw title, and nothing re-reads it until the next full sync. It heals on the next full sync and needs a drain to overlap a full sync. Typesense is written only by the full sync and the drain (webhooks do not write it), so this is a narrow new race. Consider recording it as a Known limit.
- The rowids-only-grow assumption depends on search_outbox having an implicit rowid (0024 has no INTEGER PRIMARY KEY). A VACUUM, or an export/import that rewrites the table (lib/platform/export.js includes search_outbox), can renumber rowids. A drain running across such a rewrite could then miss a newer row. Nothing in lib vacuums, so this is low risk. Consider adding it to the Known limit that already mentions rowids.

## From review

- **Fix round 1 (blocker): overlapping drains could leave an old name in search.** `drainSearchOutbox` read the values, sent them, then marked its rows done, with nothing stopping two drains at once (inline fast path past its cap, the job, the full sync's drain). Drain A could read "Name V1", drain B read and write "Name V2" and mark both rows done, then A's write land: search said V1, nothing pending, nothing to fix it. The full sync's page import had the same race against a fast drain. Fixed by option (a): after its write lands, a drain checks for any outbox row (pending or done) for those products newer than its read and, if one exists, reads and writes them again (bounded at 5 rounds, then it throws with its rows pending); the full sync makes every row newer than its read pending again before its drain; pruning keeps the newest row so rowids never repeat. Four tests added (acceptance 10a); the overlap tests failed on `e5196fa`.

## Owner checks

- **Typesense stores, `_default` included:** after the first rename on staging, search shows the new name within a few seconds (the fast path) or minutes (the `search_reindex` job; the tick must be running), and a full sync keeps it (plan section 5).
- **The job tick:** confirm the hosted scheduler runs `runDueJobs` often enough for `search_reindex` retries.
- **Hosted publish latency:** a publish on a Typesense store waits for the inline reindex (capped at 2.5 s); check it feels instant on staging.
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum; nothing under `.github/` was changed.
- **Phone and Safari:** the order page line was measured in desktop Chrome only.

## Files

`lib/catalog/search-doc.js` (new), `lib/catalog/search-reindex.js` (new), `lib/catalog/title-gate.js`, `lib/sync.js`, `lib/platform/worker.js`, `lib/typesense-search.js`, `lib/admin/refs.js`, `lib/offers/catalog.js`, `lib/reporting.js`, `lib/admin/product-content-list.js` (new), `lib/admin/documents-api.js`, `lib/admin/documents-api-shapes.js`, `app/api/admin/upsells/route.js`, `app/(console)/admin/(authed)/orders/[id]/page.js`, `lib/admin/order-view.js`, `lib/documents/service.js`, `lib/documents/undo.js`, `lib/documents/publish.js`, `lib/registry/validate.js`, the tests above, `docs/cms-reviews/drills/P4-SEARCH/` (two drills, their results and a screenshot), this packet. `lib/documents/live-rows.js`, `app/api/admin/bundles/` and `scripts/test-publish-undo.js` needed no change.

## Commands

```
pnpm test:search-effective && pnpm test:product-content && pnpm test:refs && pnpm test:api-shapes
pnpm test
pnpm build
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7107 node docs/cms-reviews/drills/P4-SEARCH/order-contrast.mjs "$PWD"
```
