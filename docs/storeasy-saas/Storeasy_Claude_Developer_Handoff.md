# Storeasy — Claude developer handoff

Version 1.0 • 27 October 2026 • Repository implementation brief

## 1. Objective

Enhance the existing Storeasy application into a repeatable multi-tenant Shopify storefront SaaS. Build on the existing commerce and tenant foundation. The immediate product is a secure storefront, merchant onboarding, a configurable template system, reliable publishing, subscriptions and useful reporting. The first validation milestone is three to five paying merchants with independent Shopify installations.

The commercial aspiration is $1 million annual recurring revenue. That is a business objective, not an engineering acceptance test or a guaranteed outcome. Do not invent conversion lifts, customer testimonials, approvals or completed integrations.

This handoff contains **116 feature records: 80 frontend and 36 backend**. Every record in `Storeasy_Enhanced_Feature_List.md` has an ID, route/service, priority, implementation requirements, dependencies and acceptance checks. The JSON carries the same information for extracting a small working batch. None of these statuses claims that the repository has been audited or changed.

## 2. How to use this package with Claude

1. Extract this package into `docs/storeasy-saas/` inside the existing repository. If that path is already used, choose a new directory without overwriting existing project guidance.
2. Keep the current Storeasy platform guide available alongside the repository. Do not copy credentials from the guide into prompts, issues or new documentation.
3. Paste `CLAUDE_START_PROMPT.txt` into Claude with repository access.
4. Claude first reads this handoff, the feature index and applicable repository instructions. It then reads only the selected feature cards and relevant reference contracts in detail.
5. Claude audits the actual implementation, records gaps with real file paths, and implements a coherent bounded slice. It does not need to ask approval again for routine local fixes within the user's instruction.

This package does not replace an existing `CLAUDE.md`, `AGENTS.md`, security policy or repository conventions. Do not overwrite those files with this brief. If Claude lacks repository access, it should state that limitation, produce a proposed first-slice plan, and request the repository rather than pretending to have edited it.

## 3. Evidence and existing implementation

The supplied post-S24 guide reports the following; verify each item in code before classifying it as complete:

| Area | Reported baseline | Implementation direction |
| --- | --- | --- |
| Runtime | Next.js 16 App Router, JavaScript ESM, pnpm | Preserve existing conventions; no framework/language rewrite |
| Data | Turso/libSQL, Kysely, database per tenant | Preserve isolation pattern; add explicit context and migration discipline |
| Search | Typesense with SQL fallback; availability needs repair | Restore a bounded adapter and expose health |
| Commerce | Catalog sync, server cart, offers, Razorpay/COD and Shopify order push | Verify authorization and migrate toward the supported Shopify authority model |
| Merchant tools | Offers, orders, storefront, upsell and settings tabs | Extend into a coherent merchant workspace without discarding working logic |
| CMS | Basic structured content forms | Add versioned templates, drafts, preview, release and rollback |
| Operations | Operator console, health checks, after-response tasks and daily sweep | Add durable jobs, actual alert delivery, distributed limits and recovery |
| Deployment | Guide describes production/staging at S20, later work local | Audit actual deployment and rehearse migrations before cutover |

Reported defects to verify first: default-tenant fallback on invalid/suspended/unresolved hosts; order confirmation PII retrievable by order ID; shared password-derived sessions; non-durable asynchronous work; missing pruning after catalog sync; timezone round-trip errors; hidden CMS pages missing from the editor; upsell edits enabling a disabled placement; hardcoded brand/offer defaults; secret-key rotation that can orphan ciphertext.

The guide reports tenant-scoped Razorpay keys, browser pixels and `write_orders` scope already fixed. Preserve those regressions rather than reimplementing them blindly. The guide's reported 148 checks and two-tenant dry run are not independent verification, and two tenants on the same development shop do not prove unrelated-merchant isolation.

## 4. Architecture decisions to preserve

