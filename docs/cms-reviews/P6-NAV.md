# P6 · NAV · Logo and colours you can find again, Reset to the starting palette, one dashboard nudge (GEN-04, GEN-01, US-01)

This is the author's own report. Reviewers should re-read the code.

Branch `cms/p6-nav`, cut from `dd9ff01` (`cms/phase-1` with P5-FIX2 `441b44d`, P5-DRILLS `211c982`, P6-PALETTE `8f7430c`, P6-GEN-WRITE `37efcd3` and P6-GEN `41dfbd3` merged). Batch 3. Plan: `docs/cms-reviews/P6-PLAN.md` revision 4 (decision 9, owner answer OQ-P6-8) and `P6-BATCHES.json` (item P6-NAV). Migrations owned: none.

## Files

- `components/console/nav/SidebarNav.js`: "Logo and colours" (`/admin/start`) after Editor in the documents storefront group, with the Palette icon. Not admin-only.
- `components/admin/editor/fields/inspectorModel.js`: `design.reset(start = null)` and `design.setToken(brand, key, value, start = DEFAULT_BRAND)`.
- `components/admin/editor/fields/DesignForm.js`: the Reset button, its label and when it shows, the placeholder and hint, the "Change your logo and colours" link, and the null-brand note. DesignForm passes `context` to its controls.
- `components/admin/editor/DocumentEditor.js`: the `startingBrand` prop, handed to EditorView and put in the inspector `context`. Also the carried P5-FIX2 fix in `loadBundles`: an ids= answer that comes in while a full read is out is merged into that read's answer, not replaced.
- `app/(console)/admin/(authed)/editor/page.js`: works out `startingBrand` on a documents store and passes it to DocumentEditor.
- `components/admin/SettingsAdmin.js`: a `documents` prop; on documents stores the logo text hint points at "Logo and colours".
- `app/(console)/admin/(authed)/settings/page.js`: reads `getCmsMode()` inside its tfetch and passes `documents`.
- `app/(console)/admin/(authed)/dashboard/page.js`: "Start your store" in place of "Setup: x/y done" on a documents store that has not started.
- `scripts/test-editor-routes.js`, `scripts/test-editor-inspector.js`, `scripts/test-console-fresh.js`: the tests below.
- `docs/cms-reviews/P6-NAV.md`: this file.

Not touched: `.github/`, `package.json`, migrations, `scripts/test-first-run.js` (owned by P6-FIX1 in this batch, see Design), the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No new dependency. No real or hosted tenant was touched: the only mode change is on test-console-fresh's own local file database.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` (102 of 102) and `pnpm build` (see Tests) |
| Browser verified | NOT DONE. Every acceptance item is proved by a test that fails without the change (31 mutations, all caught). `/admin/start` itself is P6-START-UI's page in this same batch, so a click-through only makes sense once both have merged (owner check) |
| Staging | NOT DONE (owner check) |

## What and why

After the store opens, nothing in the console led back to the brand step, so a founder could not find where to change the logo or the palette (plan mustFix 14). And the design settings' Reset went to the platform's lime default; the owner answered OQ-P6-8 (2026-11-05) that Reset must go back to the store's own starting palette, never lime, with no known-limit fallback.

- **Nav.** A documents store's sidebar (desktop and phone drawer) has "Logo and colours" right after "Editor". Legacy and migrating stores get exactly today's nav.
- **Reset.** In the editor's design settings the button reads "Go back to your starting colours (Forest)" (the store's palette name). Pressing it stores a fresh copy of that palette's brand. It shows whenever the stored brand is not exactly the starting one, a null (platform default) brand included. A first colour, corner or size edit on a store with no brand starts from the starting palette, so it never keeps lime tokens.
- **Words.** The colour placeholder and the "like #…" hint show the starting accent, not `#84cc16`. The null-brand note says "Your store uses the platform's default colours. Go back to your starting colours, or change anything below." The form has a "Change your logo and colours" link to `/admin/start`.
- **Settings.** On a documents store the logo text hint says "Your picture logo is set in Logo and colours. This text is used when there is no picture; the second part renders in your accent color." with a link. Every other store keeps today's hint word for word. A mode that can't be read gives the legacy words, never an error page.
- **Dashboard.** On a documents store that is closed and has not started (no starting store made, or the brand step not recorded), the one setup nudge is "Start your store" to `/admin/start`, in place of "Setup: x/y done", never beside it. Otherwise, today's nudge.
- **Carried from P5-FIX2's review.** Three surviving `loadBundles` mutations are now pinned, and a bundle picked while a focus re-read is out keeps its row when that re-read lands.

## Design

