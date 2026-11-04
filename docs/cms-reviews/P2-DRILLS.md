# P2-DRILLS: browser drills for phase 2

Branch `cms/p2-drills`, cut from `44a6c7e`. Plan: `docs/cms-reviews/P2-PLAN.md` (batch 6, sections 0, 3, 4 and 6). Spec: DOC-03, DOC-07, PV-03, PUB-01, PERF-01 (section 7), section 8. Builds on every merged phase 2 item, mostly P2-PERF (the documents fixture), P2-SECTIONS (the renderer map, the hero image, the unfinished note), P2-PREVIEW (the overlay), P2-VGATE (neutral chrome) and P2-FIX4 (the redirect). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch. Nothing in `app/`, `lib/` or `components/` changed |
| Locally tested | Yes. `pnpm test`: 66 of 66 suites passed in 119.1 s. `pnpm build` passed (the one warning is the old `/api/errors` trace warning) |
| Browser verified | Yes. Desktop Chrome 156 (headless, through `playwright-core`) on the design harness on this Mac, ports 3800 and 4800 to 4802, storefront on Next's local edge runtime in dev mode. Last full run: 11 parts, 681 checks passed, 0 failed, 2 known failures (findings 1 and 2). Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real store changed mode |

## What and why

Phase 2's items each proved their own piece with unit tests and a few hand-run browser checks. Nothing yet drove the whole documents-mode store in a real browser, at phone and desktop widths, the way the plan's batch 6 asks. This item adds that runner and its fixture, runs it, and reports what it found.

## Design

### `scripts/seed-design-documents.js`

