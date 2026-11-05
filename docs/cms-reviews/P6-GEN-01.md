# P6-GEN-01 · How the first store is made (GEN-01)

Design notes for the first-run generator. The item's report, with acceptance and evidence, is `P6-GEN.md`.

## The parts

| Part | File | Runs where |
|---|---|---|
| Planner | `lib/first-run/plan.js` | Anywhere. Pure, edge-safe, no imports beyond the registry, `lib/cms/defaults.js` and `lib/themes/palettes.js` |
| Runner | `lib/first-run/generate.js` | Node only (reads the database and the sync state) |
| Writer | `createFirstRunDocuments` in `lib/documents/service.js` (P6-GEN-WRITE) | Node only. The only place first-run content is stored |
| Triggers | `lib/platform/worker.js` (catalog_sync), `app/api/admin/first-run/route.js`, `app/(console)/admin/(authed)/editor/page.js` | Node only |

Nothing here imports `lib/ai`. A suite test walks every static, re-export and dynamic import from `plan.js`, `generate.js` and `worker.js` and finds no path to it.

## What the planner makes

Only `doc_home` and `doc_design`. The header and footer are left without a document, which means automatic mode: the menus come from the catalog when the page renders.

**The hero:**
- Title: the store's name, cut to 60 characters at a word boundary. A blank name falls back to the hero's own default, "Welcome to our store". P6-FIX1: when there is no space to cut at, the hard cut keeps whole graphemes (an emoji, a flag, a letter with its accents), so it never leaves half a character. The limit still counts UTF-16 code units, as the validator does. The same cut is used for alt text (300) and rail titles (50).
- Highlight and badge: empty. No second button.
- Subtitle, first one that fits:
  - "Shop {a} and {b}." when two collections have products in stock;
  - "Shop {a}." when one does;
  - otherwise `DEFAULT_HERO_SUBTITLE`.

  A filled line longer than 160 characters (long collection titles) also falls back to the default.
- Empty catalog: an empty subtitle (the hero kind allows it). It is never `EMPTY_STORE_HERO_SUBTITLE`, because "Our shop is opening soon" would be wrong once the store opens.
- Button:
  - "Shop all collections" → `/collections` when a collection has products in stock;
  - "See what's new" → `#new` when there are products but no such collection (all sold out, or no collections). The planner checks that `#new` passes the button's own check in publish mode before using it;
  - none on an empty catalog.
