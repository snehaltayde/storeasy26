# Architecture

Recorded on 2026-11-24 from the code at `main` 68f31cc, as it is. Where this page and the
code disagree, the code wins and this page is fixed.

## Data model

There are two kinds of database:

- **One store database per tenant** (libSQL/Turso). The base tables are in `lib/schema.sql`; later ones are in `migrations/tenant/0002…0027`. A store's data is scoped by being in that store's own database, so no table carries a tenant id.
- **One control-plane database** (`lib/platform/schema.sql` + `migrations/platform/0002…0010`). Its tables carry `tenant_id` where they belong to a store.

Full columns and types are in the SQL files named below. This page lists each table's purpose, key and how rows go away. Columns are listed only for the tables new work touches most.

### Store database

**Catalog (written only by Shopify sync, never by the founder)**

| Table | Purpose | Key | Deletion |
|---|---|---|---|
| `products` | Shopify products: `id` (gid), `handle`, `title`, `description_html`, `product_type`, `vendor`, `tags`, `status`, `featured_image`, prices | `id` | Removed by sync when gone from Shopify |
| `variants` | `id` (gid), `product_id`, `price`, `compare_at_price`, `available`, `inventory`, `sku`, options | `id` | Sync |
| `product_images`, `collections`, `collection_products` | Images; collections; membership | gid / pair | Sync |
| `sync_runs` | Each catalog sync: status, cursor, counts (resumable, 0020) | `id` | Kept |
| `search_outbox` | Products whose search entry must be rewritten (0024) | rowid | Pruned after done |

**Content (the documents CMS — the only content engine since 0026)**

