# P4 · PROVISION · New stores start on the new editor

Branch `cms/p4-provision`, cut from `dbce19a` (`cms/phase-1` after phase 4 batch 4). Requirements: MIG-03, PUB-06, GEN-02, TOK-03, ED-05. Migrations owned: none. Plan: `docs/cms-reviews/P4-PLAN.md` (decision 16, section 2 "MIG-03 provisioning", section 5) and `P4-BATCHES.json`. Owner answer: OQ-4.

No real or hosted store changed mode and none was provisioned. Every store in the tests is a file database with a file control plane. Nothing was written to Shopify. No dev server, sqld or proxy was started (ports 6120 and 7120 to 7129 were not used). One early run of the new tests did call the `turso` command line: a resume of an adopted run that had failed at its first step lost the database address and tried to create a database. `turso` was not logged in, so it refused and nothing was created. The test now passes the address back, and `provision.js` refuses that case in plain words (see Design (1)).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed (208 s; after fix round 1, 168 s, `test-provision` 30 of 30). `pnpm build` passes. Its 3 warnings are file-tracing warnings through `lib/platform/migrate.js`, which this item does not touch |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a unit test that fails without the change (table below). No desktop Chrome drill was run on the design harness (owner check below) |
| Staging | **NOT DONE.** Nothing ran against hosted Turso (owner check below) |

## What and why

The owner chose (OQ-4) that new stores start on the new editor (documents mode) from phase 4. Before this item, every new store started on the old editor and could only move through the cutover. Now provisioning puts a fresh, empty store on the new editor. The store stays closed ("Opening soon", PUB-06, already built) until the founder's first publish. A database that already holds content keeps the old editor and the run says why, because only the owner's cutover may move a store that has content. The onboarding checklist now works for such a store. Every step links to a working screen, and Launch is read from the live state, so the checklist never calls an open store "not launched".

## Design

### (1) The `content_mode` step (`lib/platform/provision.js`)

