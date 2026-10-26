# Storeasy platform — tenancy architecture (Sessions 20–22)

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

## Onboarding + webhook-driven sync (Session 21)

The control plane is **hosted** (`libsql://storeasy-platform-…turso.io`) — the
S20 local-dev edge limitation is gone (proven: edge tenant resolution works via
Host-override probe). Tenants: `beastlife`, `beastlife-staging`, `demo` (all
tracking the beastlife-dev store until a second dev store exists).

- **Provisioning** ([provision](../lib/platform/provision.js)):
  `pnpm tenant:provision <slug> --shop <x.myshopify.com> [--name … --domain …]`
  creates `storeasy-t-<slug>` on Turso **via the operator's authed `turso` CLI**
  (no standing API token on disk; set `TURSO_API_TOKEN`+`TURSO_ORG` to switch to
  the Platform HTTP API), applies the commerce schema, seeds default offers,
  generates the tenant's admin password + order-link secret, and registers the
  tenant. App creds default from env (v1 partners may share the operator shell).
- **Web OAuth connect** (ports `scripts/shopify-oauth.js`): operator opens
  `GET /api/connect/shopify/start?tenant=<slug>&secret=$CRON_SECRET` → 302 to
  the tenant app's authorize URL with an HMAC-signed stateless state (10 min
  TTL, `PLATFORM_SECRET`). The [callback](../app/api/connect/shopify/callback/route.js)
  verifies state + Shopify's param HMAC (tenant's client secret) + shop match,
  exchanges the code with the TENANT's app creds, stores the permanent admin
  token encrypted (`patchTenant`), registers webhooks (needs an https
  `PLATFORM_URL`; skipped on localhost), and kicks the initial catalog sync in
  `after()` (big catalogs: run `pnpm tenant:sync <slug>` instead).
- **Sync engine** ([lib/sync.js](../lib/sync.js), extracted from scripts/sync.js):
  `runCatalogSync()` (full), `syncTenantCatalog(tenant)` (full, as tenant),
  `syncProductByGid`/`syncCollectionByGid`/`delete*ByGid` (incremental). The
  Typesense index step is **non-fatal** since S21 — a dead search cluster
  degrades search to the SQL fallback, never blocks catalog freshness.
- **Webhooks** ([receiver](../app/api/shopify/webhooks/route.js), ONE URL for
  the platform): tenant lookup by `X-Shopify-Shop-Domain` fans out to ALL
  active tenants on that store; the raw-body HMAC is verified against EACH
  tenant's own app client secret (verification doubles as tenant-match proof).
  Deliveries are hints → targeted REFETCH via Admin GraphQL → the same
  reshape/write path as the full sync. Work runs in `after()` (Shopify wants a
  fast 2xx); the full-reconcile sync is the backstop for dropped work.
  `app/uninstalled` flags the tenant config + alerts (tenant stays active).
  Topics: products/create|update|delete, collections/create|update|delete,
  app/uninstalled. Register/repair: `pnpm webhooks:register <slug> [--url …]`.
- **Reconcile route** ([jobs/sync-catalog](../app/api/jobs/sync-catalog/route.js)):
  `POST {tenant}` one / `GET ?limit=N` loop — **no cron slot** (Hobby's 2 are
  taken); hit manually or from an external scheduler; 60s budget fits
  small/mid stores, use the CLI for big ones.

### Live proofs (2026-10-27, local)

provision demo from blank DB ✓ · `tenant:sync demo` 319/281 ✓ · two-host PDP
divergence after demo-only delete (beastlife 200, demo 404), restored via live
`syncProductByGid` ✓ · signed webhook POST → fan-out `[beastlife,
beastlife-staging, demo]`, all three DBs re-synced in ~2s; tampered sig → 401;
unknown shop → ignored ✓ · OAuth start 302 with signed state, 401 without
operator secret ✓.

## Merchant console + platform console (Session 22)

