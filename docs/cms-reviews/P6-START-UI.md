# P6 · START-UI · "Start your store" page (GEN-01, GEN-04, US-01, US-04)

Branch `cms/p6-start-ui`, cut from `dd9ff01` (`cms/phase-1` with phase 6 batches 1 and 2 merged). Both base merges are in its history: P5-FIX2 (`441b44d`) and P5-DRILLS (`211c982`). It builds on P6-GEN (`41dfbd3`, GET/POST `/api/admin/first-run`), P6-BRAND (`96a49dd`, GET/POST `/api/admin/brand-step`), P6-PALETTE (`lib/themes/palettes.js`) and P6-FIXTURE (`scripts/support/banned-copy.js`). Plan: `docs/cms-reviews/P6-PLAN.md` revision 4 (decisions 3, 4, 5, 6 and 9) and `P6-BATCHES.json` (item P6-START-UI, batch 3).

This is the author's own report. Reviewers should re-read the code.

## Files

All in the item's list:
- `app/(console)/admin/(authed)/start/page.js` (new): the page. Server part only: sign-in, the store's mode, the actor's rights.
- `components/admin/first-run/FirstRun.js` (new, client): what was made, the state order, the sync note, the POST.
- `components/admin/first-run/BrandStep.js` (new, client): colours, logo, description, Save and Skip.
- `scripts/test-brand-step.js`: 23 new tests (the suite is now 50). P6-BRAND's 27 are unchanged.
- This packet.

`lib/first-run/brand-step.js` is in the list but is **not changed**: the review items for it (M8, M14) needed tests, not code. No route changed, no migration, no new dependency, nothing under `.github/`. `DocumentEditor.js`, `inspectorModel.js`, the editor fields, `SyncProgress.js` and `MediaPicker.js` are not edited (only imported).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` (102 of 102 suites, 252 s) and `pnpm build` (exit 0, `/admin/start` listed as dynamic) |
| Browser verified | **Partly.** Desktop Chrome (the app's browser pane) on the design harness, ports 6100 and 7100 to 7102, store seeded with `seed-design-documents.js --p3`. Signed in as the seed's local test owner, opened `/admin/start`: the page loaded, `GET /api/admin/first-run` and `GET /api/admin/brand-step` answered 200, the open store showed "Your store is already open…" with both links, the six swatches drew in each palette's own colours, choosing Forest and Save sent `POST /api/admin/brand-step` → 200 and showed "Saved. Your colours and logo are saved. They show after you publish." with the preview and "Review and publish" links. No console errors. **Not drilled in the browser:** the generated, syncing, empty and no-collections states (the harness has no closed, generator-made store; P6-DRILLS stages A, B and E seed one) |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

GEN-01 and US-01: a founder who has just connected Shopify should land on a store that is already made from their catalog, see in plain words what was made, and know where to change each part. GEN-04: the founder picks colours, a logo and a one-line description before opening. US-04: a store with no products, or with products but no collections, must say why its home page looks thin and what to do in Shopify. The server side (P6-GEN, P6-BRAND) was built in batch 2; this item is the page.

## Design

### The page (server)
- Signed out → `/admin/login`. Legacy store → `redirect("/admin/setup")`. A store moving to the new editor → a plain note, nothing else. A documents store → `<FirstRun canEdit canSync />`, where `canEdit = roleAllows(role, "storefront.write")` and `canSync = roleAllows(role, "sync.run")`.
- Reads the store through `tfetch` from `@/lib/console-request` (the console-fresh walk). `runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- The page does not read first-run or brand data itself; the two client parts ask the routes. That keeps every refusal and infrastructure answer in the routes' own catch blocks.

