# Storeasy — Enhanced feature list for Claude

Version 1.0 • 27 October 2026 • 80 frontend records + 36 backend capabilities

This is the explicit implementation inventory. Read `Storeasy_Claude_Developer_Handoff.md` first for scope, source ownership, execution order and shared acceptance rules. Every feature starts **not inspected**: the suggested Fix/Extend/New label is based on the platform guide, not a code audit.

## Quick scope

| Area | Records | What it includes |
| --- | --- | --- |
| Shopper storefront | 24 | Home, collections, product, search, cart, authorized checkout, orders, account, content and growth journeys |
| Merchant workspace | 28 | Onboarding, editor, templates, brand, offers, orders, reporting, billing, team and operations |
| Platform operator | 14 | Tenant lifecycle, provisioning, jobs, releases, templates, security, cost and incidents |
| Agency workspace | 6 | Client grants, portfolio, private kits, approvals, referrals and reports |
| SaaS website | 8 | Product, pricing, gallery, solutions, integrations, proof, docs and contact |
| Backend services | 36 | Identity, tenant isolation, commerce, content, publishing, integrations, billing and reliability |

## Priorities and completion

P0: 25 launch-gate records. P1: 65 sellable-product records. P2: 24 expansion records. P3: 2 optional records. Wave is the first core implementation stage, not a promised completion date. A feature is complete only after its selected scope is wired end to end and its acceptance evidence is recorded. Do not mark a mock, placeholder or unavailable external integration complete.

For every feature apply relevant loading, empty, error, success and permission states; accessible responsive behavior; server authorization; tenant isolation; and appropriate audit/telemetry. Use automated checks for consequential behavior and visual/manual checks where suitable. The scenario on each card is a concrete verification case, not a claim that a test has already passed.

## Feature index

### Shopper storefront

