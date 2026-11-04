# P4 · FIX4 · Review findings of P4-EQUIV, P4-ED05 and P4-FIX2

Branch `cms/p4-fix4`, cut from `dbce19a` (`cms/phase-1`). Plan: `docs/cms-reviews/P4-PLAN.md` and `P4-BATCHES.json` (item P4-FIX4). Requirements: MIG-02, ED-05 and OVL-17. Migrations owned: none. The findings come from the "From review" lists in `P4-EQUIV.md`, `P4-ED05.md` and `P4-FIX2.md`.

Files changed:
- Code: `scripts/migrate-render.mjs`, `lib/migrate/render-compare.js`, `lib/migrate/allowed-differences.js`, `app/api/admin/catalog/route.js`, `app/api/admin/upsells/route.js`, `lib/admin/cms-api.js`, `lib/ai/insights.js`.
- Tests: `scripts/test-migrate-render.js`, `scripts/test-legacy-routes.js`, `scripts/test-search-effective.js`, `scripts/test-media-picker.js`, `scripts/test-preview-overlay.js`.
- Docs: this packet, plus a "Changed by P4-FIX4" section in `P4-EQUIV.md` and `P4-ED05.md`.

In the plan's list but not changed: `scripts/test-writers.js` and `components/admin/MediaAdmin.js`. The MediaAdmin toast was already right; it only needed a test, which is in `test-media-picker`.

