# P3-FRAME: the storefront side of the editor, preview only (PV-01, ED-04, ED-02, PUB-11, PV-02)

Plan: `docs/cms-reviews/P3-PLAN.md` (decision 10, R C1, batch 2) and `P3-BATCHES.json`. Branch `cms/p3-frame`, cut from `5bbc819`. No migration. No new dependency. No real tenant changes mode.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 132.2 s. `test:preview-frame` 18 passed (0.9 s in the gate), `test:preview-overlay` 27 passed (1.2 s). 29 deliberate breaks, 29 caught (see "Do the tests bite?"). `pnpm build` passed; its one warning is the old `app/api/platform/overview/route.js` trace, not from this item |
| Browser verified | Yes, on the design harness from this worktree (ports 3860 and 4860 to 4862, `next dev`), in desktop Chrome (headless, `playwright-core`) at 1440 x 900 and 375 x 812. Not Safari, not a real phone. See "Drill" |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

The new editor (batches 3 and 4) shows the store in a frame. That frame has to tell the editor what it shows (the founder's drafts, the live store, or a preview that ended), let the founder pick a section or a field by clicking it, and never act like a shop while the founder is choosing. All of it is for the founder only: a shopper's HTML does not change by one byte.

## Design

**1. A preview that ended (`lib/content/resolve.js`).**
- `documentsPreview(sid)` returns `{ refused: reason }` when the session token is this store's signature but the session no longer counts: `revoked`, `expired`, or `not_found` (a row of another store reads as `not_found`). A missing table or a read error stays `null`, as before (nothing to tell the founder).
- A token signed by this store but past its own expiry is found with `readPreviewToken(token, { now: 0 })` and refused as `expired` on a documents store.
- `contentSource()` then serves the live source with `previewRefused: reason`. A tampered or foreign token is still no preview at all: no overlay, no refusal, no bar.

**2. What the frame is told (`resolve.js`, `app/(storefront)/layout.js`).**
- The documents overlay gains `docs` (each overlaid document's draft hash), `offline` (documents taken offline, decision 4: `published_version_id` null and `undone_version_id` set; one statement, preview only), `skipped` (dirty drafts the preview could not show) and `designShown`.
- `previewFrameRoutes()` (preview only): which document each address shows. `/` is `doc_home`, `/collections` is `doc_collections_index`, every page and campaign row at its `livePath`, every journal post (one journal index read, preview only).
- The layout's `frameOf()` decides one of:
  - documents preview: the bridge with `state {kind, sid, docs, offline, skipped, designShown}` and `ok`; the banner; the preview-only attributes;
  - ended preview: the bar "Your preview has ended, so you're seeing the live store." with Exit (`/api/preview?exit=1`), and the bridge with `{ok:false, reason}`;
  - a documents store's live page and an `_admin` or `_platform` cookie (presence only): the bridge with `{ok:false, reason:"live"}` and "Edit this page", no bar;
  - anything else: today's markup. A legacy preview gets the bridge with `{ok:false, reason:"legacy"}` (it renders nothing; v1 is unchanged).
- Both bars carry `data-preview-bar`, so the bridge leaves them working (below).

**3. The protocol (`components/preview/bridge-core.js`, new).** A plain module with no imports. Window and document are passed in. `PreviewBridge.js` is now a `useEffect` that calls `createBridge` and holds the outline styles (`test-copy` pins the class names there).
- v1 for the legacy Designer is unchanged: `storeasy:designer:hello`, `sec:highlight`, `sec:click`, `refresh`, the mount's `{type:"storeasy:ready"}`.
- v2 starts on `{type:"storeasy:editor:hello", v:2}` and answers `{type:"storeasy:ready", v:2, state, ok, reason?, unfinished}`. `unfinished` holds the `[data-unfinished]` section ids.
- While v2 is on, capture-phase handlers stop every link click, every form submit and every submit button (a `<button>` with no type, or `type=submit`). A `type=button` is left alone.
- Every click inside the page posts `{type:"storeasy:pick", doc, sectionId, kind, field, offset}` from the closest `[data-doc]`, `[data-section-id]` (with its `data-section-kind`) and `[data-field]` inside that section. `offset` is the index of the clicked block inside a `[data-field-type="rich_text"]` field, else null.
- The preview's own bar (`[data-preview-bar]`) is not picked and not stopped. Without this, "See the live store", Exit and the colours toggle did nothing inside the editor's frame (the drill found it).
- `{type:"storeasy:select", sectionId}` outlines the section and scrolls to it.
- `refresh` keeps the address, scroll and selection in `sessionStorage`, then reloads. The next mount on the same address restores them, once. Storage that throws loses only the scroll.
- `routeDocFor(pathname, routes)`: exact addresses, plus product pages (`doc_product_layout`) and collection pages (`doc_collection_layout`).

**4. Preview-only attributes.**
- `data-doc`:
  - `Header` (`doc_header`) and its announcement bar (`doc_announcement`) and `Footer` (`doc_footer`) take an `editing` prop from the layout.
  - `<main>` in a documents preview is `PreviewMain` (`components/PreviewBanner.js`, a client component). It gets `data-doc` from `usePathname()` and the routes. The layout has no address of its own, so this is the only way for it to name the route's document. Every other request gets the layout's plain `<main>`.
- `data-field` uses validate's real field paths, not the brief's names (see the deviation below):
  - `HeroSection` marks `title`, `subtitle`, `primary.label`, `secondary.label` and `badge`. It still has `data-sec="hero"` and is selected by `data-section-id`.
  - For every other kind, `SectionView` (`components/sections/index.js`) walks the section's own render. The element whose only child is exactly a setting's text gets that setting's path. This covers `title`, `text`, `caption`, `button.label` and `body.N`. Rich text is marked as `html` with `data-field-type="rich_text"`. The first match wins, in document order.
  - FAQs render through a client component the walk can't see into. In a preview they render through `PreviewFaq`: the same markup (pinned by a test), plus `items.N.q` and `items.N.a` (rich text).
  - `ContentPage` marks the page title `meta.title`.
- **How the renderers know it is a documents preview.** `page.js` is not this item's file, and the renderers run outside `tfetch` and can't import `resolve.js`: next/headers would reach every suite that renders the map. So `contentSource` notes `{storeId, documentsPreview}` in a per-request holder (React `cache`, the same per-request scope `contentSource` already relies on), published under `Symbol.for("storeasy.requestScope")`. `SectionView` and `ContentPage` read it. Outside a request the holder is a fresh object, so the answer there is "not a preview". It fails toward live markup, never toward a shopper seeing attributes. It was checked on the real Next server (Drill).

**5. The banner (`components/PreviewBanner.js`, now a client component).**
- A documents preview reads "You're seeing your unpublished changes." with "See the live store", which links to `liveExitUrl(pathname)` = `/api/preview?exit=1&to=<this address>`, never a token. When this address's document is offline, it adds "This page is offline. Publishing it brings it back."
- A legacy preview keeps today's words. The other-tab and colours notes are unchanged.

**6. Edit this page (`components/preview/EditThisPage.js`, new).** A client link to `/admin/editor?path=<encoded pathname>`. It renders only when there is no preview, an `_admin` or `_platform` cookie is present, and the store is in documents mode on a live v4 release.

**7. After the batch 1 review.**
- **`section_render_failed` carries the real store id** (P3-VALIDATE). Inside a tenant context, `slog`'s own id is kept. Otherwise the line takes `storeId` from the request scope above.
- **A broken release pointer gives the error page, never "Opening soon"** (P3-CLOSED). This was a test gap only; the code was right. A rendered test now covers a pointer to a missing row and a pointer to a row whose content isn't JSON. `closedNow`'s catch changed to `true` fails it (break B18).
- **Quizzes and bundles on a closed store** (P3-CLOSED). The probe on the real server confirmed the leak before the fix. On a closed store, `/quiz/skin` and `/bundles/night` carried the quiz title, intro, question and option, and the bundle title and description:
  - in the RSC answer;
  - in the full HTML too, even though the page showed "Opening soon", because the page's metadata and its render travel in the payload.
  Both pages now ask `closedStoreGate()` first. `{preview:false}` answers `StoreClosed` and the closed metadata before reading the quiz or bundle. A founder's valid preview session and an open store see them as before.

**Deviation from the brief: the field names.** The brief names `buttons.N.label` and `items.N.question` / `items.N.answer`. Its acceptance asks for "the validate issue field for the same value", and validate reports `primary.label` / `secondary.label` (hero), `button.label` (banner, image with text), and `items.N.q` / `items.N.a` (FAQ). P3-VALIDATE's packet says the same. I used validate's paths, so a click and an issue name the same field. The test derives each expected path from `validateDocument` with an over-long value.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | unit (test-preview-overlay): a revoked, an expired and an unknown sid each give live content plus `previewRefused` with the reason; a tampered HMAC gives neither overlay nor bar | **Pass** | "P3-FRAME: a revoked, an expired and an unknown sid …". It covers revoked, an expired row, a token past its own expiry, an unknown sid, another store's row (`not_found`), and each gives the live release, preview false and the reason. A tampered HMAC, a tampered expiry, another store's token and garbage give no overlay and no `previewRefused`. The bar side is in row 2. Fails without the change: B1, B2, B28 |
| 2 | rendered (test-preview-frame): refused session renders the bar and the bridge with ok:false; no preview cookie plus `_admin` renders the bridge with reason 'live' and no bar; no cookies at all renders no bridge (byte-equal to before); a valid session renders the banner with 'See the live store' to `/api/preview?exit=1&to=…` and no token; an offline route doc adds the offline line | **Pass** | Real layout (SWC), bridge stubbed to print its props. "a refused session …": revoked, expired and unknown each show the bar's exact words, Exit to `/api/preview?exit=1` and `[{ok:false, reason}]`, with no banner and no attributes. A tampered token gets no bar and no bridge. "no preview cookie plus _admin (or _platform) …": `[{ok:false, reason:"live"}]` and no bar. `_mx` gets nothing, and neither does a legacy store. "no cookies at all …": 7 shopper renders (v4 and legacy layouts, home pages, a content page, with no cookie, a cart cookie, or `_admin` on legacy) are compared by sha-256 with the same renders at `5bbc819`, recorded with `FRAME_RECORD=1` on a `git archive` copy of the base with its own `pnpm install`. All 7 are equal. "a valid documents session …": the banner words; `href` = `/api/preview?exit=1&to=%2Fabout`; the token absent from the page; `state.docs` equals the drafts' hashes. A page taken offline shows the line on its address only, `state.offline` = `[id]`, and shoppers never see it. Fails without the change: B3, B4, B5, B19, B20, B21, B23, B25 |
| 3 | rendered: in preview Header, Footer and main carry the right data-doc; the hero title, a button label, a text paragraph (body.2) and an FAQ question carry data-field equal to the validate issue field for the same value; live renders carry neither (byte-equal for legacy and v4 fixtures) | **Pass** | "in a preview the header, the announcement bar, the footer and `<main>` …": `doc_header`, `doc_announcement`, `doc_footer`; main is `doc_home` on `/`, the page's id on `/about`, `doc_product_layout` on a product page, and has none on `/search`. "the hero title, a button label …": the expected paths come from `validateDocument` (`title`, `primary.label`, `body.2`, `items.1.q`, `button.label`). The rendered home preview carries them, plus `subtitle`, `body.0`, `title` and the answer's `items.1.a` / `rich_text`. The FAQ preview markup minus attributes equals the live accordion's. A content page carries `meta.title` and `body.2`. Live home and page, `_admin` alone and a legacy preview carry none. Byte-equality is in row 2. Fails without the change: B13, B14, B24, B27 |
| 4 | unit (bridge-core, stand-in DOM, no jsdom): after a v2 hello, a click on an anchor inside or outside a section is prevented and posts pick {doc, sectionId, field, offset}; a form submit is prevented; without a hello, v1 behaviour (data-sec click, highlight, refresh) is unchanged | **Pass** | A ~100-line stand-in DOM in the suite. "v2: a click on a link inside a section and outside any section …": the hero's button, a header link, the announcement, a footer link, a word, two rich text blocks (offsets 0 and 1), a form submit, a submit button, a `type=button` (not stopped), and the preview bar's link and toggle (not stopped, not picked). "v1 unchanged without the editor's hello …": announce, origin check, the select-mode class, a `[data-sec]` click swallowed and posted as `sec:click`, highlight and scroll, refresh reloads and stores nothing, no pick, clean teardown. "not embedded: inert". Fails without the change: B6, B7, B11, B12, B29 |
| 5 | unit: ready carries state.docs equal to the overlay's draft hashes, the offline ids and the [data-unfinished] ids; select outlines the section; refresh restores scroll from sessionStorage and survives a throwing storage | **Pass** | "v2 ready carries the layout's state …" (and `ok:false` with each reason). The overlay side, `test-preview-overlay` "P3-FRAME: the overlay tells the frame …", checks that `docs` equals each overlaid document's `draft_hash` from the table, `skipped`, `designShown`, and `offline` after a page is taken offline. In the rendered layout, `state.docs` equals the table's hashes (row 2). "v2 select … refresh …": outline and scroll, another origin ignored, the scroll (640) and the selection restored on the next mount on the same address, not on another address, and a throwing storage still reloads. Fails without the change: B8, B9, B10, B22, B25 |
| 6 | rendered: EditThisPage renders only with no preview and a console cookie, with href /admin/editor?path=…; never without the cookie | **Pass** | "rendered: EditThisPage renders only …": no cookie gives none; a preview with `_admin` gives none; `/policies/returns` gives `/admin/editor?path=%2Fpolicies%2Freturns`; the path is only ever a query value. Row 2's test also checks `/about`, and that `_mx` and legacy stores get none. Fails without the change: B4, B5, B26 |
| 7 | rendered: a documents store with a broken release pointer renders the error page, not 'Opening soon' | **Pass** | "rendered: a documents store whose release pointer names a missing row, or a row that can't be read …": the layout renders the page inside neutral chrome (no store name) with no "Opening soon", in body or metadata. The home page rejects with `ContentUnavailableError`, and `error.js` renders "Something went wrong". Fails if `closedNow`'s catch returns true: B18 |
| 8 | rendered: section_render_failed carries the real store id | **Pass** | "rendered: section_render_failed carries the real store id …": a throwing section published on store `fj`. The real `page.js` is rendered outside any tenant context, as in Next. The line is `["fj", "sec_boomf"]`; before the change it was `_default`, as P3-VALIDATE's reviewer saw on the real server. Fails without the change: B15 |
| 9 | rendered: a closed store's /quiz/<slug> and /bundles/<slug> leak no founder copy in HTML or RSC payloads | **Pass** (rendered), and **seen on the real server** (`next dev`) | "rendered: a closed store's /quiz/<slug> and /bundles/<slug> …": page render and metadata with no cookie, `_admin`, or `_platform`+`_mx`. None of the 6 strings appear; the closed page and closed metadata do. A preview session and an open store still show them. The client components (QuizRunner, BundleAddButton) are stubbed to print their props, so props that would travel in the payload count. Drill: before the fix, 12 of 12 requests carried copy; after, 0 of 12 (below). Fails without the change: B16, B17 |

## Drill (`docs/cms-reviews/drills/P3-FRAME/`)

The harness ran from this worktree (`DESIGN_PORT=3860 DESIGN_SQLD_PORT=4860 pnpm dev:design`, `next dev`). `setup.mjs` worked on the harness's local sqld only:
- it moved tenant `design` to documents mode, setting its seeded v3 pointer aside;
- it published a home page (hero, text, FAQ, banner), header, footer, announcement and an about page through the real service;
- it saved a draft hero title and minted a session. The token went to the scratch folder and was never printed or committed.

**`frame.mjs`: a same-origin stand-in for the editor (an iframe on the store's origin). 19 of 19 passed (`frame-results-part1.json`).**
- On the real server, the preview HTML carried every `data-doc` (header, announcement, footer, `doc_home`) and the `data-field` paths. This confirms the request-scope holder works under React's real server `cache`.
- The mount announced v1 ready. Hello v2 got `ok:true` with the session's state and no token.
- Clicking the hero's button picked `primary.label` and the frame did not navigate. A header link picked `doc_header` and did not navigate. An FAQ question picked `items.1.q`.
- `select` outlined `sec_text`. After scrolling to 700, `refresh` reloaded, scroll 700 came back and the outline came back.
- "See the live store" had `href` `/api/preview?exit=1&to=%2F`. With v2 on (and `_admin`), clicking it took the frame to `/about` live and dropped the cookie, and the bridge then said `reason:"live"`. No page errors.
- At 375 there was no sideways scroll (`preview-375.png`).
- `_admin` with no preview: ready `ok:false`, `reason:"live"`, and Edit this page linked to `/admin/editor?path=%2Fabout` (`live-console-1440.png`).
- A shopper's `/about` had no link, no attributes and no bar.

**`ended.mjs`: after `setup.mjs revoke`. 5 of 5 passed (`frame-results-part2.json`).** The bridge mounted. Ready said `ok:false`, `reason:"revoked"`. The ended bar showed (`ended-1440.png`) over the live store (no draft, no attributes). Exit cleared the cookie.
- The first run failed this step. The bridge stopped the bar's own Exit link while v2 was on. That was a real defect: the founder could not leave an ended preview or "See the live store" from inside the editor. It is fixed by `[data-preview-bar]`, and break B29 pins it.

**`quiz-probe.mjs`: `/quiz/skin` and `/bundles/night`, full HTML and `RSC: 1` (P3-CLOSED's router-state header) × no cookie, `_admin`, `_platform`+`_mx`.**
- Open store (control): 12 of 12 carry the copy (`quiz-probe-open-control.json`).
- Closed store with the two pages put back to `5bbc819`: 12 of 12 carry it. The full HTML says "Opening soon" and still holds the quiz's 4 strings and the bundle's 2 (`quiz-probe-closed-before.json`).
- Closed store with this branch: 0 of 12; every answer is "Opening soon" (`quiz-probe-closed.json`).

**Stopped afterwards.** The harness got SIGINT. Ports 3860 and 4860 to 4862 were free afterwards and all five processes were gone. No order was placed.

## Do the tests bite?

Each break was applied alone to the finished code, then the named suites were run (`scratchpad/…/P3-FRAME/mutate.py`):

| # | Break | Result |
|---|---|---|
| B1 | An ended session gives plain `null` (no `previewRefused`) | Caught (overlay, frame) |
| B2 | A token past its own expiry is not refused | Caught (overlay) |
| B3 | No ended bar | Caught |
| B4 | No live bridge for a console cookie | Caught (2) |
| B5 | Live bridge and Edit this page without the cookie check | Caught (4, the byte-equality test included) |
| B6 | v2 doesn't stop links | Caught |
| B7 | v2 doesn't stop submits | Caught |
| B8 | No restore after refresh | Caught |
| B9 | A storage error on save not caught | Caught (suite crash) |
| B10 | `ready` without the unfinished ids | Caught |
| B11 | Rich text offset not computed | Caught |
| B12 | v1 click sent in another shape | Caught |
| B13 | No field annotation | Caught |
| B14 | Hero fields off | Caught |
| B15 | The store id not carried into `section_render_failed` | Caught |
| B16 | Quiz page not gated | Caught |
| B17 | Bundle metadata not gated | Caught |
| B18 | `closedNow`'s catch returns true | Caught |
| B19 | Header `data-doc` for everyone | Caught (4, byte-equality included) |
| B20 | The request scope says "documents preview" for everyone | Caught (3, byte-equality included) |
| B21 | No offline line | Caught |
| B22 | Offline ids not read | Caught (overlay, frame) |
| B23 | The live-store link drops the address | Caught |
| B24 | `<main>` without `data-doc` | Caught (2) |
| B25 | `docs` hashes empty | Caught (overlay, frame) |
| B26 | Edit this page in a preview too | Caught |
| B27 | FAQ not swapped for the preview markup | Caught |
| B28 | A tampered token treated as an ended preview | Caught (overlay, frame) |
| B29 | The preview bar picked and stopped in v2 | Caught |

B3 and B7 were re-run with new patterns after the bar change; both were caught. 29 of 29.

## Tests

- `scripts/test-preview-frame.js`: new (it replaces the P3-SCAFFOLD placeholder). 18 tests: bridge-core on the stand-in DOM (6), the layout (5), attributes (3), the batch 1 review items (3), and edge safety. 0.9 s in the gate.
- `scripts/test-preview-overlay.js`: 2 new tests (refusals; what the overlay tells the frame), and the real-layout bar test now expects the documents banner's words.
- `scripts/test-sections-render.js`: not changed. Its 36 tests pass unchanged (the a6d028e equivalence included): the attributes appear only in a documents preview, which that suite never renders.

## Known limits

- **A closed store's page gets no bridge and no ended bar.** The closed layout is P3-CLOSED's, and `test-release-readers` pins it byte-identical for `_admin`, `_platform` and `_mx` cookies. An ended or live view of a store that has never published shows "Opening soon" only, and the editor falls back on its 3-second re-mint (plan C1).
- **Fields are found by exact text.** In a preview, a renderer that changes a setting's words before showing them leaves that element unmarked. The hero (GEN-03's empty-store subtitle, the highlight span) marks its own fields, so it is not affected. Identical texts in one section are marked in document order. Images, the badge's default words and catalog-bound text (product names) carry no field.
- **The FAQ in a preview is a server copy of the accordion.** The ¶ copy-link button does nothing in a preview, and a `#q-…` address does not open its question there. A test pins the copy's markup to the live accordion's.
- **Edit this page and the "live" bridge exist only on a documents-mode store with a v4 release live.** Legacy stores and a documents store still on a legacy release get today's HTML. The editor's re-mint covers those.
- **In the editor's frame, a click on Edit this page is stopped** like any link while v2 is on. Only `[data-preview-bar]` is exempt.
- **Statement cost, founder only.** A documents preview reads the offline ids (1 statement) and the journal index for the address map (1). An ended preview costs the session read it always did, plus `cms_state`. Shoppers and console-cookie live views add no statement.
- **Quizzes and bundles answer the closed page on a `CMS_MODE_UNAVAILABLE` fault** of a store with no release. This follows `closedStoreGate` (fail closed): during a database fault, a legacy store that has never released shows "Opening soon" on those two pages.
- **The legacy preview bar gained `data-preview-bar=""`** (founder-only HTML, no visible change).
- **`state.sid` is in the preview page's flight data.** A sid is not a credential (the token's HMAC binds it), and the token itself never appears (tested, and checked in the drill).
- The request-scope holder relies on React's per-request `cache` in server components. It was checked on `next dev`, not on a production build.
- `HomeSections.js` was not changed: `SectionView` reads the request scope, so the home page's own caller (`page.js`, not this item's file) needs no `ctx.preview`.

From review:

- Nothing in cms/p3-frame at a52c567 blocks. I reproduced the main claims. The full suite passed on my own install: pnpm test, 81 of 81 suites in 138.2 s. pnpm build also passed.
- The packet's known limit 'request scope checked on next dev only' is now settled. I ran the harness under `next build && next start` (production build, edge storefront, port 4060, sqld 5063-5065) with the builder's setup.mjs. A documents preview of / and /about carried every data-doc (doc_header, doc_announcement, doc_footer, doc_home, the about doc) and every data-field (title, subtitle, primary.label, secondary.label, body.0-2, button.label, text, items.0/1.q/a, meta.title). I then sent 30 preview, 30 live and 30 RSC requests to /about at the same time. No live or RSC answer carried data-field or data-doc. Every preview answer carried body.2. The preview token was in no page. The owner check in the packet can be narrowed to the hosted run.
- On the production build, the ended-preview paths behave as claimed. A revoked session renders 'Your preview has ended, so you're seeing the live store.' with Exit to /api/preview?exit=1 and the bridge {ok:false, reason:'revoked'}. A tampered HMAC gets no bar and no reason, and its page is the same size as the live page. An _admin cookie on /about gives reason 'live' plus Edit this page with href /admin/editor?path=%2Fabout.
- Closed store, quizzes and bundles, on the production build: quiz-probe.mjs gave 0 of 12 requests with founder copy. I also tried 24 more combinations (HTML, RSC: 1 and Next-Router-Prefetch, each with no cookie, _admin, _platform and _mx). None leaked. A valid preview session still sees the quiz.
- Gap in the tests: nothing checks that the submit listener uses the capture phase. When I changed `doc.addEventListener("submit", onSubmit, true)` to `false` in components/preview/bridge-core.js, both suites still passed. The DOM stub does not model capture versus bubble. The code itself is correct. A stub that dispatches capture listeners first, plus a bubble-phase handler that must not run, would pin the brief's 'capture-phase interception'. The click listener is probably unpinned for the same reason.
- While v2 is on, buttons with type="button" still work inside the editor frame: add to cart, wishlist, the cart drawer, the FAQ copy-link. A founder clicking to pick a section on a product page may add the item to their own cart. The brief only asks for anchors, form submits and submit buttons, so this is within scope. It is worth an owner ruling or a later item.
- Other mutations I made, all caught by the suites. Bridge: the message origin check, posting with '*', a <button> with no type counted as type=button, the rich-text offset off by one, the [data-preview-bar] exemption, restoring the place on a different path, the unfinished ids, keepPlace on refresh. Resolve: other_store reported as 'other_store', state.docs including skipped drafts, the ended-token check without HMAC verification, a legacy preview flagged as a documents preview, the store id not noted. Layout: the live bridge for legacy stores, the live bridge without a console cookie, closedNow's catch returning true. Elsewhere: field annotation on live renders, the section_render_failed tenant dropped, the offline line removed, EditThisPage without URL encoding, the closed check removed from quiz metadata and from the bundle page.
- These match the packet's known limits and are fine as written. A closed store gets no bridge or ended bar. The live bridge and Edit this page appear only on a documents store whose live release is v4. The FAQ in a preview is a server-rendered copy, so its copy-link button does nothing. The sid is in the preview's flight data. The field paths follow validate (primary.label, items.N.q/a) rather than the brief's buttons.N.label and items.N.question; P3-PLAN rule 10 and the acceptance both say validate's paths, so this needs no ruling beyond the owner check already listed.
- Note for later harness runs: Node's fetch refuses ports 5060 and 5061 (blocked SIP ports), so DESIGN_SQLD_PORT=5060 cannot start the harness. I used 5063. Everything I started is stopped: the harness, Next and sqld. Ports 4060 and 5060-5069 are free and the rv0 worktree is removed. Nothing was pushed, merged or committed.

## Owner checks

- **Hosted, on a staging tenant in documents mode:**
  - preview, ended preview (revoke from another tab), "See the live store", and Edit this page from the live store with a console session;
  - a forced `section_render_failed` appears in the Vercel log search under the store's id (P3-VALIDATE's owner check, now that the id is carried).