- Image: the first in-stock product (the most-stocked collection's products first, in collection order, then the rest) whose image link starts with https, has no spaces and is 500 characters or fewer. Its alt text is the Shopify alt text, else the product title, cut to 300. Otherwise no image.

**The other sections:**
- A collections grid ("Shop by collection", 6) when two or more collections have products in stock.
- Up to two product rails, each on a collection with a known count of products in stock above 0. `pickRailCollection` is fed only those collections, with the field names it reads (`available` → `available_count`, `total` → `product_count`). Its later fallbacks, which would pick a sold-out or unknown collection, can never fire. A rail's title is the collection's title cut to 50, 8 products.
- "New arrivals" (8) whenever the catalog has products.

**What each shape gets:**

| Shape | Sections | Button |
|---|---|---|
| one | hero, rail, new | /collections |
| few, many | hero, grid, rail, rail, new | /collections |
| all_sold_out | hero, new | #new |
| no_images | hero, rail, new (no hero image) | /collections |
| long_titles | hero, rail, new (default subtitle, no hero image: its links are over 500) | /collections |
| no_collections | hero, new | #new |
| empty | hero only (empty subtitle) | none |

**The design:** `designBodyFor(paletteId)`. The runner passes `startingPaletteId(config.onboarding)`, which is the brand step's recorded palette, else slate. There are no kit presets, announcement, reviews or badge.

**summary:** `{ heroImage: { productTitle } | null, collections: [titles], rails: [titles], paletteId }`.
- `collections` is the collections the live grid shows, in its order (P6-FIX1; corrected): the same rule as `repo.getFeaturedCollections`, the grid's default source. That is every collection with at least one product, **sold-out ones included**, the most products first, then by title in code point order, up to the grid's limit (`gridCollections` in plan.js). It is empty when there is no grid. The grid is placed only when two or more collections have products in stock, but once placed it shows what getFeaturedCollections reads. The earlier text ("in stock, most stocked first") was wrong: with a sold-out collection of 10 products the grid shows it first, and the summary did not name it.
- `summarizeFirstStore` is shared by the planner and `describeFirstStore`, so the start page's copy is re-derived from the stored drafts the same way.

**Where every word comes from:** a fixed list (`WORDS`, `SUBTITLES`, `DEFAULT_HERO_SUBTITLE`), the store's name, or the founder's own catalog (collection and product titles, Shopify alt text). The provenance test checks every text value against those sources.

## Eligibility (the runner)

The checks run in this order:

| Check | Fails as |
|---|---|
| Console and editor triggers: `canEdit(actor)` (storefront.write) | `cannot_edit` |
| Documents mode | `legacy` / `migrating` |
| No live release | `live` |
| `confirmedCatalogSync().confirmed` | `catalog_not_confirmed` (with `syncReason`: none, running, failed, stalled) |
| `doc_home`: absent, generator-owned or untouched-empty (the writer's own predicates, read only) | `founder_started`, and nothing is written, not even the design |
| Sync trigger only: an untouched-empty `doc_home` | `home_left_for_founder`, nothing written |

The brief calls the first reason `read_only`. It is `cannot_edit` here, because test-shopify-boundary reads any `read_<word>` token in the source as a Shopify scope that belongs in `OAUTH_SCOPES`.

The second home check exists because the writer's `allowEmptyRefill: false` would skip the home but still write the design, and a design alone is the half-made state the plan rules out. The writer keeps `allowEmptyRefill = (trigger !== 'sync')` as a second line of defence.

These checks run **before** the writer is called. When nothing needs writing, the writer answers `written: false` without asking any guard, even on a live, legacy or migrating store. So a written:false answer never means "generated". The route reports `generated: written`.

If the writer refuses after the checks pass (the store changed mode or opened in between), the refusal maps to `ran: false` with the same reasons. A lost race (FIRST_RUN_RACE) is retried once from the top. A second race answers `race`.

**The writer is called twice: the home, then the design (P6-FIX1).** The checks are read before the writer reads its own rows, so a founder save to `doc_home` can land in between. With one call, the writer then skipped the home as the founder's and still wrote the design alone. Now:
- The first call carries only the home. If the writer skips it, the run stops with nothing written at all (not even the design), and the reason comes from the checks read again (`founder_started`, or `home_left_for_founder` on the sync trigger).
- A founder save that lands after the writer read the home makes the home's guarded INSERT or UPDATE change no row, so that batch aborts (FIRST_RUN_RACE). The retry reads the checks again and now sees the founder's home.
- Only then is the design written, in a second call. Each call is still the one writer, all or none.
- Tested in test-first-run ("a founder save between the checks and the writer…"), with a test-only seam `firstRunGenerateHooks.afterChecks` in generate.js and the writer's own `firstRunHooks.beforeBatch`.

## The triggers

| Trigger | When | Actor | `allowEmptyRefill` |
|---|---|---|---|
| Worker `catalog_sync` | A slice ends with the run `complete`, and at least 5 s (`FIRST_RUN_MIN_LEFT_MS`) of the slice's deadline is left. Otherwise it logs `first_run_deferred` and skips | none (the worker) | false |
| `POST /api/admin/first-run` | The founder asks (the start page, P6-START-UI) | storefront.write; anyone else gets 403 in plain words | true |
| Editor page render | The actor can edit, the store is documents, and the page's own `listDocuments` has no `doc_home` | the editor's actor | true |

**The worker:**
- Its call goes through `workerFirstRun.generate`, a seam the suite can replace.
- A generator error is caught and logged as `first_run_failed`. It never fails or requeues the job.
- The job result is unchanged apart from a `firstRun` field: `{ ran, written, created, refilled }`, `{ ran: false, reason }`, `{ deferred: true }` or `{ ran: false, error: true }`.

**The editor page:**
- It decides from its own single mode read and single documents read. It loads the generator with a dynamic import, written as a template literal (`` import(`@/lib/first-run/generate`) ``). Next bundles that like a plain string. The SWC-based loaders of test-editor-routes and test-product-editor only follow `require("…")` literals, so they never load the generator chain.
- After a run that wrote something, it reads `listDocuments` once more, on that branch only.
- Any error is logged as `editor_first_run_failed` and the editor opens as it would have.

**`GET /api/admin/first-run`** returns `describeFirstStore({ actor })` plus `catalogSyncProgress().view`. It needs storefront.read. A read-only person sees `eligible: false, reason: 'cannot_edit'`.

## Sync paths that are NOT hooked

These sync paths do not make the first store. Those stores generate the first time the founder opens `/admin/start` (which POSTs, P6-START-UI) or the editor:
- the console's inline slices (`lib/platform/sync-jobs.js`, when no platform queue is configured);
- the CLI's `runCatalogSync`;
- the Shopify connect callback's `after()`.

The worker hook only covers slices that run as queued `catalog_sync` jobs. The owner's end-to-end staging check covers this (below).

## Known limits

- **A sync-time refill bumps the revision of an open generator-owned draft.** If the founder has the editor open on a home that is still the generator's (never saved by them) and a later sync changes the catalog, the refill raises the revision. Their next save then gets the editor's "changed somewhere else" conflict. An unchanged catalog writes nothing (the hash skip), so only a real catalog change does this. Owner check below.
- ~~A founder save between the runner's checks and the writer's own read lets the design be written alone.~~ Closed by P6-FIX1 (home first, then the design; see Eligibility).
- **(P6-FIX1) The home and the design are two writer calls now, not one batch.** If the home's call writes and the design's call then fails (the database stops answering), the store has a generated home and no design until the next run, which creates the design. That is the state P6-OPEN's design rule already handles (with `checkOpening`, the first publish makes and offers the slate design). A founder save to `doc_home` in the milliseconds between the two calls still lets the design be written, but only right after this run wrote the home itself, so the design is never written for a home the founder had already started.
- **The fixed status colours.** `brandCssVars` always sets `--sf-success*` to the platform's lime-700/800/50/100 status colours, whatever the brand. They are not derived from the store's accent. The suite checks that no other colour variable is lime and that the status values are the same for every curated palette. Changing them is lib/brand.js's business, not this item's.
- **The editor trigger runs on every editor open of a store that has no `doc_home`**, including stores that are not eligible (catalog not in yet). That costs one dynamic import and the read-only checks, and nothing is written.
- **In test-product-editor** (an existing suite, unchanged), its store has no `doc_home`. The owner's editor render takes the generate branch, the suite's loader can't load the module, and the page logs `editor_first_run_failed` once and opens as before. The suite passes. The log line is expected.
- **The `#new` button** only scrolls when a "New arrivals" section is on the page. The planner adds one whenever it uses `#new`, and a founder who later removes that section keeps a button that doesn't scroll (as today's default hero does).
- **The worker hook also runs on a re-delivered job for a run that is already complete.** That is harmless, because eligibility is checked again and unchanged bodies are not written.

## Owner checks

- **Staging end to end** (OQ-4, throwaway tenant): connect → sync → `/admin/start`. The connect callback and inline syncs are not hooked, so check that generation happens when the page or the editor opens. Then check the home and design are made together, the hero shows the store name, and the founder's later edit is never overwritten by a sync.
- **The open-editor refill conflict:** with the editor open on a generated, unsaved home, change a product in Shopify and let a sync complete. Confirm the "newer version elsewhere" wording is acceptable.
- **A queued sync on hosted Turso** makes the store within the slice (look for `first_run` in the logs), or logs `first_run_deferred` and the start page makes it.