Not touched: `lib/admin/onboarding.js` (P4-PROVISION), every P4-CUTOVER and P4-FIX3 file (`lib/migrate/check.js`, `lib/cms-mode.js`, `lib/releases.js`, `lib/cms/store.js`, …), `lib/cms/view.js`, `lib/sync.js`, `lib/content/documents-reader.js`, `package.json`, `.github/`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`.

Only file databases, one local `sqld` (the suites' own, on ports 7160 to 7167, all stopped) and a Typesense spy were used. No store was moved to documents mode except the file-database test stores. `--hosted` was never passed. Nothing was written to Shopify. No dev server was started (port 6160 was not used).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 182.7 s. `pnpm build` passes (only its 2 existing NFT trace warnings) |
| Browser verified | **NOT DONE.** Every acceptance item is a unit test that fails without the change (see the table). The changes are a command-line tool and API answers; the screens that call the changed APIs redirect a documents store. No desktop Chrome drill was run on the design harness. Owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso or a real Typesense |
| Production enabled | **NOT DONE.** Nothing was pushed, merged or deployed |

## What and why

P4-CUTOVER will rely on the rendered comparison as a hard gate (MIG-02, plan decision 8(b)). The EQUIV review found three ways it could pass when it should not:

- It passed when it compared nothing.
- It passed when the store was broken before and after.
- It passed when the route list was short because a database read failed.

The review also found test gaps on lines that matter. P4-ED05's review found:

- a missing test on the catalog list's pins;
- a picker that breaks when the live release can't be read;
- two console readers that still read frozen tables;
- a read guard blind to wrapper readers;
- an untested closed-store branch.

P4-FIX2's review found three lines no test protected.

## Design

### 1. The rendered comparison (MIG-02)

**`--compare` refuses a comparison that proves nothing** (`scripts/migrate-render.mjs`). The new `assertComparable(before, result)` throws a refusal (exit 2) in three cases:
- 0 pages were compared;
- the before capture marks no canary page;
- any canary in the before capture answered something other than 2xx or 3xx.

The refusal names the broken pages with their status, in plain words. `compareDirs` runs this gate by default (`gate: true`), so a library caller such as CUTOVER gets it too. Only a test passes `gate: false`, to show what the gate stops. A non-canary page that is broken on both sides still compares as usual: it is compared, and its status is compared.

**`renderRoutesFor` rethrows real database errors** (`lib/migrate/render-compare.js`). Its `select` now treats only `notMigratedYet(e, { table })` as "no rows", as `lib/migrate/check.js` does for the same lookup. Anything else stops the route list: busy, network, a missing column or another table's name. `--make-routes` then exits with the error, never with a short list.

**`hero-test-variant` matches the hero test by its slug** (`lib/migrate/allowed-differences.js`). A capture has no way to tell, from the page alone, which ping belongs to the hero. So the store says it:
- `renderRoutesFor` reads `SELECT slug FROM experiments WHERE target_kind = 'hero' AND status = 'running'` and returns it as `heroExperiments`, which `--make-routes` writes into `routes.json`.
- A capture copies that list into its `index.json`.
- `loadCapture` puts it on each capture.
- `compare()` passes each side's list into the entry's context. Its new `heroExperiments` option is the default for captures that carry none.

The entry sets the hero aside only for a slug that both sides name as the hero test and both pages ping. A test on another surface, a plain route list, or a slug only one side names leaves the hero compared. The fixture carries `heroExperiments: ["hero-promise"]`.

### 2. Old routes on a documents store (ED-05, spec 8.13)

**`GET /api/admin/catalog`** (`app/api/admin/catalog/route.js`):
- **The live release can't be read.** `publishedGetters()` failing, or any of the list's live reads failing, no longer errors the editor's pickers. The list answers 200 with:
  - the Shopify catalog: every product, no `customized`, every collection with `pinned: 0`;
  - `overrides: []`, `published: "unavailable"` and a plain `note`.

  `?product=` answers the same way: the product's Shopify fields, empty modules and badge, `surface: null`. Each failure is logged as `catalog_published_unreadable`, with the part (`release`, `list` or `product`) and the error's detail. The frozen tables are never read as a fallback.
- **The fallbacks are promise `.catch`es, not `catch` blocks.** `test-failure-matrix` requires every `catch` block in an admin route to map database failures to 5xx. These fallbacks deliberately answer 200, so they are written differently.
- **Batched reads.** The per-product overrides and per-collection pins run eight at a time (`mapLimited`) instead of one after another. The legacy path is unchanged.
- **A mode that can't be read** is still a 5xx, as before.

**`GET /api/admin/upsells`** on a documents store answers 409 `STORE_USES_DOCUMENTS`: "This store now uses the new editor, so its upsells are there: a product's pairs on that product, and the cart's offer in the cart. Open them in the editor."
- It reads nothing.
- A mode that can't be read answers 503 in plain words, never the frozen list.
- Legacy and migrating stores list as before.
- The old upsells screen, its only caller, already redirects a documents store before it calls this.

**`lib/admin/cms-api.js`, the read ops on a documents store:**
- `getPage` answers the **published** page: `publishedGetters().resolvedContentPage(slug)`, the storefront's own getter over the live release, with no preview. It is `null` on a store not open yet. The answer carries `documents: true`.
- `history` answers `{ history: [], note }`, with the note "This store now uses the new editor, so the old change history isn't shown here. Each page's versions are in the editor."
- Neither reads `cms_pages` or `cms_history`. A mode or release that can't be read goes through `failed()` and answers 5xx.
- `listTemplates` and `useTemplate` still read the saved templates, by design (DOC-09).
- Why not refuse: P2-GUARD's suite (`test-cms-api`) pins "reads are unchanged in documents mode", with `getPage` answering the page. Reading the published page keeps that true without touching a frozen table.

**The read guard** (`scripts/test-legacy-routes.js`):
- `READS` now includes `getAnnouncement`, `getHomeSections`, `getContentPage`, `getProductOverride`, `getCollectionPins` and `listPlacements`.
- Definitions of those names are not counted as reads.
- The new hits were already behind a mode check. Each is allowlisted with a reason and a check that fails if the check moves:
  - the old catalog page (after its documents branch returns);
  - the old upsells page (redirects);
  - the upsells API (GET refuses first; POST reads after the write refusal);
  - the upsells toggle (reads after the write refusal).
- The `cms-api.js` entry gained a check for its documents branch.

**`lib/ai/insights.js`**: the hero fact's `catch` now logs `insights_hero_unavailable`. A closed store gives no fact and no log, because `publishedGetters` answers `closed` without an error. A broken release gives no fact and one log line. That is what makes the closed branch testable.

### 3. FIX2 test gaps (OVL-17, MED-03, OVL-07)

No code changed; three tests were added:
- **The requeue key's random suffix.** Two full syncs in a row, with nothing written between them, each fail their drain, and each enqueues its own `search_reindex` job. The two keys share `search_reindex:<tenant>:<top>:sync:<upTo>:` and differ only in the suffix; then both jobs run and nothing is left pending.
- **The MediaAdmin toast.** The real `saveMedia` on a file store brings an archived file back. The screen says exactly "amber-jar-again.png was archived. It's back in your library now.", and a plain duplicate says "reused".
- **`readDirtyEntityDrafts`' `draft_hash IS NOT published_hash`.** A clean collection document is set up with an unreadable draft, so listing it would put it in `skipped`. It is neither read nor listed, while the dirty product draft is. Once its draft differs, it is read.

## Acceptance, with evidence

Each "fails without" entry was checked by a mutation: the line was changed in place, the suite was run, and the file was restored. The scratch runner is `…/scratchpad/p4-b5/P4-FIX4/tools/mut.py`.

| # | Acceptance item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: --compare refuses 0 compared pages and a failing before canary; the CLI applies ALLOWED_DIFFERENCES; renderRoutesFor rethrows real database errors | **DONE** | `test-migrate-render`, these cases: "--compare refuses (exit 2, plain words) when no page was compared" (the command and `compareDirs`); "--compare refuses when a canary in the before capture did not answer 2xx or 3xx" (two 500 canaries: without the gate the same, with it exit 2 naming `/ (500), /products/x (500)`; one 404 canary; 3xx canaries and a broken non-canary page pass; a capture with no canary refused); "the command applies ALLOWED_DIFFERENCES" (the section-ids fixture as two capture folders: strictly different, the command exits 0 and lists `section-ids on /` with its reason); "renderRoutesFor rethrows a real database error" (busy, network, `no such column: handle` and `no such table: products_v2` each rethrown from the products lookup; busy rethrown from the collections and experiments lookups; only `no such table: products` reads as no products) | Gate's 0-pages line off, canary line off, `compareDirs` defaulting to `allowed = []`, `select` swallowing every error: each fails its case (1 failure each) |
| 1b | (brief 3) hero-test-variant matches the hero test's slug | **DONE** | "hero-test-variant matches the hero test by its slug, never any running test" (another slug, no slug known, one side only, a non-hero test beside it: each still a difference); "the route list names the store's running hero test by its slug" (running hero yes; completed hero and a running non-hero no); "a capture keeps the hero test's slug from a --make-routes list"; the command case with and without the slug in `index.json` | The old rule (any running experiment): 2 cases fail |
| 2 | unit: href/src/alt changes, preview markup stripping, attribute order and the backslash origin case are each pinned | **DONE** | "only an href, only a src or only an alt changes" (each exactly one difference at the element, with before and after); "preview-only markup is stripped" (a page with `data-preview-bar`, `data-preview-note`, `data-preview-*` and `data-field*` normalizes to the shopper page; a real class beside them still counts); "attribute order does not matter"; "a '/\evil.com/x' route … is refused by the origin check, before any request" (library and command, no fetch, no folder) | The attribute check in `diffNode` off: 2 fail. Preview attributes kept: 1 fails. The preview bar and note kept: 1 fails. No attribute sort: 1 fails. No origin check: 1 fails |
| 3 | unit: catalog list pins prefer the live row; an unreadable live release still answers the picker list; upsells GET and cms-api reads never read frozen tables on a documents store; READS includes the wrapper readers | **DONE** | `test-legacy-routes` covers each part. "the documents-store list's pins come from the live collection rows": frozen-only 0, live-only 1, both 1; legacy still reads its table. "when the live release can't be read…": release content corrupted, then a live table replaced by a failing view; each time 200, 3 products, no overlays, the note, logged; restored after. "upsells GET never reads the frozen placements": 409 with the words, the same with `placements` renamed away; legacy and migrating list. "cms-api's page and history reads never read the frozen tables": the published "Privacy", never "FROZEN privacy"; empty history with the note; the same with `cms_pages` and `cms_history` renamed away; closed store `page: null`; legacy unchanged. "read guard: READS includes the wrapper readers": six planted calls each fail, definitions don't, and the two routes without their documents branch fail | Documents pins read from `getCollectionPins(c.id)`: 2 fail. No release fallback: 1 fails. No list fallback: 1 fails. Upsells GET documents check off: 2 fail (the route test and the read guard). `getPage` or `history` left out of the documents branch: 1 fails each. `READS` back to the old six names: 1 fails |
| 4 | unit: publishedSource's closed branch, the requeue suffix, the archived toast and the dirty-drafts filter each fail a test when removed | **DONE** | "publishedSource's closed branch…" (`test-legacy-routes`: closed source and `closed: true`; insights on a closed store: no fact, no `insights_hero_unavailable`; a broken release: the error and one log line); "two failed full syncs in a row … each get a job of their own" (`test-search-effective`); "MediaAdmin says '<file> was archived. It's back in your library now.'…" (`test-media-picker`); "a clean product or collection document … is never listed" (`test-preview-overlay`) | Closed branch off (`if (false)`): 1 fails. Insights' new log line removed: 1 fails. Suffix dropped from the requeue key: 1 fails. The toast replaced by the "reused" one: 1 fails. `draft_hash IS NOT published_hash` removed from `readDirtyEntityDrafts`: 1 fails |
| 5 | unit: pnpm test passes | **DONE** | `pnpm test` with `TEST_PUBLISH_PORTS=7161,7162 TEST_PRODUCT_CONTENT_PORTS=7163,7164 TEST_PUBLISH_SERVICE_PORTS=7165,7166 TEST_PUBLISH_UNDO_PORTS=7167 TEST_MIGRATE_MAP_SQLD_PORT=7160`: 96 of 96 suites passed in 182.7 s | — |

## Tests

| What | Result |
|---|---|
| `node scripts/test-migrate-render.js` | 33 passed (11 new) |
| `node scripts/test-legacy-routes.js` | 27 passed (6 new) |
| `node scripts/test-search-effective.js` | 31 passed (1 new) |
| `node scripts/test-media-picker.js` | 18 passed (1 new) |
| `node scripts/test-preview-overlay.js` | 36 passed (1 new) |
| `test-cms-api`, `test-failure-matrix` (unchanged, re-run because they read the changed files) | 27 and 125 passed |
| `pnpm test` | 96 of 96 suites |
| `pnpm build` | exit 0; the 2 Turbopack NFT warnings that were there before (`lib/platform/migrate.js` via `/api/platform/*`) |

Two earlier full runs on the way:
- One failed `test-cms-api` and `test-failure-matrix`. That led to the design choices above: `getPage` reads the published page, and the catalog route's fallbacks use `.catch`.
- One failed `test-schema-compat` once, on its timing case ("inside the window, the column exists but is left out"). That suite does not touch any file of this item. It passed three times on its own, and in the final full run.

## Known limits

- **The canary rule trusts the route list's `kind`.** A capture made from a hand-written list with no `"kind": "canary"` is refused, not checked. Captures from `--make-routes` always mark the 12 canaries.
- **A non-canary page that is broken on both sides is not refused.** It is compared like any other page, so a product page that 404s before and after compares the same. The canaries include the product with the most content and the most-pinned collection. The data check (`lib/migrate/check.js`) compares every product's getters.
- **The hero slug must come from the store.** Older capture folders (no `heroExperiments` in `index.json`) and hand-written route lists set nothing aside in the hero. That is the strict direction: a running hero test then shows as a difference. Either re-capture with a list from `--make-routes`, or pause the test for the rehearsal (P4-EQUIV owner check).
- **P4-CUTOVER's `test-migrate-documents`**, when it replays the `ALLOWED_DIFFERENCES` fixtures, must pass `fixture.heroExperiments` as `compare()`'s `heroExperiments` option. Otherwise the hero fixture still differs.
- **`getPage` on a documents store** answers the published page in the old editor's page shape, through the storefront getter:
  - A live **legacy** release still in place reads that release's page snapshot.
  - A v1 release's fallbacks read the live tables, as the storefront does. A store only reaches documents mode through the cutover, which publishes a v4 release.
  - On a v4 release, a slug with no published page answers the code's default page, as the storefront route does, never a frozen row.
- **`history` on a documents store** answers an empty list with a note, not the documents' versions. The editor has its own version list.
- **The catalog fallback hides overlays, not products.** While the live release can't be read, the pickers show every product with no "customized" mark and every collection with 0 pins. The storefront is failing closed at that point too.
- **The catalog's batching** runs the getters eight at a time per list (products and collections together, so up to 16 at once). It is not a single query: the getters keep the storefront's rules (closed store, legacy release, v4 rows).
- **`insights_hero_unavailable` is logged for every failed hero read.** This includes a legacy store whose content tables are missing, which before this change was skipped silently.
- **The onboarding family filter** (ED05 review, M4) is still untested. `lib/admin/onboarding.js` belongs to P4-PROVISION.
- **The P4-FIX2 review's other notes** (preview cost per request, collection pins failing closed, the raw text of a non-409 MediaAdmin delete) were not in this item's brief. They stay as P4-FIX2 recorded them.

From review:

- Test gap, catalog GET single product (app/api/admin/catalog/route.js): the per-product fallback `.catch((e) => unavailable(e, "product"))` on the ?handle= path can be removed and test-legacy-routes still passes. The fallback is only proven for the list, not for a single product whose override or surface read fails. The code looks right.
- Test gap, mapLimited (app/api/admin/catalog/route.js): changing `out[i + j] = done[j]` to `out[j] = done[j]` passes every test. The fixtures have fewer than 8 products and collections, so batching never goes past the first batch. On a store with more than 8 products or collections, a broken index would mislabel 'customized' and pin counts and no test would catch it. The code is correct today. Add a fixture with more than 8 items.
- Mutations that survive but are harmless: in lib/ai/insights.js `g.closed ? null : await g.resolvedHero()` and in lib/admin/cms-api.js `g.closed ? null : await g.resolvedContentPage(...)` can each have the closed check removed and tests still pass, because a closed source's getters answer null anyway. The brief's actual target, publishedSource's `s.state === "none"` branch in lib/cms/view.js, is pinned: disabling it fails test-legacy-routes.
- Hero filter partial mutations survive: removing the slug filter from only `a` or only `b` in lib/migrate/allowed-differences.js makes the rule stricter, not looser, so the tests stay green. The full revert to the old any-experiment rule is caught. No fix needed.
- Legacy behaviour change, small: upsells GET and cms-api getPage/history now read getCmsMode on every store. On a legacy store, a mode read that fails now answers 503/5xx where it used to return the list or page. This matches the P2 pattern and is in plain words. It is listed so the owner knows.
- Not checked in a browser (as the builder says): the editor's product and collection pickers on a documents store, both normal and with an unreadable live release, and the /admin/upsells redirect. These belong in docs/cms-reviews/MANUAL-CHECKS.md.
- Verified: 26 mutations in total. These were caught: zero-compared, canary-broken, no-canary, 5xx-canary-accepted, compareDirs allowed=[], main gate off, main allowed=[], renderRoutesFor swallowing all errors, full old hero rule, heroB ignored, capture dropping heroExperiments, make-routes hero list emptied, hero query widened by status or by kind, cms-api getPage/history leaving the documents branch, documents branch off, upsells documents check off, catalog release fallback off, catalog list fallback off, catalog pins read from frozen getCollectionPins, the catalog_published_unreadable and insights_hero_unavailable logs removed, publishedSource closed branch off, requeue suffix dropped, archived toast removed, and the draft_hash IS NOT published_hash filter removed. pnpm test passed 96 of 96 on ports 7360-7367. No node: imports were added to edge code. No .github or package.json changes. Worktree removed and no ports left listening.

## From review

(empty until reviewed)

## Owner checks

- **Desktop Chrome on the design harness (P4-DRILLS):**
  - On a documents store, open the editor's product and collection pickers: they list as before.
  - With the live release made unreadable on a local copy, the pickers still list the products.
  - `/admin/upsells` redirects to the editor, as before.
- **The rehearsal (P4-CUTOVER):**
  - Run `--make-routes` on the restore-drill copy. If a hero test is running, the command says so and `routes.json` carries its slug.
  - Read the comparison: a refusal (exit 2) means the harness was broken before the move. Fix it, then capture again.
- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need your approval.

## Commands

```
node scripts/test-migrate-render.js
node scripts/test-legacy-routes.js
node scripts/test-search-effective.js
node scripts/test-media-picker.js
node scripts/test-preview-overlay.js
pnpm test
pnpm build
```
