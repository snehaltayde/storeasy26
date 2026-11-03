# P1-DRILLS-C: desktop Chrome drills for batch C, on the design harness (edge runtime)

Branch `cms/p1-drills-c`, cut from `a22d1fb` (the integrated `cms/phase-1` head). Nothing in `app/`, `lib/` or `components/` is changed by this branch (`git diff a22d1fb --stat -- app lib components` prints nothing). Every break and every state change was made in this checkout's local harness databases, then undone or wiped by a re-seed.

This is the drill agent's own report. Reviewers should re-read the scripts and look at the screenshots.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Not applicable. This item adds drill scripts and evidence only: `scripts/drills/p1c/`, and files named `c-*` or `results-c-*` under `docs/cms-reviews/drills/<item>/` |
| Locally tested | Every drill below ran on this Mac against the design harness. The storefront ran on the edge runtime under `next dev`, with local `sqld` |
| Browser verified | Desktop Chrome 156.0.8078.80, headless, through `playwright-core` (the P1-HARNESS runner). **Not Safari, not a phone** |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing was pushed, merged or deployed. No migration ran against any database except the harness's own local `sqld` |

## How the drills ran

- **Harness.** Seeded with `DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js seed`, then started with `DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js` (Next on 3231, `sqld` on 18320 to 18322). The harness was seeded fresh five times:
  1. at the start;
  2. before the plain `drill:edge` and `drill:smoke` runs;
  3. with `--fixture perf` for the PERF-04 drills;
  4. plain again for the last hover run;
  5. plain at the end.
- **Runner.** `DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs <journey> [part]` is a copy of the P1-DRILLS runner that loads journeys from `scripts/drills/p1c/`.
  - It signs in through the real form once per run and reuses that session, because the sign-in allows 5 tries a minute.
  - Each part writes `results-<part>.json` beside its screenshots.
  - Every part here is named `c-…`, so nothing from the batch A, B or C runs is overwritten.
- **`drill:edge` and `drill:smoke`** write into the committed `drills/P1-HARNESS/` and `drills/smoke/` folders. Each run's `results.json` and console log were copied into this batch's folders, and the committed folders were put back with `git checkout`.
- **Database edits** went through `scripts/drills/p1/db.mjs`, which only talks to `http://127.0.0.1:<port>` read from this checkout's `.design-data/harness.pid.json`.
- **Switching the live look for the TOK drills.** Most drills published a copy of the live release with another brand and theme straight into the local tenant database, using the TOK journey's own `publishCopy`, and pointed the live release back afterwards. The drills marked "through the screens" used the console instead.
- **Test orders** used `drill@design.test` and `p1c-themes-…@design.test` on the harness. Email, Razorpay and Shopify keys are blank there, so nothing left this Mac.
- **Screenshots.** `drill.shoot` saves at most 720 px wide and 300 KB. The TOK sets are at most 360 px wide and 30 to 60 KB. New evidence per item, screenshots and JSON included: FIX-C 0.36 MB, PV-08 0.19 MB, PERF-04 0.39 MB, TOK-01-02 1.3 MB, GEN-03 0.16 MB, DOC-04 0.07 MB, harness 0.35 MB.

## Results

Pass means every check in that drill passed. Each part's checks and notes are in its `results-c-<part>.json`.

