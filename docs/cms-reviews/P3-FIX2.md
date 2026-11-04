# P3 · FIX2 · The batch 2 review findings no other batch 3 item owns (PUB-03, PUB-05, PUB-06, PV-01, DOC-10)

**Branch:** `cms/p3-fix2`, cut from `64d3d07`.

This item fixes the "From review" findings in `P3-CHECKS.md`, `P3-UNDO.md`, `P3-CHANGES.md`, `P3-FRAME.md`, `P3-HARNESS.md` and `P3-FIX1.md` that no other batch 3 item owns. No tenant changes mode. Legacy tenants, today's releases, the editors and preview behave as before. No storefront (edge) code changed. The only change a shopper could ever notice is indirect: the publish checks now stop a founder from publishing a link that would 404, and no longer stop a link that works.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` 81 of 81 suites in 142.2 s, `pnpm build` passes; fix round 1: 81 of 81 in 132.3 s |
| Browser verified | done for the harness items: the P3 smoke drill in desktop Chrome 156 on ports 6200 and 7200 to 7202 (26 of 26), plus the mutation runs below |
| Staging | NOT DONE (owner check) |

## What and why

### 1. Reference checks (`lib/documents/checks.js`)

These change what shoppers can end up clicking, so they were treated as blockers.

- **A link chosen by document id to a renamed page.** The storefront builds a page link's address from the slug the link stores (`lib/registry/settings.js` `linkHref`), not from the page's address now. The checks found the target by id and passed it, so shoppers got a 404. Now, when the target is live but its family or slug differs from the link's, the link blocks as `LINK_TARGET_MISSING` with words that name the new address: "This link goes to /policies/moves, but “Moves” is at /policies/moved now, so shoppers who click it get “not found”. Choose the page again so the link uses its new address." This also works inside one set (the page is renamed in the same publish). It passes when the old address really forwards shoppers to that same page.
- **A link to an old address that a live redirect covers.** It was refused with "which isn't a page of your store". The checks now read the redirects of M2 (the live list with the set applied) and pass a link whose address forwards to a live page.
- **What "forwards" means, read from the storefront, not from the brief.** Only `/journal/<slug>` follows an old address (`app/(storefront)/journal/[slug]/page.js` calls `resolvedSlugRedirect`). `/policies/<slug>` and `/campaigns/<slug>` never do: they 404 at an old address even when a page lists it in "Old addresses". So a redirect covers a link only on the journal. For a page or campaign whose old address is listed, the link still blocks, and the words add "Old addresses only forward shoppers on journal posts." Passing those links would have sent shoppers to a 404, so this follows the code rather than the brief's wider wording. See Known limits and the owner check.
- **Hidden rows shadow a redirect.** `resolvedSlugRedirect` lets any page row or journal post at an address win over an old address, a hidden or offline one included, and that row then answers "not found". `REDIRECT_SHADOWED` and the loop walk now use every row, not only enabled ones. A hidden holder gets its own words: "The old address “hidden-holder” is still the address of a page that's hidden from shoppers or offline, so shoppers who use it get “not found”, not this page. Remove it, or change that page's address."
- **Pins.** There are new tests for the M2 "set applied" filter (`!inSet.has(row.document)`: the set hides B, or renames B, while A links to it) and for a link to a live journal post (the `needJournal` read).
- **Menu links in a document's own settings.** A header, footer or announcement link has no section, so classify() never inherited it, and one offline target blocked every later header publish with "This page links to…". Now:
  - A link block in settings (a page link that is missing, hidden or not live) whose link was already in the live version is inherited. It becomes a warning with level `inherited`, its message ends with "It was already live like this, so it doesn't stop publishing.", and it keeps `removeItem` as its action. "Already live" means the same link (same type, address, slug, document and handle) was among the live version's settings links. That is matched by identity, not by position, so adding or reordering items keeps it inherited.
  - **Fix round 1: never inherited when the same set breaks it.** A link is inherited only when the page it goes to is outside the set. If the set holds that page (the link's document id is in the set, or its address is a set page's address now, its live address, or one of its old addresses), this publish may be what hides or renames it, so the link blocks as before. Round 0 inherited it, so publishing [header with an unchanged item to /policies/rv-x, rv-x switched off] gave a 200 with "It was already live like this", which was untrue, and the header menu then sent shoppers to a 404. The same hole covered a rename inside one set, by id and by address. Hiding or renaming the page on its own first, then publishing the header, still inherits, since the link was already broken on the live store.
  - The words name what links: "Your header menu links to…", "Your footer menu links to…", "Your announcement bar links to…" (`linkLead`). Sections keep "This page links to…" and "This link goes to…".
  - The 422's own `error` for `LINKS_TO_UNPUBLISHED` uses the same lead when every block shares it. That is a 6-line edit to `lib/documents/publish.js`, which is outside this item's file list and has no batch 3 owner. See Known limits.

