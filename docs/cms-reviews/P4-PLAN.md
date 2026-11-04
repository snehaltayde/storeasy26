# Phase 4 build plan (revised): product content and moving tenants

**Base:** `cms/phase-1` at `552e6f3`. Phases 1 to 3 are done.

**Scope:** P0s only.
- OVL-01, OVL-02, OVL-03, OVL-04, OVL-05, OVL-06 (closing its loose ends) and OVL-07.
- MED-03.
- MIG-01, MIG-02, MIG-03 and MIG-04.
- ED-05.
- The phase 3 carry-overs: theme_pin at cutover, the 0023 deploy order, finding D2, and the insight and experiment wording.
- Pulled in by the owner's answers (2026-11-04): a minimal OVL-17 (reindex one product's search entry on publish, Undo and reset; OQ-1 (b)) and documents-mode provisioning for new tenants (MIG-03 provisioning; OQ-4).

**Revision note:** this revision answers four critiques. Section 7 says how each mustFix, shouldFix and uncovered point was handled. The full founder and ops critique (R4) has now been read and answered in full (section 7, R4), and the uncovered points of R1 and R2 that the earlier revision left open are answered too.

**Owner answers applied (2026-11-04):** OQ-1 is (b): a minimal OVL-17 goes into P4-SEARCH, and the title gate's Typesense condition is lifted there. OQ-2 and OQ-3 are signed off as accepted deviations (section 2). OQ-4: new tenants start in documents mode, built by the new item P4-PROVISION in batch 5. OQ-01 (spec): the product title is overridable; the URL handle stays tied to Shopify. OQ-5 to OQ-9 had no answer, so their defaults stand (section 6).

## 0. Rules for every item

**Branches:**
- Each item gets its own branch, `cms/p4-<id>`, in its own worktree, and merges with `--no-ff`.
- A batch is cut only after the previous batch has fully merged.
- Batch 0 can start now. **Batch 1 and later start only after P3-FIX5 has merged.**

**The P3-FIX5 footprint (corrected).** P3-FIX5 touches these files (from `docs/cms-reviews/P3-BATCHES.json`):
- `app/api/admin/preview-session/route.js`, `lib/admin/preview-session-api.js`, `lib/preview-sessions.js`.
- `components/admin/editor/editorModel.js`, `PreviewPane.js`, `previewMachine.js`.
- `lib/sanitize.js`, `lib/registry/text.js`, `lib/cms/store.js`, `lib/documents/after-commit.js`.
- `app/api/admin/theme/route.js`, `lib/documents/changes.js`, `lib/documents/service.js`, `lib/admin/documents-api-shapes.js`.
- Tests and drills: `scripts/test-logout-preview.js`, `test-editor-shell.js`, `test-rich-text.js`, `test-design-doc.js`, `test-doc-changes.js`, `test-api-shapes.js`, `scripts/drills/p3/{matrix,rte,lib}.mjs`, `scripts/drills/p2/run.mjs`.

Which of these phase 4 may touch:
- **Never edited:** `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js` and `scripts/drills/p3/*`. Phase 4 only imports them.
- **Edited after the merge, by a named owner who rebases first:**
  - `lib/cms/store.js`: GUARD.
  - `lib/documents/service.js`: MEDIA, then LIVEROW.
  - `lib/documents/changes.js`, `lib/admin/documents-api-shapes.js` and `scripts/test-api-shapes.js`: LIVEROW, then SEARCH.
  - `editorModel.js` and `test-editor-shell.js`: EDITOR.

**Safety:**
- No existing real or hosted tenant changes mode in phase 4 except by the owner's cutover. New tenants provisioned after P4-PROVISION deploys start in documents mode (OQ-4); builders provision only file-database tenants in tests.
- Builders run every CLI only against file databases (`scripts/support/tenant-fixture.js`) and the harness's local sqld.
- Every CLI refuses other URLs unless given `--hosted --confirm <tenantId>`. Cutover and reversal also need `--backup-ref`, a matching dry-run digest and a passing rehearsal report. Builders never pass `--hosted`.
- Every hosted step is an owner command in `docs/cms-reviews/P4-CUTOVER-RUNBOOK.md`.
- Legacy tenants keep today's behaviour until each one is cut over.

**Other rules:**
- Never write to Shopify. Add no npm dependencies.
- Messages the founder sees use plain words.
- Each item writes the packet `docs/cms-reviews/P4-<ID>.md`, with Known limits, From review and Owner checks.
- Only P4-DRILLS edits `MANUAL-CHECKS.md`.
- `package.json` is edited only by SCAFFOLD. SCAFFOLD registers all 15 new suites as placeholders, plus the operator commands `migrate:documents`, `reverse:documents`, `media:reindex` and `drill:p4`.

## 1. Key design decisions

1. **Titles and OVL-06.** OVL-06's core shipped in phase 1 (migration 0018, cart, orders, order page, reports). Phase 4 closes its loose ends, so the title row is not gated on OVL-06 itself:
   - The editor always shows "Shopify title: X" beside the override.
   - A shopper-safe cart projection is applied at **every** client boundary (decision 13).
   - Gift lines freeze the catalog title and SKU too.
   - The SHOP-02 sentinel also covers gift and bundle descriptions.
   - Reports use the effective title.
   - The contrast of the order page's Shopify-title line is fixed.

   **The title gate** (`lib/catalog/title-gate.js`, LIVEROW in batch 2) blocks titles and `display_*` in two cases:
   - **(a) Typesense would still serve the Shopify title.** The test is `typesenseConfigured() && productsCollection()` for the tenant, which includes `_default` through the env collection. By the owner's answer to OQ-1 (option b), a minimal OVL-17 ships in P4-SEARCH (batch 3): publish, Undo and reset reindex the product with effective values (decision 15). Once that reindex ships and its spy tests pass, P4-SEARCH removes condition (a).
   - **(b) Not every console reader shows effective values yet.** The flag `TITLE_READERS_READY` stays false until P4-SEARCH flips it.

   So between batch 2 and batch 3 titles are gated everywhere; from batch 3, renaming works on every tenant, `_default` and Typesense tenants included. The gate refuses at **save** time, and the editor disables those fields with the reason, so a founder never types a title that can't go live. Publish re-checks it as a belt. The gate's shape, its save-time refusal, the belt and a test seam (`setTitleGateForTest`) stay after SEARCH, for any future gate.
