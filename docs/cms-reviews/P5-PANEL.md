# P5 · PANEL · The console bundle form: picked products, a derived link, and no accidental turn-off

Branch `cms/p5-panel`, cut from `f80ba0f` (`cms/phase-1`). Plan: `docs/cms-reviews/P5-PLAN.md` (decisions 9, 11, 12; batch 2) and `P5-BATCHES.json` (item P5-PANEL). Requirement: COM-02. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the plan's list):
- Code: `components/admin/bundles/BundleForm.js` (new), `components/admin/CommercePanels.js` (BundlesPanel only), `app/(console)/admin/(authed)/catalog/page.js`, `app/api/admin/bundles/route.js`, `lib/bundles.js`.
- Tests: `scripts/test-bundle-form.js` (the placeholder replaced), `scripts/test-commerce-exp.js` (6 new cases).
- Docs: this packet.

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/commerce/bundle-words.js`, `lib/commerce/bundle-compat.js`, `scripts/test-product-editor.js`, `scripts/test-legacy-routes.js`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration. No new dependency.

Safety: tests ran on file databases only (`scripts/support/tenant-fixture.js` and the suites' own). The drill ran on this worktree's own design harness (`DESIGN_PORT=6140`, `DESIGN_SQLD_PORT=7140`, perf seed), started and stopped by the drill; ports 6140 and 7140 to 7149 were free afterwards. `pnpm test` pinned every port-taking suite to 6140 and 7140 to 7149. No store changed mode, no `--hosted`, Typesense untouched, nothing written to Shopify, no test order.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 98 of 98 suites passed in 185.2 s. `test:bundle-form` 9 passed (new, about 0.5 s). `test:commerce-exp` 41 passed (6 new). `test:legacy-routes` 29 and `test:product-editor` 29 pass, unchanged files. `pnpm build` passes; its 2 Turbopack warnings are the existing `next.config.mjs` NFT trace warning |
| Browser verified | Yes, desktop Chrome on the design harness (perf seed), 16 of 16 checks: see "Drill" below |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

The Catalog > Bundles panel asked the founder to type a slug and a "product-handle or gid://…" for each product, priced in a hard-coded ₹, and showed the legacy `problems` strings ("component 2: variant not in the catalog"). A typed handle was quietly resolved to the product's first variant. An edit sent `enable` every time, so saving a live bundle as a draft turned it off. COM-02 needs a form the founder can use (in the console and, in P5-EDITOR, inside the editor) that picks products, derives the link, and never turns a live bundle off by accident.

## Design

### (1) `components/admin/bundles/BundleForm.js` (new, client)

`<BundleForm currency initial onSaved(bundle) compact onCancel />`, exported as `BundleForm` (and default) for P5-EDITOR. Also exported: `applyPick(rows, at, pick)` and `reasonWords(reason, currency)`.

- **Fields.** Name; Products (one row per picked variant: its name, a Change button that opens `VariantPicker`, a whole-number quantity, Remove); "Add product" opens the picker for a new row; Price; Description (full mode only, kept on edit). There is no text field for a product and no slug field.
- **Picking.** Picking a variant already in the list adds to that row's quantity (a new pick adds 1; changing a row to a variant another row holds merges the two rows). The server merges too (P5-BUNDLEREAD).
- **Live check.** Every change posts `{ check: { items, bundle_price } }`; a stale answer is dropped (a sequence number). The structured `reasons` become words through `lib/commerce/bundle-words.js reasonSentence`: per row (`sold_out` "Sold out", `missing` "No longer available", `duplicate`, `bad_quantity`), under Products (`too_few`, `mixed_currency`) and under the price (`no_saving` "Price must be lower than <sum>", `bad_price`). When the check passes, under the price: "The products add up to <sum>. Shoppers save <saving>." (the saving rounded as the engine rounds it). Money is `formatMoney(amount, currency)` with the store's currency. The legacy `problems` are never read.
- **Full mode, new bundle.** "Save as draft" sends `{ create: { …, description, enable: false, mustPass: false } }`. "Save and show to shoppers" sends `enable: true, mustPass: true` and is disabled until the live check passes; the server saves nothing if it fails. After a save the form edits that bundle and shows "Shoppers' link: /bundles/<slug>" (read-only) and "Saved.".
- **Full mode, edit.** One "Save changes" that sends `{ bundle: { id, title, items, bundle_price, description } }`: no slug and no `enable`, so the slug and the on/off state stay as stored (P5-BUNDLEREAD). The on/off control stays in the panel's list (Enable / Disable).
- **Compact mode** (the editor's Dialog): Name, Products, Price, and one "Create bundle" that sends `{ create: { title, items, bundle_price, enable: true, mustPass: true } }`. It is disabled until the live check passes and a name is given, and stays disabled after a create (no double create).
- **Errors.** A 422 with `reasons` puts those reasons on the rows; the message shown is the server's plain one.

### (2) `components/admin/CommercePanels.js` BundlesPanel

- Uses BundleForm. The slug input, the typed product input, `inr()` and "Bundle price (₹)" are gone. Prices are `formatMoney(…, currency)`.
- The card is `<Card id="bundles">`, the anchor `/admin/catalog#bundles` that bundle-words and the editor link to.
- Each row: a warning when the check does not pass, in bundle-words (the state line as its title when the bundle is on, the reason sentences below). "On your home page" when the live home shows it.
- **Enable is offered only to a draft whose check passes** (state `available`). A draft that fails (for example a quantity of 1.5) shows why and has no Enable button; the server refuses too.
- **Disable** of a bundle on the live home opens a confirm that says "Shoppers will stop seeing this bundle on your home page right away."; any other bundle is turned off at once, as before. The **Delete** confirm adds the same sentence when the bundle is on the live home.
- A failed Enable shows the reasons in bundle-words, never "can't enable: component 1 (…)".
- QuizPanel is unchanged.

