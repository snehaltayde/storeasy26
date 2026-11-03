# Storefront copy inventory (GEN-03)

The fixed text a shopper can receive, and what was decided for it. Swept at baseline `939d630`, then completed against this branch.

**Swept:** `app/(storefront)`, `components` (not `admin`, `console`, `platform`, `partners`, `site`), `lib` and shopper-facing `app/api` routes, plus the manifest route, the service worker, shopper emails and the app icon.

**How complete this is:**

- **Pages and components:** a one-off script read `app/(storefront)` and the shopper components through SWC, and looked up every JSX text node, visible attribute and text-like string in this file. At the last check, every one that a person can read has a row. The script isn't committed.
- **`lib` and `app/api`:** read by hand, so a string could be missed. Section 3 lists what was found.
- **Form:** text built at runtime is shown with `{name}` for the variable part.
- **Not listed:** a store's own content, and what Shopify or Razorpay send.
- **Staying current:** nothing keeps this up to date. New text with no row fails no test.

**Decisions:**

- **Neutralized:** the code default now fits any store.
- **Editable:** a founder can already change it through an existing setting. No new CMS field was added.
- **Kept:** left as it is, with the reason.

**What `pnpm test:copy` guards:** section 1. Putting back a row's old wording in the code fails the suite, through the source scan, a render, a test that calls the route or clicks the button, or a test that reads the value directly (the Home editor's new sections, the shopper automation email). This was checked by reverting each code change in turn (see the review packet). Wording changed from what section 1 says is not pinned unless a test names it.

**What it does not guard:**

- The ban on Razorpay, Shopify, Storeasy, Vercel, Turso and localhost in visible text covers storefront pages and components only. In `lib` and `app/api`, only the listed phrases fail.
- Console files aren't scanned, apart from the Home editor's new-section values, which a test reads.
- Sections 2 and 3 are decisions, not assertions, apart from the guards named in section 3.
- Text put together at runtime from fragments, and text a founder has stored (see "Old default words already saved" in section 5).

Changing a decision here should go with a change to `BANNED` or `ALLOWED` in `scripts/test-copy.js`.

BeastLife's stored content (its hero, tagline, footer tagline, logo and legal name, set by `scripts/seed-cms-beastlife.js` and `scripts/seed-tenant-beastlife.js`) is untouched. Only code defaults changed.

---

## 1. Neutralized

Line numbers are from `939d630`.

### Wrong brand or gym voice

| Was | Location | Now |
|---|---|---|
| "Something dropped the weights" | `app/(storefront)/error.js:22` | "Something went wrong" |
| "Add some gains and they'll show up here." | `components/cart/CartDrawer.js:158` | "Add something you like and it’ll show up here." |
| "Browse the full catalog at ludicrous speed — fresh drops, live offers and fast checkout." (default hero; it also promised offers a store may not have) | `lib/cms/defaults.js:13` | "Browse the full catalog and check out in a few easy steps." On an empty store, "Our shop is opening soon." Also editable (section 2). A store that already saved the old text keeps it (section 5). |
| "Fresh drops" (default title of the newest-products section) | `lib/cms/defaults.js:23`, `lib/cms/registry.js:58`, `components/admin/cms/HomeEditor.js:38` | "New arrivals". Also editable (section 2). A store that already saved the old text keeps it (section 5). |
| `Storeasy <onboarding@resend.dev>`, or one `MAIL_FROM` name, as the sender of every store's emails (sign-in codes, automations, quiz picks) | `lib/mail.js:8`, `lib/notifications.js:81` | `{store name} <the MAIL_FROM address>`. Invitations and password resets stay the platform's. |

### Developer or platform text