| Table | Purpose | Key | Deletion |
|---|---|---|---|
| `documents` | One row per page, header, footer, design, home, product or collection content: `id`, `type`, `slug`, `draft_body` (JSON), `draft_hash`, `revision`, `published_version_id`, `published_hash`, `archived_at`, `updated_by`, `updated_at` | `id` | Archived (`archived_at`), never deleted |
| `document_versions` | Immutable published or kept versions: `id`, `document_id`, `body`, `hash`, `created_by`, `created_at` | `id` | Kept |
| `releases`, `release_state` | A release lists the live version of every document; `release_state.live_release_id` is the live pointer | `id` / singleton | Kept |
| `publish_log` | One row per publish or undo, written in the publish batch | `id` | Kept |
| `document_refs` | Which document uses which media, product, collection, bundle or page | (document, kind, target) | Rewritten on save |
| `product_content_live`, `collection_content_live` | Published founder edits over Shopify values, read by `lib/catalog/effective.js` | entity id | Overwritten on publish |
| `preview_sessions` | Signed draft-preview sessions | `id` | Expire |
| `cms_state` | The store's content mode (`documents`, or `closed` until first publish) | singleton | — |
| `media` | Uploaded files: bytes or R2 `storage_url` (0027), `archived_at` (0025), derivatives via `parent_id` | `id` (`med_…`) | Archive, then two-step delete refused while referenced |
| `page_redirects`, `quizzes`, `experiments`, `experiment_exposures`, `experiment_conversions`, `ai_insights`, `automations`, `automation_runs`, `automation_flags` | Redirects, quiz, A/B tests, AI insight drafts, automations | `id` | Kept |
| Legacy, no longer written: `cms_blocks`, `cms_pages`, `cms_history`, `cms_templates`, `cms_approvals`, `product_overrides`, `collection_overrides`, `placements`, `cms_migration_runs`, `content_live_reversed`, `cms_preview_candidates` (0026's `DROP TABLE IF EXISTS preview_candidates` named the wrong table, so it stays) | Old-editor content kept for history and migration | — | Not dropped (migrations stay additive) |

**Commerce**

| Table | Purpose | Key | Deletion |
|---|---|---|---|
| `carts`, `cart_items` | Server carts; price at add (0004) | `id` | Expire |
| `orders`, `order_items`, `order_events`, `order_fulfillments`, `order_refunds`, `return_requests` | Orders and what happened to them; totals always recomputed on the server | `id` | Kept (cancelled, never deleted) |
| `offers`, `bundles` | Discount engine rows; bundles sync a `bundle-<id>` offer | `id` | Deleted by the founder |
| `customers`, `customer_otps`, `customer_sessions`, `customer_wishlists` | Shopper accounts (email OTP) | `id` | Privacy erasure via `privacy_requests` |
| `events`, `notifications`, `contact_messages`, `privacy_requests`, `app_errors` | Analytics events, outgoing email, contact form, privacy requests, errors | `id` | Pruned / kept |

### Control-plane database

| Table | Purpose | Key | Deletion |
|---|---|---|---|
| `tenants` | Each store: `id`, `name`, `status`, `db_url`, `db_token` (encrypted `k1:`), `config` JSON (brand, theme_pin, onboarding, checkout settings), `secrets` (encrypted) | `id` | Suspended, not deleted |
| `domains` | Host → tenant | host | Removed by operator |
| `users`, `memberships`, `invitations`, `sessions`, `login_limits` | People, their role per store, invites, sessions, login throttling | `id` | Revoked |
| `support_grants` | Time-boxed operator access to a store | `id` | Expire |
| `jobs`, `webhook_inbox`, `provision_runs` | Durable job queue, received webhooks, store provisioning runs | `id` | Pruned |
| `plans`, `subscriptions`, `billing_events`, `usage_events`, `entitlement_overrides`, `cost_inputs` | Storeasy's own billing of stores | `id` | Kept |
| `audit_log` | Every merchant and operator write: actor, action, resource, diff | `id` | Kept |
| `feature_flags`, `incidents`, `leads`, `case_studies` | Flags, status-page incidents, sales leads, marketing | `id` | Kept |
| `agencies`, `agency_members`, `agency_grants`, `agency_kits`, `agency_referrals`, `agency_commissions`, `client_approvals` | Agency partner programme (removed) | `id` | Unused since 2026-11-24, kept (migrations are additive) |

## Roles and permission matrix

Least-trusted roles: `support` in the merchant console; the anonymous shopper on the storefront.

Merchant roles are per store (`memberships.role`) and nest: owner ⊇ admin ⊇ staff ⊇ support. The matrix below is the code's own table in `lib/platform/authz.js`, enforced by `requireAdmin(request, action)` in every `app/api/admin/*` route (confirmed route by route by `test:permissions`: `scripts/support/admin-routes.js` lists every route × method × body-selected action, each row is called as owner, admin, staff, support, signed-out, another store's owner and an operator under a support grant, and the expected answer comes from `roleAllows()`; a static guard fails when a route file, method or `requireAdmin` action has no row). Every non-GET/HEAD admin request is also refused cross-origin, read actions included. Changing or removing an existing owner needs `team.owner`.

| Action | owner | admin | staff | support | shopper | operator |
|---|---|---|---|---|---|---|
| storefront.read (view editor, pages, media) | allow | allow | allow | allow | deny | via support grant |
| storefront.write (edit drafts, upload media) | allow | allow | allow | deny | deny | via support grant |
| storefront.publish (publish, undo, open the store) | allow | allow | deny | deny | deny | via support grant |
| offers.read / upsells.read | allow | allow | allow | allow | deny | via support grant |
| offers.write / upsells.write (offers, bundles, cart offer drafts) | allow | allow | allow | deny | deny | via support grant |
| orders.read | allow | allow | allow | allow | own only (account pages, signed order links) | via support grant |
| returns.decide | allow | allow | allow | deny | request own only | via support grant |
| orders.push / orders.cancel | allow | allow | deny | deny | deny | via support grant |
| sync.run | allow | allow | deny | deny | deny | allow |
| settings.read / settings.write (checkout, payments, secrets, domains view) | allow | allow | deny | deny | deny | allow |
| audit.read | allow | allow | deny | deny | deny | allow |
| team.manage | allow | allow | deny | deny | deny | allow |
| team.owner (grant or transfer owner) | allow | deny | deny | deny | deny | deny |
| cart, checkout, account | — | — | — | — | own cart / own account only (confirmed by `test:shopper-reads`) | — |
| platform console (tenants, provisioning, billing, flags, incidents) | deny | deny | deny | deny | deny | allow (TOTP sessions; bootstrap shared password until the first operator exists) |

