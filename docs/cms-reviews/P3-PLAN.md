# Phase 3 build plan: Publish and the editor (revision 2)

**Base:** `cms/phase-1` at `bb7ab33`, phases 1 and 2 done.
**Branches:** one per item, `cms/p3-<id>`, in its own worktree, merged with `--no-ff`. Each batch is cut after the previous batch has fully merged.
**Tenants:** no real tenant changes mode in phase 3 (MIG is phase 4). Legacy tenants keep their editors, releases, preview and the S59 candidate preview. The new editor runs only on documents-mode test tenants and the design harness.
**Scope:** P0s only: PUB-02, PUB-03, PUB-04, PUB-05, PUB-06, PUB-09, PUB-11, ED-02, ED-03, ED-04, ED-12, PV-01, PV-02, AU-01, AU-02, AU-04, TOK-03.
**Full briefs** are in `batches.json`. Each builder gets its brief plus this file.

## R. How the critiques were answered

### Must fix

| # | Critique | Answer |
|---|---|---|
| A1 | Undo isn't tied to the row the founder clicked, so a retry can undo someone else's publish | **Fixed.** `undo`, `undoSet` and dry runs carry `logId`. A row is "current" only when it is the latest undoable row and the live state still matches it. If not, the answer is 409 `PUBLISHED_ELSEWHERE`. The commit gains `expectPublished`, a guard term on `published_version_id`. A rebuild after a lost race re-checks that the row is still current. `canUndo` is true only on current rows. Test: tab A publishes while tab B's Undo is in flight. |
| A2 | The republish confirm compares `body_hash` with `draft_hash` and never fires | **Fixed.** The check compares `documentHash(undone version body)` with `draft_hash`. Commit, Undo and take-offline always set `published_hash = documentHash(body)`. Tests use bodies whose section ids differ. |
| A3 | The commit's draft rewrite leaves slug and label stale, and a UNIQUE clash shows as a 500 | **Fixed.** The commit's `draft` field writes the same columns as `service.draftWrite`, and a test compares the column sets. Undo checks the target slug against the live list and other drafts (`draftSlugOwner`). A UNIQUE failure on `documents.slug` maps to 409 `SLUG_TAKEN`. Test: an Undo whose target slug is held by another draft. |
| A4 | Refs inserts break every publish before 0023 | **Fixed (option b).** `hasRefsTable()` probes once and caches only a positive answer, so it costs one counted statement until 0023 runs. The build leaves the refs statements out when the table is missing. Test: a publish on a 0022 tenant. |
| A5 | "Adopt revision, keep text" undoes server-side draft rewrites | **Fixed.** `undo`, `keepLiveSection`, `discardDraft` and `restoreVersion` are server-replace operations. The store flushes first, holds autosave, replaces body and revision from the response, and replays edits typed during the hold as field-path operations. There is one test per operation. |
| A6 | "Publish both" can publish a target nobody reviewed | **Fixed.** PublishPanel loads `listChanges` for every offered target, and for "publish all changes", and keeps Confirm disabled until all have loaded. `draftHash` pins what was shown. There is a unit test and a drill step. |
| A7 | Closed falls through to the legacy helpers and shows code-default copy | **Fixed (default-deny).** A closed source is v4-shaped over `emptyList`, so every getter takes its existing v4 path. A test walks every exported `resolved*` getter, enumerated from the module. |
| B1 | UNDO needs the private helpers in `publish.js`, which CHECKS owns | **Fixed.** P3-COMMIT moves them into `lib/documents/build.js` in batch 1. It does this first as a pure move, then extends `makeBuild` overrides (offline, draft, published, undone, expectPublished, extraVersions, action), `liveEntryOf` (offline means not live), and `slugClash` (archived offline slugs are released). `build.js` has no batch 2 owner. UNDO edits only `undo.js`. |
| B2 | = A3 | As A3. |
| B3 | = A4 | As A4. |
| B4 | The `DOCUMENTS_UNPUBLISHED` assertion in `test-preview-overlay.js` sits in a file SESSION owns | **Fixed.** P3-CLOSED owns `test-preview-overlay.js` and `test-release-readers.js` in batch 1. SESSION's tests move to the new `test-logout-preview.js`. The repo-wide grep found only those two suites plus `resolve.js`. |
| B5 | A bridge in a `useEffect` can't be tested without jsdom | **Fixed.** The protocol moves to `components/preview/bridge-core.js`, which takes window and document as parameters, and `PreviewBridge` becomes a thin wrapper. Every batch 3–4 component keeps its logic in a pure model (`store.js`, `previewMachine.js`, `inspectorModel.js`, `treeModel.js`, `publishModel.js`, `editorModel.js`, `richTextModel.js`). SSR is used only for markup. |
| B6 | Interactive acceptance is proved only in batch 5 | **Fixed.** Every acceptance line is tagged unit (pure model), rendered (SSR) or drill. P3-HARNESS (batch 2) ships `scripts/drills/p3/lib.mjs` and seeds. ROUTES (batch 3), EDITOR, DESIGN and RTE (batch 4) each ship and run their own drill. In batch 4, EDITOR may fix the batch 3 components that its drill finds defects in, so defects are fixed in the batch where they are found. Batch 3 components have no host page until EDITOR. Their interaction logic is unit-tested in models, and EDITOR's drill covers them. P3-DRILLS keeps `run.mjs`, the timed tasks and the cross-item matrix. |
| B7 | Mode 409 on the new reads conflicts with the API structure | **Fixed.** `listChanges` and `listRecentlyPublished` check `getCmsMode` themselves and answer 409 `STORE_USES_LEGACY`. `getDocument` and `listDocuments` are unchanged. |
| B8 | `dryRun` and pass-through would need batch 2 edits to `documents-api.js` | **Fixed.** P3-COMMIT parses `dryRun`, `logId` and `confirmRepublish`. The dispatcher passes the whole op through and returns the module's `{status, body}` as-is, so `documents-api.js` has no batch 2 owner. |
| C1 | No way to detect that the frame shows live after exit | **Fixed.** With no preview cookie and a console cookie present, the layout mounts the bridge with `{ok:false, reason:'live'}`. The editor also re-mints when no `ready` arrives within 3 seconds of a frame load. `previewMachine` unit tests cover both, and the editor drill has a "See the live store, then Reconnecting, then Up to date" step. |
| C2 | The Undo confirm doesn't say what will change | **Fixed.** New batch 1 item P3-DIFF (`lib/documents/diff.js`, pure). The dry run returns `changes` (live body against target). `listRecentlyPublished` rows carry a `summary` (from body against to body, bodies read in one IN statement). Both have acceptance tests. |
| C3 | The TOK-03 guard can't pass with the readers left in place | **Fixed.** P3-DESIGN moves onboarding, help, agency and brand-readability to `doc_design`, and the operator screens (overview, themes, tenants/[id], TenantDetail) to `theme_pin`. The guard has an explicit allowlist with a reason per file: legacy-mode branches, plus the brand and theme console pages, which ROUTES redirects in documents mode. |
| C4 | ED-02 product search has no owner | **Partly built, partly recorded.** The switcher searches documents by name. Products are listed by name with "not yet editable here". Editing waits for OVL-02, recorded in section 4. |
| C5 | In-app navigation loses typing | **Fixed.** `store.beforeNavigate()` flushes. The editor adds a capture-phase handler on console anchors and the switcher. There is a unit test, plus a drill step: type, then click a console link within the pause. |

