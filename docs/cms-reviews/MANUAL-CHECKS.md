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
