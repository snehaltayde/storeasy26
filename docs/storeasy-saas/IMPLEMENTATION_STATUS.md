# Storeasy SaaS — implementation status

Tracking file required by `Storeasy_Claude_Developer_Handoff.md` §6 and
`CLAUDE_START_PROMPT.txt` step 3. States: **not inspected** · **verified complete** ·
**partial** · **missing** · **blocked**. A state other than "not inspected" is backed
by a code audit or implementation in this repo — never by documentation alone.

- Created: 2026-10-28 (session S25). Last updated: S26.
- Roadmap: all 116 records are phased S25–S49 in the approved plan
  (`~/.claude/plans/lively-moseying-bunny.md`); waves per the handoff.
- **Audit coverage honesty:** 6 of 116 records audited/implemented so far
  (BE01, SF23, SF08 — S25; BE02, MC01, OP01 — S26). The other 110 are
  **not inspected** — the handoff's Fix/Extend/New labels for them remain
  unverified documentation claims.

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