- The steps are now `create_db → apply_schema → content_mode → seed_defaults → register_tenant → init_billing → record_onboarding`.
- `content_mode` opens the tenant database the way `apply_schema` does and calls `applyContentMode(client, { contentMode })`:
  - It reads `cms_state` first. If the store is already `documents`, it records `documents` ("This store already uses the new editor.") and writes nothing. That makes a resume after the change landed (but before the step was recorded) idempotent. `migrating` is left as it is. A missing row keeps legacy, with its own reason.
  - With `contentMode: 'legacy'` (the operator's escape) it records `legacy` with "The operator asked for the old editor, so this store starts on it."
  - Otherwise it runs **one** guarded statement (`DOCUMENTS_FOR_FRESH_STORE_SQL`): `UPDATE cms_state SET mode = 'documents', updated_at = ? WHERE id = 1 AND mode = 'legacy' AND (SELECT live_release_id FROM release_state WHERE id = 1) IS NULL AND NOT EXISTS (SELECT 1 FROM <t>)` for every table in `CONTENT_TABLES`.
  - If it changed the row, it records `documents` ("A new store starts on the new editor. It stays private until its first publish."). If not, it re-reads the row and records `legacy` with "This database already holds store content, so it keeps the old editor. Move it with the cutover."
- `CONTENT_TABLES` was checked against `migrations/tenant` up to 0025. It holds the brief's list (`releases`, `documents`, `cms_blocks`, `cms_pages`, `cms_templates`, `placements`, `product_overrides`, `collection_overrides`, `page_redirects`) plus every other table that holds content or a trace of content work: `publish_log`, `document_versions`, `document_refs`, `product_content_live`, `collection_content_live`, `cms_history`, `cms_approvals`, `cms_preview_candidates`, `cms_migration_runs` and `content_live_reversed`. A test reads the migrations and fails when a new content-looking table is missing from the list. The catalog (products, collections), offers, bundles, quizzes and orders are not store content. But since fix round 1 a database the run did not create that holds products, collections, customers or orders keeps the old editor (see the fix round 1 section below).
- The step has no compensation. The database is left in place, as today.
- `params.contentMode` is `'documents'` (the default) or `'legacy'`. Any other value is refused before a run starts. It is recorded in the run's settings (`params.contentMode`), and the outcome is recorded in `refs.contentMode` and `refs.contentModeReason`.
- **Runs started before this step existed.** A resume adds the missing step in order. Because the stored settings of such a run have no `contentMode`, the step keeps the old editor: "This store's setup started before new stores began on the new editor, so it keeps the old editor. Move it with the cutover." An in-flight provisioning at deploy time is therefore never moved by the new code.
- **An adopted run resumed without its address.** The stored settings are redacted and never hold the database address. Before, resuming an adopted run that failed at `create_db` would have created a new Turso database `storeasy-t-<slug>`. `create_db` now refuses it: "This run uses an existing database. Resume it with that database's address."
- `applyTenantSchema` is unchanged. The env store (`_default`), `scripts/migrate.js` and every suite that calls it stay legacy.
- `editorSummary(refs)` gives the plain line on which editor the store starts on.
- `provisionTenant` takes `contentMode` (default `'documents'`). The `/platform` "New tenant" route calls it without one, so new stores made there start on the new editor too.

### (2) What a new documents store holds at creation

Nothing beyond the schema, by design. It has no documents (GEN-01 is not in phase 4: the editor makes the home page and the other singletons when they are opened, and the first publish builds from `emptyList`). It has no release, no legacy rows and no `theme_pin` (`themePinOf` reads no pin as never published; the first `doc_design` publish writes it through after-commit). The store is closed until its first publish (PUB-06).

### (3) `scripts/provision-tenant.js`

`--legacy-content` passes `contentMode: 'legacy'`. The closing summary prints `editorSummary`. For a new-editor store it reads: 'Editor: the new editor. The store stays private (shoppers see "Opening soon") until its first publish from the editor. Publishing opens it.' For an old-editor store it gives the reason. The usage line names the flag.

### (4) Onboarding on a documents store (`lib/admin/onboarding.js`)

- **Design:** links to the editor's `doc_design`. The step is done when the live design has a look or a brand, so after a `doc_design` publish. A design that can't be read now still links to the editor on a documents store (before, the fallback was `/admin/theme`). The documents hint reads "Pick a look and your accent colour in the editor's Design, then publish it."
- **Legal pages:** links to the editor's pages list (ED05). The step is done only when published page documents (family `page`) for privacy and for terms, refund or returns exist. A closed store has none.
- **Review your draft preview:** opens the editor, as ED05 set.
- **Place a test order:** on a closed documents store it links to the editor and says: "Your store is private, so place it from the editor's preview: add a product to the cart and pay cash on delivery. Cancel it after." The closed store's checkout accepts only a founder's preview session (PUB-06). Once the store is open, the link is `/checkout` again with today's hint.
- **Launch (documents only):** the first publish is the launch, so the step is read from the live state (`release_state.live_release_id`), with `kind: 'auto'`, never gated, and linking to the editor's Publish.
  - Before the first publish the hint reads 'Your store is private until your first publish: shoppers see "Opening soon". Publishing from the editor opens it.' While other steps are open it adds ", so finish the steps above first".
  - After the first publish the step is done ("Your store is open to shoppers. …"). `launched` is true and `launchedAt` is the first release's time, so the dashboard and the sidebar badge stop saying "not launched".
  - `markManualStep('launch')` on a documents store is refused in plain words, so a check-off can never call a closed store launched. The other check-offs work as before.
- **Catalog (GEN-02):** unchanged. It reads products and the sync's own record in every mode. Only `migrating` parks a sync.
- **A legacy store's checklist is unchanged:** every label, kind, link, hint and gate, the answer keys, and the manual Launch with its server gate.
- The ED05 source checks in `test-legacy-routes` (`documents ? PAGES_LIST_HREF : "/admin/storefront"`, `documents ? EDITOR_PATH : "/admin/storefront"`, `documents ? documentsPages() : listContentPages()`) still hold.

### (5) `docs/onboarding.md`

New stores start on the new editor and stay private ("Opening soon") until the first publish. A database with content keeps the old editor. `--legacy-content` is the operator's escape. Existing stores move only by the owner's cutover runbook. The hand-off and verify lists now cover a new-editor store: the Setup links, the preview test order, and the brand check after the first publish.

### (6) Fix round 1: a registered or live store is never moved

The review found that `content_mode` runs before `register_tenant`, which is where "tenant already exists" is refused. Its guard only looked at the content tables, so an existing old-editor store with no editor content (but with products, orders and shoppers) was moved to the new editor and closed to shoppers. That happened even when the run then failed with "already exists", and also with `--force`, an adopted `--db-url` pointing at a live store, or the `/platform` form with an existing slug (Turso hands back the existing database, and the form passes no `contentMode`).

Now `content_mode` checks two things before it can move a store:

- **A store already registered under this id, and not by this run** (`getTenant(id)` and not `refs.tenantCreated`) keeps its editor. Reason: "A store with this id is already registered, so it keeps the old editor. Move it with the cutover." This covers the refused re-provision, `--force`, and the `/platform` form with an existing slug. A store already on the new editor still reads "already uses the new editor" and is untouched.
- **A database this run did not create** (`refs.dbCreated` not true: an adopted `--db-url`, or a Turso database that already existed) is moved only if it also holds no row in `STORE_DATA_TABLES` (`products`, `collections`, `customers`, `orders`). This is part of the same one guarded statement (`DOCUMENTS_FOR_UNUSED_DATABASE_SQL`). Reason: "This database already holds products, collections, customers or orders, so it keeps the old editor. Move it with the cutover." A database this run created is empty, so its later catalog sync is not affected.

## Acceptance

| # | Item | Status | Evidence | Fails without the change |
|---|---|---|---|---|
| 1 | Unit (test-provision, file databases): a freshly provisioned tenant has cms_state mode 'documents', no live release, no releases, documents or legacy content rows and no theme_pin; the run records the content_mode step with contentMode 'documents'; a failure injected before every step (failAt) and resumed ends in the same state | **DONE** | `test-provision` "a freshly provisioned tenant is a documents store …": step order, `refs.contentMode`, reason and `params.contentMode`; the store's mode, live pointer and the row count of every `CONTENT_TABLES` table (all 0); the config has no `theme_pin`, `theme` or `brand`, and `themePinOf` is null. "a failure injected before every step …": for each of the 7 steps, fail then resume, and the store, `refs.contentMode`, billing and the absent pin equal the uninterrupted run. Also: "content_mode re-reads cms_state …" (no second write) and "CONTENT_TABLES covers the brief's list and every content table in migrations/tenant" | The step made a no-op (M1): these 3 fail, and every later documents test fails too (11 in all) |
| 2 | Unit: the new tenant is closed before its first publish: isStoreClosed() is true, contentSource() is {mode: 'closed'}, the home getters return neutral empties and the sitemap only '/'; an anonymous POST to /api/checkout is refused and a console-session COD test order is accepted (reusing the existing PUB-06 test helpers) | **DONE** | "the new tenant is closed …": `isStoreClosed()` true, `contentSource().mode === 'closed'` (the orchestrator's ruling), `resolvedHomePage` and `resolvedHomeSections` `[]`, `resolvedHero` null, the announcement off, the page list empty, and the real `app/sitemap.js` gives only `https://fresh.test/`. "on the closed new store an anonymous checkout is refused …": the real `/api/checkout` route (test-commerce's stubs and helpers) answers COD and card with 403 `STORE_CLOSED` and stores no order, even with a console `_admin` cookie. With the founder's preview session (`createPreviewSession`, the console's own way into a closed store) COD is 200, one order to `snehal@mediastic.in`, the Shopify push collected and never run, then the order is marked cancelled and the session revoked | M1: both fail (the store is legacy, so it is open) |
| 3 | Unit: the founder publishes a first home page (open doc_home, save a valid section, publish): the store opens (isStoreClosed() false), resolvedHomePage shows the published section from a live content.v 4 release, and a later doc_design publish writes theme_pin (setThemePinWriter spy) | **DONE** | "the founder publishes a first home page …": through the documents API with an owner session: `createDocument {type:'home'}`, `saveDraft` with a text section, then publish. A saved draft keeps the store closed. After the publish `isStoreClosed()` is false, `contentSource()` is `live` with v 4, the live `releases.content` has `v: 4`, and `resolvedHomePage` holds `sec_first` and its title. "a later doc_design publish writes theme_pin …": the spy is called once with `('fresh', {kit: 'glow', release, …})` | M1: both fail (the API refuses documents writes on a legacy store) |
| 4 | Unit: a --force re-provision or an adopted database that already holds content (a releases row or a cms_blocks row) stays legacy with the plain reason recorded; contentMode 'legacy' keeps a fresh tenant legacy; an existing legacy tenant is untouched by provisioning another; applyTenantSchema alone still leaves cms_state 'legacy' (test-tenancy: _default and the env store stay legacy) | **DONE** | `test-provision`: adopted databases holding a releases row, a cms_blocks row or a documents row stay legacy with the exact reason and an unchanged store. A fresh store with `contentMode: 'legacy'` stays legacy with the operator reason. The founder then saves an old-editor block and a `--force` re-provision (asking for documents) stays legacy with the content reason. An unknown `contentMode` is refused and registers nothing. A run from before the step keeps legacy. acme (legacy) has the same mode, `cms_state` row and counts after every other provision in the suite. A `--force` re-provision of the published documents store keeps documents and its live release. `test-tenancy` "P4-PROVISION: applyTenantSchema alone leaves cms_state 'legacy' …": a schema-only database, the env store (`_default`, outside any tenant), t1, t2 and a tenant on the schema-only database all read `legacy` | The content guard removed (M2): the adopted and the `--force` tests fail. The earlier-run rule removed (M8): its test fails. A flip added to `applyTenantSchema` (M10): the test-tenancy test fails |
| 5 | Unit: on the new documents tenant the onboarding checklist builds and every step's href is an editor or working console destination (never /admin/theme, /admin/catalog, /admin/home, /admin/upsells or a bare /admin/storefront); the design step completes after a doc_design publish; the legal-pages step completes only after privacy and terms page documents are published; the launch hint says the store is private until the first publish and the step reads done after it; a legacy tenant's checklist output is unchanged | **DONE** | "a closed documents store builds the onboarding checklist with editor links …": all 9 hrefs pinned. Each one is checked against the forbidden list and against a real page file (`editor/page.js`, `integrations`, `settings`, `billing`). The design and legal steps are not done; the test order goes through the preview; Launch is `auto`, not gated, not done, with the private hint; `launched` is false; a Launch check-off is refused while the preview check-off still works. "a later doc_design publish …": the design step is done with the editor link. "the legal-pages step counts only published PAGE documents …": two published campaigns (`privacy-week`, `terms-and-returns-week`) and a journal post don't count; a draft privacy page doesn't; privacy alone doesn't; privacy and terms do. "the founder publishes a first home page …": Launch is done with the open hint, `launched` is true, `launchedAt` is set, and the test order goes back to `/checkout`. "a legacy tenant's checklist output is unchanged …": every label, kind, href, hint and gate, plus the answer keys | Launch block disabled (M4): 2 fail. Test-order link put back (M6): 1 fails. Launch check-off allowed (M11): 1 fails. Family filter removed (M3): the legal-pages test fails |
| 6 | Unit: legacy brand and theme writes on the new tenant answer 409 with the documents message, and saving doc_design through the documents API works | **DONE, with one note** | "legacy brand and old-editor writes on the new tenant answer 409 …": brand save and reset are 409 `STORE_USES_DOCUMENTS`; the words start with `DOCUMENTS_MESSAGE` and `editor` is `/admin/editor?doc=doc_design`. The old storefront save (`PUT /api/admin/storefront`) is 409 `STORE_USES_DOCUMENTS` ("…new editor…") and writes no block. `saveDraft doc_design` through `handleDocumentsPut` is 200 and the store stays closed. **Note:** on a documents store the theme screen's apply is not a legacy write. Since P3-DESIGN (TOK-03) it saves the kit into the `doc_design` **draft**, so it answers 200, not 409. The test pins that it changes only the draft: the control-plane config is unchanged and no old block is written | M1: fails (a legacy store accepts the brand save) |
| 7 | unit: onboarding's page-family filter and closed-store editor links are pinned | **DONE** | The two "(ED05 review, pinned)" tests above | Family filter removed (M3): the legal-pages test fails (26 passed, 1 failed). The closed-store links: M4, M6 and M11 each fail it |

