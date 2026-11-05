# P5-FIX2: the batch 2 review findings in the bundle picker, the bundle form and Catalog > Bundles (COM-01, COM-02)

Branch `cms/p5-fix2`, cut from `5dc250a` (`cms/phase-1` after P5-EDITOR and P5-FIX1 merged and their review findings were folded in). Batch 3. Plan: `docs/cms-reviews/P5-PLAN.md` and `P5-BATCHES.json` (item P5-FIX2). Requirements: COM-01, COM-02. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the item's list):
- Code: `components/admin/CommercePanels.js`, `components/admin/editor/fields/BundleControl.js`, `components/admin/editor/fields/inspectorModel.js`, `components/admin/editor/DocumentEditor.js`, `components/admin/bundles/BundleForm.js`.
- Tests: `scripts/test-editor-inspector.js` (section 7, 10 new tests), `scripts/test-bundle-form.js` (section 7, 4 new tests).
- Docs: this packet.

Not changed: `app/(console)/admin/(authed)/editor/page.js` (it was already right; it is now under test, see MA) and `scripts/test-commerce-exp.js` (nothing in this item needed it). Not touched: `package.json`, `.github/`, `scripts/drills/**`, `MANUAL-CHECKS.md`, `lib/commerce/bundle-words.js`, storefront code, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration, no new dependency. Nothing here runs on the edge: every changed file is console code.

