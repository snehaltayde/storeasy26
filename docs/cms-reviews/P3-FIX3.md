# P3-FIX3: batch 3 review findings (PUB-03, PUB-05, TREE-05, ED-03, ED-04, AU-04)

This item fixes the "From review" findings in `P3-STORE.md`, `P3-INSPECTOR.md`, `P3-TREE.md`, `P3-PUBLISHUI.md`, `P3-ROUTES.md` and `P3-FIX2.md` that no other batch 4 item owns. No tenant changes mode. Legacy tenants, today's releases, the editors and preview behave as before. No storefront (edge) code changed. Shoppers can only notice this item indirectly: publish now refuses two more things that would have broken the live store (an unchanged section whose link the same publish breaks, and the buy box hidden on both screens).

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` 81 of 81 suites in 135.6 s; `pnpm build` passes (its 2 Turbopack NFT warnings about `lib/platform/migrate.js` were there before this item) |
| Browser verified | NOT DONE. The tree, the publish panel and the editor store have no host page until P3-EDITOR merges. Their behaviour is proved with unit, rendered (SSR) and driven tests. See owner checks |
| Staging | NOT DONE (owner check) |

## What and why

### Shopper-facing (blockers for this item)

1. **An unchanged section's link was inherited even when the same publish broke it** (`lib/documents/publish.js` classify, `lib/documents/checks.js`). If a page had a banner linking to /policies/x, and one publish both hid or renamed x and touched the page, the banner's block was downgraded to "It was already live like this". The publish went through, and shoppers got "not found". Now `referenceChecks` also returns `setBreaks`: the link blocks in a section whose target page is in the set. `classify()` never inherits those. It uses the same `targetInSet` rule that FIX2 made for menu links. A hidden section still only warns, because shoppers don't see it. Hiding or renaming the page on its own first, then publishing the page, still inherits the block, because the link was already broken on the live store.
2. **The `targetInSet` terms.** `row?.fromSet` was dropped. A row from the set is found either by the link's document id (so the id term holds) or by its address (so the address term holds). The id term is kept and pinned. It only changes the answer for a link by id that was already stale before this publish, and then it blocks rather than inherits, which is stricter.
3. **A link saved with a stale document id** (`checks.js`). FIX2 already reported a stale id whose page is live at another address or is another kind (both are now tested here). Two gaps were left, and both are closed now:
   - A stale id whose page is hidden or offline somewhere else used to give `LINK_TARGET_HIDDEN` ("Show that page"). Showing that page wouldn't fix the link. The id's row is now trusted only when it is live, or is at the link's own address and of its kind. Otherwise the link's address decides.
   - A stale id that names a never-published page at another address used to offer "Publish both" for that page. Publishing it wouldn't fix the link. A document found by id now counts only at the link's own address and kind (`atLink`), so the answer is `LINK_TARGET_MISSING` with no offer. The same id at its own address is still offered.
4. **The buy box hidden on both screens** (`lib/registry/validate.js`). A protected section (today, `product_main`) with `show: {mobile:false, desktop:false}` got no issue, so shoppers could lose the buy button. It now gives `PROTECTED_HIDDEN` on the `show` field, with the words "The product details and buy button can't be hidden on both phones and computers: shoppers need it to buy. Show it on at least one." The class is "invalid", so a draft keeps it as `incomplete` and the founder can show it again. At publish it is an error, and since `PROTECTED_HIDDEN` is in publish.js `STRUCTURE_CODES`, it always blocks, even when an older live version already had it.

### Founder-facing

5. **Publish panel and Undo** (`publishModel.js`, `UndoNotice.js`, `RecentlyPublished.js`, `PublishPanel.js`):
   - **Whole-set Undo shows the server's words.** Since FIX2, the server's message names the pages that are live again, the pages that went offline and the pages that stayed as they were. It also says "There's nothing earlier to undo." when nothing was undone. The client used to replace that with "Undone." and list every page as "Live now". It now shows the server's message.
   - **A lost answer is checked.** A `NETWORK_ERROR` (returned, or a thrown fetch) on publish or publishSet goes through "We couldn't confirm the publish. Checking…" and the existing resolve: it reads each document's live hash. A lost answer on undo or undoSet shows "We couldn't confirm the Undo. Checking…" and then asks the same dry run again:
     - 409 `PUBLISHED_ELSEWHERE`, or nothing left to undo: "It looks like the Undo went through…"
     - the same dry run: "Your Undo didn't go through. Nothing changed on your store. Try again." with a Try again button
     - no answer again: "We still couldn't confirm the Undo…"

     The words "so nothing was saved" never show for a publish or an Undo whose answer was lost.
   - **The whole-set Undo confirm names the page that goes offline.** When the set dry run says a page goes offline, the flow asks each member's own `undo` dry run. The title then reads, for example, "Undo all 2 pages of this publish? “Diwali sale” goes offline." When only one member changes, its change words are prefixed with its name. Also, a singleton's first publish that came in through an offer (where no type was recorded) is now recognised from its id (`doc_<type>`, `typeOfId`). It offers no Undo, so it no longer makes a whole-set Undo.
   - **Staff see Undo disabled with the reason.** `UndoNotice`, `RecentlyPublished` and the publish answer's Undo take `access` (getDocument's `{ canPublish, reason }`, or `{ canUndo, reason }`). Without the right, the button is disabled. The reason shows as text next to it, named by `aria-describedby`, and `createUndoFlow({ access }).start()` sends nothing.
   - **Closing the panel while a fix runs.** The blocked panel says "This keeps running if you close the panel: the change is saved and published." while busy. If the founder closes it, the save and publish still finish (the founder asked for them), `onDocument` and `onPublished` still hear them, and the panel no longer reopens by itself.
   - **A second Undo confirm while one runs** is ignored (the same guard Publish has).
6. **Section tree** (`SectionTree.js`, `AddSection.js`, `treeModel.js`):
   - Every icon button's `title` is its reason when disabled, otherwise its label, so enabled buttons keep their tooltip. `IconButton` spreads `title` after its own, so `undefined` used to wipe it.
   - A disabled button's reason is now text under the row, and the button names it with `aria-describedby`. "Already at the top" and "already at the bottom" are only for screen readers, because the greyed arrow already says it.
   - Copy (and add) is refused with `DRAFT_TOO_LARGE` when the draft would be over the draft cap (`DRAFT_MAX_BYTES`, the cap saveDraft refuses). The tree takes the whole draft as an optional `body` prop. Without one, the sections alone are measured.
   - A `confirmingId` prop sets which row's delete confirm shows first (tests and hosts), the same pattern as AddSection's `open`.
7. **Editor store** (`store.js`):
   - A save that answers after the tab was closed (disposed) clears this tab's own backups when it saved everything typed.
   - An offered backup whose body this tab then saves is dropped, and its key is removed.
   - On open, a backup equal to the live version (`publishedHash`) is not offered and is cleared, like one equal to the draft.

   "Dismiss removes the key" and "choosing is reset after useNewer" were already correct, and are now pinned.
8. **Page links typed while the kind is Campaign or Journal** (`fields/controls.js`). The code was already right, and it is now pinned with a driven test. `controls.js` is unchanged.
9. **"Edit this page" from store data routes** (`lib/admin/editor-entry.js`):
   - `/products/<x>` opens `doc_product_layout` with "Every product page uses this layout, so a change here shows on all of them."
   - `/collections/<x>` opens `doc_collection_layout` with the same kind of note.
   - `/collections` opens the collections page.
   - The other storefront routes (`STORE_ROUTES`: /journal, /campaigns, /search, /cart, /checkout, /account/…, and the rest) open home with "This page is built from your store's data, so the editor opened your home page."
   - `/about` and `/contact` before their page exists get the same neutral words.
   - A page, campaign or post that isn't there (`/campaigns/missing`, `/policies/a/b`) still says "Nothing on your store lives at …", because that is true.
10. **The console's phone drawer** (`ConsoleShell.js`) already passed `cmsMode`. A `drawerOpen` prop (how the drawer first renders; the layout never sets it) lets a test render it open, and the test proves it.
11. **Designer push failures** (`components/admin/cms/Designer.js` candidateFailure):
    - A 5xx answer's own plain message is kept, with "so nothing was saved" reworded to "so the preview didn't update". For example: "We couldn't check which editor this store uses, so the preview didn't update. Try again in a minute."
    - A message with a code in it, or no message at all, still gets the generic words.
    - On a migrating store (`STORE_USES_DOCUMENTS`), the words no longer say "nothing is saved until you press Save". They say the changes can't be saved here either.
    - The new code sits at the end of the file, so the ED-12 checklist's Designer line numbers (`docs/cms-reviews/P3-ED12-CHECKLIST.md`, not this item's file) still hold.

## Design notes

- **One rule for "the set breaks it".** `targetInSet` in checks.js decides it for both kinds of link. Menu and bar links use it inside checks.js. Section links pass it to classify() through `setBreaks`, which is keyed by issue identity, so no issue field is added and the response shape is unchanged.
- **No API shape change.** No new server code or field was added, so `lib/admin/documents-api-shapes.js` and `scripts/test-api-shapes.js` are unchanged. `DRAFT_TOO_LARGE` in the tree is a client-side refusal, using the code saveDraft already answers.
- **Driven component tests.** As in the inspector suite, a host calls the real component as a plain function and the test calls the handlers in the element tree it returns. This proves the wiring (onSelect, AddSection's index and collections, the delete confirm) without jsdom.

## Acceptance, with evidence

| Item | Status | Evidence |
|---|---|---|
| unit: an unchanged section linking to a page the same set hides or renames is blocked; the journal old-address probe is 422; a stale-id page link is reported | done | `test-publish-checks.js`: "P3-FIX3: an unchanged section linking to a page the same set hides, renames by id or renames by address blocks…" (also a hidden section only warns, and a page hidden alone first is inherited); "P3-FIX3 (FIX2 reviewer's probe)…" gives 422 `VALIDATION_FAILED` with `LINK_TARGET_MISSING` at level blocks on `items.0.link`, and storage is unchanged; "P3-FIX3 pin: a menu item by id that was already stale…"; "P3-FIX3: a page link saved with a stale document id is reported…" (another address, another kind, a hidden page elsewhere, a never-published page elsewhere with no offer, and the offer kept at the right address). Without the change: removing the setBreaks check in classify() fails the first test (200 with "already live"). The probe and the "another address" and "another kind" cases already passed on the base, because FIX2 fixed them; they are pins now. Mutations caught: classify ignores setBreaks; setBreaks never filled; the id term dropped; the old-address line dropped (the probe gives 200 inherited); the stale-id pick ignoring the address; a hidden stale-id row trusted |
| unit: a protected section hidden on both screens is a publish error and a draft 'incomplete' | done | `test-registry-contract.js`, in the DOC-03 composition test: for every protected kind and a document type that takes it, publish gives `PROTECTED_HIDDEN` on `show` at severity error, a draft gives `ok: true` with it `incomplete`, and shown on one screen gives nothing. It fails on the base (no issue) |
| unit: whole-set Undo with nothing undone shows the server's words; NETWORK_ERROR on publish resolves through 'Checking…'; staff see Undo disabled with the reason | done | `test-publish-ui.js`: "P3-FIX3 unit: whole-set Undo with nothing undone…" (the model, a mixed set and the flow); "…a NETWORK_ERROR on publish and publishSet goes through 'Checking…'…" (returned and thrown, and no "nothing was saved" in any state); "…on undo and undoSet goes through 'Checking…' and asks the dry run again" (4 answers each); "…the whole-set Undo confirm names the page that goes offline…"; "…without undo rights, Undo is disabled with the reason as text…" (RecentlyPublished rows and set, UndoNotice, the publish answer, start() sends nothing). All fail on the base |
| rendered: enabled tree icon buttons have a tooltip; a disabled button's reason is readable without hover; a copy that would exceed the draft caps is refused | done (rendered, SSR) | `test-editor-tree.js`: "P3-FIX3 rendered: every enabled tree icon button keeps its label as its tooltip…"; "…a disabled button's reason is text under the row, named by aria-describedby; at the top, Move up is disabled"; "P3-FIX3 unit+rendered: a copy (or an add) that would make the draft too big to save is refused with DRAFT_TOO_LARGE" (the reviewer's 19,000-character rich text copied until refused, every allowed copy saving, the validator agreeing about the refused one, and the body-only case). All fail on the base. A Chrome check waits for P3-EDITOR's host page (owner check) |
| unit: 'Edit this page' on /products/x opens the product layout; no route with real data says 'Nothing on your store lives at' | done | `test-editor-routes.js` "P3-FIX3 unit: 'Edit this page' on a product or collection opens its layout…": every folder under `app/(storefront)` must be in `STORE_ROUTES`, and `/<route>` and `/<route>/x` never say "Nothing on your store lives at", except a missing page, campaign or post. The old test that expected `/journal/` and `/products/serum` to say "nothing" was corrected |
| unit: each surviving mutation the batch 3 reviewers listed for these files is now caught | done | See "Mutations" below: every survivor named for these files is now caught, except the EarlierVersions restore click (`EarlierVersions.js` is not this item's file; see Known limits) |
| unit: pnpm test passes | done | 81 of 81 suites in 135.6 s on ports `PORT`/`DESIGN_PORT` 6160, `DESIGN_SQLD_PORT` 7166, `SHOPIFY_OAUTH_PORT` 7167, `TEST_PUBLISH_PORTS` 7160,7161, `TEST_PUBLISH_SERVICE_PORTS` 7162,7163, `TEST_PUBLISH_UNDO_PORTS` 7164. `pnpm build` passes |

### Mutations

66 one-line mutations, applied one at a time with a runner in the scratch folder (not committed). All 66 were caught.

- The reviewers' survivors:
  - STORE: dismissBackup keeping the key; `choosing` never reset.
  - INSPECTOR: the web name box always using the kind 'page'.
  - TREE:
    - onSelect after an op;
    - AddSection onSelect;
    - collections not passed;
    - add at selectedIndex;
    - Move up never disabled;
    - delete skipping the confirm;
    - "Needs a fix" dropped;
    - block ids minted against an empty set.
  - PUBLISHUI:
    - the threshold `> 0`;
    - the loadLists, open() and Undo start stale-answer guards;
    - the double-confirm guard;
    - pinned() without a revision;
    - hidePublishBoth;
    - the home link words.
  - ROUTES: the drawer dropping cmsMode; `setPushFail(null)` in mintPreview; `setPushFail(null)` in the nothing-dirty branch; no `encodeURIComponent` in editorHref.
  - FIX2: the old-address line in setSlugs; the redundant terms (one simplified away, one pinned).
- This item's own changes: each fix reverted or weakened.

## Tests

| Suite | Time (in `pnpm test`) | New or changed |
|---|---|---|
| `test:publish-checks` | 1.6 s | 4 new tests |
| `test:registry-contract` | 0.7 s | the composition test gains the hidden-on-both-screens loop |
| `test:publish-ui` | 0.4 s | 8 new tests. "whole-set Undo says which pages are live…" now expects the server's words: the old one pinned the words FIX2 replaced |
| `test:editor-tree` | 0.6 s | 7 new tests (rendered and driven) |
| `test:editor-store` | 0.6 s | 3 new tests |
| `test:editor-inspector` | 0.7 s | 1 new driven test |
| `test:editor-routes` | 0.4 s | 5 new tests. The unknown-path test lists real "nothing" paths. The 500 push now expects the server's own words |

## Known limits

- **No browser drill.** None of these components has a host page until P3-EDITOR merges, so their clicks are proven by driven and SSR tests, not in Chrome. P3-EDITOR's drill is the first time they run in a browser.
- **The host must pass `access` and `body`.** RecentlyPublished, UndoNotice and the publish answer disable Undo only when the host passes `access`. The tree measures the whole draft only when the host passes `body`; without it, only the sections are measured. P3-EDITOR mounts both.
- **A whole-set Undo that takes a page offline costs one dry run per member**, to name that page. It happens only when the set dry run says a page goes offline.
- **A lost Undo answer is resolved by asking the dry run again.** A 409 `PUBLISHED_ELSEWHERE` could also mean someone else published in between, so the words say "It looks like the Undo went through" and ask the founder to reload. They don't claim more than that.
- **Old backups are still not checked against Earlier versions.** A backup whose text was saved at some revision and then saved over again is still offered, because history versions carry no hash. Keeping it as an earlier draft loses nothing.
- **"Already at the top / bottom"** is only for screen readers. Every other disabled button's reason is visible text.
- **The EarlierVersions restore click** (a PUBLISHUI survivor) is not pinned: `EarlierVersions.js` is not in this item's file list. SSR can't see a click, so P3-EDITOR's drill or a driven test in a later item should cover it.
- **`STORE_ROUTES` is a fixed list.** The test fails when a new storefront folder is added without it.
- **The Designer's doc comment above `candidateFailure` was re-wrapped** (3 lines shorter), so that the new 2 lines keep every later line number. Nothing else in Designer.js moved.

## Owner checks

- **Desktop Chrome, at P3-EDITOR's drill** (NOT DONE here):
  - the tree's tooltips, and the reason text under a row;
  - Copy refused near the draft cap;
  - "Edit this page" from a product page (product layout and its note) and from /search (the neutral words);
  - Undo disabled for a staff login on Publishing;
  - a whole-set Undo naming the page that goes offline;
  - closing the publish panel during a fix.
- **Phones:** the phone drawer in documents mode links Storefront to the editor (proved only in SSR).
- **Wording:**
  - the buy-box words ("can't be hidden on both phones and computers…");
  - "This keeps running if you close the panel…";
  - the Undo checking words;
  - "This page is built from your store's data…";
  - the two layout notes;
  - the migrating Designer words.
- **Hosted staging:** a publish and an Undo whose answers are lost on a slow network are resolved by the check (NOT DONE).
- **CI:** the sqld download's source and checksum still need the owner's approval. Nothing under `.github/` was touched.

## Files

`lib/documents/publish.js`, `lib/documents/checks.js`, `lib/registry/validate.js`, `lib/admin/editor-entry.js`, `components/admin/editor/publish/publishModel.js`, `PublishPanel.js`, `RecentlyPublished.js`, `UndoNotice.js`, `components/admin/editor/tree/SectionTree.js`, `AddSection.js`, `treeModel.js`, `components/admin/editor/store.js`, `components/console/nav/ConsoleShell.js`, `components/admin/cms/Designer.js`, `scripts/test-publish-checks.js`, `scripts/test-registry-contract.js`, `scripts/test-publish-ui.js`, `scripts/test-editor-tree.js`, `scripts/test-editor-store.js`, `scripts/test-editor-inspector.js`, `scripts/test-editor-routes.js`, and this packet.

Unchanged though listed: `components/admin/editor/fields/controls.js` (already right; pinned), `lib/admin/documents-api-shapes.js` and `scripts/test-api-shapes.js` (no shape changed). No `package.json`, lockfile or `.github/` change. No new dependency. No `node:` import in edge code.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
PORT=6160 DESIGN_PORT=6160 DESIGN_SQLD_PORT=7166 SHOPIFY_OAUTH_PORT=7167 TEST_PUBLISH_PORTS=7160,7161 TEST_PUBLISH_SERVICE_PORTS=7162,7163 TEST_PUBLISH_UNDO_PORTS=7164 pnpm test
pnpm build
```

No server, sqld or proxy was left running. Ports 6160 and 7160 to 7169 are free.