Fix round 1 (blocker: `content_mode` could move a live store): 3 new tests in `test-provision`, all failing on `b5812cf` (26 passed, 4 failed with only the two new reason words added) and passing with the fix (30 of 30):

- "(fix 1): re-provisioning an existing legacy store with no editor content, with the default contentMode and no force, is refused …": the run fails at `register_tenant` with the same words, `refs.contentMode` is `legacy` with the "already registered" reason, and `cms_state` (mode and `updated_at`), every content count and `getCmsMode` are as before. On `b5812cf` the store became `documents`.
- "(fix 1): a --force re-provision of an existing legacy store … with live orders and products, default contentMode …": done, legacy, `cms_state` and the order untouched.
- "(fix 1): an adopted database (a new id) with no editor content that already holds orders or products keeps the old editor …": one database with an order, one with a product; both stay legacy with the exact store-data reason.

Two existing tests changed their expectations: the `--force` re-provision of the "keep" store now records the "already registered" reason (it still stays legacy, untouched), and the acme check reads acme's completed run (the later refused re-provision now records "already registered").

Mutation runs (each restored after): M1 left 16 passed, 11 failed; M2 25/2; M3 26/1; M4 25/2; M6 26/1; M8 26/1; M11 26/1; M10 (test-tenancy) 9/1. The adopted-resume guard was **not** mutation-tested, because its mutant would call the `turso` command line. Its test only checks the refusal words and that nothing was registered.

