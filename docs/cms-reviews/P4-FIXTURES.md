# P4 · FIXTURES · Legacy tenants for phase 4 tests

Branch `cms/p4-fixtures`, cut from `607cde2`. Plan: `docs/cms-reviews/P4-PLAN.md` (section 0, batch 1) and `P4-BATCHES.json`. Requirements it serves: MIG-01, MIG-02 and MIG-04. It proves none of them end to end. It gives MAPPER, SEAM, HARNESS, CUTOVER and REVERSE one place that builds every legacy tenant shape the spec names, on local file databases, plus one recorder of what the store answers.

Migrations owned: none. Test infrastructure only: no file under `lib/`, `app/` or `components/` changed. One file beyond the plan's list: `scripts/test-documents.js` (one allowlist line, see Known limits). No P3-FIX5 file was touched, nothing under `.github/`, and not `MANUAL-CHECKS.md` or `package.json`.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 158.0 s. `test:legacy-fixtures` 28 passed in about 3.5 s; `test:releases` 43, `test:release-readers` 44 and `test:sections-render` 36 passed with no baseline change. `pnpm build` passes |
| Browser verified | Not applicable. Nothing a shopper or founder sees changed. No dev server ran; port 6140 and 7140 to 7149 were not used |
| Staging verified | **NOT DONE.** Builders only ever touch local file databases |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

Phase 4 moves real stores from the old content tables to documents. Every later item needs the same legacy stores to test against: the six rows of the spec 8.11 state table, the mapping traps, the product and collection content in all its old shapes, and the half-finished runs a cutover must survive. Before this item, three recorders each built their own throwaway tenant inline, and nothing else could reuse them. This item:

1. moves those tenant builders into one helper, `scripts/support/legacy-tenants.js`, and makes the three recorders thin wrappers, with their JSON output unchanged byte for byte;
2. adds one named builder per state row, mapping trap, entity fixture and re-run fixture in the brief;
3. adds `recordOutputs`, which records what `getLiveReleaseState`, `contentSource` and the `resolved*` getters answer, so MAPPER's in-process data check and CUTOVER can compare a legacy store with its candidate;
4. refuses any database that is not a local file before it touches it.

## Design

### `scripts/support/legacy-tenants.js` (new)

Nothing runs on import, and no `lib/` module is imported until a function is called, so the caller sets the environment first.