### (3) `app/(console)/admin/(authed)/catalog/page.js`

Both render sites (documents and legacy) pass `currency` to BundlesPanel. It is read through `lib/bundles.js bundleCurrency()` (which is `lib/offers/catalog.js storeCurrency()`); if that read throws, the panel gets `undefined` and formatMoney uses its own default, as Price.js does. Nothing else changed; the P4-ED05 split stands.

### (4) `app/api/admin/bundles/route.js`

- `resolveItems` is gone. The `bundle` and `check` actions, like `create` already did, accept only variant GIDs (`gid://…/ProductVariant/…`); anything else (a handle, an empty id) is refused 422 `{ error: "Pick the product again.", code: "BAD_ITEM" }` before any read or write (deviation 3.10, OQ-F).
- `check`'s answer is unchanged otherwise.
- GET rows carry `usedOnHome` (from `listBundles`, below). `offers.write` / `offers.read` unchanged.

### (5) `lib/bundles.js`

- **Whole quantities (P5-BUNDLEREAD review).** `bundleCompat` adds reason `{ kind: 'bad_quantity', index, title, words }` for any quantity that is a finite non-whole number (1.5), plus a legacy-style problem so `ok` stays "no problems"; the state is `not_ready`. A missing or non-numeric quantity still reads as 1, as `mergeItems` and `compatFrom` always did. `lib/commerce/bundle-words.js` has no sentence for this kind and is not this item's file, so the reason carries the engine's own words, "The quantity must be a whole number, 1 or more"; the console shows `reasonSentence` first and then `words`. A turned-off draft still saves with 1.5; `listBundles`, `createBundle` and the route's check report it `not_ready`, so it is never shown as ready to turn on. Turning it on (`setBundleEnabled`, `upsertBundle` with `enable: true` or an edit of a live bundle, `createBundle` with `enable` or `mustPass`) is refused `BUNDLE_INVALID` "Each product's quantity must be a whole number, 1 or more. Nothing was saved." before anything is written (the same code and words P5-BUNDLEREAD's fix 1 tests expect).
- **`bundleIdsOnLiveHome()`**: one statement, `document_refs` rows `('bundle', id)` joined to the published version of the store's `home` document (`documents.published_version_id`, not archived); the same index media "Where it's used" reads. A store without the `documents` or `document_refs` table answers an empty Set; any other failure throws.
- **`listBundles()`** adds `usedOnHome` to each row: true or false, or null when the home lookup failed (logged `bundle_home_use_unread`; the panel then says nothing about the home page). Putting it here (not only in the GET) means the Catalog page's first render has it too.
- **`bundleCurrency()`**: the store's currency for the console.

