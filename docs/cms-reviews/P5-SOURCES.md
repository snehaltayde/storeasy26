# P5-SOURCES: bindings are a table (TREE-01)

Branch `cms/p5-sources`, cut from `b09f342`. Batch 1, merges first (plan 0.2).

This is the author's own report. Reviewers should re-read the code.

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` 98 of 98 suites, `pnpm build` passes |
| Browser verified | Not needed for the acceptance (every item is proved by a test). A harness smoke was run instead: `DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/dev-design.js`, `GET /` 200, the home rendered its `hero`, `collections` (3 collection links) and `new` (8 product links) sections, and the harness log had no `section_binding_failed` line. Harness stopped afterwards; ports 6100 and 7100 to 7109 checked free. No desktop Chrome drill |
| Staging | NOT DONE |

## What

1. **`lib/registry/sources.js` (new).** The source table. Pure, imports nothing. Exports:
   - `SOURCES` (name -> `{ args, resolve(repo, args, ctx), prefetch?, argOf? }`)
   - `getSource`, `isSource`, `sourceNames`
   - the test seams `defineSource(decl)` and `removeSource(name)`

   It declares six sources:
   - `featured_collections`: the curated slice, or `repo.getFeaturedCollections`. A failed curated read rejects.
   - `newest_products`
   - `collection_products`: the old `railProducts` body. It takes documents pins vs legacy pins from ctx. Its `argOf` turns `{ handle, id }` into the handle.
   - `route_product`: resolves to `undefined`, so there is no data and no log.
   - `bundle_by_id`: `argOf { id } -> id`. It resolves to the entry from the prefetched Map, or `undefined`.
   - `bundles_by_ids`: `argOf [{ id }] -> ids`, in order. It resolves to every picked id in order. An id the read lacks gives `{ id, state: "missing" }`.

   The two bundle sources share one prefetch (`prefetchBundles`). It gathers the ids of every instance of both sources, dedupes them and makes one `repo.bundlesByIds(ids)` call. With no ids it makes no read. A rejection fails every bundle instance. `repo.bundlesByIds` is not in `DEFAULT_REPO` (P5-BLOCKS adds it there). No kind uses the bundle sources yet.
2. **`lib/registry/index.js`.**
   - `defineSection` now checks bindings (`checkBindings`):
     - a singular `source` becomes `sources: [source]`;
     - each binding must be `{ sources: [non-empty strings], args: [keys of its own settings] }`;
     - a source that is not in the table throws.

     The stored binding is the frozen, normalised shape.
   - `checkRegistry()` (through `checkSectionContract`) reports `<kind>: binding "<field>" names the source "<name>", which is not in the source table`.
   - The source exports are re-exported from the index.
3. **`lib/cms/section-data.js`.**
   - The resolver bodies moved to the table, and `run()` looks the source up there:
     - an unknown source gives a rejected promise with an Error whose `code` is `source_unknown`;
     - a resolver that throws synchronously becomes a rejection.
   - The catch also logs `cause` (`source_unknown` or `fault`) on `section_binding_failed`. It sets `data.bindingFailedCause[field]` too (see Known limits: not enumerable).
   - The args of every binding are now built in a first pass. Each prefetch then runs once with the args of every instance that uses it. Only after that does the per-instance loop run.
   - Unchanged: the curated and pins pre-reads, the queryCache key and the limit default. They now reach resolvers through `ctx` (`curated`, `curatedError`, `pinsByHandle`, `pinsError`, `documents`, `prefetched(fn)`).
   - The `argOf()` special case for `collection` is now the `collection_products` source's `argOf`. Registry sections only; `limit` is never passed through an argOf.
4. **`lib/registry/validate.js`.**
   - A body `section.bindings[k].source` is BINDING_INVALID in two new cases:
     - the declaration has no `sources` list (guarded);
     - the source is not in the table.
   - New message: "This <label> section is set up in a way the editor can't fix. Remove it and add it again." No existing test pinned the old words; a repo-wide grep found them only in validate.js.
5. **`package.json`.** Adds `test:commerce-blocks` and `test:bundle-form`. Both are passing placeholders: `scripts/test-commerce-blocks.js` and `scripts/test-bundle-form.js` print `placeholder: filled by P5-BLOCKS` and `placeholder: filled by P5-PANEL`. The gate goes from 96 to 98 suites.
6. **`scripts/test-sections.js`.** 14 new tests (29 in all).

`lib/cms/registry.js` and `componentFor` are untouched. Legacy declarations (singular `source`) resolve through the same table.

## Why

TREE-01: before this item, an unknown source resolved silently to `undefined`. There was no log and no registry check (plan deviation 3.1). Bundles need a page-wide prefetch, and a hard-coded if/else could not give one. With a table, adding a source is one entry, and an unknown source is an error that can be seen.

## Design notes

- **Client-safe.** `sources.js` reaches the browser through `lib/registry/index.js`. It imports no module. Resolvers only call the injected `repo` and `ctx`. An import scan in test-sections enforces this.
- **Which arg holds the bundle id.** The bundle sources read the first argument other than `limit`. A bundle binding has exactly one argument, its setting (P5-BLOCKS declares `args: ["bundle"]` and `args: ["bundles"]`).
- **One prefetch per function.** Prefetches are keyed by function identity, so the two bundle sources share one call. The prefetch promise has a no-op catch attached, so a fault is not reported as unhandled before the resolvers read it.
- **Order and timing.** Sections still resolve one after another, as before. Only prefetches run ahead.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | defineSource + throwaway kind resolves via resolveHomeSectionData; removeSource restores the table | DONE | test-sections "a throwaway source (defineSource) plus a throwaway kind…". Fails with the base `section-data.js` (the kind's data is missing) |
| 2 | defineSection throws on an unknown source; checkRegistry names kind and source after a removeSource | DONE | test-sections "defineSection refuses a source not in the table…" and "checkRegistry names the kind and the source…". Both fail with the base `index.js` |
| 3 | Runtime: a removed source gives bindingFailed [field] and cause source_unknown, logs once with that cause, reads no collections, never throws | DONE | test-sections "P5-SOURCES runtime: a source removed after registration…". Fails with the base `section-data.js` (base: silent `undefined`, no bindingFailed, no log) |
| 4 | Registry-shaped collections (3, 6) and two new instances are independent; getNewestProducts and getCollectionsByHandles each called once | DONE (regression guard) | test-sections "registry-shaped sections…". It also passes on the base, as the behaviour existed; it guards the move into the table |
| 5 | 2 bundle_by_id + 1 bundles_by_ids (of 4): one bundlesByIds call with deduped ids, order kept; a rejecting fake gives bindingFailed (fault) on all three | DONE | Two test-sections tests: 5 deduped ids in first-seen order; grid order `bun-c, bun-a, bun-gone (missing), bun-d`; fault on all three plus three log lines. Both fail with the base `section-data.js` |
| 6 | route_product: no data, no log | DONE (regression guard) | test-sections "route_product resolves to no data and no log". Passes on the base too (the old fallback also returned `undefined`) |
| 7 | Import scan of sources.js finds only pure lib/registry modules | DONE | test-sections "lib/registry/sources.js imports only pure lib/registry modules…". sources.js imports nothing |
| 8 | No registry default, empty() check, starter section or worst-case settings value holds a price or stock key | DONE | test-sections "no section setting value…". It scans every section and document type default, `starterSection` (with and without collections), `emptyBody` of every type, and the worst-case `section.settings`. It also checks each `SETTING_KINDS[k].empty` function's source for a read of a banned key. The test proves the scan bites: it finds `soldOut` in the worst-case render data |
| 9 | Existing 'every_product' case still BINDING_INVALID with the new words; still in STRUCTURE_CODES | DONE | test-sections "the existing body-binding case (source 'every_product')…". It asserts the code, the field, the exact new words, `__publishInternals.STRUCTURE_CODES.has("BINDING_INVALID")` and `alwaysBlocks`. A declared source removed from the table is BINDING_INVALID too. Fails with the base `validate.js`. test-registry-contract (not edited) passes |
| 10 | test-sections-render a6d028e fixtures byte-identical; test-release-readers unchanged | DONE | Both suites pass unchanged in the 98-suite run (`test:sections-render` 1.3s, `test:release-readers` 3.1s). Neither file was edited |
| 11 | pnpm test 98 suites, placeholders included | DONE | `98 of 98 suites passed in 195.3s`; `test:commerce-blocks` and `test:bundle-form` are listed |

How "fails without the change" was checked: each of `lib/cms/section-data.js`, `lib/registry/validate.js` and `lib/registry/index.js` was put back to `b09f342` in turn, with everything else kept, and test-sections was run:
- without section-data.js: 4 failures (items 1, 3, 5, 5);
- without validate.js: 1 failure (item 9);
- without index.js: 2 failures (item 2).

## Tests

- `node scripts/test-sections.js`: 29 passed.
- `pnpm test`: 98 of 98.
- `pnpm build`: passes. Turbopack prints 2 warnings about `./next.config.mjs` tracing the whole project. This item does not touch that file.

## Known limits

- **`data.bindingFailedCause` is not enumerable.** It is set with `Object.defineProperty(…, { enumerable: false })`. The reason: test-sections-render (owned by P5-HIDDEN this batch) pins a failing section's data as `JSON.stringify(...) === '{"bindingFailed":["products"]}'`, and an enumerable field would break it. `data.bindingFailedCause` reads normally. But a spread or JSON copy of the data drops it, and a reader then falls back to today's note. P5-HIDDEN should read it from the data object it is handed. Making it enumerable later means editing that render assertion.
- **How the bundle sources find their id.** They read the first non-`limit` argument. A bundle binding with two setting arguments would read only the first.
- **No bundle read wired yet.** Until P5-BLOCKS adds `bundlesByIds` to `DEFAULT_REPO`, a page with bundle ids would fail its bundle bindings with cause `fault` ("bundles can't be read here"). No kind binds those sources yet, so no page can have them.
- **argOf is per source now.** The old code applied `{ handle, id } -> handle` to any registry setting named `collection`, whatever the source. Now only `collection_products` does it. No registry kind binds `collection` through another source.
- **Removing a source affects stored bodies.** validate.js now checks body bindings against the live table, so a body binding to a source later removed from the table becomes BINDING_INVALID. Only tests remove sources.
- **The empty() scan reads code, not values.** `SETTING_KINDS[k].empty` is a check function, not a value, so the scan reads its source text for a property read of a banned key. Empty values themselves are covered by the defaults, starter sections and `emptyBody` scans.
- `seed-design-documents` bodies need a database and are not scanned (P5-SETTING's structural UNKNOWN_FIELD test carries that guarantee).

## From review

No review yet.

## Owner checks

- None new for this item beyond the phase list (plan section 4). It changes no shopper-visible text. The BINDING_INVALID words change only for a body binding that the writer already refuses.
- CI: this item adds nothing under `.github/`. Any CI `sqld` download still needs the owner's approval of its source and checksum.