| Was | Location | Now |
|---|---|---|
| "Catalog not synced yet" / "Connect the store's Shopify account, then pull the catalog:" / `pnpm migrate` `pnpm sync` / "Home, collections, product pages and search all light up automatically once products land." | `app/(storefront)/page.js:97-114` | `components/EmptyCatalog.js`: "New products are on the way" / "We’re getting things ready. Please check back soon." |
| "Storefront ready" (badge on an empty home) | `app/(storefront)/page.js:61` | "Coming soon" |
| "See what's new" on an empty home, pointing at `#new`, which only exists once there are products | `app/(storefront)/page.js:77` | Hidden while the store is empty, on any hero that points at `#new` |
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
| Any `/api/checkout` error shown as written, including the route's catch-all: raw provider text ("Razorpay order create failed (…)") and database errors | `components/checkout/CheckoutFlow.js:117` | Only four known messages pass, by allow-list (`lib/shopper-errors.js`). Anything else shows the plain "Could not continue…" line. |
| Server verify errors ("Payment signature verification failed", "Order mismatch") | `components/checkout/CheckoutFlow.js:217` | "We couldn't confirm your payment for order {id}. If money left your account, please don't pay again — contact the store with this order number." |
| Browser wording from a failed fetch or a non-JSON reply ("Failed to fetch", "Unexpected token…") | `components/checkout/CheckoutFlow.js:229` | "Could not reach the store — your cart is untouched. Check your connection and try again." |
| "Razorpay is not configured" | `app/api/checkout/route.js:197` | "Online payment isn't available for this store right now." |
| "Checkout is briefly paused by the platform — …" | `app/api/checkout/route.js:116` | "Checkout is briefly paused — …" |
| Any thrown message on `/api/account`, including database errors, shown by the sign-in, returns, profile and wishlist forms | `app/api/account/route.js:107` | `lib/shopper-errors.js`: messages written for shoppers still show. Database and network errors become "Something went wrong — please try again." |
| Raw database error text in the public search JSON (no screen showed it) | `app/api/search/route.js:32` | Field removed |
| Any thrown message in the public cart JSON, such as "variant not in catalog: {id}" (no screen showed it) | `app/api/cart/route.js:71` | Field removed. The 400 status stays. |
| `— automated rule "{rule name}"` at the foot of automation emails sent to shoppers | `lib/automations.js:235` | Shopper emails end with "Order {id}". The note stays on emails to the store. |

### Promises the store never made

| Was | Location | Now |
|---|---|---|
| "COD fee (if any) added at checkout · prices incl. GST" (a tax claim from code) | `components/cart/CartDrawer.js:366` | "Any cash on delivery fee is added at checkout" |
| "Refunds reach the original payment method in 5–7 business days." | `app/(storefront)/orders/[orderId]/page.js:150` | "Refunds go back to the original payment method. Your bank may take a few days to show it." |
| "We review requests within a working day." | `components/account/ReturnRequest.js:83` | "The store reviews each request and will reply here." |
| "…and each piece stays returnable on its own." (a returns policy from code) | `app/(storefront)/bundles/[slug]/page.js:70-71` | Clause removed |
| "Festive offer" with a "Shop now" button (new banner), "Tell your story…" (new rich text): prefilled, so a founder who published without retyping showed an offer the store never made | `components/admin/cms/HomeEditor.js:39-40` | Fields start empty, with these as placeholders only. An unedited section can't be saved (`lib/cms/validate.js:55`, `:61`). A store that already saved them keeps them (section 5). |

---

## 2. Editable through an existing setting

| Text | Where the founder changes it | Default now |
|---|---|---|
| Store name, logo text, title | Settings → store identity (`config.site`) | Store's registry name; "{name} — Shop online" |
| Tagline, footer tagline | Settings → store identity | "Shop {name} online." |
| Legal name in the footer | Settings → store identity | Store name |
| Support email and phone | Settings → store identity | Hidden when empty |
| Hero title, subtitle, badge, buttons | Home editor | "Shop {name}." and the neutral subtitle; "Shop all collections", "See what's new". The empty-store changes in section 1 apply only to the default subtitle and a `#new` button. A founder's own subtitle stays as written. |
| Section titles and limits | Home editor | "Shop by collection", "New arrivals", "Featured products" |
| Announcement bar | CMS announcement | Off |
| Header and footer links | CMS navigation | Derived from the catalog; "All collections", "About us", "Contact" |
| "Pairs well with", "You might also like" | Placements, title field | Those two strings |
| About, contact and policy pages | Content pages | None for a new store. BeastLife has its own (section 3). |
| Shipping rates, and with them the free-shipping nudge | Settings → Shipping rules | See section 4 |

