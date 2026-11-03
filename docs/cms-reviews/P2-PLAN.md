# Phase 2 build plan (revised): Foundation — documents, the v4 read path, atomic publish proven first

Base: `cms/phase-1` at `a6d028e`. Each item gets its own branch (`cms/p2-<id>`) and worktree, and is merged with `--no-ff`. No tenant changes mode in this phase, and provisioning stays `legacy`. Today's releases, editors and preview keep working on every legacy tenant. Only test tenants and the harness fixture use `documents` mode.

Revision 2 changes the plan in these ways:
- It answers every mustFix (see section 5).
- It splits the old batch 4, so that no two items in a batch share a file.
- It pre-registers a suite file for every later item.
- It writes out the briefs for P2-HERO (renamed P2-SECTIONS), P2-WRITERS, P2-PREVIEW, P2-PERF and P2-DRILLS in full. They were cut off in revision 1.

## 0. Decisions (smallest correct design)

1. **Atomic publish is one `libsql.batch(stmts, "write")` using the repo's GEN-02 guard-and-abort pattern.** It does not use the per-statement subselect guards in spec 8.6. The batch runs these steps in order:
   1. Insert the version rows with `INSERT … ON CONFLICT(id) DO NOTHING`.
   2. Insert the release row (`published_at` null) the same way.
   3. Flip the pointer: `UPDATE release_state SET live_release_id=:new, updated_at=:now WHERE id=1 AND (live_release_id IS :L OR live_release_id=:new) AND EXISTS(SELECT 1 FROM releases WHERE id=:new AND content_hash=:h) AND (SELECT count(*) FROM document_versions WHERE id IN (:v…))=:nv AND (SELECT revision FROM documents WHERE id=:d)=:rev …`
   4. Abort if nothing flipped: `INSERT INTO release_state (id) SELECT 2 WHERE changes()=0`. This breaks `CHECK(id=1)`, so the whole batch rolls back.
   5. Stamp `published_at`.
   6. Insert the publish_log rows with `ON CONFLICT(id) DO NOTHING`.
   7. `UPDATE documents SET published_*`.

   `ON CONFLICT(id) DO NOTHING` absorbs only a duplicate id. NOT NULL and CHECK still raise. The flip also checks that the release row and every version row exist, so a dropped row can never sit behind a live pointer. The `OR live_release_id=:new` term makes a re-sent batch an idempotent success. This covers HEAD's `lib/db.js` retry.
2. **Reconcile has three outcomes.** On any thrown error, `commitPublishBatch` re-reads the pointer and its list:
   - `{ok}` when the pointer is `:new`, or the list already holds this build's version ids.
   - `{lost, pointer, list}` when the pointer moved, or the error was `SQLITE_BUSY` or "database is locked" and the pointer is not `:new`.
   - `{unknown}` when the re-read itself fails. The service then answers 503 "Your publish may have gone live. Reload to check." It never rebuilds or answers 409 on `{unknown}`.

   This covers HEAD's retry policy and the stricter no-retry policy on the unmerged `claude/gallant-keller-7d3213` branch. The raw-client variant of the test mirrors that branch.
3. **The proof runs on a real local sqld through `lib/db.js`, behind a new Hrana fault proxy.**
   - The proxy counts **pipeline requests only** (`/v2|/v3/pipeline`). It never counts the version probe.
   - `commit_then_drop` forwards the request, waits for the full upstream answer, then destroys the client socket **before writing any response byte**. That gives an error that `isTransient()` retries on HEAD. The test asserts that the proxy saw 2 batch requests.
   - `hold` only orders requests. True server-side concurrency comes from a second raw connection that holds an open `transaction("write")` while the publish batch is sent (case **busy**).
4. **The version gate ships in batch 1, before any v4 writer exists.**
   - v1, v2 and v3 go to the legacy reader.
   - v4 fails closed until the new reader lands.
   - Anything else is an error.

   **Scope of the claim:** the gate protects deploy rollbacks only back to P2-VGATE. A rollback to `a6d028e` or earlier while any v4 pointer exists still renders the silent empty default site. This is recorded as deploy rule DR-1 and an owner check.