### Batch C · FIX-C (`drills/FIX-C/`, `scripts/drills/p1c/fixc-c.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| Brand in the Designer preview right after Save brand | **Pass** (5/5) | Changed the accent from `#0d9488` to `#7c3aed` and pressed Save brand (200). Opened the Designer at once. 1.4 s after the save, the frame's `--accent-500` was `#7c3aed` on its first load. Its accent button, "Shop night routine", was painted `rgb(158,109,242)`, the new accent's 400 step: the hero's accent role uses a lighter step on a dark hero. A signed-out shopper still had the published `#0d9488`. The accent was put back afterwards. The script's first run checked that the button used the exact accent and failed on that 400 step; the check was corrected to "a step of the new accent's ladder". | [c-brand-preview-designer](drills/FIX-C/c-brand-preview-designer.png) |
| Theme kit, then Publishing at once | **Pass** (7/7) | Published so there was nothing to publish (Publish now disabled), then Theme → Apply Pulse (200). On Publishing straight away: Publish now was enabled and "Theme" was in the change list. Publish now answered 200 with the toast "Published — live now.", and the live release's kit is `pulse` | [c-theme-publishing-at-once](drills/FIX-C/c-theme-publishing-at-once.png), [c-theme-published](drills/FIX-C/c-theme-published.png) |
| Store name (identity) at once | **Pass** (4/4) | Settings → Store name "Design Demo Drill …" → Save settings (200). The first reload showed the new name in the field and in the console sidebar. The Designer's console header showed it too. The name was put back afterwards | [c-identity-settings-reload](drills/FIX-C/c-identity-settings-reload.png), [c-identity-designer](drills/FIX-C/c-identity-designer.png) |
| Cart drawer against checkout within 30 s of a rate change | **Fail** (5 passed, 1 failed). See finding 1 | First, a shopper warmed the caches with one Radiance Glow Serum (₹1,299) in the cart. Then the rates changed from flat ₹79, free over ₹999, COD fee ₹49 to flat ₹149, free over ₹4,999, COD fee ₹59 (Save settings 200). **Within 30 s** the shopper's screens all agreed with each other, but on the **old** rates: the drawer read Shipping FREE and Total ₹1,299 (1.9 s), the review step read "Shipping (incl. COD fee) ₹49" and Total ₹1,348 (3.5 s), and the payment step read "Place order · ₹1,348" (4.0 s). Placing the order at 4.2 s stored **total ₹1,507, shipping ₹208** (the new rates), and the confirmation page reads Total ₹1,507. **After 35 s** every screen used the new rates: drawer ₹149 and ₹1,448, review ₹208 and ₹1,507, payment ₹1,507. The same happened in two runs. The rates were put back afterwards | [c-rates-payment-within-30s](drills/FIX-C/c-rates-payment-within-30s.png), [c-rates-confirmation-within-30s](drills/FIX-C/c-rates-confirmation-within-30s.png), [c-rates-payment-after-35s](drills/FIX-C/c-rates-payment-after-35s.png) |
| A store from before page versions | **Pass** (5/5) | `cms_pages` was renamed to `cms_pages_data` and replaced by a view of every column except `revision`. Pages answered 200 and listed the pages. The page editor for `shipping` answered 200 and opened "Shipping policy", with no error screen and no 404. The table was put back afterwards | [c-oldversions-pages-list](drills/FIX-C/c-oldversions-pages-list.png), [c-oldversions-page-editor](drills/FIX-C/c-oldversions-page-editor.png) |

### Batch C · PV-08 (`drills/PV-08/`, `scripts/drills/p1c/pv08c.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| A real lapse, not a dropped cookie | **Pass** (12/12) | **Setup.** Signed in. The browser's `_unit` was in variant b. The Designer was opened with the hero test running at 15:40:55 UTC and showed the saved title. The preview cookie expired at 16:40:52.<br>**The wait.** The Designer was left untouched until 16:42:22. The browser had dropped `_preview` by itself, `_admin` was still there, and the status still read "Preview shows your last save".<br>**After the lapse.** Typed the hero title "Lapse drill 16.42.22" and pressed Save (200), then Refresh preview twice. The frame showed the live hero "Winter repair, started." with no Draft preview bar and no note, never variant b's "Visibly brighter in 14 days". The status read "Connecting…" (PV-04).<br>**Counting.** No `POST /api/exp` in the whole session, and no exposure row for the unit. The hero title was put back afterwards | [c-lapse-0-start](drills/PV-08/c-lapse-0-start.png), [c-lapse-1-after-hour-untouched](drills/PV-08/c-lapse-1-after-hour-untouched.png), [c-lapse-2-saved-refreshed](drills/PV-08/c-lapse-2-saved-refreshed.png) |
| Signing out returns the browser to being a shopper | **Pass** (12/12) | **Setup.** A sign-in of its own; the unit was in variant b. The Designer was open, with a preview cookie. Sign out was pressed from the Designer's console menu: `/api/admin/logout` answered 200 and `_admin` was gone, but `_preview` stayed.<br>**Before Exit preview.** `/` showed the Draft preview bar and the saved title, with no `/api/exp` and no exposure row.<br>**After Exit preview.** The cookie was cleared and the browser landed on `/` with variant b's title. One `POST /api/exp` was answered `{"ok":true,"recorded":true}`, and there is one exposure row, variant b. A second visit to `/` sent no further ping | [c-signout-1-before-exit-preview](drills/PV-08/c-signout-1-before-exit-preview.png), [c-signout-2-after-exit-preview](drills/PV-08/c-signout-2-after-exit-preview.png) |

