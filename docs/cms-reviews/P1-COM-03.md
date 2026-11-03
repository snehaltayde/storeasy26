# P1 · COM-03 · Start an offer in plain words, safely

Branch `cms/p1-com03`, cut from `bdbe1a7`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:1403-1421` (COM-03), with OQ-03 (`:3183`, offers stay live on save), PUB-04 (`:478-500`), PUB-10 (`:571-576`), the planned column (`:2487`) and the test strategy (8.15, `:2845`).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch. The code is in `ef26961`. The stale-example fix, its tests, this packet and the drill screenshots are in the commit after it |
| Locally tested | Yes. `pnpm test`: 45 of 45 suites, 874 tests passed, 0 failed. The new suite `test:offer-form`: 44 passed, 0 failed. `test:offers` (27) and `test:offers-admin` (8) pass with neither file changed. `next build` passes. The mutation check caught 53 of 56; the 3 survivors are explained below |
| Browser verified | **Yes, on the local design harness only**: desktop Chrome, headless, 1280 and 375 wide, on port 3019. Twelve journeys passed with no console errors. See "Browser drill" for the screenshots. Not Safari, not a phone, not the storefront cart |
| Staging verified | **NOT DONE.** Migration 0019 has not run on any hosted database, and nothing is on staging |
| Production enabled | **NOT DONE.** Nothing pushed, merged, deployed or migrated |

## The bugs, reproduced first

The first five tests of `scripts/test-offer-form.js` ran against the code at `bdbe1a7`, before any fix, through the real code paths: the real engine, the real simulator on a real tenant database, the real create route called with a real request, and the real `OfferForm` and `OffersAdmin` rendered by `react-dom/server`. Exact output:

```
✗ a code's minimum-spend message uses the cart's currency, not a hard-coded rupee sign
    reason shows a rupee sign in a USD cart: Minimum spend ₹25 for this code
✗ the simulator's example uses this store's products, never the old fixture products
    fixture products in the example: Sim Whey 500g, Sim Creatine
✗ creating a new offer never overwrites an existing one
    the live offer was replaced by a create (status 200): expected 10, got 50
✗ the offer form shows no raw target kinds, no identifier fields, and the store's currency
    form for a new offer shows a rupee sign in a USD store; form for BXGY shows "productId"; form for BXGY shows "variantId"; form for BXGY shows "productType"; form for BXGY shows "Target by"; form for BXGY shows "Target value"; form for BXGY shows "handle"; form for BXGY shows a rupee sign in a USD store; form for FREE_GIFT shows "gid://"; form for FREE_GIFT shows a rupee sign in a USD store
✗ the offers list says each offer in plain words, in the store's currency
    offers list shows "tag="; offers list shows a rupee sign in a USD store; offers list lacks the plain sentence