5. **The pointer and release are read in one LEFT JOIN** for every version. On v4, the layout plus a page costs 3 content statements: the pointer and list, the chrome versions in one `id IN (…)`, and the route's own version. The 3 holds only when `cache()` dedupes per request. Section 3 says how this is tested.
6. **The new registry is a new module, `lib/registry/`.** The legacy `lib/cms/registry.js`, `validate.js`, `schemas.js` and kind lists stay on the legacy path. `test-sections` does not change.
7. **The body shape gains document-level `settings`** for singletons: header, footer, announcement, design, cart and layouts.
8. **`doc_design` is a thin document type.** Its body is `settings: {brand, theme}`, validated by `validateBrand` and `checkBrand`. The brand and theme routes, the logo and the console editor move at TOK-03. In documents mode those routes refuse.
9. **The v4 reader serves neutral empties for product overrides, collection pins and PDP pairs** until OVL lands. They never fall back to legacy tables. `product_content` can be stored, but publishing it is refused (`PUBLISH_NOT_AVAILABLE`) until OVL-02. **Cutover gate addition:** OVL-01 and OVL-02 must land before MIG-01..04 move any real tenant.
10. **Ids.**
    - Singletons get deterministic ids: `doc_<type>`.
    - **Editor-created route documents** (page, campaign, journal) get random ids: `doc_` plus 16 base32 characters from Web Crypto.
    - Deterministic slug-hash ids are kept only for the backfill (MIG-01). Phase 2 ships them in `ids.js` as a pure function and tests them for determinism.
    - Slug uniqueness among live drafts comes from the `documents_slug` partial unique index (`WHERE slug IS NOT NULL AND archived_at IS NULL`). A slug collision on create or save maps to **409 `SLUG_TAKEN`**, with a plain message naming the other page. It is never a 5xx.
    - Two racing creates at one slug give one success and one 409.
    - Swapping two slugs takes three saves (one through a temporary slug). Publish also checks slug uniqueness against the resulting list plus the journal index. The one-step swap is a DOC-10 limit.
11. **`emptyList(m)` carries an explicit `null` (code default) for every registered singleton**, and `setEntries` keeps those nulls. A first publish of a single document can therefore never make a missing singleton an error.
12. **Legacy writers pre-check the mode with a fresh `cms_state` read.** The same-statement check waits for MIG-03 (known limit).
13. **The documents API writes and publishes only when `cms_state.mode = 'documents'`.** Legacy tenants get 409 `STORE_USES_LEGACY`.
14. **The test scaffold: P2-ATOM pre-registers every phase-2 suite in `package.json`.** These are the placeholders and their owners:

    | Suite | Owner |
    |---|---|
    | `test-publish` | P2-ATOM, real |
    | `test-registry-contract` | P2-REG |
    | `test-documents` | P2-DOCS |
    | `test-release-readers` | P2-READ |
    | `test-publish-service` | P2-PUBLISH |
    | `test-writers` | P2-WRITERS |
    | `test-preview-overlay` | P2-PREVIEW |
    | `test-sections-render` | P2-SECTIONS |
    | `test-perf-docs` | P2-PERF |

    Each placeholder prints `pending: owned by cms/p2-<id>` and exits 0. No other item edits `package.json`. Drills are not gate suites; they run through `scripts/drill.js` and its existing `drill:*` scripts. P2-DRILLS adds no `package.json` entry. It is invoked with `node scripts/drills/p2/run.mjs`.
15. **`cms_state` reads.** A missing table means legacy. **Any other read error fails closed** (`ContentUnavailableError`) on the shopper path. It never takes the legacy draft path. `lib/cms-mode.js` is edge-safe.

## 1. Batches (one owner per file per batch)

### Batch 1: prove atomic publish, and make v4 rows safe to exist

**P2-ATOM** (`cms/p2-atom`) — gate: batch 2 must not start until `pnpm test:publish` passes on sqld.
- Migration 0021: `documents` (with the `documents_slug` partial unique index on the draft slug), `document_versions` with frozen triggers, `publish_log` and `cms_state` seeded `legacy`.
- `ids.js`: random route ids, `doc_<type>` singletons, and the deterministic backfill helper.
- `release-list.js`: `emptyList` with singleton nulls, `setEntries`, list hash.
- `commit.js`: decisions 1 and 2.
- `scripts/support/hrana-fault-proxy.js`: decision 3.
- `test-publish`, run on `file:` and on sqld through `lib/db.js`, plus the raw client.
- The placeholder suites.
- The sqld install step in `.github/workflows/test.yml`: a pinned libsql-server release, with its checksum verified.
- `EXPORT_TABLES` gains `documents`, `document_versions`, `publish_log` and `cms_state`. A table missing at 0020 is skipped.