## Tests

- `scripts/test-provision.js`:
  - New hooks at the top, as in `test-commerce`: the `@/` alias; `next/server` with `after()` collected; and `next/headers` answering for one simulated request (host and cookies).
  - The BE26 and MC02 tenants (acme, beta) now pass `contentMode: 'legacy'`, so their old-editor checklist is tested as before.
  - 18 new tests in the "P4-PROVISION" section. They cover provisioning, failAt and resume, the re-read, the adopted and forced cases, earlier runs, the closed store, checkout, onboarding, the brand and old writes, the first publish, the theme pin, the legal pages, the forced documents store and the legacy snapshot.
- `scripts/test-tenancy.js`: 1 new test (`applyTenantSchema`, the env store and schema-built tenants stay legacy).
- No new suite or `package.json` entry.

## Known limits

- **The theme screen on a documents store is not a 409** (acceptance 6 note). Its apply saves the design draft by P3-DESIGN's design. Only brand save and reset and the old storefront writes answer 409.
- **The test order on a closed store needs the founder's preview session, not just the console login.** PUB-06 refuses console cookies on purpose. So the checklist step links to the editor, whose preview pane carries the session. Whether the preview pane lets the founder reach the cart and checkout comfortably is a browser check (owner check).
- **Launch on a documents store has no "Launch" button.** It is an `auto` step with an "Open" link to Publish (SetupAdmin shows "Auto" for it). `manual.launch` is ignored on documents stores, and the check-off API refuses it there. A product-only publish makes no release, so it does not open a closed store, and Launch stays open until a page, home or chrome publish.
- **`/platform` "New tenant" has no old-editor option.** Only the CLI has `--legacy-content`. Adding a toggle needs `app/api/platform/tenants/route.js` and `components/platform/*`, which are outside this item.
- **The resume token for a hosted database** (pre-existing for `apply_schema`): the database token lives only in step memory. If a run that created a hosted database stops after `create_db`, `apply_schema` and `content_mode` open it on resume without a token, and the resume fails until the operator resumes with a token. Builders could not test this (no hosted databases).
- **An adopted run that failed at `create_db`** must be resumed with its database address. It is now refused in plain words instead of creating a new Turso database.
- **`CONTENT_TABLES` must grow with new content tables.** The test fails when a migration adds a table named like a content table that is not in the list. A content table with an unusual name would not be caught.
- **An adopted database of another store with no products, collections, customers, orders or editor content** (fix round 1) can still be moved to the new editor under a new id. Such a database runs no store a shopper could reach (it has nothing to sell), and the move is reported in the run.
- **`STORE_DATA_TABLES` is a fixed list** (products, collections, customers, orders). Carts, events and offers alone do not count as a live store.
- **`launchedAt` on a documents store** is the first release's time (`min(releases.created_at)`).
- Build warnings: 3 file-tracing warnings through `lib/platform/migrate.js` (via `/api/platform/*`). That file is unchanged here. `provision.js` already imported it dynamically before this item.

