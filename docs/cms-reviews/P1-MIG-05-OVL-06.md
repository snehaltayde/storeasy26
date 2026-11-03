# P1 · MIG-05 + OVL-06 · Schema before code, and orders that can be matched

Branch `cms/p1-mig-ovl`, cut from `bdbe1a7`. Two commits, as asked: `af7e57b` (MIG-05) then `bb98e45` (OVL-06), and this packet after them. Spec: `docs/CMS_FULL_BUILD_SPEC.md:2289-2299` (MIG-05), `:1673-1685` (OVL-06), `:2707` (8.9, `getCart` returns `catalog_title` and `sku`), `:2728` (8.11, deploy order), `:2845-2890` (8.15).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 46 of 46 suites passed, 870 tests, 0 failed. Two new suites: `test:schema-compat` (25 passed, 0 failed) and `test:order-catalog` (15 passed, 0 failed). `test:shopify-boundary` unchanged, 41 passed, 0 failed. `next build` passes, with 2 warnings that are older than this branch. See Test results |
| Browser verified | **NOT DONE.** No dev server or browser was run in this batch: no port was assigned to this item. The console page was rendered in the suite with Next's SWC and `react-dom/server` instead. Drills are listed below |
| Staging verified | **NOT DONE.** Nothing ran against Turso, a staging tenant or a real Shopify store. Every `--check` run here used local file databases |
| Production enabled | **NOT DONE.** Nothing pushed, merged, deployed or migrated. Migration 0018 has run only on local test files and the local design-harness seed |

## The bugs, reproduced first

**MIG-05: there was no deploy gate, and `--check` was silently dangerous.** The new suite ran against the base commit's `scripts/tenant-migrate.js` before any fix: 12 passed, 9 failed. The CLI ignored `--check`. With `--check` alone it printed the usage line and exited 1, so "fails when one tenant is behind" looked like a pass, for the wrong reason. With `--check --all` it **ran the migrations**:

```
✗ one tenant behind (a suspended one): --check exits 1, names it and the missing 0017_cms_approvals
    cb not named as behind:
Usage: pnpm tenant:migrate -- (--all | --tenant <slug>)
✗ --check writes nothing: ledgers, tables and the audit log are unchanged
    still behind: expected 1, got 0
✗ deploy order: migrate --all exits 0, then --check exits 0 and says it is safe
    cb not migrated:
✓ ca: 0 applied (none), 17 recorded
✓ cb: 0 applied (none), 17 recorded
```

The third test shows `cb: 0 applied` because the second test's `--check --all` had already migrated it. (At the MIG-05 commit the newest migration was 0017, so the run names 0017.)

**OVL-06 at the older schema: an order half-written after the columns were added.** Adding `catalog_title` and `sku` to the `order_items` insert with no guard, then running `test:schema-compat` against a tenant at 0017:

```
✗ order creation: the checkout's createOrder saves the order, its lines and first event on both schemas
    SQLITE_ERROR: table order_items has no column named catalog_title
20 passed, 1 failed
```

In today's `createOrder` the `orders` row is inserted before the lines, so the `orders` row is already written when the lines fail. That tenant would have orders with no lines and a failed checkout response. `test:orders` and others that build only the baseline schema failed the same way (`2 passed, 25 failed`). Then the guard went in, and both went green.

**OVL-06 on the base code: a rename splits a product's sales.** `test:order-catalog` against the base commit's `lib/cart.js`, `lib/orders.js`, `lib/reporting.js`, `lib/ai/insights.js` and the order page: 1 passed, 14 failed. The ones that show the reported problem:

```
✗ renaming a product keeps one row in top products, under its current title
    rows: [{"title":"Creatine 250g","qty":2,"revenue":1000},{"title":"Creatine Monohydrate 250g","qty":1,"revenue":500}] expected 1, got 2
✗ the agency report counts a renamed product once, under its current title
      got: [{"title":"Creatine 250g","qty":2,"revenue":1000},{"title":"Creatine Monohydrate 250g","qty":1,"revenue":500}]
✗ AI insights count a renamed product once, under its current title
    top sellers (recent orders): Steel Shaker ×3; Legacy Tee ×2; Creatine 250g ×2; Shaker Pro ×2; Morning Whey ×2
✗ an order for a retitled product shows both titles: the shopper's, then Shopify title and SKU
    first line: Morning Whey Default Title · × 1 ₹1,000
```

