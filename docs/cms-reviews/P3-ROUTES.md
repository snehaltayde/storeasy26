# P3-ROUTES: the editor's address, the old screens' redirects, the console nav, and the Designer's failed push (ED-02, PUB-11, PV-01)

Plan: `docs/cms-reviews/P3-PLAN.md` (decision 11, batch 3) and `P3-BATCHES.json`. Branch `cms/p3-routes`, cut from `64d3d07`. No migration. No new dependency. No real tenant changes mode. Nothing under `.github/` changed.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 140.4 s (`TEST_PUBLISH_PORTS=7183,7184 TEST_PUBLISH_SERVICE_PORTS=7185,7186 TEST_PUBLISH_UNDO_PORTS=7187`). `test:editor-routes`: 22 passed, 0.5 s in the gate (1.7 s alone). 12 deliberate breaks, 12 caught. `pnpm build` passed, `/admin/editor` is listed as a dynamic route; its warnings are the old `next.config.mjs` NFT trace through `lib/platform/migrate.js`, not from this item |
| Browser verified | Yes, on the design harness from this worktree (`DESIGN_PORT=6180`, `DESIGN_SQLD_PORT=7180`, so 7180 to 7182, `next dev`), desktop Chrome 156 (headless, `playwright-core`), 1440 wide. `scripts/drills/p3/routes.mjs`: 31 passed, 0 failed. Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