## Acceptance, with evidence

| # | Item | Status | Evidence (and the run without the change) |
|---|---|---|---|
| 1 | test-bundle-form: the source scan finds no 'gid://' placeholder, no slug Input, no '₹' or 'INR', and no compat.problems in BundleForm.js and CommercePanels.js | DONE | "BundleForm.js and the BundlesPanel part of CommercePanels.js hold no …". The scan covers the whole of BundleForm.js and CommercePanels.js from the top to the quiz editor (the quiz keeps its own slug field, which is not a bundle's). It also checks formatMoney, bundle-words and the `#bundles` card. On the old CommercePanels.js it fails ("a typed variant-id placeholder") |
| 2 | test-bundle-form: full mode renders Name, Products, Price, Description and 'Save as draft' / 'Save and show to shoppers'; compact renders only Name, Products, Price and 'Create bundle' | DONE | "full mode (new bundle) renders …" (labels exactly Name, Price, Description; the Products list; inputs exactly name and price before a pick; both buttons; show-to-shoppers disabled) and "compact mode renders only …" (labels Name, Price; no textarea; buttons exactly "Add product", "Create bundle", disabled). BundleForm.js did not exist before |
| 3 | test-bundle-form: a failing check renders bundle-words reasons per product row and no 'component N:' text | DONE | "a failing check renders bundle-words reasons …", through the real bundle route on a USD file database: rows read "Sold out", "No longer available", "" and the price "Price must be lower than $400"; no "component N", ₹, INR or legacy problem words on screen |
| 4 | test-commerce-exp: a handle variantId on `bundle` or `check` is refused 422 'Pick the product again.' and no row is written | DONE | "P5-PANEL: a handle (or any non-GID) variantId on `bundle` or `check` …" (create, the brief's `some-handle` case, an empty id, an edit of an existing bundle, and `check`; row, offer and counts unchanged). Fails on the old route (200) |
| 5 | test-commerce-exp: an edit without slug, enable or description keeps all three and updates the bundle-<id> offer price | DONE | "P5-PANEL: an edit through the route without slug, enable or description …" (also the new title and a third item in the offer). This server behaviour is P5-BUNDLEREAD's and the case passes on the base too; what this item adds is that the form's edit never sends them, proved by test-bundle-form "full mode: 'Save as draft' … 'Save changes' sends no slug and no on/off and keeps a live bundle live" (the old panel sent `slug` and `enable` on every save) |
| 6 | test-commerce-exp: GET marks usedOnHome for a bundle referenced by the live home | DONE | "P5-PANEL: GET marks usedOnHome for a bundle the LIVE home refers to …" (an older home version, another document type and a media ref do not count) and "… a store without the documents tables …" (all false, no error). Both fail on the base (no `usedOnHome`) |
| 7 | pnpm test is green | DONE | 98 of 98 suites, 185.2 s |
| 8 | unit: a non-integer quantity gives a compat reason and is never offered 'Turn it on'; createBundle's mustPass pre-check is pinned | DONE | test-commerce-exp "P5-PANEL: a quantity that is not whole (1.5) gives the bad_quantity reason …" (bundleCompat, createBundle, listBundles, setBundleEnabled, upsertBundle, the route's check; fails on the base: "got [true, available, []]"); test-bundle-form "the panel: … a draft with a quantity of 1.5 … is never offered Enable" (its buttons are exactly Edit, Delete; a passing draft has Enable). The pre-check: "P5-PANEL: createBundle's pre-check: mustPass with enable: false and a 2-character name is refused …"; with the `assertEngineAccepts` line in createBundle disabled it fails (the mutation the BUNDLEREAD review said survived) |

## Drill (desktop Chrome, design harness)

`DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140`, `node scripts/dev-design.js seed --fixture perf`, then a scratch journey (not a repo file) using `scripts/drill.js` (`connectHarness({ start: true })`, `signIn`, Chrome 1440 wide). 16 of 16 checks passed:

- `/admin/catalog` 200; `section#bundles` is there.
- "New bundle": only the Name and Price inputs, no "gid://".
- Two products picked through the picker (search "PF-"), then the first again: still two rows, its quantity 2.
- Price 999999: "Price must be lower than ₹3,197" under the price, "Save and show to shoppers" disabled.
- Price 3147: "The products add up to ₹3,197. Shoppers save ₹50.", button enabled; saved: "Shoppers' link: /bundles/drill-duo", the form switches to "Save changes", the list shows it Live.
- No "component N", "gid://" or "can't enable" in the card; deleted again through the confirm; no page errors.

Screenshots and `results.json` are in the scratch folder, not committed (the drills folder is P5-DRILLS'): `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p5-b1/P5-PANEL/drill-out/docs/cms-reviews/drills/P5-PANEL/`. The first drill run found a layout bug (the quantity box took the row's whole width and hid the product name, because the console `Input` is `w-full`); fixed by wrapping it in a `w-20` box, shown in the second run's screenshots.

Not drilled: the compact mode (no Dialog uses it until P5-EDITOR), the home-page confirm (the perf seed's home is legacy, so no bundle is on a live documents home), phone widths and Safari.

## Tests

- `scripts/test-bundle-form.js` (new content; the `test:bundle-form` entry was registered by P5-SOURCES): Next's SWC plus the hook driver copied from test-media-picker (VariantPicker is not called; the test picks by calling its `onConfirm`). The browser `fetch` lands on the real `app/api/admin/bundles/route.js` on a tenant-fixture file database set to USD, so money and words are checked without a ₹ that formatMoney would print for INR. 9 cases.
- `scripts/test-commerce-exp.js`: 6 new P5-PANEL cases on the existing "cb" fixture.
- Unchanged and still green: test-product-editor and test-legacy-routes (they stub CommercePanels and `@/lib/bundles`), test-failure-matrix (its bundle case uses GIDs), test-effective-read.

## Known limits

- **Stores whose variant ids are not Shopify GIDs cannot make or check bundles any more.** Every real store syncs Shopify GIDs, but the design harness's plain demo seed (`scripts/seed-demo.js`, variant ids like `demo-1-v1`) does not: picking one of those 8 products makes the check answer "Pick the product again." (the first drill run hit this; the drill then used the perf seed's GID products). `create` (P5-BUNDLEREAD) already had this rule; this item extends it to `bundle` and `check` as the brief says. Bundles already stored with such ids still list, edit (once re-picked), turn on and off.
- **`bad_quantity` words live in lib/bundles.js**, not in bundle-words (not this item's file): the reason carries `words`. The next owner of bundle-words should add a `reasonSentence` case and the reason can drop `words`.
- The legacy-routes and product-editor suites stub `@/lib/bundles` with only `listBundles`, so on their stubbed Catalog page `bundleCurrency` is missing, the page's guard gives `undefined`, and their stub props stay byte-identical. On a real page the currency is passed. A reviewer may prefer those suites to stub `bundleCurrency` explicitly; they were not changed, as the brief says.
- `usedOnHome` is null (and the panel says nothing about the home page) if the home lookup fails for a reason other than missing tables; logged as `bundle_home_use_unread`.
- `usedOnHome` reads the published home only. A bundle in an unpublished home draft is not counted: turning it off changes nothing shoppers see now, but the next publish will warn (P5-CHECKS).
- Bundles are not versioned: an edit or turn-off in Catalog > Bundles changes every live card at once (plan section 4).
- The live check posts on every keystroke in the price (no debounce; stale answers are dropped). Cheap (two statements) but chatty.
- An edit of a live bundle whose check fails is not blocked in the form; the server refuses it in plain words and the reasons land on the rows.
- Quantity entry rounds to a whole number of at least 1. A stored 1.5 is shown as 1.5 (marked invalid) until the founder changes it, and "Save changes" on a turned-off draft keeps it as it is.

## From review

(None yet.)

## Owner checks

- Sign-off of deviation 3.10 parts made here: handles (and any non-GID id) refused on the `bundle` and `check` actions; a draft with a non-whole quantity is shown as not ready and can't be turned on.
- Decide whether the design harness demo seed should get GID variant ids, so bundles can be made on the plain seed (today use `--fixture perf`).
- On staging, after deploy, on a documents store with a bundle card on the live home: Disable and Delete in Catalog > Bundles say "Shoppers will stop seeing this bundle on your home page right away."; the "On your home page" marker shows.
- Phone widths (375, 768) and Safari for Catalog > Bundles and the form.