What the read-only callers get back is proven by `test:support-reads`: every role without `settings.read` (staff, support) and an operator under a support grant calls every read they are allowed (`scripts/support/support-reads.js`), and each raw answer is searched for canary strings (store secrets and settings, member emails, an audit row, an order's customer details, `cart_id` and `idempotency_key`, another store's data, session tokens) and held to a per-probe list of top-level keys; the owner is the positive control. Member names are names only: a member without one reads "Someone on your team", never their email. Support and an operator under a grant search orders by order id only. `cart_id` and `idempotency_key` never leave the server in an admin read, for any role. Every console page has a row in `scripts/support/admin-pages.js`; Settings, Integrations and Automations check `settings.read` on the server before they fetch anything, and every page is run as support with its components stubbed (`scripts/support/page-harness.js`) so no prop carries a canary. Storefront-public values (Shopify domain, Razorpay key id, support email, shipping rates) and derived booleans are fine for support. No route reads `upsells.read`; its page redirects to the editor.

Admin routes that do not call `requireAdmin`, each with its own rule tested by `test:permissions`:

| Route | Rule |
|---|---|
| `admin/login` POST | public; cross-origin → 403; `{}` → 400; a wrong password → 401 with no `_admin` cookie; the shared password on a store with members → 401 |
| `admin/logout` POST | any caller (`allowUnresolved`); cross-origin → 403; signed-out → 200 and clears `_admin`; a session it is called with is revoked |
| `admin/accept-invite` POST | public token route; cross-origin → 403; `{}` → 400; a bad token → 400; never 401 |
| `admin/reset` POST | same rule as accept-invite |
| `admin/recover` POST | cross-origin → 403; `{}` → 400; an unknown email → 200 with the generic body |
| `admin/maintenance-pass` GET | public; always 302 to `/admin/login`; the `_mx` cookie only for a verified member (support included: a curtain pass only) or operator session, signed with the store's `order_link_secret`; signed-out and other stores' members get none |

`preview-session`, `documents`, `refs` and `releases` are gated through their `lib/admin/*` handlers, not exempt.

What a shopper gets back is proven by `test:shopper-reads`. A shopper is identified only by the `_customer` cookie (`customerFromToken`, hashed and looked up in the store's own database), the cart cookie (a body or query cart id is never read), or a signed order link `?t=2.<exp>.<hmac20>` (`verifyOrderStatusToken`, the store's `order_link_secret`); shoppers are not in `authz.js`. The suite calls `/api/account`, `/api/cart`, `/api/checkout` and the public reads, and runs `/account`, `/account/orders/[orderId]`, `/orders/[orderId]`, `/checkout/confirmation/[orderId]` and `/checkout` through the page harness, as anonymous, shopper A (positive control), shopper B with A's ids, B with a forged, revoked or expired session, and A's cookies on another store's host; every non-owner answer is searched for A's canaries. A checkout idempotency key returns an order only to the cart that made it (`orders.cart_id`): the same key from another cart is a 409 `IDEMPOTENCY_CONFLICT` with no order fields, and no cart cookie means no dedup. In production a store without its own secret mints no order link and verifies none, and hashes no sign-in code; the public `dev-only-secret` fallback is for local runs only.

Routes outside `app/api/admin/`, by class (`scripts/support/shopper-routes.js`; a static guard fails on a route, method or storefront page without a row):