- One shared codebase and component registry. Tenant differences live in configuration, data and immutable content releases.
- Keep Next.js, JavaScript ESM, pnpm, Turso/libSQL and Kysely. Use a modular application with web and durable worker execution; do not introduce a microservice fleet or MongoDB rewrite without an observed reason.
- A tenant is one storefront bound to one verified Shopify shop. An organization may own several tenants. An agency needs explicit client grants. Environment is part of context and never inferred from a user-supplied store ID alone.
- Shopify owns commerce catalog values, inventory, checkout totals, tax, payments, orders and refunds. Storeasy owns presentation, merchandising intent, draft/releases and reconciled reporting projections.
- Retain an adapter boundary for commerce. Existing direct Razorpay/COD behavior must not become the default public SaaS path without documented authorization. Preserve and reconcile in-flight transactions during migration; do not abruptly remove their callbacks or fabricate refund state.
- Never infer legal/platform permission from successful API access. Confirm actual approval records and current official Shopify requirements when implementing distribution, billing, checkout or protected customer data. The earlier research identifies API-version and commercial-hosting work; treat its date as a snapshot.
- Use individual identities, server authorization and revocation. Merchant, customer and operator access are distinct domains. Secrets are never readable as plaintext through ordinary UI APIs.

## 5. Release waves and bounded delivery

Priority is risk/value, not a dependency sort: **P0 = launch gate; P1 = sellable-product scope; P2 = retention/expansion; P3 = optional later work**. There are 25 P0, 65 P1, 24 P2 and 2 P3 records. A P0 journey may need a minimal portion of a P1 service. Build that dependency explicitly; do not skip it because its label is lower.

| Wave | Result | Core feature groups | Exit evidence |
| --- | --- | --- | --- |
| W0 — Repository audit | Grounded gap map and safe first slice | All records classified, first slice selected | Actual paths, baseline test results, unresolved external dependencies |
| W1 — Identity and tenancy | Fail-closed hosts, memberships, sessions, secrets and migrations | BE01–03, BE12–13, BE16–17, MC01, OP01, SF23 core | Two-tenant negative tests; no default-store leak; revocation enforced |
| W2 — Reliable commerce | Durable events, supported commerce contracts, protected orders and recovery | BE04, BE06–07, BE10, BE14, BE18–20, BE24–25, BE27, BE34, BE36; cart/order/consent and operator safety screens | Provider reconciliation, failure/replay tests, documented approval status, restore evidence |
| W3 — Storefront product | Pulse/Glow kits, core pages, editor, preview and releases | BE05, BE08–09, BE15, BE23; SF01–05, SF13–17; MC05–15, OP07 | Tenant-specific pages; no draft/live leakage; publish and rollback demonstrated |
| W4 — Sellable SaaS | Onboarding, domains UX, billing, team, reports, exports and operational workflows | BE11, BE21, BE26, BE29, BE33, BE35 and remaining P1 UI | Independent merchants launch, billing matches entitlements, offboarding works |
| W5 — Expansion | Customer accounts, bundles, product finder, experiments, AI and agencies | Remaining P2 records | Each feature enabled only after its data/provider/permission prerequisites pass |
| W6 — Optional | Wishlist and automations | SF22, MC28 | A customer need and compatible integration justify delivery |

The feature index records the first implementation wave. That is not a promise that every sub-feature finishes there. Explicit staged cases: SF23 starts with safe neutral/known-host error handling in W1 and gets full published branding in W3; MC15 starts with basic upsells and adds advanced bundle behavior only with BE31 in W5. External approvals, real provider accounts and paid service activation are tracked separately from code completion.

Do not assign calendar estimates until the repository audit and team capacity are known. Do not attempt all 116 records in one change set.

## 6. First execution slice for Claude

**Start with BE01 plus the minimum SF23 behavior**, after reading the repository and running the existing relevant baseline checks. Audit SF08 at the same time; if its documented exposure is confirmed, record it as the next urgent slice and apply a safe containment fix when possible without inventing identity semantics.

For the first slice:

