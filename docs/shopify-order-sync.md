# Shopify Order Sync — locked mechanism (Session 8 spike)

**Goal:** after a guest pays through our own checkout (Razorpay / COD), push a matching
order into Shopify whose **total equals the externally-captured amount to the rupee**, with
the stacked offers + free gift + shipping represented, marked **paid**, and GST handled so
Shopify never silently re-adds tax and breaks the match.

This was proven end-to-end against `beastlife-dev.myshopify.com` (Admin API `2025-10`).
Spike harness: [`scripts/spike-order-push.js`](../scripts/spike-order-push.js).

> **PRODUCTIONIZED in Session 12** → [`lib/shopify-push.js`](../lib/shopify-push.js), wired
> into checkout/webhook via `after()`, with retry queue, dead-letter + alerts,
> tag-based idempotent adoption, and a total==captured reconciliation guard.
> See the "Shopify push" section of [orders.md](./orders.md). This doc remains the
> mechanism reference (draft-order representation, GST decision tree, orderCreate fallback).

---

## TL;DR — what to build in Session 12

1. Read the real store's `shop.taxesIncluded` once (it decides the path).
2. **Primary: Draft Order API** (`draftOrderCreate` → `draftOrderComplete(paymentPending:false)`).
   Cleanest discount/gift representation. Correct when the store is **tax-inclusive** (the
   Indian D2C norm). Record the Razorpay id in `customAttributes`.
3. **Fallback: `orderCreate`** with `taxesIncluded:true` + explicit included `taxLines` +
   a `razorpay` SALE transaction. Use when the store is **tax-exclusive with GST rates** (a
   draft would add tax on top). Gives exact total + GST control, but you lose the manual
   order-level discount field (bake discounts into line prices or use a real `discountCode`).
4. Guard creation with an **idempotency key** (our `BL-XXXX` order id) so retries don't
   duplicate the Shopify order.

**Proven orders (evidence in admin):**

| Order | Mechanism | Total | Tax | Status |
|---|---|---|---|---|
| `OID597492BL` (`gid://shopify/Order/7050445095129`) | Draft → complete | ₹13,565 == paid | ₹0 (no rates on dev store) | PAID |
| `OID597493BL` (`gid://shopify/Order/7050451091673`) | `orderCreate` | ₹13,565 == paid | ₹2,054.14 **included** (not re-added) | PAID, gateway `razorpay` |

---

## The money model (our side)

Everything in the app is **integer rupees**. The offer engine
([`lib/offers/engine.js`](../lib/offers/engine.js)) returns:

```
subtotal      = Σ price × qty
discountTotal  = productDiscount (BXGY + TIERED_QTY) + couponDiscount   // all Math.round-ed
total          = subtotal − discountTotal                               // gift is a derived free line, value NOT in total
```

Razorpay captures `Math.round(total * 100)` paise (see `app/api/checkout/route.js`). So the
**captured amount in rupees == `total`** (+ shipping, once we charge it). Our worked example
(the canonical demo cart):

```
3× BCAA Mango @499  + 1× Whey @4949 + 1× Whey @9749        subtotal  16195
  − BXGY (cheapest BCAA free)          499
  − Whey 5% qty tier                   734
  − BEAST10 (10% of net 14962)        1496   → discountTotal 2729
                                              total      13466
  + free Shaker (value 315, a 100%-off line, not in total)
  + shipping                            99
                                              PAID       13565   ← must equal Shopify order total
```

---

## Cart → Shopify mapping (the core of the mechanism)

| Cart concept | Shopify draft order field |
|---|---|
| Each paid line (normal price) | `lineItems[]` `{ variantId, quantity }` — Shopify uses the variant's own price |
| Free gift (engine `gifts[]`) | a `lineItems[]` entry with `appliedDiscount { valueType: PERCENTAGE, value: 100 }` → nets to ₹0 |
| Stacked savings (`discountTotal`, the non-gift part) | **one order-level** `appliedDiscount { valueType: FIXED_AMOUNT, value: discountTotal }` |
| Shipping | `shippingLine { title, price }` |
| Razorpay payment id | `customAttributes [{ key:"razorpay_payment_id", value }]` (+ tag, + note) |