0 passed, 5 failed
```

The third one is a bug the spec didn't name. The old form made an offer's id from its type and code or target (`OfferForm.js:52` at `bdbe1a7`), and the create route saved with an upsert. So a second "Discount code" with the code SAVE10 silently replaced the first live one. The create route now refuses a taken id (409), and new ids end in a random part.

## What was built

A founder opens Offers, presses New offer and:

1. **Chooses the kind of offer in words.** "Buy some, get some free", "Buy more, save more", "Free gift over a spend" or "Discount code", each with a one-line example.
2. **Picks what it's for, without typing an identifier.** "One product" uses the existing `ProductPicker`. "One size or option" and the free gift use the existing `VariantPicker`. "Products with a tag" and "Products of one type" open a list of the store's own tags and types, with how many products carry each, in the same dialog style. A code is suggested (SAVE10, or FLAT200 for an amount off) and follows the discount until the founder types their own. Numbers (how many, what percent, how much) are the only things typed.
3. **Reads the offer as one sentence**, for example `Buy 2 of Radiance Glow Serum 30ml, get 1 free`, plus a line or two of fine print on how ties are settled.
4. **Sees an example from the store's own products.** About 350 ms after the last change, the simulator builds a cart that gets the offer and the closest cart that doesn't. For example: `3 × Radiance Glow Serum 30ml (₹1,299 each): the shopper pays ₹2,598 instead of ₹3,897. 1 is free.` and `2 × …: nothing is free yet. The shopper needs 3 in the cart.` It also says when the store's other live offers stop this one applying. An example for rules the founder has since changed is never shown next to the new sentence: until the new one arrives, the form says "Checking on your store's products…". This came out of a review while writing this packet. The first version kept the old example on screen for a moment after each change.
5. **Starts it.** The primary button reads **Start offer** and sits below the sentence and the example. It is disabled while anything is still to do, and the list of what's left is in plain words.

Editing a live offer adds the safety the spec asks for:

- **The old and new sentences side by side** ("Live now" and "After you update"), with the schedule under each. The button reads **Update live offer** and stays disabled until something changes.
- **Turn off is at the top of the edit view** for a live offer (Turn on for one that's off), with a Live or Off badge. The list keeps its switch, now labelled "Turn off …" and "Turn on …".
- **"Before your last change"** shows the previous settings as a sentence, with **Go back to previous offer settings**. It asks once, naming exactly what shoppers will get. Going back is a swap, so going back again returns to where the founder started.
- **Form-level warnings, not validator changes**: more than 50% off (a step, a percent code, buy 1 get 2, or an amount off without a minimum of at least twice the amount), a free item worth more than the threshold, a gift worth more than the spend needed to get it, and a code another offer already uses. A warning never disables the button.

### The free-item threshold and where it lives

`FREE_ITEM_WARN_AT` in `lib/offers/plain.js`: **₹2,000** (INR), $25 (USD), €25 (EUR), £20 (GBP), AED 90, SGD 30, AUD 40 and CAD 35, roughly the same real amount each. "More than" means strictly more: ₹2,000 itself doesn't warn (by test). A currency not in the table gets only the "more than half off" checks. The numbers are a starting guess, and the owner is asked to confirm them (manual checks).

### One shared source

`lib/offers/plain.js` builds everything a founder reads from one normalized `offerTerms(offer)`: the sentence, the default shopper title, the example carts and what each should get, the warnings, and plain words for every validator message. It has no database and no `node:` imports. The form runs it in the browser and `lib/offers/simulate.js` runs it on the server. The simulator runs the real engine on each example and compares the result with what the sentence promised (`checkExample`). If they ever differ, the console shows the difference in red and tells the founder to check before starting.

## What changed

- `lib/offers/plain.js` (new): the shared source above.
- `lib/offers/match.js` (new, by the other agent; see below): the engine's `matchesTarget`, moved to its own file so the browser doesn't load the engine's built-in offer list. `engine.js` re-exports it unchanged.
- `lib/offers/catalog.js` (new): the store's currency (the catalog's own, then the store setting, then INR), current product names for the products, sizes and handles offers point at, the example catalog (everything a targeted offer covers, or the cheapest products for a gift or a code, up to 500 rows), and the tag and type lists.
- `lib/offers/simulate.js`: rebuilt on the store's own products. The fixed "Sim" baskets and the `cartKey` option are gone. It returns `sentence`, `example`, `nearMiss`, `steps`, `missing`, `warnings`, `facts` and `currency`, and keeps `cart`, `alone`, `combined`, `applied`, `activeOfferCount` and `notes` for the main example. The notes are in plain words.
- `lib/offers/store.js`: on every save, the database copies the settings being replaced into `previous_config` in the same statement, unless nothing changed. `revertOffer` swaps the two in one statement, with a check that the offer wasn't changed in between. `listRecentOfferChanges` is the PUB-04 hook. `getOfferRow` and `listOffers` return `previous`. A database without 0019 still saves (the fallback). Bundle offer rows get no way back (other agent).
- `migrations/tenant/0019_offer_previous_config.sql` (new): `ALTER TABLE offers ADD COLUMN previous_config TEXT`, alone in its file, as the spec plans (`:2487`).
- `lib/offers/engine.js`: the shopper's minimum-spend message uses the cart's currency, and `matchesTarget` is re-exported from `match.js`. Amounts, validity and order of application are unchanged.
- `app/api/admin/offers/route.js`: the list also returns `names` and `currency`, and create refuses an id that exists (409, `OFFER_EXISTS`).
- `app/api/admin/offers/[id]/revert/route.js` (new): `POST` goes back. It needs `offers.write`, with the same sign-in, same-site and role checks as every write. Errors: 404, 409 (nothing to go back to, or changed meanwhile), and 409 `NOT_HERE` for a bundle's row.
- `app/api/admin/offers/targets/route.js` (new): `GET` returns the store's tags and types for the pickers (`offers.read`).
- `app/api/admin/offers/simulate/route.js`: no `cartKey`.
- `app/(console)/admin/(authed)/offers/page.js`: passes names and currency.
- `components/admin/OfferForm.js`: rewritten as described. The stale-example fix is in the commit after `ef26961`.
- `components/admin/offerFormModel.js` (new): form state to offer and back, the id maker, the change check and the "still to do" list. No JSX, so plain node runs it.
- `components/admin/OffersAdmin.js`: each row reads as its sentence, with a plain kind name and plain switch labels. Toasts after start, update and going back. Bundle rows link to Catalog (other agent).
- `package.json`: `test:offer-form`.
- `scripts/test-offer-form.js` (new): 44 tests, listed under Acceptance.
- `scripts/test-commerce.js`: its two simulator tests pinned the old fixture baskets (`10% of the ₹1,897 basket`). They now check the same things against the store-catalog examples. See Deviations.
- `scripts/test-copy.js`: dropped the blanket allowance for `lib/offers/simulate.js` ("console offer simulator fixtures"), since the fixtures are gone and the file now gets scanned like the rest. The suite stays green.

Not changed: `lib/offers/validate.js`, `scripts/test-offers.js` and `scripts/test-offers-admin.js`. `git diff bdbe1a7 --stat -- lib/offers/validate.js scripts/test-offers.js scripts/test-offers-admin.js` prints nothing.

### Changes made by another agent in this worktree

While this run was going, an agent I could not identify edited this worktree between about 14:17 and 14:19 IST. It wasn't me, and the workflow gave me no second agent. I reported it to the main session, waited until the edits stopped, then reviewed each change and kept them, because each fixes a real gap. They are in `ef26961`:

- `lib/offers/match.js` and the `engine.js` re-export, plus a guard test that the console's imports never reach `config.js`, `engine.js` or `db.js`.
- Bundle offer rows: no way back in `store.js` (`NOT_HERE`), and the list sends them to Catalog instead of Edit and Delete. Before this, a bundle's row could be opened in the offer form, which has no rules for it.
- `exampleCatalog` reads up to 500 rows for gifts and codes too, so a big spend is shown with the dearest product rather than many cheap ones. It came with a test that seeds 40 cheap products.

Each of these has a mutation in the final mutation pass (below).

Separately, the shared scratchpad caused trouble. Another agent's command ran my first mutation runner, because we had both used `scratchpad/mutate.mjs`. That runner mutated this worktree while my own runs were going, so I discarded those results. A check confirmed every mutation site holds its original text, and the final mutation pass was rerun alone.

## Acceptance

Unless noted, the command is `node scripts/test-offer-form.js`, against real tenant file databases with every tenant migration applied: one rupee store, one dollar store, and one store before 0019. Tags follow spec 8.15. "Rendered" means compiled with Next's SWC and rendered by `react-dom/server`, as in AU-05. The form tests run the real `OfferForm` on a small hook driver: effects run, and fetch reaches the real route files. That covers logic and copy, not layout. Layout is in the browser drill.

### 1. Each of the four offer types can be created without typing an identifier

**Tag: unit (hook driver), plus browser. Status: pass.**
- `✓ Buy some, get some free: started by picking a product, no identifier typed, and the cart applies it`. Picks through the `ProductPicker`'s own `onConfirm` with an item from the real refs handler. The POST carries `{ kind: "productId", value: "gid://shopify/Product/101", label: "Radiance Glow Serum" }`, the title defaults to the sentence, and the id is made (`bxgy-radiance-glow-serum-<6 hex>`). Then the real `getCart` gives 1,299 off for 3 × serum.
- `✓ Buy more, save more: started by picking a tag from the store's list, steps typed as numbers`. The picker lists the store's own tags (from the targets route). Then 2 × SPF in the real cart: 180 off.
- `✓ Free gift over a spend: the gift is picked, its worth filled in, the amount typed as a number`. The worth is filled from the variant price (549). Then a real cart over ₹2,000 gets the gift.
- `✓ Discount code: a code is suggested, so it starts with nothing typed at all`. The founder types nothing at all. Then a real cart with SAVE10: 65 off.
- Each test records every field typed and checks that only number fields were typed (`offer-buy`, `offer-threshold` and the like). The discount-code test types none.
- `✓ the offer form shows no raw target kinds, no identifier fields, and the store's currency` and `✓ rendered: every kind of offer, new and live, …`: no `productId`, `variantId`, `productType`, `handle`, `Target by`, `Target value`, `gid://` or `tag=` anywhere in the HTML.
- `✓ the model: … a saved 'handle' pick still reads as one product`: older offers keep their target exactly unless the founder picks again.
- Browser: D1 to D4 below each started one offer of each kind from the pickers.