**P2-VGATE** (`cms/p2-vgate`)
- The version gate.
- The one-query pointer and release read.
- `listReleases` hides lost-race rows only when the row is not the live pointer.
- Neutral chrome on `ContentUnavailableError`: nav `[]` (so no collections scroller), announcement off, no tenant brand, no default nav. The maintenance branch catch at `layout.js:212` does the same.
- A shared test helper, `scripts/support/request-cache.js`: a `react` `cache` stub installed through registerHooks that memoizes per simulated request.

### Batch 2: registry, and side-by-side guards

**P2-REG** (`cms/p2-reg`)
- The registry engine and its declarations, including `maxBeforeProtected` on `product_layout`.
- Typed-link validation: links that are not storefront routes are refused.
- Draft and publish validation.
- Sanitize helpers that never lose words.
- Id-stripped hashing.
- Legacy adapters that never drop a legacy field that fails validation. Validation reports the field and the value is kept.
- `worstCase(kind)` fixtures for the drills.

**P2-GUARD** (`cms/p2-guard`)
- `lib/cms-mode.js`, edge-safe.
- Route-level `assertLegacyContentWrites` on **every** legacy and bypass writer:
  - `cms-api` (save, reset and delete for blocks and pages, templates);
  - catalog POST;
  - upsells POST, and `upsells/[id]` PUT and DELETE;
  - brand PUT and reset;
  - theme POST (`applyKit`);
  - experiments POST (adopt);
  - insights POST (apply);
  - partners POST (agency apply).
- `/api/admin/releases` in documents mode: publish, schedule, rollback, cancel, **preview and approve** return 409 pointing to the editor. Preview and approve would otherwise mint legacy tokens or approve meaningless legacy snapshots.
- Legacy `createRelease`: the INSERT of the release row, the guarded flip, the abort and the stamp run as **one batch**, so a lost race leaves no orphan.
- `rollbackRelease` and `publishReleaseById` refuse v4 targets and documents mode.
- The scheduled job, on losing the compare-and-set for a legacy target, re-reads the pointer and retries the flip up to 3 times. This keeps the rule that the scheduled release wins at time T.
- The admin `getLiveRelease()` returns `{id, v:4, documents:true, content:null}` for v4 rows. These consumers handle it with a plain "This store publishes with the new editor" message: `releaseDiff`, `validateRelease`/`liveContentForCheck`, `brandReadability`, the console storefront, releases and badge pages, and the platform overview.
- The documents-mode console badge.

### Batch 3: the document service and the v4 reader

**P2-DOCS** (`cms/p2-docs`)
- The write service.
- The documents API.
- Mapping of `SLUG_TAKEN`.
- `listVersions` with plain names, through a new `teamMemberNames(tenantId)` in `lib/platform/identity.js`.
- **`mediaUsage` and `deleteMedia` also scan `documents.draft` and `document_versions.body`.** Hits are labelled live, draft or older version, and deleting media still in use is refused.
- Failure-matrix rows.

**P2-READ** (`cms/p2-read`)
- Frozen `legacy-release.js`.
- An edge-safe `documents-reader.js`.
- v4 branches in all 17 getters.
- A **split page index**: `resolvedContentPageList()` returns `list.pages` only (the chrome, footer and checkout use it, and never load the journal index). A new `resolvedJournalEntries()` reads the `indexes.journal` version once. The index entries carry title, description, enabled, family, `effective_at`, `window_start` and `window_end`, so `campaignVisible()` runs without bodies.
- `app/sitemap.js` and `app/(storefront)/journal/page.js` change to call `resolvedJournalEntries()`. On legacy that getter runs today's per-post loop, so the output is unchanged.
- `resolvedHomePage()`, which keeps the S59 candidate overlay, experiments and `healHomeSections`.
- A missing listed version gets **one** re-read before failing closed, against replica lag.

