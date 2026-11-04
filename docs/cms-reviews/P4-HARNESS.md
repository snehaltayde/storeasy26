# P4 · HARNESS · The phase 4 drill store and drill helpers

Branch `cms/p4-harness`, cut from `17a08b7`. Plan: `docs/cms-reviews/P4-PLAN.md` (sections 0 and 3, batch 2) and `P4-BATCHES.json`. Requirements it serves: MIG-02, MIG-03 and MIG-04. It proves none of them end to end. It gives MAPPER, EQUIV, CUTOVER, REVERSE and DRILLS one legacy drill store on the design harness, local file copies of every legacy state for the CLI drills, and the helpers to drive both.

This is the author's own report. Reviewers should re-read the code.

Migrations owned: none. No file under `lib/`, `app/` or `components/` changed, so nothing new runs on the edge runtime. Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `scripts/drills/p3/*`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, the untracked `docs/CMS_*.md` files, and the two named `.claude/worktrees`.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 143.5 s (fix round 1). `test:legacy-fixtures` 33 passed, `test:writers` 23 passed. `pnpm build` passes |
| Browser verified | Yes, desktop Chrome 156 (headless, `playwright-core`), at 1440 px, on the design harness on this Mac (`DESIGN_PORT=6160`, `DESIGN_SQLD_PORT=7160`, `next dev`). `run.mjs seed` 35 passed, `run.mjs smoke` 16 passed, 0 failed. Not Safari, not a phone |
| Staging verified | **NOT DONE.** The harness and the local copies are local tools |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real or hosted tenant touched, no store moved to documents mode, `--hosted` never passed |

## What and why

Phase 4 moves real stores from the old content tables to documents. Its later items need:

- one store on the design harness that looks like a real legacy store a cutover would move, with every kind of old content the cutover must carry, so the browser drills can compare "before" and "after";
- local file databases in each spec 8.11 state, for the CLI drills (dry run, cutover, reversal), which must never touch a hosted store;
- shared helpers (seed, sign in, capture what a shopper gets, refuse anything not on this machine).

This item builds those, plus the four P4-FIXTURES review fixes the orchestrator folded into it.

## Design

### 1. `scripts/seed-design-documents.js --p4`

A **legacy** store, live on a **version 3 release made by `createRelease`** (no takeOver, no documents).

- It starts from a fresh perf seed (`runHarness({ mode: "seed", fixture: "perf" })`, the same call as `node scripts/dev-design.js seed --fixture perf`). The perf seed is already legacy and live on a v3 release, so re-running `--p4` is a reset.
- It then changes the store (in `scripts/drills/p4/seed-p4.mjs`, see Known limits) through the **same legacy writers the old consoles use** (`setProductOverride`, `upsertPlacement`, `deletePlacement`, `setBlock` with `validateBlock`, `upsertContentPage` with `redirect_from`, `deleteContentPage`, `saveTemplate`, `upsertExperiment`, `startExperiment`), and publishes one more release with `createRelease` (note "P4-HARNESS drill store").
- It adds the P3 logins (`seedP3Logins`: owner and staff, fresh passwords, never printed).
- The `--p3` seed is unchanged (no line of its path changed). `dev-design.js` needed no change: `--p4` runs the perf seed itself.

What the store holds (`P4_SEED_LIST`, counted by `check --p4`):

| Line of the brief | How |
|---|---|
| 24 product overrides, one with 6 modules | the perf seed's 24; the chosen product (the perf "measured" product, `micronised-creatine-12`) gets 6 modules and the badge "Bestseller" |
| 40 pairs: one with a custom title, one disabled, one source with two placements | the perf seed's 40 `pp-perf-*` rows: `pp-perf-1` (the chosen product's) titled "Goes well with your routine", `pp-perf-2` switched off, `pp-perf-40` moved onto `pp-perf-3`'s source at position 1 ("More to try"). The demo store's own pairs row is deleted, so there are exactly 40 |
| a cart_upsell placement | the perf seed's `cu-perf-1` |
| 5 pinned collections | the perf seed's 5 |
| one per-product and one per-collection template exception | `surface_templates`: the chosen product `editorial`, the first pinned collection (`protein`) `sidebar` |
| 32 library photos, one used only inside product module HTML | the perf seed's 32. `product-photo-24` is moved off every catalog row (products, product photos, variants, collections) onto `product-photo-23`, then the chosen product's third module shows it. `check --p4` counts its uses in every table that can hold one |
| a running hero experiment | the demo seed's `hero-promise` already runs on the hero; `P4_EXPERIMENT` is started only on a store with none |
| a page_redirect | the first journal post renamed the old console's way (`redirect_from`), its old row deleted |
| two cms_templates rows | `saveTemplate`, one page and one journal |
| the P3 logins | owner and staff |