### 2. The sentence matches the simulator's result

**Tag: unit, plus browser. Status: pass.**
- `✓ on 2,000 generated offers and catalogs, the real engine gives every example exactly what its sentence says`. The test reads the numbers back out of each sentence with its own parser ("Buy (n) …, get (m) free", the steps, "Spend more than …", "Code X takes … off orders of … or more"). From those numbers alone it works out what each example cart must get, then runs the real engine on the example, every step and the near miss. It checks (a) the shared check, (b) the test's own figure, and (c) that the example gets the offer exactly when the sentence says it does. The generated cases cover all four kinds, all five ways an offer can target products, whole and decimal prices, repeated and unordered steps, and minimums. Each kind gets more than 200 cases, with more than 500 near misses and more than 1,000 steps.
- `✓ the sentence reads the way a founder says it`: exact sentences, including the spec's `Buy 2 of Whey, get 1 free`. A repeated step that never applies is left out, steps come in order, and dollars show as `$`.
- `✓ each example's words name the same numbers as the sentence`: exact example lines.
- `✓ the simulator's check notices when the cart disagrees with the sentence`: a different rule, a missing gift and a code accepted below its minimum are each caught.
- `✓ the simulator runs on this store's own products, for every kind of offer and pick`: through `simulateOffer` on the tenant database, every example `agrees`.
- `✓ an example avoids a product whose discount would round to nothing, and says so when every one would`
- `✓ an example for rules that have since changed is never shown next to the new sentence`: in the form, the moment "get 1 free" becomes "get 2 free", the old example is gone and "Checking on your store's products…" shows. Then the new example (4 × …) arrives and agrees.
- Browser: in D1 to D4 the sentence and example matched (green check, no red line) in a real page. E1 changed a number and read the example area straight away: `Checking on your store's products…`, never the old example.

