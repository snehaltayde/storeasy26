# P6 · FIXTURE · Test fixtures, banned-copy rules and phase 6 placeholders (GEN-01, GEN-04, PUB-12)

Branch `cms/p6-fixture`, cut from `b063753` (`cms/phase-1` after both P5-FIX2, merge `441b44d`, and P5-DRILLS, merge `211c982`). Plan: `docs/cms-reviews/P6-PLAN.md` (revision 4) and `P6-BATCHES.json` (item P6-FIXTURE, batch 1, merges first). Phase 2 plan sections 0, 3 and 6 and `P1-HARNESS.md` apply.

This is the author's own report. Reviewers should re-read the code.

**Test infrastructure only.** No file under `app/`, `lib/` or `components/` changed (`git diff b063753 --stat -- app lib components` is empty). No migration, no new dependency, nothing under `.github/`.

## Files

All in the plan's list:
- `package.json`: `test:first-run`, `test:brand-step`, `test:open-checks`, `test:policy-start` (each exactly `node scripts/<file>.js`), and `drill:p6`.
- `scripts/support/tenant-fixture.js`: the new `makeTenant` options, `fixtureCollection`, `catalogFor`, the `0025` stage.
- `scripts/support/banned-copy.js` (new): `BANNED` (moved), `SHOPPER_UI`, `CLAIMS`, `scanText`.
- `scripts/test-copy.js`: imports the rules; one new test for `scanText` and `CLAIMS`.
- `scripts/test-schema-compat.js`: the `0025` stage in part 7, and seven P6-FIXTURE tests.
- `scripts/test-first-run.js`, `test-brand-step.js`, `test-open-checks.js`, `test-policy-start.js`, `scripts/drills/p6/run.mjs` (new placeholders).
- This packet.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` (102 suites) and `pnpm build` (see Tests) |
| Browser verified | **NOT DONE, not needed.** Nothing a shopper or founder sees changed; every acceptance item is a unit test |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

Phase 6 builds the first-run store (GEN-01), the brand step (GEN-04) and "Before you open your store" (PUB-12). Its suites need stores that look like a real new store: documents mode, a catalog copied by a real sync (or a sync that stopped), and catalogs of awkward shapes. They also need one shared list of words a generated store must never say. This item builds those, and registers phase 6's four gate suites and its drill so later items only fill files they own. package.json has one phase 6 owner: this item.

## Design

### makeTenant options

All optional. With none of them, `makeTenant` runs the same code as before: legacy, products by `writeProduct`, no `sync_runs` row, no collections, and the caller's own `config` object on the tenant.

- **`mode: 'documents'`** calls `lib/platform/provision.js` `applyContentMode(client, { contentMode: 'documents' })`, which runs `DOCUMENTS_FOR_FRESH_STORE_SQL`. That is the one way provisioning moves a new store. It runs right after the migrations and before any product, collection or content row, as the brief orders. If the SQL leaves the store on legacy, the fixture throws with provisioning's own reason. It needs stage `0024` or later, because the SQL reads every `CONTENT_TABLES` table and 0024 adds the last of them. Earlier stages are refused before any file is made.
- **Commerce defaults (documents only):** the tenant config becomes `{ checkout_mode: 'direct', ...config }`. A caller's own `checkout_mode` still wins. No `maintenance` and no `billing` keys are added. So `checkoutCapability()` answers from the tenant, never from `process.env.CHECKOUT_MODE`. The four new suites `delete process.env.CHECKOUT_MODE`, as test-commerce.js does, and so does the P6-FIXTURE part of test-schema-compat.
- **`sync`**, which runs inside `withTenant`, using only `lib/sync.js`'s own functions:
  - `'complete'`: `runCatalogSync({ fetchers: { products, collections }, indexer: async () => ({ indexed: 0 }) })`. The products, collections, prune and index steps all run, and the run ends `complete` with source `injected`.
  - `'partial'`: `requestCatalogSync` starts a run, then one `runSyncSlice` with a fake clock commits the first products page (the first half of the catalog) and yields on its deadline. The latest run stays `running`, phase `products`, with no lease.
  - `'failed'`: `runCatalogSync` with page readers whose second products page throws. Inline, the sync marks the run `failed` (lib/sync.js `failSyncRun`) and keeps the first page.
  - Any sync needs stage `0020` or later.
- **Variants:** `fixtureProduct` already carries one variant per product (id, SKU, price, available). The sync writes it through `productStatements`, the same path `writeProduct` uses, so nothing had to be copied by hand (the P3 matrix copies rows by hand only because its closed store had no catalog). A unit test adds a synced `few` product to a cart.
- **`catalogShape`** (`CATALOG_SHAPES`), built by `catalogFor(shape)`:

  | Shape | Products | Collections |
  |---|---|---|
  | `one` | 1 | 1 |
  | `few` | 4 | 2 (2 products each) |
  | `many` | 40 | 4 (10 each) |
  | `all_sold_out` | 4, product and variant not available, stock 0 | 1 |
  | `no_images` | 4, no featured image, no images | 1, no image |
  | `long_titles` | 3, titles over 200 characters, image URLs over 500 | 1, title over 200, image URL over 500 |
  | `empty` | 0 | 0 |
  | `no_collections` | 4 | 0 |

  A shape replaces `products`. Giving both is refused.
- **`collections`** (a count, or a list of partial collections merged over `fixtureCollection(i)`) works without a shape. A count makes collections that hold every product.
- **Without a sync,** a shape or collections are written by `writeProduct` and `writeCollection`, as a webhook would write them.
- **The handle** also carries `mode`, `sync`, `collections` and `syncResult` (the latest `sync_runs` row, plus `runCatalogSync`'s answer for `complete`).
- **`STAGES`** gains `'0025'` and keeps `'latest'`. Today both hold the same migrations.

### banned-copy.js

`BANNED` moved out of test-copy.js unchanged: a diff of the two rule lists differs only in the `export` keyword. test-copy's source scan, its ALLOWED list and its "one sample per rule" check are unchanged. They use the imported list.

`CLAIMS` holds 13 rules, one for each word in the brief's lexicon, each labelled `claim: …`. CLAIMS is not part of the storefront source scan: product pages may well mention real reviews.

`scanText(text, { shopper = false, claims = true })` returns `[{ rule, match }]`, one entry per matching rule:
- It reads every BANNED rule with no file limit, plus CLAIMS.
- `shopper: true` adds the rules limited to shopper UI files (vendor names, localhost, test mode), for text a shopper will see. Founder copy may say "Ask Storeasy support", so those rules are off by default.
- `claims: false` leaves CLAIMS out, for founder-facing words that use "review" as a verb.

### Placeholders

Each of the four suites prints `placeholder: filled by <item>` and exits 0:
- test-first-run (P6-GEN);
- test-brand-step (P6-BRAND, extended later by P6-START-UI);
- test-open-checks (P6-OPEN);
- test-policy-start (P6-POLICY-START).

`scripts/drills/p6/run.mjs` prints `placeholder: filled by P6-DRILLS`. test-schema-compat pins all five scripts next to `drill:p4`. It runs each file only while it still holds its placeholder line, the same way P4-SCAFFOLD's stubs were checked, so the owners replace the files without touching this test.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| `pnpm test` passes with 102 suites; run-tests finds a test:* script for every scripts/test-*.js | DONE | `pnpm test`: "Running 102 test suites", 102 of 102 passed. run-tests.js's own check refuses a suite file with no script; the four new files have theirs |
| `makeTenant({ mode:'documents', sync:'complete', catalogShape:'few' })`: confirmed true, cms_state documents, no release, no documents, checkout_mode direct, `checkoutCapability().available` true with CHECKOUT_MODE unset | DONE | test-schema-compat "P6-FIXTURE: makeTenant({ mode: 'documents', … }) is a confirmed, unopened documents store…". A second test sets `CHECKOUT_MODE=disabled` and the fixture still has checkout available. Both fail on the old fixture (see Tests) |
| sync `partial` / `failed` give confirmed false; `empty` + `complete` gives confirmed true with 0 products; a `few` product goes into a cart | DONE | test-schema-compat "…sync 'partial' and 'failed'…" (reasons `running` and `failed`, first page kept), "…catalogShape 'empty'…" (also checks every shape), "…a 'few' product … goes into a cart" (`createCart`, `addItem`, `getCart`: one line, price 100, available) |
| The 13 fixture-importing suites pass unchanged; the four golden outputs are byte-identical; local-tenants.mjs builds | DONE | All 13 pass in the gate, with no edit. The golden outputs were run on this branch and again with the old tenant-fixture.js stashed: `legacy-release-outputs` and `legacy-journal-outputs` are byte-identical. `home-render-outputs` differs only in its random `sec_…` ids, which also change between two runs of the same code, and is identical once those are masked. legacy-tenants.js is covered by test-legacy-fixtures and the suites that read it. `node scripts/drills/p4/local-tenants.mjs --out <scratch>`: 22 passed, 0 failed; the scratch folder was deleted |
| test-copy still fails on a planted banned string in storefront code; `scanText('Rated 5 stars by customers')` reports a CLAIMS hit | DONE | Planted `run pnpm sync.` into `app/(storefront)/collections/page.js`: test-copy exited 1 with "developer: pnpm command" at line 35; the file was restored. Its in-file plant tests still pass. The new test-copy test pins the two hits `claim: rated` and `claim: stars` |
| package.json has drill:p6; `node scripts/drills/p6/run.mjs` prints the placeholder and exits 0 | DONE | test-schema-compat "the four phase 6 suites and drill:p6 are registered…" runs each placeholder and checks its exit code and output |

## Tests

- **`pnpm test`:** 102 of 102 suites passed.
- **`pnpm build`:** passed.
- **test-schema-compat:** 49 passed. With the old tenant-fixture.js stashed, 7 tests fail: the six P6-FIXTURE fixture tests and part 7's stage test, which now expects a `0025` stage. Without the package.json change the placeholder test fails, because the scripts are not registered.
- **test-copy:** 54 passed (53 before). The new scanText test fails without banned-copy.js, because its import is missing.

## Known limits

- **The handle has four extra keys** (`mode`, `sync`, `collections`, `syncResult`) even when no option is given. No importer spreads or serialises the handle (checked with grep), and the databases it builds are unchanged.
- **A `partial` run is real and still open.** A later `runCatalogSync` in that tenant joins it and carries on from its stored cursor with the new readers, exactly as lib/sync.js does for a real store. After `STALL_MS` it reads as `stalled`, which is still not complete.
- **`partial` and `failed` write no collections.** They stop in the products phase.
- **One variant per product,** with no options. A suite that needs a size or colour matrix passes its own `products` list.
- **The cart check stops at add-to-cart.** A real cash on delivery order is P6-DRILLS's.
- **Documents mode uses `DOCUMENTS_FOR_FRESH_STORE_SQL`** (provisioning's default), not the stricter unused-database SQL. That matches a store provisioned fresh, whose first sync comes after the mode.
- **With `makePlatform`,** the registered tenant gets the same config (with `checkout_mode: 'direct'`). Nothing is written to `config.onboarding`. P6-BRAND's suites set that themselves.
- **CLAIMS matches words, not meaning.** "stars" and "5 stars" are flagged, but a lone "star" is not. "review" as a verb is flagged unless `claims: false` is passed. "organic" is flagged even when it is true: the lexicon is for text the system writes, not text a founder writes.

## Owner checks

- **CI sqld download:** unchanged. The approval of its source and checksum is still the owner's. Nothing under `.github/` was touched.
- **The CLAIMS lexicon:** confirm the 13 words are the ones a generated store must never say, in particular "organic" and "guaranteed". A founder's own words are never scanned.
