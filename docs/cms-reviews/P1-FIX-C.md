# P1 · FIX-C · The batch B drill failures, and the test gaps the batch B reviews named

Branch `cms/p1-fixc`, cut from `8968db3` (the integrated phase 1 head after batch B and its drills). Sources: `docs/cms-reviews/P1-DRILLS.md` (findings 1 and 5), the "From review" sections of `P1-DOC-04.md`, `P1-ED-01.md`, `P1-GEN-02.md`, `P1-MIG-05-OVL-06.md` and `P1-HARNESS.md`, commit `c513d27`, and spec §8.15 (test strategy). The spec requirements behind each item: DOC-04 (`docs/CMS_FULL_BUILD_SPEC.md:284`), GEN-03 (`:1954`), GEN-02 (`:1941`), MIG-05 (`:2289`), OVL-06 (`:1673`).

This is the builder's own report. Reviewers should re-read the code.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: **52 of 52 suites passed**, 1,226 tests, 0 failed (baseline at `8968db3`: 51 of 51, 1,174). New suite `test:console-fresh` 19 passed. Per-suite counts under "Test results" |
| Browser verified | **Partly.** Desktop Chrome 156.0.8078.80 (headless, `playwright-core`) on the design harness: edge runtime, local `sqld`, Next on 3201. Settings reload at once, Brand → Publishing → Publish now, the missing-column Designer save and page editor load, and the old-store shape: 22 checks, 0 failed. The two-instance case (save on one server instance, reload served by another) can't happen on the harness, which is one process; it is proven by the unit suite only. Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE. Production is unverified.** Nothing pushed, merged or deployed. No migration ran anywhere; this item needs none |

## What was built

### 1. A founder's own next view after a save is never stale (P1-DRILLS finding 1, GEN-03 drill 6)

**The cause, proven.** The store's row in the control plane (settings, brand, theme, identity, domains, status) is cached for 30 seconds per server instance (`lib/platform/control.js`, `PLATFORM_CACHE_MS`). A save goes through `patchTenant`, which clears that cache **only on the instance that saved**. Hosted runs many instances, and on the harness a route and a page can be separate module instances, so the next request can land where the old row is still cached.

`scripts/test-console-fresh.js` (new) starts two real server instances, two node processes, each with its own cache at the real 30-second TTL, on one local control plane. It drives the real `/api/admin` routes and the real Settings and Publishing pages (compiled with Next's SWC; their client components are stubs that keep their props). On `8968db3` it gives **2 passed, 17 failed** ([fresh-before-8968db3.txt](drills/FIX-C/fresh-before-8968db3.txt)), including:
- Rates saved through instance B, then `GET /api/admin/settings` on A: `expected {"flatRate":79,"freeThreshold":1999,"codFee":49}, got {"flatRate":79,"freeThreshold":999,"codFee":49}`. That is the drill's "starter values after a reload".
- Brand saved on B, then Publishing on A: `A's Publishing API still says nothing to publish: expected true, got false`.
- Publishing opened on B, Publish now answered by A: `DRAFTS_CHANGED … expected 200, got 409`. That is the drill's 409.
- Found on the way, three lost updates from the same cache, each undoing a founder's save: an operator's cost budget set on a warm instance spread an old copy of the whole config back into the row (`expected "#16a34a", got "#dc2626"`, the brand reverted); an operator's edit of the store's details merged into an old `site` (`expected "Fresh every day", got null`, the tagline gone); a domain claim built the list from an old copy and dropped a domain another instance had just added.

**The fix: the console reads the row, not the cache.**

| Read | Before | Now | Why |
|---|---|---|---|
| Console pages (`app/(console)/**`, 32 files) | 30 s instance cache | the row is read on every request. `lib/console-request.js` (new) exports `tfetch` with `{ fresh: true }`, and each page's one import line now names it | a founder's next view after any settings, brand, theme or identity save |
| Console API (every `/api/admin/*` route) | 30 s instance cache | `tenantHandler` reads the row on every request whose path starts with `/api/admin/` (`CONSOLE_API_PREFIX`). No route file changed | the Settings GET, the Publishing view and Publish now read the row the save wrote |
| A storefront page in a founder's preview session | 30 s instance cache | the row is read on every request, only when the `_preview` cookie verifies against this store (one local HMAC; a forged cookie reads nothing) | the preview shows drafts, and draft brand, theme and identity live in the row |
| Operator console: tenant detail, tenant edit, domain claim and removal | cached copy, then written back | fresh read (`getTenant(id, { fresh: true })`) | these merged into a cached copy and wrote it back |
| Operator cost budget | spread the cached config into the write | writes only `cost_budget`; `patchTenant` merges it into the row as it is now | the same lost update |
| Shopper pages and shopper APIs | 30 s instance cache | **unchanged** | see "Why the rest is safe" |

How a fresh read behaves (`resolveHost(host, { fresh: true })`, `getTenant(id, { fresh: true })`):
- The host index (30 s) still maps the host to the store's id. The row is then read by id (`SELECT * FROM tenants WHERE id = ?`), and the row's status and domains decide. So a store suspended through another instance is closed to its console at once, a reopened one is open at once, and a domain removed elsewhere no longer opens the console.
- A fresh read that fails is "unavailable": 503 from the API, the console's error screen for a page. It never falls back to the cached row, which may be older than the founder's save. Shopper reads keep the old stale-if-down behaviour.
- The fresh row refreshes the instance's cache too.
- Cost: one primary-key read of the control plane per console request, measured in the suite (`GET /api/admin/settings` reads the row once; two shopper pages read it zero times). A page whose layout and body each resolve can read it twice when React's per-request cache doesn't join them.

**Why the rest is safe, and what is not proven safe.**
- **What a shopper sees after the store's first Publish** (blocks, pages, brand, theme, product modules, pins, placements, redirects) comes from the live release. The release pointer is read on every request, not through this cache, so the tenant cache can't make it stale.
- **Before a store's first Publish** the storefront serves drafts, and draft brand and theme come from the row, so a shopper (not the founder's preview) can see the old brand for up to 30 seconds. Such a store has not opened yet; the founder's own preview is fresh.
- **Live-on-save settings still reach shoppers within 30 seconds per instance, as before:** shipping rates, the store's name and identity, checkout mode, the Razorpay key id, tracking ids and maintenance (P1-HARNESS finding 4). One case is **not proven safe**: for up to 30 seconds after a rate change, the cart drawer (edge) and `/api/checkout` (node) can hold different copies. `/api/checkout` computes the charge from its own copy. Whether the checkout's review step can then show a different amount from the drawer was not tested. It is in "Browser drills still needed" and the owner's list.

