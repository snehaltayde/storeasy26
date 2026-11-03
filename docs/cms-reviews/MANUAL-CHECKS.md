# Checks the owner has to run

Each phase of the CMS build adds to this list. These checks need something an agent cannot use: a real phone, Safari, staging, a real Shopify store, a real Razorpay payment, a real inbox, or a decision that is the owner's to make. Checks that desktop Chrome on the design harness can cover are run by agents and recorded in the review packets instead.

The full list goes to the owner when all six phases are done. Each entry names the requirement, what to do, and what a pass looks like.

## Phase 1, batch A

### Page editor (AU-05)
- [ ] **Unclosed tag in a real Shopify description.** On a test store, in Shopify's own admin, end a product description with `< <img src=x onerror=alert(1) `. Pass: the product page shows it as text, no dialog opens, and the page has no image from it. Then try `a <!-- private > note --> b`. Pass: only `a` and `b` show. The harness run covers this with local data; this check covers a real sync.

### Shopify boundary and test gate (SHOP-01 to SHOP-06)
- [ ] **CI gate on GitHub.** Push a branch and watch `.github/workflows/test.yml` pass. Then push a throwaway branch that adds `productUpdate` anywhere in `lib/`. Pass: the run fails on `test:shopify-boundary`. Needs a push, which is yours to do.
- [ ] **Turn on the local hooks.** Decide whether to run `pnpm hooks:enable`. It sets `core.hooksPath`, so every commit and merge runs the whole suite (about 35 seconds) and stops if any suite fails. It was left off on purpose while parallel sessions committed.
- [ ] **OAuth scopes against a dev store.** Run `pnpm shopify:oauth` against a development store. Pass: the scopes it asks for match the one scope list, with no write scopes for products or content.

