# P5-BLOCKS: the bundle card and bundle grid sections (COM-01, COM-02, TREE-01)

Branch `cms/p5-blocks`, cut from `f80ba0f` (`cms/phase-1` after batch 1 merged). Batch 2, merges first in batch 2 (plan 0.1). Plan: `docs/cms-reviews/P5-PLAN.md` (decisions 1, 5 to 9; section 0) and `P5-BATCHES.json` (item P5-BLOCKS), with the owner's answers of 2026-11-05 (OQ-B against the default: a bundle that saves nothing is hidden).

This is the author's own report. Reviewers should re-read the code.

Migrations owned: none. No store changed mode, `--hosted` was never passed, nothing went to Typesense or Shopify, no test order was placed (the cart check runs `lib/cart.js` on a file database). Only file databases were used (`scripts/support/tenant-fixture.js` and the suites' own). No server was started for this item: port 6100 was given to test:migrate-documents' web server during `pnpm test`, and 7100 to 7109 to the sqld suites; each suite stops its own.

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` 98 of 98 suites in 194.2 s, `pnpm build` passes (see Tests) |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a rendered or unit test (below). No desktop Chrome drill on the design harness was run: the harness would first need bundles and a published home holding bundle blocks, which is P5-DRILLS' job (owner check) |
| Staging | **NOT DONE** |

## What

1. **Two section kinds** (`lib/registry/sections.js`):
   - `bundle_card` "Bundle card": home only; settings `title` (text, "Heading", max 80, softMax 50, default "") and `bundle` (kind `bundle`, "Bundle", required, default null); binding `{ bundle: { sources: ["bundle_by_id"], args: ["bundle"] } }`; starts incomplete; placeholder "Pick a bundle to show its products, price and saving".
   - `bundle_grid` "Bundle grid": home only; settings `title` ("Heading", default "Bundles") and `bundles` (kind `bundle_list`, "Bundles to show", required, max 12, default []); binding `{ bundles: { sources: ["bundles_by_ids"], args: ["bundles"] } }`; starts incomplete; placeholder "Pick the bundles to show side by side".
   - Neither is in `HOME_LEGACY` (`lib/content/documents-reader.js`), `HOME_SECTION_KINDS` or `lib/cms/registry.js`.
2. **`lib/cms/section-data.js`**: `bundlesByIds` (from `lib/commerce/bundle-read.js`) added to `DEFAULT_REPO`. Nothing else there changed.
3. **`lib/registry/token-usage.js`**: both kinds use colours, fonts, shapes and spacing (a bordered card, rounded photos, a button, a sale chip, section padding).
4. **`lib/registry/fixtures.js`**: `worstBundle(id, state)` gives a bundle entry as `bundlesByIds` does: a 120-character title, 6 products (the third has no photo, the fifth is sold out when the state is `sold_out`), currency USD. The card's worst case is a sold-out bundle; the grid's `max_items` case holds 12 entries cycling through every state (`WORST_GRID_STATES`). The data follows the section's own ids, so cells match the picked list.
5. **`components/sections/BundleCardSection.js`** (new, server, edge-safe). `BundleBox` shows the "N-piece set" line, the bundle title (linked to `/bundles/<slug>`), each product with its photo (or the token fallback `MediaFallback` when it has none), its quantity and, when it can't be bought, "Sold out" or "No longer available" (as the bundle page marks them), then the price, the struck-through sum when it is higher, "You save <formatMoney(saving, bundle.currency ?? undefined)>" when the saving is above 0, the add button and a "See the set" link. The add button is `components/BundleAddButton.js` with `components` holding only `{ variantId, quantity, available }` per product and `disabled` unless the state is `available`. So `sold_out` and `not_ready` say "Currently unavailable" with add off.
   - `shows()`: true for `available`, `sold_out`, `not_ready`, unless the bundle's reasons include `no_saving`. False for `no_saving` (OQ-B), `disabled`, `missing` and an absent entry. Fix round 1: bundle-compat's `stateOf` ranks `sold_out` and `not_ready` above `no_saving`, so a bundle that saves nothing and also has a sold-out or deleted product (or is not ready) has state `sold_out` or `not_ready`. `isShown` now also checks the reasons (`savesNothing`), so such a bundle is hidden too, as the owner's OQ-B answer says.
   - `hiddenReason()`: the bundle-words sentence for the state (an absent entry gets the "deleted" one). A hidden bundle whose reasons include `no_saving` gets the no-saving sentence, unless it is turned off or deleted (those keep their own words).
6. **`components/sections/BundleGridSection.js`** (new). One `BundleBox` per shown entry, in the picked order. A dropped entry (`no_saving`, `disabled`, `missing`, or any whose reasons include `no_saving`) renders nothing live; in a documents preview only (`isFounderPreview(ctx)`) a `FounderNote` takes its place, titled "<bundle title or Bundle N>: hidden from shoppers", with that bundle's reason and `data-bundle-cell="<index>"`. `shows()`: at least one shown entry. `hiddenReason()`: "None of the bundles in this grid can be shown, so shoppers don't see it." followed by "<name>: <reason>" for each picked bundle.
7. **`components/sections/index.js`**: both registered in `COMPONENTS`, and in `textFields` (the heading gets the editor's `data-field="title"` in preview).
8. **`lib/commerce/bundle-words.js`** (owned this batch for this change only): the `no_saving` line now reads "The price no longer saves anything (the products add up to <sum>), so shoppers don't see it. Lower the price in Catalog > Bundles." (OQ-B).
9. **Batch 0 review fixes**:
   - `lib/registry/sources.js`: the bundle sources read their declared argument by name (`BUNDLE_ARG` "bundle", `BUNDLES_ARG` "bundles"), never "the first argument other than limit". The shared prefetch reads both names, since it can't tell which of the two sources an instance's args came from.
   - `lib/registry/index.js` `checkBindings`:
     - a binding that gives both `source` and `sources` now throws;
     - new: a binding must pass every argument its source declares, other than `limit`, so a kind can't bind `bundle_by_id` to a setting with another name and have it read nothing.
   - `data.bindingFailedCause` is read only from the data object section-data made: a new end-to-end test proves the home page hands that object through unchanged.
   - `scripts/test-registry-contract.js`: the class `invalid` of the two bundle_list errors is pinned. `entries` moved out of `PLAIN_KINDS` into a named `EXEMPT_KINDS` entry with its reason ("system type journal_index: generated, never written by an editor"), plus a check that only `journal_index` holds it.

## Why

COM-02 asks for a bundle card and grid a founder can compose on the home page. COM-01 asks that each state of a bound bundle has one defined shopper and founder behaviour. TREE-01 asks that bindings are a table and that the version body holds only the id. P5-SOURCES, P5-BUNDLEREAD, P5-SETTING and P5-HIDDEN built the source table, the bounded read, the setting kinds and the founder notes. This item declares the kinds and renders them.

## Design notes

- **The state rule lives in one place.** `SHOWN_STATES`, `isShown` (state and reasons) and `bundleReason` are exported from `BundleCardSection.js`, and the grid uses them, so the card and the grid cells can't disagree.
- **Words.** Every founder sentence comes from `lib/commerce/bundle-words.js`. The shopper words come from what already exists: "Currently unavailable" and "Add the set to cart" from BundleAddButton, and "Sold out" / "No longer available" as on the bundle page. New shopper words: "N-piece set" (as on the bundle page), "You save <money>" and "See the set →".
- **Money.** Only `formatMoney(amount, bundle.currency ?? undefined)`. No currency sign or code is written. The rendered tests use USD and check for no ₹ or INR.
- **Single text nodes.** "You save $50", "×2" and "2-piece set" are built as one string each, so the streaming renderer writes no `<!-- -->` inside them.
- **The grid's founder note** is HIDDEN's `FounderNote`, which checks the preview itself. So even a grid that asked for a note live would render nothing there (mutation M3 below shows this guard holds on its own).
- **Overlap** (`overlapsWith`) is data for P5-CHECKS and P5-EDITOR. The card still shows for shoppers.

## Acceptance, with evidence

"Fails without the change": each mutation below was applied alone and the named suite run (helper `mut.sh` in the scratch folder). For the two new components, the base has no such kind at all, so every block test fails there.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | An available card renders title, products, price, saving in the bundle's currency, and an enabled add button | DONE | test-commerce-blocks "an available card renders…": heading, "Gym kit", both product titles, `$250`, `$300` struck through, `You save $50`, `href="/bundles/gym-kit"`, one button "Add the set to cart" with no `disabled`, no ₹ or INR, live and in preview (preview equals live apart from the editor's `data-field`). M4 (no `bundlesByIds` in DEFAULT_REPO) and M6 (`cur = "INR"`) fail it |
| 2 | A sold-out card marks the product "Sold out", says "Currently unavailable", add off, live and in preview; not_ready the same; a no_saving card is hidden live with its note in preview | DONE | "a card with a sold-out product…" (the sold-out product's row holds "Sold out", the in-stock one doesn't; the one button is `disabled=""` "Currently unavailable"; not_ready the same, with no product marked) and "a no_saving card…" (live `""`; preview has "Bundle card: hidden from shoppers" and the exact new sentence with `$700`). M1 (no_saving shown), M14 (no hiddenReason) and M15 (old words) fail them |
| 3 | Disabled and missing cards render nothing live and the bundle-words reason in preview, without throwing | DONE | "disabled and missing cards…": the turned-off and deleted sentences in preview, `""` live; also a card whose entry is absent (no data). M14 fails it |
| 4 | An all-hidden grid renders nothing live and the no-results reason in preview | DONE | "a grid whose bundles are all hidden…": turned off + deleted + no saving: live `""`; preview has the grid-empty sentence and "Off set: This bundle is turned off…", "Bundle 2: This bundle was deleted…", "Dear set: The price no longer saves anything…". M1 fails it |
| 5 | A mixed grid renders only the available and sold-out cells live, in picked order, the sold-out one "Currently unavailable" with add off; in preview a note per dropped cell; no note live | DONE | "a mixed grid…": picked `[off, sold, deleted, avail, nosave]`; live cells are exactly `[sold, avail]` in that order; the sold cell's button is `disabled=""` "Currently unavailable" and its product says "Sold out"; live has no founder note and no dropped bundle's name; preview has notes at cells 0, 2 and 4 with their reasons, in the order note, sold, note, available, note. M1, M2 (no cell note) and M6 fail it |
| 6 | When bundlesByIds rejects, every bundle section gets bindingFailed and logs section_binding_failed | DONE | "when bundlesByIds rejects…": 2 cards and a grid, each `bindingFailed` with its field and cause `fault`, three log lines; live renders `""`; preview shows the failed note with the reload words for all three |
| 7 | 2 cards and 1 grid of 4 call bundlesByIds once with at most 3 statements after a warm-up | DONE | "a home with 2 bundle cards and 1 grid of 4…": a spy repo sees one call with 5 deduped ids in first-seen order; through the real DEFAULT_REPO, after one warm-up, `watchStatements` counts exactly 3; the data equals the spy's. M4 fails it |
| 8 | The transitive import scan finds no lib/offers/ module and no node: import | DONE | "the transitive import scan…": from both components, `lib/registry/sources.js` and `lib/commerce/bundle-read.js`, following relative and `@/` imports. It reaches BundleAddButton, CartContext, bundle-words, format, parts, db and effective (asserted, so the scan really follows). No `lib/offers/` file. The only Node module reached is `lib/tenant-context.js: node:async_hooks`, which the edge runtime provides and test-commerce-exp already allows. test-sections-render's edge scan now also lists BundleAddButton, CartContext, sources, bundle-read, bundle-compat, bundle-words and format |
| 9 | The cart from the block's add props equals the cart from getBundle components | DONE | "the cart from the block's add props…": the loader records the props the block really passes to the real BundleAddButton (`components`, `disabled` only; per product exactly `available`, `quantity`, `variantId`). BundleAddButton's add loop is run with `lib/cart.js addItem` for those props and for `getBundle("gym-kit").components`. Lines, appliedOffers (id and amount) and total are equal, and the BUNDLE amount equals the saving the block shows. M5 (passing the full components) fails it |
| 10 | The overlap fixture lists the overlapping bundle; no payload contains catalog_title or sku | DONE | "overlap fixture…": A = {v7, v8} at 180 and B = {v7, v8, v9} at 200, both on. B's entry lists `[{ id: A, title: "Pair A" }]` and A lists B. The card still shows. "no rendered or serialised block payload…": the resolved data JSON, the recorded add props, and the live and preview markup of 2 cards and a grid of 6 hold no `catalog_title`, `sku` or fixture SKU (`FX-n`) |
| 11 | test-registry-contract: no P5-SETTING exemption remains; checkRegistry names a kind whose source was removed; checkRegistry() is [] for the real registry | DONE | `NOT_DECLARED_YET` and the `zz_badbundle` probe are gone. The "declared somewhere" check now also asserts that bundle and bundle_list are declared, and their bad values run through the real kinds. New test "P5-BLOCKS: checkRegistry names a kind…": `defineSource` a throwaway source, a throwaway kind on it, `removeSource`; `checkRegistry()` is exactly `['zz_throwaway_kind: binding "things" names the source "zz_throwaway_src", which is not in the source table']`; `[]` before and after. M10 (no source check in `checkSectionContract`) fails it |
| 12 | test-editor-tree: bundle_card and bundle_grid offered on home only | DONE | "P5-BLOCKS: bundle_card and bundle_grid are offered on the home page only…": in home's offered kinds and picker, and addable; not allowed, listed or addable on page, campaign or journal; the only section type allowing either is `home`; a new one has only incomplete issues |
| 13 | test-sections-render and test-design-doc: every kind has a component and token entry; the a6d028e legacy fixtures are unchanged | DONE | test-sections-render: `checkSectionComponents` is `[]` with the two kinds. The root-attributes test renders both with a shown bundle. The a6d028e legacy fixture tests (section 2) pass with the fixtures and `home-render-outputs.js` untouched. The BASE_LIVE digests of the ten older kinds are unchanged, and the two new kinds' digests were recorded with `SR_RECORD=1`. test-design-doc: the existing "every kind has an entry" check, plus the bundle groups and "one entry per registered kind, no more" |
| 14 | pnpm test is green (98 suites) | DONE | `98 of 98 suites passed` (see Tests) |
| 15 | A no_saving card renders nothing live and a reason note in preview; a grid drops its no_saving cell live | DONE | Items 2 and 5 (the mixed grid holds a no_saving bundle: no cell live, note 4 in preview), plus item 4 |
| 16 | Unit: bundle sources read the declared arg name; source and sources together throw; source_unknown runs end to end to the preview note; bundle_list duplicate and over-max errors are class invalid | DONE | test-sections "the bundle sources read their declared argument…" (args with another key first: the card reads `bundle`, the grid `bundles`; the prefetch asks only for the declared names' ids; a binding of `bundle_by_id` to a setting `pick` is refused). M7 (back to the first argument) and M9 (no argument rule) fail it. test-sections "a binding that gives both source and sources is refused…": M8 fails it. test-sections-render "P5-BLOCKS: a source removed after publish fails its section end to end…": publishes a home holding a throwaway kind on a throwaway source through the real service, removes the source, then renders the real `app/(storefront)/page.js` in a real documents preview request. It shows "This echo block section is set up in a way the editor can't fix. Remove it and add it again." (not the reload words), logs `section_binding_failed` with cause `source_unknown`, and the live page has no trace. M16 (HomeSections spreads the data, losing the non-enumerable cause) fails it. test-registry-contract: `VAL.issueClass(...) === "invalid"` for both. M11 and M12 (class `structure` in `lib/registry/settings.js`) fail it; before, they survived (P5-SETTING review) |
| 17 | Fix round 1: a bundle that saves nothing is hidden even when it is also sold out or not ready, as a card and a grid cell, live and in preview, with the no-saving words | DONE | test-commerce-blocks "fix round 1 (OQ-B)…": on the tenant-fixture file DB, "Dear sold" ({v10, v11} saved at $2,000, then v10 sold out and v11 lowered to $100) reads as state `sold_out` with reasons `[sold_out, no_saving]`, and "Dear half" ({v12, v13} at $2,400, its offer row deleted and v13 lowered) reads as `not_ready` with `not_synced` and `no_saving`. Each as a card: live `""`; preview has "Bundle card: hidden from shoppers" and the exact no-saving sentence ($1,100 and $1,300), and no "Currently unavailable" card. As cells of a grid with an available bundle: the live grid has only the available cell and no trace of either; preview has notes at cells 0 and 2 with the no-saving sentence. A grid of only these two: live `""`, preview the grid-empty sentence plus both no-saving sentences. Failed before the fix ("Dear sold card live" rendered the card). M18 and M19 fail it |

### Mutation table

| # | Mutation (alone) | Result |
|---|---|---|
| M1 | no_saving counted as shown | test-commerce-blocks: 3 failed |
| M2 | the grid never renders a cell note | test-commerce-blocks: 2 failed |
| M3 | the grid asks for a note live too | passes: FounderNote's own preview check renders nothing live (the guard holds by itself) |
| M4 | DEFAULT_REPO without bundlesByIds | test-commerce-blocks: most block tests fail |
| M5 | the full components handed to BundleAddButton | test-commerce-blocks: 1 failed (props) |
| M6 | currency forced to INR | test-commerce-blocks: 2 failed |
| M7 | the bundle source reads the first non-limit argument again | test-sections: 1 failed |
| M8 | source plus sources accepted | test-sections: 1 failed |
| M9 | no "pass the source's arguments" rule | test-sections: 1 failed |
| M10 | checkSectionContract skips the source check | test-registry-contract: 1 failed |
| M11, M12 | duplicate / over-max class `structure` | test-registry-contract: 1 failed each |
| M13 | `entries` back in PLAIN_KINDS | test-registry-contract: 1 failed |
| M14 | the card has no hiddenReason | test-commerce-blocks: 2 failed |
| M15 | the old no_saving words | test-commerce-blocks: 2 failed |
| M16 | HomeSections spreads each section's data | test-sections-render: 1 failed (the end-to-end source_unknown test) |
| M17 | test-sections-render renders without CartProvider | test-sections-render: 3 failed (BundleAddButton's useCart throws) |
| M18 | (fix round 1) `isShown` looks at the state only again | test-commerce-blocks: 1 failed (the fix round 1 test) |
| M19 | (fix round 1) `bundleReason` gives the state's words, not the no-saving words, for a sold-out or not-ready bundle that saves nothing | test-commerce-blocks: 1 failed (the fix round 1 test) |

## Tests

- `scripts/test-commerce-blocks.js` (was a placeholder): 15 passed (14, plus 1 from fix round 1; the fixture gained two bundles on v10 to v13, which no other test uses). It uses the SWC + react-dom loader as test-sections-render does, and `prerenderToNodeStream`, because the live failed note is async. **CartProvider renders server-side**, so BundleAddButton was not stubbed: the loader wraps the real button only to record its props.
- `scripts/test-sections.js`: 32 passed (3 new: exact kind list and legacy absence, declared argument, source plus sources).
- `scripts/test-registry-contract.js`: 39 passed (1 new, 2 class checks, the exemption changes).
- `scripts/test-sections-render.js`: 45 passed (1 new end-to-end test). Renders now sit inside CartProvider, which adds no markup. Bundle data was added to the root test, the edge-scan list grew, and two BASE_LIVE digests were added.
- `scripts/test-editor-tree.js`: 26 passed (1 new).
- `scripts/test-surfaces.js`: 17 passed (1 new: the legacy home validator refuses both kinds as UNKNOWN_KIND).
- `scripts/test-media-refs.js`: 23 passed (1 new: the bundle worst cases reference no media, and their refs are the bundles by id, in order).
- `scripts/test-design-doc.js`: 23 passed (2 assertions added to the token-entry test).
- `scripts/test-commerce-exp.js`: 35 passed. **One expected string edited** (see Known limits).
- `scripts/test-editor-inspector.js`: 37 passed, **not edited** (P5-SETTING's derived waiting lines absorbed both kinds).
- `pnpm test`: after fix round 1, `98 of 98 suites passed in 181.0s`. First round: `98 of 98 suites passed in 194.2s` (baseline at `f80ba0f` before any change: 98 of 98 in 181.0 s). Sqld and web ports pinned to 7100 to 7109 and 6100 through the suites' port variables; nothing was left listening afterwards.
- `pnpm build`: passes. Its 2 Turbopack warnings are the existing `next.config.mjs` NFT-trace ones.

## Known limits

- **test-commerce-exp.js is P5-PANEL's this batch, and this item edited one line of it.** It pins the exact no_saving sentence. The owner's OQ-B answer changes that sentence in `bundle-words.js`, which this item owns for that change, so the old assertion could not stay green. Only the expected string changed (": shoppers can't add it." became ", so shoppers don't see it."). No assertion was weakened. If P5-PANEL changes the same line, the merge should keep the new words.
- **The shared bundle prefetch reads both names** (`bundle` and `bundles`) from every bundle instance's args. A kind that bound `bundle_by_id` with a second setting named `bundles` would also prefetch those ids (one larger read, nothing wrong shown). No kind does.
- **The new "pass the source's arguments" rule is stricter than the brief asked.** A binding must now pass each argument its source declares, other than `limit`. Every built-in kind and every throwaway kind in the suites already did. Legacy `componentFor` declarations are not checked by `defineSection`.
- **A hidden bundle that saves nothing and is also sold out or not ready gets only the no-saving sentence** in its preview note, not the sold-out or not-ready one too. Lowering the price is the step that makes it show again; once it saves, the sold-out or not-ready card (with "Currently unavailable") and its product marks take over. The bundle panel and editor wording for such a bundle are P5-PANEL's and P5-EDITOR's, which still read the state.
- **A sold-out or not-ready card still shows its price and "You save"**, next to "Currently unavailable" (as the bundle page shows its saving while out of stock).
- **The "Sold out" mark** is the text "Sold out" shown upper-case by CSS. The bundle page writes "SOLD OUT" as text. They look the same, but a screen reader reads them differently.
- **The preview in test-commerce-blocks is the request scope set directly** (`Symbol.for("storeasy.requestScope")`), not a real preview session. The real preview path is proved in test-sections-render (HIDDEN's tests and this item's end-to-end test).
- **Overlap is not a shopper state.** An overlapping bundle's card shows. The cart may give a different saving (OQ-D). The warning is P5-CHECKS and P5-EDITOR.
- The heading's limits (80, soft 50) match the other rails. The 120-character title of the worst case is the bundle's own title (data), not the heading.
- `lib/registry/fixtures.js` writes its fixture currency as a template string: test-registry-contract reads every double-quoted upper-case string in `lib/registry` as an issue code.
- Carried from the plan: home only (deviation 3.5); getBundle and the bundle page don't check the offer sync; stock depth (a component with quantity 2 and one unit left reads as available); bundles are not versioned (an edit in Catalog > Bundles changes live cards at once); the add button's add is non-atomic (OQ-G).

From review:

- The earlier blocker is fixed at 290d107. In BundleCardSection.js, isShown now also requires !savesNothing(b), and bundleReason gives the no_saving sentence to a hidden sold_out or not_ready bundle. Turned-off and deleted bundles keep their own words. The grid uses the same isShown and bundleReason, so a card and a grid cell can't disagree. The new test 'fix round 1 (OQ-B)' covers sold_out+no_saving ('Dear sold', reasons [sold_out, no_saving]) and not_ready+no_saving ('Dear half', not_synced plus no_saving). It runs each as a card and as a grid cell, live and in preview, on the tenant-fixture file DB. A grid made only of these two bundles is also checked. I mutated two lines and the test caught both, each turning test-commerce-blocks red (1 failed): isShown back to state-only, and bundleReason ignoring savesNothing. test-commerce-blocks: 15 passed. pnpm test: 98 of 98 suites passed in 185.2 s at 290d107.
- Wrong words for the founder and a side effect for shoppers, both from a bundle-compat quirk that this fix now reaches. When a component's variant is deleted, compatFrom (lib/commerce/bundle-compat.js) leaves it out of the sum but still checks price >= sum. A bundle A($100)+B($100) at $180 whose A was deleted gets reasons [missing, no_saving] with sum $100. Reproduced directly with compatFrom: state sold_out, reasons [{missing},{no_saving,sum:100,price:180}]. After this fix such a bundle is hidden from shoppers. Before, it was shown as 'Currently unavailable' with the product marked 'No longer available'; hiding it hurts nobody, since it can't be bought either way. But the founder's preview note says 'The price no longer saves anything (the products add up to $100) ... Lower the price in Catalog > Bundles.' The sum is false, and the advice is wrong: the real fix is to replace the deleted product. The packet's Known limits ('Lowering the price is the step that makes it show again') is untrue for this case. Suggested follow-up, owned by P5-BUNDLEREAD or a later item: don't add no_saving when any component is missing, or have bundleReason prefer the missing words when a missing reason is present. Also add a Known limits line now.
- Known limits line for the finding above: a bundle with a deleted product can also be marked as saving nothing, because the deleted product is left out of the sum. Its preview note then gives a false sum and tells the founder to lower the price, when the real fix is to replace the deleted product. The line above that says lowering the price makes it show again does not hold for this case.
- Founder surfaces can disagree. The preview note for a sold_out+no_saving bundle says only the no-saving sentence, while the inspector, publish check and bundle panel (P5-EDITOR, P5-CHECKS, P5-PANEL) still read the state and will say 'sold out'. The packet records this in Known limits. It should be carried to those items so they use the same reasons-aware rule (savesNothing) and the founder isn't told two different things.
- The deviation carried from round 1 still stands: one expected string in scripts/test-commerce-exp.js, which P5-PANEL owns, was changed for the owner's no_saving wording. No assertion was weakened, and it is recorded in the packet. The merge should keep the new words.

## From review

- **Fix round 1 (blocker): a bundle that saves nothing was still shown when it was also sold out, had a deleted product, or was not ready.** Hiding was decided by the state alone, and `stateOf` ranks `sold_out` and `not_ready` above `no_saving`. A shopper saw the card at a price above what the products add up to, with "Currently unavailable", and the preview gave the founder no note. Fixed in `BundleCardSection.js` (`isShown` checks the reasons for `no_saving`; `bundleReason` gives the no-saving sentence), which the grid shares. Acceptance item 17, mutations M18 and M19.

## Owner checks

- **Browser (P5-DRILLS):** in desktop Chrome on the design harness, a documents-mode home with a bundle card and a grid: the available card, a sold-out cell, and the preview notes for a turned-off, deleted and no-saving bundle. Live shows none of the notes. A click on a note selects the section in the editor.
- Phone widths (375 and 768) and Safari for the card, the grid of up to 12, and the per-cell notes (the 120-character title and 6 products of the worst case).
- Wording sign-off: the no_saving sentence (OQ-B), "You save <money>", "See the set →", and the cell note title "<bundle>: hidden from shoppers".
- Staging: one documents-mode tenant after phase 5 deploys, and one real test order through a bundle block to snehal@mediastic.in, cancelled afterwards, to check the bundle discount line on the order pushed to Shopify (plan section 4).
- Merge note: this branch edits one expected string in P5-PANEL's `scripts/test-commerce-exp.js` (Known limits).
- (Carried) The CI sqld download under `.github/` still needs the owner's approval of its source and checksum. This item added nothing under `.github/`.
