# P3-CLOSED: a store stays private until its first Publish (PUB-06), and a broken chrome version gives the error page (PUB-01, finding 3)

Plan: `docs/cms-reviews/P3-PLAN.md` (decisions 7 and 8, batch 1) and `P3-BATCHES.json`. Spec: PUB-06 and PUB-01 (section 7), section 8. Branch `cms/p3-closed`, cut from `407b88a`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 127.9 s. `test:release-readers` 43 passed (2.2 s in the gate), `test:commerce` 15 passed (0.7 s), `test:preview-overlay` 25 passed (1.1 s). 15 deliberate breaks, 15 caught (see "Do the tests bite?"). `pnpm build` passed; its one warning is the old `next.config.mjs` trace through `lib/platform/migrate.js` and `app/api/platform/overview/route.js`, not from this item |
| Browser verified | Yes, on the design harness on this Mac (ports 3640 and 4640 to 4642, `next dev`), in desktop Chrome (headless, through `playwright-core`) at 1440 x 900 and 375 x 812. Not Safari, not a real phone. See "Drill" |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real tenant changed mode. No migration |

## What and why

**Drill finding 4.** A store in documents mode that had never published threw `DOCUMENTS_UNPUBLISHED`, so shoppers got a 500 "Something went wrong" page. PUB-06 says such a store is closed: shoppers see "Opening soon", nothing else, and no draft can leak through any route.

**Drill finding 3.** When only a chrome document's version (for example `doc_header`) could not be read, the layout fell back to neutral chrome and the page still rendered, with 200. PUB-01 says a missing version gives the error page.

**The reorder.** PUB-06 is built before PUB-03 and PUB-05 on purpose. The closed state of the reader does not depend on the publish checks. This is an intended reorder against spec 8.11 and section 11.

## Design

**1. The closed source (`lib/content/resolve.js`, `lib/content/documents-reader.js`).**
- `liveSource()`: documents mode with state `none` now returns `{mode:"closed", v:4, list: Docs.emptyList(), releaseId:null, content:null, preview:false}`. Legacy and migrating with state `none` keep `{mode:"draft"}` exactly as before. An unreadable mode (`CMS_MODE_UNAVAILABLE`) or an unknown one (`UNKNOWN_CMS_MODE`) still throws.
- The closed source is v4-shaped, so every getter takes its own v4 path. No getter has a closed branch.
- **One change from the brief, and why.** The brief expected the v4 path over an empty list to give neutral empties. It doesn't. On the v4 path a missing (null) singleton means "the code default". The code defaults carry copy: `defaultHero` ("Shop <name>."), `DEFAULT_HOME_SECTIONS` ("Shop by collection", "New arrivals"), and, for the brand's own stores, the default policy pages. So `Docs.emptyList()` is a list with no documents, no pages, no redirects and no journal index, plus a `neutral: true` mark. It changes two things, both in the reader:
  - `documentBodies` gives every document asked for an empty body of its type, never null, and reads nothing from the database. The header and footer are an empty custom menu, as P2-VGATE's neutral chrome is. An "auto" menu would list the catalog's collections.
  - `usesCodeDefaults(list)` is false, so the v4 path serves no default page (`defaultPage`, `lib/content/pages.js`) and lists none.

  It stays default-deny. A getter added later that reads chrome, home or layout documents through `documentBodies` gets empty bodies. A getter that asks for a version by id finds none listed. The walk test (below) fails any getter whose neutral value is not written down.
- A valid documents preview session still goes to `documentsPreview`, over P2's `previewBaseList()` (`emptyList(m)` with code-default nulls) plus the drafts. That is what a first publish of those drafts would show. I did not move the preview onto the neutral list: the neutral list ignores drafts, and the P2 preview cases must stay green.
- New exports:
  - `isStoreClosed()` (async). True when the source is closed, and also inside a founder's preview of a store that has never published (the store is still closed to shoppers).
  - `closedStoreGate()`, for the routes. It returns `null` (open), `{preview:false}` (closed, no valid session) or `{preview:true}` (closed, valid session). Both read the request's cached `contentSource()`.
  - `STORE_CLOSED_CODE`, `STORE_CLOSED_MESSAGE`, `STORE_CLOSED_COD_ONLY_MESSAGE`.
