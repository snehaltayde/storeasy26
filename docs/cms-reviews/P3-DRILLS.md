# P3-DRILLS: every phase 3 drill, and the cross-item matrix (PUB-02 to PUB-11, ED-02 to ED-12, PV-01, PV-02, AU-01, AU-02, AU-04, TOK-03)

Plan: `docs/cms-reviews/P3-PLAN.md` (batch 5) and `P3-BATCHES.json`. Branch `cms/p3-drills`, cut from `7113534`. No migration. No new dependency. Nothing in `app/`, `lib/` or `components/` changed. Nothing under `.github/` changed. No real tenant changes mode.

This is the author's own report. Reviewers should re-read the code and the results files.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 131.4 s (`PORT=6100 DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 SHOPIFY_OAUTH_PORT=7107 TEST_PUBLISH_PORTS=7103,7104 TEST_PUBLISH_SERVICE_PORTS=7105,7106 TEST_PUBLISH_UNDO_PORTS=7108`). `pnpm build` passed; its two warnings are the old `next.config.mjs` NFT trace |
| Browser verified | Yes. Desktop Chrome 156 (headless, through `playwright-core`) on the design harness from this worktree (`DESIGN_PORT=6100`, `DESIGN_SQLD_PORT=7100`, so 7100 to 7102; `DRILL_HTTPS_PORT=7106`; `next dev`). Every stage passed: see "Acceptance". Not Safari, not a real phone, not a production build |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

Batches 1 to 4 built the publish service, the editor and its parts, and each item drilled its own slice. Nothing yet walked a founder through the whole of phase 3 in one browser, on one seed, the way the spec's timed tasks do. This item:
- runs every per-item drill (smoke, routes, editor, design, rte) from one runner;
- adds the cross-item matrix the brief lists, each part on a fresh seed, with screenshots and click counts;
- turns the four P2-DRILLS findings, and the `--drafts-only` preview check, into plain checks, now that phase 3 fixed them;
- narrows P3-ROUTES' "no legacy preview frame" check to the Designer's frame, as the P3-EDITOR review asked.

## Design

### Files

