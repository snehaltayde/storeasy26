# P6 · GEN · The first-run generator and its triggers (GEN-01, US-01, US-04, PUB-06)

Branch `cms/p6-gen`, cut from `cms/phase-1` at `7506c9e`. Both P5-FIX2 (merge `441b44d`) and P5-DRILLS (merge `211c982`) are in that base, as the plan requires. The batch 1 items this builds on are merged there too: P6-FIXTURE, P6-PALETTE, P6-LOGO-REG and P6-GEN-WRITE.

This is the author's own report. Reviewers should re-read the code. The design notes are in `P6-GEN-01.md`.

## Files

All are in the item's list:
- `lib/first-run/plan.js` (new): the pure planner, `planFirstStore` and `summarizeFirstStore`.
- `lib/first-run/generate.js` (new): `generateFirstStore`, `describeFirstStore`, `readFirstRunCatalog` and `FIRST_RUN_WORDS`.
- `lib/platform/worker.js`: the `catalog_sync` hook, `FIRST_RUN_MIN_LEFT_MS` and the `workerFirstRun` seam.
- `app/api/admin/first-run/route.js` (new): GET and POST.
- `app/(console)/admin/(authed)/editor/page.js`: the editor trigger. It builds on P5-FIX2's version of the file.
- `scripts/test-first-run.js`: the real suite, replacing P6-FIXTURE's placeholder.
- `scripts/test-documents.js`: the two P6-GEN-WRITE review tests.
- `scripts/support/banned-copy.js`, `scripts/test-copy.js`, `scripts/test-schema-compat.js`: the P6-FIXTURE review fixes.
- `docs/cms-reviews/P6-GEN-01.md` and this packet.

