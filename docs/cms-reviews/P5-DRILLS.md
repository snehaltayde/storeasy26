# P5 · DRILLS · Browser proof of the bundle blocks, legacy stores untouched, and the owner checks (TREE-01, COM-01, COM-02)

Branch `cms/p5-drills`, cut from `5dc250a` (`cms/phase-1` after batch 2 and its review notes: P5-SOURCES, SETTING, BUNDLEREAD, HIDDEN, BLOCKS, CHECKS, PANEL, EDITOR and FIX1 merged). Plan: `docs/cms-reviews/P5-PLAN.md` and `P5-BATCHES.json` (item P5-DRILLS, batch 4), with the owner's answers of 2026-11-05 (OQ-B: a bundle that saves nothing is hidden; OQ-C kept; deviation 3.10 accepted). Phase 2 plan sections 0, 3 and 6 and the harness rules (`P1-HARNESS.md`, `P4-DRILLS.md`) apply.

This is the author's own report. Reviewers should re-read the code and the results files.

**What was drilled:** the tree at `5dc250a` plus this item's drill and doc files. **P5-FIX2 ran beside this item and had not merged**; nothing of it is in these runs. Its editor and bundle-form changes should be drilled again once it merges (`node scripts/drills/p5/run.mjs pick,create,console`).

## Files

All in the plan's list: `scripts/drills/p5/run.mjs`, `lib.mjs`, `blocks.mjs`, `legacy.mjs` (new), `docs/cms-reviews/drills/P5-DRILLS/` (results, screenshots, `baseline-legacy/`, `phase5-legacy/`), `docs/cms-reviews/MANUAL-CHECKS.md` (new "Phase 5, batch 3" section), this packet.

`scripts/drills/p5/seed-p5.mjs` is in the plan's list but was **not needed**: every stage seeds its bundles in-process through `lib.mjs` (`makeBundle`, `bundleEnabled`, `bundleGone`, which call `lib/bundles.js` `createBundle`, `setBundleEnabled`, `deleteBundle`), so no separate seed file was written.

Not touched: `app/`, `lib/`, `components/` (no app code: `git diff 5dc250a --stat -- app lib components` is empty), `package.json`, `.github/`, `scripts/drills/p3/*`, `scripts/drills/p4/*` (imported only), `scripts/seed-design-documents.js`, the untracked `docs/CMS_*.md` files, the two named `.claude/worktrees`. No migration, no dependency.

## Safety