2. **Live tables (0024, DDL pinned in SCAFFOLD).**
   - The spec 8.2 tables, plus `pairs_title` and `layout_template`.
   - `cms_migration_runs`: the cutover and reversal lock, and resumable state.
   - `content_live_reversed`: MIG-04's copy-aside, a fixed table instead of `_reversed_<date>`.
   - Any later column need is a new 0026 file with a named owner, never an edit to 0024.
3. **One effective read: `lib/catalog/effective.js`.**
   - It covers title, description and `description_html`, `display_*`, the featured image and its alt, gallery, `seo_*` and `og_image`, plus `logic_tags` and `logic_type`.
   - Selectors: card, product page, cart, `byIds`, search and `indexRows`. `indexRows` is the Typesense builder's source; EFFECTIVE ships it so SEARCH never edits `effective.js`.
   - On "no such table" it falls back to the raw read with the same shape.
   - Entity content (modules, badge, pairs, template, pins) is read only when `src.v === 4`. That covers a live v4 release and a candidate source from the SEAM.
4. **Product and collection content documents.**
   - Ids are deterministic and async (`doc_prod_` and `doc_coll_`).
   - `openEntityContent` reuses phase-3 random-id rows.
   - Each overlay field is stored as `{value, base_hash, base_value}`.
   - Removed or over-limit legacy shapes load verbatim with inherited warnings and are never truncated.
   - Deleting a product never archives its document, because orphan status is computed live.
5. **Every documents-side batch carries an in-batch mode guard.** This covers live-row publish, Undo, `discardOrphanEdits` and `commitPublishBatch`, each guarded with `mode = 'documents'`.
   - Legacy writers carry `mode = 'legacy'`, in the EXISTS form, so a table with no row reads as legacy.
   - `lib/migrate/*` carries `mode = 'migrating'` plus an open run row.
   - After an abort, `classifyAbort` re-reads the mode. That separates a mode refusal from a lost pointer race, whose CHECK text is identical.
6. **MED-03.**
   - References come from the registry plus a regex belt.
   - Every version kind is indexed.
   - Usage on documents tenants joins `document_refs` to `document_versions`, and adds drafts, config and `release:<id>` rows.
   - Migration 0025 adds `archived_at`.
   - Deletes are refused while the tenant is migrating.
7. **Cutover = lock, backfill, data check, flip, theme_pin**, each step recorded and resumable:
   - **Legacy is the source of truth on a legacy tenant.** Backfill upserts documents and the legacy-derived live-row columns from the current legacy source.
   - **Existing documents.** A different existing draft is saved as a "kept" version first. Versions are content-addressed, so `ON CONFLICT(id) DO NOTHING` is exact. Row counts are verified after every chunk. `INSERT OR IGNORE` is never used.
   - **Overlay-only columns** are written only in the flip batch (on re-cutover), so legacy shoppers never see them early.
8. **MIG-02 is a hard gate, before the flip:**
   - **(a) In-process data check inside the real cutover.** It runs after backfill and before the flip. It compares every `resolved*` getter, entity getters included, reading back the backfilled live rows, through the SEAM's `contentGettersFor(candidateSource(...))`.
   - **(b) Rehearsal report.** A passing rehearsal on a local `restore-drill` copy, including the rendered before/after comparison, with a `sourceHash` equal to the tenant's current one. Without it the real command refuses.
   - The spec's `pin_release` preview is replaced by (a) and (b). The owner signed this off (OQ-3); it is an accepted deviation (section 2).
9. **Sync pause.**
   - A new full sync refuses to start while the tenant is migrating.
   - A running sliced sync parks at its next slice.
   - Webhooks continue. They change `products` equally for the legacy and the candidate side, which is an allowed difference pending the owner's OK (OQ-5).
10. **D2: stop offering the banner** on page, campaign and journal documents. Existing banners keep saving with an inherited warning. Rendering them is DOC-06 (P1).
11. **Insight apply and experiment adopt wording:** verified in P3-FIX4 (`lib/ai/insights.js:314`, `lib/experiments.js:357`). MAPPER adds a fixture showing a running hero experiment still serves on a migrated home.
12. **`cms_templates`.**
    - Not mapped, because blueprints are DOC-09 (P1).
    - The dry run counts them.
    - ED05 adds a read-only "saved templates" page with "Make a page from this". The old rows are never edited.
13. **The cart projection.** `shopperCart()` is applied in:
    - `app/api/cart/*`;
    - the storefront layout's `initialCart`;
    - the checkout page prop;
    - `api/checkout` responses.

    `createOrder` keeps the full cart.
14. **Product draft preview has no heartbeat.**
    - With a valid documents preview session, the product and collection pages merge their own draft in the page layer.
    - The list overlay still excludes them.
    - `lib/preview-sessions.js` is not touched and no migration is needed.
15. **Minimal OVL-17 (owner answer OQ-1 (b), P4-SEARCH).**
    - LIVEROW writes one `search_outbox` row per affected product inside every live-row batch (publish, set, Undo, undoSet, `discardOrphanEdits`); CUTOVER and REVERSE write them at flip and reversal. A Reset changes the draft and reaches search with the publish that carries it.
    - SEARCH's `drainSearchOutbox` (new `lib/catalog/search-reindex.js`) reads the effective values with EFFECTIVE's `indexRows({ids})`, upserts only those products, deletes a gone product by its stored handle, marks done only the rows it read, and never drops the collection or leaves the tenant's namespace.
    - Triggers: the fast path in `documents-api.js` after a successful publish-shaped answer (`kickSearchReindex()`: inline with a short cap, plus a durable `search_reindex` job keyed by tenant and the highest pending outbox rowid, because job idempotency keys are unique for all time); the job handler in `lib/platform/worker.js` for retries; every full sync as the backstop.
    - Failures leave rows pending and are logged. They never block or fail a publish, and nothing writes to Shopify. Tests use a spy client, never a real Typesense; drills use the SQL path or a spy with dummy localhost values only.