### Batch 4: publish, bypass writers, overlay preview (no shared files)

**P2-PUBLISH** (`cms/p2-publish`)
- `publish` and `publishSet` on the proven commit. Service cases go in their own suite, `test-publish-service`.
- `{lost}` causes a rebuild, up to 3 times. `{unknown}` gives 503.
- A `SQLITE_BUSY` storm ends in 503 "Publishing is busy, try again in a moment".
- It is marked **partial** for PUB-03 (minimal inherited rule), PUB-05 (`publishSet`) and DOC-10 (slug checks).

**P2-WRITERS** (`cms/p2-writers`) owns all of `lib/experiments.js`, including the new `heroVariantSettings(settings, variant)` merge at the settings level through the adapter. It adds a mode-aware facade for the four bypass writers:
- **legacy:** revision, validation and history;
- **documents:** the documents service.

It replaces P2-GUARD's route-level refusals on those four routes with the facade. It also adds the grep guard.

**P2-PREVIEW** (`cms/p2-preview`) owns `lib/content/resolve.js` and `documents-reader.js` in this batch.
- Migration 0022 `preview_sessions`.
- A sid token (`p.<exp>.<sid>.<hmac>`); the old format is still parsed.
- **Overlay on the v4 live list, or on `emptyList(m)` when the tenant has never published.**
- The other-tab note.
- The "Your new colours are not shown here. Show them" toggle, a session flag that adds `doc_design` to the overlay.
- Its own route, `app/api/admin/preview-session/route.js`.
- In documents mode, an old-format token gives **no** overlay (live only). In legacy mode it works as today.
- `product_content` drafts are not previewable until OVL-02. This is narrowed and recorded.

### Batch 5: section rendering and measurement

**P2-SECTIONS** (`cms/p2-sections`, was P2-HERO)
- `components/sections/index.js` renderer map.
- `HeroSection` with an image.
- `HomeSections` **and `ContentPage`** render through the map. Every section root carries `data-section-id` and `data-section-kind`.
- The home page comes from `resolvedHomePage()` plus `heroVariantSettings`.
- The DOC-03 shopper state table is built and given rendered tests.
- **Rendered-HTML equivalence for legacy is checked against `a6d028e`.**

**P2-PERF** (`cms/p2-perf`)
- The documents fixture builder.
- `test-perf-docs`, with the request-cache stub.
- `perf-dbcount` runs through real Next for:
  - home, policy and checkout, at 0, 200 and 1,000 posts;
  - the **sitemap route itself**;
  - `/journal`.
- Local before-and-after numbers. Every pre-first-publish legacy tenant now makes one extra `cms_state` read, and that is reported.

### Batch 6: browser drills

**P2-DRILLS** (`cms/p2-drills`)
- A documents-mode harness seed.
- **Every registered section kind at 375, 768 and 1440 wide, against its `worstCase(kind)` fixture**: a 120-character title, long names, no image, a tall image, one item, the maximum number of items, and sold out.
- The hero image.
- A policy typo published while the home draft is dirty and incomplete.
- The preview overlay, including before the first publish and the colours toggle.
- Error-page chrome.
- The edge runtime header.
- Legacy smoke and edge drills.

## 2. Where the spec is wrong or stale (to correct in the spec)

