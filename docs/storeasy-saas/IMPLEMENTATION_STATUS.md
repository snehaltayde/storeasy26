# Storeasy SaaS — implementation status

Tracking file required by `Storeasy_Claude_Developer_Handoff.md` §6 and
`CLAUDE_START_PROMPT.txt` step 3. States: **not inspected** · **verified complete** ·
**partial** · **missing** · **blocked**. A state other than "not inspected" is backed
by a code audit or implementation in this repo — never by documentation alone.

- Created: 2026-10-28 (session S25). Last updated: S29 (W2 underway; W1 complete).
- Roadmap: all 116 records are phased S25–S49 in the approved plan
  (`~/.claude/plans/lively-moseying-bunny.md`); waves per the handoff.
- **Audit coverage honesty:** 29 of 116 records audited/implemented so far
  (BE01, SF23, SF08 — S25; BE02, MC01, OP01 — S26; BE03, BE16 — S27;
  BE13, BE17, BE12 — S28; BE14, BE19, OP05 — S29; BE04, BE25 — S30;
  BE10, BE36, SF09, MC16 — S31; BE06, BE07, SF06, SF07, MC14, MC22 — S32;
  BE18, SF24, BE20 — S33, with SF08 completed). The other 87 are **not
  inspected** — the handoff's Fix/Extend/New labels for them remain unverified
  documentation claims.

## Package gaps (blockers: none hard, recorded)

- `enhanced_feature_catalog.json` — referenced by the handoff and start prompt, not
  present in `docs/storeasy-saas/`. The feature records were read from
  `Storeasy_Enhanced_Feature_List.md` instead.
- `reference/Implementation_Specification.md` and `reference/sources.json` —
  referenced (handoff §8, feature list footer), not present. Entity/API contracts
  will be derived from the actual repo, which the handoff itself prefers.

## Locked decisions (user-confirmed 2026-10-28)

1. Checkout: keep direct Razorpay+COD as default path behind the BE06 adapter with
   per-tenant capability gates; Shopify-hosted handoff later as an alternative mode;
   authorization status documented, never assumed.
2. Identity (BE02): self-managed users/sessions/memberships in the control plane
   (scrypt, TOTP MFA, email invites). No external auth vendor.
3. Billing (BE11): Razorpay Subscriptions (platform bills merchants directly).
4. Jobs (BE14): durable Turso-backed job/webhook-inbox tables + secured tick
   endpoint invoked by a free external scheduler; `after()` stays fast-path only.
5. Marketing site (MK) = same Next app in platform-host mode. Minimal mail
   transport arrives in S26; full notification service (BE23) in W3.
6. Fail-closed scope (S25): applies when a control plane is configured
   (`PLATFORM_DB_URL` set). Unset = legacy single-tenant env-fallback mode — keeps
   the current pre-platform production deploy and old local dev working. Multi-tenant
   deployments MUST set `PLATFORM_DB_URL`.

## Audited records

### BE01 — Tenant resolution and boundary · **partial (W1 core implemented & verified, S25)**

Observed state (code audit, 2026-10-27/28, pre-fix):
- `lib/platform/control.js:59-80` `getTenantByHost`: unknown host → `null` (L77);
  suspended tenant dropped from the active-only host index (L65) → `null`;
  control-plane refresh failure → stale map kept, ~5s retry (L71-74); `getTenant`
  throw escapes to callers.
- Every consumer treats `null` as "use the env-default tenant (BeastLife)":
  `lib/tenant-request.js:20-27` (`requestTenant`, catch→null), `:34-44`
  (`tenantHandler`, catch→null), then `withTenant(null, …)` → env DB
  (`lib/db.js:73-87`), env admin password, env Razorpay/Shopify creds, BeastLife
  branding (`lib/site.js:21`).
- `lib/platform/ops.js:71-76` `runAsTenant`: no status check (would enter a
  suspended tenant). `forEachActiveTenant` (L10-38): control-plane failure swallowed
  → silently runs env-default work once.
- No status checks: `app/api/connect/shopify/start` (L31-32), `…/callback` (L33-34),
  `app/api/platform/tenants/[id]` POST (L34-37).
- Suspended fallback documented as intended pre-SaaS behavior
  (`app/api/platform/tenants/[id]/route.js:13-14`) — superseded by this slice.

Selected slice (S25): fail-closed `resolveHost` outcomes
(legacy/resolved/unknown/suspended/unavailable), `PLATFORM_STALE_MS` outage budget,
`lib/tenant-gate.js` HTTP mapping, neutral page shell, API 404/503 with stable
codes, ops/CLI/connect-route gates, `scripts/test-tenant-boundary.js`.

Out of this slice (recorded, scheduled later): adapter-level context *requirement*
(db/search/media refusing contextless access in platform mode) — enforcement is at
entry points for now; full de-env-ing of tenant config is the user's stated next
phase; BE12 domain registry (S28).

### SF23 — Offline and errors · **partial (W1 core implemented & verified, S25)**

Observed: `app/not-found.js` + `app/error.js` are neutral but render inside the
tenant-resolved root layout, so unknown hosts get env-fallback (BeastLife) chrome,
pixels and cart. `public/manifest.webmanifest`, `public/offline.html`, `public/sw.js`
cache names are statically BeastLife-branded on every host. `app/robots.js` is
statically prerendered with the build origin.

S25 delivers the W1 core: neutral unknown-host response, safe suspended response
(control-plane name only), no tenant/env branding on gated hosts. Release-driven
branded 404/offline/maintenance + per-tenant manifest/SW = W3 (S36).

### SF08 — Confirmation · **partial (exposure confirmed → contained & verified, S25; full fix scheduled S33)**