---

## 3. Kept, with a reason

Line numbers in this section are from this branch.

### Wrong-brand text that stays in code

| Text | Location | Why it stays | Guard |
|---|---|---|---|
| `"BeastLife"` fallback store name | `lib/site.js:23` | Reached only with no tenant context. That legacy env store is BeastLife, and every tenant has a registry name first (S51). | `test:copy`, `ALLOWED` |
| BeastLife's about, contact and policy copy, with its ₹999 / ₹79 / ₹49 figures | `lib/content/pages.js` | BeastLife's own content. `brandDefaultsApply()` serves it only to BeastLife. | `test:copy`, `test:storefront` |
| BeastLife offers and coupons (BEAST10 and others) | `lib/offers/config.js` | Seeded only by BeastLife's bootstrap. Both real `evaluateOffers` callers pass offers from the database. | `test:platform-sync` |
| `"beastlife"` tenant ids | `lib/brand-tenants.js` | The check that keeps BeastLife's pages on BeastLife | `ALLOWED` |
| Pulse kit preset: "Fuel the work.", "Proteins, pre-workouts and daily essentials — live offers, fast checkout.", "Shop all collections", "See what’s new" | `lib/themes/kits.js:40-44` | Written as a draft only if a founder applies that nutrition kit and accepts its copy. "Live offers" and "fast checkout" are unset promises. **For ED:** show the preset text before applying. | `ALLOWED` |
| Glow kit preset: "Your glow, daily.", "Skincare and self-care rituals, picked with love — delivered fast.", "Shop the edit", "What’s new" | `lib/themes/kits.js:59-63` | The same opt-in as Pulse. "Delivered fast" is an unset promise. **For ED**, with Pulse. | None. No rule matches this wording. |
| Sim Whey and other simulator products | `lib/offers/simulate.js` | Console offer simulator, never shown to shoppers | `ALLOWED` |

### Says what will happen

These state how refunds, returns or messages work. None gives a time or an amount, and the code bears each one out. **For GEN-06:** review them with the refund wording in section 1 once real settings exist.

| Text | Location | Why it stays |
|---|---|---|
| "This order was cancelled. If a payment was captured, the refund is processed back to the original payment method — reach us at {support email} with your order id for anything unclear." | `app/(storefront)/orders/[orderId]/page.js:108-110` | The console refuses to cancel a captured payment until a refund is recorded (`lib/order-cancel.js:29`). |
| "Approved means we’re taking it back — any refund arrives separately to your original payment method once processed." | `components/account/ReturnRequest.js:34` | Approving a return moves no money (`lib/returns.js:123`). It doesn't promise a refund. |
| "The store reviews each request and will reply here. Approval authorizes the return; refunds are processed separately." | `components/account/ReturnRequest.js:83` | The same |
| "Refunds go back to the original payment method. Your bank may take a few days to show it." | `app/(storefront)/orders/[orderId]/page.js` | The replacement wording from section 1 |
| "Your cart is saved — nothing was charged. Please try again a little later." | `app/(storefront)/checkout/page.js:50` | True: this page shows only when checkout is closed. |
| "Everything is added as normal items — the set price applies automatically in your cart." | `app/(storefront)/bundles/[slug]/page.js:70` | The cart allocates the set's discount across its items (`lib/offers/engine.js`). |
| "Your past orders with this email join your account automatically once it’s verified." | `components/account/AccountAuth.js:51` | Verifying claims them (`lib/customers.js`). |
| "We’ll reply to {email}." | `components/ContactForm.js:48` | The message reaches the store's inbox. The reply is up to the store. |
| "You asked for this one email after the quiz — there's no list and no follow-ups." | `app/api/quiz/[slug]/route.js:37` | The route sends one email and stores no list. |

