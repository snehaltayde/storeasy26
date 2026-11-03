# P1 review packet — GEN-03: No wrong-brand or developer text reaches shoppers

Branch `cms/p1-gen03`, cut from `939d630`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:1954`. Inventory: `docs/storefront-copy-inventory.md`.

## Status

| Stage | State |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: 40 of 40 suites passed in the final run. `test:shopify-push` fails intermittently, also on the untouched baseline (see Test results). |
| Browser verified | **NOT DONE.** No browser or dev server in this batch. Tests marked "clicked" use a small hook driver in the suite, not a browser. |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing deployed or pushed. |

## Acceptance items

| Item | Tag | Status | Evidence |
|---|---|---|---|
| A test fails if a banned string appears in storefront code. | unit | Locally tested | `node scripts/test-copy.js`: "banned strings: none in 159 storefront source files" passes. Each file is scanned per line and through SWC's parser, so wrapped text is caught. Planted-regression runs below all exit 1. |
| Negative: an empty catalog shows shoppers no developer command. | rendered | Locally tested | "empty catalog (rendered): home…" and "…collections index…" compile the real `page.js` files with Next's SWC and render them with `react-dom/server`, against a tenant database with 0 products, and compare the page's whole text exactly. "empty catalog can fail" renders the old block and requires the failure. |

The rendered tag has a limit: `app/(storefront)/page.js` runs with real repo, store and section-data modules, but `lib/content/resolve.js` is replaced by the draft getters it would call, because it needs a request. This is not a run through Next's server or the edge runtime. See the browser drills.

The clicked and route tests have limits too. The hook driver calls a component as a plain function and runs no effects, so it proves logic and words, not layout. Routes are compiled and called directly, with a real tenant, database and `NextRequest`. The checkout route itself isn't called: its catch-all is deliberately unchanged (deviation 8).

## Also required by the task

| Item | Tag | Status | Evidence |
|---|---|---|---|
| Written inventory with a decision per string | manual | Done | `docs/storefront-copy-inventory.md` |
| Default shipping values made honest | rendered, clicked, unit | Locally tested | See Shipping below |
| Shipping calculation unchanged | unit | Locally tested | `git diff 939d630 -- lib/shipping.js scripts/test-shipping.js` is empty. `node scripts/test-shipping.js`: 12 passed, 0 failed. |
| BeastLife's stored content keeps working | unit | Locally tested | "BeastLife keeps its stored voice" stores a gym-voice hero and tagline and reads them back. `test:storefront`: its pages still serve only BeastLife. |

## What changed

- **Copy:** the spec's known list, plus what the sweep found. The worst new finds were "(test mode)" and "Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable." on the checkout payment step, the internal rule name in shopper emails, and raw provider and database errors shown at checkout and on account forms.
- **Sender:** a store's emails now go out as `{store name} <the MAIL_FROM address>`. All of them go through `deliverNotification`, including the few sent to the store itself. Invitations and password resets stay the platform's.
- **Empty home:** the default subtitle becomes "Our shop is opening soon.", and a button pointing at `#new` is hidden until there are products.
- **New files:** `components/EmptyCatalog.js`, `lib/shopper-errors.js`, `lib/brand-tenants.js`, `scripts/test-copy.js`, `docs/storefront-copy-inventory.md`.
- **No new CMS field.** Items that should become editable are in inventory section 5.

## Shipping

Found by tracing, all in inventory section 4:

1. **A real bug.** `CheckoutFlow` called `computeShipping` with no config, so the checkout summary and Pay button showed the code default on every store, even one with its own rates, while the server charged the store's rates. The page now passes the same value the server uses. Test: "checkout page (rendered)…", which runs the real `checkout/page.js` on a store with its own rates and a real cart, checks the prop, and checks the amounts in the real `CheckoutFlow`.
2. **The free-shipping nudge** is a promise in the store's name, so it now needs rates the store chose: `shippingRatesSet` in `lib/cart.js`. The charge line always shows. Test: a real cart through the real `CartProvider` into the real drawer.
3. **The console.** The Settings form showed defaults as if saved, and every save wrote them to `shipping_config`, so saving a support email adopted them silently. It now says so, sends starter rates only if their values changed, and offers "Keep these rates". Retyping the same number is no change. Tests: "settings (rendered)…" and "settings (clicked)…".
4. **One definition of "chosen".** The cart and the console now share `shippingRatesChosen` in `lib/brand-tenants.js`. BeastLife with no `shipping_config` counts as chosen in both, so it sees no notice.

