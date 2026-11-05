# P6 · OPEN · Before you open your store (PUB-12, US-41, PUB-06)

Branch `cms/p6-open`, cut from `7506c9e` (`cms/phase-1`, which holds both P5-FIX2, merge `441b44d`, and P5-DRILLS, merge `211c982`). Plan: `docs/cms-reviews/P6-PLAN.md` (revision 4), item P6-OPEN in `P6-BATCHES.json`. Companion note with the item table and the first-publish suite list: `P6-PUB-12.md`.

This is the author's own report. Reviewers should re-read the code.

## Fix round 1: test-provision now opens with the design

**First run (`7d58d54`): the gate was 101 of 102.** `test:provision` failed 4 tests. Its test "legacy brand and old-editor writes … saving doc_design through the documents API works" saves a founder doc_design draft (accent `#0f766e`) on the closed documents store. The next test, "the founder publishes a first home page", published `[doc_home]` alone. Rule b (always on) refused it: 409 OPENING_NEEDS_DESIGN, offering `[doc_home, doc_design]`. The store never opened, so three later tests failed too (the later design publish got FIRST_PUBLISH_NEEDS_HOME, the ED05 legal-pages test, and the `--force` re-provision live-release test). I stopped and did not edit the suite then. A reviewer confirmed that rule b alone causes it.

**The choice made (option 1 of the two the first run offered):** rule b stays exactly as the plan asks (a left-out design draft is always refused, plan mustFix 2). Narrowing it would need the owner's word and would let a store open without the founder's own colours, the bug this rule fixes. Instead test-provision was changed, by this fix round, outside this item's file list (P6-ONBOARD owns test-provision in batch 4, so there is no clash in batch 2):
- "the founder publishes a first home page": publishing `[doc_home]` alone now expects 409 OPENING_NEEDS_DESIGN, an offer of `[doc_home, doc_design]`, and a store that is still closed. Then it publishes the offer (with the theme_pin writer spy, so nothing writes to the control plane) and checks the store opens with one pin write. Its old last line "the design is not published yet" now reads "the design opened with the store" (brand step done).
- "a later doc_design publish writes theme_pin": the design is already live, so it first saves a new accent (`#1d4ed8`) on doc_design, then publishes that on the open store. Its checks are unchanged.

**Fails before, passes after:** `env -u CHECKOUT_MODE pnpm test:provision` on `7d58d54` (test-provision as it was): 29 passed, 4 failed. With the change: 33 passed, 0 failed. No library code changed in this round.

**P6-PUB-12.md corrected.** Its first-publish section said no suite left out a design draft and every suite passed unchanged, and listed test-provision as unchanged. That was false. It now names test-provision as the suite that hit rule b and says how it was changed.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test` with `CHECKOUT_MODE` unset: 102 of 102 suites passed in 200 s (fix round 1). `pnpm build` passed on the first run; no library code changed since |
| Browser verified | **NOT DONE, not needed for this item.** No screen changed: the panel is P6-OPEN-UI (batch 3). Every acceptance item is a unit test |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

PUB-12 asks for a "Before you open your store" step. Revision 4 of the plan (owner answers OQ-P6-1 and OQ-P6-2) makes payment problems, a left-out design and missing policies **block** opening, and keeps maintenance, test order, catalog and contact as warnings behind one confirm. This item builds the server side: the report, the publish rules, the API flags and read, and the contract. Carried from phase 5 (P5D-2): a deleted bundle's publish warning no longer shows the bundle's raw id.

## Design

### `lib/documents/opening.js` (new, Node, read only)

- `openingReport({ setIds })` → `{ opening, items, offer }`. `openingState()` returns the same plus the design and policy states that publish.js needs.
- On an open store: `{ opening: false, items: [], offer: null }`.
- Items, every one including ok ones, in fixed order: payment, maintenance (only while it is on), privacy, returns, test_order, catalog, contact, design. Each is `{ id, level, title, message, href, who, linkLabel?, actions? }`. The words are written per item. `checkoutCapability().reason` is never used.
- **payment** comes from `billingDegraded(tenantOwnCfg('billing'))` first, then `checkoutMode()`. adapter.js is only imported, not changed. Billing → block, `/admin/billing`. `disabled` → block, `/admin/settings#commerce`. `shopify` → block, `who: 'support'`, no link. Direct with both Razorpay keys → ok. Without them → info "Cash on delivery only", `/admin/settings#payments`. The two-key test is written out here (adapter.js keeps its own copy inside checkoutCapability).
- **maintenance**: warn, `who: 'support'`.
- **privacy / returns** from `policyStatus(await readPolicyRows(), setIds)` (lib/documents/policy-pages.js, imported, not copied). live or inSet → ok. saved → info "Your privacy page goes live too.", with a link to that draft that names it ("Open “Privacy”"), and the offer adds it. starter → block, `href /admin/editor?doc=<id>`, linkLabel "Read it", action `markPolicyRead { id, revision }`; never in an offer. missing → block, action `startPolicy { kind }`. The returns words say "(your terms, returns and refunds)" once.
- **test_order**: ok when an order (any status, cancelled included) was made before the store's first release (any order, when there is none), or `config.onboarding.manual.test_order` is set. Else warn, `/admin/editor`, `TEST_ORDER_CLOSED_HINT` from onboarding.js (not edited).
- **catalog**: warn at 0 products, `/admin/settings#catalog-sync`. **contact**: warn with no support email or phone, `/admin/settings#store-profile`. Both are additions beyond the spec's three items.
- **design**: ok when live or in the set; info "Your colours and logo go live too." for an unpublished draft left out; info "Your store opens with the starting colours (Slate)." with no row. Both info items link to the editor at doc_design (every non-ok item needs a fix).
- **offer**: the set's items, plus the left-out design draft, plus each founder-saved policy draft of a kind that is neither live nor in the set; null when it adds nothing. Items are `{ id, revision, draftHash, label }`, the FIRST_PUBLISH_NEEDS_HOME offer's shape.