### 3. Simulator examples use this store's products, not "Sim Whey"

**Tag: unit, plus browser. Status: pass.**
- `✓ the simulator's example uses this store's products, never the old fixture products` (a reproduction).
- `✓ the simulator runs on this store's own products, …`: every example line is one of the store's own variant ids. A tag picks a product with that tag, a size uses that size's price (50ml, ₹1,899), and the gift is never the thing being bought.
- `✓ the simulator says plainly when nothing in the store matches, and works in dollars`: `Nothing in your store matches this offer yet, so there is no example to show.`
- `✓ a store with many products: a big spend is shown with its dearest product, not 40 cheap ones` (the other agent's test).
- Browser: screenshots 03, 04, 06, 07 and 08 show the harness store's own products.

### 4. "Go back to previous offer settings" restores the last config and is live on the next cart read

**Tag: unit, plus browser. Status: pass (the cart read through the real `lib/cart.js` in the suite; the storefront cart was not opened in a browser, see Known limits).**
- `✓ going back restores the last settings, live on the next cart read, and going back again undoes it`. With buy 2 get 2 live, a real cart of 4 serums gives 2,598 off. After going back, the very next `getCart` gives 1,299. Going back again gives 2,598.
- `✓ each change keeps the settings from just before it; saving with no change keeps the way back`. This covers the schedule and name, an unchanged save, and turning the offer off and on, and shows only the last previous settings are kept.
- `✓ going back restores the schedule and the name too`: a renamed offer moved to next year comes back under its old name and is live again now.
- `✓ a save that only reorders the stored settings never offers them as a way back`: an older row whose JSON only differs in key order.
- `✓ going back keeps an offer that is off, off`
- `✓ going back is refused plainly when there is nothing to go back to, or the offer changed meanwhile`. Two at once: one goes back, the other gets `CHANGED`.
- `✓ routes: go back over the API, with sign-in, same-site and role checks`: signed out 401, another site 403, the read-only support role 403 with nothing changed, and the owner 200. An unknown id gives 404, and nothing to go back to gives 409 in plain words.
- `✓ 'Go back to previous offer settings' shows the earlier sentence, asks once, and is live on the next cart read` (form).
- `✓ a store whose database predates migration 0019 still saves offers, with nothing to go back to`
- `✓ a bundle's offer row has no way back here, so it can't drift from its bundle record` (other agent)
- Browser: D5 and D6, screenshots 11, 12 and 13.

### 5. Negative: validation and engine behaviour are unchanged, proved by `test-offers` and `test-offers-admin`

**Tag: unit. Status: pass.** `pnpm -s run test:offers`: 27 passed, 0 failed. `pnpm -s run test:offers-admin`: 8 passed, 0 failed. Neither file is changed, and neither is `lib/offers/validate.js` (the `git diff` above prints nothing). `test-offers.js` was already wired into the gate as `test:offers`. The engine changed in two ways only. The minimum-spend message is now worded in the cart's currency; for rupee amounts under 1,000 it is word for word what it was (`Minimum spend ₹999 for this code`, by test). And `matchesTarget` moved to `match.js`; the guard test checks that the engine and the console use the same function. Validator messages are translated in the form, not changed (`✓ validation messages reach the founder in plain words, …`). The warnings are only in the form: `✓ warnings, one by one: …` checks the offers that warn still pass `validateOffer`.

### 6. Negative: money messages do not hard-code the rupee sign where the store's currency differs

**Tag: unit and rendered, plus browser at INR only. Status: pass for everything this branch shows; the validator's own developer messages keep `₹` (Known limits).**
- The engine: the first reproduction. A dollar cart gets `Minimum spend $25 for this code`.
- The simulator: `✓ the simulator says plainly when nothing … works in dollars`. No `₹` anywhere in a dollar store's simulation. Example lines carry their currency, so a near miss is worded in dollars too. That was a bug the suite found mid-build: the example lines had no currency, so the engine fell back to INR.
- The form and list in a dollar store: the reproductions, and `✓ rendered: … Cart total over ($)`, plus `✓ validation messages … never as field names or a rupee sign`.
- `✓ no money sign is hard-coded in the offer console or its shared source`: no `₹` in `OfferForm.js`, `OffersAdmin.js`, `offerFormModel.js`, `plain.js`, `simulate.js`, `catalog.js` or `engine.js`.

### The spec's safety bullets

| Bullet | Where | Tag | Status |
|---|---|---|---|
| Primary reads "Start offer" or "Update live offer", below the sentence and simulator result | hook driver checks the order of the sentence, the example and the button, and the label. Rendered HTML checks the order for every kind. Browser checks layout at 1280 and 375 (D1, D5, D8, E1, E3) | unit, rendered, browser | pass. An existing offer that is off reads "Save changes" (Deviation 2) |
| Editing a live offer shows old and new sentences side by side | `✓ editing a live offer: …` and browser D5 (side by side at 1280, stacked at 375) | unit, browser | pass |
| The last previous config is kept per offer, with "Go back to previous offer settings" | acceptance 4 | unit, browser | pass |
| "Turn off" is always visible | `✓ 'Turn off' is always at the top …` (shown on open, still shown while the form has problems, takes the offer out of the next cart) and browser D5 and D7 | unit, browser | pass |
| Form-level warning, not a validator change, over 50% off or a free item over a threshold | `✓ form-level warnings: …`, `✓ warnings, one by one: …`, browser E2 | unit, browser | pass |
| Offer changes appear in "Recently published" (PUB-04) | **Deferred to phase 3**, as the brief says. Hook: `listRecentOfferChanges()` and `POST /api/admin/offers/:id/revert`, tested by `✓ PUB-04 hook: …` | unit (hook only) | deferred |

## Browser drill

Local design harness on port 3019, freshly seeded with `node scripts/dev-design.js seed`, on the final code. Desktop Chrome, headless, driven over the DevTools protocol. One local fixture was added for D3: a Shopify-shaped product, "Drill Gift Pouch", in the harness tenant database, because the seed's variants are `gid://v/N` and the unchanged validator wants a Shopify variant for a gift. All 12 journeys (D0 to D8, E1 to E3) passed, with 0 console errors. The dev server and Chrome were both stopped after the drill. Results, all at 1280 wide unless noted:

| Journey | Result | Screenshot |
|---|---|---|
| D0 The list | Seeded offers read as sentences (the old handle-targeted "Serum duo" reads `Buy 2 or more of Radiance Glow Serum 30ml, get 15% off`). No raw words | [01](drills/COM-03/01-offers-list.png) |
| D1 Buy some, get some free, by product | Picker, sentence, example from the store, "Start offer" below the example. The example also warned that the seeded Serum duo already covers this product, which is true in a real cart | [02](drills/COM-03/02-product-picker.png), [03](drills/COM-03/03-bxgy-check-and-start.png), [04](drills/COM-03/04-new-offer-check-then-start.png) |
| D2 Buy more, save more, by tag | The store's tags with product counts. Two steps, and 60% warned | [05](drills/COM-03/05-tag-picker.png), [06](drills/COM-03/06-tiered-warning.png) |
| D3 Free gift | Threshold typed, gift picked in two steps, worth filled in (499) | [07](drills/COM-03/07-gift-check.png) |
| D4 Discount code | Started with the suggested SAVE10, nothing typed | [08](drills/COM-03/08-code-check.png) |
| D5 Edit a live offer | "Turn off" at the top. "Live now" and "After you update" side by side. "Update live offer" | [09](drills/COM-03/09-edit-header-turn-off.png), [10](drills/COM-03/10-edit-old-and-new.png) |
| D6 Go back | "Before your last change", one confirm naming what shoppers get, and the list back to `get 1 free` | [11](drills/COM-03/11-before-your-last-change.png), [12](drills/COM-03/12-go-back-confirm.png), [13](drills/COM-03/13-list-after-go-back.png) |
| D7 Turn off | Header switches to "Turn on"; the primary reads "Save changes" while off | [14](drills/COM-03/14-turned-off.png) |
| D8 and E3 Phone width (375) | No horizontal scroll on the list or the form. The button sits below the example; the two sentences stack | [15](drills/COM-03/15-phone-list.png), [16](drills/COM-03/16-phone-edit-compare.png), [17](drills/COM-03/17-phone-new-code-check.png) |
| E1 A new offer, whole check card | Sentence, fine print, example, then Cancel and Start offer. After changing "get 1" to "get 2", the example area read "Checking on your store's products…" straight away, then the new example | [04](drills/COM-03/04-new-offer-check-then-start.png) |
| E2 The warning with its example | "Check this is right" under the example, and Start offer still enabled | [06](drills/COM-03/06-tiered-warning.png) |

Screenshot 17 also shows the duplicate-code warning and the one-code-per-order note. D4 had already started a SAVE10 offer, and E3 suggested SAVE10 again.

## Deviations from the spec, and decisions to check

1. **Collections can't be picked.** The engine can't match a collection, and the engine may not change here (Known limits). Tags and types are offered as the group picks instead. Owner decision.
2. **An existing offer that's off reads "Save changes"**, not "Update live offer", because it isn't live. New offers read "Start offer" and live ones "Update live offer", as specified.
3. **New offers always start on.** The old form's "Enabled" switch on create is gone, because the button says Start offer. A founder preparing one ahead sets a start date. Owner to confirm.
4. **The name shoppers see is optional.** Left blank, it becomes a plain default (the sentence for Buy some, get some free; `Buy more of X, save more`; `Free X on orders over ₹N`; `CODE · 10% off`). This name also reaches Shopify as the draft order's discount description, as titles always have (`test-shopify-boundary` SHOP-04).
5. **Create refuses an id that exists (409).** Before, it replaced the live offer. Only the console calls this route.
6. **The simulator's API changed.** `cartKey` and the fixture baskets are gone, the line titles now include the size, and the notes are reworded. `scripts/test-commerce.js` changed two tests to match: the coupon example is the store's cheapest product (`Gift Sticker — OS`, 10 off ₹99), the gift example crosses its threshold while the near miss doesn't, and the one-code note reads "one code per order".
7. **`scripts/test-copy.js` lost one allowance** (the simulator's fixtures). The file is scanned like the rest now.
8. **Going back is a swap**, so the "previous" after going back is the settings just undone. It includes the name and schedule, not the on/off switch.
9. **The engine's shopper message changed wording for rupee amounts of 1,000 or more** (digit grouping, `₹1,499`).
10. **New suite `test:offer-form`**, and three new files the spec didn't name: `offerFormModel.js`, `catalog.js` and `match.js`.
11. **The suite compiles with Next's SWC** instead of the runner in spec 8.15, as AU-05 did. No new dependency.

## Merge notes

- **Migration 0019 must run on every tenant** (`pnpm tenant:migrate -- --all`, the owner's step; not run here). Code deployed first is safe: saves skip the snapshot, and there is nothing to go back to until it runs (by test). Re-seed the design harness after merging (`pnpm seed:design`), since seeding applies all migrations.
- **Numbering:** 0018 is reserved for OVL-06 and 0020 for GEN-02. If 0019 lands before 0018, the runner applies 0018 later. That's harmless, as they touch different tables. Rule 3 of `migrations/README.md` applies: the ALTER is alone in its file.
- **Likely conflicts** with other batch B branches: the `test:*` block in `package.json` (one added line), the `ALLOWED` list in `scripts/test-copy.js` (one removed line), and `lib/offers/engine.js` if anything else touches its imports.
- **Nothing in this branch writes to Shopify.** Offers, previous settings and the tag and type lists are all local reads and writes.

## Known limits

Deliberately left, or outside what COM-03 may change. Each was read from the code on this branch. "By test" means the suite shows it.

**What an offer can be for.**
- **Collections can't be picked.** The spec says founders pick "products or collections". The engine matches a cart line by product, size, web address (handle), tag or product type (`matchesTarget`, now `lib/offers/match.js`), and a cart line doesn't know its collections (`lib/cart.js:82-109`). Collections would need a new target kind in the validator and engine, which COM-03 may not change.
- **One target per offer.** The engine takes one, so a founder can't pick three products for one offer. A tag covers that today.
- **The gift must be a Shopify variant** (`validate.js`, unchanged). A product that isn't from Shopify can't be the gift, and the form says so in plain words: `Choose the free gift from your products. It has to be a product from your Shopify catalog.`

**Money.**
- **The engine rounds every discount to whole units of money** (`Math.round` on rupees or dollars). In a dollar store, 10% off 2 × $12.99 is $3, not $2.60. That is unchanged, because pricing may not change here. The simulator shows the engine's real, rounded figure, prefers a product whose discount doesn't round to nothing, and says `rounds to nothing on a cart this small` when every product would. The owner may want this looked at for stores outside India.
- **`formatMoney` groups digits the Indian way for every currency** (`lib/format.js`, locale `en-IN`), so a dollar store sees `$1,00,000`. It's an existing helper, left alone.
- **`validate.js` still has `₹` in its developer messages.** The form shows all of them in plain words and the store's currency, but a direct API caller gets the developer text.
- **The free-item thresholds are a guess per currency** (above). A currency not listed gets no free-item amount warning.

**Previous settings.**
- **Only the last previous settings are kept**, as the spec says: name, rules and schedule, not on/off.
- **A database without 0019 saves offers without a way back.** The store spots the missing column by the `previous_config` text in the error.
- **Two people editing one offer at once: the last save wins**, as before (there is no revision check on PUT). Each save captures what it replaces in the same statement, and going back refuses if the offer changed since it was read.
- **Bundle rows have no way back in the offer console.** They follow their bundle record.

**The form and simulator.**
- **The example is one product on one cart line.** "The cheapest are the free ones" is in the fine print, not shown with a mixed cart.
- **The free-item warning for Buy some, get some free arrives with the example.** It uses the dearest product the offer covers, of up to 500 read.
- **The tag and type pickers read every product's tags each time they open** and return the top 300 of each. This wasn't measured on a large catalog.
- **The button doesn't wait for the example.** It sits below it, but a founder can press it while the example is loading.
- **Two codes with the same letters are allowed** (validation unchanged). The form warns, and the engine uses the first it finds (seen in screenshot 17).
- **The static routes `targets` and `simulate` shadow offers with those exact ids** in the `[id]` routes. The form's ids always start with the kind, and no such offer is known to exist.
- **The hook driver and rendered tests aren't a browser.** Layout, dialogs and real clicks were checked only in the headless Chrome drill on the local harness.

**Not built or not checked here.**
- **"Recently published" (PUB-04) is deferred to phase 3.** The hook is `listRecentOfferChanges()` (newest first, before and after, time of change), and Undo is `POST /api/admin/offers/:id/revert`.
- **The storefront cart wasn't opened in a browser after going back.** The suite reads the real `getCart`. The storefront runs on the edge runtime, which this harness doesn't serve against file databases (spec 8.15, the harness fix).
- **No Safari, no real phone, no staging, and no real Shopify gift variant.** See the owner's checks.

## Browser drills still needed

These are for an agent with desktop Chrome on the design harness.

- **B1, storefront cart after going back.** Needs the edge-runtime harness fix (a local libSQL server). Start a Buy 2 get 1 offer on a product with no other offer, edit it to get 2 free, add 4 to the storefront cart: 2 free. Go back in the console and reload the cart: 1 free, with no restart and no publish.
- **B2, keyboard only.** Do the New offer journey without a mouse: choose the kind, open the product picker, pick, Start offer. Focus is visible throughout, Escape closes each dialog, and focus returns to the button that opened it.
- **B3, a slow or failed example.** Throttle the network to Slow 3G and change a number: "Checking on your store's products…" shows until the new example arrives (E1 checked this at full speed only). Then go offline and change a number: the example area says it couldn't load, and the Start offer button still works once you're back online.
- **B4, a large catalog.** Seed 2,000 products with 50 tags, open "Choose a tag" and search. The list opens within about a second and searching works.

## Owner's checks (manual)

- **Decide on collections.** Offers can't be "for a collection" without an engine change (a new target kind). Tags and types work today. Pass: a yes or no, and if yes, which phase.
- **Confirm the free-item thresholds** in `FREE_ITEM_WARN_AT` (₹2,000, $25, €25, £20, AED 90, SGD 30, AUD 40, CAD 35), or give your own. Pass: numbers agreed.
- **Confirm the wording choices.** "Save changes" for an offer that's off, new offers always starting on, and the plain default names. Pass: agreed, or a change requested.
- **Run migration 0019 on staging**, then edit a live offer and press Go back. Pass: the old settings come back and a real staging cart shows them on its next load.
- **On a real phone (Safari on iPhone)**, start a discount code and edit it. Pass: no sideways scroll, the pickers open and close, and the button is below the example.
- **On a real Shopify store**, make a free-gift offer with a real product and place a real test order over the threshold. Pass: the gift appears in the cart, and the Shopify draft order's discount description reads the plain name. Cancel the test order afterwards.
- **Decide on whole-unit rounding for non-rupee stores.** Pass: a decision, since it would be an engine change.

## Test results

`pnpm test` on the final code: `45 of 45 suites passed`. Counts are passed/failed per suite, from `node scripts/run-tests.js --verbose`:

```
test:orders 27/0            test:shipping 12/0          test:shopify-push 13/0
test:shopify-boundary 41/0  test:hardening 11/0         test:offers 27/0
test:offers-admin 8/0       test:offer-form 40/0        test:events 16/0
test:tenancy 9/0            test:platform-sync 15/0     test:admin-console 9/0
test:cms-api 20/0           test:page-editor 53/0       test:refs 8/0
test:sections 15/0          test:cms 11/0               test:platform-ops 9/0
test:tenant-boundary 24/0   test:identity 22/0          test:authz 14/0
test:platform-core 15/0     test:jobs 12/0              test:sync-generations 8/0
test:order-projection 14/0  test:commerce 10/0          test:privacy 11/0
test:security 19/0          test:content 19/0           test:releases 25/0
test:themes 10/0            test:storefront 15/0        test:surfaces 15/0
test:billing 14/0           test:provision 9/0          test:reporting 6/0
test:tenant-ops 9/0         test:marketing 4/0          test:customers 9/0
test:commerce-exp 18/0      test:growth 21/0            test:agency 16/0
test:w6 16/0                test:copy 52/0              test:media-upload 119/0
```

Total: 874 passed, 0 failed (`test:offer-form` 44/0). The baseline at `bdbe1a7` was 44 of 44 suites; `test:offer-form` is the forty-fifth. `test:perf` was not run, as it is a measurement. `test:offer-form` has passed on every run on code no other process was touching: 3 solo runs before the other agent's edits, and every solo and gate run since. `next build` passed on the final code, listing `/api/admin/offers/[id]/revert` and `/api/admin/offers/targets`.

**A note on runs that overlapped other agents.** Twice during this run, other processes touched this worktree: another agent's command ran my first mutation runner, and another agent edited files (above). The suite failed while that was happening, with `SQLITE_READONLY` from two runs sharing the suite's database files, and with mutated code. Those runs are not counted. Every result above came after both had stopped, with each mutation site checked back to its original text.

**Mutation check (scratch, not committed; run alone on the final code).** 56 deliberate breakages, each run against `test:offer-form`, and 53 caught. Covered: the sentence, the shared terms, the example builder, the check, the warnings and their threshold, the plain errors, the engine message, the catalog reads, the store's snapshot, swap and fallback, the routes' overwrite and role checks, the form's label, Turn off, way back, side by side, warnings, change detection, code warning, picks, gift worth, auto-check, rupee sign and stale example, the model, the list, and the other agent's bundle, `match.js` and catalog changes. The first clean pass caught 47 of 55. Five of its survivors became tests: an example that rounds away, going back keeping the new schedule, same settings offered as a way back, the simulator's `warnings`, and switching the kind of pick. The three that survive:

- `example: code minimum ignored` (`const valid = true` in the code example). This is equivalent by construction: the example cart is built to meet the minimum, so `valid` is only false if the price times the quantity lands a float hair under it. It's kept as a guard.
- `catalog: tag matched loosely` (dropping the exact-tag filter after SQL). This is equivalent in practice: the SQL already matches the tag with its JSON quotes, and the example builder filters again with the engine's own rule.
- `store: going back has no change check` (dropping `previous_config = <read>` from the revert's update). The other condition (`config = <read>`) still refuses a revert racing a rules change (by test). The dropped one only matters for a name-only or schedule-only save landing between the revert's read and its write. That interleaving can't be forced without test hooks in the store, so it was left as code-reading only.
