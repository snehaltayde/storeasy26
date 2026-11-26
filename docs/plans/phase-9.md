# Phase 9 plan: first-party plugins (roadmap Phase 6)

Architect plan, 2026-11-26 06:40 IST. Five tenant migrations (0040–0044, additive), no platform migration (0020 stays free), no new npm dependency, four new merchant actions. Every outside service sits behind a provider interface with a stand-in that refuses in production.

## Findings that shape the plan
1. **Plugin layer.** `lib/plugins/handlers.js` `BUILT_IN` is empty; `catalog.js` `BUILT_IN` holds only `trust-badges`; `killFlag(id)` gives `ff_plugin-<id>` (34-char limit). Block data resolvers get `(ctx, { installSettings })` with a 300 ms budget (`placement.js`). Slot `storefront.order.status` passes only `id, status, fulfillment_status, created_at` and is mounted on both order pages after their token checks. Primitives (`lib/plugins/blocks.js`: text, href, icon, integer, list) cover every Phase 9 block.
2. **Consent and messaging.** `_consent` (`lib/track/names.js`) is browser-tracking consent, not permission to message, so WhatsApp needs its own consent record. `notify()` refuses a `marketing` send without `consentRef`; `notifications` has `idempotency_key`, `consent_class`, `provider_id`. `lib/messaging/sms.js` is the pattern (a `stub` that writes a `notifications` row and refuses in production).
3. **Tracking.** `order_fulfillments.tracking_number` (Shopify projection) holds the AWB, so Shiprocket updates match on it.
4. **Shiprocket webhooks.** The URL must not contain "shiprocket", "kartrocket", "sr" or "kr"; the only security is an optional `x-api-key` header; the body is unsigned. Treat it as a hint and refetch the real status.
5. **AI.** `lib/ai/insights.js` hard-codes Anthropic (`claude-haiku-5-5` via `AI_INSIGHTS_MODEL`), has `assertNoPii` and a monthly budget via platform `recordUsage`/`usageTotals`. Banned-copy rules (`BANNED`, `CLAIMS`, `scanText`) live in `scripts/support/banned-copy.js`, which runtime code can't import; `CLAIMS` bans "reviews", "rated", "N stars" in generated text. `product_content` has no SEO fields, but its live row has `seo_title`, `seo_description` columns written as null by `live-rows.js`.
6. **Razorpay subscriptions** are used for platform billing (Storeasy's keys); stores use their own keys (`tenantOwnCfg`).
7. **Carts and offers.** `cart_items` PK `(cart_id, variant_id)`; the engine claims lines (`BUNDLE`, `BXGY`, `TIERED_QTY`) so one line can't take two line offers.
8. **Scheduled work** is a windowed idempotency key enqueued from `/api/jobs/tick` (pattern: `queueOnboardingSweep`).

## Order, parallelism, ownership
**Step 0 (Opus, small, no behaviour change; merges before the lines):**
- Permissions: the four new actions in `lib/platform/authz.js` + rows in `scripts/test-authz.js`.
- Anchors in `lib/plugins/catalog.js` (`// p9: <id>`), `handlers.js`, `blocks.js`, `components/plugins/blocks/index.js` (one per line).
- Topic `order.delivery_updated` in `lib/plugins/topics.js` `TOPICS` (internal; not in `SUBSCRIBABLE`).
- `lib/plugins/sweeps.js` with `registerSweep`: one `plugin_sweep` job per 10-minute window from the tick; it walks stores with an enabled, un-killed install of a plugin that has a sweep, calling `sweep({ install, now })` inside `withTenant`. Add `plugin_sweep` to `lib/platform/worker.js` `HANDLERS` and `queuePluginSweep()` to `app/api/jobs/tick/route.js`.
- `lib/delivery/estimate-source.js` `estimateFor({ pin, storeEstimate })` returning the store estimate for now; wired into `app/api/pincode/route.js` and `app/api/checkout/route.js`.
- Anchors `{/* messaging-consent */}` in `components/checkout/AddressStep.js`; `{/* account: subscriptions */}` and `{/* account: messaging */}` in `app/(storefront)/account/page.js`.
- Drill `scripts/drills/plugins/{run.mjs,lib.mjs,stage-baseline.mjs}` (the `STAGE_FILES` pattern) + `drill:plugins` in `run-isolated.mjs` and in `ALL`.
- `pnpm test` green with the same counts.

**Then all five lines in parallel** (own worktrees, ≤ 3 heavy runs). Merge order and migrations: 1 reviews (0040) → 4 Shiprocket (0041) → 3 WhatsApp (0042) → 5 copilot (0043) → 2 subscriptions (0044, last: cart, checkout, engine). If the order changes, renumber; never merge a lower number after a higher one ran.

| Shared file | Owner / rule |
|---|---|
| `app/api/checkout/route.js`, `CheckoutFlow.js`, `lib/cart.js`, `lib/offers/engine.js`, `lib/payment-settle.js`, `components/ProductPurchase.js` | line 2 only |
| `components/checkout/AddressStep.js` | line 3: one import + one element at its anchor |
| `app/(storefront)/account/page.js` | lines 2 and 3, one element each at their anchors |
| `app/(storefront)/products/[handle]/page.js` (JSON-LD) | line 1 only |
| `lib/pincode/index.js`, `lib/delivery/estimate-source.js`, `components/pdp/DeliveryCheck.js`, admin order view | line 4 only |
| `lib/registry/document-types.js`, `lib/documents/live-rows.js`, `lib/ai/*`, banned-copy move | line 5 only |
| `lib/privacy.js`, `lib/platform/export.js`, `lib/admin/nav.js`, `lib/plugins/{catalog,handlers,blocks}.js`, `components/plugins/blocks/index.js`, `package.json`, `scripts/support/*`, `run-isolated.mjs`, `drills/plugins/run.mjs`, `docs/UI.md`, `docs/ARCHITECTURE.md`, `MANUAL-CHECKS.md` | append-only at anchors; docs and lists keep both sides; **code conflicts resolved by hand** (PLAYBOOK) |
| Order pages | nobody edits them; lines 1 and 4 render through the `storefront.order.status` slot |
| `lib/notifications.js` | not edited; line 1 calls `notify()`; line 3 owns `lib/messaging/whatsapp.js` |

Every builder runs `pnpm test`, `test:shopify-boundary`, `test:security` (`git add` new routes first), `test:shopper-reads`, `test:support-reads`, `test:permissions`; screens add `test:console-kit`, `test:console-shell`; a new nav item (lines 1, 2, 5) adds `drill:shell`; and its own `drill:plugins` stage after committing.

---
## Line 1: reviews from an invite link, moderated, with stars and JSON-LD (`reviews`)
**Features (floor)**
1. Plugin `reviews`. Settings: invite emails on/off (default **off**); send N days after fulfilment (1–30, default 7); "Show store replies" (default on). Blocks (each starts Off): "Stars" (`rating_summary`, `pdp.under_price`: average to one decimal, count, link to `#reviews`); "Reviews" (`review_list`, `pdp.below_fold`: distribution bars, latest 10 approved, store replies, "See all reviews" → `/products/[handle]/reviews`); "Review links" (`link_list`, `order.status`: "Review {product}" per product on the order with an unused invite).
2. Invites: handler for `order.fulfilled` creates one `review_invites` row per distinct product (`UNIQUE(order_id, product_id)`); the sweep sends one email per order (`notify`, transactional, `idempotencyKey review_invite:<order>`) when emails are on and `send_after` passed; skips suppressed emails; every email has a signed "Don't ask me for reviews" link writing `review_optouts`.
3. Token `<rvi_id>.<exp>.<base64url HMAC-SHA256("review-invite|"+id+"|"+order+"|"+product+"|"+exp, storeLinkSecret())>`, 60 days, constant-time check, single-use (`used_at` set in the same batch as the review insert, `WHERE used_at IS NULL`); recomputable, so order-page links store no plaintext; no link secret in production → fails closed.
4. `/reviews/write?t=` (storefront page, plain HTML form, no JavaScript needed): product title and image; rating 1–5 (radio stars), title ≤ 80, review 20–2,000, display name (prefilled "Priya S.", ≤ 40); "We never show your email". `POST /api/reviews`, 10/hour/IP. A used, expired, tampered or other-store token: "This review link has already been used or has expired" (reveals nothing). After: "Thanks. Your review will appear once the store has read it."
5. `/admin/reviews` (nav "Reviews"): tabs Pending, Approved, Rejected, Hidden; rating and product filters; counts; rows with stars, title, text, product, display name, "Verified buyer", date, plus order link and email for staff and up (redacted for support); Approve, Reject (internal reason), Hide, Restore, Reply/edit reply (≤ 1,000), bulk Approve/Reject (≤ 50); plain empty state.
6. Storefront reads only `approved` reviews; no email column in any shopper read; text rendered as plain text; store B's reviews never on A.
7. JSON-LD: `productJsonLd` adds `aggregateRating {ratingValue, reviewCount, bestRating: 5, worstRating: 1}` only when the plugin is enabled and not killed, the Stars placement is Live, and count ≥ 1; from approved reviews only; numbers only; script body escapes `<` as `<`.
8. Stats via `cachedTenantRead("plugins", ["reviews", productId])`; every moderation write invalidates.
9. `redactCustomer` deletes that customer's reviews, invites and opt-outs by email hash; `export.js` lists the tables.
10. Media deferred (EXIF/GPS stripping needs a new image dependency, plus image moderation).

```sql
-- migrations/tenant/0040_reviews.sql (additive)
CREATE TABLE IF NOT EXISTS review_invites (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL,
  customer_id TEXT, send_after TEXT NOT NULL, sent_at TEXT, expires_at TEXT NOT NULL, used_at TEXT, review_id TEXT,
  created_at TEXT NOT NULL, UNIQUE(order_id, product_id));
CREATE INDEX IF NOT EXISTS idx_review_invites_due ON review_invites(sent_at, send_after);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, order_id TEXT NOT NULL,
  invite_id TEXT NOT NULL UNIQUE, customer_id TEXT, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT, body TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT, reply TEXT, reply_by TEXT, reply_at TEXT, moderated_by TEXT, moderated_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
CREATE TABLE IF NOT EXISTS review_optouts (email_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL);
```
**Files:** new `lib/plugins/first-party/reviews/{manifest,handlers,sweep}.js`, `lib/reviews/{tokens,store,moderate,stats}.js`, `app/api/reviews/route.js`, `app/(storefront)/reviews/write/page.js`, `app/(storefront)/reviews/optout/page.js`, `app/(storefront)/products/[handle]/reviews/page.js`, `components/plugins/blocks/{RatingSummary,ReviewList,LinkList}.js`, `app/api/admin/reviews/route.js`, `app/(console)/admin/(authed)/reviews/page.js`, `components/admin/reviews/{ReviewQueue,ReviewRow,ReplyDialog}.js`, `scripts/test-reviews.js` + `test:reviews`, `scripts/drills/plugins/stage-reviews.mjs`; changed: anchors, `app/(storefront)/products/[handle]/page.js`, `lib/privacy.js`, `export.js`, `nav.js`, `scripts/support/{admin-routes,admin-pages,support-reads,shopper-routes}.js`, `docs/UI.md`.

| Action | anonymous | signed-in shopper | support / op-support | staff | admin, owner |
|---|---|---|---|---|---|
| PDP stars, list, all-reviews page | approved only, this store | same | n/a | n/a | n/a |
| write page, `POST /api/reviews` | valid token only; else the same refusal | same | n/a | n/a | n/a |
| `reviews.read` (queue) | n/a | n/a | 200, email and order redacted | 200 | 200 |
| `reviews.moderate` | n/a | n/a | 403 | 200 | 200 |

**Tests:** tampered, expired, other-store and replayed tokens refused (two concurrent submits → one review); a token for order A can't review product X from order B; pending, rejected, hidden never render or count; JSON-LD count and average equal the approved set over 200 random sets, absent when Stars is Off, plugin off or killed, or 0 reviews; a `</script>` title can't break the tag; anonymous HTML has no `@` from a seeded email; support canaries (reviewer email, order id); opt-out suppresses; privacy erase; banned-copy scan on default copy.

**Drill `plugins/stage-reviews`:** place and fulfil a fixture order; open the invite link from the notifications row; submit; PDP shows nothing; staff approve; anonymous PDP shows stars + JSON-LD; reusing the link refuses; support has no moderation controls.

## Line 2: subscribe to a product; pause, skip, swap or cancel from `/account` (`subscriptions`)
**Decision: scheduled re-orders through the jobs tick, not Razorpay Subscriptions.** Each renewal is an ordinary checkout priced fresh, paid by Razorpay or COD under existing rules; nothing is charged automatically, and the page says so. Reasons: no stored mandate (RBI e-mandate limits, AFA) and no plan per price; skip and swap are ours to define; every money path is the existing tested one. Cost: renewals depend on the shopper acting (auto-debit is an owner question).

**Features (floor)**
1. Settings: subscriber discount 0–30% whole numbers (default 0); intervals offered (14, 30, 45, 60, 90 days); eligible products (all, or by tag); reminder days before due (1–7, default 3); days to pay after due (1–14, default 7).
2. PDP buy box (plugin enabled, not killed, product eligible, base market): "One-time" vs "Subscribe and save 10%: ₹X every [30 days]"; "You pay for each delivery when it's due. Nothing is charged automatically." Subscribing sets `cart_items.subscription_interval`; a variant is one or the other in a cart.
3. Engine: new offer type `SUBSCRIPTION` built on the server from plugin settings, never the client; claims subscribed lines first (no other line offer stacks); percent rounded the way the engine rounds lines; cart-level coupons and thresholds treat these claimed lines exactly like `BUNDLE`-claimed lines; plugin off → line prices one-time (drawer shows it; checkout total from the server).
4. Checkout: a subscription line needs a signed-in shopper (401 "Sign in to subscribe" + sign-in link); a non-base market → 409 plain words; `runOrderEffects` calls `createSubscriptionsFor(orderId)` keyed on order + line (repeat-safe) and links a renewal order to its cycle.
5. `/account` → Subscriptions: product, variant, quantity, interval, status, next due, "Next delivery ₹X (price today; confirmed at checkout)"; **Pay for this delivery** (when due) builds a renewal cart (`carts.subscription_id`, `subscription_cycle`) → `/checkout`; **Skip next** (cycle skipped, due moves one interval); **Pause** (until a date or resumed) / **Resume**; **Swap** (another variant or eligible product, current price, from the next cycle); **Change interval or quantity** (1–10); **Cancel** behind a confirm (kept as cancelled, never deleted). Own subscriptions only.
6. Sweep: marks a cycle `due` and emails a reminder N days before (amount from the same pricing function; link to `/account`, never a raw pay link); after the grace days marks `missed` and schedules the next; two misses in a row pause with an email.
7. `/admin/subscriptions`: list with status filters, next due, next amount, customer (redacted for support), history; staff and up can pause or cancel for a customer (reason audited).
8. `redactCustomer` cancels and anonymizes subscriptions (`customer_id` null); export lists the tables.

**Every read of the money this changes (each tested):** cart (`getCart`) and its route, drawer, sticky bar, PDP subscribe price; offer progress and nudges (subscription lines excluded from other offers' progress); checkout `quote` (prepaid, COD, nudge), COD OTP amount binding, Razorpay mint, verify and webhook amount check; order totals, `applied_offers`, snapshot; Shopify push (line discount and `appliedDiscount`) and `test:shopify-boundary`; reminder email, account "next delivery", admin "next amount"; confirmation email and order pages; reports and dashboard (`discount_total`, `COALESCE(base_total, total)`); refunds (projection, unchanged); plugin webhook `orderSnapshot` and API v1 orders.

```sql
-- migrations/tenant/0044_subscriptions.sql (additive; number by merge order)
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, customer_id TEXT, product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL, quantity INTEGER NOT NULL, interval_days INTEGER NOT NULL, discount_percent REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', next_due_at TEXT NOT NULL, paused_until TEXT, cycle INTEGER NOT NULL DEFAULT 1,
  missed_in_row INTEGER NOT NULL DEFAULT 0, origin_order_id TEXT NOT NULL, origin_line TEXT NOT NULL,
  cancelled_at TEXT, cancel_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(origin_order_id, origin_line));
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(status, next_due_at);
CREATE TABLE IF NOT EXISTS subscription_cycles (subscription_id TEXT NOT NULL, cycle INTEGER NOT NULL, due_at TEXT NOT NULL,
  status TEXT NOT NULL, order_id TEXT UNIQUE, reminded_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(subscription_id, cycle));
ALTER TABLE cart_items ADD COLUMN subscription_interval INTEGER;
ALTER TABLE carts ADD COLUMN subscription_id TEXT;
ALTER TABLE carts ADD COLUMN subscription_cycle INTEGER;
```
Discount percent locked at signup; price follows the product; new columns read via `hasColumns`.

**Files:** new `lib/plugins/first-party/subscriptions/{manifest,sweep}.js`, `lib/subscriptions/{store,pricing,actions,renewal}.js`, `app/api/account/subscriptions/route.js`, `app/api/admin/subscriptions/route.js`, `components/account/SubscriptionList.js`, `components/pdp/SubscribeChoice.js`, `app/(console)/admin/(authed)/subscriptions/page.js`, `components/admin/subscriptions/{SubscriptionTable,SubscriptionDetail}.js`, `scripts/test-subscriptions.js` + `test:subscriptions`, `scripts/drills/plugins/stage-subscriptions.mjs`; changed `lib/offers/engine.js`, `lib/cart.js`, `app/api/cart/route.js`, `app/api/checkout/route.js`, `components/checkout/CheckoutFlow.js`, `lib/payment-settle.js`, `lib/shopify-push.js` (only if needed), `components/ProductPurchase.js`, the account anchor, `lib/privacy.js`, `export.js`, `nav.js`, `scripts/support/*`, `docs/UI.md`.

| Action | anonymous | shopper (own) | shopper (another's id) | support / op-support | staff | admin, owner |
|---|---|---|---|---|---|---|
| account subscription GET/POST | 401, no data | 200 | 404 same as missing; row unchanged | n/a | n/a | n/a |
| checkout with a subscription line | 401 | 200 (base market) | n/a | n/a | n/a | n/a |
| `subscriptions.read` | n/a | n/a | n/a | 200, PII redacted | 200 | 200 |
| `subscriptions.manage` | n/a | n/a | n/a | 403 | 200 | 200 |

**Brute-force test (mandatory):** 1,000 random carts mixing subscribed and one-time lines (real seeded variants, whole quantities, live BXGY, tiered and coupon offers, random discount percents and shipping/COD configs): PDP subscribe price × qty = cart line = quote = Razorpay `amount` (stubbed `fetch`) = `orders.total` = stubbed Shopify draft total. For 300 random histories (skip, swap, pause, price change): reminder amount = account figure = that day's checkout total; a price change in between gives the existing 409. Body `discount`, `subscription_interval` on a non-eligible product, `subscription_id` ignored. One order per cycle even when two renewal checkouts race. Pinned clock.

**Drill `plugins/stage-subscriptions`:** sign in, subscribe on the PDP, place COD; `/account` shows it; Skip moves due; Swap changes the variant; Pause/Resume; a pinned-clock sweep makes it due; "Pay for this delivery" reaches checkout with the quoted total; Cancel; signed out `/account/subscriptions` reads nothing.

## Line 3: WhatsApp order updates and an abandoned-cart reminder, consent-gated (`whatsapp`)
**Consent decision:** two separate opt-ins, both unticked by default, at checkout and in `/account`: "Send my order updates on WhatsApp" (purpose `updates`, transactional class, still needs the explicit opt-in since Meta requires opt-in for business-initiated messages) and "Also send me offers and cart reminders on WhatsApp" (purpose `marketing`, marketing class, `consent_ref` = consent id). Nobody with neither opt-in receives anything.

**Features (floor)**
1. Provider `lib/messaging/whatsapp.js` `sendWhatsApp({ to, template, vars, consentClass, consentRef, idempotencyKey })`: `stub` writes a `notifications` row (`provider_id whatsapp-stub`) and refuses in production; `meta` (WhatsApp Cloud API template messages via `safeFetch`, egress `graph.facebook.com`) uses store secrets (phone-number id, access token, app secret); `WHATSAPP_PROVIDER` selects; production with no provider → settings say "not connected", nothing sends.
2. Templates (`whatsapp_templates`): `order_confirmed`, `order_shipped` (tracking link), `order_delivered`, `cart_reminder`. Storeasy default text seeded as a **draft**; the founder edits the preview, Meta template name and language, then **Approve**; editing returns it to draft; only approved templates send. Fixed vars `{store}`, `{order}`, `{total}`, `{link}`, `{first_name}`. Default copy passes `scanText` with shopper rules.
3. Consent capture: `components/checkout/WhatsAppConsent.js` at the AddressStep anchor → `POST /api/messaging/consent` (cart cookie, 10 per 10 min); each row records phone, exact wording and version, source. `/account` toggle via `app/api/account/messaging/route.js`.
4. Order updates: first-party handlers for `order.created`, `order.fulfilled`, `order.delivery_updated` (delivered only), one message per order and status (`wa:<kind>:<orderId>`), only when a live `updates` consent matches the order's phone hash and is bound to the order's cart or customer.
5. Abandoned cart (sweep): a cart with items, a live `marketing` consent bound to that cart, no order from it, idle for the delay (1–24 h, default 2 h); one reminder per cart ever; caps ≤ 1 marketing message per phone per 24 h and ≤ 2 per 7 days, per-store daily cap (default 200); quiet hours 21:00–09:00 store time (marketing only); link `/cart/r/<signed cart token>` restores that cart (no PII).
6. Opt-out: every message has a signed `/m/stop?t=` (GET shows, POST confirms); the account toggle; inbound "STOP" via `app/api/whatsapp/webhook/route.js` checking `X-Hub-Signature-256` (HMAC of the raw body with the app secret, constant time) plus the GET verify challenge; privacy erase revokes and deletes consents. Consent is re-checked at send time, so any revocation stops pending sends.
7. App detail card: connection status, templates with Approve, caps, delay, message log (last 50, phones masked for support).

```sql
-- migrations/tenant/0042_whatsapp.sql (additive)
CREATE TABLE IF NOT EXISTS messaging_consents (id TEXT PRIMARY KEY, channel TEXT NOT NULL, purpose TEXT NOT NULL,
  phone_e164 TEXT NOT NULL, phone_hash TEXT NOT NULL, customer_id TEXT, cart_id TEXT, source TEXT NOT NULL,
  wording TEXT NOT NULL, wording_version INTEGER NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT, revoked_via TEXT);
CREATE INDEX IF NOT EXISTS idx_mc_phone ON messaging_consents(phone_hash, purpose, revoked_at);
CREATE INDEX IF NOT EXISTS idx_mc_cart ON messaging_consents(cart_id);
CREATE INDEX IF NOT EXISTS idx_mc_customer ON messaging_consents(customer_id);
CREATE TABLE IF NOT EXISTS whatsapp_templates (kind TEXT PRIMARY KEY, provider_template TEXT, language TEXT NOT NULL DEFAULT 'en',
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', approved_by TEXT, approved_at TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS whatsapp_reminders (cart_id TEXT PRIMARY KEY, consent_id TEXT NOT NULL, sent_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient, consent_class, created_at);
```
**Files:** new `lib/messaging/{whatsapp,consent,caps}.js`, `lib/plugins/first-party/whatsapp/{manifest,handlers,sweep,templates}.js`, `app/api/messaging/consent/route.js`, `app/api/account/messaging/route.js`, `app/api/whatsapp/webhook/route.js`, `app/(storefront)/m/stop/page.js`, `app/(storefront)/cart/r/[token]/route.js`, `components/checkout/WhatsAppConsent.js`, `components/account/MessagingPrefs.js`, `components/admin/apps/WhatsAppCard.js` (AppDetail anchor), `app/api/admin/apps/[id]/whatsapp/route.js`, `scripts/test-whatsapp.js` + `test:whatsapp`, `scripts/drills/plugins/stage-whatsapp.mjs`; changed anchors, `lib/privacy.js`, `export.js`, `scripts/support/*`, `docs/UI.md`.

| Action | anonymous | shopper | support / op-support | staff | admin, owner |
|---|---|---|---|---|---|
| consent POST | own cart cookie only | own | n/a | n/a | n/a |
| account messaging toggle | 401 | own only | n/a | n/a | n/a |
| stop page, cart-restore link | signed token only | same | n/a | n/a | n/a |
| WhatsApp card and log (`apps.read`) | n/a | n/a | 200, phones masked | 200 | 200 |
| templates, approve, caps, secrets (`apps.manage`) | n/a | n/a | 403 | 403 | 200 |
| webhook | bad or missing signature → 401, nothing changes | | | | |

**Tests:** "nobody else": 60 seeded carts and orders across every combination (no consent; updates only; marketing only; revoked; another cart's consent with the same phone; consent on store B; order placed; quiet hours; cap reached) — after every handler and sweep, the `whatsapp-stub` rows equal the expected set exactly, and no row exists for a phone without the matching live consent. Unapproved or edited templates never send; a replayed event doesn't send twice; pinned clock for quiet hours and caps; webhook signature known-answer, tampered body refused; stub refuses in production; support canaries (phone, access token).

**Drill `plugins/stage-whatsapp`:** admin approves templates; a shopper ticks both boxes and places COD → an `order_confirmed` stub row; a second cart with marketing consent idles, the pinned-clock sweep sends one reminder whose link restores the cart; the stop link revokes; a third cart without consent gets nothing.

## Line 4: Shiprocket delivery estimate and live tracking on the order page (`shiprocket`)
**Features (floor)**
1. Settings: API user's email and password (secret); pickup PIN; default weight (0.1–30 kg); "Delivery dates come from: your shipping settings / Shiprocket's courier estimate" (default: your settings); webhook token (generated, shown once, Rotate); the webhook address to paste, on a path with no "sr"/"kr": `/api/parcel-updates`.
2. Provider `lib/couriers/shiprocket.js`: `login` caches its token encrypted for 9 days (`courier_auth`); `serviceability(pin, { cod, weight })` → `{serviceable, cod, minDays, maxDays}`, cached 12 h per PIN; `trackAwb(awb)`; all via `safeFetch`, egress `apiv2.shiprocket.in`, 1.5 s timeout on shopper paths. A `stub` uses recorded fixtures and refuses in production.
3. Estimate: `estimate-source.js` uses Shiprocket only when the source setting is Shiprocket and the plugin is enabled and not killed; timeout or failure falls back to the store estimate. Unserviceable PIN: "Couriers don't reach this PIN code yet" on PDP and checkout (ordering not blocked). Fees and COD rules stay the store's.
4. Webhook `/api/parcel-updates`: `x-api-key` compared in constant time against a per-store hash, else 401; body ≤ 64 KB; answers 200 fast; enqueues `courier_refetch:<awb>`, and the refetch result is what's written; unknown AWB logged and ignored. The sweep re-polls undelivered shipments older than 4 h, ≤ 50 per run.
5. `shipment_tracking`: statuses normalized (placed, in transit, out for delivery, delivered, returning, cancelled, exception) with Shiprocket's label kept; ETD; scans ≤ 50 (time, hub, activity; no names or phones); RTO return AWB noted. A move to delivered or out for delivery emits `order.delivery_updated` (`delivery:<awb>:<status>`).
6. Order page block "Tracking" (`tracking_timeline` in `order.status`, starts Off): status, "Expected by …" (ETD once shipped, else the snapshot's estimate), timeline, courier link; renders only inside the order page's token gate.
7. Admin order view: a shipment card (`orders.read`).

```sql
-- migrations/tenant/0041_shipment_tracking.sql (additive)
CREATE TABLE IF NOT EXISTS shipment_tracking (awb TEXT PRIMARY KEY, order_id TEXT NOT NULL, courier TEXT, status TEXT NOT NULL,
  status_label TEXT, etd TEXT, delivered_at TEXT, return_awb TEXT, scans TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
  last_event_at TEXT, fetched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_shipment_order ON shipment_tracking(order_id);
CREATE INDEX IF NOT EXISTS idx_shipment_open ON shipment_tracking(status, fetched_at);
CREATE TABLE IF NOT EXISTS courier_auth (provider TEXT PRIMARY KEY, token_enc TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courier_pin_cache (pin TEXT PRIMARY KEY, serviceable INTEGER, cod INTEGER, min_days INTEGER,
  max_days INTEGER, fetched_at TEXT NOT NULL);
```
**Files:** new `lib/couriers/{shiprocket,stub,normalize}.js`, `lib/plugins/first-party/shiprocket/{manifest,sweep}.js`, `lib/shipments.js`, `app/api/parcel-updates/route.js`, `components/plugins/blocks/TrackingTimeline.js`, `components/admin/orders/ShipmentCard.js`, `components/admin/apps/ShiprocketCard.js`, `scripts/fixtures/shiprocket/*.json`, `scripts/test-shiprocket.js` + `test:shiprocket`, `scripts/drills/plugins/stage-shiprocket.mjs`; changed `lib/delivery/estimate-source.js`, `lib/pincode/index.js`, `components/pdp/DeliveryCheck.js`, `components/checkout/DeliveryEstimate.js`, the admin order page (card only), the worker handler for `courier_refetch`, `scripts/support/*`, `docs/UI.md`.

| Action | anonymous | shopper | support / op-support | staff | admin, owner |
|---|---|---|---|---|---|
| tracking block | its own order's token or session only; another order's id → not found | own orders only | n/a | n/a | n/a |
| `/api/pincode` estimate | public, this store only | same | n/a | n/a | n/a |
| admin shipment card (`orders.read`) | n/a | n/a | 200, no PII | 200 | 200 |
| settings and token (`apps.manage`) | n/a | n/a | 403 | 403 | 200 |
| `/api/parcel-updates` | wrong or missing key → 401; store B's key on A → 401 | | | | |

**Tests:** key checks (missing, wrong, rotated old key after the overlap, another store's); a webhook body claiming "delivered" with a refetch saying "in transit" stores "in transit"; order A's token never shows B's tracking; estimate source "store" byte-identical to Phase 8; 1.5 s timeout falls back; RTO fixture; the `egress.js` import walk never reaches `app/(storefront)` or `components`; store hosts containing "sr" documented as an owner check.

**Drill `plugins/stage-shiprocket`:** admin enables with the stub and Shiprocket estimate; PDP "Check delivery" shows courier dates; fulfil a fixture order with an AWB; POST a fixture webhook with the token; the order page shows "In transit" then a timeline ending Delivered; a wrong key gets 401; another order's page shows no tracking.

## Line 5: AI copilot: starter store, product SEO and FAQs, offer ideas (`ai-copilot`)
**Features (floor)**
1. Provider `lib/ai/provider.js` `complete({ system, user, maxTokens })` → `{ text, tokensIn, tokensOut, provider, model }`; `AI_PROVIDER` = `anthropic` (default), `openai`, `gemini`, `stub` (tests; refuses in production). Anthropic default model `claude-sonnet-5-5` (chosen over `claude-opus-5-5` for short structured copywriting at lower cost); `AI_MODEL` overrides; OpenAI and Gemini need `AI_MODEL` set (no guessed ids). Keys `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`; no key → the page says the copilot isn't set up. `lib/ai/insights.js` moves onto the provider (closes the "Later" model-id item).
2. Plugin `ai-copilot`; operator kill switch `ff_plugin-ai-copilot` (global or per store); `/admin/copilot` (nav "Copilot") with an install prompt until installed. Tasks:
   - **Starter store:** a home draft from registry sections (hero, featured collection, text, FAQ) via `saveVersion` as an AI version; becomes the draft only when home has no unpublished edits, otherwise offered to restore.
   - **Product SEO and FAQs** for up to 10 products a run: `seo_title` (≤ 70), `seo_description` (≤ 160), FAQ module (≤ 6) as `product_content` drafts, reviewed in the editor.
   - **Offer ideas** (≤ 3): offers created with `enabled = 0` and `config.source = "copilot"`, checked by `lib/offers/validate.js`, capped at 30% off; simulator link shown.
   - Nothing publishes; legal or policy documents never touched.
3. Zero PII: the prompt holds only catalog and brand data (titles, descriptions, types, tags, prices, collections, store name, brand voice, tokens); email and phone shapes scrubbed from catalog text; then `assertOutgoingClean(prompt)` refuses on any email, Indian or E.164 phone, `@`-handle, order id, or seeded customer value. No orders, search terms, customers or addresses are read.
4. Output parsed into a fixed schema, checked with registry validators and `scanText(text, { shopper: true, claims: true })`; an item with a hit is dropped and named ("Removed one suggestion: it claimed 'clinically proven'"); empty result → no draft and an honest message.
5. Daily budget: `ai_usage_ledger` by day in store time, default 100,000 tokens (`tenantCfg("ai_daily_tokens")`, operator-set); reservation by one conditional `INSERT … SELECT WHERE spent + reserve <= budget` (no overspend under concurrency), reserved with `max_tokens` including any thinking; settled with actual tokens; failure frees the reservation; also records platform `recordUsage(ai_tokens)`; page shows "38,200 of 100,000 used today; resets at midnight".
6. History: last 30 runs (task, who, when, tokens, links to drafts).

```sql
-- migrations/tenant/0043_ai_usage_ledger.sql (additive)
CREATE TABLE IF NOT EXISTS ai_usage_ledger (id TEXT PRIMARY KEY, day TEXT NOT NULL, task TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT NOT NULL, status TEXT NOT NULL, tokens_reserved INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER,
  result_refs TEXT NOT NULL DEFAULT '[]', actor TEXT, created_at TEXT NOT NULL, settled_at TEXT);
CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_ledger(day, status);
```
**Files:** new `lib/ai/{provider,prompt-guard,copilot,budget}.js`, `lib/copy/banned-copy.js` (rules moved unchanged; `scripts/support/banned-copy.js` re-exports), `lib/plugins/first-party/ai-copilot/manifest.js`, `app/api/admin/copilot/route.js`, `app/(console)/admin/(authed)/copilot/page.js`, `components/admin/copilot/{CopilotTasks,BudgetMeter,RunHistory,ProductPicker}.js`, `scripts/fixtures/ai/*.json`, `scripts/test-copilot.js` + `test:copilot`, `scripts/drills/plugins/stage-copilot.mjs`; changed `lib/ai/insights.js`, `lib/registry/document-types.js` (`seo_title`, `seo_description`), `lib/documents/live-rows.js`, `scripts/support/banned-copy.js`, `nav.js`, `scripts/support/*`, `docs/UI.md`.

| Action | anonymous | support / op-support | staff | admin, owner |
|---|---|---|---|---|
| copilot page and history (`storefront.read`) | n/a | 200, no run controls | 200 | 200 |
| starter, SEO, FAQ (`storefront.write`) | n/a | 403 | 200 | 200 |
| offer ideas (`offers.write`) | n/a | 403 | 200 | 200 |
| storefront | AI drafts never live until a founder publishes | | | |

**Tests:** a stub provider captures every outgoing body for every task over a store seeded with customers, orders, search terms and a description containing an email; the scan finds no email or phone shape and none of the seeded values. 20 concurrent runs at the budget edge never pass it; failures free their reservation; IST day rollover on a pinned clock. Kill switch global and per store → 403 with words. After each task, `publish_log` and live rows unchanged and every new offer has `enabled = 0`. Output with "#1 brand" or "clinically" dropped; malformed JSON → no draft. `test-copy` passes with the same counts after the banned-copy move.

**Drill `plugins/stage-copilot`:** owner installs and runs SEO + FAQs on 2 products with the stub; the editor shows drafts; anonymous PDP unchanged; offer ideas appear as Off offers; the meter rises; support sees no run buttons.

---
## Events and side effects
| What | Where | Consumers |
|---|---|---|
| audit `reviews.approve/reject/hide/restore/reply`, `subscriptions.pause/cancel` (merchant), `apps.settings`, `apps.whatsapp_template_approve`, `apps.shiprocket_token_rotate`, `copilot.run` (task, tokens; no copy) | `audit_log` | Audit, operators |
| `order.delivery_updated` (internal) | `plugin_events` | WhatsApp |
| jobs `plugin_sweep` (10-min window), `courier_refetch` | platform jobs | worker |
| `notifications` types `review_invite`, `subscription_reminder`, `subscription_paused`, `whatsapp_<kind>` | store DB | Notifications, drills |
| slog `review_token_refused`, `wa_skipped {reason}`, `wa_sent`, `courier_unknown_awb`, `courier_timeout`, `ai_prompt_refused`, `ai_budget_refused` (no PII) | logs | operators |

## Decisions (schema and permissions first)
1. Migrations: tenant 0040 reviews, 0041 shipment tracking, 0042 WhatsApp, 0043 AI ledger, 0044 subscriptions; merge order; additive; no platform migration.
2. New actions: `reviews.read` (support and up), `reviews.moderate` (staff and up, like `returns.decide`), `subscriptions.read` (support and up), `subscriptions.manage` (staff and up). Plugin settings, templates and secrets under `apps.manage`. Copilot reuses `storefront.write` and `offers.write`. `APP_PERMISSIONS` unchanged (no outside app reads reviews, subscriptions or consents).
3. Review invites: HMAC-signed, bound to order + product, single-use, 60 days, fail closed without a link secret.
4. Review media deferred.
5. `AggregateRating` only from approved reviews, only while Stars is visible.
6. Review invite emails transactional, off by default, with an opt-out.
7. Privacy erase deletes reviews, invites, consents, opt-outs; anonymizes subscriptions.
8. Subscriptions: scheduled re-orders via the tick, paid at each renewal checkout; no auto-debit, no Razorpay Subscriptions; base market only; discount locked at signup, price follows the product; subscription lines take no other line offers.
9. Subscription creation in `runOrderEffects`, not behind plugin deliveries.
10. WhatsApp: two explicit opt-ins re-checked at send time, bound to cart or customer; marketing ≤ 1/day and ≤ 2/week per phone, one reminder per cart, quiet hours; templates send only once approved; real provider Meta Cloud API.
11. Shiprocket owns only the estimate and serviceability text, only when chosen; webhook checked by key then refetched.
12. AI: default `claude-sonnet-5-5`; provider by env; no guessed ids for OpenAI/Gemini; daily per-store budget reserved atomically; outgoing prompt scrubbed then asserted clean; output passes the banned-copy and claims scan; kill switch `ff_plugin-ai-copilot`; banned-copy rules move to `lib/copy/` unchanged.
13. `product_content` gains `seo_title`, `seo_description` (founders can edit by hand).
14. Shared scheduling and plumbing built in step 0 (one `plugin_sweep` registry, one `estimate-source` hook, anchors).

## Checks the builder runs first
- `ls migrations/tenant | tail -3 && ls migrations/platform | tail -2 && node scripts/test-schema-compat.js`
- `node scripts/test-apps.js && node scripts/test-plugin-slots.js && node scripts/test-plugin-webhooks.js && node scripts/test-authz.js && node scripts/test-copy.js && node scripts/test-cod-checkout.js && node scripts/test-markets.js` (record counts; drop missing)
- `grep -rn "CLAIMS\|scanText" scripts/test-*.js` — if a suite scans rendered PDP HTML with `CLAIMS`, line 1's "reviews" wording will trip it; scope that scan to generated documents; never loosen the rule.
- `grep -n "kind" lib/documents/versions.js | head` (line 5: `saveVersion` accepts a new kind)
- `grep -n "egress\|storefront" scripts/test-plugin-webhooks.js | head` (line 4)
- `grep -n "BUNDLE" lib/offers/engine.js lib/offers/progress.js lib/shopify-push.js` (line 2)
- `grep -n "secret()" lib/customers.js lib/orders.js`
- Read current official docs before coding (record the date): Shiprocket serviceability and track fields (apidocs.shiprocket.in); WhatsApp Cloud API version and template-send body; Anthropic Messages structured output and `max_tokens` with adaptive thinking. Reading docs is fine; never call the real services.

## Risks
1. Line 2 changes engine, cart and checkout — merges last, after its brute-force test; the reviewer gets the money-read list.
2. WhatsApp sending without consent is the worst failure: re-check at send time; the "nobody else" set-equality test is mandatory; Indian DLT and Meta policy are owner checks.
3. Adaptive thinking can use more tokens than visible output: reserve with `max_tokens` including thinking.
4. Shiprocket webhook security is a shared key only: refetch by AWB before writing; a store host with "sr"/"kr" may be refused by Shiprocket's URL rule.
5. Shared-file conflicts across five branches: step-0 anchors, append only, code conflicts by hand, `pnpm test` after each merge.

## Owner-only checks (into `docs/cms-reviews/MANUAL-CHECKS.md`)
1. WhatsApp Cloud API number and approved Meta templates: a real order update and cart reminder; reply STOP and confirm the opt-out.
2. Shiprocket: real API-user login, serviceability for 5 known PINs, a live tracking webhook on a deployed URL.
3. A real `ANTHROPIC_API_KEY` run of each task: quality, tokens, cost against the meter (optionally OpenAI/Gemini with `AI_MODEL`).
4. A real review invite email; JSON-LD in Google's Rich Results Test on a deployed PDP.
5. A renewal paid through real Razorpay test mode.
6. Owner question: is a scheduled re-order paid at each renewal acceptable, or should Razorpay auto-debit be a later line?
7. Owner question: are review invite emails acceptable as transactional (off by default)?

## Later (not planned)
Review photos and video; bulk invites to past buyers; auto-debit renewals; subscriptions outside the base market; courier COD rules overriding the store's; WhatsApp for shoppers without checkout or account consent.

## Builders
Opus: step 0 and all five lines' server, permission and storefront code. Sonnet: `docs/UI.md` sections, `MANUAL-CHECKS.md` entries, Shiprocket and AI fixtures, default WhatsApp template and review-email copy (banned-copy scanned), a receiver note in `docs/APPS_WEBHOOKS.md` for `order.delivery_updated`. ui-designer: reviews queue, subscriptions (account and admin), WhatsApp card, copilot page, tracking block.
