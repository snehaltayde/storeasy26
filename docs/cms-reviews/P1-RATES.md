# P1-RATES: checkout charged a different amount than it showed

Branch `cms/p1-rates`, from `d890d80` on `cms/phase-1`.

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done. `pnpm test`: 56 of 56 suites pass. `pnpm build` passes |
| Browser verified | Done, on the design harness (desktop Chrome, port 3251). The `c-rates` drill passed twice, 11 of 11 checks each time |
| Staging | **NOT DONE** |

## What was wrong

This is P1-DRILLS-C finding 1. A founder changed the shipping rates from flat ₹79, free over ₹999, COD fee ₹49 to flat ₹149, free over ₹4,999, COD fee ₹59. For up to 30 seconds after that, a shopper's cart drawer, review step and payment step all used the old rates, and the button read "Place order · ₹1,348". Pressing it stored the order at **₹1,507**, with shipping at ₹208, and the confirmation page showed ₹1,507. The shopper was charged an amount they had never been shown. With online payment, the Razorpay order would have been created for the server's amount too.

## Cause

- The checkout page runs on the edge runtime. It reads the store's row (which holds the rates) through that runtime's 30-second cache, and passes those rates to the page, which works out the totals in the browser.
- `POST /api/checkout` runs on Node, which has its own cache. In the drill that cache had just loaded the new row, so the route priced the cart with the new rates.
- The route never checked the shopper's amount against its own. It used its own number and charged it, whatever the button had said.

## Fix

