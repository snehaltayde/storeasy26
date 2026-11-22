# Storeasy (`storeasy26`) — Claude Code Handoff: Phases 2 through 6

> **Purpose:** Authoritative technical handoff from **Phase 0 + Phase 1** (completed locally on `main`) to **Claude Code** for implementing **Phases 2, 3, 4, 5, and 6**.
>
> **How to use this document:**
> 1. Read **Sections 1–3** once before starting any phase so you preserve every architectural, security, and test-runner invariant.
> 2. Execute **one bounded sub-phase per Claude Code session** using the ready-to-paste prompts in **Sections 5–9** (Phase 2A → 2B → 3 → 4 → 5 → 6).
> 3. After every sub-phase, run the mandatory verification gate:
>    ```bash
>    pnpm typecheck && pnpm build && pnpm test
>    ```
>    Do not move to the next sub-phase until all suites, TypeScript, and the Next.js production build pass with zero errors.

---

## 1. Current Repository State (Post-Phase 0 & Phase 1 Ground Truth)

### 1.1 Recent Git History on `main` (Local Commits — Not Pushed Yet)
| Commit | Summary |
| :--- | :--- |
| `907cd42` | Fast-forwarded `main` to `cms/phase-1` (482 commits of Documents CMS Phases 1–6). |
| `e59803e` | Merged `claude/gallant-keller-7d3213` — DB transient retry hardening (`lib/db.js`) & strict double-payment refusal (`lib/payment-recovery`). |
| `cfc35e6` | Merged `claude/musing-williamson-4c86b3` — Verified fail-closed maintenance curtain (`lib/storefront-request.js`) & closed-store leak prevention. Pruned ~180 merged branches & ~70 orphaned worktrees. |
| `9926aeb` | **Phase 1.1: Retired Legacy CMS** — Deleted 47,119 LOC across 178 files (`components/admin/cms/`, `lib/migrate/`, legacy `lib/cms/*`, legacy console routes, 26 legacy-only suites). Documents CMS is now the **sole** CMS engine (`migrations/tenant/0026_retire_legacy_cms.sql`). Shared pickers live in `components/admin/shared/`, upsells in `lib/catalog/upsells.js`. |
| `50a4417` | **Phase 1.2: Architecture Core Modernization** — Incremental TypeScript (`tsconfig.json`, `lib/types/*.ts`), Cloudflare R2/S3 Edge-safe media storage (`lib/media-storage.js` + `migrations/tenant/0027_media_storage_url.sql`), tenant-scoped tagged storefront cache (`lib/cache.js`), Edge-safe Upstash Redis REST distributed rate limiter (`lib/rate-limit.js`), strict CSP & security headers (`next.config.mjs`), atomic batch cart add (`lib/cart.js` `addItems`, `/api/cart` `action: "add_many"`, `components/BundleAddButton.js`), and `scripts/test-phase1-core.js`. |

> **Untracked files to leave untouched:** Do NOT modify, delete, or commit `docs/CMS_CLAUDE_DIRECTION_BRIEF.md`, `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md`, or `docs/CMS_SESSION_HANDOFF.md`. They are reference documents owned by the user.

### 1.2 Toolchain & Runtime Versions
- **Framework:** Next.js `16.2.9` (App Router + Turbopack, Edge & Node runtimes)
- **UI:** React `19.2.4`, Tailwind CSS `^4`, `lucide-react` `0.544.0`
- **Database:** `@libsql/client` `^0.17.4` + `kysely` `^0.29.2` (SQLite locally, Turso in hosted staging/prod; **DB-per-tenant** + 1 control-plane DB)
- **Search:** `typesense` `^3.0.6` (with SQLite fallback when unset)
- **TypeScript:** `typescript@^5.9.3` with `tsconfig.json` (`allowJs: true`, `noEmit: true`, `strict: false` incrementally; run via `pnpm typecheck`).
  - **CRITICAL:** Do NOT upgrade `typescript` to `7.x` — Next.js `16.2.9` build workers crash on TypeScript 7.x. Stay on `5.9.x`.
- **Tests:** **80 automated test suites** run via `pnpm test` (`scripts/run-tests.js`), plus `pnpm typecheck` and `pnpm build`.

### 1.3 Directory & Key Module Map
```text
app/
  (storefront)/         # Edge/Node storefront pages (/, /products/[handle], /collections/[handle], /cart, /checkout, /account, /campaigns/[slug], /journal, /search, etc.)
  (console)/
    admin/              # Merchant Console (/admin/dashboard, /admin/editor, /admin/orders, /admin/catalog, /admin/offers, /admin/media, /admin/releases, /admin/settings, ...)
    platform/           # Platform Operator Console (currently monolithic components/platform/PlatformAdmin.js — split in Phase 3)
  api/
    admin/              # Merchant APIs (authenticated via lib/platform/authz.js + actor checks)
    platform/           # Operator APIs
    cart/               # Shopper cart (supports action: "add" | "add_many" | "set" | "remove" | "coupon")
    checkout/           # Money-path idempotent checkout + Razorpay + COD
    media/[id]/         # R2 302 redirect (non-SVG public HTTPS) or streamed bytes with strict SVG CSP
    razorpay/webhook/   # Razorpay signed webhook + payment recovery
    shopify/webhooks/   # Shopify signed webhook ingestion (catalog/fulfillment sync)
    jobs/tick/          # Durable job queue processor (Turso jobs table)
    preview/            # Signed preview session entrypoint

lib/
  types/                # Canonical TypeScript contracts (EXTEND THESE — DO NOT REINVENT):
    tenant.ts           # Tenant, TenantConfig, BrandTokens, ShippingConfig, Actor
    documents.ts        # DocumentType, SectionInstance, BlockInstance, DocumentRow, ReleaseListV4
    commerce.ts         # EffectiveProduct, Cart, CartLine, BatchCartItemInput, OrderSummary
    ecosystem.ts        # Full Phase 2 PluginManifest, ExtensionSlotId, WebhookTopic, ThemePackageManifest, TemplateAstNode, ProtectedPrimitiveName, StorefrontDataContext
    index.ts            # Re-exports all types
  documents/            # Sole CMS engine: service.js, publish.js, after-commit.js, diff.js, validate.js
  registry/             # Section & document type schemas (sections.js, documents.js, design.js)
  content/              # Storefront document reader & resolver (resolve.js, effective.js)
  catalog/              # Effective catalog reader & upsells.js (single-reader overlay boundary)
  themes/               # Current kit definitions (kits.js) — evolved into Open Theme Engine in Phase 2B
  media-storage.js      # Edge-safe AWS SigV4 Cloudflare R2 / S3 adapter
  media.js              # Media CRUD (R2 primary + SQLite BLOB fallback)
  cache.js              # Edge-safe tenant-scoped tagged cache (`tenant:<id>:<namespace>`)
  rate-limit.js         # Edge-safe Upstash Redis REST sliding window + in-memory fallback
  cart.js               # Server cart (atomic addItems, offers, gifts, shopperCart sanitizer)
  offers/               # Discount & bundle engine
  shipping.js           # Shipping & COD fee quotes
  db.js                 # Tenant-scoped libSQL + Kysely wrapper with safe transient read retry
  tenant-context.js     # AsyncLocalStorage fail-closed tenant context
  storefront-request.js # Host resolution + verified maintenance curtain gate
  platform/             # Control plane DB, authz, sessions, OAuth, jobs, billing, agency, crypto (`k1:` AES-GCM)

migrations/
  platform/             # Up to 0010_agency.sql → Phase 2 starts at 0011_*.sql
  tenant/               # Up to 0027_media_storage_url.sql → Phase 2 starts at 0028_*.sql

scripts/
  run-tests.js          # Master test runner (auto-validates every scripts/test-*.js is wired in package.json!)
  test-*.js             # 80 test suites
```

---

## 2. Non-Negotiable Architecture & Security Invariants

Every PR/commit across Phases 2–6 MUST uphold these invariants (all enforced by automated tests in `pnpm test`):

