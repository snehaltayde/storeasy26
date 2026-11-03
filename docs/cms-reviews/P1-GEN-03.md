# P1 review packet — GEN-03: No wrong-brand or developer text reaches shoppers

Branch `cms/p1-gen03`, cut from `939d630`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:1954`. Inventory: `docs/storefront-copy-inventory.md`.

## Status

| Stage | State |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: 40 of 40 suites passed in the final run. `test:shopify-push` fails intermittently, also on the untouched baseline (see Test results). |
| Browser verified | **NOT DONE.** No browser or dev server in this batch. |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing deployed or pushed. |

## Acceptance items

| Item | Tag | Status | Evidence |
|---|---|---|---|
| A test fails if a banned string appears in storefront code. | unit | Locally tested | `node scripts/test-copy.js`: "banned strings: none in 158 storefront source files" passes. Planted-regression runs below all exit 1. |
| Negative: an empty catalog shows shoppers no developer command. | rendered | Locally tested | "empty catalog (rendered): home…" and "…collections index…" compile the real `page.js` files with Next's SWC and render them with `react-dom/server`, against a tenant database with 0 products. "empty catalog can fail" renders the old block and requires the failure. |

The rendered tag has a limit: `app/(storefront)/page.js` runs with real repo, store and section-data modules, but `lib/content/resolve.js` is replaced by the draft getters it would call, because it needs a request. This is not a run through Next's server or the edge runtime. See the browser drills.

## Also required by the task

| Item | Tag | Status | Evidence |
|---|---|---|---|
| Written inventory with a decision per string | manual | Done | `docs/storefront-copy-inventory.md` |
| Default shipping values made honest | rendered, unit | Locally tested | See Shipping below |
| Shipping calculation unchanged | unit | Locally tested | `git diff 939d630 -- lib/shipping.js scripts/test-shipping.js` is empty. `node scripts/test-shipping.js`: 12 passed, 0 failed. |
| BeastLife's stored content keeps working | unit | Locally tested | "BeastLife keeps its stored voice" stores a gym-voice hero and tagline and reads them back. `test:storefront`: its pages still serve only BeastLife. |

## What changed

- **Copy:** the spec's known list, plus what the sweep found. The worst new finds were "(test mode)" and "Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable." on the checkout payment step, the internal rule name in shopper emails, and raw provider and database errors shown at checkout and on account forms.
- **New files:** `components/EmptyCatalog.js`, `lib/shopper-errors.js`, `scripts/test-copy.js`, `docs/storefront-copy-inventory.md`.
- **No new CMS field.** Items that should become editable are in inventory section 5.

## Shipping

Found by tracing, all in inventory section 4:

1. **A real bug.** `CheckoutFlow` called `computeShipping` with no config, so the checkout summary and Pay button showed the code default on every store, even one with its own rates, while the server charged the store's rates. The page now passes the same value the server uses. Test: "checkout preview (rendered) shows the store's own rates, the same the server charges".
2. **The free-shipping nudge** is a promise in the store's name, so it now needs rates the store chose: `shippingRatesSet` in `lib/cart.js`. The charge line always shows.
3. **The console.** The Settings form showed defaults as if saved, and every save wrote them to `shipping_config`, so saving a support email adopted them silently. It now says so, sends starter rates only if changed, and offers "Keep these rates".

**Charges:** the server computes them as before, from the same config. The only code changed on those paths is display and the two error strings at `app/api/checkout/route.js:116` and `:197`.

## Test results

`pnpm test:copy` = `node scripts/test-copy.js`: **27 passed, 0 failed.**

Related suites, in the final full run: `test:shipping` 12/0, `test:storefront` 15/0, `test:cms` 11/0, `test:commerce` 10/0, `test:admin-console` 9/0, `test:w6` 16/0, `test:sections` 15/0, `test:customers` 9/0.

Every `test:*` except `test:perf`, run one after another with `node <script>`: **40 suites, 0 failed.**

```
orders 27/0 · shipping 12/0 · shopify-push 13/0 · hardening 11/0 · offers-admin 8/0 · events 16/0
tenancy 9/0 · platform-sync 15/0 · admin-console 9/0 · cms-api 20/0 · refs 8/0 · sections 15/0
cms 11/0 · platform-ops 9/0 · tenant-boundary 24/0 · identity 22/0 · authz 14/0 · platform-core 15/0
jobs 12/0 · sync-generations 8/0 · order-projection 14/0 · commerce 10/0 · privacy 11/0 · security 13/0
content 19/0 · releases 25/0 · themes 10/0 · storefront 15/0 · surfaces 15/0 · billing 14/0
provision 9/0 · reporting 6/0 · tenant-ops 9/0 · marketing 4/0 · customers 9/0 · commerce-exp 18/0
growth 21/0 · agency 16/0 · w6 16/0 · copy 27/0
```

`pnpm build`: completed, routes listed. It ran before the last test and docs edits, none of which touch app code.

### One flaky suite, not caused by this branch

`test:shopify-push` failed once in an earlier full run on this branch: "sweep recovers stale syncing_shopify from a crashed worker" ("retried next sweep"). Repeated runs of that suite alone:

| Tree | Failures |
|---|---|
| Untouched `939d630`, exported from git | 2 of 12 |
| This branch | 3 of 12, and 2 of 6 before that |

It is the same order of failure on both trees. The likely cause, not proven: the test sets a 1 ms backoff, so a sweep in the same millisecond finds the order not yet due (`lib/shopify-push.js:339`). I did not fix it, since it is outside this requirement. **It needs its own fix, or it will show up in reviews and in the SHOP-06 CI gate.**

## Proof that the test can fail

Inside the suite: one planted sample per banned rule, the old empty block rendered, and the checkout wiring removed.

Against real files, planting each regression, running the suite, then restoring the file:

```
[exit 1] collections page: 'run pnpm sync' back in the empty state
   ✗ banned strings: none in 158 storefront source files
   ✗ empty catalog (rendered): collections index shows no developer command