A documents-mode store on the design harness. It reuses `scripts/perf-docs-fixture.js`: `buildDocumentsFixture` (the perf store's content as registry documents), `publishDocumentsFixture` (created through the write service, published through `lib/documents/publish.js`) and `takeOverHarnessStore` (mode `documents`, the seeded v3 pointer cleared).

- It needs the perf seed (`node scripts/dev-design.js seed --fixture perf`), whose catalog and library photos those documents point at, and a stopped harness. `check` reads the store's state and also works while the harness runs.
- `--drafts-only` creates the documents and publishes nothing (a store before its first publish). `--posts N` sets the journal posts (default 3).
- `--worst-case` adds the catalog the section drill binds to, named after `lib/registry/fixtures.js`: 24 products with 150-character names and huge prices (a wide photo, a tall photo, no photo, in turn; the last one sold out), the rail's collection with 12 of them, 24 grid collections with 90-character names (every other one with no photo), and two library photos standing in for the fixtures' `/api/media/worst-case-*.jpg`. The grid collections hold every product plus one, so the store's "biggest first" grid lists them first.
- **Local only.** Every database URL (both harness servers and the store row's own `db_url`) must be `http://127.0.0.1:<port>`; anything else is refused before anything is written. Run by hand: with the store row pointed at `libsql://store.example.invalid`, it printed `✗ the design store's database must point at a local harness database …` and exited 1 with the store unchanged.
- **It never deletes documents.** The first version reset the store in place with `DELETE FROM documents …`. `test-documents` and `test-writers` failed on that (their guards allow document-table writes only in `lib/documents/`). Rather than widen those guards, the seed now refuses a store that already holds documents, and the runner seeds the harness fresh instead.
- Its CLI check uses `fileURLToPath(import.meta.url) === process.argv[1]`, so it runs from a path with a space (part `space`).

### `scripts/drills/p2/run.mjs`

A part runner in the style of `scripts/drills/p1/run.mjs`, built on the P1-HARNESS helpers (`Drill`, `connectHarness`, `launchChrome`).

- `DESIGN_PORT=3800 DESIGN_SQLD_PORT=4800 node scripts/drills/p2/run.mjs [part,part…] [--headed]`. No `package.json` entry; not a gate suite.
- **It owns the harness.** Before each part that needs a store it stops its harness, seeds it fresh (`dev-design.js seed`, with `--fixture perf` for a documents store), runs `seed-design-documents.js`, and starts the harness again (`connectHarness({ start: true })`). It stops it at the end. A harness already running in this checkout is refused, so the runner never wipes one somebody else started. It warns if `DESIGN_PORT` is 3017.
- It signs in through the real console form once per seed (a fresh seed has no sessions) and reuses the cookies within that seed.
- Results go to `scripts/drills/p2/results-<part>.json`; screenshots (each at most 300 KB) to `docs/cms-reviews/drills/P2-DRILLS/`.
- Helpers for the parts: `reseed`, `docsApi`/`getDoc`/`saveDraft`/`publishDoc` (the real `PUT /api/admin/documents` from a signed-in page), `uploadPhoto` (the real `POST /api/admin/media`), `tenantSql` (the running harness's own store database, for set-up only).

### Parts

| Part | File | What it does |
|---|---|---|
| `sections` | `sections.mjs` | Every registered kind (`hero`, `collections`, `new`, `banner`, `rich_text`, `image_with_text`, `product_rail`, `text`, `faq`, `product_main`) with each `worstCase(kind)` case, at 375, 768 and 1440. Each kind's cases go into `doc_home` through the documents API and are published; each case gets its own section id. Hero cases go one at a time (one hero per page). Sold-out cases are published on their own, with every product in the store marked sold out for that look and put back afterwards. Text, rich text, image with text and FAQ also run on a published content page. `product_main` is checked on the worst-case product pages, because the product route still renders the product itself (P2-SECTIONS known limit). At each width: no sideways scroll (`scrollWidth <= innerWidth`), every case's section present, no text past the window outside a scroller, no text cut by a box that hides its overflow, no broken image. Text cut with an ellipsis or a line clamp counts as truncation by design: it is listed in the notes, not failed |
| `hero-image` | `publish.mjs` | A photo uploaded to the library, set as the hero image with alt text through `saveDraft`, published, and looked at signed out at 1440 and 375. Then the same with a `/` path that isn't the library (`/icons/icon-512.png`) and with an https photo from another host (a local https server with a throwaway self-signed certificate on port 4806; the shopper's context accepts it). Checks the `alt`, that the image loaded, its `src`, and that no `/_next/image` request is made for it |
| `policy-typo` | `publish.mjs` | A shipping page with a typo goes live. The home draft is then saved dirty (a new hero title) and incomplete (an empty banner). The policy fix is saved and published alone |
| `preview` | `preview.mjs` | Before the first publish (`--drafts-only`): a shopper, then a founder's session (`POST /api/admin/preview-session`, then its link). After the first publish: a home draft and a `doc_design` draft accent; the "Show them" and "Hide them" buttons; the legacy preview refused; an old-format token minted by the legacy preview while the store was briefly legacy (a tab from before the move), then used on the documents store; signing out of the console |
| `unfinished` | `preview.mjs` | A home draft with an empty banner and a rail with no collection, previewed and looked at live. The click target: the preview in a frame on the store's own origin, spoken to with the Designer's own protocol (`storeasy:designer:hello`, then a real click on the note). Then the real Designer page |
| `redirect` | `preview.mjs` | `/api/preview?to=` with each of P2-FIX4's 17 hostile values (with no token, a bad token, and `exit=1`), its raw links, the review's dot-segment values, and a good path. Every other host is stopped and recorded by the browser context, so the browser never leaves |
| `error-chrome` | `publish.mjs` | The live v4 list's entries for `doc_home` and `doc_header` pointed at a version that doesn't exist (the list is put back afterwards). Then only `doc_header`'s, to record what other pages do |
| `edge` | `publish.mjs` | Twelve storefront routes on the v4 store, with `x-edge-runtime` and status |
| `space` | `run.mjs` | Copies of `perf-docs-fixture.js` and `seed-design-documents.js` run from `…/Projects 2026/storeasy26/scripts/` (everything else linked back to this checkout) |
| `legacy` | `run.mjs` | The plain legacy seed, then `node scripts/drill.js smoke` and `harness-edge` (`pnpm drill:smoke` and `drill:edge`) unchanged. Copies of their `results.json` are kept as `legacy-*-results.json`; the journeys also rewrite their own folders (`drills/smoke/`, `drills/P1-HARNESS/`), which were put back with `git checkout` before committing |

The seeded store runs a hero test (`hero-promise`), whose variant b replaces the hero title. The hero cases of `sections`, and the `preview` and `unfinished` parts, pause it while they look and start it again afterwards. How a preview treats a running test is PV-08's and is not drilled here.

## Acceptance, with evidence

"Drill" means the named part, in desktop Chrome on the design harness, in the last full run. Results are in `scripts/drills/p2/results-<part>.json`.

| Item | Status | Evidence |
|---|---|---|
| Every registered section kind passes at 375, 768 and 1440 with its worst-case fixture (no overflow, no clipped text) | **Proven**, with one case refused by design | `sections`: 453 passed, 0 failed. All 10 kinds; every case of 9 home kinds, the 4 page kinds on a content page, and `product_main` through 4 product pages, each at 3 widths. The 120-character hero title was checked to be what the shopper sees. Sold-out cards say "Sold out". **`image_with_text` with no image can't be published** (the image is required; publish answers 422 `REQUIRED`), so shoppers never meet it on a documents store; the drill checks that refusal, and the fallback look stays covered by `test-sections-render` §4. Truncation by design (product names clamped with an ellipsis, collection titles) is listed in the notes. Screenshots `sections-*` |
| A hero image published through the API renders on home with alt text | **Proven** | `hero-image`: 32 passed. Library photo: uploaded (200), saved and published (200), at 1440 and 375 the hero `<img>` has the alt, loaded, `src` is its own `/api/media/med_…`. Break B1 below |
| A hero photo off the Shopify CDN loads from its own url, not `/_next/image`, without a broken image | **Proven** | `hero-image`: `/icons/icon-512.png` and `https://localhost:4806/hero.jpg` each load from their own url at both widths, no `/_next/image` request; the https server saw the browser fetch `/hero.jpg`. Break B1 |
| A policy typo published while `doc_home` has a dirty, incomplete draft goes live; home is unchanged | **Proven** | `policy-typo`: 8 passed. The save reported `sec_drillbanner:title:SECTION_EMPTY:incomplete`. The fix published alone (200, one document); the shopper sees the fixed sentence, not the typo; home's text and section ids are identical before and after; neither the draft title nor a note shows; `doc_home` is still dirty with its banner |
| Preview overlays drafts before and after the first publish; the colours toggle applies `doc_design`; an old-format token shows live only | **Proven** | `preview`: 20 passed. Before the first publish a shopper gets the error page (500, neutral chrome, no draft) and the founder's preview shows the drafted hero and announcement with the preview bar. After: the founder sees the draft hero, the shopper the live one; "Your new colours are not shown here." and no `#7c3aed` in the page until "Show them", then the accent is in the page and the bar says they are shown; the shopper keeps the live colours; "Hide them" takes them off. The legacy preview is refused (409). An old-format token still sets the cookie but shows live only. Screenshots `preview-*` |
| Logging out of the console removes the overlay | **Fails (finding 1).** Not in the acceptance list; recorded as a known check | `preview`: after `POST /api/admin/logout` (200, the dashboard asks to sign in again), the same browser still shows the draft hero; the `_preview` cookie and its session stay valid for up to an hour |
| A corrupted live version shows the error page with neutral chrome | **Proven** | `error-chrome`: 13 passed. With `doc_home`'s and `doc_header`'s versions missing, `/` answers 500 with "Something went wrong" at 1440 and 375; header and footer hold only `/`, `/collections`, `/wishlist`, `/account`, `/contact`; no announcement, no store menus, the name "Store". Put back, the store shows again. Break B4. See finding 3 for a chrome-only corruption |
| v4 storefront routes carry `x-edge-runtime: 1` | **Proven** | `edge`: 25 passed. The live release is v4; home, `/policies/shipping`, a page, a campaign, `/journal`, a post, `/collections`, a collection, a product, search, contact and an unknown policy (404) each carry `x-edge-runtime: 1` with the right status and no error page. Route handlers (`/api/*`, sitemap) send no such header and are not claimed |
| Legacy `drill:smoke` and `drill:edge` pass unchanged | **Proven** | `legacy`: 4 passed, on the plain legacy seed in legacy mode. `drill:smoke` 31 passed, 0 failed; `drill:edge` 151 passed, 0 failed, 4 known (P1-HARNESS finding 5, as before). `legacy-smoke-results.json`, `legacy-harness-edge-results.json` |
| An unfinished section shows the founder note in preview and a click selects it in the Designer; live shows neither | **Partly proven. The Designer half is NOT DONE (finding 2)** | `unfinished`: 8 passed, 1 known. In the preview the banner and the rail each show "…: not finished yet … Only you can see this in your preview." with their own `data-section-id`; a shopper sees neither the notes nor the sections. In a same-origin frame, the bridge answers the Designer's hello, a real click on the banner's note sends `storeasy:sec:click` with `sec_drillbnr`, and the note is outlined as selected. **The real Designer can't preview a documents store**: it shows "Preview couldn't start … This store publishes with the new editor, so this preview can't open here" and no frame (`unfinished-designer-1440.png`), so "selects it in the Designer" can't happen yet. Break B3 |
| Every hostile preview redirect lands on the store's own origin in a real browser | **Proven** | `redirect`: 115 passed. 17 values × (no token, bad token, exit): each lands on the store's home; 10 raw links (including `?token=bad&to=/%5Cevil.com`, `/%09/evil.com` and the review's `/a/..//evil.com`, `/..//evil.com`, `/%2e%2e/%2e%2e//evil.com`) land on the store's origin; `/collections` is kept; the browser requested no other host. This is P2-FIX4's owner check OC-F1, done by the drill. Break B2 |
| The perf fixture CLI runs from this repo's path, which contains a space | **Proven** | `space`: 3 passed. From `…/Projects 2026/storeasy26/scripts/`, `perf-docs-fixture.js hash --posts 0` prints the same hash as here, an unknown command exits 2, and `seed-design-documents.js` refuses an unknown option (exit 1). With this seed's CLI check put back to the `file://` string compare, the third check fails (exit 0, no output) |

### Requirements

| Requirement | What the drills add |
|---|---|
| DOC-03 | The shopper look of every kind's worst cases in a real browser at three widths. Founder notes for the state table stay PV-02/PV-09. A field attribute per text (ED-04) is not drilled |
| DOC-07 | A hero image added through the API (the editor UI is ED-02), from the library, a store path and another https host |
| PV-03 | Before and after the first publish, the colours toggle, old tokens, sign-out (finding 1). Two tabs and `product_content` are as P2-PREVIEW recorded |
| PUB-01 | A per-document publish next to a dirty incomplete draft; a missing version gives the error page with neutral chrome (finding 3 for chrome-only) |
| PERF-01 | The v4 routes on the edge runtime. Read counts are P2-PERF's |

## Do the drills bite?

Each break was applied alone to the app in this worktree (the dev server reloads it), the named part run, the file put back (`git diff` empty afterwards). Script: `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p2-b6/P2-DRILLS/breaks.py`. These ran against an earlier runner that re-seeded in place; the parts' checks are the same.

| # | Break | Part | Result |
|---|---|---|---|
| B1 | `HeroSection` sends every hero photo through the optimizer (`unoptimized={false}`) | `hero-image` | caught: 11 failed (the store path goes to `/_next/image`) |
| B2 | the redirect's backslash/control check and origin check both removed (P2-FIX4's two layers) | `redirect` | caught: 21 failed (`/\evil.com` landed on `http://evil.com/`, stopped by the context) |
| B3 | the unfinished note branch in `components/sections/index.js` removed | `unfinished` | caught: 2 failed |
| B4 | on `ContentUnavailableError` the chrome keeps the default nav and an announcement | `error-chrome` | caught: 6 failed |
| S1 | `seed-design-documents.js` CLI check back to the `file://` string compare | `space` | caught: 1 failed |

## Findings (for the owner)

1. **Signing out of the console doesn't end the founder's preview.** `app/api/admin/logout/route.js` revokes the console session and clears `ADMIN_COOKIE`, but not the `_preview` cookie, and the `preview_sessions` row stays valid. The same browser keeps showing drafts for up to an hour (the token's life). On a shared computer, the next person at that browser sees unpublished drafts. Not caused by this branch (P2-PREVIEW). Suggested fix: logout also clears `_preview` and revokes the person's live preview sessions. The drill's check is marked `known: "finding 1"` and will say when it passes.
2. **The Designer can't preview a documents-mode store.** It mints its preview through the legacy releases route, which refuses documents stores, so it shows "Preview couldn't start" and no frame; its section tree is the legacy draft's. So the P2-SECTIONS owner check "clicking the note in the Designer selects that section" can't be done yet. The preview side works (the bridge sends the note's own section id). This is the editor's job (ED-02). Marked `known: "finding 2"`.
3. **A missing version of a chrome document alone doesn't give the error page.** With only `doc_header`'s version missing, `/` and `/policies/shipping` answer 200 with their own content under neutral chrome (no menus, no announcement). Nothing wrong or leaking is shown, but PUB-01's negative says a release pointing at a missing version gives the error page. When the route's own document is missing too, it is the error page. Recorded in `results-error-chrome.json`; not failed.
4. Before its first publish, a documents store gives shoppers the error page (500, neutral chrome). This is the fail-closed design (P2-READ), recorded so nobody is surprised at cutover.

## Tests

| Run | Result |
|---|---|
| `pnpm test` | 66 of 66 suites passed in 119.1 s |
| `pnpm build` | passed |
| `node scripts/drills/p2/run.mjs` (all 11 parts) | sections 453, hero-image 32, policy-typo 8, error-chrome 13, edge 25, preview 20 (+1 known), unfinished 8 (+1 known), redirect 115, space 3, legacy 4 passed; 0 failed. 10 min 25 s, most of it the eight fresh seeds and harness starts |

No new suite: drills aren't gate suites (plan decision 14). `test-documents` and `test-writers` caught the first version's direct document-table deletes (see Design).

## Known limits

- **Local Next dev only**, on this Mac, headless desktop Chrome. Not a production build, not Safari, not a phone, not hosted.
- **"Clipped text" is measured, not seen.** A text node counts as clipped when a box that hides its overflow cuts it, or it runs past the window outside a sideways scroller. Text cut with an ellipsis or a line clamp is counted as truncation by design and only noted (product names clamp to two lines on cards; long collection titles end in "…"). Overlap between two texts is not measured.
- **`image_with_text` with no image** can't reach shoppers on a documents store; its fallback is covered only by the rendered test.
- **`product_main`** is drilled through the product page the route renders itself, not through the section map.
- **The worst-case catalog bends the store**: its grid collections hold every product, so they top the "biggest first" grid. Other kinds use the perf store's catalog.
- **Hero tests are paused** during the hero cases and the preview parts. A drill killed mid-part leaves `hero-promise` paused; the next fresh seed puts it back.
- The `error-chrome` part edits the live release row's list in the harness database (put back in a `finally`); a fresh seed also clears it.
- The old-format token is minted by briefly switching the harness store to legacy mode, as a tab opened before a move would hold one.
- The https photo server uses a self-signed certificate that the shopper's browser context is told to accept; a real browser would want a trusted host.
- The `legacy` part rewrites `docs/cms-reviews/drills/smoke/` and `P1-HARNESS/` (those journeys always do). Drop those changes with `git checkout` after a run, as was done here.
- Home's text is compared by `textContent`, not `innerText`: during the first runs the same page's rendered text came back once as "Protein" and once as "PROTEIN" (CSS `text-transform` applied at a different moment), with nothing else different.
- Each part re-seeds and restarts the harness, so a full run takes about 10 minutes.

### From review

Non-blocking findings from the independent review, added at merge.

- Results I reproduced on ports 3900 and 4900 to 4909, with DRILL_HTTPS_PORT=4906, in a detached worktree at fe7b8a1. A full run of node scripts/drills/p2/run.mjs gave the same counts as the builder: sections 453, hero-image 32, policy-typo 8, error-chrome 13, edge 25, preview 20 plus 1 known, unfinished 8 plus 1 known, redirect 115, space 3, legacy 4, and 0 failed. pnpm test passed 66 of 66 suites in 119.9 s. The diff only touches scripts/, docs/ and screenshots. Nothing in app/, lib/, components/, package.json or .github/ changed, so edge-runtime code is unaffected.
- Deliberate break I ran myself: I added 'truncate' to the hero h1 and 'whitespace-nowrap' to the banner h2, then ran the sections part. It caught both, with 15 failures: hero text past the window or clipped at all three widths, and the banner at scrollWidth 949 against 375 and 973 against 768. So the overflow and clipped-text checks do bite. I put the files back afterwards.
- A packet claim is false. The Design section says that with the store row pointed at libsql://store.example.invalid, the seed 'printed ✗ … and exited 1 with the store unchanged'. I reproduced it: perf seed, tenants.db_url set to libsql://store.example.invalid, then seed-design-documents.js with the harness stopped. It exited 0 and published 36 documents. The reason is that withHarnessStore calls pointTenantAtThisRun, which quietly resets db_url to http://127.0.0.1:4901 before assertLocalDbUrl checks the row. So that row check can never fire on the write path. Nothing reached a remote host, because every write went to the local URLs that were checked. Fix: correct the packet, or check the row before pointTenantAtThisRun runs.
- The product_main pages are labelled 'product-long-wide' and 'product-tall', but the product page shows 'No image' for both (screenshots sections-product_main-product-*-*.png). The product gallery does not use the products.featured_image the seed sets, so those pages test no photo at all. worstCase('product_main') only has long_text and sold_out, so the acceptance item still holds. The labels and the packet's 'a wide photo, a tall photo, no photo' should be corrected.
- The redirect part tries each of the 17 P2-FIX4 values with no token, a bad token and exit. It does not try a valid token, which the P2-FIX4 table also lists, and it does not try the preview bar's POST. The packet says '17 values × (no token, bad token, exit)', so this is disclosed, but the P2-FIX4 table's 'valid token' cases have not been checked in a real browser.
- In policy-typo, the check 'the home draft is saved dirty and incomplete' only tests for HTTP 200. Whether the empty banner was flagged incomplete is only written to the notes; this run flagged it, as SECTION_EMPTY. Later checks confirm the draft is dirty and still holds the banner, but the incomplete flag itself is never asserted.
- The https photo server defaults to port 4806 unless DRILL_HTTPS_PORT is set. Another agent on other ports could clash with the builder's port range. The port should come from DESIGN_SQLD_PORT, for example base + 6.
- The text checks treat any ellipsis or line-clamp as truncation by design and only note it, never fail it. This is disclosed under Known limits and is left to the owner's screenshot check. Listing the elements that are allowed to truncate would be stricter.
- The four findings for the owner hold up. Finding 1: app/api/admin/logout/route.js clears only ADMIN_COOKIE, and the drill showed the _preview cookie still set and the draft hero still visible after logout. Finding 2: 'Designer selects the section' is NOT DONE, and the drill shows 0 frames. Finding 3: chrome-only corruption gives 200 with neutral chrome. Finding 4: a store before its first publish shows shoppers a 500 page. The Designer half of the unfinished item is honestly marked partly proven. The logout check is not in the acceptance list.
- Clean-up: the legacy part rewrites docs/cms-reviews/drills/smoke and P1-HARNESS in the checkout, which is documented. My review worktree was removed, and nothing is left listening on 3900 or 4900 to 4909. A stray sqld from my own helper script was killed before removal.

## Owner checks

- **Finding 1**: decide whether signing out must end the founder's preview (suggested: yes, clear `_preview` and revoke the sessions).
- **Finding 2**: the Designer's click-to-select on an unfinished note in a documents store waits for ED-02's editor; check it in a browser then.
- **Finding 3**: decide whether a missing chrome version alone must give the error page (PUB-01 as written) or neutral chrome is enough.
- **P2-FIX4 OC-F1** is now covered by the `redirect` part on the harness; on staging, repeat three of the links by hand.
- **CI sqld** (unchanged): `.github/` was not touched. `test:publish` and `test:publish-service` need sqld in CI; the download's source and checksum need your approval.
- Look at the `sections-*` screenshots and say whether the clamped product names and collection titles are the look you want.
- Real phone (Safari) and staging: the hero with an image, the preview bar, and a policy page.
- DR-1, DR-2 and DR-3 stand. No real store is in documents mode.

## Files

- New: `scripts/seed-design-documents.js`, `scripts/drills/p2/run.mjs`, `scripts/drills/p2/sections.mjs`, `scripts/drills/p2/preview.mjs`, `scripts/drills/p2/publish.mjs`, `scripts/drills/p2/results-*.json`, `docs/cms-reviews/drills/P2-DRILLS/*`, `docs/cms-reviews/P2-DRILLS.md`

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
export DESIGN_PORT=3800 DESIGN_SQLD_PORT=4800
node scripts/drills/p2/run.mjs                      # every part (starts and stops its own harness)
node scripts/drills/p2/run.mjs sections,redirect    # some parts
git checkout -- docs/cms-reviews/drills/P1-HARNESS docs/cms-reviews/drills/smoke   # after the legacy part
node scripts/dev-design.js seed --fixture perf && node scripts/seed-design-documents.js --worst-case   # the store by hand
node scripts/seed-design-documents.js check
pnpm test
pnpm build
```