1. **DB-Per-Tenant Isolation (`test:tenant-boundary`, `test:tenancy`)**
   - Every tenant query runs inside `withTenant(tenant, fn)` via `AsyncLocalStorage` (`lib/tenant-context.js`).
   - Cache tags MUST be created via `tenantTag(namespace)` (`tenant:<id>:<namespace>`).
   - Media/Theme R2 object keys MUST be prefixed `tenants/<tenantId>/...` (or `themes/<themeId>/<version>/...` for immutable public catalog packages).
   - Never cache tenant-specific data in module-level Maps without keying by `tenantId()`.

2. **Shopify Read-Only Content Boundary & Static Scanner Rules (`test:shopify-boundary`)**
   - Storeasy **never** writes storefront content (titles, copy, CMS sections, themes) back to Shopify. Only `draftOrderCreate` / `draftOrderComplete` / `orderCancel` on the strict allowlist are permitted.
   - **IMPORTANT STATIC SCANNER GOTCHA:** `scripts/test-shopify-boundary.js` (`SHOP-01`) scans the entire repo for any identifier matching `*_SCOPES =` (to guarantee there is only ONE Shopify OAuth scope list in `lib/platform/oauth.js: OAUTH_SCOPES =`) and scans for any `write_*` Shopify scope string.
     - **Rule for Phase 2–6:** When naming plugin permissions, theme capabilities, or cache lists in JS/TS files, **NEVER** name a constant `*_SCOPES =` (use `PLUGIN_PERMISSIONS =`, `APP_CAPABILITIES =`, `CACHE_NAMESPACES =`, etc.) and never include `write_` strings that look like Shopify scopes.

3. **Effective Catalog Single-Reader Boundary (`test:effective-read`, `test:order-catalog`)**
   - Shopper-facing UI (and `StorefrontDataContext` injected into themes/plugins) MUST read titles/descriptions through the effective catalog overlay (`lib/content/effective.js`), never raw `products.title`.
   - `shopperCart()` in `lib/cart.js` strips server-only fields (`catalog_title`, `sku`) before sending cart JSON to browsers, themes, or plugins. Preserve this stripping everywhere.

4. **Security & Route Registration Guardrails (`test:security`, `test:authz`, `test:maintenance`)**
   - `scripts/test-security.js` inspects `git ls-files app/api` — **every new API route MUST be explicitly authenticated** (or intentionally listed in the public storefront allowlist with rate limiting and input validation) and **must be `git add`-ed before running `test:security`** if testing untracked routes.
   - Every new `scripts/test-*.js` file MUST be wired into BOTH `package.json` (`"test:<name>": "node scripts/test-<name>.js"`) AND `scripts/run-tests.js`, or `SHOP-06` will fail ("a suite file no gated script runs").
   - Fail-closed host resolution and maintenance curtain (`lib/storefront-request.js`) must remain intact on all storefront routes and new theme/plugin endpoints.

5. **Edge Runtime Safety**
   - Storefront routes and shared runtime helpers (`lib/cache.js`, `lib/media-storage.js`, `lib/rate-limit.js`, `lib/cart.js`, and the Phase 2B **Theme AST Renderer**) MUST NOT import `node:*` modules so they run cleanly on both Edge and Node runtimes.
   - Use Web Crypto (`globalThis.crypto.subtle`) instead of `node:crypto` in Edge-accessible modules. (ZIP parsing / theme upload compilation runs in Node-only admin/platform API routes, never in Edge storefront renderers!)

6. **Zero Arbitrary JS Execution in Themes & Plugins ("Full UI Freedom, Zero Logic Access")**
   - **Uploaded themes NEVER execute arbitrary JS** in Next.js SSR or client bundles:
     - Reject `<script>`, `<iframe>`, `on*=` attributes, `javascript:` URLs, `eval`, `Function`, CSS `expression()`, and external `@import` at upload/compile time.
     - Compile `.stml` templates into static JSON `TemplateAstNode[]` at **upload time** (Node route); render the AST deterministically at request time with zero `eval`.
     - Commerce interactions (Add to Cart, Variant Selector, Buy Box, Cart Drawer, Checkout Button, Bundle Add, Pincode Check, Wishlist, Search) are rendered EXCLUSIVELY by Storeasy's **Protected Commerce Primitives** (`<storeasy:*>`), which themes can position and style via CSS custom properties/parts, but NEVER alter the pricing/cart/checkout/auth logic of.
   - **External (Tier 2) plugins NEVER execute unsandboxed JS in admin or storefront**:
     - Storefront widgets use either declarative templates, strict allowlisted SRI scripts (merchant-consented), or sandboxed `<iframe>` (`sandbox="allow-scripts allow-forms"` without `allow-same-origin` unless explicitly isolated on a separate origin).
     - Admin panels run inside CSP-sandboxed iframes communicating over a typed `postMessage` App Bridge.

7. **Money-Path & Write-Retry Safety (`test:db-retry`, `test:payment-recovery`, `test:orders`)**
   - Never blindly retry unknown-outcome write mutations (`lib/db.js` intentionally retries transient reads only).
   - All checkout pricing, discounts, shipping, and COD fees are recomputed server-side; client totals are advisory only.

8. **Test Suite Registration & Schema Compat (`test:schema-compat`, `test:provision`)**
   - All new tenant DB migrations MUST be **additive** (no destructive column drops that break in-flight older code) and placed in `migrations/tenant/00XX_<name>.sql` (sequential numbering from `0028`).
   - All new platform DB migrations go in `migrations/platform/00XX_<name>.sql` (sequential numbering from `0011`).

---

## 3. Operator Runbook: Hosted Staging Deployment (Phase 0 Live Gate)

Before or alongside Phases 2–6, the user/operator can deploy the stabilized Phase 0 + Phase 1 `main` branch to hosted staging (Vercel + Turso + Typesense + optional R2/Upstash) using this checklist:

1. **Required Environment Variables (Vercel Staging Project)**
   - **Control Plane:** `PLATFORM_DB_URL`, `PLATFORM_DB_TOKEN`, `PLATFORM_SECRET` (32+ byte random hex), `PLATFORM_URL`, `CRON_SECRET`
   - **Fallback / Single-Tenant (if used):** `TURSO_DB_URL`, `TURSO_DB_AUTH_TOKEN`, `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - **Search:** `TYPESENSE_HOST`, `TYPESENSE_PORT`, `TYPESENSE_PROTOCOL`, `TYPESENSE_API_KEY`
   - **Media CDN (Phase 1.2 — optional, falls back to SQLite BLOB if unset):** `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL`
   - **Distributed Rate Limit (Phase 1.2 — optional, falls back to in-memory if unset):** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - **Notifications & Alerts:** `RESEND_API_KEY`, `ALERT_WEBHOOK_URL`
   - **AI Copilot (Phase 6):** `AI_PROVIDER` (`gemini` | `anthropic` | `openai`), `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`

2. **Database Migration & Search Sync Commands**
   ```bash
   pnpm platform:migrate
   pnpm tenant:migrate -- --all
   pnpm tenant:migrate -- --all --check
   pnpm sync:search
   ```

3. **Hosted Smoke Verification Gate**
   - Enable `.github/workflows/jobs-tick.yml` with `PLATFORM_URL` + `CRON_SECRET`.
   - Verify `/api/health` returns `200` and response headers contain `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
   - Run a real Razorpay test order + COD order + Shopify draft order push + order cancel.
   - Verify closed-store maintenance curtain returns `503` + `X-Robots-Tag: noindex` with zero product/brand leaks (`pnpm drill:maintenance-edge`).
   - Verify Documents CMS edit → preview → publish → storefront update + cache invalidation works end-to-end.

---

## 4. Roadmap Overview for Claude Code (Phases 2–6)

