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

### Saves show at once, and a broken table is not a missing page (FIX-C)
- [ ] **Staging with several instances.** Save shipping rates in Settings and reload at once, five times. Save the brand, open Publishing at once, then click Publish now. Pass: every reload shows the saved rates and no "You haven't set your own shipping rates yet", Publishing lists the brand change at once, and Publish now answers 200, not 409.
- [ ] **Turso read-your-writes.** Confirm the control-plane database on staging and production is one Turso location read over HTTP, with no embedded or read replica serving console reads. Pass: yes, or a decision on how console reads reach the primary.
- [ ] **Hosted blips.** The fresh read of the store's row has no retry on Turso's occasional "fetch failed". On staging, watch the console for a day. Pass: no "Service temporarily unavailable" screens; if there are some, ask for a retry.
- [ ] **Staging schema fault.** On a throwaway staging tenant, break `cms_pages` (for example a view naming a missing column), open a page in the page editor, then save in the Designer. Pass: "This page hit an error" with Try again, then "Your changes were saved, but this page couldn't refresh…" after the save. Never a 404, never a silent save.
- [ ] **Safari and a real phone:** the Settings reload and the Publishing panel after a brand save. Pass: saved values show at once, nothing scrolls sideways.
- [ ] **Decisions:**
  - Shopper-facing settings (shipping rates, store name, checkout mode, payment key, maintenance) still reach shoppers up to 30 seconds late per instance. Accept, or version them too? (See also the rate mismatch below, which is being fixed.)
  - A store before its first Publish can show shoppers the old brand for up to 30 seconds after a save. Accept?
  - Other "old store" reads still treat any failure as empty (wishlist, bundles, automations, customers, experiments, notifications, media usage, history, templates, insights, content pages, slug redirects, support, incidents). Tighten them in a later item?
  - Client approvals (`/api/approve`) still compare against a brand up to 30 seconds old. Accept?

### Experiments stay out of the preview (PV-08)
- [ ] **Safari on a Mac and an iPhone.** Open the Designer with a hero test running, then "Open preview in a new tab". Pass: your own title shows in both, the purple note reads well at phone width, and "See the test" opens Experiments at that test in a new tab while the Designer keeps what you typed.
- [ ] **Staging with a real hero test.** Note the Results counts. Type, save and reload in the Designer, open a preview tab, browse the live store while signed in, and once leave the Designer open for over an hour before saving. Pass: no recorded `POST /api/exp`, and the exposure counts are unchanged.
- [ ] **Production after deploy:** repeat that on a real store with a running test. Pass: previewing and browsing while signed in never raise the counts.
- [ ] **A real Razorpay test payment on staging** (email snehal@mediastic.in, cancel each order after). In a browser that was counted as a shopper, sign in, open the Designer, then pay online. Pass: no new conversion. Then pay from a private window that never signed in. Pass: one conversion.
- [ ] **Decisions:**
  - A browser signed in to the console always sees your live hero, never the test's other version, and is never counted, on the live store too. Note: this holds only on the domain where you signed in; on another domain of the same store (www vs bare, platform subdomain vs custom domain) you are counted. Right, or do you want a "see what shoppers see" option?
  - A client opening an approval link sees the purple "A test is running…" note with a console link they may not be able to open. Keep or hide?
  - Approve the wording of both notes, including the screen-reader text "(opens in a new tab)".
  - Should the Home page editor's hero card carry the same note?

### Speed baseline (PERF-04)
- [ ] **OQ-11:** may engineers read real tenant sizes (counts of products, variants, collections, pages, posts, media, offers) for pavos or BeastLife? If yes, the perf fixture is resized to match.
- [ ] **OQ-19:** approve a private staging deploy of one test tenant, only for measurement. Without it, hosted numbers and budgets (and PERF-03, PERF-05, PERF-07) wait for the hosting phase.
- [ ] **Hosted numbers, once staging exists:** measure the same 11 requests on staging (TTFB, total, bytes, Turso reads, edge memory). Pass: a hosted run in `docs/perf/` with kind "hosted". Then write the first budgets into `docs/perf/budgets.json` and check that `node scripts/perf-report.js check <run> --budget docs/perf/budgets.json` passes, and fails when one number is pushed over. (The `test:perf-tools` guards that say "no hosted numbers yet" change at that point.)
- [ ] **Fixture size:** 400 products with about 3 options each, 30 collections, 20 pages, 60 posts, 12 home sections, 8 offers, 4 bundles. Does that look like a store you would onboard?
- [ ] **On Vercel staging, compression:** the home page response carries `Content-Encoding: br` or `gzip`. (Locally it does not.)
- (Library photos through `next/image` answering 400 locally was fixed in batch D, P1-IMAGES.)

## Phase 1, batch D

### Checkout charges the amount on the button, or nothing (P1-RATES)
- [ ] **Staging, cash.** Change the shipping rates, then within 30 seconds place a cash order as snehal@mediastic.in. Pass: "Shipping changed — your new total is ₹X. Review and place order." appears, the button changes to ₹X, and pressing again places the order at ₹X. Cancel the order after.
- [ ] **Staging, Razorpay test mode.** The same with Pay online. Pass: the first press is refused with no Razorpay window; after the redraw, the Razorpay window's amount equals the Pay button. Cancel the order after.
- [ ] **Decisions:**
  - Approve the wording "Shipping changed — your new total is ₹1,507. Review and place order." and "Your total changed — your new total is ₹X. Review and place order."
  - A browser tab opened before the deploy sends no amount, so it can't place an order until reloaded. Accept, or allow such requests for a short time after deploy?
  - Should the checkout page itself read the rates fresh, so shoppers rarely see the refusal? It costs one control-plane read per checkout view.

### Library photos show again (P1-IMAGES)
- [ ] **Vercel staging.** Open a product with media-library photos, a collection page and the cart. Pass: every photo shows, and the Network tab shows `/api/media/...` answering 200, not `/_next/image`.
- [ ] **Same photo, two stores.** On staging, open store A's `/api/media/<id>` on store B's domain. Pass: 404.
- [ ] **Page weight on a phone.** Library photos are now sent at full size (no smaller copies per width yet). Open a collection page with library photos on a mid-range phone and note the bytes. Pass: acceptable; if not, PERF-06 (smaller copies per width) moves up.

