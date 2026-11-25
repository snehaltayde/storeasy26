**Storeasy CMS: architecture audit and product direction**

29 October 2026 · Audited repository baseline: `d9b6637` · Analysis only

**Storeasy should evolve into a visual storefront composition system on its existing commerce and tenant foundation.** The current CMS already supports useful structured editing and publishing, but most page layouts remain fixed React code. Resource pickers solve an immediate authoring problem; reusable templates, a common renderer, and reliable publication boundaries solve the larger product problem.

The user confirmed the target: **a visual section builder with flexible templates and brand controls, serving D2C merchants and their marketing teams first.** The user and Codex will direct and review; Claude will implement. This report contains recommendations, not approval to implement or deploy them.

**Evidence and limits.** This review surveyed the repository architecture and traced CMS authoring, content storage, renderers, catalog integration, tenant boundaries, media, permissions and publishing in depth. Existing product specifications and implementation notes were compared with current source. It is not an exhaustive line-by-line audit of every commerce subsystem, a penetration test, a production inspection, or a load test. The local admin URL reached the login screen; authenticated editor journeys were not exercised. The historical PDF/DOCX reference artifacts were not independently reviewed; the Markdown handoff and feature/status documents were reviewed.

Five existing suites were executed against their isolated test databases, without loading project environment files:

| Command | Result |
| --- | --- |
| `node scripts/test-cms.js` | 11 passed |
| `node scripts/test-content.js` | 18 passed |
| `node scripts/test-releases.js` | 17 passed |
| `node scripts/test-themes.js` | 10 passed |
| `node scripts/test-storefront.js` | 15 passed |
| **Total** | **71 passed, 0 failed** |

These tests establish a useful baseline. They do not cover all the failure paths identified below. No application code, production records, credentials or deployment configuration were changed. New audit documents are the deliverables.

**The project is broader than its original README suggests.** It has grown from a single Shopify-backed storefront into a multi-tenant commerce application with merchant, operator and agency consoles. That foundation is worth preserving.

| Layer | Observed implementation | Direction |
| --- | --- | --- |
| Application | Next.js 16.2.9, React 19.2.4, JavaScript ESM, pnpm, Tailwind 4 | Preserve stack; modularize around existing boundaries |
| Tenant control plane | Host resolution, tenant registry, separate tenant databases, sessions/memberships, domains, provisioning | Preserve isolation; close conditional fallback defects |
| Commerce projection | Shopify sync to libSQL/Turso, products/variants/collections, generation-based pruning, SQL/Typesense search | Reuse for pickers; complete catalog coverage and explicit eligibility |
| Commerce execution | Server cart, offers, direct Razorpay/COD, order state, Shopify push/reconciliation, returns | Keep behavior behind existing services; CMS edits presentation |
| Merchant console | Shared shell and primitives, catalog, storefront, orders, growth, settings, billing | Improve task flows within the existing console |
| CMS | Blocks/pages, revisions, typed content, navigation, catalog presentation overrides | Introduce durable component identities and reusable templates |
| Publication | Snapshots, hashes, preview tokens, live pointer, schedule/cancel, rollback | Extend into a complete, coherent presentation release |
| Operations | Jobs, audit, support grants, health, migrations, exports, restore tooling | Extend existing mechanisms to cover new CMS entities |
| Expansion | Accounts, journal, bundles, quizzes, experiments, automation, agencies | Integrate progressively; keep first delivery focused on core D2C journeys |

The existing handoff already describes a versioned template/assignment architecture. The current implementation log explicitly records visual editing and PDP/collection template assignment as partial. Completing that design is preferable to introducing a separate CMS beside it. See the [customization contract](</Users/snehal/Documents/Projects 2026/storeasy26/docs/storeasy-saas/Storeasy_Claude_Developer_Handoff.md:85>) and [recorded template gaps](</Users/snehal/Documents/Projects 2026/storeasy26/docs/storeasy-saas/IMPLEMENTATION_STATUS.md:745>).

**Current capabilities are uneven, rather than absent.** We should keep the working parts and replace the contracts that prevent them from scaling.