- How `closedStoreGate` handles a read failure: closed if the failure was deciding the mode of a store with no release (`CMS_MODE_UNAVAILABLE`, `UNKNOWN_CMS_MODE`). Any other failure (a store with a release whose release can't be read) leaves the route as it is today.

**2. The layout (`app/(storefront)/layout.js`, new `components/StoreClosed.js`).**
- After the gated-host check and before maintenance, `closedNow()` reads `contentSource()`. If the mode is `closed`, the layout renders `StoreClosed` instead of anything else: the store name, "Opening soon", and "We're getting the shop ready. Check back soon." It uses kit `pulse-1` with no brand CSS, and has no menus, cart, pixels, consent banner or service worker.
- Closed wins over maintenance. The maintenance check and its `_admin` / `_platform` / `_mx` bypass are never consulted when closed.
- A founder's valid preview never reaches `closed` (the source is the preview), so they get the normal layout with the preview bar.
- `generateMetadata` on a closed store returns `{title:{absolute:"<name> · Opening soon"}, description:"Opening soon.", robots:{index:false, follow:false}}`. It has no tagline, no manifest and no `metadataBase`.
- The colours sit on `<main>`, not `<body>`. `globals.css` styles `body` outside any layer, which beats the `bg-hero` / `text-hero-fg` utilities. The drill caught this: the first screenshot was light grey on white.

**3. Sitemap (`app/sitemap.js`).** `isStoreClosed()` gives `[{url: "<site>/"}]` only. The manifest and the offline route needed no edit. `resolvedBrand()` is `null` on a closed store, and they fall back to the neutral brand (proved by test).

**4. Checkout and forms.** `checkoutCapability()` is unchanged: still synchronous, no arguments. The closed check lives only in the routes:
- `app/api/checkout/route.js`, after the capability, kill-switch and rate-limit checks:
  - With `closedStoreGate()` `{preview:false}`: 403 `STORE_CLOSED`, "This store isn't open yet."
  - With `{preview:true}`: only `action:"cod"` passes. `razorpay_create` and `razorpay_verify` get 403 `STORE_CLOSED`, "Card and UPI payments open when your store does. Use cash on delivery for a test order."
  - A passing COD order goes through the normal flow, the Shopify push included. The log line is `closed_store_test_order`.
  - **The orders table has no notes or tags column**, so the order is not marked "Test order: store not open yet". No migration was added. The test-order rule (drill cancels every test order) covers it.
- `app/api/contact/route.js` and `app/api/quiz/[slug]/route.js` (POST): 403 `STORE_CLOSED` with the same words when the store is closed and there is no valid session. There is no GET on either.
- `app/api/leads/route.js`: leads are taken on marketing hosts only, as before. On a store host it now answers 403 `STORE_CLOSED` when that store is closed and there is no session. Every other store-host case (open, preview, unknown or suspended host) answers today's 404 `{"error":"Not found"}`. So "accepted with a valid preview session" means the gate passes and the answer is today's 404.
- **Owner interpretation recorded.** The spec's "verified console session" is read as "a valid preview session minted from the console": a `_preview` token this store signed, whose `preview_sessions` row is this store's, unexpired and not revoked. A bare `_admin`, `_platform` or `_mx` cookie is not proof.

**5. Finding 3 (`pageChromeGuard`).**
- For v4 sources (closed included) it awaits `Docs.documentBodies(src.list, CHROME_DOCUMENTS)`. That is the layout's own read: same ids, same per-request cache.
- It is called, in parallel with each getter's own read, by:
  - `resolvedHomePage`;
  - `resolvedContentPage` (policy, about, contact, campaign and journal post pages);
  - `resolvedSurfaceTemplateFor`;
  - `resolvedPdpExtras`.

  So a missing chrome version throws `ContentUnavailableError` from the page, and `error.js` renders inside the layout's neutral chrome, which is kept.
- **Not on `resolvedJournalEntries`** (the /journal listing and the sitemap). `test-perf-docs`, which this item does not own, pins the sitemap and the /journal page rendered alone at 2 content statements (pointer, index). A guard there would make it 3. So the /journal listing with only a chrome version missing still renders inside neutral chrome. Known limit; the fix is a one-line add plus that suite's owner updating its count.
- **Statement count.** A full render (layout plus page) is unchanged: the chrome set is read once. A request that skips the layout (an RSC navigation) pays one extra statement, the chrome set. A policy page alone is now 3 content statements (pointer, chrome set, its version), up from 2.

**6. `DOCUMENTS_UNPUBLISHED`.** A grep of every suite (`scripts/**/*.js`, `*.mjs`, the drills included) found hits only in:
- `scripts/test-release-readers.js`: the old "documents mode with no release" test, now replaced by the closed tests;
- `scripts/test-preview-overlay.js:470`: the no-cookie case, which now expects closed live content.

`lib/content/resolve.js` no longer throws `DOCUMENTS_UNPUBLISHED`. Nothing else referenced it.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | unit: a documents tenant with no release gets mode `closed`; every exported `resolved*` getter (enumerated) returns its neutral value; no seeded-draft or code-default string | **Pass** | `test-release-readers`, three tests. (1) "PUB-06: a documents store with no release is closed …". (2) "PUB-06: every exported resolved* getter (enumerated from resolve.js) …": it enumerates `Object.keys(Res)` matching `^resolved[A-Z]` (19 getters today), calls each with 1 to 7 argument sets, and checks each against `CLOSED_NEUTRAL`. A getter with no entry fails. It searches every output for 12 seeded draft strings (legacy tables and documents drafts, the config brand colour) plus the default hero, `DEFAULT_HERO_SUBTITLE`, `EMPTY_STORE_HERO_SUBTITLE`, `DEFAULT_HOME_SECTIONS` titles and every default page's title and headings. It also checks that only `release_state` and `cms_state` are read. (3) "a closed brand store … shows no default policy page either", on tenant id `beastlife`, where `defaultPage` applies. Fails without the change: breaks B1, B2, B3, B14 |
| 2 | unit: legacy and migrating with no release keep the draft path, output equal to the fixture; 0021 onwards on a live legacy tenant with state none does not close it | **Pass** | "PUB-06 legacy: a legacy and a migrating store …": every getter call on a legacy and on a migrating store equals, field for field, the same drafts on a store at 0020 (no `cms_state`, the a6d028e path). "…running every migration after 0020 …": a store at 0020 with drafts, every getter recorded, every later migration run (0021, 0022; 0023 when it lands, as the test runs all of them), mode still `legacy`, source `draft`, outputs equal. The existing a6d028e fixtures (v1 to v3, drafts sitemap and /journal) stay green. Fails without the change: B15 for migrating. The legacy half is a guard: today's code passes it too |
| 3 | rendered: the closed layout renders "Opening soon", no maintenance words, no draft; forged cookies give the same page; with maintenance on, the closed page still shows | **Pass** | "rendered: the closed layout shows …": the real layout (SWC-compiled). It checks "Opening soon", the line under it, the store name, kit `pulse-1` with no brand CSS, and no "maintenance", "right back", "Scheduled", sign-in link, draft, code default or page body. `_admin=x`, `_platform=x`, `_mx=x` and all three give byte-identical HTML. A closed store with maintenance on (and `_admin`) shows the closed page. A legacy store in maintenance keeps its curtain. Neutral metadata. A second test: a valid preview session gets the normal layout with drafts. Fails without the change: B4, B5. Also seen in Chrome (Drill) |
| 4 | unit: the sitemap on a closed store is only `/`; manifest and offline route use neutral brand values | **Pass** | "the sitemap of a closed store is only '/' …": sitemap `["https://dm.test/"]`. Manifest `theme_color` and `background_color` are the neutral brand's. The offline page carries the neutral accent and neither the config brand's nor the design draft's. Fails without the change: B6 (sitemap). Without B1's fix the manifest and offline routes threw (`DOCUMENTS_UNPUBLISHED`). No edit was needed to either route |
| 5 | unit (test-commerce): anonymous checkout is 403 STORE_CLOSED, also with forged cookies; a valid preview session's COD passes and Razorpay is refused; legacy unaffected; `checkoutCapability`'s signature unchanged | **Pass** | `test-commerce`, four tests. They call the real route: COD, `razorpay_create` and `razorpay_verify` × 5 cookie sets, all 403 with no order stored. With a session: COD 200, one order (`snehal@mediastic.in`), the after-response work queued (not run: no Shopify call in tests). Card and verify get 403 with the COD-only words. A revoked session gets 403. Legacy: COD 200 with and without `_admin`; card never `STORE_CLOSED`. `checkoutCapability.length === 0`, a plain function, synchronous answer. Fails without the change: B8, B9, B10 |
| 6 | unit: contact, leads and quiz POST on a closed store are 403 for anonymous requests and accepted with a valid preview session; legacy unaffected | **Pass** | "PUB-06 forms …": each route × 5 cookie sets is 403 `STORE_CLOSED`. With a session: contact stores the message (200 `received`), quiz answers (200 `ok`), leads passes the gate to today's 404. On a legacy store all three answer as today. The marketing host still takes a lead. Exactly one contact message (the preview's) is stored on the closed store. Fails without the change: B10, B11, B12, B13 |
| 7 | unit: finding 3. Only `doc_header`'s version missing gives ContentUnavailableError from the home, policy and campaign page getters; statement count of a full render unchanged | **Pass** (the /journal listing excepted, see Known limits) | "finding 3: only doc_header's version missing …": the version hidden from every read. Each of these throws `MISSING_VERSION`, naming that version: home page, policy page, campaign page, a journal post page, the product accordions, and the product and collection templates. Each answers when nothing is missing. The layout plus the home page in one request: the layout renders neutral chrome and the page throws. Statement count: "the REAL layout plus the home page issue at most 3 content statements …" (unchanged, version reads exactly the chrome and home sets), and "a policy page reads only its own version besides the chrome set …": the layout plus the page costs the layout's statements + 1, and the chrome set is read once. Fails without the change: B7 |
| 8 | unit: the P2 v4 cases in test-release-readers and test-preview-overlay stay green; the no-cookie case now expects closed live content | **Pass** | Every earlier test in both suites passes unchanged, except the two `DOCUMENTS_UNPUBLISHED` cases (rewritten) and two statement-count tests (now name the chrome set). `test-preview-overlay` "… no cookie gets the closed store's neutral live content (PUB-06), never a draft": mode `closed`, no hero, no sections, no about page, no draft word |
| 9 | drill: anonymous `RSC: 1` requests with a router-state header claiming the layout is loaded, to /, /contact, /about, /policies/&lt;slug&gt;, /campaigns/&lt;slug&gt;, /journal, /journal/&lt;slug&gt; and /collections on a closed store return no draft or content-document strings | **Pass on `next dev`**. **NOT DONE on a production build** (owner check) | See "Drill": 64 requests, 0 leaks. The control run with the store open finds content strings |