### 2. Undo (`lib/documents/undo.js`)

- `listRecentlyPublished` gives `canUndo: false` (and `undo: null`) for a row whose Undo would only answer "nothing": a singleton's first publish, such as the publish of home that opened the store. It uses the same `planOf` that `undo` uses, so the two can't disagree.
- The whole-set Undo message names which pages are live and which went offline, sorted by name: "“Mix p” is live again, as it was before that publish. “Mix q” is offline now, as it was before that publish. To bring it back, open it and publish it again." With more than one offline page it says "open each one and publish it again". The old opening, "2 pages are back to how they were before that publish.", is gone. The `undoSet` shapes example was updated to match.

### 3. Kept drafts (`lib/documents/changes.js`, `lib/documents/service.js`)

- **The draft's id is kept.** A test pairs two sections with different valid ids by content (a moved copy) and proves that `keepLiveBody` keeps the draft's id.
- **`keepLiveSection` never leaves a row for the section it restored.** diff.js names as "moved" every section outside one longest run kept in live order. When the draft's order is scrambled, the place right after the nearest live neighbour can fall outside that run (live `[l0..l4]`, draft `[l4,l2,l3,l0]`, keep `l1` used to give `[l4,l2,l3,l0,l1]` and "Text 2: moved down"). `placeQuietly` tries that place first. If the change list would still name the section there, it uses the nearest place that doesn't. One always exists: put just before the run's first section with a later live index, the section extends the run. The reorder case now gives `[l4,l1,l2,l3,l0]` and no row for `l1`. An exhaustive sweep is also tested: every order of every 4-of-5 subset, with every section kept, is 600 cases and leaves no row.
- **`keepEarlierDraft` refuses an archived document** with 409 `DOCUMENT_ARCHIVED`, like `saveDraft`. A test now pins the cart lock (409 `CART_NOT_AVAILABLE`). Both store nothing. Both outcomes were added to `SHAPES.keepAsEarlierDraft`.
- **`keepLiveSection` on an offline page** (published, then taken offline) answers 404 with "This page is offline, so there is no live version to keep. Publish it again to bring it back." It no longer says "never been published".

### 4. Preview bridge (`components/preview/bridge-core.js`, test only)

The stand-in DOM in `scripts/test-preview-frame.js` now runs a document's capture listeners first, then its bubble listeners only if nothing stopped propagation, as a browser does. A new test adds the page's own bubble-phase click and submit handlers before the bridge mounts. With v2 on, a link click and a form submit never reach them, and a plain `type=button` click still does. The bridge code needed no change.

### 5. Diff (`lib/documents/diff.js`)

- `diffBodies('product_layout', null, emptyBody)` is pinned: it gives one row, "Product details and buy button: added".
- A section hidden on both screens and then switched off with its show flags cleared now gives one "hidden" row and no "now shown on…" rows. A section switched back on while still hidden on both screens reads "switched on, still hidden on phones and computers", where before it gave either nothing or "now shown" rows.

### 6. Preview client (`components/admin/editor/documentsApi.js`)

A 2xx answer to the preview-confirm fetch with no readable body (not JSON, or a 204 with none) maps to `PREVIEW_NOT_CONFIRMED` and the preview's words ("We couldn't open the preview…"). It no longer maps to `UNREADABLE_RESPONSE`, whose words say "nothing was saved".

### 7. Harness (`scripts/drills/p3/lib.mjs`, `scripts/drills/p3/smoke.mjs`, `scripts/seed-design-documents.js`, `docs/cms-reviews/P1-HARNESS.md`)