Observed (code audit): `app/checkout/confirmation/[orderId]/page.js:13-16` fetched
the order with **no token/cookie check** — order id alone (BL- + 8 hex ≈ 32 bits,
`lib/orders.js:59-62`) returned full PII: first name, email (L55), full name +
address + phone (L109-115), `razorpay_payment_id` (L122), items/totals — AND the
valid tokenized `/orders/<id>?t=` link (L56), defeating the status page's token too.
404-vs-200 also confirmed which ids exist. `/orders/[orderId]` itself was correctly
token-gated before DB read (L40) and renders no contact PII.

Containment (S25, same token scheme — no invented identity semantics):
server-computed `confirmationPath` (`?t=` token) in every `/api/checkout` success
response incl. idempotent duplicates; `CheckoutFlow` navigates to it; confirmation
page verifies the token BEFORE any DB read (404 for bad token and missing order
alike); robots noindex; constant-time token compare.

Residual risks (recorded, scheduled):
- Token is deterministic and non-expiring → replaced by signed expiring guest proof
  in S33 (SF08 full, W2).
- Token travels in the query string → reaches GA4/Meta pixels, Meta CAPI
  `event_source_url` (`lib/track/client.js:26`, `lib/events.js:204`) and error
  reports (`components/analytics/ErrorReporter.js:21`, `instrumentation.js:11`).
  No `Referrer-Policy` header anywhere. → S33 (strip token after load +
  Referrer-Policy).
- ~32-bit order ids; secret chain falls back to `razorpay_key_secret` then the
  literal `"dev-only-secret"` (`lib/orders.js:367-389`) — tenants provisioned via
  `provisionTenant` get a real `order_link_secret`; env deployments should set
  `ORDER_LINK_SECRET`. → hardening with S33.

### BE02 — Identity and sessions · **partial (core implemented & verified, S26)**

Replaced the shared password-derived tokens with individual identity:
- Control plane gains `users` (scrypt `N=16384,r=8,p=1` hashes; TOTP secret
  encrypted at rest), `sessions` (random 32-byte cookie token, SHA-256 stored,
  expiry + revoked_at; verified FRESH per request so revocation holds across
  instances), `memberships` (user↔tenant+role — stored now, fully enforced in
  S27/BE03), `invitations` (single-use, tenant-bound, 7d; also `reset` kind, 1h),
  `login_limits` (distributed throttle: 10/15min per email + per IP).