### 2. A schema error is not a store from before a migration (P1-DRILLS finding 5)

**Reproduced first.** Ten new tests in `test:failure-matrix` fail on `8968db3` ([matrix-before-8968db3.txt](drills/FIX-C/matrix-before-8968db3.txt): 91 passed, 10 failed). The drill's own two:
- A Designer save while every `cms_pages` read fails "no such column: nosuch_col" (the table is now a view naming a column that isn't there): `expected 503, got 200`. The save went through, the editor's refresh read no pages, and the founder got no notice.
- The page editor's server load (`app/(console)/admin/(authed)/storefront/pages/[slug]/page.js`, compiled with SWC and run on the real databases): `it answered 404: NEXT_HTTP_ERROR_FALLBACK;404`, the drill's "404 — not found" for a page that exists.

The same cause behind the others: the editors' load answered 200 with `pages: []`; the page list, the page versions and the page's own read each tolerated an unexpected "no such column" alone; Publishing's load read "no such table" for the table under a view as "no approval yet"; and two found on the way that reach shoppers:
- **The live pointer read** (`getLiveReleaseState`) treated "no such table" for *any* table as "no release yet", which serves drafts to shoppers: `state: {"state":"none"} expected "error"`.
- **The release snapshot** read any "no such table" in its four other tables as empty, so a Publish went live with every slug redirect dropped: `expected 503, got 200`.
- **The page save's redirect clean-up** swallowed every error ("pre-migration tenants lack the table"), so a save answered 200 while an old redirect could keep sending visitors away from the page.

The cause: these reads tolerated `infraKind(e) === "schema"`, `/no such table/` in general, or anything at all. Each matches a broken view, a missing table a view reads, or a column nobody expected to be missing.

**The fix: one rule, `notMigratedYet(e, { table, columns })` in `lib/schema-shape.js`** (new, import-free, edge-safe). It is true only when the database driver's own error says that the table this code names isn't there (`no such table: cms_pages`, also `main.cms_pages`), or that one of the named columns isn't (`no such column: family`, `cms_pages.family`, `table order_items has no column named sku`). Local-file and sqld-over-HTTP wordings are both covered (`SQL input error: no such column: family (at offset 7)`, checked against a real `sqld`). The name must end there (`cms_pages_data` is not `cms_pages`), and our own errors' words are never read. `lib/cms/issues.js` now takes `isDriverError` from the same module.

| Read | "Not there yet" now only when |
|---|---|
| `getBlockRow` (`lib/cms/store.js`) | `cms_blocks` is missing |
| `listContentPages({ strict })` | `cms_pages` is missing, or its `family` column (then the read without it runs); the fallback read: `cms_pages` is missing |
| `pageRevisions({ strict })` | `cms_pages` is missing, or its `revision` column (0006) |
| page editor server load | `cms_pages` is missing |
| console Pages list, visibility windows | `cms_pages` is missing, or `window_start` / `window_end` (0009) |
| page save, clearing a redirect from its slug | `page_redirects` is missing (before: every error) |
| release snapshot: pages, and the four other tables | that table is missing |
| live pointer (`getLiveReleaseState`) | `release_state` is missing |
| current approval (`lib/cms/approvals.js`) | `cms_approvals` is missing |
| `hasColumns` (`lib/schema-compat.js`, MIG-05) | the probed table is missing, or one of the probed columns |

Everything else is a failure, answered the way DOC-04 answers any read failure: 503 with a code (`DATABASE_NOT_READY` for a schema error), `SAVED_RELOAD_FAILED` when the write went through, and the console's "This page hit an error" screen for a page load. MIG-05's deliberate older-schema paths keep working: `test:schema-compat` still runs cart, product page, search and order creation on a tenant at 0017 next to one at 0020, and its "asked once / re-checked after the window" tests are unchanged and pass. New positive cases: a store from before page families loads with its page (editor view and page editor); a store from before content pages loads with none; a store from before page versions (0006) loads with no versions.

### 3. Behaviour tests for the integration fix `c513d27`

Until now only the order scan in `test:failure-matrix` looked at these two catch blocks.
- **Offer go-back** (`app/api/admin/offers/[id]/revert/route.js`), through the real route on real tenant databases (`test:failure-matrix`): a database that doesn't answer → 503 `DATABASE_UNAVAILABLE` with the plain message; reads that fail → 503 `DATABASE_ERROR`; each of the store's five refusals keeps its exact status and body (`NOT_FOUND` 404, `NOT_HERE` 409, `NO_PREVIOUS` 409, `CHANGED` 409, `OFFER_INVALID` 422) and changes nothing; an error that is neither (a stand-in `TypeError` from the database client) → JSON 500 `INTERNAL_ERROR`, "Something went wrong on our side…", with the raw text kept out.
- **Sync now** (`app/api/admin/sync/route.js` POST), in `test:first-sync` with its fake Shopify: a linked store whose sync record can't be read → 503 `DATABASE_ERROR`; one whose database went read-only → 503 `DATABASE_UNAVAILABLE`. Both say "We couldn't reach your store's data just now, so this couldn't load. Try again in a minute." and never blame Shopify. The existing test still holds a missing link at 409 with GEN-02's message.

Both are new tests of correct code, so they pass on `8968db3` (which contains `c513d27`). Mutation R1 to R5 put the pre-`c513d27` code back and each is caught.

### 4. The named test gaps

| Packet | The gap, as the reviewer put it | Test now | A real bug? |
|---|---|---|---|
| ED-01, review of fix round 1 (the two breaks the brief calls F2 and F9) | the error page's menu button wired to do nothing, or given `hidden`, passed every suite | `test:editor-layout`: "on the designer, the error page's menu button is visible and its click opens the store navigation": no hiding class on all three designer routes (rendered), and the click is the shell's `openNav` (stand-in hooks) | no |
| GEN-02 | cleaning a long collection's old members on every member page (`lib/sync.js:666`) passed; the only long collection had 300 members | `test:first-sync`: a 600-member collection, Shopify answering 503 from its second member page: 600 live while it retries and after the run fails | no |
| MIG-05/OVL-06 (1) | the snapshot fallback taking the first snapshot line passed; every gap-window order had one line | `test:order-catalog`: a two-line order placed before migrating, its snapshot in the other order: each line shows its own Shopify title and SKU | no |
| MIG-05/OVL-06 (2) | the cart's `catalog_title` taken from the line's title passed; the two are equal until OVL-03 | `test:order-catalog`: **a source check**. Every `catalog_title` in `lib/cart.js` is `r.product_title` or `i.catalog_title`. No behaviour can tell them apart until OVL-03 gives the line a title of its own | no |
| MIG-05/OVL-06 (3) | a ledger ahead of the code (a rollback deploy) failing the check passed | `test:schema-compat`: `checkLedger` says current with the extra id under `unknown`, and `--check` exits 0, prints the note and "Safe to deploy." | no |
| DOC-04 | a known answer moved after the database check was caught only through a count of at least 11, and there were exactly 11 | `test:failure-matrix`: the order scan now flags any known answer after the check by what it is | no |
| DOC-04 R4, R5 | the Home editor and the Designer not minting ids survived | `test:editor-layout`: each editor on stand-in hooks; add a Banner / CTA and duplicate the first section, then Save: the three sections sent each carry their own `sec_…` id, and the original keeps its id | no |
| HARNESS | a seed run with another `TZ` read another start time, thought the running harness was gone, and `stopLeftovers` deleted its pid file; a later seed on other ports then wiped `.design-data` | `test:design-harness`: three tests (below) | **yes, fixed** |

**The harness bug, fixed** (`scripts/design-harness.js`): `ps` now runs with `TZ: "UTC"` beside `LC_ALL: "C"`, so a start time reads the same whoever reads it; and a recorded launcher that is alive and whose command line still names its script counts as running even when its start time doesn't match (refusing to start is the safe mistake), so `stopLeftovers` never clears its pid file. Reproduced on `8968db3` ([harness-before-8968db3.txt](drills/FIX-C/harness-before-8968db3.txt)): a seed with `TZ=UTC` against a harness started with `TZ=Asia/Kolkata` did not say "already running". It got as far as `✗ Port 37305, for the platform database, is already in use`, having already deleted the pid file. On the harness after the fix, the pid file reads `"started": "Tue Nov  3 13:23:22 2026"` (UTC) where the local time was 18:53.

## Acceptance

Tags: **unit** = plain node; **rendered** = a real page or component compiled with Next's SWC, run against real databases or on stand-in hooks, with its client children stubbed; **browser** = desktop Chrome on the design harness; **manual** = done by hand, recorded here.

### Item 1, fresh reads

| # | Item | Tags | Status | Evidence |
|---|---|---|---|---|
| 1.1 | Settings saved on one instance; a reload served by another shows the saved rates and no "You haven't set your own shipping rates yet" | unit, rendered, browser | Pass | `test:console-fresh` "THE BUG: rates saved through instance B…" (API and the real Settings page on A); fails on `8968db3`. Browser: [results-settings.json](drills/FIX-C/results-settings.json), a reload with no wait shows 79 / 1999 / 49 and no notice; four more reloads and a new tab agree ([settings-reload-at-once](drills/FIX-C/settings-reload-at-once.png)) |
| 1.2 | Brand saved; Publishing (page and API) lists the change at once | unit, rendered, browser | Pass | `test:console-fresh` "THE BUG: brand saved on B; Publishing on A…"; the page and API agree on the draft hash. Browser: right after Save brand, Publish now is enabled and the list shows "Brand edited" ([brand-publishing-at-once](drills/FIX-C/brand-publishing-at-once.png)) |
| 1.3 | Publish now right after a brand save answers 200, not 409, and the saved brand goes live | unit, browser | Pass | `test:console-fresh` "Publishing opened on B, Publish now answered by A: 200, not 409"; fails on `8968db3` with `DRAFTS_CHANGED`. Browser: 200, toast "Published — live now.", the live release holds the saved accent ([brand-published](drills/FIX-C/brand-published.png), [results-brand.json](drills/FIX-C/results-brand.json)) |
| 1.4 | Theme and identity saves are seen at once too | unit | Pass | `test:console-fresh`: the store's name on A's page and API; a kit applied on B shows on A's Theme API and in A's Publishing |
| 1.5 | Every console page and every `/api/admin` route reads fresh | unit | Pass | source scans in `test:console-fresh` (32 pages, 40 routes); mutation F12 caught |
| 1.6 | Negative: a fresh read that fails never falls back to the cached row | unit | Pass | "NEGATIVE: when the control plane can't be read, the console says so (503)…"; the Settings page goes to its error screen; shopper pages still answer from the last good copy |
| 1.7 | Negative: shopper reads keep the cache | unit | Pass | "every console request reads the store's row once; a shopper's page reads it not at all"; "a shopper's page on A keeps the cached row until it expires" |
| 1.8 | A founder's preview session reads fresh; a forged preview cookie doesn't | unit | Pass | "a founder's preview session on A reads the row fresh…; a forged preview cookie does not" (0 row reads) |
| 1.9 | Suspension, reopening and a removed domain take effect in the console at once | unit | Pass | "a store suspended through instance B is closed to its console on A at once; reopened, it opens at once" (including an instance started while suspended); "a domain removed through B no longer opens the console on A" |
| 1.10 | No operator write puts back an old copy over a founder's save | unit | Pass | the cost budget, store details and domain claim tests; each fails on `8968db3` |
| 1.11 | Hosted, many instances, Turso | manual | **Not done** | owner's check M1 below |

### Item 2, schema errors

| # | Item | Tags | Status | Evidence |
|---|---|---|---|---|
| 2.1 | The page editor with `cms_pages` reads failing "no such column" shows "This page hit an error", not a 404 | rendered, browser | Pass | `test:failure-matrix` "page editor load: a page whose reads fail…" and "…only the page's own read fails…" (both fail on `8968db3` with the 404). Browser: "This page hit an error" with Try again ([missingcol-page-editor-error](drills/FIX-C/missingcol-page-editor-error.png)) |
| 2.2 | A Designer save in that state never reports success: 503 `SAVED_RELOAD_FAILED` | unit, browser | Pass | matrix row "saved, then the editor's refresh fails on a column nobody expected…" (200 on `8968db3`). Browser: `PUT` 503, banner "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes.", the hero is stored ([missingcol-designer-saved-refresh-failed](drills/FIX-C/missingcol-designer-saved-refresh-failed.png), [results-missingcol.json](drills/FIX-C/results-missingcol.json)) |
| 2.3 | The editors' load, page list, page versions and Publishing's load answer 503 on an unexpected schema error | unit | Pass | four matrix load rows, each failing on `8968db3` |
| 2.4 | Shopper-facing: the live pointer and the release snapshot stay strict | unit | Pass | "the live pointer read failing on some other table is an error…"; publish row "the slug redirects read names a table that's gone…: nothing ships" |
| 2.5 | A save whose writes fail is never a success (the redirect clean-up) | unit | Pass | "a page save whose redirect clean-up fails is never answered as a success" (200 on `8968db3`) |
| 2.6 | Negative: the expected old shapes still read as "not there yet" | unit, rendered, browser | Pass | `test:schema-compat` (all 0017-tenant paths); matrix rows for a store before page families, before content pages, before page versions; page editor opens on a store before page families. Browser: `oldshape` 2 checks ([oldshape-pages-list](drills/FIX-C/oldshape-pages-list.png), [oldshape-page-editor](drills/FIX-C/oldshape-page-editor.png)) |
| 2.7 | `notMigratedYet` matches only the expected shapes, local and sqld | unit | Pass | `test:schema-compat` "the expected shapes, from a local file and from sqld over HTTP, and nothing else" (6 true, 7 false, our own words, a wrapper's cause) and "a probe that fails with some OTHER missing column (a broken view) is not remembered as absent" |

### Item 3, `c513d27`

| # | Item | Tags | Status | Evidence |
|---|---|---|---|---|
| 3.1 | Go-back: a database failure → 503 with the plain message | unit | Pass | matrix "go back: a database that doesn't answer…", "…reading the offer fails…"; mutation R2 caught |
| 3.2 | Go-back: each known refusal keeps its status and body | unit | Pass | "go back: each of the store's refusals keeps its status and its exact body, and changes nothing"; mutation R3 caught |
| 3.3 | Go-back: an unknown error → JSON 500 `INTERNAL_ERROR` | unit | Pass | "go back: an error that is neither…"; mutation R1 (the pre-`c513d27` re-throw) caught |
| 3.4 | Sync POST: a database failure → 503 | unit | Pass | `test:first-sync` two "Sync now when…" tests; mutation R4 (pre-`c513d27`) caught |
| 3.5 | Sync POST: a missing Shopify link still → 409 with GEN-02's message | unit | Pass | the existing "starting with no Shopify link…"; mutation R5 caught |

### Item 4, the named gaps

| # | Item | Tags | Status | Evidence |
|---|---|---|---|---|
| 4.1 | ED-01 F2 and F9 | rendered | Pass | mutations E1, E2 caught |
| 4.2 | GEN-02 600-member cleanup | unit | Pass | mutation G1 caught |
| 4.3 | MIG-05/OVL-06: two-line gap order, cart `catalog_title`, ledger ahead | unit (the second is a source check) | Pass | mutations M1, M2, M3 caught |
| 4.4 | DOC-04: the order scan without the count | unit | Pass | mutation D1 (a known answer moved after the check, another added before it so the count stays 11) caught |
| 4.5 | DOC-04 R4, R5 | rendered | Pass | mutations D2 to D5 caught |
| 4.6 | HARNESS: the TZ wipe and the pid file | unit | Pass, and fixed | mutations H1, H2 caught; the TZ test and the stand-in launcher test fail on `8968db3` |

## Mutation check

Scratch runner, not committed: each mutation replaces exact strings in the real file, runs the named suites, and restores the file (compared byte for byte). Full output: [mutations.txt](drills/FIX-C/mutations.txt).

**First pass: 40 mutations, 35 caught, 5 survived.**

| # | Mutation | Caught by |
|---|---|---|
| F1 | console pages read the cached row | `test:console-fresh` (3 failed) |
| F2 | `/api/admin` routes read the cached row | 12 failed |
| F3 | `getTenant` ignores `fresh` | 14 failed |
| F4 | a failed fresh read falls back to the cache | the NEGATIVE test |
| F5 | fresh resolution trusts the index's cached status | **survived**, then caught (below) |
| F6 | fresh resolution ignores a removed domain | the domain test |
| F7 | a preview session keeps the cached row | the preview test |
| F8 | any preview cookie reads fresh | the preview test (forged cookie) |
| F9 | the cost budget writes back the cached config | the cost budget test |
| F10 | the operator's edit merges into a cached copy | the store details test |
| F11 | a domain claim builds from a cached copy | the domain claim test |
| F12 | one console page imports the cached `tfetch` | the source scan |
| S1 | the editors' page list counts any schema error as old | **survived**, then caught |
| S1b | page versions count any schema error as old | **survived**, then caught |
| S2 | the page editor load counts any schema error as old | **survived**, then caught |
| S3 | the live pointer: any missing table means no release | the live pointer test |
| S4 | the snapshot's other tables: any missing table reads as empty | the redirects publish row |
| S5 | `hasColumns` remembers any missing column as absent | the broken-view probe test |
| S6 | `notMigratedYet` accepts any table name | the shapes test, three matrix rows |
| S7 | `notMigratedYet` reads our own errors' words | the shapes test |
| S8 | the redirect clean-up swallows every error again | the redirect clean-up test |
| S9 | approvals: any missing table means no approval | **survived**, then caught |
| R1 to R5 | `c513d27` put back, or a status changed | the go-back and Sync now tests (each) |
| E1, E2 | ED-01 F2, F9 | the menu button test |
| G1 | GEN-02 cleanup on every member page | the 600-member test |
| M1 to M3 | the three MIG-05/OVL-06 gaps | their tests |
| D1 | a known answer after the check, count kept at 11 | the order scan |
| D2 to D5 | Designer and Home editor without minting | the two minting tests |
| H1 | `ps` in the caller's time zone | the leftover-servers-in-another-TZ test |
| H2 | a live launcher with a mismatched start time counts as gone | the stand-in launcher test |

Why the five survived, and what was added:
- **S1, S1b, S2.** A view that names a missing column breaks every read of it, so the page list, the page versions and the page's own read failed together, and each strict read hid the others (the same trap DOC-04's F10 and F11 hit). Added three rows where only one statement fails, with the driver's own error shape, on a healthy store: "only the page list's read fails…", "only the page versions' read fails…", "page editor load: only the page's own read fails…".
- **S9.** No store had a broken approvals table. Added "Publishing's load when the approvals table is a view over a table that's gone: 503".
- **F5.** Instance A's host index never held "suspended". The suspension test now starts a third instance while the store is closed, so its index says suspended, then reopens the store.

**Second pass: the 5 against the new tests, 5 caught.** These prove the tests notice these breaks, not every break.

## Browser drills done

Desktop Chrome 156.0.8078.80, headless, through `playwright-core` (`scripts/drill.js`), on the design harness on this Mac: `DESIGN_PORT=3201 DESIGN_SQLD_PORT=18200`, freshly seeded, edge runtime, local `sqld`. The journey is `scripts/drills/p1/fixc.mjs`. Every database break was made in the harness's local tenant database through `scripts/drills/p1/db.mjs` and undone at the end of its part. The harness was stopped by its own PID afterwards, and ports 3201 and 18200 to 18202 were free.

| Part | Result | What happened | Evidence |
|---|---|---|---|
| settings | **Pass, 6 of 6** | Starter rates with the notice. Set 79 / 1999 / 49, Save settings (200), reload with no wait: 79 / 1999 / 49 and no notice. Four more reloads and a new tab: the same. Then the rates removed in the control plane by hand: the next reload shows the starter rates and the notice again (the console reads the row, whichever way it changed). In P1-DRILLS this drill failed, and only a reload 31 s later was right | [settings-reload-at-once](drills/FIX-C/settings-reload-at-once.png), [settings-after-control-plane-change](drills/FIX-C/settings-after-control-plane-change.png), [results-settings.json](drills/FIX-C/results-settings.json) |
| brand | **Pass, 7 of 7** | Published once so nothing was pending (Publish now disabled). Brand → accent → Save brand (200). Straight to Publishing: Publish now enabled, "Brand edited" in the change list. Publish now → 200, "Published — live now.", and the live release holds the new accent. In P1-DRILLS Publishing showed nothing to publish, and once answered 409 | [brand-publishing-at-once](drills/FIX-C/brand-publishing-at-once.png), [brand-published](drills/FIX-C/brand-published.png), [results-brand.json](drills/FIX-C/results-brand.json) |
| missingcol | **Pass, 7 of 7** | `cms_pages` made a view naming `nosuch_col`. Designer hero title typed, Save: `PUT /api/admin/storefront` 503, the client's second look 503, banner "Couldn't save the hero / Your changes were saved, but this page couldn't refresh. Reload it before you make more changes.", and the hero is stored. `/admin/storefront/pages/shipping`: "This page hit an error" with Try again, not a 404. With the table back, the page editor opens the page. In P1-DRILLS the save answered 200 with no notice and the page editor showed "404 — not found" | [missingcol-designer-saved-refresh-failed](drills/FIX-C/missingcol-designer-saved-refresh-failed.png), [missingcol-page-editor-error](drills/FIX-C/missingcol-page-editor-error.png), [results-missingcol.json](drills/FIX-C/results-missingcol.json) |
| oldshape | **Pass, 2 of 2** | `cms_pages` made a view without `family`, `window_start` and `window_end` (a store from before 0009): the Pages list opens and lists the pages, and the page editor opens the shipping page | [oldshape-pages-list](drills/FIX-C/oldshape-pages-list.png), [oldshape-page-editor](drills/FIX-C/oldshape-page-editor.png), [results-oldshape.json](drills/FIX-C/results-oldshape.json) |

`next build` with the harness env (`scripts/drills/p1/prod-harness.mjs build`, no database touched during it): exit 0, "Compiled successfully", and only the two known "unexpected file in NFT list" warnings through `lib/platform/migrate.js` ([next-build.log](drills/FIX-C/next-build.log)). The changed modules a shopper's page can reach (`lib/tenant-request.js`, `lib/schema-shape.js`, `lib/schema-compat.js`, `lib/releases.js`, `lib/cms/store.js`, `lib/cms/issues.js`) use no `node:` API; the edge bundle compiled.

## Test results

`node scripts/run-tests.js --verbose` on the final code: 52 of 52 suites passed, **1,226 tests passed, 0 failed**. Then `pnpm test`: `52 of 52 suites passed in 102.3s.`, exit 0. Format is passed/failed:

```
test:orders 27/0              test:shipping 12/0            test:shopify-push 13/0
test:shopify-boundary 41/0    test:hardening 11/0           test:offers 27/0
test:offers-admin 8/0         test:offer-form 61/0          test:events 16/0
test:tenancy 9/0              test:platform-sync 15/0       test:admin-console 9/0
test:cms-api 20/0             test:page-editor 61/0         test:refs 8/0
test:sections 15/0            test:cms 11/0                 test:platform-ops 9/0
test:tenant-boundary 24/0     test:identity 22/0            test:authz 14/0
test:platform-core 15/0       test:jobs 16/0                test:sync-generations 8/0
test:first-sync 75/0          test:order-projection 14/0    test:commerce 10/0
test:privacy 11/0             test:security 19/0            test:content 19/0
test:releases 25/0            test:themes 10/0              test:storefront 15/0
test:surfaces 15/0            test:billing 14/0             test:provision 9/0
test:reporting 6/0            test:tenant-ops 9/0           test:marketing 4/0
test:customers 9/0            test:commerce-exp 18/0        test:growth 21/0
test:agency 16/0              test:w6 16/0                  test:copy 52/0
test:media-upload 119/0       test:design-harness 49/0      test:failure-matrix 101/0
test:schema-compat 28/0       test:order-catalog 17/0       test:editor-layout 34/0
test:console-fresh 19/0
```

Baseline at `8968db3` before any change: 51 of 51 suites, 1,174 tests, 0 failed. Changed counts: `test:first-sync` 72 → 75, `test:design-harness` 46 → 49, `test:failure-matrix` 82 → 101, `test:schema-compat` 25 → 28, `test:order-catalog` 15 → 17, `test:editor-layout` 31 → 34, and `test:console-fresh` new with 19. `test:order-catalog` also changed one stub key: the order page now imports `@/lib/console-request`.

Reproduction runs (each a `git archive 8968db3` copy with the final suites copied in, `node_modules` linked):
- `test:console-fresh`: 2 passed, 17 failed.
- `test:failure-matrix`: 91 passed, 10 failed.
- `test:schema-compat`: 25 passed, 3 failed (the broken-view probe; and two that need `lib/schema-shape.js`, which doesn't exist there) ([compat-before-8968db3.txt](drills/FIX-C/compat-before-8968db3.txt)).
- `test:design-harness`: 45 passed, 4 failed. Three are the harness bug; the fourth ("the harness data folder… gitignored") fails only because the copy isn't a git checkout.
- The new tests in `test:first-sync`, `test:editor-layout`, `test:order-catalog` and the order scan guard correct code, so they pass there; the mutation check proves them.

`test:perf` was not run (a measurement).

## Commands

```
git checkout -B cms/p1-fixc 8968db3
pnpm install --frozen-lockfile --prefer-offline
node scripts/run-tests.js --verbose                    # baseline: 51 of 51, 1,174
node scripts/test-console-fresh.js                     # and each changed suite, while building
git archive 8968db3 → scratch copy; node_modules linked; the final suites copied in; each run there
node <scratch>/mutate.mjs mutations.json               # 40 mutations, then the 5 survivors again
DESIGN_PORT=3201 DESIGN_SQLD_PORT=18200 node scripts/dev-design.js seed
DESIGN_PORT=3201 DESIGN_SQLD_PORT=18200 node scripts/dev-design.js            # left running
DESIGN_PORT=3201 node scripts/drills/p1/run.mjs fixc settings
DESIGN_PORT=3201 node scripts/drills/p1/run.mjs fixc brand
DESIGN_PORT=3201 node scripts/drills/p1/run.mjs fixc missingcol,oldshape
kill -TERM <the harness launcher's pid>                # sqld and Next stopped with it
DESIGN_PORT=3201 DESIGN_SQLD_PORT=18200 node scripts/drills/p1/prod-harness.mjs build
node scripts/run-tests.js --verbose                    # final: 52 of 52, 1,226
pnpm test
```

## Deviations

1. **Console pages changed one import line each (32 files).** A server component has nothing reliable to say it is the console, so the rule is the import. A source scan in `test:console-fresh` fails if a console page reads through the cached path. Call sites are unchanged.
2. **The console API rule is by path** (`/api/admin/`), inside `tenantHandler`, so no route file changed and a new console route can't miss it. `tenantHandler(handler, { fresh })` can override it either way.
3. **A founder's preview session reads the row fresh too.** Not asked for in so many words, but the preview shows drafts, and draft brand, theme and identity come from the row.
4. **The operator console's read-then-write paths read fresh, and the cost budget writes only its own key.** Outside the founder's console, but the same cache let them undo a founder's save.
5. **Three fixes beyond the drills' wording**, found while proving item 2: the live pointer read (drafts to shoppers), the release snapshot's other tables (redirects dropped on publish), and the page save's redirect clean-up (every error swallowed).
6. **A failed redirect clean-up during a page save is now a 5xx.** Before, the save answered 200. The answer says "nothing was saved" although the page row is written: DOC-04's known two-writes limit, which DOC-02's single write ends.
7. **`isDriverError` moved** from `lib/cms/issues.js` to `lib/schema-shape.js` (the same rule), and `test:schema-compat`'s edge-safety pin now allows `./schema-shape.js` and checks that file is import-free.
8. **The harness counts a live launcher whose command still names its script as running even with a mismatched start time.** The review suggested keeping the pid file in that case; refusing to start goes one step further, and is the safe direction.
9. **The cart `catalog_title` gap is closed by a source check**, not a behaviour test, because the two values are equal until OVL-03.
10. **No migration, no new dependency, no new environment variable.**

## Merge notes

- **`claude/musing-williamson-4c86b3` (maintenance).** It adds `lib/storefront-request.js`, which wraps `tfetch` and `tenantHandler` from `lib/tenant-request.js`, and points the storefront pages' import at it. This branch changes `lib/tenant-request.js` inside (`tfetch(fn, { fresh })`, `tenantHandler(handler, { allowUnresolved, fresh })`, the preview check), and the wrapper's calls still fit: shopper pages take the cached path plus the preview check, shopper APIs are not under `/api/admin/` so they stay cached. Its `test-maintenance.js` requires console pages not to name `storefront-request`; they now name `console-request`, which passes. Neither branch edits the other's lines, so no textual conflict is expected. After merging, run `test:maintenance` and `test:console-fresh`. `app/api/admin/maintenance-pass` now reads the row fresh (path rule); harmless.
- **`claude/gallant-keller-7d3213` (database retries, payment confirmation).** No file overlaps except `package.json` (both add `test:*` lines; keep both). It rewrites `lib/db.js`. Three tests here patch `currentDatabase().libsql.execute` on a tenant's client (the go-back internal-error test and the three single-statement rows in `test:failure-matrix`, as `test:schema-compat` already did), so after merging re-run `test:failure-matrix`, `test:schema-compat` and `test:console-fresh`. The go-back "database doesn't answer" row adds one more call to the unreachable test database, which `lib/db.js` retries; recheck the matrix run time after that merge.
- **Other batch C branches.** Any new console page must import `tfetch` from `@/lib/console-request`; `test:console-fresh` fails otherwise. Any new read that tolerates an old schema must use `notMigratedYet` with its table (and only the columns a migration added). A new `test:*` line in `package.json` sits next to `test:console-fresh`.
- `docs/cms-reviews/MANUAL-CHECKS.md` was not edited, to keep it conflict-free; the owner checks below belong in its batch C section at merge.
- Nothing hosted touched; no hooks enabled.

## Known limits

**Fresh reads.**
- **Hosted was not exercised.** Two node processes on local files stand in for many Vercel instances on Turso. The fix assumes a console read after a save sees the save (read-your-writes on the control plane database). Turso over HTTP reads from the primary for a single-location database, but a replicated setup or an embedded replica could lag; staging must confirm (owner's check M1).
- **A domain added on another instance** is unknown to this instance's host index for up to 30 seconds, as before. The console opened on the brand-new domain can answer 404 for that window. Removals and suspensions take effect at once.
- **Each console request now reads the control plane once (sometimes twice).** Not measured on hosting; the GEN-02 progress card polls `GET /api/admin/sync` every 3 seconds, so a watched sync now reads the row every 3 seconds too.
- **Sign-in pages read fresh as well.** During a control plane outage the console sign-in now shows the error page at once instead of up to 5 minutes later; sign-in needs the control plane anyway.
- **Shoppers can see a settings change up to 30 seconds late per instance** (shipping rates, store name, checkout mode, payment key id, tracking ids, maintenance), and a store before its first Publish can show shoppers the old brand for that long. The drawer-versus-checkout amount in that window is untested (above).
- **A preview session's storefront API calls** (`/api/cart` inside the preview, for example) keep the cached path; only the preview's pages read fresh.
- **The two-instance proof is in plain node.** The harness is one process, so the browser drills show the founder's journey on one instance, not the cross-instance case.

**Schema errors.**
- **Many other "pre-migration tenant" reads still swallow every error** (`lib/wishlist.js`, `bundles.js`, `automations.js`, `customers.js`, `experiments.js`, `catalog-overrides.js`, `notifications.js`, `repo.js`, `media.js` usage, `cms/history.js`, `cms/templates-store.js`, `ai/insights.js`, `getContentPage`, `resolveSlugRedirect`, `platform/support.js`, `platform/incidents.js`). They answer a broken read as empty, as before. Only the reads behind the drill failures, the editors, publishing and the live pointer were tightened.
- **The offers "way back" check** (`lib/offers/store.js`, `missingPreviousColumn`) still matches any error that mentions `previous_config`, not only the driver's. It names the column, so a broken view elsewhere doesn't match it; left for COM-03's owner.
- **A failed redirect clean-up answers "nothing was saved" though the page row is written**, and the next save then meets the founder's own save as a conflict. DOC-04's two-writes limit; DOC-02 ends it.
- **`DATABASE_NOT_READY`'s words** ("Your store needs an update on our side first… contact support") now also cover a broken schema that isn't a missed migration. That is still the right person to call.
- **Hosted Turso's error words for a missing table or column were checked against a local `sqld` only**, not Turso itself (P1-MIG-05's staging check covers it).

**Tests.**
- **The cart `catalog_title` guard is a source check** until OVL-03.
- **The single-statement rows** make one statement fail with an error shaped exactly like the driver's (`LibsqlError`, `SQLITE_ERROR`), raised by a stand-in on the client, because a real view breaks every read of it.
- **The design harness tests change `TZ` only to `UTC`, `Asia/Kolkata` and `America/Los_Angeles`.** On Linux (CI), `lstart` is worked out from boot time and can differ by a second between reads; the "live launcher still counts" rule now covers that too, but it was not run on Linux.
- Only desktop Chrome. No Safari, no phone, no staging.

## Browser drills still needed

Desktop Chrome on the design harness can check these; an agent can run them.
1. **Brand in the Designer preview right after Save brand.** Save a new accent on Brand, open the Designer at once. Pass: the preview frame's buttons use the new accent on the first load (the preview reads the row fresh).
2. **Theme kit → Publishing at once.** Theme → apply another kit, then Publishing straight away. Pass: Publish now enabled, "Theme" in the change list; Publish now answers 200.
3. **Store name (identity) at once.** Settings → Store profile → change the store name → Save settings, then reload Settings and open the Designer. Pass: the new name in the Settings field and in the console's sidebar on the first reload.
4. **Cart drawer and checkout after a rate change.** Save new rates, then within 30 seconds add to cart and go through checkout to the review step (COD). Pass: the drawer's shipping and the review step's shipping and total agree, or the numbers are recorded for the owner's decision.
5. **A store before page versions.** In the local tenant DB make `cms_pages` a view without `revision`. Pass: the Pages list and the page editor open (the editor's save then needs a reload).

## Checks only the owner can do

- **M1. Staging, two instances.** On staging (several function instances), save shipping rates in Settings and reload at once, five times; save the brand and open Publishing at once, then Publish now. Pass: every reload shows the saved rates with no "You haven't set your own shipping rates yet", Publishing lists the brand change at once, and Publish now answers 200 (no 409).
- **M2. Turso read-your-writes.** On staging, confirm the control plane database is a single-location Turso database read over HTTP (no embedded replica, no read replica for console traffic). Pass: yes, or a decision on how console reads reach the primary.
- **M3. Decision: shoppers and settings changes.** Shipping rates, the store's name, checkout mode, the payment key id and maintenance reach shoppers up to 30 seconds late per instance. Pass: you accept that, or ask for shopper reads of those settings to be versioned too.
- **M4. Decision: a store before its first Publish** shows shoppers the old brand for up to 30 seconds after a save. Pass: accept, or ask for it to read fresh.
- **M5. A real database schema fault on staging.** Point one staging tenant at a database whose `cms_pages` is broken (or drop a column on a throwaway copy), then open the page editor and save in the Designer. Pass: "This page hit an error" with Try again, and "Your changes were saved, but this page couldn't refresh…" after a save; never a 404 and never a silent save.
- **M6. Decision: the other "pre-migration" reads** (Known limits) that still answer any failure as empty. Pass: you decide whether they are tightened in a later item.
- **M7. Safari and a phone:** the Settings reload and the Publishing panel after a brand save. Pass: the saved values show at once, no sideways scroll.