Not touched: `.github/`, `package.json`, migrations (none), `lib/ai`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No new dependency.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` and `pnpm build` (see Tests) |
| Browser verified | NOT DONE. Every acceptance item is proved by a unit test. Nothing here has a screen of its own: the start page is P6-START-UI, and the drill is P6-DRILLS stage A/E |
| Staging | NOT DONE (owner check) |

## What and why

GEN-01 asks for a first store made from the catalog and a curated palette, with no AI. US-01 and US-04 ask that a founder who connects a store sees a sensible home page, including on an empty catalog and on one with no collections. PUB-06 says the system never publishes: the founder's first Publish opens the store.

This item builds three things:
- **The planner:** pure and edge-safe.
- **The runner:** it checks eligibility, reads the catalog, plans, and writes through P6-GEN-WRITE's all-or-none writer.
- **Three triggers:** the worker after a completed sync, the console route, and the editor page.

## Design

The full notes are in `P6-GEN-01.md`. In short:
- **Planner.** The hero title is the store name (cut to 60 at a word boundary). The subtitle is "Shop {a} and {b}." / "Shop {a}." from in-stock collections, else the default line, and empty on an empty catalog (never "opening soon"). The button goes to `/collections`, or to `#new` (only after it passes the button's own check in publish mode), or there is none. The hero image is the first in-stock product with an https link of 500 characters or fewer.
- **Planner sections.** A grid when 2+ collections are in stock. Up to 2 rails, only on collections with a known in-stock count above 0 (`pickRailCollection` is fed only those). "New arrivals" whenever there are products. The design is `designBodyFor(startingPaletteId(onboarding))`. Header and footer are not made, so they stay automatic.
- **Runner eligibility** (checked before the writer, because the writer's `written:false` says nothing about the store):
  - the actor can edit (console, editor);
  - documents mode;
  - no live release;
  - a confirmed sync;
  - `doc_home` absent, generator-owned or untouched-empty. A founder's home is `founder_started` with nothing written, not even the design.
  - The sync trigger never refills an untouched-empty home (`home_left_for_founder`, nothing written).

  The writer runs with `allowEmptyRefill = trigger !== 'sync'`, and FIRST_RUN_RACE is retried once.
- **Worker.** When a slice ends `complete` and at least 5 s are left, the worker awaits the generator inside a try/catch that only logs. Otherwise it logs `first_run_deferred`. The job result gains a `firstRun` field only.
- **Route.** GET returns `describeFirstStore` plus the sync view (storefront.read). POST runs the console trigger (storefront.write). A signed-in person who can't edit gets 403 with plain words. `generated` is the writer's `written`, so an unchanged second run is never reported as generated.
- **Editor page.** It decides from its own single mode read and single documents read. Only for an actor who can edit, on a documents store with no `doc_home`, it calls the generator through a dynamic import written as a template literal. Next bundles that like a string. The SWC test loaders follow only `require("…")` literals, so they don't load the generator chain. After a write it reads the documents once more. Errors are logged, never thrown.

**Deviation from the brief:** the "can't edit" reason is `cannot_edit`, not `read_only`. test-shopify-boundary reads any `read_<word>` token in the source as a Shopify scope (`SHOP-01: there is one scope list`). That suite isn't this item's, and keeping its rule whole is better than an allowlist entry.

### P6-FIXTURE review fixes

- **`#1` rule:** now `#\s?1(?![0-9a-f])`, so hex colours such as `#1a2b3c` and `#1e3a8a` are not claims. "#1 choice" and "#1 in India" still are.
- **`stars` rule:** now a rating, not the word: "5 stars", "4.5-star", "4/5 stars", "five-star", "star rating". "Night stars candle" is no longer a claim.
- **Two new helpers:**
  - `documentTexts(body)` reads only the shown text props, using the registry's setting kinds: text, rich_text, paragraphs, a button's label, an image's or logo's alt. It never reads tokens, ids, handles or links.
  - `scanDocumentText(body, { catalogWords })` blanks the founder's own catalog words and store name before scanning.
- **test-schema-compat:**
  - The refusal test removes `.test-compat-p6-bad-tenant.db` first.
  - A new test plants a `cms_blocks` row right before the fixture's `applyContentMode` and expects the fixture to refuse with provisioning's reason ("already holds store content"). The plant goes through a module hook that wraps the fixture's own import of provision.js, so a raw `UPDATE cms_state` in the fixture would fail the test. The new test also leaves a leftover bad-tenant file behind on purpose, so the next test proves the heal.

### P6-GEN-WRITE review tests

- `document_refs`: a body with `/api/media/med_aaaa1111` is indexed on the create's version, and `/api/media/med_bbbb2222` on the refill's version.
- A founder home edited and then taken back to the empty body (revision 3, the empty hash) is skipped as `founder`.

## Acceptance, with evidence

Before this item, `scripts/test-first-run.js` was P6-FIXTURE's placeholder. None of its tests existed, and `lib/first-run/` didn't exist, so every item below fails without the change. Mutation runs (one change at a time, then restored) are listed where they matter.

| # | Acceptance item | State | Evidence |
|---|---|---|---|
| 1 | Every fixture shape: doc_home and doc_design validate in publish mode with 0 errors (validateDocument + referenceChecks); no COLLECTION_EMPTY; hero title ≤ 60; no rail on 0 available | DONE | test-first-run, eight tests "`<shape>`: the generated doc_home and doc_design validate…", one per shape, on fixture stores synced by the real `runCatalogSync`. They also pin each shape's sections, button and image. Mutation: rails/grid without the in-stock filter → `all_sold_out` fails |
| 2 | publishSet of the generated set (publish service, no checkOpening) succeeds; the live accent is not lime; brandCssVars has no lime-family hex | DONE, with one stated exception | "publish of the generated set…": `Pub.publish` of both documents, then the shopper's `resolvedBrand` is slate's accent, and `isLimeAccent` is false. Exception: `brandCssVars` always sets the four `--sf-success*` status colours to the platform's lime-700/800/50/100, for every brand (lib/brand.js STATUS roles, not this item's file). The test checks that no other variable is lime, that the same check flags the lime default, and that the status values are identical for all six palettes. **Owner decision:** accept the fixed lime status colours, or ask for a lib/brand.js change |
| 3 | After that publish the header lists the catalog's collections (auto) and the footer renders; an empty header made through createDocument (mode auto) keeps the catalog menu; no_collections publishes valid with its CTA | DONE | "after that publish the header (auto mode)…": the real `Header` and `Footer`, compiled with SWC and given what the layout gives them (`getAllCollections`, `resolvedNav`). The empty header is created, published, and the header markup is byte-identical. "no_collections publishes valid with its '#new' button" |
| 4 | No API key, and separately a spent budget: generation succeeds, the fetch spy sees 0 requests to api.anthropic.com, and there is no import path to lib/ai (static scan) | DONE | Three tests in "3. no AI". The budget test sets `ai_budget_tokens: 100`, records 200 `ai_tokens` on the platform ledger, checks `aiBudget().remaining === 0`, and sets a dummy key. The scan walks static, re-export and dynamic imports from plan.js, generate.js and worker.js. It also checks that plan.js's graph has no Node-only import and no `process` or `require` |
| 5 | scanText over every generated text: no BANNED or CLAIMS hit; provenance; the empty hero has no "opening soon" | DONE | "banned copy: scanDocumentText…" (shopper rules on, the founder's catalog words left out, the fixed words scanned on their own) and "provenance: every text value…". Mutation: the empty catalog given the default subtitle → fails |
| 6 | Refuses for sync none / partial / failed, legacy, migrating, live, and a read-only actor (console and editor), nothing written; a founder home is founder_started with no design; twice = unchanged | DONE | "it refuses, writing nothing…" (storage dumped before and after, 0 documents, plain words scanned), "a founder-written doc_home…", "running twice…". Mutations: dropping the live check, the confirmed-sync check, the canEdit check or the founder check each fail a test |
| 7 | Empty catalog → hero only; a second confirmed sync refills the untouched home with sections; a revision-1 empty editor home is refilled by console, not by sync | DONE | "an empty catalog generates a hero-only home…" (a real second `runCatalogSync` with the `few` catalog) and "a revision-1 empty doc_home…". Mutation: dropping `home_left_for_founder` → fails. Surviving mutation: `allowEmptyRefill: true` for sync, because the runner's own check stops it first (the writer flag is a second line) |
| 8 | Worker: a completed run calls the generator; a thrown error doesn't fail or requeue; under 5 s it skips and logs first_run_deferred | DONE | Three "worker:" tests through the real `runJobById` and the real `catalog_sync` handler on fixture runs. Mutations: removing the 5 s check, or rethrowing in the catch, each fail |
| 9 | test-editor-routes, test-product-editor and test-provision render the page unchanged; no doc_home + an editor generates before render; read-only doesn't | DONE | The three suites pass unchanged (34, 29 and 33 passed). test-first-run "editor page: compiled alone…" (only page.js is compiled; one mode read, one documents read, 0 generator loads on a store with doc_home), "…generates before render…" (two documents reads, documents made by system:first-run, read-only: no load, nothing written), and "…a generator failure…never fails the page". Mutations: dropping the `editable` guard, the re-read, or the catch each fail |
| 10 | The route passes the catch-order walk, the tenantHandler walk and the literal-link walk; pnpm test passes | DONE | test-failure-matrix, test-console-fresh and test-legacy-routes pass with the new route in their walks. Route behaviour: test-first-run "route: GET … POST … 403 …" (real sessions; support member, cross-origin, owner, a second run not "generated", live store). `pnpm test` below |
| 11 | Refs on create and refill; a reverted founder home is skipped; written:false on a live store is never "generated" | DONE | test-documents "document_refs: …" (fails with refsFor removed from the create path, M1b, or from the refill path, M1) and "a founder-edited doc_home taken back…" (fails with the revision-1 term removed, M6). test-first-run: the live store answers `ran:false` with no `written` key, describe says `generated:false`, and the route on a live store answers `generated:false, reason:'live'` |
| 12 | '#1a2b3c' and 'Night stars candle' are not claims; test-schema-compat heals a leftover file and pins applyContentMode | DONE | test-copy "CLAIMS: '#1a2b3c' and 'Night stars candle'…" (fails on the old banned-copy.js: "#1a2b3c flagged"). test-schema-compat "P6-GEN: makeTenant({ mode: 'documents' }) uses applyContentMode…" (fails when the fixture does a raw UPDATE: "called applyContentMode once: expected 1, got 0"). The refusal test fails without its pre-run `rm` once the leftover is there |

## Tests

- `pnpm test`: "Running 102 test suites", **102 of 102 passed** in 203.0 s, exit 0. The first full run had 2 failures, both fixed:
  - test:shopify-boundary read the reason `read_only` as a Shopify scope (now `cannot_edit`);
  - test:publish-service's "archive is terminal" grep read `out.set(…)` followed by `archived_at == null` in generate.js as an `archived_at` writer (the row mapping now lives in its own function).
- `pnpm build`: passes, exit 0, with `/api/admin/first-run` listed as a dynamic route. Its 2 Turbopack warnings are the existing NFT-trace warnings through `lib/platform/provision.js` and `app/api/platform/tenants/route.js`, which this item doesn't touch.

- `node scripts/test-first-run.js`: 29 passed, 0 failed (about 3 s).
- `node scripts/test-documents.js`: 60 passed (58 before).
- `node scripts/test-copy.js`: 55 passed (54 before).
- `node scripts/test-schema-compat.js`: 50 passed (49 before).
- The port-taking suites were pinned to 6100 and 7100 to 7109, and nothing was left listening.

## Known limits

- See `P6-GEN-01.md`. The main ones:
  - A sync-time refill bumps the revision of an open, generator-owned draft, so the founder's next save gets the "changed somewhere else" conflict. This only happens when the catalog really changed.
  - The console's inline slices, the CLI's `runCatalogSync` and the connect callback are not hooked. Those stores generate on the founder's first visit to `/admin/start` or the editor.
  - The fixed lime `--sf-success*` status colours (acceptance 2).
  - ~~A founder save in the millisecond window between the checks and the writer's read can leave a system design draft beside the founder's home.~~ Closed by P6-FIX1: the home is written first, on its own, and the design only after the writer did not skip it (P6-GEN-01.md, Eligibility).
- test-product-editor's store has no `doc_home`, so its owner render takes the generate branch, the suite's loader can't load the module, and it logs `editor_first_run_failed` once. The page opens and the suite passes unchanged.
- **CLAIMS still matches words, not meaning.** It now leaves out the founder's catalog words, which reduces false hits but doesn't make it understand meaning.

From review (each item's P6-FIX1 outcome is in docs/cms-reviews/P6-FIX1.md):

- The 'what was made' summary can name different collections from the ones the grid shows. summarizeFirstStore (lib/first-run/plan.js ~l.228) lists collections with stock, most stocked first. The live grid comes from repo.getFeaturedCollections (lib/repo.js l.38), which orders by total product count, then title, and includes sold-out collections. Example: A has 10 products and 0 in stock, B has 3 in stock, C has 2. The grid shows A, B, C (A is a sold-out card), but the summary says B, C. P6-GEN-01.md l.56 says the summary is 'the grid's collections', which is not true. Every fixture collection is fully in stock, so no test sees this. Fix: build the summary from the grid's own read, or correct the packet before the start page uses it.
- Acceptance item 2 ('brandCssVars contains no lime-family hex') is met only with an exception. The fixed --sf-success* status colours (lib/brand.js l.247-250) are lime-700/800/50/100 for every brand. The builder reported this openly and the test excludes those variables. The brand accent is slate and no brand-derived variable is lime. This stays an owner decision as the builder listed it.
- cutWords (plan.js l.78) hard-cuts by UTF-16 code units when there is no space within the limit. An emoji at the cut leaves a lone surrogate, which shoppers see as a broken character. Reproduced: siteName 'A'+40 tea emoji gives a 60-character hero title ending in \ud83c. Alt text over 300 characters gives the same result. Publish validation lets both through. This needs a long name or title with no space near the limit, so it is rare. Fix: cut with Array.from or Intl.Segmenter.
- Surviving mutations (test gaps, the code is correct today). Planner: the https image check removed (no fixture has an http image); the hero title cut removed (fixture site names are short, so the <=60 limit is never tested on a long name); 'top collection first' image ordering removed; the alt fallback to the product title removed; the unknown-count (null available) rail filter loosened (readFirstRunCatalog always computes counts). Generator: archived rows not classed as founder; the FIRST_RUN_RACE retry set to zero (the retry is untested); describeFirstStore.noCollections changed; generate.js classify loosened to accept an empty body at any revision (G18). On G18, a founder home reverted to the empty body would then reach the writer through the console trigger. The writer skips the home but writes doc_design, and test-first-run does not catch it (test-documents only covers the writer). Also untested: the mode check (the writer's own guard covers it, so legacy and migrating stores still write nothing), worker status 'complete' versus any done status (the generator refuses an unconfirmed sync anyway), and the route's audit call.
- banned-copy: in scanDocumentText, removing the catalog-word blanking (B3) and widening documentTexts to every string setting (B4) both survive test-copy and test-first-run. 'Night stars candle' no longer matches the new stars rule anyway, so the blanking is never really exercised. The stars rule was also loosened for every repo-copy scan: a lone 'stars' is no longer a claim anywhere. The '#1' rule uses /i, so (?![0-9a-f]) also lets '#1Best' or '#1Brand' through.
- Brief deviation: the read-only reason is 'cannot_edit', not 'read_only'. It is justified, because test-shopify-boundary's READ_SCOPE_TOKEN matches read_<word>. Later items (the start page) must use 'cannot_edit'.
- Small race: eligibility is read before the writer reads its rows. A founder save to doc_home, or the editor creating an empty doc_home with the sync trigger, can land in that gap. The writer then skips the home but still creates doc_design. The window is milliseconds, but it does not strictly follow 'write NOTHING when the founder started'. It is not listed in the known limits.
- The worker generator call has no time box. Once it starts with 5 s or more left, it can run past the slice deadline. If the lease expires, the run is repeated, which is safe because the writer is idempotent. The packet could say so.

## Owner checks

- **Staging, end to end (OQ-4):** connect a throwaway tenant, then sync. Check that `/admin/start` or the editor makes the store, because inline and connect-callback syncs are not hooked. Check the home and design are made together, and that a later sync never overwrites a founder edit.
- **Open editor + sync refill:** confirm the conflict wording is acceptable.
- **The `--sf-success*` lime status colours** on a generated store: accept them, or ask for a change in lib/brand.js.
- **A queued sync on hosted Turso** generates within the slice, or logs `first_run_deferred` and the start page makes it.
- **CI sqld download:** unchanged. The approval of its source and checksum is still the owner's. Nothing under `.github/` was touched.

## Commands

```
node scripts/test-first-run.js
node scripts/test-documents.js
node scripts/test-copy.js
node scripts/test-schema-compat.js
pnpm test
pnpm build
```
