# Phase 8 plan: India and global checkout (roadmap Phase 5)

Architect plan, 2026-11-26 02:35 IST, with one session change (the pincode dataset download is an owner step). Four tenant migrations (0036–0039, additive). No platform migration, no new permission action, no new dependency.

## Findings that shape the plan
1. One pure money engine: `computeShipping` (`lib/shipping.js`) does flat rate, free threshold, COD fee and pincode-prefix `zones` (`{label, prefixes, flatRate, freeThreshold}`) from `tenants.config.shipping_config`, validated by `validateShippingConfig` (`lib/admin/settings.js`). Zones have no delivery days and no COD flag.
2. `app/api/checkout/route.js` recomputes cart + shipping, then `priceCheck` → 409 `PRICE_CHANGED`. `createRazorpayOrder` is called without `currency` (INR default). `CheckoutFlow.js` hard-codes `country: "India"`, free-text state, and recomputes shipping on the client.
3. Shopper auth is email OTP (`lib/customers.js`): `sha256(code|secret)`, 10 min, 5 attempts, 3 live codes per email. `customers.default_address` is one JSON. `redactCustomer` (`lib/privacy.js`) deletes account rows. No console screen reads customers; support redaction is `redactOrderForRole`.
4. `lib/notifications.js` is email only; no SMS provider.
5. Offers have `starts_at`/`ends_at`, read active-at-now by `getActiveOffers`, with `ScheduleField` and `offerScheduleStatus`. Bundles have no schedule; `syncOffer` writes the `bundle-<id>` offer row with null times; `bundle-read` already has `offer_scheduled`. Targets: handle, productId, variantId, tag, productType — no collection.
6. Currency comes from Shopify product rows; `formatMoney` always uses `en-IN`; `PRICE_CHANGED_MESSAGE` regex assumes symbol+number with no space; the Shopify push builds drafts in the shop's currency and compares with `order.total`. Storefront pages are `force-dynamic`.

## Order and parallelism
- **Step 0 (Opus, small, no behaviour change):** split `components/checkout/CheckoutFlow.js` into `AddressStep.js`, `PaymentStep.js`, `OrderSummary.js` and a pure `checkoutModel.js` (`emptyForm`, `applyAddress(form, patch, source)`, `addressValid`); `AddressStep.js` gets an anchor `{/* saved-addresses */}`; add `validatePaymentConfig` to `lib/admin/settings.js`; extend `validateShippingConfig` with `dispatchDays`, `deliveryDays {min,max}`, `zone.deliveryDays`, `zone.cod` (absent fields stay absent, so existing stored JSON and `shippingFormChanged` are byte-identical); update `lib/types/tenant.ts`; add `scripts/drills/checkout/{run.mjs,lib.mjs,stage-baseline.mjs}` (COD order placed) and `drill:checkout`.
- **Then lines 1, 2, 3 and 5 in parallel**, own worktrees. Merge order: 2 (0036), 3 (0037), 1, 5 (0038).
- **Line 4 (0039) is cut from `main` after those four merge** (it touches cart, checkout, push and display money the others change).
- Ownership: line 2 owns `CheckoutFlow.js` (shared client state: form, method, quote), `placeOrder.js`, `app/api/checkout/route.js`. Line 1 owns `AddressStep.js` and `lib/shipping.js`. Line 3 writes only `SavedAddressPicker.js` plus one import and one element at the step-0 anchor. Lines 1 and 3 change the form only through `applyAddress`. Line 5 owns `lib/offers/*`, `lib/bundles.js`, `lib/commerce/bundle-read.js`, and only the `collections` field in `lib/cart.js` and `effective.js cartRows`.
- Append-only shared files (keep both sides): `package.json`, `scripts/drills/run-isolated.mjs`, `scripts/drills/checkout/run.mjs`, `scripts/support/*`, `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/cms-reviews/MANUAL-CHECKS.md`.
- Every builder runs `pnpm test` plus `test:shopify-boundary`, `test:security`, `test:shopper-reads`; lines with screens also `test:console-kit` and `test:console-shell`; line 4 adds a settings nav item, so it runs `drill:shell`.