**Charges:** the server computes them as before, from the same config. The only code changed on those paths is display and the two error strings at `app/api/checkout/route.js:116` and `:197`.

## Test results

`pnpm test:copy` = `node scripts/test-copy.js`: **42 passed, 0 failed.**

Related suites, in the final full run: `test:shipping` 12/0, `test:storefront` 15/0, `test:cms` 11/0, `test:commerce` 10/0, `test:admin-console` 9/0, `test:w6` 16/0, `test:sections` 15/0, `test:customers` 9/0.

Every `test:*` except `test:perf`, run one after another through its package script: **40 suites, 0 failed.** An earlier full run in this round had 39 of 40, with only `test:shopify-push` failing (see below).

```
orders 27/0 · shipping 12/0 · shopify-push 13/0 · hardening 11/0 · offers-admin 8/0 · events 16/0
tenancy 9/0 · platform-sync 15/0 · admin-console 9/0 · cms-api 20/0 · refs 8/0 · sections 15/0
cms 11/0 · platform-ops 9/0 · tenant-boundary 24/0 · identity 22/0 · authz 14/0 · platform-core 15/0
jobs 12/0 · sync-generations 8/0 · order-projection 14/0 · commerce 10/0 · privacy 11/0 · security 13/0
content 19/0 · releases 25/0 · themes 10/0 · storefront 15/0 · surfaces 15/0 · billing 14/0
provision 9/0 · reporting 6/0 · tenant-ops 9/0 · marketing 4/0 · customers 9/0 · commerce-exp 18/0
growth 21/0 · agency 16/0 · w6 16/0 · copy 42/0
```

`pnpm build`: completed, routes listed, after the last code change to app or `lib` files.

### One flaky suite, not caused by this branch

`test:shopify-push` failed once in an earlier full run on this branch: "sweep recovers stale syncing_shopify from a crashed worker" ("retried next sweep"). Repeated runs of that suite alone:

| Tree | Failures |
|---|---|
| Untouched `939d630`, exported from git | 2 of 12 |
| This branch | 3 of 12, and 2 of 6 before that |

It is the same order of failure on both trees. The likely cause, not proven: the test sets a 1 ms backoff, so a sweep in the same millisecond finds the order not yet due (`lib/shopify-push.js:339`). I did not fix it, since it is outside this requirement. **It needs its own fix, or it will show up in reviews and in the SHOP-06 CI gate.**

Fix round 1 changed neither `lib/shopify-push.js` nor its suite. It failed again in that round: "sweep recovers stale syncing_shopify…" in one full run, and "transient failure retries via sweep and succeeds", once in 8 runs alone.

## Proof that the test can fail

Inside the suite: one planted sample per banned rule, every section 1 row's old wording, a wrapped phrase, text after `//`, the old empty block rendered, and the checkout wiring removed.

Against real files, planting each regression, running the suite, then restoring the file: **37 plants, 0 survived.** The first version of this list included "checkout preview: store's rates no longer passed", which only edited `CheckoutFlow`. It said nothing about the page, and the review showed the page's wiring could break with the suite green. The page and `CartContext` plants below are what cover that now.