### `lib/documents/publish.js`

`publish({ ids, actor, checkOpening, confirmOpen })`. After the kept FIRST_PUBLISH_NEEDS_HOME rule, when the set opens the store (`live.pointer == null && !rowsOnly`), `openingGate` runs, before the build and again in the rebuild loop (attempt 2 and later, while that attempt's `from.pointer` is still null):
- a. payment block, always → 409 STORE_CANNOT_TAKE_PAYMENT `{ report }`; the words are `PAYMENT_LEAD` plus the item's words.
- b. unpublished doc_design draft left out, always → 409 OPENING_NEEDS_DESIGN `{ offer, report }` (the report's combined offer).
- c. `checkOpening` and no doc_design row → `createFirstRunDocuments` writes the slate draft as `system:first-run`, the state is read again, and the answer is 409 OPENING_NEEDS_DESIGN with the offer. FIRST_RUN_STORE_LIVE and FIRST_RUN_RACE are caught and the state is read again, so a race never leaves the founder stuck.
- d. `checkOpening` and privacy or returns not live and not in the set → 409 OPENING_NEEDS_POLICIES `{ report, offer }`, whatever confirmOpen says. offer only when every such kind is 'saved'.
- e. `checkOpening`, a warn item and no `confirmOpen` → 409 OPENING_CONFIRM_NEEDED `{ report }`.

The FIRST_PUBLISH_NEEDS_HOME offer also adds an unpublished doc_design draft (its body keys, words and the test-api-shapes source pins are unchanged).

**POLICY_PAGE_MISSING** (live store only): after a build goes live, for each policy kind the set touches (a page of the set whose new address, or its address in the list the build started from, is of that kind), when the new list has no enabled page of that kind, a decorated warning issue `{ code: 'POLICY_PAGE_MISSING', severity: 'warning', documentId: <that page> }` is added to the 200's issues. **Narrowed from the brief's wording:** the brief says "leaves no live privacy page or no live returns page"; I warn only for the kinds the set touched, because test-publish-checks pins that publishing a refunds page on a store with no privacy page carries no issue ("negative: a broken link in the dirty home draft does not stop publishing a policy page…"), and that suite must pass unchanged. Unpublish and undo are not changed.

### `lib/admin/documents-api.js`

`checkOpening` and `confirmOpen` are top-level modifiers (MODIFIERS). They are accepted only on publish and publishSet, and only as booleans (null counts as absent); anything else is 400 MALFORMED. They reach `Publish.publish`. New read `openingChecks { ids }` (or `true`): storefront.read, a mode read (409 STORE_USES_LEGACY on legacy), 0 to 200 ids, answering `{ ok, opening, items, offer }`.

### `lib/admin/documents-api-shapes.js`

`OPENING_REPORT` (plus `OPENING_LEVELS`, `OPENING_ITEM_IDS`, `OPENING_ACTION_TYPES`, `OPENING_REPORT_OPTIONAL`); publish outcomes `storeCannotTakePayment`, `openingNeedsDesign`, `openingNeedsPolicies`, `openingConfirmNeeded` and `okPolicyPageMissing` (a 200 carrying the warning), all `since: 'p6'`; the `openingChecks` operation; `checkOpening`/`confirmOpen` in the publish and publishSet request examples (optional); and the pinned contract: "a client that opens a store must send checkOpening: true; without it neither the slate design nor the policy pages are checked".

### `lib/documents/checks.js` (P5D-2)

A deleted bundle is named "A deleted bundle" (`DELETED_BUNDLE_NAME`). The section only holds `{ id }`, so there is no last known title in the document; a title, if a read ever carries one, wins. Other bundles keep their names.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| disabled, shopify, billing degraded refuse `[home]` with 409 STORE_CANNOT_TAKE_PAYMENT with and without checkOpening and with confirmOpen; nothing live; hrefs `#commerce`, none + who support, `/admin/billing` | DONE | test-open-checks "a. checkout_mode 'disabled' / 'shopify' / billing degraded …" (storage dump unchanged, live pointer null), and "the payment item never echoes checkoutCapability's reason". Fails without the change: no such code (publish opens the store) |
| maintenance + disabled still 409 STORE_CANNOT_TAKE_PAYMENT; maintenance + direct is a warn | DONE | test-open-checks "a. maintenance on PLUS …", "a. maintenance on with direct checkout …" |
| checkOpening, saved privacy and terms in the set, no test order or contact → 409 OPENING_CONFIRM_NEEDED, test_order and contact warn, privacy and returns ok; every non-ok item has a fix; scanText finds nothing; no 'not implemented' or 'mode reserved'; confirmOpen opens | DONE | test-open-checks "e. with checkOpening …" and "words: …" (every report state, `checkWords`). The set also holds the design, because without it rule c answers first (by design) |
| OQ-P6-1: no policy pages → 409 OPENING_NEEDS_POLICIES with and without confirmOpen, startPolicy blocks, no page offered, nothing live; privacy alone still 409; both opens | DONE | test-open-checks "d. with checkOpening and NO policy pages …" |
| review rule: starter → block, `/admin/editor?doc=<id>`, Read it, markPolicyRead {id, revision}, never offered; starter in the set opens; saved drafts → info, offered, offer opens with both live; no flag + no pages opens | DONE | test-open-checks "d. a starter draft …", "d. founder-saved privacy and returns drafts …", "d (pinned contract, known limit) …" |
| `[home]` without checkOpening with a generated design draft → 409 OPENING_NEEDS_DESIGN offering doc_design; the offer opens non-lime | DONE | test-open-checks "b. publishing [home] WITHOUT checkOpening …" (forest accent live, `isLimeAccent` false) |
| checkOpening, pages in the set, no doc_design row → 409 OPENING_NEEDS_DESIGN, slate draft by system:first-run exists; offer opens non-lime; no flag + no design opens | DONE | test-open-checks "c. …" and "d (pinned contract …)" (no design row made, nothing design live) |
| a cancelled preview COD order turns test_order ok; so does the manual check-off; pages in the set turn privacy and returns ok via policyStatus | DONE | test-open-checks "test_order: a preview COD order …" (the real `/api/checkout` route with a preview session, email snehal@mediastic.in, then `cancelOrder`; the Shopify push is collected and never run), "…manual check-off…", "privacy and 'terms' pages in the set …" |
| live store: moving the last returns page warns POLICY_PAGE_MISSING and succeeds; a set touching no policy page has none; rowsOnly on a closed store runs no checks | DONE | test-open-checks "live: …" and "rowsOnly: …" (checkout off, product content still publishes, store stays closed); test-failure-matrix row "moving the last returns page off its address on a live store" |
| openingChecks: design info, privacy info, offer with revisions and draftHashes; no design row writes nothing; live store opening false | DONE | test-open-checks "openingChecks: …" (three tests) and the "live" test |
| parser: flags are top-level booleans on publish and publishSet only; refused elsewhere and as non-booleans; test-documents' parser table passes | DONE | test-open-checks "API: …" (real handler, nothing written) and "the editor's flags travel"; test-api-shapes "P6-OPEN: checkOpening and confirmOpen …"; test-documents 58 of 58 |
| test-publish-checks, -service, -undo, -ui, test-design-doc pass unchanged; test-api-shapes and test-failure-matrix cover every new code; pnpm test passes with CHECKOUT_MODE unset | DONE (fix round 1) | Those five suites pass. test-publish-checks is changed only for P5D-2 (two assertions that pinned the raw id, and one new test), as the brief allows. api-shapes and failure-matrix cover every new code (their new checks). pnpm test with CHECKOUT_MODE unset: 102 of 102 suites passed in 200 s. test-provision was changed to open with the design (see the top), so it is not one of the unchanged suites |
| BUNDLE_MISSING never shows a raw bundle id | DONE | test-publish-checks "P6-OPEN (P5D-2): BUNDLE_MISSING never shows a raw bundle id …" (no part of either issue holds the id). Fails on the old checks.js |

## Tests

- **`pnpm test`** (CHECKOUT_MODE unset; ports 6140 and 7140 to 7149), fix round 1: 102 of 102 suites passed in 200 s. First run: 101 of 102 (test:provision, fixed above).
- **test-provision** (fix round 1): 33 passed (29 passed, 4 failed before the change).
- **`pnpm build`**: passes.
- **test-open-checks** (new, replaces the placeholder): 26 passed. Without this branch's lib changes it cannot run (opening.js is missing); every test also checks a code or behaviour that only exists with them.
- **test-api-shapes**: 37 passed (three new P6-OPEN checks; `openingChecks` in the operations list; the four refusal codes in BUILT_CODES and POLICY_PAGE_MISSING in NEW_CODES; "used by an outcome" now also reads `issues[].code`, because a 200 cannot carry a top-level code).
- **test-failure-matrix**: 134 passed (eight new rows on a new closed store and the live `docs` store, plus a coverage test).
- **test-publish-checks**: 41 passed; **test-logout-preview** 37 passed (it walks every new shape through the client); **test-documents** 58 passed.

## Known limits

- **Today's editor has no button for OPENING_NEEDS_DESIGN until P6-OPEN-UI (batch 3) ships.** A founder who has saved a design draft and presses Publish on the home page of a closed store is refused (nothing is published or lost). `publishModel.outcomeOf` has no branch for this code, so the editor shows its generic refused panel with the server's words ("Publish your colours and logo with this, so your store opens with them. Nothing was published.") and no button. The founder can open the store by publishing the design document instead, which gets the FIRST_PUBLISH_NEEDS_HOME offer to publish both. publishModel.js is not this item's file; P6-OPEN-UI adds the 'needsDesign' fold. If batch 2 merges well before batch 3, this is what a founder sees in between.
- **test-provision was edited outside this item's file list** (fix round 1, top of this note). P6-ONBOARD, which owns it in batch 4, must keep the first publish carrying the design.
- **The checkOpening contract.** A client that opens a store without `checkOpening` opens on the platform's default (lime) brand when there is no design row, and with no policy pages. Pinned in the shapes and in test-open-checks. The editor (P6-OPEN-UI) must always send it.
- **POLICY_PAGE_MISSING is scoped to the kinds the set touches** (see Design), so a refunds page published on a store with no privacy page stays quiet.
- **Unpublish and Undo give no POLICY_PAGE_MISSING.** Taking a policy page offline gives no warning.
- **Rules run before validation.** With checkOpening and no design row, a set that also has a validation error still gets the slate draft made (a harmless, generator-owned draft), then the design 409, then the 422 on the next try.
- **The rebuild re-check** runs only while the rebuilt attempt still sees a closed store. If someone else opened the store in between, the set publishes as a later publish.
- **test_order uses the first release's time.** On a closed store that is any order at all. Orders imported before a store was ever open count.
- **The Razorpay two-key test is written out in opening.js** (adapter.js could not be changed). If adapter.js changes its key names, opening.js must follow.
- **openingChecks on an open store returns no items** (`items: []`), not a full report.

From review:

- Both earlier blockers are fixed. (1) The gate is green: `env -u CHECKOUT_MODE pnpm test` on 8b6db5b passed 102 of 102 suites in 197 s, run on my own ports (6340, 7340-7349). Fix round 1 changed no library code. Only scripts/test-provision.js and the two notes changed (diff 7d58d54..8b6db5b). (2) P6-PUB-12.md now names test-provision as the one suite that hit rule b and says how it was changed. It no longer claims that every suite passed unchanged. I compared its suite table with every script that calls publish or publishSet. The only scripts not in the table (test-api-shapes, test-logout-preview, test-publish-ui) use client stubs or parser fixtures and never publish a store.
- The test-provision change is honest. 'The founder publishes a first home page' now expects 409 OPENING_NEEDS_DESIGN for [doc_home] alone, an offer of [doc_home, doc_design] and a store that stays closed. It then publishes that offer behind the theme_pin spy and checks one pin write. The later theme_pin test now saves a new accent first, and it still checks the kit, the tenant and the release in the pin. Its brand-step line changed from false to true, which is right because the design now goes live with the first publish. But test-provision.js is outside P6-OPEN's file list: P6-OPEN-UI does not own it, and P6-ONBOARD owns it in batch 4. No other batch-2 item touches it, so there is no merge clash. Owner check: accept option 1 (rule b kept as it is). P6-ONBOARD must keep the first publish carrying the design.
- The previous review raised a gap that is still there, now written up as a known limit and an owner check. Until P6-OPEN-UI (batch 3) ships, a founder who has a design draft and publishes only the home page of a closed store gets the editor's generic refused panel. It shows the server's words ('Publish your colours and logo with this…') and has no button. Nothing is lost. The founder can still open the store by publishing the design document, which gets the FIRST_PUBLISH_NEEDS_HOME offer to publish both. Owner check: either merge P6-OPEN together with P6-OPEN-UI, or accept the gap between batches.
- Test gap (a mutation the tests did not catch): rule d says 'offer is non-null only when every such kind has a saved draft'. I changed that line in publish.js to always return the report's offer, and test-open-checks still passed 26 of 26. No test covers the mixed case (a saved privacy draft not in the set, plus a missing returns page), where the report's offer is non-null but rule d must answer offer: null. The code is correct today; only the test is missing.
- Test gap (a mutation the tests did not catch): in opening.js, the closedStoreOrder clause `created_at < (SELECT MIN(created_at) FROM releases)` can be flipped to `>` and test-open-checks still passes. Every test store has no releases, so only the 'no releases at all' branch ever runs. The time comparison only matters for a store that has releases but no live pointer, which is a rare state.
- These mutations were each caught: removing the gate re-check in the rebuild loop; skipping the confirmOpen check (rule e); enforcing rule b only with checkOpening; dropping the design from the FIRST_PUBLISH_NEEDS_HOME offer; turning off POLICY_PAGE_MISSING; offering a starter draft; emptying rule d's list of missing kinds; and putting back the raw bundle id for P5D-2 (3 tests in test-publish-checks fail).
- Edge-runtime check: opening.js, policy-pages.js and the publish gate are reached only through app/api/admin/documents/route.js, which runs as runtime 'nodejs'. No edge route imports them. Legacy tenants are untouched, because the gate runs only in the documents-mode publish path (releases.js is unchanged), and the legacy suites in the gate pass.
- Owner checks the builder already listed still stand: the checkOpening contract (without the flag, a first publish opens on lime with no policy pages); POLICY_PAGE_MISSING warns only for the policy kinds a set touches; reading every opening item's words as a founder on a phone; the 'A deleted bundle' words; a staging tenant with real Razorpay keys showing payment ok; re-running drills p2, p3 and p4 on this branch; and approving the source and checksum of the CI sqld download.
- Cleanup: every file I mutated was restored and the worktree was clean. Nothing was listening on my ports at the end. I removed the worktree /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p6-b1/P6-OPEN/rv1 and pruned it. The gate log is at /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p6-b1/P6-OPEN/rv1-gate.log.

## Owner checks

- **Accept the test-provision choice** (option 1: rule b kept, the suite opens with `[doc_home, doc_design]`), or ask for rule b to be narrowed.
- **Between batch 2 and batch 3:** a founder with a saved design draft who publishes only the home page of a closed store sees a refusal with no button (Known limits). Accept it, or merge P6-OPEN together with P6-OPEN-UI.
- **The checkOpening contract** (plan owner check): accept that a non-editor first publish without the flag opens on lime and with no policy pages, or ask for full enforcement.
- **POLICY_PAGE_MISSING scope:** accept warning only for the kinds a set touches.
- **The words** of every item and refusal (`WORDS` and `policyWords` in opening.js, the four messages in publish.js), read as a founder on a phone once P6-OPEN-UI shows them.
- **The deleted bundle's words**: "A deleted bundle: This bundle was deleted, so shoppers don't see it. …" (P5D-2).
- **A real Razorpay-key tenant** on staging shows payment ok (never enter card details).
- **Drills p2, p3 and p4** first-publish and were not re-run; run them once on this branch.
- **CI sqld download:** unchanged; nothing under `.github/` was touched. Its source and checksum still need your approval.

## Commands

```
TEST_PUBLISH_PORTS=7140,7141 TEST_PUBLISH_SERVICE_PORTS=7142,7143 TEST_PUBLISH_UNDO_PORTS=7144 \
  TEST_PRODUCT_CONTENT_PORTS=7145,7146 TEST_MIGRATE_MAP_SQLD_PORT=7147 MIGRATE_DOCUMENTS_TEST_PORTS=7148,7149 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6140 DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 env -u CHECKOUT_MODE pnpm test
node scripts/test-open-checks.js
env -u CHECKOUT_MODE pnpm build
```
