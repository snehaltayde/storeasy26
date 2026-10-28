# Storeasy SaaS — implementation status

Tracking file required by `Storeasy_Claude_Developer_Handoff.md` §6 and
`CLAUDE_START_PROMPT.txt` step 3. States: **not inspected** · **verified complete** ·
**partial** · **missing** · **blocked**. A state other than "not inspected" is backed
by a code audit or implementation in this repo — never by documentation alone.

- Created: 2026-10-28 (session S25). Last updated: S43 (W1+W2+W3 complete; W4 underway).
- Roadmap: all 116 records are phased S25–S49 in the approved plan
  (`~/.claude/plans/lively-moseying-bunny.md`); waves per the handoff.
- **Audit coverage honesty:** 83 of 116 records audited/implemented so far
  (BE01, SF23, SF08 — S25; BE02, MC01, OP01 — S26; BE03, BE16 — S27;
  BE13, BE17, BE12 — S28; BE14, BE19, OP05 — S29; BE04, BE25 — S30;
  BE10, BE36, SF09, MC16 — S31; BE06, BE07, SF06, SF07, MC14, MC22 — S32;
  BE18, SF24, BE20 — S33, with SF08 completed; BE24, MC20, BE27, BE34,
  OP10 — S34; BE08, MC10 — S35; BE09, MC13 — S36, with SF23 completed;
  MC07, MC08, MC09, OP07 — S37; SF01–05, SF13, SF14, BE05, BE15,
  MC12 — S38; SF15, SF16, SF17, MC05, MC06, MC11, MC15, BE23 — S39;
  BE11, BE33, MC24, OP08 — S40; BE26, MC02, MC03, OP03, OP04 — S41;
  BE21, MC04, MC17, OP02, OP06, BE35 — S42; MC21, MC23, MC25, MC26, MC27,
  OP11, OP12, BE29 — S43). The other 33 are **not inspected** — the
  handoff's Fix/Extend/New labels for them remain unverified documentation
  claims.

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

### BE24 — Provider integration registry · **partial (implemented & verified, S34)**

- `lib/integrations.js`: one registry over shopify/razorpay/ga4/meta/typesense/
  mail — connection state from PRESENCE flags + metadata only (store domain,
  scopes, key mode from prefix, checkout capability, last webhook via
  `webhook_inbox`, last forward via event sent-stamps). Secret values never
  serialize. `testIntegration` = side-effect-free live probes (Shopify `{shop}`
  gql, Razorpay auth'd GET, Typesense `/health`, mail self-test to Resend's
  sink; GA4/Meta honestly report that no safe test exists). `revokeIntegration`
  nulls that provider's tenant keys via `patchTenant`, audited
  (`integration.revoke`), refuses the env-fallback tenant.
- LIVE (beastlife): registry GET rendered all six cards; shopify test →
  "connected to Beastlife (beastlife-dev.myshopify.com)", razorpay →
  "credentials valid (test mode)", typesense → honest "fetch failed" (cluster
  dead, known), ga4 → honest no-test message.
