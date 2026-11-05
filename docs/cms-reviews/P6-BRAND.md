# P6-BRAND: the brand step, server side (GEN-04, US-01)

Branch `cms/p6-brand`, cut from `7506c9e` (`cms/phase-1` with phase 6 batch 1 merged). Both required merges are in its history: P5-FIX2 at `441b44d` and P5-DRILLS at `211c982`. Batch 2. Plan: `docs/cms-reviews/P6-PLAN.md` (decisions 4, 5, 6 and 9, owner answer OQ-P6-8) and `P6-BATCHES.json` (item P6-BRAND, with the batch 0 review items for P6-PALETTE). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Files

All in the item's list:
- `lib/first-run/brand-step.js` (new): `saveBrandStep`, `readBrandStep`, `storeIsOpen`, `canEditDescription`, `BRAND_STEP_WORDS`, `DESCRIPTION_MAX` (160).
- `app/api/admin/brand-step/route.js` (new, `runtime = "nodejs"`): GET and POST.
- `scripts/test-brand-step.js`: the placeholder replaced with the real suite (27 tests). P6-START-UI adds its rendered tests to this file in batch 3.
- `lib/themes/palettes.js`: `paletteIdOfBrand` now compares as the brand draws (`validateBrand(brand).value`); comments on the frozen brands and the lime edges. This is its only import (`../brand.js`).
- `scripts/test-tokens.js`: the P6-PALETTE review items (2 new tests, 2 changed).
- `docs/cms-reviews/P6-GEN-04.md` (new) and this packet.

Not changed: `lib/admin/settings.js` (imported only), `lib/documents/*`, `lib/admin/documents-api*.js`, `package.json`, anything under `.github/`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. `lib/first-run/generate.js` is not imported (P6-GEN builds it in this batch); generated state is seeded with `createFirstRunDocuments` and `designBodyFor`.

