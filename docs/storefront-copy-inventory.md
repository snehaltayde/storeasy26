# Storefront copy inventory (GEN-03)

Every piece of fixed text a shopper can receive, swept at baseline `939d630`, and what was decided for it.

**Swept:** `app/(storefront)`, `components` (not `admin`, `console`, `platform`, `partners`, `site`), `lib` and shopper-facing `app/api` routes, plus the manifest route, the service worker, shopper emails and the app icon.

**Decisions:**

- **Neutralized:** the code default now fits any store.
- **Editable:** a founder can already change it through an existing setting. No new CMS field was added.
- **Kept:** left as it is, with the reason.

`pnpm test:copy` guards this list. Changing a decision here should go with a change to `BANNED` or `ALLOWED` in `scripts/test-copy.js`.

BeastLife's stored content (its hero, tagline, footer tagline, logo and legal name, set by `scripts/seed-cms-beastlife.js` and `scripts/seed-tenant-beastlife.js`) is untouched. Only code defaults changed.

---

## 1. Neutralized

Line numbers are from `939d630`.

### Wrong brand or gym voice

| Was | Location | Now |
|---|---|---|
| "Something dropped the weights" | `app/(storefront)/error.js:22` | "Something went wrong" |
| "Add some gains and they'll show up here." | `components/cart/CartDrawer.js:158` | "Add something you like and it'll show up here." |
| "Browse the full catalog at ludicrous speed — fresh drops, live offers and fast checkout." (default hero; it also promised offers a store may not have) | `lib/cms/defaults.js:13` | "Browse the full catalog and check out in a few easy steps." Also editable (section 2). |
| "Fresh drops" (default title of the newest-products section) | `lib/cms/defaults.js:23`, `lib/cms/registry.js:58`, `components/admin/cms/HomeEditor.js:38` | "New arrivals". Also editable (section 2). |

### Developer or platform text

| Was | Location | Now |
|---|---|---|
| "Catalog not synced yet" / "Connect the store's Shopify account, then pull the catalog:" / `pnpm migrate` `pnpm sync` / "Home, collections, product pages and search all light up automatically once products land." | `app/(storefront)/page.js:97-114` | `components/EmptyCatalog.js`: "New products are on the way" / "We're getting things ready. Please check back soon." |
| "Storefront ready" (badge on an empty home) | `app/(storefront)/page.js:61` | "Coming soon" |
| "No collections yet — run `pnpm sync`." | `app/(storefront)/collections/page.js:35` | "No collections to show yet — please check back soon." |
| "© {name} · Catalog synced from the live Shopify store" (both footer variants) | `components/Footer.js:64`, `:147` | "© {name}" |
| "Browse the {name} catalog — a fast storefront over the live Shopify store." (default tagline: meta description, manifest, footer) | `lib/site.js:36` | "Shop {name} online." Also editable (section 2). |
| "500" (large numeral on the error page) | `app/(storefront)/error.js:21` | Removed. The "Ref:" line stays (section 3). |
| "(test mode)" beside the card option, shown on live stores too | `components/checkout/CheckoutFlow.js:375` | Removed |
| "Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable." | `components/checkout/CheckoutFlow.js:378` | "Online payment isn't available for this store right now." |
| "Razorpay · card / UPI / netbanking" | `components/checkout/CheckoutFlow.js:375` | "Pay online · card / UPI / netbanking" |
| "Secure payment via Razorpay." | `components/checkout/CheckoutFlow.js:378` | "You'll finish paying in a secure payment window." |
| "Could not load Razorpay" | `components/checkout/CheckoutFlow.js:192` | "Could not open the payment window — check your connection and try again." |
| "Could not continue (HTTP {status}) — your cart is untouched, please retry." | `components/checkout/CheckoutFlow.js:117` | "Could not continue — your cart is untouched, please retry." |
| "Razorpay" (payment line on the confirmation page) | `app/(storefront)/checkout/confirmation/[orderId]/page.js:125` | "Online payment" |
| "No store is configured for this address." | `app/(storefront)/not-found.js:36` | "There is no store at this address." |
| "Couldn't check this order ({status})." | `components/account/ReorderPanel.js:25` | "Couldn't check this order — please try again." |

### Raw errors reaching shoppers