- **8.2:** the next free migration is 0021, not 0018. The "Added columns" already landed in 0018 and 0019. `documents_slug` is a unique index on the *draft* slug. It is mapped to 409 `SLUG_TAKEN`, so a one-step slug swap is not possible (DOC-10 limit).
- **8.3:** "route ids deterministic from slug" applies to the backfill only. Editor-created ids are random, because otherwise a renamed or archived slug could never be reused. `config.site.logo` (`text1`, `text2`) has no document type; it is decided at TOK-03.
- **8.6 step 6 (`INSERT OR IGNORE`):** this is unsafe in SQLite, because it also ignores NOT NULL and CHECK failures. Use `ON CONFLICT(id) DO NOTHING`, plus a flip guard that requires the rows to exist. The per-statement subselect guards are replaced by guard-and-abort.
- **8.6, 8.15 and PUB-02 evidence:** "no `.batch(`" is stale. `lib/sync.js` already batches, but that is proven on the file client only. The `lib/db.js` retry policy differs between HEAD and gallant-keller, and both are tested.
- **8.7:** `cms_state` is read only when the state is `none`. The budget is 3 statements against 2 today, and it holds only through per-request `cache()`. A route handler's `cache()` is a no-op, so `/api/upsell`, offline and manifest pay the extra reads until PERF-03. The page index is split from the journal index.
- **8.8:** old-format tokens on documents tenants get no overlay. `product_content` preview waits for OVL-02.
- **8.11:** provisioning stays `legacy` in phase 2. The mode check is a pre-check; MIG-03 must tighten it. Export must include the document tables.
- **8.12:** the code accepts unknown versions; this is fixed by P2-VGATE. A rollback past VGATE is unsafe (DR-1).
- **Section 11 cutover gate:** add "OVL-01 and OVL-02 before MIG-01..04 move any real tenant", and "fleet scan of live `content.v` before the VGATE deploy".
- **8.15:** the JSX runner is still the SWC `registerHooks` stopgap. React `cache()` does not memoize outside RSC, so unit query counts need the request-cache stub. `test-sections` does not change in phase 2.
- **Migration 0007 and `lib/releases.js` comments ("one atomic UPDATE"):** these are wrong and are fixed by P2-GUARD.
- **DOC-02 legacy:** `resetBlock` and `deletePage` stay revision-less. This is recorded for MIG-03 and ED-05.

## 3. Constraints every builder must respect

- **Edge runtime.** No `node:` imports in `lib/registry/*`, `lib/content/*`, `lib/documents/{ids,release-list}.js` or `lib/cms-mode.js`. Use Web Crypto. Writes run only on Node console routes.
- **Environment variables and identifiers.** Add no env vars in app, lib or components. Don't use "mutation" in identifiers.
- **Migrations.** Use `IF NOT EXISTS` only. Never edit a migration that has run. A missing `cms_state` table means legacy, and a missing `preview_sessions` table means no overlay. Run `tenant:migrate --all --check` before the code that needs it deploys. Re-seed the harness after each migration.
- **Never write content back to Shopify.** Price, variants and inventory stay Shopify-owned.
- **Query-count tests.** Unit tests use `scripts/support/request-cache.js` (one memo per simulated request) and assert per-request counts with an execute counter. Real-Next counts come from P2-PERF's `perf-dbcount` runs. A test may not claim a per-request count without the stub.
- **Suite time.** Every suite stays under the 2-minute `SUITE_TIMEOUT_MS`. Each packet records its measured time.
- **Drills.** Agents use their own `DESIGN_PORT` and `DESIGN_SQLD_PORT`, never 3017. Re-seed between state-changing drills.
- **Owner checks.** These go in each item's packet, and the orchestrator merges them into `MANUAL-CHECKS.md`:
  - **DR-1:** never roll back past the P2-VGATE deploy while any v4 pointer exists.
  - **DR-2:** before VGATE deploys, scan the fleet: `SELECT DISTINCT json_extract(r.content,'$.v') FROM release_state s JOIN releases r ON r.id=s.live_release_id` on every tenant, and confirm the only values are 1, 2 or 3.
  - **DR-3:** run migrations 0021 and 0022 before the code that needs them.
  - Hosted Turso: one publish, a concurrent publish, `BEGIN IMMEDIATE` contention, and replica read consistency on a staging tenant.
  - The `doc_cart` capability ruling (`upsells.write` versus `storefront.*`).
  - Hosted perf numbers (OQ-19).
  - Restoring an export of a documents-mode tenant (the restore side, DOC-12).

## 4. Requirements only partly provable in phase 2 (recorded, not claimed as passes)

| Requirement | What phase 2 proves | What waits, and for which item |
|---|---|---|
| DOC-07 | A hero image can be added through the API or a fixture | The editor UI (ED-02). The variant translation of a running experiment at cutover (MIG). |
| PV-03 | Previews of every type through fixtures, except `product_content` | `product_content` (OVL-02) |
| DOC-05 | Incomplete sections do not block other publishes | "Cannot be published through schedule" (PUB-07, since document schedules do not exist yet) |
| DOC-08 | Pruning is safe against publish_log and release lists | Pruning against pending schedules (PUB-07) |
| DOC-01 | Ids are deterministic (`ids.js`) | "Backfill twice gives the same ids" (MIG-01) |
| DOC-02 | The API half of a 409 | "The text stays in the editor" (ED-02) |
| DOC-03 | Validation refuses a second or out-of-position hero | Refusal at add and move (ED-02) |
| ED-03 | — | Autosave between read and commit makes publish lose (409 after 3 rebuilds) and can starve it |