### Honest, and useful to shoppers

| Text | Location | Why it stays |
|---|---|---|
| "Ref: {digest}" | `app/(storefront)/error.js` | A code the shopper can quote to support. It reveals nothing else. |
| "Paid · {payment id}" | Checkout confirmation | The shopper's payment reference for a bank dispute |
| Razorpay's own failure description, shown as written after a failed payment | `components/checkout/CheckoutFlow.js`, `payment.failed` | It comes from the payment window and is written for the person paying. The fallback is "Payment failed". Not checked against the provider's full list of messages. |
| "Free shipping (₹999+)", "Standard shipping + COD fee ₹49" | `lib/shipping.js` labels, shown on the confirmation | True of that order. The label is also what is pushed to Shopify, and `test:shipping` pins it. |
| "Analytics (Google Analytics)", "Marketing (Meta ads)" | `components/analytics/ConsentBanner.js` | Consent needs the real vendor named |
| "{store} is temporarily unavailable", "Store not found" | `app/(storefront)/not-found.js`, `lib/tenant-gate.js` | Neutral by design (S25), no tenant data |
| "Checkout is temporarily unavailable" and its explanation | `app/(storefront)/checkout/page.js` | Plain and true |
| "Scheduled maintenance", "{name} will be right back.", "Store team sign-in" | `app/(storefront)/layout.js` | Plain and neutral. This block is also being changed on another branch. |
| "We're doing some quick work behind the scenes. Nothing is lost — your cart will be waiting." | `app/(storefront)/layout.js:221` | The default maintenance message. Plain and neutral. Only the platform operator can replace it (`components/platform/PlatformAdmin.js`, `app/api/platform/tenants/[id]/route.js:157`). A founder can't change it. |
| "Draft preview — this is NOT what shoppers see.", "Exit preview" | `app/(storefront)/layout.js` | Only a founder previewing sees it |
| Country "India", ₹, "PIN code", "Cash on Delivery", "UPI" | Checkout and account | The product serves Indian stores today. Not a brand leak. |

### Plain commerce words that fit any store

