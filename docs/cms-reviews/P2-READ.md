# P2-READ: the version 4 shopper reader, next to a frozen legacy reader

Branch `cms/p2-read`, cut from `2009c8f`. Plan: `docs/cms-reviews/P2-PLAN.md` (batch 3, decisions 4, 5, 9, 11 and 15, section 3, section 6). Spec: PUB-01, PERF-01 and DOC-07 (section 7), sections 8.4 and 8.7. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:release-readers` 27 passed, 0 failed (about 1.4 s). `pnpm test`: 66 of 66 suites passed in 108.4 s (see Tests). 21 deliberate breaks, all caught (see "Do the tests bite?"). `pnpm build` passed, with only the 2 warnings that were already there (`next.config.mjs` traced through `lib/platform/migrate.js`) |
| Browser verified | Yes, on the design harness on this Mac (ports 3720 and 4720 to 4722), in the Claude desktop app's built-in browser (Chromium) at 1440 x 900, on the edge runtime (`x-edge-runtime: 1`). Not Safari, not a phone. See "Browser evidence" |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No tenant changed mode. No migration |

No real store is moved to documents mode. Only test stores in the suites, and the harness store for the length of the drill, have a v4 release.

## What and why

A version 4 release is a small list of document versions, not a snapshot of content (PUB-01, spec 8.4). Until now the reader refused it (P2-VGATE's `READER_NOT_READY`). This item reads it, route by route, and reads only the versions each route needs (PERF-01). The v1 to v3 rules are moved, unchanged, into their own frozen file, so the new reader can grow without touching what legacy shoppers see.

## The design

**`lib/content/legacy-release.js`** (new, pure, edge-safe). The live branches of every getter as they were at `2009c8f`, moved word for word into pure functions of the release `content` (`legacyAnnouncement`, `legacyHero`, `legacyHomeSections`, `legacyNav`, `legacyCollectionsIndex`, `legacyPdpExtras`, `legacyContentPage`, `legacyContentPageList`, `legacyBrand`, `legacyTheme`, `legacySurfaceTemplates`, `liveBlock`) plus the four S53 presentation helpers. What needs the database (healing renamed handles, the v1 fall-back to live tables) stays in `resolve.js`. **`lib/content/presentation.js`** is now a re-export shim.

**`lib/content/documents-reader.js`** (new, edge-safe: React `cache`, `../db.js` and pure modules only).
- `ContentUnavailableError` and `isContentUnavailable` now live here, so the reader can throw them; `resolve.js` re-exports them, so every existing import is unchanged.
- `parseList(content)` checks the v4 shape (`isV4List`), `m` (a whole number of 1 or more) and every entry (`null` or `{version: "ver_…", hash}`). For every registered singleton missing from `documents`: an error (`MISSING_SINGLETON`) when its `sinceManifest <= m`, otherwise an explicit `null` (code default). Any other problem is `BAD_LIST`.
- `liveVersions(ids)`: one `SELECT … FROM document_versions WHERE id IN (…)`, memoized per request by React `cache` keyed by the sorted ids joined into one string. A version missing from the answer is read again **once** (only the missing ids, for replica lag), then `MISSING_VERSION`. Each body is parsed and checked: a body from newer code (`schema` or `schema_version` above the registry's `SCHEMA_VERSION`) is `UNKNOWN_SCHEMA`. Bodies are upgraded in memory with `upgradeBody` (the registry's `migrate` steps); the stored row is never rewritten.
- `documentBodies(list, ids)` returns `{doc_x: body | null}` for a fixed set; the version row must belong to that document, and a singleton's body must be of its type (`VERSION_MISMATCH`).
- Fixed sets, so each part of the storefront costs one statement: `CHROME_DOCUMENTS` (header, footer, announcement, design), `HOME_DOCUMENTS` (home and collections index, which the home page reads together), `PRODUCT_LAYOUT_DOCUMENTS`, `COLLECTION_LAYOUT_DOCUMENTS`, `CART_DOCUMENTS`. `doc_cart` is not in the chrome set: `chromeData` doesn't use it.
- Mappers turn each body into the shape the getter already returns, so components are unchanged: announcement settings to `{enabled, text, href}`; header and footer `mode: "auto"` to `null` (the catalog menu) and `"custom"` to the item list (`[]` stays `[]`); the hero section to the legacy hero (through `settingsToLegacyHero`); home sections back to the legacy home shapes; page sections back to `text`/`rich`/`image`/`faq`; collections index to handles plus the `ids` sidecar `healCollectionsIndex` reads; product layout sections to PDP accordions; design to `{brand, theme}`; journal index entries.

**`lib/content/resolve.js`.**
- `contentSource()` on v4 returns `{mode: "live", v: 4, list, releaseId, content: null, preview: false}` (the list already checked by `parseList`). v1 to v3 return exactly what they did.
- When the state is `none`, it reads `cms_state` through `getCmsMode()` (`lib/cms-mode.js`): `legacy` (also a store from before 0021, with no table) and `migrating` keep today's draft path; `documents` throws `DOCUMENTS_UNPUBLISHED`; any read error throws `CMS_MODE_UNAVAILABLE`; any other stored value throws `UNKNOWN_CMS_MODE`. Never legacy drafts on a guess.
- Every one of the 17 getters has a v4 branch before its legacy branch:

| Getter | v4 source |
|---|---|
| `resolvedAnnouncement`, `resolvedNav`, `resolvedBrand`, `resolvedTheme`, `resolvedSurfaceTemplates` | the chrome set, one statement. `resolvedSurfaceTemplates` returns `{header, footer}` only |
| `resolvedHero`, `resolvedHomeSections`, `resolvedCollectionsIndex` | the home set, one statement. An empty published home gives `[]`, never `DEFAULT_HOME_SECTIONS` (DOC-07) |
| `resolvedPdpExtras`, `resolvedSurfaceTemplateFor("pdp")` | `doc_product_layout` |
| `resolvedSurfaceTemplateFor("collection")` | `doc_collection_layout`; every entity gets the family default |
| `resolvedContentPage(slug)` | the `list.pages` row, then that page's version only; else the journal index entry, then that post's version; else the code default page |
| `resolvedContentPageList()` | `list.pages` plus the code default pages. No body, never the journal index |
| `resolvedCartUpsell` | `doc_cart` (title and products; a product picked by handle only is looked up in the catalog) |
| `resolvedSlugRedirect` | `list.redirects`; a page (or journal post) at the same slug wins |
| `resolvedProductOverride`, `resolvedCollectionPins`, `resolvedPdpPairs` | neutral empties. Pairs pass an empty placement set, so the placements table is never read; the automatic same-collection strip still comes from the catalog, as on a v2 or v3 release with no pairs |

- **`resolvedJournalEntries()`** (new). v4: the `indexes.journal` version, read once, filtered with `campaignVisible` on the index's own fields; no post body is read. Legacy: today's loop over `resolvedContentPageList()` plus `resolvedContentPage()`, so the output is unchanged.
- **`resolvedHomePage()`** (new): registry-shaped sections, the hero included. v4: the shown sections of `doc_home`, kinds the registry knows, product rails healed to the catalog's current handle. Legacy (and preview): built from `resolvedHero()` and `resolvedHomeSections()` through `legacyHeroToSection` and `legacyHomeSectionsToSections`, so the S59 candidate overlay and `healHomeSections` apply. Experiments are left to the page.

**`app/sitemap.js`** and **`app/(storefront)/journal/page.js`** call `resolvedJournalEntries()` instead of their own per-post loops.

**Route handlers** (`/api/upsell`, `/offline`, `/manifest.webmanifest`) needed no change: they call the getters. Their `cache()` is a no-op, so each pays its reads (plan 2, spec 8.7).

**`scripts/test-releases.js`**: one P2-VGATE case expected `READER_NOT_READY` for its stand-in v4 row (`{v: 4, list: {...}}`). That row is not a v4 list, so it now fails closed as `BAD_LIST`; the case and its comment were updated. Every other case is unchanged.

**`scripts/test-schema-compat.js`**: its own pin `READ_BEFORE_DOCUMENTS = "0020_sync_runs_resumable"`, next to P2-GUARD's `BEFORE_DOCUMENTS`, and part 5 (below).

## Acceptance

All in `scripts/test-release-readers.js` unless named. "Break" refers to "Do the tests bite?".

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | A v4 fixture through all 17 `resolved*` getters, `resolvedJournalEntries` and `contentSource` returns the expected content | **Pass** | "a v4 release built with commit.js: …". The store is published through the real `commitPublishBatch` with registry bodies (each validated in publish mode first): every singleton, a page, a hidden page, a campaign, a redirect and a journal index with a shown, a scheduled and a switched-off post. The suite checks it calls exactly the 17 exported getters. Also: the config brand never leaks, no legacy table is read, the route handlers answer from `doc_cart` and `doc_design`, and the real layout and checkout render the v4 chrome and policy link. Fails without the change: break M1 (the base's `READER_NOT_READY`) fails 19 of 27 |
| 2 | v1, v2 and v3 give identical getter outputs before and after the move; the legacy sitemap and journal listing equal `a6d028e`'s | **Pass** | "v1, v2 and v3 fixtures …" runs P2-VGATE's recorder and compares with `scripts/fixtures/legacy-release-outputs.a6d028e.json`. "the legacy sitemap and /journal listing …" runs the new `scripts/support/legacy-journal-outputs.js` (drafts, then a v3 release with its own posts) and compares with `scripts/fixtures/legacy-journal-outputs.a6d028e.json`, which I recorded by running the same file inside an `a6d028e` checkout. Today's output is byte-identical to it. Break M15 (one changed rule in `legacy-release.js`) is caught |
| 3 | A v4 entry still missing after one re-read throws, never a draft or default; missing on the first read and present on the re-read renders; a v5 row is an error | **Pass** | "… missing on the first read but present on the re-read renders" (two version reads; the second asks only for the missing id). "… still missing after one re-read throws …" (exactly two reads, a draft present and not served; also a list naming a version that was never written). "a v5 row is an error; a version body written by newer code (schema 2) …". Breaks M2, M3, M17 |
| 4 | A singleton with `sinceManifest` m+1 missing from an older v4 row is the code default; one with `sinceManifest <= m` missing is an error; an explicit null is the code default; `emptyList` plus one policy page renders every getter at its code default | **Pass** | "a singleton with sinceManifest m+1 …" registers `promo_strip` (sinceManifest 2) in the test, reads an m=1 row (default, the row still renders), then an m=2 row without it (`MISSING_SINGLETON`) and with an explicit null. "a required singleton … missing …" removes `doc_header`. "a list made by emptyList plus one policy page …" checks each getter's exact default. Breaks M4, M5 |
| 5 | `doc_home` published with zero shown non-hero sections renders no `DEFAULT_HOME_SECTIONS` | **Pass** | "doc_home published with zero shown sections …" (a hero plus a hidden section gives `[]`). Break M6 |
| 6 | Documents mode, no release: `DOCUMENTS_UNPUBLISHED`; legacy, no release: drafts as today; no `cms_state` table: legacy; a `cms_state` read error (broken view): `ContentUnavailableError`, never legacy drafts | **Pass** | Three tests in part 5. The broken view is a `cms_state` view over a dropped table; all 24 getter calls fail closed with a draft saved. Breaks M7, M8 |
| 7 | (request-cache stub) The REAL layout `chromeData` plus the home page issue at most 3 content statements, same count and identical byte totals at 0 and 1,000 journal documents; `chromeData` and checkout `policyLinks` read no page bodies and never the journal index; a policy page reads only its own version | **Pass** | The real `app/(storefront)/layout.js`, `page.js` and `checkout/page.js` compiled with Next's SWC and rendered inside one `runRequest`. Home: 3 content statements (pointer and list, the chrome set, the home set), the same 3 and the same bytes at 1,000 posts. The layout reads only chrome versions; checkout reads no version. A policy page: 2 content statements, its own version only. Breaks M9, M11 |
| 8 | (request-cache stub) `app/sitemap.js` with 200 posts reads the journal index once, no per-post read; `/journal` likewise | **Pass** | Imports the real `app/sitemap.js` and renders the real journal page: one version read each (the index), 199 posts listed (one is scheduled). Breaks M16, M21 (sitemap and journal page put back on a per-post loop), M10 |
| 9 | Product overrides, collection pins and PDP pairs on v4 are neutral empties and never query `product_overrides`, `collection_overrides` or `placements` | **Pass** | "product overrides, collection pins and PDP pairs on v4 …" watches every statement. The legacy tables hold rows that would show. Break M12 |
| 10 | `resolvedHomePage` on a legacy tenant matches `resolvedHero` plus `resolvedHomeSections`, also with an S59 preview candidate | **Pass** | Drafts, a v3 release, and a real preview token plus `setPreviewCandidate` (the candidate's hero and rail show, the rail healed). Break M13 |
| 11 | A scan finds no `node:*` import in `lib/content/*` or `lib/cms-mode.js` | **Pass** | Scans those files, and walks every relative import of both readers. The walk allows only `node:async_hooks`, which Next's edge runtime provides and `lib/tenant-context.js` already uses on every edge page. Break M14 |
| 12 | (test-schema-compat) A tenant at 0020 renders legacy content unchanged | **Pass** | `test:schema-compat` part 5: a tenant at `READ_BEFORE_DOCUMENTS` and a current one with the same content give the same output from 16 getters (drafts, no `cms_state` table), then again after a real `createRelease` (a v3 release). Break M18 (a missing `cms_state` table read as an error) fails it |

### Requirements

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| PUB-01 | A v4 row through every getter; a missing version is the error page; an unknown version is an error; the manifest rule and explicit null. Hashing is unchanged (`stableStringify`, `sha256Hex`, P2-ATOM) | Nothing in phase 2 writes v4 rows for real stores until P2-PUBLISH |
| PERF-01 | Unit counts: home 3 content statements independent of post count and size; sitemap and `/journal` one index read; footer and checkout read no bodies | Real-Next counts: P2-PERF (`perf-dbcount`). Hosted numbers: owner check |
| DOC-07 | The hero section, with its image, is read from `doc_home`; an explicit empty home shows no default sections; `resolvedHomePage` | Rendering the hero image (P2-SECTIONS). Editor UI (ED-02). Experiments after migration (P2-WRITERS, MIG) |

## Do the tests bite?

Each break was applied alone to the finished code and its suite run (script: my scratch folder, `mut/run.py`), then the file restored.

| # | Break | Caught by |
|---|---|---|
| M1 | v4 throws `READER_NOT_READY` (the base) | 19 tests |
| M2 | no re-read | both replica tests |
| M3 | a missing version reads as default | "still missing after one re-read" |
| M4 | a missing singleton is always default | both manifest tests |
| M5 | a missing singleton is always an error | the later-singleton test |
| M6 | an empty home falls back to defaults | the DOC-07 test |
| M7 | a `cms_state` read error serves drafts | the broken-view test |
| M8 | documents mode with no release serves drafts | the `DOCUMENTS_UNPUBLISHED` test |
| M9 | the page list loads the journal index | 3 tests (getters, home count, chrome reads) |
| M10 | journal entries read each post | the getters test |
| M11 | each chrome getter reads its own set | home count, chrome reads |
| M12 | v4 overrides fall back to the table | 4 tests |
| M13 | `resolvedHomePage` ignores the candidate | the legacy home-page test |
| M14 | `import "node:fs"` in the reader | the scan |
| M15 | one legacy rule changed | the `a6d028e` comparison |
| M16 | the sitemap back on a per-post loop | the sitemap test |
| M17 | no schema check | the v5 / schema 2 test |
| M18 | a missing `cms_state` table is an error | `test:schema-compat` (and an older product page case there) |
| M19 | a redirect beats a page | "a page beats a redirect" (added after this break first survived) |
| M20 | a version of another document accepted | "… belongs to another document …" (added after this break first survived; before, the type check behind it caught the only case) |
| M21 | the journal page back on a per-post loop | the `/journal` count |

## Browser evidence (`docs/cms-reviews/drills/P2-READ/`)

Design harness, this branch, `DESIGN_PORT=3720 DESIGN_SQLD_PORT=4720`. A helper in my scratch folder (`helpers/v4-drill.mjs`) published a v4 release on the harness store through `commitPublishBatch` (header, footer, announcement, design, home, a shipping page, a journal index with a shown and a scheduled post), then put the seeded v3 pointer back.

| Page | Live release | What showed |
|---|---|---|
| `/` | v4 | Bar "V4 drill: read from documents", menu "V4 Serums / V4 About", hero "Read from **documents**" with "This hero comes from doc_home" and "Shop V4", section "V4 new arrivals" with the catalog's products. `x-edge-runtime: 1` (`home-v4-1440.jpg`) |
| `/policies/shipping` | v4 | "V4 Shipping", "From a page version", "Orders ship from the v4 page body." Footer "V4 Footer link", "V4 Shipping" (`policy-v4-1440.jpg`) |
| `/journal` | v4 | "V4 hello post, 1 January 2025" only; the scheduled post is absent and `/journal/v4-later` is 404 (`journal-v4-1440.jpg`) |
| `/sitemap.xml` | v4 | `/journal` and `/journal/v4-hello` only |
| `/` | v3 again | The seeded store: "Festive sale …", "Skin first. Makeup second." (`home-v3-restored-1440.jpg`) |

The harness was stopped afterwards; ports 3720 and 4720 to 4729 are free.

## Tests

- `scripts/test-release-readers.js` replaces the P2-ATOM placeholder (same script name, `package.json` unchanged): 27 tests, about 1.4 s.
- `scripts/test-schema-compat.js`: +2 tests and the `READ_BEFORE_DOCUMENTS` pin (32 passed).
- `scripts/test-releases.js`: one expectation changed (see the design).
- New support: `scripts/support/legacy-journal-outputs.js` and its fixture `scripts/fixtures/legacy-journal-outputs.a6d028e.json`.
- `pnpm test`: 66 of 66 suites passed in 108.4 s (`test:release-readers` 1.5 s, `test:schema-compat` 2.3 s, `test:releases` 1.3 s). `pnpm build` passed.

## Known limits

- **The home page's product rails read `collection_overrides` directly** (`lib/cms/section-data.js` through `getProductsInCollection`), on every store and outside any release. That is today's behaviour for legacy stores; on a v4 store it is a legacy table read on the shopper path. Not in this item's files: P2-SECTIONS (which moves rails to the renderer map) or OVL should pass the v4 pins (none). The count test names and counts this read separately.
- **`resolvedHero()` returns `null` on v4 when the home page shows no hero** (DOC-07 lets the founder hide it). Today's `app/(storefront)/page.js` expects a hero object and would show the error page. P2-SECTIONS moves the home page to `resolvedHomePage()`, which handles it. No v4 store can hide its hero before then (nothing writes v4 for real stores).
- **Kinds today's renderers can't show are left out on v4**: on the home page `text` and `faq`; on pages `banner`, `collections`, `new`, `product_rail`; in PDP accordions everything but rich text, text and FAQ. `resolvedHomePage()` keeps them all. P2-SECTIONS renders every kind.
- **`resolvedSurfaceTemplates()` on v4 holds only `{header, footer}`.** The layout is its only caller. Product and collection templates come per route from `resolvedSurfaceTemplateFor`, so the layout never loads the layout documents. Per-entity templates read as the family default until OVL.
- **`/collections` loads `doc_home` too**, because `resolvedCollectionsIndex()` uses the home set (that is what keeps the home page at 3 statements). One statement, a bounded extra body.
- **A journal post costs 2 version reads** (the index, then the post). A slug that is not a listed page (a code default page, or a 404) reads the journal index once before the code default. One read for the post alone needs the index cached by release id (spec 8.7's instance cache), later.
- **The redirect check reads the journal index** when a redirect matches, to let a post at the same slug win. Only `journal/[slug]` calls it, after it has already read the index.
- **No hash check per entry.** The reader trusts the list's `{version}` and checks the row's document and type; it does not recompute each body's hash on every request.
- **Preview on a documents store still serves legacy drafts** (`contentSource` takes the preview path first, as before). P2-PREVIEW owns the overlay and must ignore legacy tokens on documents stores (plan section 6).
- **Every legacy store before its first publish now makes one extra statement per request** (the `cms_state` read), as the plan expects; P2-PERF reports it. Route handlers pay it on every call (their `cache()` is a no-op).
- Unit counts only. Real-Next per-request counts are P2-PERF's.

## Owner checks

- **Replica consistency on hosted Turso**: publish on a staging tenant and load the home page right away from another region; a missing version must render after the one re-read, or show the error page, never defaults.
- **Hosted perf numbers** for the v4 home page, policy page, sitemap and `/journal` (OQ-19), once P2-PERF has the local numbers.
- **DR-1 and DR-2** stand (P2-VGATE): never roll back past VGATE while any v4 pointer exists, and scan the fleet's live `v` before deploy.
- **CI sqld** (unchanged from P2-ATOM): `.github/` was not touched. This suite does not need sqld, but `test:publish` does, so CI stays red until the owner approves the pinned, checksum-verified sqld step.
- Look at a v4 harness store in desktop Chrome yourself (the helper idea above), and a legacy store's `/journal` and `/sitemap.xml` after deploy: they must list exactly what they listed before.

## Files

- `lib/content/legacy-release.js` (new), `lib/content/documents-reader.js` (new), `lib/content/resolve.js`, `lib/content/presentation.js`
- `app/sitemap.js`, `app/(storefront)/journal/page.js`
- `scripts/test-release-readers.js`, `scripts/test-schema-compat.js`, `scripts/test-releases.js`
- `scripts/support/legacy-journal-outputs.js` (new), `scripts/fixtures/legacy-journal-outputs.a6d028e.json` (new)
- `docs/cms-reviews/P2-READ.md`, `docs/cms-reviews/drills/P2-READ/*.jpg`

## Commands

```
pnpm test:release-readers
pnpm test:schema-compat
pnpm test
pnpm build
node scripts/support/legacy-journal-outputs.js out.json   # re-record (inside any checkout)
```