## Decisions (schema and permissions first)
1. **0036 (line 2):** `cod_otps` table; `orders.payment_discount REAL NOT NULL DEFAULT 0`, `orders.cod_verified_at TEXT`. Total = subtotal − discount_total − payment_discount + shipping_total.
2. **0037 (line 3):** `customer_addresses`; existing `default_address` values copied into rows by the same SQL; the old column stays and is no longer read.
3. **0038 (line 5):** `bundles.starts_at`, `bundles.ends_at`, mirrored onto the `bundle-<id>` offer row by `syncOffer`; a mismatch shows as `offer_differs`.
4. **0039 (line 4):** `orders.market`, `base_currency`, `fx_rate`, `base_subtotal`, `base_discount_total`, `base_shipping_total`, `base_total`; reads through `hasColumns`.
5. No platform migration. `payment_config` and `markets` live in `tenants.config`, edited with `settings.write` (admin, owner), audited by the existing `settings.write` audit with the changed keys.
6. No new action. Scheduling an offer or bundle is `offers.write`, the same act as turning one on today (staff hold it since S27); offers are commerce settings, not CMS documents. Audited as `offers.write` with the window in the diff. (Risk 5: staff can make prices go live without an admin — status quo, recorded so the owner can change it.)
7. Addresses are shopper data with no console read; no admin, operator or plugin route returns them. A shopper's own delete is a real delete (privacy is the shopper's choice; "archive, not delete" covers documents). Order snapshots keep their own copy. `redactCustomer` also deletes addresses.
8. **Pincodes from a bundled offline dataset** (India Post "All India Pincode Directory", data.gov.in, GODL-India, commercial use with attribution), stored as `data/in-pincodes.json` (~19,100 pins → `[districtIdx, stateIdx]` with name tables, ~250 KB raw / ~70 KB gzipped), read only by the Node route `/api/pincode` behind `lib/pincode/index.js` (an `offline` provider and a test fake). City is filled with the district and stays editable. **Session change:** downloading the dataset is an owner step (no file downloads without the owner's OK). The builder ships `scripts/build-pincodes.js` (CSV → JSON), the provider, and a small hand-written fixture for tests only; until the owner runs the build, the route answers "not found" for every pin, and the shopper types city and state as today.
9. Delivery estimates in calendar days from the store's `dispatchDays` plus the zone's or default `deliveryDays`, in the store timezone; nothing configured → no estimate.
10. **One server quote:** a `quote` action on `/api/checkout` returns both payment methods' totals, the nudge, COD availability and whether an OTP is needed; the client shows only quote numbers; every placing action recomputes.
11. **Prepaid nudge:** optional `payment_config.prepaid {kind: percent|fixed, value, max}`; percent capped at 20, rounded down to whole currency units, on the post-offer goods total; doesn't change free-shipping eligibility; goes to Shopify in the existing `appliedDiscount` ("Prepaid discount"); nudge = COD total − prepaid total.
12. **COD rules:** `payment_config.cod {maxTotal, otp: off|always|above, otpAbove, otpChannel: sms|email}`; `zone.cod: false` hides COD for the zone; COD only in the base market.
13. **COD OTP:** 6 digits, `sha256(code|challengeId|store link secret)`, 5 min, 5 attempts; 30 s resend cooldown, 3 sends per cart per 30 min, 5 per phone hash per hour, 10 per IP per 15 min; bound to cart id, idempotency key, phone hash and amount (minor units); consumed by the order. SMS via `lib/messaging/sms.js`: the `stub` provider runs only outside production; in production with no provider, settings refuse the SMS channel. Email uses `notify`.
14. **Multi-currency with founder-set fixed rates and rounding:** `{country codes, currency, rate (base units per 1 market unit), rateSetAt, rounding: exact|whole|x.99, flatRate, freeThreshold, enabled}`. Rejected: per-country price lists (a per-variant UI over Shopify), live FX (outside service; prices move under shoppers).
15. **Two engine runs per checkout:** the presentment run (converted unit prices and offer amounts, the market's shipping) is what the shopper sees and Razorpay charges; the base run is what goes to Shopify and reports.
16. Razorpay: a market may only use a currency on `RAZORPAY_CURRENCIES` (`lib/money.js`), and the founder must tick "International payments are on in my Razorpay account".
17. Choosing a market: a footer picker (GET `/api/market`, no JavaScript needed) and the checkout country; the address country decides at checkout and a different one gives a 409 in the new currency; an `x-vercel-ip-country` suggestion applies only on the first visit.
18. Collection target: `target.kind: "collection"` with a collection handle; membership from synced `collection_products`.
19. Schedule windows in UTC ISO: `starts_at` inclusive, `ends_at` exclusive, checked on every read.

---
## Line 1: a shopper can enter a pincode and get their address filled and a delivery estimate
**Features (floor)**
1. Checkout asks PIN code first; six valid digits call `GET /api/pincode?pin=`; city and state fill only if empty or auto-filled before (typed values never overwritten); chip "Bengaluru, Karnataka · Change"; not found: "We couldn't find that PIN code. Check it, or type your city and state." (order still possible); bad format: inline error.
2. Estimate under the PIN and in the summary: "Delivery by Tue 1 Dec – Thu 3 Dec", from settings in the store timezone; unset → no line.
3. Product page "Check delivery" (`DeliveryCheck`): the estimate, "Cash on delivery available" or not (`zone.cod`), the zone's free-shipping threshold; PIN kept in `localStorage` (`sf_pin`) and prefills checkout.
4. Shipping settings: dispatch days (0–10), default delivery days min/max (1–30, min ≤ max), per-zone delivery days and a "Cash on delivery" toggle; `shippingExample` sentences cover the estimate.
5. `computeShipping` returns `estimate {minDays, maxDays}` and `zoneCod`; the snapshot keeps them; confirmation and account order pages show "Expected by …".
6. `scripts/build-pincodes.js` (CSV → JSON, title-cased names, current states such as Ladakh and Telangana); attribution in `docs/DECISIONS.md` and the JSON header. The real dataset is an owner step (decision 8).

**Files:** new `lib/pincode/index.js`, `lib/pincode/offline.js`, `scripts/build-pincodes.js`, `scripts/fixtures/pincodes-sample.json` (hand-written, tests only), `app/api/pincode/route.js` (`runtime nodejs`, 30 per minute per IP), `lib/delivery-estimate.js` (pure, Edge-safe), `components/checkout/PincodeField.js`, `components/checkout/DeliveryEstimate.js`, `components/pdp/DeliveryCheck.js`; changed `lib/shipping.js`, `components/checkout/AddressStep.js`, `components/ProductPurchase.js` (mount only), the shipping settings form, `lib/admin/settings.js` (`shippingExample`), the confirmation and account order pages; `scripts/test-pincode.js` + `test:pincode`; `scripts/drills/checkout/stage-pincode.mjs`; `docs/UI.md` ("Pincode and delivery").

| Action | anonymous | signed-in shopper | support | staff | admin |
|---|---|---|---|---|---|
| `/api/pincode` | 200, this store's public rates only | 200 | n/a | n/a | n/a |
| shipping settings | n/a | n/a | NoAccess | NoAccess | read + write (`settings.*`) |

**Tests:** fixture pins give the right state; unknown and bad pins; with no dataset file every pin is "not found"; store B's zones never shape A's answer; brute force over every zone/default configuration × pins × times around IST midnight equals the configured rule, no settings → `estimate: null`; the import walk from the storefront layout and checkout page never reaches `data/` or `node:*`; the 31st request in a minute → 429; an existing store's shipping JSON unchanged.

**Drill `checkout/stage-pincode`** (with the fixture dataset): 560001 fills city and state, the estimate shows; a typed city survives a PIN change; an unknown PIN still places the order; the PDP "Check delivery" works.

## Line 2: a shopper choosing COD is offered a prepaid nudge, and COD orders can require an OTP
**Features (floor)**
1. `quote` action `{address}` → `{prepaid:{shipping, discount, total}, cod:{available, reason, fee, total, otpRequired}, nudge:{save, parts}}`, 60 per minute, debounced on PIN/address change.
2. On the COD option: "Pay online and save ₹128: no ₹49 COD fee and 5% off" with "Pay online instead"; the prepaid option shows "Save ₹128"; amounts only, no pressure words, banned-copy scan passes.
3. COD hidden with its reason ("Cash on delivery isn't available for this PIN code" / "for orders over ₹5,000") when the zone has `cod: false` or the total exceeds `maxTotal`; the route refuses the same.
4. OTP: "Place order" with `otpRequired` sends `cod_otp_send` and opens `CodOtpDialog` ("We sent a code to +91 ••••••4321"; `autocomplete="one-time-code"`; Resend after 30 s; Change number); `cod_otp_verify`; `cod` then requires a verified challenge bound to cart, key, phone and amount. Wrong, expired, locked and cap answers each have their own sentence and reveal nothing about other orders or accounts.
5. Checkout settings: prepaid discount (off / percent / fixed with optional max), COD maximum order, OTP (off / always / above ₹X) with channel SMS or email; SMS disabled with a reason when no provider is set; a worked example sentence from the same pure function.
6. Orders store `payment_discount` and `cod_verified_at`; the order view shows "Phone confirmed by code" (not PII; visible to support); the Shopify draft carries the prepaid discount.

```sql
-- migrations/tenant/0036_cod_otp_prepaid.sql (additive)
CREATE TABLE IF NOT EXISTS cod_otps (
  id TEXT PRIMARY KEY,            -- otp_<hex>
  cart_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  phone_hash TEXT NOT NULL,       -- sha256(e164|secret)
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  channel TEXT NOT NULL,          -- sms | email
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT NOT NULL,
  verified_at TEXT, order_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cod_otps_cart ON cod_otps(cart_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cod_otps_phone ON cod_otps(phone_hash, created_at);
ALTER TABLE orders ADD COLUMN payment_discount REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN cod_verified_at TEXT;
```

**Files:** new `migrations/tenant/0036_cod_otp_prepaid.sql`, `lib/checkout/payment-terms.js` (pure, client-safe), `lib/checkout/cod-otp.js`, `lib/messaging/sms.js` (`sendSms`, `smsAvailable`, `stub`), `components/checkout/{PrepaidNudge,CodOtpDialog,placeOrder,useQuote}.js`; changed `app/api/checkout/route.js`, `lib/checkout-price.js`, `lib/orders.js`, `lib/shopify-push.js`, `scripts/test-shopify-boundary.js` (the description text), `components/checkout/{CheckoutFlow,PaymentStep,OrderSummary}.js`, `components/admin/settings/CheckoutForm.js`, `lib/admin/settings.js` (payment patch), `components/admin/orders/OrderTimeline.js`, `lib/types/tenant.ts`; `scripts/test-cod-checkout.js` + `test:cod-checkout`; `scripts/drills/checkout/stage-cod.mjs`; `docs/UI.md` ("COD and prepaid").

| Action | anonymous | signed-in shopper | support | staff | admin |
|---|---|---|---|---|---|
| quote / OTP / place | 200, own cart cookie only; another cart's challenge → 409 | same | n/a | n/a | n/a |
| payment settings | n/a | n/a | NoAccess | NoAccess | read + write |
| order "phone confirmed" | n/a | n/a | visible | visible | visible |

**Tests (`test-cod-checkout`):** brute force over 1,000 random carts (real seeded variants, whole quantities, live offers) × random payment and shipping configurations: the quote's `nudge.save` equals the COD total the route charges minus the Razorpay amount it mints (stubbed `fetch`, `amount` read from the body); following the nudge charges exactly the quoted prepaid total; COD hidden in the quote ⇔ the route refuses COD. Body fields `prepaidDiscount`, `nudge`, `payment_discount` ignored; tampered `expectedTotal` → 409. OTP: no plaintext in `cod_otps`; 5 min expiry; 6th attempt locked; cooldown and caps hold; a challenge from cart A with cart B's cookie, a changed phone, or a cart changed after sending needs a new code; no replay; timing-safe compare; identical responses whatever the phone; the stub refuses with `NODE_ENV=production`; a dedup retry never needs a second OTP; every matrix row.

**Drill `checkout/stage-cod`:** the nudge shows and "Pay online instead" moves the total to the quoted amount; COD with OTP "always": read the stub code from the notifications row, a wrong code shows its error, the right code places the order; the admin order shows "Phone confirmed".

## Line 3: a signed-in shopper can save addresses and pick one at checkout
**Features (floor)**
1. `/account` "Addresses": list (default first, then last used, created, rowid); add, edit, set default, delete with confirm ("Delete this address? Past orders keep their copy."); optional label ≤ 30 chars; at most 10; same validation as checkout; the profile form keeps only name and phone.
2. Checkout signed in: `SavedAddressPicker` (radio cards, default pre-picked, "Use a new address"); picking fills via `applyAddress`; "Save this address to my account" ticked by default for a new address, saved on Continue; identical addresses not duplicated; `last_used_at` set on order.
3. Signed out: "Have an account? Sign in to use saved addresses" → `/account?return=/checkout` (`safeReturnPath`).
4. 0037 copies each `default_address` into a default row.
5. `redactCustomer` deletes the addresses; delete is a real delete.

```sql
-- migrations/tenant/0037_customer_addresses.sql (additive + one data copy)
CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, label TEXT,
  name TEXT NOT NULL, phone TEXT NOT NULL, line1 TEXT NOT NULL, line2 TEXT,
  city TEXT NOT NULL, state TEXT NOT NULL, pincode TEXT NOT NULL, country_code TEXT NOT NULL DEFAULT 'IN',
  is_default INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id, is_default, last_used_at);
INSERT INTO customer_addresses (id, customer_id, name, phone, line1, line2, city, state, pincode, is_default, created_at, updated_at)
  SELECT 'adr_' || lower(hex(randomblob(8))), c.id, COALESCE(json_extract(c.default_address,'$.name'), c.name, ''), COALESCE(json_extract(c.default_address,'$.phone'), c.phone, ''),
    json_extract(c.default_address,'$.line1'), json_extract(c.default_address,'$.line2'), json_extract(c.default_address,'$.city'),
    json_extract(c.default_address,'$.state'), json_extract(c.default_address,'$.pincode'), 1, c.created_at, c.created_at
  FROM customers c WHERE json_valid(c.default_address) AND json_extract(c.default_address,'$.line1') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM customer_addresses a WHERE a.customer_id = c.id);
```

**Files:** new `migrations/tenant/0037_customer_addresses.sql`, `lib/addresses.js` (every query `WHERE customer_id = ? AND id = ?`), `components/account/{AddressBook,AddressForm}.js`, `components/checkout/SavedAddressPicker.js`; changed `lib/customers.js`, `lib/privacy.js`, `app/api/account/route.js` (GET `view=addresses`; POST `address_save`, `address_delete`, `address_default`, `address_used`; writes 30 per 10 min), `components/account/ProfileForm.js`, `app/(storefront)/account/page.js`, `components/checkout/AddressStep.js` (anchor only); `scripts/test-addresses.js` + `test:addresses`; `scripts/test-privacy.js` (addresses deleted); `scripts/test-shopper-reads.js` (rows); `scripts/drills/checkout/stage-addresses.mjs`; `docs/UI.md` ("Saved addresses").

| Action | anonymous | signed-in shopper | support | staff | admin |
|---|---|---|---|---|---|
| list / save / delete | 401, no data | own rows only; another shopper's id → 404 (same as missing) | no route | no route | no route |
| order PII (unchanged) | n/a | n/a | redacted | full | full |

**Tests:** shopper B's address id under A's session → 404 for read, edit, delete, default, and B's row unchanged; anonymous 401 everywhere; 11th address refused; one default at a time; delete removes the row and leaves the order snapshot; 0037 copy on a fresh database and on one seeded with a `default_address`; `redactCustomer` deletes addresses; no admin, platform or plugin route or `api-reads` response contains an address field (scan with the route tables); the form passes the banned-copy scan.

**Drill `checkout/stage-addresses`:** sign in, save two, make the second default; at checkout the default is pre-picked; pick the other; a new address with "Save" ticked appears in `/account`; delete it; signed out, the picker is absent and the sign-in link returns to checkout.

## Line 4: a founder can sell in more than one currency and country
**Features (floor)**
1. Settings → Markets (admin): base market (store country, Shopify currency) read-only; add a market: countries, currency (allowlist), rate "1 USD = ₹84.20" with its set date, rounding, the market's flat rate and free threshold in its own currency, enabled, the Razorpay international tick; a live price example from `convertPrice`; a warning for a rate older than 30 days.
2. Storefront footer "Ship to: India (₹) ▾"; choice in the `_market` cookie via `/api/market?country=&return=`; first visit takes a Vercel country suggestion only when it is an enabled market.
3. Every shopper-facing price uses `useMoney` / `storefrontMarket()`: cards, PDP, sticky bar, bundles, search and its price filter (bounds converted back to base), quiz, JSON-LD `priceCurrency`; cart and drawer priced by the presentment run; locale follows the currency; INR output unchanged.
4. Checkout: country select (base + enabled markets); postal code 6 digits for IN, 3–10 alphanumerics elsewhere; a different market for the address country → 409 in the new currency; "You'll be charged in USD" by the total and Pay button; COD absent outside the base market; Razorpay minted in the market currency.
5. Orders store presentment money plus `base_*` and the rate; Shopify gets base amounts and custom attributes `charged_currency`, `charged_total`; dashboard and reports sum `COALESCE(base_total, total)`.
6. Emails, confirmation and account order pages show the charged currency.

```sql
-- migrations/tenant/0039_order_markets.sql (additive)
ALTER TABLE orders ADD COLUMN market TEXT;            -- country code of the market, NULL = base
ALTER TABLE orders ADD COLUMN base_currency TEXT;
ALTER TABLE orders ADD COLUMN fx_rate REAL;
ALTER TABLE orders ADD COLUMN base_subtotal REAL;
ALTER TABLE orders ADD COLUMN base_discount_total REAL;
ALTER TABLE orders ADD COLUMN base_shipping_total REAL;
ALTER TABLE orders ADD COLUMN base_total REAL;
```

**Files:** new `migrations/tenant/0039_order_markets.sql`, `lib/markets.js` (pure, Edge-safe: `validateMarkets`, `marketForCountry`, `convertPrice`, `convertOffer`, `marketShipping`), `lib/market-request.js` (`storefrontMarket()`), `app/api/market/route.js`, `components/{MarketContext,MarketPicker}.js`, `app/(console)/admin/(authed)/settings/markets/page.js`, `components/admin/settings/MarketsForm.js`; changed `lib/money.js` (`RAZORPAY_CURRENCIES`), `lib/format.js`, `lib/checkout-price.js` (regex), `lib/cart.js`, `app/api/cart/route.js`, `app/api/checkout/route.js`, `lib/orders.js`, `lib/payment-settle.js`, `lib/razorpay.js`, `lib/shopify-push.js`, `scripts/test-shopify-boundary.js`, `lib/reporting.js`, `lib/admin/dashboard.js`, `lib/admin/settings.js`, `app/(console)/admin/(authed)/settings/layout.js`, `app/(storefront)/layout.js`, `components/{Footer,ProductCard,ProductPurchase,SearchBox,QuizRunner}.js`, `components/pdp/StickyBuyBar.js`, `components/sections/BundleCardSection.js`, `app/(storefront)/bundles/[slug]/page.js`, `app/(storefront)/products/[handle]/page.js` (JSON-LD), `components/search/PriceRange.js`, `lib/catalog/facets.js`, `components/checkout/{checkoutModel,AddressStep,OrderSummary,PaymentStep}.js`; `scripts/test-markets.js` + `test:markets`; `scripts/drills/checkout/stage-markets.mjs`; `docs/UI.md` ("Markets").

| Action | anonymous | signed-in shopper | support | staff | admin |
|---|---|---|---|---|---|
| `/api/market`, priced pages | 200; enabled markets only; unknown country → base | 200 | n/a | n/a | n/a |
| Markets settings | n/a | n/a | NoAccess | NoAccess | 200 + audit |
| order money in the console | n/a | n/a | visible, currency labelled | visible | visible |

**Tests (`test-markets`):** brute force 1,000 random carts × USD (2 decimals), JPY (0), AED × every rounding rule: PDP unit price × qty = cart line; drawer total = the route's charged total = the Razorpay `amount` in minor units of the right currency (stub); every nudge, completed in whole units with real products, makes the presentment engine apply it; the base run = the stubbed Shopify draft total; no float drift (`toMinor` integers). Cookie market ≠ address country → 409 with the new currency; COD outside base refused; non-allowlisted currency or missing Razorpay tick refused at save; INR HTML and `formatMoney` byte-identical to before; a disabled market never served; store B's markets never on A; reports sum base amounts; `PRICE_CHANGED_MESSAGE` matches every allowlisted format.

**Drill `checkout/stage-markets`:** admin adds a US market; the shopper picks "United States ($)"; card, PDP and drawer show $; checkout says "charged in USD"; switching the country to India gives the ₹ total and COD; support and staff get NoAccess on Markets.

## Line 5: a founder can schedule a bundle and an offer for a collection
**Features (floor)**
1. Offer editor: "Products in a collection" target with a collection picker (title, product count) from `/api/admin/offers/targets`; plain words "Buy 2+ from Summer Edit, get 10% off"; works for BXGY and TIERED_QTY; the simulator's example carts come from that collection.
2. The cart engine matches `item.collections`; cart rows carry collection handles from `collection_products`; collection-offer nudges work through `offerProgress`.
3. Bundle editor reuses `ScheduleField` (local → UTC via `lib/admin/schedule.js`), start before end; the bundle list shows a status chip (draft / scheduled / active / expired from `offerScheduleStatus`); the window is mirrored to the bundle's offer row.
4. Storefront: a bundle outside its window shows the not-found words and its card is hidden; a collection page shows "Buy 2+, get 10% off" (offer title only) while a collection offer is active; cart and checkout apply offers only inside the window; expiry mid-checkout gives the existing 409.

```sql
-- migrations/tenant/0038_bundle_schedule.sql (additive)
ALTER TABLE bundles ADD COLUMN starts_at TEXT;
ALTER TABLE bundles ADD COLUMN ends_at TEXT;
```

**Files:** new `migrations/tenant/0038_bundle_schedule.sql`, `components/CollectionOfferNote.js`; changed `lib/offers/{validate,match,catalog,plain}.js`, `lib/catalog/effective.js` (`cartRows` collections), `lib/cart.js` (collections only), `lib/bundles.js`, `lib/commerce/bundle-read.js` (`hasColumns`), `app/api/admin/bundles/route.js`, `app/api/admin/offers/targets/route.js`, `components/admin/offerFormModel.js`, `components/admin/offers/OfferEditor.js`, `components/admin/bundles/BundleForm.js`, `app/(console)/admin/(authed)/bundles/page.js`, `app/(storefront)/bundles/[slug]/page.js`, `app/(storefront)/collections/[handle]/page.js`; `scripts/test-offer-schedule.js` + `test:offer-schedule`; `scripts/drills/offers/stage-schedule.mjs`; `docs/UI.md`.

| Action | anonymous | signed-in shopper | support | staff | admin |
|---|---|---|---|---|---|
| schedule offer or bundle | n/a | n/a | 403, chips without controls | 200 (`offers.write`) | 200 |
| storefront | live-at-now only; never another store's | same | n/a | n/a | n/a |

**Tests:** brute force 500 random carts mixing in- and out-of-collection lines: only in-collection lines discounted, and completing each nudge with real collection products makes the engine apply it; boundaries (start − 1 ms off, start on, end − 1 ms on, end off); bundle window = its offer row's window, a hand-edited mismatch shows `offer_differs`; anonymous bundle page and card before, during and after; checkout across an expiry → 409; support write 403; store B's collection handle never matches on A.

**Drill `offers/stage-schedule`:** staff schedule a bundle for +2 minutes; anonymous doesn't see it, then sees it; owner adds a collection offer; the collection page shows the note and the cart applies it.

---
## Events and side effects
| What | Where | Who reads it |
|---|---|---|
| audit `settings.write` with keys `payment_config`, `markets` (rate changes listed); `offers.write` with `{starts_at, ends_at, target: collection}` | `audit_log` | Audit, operators |
| slog `pincode_lookup {found}` (no pin with identity), `cod_otp_sent {channel}`, `cod_otp_failed {reason}`, `cod_otp_verified`, `market_mismatch`, `address_saved` (no PII) | logs | operators |
| `notifications` rows of type `cod_otp` (email, or the SMS stub outside production) | tenant DB | Notifications, drills |
| order `cod_verified_at`, `payment_discount`, `base_*` | orders | console, Shopify push, reports |

## Checks the builder runs first
- All: `ls migrations/tenant | tail -3 && ls migrations/platform | tail -2`; `node scripts/test-schema-compat.js`; `node scripts/test-orders.js && node scripts/test-shipping.js && node scripts/test-offers.js && node scripts/test-customers.js && node scripts/test-shopper-reads.js && node scripts/test-privacy.js` (drop missing); `grep -n "DRILLS" scripts/drills/run-isolated.mjs`.
- Step 0: `pnpm drill:p5` once, to see which drill covers today's checkout.
- Line 1: `grep -n "import" "app/(console)/admin/(authed)/settings/shipping/page.js"`; `grep -n "collection_products" lib/sync.js | head`. **No network access** for the dataset (decision 8).
- Line 2: `grep -n "secret()" lib/customers.js`; `grep -rn "discount_total" lib/shopify-push.js lib/reporting.js | head`.
- Line 4: `grep -n "currency\|amount" lib/payment-settle.js | head -20`; `grep -rn "PRICE_CHANGED_MESSAGE" lib components scripts`; `grep -n "total" lib/reporting.js lib/admin/dashboard.js | head`; `node -e "for (const c of ['USD','AED','JPY']) console.log(new Intl.NumberFormat('en-IN',{style:'currency',currency:c}).format(1234.5))"`.
- Line 5: `grep -n "offer_scheduled" lib/commerce/*.js components/sections/BundleCardSection.js`.

## Risks
1. Line 4 touches every money path (Razorpay verify and webhook amount compare, Shopify reconciliation on base totals, reports); its brute-force test and the reviewer's escape list (x.99 rounding, zero-decimal currencies, 409 on a currency switch, a stale rate) are mandatory; it merges last.
2. Pincode dataset: an owner download; districts are not always the city; some pins span two districts (most common district; the field stays editable).
3. The real SMS provider isn't chosen (India needs DLT template registration). Until the owner picks one (MSG91, Gupshup, Twilio), COD OTP really works only by email; SMS is refused in production.
4. Checkout refactor conflicts across lines 1–3: step 0 must be behaviour-identical (baseline drill + `pnpm test`); the `AddressStep` anchor and `applyAddress` are the only shared points.
5. Staff can schedule offers and bundles under `offers.write` (status quo, recorded for the owner).

## Owner-only checks (into `docs/cms-reviews/MANUAL-CHECKS.md`)
1. Download the India Post pincode CSV from data.gov.in, run `node scripts/build-pincodes.js <csv>`, commit `data/in-pincodes.json`; spot-check 20 known pins; confirm the GODL attribution wording.
2. Choose an SMS provider and template; send a real COD OTP to a real phone.
3. A Razorpay test-mode USD payment with international payments enabled; settlement and refund in the dashboard.
4. A USD order pushed to Shopify: base-currency draft and `charged_*` attributes look right.
5. A COD email OTP delivered by the real mail provider.
6. The Vercel country suggestion on a deployed preview.

## Builders
Opus: step 0, lines 2 (money, OTP), 3 (PII), 4 (money), 5 (server and engine), and line 1's route and estimate. Sonnet: `scripts/build-pincodes.js`, `docs/UI.md` sections, `MANUAL-CHECKS.md` entries, drill fixtures.