| Surface | Strings | Location |
|---|---|---|
| 404 | "This page isn’t on {name}’s shelves", "The page you're looking for doesn't exist or may have moved.", "Back to home", "Browse collections", "Search products", and "Page not found" as the page title | `app/(storefront)/not-found.js`, `app/(storefront)/policies/[slug]/page.js` |
| Error | "A temporary error stopped this page from loading. It's usually gone on retry.", "Try again", "Back to home" | `app/(storefront)/error.js` |
| Offline | "Offline · {name}", "You're offline", "Check your connection — your cart is safe and waiting.", "Try again" | `app/(storefront)/offline/route.js` |
| Header | "Shop all", plus search, wishlist and account labels | `components/Header.js` |
| Footer | "Shop", "Company", "Support" | `components/Footer.js` |
| Search | "Search products…", "Recent searches", "Clear", "Searching…", "No products match “{q}”.", "Type at least 2 characters to search.", "Browse all collections →", "Results for “{q}”", "View all results for “{q}”", "Search: {q}" | `components/SearchBox.js`, `app/(storefront)/search/page.js` |
| Collections | "Collections", "Featured", "In stock", "Clear all", "Clear all filters", "Filter", "Nothing matches these filters.", "No products in this collection yet.", "← Previous", "Next →", "← Back home", "{n} products · page {page} of {total}", "{title} — page {page}", "Filters", "Pagination" (screen reader) | `app/(storefront)/collections` |
| Sort | "Sort", "Featured", "Newest", "Price: low to high", "Price: high to low", "Sort products" (screen reader) | `components/CollectionControls.js` |
| Product | "● In stock", "● Sold out", "Add to cart", "Select options", "Added ✓ — View cart", "Details", "No image", "from", "Not available with the current selection", "This combination isn’t available — struck-through values don’t exist together. Pick a different option.", and for screen readers "Decrease quantity", "Increase quantity", "View image" | `components/ProductPurchase.js`, `components/pdp/PdpLayouts.js`, `components/ProductCard.js`, `components/ProductGallery.js` |
| Bundles | "{n}-piece set", "Save {amount}", "SOLD OUT", "NO LONGER AVAILABLE", "Unavailable item", "Add the set to cart", "Adding the set…", "Added ✓ — view cart", "Currently unavailable", "A component is out of stock — the set comes back when it does." | `app/(storefront)/bundles/[slug]/page.js`, `components/BundleAddButton.js` |
| Home | "{n} products · {n} collections" (the badge when no badge is set), "View all →" | `app/(storefront)/page.js`, `components/sections/HomeSections.js` |
| Cart | "Your cart is empty", "Add something before checking out.", "Continue shopping", "Coupon code", "Apply", "Remove", "Subtotal", "Shipping", "FREE", "Total", "You save {amount}", "Checkout →", "Free gift 🎁", "Add", "“{title}” just went out of stock — remove it or check back later.", "“{title}” price changed since you added it: {old} → {new} (totals use the new price).", and for screen readers "Shopping cart", "Close cart", "Decrease quantity", "Increase quantity", "Remove item", "Open cart, {n} items" | `components/cart/CartDrawer.js`, `components/cart/CartButton.js`, `app/(storefront)/checkout/page.js` |
| Coupons and offers | "Not a valid code", "Minimum spend ₹{n} for this code", "Coupon {code} · exclusive", "{offer title} · {n}% off" | `lib/offers/engine.js` |
| Checkout | "Address", "Review", "Payment", the fields "Email", "Phone", "Full name", "Address", "Apartment, suite (optional)", "City", "State", "PIN code", then "Contact & shipping address", "Continue to review", "Review your order", "Ship to", "Edit", "Back", "Qty", "Continue to payment", "Place order · {amount}", "Pay {amount}", "Processing…", "Order summary", "Free gift · {title}", "(incl. COD fee)", "By placing this order you agree to our…", "Pay in cash when your order arrives.", and the policy links "Privacy policy", "Terms", "Refund policy", "Shipping policy" | `components/checkout/CheckoutFlow.js`, `app/(storefront)/checkout/page.js` |
| Checkout errors | "Please fill all required fields", "This checkout attempt no longer matches your cart. Please retry.", "Your cart session expired — your items may still be in the cart. Go back to the cart and try again.", "Checkout is temporarily unavailable for this store — your cart is saved, nothing was charged. Please try again later.", "Checkout is temporarily unavailable", "Keep browsing" | `app/api/checkout/route.js`, `lib/shopper-errors.js`, `app/(storefront)/checkout/page.js` |
| Confirmation | "Order confirmed", "Thanks {name}!", "Thanks there!", "Payment received.", "You'll pay cash on delivery.", "Payment is pending.", "A confirmation was sent to {email}. Keep your order-status link to track it anytime.", "Due on delivery", "Pending", "Qty", "Continue shopping", "Shipping to" | `app/(storefront)/checkout/confirmation/[orderId]/page.js` |
| Order status | "Order placed", "Payment confirmed", "Being prepared", "Shipped", "CANCELLED", "Preparing shipment", "carrier status updated {when}", "{n}m ago", "{n}h ago", "{n}d ago", "Fully refunded", "Partially refunded", "Questions?", "{id} · placed {date}", "(Cash on Delivery)", "Shipments ({n})", "Qty", "Total (due on delivery)", "Total (paid)", "Total (pending)" | `app/(storefront)/orders/[orderId]/page.js` |
| Account | "Sign in", "Email me a code", "No passwords — we email you a 6-digit code. Your past orders with this email join your account automatically once it’s verified.", "Code sent to {email}", "Checking…", "Sending…", "Different email / resend", "Your account", "Hi, {name}", "Orders", "No orders on this account yet — anything you buy with {email} lands here after sign-in.", "Start shopping", "Profile", "Sign out", "Save profile", "Saving…", "Saved.", "Save failed.", "Name", "Phone", "Default address — line 1", "Line 2 (optional)", "City", "State", "Pincode", "payment pending", "paid", "placed (COD)", "processing", "cancelled" | `app/(storefront)/account`, `components/account` |
| Account order | "Order details", "Placed", "Cash on delivery", "Paid online", "Discounts", "Refunded", "Shipment", "Courier", "tracking pending", "Track →", "updated {date}", "×{n}" | `app/(storefront)/account/orders/[orderId]/page.js` |
| Sign-in errors | "That email doesn't look right.", "That code isn't right — check the email and try again.", "That code expired — request a new one.", "No active code — request a new one.", "Too many wrong attempts — request a new code.", "Too many codes requested — use the latest one or try again in an hour.", "An address needs at least line 1, city and pincode.", "sign in first", "Too many attempts — give it a few minutes.", "Something went wrong." | `lib/customers.js`, `app/api/account/route.js`, `components/account/AccountAuth.js` |
| Returns | "Request a return", "What went wrong?", "Submit request", "Submitting…", "Cancel", "Couldn't submit — try again.", "Return request", "Store reply: {note}", "Returns: {reason}.", "not available for this order", "the {n}-day return window has passed", "order not found", "this order was never completed", "this order is already fully refunded", "Tell us a little more about why (at least 10 characters).", "A return is already open for this order." | `components/account/ReturnRequest.js`, `lib/returns.js`, `app/(storefront)/account/orders/[orderId]/page.js` |
| Reorder | "Reorder these items", "Checking today’s prices and stock…", "Add {n} items at today's prices", "Adding…", "Added ✓ — the cart shows today’s prices.", "Nothing from this order is available right now.", "currently sold out", "no longer in the catalog", "was ₹{old}, now ₹{new}", "order not found" | `components/account/ReorderPanel.js`, `lib/customers.js`, `app/api/account/route.js` |
| Wishlist | "Wishlist", "Save for later", "Saved", "Loading…", "Nothing saved yet — tap Save for later on any product. Your list stays in this browser unless you sign in and choose to merge it into your account.", "Saved on this device ({n})", "clear all", "You’re signed in. Move these into your account so they follow you across devices?", "Merge into my account", "Merging…", "This is the only way device and account lists ever join — nothing merges on its own.", "Merged: {n} added, {n} already saved.", "Merge failed — your local list is untouched.", "In your account ({n})", "Sign in to optionally keep this list on your account (your choice — nothing merges automatically).", "sold out right now", "no longer in the catalog" | `components/WishlistPage.js` |
| Contact | "Contact {name}", "Contact us", "Get in touch with us.", "Questions about an order or a product? Drop us a line.", "Send us a message", "Your name", "Email", "Send message", "Sending…", "Message received ✓", "Too many messages from this connection — please try again in a while.", "Something went wrong — please try again.", "Couldn't reach the server — check your connection and try again.", "Contact form" (screen reader) | `app/(storefront)/contact/page.js`, `components/ContactForm.js`, `app/api/contact/route.js` |
| Content pages | "Operated by {legal name} ·", "Effective from {date}", "Questions?", "Contact us", and for screen readers on FAQ pages "Copy link to "{question}"" | `components/ContentPage.js`, `components/FaqSection.js` |
| Journal | "Journal", "Nothing published yet — check back soon." | `app/(storefront)/journal/page.js` |
| Quiz | "Your picks", "Matched on: {tags} — same answers, same picks, every time.", "your answers", "Nothing in the catalog matches those answers right now — browse everything instead.", "Matching…", "← Back", "Something went wrong — try again.", "Want these picks in your inbox? (optional)", "you@example.com", "Sent ✓ — check your inbox.", "One email with these picks — that’s the whole deal. No list, no follow-ups." | `components/QuizRunner.js`, `app/api/quiz/[slug]/route.js` |
| Consent | "We use analytics and advertising cookies to understand shopping activity and improve {store name}. Only with your consent — change your mind anytime via the Privacy button.", "Allow all", "No thanks", "Settings", "Save choices", "Privacy", "Privacy settings", "Essential (orders, cart) — always on" | `components/analytics/ConsentBanner.js` |
| Emails | "Your sign-in code: {code}", "Your sign-in code is {code}. It expires in 10 minutes. If you didn't request this, ignore this email — nothing happens without the code.", "A note from the store", "Order {id}", "Your picks from the {quiz}", "Here are your picks:", "(no matches today)" | `lib/customers.js`, `lib/automations.js`, `app/api/quiz/[slug]/route.js` |
| Rate limit and gates | "Too many requests", "Store not found", "This store is temporarily unavailable", "Service temporarily unavailable" | `lib/rate-limit.js`, `lib/tenant-gate.js` |

