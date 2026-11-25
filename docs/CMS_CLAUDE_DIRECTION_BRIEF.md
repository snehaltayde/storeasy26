**Storeasy CMS: direction brief for Claude**

29 October 2026 · Based on source audit at `d9b6637`

This is a proposed implementation direction for the user to give Claude. It has not been executed. Codex's role is architecture, product direction, acceptance criteria and review; Claude's role is implementation once the user assigns a slice.

Read the [audit](</Users/snehal/Documents/Projects 2026/storeasy26/docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md>) alongside the existing repository guidance. Verify the current branch before relying on line numbers or recorded findings. Do not infer current completion from historical session notes.

**The agreed product is a visual section builder for D2C merchants and marketing teams.** Tenants should select real catalog entities, choose and customize reusable templates, control their visual design, preview the actual storefront, and publish reviewed changes without touching application code.

Preserve Next.js, JavaScript ESM, React, pnpm, libSQL/Turso, Kysely, existing tenant context, console primitives, catalog projection and commerce services. Build on existing revision and release mechanisms. No framework rewrite, second catalog identity system, parallel CMS service or external CMS migration is requested.

**The success scenario is concrete.** A beauty merchant chooses an editorial PDP template, selects a real serum as preview context, changes gallery placement and typography, inserts an ingredients block and a collection-linked product rail, adjusts mobile spacing, previews the result, and publishes the exact reviewed candidate. A nutrition merchant uses a different template and design on the same codebase. Product handle changes preserve references. New prices and inventory remain live commerce facts. Rollback restores the prior presentation without restoring old stock or prices.

**The product contracts to implement across slices are these:**

1. A shared selector infrastructure supports products, variants, collections, pages, typed links and media. Use resource IDs, search, bounded pagination, selected-ID hydration, real thumbnails/status and accessible selection. Product selection and variant selection are separate contracts.
2. A versioned component registry declares settings, defaults, allowed page families/children, data bindings, rendering and migration. The editor and server validate the same contract. Component instances have persistent IDs.
3. Themes define the visual system; templates define reusable composition; assignments select a template; content instances supply page-specific values. Avoid flattening these into independent hardcoded forms.
4. Start template selection with explicit entity assignment and family defaults. Later rules follow explicit assignment → ranked rule → family default → theme default. Reject ambiguous matches.
5. Brand/template/section settings support useful no-code typography, colors, widths, spacing, layout, imagery and responsive choices. Approved values and component contracts protect functional and accessible output.
6. Preview and shoppers use the same storefront renderers. Editor code is not shipped with public pages. Unsaved editor preview, saved draft and published release are distinct states.
7. A release candidate freezes presentation, template/assignment versions, redirects and retained asset dependencies. Review/approval/publish refer to that candidate ID/hash. Actual commerce values remain live.
8. Mutation permissions, revision checks and tenant ownership are enforced on the server. Optional approvals become real gates when enabled. A support/read-only capability can never select a mutation path.
9. Existing content remains readable during migration. Preserve hidden content, ordering, public URLs, required purchase components, metadata, consent and account/order access checks.

**The initial component portfolio should stay small enough to finish.** Begin with global header/footer/announcement, hero, rich text, image-with-text, collection grid, product rail/grid, promotion banner, FAQ and required PDP gallery/purchase/information modules. Extend those foundations into classic split, editorial and specification-oriented PDP designs; product-led, editorial and campaign-led home designs; and compact, editorial and sidebar collection designs. Approve actual compositions/settings before building numerous variants.

Reviews/testimonials, video, comparison tables and richer marketing sections can follow once their content, provider and accessibility behavior is defined. Do not invent merchant reviews, certifications, promotional claims or provider integrations as default content.

**These existing implementation details need attention before expansion:**

- `app/api/admin/storefront/route.js` can select read permission using `getPage` and then process a different mutation key. Parse one operation before permission selection.
- `lib/releases.js` maps live-release failures to null; `lib/content/resolve.js` maps null to drafts. Distinguish first-publish state from read/corruption errors.
- The Storefront API source in `lib/shopify.js` reads environment credentials while catalog writes use current tenant context. Do not let a tenant source borrow another shop's environment configuration.
- Membership/operator existence checks treat query failure as absence, which can reactivate bootstrap authentication under specific conditions. Fail closed on lookup errors.
- Product modules, badges and collection pins go live on save, outside the main release. Unify presentation state before promising complete preview or rollback.
- Home sections share data by kind rather than instance. Duplicate sections must remain independent.
- Catalog browser returns at most 30 products without pagination; variant sync is truncated. Do not disguise these limits with a new selector UI.
- Asset usage does not protect all derivatives, scheduled releases and retained historical releases. An immutable release needs available dependencies.
- Current generic pages mostly use `/policies/:slug`. A future `/pages/:slug` route requires deliberate compatibility and redirects.

Read the audit for conditions and evidence. These are not instructions to fix all defects in one change set.

**Use this delivery queue; split each item further when its review cannot remain focused.**

