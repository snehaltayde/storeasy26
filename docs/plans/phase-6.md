# Phase 6 plan: studio editor (roadmap Phase 3)

Architect plan, 2026-11-25 22:40 IST. No schema change, no new dependency, no new permission action.

## Findings that shape the plan
1. The parts exist: `components/admin/editor/store.js` (one store per document: 700 ms autosave, `revision` + 409 `DOCUMENT_CHANGED`, `draftHash`, `publishSet` items); `tree/treeModel.js` `move(sections, id, toIndex, {type})` guarded by the registry's composition rules, plus `rowActions`; `PreviewPane` + `createPreviewController` (mint, re-mint, `showDesign`, reload on `saveAck`); `DesignForm` `BrandControl` edits every token key (accent, background, foreground, radius, type_scale, button_shape, section_spacing).
2. Instant preview has a precedent: `components/preview/bridge-core.js` look mode draws unsaved choices with `storeasy:brand`; the frame computes CSS itself (`brandFor`, injected by `PreviewBridge.js`) into `<style id="brand-vars-draft">`, accepted only from `window.parent`, same origin, while `ok === true`. The editor frame today only reloads after a save.
3. Tokens already layer over a theme: tokens are `doc_design.settings.brand`; an uploaded package gives `surfaces`, `styles`, templates. Overriding needs no new storage.
4. No drag library in `package.json`; `@dnd-kit/react` is still 0.x.

## Order and parallelism
- **Step 0, contract** (one builder, ~30 min, own worktree, merged before lines 1 and 2 fork):
  - `components/preview/bridge-core.js`: two v2 editor messages (spec below)
  - `components/preview/PreviewBridge.js`: injects `tokensCss(brand)`
  - `app/(storefront)/layout.js`: passes `look={{kit, surfaces}}` to `PreviewBridgeMount` in the editing branch
  - `components/admin/editor/PreviewPane.js`: props `fill` (full height) and `onFrame(post)` (a poster bound to the frame and origin)
  - `components/admin/studio/studioModel.js` (pure): `touched` set (documents this session changed) and undo/redo history of `{docId, before, after}`, 50 steps
  - `components/admin/studio/Studio.js`: shell with top bar, left rail with "Sections" and "Design" tabs as slots, preview centre, inspector right
  - `app/(console)/admin/(authed)/studio/page.js` + `loading.js` + `error.js`
  - `lib/admin/nav.js`: item id `editor` gets label "Studio" and href `/admin/studio`
  - drill skeleton `scripts/drills/studio/{run.mjs,lib.mjs}`, `studio` in `DRILLS` (`run-isolated.mjs`, `withRolesStore` like `themes`), `drill:studio`
  - `scripts/test-studio.js` + `test:studio`
- **Then lines 1 and 2 in parallel**, own worktrees under `../storeasy26-wt/`, disjoint files. Shared append-only: `package.json`, `scripts/support/{admin-pages,support-reads,read-controls}.js`, `docs/UI.md` (one sub-heading each).
- Both lines touch shared editor, nav or storefront code, so **each builder runs `pnpm test`** (PLAYBOOK).
- Tenant 0035 and platform 0020 stay unused.

### Bridge protocol (fixed in step 0)
- **`storeasy:order`** from the parent `{type, doc, ids:[sectionId…], hidden:[sectionId…]}`. Taken only when v2 is on, `!look`, `ok === true`, sender is `window.parent`, origin matches. Ids `/^[A-Za-z0-9_-]{1,64}$/`, at most 200. For the `[data-section-id]` siblings inside `[data-doc="<doc>"]`, the frame adds class `storeasy-ordering` to their parent (`display:flex; flex-direction:column`) and sets `style.order`. Hidden ids get `data-studio-hidden` + `display:none`. Never creates, removes or moves a DOM node; unknown ids ignored; the next `storeasy:refresh` reload clears it.
- **`storeasy:tokens`** from the parent `{type, brand}`, same gates. The frame runs `tokensCss(brand)`: `validateBrand(brand)`; if ok, `brandCssVars(value, {kit, surfaces})` using the layout's `look`, into `#brand-vars-draft` after `#brand-vars`. Invalid brand ignored; raw CSS never accepted; `brand: null` removes the draft style. Package compiled styles stay and follow the role variables.
- **How the preview updates:** reorder, hide and token edits post on the same tick (no network round trip); the store autosaves after 700 ms and `saveAck` reloads the frame ("Updating" → "Up to date", scroll kept); the reload is the truth. Content edits, adds and copies use the existing save-then-reload path. The studio turns `showDesign` on as soon as any token is touched.