1. **The browser sends the amount it showed.** `components/checkout/CheckoutFlow.js` adds `expectedTotal` (the button's amount) and `expectedShipping` to both the cash (`cod`) and the online (`razorpay_create`) requests.
2. **The server charges that amount or nothing.** `app/api/checkout/route.js` prices the cart as before. Then `lib/checkout-price.js` (`priceMismatch`) compares that price with `expectedTotal` to the paisa. If they differ, or if no amount was sent, the route answers 409 `PRICE_CHANGED` **before** it creates an order row or a Razorpay order. The answer includes:
   - the message the shopper reads: "Shipping changed — your new total is ₹1,507. Review and place order." If shipping is the same but the goods total changed (an offer ended, or the cart was changed in another tab), it reads "Your total changed — your new total is ₹X. Review and place order.";
   - the new total and shipping;
   - the server's cart and rates. The checkout page already sends both to this shopper.
3. **The page redraws instead of charging.** On a `PRICE_CHANGED` answer, CheckoutFlow swaps in the server's cart and rates. The order summary, the COD fee label and the button then show the server's amount. The message appears in the alert box (now `role="alert"`), and a fresh payment key is made. It does not retry by itself. The shopper reads the new total and presses again, and that press sends the new amount. `lib/shopper-errors.js` lets this message through only when it matches the exact sentence pattern. Any other text under that code shows the usual safe fallback.
4. **One consistent, current read of the rates per checkout request.** `tenantHandler` gets a new option, `fresh: "prefer"`, which the checkout route uses. It reads the store's row fresh, so a founder's new rates apply from the next order on any instance. If the fresh read fails, it falls back to the cached row as before, so a control-plane problem never closes checkout. The amount check holds either way. Within one request, the cart, the shipping price and the rates sent back in a refusal all come from that one tenant row: `shippingConfig` is read once per action and reused.

Not changed: shopper pages (the checkout page, `/api/cart` for the drawer) keep the 30-second cache. Duplicate-key handling is unchanged. A retry with the same key after an order went through still returns that order, because that check runs first.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| A shopper is never charged an amount different from the one on the button they pressed (COD) | Pass | `test:rates` "THE BUG…" and "REGRESSION: the shown total is the server's…". Drill: the first press on "Place order · ₹1,348" got 409 and stored no order. The second press on "Place order · ₹1,507" stored 1507 ([results](drills/RATES/results-c-rates.json), [refused](drills/RATES/c-rates-refused-within-30s.png), [confirmation](drills/RATES/c-rates-confirmation-within-30s.png)) |
| Online: the Razorpay order is created for the amount shown, or not at all | Pass (unit level, no payment made) | `test:rates` "THE BUG, online…": no Razorpay order was created for a stale ₹1,299. "online: the Razorpay order, the stored order and the modal…": 144800 paise in all three. Razorpay's API is a local stub. No card was entered and nothing was paid |
| The refusal says "Shipping changed — your new total is ₹1,507. Review and place order." | Pass | `test:rates`, and the drill's alert text (screenshot above) |
| The UI redraws the amounts, and the next press sends the new amount | Pass | `test:copy` "checkout (clicked, P1-RATES)…" for cash and online. Drill: after the refusal, the button read ₹1,507, the summary's shipping ₹208 and the total ₹1,507 |
| No order row and no Razorpay order on a refused press | Pass | `test:rates` (order and Razorpay call counts). Drill "a refused press stores no order" (order count before and after) |
| A request with no amount is refused (never charged unseen) | Pass | `test:rates` "a request that names no total…" (cash and online) |
| Pricing reads in a checkout request are current and consistent | Pass | `test:rates` "a save made on another instance applies to the next order…" (the row was changed behind this instance's cache) |
| A failed fresh read doesn't close checkout | Pass | `test:rates` "when the fresh read fails…". A mutation run that removed the fallback failed this test with 503 |
| Regressions: duplicate-key retry, exact-amount orders, safe error copy | Pass | `test:rates` REGRESSION tests. `pnpm test` 56/56 |
| Edge runtime | Pass | `lib/checkout-price.js` is pure: it imports only `format.js` and `money.js`, and no `node:` modules. The checkout page (edge) doesn't import it. `CheckoutFlow` (client) does. `tenant-request.js` only gains branching. `pnpm build` passes |

## Tests that fail on d890d80

The new suite, copied onto the base tree, fails 10 of 13 tests. The 3 that pass are the REGRESSION tests (full output in [tests-on-base.txt](drills/RATES/tests-on-base.txt)). Among them:

- "THE BUG": `an order was stored at 1507 while the button said ₹1348`
- "THE BUG, online": `a Razorpay order was created for 144800 paise while the button said ₹1299`
- "a request that names no total": `expected [409,"PRICE_CHANGED"], got [200,null]`
- "a save made on another instance": `got [200,null]` (base charged the cached old rates)

The `test:copy` P1-RATES test fails on the base `CheckoutFlow` with `requests on one press (cash), no silent retry: expected 1, got 2`. For that run, only `lib/checkout-price.js` was added so the suite could load.

New suite: `scripts/test-rates.js` (`pnpm test:rates`, part of `pnpm test`). It calls the real `POST /api/checkout` handler against a real local control plane and tenant database.

## Browser evidence (`docs/cms-reviews/drills/RATES/`)

Command: `DESIGN_PORT=3251 node scripts/drills/p1c/run.mjs ratesd c-rates`, with the harness on `DESIGN_PORT=3251 DESIGN_SQLD_PORT=18300`. `ratesd.mjs` reuses FIX-C's `c-rates` part, so the results land in this folder.

The `c-rates` part (`scripts/drills/p1c/fixc-c.mjs`) now expects the new behaviour:

- **Press until the order goes through.** The stored total must equal the button that was pressed. A refused press must store nothing, show the message and redraw the button and summary.
- **Setup check.** A run started within 30 seconds of an earlier run's put-back still had that run's rates cached and tested nothing. The part now waits for the caches to expire when the warmed checkout doesn't show the rates being changed from.

| Run | Result | What happened |
|---|---|---|
| 1 ([results-c-rates-run1.json](drills/RATES/results-c-rates-run1.json)) | 11 / 11 | Within 30 s the drawer, review and payment were all on the old rates ("Place order · ₹1,348", 4.0 s). The press at 4.1 s got 409 with "Shipping changed — your new total is ₹1,507…". The page then showed the button ₹1,507, shipping ₹208 and total ₹1,507. The second press at 4.7 s stored DES-A6AA19E2 at 1507. After 35 s everything was on the new rates |
| 2 ([results-c-rates.json](drills/RATES/results-c-rates.json), [log](drills/RATES/c-rates-run2.log)) | 11 / 11 | The same, with the first press at 4.2 s refused |

Screenshots: [payment step within 30 s](drills/RATES/c-rates-payment-within-30s.png), [after the refusal](drills/RATES/c-rates-refused-within-30s.png), [confirmation](drills/RATES/c-rates-confirmation-within-30s.png), [after 35 s](drills/RATES/c-rates-payment-after-35s.png).

The orders were Cash on Delivery on the harness's local database (`drill@design.test`). No real store, Shopify or payment was involved. The rates were put back after each run (200). The harness was stopped by its own process, and ports 3251 and 18300 to 18302 were free afterwards.

## Known limits

- **The shopper still sees old rates for up to 30 s.** The drawer, the review step and the payment step read the cached row, so a shopper can see the old amount until the press. What this fix guarantees is that they are never charged it: the press is refused and the page redraws. Making the checkout page read fresh would close most of that gap, at the cost of one control-plane read per checkout view. That is not done here.
- **The drawer is not redrawn by a refusal.** Only the checkout page updates. The drawer catches up when its cache expires.
- **A browser tab opened before this deploy can't place an order until it is reloaded.** The old page sends no amount, so the server refuses it. The old page then retries once and shows "Could not continue — your cart is untouched, please retry." Reloading fixes it. Letting such requests through would break the guarantee. This needs an owner decision (see below).
- **A cart change also leads to a refusal.** If anything else changes the total between page load and the press (an offer ending, a price sync, the cart edited in another tab), the shopper now gets a refusal ("Your total changed…") where before they were silently charged the new total. This is intended.
- **One more control-plane read per checkout request.** `POST /api/checkout`, including `razorpay_verify`, now reads the store's row fresh. Checkout requests are rate-limited to 10, and the route already made one uncached flag read.
- **No online payment was tried in a browser.** The harness has no Razorpay keys. Online is proved at the route, with the Razorpay API stubbed.

## Owner checks

- [ ] **Staging, cash.** Change the shipping rates in Settings. Within 30 s, as a shopper (email snehal@mediastic.in), go through checkout and press Place order. Pass: the "Shipping changed — your new total is ₹X…" message appears and the button changes to ₹X. Pressing again places the order at ₹X. Cancel the order afterwards.
- [ ] **Staging, Razorpay test mode.** Do the same with Pay online. Pass: the first press is refused with no Razorpay window. After the redraw, the Razorpay window's amount equals the Pay button. Cancel the order afterwards.
- [ ] **Wording.** Approve "Shipping changed — your new total is ₹1,507. Review and place order." and "Your total changed — your new total is ₹X. Review and place order." Both show in the red alert box.
- [ ] **Decision: browser tabs from before the deploy** can't place orders until reloaded (see Known limits). Accept that, or allow requests that send no amount for a short time after deploy?
- [ ] **Decision: should the checkout page read the rates fresh** so shoppers rarely see the refusal at all (one control-plane read per checkout view)?

These checks are listed here only. `MANUAL-CHECKS.md` is not edited on this branch, to avoid merge conflicts with the other batch D branches. Add them to that list when merging.
