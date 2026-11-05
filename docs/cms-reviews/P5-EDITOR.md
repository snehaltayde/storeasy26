# P5-EDITOR: the inspector's bundle picker, inline create, and the bundle form fixes (COM-02, COM-01)

Branch `cms/p5-editor`, cut from `425b844` (`cms/phase-1` after batch 2 and its review notes). Batch 3. Plan: `docs/cms-reviews/P5-PLAN.md` (decisions 9, 12; OQ-A, OQ-B as the owner answered it, OQ-C) and `P5-BATCHES.json` (item P5-EDITOR). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the item's list):
- Code: `components/admin/editor/fields/BundleControl.js` (new), `components/admin/editor/fields/controls.js`, `components/admin/editor/fields/inspectorModel.js`, `components/admin/editor/DocumentEditor.js`, `app/(console)/admin/(authed)/editor/page.js`, `components/admin/bundles/BundleForm.js`.
- Tests: `scripts/test-editor-inspector.js`, `scripts/test-bundle-form.js`.
- Docs: this packet.

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/commerce/bundle-words.js`, `components/sections/*`, `components/admin/CommercePanels.js`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration, no new dependency.

Safety: tests ran on file databases only (`scripts/support/tenant-fixture.js` and the suites' own). `pnpm test` pinned every port-taking suite to 6100 and 7100 to 7109. The drill ran on this worktree's own design harness (`DESIGN_PORT=6100`, `DESIGN_SQLD_PORT=7100`) on the phase 3 documents-mode seed (`node scripts/seed-design-documents.js --p3`, local sqld only); the drill started and stopped the harness, and nothing listened on 6100 or 7100 to 7109 afterwards. No real or hosted store changed mode, `--hosted` was never passed, Typesense was not used, nothing was written to Shopify, and no order was placed.

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` 98 of 98 suites in 185.1 s; `test:editor-inspector` 46 passed (9 new, 1 rewritten), `test:bundle-form` 16 passed (7 new); `pnpm build` passes (its 2 Turbopack warnings are the existing `next.config.mjs` NFT-trace ones) |
| Browser verified | Done: desktop Chrome on the design harness, 26 of 26 checks (see Drill) |
| Staging | **NOT DONE** |

## What and why

COM-02 asks for a bundle picker in the editor and a way to make a bundle without leaving it; COM-01 asks that the founder is told each bundle's state in plain words. Batch 1 and 2 registered the `bundle` and `bundle_list` setting kinds, the bundle card and grid, the bounded read (`/api/admin/refs?type=bundle`) and the console form; the inspector still had no control for the two kinds (they were "waiting" in the inspector suite). This item adds the controls, loads the bundles in the editor, adds the inline create, and fixes the console form points the P5-PANEL review raised.

## Design

### (1) `inspectorModel.js`: the picker's logic (pure)

- `CONTROL_OF_KIND`: `bundle -> "bundle"`, `bundle_list -> "bundle_list"`. `pathsOf` gives a grid its rows (`<path>.<j>`), so `anchorsOf` lists the control and each row.
- `bundleView(id, entry, { status })` -> `{ id, title, price, chip, line, overlap, canReplace }` for one picked bundle, from its refs row:
  - The words are `lib/commerce/bundle-words.js stateLine`, by the **blocks' own rule** (`components/sections/BundleCardSection.js isShown / bundleReason`, which a client module can't import): a bundle that saves nothing is hidden whatever its state says, so a `sold_out` or `not_ready` bundle whose reasons hold `no_saving` gets the no-saving words and the chip "Hidden: no saving" (the P5-BLOCKS review). Turned off and deleted keep their own words.
  - A turned-off draft whose check fails is never offered as ready to turn on (the P5-BUNDLEREAD review): its line is "This bundle is turned off, so shoppers don't see it. It can't be turned on yet: <reasons>. Fix it in Catalog > Bundles, or remove it." and its chip "Turned off, not ready". The reasons are `reasonSentence`, or the reason's own `words` (bad_quantity).
  - The overlap line (`overlapLine()`) only for a bundle shoppers see.
  - Not read yet: "Checking this bundle…". Absent from a ready list: the deleted words. A failed or 403 read: "You can't see bundles here." and `canReplace: false`.
- `linkParts(line)` splits a line around "Catalog > Bundles" so the control makes it a link.
- `bundleOptions(items, q, picked)`: title, price (`formatMoney(bundle_price, currency ?? undefined)`) and chip per option; a deleted bundle is not offered; a picked one is marked.
- `pickBundle(id)` -> `{ id }` only. `bundleList.add / replace / move / remove` return `{ list, error }`; a duplicate is refused with "This bundle is already in the grid." and a full grid with "A grid shows at most 12 bundles." (the registry's own sentence).
- `pickedBundleIds(body)`: every bundle id the sections pick, for the editor's `ids=` read. `bundleSlugGuess(title)`: the page a new bundle will get (the same as `lib/bundles.js slugWithSuffix(slugBase(title), 1)`; a test pins that).

### (2) `BundleControl.js` (new, client)

- `BundleControl` (one bundle) and `BundleListControl` (a grid: add, move up and down, remove), registered in `controls.js CONTROLS`. Each picked bundle (the one, and every row) shows its title, price, chip and status line; "Catalog > Bundles" is `<a href="/admin/catalog#bundles" target="_blank" rel="noopener noreferrer">`.
- A search field: without words it lists what the editor read; with words it asks `context.searchBundles(q)` (refs `q=`), 250 ms after typing stops. Picking writes `{ id }`, so picking again over an old `{ id, title }` rewrites it.
- When the read failed: the picked id with "You can't see bundles here.", Remove stays, no search and no create.
- "Create a bundle" opens `CreateBundleDialog`: the Dialog says "The bundle is saved and turned on now: its discount works in the cart and its page /bundles/<slug> opens right away, even if you don't publish. It shows on your home page after you publish." (the slug follows the typed name) and holds `BundleForm compact`. On save the control picks the new id (a grid adds it at the end) and calls `context.refreshBundles()`. Without `offers.write` the button is not there and the control says "Ask an owner to create bundles."
- Element ids: the setting's anchor on the group, `<path>.<j>` on each row, each with its notes element and `aria-describedby`, as the other controls. The file has its own small `Notes` (controls.js imports this file, so it can't import controls.js back).

### (3) `DocumentEditor.js`

- At mount, beside products and collections: `fetchRefs({ type: "bundle", limit: 50 })`, then `ids=` for picked bundles not in that page. When the open document picks an id the list doesn't hold (a document opened later, a bundle past the first 50), that id is read by `ids=` once.
- Read again on window `focus` and after an inline create, so the chips match the preview. A search's rows join the list. Only the latest read sets the list.
- A failed or 403 read sets `{ status: "failed" }`.
- The inspector context gets `bundles`, `searchBundles`, `refreshBundles`, `canCreateBundles` (`can.offersWrite === true`) and `currency`.

### (4) `app/(console)/admin/(authed)/editor/page.js` (OQ-A)

Passes `can={{ offersWrite: roleAllows(actor.role, "offers.write") }}` and, for a session that may create, the store's currency (`lib/bundles.js bundleCurrency()`, guarded: `undefined` when it can't be read, as Catalog > Bundles does).

### (5) `BundleForm.js` (the P5-PANEL review)

- `onTitleChange` prop for the Dialog's page name.
- The saving keeps the cents: "Shoppers save $49.48." When the cart takes off a different amount (the offer engine rounds the BUNDLE discount to a whole amount, `lib/offers/engine.js`), the line adds "The cart takes off $49, as it rounds to a whole amount."
- The quantity box keeps what is typed: `''` stays `''` (so "delete then 3" is 3, not 13); nothing is checked or saved while a quantity is empty ("Enter how many of this product, 1 or more." on that row); a typed 1.5 is sent as 1.5 and the check's bad_quantity reason shows on its row.
- A stored row holding a web name instead of a picked product shows that name, "Pick this product again with Change: it was saved by its web name.", and a banner "Pick product 1 again: …" naming the row. Nothing is checked or saved until it is picked again (the route would refuse the whole check with one banner and leave every row at "Checking…").
- "Save and show to shoppers" and "Create bundle" also wait while a quantity is empty.

## Acceptance, with evidence

"Fails without the change": each mutation below was applied alone and the named suite run (helper `helpers/mut.py` in the scratch folder, restoring each file afterwards).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | test-editor-inspector: WAITING_KINDS has no bundle or bundle_list, and inspectorCoverage() reports no problem for them | DONE | "P5-EDITOR unit: bundle and bundle_list have controls, are not waiting…" (also: the other four waiting kinds still reported, controls.js maps both to BundleControl.js) and the rewritten "P5-EDITOR rendered: a throwaway home kind with bundle and bundle-list settings…". M1 (no `bundle` in CONTROL_OF_KIND) fails 6 tests |
| 2 | test-editor-inspector: the status line is the bundle-words sentence for each state, the overlap line, and 'You can't see bundles here.' when the read failed | DONE | "every picked bundle shows the bundle-words sentence for its state…": available, sold_out, no_saving (with "$300"), not_ready, disabled, missing, each pinned to the exact sentence AND to `stateLine`, rendered on the card and on each grid row in order, with the link markup. "the overlap line, and 'You can't see bundles here.'…": the overlap sentence; failed read on the card (id shown, Remove there, no search or create) and on each grid row. M12 (failed read ignored), M15 (overlap on a hidden bundle), M16 (no link) each fail it |
| 3 | test-editor-inspector: a pick writes exactly { id }; re-picking over { id, title } clears the UNKNOWN_FIELD issue; BundleListControl keeps order and refuses a duplicate | DONE | "a pick writes exactly { id }…" drives the real control (a small hook driver) on a real `bundle_card`: UNKNOWN_FIELD at `bundle.title` before, `{ id }` written, no UNKNOWN_FIELD after. "BundleListControl keeps the order, refuses a duplicate…": add at the end twice, a duplicate not written and "This bundle is already in the grid." on screen, move up, remove. M3 (pick keeps old keys) and M4 (no duplicate check) fail them |
| 4 | test-editor-inspector: anchorsOf maps a bundle incomplete, UNKNOWN_FIELD and an indexed bundle_list INVALID_VALUE to the control or row anchor | DONE | "anchorsOf maps a bundle's incomplete and UNKNOWN_FIELD notes to the control, and a grid's indexed INVALID_VALUE to its row" (plus a row's unknown key to that row), and the rendered SettingsForm places each message there. The brokenBody of every type now holds an old `{ id, title }` bundle and a grid with a duplicate, an unreadable entry and a bad id, all placed by the whole-registry render. M5 (no bundle_list rows in pathsOf) fails 3 tests |
| 5 | test-bundle-form: the inline-create Dialog shows only Name, Products and Price plus the live-now sentence, and Save is disabled while the check fails | DONE | "the inline-create Dialog shows only Name, Products and Price…": mounts the real BundleControl against the real bundle route on a USD file database; the Dialog adds exactly the Name and Price labels and inputs, the Products list, no description, the exact sentence (its page follows the name), "Create bundle" off while "Price must be lower than $300", one create with `enable: true, mustPass: true`, saved on at `gym-kit`, picked as `{ id }`, the bundles read again, the Dialog closed. M8 (Create ignores the check) fails it |
| 6 | test-bundle-form: without offers.write the 'Create a bundle' button is absent and the sentence is shown | DONE | "a grid's inline create adds the new bundle at the end; without offers.write…": both controls. M9 fails it |
| 7 | pnpm test is green | DONE | 98 of 98 suites passed in 185.1 s |
| 8 | unit: inspector words match the block's reasons-aware rule; the form keeps cents in the saving, lets quantity be cleared, shows 1.5 as a reason, confirms Disable when the home lookup fails, and names the row to pick again | **PARTLY DONE** | Done: "the inspector's words follow the blocks' reasons-aware rule…" compares `bundleShows` with `BundleCardSection.isShown` and the line with `bundleReason` for 30 state and reason pairs (M2 fails it); "the saving keeps its cents" (M6); "a quantity can be cleared … 1.5 shows the bad_quantity reason" (M7); "a stored row that holds a web name … is named" (M13); "'Save and show to shoppers' stays off while the check fails, with a name typed" (M14, the mutation the P5-PANEL review found surviving). **NOT DONE: "confirms Disable (and Delete) when the home lookup fails".** That confirm lives in `components/admin/CommercePanels.js` BundlesPanel, which is not in this item's files (plan 0.2: P5-PANEL owned it in batch 2; no batch 3 item owns it). Owner check below |

Also from the reviews:
- (P5-BUNDLEREAD) "a turned-off draft whose check fails is never offered as ready to turn on": M10 fails it.
- (P5-SETTING) "placeableIssues leaves out only the waiting setting of THAT section": two throwaway kinds share the key `pick` (one waiting, one text). M11 (the review's M12: no sectionId guard) fails it.

### Mutation table

| # | Mutation (alone) | Result |
|---|---|---|
| M1 | no `bundle` in CONTROL_OF_KIND | test-editor-inspector: 6 failed |
| M2 | the words ignore `no_saving` in the reasons | 1 failed (the blocks' rule) |
| M3 | a pick keeps the old keys (`{ ...value, id }`) | 1 failed |
| M4 | the grid's add has no duplicate check | 1 failed |
| M5 | pathsOf has no rows for bundle_list | 3 failed |
| M6 | the saving rounded to a whole amount | test-bundle-form: 1 failed |
| M7 | a keystroke turns the quantity into a whole number again | 1 failed |
| M8 | compact "Create bundle" ignores the check | 3 failed |
| M9 | "Create a bundle" ignores offers.write | 1 failed |
| M10 | a turned-off draft's reasons ignored | test-editor-inspector: 1 failed |
| M11 | placeableIssues without the sectionId guard | 1 failed |
| M12 | a failed read shown as "deleted" | 1 failed |
| M13 | no web-name row detection | test-bundle-form: 1 failed |
| M14 | "Save and show to shoppers" ignores the check | 1 failed |
| M15 | the overlap line for a hidden bundle too | test-editor-inspector: 1 failed |
| M16 | "Catalog > Bundles" not a link | 1 failed |

## Drill (desktop Chrome, design harness)

`DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/seed-design-documents.js --p3` (fresh perf seed, documents mode, owner login), then a scratch journey (not a repo file) using `scripts/drill.js` (`connectHarness({ start: true })`, Chrome 1440 wide), signed in as the seed's owner through the real form. 26 of 26 checks passed:

- Seeded through the console API as the owner: "Drill duo" turned on; "Drill dear", a draft whose price saves nothing. The home draft gets a bundle card on Drill duo and a grid of Drill duo, Drill dear and a deleted id (after the hero), saved through the documents API.
- `/admin/editor`: the editor read `type=bundle&limit=50` at mount; the card's inspector reads "Showing to shoppers." with the chip "Showing", and the preview shows "Drill duo".
- The grid's rows: "Showing to shoppers."; "This bundle is turned off, so shoppers don't see it. It can't be turned on yet: Price must be lower than ₹…. Fix it in Catalog > Bundles, or remove it."; "This bundle was deleted, …". The deleted id was read by `ids=`. "Catalog > Bundles" is a new-tab link to `/admin/catalog#bundles`. The preview shows the founder notes for the dropped cells. Picking Drill duo again is refused with "This bundle is already in the grid.".
- "Create a bundle" on the card: the Dialog has only the Name and Price inputs, no description, and the exact live-now sentence with `/bundles/drill-trio`. Two products picked through the real VariantPicker; a price that saves nothing keeps "Create bundle" off with "Price must be lower than …"; a passing price creates exactly one bundle, turned on, at `/bundles/drill-trio`; the card's saved draft now holds `{ id }` of it only; its chip and line came from a fresh read; `/bundles/drill-trio` answers 200 before any publish.
- A window `focus` reads the bundles again. No page errors. The drill's bundles were removed again afterwards.

Screenshots and `results.json` are in the scratch folder, not committed (the drills folder is P5-DRILLS'): `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p5-b2/P5-EDITOR/drill-out/docs/cms-reviews/drills/P5-EDITOR/`. The drill script is `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p5-b2/P5-EDITOR/helpers/drill-editor.mjs`.

Not drilled: a 403 read (the seed has no support login; unit-tested), "Ask an owner to create bundles." (staff and admin hold offers.write; only support lacks it; unit-tested), phone widths and Safari.

## Tests

- `scripts/test-editor-inspector.js`: section 6 (9 tests) and the rewritten bundle probe. It loads `components/sections/BundleCardSection.js` with the suite's SWC loader to compare the rule, and has a small hook driver (as test-bundle-form's) for the controls that keep state. `CATALOG` gained two bundle rows; `brokenValue` gained bundle values.
- `scripts/test-bundle-form.js`: section 6 (7 tests), through the real bundle route on the USD file database.
- Unchanged and green: test-editor-shell, test-editor-routes (the editor page renders with its stubs; `bundleCurrency` fails there without a tenant and the guard gives `undefined`), test-media-picker, test-product-editor, test-legacy-routes, test-commerce-blocks.

## Known limits

- **Disable and Delete with an unread home lookup (usedOnHome null) still go ahead without a confirm in Catalog > Bundles.** The fix belongs in `components/admin/CommercePanels.js`, outside this item's files. Recorded as NOT DONE (acceptance 8) for the orchestrator to place.
- **New words outside bundle-words.js.** The turned-off-but-not-ready line ("It can't be turned on yet: … Fix it in Catalog > Bundles, or remove it."), the chips ("Showing", "Sold out", "Not ready", "Hidden: no saving", "Turned off", "Turned off, not ready", "Deleted"), "You can't see bundles here.", "Checking this bundle…", "Ask an owner to create bundles.", the Dialog sentence, and the form's "Enter how many…", "Pick this product again…", "The cart takes off …" live in `inspectorModel.js` and `BundleForm.js`, because `bundle-words.js` is not this item's file. The state sentences themselves are all `stateLine`. Wording sign-off is an owner check.
- **The cents and the cart can differ.** The form now shows the exact saving ($49.48) as the review asked, but the offer engine rounds the BUNDLE discount to a whole amount and the block's "You save" uses the engine's rounding (plan 1.6). The form says what the cart takes off when they differ; the block and the form still show different numbers for a price with cents.
- **The page name in the Dialog is a guess before saving.** It is what `createBundle` derives from the name, but when that page is taken the server adds "-2"; the Dialog closes on save and does not show the final page. Catalog > Bundles shows it.
- **A failed `ids=` read after a good first read marks the whole list "failed"** until the next window focus or create reads it again.
- **The bundles are read on window focus, not on a timer.** A change made in another tab shows when the founder comes back to the editor tab; one made by someone else while the editor stays focused shows on the next focus.
- **The search lists at most 8 options** (the first 50 read, or a search's answer); more words narrow it.
- **The 403 case is unit-tested only** (the drill store's logins all hold storefront.read).
- Carried from the plan: bundles are not versioned (an inline create or a change in Catalog > Bundles is live at once); `/bundles/<slug>` links are keyed by slug and not checked; overlap is reported, not resolved (OQ-D); the home only (deviation 3.5).

From review:

- Acceptance 8 is only partly met, and the packet says so plainly (PARTLY DONE). When the home lookup fails (usedOnHome null), Disable and Delete still go ahead with no confirm. In components/admin/CommercePanels.js line 124, `b.usedOnHome ? setConfirmOff(b) : setEnabled(b, false)` turns the bundle off straight away. That file is not in P5-EDITOR's file list (P5-BATCHES.json), and plan 0.2 gives it no batch 3 owner, so the builder could not fix it legally. The orchestrator must give this fix to an owner before phase 5 closes. This is behaviour from before this item, not a regression.
- The editor wiring in DocumentEditor.js and page.js has no test. These mutations, each applied alone, passed test-editor-inspector, test-bundle-form, test-editor-routes and test-editor-shell: (MA) page.js `offersWrite = true`; (MB) `canCreateBundles: true` whatever `can` says; (MC) a failed or 403 bundle read set to `{status:'ready', items:[]}` instead of 'failed', so the founder would see 'This bundle was deleted… Pick another' instead of 'You can't see bundles here.'; (MD) no ids= read at mount; (ML) pickedBundleIds skips bundle_list; (ME) no re-read on window focus; (MK) the server's q= search answer ignored. Reading the code, it is correct today: fetchRefs throws on !res.ok and the catch sets 'failed'; roleAllows(actor.role,'offers.write') is right; the server still enforces offers.write on /api/admin/bundles. But the 'not offers.write' and '403' paths are proved only at the control level, and the drill says it did not cover them. Suggest a test of EditorView or DocumentEditor's context with a stubbed fetchRefs.
- For a moment, the founder is told a live bundle was deleted. bundleView treats an id missing from a 'ready' list as deleted: chip 'Deleted' and the line 'This bundle was deleted… Pick another or remove it.' Say the founder opens another document whose picked bundles are not in the first 50. Until the pickedKey ids= read answers, a live bundle shows as deleted. bundleAsked already knows which ids are still being read, so those could show 'Checking this bundle…' instead.
- In CreateBundleDialog, the `title` state outlives the form. BundleForm remounts on each open because of `{open && <BundleForm/>}`, but the Dialog's title does not. After one create (or after cancelling with a name typed), opening 'Create a bundle' again shows the live-now sentence with the old page (/bundles/<old-name>) while the Name box is empty. Reset title when the Dialog opens or closes.
- BundleForm quantity: a typed 0 or a negative number is now kept as typed (quantityFrom). It is not marked invalid, because Number.isInteger(0) is true, and isBadQuantity does not flag it. But compat and mergeItems clamp it to 1 (Math.max(1, …)) on both the check and the save. So the founder sees 0 or -2 in the box while the saving and the stored bundle use 1. Before this change, wholeQuantity snapped the box to 1. This affects Catalog > Bundles on legacy tenants too. Suggest treating a value under 1 like the empty case ('Enter how many of this product, 1 or more.').
- A grid row stored as an old { id, title } cannot be picked again in place. bundleList.replace exists but no UI uses it, and adding the same id is refused as a duplicate. The founder has to remove the row and add it again, which moves it to the end. The brief's 're-picking replaces any old value' is fully true only for the single BundleControl.
- In a full grid (12 bundles), 'Create a bundle' is still offered. After the inline create, add refuses with 'A grid shows at most 12 bundles.', but the bundle is already saved and live (OQ-C) and was not placed. Hide or turn off Create when list.length >= max.
- BundleControl, read failed, with a value that is not a { id } object: 'You can't see bundles here.' appears twice. The first <p> and the `!view && <p>` fallback both print it.
- Mutation MJ survived: removing `blank` from the compact 'Create bundle' disabled test changed nothing, because the check is null while a quantity is empty, so passes is already false. The guard is redundant, not a bug.
- Verified: pnpm test passed 98 of 98 in 194.6 s on ports 6300 and 7300 to 7309. These mutations were caught: MF (create does not re-read the bundles), MG, MH (disabled no longer excluded from the no-saving words), MI, MM, MN, MO, MP and MQ. Variant ids are full gids everywhere (lib/ids.js, fixtures), and isPickedVariant uses the same regex as the route's VARIANT_GID, so existing bundles are not wrongly flagged 'pick again'. No storefront or edge files changed. page.js keeps runtime nodejs. Nothing is left listening on my ports, and the review worktree has been removed.

## From review

(Empty until the review.)

## Owner checks

- Wording sign-off: the chips, the turned-off-but-not-ready line, "You can't see bundles here.", "Ask an owner to create bundles.", the Dialog's live-now sentence, and the form's new lines (Known limits).
- Decide where the "confirm Disable and Delete when the home lookup fails" fix goes (CommercePanels.js has no batch 3 owner).
- Decide whether the form should show the engine's whole-amount saving only (as the block does) or keep the cents with the cart note.
- OQ-C on staging: an inline create is live at once (its discount and `/bundles/<slug>`), before publish, and stays if the draft is discarded.
- Phone widths (375, 768) and Safari for the picker, the grid rows and the Dialog.
- Staging: a documents-mode tenant after phase 5 deploys; a support-role login sees "You can't see bundles here." only if its storefront.read is ever refused (today support holds storefront.read, so a real 403 needs a role without it).
- (Carried) The CI sqld download under `.github/` still needs the owner's approval of its source and checksum. This item added nothing under `.github/`.

## Commands

```
node scripts/test-editor-inspector.js     # 46 passed
node scripts/test-bundle-form.js          # 16 passed
TEST_PUBLISH_PORTS=7100,7101 TEST_PUBLISH_SERVICE_PORTS=7102,7103 TEST_PUBLISH_UNDO_PORTS=7104 \
  TEST_PRODUCT_CONTENT_PORTS=7105,7106 TEST_MIGRATE_MAP_SQLD_PORT=7107 MIGRATE_DOCUMENTS_TEST_PORTS=7108,7109 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6100 pnpm test     # 98 of 98
pnpm build
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/seed-design-documents.js --p3
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node <scratch>/helpers/drill-editor.mjs <worktree> <scratch>/drill-out
```