| Session | Phase | Primary Deliverable | New Migrations | New Test Suites |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **Phase 2A** | Two-Tier Plugin System (Registry, Scoped Tokens, Webhook Outbox, `<PluginSlot />`, `/admin/apps`) | `platform/0011_ecosystem_registry.sql`, `tenant/0028_plugins.sql` | `scripts/test-plugins.js` |
| **2** | **Phase 2B** | Open Uploadable Theme Engine (`.storeasy-theme.zip` uploader, `.stml` AST compiler & zero-eval Edge renderer, scoped CSS sanitizer, `<storeasy:*>` primitives, `/admin/themes`) | `tenant/0029_themes.sql` | `scripts/test-themes-engine.js` |
| **3** | **Phase 3** | Full-Bleed Visual Studio Editor (`100dvh`, `@dnd-kit`, Theme Customizer, Pro UI-only `.stml`/CSS editor, `<16ms` `postMessage` preview) + Console UX & Multi-Route `/platform` | — (uses existing `documents` + `tenant_themes`) | `scripts/test-studio-editor.js` |
| **4** | **Phase 4** | 5 Flagship Open-Engine Themes (`pulse`, `glow`, `atelier`, `vital`, `craft`), 12+ High-Converting Sections, Upgraded `ProductCard` / Multi-Facet Typesense Search / Mobile Sticky ATC / Tiered Cart Drawer | — | `scripts/test-storefront-ux.js` |
| **5** | **Phase 5** | India D2C + Global Checkout (Pincode Auto-Fill & ETA, COD-to-Prepaid Nudge & COD OTP, Multi-Currency/Country Generalization, Saved Addresses, Collection Offers & Bundle Stock/Scheduling) | `tenant/0030_checkout_addresses_offers.sql` | `scripts/test-checkout-india-global.js` |
| **6** | **Phase 6** | 5 First-Party Ecosystem Plugins (`reviews`, `subscriptions`, `whatsapp`, `shiprocket`, `ai-copilot` multi-provider Gemini/Claude/OpenAI) | `tenant/0031_first_party_plugins.sql` | `scripts/test-ecosystem-plugins.js` |

---

## 5. Phase 2A — Two-Tier Plugin System

### 5.1 Architecture & Contracts
Implement the canonical TypeScript contracts already defined in `lib/types/ecosystem.ts` (`PluginTier`, `PluginScope`, `ExtensionSlotId`, `WebhookTopic`, `PluginManifest`, `InstalledPlugin`).

- **Tier 1 (Declarative / First-Party Modules):** Registered in `lib/plugins/builtin.ts`, zero external network hops, Edge-safe, tenant-scoped via `AsyncLocalStorage`, secrets encrypted via existing `k1:` AES-GCM envelope (`lib/platform/crypto.js`). Migrate existing integrations (`razorpay`, `ga4`, `meta`, `mail`) to register through the plugin registry while maintaining 100% backward compatibility with `lib/integrations.js` and existing tests.
- **Tier 2 (External / Third-Party Remote Apps):**
  - Installed per-tenant with least-privilege granted permissions (remember: name runtime constant `PLUGIN_PERMISSIONS`, NOT `*_SCOPES`!).
  - Issues per-tenant hashed API tokens (`stapp_<prefix>_<random>`, SHA-256 stored in `tenant_plugin_tokens`) checked on `/api/plugins/v1/*` routes.
  - Outbound durable webhooks emitted via `emitPluginEvent(topic, payload)` → enqueued into Turso `jobs` (or `plugin_webhook_deliveries`) with **HMAC-SHA256** signature header (`X-Storeasy-Signature: sha256=<hex>`, `X-Storeasy-Topic`, `X-Storeasy-Tenant`, `X-Storeasy-Delivery-Id`), exponential retry, dead-letter status, and delivery log viewer in `/admin/apps/[id]`.
- **Extension Slots (`components/plugins/PluginSlot.tsx`):**
  - Renders active plugins targeting any `ExtensionSlotId` (`storefront.pdp.under_price`, `storefront.pdp.under_atc`, `storefront.pdp.tabs`, `storefront.pdp.below_fold`, `storefront.cart.above_total`, `storefront.cart.below_cta`, `storefront.checkout.order_summary`, `storefront.footer.above`, etc.).
  - Supports `declarative_template` (rendered with Phase 2B AST engine or safe HTML escaping), `iframe_widget` (strict `sandbox="allow-scripts allow-forms"`), and `script_tag` (HTTPS + SRI hash required).
  - Fails closed & isolated: one broken plugin MUST NEVER throw or crash the storefront page (`try/catch` boundary per slot item).

### 5.2 Database Migrations
1. `migrations/platform/0011_ecosystem_registry.sql`:
   - `plugin_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved', manifest_json TEXT NOT NULL, author_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
   - `theme_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved', manifest_json TEXT NOT NULL, package_url TEXT, preview_url TEXT, author_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
2. `migrations/tenant/0028_plugins.sql`:
   - `tenant_plugins (plugin_id TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, granted_permissions TEXT NOT NULL DEFAULT '[]', settings_json TEXT NOT NULL DEFAULT '{}', secrets_enc TEXT, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
   - `tenant_plugin_tokens (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL, permissions_json TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL)`
   - `plugin_webhook_deliveries (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, topic TEXT NOT NULL, endpoint_url TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_status_code INTEGER, last_error TEXT, next_retry_at TEXT, created_at TEXT NOT NULL, delivered_at TEXT)`
   - `plugin_kv (plugin_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (plugin_id, key))`

### 5.3 Files to Create / Update
- `lib/plugins/registry.ts` — Manifest validation (rejects HTTP non-HTTPS `appBaseUrl`, invalid slugs, missing SRI on script tags, unknown permissions/slots), catalog lookup, install/uninstall/toggle/settings CRUD, secret encryption/decryption.
- `lib/plugins/tokens.ts` — Scoped API token minting, SHA-256 verification, permission check helper.
- `lib/plugins/webhooks.ts` — `emitPluginEvent(topic, payload)`, Web Crypto HMAC-SHA256 signing, delivery worker + retry processor (wired into `/api/jobs/tick` and order/sync/publish hooks).
- `lib/plugins/kv.ts` — Tenant-isolated namespaced `plugin_kv` read/write helper (capped at 64KB per value, max 500 keys per plugin).
- `lib/plugins/builtin.ts` — Built-in Tier 1 manifest declarations for `razorpay`, `ga4`, `meta`, `resend-mail`.
- `components/plugins/PluginSlot.tsx` — Server/client slot renderer with strict error & sandbox isolation.
- `app/api/admin/plugins/route.ts` & `app/api/admin/plugins/[id]/route.ts` — Merchant install/configure/uninstall/test-webhook/rotate-token APIs (RBAC-protected, audit-logged, calls `invalidateTenantCache(["plugins"])`).
- `app/api/plugins/v1/[resource]/route.ts` — Scoped External App API (`catalog`, `orders`, `customers`, `kv`) authenticated by `Authorization: Bearer stapp_...` with per-permission enforcement and `shopperCart`/effective-catalog rules.
- `app/api/platform/plugins/route.ts` — Operator catalog approval, submission, and global kill-switch (`status = 'suspended'`).
- `app/(console)/admin/(authed)/apps/page.tsx` & `app/(console)/admin/(authed)/apps/[id]/page.tsx` — Merchant App Marketplace, installed apps config forms (auto-generated from `settingsSchema`), webhook delivery logs, and sandboxed Admin App Bridge iframe (`postMessage` handshake).
- `scripts/test-plugins.js` — Comprehensive test suite wired into `package.json` (`test:plugins`) and `scripts/run-tests.js`.

### 5.4 Ready-to-Paste Claude Code Prompt (Phase 2A)
```text
Read docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md (Sections 1, 2, and 5) and lib/types/ecosystem.ts first.

Implement Phase 2A — Two-Tier Plugin System on local `main` (do NOT push):
1. Add migrations:
   - migrations/platform/0011_ecosystem_registry.sql (`plugin_catalog`, `theme_catalog`)
   - migrations/tenant/0028_plugins.sql (`tenant_plugins`, `tenant_plugin_tokens`, `plugin_webhook_deliveries`, `plugin_kv`)