| Capability | Current state | Missing for the requested experience |
| --- | --- | --- |
| Catalog selection | Searchable catalog browser; homepage collection suggestion chips; media picker | Shared product, variant, collection, page and link pickers |
| Homepage composition | Four section kinds; duplicate, reorder, hide; section undo/redo | Richer library, real layout variants, persistent section IDs, configurable hero |
| Content pages | Text, sanitized HTML, image and FAQ sections | Visual rich-text editing, flexible layouts, reusable structures |
| Templates | Code-defined page prefills | Saved tenant templates, versioning, assignment and inheritance |
| Themes | Pulse/Glow presets with a stored version pin | Version-addressable manifests, deeper component styles, upgrade contracts |
| Brand | Accent/background/foreground, radius, three type scales | Fonts, semantic palettes, widths, spacing, cards, buttons, responsive controls |
| Preview | Real storefront iframe; device widths; saved-draft refresh | Click-to-select, live editor-state preview, section highlighting |
| Draft concurrency | Revision checks and conflict UI on normal saves | Consistent revision requirements, guarded deletion/reset, retained history |
| Publishing | Whole-site release, diff, scheduling and rollback | Complete dependency set, exact reviewed candidate, selected changesets later |
| Editorial roles | Read/write storefront permission | Separate edit, design, review, publish and destructive permissions |
| Media | Upload, alt text, deduplication, derivatives, usage checks | Complete retention/dependency protection; search/pagination; focal points |
| Localization | No general locale-aware CMS model found in audited paths | Design-compatible locale model; full translation workflow only when needed |

The current homepage uses explicit Save actions. It retains section undo/redo; historical claims of autosave should not be repeated as current behavior. See [HomeEditor](</Users/snehal/Documents/Projects 2026/storeasy26/components/admin/cms/HomeEditor.js:20>).

**The highest-priority findings concern correctness underneath the editor.** These are source-verified paths, not claims that production has been exploited. Urgency below is this audit's prioritization.