```
[exit 1] checkout page: drops the shippingConfig prop
   ✗ checkout page (rendered): a store's own rates reach the preview, the same the server charges
[exit 1] checkout page: shippingConfig undefined
   ✗ checkout page (rendered): a store's own rates reach the preview, the same the server charges
[exit 1] CartContext: shippingRatesSet always true
   ✗ cart drawer (real provider): the charge always shows, the free-shipping promise needs chosen rates
[exit 1] CartContext: flag removed
   ✗ cart drawer (real provider): the charge always shows, the free-shipping promise needs chosen rates
[exit 1] SettingsAdmin: notice removed
   ✗ settings (rendered): the notice shows only when the rates aren't chosen
   ✗ settings (clicked): Keep these rates saves them, and the notice goes
[exit 1] SettingsAdmin: Keep sends {}
   ✗ settings (clicked): Keep these rates saves them, and the notice goes
[exit 1] allow-list widened to everything
   ✗ checkout errors: raw provider and database text never passes
   ✗ checkout (clicked): a failed order shows the shopper's line, never the server's text
[exit 1] friendlyCheckoutError forwards data.error
   ✗ checkout errors: raw provider and database text never passes
   ✗ checkout (clicked): a failed order shows the shopper's line, never the server's text
[exit 1] CheckoutFlow bypasses the helper
   ✗ checkout (clicked): a failed order shows the shopper's line, never the server's text
[exit 1] verify handler forwards v.error
   ✗ checkout (clicked): a failed payment check says what to do, not the server's reason
[exit 1] account route: raw message back
   ✗ account API: a real database error reaches the shopper as plain words
[exit 1] search route: error field back
   ✗ search API: a real database error leaves no error text in the response
[exit 1] ReturnRequest: wrapped Shopify note
   ✗ banned strings: none in 159 storefront source files
   ✗ the scan fails: a phrase wrapped across JSX lines
[exit 1] not-found: text after //
   ✗ banned strings: none in 159 storefront source files
[exit 1] notifications: platform sender back
   ✗ shopper emails carry the store's name and keep the verified address
[exit 1] mail: address not taken from MAIL_FROM
   ✗ shopper emails carry the store's name and keep the verified address
[exit 1] not-found baseline
   ✗ banned strings: none in 159 storefront source files
   ✗ the scan fails: visible text that follows //
[exit 1] ReorderPanel baseline
   ✗ banned strings: none in 159 storefront source files
[exit 1] CheckoutFlow 'Razorpay <span'
   ✗ banned strings: none in 159 storefront source files
   ✗ checkout (clicked): the payment step names no vendor or setup step
[exit 1] CheckoutFlow 'Pay with Razorpay <span'
   ✗ banned strings: none in 159 storefront source files
   ✗ checkout (clicked): the payment step names no vendor or setup step
[exit 1] confirmation 'Razorpay' single quotes
   ✗ banned strings: none in 159 storefront source files
[exit 1] ReturnRequest 'within a working day'
   ✗ banned strings: none in 159 storefront source files
   ✗ the scan fails: a phrase wrapped across JSX lines
[exit 1] bundle 'each piece stays returnable'
   ✗ banned strings: none in 159 storefront source files
[exit 1] hero 'live offers and fast checkout'
   ✗ banned strings: none in 159 storefront source files
   ✗ code defaults: a store with nothing set reads neutral
[exit 1] CartDrawer 'Powered by Shopify'
   ✗ banned strings: none in 159 storefront source files
   ✗ cart drawer (real provider): the empty state is neutral
[exit 1] error page 'on Storeasy'
   ✗ banned strings: none in 159 storefront source files
   ✗ error page (rendered): plain words, no status code, no gym voice
[exit 1] EmptyCatalog yarn + node scripts
   ✗ banned strings: none in 159 storefront source files
   ✗ empty catalog (rendered): home shows exactly the shopper message, no developer command
[exit 1] collections 'connect Shopify and run the sync script'
   ✗ banned strings: none in 159 storefront source files
   ✗ the scan fails: planted text in a real file, outside any comment
   ✗ empty catalog (rendered): collections index shows exactly the shopper message
[exit 1] cart route: raw error back
   ✗ cart API: a failed change leaves no error text in the response
[exit 1] console: own definition of chosen again
   ✗ cart and console use one definition of chosen rates
   ✗ settings (rendered): the notice shows only when the rates aren't chosen
[exit 1] SettingsAdmin: compare JSON strings again
   ✗ settings (clicked): an unrelated save can't adopt starter rates
[exit 1] home: #new button back on empty
   ✗ empty catalog (rendered): home shows exactly the shopper message, no developer command
   ✗ empty catalog (rendered): no button to a section that isn't there
[exit 1] home: subtitle swap removed
   ✗ empty catalog (rendered): home shows exactly the shopper message, no developer command
[exit 1] collections 'run pnpm sync'
   ✗ banned strings: none in 159 storefront source files
   ✗ the scan fails: planted text in a real file, outside any comment
   ✗ empty catalog (rendered): collections index shows exactly the shopper message
[exit 1] footer: catalog note back
   ✗ banned strings: none in 159 storefront source files
   ✗ footer (rendered): both variants carry the store's name and no catalog note
[exit 1] CheckoutFlow: rates not used
   ✗ checkout page (rendered): a store's own rates reach the preview, the same the server charges
   ✗ checkout preview can fail: dropping the store's rates is caught
[exit 1] CartDrawer: nudge regardless
   ✗ cart drawer (real provider): the charge always shows, the free-shipping promise needs chosen rates
```

