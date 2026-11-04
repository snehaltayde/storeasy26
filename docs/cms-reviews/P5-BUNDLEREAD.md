# P5 · BUNDLEREAD · A bounded, honest bundle read, one place for bundle words, and safe bundle writes

Branch `cms/p5-bundleread`, cut from `b09f342` (`cms/phase-1`, the phase 5 plan). Plan: `docs/cms-reviews/P5-PLAN.md` (decisions 4, 5, 6, 9, 11; batch 1) and `P5-BATCHES.json`. Requirements: COM-01, COM-02. Migrations owned: none.

No store changes mode. No real or hosted store was used: every case runs on file databases (`scripts/support/tenant-fixture.js` for the new cases, the suites' own file databases for the rest). Typesense is not touched. Nothing writes to Shopify. No test order was placed (the engine discount is read from `getCart` on a file database).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 205.8 s. `test:commerce-exp` 33 passed (15 new), `test:refs` 15 passed (4 new), `test:effective-read` 41 passed, unchanged. `pnpm build` passes (its two Turbopack warnings were there before) |
| Browser verified | **NOT DONE, nothing to see yet.** This item has no UI: the read, the words and the writes are used by P5-BLOCKS, P5-CHECKS, P5-PANEL and P5-EDITOR. The bundle route's answers are proved by calling the real route handler. Port 6140 was not used; 7140 was given to test:migrate-map's sqld during `pnpm test` and stopped with it |
| Staging | **NOT DONE** (owner checks below) |

## What and why

Phase 5 puts bundles on the home page as blocks (COM-02). A block must show the bundle the cart will actually price (COM-01), without an N+1 read per bundle, and the founder must be able to make a bundle from the editor without breaking a live one. Before this item:

- `checkBundleCompatibility` read each component with two statements (variant, then product), so a grid of 12 bundles of 4 would cost about 100 statements;
- nothing checked that a bundle's linked `bundle-<id>` offer (what the cart prices from) still matched the bundle row;
- the only words were the legacy problems, with a hard-coded ₹ and "component N:";
- `upsertBundle` with a new id and a taken slug overwrote the other bundle; an edit that did not send `enable` turned a live bundle off and wiped its description; a variant listed twice got the engine's discount twice.

## Design

### (1) `lib/commerce/bundle-compat.js` (new, pure)

`compatFrom({ items, bundle_price, variantsById, productsById })` -> `{ ok, state, reasons, problems, components, componentsSum, saving, liveSaving, currency }`.

- **state**, first match wins: `not_ready` (fewer than 2 components, the same variant twice, a price that is not a positive number, mixed currencies), `sold_out` (a component variant or product unavailable, or gone), `no_saving`, `available`. `stateOf(reasons)` is exported.
- **reasons**: `too_few`, `duplicate {index, title}`, `bad_price`, `mixed_currency`, `sold_out {index, title}`, `missing {index, title}`, `no_saving {sum, price}`. `title` is the product's effective title or null, never a variant id.
- **problems**: the legacy strings byte for byte, in the legacy order. A duplicate variant adds "component N (title): already in the bundle" and mixed currencies add "components are priced in different currencies", so `ok` stays "no problems" and equals `state === 'available'`. Neither can happen in a row this code writes.
- **saving** stays the legacy `Math.max(0, sum - price)`; **liveSaving** is `sum > 0 && price > 0 ? Math.round(Math.max(0, sum - price)) : 0`, the engine's BUNDLE discount for one complete set.
- **currency**: the components' own (variant, then product); `null` when mixed or none.
- `mergeItems(items)`: duplicate variant ids become one entry with the summed quantity, first-seen order.

`lib/bundles.js` now has `bundleCompat(...)` (two statements: the variants with `IN`, then their products through `effective.byIds`) and `checkBundleCompatibility`, which returns exactly `{ ok, problems, components, componentsSum, saving }` from it. The getBundle snapshot in test-effective-read is unchanged.

### (2) `lib/commerce/bundle-words.js` (new, pure)

The only source of bundle-state wording. `stateLine(state, reasons, { currency, formatMoney })` gives the plan's section 1.9 sentences for available, sold_out, no_saving (with "the products add up to <sum>" when the reason carries the sum), not_ready, disabled and missing. `reasonSentence(reason, …)` gives "Sold out", "No longer available", "Price must be lower than <sum>", "Pick at least two products", "This product is already in the bundle", plus three the plan did not list: `bad_price` "Enter a price above zero", `mixed_currency` "These products are priced in different currencies", `not_synced` "Open it in Catalog > Bundles and save it again". `gridEmptyLine()`, `overlapLine()`, `BUNDLES_HREF` (`/admin/catalog#bundles`) and `BUNDLES_PLACE` ("Catalog > Bundles") are exported too. Money is `formatMoney(amount, currency ?? undefined)` (lib/format.js by default, or the one passed in), so a null currency uses formatMoney's own default and never prints "null". The file holds no ₹, no "INR" and no "component ".

### (3) `lib/commerce/bundle-read.js` (new, edge-safe)

`bundlesByIds(ids)` -> `Map id -> { id, slug, title, description, enabled, bundle_price, currency, componentsSum, saving, state, reasons, overlapsWith, components }` in the order asked. It imports only `lib/db.js`, `lib/catalog/effective.js` and `bundle-compat.js`.

- **Statement 1:** `bundles b LEFT JOIN offers o ON o.id = 'bundle-' || b.id WHERE b.id IN (…) OR b.enabled = 1` (plain SQL through `libsql`; no `lib/offers` import).
- **Statement 2:** the requested bundles' variants (`id, product_id, title, price, currency, available`).
- **Statement 3:** `effective.byIds` for their products (effective title and image).
- No ids: no statement, an empty Map.
- **States:** `missing` (no row), `disabled` (turned off), then for a turned-on bundle `not_ready` when its offer row is missing, turned off, outside its `starts_at`/`ends_at`, or its config (read as `lib/offers/store.js rowToOffer` does: `{ ...JSON.parse(config), id, type }`) is not `BUNDLE`/`line`, or has another price or another item set (an order-free multiset of variant and quantity). That adds the reason `{ kind: 'not_synced', detail: 'offer_missing' | 'offer_disabled' | 'offer_scheduled' | 'offer_differs' }` at the front. Otherwise the compat state.
- **saving** is `liveSaving`. **components** are `{ variantId, quantity, title, image, available, state: 'ok' | 'sold_out' | 'missing' }` (missing when the variant or its product is gone).
- **overlapsWith**: the other turned-on bundles sharing any variant, `[{ id, title }]`.
- A database fault throws. Payloads carry no `catalog_title` and no SKU.

### (4) Writes in `lib/bundles.js`

- Every write merges duplicate items (`mergeItems`), so the stored row and its offer never list a variant twice.
- `upsertBundle` (signature unchanged, but `description` and `enable` no longer default):
  - the slug owner is checked first: a create (`id` null) onto a taken slug, or an edit onto another bundle's slug, throws `SLUG_TAKEN` "A bundle with this link already exists." before anything else. A UNIQUE(slug) violation from the write itself (a race) is mapped to the same error;
  - on an edit, `slug`, `description` and `enable` left undefined keep the stored values;
  - `enable: true` that fails the check throws the legacy "can't enable: …" (now also with `code: 'BUNDLE_INCOMPATIBLE'`, `reasons`, `state`);
  - an edit of a turned-on bundle with `enable` undefined whose new items or price fail the check throws `BUNDLE_INCOMPATIBLE` ("This bundle is on, and with this change shoppers couldn't buy it, so nothing was saved. …") with no row or offer change;
  - `enable: false` still saves it turned off;
  - a create inserts only (it can never overwrite a row).
- `createBundle({ title, items, bundle_price, description?, enable = false, mustPass = false })` derives the slug: `slugBase(title)` (NFKD, accents dropped, lower-case, anything not `a-z0-9` becomes `-`, trimmed, `bundle` when empty) and `slugWithSuffix(base, n)` (the base cut so base plus `-N` is at most 61 characters). One statement reads the slugs already used under that base, the first free one is tried, and a UNIQUE race moves on to the next suffix (up to 25 tries). `mustPass: true` with a failing check throws `BUNDLE_INCOMPATIBLE` and saves nothing; without it the bundle is saved turned off and `compat.reasons` come back. `enable: true` turns it on only when it passes. An empty title throws `BUNDLE_INVALID` "Give the bundle a name."
- A turned-off draft the offer validator refuses (one product, no price) is now saved with its older offer turned off. Before, the row was written and then the save failed with OFFER_INVALID, leaving any older offer as it was.
- `setBundleEnabled` uses the same refusal (legacy message, plus code and reasons).
- `listBundles` adds `state` and `reasons` to each row's `compat`.
- `getBundle` and the bundle page are unchanged.

### (5) `app/api/admin/bundles/route.js`

- `POST { create: { title, items, bundle_price, description?, enable?, mustPass? } }` (offers.write): every item must be a variant GID (`gid://…/ProductVariant/…`), otherwise 422 `BAD_ITEM` "Pick the product again." and nothing is read or written. It calls `createBundle`, writes the same audit line as `bundle`, and answers `{ ok, bundle, compat: { state, reasons }, currency }`.
- The `bundle` action passes `enable` and `description` only when the body has them.
- `SLUG_TAKEN` answers 409. `BUNDLE_INCOMPATIBLE` and `BUNDLE_INVALID` answer 422 with `{ error, code, state, reasons, problems }`. These known answers come before the database check, as test-failure-matrix requires.
- GET and `check` add `currency` (`storeCurrency()`); `check`'s compat adds `state` and `reasons`. Handle resolution in `resolveItems` (legacy `bundle` and `check`) is left for P5-PANEL.

### (6) `lib/admin/refs.js`

`type=bundle` under `storefront.read` (OQ-A). Rows `{ id, slug, title, state, reasons, enabled, bundle_price, saving, currency, componentCount, overlapsWith }`, plus `missing: true` for a deleted id. `ids=` hydrates in the order given. `q=` is a title LIKE; title-then-id order; `limit` and a keyset cursor like collections. The id selection is one statement, then `bundlesByIds`.

### (7) `scripts/perf-fixture.js`

It looks each fixture bundle's id up by slug before `upsertBundle`, so a reseed onto a used database edits the bundle instead of failing with SLUG_TAKEN.

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | bundlesByIds gives available, sold_out, no_saving, not_ready (offer missing, offer disabled, offer price differs, raw duplicate items), disabled, missing on a tenant-fixture file DB | DONE | test-commerce-exp "P5: bundlesByIds gives available, …" (adds offer out of schedule). Fails without the change: the module did not exist. With the offer check stubbed out, it fails ("got … sold_out" for the offer-missing bundle). With the duplicate check removed, it fails too |
| 2 | after a warm-up, the same statement count (at most 3) for 1 bundle of 2 and 6 bundles of 4 | DONE | "P5: after a warm-up, 1 bundle of 2 and 6 bundles of 4 cost the same …" (exactly 3 each, through `watchStatements`) |
| 3 | when the bundles read rejects, bundlesByIds throws | DONE | "P5: when the bundles read fails …" (the table is renamed away: the call rejects with "no such table", never a Map) |
| 4 | saving equals getCart's BUNDLE discount for one set; duplicates merge on write and the engine discount then equals the saving | DONE | "P5: the saving the read gives equals …" (price 1234.4, both 666) and "P5: duplicate items merge on write …" (row and offer hold `[{v11,2},{v12,1}]`, cart discount 400 = saving; `createBundle` merges too). The second test fails on the old `lib/bundles.js` |
| 5 | overlapping turned-on bundles list each other | DONE | "P5: overlapping turned-on bundles …" (a turned-off third bundle is not listed) |
| 6 | create onto a taken slug and an edit onto another's slug both SLUG_TAKEN, nothing changes | DONE | "P5: a create onto a taken slug …" (rows, the edited bundle's offer and the count compared before and after; the route answers 409). Fails on the old `lib/bundles.js` |
| 7 | createBundle 'Gym Kit' twice gives gym-kit and gym-kit-2; a 61-character and a non-Latin title give valid slugs; mustPass with failing compat saves nothing | DONE | "P5: createBundle derives slugs …" (also "Café -- Deluxe!!" gives cafe-deluxe; with mustPass, neither the bundle nor the offer count changes). Fails on the old `lib/bundles.js` (no createBundle) |
| 8 | editing a turned-on bundle's price without enable or description keeps it on, its offer on with the new price, and the description; an edit that breaks compat answers 422 with no change | DONE | "P5: editing a turned-on bundle's price …" and "P5: an edit that would break …" (through the real route; the second also shows `enable: false` still turns it off and `enable: true` is still checked). Both fail on the old lib and route |
| 9 | POST { create } with a handle is refused 422 with a plain message and no row | DONE | "P5: POST { create } with a handle …" (also a good create, a mustPass refusal, and GET/check carrying currency and reasons). Fails on the old route |
| 10 | bundle-words source has no ₹, INR or "component "; USD sentences use $ and hold no ₹ or INR; with a null currency nothing prints "null" | DONE | "P5: bundle words: …" (the source scan; every state and reason in USD; the no_saving sentences hold "$1,500"; null and undefined currency checked) |
| 11 | the import scan of bundle-read, bundle-compat and bundle-words finds no lib/offers/ module and no node: import | DONE | "P5: bundle-read, bundle-compat and bundle-words import nothing under lib/offers/ …". Transitive through lib/db.js, tenant-context, schema-compat and effective.js; the one node import reached is `lib/tenant-context.js: node:async_hooks`, which test-effective-read already allows as the edge runtime provides it |
| 12 | test-refs: type=bundle lists rows with state; ids= in order; q= searches; no storefront.read gives 403 | DONE | test-refs "P5-BUNDLEREAD: …" four cases (the 403 uses a membership whose stored role is outside the role map, since every real role has storefront.read; support reads 200). They fail without the change (type=bundle was a 400) |
| 13 | test-effective-read passes unchanged | DONE | 41 passed, file not edited |
| 14 | pnpm test green on the branch | DONE | 96 of 96 suites |

