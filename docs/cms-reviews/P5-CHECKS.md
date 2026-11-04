# P5-CHECKS: bundle warnings at publish, and the BINDING_INVALID remove path (COM-01, PUB-03, TREE-01)

Branch `cms/p5-checks`, cut from `f80ba0f` (`cms/phase-1`, after batch 1 merged). Plan: `docs/cms-reviews/P5-PLAN.md` (decision 10, the state contract in decision 8, batch 2) and `P5-BATCHES.json` (item P5-CHECKS). Requirements: COM-01, PUB-03, TREE-01. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the plan's list):
- Code: `lib/documents/checks.js`.
- Tests: `scripts/test-publish-checks.js` (a new P5-CHECKS section, 8 tests).
- Docs: this packet.

Not touched: `lib/commerce/bundle-words.js` (P5-BLOCKS owns it this batch for the no_saving words), `components/admin/editor/publish/publishModel.js` (its button words are used, not changed), `lib/documents/publish.js`, `package.json`, `.github/`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration. No new dependency.

Safety: only file databases were used (the suite's own `.test-pc-*.db`, plus one tenant-fixture database `.test-pc-bun-tenant.db`, all removed by the suite). No store changed mode except those test files, `--hosted` was never passed, Typesense was not touched, nothing was written to Shopify, and no test order was placed. `pnpm test` ran with the sqld suites pinned to ports 7120 to 7129 and the one web port to 6120; nothing was left listening on them afterwards.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `node scripts/test-publish-checks.js`: 39 passed, 0 failed (31 before, plus 8 new). `pnpm test`: 98 of 98 suites passed in 182.2 s. `pnpm build` passes (its 3 Turbopack warnings were there before) |
| Browser verified | **NOT DONE.** No real kind holds a bundle setting until P5-BLOCKS (same batch) and the inspector picker until P5-EDITOR, so a founder can't make one of these warnings in the editor yet. Every acceptance item is proved through the real console publish API instead. P5-DRILLS covers the publish panel in Chrome (owner check below) |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

A home page can now pick bundles by id (P5-SETTING). Bundles are not versioned: one can be deleted, turned off, sell out, or stop saving anything after the founder picked it. Before this item, publish said nothing, so the founder published a block that shoppers would not see, or would see as "Currently unavailable", with no warning. COM-01's state contract gives each of those states a publish warning (plan decision 8, last column), and PUB-03 says warnings never block.

TREE-01 (from the plan review, C4-4): a section whose body binding names a source that isn't in the source table blocks with BINDING_INVALID. Its words tell the founder to remove the section and add it again; this item proves that the Remove button really does that and that publish then succeeds.

## Design

`referenceChecks` (lib/documents/checks.js):

1. Every `{ ref: 'bundle', id }` that `refsOf` gives for a section's settings (a `bundle` setting, or each entry of a `bundle_list`) is collected with the other refs. A `/bundles/<slug>` link is a link ref and is not checked (known limit).
2. When the set holds no bundle ref, nothing is read: not one statement. Otherwise one `bundlesByIds([...ids])` call (lib/commerce/bundle-read.js, at most 3 statements for any number of ids), run in the same `Promise.all` as the collections, products and media reads and wrapped in the same `guarded()`. A read that throws is logged as `documents_publish_check_unreadable` with `table: "bundles"` and the bundle checks are left out; it never turns into a "deleted" warning.
3. Per ref, from the bundle's `state`:
   - `missing` -> BUNDLE_MISSING, `disabled` -> BUNDLE_DISABLED, `sold_out`, `no_saving`, `not_ready` -> BUNDLE_UNAVAILABLE.
   - The message is `“<title>”: <stateLine(state, reasons, { currency })> <what Remove takes>`. The name is the bundle's title, or its id once it is deleted. The middle sentence is bundle-words' own, with money in the bundle's currency (`currency ?? undefined`, so formatMoney never prints "null"). The tail says what goes: "Removing it takes this whole section off the page." for a card setting, "Remove this bundle from the grid, and the rest of the grid stays." for a grid entry.
   - BUNDLE_OVERLAP for a bundle that is turned on and shares a product with another turned-on bundle (`overlapsWith` from the same read): `“<title>”: <overlapLine()> It shares products with “<other>”.` It can come on top of a BUNDLE_UNAVAILABLE for the same bundle.
4. All four are `severity: "warning"`; none is in publish.js `STRUCTURE_CODES`, so classify() leaves them as warnings and publish goes on.
5. BUNDLE_MISSING, BUNDLE_DISABLED and BUNDLE_UNAVAILABLE are added to `REMOVABLE_WARNINGS`. The existing `actionsFor` then gives `removeItem { sectionId, field: "bundles", index }` for a grid entry (the field ends in a list index) and `removeSection` for a card. The buttons read "Remove it and publish" and "Remove this section and publish" (publishModel.js `actionLabel`, unchanged). BUNDLE_OVERLAP is not removable: `openField { sectionId, field }`.

No ₹, INR or other currency literal is in checks.js (a source scan pins it). Checks run only on a documents publish, so legacy stores never get here.

## Acceptance

Every test is in `scripts/test-publish-checks.js`, section "P5-CHECKS". "Fails without" was checked by running the suite against the base checks.js and against the mutations listed below.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | A card bound to a deleted bundle gives BUNDLE_MISSING with removeSection, and replaying it removes the section | DONE | "a card on a deleted bundle is BUNDLE_MISSING naming its id with removeSection …": the message names the id and holds bundle-words' missing sentence; the action is `removeSection`; its button is "Remove this section and publish"; the replayed body is saved and publishes with no issue for that section. Fails at base (no warning) and with M1 (`openField` only) |
| 2 | A bundle_list with one deleted and one turned-off bundle gives BUNDLE_MISSING and BUNDLE_DISABLED, each with removeItem for its own index only | DONE | "a grid with one deleted and one turned-off bundle …": `removeItem` index 0 for the deleted one and index 1 for the turned-off one, button "Remove it and publish", message says "Remove this bundle from the grid"; both replays leave `[{ id: <available bundle> }]` and the grid publishes clean. The available third entry is silent. Fails at base and with M1 |
| 3 | A sold-out component gives BUNDLE_UNAVAILABLE saying "Currently unavailable"; no_saving names the live sum through formatMoney; with USD no message has ₹ or INR, and checks.js has no such literal | DONE | "a sold-out component gives BUNDLE_UNAVAILABLE …" (sold-out component planted through `lib/sync.js writeProduct` with `availableForSale: false`; the no_saving bundle made by re-syncing two components cheaper, so the sum is 2500 against a price of 4000; the message holds `formatMoney(2500, "USD")` = "$2,500" and "Lower the price in Catalog > Bundles", not "Currently unavailable") and "publishing a home carrying all four …" (no ₹ or INR in any message; source scan of checks.js). Fails at base, and with M6 (currency dropped: the sum prints as ₹) |
| 4 | Overlapping turned-on bundles give BUNDLE_OVERLAP with openField only | DONE | "two turned-on bundles that share a product …": one overlap, on the picked bundle, naming the other; action `openField { sectionId, field: "bundle" }` only; no overlap from the turned-off bundle that shares products with a deleted one. Fails at base and with M5 (overlap made removable) |
| 5 | Publishing a document carrying all four warnings succeeds | DONE | "publishing a home carrying all four bundle warnings …": 200, the six bundle warnings in body order, all level "warns", every issue passes the suite's `checkIssues` shape check, and the live version holds every section. No acknowledgement is needed (the PRODUCT_UNAVAILABLE pattern: warnings ride along in the 200). None of the four codes is in `STRUCTURE_CODES`. Fails at base |
| 6 | When the bundles read throws, no BUNDLE_MISSING is reported and the checks-failed handling applies | DONE | "when the bundles read fails …": the `bundles` table is renamed for one publish (a real database error inside `bundlesByIds`); the publish is 200 with no bundle warning, and exactly one `documents_publish_check_unreadable` line with `table: "bundles"` is logged; with the table back, the six warnings return. Fails at base (no log line) and with M2 (unguarded read: the publish fails) |
| 7 | The bundle checks use the same statement count, at most 3, for 1 and 12 refs | DONE | "the bundle checks send the same statements for 1 and for 12 bundle refs …": `referenceChecks` on a grid of 1 and of 12 real, turned-on bundles, after one warm-up call; both send 3 statements (bundles + offers, variants, products), one of them `FROM bundles`. Fails at base (0 bundle statements) and with M3 (one read per bundle: 12 refs send far more statements than 1) |
| 8 | A planted unknown body binding gives BINDING_INVALID with the remove words; replaying removeSection clears it and publish succeeds | DONE | "P5-CHECKS (TREE-01): a planted body binding …": the draft writer refuses the body first (shown in the test); it is then planted straight into the test database (named test-only plant); publish is 422 with nothing stored, BINDING_INVALID on `bindings.products` with "This newest products section is set up in a way the editor can't fix. Remove it and add it again.", action `removeSection` ("Remove this section and publish"); after the replay the publish is 200 with no BINDING_INVALID. This proves behaviour P5-SOURCES and P3-CHECKS already ship (structure issues get removeSection), so it does not fail at base; it pins it |
| 9 | A document with no bundle reference sends no bundles, offers or bundle-variants statement during publish checks | DONE | Same test as 7: a whole publish of a home with no bundle ref is watched and has no statement matching `bundles`, `offers` or `FROM variants`; `referenceChecks` on a body with no reference sends nothing at all. It passes at base too (it guards the "no read without a ref" rule); it fails with M4 (a bundles probe sent when there is no ref) |
| 10 | `pnpm test` is green | DONE | 98 of 98 suites passed in 182.2 s; `pnpm build` passes |

### Do the tests bite?

| Mutation | Tests that fail |
|---|---|
| M0: base checks.js | the 7 bundle tests (all but the TREE-01 pin) |
| M1: bundle codes taken out of `REMOVABLE_WARNINGS` | card removeSection, grid removeItem, sold-out/no-saving removable |
| M2: bundles read not guarded | the read-fails test |
| M3: one `bundlesByIds` per ref | the statement-count test |
| M4: a bundles statement sent when there is no ref | the statement-count test (the no-ref half) |
| M5: BUNDLE_OVERLAP made removable | the overlap test |
| M6: currency not passed to bundle-words | all-four (₹ in a message) and the sold-out/no-saving test |

## Tests

- `scripts/test-publish-checks.js`, 8 new tests. A tenant-fixture file database (`TF.makeTenant`, 25 products in USD, written by `lib/sync.js writeProduct`) is registered on the suite's own control plane with the suite's owner as a member. Bundles are made with `lib/bundles.js createBundle` (turned on, `mustPass`), then `deleteBundle`, `setBundleEnabled(false)`, a sold-out component and two cheaper components through the sync writer. The fixture states are checked with `bundlesByIds` before any test runs (missing, missing, disabled, available, sold_out, no_saving, available, available). A throwaway home kind `p5c_bundles` with a `bundle` and a `bundle_list` setting stands in for the real kinds (defineSection, then removeSection at the end), because bundle_card and bundle_grid land in P5-BLOCKS.
- Existing statement-count tests in test-publish-checks and test-publish-service did not move (no bundle ref, no statement).

## Known limits

- The owner's OQ-B words for no_saving ("…, so shoppers don't see it.") come from P5-BLOCKS' change to `lib/commerce/bundle-words.js` in this same batch. This branch uses `stateLine('no_saving', …)` as it stands on `f80ba0f` ("…: shoppers can't add it."), so the BUNDLE_UNAVAILABLE message carries the new words as soon as P5-BLOCKS merges, with no change here. The test pins the message to bundle-words' sentence, the sum, and the absence of "Currently unavailable", so it stays green either way; it does not pin "don't see" (that would fail on this branch alone).
- not_ready uses bundle-words' not_ready line ("This bundle isn't ready for the cart yet: shoppers can't add it. …"), which does not say "Currently unavailable", although shoppers see those words on the block. All bundle wording comes from bundle-words.js (plan 0.5), so a change there is P5-BLOCKS' or a later item's.
- `/bundles/<slug>` links are not checked (plan decision 10, deviation 3.11).
- A bundle picked in the document's own settings (not a section) would also be checked, but no document type has a bundle setting.
- The same bundle picked in two sections gives one warning per section (each has its own Remove).
- BUNDLE_OVERLAP and BUNDLE_UNAVAILABLE can both appear for one bundle (overlap is about the cart's saving, unavailable about the block).
- The removed bundle's whole section goes with removeSection on a card; there is no "pick another" action at publish (the message says to pick another; the picker is P5-EDITOR's).
- Bundles are not versioned: a warning reflects the bundle as it is at publish time; a later edit in Catalog > Bundles changes the live block with no publish (plan section 4 owner check).
- The read-failure test renames the `bundles` table to make the read fail. That proves `guarded()` around `bundlesByIds`, not every way the read can fail.
- The statement count is taken on a file database with `referenceChecks` called directly; test-publish-service's sqld counts are unchanged because they hold no bundle ref.

From review:

- Test gap: nothing tests the `b.enabled &&` guard on BUNDLE_OVERLAP (lib/documents/checks.js bundleIssues). Mutation X1, which removes the guard, leaves all 39 tests passing. The test's line 'no overlap from a turned-off or deleted bundle' proves nothing, because the turned-off fixture 'Grid off kit' only shares products with a deleted bundle, and bundle-read lists only turned-on bundles in overlapsWith. A turned-off bundle that shares a product with a turned-on one would expose the mutation. I tried the real code with a temporary test: a turned-off 'Off overlap kit' sharing a product with the turned-on 'Overlap A kit' correctly gets only BUNDLE_DISABLED. Suggest adding that case.
- Test gap: no test covers not_ready going to BUNDLE_UNAVAILABLE. Mutation X2, which drops not_ready from BUNDLE_CODE_OF, passes all 39 tests. The brief lists not_ready under BUNDLE_UNAVAILABLE, though no acceptance item names it. I checked the real behaviour with a temporary test (bundle on, its offer row deleted): it gives BUNDLE_UNAVAILABLE "“NR kit”: This bundle isn't ready for the cart yet: shoppers can't add it. Open it in Catalog > Bundles and save it again. Removing it takes this whole section off the page." with removeSection. That is correct, so only the pin is missing.
- Words: BUNDLE_OVERLAP also fires on a bundle that is turned on but not_ready, sold_out or no_saving. It then sits next to a BUNDLE_UNAVAILABLE for the same field and says 'the cart may give a different saving than this block shows', but that block shows no saving. With no_saving now hidden, it shows nothing at all. This was seen on the not_ready probe. The packet records it as a known limit ('can both appear'). Suggest raising the overlap only for state 'available'. Mutation X5, which does exactly that, passes the current tests, so either choice is open. The owner should sign this off.
- The grid-replay tests remove entries with a hand-written filter instead of the editor's real publishModel.applyAction. I checked applyAction on the BUNDLE_DISABLED removeItem action { sectionId, field: 'bundles', index: 0 }: it routes through containerFor to settings.bundles and drops only that entry, leaving the other one ([{ id: fine }]). Behaviour is correct. Suggest the test call applyAction so a future containerFor change gets caught.
- Merge order: on this branch alone, the no_saving BUNDLE_UNAVAILABLE message still says 'shoppers can't add it'. The owner's OQ-B words ('so shoppers don't see it') arrive only when P5-BLOCKS changes bundle-words.js, and P5-BATCHES confirms BLOCKS owns that change. The deferral is correct under file ownership. After both merge, check that the batch merge carries the new words; the packet lists this as an owner check. The not_ready line does not say 'Currently unavailable', also a recorded known limit that belongs to bundle-words.
- Verified: pnpm test passed 98 of 98 suites on ports 7320-7329 and 6320; test-publish-checks passed 39 of 39; pnpm build exits 0. Mutations X3 (grid and card Remove wording swapped) and X4 (reasons dropped, so the sum disappears) are each caught. checks.js stays server-only: its only importers outside lib/documents/publish.js mention it in comments, so no client bundle pulls in bundle-read. Its new imports, bundle-read.js and bundle-words.js, are edge-safe (no node: modules). Nothing listens on my ports any more, and the review worktree rv0 is removed.

## From review

(Empty until review.)

## Owner checks

- Prerequisite: phase 5 on staging with a documents-mode tenant.
- In the editor (once P5-BLOCKS and P5-EDITOR are in): publish a home with a bundle card on a deleted bundle, a grid with a turned-off bundle, a sold-out bundle, a bundle whose price no longer saves, and two bundles sharing a product. Check the publish panel shows each warning under "Check", that "Remove this section and publish" and "Remove it and publish" do what the message says, and that the overlap only opens the field (P5-DRILLS covers this in desktop Chrome; phone widths and Safari stay owner checks).
- Read the six messages as the founder would and sign off the words, including the "“<id>”" name a deleted bundle gets.
- (Carried) The CI sqld download in `.github` still needs the owner's approval of its source and checksum; this item did not touch `.github`.