- **ED-02** says one editor edits every document and entering it opens the home page. Phase 3 builds that editor in batch 4. This item gives it its address, `/admin/editor`, and decides which document it opens.
- **PUB-11** needs "Edit this page" on a live page to open the document behind that address. `?path=` does that: it is the reverse of `livePath()`.
- **Plan decision 11:** the new editor runs beside the old ones. On a documents store, the old content, brand and theme screens send the founder to the new editor; on legacy and migrating stores they stay exactly as they are. That also fixes **finding 2**: the Designer is never reached on a documents store, so it can't show a broken preview there.
- **US-38:** on a documents store the sidebar shows one "Editor" link instead of eight storefront screens.
- **PV-01 (legacy slice):** the Designer used to drop a failed live-preview push silently (`Designer.js:289-297` in the spec's evidence). The frame stayed on older content and the label could still say "Preview shows your UNSAVED edits". Now the founder is told, in plain words.

## Design

**1. `lib/admin/editor-entry.js` (pure, no I/O, no `node:` imports).**
- `editorEntry({ doc, path }, documents)` returns `{ document: { id, type, label, slug }, note }`.
  - `?doc=<id>` opens that row. A registered singleton id (`doc_design`, `doc_header`, …) opens even before its row exists, labelled from the registry, because the store already shows its code default.
  - `?path=<path>` is placed by `placePath()`: `/` is home, `/about` and `/contact` are those pages, `/policies/<slug>`, `/campaigns/<slug>`, `/journal/<slug>`. The row must have the same type and give the same `livePath()`, so a slug shared by a page, a campaign and a journal post never crosses types. Query strings, hashes and a trailing slash are ignored. Anything that isn't a plain path on this store (`https://…`, `//…`) is not placed.
  - No query opens home.
  - An unknown id, or an address with no page behind it, opens home with a note: "We couldn't find that page…" or "Nothing on your store lives at /x yet, so the editor opened your home page." The address in the note is cut at 120 characters; React escapes it.
- `LEGACY_ROUTE_DOCS` maps each old screen to its document; `editorHref(id)` builds `/admin/editor?doc=<id>`.

**2. `app/(console)/admin/(authed)/editor/page.js`** (`runtime = "nodejs"`, `force-dynamic`).
- The same sign-in guard as every console page.
- `getCmsMode()` is read on every request (it never caches).
  - `documents`: `listDocuments()` once, then `<DocumentEditor document note />`.
  - `legacy`: a note that links to `/admin/storefront/designer`. No documents are read.
  - `migrating` (and any unknown stored text): a read-only note. No link to any editor, no button.
  - A mode that can't be read throws (`CMS_MODE_UNAVAILABLE`), so the console's error page shows. It never guesses.

**3. `components/admin/editor/DocumentEditor.js`.** A placeholder: the page title "Editor", the note if any, and the chosen document's label (`data-document-editor`, `data-doc`, `data-document-label`). P3-EDITOR replaces it in batch 4.

**4. The redirects (each 3 lines plus 2 imports, right after the sign-in guard, before any data is loaded).**

| Old screen | Documents store goes to |
|---|---|
| `/admin/storefront` (overview) | `/admin/editor?doc=doc_home` |
| `/admin/storefront/designer` | `/admin/editor?doc=doc_home` |
| `/admin/storefront/home` | `/admin/editor?doc=doc_home` |
| `/admin/storefront/navigation` | `/admin/editor?doc=doc_header` |
| `/admin/storefront/pages` | `/admin/editor?doc=doc_home` (the pages list has no document; the switcher lists pages in batch 4) |
| `/admin/storefront/product-pages` | `/admin/editor?doc=doc_product_layout` |
| `/admin/brand` | `/admin/editor?doc=doc_design` |
| `/admin/theme` | `/admin/editor?doc=doc_design` |

- Only `documents` redirects. `legacy`, `migrating` and anything else render the screen as before.
- **A mode read that fails keeps the old screen** (`.catch(() => null)`). This is on purpose: a legacy store must not lose its brand or theme screen (which read only control-plane config) because one tenant-database read failed. On a documents store in that state, every old writer still refuses on its own fresh mode read (P2-GUARD), so nothing can be written. The editor page itself fails closed instead. This is listed as an owner ruling below.

**5. Console nav.**
- `layout.js` reads `getCmsMode()` inside the existing best-effort badge block and passes `cmsMode` to `ConsoleShell`. A failed read passes `null`, which is today's nav. This adds one `cms_state` statement to every console page render.
- `ConsoleShell` passes `cmsMode` through to `SidebarNav` (desktop sidebar and drawer). Nothing else in the shell changed.
- `SidebarNav`'s new `navGroups(cmsMode)`: in `documents` mode the Storefront group becomes Editor (`/admin/editor`), Media, Publishing. Every other value returns `NAV_GROUPS` itself, unchanged. Role filtering is unchanged.

**6. Designer, PV-01 legacy slice (`components/admin/cms/Designer.js`).**
- New exported `candidateFailure(res)` words each failure of `saveCandidate`:
  - a 422 with issues: "something in your edits needs fixing", plus each issue worded like the save errors, as a button that selects its section (the same pattern as `errorBanner`);
  - a 422 with only `errors`: those words;
  - no connection: "We couldn't reach Storeasy, so the preview didn't update…";
  - `NO_PREVIEW` (409): the server's words, plus a "Reopen preview" button that mints a new session;
  - 5xx or an unreadable answer: "Something went wrong on our side (error N), so the preview didn't update. Try again in a minute.";
  - any other 4xx: the server's own words.

  Every message ends with "The preview still shows an earlier version. Your changes are still here, and nothing is saved until you press Save." None of them says "nothing was saved", because a preview push is not a save.
- On a failed push the Designer keeps `pushFail` and shows a warning banner above the frame. The status line says "Preview didn't update: it shows an earlier version" instead of "Preview shows your UNSAVED edits". That is the negative in PV-01: the label never claims edits the frame doesn't hold.
- The next push that works, re-minting the preview, or reverting to the last save clears it. One banner, replaced by each push, so there is no storm of messages.
- Nothing else in the Designer changed.

## Acceptance, with evidence

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: editor-entry maps /, /about, /contact, /policies/x, /campaigns/x, /journal/x and an unknown path; every mapping round-trips with livePath | DONE | `test:editor-routes` "each listed path opens its document" (one slug `x` under three types, three different documents), "an unknown path opens home with a note that names the path" (5 paths plus an off-site URL), "every document with an address round-trips" (livePath of every listed row opens that row; placePath of each listed path gives the path back through livePath, including `/policies/size%20guide`), and "?doc= opens that id…" | M8 (path lookup by slug alone, ignoring type), M11 (no note for an unknown id) |
| 2 | rendered: /admin/editor renders the editor placeholder in documents, the note in legacy and the read-only note in migrating; each listed legacy route redirects in documents mode only and renders as before in legacy and migrating | DONE | The real page modules, compiled with Next's SWC and called as server components, data stubbed. Editor: documents shows `data-document-editor` at `doc_home`, at the campaign for `?path=`, at `doc_design` for `?doc=`, with the note for an unknown path; legacy shows `data-editor-note="legacy"` with the Designer link and reads no documents; migrating (and an unknown mode) shows the read-only note with no link or button; one mode read per request; a mode read error throws. Redirects: all 8 screens redirect to the table's address in documents mode. In legacy and in migrating, each screen's markup is **byte-equal** to the same file compiled with its one redirect line taken out. A failed mode read renders the old screen too. Drill: 8 of 8 land on the editor at the right document (documents), 2 of 2 stay (migrating), 8 of 8 stay with no error page (legacy) | M2 (no Designer redirect), M3 (brand redirects in every mode), M7 (editor shown on legacy), M12 (navigation to the wrong document) |
| 3 | rendered: SidebarNav in documents mode links storefront items to /admin/editor; test-editor-layout's legacy ConsoleShell output is unchanged | DONE | `test:editor-routes`: documents mode gives `/admin/editor` (marked current on `/admin/editor`), Media and Publishing with its badge, and none of the 8 old links, in SidebarNav and in the whole shell; staff keep the role filter. `null`, `legacy`, `migrating`, `""` and `DOCUMENTS` give markup equal to no prop, and the legacy links in their exact order. ConsoleShell's markup with `cmsMode` null, legacy or migrating equals no prop on 4 paths. The layout passes documents, legacy and migrating through, and `null` when the read fails. `test:editor-layout` 34 of 34. One-off check: ConsoleShell's markup on 5 paths x 3 roles (236,330 bytes) is identical to the base commit's ConsoleShell and SidebarNav (scratch `mut/shell-base.html` vs `shell-new.html`, `cmp` equal). Drill: documents sidebar has Editor, Media and Publishing only, and one click on Editor opens home; migrating and legacy sidebars are the old ones | M4 (nav ignores the mode), M5 (layout drops the mode), M6 (shell drops the mode) |
| 4 | rendered: Designer shows a plain message for a failed candidate push (stubbed api); test-admin-console stays green | DONE | `test:editor-routes`: `candidateFailure` words 7 failure answers, each saying the frame is stale and none saying "nothing was saved."; Reopen only for `NO_PREVIEW`. Behaviour, with the real Designer, a stubbed `./api` and stand-in hooks (effects run when their dependencies change, like React): preview minted and connected, Hero picked, title typed, push. A good push shows "UNSAVED edits". A network failure shows the banner (rendered with the real Banner) and the label stops claiming edits. The next good push clears it. A 422 names "Section 1" and clicking it selects that section in the tree. `NO_PREVIEW` offers "Reopen preview", a 500 says "error 500". A first render has no banner. `test:admin-console` 9 of 9. Drill (legacy store, real Designer, the PUT intercepted to answer 503): the banner shows "Something went wrong on our side (error 503), so the preview didn't update", the status line does not say "UNSAVED edits", and the next real push clears it | M1 (Designer back to base: 3 tests fail), M9 (label still claims edits), M10 (failure not cleared on success) |
| 5 | drill (harness): routes.mjs passes for the Designer redirect, the nav and the legacy tenant | DONE | `docs/cms-reviews/drills/P3-ROUTES/results-routes.json`: 31 passed, 0 failed, 0 known. Screenshots: `documents-designer-redirect-1440.png`, `documents-editor-home-1440.png`, `documents-unknown-path-1440.png`, `migrating-editor-note-1440.png`, `legacy-editor-note-1440.png`, `legacy-designer-push-failed-1440.png` | each check is the browser side of 2 to 4 |

## Do the tests bite?

Scratch runner `…/scratchpad/p3-b3/P3-ROUTES/mut/run.py`: one break at a time, `node scripts/test-editor-routes.js`, the file restored. **12 of 12 caught.**

| Break | Tests that failed |
|---|---|
| M1 Designer.js back to the base commit | 3 (candidateFailure, failed push, issue link / Reopen) |
| M2 no redirect line in the Designer page | 2 |
| M3 brand page redirects in every mode | 2 |
| M4 `navGroups` ignores the mode | 2 |
| M5 layout doesn't pass `cmsMode` | 1 |
| M6 ConsoleShell doesn't pass `cmsMode` to SidebarNav | 1 |
| M7 the editor shows on legacy | 3 |
| M8 `?path=` matched by slug alone | 2 |
| M9 status label still says "UNSAVED edits" after a failure | 1 |
| M10 a good push doesn't clear the failure | 1 |
| M11 an unknown `?doc=` gives no note | 1 |
| M12 navigation sent to home | 1 |

## Tests

| What | Result | Time |
|---|---|---|
| `pnpm test:editor-routes` (replaces P3-SCAFFOLD's placeholder) | 22 passed | 0.5 s in the gate |
| `pnpm test` | 81 of 81 suites | 140.4 s |
| `pnpm build` | passed | |
| `DESIGN_PORT=6180 DESIGN_SQLD_PORT=7180 node scripts/drills/p3/routes.mjs` | 31 passed, 0 failed | about 2 minutes |

The drill follows the batch 2 review notes: one `clickCounter` per browser context (one per part), owner sign-in with `drill.login()` on the `--p3` seed, and the setup password through the real form on the legacy perf seed (the way `drill.js` `signIn` does). The migrating part sets `cms_state.mode` on the harness's own local database and sets it back. The drill stops the harness it started, and ports 6180 and 7180 to 7182 were free afterwards.

## Known limits

- **`/admin/editor` uses the console's normal capped page, with the sidebar.** It is not in `EDITOR_ROUTES` (`components/admin/cms/editorLayout.js` is not this item's file). P3-EDITOR adds it when the real editor lays out full width; the placeholder needs the sidebar for navigation until then.
- **Other old screens are not redirected:** `/admin/storefront/pages/[slug]` and `/new`, `/admin/storefront/designer/product` and `/collection` (SurfaceDesigner), `/admin/releases`, and the presentation half of Catalog. They are not in this item's file list. On a documents store their writes already refuse (P2-GUARD); only their screens still show. Links to them from the old screens can't be reached on a documents store, because those screens redirect.
- **`/admin/storefront/pages` opens home.** The pages list has no document of its own; the batch 4 switcher lists pages.
- **`?path=` matches the document's draft slug** (`documents.slug`). A page renamed in its draft but not yet published is found at its new address, not its old live one. An old address covered by a redirect opens home with the note. P3-EDITOR's "Edit this page" should pass `?doc=` when the frame knows the id (`data-doc`), and `?path=` only as a fallback.
- **A failed mode read keeps the old screen** on the 8 redirected routes (see Design 4). The old writers still refuse on their own read.
- **One more statement per console page:** the layout's `getCmsMode()` (best effort, inside the badge block). It is not counted by `perf-dbcount`; P2-PERF's console numbers move by 1.
- **PV-01 is the legacy slice only.** It covers the Designer's candidate push. The "updating" state and a link to the exact field (not just the section) are the new editor's (`previewMachine`, P3-STORE and P3-EDITOR). A hero issue links to the hero; an announcement issue links to the announcement.
- **P2 drill `preview`'s known check** "the real Designer previews a documents store" (`known: "finding 2"`) still fails, now because the Designer redirects to the editor on a documents store. P3-DRILLS owns `scripts/drills/p2/` and should retire that known check, as finding 2 is fixed by the redirect.
- **The rendered tests stub each page's data** (`storefrontView`, releases, brand, kits…). They prove the redirect and that the page's own markup is unchanged, not the data loaders, which this item didn't touch.
- Next dev only, Chrome only, headless, macOS, 1440 wide.

## Owner checks

- **Ruling:** on the 8 old screens, a mode read that fails keeps the old screen (writes still refuse), while `/admin/editor` shows the error page. Accept, or ask for the old screens to fail closed too.
- **Ruling:** in documents mode the sidebar's Storefront group is Editor, Media and Publishing only (US-38), and `/admin/storefront/pages` opens the home page.
- **On a documents test tenant on staging** (no real tenant): open each of the 8 old addresses from a bookmark and confirm they land in the editor; confirm a legacy tenant's sidebar and screens look as before.
- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need the owner's approval.
- Optional: `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p3/routes.mjs` on your Mac, and look at `legacy-designer-push-failed-1440.png`.

## Files

- New: `app/(console)/admin/(authed)/editor/page.js`, `components/admin/editor/DocumentEditor.js`, `lib/admin/editor-entry.js`, `scripts/drills/p3/routes.mjs`, `docs/cms-reviews/P3-ROUTES.md`, `docs/cms-reviews/drills/P3-ROUTES/`
- Changed: the 8 old screens (redirect), `app/(console)/admin/(authed)/layout.js`, `components/console/nav/ConsoleShell.js`, `components/console/nav/SidebarNav.js`, `components/admin/cms/Designer.js`, `scripts/test-editor-routes.js` (replaces the placeholder)

## Commands

```
pnpm test:editor-routes
TEST_PUBLISH_PORTS=7183,7184 TEST_PUBLISH_SERVICE_PORTS=7185,7186 TEST_PUBLISH_UNDO_PORTS=7187 pnpm test
pnpm build
DESIGN_PORT=6180 DESIGN_SQLD_PORT=7180 node scripts/drills/p3/routes.mjs
```
