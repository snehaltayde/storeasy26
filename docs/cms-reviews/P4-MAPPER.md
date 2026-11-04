# P4 · MAPPER · The legacy store as documents, and a read-only dry run

Branch `cms/p4-mapper`, cut from `17a08b7` (`cms/phase-1` with batch 1 merged). Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 7, 8 and 12, sections 0 to 3, batch 2) and `P4-BATCHES.json`. Requirements: MIG-01 (the mapper and the dry run), MIG-02 (the in-process data check, non-entity part) and DOC-03 (merged kind names in every body).

Files: `lib/migrate/map.js`, `lib/migrate/ids.js`, `lib/migrate/state.js`, `lib/migrate/report.js`, `lib/migrate/check.js`, `lib/migrate/map-entities.js` (a stub for P4-OVL07), `scripts/migrate-documents.js` (replaces SCAFFOLD's stub), `scripts/test-migrate-map.js` (replaces SCAFFOLD's placeholder; no `package.json` change), this packet. No migration. No file outside this list changed. No P3-FIX5 file, no `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `.github/`, `MANUAL-CHECKS.md` or untracked `docs/CMS_*.md` file was touched.

**It writes nothing.** Every database call in `lib/migrate/*` is a SELECT. The suite checks that the tenant's database file is byte-identical before and after both the in-process mapping and the command.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 161.9 s (final run). `test:migrate-map`: 47 passed in about 10 to 15 s. `pnpm build` passes |
| Browser verified | Not applicable. Nothing a shopper or founder sees in the browser changed: the work is a command-line dry run and library code no route imports. No dev server ran; port 6140 and 7140 to 7149 were not used |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. A real dry run on a real store is an owner step (Owner checks) |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

Before a store can move to the new editor (P4-CUTOVER, batch 5), we need to know, without touching it, exactly what the move would write and whether shoppers would see any difference. This item builds that:

1. **The mapper** (`map.js`): every legacy row becomes the spec 8.3 document it belongs to, with content-addressed version ids and the v4 release list a cutover would put live. The draft side comes from the draft tables; the published side from the live release (spec 8.11 table). Nothing new is published: a draft that differs from what is live stays a draft.
2. **The state** (`state.js`): which 8.11 row the store is in. A store with no release is never guessed: the operator says `--store-open` or `--not-launched`.
3. **The data check** (`check.js`): every non-entity `resolved*` getter is run against the legacy store and against the mapped candidate (P4-SEAM's `candidateSource`, versions held in memory), and the answers are compared.
4. **The report** (`report.js`) and **the command** (`scripts/migrate-documents.js --dry-run`): a plain report a founder can act on, the developer detail below a "Details" line, and a digest P4-CUTOVER will require.

## Design

### `lib/migrate/ids.js` (Web Crypto, all async)

- `migratedVersion(documentId, body)` gives `{ id, bodyHash }`: `ver_` plus the first 16 hex of sha256(documentId + bodyHash(body)). `bodyHash` is the canonical body with ids kept (`document_versions.body_hash`, and what a list entry's `hash` holds, as `makeBuild` writes it). The same id always means the same body of the same document, so a re-run or a rehearsal mints the same ids and `ON CONFLICT(id) DO NOTHING` is exact.
- `migratedReleaseId(list)` gives `rel_mig_` plus 16 hex of the list's release hash.
- `draftHash` and `publishedHash` are `documentHash` (ids stripped), the rule `documents.draft_hash` and `published_hash` already follow. So a store whose drafts equal what is live has no dirty document, even where an old live snapshot had no section ids.

### `lib/migrate/state.js`

`classifyState({ mode, live, pendingSchedules, storeOpen })` gives `{ state, published, refusals, notes }`, with `published` one of `release` (v2, v3), `release+tables` (v1: the release plus the live tables for what v1 never froze), `drafts` (no release, open), `none` (no release, not launched) or `null` (refused). Refused: a pending schedule (first, after the mode), a live read error, a store already in documents mode or migrating, a live v4 release on a legacy store, and a store with no release and no flag (`needs --store-open or --not-launched`). A flag on a store that has a release is noted and ignored. `readTenantState()` reads the mode, the live release (`getLiveReleaseState`) and the pending schedules (a release with `scheduled_for` and no `published_at`, other than the live one).

### `lib/migrate/map.js`

`readLegacySource({ platform })` reads, in the tenant's context: `cms_blocks`, `cms_pages`, `page_redirects`, `placements`, `product_overrides`, `collection_overrides`, `cms_templates`, `cms_approvals`, `cms_state`, `release_state` and the live release, the existing `documents` rows, `product_content_live` and `collection_content_live`, the pending schedules, the draft design (through `kits.js` `draftDesignOf`, the one place allowed to read the brand from tenant config), agency grants from the control plane (`status = 'accepted'` for this store), and the catalog handles of the cart offer's products. A missing table reads as empty.

`mapLegacy(source, { storeOpen, editability, entities })` maps both sides with the same functions:

| Legacy | Document | Notes |
|---|---|---|
| `announcement` | `doc_announcement` | No row is the code default (null). A stored empty bar is a body |
| `nav_header`, `nav_footer` (+ `surface_templates.header` / `.footer`) | `doc_header`, `doc_footer` | null (or not a list) is `{mode: "auto"}`, `[]` is `{mode: "custom", items: []}`, no row and no template is null. An item's href becomes a typed link; a hidden item is carried. No template is stored when none was, so the platform default still applies and still reports itself as the platform's |
| `hero`, `home_sections` | `doc_home` | Neither row: null. One half stored: the other half is materialized. The hero is section 0 (`sec_hero`) |
| `collections_index` | `doc_collections_index` | handles become `{handle, id?}` from the ids sidecar |
| `pdp_extras` (+ `surface_templates.pdp`) | `doc_product_layout` | the product module first (`sec_productmain`), then one rich text section per accordion, hidden ones carried hidden |
| `surface_templates.collection` | `doc_collection_layout` | |
| `brand`, `theme` | `doc_design` | the release's on the published side; the draft design on the draft side. A store open with no release whose brand would not pass a publish shows shoppers the default look today (`resolvedBrand`), so the published design holds no brand and the founder's brand stays a draft |
| `placements` kind `cart_upsell` | `doc_cart` | only when `cartEditable()`. The enabled offers in position order, their products merged, the first offer's title (null becomes the default words). Later offers' titles never showed and are listed in the report |
| `cms_pages` | `doc_p_<hash of slug>` (`backfillRouteId`) | by family: page (policies included), campaign, journal. Journal posts are listed through a generated journal index version, as `makeBuild` does. Page sections go through the merged names |
| `page_redirects` (v2+: the release's own) | the target page's `meta.redirect_from` | else reported unresolved |
| `surface_templates.products` / `.collections`, `product_overrides`, `collection_overrides`, `pdp_pairs` | product and collection content | `map-entities.js`, a stub until P4-OVL07 |

The traps (spec 8.11):

- **null, [] and absent** stay distinct (header, footer, announcement).
- **An empty `home_sections`** reads as the default sections today, so they are materialized (`sec_defcollect`, `sec_defnew`).
- **Home sections with no id** get `sec_l<n>`, where n is the section's place among the sections shoppers see: the id `resolvedHomePage` gives it today, whose old data-sec key was `i-<n>` (same n; the suite checks both against the old home page). A hidden one gets `sec_lh<n>` (its stored place), so it can't take a shown one's id. A section of a kind the old home page never showed is left out of the body and listed in the report with its stored value; the old row keeps it.
- **Page sections**: no kind becomes text, no id becomes `sec_l<i>`, `rich` and `image` take the merged names and `heading` becomes `title` (`legacyPageSectionsToSections`).
- **Code-default pages** (`_default` and BeastLife) get no document. The reader still serves them from code (`usesCodeDefaults`), so they keep rendering; a row that overrides one is a document.
- **Half-customized home and `{store_name}`.** A stored hero keeps exactly the fields it has. The materialized default hero stores its subtitle and buttons, and **no title or highlight**: `heroFromSection` and the home page's `heroWithDefaults` fill any hero field a body lacks from `defaultHero(siteName())`, so the title stays "Shop <store name>." and follows a rename. That is how the binding is stored: as "no title of its own". A literal `{store_name}` token would print as is, because nothing in the reader fills one (see Known limits). The suite renames the store and the migrated hero follows.
- **An unmatched highlight** is carried (a warning, never a block).
- **Stored payloads** (experiment variants, AI proposals, agency kits) are not read or rewritten.
- **Values over a limit or failing strict checks** are carried exactly as stored (a 250-character bar, a 130-character title, an off-store link, an unknown field) and reported per document.

When only the live side holds a singleton, the draft is the code default as a body (the default home, an automatic menu, an empty cart, no design). The collections page has no such body ("follow the catalog"), so its draft stays what is live and the report says so. A page deleted in the drafts but still live stays live (its draft is the live page), and the report says so in plain words.

Output: `{ state, documents, list, bodies, liveRows, refs, report, sourceHash, releaseId, entities }`. `list` is the v4 list (with `m`) built with `emptyList` and `setEntries` as a publish builds it, posts removed from `documents`; null when nothing is published (not launched, or refused). `bodies` maps every listed version (the journal index and posts included) to `{ document_id, body, schema_version }`. `refs` are `refRows` of every published version. `sourceHash` is sha256 of the canonical JSON of every source row read (all the tables above, the existing documents and live rows, the design, the agency grants, the mode and the live pointer), the catalog left out because it is Shopify's.

The report facts: refusals (the state's, approvals in use, agency access or an agency read that failed, types holding content without an editor, entity content while the entity part is a stub, slug collisions), the reconcile report, strict validation per document (publish mode, plus what would stop a draft save), unresolved redirects, left-out values, saved templates per family, code-default pages, and estimated statement counts.

**Reconcile** (read-only): each mapped document's existing row by id, and whether its draft differs (it will be kept as a version); every existing product and collection content row with the deterministic id it stands in for (a phase-3 random id is reused, never duplicated; the map is handed to the entity part); a non-archived row of another id holding a mapped slug (a refusal); the existing live rows.

**Editability**: `typeHasEditor(type)` for every type holding content, and for the cart `cartEditable()` is checked by the mapper itself (`typeHasEditor("cart")` is true whatever the ruling). With the ruling off, no cart document is mapped and a store with a cart offer is refused.

### `lib/migrate/map-entities.js` (stub)

`mapEntities(source, ctx)` returns `{ built: false, documents: [], bodies: new Map(), liveRows: { product: [], collection: [] }, refs: [], holds }`, where `holds` counts the entity content the store has (live tables and the release's frozen arrays). While `built` is false, a store with any entity content is refused ("can't be moved yet"), so the dry run never says "Ready to move" for content it can't carry. The contract is written at the top of the file for P4-OVL07.

### `lib/migrate/check.js`

`dataCheck(mapped, { routes })` runs, in the tenant's context, every route through `contentGettersFor(contentSource())` (the legacy store, as a shopper request outside any preview builds it) and through `contentGettersFor(candidateSource({ list, bodies, releaseId }))`, and lists every difference. `routesFor(source, extra)` gives every non-entity getter, every page slug the store holds or serves from code, every old address, and `extra` (the suite passes `allGetterRoutes()`, the routes `recordOutputs` records, and checks each non-entity one is covered). Entity routes (`resolvedProductOverride`, `resolvedCollectionPins`, `resolvedPdpPairs`, and a per-entity `resolvedSurfaceTemplateFor`) are skipped and counted, for P4-OVL07. A getter added to `resolve.js` later is compared too (an unbound one answers as a difference, never a pass).

The comparison is deep equality of the plain-JSON answers, except six differences no shopper sees, each named with its reason at the top of the file (P4-CUTOVER may move them into `allowed-differences.js`): a section's `id` and `legacyKey`; a field left out against `""`, `null` or `[]`, and `enabled` left out against `true`; `resolvedSurfaceTemplates` compared on the header and footer; `resolvedHomePage`'s hero compared as the home page renders it (`heroWithDefaults`); `resolvedContentPageList` compared on the fields its readers use, journal posts left out of both sides (the v4 list never carries them; a post whose address the checkout's policy links would pick is kept in); `resolvedJournalEntries` compared on the fields the journal list and sitemap read.

### `lib/migrate/report.js`

`buildReport(mapped, check)` gives the full JSON; `renderText(report, digest)` the plain output; `reportDigest(report)` sha256 of the report's canonical JSON. The plain output, in order:

1. the verdict: `Ready to move`, or `Not ready: N things to fix`, each fix in founder words with where to fix it;
2. What shoppers will see change (each data-check difference by page or part of the store; a not-launched store "stays closed until your first publish", expected, not a fix);
3. Unpublished changes that will carry over as drafts (by page, sorted by name; never-published ones marked; deleted-in-drafts pages said);
4. Drafts kept as older versions;
5. Things the new editor will flag (by page, with up to two of the editor's own messages);
6. Old addresses that couldn't be matched;
7. Saved templates (the count per family, and that they stay readable on ED05's saved templates page);
8. Team access that changes: from `roleAllows` over every role that had `upsells.write`. Today that is one line: "Staff can still change the cart offer, but an owner or admin has to publish it before shoppers see it."

Then `Details` (the state, refusal codes, the mapping with version ids, left-out values, notes, unresolved redirects, strict validation per document with codes and section counts, types without an editor, the reconcile report, the `cms_templates` count, code-default pages, the entity content counts, the data check, estimated backfill and flip statements), then `Dry-run digest: <hex>`. `--json` prints the same report with `digest` as its last key.

### `scripts/migrate-documents.js`

`--tenant X --dry-run [--json] [--store-open | --not-launched]`. Without `--dry-run` it refuses (the move itself is CUTOVER's). `_default` is the env store (`TURSO_DB_URL`, `DATABASE_URL`, else `file:local.db`). A database that is not a local file or on this machine (localhost, 127.0.0.1, [::1], for the harness's sqld) is refused unless `--hosted --confirm <the same id>`. No token is printed. Exit 0 with a report (ready or not), 1 on a refusal to run.

## Acceptance, with evidence

| # | Item | Status | Evidence (scripts/test-migrate-map.js; each fails without the change, see the mutation runs) |
|---|---|---|---|
| 1 | Every 8.11 state row and mapping trap maps as the spec says; "no release" without a flag is a refusal; `--store-open` publishes the drafts; `--not-launched` publishes none | **DONE** | Part 1: `classifyState` for every row, then `live_v1` (release plus the live tables: cart offer and redirect from the tables), `live_v2`/`live_v3` (frozen sets, v3 templates), `no_release_open` (every published hash equals its draft's), `no_release_not_launched` (no list, no version, every document a never-published draft), no flag (refusal with the exact words), `pending_schedule` and `live_read_error` (refused, no list). Part 2: one case per trap group (menus, bar, home sections and ids against the old home page's ids and `i-<n>` keys, page sections, code-default pages on `_default` and BeastLife, policies and journal, old addresses, the hero halves with a store rename, stored payloads untouched). The suite has no case before this item (it was a placeholder) |
| 2 | Mapping twice gives deep-equal output (ids, hashes, sourceHash); any legacy edit changes sourceHash | **DONE** | Part 3: two mappings of one store are deep-equal (documents, list, bodies, refs, report, source hash); version ids are recomputed from the bodies; six edits (a block, a page, a redirect, a cart offer, a product override, a saved template) each change the source hash |
| 3 | A draft that differs from the live release stays a draft (dirty); an unchanged tenant has 0 dirty documents | **DONE** | Part 4: on `live_v3` the home and About drafts are dirty, the list names the live versions and no listed body holds the draft words; a page deleted in the drafts stays live and is said. A `live_v3` store whose drafts equal the release (written in the test) and a store open with no release both map to 0 dirty documents |
| 4 | The candidate list parses through `parseList`, and for every non-entity getter the data check equals the legacy outputs on every fixture state, in-process, with no write | **DONE**, one stated exception | Part 5: 11 state cases (vgate v1, v2, v3 and open; home v1, v2, v3 and open; journal v3 and open; empty open), each `parseList`, every `allGetterRoutes()` non-entity route covered, database file hash unchanged. home, journal and empty: 0 differences. vgate: the only differences are the old addresses whose page isn't stored (`old-post`, a fixture row with no target page), which the mapper reports as unresolved, and the suite asserts exactly one difference per such address. Every trap: the same. Two more cases show the comparison isn't blind (a changed announcement in the candidate is caught; the comparison rules unit-tested) |
| 5 | The running hero experiment serves the same hero settings on the migrated home | **DONE** | Part 6: with the experiment running (and again with the half-customized home), a unit assigned to variant b by `heroVariantFor` gets, through `heroWithDefaults` and `heroVariantSettings`, the same title, highlight, subtitle and buttons on the legacy and the migrated home; the stored payload is byte-identical after mapping |
| 6 | The reconcile report finds the phase-3 random-id product row (reused) and the slug collision (refusal); over-limit values are carried verbatim with warnings | **DONE** | Part 7: `buildPhase3Leftovers` gives the product row with `reused: true` and its deterministic id, and the `about` collision with a `SLUG_COLLISION` refusal. `buildStaleBackfill`: home and About kept, newer legacy content in the draft, live rows listed. Over limits: a 250-character bar, an off-store link, an unknown field and a 130-character title are carried exactly, flagged (`TOO_LONG`, `LINK_NOT_STOREFRONT`, `UNKNOWN_FIELD`) and shown under the editor's flags |
| 7 | The dry run leaves the database byte-identical, prints the digest, reports the `cms_templates` count, unresolved redirects, cart/approval/schedule refusals and strict-validation counts, and refuses `libsql://` without `--hosted --confirm` | **DONE** (the cart refusal in-process) | Part 8: the command against a file tenant (file hash equal before and after, digest line last, 2 saved templates by family, `old-gone` unmatched, `APPROVALS_IN_USE`, strict validation of the header); a pending-schedule store through the command; the env store `_default`. A store registered at `libsql://…` is refused (exit 1, nothing printed), and `--confirm` alone too; no case passes `--hosted`. The cart refusal needs `cartEditable()` off, which only an in-process stub can do: part 12 |
| 8 | Snapshot: the plain output starts with the verdict, sections in order, nothing above "Details" that is a table name, error code, id or statement count; `--json` holds the full detail; one digest | **DONE** | Part 9: a ready store's plain report compared word for word; a not-ready store (approvals, agency, collision, unmatched address, cart offer) and a not-launched store checked against a pattern list (table names, codes, ids, gids, getter names, "statement", long hex) and for section order; the fix count equals the JSON's; the JSON has every detail key; the digest is the same with and without `--json` |
| 9 | "Team access that changes" names the staff role for the cart offer, from `roleAllows`, with a `cart_upsell` placement | **DONE** | Part 10: the role table as the plan cites it, the exact staff line, owners and admins not named, the line in its section, and no line for a store with no cart offer |
| 10 | DOC-03: every section of every mapped body is a merged, registered kind; no pre-merge name, on every state and trap | **DONE** | Part 11 walks every draft, published and listed body of every mapping the suite made (each state, each trap, all entity fixtures): registered, allowed on its type, not `rich`/`image`, no `heading`/`src` setting, a valid id (over 500 sections) |

After the SCAFFOLD review: part 12 registers a stub editable system type (no editor) next to an editable plain one (an editor), so the `t.system !== true` check is pinned, and shows `cartEditable()` checked by the mapper.

## Tests

- `scripts/test-migrate-map.js` (`pnpm test:migrate-map`): 47 cases in 12 parts, about 15 s. File databases only (`.test-mmap-*.db` at the checkout's root, removed at the end; none left behind). Tenants come from P4-FIXTURES' builders (`makeLegacyTenant`, `buildLegacyTenant`, `buildPhase3Leftovers`, `buildStaleBackfill`, `allGetterRoutes`). The command is run as a child process against the same files.
- Mutation runs (by hand, each reverted; the number of failing cases): ids by stored place instead of shown place (1); the default hero title stored as text (2); not launched publishing the drafts (3); a guessed "open" without a flag (2); a blind comparison (7); redirects not attached (1); the cart ruling ignored (1); a code above Details (2); the published side read from the drafts (13); one write to a legacy table during the mapping (11); a source hash without the rows (1); slug collisions ignored (1); the blocked-brand rule removed (1); `typeHasEditor`'s system check removed (1).
- Before this item the suite was SCAFFOLD's placeholder, so every acceptance case is new; the mutation runs show each fails without the code it covers.
- `pnpm test`: 96 of 96 suites passed in 161.9 s (final run before commit; an earlier run caught `test:design-doc`'s guard on a direct brand read, fixed by reading through `kits.js` `draftDesignOf`). `pnpm build` passes.

## Known limits

- **The entity part is a stub** (`map-entities.js`, P4-OVL07's in batch 3). Product and collection content documents, their live rows (P4-LIVEROW's `liveRowFor`) and the entity getters in the data check are not built. Until then the dry run refuses any store holding entity content ("can't be moved yet"). Every vgate and home fixture holds some, so only the journal and empty fixtures reach "Ready to move".
- **`{store_name}` is stored as "no title of its own"**, not as a token. The reader fills an absent hero title and highlight from the store name (`heroFromSection`, `heroWithDefaults`), which gives exactly today's words and follows a rename (tested). The cost: the new editor shows such a hero's title as missing (an "incomplete" note, listed under "Things the new editor will flag"), and publishing an unchanged hero only warns (the inherited rule). A real `{store_name}` token needs the reader to fill it; `resolve.js` and `documents-reader.js` are SEAM's, LIVEROW's and OVL07's, so that would need a named owner.
- **The data check's comparison rules live in `check.js`.** The plan puts allowed differences in `lib/migrate/allowed-differences.js`, which is CUTOVER's. The six rules are named at the top of `check.js` with their reasons; CUTOVER may move them.
- **Old addresses whose page isn't stored are reported, not carried.** A v4 redirect is owned by its target document, so one pointing at no page (or at a code-default page with no row, such as BeastLife's `terms`) can't be listed. Shoppers following it would land on a missing page instead of being sent on; the dry run says "Not ready" and names the address. The vgate fixture's `old-post` is one, so the vgate data checks show exactly that difference.
- **Unknown section kinds and non-object entries** are left out of the bodies (they were never shown) and listed in the report with their stored values. The old rows keep them.
- **A switched-off cart offer and the titles of later offers** are not carried (they never showed); listed in the report.
- **Pages whose family changed** between the release and the drafts keep the draft's type for the document and the release's for the published row (noted). Pages with an unknown family map as pages (noted).
- **The env store (`_default`) has no brand or theme**: its storefront reads none (no tenant config), so the mapper reads none.
- **Estimated statement counts** are a simple sum (documents, versions, refs, kept versions, live rows; 5 for the flip). CUTOVER owns the real batches.
- **The command accepts databases on this machine** (localhost, 127.0.0.1, [::1]) as well as `file:` ones, like `media:reindex`, so the harness's sqld works. Anything else needs `--hosted --confirm <id>`.
- **The operator command has no `--env-file`** (`package.json` is SCAFFOLD's, see P4-SCAFFOLD). For the owner's hosted dry run, `PLATFORM_DB_URL` and its token must be in the environment.
- **`--hosted` was never exercised.** Builders never pass it; the refusal without it is tested.

From review:

- Six mutations of safety lines survived the suite, so these behaviours are not pinned by any test (in each case the code is right today). (a) map.js buildFacts: `if (entityContent && !entities.built) refusals.push(...)` changed to `if (false)` leaves 47/47 passing. The 'Ready to move' wrongly given to a store with product or collection content would not be caught. By hand, a ready journal store plus one product_overrides row is refused as it should be. Add a case: a ready store plus one entity row gives ENTITY_CONTENT_NOT_MOVABLE. (b) report.js: `if (unexpected.length) fixes.push(...)` disabled. A data-check difference alone never has to make the verdict 'Not ready', because every fixture with a difference also has an unmatched-address fix. (c) The AGENCY_ACCESS refusal disabled. It works by hand with an accepted grant, but no case covers it. (d) sourceHash without `design`: a brand edit between rehearsal and cutover would leave sourceHash unchanged, and none of the six edits tested is a brand edit. (e) mapCart reading only the first offer's products: no fixture has two enabled cart offers. By hand, two offers merge in position order, the first one's '' title becomes the default, and the data check shows 0 differences. (f) An absent announcement mapped to a default body instead of null: the announcement half of the 'null vs [] vs absent' trap is not pinned (the header and footer halves are).
- ids.js: the 'ids stripped' rule for draft_hash and published_hash, and the documentId inside the version-id hash, are not proven. Using bodyHash (ids kept) for draftHash, or sha256(bodyHash) without the documentId, leaves the suite green. The 'recomputes the content-addressed ids' check calls migratedVersion itself, so it proves nothing. The packet's claim 'even where an old live snapshot had no section ids' has no fixture: none has id-less live sections next to identical drafts.
- report.js: when the data check did not run (NEEDS_FLAG, PENDING_SCHEDULE, LIVE_READ_ERROR, migrating, already documents), 'What shoppers will see change' still prints 'Nothing.', which reads as a checked result. The verdict is 'Not ready' anyway, but this section should say it wasn't checked yet, for example 'Not checked: fix the things above first'.
- The {store_name} binding is stored as 'no title or highlight' instead of a token. Shoppers see today's words, and the title follows a rename. The cost is larger than the packet's Known limit says. validateDocument gives REQUIRED 'The title is empty' as incomplete in draft mode and as an error in publish mode. The inherited rule only softens it while the hero section is unchanged. So the first time the founder edits any hero field (for example the subtitle), publishing is blocked until they type a title, and that typed title then stops following the store name. lib/experiments.js unpublishableDrafts also uses a plain publish-mode validateDocument, so adopting a subtitle-only variant on a migrated half-customized home will report the home page as blocked. The packet should say this, and it should be an owner check.
- The cart document stores each product's catalog handle (`handles[pid]`), and the catalog is left out of sourceHash. A Shopify handle change between rehearsal and cutover leaves sourceHash the same but changes the cart version id and the release id (reproduced: sourceHash same, releaseId different). This is harmless for shoppers, because the reader uses the id first, but CUTOVER should not expect rehearsal and cutover ids to match when the hashes do. Either drop the handle (the reader resolves by id) or note it for CUTOVER.
- Generated home-section ids can collide with a stored id. Stored sections [{id:'sec_l1'}, {no id}, {no id}] map to ids sec_hero, sec_l1, sec_l1, sec_l2. The data check sees no difference because ids are ignored. Validation reports SECTION_ID_DUPLICATE with blocksSaving, so the founder gets 'Two sections share one id. Reload the page and try again.' and has no way to fix it. This is unlikely with real stored ids, but the id generator should skip ids already taken.
- The dry run's data check runs routesFor(source) with no extra routes, while the acceptance coverage claim (every non-entity recordOutputs route is covered) was tested with allGetterRoutes() passed in as `extra`, so it holds by construction. In the command, the routes left unchecked are only fixture probes (code-default 'terms' on a store without brand defaults, and redirects that don't exist). The difference is small, but 'covers every recordOutputs route' is only true in-process.
- False 'Not ready' cases, safe direction, worth listing as known limits. A page section of an unknown kind (left out of the body, and never rendered today) shows as a difference on that page. An old address whose from_slug is a switched-off page is correctly reported as a shopper change (legacy redirects, v4 gives null).
- The command reads the control plane (getTenant, agency_grants) from PLATFORM_DB_URL without the local/hosted check it applies to the store database. It only reads, and a hosted store database is still refused, but the plan says every CLI refuses other URLs. Consider applying isLocalDbUrl to PLATFORM_DB_URL too, or saying so in Known limits.

## From review

See "From review" at the end of Known limits.

**Answered by P4-FIX1** (`docs/cms-reviews/P4-FIX1.md`):
- The six surviving mutations now each fail a case.
- The ids.js rules are proven with sha256 worked out in the test, and the id-less live sections fixture exists.
- An unchecked data check says "Not checked: fix the things above first.".
- Generated section ids skip taken ones (home, page and product page extras).
- The cart handle is kept, because the reader, the `product_list` check and MED-03 refs need it. It is recorded for P4-CUTOVER: rehearsal and cutover ids may differ when source hashes match.
- The `{store_name}` cost is recorded, and the token is an owner check.
- `PLATFORM_DB_URL` gets the local/hosted check.
- The dry run lists the routes its data check covered.
- Product-page extras stored with an id still show as a (safe-direction) difference: that is `check.js` work.

## Owner checks

- **A real dry run per store, before its rehearsal:** `pnpm migrate:documents -- --tenant <id> --dry-run --hosted --confirm <id>` (add `--store-open` or `--not-launched` for a store that never published). Read the plain report with the founder; keep the digest for CUTOVER.
- **OQ-6 (doc_cart):** the dry run prints the staff line under "Team access that changes". Confirm it with the team before each cutover (plan section 6).
- **OQ-8 (saved templates):** the dry run counts them and says where they stay readable; confirm that is enough.
- **Stores with a half-customized home:** after a real cutover, open the new editor's home page once and check the hero title note reads sensibly to the founder (Known limits, `{store_name}`).
- The CI sqld download in `.github/` still needs the owner's approval of its source and checksum (carried from P4-SCAFFOLD; nothing here changed `.github/`).