16. **New tenants start in documents mode (owner answer OQ-4, P4-PROVISION in batch 5).**
    - A new `content_mode` provisioning step sets `cms_state` to `documents` in one guarded statement, only on a fresh database with no release and no legacy or documents rows. An adopted or re-provisioned database that holds content stays legacy, with a plain reason. `applyTenantSchema` is unchanged, so `_default` and the env store stay legacy.
    - No starter documents (GEN-01 is not in phase 4), no release, no legacy rows, no theme_pin at creation. The store is closed (PUB-06, already built) until the founder's first publish.
    - The onboarding checklist works for such a store, with editor destinations, and its Launch step reflects the first publish.
    - Existing tenants still move only by the owner's cutover; the cutover tool refuses a store that is already in documents mode.

## 2. Where the spec is wrong against the code (deviations to record)

- **OVL-06 timing.** Its core shipped in phase 1; phase 4 closes the loose ends.
- **8.2 `product_content_live`** needs `pairs_title` and `layout_template`.
- **8.2 new tables.** `cms_migration_runs` and `content_live_reversed` are added. The latter replaces `_reversed_<date>`.
- **8.2 `preview_sessions`** has no `pin_release` or overlay column. MIG-02 uses the in-process check plus the rehearsal (OQ-3, signed off), and draft preview is per page (decision 14).
- **8.2 `document_refs`.** No `draft:` or `config:` rows; drafts and config are read live. `release:<id>` rows are written at cutover.
- **8.3 product and collection ids.** The code minted random ids; deterministic ids are added and existing rows reused. Named layouts don't exist, so the template is a field.
- **8.3 and ED-12 `collection_content`.** It was never registered; phase 4 adds it.
- **8.9 draft preview "only when open in the editor"** becomes "any valid preview session, per page".
- **8.11 "no release" state.** It is set by an explicit operator flag, never classified automatically.
- **8.11 step 6 (experiments).** Translated at read, not rewritten.
- **8.11 step 8 (live rows).**
  - Legacy-derived columns are written in backfill. The version 1 to 3 readers never read them, and the effective overlay columns stay null.
  - Overlay columns are written only in the flip.
- **MIG-02 allowed differences** live in `lib/migrate/allowed-differences.js`, asserted in `test-migrate-documents` as the spec names it.
- **MIG-03 rollback (accepted deviation, owner sign-off OQ-2, 2026-11-04).** `/api/admin/releases` keeps its 409 for publish, schedule and rollback in documents mode until PUB-08 (P1) ships the whole-store restore. Until then a cut-over founder has per-document Undo and the operator has the reversal tool.
- **MIG-02 preview pin (accepted deviation, owner sign-off OQ-3, 2026-11-04).** The spec's operator-only `pin_release` preview is replaced by the in-process data check inside the real cutover (before the flip) plus a required passing rehearsal on a local `restore-drill` copy with the rendered comparison and a matching `sourceHash` (decision 8).
- **PUB-03 whole-set refusal (deliberate deviation).** PUB-03 says a problem in another document never blocks this one. The title publish belt instead follows today's set rule (`lib/documents/publish.js:417-444`): a product whose title can't go live refuses the whole set, named in plain words with "reset the name or leave this product out". It can only fire for a title saved before a gate turned on, and the same set without that product publishes (LIVEROW (4)).
- **MIG-03 provisioning** now follows the spec: new tenants start in `documents` (owner answer OQ-4, P4-PROVISION). The only difference from the spec's wording is timing: it ships in batch 5, before the first real cutover has been run, by the owner's choice.
- **OVL-17 (P1) partly pulled in** (owner answer OQ-1 (b)): the outbox, the one-product drain, the job and the full-sync backstop (decision 15). Restore (PUB-08) is not built, so "restore writes outbox rows" waits for it.
- **MED-03 "through the registry".** A regex belt is added.
- **MIG-05 `--check`** gains `--include-env`.
- **The OVL-13 gallery host allowlist** (P1) is pulled forward with OVL-01 and MED-03.
- **DOC-09** is partly pulled in: make a page from an old saved template.
- **Section 11 cutover gate**, as enforced by the cutover command's preconditions:
  - DOC-01 to DOC-05 and DOC-07.
  - PUB-01 to PUB-06 and PUB-09.
  - ED-02, ED-03, ED-05 and ED-12 (cart, product content and collection content).
  - TOK-03.
  - OVL-01, OVL-02, OVL-03 and OVL-07, plus OVL-06's ends.
  - MED-03.
  - MIG-01, MIG-02 and MIG-05.
  - DOC-13 is not built, so approval and agency tenants are refused.
- **The spec's evidence line numbers have drifted.**

## 3. Shared-file owners (in order)