### Should fix: adopted

- **Offline redirects.** Take offline drops the document's redirects; publishing again rewrites them.
- **Offline entry and the inherited rule.** An offline entry has `liveBody` null, so nothing in it is treated as inherited.
- **PV-02 draft mode.** Meta lengths and nav links become incomplete in draft mode. `SLUG_INVALID` stays 422, so the store sends the last saved slug while the field is invalid. A pending 422 keeps the text and warns on close.
- **Undo upgrades the target.** Undo runs `upgradeBody` on the target body.
- **First publish needs a home page.** A first publish without a home page gets 409 `FIRST_PUBLISH_NEEDS_HOME`, with an offer that adds `doc_home`. This holds until PUB-12 ships (open question).
- **Closed-store checkout.** A preview session allows COD only; Razorpay is refused. The order is tagged as a test only if a notes field exists; there is no migration. The drill cancels the order.
- **`undoSet`.** It guards on the current revision and saves divergent drafts as `undo_saved`.
- **`extraVersions`.** These stay separate from `versions` in reconcile. A test pins the `oursPresent` path.
- **Logout.** Ending previews on every device and in legacy is recorded as a known change. There is a legacy re-login test.
- **`keepAsEarlierDraft`.** It dedupes by hash and is capped at 10 per document (409 `TOO_MANY_KEPT`).
- **Slug release.** Archive is terminal (no unarchive path; a grep test proves it), so no guard term is needed.
- **One response contract.** P3-SCAFFOLD (batch 0) adds `lib/admin/documents-api-shapes.js`. SESSION's mapper and the batch 2 server tests both use it.
- **VALIDATE's grep.** The plan grepped the suites. VALIDATE owns `test-documents`, `test-registry-contract`, `test-sections-render`, `test-writers` and `test-failure-matrix` (documents rows only). Publish-mode cases must not change.
- **SectionView isolation** is narrowed to a server section's own render or binding. `lib/cms/section-data.js` is named.
- **`checkoutCapability`** stays synchronous. The closed check runs only in the routes.
- **Platform logout** clears `_preview`.
- **`pnpm-lock.yaml` and `next.config.mjs`** belong to RTE.
- **FORMS is split** into INSPECTOR and TREE, both prop-driven with no store import.
- **`theme_pin`** is written by the `lib/documents/after-commit.js` hook (an empty registry from COMMIT; DESIGN adds the handler).
- **Owners of the brand/theme pages and APIs and of `kits.js`** are named: ROUTES and DESIGN.
- **Console nav files** have named owners (ROUTES). The `/admin/releases` mount moves to EDITOR, because it needs the PUBLISHUI component.
- **Offline journal posts** use an index override (`disabled:[id]`). The body is unchanged, so the hash comparison still holds.
- **The PUB-06 reorder** is recorded as intended (P3-CLOSED brief).
- **ED-02 partial** is added to section 4.
- **Keep mine and Use the newer version** are both specified and tested.
- **`showDesign`** is on while `doc_design` is open.
- **The design panel's `affects` rows** come from `lib/registry/token-usage.js`.
- **The doc_design two-admin 409** is tested.
- **Undo of an unpublish row** is specified. The invalid action value `undo-of-unpublish` was removed.
- **Alt-text warnings** were added.
- **Refs for phase 2 publishes** come from HARNESS re-seeding through publish. MIG-01 owns the legacy backfill.
- **The RSC probe** is extended to every content route.
- **The COD order** is placed end to end in the drill.
- **The `data-field` paths** are fixed (`body.N`).
- **AU-01 acceptance** gains shared `.rte` styles, server-only sanitizing and "Edit as HTML".
- **AU-04** has a loop over every kind.
- **The unsaved new section** shows "Adding to preview…".
- **`focusRequest {path, offset}`** is in the RichTextField interface.
- **ED-02 other-document pick** has a test.
- **The ED-12 checklist** is an INSPECTOR deliverable.
- **P1s dropped:** PV-04 (re-mint before expiry) and PUB-10 negative.
- **The full-width writing view** is built.
- **The statement-count claim** is narrowed to a full render; an RSC navigation that skips the layout adds 1 (recorded).
- **A pending keepalive** gets the beforeunload warning and the local backup offer.