Facts the drills need (ids, paths, titles, the pinned order, the module-only photo, the redirect, the seed list) go to `.design-data/p4-seed.json`, mode 600. A copy of the stores and logins also goes to `.design-data/p3-seed.json` (mode 600), so the phase 3 helpers' `login()` works on this store too.

`check --p4` (read only, works with the harness running) prints the mode, the live release, its version and note, every seed-list count, what the live release froze (overrides, six-module override, pairs, the switched-off one, the cart upsell, pins, redirect, template exceptions) and where the module-only photo is used. `--p4` itself refuses to finish if any count is off.

### 2. `scripts/drills/p4/local-tenants.mjs`

Builds five file databases with the P4-FIXTURES builders (`openWorld`, `makeLegacyTenant`), content set `vgate` plus every entity fixture a cutover can move, and copies them out with `VACUUM INTO` (one clean file each):

| File | State row | Live |
|---|---|---|
| `v1.db` | `live_v1` | a version 1 release (entities in the live tables) |
| `v2.db` | `live_v2` | a version 2 release (entities frozen) |
| `v3.db` | `live_v3` | a version 3 release |
| `open.db` | `no_release_open` | no release, flag `--store-open` |
| `closed.db` | `no_release_not_launched` | no release, flag `--not-launched` |

Plus `platform.db` (a control plane whose tenant rows point at those files) and `manifest.json` (id, `file:` URL, state, flag, live release, the env a CLI needs, and `tool: "p4-local-tenants"`). The working files at the checkout root are removed. Default folder `.design-data/p4-local`, or `--out <dir>`. `--check` verifies an earlier build.

**The output folder is never wiped** (fix round 1). Before anything is built, `prepareOutDir` takes a folder that does not exist (it makes it), an empty folder, or an earlier build of this tool: a `manifest.json` with `tool: "p4-local-tenants"` and nothing but the files this tool writes (`v1`, `v2`, `v3`, `open`, `closed` and `platform` `.db`, their `-wal` and `-shm` files, `manifest.json`; all plain files). An earlier build is cleared file by file, by name; the folder stays. Anything else is refused with exit 1 before a single file is deleted or a store is built: "Refused to build in <folder>: it holds files this tool did not write (founder-notes.txt). Nothing was deleted. Pick a new or empty folder with --out." So `--out .`, `--out ~` or `--out .design-data` are refused.

Verified by SQL with a plain client: each copy is legacy, has the right live release and version (or none), one release or none, no documents, the catalog, drafts and entity rows; v2 and v3 froze the entity rows; the flag is right; the copied control plane points each tenant at its file. Results: `docs/cms-reviews/drills/P4-HARNESS/results-local-tenants.json`.

Not approvals or agency grants (they make a cutover refuse) and not the BeastLife-only redirect.

### 3. `scripts/drills/p4/lib.mjs`

Re-exports everything in `scripts/drills/p3/lib.mjs` (imported, not edited): `runDrill`, `storeSql`, `p3Ports` (which refuses 3017), `startOwned`, `stopOwned`, `runNode`, `storeUrl`, `docsApi`, `bodyText`, `noThanks`, `readSeed`, `DrillError`, `settle`. Adds:

