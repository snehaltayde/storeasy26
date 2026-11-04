# P3-EDITOR: the new editor, put together (ED-02, ED-03, ED-04, PV-01, PV-02, PUB-02, PUB-04, PUB-06, PUB-11)

Plan: `docs/cms-reviews/P3-PLAN.md` (batch 4) and `P3-BATCHES.json`. Branch `cms/p3-editor`, cut from `0b81097`. No migration. No new dependency. No real tenant changes mode. Nothing under `.github/` changed.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 130.4 s (`TEST_PUBLISH_PORTS=7101,7102 TEST_PUBLISH_SERVICE_PORTS=7103,7104 TEST_PUBLISH_UNDO_PORTS=7105 PORT=6100`). `test:editor-shell` 24 passed (0.4 s in the gate). `test:preview-frame` 20 passed. 18 deliberate breaks of the new code, 18 caught (two only after fixing the break itself, see "Do the tests bite?"). `pnpm build` passed; its two warnings are the old `next.config.mjs` NFT trace |
| Browser verified | Yes, on the design harness from this worktree (`DESIGN_PORT=6100`, `DESIGN_SQLD_PORT=7100`, so 7100 to 7102, `next dev`), desktop Chrome 156 (headless, `playwright-core`), at 1440 and 375. `scripts/drills/p3/editor.mjs`: 22 passed, 0 failed. Not Safari, not a real phone |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

Until now the batch 3 parts (the store, the preview machine, the forms, the tree, the publish panel) had no page. This item gives them one: `/admin/editor` on a documents store is now a working editor. A founder can open any page, click a section in the preview to edit it, add and arrange sections, publish with a review, undo, take a page offline and restore an earlier version, and nothing they type is lost when they leave, switch, or open a second tab.

All the rules live in one pure module, `components/admin/editor/editorModel.js`, so node tests drive them. The React files only hold state and browser events.

## Design

### Files

| File | What it does |
|---|---|
| `components/admin/editor/editorModel.js` (new, pure) | pick plan, tree changes as store operations, the selection ruling, inspector paths, the store's `call` for publishing, the navigation guard, per-tab backup storage, the preview controller, switcher rows, closed-store and writing-view tests |
| `components/admin/editor/DocumentEditor.js` (replaces the placeholder) | `EditorView` (all props, what the rendered tests render) and the default export that holds the store, the publish flow, the preview and the browser listeners. Also `PublishingHistory`, the client part of `/admin/releases` |
| `components/admin/editor/Switcher.js` (new) | every document by label, name search, products listed as "Not yet editable here" |
| `components/admin/editor/PreviewPane.js` (new) | the frame; gives the controller the frame and the window's messages |
| `components/admin/editor/StatusLine.js` (new) | "Changes: Saved / Saving / Could not save: …", "Preview: Up to date / Updating / Could not update", the conflict choice, the backup offer, the closed-store copy, a link held by a failed save |
| `components/preview/bridge-core.js` | in the editor frame, every control click is stopped and picked (P3-FRAME review) |
| `app/(console)/admin/(authed)/releases/page.js` | documents mode: Recently published; legacy and migrating unchanged |
| `scripts/test-editor-shell.js`, `scripts/test-preview-frame.js`, `scripts/drills/p3/editor.mjs` | tests and the drill |

### The pieces