### Not shopper-visible, so not in the scan

| Text | Location | Why |
|---|---|---|
| Storeasy, Shopify, Razorpay, Vercel, Turso and nutrition copy on marketing pages | `app/(storefront)/{customers,integrations,legal,pricing,templates,trust,verticals}`, `components/site` | Each route returns 404 on a store's address. `test:copy` asserts every host gate. |
| "Storeasy — fast, branded storefronts on your Shopify catalog", "Launch a fast, branded storefront on your existing Shopify catalog — themes, offers, releases and analytics included.", "Pricing", "Templates", "Integrations", "Trust & security", "Terms", "%s · Storeasy" | `app/(storefront)/layout.js:44-45`, `:174-177` | The platform-host branch only. `ALLOWED` names the Storeasy strings. |
| "Talk to us", "Tell us about your store — we reply personally.", "Tell us about your store — we onboard a small number of merchants at a time and reply personally." | `app/(storefront)/contact/page.js:19`, `:34-36` | The platform-host branch only |
| "Recorded: {decision}. Your agency can see this — publishing still happens through the store’s own release workflow.", "Your name", "Recorded with the decision.", "Comment (optional)", "Approve", "Request changes", "Couldn't record the decision — try again." | `components/ApprovalDecision.js` | Used only by the approval page (`app/(console)/approve/[token]/page.js`), for the person an agency asked to sign off |
| "Website" | `components/ContactForm.js:76` | A hidden field that catches bots. People don't see it. |
| "Shop {name} — fast." | `app/manifest.webmanifest/route.js:21` | A fallback that is never reached: `siteTagline()` always returns text |
| "idempotencyKey is required", "Unknown action", "unknown action", "No cart session", "Cart is empty", "Payload too large", "Invalid JSON", "message required", "event_id is required", "Unknown event name "{name}"", "quiz not found" | `app/api/checkout`, `app/api/cart`, `app/api/account`, `app/api/track`, `app/api/errors`, `app/api/quiz` | API replies no screen shows. Checkout replaces "No cart session" and "Cart is empty" with its own line (`lib/shopper-errors.js`). |
| "Shopify-hosted checkout is not implemented yet — mode reserved, checkout disabled", "Checkout is disabled for this store", "Checkout is paused while this store's subscription is renewed…", "The store is briefly down for maintenance…" | `lib/commerce/adapter.js` | API and console detail. Shoppers get the checkout page's fixed text, or `friendlyCheckoutError`'s, for this code. `test:copy` renders the closed page for the Shopify, disabled and maintenance cases and asserts its exact text. `test:commerce` asserts the Shopify wording stays in the adapter. |
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
| Cart drawer, "Add ₹X more for free shipping" (`lib/cart.js`) | A promise in the store's name about a threshold the founder never chose | Shown only when the store chose its rates (`shippingRatesChosen`, `lib/brand-tenants.js`, the one definition the console uses too). BeastLife keeps it, since its shipping policy publishes those figures. |
| Cart drawer and checkout, the shipping amount | The real charge, so hiding it would be dishonest | Kept. "Shipping" makes no claim about who set it. |
| Order confirmation label ("Standard shipping") | True of that order | Kept |
| `emptyCart()`: `computeShipping` with no config | Never displayed: the drawer's totals need items | Kept, no shopper path |
| Console. The Settings form showed defaults as if saved, and **every save wrote them to `shipping_config`**, so saving a support email silently adopted them. | The founder couldn't tell | The form says "You haven't set your own shipping rates yet", sends starter rates only if their values changed (retyping 79 is no change), and offers "Keep these rates". BeastLife sees no notice, because its cart already treats the rates as chosen. |