### Batch C · PERF-04 (`drills/PERF-04/`, `scripts/drills/p1c/perf04c.mjs`), harness seeded with `--fixture perf`, `next dev`

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| Console with a realistic store | **Pass** (12/12) | The local DB held 400 products, 30 collections, 85 pages (60 journal posts) and 32 media. No screen showed an error page. The second load of each, in ms (TTFB / load event / network quiet):<br>- Catalog: 704 / 1,059 / 1,577<br>- Pages: 775 / 822 / 1,422<br>- Media: 608 / 637 / 1,200<br>- Offers: 625 / 651 / 1,213<br>- Publishing: 1,547 / 2,109 / 2,613<br>What each screen showed:<br>- Catalog showed its first 30 products.<br>- Catalog has no collections list. It offers all 30 collections in the handle field's suggestions, and in the "Choose…" picker after one "Load more" (25 on the first page; all 30 listed 2.3 s after the click).<br>- Pages listed all 85, the 60 journal posts included.<br>- Media showed 32 thumbnails with none broken.<br>- Offers listed all 12.<br>- Publishing loaded.<br>First loads are in the results. These are `next dev` times on this Mac, not production | [c-console-catalog](drills/PERF-04/c-console-catalog.png), [c-console-catalog-collection-picker](drills/PERF-04/c-console-catalog-collection-picker.png), [c-console-pages](drills/PERF-04/c-console-pages.png), [c-console-media](drills/PERF-04/c-console-media.png), [c-console-offers](drills/PERF-04/c-console-offers.png), [c-console-publishing](drills/PERF-04/c-console-publishing.png) |
| Finding 1 under `next dev` | **Fail: the photos don't show in dev either** (3 passed, 1 failed). See finding 3 | `/products/micronised-creatine-12` answered 200, but **0 of 10 images were drawn**. Every `/_next/image?url=%2Fapi%2Fmedia%2F…` request answered 400. The content page `/policies/terms-of-service`, which has an image section, drew its 1 image: that section loads `/api/media/med_…` directly (200, `image/webp`), not through `next/image`. So the fault is not `next start` only. It hits every library image shown through `next/image` | [c-images-dev-product](drills/PERF-04/c-images-dev-product.png), [c-images-dev-content-page](drills/PERF-04/c-images-dev-content-page.png) |
| Existing drills on the perf fixture | **Recorded: differs from the plain seed** | `drill:smoke`: 31 passed, 0 failed, the same as the plain seed.<br>`drill:edge`: 132 passed, 6 failed, and the drill stopped early. The 6 failures:<br>- the home page at 1440, 768 and 375: "shows one of …". The drill expects the demo's live hero words, which the fixture's home page doesn't carry;<br>- "no console errors" and "no failed requests": the `/_next/image` 400s of finding 1;<br>- the drill stopped in the product page designer. Its picker didn't offer "Radiance Glow Serum 30ml" within 30 s, because the demo product isn't on the first page of 400 products.<br>So the product and collection designer checks and the maintenance section **did not run** on the fixture. The Designer preview checks passed: draft title, no exposure | `c-smoke-perf.json` and `.log`, `c-edge-perf.json` and `.log` |