### Should fix: rejected or deferred

- **Offer changes in Recently published (COM-03).** Deferred. `listRecentlyPublished` reads only `publish_log`, and this is recorded as a gap for COM-03. Merging offer config history is outside the phase 3 P0 list.
- **Draft-mode `SLUG_INVALID` downgrade.** Rejected, because the slug column is the uniqueness key. The store-side "send the last saved slug" rule covers the founder's need instead.

### Uncovered points

- **Platform preview revoke.** Platform logout clears the cookie. Platform-created sessions expire within the hour (known limit; the platform has no per-tenant revoke).
- **Forms on a closed store.** Contact, leads and quiz POSTs get 403 `STORE_CLOSED`.
- **Undo of an offline-making undo.** Not a target. Copy and drill say "publish it again".
- **The overlay on an offline page.** The banner says "This page is offline. Publishing it brings it back."
- **A lost keepalive.** The local backup is offered on the next open.
- **Harness seeds.** P3-HARNESS owns them.
- **Statement count on RSC navigation.** Recorded.

## 0. Decisions

1. **One commit core, extended, never forked.** P3-COMMIT moves the build helpers from `publish.js` to `lib/documents/build.js` with no behaviour change. It then adds per-item overrides and the commit fields:
   - `draft {body, hash, slug, label, by, at}`;
   - `published {versionId|null, hash|null}`, where the hash is always `documentHash`;
   - `undone`;
   - `expectPublished`;
   - `extraVersions` (`undo_saved`, inside the guarded batch);
   - refs;
   - log `action`, `undoes_log_id` and `saved_version_id`.

   Every version id in a build is fresh. Undo and take-offline copy bodies into new `published` versions. Reconcile treats `extraVersions` separately from `versions`.
