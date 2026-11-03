# P1-DRILLS: desktop Chrome drills for batch A and batch B, on the design harness (edge runtime)

Branch `cms/p1-drills`, cut from `c513d27` (the integrated `cms/phase-1` head). Nothing in `app/`, `lib/` or `components/` is changed by this branch: two drills put a temporary line into an app file and took it out again with `git checkout` (ED-01 B7 and B8, GEN-03 drill 7). `git diff c513d27 --stat -- app lib components` prints nothing.

This is the drill agent's own report. Reviewers should re-read the scripts and look at the screenshots.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Not applicable: this item adds drill scripts and evidence only (`scripts/drills/p1/`, `docs/cms-reviews/drills/<item>/`) |
| Locally tested | Every drill below ran on this Mac against the design harness, on the edge runtime, with no runtime flip |
| Browser verified | Desktop Chrome 156.0.8078.80, headless, through `playwright-core` (the P1-HARNESS runner). **Not Safari, not a phone** |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No migration ran against a hosted database |

## How the drills ran

- Harness: `DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/dev-design.js seed`, then `DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/dev-design.js` (Next on 3081, `sqld` on 18130 to 18132). Seeded fresh at the start, re-seeded before the production run (after the DOC-04 breaks), re-seeded after the destructive drills (deleted products, 2,000 extra products) and before MIG-OVL D2, and re-seeded once more at the end.
- "The local `.design-tenant.db`" in the drill texts is now `.design-data/tenant.sqld` (P1-HARNESS moved the harness to local `sqld`). Every database edit in a drill went through `scripts/drills/p1/db.mjs`, which only talks to `http://127.0.0.1:<port>` read from this checkout's `.design-data/harness.pid.json`.
- Runner: `DESIGN_PORT=3081 node scripts/drills/p1/run.mjs <journey> [part]`. It uses the P1-HARNESS `Drill` helpers (`scripts/drill.js`), attaches only to this checkout's harness, and writes `results-<part>.json` next to the screenshots. The console's sign-in allows 5 tries a minute, so the runner signs in through the real form once per run and reuses that session's cookies.
- Screenshots are PNGs scaled to at most 720 wide and at most 300KB each (the largest folder, ED-01, is about 2MB with the builder's own files).
- Test orders used `drill@design.test` and `drill-account@design.test` (the harness blanks email, Razorpay and Shopify keys, so nothing left this Mac).

## Results

Pass means every check in that drill passed. Evidence is the screenshot(s) and the `results-<part>.json` in the item's folder.

### Batch B · DOC-04 (`drills/DOC-04/`, `scripts/drills/p1/doc04.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| Saved, but the refresh failed, in an editor | **Pass** | `cms_pages` renamed to `cms_pages_data`, view `cms_pages` with `json_extract('not json','$') AS title`. Changed the hero title in the Designer, Save: `PUT /api/admin/storefront` 503, the client's second look `GET` 503. Banner: "Couldn't save the hero" / "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes." No conflict banner, no validation list. `cms_blocks` holds the new title, so the save really went through. (A third `PUT` answered 200; it is the preview update, not a second save) | [B-designer-saved-refresh-failed](drills/DOC-04/B-designer-saved-refresh-failed.png), `results-savefail.json` |
| Publish, then the panel's refresh fails | **Pass, with a changed break** | The drill's break as written does nothing on the harness: `cms_approvals` is empty, so a view over it never evaluates the bad expression and every read succeeds. The first run therefore published normally, with no notice. The view was changed to fail on every read even with no rows (`… UNION ALL SELECT NULL, json_extract('not json','$'), NULL, json_extract('not json','$'), NULL`, failing on `draft_hash` too, because the panel's read filters on it). Then: Publish now → confirm: toast "Published — live now.", warning banner "Published. Your live store has the new version, but this page couldn't refresh, so it may show old details. Reload it.", no red banner. After restoring the table and reloading, History's first row is the new release, Live (`release_state` moved to it) | [B-publish-then-refresh-failed](drills/DOC-04/B-publish-then-refresh-failed.png), [B-publish-history-live](drills/DOC-04/B-publish-history-live.png), `results-publishfail.json` |
| Page editor load with page reads failing | **Pass** | `/admin/storefront/pages/shipping` with the broken view: "This page hit an error" with Retry, answer 200 (the error screen), not a 404, not a default page | [B-page-editor-reads-failing](drills/DOC-04/B-page-editor-reads-failing.png) |
| After re-seeding and reloading | **Pass** | `cms_pages` is a table again, the Designer and the page editor open | [B-after-reseed-page-editor](drills/DOC-04/B-after-reseed-page-editor.png), `results-after.json` |
| Navigation editor wording | **Pass** | Custom header menu with rows "Shop" /collections, (empty label) /collections/serums, "Night routine": `PUT` 422, banner "Fix these to save / Header menu, item 2: needs a label and a path/URL". Row 2 is the empty one on screen | [B-nav-empty-label](drills/DOC-04/B-nav-empty-label.png) |
| Product page accordions wording | **Pass** | Two accordions, the second with an empty title: "Product page accordions, accordion 2: needs a title" | [B-pdp-accordion-2](drills/DOC-04/B-pdp-accordion-2.png) |
| Home editor on this commit | **Pass** | Blank Banner / CTA as row 3, Save: "Section 3 (Banner / CTA): needs a title or text". Move up: "Section 2 (Banner / CTA): …", row 2 is the banner, and no request went out | [B-home-section-3](drills/DOC-04/B-home-section-3.png), [B-home-after-move-up](drills/DOC-04/B-home-after-move-up.png) |
| Storefront overview | **Pass** | Saved a banner "Monsoon sale" linking to `/collections/not-a-collection` (200). `/admin/storefront`: "Fix before publishing / Section 3 (Banner / CTA): "/collections/not-a-collection" points at a collection that doesn't exist in the catalog". The Designer's tree reads Hero, Announcement bar, Shop by collection, New arrivals, Monsoon sale: the banner is the third homepage section | [B-overview-fix-before-publishing](drills/DOC-04/B-overview-fix-before-publishing.png), [B-overview-designer-tree](drills/DOC-04/B-overview-designer-tree.png) |
| Schedule in a browser | **Pass** | With the D9 warnings (hero `/x-odd`, announcement `/another-odd`, banner `/odd-route`), Schedule two days ahead: toast "Scheduled for 5 Nov, 10:00 am — the pending release is in the history below.", and the top banner lists the same three located lines as the card (plus the two policy-page warnings). The schedule was cancelled afterwards | [B-schedule-toast-and-banner](drills/DOC-04/B-schedule-toast-and-banner.png) |

Seen on the way (not one of the drills): with a view that names a column that doesn't exist, every `cms_pages` read fails with "no such column". The console treats that like a store from before the migration: the Designer's save answered 200 with no notice, and the page editor answered **"404 — not found. This console page doesn't exist, or this store isn't available here."** for a page that exists. A real schema fault would look like a missing page. [B-page-editor-missing-column-404](drills/DOC-04/B-page-editor-missing-column-404.png), `results-savefail-missing-column.json`.

### Batch B · MIG-05 / OVL-06 (`drills/MIG-OVL/`, `scripts/drills/p1/migovl.mjs`, `migovl-d2.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| D1 Both titles on the order page | **Pass** | The harness variants have no SKU, so `gid://v/1` and `gid://v/3` got `DD-GLOW-30` and `DD-SPF-50` in the local DB first. COD order with two lines through the real checkout; both lines stored `catalog_title` and `sku`. Then the glow-serum line's `title` was set to "Glow Serum, festive edition". The order page shows "Shopify title: Radiance Glow Serum 30ml, SKU: DD-GLOW-30" under that line only; nothing overflows at 1280 or 375. The line is 12px `rgb(161,161,170)`, **2.56:1** on white (the review's contrast finding, measured again) | [D1-order-1280](drills/MIG-OVL/D1-order-1280.png), [D1-order-375](drills/MIG-OVL/D1-order-375.png) |
| D2 Old orders look the same | **Pass** | Main (`c47045f`) was run from a `git archive` copy with its own file-database harness on 3081, then this branch, each freshly seeded. Order `DD-SYNC1` at 1280 and 375: the page text is identical once the seed time is taken out ("placed 3 Nov 2026, 05:37 pm" on main, 05:38 pm here, because the two seeds ran a minute apart), no "Shopify title" on either. Seeded orders have no line rows, so neither page shows a lines card at all | [D2-main-1280](drills/MIG-OVL/D2-main-1280.png), [D2-branch-1280](drills/MIG-OVL/D2-branch-1280.png), [D2-main-375](drills/MIG-OVL/D2-main-375.png), [D2-branch-375](drills/MIG-OVL/D2-branch-375.png), `D2-main.json`, `D2-branch.json` |
| D3 Top products after a rename | **Pass** | Rose Hydration Mist (no seeded orders) ×1, then `products.title` changed to "Rose Hydration Mist 100ml Renamed", then ×2. Analytics: one row "Rose Hydration Mist 100ml Renamed ×3 ₹2,247". CSV header `title,qty,revenue`, row `Rose Hydration Mist 100ml Renamed,3,2247`. The harness's false split for seeded products shows too (Radiance Glow Serum ×38 and ×2, Daily Defence ×19 and ×4: seeded snapshots have no product id), as the review said | [D3-analytics-top-products](drills/MIG-OVL/D3-analytics-top-products.png) |
| D4 Agency report | **Pass** | Signed in at `/partners` as the seeded agency user, opened the design store's report: "Rose Hydration Mist 100ml Renamed — 3 units · ₹2,247", one row | [D4-agency-report](drills/MIG-OVL/D4-agency-report.png) |
| D5 Support role | **Pass** | Operator console → support grant for `design` (1 hour) → the D1 order as support: the Shopify title and SKU line shows; the shopper's name, email, phone, address and PIN code are not on the page. Grant revoked afterwards | [D5-support-order](drills/MIG-OVL/D5-support-order.png) |
| D6 Shopper sees nothing new | **Pass** | Cart drawer, checkout address, review, payment and confirmation: no "SKU", "Shopify title" or SKU value. The cart JSON a shopper's browser receives does carry `catalog_title` and `sku` (the known limit, not visible) | [D6-cart-drawer](drills/MIG-OVL/D6-cart-drawer.png), [D6-checkout-review](drills/MIG-OVL/D6-checkout-review.png), [D6-checkout-payment](drills/MIG-OVL/D6-checkout-payment.png), [D6-confirmation](drills/MIG-OVL/D6-confirmation.png) |

### Batch B · GEN-02 (`drills/GEN-02/`, `scripts/drills/p1/gen02.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| Setup | Done | Fresh seed, so migration 0020 applies. States set by writing `sync_runs` rows to the local tenant database | |
| D1 Progress on the dashboard | **Pass** | First block on the page; "Bringing in your products from Shopify"; "240 of 600 products so far. Big stores can take a while. You can keep using the console."; `aria-valuenow` 40; no button; no sideways scroll at 375 | [D1-dashboard-1440](drills/GEN-02/D1-dashboard-1440.png), [D1-dashboard-375](drills/GEN-02/D1-dashboard-375.png) |
| D2 Failure and Try again | **Pass** | Red banner, "Your products didn't finish coming in", "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes.", "240 of 600 products so far. Your store keeps everything already brought in.", Try again; nothing raw on the card. Try again → `POST` 409 → "Couldn't start / Storeasy isn't linked to your Shopify store. Contact support to link it, then try again." (Elsewhere on the dashboard the seeded order-push failures do show "Shopify 502: upstream timeout"; that card is not GEN-02's) | [D2-failed](drills/GEN-02/D2-failed.png), [D2-try-again-couldnt-start](drills/GEN-02/D2-try-again-couldnt-start.png) |
| D3 Retrying | **Pass** | Amber banner, "We hit a snag and will try again", "Shopify didn't answer. …", "Try again now"; no "fetch failed" | [D3-retrying](drills/GEN-02/D3-retrying.png) |
| D4 Stalled | **Pass** | "Bringing in your products stopped partway", "It stopped before finishing. Try again to pick up where it left off.", Try again; 0 `GET /api/admin/sync` in 10 seconds | [D4-stalled](drills/GEN-02/D4-stalled.png) |
| D5 Settings card | **Pass** | Nav "Products from Shopify" jumps to `#catalog-sync`; progress with the D1 row; after the complete update "Your products are in", "600 products and 120 collections, brought in just now.", no "Refresh from Shopify" | [D5-settings-progress](drills/GEN-02/D5-settings-progress.png), [D5-settings-complete](drills/GEN-02/D5-settings-complete.png) |
| D6 Polling stops when done | **Pass** | Polls 3,037 ms and 3,018 ms apart; the card turned into "Your products are in" 1.3 s after the update, with no reload; 0 polls in the next 10 s | [D6-done-without-reload](drills/GEN-02/D6-done-without-reload.png) |
| D7 Setup checklist | **Pass** | Products deleted, D1 row: "Bringing in your products from Shopify: 240 products so far", not done; its link opens `/admin/settings#catalog-sync` with the card at the top | [D7-setup](drills/GEN-02/D7-setup.png), [D7-link-lands-on-card](drills/GEN-02/D7-link-lands-on-card.png) |
| D8 Keyboard and screen reader basics | **Pass** | Tab reaches Try again (2px solid outline), Enter presses it (`POST` went out); progress bar `aria-label="Products brought in"` with `aria-valuenow`; headline area `aria-live="polite"` | in `results-main.json` |
| D9 Support login | **Pass** | Operator under a support grant: the card shows with no buttons; its polls ran, and `products_fetched` and `updated_at` didn't change. Also checked with the lease cleared: still untouched | [D9-support](drills/GEN-02/D9-support.png) |
| D10 No link, no products | **Pass** | "Your products aren't in yet", "Storeasy isn't linked to your Shopify store yet. Contact support to link it.", no button | [D10-no-link-no-products](drills/GEN-02/D10-no-link-no-products.png) |
| D11 A failed refresh of an existing store | **Pass** | Re-seeded. "The latest refresh from Shopify didn't finish", amber banner, "Your store keeps everything it had, plus what came in.", Try again, nothing raw | [D11-refresh-failed-amber](drills/GEN-02/D11-refresh-failed-amber.png) |
| D12 A running refresh stays off the dashboard | **Pass** | No sync card on the dashboard; Settings shows "Refreshing your products from Shopify" | [D12-dashboard-no-card](drills/GEN-02/D12-dashboard-no-card.png), [D12-settings-refreshing](drills/GEN-02/D12-settings-refreshing.png) |

### Batch B · COM-03 (`drills/COM-03/`, `scripts/drills/p1/com03.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| B1 Storefront cart after going back | **Pass** | Buy 2 get 1 on Night Repair Cream 50g (in stock, no other offer; the first try used Detox Clay Mask, which the seed has out of stock). Edited to get 2: 4 in the cart, ₹3,598 off (2 free). Went back in the console, reloaded the cart: ₹1,799 off (1 free), no restart, no publish | [B1-started](drills/COM-03/B1-started.png), [B1-went-back](drills/COM-03/B1-went-back.png), [B1-drawer-after-go-back](drills/COM-03/B1-drawer-after-go-back.png) |
| B2 Keyboard only | **Pass, one note** | New offer → kind → Choose a product → picker opens with focus inside → Escape closes it, focus back on Choose a product → reopen, type, Tab to the product, Enter picks it (a one-product picker takes the pick at once; there is no Confirm), dialog closes, focus back on the button → Tab to Start offer → Enter starts it. Focus was visible at every stop (62) outside the date fields. **Note:** inside Starts and Ends, Tab walks the day, month, year and time parts; on those stops the field has no ring, only Chrome's own highlight of the part ([close-up](drills/COM-03/B2-date-part-focus-raw.png)) | [B2-picked-by-keyboard](drills/COM-03/B2-picked-by-keyboard.png), [B2-started](drills/COM-03/B2-started.png) |
| B3 A slow or failed example | **Pass** | Slow 3G (2 s latency, 500 kbit/s): "Checking on your store's products…" from 2 ms after the change to 2.4 s, then the example. Offline: "The example couldn't load. Check your connection and try again." Back online, Start offer started it | [B3-slow-example-arrived](drills/COM-03/B3-slow-example-arrived.png), [B3-offline-example](drills/COM-03/B3-offline-example.png) |
| B4 A large catalog | **Pass** | 2,000 products with 50 tags added to the local DB. "Choose a tag" listed the tags 223 ms after the click; searching "drilltag-42" narrowed it to that tag ("80 products") | [B4-tag-list](drills/COM-03/B4-tag-list.png), [B4-tag-search](drills/COM-03/B4-tag-search.png) |
| B5 The cart's label after an edit | **Pass** | Name blank. 3 in the cart: "Buy 2 of Night Repair Cream 50g, get 1 free" −₹1,799. After the edit, 4 in the cart: the drawer and the checkout summary read "… get 2 free", ₹3,598 off | [B5-drawer-get-1](drills/COM-03/B5-drawer-get-1.png), [B5-drawer-get-2](drills/COM-03/B5-drawer-get-2.png), [B5-checkout-get-2](drills/COM-03/B5-checkout-get-2.png) |
| B6 Two real tabs | **Pass** | Two pages on the seeded Serum duo. A: step 1 from 16% to 18%, Update live offer. B, not reloaded: Go back → Go back: "This offer changed while you were looking at it. Close it and open it again to see its settings now." The reloaded list and the stored config keep 18% | [B6-tab-b-refused](drills/COM-03/B6-tab-b-refused.png), [B6-list-after](drills/COM-03/B6-list-after.png) |
| B7 Going back to settings that start later | **Pass, one note** | Code DRILLLATER starting next week ("starts 10 Nov, 10:00 am."), then no dates, then Go back: dialog "Shoppers get this from 10 Nov, 10:00 am:", toast "Back to the earlier settings. Shoppers get them from 10 Nov, 10:00 am." **Note:** while the offer hadn't started yet, its edit form's button read "Update live offer" | [B7-go-back-dialog](drills/COM-03/B7-go-back-dialog.png), [B7-toast](drills/COM-03/B7-toast.png) |

### Batch B · P1-HARNESS follow-ups (`drills/harness/`, `scripts/drills/p1/harness.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| S57 and S59 Designer flows on the edge runtime | **Pass with the experiment completed; finding 1 with it running** | Designer: typed a new title, subtitle and button label, Save (200), Publish now (200), then `/` signed out in fresh browsers. With the seeded `hero-promise` experiment running, the founder's preview showed variant b's title and subtitle ("Visibly brighter in 14 days", "Or your money back.") while typing and after Save; only the button label showed the founder's words. Signed out, 3 of 4 new visitors got variant b. After completing the experiment in the console (Experiments → Complete): the typed words showed in the preview, after Save, and for 4 of 4 signed-out visitors. Every preview document answered 200 with `x-edge-runtime: 1` (4 per run), and the live page too | [S57-designer-typed](drills/harness/S57-designer-typed.png), [S57-designer-saved](drills/harness/S57-designer-saved.png), [S57-live-signed-out](drills/harness/S57-live-signed-out.png), [S57-noexp-designer-typed](drills/harness/S57-noexp-designer-typed.png), [S57-noexp-designer-saved](drills/harness/S57-noexp-designer-saved.png), [S57-noexp-live-signed-out](drills/harness/S57-noexp-live-signed-out.png) |
| Production build on the harness databases | **Pass** | `next build` with the harness env: exit 0, the same two "unexpected file in NFT list" warnings through `lib/platform/migrate.js`. `next start` through the real harness launcher (`scripts/drills/p1/prod-harness.mjs`, which passes `nextCmd` to `runHarness`), then `node scripts/drill.js harness-edge`: **150 passed, 0 failed, 5 known** (finding 5 ×4, finding 6 ×1), the same as dev. In production the raw HTML holds less: product page "Radiance Glow Serum 30ml" 22 times and "1299" 6 times (dev 24 and 9); RSC fetch 16 (dev 18). The drill's own `/api/cart` edge check reads the dev manifest, which was still on disk; the production manifest (`.next/server/middleware-manifest.json`) also lists `/api/cart/route` as an edge function built from `server/edge/` chunks | `next-build.log`, `prod-edge-run.log`, `prod-edge-run.json` |
| Maintenance on a dark brand | **Fail (finding 3 confirmed, on every brand)** | Saved a dark brand (background `#111827`, text `#f9fafb`) through the console's brand API and published it; the open store turned dark. Maintenance on: the closed page is still white, and the message is `rgb(212,212,216)` on `rgb(255,255,255)`, **1.48:1**, the same number as finding 3; the "Store team sign-in" link is the same colour. The maintenance page doesn't use the brand at all, so a dark brand doesn't help. Brand put back and published, maintenance off | [open-store-dark-1440](drills/harness/open-store-dark-1440.png), [maintenance-dark-1440](drills/harness/maintenance-dark-1440.png), `results-dark.json` |
| Checkout at 390 and 360 (finding 6) | **Known (finding 6), measured** | With one item in the cart: 360 → page 398px wide; 375 → 398; 390 → 398; 414 → fits. The step row ends at 398px at every width. Not fixed, so the `knownOverflow` marker stays | [checkout-360](drills/harness/checkout-360.png), [checkout-375](drills/harness/checkout-375.png), [checkout-390](drills/harness/checkout-390.png), [checkout-414](drills/harness/checkout-414.png) |
| Finding 5 after the maintenance fix merges | **Could not run as written** | The maintenance fix (`f3e8672`, another session) is not merged into `c513d27`. `drill:edge` still reports the four "carries no store content" checks as known failures (home: "Shop bestsellers" ×2, product name ×2; product page: product name ×24, "1299" ×9; policy text ×2; RSC fetch: product name ×18), and no "finding 5 looks fixed" note. Markers left in place | `edge-run-*.json` |
| Finding 1 numbers | **Recorded** | Five dev runs of `drill:edge`: the Designer preview's hero title was the draft "Winter repair, started." in runs 1–3 and variant b "Visibly brighter in 14 days" in runs 4–5. Every run sent `POST /api/exp` from inside the preview, answered `200 {"ok":true,"recorded":true}`. The production run: variant b, recorded | `edge-run-1.json` to `edge-run-5.json`, `edge-run-*.log` |

### Batch B · ED-01 (`drills/ED-01/`, `scripts/drills/p1/ed01.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| B1 Click to select, edge | **Pass** | 1440: "Desktop, 1280 px wide, shown at 71% to fit" (912px shown); 1024: "… 56% to fit" (720px). Clicking the hero in the frame selects Hero (tree and inspector) and gives it `storeasy-selected` with a solid outline; clicking "Shop by collection" moves both | [B1-1440-hero](drills/ED-01/B1-1440-hero.png), [B1-1440-section](drills/ED-01/B1-1440-section.png), [B1-1024-hero](drills/ED-01/B1-1024-hero.png), [B1-1024-section](drills/ED-01/B1-1024-section.png) |
| B2 Close-on-pick | **Pass** | 1024: Sections drawer → "New arrivals" (the last): the drawer closes, focus is on the Sections button, the section is outlined and in view | [B2-1024-last-section-picked](drills/ED-01/B2-1024-last-section-picked.png) |
| B3 Live typing | **Pass** | `hero-promise` completed. 1280 ("Desktop, 1280 px wide, shown at 59% to fit"): typed announcement text showed in the frame after 845 ms, the typed hero title after 795 ms; caption, shown width and inner width unchanged | [B3-1280-announcement](drills/ED-01/B3-1280-announcement.png), [B3-1280-hero-title](drills/ED-01/B3-1280-hero-title.png) |
| B4 Desktop inside the frame | **Pass** | At 1024 and 1440 the store reports `innerWidth` 1280, `(min-width: 1024px)` true, and shows its header links with no menu button | [B4-1024](drills/ED-01/B4-1024.png), [B4-1440](drills/ED-01/B4-1440.png) |
| B5 Pairs and modules | **Pass** | An accordion on every product page was saved first (Product pages), so the product preview has `pdp-modules`. At 1280, clicking `pdp-pairs` brings "Also on this page" into view with the ring; clicking `pdp-modules` brings "Modules & badge" into view in the 288px inspector with the ring | [B5-1280-pairs](drills/ED-01/B5-1280-pairs.png), [B5-1280-modules](drills/ED-01/B5-1280-modules.png) |
| B7 Designer loading state | **Pass** | A temporary 4 s delay in the home and product designer pages (`scripts/drills/p1/ed01-temp.mjs delay`, reverted). Holding the RSC answer in the browser instead showed the skeleton for only about 300ms, because Next sends the loading shell in the same answer. Storefront → Designer: editor-shaped skeleton with Open menu and a tree; the menu opens the navigation; the real editor replaced it with the top bar at the same top and height. Product page tab: skeleton with no tree, same | [B7-home-skeleton](drills/ED-01/B7-home-skeleton.png), [B7-home-skeleton-menu-open](drills/ED-01/B7-home-skeleton-menu-open.png), [B7-product-skeleton](drills/ED-01/B7-product-skeleton.png), [B7-product-real](drills/ED-01/B7-product-real.png) |
| B8 Error page by keyboard | **Pass** | A temporary throw in the designer page (reverted, `git diff -- app` clean). 1440: "This page hit an error"; the first Tab is Open menu; Enter opens the navigation with focus inside; Escape closes it with focus back on the button; Try again reachable | [B8-error-page](drills/ED-01/B8-error-page.png), [B8-menu-open](drills/ED-01/B8-menu-open.png) |

### Batch A · AU-05 (`drills/AU-05/`, `scripts/drills/p1/au05.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| D1 Paragraphs, no heading | **Pass** | Saved, reloaded: both paragraphs, heading empty. Preview and the published page show both paragraphs with no empty `h2` | [D1-editor-after-reload](drills/AU-05/D1-editor-after-reload.png), [D1-preview](drills/AU-05/D1-preview.png), [D1-live](drills/AU-05/D1-live.png) |
| D2 Blank text section | **Pass, one note** | Refused (422) naming section 3, badge "3. Text"; Unsaved stays; reload shows the earlier content. Removing the blank section and saving (with one more real edit) succeeds, and the banner and Unsaved go. **Note:** right after removing the blank section the form matches the saved page, so Save is disabled, and the old banner stays, now reading "A section: add a heading or some text, or remove this section." until the next save or a reload (DOC-04's known limit about removed sections) | [D2-blank-refused](drills/AU-05/D2-blank-refused.png), [D2-after-remove](drills/AU-05/D2-after-remove.png) |
| D3 Heading only, alt only, answer only | **Pass** | "section 2: this section is empty…", "section 3: choose an image…", "section 4, question 1: question text required"; heading, alt and answer all still in the form | [D3-three-refused](drills/AU-05/D3-three-refused.png) |
| D4 Save as template | **Pass** | Enabled with only a headingless text section; saved; a new page from it holds both paragraphs; a blank section's error shows inside the dialog | [D4-new-page-from-template](drills/AU-05/D4-new-page-from-template.png), [D4-template-dialog-error](drills/AU-05/D4-template-dialog-error.png) |
| D5 Identity | **Pass** | Add, save, edit, save, reload: "One"/"First." then "Two"/"Second, edited.", in that order, stored as two sections each with its own id (`results-editor.json`) | [D5-identity](drills/AU-05/D5-identity.png) |
| D6 Over 4,000 characters | **Pass** | Refused with the length and the limit; the text stays | [D6-too-long](drills/AU-05/D6-too-long.png) |
| D7 `<500 and >` | **Pass** | Banner quotes "<500 and >", section 1 matches the badge, text stays; reworded saves; the live page reads "Free on orders under 500 rupees." | [D7-quoted](drills/AU-05/D7-quoted.png), [D7-live](drills/AU-05/D7-live.png) |
| D8 `tel:` link | **Pass** | Banner quotes `tel:+919876543210`, Unsaved stays; https addresses save; the live HTML keeps `nofollow` beside `noopener noreferrer` on the `target=_blank` link | [D8-tel-refused](drills/AU-05/D8-tel-refused.png) |
| D9 YouTube embed | **Pass** | Banner quotes the embed address and says embedded videos can't show, not "empty"; Unsaved stays; a plain link saves | [D9-embed-refused](drills/AU-05/D9-embed-refused.png) |
| D10 Stray markup in a product description | **Pass** | Put into the harness product's `description_html` directly (local only, put back afterwards): `< <img src=x onerror=alert(1) ` shows as text, no dialog, no `img`; `a <!-- private > note --> b` shows "a b" | [D10-stray-markup-as-text](drills/AU-05/D10-stray-markup-as-text.png), [D10-comment-hidden](drills/AU-05/D10-comment-hidden.png) |
| D11 Old empty-markup template | **Pass** | A template row inserted locally with a rich section of `<p>&nbsp;</p>`: the new page opens with both sections and the heading "Old details"; Save names section 2; fixing it saves | [D11-opened](drills/AU-05/D11-opened.png), [D11-save-names-section](drills/AU-05/D11-save-names-section.png) |

### Batch A · SHOP (`drills/SHOP/`, `scripts/drills/p1/shop.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| Cart after the CartContext change | **Pass** | Product page → Add to cart (200, drawer opens) → + (2, ₹2,598) → − (1) → Checkout opens checkout with the item → Remove (drawer and cart empty, header "Open cart, 0 items") → checkout reads "Your cart is empty". No console or page errors | [1-added](drills/SHOP/1-added.png), [2-quantity-2](drills/SHOP/2-quantity-2.png), [3-checkout](drills/SHOP/3-checkout.png), [4-removed](drills/SHOP/4-removed.png), [5-checkout-empty](drills/SHOP/5-checkout-empty.png) |
| `pnpm build` | **Ran as `next build` with the harness env** | Exit 0 (see the production drill above). Not run with a hosted env | `drills/harness/next-build.log` |

### Batch A · GEN-03 (`drills/GEN-03/`, `scripts/drills/p1/gen03.mjs`)

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| 1 Empty store | **Pass** | All products deleted locally. Home and `/collections` at 1440 and 375: no error, no sideways scroll; "New products are on the way", "No collections to show yet — please check back soon." | [1-empty-home-1440](drills/GEN-03/1-empty-home-1440.png), [1-empty-home-375](drills/GEN-03/1-empty-home-375.png), [1-empty-collections-1440](drills/GEN-03/1-empty-collections-1440.png), [1-empty-collections-375](drills/GEN-03/1-empty-collections-375.png) |
| 2 Checkout with the store's own rates | **COD pass; online not run** | Rates ₹79, free over ₹1,999, COD fee ₹49. Payment step: "Place order · ₹1,427"; summary Subtotal ₹1,299, "Shipping (incl. COD fee)" ₹128, Total ₹1,427; the stored order's total is 1427 | [2-cod-confirmation](drills/GEN-03/2-cod-confirmation.png) |
| 3 No Razorpay keys | **Pass** | Pay online disabled: "Online payment isn't available for this store right now." | [3-payment-no-keys](drills/GEN-03/3-payment-no-keys.png) |
| 4 Forced failures | **Network failure pass; failed verify not run** | `POST /api/checkout` cut off: "Could not reach the store — your cart is untouched. Check your connection and try again." | [4-network-failed](drills/GEN-03/4-network-failed.png) |
| 5 Cart drawer nudge | **Pass** | Starter rates: no nudge. After saving rates (and the storefront's 30 s settings cache): "Add ₹700 more for free shipping" at ₹1,299 | [5-drawer-starter-no-nudge](drills/GEN-03/5-drawer-starter-no-nudge.png), [5-drawer-own-rates-nudge](drills/GEN-03/5-drawer-own-rates-nudge.png) |
| 6 Settings notice, save and reload | **Fail** | The notice sits at the top of the shipping card with Keep these rates ([close-up](drills/GEN-03/6-settings-notice-raw.png)). Save settings answered 200 and the control plane held the new `shipping_config` at once, but **a reload right after Save showed the old starter values (₹79, free over ₹999) and "You haven't set your own shipping rates yet" again**. A reload 31 seconds later showed the saved rates and no notice | [6-settings-notice](drills/GEN-03/6-settings-notice.png), [6-settings-after-save-reload](drills/GEN-03/6-settings-after-save-reload.png), [6-settings-reload-31s-later](drills/GEN-03/6-settings-reload-31s-later.png) |
| 7 Error boundary on the edge runtime | **Pass** | Temporary throw in `app/(storefront)/search/page.js` (reverted): "Something went wrong", "A temporary error stopped this page from loading. It's usually gone on retry.", Try again and Back to home, no error text | [7-error-boundary-edge](drills/GEN-03/7-error-boundary-edge.png) |
| 8 Footer variants | **Pass** | Theme → Footer layout, saved and published each way: columns and minimal both carry "Design Demo Co" and no catalog or vendor note. Put back to columns | [8-footer-columns](drills/GEN-03/8-footer-columns.png), [8-footer-minimal](drills/GEN-03/8-footer-minimal.png) |
| 9 Cart on a real page | **Pass** | Adding ₹1,499 opens the drawer with "Add ₹500 more…"; after a reload the header reads "1 item" from the real cart | [9-drawer-real-page](drills/GEN-03/9-drawer-real-page.png) |
| 10 Empty home hero | **Pass** | One button at 1440 and 375 | the drill 1 screenshots |
| 12 Home editor placeholders | **Pass** | "A short headline", "Shop now", "/collections/…", "<p>Tell your story…</p>"; unedited Save refuses Section 3 (Banner / CTA) and Section 4 (Rich text); typing saves | [12-placeholders](drills/GEN-03/12-placeholders.png), [12-unedited-error](drills/GEN-03/12-unedited-error.png), [12-saved](drills/GEN-03/12-saved.png) |
| 13 Wrong sign-in code | **Pass** | "That code isn't right — check the email and try again." | [13-wrong-code](drills/GEN-03/13-wrong-code.png) |
| 14 Order list badges | **Pass, one note** | Two COD orders for a test shopper, set shipped and partly shipped in the local DB; signed in with the code recorded in the local notifications table (never printed). "SHIPPED" and "PARTLY SHIPPED" fit at 1440 and 375. **Note:** at 375 the product name next to "PARTLY SHIPPED" is cut to one letter ("R…") | [14-orders-1440](drills/GEN-03/14-orders-1440.png), [14-orders-375](drills/GEN-03/14-orders-375.png) |

### Batch A · MED-01 (`drills/MED-01/`, `scripts/drills/p1/med01.mjs`, files from `med01-fixtures.mjs`)

The files are synthetic, made with `sharp` (no real camera, no Display P3, no real HEIC). Uploads went through Storefront → Media unless the row says picker.

| Drill | Result | What happened | Evidence |
|---|---|---|---|
| 1 Large photo | **Pass on the mechanics, synthetic file** | 4000×3000 JPEG, 5.3MB: no error, `image/jpeg`, 1920×1440, 268KB, +thumb. Sharpness and colour on a real phone photo not checked | [1-library-photo](drills/MED-01/1-library-photo.png) |
| 2 One path and progress | **Pass** | Throttled to 1 Mbit/s up. Library and picker both showed "Getting … ready…", "Uploading … N%" in 6% steps, then "Saving …". Picker upload landed in the image field, and its grid loaded `/api/media/<id>` previews. Escape mid-upload: the spot stayed empty, toast "… is now in your library. It wasn't added here because you closed the window before it finished…". Reopened for the other spot mid-upload: neither spot changed and the picker stayed open. Network cut after closing: toast "The upload didn't go through. Check your connection and try again." | [2-picker-landed](drills/MED-01/2-picker-landed.png), [2-escape-mid-upload](drills/MED-01/2-escape-mid-upload.png), [2-reopened-other-spot](drills/MED-01/2-reopened-other-spot.png), [2-network-lost-after-closing](drills/MED-01/2-network-lost-after-closing.png) |
| 3 Transparent PNG (Chrome) | **Pass** | 10.7MB 1800×1800 PNG → WebP 1.18MB; corners alpha 0, middle solid; renamed `.jpg` → WebP; one see-through area → WebP. Safari not run | `results-library.json` |
| 4 Sideways photo (Chrome) | **Pass** | Landscape pixels with EXIF orientation 6 stored upright at 1440×1920 | [4-library-sideways](drills/MED-01/4-library-sideways.png) |
| 5(c) HEIC in desktop Chrome | **Pass** | A `.heic` Chrome can't open: the plain HEIC message, no `POST`. (An AV1 HEIF named `.heic` was decoded by Chrome and stored as JPEG `phone-photo.jpg`; that file wasn't a real HEIC) | [5c-heic-message](drills/MED-01/5c-heic-message.png) |
| 6 Small and unchanged | **Pass** | 800×600 JPEG stored at the same size in bytes; 300px PNG has no +thumb | `results-library.json` |
| 7 Refusals | **Pass** | PDF: "isn't an image", no POST. PDF renamed `.jpg` and a damaged JPEG: "couldn't open", no POST. Small PNG renamed `.jpg`: "isn't really the kind of image". Zero-byte `.jpg`: "is empty", no POST. No extension and `.jfif`: upload. GIF over 1.5MB and SVG over 300KB: "too big". Offline: "didn't go through", re-picking the same file offline tries again and says the same; back online the same file uploads. Chrome's offline switch did not stop an upload already in flight, so "network off during an upload" was shown only by picking while offline | [7-refusal-empty](drills/MED-01/7-refusal-empty.png), [7-offline-didnt-go-through](drills/MED-01/7-offline-didnt-go-through.png), [7-back-online](drills/MED-01/7-back-online.png) |
| 8 SVG, GIF and animated | **Pass for SVG, GIF and WebP** | SVG stored with no `<script>` or `onload`; animated GIF stored as sent; animated WebP 2400×1000 under 1.5MB stored as sent with its name; animated WebP over 1.5MB: "animated image and it's too big"; that WebP renamed `.jpg`: "isn't really the kind of image", no POST; a small GIF renamed `.jpg`: the same words after the server refused it. Animated PNG and `.apng` not run (no APNG encoder here) | `results-library.json` |
| 11 Long images (Chrome) | **Pass** | 1080×5000 PNG (1.45MB) same bytes, no "made smaller" notice (the check counted the ordinary "uploaded" toast as a notice and recorded a fail; the only toast was "size-chart-1080x5000.png uploaded"); 2000×6000 same bytes and size; 4000×400 stays; 1290×7000 PNG (25.9MB) → JPEG 1080×5860, 1.24MB; 1200×12000 (9.5MB) → 819×8192 with the notice "… so it's now 819×8192 pixels and could look soft on a big banner." | [11-library-grid](drills/MED-01/11-library-grid.png) |

## Findings for the owner

Each is a failed or partly failed drill, with the steps to see it. None is fixed here.

1. **The console shows the old settings for up to 30 seconds after a save (GEN-03 drill 6; also seen on Brand).** Steps: harness, `/admin/settings`, shipping card shows "You haven't set your own shipping rates yet". Set Flat rate 79, Free over 1999, COD fee 49, Save settings (200). Reload at once. Seen: starter values (free over ₹999) and the notice again. Expected: the saved rates, no notice. A reload 31 s later is right. The same happens on Brand: right after "Save brand", Publishing showed nothing to publish (Publish now disabled), and in another run Publish now answered **409**; 31 s later it published. Cause read, not proven: console pages read the tenant's settings through the 30 s platform cache (`PLATFORM_CACHE_MS`) in the process that just wrote them. A founder who saves and reloads sees their change "undone".
2. **The maintenance page ignores the brand, and its message is 1.48:1 on every brand (P1-HARNESS finding 3).** Steps: save and publish a dark brand (background `#111827`, text `#f9fafb`); the open store turns dark. Switch maintenance on in the operator console. Seen: a white page with the message in `rgb(212,212,216)`, 1.48:1, and the sign-in link the same. Expected: 4.5:1 or better.
3. **The founder's Designer preview shows an experiment variant instead of their words (P1-HARNESS finding 1).** Steps: seeded harness with `hero-promise` running; Designer → Hero → type a title and subtitle → Save. Seen in the Designer drill run with the experiment running, in 2 of 5 `drill:edge` runs and in the production run: variant b's "Visibly brighter in 14 days" / "Or your money back." in the preview while typing and after saving; every run records a `POST /api/exp` exposure from the preview. Completing the experiment fixes it.
4. **Checkout scrolls sideways at 360, 375 and 390 (P1-HARNESS finding 6).** The page is 398px wide at all three; 414 fits.
5. **A missing column reads as a missing page (seen during DOC-04).** Steps: in the local tenant DB, `ALTER TABLE cms_pages RENAME TO cms_pages_data`, then a view `cms_pages` that names a column that doesn't exist. Open `/admin/storefront/pages/shipping`. Seen: "404 — not found. This console page doesn't exist…". A Designer save in that state answered 200 with no notice. Expected: the console's error screen, as with any other read failure. Probably the "pre-migration store" tolerance (`no such table`/`no such column` read as empty).
6. **Minor wording and layout notes**, for the owner to decide: the "Shopify title: …, SKU: …" line is 2.56:1 (MIG-OVL D1); an offer that starts next week shows "Update live offer" (COM-03 B7); at 375 the account order list cuts the product name to one letter beside "PARTLY SHIPPED" (GEN-03 14); a stale "Couldn't save" banner reading "A section: …" stays after the blank section is removed, with Save disabled (AU-05 D2); date fields have no focus ring while Tab moves through their parts (COM-03 B2).
7. **The DOC-04 drill text for the publish case doesn't break anything on the harness.** `cms_approvals` is empty there, so a view over it never fails. The drill needs a view that fails with no rows (used here, see the DOC-04 table).

## Drills not run, and why

| Item | Drill | Why |
|---|---|---|
| AU-05 | none | All of D1 to D11 ran |
| SHOP | Push a branch and watch `.github/workflows/test.yml` pass, then one with `productUpdate` fail | Needs pushes; the brief forbids pushes |
| SHOP | `pnpm hooks:enable`, then a commit and a merge commit | The brief forbids enabling git hooks |
| SHOP | `pnpm shopify:oauth` against a dev store | Needs a real Shopify store |
| SHOP | `pnpm build` with the real env | Ran `next build` with the harness env only (no `.env.local` in this worktree, and the brief forbids using it) |
| GEN-03 | 2: online payment with a real Razorpay test payment | Needs real Razorpay keys and a real payment; the harness blanks them |
| GEN-03 | 4: a failed payment verify | Needs the Razorpay flow, which is disabled without keys |
| GEN-03 | 11: a real sign-in email on staging (store names with a dot and with non-English letters) | Needs staging and a real inbox |
| MED-01 | 1: a real phone photo, sharpness and Display P3 colour | Needs a real phone photo; a synthetic file covered the mechanics only |
| MED-01 | 3 and 11 in Safari; Safari's `toBlob` WebP answer | Safari, not desktop Chrome |
| MED-01 | 4 on the oldest supported iOS Safari | Needs that phone |
| MED-01 | 5(a), (b), (d), (e): HEIC on iPhone Safari, Mac Safari, Android Chrome, old iOS | Safari and phones |
| MED-01 | 8: animated PNG and `.apng` | No APNG encoder available here (no new dependencies) |
| MED-01 | 9: large camera photos on a real iPhone and Android, 48MP | Real phones |
| MED-01 | 10: a full-size upload on staging through the proxy | Staging |
| MED-01 | 11 on a real iPhone, and how long images look on a real page | A phone; the library grid was screenshotted |
| P1-HARNESS | Finding 5 after the maintenance fix merges | The fix isn't merged into `c513d27`; `drill:edge` was run and the four checks are still known failures |

## Known limits of this run

- **Desktop Chrome, headless, on macOS only.** No Safari, Firefox, phone, real touch or classic scrollbars.
- **Local only.** Next's edge sandbox in `next dev` and in `next start` on this Mac, with local `sqld`. Not Vercel's edge runtime, not Turso.
- **The DOC-04 failures were made with local views** (`json_extract('not json','$')`), as the drill texts say. They stand in for real database failures; hosted error shapes were not exercised.
- **The publish-failure break was changed** to fail with no rows (see DOC-04), because the drill's version breaks nothing on an empty table.
- **ED-01 B7 used a temporary 4 s delay in the server page**, as the packet allows, not Chrome's network throttle. Holding the browser's RSC answer instead showed the skeleton for only about 300ms.
- **The runner reuses one console session per run** (the sign-in limit is 5 a minute). The real sign-in form ran at the start of every run.
- **Some drills changed the harness and were put back by a re-seed**: the DOC-04 views, the deleted products, the 2,000 extra products, the completed hero experiment, the drill pages and offers. The harness was re-seeded at the end, so it is back to the seeded state.
- **MIG-OVL D2 compared main and this branch on two different harnesses**: main's file-database harness (its console runs on Node either way) and this branch's `sqld` harness. Only the order page was compared.
- **MED-01 used synthetic files.** Real photos compress differently, and the HEIC message test used a HEIC-labelled file of random bytes.
- **Chrome's offline switch doesn't stop an upload already in flight**, so MED-01 7's "network off during an upload" was shown by picking while offline.
- **GEN-02 states were written straight into `sync_runs`.** No real sync ran (the harness has no Shopify link).
- **Screenshots are the top of the page** at each width unless noted; the `results-*.json` hold every check's detail.
- **`results-*.json` and the `edge-run-*` files hold timestamps and generated ids**, so a re-run changes them.

## Files

- `scripts/drills/p1/`: `run.mjs` (runner), `db.mjs` (local harness database only), `util.mjs`, `sf.mjs` (storefront helpers), one journey per item (`doc04`, `migovl`, `gen02`, `com03`, `harness`, `ed01`, `au05`, `shop`, `gen03`, `med01`), `migovl-d2.mjs`, `prod-harness.mjs` (`next build` and `next start` on the harness), `edge-repeat.sh` and `edge-summary.mjs` (finding 1 numbers), `ed01-temp.mjs` and `gen03-temp.mjs` (the temporary app edits and their revert), `med01-fixtures.mjs` (test files), `console-errors.mjs`, `summary.mjs`.
- `docs/cms-reviews/drills/<item>/`: screenshots and `results-<part>.json` for DOC-04, MIG-OVL, GEN-02, COM-03, harness, ED-01, AU-05, SHOP, GEN-03, MED-01. The committed P1-HARNESS folder was left as it was: each `drill:edge` run's `results.json` was copied to `drills/harness/edge-run-N.json` and the folder restored with `git checkout`.

## Commands

```
git checkout -B cms/p1-drills c513d27
pnpm install --frozen-lockfile --prefer-offline
DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/dev-design.js seed
DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/dev-design.js            # left running
DESIGN_PORT=3081 node scripts/drill.js harness-edge                           # run 1, then:
DESIGN_PORT=3081 sh scripts/drills/p1/edge-repeat.sh 2 5
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs gen02 main,support
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs migovl orders,rename
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs doc04 nav,pdp,home,overview,schedule,publishfail,savefail
DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/drills/p1/prod-harness.mjs build
# stop the dev harness, re-seed, then:
DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/drills/p1/prod-harness.mjs start
DESIGN_PORT=3081 node scripts/drill.js harness-edge                           # production run
# stop it, start the dev harness again, then:
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs doc04 after
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs gen02 refresh
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs harness checkout,designer,designer-noexp,dark
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs ed01 b1,b2,b3,b4,b5
node scripts/drills/p1/ed01-temp.mjs delay;  DESIGN_PORT=3081 node scripts/drills/p1/run.mjs ed01 b7; node scripts/drills/p1/ed01-temp.mjs revert
node scripts/drills/p1/ed01-temp.mjs throw;  DESIGN_PORT=3081 node scripts/drills/p1/run.mjs ed01 b8; node scripts/drills/p1/ed01-temp.mjs revert
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs com03 cart,tabs,later,keyboard,slow
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs au05 editor,publish,d10,d11
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs shop cart
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs gen03 rates,home,account,footer
node scripts/drills/p1/gen03-temp.mjs throw; DESIGN_PORT=3081 node scripts/drills/p1/run.mjs gen03 boundary; node scripts/drills/p1/gen03-temp.mjs revert
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs com03 big
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs gen02 empty
DESIGN_PORT=3081 node scripts/drills/p1/run.mjs gen03 empty
# MIG-OVL D2: main from `git archive main` in a scratch folder, its own seed, Next on 3081:
node scripts/drills/p1/migovl-d2.mjs main http://localhost:3081 DD-SYNC1
# stop it, re-seed this branch's harness, start it:
node scripts/drills/p1/migovl-d2.mjs branch http://localhost:3081 DD-SYNC1
node scripts/drills/p1/med01-fixtures.mjs <scratch folder>
MED01_FILES=<scratch folder> DESIGN_PORT=3081 node scripts/drills/p1/run.mjs med01 library,heic,offline,progress
node scripts/drills/p1/summary.mjs
```

Every server started for these drills (the dev harness, the production harness, main's console) was stopped by its own PID at the end, and ports 3081 and 18130 to 18132 were free.