**Owner interpretations recorded.**
- Catalog data (product, collection and search routes, and the catalog-derived parts of other pages) is public Shopify data and still answers on a closed store. Those routes show it to an RSC request, and the product page's own metadata still names the product.
- "Verified console session" means a valid console-minted preview session.

## Drill (`docs/cms-reviews/drills/P3-CLOSED/`)

The design harness was run from this worktree (`DESIGN_PORT=3640 DESIGN_SQLD_PORT=4640`, `next dev`).

**How the harness tenant was closed.** `rsc-probe.mjs`:
- set `cms_state.mode` to `documents` and the live pointer to NULL (it had been `rel_84d7d33384eb3e33`, v3);
- added drafts in the documents table for home, header, about, contact, shipping, a campaign and a journal post, each carrying a `DOCDRAFT …` string;
- built a list of 22 strings of 10 or more characters from the store's content: the legacy blocks, the legacy pages, the release content, and those drafts. Strings that overlap catalog titles were left out (owner interpretation).

**RSC probe.** It sent 64 requests: the 8 routes × no cookie, `_admin=x`, `_platform=x`, `_mx=x` × (plain HTML, and `RSC: 1` with `Next-Router-State-Tree` claiming `["",{children:["(storefront)",{children:["collections",…]}]}]` plus `Next-Url: /collections`).
- Every answer was 200, and **0 contained any content string** (`rsc-probe-closed.json`). Every RSC answer was `text/x-component`.
- I read the payloads to check that the layout really was skipped: `/` carried only "There's nothing on this page yet.", `/contact` only its template line, and `/journal` only "Nothing published yet". The "Opening soon" seen in RSC answers comes from the neutral metadata title.
- A first attempt with a five-element router-state tuple was refused by Next 16 (500 "could not be parsed"). The probe uses the two-element form Next accepts.