## Existing suites changed

| Suite | Change |
|---|---|
| `scripts/test-w6.js` | Two assertions **added**: the shopper email keeps its message and order id, and leaves out the rule name. None removed or weakened. |

No existing suite asserted an old string, so none needed updating. `test:commerce` still asserts "not implemented" in `lib/commerce/adapter.js`, which stays (inventory section 3).

## Fix round 1: what the reviewer found

Each finding was checked against the code first. None was wrong.

| Finding | Outcome |
|---|---|
| Shipping fix's real wiring had no test | Fixed. Real page, real `CartProvider`, and Settings rendered and clicked. |
| Raw-error fixes had no guard that could fail | Fixed. `friendlyCheckoutError` moved to `lib/shopper-errors.js` and tested against real messages. Checkout is clicked through with failing replies. The account and search routes are called against a store with no database tables. |
| Banned-string scan missed real text | Fixed. Second pass through SWC's parser, with self-tests. The "scans more, not less" claim was wrong and is corrected (deviation 2). |
| Every shopper email under the platform's name | Fixed. Store name on the verified address. A per-store address stays open (inventory section 5). |
| "Ludicrous speed" and "Fresh drops" still reach some stores | **Not fixed: needs an owner decision.** Recorded as a known limit (deviation 10, inventory section 5). |
| "`test:copy` guards this list" overclaimed | Fixed. New rules cover each row, and the sentence now says what isn't guarded. |
| Empty-catalog guard was narrow | Fixed. Rules for yarn, npx, `node scripts/`, "sync script" and "connect Shopify". Exact page text is asserted. |
| `/api/cart` returned raw errors | Fixed by dropping the field. `shopperErrorMessage` would not have worked here: `addItem` throws a plain `Error` with the variant id in it, which that helper lets through. |
| Console and cart disagreed | Fixed. One definition, and a comparison of values rather than JSON strings. |
| Empty home contradicted itself | Fixed, except the primary button (deviation 11). |

## Deviations and decisions to check

1. **Runner.** Section 8.15 proposes a JSX runner such as Vitest. I added no dependency: `test-copy` uses the SWC build Next ships (`next/dist/build/swc`), which is a private path pinned by `next` 16.2.9. A Next upgrade could break the suite, loudly. It is not a replacement for the runner in 8.15.
2. **The scan reads comments as non-copy, in two passes.** The per-line pass uses a stripper, not a parser, and it can scan less than the file holds: it blanks visible text after " // ". An earlier version of this packet claimed the opposite, which was wrong. The second pass reads literals through SWC's parser with whitespace collapsed, which covers that case and text wrapped across lines. Text built up at runtime from fragments is still not caught.
3. **Console changes outside the sweep's scope:** `components/admin/SettingsAdmin.js` and `lib/admin/settings.js`. Honest defaults need the founder to be told. "Fresh drops" also changed in `components/admin/cms/HomeEditor.js`, so new sections match the default. `SettingsAdmin` now imports `lib/admin/settings.js`, which stays free of server imports. `lib/brand-tenants.js` exists so that it can, and `brandDefaultsApply` in `lib/cms/store.js` now reads its list from there.
4. **Product call: nudge hidden on starter rates.** The owner may prefer otherwise. A store on starter rates still ships free at ₹999, and shoppers see "FREE" in that case, but no longer see "Add ₹X more". To reverse it, remove the `shippingRatesSet &&` check in `CartDrawer`.
5. **What BeastLife will notice**, all from code defaults:
   - The error page and empty-cart lines lose the gym voice, and the footer loses the catalog note.
   - The cart drawer no longer says "prices incl. GST".
   - Payment wording changes at checkout and on the confirmation page.
   - The newest-products title becomes "New arrivals" if BeastLife never saved its home sections. The seed scripts don't store them, and production data wasn't read. It can restore "Fresh drops" in the Home editor.
   - It keeps its nudge, hero, tagline, pages and offers.