## 5. How each mustFix was answered

**Critic 1**
1. **`INSERT OR IGNORE` hides NOT NULL and CHECK failures.** *Accepted.* All inserts use `ON CONFLICT(id) DO NOTHING`, and the flip requires `EXISTS(release with this hash)` and the right count of this build's version rows (decision 1). New P2-ATOM acceptance: a null body or a null hash makes the batch fail with nothing written and the pointer unchanged.
2. **A first publish takes the store down.** *Accepted.* `emptyList(m)` holds an explicit `null` for every registered singleton, and `setEntries` keeps those nulls (decision 11). Acceptance in P2-ATOM (pure) and P2-PUBLISH: after the first publish of one policy page, every other getter returns its code default and nothing errors.
3. **`mediaUsage` misses documents.** *Accepted,* in P2-DOCS. `lib/media.js` scans `documents.draft` and `document_versions.body`, labels each hit, and `deleteMedia` refuses media that is in use. Tested in `test-documents`.
4. **Slug-hash route ids collide.** *Accepted.* Editor-created route ids are random, and slug uniqueness comes from the partial unique index, mapped to 409 `SLUG_TAKEN` (decision 10). The racing-create acceptance still holds through the index. New acceptance: rename "about" to "about-us", then create "about" (200). Archive a page, then create at its slug (200).

**Critic 2**
1. **The scaffold contradicts the gate.** *Accepted.* All nine suites are pre-registered by P2-ATOM, each with one owner (decision 14). Drills are not gate suites.
2. **Batch 4 shares files.** *Accepted.* P2-WRITERS owns `lib/experiments.js`, including the settings-level merge. P2-PREVIEW owns `resolve.js` and `documents-reader.js` in batch 4. P2-SECTIONS moves to batch 5 and edits neither file.
3. **Sitemap and journal reads can't be met inside P2-READ's files.** *Accepted.* P2-READ owns `app/sitemap.js` and `journal/page.js` and adds `resolvedJournalEntries()`, backed by an index carrying the visibility fields. `journal/[slug]` reads only its own version (one read is correct there).
4. **React `cache()` is a no-op in unit tests.** *Accepted.* There is a per-request cache stub (`scripts/support/request-cache.js`, from P2-VGATE), and real-Next counts come from P2-PERF. The constraint is added in section 3.
5. **P2-GUARD does not cover every writer.** *Accepted.* `upsells/[id]` PUT and DELETE, theme **POST**, and the experiments, insights and partners POST routes are guarded at route level from batch 2. P2-WRITERS later swaps them for the facade.
6. **Deterministic route ids.** Same answer as critic 1 item 4.
7. **The slug-swap acceptance can't be reached.** *Accepted.* The swap acceptance is dropped (DOC-10 limit). A save or create collision gives 409 `SLUG_TAKEN` naming the other page, never a 5xx. Publish still checks uniqueness against the list.

**Critic 3**
1. **The journal index is on every page.** *Accepted.* The getter is split. The chrome, footer and checkout read `list.pages` only. The acceptance calls the real `chromeData` and the real checkout `policyLinks`, and checks the statement count and that the read size does not change between 0 and 1,000 posts.
2. **The sitemap reads every post.** *Accepted.* Same answer as critic 2 item 3. `perf-dbcount` measures the sitemap route itself (P2-PERF), and a unit test imports `app/sitemap.js` under the request stub.
3. **DOC-03 state-table rendered tests are missing.** *Accepted,* in P2-SECTIONS (`test-sections-render`). Each row has a rendered test:
   - sold-out rail: labelled, sorted last unless hand-picked;
   - rail below `minItems`: hidden, no empty slots;
   - rail bound to an empty collection: hidden;
   - missing image: token fallback;
   - hero button linked to a sold-out product: the spec's row;
   - page with no sections: neutral message plus a link to collections.