- Remaining: revoke should also pause queued jobs that use the provider
  (today jobs fail cleanly and dead-letter — acceptable, noted); connect flows
  stay in Settings/OAuth (MC20's connect buttons are hints, not flows).

### MC20 — Integrations tab · **partial (implemented & verified, S34)**

- `/admin/integrations` (new nav tab): provider cards with status dots,
  LIVE/test chips, uninstall markers, Test/Revoke buttons (revoke = confirm
  dialog + settings.write + audit; test = settings.read), per-provider
  messages, honest empty/error states. Secrets presence-only by construction
  (BE24 registry).
- Remaining: last-event freshness per provider beyond webhooks/forwards
  (needs BE21 coverage rollups, W4).

### BE27 — Backup & restore drill · **partial (drill implemented & run, S34)**

- `scripts/restore-drill.js` (`pnpm restore:drill -- --tenant <slug> |
  --control-plane [--keep]`): logical restore of the HOSTED DB into an isolated
  local file, then integrity verification — per-table row counts vs source,
  migration-ledger ids+checksums, order money totals (Σtotal), secret-envelope
  ciphertext lengths, PRAGMA foreign_key_check + integrity_check.
- RUN 2026-10-28 (evidence): demo tenant — 21 tables / 13,579 rows restored in
  1.4s, all checks green, ledger 0001–0005 intact, newest order timestamp
  captured as RPO evidence. Control plane — 12 tables / 40 rows in 0.4s,
  ledger 0001–0004 intact, tenant secret envelopes byte-length-identical.
- RTO at current scale: seconds (logical). RPO: Turso continuous replication;
  PITR clone (`turso db create <new> --from-db <db> --timestamp <iso>`) is the
  production path — paid-plan feature, documented in platform-guide §5.3b, not
  exercised against prod from sessions (user-gated).
- Remaining: scheduled automatic drill (cron job post-deploy), PITR exercise
  on a paid plan.

### BE34 — Security release gate + threat model · **partial (implemented & verified, S34)**

- `scripts/test-security.js` (13 tests, part of the pre-commit baseline):
  static gates (live-credential literal scan over all tracked files; `.env*`/
  `*.db` gitignore + tracked-file check; "use client" components can never
  import server secret accessors; no API route serializes process.env) +
  dynamic abuse (normalizeHost SSRF rejections, webhook-HMAC forge/tamper/
  length-mismatch matrix, OAuth-state tamper/expiry/cross-secret,
  support-grant TTL clamp + fresh expiry/revocation + read-only role matrix +
  audit trail).
- `docs/security-threat-model.md`: assets, trust boundaries → mitigations
  mapped to modules/suites, residual risks stated honestly (top item: stored
  XSS posture of `description_html`/CMS rich text — sanitization lands with
  BE08/S35; CSP follows it).
- Remaining: CSP headers (post-BE08), log-PII audit sweep automation,
  dependency audit cadence.

### OP10 — Operator support access grants · **partial (implemented & verified, S34)**

- Control-plane `support_grants` (migration 0004, applied hosted): id, tenant,
  operator, reason (min 5 chars enforced), created/expires/revoked. TTL
  clamped 1–72h (default 4). Creation + revocation audited. `activeSupportGrant`
  is a FRESH lookup per request — no cache window after revoke/expiry.
- Entry path: `adminActor` in `lib/admin-auth.js` — merchant session first,
  bootstrap second, then operator `_platform` cookie + active grant → actor
  `{kind:"operator-support", role:"support"}`. Support is read-only
  (`roleAllows` denies every write + settings.read) and PII-redacted (S31
  order views). Merchant-visible amber banner on every `/admin` page
  (`app/admin/layout.js`) with operator, reason, expiry.
- Surfaces: `pnpm support -- grant|revoke|list` CLI +
  `GET/POST /api/platform/support` (operator cookie + sameOrigin).
- LIVE HTTP matrix (demo tenant, dev server): grant via CLI → operator cookie
  read `/api/admin/orders` 200 with `"email":null …"pii_redacted":true`;
  offers POST → 403 "Support access is read-only"; banner string rendered in
  `/admin` HTML; same cookie on beastlife (no grant) → 401; support API GET
  listed the grant, 401 without cookie; revoke via API → `{ok:true}` and the
  very next demo request → 401; banner gone.
- Remaining: /platform console UI panel for grants (CLI+API only today, W4
  polish); real operator accounts replace the bootstrap token at cutover.

### BE08 — Content & template service · **partial (core implemented & verified, S35)**

- Versioned component schemas: `lib/cms/schemas.js` registry (every block kind
  + the page schema carry a version with a lazy `migrate` hook; writes stamp
  `schema_version`, reads upgrade through `upgradeBlock`). Draft-revision
  safety: migration tenant/0006 adds `revision` to cms_blocks/cms_pages;
  writes are compare-and-swap on the revision the editor loaded —
  `CmsConflictError` → HTTP 409 carrying the server's current row, BOTH
  versions preserved (server keeps its row, editor keeps the unsaved form;
  a deliberate second save overwrites). Content resolution order documented
  and enforced: platform defaults → theme kit (S37) → tenant tokens →
  template (S37/MC09) → tenant content rows.
- **Sanitization (BE34 residual CLOSED):** `lib/sanitize.js` — edge-safe,
  dependency-free allowlist sanitizer (script/style/iframe dropped WITH
  content, event handlers stripped, javascript:/data: URLs rejected incl.
  entity-encoded, target links get `rel=noopener`); applied at render to
  Shopify `description_html` on the PDP. CMS page bodies render as plain
  text (no sink).
- LIVE (demo over HTTP): pre-S35 hero row at revision 0 → "expect to create"
  rightly 409'd with the server version in the payload; create → rev 1,
  save-with-rev → rev 2, stale save → 409; PDP renders sanitized markup.
- Remaining: immutable releases + publish/rollback (BE09/S36), templates &
  assignments (MC09/S37), rich-text CMS fields (sanitizer ready), CSP headers.

### MC10 — Brand system · **partial (implemented & verified, S35)**

- `/admin/brand` tab + `config.brand` tokens: ONE accent → derived 50–900
  ladder (lightness interpolation anchored at the picked color; strictly
  monotonic — property-tested across extreme picks), background/foreground,
  radius sm–xl, type scale. WCAG AA gate: body-text contrast < 4.5:1 BLOCKS
  the save (server-side); low-contrast accents warn; button label color
  (`accent-label`) computed against the actual button surface. Reset-to-theme.
- Delivery: root layout emits one `<style id="brand-vars">` CSS-variable
  block (validated values only); ALL storefront components swept from
  hardcoded lime classes to `accent-*` utilities mapped via Tailwind v4
  @theme. No tenant row → no override emitted (defaults in globals.css =
  byte-identical pre-S35 look). Admin console deliberately keeps platform
  styling.
- LIVE: contrast gate 422 with the computed ratio; demo saved navy
  `#1e3a8a` → home serves the navy variable block and renders fully
  re-skinned (white button labels — auto-flipped), beastlife unchanged lime
  (zero brand-vars in its HTML) — tenant differentiation proven visually,
  side by side.
- Remaining: logo/favicon upload (needs BE15 media pipeline, S38), approved
  font pairs (next/font loading lands with theme kits, S37).

### BE09 — Immutable releases & publishing · **partial (core implemented & verified, S36)**

- Releases = frozen snapshots of the content set (cms blocks + pages + brand
  tokens), canonically serialized (sorted-key stringify) and sha256
  content-hashed; `release_state` is the single live pointer — publish and
  rollback are ONE atomic UPDATE and never touch drafts (migration
  tenant/0007, applied hosted ×3). Storefront serves the live release via
  `lib/content/resolve.js` (layout, home, content pages, sitemap, brand);
  pre-first-publish stores serve drafts exactly as before.
- Signed expiring previews: 1h tenant-bound HMAC token → `/api/preview` sets
  an httpOnly cookie + 302 (purple "Draft preview" banner; preview content
  never sits behind a shareable/cacheable URL). Scheduling: release created
  and validated at schedule time, pointer flip runs as a durable
  `publish_release` job at the merchant-local-converted UTC instant. Publish
  validation blocks on: missing hero title, zero enabled home sections, brand
  WCAG failure, internal links to catalog entries that don't exist; unknown
  internal paths warn. Publish/schedule/rollback audited.
- LIVE (demo over HTTP): first release published → draft hero edit did NOT
  change the shopper page; preview cookie flow showed the draft (banner
  included) while a cookieless request kept the release; second publish went
  live and rollback restored release 1 instantly with drafts preserved.
- Remaining: pinned theme/template deps in the snapshot (S37), content-hash
  shown in MC26 audit UI (W4), CSP pass.

### MC13 — Releases tab · **partial (implemented & verified, S36)**

- `/admin/releases`: live-vs-draft state (hash comparison → "unpublished
  changes" chip), blocking validation list, publish-now with note, schedule
  (datetime-local converted in the BROWSER so the merchant's timezone decides
  the instant), draft preview (opens in a new tab), history with per-release
  hash prefix + LIVE chip + "Roll back to this" (confirm). Draft stores
  without a release say so honestly. Storefront/Brand save messages now point
  at the Releases tab.
- Remaining: per-release content DIFF view (what changed between hashes), W4.

### SF23 — Branded system pages · **complete for current scope (S36; core was S25)**

- Per-tenant PWA surface: `app/manifest.webmanifest/route.js` (name,
  short_name, tagline, theme/background colors from the LIVE release brand)
  and `app/offline/route.js` (self-contained branded offline shell — inline
  CSS, zero app chunks) replace the static BeastLife files; sw.js v2 uses
  neutral `storeasy-*` cache names and precaches the dynamic routes, so each
  tenant ORIGIN caches its own branding at install. 404 is tenant-branded
  (store name + accent tokens); gated hosts keep the S25 neutral shell.
- LIVE: beastlife manifest says BeastLife; demo manifest says "Storeasy Demo
  Store" with navy theme `#0b1738`; demo /offline carries its name + navy;
  404 renders "This page isn't on Storeasy Demo Store's shelves" vs
  BeastLife's on the other host.
- Deferred (recorded): shared icon set until BE15 media uploads (S38);
  merchant-togglable MAINTENANCE mode → OP12 (W4) where incident/maintenance
  states get their operator workflow (suspended hosts already show the
  control-plane-named unavailable page, S25).

### MC07 — Theme kits · **partial (implemented & verified, S37)**

- `lib/themes/kits.js`: versioned kit registry — **Pulse** v1 (the original
  dark/lime nutrition look, implicit default) and **Glow** v1 (beauty: light
  surfaces `#fffbf7/#fff1ee`, Fraunces serif display, rose `#e11d48`, xl
  radius). Kit = brand defaults + display font + surface CSS
  (`[data-kit="<id>-<version>"]` blocks) + hero preset. `applyKit` pins
  `config.theme`, seeds brand + hero as DRAFTS, never touches the live
  pointer; the pin rides the release snapshot (kit switches are
  draft-until-publish, previewable, rollback-safe). `/admin/theme` library
  tab with per-kit preview card.
- LIVE (demo): applied Glow → live home stayed `pulse-1` ("Demo picks");
  preview cookie showed `glow-1` + "Your glow, daily."; published → shopper
  home now full Glow (cream header, rose accent, serif hero — screenshot
  verified) while beastlife renders Pulse untouched. Two kits, two verticals,
  one codebase.
- Remaining: more surface coverage per kit (footer, PDP accents beyond
  tokens), kit thumbnails from real screenshots, a third kit when a real
  vertical needs it.

### MC08 — Visual editor · **partial (section editor implemented & verified, S37)**

- Home page is now a composable section TREE: collections grid / newest
  products / **banner** (accent CTA panel) / **rich_text**
  (allowlist-sanitized at save — same sanitizer as PDP). Editor
  (`components/admin/SectionsEditor.js`): add/duplicate/hide/remove,
  keyboard-reachable reorder, undo/redo (30-step history), debounced
  AUTOSAVE with honest indicator, 409 conflict surface with
  reload-or-overwrite. **Draft preview pane** iframes the real storefront
  through the S36 preview cookie at 375/768/full widths — real catalog, cart
  and offer bindings, not a mock.
- Remaining (recorded honestly): drag-drop reordering, per-section live
  highlight in the preview, section kinds beyond these four, PDP/collection
  layout editing (needs their template families, W4+).

### MC09 — Templates & assignment · **partial (content-page family, S37)**

- `lib/content/templates.js` (pure data): blank / FAQ / brand story /
  how-to-use — "New page from template" prefills the page editor; Clone
  copies any page to `<slug>-copy`. Suite proves every template passes
  upsert validation.
- Remaining: collection/PDP template families + ranked-rule assignment —
  there is nothing to bind rules to until those page types have variants;
  deferred with W4's merchandising work, recorded as the larger half of MC09.
- S38 addition: "Privacy policy" and "Terms & refund" templates joined the
  set (SF14's scaffolds, since defaults never cross tenants).

### SF01 — Home · **verified complete (S36–S38)**

- Hero, announcement, nav and the composable section tree all render from the
  release snapshot (drafts pre-first-publish); S38 adds the curated
  collections row (featured handles win over the size heuristic). Live-proven
  on demo (Glow) and beastlife (Pulse) through S36–S38 publishes.

### SF02 — Collection index · **verified complete (S38)**

- `collections_index` block ({featured ≤6, order, hide}; null = catalog-
  derived): /collections renders featured-with-badge first, then the explicit
  order, then the rest alphabetically; hidden handles never render; the home
  Collections row uses the featured list. Release-governed; publish validation
  blocks handles missing from the catalog. Admin: Storefront → Collections
  index. Suite: validation (bad handle, featured∩hidden, dedupe), order
  preservation, release gate. Live: demo publish showed the badge on
  `3-kg-mass-gainer` only after the pointer flip.

### SF03 — Collection detail · **verified complete (S38)**

- URL-backed `?sort=featured|new|price-asc|price-desc`, `?type=` chips with
  counts (facets computed unfiltered so siblings stay visible), `?instock=1`,
  composable with pagination; back/forward/share restores the exact view
  (filters are links; only the sort select is client-side). Zero-results
  state carries Clear-all. Canonicals ignore filter params. Suite: sort
  orders, in-stock totals, type filter, facet ranking. Live: price-asc +
  in-stock verified ascending on demo.
- Not built (recorded): price-range slider, variant-level filters — add if a
  merchant asks; the URL contract extends cleanly.

### SF04 — Product detail · **partial (S38: global modules, sticky CTA, variant states)**

- `pdp_extras` block → sanitized accordions under every description;
  sticky mobile CTA (IntersectionObserver on the main add button; fixed
  bottom bar with title/price/add/view-cart, lg:hidden); invalid-variant
  feedback (per-value existence/stock check against the current selection:
  struck-through "missing" vs "soldout" styling + an explicit "combination
  isn't available" notice replacing the old silent disabled button).
- Remaining (recorded): PER-PRODUCT vertical modules (ingredients/usage/
  specs) belong to MC05's catalog presentation overrides (S39) — a global
  block cannot honestly carry per-product ingredient data.

### SF05 — Search experience · **verified complete (S38)**

- Debounce (200ms) + AbortController stale-response cancellation (pre-S38),
  plus per-session recent searches (sessionStorage, shown on focus, Clear,
  storage-failure-safe) and full keyboard navigation (↑/↓ wraps, Enter opens
  the active row, Escape closes; combobox ARIA). Results dropdown = product
  suggestions with image/price/type. Generic placeholder (was BeastLife-
  flavored). /search page unchanged (grid + zero-results + analytics).

### BE05 — Search service · **partial (decision recorded + SQL engine upgraded, S38)**

- **Decision (no-spend default):** SQL over the tenant catalog IS the
  supported engine. Typesense stays an optional env-configured upgrade; the
  lapsed cluster's revival is a paid, USER-GATED call — nothing in the
  platform assumes it. `searchProductsInDb` upgraded to earn the role:
  multi-term AND across title/type/vendor/tags, deterministic ranking
  (in-stock → title-prefix → title-substring → rest, then title A–Z),
  term cap, like-escape. `/api/health` names the serving engine
  (`search.engine` + a note when Typesense is configured-but-dead) and a dead
  OPTIONAL Typesense no longer degrades health (the fallback is the engine).
- Remaining (Typesense-side, lands only with a revival): tenant-scoped index
  rebuild-into-new-collection + atomic swap, synonyms, lag surfacing to the
  merchant console.

### SF13 — Flexible pages · **verified complete (S38)**

- Typed page sections (page schema v2): text (heading+paragraphs), rich
  (allowlist-sanitized AT SAVE, 20k cap), image (https or `/api/media/…`,
  alt required, caption). v1 rows normalize lazily at read
  (`normalizePageSections`); slug/SEO-description/visibility already existed.
  Editor: per-kind add buttons + fields. Suite: sanitize, src/alt refusals,
  v1 normalization, snapshot round-trip.

### SF14 — Policy pages · **verified complete (S38)**

- Effective dates (`effective_at` column, YYYY-MM-DD validated, rendered
  "Effective from …"); checkout links the store's OWN enabled
  privacy/terms/refund/shipping pages beside the pay button; publish warns
  (not blocks) when a non-BeastLife store has no privacy or terms/refund
  page; legal templates scaffold them. **Cross-tenant legal text closed:**
  `brandDefaultsApply()` restricts the BeastLife-sourced default pages (and
  their sitemap/list entries) to beastlife/beastlife-staging/legacy-env —
  live-verified: demo's /policies/shipping 404s and its sitemap lists only
  its own pages while beastlife keeps serving all four.

### BE15 — Media pipeline · **partial (core implemented & verified, S38)**

- Tenant-bound by construction: admin-session-authed multipart upload →
  blob in the TENANT's own Turso DB (migration 0008); no external bucket or
  URL-signing infrastructure exists to misbind. Validation: mime allowlist +
  size caps (raster 1.5MB, svg 300KB), magic-byte sniffing (declared type
  must match bytes), SVG sanitizer at write (script/foreignObject/handlers/
  unsafe hrefs stripped) + no-script CSP + nosniff + inline disposition at
  serve. sha256 content dedupe (unique index per variant). Derivatives:
  client-side canvas thumb (≤480px webp) as a variant row — honest about the
  runtime (no native image codecs serverless); more sizes = same mechanism.
  Usage references scanned across draft blocks, draft pages, and the LIVE
  release; delete refuses while referenced (409 + list) unless forced, and
  the console warns immutable old releases keep their references.
- Remaining (recorded): video/document types, server-side derivative
  generation if a native-capable runtime ever exists, storage quotas
  (BE32/OP13 metering, W5), CDN offload if blob volume demands it.

### MC12 — Content & media library · **verified complete (S38, library scope)**

- `/admin/media` tab: multi-file upload with client-side thumb generation,
  dedupe notice, alt-text editing (blur-save), copy-URL, usage-guarded
  delete with the two-step force path, support-role read-only. The
  "content" half of MC12 (page/section browsing) lives in the Storefront
  tab (S37 editor + S38 typed pages) — recorded as satisfied across the two
  tabs rather than duplicated.

### BE23 — Notification service · **partial (core implemented & verified, S39)**

- lib/notifications.js is THE send path for tenant messages: durable intent
  rows (migration 0009), delivery via the jobs queue (`send_notification`,
  after() fast path, backoff retries), honest states queued|sent|failed with
  provider errors recorded and the unset-provider mock explicitly labeled
  DEV MOCK; idempotency-key dedupe; missing recipient = FAILED intent with
  an actionable error, never a silent drop. Consent separation at the
  schema: marketing class REFUSED without a consent reference. One owner per
  transactional message type (contact_message today). Recorded split:
  control-plane identity mail (invites/resets) stays on lib/mail.js —
  platform-scoped, no tenant DB for intents.
- Remaining: bounce/delivery webhooks from the provider (needs a real
  RESEND key + webhook endpoint — provider unconfigured by design until the
  user sets it), order-lifecycle messages (confirmation/shipped) migrate
  onto this service when the merchant asks for them, marketing sends (no
  marketing surface exists yet — the guard is ready).

### SF15 — Contact · **verified complete (S39)**

- Accessible form (labels, aria-describedby error list, honest idle→sending→
  received states), server validation (name/email/message with exact field
  errors), honeypot (bots get a bland 200, nothing stored), 5/hour per-IP
  rate limit. EVERY store gets a working contact page (renders with or
  without a content page — non-BeastLife tenants start page-less).
  Messages: stored in the tenant inbox + merchant copy through BE23 with the
  delivery state attached. Live on demo: valid stored+sent(mock), honeypot
  stored nothing, invalid 422 with field errors.

### SF16 — FAQ · **verified complete (S39)**

- `faq` section kind (questions + sanitized answers, validated at save) on
  any content page; native details/summary accordions (keyboard + SR for
  free), stable `#q-<slug>` anchors that auto-open and scroll on load and
  hashchange, ¶ copy-link per question. Reusable groups = FAQ sections are
  ordinary page sections (clone/template machinery applies). FAQ template
  upgraded to the new kind. Live: demo /policies/faq with working anchors.

### SF17 — Campaign landing · **verified complete (S39)**

- `family='campaign'` pages at `/campaigns/<slug>`: served ONLY inside their
  UTC visibility window (console edits in merchant-local wall time,
  converted to instants client-side — same TZ discipline as offers/release
  scheduling); noindex + excluded from the sitemap (paid/social
  destinations); internal links carry the visitor's utm_* params forward
  (strict utm_ allowlist; external links untouched); `view_campaign` joined
  the versioned event registry; campaign slugs never serve at /policies/.
  Release-governed (publish-with-dependencies = the release snapshot).
  Live: glow-days 200-with-utm-rewrite inside window, expired bye-days 404.

### MC05 — Catalog browser · **verified complete (S39)**

- /admin/catalog: search, Shopify-owned fields labeled read-only + deep link
  to Shopify admin; per-product presentation = PDP modules (the per-product
  ingredients/usage/specs SF04 deferred here; sanitized at save, ≤6) +
  badge (≤30 chars). Deleted-product guard: orphaned overrides flagged in
  the console, unknown products refused at write. Overrides are LIVE-ON-SAVE
  (catalog-adjacent like placements, deliberately outside releases —
  recorded). Live: badge + two modules on a demo PDP immediately after save.

### MC06 — Collection merchandising · **verified complete (S39, pinning scope)**

- Per-collection pinned products lead the "Featured" sort (CASE ordering in
  getProductsInCollection); pins are ownership-validated (must be members of
  the collection); empty pins restore Shopify's order exactly. Live: demo's
  performance-protein collection led by the pinned product over Shopify's
  first. Template assignment deferred with the template families (W4,
  recorded in MC09).

### MC11 — Menus & footer · **verified complete (S39)**

- Header nav: ONE level of nesting (validated — unsafe child URLs refused,
  two-level refused, ≤8 children), rendered as native details dropdowns
  (keyboard/SR-friendly, no client JS); console editor speaks indentation.
  Footer: flattens nested items and links ONLY to pages that exist on the
  store (the hardcoded /policies/* list 404'd on new tenants); about link
  hidden when no about page. Release validation checks child links. Live:
  demo dropdown DOM-verified (3 links), footer lists its 4 real pages.
- Not built (recorded): drag-drop tree editing — the indent syntax covers
  the one-level model; revisit if merchants ask for deeper trees.

### MC15 — Upsell manager · **verified complete (S39)**

- Quirk #6 closed: editing a disabled placement keeps it disabled (the API
  preserves stored state when the form omits `enabled`; suite round-trip).
  Availability-aware targets: the console strikes through sold-out/deleted
  targets with tooltips — an honest preview of exactly what the storefront
  renders (it skips them). Placement preview = that annotated target list.

### OP07 — Operator template registry · **partial (implemented & verified, S37)**

- `/api/platform/themes` + ThemesPanel in the platform console: kit catalog
  (id, version, vertical, supported schema range) and every tenant's pin
  (explicit vs implicit default, applied_at, upgrade-available flag).
  READ-ONLY by design — pins change only in the tenant's own console, so
  "pinned versions never silently overwritten" holds structurally; version-
  keyed CSS selectors extend that to styling. Kit fixtures are validated in
  `test:themes` (WCAG, preset validation, release validation, accent-label
  accessibility).
- Remaining: per-kit fixture SCREENSHOT diffs, a11y audit beyond contrast
  (focus order etc.) — W4 polish.

### BE11 — Billing (Razorpay Subscriptions) · **partial (core implemented & verified, S40)**

- Platform migration 0005: versioned `plans` (a change = version+1, old rows
  immutable for pinned subscribers), `subscriptions` (provider id, status,
  period, grace watermark), append-only `billing_events` ledger (signed
  amounts, provider-event-id dedupe), `entitlement_overrides`, `usage_events`.
  The platform bills from ITS OWN Razorpay account (PLATFORM_RAZORPAY_* env,
  separate from tenant checkout keys). Free plans activate locally; paid
  plans mirror into the provider lazily and return the authorization
  short_url; an unconfigured provider is an honest 503, never a mock.
  Webhook: HMAC fail-closed (401 live-verified) → inbox persist → jobs apply
  (billing_apply handler), with out-of-order watermark + terminal-state
  protection and refunds matched to charges by payment id.
- Pending external (tracked, not claimed): a real PLATFORM Razorpay account +
  webhook registration + one real authorize/charge/refund cycle — USER-GATED
  (money). Subscription CANCELLATION from the console is deliberately absent
  until then (provider action); plan changes today are free-plan switches.

### BE33 — Entitlements enforcement · **partial (core implemented & verified, S40)**

- Entitlements = pinned plan features ← time-limited reasoned operator
  override (per-field; expired overrides ignored). Every applied event
  pushes a SNAPSHOT into tenants.config.billing; lib/billing-state.js
  (edge-safe, pure) derives grace/degraded/quota states from it — zero
  control-plane calls on the shopper hot path. **Degraded = checkout pauses
  with honest copy; browsing/content/order-lookup stay live** (live-proven
  on demo: /api/checkout 503 with the copy while home/collections/search
  stayed 200; recovery within the resolver's 30s config cache). Grace
  default 7 days (PLATFORM_BILLING_GRACE_DAYS). Quotas: 80% pre-limit
  warning, over = warn-never-block (the orders metric counts the tenant's
  real orders table; usage_events carries other metrics idempotently).
- Deliberately NOT YET enforced (recorded): per-feature gating beyond the
  degraded-checkout rule (e.g. blocking campaigns on free) — lands with W4's
  onboarding work once plans are actually sold.

### MC24 — Billing tab · **verified complete (S40, current provider scope)**

- /admin/billing (settings-domain roles): status chip (incl. grace countdown
  + degraded explainer that names exactly what paused), plan cards from the
  versioned catalog, authorization link for pending provider subs, quota
  bars with warnings, charge/refund history from the ledger, operator-
  adjustment visibility. Shared view assembler (lib/admin/billing-view.js)
  keeps page and API identical. Legacy/env tenants get an honest
  "needs the control plane" state.

### OP08 — Revenue reconciliation · **verified complete (S40, subscription scope)**

- /platform → Billing & revenue: MRR (active subs at monthly-ized price),
  gross/refunds/net by month (straight SUMs over the deduped signed ledger),
  per-tenant subscription states (past-grace flagged degraded), exception
  queue (payment trouble, past grace, orphan events — orphans land in the
  ledger, never dropped), and entitlement overrides (set/clear, reasoned,
  audited, optional expiry). Merchant-order revenue reconciliation (the
  storefront side) is BE21/S42 — this view is the SUBSCRIPTION ledger.

### BE26 — Provisioning orchestration · **verified complete (S41, current scope)**

- runProvision: recorded steps (provision_runs rows — step states +
  NON-SECRET refs only; passwords/db tokens never persisted), resume skips
  done steps and each step verifies REAL state (no duplicate resources, no
  secret rotation — suite-proven by password equality across resume), db
  tokens re-minted on resume when lost (they're memory-only). Compensation
  is conservative: deregisters a run-created tenant (via cache-busting
  deleteTenant) + removes its Free subscription; NEVER deletes a database
  (left-in-place note recorded); done runs refuse compensation (offboarding
  = BE29/S43). **Neutral seeds — quirk #14 closed**: zero offers seeded;
  brand seed is opt-in for the BeastLife/env store only. New tenants start
  on the Free plan + an onboarding record. Live-drilled against the HOSTED
  control plane: fail-at-billing → resume → done → cleaned.
- Remaining (recorded): provisioning stays a synchronous recorded run (fits
  Vercel's 60s window today); moving steps onto the jobs queue is a scale
  follow-up, not a W4 need.

### MC02 — Onboarding checklist · **verified complete (S41)**

- /admin/setup: connect → catalog → brand → policies → billing → domain →
  preview → test order → launch. The first six DERIVE from real state (a
  reopened checklist can never lie); preview/test-order/launch are stored
  check-offs; **launch is server-gated** until everything above is done and
  stamps launched_at. Billing activation is its own explicit item (Free
  counts). Live: demo derives 5/9 honestly (connect/catalog/brand/policies/
  billing ✓, domain pending on localhost hosts, launch gated).

### MC03 — Store switcher · **verified complete (S41)**

- Header dropdown fed by /api/admin/stores: VERIFIED memberships only
  (control-plane rows for the signed-in user), active tenants only,
  bootstrap/legacy sessions get none. Switching navigates to the target
  store's own console host — admin sessions stay tenant-bound, nothing is
  shared across stores.

### OP03 — Tenant registry & detail · **verified complete (S41, detail scope)**

- Each /platform tenant row expands into GET /api/platform/tenants/[id]:
  lifecycle status, config summary (shop/site/checkout/theme), credentials
  as a PRESENCE MAP (values never leave the encrypted envelope), billing
  snapshot, onboarding progress (computed in-tenant, unreachable-DB safe),
  provisioning history. Lifecycle workflows = existing suspend/activate +
  the new provisioning resume/compensate; richer flows (offboard) are BE29.

### OP04 — Provisioning jobs UI · **verified complete (S41)**

- /platform Provisioning-runs panel: per-step chips with failure details,
  Resume (idempotent tail re-run; surfaces a once-only generated password
  when registration happens on resume), conservative Roll-back with
  confirm. Done runs are history, not buttons.

### BE21 — Reporting rollups · **partial (core implemented & verified, S42)**

- lib/reporting.js: sales from the orders ledger (sale statuses = money
  committed), refunds from the S31 provider-mirrored projection, day buckets
  in the MERCHANT timezone (suite proves 19:00 UTC lands on the next IST
  day); freshness watermarks; coverage (% pushed to Shopify, % of sales the
  consented event stream sees); discrepancy queue (dead pushes, stuck
  pushes, refund mismatches — each with an action). Honest unknowns: nulls
  with reasons, never fake zeros. Live on beastlife's real data: 120d = 15
  orders / ₹1,01,070 net; the queue surfaced the 9 known dead pushes.
- Remaining (recorded): a true order-by-order reconcile AGAINST Shopify's
  API (ours reconciles against the webhook-mirrored projection); MRR
  movement classification (new/churn/expansion) — the ledger has the data,
  the rollup lands when there are real subscriptions to classify.

### MC04 — Merchant dashboard · **verified complete (S42)**

- /admin/dashboard is the console landing page: today/7d/30d net + orders +
  AOV, freshness + coverage chips, needs-attention queue (discrepancies w/
  actions, failed contact deliveries, unfinished setup), 30-day bar chart.
  Unknown renders as "unknown"/null copy, never 0.

### MC17 — Analytics tab · **verified complete (S42, current event scope)**

- Funnel (consent-badged), top products (order snapshots — not consent-
  limited, says so), search terms with zero-result flags, campaigns by
  utm_source, coarse device split; definitions under every card; CSV
  exports are aggregated rows only. Small-sample effects are visible by
  design (directional label) — e.g. 2 purchases over 1 view reads >100%
  conversion on a near-empty window rather than being massaged.

### OP02 — Platform overview · **verified complete (S42)**

- /platform Fleet panel: active/suspended counts, 30d GMV + orders summed
  over REACHABLE active tenants with uncovered tenants LISTED (never a
  silent zero), MRR. Backed by /api/platform/overview.

### OP06 — Fleet releases & migrations · **verified complete (S42, current scale)**

- Same panel: per tenant (suspended included) the migration-ledger head vs
  the repo head (BEHIND flagged), live release hash + date (pre-first-
  publish honest), theme kit pin. **Canary rollouts**:
  `pnpm tenant:migrate -- --all --canary <slug>` migrates the canary FIRST
  and a canary failure aborts the rollout with the rest untouched; unknown
  canary refused (both live-verified). Cohorts beyond one canary + an
  operator-triggered rollout UI are recorded for real fleet scale.

### BE35 — Performance & scale · **partial (budgets + fixtures, S42)**

- `pnpm test:perf`: 5,000-product / 120-collection fixture; budget-asserted
  hot paths (PDP, collection sort+facets+filters, multi-term search, home),
  offers on a 20-line cart, 50-page snapshot+hash, queue drain throughput,
  noisy-neighbor search. S42 measured (local SQLite): all storefront paths
  ≤2ms p50, snapshot 0.6ms, drain ~2,400 jobs/s — headroom is 2–3 orders of
  magnitude inside budgets that exist to catch lost indexes/N+1s.
- Measurement honesty (recorded): single-process harness — the noisy-
  neighbor check interleaves on one event loop, so it proves file-level DB
  isolation, not true concurrent-I/O contention; hosted-Turso network
  latency dominates production and isn't modeled here. HTTP-level load
  (concurrent render paths) not measured — revisit before checkpoint C.

### MC21 — Domains & SEO · **partial (merchant UX + robots, S43)**

- Settings → Domains panel: claimed hosts, verification status, the exact
  TXT record to add, merchant-triggered verify (own hosts only; claiming
  stays operator-side — it changes fleet routing). robots.txt is now
  per-tenant per-request (quirk #9 closed; /platform + /campaigns/
  disallowed); the sitemap was already release-aware (S36/S39).
- Remaining (recorded since S28): the path-preserving primary-host HTTP
  redirect (needs middleware or the domains activation layer) and automated
  TLS/Vercel-Domains wiring — pre-launch (checkpoint C) items.

### MC23 — Team & permissions UI · **verified complete (S43)**

- Settings → Team: members with roles, invite-by-email (link shown once,
  token hashed at rest, 7-day expiry), role select, removal; last-owner
  demote/remove guards surface from the identity layer (suite: sole owner
  blocked both ways, second owner unlocks). Owner grants require team.owner.

### MC25 — Privacy & exports (merchant) · **verified complete (S43, current scope)**

- Settings → Privacy: consent version + purposes + collection note,
  retention summary, the shopper privacy-request queue (statuses + notes),
  redaction count, per-consent event-snapshot counts. Shopper DATA export
  requests flow through the S33 data_request lifecycle; the TENANT's own
  full export is BE29 (operator-minted).

### MC26 — Audit log UI · **verified complete (S43)**

- Settings → Audit: the S27 append-only trail (time, action, resource,
  actor), served by the existing scoped+redacted API.

### MC27 — Help & support · **verified complete (S43)**

- Settings → Help: the diagnostics bundle rendered BEFORE anything is
  shared — presence flags, counts, freshness watermarks, discrepancy kinds
  with order ids only; no shopper PII, no secret values, nothing
  auto-sends. Copy button + support mail link.

### OP11 — Privacy operations · **verified complete (S43)**

- /platform Privacy ops: the fleet's request queue (unreachable tenants
  listed, never skipped silently), operator-executed redaction for
  pending/manual rows (confirm → redactCustomer → request marked done with
  counts; audited). Money rows retained by the S33 redaction semantics.

### OP12 — Incidents & maintenance · **verified complete (S43)**

- Maintenance: per-tenant config.maintenance → BRANDED kit-styled closed
  page for shoppers; console/platform cookie or the 15-min _mx pass lifts
  the visual curtain (presence-only, UX not auth); checkout 503s for
  EVERYONE. Live-drilled on demo end-to-end incl. restore. Honest notes:
  the closed page serves HTTP 200 (a real 503 status needs middleware —
  recorded), and the unused page payload still rides the response (content
  isn't secret; the store is just closed).
- Incidents: internal note / public message strictly split; open incidents
  banner in affected merchant consoles (live-verified on the login page,
  internal note absent from the HTML); resolve removes it.

### BE29 — Export & offboarding · **verified complete (S43, current scope)**

- Versioned export (manifest + all tenant-owned tables; media metadata
  only; secrets never; other tenants impossible by construction — separate
  DBs, suite-asserted). Expiring (1h) tenant-bound tamper-proof download
  links. Offboarding: typed confirm → suspend → key revocation (order-link
  + console password rotated, unrelated secrets retained) → local billing
  cancel → platform-side queue/usage purge; tenant DB + row KEPT, export
  still works after. Live: demo export downloaded (19 populated tables,
  attachment headers, bad token 401). Final DB deletion stays manual.

## W3 EXIT (recorded S39, 2026-10-28)

Exit evidence per the handoff ("tenant-specific pages from releases; no
draft/live leakage; publish + rollback demonstrated"):
- **Two tenants, two kits, one codebase**: demo = published Glow (cream/rose/
  Fraunces, screenshot-verified S37), beastlife = implicit Pulse, byte-
  identical through S35–S39 regression sweeps.
- **Everything shopper-visible rides releases**: hero, sections, nav (now
  nested), brand, theme kit, collections index, PDP extras, content/policy/
  FAQ/campaign pages — proven draft-until-publish live in S36 (publish/
  preview/rollback), S37 (kit switch), S38 (policy pages, curation), S39
  (campaigns, FAQ, nav): every pre-publish probe 404'd/stayed-stale, every
  post-publish probe flipped.
- **No draft/live leakage**: suite-proven (releases 13 + storefront 15 +
  surfaces 15) and live-probed before every publish, five sessions running.
- **Rollback**: demonstrated live in S36 (pointer back to release A, drafts
  untouched) and re-proven by suite at every commit since.
- Deliberate scope notes carried into W4: catalog presentation overrides +
  upsell placements are live-on-save (catalog-adjacent, recorded in MC05);
  maintenance mode → OP12; collection/PDP template families → W4.

## Verification state (S43, 2026-10-28)

31 aliased suites / **375 tests + 10 perf budgets + 21 offers = 406 checks**
green (new `test:tenant-ops`, 9), `pnpm build` clean (the known NFT
warning). Platform migration 0007 (incidents) applied hosted. Live drills:
maintenance ON demo → branded closed page with the custom message, checkout
API 503 CHECKOUT_DISABLED, `_mx` pass 302+cookie, any console cookie lifts
the visual curtain while checkout stays 503 → OFF restored (resolver 30s
cache window applies, as designed). Incident banner: platform-wide incident
showed its PUBLIC message on demo's /admin/login, the internal note never
appeared in the HTML, resolve removed it. Export: operator-minted link
downloaded demo's real export (manifest v1, 19 populated tables, attachment
headers), bad token 401. robots.txt per-host live (beastlife origin +
/platform+/campaigns disallowed; demo gets its own origin). Offboarding
exercised in-suite only (deliberately — no hosted tenant to sacrifice).
Dev-ops note repeated for a reason: `rm -rf .next` during baselines KILLS
the running dev server — restart the preview afterwards (bit us twice now;
the baseline script order now does build last).

## Verification state (S42, 2026-10-28)

30 aliased suites / **366 tests + 10 perf budgets + 21 offers = 397 checks**
green (new `test:reporting` 6 + `test:perf` 10), `pnpm build` clean (back to
the single known NFT warning — an S40 edge-bundle leak of node:crypto
through billing.js/razorpay-billing.js surfaced in this session's clean
build and was fixed: Web-Crypto HMAC + lazy provider import; billing +
security suites re-green). No new migrations (reporting is read-only).
Live: BE21 against beastlife's REAL hosted data (120d: 15 orders,
₹1,01,070 net, TZ Asia/Kolkata; discrepancy queue = exactly the 9 known
dead pushes; coverage honest nulls on the empty 30d window); fleet view:
all 3 tenants at migration head 0009 "current ✓", demo release 89b985a4 on
glow-1, beastlife pre-first-publish on pulse-1; canary rollout live (demo
first, then fleet; unknown canary exit 1). /admin now 307s to /admin/
dashboard; shopper regression beastlife+demo 200. Perf report (BE35)
measured set recorded above. Authenticated dashboard/analytics UI
walkthrough remains the standing user action.

## Verification state (S41, 2026-10-28)

28 suites / **360 tests + 21 offers = 381 checks** green (new
`test:provision`, 9; test-platform-sync updated for neutral-by-default
seeding), `pnpm build` clean. Platform migration 0006 applied to the hosted
control plane. Live: provisioning drill AGAINST THE HOSTED control plane
(throwaway tenant, adopted local db) — fail-at-init_billing → run recorded
with the tail pending → resume → done with all six steps, Free sub active,
onboarding record written, ZERO offers in the fresh tenant (quirk #14
verified closed) → drill tenant/sub/runs fully cleaned from the control
plane. Demo checklist derived live: 5/9 (connect/catalog/brand/policies/
billing ✓ from prior sessions' real state; domain honest-pending on
localhost hosts; launch gated). Shopper regression: beastlife + demo home
200. Console UI walkthrough (Setup tab, switcher, platform panels) remains
the standing user action (no demo login account by policy).

## Verification state (S40, 2026-10-28)

27 suites / **351 tests + 21 offers = 372 checks** green (new `test:billing`,
14), `pnpm build` clean. Platform migration 0005 applied to the hosted
control plane. Live (hosted control plane + dev server): default plans
seeded; demo subscribed to FREE (local activation, snapshot pushed,
entitlements resolve); synthetic payment-trouble drill on a throwaway
provider sub — activated → charged (₹999 in the ledger) → halted with an
already-expired grace → **checkout paused with the honest copy (API 503
CHECKOUT_DISABLED) while home/collections/search stayed 200** → resumed →
checkout back (within the resolver's 30s config cache) → drill rows deleted,
demo left clean on Free (overview: MRR 0, demo:free:active). Webhook
endpoint fail-closed 401 without a valid signature (no secret set = always
refuse). GOTCHA logged: SQLite `datetime('now')` (space format) sorts before
ISO timestamps — the drill's first snapshot picked the wrong "latest"
subscription until the row got a proper ISO created_at (lib code always
writes ISO; hand-written SQL in drills must too). NOT verified: real
provider flows (account, webhook registration, authorize/charge/refund) —
USER-GATED; the authenticated console walkthrough remains the standing user
action.

## Verification state (S39, 2026-10-28)

26 suites / **337 tests + 21 offers = 358 checks** green (new
`test:surfaces`, 15), `pnpm build` clean. Migration tenant/0009
(notifications, contact_messages, product/collection overrides,
cms_pages.family+window) applied to all 3 hosted tenant DBs + env default.
Live on demo: contact probe stored + delivered through the jobs fast path
(sent, honestly labeled DEV MOCK — RESEND unset by design), honeypot stored
nothing, invalid 422 field errors; product override (badge + 2 modules) and
collection pin live-on-save immediately; FAQ/campaign/nav drafts did NOT
leak pre-publish → publish rel_fc5b03531bf5de23 → campaign 200 inside
window with utm carried into internal links, expired campaign 404, campaign
slug 404 at /policies/, FAQ anchors live, header dropdown DOM-verified,
footer lists only the store's real pages, sitemap excludes campaigns.
beastlife regression: 6 routes 200, contact page gained the form alongside
its BeastLife content. Console UI walkthrough for the new tabs remains the
same USER ACTION as S38 (no demo account; creation-for-access declined).

## Verification state (S38, 2026-10-28)

25 suites / **322 tests + 21 offers = 343 checks** green (new
`test:storefront`, 15 tests; test-cms updated: "banner" is a real section
kind since S37 so the unknown-kind probe uses "bogus", and the
contact-injection test now also asserts a plain tenant gets NO BeastLife
default; test-releases warning count scoped to the path warning), `pnpm
build` clean. Migration tenant/0008 (media + cms_pages.effective_at) applied
to all 3 hosted tenant DBs + the env-default DB. Live on demo (script-driven
drafts — console auth untouched): media upload → served tenant-scoped
(immutable cache on demo host, 404 on beastlife host for the same id) →
drafts (pdp_extras, collections_index, privacy/terms pages with effective
dates) did NOT leak pre-publish (PDP clean, policy 404, no badge) → publish
rel_a784500fb4a36228 (zero warnings once the policy pages existed) → live:
Glow PDP accordions open/close, featured badge on /collections, policy page
with "Effective from 28 October 2026", sitemap lists only demo's own pages.
Collection filters live: price-asc + in-stock ascending ₹735→₹2,104, Clear
all + sort select rendered; sticky mobile CTA DOM-verified fixed to the
viewport bottom at 375px after scroll (hidden-pane screenshots clip fixed
elements — pane quirk, not a page bug). beastlife regression sweep: 7 key
routes 200, policies/sitemap unchanged. Also fixed in passing: React 19
hoisting warning on the S35 `<style id="brand-vars">` (precedence/href —
now hoists into <head>). NOT verified this session: the authenticated
console UI flows for the new Media tab / editors in a real browser session —
demo has no user account and minting one for access was declined by policy;
the UI is exercised by build + the API suite only. USER ACTION (2 min):
log into demo `/admin/media`, upload one image, delete it, and skim the new
Storefront panels.

## Verification state (S37, 2026-10-28)

24 suites / **307 tests + 21 offers = 328 checks** green (new `test:themes`,
10 tests), `pnpm build` clean. No new migrations (theme pin lives in tenant
config → release snapshots). Live on demo: apply-Glow → no-leak → preview →
publish → full visual transformation (screenshots); operator registry 401
without cookie, lists pins with one. Demo left on Glow v1 (published) as the
standing two-vertical showcase; beastlife untouched on implicit Pulse.

## Verification state (S36, 2026-10-28)

23 suites / **297 tests + 21 offers = 318 checks** green (new
`test:releases`, 13 tests), `pnpm build` clean. Migration tenant/0007 applied
to all 3 hosted tenant DBs. Live on demo: publish → no-leak → preview cookie
flow → rollback; per-tenant manifest/offline/404 on both hosts. Demo left
published (release 1 live, drafts in sync); beastlife remains
pre-first-publish (drafts serve, unchanged behavior).

## Verification state (S35, 2026-10-28)

22 suites / **284 tests + 21 offers = 305 checks** green (new `test:content`,
18 tests; test-cms fixture now runs the migration ledger per the standing
rule), `pnpm build` clean. Migration tenant/0006 applied to all 3 hosted
tenant DBs. Live: CAS conflict matrix + navy rebrand on demo (kept — demo
remains visibly differentiated), beastlife byte-identical.

## Verification state (S34, 2026-10-28)

21 suites / **266 tests + 21 offers = 287 checks** green (new `test:security`,
13 tests), `pnpm build` clean. Platform migration 0004 applied to the hosted
control plane. Live: full OP10 grant lifecycle over HTTP (above), BE24 probes
on beastlife, BE27 drills on demo + control plane.

## Wave W2 — EXIT (S29–S34, 2026-10-28)

Handoff exit evidence for W2 ("reliable commerce: provider reconciliation,
failure/replay tests, documented approval status, restore evidence"):
- Provider reconciliation: authoritative order projection with out-of-order/
  dedup watermark (S31, live reconcile of a real cancelled order); money in
  minor units with drift-free allocation (S31); catalog sync generations with
  prune-after-complete-only, live ghost-prune on beastlife (S30).
- Failure/replay: persist-before-ack inbox; atomic leases + crash recovery via
  lease expiry; duplicate payment replay changes money exactly once (S29
  acceptance test); audited replay from the queues console (OP05).
- Documented approval status: per-store custom apps today; public-app
  requirements + protected-customer-data position recorded (BE25, S30);
  checkout stays direct Razorpay+COD behind the capability gate (BE06, locked
  decision) — Shopify-hosted mode reserved, never silently switched.
- Restore evidence: BE27 drills run against the HOSTED demo tenant and control
  plane with integrity checks green (S34, numbers above).
- Security: release gate suite + threat model in the baseline (BE34, S34);
  operator access to tenant consoles is grant-bound, read-only, audited,
  merchant-visible (OP10, verified live over HTTP).
- Checks: 21 suites / 266 tests + 21 engine = 287, build clean.

**Deploy checkpoint B (user-gated, NOT executed):** production cutover to
platform mode. Pre-cutover list: everything from checkpoint A (PLATFORM_* env,
hosted migrations via `pnpm platform:migrate` + `pnpm tenant:migrate -- --all`,
`pnpm webhooks:register <slug>` for the S31 order topics, compliance webhook
URLs in the Shopify Dev Dashboard, real owner/operator accounts, rotate S22
throwaway passwords) plus: GH repo secrets TICK_URL+CRON_SECRET (jobs tick),
optional RESEND_API_KEY, run `pnpm restore:drill` against prod DBs after
cutover, reversible-cutover note (prod can fall back to the legacy S20 build by
unsetting PLATFORM_DB_URL — legacy mode is tested every session).

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

All remaining 33 records: **not inspected** (states will change only with code
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