1. Find the actual host-resolution and default-tenant branches, control-plane lookup, middleware, database factory and public response caching.
2. Trace representative storefront, admin and background entry points. Write a short contract for trusted tenant/environment context using actual project types/conventions.
3. Make unknown, suspended or unresolved production hosts fail closed. Keep a clearly bounded local-development behavior only if the repository requires it; it must not activate implicitly in production.
4. Implement neutral unknown-host and safe known-store unavailable states without reading another tenant's content. Any last-known read-only behavior must have an explicit freshness/invalidation policy; default to unavailable until that policy exists.
5. Add meaningful negative tests using two unrelated tenant fixtures with overlapping handles, and test control-plane failure. Ensure no shared cache entry can substitute a different store.
6. Run the actual relevant checks and report changed files, exact commands/results, residual issues and the next slice. Update `docs/storeasy-saas/IMPLEMENTATION_STATUS.md` if that directory is the chosen handoff location.

If BE01 is already complete, demonstrate that with evidence and select the next unmet P0 slice, normally SF08 protection or BE02/BE03 identity. Do not replace working code merely to match a proposed filename or route in this package.

## 7. Tenant customization contract

| Surface | Merchant can customize | Protected behavior |
| --- | --- | --- |
| Storefront global | Logo, approved fonts, colors, spacing, radius, header/footer, announcements | Tenant routing, authorization, consent semantics and commerce ownership |
| Storefront page | Allowed section order, content, visibility, media and layout settings | Required purchase facts, valid links, accessible controls and supported components |
| Product/collection | Template assignment, presentation copy, approved display badges and guides | Source price, stock, tax and final order/payment values |
| Campaign | Page composition, selected products, dates and attribution context | Supported discounts, permitted analytics and publication controls |
| Checkout/account | Only capabilities allowed by the provider and merchant plan | Payment processing, identity, total calculation and provider restrictions |
| Merchant/agency workspace | Limited logo/accent or report branding where useful | Navigation semantics, roles, billing controls and audit integrity |
| Operator console | Platform design conventions | Fleet permissions, support grants and incident/audit boundaries |

Resolution for style/content: platform defaults → pinned theme version → tenant token overrides → page-type template → explicit assignment → permitted page content. Assignment selection: explicit entity first, then ranked matching rules, then page-type default, then theme default. Reject equal-priority ambiguity. Device settings may change layout; they must not hide required price, stock or consent information.

All 24 shopper feature families have reference mappings. Some represent overlays or provider handoffs rather than fully editable local pages. `/pages/contact` and `/pages/faq` are specific route contracts that may use the general content implementation; avoid duplicate routers. Merchant/operator/agency pages use a shared application shell, not arbitrary per-tenant code forks.

Pulse (nutrition) and Glow (beauty) are the first kits. Mode (apparel), Haven (home), Pantry (food) and Essential (general D2C) are planned expansion kits. The bundled tenant examples demonstrate nutrition, beauty and fashion; they are reference configuration, not production component implementations or proof of six finished themes.

## 8. Data and service contracts

Use `reference/Implementation_Specification.md` for proposed entities, API contracts, roles and state machines. Map them to the actual repository rather than creating parallel tables/routes by default.

Minimum rules:

- `tenant_id` is immutable internal identity, and environment travels with every trusted request/job context. Public body/path IDs do not authorize access.
- Public cache keys include tenant, environment, release and relevant locale/currency. Account/order responses are not shared-cacheable. Preview content is private and does not contaminate published caches.
- Use currency metadata and integer minor-unit amounts. Never assume all currencies have two decimals. Distinguish estimates from final Shopify amounts.
- Draft writes include an expected revision. A conflicting update returns a meaningful conflict and preserves both users' work for resolution.
- Releases are immutable snapshots with content hash and pinned dependencies. Scheduled publication references the approved snapshot. Rollback is an audited pointer/release operation, not destructive deletion of later drafts.
- Persist a verified webhook receipt before acknowledgement. Derive shop binding from trusted registration and verified event context; do not trust an unsigned routing header alone. Worker idempotency survives process restarts.
- Keep order, financial and fulfillment states separate. Out-of-order events trigger authoritative reconciliation when timestamps/version semantics are insufficient.
- Billing provider status controls entitlements; client plan flags do not. Separate release flags, purchased permissions and operational quotas.
- Failures return stable codes, request IDs and field errors where applicable. Use appropriate status codes, including conflict, validation, forbidden and rate-limit responses. Do not return success for discarded work.