| Was | Location | Now |
|---|---|---|
| Any `/api/checkout` error shown as written, including the route's catch-all: raw provider text ("Razorpay order create failed (…)") and database errors | `components/checkout/CheckoutFlow.js:117` | Only four known messages pass, by allow-list. Anything else shows the plain "Could not continue…" line. |
| Server verify errors ("Payment signature verification failed", "Order mismatch") | `components/checkout/CheckoutFlow.js:217` | "We couldn't confirm your payment for order {id}. If money left your account, please don't pay again — contact the store with this order number." |
| Browser wording from a failed fetch or a non-JSON reply ("Failed to fetch", "Unexpected token…") | `components/checkout/CheckoutFlow.js:229` | "Could not reach the store — your cart is untouched. Check your connection and try again." |
| "Razorpay is not configured" | `app/api/checkout/route.js:197` | "Online payment isn't available for this store right now." |
| "Checkout is briefly paused by the platform — …" | `app/api/checkout/route.js:116` | "Checkout is briefly paused — …" |
| Any thrown message on `/api/account`, including database errors, shown by the sign-in, returns, profile and wishlist forms | `app/api/account/route.js:107` | `lib/shopper-errors.js`: messages written for shoppers still show. Database and network errors become "Something went wrong — please try again." |
| Raw database error text in the public search JSON (no screen showed it) | `app/api/search/route.js:32` | Field removed |
| `— automated rule "{rule name}"` at the foot of automation emails sent to shoppers | `lib/automations.js:235` | Shopper emails end with "Order {id}". The note stays on emails to the store. |

### Promises the store never made

| Was | Location | Now |
|---|---|---|
| "COD fee (if any) added at checkout · prices incl. GST" (a tax claim from code) | `components/cart/CartDrawer.js:366` | "Any cash on delivery fee is added at checkout" |
| "Refunds reach the original payment method in 5–7 business days." | `app/(storefront)/orders/[orderId]/page.js:150` | "Refunds go back to the original payment method. Your bank may take a few days to show it." |
| "We review requests within a working day." | `components/account/ReturnRequest.js:83` | "The store reviews each request and will reply here." |
| "…and each piece stays returnable on its own." (a returns policy from code) | `app/(storefront)/bundles/[slug]/page.js:70-71` | Clause removed |

---

## 2. Editable through an existing setting

| Text | Where the founder changes it | Default now |
|---|---|---|
| Store name, logo text, title | Settings → store identity (`config.site`) | Store's registry name; "{name} — Shop online" |
| Tagline, footer tagline | Settings → store identity | "Shop {name} online." |
| Legal name in the footer | Settings → store identity | Store name |
| Support email and phone | Settings → store identity | Hidden when empty |
| Hero title, subtitle, badge, buttons | Home editor | "Shop {name}." and the neutral subtitle; "Shop all collections", "See what's new" |
| Section titles and limits | Home editor | "Shop by collection", "New arrivals", "Featured products" |
| Announcement bar | CMS announcement | Off |
| Header and footer links | CMS navigation | Derived from the catalog; "All collections", "About us", "Contact" |
| "Pairs well with", "You might also like" | Placements, title field | Those two strings |
| About, contact and policy pages | Content pages | None for a new store. BeastLife has its own (section 3). |
| Maintenance message | Maintenance setting | "We're doing some quick work behind the scenes. Nothing is lost — your cart will be waiting." |
| Shipping rates, and with them the free-shipping nudge | Settings → Shipping rules | See section 4 |

---

## 3. Kept, with a reason

### Wrong-brand text that stays in code

| Text | Location | Why it stays | Guard |
|---|---|---|---|
| `"BeastLife"` fallback store name | `lib/site.js:23` | Reached only with no tenant context. That legacy env store is BeastLife, and every tenant has a registry name first (S51). | `test:copy`, `ALLOWED` |
| BeastLife's about, contact and policy copy, with its ₹999 / ₹79 / ₹49 figures | `lib/content/pages.js` | BeastLife's own content. `brandDefaultsApply()` serves it only to BeastLife. | `test:copy`, `test:storefront` |
| BeastLife offers and coupons (BEAST10 and others) | `lib/offers/config.js` | Seeded only by BeastLife's bootstrap. Both real `evaluateOffers` callers pass offers from the database. | `test:platform-sync` |
| `"beastlife"` tenant ids | `lib/cms/store.js:231` | The check that keeps BeastLife's pages on BeastLife | `ALLOWED` |
| Pulse kit preset: "Fuel the work." / "Proteins, pre-workouts and daily essentials…" | `lib/themes/kits.js:42` | Written as a draft only if a founder applies that nutrition kit and accepts its copy. **For ED:** show the preset text before applying. | `ALLOWED` |
| Sim Whey and other simulator products | `lib/offers/simulate.js` | Console offer simulator, never shown to shoppers | `ALLOWED` |