That base run used an earlier version of the fixture: two titles and no third rename. The final fixture adds a third rename, after both orders.

## What was built

### MIG-05 (`af7e57b`)
- `scripts/tenant-migrate.js`: a new `--check` mode, and `--check --tenant <slug>`. It reads every tenant's ledger, suspended tenants included, and writes nothing: no ledger table, no audit row, no migration. It exits 0 only if every tenant holds every migration this code ships, unedited. It exits 1, naming each tenant and what is missing, for: a tenant behind; an applied file whose checksum changed; a tenant whose database can't be read; a control plane that lists no tenants (a wrong `PLATFORM_DB_URL` looks exactly like that); a control plane with no tenants table. `--check` takes priority over `--all`, so `--check --all` stays read only.
- `lib/platform/migrate.js`: `checkLedger(client, migrations)`, read only.
- `lib/schema-compat.js` (new, edge-safe): `hasColumns(table, columns)`. See "The choice: optional columns".
- `lib/db.js`: `currentDatabase()`, the cached `{ libsql, db }` pair for the active database, so schema facts can be kept per database. Four lines at the end of the file.
- `migrations/README.md` rules 6 and 7, `docs/operations.md` "Deploying code that needs a new migration", and one row in `docs/platform-guide.md`. Deploy order: `pnpm tenant:migrate -- --all` exits 0, then `pnpm tenant:migrate -- --check` exits 0, then deploy.
- `scripts/test-schema-compat.js` (`test:schema-compat`).

### OVL-06 (`bb98e45`)
- `migrations/tenant/0018_order_catalog_title.sql`: `order_items.catalog_title` and `order_items.sku`, both TEXT, nullable. Expand only, no backfill.
- `lib/cart.js`: `getCart` also selects `v.sku`, and each line carries `catalog_title` (always the raw `p.title`) and `sku` next to `title`. The order snapshot is `cart.items`, so it carries both with no other change.
- `lib/orders.js`: `createOrder` adds the two values to the existing `order_items` rows, paid lines and gift lines, only when `hasColumns("order_items", ["catalog_title", "sku"])` says the tenant has them.
- `lib/admin/order-view.js`: `shopifyMatchLine(item, snapshotItems)`. It returns `Shopify title: X, SKU: Y`, or `Shopify title: X` with no SKU, when Shopify's title differs from the one the shopper saw. Otherwise it returns null.
- `app/(console)/admin/(authed)/orders/[id]/page.js`: that line, in small subtle text, under each order line's quantity.
- `lib/reporting.js`: `productLineKey` and `currentProductTitles`. `topProducts` groups by product id and shows the catalog's current title. A product no longer in the catalog keeps the newest title its orders saw. Lines with no product id group by title, as before. Rows gain `product_id`.
- `lib/ai/insights.js`: top sellers group the same way and use the current title.
- Agency report: `agencyClientReport` calls `topProducts`, so it is fixed by the same change (`lib/platform/agency.js:472`, unchanged).
- `app/(console)/admin/(authed)/analytics/page.js`: the table's row key is `product_id`, falling back to the title, so two products with one title can't collide.
- `scripts/test-order-catalog.js` (`test:order-catalog`), and four OVL-06 tests added to `test:schema-compat`.

## The choice: optional columns (MIG-05)

The brief asked for this to be written down.

**Chosen: probe once per database, remember the answer on that database's cached client.** `hasColumns` sends `SELECT catalog_title, sku FROM order_items LIMIT 0`, once, and keeps the answer in a `WeakMap` keyed on the `{ libsql, db }` pair that `lib/db.js` already caches per database. So each tenant answers for itself, and a cold instance's concurrent callers share one probe.
- **Present** is remembered for the life of the instance. Expand, then contract never drops a column that code still names.
- **Absent** ("no such column" or "no such table") is asked again after 60 seconds. A tenant migrated while an instance is warm gets the columns on its orders within about a minute.
- **Any other probe error** (database unreachable, locked) answers no for that call only, and is not remembered. The order still saves, without the two columns. The snapshot still has them, and the console reads them from there.