2. **Migration 0023 is the only phase 3 migration**, owned by P3-COMMIT:
   - `document_refs` plus the target index;
   - partial indexes on `publish_log(set_id)` and `publish_log(undoes_log_id)`;
   - an index on `publish_log(created_at)`.

   Refs are written only for published versions. Publishing works without the table. The spec's `ref_type 'page'` becomes `'document'`.
3. **Contract first.** P3-SCAFFOLD (batch 0) registers every new suite and writes `documents-api-shapes.js`. P3-COMMIT (batch 1) parses every new op: `unpublish`, `undo` (with `logId`), `undoSet` (members `{id, logId}`), `listRecentlyPublished`, `listChanges`, `keepLiveSection`, `keepAsEarlierDraft`, `dryRun` and `confirmRepublish`. The dispatcher passes ops through. The stubs answer 501.
4. **Take offline (Undo of a first publish, and `unpublish`).**
   - The entry stays, pointing at a fresh copy of the last live body. Its pages row or journal index entry gets `enabled:false`, the redirects are dropped, and `published_version_id` and `published_hash` become null. `undone_version_id` is set to the version taken offline, and the draft is kept.
   - Publishing the same content again (`documentHash` equal) needs `confirmRepublish`.
   - Undo of an `unpublish` row brings the page back.
   - An offline page keeps its slug until it is archived. A publish claiming the slug of an archived offline page releases it.
5. **PUB-03 checks** run over the set's own bodies only, against M2.
   - Each issue has a `level` (blocks, warns or inherited), an `anchor`, `where` words and `actions`.
   - A link to an existing unpublished document gives 422 `LINKS_TO_UNPUBLISHED` with an offer. The UI shows each target's changes before Confirm.
6. **Undo targets a row.**
   - The `logId` must be current, or the answer is 409 `PUBLISHED_ELSEWHERE`.
   - Undo upgrades the target body, checks its slug against the live list and other drafts, and saves divergent drafts as `undo_saved`.
   - A dry run returns the change words and the pages that link to the document.
7. **PUB-06 closed is a content-source state.** Documents mode with state none is a v4 source over the empty list.
   - The layout shows "Opening soon", and closed wins over maintenance.
   - The sitemap is `/` only.
   - Checkout, contact, leads and quiz POSTs are refused, except that a valid preview session may place a COD test order.
   - The first publish must include the home page.
   - Shopify catalog data on product, collection and search routes is an owner interpretation.