- **`package.json`:** SCAFFOLD only.
- **Migrations:** 0024 belongs to SCAFFOLD and 0025 to MEDIA. Any 0026 needs a named owner in a plan update.
- **`lib/admin/editor-entry.js`:** SCAFFOLD (batch 0), then ED05 (batch 4).
- **`lib/content/resolve.js`:** SEAM (batch 1), then OVL07 (batch 3). EFFECTIVE may not touch it.
- **`lib/content/documents-reader.js`:** SEAM (batch 1), LIVEROW (batch 2), then OVL07 (batch 3).
- **`lib/documents/service.js`, `build.js` and `commit.js`:** MEDIA (batch 1), then LIVEROW (batch 2).
- **`lib/registry/settings.js`:** MEDIA (batch 1), then LIVEROW (batch 2).
- **`lib/registry/sections.js` and `lib/documents/checks.js`:** LIVEROW (batch 2), then ED05 (batch 4).
- **`lib/admin/documents-api.js`, `documents-api-shapes.js` and `scripts/test-api-shapes.js`:** LIVEROW (batch 2), then SEARCH (batch 3).
- **`lib/catalog/effective.js`:** EFFECTIVE (batch 2), then OVL07 (batch 3).
- **`lib/catalog/title-gate.js`:** LIVEROW (batch 2), then SEARCH (batch 3, removes the Typesense condition after the reindex ships).
- **`scripts/test-product-content.js`:** LIVEROW (batch 2), then SEARCH (batch 3, rewrites the Typesense title-gate cases only).
- **`lib/catalog/search-reindex.js`** (new) **and `lib/platform/worker.js`:** SEARCH (batch 3). CUTOVER and REVERSE only import `kickSearchReindex()`.
- **`lib/admin/onboarding.js`:** ED05 (batch 4), then PROVISION (batch 5).
- **`lib/platform/provision.js`, `scripts/provision-tenant.js`, `scripts/test-provision.js`, `scripts/test-tenancy.js` and `docs/onboarding.md`:** PROVISION (batch 5). Its tests go in these existing suites, so SCAFFOLD's placeholder list is unchanged.
- **The product page:** EFFECTIVE (batch 2), then OVL07 (batch 3).
- **`lib/cms/placements.js`:** GUARD (batch 1), then EFFECTIVE (batch 2).
- **`lib/sync.js`:** GUARD (batch 1), then SEARCH (batch 3).
- **`scripts/test-releases.js` and `scripts/test-writers.js`:** GUARD only.
- **`lib/migrate/map-entities.js`:** MAPPER's stub (batch 2), then OVL07 (batch 3).
- **`lib/migrate/check.js`:** MAPPER (batch 2), OVL07 (batch 3), then CUTOVER (batch 5).
- **`scripts/migrate-documents.js`:** SCAFFOLD's stub, MAPPER (batch 2), CUTOVER (batch 5), then REVERSE (batch 6, only if the re-cutover report needs a CLI change).
- **`lib/migrate/report.js`** (the plain-words report): MAPPER (batch 2), CUTOVER (batch 5), then REVERSE (batch 6).
- **`lib/admin/shopify-admin-url.js`** (new, the shared `shopifyAdminBase`): LIVEROW (batch 2). EDITOR and ED05 only import it in batch 4.
- **`lib/migrate/backfill.js` and `flip.js`:** CUTOVER (batch 5), then REVERSE (batch 6).
- **`P4-CUTOVER-RUNBOOK.md`:** CUTOVER, REVERSE, then DRILLS (batch 7, wording and missing-step fixes found by the literal runbook drill only).
- **`components/admin/editor/DocumentEditor.js`:** PICKER (batch 3), then EDITOR (batch 4; now in EDITOR's file list).
- **`editorModel.js`, `Switcher.js` and `editor/page.js`:** EDITOR (batch 4).
- **`scripts/test-editor-routes.js`:** SCAFFOLD (batch 0), then ED05 (batch 4).
- **`scripts/drills/p4/run.mjs`:** SCAFFOLD's stub, HARNESS (batch 2), then DRILLS (batch 7).
- **`MANUAL-CHECKS.md`:** DRILLS only.

## 4. URL contract

- `/admin/editor?product=<gid>` opens a product; `?collection=<gid>` opens a collection; `?doc=<id>` opens a document.
- `entityEditorHref` and `parseEditorTarget` (SCAFFOLD) are the only builders and parsers.
- Redirects:
  - `/admin/catalog` goes to the Products list.
  - `/admin/upsells`: pairs go to the product, and the cart slot goes to `doc_cart`.
  - `/admin/storefront/designer/product` goes to `doc_product_layout`, and `.../collection` to `doc_collection_layout`.
  - `/admin/storefront/pages/[slug]` goes to that page's document.
  - `/admin/releases` stays the documents "Recently published" page.

## 5. Owner steps (never run by builders)

- **Migrations:** apply 0023, 0024 and 0025 with `pnpm tenant:migrate -- --all`, then run `--check --include-env`.
  - 0023 must be applied before any code that writes refs.
  - 0024 and 0025 must be applied before batch 2 code deploys.
- **Per tenant:**
  - a quiet window, with the founder warned that editing pauses while the store is being updated;
  - a backup: confirm the Turso plan has PITR, record the ISO time just before the real command and pass it as `--backup-ref`. The disaster restore is `turso db create <new> --from-db <db> --timestamp <iso>`, which also loses orders placed after that time. The supported way back is the reversal tool;
  - a `restore-drill` copy;
  - a real dry run;
  - a rehearsal;
  - the real cutover (`pnpm migrate:documents`);
  - post-checks;
  - a reversal if needed (`pnpm reverse:documents`);
  - if a run stops midway: `pnpm migrate:documents -- --tenant X --status`, then `--resume` or `--abort` (before the flip only).
- **Before the first real cutover:** check hosted (Turso) batch atomicity on staging.
- **Hosted theme_pin writes** at cutover and reversal.
- **Before P4-PROVISION deploys:** 0024 and 0025 applied everywhere. After it deploys, provision one throwaway tenant on staging: it starts on the new editor, shows "Opening soon" until its first publish, and its checklist links work.
- **Other checks:**
  - OQ-14 (do image URLs differ only by query string?) on a dev store;
  - Typesense tenants, `_default` included: after the first rename, search shows the new name within a few minutes (the reindex job and the tick must be running), and a full sync keeps it;
  - phone and Safari;
  - webhook differences during cutover.

## 6. Open questions for the owner

### Answered (owner, 2026-11-04)

- **OQ-1 Typesense and titles: ANSWERED, option (b).** A minimal OVL-17 is pulled into phase 4 (decision 15, P4-SEARCH): publishing, undoing or resetting product content reindexes that product's search entry with effective values from `search_outbox`. Once the reindex ships and is proven, the title gate's Typesense condition is lifted, so renaming works in phase 4 on every tenant, `_default` included.
- **OQ-2 Whole-store rollback after cutover: ANSWERED, default accepted.** `/api/admin/releases` keeps its 409 in documents mode until PUB-08; per-document Undo plus operator reversal until then. Recorded as an accepted deviation (section 2).
- **OQ-3 The MIG-02 preview pin: ANSWERED, signed off.** The in-process data check plus a required passing local rehearsal replace the `pin_release` preview. Recorded as an accepted deviation (section 2).
- **OQ-4 Provisioning: ANSWERED, NOT the default.** New tenants start in documents mode from phase 4 (decision 16, P4-PROVISION in batch 5). Existing tenants still move only by the owner's cutover.
- **OQ-01 (spec) Product title:** overridable; the URL handle stays tied to Shopify.

### No answer: the default stands

- OQ-5 Webhooks during cutover: catalog syncs are paused while a tenant is migrating, but product webhooks continue (they change products for both the legacy and the new side equally) and are listed as an allowed difference. OK, or should webhooks be queued while migrating?
- OQ-6 doc_cart ruling: the default gives doc_cart storefront.write and storefront.publish and removes refuseCart, so the cart slot is editable in the new editor and cutover is not blocked on it. Side effect: the staff role (upsells.write and storefront.write, no storefront.publish) can still edit the cart offer but needs an owner or admin to publish it; the dry run says so under 'Team access that changes'. Confirm.
- OQ-7 Cart JSON to browsers: catalog_title and sku are stripped from every cart that reaches the browser (default, MANUAL-CHECKS:49). Confirm nothing client-side needs them.
- OQ-8 Saved templates (cms_templates): not converted to blueprints (DOC-09 is P1); they stay reachable read-only with 'Make a page from this'. OK?
- OQ-9 Re-cutover after a reversal: legacy wins for everything the legacy store can edit; overlay-only fields (title, description, gallery, display_*) come back from document versions; other content published in documents mode before the reversal is kept as history and not republished (counted in the report). OK?

OQ-5 to OQ-9: default stands, no answer. The defaults are what gets built. Each can be changed later without rework beyond the named item.

### Owner checks for the cutover runbook (not blockers for building)

- **PITR:** confirm the Turso plan has point-in-time restore, and record the PITR time just before each real cutover (`--backup-ref`). This is a runbook step and a MANUAL-CHECKS line, not a building question.
- **Staff cart-offer publishing:** at cutover, staff (`upsells.write`, `storefront.write`, no `storefront.publish`) can still edit the cart offer but need an owner or admin to publish it (OQ-6 default). Confirm this with the team before each cutover; the dry run lists it under "Team access that changes".

## 7. How each critique was answered

### R1 (safety and correctness)

- **Live-row batches had no mode guard.** **Fixed.**
  - `documentsGuardStatement` goes into every live-row publish, Undo, `discardOrphanEdits` and `commitPublishBatch` (LIVEROW).
  - Reversal first sets `migrating` in a guarded batch. It then copies aside, deletes, writes the outbox, moves the pointer and sets `legacy` in **one** batch (REVERSE).
  - A test hook reverses the tenant between the pre-check and the batch, in both LIVEROW and REVERSE.
- **`INSERT OR IGNORE` and stale rows.** **Fixed.**
  - `ON CONFLICT(id) DO NOTHING` is used only for content-addressed versions, with row counts verified after each chunk.
  - Documents and the legacy-derived live columns are upserted from the current legacy source. Legacy wins on a legacy tenant, and older differing drafts are kept as "kept" versions.
  - Phase-3 random-id rows are reused, and slug collisions are refused.
  - The re-cutover rule now covers every document (REVERSE (5)): legacy wins for everything legacy can edit. Overlay-only columns are restored from versions, in the flip only. Content published in documents mode stays as history, counted.
  - The stale-backfill fixture is tested (CUTOVER).
- **MIG-02 skipped entity content before the flip.** **Fixed.**
  - SEAM (batch 1) adds `contentGettersFor` and `candidateSource`.
  - OVL07 makes the entity getters read `src.entityRows`, or the backfilled live rows, whenever `src.v === 4`.
  - The cutover runs the full check after backfill and before the flip.
  - Backfill uses LIVEROW's `liveRowFor`.
  - A passing rehearsal on a fresh `restore-drill` copy, with the rendered comparison and a matching `sourceHash`, is a hard precondition of the real command.
- **`cms_templates` were never moved.** **Answered.** They are not mapped (DOC-09 is P1). The dry run reports the count, and ED05's read-only page keeps them reachable, with "Make a page from this". This is recorded as a deviation and a partial pull-in.
- **R1's shouldFix points, all taken:**
  - `classifyAbort`;
  - the EXISTS guard;
  - gift lines on the effective title;
  - `_default` in the Typesense gate;
  - an in-batch orphan check;
  - tool-enforced preconditions (ledger, running sync, schedule, digest, backup ref);
  - an explicit flag for the "no release" state;
  - the theme_pin re-read, resume and reversal reset;
  - an atomic reversal with the NULL pointer case;
  - `TITLE_READERS_READY`, so titles can't publish before SEARCH;
  - removed kinds kept readable;
  - the allowlist entry for `resolve.js:669`.
- **R1's uncovered points:**
  - Media deletes are refused while the tenant is migrating.
  - `search_outbox` is pruned and drained on tenants without Typesense.
  - Shopify write-back is covered by the gift and bundle sentinel.

### R2 (buildability)

- **Heartbeat preview.** **Option (a), adapted:** per-page draft merge for a valid preview session. No heartbeat, no migration, and no edit to `preview-sessions.js`.
- **No seam for the data check.** **Fixed:** the new item P4-SEAM in batch 1 owns `resolve.js` and `documents-reader.js`. Its files are listed.
- **The cart leak through RSC props.** **Fixed:** `shopperCart` goes at every client boundary (EFFECTIVE (4)), and the files are listed.
- **The guard allowlist.** **Fixed:**
  - The allowlist now names the `repo.js` facets and `resolve.js:669`.
  - The guard test is column-aware.
  - EFFECTIVE is forbidden from editing `resolve.js`.
- **SEARCH editing `effective.js`.** **Fixed:** EFFECTIVE ships `indexRows`, and SEARCH never edits `effective.js`.
- **GUARD against CUTOVER and reversal.** **Fixed:**
  - There are three guards.
  - The release helpers stay legacy-only.
  - `lib/migrate/*` writes its own statements under `migratingGuardStatement`.
  - The grep allowlist names `lib/documents/*` and `lib/migrate/*`.
- **Dependencies inside batch 4.** **Fixed.**
  - Batch 4 holds EDITOR, ED05 and EQUIV, with EQUIV tested on synthetic captures.
  - CUTOVER is batch 5, REVERSE batch 6 and DRILLS batch 7.
  - `editor/page.js` belongs to EDITOR. `editor-entry.js` belongs to SCAFFOLD, then ED05, with the URL helpers created in batch 0.
- **MAPPER depending on `cartEditable`.** **Fixed:** `lib/registry/editability.js` is in SCAFFOLD.
- **The dropped description.** **Fixed:** `description` and `description_html` (plus `seo_*` and `og_image`) are in `effective.js`, and the product page meta and JSON-LD use them.
- **R2's shouldFix points, all taken:**
  - the corrected FIX5 footprint;
  - the extra LIVEROW files;
  - theme_pin construction and its test;
  - pinned DDL;
  - async ids;
  - `withTenant` and `runMigrations` in the fixture;
  - the pnpm operator scripts;
  - the `/admin/releases` destination;
  - approvals and history guarded;
  - MEDIA kept out of `test-releases`;
  - hosted atomicity as an owner precondition.

### R3 (requirements coverage)

- **Missing briefs and acceptance.** All 18 items now have complete briefs and acceptance (19 with P4-PROVISION, added by the owner answer to OQ-4).
- **The read guard and 8.13 readers.** These are named in ED05 (2), with a test.
- **The remaining redirects.** They are in ED05 (1).
- **Setup and help links.** These are in ED05 (3), citing the onboarding lines, `ReleasesAdmin.js:223` and `PreviewFrame.js:10`.
- **The allowlist.** Fixed.
- **Checkout, confirmation, order page, quiz email and view events.** They are in EFFECTIVE's acceptance.
- **The PERF timing.** It is in EFFECTIVE (6).
- **OVL-04 acceptance.** It is in EDITOR.
- **ED-12.** EDITOR has the collection form, PICKER has the pairs and pins controls, and the parity list is tested.
- **MIG-02 as a hard precondition.** Decision 8. The pin replacement was signed off by the owner (OQ-3).
- **MIG-03 acceptance.** It is in CUTOVER:
  - refusals by test, including a check after the lock;
  - fault injection between every pair of steps.
- **The rollback 409.** Raised as OQ-2; the owner accepted it until PUB-08 (section 2).
- **MIG-04 acceptance.** It is in REVERSE.
- **`release:<id>` at cutover.** It is in CUTOVER (2c), with a test.
- **Backfill run twice or resumed.** Tested in CUTOVER.
- **R3's shouldFix points, all taken:**
  - the webhook in the acceptance;
  - un-archive replaced by live orphan status;
  - the upsell picker;
  - the per-slice sync check;
  - fixtures for a disabled placement and for several placements on one product;
  - the gate enforced by the command;
  - the spec's suite name kept;
  - provisioning and re-cutover raised as OQs (provisioning answered: documents for new tenants, P4-PROVISION);
  - the P1 pull-ins recorded.

### R4 (founder and ops)

**mustFix:**
- **The Typesense gate missed `_default`.** **Fixed:** the gate tests `typesenseConfigured() && productsCollection()` per tenant, `_default` included. Raised as OQ-1; the owner chose (b), a minimal OVL-17 in P4-SEARCH, after which the Typesense condition is lifted (decisions 1 and 15).
- **A refusal only at publish time, and the mixed set.** **Fixed:**
  - The gate refuses at save, and the editor disables the fields with the reason (`titleEditable` from `openEntityContent`). Clearing a gated field (Reset) is always allowed.
  - The publish belt can only fire for a title saved before the gate turned on (for example Typesense configured later). It follows today's set rule (`lib/documents/publish.js:417-444`, a blocked document refuses the set and is named). The refusal names the product in plain words and says to reset the name or leave the product out. The same set without it publishes (LIVEROW (4), with a test).
- **Founders can't reach every product in the editor.** **Fixed (EDITOR (2)).** Verified: the switcher fetches `/api/admin/catalog` at `DocumentEditor.js:321`.
  - EDITOR now owns `DocumentEditor.js` in batch 4 (it was in the owner table but missing from EDITOR's files). The switcher reads only `listProductContent`, which gains a `q` search on the effective and Shopify titles (SEARCH (3)).
  - Acceptance: product 31 and later open; a renamed product is found by its new name; both filters and the count render in the shell; the editor no longer calls the catalog route.
  - ED05 keeps `GET /api/admin/catalog` answering on documents stores. The read guard changes where it reads, never blocks it, and this is tested.
- **Reset, "differs" and "keep mine" were undefined for the stored shape.** **Fixed (LIVEROW (3b), enforced in the service):**
  - Reset and "Use Shopify's" set the field to null (follow Shopify again), never to `base_value`.
  - Saving a value equal to Shopify's stores null.
  - "Keep mine" is `resolveShopifyChange` `keep`: it re-bases `base_hash` and `base_value` in the draft.
  - SEARCH's `changed_in_shopify` filter and count read the draft's base only, so they clear as soon as the founder decides, with no publish.
  - Unit cases are in LIVEROW, SEARCH and EDITOR.
- **The dry run was not readable by a non-developer.** **Fixed (MAPPER (6)):**
  - The default output is a plain report: a verdict line ("Ready to move" or "Not ready: N things to fix", each with where to fix it), then what shoppers will see change, drafts that carry over, editor warnings, unmatched old addresses, saved templates and team access changes.
  - Developer detail goes below "Details" and in full with `--json`. The digest is the same either way.
  - A snapshot test checks there are no table names, codes, ids or statement counts above "Details".
- **No recovery when a tenant is stuck in "migrating".** **Fixed (CUTOVER (2h), REVERSE (4b)):**
  - `--status` prints in plain words the mode, step, start time and time spent.
  - `--resume` continues an open run.
  - `--abort` (before the flip only) returns the store to legacy in one guarded batch. Old writers and the parked sync then work again. After the flip, `--abort` points to the reversal tool.
  - Reversal has its own status and abort for a run stopped between its two batches.
  - The runbook adds a quiet window and a warning to the founder. These are unit tested, and DRILLS rehearses a stop and an abort.
- **The backup step had no real command.** **Fixed (CUTOVER (1) and (4)).** Verified: the `scripts/restore-drill.js` header and `docs/platform-guide.md` 5.3b give `turso db create <new> --from-db <db> --timestamp <iso>`.
  - `--backup-ref` is the ISO time recorded just before the command.
  - The runbook spells out the PITR clone. It says the reversal tool is the supported way back, and that PITR is the disaster path that loses later orders.
  - It also says the restore-drill copy is a verification copy, not a backup. Checking that the Turso plan has PITR is an owner check.

**shouldFix (all taken except one flag):**
- **Gallery override made visible.** Verified: `product_images` ids are synthesized (`<productId>::img::<i>`, `lib/schema.sql:28`), so the whole gallery becomes the founder's copy (LIVEROW (3b)). EDITOR says so in plain words at the first gallery edit. The notice reads "Shopify's images changed", with "Use Shopify's images".
- **The reversal message for the founder.** REVERSE's report lists products by name with the edits that no longer show. The runbook gives a plain message for the owner to pass on. The re-cutover dry run lists by name the edits that come back.
  - **Rejected:** a separate `--accept-restored-overlays` flag. Restoring is the OQ-9 default, and the dry run shows it by name before anything happens.
- **Shopify-owned fields shown read-only with a link.** Verified: `shopifyAdminBase` is local to `app/api/admin/catalog/route.js:25-29`.
  - LIVEROW moves it into the new `lib/admin/shopify-admin-url.js` and returns `shopifyAdminUrl` from `openEntityContent`.
  - EDITOR uses it, and ED05 switches the route to the import.
  - The "Shopify owns these" copy (`CatalogAdmin.js:169`) was already in EDITOR.
- **The orphan view.** EDITOR shows the stored base values with Reset and the notice disabled, and "Discard edits" for owners and admins. Staff see the plain reason instead of the button. This is in the acceptance.
- **ED-05 links.** ED05 adds a test that, on a documents store, no onboarding, ReleasesAdmin, PreviewFrame or hard-coded console link targets `/admin/catalog`, `/admin/home`, `/admin/upsells` or a bare `/admin/storefront`.
- **doc_cart access.** Verified at `lib/platform/authz.js:19-20`: staff hold `upsells.write` and `storefront.write` but not `storefront.publish`. The dry run's "Team access that changes" section says staff can still edit the cart offer but need an owner or admin to publish it. This is added to OQ-6.
- **A runbook drill a non-developer can follow.** DRILLS adds a `runbook` stage that follows the runbook literally, including a stop and an abort. It records each step that needed developer knowledge and fixes the runbook wording; DRILLS owns the runbook in batch 7 for those fixes only.

**R4's uncovered points:**
- The briefs it could not see now cover each gap it flagged.
- OVL-06 and the P3-FIX4 wording were verified by R4 itself; no work.
- The order page contrast is measured in SEARCH's rendered acceptance.

### Uncovered points of R1 and R2, now answered

- **R1, the flip batch's guards.** The flip runs under `migratingGuardStatement(run)`. The pointer flip is now also guarded on the live release id read at lock, which is kept in the run row's report JSON because 0024 is pinned. A test moves the pointer after the lock (CUTOVER (2a), (2e)).
- **R2, a Typesense spy seam.** Verified: `lib/sync.js` already takes an injected indexer (lines 723 and 894). SEARCH may add a client seam in `lib/typesense-search.js`, which it owns. The minimal OVL-17 drain takes a `client` argument for the same reason, so its tests use a spy client.
- **R2, D2 against the campaign and journal renderers.** ED05 checks both routes with an existing banner. The inherited warning matches what each route actually shows, and this is tested.
- **R2, fixed suite or type counts.** Verified: `scripts/run-tests.js` only prints the count, and no suite asserts a document-type count. SCAFFOLD's "96 suites" acceptance stands.
- **R2, the P3-FIX4 wording.** Verified by R4 (P3-FIX4 item 10); no action.

## 8. Batches

Each item has a complete brief, file list and acceptance in batches.json. The builder gets its brief plus this file. Summary:

### Batch 0 - Scaffold (start now, parallel with P3-FIX5)
- **P4-SCAFFOLD** (`cms/p4-scaffold`; OVL-02, MIG-01, MIG-05, MIG-03; 0024_content_live.sql): Lay the ground for phase 4. It touches no P3-FIX5 file, so it can start now. 7 acceptance lines.

### Batch 1 - Foundations (cut only after P3-FIX5 has merged into cms/phase-1)
- **P4-GUARD** (`cms/p4-guard`; MIG-03, MIG-02, MIG-04, ED-05): Move the content-system mode check of every old write into the write's own batch (MIG-03; P2-GUARD known limit; OC-G3, OC-W3), and give later items the guards they need. lib/cms/store.js is also a P3-FIX5 file: rebase on the merged FIX5 first. 6 acceptance lines.
- **P4-MEDIA** (`cms/p4-media`; MED-03; 0025_media_archived.sql): The server side of the MED-03 reference index and archive. lib/documents/service.js is also a P3-FIX5 file: rebase on the merged FIX5 first. 7 acceptance lines.
- **P4-FIXTURES** (`cms/p4-fixtures`; MIG-01, MIG-02, MIG-04): Test infrastructure only; no lib edits. 4 acceptance lines.
- **P4-SEAM** (`cms/p4-seam`; MIG-02, MIG-01): Give the MIG-02 data check an explicit, production-safe source seam, so every resolved* getter can run against a given source (a candidate v4 list, in-memory bodies, injected entity rows) without cookies(), React cache() or a flip. 4 acceptance lines.

### Batch 2 - Server core
- **P4-EFFECTIVE** (`cms/p4-effective`; OVL-03, OVL-05, OVL-06, SHOP-02): Build lib/catalog/effective.js (edge-safe Kysely, no node: imports) as the only shopper-path reader of product content columns, and move every shopper reader onto it. Do not edit lib/content/resolve.js (SEAM and OVL07 own it). 10 acceptance lines.
- **P4-LIVEROW** (`cms/p4-liverow`; OVL-01, OVL-02, OVL-07, ED-12, MED-03, OVL-05, OVL-17): Make product content and collection content real, publishable documents with live rows. lib/documents/service.js, lib/documents/changes.js, lib/admin/documents-api-shapes.js and scripts/test-api-shapes.js are also P3-FIX5 files: rebase on the merged FIX5 first. Writes the search_outbox rows the minimal OVL-17 drains. 16 acceptance lines.
- **P4-MAPPER** (`cms/p4-mapper`; MIG-01, MIG-02, DOC-03): A pure MIG-01 mapper plus a read-only dry run. It writes nothing. 10 acceptance lines.
- **P4-HARNESS** (`cms/p4-harness`; MIG-02, MIG-03, MIG-04): The proof infrastructure for phase 4. Do not edit scripts/drills/p3/*; import from it. 5 acceptance lines.

### Batch 3 - Readers, search, entity content and pickers
- **P4-SEARCH** (`cms/p4-search`; OVL-05, OVL-03, OVL-04, OVL-06, OVL-17): (1) lib/catalog/search-doc.js: buildSearchDoc(effectiveRow) is the one builder; a full sync indexes effective values and drains the outbox. (2)-(4) Console readers, the editor's product list and the order-page contrast. (5) Flips TITLE_READERS_READY and removes the gate's Typesense condition once (6) is proven. (6) The minimal OVL-17 (owner answer OQ-1 (b)): drainSearchOutbox in the new lib/catalog/search-reindex.js, the fast path in documents-api.js, a 'search_reindex' job in lib/platform/worker.js and the full-sync backstop; spy client only. 11 acceptance lines.
- **P4-OVL07** (`cms/p4-ovl07`; OVL-07, OVL-02, ED-12, PV-03, MIG-02): (1) The v4 reader uses the live rows. Whenever src.v === 4 (a live v4 release OR a SEAM candidateSource), these getters read the entity row from src.entityRows when given, else through new contentRowFor(productId) / collectionRowFor(collectionId) in lib/catalog/effective.js: 6 acceptance lines.
- **P4-PICKER** (`cms/p4-picker`; MED-03, OVL-04, ED-12, MED-02): The editor controls the product and collection forms need. components/admin/editor/editorModel.js is a P3-FIX5 file: do not edit it here (EDITOR owns it in batch 4). 4 acceptance lines.

### Batch 4 - Editor UI, old routes and the rendered comparison tool
- **P4-EDITOR** (`cms/p4-editor`; OVL-04, OVL-01, OVL-06, ED-12, ED-02): The OVL-04 product editor and the ED-12 collection form. Owns components/admin/editor/editorModel.js, Switcher.js and app/(console)/admin/(authed)/editor/page.js in this batch. 11 acceptance lines.
- **P4-ED05** (`cms/p4-ed05`; ED-05, MIG-03, DOC-06): Old routes, frozen-table readers, setup links, saved templates and the D2 ruling. Owns lib/admin/editor-entry.js, lib/registry/sections.js and lib/documents/checks.js in this batch. 8 acceptance lines.
- **P4-EQUIV** (`cms/p4-equiv`; MIG-02): The MIG-02 rendered comparison tool (built and tested on synthetic captures; CUTOVER runs it on the harness). 3 acceptance lines.

### Batch 5 - Cutover and new-store provisioning (after batch 4 has merged)
- **P4-CUTOVER** (`cms/p4-cutover`; MIG-01, MIG-02, MIG-03, MED-03, ED-05, OVL-17): The cutover command (MIG-01 backfill, MIG-02 checks, MIG-03 flip) and the owner runbook. Builders run it only on file tenants and the harness. Owns scripts/migrate-documents.js (after MAPPER) and lib/migrate/*. Refuses a store already in documents mode; kicks the search reindex after the flip. 13 acceptance lines.
- **P4-PROVISION** (`cms/p4-provision`; MIG-03, PUB-06, GEN-02, TOK-03, ED-05): New tenants start in documents mode (owner answer OQ-4). A guarded 'content_mode' provisioning step on fresh databases only; no starter documents, release, legacy rows or theme_pin; closed until the first publish; the onboarding checklist works for such a store. Tests in the existing test-provision and test-tenancy suites, file databases only. 6 acceptance lines.

### Batch 6 - Reversal (after P4-CUTOVER has merged)
- **P4-REVERSE** (`cms/p4-reverse`; MIG-04, OVL-17): MIG-04: put a cut-over tenant back on the legacy store with no unmanaged overlay. lib/migrate/reverse.js and scripts/reverse-documents.js (replaces SCAFFOLD's stub). Local and harness only for builders; same --hosted --confirm --backup-ref rule as CUTOVER. 8 acceptance lines.

### Batch 7 - Drills and owner checks
- **P4-DRILLS** (`cms/p4-drills`; OVL-04, MIG-02, MIG-03, MIG-04, ED-05, MED-03, OVL-17): Browser proof of the founder tasks on the harness, plus collecting owner checks. Adds stages to scripts/drills/p4/run.mjs (HARNESS's file) and new stage files under scripts/drills/p4/. 4 acceptance lines.


## 9. Orchestrator rulings after verification

- Unpublish: product and collection content documents cannot be taken offline; the op is refused in plain words pointing to "Use Shopify's" plus publish (P4-LIVEROW).
- Title gate words: the refusal names the condition that blocked; Typesense words only when Typesense is the cause (P4-SEARCH).
- PROVISION acceptance 2: assert contentSource().mode === "closed", not deep equality.