Every drill ran on this worktree's own design harness (`DESIGN_PORT=6100`, `DESIGN_SQLD_PORT=7100`, so sqld on 7100 to 7102), started and stopped by each stage; nothing listened on 6100 or 7100 to 7109 afterwards. Every address goes through `assertLocal`; the harness env is the harness's own (never `.env.local`), and it blanks Shopify, Razorpay and Typesense. No store left the harness; no real or hosted store changed mode; `--hosted` was never passed; no migration or cutover tool ran. Nothing was written to Shopify; Typesense was not used. Stock and price changes went through the sync writer (`lib/sync.js` `writeProduct`, and its own `deleteProductByGid` for one deleted product), never a raw catalog UPDATE. One cash on delivery test order per `cart` run, to snehal@mediastic.in, cancelled at once, after a check that neither the store's row nor the harness env holds a Shopify domain or token or a payment secret; no card details were entered. The afd7881 baseline worktree was a throwaway detached worktree in the scratch folder (outside `.claude/worktrees`), with its own `pnpm install --frozen-lockfile --prefer-offline`, removed by the stage.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` and `pnpm build` (see Tests). Drills are not test suites (they need the harness and Chrome) |
| Browser verified | Yes: desktop Chrome 156 (headless), 1440 px (and the founder's preview at 375), on the design harness (`next dev`): every stage, 102 checks, 0 failed (see "The run") |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

Phase 5 built the bundle card and grid, the bundle picker and inline create, the bundle publish warnings and the hidden-section notes, each proved by unit and rendered tests. This item proves the founder's tasks (US-28, US-33, the bundle half of US-34) end to end in desktop Chrome, proves legacy stores render exactly as before phase 5, and gathers the phase 5 owner checks into `MANUAL-CHECKS.md`.

## Design

### The runner (`scripts/drills/p5/run.mjs`)

`node scripts/drills/p5/run.mjs [stage,…]` runs each stage on a fresh seed with its own harness and writes `docs/cms-reviews/drills/P5-DRILLS/results-<stage>.json` (checks, notes, screenshots) and the summary `results-run[-<stages>].json`. `P5_DRILL_SCRATCH` names a folder for the legacy snapshot and raw captures (default: a new temporary folder). Stages: `baseline`, `legacy`, `pick`, `create`, `states`, `nosaving`, `disabled`, `grid`, `cart`, `console`, `unknown`.

### The stores

- **Documents-mode store (every bundle stage):** the phase 3 seed, `seed-design-documents.js --p3` (through the P3 helper `reseed`): the design store seeded straight into documents mode, i.e. a new documents-mode tenant, **not** a store moved by the P4 cutover. It is the perf catalog (Shopify-style GIDs) with the phase 3 content and an owner login. The drills' own bundles use products no seeded bundle uses (the perf seed has four), so nothing overlaps unless meant to.
- **Legacy store (baseline, legacy):** the P4 legacy store, `seed-design-documents.js --p4` (a legacy store live on a version 3 release, with a running hero test and the perf seed's bundles). Its `/bundles/<slug>` is the perf seed's turned-on `gym-starter-kit`.

### Shared helpers (`lib.mjs`)

Re-exports the P3 and P4 helpers (imported, never edited) and adds: `docStore`, `inStore` (withTenant in the drill process, against the running harness's local databases only, through `withHarnessStore` with `write: false`), `pickVariants`, `makeBundle`, `bundleEnabled`, `bundleGone`, `readBundles` (`bundlesByIds`), `productShape` and `syncProduct` (a product rebuilt from its rows into the shape `writeProduct` takes, changed, and written by the sync writer; each call first writes the unchanged shape and checks no row changed, so the only change is the one asked for), `soldOut`, `priced`, the editor helpers (`openEditor`, `addSection`, `pickBundleIn`, `publishAndRead`, `actOn`, `readPanel`), `liveHome` (the live home in a fresh browser with a fixed experiment unit), `saveHome` (the home draft through the documents writer API from a signed-in page), and `noShopifyOrPayment`. `node scripts/drills/p5/lib.mjs --check` runs the helpers' own checks.

### Byte comparisons, and what is masked

`next dev` writes a per-request id (`self.__next_r`) and render timings into every page's streamed scripts, so two fetches of the same unchanged page never match byte for byte (seen in the `unknown` stage). Pages are therefore compared after **the P4 comparison's own mask**, `lib/migrate/render-compare.js normalize` (scripts, generated ids, hashed asset names, date-times, the origin), and that output is compared byte for byte. The cart JSON is compared with only its random cart id and date-times masked. The a6d028e-style home render is compared raw for every state's home page; its content pages differ between two runs of the **same** tree only in section ids the recorder mints fresh each run (the stage proves that with a second run), so those minted ids alone are masked (narrower than `test-legacy-fixtures`, which takes out every `data-section-*` attribute).

## The stages

- **baseline**: a fresh `--p4` store, seeded once on this tree and copied aside (the snapshot). A throwaway detached worktree at `afd7881` (phase 5's base), its own `pnpm install`, the snapshot copied in, its own harness: the home page, a product (`/products/micronised-creatine-12`), a collection (`/collections/protein`) and `/bundles/gym-starter-kit` as a shopper (fixed unit), the cart JSON after adding that bundle's products the way its button does, the old home Designer's "Add section" list and the Home page editor's add buttons as the owner, and afd7881's own a6d028e-style home render. Saved in `baseline-legacy/` (masked pages, `cart.json`, `home-render.json`, `index.json` with raw and masked hashes). The worktree is removed.
- **legacy**: the same snapshot served by this tree's harness; the same captures (`phase5-legacy/`), compared with `baseline-legacy/` as above; the old editors offer the same section types and no bundle kinds.
- **pick (US-28, benchmark row 2)**: two turned-on bundles; a fresh browser, the owner signs in; **timer starts** on opening `/admin/editor`: Add a section, Bundle card, type "gym", pick "Gym duo" (saved as `{ id }` only, the preview shows it, the inspector says "Showing to shoppers."), the founder's preview at 375 wide (a second tab of the same browser; see finding P5D-1), Publish, review, Publish, then a fresh browser loads `/` until the card is there. **Timer stops.**
- **create (COM-02)**: Add a section, Bundle card, Create a bundle: the Dialog's live-now sentence for `/bundles/drill-trio`, only Name, Products and Price; two products through the real VariantPicker; a price of 99999999 keeps "Create bundle" off with "Price must be lower than ₹…"; a passing price turns it on with the saving; Create: exactly one new bundles row (`drill-trio`, on, no `-2`), its offer on, the section's draft picks `{ id }` of it, the inspector reads it again; a shopper opens `/bundles/drill-trio` before any publish; the live home has no card yet.
- **states (US-33)**: a card on a turned-on bundle in the draft; one product sold out through the sync writer; the preview card says "Currently unavailable" and marks that product "Sold out"; the inspector line is the sold-out sentence; publish shows BUNDLE_UNAVAILABLE ("Remove this section and publish") and publishes; the live card has add disabled. Then P5-FIX1's browser check: a second bundle whose product the sync writer deletes reads `sold_out` with a missing product (never `no_saving`); preview: "Currently unavailable", "No longer available" and the "Replace it" founder note; live: the same card with no note.
- **nosaving (owner's OQ-B stage)**: a live, available card; the founder raises the price above the products' sum in Catalog > Bundles: refused, nothing saved (an edit that breaks a live bundle is refused, deviation 3.10); so the drill makes the price stop saving the way a real store does: both products get cheaper through the sync writer until their sum is under the bundle price. The live home loses the card at once; the preview shows "Bundle card: hidden from shoppers" with the owner's sentence naming the sum; the inspector says the same; publish (after a heading change) warns BUNDLE_UNAVAILABLE naming the sum and publishes; the live home still has no card.
- **disabled (US-34, bundle half)**: a live card; Catalog > Bundles shows "On your home page"; Disable asks first ("Shoppers will stop seeing this bundle on your home page right away."); the live home hides the card at the first look after the click (no publish); the preview note and the inspector give the turned-off reason; a click on the note in the preview selects that section (P5-HIDDEN's browser check); publish shows BUNDLE_DISABLED with "Remove this section and publish", which takes out only that section and publishes again.
- **grid**: Add a section, Bundle grid, four bundles picked in order through the inspector; then one sells out (sync writer), one is turned off, one deleted. Preview: the available and sold-out cells, and a note for cells 3 and 4 with their reasons; the inspector gives each row its own line. Publish: BUNDLE_UNAVAILABLE `removeItem:1`, BUNDLE_DISABLED `removeItem:2`, BUNDLE_MISSING `removeItem:3`, each "Remove it and publish", and publishes. Live: two cells in order (available, then sold out with add off), no note. "Remove it and publish" on the turned-off bundle removes only it; then on the deleted one, only it; the live grid keeps its two cells.
- **cart**: a live card; shopper A adds from the card, shopper B from `/bundles/<slug>`; the two carts are equal (lines, subtotal, discount, total, applied offers) and take off the saving the card shows; the checkout review shows "You save ₹150"; one cash on delivery test order to snehal@mediastic.in, carrying that discount, cancelled at once.
- **console**: Catalog > Bundles, New bundle and Edit: no input whose id, name, label or placeholder is a slug, GID or handle, and no "gid://" text; editing a live bundle's price saves it, keeps it on, and the live card shows the new price at once.
- **unknown (TREE-01, validator regression)**: a live card; a draft save through the documents writer API with a bundle card whose body binding names `no_such_source`: 422, BINDING_INVALID, "This bundle card section is set up in a way the editor can't fix. Remove it and add it again."; same revision and draft, no version holds the source; the live home is byte-identical (after the P4 mask). The runtime `source_unknown` path (a source removed after registration) is proved in test-sections and test-sections-render only, as the plan says: a draft cannot hold it.

## Acceptance, with evidence

These are drills, not unit tests; "fails without this change" means the stages did not exist before this branch. One bite check was run by hand for the legacy comparison (below).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Baseline and legacy show the legacy store's shopper captures byte-identical between afd7881 and the phase 5 tree | **DONE** (after the P4 mask; see "Byte comparisons") | `results-baseline.json` (12 passed), `results-legacy.json` (9 passed): home, product, collection, `/bundles/gym-starter-kit` byte-identical after the P4 mask; cart JSON byte-identical (cart id and date-times masked); the home render's home pages raw-identical in every state, content pages identical once the minted ids are masked (and two runs of this tree differ only there). **Bite check:** with `components/BundleAddButton.js` changed by hand to say "Add the whole set to cart", the legacy stage failed exactly the `/bundles/gym-starter-kit` check (masked hashes `d7d0415d…` vs `00367a18…`); the file was put back and the stage run again in the full run |
| 2 | The pick stage records the time from editor to live card (target under 2 minutes) and a Mobile preview screenshot | **DONE**, with finding P5D-1 | `results-pick.json`: **15.1 s** from opening the editor to a fresh browser seeing the card (laps: editor 4.1, card added 5.2, picked and saved 6.3, preview 6.7, phone preview checked 13.4, published 14.3, live 15.1); 7 clicks after sign-in, one typed word. Screenshot `pick-mobile-preview-375.png`. The new editor has no Mobile switch, so "the Mobile preview" is the founder's own preview in a second tab at 375 (finding P5D-1) |
| 3 | The create stage shows Save disabled on a failing price, then exactly one new bundle after the fix, picked in the section, with the live-now sentence | **DONE** | `results-create.json` (11 passed); `create-failing-price-1440.png`, `create-passing-price-1440.png`, `create-picked-1440.png`, `create-bundle-page-before-publish-1440.png` |
| 4 | The states, disabled and grid stages show the live and preview outcomes and warnings named in the brief, with screenshots | **DONE** | `results-states.json` (11), `results-disabled.json` (10), `results-grid.json` (12); the warning codes and actions are read from the publish answer the editor got, and the words and buttons from the panel; screenshots `states-*`, `disabled-*`, `grid-*` |
| 5 | The cart stage shows equal carts from the block and the bundle page, and the test order to snehal@mediastic.in is cancelled | **DONE** | `results-cart.json` (9 passed): equal carts, discount ₹150 = the card's saving, review "You save ₹150", order `DES-09CD2788` (cash on delivery) placed and cancelled (status `cancelled`) |
| 6 | The unknown stage shows the draft save refused 422 with nothing stored and the live home unchanged | **DONE** (live home compared after the P4 mask) | `results-unknown.json` (5 passed) |
| 7 | MANUAL-CHECKS.md lists every phase 5 owner check from plan section 4 | **DONE** | "Phase 5, batch 3" in `MANUAL-CHECKS.md`: every plan section 4 line, the batch 0, 1 and 2 review items the brief named, and this item's findings |
| 8 | pnpm test is green; no app code changed on this branch | **DONE** | see Tests; `git diff 5dc250a --stat -- app lib components` is empty |
| 9 | Drill: a no_saving bundle's card is hidden on the live home page and its reason shows in preview and on publish | **DONE** | `results-nosaving.json` (10 passed): no card live (before and after publish), the preview note and the inspector with the OQ-B sentence naming ₹2,020, BUNDLE_UNAVAILABLE naming the sum and still publishing; screenshots `nosaving-*`. The price was made to stop saving by cheaper products (sync writer), because raising a live bundle's price above its sum is refused by every writer |

## The run

Desktop Chrome 156 (headless), 1440 px, `next dev` on `localhost:6100`, sqld on 7100 to 7102, on `5dc250a` plus this item. One full run (`results-run.json`):

| Stage | Passed | Failed | Seconds |
|---|---|---|---|
| baseline | 12 | 0 | 47 |
| legacy | 9 | 0 | 33 |
| pick | 8 | 0 | 30 |
| create | 11 | 0 | 32 |
| states | 11 | 0 | 32 |
| nosaving | 10 | 0 | 44 |
| disabled | 10 | 0 | 42 |
| grid | 12 | 0 | 34 |
| cart | 9 | 0 | 27 |
| console | 5 | 0 | 30 |
| unknown | 5 | 0 | 15 |

Screenshots: 54, the largest 136 KB, all through `scripts/drill.js` `shoot` (at most 300 KB). The results folder is 2.4 MB with the masked captures.

## Findings (not this item's files; for the orchestrator)

- **P5D-1 (founder-facing, not a blocker: nothing a shopper sees).** The new editor (`components/admin/editor/PreviewPane.js`) has no Mobile (device) preview switch; the old Designer had one. Spec benchmark row 2 says "checked on the Mobile preview". The drill checked the founder's preview in a second tab at 375 instead. Owner decision.
- **P5D-2 (wording).** A deleted bundle's publish warning names it by its raw id ("“bun-1a92…”: This bundle was deleted…"), so the founder can't tell which bundle went. Part of P5-CHECKS' wording sign-off.
- **Observations, not findings:** in one card screenshot a component's photo tile is blank while the other loads (likely lazy loading at screenshot time; the bundle page shows both); the Next dev overlay shows "1 Issue" on the bundle page screenshot (dev only; shopper page errors are not collected by these drills). Both are worth a look in the owner's phone check.

## Tests

| What | Result |
|---|---|
| `pnpm test` (ports pinned to 6100 and 7100 to 7109) | 98 of 98 suites passed in 186.0 s (after the full drill run), exit 0 |
| `pnpm build` | passes (exit 0); its Turbopack warning is the existing `next.config.mjs` one (no app code changed) |
| `node scripts/drills/p5/lib.mjs --check` | 5 passed |

## Known limits

This item's:

- **Drilled on `5dc250a`, without P5-FIX2** (it ran beside this item). Run `pick,create,console` again after it merges.
- **Raw bytes are not comparable under `next dev`** (a per-request id and timings in the scripts), so the legacy and unknown comparisons use the P4 comparison's own mask, and the home render masks the recorder's freshly minted page section ids. A change a shopper could see (text, links, classes, order, images) still shows: the bite check caught a one-word change.
- **The pick time** includes this machine's `next dev` compiles and the drill's own waits and a second tab for the phone-width look. It is far under 2 minutes, but it is a machine's time, not a founder's.
- **The "Mobile preview"** is the founder's preview in Chrome at 375 wide, not a phone and not an editor switch (P5D-1).
- **The no-saving state was made by cheaper products, not by a higher price**: raising a live bundle's price above its sum is refused by every writer (deviation 3.10), which the drill shows.
- **The legacy store's bundle is the perf seed's own** (`gym-starter-kit`), so no phase 5 writer touched the legacy store.
- **Not drilled (NOT DONE, owner checks):** BUNDLE_OVERLAP in the publish panel; the 403 "You can't see bundles here." and "Ask an owner to create bundles." paths; `/bundles/<slug>` of a bundle stored with quantity 1.5 (only a raw write makes one); a full grid of 12 with Create a bundle; phone widths and Safari; staging; a real Shopify order.
- `scripts/drills/p5/seed-p5.mjs` was not written (seeding lives in `lib.mjs`).
- `baseline-legacy/snapshot.json` records the scratch path of the legacy snapshot so `legacy` can run after `baseline`; run both together.

Collected from every phase 5 packet (each packet has the full wording):

- **P5-SOURCES:** `data.bindingFailedCause` is non-enumerable (a spread or JSON copy drops it); argOf is per source now; removing a source turns stored body bindings to it into BINDING_INVALID; the empty() scan reads code, not values; seed bodies are not scanned. (Its "first non-limit argument" limit was fixed by P5-BLOCKS.)
- **P5-SETTING:** a picked bundle is indexed by id, a `/bundles/<slug>` link by slug, nothing joins them; only the id's shape is checked there; verb-first diff rows; `bundle_list` has no hard ceiling on a declared max; `entries` exemption (moved to its own named exemption by P5-BLOCKS).
- **P5-BUNDLEREAD:** getBundle and the bundle page don't check the offer sync; `bundlesByIds` throws without the bundles table; the engine still counts sets per entry and has no fixed BUNDLE order (OQ-D); stock depth; the UNIQUE(slug) race is covered by review only; `POST { create }` defaults `enable` to false; a database fault after a turned-on row is written leaves it on with no offer (reported, read as not_ready).
- **P5-HIDDEN:** home page only (pages drop bound kinds); the note looks like the rich-text block; plain-text reason, no link; a hidden note counts as "shown" for the empty-page message in preview only; `source_unknown` words win over a fault.
- **P5-BLOCKS:** the shared prefetch reads both arg names; the "pass the source's arguments" rule is stricter than asked; a hidden no-saving bundle that is also sold out shows only the no-saving sentence; a sold-out card still shows its price and "You save"; "Sold out" is CSS upper case; the test preview is a request scope set directly.
- **P5-CHECKS:** `/bundles/<slug>` links unchecked; the same bundle in two sections warns twice; no "pick another" action; warnings reflect the bundle at publish time; the not_ready line does not say "Currently unavailable".
- **P5-PANEL:** non-GID stores (the plain demo seed) can't make or check bundles; usedOnHome is null when the home lookup fails, reads the published home only, and counts only picked bundles (not `/bundles/<slug>` links); the live check posts on every keystroke; an edit of a live bundle that fails is refused by the server, not the form.
- **P5-EDITOR:** Disable and Delete with an unread home lookup go ahead without a confirm (CommercePanels.js, no owner); new words outside bundle-words.js; the form's cents and the cart's whole amount differ; the Dialog's page name is a guess before saving and its title outlives the form; a failed `ids=` read marks the list failed until the next focus; read on focus, not a timer; at most 8 search options; 403 unit-tested only; a stored `{ id, title }` grid row can't be re-picked in place; Create a bundle is offered on a full grid; a typed quantity of 0 shows as typed but saves as 1.
- **P5-FIX1:** the bundle page's no-saving case now says "This bundle isn't available right now."; a deleted product on the bundle page still says "A component is out of stock"; the deleted-product note only shows for a shown bundle; getBundle's `state` only when unbuyable; reasons now in product order.
- **Plan section 5:** product rail still hides silently in preview (PV-09); a bundle the founder can't list can be removed but not replaced; a null bundle currency falls back to INR in formatMoney.

## From review

(Empty until the review.)

## Owner checks

All are in `MANUAL-CHECKS.md`, "Phase 5, batch 3":

- The one-list owner steps for phase 5 (plan section 4: staging with a documents-mode tenant; phone and Safari; one real test order through a bundle block on staging, cancelled, with the discount line on the Shopify order; sign-off of deviations 3.5, 3.10, 3.11, 3.3; bundles not versioned; inline create live at once; the exclusive coupon; stock depth; duplicate-item and overlapping bundles; the non-atomic add), the batch 0, 1 and 2 review items, the usedOnHome confirm owner, and the CI sqld download.
- Findings P5D-1 and P5D-2.
- The paths not drilled (above).
- Optional: run the drills on your Mac.

## Commands

```
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 P5_DRILL_SCRATCH=<dir> node scripts/drills/p5/run.mjs
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p5/run.mjs pick,create,console
node scripts/drills/p5/lib.mjs --check
TEST_PUBLISH_PORTS=7100,7101 TEST_PUBLISH_SERVICE_PORTS=7102,7103 TEST_PUBLISH_UNDO_PORTS=7104 \
  TEST_PRODUCT_CONTENT_PORTS=7105,7106 TEST_MIGRATE_MAP_SQLD_PORT=7107 MIGRATE_DOCUMENTS_TEST_PORTS=7108,7109 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6100 pnpm test
pnpm build
```