- `login(drill, role, opts)`: the P3 drill's real-form sign-in, as a function.
- `reseedP4(drill, { start })`: stops the harness this run started, runs `--p4`, starts it again; returns `{ seed, out }`.
- `readP4Seed()`, `p4SeedState()` (`check --p4`).
- `captureShopperRoutes(baseUrl, routes, outDir, { unit })`: fetches each route as a shopper and writes `<name>.html` and `index.json` (status, redirect target, content type, bytes, sha256). Redirects are recorded, not followed. **One cookie is sent: a fixed experiment unit (`_unit=p4-capture`)**; see Known limits for why. `{ unit: null }` sends none.
- `assertLocal(url)`: throws unless the address is on this machine (`localhost`, `*.localhost`, `127.0.0.1`, `::1`, or a `file:` path with no host). It also refuses port 3017 (the owner's harness).
- `selfCheck()`: assertLocal refuses nine non-local addresses and lets six local ones through; `p3Ports` still refuses 3017, set or by default. `node scripts/drills/p4/lib.mjs --check` runs it alone; both stages of `run.mjs` record it.

### 4. `scripts/drills/p4/run.mjs` (replaces SCAFFOLD's stub)

`pnpm drill:p4`, or `DESIGN_PORT=… DESIGN_SQLD_PORT=… node scripts/drills/p4/run.mjs [seed,smoke] [--headed]`. Refuses a harness already running in this checkout. P4-DRILLS adds stages to `STAGES` and `STAGE_FNS`.

- **seed**: selfCheck; seeds `--p4`, reads `check --p4`; checks the mode, version 3, that the live release is the one `--p4` made (its id, note and publish time), each of the 20 seed-list lines, the module-only photo, what the release froze; seeds again and checks the same counts and a new live release; checks neither password is printed and both seed files are mode 600.
- **smoke**: selfCheck; seeds `--p4` and starts the harness; shopper captures of the home page (twice), the chosen product, the pinned collection and the renamed post's old and new address; then desktop Chrome at 1440 px on the chosen product and the pinned collection; then the owner and staff sign in.

Results go to `docs/cms-reviews/drills/P4-HARNESS/results-<stage>.json` with screenshots; captures to `.design-data/p4-captures/` (not committed).

### 5. The P4-FIXTURES review fixes (`scripts/support/legacy-tenants.js`)

- **`redirect_to_code_default_page`** now needs the env store or the tenant id `beastlife`, as `code_default_pages_*` do, and refuses any other store in plain words. On an ordinary tenant the `terms` slug resolves to nothing, so the fixture was the same as `redirect_to_nothing`. It also removes any `terms` row from the drafts and the release, so the code default is what renders.
- **The stale-backfill fixture**: the collection row now names a real `doc_coll_<16 hex>` document of type `collection_content` and a real `ver_<16 hex>` version (the same deterministic shape as the others). The product's "migrated" version now holds the older modules as `rich_text` sections, so version and live row agree. What stays in the live row only is listed in the return value (`liveRowOnly`) and under Known limits.
- **A second build on one database** is refused before anything is written: "this database (…) already holds a store's catalog or content, so it was built before. Each database can be built only once: make a new tenant with its own file …". It counts rows in products, collections, releases, cms_blocks and cms_pages (all empty on a freshly migrated database).
- **`assertFileDb`** has a comment: it checks what the handle says and trusts that `run(fn)` opens that same database.
- **The three recorders' headers** now say `legacy-tenants.js` and `tenant-fixture.js` must be copied into an older checkout too (comment-only change in three files outside this item's list; see Known limits).

### Restore-drill copy of a real tenant, for a rehearsal (owner only)

CUTOVER's real command requires a passing rehearsal on a local copy of the real store (plan decision 8b). This is how the owner makes that copy. **Builders never run it**: it reads a hosted database.

1. On your own Mac, in your checkout, with `.env.local` holding the control plane's address and token (as for every operator command):
   `pnpm restore:drill -- --tenant <tenantId> --keep`