4. **PV-03 has no preview before the first publish, and no `product_content` preview.** *Partly accepted.* Overlay on `emptyList(m)` is defined and tested for tenants that have never published. `product_content` is narrowed and recorded until OVL-02, because the reader has no product-content path to overlay.
5. **PV-03 negatives are untested.** *Accepted,* in `test-preview-overlay`:
   - no cookie: live only;
   - a tampered HMAC is refused;
   - an expired or revoked session is refused;
   - a token from tenant A on tenant B is refused;
   - an old-format token on a documents tenant gives no overlay;
   - an old-format token on a legacy tenant works as today;
   - failure rows: a `preview_sessions` read error means no overlay plus a logged error, and a write error gives 5xx.

**shouldFix taken:**
- reconcile `{unknown}`;
- the real-concurrency busy case;
- the proxy counts pipeline requests and closes the socket before sending bytes;
- restated rollback claim (DR-1) and fleet scan (DR-2);
- admin `getLiveRelease` v4 marker;
- `listReleases` keeps the live row;
- scheduled publish retries;
- legacy INSERT inside the batch;
- legacy preview and approve refused in documents mode;
- `cms_state` errors fail closed;
- legacy home-page equivalence against `a6d028e`;
- export tables;
- CI sqld;
- service cases in their own suite;
- `cms-mode` edge-safe, with the extra read reported;
- team-names helper;
- precise neutral chrome;
- the partial-requirement table;
- `test-schema-compat` 0020 constants (P2-READ rebases on P2-GUARD);
- the autosave-starvation limit;
- typed-link checks and `data-section-*` attributes in the contract test;
- the worst-case drill per section;
- DOC-05 incomplete preview and publish of others;
- DOC-08 restore-then-publish, `undo_saved` listed, pruning safe against release lists;
- the "Show them" toggle;
- footer and checkout read no bodies;
- `maxBeforeProtected`;
- the partial markings on P2-PUBLISH;
- one re-read for replica lag;
- the OVL-before-MIG gate.

**Uncovered points:**
- Replica consistency: one re-read, plus an owner check.
- Hosted Turso: an owner check.
- OVL before MIG: in the cutover gate.
- Old tokens: no overlay in documents mode.
- Bypass writers in batches 2 and 3: guarded at route level by P2-GUARD.
- The gallant-keller policy: mirrored by the raw-client variant. The branch itself is not inspected.
## 6. Updates after batch 2 (binding on later items)

- `commitPublishBatch` now has four outcomes: `{ok}`, `{lost}`, `{unknown}` and `{failed, code}`. The `failed` codes are listed in docs/cms-reviews/P2-HARDEN.md. P2-PUBLISH maps `failed` to a 5xx (or a plain refusal for `MISSING_DOCUMENT`: "This page was deleted while you were publishing. Reload to see the current pages."). It never maps it to 409 "someone else published". It also wraps the call in a try and treats any throw as `failed`, never as `lost`.
- Release ids and published version ids are always minted fresh for each build. A publish never reuses a checkpoint or any existing version id, and never pre-inserts a release row before its flip (this keeps reconcile's `oursPresent` rule true). Restore followed by publish writes a new published version row.
- At cutover (MIG-03), cancel any pending legacy `publish_release` jobs for the tenant; otherwise they dead-letter with a critical alert.
- The legacy preview path in `/api/admin/releases` falls back to legacy when the mode can't be read; P2-PREVIEW must ignore legacy preview tokens on documents-mode stores.
- (After batch 3) Gates before any store publishes v4 for real, owned by P2-SECTIONS: `app/(storefront)/page.js` moves to `resolvedHomePage()` (today a v4 home with its hero hidden makes `resolvedHero()` null and the page 500s); the home rails' `collection_overrides` read in `lib/cms/section-data.js` must not run on v4 (plan decision 9: neutral empties until OVL).
- (After batch 3) P2-PERF reports the extra `cms_state` statement on legacy stores with no release, and the journal-index read that a v4 request for an unlisted slug (default policy pages, 404s) costs.
- (After batch 3) The editor UI work shows media usage with `u.name` and `u.label`, not the raw `u.where`.