### Batch C · TOK-01/02 (`drills/TOK-01-02/`, `scripts/drills/p1c/tokc.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| No brand on Glow with a two-word logo | **Pass** (7/7) | Logo "Design" / "Demo" was saved through Settings, then made live with no brand and the Glow kit. At 375 and 1440 the header wordmark's "Demo" measures **`#4d7c0f` on `#fffbf7`, 4.85:1**, with kit `glow-1`. The logo and the live release were put back afterwards | [header-375](drills/TOK-01-02/c-glow-twoword/header-375.png), [header-1440](drills/TOK-01-02/c-glow-twoword/header-1440.png) |
| Reset straight after a save, through the screens | **Pass** (8/8) | First, the store's own colours were published (200). Then Brand → "Reset to platform default" → Reset (200). Going straight to Publishing, 1.3 s after Reset there was no "Fix before publishing" and Publish now was enabled. Publish now answered 200, and the live release has no brand. No 422 at any point. The brand and the live release were put back afterwards | [c-reset-publishing](drills/TOK-01-02/c-reset-publishing.png), [c-reset-published](drills/TOK-01-02/c-reset-published.png) |
| The Pulse kit's own brand, published | **Fail** (4 passed, 2 failed). See finding 2 | Theme → Pulse with its brand (`#84cc16` / `#ffffff` / `#0a0a0b`), then publish (200).<br>**Measured:**<br>- the home page's "View all →" link: `#456c09` on white, 6.17:1;<br>- **the CMS page's links "Home" and "Contact us": `#9f9fa9` on white, 2.62:1**. That is the platform default look's faint grey, the same pixels as with no brand;<br>- footer links: 4.62:1.<br>The harness logo is one word, so the footer and checkout wordmarks have no accent part to measure.<br>**Pixels.** Compared with the same pages and no brand on Pulse, **no page is pixel-equal**. Every page differs in its lime surfaces: the announcement bar and other lime-400 areas go from `#a3e635` to `#a8eb43` (10.6k to 61k pixels a page, in the top 58 px on most pages, more on home and product). Links go from `#4d7c0f` to `#456c09` (the documented correction) | [home-1440](drills/TOK-01-02/c-pulse-brand/home-1440.png), `c-pulse-brand/pixel-diff.json`, `c-pulse-brand/diff-*.png` |
| The rest of the storefront on both test themes | **Fail on one mark only** (81 passed, 4 failed). See finding 4 | Light (Glow) and dark (Pulse), at 375 and 1440, every text and icon pair measured. The pages: account sign-in, account orders, an order page, the order confirmation (with its `?t=` token), wishlist (with the saved product listed), a quiz and a bundle (both inserted into the local DB; the seed has neither), the shipping policy, and checkout's review and payment steps. Between 27 and 55 pairs a page. **All pass except the wishlist's missing-image "?" mark: `#777471` on `#f5f3ee`, 4.19:1 (light) and `#797d83` on `#151921`, 4.25:1 (dark)**. The disabled "Pay online" option was exempt, its explanation line included ("Online payment isn't available for this store right now.", 2.0 to 2.4:1) | `c-rest-themes/` (40 shots), `c-rest-themes/contrast.json` |
| Hover and focus states on both test themes | **Pass** (12/12) | Hovered text, light / dark:<br>- the dark button, checkout's "Continue to review" (address filled): 12.15:1 / 13.53:1;<br>- Add to cart and the hero button, which are accent-filled on both test themes: 8.96:1 / 14.11:1;<br>- a footer link: 16.48:1 / 16.83:1;<br>- the "In stock" filter: 8.38:1 / 10.6:1.<br>The first field reached by Tab is the header search box. Typed text there: 17.2:1 / 17.51:1 | `c-hover-focus/`, `c-hover-focus/contrast.json` |
| A dark brand on the Glow kit | **Pass** (10/10) | Brand `#f59e0b` / `#0b0f17` / `#f1f5f9` on Glow. Home (65 to 66 pairs) and product (45 to 46) at 375 and 1440: every pair passes, the header and the hero included | `c-dark-glow/`, `c-dark-glow/contrast.json` |
| A store that has never published | **Pass** (5/5) | `release_state.live_release_id` was set to NULL locally. Saved background `#0a0a0b` and text `#18181b` through Brand: 200, with the warning "Product titles, prices and body text: #18181b on #0a0a0b has a contrast of 1.12 to 1 … Try text colour #80808e."<br>- Brand shows "Hard to read" after a reload.<br>- A signed-out shopper gets a white page with `#0a0a0b` text (the default look).<br>- The founder's Designer preview shows the `#0a0a0b` page with `#18181b` text (the saved colours).<br>The brand and the live release were put back afterwards | [c-never-published-brand-warning](drills/TOK-01-02/c-never-published-brand-warning.png), [shopper-1440](drills/TOK-01-02/c-never-published/shopper-1440.png), [c-never-published-designer](drills/TOK-01-02/c-never-published-designer.png) |
| `drill:edge` on `next dev` | **Pass** | On the plain seed: **151 passed, 0 failed, 4 known (finding 5)**, and no finding 6 marker anywhere in the run | `drills/harness/c-edge-plain.json` and `.log` |
| Checkout review and payment steps at 320 to 414 | **Pass** (15/15) | One item in the cart. The address, review and payment steps at 320, 360, 375, 390 and 414 were each exactly as wide as the window | `c-checkout-steps/` (15 shots), `c-checkout-steps/widths.json` |