Reference JSON schemas prove structural shape only. Production validation must also check tenant ownership, component settings, catalog existence, capabilities, links, media, accessibility and supported commerce behavior. Do not adopt permissive reference fields as permission for arbitrary HTML, scripts or untrusted URLs.

## 9. Shared UX and verification rules

All user-facing features need relevant loading, empty, unavailable, error and success states. Protected screens need access-denied/session-expired behavior. Editable screens need saving, dirty, saved, invalid and conflict states. Do not render unknown metrics as zero or show a successful action before provider acknowledgement when acknowledgement is required.

Check core journeys at 360, 390, 768, 1024 and 1440 pixels, keyboard navigation, focus restoration, form labels, contrast, 200% zoom and reduced motion. Measure performance with realistic catalogs and mobile conditions; field behavior and vendor limits still need observation. Use genuine merchant content and reviews, not seeded proof claims.

Testing should target real failure modes. Add automated regression coverage for money, tenant isolation, authentication, idempotency, data migration and release integrity. For simple presentation work, a documented visual/interaction check may be enough; do not create tests that merely repeat implementation details. Use mocks for development, label them, and keep external verification separately incomplete until exercised against authorized systems.

Required high-risk fixtures: two unrelated stores with overlapping handles; revoked staff access; guessed order ID; partial catalog sync; duplicate/out-of-order event; unavailable gift; price/stock change; partial refund; conflicting draft; expired preview; failed scheduled publish; failed migration; tenant restore; consent withdrawal; cancellation/offboarding.

## 10. What done means

A feature is done when the agreed release slice is implemented, wired end to end, authorized on the server, has relevant error states, passes appropriate checks and carries actual repository evidence. A placeholder button, static dashboard, mock response or credential form alone is not a completed integration.

Track separately: code complete, local checks passed, staging/provider verified, external approval complete and production enabled. A pending external approval must not prevent unrelated local development, and local success must not be described as approval.

Before a production release, require tenant/identity and money-path verification, supported deployment configuration, working alerts, backup/restore evidence, privacy/uninstall behavior and a reversible cutover plan. Keep deployment, DNS changes, real charges, customer messages and destructive migrations outside this handoff's automatic execution scope; handle those under the user's explicit operational authorization.

Every implementation response should state: selected feature IDs and slice; changed files; migrations/configuration; checks actually run and results; unresolved dependencies; and the next useful slice. Never say tests passed if they were not run. Avoid claiming business revenue or conversion results from code changes.

## 11. Package precedence and corrections

This handoff and the enhanced feature JSON/Markdown refine the earlier implementation pack. Where they differ, use this newer feature scope, subject to actual repository instructions and observed constraints:

- SF19 is a deterministic product finder first; BE32 is optional for later AI assistance. No AI dependency blocks the basic quiz.
- MC15 basic upsells do not depend on the full BE31 bundle/subscription platform. Advanced bundle behavior remains gated.
- BE02 requires revoked/expired sessions to fail and stolen-session reuse to fail after revocation. It does not claim every still-valid stolen session is automatically detectable.
- SF23 uses neutral responses when tenant identity is unknown; tenant branding is allowed only after safe resolution.
- Conditional checkout replacement requires confirmed integration authority and careful migration of pending transactions.

Routes and entity names in this package are proposed contracts. Rename or reuse existing equivalents when appropriate, record the mapping, and preserve public URLs or add tested redirects. The package is a development specification, not a new source of product approvals or live production configuration.