- **Local production build** (`next build && next start`):
  - run `docs/cms-reviews/drills/P3-FRAME/quiz-probe.mjs` against a closed copy of the harness and confirm 0 of 12;
  - open a documents preview and confirm the `data-field` attributes render (the request scope under a production React build).
- **Phones:** the banner ("You're seeing your unpublished changes. See the live store"), the ended bar, the offline line and Edit this page on a real phone (seen only at 375 in desktop Chrome).
- **Words:**
  - "You're seeing your unpublished changes." / "See the live store";
  - "Your preview has ended, so you're seeing the live store." / "Exit";
  - "This page is offline. Publishing it brings it back.";
  - "Edit this page".
- **Ruling:** the field paths follow validate (`primary.label`, `button.label`, `items.N.q`, `items.N.a`), not the brief's `buttons.N.label` and `items.N.question` / `answer`.
- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need the owner's approval.

## Files

- `lib/content/resolve.js`
- `app/(storefront)/layout.js`, `app/(storefront)/quiz/[slug]/page.js`, `app/(storefront)/bundles/[slug]/page.js`
- `components/preview/bridge-core.js` (new), `components/preview/PreviewBridge.js`, `components/preview/EditThisPage.js` (new), `components/PreviewBanner.js`
- `components/sections/index.js`, `components/sections/HeroSection.js`, `components/ContentPage.js`, `components/Header.js`, `components/Footer.js`
- `scripts/test-preview-frame.js`, `scripts/test-preview-overlay.js`
- `docs/cms-reviews/P3-FRAME.md`, `docs/cms-reviews/drills/P3-FRAME/*`
- Not changed though listed: `components/sections/HomeSections.js`, `scripts/test-sections-render.js`

## Commands

```
pnpm test:preview-frame
pnpm test:preview-overlay
pnpm test
pnpm build
FRAME_RECORD=1 node scripts/test-preview-frame.js        # on a copy of 5bbc819: re-records BEFORE
DESIGN_PORT=3860 DESIGN_SQLD_PORT=4860 pnpm dev:design
node docs/cms-reviews/drills/P3-FRAME/setup.mjs <worktree> <scratch> 4860 publish   # then session | revoke | quiz | close
node docs/cms-reviews/drills/P3-FRAME/frame.mjs <worktree> <scratch> 3860 <out-dir>
node docs/cms-reviews/drills/P3-FRAME/ended.mjs <worktree> <scratch> 3860 <out-dir>
node docs/cms-reviews/drills/P3-FRAME/quiz-probe.mjs 3860 <label> <out.json>
```