### Honest, and useful to shoppers

| Text | Location | Why it stays |
|---|---|---|
| "Ref: {digest}" | `app/(storefront)/error.js` | A code the shopper can quote to support. It reveals nothing else. |
| "Paid · {payment id}" | Checkout confirmation | The shopper's payment reference for a bank dispute |
| "Free shipping (₹999+)", "Standard shipping + COD fee ₹49" | `lib/shipping.js` labels, shown on the confirmation | True of that order. The label is also what is pushed to Shopify, and `test:shipping` pins it. |
| "Analytics (Google Analytics)", "Marketing (Meta ads)" | `components/analytics/ConsentBanner.js` | Consent needs the real vendor named |
| "{store} is temporarily unavailable", "Store not found" | `app/(storefront)/not-found.js`, `lib/tenant-gate.js` | Neutral by design (S25), no tenant data |
| "Checkout is temporarily unavailable" and its explanation | `app/(storefront)/checkout/page.js` | Plain and true |
| "Scheduled maintenance", "{name} will be right back.", "Store team sign-in" | `app/(storefront)/layout.js` | Plain and neutral. This block is also being changed on another branch. |
| "Draft preview — this is NOT what shoppers see." | `app/(storefront)/layout.js` | Only a founder previewing sees it |
| Country "India", ₹, "PIN code", "Cash on Delivery", "UPI" | Checkout and account | The product serves Indian stores today. Not a brand leak. |

### Plain commerce words that fit any store