## Permissions (no change to `lib/platform/authz.js`)
| Action | owner | admin | staff | support | op-support | signed out | other store's owner |
|---|---|---|---|---|---|---|---|
| open `/admin/studio` (`storefront.read`) | 200 | 200 | 200 | 200 read-only | 200 read-only | → `/admin/login` | own store only; another store's `?doc=` → home + note |
| drag, move, hide, add, delete, inspector, tokens (`storefront.write`, documents API) | yes | yes | yes | no controls; API 403 | no controls; API 403 | 401 | 401 |
| publish / publishSet (`storefront.publish`) | 200 | 200 | "Ask an admin to publish"; 403 | 403 | 403 | 401 | 401 |
| preview session / `showDesign` (existing) | 200 | 200 | 200 | 200 | 200 | 401 | 401 |
| storefront HTML, anonymous | live only; no bridge, so `order`/`tokens` do nothing | | | | | | |

---
## Line 1: a founder edits in a full-screen studio with drag-and-drop sections and an instant preview
**Features (floor)**
1. `/admin/studio?doc=<id>|?path=<path>` (`editorEntry` rules) fills the viewport (`fixed inset-0`, no console shell). Top bar: "Exit studio" (`createNavGuard` asks if unsaved), document switcher (pages, home, layouts, header, footer, design), save state (`StatusLine`), undo/redo, device widths, "Full screen" (`requestFullscreen`, read control), Publish. Below 1024px the rails become tabs: Sections, Edit, Design, Preview.
2. Product and collection content redirect to `/admin/editor?doc=`; the editor stays and "Edit this page" still opens it.
3. Drag and drop in the Sections rail (`SectionTree` gains a handle; native pointer events): starts only from a 24px handle (`touch-action:none`, `setPointerCapture`) after a 4px threshold; row follows the pointer, drop line shows the target, rail auto-scrolls near edges; every candidate index checked with `treeModel.move`; a refused spot shows "Can't drop here" with the registry's reason and snaps back; Escape cancels; the frame reorders while dragging and outlines the dragged section (`storeasy:select`).
4. Keyboard: Move up/down buttons stay; the handle is a button "Reorder <label>"; Space/Enter picks up, ArrowUp/ArrowDown (Home/End) move, Space/Enter drops, Escape returns it. While held, arrows move the section, not focus.
5. One `aria-live="assertive"` region: "Picked up Hero, position 2 of 6. Arrow keys move it, Space drops it, Escape cancels." / "Hero, position 3 of 6." / "Can't go there: <reason>." / "Hero dropped at position 3 of 6." / "Move cancelled. Hero is back at position 2." Pointer drops announce too.
6. "Add a section here" insert points between rows (focusable, `storefront.write`), reusing `AddSection` with that index.
7. Reorder, hide and show post `storeasy:order` at once; other edits use save-then-reload; the frame never says "Up to date" before the save is acknowledged.
8. Undo/redo (⌘Z, ⇧⌘Z, buttons) for this session's structure, settings and token edits; each step is a normal draft save; undo never publishes.
9. Publish dialog: every document with a draft listed with a checkbox; pre-ticked only `touched` documents that still differ from live; the rest under "Other drafts", unticked, described "Changed in this session" or "Has other edits". Pending saves flushed first; calls `publishSet` with each document's `revision` and `draftHash`; server refusals (blockers, 409) in plain words with "Go to the fix". Staff see the reason instead of the button.
10. A 409 shows the existing conflict notice and disables drag until resolved; a failed save keeps the edit locally (existing backup).
11. Support and op-support: no handles, insert points, Add or row buttons; read-only inspector; Space picks nothing up; zero documents writes.

**Files:** `components/admin/editor/tree/dragModel.js` (pure: pointer y → index, keyboard grab state, announcement text, validity via `move`); `components/admin/editor/tree/SectionTree.js` (handle, insert points, `draggable` prop); `components/admin/studio/{SectionsRail,StudioTopBar,StudioPublishDialog,LiveRegion}.js`; `scripts/test-studio-drag.js` + `test:studio-drag`; `scripts/test-preview-frame.js` (order cases); `scripts/drills/studio/{stage-drag,stage-publish,stage-roles}.mjs`; `docs/UI.md` ("Studio").