8. **Finding 3 follows PUB-01: chrome corruption gives the error page.** It goes through `pageChromeGuard` on the page getters. The owner ruling stays an owner check.
9. **PV-02 contract change.** In draft mode, in-section invalid, meta length and nav link issues are `incomplete`. Structure issues and `SLUG_INVALID` stay 422. Publish is unchanged.
10. **Preview-only attributes.** `data-doc` and `data-field` (validate's field paths) render only in preview. The bridge mounts for preview, for a refused preview, and for a console-cookie live view. Shopper HTML without console cookies is byte-identical.
11. **The new editor runs side by side with the legacy editors.** `/admin/editor` is a nodejs page that reads the mode fresh. The legacy content, brand and theme routes redirect in documents mode only. The only legacy component change is the PV-01 slice in `Designer.js`. Finding 2 is fixed by the redirect.
12. **Logout ends preview.** It revokes the actor's previews and clears `_preview` in every mode. This is recorded as a known change.
13. **No new npm dependency**, except possibly Tiptap for AU-01 (an open question). Drills use `playwright-core`.
14. **Testability.** Logic lives in pure models. SSR is used only for markup. Drills come from the batch that can host them.

## 1. Batches

File ownership is one owner per batch (checked by script against `batches.json`). Gate: batch 2 starts only after `pnpm test:publish` passes on sqld with P3-COMMIT merged.

| Batch | Items |
|---|---|
| 0: contract and scaffold | P3-SCAFFOLD |
| 1: server foundations | P3-COMMIT, P3-DIFF, P3-CLOSED, P3-SESSION, P3-VALIDATE |
| 2: operations, frame, harness | P3-CHECKS, P3-UNDO, P3-CHANGES, P3-FRAME, P3-HARNESS |
| 3: editor building blocks | P3-STORE, P3-INSPECTOR, P3-TREE, P3-PUBLISHUI, P3-ROUTES |
| 4: integration | P3-EDITOR, P3-DESIGN, P3-RTE |
| 5: drills | P3-DRILLS |

Files that pass between batches, each with one owner per batch:

| File | Owners, by batch |
|---|---|
| `resolve.js`, storefront `layout.js` | CLOSED (1), FRAME (2) |
| `publish.js` | COMMIT (1), CHECKS (2) |
| `service.js` | CHANGES (2), RTE (4, only if needed) |
| `changes.js` | COMMIT (1, stub), CHANGES (2), DESIGN (4) |
| `components/sections/index.js` | VALIDATE (1), FRAME (2) |
| `test-preview-overlay.js` | CLOSED (1), FRAME (2) |
| `test-sections-render.js` | VALIDATE (1), FRAME (2) |
| `test-documents.js` | VALIDATE (1), CHANGES (2) |
| `test-publish-service.js` | COMMIT (1), CHECKS (2) |
| `after-commit.js` | COMMIT (1), DESIGN (4) |
| `package.json` | SCAFFOLD (0), RTE (4, Option A only) |
| `DocumentEditor.js` | ROUTES (3, placeholder), EDITOR (4) |
| batch 3 editor components | their batch 3 owners, then EDITOR may fix them in batch 4 (not `RichTextField.js`, which RTE owns) |

**Acceptance kinds:**
- **unit:** pure module or service, in node.
- **rendered:** react-dom/server markup through the SWC `registerHooks` loader. No effects, no events.
- **drill:** `playwright-core` on the harness, each drill with its own `DESIGN_PORT` and `DESIGN_SQLD_PORT`.

## 2. Where the spec is wrong or stale against the code

- **8.6 Undo step 4** writes `undo_saved` "first". It goes in the same guarded batch, or a lost Undo leaves orphan rows.
- **8.6 Undo** has no target identity. Undo needs the publish_log row (`logId`) plus a live-state check, or retries undo other people's publishes.
- **8.2 `ref_type 'page'`** becomes `'document'`. Draft refs and the backfill belong to MED-03 and MIG-01.
- **8.14** lacks:
  - `listRecentlyPublished`, `keepLiveSection` and `keepAsEarlierDraft`;
  - `confirmRepublish`, `dryRun` and `logId`;
  - the new codes `PUBLISHED_ELSEWHERE` (for Undo), `REPUBLISH_CONFIRM_NEEDED`, `FIRST_PUBLISH_NEEDS_HOME` and `TOO_MANY_KEPT`.
- **PUB-04 and 8.6** are silent on an offline page's slug, its redirects and its `published_version_id`. Decision 4 writes the rule.
- **Two hashes.** `document_versions.body_hash` keeps ids, while `documents.*_hash` is `documentHash` (ids stripped). The spec uses "hash" for both; phase 3 code names which one it means.
- **PUB-06 "no real page content".** Catalog routes still return public Shopify data (owner interpretation). The spec's "verified console session" is read as "a valid console-minted preview session". The order schema has no test-order flag.
- **PUB-06 vs PUB-12.** The first publish opens the store. Phase 3 requires the home page in that first publish.
- **ED-12** lists `collection_content`, but no such type is registered. `cart` waits for the capability ruling, and `product_content` waits for OVL-02.
- **ED-04 evidence** cites the legacy `lib/cms/registry.js:29`. The field attribute comes from `lib/registry` and the renderers. The text section's paragraphs are `body.N`.
- **ED-03** omits the roughly 64 KB keepalive limit (phase 3 uses 60,000 bytes) and in-app navigation.
- **AU-01**'s 6 surfaces are legacy screens, retired at ED-05 and OVL-04.
- **PV-03** is unchanged from phase 2: the overlay shows every saved draft. ED-02's dependency on it is only partly met.
- **8.11 / section 11** order PUB-06 after PUB-03 and PUB-05. Phase 3 builds it first on purpose.

## 3. Constraints (P2-PLAN section 3 still binds)

- **Edge-safe.** No `node:` imports in `lib/registry/*`, `lib/content/*`, `lib/documents/{ids,release-list,refs,paths,diff}.js`, `lib/admin/documents-api-shapes.js` or `lib/cms-mode.js`. Writes run only on nodejs console routes.
- **No env vars. No writes to Shopify.** Price, variants and inventory stay Shopify-owned.
- **Migrations.** Use `IF NOT EXISTS`, and run `tenant:migrate --all --check` before deploying code that needs 0023. Publishing works without 0023, but refs need it. Re-seed the harness after 0023.
- **Measurement.** Query counts use `scripts/support/request-cache.js`. Every suite stays under 2 minutes, and each packet records its measured time.
- **Drills** use their own ports (never 3017) and re-seed between state-changing drills. Test orders are cancelled.
- **Legacy stays green and unchanged in meaning:** `test-admin-console`, `test-cms-api`, `test-sections`, `test-sections-render` (equivalence), `test-releases`, `test-themes`, `test-editor-layout`, `drill:smoke` and `drill:edge`. Every redirect and closed branch has a legacy and a migrating test.
- **Known legacy behaviour changes,** owner-visible:
  - logout ends the Designer preview;
  - the Designer shows a failed push instead of hiding it.

## 4. Requirements only partly provable in phase 3

| Requirement | Proved in phase 3 | Waits for |
|---|---|---|
| PUB-04 | Undo, take offline and publish again for every content document, plus Recently published with summaries | Product and collection content (OVL-02); offer rows (COM-03) |
| PUB-05 | Sets, "publish both" with review, "publish all changes", whole-set Undo | Product content in a set, and the split above the cap (OVL-02) |
| PUB-06 | Closed store, form and checkout gates, a preview COD order, first open with the home page | Migrated live tenants (MIG-01..03); PUB-12 |
| ED-02 | Switcher and document name search; products listed but not editable | Product editing and search into product content (OVL-02); per-tab overlay (PV-03) |
| ED-12 | Forms and the checklist for collections index, header, footer, announcement, product layout, collection layout and design | Cart (capability ruling), product content (OVL-02), collection content (no type yet). These are phase 4 cutover gates. |
| AU-01 | The new editor's rich text | Legacy surfaces (ED-05), catalog modules (OVL-04) |
| TOK-03 | Drafts, publish, Undo, kit apply, readers, operator `theme_pin`, guard, `affects` | Seeding from the live brand (MIG-01), the logo (GEN-04) |
| ED-03 | Within one pause, in-app navigation, keepalive up to 60,000 bytes, local backup | A larger body on tab close gets the warning plus the backup |
| PV-03 | Unchanged from phase 2 | Per-tab overlay |

## 5. Owner checks (merged into MANUAL-CHECKS.md after the drills)

- **Hosted Turso, on a staging tenant:** Undo, take offline, whole-set Undo, an Undo racing an autosave, and an Undo racing a publish (409) are all atomic.
- **Local production build:** the RSC probe against a closed store (`next build && next start`).
- **Rulings and acceptances:**
  - finding 3: error page or neutral chrome;
  - decision 4: slug reservation;
  - decision 9: the PV-02 contract change;
  - first publish must include the home page;
  - the logout known changes;
  - the catalog-data interpretation, and preview session as the "verified console session".
- **Founder tasks:** the five timed founder tasks with real participants (tasks 1, 4 and 5 are in scope).
- **Phones:** the closed page, the banner and the offline line.
- **Deploy order:** run 0023 before the code that writes refs (DR-4).

## 6. Open questions that block a P0

See `openQuestions`.