### Shopper copy (GEN-03)
- [ ] **Checkout with the store's own shipping rates and a real Razorpay test payment.** Pass: the summary and Pay button match the amount charged, for both COD and online payment. You perform the payment.
- [ ] **Sender name on real email, on staging.** Request a sign-in code. Pass: it arrives from the store's name. Repeat with a store name containing a dot (`St. Mark's`) and one in non-English letters. A refused sender would stop that store's sign-in emails.

### Phone photo uploads (MED-01)
- [ ] **A real 5MB phone photo,** from both Storefront > Media and an image field's picker. Pass: it uploads, looks sharp, and keeps its colours (Display P3).
- [ ] **Safari.** A transparent PNG over 1.5MB stays transparent. The same file renamed `.jpg` is handled. A long image (for example a size chart) keeps its size.
- [ ] **HEIC** on iPhone Safari, Mac Safari, desktop Chrome, Android Chrome and the oldest iOS you support. Pass: converted where the browser can, otherwise a plain message and nothing sent.
- [ ] **Sideways photos** on the oldest supported iOS Safari. Pass: they upload the right way up.
- [ ] **Large camera photos on a real iPhone and Android,** including 48MP if available. Pass: the tab does not run out of memory.
- [ ] **One full-size upload on staging.** Pass: it gets through the hosting request limit and the proxy, with a preview.

## Phase 1, batch B

### Before any deploy of this branch (yours: it touches hosted databases)
- [ ] **Run tenant migrations 0018, 0019 and 0020 on every hosted tenant, then the check.** Run `pnpm tenant:migrate -- --all` on staging first, then `pnpm tenant:migrate -- --check`. Pass: each tenant reports the three migrations applied. `--check` prints a ✓ line for every tenant, suspended ones included, then "Safe to deploy." 0020 also adds `collection_products.sync_generation` and `synced_at`, which collection webhooks need.
- [ ] **Decide whether `--check` becomes a required deploy step.** Today it is a documented command only. Choose a CI job before promote, a deploy script step, or the manual rule.
- [ ] **A staging tenant still at 0017.** Deploy to staging before migrating one tenant, then place a COD order and a Razorpay test payment. Pass: both complete and show their lines in the console. Migrate that tenant and order again. Pass: the new order's lines carry the SKU, which confirms Turso's "no such column" wording matches `lib/schema-compat.js`. Cancel the test orders (snehal@mediastic.in).

### Errors that say what kind they are (DOC-04)
- [ ] **A real database failure on staging.** Point one staging tenant at a wrong database URL or revoke its token, then save in the Designer and publish. Pass: a 503 with "We couldn't reach your store's data just now, so nothing was saved/published…", never a conflict dialog or a validation list. The log shows DATABASE_UNAVAILABLE or DATABASE_ERROR. Only local files and an unreachable URL were tested, so this is the check that hosted Turso's error shapes are classified correctly.
- [ ] **The AI service unreachable on staging.** With the AI key set and the provider blocked, click Generate in AI Insights. Pass: "We couldn't reach the AI service just now…", not "your store's data".
- [ ] **Safari and a phone:** the Publishing warnings banner and the Media "Still referenced" dialog wrap with no sideways scroll.
- [ ] **Decisions:**
  - Accept the new answer codes SAVED_RELOAD_FAILED and RELOAD_NEEDED, or rename them before phase 2.
  - A failure in another service (for example Razorpay in Billing) can still read "We couldn't reach your store's data". Fix it once the database-retry branch merges?
  - Should the editors' "Couldn't save" title change when the save went through but the reload failed?
  - Two older holes: a failed sign-in lookup answers 401, and `mediaUsage` swallows read failures, so a delete may not warn that a file is in use. Fix them now or later?

### Orders keep the Shopify title and SKU (MIG-05, OVL-06)
- [ ] **A real Shopify store.** Push a test order to a dev store and search Shopify admin by the SKU the console shows. Pass: the order is found. Cancel it.
- [ ] **Decisions:**
  - The cart data in shoppers' browsers now carries `catalog_title` and `sku`. Once titles can be edited (OVL-03), should these stay server-side?
  - Free gift lines get no "Shopify title" line until OVL-09. Accept that, or pull it forward?

### First product sync in steps (GEN-02)
- [ ] **A running tick (OQ-19).** Decide on a staging deploy now or wait for hosting; `jobs-tick.yml` does nothing until TICK_URL and CRON_SECRET are set. Pass: on staging, a first sync of a 2,000+ product store finishes with the console closed.
- [ ] **A real development store with over 1,000 products and a collection over 250.** Pass: the dashboard shows "N of M" with M equal to Shopify's active product count. Product, variant and collection-member counts match Shopify admin. `sync_runs.products_total` is filled. A product edited during the sync has its edit afterwards. No products page takes close to the 15-second limit.
- [ ] **Stop it mid-sync on staging.** Redeploy or cancel the function during a sync. Pass with a tick: it resumes at the stored cursor with no page fetched twice, and the counts are exact. Pass with no tick and the dashboard open: progress moves again within about three minutes. This is the only check of batch atomicity over HTTP.
- [ ] **after() time on the hosting plan.** Pass: within a minute of connecting, `products_fetched` is above zero before any tick.
- [ ] **Webhooks on a real store.** Edit a product title in Shopify and remove a product from a collection. Pass: the storefront shows both within a minute.
- [ ] **A long collection during a refresh.** Pass: it never shows fewer products than before the refresh started.
- [ ] **Phone Safari:** the dashboard sync card is readable with no sideways scroll, and Try again works.
- [ ] **Decisions:**
  - Accept the wording ("Bring in products", "Refreshing your products from Shopify", "The latest refresh from Shopify didn't finish", "Your store keeps everything it had, plus what came in.") and the rule that the dashboard hides a running refresh when the store already has its products.
  - What counts as "confirmed" for GEN-01: the latest sync must be complete, or any complete sync?

### Offer form (COM-03)
- [ ] **Run 0019 on staging, edit a live offer and press Go back.** Pass: the old settings come back and a real staging cart shows them on its next load.
- [ ] **A real free-gift order on a real store.** Make a free-gift offer with a real product and order over the threshold. Pass: the gift is in the cart, and the draft order's discount description reads the plain name. Then leave the name blank, move the spend, and order again. Pass: the description names the new amount. Cancel the orders.
- [ ] **iPhone Safari:** start a discount code and edit it. Pass: no sideways scroll, the pickers open and close, and the two "Name in the cart" lines stack.
- [ ] **Decisions:**
  - Offers "for a collection" need an engine change. Yes or no, and in which phase?
  - Accept the free-item warning thresholds (₹2,000, $25, €25, £20, AED 90, SGD 30, AUD 40, CAD 35), or give your own.
  - Accept the wording: "Save changes" for an offer that is off, new offers start on, the default names ("Buy 2, get 1 free", "Buy more, save more"), and the typed-name warning (warns, never blocks).
  - Whole-unit rounding outside India (12.5% of $20 shows "$3 saved") is an engine change. Change it or keep it?

### Design harness (P1-HARNESS)
- [ ] **Your own harness on 3017.** From your main checkout, run `pnpm dev:design` and open http://localhost:3017 signed out. Pass: the Design Demo Co store shows, and sign-in works with `.design-env`. Run `pnpm seed:design` in a second terminal. Pass: it says the harness is running and the store still loads. Ctrl-C the first terminal. Pass: `lsof -nP -iTCP:3017 -iTCP:18017-18019 -sTCP:LISTEN` prints nothing.
- [ ] **Cookie banner over "Checkout →" on a real iPhone.** On a first visit, add to cart. Pass: the drawer's checkout button can be tapped without answering the banner, or you accept that it can't. In Chrome the banner covers it at 375, 768 and 1440.
- [ ] **Staging on the hosted edge runtime.** Open home, a product, a collection, /collections, search, checkout's first step, account sign-in, a CMS page and the closed-store page. Pass: each shows real content and the Designer preview works.
- [ ] **Safari on the Mac:** the harness storefront and the Designer render and the preview connects.

### Full-width editor (ED-01)
- [ ] **Safari on a Mac,** full screen and about 1100 wide. Pass: tree, preview and inspector sit side by side, with the tree in a drawer at 1100. The drawer opens and closes by keyboard and focus returns to it. Picking a section closes it and shows the section's settings. Escape works.
- [ ] **iPad landscape.** Pass: the Sections drawer works by touch, and the preview is at least 600px wide.
- [ ] **Your own laptop** (1366 or 1280 wide, shorter than 900). Pass: no page scroll, the inspector and long section lists scroll on their own, and the store is readable.
- [ ] **A classic-scrollbar screen** (Windows, or a Mac with scroll bars always shown) at 1440 and 1366. Pass: the desktop preview is at least 900px at 1440, nothing scrolls sideways, and no inspector control is cut off.
- [ ] **Staging:** the Designer at 1440 shows the desktop layout at 71%, clicking a section selects it, and Save and Publishing work. When a designer page fails to load, "This page hit an error" shows with a working menu button and Try again.
- [ ] **Decisions:**
  - "Desktop" means a 1280px page shrunk to fit, or 1440px? Do you want an "actual size, scroll sideways" option?
  - Fold the console navigation fully behind the menu button (as built), or keep the 64px icon rail?
  - The designers' description sentences are now for screen readers only. Is hidden fine?
  - Below 1280 wide, the store name, the store switcher and the unpublished-changes dot show only in the menu. Is that acceptable for agency use?
  - Picking a section closes the drawer at 1024 to 1279 wide. Keep it?

### The founder test (spec section 12)
- [ ] **The riskiest-assumption test.** Recruit 5 Shopify founders who pay for at least two apps. Time the five founder tasks on the harness shell and on today's console. Show them the app matrix in section 9 and ask which apps they would cancel. Decision rule: if fewer than 3 of 5 would cancel at least one app, or if missing reviews stop most of them, reopen OQ-07 before investing further. This needs your time with founders, not engineering.

## Phase 1, batch C

### Colours follow the brand, and unreadable colours can't be published (TOK-01, TOK-02, checkout width)
- [ ] **Checkout on your phone.** On your iPhone in Safari, open a store's checkout with one item in the cart. Pass: nothing moves sideways and "Payment" in the step row is fully visible. Chrome on the harness passed at 320, 360, 375, 390 and 414.
- [ ] **A real branded store on staging.** Open a tenant that has its own brand (pavos.in, for example) before and after this merges. Pass: the greys, buttons and links now follow its own background and text colours, and you are happy with how it looks. A store with no brand looks exactly as before.
- [ ] **The full flow on staging.** In Brand, type a dark text colour on a dark background and save. Pass: it saves, the "Hard to read" note names the problem and a colour to try, Publishing refuses with the same words, and the suggested colour publishes.
- [ ] **Decisions:**
  - The platform default look (no brand) keeps today's colours, so it keeps today's hard-to-read ones: small grey text (product types, old prices, captions) at 2.6:1, placeholders about 3.3:1, the wordmark accent in the footer and checkout, red error text on its pink panel at 4.36:1. Darken them (this changes the default look), or keep them?
  - Stores using the Pulse kit's own colours: their link and wordmark accent now use a darker lime (links #588a0c become #456c09) because the old shade read at 4.15:1. Keep?
  - Field outlines are about 1.3:1 on every store. Accessibility guidance asks 3:1 for a field's outline. Change them?
  - The suggested fix is the nearest colour that passes (for dark text on black it suggests a mid grey, #80808e). Would you rather it suggest near-white or near-black?
  - (Fix round 1) The platform default look's own hard-to-read pairs above are no longer shown to founders at all, and never stop a publish, even right after a store resets from its own readable colours (its faint grey text goes from about 4.9:1 back to 2.6:1). Should the Brand screen say so, or stay quiet as now?
  - (Fix round 1) A store with no brand on the Glow kit now shows a darker green for the header wordmark and hero highlight (#4d7c0f and #3f6212 instead of #a3e635, which read at 1.46:1 on Glow's cream). Happy with that shade?
- [ ] **(Fix round 1) A real store that resets its brand, on staging.** On a tenant with its own colours live and a theme pinned, press Reset on the Brand screen, then Publish. Pass: it publishes, and the store shows the platform's default look. Then apply the Pulse kit with "use its colours" ticked and publish. Pass: it publishes and the Brand screen shows no "Hard to read" banner.
- [ ] **(Fix round 1) A new store on Glow, on staging.** On a newly provisioned tenant (no brand), apply the Glow kit with both boxes unticked and publish. Pass: it publishes, and on your phone the header and hero green text is readable on the cream background.

## Bug-fix branches (not yet merged to main)
- [ ] **Payment confirmation when the database blips** (`claude/gallant-keller-7d3213`). Covered by tests with a simulated database. A real Turso run and a real Razorpay payment are yours.
  - On hosted Turso, check that a refused connection and a lost response give the error shapes the retry code expects. Only Node and a local sqld were tested.
  - In Razorpay test mode, stop the database during verify. Pass: the checkout page waits about 30 seconds, then shows "Confirming your payment", with a sensible message when no status link comes back.
  - After the pending message, press Pay again. Pass: Razorpay refuses a second payment for the same order.
  - On staging, once the duplicate-push fix lands: a browser callback and a webhook arriving together still produce one Shopify order.
- [ ] **Closed store sends nothing** (`claude/musing-williamson-4c86b3`). Only local `next start` on the edge runtime was tested.
  - On a staging tenant with maintenance on: a signed-out product page shows the closed page, view-source has no product title or description, and the tab reads "<Store> will be right back". A signed-in founder sees the real site.
  - On a phone and an installed PWA, with a tab open when maintenance starts, tap a product. Decide whether what it shows until reload is acceptable.
  - During a real maintenance window, watch Google Search Console and Merchant Center. Pages answer 200 with the closed page, and the sitemap answers 404.
  - Agency members signed in only with the `_agency` cookie still see the closed page. Is that intended?