**Control: the probe does find content.** With the same store open (legacy, its v3 release live), the same RSC request found "Shop bestsellers" and "What's new" on `/`, and "Shipping policy" and "Orders dispatch within 24 hours on business days." on `/policies/shipping` (`rsc-probe-open-control.txt`).

**Chrome.** `shots.mjs`, desktop Chrome, 1440 x 900 and 375 x 812, anonymous and with forged `_admin`, `_platform` and `_mx` cookies (`closed-page-chrome.json`, `closed-1440.png`, `closed-375.png`):
- every visit answered 200 with the title "Design Demo Co · Opening soon";
- the page text was exactly "Design Demo Co Opening soon We're getting the shop ready. Check back soon.";
- no sideways scroll and no page errors.

The first screenshot showed light grey text on white (the `body` colour issue above). It was fixed and re-shot.

**Stopped afterwards.** The harness was stopped, and ports 3640 and 4640 to 4642 were free afterwards. No order was placed in the drill. The COD order end to end is P3-DRILLS's, per the plan.

## Do the tests bite?

Each break was applied alone to the finished code, then the named suite was run (`scratchpad/…/mutate.py`):

| # | Break | Result |
|---|---|---|
| B1 | Documents with no release throws `DOCUMENTS_UNPUBLISHED` again | Caught (6 tests) |
| B2 | No neutral bodies (null, so code defaults) | Caught (walk test, brand store) |
| B3 | Default pages served from the closed list | Caught (brand store) |
| B4 | No closed page in the layout | Caught (rendered) |
| B5 | Maintenance checked before closed | Caught (rendered) |
| B6 | Sitemap lists everything when closed | Caught |
| B7 | `pageChromeGuard` a no-op | Caught (finding 3, statement count) |
| B8 | Checkout without the gate | Caught (2 tests) |
| B9 | A preview may pay by card | Caught |
| B10 | `_admin` counts as proof | Caught (checkout, forms) |
| B11 to B13 | Contact, quiz or leads without the gate | Caught, each |
| B14 | Closed source not v4-shaped (draft path) | Caught (6 tests) |
| B15 | Migrating with no release closes too | Caught (legacy test) |