[exit 1] home empty state: developer command back in the component
   ✗ banned strings: none in 158 storefront source files
   ✗ empty catalog (rendered): home shows a shopper message and no developer command
[exit 1] footer: catalog note back
   ✗ banned strings: none in 158 storefront source files
   ✗ footer (rendered): both variants carry the store's name and no catalog note
[exit 1] error page: gym voice back
   ✗ banned strings: none in 158 storefront source files
   ✗ error page (rendered): plain words, no status code, no gym voice
[exit 1] default hero: ludicrous speed back
   ✗ banned strings: none in 158 storefront source files
   ✗ empty catalog (rendered): home shows a shopper message and no developer command
   ✗ code defaults: a store with nothing set reads neutral
[exit 1] checkout preview: store's rates no longer passed
   ✗ checkout preview (rendered) shows the store's own rates, the same the server charges
   ✗ checkout preview can fail: dropping the store's rates is caught
[exit 1] cart drawer: nudge shown regardless of who chose the rates
   ✗ cart drawer (rendered): the charge always shows, the free-shipping promise needs chosen rates
```

## Existing suites changed

| Suite | Change |
|---|---|
| `scripts/test-w6.js` | Two assertions **added**: the shopper email keeps its message and order id, and leaves out the rule name. None removed or weakened. |

No existing suite asserted an old string, so none needed updating. `test:commerce` still asserts "not implemented" in `lib/commerce/adapter.js`, which stays (inventory section 3).

## Deviations and decisions to check

1. **Runner.** Section 8.15 proposes a JSX runner such as Vitest. I added no dependency: `test-copy` uses the SWC build Next ships (`next/dist/build/swc`), which is a private path pinned by `next` 16.2.9. A Next upgrade could break the suite, loudly. It is not a replacement for the runner in 8.15.
2. **The scan reads comments as non-copy,** using a line-based stripper rather than a parser. If it misreads a line, it scans more, not less, for the cases it tests. Text built up at runtime from fragments would not be caught by the scan.
3. **Console changes outside the sweep's scope:** `components/admin/SettingsAdmin.js` and `lib/admin/settings.js`. Honest defaults need the founder to be told. "Fresh drops" also changed in `components/admin/cms/HomeEditor.js`, so new sections match the default.
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
   - `app/api/checkout/route.js`'s catch-all still returns raw messages in its JSON. No screen shows them now, because `CheckoutFlow` uses an allow-list. The new checkout error wording does depend on that client allow-list.
   - The verify path, `lib/db.js`, `lib/orders.js` and the maintenance check are untouched. `CheckoutFlow`'s verify handler did change, one display line, so it may touch the same area as the verify branch at merge.
9. **Spec citations** in GEN-03 were all accurate at `939d630`. The spec's list was incomplete, as it predicted.

## Still needs a browser drill

On the harness, with a recording per section 8.15:

1. **Empty store:** home and `/collections` on a store with 0 products, at 375 and 1440 wide.
2. **Checkout on a store with its own rates:** the summary and Pay button match the amount charged, for both COD and online payment, with a real Razorpay test payment.
3. **Payment step with no Razorpay keys:** the option is disabled with the new plain message.
4. **Forced failures:** a failed verify and a failed network call show the new messages.
5. **Cart drawer:** the nudge is absent on starter rates, and appears after saving rates in Settings.
6. **Settings, untested in any form beyond the source check:**
   - The notice renders in the shipping card.
   - "Keep these rates" works and clears the notice.
   - Saving a support email does not clear it.
7. **Error boundary:** force a render error on the edge runtime.
8. **Footer:** both variants in place.