**Tests:** `test-studio-drag`: index maths at edges and in a scaled pane; refused positions; keyboard grab, move, drop, cancel; exact announcement strings; no grab for support. `test-studio`: page per role (support and op-support have no write marks; another store's doc id canary); staff no Publish; pre-ticks only `touched`; undo restores the body; entity docs redirect; two stores saving at once with a slow save, then publish sends fresh revisions. `test-preview-frame`: `order` from a non-parent, another origin, `ok:false` or look mode is ignored; no node created or removed; unknown ids ignored.

**Drill stages:** `open` (owner, frame reaches "Up to date"); `drag` (pointer drag with the save delayed 2 s by a route: frame order changes before the POST completes and survives reload; then a keyboard move, live region text checked); `publish` (home pre-ticked, an older about-page draft unticked; after publish anonymous sees the new order and the about draft is still a draft); `roles` (staff drag OK, no Publish; support has no handles and sends no documents POST).

## Line 2: a founder customises the theme's colours, type and spacing in the studio within the design tokens
**Features (floor)**
1. The Design tab edits `doc_design` through its own store with revision concurrency: colours (accent, background, foreground; picker + hex), type (`type_scale`), spacing and shape (`section_spacing`, `radius`, `button_shape`); `validateBrand` options only; reuses `BrandControl`'s controls.
2. Every change posts `storeasy:tokens` on the same tick, on whatever page the frame shows, then saves; `showDesign` on for the session.
3. `checkBrand` with the live kit, package `surfaces` and live brand lists failing pairs in plain words, each with a `suggestFix` "Use <colour>" button; a failing pair is a publish blocker (existing server check), visible before the dialog.
4. With an uploaded theme live or drafted: "Theme: Aurora 1.2.0. Your colours, type and spacing go on top of it." "Reset to the theme's" restores the package's tokens; with a built-in look Reset goes to `startingBrand`. Package surfaces and styles aren't editable here.
5. Undo/redo cover token edits; Publish uses line 1's dialog with `doc_design` pre-ticked when touched.
6. Support and op-support see values with disabled inputs, no Reset, no fix buttons. Staff can draft.

**Files:** `components/admin/studio/{DesignRail,tokensModel}.js` (pure: `setToken`, reset target, post); `components/admin/onboarding/` untouched; `scripts/test-studio-tokens.js` + `test:studio-tokens`; `scripts/drills/studio/stage-design.mjs`; `docs/UI.md` ("Studio: design").

**Tests (`test-studio-tokens`):** the `tokens` handler uses only `validateBrand` output and ignores `"accent":"red;}body{"`, extra keys, a non-parent sender, `ok:false`; the CSS equals the layout's `brandCssVars` for the same brand, kit and surfaces; Reset targets for package and built-in looks; `checkBrand` blockers with package surfaces; support and op-support render no enabled token input; anonymous live HTML unchanged after a draft token save; `layout.js` import walk finds no `node:*`.

**Drill stage `design`:** with the save delayed, changing accent changes the frame's `--c-accent` before the POST; then type scale and spacing; a low-contrast foreground shows the fix and blocks publish; with Aurora live, override accent, check the package's `data-theme` styles remain, then Reset to the theme's.

---
## Events and side effects
| What | Where | Who reads it |
|---|---|---|
| draft saves (documents API) | store DB | studio, Releases |
| `publishSet`: release, `publish_log`, audit in one batch | store DB, `audit_log` | Releases, rollback, Audit, operators |
| `config.theme_pin` (existing afterCommit on `doc_design`) | control plane | operator Themes |
| storefront cache invalidation (existing) | — | storefront |

No new audit actions or log events.

## Checks the builder runs first
- `node scripts/test-preview-frame.js && node scripts/test-editor-tree.js && node scripts/test-editor-store.js && node scripts/test-editor-ui.js && node scripts/test-editor-shell.js && node scripts/test-design-doc.js` (drop missing ones)
- `sed -n 743,800p lib/brand.js`: confirm every token becomes a CSS variable; if one doesn't, the instant path covers it only after reload; say so.
- `grep -rn "data-section-id" components/ "app/(storefront)" | head -20`: one parent holds the sections? hidden sections rendered in preview?
- `grep -n "flush\|saveNow\|publishSet" components/admin/editor/store.js`
- `grep -rln '"editor"\|/admin/editor' scripts/test-*.js | head`: suites pinning the nav label or href
- `ls migrations/tenant | tail -2`

## Risks
1. CSS `order` on the sections' parent can shift spacing until reload; with wrapper parents the message acts within one parent only.
2. Two stores saving at once (page + `doc_design`) with undo across both: publish must flush both and send fresh revisions.
3. Hand-built drag and accessibility (pointer capture in a scaled pane, touch, focus during a grab): dedicated accessibility review and the keyboard drill stage.
4. Nav relabel and shared `SectionTree`, `PreviewPane`, `bridge-core` edits ripple into editor, nav-count and `sf-styles` suites: `pnpm test` in both briefs; `drill:editor` and `drill:sf-styles` in the phase suite.