| File | What it does |
|---|---|
| `scripts/drills/p3/run.mjs` (new) | The runner. Stages: `items` (the five per-item drills, each its own process, each seeding the phase 3 store itself), `matrix` (matrix.mjs, part by part), `legacy` (drill:smoke and drill:edge through the P2 runner's legacy part, on the plain legacy seed), `p2` (every P2 part on the P2 seed). A copy of each item's results goes to `docs/cms-reviews/drills/P3-DRILLS/items/`. The summary is `results-run.json` (or `results-run-<stages>.json` for a partial run) |
| `scripts/drills/p3/matrix.mjs` (new) | The cross-item matrix, 13 parts, each through `lib.mjs` `runDrill`, each starting with `reseed()` (the `--p3` seed), one click counter per browser context |
| `scripts/drills/p2/run.mjs` | The four former known checks and the `--drafts-only` bar check, flipped without editing the part files (see below) |
| `scripts/drills/p3/routes.mjs` | The "no legacy preview frame" check counts only frames outside the new editor; the legacy Designer's failed-push words follow P3-FIX3 |
| `docs/cms-reviews/MANUAL-CHECKS.md` | "Phase 3, batch 5": the plan's section 5 owner checks, plus what this item found |

### Two seeds (P3-HARNESS review)

The P2 drills sign in with the shared setup password (`drill.js` `signIn`); the `--p3` store has members, so it refuses that password. So:
- `items` and `matrix` run on the **phase 3 seed** (`node scripts/seed-design-documents.js --p3`), owner and staff logins from `.design-data/p3-seed.json`;
- `p2` runs on the **P2 seed** (`dev-design.js seed --fixture perf` plus `seed-design-documents.js`, `--drafts-only` where the part asks);
- `legacy` runs on the **plain legacy seed** (`dev-design.js seed`).

### The matrix parts

| Part | What it does, as a founder would |
|---|---|
| `task1` | Founder task 1. Timer starts on the editor's home page. Click the hero's title in the preview (it focuses the title field), type; click the button text field, type; Publish; Publish. Stops when a shopper's phone-width (375) page shows both new texts |
| `task4` | Founder task 4. Set-up: the shipping policy is live with a typo ("withn"); the home page has a half-finished draft banner. Timer starts on the live policy page, signed in. Click "Edit this page"; click the typo in the preview (it focuses the paragraph), retype; Publish; Publish. Stops when a phone-width shopper sees the fix. Then checks the home banner is not live |
| `task5` | Founder task 5, twice. (a) A hero change published in the editor, then Undo, Undo in the publish message; the next Publish shows "Nothing has changed". (b) The size guide is changed and published elsewhere; from the home editor: Publishing in the nav, the top row's Undo, Undo; that page's change list is then empty |
| `closed` | The closed store (`closed.localhost`). A shopper sees "Opening soon"; contact and checkout get 403 `STORE_CLOSED`; the RSC probe (below); the owner opens a preview session, adds a product to the cart, goes through the real checkout with cash on delivery, `snehal@mediastic.in`; a card or UPI request gets 403 with the COD-only words; the order is cancelled at once through the console's orders route; then the first open: Publish on the about page, the review, Publish, then "Publish with the home page" (FIRST_PUBLISH_NEEDS_HOME), both lists shown first; the store opens |
| `publish-both` | The spring guide's draft links to the unpublished campaign. Publish, review, Publish: the offer "Publish these together", with the campaign's own list ("goes live for the first time") loaded before "Publish both" turns on |
| `offline` | The weekend campaign: "Take this page offline"; the dialog lists the home page as linking to it; Take it offline; shoppers get 404; the preview's bar says "This page is offline. Publishing it brings it back."; Publish, "Publish it again?", Publish it again; live again |
| `keep-live` | PUB-09. Hero title and the campaign banner's title edited; Publish; the review lists both; "Keep the live version" on the banner row; Publish; the hero is live, the banner is not |
| `conflict` | Two tabs on the home page. Tab B saves, tab A types: the choice shows with A's text on screen. "Keep mine" once, "Use the newer version" once. Earlier versions lists "Kept from another tab" |
| `keepalive` | Type, then close the tab inside the 700 ms pause: the keepalive save reaches the server. Then the network is cut for that save: "Could not save: We couldn't reach Storeasy…"; the tab dies without its keepalive; the next open offers "We found edits that weren't saved", and "Keep them as an earlier draft" puts them in Earlier versions |
| `pv01` | The preview failure matrix. Revoked (the session the frame's cookie names is revoked), expired (its row's time moved into the past), exit (the frame goes to `/api/preview?exit=1`), each followed by an edit: Reconnecting, a new session, Up to date with the edit in the frame. "See the live store" from the frame's bar, then back. Network: making a session fails: "Could not update" with "Check your internet connection", "Try the preview again" brings it back |
| `session` | The Designer's address opens the editor at the home page; Sign out (one click) ends the preview in the same browser (cookie gone, no open session); staff see Publish and Recently published's Undo disabled with the reason |
| `design` | From the home editor: All pages, Brand (two clicks); change the accent; the preview shows it; Publish, Publish; a shopper's page has the new accent; Undo, Undo; the old accent is back. Also the two-tab case of finding D1 (below), as a known check |
| `error-chrome` | Only `doc_header`'s version missing from the live list: `/`, a policy page and a campaign page each give the error page (500), none of their own words; the list put back, the store shows again |

**The RSC probe** is P3-CLOSED's: the 8 routes it lists (`/`, `/contact`, `/about`, `/policies/about`, `/campaigns/spring`, `/journal`, `/journal/first-post`, `/collections`), each with no cookie and with forged `_admin`, `_platform` and `_mx`, each as a page and as an `RSC: 1` request with a router-state header claiming the layout is loaded. It runs in the browser (`fetch` from a page on `closed.localhost`, cookies set on the context), because Node can't resolve `closed.localhost`. It searches for the closed store's four draft strings. The control: once the store is open, the same RSC request to `/` does carry the home page's words.

**The test order.** The closed store has no catalog, so the drill copies one product and its variants from the design store's local database into the closed store's local database. The harness blanks every Shopify and Razorpay key, so nothing leaves the machine. The order is cancelled with `POST /api/admin/orders/<id> {action:"cancel"}` straight after it is placed. Card details are never entered: card and UPI are refused by a direct `razorpay_create` request.

### The P2 flips (`scripts/drills/p2/run.mjs`)

The P2 part files (`preview.mjs`, `publish.mjs`) are not this item's, so the runner does it:
- `FLIPPED`: a check marked `known: "finding 1"` (logout ends the preview, fixed by P3-SESSION) is recorded as a plain check. A check marked `known: "finding 2"` (the Designer can't preview a documents store) is **retired**, with a note: the Designer redirects to the editor on a documents store (P3-ROUTES).
- `AFTER.unfinished` replaces finding 2 with the editor preview check: on the same seed and drafts, the Designer's address opens `/admin/editor?doc=doc_home`, the preview says Up to date, and a click on the unfinished banner's note in the editor's frame selects that section in the tree.
- `NOTE_CHECKS`: two lines the parts only noted are now checks. Finding 4 (`--drafts-only`): a shopper gets 200 "Opening soon", not the error page. Finding 3: `/` and `/policies/shipping` with only `doc_header`'s version missing give the error page (500).
- `REWORDED`: the `--drafts-only` preview bar check looked for the word "preview" and the old Exit link. The documents preview bar now says "You're seeing your unpublished changes." with "See the live store" (P3-FRAME), so it failed. The same check is made with those words, on the page the part screenshots next.

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | drill: every listed step passes and is recorded with screenshots and click counts; the test order is cancelled | **DONE** (on `next dev`) | `results-run.json` (items, legacy, p2) and `results-run-matrix.json` (the matrix after the fixes in "Runs"). Matrix: 65 passed, 0 failed, 1 known (finding D1). Each listed step and its part: timed tasks 1, 4, 5 (`task1`, `task4`, `task5`); closed store, first open, COD order with Razorpay refused (`closed`); RSC probe (`closed`: 64 requests, 0 with draft text, plus the control); checks and "publish both" (`publish-both`); take offline with linkers, the offline line, publish again (`offline`); PUB-09 (`keep-live`); two tabs, both choices (`conflict`); keepalive and the backup offer (`keepalive`); the PV-01 matrix and See the live store (`pv01`); logout, the Designer redirect, staff (`session`); design publish and Undo (`design`); the error page (`error-chrome`); legacy smoke and edge (`legacy`). Screenshots: 41 in `docs/cms-reviews/drills/P3-DRILLS/`. Click counts are in the details of the checks where the founder clicks; the timed tasks: task 1, 4 clicks, 2.8 s; task 4, 4 clicks, 3.0 s from the live page; task 5, 2 clicks, 1.4 s from the same page and 3 clicks, 31.5 s from Publishing (most of it waiting for the live page to change). The test order: `DES-BB629872`, `snehal@mediastic.in`, status `cancelled` (`results-closed.json`). Every earlier run's order was cancelled the same way, and each re-seed wipes the local databases |
| 2 | drill: P2 drills run with the former known checks as passes; drill:smoke and drill:edge unchanged | **DONE** | `results-run.json`, stage p2: sections 453, hero-image 32, policy-typo 8, error-chrome 15, edge 25, preview 22, unfinished 9, redirect 115, space 3, legacy 4; 0 failed, **0 known** (before: 2 known, and the drafts-only bar check failed). The flipped checks: "after signing out of the console, the same browser no longer sees the draft overlay" (finding 1, plain); finding 2 retired, replaced by "the editor previews a documents store … a click on the unfinished note selects that section there"; "before the first publish (--drafts-only): a shopper gets 200 'Opening soon'" (finding 4); "… with only doc_header's version missing gives the error page" ×2 (finding 3); "before the first publish (--drafts-only): the preview bar shows, in the documents preview's words". Legacy: drill:smoke 31 passed, 0 failed; drill:edge 151 passed, 0 failed, 4 known (P1-HARNESS finding 5, the maintenance page source, as before) (`docs/cms-reviews/drills/P2-DRILLS/legacy-*-results.json`). Fails without the change: at `7113534` the runner leaves finding 2 as a known failure (the P3-ROUTES review saw it fail for the new reason), records findings 3 and 4 only as notes, and the preview part fails "before the first publish: the preview bar shows" (seen in this item's first run, before `REWORDED`) |
| 3 | unit: pnpm test green | **DONE** | 81 of 81 suites passed in 131.4 s. No suite was added or changed (this item owns no suite) |
| 4 | drill: Design is reachable from the editor switcher in documents mode and a design publish shows on the live store | **DONE** | `results-design.json`: "a documents-mode founder reaches the design from the editor's page list (All pages, Brand: two clicks)", then the accent in the editor's preview, then "after Publish the live store's look changes (the new accent)" (`#0d9488` to `#dc2626` on a shopper's page), then "Undo puts the old look back on the live store". Screenshots `design-editor-preview-1440`, `design-live-after-publish-1440`, `design-live-after-undo-1440` |

Also from the batch reviews:
- **P3-EDITOR review (routes.mjs):** the check now counts frames outside the new editor. At `7113534` it failed ("frames": 1, the editor's own); now `routes`: 31 passed, 0 failed. The same run showed the legacy Designer check's words were stale since P3-FIX3 (the server's own "We couldn't reach the database, so the preview didn't update."); `routes.mjs` now expects those words.
- **P3-RTE review:** P3-FIX4 (clean a web page's paste on save) is not merged on `7113534`, so this drilled the "Edit as HTML" way out: `rte` step 7 (43 passed): the paste with `<product-info>` is refused with WORDS_LOST and nothing stored, the field offers Edit as HTML, the tag is removed there, and the save stores the cleaned text.
- **P3-DESIGN review:** acceptance 4.
- **P3-HARNESS review:** two seeds (above), one click counter per context, `DRILL_HTTPS_PORT=7106`, `DRILL_TMP` and `DRILL_SCRATCH` in this item's scratch folder.

## Findings

**D1. A design change can show "Up to date" in a preview that doesn't show it (founder-facing, not shoppers).** The editor turns the design's colours on (`setShowDesign`) in its own preview session. The browser has one `_preview` cookie, for whichever session was confirmed last. With two editor tabs, tab B's newer session owns the cookie; tab A then opens Brand and changes the accent: tab A's session gets the colours, the frame uses B's session, so the frame keeps the old colours, while the editor's label says "Up to date". The frame's own bar does say "Your new colours are not shown here. Show them". `next dev` mounts the editor's effects twice, so one tab can hold two sessions, and the same happens in one tab about half the time. Reproduced every run by the `design` part's two-tab check (`design-two-tabs-stale-1440.png`), marked `known: "finding D1"`; the one-tab check is marked known only when it hits this exact case (two sessions, "not shown here" in the frame), and a reload fixes it. Not this item's code (`components/admin/editor/editorModel.js` preview controller, or showDesign by cookie in `/api/admin/preview-session`). Not a blocker by the plan's rule: no shopper sees it and nothing is lost; it is a wrong state label in the founder's preview.

**D2. A banner on a page document renders nowhere on its page route.** Already a P2-SECTIONS known limit (`pageFromBody` keeps only text, rich text, image and FAQ on page routes). Seen again here: the seed's spring guide links to the campaign through a banner; the publish check catches that link and "publish both" publishes it, but `/policies/p3-spring-guide` never shows the banner, in preview or live. The `publish-both` part checks the guide's live version and its `document_refs` instead of the rendered link.

**D3. `next dev`'s own indicator sits where "Edit this page" sits** (bottom left) and takes the click. Dev only; the drill hides it with a style before the click. Not in a production build.

## Runs

1. Full run (`results-run.json`): items 148 passed, 0 failed; legacy and p2 all passed; matrix 57 passed, 3 failed, 2 known: `task4` (D3, the dev indicator came back after the first fix removed it once) and `pv01` revoked and expired (the drill revoked the session minted last, which in `next dev` isn't always the frame's; finding D1's double mint). Fixed in the drill: the dev indicator is hidden with a style, and PV-01 now revokes the session named in the browser's `_preview` cookie.
2. Matrix again (`results-run-matrix.json`): 65 passed, 0 failed, 1 known (D1, two tabs).

Times: smoke 28 s, routes 68 s, editor 43 s, design 24 s, rte 13 s; the matrix about 5 minutes (each part re-seeds and restarts the harness).

## Tests

| What | Result |
|---|---|
| `node scripts/drills/p3/run.mjs` (all stages) | see "Runs" |
| `node scripts/drills/p3/run.mjs matrix` | 13 parts, 65 passed, 0 failed, 1 known |
| `pnpm test` | 81 of 81 suites passed in 131.4 s |
| `pnpm build` | passed (the two old NFT warnings) |

## Known limits

- **`next dev` only**, headless desktop Chrome, macOS. Not a production build (the RSC probe on `next start` is an owner check), not Safari, not a phone.
- **The timed tasks are timed with a script**, which types and clicks at once. The clicks are the real measure here; the seconds only show nothing waits on the founder (a person is the owner check).
- **The test order goes through the real checkout on a local store** with a copied product and no Shopify keys. The Shopify push and the Shopify cancel were not exercised.
- **Card and UPI are refused by a direct request**, not by pressing the Razorpay option: the harness has no Razorpay key, and card details are never entered.
- **"Expired" is made by moving the session row's time into the past** in the local database, not by waiting an hour.
- **The P2 flips live in the runner**, keyed on the part files' labels and notes. If a part's words change, its flip no longer applies: a flipped known check then falls back to the part's own marker, a note check simply isn't made, and a reworded check is not replaced. The P2 results list each flipped check by its new label, so a missing one shows.
- **The per-item drills rewrite their own folders** (`P3-HARNESS`, `P3-ROUTES`, `P3-EDITOR`, `P3-DESIGN`, `P3-RTE`), and the legacy part rewrites `smoke/` and `P1-HARNESS/`. Those folders were restored after the run (they are other items' records); copies of this run's results are in `P3-DRILLS/items/` and `P2-DRILLS/legacy-*-results.json`.
- **Finding D1** is recorded, not fixed (not this item's files).
- **Staging: NOT DONE.**

From review:

- The P2 and P3 drills reproduce. pnpm test passed 81 of 81 in 136.9 s on ports 6300 and 7300 to 7308. The full matrix passed all 13 parts. One exception: keep-live stopped once with 'The harness didn't come up at http://localhost:6300 within 3 minutes'. It passed 3 of 3 when run again, so that was the machine, not the code. Items passed: smoke 26, routes 31, editor 22, design 26, rte 43. Every P2 part passed with 0 failed and 0 known. Legacy drill:smoke was 31 passed, 0 failed; drill:edge was 151 passed, 0 failed, with the same 4 old known checks. The closed-store COD order to snehal@mediastic.in was placed on the local harness and cancelled, and that check passed. No app, lib or components file changed, so there is no edge-runtime exposure.
- The drills catch the faults I planted. (1) I commented out endPreviews in app/api/admin/logout/route.js. matrix 'session' failed: 'no preview session is left open', with openSessions 2. (2) I made sendKeepalive in components/admin/editor/documentsApi.js skip the fetch. matrix 'keepalive' failed, with requests []. (3) I also stopped logout clearing the _preview cookie. The P2 preview check 'after signing out of the console, the same browser no longer sees the draft overlay' then failed as a plain failure (exit 1), not as a known one. So the finding 1 flip in scripts/drills/p2/run.mjs is real.
- Finding D1 happens in one tab more often than the packet suggests. In my full matrix run, the one-tab check 'design: the editor's preview shows the new accent' failed: label 'Up to date', frame accent #0d9488, two sessions, show_design 0 and 1. matrix.mjs then marked it known through its own `raced ? { known: 'finding D1' }` condition. The builder's own full run (results-run.json, design: 2 known) hit it as well. Only the builder's matrix-only rerun did not. Because the check excuses itself when it hits this case, a founder-facing wrong 'Up to date' label never shows as a failure. The frame bar does say 'Your new colours are not shown here. Show them', and a reload fixes it. No app/ change sets reactStrictMode, so Next's dev default (on) probably explains the one-tab case. The two-tab case can happen in production. This needs a fix item (editorModel preview controller or preview-session showDesign). The publish and live-store acceptance is still proven.
- The keepalive part's last check is weak: 'Keep them as an earlier draft keeps them in Earlier versions'. It passes on the status line and listHistory having more than 0 versions. It never checks that the text which never reached the server is in a stored version. My probe confirmed the text is there: the newest document_versions row (kind undo_saved) holds the 'Never reached the server' text. So behaviour is right, but the drill would not catch a regression. That version's note reads 'Kept from another tab', which is the wrong wording for a local-backup recovery. This is a small founder-facing wording issue for the editor owner.
- The P2 flips in scripts/drills/p2/run.mjs depend on exact label and note strings from preview.mjs and publish.mjs. NOTE_CHECKS only makes a check when the note appears, and REWORDED swallows the original check, then checks again at a shot with an exact name. If a part's words or shot names change, the check silently disappears and nothing fails. The packet's Known limits says so. A guard that fails when an expected flipped label is missing from the results would close this.
- The RSC probe's leak search only covers the closed store's two drafts (home and the about page). /campaigns/spring, /journal and /journal/first-post have no closed-store draft, and the control after opening checks only '/'. A 0-leak result on those routes proves little. P3-CLOSED's review noted the quiz and bundles routes are uncovered too. The production-build probe remains an owner check.
- Ownership: the commit rewrites P2's records (scripts/drills/p2/results-*.json and docs/cms-reviews/drills/P2-DRILLS/*.png). Neither is in the item's file list. They are run outputs, and the packet lists them, but other items' folders were restored after the run and P2-DRILLS was not. Results (P2 and matrix runs) are in /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p3-b5/P3-DRILLS/rv0-matrix.log and /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p3-b5/P3-DRILLS/rv0-rest.log. The worktree is removed, ports 6300 and 7300 to 7309 are free, and nothing is left running.

## Owner checks

In `MANUAL-CHECKS.md`, "Phase 3, batch 5". In short: hosted Turso atomicity on a staging test tenant; the RSC probe on a production build; the rulings (finding 3, decision 4, decision 9, first publish with home, logout, catalog data, preview session as the verified console session); the five timed tasks with real founders; phones; migration 0023 before the code; finding D1; banners on page routes (D2); a COD order on staging, then cancelled in the console and Shopify; re-run `rte.mjs` after P3-FIX4; the CI sqld download.

## Files

- `scripts/drills/p3/run.mjs` (new), `scripts/drills/p3/matrix.mjs` (new)
- `scripts/drills/p2/run.mjs`, `scripts/drills/p3/routes.mjs`
- `docs/cms-reviews/P3-DRILLS.md` (new), `docs/cms-reviews/MANUAL-CHECKS.md`
- `docs/cms-reviews/drills/P3-DRILLS/` (results, screenshots, `items/`)
- `scripts/drills/p2/results-*.json` and `docs/cms-reviews/drills/P2-DRILLS/` (this run's P2 results and screenshots)

## Commands

```
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 DRILL_HTTPS_PORT=7106 DRILL_TMP=<scratch> DRILL_SCRATCH=<scratch> node scripts/drills/p3/run.mjs
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/run.mjs matrix
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/matrix.mjs closed,pv01
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 DRILL_HTTPS_PORT=7106 node scripts/drills/p2/run.mjs preview,unfinished,error-chrome
PORT=6100 DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 SHOPIFY_OAUTH_PORT=7107 TEST_PUBLISH_PORTS=7103,7104 TEST_PUBLISH_SERVICE_PORTS=7105,7106 TEST_PUBLISH_UNDO_PORTS=7108 pnpm test
pnpm build
```
