# P3-FIX4: batch 4 review findings (rich text pastes, theme_pin, design panel, first design publish, writers' notes)

Requirements: TOK-03, AU-01, PUB-02, PUB-05. Branch `cms/p3-fix4`, cut from `cms/phase-1` at `7113534`.

This item fixes the "From review" findings in `P3-DESIGN.md`, `P3-RTE.md` and `P3-FIX3.md` that no other batch 5 item owns. No tenant changes mode. Legacy tenants, today's releases, the legacy editors and preview behave as before: the legacy save path keeps its strict reading of pasted HTML word for word, and `sanitizeHtml` (what every storefront renders through) is unchanged. No migration. No new dependency. Nothing under `.github/` or `package.json` changed.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` 81 of 81 suites in 137.3 s; `pnpm build` passes (its one Turbopack NFT warning about `lib/platform/migrate.js` was there before this item) |
| Browser verified | NOT DONE. Every acceptance line is a unit line and is proved by a test that fails without the change (see "Mutations"). The paste in Chrome belongs to P3-DRILLS (see Known limits: `scripts/drills/p3/rte.mjs` step 7 must change) |
| Staging | NOT DONE (owner check) |

## What and why

### Shopper- or data-facing (blockers for this item)

1. **A web page's paste is cleaned on save, not refused** (owner default, option b). `lib/sanitize.js` `visibleText` gets a `webPaste` reading, used only by the documents editor's cleaner (`lib/registry/text.js` `lostBySanitizing` passes `{ webPaste: true }` to `wordsLostBySanitizing`):
   - A web page's own element (a tag name with a hyphen, such as `<product-info id=…>`, `<relative-time datetime=…>`, `<cart-drawer>`) counts as markup, with or without attributes. The sanitizer already unwraps unknown tags and keeps their children, so the paste saves with its visible text, and the elements are gone.
   - A whole `<noscript>…</noscript>` counts as never shown (every browser that opens the store runs scripts), so it is dropped with its content, as the sanitizer already did.
   - Every existing refusal for real text loss stays: `<founder>`, "the `<link>` below", `<b required>`, stray `<`/`>` signs, an unclosed `<noscript>`, an unclosed `<product-info>` with no attributes and nothing closing it (it could be somebody's words), and a valueless word on a hyphenated tag (`<sale-ends soon>`). A valueless attribute on such a tag counts only when it reads as one (it has a hyphen, like `defer-hydration`, or is a known valueless attribute like `hidden`).
   - **Legacy is unchanged.** `lib/cms/store.js` calls `wordsLostBySanitizing` without `webPaste`, so the legacy page editor still refuses these pastes (its own AU-05 suite, `test-page-editor`, pins `<noscript>Important founder words</noscript>` as lost words and stays green). `sanitizeHtml` itself is not touched, so storefront rendering is byte-identical.
2. **The refusal words name the tag.** `lib/registry/text.js` (`wordsLostMessage`, exported) and `lib/cms/store.js` say "This usually comes from < or > signs" only when the lost words hold no tag. When they hold one (`<shop class="x">`, `<founder>`), the words name it: "They come from a `<shop>` tag this page can't show, often hidden in pasted text. Open Edit as HTML to see it and remove that tag, or reword it if you typed it, then save again." The legacy copy names the tag without "Edit as HTML" (the legacy box already shows the HTML). A tag name longer than 24 characters is quoted short, so the message stays under the legacy suite's length limit. "`<priya@store.com>`", "`<tel:9876543210>`" and "`<500 and >`" are not tags and keep the old words.
3. **Rescue is off in Edit as HTML** (`RichTextField.js`). The code was already right (`rescue = mode === "edit" && …`); the RTE reviewer's surviving mutation (`!locked && …`) is now caught. A `sourceOpen` prop sets how Edit as HTML first renders (tests; hosts leave it off), the same pattern as FIX3's `drawerOpen` and `confirmingId`.
4. **theme_pin is a targeted write** (`lib/documents/after-commit.js` `writeThemePin`). The whole-row `patchTenant` (read the row, write every column back) is replaced by one statement: `UPDATE tenants SET config = json_set(…, '$.theme_pin', json(?)), updated_at = ? WHERE id = ?`. A settings or secrets save landing at the same moment is never overwritten. `null` is written as JSON null, never removed, because `kits.themePinOf` reads a missing pin as "never published" (falls back to the legacy pin). After the write, this instance's cached tenant is refreshed (`getTenant(id, { fresh: true })`), as `upsertTenant` did by busting its cache.
5. **A slow platform database can't fail a live publish** (`runAfterCommit`). Each after-commit handler gets `AFTER_COMMIT_TIMEOUT_MS` (2,500 ms). One that takes longer is logged (`documents_after_commit_timeout`, with the handler's name and the wait) and left to finish; if it fails later, that is logged as `documents_after_commit_failed`. The publish answers success. `setAfterCommitTimeout(ms)` is a test seam.

