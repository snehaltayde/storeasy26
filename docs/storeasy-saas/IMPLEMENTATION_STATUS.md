# Storeasy SaaS — implementation status

Tracking file required by `Storeasy_Claude_Developer_Handoff.md` §6 and
`CLAUDE_START_PROMPT.txt` step 3. States: **not inspected** · **verified complete** ·
**partial** · **missing** · **blocked**. A state other than "not inspected" is backed
by a code audit or implementation in this repo — never by documentation alone.

- Created: 2026-10-28 (session S25).
- Roadmap: all 116 records are phased S25–S49 in the approved plan
  (`~/.claude/plans/lively-moseying-bunny.md`); waves per the handoff.
- **Audit coverage honesty:** 3 of 116 records have been code-audited so far
  (BE01, SF23, SF08). The other 113 are **not inspected** — the handoff's
  Fix/Extend/New labels for them remain unverified documentation claims.

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