- **Merchant console** `/admin` on each storefront host (per-tenant password,
  sessions tenant-bound): **Offers** (S19) · **Orders** — list with status
  tabs/search/keyset paging ([lib/admin/orders](../lib/admin/orders.js)),
  detail with items/payment/sync/timeline, "Retry Shopify push" on
  `sync_failed` · **Settings** ([lib/admin/settings](../lib/admin/settings.js)):
  store identity, Razorpay keys, GA4/Meta creds, **shipping rules editor**
  (writes `config.shipping_config` — the same engine prices drawer, checkout
  and push), sync status + "Sync now", console-password rotation (old sessions
  die; the saving browser gets a fresh cookie). Secret values NEVER leave the
  server — presence flags only, fields are write-only (blank = keep). Saves go
  through `PUT /api/admin/settings` → validated `buildSettingsPatch` →
  `patchTenant` for the Host-resolved tenant only; the env-fallback default
  tenant is read-only (no control-plane row).
- **Platform console** `/platform` (operator password `PLATFORM_ADMIN_PASSWORD`
  env; `_platform` cookie, also accepted by the OAuth connect start route):
  tenant registry with per-tenant health queried from each tenant's own DB
  (products, last sync, orders in flight, Shopify connected/uninstalled),
  actions Sync / Connect Shopify / Suspend / Activate, and the **create
  wizard** → `POST /api/platform/tenants` → S21 `provisionTenant` (generated
  console password shown ONCE). Suspending a tenant drops its hosts to the
  default-store fallback, never a 500.

### Live proofs (2026-10-27, local)

Operator console lists 3 tenants with live health (326/308/319 products) ✓ ·
demo merchant console (`127.0.0.1:3007` host) logged in via UI, orders list +
detail + timeline render demo's own data ✓ · settings edited in the UI (name,
flat ₹99, free ≥₹1499, zone 79/78 @₹149) → persisted to the control plane,
beastlife untouched, **demo storefront cart immediately charges ₹99 with
"₹132 away from free"** ✓ · suspend → demo host falls back to default store →
activate ✓ · login title is per-tenant ("Storeasy Demo admin") ✓.

## Operating it

```bash
pnpm platform:migrate          # apply control-plane schema
pnpm tenant:seed-beastlife     # lift current env into tenant #1 (idempotent)
pnpm tenant:provision <slug> --shop <x.myshopify.com>   # new tenant E2E
pnpm tenant:sync <slug>        # full catalog sync for one tenant
pnpm webhooks:register <slug>  # register/repair webhook subscriptions
pnpm test:tenancy              # S20 isolation suite (9 tests)
pnpm test:platform-sync        # S21 onboarding/webhook suite (13 tests)
pnpm test:admin-console        # S22 console suite (9 tests)
```

Local consoles: `/platform` (operator) and `/admin` per tenant host — in dev,
`localhost:3007` is beastlife and `127.0.0.1:3007` is the demo tenant. The
local operator password and the demo tenant's console password are THROWAWAY
test values set during S22 — rotate both before any deploy (operator: edit
`PLATFORM_ADMIN_PASSWORD` in env; demo: Settings → Console password).

## Known states & next steps

1. **Vercel env still missing platform vars**: set `PLATFORM_DB_URL`,
   `PLATFORM_DB_TOKEN`, `PLATFORM_SECRET` (+ optional `PLATFORM_URL`) in prod
   AND preview, then redeploy — until then prod serves the env-fallback tenant
   and the webhook receiver answers `unknown_shop`. After deploy:
   `pnpm webhooks:register beastlife` for live incremental sync.
2. **Typesense cluster is gone** (lapsed): search rides the SQL fallback
   everywhere; health says "degraded". Revive/recreate the cluster, update
   `TYPESENSE_*` env + tenant configs, then `pnpm sync:search` per tenant.
3. **Catalog staleness** (the S20 ₹1-drift lesson): webhooks now cure it for
   connected tenants; until webhooks are registered on prod, re-run
   `pnpm sync` / `pnpm tenant:sync` periodically.
4. Platform domain (wildcard `*.storeasy.app`-style) still to be purchased;
   tenants currently resolve via explicitly mapped hostnames.
5. The demo tenant carries a copied beastlife admin token (same store/app —
   what the OAuth callback would store); replace via the connect flow when the
   localhost redirect URI is allowlisted on the app, or keep until S24's second
   dev store.