2. Implement lib/plugins/{registry,tokens,webhooks,kv,builtin}.ts using the canonical interfaces in lib/types/ecosystem.ts.
   - CRITICAL: Never name any constant `*_SCOPES =` (use `PLUGIN_PERMISSIONS =`) and never reference Shopify `write_*` strings — `test:shopify-boundary` enforces a single OAuth scope list.
   - Encrypt plugin secrets with lib/platform/crypto.js (`k1:` AES-GCM).
   - Keep runtime slot/webhook signing Edge-safe (Web Crypto only, zero `node:*` imports in storefront-imported modules).
   - Wire `emitPluginEvent` cleanly into order creation/payment/cancel, catalog sync, and document release publish (best-effort, never blocking or failing the money path).
   - Invalidate `tenant:<id>:plugins` via `invalidateTenantCache(["plugins"])` on plugin install/config/toggle/uninstall.
3. Build `components/plugins/PluginSlot.tsx` and mount key slots on PDP (`under_price`, `under_atc`, `below_fold`), Cart Drawer (`above_total`, `below_cta`), and Footer (`above`) without changing existing storefront DOM when no plugins are installed.
4. Build APIs:
   - `/api/admin/plugins` & `/api/admin/plugins/[id]` (merchant RBAC + audit log)
   - `/api/plugins/v1/[resource]` (scoped Bearer token auth enforcing granted permissions + tenant isolation)
   - `/api/platform/plugins` (operator catalog governance + global kill-switch)
5. Build Merchant UI `/admin/apps` and `/admin/apps/[id]` (marketplace grid, install/configure from `settingsSchema`, webhook logs, sandboxed iframe panel for Tier 2 apps).
6. Add `scripts/test-plugins.js` (register in `package.json` as `test:plugins` and in `scripts/run-tests.js`) testing: manifest validation, Tier 1 & Tier 2 install/secret encryption, cross-tenant isolation, scoped token permission enforcement & revocation, HMAC-SHA256 webhook signing + retry, global kill-switch, and slot error isolation.
7. Run `pnpm typecheck && pnpm build && pnpm test`. Fix any failures, then commit locally on `main` as `Phase 2A: Two-tier plugin system, scoped app API, HMAC webhooks, extension slots, and /admin/apps`.
```

---

## 6. Phase 2B — Open Uploadable Theme Engine (Full UI Freedom, Zero Logic Access)

### 6.1 Core Design Principle
Any third-party designer, agency, or merchant can author a complete storefront theme (`.storeasy-theme.zip`), upload it, preview it against real tenant catalog data, visually customize it via its own `settings_schema.json`, optionally edit its UI templates/CSS safely in-browser, and publish/rollback atomically — **with FULL UI/layout/CSS freedom and ZERO access to commerce, auth, DB, secrets, or arbitrary JavaScript execution**.

### 6.2 `.storeasy-theme.zip` Package Spec
Match `ThemePackageManifest`, `ThemeSettingsGroup`, `ThemeSectionSchema`, `TemplateAstNode`, `ProtectedPrimitiveName`, and `StorefrontDataContext` in `lib/types/ecosystem.ts`:
```text
my-theme.storeasy-theme.zip
├── theme.manifest.json         # ThemePackageManifest (schemaVersion: 1, id, version, entry map, defaultBrand)
├── config/
│   ├── settings_schema.json    # ThemeSettingsGroup[] — auto-generates Theme Customizer sidebar
│   └── settings_data.json      # Default setting values
├── assets/
│   ├── theme.css               # Scoped CSS (sanitized & prefixed under [data-theme-root="<id>"])
│   ├── preview.webp            # Theme thumbnail
│   └── *.svg / *.png / *.woff2 # Sanitized SVG / static assets stored in R2 (or SQLite fallback)
├── layout/
│   └── theme.stml              # Root layout shell (`{{ content_for_layout }}`, header/footer, `<storeasy:cart-drawer />`)
├── templates/
│   ├── home.stml               # Page-family templates (optional per surface; falls back to Storeasy default if omitted)
│   ├── product.stml
│   ├── collection.stml
│   ├── cart.stml
│   └── page.stml
├── sections/
│   ├── hero.section.json       # ThemeSectionSchema
│   ├── hero.stml               # Logic-free section template
│   └── ...
└── snippets/
    └── product-badge.stml      # Reusable UI partials (`{% render 'product-badge' %}`)
```

### 6.3 Logic-Free `.stml` Compiler & Zero-Eval Edge Renderer
1. **Upload-Time Compiler (`lib/themes/compiler.ts` — Node runtime):**
   - Unzips `.storeasy-theme.zip` safely (zip-slip path traversal protection, max uncompressed size 15 MB, max 200 files, strict extension allowlist: `.json`, `.stml`, `.css`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.woff2`).
   - Parses `.stml` into `TemplateAstNode[]` supporting ONLY:
     - Safe text & escaped interpolation: `{{ product.title }}`, `{{ product.priceMin | money }}`, filters: `money`, `truncate`, `upcase`, `downcase`, `escape`, `default`, `img_url`, `json_attr`.
     - Conditionals: `{% if product.available %}...{% elsif ... %}...{% else %}...{% endif %}`.
     - Bounded loops: `{% for item in collection.products limit:24 %}...{% else %}...{% endfor %}` (hard cap: max 100 iterations per loop, max nesting depth 6 — prevents DoS!).
     - Safe HTML elements (allowlisted structural/semantic/media tags) and attributes (blocks ALL `on*` event attributes, `javascript:`, `data:text/html`, `<script>`, `<object>`, `<embed>`, `<iframe>`, `<form action="http...">`).
     - **Protected Commerce Primitives:** `<storeasy:add-to-cart />`, `<storeasy:variant-selector />`, `<storeasy:buy-box />`, `<storeasy:cart-drawer />`, `<storeasy:checkout-button />`, `<storeasy:bundle-add />`, `<storeasy:search-box />`, `<storeasy:wishlist-button />`, `<storeasy:pincode-check />`, `<storeasy:plugin-slot name="..." />`, `<storeasy:section-outlet />`.
     - **Required primitive check:** `product.stml` (if provided) MUST include `<storeasy:buy-box />` or (`<storeasy:variant-selector />` + `<storeasy:add-to-cart />`), and `layout/theme.stml` MUST include `<storeasy:cart-drawer />` and `{{ content_for_layout }}` — ensuring no uploaded theme can accidentally break checkout!
   - **CSS Sanitizer & Scoper (`lib/themes/css-sanitizer.ts`):**
     - Strips `@import`, `javascript:`, `expression(`, `-moz-binding`, `behavior:`, `url(data:text/html...)`, and external `url(http...)` except allowlisted Google Fonts / R2 CDN / relative `assets/` rewritten to tenant media URLs.
     - Scopes selectors under `[data-theme-root="<themeId>"]` and generates `:root` / `[data-theme-root]` CSS custom properties from `settings_schema.json` (`cssVar` mappings).
2. **Request-Time Renderer (`lib/themes/renderer.tsx` — 100% Edge-safe, zero `eval`, zero `node:*`):**
   - Walks the pre-compiled `TemplateAstNode[]` JSON and returns React elements directly (zero `dangerouslySetInnerHTML` for template nodes!).
   - Injects ONLY the read-only `StorefrontDataContext` (`lib/types/ecosystem.ts`) — guaranteed zero secrets, zero DB handles, zero `catalog_title`/`sku`.
   - Maps `<storeasy:*>` AST nodes to Storeasy's real React commerce components (`components/pdp/*`, `components/cart/*`, `components/BundleAddButton.js`, `components/plugins/PluginSlot.tsx`, etc.).

### 6.4 Database Migration
- `migrations/tenant/0029_themes.sql`:
  - `tenant_themes (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'draft', source TEXT NOT NULL DEFAULT 'upload', manifest_json TEXT NOT NULL, settings_schema_json TEXT NOT NULL, settings_data_json TEXT NOT NULL DEFAULT '{}', compiled_ast_json TEXT NOT NULL, scoped_css TEXT NOT NULL DEFAULT '', raw_files_json TEXT, preview_image_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT)`
  - `tenant_theme_revisions (id TEXT PRIMARY KEY, theme_id TEXT NOT NULL, settings_data_json TEXT NOT NULL, compiled_ast_json TEXT NOT NULL, scoped_css TEXT NOT NULL, note TEXT, created_by TEXT, created_at TEXT NOT NULL)`
  - Unique partial index ensuring at most ONE `role = 'live'` theme per tenant (switching live themes is an atomic transaction + `invalidateTenantCache(["theme", "release"])` + records revision for 1-click rollback).