### FirstRun (client)
State order, first match wins (`viewOf`, exported and tested through the render):
1. **ready**: a home page exists and the generator made it (`byGenerator` has `doc_home`, or there is a summary). Shown even while a later sync runs or after it failed; the sync shows as a small note under it.
2. **kept**: the founder's own home page (`kept` has `doc_home`, or reason `founder_started`): "We kept the home page you already started." with "Edit the home page" and "Change colours and logo".
3. **syncing / sync-failed**: reason `catalog_not_confirmed` or a running, retrying, failed or stalled sync: the sync's progress with its own retry.
4. **make**: eligible and not made: one `POST /api/admin/first-run`, then the ready view built from the POST's answer (`afterMake`). A failed POST (5xx, network, or `reason: "race"`) shows "We couldn't make your starting store. Try again." with a retry button; each click is one POST.
- Otherwise **blocked**: the reason in words (`REASON_WORDS`, a client copy of `FIRST_RUN_WORDS`, which is Node-only). On an open store this is "Your store is already open, so the starting store wasn't made again…".

The one-POST rule: a ref marks the POST as sent. If a POST answers `ran:false` (the store changed), the page reads GET again and never posts by itself a second time; a re-read that still says "can be made" shows the retry button.

The sync part uses `SyncProgress.js`'s own exports (`SyncProgressBody`, `readSync`, `requestSync`, `POLL_MS`) in a small wrapper (`SyncPanel`) that polls the same way SyncProgress does and, when a running sync settles, reads the first run again. So a founder who opens the page during the first sync sees the store made as soon as the products are in (US-01). There is one progress bar on the page, SyncProgress's.

Ready copy is built from the server's summary (`madeSentence`): "A home page with your store name, a photo of <product>, rows for <rail A> and <rail B>, a grid of your collections, a row of your newest products, and the <Palette> colours." Each part appears only when the summary has it. The rails' titles are named; the collection grid is not named by collection (see Known limits for why). "Nothing is public yet." while closed; "Your store is open…" when the reason is `live`.

Empty catalog: "Your Shopify store has no products yet. Add products in Shopify, then sync again." plus SyncProgress's start button ("Refresh from Shopify") and "If you haven't changed your home page, product rows appear after your next sync. Otherwise add them in the editor." No collections (products > 0): "Your products have no collections in Shopify yet, so your home page shows your newest products. Add collections in Shopify to get collection rows."

### BrandStep (client), at `#brand`
- Reads `GET /api/admin/brand-step`. Six choices from `palettes.js`; each swatch is drawn with the palette's own CSS variables from `brandCssVars(brand, { kit: "pulse-1" })` (`paletteStyle` turns the `:root{…}` text into a style object). The current palette is preselected from `current.paletteId` (slate on a generated store), so Save with no change is one click. A founder's own colours (`paletteId` null) preselect nothing; Save waits for a choice, Skip keeps theirs.
- Logo: "Choose a logo" opens the existing `MediaPicker`. Only a library address (`/api/media/<id>`) is taken; anything else shows "Choose a picture from your library for the logo." The alt field may be empty ("If empty, your store name is used."); an empty alt is left out of the request. "Remove logo" takes it off the form; the next Save sends `logo: null`.
- Description: one line, `maxLength` from `descriptionMax` (160), prefilled with the tagline. Disabled with "Only the store owner or an admin can change the store's description." when `canEditDescription` is false, and then never sent.
- Before saving: closed "Nothing shows to shoppers until you open your store."; open "Your description shows now. Colours and logo show after you publish." with "Publish in the editor".
- Save sends `{ paletteId, logo, description, revision }`; Skip sends `{ skip: true }`. After saving: the lines from `savedLines`, "See it in the preview" (`/admin/editor`) and "Review and open your store" (or "Review and publish" when open), both to the editor at the home page (`EDITOR_PUBLISH_HREF`, pinned equal in a test).
- **Partial save (review item):** a 503 `BRAND_STEP_PARTIAL` shows the server's words, takes `design.revision` from the 503 for the next Save, and remembers that colours and logo were saved, so a retry that changed nothing still says "Your colours and logo are saved. They show after you publish."
- A stale revision (409 `DOCUMENT_CHANGED`) shows plain words and takes `current.revision`, so the founder's next Save goes through on purpose.
- Read-only (`canEdit` false): an info note, palettes and fields disabled, no Save, Skip or logo buttons, and `send` returns before any POST.

## Acceptance