| Finding | Evidence and consequence | Required direction |
| --- | --- | --- |
| Urgent: CMS operation and permission can disagree | `getPage` selects read permission, while a mixed payload can enter an earlier block/page/delete mutation branch. [API](</Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/storefront/route.js:32>) | Parse exactly one operation; reject ambiguous payloads; authorize that operation; exercise real route-level denial tests |
| Urgent: published read failure can select drafts | Live-release lookup catches errors as null; resolver treats null as draft mode. Draft exposure is possible if subsequent reads succeed. [Release lookup](</Users/snehal/Documents/Projects 2026/storeasy26/lib/releases.js:192>), [resolver](</Users/snehal/Documents/Projects 2026/storeasy26/lib/content/resolve.js:33>) | Distinguish uninitialized, missing/corrupt and unavailable; serve only validated published content to shoppers |
| Urgent: conditional wrong-shop catalog ingestion | The Storefront-source sync client reads environment shop/token while writes use active tenant DB. This concerns that source path; Admin-source sync has tenant-owned credentials. [Source selection](</Users/snehal/Documents/Projects 2026/storeasy26/lib/sync.js:26>), [client](</Users/snehal/Documents/Projects 2026/storeasy26/lib/shopify.js:4>) | Tenant-owned source clients or prohibit the unsupported path in platform mode; missing credentials must fail closed |
| Urgent: conditional bootstrap authentication fallback | Membership lookup exceptions return false; false can re-enable a retained bootstrap credential. Requires the relevant outage/cache/credential conditions. [Detector](</Users/snehal/Documents/Projects 2026/storeasy26/lib/platform/sessions.js:121>), [auth](</Users/snehal/Documents/Projects 2026/storeasy26/lib/admin-auth.js:53>) | Separate absence from lookup failure; audit equivalent operator behavior; prevent completed onboarding from reverting to bootstrap |
| High: publication scope is incomplete | Snapshot contains blocks/pages/brand/theme; product modules, collection pins and other presentation settings have separate live behavior. [Snapshot](</Users/snehal/Documents/Projects 2026/storeasy26/lib/releases.js:46>), [overrides](</Users/snehal/Documents/Projects 2026/storeasy26/lib/catalog-overrides.js:1>) | Release all presentation state together; retain live commerce facts outside the snapshot |
| High: reviewed changes can differ from published changes | Publish snapshots current mutable drafts; request does not identify the exact reviewed candidate. Reads span several records and control-plane configuration. [Publish API](</Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/releases/route.js:49>) | Create immutable candidate first, review its hash, publish precisely it; detect concurrent changes during candidate construction |
| High: media deletion can break scheduled or restored content | Usage scan covers draft blocks/pages and live release, excludes historical/scheduled releases; original deletion also removes derivatives. [Media usage/deletion](</Users/snehal/Documents/Projects 2026/storeasy26/lib/media.js:148>) | Track dependency IDs across assets/derivatives/drafts/retained releases; archive and retain referenced assets |
| High: repeated home sections overwrite each other's data | All collection instances share `data.collections`; all newest-product instances share `data.products`. Last fetch wins. [Homepage](</Users/snehal/Documents/Projects 2026/storeasy26/app/(storefront)/page.js:45>) | Persist section IDs; scope fetched data and DOM identity per instance; batch compatible queries |
| High: variants are incomplete for a universal picker | Admin projection takes first 50 variants; Storefront projection first 100. Product sync is active-only; availability is not publication eligibility. [Admin catalog](</Users/snehal/Documents/Projects 2026/storeasy26/lib/shopify-admin-catalog.js:9>), [Storefront fields](</Users/snehal/Documents/Projects 2026/storeasy26/lib/shopify.js:72>) | Complete variant pagination; define and retain selectable/channel eligibility; report catalog freshness |
| Medium: conflict protection has gaps | Ordinary API callers may omit revisions; reset/delete are unguarded. [Write API](</Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/storefront/route.js:39>), [storage](</Users/snehal/Documents/Projects 2026/storeasy26/lib/cms/store.js:61>) | Require expected revision on ordinary mutations; isolate privileged migration/overwrite paths; retain history |
| Medium: defaults and dependencies can drift after publish | Snapshot stores customized values; runtime supplies current code defaults. Kit lookup is primarily by kit ID. [Defaults](</Users/snehal/Documents/Projects 2026/storeasy26/lib/releases.js:43>), [kits](</Users/snehal/Documents/Projects 2026/storeasy26/lib/themes/kits.js:69>) | Materialize effective defaults or pin fully versioned manifests; preserve compatible renderers |
| Medium: page save and redirect behavior are separate | Page persistence precedes some redirect validation; redirects are mutable outside releases. [Page save](</Users/snehal/Documents/Projects 2026/storeasy26/lib/cms/store.js:268>) | Validate first; make page/route edits atomic; publish redirects with content |
| Medium: editing and publishing share one permission | Staff can edit and publish through `storefront.write`; agency acknowledgements are not general enforced publication approval. [Roles](</Users/snehal/Documents/Projects 2026/storeasy26/lib/platform/authz.js:15>), [release authorization](</Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/releases/route.js:42>) | Introduce explicit editorial capabilities and optional review gates bound to the candidate hash |

Additional boundaries belong in the foundation work: Typesense must reject missing/duplicate tenant namespaces instead of falling back to a common index; media usage must include actual brand/site and product presentation dependencies; missing tables and operational failures must not silently appear as empty content during release construction. These require targeted regressions, not a broad unverified security claim.

**Pickers should be a shared CMS capability.** The current catalog is a good starting point because products, collections and variants already have stable Shopify GIDs. The existing admin endpoint returns only 30 products, fetches all collections/overrides, drops collection IDs from its response and performs a pin lookup per collection. It needs a narrow selection read model with pagination, rather than reuse unchanged. See [catalog API](</Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/catalog/route.js:56>) and [catalog identities](</Users/snehal/Documents/Projects 2026/storeasy26/lib/schema.sql:4>).