- `clickCounter(context)` returns the existing counter on a second call for the same context. It used to throw from `exposeBinding`.
- **The smoke guide check can fail now.** The storefront never renders a link to a page that isn't live, so checking the page's text proved nothing. The check now reads the guide's published version and its draft through `storeSql`:
  - the live version has no `sec_p3guidebn` banner and no `document_refs` row naming the unpublished campaign;
  - the page renders no `a[href="/campaigns/p3-spring-edit"]`;
  - a second check confirms that the draft holds the banner and that `draft_hash` differs from `published_hash`.
- **The closed store is re-pointed at harness start.** `startOwned()` calls the new `pointClosedStoreAt` (in the seed module, local addresses only), which sets the `design-closed` tenant row's database to this run's third server. A smoke check spoils the row, points it back and reads it back.
- `P1-HARNESS.md` now documents `DESIGN_PORT`, `DESIGN_SQLD_PORT`, `DRILL_HTTPS_PORT`, `DRILL_SCRATCH` and `DRILL_TMP` for running drills on an agent's own ports. It also lists the ports to avoid on this Mac (5000 and 7000 ControlCenter, 5037 and 5500 in use, 5060 and 5061 refused by Node's fetch) and the closed-store re-point.

## Design notes

- **One reading of an address.** `landing(family, slug)` in `checks.js` mirrors `v4ContentPage` and `resolvedSlugRedirect`. It looks for a page row at the slug (any family) first, then a journal post. A row that is off, or of another family, gives "not found". Only the journal follows `m2Redirects`, for up to 20 hops. The stale-link check, the redirect-covered link and `REDIRECT_SHADOWED` all use it or its maps, so they can't drift from each other.
- **No new action type.** The stale link keeps the actions an ordinary missing link has: `hideSection` in a section, `removeItem` for a menu item, `openField` otherwise. The words say "Choose the page again". An "update the link" action would need P3-PUBLISHUI (batch 3) to render a new type, which would be a contract change in the middle of the batch.
- **The inherited rule for settings lives in checks.js**, not in publish.js's classify(), because publish.js isn't in this item's list. checks.js already receives each item's `liveBody` (the offline rule is unchanged: an offline entry has none, so nothing is inherited).

## Acceptance, with evidence