| # | Item | Status | Evidence (all in `scripts/test-brand-step.js`, SWC-compiled, hook driver, mocked fetch) |
|---|---|---|---|
| 1 | FirstRun shows generated (with a running-sync note), founder_started, syncing, sync failed (retry), generation failed (retry) and empty states; generated + running sync still shows ready | Done | "RENDERED: a generated store whose latest sync is RUNNING…", "…skipped founder doc_home…", "…syncing… sync failed shows its own retry", "…eligible and not made: ONE POST… a failed POST…", "RENDERED (US-04): an empty catalog…", plus "RENDERED (US-01): when the sync finishes…", and for OPEN stores "RENDERED: an OPEN store (generated:false, reason live…)" (running, retrying, failed, stalled and complete sync: always the 'already open' view with both links, a small sync note while one runs or failed, SyncProgress's own retry; fix round 1, it failed before the fix). Breaking the generated-first rule (`if (firstRun.generated && !LIVE.has(sync?.state))`) fails the running-sync test |
| 2 | Ready copy names the product photo, collection rows and palette from the mocked result; a skipped founder doc_home shows the 'kept' line | Done | "RENDERED: generated store (GET)…" checks the full sentence for two different summaries (and that no words of the other leak). Removing the photo part fails 3 tests; removing the kept branch fails 2 |
| 3 | Empty state has 'Add products in Shopify' and the refill note; no-collections explains collections; banned-copy scanText finds nothing on any state | Done | "RENDERED (US-04)…" ×2 and "RENDERED: banned-copy scanText…" (10 rendered states, plus BrandStep's, `scanText(text, { claims: false })` and a pnpm/migrate/CLI regex). `claims: false` because "Review and open your store" uses "review" as a verb, as banned-copy.js documents |
| 4 | BrandStep: 6 palettes with labels, preselects slate, Save posts {paletteId, logo, description}, Skip {skip:true}, Remove logo logo:null, alt hint, 'description shows now' only when storeOpen | Done | Five "RENDERED: BrandStep…" tests. Mutations caught: preselect removed, `logo` always sent as an object, skip body changed, description sent to a role that can't change it, alt hint removed, open line always shown |
| 5 | Legacy store redirects to /admin/setup; read-only actor sees no Save and makes no POST; page passes the tfetch walk and the legacy-link walk; pnpm test passes | Done | "RENDERED: a legacy store redirects to /admin/setup…" (also signed out, moving, owner/support/staff rights; removing the redirect or hard-coding `canEdit` fails it), "RENDERED: a read-only actor…" ×2 (BrandStep alone and the whole page; letting FirstRun post without `canEdit` fails), "the page passes the console-fresh tfetch walk…". The real walks in test-console-fresh and test-legacy-routes pass in `pnpm test` (102/102) |
| 6 | unit: partial brand step retried with the 503's revision; settings.brand is a copy; saveBrandStep's own write check | Done | "UNIT: a partial brand step (503…)" (dropping the revision or the carried flag fails it), "M14: the body saved carries a COPY…" (wraps brand-step.js's own `../documents/service.js` import to see the exact body objects; `brand: want.palette.brand` fails it), "M8: saveBrandStep itself refuses…" (support, no role, null; Save, Skip, description; storage unchanged; removing `canEditDesign` fails it) |

Mutation pass: 21 mutations of the new code and of brand-step.js; 19 were caught. The two that survived are equivalent from the founder's side: (a) a failed POST that re-reads GET instead of showing the error at once still ends on the same retry view; (b) BrandStep's `if (!canEdit) return` in `send` is a second guard behind buttons that a read-only actor never gets.

## Tests

- `node scripts/test-brand-step.js`: 51 passed (27 P6-BRAND, 24 new).
- Fix round 1: `pnpm test` 102 of 102 suites, 210.7 s, exit 0.
- `pnpm test` with `TEST_PUBLISH_PORTS=7100,7101 TEST_PUBLISH_SERVICE_PORTS=7102,7103 TEST_PUBLISH_UNDO_PORTS=7104 TEST_PRODUCT_CONTENT_PORTS=7105,7106 TEST_MIGRATE_MAP_SQLD_PORT=7107 MIGRATE_DOCUMENTS_TEST_PORTS=7108,7109 MIGRATE_DOCUMENTS_TEST_WEB_PORT=6100` and `CHECKOUT_MODE` unset: 102 of 102 suites, 252.3 s, exit 0.
- `pnpm build`: exit 0.
- The rendered tests use the hook driver from test-media-picker (copied, since test-media-picker is not this item's file). The fetch mock answers a few ms later, like a network, and the driver waits for requests in flight, so the page draws while a request is out; with an instant mock the one-POST guard could not be tested.

## Known limits

- **The collection grid is not named by collection.** The review of P6-GEN found that `summary.collections` (stocked, most-stocked first) can differ from what the live grid shows (`getFeaturedCollections`: by total count, sold-out included). So the ready copy says "a grid of your collections" and names only the rails (which are the planner's own titles). `plan.js` is not this item's file; fixing the summary would let the page name them.
- **The 'kept' line inside the ready view only appears for the design** ("We kept the colours you already chose."). A kept founder home always goes to the kept view instead, because the server never gives a summary for a home it didn't make.
- **An open store with a home page shows the "blocked" view with the `live` words** ("Your store is already open, so the starting store wasn't made again…") and both links, not a summary: `describeFirstStore` stops at the live check before reading rows, so `generated` is false there. This holds whatever the latest sync is: `viewOf` returns "blocked" for reason `live` before it looks at the sync, and while a later sync runs or after it failed or stalled the view adds the small sync note (SyncProgress's body, with its own retry). Before fix round 1 an open store with a running or failed sync wrongly showed "Your starting store is made as soon as your products are in." and no links. The words are true; a calmer "Your store is open" view would need the server to read the rows on live stores.
- **No preview session link.** "See it in the preview" opens the editor, whose preview pane is the founder's preview. A direct preview link would need a preview session (`/api/admin/preview-session`), which the editor creates itself.
- **The editor's Publish is not opened automatically.** "Review and open your store" goes to the editor at the home page, where Publish is. The editor has no address that opens its publish panel, and DocumentEditor.js is not this item's file.
- **The description note on a closed store** says shoppers see it once the store opens; the manifest leak P6-BRAND found (`/manifest.webmanifest` shows the tagline on a closed store) is still open and not this item's file.
- **Swatch radios are visually hidden inputs inside labels**, with `aria-label` set to the palette's name. Keyboard focus shows as a ring on the card. Not checked with a screen reader.
- **Remove logo needs Save**, like every other change on the step. The plan says "a 'Remove logo' action (logo:null)"; the request is sent on the next Save, not at once.

## Owner checks

- **The page end to end in Chrome on a fresh closed store** (P6-DRILLS stages A, B and E): generated ready view with the real summary, the sync note during a refresh, the empty and no-collections words, Save with no change, Remove logo, Skip.
- **Read the founder words** on a phone: the made sentence, the empty and no-collections notes, the before/after-save lines. Confirm "sync again" is a word you are happy to show founders (the brief's own copy).
- **Staff:** staff can change colours and logo here but not the description (disabled with a note). Confirm that split.
- **The open-store view** (known limit 3): accept the "already open" words, or ask for a summary view on open stores.
- **CI sqld download:** unchanged; its source and checksum still need your approval. Nothing under `.github/` was touched.

## Fix round 1

- **Open store plus a running or failed sync showed the waiting view.** `viewOf` checked the sync state before reason `live`, so an open store (which has its doc_home) showed the sync panel and "Your starting store is made as soon as your products are in." while a "Refresh from Shopify" ran or after it failed, with no "already open" words and no links. Now `viewOf` returns "blocked" for `live` first, and the blocked view on an open store shows the small sync note when a sync runs or failed. New rendered test "RENDERED: an OPEN store…" uses the server's real shape (generated false); it failed before the fix (50 passed, 1 failed) and passes after.

## Commands

```
node scripts/test-brand-step.js
pnpm test
pnpm build
```