Why not the alternatives:
- **A PRAGMA per request:** ruled out by the brief, and it is an extra round trip on every order.
- **A PRAGMA once:** works, but `claude/gallant-keller-7d3213` classifies every PRAGMA as a write, which is never retried. A `SELECT` is retried as a read.
- **Insert, and retry without the columns on "no column named":** no probe at all on current tenants, but it parses an error string on the money path. In today's non-atomic `createOrder` the retry would run after the `orders` row is already in. Rejected.
- **A schema version read from the ledger:** couples order code to migration ids, and a ledger row can exist without its schema.

Reads needed nothing new. `getOrder` uses `selectAll()`, so a line has the two keys on a migrated tenant and lacks them on an older one. The page and reports treat a missing key and null the same way.

Cost: one extra `SELECT … LIMIT 0` per database per instance lifetime, and at most one a minute per instance on a tenant that is still behind. The cart, product page and search paths ask nothing. They read no new column (`v.sku` is in the baseline schema).

## Acceptance

Unless noted, tests run against real tenant file databases through the real code: `getCart`, `createOrder`, `getOrder`, `writeProduct` (the sync writer), `topProducts`, `gatherTenantFacts`, `agencyClientReport` and `pushOrderToShopify`.

### MIG-05

**1. A test runs cart, product page, search and order creation against a tenant at the older schema. Tag: unit. Status: pass.** `test:schema-compat` sets up a tenant at `0017_cms_approvals` (`OLDER_SCHEMA`) and one at `0018_order_catalog_title`, with the same catalog, and requires the same results from both:
- `✓ the older tenant really is at 0017_cms_approvals, a migration this code ships`
- `✓ cart: add, change quantity and read through the real /api/cart route, the same on both schemas`. This is the real edge route's handler with a real `NextRequest`, cookie and host resolution through the control plane, run in plain Node.
- `✓ product page data: every loader the page calls returns the same on both schemas`. This uses `getProductByHandle` and the real `lib/content/resolve.js` getters the page calls. A source guard fails if the page gains a loader the test doesn't run. `getPdpPairs` swallows errors into an empty list, so the test also checks that it found the pair.
- `✓ search: the real /api/search route finds the product on both schemas` (SQL engine, Typesense off)
- `✓ order creation: the checkout's createOrder saves the order, its lines and first event on both schemas`. It is called the way the COD route calls it: server cart, shipping from `computeShipping`, then a transition to `syncing_shopify` at the older schema.
- `✓ older schema: the order's lines leave out catalog_title and sku, and its snapshot still has them`
- `✓ current schema: the order's lines carry catalog_title and sku`
- `✓ orders ask about the columns once per database, never per order and never with a PRAGMA` (6 orders across two databases, exactly 1 probe each)
- `✓ a tenant migrated while the instance is warm: orders get the columns once the re-check window passes`
- The checkout route itself was not run. Its `after()` needs Next's request scope. Its `createOrder` call was run as above.

**2. Negative: `--check` fails when one tenant is behind. Tag: unit (the real CLI run as a child process, local file databases only). Status: pass.**
- `✓ one tenant behind (a suspended one): --check exits 1, names it and the missing 0018_order_catalog_title`. Output: `✗ cb: behind, missing 0018_order_catalog_title`, then `✗ 1 of 2 tenant(s) not ready for code that needs 0018_order_catalog_title. Do not deploy. …`
- `✓ deploy order: migrate --all exits 0, then --check exits 0 and says it is safe`. This is the brief's "both current, it passes": `✓ all 2 tenant(s) hold every migration up to 0018_order_catalog_title. Safe to deploy.`
- `✓ --check writes nothing: ledgers, tables and the audit log are unchanged` (run as `--check --all`)
- `✓ a tenant with no ledger is behind on everything, and --check does not create one`
- `✓ --check --tenant checks one store only`
- `✓ a migration file edited after it ran fails the check`
- `✓ a tenant whose database can't be read fails the check`
- `✓ a control plane with no tenants, or no tenants table, fails the check`
- `✓ without --all, --tenant or --check the CLI does nothing and says how to use it`