- **Loading.** The editor reads the document with `getDocument` (the page passes only the id and label, so P3-ROUTES' page is unchanged), `listDocuments` for the switcher and the closed-store test, and `GET /api/admin/catalog` (read only) for products and collections. A singleton that has no row yet (404) says so and offers "Start editing" (`createDocument`).
- **Switcher (ED-02).** "All pages" opens the list. Documents are sorted home first, then the singletons, then pages by name, each with "Live", "Changes not published" or "Not published yet". System documents (journal index, product content) are left out. Products come from the catalog and each says "Not yet editable here". Opening another document waits for the save first (the same guard as links).
- **Layout.** Tree and inspector on the left, the preview on the right (sticky, so it stays in view while the founder edits). A page whose sections are all rich text (a policy) opens in a full-width writing view: the page's details and each rich text section, with "Show the preview" (the frame and its session stay mounted, hidden).
- **Edits as store operations.** An inspector change becomes `store.setField("sections.<id>.settings.<path>")` (or `meta.*`, or `settings.*` for a document form). A tree change (add, copy, move, hide, show, delete) becomes `insertSection`, `moveSection`, `removeSection` or a `setField` on that section's `enabled` / `show`, so an edit typed during a server-replace hold is replayed by section id, never as a whole list.
- **Preview (PV-01, PUB-11).** `createPreviewController` mints with `startDocumentsPreview({showDesign})`. showDesign is on only while `doc_design` is open; switching documents calls `setShowDesign(sid, on)` on the same session when it changes (a failed call mints a new session with the right setting). It answers the bridge's v1 ready with the editor's hello, feeds `previewMachine` every frame load, ready, save ack and failure, runs the 3-second ready timer, and re-mints on `ready ok:false` (`live`, `revoked`, `expired`, `not_found`) or on no ready within 3 seconds. Meanwhile the label is "Updating" with "Reconnecting…". Nothing re-mints before expiry (PV-04 is P1). A save acknowledged while the frame is shown refreshes it in place (`storeasy:refresh`, which keeps scroll and selection).
- **Click to select (ED-04).** `pickPlan`: a pick on the open document selects its section and builds `focusRequest {path, offset}` (a new object each time, so the field takes focus again). A pick on another document (the header, the footer, the announcement bar) opens that document with a note, "You picked “Header menu” in the preview, so the editor opened it. Nothing changed on “Home page”.", and nothing is written to the open document. On a product or collection page, whose store-owned markup carries no section ids, a pick with no section selects the layout's protected section (`product_main`).
- **Adding to preview.** A section added or copied is "pending" with the store's ack count at that moment. The pane shows "Adding to preview…" until the frame shows a save acknowledged after it (the controller's `shownAck`), then the editor posts `select` and the section is outlined.
- **Navigation (ED-03).** A capture-phase click handler on the console document: while the store holds anything unacknowledged, a click on an in-app link (not a new tab, a download, another site or a same-page `#anchor`) is held, `store.beforeNavigate()` runs, and only then the router moves. If the save fails, the editor stays and says "Your latest changes aren't saved yet, so we stayed on this page. They are still here." with "Leave anyway". `beforeunload` uses `store.beforeUnload()` (warning and the keepalive).
- **The store's `call` (plan A5, P3-PUBLISHUI review).** The publish panel, its fixes, UndoNotice, take offline and Earlier versions all get `createStoreCall`, which routes every write to the open document through its store:
  - `publish` / `publishSet`: flush first; then, with no await before the store's own publish, the acknowledged draft must be the one the review pinned. Otherwise the answer is "This page changed after you looked at what will go live, so nothing was published. Open Publish again to see the latest changes." and nothing is sent.
  - A fix ("Hide this section and publish"): its `getDocument` and `saveDraft` flush first and refuse when the saved draft is no longer the reviewed one; otherwise the edit is applied through the store and saved, so the store takes the new revision and the next autosave has no 409.
  - `undo`, `unpublish`, `keepLiveSection`, `restoreVersion`, `discardDraft`: the store's server-replace operations, on the current revision (Undo after an autosave no longer sends the publish-time revision).
  - `undoSet` with this page in it: flushed first; text typed while it runs is kept as an earlier draft, then the store is replaced with the answer's document. If that keep fails, the store is not replaced and its next save meets the 409 choice with the text on screen.
  - Publish opens only after a flush, and pins the store's acknowledged revision and hash.