2. It reads the hosted store **read only** (`SELECT` of every table; nothing is written to the hosted store), writes `restore-drill-<tenantId>.db` at the checkout root, and checks row counts on every table, the migration ledger, order totals and the database's integrity. Without `--keep` it deletes the copy at the end.
3. Point the rehearsal at that file (`file:restore-drill-<tenantId>.db`), as CUTOVER's runbook says.
4. **The copy holds the store's customer data** (customers, orders, addresses, emails). It stays on your machine: never commit it (`*.db` is gitignored), never upload, attach or share it, and never put it in a shared or synced folder. Delete it, and its `-wal` and `-shm` files, as soon as the rehearsal is done.
5. It is a verification copy, not a backup. The backup is the Turso point-in-time restore (the runbook's `--backup-ref`).

## Acceptance, with evidence

| # | Item | Status | Evidence | Fails without this change |
|---|---|---|---|---|
| 1 | Drill (run.mjs seed): after --p4, cms_state.mode is legacy, the live release has v 3, and SQL counts match the seed list (including the disabled placement and two cms_templates rows) | **DONE** | `results-seed.json`: 35 passed, 0 failed. "cms_state.mode is legacy", "the live release is version 3, and it is the one --p4 published", "made by createRelease and published", 20 "seed list: …" checks (`pdpPairsDisabled is 1`, `cmsTemplates is 2`, …), "SQL counts match the whole seed list", the frozen-release checks, the same counts on a second seed | On `17a08b7` `--p4` is an unknown option and `run.mjs` is the stub (exit 1). Mutations below |
| 2 | Drill (desktop Chrome on the harness): the storefront shows the badge, the custom pairs title, the pinned products first and the editorial template on the chosen product | **DONE** | `results-smoke.json`: 16 passed, 0 failed. "renders the editorial template", "shows its badge \"Bestseller\"", "shows its own pairs title \"Goes well with your routine\"", "six modules", "the module-only photo is inside the chosen product's module", "the pinned collection lists its pinned products first, in the pinned order" (the four pinned handles first), "renders the sidebar template", the redirect in Chrome. Screenshots `chosen-product-1440.png`, `pinned-collection-1440.png` | Mutation M5 (chosen product on `classic`): "renders the editorial template" fails |
| 3 | Drill: the p3 'items' stage still passes after reseeding with --p3 | **PARTLY: 140 of 141 checks pass; the 1 failure fails the same way on the base `17a08b7`** | Each item drill reseeds `--p3` itself. routes 31/0, editor 22/0, design 26/0, rte 46/0, smoke 25/1. Copies: `docs/cms-reviews/drills/P4-HARNESS/p3-items/`. See "The p3 items stage" below | n/a (the `--p3` path is unchanged) |
| 4 | Check inside lib.mjs: assertLocal refuses a non-localhost URL and p3Ports still refuses 3017 | **DONE** | `node scripts/drills/p4/lib.mjs --check`: 3 ✓; the same three checks open both `results-seed.json` and `results-smoke.json` | On `17a08b7` there is no `lib.mjs` |
| 5 | local-tenants.mjs produces the five file-database states, verified by SQL | **DONE** | `results-local-tenants.json`: 22 passed, 0 failed (built into a folder whose name has a space). A fresh process with only `manifest.json`'s env read each copy through the app: v1, v2, v3 `live` with versions 1, 2, 3 and heroes "Live hero v1/v2/v3"; open and closed `none` with "Draft hero" | On `17a08b7` there is no `local-tenants.mjs` |
| 6 | unit: redirect_to_code_default_page on beastlife redirects to a page that renders, and refuses on an ordinary tenant | **DONE** | `test-legacy-fixtures`, "redirect_to_code_default_page on BeastLife: …": on `live_v3` and `live_v1`, the row, `resolvedSlugRedirect("old-terms")` is `terms`, `resolvedContentPage("terms")` is "Terms of service" with sections, no terms row; an ordinary tenant is refused; on an ordinary tenant `terms` resolves to nothing | The new test file run on `17a08b7`: 25 passed, 5 failed (this case, the second-build case, the stale-backfill case, the ordinary-entities case, the "every builder checked" case). Mutation: removing the store check fails it |

### The p3 items stage

Run after this branch's changes, each item drill seeding `--p3` itself. One check fails in `smoke` (P3-HARNESS): "document_refs holds exactly the refs of every seeded published version (none missing, none extra)", with `orphanRefs: 22`.

That is not this branch: `smoke.mjs` run on a worktree at `17a08b7` (none of these changes), same ports, fails the same check with the same numbers (`p3-items/base-17a08b7-P3-HARNESS-smoke.txt`). The check counts `document_refs` rows whose version is not a *published* version as orphans. P4-MEDIA (merged in `8565697`, after the committed P3 results of 08:53) now writes refs for checkpoints too (its packet, "Checkpoints and kept drafts written by service.js"), so the 22 rows are the checkpoints' refs, which are correct. `scripts/drills/p3/*` is not this item's to edit (plan section 0). **Orchestrator: the P3 smoke's refs check needs to count every kept version, not only published ones** (a P3 drill fix, or a note that P4-MEDIA changed it).

How the runs went, so a reviewer can repeat them: the first full `run.mjs items` also stopped editor, design and rte on `page.goto` timeouts (`/admin/editor` and `/admin/brand` never answered). The same editor drill passed 22/0 on the base worktree, and then 22/0 on this branch once this worktree's Next dev cache (`.next`, 957 MB after many harness runs) was removed: a stale dev cache, not code. After that, editor, design and rte passed in one `items` run; smoke and routes in that run timed out waiting for the harness's first cold compile ("didn't come up within 3 minutes"), so they were run again alone: routes 31/0, smoke 25/1 (the refs check above). The P3 results folders were restored to their committed state after each run; the copies are in `p3-items/`. Note for later runs: `run.mjs editor,design,rte` also runs the matrix part named `design` (the names collide); run item drills by file (`node scripts/drills/p3/design.mjs`) to avoid that.

## Do the tests bite?

Scratch runner `…/scratchpad/p4-b2/P4-HARNESS/mut/run.py`: one break at a time in the seed's writes (`scripts/drills/p4/seed-p4.mjs`), the named stage run, the file restored.

| Break | Stage | What failed |
|---|---|---|
| M1: no template exceptions | seed | the seed refuses ("productTemplateExceptions 0 (want 1) …"), the stage stops, exit 1 |
| M2: no `createRelease` at the end | seed | "the live release is … the one --p4 published", "made by createRelease", the two frozen-release checks (4 failed) |
| M3: the photo not moved off the catalog | seed | the seed refuses ("moduleOnlyPhotos 0 (want 1)") |
| M4: the pairs not switched off | seed | the seed refuses ("pdpPairsDisabled 0 (want 1)") |
| M5: the chosen product on `classic` | smoke | "the chosen product … renders the editorial template" (got `classic`) |
| M6: the custom pairs title dropped | smoke | the seed refuses ("pdpPairsCustomTitle 0 (want 1)") |

In `legacy-tenants.js` (each reverted): no store check on the code-default redirect (2 cases fail); no second-build refusal (1 fails); the collection row back on `ver_stalecollection` (2 fail).

## Tests

| What | Result |
|---|---|
| `node scripts/test-legacy-fixtures.js` | 33 passed, 0 failed (was 28; 2 new cases, 3 changed; fix round 1 adds 3 in part 8b) |
| `node scripts/drills/p4/run.mjs seed` | 35 passed, 0 failed |
| `node scripts/drills/p4/run.mjs smoke` | 16 passed, 0 failed |
| `node scripts/drills/p4/local-tenants.mjs` | 22 passed, 0 failed (fix round 1: a fresh build into a folder with a space, a rebuild over it, then `--check`, each 22 passed; with a `notes.txt` added, and with `--out .`, refused, exit 1, nothing deleted) |
| `node scripts/drills/p4/lib.mjs --check` | 3 passed |
| P3 item drills (each reseeds `--p3`) | routes 31/0, editor 22/0, design 26/0, rte 46/0, smoke 25/1 (the refs check, same on the base) |
| `pnpm test` | 96 of 96 suites passed in 146.9 s (the first full run failed `test:writers`; see Known limits, `seed-p4.mjs`). Fix round 1: 96 of 96 in 143.5 s |
| `pnpm build` | passes; its two warnings are the old `next.config.mjs` NFT trace (nothing in `app/`, `lib/` or `components/` changed) |

## Known limits

- **Shopper captures send one cookie, a fixed experiment unit.** The brief says "fetch with no cookies; experiments are deterministic without a unit cookie". The code says otherwise: `app/(storefront)/page.js:47` gives a request with no `_unit` cookie a random unit, so a running hero experiment serves a random variant. The smoke drill shows it: 8 cookie-less fetches of `/` showed both heroes ("Winter repair, started." and "Visibly brighter in 14 days"). So `captureShopperRoutes` sends `_unit=p4-capture` and nothing else (no session, preview or console cookie): two captures then show the same hero (checked). The variant a fixed unit gets depends on the experiment's salt, so it is the same for every capture of one store (before and after a cutover), not across reseeds. `{ unit: null }` sends no cookie.
- **"40 pairs" means 40 `pdp_pairs` rows** on 39 source products. The demo seed's own pairs row was deleted to get there, through the old console's `deletePlacement`.
- **The running hero experiment is the demo seed's `hero-promise`**, not a new one: a store can run one hero experiment at a time. `P4_EXPERIMENT` starts only on a store that runs none.
- **The module-only photo** was made by moving `product-photo-24` off the catalog rows with plain `UPDATE`s (catalog rows are what a sync writes, as the perf fixture writes them). Every content table goes through the legacy writers.
- **`--p4` also writes `.design-data/p3-seed.json`** (stores and logins only, no closed store), so the P3 `login()` works. A P3 drill that needs the closed store or the P3 documents must reseed `--p3` (they all do).
- **`reseedP4` cannot clear the P3 helpers' cached console cookies** (a private map in `scripts/drills/p3/lib.mjs`). After a reseed the old cookies no longer sign in, and `login()` falls back to the real form, so it works; it costs one extra page load.
- **The smoke drill waits for the real page**: Next dev may reload a page once after compiling it, and the product page streams a skeleton first. The checks wait up to 60 s for the element to be visible.
- **The switched-off pairs are not checked in the browser.** The product with the switched-off placement shows the automatic same-collection pairs under the same default title, so a title check can't tell them apart. The seed and the frozen release are checked by SQL.
- **local-tenants: the `vgate` content set only, no mapping traps.** Each state holds the same entity fixtures; MAPPER's and CUTOVER's suites build the traps themselves. How each CLI is pointed at a copy (`--db`, `--tenant` with `manifest.env`) is MAPPER's and CUTOVER's to define; the manifest gives both.
- **local-tenants' default folder is `.design-data/p4-local`**, which a fresh harness seed wipes. Build after seeding, or pass `--out`.
- **local-tenants refuses a build made before fix round 1.** Those manifests have no `tool` field, so a rebuild into such a folder is refused ("not an earlier build of this tool"). Delete that folder by hand once, or pick another `--out`. It also refuses a folder holding anything it did not write, even a stray `.DS_Store`.
- **The stale-backfill fixture, what stays live-row-only:** the product's badge and pairs (product_content has no field for them at this base) and, until P4-LIVEROW registers `collection_content`, the collection's pins. Until then the collection document holds the smallest body of that type (`{ schema: 1, type: "collection_content", meta: {}, sections: [] }`, not validated); once the type is registered, the fixture builds it from the registry by itself (`collectionBody: "registry"`) and the test validates it. LIVEROW or CUTOVER should put the older pins into that body when the type has a field for them.
- **One new file beyond the plan's list: `scripts/drills/p4/seed-p4.mjs`** (the `--p4` writes). The writer guard in `scripts/test-writers.js` (GUARD's file) allows the old block and page writers (`setBlock`, `upsertContentPage`, `deleteContentPage`) only in fixture and drill code (`scripts/support/`, `scripts/drills/`, `scripts/test-*`) and a short list of seed files, which `seed-design-documents.js` is not on. With the writes in `seed-design-documents.js`, `test:writers` failed ("block/page writer"); moved under `scripts/drills/p4/`, it passes, and no guard was loosened. `seed-design-documents.js` keeps the plan, the constants, `check --p4` and the CLI; the writes get the plan and constants as arguments (importing the seed script back from there would wait on its own top-level await).
- **Three files outside this item's list changed, comment only:** `scripts/support/legacy-release-outputs.js`, `home-render-outputs.js` and `legacy-journal-outputs.js` (the header line the brief asks for). Their output is unchanged (the suite still checks it byte for byte).
- **`P1-HARNESS.md` is not updated** (not this item's file). The phase 4 helper list is in this packet and in `lib.mjs`'s header.
- **Next dev only, headless Chrome, macOS, 1440 px only.**

From review:

- Earlier blocker is FIXED at 66c317a. buildLocalTenants() now calls prepareOutDir() before any build. prepareOutDir makes the folder if it is missing and accepts an empty folder. Otherwise it accepts only an earlier build of this tool: manifest.json must have tool 'p4-local-tenants' and every entry must be one of the 19 files the tool writes, all plain files. It then deletes those files one by one by name, and never deletes the folder itself. I reproduced the original case in scratch: 'precious dir' holding founder-notes.txt was refused with exit 1 and a plain-words message, printed no result, and the file was untouched. A stand-in checkout root (a folder holding .git/HEAD) was refused the same way and kept its .git. Building into a fresh folder, rebuilding over it, then running --check gave 22 passed each time, with only the tool's own files left.
- I did not run '--out .' or '--out ~' against the real checkout or home folder: the auto-mode safety check blocked it as too risky. They are covered by the stand-in root above and by test part 8b, which calls prepareOutDir(ROOT) on the checkout and checks the listing is unchanged.
- Mutation check: I disabled the manifest 'tool' check in prepareOutDir, and test-legacy-fixtures part 8b failed (32 passed, 1 failed). I then restored the file.
- pnpm test in a fresh detached worktree at 66c317a: 96 of 96 suites passed in 142.5 s.
- Known limit, documented in the packet: a folder built before fix round 1 (its manifest has no tool field), or one holding a stray .DS_Store, is refused, so the owner has to delete that folder by hand once. This is safe but may surprise the owner on a Mac, because Finder can drop a .DS_Store into any folder it opens.
- Each local-tenants run (build or --check) rewrites the committed file docs/cms-reviews/drills/P4-HARNESS/results-local-tenants.json, even when --out names a scratch folder, so it leaves the working tree dirty. This is a minor nuisance and loses no data.
- Still open from the first round, unchanged by this fix: the P3 smoke document_refs orphans check (22) fails both here and on base 17a08b7. The CI sqld download needs the owner's approval. The orchestrator needs to add seed-p4.mjs to the plan's file list.

## From review

- **Fix round 1 (blocker, founder data loss reported as success):** `buildLocalTenants()` ran `rmSync(outDir, { recursive: true, force: true })` on whatever `--out` named, then reported "22 passed". A folder `precious dir` holding `founder-notes.txt` lost the file; `--out .` would have wiped the checkout, `.git` included. **Fixed:** `prepareOutDir` (see section 2) refuses any folder that holds a file this tool did not write, or that is not empty and lacks this tool's `manifest.json`, and deletes only its own file names, one by one. Tests in `test-legacy-fixtures` part 8b: the CLI on a folder holding `founder-notes.txt` exits 1, says so in plain words, prints no result, and the folder and file are unchanged; `prepareOutDir` refuses (and deletes nothing from) an earlier build plus a foreign file, a `manifest.json` of another kind, database files with no manifest, the checkout root, and a plain file; it makes a new folder, accepts an empty one, and clears an earlier build of its own file by file. On the old `local-tenants.mjs` all three fail ("the founder's file was deleted", "no prepareOutDir", "prepareOutDir is not a function"): 30 passed, 3 failed.

## Owner checks

- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need your approval before CI can run the sqld suites (carried from P4-SCAFFOLD).
- **The P3 smoke's refs check** (acceptance 3): decide whether the P3 drill is updated to count checkpoint refs, or the check is accepted as known after P4-MEDIA.
- **Before each rehearsal:** make the restore-drill copy on your own Mac only, as in "Restore-drill copy of a real tenant" above, and delete it afterwards. It holds customer data.
- Optional: run `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p4/run.mjs` once on your Mac and open the chosen product (`/products/micronised-creatine-12`) and `/collections/protein` in your own Chrome.

## Files

- `scripts/seed-design-documents.js`: `--p4`, `check --p4`, the P4-HARNESS section (plan, constants, seed list, state)
- `scripts/drills/p4/lib.mjs` (new), `scripts/drills/p4/run.mjs` (replaces the stub), `scripts/drills/p4/local-tenants.mjs` (new), `scripts/drills/p4/seed-p4.mjs` (new, the `--p4` writes)
- `scripts/support/legacy-tenants.js`, `scripts/test-legacy-fixtures.js`: the review fixes and their tests (part 8b: the local-tenants output-folder guard)
- `scripts/support/legacy-release-outputs.js`, `home-render-outputs.js`, `legacy-journal-outputs.js`: header comment only
- `docs/cms-reviews/P4-HARNESS.md`, `docs/cms-reviews/drills/P4-HARNESS/` (results and screenshots)

## Commands

```
DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 node scripts/seed-design-documents.js --p4
DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 node scripts/seed-design-documents.js check --p4
DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 node scripts/drills/p4/run.mjs seed,smoke
node scripts/drills/p4/local-tenants.mjs [--out <dir>] [--check]
node scripts/drills/p4/lib.mjs --check
DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 node scripts/drills/p3/run.mjs items
pnpm test
pnpm build
```