## Tests

- `scripts/test-release-readers.js`:
  - section 5 is rewritten: 9 new tests, closed, legacy and migration;
  - section 6 has 1 new test (finding 3) and 1 rewritten (policy page statement count);
  - the header comment is updated.
- `scripts/test-preview-overlay.js`: the no-cookie case in section 2.
- `scripts/test-commerce.js`: route hooks at the top (the `@/` alias, `next/server` with `after()` collected, a `next/headers` stub), plus 5 new tests.

## Known limits

- **The /journal listing is not guarded** (finding 3). With only a chrome version missing it still renders its posts inside neutral chrome, because `test-perf-docs` pins the sitemap and the /journal page at 2 content statements. Journal post pages are guarded.
- **One extra statement on an RSC navigation** (and on any page getter called without the layout in the same request): the chrome set. A full render is unchanged.
- **The checkout page shows generic words** for `STORE_CLOSED`. `friendlyCheckoutError` (`lib/shopper-errors.js`, not owned here) passes through only known shopper messages, so a founder in preview who picks card sees "Could not continue — your cart is untouched, please retry." and not the COD-only line. Shoppers never reach checkout on a closed store (they get the closed page). Follow-up: add the two closed messages to `SHOPPER_CHECKOUT_ERRORS`.
- **A preview COD test order is not marked as a test.** The orders table has no notes or tags field, and it is pushed to Shopify like any order. It must be cancelled after (test-order rule).
- **The checkout, contact, quiz and leads routes now read the content source:** the pointer, plus `cms_state` on a store with no release, about 1 to 2 statements per POST.
- **The maintenance curtain likely has the same `body` colour problem:** `bg-hero` / `text-hero-fg` on `body` lose to `globals.css`'s unlayered `body` rule. Not changed here (it is P2-VGATE's page). Seen only by reading the CSS; the curtain was not drilled.
- **Catalog data** on product, collection and search routes, and product page metadata, still answer on a closed store (owner interpretation).
- `leads` on a store host can only ever pass the gate to a 404. Store hosts never take leads.
- The drill ran on `next dev`, not a production build.