Why one order-level fixed discount instead of per-line: the engine already collapses BXGY +
TIERED + COUPON into `discountTotal`; representing it as a single custom discount is exact and
keeps line unit prices honest. The gift is the **only** line-level discount.

Arithmetic Shopify performs (verified): `subtotal(incl. gift) − [gift 100% + order FIXED_AMOUNT]
+ shipping + tax`. With the gift line cancelling itself, that's `16195 − 2729 + 99 = 13565`. ✔

---

## Mechanism A — Draft Order API (PRIMARY)

```graphql
mutation CreateDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id name totalPriceSet { presentmentMoney { amount } } taxesIncluded }
    userErrors { field message }
  }
}
```

`input` (see `draftInput()` in the spike script):

```jsonc
{
  "email": "guest@…",
  "tags": ["storeasy26", "razorpay-paid"],
  "customAttributes": [
    { "key": "razorpay_payment_id", "value": "pay_…" },
    { "key": "captured_amount_inr", "value": "13565" }
  ],
  "lineItems": [
    { "variantId": "gid://shopify/ProductVariant/45321217147097", "quantity": 3 },
    { "variantId": "gid://shopify/ProductVariant/45042167054553", "quantity": 1 },
    { "variantId": "gid://shopify/ProductVariant/45323586633945", "quantity": 1 },
    { "variantId": "gid://shopify/ProductVariant/48656508289241", "quantity": 1,
      "appliedDiscount": { "valueType": "PERCENTAGE", "value": 100, "title": "Free gift" } }
  ],
  "appliedDiscount": { "valueType": "FIXED_AMOUNT", "value": 2729, "title": "Stacked offers",
                       "description": "BXGY (BCAA) + Whey 5% tier + BEAST10" },
  "shippingLine": { "title": "Standard shipping", "price": "99.00" }
}
```

Then complete + mark paid:

```graphql
mutation Complete($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: false) {   # false ⇒ order is marked PAID
    draftOrder { order { id name displayFinancialStatus } }
    userErrors { field message }
  }
}
```

**Result (`OID597492BL`):** `displayFinancialStatus: PAID`, total **13565.0**, shipping 99,
discounts 3044 (2729 "Stacked offers" + 315 gift line), gift line `discountedUnitPrice 0.0`,
both discount applications visible, `razorpay_payment_id` on the order. Tax 0 here only because
the dev store has no GST rates.

**Pros:** richest representation (order discount + per-line gift discount + shipping all show
in admin). **Con:** tax is computed by the store's tax engine — see the tax section.

The `draftOrderComplete` transaction is gateway **`manual`**; the Razorpay id lives in
`customAttributes`. If you need the Razorpay reference *on the transaction*, use Mechanism B.

---

## Mechanism B — `orderCreate` (FALLBACK: force total + explicit GST + real txn)

Use when the store is tax-exclusive with GST rates (a draft would add tax on top), or when you
want the Razorpay reference booked as the payment transaction.

```graphql
mutation($order: OrderCreateOrderInput!) {
  orderCreate(order: $order) {
    order { id name displayFinancialStatus taxesIncluded
            totalPriceSet { presentmentMoney { amount } }
            totalTaxSet  { presentmentMoney { amount } }
            taxLines { title rate priceSet { presentmentMoney { amount } } }
            transactions(first:5){ kind status gateway authorizationCode } }
    userErrors { field message }
  }
}
```

`order` (see `order-create` in the spike script). Key fields:

```jsonc
{
  "currency": "INR",
  "taxesIncluded": true,                 // ⇐ tells Shopify the price ALREADY includes the tax
  "financialStatus": "PAID",
  "lineItems": [
    { "title": "storeasy26 cart …", "quantity": 1, "taxable": true, "requiresShipping": true,
      "priceSet": { "shopMoney": { "amount": "13466.00", "currencyCode": "INR" } },
      "taxLines": [ { "title": "IGST 18%", "rate": 0.18,
                      "priceSet": { "shopMoney": { "amount": "2054.14", "currencyCode": "INR" } } } ] }
  ],
  "shippingLines": [ { "title": "Standard shipping",
                       "priceSet": { "shopMoney": { "amount": "99.00", "currencyCode": "INR" } } } ],
  "transactions": [
    { "kind": "SALE", "status": "SUCCESS", "gateway": "razorpay",
      "authorizationCode": "pay_…",
      "amountSet": { "shopMoney": { "amount": "13565.00", "currencyCode": "INR" } } }
  ],
  "customAttributes": [ { "key": "razorpay_payment_id", "value": "pay_…" } ]
}
```