| Class | Routes | Caller is proven by |
|---|---|---|
| shopper | `account`, `cart`, `checkout` | the `_customer` cookie or the cart cookie |
| public-read | `search`, `upsell`, `wishlist` (guest handles only), `media/[id]` | nothing; returns no shopper data |
| collector | `track`, `exp`, `contact`, `leads`, `quiz/[slug]`, `errors` | nothing; write-only intake |
| token | `preview`, `connect/shopify/start`, `connect/shopify/callback` | a signed token or OAuth state |
| operator | `platform/*` (except the billing webhook) | `lib/platform/admin-auth.js` |
| webhook | `shopify/webhooks`, `razorpay/webhook`, `platform/billing/webhook` | the provider's signature |
| job | `jobs/*`, `health` | the job secret |

"own only" means the cart, order or account must belong to the caller's session. Anything not listed is denied. The operator column is **unconfirmed** cell by cell: operator access to a store goes through `support_grants` and `lib/platform/admin-auth.js`, read but not tested here.

## Event flow

- **Every merchant or operator write** → an `audit_log` row (control plane) via `lib/platform/audit.js`.
- **Publish** (`lib/documents/publish.js`) → one batch writes the new release, the live pointer, `publish_log`, live content rows and `search_outbox` rows; after commit it writes `config.theme_pin` best effort and kicks a `search_reindex` job.
- **Checkout** → order + `order_events`; a `shopify_push` job creates the Shopify draft order; `payment_confirm` jobs reconcile Razorpay.
- **Shopper actions** → `events` rows (and Meta CAPI forwarding via `forward_event` jobs).
- **Shopify and Razorpay webhooks** → `webhook_inbox` → `webhook_apply` / `billing_apply` jobs.

## Background work

All background work is the durable `jobs` table (control plane), run by `runDueJobs` in `lib/platform/worker.js`, triggered by `/api/jobs/tick` (GitHub Actions cron `jobs-tick.yml` with `CRON_SECRET`). Jobs retry with backoff; unknown-outcome writes are never blindly retried (`lib/db.js` retries reads only).

| Job | Trigger | Touches |
|---|---|---|
| `catalog_sync` | Operator or founder "Refresh from Shopify", webhooks | Store catalog tables in slices; after a complete sync it may run the first-store generator |
| `search_reindex` | Publish, sync | Typesense from `search_outbox` |
| `shopify_push` | New order | Shopify draft order (allowlisted call) |
| `payment_confirm` | Razorpay | Order payment state |
| `webhook_apply`, `billing_apply` | Webhooks | Catalog, order and billing state |
| `send_notification` | Order and account events | Email via Resend |
| `forward_event` | Shopper events | Meta CAPI |
| `generate` | First run | Starter home and design drafts (`lib/first-run/generate.js`) |

## External services

| Service | Used for | How it fails | Alert when silent |
|---|---|---|---|
| Shopify (Admin + Storefront API, OAuth, webhooks) | Catalog source; draft orders | Sync run marked failed and resumable; checkout still takes orders and queues the push | Sync health on the dashboard; `ALERT_WEBHOOK_URL` on job failures |
| Turso | Store and control-plane databases | Reads retry transient errors; writes fail closed with plain words | `/api/health` |
| Typesense | Search | Falls back to SQL search | Search health in operator console |
| Razorpay | Payments (and Storeasy billing) | Checkout refuses the payment method; payment recovery refuses double payment | Webhook inbox backlog |
| Resend | Email | `notifications` row stays queued | Job failures |
| Cloudflare R2 (optional) | Media | Falls back to SQLite BLOB | — |
| Upstash Redis (optional) | Rate limits | Falls back to in-memory | — |
| Meta CAPI (optional) | Ads conversions | Event kept; forward retried | — |
| Anthropic (optional) | AI insights; later the AI copilot | Generators work without it (GEN-01) | Budget ledger |

Nothing is hosted yet: none of these has been exercised against a real hosted account in this codebase's current state.