| Work item | Scope | Acceptance gate |
| --- | --- | --- |
| A1 | CMS operation parsing and permission regression | Mixed payloads cannot mutate; read-only actors and support grants remain read-only; valid clients work |
| A2 | Published-content failure behavior and initial-release contract | Anonymous shoppers never receive drafts because a release is unavailable/corrupt; preview remains isolated |
| A3 | Catalog/auth tenant fallback hardening | Missing source credentials and lookup failures fail closed; unrelated-tenant fixtures prove isolation |
| B1 | Resource reference and catalog selection read model | Paginated products/collections/variants, selected-ID hydration, complete variants, no unbounded/N+1 query pattern |
| B2 | Reusable pickers in current forms | Replace handles in home curation, catalog pins and upsells first; then links and variant-driven surfaces |
| C1 | Coherent release candidate and revision boundary | Reviewed candidate is exactly what publishes; failed or concurrent reads cannot silently make partial content |
| C2 | Presentation/asset/redirect dependency coverage | Save, preview, schedule and rollback agree across all covered presentation settings |
| D1 | Component/template runtime and compatibility migration | Durable IDs, schema versions, same renderer, legacy equivalence; no hidden content loss |
| D2 | Visual editor and representative template families | Complete home/PDP/collection editing and publication workflows with distinct layouts |
| E | Remaining page families, design library and reusable sections | Page coverage matrix satisfied; shared versus detached edits show their effect |
| F | Advanced editorial and measured scale work | Revision restore, optional approval, changesets, asset scaling and performance evidence |

Basic author/publisher separation should arrive with C, not be postponed behind advanced collaboration. B and C design can proceed concurrently after shared contracts are agreed; their implementations should remain independently reviewable. No calendar commitment is implied by this queue.

**The first prompt to send Claude can be narrowly scoped as follows.** This is the proposed first coding task, ready for the user to assign; the remaining CMS roadmap is context.

> We are evolving Storeasy into a visual, template-based CMS for D2C merchants. For this task implement only work item A1: fix operation parsing and authorization in the existing storefront CMS API.
>
> First read applicable repository instructions, `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md`, this brief, `app/api/admin/storefront/route.js`, `lib/admin-auth.js`, `lib/platform/authz.js`, existing CMS callers, and relevant auth/CMS tests. Inspect current source rather than assuming the audit is still exact.
>
> Verify the suspected mismatch: a truthy `getPage` chooses `storefront.read`, while an accompanying block/page/delete key can execute a mutation earlier in the handler. If confirmed, parse and validate exactly one supported operation before authorization. Reject mixed or malformed operations with a stable client error. Derive authorization from the parsed operation, preserve write-origin checks, and dispatch only that operation. Keep current valid editor request shapes compatible unless a demonstrated reason requires a coordinated caller change.
>
> Add meaningful route-level regressions for a read-only/support actor attempting mixed read/write payloads, ambiguous operations, unauthorized mutation, valid reads, valid writes and write-origin rejection. Tests must exercise request dispatch and prove denied requests leave storage unchanged; inspecting source strings alone is insufficient. Use isolated test fixtures, not configured merchant databases. Preserve existing revision/conflict behavior.
>
> Run the relevant existing CMS/auth suites and the new regressions. Report exact commands and results, files changed, behavior before/after, compatibility impact and remaining concerns. Update only the applicable completion record with evidence. Do not implement the visual builder, migrate real tenant data, change payment behavior, publish content or deploy in this task.

**The second visible feature task is the picker, with a specification before implementation.** Give Claude B1 after the relevant source-isolation findings are addressed. Request the API/ref schema and migration mapping first, then implementation in the same agreed slice. Define resource type, cursor, query limits, allowed filters, selected-ID hydration, error shapes, freshness and availability semantics. Tenant scope must derive from the trusted host/session context. Ensure the model can represent missing references without deleting them.

For B2, start with a product selector in upsells and a collection selector in homepage curation; use the same infrastructure for collection pinning. Retain stable IDs through save, reload and ordered selection. Demonstrate a catalog larger than 30 products and a product with more than 50 variants. Handle rename, deletion, missing sync and failed search explicitly. Migrate handle-driven input at the persistence boundary, not just by showing names in a dropdown that still saves handles.

Offers and bundles need an explicit variant selector where the action affects a purchasable item. Do not silently choose the first variant or change offer semantics while improving its form. Link picking should resolve current entity URLs; external URLs remain a separately validated choice. Human-authored page slugs remain URL settings.

**Each Claude slice should return a review packet.** Include the selected work item and acceptance criteria; source findings; changed files; schema/migration and compatibility details; exact verification results; screenshots or a short demonstration of user-visible flows where appropriate; unresolved external/runtime conditions; and the next bounded item. Separate implemented, locally tested, browser verified, staging verified and production enabled. A helper function or green unit suite alone does not establish a completed authoring journey.

Codex will review behavior against the agreed product contract, inspect the diff and test evidence, identify regressions or missing cases, and prepare the next direction. Product questions that change scope belong with the user; routine implementation choices stay with Claude within the assigned work item. No messages have been sent to another coding service by preparing this brief.