- **The starting palette** is `startingPaletteId(config.onboarding)` from `lib/themes/palettes.js` (P6-PALETTE): the brand step's recorded paletteId (saved or skipped with an earlier pick), else slate. The editor page reads `currentTenant().config.onboarding` inside its existing tfetch callback, the tenant already in context, so there is no extra mode, documents or control-plane read. It passes `{ ...paletteById(id).brand }`, a plain copy, to DocumentEditor.
- **Template-literal imports on the editor page (a deviation from the brief's wording, not its intent).** `lib/tenant-context` and `lib/themes/palettes` are loaded with `import(\`@/…\`)`, the way P6-GEN loads the generator. A static import made test-first-run's "compiled alone" test fail: that test pins the list of files the page compiles to the page itself. test-first-run.js belongs to P6-GEN and is P6-FIX1's file in this batch, so I did not edit it. Both modules are pure and small. If they fail to load, the page logs `editor_starting_brand_failed`, passes `startingBrand = null`, and the form falls back to slate. It is still never lime, and the editor still opens. test-editor-routes gives the palettes module as a stub and pins this (source check and a failure-path test). The page still never imports `lib/first-run/generate.js` statically.
- **DocumentEditor** takes `startingBrand = null` and passes it to EditorView, which puts it in `context` as `startingBrand` (null unless it is an object). SettingsForm hands its props, context included, to DesignForm for the design type, and DesignForm now hands `context` to BrandControl and ThemeControl.
- **inspectorModel `design`:**
  - `reset(start = null)` returns `{ ...start }` for an object, else `null`. So `reset()` is still null, and test-bundle-form, test-media-picker and test-product-editor are unaffected.
  - `setToken(brand, key, value, start = DEFAULT_BRAND)` copies `start` only when the store has no brand yet.
  - `brandView` is unchanged: a null brand still shows the platform default's real values in the inputs.
- **DesignForm:**
  - `startingOf(context)` gives the brand and the palette's name. It uses `context.startingBrand` when it is an object, else `paletteById(DEFAULT_PALETTE_ID).brand`, and finds the name with `paletteIdOfBrand`.
  - `sameBrand` compares key by key; the button shows when the stored brand is not the same.
  - Reset calls `onChange(design.reset(start.brand))`, the same onChange the colour fields use (DesignForm's `set("brand", …)` through `setAt`, so `settings.logo` and the look are kept).
  - The link is a plain `<a href="/admin/start">`, as the form has no next/link today.
- **Settings page:** `getCmsMode().catch(() => null)` inside the existing tfetch. That is one tenant-database query and no extra control-plane row read, so test-console-fresh's row-read counts are unchanged. It passes `documents={mode === "documents"}`. SettingsAdmin uses the new hint only for `documents === true`.
- **Dashboard:** `firstRunNudge(actor)` runs inside the page's existing Promise.all and never throws.
  1. A mode other than documents: no change.
  2. `readBrandStep` (small: the design row and whether the store is open). An open store, or a failed read, keeps today's nudge. No brand step recorded: "Start your store".
  3. Only when the brand step is recorded and the store is closed: `describeFirstStore` (it reads the catalog). Not generated: "Start your store". A failure or `reason: "live"` keeps today's nudge.

  It does not use P6-ONBOARD's checklist step (batch 4).
- **loadBundles merge (carried):** `bundleLate` (a ref) is cleared when a full read starts. The picks effect records each ids= answer it gets for the current read (a row, or null when the answer left the id out). When the full read lands, it adds those rows and ids to its own items and `answered`, and to `bundleAsked`. The `mine === bundleSeq.current` guard now returns before anything is set. Behaviour is otherwise unchanged.

## Acceptance, with evidence

"Fails without": each mutation was applied alone and the named suite run. The helper is `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p6-b2/P6-NAV/helpers/mut.py`; the final log is `.../P6-NAV/mut-final.log`, with 31 of 31 mutations caught.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Unit (test-editor-routes): the documents nav has 'Logo and colours' -> /admin/start; the legacy nav is unchanged | DONE | "P6-NAV rendered: the documents nav has 'Logo and colours' …": the storefront group is in order (`/admin/editor`, `/admin/start`, `/admin/media`, `/admin/releases`), the link is marked current on /admin/start, the item is `{ id, label, href }` with no adminOnly, staff see it, and the desktop sidebar and open drawer both have it. Legacy, null and migrating renders have no such link, and NAV_GROUPS is untouched. The existing "SidebarNav outside documents mode is exactly the legacy nav" test still pins the legacy markup. N1 (no item) and N2 (admin-only) fail it |
| 2 | Rendered (test-editor-inspector, OQ-P6-8): forest in context and a changed accent shows 'Go back to your starting colours (Forest)'; pressing it gives exactly forest; a null brand shows it and gives forest; no startingBrand gives slate; isLimeAccent false for every result; no '#84cc16' placeholder or hint; the /admin/start link shows | DONE | Three "P6-NAV rendered (OQ-P6-8)" tests and "no '#84cc16' placeholder or hint remains …": the button is found in BrandControl's own tree and its onClick pressed. The change arrives through DesignForm's onChange at path `brand` with a brand key-for-key equal to forest, not null and not DEFAULT_BRAND, and the result publishes. Covered: a null brand, no context, a context without startingBrand, and a junk startingBrand (the last three give slate, labelled "(Slate)"). Every result is checked with `isLimeAccent`. Placeholders and hints are checked for the forest and slate accents. A first edit by text input, colour picker or a step starts from the starting palette. Mutations I1, F1, F2, F3, F4, F5, F6, F7 and F8 each fail at least one. The older tests' "platform's default brand" note and "Go back to the platform" label assertions were updated to the new words (the reason is in the test comments) |
| 3 | Unit (test-editor-inspector): reset() still null; reset(forest) deep-equals forest and is a copy; setToken(null, 'radius', step, slate) keeps the slate accent; setToken(null, …) with no start is as today; settings.logo is kept by a brand reset | DONE | "P6-NAV unit: design.reset() is still null …": `reset()`, `reset(undefined)` and `reset("forest")` are null. `reset(FOREST)` has the same keys and values, is not the frozen palette object, and changing it leaves the palette alone. `setToken(null, "radius", "lg", SLATE)` keeps slate's colours and accent_label. With no start, the accent is DEFAULT_BRAND's and the brand matches the old result. A stored brand ignores the start. The logo test is in the forest Reset test (`settings.logo` equals the seeded logo after Reset). I1, I2 (no copy) and I3 fail it |
| 4 | Unit (test-editor-routes): the editor page passes startingBrand = the brand step's palette (forest after a forest pick; slate with no record or a skip with no earlier pick) with modeReads === 1 and docsReads === 1; legacy unchanged; test-editor-shell and test-product-editor pass unchanged | DONE | "P6-NAV rendered: on a documents store the editor page passes startingBrand …": six configs (forest saved, forest skipped, no record, a skip with no paletteId, an unknown id, no config) give forest, forest, then slate four times, none lime, each with reads [1, 1]. `?doc=doc_design` gives the same. If the modules fail to load: null, logged, and the editor still opens. "legacy and migrating editor renders are unchanged": the markup with a forest record equals the plain render, reads [1, 0], and there is no static generator import. E1 (prop dropped) and E2 (always slate) fail it. test-editor-shell and test-product-editor pass in the gate. The existing "modeReads === 1 && docsReads === 1" test (~l.304) still passes |
| 5 | Rendered: SettingsAdmin with documents:true points the logo hint at /admin/start; legacy markup unchanged; the settings page passes documents from getCmsMode and still passes the row-read counts and tfetch walk | DONE | test-console-fresh "P6-NAV rendered: SettingsAdmin with documents: true …": the real SettingsAdmin is compiled with SWC and rendered with the page's real `initial`. `documents` false, undefined, "true", 1 and null all give exactly the no-prop markup, which has today's hint. With true, the hint has the `/admin/start` "Logo and colours" link and the new words, and the whole form differs only in that hint. Page tests: a legacy store gives `documents: false`, a documents store `true` on both instances, and a mode read that fails gives `false` with the page rendering and the row still read. The existing row-read and tfetch-walk tests pass. S1–S5 each fail one or more |
| 6 | Unit: the dashboard on an ungenerated documents store shows exactly one nudge, 'Start your store'; after generation and a brand step it shows today's setup nudge; legacy unchanged | DONE | test-console-fresh renders the real dashboard page on a real local store (tree read, components stubbed). Legacy: one nudge, "Setup: x/y done — not launched yet" to /admin/setup. Documents with nothing made: exactly `[{ /admin/start, "Start your store" }]` on both instances, and no Setup line. A brand step but no starting store: Start. The starting store (written by the real first-run writer) but no brand step: Start. Both: today's Setup nudge on both instances. A recorded skip counts. A mode that can't be read: today's nudge. An open documents store with no brand step: no Start nudge. H1–H5 each fail one or more |
| 7 | pnpm test passes (console-fresh and legacy-routes walks green) | DONE | 102 of 102 suites passed in 231.1 s, exit 0 (log `.../P6-NAV/pnpm-test-final.log`). test-failure-matrix, test-console-fresh (tfetch and tenantHandler walks) and test-legacy-routes (literal-link walk) pass. No new route was added |
| 8 | Unit: the three loadBundles mutations each fail a test; a focus re-read never loses an earlier ids= answer | DONE | "P6-NAV pin (a, answered: want)": a picked `bun-gone` that the ids= answer leaves out reads the "was deleted" words with nothing pending. B-a (`answered: []`) leaves it "Checking this bundle…" and fails. "pin (b)": that pick is asked about once; B-b (bundleAsked from the items only) asks twice and fails. "pin (c)": an older focus read whose held ids= answer (bun-far available) lands after a newer one (bun-far turned off) does not put it back; B-c (guard dropped) fails. "merge, do not replace": bun-q is picked while a focus re-read's ids= is held, and the picks effect's answer comes in first. After the re-read lands, bun-q is still in the list, nothing is pending, and the new card shows its real state; a later re-read keeps it. B-d (replace) fails. The test refs server now takes its answer when asked (before a hold), has a one-shot hold, and an "omit" mode |

## Tests

- `pnpm test`: "Running 102 test suites", 102 of 102 passed in 231.1 s, exit 0. Port-taking suites were pinned to 6140 and 7140 to 7149 (`MIGRATE_DOCUMENTS_TEST_PORTS=7140,7141`, `MIGRATE_DOCUMENTS_TEST_WEB_PORT=6140`, `TEST_MIGRATE_MAP_SQLD_PORT=7142`, `TEST_PRODUCT_CONTENT_PORTS=7143,7144`, `TEST_PUBLISH_PORTS=7145,7146`, `TEST_PUBLISH_SERVICE_PORTS=7147,7148`, `TEST_PUBLISH_UNDO_PORTS=7149`, `SHOPIFY_OAUTH_PORT=6140`). Nothing was left listening.
  - The first full run had one failure, test-first-run's "compiled alone" pin, caused by my static imports on the editor page. Fixed in the page (template-literal imports, see Design), not in that suite.
- `pnpm build`: exit 0. The only warnings are the two existing NFT-trace warnings about `next.config.mjs` via `lib/platform/provision.js`, which this item does not touch.
- New tests:
  - test-editor-routes: 3 (nav, editor page starting brand, legacy unchanged).
  - test-editor-inspector: 9 (section 8).
  - test-console-fresh: 7 (the P6-NAV section, which runs first while the store has never opened, then puts the store back to legacy).
- Edge runtime: no storefront file changed. The console files use no `node:` API, and `lib/themes/palettes.js` (now also loaded by DesignForm in the browser) is pure.

## Known limits

- **`/admin/start` is P6-START-UI's page (same batch).** On this branch alone, the nav link, the DesignForm link, the Settings hint link and the dashboard nudge all point at a page that is not here yet. Merge P6-START-UI with or before this item.
- **The inputs on a null-brand store still show the platform default's real values**, as `brandView` always has (the brief keeps it). Only the placeholder, hint, note and Reset changed. The note now says the colours are the platform default's and offers the way back.
- **If the editor page's two small modules fail to load,** the editor gets `startingBrand = null` and Reset goes to slate, not the recorded palette, and a log line is written. It is never lime.
- **The dashboard's `describeFirstStore` reads the whole catalog,** but only on a closed documents store whose brand step is recorded (each dashboard visit until the store opens). Open stores and stores without a recorded brand step never call it.
- **The "Start your store" nudge and the nav link show for every role that sees them** (the nav item is not admin-only, by the brief). What a staff or support person can do on `/admin/start` is P6-START-UI's.
- **Reset compares brands key by key, exactly.** A stored brand that draws the same as the palette but differs in letter case or an extra key still shows the button. Pressing it stores the palette exactly, which is harmless.
- The Settings hint and the DesignForm link are plain `<a>` links (a full page load), like the rest of those forms.

## Owner checks

- **After P6-START-UI merges, on the design harness or staging, phone and desktop:**
  - "Logo and colours" shows after Editor in the sidebar and the phone drawer, and opens the brand step.
  - In the editor's design settings, change a colour and press "Go back to your starting colours (…)". The palette name matches the one picked in the brand step, and the colours come back.
  - On a store whose brand step was skipped with no pick, it says "(Slate)".
- **Settings on a documents store:** the logo text hint reads well and its link works. On a legacy store it is unchanged.
- **Dashboard on the staging throwaway tenant (OQ-4):** before the brand step, one "Start your store" nudge. After the brand step and generation, the usual "Setup: x/y done". After opening, no "Start your store".

## Commands

```
cd <worktree>
MIGRATE_DOCUMENTS_TEST_PORTS=7140,7141 MIGRATE_DOCUMENTS_TEST_WEB_PORT=6140 TEST_MIGRATE_MAP_SQLD_PORT=7142 TEST_PRODUCT_CONTENT_PORTS=7143,7144 TEST_PUBLISH_PORTS=7145,7146 TEST_PUBLISH_SERVICE_PORTS=7147,7148 TEST_PUBLISH_UNDO_PORTS=7149 SHOPIFY_OAUTH_PORT=6140 pnpm test
pnpm build
node scripts/test-editor-routes.js; node scripts/test-editor-inspector.js; node scripts/test-console-fresh.js
python3 <scratch>/P6-NAV/helpers/mut.py <worktree> [name …]   # the mutation table, every mutation when no name is given
```