The intended interaction is: click **Select products**, search recognizable names or SKUs, inspect thumbnails and availability, select items, confirm, and reorder the chosen cards. For collections, show name, image and count. For variants, show product, option values, SKU and availability. Never require a merchant to discover or paste a GID.

| Picker | Use it for | Persist |
| --- | --- | --- |
| Product | Featured products, related products, upsell targets, product-specific presentation | Product reference |
| Variant | Bundle components, gifts, direct add-to-cart actions | Explicit variant reference |
| Collection | Featured categories, collection templates, collection-linked CTAs | Collection reference |
| Page | Navigation, buttons, related articles | Stable CMS page reference |
| Link | Product/collection/page destination, external URL, email, phone or anchor | Typed destination with validated options |
| Media | Images, brand assets, mobile/desktop art direction | Asset reference and presentation settings |

Every picker needs single/multiple modes, selected-item hydration across pages, stable ordering, cancellation, selection limits, duplicate prevention, keyboard operation, focus restoration and loading/error/empty states. Selection must remain visible even when the current query no longer returns the selected items. Filter collection pins to that collection's members. Product status should distinguish unavailable, deleted, unsynced and ineligible where the projection supports them.

**“All real products” means all eligible products are reachable through search and pagination.** It does not mean downloading the entire catalog into a dropdown. Start with the tenant's synchronized catalog, show the last successful sync and sync failures, and add status coverage deliberately. Do not label sold-out as unpublished, or pretend the current active-only projection contains draft/archived products. Complete variant fetching before promising that every real variant can be selected.

Store references by resource type, stable ID and source where needed. Tenant/environment ownership comes from trusted server context; a request body does not authorize another tenant. Resolve the current handle to build URLs. Preserve optional display metadata for explaining a missing selection, but never use its saved price or stock as commerce truth. A Shopify handle rename should update links automatically; a deletion should produce a visible issue with a defined component fallback.

Migrate existing handle strings within each tenant. Convert resolvable references, record unresolved ones for repair, preserve ordering and original migration evidence, and retain compatibility while older content remains. Product overrides and collection pins already store IDs internally; do not create a second identity system. CMS page slugs still need an editable URL field because they create a URL, whereas a product picker selects an existing entity.

**The target architecture needs six distinct concepts.** Keeping them separate prevents the next editor from becoming another collection of bespoke forms.

| Concept | Responsibility | Merchant example |
| --- | --- | --- |
| Component definition | Versioned renderer, settings, bindings, allowed children, validation, migrations | A product rail with list/grid variants |
| Theme version | Design defaults, compatible components and default templates | A beauty visual system with rounded cards and serif headings |
| Tenant template | Named reusable page composition and allowed overrides | “Editorial product detail” |
| Assignment | Connect a page family or specific entity to a template | Apply editorial design to this collection's products |
| Page/content instance | Page-specific copy, references, media and permitted overrides | Images and ingredient content for one serum |
| Release candidate | Frozen effective presentation, assignments and retained dependencies | Reviewed festive launch ready to schedule |

Component definitions should drive both editor controls and server validation. Each component instance needs a persistent ID independent of its title, position or type. Define bounded child slots, page-family compatibility, responsive settings, and permitted data bindings. A tenant can create a new composition from supported components without a deployment; introducing an entirely new interactive capability still requires platform development once.

Template assignment precedence should be: **explicit entity assignment → highest-ranked matching rule → tenant page-family default → theme default**. Initially implement explicit assignment and family defaults; add rules after that path is reliable. Reject equal-priority matches instead of choosing unpredictably. Explain the selected template and reason in the editor. Design inheritance should separately follow theme defaults → tenant design overrides → template settings → permitted page/section overrides, with visible inherited/customized states and reset-to-inherited controls.

Preview and public rendering must use the same component registry and renderers. Keep editor overlays and drag behavior out of the public bundle. Compile/query the page's data requirements in batches, then resolve data per component ID. No network request per card or repeated full catalog scan per section. Version templates, manifests and schema migration functions; block unsupported future versions safely. Publishing an old release must not silently pick new defaults or lose its images.