- **Status line, conflict, backup.** The store's words, the preview's words, "Use the newer version" / "Keep mine", "We found edits that weren't saved. Keep them as an earlier draft?", and the store's notices. A closed store (no document live) shows "Your store isn't open yet. Publishing your home page opens it."
- **Publish UI wiring.** `PublishPanelView` with an editor-held `createPublishFlow` (so the editor can flush before open and the store's call can read the pinned hash). "Go back to the live version" asks once, then `discardDraft` through the store. "Take this page offline" (route documents that are live) is UndoNotice with an offline target; staff see it disabled with the reason. "Earlier versions" lists `listHistory` and restores through the store. "Make your home page" creates the home page only when no home document exists; when one exists, the same button opens it.
- **Local backup per tab (P3-STORE review).** `createTabStorage` gives the store a storage whose backup keys carry this tab's id (`…:<revision>~<tab>`), so two tabs at one revision write two keys. Keys found from earlier visits or other tabs are read and removed as they are. When another tab removes a key this tab still needs (it dismissed or accepted our live backup, or cleared storage), the `storage` event writes it back.
- **The frame stops every control (P3-FRAME review).** While the editor's v2 bridge is on, a click on any button (a `type="button"` too: add to cart, wishlist, the cart drawer), input, select, textarea, summary, label or `role=button|link|switch|checkbox|tab|menuitem` element is stopped in the capture phase and picked instead. The preview's own bar stays exempt. Without the editor's hello (shoppers, the legacy Designer) nothing changes.
- **`/admin/releases`.** In documents mode the page renders `PublishingHistory`, which reads `listRecentlyPublished` through the documents API (its own mode check and access) and renders P3-PUBLISHUI's `RecentlyPublished`, reading the list again after an Undo. It passes `access` (staff: `{canPublish:false, reason}`). The client part is loaded with a dynamic import only in that branch, so the legacy suite that loads this page with plain `require()` is unaffected. Legacy and migrating render as before.

### UX ruling recorded here (P3-TREE review)

**After a move, hide, show or delete on a row that is not selected, the founder's selection stays where it was.** Adding or copying selects the new section (ED-04). Deleting the selected row selects its neighbour (the tree's proposal). With nothing selected, nothing becomes selected. This is `selectionAfterTree` in `editorModel.js`; SectionTree's own follow-up `onSelect` after a change is ignored by the editor, so the tree file is unchanged.

## Acceptance, with evidence