### 6.5 Files to Create / Update
- `lib/themes/compiler.ts` — `.stml` tokenizer/parser → `TemplateAstNode[]`, strict security validator, zip unpacker (use pure JS zip reader like `fflate` or minimal ZIP parser; add dependency if needed).
- `lib/themes/css-sanitizer.ts` — CSS validator, URL rewriter, and `[data-theme-root]` scoper.
- `lib/themes/renderer.tsx` — Edge-safe AST-to-React renderer + `<storeasy:*>` primitive registry + `buildStorefrontDataContext()`.
- `lib/themes/service.ts` — Tenant Theme Library CRUD: `uploadThemeZip`, `installCatalogTheme`, `duplicateTheme`, `updateThemeSettings`, `updateThemeUiFile` (re-validates & re-compiles single `.stml` or `.css` file with revision snapshot!), `publishTheme`, `rollbackTheme`, `getActiveTheme`, `getPreviewTheme`.
- `lib/themes/packages/pulse/` & `lib/themes/packages/glow/` — Convert existing `pulse` and `glow` kits into genuine Open Theme Engine packages (with `theme.manifest.json`, `settings_schema.json`, `assets/theme.css`, `layout/theme.stml`, `templates/home.stml`) while preserving 100% compatibility with existing `test:design-doc`, `test:sections-render`, and `test:brand-step`.
- `app/api/admin/themes/route.ts`, `app/api/admin/themes/upload/route.ts`, `app/api/admin/themes/[id]/route.ts`, `app/api/admin/themes/[id]/publish/route.ts`, `app/api/admin/themes/[id]/files/route.ts` — Merchant Theme Library & safe UI-file edit APIs.
- `app/api/platform/themes/route.ts` — Operator Theme Store catalog & approval/suspension workflow.
- `app/(console)/admin/(authed)/themes/page.tsx` — Merchant Theme Library UI (Live Theme card, Draft Themes list, Upload `.storeasy-theme.zip` dropzone with instant validation report, Duplicate, Preview with `?themePreview=<id>`, Publish, Rollback, Customize button → `/admin/editor?theme=<id>`).
- `scripts/theme-cli.ts` (`pnpm theme:pack` / `pnpm theme:validate`) — Developer CLI so external creators can validate & pack a `.storeasy-theme.zip` locally.
- `scripts/test-themes-engine.js` — Registered in `package.json` (`test:themes-engine`) and `scripts/run-tests.js`.