**The visual workspace should make the page itself the primary editing context.** Use a left section/layer tree and insertion library, a central real storefront preview, and a right settings inspector. The top bar shows page family, template, real product/collection context, device width, draft state and Review/Publish. Clicking a section in the preview selects its tree item and properties. Editing a field updates a clearly identified preview state. Saved, unsaved and published are visibly distinct.

Provide duplicate, move, hide, delete, keyboard reorder, undo/redo and recovery. A visual rich-text editor should replace routine HTML authoring while retaining sanitization and typed links. Show the effect of switching templates before applying it: compatible content retained, unsupported slots needing a destination, and any resulting removals. Distinguish **insert a copy** from **link a shared section**; linked edits show all affected pages before publication. Use persistent IDs for selection, comments, diffs and recovery.

An autosave model can be introduced once revision handling and recovery are dependable. It should save drafts only and use one consistent state model across the workspace. Do not restore autosave merely because an older implementation had it. Existing dirty guards and conflict behavior need completion before relying on them for long editing sessions.

**Tenant design control should cover the complete visual system.** Today the editable brand model is small, while many cards, grids, text colors and widths remain fixed. The footer uses a fixed palette; rich text has hardcoded colors; many explicit text-size utilities bypass the body type scale. Therefore changing one background color does not guarantee a coherent or accessible theme. See [brand model](</Users/snehal/Documents/Projects 2026/storeasy26/lib/brand.js:12>), [content renderer](</Users/snehal/Documents/Projects 2026/storeasy26/components/ContentPage.js:11>) and [styles](</Users/snehal/Documents/Projects 2026/storeasy26/app/globals.css:78>).

Expose approved font families and weights, heading/body scales, semantic color schemes, container width, spacing scales, border/radius/shadow choices, button styles, card treatments, image aspect ratios, crop/focal point, alignment and responsive columns. Add desktop/mobile overrides where they solve real needs. Schema defaults and constraints should keep output usable; publish checks should identify contrast, missing alternative text, empty required content and incompatible components. Validate the rendered combinations as well as the token values.

“Complete control” means tenants can create and customize supported visual compositions without editing code. Required purchase facts, variant selection, availability, totals, payment behavior, identity and consent remain governed by functional components. For checkout/account pages, offer alternate visual arrangements and approved slots around those components, with capability-aware controls. Preserve the existing direct checkout mode and its state machine; Shopify-hosted checkout is currently reserved but unimplemented in the adapter, not a finished alternative.

**Every shopper surface needs an explicit customization contract.** Multiple templates should mean materially different layouts, not several color presets. The following is a proposed portfolio, not a claim these variants exist today.

| Page/surface | Current layout | Proposed choices and controls | Delivery |
| --- | --- | --- | --- |
| Home | Fixed hero plus four section kinds | Product-led, editorial, campaign-led; image/video-ready hero, curated rails, story sections | Core |
| Product detail | Fixed gallery/purchase columns | Classic split, editorial/story, specifications-led; gallery modes and content slots | Core |
| Collection detail | Fixed listing/filter structure | Compact grid, banner/editorial grid, sidebar filtering; cards, density, intro sections | Core |
| Collections index | Fixed collection cards | Image grid, editorial groups, compact category directory | Core follow-through |
| Campaign/landing | Generic ContentPage | Launch, promotion, education/lead landing; real product bindings and date windows | Core follow-through |
| General pages/about | Narrow text-oriented renderer | Article, split media/story, full-width section composition | Core follow-through |
| FAQ/contact | FAQ blocks and appended contact form | Accordion help, grouped help, split contact; reposition approved form component | Core follow-through |
| Policies | Shared content renderer | Plain document, sectioned document with contents navigation | Functional coverage |
| Search | Fixed results/grid | Compact results, discovery-oriented results; approved filter/result modules | Expansion |
| Journal index/article | Fixed index/shared article | Magazine/list index; classic/feature article | Expansion |
| Bundle detail | Fixed bundle components/purchase | Product-led bundle, comparison/story bundle; explicit variant selection retained | Expansion |
| Quiz | Fixed question/result shell | Minimal steps, illustrated steps; style/layout around existing quiz logic | Expansion |
| Wishlist | Fixed list/grid surface | Grid, compact list; consistent empty/sold-out states | Expansion |
| Cart | Global drawer | Drawer variants and optional page shell; protected cart lines/totals/actions | Controlled |
| Checkout | Fixed functional flow | Approved visual presets/content slots; existing payment flow protected | Controlled |
| Account/orders/tracking/confirmation | Fixed functional pages | Compact/cards or split summary layouts around secured functional modules | Controlled |
| 404/offline/error/maintenance | Basic branding/fixed composition | Minimal, illustrated, helpful-navigation variants; correct response semantics | Functional coverage |
| Header/footer/announcement | One structure with editable navigation | At least two structural variants; logos, menu/search arrangement, footer groups | Core |
| Platform marketing/operator/admin | Platform-owned surfaces | Shared platform design system, separate from merchant storefront templates | Separate scope |