### Founder-facing

6. **The design panel's "affects" rows** (`lib/documents/changes.js` `liveParts`): the code was right; it is now pinned. An offline page and a turned-off announcement bar are never named, both in `liveParts()` and in `listChanges` rows for `doc_design`.
7. **A corrupt live design version throws** (`lib/admin/brand-readability.js` `liveDesign`): the code was right; it is now pinned for a body that isn't JSON, a body of `null` and a missing version, through `liveDesign` and `storeDesign`.
8. **The theme route's partial failure** (`app/api/admin/theme/route.js`). When the `doc_design` draft saved and the hero preset then failed for a reason other than a race (a database error), the answer was 500 "…so nothing was saved". The route now watches the documents service it hands to `applyKit` (`watchDesignSave`: it notes a successful `saveDraft` of `doc_design` or `createDocument` of a design). A failure after that is answered 200 `ok: true`, `heroApplied: false`, `applied.presets: []`, the saved design's revision, and the note "Your new look was saved as a draft. The hero look wasn't added, because something went wrong on our side. Apply the look again in a minute to add it, or change the hero in the editor." It is logged as `theme_hero_failed`. A failure before the design saved still goes to the catch, unchanged. The partial answer is made outside the `catch (e)` block (a `.catch` on the `applyKit` promise), so the failure-matrix rule "own refusals, then the database check, then the fall-back" still holds.
9. **A first design publish offers no Undo.** Since P3-DESIGN, `listChanges` for `doc_design` never says `firstPublish` (its rows compare with the platform default), so the publish panel offered an Undo that could only answer `FIRST_VERSION_MESSAGE`. Now:
   - `listChanges` for a never-published `doc_design` adds `neverPublished: true` (`lib/documents/changes.js`). The rows are unchanged.
   - `publishModel.changeListOf` keeps the flag, and the flow records the document as a first version (`firstPublish[id]` is true when `firstPublish` or `neverPublished` is), so `outcomeOf` gives `undo: null` and the first-version note, as for any singleton's first publish.
   - Recently published already answered `canUndo: false` for that row (`undo.js` `planOf` gives `nothing` for a singleton's first publish); this is now pinned on the real server.
   - Shape: `neverPublished` is an optional key of `listChanges.outcomes.ok` in `lib/admin/documents-api-shapes.js` (it is in the example, so its type is known). `test-api-shapes` checks the listing.
10. **Insight apply and experiment adopt say when the draft can't be published** (the P3-VALIDATE direction; `lib/ai/insights.js`, `lib/experiments.js`). In documents mode, after the draft is saved, each draft it wrote is checked in publish mode (`validateDocument` with `mode: "publish"`; edge-safe, so `experiments.js` stays on the storefront path). When one would be refused, the answer's `note` says, as a kit apply does: "The home page was saved as a draft but can't be published yet. Fix this in the editor first: Hero · Title: … Until then it is saved as a draft only." It also carries `unpublishable: [{ documentId, label, problems }]`. A publishable draft keeps the plain note. Legacy is unchanged.
11. **A set dry-run Undo through the real handler** (`scripts/test-publish-undo.js`), the FIX3 reviewer's probe, kept as a test: `createUndoFlow` runs through the real client (`createDocumentsApi`) into `handleDocumentsPut` on the `sets` store (page X published alone, then edited, then X and a new page Y as one set). Both ways the editor builds the set target (the publish answer through `outcomeOf`, Recently published through `recentGroupsOf`) give "Undo all 2 pages of this publish? “Fix4 Y” goes offline.", every dry run answers 200 (no 428), storage is unchanged by them, an autosave on X doesn't change the confirm, and Confirm runs the real `undoSet` (X back to its first version, Y offline).

## Design notes

- **Two readings of pasted HTML, one sanitizer.** The documents editor cleans what a browser wouldn't show; the legacy editors keep the stricter AU-05 reading. Both compare against the same `sanitizeHtml` output, so nothing a shopper sees changes, only which saves are refused.
- **The theme route watches, not guesses.** Re-reading the design after an error could not tell a save from a colleague's; the wrapper records the save this request made.
- **`neverPublished` instead of `firstPublish: true`** for the design keeps P3-DESIGN's token rows and their "affects" lines (the owner ruling on that list is still open) and only changes what Undo offers.

## Acceptance, with evidence

| Item | Status | Evidence |
|---|---|---|
| unit: the reviewer's custom-element and noscript pastes save cleaned with their visible text; refusal words name the tag; legacy sanitize tests unchanged | done | `test-rich-text.js`: "P3-FIX4 unit: the reviewer's custom-element and `<noscript>` web pastes are saved cleaned…" (the three reviewer pastes plus the no-attribute probe, each tag left alone, and `<cart-drawer … defer-hydration hidden>`: saved through `saveDraft`, stored equal to `sanitizeHtml`, visible words kept, no hidden markup stored); "P3-FIX4 unit: real text loss is still refused, and the refusal words name the tag and Edit as HTML" (6 still-refused cases name the tag; stray signs keep the old words; the legacy reading still refuses the pastes; the legacy words name the tag without Edit as HTML and the `<500 and >` words are word for word); "rendered+driven: a refused web-page paste offers Edit as HTML…" now uses pastes that are still refused; "P3-FIX4 rendered: in Edit as HTML a refusal shows no rescue words…". Legacy: `test-page-editor` (AU-05, 36 refused cases including `<noscript>` words), `test-security`, `test-content` pass unchanged. Fails without the change: see Mutations 1–6 |
| unit: theme_pin is written with a targeted update (null for a design with no theme), a concurrent config write survives, a hanging handler does not fail the publish | done | `test-design-doc.js`: "P3-FIX4 unit: a design published with settings.theme null writes theme_pin null…" (the reviewer's `!pin` edit fails it); "…the theme_pin write is a targeted json_set; a settings and secrets save landing during the publish survives" (a real `patchTenant` of a setting and a secret is run before every control-plane statement of the publish; the old whole-row write loses the one between its read and write, and fails); "…a hanging after-commit handler times out; the publish answers success and the timeout is logged" (100 ms wait, a writer that takes 4 s, the answer in under 3 s) |
| unit: liveParts never names offline pages or a hidden bar; a corrupt live design throws; the theme route's partial failure says the design was saved | done | `test-design-doc.js`: "P3-FIX4 unit: liveParts and the affects rows never name an offline page or a turned-off announcement bar" (About taken offline, the bar turned off and published, then everything put back); "…a corrupt or missing live design version makes liveDesign and storeDesign throw…"; "…a kit apply whose design saved but whose hero write failed says the design was saved and the hero look was not" (a trigger makes the `doc_home` write fail; it failed on the base with "Something went wrong on our side, so nothing was saved") |
| unit: a first design publish offers no Undo; insight apply and experiment adopt name what makes the draft unpublishable | done | `test-publish-ui.js` "P3-FIX4 unit: a first design publish offers no Undo (neverPublished)…" (the flow, the outcome, the rendered panel, a later design publish keeping Undo, and Recently published's row); `test-design-doc.js` listChanges test: a never-published design says `neverPublished: true`, Recently published's first design row has `canUndo: false, undo: null`, a published design has no flag. `test-writers.js` "P3-FIX4 documents: insight apply and experiment adopt that leave an unpublishable draft say so…" (an empty hero title by insight and by adopt, a bar turned on with no words; a publishable bar says nothing of it) |
| unit: a set dry-run undo passes through the real handler | done | `test-publish-undo.js` "P3-FIX4 unit (real handler): a set dry-run Undo from the editor passes createDocumentsApi and handleDocumentsPut…". Dropping the member dry run's revision in `publishModel.js` (a 428 from the real handler) fails it |
| unit: pnpm test passes | done | 81 of 81 suites in 137.3 s with `PORT=6120 DESIGN_PORT=6120 DESIGN_SQLD_PORT=7126 SHOPIFY_OAUTH_PORT=7127 TEST_PUBLISH_PORTS=7120,7121 TEST_PUBLISH_SERVICE_PORTS=7122,7123 TEST_PUBLISH_UNDO_PORTS=7124`. `pnpm build` passes |

### Mutations

18 one-line mutations, each applied alone with a runner in the scratch folder (not committed), each run against its suite. All 18 were caught:

1. `lostBySanitizing` with `webPaste: false` (rich-text)
2. `<noscript>` content counted as shown (rich-text)
3. custom elements not counted as markup (rich-text)
4. the old "< or >" words always, documents (rich-text)
5. the old words always, legacy (rich-text)
6. rescue on in Edit as HTML, the RTE reviewer's survivor (rich-text)
7. `if (!pin) return;`, the DESIGN reviewer's survivor (design-doc)
8. the whole-row `patchTenant` back (design-doc)
9. no timeout around the handler (design-doc)
10. the offline-page filter in `liveParts` removed, a DESIGN survivor (design-doc)
11. the bar listed when off, a DESIGN survivor (design-doc)
12. a corrupt live design answered as the platform default, a DESIGN survivor (design-doc)
13. the hero failure rethrown into the catch (design-doc)
14. `neverPublished` not sent (design-doc)
15. `neverPublished` ignored by the publish flow (publish-ui)
16. insight apply's plain note always (writers)
17. adopt's plain note always (writers)
18. a member dry run sent without its revision (publish-undo, real handler)

## Tests

| Suite | Time (in `pnpm test`) | New or changed |
|---|---|---|
| `test:rich-text` | 0.5 s | 3 new tests; the web-paste rescue test now uses pastes that are still refused (the reviewer's pastes now save) |
| `test:design-doc` | 1.1 s | 7 new tests; the listChanges test checks `neverPublished` and Recently published's first design row |
| `test:publish-ui` | 0.5 s | 1 new test |
| `test:writers` | 0.8 s | 1 new test |
| `test:publish-undo` | 1.9 s | 1 new test (real handler) |
| `test:api-shapes` | 0.4 s | unchanged; checks the new optional key |

## Known limits

- **`scripts/drills/p3/rte.mjs` step 7 now fails as written.** It expects the `<product-info>` paste to be refused with `WORDS_LOST` and then fixed in Edit as HTML. That paste now saves cleaned. The file belongs to P3-DRILLS, whose brief already says to drill the clean-on-save if this item merges first. Until then the drill's step 7 is out of date, not a regression. The Edit as HTML way out still works for a paste that is still refused (for example `<shop class="x">…</shop>`).
- **A lone, unclosed web element with no attributes is still refused** (`<product-info><p>Ships</p>` with no `</product-info>`), because it could be somebody's words ("`<re-order>`"). The words now name the tag and Edit as HTML. A paste copied from a page always holds both tags, so this needs a hand edit first.
- **`<noscript>` text is now treated as never shown in the documents editor.** A founder who typed words inside a `<noscript>` in Edit as HTML loses them on save without a refusal. Shoppers never saw them either. The legacy editors still refuse it.
- **A concurrent whole-row `patchTenant` can still overwrite the pin.** The pin write no longer overwrites others' saves, but an operator's or founder's settings save that read the row before the pin and writes it after still puts the old pin back (the operator screens then lag one design publish). Making every control-plane write targeted is outside this item's files (`lib/platform/control.js`).
- **A timed-out pin write keeps running in the background.** On a serverless host it may be cut off when the function ends; the old pin then stays until the next design publish (logged either way).
- **The theme route's partial answer covers any failure after the design saved.** A deliberate refusal from the hero write (for example the cart lock) is also answered "the hero look wasn't added, because something went wrong on our side", which is true about what was saved but vague about why. Today `applyKit` only rethrows non-race errors there.
- **The design that was never published and matches the platform default still lists nothing to publish** (P3-DESIGN's open owner ruling). This item changed only what Undo offers.
- **`unpublishable` notes are advice.** A draft that can't be read back after the save is left out of the note, as the agency kit does.
- **Two copies of the refusal words** (`lib/registry/text.js` and `lib/cms/store.js`), as before: the registry must not import the database layer.

## Owner checks

- **Desktop Chrome, in the editor** (P3-DRILLS or the owner): paste a product description copied from a live Shopify page into a rich text field and save; the words, bold and links come through, and the store shows them. Paste `<shop class="x">…</shop>` in Edit as HTML: the refusal names `<shop>` and Edit as HTML.
- **Rulings:**
  - option (b) as built: hyphenated elements and whole `<noscript>`s are cleaned in the documents editor only; legacy stays strict;
  - the refusal words that name the tag (both copies), and the hero-failed note on the theme route;
  - the "can't be published yet" notes on insight apply and experiment adopt.
- **Hosted staging (Turso):** a design publish writes `config.theme_pin` with the targeted update; a slow platform database (or a 3-second delay) leaves the publish answer a success with `documents_after_commit_timeout` logged.
- **CI:** the sqld download in CI still needs the owner's approval of its source and checksum. Nothing under `.github/` was touched.

## Files

`lib/sanitize.js`, `lib/registry/text.js`, `lib/cms/store.js`, `components/admin/editor/fields/RichTextField.js`, `lib/documents/after-commit.js`, `lib/documents/changes.js`, `app/api/admin/theme/route.js`, `components/admin/editor/publish/publishModel.js`, `lib/ai/insights.js`, `lib/experiments.js`, `lib/admin/documents-api-shapes.js`, `scripts/test-rich-text.js`, `scripts/test-design-doc.js`, `scripts/test-publish-ui.js`, `scripts/test-writers.js`, `scripts/test-publish-undo.js`, and this packet.

Unchanged though listed: `lib/admin/brand-readability.js` (already right; pinned), `lib/documents/undo.js` (Recently published was already right; pinned), `scripts/test-api-shapes.js` (it already checks every optional key the shapes list). No `package.json`, lockfile or `.github/` change. No `node:` import in edge code (`lib/sanitize.js`, `lib/registry/text.js`, `lib/experiments.js` and what they import; `test-writers` checks the last).

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:rich-text && pnpm test:design-doc && pnpm test:publish-ui && pnpm test:writers
TEST_PUBLISH_UNDO_PORTS=7124 pnpm test:publish-undo
PORT=6120 DESIGN_PORT=6120 DESIGN_SQLD_PORT=7126 SHOPIFY_OAUTH_PORT=7127 TEST_PUBLISH_PORTS=7120,7121 TEST_PUBLISH_SERVICE_PORTS=7122,7123 TEST_PUBLISH_UNDO_PORTS=7124 pnpm test
pnpm build
```

No server, sqld or proxy was left running. Ports 6120 and 7120 to 7129 are free.