## Tests

- `scripts/test-commerce-exp.js`: the `registerHooks` `@/` alias and `next/server` block from test-cms-api (so it calls `app/api/admin/bundles/route.js` with a real session, host resolution and audit), and 15 new cases on a tenant-fixture file database "cb" (16 fixture products) registered on the suite's control plane. The legacy cases (lines ~105-108 included) pass unchanged.
- `scripts/test-refs.js`: 4 cases on rf3 (every migration), with four variants and three bundles.
- The failure-matrix bundle case ("Network Switch 8-port", 422 with the legacy problem) still passes: the refusal now also carries code and reasons.

## Known limits

- `getBundle` and the `/bundles/<slug>` page do not check the offer sync; only the new read does (plan section 5). They do now say "not available" for a stored row with a duplicate variant (the added legacy problem). Before, such a row looked buyable and the cart gave its discount twice.
- `bundlesByIds` throws on a store without the `bundles` table (before migration 0011). Blocks only run on documents-mode stores, which have every migration.
- The engine still counts sets per entry (OQ-D): an old row stored with duplicates keeps its double discount in the cart until it is saved again. The read shows it as not_ready.
- Overlap is reported, not resolved (OQ-D): the engine's BUNDLE order is not fixed.
- Stock depth: a component with quantity 2 and one unit left reads as available (as the bundle page does).
- The UNIQUE(slug) race mapping is covered by code review only: the tests prove the pre-check path. Making the race happen in a test would need a seam inside the write.
- `POST { create }` defaults `enable` to false; the editor (OQ-C) sends `enable: true, mustPass: true`.
- Edge bundling is proved by the import scan. No edge route imports `bundle-read.js` until P5-BLOCKS, so `pnpm build` does not bundle it for the edge yet.
- Words added beyond plan 1.9: `bad_price`, `mixed_currency`, `not_synced` reason sentences (above).

## From review

- Nothing yet (written before review).

## Owner checks

- Sign-off of deviation 3.10 parts made here: SLUG_TAKEN instead of overwrite, handles refused on `POST { create }`, edits keep `enable`, `description` and `slug` when not sent, duplicate items merged on write, an edit that breaks a turned-on bundle refused, a turned-off draft the offer validator refuses now saves with its old offer turned off.
- Bundles already stored with a duplicate variant show "not ready" in blocks and "not available" on their bundle page until saved again in Catalog > Bundles. Worth a look on the real store before phase 5 ships.
- On staging, after deploy: one real test order through a bundle (snehal@mediastic.in, then cancelled) to confirm the bundle discount equals the saving the read gives (plan section 4; P5-DRILLS adds it to MANUAL-CHECKS).