Generic CMS pages currently generally use `/policies/:slug`, with dedicated about/contact routes and separate campaign/journal routes. A more natural `/pages/:slug` contract should be a deliberate migration with redirects and reserved-path validation. Do not change existing public URLs incidentally while introducing templates.

**Enterprise quality is primarily about trustworthy operations.** For D2C teams, the initial editorial roles should be content editor, designer, publisher and owner, mapped into existing membership infrastructure through capabilities. A small merchant can hold all capabilities; a larger team can split them. Approval can be optional per tenant, but when enabled it must authorize the exact immutable release candidate. An acknowledgement link that does not gate publishing is not a complete approval workflow.

Publish should follow: save revisions → build coherent candidate → validate dependencies → review exact diff/impact → approve if required → publish or schedule that candidate → verify live pointer and render health. Rollback restores presentation references/configuration, not historical prices or stock. A scheduled release should recheck current reference eligibility and conflicts, then fail visibly or use a documented safe fallback. It must not silently rebuild from newer drafts.

All presentation changes should obey the same publication rule: templates, assignments, brand, global sections, navigation, product modules, pins, presentation placements, page routes and media dependencies. Offers and other commercial rules remain under their own business lifecycle, with explicit coordination where a campaign depends on them. Do not snapshot payments, orders, inventory or cart totals into CMS releases. Experiments should be visible in preview context, so an active override cannot unexpectedly mask the design being reviewed.

Draft history needs retained revisions, actor/time information, restore and comparison. Optimistic concurrency comes first; real-time co-editing can wait. Durable audit for critical publication/access/destructive actions needs stronger guarantees than the current best-effort logging if stronger enterprise audit promises are made. Export/restore must include templates, assignments, revisions, redirects and necessary assets, with retained ownership boundaries.

Media should gain searchable metadata, pagination, folders/tags if useful, per-use alt text, crop/focal point, mobile variants and dependency-aware archival. Tenant-keyed object storage/CDN and server-generated transforms are sensible scale directions; current database blob storage is not proof of a measured production bottleneck. Make that migration a measured work item with a compatible URL/retention strategy, not a prerequisite to the first picker.

The checked-in scheduler is a best-effort five-minute GitHub tick and requires deployment secrets. Exact campaign activation times need an operational scheduler and lateness monitoring. The repository's checked-in workflows do not currently demonstrate a build/test CI gate. Establish one for the affected paths and verify deployment behavior separately from local suite results.

**Delivery should proceed through bounded slices with visible acceptance evidence.** Do not ask Claude to rebuild the entire CMS in one prompt.