**What did not change:** what any shopper is charged. `lib/shipping.js` is untouched and `test:shipping` is unmodified. The server was already using the store's rates, and it remains the only source of the charged amount.

**Known limit:** a store that saved Settings before this change already has `shipping_config` holding the defaults, and the code can't tell those from chosen rates. Such a store counts as having chosen them and keeps the nudge.

---

## 5. For later work

No new CMS field was added. These should become editable or get a better answer later.

| Item | Why | Suggested owner |
|---|---|---|
| **Old default words already saved** | **Known limit, still open.** "Ludicrous speed" and "Fresh drops" were code defaults, and section 1 changed only the code. The Home editor prefills from the defaults, so a non-BeastLife store that saved the Home editor before this change stored the old text, and any release it published froze it (`lib/cms/view.js:30`, `components/admin/cms/HomeEditor.js:153`, `lib/releases.js:52`). Those shoppers still see both phrases, even on an empty store, because `app/(storefront)/page.js` swaps the subtitle only when it equals the new default. The suite can't see them, because stored content isn't scanned. A probe on a local test store confirmed this. Stores that never saved are unaffected. Production wasn't read, so the number of stores affected is unknown. **Owner decision:** count them with a read-only query, then run a one-off replacement of those two exact strings on non-BeastLife stores. It changes stored content, including published releases, so it isn't done here. | Owner, then GEN-01 or a one-off script |
| New-section prefills already saved | "Festive offer", "Shop now" and "Tell your story…" have the same limit: a store that published them unedited keeps them. A founder may have kept "Festive offer" on purpose, so these should be counted and shown to the owner, not replaced by a script. | Owner, with the row above |
| Empty-store message and "Coming soon" badge | A founder may want their own words. Today they are fixed. | ED, or GEN-01 |
| "Shop all collections" on an empty home | It works, but leads to "No collections to show yet". Left in place so an empty home keeps one way forward. | GEN-01 |
| Telling the founder why the store looks empty | The shopper page no longer explains it, so the console has to. US-04 needs this. | GEN-01, GEN-02 |
| Error, 404 and offline wording; "Your cart is empty" | Could carry a store's voice. BeastLife loses its gym line on the error page and in the cart. | ED |
| Refund timing and return review time | Removed because no setting holds them. Should come from real settings. | GEN-06 |
| Whether prices include GST | Removed because code can't know. Should come from Shopify or a setting. | GEN-06 or a tax item |
| Pulse and Glow kit presets | Show the copy before it is applied. Drop "live offers", "fast checkout" and "delivered fast" unless the store has set them. | ED |
| "A confirmation was sent to {email}" | Shopify sends this email (S18), so it can be early or wrong if the Shopify push is delayed. Kept for now. Not a brand or developer leak. | COM or PUB-12 |
| Sender address of store emails | Every store now shows its own name, but all share one `MAIL_FROM` address, and replies go there rather than to the store. If `MAIL_FROM` is unset in production, Resend's `onboarding@resend.dev` is used. The live value wasn't read. A per-store address and a reply-to using the support email are still needed. | Operations |
| Quiz email links | Relative paths (`/products/x`) in an email don't open. Not copy, so not changed here. | Follow-up bug |
| Shared bolt icon | `app/icon.svg` and `public/icons/*` are the lime bolt on every store | GEN-04 |
| Raw errors still in the `/api/checkout` JSON | No screen shows them now, but the network response still carries them. The catch-all is shared with the verify path, which another branch is changing. | Follow-up after that branch lands |
| Root layout crash | There is no `global-error.js`, so a crash in the layout itself shows Next's built-in English message | Follow-up |