"Fails without" names the break (listed under "Do the tests bite?") that the test catches; on the base commit every `test-editor-shell` test fails, because the suite was the placeholder and `editorModel.js` did not exist.

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit (editorModel): a pick for another document switches with a note and no write to the open document; a pick on the open document selects and builds focusRequest {path, offset} | DONE | `test-editor-shell` "a pick for another document switches…": the exact note, no edit in the plan, the open store's state object unchanged, no call reached the server. "a pick on the open document selects…": `{path:"html", offset:2}`, `primary.label`, `meta.title`, a product page's fallback section. Drill: one click on the banner title focuses `f-sec_p3camp-title`; one click on the header opens it with the note and the home page's revision and hash unchanged | M1, M15 |
| 2 | unit: showDesign set when doc_design opens and cleared when another document opens; re-mint on ready ok:false and on no ready within 3 seconds | DONE | "showDesign is set when doc_design opens…": doc_design mints with showDesign on; another document calls `setShowDesign(sid,false)` on the same session; back on, off again; one mint; a failed `setShowDesign` re-mints with the right setting. "re-mint is requested on ready ok:false…": `live`, `revoked`, `expired`, `not_found` each re-mint with "Updating" and "Reconnecting…", then "Up to date"; `legacy` never. "…no ready arrives within 3 seconds": nothing at 2,999 ms, a re-mint at 3,000 ms; a ready in time and an hour shown re-mint nothing | M2, M3, M4, M5 |
| 3 | unit: an in-app navigation while dirty awaits the flush before routing | DONE | "an in-app navigation while dirty awaits the flush…": the click is held (prevented, stopped), no route while the save is held in flight, the save goes at once, the route happens after it lands with nothing unacknowledged; a clean store, a `#anchor`, a new tab and another site are not held; a failed save stays with words. "the switcher's open waits for the same flush…". Drill: "typed then clicked a console link within the pause, nothing lost" (status was `pending` at the click; the stored title is the typed text; 1 click) | M6 |
| 4 | rendered: a policy opens in the full-width writing view; a closed store shows the opening copy; staff see Publish disabled with the reason; /admin/releases renders RecentlyPublished in documents mode and the legacy screen otherwise | DONE | `EditorView` and the releases page compiled with Next's SWC, rendered with react-dom/server. A rich-text-only page: `data-writing-view`, no tree, the toggle, the rich text field; a mixed page: tree and layout. A store with no live document: the exact copy. Staff: `<button disabled>Publish</button>` and the reason, Take offline disabled with the reason; an owner's enabled. `/admin/releases` documents: the documents list host (and with its rows: `RecentlyPublished`, one Undo only where `canUndo`, the offline note), no legacy screen; legacy: `ReleasesAdmin`; migrating: the note as before. Drill: the policy, the closed store on `closed.localhost`, staff, and `/admin/releases` all seen in Chrome | M13, M14, M18 |
| 5 | drill (harness): editor.mjs passes every step listed, with screenshots and click counts, including 'typed then clicked a console link within the pause, nothing lost' and 'See the live store, back to the editor, Reconnecting then Up to date' | DONE | `docs/cms-reviews/drills/P3-EDITOR/results-editor.json`: 22 passed, 0 failed, with click counts in each detail and 20 screenshots. Edit and autosave (1 click, one revision), the frame shows the draft, click to select, other-document pick, the switcher (2 clicks), add a section, conflict in two tabs with Keep mine and "Kept from another tab" in Earlier versions, the link within the pause, See the live store (labels `Up to date → Updating (Reconnecting) → Updating → Up to date`, controller log `ready:live mint:false minted refresh … ready:ok`), publish (blocked by the new empty section, fixed with "Hide this section and publish", published, live shows the text), Undo (confirm lists "Hero: title changed, Text: removed"; live back to before) | each check is the browser side of 1 to 4 and 6 to 8 |
| 6 | drill: in the editor frame, clicking add to cart selects the section and adds nothing to the cart | DONE | Drill "cart": on `/products/advanced-anti-dandruff-shampoo-197` in the frame, one click on Add to cart: 0 cart writes, 0 cart lines, the product section row selected. `test-preview-frame` "P3-EDITOR: in the editor frame, a click on Add to cart, the wishlist heart, the cart drawer button, a quantity input, a summary and a role=button…": every click stopped, the page's own handler never ran, the product section picked and outlined; with no hello or v1, the page's controls work and its handlers run | the bridge on the base commit: 3 `test-preview-frame` tests fail (checked by `git stash` of `bridge-core.js`) |
| 7 | drill: at 375 the documents-mode nav drawer links storefront items to the editor | DONE | Drill "phone": at 375, Open menu, the drawer's links include `/admin/editor` and none of the 8 old storefront screens; one click on Editor opens the editor (2 clicks in all); no sideways scroll (overflow 0). Screenshots `phone-nav-drawer-375.png`, `phone-editor-375.png`. The drawer code was already right (P3-ROUTES); this is the browser proof the review asked for | (browser proof of existing code) |
| 8 | unit: staff see Undo disabled with the reason; a fix publish never includes unreviewed typing | PARTLY DONE | **The fix:** "a fix publish ('Hide this section and publish') never includes typing the review did not show": typing after the review, then the fix: no second publish, the founder is told to look again, the hide is not saved on top, the typing is kept as a draft. "with nothing typed after the review, the fix is saved through the store…": `saveDraft` on the reviewed revision with the section hidden, publish with the saved hash, the store at the new revision, the next autosave on it. "a publish whose review is older than the saved draft is refused, never sent". "Undo … uses the current revision after an autosave". Drill: the fix publish in Chrome. **Staff Undo:** the editor never shows staff a publish notice (staff can't publish), and shows Take offline disabled with the reason (rendered, item 4). On `/admin/releases`, the page passes `{canPublish:false, reason}` for staff and `PublishingHistory` hands it to `RecentlyPublished` (tested with a stub). **NOT DONE on this branch: the disabled Undo button itself.** `RecentlyPublished` and `UndoNotice` take `access` only once P3-FIX3 (same batch) adds the prop; until it merges, staff on `/admin/releases` see Undo, and the server refuses it ("This tab isn't allowed to do that…"). Owner check: after both merge, staff see Undo disabled with the reason | M7, M8, M9 |

From the batch reviews, also done:
- P3-FIX1: the desktop Chrome check of the confirm fetch. The drill saw the cookie set by a `fetch` of `/api/preview?…` with `x-storeasy-preview-confirm: 1` (2 confirms), no `fetch` of `/` in the network log, the frame showing the draft, and a spoilt token (the drill changes the token's last 4 characters) shows "Could not update · This preview link has expired or isn't valid, so the preview didn't open." with "Try the preview again".
- P3-STORE: per-tab backup keys. "two tabs on one document at one revision write two keys; tab B dismissing never removes tab A's only local copy": A's key and B's key both exist; B's dismiss removes A's key and A's `storage` event writes it back with A's words; a `clear()` elsewhere is rewritten by each tab; A clears only its own key on acknowledgement; an older visit's key (no tab id) is still offered and removable. Breaks M10, M11.
- P3-TREE: the selection ruling above. Break M12.
- P3-ROUTES: the phone drawer, item 7.
- P3-PUBLISHUI: flush before a fix, the current revision for Undo, access passed, and "Make your home page" only when no home exists (when one exists, the button opens it).

## Do the tests bite?

`…/scratchpad/p3-b4/P3-EDITOR/tools/mutate.py`: one break at a time, `node scripts/test-editor-shell.js`, the file restored.

| Break | Caught by |
|---|---|
| M1 another document's pick selects instead of switching | 2 tests |
| M2 showDesign never on | the showDesign test |
| M3 no `setShowDesign` on a switch | the showDesign test |
| M4 no ready timer | the 3-second test |
| M5 ready ok:false not handed to the machine | the ok:false test |
| M6 the guard routes without waiting | 2 tests |
| M7 publish without the reviewed-hash check | "a publish whose review is older…" |
| M8 the fix's `saveDraft` without the pinned check | "a fix publish … never includes typing…" |
| M9 Undo passes through with the publish-time revision | the Undo revision test |
| M10 one backup key for every tab | the two-tab test |
| M11 no rewrite on another tab's removal | the two-tab test |
| M12 the selection follows the tree's proposal | the tree ruling test |
| M13 no writing view | the rendered policy test |
| M14 a closed store never detected | the rendered closed test |
| M15 no product-page fallback section | the pick test |
| M16 "Adding to preview…" never resolves | the adding test (my first version of this break was a syntax error and was misreported as surviving; the valid break is caught) |
| M17 tree changes as one whole-list set (DocumentEditor wiring) | not caught by the unit suite: it is component wiring. The drill's "add" step goes through it |
| M18 the closed copy missing | the rendered closed test |

## Tests

| What | Result | Time |
|---|---|---|
| `pnpm test:editor-shell` (replaces P3-SCAFFOLD's placeholder) | 24 passed | 0.4 s in the gate |
| `pnpm test:preview-frame` | 20 passed (3 new or changed tests) | 0.8 s |
| `pnpm test` | 81 of 81 suites | 130.4 s |
| `pnpm build` | passed | |
| `DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/editor.mjs` | 22 passed, 0 failed | about 4 minutes |

The drill reseeds with `--p3`, makes one click counter per browser context, signs in through the real form (owner, staff, and the closed store's setup password), and stops the harness it started. Ports 6100 and 7100 to 7109 were free afterwards. One run stopped with "The harness didn't come up at http://localhost:6100 within 3 minutes" at a machine load of 3.5; the port was free and the next run passed, so I count it as a slow start, not a code failure.

`test-preview-frame` changes: the P3-FIX2 capture-phase test and the v2 click test pinned "a type=button is the page's own"; they now pin that it is stopped (the review's request), and a click on plain text still reaches the page's bubble handlers.

## Known limits

- **`/admin/editor` is still the console's capped page** (max 1024 px, with the sidebar), because `components/admin/cms/editorLayout.js` (EDITOR_ROUTES) is not this item's file. The tree scrolls in its own box and the preview is sticky. A later item should add `/admin/editor` to EDITOR_ROUTES for the full-width layout.
- **Staff see Undo enabled on `/admin/releases` until P3-FIX3 merges** (item 8). The server refuses it, so this is not a security hole.
- **P3-ROUTES' drill now fails one check**: "the Designer is never reached (finding 2): no Designer shell, no legacy preview frame" counts every `iframe`, and the new editor has its own preview frame. The Designer is still not reached (no `[data-editor-shell]`, address `/admin/editor?doc=doc_home`). `scripts/drills/p3/routes.mjs` is not this item's file; P3-DRILLS should narrow it to the Designer's frame. I restored the ROUTES results in the worktree; my run's copy is `…/scratchpad/p3-b4/P3-EDITOR/routes-results-p3-editor-run.json` (30 passed, 1 failed).
- **"Make your home page" words**: when a home page exists but the server still answers `FIRST_PUBLISH_NEEDS_HOME` with no offer, the button (PublishPanel's words, P3-FIX3's file) still says "Make your home page", and opens the existing home page.
- **Product picks**: the product page's markup (legacy PDP layouts) carries no section ids, so every pick on it selects the layout's `product_main`. Clicking a field there focuses nothing.
- **Products in the switcher** are the catalog's first 30 by title (the catalog API's limit); the name search filters those. Product editing waits for OVL-02.
- **The frame's address for layouts** is the first available product, or the first collection. The founder can't choose which product the frame shows yet.
- **No media picker** in the new editor yet (`context.pickImage` is not passed); image fields show what `ImageControl` shows without it.
- **A legacy (unsuffixed) backup at this tab's revision** can be offered twice: the store moves an offered backup aside before writing at its own key, which per-tab keys no longer need. Keeping it twice loses nothing.
- **Another live tab's backup can still be offered** in a new tab (P3-STORE's limit). Dismissing it no longer costs the other tab its copy.
- **Not drilled here** (unit or rendered only, or P3-PUBLISHUI's own tests): "Use the newer version", take offline in the browser, whole-set Undo from the editor, Earlier versions restore, Keep the live version, the offer review, the republish question.
- **`data-preview-log`** on the preview pane holds the controller's last 16 steps (console markup only, founder-only), for drills and support.
- Next dev only, Chrome only, headless, macOS, 1440 and 375.

## Owner checks

- **Desktop Chrome on a documents test tenant on staging** (no real tenant): open `/admin/editor`, type and click a sidebar link within a second (nothing lost), close the tab within a second (the warning, and the keepalive PUT in the network panel), reopen (the backup offer), two tabs with Keep mine and Use the newer version, See the live store and back, publish and Undo.
- **After P3-FIX3 merges**: staff on `/admin/releases` see Undo disabled with the reason.
- **Rulings**: the tree selection ruling above; the pick note's words; "Adding to preview…"; the writing view for all-rich-text pages and journal posts; the closed-store copy; "Leave anyway" after a failed save; that every control in the editor frame is stopped (the FAQ copy link and accordions too).
- **Phones**: the editor at 375 on a real phone (seen only in desktop Chrome at 375).
- **CI `sqld` download**: not touched (no `.github/` change). Its source and checksum still need the owner's approval.

## Files

- New: `components/admin/editor/editorModel.js`, `Switcher.js`, `PreviewPane.js`, `StatusLine.js`, `scripts/drills/p3/editor.mjs`, `docs/cms-reviews/P3-EDITOR.md`, `docs/cms-reviews/drills/P3-EDITOR/`
- Changed: `components/admin/editor/DocumentEditor.js`, `components/preview/bridge-core.js`, `app/(console)/admin/(authed)/releases/page.js`, `scripts/test-editor-shell.js` (replaces the placeholder), `scripts/test-preview-frame.js`
- Not changed: every batch 3 component (store, preview machine, forms, tree, publish UI). The defects the drill found were fixed in the editor's own files.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:editor-shell && pnpm test:preview-frame
TEST_PUBLISH_PORTS=7101,7102 TEST_PUBLISH_SERVICE_PORTS=7103,7104 TEST_PUBLISH_UNDO_PORTS=7105 PORT=6100 pnpm test
pnpm build
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/editor.mjs
```