| Slice | Deliverable | Exit evidence |
| --- | --- | --- |
| 0A: urgent integrity | Unambiguous CMS operation/auth; fail-closed published resolution; guarded tenant source/auth fallbacks | Negative route tests; release outage tests; two-tenant source fixtures; preserved existing behavior |
| 0B: publication contract | Candidate identity/hash, coherent snapshot boundary, revision requirements, asset/redirect protection plan and implementation slices | Concurrent-edit review proof; failed reads cannot produce apparently valid partial releases |
| 1: resource selection | Shared paginated reference APIs and product/collection/variant/link controls; staged legacy migration | More than 30 results reachable; variants beyond 50 reachable; rename/delete/isolation/keyboard demonstrations |
| 2: composition foundation | Versioned component registry, durable IDs, templates/default assignments, shared renderer, compatibility reader | Existing tenants render equivalent content; duplicated sections remain independent |
| 3: complete visual workflow | Editor shell plus a full home and PDP path, then collection path | Edit → preview → review candidate → publish → rollback with distinct template variants |
| 4: design and page coverage | Broader section library, global sections, all agreed families, richer tokens | Two clearly different D2C tenant designs built entirely in the editor; route/SEO/commerce parity |
| 5: editorial/operational scale | Optional approvals, revision restore, changesets, dependency management, asset scale, measured performance | Access separation, retained-release restore, scheduler failure handling, catalog-scale measurements |

Basic permission separation and asset safety belong early; advanced editorial conveniences can arrive later. Picker UI work can proceed alongside release design after shared contracts and isolation prerequisites are agreed. Avoid multiplying templates before the complete authoring-to-publication path works for representative families.

**Migration should be additive and reversible.** Inventory tenant content and take authorized backups before actual migration. Add versioned schemas through new migrations; keep readers compatible with current blocks/pages. Map legacy section kinds and handle references, preserving disabled sections, ordering and content. Materialize explicit template assignments and initial published state where appropriate. Compare legacy/new rendering, canonical URLs, metadata and purchase behavior in staging. Enable one canary tenant, inspect and roll back if needed, then expand. Do not rewrite historical releases in place or edit applied migration files.

**Acceptance must describe merchant outcomes.** A deliverable is complete when a nontechnical marketer can select real products, create a campaign, choose a template, change mobile layout, preview a real PDP, and publish exactly the reviewed result. A different tenant must be able to create a visibly different storefront without a code branch.

The verification set should cover overlapping handles and IDs in two tenants; catalog rename/deletion; selected-item pagination; all variant pages; duplicate section kinds; empty catalog with non-catalog brand content still visible; stale revisions; disabled content editing; unreadable release storage; candidate changed after review; missing media derivative; scheduled release using retained assets; rollback after template upgrade; route redirects; keyboard/focus and responsive layouts; and existing add-to-cart, availability, totals, consent and account authorization behavior.

Measure picker latency/query count and editor/render payloads against an agreed realistic catalog and page size. Set performance budgets after that fixture is chosen; none were benchmarked in this audit. Require browser demonstrations for preview/live parity and rendered accessibility. Passing data-model tests alone is insufficient.

**External patterns support this direction without requiring a vendor migration.** Shopify's resource picker documents product, variant and collection selection with resource IDs and metadata; its JSON templates separate stored composition from rendered sections. Those are useful interaction and modeling references. Storeasy's standalone merchant console should implement an appropriate native selector; Shopify's embedded App Bridge picker is not assumed to be a drop-in dependency. Sources: [Resource Picker API](https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/resource-picker-api), [JSON templates](https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates).

Sanity's visual-editing model illustrates live preview, click-to-edit and section reordering; its perspectives distinguish published, draft and release-specific views. The relevant lesson for Storeasy is to make editing context and publication state explicit while reusing the storefront renderer. This is an architectural comparison, not a recommendation to replace Storeasy's backend with Sanity. Sources: [Visual editing](https://www.sanity.io/docs/visual-editing/introduction-to-visual-editing), [Perspectives](https://www.sanity.io/docs/content-lake/perspectives). References checked 29 October 2026.

The next implementation direction is captured in [the Claude brief](</Users/snehal/Documents/Projects 2026/storeasy26/docs/CMS_CLAUDE_DIRECTION_BRIEF.md>). Product decisions now established are the structured visual builder, D2C-first audience, preservation of the existing stack, stable resource references, reusable tenant templates and a single coherent presentation publication model. The remaining design work is to agree the first template compositions and the initial component/settings catalog before Claude expands implementation.
