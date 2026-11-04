# P3-DESIGN: the design document in documents mode (TOK-03)

Plan: `docs/cms-reviews/P3-PLAN.md` (critique C3, "theme_pin", "affects", "the doc_design two-admin 409"; batch 4) and `P3-BATCHES.json`. Branch `cms/p3-design`, cut from `0b81097`. No migration. No new dependency. No real tenant changes mode. Nothing under `.github/` changed.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 132.5 s (`TEST_PUBLISH_PORTS=7123,7124 TEST_PUBLISH_SERVICE_PORTS=7125,7126 TEST_PUBLISH_UNDO_PORTS=7127`). `test:design-doc`: 15 passed, 0.9 s in the gate. 20 deliberate breaks, 20 caught (below). `pnpm build` passed |
| Browser verified | Yes, on the design harness from this worktree (`DESIGN_PORT=6120`, `DESIGN_SQLD_PORT=7120`, so 7120 to 7122, `next dev`), desktop Chrome 156 (headless, `playwright-core`), 1440 wide. `scripts/drills/p3/design.mjs`: 26 passed, 0 failed. It drives the console's own API from the signed-in owner's page, not the editor's Design form (that host page is P3-EDITOR's, built in this same batch). Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

TOK-03 says the brand tokens and the theme pin live in a design document that is edited as a draft, previewed, published and undone like any other document. Phase 2 made `doc_design` a thin document type and made the old brand and theme writers refuse on a documents store. Three things were still missing:

1. A way to apply a theme kit on a documents store (it refused with 409).
2. The console readers (onboarding, Help, the agency kit export, brand readability) and the operator screens still read `config.brand` / `config.theme`, the legacy drafts. On a documents store those values are stale: the storefront reads the live `doc_design`.
3. The design publish panel had no way to say what a token change touches.

This item closes all three, adds the `theme_pin` the operator screens read, and adds a guard so no new code reads `config.brand` / `config.theme` outside the legacy branches.

## Design

**1. Kit apply on a documents store** (`lib/themes/kits.js`, `app/api/admin/theme/route.js`).
- `applyKit(kitId, { actor, withPresets, withBrand, documents, revision })` reads the mode fresh. On `documents`, with the documents service handed in, it saves a **draft** of `doc_design` (`settings.theme` = the kit's pin; with `withBrand`, `settings.brand` = the kit's starter brand, else the draft's brand stays) through `service.saveDraft` at `revision` (the founder's, else the one just read), or `createDocument` when the design was never saved. Nothing publishes. The control-plane config is never written. Without the service a documents store still refuses (409, fail closed). `migrating` refuses as before. Legacy is the old code path, unchanged.
- The hero preset goes through `lib/content-writes.js` with the service (a `doc_home` draft). A hero race after the design saved is the existing `HERO_RACE_NOTE`, never "nothing was saved".
- The theme route: GET on a documents store answers the draft's look plus `design: { id, revision, draftHash, editor }`. POST accepts `revision`. A 409 `DOCUMENT_CHANGED` (or `DOCUMENT_EXISTS`) comes back with `current`; a broken draft is 422 with every issue; a database failure is a 5xx (the failure-matrix ordering rule holds).
- `kits.js` stays storefront-safe: the registry and `content-writes.js` are loaded with `import()`, and the service is handed in by the Node route.

**2. The brand API** (`app/api/admin/brand/route.js`). Save and reset on a documents store keep refusing (409 `STORE_USES_DOCUMENTS`), now with `DOCUMENTS_MESSAGE` and the editor's address: "This store publishes with the new editor, so nothing was saved here. Change your brand in the editor: open Brand there, then publish." plus `editor: "/admin/editor?doc=doc_design"`. GET answers the design draft's brand with `documents: true` and `editor`. `PUT {preview}` still stores nothing and now compares against the live design. A `migrating` store keeps the generic moving words.

**3. `theme_pin`** (`lib/documents/after-commit.js`). The one after-commit handler, `themePin`. When a build puts a new `doc_design` version live (publish, Undo, whole-set Undo), it writes `config.theme_pin = { kit, version, applied_at, published_at, release }`, or `null` when the live design has no look of its own (the platform default). It reads the build's own design version, so a build found live after a lost answer pins what actually went live. Best effort: the write runs inside `runAfterCommit`'s try, so a failure is logged (`documents_after_commit_failed`, handler `themePin`) and the publish answer is unchanged. A test seam, `setThemePinWriter`, replaces the control-plane write.