6. **Copy claims removed, not replaced:** "prices incl. GST", "5–7 business days", "within a working day", and "each piece stays returnable". No setting holds these facts. A store that wants them can state them in its own policy pages.
7. **Stores that saved Settings earlier** already hold defaults in `shipping_config`, can't be told apart, and count as having chosen them.
8. **Not fixed, to avoid other sessions' work:**
   - `app/api/checkout/route.js`'s catch-all still returns raw messages in its JSON. No screen shows them now, because `CheckoutFlow` uses an allow-list, which the "checkout (clicked)" tests cover. The new checkout error wording depends on that client allow-list.
   - The verify path, `lib/db.js`, `lib/orders.js` and the maintenance check are untouched. `CheckoutFlow`'s verify handler did change, one display line, so it may touch the same area as the verify branch at merge.
9. **Spec citations** in GEN-03 were all accurate at `939d630`. The spec's list was incomplete, as it predicted.
10. **Owner decision: old default words already saved.** "Ludicrous speed" and "Fresh drops" still reach shoppers on any non-BeastLife store that saved the Home editor before this change, because the editor prefills from the defaults, and a published release freezes what was saved. A local probe confirmed it: after saving the old text, `getHero().subtitle` and `getHomeSections()[0].title` return it. Production wasn't read, so the number of stores is unknown. **Suggested:** a one-off replacement of those two exact strings on non-BeastLife stores. It changes stored content and published releases, so it is not done here. Owner: you, then GEN-01 or a one-off script. The suite can't catch this, because it doesn't scan stored content.
11. **Empty home.** "Shop all collections" stays on an empty home, so the page keeps one way forward, though it leads to "No collections to show yet" (GEN-01). The `#new` button is hidden on any empty hero that points at `#new`, even a customised one, because the link does nothing there. The review asked for this only on an uncustomised hero.
12. **Sender.** Only the display name changed. Stores share one address, and replies go to it. The production `MAIL_FROM` wasn't read. If it is unset, Resend's `onboarding@resend.dev` is what shoppers see, which needs fixing whatever this branch does. Notifications sent to the store itself, such as contact-form copies, also carry the store's name now.
13. **Vendor-name rule.** Razorpay, Shopify and Storeasy in visible text fail only in storefront pages and components. `lib` and `app/api` hold server errors and staff notes that name them legitimately, so only listed phrases fail there.

## Still needs a browser drill

On the harness, with a recording per section 8.15:

1. **Empty store:** home and `/collections` on a store with 0 products, at 375 and 1440 wide.
2. **Checkout on a store with its own rates:** the summary and Pay button match the amount charged, for both COD and online payment, with a real Razorpay test payment.
3. **Payment step with no Razorpay keys:** the option is disabled with the new plain message.
4. **Forced failures:** a failed verify and a failed network call show the new messages.
5. **Cart drawer:** the nudge is absent on starter rates, and appears after saving rates in Settings.
6. **Settings:** the notice's logic and the "Keep these rates" and Save payloads are tested, but not how they look. In a browser, check that the notice sits well in the shipping card, and that a save followed by a reload shows the right state.
7. **Error boundary:** force a render error on the edge runtime.
8. **Footer:** both variants in place.
9. **Cart on a real page:** the layout seeds `CartProvider` from the real cart (`app/(storefront)/layout.js`, not exercised by `test:copy`). The drawer shows the right nudge after adding to the cart.
10. **Empty home:** the shorter hero looks right with one button, at 375 and 1440 wide.
11. **A real email, on staging:** a sign-in code arrives showing the store's name as the sender.
