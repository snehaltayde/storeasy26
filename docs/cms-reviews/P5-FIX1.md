# P5-FIX1: the batch 1 review findings P5-EDITOR does not own (COM-01, COM-02)

Branch `cms/p5-fix1`, cut from `425b844` (`cms/phase-1` after batch 1 merged and its review findings were folded in). Plan: `docs/cms-reviews/P5-PLAN.md` and `P5-BATCHES.json` (item P5-FIX1). Requirements: COM-01, COM-02. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the item's list):
- Code: `lib/commerce/bundle-compat.js`, `lib/bundles.js`, `lib/commerce/bundle-words.js`, `lib/documents/checks.js`, `components/sections/BundleCardSection.js`, `app/(storefront)/bundles/[slug]/page.js` (the unavailable sentence only).
- Tests: `scripts/test-commerce-exp.js` (3 new), `scripts/test-commerce-blocks.js` (3 new), `scripts/test-publish-checks.js` (1 new, 2 replays changed to the editor's `applyAction`).
- Fix round 1, at the orchestrator's direction: `scripts/test-bundle-form.js`, one assertion (see "The test-bundle-form conflict"). This file is P5-EDITOR's in batch 3 and was outside this item's list; the orchestrator's fix round told this item to land the change so the merge is green.
- Docs: this packet.

Not touched: `lib/commerce/bundle-read.js` (it calls `compatFrom`, so it picks up both rulings with no change), `components/admin/bundles/BundleForm.js` and everything else P5-EDITOR owns (apart from the one `test-bundle-form.js` assertion above), `components/admin/editor/publish/publishModel.js` (imported, not edited), `package.json`, `.github/`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration. No new dependency.

Safety: only file databases were used (the suites' own and `scripts/support/tenant-fixture.js`). No store changed mode except those test files, `--hosted` was never passed, Typesense was not touched, nothing was written to Shopify, no test order was placed. `pnpm test` ran with every port-taking suite pinned to 6120 and 7120 to 7129 (in both rounds); nothing was listening on them afterwards. No server was started for this item.

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done. Fix round 1: `pnpm test` **98 of 98 in 185.0 s** (exit 0). Round 0 had `test:bundle-form` red (97 of 98); its one assertion pinned the false sum ruling 1 removes, and it is now changed (see "The test-bundle-form conflict"). `pnpm build` passed in round 0; round 1 changed only a test file |
| Browser verified | **NOT DONE.** Every acceptance item is proved by unit and rendered tests (the real bundle page is rendered with Next's SWC and react-dom). The desktop Chrome check is an owner check (P5-DRILLS) |
| Staging | **NOT DONE** |

## Orchestrator rulings (no owner answer; recorded here as the brief asks)

1. **A bundle with a missing (deleted) product never gets `no_saving`.** `compatFrom` adds `no_saving` only when every product was found (its variant and its product). The founder is told to replace the product, never to lower the price on a false sum. The shopper result is unchanged from before P5-BLOCKS' fix round 1: state `sold_out`, the card shows "Currently unavailable" with the product marked "No longer available", and a grid keeps the cell.
2. **`bad_quantity` moves into `compatFrom`**, so `/bundles/<slug>` (`lib/bundles.js getBundle`) and the home blocks (`lib/commerce/bundle-read.js`) agree: a quantity that is not whole is `not_ready` on both. The bundle page then says "This bundle isn't available right now.", never "A component is out of stock".
3. **BUNDLE_OVERLAP is raised only for a bundle in state `available`** (which is always shown to shoppers), so never next to BUNDLE_UNAVAILABLE for the same field.

## What and why

From review (batch 1), the findings this item owns:

- **P5-BLOCKS: wrong words for the founder.** A bundle A ($100) + B ($100) at $180 whose B was deleted read `[missing, no_saving]` with sum $100. After BLOCKS' fix round 1 it was hidden, and the preview note said "The price no longer saves anything (the products add up to $100) … Lower the price". The sum was false and the advice wrong. Fixed by ruling 1.
- **P5-PANEL: storefront side effect of `bad_quantity`.** The reason sat in `lib/bundles.js bundleCompat`, which `getBundle` uses but `bundle-read.js` does not. A live legacy bundle stored with quantity 1.5 showed on `/bundles/<slug>` as unavailable, saying "A component is out of stock", while the home blocks showed it as available. Fixed by ruling 2.
- **P5-CHECKS: overlap words.** BUNDLE_OVERLAP fired on a turned-on bundle that was `not_ready`, `sold_out` or `no_saving`, next to its BUNDLE_UNAVAILABLE, saying "the cart may give a different saving than this block shows" about a block that shows no saving. Fixed by ruling 3.
- **P5-CHECKS: test gaps.** The `b.enabled &&` guard (mutation X1 survived), `not_ready -> BUNDLE_UNAVAILABLE` (X2 survived) and "overlap only for available" (X5 survived) are now pinned, and the grid and card replays call the editor's real `publishModel.applyAction`.
- **P5-CHECKS: merge order.** Checked on `425b844`: the no_saving BUNDLE_UNAVAILABLE message carries the owner's OQ-B words ("…, so shoppers don't see it."). Nothing to change.
- **P5-PANEL Known limit: `bad_quantity` had no bundle-words sentence.** `reasonSentence` now has one ("The quantity must be a whole number, 1 or more"). The reason still carries `words` too, so BundleForm's `reasonWords` reads the same either way.

The other batch 1 findings are P5-EDITOR's (the inspector's reasons-aware words; every BundleForm item: the disabled-until-passes pin, cents in the saving, the quantity input, the Disable confirm when `usedOnHome` is null, naming the row of an unresolved handle). Not touched here.

## Design

### `lib/commerce/bundle-compat.js` (rulings 1 and 2)

- `compatFrom` tracks `allFound`: false when a product's variant is not in the catalog, or its variant is there but its product is not. `no_saving` (reason and the legacy problem string) is added only when `allFound`. A sold-out product (found, unavailable) still allows `no_saving`, as before ("sold_out beats no_saving" stays).
- `bad_quantity` is checked per product inside the loop: a quantity that is a finite number but not whole gives `{ kind: 'bad_quantity', index, title, words }` and the legacy problem `component N (title): quantity must be a whole number`, as P5-PANEL wrote them. `bad_quantity` joined the `NOT_READY` set, so `stateOf` gives `not_ready`. A missing or non-numeric quantity still reads as 1 (unchanged). `isBadQuantity` and `BAD_QUANTITY_WORDS` moved here; `lib/bundles.js` re-exports `isBadQuantity`.
- The reasons now come in product order (a `bad_quantity` reason sits with its product), not "all bad quantities first". The existing tests only look at kinds and the first reason of a one-reason case.

### `lib/bundles.js`

- `bundleCompat` returns `compatFrom`'s answer as it is (`withQuantityCheck` is gone). `assertWholeQuantities` and every write rule are unchanged.
- `getBundle` reads the full compat and adds `state` **only when the bundle can't be bought** (`sold_out`, `not_ready`, `no_saving`). An available bundle keeps the exact shape the test-effective-read snapshot (recorded at 17a08b7) holds; that suite stays green.

### `lib/commerce/bundle-words.js`

- `stateLine('sold_out', reasons)` with a `missing` reason: "A product in this bundle is no longer in your catalog: shoppers see Currently unavailable and can't add it. Replace it with another product in Catalog > Bundles." Without one, the sold-out sentence is unchanged. So the publish check (BUNDLE_UNAVAILABLE), the console panel's banner and the preview note all say the same thing.
- `reasonSentence({ kind: 'bad_quantity' })`: "The quantity must be a whole number, 1 or more".
- `BUNDLE_PAGE_UNAVAILABLE` = "This bundle isn't available right now." and `bundlePageSaysOutOfStock(b)` (true only for an unbuyable bundle in state `sold_out`). The out-of-stock sentence itself stays in the page: bundle-words' source scan forbids the word "component ".

### `app/(storefront)/bundles/[slug]/page.js` (the sentence only)

Under the add button, for a bundle that can't be bought: the old "A component is out of stock — the set comes back when it does." when `bundlePageSaysOutOfStock(b)`, otherwise "This bundle isn't available right now.". Nothing else on the page changed (its hard-coded INR stays, a carried limit).

### `components/sections/BundleCardSection.js`

`BundleBox` takes an optional `ctx`. A shown bundle with a `missing` reason (`hasDeletedProduct`) gets a `FounderNote` (P5-HIDDEN's, which renders only in a documents preview) under its add button, with the bundle-words line above and `data-bundle-note="missing-product"`. The card passes its `ctx`; the grid passes none, and `FounderNote` then asks the request whether it is a documents preview, so a grid cell gets the same note without touching `BundleGridSection.js`. Live markup is unchanged (test-sections-render's live digests are unchanged).

### `lib/documents/checks.js` (ruling 3)

`bundleIssues` raises BUNDLE_OVERLAP only when `b.enabled && b.state === "available"` and `overlapsWith` is not empty. The header comment says so.

## Acceptance, with evidence

Mutations were each applied alone with `mut.sh` in the scratch folder (it puts the file back after the run).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | A bundle with a deleted product never gets no_saving and its preview says to replace the product | DONE | test-commerce-exp "P5-FIX1: compatFrom gives no no_saving while any product is missing…" (the review's $100 + $100 at $180 case: reasons exactly `[{missing, index 1}]`, state `sold_out`, no "doesn't save" problem; a product gone with its variant still there: the same; every product found: `no_saving` as before; the founder words exactly the new sentence, with no "Lower the price") and "…a turned-on bundle whose product was deleted from the catalog…" (the variant row really deleted: bundlesByIds, listBundles and getBundle all `sold_out` with only `missing`). test-commerce-blocks "a card whose bundle lost a product…" (live and preview: shown, "Currently unavailable" with add off, the product marked "No longer available", no no-saving words; live has no note; the preview note holds the replace sentence and "Only you can see this note in your preview.") and "in a grid, the bundle that lost a product keeps its cell…" (cells `[available, sold_out]` live and in preview, no "hidden from shoppers", the note inside the sold-out cell). Fail without the change: M1 (no `allFound`) fails 2 in each suite; M7 (no note) fails the 2 blocks tests; M8 (no replace words) fails 2 in each |
| 2 | A non-whole quantity is not_ready on the bundle page and the home blocks, with the bundle page's own sentence | DONE | test-commerce-exp "…stored with a quantity of 1.5 (offer in step)…": the row and its offer agree on 1.5 (so no `not_synced`); bundlesByIds `not_ready` with exactly `[bad_quantity]` naming "Fixture product 7"; getBundle `available: false, state: not_ready`; the page rule and words; a sold-out bundle keeps the out-of-stock rule; a source check of the page. test-commerce-blocks "…is not_ready on the home card AND on the real bundle page…": the home card says "Currently unavailable" with add off; **the real `app/(storefront)/bundles/[slug]/page.js` is rendered** in the store (its `tfetch` and closed-store gate stubbed to run in this store, open) and says "This bundle isn't available right now.", not "A component is out of stock", with "Currently unavailable" off; the sold-out "night-set" page still says the out-of-stock sentence; the available "gym-kit" page says neither. Fail without the change: M2 (no bad_quantity in compatFrom) fails it in both suites (and P5-PANEL's own 1.5 test); M3 (the page's old sentence) fails both; M9 (getBundle without `state`) fails both |
| 3 | Overlap only for an available bundle; the enabled guard, not_ready -> BUNDLE_UNAVAILABLE and the real applyAction replay are pinned | DONE | test-publish-checks "P5-FIX1: a turned-off bundle sharing a product with a turned-on one gets only BUNDLE_DISABLED…": "Off overlap kit" (off) and "NR kit" (on, offer row deleted, so `not_ready`) each share a product with the available "On overlap kit", and the read lists it in both `overlapsWith` (so only the checks' rule keeps the overlap off). The publish gives exactly `[BUNDLE_DISABLED sec_xoff, BUNDLE_UNAVAILABLE sec_xnr, BUNDLE_OVERLAP sec_xon]`, no overlap beside another bundle warning on the same field; NR's message is the not_ready line with "takes this whole section off the page", its action `removeSection` ("Remove this section and publish"); replaying it through `applyAction` and publishing again leaves `[BUNDLE_DISABLED, BUNDLE_OVERLAP]`. The card replay (BUNDLE_MISSING) and the grid replay (removeItem at index 1, then 0) now call `publishModel.applyAction`; the grid replay also checks nothing else in the body changed. Fail without the change: M4 (overlap for any turned-on bundle, the code at 425b844), M5 (no guard at all, X1) and M6 (`not_ready` dropped from BUNDLE_CODE_OF, X2) each fail it |
| 4 | pnpm test passes | DONE (fix round 1) | `98 of 98 suites passed in 185.0s`, exit 0, ports 6120 and 7120 to 7129, nothing listening afterwards. Round 0 was 97 of 98 (`test:bundle-form`); the one assertion is changed in this branch at the orchestrator's direction (below). The changed assertion fails without ruling 1: M1 (`allFound` dropped, so `no_saving` comes back on the false sum) gives test-bundle-form `8 passed, 1 failed`, the failure being that test; with the fix, 9 passed |

### Mutation table

| # | Mutation (alone) | Result |
|---|---|---|
| M1 | `no_saving` added even when a product is missing (`allFound` dropped) | test-commerce-exp 2 failed; test-commerce-blocks 2 failed |
| M2 | no `bad_quantity` in `compatFrom` | test-commerce-exp 2 failed (incl. P5-PANEL's 1.5 test); test-commerce-blocks 1 failed |
| M3 | the bundle page always says "A component is out of stock" | test-commerce-exp 1 failed; test-commerce-blocks 1 failed |
| M4 | overlap for any turned-on bundle (base) | test-publish-checks 1 failed |
| M5 | overlap with no guard at all (review X1) | test-publish-checks 1 failed |
| M6 | `not_ready` dropped from BUNDLE_CODE_OF (review X2) | test-publish-checks 1 failed |
| M7 | no founder note on a shown bundle with a deleted product | test-commerce-blocks 2 failed |
| M8 | the sold-out line ignores a missing product | test-commerce-exp 2 failed; test-commerce-blocks 2 failed |
| M9 | getBundle without `state` | test-commerce-exp 2 failed; test-commerce-blocks 1 failed |
| M1 (fix round 1) | `allFound` dropped, run against test-bundle-form | test-bundle-form 8 passed, 1 failed ("a failing check renders bundle-words reasons per product row and under the price…") |

## The test-bundle-form conflict (landed in fix round 1)

`scripts/test-bundle-form.js` (P5-PANEL's in batch 2, P5-EDITOR's in batch 3; this item's brief kept it out of its files) lines 420 to 423 pin "Price must be lower than $400" under the price for a bundle of [sold-out product 1 ($100), a variant not in the catalog, product 3 ($300)] at $1,000. The $400 leaves out the missing product: the false sum ruling 1 says the founder must never be told. After this item the form shows "Sold out" and "No longer available" on the rows and nothing under the price. The change (it was proposed in round 0 as `test-bundle-form.proposed.patch` in the scratch folder, and applied as it was in fix round 1):

```js
      // P5-FIX1 (ruling 1): with a product missing the sum is not the real one,
      // so there is no "Price must be lower than …" under the price; the
      // missing row says "No longer available" (replace it)
      const price = v.find((n) => n.props?.["data-bundle-price-reason"] === "");
      ok(!price || !/Price must be lower/.test(textOf(price.props.children)), "no price reason on a false sum");
```

Fix round 1: the reviewer's blocker said the merge must carry this change, and the orchestrator's fix round told this item to fix it, so it is committed here: the old two-line check ("a price reason" and "Price must be lower than $400") is replaced by the check above; the rest of that test (the row reasons "Sold out", "No longer available", the legacy-words scan, the titles) is unchanged. **For P5-EDITOR:** this touches lines 417 to 424 of its file; if its branch also edits that test, take this version of those lines at merge.

## Tests

- `scripts/test-commerce-exp.js`: 44 passed (41 + 3 new).
- `scripts/test-commerce-blocks.js`: 18 passed (15 + 3 new). The new page test adds two loader stubs (`@/lib/tenant-request` `tfetch` runs the read in this suite's store; `@/lib/content/resolve` `closedStoreGate` answers open) after every block test has loaded, so only the bundle page uses them.
- `scripts/test-publish-checks.js`: 40 passed (39 + 1 new; the card and grid replays now use `applyAction`). The new test's three bundles are deleted at the end and the home body is put back, so the later read-fails and statement-count tests see what they saw before.
- Unchanged and green: test-effective-read 41 (the getBundle snapshot), test-sections-render 45, test-bundle-form 8 of 9 (see above).
- `pnpm test`: round 0 `97 of 98 suites passed in 186.0s`; fix round 1 `98 of 98 suites passed in 185.0s` (ports 6120, 7120 to 7129). `pnpm build` (round 0): passes; its 2 Turbopack warnings are the existing `next.config.mjs` NFT-trace ones.
- `scripts/test-bundle-form.js`: 9 passed (fix round 1; was 8 of 9).

## Known limits

- **The bundle page's no-saving case changed too.** An enabled bundle that saves nothing used to say "A component is out of stock" on `/bundles/<slug>`; it now says "This bundle isn't available right now." (ruling 2's rule is "out of stock only for sold_out"). Both are unbuyable; the new words are true.
- **A deleted product on the bundle page** still reads as `sold_out`, so the page says "A component is out of stock — the set comes back when it does." with that product marked "NO LONGER AVAILABLE". It won't come back by itself; the founder must replace it (the preview note, the publish check and the console say so). Changing the shopper words there was not in the rulings.
- **The founder note for a deleted product shows only for a bundle that is shown.** A turned-off bundle with a deleted product keeps the turned-off words. A shown `sold_out` (no product deleted) or `not_ready` card still has no preview note of its own; the publish check and the inspector say why.
- **getBundle's `state` is present only when the bundle can't be bought**, to keep the available shape byte-identical for the test-effective-read snapshot. A caller must treat a missing `state` as "available".
- **The console form** no longer shows "Price must be lower than …" while a product is missing; it shows the row reasons only. After the founder replaces the product, the price reason (if any) comes back on the real sum.
- **Reason order** from `compatFrom` is now product order, with a `bad_quantity` reason next to its product (it was all `bad_quantity` reasons first).
- Carried: the bundle page's hard-coded INR; getBundle and the bundle page don't check the offer sync (`not_synced`), so a bundle whose offer is gone is still sold there; `/bundles/<slug>` links are keyed by slug and unchecked; bundles are not versioned.

## Owner checks

- **Orchestrator/merge:** the one-assertion change to `scripts/test-bundle-form.js` (P5-EDITOR's file) is in this branch (fix round 1); confirm it, and watch for a conflict at those lines when P5-EDITOR merges.
- Sign-off of the three orchestrator rulings above, and of the new words: "A product in this bundle is no longer in your catalog: shoppers see Currently unavailable and can't add it. Replace it with another product in Catalog > Bundles." and the bundle page's "This bundle isn't available right now."
- **Browser (P5-DRILLS):** desktop Chrome on the design harness: a home card and a grid cell whose bundle lost a product (live: "Currently unavailable", product marked; preview: the replace note), and `/bundles/<slug>` of a bundle stored with quantity 1.5 (only possible by a raw write today).
- Phone widths (375, 768) and Safari for the new preview note.
- Staging: NOT DONE, as for the rest of phase 5.
- (Carried) The CI sqld download under `.github/` still needs the owner's approval of its source and checksum. This item added nothing under `.github/`.

## From review

### Round 1 (fix round 1)

- **BLOCK: `pnpm test` fails, caused by this branch** (`test:bundle-form` expects "Price must be lower than $400" for a bundle with a missing product, the false sum ruling 1 removes). Accepted. Fixed by committing the proposed one-assertion change to `scripts/test-bundle-form.js`, as the orchestrator's fix round directed (the file is P5-EDITOR's; flagged above for its merge). Proof: the new check fails with ruling 1 undone (M1: 8 passed, 1 failed) and passes with it (9 passed); `pnpm test` 98 of 98, exit 0. No code changed in this round.