- **`installHooks({ headers })`**: the module hooks the app needs outside Next (`next/server`, `next/navigation`, `@/` paths). `headers: "real"` keeps Next's own `next/headers` (as the release recorder always did); `"stub"` answers one simulated request at a time through `asRequest(host, cookies, fn)` (as the home and journal recorders did, now with one shared global).
- **`openWorld({ prefix })`**: sets the env exactly as the recorders did (`TURSO_DB_URL` empty, `DATABASE_URL` and `PLATFORM_DB_URL` as `file:<prefix>-default.db` and `-platform.db`, the test platform secret), changes to the checkout's root (file URLs are relative to it), and migrates the control plane. The prefix must look like `.test-<name>`.
  - `world.tenant({ id, name, file, domains, config, secrets, stage })` registers a tenant on `file:<prefix>-<file or id>.db`, runs `lib/schema.sql` and the tenant migrations up to `stage` (tenant-fixture's `stageMigrations`), and returns a handle `{ id, url, file, tenant, run, world }`.
  - `world.defaultStore()` is the env store (`_default`) as a handle, for the code-default pages trap.
  - `world.cleanup()` removes every file the world made.
- **`buildLegacyTenant(db, { state, traps, entities, set, drafts })`**: fills a handle (from the world, or tenant-fixture's `makeTenant`) with legacy content and returns a manifest (state, operator flag, release ids, the envelope put live). It builds a model of the drafts and of the release the state puts live; traps and entities patch both; then it writes the catalog, the live tables, the drafts, the extra rows and the release. Traps that need exact old shapes are written raw, never through today's normalizing writers.
- **`makeLegacyTenant(world, {...})`**: `world.tenant` plus `buildLegacyTenant`, with the content set's tenant id, name and config by default.
- **`recordOutputs(db, { routes, getters, state })`**: the plain-JSON record. `routes` defaults to `allGetterRoutes()`, which enumerates every exported `resolved*` getter of `lib/content/resolve.js` (a getter added later is still recorded, called with no arguments). `getters` lets MAPPER and CUTOVER record another source the same way (P4-SEAM's `contentGettersFor(src)`). A getter that throws is recorded as `{ threw, message }`, as before.
- **`putLiveRelease`, `startHeroExperiment`, `renderKit`** (the SWC loaders of the home and journal recorders, unchanged).

### Content sets

The recorders' content moved as is, so their output cannot drift:

| Set | Was in | Tenant | Used by |
|---|---|---|---|
| `vgate` | `legacy-release-outputs.js` | `vgl` | the default for every named builder; v1, v2 and v3 envelopes, live-table overrides, pins, placements and a redirect |
| `home` | `home-render-outputs.js` | `hr` | the home recorder (drafts through the console's own writers) |
| `journal` | `legacy-journal-outputs.js` | `jl` | the journal recorder |
| `empty` | `home-render-outputs.js` | `hre` | a store with no products yet |

One addition to `vgate`: drafts (the v1 blocks and pages with the hero and the about title changed), so a store live on a release also has an unpublished change, as real stores do. The release recorder passes `drafts: false`, so its database holds exactly what it held before. The in-process test builds with drafts and still matches the baseline, which shows the drafts do not leak into a live read.

### Named builders

Each has a plain `describe` line.

- **`STATE_ROWS`** (8.11): `live_v1` (live-table overrides, pins, placements and redirects), `live_v2`, `live_v3`, `no_release_open` (flag `--store-open`), `no_release_not_launched` (flag `--not-launched`), `pending_schedule` (live on v3 plus a release scheduled for 2099), `live_read_error` (the pointer names a release with no envelope version).
- **`MAPPING_TRAPS`**: `nav_header_null`, `_empty`, `_absent` and the same three for the footer (composable, so header and footer can differ in one store); `announcement_set`, `announcement_empty`; `home_sections_empty`; `home_sections_no_ids`; `page_sections_no_ids`; `page_sections_no_kind`; `code_default_pages_default` (needs `world.defaultStore()`) and `code_default_pages_beastlife` (needs tenant id `beastlife`); `policies_as_cms_pages`; `journal_family` (posts shown, undated, scheduled, ended and switched off, which the /journal index is built from); `agency_home_sections_v2` (the id-less sections a kit applied at a6d028e, goes with `live_v2`); `highlight_unmatched`; `hero_experiment_running`; `ai_proposal_payload`; `agency_kit_payload`; `home_hero_only`, `home_sections_only` (the default hero title follows the store name, the `{store_name}` case), `home_both_custom`, `home_both_default`. Every trap changes the drafts AND the live release, so "a snapshot holds only the customized blocks" is real.
- **`ENTITY_FIXTURES`**: `product_override_modules_badge`, `_six_modules` (the legacy limit), `_long_module` (exactly 10000 characters of HTML), `_unsanitized_html` (module HTML that `sanitizeHtml` rewrites); `pdp_pairs_custom_title`, `pdp_pairs_default_title` (title null), `pdp_pairs_disabled`, `pdp_pairs_two_on_one_source` (positions 0 and 1); `cart_upsell` (title, position 2); `collection_pins`; `surface_templates_products`, `surface_templates_collections`; `redirect_to_page`, `redirect_to_journal_post`, `redirect_to_code_default_page` (`terms`, no row), `redirect_to_nothing`; `cms_templates_two_families` (page and journal); `cms_approvals`; `agency_grant` (an accepted grant in the control plane). Each entity brings its own products (ids 201 to 241), so they compose. On v2 and v3 they are also frozen into the release's own arrays; on v1 they stay in the live tables, which v1 reads.
- **`RERUN_FIXTURES`**: `phase3_leftovers` (`buildPhase3Leftovers(db)`: a `product_content` document with a random phase-3 id for product 1, and a page document with a random id holding the slug `about`, which the legacy page also uses) and `stale_backfill` (`buildStaleBackfill(db)`: `doc_home`, the about page's backfill id and product 1's deterministic id with "migrated" versions, a `product_content_live` and a `collection_content_live` row, an aborted `cms_migration_runs` row and the store back in legacy; then newer edits to the hero, the about title, product 1's badge and modules and collection 2's pins). Both return the ids and the older and newer values, so CUTOVER can assert "the newer legacy content wins and the older draft is kept".

Document bodies in the re-run fixtures are built from the registry (`emptyBody`, the legacy mappers) and validated before they are written, with `documentHash` and the service's `ver_<16 hex>` id shape.

### Refusing non-file URLs

`assertFileDb(db)` runs first in `buildLegacyTenant`, `recordOutputs`, `putLiveRelease`, `startHeroExperiment`, `buildPhase3Leftovers` and `buildStaleBackfill`. It uses tenant-fixture's `assertLocalDbUrl` on both the handle's `url` and its `tenant.dbUrl`, so `libsql://`, `https://`, `ws://`, a sqld on `http://127.0.0.1`, `file://host/…` and a bare path are refused before `run` is ever called. `openWorld` only makes `file:` URLs. Nothing passes `--hosted`, and nothing calls a CLI against a hosted store.

### The three recorders

Each is now about 40 lines: install the hooks, open a world with its old prefix (`.test-vgate-legacy`, `HOME_RENDER_DB_PREFIX` or `.test-home-render`, `.test-journal-legacy`), build its tenant from its content set, put the releases live in the same order, record, clean up. Before committing, each was run once on `607cde2` and once on this branch: the release and journal JSON is byte-identical; the home JSON is identical once the 8-hex section ids that `upsertContentPage` mints at random are masked (two runs on `607cde2` already differ there, and `test:sections-render` strips those attributes).

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Builders plus `recordOutputs` reproduce `legacy-release-outputs.a6d028e.json`, the home-render baseline and the legacy-journal baseline exactly | **DONE** | `test-legacy-fixtures` part 3. "live_v1, live_v2 and live_v3 (with their drafts) plus recordOutputs reproduce …" builds each state in this process and compares every recorded key with the baseline (`release.v` aside, the one P2-VGATE addition, as `test:releases` does). The wrapper cases run each recorder: the release output equals the in-process record exactly and the baseline; the home output equals the baseline in all 10 states once `data-section-*` is stripped (as `test:sections-render` does); the journal file is byte-identical to its baseline. A changed value in the `vgate` live tables fails the first two cases (mutation run) |
| 2 | The test enumerates the required 8.11 state rows, mapping traps, entity fixtures and re-run fixtures and fails if any has no builder | **DONE** | Part 2, "every 8.11 state row, mapping trap, entity fixture and re-run fixture of the brief has a named builder …", holds the brief's list (7 + 25 + 19 + 2) and also refuses unnamed extras. Part 9, "every required builder ran in a case above", fails if a builder exists but no case checked what it writes. Removing `pdp_pairs_disabled` fails both (mutation run) |
| 3 | The builders refuse a `libsql://` URL | **DONE** | Part 1: six refused URLs, each as `url`, as `tenant.dbUrl`, and as a file `url` with a hosted `tenant.dbUrl`, through all six entry points; the handle's `run` is never called. Removing the check from `buildLegacyTenant` fails it (mutation run) |
| 4 | Every existing suite that runs the three CLIs stays green with no baseline change | **DONE** | `test:releases` 43 passed, `test:release-readers` 44 passed, `test:sections-render` 36 passed; `git diff --stat -- scripts/fixtures` is empty |

Without this change, `scripts/test-legacy-fixtures.js` cannot even load: `scripts/support/legacy-tenants.js` does not exist at `607cde2`.

## Tests

- `scripts/test-legacy-fixtures.js` replaces SCAFFOLD's placeholder body (no `package.json` change). 28 cases in 9 parts, about 3.5 s, all file databases with the prefix `.test-lfx`, removed at the end (the suite checks the recorders leave none either).
- Beyond the four acceptance lines, each builder's own case checks what it wrote and what the store answers: for example `home_sections_empty` reads as the default sections, page sections with no kind read as text, the code-default `terms` page renders on `_default` and `beastlife` and the trap refuses any other store, the journal index shows only the two visible posts, the default hero title becomes "Shop Renamed Shop." after a rename, `sanitizeHtml` rewrites the old module HTML, the v1 read uses the entity live tables while v3 reads the frozen arrays, and the stale backfill's documents validate and keep the older values while the legacy tables hold the newer ones.
- Mutation runs (each reverted): no file check in `buildLegacyTenant` (part 1 fails); a builder removed (parts 2, 7 and 9 fail); a `vgate` value changed (part 3 fails); entities not frozen into v2 and v3 (part 7 fails).
- Full `pnpm test`: 96 of 96 suites passed in 158.0 s. The first full run failed one case in `test:documents` (see Known limits); after the allowlist line it passed. `pnpm build` passes.

## Known limits

- **One file beyond the plan's list: `scripts/test-documents.js`.** Its "one writer" scan (no INSERT, UPDATE or DELETE on `documents`, `document_versions` or `publish_log` outside `lib/documents/`) allowlists only `scripts/test-*.js`. The re-run fixtures must write leftover document rows directly, with fixed ids, on local file databases, as an aborted run or phase 3 left them; no service function writes a document at a chosen id. The first full `pnpm test` failed that case (95 of 96). The allowlist now also names exactly `scripts/support/legacy-tenants.js`; any other file still fails (checked by adding a probe file under `scripts/support/` with an INSERT: the case failed, then the probe was removed). The orchestrator should add this file to this item's list.
- **The home recorder's JSON is not byte-identical run to run, before or after this change.** `upsertContentPage` mints random section ids for the page drafts. The comparison masks only those 8-hex ids; every other byte matched.
- **`openWorld` changes the process's working directory** to the checkout's root, as the recorders did at their top. File URLs are relative, so this is needed; a suite that relies on another working directory should open the world first.
- **One world per process.** `lib/db.js` reads `DATABASE_URL` once, so a second `openWorld` with another prefix in the same process would keep the first env store. Tenants are separate files, so one world can hold any number of them (the suite builds about 30). A test that needs a fresh tenant with an id already used should pass a new `file`.
- **The agency fixtures write the control plane.** `agency_kit_payload` and `agency_grant` need a handle from `openWorld`; with a bare tenant-fixture handle they refuse before writing anything.
- **`code_default_pages_*` need the right store** (`world.defaultStore()`, or tenant id `beastlife`) and refuse any other, because code-default pages only apply there.
- **`agency_home_sections_v2` goes with `live_v2`** (or a state with no release) and refuses another version.
- **The live-row columns the stale-backfill fixture writes** (`badge`, `modules`, `pairs`, `pinned`) are my reading of "legacy-derived columns". If LIVEROW or CUTOVER define them differently, they should adjust the fixture, not the other way round.
- **"No release, open" and "not launched" hold the same data.** Spec 8.11 says the operator decides which one a store is; the builders differ only in the manifest's `flag`, which is what MAPPER's `--store-open` and `--not-launched` read.
- **`recordOutputs` records getters, not rendered pages.** The rendered comparison is EQUIV's (batch 4); the home and journal recorders keep their own rendering.

## From review

Nothing yet.

## Owner checks

- None new for this item. It builds local test databases only. The CI sqld download in `.github/` still needs the owner's approval of its source and checksum before CI can run the phase 4 sqld suites (carried from P4-SCAFFOLD; this item changed nothing under `.github/`).