| Item | Status | Evidence |
|---|---|---|
| unit: a link by id to a renamed page with no redirect is blocked (also inside one set); with a redirect covering the old slug it passes; a link to a redirected old address passes; a hidden page row shadowing a redirect warns | done | `test-publish-checks.js` "P3-FIX2: a link by document id to a page renamed…", "…a link to an old address that a live redirect covers passes…", "…an old address held by a hidden live page warns REDIRECT_SHADOWED…", and the M2 pin. A redirect "covers" only on the journal, which is the only place the storefront follows one (see What and why 1). Mutations killed: no `moved` verdict; the redirect never counted for a moved link; an old address never forwards; redirects followed on every family; shadow counting only enabled rows; the M2 filter removed; `needJournal` false |
| unit: an unchanged header menu item to an offline page is inherited as a warning; the words say menu, not page | done | "P3-FIX2: an unchanged header menu item to a page taken offline is inherited…": a 200 with `items.0.link` level `inherited`, the exact words "Your header menu links to Menu tgt, which isn't published yet. It was already live like this…", and `removeItem`. A new item to another offline page gives a 422 whose `error` is "Your header menu links to Menu tgt two…" and whose offer names that page only. The footer says footer. Mutations killed: settings never inherited; the lead always using page words; the 422's lead dropped; the inherited item losing `removeItem` |
| fix round 1: an unchanged menu item is not inherited when the same set hides or renames its page | done | "P3-FIX2 fix 1: an unchanged menu item is not inherited when this same set is what breaks it…": four cases, each a 422 `VALIDATION_FAILED` with the header's (or the bar's) item at level `blocks` and no "already live" words, and storage unchanged: [header, X hidden], [header with a link by id to Y, Y renamed rv-y to rv-y2] (the words name /policies/rv-y2), [header with /policies/rv-z, Z renamed], [announcement bar to /policies/rv-w, W hidden]. After X is hidden on its own, the next header publish inherits it. Each of the four cases was run as its own test against round 0's checks.js and each failed (200 with level `inherited`), then all passed with the fix |
| unit: a singleton first-publish row has canUndo false; the set Undo message names live and offline pages | done | `test-publish-undo.js` listRecentlyPublished test: home's opening row has `canUndo:false, undo:null`, and its Undo answers `nothing`. "P3-FIX2 unit: a whole-set Undo where one member goes offline…" gives the exact mixed message and the plural offline message. The 3-member test gives the exact names. Mutations killed: canUndo ignoring the plan; the count words put back; "open it" dropped |
| unit: each kept-draft and bridge capture gap has a test that fails under its mutation; the l1 reorder case leaves no row | done | `test-doc-changes.js`: the content-paired id test (killed: restored under the live id), the l1 case and the 600-case sweep (killed: plain insert in the removed case, and in the moved case), the offline words (killed), archived and cart (each killed on its own). `test-preview-frame.js`: the capture test (killed: submit in bubble, click in bubble). With the listener-flag assertion taken out, the behaviour check alone still fails ("the page's own handlers never ran: expected 0, got 1") |
| drill: the smoke guide-page check fails when the seed order is swapped | done | Desktop Chrome, ports 6200/7200. (a) Normal seed: 26 of 26. (b) Seed order swapped (banner added before the guide's publish): the seed itself is now refused (`This page links to The spring edit, which isn't published yet.`, P3-CHECKS), so the drill stops. (c) The swap with the reference checks stubbed out, which is the reviewer's pre-checks scenario: 24 passed, 2 failed, both guide checks, with `{"liveHasBanner":true,"draftDiffers":false,"liveRefsToCampaign":1,"renderedLinks":0}`. (d) HEAD's old smoke.mjs on the same mutant: 22 of 22 passed, so the old check could not fail. Every mutation was reverted |
| unit: pnpm test passes | done | 81 of 81 suites in 142.2 s (ports: `PORT`/`DESIGN_PORT` 6200, `DESIGN_SQLD_PORT` 7206, `TEST_PUBLISH_PORTS` 7201,7202, `TEST_PUBLISH_SERVICE_PORTS` 7203,7204, `TEST_PUBLISH_UNDO_PORTS` 7205). `pnpm build` passes |

Also tested, outside the acceptance list: the diff hidden-on-both-screens rows (killed: per-screen rows kept; no hidden row), the `product_layout` pin (killed: `sideOf` keeping the empty body's sections), and the preview-confirm words (killed: back to `UNREADABLE_RESPONSE`). 26 mutations were run in all, and all 26 were killed.

## Tests

| Suite | Time | New or changed |
|---|---|---|
| `test:publish-checks` | 1.4 s | 6 new tests (P3-FIX2 block, one from fix round 1). The loop case now expects `REDIRECT_SHADOWED`: a hidden page holds its address, so no loop can form |
| `test:publish-undo` | 2.0 s | 1 new test; the set message and the current-rows list follow the fixes |
| `test:doc-changes` | 2.0 s | 4 new tests |
| `test:preview-frame` | 1.0 s | the stand-in DOM runs capture before bubble; 1 new test |
| `test:doc-diff` | 0.4 s | 2 new tests |
| `test:logout-preview` | 1.0 s | 2 new rows in the confirm table, plus a words check |
| `test:api-shapes` | 0.5 s | unchanged, passes with the two new `keepAsEarlierDraft` outcomes |

The mutation runner and its lists are in the agent's scratch folder. They are not committed.

## Known limits

- **Old addresses forward only on the journal.** `/policies/<old>` and `/campaigns/<old>` 404 even when a live page lists that old address. This is how the storefront has always worked (the policies and campaigns routes never call `resolvedSlugRedirect`), and this item doesn't change storefront code. The checks follow the storefront, so a page or campaign link to an old address still blocks, and its words say why. Whether pages and campaigns should forward is an owner ruling (below). If a later item makes them forward, `landing()` must drop its `family !== "journal"` line in the same change.
- **`REDIRECT_LOOP` can't happen any more.** Every row now holds its slug, and a redirect's target is always the page's own row, so the walk stops at once. The code is kept as a guard and is no longer tested. Two hidden pages whose old addresses point at each other now each get `REDIRECT_SHADOWED`.
- **`lib/documents/publish.js` was edited (6 lines) though it isn't in this item's list.** No batch 3 item owns it. `linksToUnpublished` takes the lead words, and its one call site passes `linkLead` when every block shares one. Without it, the 422 for a new menu item would still say "This page links to…". The orchestrator should accept it with this branch.
- **The inherited rule for settings covers page-link blocks only** (`LINK_TARGET_MISSING`, `LINK_TARGET_HIDDEN`, `LINKS_TO_UNPUBLISHED`). A menu link to a deleted collection or product (`LINK_COLLECTION_MISSING`, `LINK_PRODUCT_MISSING`) still blocks even when it was already live.
- **classify() in `lib/documents/publish.js` has the same gap for unchanged sections.** It inherits a block in an unchanged section even when the set is what hides or renames that section's link target. That rule is older than this item (P3-CHECKS) and publish.js isn't in this item's list, so it is left for the orchestrator to assign. The settings rule in checks.js no longer has it.
- **"In the set" is matched by address, not by family.** A settings link whose slug is any set page's address (now, live or old) is never inherited, even if the family differs. That can only turn an inherited warning into a block for a link that is already broken; it never passes a broken link.
- **A stale link has no one-click fix.** Its actions are the ordinary ones (hide the section, remove the menu item, go to the field). An "update the link" action would be a new action type for P3-PUBLISHUI.
- **`placeQuietly` may put a section back away from its nearest live neighbour** when the draft's order is scrambled, and it may change which other sections read as "moved". The section itself never leaves a row, which is the rule. The plain cases are unchanged: the first place tried is the old one.
- **The closed store is re-pointed only when a phase 3 drill starts the harness.** A harness started by hand (`pnpm dev:design`) still re-points only the design store. That fix belongs in `scripts/design-harness.js`, which isn't in this item's list. P1-HARNESS.md says this.
- **The smoke drill's committed results** (`docs/cms-reviews/drills/P3-HARNESS/`) were left as P3-HARNESS committed them. That folder isn't this item's. This run's numbers are quoted above.
- **Statement counts were not measured separately.** The checks add no statement: the new maps are built from rows already read. Undo's `canUndo` calls `planOf`, which is pure.

## Owner checks

- **Ruling:** should `/policies/<old>` and `/campaigns/<old>` follow a page's old addresses, as `/journal/<old>` does? Today they 404, and the "Old addresses" field on a page or campaign does nothing for shoppers.
- **Wording:** the stale-link words, the menu, footer and announcement leads, and the set Undo words ("live again…", "offline now…, open it and publish it again").
- **Accept** the out-of-list edit to `lib/documents/publish.js` (6 lines).
- **Hosted staging:** a renamed page linked by id, and an inherited menu item after take offline, on a staging tenant (NOT DONE).
- **CI:** the sqld download source and checksum for `.github` are unchanged and still need the owner's approval (not touched here).

## Files

`lib/documents/checks.js`, `lib/documents/publish.js` (out of list, see Known limits), `lib/documents/undo.js`, `lib/documents/changes.js`, `lib/documents/service.js`, `lib/documents/diff.js`, `components/admin/editor/documentsApi.js`, `lib/admin/documents-api-shapes.js`, `scripts/test-publish-checks.js`, `scripts/test-publish-undo.js`, `scripts/test-doc-changes.js`, `scripts/test-preview-frame.js`, `scripts/test-doc-diff.js`, `scripts/test-logout-preview.js`, `scripts/drills/p3/lib.mjs`, `scripts/drills/p3/smoke.mjs`, `scripts/seed-design-documents.js`, `docs/cms-reviews/P1-HARNESS.md`, `docs/cms-reviews/P3-FIX2.md`. `components/preview/bridge-core.js` needed no change.

## Commands

```
PORT=6200 DESIGN_PORT=6200 DESIGN_SQLD_PORT=7206 TEST_PUBLISH_PORTS=7201,7202 TEST_PUBLISH_SERVICE_PORTS=7203,7204 TEST_PUBLISH_UNDO_PORTS=7205 pnpm test
pnpm build
DESIGN_PORT=6200 DESIGN_SQLD_PORT=7200 node scripts/drills/p3/smoke.mjs
```

Everything this item started (the harness, Next and sqld) was stopped. Ports 6200 and 7200 to 7209 are free.