- Edge-safe verification (`lib/platform/sessions.js`, web crypto + libsql HTTP);
  Node-only credential work (`lib/platform/identity.js`). Password change/reset
  revokes every session. CSRF origin checks on login/logout/settings/platform
  mutations (full route sweep lands with S27's authorize()).
- Bounded fallbacks (recorded design): LEGACY mode (no `PLATFORM_DB_URL`) keeps
  the old derived token exactly; BOOTSTRAP (platform mode, zero member users /
  zero operators) accepts the old shared password until the first account exists
  — the migration path for existing tenants. A control-plane outage degrades
  auth to the bootstrap check, but gated pages are unreachable then anyway.
- Out of scope, scheduled: role enforcement per action (S27), session rotation
  mid-life, merchant-side MFA for privileged actions (S27), audit_log rows for
  sign-ins (slog only until S27), team management UI (W4/MC23).

### MC01 — Merchant sign in · **partial (implemented & verified, S26)**

`/admin/login` takes email+password (empty email = bootstrap password, only while
the tenant has no users); "Forgot password?" → 1-hour emailed reset (generic
response, no enumeration); invite acceptance page (`/admin/accept-invite`) creates
account+membership and signs in; reset page (`/admin/reset`). Settings
password-rotation now only re-issues the cookie in bootstrap mode. CLIs:
`pnpm user:create`, `pnpm invite:create` (mock mail prints the link until
`RESEND_API_KEY` is set — clearly labeled). MFA for merchant privileged actions:
S27.

### OP01 — Operator identity · **partial (implemented & verified, S26)**

`/platform` sign-in = operator email + password + MANDATORY TOTP (first login
returns the secret/otpauth once, first valid code confirms enrollment); sessions
are 12h, kind `operator` — a merchant session can never pass operator routes
(verified). `pnpm operator:create` creates/promotes operators; the first operator
disables the legacy `PLATFORM_ADMIN_PASSWORD`. Sign-ins slog'd
(`platform_login*`); durable audit rows come with BE16 (S27).

### BE03 — Role authorization · **partial (core implemented & verified, S27)**

- `lib/platform/authz.js`: owner ⊇ admin ⊇ staff ⊇ support permission sets over
  `<area>.<verb>` actions (offers/orders/storefront/upsells/settings/sync/
  audit/team). `requireAdmin(request, action)` in lib/admin-auth.js is called by
  EVERY admin API route: authentication + role check + CSRF origin check for
  writes, in one gate. 403 (role) vs 401 (unauthenticated) distinguished.
- Tenant spoofing structurally denied: the tenant is always the host-resolved
  context; URL/body tenant ids authorize nothing (verified: a tenant-A session
  is 401 on tenant-B's host).
- Final-owner protection in addMembership/removeMembership; `pnpm member:set`
  CLI for role changes/removal; revocation is effective on the next request —
  there is NO permission cache to invalidate (fresh membership lookup per
  request), satisfying the invalidation requirement by construction.
- Bootstrap/legacy cookies act as role owner (single-password mode).
- Out of scope, scheduled: org/agency grants (BE28, W5), worker-action actor
  attribution beyond CRON_SECRET (W2 jobs rework), role-aware PII field
  filtering in order read models (BE10/MC16, S31), role-aware tab hiding in the
  console UI (MC23, W4), merchant MFA for privileged actions (arrives with the
  first money-path actions in W2).

### BE16 — Audit and approval · **partial (audit core implemented & verified, S27)**

- Control-plane `audit_log`: append-only by construction — the application
  exposes INSERT (`audit()`) and scoped SELECT (`listAudit`) only; no update or
  delete code path exists (test asserts the module surface). Rows: actor,
  actor_kind, tenant, action, resource, request-id slot, timestamp, and a
  REDACTED diff (keys matching password/secret/token/key/credential are
  stripped; 2KB size cap). Audit failures never fail the mutation (best-effort,
  slog'd).
- Writers wired: admin + operator logins, password resets, invite created/
  accepted, role set/removed, settings saves (key NAMES only), offer writes/
  deletes, storefront block/page writes, upsell writes, order pushes, catalog
  syncs, tenant provision/suspend/activate/sync.
- Read API: `GET /api/admin/audit` (owner/admin, host-tenant-scoped).
- Out of scope, scheduled: approvals bound to content hashes (BE09/S36),
  operator-identity attribution on platform routes (currently actor "operator"
  — individual operator ids attach when platform routes adopt a requireOperator
  gate, W2/OP10), audit UI tab (MC26, W4), storage-level immutability policy
  beyond app construction (documented; provider-level WORM is a W4 ops item).

### BE13 — Secret management · **partial (rotation core implemented & verified, S28)**

- Envelope v2 `k1:<keyfp>:<blob>` (key fingerprint = 8 hex of a keyed hash —
  identifies the key, reveals nothing); legacy bare-base64 blobs stay readable.
- Dual-read / single-write rotation: `PLATFORM_SECRET_NEXT` opens a rotation
  (both keys decrypt; writes + OAuth-state signatures use NEXT, state
  verification accepts both), `pnpm rotate:secrets` re-encrypts every stored
  blob (tenants.db_token_enc / secrets_enc, users.totp_enc — audited,
  re-runnable, counts-only output), then the keys swap. The "rotation orphans
  ciphertext" defect is gone; the suite proves the stranded case exists ONLY
  when the runbook is skipped. Live: dev control plane's blobs upgraded to k1
  envelopes, all tenants decrypt, storefront unaffected.
- Masked read models re-checked: settings view stays presence-only; audit
  diffs redact secret-ish keys; rotate CLI prints fingerprints only.
- Out of scope, scheduled: per-secret purpose/rotation metadata rows and
  managed-KMS envelopes (post-W2 if needed); audited revoke flow per
  integration (BE24, S34).

### BE17 — Versioned migrations · **partial (ledger implemented & verified, S28)**

- `lib/platform/migrate.js`: two tracks (tenant / platform), baseline = the
  frozen schema files + `migrations/<track>/NNNN_*.sql`; every DB carries its
  own `schema_migrations` (id, sha-256 checksum, applied_at). Applied files are
  checksum-locked (editing one is a hard error telling you to write a new
  migration); failures are not recorded, so retries re-run the file; adoption
  on live DBs is a no-op re-run of the IF-NOT-EXISTS baseline.
- Wired: `pnpm migrate`, `pnpm platform:migrate`, provisioning
  (applyTenantSchema), new `pnpm tenant:migrate -- --all|--tenant` (failure-
  isolated per tenant, suspended included, audited). Live: control plane
  recorded baseline+0002_domains; all 3 tenant DBs recorded their baseline.
- Discipline documented in migrations/README.md (expand → backfill → contract;
  idempotent files because executeMultiple is not transactional).
- Out of scope, scheduled: canary cohorts + fleet rollout UI (OP06, S42);
  renderer dual-schema windows arrive with the release system (S35–36).

### BE12 — Domains and certificates · **partial (registry core implemented & verified, S28)**

- Control-plane `domains` table (host PRIMARY KEY = platform-wide uniqueness):
  claim mints a `storeasy-verify=<hex>` TXT challenge; verify does a real DNS
  TXT lookup (injectable for tests) and ACTIVATES the host into tenants.domains
  (which the resolver reads, cache-invalidated); remove deactivates; any
  re-claim mints a FRESH challenge, so a reclaimed domain can never ride a
  previous owner's proof. `--pre-verified` = explicit, audited operator
  assertion for dev hosts that can't carry TXT records. `primary` flags the
  canonical host + mirrors `config.primary_host`.
- Surfaces: `pnpm domain -- claim|verify|remove|primary|list` +
  `GET/POST /api/platform/domains` (operator cookie + origin check).
- Live round-trip: claimed `s28-probe.test` (pre-verified) → host SERVED the
  demo store over HTTP → removed → 404 fail-closed again; real-domain claim
  printed its TXT instructions; cross-tenant takeover refused; DNS verify
  failed honestly on a nonexistent record (ENOTFOUND surfaced).
- Deferred (recorded): the path-preserving primary-host HTTP redirect and the
  DNS/TLS wizard (MC21/W4 — needs middleware or the domains UX; `is_primary` +
  `config.primary_host` carry the data already); Vercel Domains API attachment
  (deploy checkpoint A, needs the Vercel project context); TLS checks are
  Vercel-managed and observed at MC21.

### BE14 — Durable jobs and webhook inbox · **partial (core implemented & verified, S29)**

- Control-plane `jobs` (idempotent enqueue via UNIQUE idempotency_key, atomic
  lease UPDATE, attempts/backoff-with-jitter, dead-letter + critical alert,
  audited replay) + `webhook_inbox` (raw body persisted for replay, sha-256,
  per-tenant fan-out rows). Handlers run under `runAsTenant` and are
  idempotent — at-least-once execution, money state changes once (acceptance
  test green: a replayed payment.captured marks the order paid exactly once,
  `paid_at` unchanged).
- Receipts persist BEFORE acknowledgement: shopify webhooks answer 500 when
  the receipt can't be written (provider redelivers); razorpay transient
  failures now ack `{queued:true}` backed by our own retry job. Crash-after-ack
  recovery = lease expiry (tested).
- Dispatch: `after()` fast path via atomic single-job lease (`runJobById`) +
  `GET /api/jobs/tick` drained by an external scheduler
  (.github/workflows/jobs-tick.yml, inert until TICK_URL/CRON_SECRET repo
  secrets are set — USER ACTION at deploy checkpoint A); daily crons piggyback
  a small drain as insurance. Checkout paths enqueue durable
  shopify_push/forward_event backups (fast path usually wins; jobs no-op).
- Legacy mode (no control plane): original behavior preserved exactly
  (sweeps + provider redelivery).
- Out of scope, scheduled: catalog-sync generation/cursor model (BE04, S30);
  migrating the ORDER-STATE retry sweeps themselves onto the queue (they stay
  the money-truth owner; jobs guarantee attempt delivery — recorded design).

### BE19 — Monitoring and service operations · **partial (extended, S29)**

- `/api/health?all=1` now carries `queue` stats (pending/leased/dead/oldest-
  pending-minutes + inbox) and degrades the rollup on dead letters or a >60min
  pending backlog. `sendAlert` gains severity levels (critical/warn/info) +
  optional runbook pointer; `pnpm alert:test` is the delivery self-test
  (verified honest-failure locally where no ALERT_WEBHOOK_URL is set).
- Still pending: synthetic journey checks and log-PII audit sweep (W2/S34 with
  BE34), real alert destination (user config).

### OP05 — Queue and webhook inspector · **partial (implemented & verified, S29)**

- `/platform` console "Queues & webhooks" panel + `GET/POST
  /api/platform/queues` (operator cookie + origin check): stats, non-done jobs
  and inbox rows (METADATA ONLY — payloads never serialized), per-row replay
  (audited `queue.replay`, idempotency proven by the acceptance test), and a
  "run due now" button. Provider/store binding visible per row (source, topic,
  shop, tenant).

### BE04 — Catalog synchronization · **partial (generation model implemented & verified, S30)**

- Every full sync is a recorded generation: tenant-DB `sync_runs` (id = the
  generation, status running/complete/failed, page cursor, fetched/written/
  pruned counts, error). Rows written by the run are stamped
  (`products.sync_generation` / `collections.sync_generation`, migration
  0002_sync_runs); webhook writes stay unstamped with a fresh `synced_at`.
- **Prune ONLY after a COMPLETE run**: anything not stamped by the finished
  generation AND untouched since the run's start watermark is deleted with its
  children (variants/images/memberships). A FAILED partial run records the
  failure and touches nothing (acceptance: failed partial sync never deletes
  good rows — suite-proven). Missed deletions (webhook gaps) self-heal on the
  next complete run; webhook-raced rows written mid-run survive via the
  watermark (suite-proven).
- Event persistence before async handling landed in S29 (webhook inbox); the
  webhook incremental path is unchanged and shares the same reshape/write code.
- LIVE: beastlife's first generation-tracked sync completed (319 products /
  281 collections, cursor recorded) and pruned **7 ghost products + 4 ghost
  collections** that upsert-only syncs had stranded; storefront healthy after.
- Out of scope, scheduled: Typesense staleness is handled today by the full
  delete-recreate-import rebuild; atomic rebuild-and-swap + health/lag
  surfacing is BE05 (S38). Mid-run page-cursor RESUME is recorded diagnostics
  only (a failed run re-fetches from scratch — catalogs are small).

### BE25 — Shopify partner integration · **partial (audited + hardened, S30)**

- **Install model (audited, documented):** one CUSTOM-DISTRIBUTION app per
  store, created in the merchant's own Shopify Dev Dashboard; tokens via
  client-credentials (same-org stores) or the authorization-code connect flow
  (S21: HMAC-signed 10-min state, callback verifies state + Shopify param HMAC
  + shop match). No public/listed app exists; nothing here claims Shopify
  approval of anything (handoff rule).
- **Hardening added (S30):** scope check at token mint — `missingScopes()`
  compares the granted scopes to OAUTH_SCOPES; a partial grant warns on the
  connect success page AND fires a warn-severity alert (suite-tested).
  Reinstall handling verified in code: `app/uninstalled` sets the tenant flag +
  alerts (S21), a successful reconnect clears it.
- **Protected customer data position (recorded honestly):** customer PII enters
  via OUR checkout, not Shopify customer APIs; we push draft orders/orders with
  write_orders + write_draft_orders. Moving to a public app would require:
  partner-org app, app review, protected-customer-data access request, current
  checkout-integration rules re-verified at that time (tracked as an external
  dependency, not code).
- **Pending external (needs the user's Shopify session):** a REAL
  uninstall→reinstall drill on the dev store, and the two-unrelated-shops
  install matrix (requires a second dev store — known W2-exit item).

### BE10 — Order and refund projection · **partial (core implemented & verified, S31)**

- Three independent per-order dimensions: the existing `status` machine
  (capture + push) plus provider-mirrored `financial_status` /
  `fulfillment_status` + `refunded_total` and `order_refunds` /
  `order_fulfillments` rows (migration 0003_order_projection) — neither
  derives from the other anymore.
- Ingestion = authoritative reconciliation: order webhooks (NEW topics
  refunds/create, fulfillments/create+update, orders/cancelled, routed through
  the S29 inbox) are hints that trigger a targeted order refetch rebuilding the
  whole projection under an `updatedAt` watermark. Suite-proven acceptance:
  duplicate snapshot cannot double revenue; an older snapshot is refused (no
  status regression); refunds sum exactly to the captured total.
- LIVE: reconciled the cancelled S29 probe order against the real store →
  financial `voided`, Shopify's ₹0 restock-refund record mirrored, status page
  200 with correct copy.
- Recorded design: Shopify-side cancellation only updates the projection
  (financial voided); the LOCAL status machine is never driven from webhooks —
  local cancellation stays the operator CLI's job. Net-sales rollups with
  currency/cutoff rules are BE21 (S42) on top of refunded_total. PENDING
  deploy item: `pnpm webhooks:register <slug>` per tenant for the new topics.

### BE36 — Tax and money definitions · **partial (implemented & verified, S31)**

- `lib/money.js`: explicit per-currency exponents (incl. 0- and 3-decimal
  currencies), `toMinor`/`fromMinor`/`roundMoney`, minor-unit `sameAmount`,
  and largest-remainder `allocateProportional` (drift-free partial-refund /
  discount splitting — fixture-tested to the paisa).
- Swept the provider compare sites: checkout dedup epsilon, Razorpay paise
  amounts (route + webhook + replay worker), and the Shopify push reconcile
  guard all go through minor units now. Semantics documented: cart figures are
  estimates, the order row is our captured contract, providers stay
  authoritative for charged/refunded money.
- Remaining (scheduled): tax-inclusion metadata + invoice semantics arrive
  with real tax surfaces (W4); UI estimate-labeling pass rides MC22/SF06 (S32).

### SF09 — Order tracking · **partial (implemented & verified, S31)**

- The tokenized status page now renders PER-PARCEL shipment cards from the
  local projection (carrier, number, link, per-parcel "carrier status updated
  …ago" — an outage shows as stale data, never a broken page) plus a refund
  banner keyed on refunded amount. Every view of a pushed order refreshes the
  projection in the background (after()); the page never waits on Shopify.
- Two-parcel fixture suite-proven. Phone-lookup flow: not offered (recorded).

### MC16 — Orders and order detail · **partial (extended & verified, S31)**

- Detail page: financial/fulfillment badges, Shipments + Refunds panels,
  existing timeline, and "Reconcile from Shopify" (audited `orders.reconcile`,
  requested-vs-confirmed states on screen). The RetryPushButton quirk is FIXED:
  `pushResultMessage` translates refusal shapes into honest copy.
- Role-limited reads: the support role never receives customer PII (list +
  detail APIs and the detail page all pass through `redactOrderForRole`;
  client-safe `lib/admin/order-view.js`).
- Remaining (scheduled): provider deep-links & refund-request actions (W2+,
  with supported provider flows), list-page projection columns (W4 polish).

### BE06 — Cart and checkout adapter · **partial (capability gate implemented & verified, S32)**

- `lib/commerce/adapter.js`: explicit per-tenant `checkout_mode` — `direct`
  (default: the existing first-party Razorpay+COD flow with its idempotency,
  secure cart binding and state machine, all unchanged), `disabled` (checkout
  API 503 `CHECKOUT_DISABLED`, page explains "cart is saved", browsing/cart
  stay up), `shopify` (RESERVED: keeps checkout OFF instead of pretending —
  the hosted-handoff adapter is a later wave behind this same gate). Unknown
  values fail closed. Modes are merchant settings (audited), never silently
  switched — the handoff's conditional-replacement rule is now enforceable
  configuration. `checkoutCapability()` also scopes the prepaid flag to the
  tenant's OWN Razorpay keys. LIVE round-trip on demo: disabled → API 503 +
  page notice → restored.
- Out of scope, scheduled: the actual Shopify-hosted checkout adapter + offer
  compilation to provider discounts (gated on the external authorization
  decision, per the locked S-roadmap choice).

### BE07 — Promotion compiler · **partial (simulator + schedules verified, S32)**

- Deterministic sample-cart SIMULATOR (`lib/offers/simulate.js` + POST
  /api/admin/offers/simulate + the "Test on a sample cart" panel in the offer
  form): validates the candidate, runs the pure engine alone AND combined with
  the live offers on three canned baskets, and explains non-application and
  combination conflicts (one-coupon-per-cart etc.) in plain notes.
- Timezone-safe schedules: the UTC-drift quirk is dead — `lib/admin/schedule.js`
  converts local wall time ↔ UTC instants properly (round-trip identity is
  suite-proven, TZ-independent) and derives the lifecycle status
  (draft/paused/scheduled/active/expired) shown as chips in the console.
- Typed rules + validation existed (S19, `OFFER_INVALID` with named errors);
  compilation TO PROVIDER discount functions is deferred with the shopify
  checkout mode (recorded).

### SF06 — Cart · **partial (fixes implemented & verified, S32)**

- Price/stock changes are ACKNOWLEDGED: `cart_items.price_at_add` (migration
  0004) remembers what the shopper saw; `getCart` returns `changes[]`
  (price_changed from→to, unavailable) while totals always use the CURRENT
  catalog price; the drawer shows an amber notice. Duplicate `setQty` submits
  collapse to one state (suite-proven); gift eligibility recomputes on removal
  (suite-proven); checkout failures never clear the cart (clear happens only
  on success — unchanged, now stated in the UI copy).

### SF07 — Checkout handoff · **partial (direct-adapter states verified, S32)**

- Honest handoff states: `CHECKOUT_DISABLED` → "cart saved, nothing charged";
  expired cart session → recovery hint; Razorpay modal dismiss/payment-failed
  already reset cleanly (verified in code). The page itself gates on
  capability before rendering the form. Provider-handoff (Shopify checkout)
  states arrive with that adapter.

### MC14 — Offers · **partial (fixed & extended, S32)**

- TZ round-trip FIXED (quirk #5); lifecycle chips (draft/paused/scheduled/
  active/expired) in the list; sample-cart simulator panel in the form
  (alone + combined, explained). Draft→validated→active flow = validation on
  save (existing) + chips + simulator; provider capability display arrives
  with BE24/MC20 integration surfacing (S34 did connection state; discount
  compilation display is deferred with the shopify mode).

### MC22 — Commerce preferences · **partial (implemented, S32)**

- Settings → Commerce: checkout mode (explicit select, validated server-side,
  audited via the settings save), merchant timezone (IANA-validated), and a
  shopper-emails note (Shopify-native — no duplicate senders). Source-owned
  fields (prices/stock/tax/totals) labeled Shopify-owned. Currency remains
  catalog-derived display (read-only by construction).

### SF08 — Confirmation · **UPGRADED to "implemented" (S33: full fix on top of the S25 containment)**

- Guest proof v2: `2.<expEpochSecs>.<hmac-sha256 hex20>` over `orderId|exp`,
  keyed by the tenant's own link secret — scoped, EXPIRING (default 30d,
  `ORDER_LINK_TTL_DAYS`), tenant-bound, constant-time compared. Legacy bare-hex
  links keep working until 2027-01-31 (hard cutover constant), then die.
- Token-leak residuals CLOSED: `scrubTrackingUrl` strips `?t=` from tracker
  URLs/referrers, error reports, and CAPI `event_source_url` (defensively
  server-side too); `instrumentation.js` records paths without query strings;
  order/confirmation pages send `referrer: no-referrer`; a global
  `Referrer-Policy: strict-origin-when-cross-origin` header ships from
  next.config. LIVE: v2 link 200, legacy link 200 (grace), junk/expired 404,
  header present. Remaining recorded fact: order ids stay ~32-bit — the proof,
  not the id, is the gate.

### SF24 — Consent settings · **partial (implemented & verified, S33)**

- Purpose-granular consent: Analytics (GA4) and Marketing (Meta) as separate
  choices; Allow all / No thanks / Settings toggles; essential labeled
  always-on; persistent "Privacy" reopen chip; versioned cookie
  (`{"v":2,"a","m","at"}`, legacy values parse). A saved CHANGE reloads so tags
  re-evaluate — withdrawal stops client tags immediately and (via the stored
  snapshots) server forwarding per purpose. gtag loads only with analytics,
  fbq only with marketing.
- Remaining: geo-sensitive banner variants + policy-page linkage copy (W3
  content pass).

### BE20 — Analytics event contract · **partial (implemented & verified, S33)**

- Every stored event now carries `contract_version` + the consent purposes in
  force at collection (migration 0005); forwarding gates per destination
  against the EVENT'S snapshot (GA4⇠analytics, Meta⇠marketing; pre-v2 rows
  grandfathered as both — they only ever stored under full grant). Collector
  hardening: `scrubPiiParams` strips email/phone-looking param values; name
  whitelist + event_id dedup already stood. LIVE: a collector probe with an
  analytics-only cookie stored `{"v":2,"a":1,"m":0}` + contract 2.
- Remaining: coverage measurement + distinct denominators (BE21/MC17, W4).

### BE18 — Privacy lifecycle · **partial (core implemented & verified, S33)**

- Shopify's mandatory compliance topics flow through the durable inbox into
  `lib/privacy.js`, each recorded as a `privacy_requests` row (migration 0005):
  data_request → recorded `manual` + warn alert (automated export lands with
  MC25/W4); customers/redact → EXECUTED — order PII + snapshot contact/address
  scrubbed with `redacted_at` set, money/order/sync fields retained (documented
  financial-records retention exception), matching event rows deleted
  (order+cart match, email case-insensitive, phone by last-10-digits),
  idempotent on replay; shop/redact → recorded `manual` + CRITICAL alert
  (tenant disposal stays a deliberate operator action, BE29).
- USER ACTION (deploy checklist): set the three compliance webhook URLs for
  each custom app in the Shopify Dev Dashboard → `https://<platform>/api/
  shopify/webhooks` (they are not subscription-API topics).
- Remaining: retention-policy table + request-tracking UI (MC25/OP11, W4);
  consent-version records per policy text revision (W3 content pass).

## Verification state (S33, 2026-10-28)

20 suites / **253 tests + 21 offers = 274 checks** green (new `test:privacy`,
11; `test-events` fixtures now run the migration ledger — the new event
columns caught another raw-schema fixture, same class as S32's; boundary-suite
token shapes updated to v2); build clean. Hosted: 0005 applied to all 3 tenant
DBs. Live: v2/legacy/expired token matrix on the real cancelled order,
Referrer-Policy header on every response, collector probe stored the purposes
snapshot + contract version (cleaned up after).

## Verification state (S32, 2026-10-28)

19 suites / **242 tests + 21 offers = 263 checks** green (new `test:commerce`,
10; `test-tenancy` fixtures now run the migration ledger on top of the raw
baseline — the new cart column broke its raw-schema DBs, which is exactly the
drift the ledger exists to prevent); build clean. Hosted: 0004 applied to all
3 tenant DBs; live gate round-trip on demo (API 503 CHECKOUT_DISABLED + page
notice + restore); cart price_at_add verified stored on a real beastlife
variant. Simulator case-sensitivity bug (uppercase offer types) caught by the
suite and fixed before ship.

## Verification state (S31, 2026-10-28)

18 suites / **232 tests + 21 offers = 253 checks** green (new
`test:order-projection`, 11); build clean. Hosted: 0003_order_projection
applied to all 3 tenant DBs via the ledger; live reconcile of the cancelled
probe order (voided + mirrored ₹0 restock refund); status page 200 showing
CANCELLED without a spurious refund banner; admin orders page 200.
`lib/shopify-order-status.js` (live-fetch helper) removed — the projection +
background refresh replaced its only consumer.

## Verification state (S30, 2026-10-28)

17 suites / **221 tests + 21 offers = 242 checks** green (new
`test:sync-generations`, 8); build clean. Hosted: `tenant:migrate --all`
applied 0002_sync_runs to all 3 tenant DBs via the ledger; live beastlife full
sync pruned 7+4 ghosts (sync_runs row complete, cursor recorded); storefront
200 and health unchanged after the prune. `pnpm sync`/`tenant:sync` now run
the migration ledger instead of raw schema applies.

## Verification state (S29, 2026-10-28)

16 suites / **213 tests + 21 offers = 234 checks** green (new `test:jobs`, 12;
`test-platform-ops` alert assertion updated for severity prefixes); build
clean. Hosted control plane migrated (0003_jobs — ledger correctly recorded it
as the only new file). Live: tick endpoint drained a REAL COD probe order's
durable jobs (`shopify_push` + `forward_event`, ran 2 / failed 0), health
rollup showed the queue section, OP05 API listed the done jobs and ran an
operator tick, alert self-test reported its honest no-webhook failure; probe
order BL-29E6DDA5 cancelled on both sides afterwards.

## Wave W1 — EXIT (S25–S28, 2026-10-28)

Handoff exit evidence for W1 ("fail-closed hosts, memberships, sessions,
secrets and migrations; two-tenant negative tests; no default-store leak;
revocation enforced"):
- Two-tenant negative matrix: overlapping-handle isolation (S25 boundary
  suite), cross-tenant session rejection + spoofed-tenant denial (S26/S27),
  cross-tenant order-token rejection (S25), domain takeover block (S28).
- No default-store leak: unknown/suspended/outage hosts fail closed at page +
  API level (S25 curl matrix); cron/job env-default runs gated (S25).
- Revocation enforced server-side: sessions (S26 HTTP), memberships mid-session
  (S27), invitation single-use + no-burn-on-wrong-host (S26).
- Secrets: key-versioned, rotation drill green end-to-end (S28).
- Migrations: ledger live on the control plane + all tenant DBs (S28).
- Checks: 15 suites / 201 tests + 21 engine = 222, build clean.
STILL PENDING before deploy checkpoint A (user-gated): set PLATFORM_* env in
Vercel, run platform+tenant migrations there, register webhooks, create real
owner/operator accounts (bootstrap passwords retire per surface), rotate the
S22 throwaway console passwords, HTTP-probe legacy + outage modes on staging.

## Baseline checks (S25, before changes)

Commands: `pnpm test:orders|shipping|shopify-push|hardening|offers-admin|events|
tenancy|platform-sync|admin-console|cms|platform-ops`, `node scripts/test-offers.js`,
`pnpm build`.

Results (2026-10-28, before changes): all green — orders 18, shipping 12,
shopify-push 13, hardening 11, offers-admin 8, events 16, tenancy 9, platform-sync
13, admin-console 9, cms 10, platform-ops 8 (= 127), offers standalone 21
(= 148 total), `pnpm build` exit 0.

## Other records

All remaining 113 records: **not inspected** (states will change only with code
audits/implementation in their scheduled sessions; see roadmap phases S26–S49).
Incidental observations made during the S25 audits, recorded WITHOUT claiming a full
audit of those records:
- BE14: webhooks are processed in `after()` with no persisted receipt; `jobs/*`
  sweeps are the only retry path (supports the "Replace" label).
- BE19: `/api/health` exists with per-tenant + `?all=1` rollup; alerts via webhook;
  no queue-age metric yet.
- BE17: schema applied as one-shot `lib/schema.sql` / `lib/platform/schema.sql`
  (no migration ledger).
- BE13: secrets AES-GCM encrypted under a single `PLATFORM_SECRET` (no key
  versions; rotation can orphan ciphertext — matches the handoff's defect note).
- MC14/BE07: offer schedules stored as naive local instants (UTC drift quirk,
  platform-guide §2F) — scheduled S32.
- MC15: editing a disabled placement re-enables it (quirk) — scheduled S39.
- Rate limiting is per-isolate in-memory (`lib/rate-limit.js`) — distributed limits
  arrive with BE02/BE34.
- Unmapped hosts share the `_default` rate-limit bucket; after S25 the gate rejects
  before the rate limiter, so the shared bucket no longer matters for gated hosts.
- `scripts/tenant-sync.js` / `scripts/register-webhooks.js` call `getTenant`
  without a status check (CLI-only; S25 gates `runAsTenant` but these two use
  `getTenant` directly) — tidy-up scheduled with BE26 (S41).
- Static `/_not-found` prerender and `app/robots.js` carry build-origin values —
  same class as the manifest quirk, W3 (S36).

## Verification state (S25, 2026-10-28)

**Suites after changes — all green:** the 11 pre-existing suites (platform-ops now
9 after the empty-registry test split into configured/legacy variants) + the NEW
`pnpm test:tenant-boundary` (24 tests: resolution outcomes incl. overlapping-handle
isolation via two unrelated fixtures `alpha`/`beta` sharing handle `signature-tee`;
cold/warm control-plane outage with the `PLATFORM_STALE_MS` budget; GATE mapping;
`runAsTenant`/`forEachActiveTenant` gates; order-token scheme incl. cross-tenant
rejection) = **152 suite tests + 21 offers-engine assertions = 173 checks**;
`pnpm build` exit 0.

**HTTP-level curl matrix against `pnpm dev` (hosted dev control plane, platform
mode; curl with Host override — node fetch strips the Host header):**
- Unknown host `/` → **404**, neutral shell: 0 hits for beastlife/gtag/fbq/
  serviceWorker, title "Page not found", body "Store not found".
- Unknown host `/products/<real-handle>` → neutral 404 content, zero product data
  (HTTP 200 shell — Next streams before `notFound()`; documented repo gotcha).
- Unknown host `/api/cart`, `/api/search`, `/api/admin/login` → **404
  `TENANT_UNKNOWN`** (admin login unreachable on unmapped hosts).
- Suspended tenant (demo suspended via control plane, then reactivated): `/` →
  404 page "Demo is temporarily unavailable" (control-plane name only, 0 beastlife
  hits); `/api/cart` → **503 `TENANT_SUSPENDED`**. Reactivation → 200 demo home.
- Known host regression: beastlife `/` → 200 with BeastLife chrome; `/api/health`
  → 200 (degraded = known dead Typesense).
- `/api/health?all=1&secret=…` from an UNKNOWN host → 200 rollup (3 tenants);
  plain `/api/health` on the unknown host → 404 `TENANT_UNKNOWN`.
- `/api/jobs/sync-shopify` POST on an unknown host without `body.tenant` → **400
  `TENANT_REQUIRED`** (no silent env-default run).
- SF08 end-to-end with a REAL COD probe order (BL-1F49D0E4, snehal@mediastic.in):
  `/api/checkout` response carried `confirmationPath …?t=<20 hex>`; with token →
  200 full confirmation; without / wrong token / unknown id → 404 with **zero PII
  bytes** in the response (only the static "Order confirmed" `<title>` string
  flushes); `/orders/<id>?t=` regression → 200. Probe order then cancelled on BOTH
  sides (`order:cancel`: Shopify order 7334354878681 cancelled+restocked, local
  sync_failed → cancelled). Incidental: the push hit the designed
  `RECONCILE_MISMATCH` guard (Shopify-side total drift on the dev store) — the
  guard refusing to complete is correct behavior, unrelated to this slice.

**Suite-level only (not probed over HTTP — would require dev-server restarts with
altered env):** legacy mode end-to-end (PLATFORM_DB_URL unset; covered by the
boundary suite's legacy tests + unchanged production build) and the
control-plane-outage 500-page/503-API rendering (outcome + GATE mapping covered by
the suite; `tenantHandler`/`tfetch` wiring is the same code path the other probes
exercised). Recorded as pending HTTP-level verification at deploy checkpoint A.

## Verification state (S26, 2026-10-28)

**Suites:** 13 aliased / **173 tests + 21 offers = 194 checks**, all green;
`pnpm build` exit 0. New `pnpm test:identity` (21): scrypt roundtrip + rejects,
session create/verify/expire/revoke (fresh-lookup revocation), disabled-user
kill, membership isolation (cookie from tenant A rejected on tenant B),
bootstrap→account flip, legacy mode, operator bootstrap flip, merchant-session-
on-operator-route rejection, TOTP RFC 6238 vector (T=59 → 94287082) + window +
encrypted-at-rest, invite accept/single-use/wrong-tenant-does-NOT-burn-token/
expired, reset (password set + all sessions revoked + single-use), distributed
throttle (block/clear/window-reset), sameOrigin matrix.

**Bug found & fixed during HTTP verification:** `consumeInvite` originally
stamped `accepted_at` BEFORE the tenant check — a wrong-host acceptance attempt
burned the invitation. The tenant check now lives inside the UPDATE's WHERE
clause; regression test added, re-proven over HTTP.

**HTTP matrix (dev server, hosted dev control plane; throwaway probe users
created on the demo tenant and DELETED after, restoring both bootstrap logins —
verified 200 post-cleanup):** email login 200 + cookie reaches settings; wrong
password 401; legacy password refused with "Sign in with your email and
password" once a user exists; beastlife (no users) still accepts its bootstrap
password; cross-origin login 403 BAD_ORIGIN; logout → old cookie 401 (server
revocation); recover → mock-mail reset link (dev-server log) → reset 200 →
pre-reset session 401 + old password 401 + new password 200 + token replay 400;
invite: wrong-tenant host 400 with token intact, right tenant 200 + auto
sign-in + settings 200, replay 400; operator: legacy login 200 pre-operator →
create operator → legacy 401 → first login returns enroll handshake (secret +
otpauth) → TOTP-confirmed login 200 → operator cookie reads /api/platform/
tenants 200 while a MERCHANT cookie gets 401 → passwordless/code-less login 401
(MFA mandatory).

**Migration/config:** `pnpm platform:migrate` applied the 5 new tables to the
hosted dev control plane (idempotent CREATE IF NOT EXISTS; prod/staging get it
at deploy checkpoint A). New optional env: `RESEND_API_KEY` + `MAIL_FROM`
(mail is a labeled console mock until set). USER ACTION when ready: create real
accounts — `USER_PASSWORD=… pnpm user:create -- --tenant beastlife --email you@…
--role owner` per tenant and `pnpm operator:create -- --email you@…` (each
switches that surface off its bootstrap password).

## Verification state (S27, 2026-10-28)

**Suites:** 14 aliased / **186 tests + 21 offers = 207 checks**, all green;
`pnpm build` exit 0. New `pnpm test:authz` (13): role matrix, requireAdmin
(owner write ok · support 403-on-write/ok-on-read · staff blocked from
settings/push/sync · cross-origin write 403 while reads pass · no-cookie 401),
spoofed-tenant denial (tenant-A session 401 on tenant-B host), instant
revocation mid-session, final-owner demote+remove blocked until a second owner
exists, audit scoping/default-tenant-context/redaction/size-cap/append-only
surface/never-throws.

**HTTP matrix (dev server; throwaway owner+support users on demo, DELETED
after, bootstrap login verified restored 200):** support → offers GET 200,
offers POST 403 "Your role (support) can't do that", settings GET 403, audit
GET 403, sync POST 403; owner → offer write path reachable (422 on an invalid
probe payload = authz passed, validation spoke), audited DELETE 200,
cross-origin POST 403; `GET /api/admin/audit` returned the trail:
offers.write[offer:s27-probe] · auth.login ×2 · team.role_set ×2 (cli).
CLI final-owner guard: `member:set --remove`/demote on the lone owner both
refused with the guard message. `pnpm platform:migrate` applied `audit_log`
to the hosted dev control plane. Probe audit rows remain in the log by design
(append-only; they record exactly what happened).
