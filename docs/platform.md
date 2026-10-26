# Storeasy platform — tenancy architecture (Session 20)

storeasy26 is becoming **storeasy**: a tenant-based platform where a merchant
connects their Shopify store and gets this storefront — own cart/discounts/
checkout (India-market custom-checkout model), first-party tracking, search.
S20 laid the tenancy core; S21 = onboarding + webhook sync, S22 = merchant
console, S23 = CMS/upsells, S24 = platform ops (plan: 2026-10-27).

## How tenancy works

- **Control plane** (`PLATFORM_DB_URL`, dev fallback `file:platform.db`): one
  small DB with the `tenants` registry ([schema](../lib/platform/schema.sql)).
  Secrets (Shopify admin token, Razorpay secrets, admin password…) are
  **AES-GCM encrypted** with `PLATFORM_SECRET` ([crypto](../lib/platform/crypto.js)).
  Rotating `PLATFORM_SECRET` orphans stored secrets — re-seed tenants after.
- **Data plane**: **one Turso DB per tenant**, running the unchanged commerce
  schema (`lib/schema.sql`) — isolation by construction. BeastLife's existing
  `storeasyfinal` DB is tenant #1's DB.
- **Resolution**: Host header → [`getTenantByHost`](../lib/platform/control.js)
  (per-isolate cache, `PLATFORM_CACHE_MS` 30s). API routes are wrapped in
  `tenantHandler()`, RSC data calls in `tfetch()` ([tenant-request](../lib/tenant-request.js));
  both establish AsyncLocalStorage context ([tenant-context](../lib/tenant-context.js)).
- **`db` is a Proxy** ([lib/db.js](../lib/db.js)): inside tenant context it
  routes to that tenant's client (cached per DB); outside, to the env client.
  **Env vars act as the DEFAULT TENANT (BeastLife) fallback** — every script,
  test, and cron that predates S20 works unchanged, and an unmapped host or a
  control-plane outage degrades to the default store, never a 500.
- Config/secrets resolve tenant-first with env fallback everywhere:
  Shopify (`shopify_store_domain`/`shopify_admin_token`), Razorpay keys +
  webhook secret, GA4/Meta, Typesense collection, shipping config, site url,
  order-link secret, admin password (sessions bind tenant id — rotating a
  password revokes that tenant only; cookies can't cross tenants).

## Operating it

```bash
pnpm platform:migrate          # apply control-plane schema
pnpm tenant:seed-beastlife     # lift current env into tenant #1 (idempotent)
pnpm test:tenancy              # isolation suite (9 tests)
```

## Known states & next steps

1. **Hosted control plane pending `turso auth login`** (CLI session expired).
   After re-auth: `turso db create storeasy-platform` + token → set
   `PLATFORM_DB_URL`/`PLATFORM_DB_TOKEN`/`PLATFORM_SECRET` in Vercel (prod +
   preview) → `pnpm platform:migrate && pnpm tenant:seed-beastlife` against it.
   Until then prod runs the env-fallback path (pre-S20 behavior, verified).
2. **Edge routes + `file:` control plane**: the edge libsql client can't read
   file: URLs (S7 finding), so in LOCAL dev the edge surfaces (pages, cart,
   search) serve the default tenant while node surfaces (checkout, orders,
   admin, webhooks, jobs) are fully tenant-resolved — proven by probe. With a
   hosted `libsql://` platform DB this distinction disappears.
3. **Catalog staleness bites** (proven live): a 3-month-old catalog produced a
   ₹1 price drift and the S12 reconcile guard correctly refused the Shopify
   push (`RECONCILE_MISMATCH`, gid now persisted on the order row). Webhook-
   driven sync (S21) is the cure; until then re-run `pnpm sync` periodically.
4. Platform domain (wildcard `*.storeasy.app`-style) still to be purchased;
   tenants currently resolve via explicitly mapped hostnames.