**Result (`OID597493BL`):** `PAID`, `taxesIncluded: true`, total **13565.0**, tax **2054.14**
shown as **included** (the total did **not** become 13565+2054), txn `gateway: "razorpay"` with
the payment id as `authorizationCode`. This is the definitive GST-inclusive proof.

**Con:** `OrderCreateOrderInput` has **no manual order-level discount** — only `discountCode`.
To represent the stacked savings either (a) bake them into line `priceSet` (total stays exact,
but the "discount" isn't a labelled line), or (b) pre-create a matching `discountCode`. Above,
the cart is shown as one priced line for clarity; a real impl would itemise per product with
per-line `taxLines` (allocate the discount across lines first).

---

## Tax — India GST decision tree (the thing that breaks the match)

Shopify's order tax depends on the **store** setting `taxesIncluded` + configured rates:

- **`taxesIncluded: true`** (prices include GST — standard Indian B2C): Shopify *decomposes*
  the price into net + tax and shows tax as **included**. Total = Σprices − discounts + shipping.
  **No tax added on top → draft order total == our captured amount.** ✅ Use **Mechanism A**.
- **`taxesIncluded: false` + GST rates set:** Shopify **adds** GST on top of the net price →
  order total > captured amount. ❌ A plain draft order breaks the match. Options:
  1. set the store to tax-inclusive (align the model once), then use Mechanism A; or
  2. **Mechanism B** — `orderCreate` + `taxesIncluded:true` + explicit included `taxLines`
     (proven: total stays 13565, GST 2054.14 shown as included); or
  3. draft + `taxExempt: true` → total matches but tax shows ₹0 (a GST-reporting gap — avoid
     unless GST is captured elsewhere).
- **`beastlife-dev` today:** `taxesIncluded: false` but **no GST rates** → tax computes to 0,
  so the draft happens to match. This is a dev-store artifact, **not** representative of the
  real store — do not rely on it.

**Action for Session 12:** query `shop.taxesIncluded` on the *real* BeastLife store first. If
inclusive → Mechanism A. If exclusive → fix the store setting or use Mechanism B. `taxShipping`
on the dev store is `false`; confirm on the real store (if shipping is taxable, add a `taxLine`
to the shipping line in Mechanism B).

---

## Open items for Session 12 (productionising the spike)

- **Idempotency:** pass our `BL-XXXX` id as the draft/order `name` or a metafield/customAttribute
  and check-before-create (Shopify has no native idempotency key) so a webhook/retry can't double-post.
- **Per-line GST allocation** in Mechanism B (split the order discount across lines, then 18%
  included per line) if itemised tax is required for invoices. Mixed GST slabs (5/12/18%) ⇒ per-line rates.
- **CGST/SGST vs IGST:** intra-state orders split into CGST 9% + SGST 9% (two tax lines);
  inter-state is IGST 18%. Drive off the shipping state vs the store's home state.
- **Customer linkage:** attach `customer { email/phone }` so orders group under the buyer.
- **Inventory / notifications:** `orderCreate` `options` (e.g. `inventoryBehaviour`,
  `sendReceipt`) — decide whether Shopify decrements stock / emails the customer, to avoid
  double-sending alongside our own confirmation.
- **Failure handling:** Shopify push must be **async + retryable after** our order is already
  saved + the customer confirmed (never block the buyer on a Shopify hiccup — same lesson as the
  Razorpay webhook backstop).
- **Token:** uses `SHOPIFY_ADMIN_TOKEN` (scopes present: `write_orders`, `write_draft_orders`,
  `read_products`). Swap to BeastLife's real-store creds when ready (mechanism is identical).