Safety: no server was started. Every store was a local file database made by `scripts/support/tenant-fixture.js`, removed at the end of the suite. No store changed mode outside those files, `--hosted` was never passed, nothing went to Typesense, Shopify or Razorpay, and no order was placed. `pnpm test` ran with every port-taking suite pinned to 7120 to 7129 (and 6120 for the web port); nothing listened on them afterwards (`lsof` empty).

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` **102 of 102 suites in 209.9 s** (exit 0, ports pinned); `test:brand-step` 27 passed; `test:tokens` 76 passed; `pnpm build` passes and lists `ƒ /api/admin/brand-step` |
| Browser verified | **NOT DONE.** There is no screen yet: BrandStep and `/admin/start` are P6-START-UI's (batch 3), and the desktop Chrome drill of the brand step is P6-DRILLS stage B. Every acceptance item here is proved by a unit test on the real route |
| Staging | **NOT DONE** |

## What and why

GEN-04: after the first store is generated (GEN-01), the founder gives it their own look in one step: a curated palette, a logo from their library, and a one-line description. US-01 needs this to be possible without the editor. The plan (decision 6) puts colours and logo in the founder-owned `doc_design` draft, so they wait for Publish like every other design change, and puts the description and a record of the step into the control plane in one write. Owner answer OQ-P6-8 needs the record to remember the chosen palette even after a Skip, because the design settings' Reset (P6-NAV) goes back to it.

## Design

### `saveBrandStep({ paletteId, logo, description, skip, revision }, actor)`

**Refusals, all decided before anything is written** (so a refusal writes nothing; the suite compares every content table and the tenant config before and after):

| Case | Answer |
|---|---|
| No control-plane row (the env-fallback store) | 409 `STORE_SETTINGS_READ_ONLY` |
| Body not an object, `skip` not a boolean, `logo` not an object or null, `description` not a string, `revision` not an integer | 400 `BRAND_STEP_UNREADABLE` |
| `paletteId` missing or unknown (`lime`, `toString`, …) | 400 `PALETTE_UNKNOWN`, "Choose one of the colour sets shown…" |
| Legacy store | 409 `STORE_USES_LEGACY`, "This store still uses the current Storefront editor, so nothing was saved here…" |
| Store moving to the new editor | 409 `STORE_MIGRATING` |
| Actor without `storefront.write` (the route refuses first, with 403) | 403 `BRAND_STEP_NOT_ALLOWED` |
| A **changed** description from an actor without `settings.write` | 403 `DESCRIPTION_NOT_ALLOWED`, "Only the store owner or an admin can change the store's description, so nothing was saved…" |
| A changed description over 160 characters once trimmed | 400 `DESCRIPTION_TOO_LONG` |
| A logo the logo kind refuses (another site, another path, a query string) | 422 with the kind's own `LOGO_INVALID` issue |
| A library address whose file is not in the library | 422 `LOGO_NOT_IN_LIBRARY` |
| A stale revision | 409 `DOCUMENT_CHANGED` with `current`, exactly as `saveDraft` refuses it in the documents API |

**Permission.** Palette and logo need `storefront.write` (the documents writes' permission, `canEdit`). The description needs `settings.write`, the permission `PUT /api/admin/settings` requires for `config.site` (`lib/admin/settings.js` builds the patch; the route authorizes `settings.write`). It is checked only when the description would change, so a staff member can save colours with the description left out or sent back unchanged.

**Save (not skip):**
1. The design body is the current `doc_design` draft (or `emptyBody('design')`), with:
   - `settings.brand` = `designBodyFor(paletteId).brand`, a fresh copy. The palette's own brand is frozen and is never handed out or changed;
   - `settings.logo` as asked: `{ media, alt? }`, `null` removes it ("Remove logo"), left out keeps the current one;
   - `settings.theme` kept, or the palette's kit (`{ kit: 'pulse', version: 1 }`) when it is null.
2. It is validated in draft mode first (the logo kind runs here), then the logo file is looked up in `media`.
3. The document is written under the founder's own actor:
   - no design: `createDocument({ type: 'design' })`;
   - else `saveDraft` at the revision the client sent, or the current one when it sent none;
   - a founder-owned draft whose content would not change is not written again (no revision bump for an editor that has it open). A generator-owned one (`updated_by = 'system:first-run'`) is always written, so one click on Save with no change still makes the design the founder's and the generator skips it from then on.
4. Then **one** control-plane write: `patchTenant` (the function the Settings route persists with) with `config.onboarding = { ...latest.onboarding, brand_step: { at, skipped: false, paletteId } }` and, when the description changed, `config.site = { ...latest.site, tagline }`. `latest` is read fresh from the control plane just before the write, never the request's snapshot, so an `onboarding.manual` check-off written meanwhile survives. The tagline goes through `buildSettingsPatch`, the Settings writer's own rule (trimmed, empty is null). A pasted line break becomes a space.
5. If the config write fails after the design was saved, the answer is 503 `BRAND_STEP_PARTIAL` with "Your colours and logo were saved, but your description wasn't. Try saving again." and the design's id and revision. It never says "nothing was saved" when something was, and never reports success when the description was lost. The raw error goes to the log only.

**Skip:** writes no document. One config write: `brand_step = { ...earlier record, at, skipped: true }`, so a `paletteId` an earlier save recorded is kept, and a skip with no earlier save records none (`startingPaletteId` then gives `'slate'`). Anything else in the body is ignored.

**Answer:** `{ ok, skipped, design: { id, revision } | null, liveNow, afterPublish, storeOpen, brandStep }`.
- `liveNow` is `['description']` when the tagline changed.
- `afterPublish` holds `'colours'` when the brand or look changed (or the design was created) and `'logo'` when the logo changed. Each is listed only when the draft was really written.
- `storeOpen` is read before any write.

The step never publishes (a suite test scans the module for `publish` and `generate.js`).

### `readBrandStep({ actor })` and GET

`{ ok, brandStep, palettes: [{ id, label, brand }], current: { paletteId, logo, description }, design: { id, revision } | null, storeOpen, canEditDescription, descriptionMax }`.

`current.paletteId` is `paletteIdOfBrand(draft brand)`, else `DEFAULT_PALETTE_ID` when there is no design at all, else null (the founder's own colours: nothing preselected). `design.revision` lets the screen send `revision` on POST. A legacy or moving store gets the same 409 as a save.

### The route

`GET` needs `storefront.read`; `POST` needs `storefront.write` (requireAdmin also does the CSRF origin check). Both run through `tenantHandler`, so `/api/admin/` reads the store's row fresh. Each `} catch (e) {` answers its own refusals first (`e?.expose` with its status, words, code and `extra`; `e?.issues` as `validationBody`), then `infraResponse(e)`, then a plain 500. A POST is logged (`brand_step_saved`, ids only) and audited (`settings.write` when the description changed, else `storefront.write`). The route and module contain no literal link to the legacy console screens.

### palettes.js (the P6-PALETTE review)

- **paletteIdOfBrand** compares `validateBrand(brand).value` with each palette, the value the storefront draws from. A partial stored brand (`{ accent, background, foreground }`, which the brand kind allows) whose missing keys fill in to the palette's is that palette. A stored `accent_label` is recomputed, so it no longer decides the match. A brand `validateBrand` refuses is null. Because the brand kind refuses unknown keys, an extra key can't be stored; validateBrand drops it, so it no longer stops a match either. The old test lines for those two cases now expect a match.
- **isLimeAccent edges:** pinned with `#c1cf17` (hue 64.57, not lime), `#becf17` (65.54, lime), `#46cf17` (104.67, lime) and `#43cf17` (105.65, not lime). The test checks each colour's real hue too, so rounding can't move a case across the line.
- **#808000 (olive, hue 60): not lime.** It is a yellow-brown, outside the window. Decided here and pinned.
- **Every palette's kit is `pulse-1`,** and `designBodyFor` gives `{ kit: 'pulse', version: 1 }` for each.
- **The frozen brand:** a test shows an assignment to `paletteById('forest').brand` throws and leaves it unchanged. The brand step builds `settings.brand` with `designBodyFor` (a copy), and its suite checks the forest brand is still frozen and unchanged after every save.
- **Glow readability notes:** on the Glow kit, `checkBrand` returns notes (never warnings or errors) for **Slate, Stone, Forest and Clay**: "hero highlight and badge … a darker shade of your accent" for each, and for Forest also the header wordmark (re-measured here: Slate 1, Stone 1, Forest 2, Clay 1, Ink 0, Navy 0). On Pulse, as the P6-PALETTE packet says: Ink 2, Slate, Navy and Stone 1 each, Forest and Clay 0. A founder who switches a palette store to Glow sees these notes. The brand step itself doesn't show checkBrand notes.

## Acceptance

"Fails without the change": on the base, `scripts/test-brand-step.js` is the placeholder and `lib/first-run/brand-step.js` and the route don't exist, so every brand-step test below fails (the import of the route throws). The single mutations listed were each made to the finished code, run, and restored.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Seeded with `createFirstRunDocuments({ docs: [doc_design = designBodyFor('slate')], actor: system:first-run })`, saving `{ paletteId: 'forest', logo: { media: '/api/media/<id>', alt: '' } }` gives a doc_design draft whose brand equals forest, logo set, theme unchanged; updated_by is the merchant; the store stays closed; no release is written | **Done** | test-brand-step "ACCEPTANCE: saving forest with a library logo…": brand deep-equals `{ ...forest.brand }`, logo `{ media, alt: '' }`, theme `{ kit: 'pulse', version: 1 }`, `updated_by = merchant:<owner>`, revision 2, `published_version_id` null, `live_release_id` null, releases and publish_log counts unchanged, `afterPublish ['colours','logo']`, the media library lists the draft as a use of the logo. The logo is a real file saved with `saveMedia` |
| 2 | A following `createFirstRunDocuments` call with a slate design skips doc_design with reason 'founder', and forest stays | **Done** | "ACCEPTANCE: a following createFirstRunDocuments call…": `skipped [{ id: 'doc_design', reason: 'founder' }]`, `written false`, settings unchanged. Also "Save with no change on a generated slate store (one click)…": the founder takes the design over with no content change, and the generator skips it. Mutation: not writing an unchanged generator-owned draft fails that test |
| 3 | The description writes config.site.tagline and brand_step in one config write, and an onboarding.manual check-off written just before survives; skip records skipped:true and leaves the seeded slate design intact (resolvedLogo null after publishing it) | **Done** | "ACCEPTANCE: the description writes…": the save runs inside a tenant snapshot taken **before** the check-off was written; a spy on the control plane's client counts exactly 1 write to `tenants`; the tagline is trimmed, `site.name`, `site_url` and `onboarding.manual` are kept. Mutations: merging into the request's snapshot (check-off lost) fails it; two `patchTenant` calls fail it. "ACCEPTANCE: skip records skipped:true…": the design row deep-equal before and after, record keys `['at','skipped']`, then `doc_home` + `doc_design` published and `resolvedLogo()` is null in a simulated shopper request (and `resolvedBrand` is slate) |
| 4 | Saving 'forest' then skipping leaves brand_step `{ skipped: true, paletteId: 'forest' }` and `startingPaletteId(config.onboarding) === 'forest'`; a skip with no earlier save records no paletteId (startingPaletteId gives 'slate') | **Done** | "ACCEPTANCE: saving forest then skipping…" (a skip sent with `paletteId: 'ink'` still writes no document and keeps forest) and the skip test above (`startingPaletteId` 'slate'). Mutation: a skip that drops the earlier record fails it |
| 5 | logo:null removes an existing logo; GET preselects 'slate' for a generated slate draft and DEFAULT_PALETTE_ID when no design exists | **Done** | "ACCEPTANCE: logo:null removes an existing logo…" (`afterPublish ['logo']`; leaving logo out keeps it, `afterPublish ['colours']`), "GET on the generated slate store preselects slate…", "ACCEPTANCE: GET with no design preselects DEFAULT_PALETTE_ID; a founder's own colours preselect nothing; a partial brand that draws like a palette is preselected" (`{ accent, background, foreground }` of navy preselects navy) |
| 6 | An https logo URL, an unknown paletteId and a legacy tenant are refused with nothing written; a stale revision returns 409 and does not overwrite a concurrent editor save; a staff actor without the settings permission sending a changed description gets 403 and nothing is written | **Done** | "ACCEPTANCE: an https logo address…" (4 addresses, 422 `LOGO_INVALID`, storage and config byte-identical), "ACCEPTANCE: an unknown paletteId…" (7 bodies, 400), "ACCEPTANCE: a legacy tenant…" (POST save, skip and description, and GET: 409 `STORE_USES_LEGACY`), "ACCEPTANCE: a stale revision…" (a staff editor's `saveDraft` lands first; the POST with the old revision is 409 `DOCUMENT_CHANGED` with `current.revision`, storage unchanged including config, the editor's brand stands), "ACCEPTANCE: a staff actor…" (403 `DESCRIPTION_NOT_ALLOWED`, nothing written; the same staff member's save with the description unchanged goes through). Also: a missing library file (422), a moving store (409), support and signed-out actors (403, 401). Mutations: ignoring the client's revision fails the stale test; dropping the description permission fails the staff test; dropping the library check fails its test |
| 7 | Every palette saved through the step passes the design type's publish rules (checkBrand 0 errors); the route passes the failure-matrix, console-fresh and legacy-routes walks; pnpm test passes | **Done** | "ACCEPTANCE: every palette saved through the step…": each of the six saved through the route, then `validateDocument(draft, { mode: 'publish' })` ok with no errors and `checkBrand(brand, { kit })` 0 errors, and GET preselects it. test-failure-matrix 125 passed, test-console-fresh 19, test-legacy-routes 29 (and test-design-doc, test-writers, test-api-shapes). Mutation: a `slog` before `infraResponse` in the POST catch fails the failure-matrix walk. **What the walks cover:** the console-fresh tenantHandler walk reads the route's source (the route uses `tenantHandler` for both methods; the store lookup itself is in the lib module, which that walk doesn't read); the console-fresh tfetch walk only covers `app/(console)` pages, and this item adds none; the legacy-routes href walk covers `components/admin` and `lib/admin` only, so it doesn't reach this route or `lib/first-run/`. test-brand-step's own convention test checks both files for those links. `pnpm test`: 102 of 102 |
| 8 | Unit: lime hue edges pinned; every palette on pulse-1; a partial brand equal to a palette is preselected; the frozen palette brand is never mutated | **Done** | test-tokens "isLimeAccent: hue edges pinned…" (mutation: a 66–104 window fails it), "PALETTES: …" now checks every palette's kit (mutation: Ink on glow-1 fails it), "paletteIdOfBrand: each palette finds itself as it draws…" (the old strict function fails it, as does the import check), "the frozen palette brand can't be changed in place…", and in test-brand-step the forest brand stays frozen and unchanged after every save |

## Tests

- `node scripts/test-brand-step.js`: 27 passed, about 1 s. It cleans up its own `.test-bs-*` files.
- `node scripts/test-tokens.js`: 76 passed (74 before).
- `pnpm test`: 102 of 102 suites, 209.9 s, exit 0, with `TEST_PUBLISH_PORTS=7120,7121`, `TEST_PUBLISH_SERVICE_PORTS=7122,7123`, `TEST_PUBLISH_UNDO_PORTS=7124`, `TEST_PRODUCT_CONTENT_PORTS=7125,7126`, `TEST_MIGRATE_MAP_SQLD_PORT=7127`, `MIGRATE_DOCUMENTS_TEST_PORTS=7128,7129`, `MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120`, and `CHECKOUT_MODE` unset.
- `pnpm build`: passes.

Mutations run against test-brand-step (each fails exactly the test named in the acceptance table): the config merged into the request's snapshot; two control-plane writes; Skip dropping the earlier record; no description permission; the client's revision ignored; no library check; the theme replaced by the palette's kit; an unchanged generator-owned design left with the generator.

## Known limits

- **The description is public at once (OQ-04).** `config.site.tagline` has no draft, so on an open store shoppers see it straight away while colours and logo wait for Publish. The answer says so (`liveNow`). On a closed store the pages don't show it: StoreClosed shows only the name, and the closed metadata is neutral.
- **The manifest shows the description on a closed store (found here, not fixed: not this item's file).** `app/manifest.webmanifest/route.js` answers `description: siteTagline()` whatever the store's state. The closed layout doesn't link the manifest, but `/manifest.webmanifest` opened directly on a closed store shows the description. This was already true of a Settings tagline; the brand step asks for a description before opening, so it matters more now. The founder-facing line "Nothing shows to shoppers until you open your store" (P6-START-UI) is true of the pages, not of that file. Suggested follow-up: neutral manifest description while `isStoreClosed()`, tested beside test-release-readers' closed-manifest test.
- **The one config write is not compare-and-swap.** `patchTenant` reads the row and writes it back with a shallow merge. The brand step reads the latest config just before calling it, so a check-off written before the save is kept (tested). A check-off written in the few milliseconds between that read and the write can still be lost, and the same is true the other way round: `markManualStep` (lib/admin/onboarding.js) merges into the request's snapshot of `config.onboarding`, so a check-off saved at the same moment as a brand-step save can drop the new `brand_step`. Neither file can change this without a compare-and-swap in `patchTenant`.
- **A design write then a config write.** These are two databases, so they can't be one transaction. A config failure after the design was saved answers 503 `BRAND_STEP_PARTIAL` in words that say what was saved (not reached by a test: the control plane can't be made to fail on its second statement only without a hook in control.js).
- **`revision` is optional on POST.** Without it the step saves at the draft's current revision, replacing only brand and logo (the look and anything else in the draft are kept). With it (`GET` gives `design.revision`), a concurrent editor save is a 409 and is never overwritten. P6-START-UI should send it.
- **No checkpoint per save.** `saveDraft` writes a version only when a checkpoint is due, so a brand-step save may not add an entry to "Earlier versions". That is saveDraft's normal rule.
- **The logo file must exist in `media`.** An archived file still counts as in the library.
- **Readability notes are not shown by the step.** On Glow, Slate, Stone, Forest and Clay carry `checkBrand` notes (never warnings or errors); see the palettes section.

From review:

- Closed-store leak, already there before this branch and not caused by it: app/manifest.webmanifest/route.js answers `description: siteTagline()` even when the store is closed. Anyone who opens /manifest.webmanifest on a closed store can read the description the founder typed in the brand step. The closed layout doesn't link the manifest, so a shopper's browser never fetches it on its own. Settings taglines already had this problem, so it is not a regression. The brand step makes it more likely, because it asks for a description before the store opens. The brief's own known limit ('nothing leaks while closed') is not quite true. The builder found this and wrote it up honestly in P6-GEN-04.md and P6-BRAND.md. A follow-up item that owns the manifest should answer a neutral description while isStoreClosed() is true, with a test.
- Retry after a partial failure: when the design saves but the config write fails, the step answers 503 BRAND_STEP_PARTIAL. If the client then retries with the revision it sent first, the design is unchanged and founder-owned but the revision is stale, so saveDraft refuses it with 409 DOCUMENT_CHANGED. A retry that does go through answers afterPublish [] because the draft did not change, so the screen would not say that colours show after Publish. No test covers this path. The 503 answer does carry design.revision, so P6-START-UI should retry with that revision.
- No test pins the rule that settings.brand is built from a copy. Mutation M14 (`brand: want.palette.brand`, the frozen object itself) left all 27 tests in test-brand-step passing. Nothing downstream changes the object today, so nothing breaks. A test asserting `settings.brand !== paletteById(id).brand`, or that a saved body can be changed safely, would pin it.
- Mutation M8 (removing the module's own storefront.write check, canEditDesign) left all tests passing, because the route refuses with requireAdmin first. That makes the module check a second guard that nothing tests. Only a direct caller of saveBrandStep would depend on it.
- Small edge case: the description goes through oneLine before it is compared with the current tagline. A tagline stored earlier with a line break in it therefore counts as changed even when the founder sends it back as it is. If it is over 160 characters, that gives a 400. Settings uses a single-line input, so this is unlikely to happen.
- Small ordering point: on a legacy store, a body with an unknown palette gets 400 PALETTE_UNKNOWN instead of 409 STORE_USES_LEGACY, because the input is checked before the store mode. Nothing is written either way.
- Verified, so not findings: the reviewed commit bcf03b8 has both P5-FIX2 (441b44d) and P5-DRILLS (211c982) in its history. The diff touches only the item's own files plus its P6-BRAND.md packet, and nothing under .github. pnpm test passed 102 of 102 suites in 204 s, with every port-taking suite pinned to 6320 and 7320 to 7329. test-brand-step passed 27 and test-tokens passed 76. 13 of 15 mutations were caught: dropping the earlier paletteId on skip, merging into the stale request snapshot, the description permission, the library check, keeping the theme, keeping a logo that was left out, the 160 limit, storeOpen, afterPublish, writing an unchanged description, the GET default palette, the raw paletteIdOfBrand compare, and the one-line rule. patchTenant re-reads the row and merges the top-level keys, and the step sends the whole onboarding and site objects from a fresh read, so a manual check-off written just before survives. The 403 and other refusals are all decided before anything is written. palettes.js imports only lib/brand.js, which has no imports, so it stays edge-safe. The route is nodejs, and its catch blocks follow the failure-matrix order. The worktree was removed and nothing was left listening on my ports.

## Owner checks

- **The brand step end to end in Chrome** (P6-DRILLS stage B, once P6-START-UI exists): six palettes, Save with no change, Remove logo, Skip, and the "shows now / after you publish" words on an open store.
- **Decide the manifest follow-up:** should `/manifest.webmanifest` hide the description on a closed store (a later item's file), or is it acceptable that a directly opened manifest shows it?
- **Staff and the description:** staff can change colours and the logo here but not the description (it is a Settings field). Confirm that split is what you want.
- **#808000 (olive) is not lime:** confirm, or ask for the lime window to start lower.
- **CI sqld download:** unchanged; its source and checksum still need your approval. Nothing under `.github/` was touched.

## Commands

```
node scripts/test-brand-step.js
node scripts/test-tokens.js
pnpm test
pnpm build
```