From review:

- Earlier blocker is FIXED at c876789. content_mode now reads getTenant(id). A store already registered under this id, and not registered by this run, keeps its editor with the plain 'already registered' reason. This covers the refused re-provision, --force, and the /platform form with an existing slug. A database this run did not create (an adopted --db-url, or a Turso 409 / existing-name database) moves only if it also has no rows in products, collections, customers or orders. That check is part of the same single guarded UPDATE. getTenant returns tenants of any status, so suspended tenants are covered too. The three new fix-1 tests use the default contentMode, and test (a) checks that the refused run leaves cms_state unchanged, including updated_at.
- Mutations I ran: setting `registered = false` makes 3 tests fail, including both fix-1 re-provision tests. Setting `requireNoStoreData: false` fails the adopted-database-with-orders/products test. test-provision passes 30 of 30. Full pnpm test passes 96 of 96 suites in 179.5s.
- Remaining gap, already listed in Known limits: an adopted --db-url that points at another registered tenant's database can still be moved to documents mode under a new id, as long as that database has no catalog, customers, orders or editor content. That would close the other tenant's (empty) storefront. A cheap extra guard: refuse the move when listTenants() already has a tenant with the same db_url. This is a suggestion, not a blocker, since such a store has nothing to sell.
- Old issue outside this item: createDbViaCli uses `existing.includes(name)` on the `turso db list` output, so the name 'storeasy-t-shop' matches inside 'storeasy-t-shop2'. Provisioning 'shop' while 'shop2' exists would set created=false and skip create, so `db show` fails. With fix 1 this case now fails safe (requireNoStoreData is on), but the substring match is still wrong.
- Edge runtime: the fix only touches lib/platform/provision.js, which is server-only and already used node: APIs. lib/admin/onboarding.js is unchanged by the fix and has no node: imports. Worktree rv1 is removed and no sqld or server processes are left running.