**4. Readers.**
- `lib/admin/brand-readability.js` gains `liveDesign()` (two statements: the live list, then the one `doc_design` version; the preview overlay is never applied) and `storeDesign({ config })` (`liveDesign()` on a documents store, else `kits.draftDesignOf(config)`, the legacy drafts). `brandReadability(brand, { theme })` on a documents store compares with the live design (its brand and look) and answers `documents: true` with real warnings. A legacy store with a v4 pointer still gets the documents marker (unchanged).
- `lib/admin/onboarding.js`: "Pick a theme & brand" is done when the live design has a brand or a look; on a documents store it links to `/admin/editor?doc=doc_design`. A design that can't be read leaves the step open.
- `app/api/admin/help/route.js`: the bundle's `theme` is the live look (`"unknown"` when it can't be read).
- `lib/platform/agency.js`: the kit export's brand is the live design's on a documents store.
- Operator screens: `app/api/platform/overview/route.js`, `themes/route.js` and `tenants/[id]/route.js` read `kits.themePinOf(config)`: `theme_pin` when one was written (including `null`), else the legacy `config.theme`. The tenant detail answer field is renamed `config.theme` -> `config.theme_pin`, and `components/platform/TenantDetail.js` shows it.

**5. The publish panel's `affects`** (`lib/registry/token-usage.js`, `lib/documents/changes.js`).
- `token-usage.js` is pure and edge-safe: `SECTION_TOKENS` (section kind -> token groups: colours, fonts, shapes, spacing, look), `CHROME_TOKENS` (header, footer, announcement bar), `groupsOfRow(words)` (the diff row's first word names its group; "Brand: other settings changed" means every group) and `affectsWords(groups, live)`. The map was made from the renderers: spacing is `py-sf-section` (not the hero, not the product details), shapes are buttons, cards and rounded images, the look is the theme kit's surfaces (the header and the hero).
- `listChanges` for `doc_design`: every row gets `affects`, for example `"Every page: header, footer and announcement bar"`, `"Home page: Hero, Banner and Text"`, `"About us: Text"`. Up to 6 pages are named, then "and N more pages". Live parts are read once per call: the live list, the live bodies (one `IN` statement), and the journal posts when listed. Hidden sections, hidden or offline pages and draft-only sections are left out. When the live parts can't be read, each row says "We couldn't check which parts of your store use this. It still changes everywhere it is used."
- A design that was never published is compared with `emptyBody("design")` (the platform default, which is what shoppers see), so it gives token rows too, never `firstPublish`.

**6. Kits that leave an unpublishable draft** (the batch 1 note on P3-VALIDATE). `kits.publishBlockers(body, id)` runs the publish-mode check and words each blocking issue with its place ("Banner · Button: …"). `unpublishableNote()` turns them into one sentence per document: "The home page was saved as a draft but can't be published yet. Fix this in the editor first: …" (at most 3 problems, then "(and N more)").
- Agency kit apply (`applyAgencyKit`) adds it to `note` and returns `unpublishable: [{ documentId, label, problems }]`.
- Theme kit apply checks the design draft and, when the hero preset was written, the home draft.

**7. The guard** (`scripts/test-design-doc.js`). It scans every `.js`/`.jsx`/`.ts`/`.tsx` under `lib`, `app` and `components`, comments stripped, for `config.brand` / `config.theme` (also `?.`, `["…"]`, `tenantOwnCfg("…")` and `{ brand } = …config`). `theme_pin` and writes (`patchTenant({ config: { brand } })`) are not reads. A self-test proves each form is caught. The allowlist, with a reason per file:

| File | Why |
|---|---|
| `lib/brand.js` | the brand engine; legacy-mode reads (comments only today) |
| `lib/cms/schemas.js` | legacy block schemas (comments only today) |
| `lib/releases.js` | legacy releases snapshot the brand and pin |
| `lib/content/resolve.js` | the legacy draft branch of `resolvedBrand` / `resolvedTheme` |
| `lib/themes/kits.js` | legacy `applyKit`, plus `draftDesignOf` / `themePinOf`, the one place other files read through |
| `app/api/admin/theme/route.js`, `app/api/admin/brand/route.js` | their legacy branches |
| `app/(console)/admin/(authed)/brand/page.js`, `theme/page.js` | the legacy screens, redirected in documents mode by P3-ROUTES |

**8. Reaching the Design surface (the batch 3 note on P3-ROUTES).** On a documents store, `/admin/brand` and `/admin/theme` redirect to `/admin/editor?doc=doc_design` (P3-ROUTES, proved again by this drill). The onboarding step, the brand API's refusal and the theme API's GET all carry that address. The editor's switcher is P3-EDITOR's file; it must list `doc_design` ("Brand") so the founder can reach it from inside the editor (owner check below).

## Acceptance, with evidence

| Item | Status | Evidence |
|---|---|---|
| unit: applyKit on a documents store writes the doc_design draft only (live unchanged); on legacy it behaves as before (test-themes green) | DONE | `test:design-doc` "applyKit on a documents store writes the doc_design draft only…" (pointer, releases, published design and home, control-plane config and `cms_blocks` re-read unchanged) and "applyKit on legacy behaves as before…" (+ migrating refuses). `test:themes` 10/10 and `test:writers` 21/21 green. Fails without the change: break 0 (9 cases fail) |
| unit: a design publish and a design Undo each write theme_pin; a failing pin write does not change the publish result | DONE | "a design publish and a design Undo each write theme_pin…" and "a failing pin write does not change the publish result…" (200, the design live, the log line, the old pin kept). Fails without the change: breaks 2 and 3 |
| unit: two admins saving doc_design at once (design form save and applyKit) give one success and one 409 with current | DONE | "two admins saving doc_design at once…": the documents API `saveDraft` and the theme route's apply, both at revision N, run together in both orders: one 200, one 409 `DOCUMENT_CHANGED` with `current` (revision N+1, `updatedByName`), exactly one write; a stale revision alone is the same 409. Fails without the change: breaks 0 and 1 |
| unit: onboarding, help, agency export and brand readability read doc_design in documents mode; operator screens read theme_pin | DONE | "onboarding, Help, the agency kit export and brand readability read the LIVE doc_design…" (config, draft and live all differ; legacy reads its config), "onboarding … with no published design is not done, even with an old config brand", "the operator screens read theme_pin…" (overview, themes, tenant detail through the real routes; legacy falls back). `TenantDetail.js` is a client component that fetches; it is proved by its source (`t.config.theme_pin`) and the route answer, not rendered. Fails without the change: breaks 7 to 15 |
| unit: the guard finds no config.brand or config.theme read outside the allowlist | DONE | "the guard finds no config.brand or config.theme read outside the allowlist" plus the scanner self-test. Fails when a read is added: break 16; and breaks 10 to 14 |
| unit: listChanges for doc_design lists the changed token rows and the affected live sections in plain words | DONE | "listChanges for doc_design lists the changed token rows and, under each, the live sections…" (exact rows for the look, colours and spacing; hidden and draft-only sections left out; the unreadable case) and "every registered section kind has a token-usage entry…". Fails without the change: breaks 4, 5, 6 |
| drill (harness): design.mjs passes | DONE | `DESIGN_PORT=6120 DESIGN_SQLD_PORT=7120 node scripts/drills/p3/design.mjs`: 26 passed, 0 failed (`docs/cms-reviews/drills/P3-DESIGN/results-design.json`, 4 screenshots). Apply a look and change the accent (drafts; shoppers unchanged), the change list with `affects`, preview (old colours until "show design" is on, then the new accent and glow), publish (shoppers see it; `theme_pin` glow; `config.theme` untouched), Undo (the old look; `theme_pin` back). Through the console API from the signed-in page, not the editor's form |

Brief items outside the acceptance list:
- **Agency and theme kits name what to fix** when they leave a draft unpublishable: DONE ("an agency kit that leaves the home draft unpublishable says so…", breaks 18 and 19). **Insight apply** (`lib/ai/insights.js`) and **experiment adopt** (`lib/experiments.js`) are not this item's files: **NOT DONE** here (owner check / later item).
- **The Design surface reachable from the editor:** the redirects and links are DONE; the switcher listing is P3-EDITOR's (**NOT DONE** in this item).

## Do the tests bite?

`mut/run.py` (in the scratch folder) applied each break alone, ran `test:design-doc`, and put the file back. All 20 were caught:

| # | Break | Caught by |
|---|---|---|
| 0 | applyKit's documents path removed | 9 cases (kit apply, brand GET, two admins, …) |
| 1 | applyKit ignores the founder's revision | two admins, and the stale-revision check |
| 2 | the theme_pin handler not registered | theme_pin cases, operator screens |
| 3 | an after-commit error breaks the publish | "a failing pin write does not change the publish result" |
| 4 | listChanges' design branch removed | listChanges |
| 5 | the hero mapped to spacing | token map, listChanges |
| 6 | hidden sections counted as live | listChanges |
| 7 | `storeDesign` reads the config on a documents store | readers, onboarding |
| 8 | `brandReadability`'s documents branch removed | readers |
| 9 | the onboarding link stays `/admin/theme` | readers, onboarding |
| 10 | Help reads `config.theme` | readers, guard |
| 11 | the agency export reads `config.brand` | readers, guard |
| 12 to 14 | overview, themes and tenant detail read `config.theme` | operator screens, guard |
| 15 | `themePinOf` ignores `theme_pin` | themePinOf, operator screens |
| 16 | a new `config.brand` read added to `lib/admin/settings.js` | guard |
| 17 | the brand refusal loses the editor link | brand API |
| 18, 19 | the agency or theme kit drops the unpublishable note | kits that leave an unpublishable draft |

## Tests

- New: `scripts/test-design-doc.js` (`test:design-doc`, registered by P3-SCAFFOLD): 15 cases, real file databases with every migration, the real console and operator routes with real sessions, the real publish and Undo. 0.9 s in the gate.
- Changed outside this item's list, because this item's required change turns them red (disclosed; the orchestrator should merge them with their owners):
  - `scripts/test-writers.js` (P3-VALIDATE's in batch 1): "kit apply in documents mode is 409" became "…without the documents service is 409 (fail closed); the route saves a doc_design draft and never the config". The refusal half is unchanged.
  - `scripts/test-cms-api.js`: "theme POST (applyKit)" left the documents-mode refusal list (a comment says where it is tested). Its `migrating` refusal check is unchanged.
- Green: `test:themes`, `test:writers`, `test:cms-api`, `test:releases` (the v4-pointer brand marker), `test:failure-matrix` (the catch ordering rule), `test:publish-service` (the after-commit case empties the handler list for its own cases), `test:agency`, `test:editor-routes`.
- Drill: `scripts/drills/p3/design.mjs`, results committed under `docs/cms-reviews/drills/P3-DESIGN/`.

## Known limits

- **The drill does not use the editor's Design form.** `/admin/editor` is still P3-ROUTES' placeholder at this branch's base; P3-EDITOR mounts `DesignForm` in this batch. The drill makes the same API calls the form will make. P3-DRILLS (batch 5) should repeat it through the form.
- **No editor control calls kit apply yet.** `DesignForm`'s look picker changes only the look; its help text says the starter brand and words come from "Apply on the theme screen", which redirects to the editor on a documents store. The theme API now supports it (with `revision`); P3-EDITOR (or a later item) needs an "Apply this look with its starter brand" action that calls `POST /api/admin/theme` with the design's revision, or the help text should change.
- **`theme_pin` lags after a failed write.** A failed control-plane write leaves the old pin until the next design publish or Undo. Only the operator screens read it; the storefront reads the live design.
- **A documents store that never published its design has no `theme_pin`,** so the operator screens show its old `config.theme` (the legacy pin). The P3 harness seed publishes a design, so it has one (`null`). MIG-01 should write `theme_pin` at cutover.
- **`patchTenant` is read-modify-write.** Two design publishes on one store at the same instant could leave the older pin. Rare; the next publish corrects it.
- **The token map is kept by hand.** The test fails when a section kind has no entry, not when a renderer starts using a new token. Product, collection and code-default pages (a singleton still `null` in the live list) are not named, only their documents' sections when published.
- **One extra mode read** on the theme and brand API GETs and on onboarding (`getCmsMode`), and two on a legacy theme apply. The brand and theme GETs fall back to the legacy view when the mode can't be read (as before).
- **`listChanges` for the design** costs 2 to 3 more statements (the live parts).
- **A theme kit's unpublishable check** looks at the design draft and, when the hero preset was written, the home draft. It reports any reason the draft can't publish, including ones the kit didn't cause.
- **Insight apply and experiment adopt** still say nothing when they leave an unpublishable draft (not this item's files).
- Next dev only, Chrome only, headless, macOS, 1440 wide.

## Owner checks

- On a documents test tenant on staging: apply a look, change a colour, preview with "show my new colours", publish, Undo; check the operator overview, themes and tenant detail show the live kit after each.
- Rule on "a design that was never published lists token rows against the platform default" (not "first publish").
- P3-EDITOR: the switcher lists `doc_design` ("Brand"), and decide where "Apply this look with its starter brand" lives in the editor (or change `DesignForm`'s help text).
- MIG-01: write `config.theme_pin` from the live design at cutover.
- Insight apply and experiment adopt: add the "can't be published yet" note (later item).
- Approve the CI sqld download's source and checksum (`.github` was not touched).

## Files

`lib/themes/kits.js`, `app/api/admin/theme/route.js`, `app/api/admin/brand/route.js`, `lib/documents/after-commit.js`, `lib/admin/onboarding.js`, `app/api/admin/help/route.js`, `lib/platform/agency.js`, `lib/admin/brand-readability.js`, `app/api/platform/overview/route.js`, `app/api/platform/themes/route.js`, `app/api/platform/tenants/[id]/route.js`, `components/platform/TenantDetail.js`, `lib/documents/changes.js`, `lib/registry/token-usage.js` (new), `scripts/test-design-doc.js`, `scripts/drills/p3/design.mjs` (new), `docs/cms-reviews/drills/P3-DESIGN/` (results), this packet. Outside the list: `scripts/test-writers.js`, `scripts/test-cms-api.js` (above).

## Commands

```
pnpm test:design-doc
TEST_PUBLISH_PORTS=7123,7124 TEST_PUBLISH_SERVICE_PORTS=7125,7126 TEST_PUBLISH_UNDO_PORTS=7127 pnpm test
pnpm build
DESIGN_PORT=6120 DESIGN_SQLD_PORT=7120 node scripts/drills/p3/design.mjs [--headed]
```