**Optional columns (the brief's design asks). Tag: unit. Status: pass.**
- `✓ a present column: yes, asked once for 30 callers, with a SELECT and never a PRAGMA`. Every statement sent to that database was recorded, and the list is exactly `["SELECT title, variant_title FROM order_items LIMIT 0"]`.
- `✓ an absent column: no, and callers inside the re-check window don't ask again`
- `✓ each database answers for itself`
- `✓ a column added while the instance is warm is used after the re-check window, then remembered`
- `✓ a probe that fails for another reason answers no for that call only, and is asked again`
- `✓ only plain table and column names are accepted`
- `✓ lib/schema-compat.js is edge-safe: no node: imports, only ./db.js`. This is a source check. The module never ran on the edge runtime (see Known limits).

### OVL-06

**1. An order for a retitled product shows both titles in the console. Tag: rendered. Status: pass in the suite. Drill D1 is still needed in a real browser.** The real page is compiled with Next's SWC and rendered with `react-dom/server`. The order is read by the real `getOrder` and `getOrderProjection` on a real tenant database. Only auth, `next/*` and the console's presentational components are stubbed. Overlay titles don't exist yet, so "retitled" is made the way OVL-03 will make it: the cart's `title` differs from its raw `catalog_title`.
- `✓ an order for a retitled product shows both titles: the shopper's, then Shopify title and SKU`. The line reads `Morning Whey … Shopify title: Whey Gold Isolate, SKU: WGI-1KG`. The other line, whose titles match, has no extra text.
- `✓ an order whose titles match shows no extra line`. Its HTML is identical to the page's with the new line removed from the source.
- `✓ an old order with no Shopify title renders exactly as before this change`. The HTML is byte-identical to the page without the new line. This covers the spec's "old orders with no catalog_title show as they do today".
- `✓ an order placed before its tenant was migrated still shows the line, from the snapshot`
- `✓ the support role sees the Shopify line, and still no customer details`. This includes the snapshot fallback, because the support role's copy of the order has its snapshot removed.
- `✓ the line's wording: no SKU, gifts, and missing values`

**2. Renaming a product keeps one row in top products. Tag: unit. Status: pass.** Product P9 is sold as "Creatine 250g" (2 units), renamed in Shopify through the real sync writer to "Creatine Pure 250g", sold again (1 unit), then renamed to "Creatine Monohydrate 250g" after both orders. So the title can only come from the catalog.
- `✓ renaming a product keeps one row in top products, under its current title`: `{"product_id":"gid://shopify/Product/209","title":"Creatine Monohydrate 250g","qty":3,"revenue":1500}`
- `✓ the agency report counts a renamed product once, under its current title` (a real grant, then `agencyClientReport`)
- `✓ AI insights count a renamed product once, under its current title`, with no entry for either old title
- `✓ a product no longer in the catalog keeps the newest title its orders saw`
- `✓ snapshot lines with no product id still group by title, as before`. `test:reporting`, whose fixture has no product ids, is unchanged and passes.

**3. Negative: past order snapshots are not rewritten. Tag: unit. Status: pass.**
- `✓ negative: a rename and new SKU in Shopify (through the real sync writer) rewrite no past order`. The order's `order_items` rows are deep-equal before and after, its `snapshot` text is byte-equal, and a new cart sees the new title and SKU. Nothing in this branch writes to old orders. The migration backfills nothing.
- `✓ an order freezes catalog_title and sku on its lines and in its snapshot`

**4. Negative: an overlay title is not sent in the Shopify push (SHOP-02). Tag: unit. Status: pass.**
- `test:shopify-boundary` is **unchanged**: `git diff bdbe1a7 -- scripts/test-shopify-boundary.js` is empty. It passes, 41/0. It already listed `catalog_title` and `sku` as content on the snapshot (`scripts/test-shopify-boundary.js:572-574`). The cart field is named `catalog_title` to match, so its sentinels ride the real field. That suite builds the baseline schema only, so its push test meets the older-schema path, where the lines leave the columns out.
- `✓ negative: the Shopify push sends neither the frozen Shopify title nor the SKU`, in `test:order-catalog` at the current schema. The line stores both sentinels (checked). The real `pushOrderToShopify` runs with a fake Shopify. No sentinel appears anywhere in what was sent, including the shopper's title, and the line keys are exactly `["quantity","variantId"]`.
- Also checked by reading the code: every consumer of snapshot or cart items picks fields by name. That is the Shopify push (`lib/shopify-push.js:94`), the purchase event (`lib/events.js:373-378`), the confirmation page's `TrackEvent`, and the shopper order pages. So no new field reaches GA4, Meta or Shopify.

## Commands and results

```
git checkout -B cms/p1-mig-ovl bdbe1a7                 # git log -1 --format=%h → bdbe1a7
pnpm install --frozen-lockfile --prefer-offline
pnpm test                                              # baseline: 44 of 44 suites passed
node scripts/test-schema-compat.js                     # with bdbe1a7's tenant-migrate.js: 12 passed, 9 failed
node scripts/test-schema-compat.js                     # after MIG-05: 21 passed, 0 failed
node scripts/test-schema-compat.js                     # OVL-06 columns, no guard: 20 passed, 1 failed
node scripts/test-orders.js                            # same, no guard: 2 passed, 25 failed
node scripts/test-order-catalog.js                     # with bdbe1a7's cart/orders/reporting/insights/page: 1 passed, 14 failed
node scripts/test-schema-compat.js                     # final: 25 passed, 0 failed
node scripts/test-order-catalog.js                     # final: 15 passed, 0 failed
node scripts/test-shopify-boundary.js                  # final, file unchanged: 41 passed, 0 failed
pnpm test --verbose                                    # final: 46 of 46 suites passed, 870 tests, 0 failed
pnpm build                                             # next build: exit 0, "Compiled successfully"
node scripts/dev-design.js seed                        # local seed: applies 0018, order_items has both columns
```

`pnpm tenant:migrate` was never run, and neither was anything with `--env-file=.env.local`. Every CLI run here was `node scripts/tenant-migrate.js …` with `PLATFORM_DB_URL` set to a local `file:` control plane, from inside the suite.

## Mutation checks

Scratch, not committed. Each mutation was applied alone, the named suites were run, and the file was restored.

**MIG-05, 15 of 15 caught** by `test:schema-compat`. They were: the check always passes; it exits 0 when not ready; it creates the ledger table; an empty tenant list passes; an edited file passes; `--tenant` is ignored; `--check --all` falls through and migrates; an unreadable tenant is skipped; "present" not remembered; the probe is a PRAGMA; "absent" remembered forever; any probe failure remembered; one memo for every database; names not checked; concurrent callers each probe.

**OVL-06, 22 of 22 caught** by `test:order-catalog` and `test:schema-compat`. They were:
- cart `catalog_title` null; cart drops `sku`; cart no longer selects `v.sku`
- `createOrder` writes the columns without asking (caught at the older schema); never writes them; freezes the shopper's title as `catalog_title`; drops `sku`
- match line shown when titles match; shown for old orders; no snapshot fallback; gifts borrow a paid line's snapshot; SKU left out
- page reads the redacted snapshot; page never prints the line
- top products keyed by title; keeps the order title instead of the catalog's; keeps the oldest title; `productLineKey` ignores the id; `currentProductTitles` reads nothing
- AI insights keyed by title; keep the order title
- migration adds only `catalog_title`

Two of the tests were tightened before this run, because I saw they could not catch a break. The rename test's current title had equalled the newest order's title, so "use the catalog title" could not fail. A third rename after both orders fixed that. The support-role test had never reached the snapshot fallback. Not mutated: the gift line's `g.catalog_title ?? null`, which is always null today (deviation 4), and the analytics `rowKey`.

## Merge notes: `claude/gallant-keller-7d3213`

That branch rewrites `createOrder` into one atomic `libsql.batch`. I read it with `git show` and did not merge it. Checked with `git merge-tree --write-tree HEAD claude/gallant-keller-7d3213`:
- **`lib/orders.js` and `lib/db.js` merge with no conflict.** In the merged result, the guarded rows go into the batch: `statements.push(asStatement(db.insertInto("order_items").values(rows.slice(i, i + 50))))` uses the same `rows`.
- **The three conflicts are not this branch's.** `package.json`, `components/checkout/CheckoutFlow.js` and `scripts/test-shopify-push.js` conflict identically for `bdbe1a7` itself (`git merge-tree --write-tree bdbe1a7 claude/gallant-keller-7d3213`). In `package.json`, keep both sides.
- **The merged tree was tested** in a scratch copy, with `package.json` resolved by keeping both sides and the other two files left alone: `test:schema-compat` 25/0, `test:order-catalog` 15/0, `test:orders` 27/0, `test:db-retry` 17/0, `test:payment-recovery` 20/0, `test:shopify-boundary` 41/0, `test:reporting` 6/0.

Lines that need care at that merge (line numbers on this branch):
- `lib/orders.js:4` adds `import { hasColumns } from "./schema-compat.js";`. Line 1 becomes theirs (`import { db, libsql, isTransient } …`). Keep both.
- `lib/orders.js:6-7` adds `export const ORDER_ITEM_CATALOG_COLUMNS`.
- `lib/orders.js:167-169`: the `hasColumns` probe, just after `const ts = now();`. It must stay **before** the batch is built and outside the `try` around `libsql.batch`. It is a read, so their classifier retries it.
- `lib/orders.js:247` and `:263`: the conditional spread in the paid and gift row objects. Their rewrite leaves the row-building block as is. If a later edit builds rows another way, both spreads must move with it, or a tenant at 0017 fails the whole batch.
- `lib/db.js:116-120`: `currentDatabase()` sits after `export const libsql`, below their changes.
- With their atomic batch, a missing guard would fail the whole order cleanly instead of leaving a half order. The guard is still required, or that tenant can't take orders at all.

## Deviations from the spec

1. **"Cart items" gain the fields in `getCart`'s output, not as a `cart_items` column.** Cart lines join the catalog live and store no title, so a stored copy would go stale. Spec 8.9 says `getCart` returns them. Migration 0018 touches `order_items` only. The snapshot is JSON and needs no column.
2. **The cart field is `catalog_title` (snake case) beside camelCase fields such as `variantTitle`.** It matches spec 8.9, the column, and the sentinel key `scripts/test-shopify-boundary.js` already used.
3. **Where the line sits.** The spec says "next to the existing Shopify link". The page has no per-line Shopify link. The order's Shopify id is in the "Payment & sync" card. The line goes under each order line's title and quantity (`orders/[id]/page.js:102` in the spec's evidence), which is where a founder matching lines looks.
4. **Gift lines get `catalog_title` and `sku` only if the gift object carries them, and today it never does.** Gift titles come from the offer config (`lib/offers/config.js`). Looking up the gift's variant would add a catalog read to `createOrder` or the cart. The brief asked for a small, local `createOrder` change, and resolving gifts from the variant is OVL-09. So gift lines show as today, even when the configured gift title differs from Shopify's.
5. **The console falls back to the snapshot** for an order whose lines lack the columns: one placed before its tenant was migrated, or during a probe failure. That is not in the spec. It keeps the line visible across the rollout gap.
6. **The support role sees the line.** The snapshot is removed from support's copy because it holds contact and address, so the line is read from the unredacted snapshot's items, which hold only titles and SKUs.
7. **`topProducts` rows gain `product_id`.** The analytics table keys on it. The CSV export keeps the columns `title, qty, revenue`.
8. **Two new suites the spec did not name:** `test:schema-compat` and `test:order-catalog`. They follow the `node scripts/test-<name>.js` pattern and join `pnpm test` automatically.
9. **`--check` fails on more than "behind":** an edited file, an unreadable tenant, an empty control plane, a missing tenants table. Each would otherwise be a silent pass.
10. **`docs/platform-guide.md`** gained one command row. It isn't in the brief, but that table is where commands are listed.
11. **The test harness loads real routes in plain Node** through `module.registerHooks`, which maps the `@/` alias and `next/headers|server|navigation` to files. That is not a JSX runner (spec 8.15). It needs no new dependency.

## Known limits

**Deploying.**
- **The gate is a command, not yet a step in any pipeline.** Nothing runs `--check` before a deploy today. It is the documented order, and someone has to run it. Wiring it into CI or the deploy is the owner's call (manual checks).
- **`--check` compares ledgers with the `migrations/tenant/` folder of the commit it runs from,** so it must run from the commit being deployed. The docs say so.
- **`--check` trusts the ledger.** A ledger row recorded without its schema, for example after hand edits, passes. The code's per-column probe still protects orders there.
- **`--check` on a local `file:` tenant whose file doesn't exist creates an empty file.** Measured: libsql opens it read-write and reads "no such table: schema_migrations". The check then correctly reports that tenant behind on everything, but leaves the empty file. Hosted Turso URLs are not affected.
- **0018 is two `ALTER`s and neither re-runs.** If the file stops between them, the retry fails with `duplicate column name: catalog_title`, and `--check` keeps listing the tenant as missing 0018. Orders keep working there, because the code needs both columns. Recovery is to add `sku` by hand and record the file. Not tested on Turso.

**At runtime.**
- **Up to about a minute without the columns after a tenant is migrated,** per warm instance. Orders in that window save without `catalog_title` and `sku` on their lines. The snapshot still has both, and the console reads them from there.
- **A probe that fails for another reason** (a database blip) means that order's lines lack the two values, for the same reason. It is asked again on the next order.
- **Turso's wording of the "no such column" error is unverified.** The probe treats `no such column`, `no such table` and `has no column` as "absent". If Turso phrased it differently, a tenant still at 0017 would get one probe per order instead of one per minute. Orders would still work. This is a staging check.
- **Never ran on the edge runtime.** `lib/schema-compat.js` and the cart change are edge-safe by reading (no `node:` APIs; a source check guards it), but the cart and search routes ran here in plain Node, and the design harness runs the storefront on Node (spec 8.15). Edge was not measured.
- **The cart JSON sent to browsers now includes `catalog_title` and `sku`.** Today `catalog_title` always equals `title`, and SKUs are public in Shopify's Storefront API too. Once OVL-03 shows an edited title, that JSON would also carry the Shopify title. OVL-03 should decide whether to keep these server-side (manual checks).

**What the founder sees.**
- **A rename made in Shopify after an order shows no line on that order.** Both titles were frozen at order time and were equal then. The line answers "what did Shopify call this when it was ordered". Today, Shopify's own renames are the only kind there is, so the line appears only once overlays exist, or for a gap-window order whose snapshot differs. The SKU is the stable thing to search Shopify by, unless the SKU changed too.
- **Titles are compared exactly.** A difference only in case or spacing shows the line.
- **Report titles read the raw `products.title`.** When OVL-03 lands, `currentProductTitles` (`lib/reporting.js`) must read the effective title. It is named in OVL-03's list of reads to move.
- **Snapshot lines without a product id group by title.** Cart lines have carried `productId` since Session 2 (`63ec860`), before orders existed, so this only affects hand-made rows such as test fixtures.
- **`currentProductTitles` swallows a catalog read error** and keeps the order titles. That path has no test.

**Not covered by tests.**
- The analytics table's `rowKey`, the agency Partners screen's rendering of the report, and the real page's console components. The rendered test stubs the components (`Card`, `Badge`, `KeyValue` and others). Drills D1 to D4 cover these.
- The COD and Razorpay checkout routes, end to end. `createOrder` ran as they call it.

## Browser drills still needed

None of these has been run. All are on the design harness, with desktop Chrome. Re-seed first (`node scripts/dev-design.js seed`), because the harness database needs 0018. Seeded orders have no line rows, so place a COD order through the storefront first.

- **D1. Both titles on the order page.** Place a COD order on the harness storefront. Then, in the local `.design-tenant.db` only, set that order's `order_items.title` for one line to another name, to stand in for an overlay title. Open the order in the console. Pass: under that line, small muted text reads `Shopify title: <catalog title>, SKU: <sku>`. The other lines show nothing new, and nothing overflows at 1280px or 375px wide.
- **D2. Old orders look the same.** Open a seeded order, and an order placed before re-seeding if one exists, on this branch and on `main`. Pass: identical screenshots.
- **D3. Top products after a rename.** Place two orders for one product. Between them, change that product's `products.title` in the local DB. Open Analytics. Pass: one row under the new title, with both orders' quantity and revenue. CSV export still has the columns `title, qty, revenue`.
- **D4. Agency report.** Sign in as the harness agency and open the client report for the design tenant after D3. Pass: one row for that product under its current title.
- **D5. Support role.** Open the D1 order as a support-role operator. Pass: the Shopify line shows, and name, email, phone and address are hidden.
- **D6. Shopper sees nothing new.** Cart drawer, checkout and confirmation for the D1 order. Pass: no SKU or "Shopify title" text anywhere a shopper can see.

## Manual checks for the owner

- **Staging: the deploy gate on the real control plane.** Run `pnpm tenant:migrate -- --all` on staging, then `pnpm tenant:migrate -- --check`. Pass: `--all` exits 0 with `1 applied (0018_order_catalog_title)` per tenant, and `--check` prints a ✓ line for every staging tenant, suspended ones included, then `Safe to deploy.` Yours, because it migrates a hosted database.
- **Staging: an order on a tenant still at 0017.** Before migrating one staging tenant, deploy this branch to staging and place a COD order there, and one Razorpay test payment. Pass: both orders complete and show in the console with their lines. Then migrate that tenant, wait a minute, and place another order. Pass: its lines carry the SKU. This also shows whether Turso's "no such column" wording is the one the code expects.
- **A real Shopify store: find an order by the console's line.** Push a test order to a dev store, then search Shopify admin for the SKU the console shows. Pass: the order is found, and Shopify's line title matches the console's "Shopify title" for a line where they differ (once overlays exist; today, check the SKU only). Cancel the test order afterwards.
- **Decision: make `--check` a required deploy step.** Today it is a documented command only. Options: a CI job before promote, or a script the deploy runs. Pass: you choose one, or accept the manual rule.
- **Decision: should the cart JSON in shoppers' browsers carry `catalog_title` and `sku`?** It is harmless today, because they equal what the shopper sees, plus a SKU. It matters when OVL-03 lets titles be edited, because the JSON would then also hold the Shopify title.
- **Decision: gift lines.** A free gift's title comes from the offer config and may already differ from Shopify's, but gift lines get no "Shopify title" line until OVL-09 resolves gifts from their variant. Accept that, or pull it forward.

## Test results

Final run, `pnpm test --verbose`, on the OVL-06 commit. Only this packet was added after it. 46 of 46 suites passed, 870 tests, 0 failed. Format is passed/failed. `test:perf` was not run, because it is a measurement.

```
test:orders 27/0              test:shipping 12/0            test:shopify-push 13/0
test:shopify-boundary 41/0    test:hardening 11/0           test:offers 27/0
test:offers-admin 8/0         test:events 16/0              test:tenancy 9/0
test:platform-sync 15/0       test:admin-console 9/0        test:cms-api 20/0
test:page-editor 53/0         test:refs 8/0                 test:sections 15/0
test:cms 11/0                 test:platform-ops 9/0         test:tenant-boundary 24/0
test:identity 22/0            test:authz 14/0               test:platform-core 15/0
test:jobs 12/0                test:sync-generations 8/0     test:order-projection 14/0
test:commerce 10/0            test:privacy 11/0             test:security 19/0
test:content 19/0             test:releases 25/0            test:themes 10/0
test:storefront 15/0          test:surfaces 15/0            test:billing 14/0
test:provision 9/0            test:reporting 6/0            test:tenant-ops 9/0
test:marketing 4/0            test:customers 9/0            test:commerce-exp 18/0
test:growth 21/0              test:agency 16/0              test:w6 16/0
test:copy 52/0                test:media-upload 119/0       test:schema-compat 25/0
test:order-catalog 15/0
```

Baseline at `bdbe1a7`: 44 of 44 suites passed. `test:shopify-push` and `test:cms-api`, flaky in batch A (`P1-AU-05.md`), passed on every run here. That does not mean they are fixed.

`next build`: exit 0, `✓ Compiled successfully`. It shows two "Encountered unexpected file in NFT list" warnings, traced through `lib/platform/migrate.js`'s file reads. Earlier builds of the base code by other sessions show the same warnings. This branch adds no file reads there.