### Two hard-to-read texts, and the colour pairs TOK missed (P1-CONTRAST)
- [ ] **On your phone, on staging.** On a store with no brand, save a product that has no photo for later, open `/wishlist`, then open a policy page and, with an item in the cart, apply a working coupon. Pass: the "?" where the photo would be, the "Home" link at the top of the policy page, "Contact us" at its foot, and "Coupon" and "Remove" on the applied coupon are all easy to read in daylight. Chrome on the harness measured 4.8:1 or better on six looks.
- [ ] **Decisions:**
  - Every store, the default look included, now shows a darker grey for the wishlist's missing-photo "?" (#52525c, was #d4d4d8), the content pages' "Home" and "Contact us" links (#71717b, was #9f9fa9) and the words "Coupon" and "Remove" on an applied coupon (#52525c, was #71717b). These are the only default-look pixels this item changes. Keep?
  - About 1 in 1,000 unusual brands (a coloured background) that published before would now be refused at publish, because the applied-coupon words read under 4.5:1 on them. Stores already live with such a brand get a warning, not a refusal. Also, about 1 in 100 accent-only brands get a slightly different link colour on every page from the added pairs. Fine?
  - A store using the Pulse kit's own colours is still not pixel-equal to the same store with no brand: its lime surfaces are #a8eb43, not #a3e635, because a brand builds its own accent ladder. A shopper can't see it. It would take using the platform's built-in lime ladder whenever the accent is exactly #84cc16. Leave it?

## Phase 2, batch 1

### One publish is all or nothing (P2-ATOM)
- [ ] Approve the CI sqld download before anyone adds it to `.github/workflows/test.yml`: the source (tursodatabase/libsql release `libsql-server-v0.24.32`, asset `libsql-server-x86_64-unknown-linux-gnu.tar.xz`) and the SHA-256 you compute yourself. The exact step is in `docs/cms-reviews/P2-ATOM.md`. Until it is added, a pushed CI run fails on `test:publish`, because that suite never skips when sqld is missing.
- [ ] Hosted Turso, on a staging tenant: one publish; two concurrent publishes; a publish while another connection holds `BEGIN IMMEDIATE`; a lost answer after commit (the retry must report ok with single rows); replica read consistency right after a publish.
- [ ] DR-3: run `pnpm tenant:migrate -- --all` and then `-- --check`, so that 0021 is on every tenant before code that needs it deploys. 0021 seeds every tenant 'legacy'.
- [ ] DOC-12: restoring an export of a documents-mode tenant is not verified; only the export side is tested.
- [ ] Decide on the new `{failed}` outcome of `commitPublishBatch` (a refused statement with nothing written). P2-PUBLISH must handle it, for example as a 500 saying "Publish failed; nothing changed", never as a 409 rebuild.

### The reader version gate and the closed-store label (P2-VGATE)
- [ ] After deploy, look at the closed-store page of a closed glow-kit test store: the "Scheduled maintenance" label should be easy to read on the light background.
- [ ] Check that a closed pulse-1 (dark) store's page looks the same as before (the label falls back to accent-400).

## Phase 2, batch 2

### Section and link rules ignore built-in names (P2-REG)
No owner checks for this item.

### Old editors refuse on new-editor stores, and legacy publishes can't clash (P2-GUARD)
- [ ] OC-G1 Hosted Turso: two legacy publishes at the same time on a staging store should give one live release and one 'Another publish just went live, review again', with no orphan row in the releases list.
- [ ] OC-G2 Hosted Turso: schedule a release, then publish by hand just before its time. The scheduled release should be live afterwards.
- [ ] OC-G3 Before any real store changes mode, MIG-03 must move the mode check into each write's own statement. Today it is a separate check before the write.
- [ ] OC-G4 Desktop Chrome on the design harness with a test store in documents mode (not run): the Publishing page shows 'This store publishes with the new editor', the sidebar badge shows the dirty count, the Storefront overview shows the note, and every old editor's save shows the plain refusal.
- [ ] OC-G5 CI's sqld download still needs the owner's approval of its source and checksum. Nothing under .github/ was changed.

### Reused ids, bad builds and missing pages never report success (P2-HARDEN)
- [ ] CI sqld install step: still needs your approval of the source and checksum (same as P2-ATOM owner check 1). I did not touch .github/; test:publish fails in CI until the step is added.
- [ ] Hosted Turso on a staging tenant: repeat the P2-ATOM concurrency and lost-answer checks, and once publish a build that reuses another document's version id to confirm it ends failed with nothing written.
- [ ] Approve the new {failed} codes (BAD_BUILD, VERSION_ID_CLASH, RELEASE_ID_CLASH, MISSING_DOCUMENT, DB_REFUSED) and the reply mapping suggested in P2-HARDEN.md, then have P2-PLAN.md decision 2 updated before P2-PUBLISH starts (it still names three outcomes).

## Phase 2, batch 3

### Drafts, checkpoints and versions for the new editor (P2-DOCS)
- [ ] CI sqld install (carried from P2-ATOM): approve the libsql-server 0.24.32 release source and its SHA-256, then add the step from docs/cms-reviews/P2-ATOM.md owner check 1 to .github/workflows/test.yml. .github/ was not touched.
- [ ] Decide whether an image used only in an older document version (not live, not the draft) may be force-deleted, accepting that restoring that version then shows a missing image. Today it is always refused.
- [ ] Confirm the plain names in Earlier versions: 'Someone on your team' for people who left and for the shared store password, 'Storeasy' for support and automatic changes, and a teammate's email shown when they set no name.
- [ ] Hosted Turso, on a staging tenant in documents mode: one save; two saves racing from one revision (one 409); two creates racing at one slug (one 409 SLUG_TAKEN); a save while another connection holds BEGIN IMMEDIATE.
- [ ] Confirm the checkpoint interval of 5 minutes, or give the number to use.

### The storefront reads published documents, legacy stores unchanged (P2-READ)
- [ ] Hosted Turso replica consistency: publish on a staging tenant and load the home page right away. A missing version must render after the one re-read or show the error page, never defaults.
- [ ] Hosted perf numbers for the v4 home page, policy page, sitemap and /journal (OQ-19), after P2-PERF has the local numbers.
- [ ] DR-1 and DR-2 still apply: never roll back past P2-VGATE while any v4 pointer exists, and scan the fleet's live v values before deploy.
- [ ] CI sqld step: approve the pinned, checksum-verified libsql-server download from P2-ATOM owner check 1 before anyone adds it under .github/. Until then CI stays red on test:publish. This suite does not need sqld.
- [ ] After deploy, a legacy store's /journal and /sitemap.xml must list exactly what they listed before.
- [ ] P2-SECTIONS or OVL: home product rails read collection_overrides directly (lib/cms/section-data.js); pass v4 pins instead.
- [ ] P2-SECTIONS: move the home page to resolvedHomePage before a v4 store can hide its hero, because resolvedHero returns null on v4 when the hero is hidden.

## Phase 2, batch 4

### Publish one document or a set in one commit (P2-PUBLISH)
- [ ] CI sqld install (unchanged from P2-ATOM owner check 1): approve the libsql-server release source and SHA-256 before anyone adds the step to .github/workflows/test.yml. test:publish-service now needs sqld too, like test:publish.
- [ ] Hosted Turso on a staging tenant in documents mode: one publish; two publishes of different pages at once (both live); two of the same page (one 409); a publish while another connection holds BEGIN IMMEDIATE (ends live or 'busy', never half-written); a lost answer after commit (success, single rows); replica read right after a publish.
- [ ] Confirm the wording: 'Publishing is busy, try again in a moment: nothing was published. Your live store hasn't changed.', 'Your publish may have gone live. Reload to check.', the SLUG_TAKEN message, and 'Someone else published this page at the same moment…'.
- [ ] Confirm these decisions: set cap 200; 3 attempts before 'busy'; 404 for MISSING_DOCUMENT; a hidden section never blocks its document's publish; storefront.publish (owners and admins) for both publish and publishSet.
- [ ] ED-03: the editor must hold autosaves while a publish runs, or autosave can starve publish.
- [ ] DR-1/DR-2/DR-3 stand; move no real store to documents mode until the plan section 6 cutover gates (P2-SECTIONS home-page gate, OVL before MIG) are met.
- [ ] Browser drill of a policy typo publish while the home draft is dirty (P2-DRILLS), once a Publish button exists.

### Other content writers go through one door (P2-WRITERS)
- [ ] OC-W1 Desktop Chrome drill on the design harness, using your own ports (not run):
  - On a legacy test store whose hero has two buttons and a badge, adopt a hero variant and apply an AI hero idea. The Designer preview should show the new copy with the founder's buttons and badge.
  - Then switch the test store to documents mode and adopt again. The answer should say to publish from the editor; the doc_home draft should hold the change while the storefront stays unchanged.
- [ ] OC-W2 Confirm these intended behaviour changes on legacy stores:
  - AI hero drafts are now merged over the current hero, so buttons and badge are kept.
  - Agency and theme kit payloads are now validated, so a payload the editor would refuse gets 422 instead of being stored.
  - Agency kit sections get newly minted ids.
  - Each of these writes now adds an audit row and a history entry.
  - On a documents store, a kit keeps the founder's hero image.
- [ ] OC-W3 Before any store changes mode: MIG-03 must move the mode check into the write itself. Today it is a separate check just before the write (same as OC-G3).
- [ ] OC-W4 The CI sqld download (source and checksum) still needs your approval. Nothing under .github/ was changed.
- [ ] OC-W5 On hosted Turso: adopt once on a staging legacy store and once on a staging documents test store, and re-read each afterwards.
- [ ] Known limit to note: the theme route answers a hero conflict with 422 instead of 409. Its catch-all is outside this item's files. Nothing is overwritten.

### Preview sessions show saved drafts on documents stores (P2-PREVIEW)
- [ ] DR-3: run migration 0022 (pnpm tenant:migrate -- --all, then --check must exit 0) before this code deploys.
- [ ] CI sqld install (carried over from P2-ATOM): approve the libsql-server release and its checksum. .github/ was not touched.
- [ ] Look at a documents-mode preview yourself in desktop Chrome on the design harness: the bar's words, the Show them / Hide them toggle, an empty banner's placeholder, and that a private window sees only live content.
- [ ] Hosted Turso, on a staging tenant in documents mode: create a session, preview, toggle and revoke; also preview from another region right after a save (replica lag).
- [ ] Confirm the founder-facing words: the colours note and toggle, the other-tab note, and the unfinished-section note.
- [ ] Decide between a per-tab overlay (spec 8.8's set of documents with an open editor tab) and showing every saved draft, before ED-02 builds the editor side.

### Document service fixes from the batch 3 reviews (P2-DOCFIX)
- [ ] doc_cart capability ruling (upsells.write or storefront.*). Until then, document writes to doc_cart answer 409 CART_NOT_AVAILABLE. When it is decided, remove refuseCart in lib/documents/service.js and set the capability in lib/admin/documents-api.js.
- [ ] CI sqld install (carried from P2-ATOM): .github/ was not touched. Approve the libsql-server release and its SHA-256, then add the step from docs/cms-reviews/P2-ATOM.md owner check 1.
- [ ] Hosted Turso, on a staging tenant in documents mode: create a page while the network drops the answer (it must answer 200, never 'Another page already uses ...'), and check that rows read per autosave stay flat as publish_log grows.

## Phase 2, batch 5

### The hero is a real section, and every section renders through one map (P2-SECTIONS)
- [ ] In the Designer preview of a documents-mode store (harness only), leave a banner or rail unfinished. Check that the 'not finished yet' note shows and that clicking it selects the section. The rendered test covers this, but it was not checked in a browser.
- [ ] A hero image off the Shopify CDN is shown unresized (the full file goes to the browser). Decide later whether to restrict hero media in the validator instead.
- [ ] CI sqld download in .github/ still needs the owner's approval of its source and checksum (unchanged).

### Fewer and smaller storefront reads (P2-PERF)
- [ ] Review the round 2 catalog changes as their owners would: app/(storefront)/layout.js, lib/repo.js, lib/cms/section-data.js, lib/experiments.js.
- [ ] Optional: in desktop Chrome, open home, a collection page and a policy page on a store with both menus and on one without, and check the header and footer look as before.
- [ ] Hosted numbers (OQ-19): a store without its own header or footer menu now starts the nav collections read one database trip later. The harness store has both menus, so no local run measured this.
- [ ] Home's margin under 50 KB is about 680 bytes on the test store only. Decide whether the next cut (merging the five rails into one statement, about 2 KB) is wanted.
- [ ] The CI sqld download is still pending your approval of its source and checksum. .github/ was not touched.

### Publish, preview redirect and theme race fixes (P2-FIX4)
- [ ] OC-F1 (security, desktop Chrome on the design harness, own ports): /api/preview?to=/%5Cevil.com, ?to=/%09/evil.com and ?token=bad&to=/%5Cevil.com each land on the store's home page; ?to=/collections lands on /collections. Not run.
- [ ] OC-F2: confirm that structure problems in hidden or inherited sections block the document's publish (PUB-03 as written), including for migrated documents.
- [ ] OC-F3: confirm the hero-race words, then have components/admin/ThemeAdmin.js show the API's `note` (it shows its own toast today).
- [ ] OC-F4: confirm the pinned preview behaviour: when a store's mode can't be read, a founder's preview shows live content, not drafts.
- [ ] OC-F5: CI sqld download (source and checksum) still needs owner approval; nothing under .github/ was changed.
- [ ] OC-F6: hosted Turso staging documents store: a publish whose response is dropped after commit answers success with single rows.
- [ ] DR-1, DR-2, DR-3 stand; no real store is in documents mode.

## Phase 2, batch 6

### Phase 2 browser drills on the design harness (P2-DRILLS)
- [ ] Finding 1: decide whether signing out of the console must end the preview (suggested: logout clears the _preview cookie and revokes the person's preview sessions); today drafts stay visible in that browser for up to an hour after sign-out
- [ ] Finding 2: once ED-02's editor previews documents stores, check in a browser that clicking an unfinished note selects that section in the Designer
- [ ] Finding 3: decide whether a missing chrome-document version alone must give the error page (PUB-01 as written) or neutral chrome is enough
- [ ] Look at docs/cms-reviews/drills/P2-DRILLS/sections-* screenshots: are the clamped product names and collection titles the look you want
- [ ] P2-FIX4 OC-F1 is covered on the harness by the redirect part; repeat three hostile links by hand on staging
- [ ] CI sqld download (source and checksum) still needs your approval; .github/ was not touched
- [ ] On a real phone (Safari) and on staging: the hero with an image, the preview bar and colours toggle, a policy page
- [ ] DR-1, DR-2 and DR-3 stand; no real store is in documents mode

## Phase 3, batch 0

### Phase 3 suites and the documents API contract (P3-SCAFFOLD)
- [ ] CI sqld download: approving the source and checksum of the sqld binary for CI is still the owner's call; nothing under .github/ was changed.
- [ ] Rule on the contract choices in docs/cms-reviews/P3-SCAFFOLD.md (Design table) before batch 1 is cut: top-level revision on undo, unpublish and keepLiveSection; ok: true on every 200; the new code CANNOT_TAKE_OFFLINE; other.title kept beside other.label on SLUG_TAKEN; access on every listDocuments row; liveUrl null after a page is taken offline.
- [ ] Add scripts/test-api-shapes.js to P3-SCAFFOLD's files in docs/cms-reviews/P3-BATCHES.json, so the ownership check does not flag it.
- [ ] Staging: NOT DONE and not needed for this item; nothing touches the database or hosted Turso.

## Phase 3, batch 1

### One commit core, document refs and migration 0023 (P3-COMMIT)
- [ ] CI sqld download: approve the source and checksum of the sqld binary for CI (.github/ was not touched).
- [ ] Hosted Turso on a staging tenant: an undo-shaped batch (draft rewrite, undo_saved, refs, log) commits all or nothing, and one that loses a pointer race writes nothing. Proven only on a local file database and local sqld.
- [ ] Deploy order: run tenant:migrate --all --check (0023) before batch 2's Undo relies on linkersStatement, then re-seed the design harness. Publishing works without 0023.
- [ ] Ruling: liveEntryOf treats an entry as offline only when its row is enabled:false AND the document no longer points at that version, so a page hidden by its own meta.enabled keeps the inherited rule (the brief's wording is broader).
- [ ] Ruling: the support role's access reason wording ('Only the store owner or an admin can publish.').
- [ ] Orchestrator: merge the two out-of-list test edits, scripts/test-preview-overlay.js (owned by P3-CLOSED) and scripts/test-documents.js (owned by P3-VALIDATE).
- [ ] Orchestrator: P3-UNDO's whole-set query must say `WHERE set_id = ? AND set_id IS NOT NULL` to use the publish_log_set index as the brief defines it.

### Change rows between two versions (P3-DIFF)
- [ ] Wording ruling: read the row words listed in docs/cms-reviews/P3-DIFF.md Design ('Old addresses that lead here', 'Showing dates', 'Look: applied again', 'Banner 2', and 'Fonts' standing for text size) and say whether they suit a founder.
- [ ] firstPublishRows quotes the page title, as the brief asks. It is the only founder text any row carries. Confirm that is wanted.
- [ ] Phones drill (375 px) of the change rows in the Publish panel and the Undo confirm. This waits for P3-PUBLISHUI and P3-EDITOR, because no screen shows these rows yet.
- [ ] Staging NOT DONE: nothing here touches a database. P3-CHANGES and P3-UNDO wire this module into the API in batch 2.

### A store that has never published shows "Opening soon" (P3-CLOSED)
- [ ] Local production build: run docs/cms-reviews/drills/P3-CLOSED/rsc-probe.mjs against next build && next start on a closed copy of the harness and confirm 0 leaks.
- [ ] Ruling: catalog data (product, collection and search routes, and product page metadata) still answers on a closed store.
- [ ] Ruling: the spec's 'verified console session' is read as 'a valid preview session minted from the console'.
- [ ] Ruling: finding 3 gives the error page (built here) rather than neutral chrome; the /journal listing stays unguarded until test-perf-docs's statement count is updated by its owner.
- [ ] Phones: look at the closed 'Opening soon' page on a real phone (only checked at 375 in desktop Chrome).
- [ ] Staging: from a preview session on a closed store, place a COD test order with snehal@mediastic.in, confirm it reaches Shopify, then cancel it. The order carries no test mark because the orders table has no notes or tags column.
- [ ] Maintenance curtain: look at a maintenance store at 1440 to see whether its dark background shows; globals.css's unlayered body rule likely overrides bg-hero and text-hero-fg on body, as it did on the first closed-page screenshot.
- [ ] Follow-up (not owned here): add the two STORE_CLOSED messages to SHOPPER_CHECKOUT_ERRORS in lib/shopper-errors.js so a founder in preview sees the COD-only words instead of the generic line.
- [ ] CI sqld download: not touched (no .github change); its source and checksum still need the owner's approval.

### Logout ends that person's previews (P3-SESSION)
- [ ] Real browser logout (desktop Chrome) on a documents-mode test tenant: open the preview, log out, reload the preview tab. It should show the live store with no preview bar. On a legacy test tenant, the Designer preview should come back after logging in again.
- [ ] Rule on the known changes: logout ends that person's previews on every device; on a legacy store logout also ends the Designer's preview (logging in again re-mints it); bootstrap is one shared actor, so a bootstrap logout ends every bootstrap preview on that store.
- [ ] Accept the known limit that platform logout clears _preview but does not revoke operator-opened preview sessions (they expire within the hour).
- [ ] Hosted Turso staging run of the logout revoke: NOT DONE.
- [ ] CI sqld download (standing): .github/ was not touched; approving the sqld binary's source and checksum is the owner's call.

### Drafts keep unfinished values, and a broken section shows a note (P3-VALIDATE)
- [ ] Rule on plan decision 9: drafts now store in-section broken values, too-long page titles and descriptions, and menu items' bad links as incomplete (200). Phase 2 refused them with 422. Publish still refuses them.
- [ ] On phones and desktop, in a documents-mode preview: a banner with an off-store button, a hero with an off-store button, and a section that fails to render each show their note, and the live page shows neither the note nor the section.
- [ ] In the founder's preview, a header or footer menu item with an off-store link shows that link as typed. Accept this, or ask for a menu-level note.
- [ ] Hosted: force a failure on a staging tenant and check that section_render_failed and section_binding_failed lines show up in the Vercel log search.
- [ ] No desktop Chrome drill ran. The browser check of these notes waits for P3-EDITOR's drill.

## Phase 3, batch 2

### Publish checks, "publish both", publish again and the first publish (P3-CHECKS)
- [ ] CI sqld download (standing): .github/ was not touched; the owner must approve the sqld binary's source and checksum for CI.
- [ ] Ruling: missing alt text now warns at publish, where phase 2 blocked it (PUB-03 wording).
- [ ] Ruling: a closed store's first publish must include the home page (409 FIRST_PUBLISH_NEEDS_HOME); with no home page document yet the answer offers nothing (offer null). This holds until PUB-12 (open question).
- [ ] Ruling: a plain publish clears undone_version_id; the confirm guards only republishing the content that was taken offline.
- [ ] Ruling (standing from P3-COMMIT): liveEntryOf's narrower offline rule, under which a page hidden by its own meta.enabled keeps the inherited rule. Now pinned by tests.
- [ ] Wording review: the new founder messages in lib/documents/checks.js, the three new refusals, and 'another tab'.
- [ ] Hosted Turso staging tenant: publish both (one set, all or nothing) and publish again after take offline, through the real handler.
- [ ] Orchestrator: accept the out-of-list edits to scripts/test-failure-matrix.js and scripts/test-schema-compat.js, which open their stores with a home page first. Neither file has a batch 2 owner.
- [ ] Orchestrator: P3-PUBLISHUI must handle the openField action, offer on VALIDATION_FAILED and offer null on FIRST_PUBLISH_NEEDS_HOME. P3-HARNESS seeds and the drills (scripts/drills/p2/run.mjs) must publish the home page in a closed store's first set.

### Undo, whole-set Undo, take offline and Recently published (P3-UNDO)
- [ ] Wording/ruling: after the Undo of a publish made while offline, no further Undo is offered (the earlier unpublish row no longer matches); the founder publishes again or restores from Earlier versions. Confirm that is acceptable.
- [ ] The mutation runner (mut/run.py) was not rerun in fix round 1; the fix's own check was running the suite on the unfixed undo.js.
- [ ] Standing: hosted Turso staging check and the CI sqld download approval (.github/ untouched).

### The change list, keep the live section, keep as an earlier draft (P3-CHANGES)
- [ ] Staging (hosted Turso), documents-mode staging tenant: keepLiveSection and keepAsEarlierDraft, including two tabs keeping at once (the cap of 10 holds) and a stale keep whose 409 names the other person.
- [ ] Ruling: where a restored removed or moved section goes. I put it after its nearest live neighbour still in the draft; the brief says the live index clamped. Both agree when nothing around the section changed.
- [ ] Ruling: the TOO_MANY_KEPT words say 'Open Earlier versions to tidy them', but undo_saved versions can't be deleted today (the 0021 trigger and no delete operation). Either build a way to tidy kept drafts or reword the message.
- [ ] Ruling: PUT /api/admin/documents has no rate limit for any operation, so 'stays under the storefront.write rate limit' means only the normal auth plus the cap of 10. Decide whether to add a limiter (the route file is not in this item's files).
- [ ] Wording: 'another tab' (lower case, as the shapes give it) and the two keepLiveSection 404 sentences ('This page has never been published, so there is no live version to keep.' and 'That section is no longer in this page or on your live store. Reload to see the latest changes.').
- [ ] Merge: scripts/test-publish-service.js (stub loop and 'restored' check) and scripts/test-api-shapes.js (the NEW_CODES checks) were edited outside this item's ownership. P3-UNDO and P3-CHECKS will hit the same lines; keep both sides' changes.
- [ ] Browser: NOT DONE. No screen uses these operations yet. Drill them when P3-PUBLISHUI and P3-EDITOR land (the changes panel, 'Keep the live version', and 'Keep mine as an earlier draft').
- [ ] CI sqld download: still needs the owner's approval of its source and checksum (.github/ was not touched).

### The storefront side of the editor, preview only (P3-FRAME)
- [ ] On a staging tenant in documents mode (hosted Turso): check a preview, an ended preview (revoke it from another tab), 'See the live store', and 'Edit this page' from the live store with a console session.
- [ ] On the same staging tenant: force a section_render_failed and confirm it appears in the Vercel log search under the store's id.
- [ ] On a local production build (next build && next start): run docs/cms-reviews/drills/P3-FRAME/quiz-probe.mjs against a closed copy of the harness and confirm 0 of 12 answers carry founder copy.
- [ ] On the same production build: open a documents preview and confirm the data-field and data-doc attributes render (this checks the per-request holder under production React).
- [ ] On a real phone: look at the banner, the ended bar, the offline line and 'Edit this page' (so far seen only at 375 wide in desktop Chrome).
- [ ] Confirm the words: "You're seeing your unpublished changes." / "See the live store"; "Your preview has ended, so you're seeing the live store." / "Exit"; "This page is offline. Publishing it brings it back."; "Edit this page".
- [ ] Rule on the field names: data-field follows validate's paths (primary.label, button.label, items.N.q, items.N.a) instead of the brief's buttons.N.label and items.N.question/answer.
- [ ] Accept that on a closed store the 'Opening soon' page gets no bridge and no ended bar (P3-CLOSED's page is pinned byte-identical), so the editor relies on its 3-second re-mint there.
- [ ] Approve the source and checksum of the CI sqld download. .github/ was not touched.

### The phase 3 seed and shared drill helpers (P3-HARNESS)
- [ ] CI sqld download: not touched (no .github/ change). Its source and checksum still need the owner's approval.
- [ ] Optional: run DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p3/smoke.mjs once, and open http://closed.localhost:<port>/ in your own Chrome.
- [ ] Staging: NOT DONE. The harness is local only; whole-set Undo, take offline and LINKS_TO_UNPUBLISHED flows are proved by later drills once P3-UNDO and P3-CHECKS merge.

### The batch 1 review findings no other item owns (P3-FIX1)
- [ ] Ruling: logout ends previews on every device on documents-mode stores only; a legacy Designer preview cookie on another device lasts until it expires (up to an hour).
- [ ] Ruling: a cms_state read fault on a store with no release refuses checkout, contact and quiz until the database answers (fail closed, a known legacy change).
- [ ] Accept the deviation: app/api/preview/route.js (outside the item's file list, no batch 2 owner) answers JSON only when the editor's x-storeasy-preview-confirm header is sent. Without the header it answers as before.
- [ ] Desktop Chrome, at P3-EDITOR's drill: on a documents-mode test tenant, open the editor preview. Check the cookie is set by the confirm fetch, the network panel shows no request for '/', and the frame shows the draft. A spoilt token should show 'didn't open'.
- [ ] Read the three draft cap messages (too big to save, text too long to save, list too many to save) and confirm they suit a founder.
- [ ] Known limit to accept: publish has no body size limit, so a body over 512 KB with every field inside its own publish limit publishes but can't be saved as a draft (founders can't build one through saves).
- [ ] Known limit to accept: /api/leads on a store host now answers 429 after 5 calls an hour from one address, instead of 404.
- [ ] CI sqld download: unchanged (no .github/ change). Its source and checksum still need the owner's approval.

## Phase 3, batch 3

### The editor's store and the preview label (P3-STORE)
- [ ] Desktop Chrome at P3-EDITOR's drill: close a tab mid-save, reopen it, reload twice without answering the 'We found edits that weren't saved' offer, and confirm it is still offered and that leaving warns.
- [ ] Desktop Chrome: during a 409, click 'Use the newer version' and keep typing while it runs; Earlier versions should show the version with the extra text ('Kept from another tab').
- [ ] Ruling: each extra keep during 'Use the newer version' adds one more kept draft, so TOO_MANY_KEPT is reached sooner.
- [ ] Ruling: when two tabs type on one document at the same revision they still share one backup key (Known limits).
- [ ] Standing: the CI sqld download needs the owner's approval of its source and checksum (nothing under .github/ was touched).

### The inspector's forms and the ED-12 checklist (P3-INSPECTOR)
- [ ] After P3-EDITOR mounts the forms: in a menu or bar link, type the web name of an existing page, change 'Kind of page' to Campaign, and confirm that publishing is blocked with a missing-page note instead of going live to a 404.
- [ ] Decide whether lib/documents/checks.js referenceChecks should also compare the found page's web name and kind with the link, so that links saved before this fix with a stale document id are caught. That file is not owned by P3-INSPECTOR.
- [ ] CI: the sqld download needs the owner's approval of its source and checksum. Nothing under .github/ was changed.

### The section tree: add, move, hide, copy, delete (P3-TREE)
- [ ] Desktop Chrome, once P3-EDITOR mounts the tree on the design harness: add each kind to the home page and to a page; move, hide, show, copy and delete sections; check each new section is selected in the preview at once (ED-04) and the disabled buttons' tooltips read well. Browser verification is NOT DONE in this item (no host page).
- [ ] Wording ruling: the refusal sentences (for example 'The home page already has a hero. It can have only one.', 'Only one section can sit above the product details and buy button.') and the row badges 'Unfinished', 'Needs a fix' and 'Hidden'.
- [ ] Phones: the tree inside the editor's drawer below 1280 px, once mounted (ED-01).
- [ ] Product rail pick: P3-EDITOR or INSPECTOR must pass a real available_count with each collection; no repo function returns one today (carried from P3-VALIDATE and P3-FIX1).
- [ ] Staging: NOT DONE (nothing here touches a database).

### The publish panel, Undo, take offline, Earlier versions, Recently published (P3-PUBLISHUI)
- [ ] P3-EDITOR desktop Chrome drill on the design harness for these components, which are not browser-verified here. Cover: Publish with its review and Keep the live version; a 422 fix (hide or remove); Publish both, with Confirm off until every list loads; the republish question for an offline target; a first publish with and without a home page; Undo showing its change words; take offline with the linking pages; whole-set Undo with one page going offline; Earlier versions restore; Recently published with no Undo on rows that can't be undone.
- [ ] P3-EDITOR must pass the store's wrapper as `call` (plus keepLiveSection, onRestore, onDocument, and documentOf when it holds the draft), so a fix's saveDraft, keep-live, restore and Undo flush and hold autosave (plan A5). It must also pass checkLive, answered from GET /api/admin/releases `live`, for the PUBLISH_UNKNOWN release check.
- [ ] Staging on hosted Turso: a publish whose answer is lost (PUBLISH_UNKNOWN) is settled correctly by the check. NOT DONE.
- [ ] Owner ruling on the words: the level names 'Must fix', 'Check' and 'Already live like this'; the two offer reasons; 'Make your home page first'; the republish question; the whole-set Undo lines 'Live now' and 'Offline now'.
- [ ] Approve the source and checksum of the CI sqld download. Nothing under .github/ was touched.
- [ ] pnpm build failed once inside next/font/google (Fraunces font download) and passed on a plain rerun. If it happens again on CI, look at the font download, not this item.

### The editor's address, the old screens' redirects, the console nav, and the Designer's failed push (P3-ROUTES)
- [ ] Ruling: on the 8 redirected old screens, a cms_state read that fails keeps the old screen (its writes still refuse), while /admin/editor shows the error page. Accept this, or ask for the old screens to fail closed too.
- [ ] Ruling: in documents mode the sidebar's Storefront group is Editor, Media and Publishing only, and /admin/storefront/pages opens the home page.
- [ ] On a documents test tenant on staging (not a real tenant): open each of the 8 old addresses (storefront overview, designer, home, navigation, pages, product-pages, brand, theme) and confirm each lands in /admin/editor at the right document. On a legacy tenant, confirm the sidebar and those screens look as before. Staging is NOT DONE.
- [ ] CI sqld download: untouched (no .github/ change). Its source and checksum still need the owner's approval.
- [ ] Optional: run DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p3/routes.mjs on your Mac and look at legacy-designer-push-failed-1440.png.

### The batch 2 review findings no other batch 3 item owns (P3-FIX2)
- [ ] Orchestrator: classify() in lib/documents/publish.js still treats an unchanged section's link as already live when the same set hides or renames its target. This is older than P3-FIX2 and publish.js is outside this item's list, so it needs an owner.
- [ ] Owner: on a hosted staging tenant, publish the header together with the page its menu item links to, while hiding or renaming that page, and confirm it is refused (NOT DONE).
- [ ] Owner: the CI sqld download source and checksum under .github still need approval. Nothing under .github was touched.

## Phase 3, batch 4

### The new editor, put together (P3-EDITOR)
- [ ] On a documents test tenant on staging (not a real tenant), open /admin/editor, click 'See the live store' in the preview bar and come back. The preview label should say 'Updating' with 'Reconnecting…' the whole time until it says 'Up to date'.
- [ ] CI sqld download: still not touched (no .github/ change). Its source and checksum still need the owner's approval.

### The design document in documents mode (P3-DESIGN)
- [ ] On a documents test tenant on staging: apply a look, change a colour, preview with show-design on, publish, then Undo. After each step, check the operator overview, themes and tenant detail show the live kit.
- [ ] Rule on whether a never-published design should list token rows against the platform default (it does now) rather than showing first publish.
- [ ] P3-EDITOR: the switcher must list doc_design (Brand). Also decide where 'Apply this look with its starter brand' lives in the editor (POST /api/admin/theme with revision), or change DesignForm's help text, which still points to the theme screen.
- [ ] MIG-01: write config.theme_pin from the live design at cutover. Until then, a documents store that never published its design shows its legacy config.theme on the operator screens.
- [ ] Insight apply (lib/ai/insights.js) and experiment adopt (lib/experiments.js) should also say when they leave a draft that can't be published (later item; not my files).
- [ ] Merge the disclosed test edits in scripts/test-writers.js and scripts/test-cms-api.js with their owners.
- [ ] P3-DRILLS: repeat the design drill through the editor's Design form once P3-EDITOR lands.
- [ ] Approve the CI sqld download's source and checksum (.github was not touched).

### The rich text field (P3-RTE)
- [ ] Ruling: should lib/sanitize.js visibleText count a valid custom element name (lowercase, with a hyphen, closed or with attributes, such as <product-info id=...>) as markup, so a Shopify-theme or GitHub paste is cleaned on save instead of refused? And should a <noscript>'s text count as lost words? Until then the founder removes these in Edit as HTML. The change belongs to whoever owns lib/sanitize.js, and the AU-05 suites must still refuse <founder> and 'the <link> below'.
- [ ] The WORDS_LOST message in lib/registry/text.js ('This usually comes from < or > signs') does not fit a hidden-markup paste. Its owner could reword it.
- [ ] A real paste from a Shopify product page and from Word into the field in Chrome, once P3-EDITOR mounts it: check that the refusal note and Edit as HTML appear, and that removing the named tag lets the save through.
- [ ] pnpm build was not rerun after fix round 1. Only the field, its model, the suite and the drill changed.

### The batch 3 review findings (P3-FIX3)
- [ ] Desktop Chrome at P3-EDITOR's drill: a whole-set Undo where one page was new in that publish shows 'Undo all N pages of this publish? “<page>” goes offline.'
- [ ] Optional: a later item that owns scripts/test-publish-undo.js could commit the real-handler probe (createUndoFlow on a Recently published set with a new page, on both stores)
- [ ] Server design question: the dispatcher refuses an undo dry run without a revision even though undo.js ignores the revision on a dry run; the owner may decide whether dry runs should skip that check (service/documents-api are not this item's files)

## Phase 3, batch 5

### Every phase 3 drill, and the cross-item matrix (P3-DRILLS)
The drills ran in headless desktop Chrome on the design harness, on `next dev`, on this Mac. These are the checks only you can do (plan section 5, plus what the drills found).
- [ ] **Hosted Turso, on a staging documents test tenant (not a real tenant):** Undo, take offline, whole-set Undo, an Undo racing an autosave, and an Undo racing a publish (the second gets 409 "published elsewhere") are each all-or-nothing.
- [ ] **Local production build:** run the closed-store RSC probe against `next build && next start`. The drill (`matrix.mjs closed`) ran on `next dev` only. `scripts/drills/p1/prod-harness.mjs build` then `start` runs the harness on `next start`; the matrix's own runner starts `next dev`, so the probe would need running by hand against it.
- [ ] **Rulings to give:** finding 3 (a missing chrome version gives the error page, not neutral chrome); decision 4 (an offline page keeps its address until archived); decision 9 (the PV-02 draft-mode change); the first publish must include the home page; logout ending previews on every device and in legacy; catalog data on a closed store's product, collection and search routes; a console-made preview session counts as the "verified console session".
- [ ] **The five timed founder tasks with real people** (tasks 1, 4 and 5 are in scope). The drill timed a script, not a person: task 1 took 4 clicks, task 4 took 4 clicks starting from the live page, task 5 took 2 clicks from the same page and 3 from Publishing. Run them with 5 founders, read aloud, no help.
- [ ] **Phones:** the closed store's "Opening soon" page, the preview bar, and the offline line ("This page is offline. Publishing it brings it back.") on a real phone.
- [ ] **Deploy order:** run migration 0023 (`tenant:migrate --all --check` first) before the code that writes document refs.
- [ ] **Finding D1 (founder-facing, not shoppers):** with two editor tabs open, the older tab's design colours are turned on in its own preview session while the browser's cookie belongs to the newer tab's, so the older tab's preview keeps the old colours and still says "Up to date" (the frame's own bar does say "Your new colours are not shown here. Show them"). In `next dev` the same happens in one tab about half the time, because dev mounts the editor twice and makes two sessions. Decide who fixes it (`components/admin/editor/editorModel.js` preview controller, or `/api/admin/preview-session` showDesign by cookie). Then check one tab and two tabs on staging.
- [ ] **A banner on a page or campaign page doesn't render for shoppers** (P2-SECTIONS known limit, seen again here): the seed's spring guide links to the campaign through a banner, the publish check catches that link, but `/policies/<slug>` never shows the banner. Decide whether page routes should render banners (DOC-06) or the editor should not offer them there.
- [ ] **The test order:** the drill placed one cash on delivery order on the closed test store with `snehal@mediastic.in` and cancelled it at once (local harness database only; the harness has no Shopify keys, so nothing reached Shopify). On staging, place one COD order through a preview of a closed documents test tenant, then cancel it in the console and in Shopify.
- [ ] **Rich text paste:** P3-FIX4 (clean a web page's paste on save) was not merged when this ran, so the drill proved the "Edit as HTML" way out instead. After P3-FIX4 merges, run `node scripts/drills/p3/rte.mjs` and change its step 7 to expect the cleaned save.
- [ ] **CI sqld download:** still not touched (no `.github/` change). Approve its source and checksum.

### Rich text cleans a web page's paste on save (P3-FIX4)
- [ ] Desktop Chrome in the editor (P3-DRILLS or the owner): paste a product description copied from a live Shopify page into a rich text field and save. The words, bold and links come through, and the store shows them. NOT DONE here.
- [ ] P3-DRILLS must update `scripts/drills/p3/rte.mjs` step 7. It still expects the `<product-info>` paste to be refused with WORDS_LOST, but that paste now saves cleaned. A paste that is still refused, such as `<shop class="x">`, can drill the Edit as HTML way out.
- [ ] Ruling on option (b) as built: tags with a hyphen and whole `<noscript>`s are cleaned in the documents editor only, and the legacy editors stay strict.
- [ ] Ruling on wording: the refusal words that name the tag (both copies), the theme route's "hero look wasn't added" note, and the "can't be published yet" notes on insight apply and experiment adopt.
- [ ] Hosted staging (Turso): a design publish writes `config.theme_pin` with the targeted update; a slow platform database leaves the publish a success, with `documents_after_commit_timeout` logged.
- [ ] Known limit: a whole-row `patchTenant` running at the same time elsewhere can still put an old `theme_pin` back. `lib/platform/control.js` is outside this item.
- [ ] Still open from P3-DESIGN: should a never-published design that matches the platform default list nothing to publish?
- [ ] CI: the owner still needs to approve the source and checksum of the sqld download. Nothing under `.github` was touched.

## Phase 3, batch 6

### Design preview label, rte drill, theme pin hardening (P3-FIX5)
- [ ] Ruling: which tags the refusal words name. As built: a known, web-page (hyphenated) or Word element, or any name with an attribute that has a value, and only with real attributes. `<founder>` and `<sale-ends soon>` now get the "< or > signs" words.
- [ ] Ruling: the local-backup version note reads "Edits this browser kept".
- [ ] Review the three files outside the plan list needed for the backup note: `components/admin/editor/store.js`, `lib/admin/documents-api.js`, `lib/documents/versions.js`.
- [ ] Desktop Chrome on a staging test tenant: with two editor tabs, open Brand in tab A after tab B opened Home and change the accent. A's preview should show the new colour, and say Up to date only once it does.
- [ ] Hosted Turso staging: a design publish writes `theme_pin` and `theme_pin_at`; a tenant with config that is not valid JSON is left unchanged and `documents_after_commit_failed` is logged.
- [ ] Production build: the editor opens one preview session per editor open.
- [ ] CI: approve the sqld download's source and checksum (nothing under `.github/` was touched).

## Phase 4, batch 0

### Phase 4 ground: migration 0024, ids, editability, fixture (P4-SCAFFOLD)
Packet: [P4-SCAFFOLD.md](P4-SCAFFOLD.md), section "Owner checks".
- [ ] Owner step: apply 0023, 0024 and 0025 on every tenant and on the env store before code that reads or writes them deploys. Run `pnpm tenant:migrate -- --all`, then `pnpm migrate` (the env store), then `pnpm tenant:migrate -- --check --include-env`, which must exit 0 (`migrations/README.md`, "Phase 4").
- [ ] CI: approve the source and checksum of the sqld download under `.github/` before CI runs the phase 4 sqld suites. Nothing under `.github/` was changed.
- [ ] OQ-6, the `doc_cart` ruling: `CART_EDITABLE = true` is the default in `lib/registry/editability.js`. Confirm it before batch 2 (LIVEROW and MAPPER).
- [ ] Orchestrator: add `scripts/test-publish.js` (one assertion relaxed to "0023 and later") to P4-SCAFFOLD's file list, and name an owner to add the new 0024 tables to `lib/platform/export.js`.
- [ ] Orchestrator: the operator commands carry no `--env-file=.env.local`. If CUTOVER's hosted owner run needs it, `package.json` must change, and only SCAFFOLD may edit it.

## Phase 4, batch 1

### The mode check moves into every old write's own batch (P4-GUARD)
Packet: [P4-GUARD.md](P4-GUARD.md), section "Owner checks".
- [ ] Hosted Turso batch atomicity on staging, before the first real cutover: with `cms_state` set to 'migrating', a legacy save must give the plain refusal and write nothing.
  - P4-DRILLS (fix round 1): the only pass is the batch guard's words, "Your store is being updated. Try again in a few minutes." An ordinary legacy save is refused before any batch is sent ("This store is moving to the new editor right now, so nothing was saved…"), which proves nothing about Turso. No step reaches the guard on staging yet: OPEN decision, see runbook 0.3.
- [ ] OQ-5: confirm that product webhooks may keep writing while a store is migrating (an allowed difference in the data check), or ask for them to be queued instead.
- [ ] CI: approve the source and checksum of the sqld download in `.github/`. This item changed nothing there.
- [ ] Desktop Chrome drill was NOT DONE for this item. P4-DRILLS could rehearse it on the harness: a store set to 'migrating', every old editor refusing in plain words, and the sync showing as paused.
  - P4-DRILLS (runbook stage, desktop Chrome on the harness): DONE for a store stopped in 'migrating': an old editor's save is refused in plain words and nothing is saved, shoppers still get the store, `--status` and `--abort` recover it. The sync pause was not drilled (a sync would need Shopify): it stays an owner check on staging.
- [ ] Orchestrator: add `scripts/test-release-readers.js` to P4-GUARD's files. Only its fixture changed: an `asLegacy` helper.
- [ ] Orchestrator, ED05 or a route owner: the catalog POST and upsells POST/PUT routes answer an in-batch refusal as 422, and upsells DELETE answers 500. The words are plain and nothing is written. These routes should map `e.expose` 4xx errors before their catch-all.
- [ ] CUTOVER: cancel pending `publish_release` jobs at the lock. The scheduled job's pre-check still throws on a store that is already off legacy, and the queue then dead-letters it.

### The reference index and the media archive (P4-MEDIA)
Packet: [P4-MEDIA.md](P4-MEDIA.md), section "Owner checks".
- [ ] Still recommended after deploy: run `pnpm media:reindex -- --tenant <id> --releases` on each documents-mode store (staging, harness, test stores). It is now cleanup, not a safety step. It is still needed to index old checkpoints and Undo-saved versions, which had no refs before this branch.
- [ ] CI sqld download under `.github/` still needs owner approval of source and checksum (unchanged).
- [ ] Apply 0025 with 0023 and 0024 on every tenant and on the env store before this code deploys (`pnpm tenant:migrate -- --all`, `pnpm migrate`, then `pnpm tenant:migrate -- --check --include-env` must exit 0). A store without 0025 lists media as before and refuses archive in plain words.
- [ ] Staging, after the reindex: in a documents-mode store, try to delete an image that only an older version uses. Pass: the dialog lists the page with "(older version)" and the forced delete is refused too.
- [ ] Decision (MANUAL-CHECKS.md line 44 and P4-MEDIA Design (6)): keep the default, or ask for the legacy catch blocks to fail closed as well (that would change legacy usage output and `test-releases`).

### Legacy tenants for phase 4 tests (P4-FIXTURES)
Packet: [P4-FIXTURES.md](P4-FIXTURES.md), section "Owner checks".
- [ ] Orchestrator: add `scripts/test-documents.js` (one allowlist line naming `scripts/support/legacy-tenants.js` in the documents-writer scan) to P4-FIXTURES' file list.
- [ ] Carried from P4-SCAFFOLD: the CI sqld download in `.github/` needs the owner's approval of its source and checksum. This item changed nothing under `.github/`.
- [ ] LIVEROW and CUTOVER: check that the stale-backfill fixture writes the same live-row columns you define as legacy-derived (badge, modules, pairs, pinned), and adjust the fixture if they differ.

### The content getters against a given source (P4-SEAM)
Packet: [P4-SEAM.md](P4-SEAM.md), section "Owner checks".
- [ ] None new from this item. Nothing calls the seam on a real tenant until P4-CUTOVER, whose runbook and rehearsal cover the MIG-02 data check.
- [ ] Staging NOT DONE: nothing ran against hosted Turso; this item is local and unit-tested only.

## Phase 4, batch 2

### One effective read of product content (P4-EFFECTIVE)
Packet: [P4-EFFECTIVE.md](P4-EFFECTIVE.md), section "Owner checks".
- [ ] OQ-7: confirm nothing in the browser needs `catalog_title` or `sku` in the cart. They are now removed from every cart a browser receives.
- [ ] Gift line titles: confirm "the founder's published title, else the title the offer stored". The alternative is Shopify's title, which would visibly change gift names on stores that have no published content today.
- [ ] Gift lines on a store where nothing is published for the product keep the title and the image the offer stored (not Shopify's). Confirm this on staging with a real gift offer.
- [ ] Hosted speed (after OQ-19): measure the cart API and a product page on a staging tenant and confirm the database reads stay at 3 and 10 as in PERF-04.
- [ ] CI: the sqld download under `.github/` still needs the owner's approval of its source and checksum. This item changed nothing under `.github/`.
- [ ] Phone and Safari check of a renamed product's page, card and cart once P4-LIVEROW can publish. The drill here only used the app's narrow built-in browser pane.

### Product and collection content publish as live rows (P4-LIVEROW)
Packet: [P4-LIVEROW.md](P4-LIVEROW.md), section "Owner checks".
- [ ] OQ-6 cart ruling (default applied): staff can now edit `doc_cart` but need an owner or admin to publish it. Confirm.
- [ ] OVL-13 gallery allowlist pulled forward: only `cdn.shopify.com` and `/api/media/<id>` images go live. Confirm no store uses images from other hosts in product galleries.
- [ ] OQ-14 on a dev store: do Shopify image addresses differ only by their query string? The "same as Shopify" rule strips the query before comparing.
- [ ] The editor's caps are below Shopify's own limits: at most 30 gallery images and 20,000 characters of description. Confirm these caps are acceptable (a Shopify product with more images or a longer description is shown as it is until the founder edits it).
- [ ] Check that hosted Turso batches are atomic for the new live-row batch (no release row; guarded UPDATE plus abort) on staging, before the first real cutover.
- [ ] CI: the sqld download in `.github/` still needs the owner's approval of its source and checksum. `test-product-content` needs sqld and fails, never skips, without it.
- [ ] Orchestrator: add `scripts/test-documents.js` and `scripts/test-doc-changes.js` to this item's file list (changed for the cart ruling and the fixed ids).
- [ ] Desktop Chrome drill: NOT DONE (nothing visible yet); left for P4-DRILLS after P4-EDITOR.

### The legacy store as documents, and a read-only dry run (P4-MAPPER)
Packet: [P4-MAPPER.md](P4-MAPPER.md), section "Owner checks".
- [ ] Owner: run a real dry run per store before its rehearsal: `pnpm migrate:documents -- --tenant <id> --dry-run --hosted --confirm <id>`, adding `--store-open` or `--not-launched` for a store that never published. Read the plain report with the founder and keep the digest for CUTOVER. Builders never ran this.
- [ ] Owner (OQ-6): confirm with the team the staff line under "Team access that changes": staff can change the cart offer but an owner or admin must publish it.
- [ ] Owner (OQ-8): confirm that saved templates being counted, and kept readable on ED05's saved templates page, is enough.
- [ ] Owner: after a real cutover of a store whose home was half customized, open the new editor's home page and check that the hero title note reads sensibly. The title follows the store name by being left out, which the editor flags as missing.
- [ ] Orchestrator: no reader owner fills a literal `{store_name}` token. If a real token is wanted, name an owner for `resolve.js` and `documents-reader.js` (OVL07 or later).
- [ ] Orchestrator: P4-OVL07 must fill `lib/migrate/map-entities.js` (contract at the top of the file). Until then every store holding product or collection content is refused.
- [ ] Orchestrator: the six comparison rules for differences shoppers can't see live in `lib/migrate/check.js`. CUTOVER may move them into `allowed-differences.js`.
- [ ] Owner: the CI sqld download in `.github/` still needs approval of its source and checksum (carried from P4-SCAFFOLD; nothing under `.github/` changed).

### The phase 4 drill harness and local tenants (P4-HARNESS)
Packet: [P4-HARNESS.md](P4-HARNESS.md), section "Owner checks".
- [ ] If you already have a local-tenants build from before this fix (for example in `.design-data/p4-local`), delete that folder by hand once. Its manifest has no tool field, so a rebuild into it is now refused.
- [ ] CI sqld download (carried over): its source and checksum still need your approval; nothing under `.github/` was touched.
- [ ] The P3 smoke's document refs check (22 "orphan" refs): decide whether the P3 drill is updated to count checkpoint refs, or the check is accepted as known after P4-MEDIA. P4-DRILLS confirmed the cause: the check counts only published versions, and P4-MEDIA now writes refs for checkpoints and Undo-saved versions too (P4-DRILLS.md, Known limits).
- [ ] Before each rehearsal: make the restore-drill copy on your own Mac only, and delete it (and its `-wal` and `-shm` files) afterwards. It holds customer data.
- [ ] Optional: run `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p4/run.mjs seed,smoke` once on your Mac and open the chosen product (`/products/micronised-creatine-12`) and `/collections/protein` in your own Chrome.

## Phase 4, batch 3

### Search and the console read the names shoppers see (P4-SEARCH)
Packet: [P4-SEARCH.md](P4-SEARCH.md), section "Owner checks".
- [ ] On staging with a real Typesense: publish two renames of the same product within about a second, then confirm search shows the second name once the job tick has run.
- [ ] The job tick: confirm the hosted scheduler runs `runDueJobs` often enough for `search_reindex` retries, including the new 'kept changing' give-up.
- [ ] Typesense stores, `_default` included: after the first rename on each, search shows the new name within a few minutes (the reindex job and the tick are running), and a full sync keeps it.
- [ ] Hosted publish latency: a publish on a Typesense store waits for the inline reindex (capped at 2.5 s). Check it feels instant on staging.
- [ ] Phone and Safari: the order page's "Shopify title" line was measured in desktop Chrome only.
- [ ] CI: the sqld download in `.github/` still needs the owner's approval of its source and checksum.

### Product and collection content on the shopper side (P4-OVL07)
Packet: [P4-OVL07.md](P4-OVL07.md), section "Owner checks".
- [ ] Old module HTML: on stores whose product modules were saved before sanitizing, the dry run reports a shopper change on those products (the cleaned HTML). Decide per store whether that is acceptable, or have CUTOVER list it in `allowed-differences.js`.
- [ ] Spec 8.9 deviation (plan section 2): a product's or collection's draft shows to any valid documents preview session, on that page only, not only when it is open in the editor. Confirm this is acceptable.
- [ ] Documents stores fail closed: when a product's own content row can't be read, its page shows the error page instead of the product (on the old editor only the extras were hidden). Confirm, and watch the error rate on product pages for the first day after each move.
- [ ] Hosted speed (OQ-19): on a staging documents store, measure the product page (one more statement: the content row) and the collection page (two more: the handle's id and the row) against the local counts.
- [ ] Phone and Safari: the drill ran in desktop Chrome only.
- [ ] Staging (hosted Turso): nothing ran against a hosted store; product and collection content on a real cut-over store waits for CUTOVER's runbook.
- [ ] CI: the sqld download in `.github/` still needs the owner's approval of its source and checksum (nothing under `.github/` was changed).

### The library picker, gallery, pairs and pins, and media archive (P4-PICKER)
Packet: [P4-PICKER.md](P4-PICKER.md), section "Owner checks".
- [ ] On a phone and in Safari: open a product's content in the editor, add a library image to its images, and archive an unused file on the Media screen.
- [ ] After P4-SEARCH merges: in the pairs and pinned-products lists, check that a renamed product shows its new name with 'Shopify title: …' under it.
- [ ] CI sqld download: nothing under `.github/` was changed. Its source and checksum still need the owner's approval (carried over from P4-SCAFFOLD).

### The MAPPER review's findings (P4-FIX1)
Packet: [P4-FIX1.md](P4-FIX1.md), section "Owner checks".
- [ ] `{store_name}` binding: decide between keeping 'no title of its own' and a real store-name token. Keeping it: the first edit to any hero field blocks publishing until the founder types a title, which then stops following the store name, and experiments' `unpublishableDrafts` reports a migrated half-customized home as blocked. A token needs a named owner for `resolve.js`, `documents-reader.js` and the home page. After a real cutover, open the home page in the editor and try a subtitle-only experiment adopt.
- [ ] A real hosted dry run per store (owner only): `pnpm migrate:documents -- --tenant <id> --dry-run --hosted --confirm <id>`, with `PLATFORM_DB_URL` and its token in the environment; check that the Details 'routes given to the data check' list covers the store's pages and old addresses.
- [ ] P4-CUTOVER note: rehearsal and cutover version and release ids may differ while source hashes match (a Shopify handle change of a cart product); compare source hashes only.
- [ ] The CI sqld download in `.github/` still needs the owner's approval of its source and checksum (unchanged here).

## Phase 4, batch 4

### The new product and collection editor (P4-EDITOR)
Packet: [P4-EDITOR.md](P4-EDITOR.md), section "Owner checks".
- [ ] Desktop Chrome on a staging test tenant: open a product from the editor's product list, rename it, publish, then check the product page, a card, search and the cart. Then Reset and publish.
- [ ] Typesense stores: after a rename, search shows the new name within a few seconds (P4-SEARCH reindex). The local drill had no Typesense.
- [ ] Design editor: with the design open, the frame's bar no longer offers 'Hide them'; on the home page it still does.
- [ ] Phone and Safari: check the product form and the switcher at phone width.
- [ ] CI: the sqld download in .github/ still needs your approval of its source and checksum. Nothing under .github/ was changed.
- [ ] Orchestrator: add these files outside the plan's list to P4-EDITOR's files: lib/admin/entity-entry.js, components/admin/editor/PreviewPane.js, scripts/drills/p4/editor.mjs, docs/cms-reviews/drills/P4-EDITOR/.
- [ ] Per-tab overlay: the rule that the Home tab must not show another tab's unpublished colours waits until the per-tab overlay lands.
- [ ] Only the first 50 collections show in the editor's switcher. Confirm that is enough for every store, or ask for a search there.
- [ ] A collection page fails closed when its live row can't be read (the error page instead of the collection). Confirm, with the pins decision under P4-FIX2.
  - P4-DRILLS ran the rename, publish, product page, card, search, cart and Reset on the harness in desktop Chrome (product stage, and the P4-EDITOR drill again): DONE on the harness; the staging run stays yours.

### Old admin addresses lead to the editor (P4-ED05)
Packet: [P4-ED05.md](P4-ED05.md), section "Owner checks".
- [ ] Desktop Chrome drill on the design harness (P4-DRILLS routes stage), on a documents store. Old addresses land in the editor: catalog ?product=, upsells, both designers, an existing page slug and a missing one. The bare /admin/catalog shows the Products link plus Bundles and Quiz. The setup links open the editor. /admin/editor/templates lists templates and 'Make a page from this' opens a new draft. A page with an old banner shows the note and publishes. Legacy stores are unchanged.
  - P4-DRILLS routes stage: DONE on the harness in desktop Chrome, except the old-banner page (not drilled: NOT DONE). The rest stays for a staging look.
- [ ] Owner decision: keep the bare /admin/catalog for Bundles and Quiz until ED-06 (current build), or move them first and then redirect.
- [ ] OQ-8 saved templates default: not converted, read-only with 'Make a page from this'. Confirm.
- [ ] Orchestrator or P4-EDITOR: make the editor read ?list=products and ?list=pages, and link /admin/editor/templates from its pages section.
- [ ] Orchestrator: add the files beyond the plan's list to P4-ED05's files: treeModel.js, lib/documents/service.js, app/api/admin/upsells/[id]/route.js, lib/admin/saved-templates.js, components/admin/SavedTemplates.js, and the test-editor-tree, test-registry-contract and test-publish-checks updates.
- [ ] Known limit for a later item: the agency kit export (lib/platform/agency.js) still reads the old hero, announcement and home sections on documents stores.
- [ ] CI: the sqld download in .github still needs the owner's approval of its source and checksum (nothing under .github was changed).

### The before-and-after page comparison (P4-EQUIV)
Packet: [P4-EQUIV.md](P4-EQUIV.md), section "Owner checks".
- [ ] CI sqld download: no .github/ change was made. Its source and checksum still need the owner's approval (carried over from P4-SCAFFOLD).
- [ ] Before the first real cutover, the owner reads the rendered comparison in CUTOVER's rehearsal report and approves the two allowed differences in lib/migrate/allowed-differences.js (section-ids, hero-test-variant), or says which to drop.
- [ ] The owner decides whether to pause a running hero test during the rehearsal so the hero is also compared as a page, or to accept the data-only comparison of the hero (hero-test-variant).
- [ ] The rendered comparison masks `/_next/static` asset addresses, full date-times and `id` attributes, so a change only there is never reported. Confirm.
- [ ] P4-DRILLS finding F2: while a hero test runs, a rehearsal can fail on the home page's hero alone, because Next sometimes splits the hero test's ping inside its streamed data and the comparison then can't see the test. Rehearse again when only the hero differs, until the comparison is fixed (P4-DRILLS.md, Findings).
- [ ] Old module HTML that today's sanitizer rewrites (MANUAL-CHECKS.md line 568): the owner decides per store whether CUTOVER adds it to ALLOWED_DIFFERENCES or it is fixed before the move.
- [ ] Orchestrator: P4-CUTOVER's scripts/test-migrate-documents.js must import ALLOWED_DIFFERENCES from lib/migrate/allowed-differences.js and assert the same list. Add a pnpm migrate:render script only if the runbook needs one (package.json is SCAFFOLD-only). Add docs/cms-reviews/drills/P4-EQUIV/results-harness.json to the plan's file list.
- [ ] Optional: the owner reruns the harness check on their own Mac: capture twice with node scripts/migrate-render.mjs --base http://localhost:<port> --routes <file> --out <dir>, then --compare (expect exit 0).

### Batch 3 review fixes (P4-FIX2)
Packet: [P4-FIX2.md](P4-FIX2.md), section "Owner checks".
- [ ] Browser NOT DONE: on a legacy store's media screen, delete a file used by an old home section and by a page draft. Expect no 'Delete anyway', the fixed words, and the places in plain words.
- [ ] Browser NOT DONE: upload a file whose bytes match an archived file. Expect '<file> was archived. It's back in your library now.' and the file back in the picker.
- [ ] Browser NOT DONE: open a product with an unpublished draft in the editor and save. The frame should report up to date once the product page shows the draft. This depends on P4-EDITOR's wiring.
- [ ] Typesense tenants: after a search outage that overlaps a full sync, check that a search_reindex job with a ':sync:' key runs and that search then shows the published names.
- [ ] test:migrate-map now starts a sqld, as test:publish does. CI's sqld download still needs the owner's approval of its source and checksum; nothing under .github/ was changed.
- [ ] Owner/CUTOVER decisions: when a live-row read fails, the product page still shows the error page (modules and badge read the same row and fail closed), and collection pins still fail closed. Decide whether pins should degrade too.

## Phase 4, batch 5

### Moving a store to the new editor (P4-CUTOVER)
Packet: [P4-CUTOVER.md](P4-CUTOVER.md), section "Owner checks".
- [ ] Staging, before the first real move: hosted Turso batch atomicity (runbook step 0.3).
- [ ] PITR: confirm the Turso plan has point-in-time restore; record the time just before each real move (`--backup-ref`).
- [ ] Per store: the dry run read with the founder, a rehearsal on a restore-drill copy served by the local harness, the real move and the post-checks (runbook steps 1 to 7). Serving the copy needs the store's control-plane row copied into the harness by a developer for now (runbook 3.2).
- [ ] OQ-5: product webhooks keep writing while a store is migrating (an allowed difference). OK, or should they be queued?
- [ ] Sanitized module HTML: accept it as an allowed difference, or have the founder save those modules again before the move.
- [ ] Hosted theme pin: the move writes the control plane; check the platform console shows the store's kit after each move.
- [ ] Brand or theme edits made on the control plane (the platform console) during a move are not caught by the recheck after the pause. Don't change them while a move runs.
- [ ] CI: the sqld download in `.github/` still needs the owner's approval of its source and checksum.
- [ ] Phone and Safari: not run (desktop Chrome only).

### New stores start on the new editor (P4-PROVISION)
Packet: [P4-PROVISION.md](P4-PROVISION.md), section "Owner checks".
- [ ] Staging: run `scripts/provision-tenant.js` (the console's New tenant form was retired in Phase 1 line 9; New store refuses a taken address before anything runs) with the slug of an existing throwaway legacy tenant. It should be refused, and that tenant should stay on the old editor (cms_state 'legacy', storefront still open).
- [ ] Before deploy: 0024 and 0025 applied everywhere. Check that no provisioning run is half-done on the hosted control plane (`/platform`, provisioning runs). A resumed earlier run keeps the old editor, as designed.
- [ ] OQ-4, staging, after P4-PROVISION deploys: provision one throwaway tenant (no `--legacy-content`). It starts on the new editor ("the new editor … private" in the summary), shows "Opening soon" to shoppers until its first publish (the sitemap only `/`), and every link of its onboarding checklist opens a working screen (Design, Pages, the editor, Publish). A COD test order from the editor's preview goes to `snehal@mediastic.in` and is cancelled after. The first publish opens the store and Setup shows Launch done. Then offboard it.
- [ ] Desktop Chrome on the design harness: the Setup page of a new documents store before and after its first publish, and the preview test order. NOT DONE (no P4-DRILLS stage provisions a store).
- [ ] Decide whether `/platform/stores/new` ("New store", Phase 1 line 9, which replaced "New tenant") needs a "start on the old editor" choice (today only the CLI has it).
- [ ] Phase 1 line 9, staging: create a store from New store with a real (test) Shopify app's id and secret; the owner invite arrives through the real mail provider; the founder accepts, connects Shopify through the redirect URL shown on the done screen. Without production mail configured every operator-made store waits for an operator to press Resend invite.
- [ ] CI: the sqld download in .github/ still needs the owner to approve its source and checksum. Nothing under .github/ was changed.

### The P4-EDITOR review findings (P4-FIX3)
Packet: [P4-FIX3.md](P4-FIX3.md), section "Owner checks".
- [ ] Desktop Chrome on a staging test tenant: give a product your own description and check Shopify's shows beside it as plain text. Change the description in Shopify, wait for the catalog update and reopen: the notice should read in plain words. Then switch to another product from the product list: the first product's name should never show with the second's Shopify title.
- [ ] Catalog page on a documents store: the header should say the brand and product type shoppers see are set in the editor.
- [ ] Phone and Safari: check the product form at phone width.
- [ ] CI: the sqld download in .github/ still needs the owner's approval of its source and checksum. Nothing under .github/ was changed.
- [ ] Orchestrator: add docs/cms-reviews/drills/P4-FIX3/ (the drill and its results) to P4-FIX3's file list.

### Review findings of P4-EQUIV, P4-ED05 and P4-FIX2 (P4-FIX4)
Packet: [P4-FIX4.md](P4-FIX4.md), section "Owner checks".
- [ ] Desktop Chrome on the design harness (P4-DRILLS): on a documents store the editor's product and collection pickers list as before; with the live release made unreadable on a local copy they still list products; /admin/upsells still redirects to the editor. Browser verification for this item is NOT DONE.
  - P4-DRILLS: the pickers listing on a documents store (product, collection, picker and editor stages) and the /admin/upsells redirect (routes stage) are DONE on the harness. The unreadable live release case was not drilled: NOT DONE.
- [ ] On a legacy store, a failing mode read now answers 503 on the upsells GET and on the cms-api page reads (instead of showing old data). Confirm on staging.
- [ ] P4-CUTOVER rehearsal: run --make-routes on the restore-drill copy. If a hero test is running, the command says so and routes.json carries its slug. An exit 2 from --compare means the harness was broken before the move: fix it and capture again.
- [ ] P4-CUTOVER's test-migrate-documents must pass fixture.heroExperiments to compare() when it replays the ALLOWED_DIFFERENCES fixtures.
- [ ] Staging and production are NOT DONE: nothing ran against hosted Turso or a real Typesense, and nothing was pushed or deployed.
- [ ] CI sqld download in .github/ still needs the owner's approval of its source and checksum (not touched here).

## Phase 4, batch 6

### Moving a store back to the old editor (P4-REVERSE)
Packet: [P4-REVERSE.md](P4-REVERSE.md), section "Owner checks".
- [ ] Staging, before the first real reversal: move a staging store, rename a product, then run runbook section 9. The product should show Shopify's name on its page, in collections and in search; the old editors should save; the platform console should show the old kit.
- [ ] Typesense stores (_default included): after a reversal, search shows Shopify's names within a few minutes, with the reindex job and the tick running. After the next move it shows the restored names.
- [ ] Read the reversal report's 'A message you can pass on' with the founder and confirm the wording.
- [ ] OQ-9 default: product names, descriptions, photos and the brand and type shown come back at the next move; everything else published in the new editor stays as older versions. Confirm this is OK.
- [ ] The reversal uses a dry-run digest but no rehearsal (plan section 0 asks for both). Accept this, or ask for a rehearsal step.
- [ ] After a move that follows a reversal, check the restored products by hand: the rehearsal leaves those edits out of its page comparison.
- [ ] A product deleted from Shopify while the store was back on the old editor gets its live row back at the next move. Shoppers never see it (the product is gone), but its edits sit unseen. Confirm this is acceptable.
- [ ] Orchestrator ruling to confirm: the reversal needs a dry-run digest but no rehearsal (it returns to the exact release from before the move). Give your OK before the first real reversal.
- [ ] PITR: record --backup-ref just before each real reversal.
- [ ] Hosted Turso batch atomicity check on staging (runbook step 0.3).
- [ ] Approve the source and checksum of the CI sqld download under .github/ (not touched here).
- [ ] Phone and Safari: not run (desktop Chrome only).

### Review fixes from batch 5 (P4-FIX5)
Packet: [P4-FIX5.md](P4-FIX5.md), section "Owner checks".
- [ ] Desktop Chrome on the design harness, with DevTools throttling: open product A, then click B and quickly C. The editor should end on C's form and never stay on 'Opening C…'. While 'Opening…' shows, there should be no Publish, Discard or Earlier versions controls. (This browser drill was not run: browser verification is NOT DONE.)
- [ ] Staging: provision a throwaway tenant whose database name is a prefix of an existing one (for example shop beside shop2), check the summary says its database was created, then offboard the tenant.
- [ ] An adopted `--db-url`: on staging, provision a throwaway tenant with `--db-url` pointing at another registered store's database (written differently, for example its `https://` form). It must be refused and the other store must stay open and on its editor. Until P4-FIX6's `sameDbAddress` change merges, two spellings of one database are not seen as the same (P4-FIX5 Known limits).
- [ ] CI: the sqld download in .github/ still needs the owner's approval of its source and checksum. Nothing under .github/ was changed.

## Phase 4, batch 7

### Every owner step for phase 4, in one list (P4-DRILLS)
Packet: [P4-DRILLS.md](P4-DRILLS.md), section "Owner checks". Collected from every phase 4 packet; each line names the packet it comes from. The runbook is [P4-CUTOVER-RUNBOOK.md](P4-CUTOVER-RUNBOOK.md).
- [ ] Migrations 0023 to 0025 on every tenant, then the env store, then the check: `pnpm tenant:migrate -- --all`, `pnpm migrate`, `pnpm tenant:migrate -- --check --include-env` (must exit 0). Before any code that needs them deploys ([P4-SCAFFOLD](P4-SCAFFOLD.md), [P4-MEDIA](P4-MEDIA.md), [P4-PROVISION](P4-PROVISION.md)).
- [ ] Per tenant, in this order: a real dry run read with the founder, a rehearsal on a restore-drill copy, the real move, the post-checks (runbook sections 3 to 7) ([P4-MAPPER](P4-MAPPER.md), [P4-FIX1](P4-FIX1.md), [P4-CUTOVER](P4-CUTOVER.md)).
- [ ] Hosted batch atomicity on staging before the first real move (runbook 0.3) ([P4-GUARD](P4-GUARD.md), [P4-LIVEROW](P4-LIVEROW.md), [P4-CUTOVER](P4-CUTOVER.md), [P4-REVERSE](P4-REVERSE.md)). **Open decision first (owner and orchestrator):** an ordinary old-editor save is refused before any batch is sent, so it can't reach the batch guard; the only pass is "Your store is being updated. Try again in a few minutes.", never "This store is moving to the new editor right now…". Choose (a) a staging-only script that sends one guarded old-editor batch straight to the staging store, or (b) accept the file-database and sqld proof and record hosted Turso as untested. No real store moves before this is settled.
- [ ] OQ-14 on a dev store: do Shopify image addresses differ only by their query string? ([P4-LIVEROW](P4-LIVEROW.md)).
- [ ] Typesense tenants, `_default` included: after the first rename on each, search shows the new name within a few minutes (the reindex job and the tick are running), and a full sync keeps it ([P4-SEARCH](P4-SEARCH.md), [P4-EDITOR](P4-EDITOR.md), [P4-REVERSE](P4-REVERSE.md)).
- [ ] Phone and Safari: every phase 4 drill ran in desktop Chrome only (the product form and switcher at phone width, a renamed product's page, card and cart, the media picker and archive, the order page line) ([P4-EFFECTIVE](P4-EFFECTIVE.md), [P4-OVL07](P4-OVL07.md), [P4-PICKER](P4-PICKER.md), [P4-EDITOR](P4-EDITOR.md), [P4-FIX3](P4-FIX3.md), [P4-SEARCH](P4-SEARCH.md), [P4-CUTOVER](P4-CUTOVER.md), [P4-REVERSE](P4-REVERSE.md), [P4-DRILLS](P4-DRILLS.md)).
- [ ] The theme pin on hosted: after each real move and reversal, the platform console shows the right kit ([P4-CUTOVER](P4-CUTOVER.md), [P4-REVERSE](P4-REVERSE.md)).
- [ ] Webhook allowed differences: product webhooks keep writing while a store moves (OQ-5). OK, or queue them? ([P4-GUARD](P4-GUARD.md), [P4-CUTOVER](P4-CUTOVER.md)).
- [ ] PITR: confirm the Turso plan has point-in-time restore, and record the PITR time just before each real move and reversal (`--backup-ref`) ([P4-CUTOVER](P4-CUTOVER.md), [P4-REVERSE](P4-REVERSE.md)).
- [ ] Warn the founder and pick a quiet window before each move and reversal (runbook sections 1 and 9.1) ([P4-CUTOVER](P4-CUTOVER.md)).
- [ ] Staff lose cart-offer publishing at the move (OQ-6): they can still edit the cart offer but an owner or admin must publish it. Tell the team before each move ([P4-SCAFFOLD](P4-SCAFFOLD.md), [P4-LIVEROW](P4-LIVEROW.md), [P4-MAPPER](P4-MAPPER.md)).
- [ ] OQ-4: after P4-PROVISION deploys, provision one throwaway tenant on staging: it starts on the new editor, shows "Opening soon" to shoppers until its first publish, and its onboarding checklist links all work ([P4-PROVISION](P4-PROVISION.md)).
- [ ] CI: approve the source and checksum of the sqld download in `.github/` (every phase 4 packet; nothing under `.github/` was changed).

### Phase 4 drills on the harness (P4-DRILLS)
Packet: [P4-DRILLS.md](P4-DRILLS.md), section "Owner checks".
- [ ] Finding F1 (decide or assign): after a move, every product and collection the move brought over is named "Product content" or "Collection content" in the media screen's "Where it's used" and delete refusal (and "Moved to the new editor Collection content" in Publishing), because the move labels those documents by type and a label is never renamed. The founder can't tell which product uses a photo. Needs an owner for `lib/migrate/map-entities.js` (and a one-off relabel of moved stores).
- [ ] Finding F2 (decide or assign): a rehearsal can fail on the home page's hero alone while a hero test runs (the comparison misses the test's ping when Next splits its streamed data). Until `lib/migrate/render-compare.js` joins the streamed chunks, rehearse again when only the hero differs.
- [ ] Finding F3 (wording): the dry run's "Not ready" line for an agency says "Settings > Team"; the panel is "Agency access" on the Settings page. The runbook now says where; the report's words are `lib/migrate/report.js`'s owner's.
- [ ] Runbook 3.2 on a real store: serving the restore-drill copy needs the store's control-plane row (id and config) in your local harness. Until there is a tool for it, a developer copies it.
- [ ] Not drilled, staging only: the catalog sync pausing while a store is being updated (a sync needs Shopify), and Typesense (the drills use the SQL search and a spy client).
- [ ] P4-FIX6 ran beside this item; its owner checks are in "Reversal and provisioning review fixes (P4-FIX6)" below.
- [ ] Optional: run `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> COPY_SQLD_PORT=<port> node scripts/drills/p4/run.mjs` on your Mac (about 25 minutes) and look at the screenshots in `docs/cms-reviews/drills/P4-DRILLS/`.

### The P4-DRILLS review (P4-DRILLS)
Packet: [P4-DRILLS.md](P4-DRILLS.md), "Known limits" (From review).
- [ ] Owner and orchestrator: decide how hosted Turso batch atomicity (runbook 0.3) is proved before any real move: (a) a staging-only script that sends one guarded old-editor batch straight to a staging store while it is 'migrating', or (b) accept the file-database and sqld proof and record hosted Turso as untested.
- [ ] Orchestrator: consider adding `node scripts/drills/p4/runbook.mjs --check` to pnpm test (package.json is SCAFFOLD's file).
- [ ] Re-run the runbook stage (with the FIX6 re-run) so results-runbook.json carries the new label and the 0.3 wording checks.

### Reversal and provisioning review fixes (P4-FIX6)
Packet: [P4-FIX6.md](P4-FIX6.md), section "Owner checks".
- [ ] Owner: sign off, or reject, the orchestrator ruling in P4-REVERSE.md: the reversal needs a matching dry-run digest and no rehearsal, which differs from plan section 0's wording. This is needed before the first real reversal.
- [ ] Staging: move a store, publish a new page in the new editor, reverse, then check the next move's dry run. It should name the page with 'Shoppers won't see it after the move…'. After the move the editor should show the page as not published, and publishing it should put it live.
- [ ] Read the reversal dry run's new draft wording ('…kept there only as an older version') with a founder and confirm it.
- [ ] Desktop Chrome on the design harness, on a slow connection: while product B is opening, pick a section of another page in the preview. That page should open with the section selected and its field focused, and stay that way (browser drill not done).
- [ ] Staging provisioning: provision a throwaway tenant with --db-url set to an existing store's database in its https:// form. It should stop with the plain words and register nothing.
- [ ] CI: the sqld download in .github/ still needs the owner's approval of its source and checksum (nothing under .github/ changed).
- [ ] Phone and Safari: not run.

## Phase 5, batch 0

### Where section data comes from (P5-SOURCES)
Packet: [P5-SOURCES.md](P5-SOURCES.md), "Owner checks" and "Known limits" (From review).
- [ ] Staging is not done: phase 5 needs a deploy to staging with a documents-mode tenant (plan section 4 prerequisite).
- [ ] No desktop Chrome drill was run. Every acceptance item is proved by a test. The design harness smoke on port 6100 gave GET / 200, with the collections and new sections rendering data and no section_binding_failed lines.
- [ ] CI sqld download: nothing was added under .github/. The source and checksum still need the owner's approval.
- [ ] P5-HIDDEN must read data.bindingFailedCause directly from the data object it is handed, because the field is non-enumerable. If it should become a normal field later, the JSON-exact assertion in test-sections-render (about line 672) has to change too.

### The bundle and bundle list settings (P5-SETTING)
Packet: [P5-SETTING.md](P5-SETTING.md), "Owner checks" and "Known limits" (From review).
- [ ] Sign off the wording of the bundle publish-diff rows. They are verb first ('Bundle grid: added a bundle'), while other lists are noun first ('FAQ: a question added').
- [ ] Known limit to accept: a bundle is indexed in document_refs by id when chosen in a section, but by slug when reached through a /bundles/<slug> link. Nothing joins the two (plan deviation 3.11).
- [ ] Not browser verified: nothing renders yet. The controls come with P5-EDITOR and the sections with P5-BLOCKS.
- [ ] Staging not done.

### Reading bundles for sections (P5-BUNDLEREAD)
Packet: [P5-BUNDLEREAD.md](P5-BUNDLEREAD.md), "Owner checks" and "Known limits" (From review).
- [ ] Sign-off: turning on a turned-off draft (setBundleEnabled) now writes its offer in full from the bundle row instead of only flagging an existing offer row on.
- [ ] Known limit: a turned-off draft can still be saved with a quantity of 1.5 (it gets no offer), and listBundles reports it as passing the check. Turning it on is refused in plain words.

### Hidden-section notes in preview (P5-HIDDEN)
Packet: [P5-HIDDEN.md](P5-HIDDEN.md), "Owner checks" and "Known limits" (From review).
- [ ] Browser check, in P5-DRILLS once the bundle kinds exist: in desktop Chrome, a documents preview of a turned-off bundle card shows the 'hidden from shoppers' note with its reason, clicking the note selects the section in the editor, and the live page shows nothing there. A grid with a dropped cell shows the per-cell FounderNote in preview only.
- [ ] Check both notes at phone widths 375 and 768 and in Safari.
- [ ] Wording sign-off: the title '<Label>: hidden from shoppers', and the source_unknown words, which include the section's label ('This newest products section is set up in a way the editor can't fix. Remove it and add it again.').
- [ ] Staging: preview a hidden bundle section on one documents-mode tenant after phase 5 deploys.
- [ ] Carried over: the CI sqld download in .github still needs the owner's approval of its source and checksum. This item did not touch .github.

## Phase 5, batch 1

### The bundle card and bundle grid sections (P5-BLOCKS)
Packet: [P5-BLOCKS.md](P5-BLOCKS.md), "Owner checks" and "Known limits" (From review).
- [ ] Wording sign-off: a bundle that saves nothing and also has a sold-out or deleted product shows only the no-saving sentence in its preview note, not the sold-out sentence as well.
- [ ] Browser (P5-DRILLS): in a documents preview, a bundle card for a sold-out bundle that saves nothing shows the founder note, and the live page shows nothing for it.

### Bundle warnings at publish (P5-CHECKS)
Packet: [P5-CHECKS.md](P5-CHECKS.md), "Owner checks" and "Known limits" (From review).
- [ ] Browser check, NOT DONE yet: the real bundle kinds (P5-BLOCKS) and the picker (P5-EDITOR) are not in yet. Once they are, check in the editor's publish panel (desktop Chrome via P5-DRILLS, then phone widths and Safari by the owner) that the six bundle warnings show under 'Check', that both Remove buttons do what the message says, and that the overlap warning only opens the field.
- [ ] Sign off the warning words, including the quoted bundle id shown for a deleted bundle.
- [ ] After P5-BLOCKS merges, confirm the no_saving BUNDLE_UNAVAILABLE message carries the owner's 'so shoppers don't see it' words, which come from bundle-words.js.
- [ ] Staging, NOT DONE: needs phase 5 on staging with a documents-mode tenant.
- [ ] Carried over: the CI sqld download in .github still needs the owner's approval of its source and checksum. This item did not touch .github.

### The console bundle form and panel (P5-PANEL)
Packet: [P5-PANEL.md](P5-PANEL.md), "Owner checks" and "Known limits" (From review).
- [ ] Sign off the deviation 3.10 parts made here: handles and any other non-GID variant id are refused on the bundle and check actions, and a draft with a non-whole quantity shows as not ready and can't be turned on.
- [ ] Decide whether the design-harness demo seed (scripts/seed-demo.js, variant ids like demo-1-v1) should get Shopify-style GID variant ids. Today bundles can be made on the harness only with --fixture perf.
- [ ] On staging after deploy, on a documents store with a bundle card on the live home: check that Disable and Delete in Catalog > Bundles say 'Shoppers will stop seeing this bundle on your home page right away.' and that the 'On your home page' marker shows.
- [ ] Check Catalog > Bundles and the bundle form at phone widths (375 and 768) and in Safari.
- [ ] Carried over: approving the CI sqld download (source and checksum) for .github is still the owner's call. This item did not touch .github.

## Phase 5, batch 2

### The inspector's bundle picker, inline create and bundle form fixes (P5-EDITOR)
Packet: [P5-EDITOR.md](P5-EDITOR.md), "Owner checks" and "Known limits" (From review).
- [ ] Decide where the 'confirm Disable and Delete when the home lookup fails (usedOnHome null)' fix goes. It is in components/admin/CommercePanels.js, which has no batch 3 owner.
- [ ] Sign off the new words that live outside bundle-words.js: the chips (Showing, Sold out, Not ready, Hidden: no saving, Turned off, Turned off not ready, Deleted), the turned-off-but-not-ready line, 'You can't see bundles here.', 'Ask an owner to create bundles.', the Dialog's live-now sentence, and the form's lines 'Enter how many…', 'Pick this product again…' and 'The cart takes off …'.
- [ ] Decide whether the form should show the saving with cents plus the cart's whole amount (current) or only the engine's whole amount, as the block does.
- [ ] On staging (OQ-C): an inline create is live at once (its discount and /bundles/<slug>) before publish, and stays if the draft is discarded.
- [ ] Phone widths (375 and 768) and Safari for the picker, the grid rows and the Create a bundle Dialog.
- [ ] On staging with a documents-mode tenant: a role without storefront.read sees 'You can't see bundles here.' (today support holds storefront.read, so a real 403 needs such a role).
- [ ] (Carried) The CI sqld download under .github/ still needs the owner's approval of its source and checksum. Nothing was added under .github/.

### Batch 1 review fixes for bundles (P5-FIX1)
Packet: [P5-FIX1.md](P5-FIX1.md), "Owner checks" and "Known limits" (From review).
- [ ] Orchestrator: confirm landing the one-assertion change to scripts/test-bundle-form.js (P5-EDITOR's file) in this branch. Watch for a conflict at lines 417 to 424 when P5-EDITOR merges.
- [ ] Owner sign-off of the three orchestrator rulings and of the new founder and shopper words (listed in P5-FIX1.md).
- [ ] Browser check (P5-DRILLS), desktop Chrome: a home card and a grid cell whose bundle lost a product, and /bundles/<slug> for a bundle stored with quantity 1.5.
- [ ] Phone widths (375, 768) and Safari for the new preview note.
- [ ] Staging: not done.
- [ ] The CI sqld download under .github/ still needs the owner's approval of its source and checksum.

## Phase 5, batch 3

### Every owner step for phase 5, in one list (P5-DRILLS)
Packet: [P5-DRILLS.md](P5-DRILLS.md), section "Owner checks". Plan section 4 of [P5-PLAN.md](P5-PLAN.md), plus the batch review items; each line names the packets it comes from.
- [ ] **Prerequisite:** phase 5 deployed to staging, and a documents-mode tenant there (a new tenant, or an owner-run cutover). Every staging line below needs it ([P5-PLAN](P5-PLAN.md) section 4, every phase 5 packet).
- [ ] Phone widths (375 and 768) and Safari for the bundle card and the bundle grid, including the per-cell preview notes, the founder notes, the inspector's bundle picker, the grid rows, the Create a bundle Dialog and Catalog > Bundles. The drills ran in desktop Chrome only (the pick stage looked at the founder's preview at 375 wide in Chrome, which is not a phone) ([P5-BLOCKS](P5-BLOCKS.md), [P5-HIDDEN](P5-HIDDEN.md), [P5-EDITOR](P5-EDITOR.md), [P5-PANEL](P5-PANEL.md), [P5-FIX1](P5-FIX1.md), [P5-DRILLS](P5-DRILLS.md)).
- [ ] One real test order through a bundle block on staging, to snehal@mediastic.in, then cancelled at once. Confirm the bundle discount line on the order pushed to Shopify equals the saving the card shows. (The harness drill placed a cash on delivery order and cancelled it; nothing reached Shopify) ([P5-PLAN](P5-PLAN.md) section 4, [P5-BUNDLEREAD](P5-BUNDLEREAD.md), [P5-BLOCKS](P5-BLOCKS.md)).
- [ ] Sign off the plan's deviations: 3.5 (bundle blocks are home page only), 3.10 (bundle behaviour changes: SLUG_TAKEN instead of overwrite, handles refused on the bundle API, edits keep enabled and description, duplicate items merged on write, an edit that breaks a live bundle is refused; the owner accepted 3.10 on 2026-11-05, so this is a record), 3.11 (`/bundles/<slug>` links are keyed by slug and not checked at publish), 3.3 (bundles have no "expired" or "not started" state) ([P5-PLAN](P5-PLAN.md)).
- [ ] Bundles are not versioned: an edit, a turn-off or a delete in Catalog > Bundles changes every live home card at once, with no publish. The drill saw a turn-off hide the live card at the first look and a price edit show on the live card at once ([P5-PLAN](P5-PLAN.md) section 4, [P5-PANEL](P5-PANEL.md), [P5-DRILLS](P5-DRILLS.md)).
- [ ] Inline create turns the bundle on at once (OQ-C, kept by the owner): its discount and `/bundles/<slug>` are live before publish, and stay if the draft is discarded. The drill saw `/bundles/drill-trio` open for a shopper before any publish ([P5-PLAN](P5-PLAN.md) section 4, [P5-EDITOR](P5-EDITOR.md)).
- [ ] An exclusive coupon (combinable: false) suppresses the BUNDLE saving the card shows; the cart does not explain why ([P5-PLAN](P5-PLAN.md) section 4).
- [ ] Stock depth: a component with quantity 2 and one unit left shows as available, the same as the bundle page today ([P5-PLAN](P5-PLAN.md) section 4, [P5-BUNDLEREAD](P5-BUNDLEREAD.md), [P5-BLOCKS](P5-BLOCKS.md)).
- [ ] Existing bundles stored with duplicate items show "not ready" until they are saved again in Catalog > Bundles; look at the real stores' bundles before phase 5 ships. Overlapping bundles may give a different cart saving than the card shows (OQ-D: the engine's order and per-entry counting are unchanged) ([P5-PLAN](P5-PLAN.md) section 4, [P5-BUNDLEREAD](P5-BUNDLEREAD.md)).
- [ ] Decide on BundleAddButton's non-atomic add (each product is added in turn; OQ-G, unchanged) ([P5-PLAN](P5-PLAN.md) section 4).
- [ ] Wording sign-off, batch 0 review: the bundle publish-diff rows are verb first ("Bundle grid: added a bundle") while other lists are noun first; a bundle picked in a section is indexed by its id while a `/bundles/<slug>` link is indexed by its slug, with nothing joining the two; the source_unknown note includes the section label ("This newest products section is set up in a way the editor can't fix. Remove it and add it again.") ([P5-SETTING](P5-SETTING.md), [P5-HIDDEN](P5-HIDDEN.md); also listed in their own sections above).
- [ ] Batch 1 review: a bundle linked from the live home only by a `/bundles/<slug>` link gets no home-page warning on Disable or Delete in Catalog > Bundles (only bundles picked in a bundle card or grid count as "On your home page") ([P5-PANEL](P5-PANEL.md)).
- [ ] Batch 1 review: the design harness's plain demo seed (variant ids like `demo-1-v1`) can no longer save or check bundles; real stores sync Shopify GIDs, and the harness drills use the perf seed ([P5-PANEL](P5-PANEL.md)).
- [ ] Batch 1 review: sign off the orchestrator rulings in P5-FIX1: a bundle with a missing (deleted) product never says "no saving" (the drill saw such a bundle read sold_out with a missing product and the "Replace it" note); a quantity that is not whole is "not ready" on both the bundle page and the home blocks; BUNDLE_OVERLAP is raised only for a bundle that is available ([P5-FIX1](P5-FIX1.md)).
- [ ] Batch 2 review: the bundle page's "This bundle isn't available right now." now also shows for a bundle whose price saves nothing (no_saving), not only for one that is not ready ([P5-FIX1](P5-FIX1.md)).
- [ ] Batch 2 review: the offer engine rounds a bundle discount to a whole amount, so the bundle form says what the cart actually takes off ("The cart takes off …") when the exact saving has cents; decide whether the form should show only the whole amount, as the card does ([P5-EDITOR](P5-EDITOR.md)).
- [ ] Decide where the "confirm Disable and Delete when the home lookup fails (usedOnHome null)" fix goes: components/admin/CommercePanels.js has no phase 5 owner after batch 2 ([P5-EDITOR](P5-EDITOR.md)).
- [ ] CI: approve the source and checksum of the sqld download in `.github/` (every phase 5 packet; nothing under `.github/` was changed).

### Phase 5 drills on the harness (P5-DRILLS)
Packet: [P5-DRILLS.md](P5-DRILLS.md), sections "Findings" and "Owner checks".
- [ ] Finding P5D-1 (decide): the new editor has no Mobile (device) preview switch. Benchmark row 2 says "checked on the Mobile preview"; the drill checked the founder's preview in a second tab at 375 wide instead. Decide whether the editor needs a device switch (the old Designer had one) or whether a phone check is enough.
- [ ] Finding P5D-2 (wording): a deleted bundle's publish warning names it by its raw id ("“bun-1a92…”: This bundle was deleted…"); the founder can't tell which bundle it was. Part of the P5-CHECKS wording sign-off.
- [ ] Not drilled, NOT DONE: the BUNDLE_OVERLAP warning in the publish panel (opens the field only); the 403 "You can't see bundles here." and "Ask an owner to create bundles." paths (every harness login holds the rights); `/bundles/<slug>` of a bundle stored with a quantity of 1.5 (only a raw write makes one, and the drills write through the writers only); a full grid of 12 with Create a bundle.
- [ ] Optional: run `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p5/run.mjs` on your Mac (about 7 minutes) and look at the screenshots in `docs/cms-reviews/drills/P5-DRILLS/`.

### The P5-DRILLS review (P5-DRILLS)
Packet: [P5-DRILLS.md](P5-DRILLS.md), "Owner checks" and "Known limits" (From review). Several lines repeat the list above; the review asked for each one again.
- [ ] Staging with a documents-mode tenant: every phase 5 staging check (NOT DONE).
- [ ] Phone widths 375 and 768 and Safari for the bundle card, grid, notes, picker, Create a bundle Dialog and Catalog > Bundles.
- [ ] One real test order through a bundle block on staging, to snehal@mediastic.in, then cancelled. Check the discount line on the order pushed to Shopify.
- [ ] Sign off deviations 3.5, 3.10 (accepted), 3.11 and 3.3.
- [ ] Bundles are not versioned; inline create is live at once (OQ-C); an exclusive coupon suppresses the saving; stock depth; duplicate-item and overlapping bundles (OQ-D); the non-atomic add (OQ-G).
- [ ] Batch review items: verb-first diff rows; bundles indexed by id while /bundles/<slug> links are indexed by slug; the source_unknown wording; no home warning for a bundle linked only by /bundles/<slug>; the demo seed can't save bundles; the P5-FIX1 rulings; the bundle page says 'This bundle isn't available right now.' for a no-saving bundle; whole-amount rounding of the cart discount.
- [ ] Choose an owner for the usedOnHome-null confirm in CommercePanels.js.
- [ ] Finding P5D-1 (no Mobile preview switch in the editor) and P5D-2 (a deleted bundle is named by its raw id).
- [ ] Not drilled: BUNDLE_OVERLAP in the publish panel, the 403 and staff paths, a quantity of 1.5 on the bundle page, a full grid of 12.
- [ ] Approve the source and checksum of the CI sqld download in .github/.
- [ ] Run pick, create and console again after P5-FIX2 merges.

### Bundle picker and console fixes, round 2 (P5-FIX2)
Packet: [P5-FIX2.md](P5-FIX2.md), "Owner checks" and "Known limits" (From review).
- [ ] No new owner checks. The existing P5-FIX2 owner checks still stand, including the browser drill and the CI sqld download approval under .github/ (nothing was added there).

## Phase 6, batch 0

### Test fixtures and banned-copy rules (P6-FIXTURE)
Packet: [P6-FIXTURE.md](P6-FIXTURE.md), "Owner checks" and "Known limits" (From review).
- [ ] CI sqld download: unchanged; approving its source and checksum is still the owner's job (nothing under .github/ was touched).
- [ ] CLAIMS lexicon: confirm the 13 words (reviews, rated, stars, certified, award, clinically, guaranteed, best-selling, #1, organic, dermatologist, lab-tested, money-back) are the ones a generated store must never say, in particular 'organic' and 'guaranteed'. A founder's own words are never scanned.
- [ ] Later phase 6 items: scanText flags 'review' used as a verb. Founder-facing report copy (P6-OPEN) should pass { claims: false } or avoid the word, and shopper text should pass { shopper: true }.

### The six curated palettes (P6-PALETTE)
Packet: [P6-PALETTE.md](P6-PALETTE.md), "Owner checks" and "Known limits" (From review).
- [ ] Look at the six palettes (Ink, Slate, Navy, Stone, Forest, Clay) on a phone and on desktop once P6-BRAND's brand step exists (P6-DRILLS stage B). Are the labels and colours the ones founders should see? Only the text colours of Ink (#09090b), Slate and Navy (#0f172a) were chosen in this item.
- [ ] Forest and Clay buttons have near-black text on a lighter shade of the accent (validateBrand's choice). Check you are happy with how that looks.
- [ ] On the Pulse kit, the dark accents' hero highlight (and, for Ink, the header wordmark) is switched to a lighter shade, and checkBrand returns a plain note that may show in the editor on a generated store. Decide whether that note should be shown there (P6-NAV / P6-BRAND).
- [ ] Browser check (desktop Chrome) and staging: NOT DONE for this item, because nothing shows the palettes yet.

### The logo in the design document (P6-LOGO-REG)
Packet: [P6-LOGO-REG.md](P6-LOGO-REG.md), "Owner checks" and "Known limits" (From review).
- [ ] On a closed store, the editor's 'Show them' toggle now changes nothing, because the design draft always shows in the founder's preview there. The same happens on an open store whose live list has no design. Confirm this is acceptable, or ask for a later change that hides the toggle until the store opens (a DocumentEditor or preview bar change).
- [ ] For a deleted logo, the MEDIA_MISSING publish warning says 'shoppers see a plain colour block instead. Choose another image.' That is image wording. Confirm that a logo-specific sentence in lib/documents/checks.js should come in a later item.

### The first-run writer and the policy-page rule (P6-GEN-WRITE)
Packet: [P6-GEN-WRITE.md](P6-GEN-WRITE.md), "Owner checks" and "Known limits" (From review).
- [ ] Staging (OQ-4), once P6-GEN has landed: on a throwaway documents tenant, the first generation makes doc_home and doc_design together, and a later sync never overwrites a founder's edit to the home.
- [ ] A sync-time refill while the editor has the generated draft open shows the 'changed somewhere else' conflict. Confirm the wording is acceptable.
- [ ] Hosted Turso: check on a staging tenant that the one batch is all or none and that the lost-answer read-back reports success. Local file databases can't show replica behaviour.

## Phase 6, batch 1

### The first-run generator and its triggers (P6-GEN)
Packet: [P6-GEN.md](P6-GEN.md), "Owner checks" and "Known limits" (From review).
- [ ] Staging end to end (OQ-4): connect, then sync. Inline, CLI and connect-callback syncs are not hooked, so check that /admin/start or the editor makes the store. Check the home and design are made together and a later sync never overwrites a founder edit.
- [ ] Open editor plus a sync-time refill of a generator-owned draft: confirm the 'newer version elsewhere' conflict wording is acceptable.
- [ ] Decide whether the fixed lime --sf-success* status colours (lib/brand.js) are acceptable on a generated store, or ask for a lib/brand.js change.
- [ ] A queued catalog_sync on hosted Turso either generates within the slice (first_run in the logs) or logs first_run_deferred, and the start page then makes the store.
- [ ] CI sqld download: approval of its source and checksum is still the owner's; nothing under .github/ was touched.

### The brand step, server side (P6-BRAND)
Packet: [P6-BRAND.md](P6-BRAND.md), "Owner checks" and "Known limits" (From review).
- [ ] Brand step end to end in desktop Chrome and on a phone once P6-START-UI exists (P6-DRILLS stage B): six palettes, one-click Save with no change, Remove logo, Skip, and the 'Your description shows now. Colours and logo show after you publish.' line on an open store.
- [ ] Decide the closed-store manifest leak: app/manifest.webmanifest/route.js answers description: siteTagline() on a closed store, so a directly opened /manifest.webmanifest shows the founder's description before opening. Fix it in a later item (neutral description while isStoreClosed()), or accept it.
- [ ] Confirm that staff may change colours and the logo in the brand step but not the description (it needs settings.write, as Settings does).
- [ ] Confirm that #808000 (olive, hue 60) is not treated as lime, or ask for the lime window to start lower.
- [ ] Phone logo upload (PNG, a large JPEG, an SVG; HEIC must be refused in plain words), and the logo in header and footer on a phone and in Safari (plan owner check, unchanged).
- [ ] On Glow, Slate, Stone, Forest and Clay show checkBrand readability notes (never warnings or errors). Confirm a founder seeing them after switching kit is acceptable.
- [ ] CI sqld download: its source and checksum still need your approval (nothing under .github/ was touched).

### Before you open your store (P6-OPEN)
Packet: [P6-OPEN.md](P6-OPEN.md), "Owner checks" and "Known limits" (From review).
- [ ] Accept the test-provision choice (option 1: rule b kept, and the suite opens with [doc_home, doc_design]), or ask for rule b to be narrowed.
- [ ] Between batch 2 and batch 3, a founder with a saved design draft who publishes only the home page of a closed store sees a refusal with no button. Accept this, or merge P6-OPEN together with P6-OPEN-UI.
- [ ] P6-ONBOARD (which owns test-provision in batch 4) must keep the first publish carrying doc_design.
- [ ] Owner checks carried over from the first run: the checkOpening contract, the POLICY_PAGE_MISSING scope, the founder words, a staging tenant with real Razorpay keys (never enter card details), re-running drills p2, p3 and p4, and approving the source and checksum of the CI sqld download (nothing under .github/ was touched).

### Start a privacy or returns page (P6-POLICY-START)
Packet: [P6-POLICY-START.md](P6-POLICY-START.md), "Owner checks" and "Known limits" (From review).
- [ ] Legal review of the privacy and returns starters is an owner action (OQ-25). Read both as a founder would, on a store with a non-default returns_window_days; the copy says they are starting points, not legal advice.
- [ ] Confirm the returns starter's refund wording: 'Refunds go back to the original payment method.' with no day count, instead of the unset 'within 5–7 working days'. This was changed so the starter passes the banned-copy rule; the legacy PageEditor list keeps the old sentence.
- [ ] Once P6-OPEN-UI and P6-ONBOARD land, check on a phone that a starter page left untouched clearly keeps the store from opening until it is saved or marked 'I've read it'.
- [ ] Not yet tied to a setting (GEN-06): the FAQ's delivery days, its payment methods, its 'reply to your order confirmation email' return hint, and the legacy list's refund timing. 'Refunds go back to the original payment method' may need changing for cash on delivery stores.

### The picture logo in the storefront (P6-LOGO-RENDER)
Packet: [P6-LOGO-RENDER.md](P6-LOGO-RENDER.md), "Owner checks" and "Known limits" (From review).
- [ ] The logo on real screens: on a documents store with a logo (a PNG, a large JPEG and an SVG with no width or height), check the header on a phone (32px tall) and on desktop (40px, never wider than 180px), and both footer variants (48px), in Chrome and Safari. Nothing should be cut off or squashed.
- [ ] A screen reader reads the header logo as the home link, using the founder's alt, or the store's name when the alt is empty.
- [ ] The preview bar on a closed store now says 'Your new colours are shown here.' with no button. Confirm the wording is acceptable.
- [ ] The checkout page keeps the text wordmark on a store with a picture logo (known limit). Confirm that is acceptable for now.
- [ ] Browser drill NOT DONE: every acceptance item is proved by rendered tests; desktop Chrome verification on the design harness is still owed.

## Phase 6, batch 2

### The Start your store page and brand step (P6-START-UI)
Packet: [P6-START-UI.md](P6-START-UI.md), "Owner checks" and "Known limits" (From review).
- [ ] Open-store view in Chrome: start 'Refresh from Shopify' on an open store and check that /admin/start keeps the 'already open' words and both links, with the small sync note.
- [ ] Accept the 'already open' words on open stores, or ask for a summary view (known limit 3).
- [ ] CI sqld download source and checksum still need your approval; nothing under .github/ was touched.

### The editor's Before you open your store panel (P6-OPEN-UI)
Packet: [P6-OPEN-UI.md](P6-OPEN-UI.md), "Owner checks" and "Known limits" (From review).
- [ ] In desktop Chrome on a closed documents store: edit a product description and press Publish. It should show the normal review (no 'Before you open your store'), publish, and leave the store closed.
- [ ] Decide whether openingChecks itself should answer opening:false for a rows-only set (a lib/documents/opening.js change). Today only the editor flow skips it.

### Logo and colours link, Reset to the starting palette, one start nudge (P6-NAV)
Packet: [P6-NAV.md](P6-NAV.md), "Owner checks" and "Known limits" (From review).
- [ ] After P6-START-UI merges (design harness or staging, phone and desktop): 'Logo and colours' appears after Editor in the sidebar and the phone drawer and opens the brand step.
- [ ] In the editor's design settings, change a colour and press 'Go back to your starting colours (…)': the palette name matches the brand-step pick and the colours come back. A store that skipped the brand step with no pick says '(Slate)'.
- [ ] Settings on a documents store: the logo text hint reads well and its 'Logo and colours' link works; on a legacy store the hint is unchanged.
- [ ] Dashboard on the staging throwaway tenant (OQ-4): one 'Start your store' nudge before the brand step; 'Setup: x/y done' after the brand step and generation; no 'Start your store' after opening.
- [ ] Browser verification and staging for P6-NAV are NOT DONE; every acceptance item is proved by tests only.

### Batch 1 review fixes (P6-FIX1)
Packet: [P6-FIX1.md](P6-FIX1.md), "Owner checks" and "Known limits" (From review).
- [ ] The grapheme cut on real screens: on a phone and in desktop Safari, generate a store whose long name is emoji only, or a script with combining marks such as Devanagari, with no spaces. Check that the hero title and the image alt end on a whole character.
- [ ] The closed manifest on a hosted store: open /manifest.webmanifest directly while the store is closed. It should say 'Opening soon.', not the brand-step description. After the first publish it should show the description.
- [ ] Returns starter wording (OQ-25 legal review): a negative returns_window_days gives 'We don't accept returns on orders.' Confirm that wording, and that rounding 10.5 down to '10 days' and 0.5 to '12 hours' is acceptable.
- [ ] Accept that the first run is now two writer calls (home, then design) instead of one batch. A database failure between them leaves a generated home with no design until the next run, and the first-publish design rule covers that state. Or ask for a guard inside createFirstRunDocuments in lib/documents/service.js, which is P6-GEN-WRITE's file.
- [ ] The new ALREADY_SAVED words, shown once P6-OPEN-UI and P6-ONBOARD use markPolicyRead: 'This page was already saved, so it already counts as reviewed. Open it in the editor to read it.'
- [ ] CI sqld download: unchanged, and nothing under .github/ was touched. Its source and checksum still need your approval.
- [ ] Browser drill NOT DONE: every acceptance item is proved by unit tests only; the design-harness Chrome drill belongs to P6-DRILLS.

## Phase 6, batch 3

### The Setup checklist on documents stores (P6-ONBOARD)
Packet: [P6-ONBOARD.md](P6-ONBOARD.md), "Owner checks" and "Known limits" (From review).
- [ ] Desktop Chrome and a phone, on a new closed documents store's Setup page: press 'Start a privacy page' and 'Start a returns page', open each with 'Read your … page', press I've read it on one, save the other in the editor, and see the step done. Check that the words make clear an untouched starter keeps the store from opening (P6-DRILLS stage G).
- [ ] Read the new checklist words as a founder would: 'Start your store', the design hints, the three legal-pages hints, the open-store legal-pages hints and the new Launch hint.
- [ ] Accept or reject that 'Start your store' ticks as soon as any doc_home exists, including an untouched empty home the editor made (known limit).
- [ ] Staging throwaway tenant end to end (OQ-4): Setup checklist on a closed store through first publish. Any COD test order goes to snehal@mediastic.in and is cancelled after.

### Batch 2 review fixes (P6-FIX2)
Packet: [P6-FIX2.md](P6-FIX2.md), "Owner checks" and "Known limits" (From review).
- [ ] Read the new FIRST_RUN_HALF_WORDS sentences in lib/first-run/generate.js as a founder. They show only through POST /api/admin/first-run's message. The start page, FirstRun.js (not this item's file), keeps its own words.
- [ ] Accept the '#1' rule line: if only letters follow '#1', it is a claim unless one letter repeats ('#1fff') or it is the 3-digit form ('#1ab'). The alternative is to ask for a word list.
- [ ] Confirm the P6-NAV deviation the review named: an open documents store with no brand step keeps today's dashboard nudge.
- [ ] The design-alone race is still narrowed, not closed (P6-FIX1 known limit). Closing it needs a guard inside createFirstRunDocuments in lib/documents/service.js.
- [ ] CI sqld download: unchanged. Nothing under .github/ was touched, and its source and checksum still need the owner's approval.
- [ ] Staging end to end on the throwaway tenant (OQ-4): not done.

## Phase 6, batch 4

### Every owner step for phase 6, in one list (P6-DRILLS)
Packet: [P6-DRILLS.md](P6-DRILLS.md), "Owner checks". The drill ran on cms/phase-1 at 60a37b8 (batches 0 to 3 merged). P6-FIX3 ran beside it and had not merged, so its fixes (half-finished first run words, failed policy read words, closedSource(null)) were not drilled.

Not drillable here (staging, phone, Safari, a real key, a decision):
- [ ] Staging throwaway tenant end to end (OQ-4): connect, sync, /admin/start (inline syncs are not hooked, so check the page makes the store), brand step, the "Before you open your store" panel, a COD test order to snehal@mediastic.in cancelled after, first publish. The drill did all of this on the local harness only (stages A to D).
- [ ] Phone logo upload: a PNG, a large JPEG and an SVG. HEIC must be refused in plain words. Then the logo in the header and footer on a phone and in Safari. The drill uploaded one PNG in desktop Chrome.
- [ ] P3-CLOSED RSC probe on a local production build (next build && next start) against a generated, unpublished store. The drill ran it on next dev only (0 leaks, 64 requests, on both the P3 closed store and the generated p6 store).
- [ ] A real Razorpay-key tenant shows the payment item as "Shoppers can pay", with no "Cash on delivery only" line. Never enter card details.
- [ ] The P4-PROVISION Setup page check, before and after first publish, on staging.
- [ ] CI sqld download: approve its source and checksum. Nothing under .github/ was touched in phase 6.
- [ ] Legal review of the privacy and returns starters (OQ-25, GEN-06): read both as a founder on a store with a non-default returns_window_days. The drill saw "within 10 days of your order" on a store set to 10. Also the privacy template's "30 days" and "cookie settings" promises, and that the returns starter drops the "5–7 working days" refund line.
- [ ] Read every word of the panel, the start page and the checklist on a phone, as a founder. Confirm an untouched starter page clearly keeps the store from opening.
- [ ] Confirm the 13-word CLAIMS lexicon, especially "organic" and "guaranteed".
- [ ] Decide on the fixed lime --sf-success* status colours (lib/brand.js) on a generated store. The drill saw no lime in the brand variables of a generated, Forest or opened store, but those status colours are fixed.
- [ ] A deleted logo uses image wording ("plain colour block… Choose another image"). Confirm or ask for logo words.
- [ ] test-product-editor leaves .test-pe-*.db files at the repo root after pnpm test.
- [ ] Inline, CLI and connect-callback syncs do not trigger generation (the start page or the editor does, and only for a store with no home page). See P6D-2 below for what that means for a refill.
- [ ] The gap between the P6-OPEN and P6-OPEN-UI merges (both are merged now; nothing to do unless a branch is replayed).
- [ ] An open store shows "already open" words on /admin/start, not a summary. Accept, or ask for a summary view.
- [ ] "Review and open your store" opens the editor, not the publish panel directly. Accept, or ask for a deep link.
- [ ] An open documents store with no brand step keeps today's dashboard nudge (a deviation from the P6-NAV brief).
- [ ] test:schema-compat "a tenant migrated while the instance is warm" flaked once under load in batch 2 (passes alone). Watch for it.
- [ ] On an OPEN store, an unreviewed policy starter draft gets "Publish your privacy page and your returns page" with no read step. Product question: should open stores also require reading a starter?
- [ ] The test-only "#1" claim rule flags some letter-only hex colours ("#1abc"). Accept or ask for a word list.
- [ ] P5D-1: the editor has no phone-width preview switch (backlog, not P0).

Found by this drill (decide or accept):
- [ ] P6D-1, shopper-visible words: the generated hero subtitle reads "Shop Shop all and Creatine." when the store has a Shopify collection called "Shop all" (lib/first-run/plan.js fills "Shop {a} and {b}." with the top collections' titles). Many real stores have a "Shop all" or "All products" collection. Seen in the editor preview (a-editor-preview-1440.png); it goes live when the founder opens without editing the hero. Ask for the planner to skip catch-all collections in the subtitle, or accept.
- [ ] P6D-2: the empty-catalog note says "product rows appear after your next sync". That is true only when the queued worker runs the sync (it calls the generator after a completed sync). After an inline, CLI or connect-callback sync, or when the worker defers the step (less than 5 s left in its slice), neither /admin/start nor the editor refills the hero-only home: both make a store only when there is no home page. Drilled in stage E. Decide whether /admin/start should refill an untouched generator-made home, or accept.
- [ ] P6D-3: with checkout off, the panel shows the payment block and an Open button that is disabled, not "no open button". The server refuses a direct open (409 STORE_CANNOT_TAKE_PAYMENT, drilled in stage D), and the "no Open button" panel only appears after that 409, which the founder can't trigger from the disabled button. Accept the disabled button, or ask for the proactive panel to drop it while payment blocks.
- [ ] P6D-4: the brand step takes any /api/media/<id> address as the logo, but the media route serves only med_ plus 18 hex digits. An upload always gives a valid id, so founders can't hit this; the drill's first seeded logo did (fixed in the drill's seed). Owner may want the brand step to check the id shape.
- [ ] P6D-5: the closed page computes the platform's lime as its accent variable (--accent-500 #84cc16). Nothing on the page draws in it today (a-storefront-closed-1440.png), so shoppers see no lime. Keep it in mind if the closed page ever uses the accent.

### Batch 3 review fixes (P6-FIX3)
Packet: [P6-FIX3.md](P6-FIX3.md), "Owner checks" and "Known limits" (From review).
- [ ] Read the half-finished start-page words (HALF_WORDS in components/admin/onboarding/brandModel.js since Phase 1 line 6; FirstRun.js is retired) and which reasons offer Try again, as a founder would. Not drilled in desktop Chrome, because it needs a staged race between two writer calls.
- [ ] Read the Setup checklist's failed-read words: 'We couldn't check your privacy and returns pages just now. Reload this page to try again.'
- [ ] After a page reload the half view is gone: the start page shows the store as it is, with no note that the colours were not made. Accept this or ask for a note.
- [ ] CI sqld download under .github/ is unchanged: its source and checksum still need the owner's approval.
- [ ] Staging run on a throwaway tenant: NOT DONE.

## Storeasy Phase 1, line 2: signup makes the store's Turso database

### The one real Turso check (`pnpm check:turso-real`, owner-run only)
Tests, drills and the local harness only ever talk to a local stand-in for Turso's Platform API. This check is the only thing that reaches the real Turso, and only you run it. It costs one real database for a few seconds (longer with `--keep`), counted against your Turso plan.
- [ ] **Dry run first.** In a shell with your Turso API token and organization (never paste them into a chat or a file in the repo):
  `TURSO_REAL_CHECK=yes-i-accept-a-real-database TURSO_API_TOKEN=… TURSO_ORG=… pnpm check:turso-real --create-one-database --dry-run`
  Pass: it prints the database name it would make and calls nothing.
- [ ] **The real run.** The same line without `--dry-run`. It refuses unless all of these hold: `TURSO_REAL_CHECK` is exactly `yes-i-accept-a-real-database` (your written consent to a real database), the `--create-one-database` flag is given, `TURSO_API_TOKEN` and `TURSO_ORG` are set, and `TURSO_API_URL` is unset (so it can only talk to the default `https://api.turso.tech`). `TURSO_GROUP` is optional (default `default`).
  What it does: creates one database `storeasy-check-<6 hex>`, mints a 1-hour token for it (never printed), applies the store schema, reads it back, then deletes the database, also when a step fails. With `--keep` it leaves the database for you to inspect and delete in the Turso dashboard.
  Pass: four ticks (created, minted, applied with its time, read back) and "deleted". Note the schema-apply time: a signup's first try has 50 s (plan risk 1). If it says it could not delete, delete `storeasy-check-…` in the Turso dashboard.
- [ ] **Errors Turso really sends.** If you can, trigger a plan limit or a wrong group once and note the HTTP status and words. The code treats 400, 401, 402, 403 and an unrequested 409 as "needs an operator", and 5xx, 429 and timeouts as retry (plan risk 3). Not checked against the real service.
- [ ] **Operator view.** In `/platform`, Provisioning runs: a signup's run shows "Self-serve signup" and, when it failed, why (gave up after 5 tries, needs an operator, lapsed). Resume on such a run queues the signup's own job. Not drilled (the drill does not sign in to the operator console).

## Storeasy Phase 1, line 4: a founder connects Shopify from onboarding step 1

### The one real Shopify check (owner-run only)
Tests and `pnpm drill:connect` only talk to a local Shopify stand-in. Shopify requires apps created on or after 2026-12-01 to use expiring offline tokens, and only the real service can prove the exchange and the refresh.
- [ ] **Set up a store's app.** In the store's Shopify app (Dev Dashboard), add the redirect URL the operator console lists under the store ("Redirect URLs to add to this store's Shopify app"), one per store domain, then put the client id and secret on the store in `/platform`.
- [ ] **Connect as the founder.** Sign in to the store's console, open onboarding step 1, enter the shop's address, press Connect to Shopify and approve in Shopify. Pass: you land on step 2 with step 1 Done and the products start coming in.
- [ ] **The real check.** In a shell with the platform's database URL, token and secret (never paste them into a chat or a file in the repo):
  `STOREASY_REAL_SHOPIFY=1 PLATFORM_DB_URL=… PLATFORM_DB_TOKEN=… PLATFORM_SECRET=… node scripts/real-checks/shopify-connect.mjs --tenant <slug>`
  Pass: the access token expires in about 60 minutes, the refresh token in about 90 days, every scope granted, one refresh saves a new pair, and `shop { name }` answers with the new token. It writes only the store's own token fields.
- [ ] **What Shopify really sends.** Note whether the token endpoint accepted the JSON refresh body and what a refused refresh returns (the code treats 400 and 401 as "connect again", 5xx and 429 as retry). Not checked against the real service.
- [ ] **Cancel in Shopify.** Press Connect, then Cancel on Shopify's screen. Shopify may send you back to its admin instead of the callback; if so, the step still says "Didn't finish in Shopify? Press Connect again." only after a return. Decide whether that is enough.
- [ ] **Browsers.** The callback is a cross-site GET that relies on SameSite=Lax cookies (verified in Chromium only). Try once in Safari and Firefox.

## Bug-fix branches (not yet merged to main)
- [ ] **Payment confirmation when the database blips** (`claude/gallant-keller-7d3213`). Covered by tests with a simulated database. A real Turso run and a real Razorpay payment are yours.
  - On hosted Turso, check that a refused connection and a lost response give the error shapes the retry code expects. Only Node and a local sqld were tested.
  - In Razorpay test mode, stop the database during verify. Pass: the checkout page waits about 30 seconds, then shows "Confirming your payment", with a sensible message when no status link comes back.
  - After the pending message, press Pay again. Pass: Razorpay refuses a second payment for the same order.
  - On staging, once the duplicate-push fix lands: a browser callback and a webhook arriving together still produce one Shopify order.
  - A second, different payment on an already-paid order is now refused and, through the webhook, logged as NEEDS ATTENTION. Decide who watches for that line and refunds the second payment in Razorpay. Through the background retry queue it is only flagged after 5 attempts, as a plain job failure; say if that should be faster or louder.
- [ ] **Closed store sends nothing** (`claude/musing-williamson-4c86b3`). Only local `next start` on the edge runtime was tested.
  - On a staging tenant with maintenance on: a signed-out product page shows the closed page, view-source has no product title or description, and the tab reads "<Store> will be right back". A signed-in founder sees the real site.
  - On a phone and an installed PWA, with a tab open when maintenance starts, tap a product. Decide whether what it shows until reload is acceptable.
  - During a real maintenance window, watch Google Search Console and Merchant Center. Pages answer 200 with the closed page, and the sitemap answers 404.
  - Agency members signed in only with the `_agency` cookie still see the closed page. Is that intended?
  - Decision: closed pages answer HTTP 200 with no Retry-After and no noindex (as before this branch). During a long closure Google may index the "will be right back" page in place of products. Should the curtain answer 503 with Retry-After, or at least send noindex? (The shopper APIs already answer 503 with Retry-After.)
  - The re-review checked the closed-store title ("<Store> will be right back") and curtain contrast on light and dark brands, and both passed.
  - On a real https staging host, click "Store team sign-in" on the closed page with a verified staff session. Pass: the `_mx` pass cookie is stored (it is Secure, so local http can't show this) and the real site shows.
  - Check the curtain in Safari and on a phone. Only headless desktop Chrome was used.
- [ ] Before hosting: add the SIL OFL 1.1 licence text next to the self-hosted fonts (`app/fonts/geist/`, `app/fonts/geist-mono/`, `app/fonts/fraunces/`, as `OFL.txt`). The fonts no longer come from Google Fonts (2026-11-25), so the licence must ship with the files.
- [ ] Phase 3 billing: on a Razorpay test account, change a store's plan and confirm the old subscription is cancelled at cycle end (`POST /v1/subscriptions/{id}/cancel` with `cancel_at_cycle_end`). Built from current docs; never run against a real account.
- [ ] Phase 7 line 2 search filters: on a staging tenant with its own Typesense namespace, run a full catalog sync (it recreates the collection with `options`, `options_available`, `created_at` and price as a facet), then filter `/search` by two types, a brand, a size, a price range and In stock. Pass: the counts and results match the same URL with Typesense switched off (SQL), `multi_search` answers with no error, and logs show `search_facets` with `source: "typesense"` and no `search_facets_fallback`. Before the sync, the same URL must still work (SQL, one `search_facets_fallback` line). Only stubs and SQL were run locally.
- [ ] Phase 8 line 2 (owner check 2): choose an SMS provider (MSG91, Gupshup or Twilio) and register the DLT template for "<code> is your code to confirm your cash on delivery order at <store>. It expires in 5 minutes. Don't share it."; add it as a provider in `lib/messaging/sms.js`, then send a real COD code to a real phone and place the order with it. Until then production refuses SMS and the code goes by email.
- [ ] Phase 8 line 2 (owner check 5): with the real mail provider on a staging store, set Settings → Checkout → "Code for cash on delivery" to every order by email, place a COD order and confirm the code email arrives within a minute, reads correctly, and the code places the order. Only the local notifications row was checked.
- [ ] Phase 8 line 2: on a deployed Vercel preview, send a COD code request with a made-up `x-forwarded-for` header and confirm the server sees Vercel's value, not yours (the 10-per-IP code cap relies on it).
- [ ] Phase 8 line 1 pincode dataset (owner step, decision 8): download the India Post "All India Pincode Directory" CSV from data.gov.in, run `node scripts/build-pincodes.js <csv>`, and commit `data/in-pincodes.json` (about 19,100 pins, ~250 KB). Then update `scripts/test-pincode.js` "file missing: every pin is found: null", which expects the file absent. Spot-check 20 pins you know (metros, a Ladakh pin such as 194101, a Telangana pin such as 500001, a pin that spans two districts) on a product page's Check delivery. Confirm the GODL attribution wording in `docs/DECISIONS.md` and the file header is what you want shown. Until then lookups answer "unknown" (no message) and shoppers type city and state.
- [ ] Phase 8 line 4 (owner check 3): on Razorpay test mode with international payments enabled, add a US market (Settings → Markets, the tick on), pick "United States ($)" in the footer and pay a USD order with a Razorpay test card. Pass: the payment window shows USD and the same amount as the Pay button, the order is paid, the webhook doesn't flag `amount_mismatch`, and the settlement and a refund in the Razorpay dashboard are in USD. Decide how refunds of a USD order should show in reports (refund rows are not converted to rupees today).
- [ ] Phase 8 line 4 (owner check 4): push that USD order to a Shopify development store. Pass: the Shopify order is in the shop's currency (rupees) at catalog prices with the base discount and shipping, its total equals the order's `base_total` (no RECONCILE_MISMATCH), and the order's additional details show `charged_currency` USD and `charged_total` with the dollar amount.
- [ ] Phase 8 line 4 (owner check 6): on a deployed Vercel preview, open the store from a fresh browser through a VPN in a country with an enabled market (a browser can't set `x-vercel-ip-country` itself). Pass: the first visit shows that market's currency and the footer says that country; after choosing India in the footer, the next visit stays on India. A country with no enabled market shows rupees.