Safety: only file databases were used (the suites' own and `scripts/support/tenant-fixture.js`). `pnpm test` ran with every port-taking suite pinned to 6120 and 7120 to 7129; nothing was listening on them afterwards. No server was started for this item, no store changed mode, `--hosted` was never passed, Typesense was not used, nothing was written to Shopify, and no order was placed.

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` **98 of 98 suites in 191.2 s** (exit 0); `test:editor-inspector` 56 passed (10 new), `test:bundle-form` 20 passed (4 new); `pnpm build` passes (its one Turbopack warning is the existing `next.config.mjs` NFT-trace one) |
| Browser verified | **NOT DONE.** Every acceptance item is a unit, driven or rendered test (react-dom/server and Next's SWC). The desktop Chrome check is an owner check (P5-DRILLS) |
| Staging | **NOT DONE** |

## What and why

The review of batch 2 (the From review lists in `P5-EDITOR.md` and `P5-FIX1.md`) found six founder-facing faults and an untested editor wiring:

1. In Catalog > Bundles, when the live-home lookup fails (`usedOnHome` null), Disable turned the bundle off at once with no question, and Delete said nothing about the home page.
2. For a moment the inspector told the founder a live bundle was deleted: a picked id not yet answered by its `ids=` read looked the same as one the server said is gone.
3. The inline create Dialog kept the name typed in an earlier opening, so its live-now sentence could name an old `/bundles/<slug>`; and a full grid (12) still offered "Create a bundle", which makes a live bundle that the grid then refuses to place.
4. A quantity of 0 or a negative number was kept in the box, while the check and the save clamp it to 1: the box disagreed with what was stored.
5. A grid row stored as an old `{ id, title }` could not be picked again in place (only remove and add again, which moves it to the end).
6. With a failed read and a value that is not `{ id }`, "You can't see bundles here." was printed twice.
7. The editor wiring in `DocumentEditor.js` and `editor/page.js` had no test: mutations MA, MB, MC, MD, ME, MK and ML all survived.

## Design

### (1) `CommercePanels.js` BundlesPanel

- `disableAsksFirst(b)`: Disable goes ahead at once only when `usedOnHome === false` (the home page was read and does not use the bundle). For `true` the confirm says, as before, "Shoppers will stop seeing this bundle on your home page right away." For `null` (or missing) it says "<title> stops being sold as a bundle. We couldn't check whether your home page uses this bundle. Turn it off anyway?"
- The Delete confirm adds "We couldn't check whether your home page uses this bundle. Delete it anyway?" when `usedOnHome` is null. It never claims the home page uses the bundle when that is unknown.

### (2) Pending reads: `inspectorModel.js`, `DocumentEditor.js`, `BundleControl.js`

- The editor's bundle list keeps `answered`: the ids an `ids=` read has answered (the first read's own `ids=`, and the `pickedKey` effect's).
- `bundlesWithPending(bundles, picked)` (pure) adds `pending`: the picked ids that are neither in the list nor answered. `DocumentEditor` hands EditorView this list (`bundlesShown`), so every render, including the one before the `ids=` effect has started, knows which ids are still unknown.
- `bundleView(id, entry, { status, pending })`: an id in `pending` reads "Checking this bundle…" with no chip. Only an id that was asked about and is still absent reads as deleted. The card and every grid row pass `pending` on.

### (3) `BundleControl.js` CreateBundleDialog and CreateBundle

- The Dialog remembers which `open` its name belongs to. When `open` changes it resets the name to empty during render (React's "adjust state on a prop change" pattern), and that same render already uses the empty name. So not even one frame shows the old page.
- `BundleListControl` passes `full` to CreateBundle when `list.length >= bundleGridMax(field.setting)` (the setting's max, else the registry's 12). The button is then off, with the registry's own sentence under it: "A grid shows at most 12 bundles."

### (4) `BundleForm.js` quantity

`emptyQuantity` now also counts a number under 1. Everything that already handled the empty case handles 0 and negatives the same way: the row says "Enter how many of this product, 1 or more.", no check is sent, and "Create bundle", "Save as draft", "Save and show to shoppers" and "Save changes" stay off. The box keeps what was typed, and nothing different is ever stored. A typed 0.5 counts as under 1 too. The box is not marked invalid, the same as the empty case.

### (5) `BundleControl.js` BundleListControl: an old row picked again in place

`isOldBundleChoice(x)` (pure): `{ id }` plus any other key. Such a row gets a "Pick again" button (`aria-label="Pick <title> again"`). It writes `bundleList.replace(list, j, id)`, which rewrites that row as `{ id }` at the same index (replace refuses a duplicate only at another index). Rows that are already `{ id }` have no button.

### (6) `BundleControl.js`: the failed-read sentence once

After a failed read, the fallback under the search is printed only when nothing is picked (`value == null`). A picked `{ id }` says it in its status line, and an unreadable value says it in the line above. Each case prints it once.

### (7) The wiring under test (no code change in `page.js`)

`DocumentEditor` runs under a one-component hook driver (its `<EditorView>` element's props are read, its children are not rendered), with:
- the real `fetchRefs` (`components/admin/cms/RefPicker.js`) over a stubbed `fetch` for `/api/admin/refs` that can hold an `ids=` answer or answer 403;
- a stubbed documents `api`, a stubbed document store whose body has a bundle card on `bun-far` and a grid of `bun-a` and `bun-g1` (only `bun-a` is in the first page);
- a stubbed `window` whose `focus` listeners the test can fire.

The props it gives are then rendered through the real `EditorView` with react-dom/server, with the card or the grid selected, so the inspector shows what a founder would see. `editor/page.js` is called as Next calls it, with its data stubbed and `roleAllows` real.

## Acceptance, with evidence

"Fails without the change": each mutation below was applied alone and the named suites run (`helpers/mut.py` in the scratch folder; it puts each file back after the run).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | unit: Disable/Delete confirm when the home lookup fails; a pending ids= bundle shows 'Checking this bundle…', never 'deleted' | DONE | test-bundle-form "P5-FIX2: when the home page can't be checked (usedOnHome null)…": a real lookup fault (a `documents` column renamed for one `listBundles` read) gives `usedOnHome: null`; Disable opens the confirm with "We couldn't check whether your home page uses this bundle. Turn it off anyway?" and sends nothing; Cancel sends nothing; Delete's confirm has "… Delete it anyway?"; only the Dialog's own Disable sends `{ enable: { id, enabled: false } }`. F1 (Disable goes ahead on null, the code before) and F2 (no Delete sentence) each fail it. test-editor-inspector "a picked bundle whose ids= read is still pending…" (model, card, grid) and "wiring (MD, ML)…" (DocumentEditor with the `ids=` answer held: `pending` is `[bun-far, bun-g1]`, the card and the grid row read "Checking this bundle…", never "was deleted"; then the real states once it answers). F3 (bundleView ignores pending) fails 2; F4 (EditorView gets the list without pending) fails the wiring test |
| 2 | unit: the create Dialog never names an old slug and is off on a full grid; quantity under 1 is treated as empty; an old grid row is re-picked in place; the failed-read sentence prints once | DONE | test-bundle-form "the create Dialog never names an earlier name's page…" (after a Cancel with "Old Name" typed, and after a real create of "Made Kit", it opens again on `/bundles/bundle`): F5 (no reset, the code before) fails it. "a full grid (12) has 'Create a bundle' off…" and test-editor-inspector "a full grid turns 'Create a bundle' off…": F6 fails one in each. test-bundle-form "a quantity under 1 (0 or negative) is treated as empty…" (0, -2 and 0.5: the box keeps it, no check, Create off, the row asks; 2 is checked as 2; full mode's Save as draft and Save and show off with a 0): F7 fails it. test-editor-inspector "a grid row stored as an old { id, title } is picked again in place…" (UNKNOWN_FIELD on row 2 before; "Pick Old kit again" writes `[{a},{old},{3}]`; UNKNOWN_FIELD gone; no button on `{ id }` rows): F8 fails it. "a failed read says 'You can't see bundles here.' once…" (values `"bun-a"`, `42`, `{ title }`, `null`, `{ id }`): F9 (the old `!view &&` fallback) fails it |
| 3 | unit: each editor-wiring mutation MA, MB, MC, MD, ME, MK, ML fails a test | DONE | See the mutation table: MA, MB, MC (each catch alone, MC1 and MC2, and both), MD, MD2, ME, MK, MK2 and ML each fail at least one test in test-editor-inspector section 7. Fix round 1: MC1 (only the `loadBundles` catch) survived the first round, because the stub's `ids=` read also returned 403 and the `pickedKey` effect's catch set "failed" anyway; MC2 (only the effect's catch) survived too, because the old `ids-forbidden` case reached `ids=` inside `loadBundles`. Each now has its own driven test |
| 4 | unit: pnpm test passes | DONE | Fix round 1: `98 of 98 suites passed in 196.1s`, exit 0, ports 6120 and 7120 to 7129 |

### Mutation table

| # | Mutation (alone) | Result |
|---|---|---|
| F1 | Disable goes ahead when `usedOnHome` is null (`=== true`, the code before) | test-bundle-form: 1 failed |
| F2 | Delete confirm without the neutral sentence | test-bundle-form: 1 failed |
| F3 | `bundleView` ignores `pending` | test-editor-inspector: 2 failed |
| F4 | DocumentEditor hands EditorView the list without `pending` | test-editor-inspector: 1 failed |
| F5 | the Dialog never resets its name (the code before) | test-bundle-form: 1 failed |
| F5b | the reset kept, but the same render uses the old name | survived (see Known limits) |
| F6 | a full grid keeps Create on | test-editor-inspector: 1 failed; test-bundle-form: 1 failed |
| F7 | a quantity under 1 is not empty | test-bundle-form: 1 failed |
| F8 | no "Pick again" on an old grid row | test-editor-inspector: 1 failed |
| F9 | the failed-read sentence twice (the old fallback) | test-editor-inspector: 1 failed |
| MA | `page.js` `offersWrite = true` | test-editor-inspector: 1 failed |
| MB | `canCreateBundles: true` whatever `can` says | test-editor-inspector: 1 failed |
| MC | a failed or 403 read (both catches) set to `{ status: "ready", items: [] }` | test-editor-inspector: 3 failed |
| MC1 | only the `loadBundles` catch set to `{ status: "ready", items: [], answered: [] }` (the review's form) | test-editor-inspector: 1 failed ("wiring (MC, first catch alone)"); test-bundle-form passes, as expected. Survived before fix round 1 |
| MC2 | only the `pickedKey` effect's catch set to "ready" | test-editor-inspector: 1 failed ("wiring (MC, second catch alone)"). Survived before fix round 1 |
| MD | no `ids=` read from the open document's picks (the `pickedKey` effect) | test-editor-inspector: 1 failed |
| MD2 | the first read asks no `ids=` | test-editor-inspector: 3 failed |
| ME | no re-read on window focus | test-editor-inspector: 1 failed |
| MK | `searchBundles` ignores the server's answer | test-editor-inspector: 1 failed |
| MK2 | the picker ignores the `q=` answer (local filter only) | test-editor-inspector: 1 failed |
| ML | `pickedBundleIds` skips `bundle_list` | test-editor-inspector: 2 failed |

## Tests

- `scripts/test-editor-inspector.js` section 7 (12 tests): pending reads (model and rendered), an old grid row picked again, the failed-read sentence once, the full grid, and the wiring: MD/ML in both orders (the first page before the document opens, so the effect asks `ids=`; and the document first, so the first read asks it), ME, MC (403 on the first page, and on `ids=`), MK, MB, MA (owner, admin and staff get `offersWrite: true` and the currency; support gets false and no currency read). Fix round 1 added two: "MC, first catch alone" (a 403 on the first page with nothing to mask it: a document with no picks, so no `ids=` read is asked, and a `page-forbidden` stub mode where only the `limit=50` read is refused and `ids=` succeeds; each checks status "failed", no rows, the card says "You can't see bundles here." once with no search and no "Create a bundle", and the grid says it once when empty or on each picked row) and "MC, second catch alone" (the first page answers before the document opens, then the effect's `ids=` read is refused). `driveEditor` takes `makeBody` (`EMPTY_BODY` has a card and a grid with nothing picked). It adds a stub-aware loader (`loadWorld`) and a one-component hook driver, and `mountControl` views gained `nodesAll()`.
- `scripts/test-bundle-form.js` section 7 (4 tests), through the real bundle route on the USD file database.
- `pnpm test`: 98 of 98. `pnpm build`: passes.

## Known limits

- **New words outside `bundle-words.js`**: "We couldn't check whether your home page uses this bundle.", "Turn it off anyway?", "Delete it anyway?" and the "Pick again" button. The full-grid line reuses the registry's sentence. Wording sign-off is an owner check.
- **The Dialog's reset has two layers** (F5b survived). The name is reset with a state update during render, and that same render also uses an empty name. React re-renders before it commits, so the second layer is not needed. It is kept so that no frame ever names the old page, and the driver cannot tell the two apart.
- **"Pick again" only rewrites the row with its own id.** To swap an old row for another bundle in place, the founder still removes it and adds the other, and the new one goes to the end. A deleted or unreadable `{ id }` row has no in-place replace either (unchanged from P5-EDITOR).
- **A grid at 12 still offers the search.** Picking from it is refused with "A grid shows at most 12 bundles." (P5-EDITOR's rule). Only Create is turned off, because only Create makes something live.
- **A disabled bundle whose home lookup is unknown** asks first even when the home page does not in fact use it. That is the safe side.
- **A failed `ids=` read after a good first read** still marks the whole list "failed" until the next focus or create (carried from P5-EDITOR).
- **The drive is not a browser.** DocumentEditor runs under a one-component driver with a stubbed store and `window`. The inspector it feeds is rendered for real, but the browser's own focus events and timing are a drill check.
- Carried: bundles are not versioned; the inline create is live at once (OQ-C); the 403 path is unit-tested only (every seeded role holds `storefront.read`).

From review:

- The earlier blocker is fixed. I re-ran the review's single-site MC1: only the catch in DocumentEditor.loadBundles was changed to setBundles({ status: "ready", items: [], answered: [] }). test-editor-inspector now fails 1 of 58, the test named 'wiring (MC, first catch alone)'. test-bundle-form passes 20 of 20, as expected. MC2 (only the pickedKey effect's catch set to 'ready') fails 1. My own variants also fail: MC1b, an empty first catch, fails 2; MC2b, where the second catch only marks the ids answered, fails 1. Changing both catches fails 3, which matches the packet. The new test does what the review asked: one case has a document with no picks, so no ids= read is asked; the other has a 'page-forbidden' stub where only limit=50 is refused. Both check status 'failed', no rows, and 'You can't see bundles here.' printed once, with no search and no 'Create a bundle'.
- Other wiring mutations, each applied alone on a separate worktree, all fail at least one test. MA: offersWrite = true fails 1, and so does using 'content.write' in place of 'offers.write'. MB: canCreateBundles: true fails 1, and so does `!== false`. ME: no focus listener fails 1. MK: no q= fails 1. MD: the effect returns early, fails 2. ML: no ids= in loadBundles, fails 3.
- Each founder-facing fix also has a test that fails when I break it. F1: Disable goes ahead on null. F1b: homeUnknown only checks for undefined. F2: no Delete sentence. F3 and F3b: pending is ignored, or answered is ignored. F5: the Dialog title is not reset. F6 and F6b: the full grid uses > instead of >=, or the button is not turned off. F7: quantity treats only q < 0 as empty. F8 and F8b: Pick again moves the row to the end, or never shows. F9 and F9b: the old !view fallback comes back, or the sentence always prints.
- Test gap, not a blocker: three mutations in DocumentEditor.loadBundles survive. (a) `answered: want` changed to `answered: []`. A picked bundle past the first 50 that was really deleted would then read 'Checking this bundle…' for good instead of 'was deleted'. The founder sees a wrong but safe message: the bundle is never shown as deleted while it still exists. (b) bundleAsked set back to the item ids only, which costs one extra ids= read. (c) The `mine === bundleSeq.current` guard on the ready set is dropped. None of these is named in the acceptance list.
- Rare race, not a blocker: a window-focus re-read can be in flight while the founder opens another document. If the pickedKey effect's ids= answer arrives before loadBundles finishes, loadBundles then overwrites `items`, `answered` and `bundleAsked`, so that answer is lost. The effect does not run again, because pickedKey and status have not changed, so that bundle reads 'Checking this bundle…' until the next focus. It is never shown as deleted. Worth a note in Known limits.
- Legacy tenants: bundleIdsOnLiveHome returns an empty Set when a tenant has no documents or document_refs tables, so usedOnHome is false and Disable still goes ahead at once with no new confirm. The panel always refreshes from GET /api/admin/bundles, and each row from listBundles carries usedOnHome, so a newly saved bundle does not wrongly get the 'couldn't check' confirm.
- pnpm test: 98 of 98 suites passed in 203.1 s, exit 0, on ports 6320 and 7320-7329. Log: /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p5-b3/P5-FIX2/rv1-pnpm-test.log. Nothing was changed under .github/, scripts/drills, MANUAL-CHECKS.md or package.json. The changed code is in admin client components and adds no node: APIs. Both review worktrees (rv1 and rv1m) were removed, and nothing is listening on my ports. Mutation helper: /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p5-b3/P5-FIX2/rvhelp1/mut.py.

## From review

- Fix round 1 (BLOCK): the claim that MC fails a test was not proven for the review's single-site form. Changing only the `loadBundles` catch to "ready" passed every test, because the follow-up `ids=` 403 masked it. If it came back, a 403 or failed first read on a home with no picked bundles (or whose `ids=` read succeeds) would give the founder an empty picker with search and "Create a bundle" instead of "You can't see bundles here." Fixed in the tests only (no code change was needed: the code was right). MC1 now fails the new test; while checking, MC2 (only the effect's catch) was found to survive as well and got its own test.

## Owner checks

- Wording sign-off: "We couldn't check whether your home page uses this bundle. Turn it off anyway?", the Delete variant "… Delete it anyway?", and "Pick again".
- **Browser (P5-DRILLS):** in desktop Chrome on the design harness, open a home whose card picks a bundle outside the first 50: it reads "Checking this bundle…" and then its state, never "deleted". Open "Create a bundle", type a name, cancel, open it again: the sentence names `/bundles/bundle`. On a grid of 12, "Create a bundle" is off. A 0 in a quantity box keeps Create off. A grid row stored as `{ id, title }` (planted through the documents API as a draft) shows "Pick again".
- Catalog > Bundles with the home lookup failing can't be made to happen on staging without a fault. It is unit-tested against a real lookup fault on a file database.
- Phone widths (375, 768) and Safari for the Dialog, the grid rows and the Pick again button.
- Staging: NOT DONE, as for the rest of phase 5.
- (Carried) The CI sqld download under `.github/` still needs the owner's approval of its source and checksum. This item added nothing under `.github/`.

## Commands

```
node scripts/test-editor-inspector.js     # 56 passed
node scripts/test-bundle-form.js          # 20 passed
TEST_PUBLISH_PORTS=7120,7121 TEST_PUBLISH_SERVICE_PORTS=7122,7123 TEST_PUBLISH_UNDO_PORTS=7124 \
  TEST_PRODUCT_CONTENT_PORTS=7125,7126 TEST_MIGRATE_MAP_SQLD_PORT=7127 MIGRATE_DOCUMENTS_TEST_PORTS=7128,7129 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120 pnpm test     # 98 of 98
pnpm build
python3 <scratch>/helpers/mut.py <worktree> [F1 F2 … ML]   # the mutation table
```

Scratch folder: `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p5-b3/P5-FIX2/` (`helpers/mut.py`, `pnpm-test.log`, `pnpm-build.log`).