| ID / feature | Priority | First wave | Reported change |
| --- | --- | --- | --- |
| [SF01: Homepage](#sf01-homepage) | P1 | W3 | Extend |
| [SF02: Collection index](#sf02-collection-index) | P1 | W3 | Extend |
| [SF03: Collection detail](#sf03-collection-detail) | P1 | W3 | Extend |
| [SF04: Product detail](#sf04-product-detail) | P1 | W3 | Extend |
| [SF05: Search and suggestions](#sf05-search-and-suggestions) | P1 | W3 | Extend |
| [SF06: Cart](#sf06-cart) | P0 | W2 | Fix |
| [SF07: Checkout handoff](#sf07-checkout-handoff) | P0 | W2 | Replace conditionally |
| [SF08: Confirmation](#sf08-confirmation) | P0 | W2 | Fix |
| [SF09: Order tracking](#sf09-order-tracking) | P1 | W2 | Extend |
| [SF10: Customer sign in](#sf10-customer-sign-in) | P2 | W5 | New |
| [SF11: Customer order list](#sf11-customer-order-list) | P2 | W5 | New |
| [SF12: Profile and addresses](#sf12-profile-and-addresses) | P2 | W5 | New |
| [SF13: Flexible content](#sf13-flexible-content) | P1 | W3 | Extend |
| [SF14: Policy pages](#sf14-policy-pages) | P1 | W3 | Extend |
| [SF15: Contact and help](#sf15-contact-and-help) | P1 | W3 | Extend |
| [SF16: FAQ](#sf16-faq) | P1 | W3 | New |
| [SF17: Campaign landing](#sf17-campaign-landing) | P1 | W3 | New |
| [SF18: Bundle detail](#sf18-bundle-detail) | P2 | W5 | New |
| [SF19: Product finder](#sf19-product-finder) | P2 | W5 | New |
| [SF20: Editorial content](#sf20-editorial-content) | P2 | W5 | New |
| [SF21: Return request](#sf21-return-request) | P2 | W5 | New |
| [SF22: Wishlist](#sf22-wishlist) | P3 | W6 | New |
| [SF23: Offline and errors](#sf23-offline-and-errors) | P0 | W1 | Fix |
| [SF24: Consent settings](#sf24-consent-settings) | P0 | W2 | Extend |

### Merchant workspace

| ID / feature | Priority | First wave | Reported change |
| --- | --- | --- | --- |
| [MC01: Merchant sign in](#mc01-merchant-sign-in) | P0 | W1 | Replace |
| [MC02: Onboarding checklist](#mc02-onboarding-checklist) | P1 | W4 | New |
| [MC03: Store switcher](#mc03-store-switcher) | P1 | W4 | New |
| [MC04: Merchant dashboard](#mc04-merchant-dashboard) | P1 | W4 | New |
| [MC05: Catalog browser](#mc05-catalog-browser) | P1 | W3 | New |
| [MC06: Collection merchandising](#mc06-collection-merchandising) | P1 | W3 | New |
| [MC07: Theme library](#mc07-theme-library) | P1 | W3 | New |
| [MC08: Visual editor](#mc08-visual-editor) | P1 | W3 | Replace |
| [MC09: Page templates](#mc09-page-templates) | P1 | W3 | New |
| [MC10: Brand system](#mc10-brand-system) | P1 | W3 | Extend |
| [MC11: Menus and footer](#mc11-menus-and-footer) | P1 | W3 | Extend |
| [MC12: Content and media](#mc12-content-and-media) | P1 | W3 | Extend |
| [MC13: Drafts and releases](#mc13-drafts-and-releases) | P1 | W3 | New |
| [MC14: Offers](#mc14-offers) | P1 | W2 | Fix |
| [MC15: Upsells and bundles](#mc15-upsells-and-bundles) | P1 | W3 | Fix |
| [MC16: Orders and order detail](#mc16-orders-and-order-detail) | P1 | W2 | Extend |
| [MC17: Analytics](#mc17-analytics) | P1 | W4 | New |
| [MC18: Experiments](#mc18-experiments) | P2 | W5 | New |
| [MC19: AI recommendations](#mc19-ai-recommendations) | P2 | W5 | New |
| [MC20: Integrations](#mc20-integrations) | P1 | W2 | Extend |
| [MC21: Domains and SEO](#mc21-domains-and-seo) | P1 | W4 | New |
| [MC22: Commerce preferences](#mc22-commerce-preferences) | P1 | W2 | Extend |
| [MC23: Team and permissions](#mc23-team-and-permissions) | P1 | W4 | New |
| [MC24: Plan and billing](#mc24-plan-and-billing) | P1 | W4 | New |
| [MC25: Privacy and exports](#mc25-privacy-and-exports) | P1 | W4 | New |
| [MC26: Audit log](#mc26-audit-log) | P1 | W4 | New |
| [MC27: Help and onboarding](#mc27-help-and-onboarding) | P1 | W4 | New |
| [MC28: Automations](#mc28-automations) | P3 | W6 | New |

### Platform operator

| ID / feature | Priority | First wave | Reported change |
| --- | --- | --- | --- |
| [OP01: Operator identity](#op01-operator-identity) | P0 | W1 | Replace |
| [OP02: Platform overview](#op02-platform-overview) | P1 | W4 | Extend |
| [OP03: Tenant registry and detail](#op03-tenant-registry-and-detail) | P1 | W4 | Extend |
| [OP04: Provisioning jobs](#op04-provisioning-jobs) | P1 | W4 | New |
| [OP05: Queue and webhook inspector](#op05-queue-and-webhook-inspector) | P0 | W2 | New |
| [OP06: Fleet releases and migrations](#op06-fleet-releases-and-migrations) | P1 | W4 | New |
| [OP07: Template registry](#op07-template-registry) | P1 | W3 | New |
| [OP08: Subscriptions and reconciliation](#op08-subscriptions-and-reconciliation) | P1 | W4 | New |
| [OP09: Tenant unit costs](#op09-tenant-unit-costs) | P2 | W5 | New |
| [OP10: Security and support access](#op10-security-and-support-access) | P0 | W2 | New |
| [OP11: Privacy operations](#op11-privacy-operations) | P1 | W4 | New |
| [OP12: Incidents and maintenance](#op12-incidents-and-maintenance) | P1 | W4 | New |
| [OP13: Feature flags and quotas](#op13-feature-flags-and-quotas) | P2 | W5 | New |
| [OP14: Partner administration](#op14-partner-administration) | P2 | W5 | New |

### Agency workspace

| ID / feature | Priority | First wave | Reported change |
| --- | --- | --- | --- |
| [AG01: Portfolio](#ag01-portfolio) | P2 | W5 | New |
| [AG02: Client invitation](#ag02-client-invitation) | P2 | W5 | New |
| [AG03: Reusable private kits](#ag03-reusable-private-kits) | P2 | W5 | New |
| [AG04: Client approvals](#ag04-client-approvals) | P2 | W5 | New |
| [AG05: Referrals and earnings](#ag05-referrals-and-earnings) | P2 | W5 | New |
| [AG06: Client reporting](#ag06-client-reporting) | P2 | W5 | New |

### SaaS marketing website

| ID / feature | Priority | First wave | Reported change |
| --- | --- | --- | --- |
| [MK01: Product homepage](#mk01-product-homepage) | P1 | W4 | New |
| [MK02: Pricing](#mk02-pricing) | P1 | W4 | New |
| [MK03: Template gallery](#mk03-template-gallery) | P1 | W4 | New |
| [MK04: Vertical pages](#mk04-vertical-pages) | P1 | W4 | New |
| [MK05: Integration directory](#mk05-integration-directory) | P1 | W4 | New |
| [MK06: Case studies](#mk06-case-studies) | P2 | W5 | New |
| [MK07: Docs and trust](#mk07-docs-and-trust) | P1 | W4 | New |
| [MK08: Contact and SaaS policies](#mk08-contact-and-saas-policies) | P1 | W4 | New |

### Backend capabilities

| ID / feature | Priority | First wave | Reported change |
| --- | --- | --- | --- |
| [BE01: Tenant resolution and boundary](#be01-tenant-resolution-and-boundary) | P0 | W1 | Fix |
| [BE02: Identity and sessions](#be02-identity-and-sessions) | P0 | W1 | Replace |
| [BE03: Role authorization](#be03-role-authorization) | P0 | W1 | New |
| [BE04: Catalog synchronization](#be04-catalog-synchronization) | P0 | W2 | Fix |
| [BE05: Search service](#be05-search-service) | P1 | W3 | Extend |
| [BE06: Cart and checkout adapter](#be06-cart-and-checkout-adapter) | P0 | W2 | Replace conditionally |
| [BE07: Promotion compiler](#be07-promotion-compiler) | P1 | W2 | Extend |
| [BE08: Content and template service](#be08-content-and-template-service) | P1 | W3 | Replace |
| [BE09: Publishing and rendering](#be09-publishing-and-rendering) | P1 | W3 | New |
| [BE10: Order and refund projection](#be10-order-and-refund-projection) | P0 | W2 | Extend |
| [BE11: Subscription billing](#be11-subscription-billing) | P1 | W4 | New |
| [BE12: Domains and certificates](#be12-domains-and-certificates) | P0 | W1 | New |
| [BE13: Secret management](#be13-secret-management) | P0 | W1 | Fix |
| [BE14: Durable jobs and webhook inbox](#be14-durable-jobs-and-webhook-inbox) | P0 | W2 | Replace |
| [BE15: Asset storage and media pipeline](#be15-asset-storage-and-media-pipeline) | P1 | W3 | New |
| [BE16: Audit and approval](#be16-audit-and-approval) | P1 | W1 | New |
| [BE17: Versioned migrations](#be17-versioned-migrations) | P0 | W1 | New |
| [BE18: Privacy lifecycle](#be18-privacy-lifecycle) | P0 | W2 | Extend |
| [BE19: Monitoring and service operations](#be19-monitoring-and-service-operations) | P0 | W2 | Extend |
| [BE20: Analytics event contract](#be20-analytics-event-contract) | P1 | W2 | Extend |
| [BE21: Reporting and unit costs](#be21-reporting-and-unit-costs) | P1 | W4 | New |
| [BE22: Experimentation](#be22-experimentation) | P2 | W5 | New |
| [BE23: Notifications](#be23-notifications) | P1 | W3 | New |
| [BE24: Integration framework](#be24-integration-framework) | P1 | W2 | New |
| [BE25: Shopify partner integration](#be25-shopify-partner-integration) | P0 | W2 | Replace |
| [BE26: Provisioning orchestration](#be26-provisioning-orchestration) | P1 | W4 | Extend |
| [BE27: Backups and recovery](#be27-backups-and-recovery) | P0 | W2 | New |
| [BE28: Agency access and economics](#be28-agency-access-and-economics) | P2 | W5 | New |
| [BE29: Export and offboarding](#be29-export-and-offboarding) | P1 | W4 | New |
| [BE30: Customer accounts](#be30-customer-accounts) | P2 | W5 | New |
| [BE31: Bundle and subscription adapters](#be31-bundle-and-subscription-adapters) | P2 | W5 | New |
| [BE32: AI assistance](#be32-ai-assistance) | P2 | W5 | New |
| [BE33: Entitlements and quotas](#be33-entitlements-and-quotas) | P1 | W4 | New |
| [BE34: Security testing](#be34-security-testing) | P0 | W2 | New |
| [BE35: Performance and load testing](#be35-performance-and-load-testing) | P1 | W4 | New |
| [BE36: Tax and money definitions](#be36-tax-and-money-definitions) | P0 | W2 | Fix |

## Shopper storefront — implementation cards

### SF01: Homepage

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/` · **Template family:** `home`.

**Implementation requirements**

- Render announcement, responsive header, hero, collection entries, product grids, proof, FAQ and footer from a published release.
- Expose section order, visibility, images, copy and CTAs in the editor; retain accessible heading order.
- Bind products to the current tenant catalog and hide unsupported modules instead of inserting demo content.

**Acceptance:** At 360 px no horizontal overflow; every CTA has a valid tenant destination; empty catalog has no fake products.

**Verification case:** Publish different logos and products for two stores; verify desktop/mobile rendering, working CTAs and a real empty-catalog state.

**Dependencies:** BE01, BE08, BE09.

### SF02: Collection index

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/collections` · **Template family:** `collection_index`.

**Implementation requirements**

- List published collections with cover image, description, count and destination.
- Allow merchant-selected order and featured collections without changing Shopify ownership of catalog data.
- Render loading, missing images, pagination and an empty state using the tenant theme.

**Acceptance:** Only published collections appear; collection sort survives pagination.

**Verification case:** Unpublish a collection and verify it disappears without breaking links to remaining collections.

**Dependencies:** BE04, BE09.

### SF03: Collection detail

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/collections/:handle` · **Template family:** `collection`.

**Implementation requirements**

- Implement filter groups, selected-filter chips, sort options, product cards and pagination.
- Encode filters and sort in the URL; validate allowed filter keys and preserve state on back navigation.
- Show variant-aware price/availability, loading indicators and a clear-all action for zero results.

**Acceptance:** Filter state is URL-backed; back navigation restores state; zero results offers clear filters.

**Verification case:** Combine filters, paginate, open a product and navigate back; verify state restoration and tenant-scoped results.

**Dependencies:** BE04, BE05.

### SF04: Product detail

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/products/:handle` · **Template family:** `product`.

**Implementation requirements**

- Build media gallery, title, price, variant selector, quantity, stock, delivery information and add-to-cart.
- Support vertical modules for ingredients, usage, specifications, size/fit and genuine review integrations.
- Add mobile sticky purchase controls, accessible image navigation and explicit unavailable/invalid-variant states.

**Acceptance:** Unavailable variants cannot be added; correct option and price follow URL; keyboard gallery and CTA work.

**Verification case:** Change variants while stock updates; verify the selected variant, live price and cart line agree and sold-out variants cannot be purchased.

**Dependencies:** BE04, BE06, BE07.

### SF05: Search and suggestions

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/search` · **Template family:** `search`.

**Implementation requirements**

- Add debounced suggestions, full result pages, query history within the session and zero-result guidance.
- Cancel or ignore superseded requests and support keyboard selection and escape dismissal.
- Use the configured search adapter with a bounded tenant-scoped fallback; collect permitted search events.

**Acceptance:** Slow search cancels stale requests; SQL fallback is explicit in merchant health; no tenant leakage.

**Verification case:** Delay an older request so it finishes last; verify it cannot replace results for the newer query or leak another store's products.

**Dependencies:** BE05, BE20.

### SF06: Cart

**Priority:** P0 · **First wave:** W2 · **Reported change:** Fix (verify in code).

**Proposed route/entry:** `/cart and cart drawer` · **Template family:** `cart`.

**Implementation requirements**

- Implement full cart and drawer with line quantities, removals, discount feedback and gift eligibility.
- Refresh authoritative totals after mutations and explain unavailable products, changed prices and shipping estimates.
- Offer one relevant, available upsell; retain the cart on recoverable provider failures and prevent duplicate submissions.

**Acceptance:** Display and authoritative checkout agree; changed prices and removed stock require acknowledgement.

**Verification case:** Submit the same quantity update twice and remove a gift-qualifying item; verify one final cart state and correct eligibility.

**Dependencies:** BE06, BE07.

### SF07: Checkout handoff

**Priority:** P0 · **First wave:** W2 · **Reported change:** Replace conditionally (verify in code).

**Proposed route/entry:** `/checkout` · **Template family:** `checkout`.

**Implementation requirements**

- Request a fresh authorized checkout reference for the current tenant and cart session.
- Show progress, retry and expired-cart recovery while preserving items and attribution where permitted.
- Gate checkout mode by verified merchant capability; keep payment entry in the authorized provider experience.

**Acceptance:** The intended integration mode and merchant capability are verified; unauthorized external-payment paths remain disabled; a rejected handoff preserves the cart and never silently changes payment mode.

**Verification case:** Expire the checkout reference and simulate a provider failure; verify recovery preserves cart contents and does not charge twice.

**Dependencies:** BE06, BE25.

**Release note:** Code may be developed behind a disabled capability while external authorization is unresolved. Production enablement is a separate verified milestone.

### SF08: Confirmation

**Priority:** P0 · **First wave:** W2 · **Reported change:** Fix (verify in code).

**Proposed route/entry:** `/checkout/confirmation/:id` · **Template family:** `confirmation`.

**Implementation requirements**

- Require customer authorization or scoped expiring guest proof before retrieving a receipt.
- Show minimal order, payment and delivery information with tracking/support links.
- Prevent shared caching and referrer/token leakage; handle pending payment, invalid proof and unavailable order states.

**Acceptance:** Unauthenticated ID enumeration reveals nothing; replay, referrer and cache tests pass.

**Verification case:** Try a guessed order ID, another customer's proof and expired proof; verify no personal or financial details are returned.

**Dependencies:** BE02, BE10, BE18.

### SF09: Order tracking

**Priority:** P1 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/orders/:id` · **Template family:** `tracking`.

**Implementation requirements**

- Provide authorized order lookup and separately render each fulfillment/package.
- Show tracking number, carrier destination, available milestones and last-update time.
- If phone lookup is offered, verify possession before revealing the latest order; expose a carrier outage as stale data.

**Acceptance:** Shopper proves access; multiple shipments render separately; stale carrier data has a timestamp.

**Verification case:** Use one order with two parcels and a carrier timeout; verify independent parcel state and no disclosure before verification.

**Dependencies:** BE10, BE24.

### SF10: Customer sign in

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/account/login` · **Template family:** `account_login`.

**Implementation requirements**

- Implement the supported customer-account sign-in flow with a safe allowlisted return path.
- Keep shopper identity separate from merchant/operator sessions and allow guest purchasing.
- Handle cancelled login, expired state, logout and repeat sign-in without redirect loops.

**Acceptance:** Expired authentication restarts safely; no merchant-session reuse.

**Verification case:** Attempt a cross-store return URL and reuse expired login state; verify both fail safely.

**Dependencies:** BE02, BE30.

### SF11: Customer order list

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/account/orders` · **Template family:** `account_orders`.

**Implementation requirements**

- List only authorized customer orders with date, amount, financial and fulfillment status.
- Add detail navigation and reorder that resolves current product variants, prices and availability.
- Handle empty history, removed items, pagination and stale data explicitly.

**Acceptance:** Only that customer and store's orders appear; reorder revalidates live catalog and prices.

**Verification case:** Reorder an old order containing a removed variant; show the problem and never recreate an obsolete price.

**Dependencies:** BE10, BE30.

### SF12: Profile and addresses

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/account/profile` · **Template family:** `account_profile`.

**Implementation requirements**

- Read and update profile/address fields through supported customer APIs.
- Separate service communication from optional marketing choices and show consent status.
- Validate addresses, handle default-address changes and require appropriate authorization for deletion.

**Acceptance:** Address validation and deletion work; marketing consent is separate from order communication.

**Verification case:** Update an address, sign out and reopen the page; verify saved data belongs to the same customer/store and is not cached publicly.

**Dependencies:** BE18, BE30.

### SF13: Flexible content

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/pages/:slug` · **Template family:** `content`.

**Implementation requirements**

- Support pages such as About, ingredient guides and size guides using typed sections.
- Manage slug, title, publication state, navigation visibility and SEO independently.
- Keep hidden/draft pages editable and sanitize all rendered rich text and links.

**Acceptance:** Hidden pages stay editable; disabled public pages return correct status; content is sanitized.

**Verification case:** Hide a published page from navigation; verify it remains editable and its direct URL follows its separate publication setting.

**Dependencies:** BE08, BE09.

### SF14: Policy pages

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/policies/:slug` · **Template family:** `policy`.

**Implementation requirements**

- Store merchant-specific shipping, returns, privacy and terms content with effective dates.
- Require the necessary policy links during onboarding and near purchase actions.
- Support policy draft/review/publish without copying another tenant's legal text.

**Acceptance:** No BeastLife text leaks into another tenant; links appear near purchase decisions.

**Verification case:** Create a new tenant and verify no other brand's identity, contact details or policy content appears.

**Dependencies:** BE08, BE18.

### SF15: Contact and help

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/pages/contact` · **Template family:** `contact`.

**Implementation requirements**

- Show merchant support channels, hours and an accessible contact form.
- Validate inputs server-side, rate-limit submissions and route to the configured destination.
- Show honest queued, sent or failed states without exposing inbox credentials or order data.

**Acceptance:** Form has rate limit, accessible errors, success state and delivery failure handling.

**Verification case:** Simulate notification-provider failure and repeated submission; verify no false success or duplicate contact request.

**Dependencies:** BE18, BE23.

### SF16: FAQ

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/pages/faq` · **Template family:** `faq`.

**Implementation requirements**

- Render grouped FAQ entries with keyboard-operable accordions and deep links.
- Provide simple client-side text filtering without hiding content from accessible reading.
- Let merchants reuse a FAQ group on product and campaign pages through a versioned reference.

**Acceptance:** Accordion is keyboard usable and shows answers without requiring scripts for indexing.

**Verification case:** Open an answer by URL fragment and navigate using only a keyboard; verify search/reset preserves usable focus.

**Dependencies:** BE08.

### SF17: Campaign landing

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/campaigns/:slug` · **Template family:** `campaign`.

**Implementation requirements**

- Create a campaign page with dates, headline, proof, product/bundle bindings and CTA.
- Support campaign-specific section composition while inheriting tenant tokens and essential navigation/policies.
- Preview and publish its dependencies together; retain permitted campaign parameters and show expired-page behavior.

**Acceptance:** UTM parameters persist; theme and campaign publish together; dates use merchant timezone.

**Verification case:** Schedule a campaign in the merchant timezone and verify preview, activation and expiry resolve to the intended UTC instants.

**Dependencies:** BE08, BE09, BE20.

### SF18: Bundle detail

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/bundles/:handle` · **Template family:** `bundle`.

**Implementation requirements**

- Display supported fixed or mix-and-match bundles with component quantities and eligibility.
- Recalculate stock and supported discounts when selections change; expose selection constraints.
- Explain component-level fulfillment and link to applicable return/refund policy.

**Acceptance:** Stock and discounts reconcile at checkout; components have SKU-level fulfillment and refund meaning.

**Verification case:** Remove stock from one component and test a partial refund fixture; the bundle must remain consistent with provider behavior.

**Dependencies:** BE07, BE31.

### SF19: Product finder

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/quiz/:slug` · **Template family:** `quiz`.

**Implementation requirements**

- Build a deterministic question/answer editor and shopper flow with buttons, progress, back and optional skip.
- Map answer rules to available products or collections with a short explanation; AI is optional, not required.
- Make contact capture optional and consented, and avoid diagnostic or sensitive-profile questions.

**Acceptance:** Button/progress navigation works without AI; deterministic results reference available tenant products/collections; optional contact capture requires appropriate consent and no diagnostic profiling is introduced.

**Verification case:** Go back and change an answer; verify the result recomputes, never recommends unavailable items and works without AI.

**Dependencies:** BE08, BE04.
**Optional/later dependencies:** BE32.

**Release note:** Basic finder uses deterministic rules. BE32 is an optional later dependency for AI assistance.

### SF20: Editorial content

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/journal and /journal/:slug` · **Template family:** `article`.

**Implementation requirements**

- Provide editorial index and article pages with author, dates, media, related content and product links.
- Support draft/scheduled publication, slug changes and redirects.
- Validate metadata, headings, alt text and canonical URLs before publication.

**Acceptance:** Structured metadata, canonical and image alt text pass publishing validation.

**Verification case:** Change an article slug and verify the previous URL redirects once to the tenant's canonical article.

**Dependencies:** BE08, BE09.

### SF21: Return request

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/returns` · **Template family:** `returns`.

**Implementation requirements**

- Authenticate order access before showing return eligibility and merchant policy.
- Hand off to the selected returns provider and display pending/approved/rejected status when supported.
- Separate return approval from actual refund and present support recovery for unavailable integrations.

**Acceptance:** Shopper authentication precedes order lookup; clear pending, rejected and approved states.

**Verification case:** An approved return without a completed refund must not display a refunded payment state.

**Dependencies:** BE10, BE24.

### SF22: Wishlist

**Priority:** P3 · **First wave:** W6 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/wishlist` · **Template family:** `wishlist`.

**Implementation requirements**

- Store an anonymous wishlist locally and render current product availability.
- Offer an explicit merge when signing in, deduplicating by store and variant/product identity.
- Support remove, clear, empty and unavailable-product states without hidden cross-device tracking.

**Acceptance:** No implicit identity joining; unavailable items remain understandable.

**Verification case:** Sign into two different stores; verify lists do not merge across tenant boundaries.

**Dependencies:** BE30.

### SF23: Offline and errors

**Priority:** P0 · **First wave:** W1 · **Reported change:** Fix (verify in code).

**Proposed route/entry:** `/offline and error routes` · **Template family:** `system`.

**Implementation requirements**

- Provide known-store 404, maintenance, offline and error layouts using safe published branding.
- Use a neutral platform response when tenant identity is unknown; never select a default store.
- Exclude account/order/checkout data from public or offline caches and offer a safe retry path.

**Acceptance:** Unknown hosts receive a neutral safe response; resolved known stores use safe branding. No account/order PII is publicly or offline cached, and offline mode cannot place an order.

**Verification case:** Disconnect the control plane on an unknown host; verify no merchant content, cached order data or purchase action appears.

**Dependencies:** BE01, BE09, BE19.

**Release note:** W1 provides neutral unknown-host and safe known-host responses. Full release-driven branding completes with BE09/BE19 in W3; do not delay the fail-closed fix for the theme system.

### SF24: Consent settings

**Priority:** P0 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `Privacy preferences overlay` · **Template family:** `consent`.

**Implementation requirements**

- Provide accept, decline, purpose settings and a persistent reopen control.
- Persist versioned preferences and propagate changes to browser tags and server-side forwarding.
- Keep essential service processing distinct from optional analytics/marketing and handle withdrawal.

**Acceptance:** Decline prevents optional destinations; withdrawal applies to client and server; version is recorded.

**Verification case:** Decline, navigate, then withdraw a prior acceptance; verify optional events stop at both client and server destinations.

**Dependencies:** BE18, BE20.

## Merchant workspace — implementation cards

### MC01: Merchant sign in

**Priority:** P0 · **First wave:** W1 · **Reported change:** Replace (verify in code).

**Proposed route/entry:** `/app/login` · **Template family:** `auth`.

**Implementation requirements**

- Create individual merchant sign-in, invitation acceptance, recovery and account-session views.
- Enforce server expiration/revocation and MFA for privileged actions using the chosen identity system.
- Add multi-instance rate limiting and safe expired-session redirects back to permitted pages.

**Acceptance:** Revocation is server enforced; rate limits survive multiple instances; session is tenant authorized.

**Verification case:** Revoke a user session while a tab remains open; the next protected read/write must fail without losing unrelated drafts.

**Dependencies:** BE02, BE03.

### MC02: Onboarding checklist

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/onboarding` · **Template family:** `onboarding`.

**Implementation requirements**

- Build a resumable checklist for connection, catalog, brand, policies, domain, preview, test and launch.
- Persist per-step status and diagnostics; distinguish optional setup from launch blockers.
- Allow preview before live launch and make subscription approval/activation explicit.

**Acceptance:** Each step is resumable; errors explain a repair; billing starts only at agreed activation.

**Verification case:** Interrupt provisioning after catalog setup; resume without duplicate tenant, connection or subscription records.

**Dependencies:** BE11, BE25, BE26.

### MC03: Store switcher

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores` · **Template family:** `store_switcher`.

**Implementation requirements**

- List stores from verified membership with role, environment, launch and connection status.
- Switch stores with explicit context in navigation and discard incompatible local page state.
- Preserve only safe filters and show an access-revoked state when permissions change.

**Acceptance:** A store ID edited in a URL or body never grants access.

**Verification case:** Change a store ID in the URL and request body; the server must deny unauthorized data and writes.

**Dependencies:** BE01, BE02.

### MC04: Merchant dashboard

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/overview` · **Template family:** `dashboard`.

**Implementation requirements**

- Show reconciled sales/orders, data freshness, draft/live state and a short setup/action queue.
- Add date range, timezone, currency and clearly labeled comparison periods.
- Show analytics coverage and unavailable data honestly; limit customer details by role.

**Acceptance:** Date, timezone, currency, refunds and data freshness are explicit; unknown data is not zero.

**Verification case:** Remove analytics consent coverage while financial orders remain available; show separate metrics instead of a misleading conversion rate.

**Dependencies:** BE10, BE20, BE21.

### MC05: Catalog browser

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/catalog` · **Template family:** `table_detail`.

**Implementation requirements**

- Provide searchable/paginated products and variants with publication, stock and synchronization status.
- Clearly identify Shopify-owned fields and link users to their authoritative editing location.
- Allow presentation overrides such as badges or display copy through drafts with a reset-to-source option.

**Acceptance:** Source-owned fields link to Shopify; unavailable and deleted products cannot be published accidentally.

**Verification case:** Delete a product in Shopify and reconcile; verify it cannot remain selectable as a new published binding.

**Dependencies:** BE04.

### MC06: Collection merchandising

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/collections` · **Template family:** `table_detail`.

**Implementation requirements**

- Allow curated ordering, featured cards and supported merchandising rules per collection.
- Assign collection templates and preview representative catalog content.
- Validate ownership, missing bindings and safe fallback before publication.

**Acceptance:** Assignments validate product/collection ownership and have preview before publishing.

**Verification case:** Assign a template using a collection from another store; reject it even if the identifier format is valid.

**Dependencies:** BE04, BE08.

### MC07: Theme library

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/design/themes` · **Template family:** `theme_library`.

**Implementation requirements**

- Show kit category, supported page families, version and integration requirements.
- Preview the kit with the merchant's catalog and identify missing optional data.
- Applying or upgrading a kit creates a new draft and preserves the current published release.

**Acceptance:** Applying a kit creates a draft; a live storefront never changes without publish permission.

**Verification case:** Apply another kit and leave the editor without publishing; the live store must remain unchanged.

**Dependencies:** BE08, BE09.

### MC08: Visual editor

**Priority:** P1 · **First wave:** W3 · **Reported change:** Replace (verify in code).

**Proposed route/entry:** `/app/stores/:store/design/editor` · **Template family:** `editor`.

**Implementation requirements**

- Build page/section tree, responsive preview and schema-driven settings panels.
- Support add, duplicate, hide, remove and keyboard reorder; add undo/redo and visible autosave state.
- Use draft revisions and conflict resolution; preview real bindings and show field-level validation.

**Acceptance:** Draft persists independently of live; keyboard move and reorder work; concurrent edits show conflict.

**Verification case:** Edit the same draft in two tabs; the second save must report a conflict instead of overwriting the first silently.

**Dependencies:** BE08, BE09.

### MC09: Page templates

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/design/templates` · **Template family:** `template_assignments`.

**Implementation requirements**

- Create named templates for each supported page family and allow cloning within a tenant.
- Assign explicit entities or ranked rules with exclusions and a page-type fallback.
- Show the winning assignment and affected pages before publication; reject equal-priority ambiguity.

**Acceptance:** Preview explains winning assignment; missing optional modules have safe defaults.

**Verification case:** Apply two equal-priority rules to the same product; validation must reject ambiguity and preserve the prior published assignment.

**Dependencies:** BE08.

### MC10: Brand system

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/app/stores/:store/design/brand` · **Template family:** `settings`.

**Implementation requirements**

- Manage logo/favicon, approved fonts, typography scale, colors, spacing, radii and responsive settings.
- Apply tokens to public pages, menus, drawers, forms and known-store system states.
- Preview changes, validate contrast and provide reset-to-theme behavior for each token.

**Acceptance:** Tokens propagate to every page and error state; invalid contrast blocks publish of core text.

**Verification case:** Change a tenant accent and inspect home, product, cart, policy and error pages; another tenant must not change.

**Dependencies:** BE08, BE09.

### MC11: Menus and footer

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/app/stores/:store/design/navigation` · **Template family:** `tree_editor`.

**Implementation requirements**

- Provide editable nested menus, mobile navigation, footer columns and announcement content.
- Validate destinations, unsafe URL schemes, missing pages and required policy links.
- Treat visibility and publication separately, with keyboard-operable tree controls.

**Acceptance:** Broken and unsafe URLs are rejected; hidden pages remain available in admin with status.

**Verification case:** Reorder a menu by keyboard and attempt a javascript URL; ordering must persist and the unsafe destination must be rejected.

**Dependencies:** BE08.

### MC12: Content and media

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/app/stores/:store/content` · **Template family:** `content_library`.

**Implementation requirements**

- Manage pages, reusable sections and media with search, filters, status and usage references.
- Upload approved file types with dimensions, alt text and rights notes; show processing errors.
- Warn before removing referenced assets and keep unpublished pages visible to authorized editors.

**Acceptance:** Media is tenant scoped; sanitized rich text cannot execute scripts.

**Verification case:** Delete an asset used in the live release; block unsafe deletion or retain the release dependency according to the retention policy.

**Dependencies:** BE08, BE15.

### MC13: Drafts and releases

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/releases` · **Template family:** `release`.

**Implementation requirements**

- List drafts and immutable releases with author, time, change summary and validation state.
- Provide before/after preview, optional approval and timezone-aware scheduling.
- Publish atomically and restore an earlier release without discarding current draft work.

**Acceptance:** Release pointer changes atomically; previous live version restores without losing draft edits.

**Verification case:** Schedule then edit a draft; publishing must use the approved snapshot/hash, not unreviewed later edits.

**Dependencies:** BE09, BE16.

### MC14: Offers

**Priority:** P1 · **First wave:** W2 · **Reported change:** Fix (verify in code).

**Proposed route/entry:** `/app/stores/:store/offers` · **Template family:** `rule_builder`.

**Implementation requirements**

- Support current offer types through explicit eligibility, benefits, limits, combinations and schedules.
- Add a sample-cart simulator and provider capability/compilation result.
- Separate draft, validated, active, paused and expired states; do not activate unsupported discounts.

**Acceptance:** Timezone roundtrip is stable; sample carts prove each offer or publish is blocked.

**Verification case:** Round-trip a timezone edit and test incompatible discounts; retain the intended instant and block invalid activation.

**Dependencies:** BE07, BE25.

### MC15: Upsells and bundles

**Priority:** P1 · **First wave:** W3 · **Reported change:** Fix (verify in code).

**Proposed route/entry:** `/app/stores/:store/upsells` · **Template family:** `rule_builder`.

**Implementation requirements**

- Configure related-product upsells with placement, trigger, exclusions, priority and enable state.
- Use available catalog items and preview placement in product/cart contexts.
- Keep basic upsells independent from later bundle/subscription adapters; advanced rules require proven checkout support.

**Acceptance:** Editing a disabled placement does not enable it; unavailable targets are excluded. Basic upsells work independently, while advanced bundles are enabled only after BE31 compatibility checks.

**Verification case:** Edit the copy of a disabled placement; it must remain disabled and an out-of-stock target must not be recommended.

**Dependencies:** BE06, BE07, BE08.
**Optional/later dependencies:** BE31.

**Release note:** Basic placement/rules are W3. Advanced bundle or selling-plan behavior additionally depends on BE31 in W5.

### MC16: Orders and order detail

**Priority:** P1 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/app/stores/:store/orders` · **Template family:** `order_detail`.

**Implementation requirements**

- List orders with independent financial/fulfillment states, search, filters and paginated details.
- Show event timeline, refunds and shipment packages with role-limited customer fields.
- Use supported provider actions or links; distinguish requested actions from confirmed provider results.

**Acceptance:** Permissions gate each action; no local edit can invent a paid or refunded status.

**Verification case:** Attempt a refund as a support-only user and replay a provider event; deny the action and retain one financial update.

**Dependencies:** BE10, BE16.

### MC17: Analytics

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/analytics` · **Template family:** `analytics`.

**Implementation requirements**

- Provide sales, funnel, products, campaigns, search and device reports with metric definitions.
- Expose coverage, timezone, currency, attribution limits and last reconciliation time.
- Offer scoped exports and preserve date/filter selections without mixing tenant data.

**Acceptance:** Definitions and observed-coverage badges are visible; total net sales reconciles to Shopify.

**Verification case:** Compare a refunded order across local reporting and Shopify; net sales and reporting cutoff must agree.

**Dependencies:** BE20, BE21.

### MC18: Experiments

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/experiments` · **Template family:** `experiment`.

**Implementation requirements**

- Create experiments with hypothesis, variants, assignment unit, allocation and a frozen analysis plan.
- Show exposures, sample sufficiency, guardrails and data-quality warnings.
- Pause, complete and adopt a variant through the normal release workflow.

**Acceptance:** No automatic winner from insufficient samples; exposure and order joins are reproducible.

**Verification case:** Insufficient samples or sample-ratio mismatch must suppress winner claims; adoption still requires publish permission.

**Dependencies:** BE22.

### MC19: AI recommendations

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/insights` · **Template family:** `insights`.

**Implementation requirements**

- Show evidence-linked recommendations with affected pages, proposed changes and expected mechanism.
- Generate editable drafts from approved tenant facts and show before/after previews.
- Require normal authorization/publishing for changes and expose usage budget and failure states.

**Acceptance:** No invented proof or product claims; AI cannot publish, refund or alter prices without permission.

**Verification case:** Prompt the assistant to invent a review or publish to another tenant; reject both and leave live content unchanged.

**Dependencies:** BE32, BE09.

### MC20: Integrations

**Priority:** P1 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/app/stores/:store/integrations` · **Template family:** `integrations`.

**Implementation requirements**

- Display provider connection, scopes, capability support, sync health and last successful event.
- Support authorized connect, reconnect, test and revoke without returning secrets to the browser.
- Show supported, partial, unsupported and needs-review integration dependencies before launch.

**Acceptance:** Reconnect is explicit; secrets never return to browsers; unsupported app dependencies surface.

**Verification case:** Revoke a provider connection; pending jobs must stop using it and UI must not report a healthy integration.

**Dependencies:** BE13, BE24, BE25.

### MC21: Domains and SEO

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/settings/domains` · **Template family:** `settings`.

**Implementation requirements**

- Guide domain challenge, DNS, TLS, primary host, redirect and canonical setup.
- Manage page SEO, redirects, sitemap inclusion and indexability through release validation.
- Block launch on unverified ownership or failed TLS and preserve preview access.

**Acceptance:** Unique host ownership is proved; failed TLS blocks go-live; redirects are tested before DNS switch.

**Verification case:** Attempt to claim another tenant's host and create a redirect loop; both must be blocked.

**Dependencies:** BE12, BE09.

### MC22: Commerce preferences

**Priority:** P1 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/app/stores/:store/settings/commerce` · **Template family:** `settings`.

**Implementation requirements**

- Show currency, timezone, tax/shipping display policy and checkout capability from authoritative configuration.
- Permit only supported local presentation preferences and explain source-owned settings.
- Identify which system sends each shopper email to avoid duplicate notifications.

**Acceptance:** Shopify remains final authority; mismatched tax/shipping settings cannot silently change charged totals.

**Verification case:** Change shipping display settings; checkout totals must still be provider-authoritative and estimates must remain labeled.

**Dependencies:** BE06, BE10, BE25.

### MC23: Team and permissions

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/settings/team` · **Template family:** `team`.

**Implementation requirements**

- Invite staff, select role/store grants, review pending invitations and revoke access.
- Prevent removal of the final owner and require a separate verified ownership-transfer flow.
- Display action capabilities and enforce them server-side on every protected operation.

**Acceptance:** Last owner cannot be removed; support cannot publish or reveal integration secrets.

**Verification case:** An expired invitation or removed membership must not grant access through an already-open tab.

**Dependencies:** BE02, BE03.

### MC24: Plan and billing

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/billing` · **Template family:** `billing`.

**Implementation requirements**

- Select the store being billed and show proposed plan, current provider status and entitlements.
- Handle provider approval, upgrade, downgrade, cancellation, invoices and usage warnings.
- Explain grace periods and retained storefront behavior; never grant paid rights from client state.

**Acceptance:** Client cannot grant a plan; delayed webhooks reconcile; usage warnings arrive before limits.

**Verification case:** Receive billing events out of order and miss one; reconciliation must restore the provider-authoritative plan.

**Dependencies:** BE11.

### MC25: Privacy and exports

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/settings/privacy` · **Template family:** `privacy`.

**Implementation requirements**

- Configure consent behavior and retention policies with documented exceptions.
- Track verified access/export/deletion requests with deadline, scope and delivery status.
- Restrict exports to permitted fields and explain pending retention or backup expiry.

**Acceptance:** Required retention exceptions are documented; deletion reaches search, analytics and derived data.

**Verification case:** A customer request for tenant A must not export or delete tenant B data with the same email.

**Dependencies:** BE18, BE29.

### MC26: Audit log

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/activity` · **Template family:** `audit`.

**Implementation requirements**

- List filterable, read-only audit records by actor, action, resource, date and tenant.
- Show safe before/after summaries and active/historical support-access grants.
- Restrict sensitive detail and export access; redact secrets and unnecessary personal data.

**Acceptance:** Read-only history cannot be edited by store admins; PII is minimized.

**Verification case:** Try editing an audit record through the API as a store admin; deny it and verify secrets never appear in the diff.

**Dependencies:** BE16.

### MC27: Help and onboarding

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/support` · **Template family:** `support`.

**Implementation requirements**

- Show setup progress, contextual help and a support request form.
- Include request IDs and merchant-approved diagnostic context with a clear preview.
- Track delivery state and point to documented support channels when submission fails.

**Acceptance:** Sensitive order data is omitted from diagnostics by default.

**Verification case:** Open support from an order page; no customer PII may be attached automatically.

**Dependencies:** BE19, BE23.

### MC28: Automations

**Priority:** P3 · **First wave:** W6 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/app/stores/:store/automations` · **Template family:** `automations`.

**Implementation requirements**

- Create bounded trigger/condition/action rules for selected supported providers.
- Add dry runs, consent checks, frequency caps, quiet hours and action deduplication.
- Provide per-rule pause, global disable, run history and retry diagnostics.

**Acceptance:** Consent, frequency caps, quiet hours and disable-all are tested.

**Verification case:** Replay the same triggering event and activate disable-all; there must be no duplicate or subsequent prohibited action.

**Dependencies:** BE23, BE24.

## Platform operator — implementation cards

### OP01: Operator identity

**Priority:** P0 · **First wave:** W1 · **Reported change:** Replace (verify in code).

**Proposed route/entry:** `/ops/login` · **Template family:** `auth`.

**Implementation requirements**

- Use privileged operator identities and mandatory MFA, separate from merchant authorization.
- Set short sessions and explicit role grants with review/revocation capability.
- Log operator sign-in and sensitive access without collecting plaintext credentials.

**Acceptance:** Merchant sessions never access operator routes; access is time bound and logged.

**Verification case:** Present a valid merchant session to an operator route; deny access before querying any fleet data.

**Dependencies:** BE02, BE03.

### OP02: Platform overview

**Priority:** P1 · **First wave:** W4 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/ops` · **Template family:** `ops_dashboard`.

**Implementation requirements**

- Show store counts, service state, queue age, incidents and subscription metrics.
- Display freshness and coverage for partial or unreachable tenant data.
- Provide drill-down links to affected tenants and operational owners without publicizing customer PII.

**Acceptance:** Aggregates show stale/partial tenants explicitly; no silent omission of dead orders.

**Verification case:** Make one tenant database unavailable; totals must identify incomplete coverage instead of silently dropping it.

**Dependencies:** BE19, BE21.

### OP03: Tenant registry and detail

**Priority:** P1 · **First wave:** W4 · **Reported change:** Extend (verify in code).

**Proposed route/entry:** `/ops/tenants` · **Template family:** `table_detail`.

**Implementation requirements**

- Search tenant identity, organization, domain, plan, connection and lifecycle state.
- Expose provisioning, suspension, recovery and offboarding as authorized audited workflows.
- Keep credentials masked and make the selected tenant/environment unmistakable.

**Acceptance:** Suspension returns the correct unavailable storefront and never another tenant's store.

**Verification case:** Suspend tenant A and verify its domain returns the correct unavailable response and never tenant B's store.

**Dependencies:** BE01, BE26.

### OP04: Provisioning jobs

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/provisioning` · **Template family:** `job_detail`.

**Implementation requirements**

- Show provisioning steps, resources created, current lease, failure and retry history.
- Retry only failed/idempotent steps and expose cancellation/compensating cleanup.
- Prevent operators from bypassing failed ownership, billing or security prerequisites.

**Acceptance:** A retry creates no duplicate DB, domain, app install or billing record.

**Verification case:** Retry after database creation but before catalog import; no duplicate database, install or subscription may be created.

**Dependencies:** BE26.

### OP05: Queue and webhook inspector

**Priority:** P0 · **First wave:** W2 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/queues` · **Template family:** `queue`.

**Implementation requirements**

- List webhook/job metadata, retries, queue age and dead-letter reason by tenant.
- Provide scoped replay with reason, permission and audit; mask payload PII.
- Show provider/store binding and idempotency outcome before and after replay.

**Acceptance:** Replay is scoped, audited and idempotent; payload PII is masked.

**Verification case:** Replay a completed payment/order event twice; financial state changes once and both operator attempts are recorded.

**Dependencies:** BE14, BE16.

### OP06: Fleet releases and migrations

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/releases` · **Template family:** `release`.

**Implementation requirements**

- Show application/content-schema compatibility, canary cohort and per-tenant migration state.
- Pause rollout on failed canaries and allow safe retries for individual tenant failures.
- Distinguish application rollback from irreversible data changes and show recovery instructions.

**Acceptance:** A failed canary prevents broad rollout; one tenant failure does not halt others.

**Verification case:** Fail a canary migration and verify expansion stops while already-healthy stores remain usable.

**Dependencies:** BE09, BE17.

### OP07: Template registry

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/templates` · **Template family:** `template_registry`.

**Implementation requirements**

- Manage versioned templates/components with page families, vertical tags and supported schema ranges.
- Validate fixtures, accessibility and upgrade migrations before making a version available.
- Allow merchants to adopt upgrades through preview; never overwrite pinned tenant versions silently.

**Acceptance:** Platform updates never overwrite merchant customization without explicit adoption.

**Verification case:** Publish a new theme version and verify existing stores retain their previous version and explicit overrides.

**Dependencies:** BE08, BE17.

### OP08: Subscriptions and reconciliation

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/billing` · **Template family:** `billing`.

**Implementation requirements**

- Review subscriptions, provider events, collection exceptions and reconciliation results.
- Separate gross subscription value, refunds, fees and net settlement in reports.
- Apply adjustments only through supported audited flows, with an owner for unresolved differences.

**Acceptance:** Raw app billings reconcile to provider statements; exceptions have an owner.

**Verification case:** Reconcile a cancellation/refund example and verify it is not counted as active recurring revenue.

**Dependencies:** BE11, BE21.

### OP09: Tenant unit costs

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/costs` · **Template family:** `costs`.

**Implementation requirements**

- Break down allocated compute, storage, search, AI and delivery/support costs per store.
- Show allocation method, measurement gaps and usage trends.
- Alert on agreed budgets and link to safe quota actions rather than silently charging merchants.

**Acceptance:** Costs show allocation assumptions and high-usage alerts before margin erosion.

**Verification case:** Compare provider totals with allocations; unallocated cost must remain visible rather than disappearing.

**Dependencies:** BE21, BE33.

### OP10: Security and support access

**Priority:** P0 · **First wave:** W2 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/security` · **Template family:** `security`.

**Implementation requirements**

- Review operator permissions, unusual access and time-limited support grants.
- Require an authorized reason and scope for tenant access; show a merchant-visible access notice.
- Expire/revoke grants promptly and audit reads or mutations according to sensitivity.

**Acceptance:** Support access requires a reason and permission; banner and audit are visible to merchant.

**Verification case:** Let a support grant expire while the operator has a page open; subsequent tenant access must fail.

**Dependencies:** BE03, BE16, BE18.

### OP11: Privacy operations

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/privacy` · **Template family:** `privacy`.

**Implementation requirements**

- Track verified privacy requests, export/deletion stages, exceptions and backup expiry.
- Show only authorized identifiers and redact request payloads in routine views.
- Provide retry and escalation for failed downstream deletion with an audit trail.

**Acceptance:** Requests resolve against the right shop; backups expire according to policy.

**Verification case:** Fail deletion in search while primary data deletion succeeds; keep the request incomplete until propagation is resolved.

**Dependencies:** BE18, BE29.

### OP12: Incidents and maintenance

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/incidents` · **Template family:** `incident`.

**Implementation requirements**

- Create incidents with severity, affected tenants, owner, timeline and recovery work.
- Maintain internal and public updates with separate visibility and safe content.
- Link runbooks, verification evidence and follow-up actions.

**Acceptance:** Public status contains no merchant PII; recovery and follow-up are recorded.

**Verification case:** Preview a public incident update containing tenant/customer details; validation or review must remove private information before publication.

**Dependencies:** BE19.

### OP13: Feature flags and quotas

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/flags` · **Template family:** `settings`.

**Implementation requirements**

- Manage server-evaluated rollout flags, tenant cohorts, expiry and emergency disable.
- Separate release flags from purchased entitlements and operational quotas.
- Audit changes and invalidate checkout-critical cached decisions promptly.

**Acceptance:** Flags are server evaluated and invalidation is immediate for checkout-critical settings.

**Verification case:** Disable a critical capability and verify new requests stop using it across workers and web instances.

**Dependencies:** BE33.

### OP14: Partner administration

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/ops/partners` · **Template family:** `partners`.

**Implementation requirements**

- Manage agency verification, delegated grants and referral eligibility.
- Review commission adjustments and disputes without inheriting global client access.
- Keep commercial partner status independent from actual client permissions.

**Acceptance:** No global access to partner client data; revenue is not counted twice.

**Verification case:** Mark an agency verified; it must still see zero client stores until explicit grants exist.

**Dependencies:** BE28, BE21.

## Agency workspace — implementation cards

### AG01: Portfolio

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/partners` · **Template family:** `portfolio`.

**Implementation requirements**

- List explicitly granted client stores with role, health and approval tasks.
- Switch context clearly and preserve each client's currency/timezone.
- Respect revoked access immediately and avoid broad cross-client search by default.

**Acceptance:** Agency sees only granted stores; revocation takes effect across all sessions.

**Verification case:** Remove one client's grant; that client disappears from the portfolio and direct API access fails.

**Dependencies:** BE02, BE28.

### AG02: Client invitation

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/partners/clients` · **Template family:** `team`.

**Implementation requirements**

- Send or prepare scoped client invitations through an authorized invitation flow.
- Require client acceptance of permissions and separate bilateral ownership-transfer confirmation.
- Track pending, accepted, expired and revoked requests without granting access prematurely.

**Acceptance:** Client explicitly accepts scope; ownership transfer requires both confirmations.

**Verification case:** Accept an expired or wrong-recipient invitation; no client grant is created.

**Dependencies:** BE02, BE28.

### AG03: Reusable private kits

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/partners/templates` · **Template family:** `theme_library`.

**Implementation requirements**

- Export reusable layout structure and permitted generic settings into agency-private kits.
- Exclude customer data, secrets, domain mappings, private media and merchant-specific product IDs.
- Require destination data binding and validation when applying a kit to another client.

**Acceptance:** Copy excludes customer data, keys, domain mappings, private media and SKU IDs.

**Verification case:** Copy a kit between two clients and scan the result for source merchant identifiers and private assets; none should remain.

**Dependencies:** BE08, BE28.

### AG04: Client approvals

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/partners/reviews` · **Template family:** `release`.

**Implementation requirements**

- Create signed, expiring client previews tied to a specific immutable content hash.
- Collect scoped comments and approval identity with a visible pending/approved/rejected status.
- Route approved work through the merchant's normal publish permission workflow.

**Acceptance:** Link is signed and expiring; approver identity and release hash are recorded.

**Verification case:** Change the draft after approval; the old approval must not authorize the new content hash.

**Dependencies:** BE09, BE28.

### AG05: Referrals and earnings

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/partners/referrals` · **Template family:** `billing`.

**Implementation requirements**

- Show referred stores, eligibility rules, eligible collections and commission lifecycle.
- Account for refunds, reversals and attribution disputes in a reconciliation ledger.
- Export statements while keeping payouts separate from calculated/approved commissions.

**Acceptance:** Refunds and reversals adjust commission; statements reconcile with finance.

**Verification case:** Refund a previously eligible subscription charge; the commission statement must reverse the correct amount once.

**Dependencies:** BE11, BE28.

### AG06: Client reporting

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `/partners/reports` · **Template family:** `analytics`.

**Implementation requirements**

- Generate selected-client reports using explicit grants and safe templates.
- Retain per-client reporting periods, currency, timezone and metric definitions.
- Allow branding of reports without copying private metrics between clients.

**Acceptance:** No cross-client private metrics appear; timezone and currency are retained.

**Verification case:** Generate reports for two clients concurrently and verify neither contains the other's metrics or assets.

**Dependencies:** BE21, BE28.

## SaaS marketing website — implementation cards

### MK01: Product homepage

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /` · **Template family:** `marketing_home`.

**Implementation requirements**

- Explain the initial customer segment, supported workflow and product demonstration.
- Show real product screens, current capabilities and a clear demo/signup action.
- Use substantiated claims and consented lead capture with delivery feedback.

**Acceptance:** Claims cite actual evidence; no fabricated merchant logos or lift percentages.

**Verification case:** Every public feature claim must map to a released capability or be explicitly labeled planned.

**Dependencies:** BE23.

### MK02: Pricing

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /pricing` · **Template family:** `pricing`.

**Implementation requirements**

- Display monthly/annual price, billing unit, included limits, dependencies and cancellation policy.
- Use the same versioned plan definitions as entitlement/billing configuration.
- Show setup/service fees separately and obtain explicit agreement for any paid overage.

**Acceptance:** Annual effective pricing and usage examples match billing configuration.

**Verification case:** Compare website pricing with the actual provider approval amount and configured allowances; they must match.

**Dependencies:** BE11.

### MK03: Template gallery

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /templates` · **Template family:** `gallery`.

**Implementation requirements**

- Filter templates by vertical, page type and device and open safe sample previews.
- Distinguish available, beta and planned kits and show relevant limitations.
- Connect selection to an onboarding draft without changing a live store.

**Acceptance:** Preview kit labels match supported release capabilities.

**Verification case:** A planned kit cannot be selected as a production-ready template or shown with fabricated merchant proof.

**Dependencies:** BE08.

### MK04: Vertical pages

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /solutions/:vertical` · **Template family:** `marketing_content`.

**Implementation requirements**

- Build nutrition and beauty solution pages using their real supported modules.
- Explain migration requirements and provide sample product/collection journeys.
- Link to relevant templates, compatibility information and a contextual demo form.

**Acceptance:** Only supported modules are presented as available.

**Verification case:** A solution page must not advertise a subscription or review capability that is unsupported in the selected release.

**Dependencies:** BE08.

### MK05: Integration directory

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /integrations` · **Template family:** `gallery`.

**Implementation requirements**

- List integrations with supported/partial/beta/planned status and setup requirements.
- Explain plan restrictions, headless limitations and source-of-truth boundaries.
- Keep public descriptions aligned with the internal capability registry.

**Acceptance:** A planned integration cannot be mistaken for functioning support.

**Verification case:** An integration that only stores credentials must not appear as fully supported.

**Dependencies:** BE24.

### MK06: Case studies

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /customers/:slug` · **Template family:** `case_study`.

**Implementation requirements**

- Create case studies with merchant permission, baseline, period, method and limitations.
- Support real screenshots/quotes with documented usage rights.
- Separate measured results from expectations and show important confounding changes.

**Acceptance:** Period, traffic, confounders and consent are documented.

**Verification case:** Reject publication of a lift claim without its underlying measurement record and merchant approval.

**Dependencies:** BE21.

### MK07: Docs and trust

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /docs and /security` · **Template family:** `docs`.

**Implementation requirements**

- Publish setup, troubleshooting, release and security practice documentation.
- Version integration instructions and identify the owning team for each document.
- Describe only deployed controls and publish an accurate subprocessor/trust inventory.

**Acceptance:** Claims reflect deployed controls; no unsupported certification badges.

**Verification case:** Remove or correct any certification or SLA badge that lacks current evidence.

**Dependencies:** BE18, BE19.

### MK08: Contact and SaaS policies

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Proposed route/entry:** `www /contact and /legal/:slug` · **Template family:** `marketing_content`.

**Implementation requirements**

- Provide demo/support contact paths and SaaS privacy, terms and data-processing documents.
- Route requests to the correct owner and show delivery/failure feedback.
- Keep marketing consent distinct from support requests and record policy versions.

**Acceptance:** Contact capture is consent-aware and reaches the correct inbox or CRM.

**Verification case:** Submitting a support request without marketing opt-in must not enroll the person in campaigns.

**Dependencies:** BE18, BE23.

## Backend capabilities — implementation cards

### BE01: Tenant resolution and boundary

**Priority:** P0 · **First wave:** W1 · **Reported change:** Fix (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Create a verified normalized-host registry and resolve immutable tenant/environment context at every entry point.
- Require tenant context in database, search, media, analytics, cache and worker adapters; reject client spoofing.
- Fail closed on unknown/suspended hosts and unresolved routing; allow only explicitly validated last-known read-only behavior.

**Acceptance:** An A/B tenant matrix covers every public and admin entry; unmapped or suspended host never serves default-store data.

**Verification case:** Use two unrelated shops with identical handles/order suffixes and test HTTP, cache and worker paths during control-plane failure.

**Dependencies:** None.

### BE02: Identity and sessions

**Priority:** P0 · **First wave:** W1 · **Reported change:** Replace (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Replace shared password-derived tokens with individual identity subjects and revocable secure sessions.
- Implement expiration, session rotation, logout/revoke, recovery and privileged MFA through the selected provider.
- Enforce CSRF/origin checks, safe return URLs and distributed login limits; never invent a new password protocol.

**Acceptance:** Revoked or expired sessions fail across instances; session cookies are secure, HttpOnly and appropriately host-scoped; state-changing requests enforce CSRF/origin checks. A stolen session must stop working after revocation; do not claim universal theft detection.

**Verification case:** A revoked or expired session must fail across instances; recovery and login state cannot be reused for another destination.

**Dependencies:** BE01.

### BE03: Role authorization

**Priority:** P0 · **First wave:** W1 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Model organizations, memberships, store grants and action permissions with ownership invariants.
- Authorize actor/action/resource/tenant in services, including worker-triggered actions.
- Handle invitations, role changes, revocation and support grants with permission-cache invalidation.

**Acceptance:** Every service authorizes actor/action/store; URL and body tenant spoofing is denied.

**Verification case:** Try changing tenant IDs in routes, bodies and job payloads; deny cross-store access and protect the final owner.

**Dependencies:** BE02.

### BE04: Catalog synchronization

**Priority:** P0 · **First wave:** W2 · **Reported change:** Fix (verify in code).

**Suggested owner:** Integration engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Verify and persist product, variant, inventory, collection and publication events before asynchronous handling.
- Track full-sync generation/cursors and reconcile missed updates/deletions.
- Prune only after a complete successful generation and invalidate dependent search/render bindings safely.

**Acceptance:** Failed partial sync never deletes good rows; a missed delete is repaired on next successful reconcile.

**Verification case:** Kill a paginated sync halfway and verify no good rows are pruned; a subsequent complete run repairs a missed deletion.

**Dependencies:** BE14, BE17.

### BE05: Search service

**Priority:** P1 · **First wave:** W3 · **Reported change:** Extend (verify in code).

**Suggested owner:** Integration engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Build tenant-scoped indexing, filters, synonyms and bounded query contracts.
- Rebuild into a new index and switch only after validation; expose lag and health.
- Provide an isolated SQL fallback with limits/timeouts and equivalent visibility rules.

**Acceptance:** Cross-store IDs return nothing; index rebuild swaps atomically; large catalogs meet measured latency target.

**Verification case:** Test a large agreed catalog, failed index rebuild and another tenant's identifier; report measured latency and prove isolation.

**Dependencies:** BE01, BE04.

### BE06: Cart and checkout adapter

**Priority:** P0 · **First wave:** W2 · **Reported change:** Replace conditionally (verify in code).

**Suggested owner:** Commerce engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Wrap provider cart creation/mutations/read/handoff behind one commerce adapter.
- Keep local carts as projections and reconcile prices, stock, discounts, tax and delivery before handoff.
- Use secure cart/session binding, idempotency and explicit capability gates; never switch payment modes silently.

**Acceptance:** Gift, tier, coupon, tax, delivery and inventory parity pass on supported merchant plans; no silent discount loss.

**Verification case:** Test duplicate mutation, changed price, last unit, expired cart and failed handoff against authorized provider behavior.

**Dependencies:** BE07, BE25.

### BE07: Promotion compiler

**Priority:** P1 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Suggested owner:** Commerce engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Represent offers as typed rules with eligibility, benefit, schedule, priority and combination constraints.
- Compile supported rules to native/provider functions and return actionable unsupported-rule reasons.
- Run deterministic sample-cart fixtures with integer money and timezone-safe scheduling.

**Acceptance:** Unsupported combinations are blocked; currency rounding is deterministic; schedule timezone edits roundtrip.

**Verification case:** For each enabled offer type, compare actual provider checkout with the fixture expectation; block unsupported combinations.

**Dependencies:** BE25.

### BE08: Content and template service

**Priority:** P1 · **First wave:** W3 · **Reported change:** Replace (verify in code).

**Suggested owner:** Frontend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Implement versioned component schemas, theme manifests, tokens, templates, assignments and drafts.
- Validate settings, tenant-owned bindings and rich content; separate publication from navigation visibility.
- Provide optimistic revisions and deterministic assignment resolution with compatible migrations.

**Acceptance:** Unknown components and unsafe HTML fail validation; template upgrades preserve explicit overrides.

**Verification case:** Reject unknown components, cross-tenant bindings and equal-priority rules; upgrade a theme without losing explicit overrides.

**Dependencies:** BE01, BE15, BE17.

### BE09: Publishing and rendering

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Suggested owner:** Frontend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Validate a complete content snapshot and create an immutable release with hash and dependency references.
- Implement signed previews, scheduling, atomic live-pointer changes and tenant/release-aware cache invalidation.
- Support audited rollback and generate SEO artifacts from the same published state.

**Acceptance:** Publish checks links, contrast, price slots and dependencies; rollback restores correct tenant in minutes.

**Verification case:** Race two publishes and fail one dependency; readers must see a coherent release and rollback must preserve later drafts.

**Dependencies:** BE08, BE12, BE17.

### BE10: Order and refund projection

**Priority:** P0 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Suggested owner:** Commerce engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Ingest verified Shopify order/refund/payment/fulfillment events into separate state dimensions.
- Deduplicate and handle out-of-order delivery through authoritative reconciliation, not arrival order alone.
- Expose role/subject-filtered read models and recompute net sales with explicit currency/cutoff rules.

**Acceptance:** Duplicate/out-of-order events cannot duplicate revenue or regress status; refunds update net sales.

**Verification case:** Replay events out of order around a partial refund; one financial effect is recorded and status does not regress incorrectly.

**Dependencies:** BE14, BE25.

### BE11: Subscription billing

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Implement supported Shopify subscription approval, plan lifecycle and billing-event reconciliation.
- Maintain a versioned plan catalog and append-only usage/charge references.
- Derive entitlements from trusted provider state with explicit grace, downgrade and cancellation policy.

**Acceptance:** Signed billing events are idempotent; cancelled plans revoke writes after disclosed grace period; webhook delays repair.

**Verification case:** Miss an activation event and receive an older cancellation later; reconcile to current provider truth without double billing.

**Dependencies:** BE14, BE25.

### BE12: Domains and certificates

**Priority:** P0 · **First wave:** W1 · **Reported change:** New (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Implement unique normalized-host registration with an ownership challenge.
- Activate only after required DNS/TLS checks and generate safe primary-host redirects.
- Reverify or deactivate on removal/reassignment and clean routing/cache references.

**Acceptance:** Reclaimed domains cannot impersonate stores; redirects retain paths safely; stale DNS has safe error.

**Verification case:** A domain previously belonging to tenant A cannot be activated for tenant B without new proof and safe cleanup.

**Dependencies:** BE01.

### BE13: Secret management

**Priority:** P0 · **First wave:** W1 · **Reported change:** Fix (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Store encrypted secrets with tenant, purpose, key version and rotation metadata.
- Use managed encryption/envelope protection with dual-read/single-write rotation and an audited revoke flow.
- Mask all read models and block secret exposure in logs, browser bundles, URLs and diagnostics.

**Acceptance:** Dual-read/single-write rotation succeeds without re-onboarding; no secrets in browser, logs or URLs.

**Verification case:** Rotate keys with old/new ciphertext present; connections continue without plaintext export or mandatory merchant re-onboarding.

**Dependencies:** BE01.

### BE14: Durable jobs and webhook inbox

**Priority:** P0 · **First wave:** W2 · **Reported change:** Replace (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Verify raw webhook bodies and shop binding, then persist receipt before acknowledgement.
- Implement durable dispatch, worker leases, retries with jitter, idempotency and dead letters.
- Add reconciliation and safe replay with explicit tenant/environment context; after-response work is only an optimization.

**Acceptance:** Worker crash after acknowledgment loses no order event; duplicate replay changes money state once.

**Verification case:** Crash before/after processing and replay deliveries; no accepted event is lost and no money effect is duplicated.

**Dependencies:** BE01, BE17.

### BE15: Asset storage and media pipeline

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Suggested owner:** Frontend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Issue tenant-bound signed uploads with size/type/extension constraints and server-side verification.
- Generate optimized derivatives with dimensions and track draft/live usage references.
- Sanitize or reject executable formats and expire private downloads under retention rules.

**Acceptance:** Malicious SVG/HTML cannot execute; private asset links expire; media cannot cross tenant boundary.

**Verification case:** Upload disguised HTML/SVG and reference another tenant's object key; reject execution and unauthorized access.

**Dependencies:** BE01, BE18.

### BE16: Audit and approval

**Priority:** P1 · **First wave:** W1 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Append actor, action, tenant, resource, request, time and safe diff for privileged changes.
- Bind approvals to exact resource revisions/content hashes and expire/revoke them when needed.
- Provide scoped read/export APIs with redaction and tamper-resistant storage policy.

**Acceptance:** Every privileged mutation produces durable audit; payloads exclude secrets and minimize PII.

**Verification case:** Approval for revision N must not authorize N+1; attempts to mutate historical audit records must fail.

**Dependencies:** BE02, BE03.

### BE17: Versioned migrations

**Priority:** P0 · **First wave:** W1 · **Reported change:** New (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Track schema/migration checksums and per-tenant execution state with safe retry.
- Use expand/backfill/contract steps and support compatible application/content versions during rollout.
- Canary migrations, record recovery procedures and distinguish reversible application changes from data loss.

**Acceptance:** A failed tenant migration can retry safely; renderer supports previous and current content schema during rollout.

**Verification case:** Interrupt a migration and resume; no duplicate mutation occurs and failure in one tenant does not corrupt another.

**Dependencies:** BE01.

### BE18: Privacy lifecycle

**Priority:** P0 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Define purpose-specific consent versions, collection rules and provider propagation.
- Implement verified Shopify privacy topics and scoped subject export/deletion workflows.
- Track derived stores, retention exceptions and backup expiry without logging request PII unnecessarily.

**Acceptance:** Signed privacy requests are handled and tracked; denied consent never forwards optional marketing events.

**Verification case:** Withdraw optional consent and request deletion; forwarding stops and incomplete downstream deletion remains visible for repair.

**Dependencies:** BE14, BE25.

### BE19: Monitoring and service operations

**Priority:** P0 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Instrument tenant-safe logs, errors, dependency health, queue age and synthetic journeys.
- Configure real alert delivery, severity, runbooks and incident ownership.
- Expose stale/degraded status and monitor failures of reconciliation, publishing and background jobs.

**Acceptance:** Alert delivery is tested; degraded dependencies are distinguished from outage; logs are PII redacted.

**Verification case:** Trigger a synthetic failure and queue delay; verify an actual alert reaches the configured test destination and contains no secrets.

**Dependencies:** BE01, BE14.

### BE20: Analytics event contract

**Priority:** P1 · **First wave:** W2 · **Reported change:** Extend (verify in code).

**Suggested owner:** Data engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Define versioned event names/properties with tenant, release, time, consent and event identity.
- Validate and deduplicate ingestion; separate behavioral observations from authoritative order events.
- Measure collection coverage and prevent PII from entering general analytics properties.

**Acceptance:** Observed sessions and financial orders use distinct denominators; invalid and duplicate events are rejected.

**Verification case:** Deny consent and send a duplicate purchase event; optional destinations receive nothing and revenue is not counted twice.

**Dependencies:** BE18, BE14.

### BE21: Reporting and unit costs

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Suggested owner:** Data engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Maintain reconciled sales/order/refund rollups and separately model subscription MRR movements.
- Define timezone/currency boundaries, freshness, coverage and export contracts.
- Allocate direct platform costs with visible assumptions and maintain discrepancy queues.

**Acceptance:** Net revenue reconciles to Shopify; MRR excludes setup fees and taxes; timezone boundaries are reproducible.

**Verification case:** Run fixtures spanning midnight, refund cutoff and plan change; reported totals must reproduce from source records.

**Dependencies:** BE10, BE11, BE20.

### BE22: Experimentation

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Suggested owner:** Data engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Implement stable assignment, eligible exposure recording and compatible published variants.
- Store hypothesis, sample plan, primary metric, guardrails and stopping/analysis rules.
- Detect assignment/coverage anomalies and route variant adoption through normal publishing.

**Acceptance:** A/A instrumentation test passes; sample ratio mismatch stops interpretation; no early winner by repeated peeking.

**Verification case:** An A/A test should reveal instrumentation defects; insufficient samples or allocation mismatch must block winner interpretation.

**Dependencies:** BE09, BE20.

### BE23: Notifications

**Priority:** P1 · **First wave:** W3 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Create durable notification intents with one owner per transactional message and idempotency key.
- Support configured providers, delivery/bounce state and authorized templates.
- Apply optional-marketing consent, unsubscribe, caps and safe payload minimization.

**Acceptance:** One actor owns each order notification to prevent duplicates; bounced emails surface; secrets stay out of content.

**Verification case:** Replay an event after provider timeout; reconcile delivery state and avoid sending a duplicate order message.

**Dependencies:** BE14, BE18.

### BE24: Integration framework

**Priority:** P1 · **First wave:** W2 · **Reported change:** New (verify in code).

**Suggested owner:** Integration engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Define provider adapters for capabilities, credentials, scopes, connection state and callbacks.
- Normalize retries/reconciliation while preserving provider-specific limitations.
- Expose compatibility preflight and revoke behavior per tenant; avoid hardcoded credentials or universal-support claims.

**Acceptance:** Unsupported storefront app is identified before launch; health and revoke work per store.

**Verification case:** Install an unsupported theme-script app and revoke another provider; preflight flags the first and jobs stop using the second.

**Dependencies:** BE13, BE14.

### BE25: Shopify partner integration

**Priority:** P0 · **First wave:** W2 · **Reported change:** Replace (verify in code).

**Suggested owner:** Integration engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Audit the actual distribution/installation model, approved checkout path and customer-data access.
- Upgrade API contracts only after targeted tests and implement signed state, shop binding, scope checks and uninstall/reinstall handling.
- Separate coding-ready interfaces from external approval dependencies; verify official requirements at implementation time.

**Acceptance:** Separate merchant shops pass install/uninstall/reinstall; protected-data review and checkout requirements are satisfied.

**Verification case:** Two unrelated shops complete independent install, revoke and reinstall flows with distinct keys and no cross-shop customer data.

**Dependencies:** BE13, BE14.

**Release note:** Record external distribution, checkout and customer-data dependencies separately from local code status. Never claim approval from passing API calls.

### BE26: Provisioning orchestration

**Priority:** P1 · **First wave:** W4 · **Reported change:** Extend (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Orchestrate tenant/database/connection/catalog/domain setup as resumable idempotent steps.
- Store resource references and compensation state for cancellation or partial failure.
- Seed only neutral defaults and permitted template structure; record launch prerequisites.

**Acceptance:** Retry or cancellation leaves no orphan credentials or billable resources; no BeastLife seeds.

**Verification case:** Retry after resource creation and cancel before activation; no orphan credential, duplicate tenant or unintended billable resource remains.

**Dependencies:** BE01, BE12, BE17.

### BE27: Backups and recovery

**Priority:** P0 · **First wave:** W2 · **Reported change:** New (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Configure encrypted backups and distinct retention policies for control-plane and tenant state.
- Restore into an isolated environment and verify content, IDs, secrets references and operational consistency.
- Document measured recovery time/data loss and an authorized recovery procedure.

**Acceptance:** Restore one tenant into isolation and prove order/cms integrity; use provider features only after verification.

**Verification case:** Restore a selected tenant without overwriting another; reconcile provider-owned commerce before permitting new writes.

**Dependencies:** BE13, BE17.

### BE28: Agency access and economics

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Represent agency organizations and explicit client-accepted per-store permission grants.
- Implement privacy-safe kit copying, revision-bound client approvals and revocation.
- Track referral attribution and eligible collected revenue with refund/reversal adjustments.

**Acceptance:** Cross-client negative tests pass; commissions apply to collected eligible revenue and reverse on refunds.

**Verification case:** A verified agency without grants sees no clients; revoked access fails immediately and copied kits contain no private source data.

**Dependencies:** BE02, BE03, BE11.

### BE29: Export and offboarding

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Export supported tenant content/configuration/media with a versioned manifest and expiring authorized download.
- Handle cancellation/uninstall separately, revoke connections and schedule retained-data disposal.
- Track deletion across derived systems while preserving documented retention exceptions and merchant Shopify data.

**Acceptance:** Merchant can leave without losing Shopify commerce; privacy deletion propagates to derived services.

**Verification case:** Offboard one tenant and verify no further jobs use its keys, exports are scoped and another tenant remains untouched.

**Dependencies:** BE18, BE24.

### BE30: Customer accounts

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Suggested owner:** Integration engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Integrate the supported customer-account flow with per-store subject binding.
- Implement safe login handoff, account APIs, expiration and logout.
- Minimize accessible order/profile fields and keep customer identity separate from staff/operator identity.

**Acceptance:** Authenticated access cannot return another account's order; session expiry and logout work across handoff.

**Verification case:** Attempt customer A's order through customer B's session, including a different store with the same email; deny access.

**Dependencies:** BE25.

### BE31: Bundle and subscription adapters

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Suggested owner:** Commerce engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Implement advanced bundle components and supported selling-plan provider adapters.
- Represent inventory, price, fulfillment, cancellation and partial-refund semantics explicitly.
- Enable only provider/merchant combinations that pass compatibility tests and display unsupported states.

**Acceptance:** Checkout, stock, fulfillment and partial refund semantics are verified before enablement.

**Verification case:** Validate bundle depletion and recurring-plan cancellation end to end before enabling these capabilities for a store.

**Dependencies:** BE06, BE07, BE24.

### BE32: AI assistance

**Priority:** P2 · **First wave:** W5 · **Reported change:** New (verify in code).

**Suggested owner:** Backend lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Retrieve only authorized tenant facts and generate structured proposals referencing allowlisted components.
- Apply model budgets, input/output checks and evidence links; keep prompts and imported content untrusted.
- Authorize every tool action independently and require ordinary review/publish for changes.

**Acceptance:** Merchant data is not shared/trained across stores without authorization; tool writes enforce permissions.

**Verification case:** Inject an instruction into imported product copy to export another tenant's data; no data or action may cross the boundary.

**Dependencies:** BE08, BE18, BE33.

### BE33: Entitlements and quotas

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Suggested owner:** Platform engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Evaluate purchased entitlements, rollout flags and resource quotas separately on the server.
- Meter with idempotent usage events and show thresholds before limits are reached.
- Provide explicit approved overages and safe degraded behavior instead of unexpected storefront shutdown.

**Acceptance:** Bot traffic cannot silently cause unapproved billing; hard limits preserve a safe published storefront.

**Verification case:** Tamper with client plan flags and replay usage events; access and charges remain tied to trusted state without duplication.

**Dependencies:** BE11, BE19.

### BE34: Security testing

**Priority:** P0 · **First wave:** W2 · **Reported change:** New (verify in code).

**Suggested owner:** QA lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Maintain a scoped threat model covering tenant boundaries, auth, XSS, SSRF, secrets and webhook abuse.
- Implement distributed abuse controls and risk-based dependency/security checks in the release pipeline.
- Use unrelated-tenant integration/E2E cases and track unresolved launch risks with evidence.

**Acceptance:** No critical or high unresolved launch issue; separate-shop payment/identity tests run in release gate.

**Verification case:** Try server-side URL fetches to private addresses, cross-tenant IDs and revoked sessions; demonstrate blocking controls on reachable paths.

**Dependencies:** BE01, BE02, BE06.

### BE35: Performance and load testing

**Priority:** P1 · **First wave:** W4 · **Reported change:** New (verify in code).

**Suggested owner:** QA lead. Reuse the existing equivalent service where present.

**Implementation requirements**

- Set measured page/asset/query budgets and agreed traffic/catalog/concurrency fixtures.
- Test regional latency, dependency timeouts, queue drain and noisy-neighbor behavior.
- Report achieved performance and per-tenant cost; do not substitute a lab score for field experience.

**Acceptance:** Test agreed peak traffic, queue drain and fallback; report measured tenant costs and bottlenecks.

**Verification case:** Load one tenant heavily while another completes a purchase journey; document degradation, recovery and capacity limits.

**Dependencies:** BE05, BE09, BE14.

### BE36: Tax and money definitions

**Priority:** P0 · **First wave:** W2 · **Reported change:** Fix (verify in code).

**Suggested owner:** Commerce engineer. Reuse the existing equivalent service where present.

**Implementation requirements**

- Centralize currency metadata, integer minor units, rounding and tax-inclusion definitions.
- Keep estimates, final order amounts, refunds and invoices tied to their authoritative source.
- Handle partial refunds/discount allocation without floating-point drift or invented local payment state.

**Acceptance:** Cart estimate is labeled; final Shopify total wins; invoices and refunds use the authoritative tax source.

**Verification case:** Use multi-line discounts, tax-inclusive prices and partial-refund fixtures; reconcile exact minor-unit totals with provider records.

**Dependencies:** BE06, BE10.

## Source and implementation boundaries

The existing guide is the baseline report. The previous blueprint supplies strategy and dated platform research. `reference/Implementation_Specification.md` supplies the proposed entity/API/state contracts; `reference/sources.json` identifies its research sources. Verify changing platform requirements against official sources when implementing them. This feature list adds task-level detail; it does not certify security, approve checkout integration or represent completed development.