### Batch B re-runs (the failures batch C was meant to fix)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| GEN-03 drill 6: Settings save, then reload at once (`gen03c.mjs`, the FIX-C journey's `settings` part) | **Pass** (6/6) | Starter rates showed with the notice. Saved flat ₹79, free over ₹1,999, COD fee ₹49 (200). **A reload at once** showed the saved rates and no notice, and so did four more reloads and a new tab. With the rates then removed in the control plane, the next reload showed the starter rates | [settings-reload-at-once](drills/GEN-03/settings-reload-at-once.png), [settings-after-control-plane-change](drills/GEN-03/settings-after-control-plane-change.png) |
| GEN-03 drill 6: Brand save, then Publishing at once (`brand` part) | **Pass** (7/7) | Nothing to publish before. Save brand (200). On Publishing at once: Publish now was enabled and the change list named the brand. Publish now answered **200, not 409**, with the toast "Published — live now."; the live release holds the new accent | [brand-publishing-at-once](drills/GEN-03/brand-publishing-at-once.png), [brand-published](drills/GEN-03/brand-published.png) |
| P1-HARNESS finding 1: Designer hero edits with `hero-promise` running (`harnessc.mjs`, the PV-08 journey's `designer` part) | **Pass** (19/19) | The founder's browser was in variant b. The preview showed the saved title, and the same title on five reloads. It carried the note naming "Hero promise test". Typed words showed before Save, and the saved words after Save (200). **No `POST /api/exp` and no exposure row.** Every preview document answered 200 with `x-edge-runtime: 1`. "See the test" opened a new tab and kept the unsaved title | [designer-preview-note](drills/harness/designer-preview-note.png), [designer-typed](drills/harness/designer-typed.png), [designer-saved](drills/harness/designer-saved.png) |
| P1-HARNESS finding 6: checkout at 320, 360, 375, 390 and 414 (`harnessc.mjs`, the TOK journey's `width` part) | **Pass** (10/10) | At every width the page was exactly as wide as the window. The step row ends at 286 px and "Payment" is fully visible (it was 398 px wide at 360 to 390 in batch B) | `drills/harness/checkout-width/c-*.png`, `c.json` |
| DOC-04 extra: a "no such column" read failure (`doc04c.mjs`, the FIX-C journey's `missingcol` part) | **Pass** (7/7) | `cms_pages` became a view naming `nosuch_col`.<br>- A Designer save answered **503**, and the client's second look answered 503 too. The banner read "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes.", and the hero really was saved.<br>- The page editor answered 200 with **"This page hit an error"** and Try again, not a 404.<br>- With the table back, the editor opened the page.<br>The banner's title still reads "Couldn't save the hero" above that body, the contradiction the FIX-C review noted | [missingcol-designer-saved-refresh-failed](drills/DOC-04/missingcol-designer-saved-refresh-failed.png), [missingcol-page-editor-error](drills/DOC-04/missingcol-page-editor-error.png) |

### `drill:edge` and `drill:smoke`, once each on the plain seed

| Run | Result | Notes |
|---|---|---|
| `DESIGN_PORT=3231 node scripts/drill.js harness-edge` | **151 passed, 0 failed, 4 known** | The 4 known are finding 5: the maintenance page's raw HTML and RSC still carry store content (home "Shop bestsellers" ×2; product name ×24 and "1299" ×11; policy text ×2; RSC product name ×18). The Designer preview's hero title was the draft "Winter repair, started.", with no exposures from the preview. The maintenance message is still 1.48:1 (not checked as a drill here; the maintenance branch fixes it) |
| `DESIGN_PORT=3231 node scripts/drill.js smoke` | **31 passed, 0 failed** | The cookie banner still covers the drawer's "Checkout →" until answered (P1-HARNESS finding 2, a note) |

## Findings for the owner

Each is a failed drill, with the steps to see it. None is fixed here.

1. **For up to 30 seconds after a shipping-rate change, checkout shows one total and the order is stored with another.**
   - Steps:
     1. On the harness, a shopper puts Radiance Glow Serum (₹1,299) in the cart and opens checkout once, which warms the caches.
     2. In the console, change the rates from flat ₹79, free over ₹999, COD fee ₹49 to flat ₹149, free over ₹4,999, COD fee ₹59, and Save settings.
     3. Within a few seconds, the shopper opens the drawer, goes through checkout to payment, picks Cash on Delivery and places the order.
   - Seen: the drawer, the review and the payment step all show the old rates ("Place order · ₹1,348"). The stored order and the confirmation page say **₹1,507**, with shipping ₹208.
   - Expected: the amount on the Place order button is the amount stored.
   - The screens agree with each other. Only the server's charge differs.
   - Cause, read but not proven: the checkout page (edge) reads the store's settings through the 30-second cache, while `/api/checkout` read the new row. FIX-C's packet had this case as "not proven safe".
   - After 35 seconds everything agrees on ₹1,507. With a cash order the shopper is told a different amount on the confirmation page. With an online payment, the amount sent to Razorpay would be the server's, which this harness can't show.
   - Evidence: `drills/FIX-C/results-c-rates.json`, [payment step](drills/FIX-C/c-rates-payment-within-30s.png), [confirmation](drills/FIX-C/c-rates-confirmation-within-30s.png).
2. **The Pulse kit's own brand is not pixel-equal to the no-brand look, and two links on content pages are 2.62:1.**
   - Steps: Theme → apply Pulse with its brand colours ticked → publish. Compare with the same pages, no brand, Pulse kit.
   - Seen: every lime surface (the announcement bar, the hero highlight, badges) moves from `#a3e635` to `#a8eb43`. The brand's own accent ladder has a different 400 step from the platform's built-in lime. A shopper can't see that difference, but the drill's "equal to the no-brand baseline" fails.
   - Links move to `#456c09`, as documented.
   - Separately, the shipping policy's "Home" and "Contact us" links are `#9f9fa9` on white, **2.62:1**, in both looks. That is the default look's faint grey, an owner decision already listed by TOK.
   - Evidence: `drills/TOK-01-02/c-pulse-brand/pixel-diff.json`.
3. **Library photos through `next/image` are broken under `next dev` too (PERF-04 finding 1 is not `next start` only).**
   - Steps: `node scripts/dev-design.js seed --fixture perf`, start the harness, open `/products/micronised-creatine-12`.
   - Seen: every `/_next/image?url=/api/media/…` answers 400, and 0 of 10 photos show. A content page's image section shows its photo, because it loads `/api/media/…` directly.
   - This also makes `drill:edge` fail its "no console errors" and "no failed requests" checks on the perf fixture.
4. **The wishlist's missing-image "?" is 4.19:1 (light test theme) and 4.25:1 (dark).**
   - Steps: either test theme, save a product with no photo for later, open `/wishlist`.
   - This is the TOK packet's known `PAIRS` gap ("marks on the sunken surface"). It is now measured in the browser on both themes.
5. **`drill:edge` can't run to the end on the perf fixture.** The product page designer's picker doesn't show the demo product among 400, so the drill stops before the collection designer and the maintenance section. Its home checks also expect the demo's hero words. A drill change, not a product bug.
6. **Notes, not failures:**
   - The disabled "Pay online" option's own explanation, "Online payment isn't available for this store right now.", is 2.0 to 2.4:1 on both themes. It is exempt as part of a disabled control, but a shopper needs to read it.
   - The header search box's focus shows only as a border colour change (outline none) on both test themes.

## Drills not run, and why

| Item | Drill | Why |
|---|---|---|
| PV-08 | After `claude/gallant-keller-7d3213` merges: `run.mjs pv08 conversion,lapsed-order` and `pnpm test:preview-experiments` | The branch is not merged into `a22d1fb`, and the brief forbids merging it here |
| PV-08 | After `claude/musing-williamson-4c86b3` merges: `run.mjs pv08` and `drill:edge` | Not merged, for the same reason. `drill:edge` on `a22d1fb` was run (above); the finding 5 checks are still known |
| PERF-04 | After both branches merge: rebuild, `node scripts/perf-report.js http --build`, `run.mjs perf04`, and commit a new dated baseline | Needs both merges, which this branch must not do. The new baseline belongs on the merged code |
| PERF-04 | Page weight with images (transferred bytes in Chrome per measured page) | Needs finding 1 fixed or real remote photos. Finding 1 also breaks the photos under `next dev` (finding 3 above), so there is no build where photos load through `next/image` |
| TOK-01/02 | After the maintenance branch merges: `pnpm test:tokens` and `pnpm test:maintenance` | Not merged. The merge needs the `curtainPalette` change described in the TOK packet's merge notes |
| P1-HARNESS | The maintenance page on a dark brand | Skipped as the brief says: the maintenance branch fixes it and is not merged |

## Merge care

This branch changes no product code, so neither `claude/gallant-keller-7d3213` nor `claude/musing-williamson-4c86b3` will conflict with it. Two things to know:
- `scripts/drills/p1c/harnessc.mjs`, `gen03c.mjs` and `doc04c.mjs` reuse parts from `scripts/drills/p1/tok.mjs`, `pv08.mjs` and `fixc.mjs`. `tokc.mjs` imports the TOK journey's helpers. A later change to those files changes these re-runs too.
- After the maintenance branch merges, `drill:edge`'s finding 5 checks should pass. The perf-fixture limits in finding 5 above stay.

## Known limits

- **Desktop Chrome, headless, on macOS only.** No Safari, no Firefox, no phone, no real touch.
- **Local only:** Next's edge sandbox under `next dev`, with local `sqld`. No production build ran in this batch, and nothing ran on Vercel or Turso.
- **One harness process.** FIX-C's fix is about many server instances. These drills show the founder's journey on one process; the harness's routes run as separate module instances, which is what made finding 1 visible.
- **The rate drill's mismatch depends on cache timing.** It showed in both runs, with the shopper's checkout read 2 to 4 s after the save. The online-payment path was not exercised (no Razorpay keys on the harness).
- **Live looks for most TOK drills were switched in the database**, by publishing a copy of the live release. That is not through Publishing. The reset, Pulse-brand and never-published drills went through the console, and the two-word-logo drill set the logo through Settings.
- **The never-published state was made by setting `release_state.live_release_id` to NULL** on a store that had releases. A store that truly never published also has no release rows.
- **The quiz and the bundle were inserted straight into the local DB** with plain content. The seed has neither.
- **The contrast audit's exemption for disabled controls** was widened in `tokc.mjs` to the `<label>` around a disabled radio, by marking it `aria-disabled` before measuring. The wording it exempted is listed in the notes and in finding 6.
- **The harness logo is one word**, so the Pulse-brand footer and checkout wordmarks had no accent part to measure. The two-word logo was used only for the Glow drill.
- **The PV-08 lapse drill's live hero equalled the saved draft title** ("Winter repair, started."), because earlier drills on the same seed had published the drafts. The check that matters held: the frame showed neither the typed title nor variant b's.
- **The PERF-04 console times are `next dev`** on this Mac, after Turbopack's first compile. They are not production numbers.
- **`results-c-*.json` and the logs hold timestamps and generated ids**, so a re-run changes them. A part that was re-run after a script fix keeps only its last run's results: FIX-C brand-preview and rates, TOK rest-themes, hover-focus and pulse-brand, PV-08 sign-out, PERF-04 console. Each fix is described in its row.

## Files

- `scripts/drills/p1c/`:
  - `run.mjs`, the runner;
  - `summary.mjs`, which prints one line per `results-c-*.json`;
  - one journey per item: `fixc-c.mjs` (FIX-C), `pv08c.mjs` (PV-08), `perf04c.mjs` (PERF-04), `tokc.mjs` (TOK-01/02);
  - the batch B re-runs: `gen03c.mjs`, `doc04c.mjs`, `harnessc.mjs`.
- `docs/cms-reviews/drills/<item>/`: `c-*` screenshots and `results-c-*.json` in FIX-C, PV-08, PERF-04, TOK-01-02 (sets in `c-*/` subfolders), GEN-03, DOC-04 and harness.
- `drills/harness/c-edge-plain.*` and `c-smoke-plain.*`: the plain-seed `drill:edge` and `drill:smoke`.
- `drills/PERF-04/c-edge-perf.*` and `c-smoke-perf.*`: the same two drills on the perf fixture.

## Commands

```
git checkout -B cms/p1-drills-c a22d1fb
pnpm install --frozen-lockfile --prefer-offline
DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js seed
DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js             # left running
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs pv08c c-real-lapse            # runs about 62 minutes; nothing else may edit the hero meanwhile
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs fixc-c c-brand-preview,c-identity,c-oldversions,c-theme,c-rates
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs gen03c
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs tokc c-checkout-steps,c-glow-twoword,c-reset-screens,c-dark-glow,c-never-published,c-hover-focus,c-rest-themes,c-pulse-brand
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs pv08c c-signout
DESIGN_PORT=3231 TOK_LABEL=c node scripts/drills/p1c/run.mjs harnessc c-checkout-width
# after the lapse drill ends (both of these save the hero):
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs doc04c
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs harnessc c-designer
# stop, re-seed plain, start:
DESIGN_PORT=3231 node scripts/drill.js harness-edge
DESIGN_PORT=3231 node scripts/drill.js smoke
# stop, then:
DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js seed --fixture perf
DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js
DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs perf04c
DESIGN_PORT=3231 node scripts/drill.js smoke
DESIGN_PORT=3231 node scripts/drill.js harness-edge
node scripts/drills/p1c/summary.mjs
```

Every server started for these drills was stopped by its own PID at the end: the harness launcher, which stops its Next and three `sqld`. Ports 3231 and 18320 to 18329 were free afterwards. Each runner closed its own Chrome.