| Surface | Strings | Location |
|---|---|---|
| 404 | "This page isn't on {name}'s shelves", "The page you're looking for doesn't exist or may have moved.", "Back to home", "Browse collections", "Search products" | `app/(storefront)/not-found.js` |
| Error | "A temporary error stopped this page from loading. It's usually gone on retry.", "Try again", "Back to home" | `app/(storefront)/error.js` |
| Offline | "You're offline", "Check your connection — your cart is safe and waiting.", "Try again" | `app/(storefront)/offline/route.js` |
| Header | "Shop all", plus search, wishlist and account labels | `components/Header.js` |
| Footer | "Shop", "Company", "Support" | `components/Footer.js` |
| Search | "Search products…", "Recent searches", "Clear", "Searching…", "No products match "{q}".", "Type at least 2 characters to search.", "Browse all collections →" | `components/SearchBox.js`, `app/(storefront)/search/page.js` |
| Collections | "Collections", "Featured", "In stock", "Clear all", "Clear all filters", "Filter", "Nothing matches these filters.", "No products in this collection yet.", "← Previous", "Next →" | `app/(storefront)/collections` |
| Sort | "Sort", "Featured", "Newest", "Price: low to high", "Price: high to low" | `components/CollectionControls.js` |
| Product | "● In stock", "● Sold out", "Add to cart", "Select options", "Added ✓ — View cart", "Details", "No image", "from", "This combination isn't available — struck-through values don't exist together. Pick a different option." | `components/ProductPurchase.js`, `components/pdp/PdpLayouts.js`, `components/ProductCard.js` |
| Bundles | "{n}-piece set", "Save {amount}", "SOLD OUT", "NO LONGER AVAILABLE", "Unavailable item", "Add the set to cart", "A component is out of stock — the set comes back when it does." | `app/(storefront)/bundles/[slug]/page.js`, `components/BundleAddButton.js` |
| Cart | "Your cart is empty", "Coupon code", "Apply", "Remove", "Subtotal", "Shipping", "FREE", "Total", "You save {amount}", "Checkout →", "Free gift 🎁", "Add", price-change and out-of-stock notices | `components/cart/CartDrawer.js` |
| Coupons | "Not a valid code", "Minimum spend ₹{n} for this code", "Coupon {code} · exclusive" | `lib/offers/engine.js` |
| Checkout | "Address", "Review", "Payment", field labels, "Continue to payment", "Place order · {amount}", "Pay {amount}", "Processing…", "Order summary", "By placing this order you agree to our…", "Pay in cash when your order arrives." | `components/checkout/CheckoutFlow.js`, `app/(storefront)/checkout/page.js` |
| Checkout errors | "Please fill all required fields", "This checkout attempt no longer matches your cart. Please retry.", "Your cart session expired…", "Checkout is temporarily unavailable for this store…" | `app/api/checkout/route.js`, `components/checkout/CheckoutFlow.js` |
| Confirmation | "Order confirmed", "Thanks {name}!", "Payment received.", "You'll pay cash on delivery.", "Continue shopping", "Shipping to" | `app/(storefront)/checkout/confirmation/[orderId]/page.js` |
| Order status | "Order placed", "Payment confirmed", "Being prepared", "Shipped", "CANCELLED", "Preparing shipment", "carrier status updated {when}", "Fully refunded", "Partially refunded", "Questions?" | `app/(storefront)/orders/[orderId]/page.js` |
| Account | "Sign in", "Email me a code", "No passwords — we email you a 6-digit code…", "Your account", "Hi, {name}", "Orders", "Start shopping", "Profile", "Sign out", "Save profile", "payment pending", "placed (COD)", "processing" | `app/(storefront)/account`, `components/account` |
| Sign-in errors | "That email doesn't look right.", "That code isn't right…", "That code expired…", "Too many codes requested…", "sign in first" | `lib/customers.js`, `app/api/account/route.js` |
| Returns | "Request a return", "What went wrong?", "Submit request", "the {n}-day return window has passed", "A return is already open for this order." | `components/account/ReturnRequest.js`, `lib/returns.js` |
| Reorder | "Reorder these items", "Checking today's prices and stock…", "Added ✓ — the cart shows today's prices.", "currently sold out", "no longer in the catalog" | `components/account/ReorderPanel.js`, `lib/customers.js` |
| Wishlist | "Wishlist", "Nothing saved yet — tap Save for later on any product…", "Merge into my account", "sold out right now", "no longer in the catalog" | `components/WishlistPage.js` |
| Contact | "Contact {name}", "Questions about an order or a product? Drop us a line.", "Send us a message", "Message received ✓", "Couldn't reach the server — check your connection and try again." | `app/(storefront)/contact/page.js`, `components/ContactForm.js` |
| Content pages | "Operated by {legal name} ·", "Questions?", "Contact us" | `components/ContentPage.js` |
| Journal | "Journal", "Nothing published yet — check back soon." | `app/(storefront)/journal/page.js` |
| Quiz | "Your picks", "Matched on: …", "Want these picks in your inbox? (optional)", "One email with these picks — that's the whole deal. No list, no follow-ups." | `components/QuizRunner.js`, `app/api/quiz/[slug]/route.js` |
| Consent | "We use analytics and advertising cookies…", "Allow all", "No thanks", "Settings", "Save choices", "Privacy" | `components/analytics/ConsentBanner.js` |
| Emails | "Your sign-in code is {code}. It expires in 10 minutes.…", "A note from the store", "Your picks from the {quiz}" | `lib/customers.js`, `lib/automations.js`, `app/api/quiz/[slug]/route.js` |
| Rate limit and gates | "Too many requests", "Store not found", "This store is temporarily unavailable", "Service temporarily unavailable" | `lib/rate-limit.js`, `lib/tenant-gate.js` |

### Not shopper-visible, so not in the scan