## Owner checks

- **Local production build:** run the RSC probe (`docs/cms-reviews/drills/P3-CLOSED/rsc-probe.mjs`, against `next build && next start` on a closed copy of the harness) and confirm 0 leaks.
- **Rulings:**
  - the catalog-data interpretation;
  - "verified console session" read as "a valid preview session minted from the console";
  - finding 3: the error page (built here) rather than neutral chrome;
  - leaving the /journal listing unguarded until `test-perf-docs`'s count is updated.
- **Phones:** look at the closed page on a real phone (seen only at 375 in desktop Chrome).
- **A closed store's COD test order on staging:** place it from a preview session with `snehal@mediastic.in`, check that it reaches Shopify, then cancel it. Note that it carries no test mark.
- **The maintenance curtain colours:** look at a maintenance store at 1440 to see whether the dark hero background shows (see Known limits).
- **CI `sqld` download:** not touched here (no `.github/` change). Its source and checksum still need the owner's approval.

## Files

- `lib/content/resolve.js`, `lib/content/documents-reader.js`
- `app/(storefront)/layout.js`, `components/StoreClosed.js` (new), `app/sitemap.js`
- `app/api/checkout/route.js`, `app/api/contact/route.js`, `app/api/leads/route.js`, `app/api/quiz/[slug]/route.js`
- `scripts/test-release-readers.js`, `scripts/test-preview-overlay.js`, `scripts/test-commerce.js`
- `docs/cms-reviews/P3-CLOSED.md`, `docs/cms-reviews/drills/P3-CLOSED/*`
- Not edited (no test failed): `app/manifest.webmanifest/route.js`, `app/(storefront)/offline/route.js`

## Commands

```
pnpm test:release-readers
pnpm test:commerce
pnpm test:preview-overlay
pnpm test
pnpm build
DESIGN_PORT=3640 DESIGN_SQLD_PORT=4640 pnpm dev:design
node docs/cms-reviews/drills/P3-CLOSED/rsc-probe.mjs <worktree> out.json   # closes the harness tenant
```