### 6.6 Ready-to-Paste Claude Code Prompt (Phase 2B)
```text
Read docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md (Sections 1, 2, and 6) and lib/types/ecosystem.ts first.

Implement Phase 2B — Open Uploadable Theme Engine (Full UI Freedom, Zero Logic Access) on local `main` (do NOT push):
1. Add `migrations/tenant/0029_themes.sql` (`tenant_themes`, `tenant_theme_revisions`, with a unique partial index allowing at most one `role = 'live'` theme per tenant).
2. Build the logic-free template compiler & CSS sanitizer:
   - `lib/themes/compiler.ts` (Node-only upload/edit-time compiler): safely unpacks `.storeasy-theme.zip` (blocks zip-slip, >15MB, disallowed file extensions), parses `.stml` into `TemplateAstNode[]` (`text`, `expr` with safe filters, `element`, `primitive`, `if`, `for` capped at 100 iterations & depth 6, `slot`), strictly rejects `<script>`, `<iframe>`, `on*` handlers, `javascript:`, `eval`, and verifies required `<storeasy:*>` commerce primitives.
   - `lib/themes/css-sanitizer.ts`: blocks `@import`, `javascript:`, `expression()`, unsafe `url()`, scopes selectors to `[data-theme-root="<id>"]`, and emits CSS vars from `settings_schema.json`.
3. Build the Edge-safe runtime renderer `lib/themes/renderer.tsx` (zero `node:*` imports, zero `eval`, zero `dangerouslySetInnerHTML`): renders compiled `TemplateAstNode[]` to React elements with read-only `StorefrontDataContext` and maps `<storeasy:*>` primitives to Storeasy's protected commerce components.
4. Build `lib/themes/service.ts` supporting Upload `.zip`, Install from catalog, Duplicate, Update `settings_data`, Safe UI-only single-file edit (`updateThemeUiFile` re-compiles & snapshots revision), Atomic Publish (swaps `role='live'`, invalidates `["theme", "release"]` cache tags), and 1-Click Rollback.
5. Wire storefront rendering so an active tenant theme package renders cleanly when enabled, while falling back seamlessly to the existing Documents storefront renderer so all 80 existing test suites remain 100% green. Package `pulse` and `glow` as reference Open Theme Engine packages.
6. Build Merchant Theme Library APIs (`/api/admin/themes/**`) and UI (`/admin/themes`) with `.storeasy-theme.zip` upload, validation feedback, draft preview, live switch, rollback, and duplicate. Add `pnpm theme:validate` / `pnpm theme:pack` helper script.
7. Add `scripts/test-themes-engine.js` (register in `package.json` as `test:themes-engine` and `scripts/run-tests.js`) proving: valid zip compiles & renders with `<storeasy:add-to-cart />`, XSS/script/`on*`/`@import`/zip-slip payloads are rejected, loop DoS is capped, `StorefrontDataContext` strips `catalog_title`/`sku`/secrets, safe UI file edit works with rollback, and atomic theme switching isolates tenants.
8. Run `pnpm typecheck && pnpm build && pnpm test`. Fix any failures, then commit locally on `main` as `Phase 2B: Open uploadable theme engine — .stml AST compiler, CSS sanitizer, Edge renderer, protected primitives, and /admin/themes`.
```

---

## 7. Phase 3 — Visual Studio Editor, Theme Customizer & Console UX Overhaul

### 7.1 Scope & Objectives
1. **Full-Bleed `100dvh` 3-Pane Visual Studio Editor (`/admin/editor`):**
   - **Top Studio Bar:** Back to Console, Active Theme pill (Live vs. Draft theme), searchable `⌘K` Command Switcher (Pages, Products, Collections, Campaigns, Journal, Templates — removing the 50-collection cap via paginated/searchable `/api/admin/refs`), Viewport Switcher (`Mobile 390px` / `Tablet 768px` / `Desktop 1440px` + `Fit`/`100%`), Undo/Redo, Autosave indicator, **Edit UI Code** drawer toggle, Preview in new tab, Publish CTA.
   - **Left Rail:** Tabbed between **Layers / Sections** (drag-and-drop section & nested `blocks` reordering using `@dnd-kit/core` + `@dnd-kit/sortable`, visibility toggle, duplicate, delete, categorized Visual Section Picker: Core + Active Theme Sections + Installed Plugin App Blocks) and **Theme Settings** (auto-rendered from the active theme's `settings_schema.json`: Colors, Fonts, Buttons, Cards, Layout, Custom Scoped CSS).
   - **Center Canvas:** Responsive iframe with hover/selection outlines, quick floating section toolbar (Move Up/Down, Duplicate, Toggle Visibility, Delete), and **optimistic `<16ms` live preview** via typed `postMessage` (`PreviewBridge`) so edits & theme token sliders update immediately while autosave persists in the background.
   - **Right Inspector:** Tabbed contextual inspector (**Content** | **Style & Layout** | **Settings**) including per-section spacing/width/surface tone/mobile visibility controls and nested `blocks` editing.
   - **Safe Pro UI Code Drawer:** In-browser editor for the active draft theme's `.stml` templates, `styles/*.css`, and `settings_data.json` — calls `POST /api/admin/themes/[id]/files`, shows inline compiler/security errors, diff, and revision rollback (strictly UI-only, zero logic access).
   - **Fix Known Editor Gaps:** Clear `Product content: <Product Name>` labels in Media/Publishing; delete kept drafts in Earlier Versions; reusable saved sections & alternate template assignment per product/collection.
2. **Streamlined Merchant Console (`/admin`) & Global `⌘K` Palette:**
   - 4 crisp sidebar groups: **Home** (Dashboard, Analytics, Setup), **Store** (Orders, Products & Bundles, Customers, Themes & Editor, Media), **Marketing** (Offers, Upsells, Experiments, Automations), **Ecosystem & Settings** (Apps & Plugins, Billing, Team & Store).
   - Actionable Dashboard command center (live revenue/AOV/order sparklines, orders needing attention, sync health, single contextual setup banner).
3. **Multi-Route Platform Console (`/platform`):**
   - Decompose the 795-line monolithic `components/platform/PlatformAdmin.js` into focused sub-routes sharing a clean layout (`app/(console)/platform/(authed)/layout.tsx`): `/platform/tenants`, `/platform/tenants/[id]`, `/platform/themes`, `/platform/apps`, `/platform/queues`, `/platform/billing`, `/platform/incidents`, `/platform/partners`, `/platform/flags`. Keep `/platform` redirecting or rendering Overview so existing `/platform` tests stay green.
   - Also modularize any remaining oversized editor files (`DocumentEditor.js`, `editorModel.js`, `publishModel.js`) into clean `<300`-LOC modules as you upgrade them.

### 7.2 Ready-to-Paste Claude Code Prompt (Phase 3)
```text
Read docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md (Sections 1, 2, and 7) first.

Implement Phase 3 — Visual Studio Editor, Theme Customizer & Console UX Overhaul on local `main` (do NOT push):
1. Install `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (keep Next.js 16.2.9 and TypeScript 5.9.x unchanged).
2. Upgrade `/admin/editor` into a full-bleed `100dvh` 3-pane Visual Studio:
   - Top Bar: Back, Active Theme pill, searchable `⌘K` document/product/collection switcher (remove 50-collection cap via searchable ref lookup), Mobile/Tablet/Desktop viewport switcher, Undo/Redo, Autosave status, Safe UI Code drawer toggle, Preview, Publish.
   - Left Rail: `Sections` tab (`@dnd-kit` drag-and-drop for sections and nested `BlockInstance[]`, visibility toggle, duplicate/delete, Visual Section Picker grouped by Core / Theme / Plugin App Blocks) and `Theme Settings` tab (auto-rendered from active theme `settings_schema.json`).
   - Center Canvas: Optimistic `<16ms` live preview bridge (`postMessage` pushing draft document & theme CSS vars directly into the preview frame while autosave persists in background) + floating section toolbar.
   - Right Inspector: Tabbed `Content | Style & Layout | Settings` inspector with spacing, container width, surface tone, mobile visibility, and nested block controls.
   - Safe Pro UI Code Drawer: edits active theme `.stml` & `.css` via `/api/admin/themes/[id]/files` with live compiler/sanitizer validation and revision undo.
   - Keep all existing editor tests (`test:editor-*`, `test:preview-frame`, `test:publish-ui`, `test:design-doc`) passing!
3. Streamline Merchant Console sidebar (`components/console/nav/SidebarNav.js`) into 4 clean groups (Home, Store, Marketing, Ecosystem & Settings), upgrade `/admin/dashboard` with actionable KPIs & orders-needing-attention, and add a global `⌘K` Command Palette.
4. Decompose monolithic `components/platform/PlatformAdmin.js` into dedicated multi-route pages under `app/(console)/platform/` (`/tenants`, `/tenants/[id]`, `/themes`, `/apps`, `/queues`, `/billing`, `/incidents`, `/partners`, `/flags`) while keeping `/platform` working cleanly.
5. Add `scripts/test-studio-editor.js` (register in `package.json` as `test:studio-editor` and `scripts/run-tests.js`) covering nested block serialization/reordering, Theme Customizer settings persistence, safe UI code edit validation/rollback, searchable switcher pagination, and multi-route platform authz.
6. Run `pnpm typecheck && pnpm build && pnpm test`. Fix any failures, then commit locally on `main` as `Phase 3: Visual Studio 3-pane editor, Theme Customizer, safe UI code drawer, and multi-route Platform Console`.
```

---

## 8. Phase 4 — 5 Flagship Open-Engine Themes & Storefront Conversion UX

### 8.1 Scope & Objectives
1. **5 Flagship Open-Engine `.storeasy-theme` Packages** (in `lib/themes/packages/` and installable from `/admin/themes`):
   - `pulse` — Sports Nutrition & Performance (high-contrast dark/punchy, bold sans display)
   - `glow` — Beauty & Skincare (airy editorial, serif display, warm pastels)
   - `atelier` — Apparel & Luxury Lifestyle (minimalist monochrome, sharp corners, full-bleed imagery)
   - `vital` — Clinical Wellness & Supplements (clean cards, trust badges, ingredient transparency)
   - `craft` — Home, Food & Artisanal D2C (tactile warm earth tones, storytelling-forward)
   - Each package must have a distinct `theme.manifest.json`, rich `settings_schema.json` (Colors, Fonts, Buttons, Card Aspect Ratio `1:1`/`4:5`/`3:4`, Header/Footer style), scoped `assets/theme.css`, and `.stml` templates dogfooding the Phase 2B Open Theme Engine.
   - Replace hardcoded lime/status colors in `app/globals.css` with semantic theme CSS custom properties (`--color-success`, `--color-warning`, `--color-danger`, `--color-accent`).
2. **12+ High-Converting Core/Theme Sections** (registered in `lib/registry/sections.js` with nested `blocks` support and Edge-safe renderers):
   - Announcement Ticker / Marquee, Trust & USP Badge Bar, Split Feature Showcase, Video / Shoppable Reels Rail, Before/After Comparison Slider, Ingredients / Nutrition Facts Table, "As Seen In" Press Strip, Comparison Matrix ("Us vs. Others"), Countdown Promo Banner, Newsletter / WhatsApp VIP Capture, Bundle Showcase, Reviews & Photo UGC Wall, Multi-Column Benefits Grid.
3. **Upgraded Protected Commerce Primitives** (automatically lifts conversion across ALL built-in and uploaded themes):
   - `components/ProductCard.js`: Secondary image hover swap (desktop) / touch swipe dots (mobile), inline **Quick Add** + variant pills (single-click add to cart), dynamic Offer / Savings % / Rating badges.
   - `app/(storefront)/collections/[handle]/page.js` & `lib/search.js`: Full **multi-facet Typesense filtering** (Price range, Variant options like Flavor/Size/Shade, Tags/Goals, Product Type, In-Stock toggle — URL-synced, with SQLite fallback when Typesense is unconfigured) + **Predictive Search Dropdown** (`components/SearchOverlay.tsx`) with thumbnails, prices, trending queries, and zero-result recovery.
   - `components/pdp/PdpLayouts.js`: **Mobile Sticky Bottom Add-to-Cart Bar** (appears once main ATC scrolls out of view), **Interactive Variant Swatches** (color/flavor chips synced to gallery image, per-variant price & stock urgency), **Live Offer Callouts**, and **Frequently Bought Together** one-tap atomic bundle box (using Phase 1.2 `addItems`).
   - `components/cart/CartDrawer.js`: **Multi-Tier Gamified Progress Bar** (`Free Shipping` → `Free Gift`), **One-Click Available Coupons Drawer**, and **Smart Cart Upsells** with inline variant selector.

### 8.2 Ready-to-Paste Claude Code Prompt (Phase 4)
```text
Read docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md (Sections 1, 2, and 8) first.

Implement Phase 4 — 5 Flagship Open-Engine Themes & Storefront Conversion UX on local `main` (do NOT push):
1. Build 5 distinct, production-quality Open Theme Engine packages in `lib/themes/packages/{pulse,glow,atelier,vital,craft}` (each with `theme.manifest.json`, `config/settings_schema.json`, `config/settings_data.json`, `assets/theme.css`, `layout/theme.stml`, and `templates/*.stml`) and register them in the Theme Store catalog.
   - Replace hardcoded status/lime colors in `app/globals.css` with semantic theme CSS variables (`--color-success`, `--color-warning`, `--color-danger`).
2. Add 12+ high-converting D2C sections to `lib/registry/sections.js` and `components/sections/` (Marquee/Trust Bar, Split Feature, Video/Shoppable Reels, Before/After Slider, Ingredients/Nutrition Table, Press Strip, Comparison Matrix, Countdown Banner, Newsletter/VIP Capture, Bundle Showcase, Benefits Grid, UGC Wall) supporting nested `blocks` and mobile-first responsive layouts.
3. Upgrade Storeasy's protected commerce primitives (preserving `test:effective-read`, `test:images`, `test:sections-render`, `test:commerce-blocks`):
   - `components/ProductCard.js`: secondary hover image swap, inline Quick Add with variant pills, dynamic savings/offer badge.
   - Collection filtering & search: URL-synced multi-facet filters (price range, variant options, tags, product type, in-stock) via Typesense with SQLite fallback + instant Predictive Search Overlay with thumbnails and zero-result recovery.
   - `components/pdp/PdpLayouts.js`: Mobile Sticky Bottom ATC bar, interactive variant swatches synced with gallery/stock urgency, live offer callouts, and one-tap Frequently Bought Together box using atomic `addItems`.
   - `components/cart/CartDrawer.js`: Multi-tier gamified progress bar (Free Shipping → Free Gift), One-Click Available Coupons list, and Smart Cart Upsells with variant selector.
4. Add `scripts/test-storefront-ux.js` (register in `package.json` as `test:storefront-ux` and `scripts/run-tests.js`) verifying: all 5 flagship themes compile & render cleanly through the Open Theme Engine, all 12+ new sections validate & render without XSS, multi-facet collection filters work with SQLite fallback, and tiered cart progress/coupons compute accurately.
5. Run `pnpm typecheck && pnpm build && pnpm test`. Fix any failures, then commit locally on `main` as `Phase 4: 5 flagship open-engine themes, 12+ D2C sections, and storefront conversion UX upgrades`.
```

---

## 9. Phase 5 — India D2C & Global-Ready Checkout & Offer Engine

### 9.1 Scope & Objectives
1. **India D2C Checkout Superpowers (`components/checkout/CheckoutFlow.js` + `app/api/checkout/route.js`):**
   - **Pincode Auto-Fill & Serviceability (`app/api/pincode/[code]/route.ts`):** Typing a 6-digit India PIN auto-fills City & State (built-in lightweight prefix/lookup table + optional `shipping.provider` plugin hook for live Shiprocket/Delhivery ETA & COD eligibility) and shows delivery ETA before payment. Also expose as `<storeasy:pincode-check />` on PDP!
   - **COD-to-Prepaid Nudge & RTO Protection:** Optional merchant-configured prepaid incentive in `tenant.config.checkout` (e.g., `prepaidDiscountFlat` / `prepaidDiscountPct`, "Save ₹50 + Skip ₹49 COD fee by paying via UPI") recomputed strictly server-side in checkout, plus optional **COD OTP verification** (`POST /api/checkout/cod-otp` — rate-limited via `rateLimitAsync`, hashed 6-digit OTP with 5-minute TTL, sent via notification channel) for orders above a merchant-configured COD threshold.
   - **Frictionless Razorpay / UPI Flow:** Use tenant's brand `accent` color in Razorpay modal options (replacing hardcoded `#0a0a0b`), highlight UPI intent/QR, and add automatic client-side payment status polling fallback if callback drops.
2. **Global-Ready Generalization:**
   - Remove hardcoded `country: "India"` in `CheckoutFlow.js` and hardcoded `₹` strings in `lib/shipping.js` — format dynamically via tenant `currency`, `locale`, and `allowedCountries` (defaulting cleanly to `IN` / `INR` when unset so zero existing tests break!).
   - Support decimal-accurate currency discounts (minor-unit / 2-decimal math outside `INR` while preserving integer INR rounding compatibility with existing `test:offers`).
   - Pluggable payment provider abstraction (`lib/payments/provider.ts`) supporting **Razorpay** (India) and **Stripe PaymentIntents** (Global, activated when tenant configures Stripe keys) cleanly without changing existing Razorpay flows.
3. **Shopper Convenience:**
   - **Saved Customer Addresses (`customer_addresses` table):** Signed-in shoppers (`/account`) can save, edit, delete, and select a default shipping address for 1-tap repeat checkout.
   - **In-Checkout Coupon Box** & itemized savings breakdown (re-using server-side cart/offer evaluation).
   - **Real-Time Shipping & Stock Re-verification** on checkout load (preventing stale-tab "total changed" surprises).
4. **Offer & Bundle Engine Enhancements:**
   - **Collection-Targeted Offers (`target.collections`):** Evaluate offers targeting Shopify collections alongside products/variants/tags (`lib/offers/` + `/admin/offers` target picker).
   - **Bundle Stock & Scheduling:** Validate required component quantities against variant inventory (e.g., a 2× pack fails cleanly if `inventory_quantity === 1`) and enforce optional `starts_at` / `ends_at` schedule windows on bundles.

### 9.2 Database Migration
- `migrations/tenant/0030_checkout_addresses_offers.sql`:
  - `customer_addresses (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, label TEXT, full_name TEXT NOT NULL, phone TEXT, line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, state TEXT NOT NULL, postal_code TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'IN', is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  - `checkout_otps (id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, verified_at TEXT, created_at TEXT NOT NULL)`
  - Additive columns on `bundles`: `ALTER TABLE bundles ADD COLUMN starts_at TEXT;` and `ALTER TABLE bundles ADD COLUMN ends_at TEXT;`

### 9.3 Ready-to-Paste Claude Code Prompt (Phase 5)
```text
Read docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md (Sections 1, 2, and 9) first.

Implement Phase 5 — India D2C & Global Checkout, Saved Addresses & Offer Engine on local `main` (do NOT push):
1. Add `migrations/tenant/0030_checkout_addresses_offers.sql` (`customer_addresses`, `checkout_otps`, and additive `starts_at`/`ends_at` on `bundles`).
2. Implement India D2C checkout superpowers:
   - `app/api/pincode/[code]/route.ts` + `lib/pincode.ts`: 6-digit Indian PIN → City/State auto-fill + merchant shipping zone ETA & COD eligibility check (pluggable via `shipping.provider` plugin hook). Wire into Checkout AND `<storeasy:pincode-check />` PDP primitive.
   - COD-to-prepaid server-recomputed incentive + optional rate-limited COD OTP verification (`app/api/checkout/cod-otp/route.ts`) for high-value COD orders.
   - Brand-colored Razorpay modal (using tenant `brand.accent` instead of `#0a0a0b`) + payment-status polling fallback.
3. Generalize for Global D2C (while preserving 100% backward compatibility with INR/India defaults and existing `test:shipping`, `test:orders`, `test:offers`, `test:commerce`):
   - Format shipping/COD copy dynamically using tenant `currency` & `locale` (removing hardcoded `₹` in `lib/shipping.js` and hardcoded `India` in `CheckoutFlow.js`).
   - Support 2-decimal currency math for non-INR currencies (`USD`, `EUR`, `GBP`, etc.).
   - Add pluggable `lib/payments/provider.ts` supporting Razorpay + Stripe (when tenant Stripe keys are configured).
4. Add Saved Customer Addresses CRUD (`/api/account/addresses`, `/account` address book UI, and 1-tap address selector in `CheckoutFlow.js`), In-Checkout Coupon Box, and live stock/shipping re-verification on checkout load.
5. Upgrade Offers & Bundles:
   - Add `target.collections` collection-targeted offers in `lib/offers/` and `/admin/offers`.
   - Enforce component quantity stock checks and `starts_at`/`ends_at` scheduling on bundles.
6. Add `scripts/test-checkout-india-global.js` (register in `package.json` as `test:checkout-india-global` and `scripts/run-tests.js`) testing: pincode auto-fill & zone ETA, server-recomputed prepaid nudge, COD OTP issue/verify/rate-limit/expiry, USD/EUR multi-currency checkout & shipping formatting, saved addresses cross-customer isolation, collection-targeted offers, and bundle stock/schedule enforcement.
7. Run `pnpm typecheck && pnpm build && pnpm test`. Fix any failures, then commit locally on `main` as `Phase 5: India D2C & global checkout, pincode lookup, COD OTP/prepaid nudge, saved addresses, and collection offers`.
```

---

## 10. Phase 6 — First-Party Ecosystem Plugins (Dogfooding the Plugin SDK)

### 10.1 Scope & Objectives
Dogfood the Phase 2A Plugin System by shipping 5 high-impact D2C plugins under `lib/plugins/first-party/`:

1. **`@storeasy/plugin-reviews` (Verified Reviews & Photo UGC):**
   - Tables: `product_reviews`, `review_media`, `review_invites`.
   - Verified Buyer badge automatically verified against Storeasy's `orders` ledger (cannot be spoofed).
   - Post-delivery review invite job + signed one-click submission link (`/reviews/submit/[token]`).
   - Storefront App Blocks via `<PluginSlot />`: Rating Stars Badge (`ProductCard` / `pdp.under_price`), Reviews Wall + Photo UGC (`pdp.below_fold`), JSON-LD `AggregateRating` SEO snippet.
   - Merchant moderation panel at `/admin/apps/reviews` (Approve / Hide / Reply / Pin).

2. **`@storeasy/plugin-subscriptions` (Subscribe & Save):**
   - Tables: `subscription_plans`, `customer_subscriptions`.
   - PDP `pdp.under_price` / `pdp.under_atc` slot: "One-time purchase" vs. "Subscribe every 15/30/60 days — Save X%".
   - Integrates with Razorpay Subscriptions API (or Stripe Subscriptions) + webhook renewal sync.
   - Self-serve shopper tab in `/account`: Pause, Skip next cycle, Swap variant/flavor, Change frequency, Cancel.

3. **`@storeasy/plugin-whatsapp` (WhatsApp & SMS Commerce):**
   - Pluggable notification channel adapter supporting **WhatsApp Business Cloud API**, **Interakt**, and **Gupshup** alongside Resend Email in `lib/notifications.js`.
   - Transactional hooks (`order.created`, `order.paid`, fulfillment shipped, COD OTP) + marketing hooks strictly gated by existing `consent_class = 'marketing'` and `consent_ref` (abandoned cart recovery, back-in-stock, reorder reminders).

4. **`@storeasy/plugin-shiprocket` (India Logistics & Live Tracking):**
   - Implements the `shipping.provider` pincode serviceability/ETA hook (used by Phase 5 Checkout & PDP `<storeasy:pincode-check />`).
   - Outbound `order.paid` / `order.created` (COD) shipment creation + inbound tracking webhook (`/api/plugins/shiprocket/webhook`) updating live tracking status & AWB on `/orders/[orderId]` and `/account`.

5. **`@storeasy/plugin-ai-copilot` (Multi-Provider Merchant AI Copilot):**
   - Upgrades `lib/ai/insights.js` from Anthropic-only to a **provider-agnostic LLM adapter** (`lib/ai/provider.ts`) supporting **Gemini** (`GEMINI_API_KEY`), **Anthropic** (`ANTHROPIC_API_KEY`), and **OpenAI** (`OPENAI_API_KEY`) selected via `AI_PROVIDER` env var (with strict token budgets, zero PII sent to LLMs, and deterministic mock adapter for tests).
   - Strictly writes to **drafts only** (never auto-publishes!) and enforces existing forbidden-claims guardrails:
     - **Brand-to-Storefront Generator:** Generates starter Home sections + theme palette/font recommendations as a draft.
     - **PDP Merchandising Enricher:** Generates SEO title/meta, benefit bullets, and FAQs into `product_content` drafts.
     - **Conversion Intelligence:** Analyzes zero-result searches & cart drop-offs to propose draft Bundles / Offers.

### 10.2 Database Migration
- `migrations/tenant/0031_first_party_plugins.sql`:
  - `product_reviews`, `review_media`, `review_invites`
  - `subscription_plans`, `customer_subscriptions`
  - `shipment_tracking` (AWB, courier, status, tracking_url, events_json, synced_at)
  - `ai_usage_ledger` (tenant token budget tracking per day/month)

### 10.3 Ready-to-Paste Claude Code Prompt (Phase 6)
```text
Read docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md (Sections 1, 2, and 10) first.

Implement Phase 6 — First-Party Ecosystem Plugins (Dogfooding the Phase 2A Plugin SDK) on local `main` (do NOT push):
1. Add `migrations/tenant/0031_first_party_plugins.sql` (`product_reviews`, `review_media`, `review_invites`, `subscription_plans`, `customer_subscriptions`, `shipment_tracking`, `ai_usage_ledger`).
2. Build 5 modular first-party plugins in `lib/plugins/first-party/`, each registering cleanly through the Phase 2A Plugin Registry:
   - `reviews/`: Verified buyer reviews tied to `orders`, tokenized submission flow, moderation queue in `/admin/apps/reviews`, storefront rating stars + reviews wall slots, and `AggregateRating` JSON-LD.
   - `subscriptions/`: Subscribe & Save plans, PDP toggle slot, Razorpay/Stripe recurring plan sync, and `/account` self-serve Pause/Skip/Swap/Cancel UI.
   - `whatsapp/`: WhatsApp Cloud API / Interakt / Gupshup notification channel adapter wired into `lib/notifications.js`, with transactional templates and strictly consent-gated (`consent_class='marketing'`) abandoned-cart recovery.
   - `shiprocket/`: Live pincode ETA/COD hook for Phase 5 checkout/PDP + AWB shipment tracking webhook syncing into `/orders/[orderId]` and `/account`.
   - `ai-copilot/`: Multi-provider LLM adapter (`lib/ai/provider.ts` supporting Gemini, Anthropic, OpenAI via `AI_PROVIDER`, zero PII, daily token budget, draft-only output honoring forbidden-claims guardrails) powering Brand-to-Storefront draft generation, PDP SEO/FAQ enrichment, and conversion offer proposals.
3. Add `scripts/test-ecosystem-plugins.js` (register in `package.json` as `test:ecosystem-plugins` and `scripts/run-tests.js`) testing all 5 plugins end-to-end with mocked external HTTP calls, verifying tenant isolation, verified-buyer integrity, marketing consent gating, token budget enforcement, and draft-only AI safety.
4. Run `pnpm typecheck && pnpm build && pnpm test`. Fix any failures, then commit locally on `main` as `Phase 6: First-party plugins — verified reviews, subscriptions, WhatsApp commerce, Shiprocket logistics, and multi-provider AI Copilot`.
```

---

## 11. Claude Code Working Discipline & Troubleshooting Quick-Reference

- **Always commit locally on `main` only** (never `git push` unless the user explicitly asks).
- **Pre-commit check before every commit:**
  ```bash
  pnpm typecheck && pnpm build && pnpm test
  ```
- **Common Gotchas Already Solved (Don't Re-Hit Them):**
  1. `test:shopify-boundary` fails if ANY file defines `*_SCOPES =` outside `lib/platform/oauth.js`. Use `*_PERMISSIONS =` or `*_CAPABILITIES =` instead.
  2. `test:shopify-boundary` (`SHOP-06`) fails if you create `scripts/test-*.js` without adding it to BOTH `package.json` and `scripts/run-tests.js`.
  3. `test:security` checks `git ls-files app/api`. If you add a new API route, stage it (`git add`) before running `pnpm test` so `test:security` audits it immediately.
  4. Never upgrade `typescript` past `5.9.x` while on Next.js `16.2.9`.
  5. Keep all storefront-imported runtime modules 100% free of `node:*` imports (Edge-safe).
  6. Never modify `docs/CMS_CLAUDE_DIRECTION_BRIEF.md`, `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md`, or `docs/CMS_SESSION_HANDOFF.md`.