## From review

- **Fixed (round 1, blocker):** `content_mode` ran before the "already exists" check and only looked at content tables, so a failed or forced re-provision (or an adopted live database, or the `/platform` form with an existing slug) moved a live old-editor store to the new editor and closed it to shoppers. See Design (6) and the fix round 1 tests.

Folded in from the batch 4 review (P4-ED05): onboarding's family filter `(p.family || 'page') === 'page'` is pinned by a test that fails when it is removed, and a closed documents store builds the checklist with editor links (acceptance 7).

## Owner checks

- **Before deploy:** 0024 and 0025 applied everywhere (plan section 5). Check that no provisioning run is half-done on the hosted control plane (`/platform` → provisioning runs). A resumed earlier run keeps the old editor, as designed.
- **Staging, after deploy (plan section 5):** provision one throwaway tenant (no `--legacy-content`). The CLI summary says "the new editor … private"; its domain shows "Opening soon" and the sitemap only `/`; the Setup page's links all open working screens (Design, Pages, the editor, Publish); a COD test order from the editor's preview goes through to `snehal@mediastic.in` and is cancelled after; the first publish opens the store and Setup shows Launch done. Then offboard the throwaway tenant.
- **Desktop Chrome on the design harness (P4-DRILLS):** the Setup page of a new documents store before and after its first publish, and the preview test order.
- **Decide** whether `/platform` "New tenant" needs a "start on the old editor" choice (today only the CLI has it).
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum. Nothing under `.github/` was changed.

## Files

`lib/platform/provision.js`, `scripts/provision-tenant.js`, `lib/admin/onboarding.js`, `scripts/test-provision.js`, `scripts/test-tenancy.js`, `docs/onboarding.md`, this packet.

## Commands

```
pnpm test:provision && pnpm test:tenancy
pnpm test
pnpm build
```