| Text | Location | Why |
|---|---|---|
| Storeasy, Shopify, Razorpay, Vercel, Turso and nutrition copy on marketing pages | `app/(storefront)/{customers,integrations,legal,pricing,templates,trust,verticals}`, `components/site` | Each route returns 404 on a store's address. `test:copy` asserts every host gate. |
| "Storeasy — fast, branded storefronts…" | `app/(storefront)/layout.js:44`, `:170` | The platform-host branch only |
| "Shopify-hosted checkout is not implemented yet…", and the billing-pause reason | `lib/commerce/adapter.js` | API and console detail. Shoppers get the checkout page's fixed text, or `friendlyCheckoutError`'s, for this code. `test:commerce` asserts the wording. |
| "storeasy26 order {id} — paid via Razorpay …" | `lib/shopify-push.js:105` | A note staff read in Shopify admin |
| `pnpm` hints, `.env.local` errors | `lib/integrations.js`, `lib/env-file.js`, `lib/shopify.js`, `lib/platform/*` | Operator console and CLI paths |
| FAQ, returns and legal starting text ("7 days", "3–5 working days", "5–7 working days") | `lib/content/templates.js` | A console prefill. It reaches shoppers only after a founder edits and saves it. **GEN-06** binds it to real settings. |

---

## 4. Default shipping values

**The defaults:** ₹79 flat, free at ₹999, ₹49 cash on delivery fee (`SHIPPING_CONFIG`, `lib/shipping.js:14`). A store with no `shipping_config` is charged these by the server.

**How they reached shoppers:**

| Path | What happened | Decision |
|---|---|---|
| Checkout preview. `CheckoutFlow` called `computeShipping` with no config. | **Bug: every store saw the code default, even a store with its own rates.** The summary, "Pay ₹…" button and COD fee could differ from the amount the server charged. | Fixed. The page now passes the store's own config, the same value the server uses. |
| Cart drawer, "Add ₹X more for free shipping" (`lib/cart.js`) | A promise in the store's name about a threshold the founder never chose | Shown only when the store chose its rates. BeastLife keeps it, since its shipping policy publishes those figures. |
| Cart drawer and checkout, the shipping amount | The real charge, so hiding it would be dishonest | Kept. "Shipping" makes no claim about who set it. |
| Order confirmation label ("Standard shipping") | True of that order | Kept |
| `emptyCart()`: `computeShipping` with no config | Never displayed: the drawer's totals need items | Kept, no shopper path |
| Console. The Settings form showed defaults as if saved, and **every save wrote them to `shipping_config`**, so saving a support email silently adopted them. | The founder couldn't tell | The form says "You haven't set your own shipping rates yet", sends starter rates only if they changed, and offers "Keep these rates". |

**What did not change:** what any shopper is charged. `lib/shipping.js` is untouched and `test:shipping` is unmodified. The server was already using the store's rates, and it remains the only source of the charged amount.

**Known limit:** a store that saved Settings before this change already has `shipping_config` holding the defaults, and the code can't tell those from chosen rates. Such a store counts as having chosen them and keeps the nudge.

---

## 5. For later work

No new CMS field was added. These should become editable or get a better answer later.

| Item | Why | Suggested owner |
|---|---|---|
| Empty-store message and "Coming soon" badge | A founder may want their own words. Today they are fixed. | ED, or GEN-01 |
| Telling the founder why the store looks empty | The shopper page no longer explains it, so the console has to. US-04 needs this. | GEN-01, GEN-02 |
| Error, 404 and offline wording; "Your cart is empty" | Could carry a store's voice. BeastLife loses its gym line on the error page and in the cart. | ED |
| Refund timing and return review time | Removed because no setting holds them. Should come from real settings. | GEN-06 |
| Whether prices include GST | Removed because code can't know. Should come from Shopify or a setting. | GEN-06 or a tax item |
| Pulse kit preset | Show the copy before it is applied | ED |
| "A confirmation was sent to {email}" | Shopify sends this email (S18), so it can be early or wrong if the Shopify push is delayed. Kept for now. Not a brand or developer leak. | COM or PUB-12 |
| Sender of shopper emails | Defaults to `Storeasy <onboarding@resend.dev>` unless `MAIL_FROM` is set, on every store. Needs a per-store sender. | Operations |
| Quiz email links | Relative paths (`/products/x`) in an email don't open. Not copy, so not changed here. | Follow-up bug |
| Shared bolt icon | `app/icon.svg` and `public/icons/*` are the lime bolt on every store | GEN-04 |
| Raw errors still in the `/api/checkout` JSON | No screen shows them now, but the network response still carries them. The catch-all is shared with the verify path, which another branch is changing. | Follow-up after that branch lands |
| Root layout crash | There is no `global-error.js`, so a crash in the layout itself shows Next's built-in English message | Follow-up |
