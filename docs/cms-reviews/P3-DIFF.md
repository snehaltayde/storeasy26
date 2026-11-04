# P3 · DIFF · What changed, in plain words

Branch `cms/p3-diff`, cut from `407b88a`. Plan: `docs/cms-reviews/P3-PLAN.md` (critique C2, batch 1) and `P3-BATCHES.json`. Requirements it serves: PUB-09, PUB-04, PUB-03, TOK-03. No migration.

It adds one new pure module, `lib/documents/diff.js`, and its suite. Nothing in the app imports the module yet: P3-CHANGES (`listChanges`), P3-UNDO (the dry run and the Recently published summaries) and the publish-both review use it in batch 2. No tenant changes mode. Today's releases, editors and preview are untouched, and a shopper sees nothing new.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:doc-diff`: 33 passed, 0 failed, in about 0.1 s. `pnpm test`: 81 of 81 suites passed in 134.5 s. `pnpm build` passes |
| Browser verified | Not applicable. No screen shows these words until P3-PUBLISHUI and P3-EDITOR. No server ran; ports 3620 and 4620 to 4629 were not used |
| Staging verified | **NOT DONE.** Nothing here touches a database |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

PUB-09 says Publish opens a panel that lists the document's changed sections in plain words, and that founders never see a hash. PUB-04 says the Undo confirm names what will change, and Recently published says what changed. Both need one function that compares two bodies of a document and says how they differ. Writing it once means the panel, the Undo confirm and the Recently published list all use the same words.

## Design

### `diffBodies(type, fromBody, toBody)`

Returns `[{kind, sectionId?, words}]`. `kind` is one of `added`, `removed`, `edited`, `moved`, `hidden`, `shown`, `meta`, `settings` (exported as `DIFF_KINDS`). `sectionId` is the section's id in `toBody`, or in `fromBody` for a removed section. Rows come in this order: meta, document settings, sections top to bottom as `toBody` has them, then removed sections.

- **Equal bodies give `[]`.** Both bodies go through `upgradeBody` first. When their id-stripped canonical text (`stableStringify(stripIds(body))`) is equal, the answer is `[]`. That is exactly the string `documentHash` hashes, so it is the same test as equal `documentHash`. It is done without hashing so the function stays synchronous. The suite checks the two agree.
- **Section matching**, in three passes:
  1. by id, when the kind is the same;
  2. what is left over, by kind plus id-stripped content, so lazily stamped ids never show as changes;
  3. a section with no usable id on either side pairs with the next unmatched section of the same kind. A migrated section that never had an id, and was then edited, reads as "Text: title changed", not as "removed" plus "added". This pass is an addition to the brief (see Known limits).
- **Moved.** Among matched sections, the ones outside the longest run that kept its order are moved, with "moved up" or "moved down". Swapping two sections gives one row, not two.
- **Hidden and shown** come from `enabled`. An added hidden section reads "Banner: added, hidden".
- **Edited rows** give one row per section. They name the changed fields by registry label, and fields that share a verb are joined: "Hero: title and subtitle changed", "Banner: title changed, text added". Inside a field:
  - a button gives "button text" or "button link" (from the setting label, so "primary button text" on the hero);
  - an image gives "image" or "image description";
  - lists count their items: "Text: a paragraph changed", "Text: 2 paragraphs added", "FAQ: a question changed", "FAQ: an answer changed", "Header menu: a menu item added", "Text: paragraphs reordered";
  - the collections page's three lists say which list: "Collections page: 2 collections added to featured collections";
  - other fields: showing on phones or computers ("now hidden on phones"), the catalog binding, blocks, the version ("brought up to date"), and unknown keys ("other details changed"). None of these names a key.
- **Two sections of one kind** get their place: "Banner 2: title changed". A single banner stays "Banner".
- **Meta rows**: "Web address changed", "Page title changed" (the type label, so "Journal post title changed"), "Search description added", "Page switched off, so shoppers won't see it", "Effective date …", one "Showing dates: start date and end date added" row for the window, and "Old addresses that lead here: an old address added". No meta row quotes a value.
- **Document settings**: one row per changed setting, named by the type's label and the setting's label: "Announcement bar: text added", "Announcement bar: switched on", "Product page layout: layout changed".
- **The design document**: one row per changed token group: "Colours: accent changed", "Colours: accent and background changed", "Fonts: text size changed", "Shapes: corners changed", "Spacing: space between sections changed". An unset brand is compared as `DEFAULT_BRAND`, which is what it renders with. `accent_label` is worked out from the accent, so it counts only when both sides store one ("Colours: text on accent changed"). The look gives "Look: chosen", "Look: a different look chosen", "Look: applied again" or "Look: back to the standard look".
- **Never "no changes" for a changed body.** When the bodies differ but no rule names how (a body-level key no declaration covers), there is one row: "<type label>: some details changed".

### `firstPublishRows(type, body)`

Returns `[{words}]`, matching `listChanges`' `sections: [{words}]` in `documents-api-shapes.js`. For a page with an address, the first row is its title (`Page title: "Shipping and returns"`, cut at 60 characters). After that comes one row per visible section, by label ("Hero", "Text 1", "Text 2"). A type with no sections gives one row naming it ("Announcement bar").

### Words that never appear

No row has a hash, an id (`sec_`, `blk_`, `doc_`, `ver_`, a Shopify `gid://`, a media path), or the words slug, handle, CTA or href. No diff row quotes founder text. The one exception is the page title in `firstPublishRows`, which the brief asks for.

### Edge safety

The module imports only `lib/registry/index.js`, `lib/registry/settings.js` and `lib/brand.js`. The registry already imports all of these, and they are already edge-safe. It has no database access, no `await`, and no Node globals.

## Acceptance, with evidence

Every test imports `lib/documents/diff.js`, which does not exist at `407b88a`. So each test below fails without this change. I also broke the module on purpose in 13 ways, one at a time, to check that each test catches what it is meant to (listed under Tests).

| # | Acceptance | Kind | Evidence |
|---|---|---|---|
| 1 | A home draft with an edited hero title and a new banner gives exactly 'Hero: title changed' and 'Banner: added' | unit | The test "a home draft with an edited hero title…" checks the whole rows, with kind and sectionId: `[{edited, sec_hero, "Hero: title changed"}, {added, sec_newban, "Banner: added"}]` |
| 2 | Bodies that differ only by section ids give []; equal documentHash gives [] | unit | "bodies that differ only by section ids give []": new ids, sections with no ids against `ensureIds` of them (both ways), and twin banners with swapped ids. Each case first checks that `documentHash` is equal. "equal documentHash gives [] for every registered type": an empty body of all 13 types. A meta change plus id-only section changes gives only the meta row. Taking out pass 2 or the early return makes these fail |
| 3 | Moved, hidden, shown, removed, meta web address and title, a window, a redirect and a document setting change each give one plain row | unit | One test per change, each checking the exact single row: "Banner: moved down" (also for a swap of two), "Text: hidden", "Text: shown", "FAQ: removed", "Web address changed", "Page title changed", "Showing dates: start date added", "Old addresses that lead here: an old address added" (and removed), "Announcement bar: text added", "Announcement bar: switched on", "Header menu: …", "Collections page: …", "Product page layout: layout changed". Nested fields too: "Banner: button text changed", "Banner: button link changed", "Text: a paragraph changed", "FAQ: a question changed", "FAQ: an answer changed" |
| 4 | For a corpus of every registered type and section kind (registry worstCase fixtures), no row matches the banned words, an id pattern or a 40+ hex hash | unit | The corpus test builds 1,126 body pairs, giving 1,144 rows. It covers every type's settings set and cleared, every route type's meta set to tempting values (address `slug-handle-cta-href`, button label "CTA", Shopify gids, media paths), and every allowed kind on every type for each worstCase case: edited, reverted, added, removed, hidden, shown, every case-to-case pair, all kinds at once, and reversed. Each row is checked against `/\b(slug|handle|CTA|href)\b/i`, an id pattern, `/[0-9a-f]{40,}/i` and the tempting text. The test also checks the kind is listed, the sectionId is valid, no extra keys, that every kind of row appears, and that a pair that differs never gives `[]`. The 102 equal pairs (two worst cases that are the same section) must give `[]`. Putting "Slug" or "CTA" into the words makes it fail |
| 5 | A doc_design token change gives one 'Colours' or 'Fonts' row; firstPublishRows lists visible sections only | unit | "a doc_design token change…": an accent change gives exactly `[{settings, "Colours: accent changed"}]`, a type scale change gives `"Fonts: text size changed"`, two colours give one row, and so does a change from no brand. "firstPublishRows lists the title and the visible sections only": a hidden banner is left out, the page title comes first, and a long title is cut |
| 6 | The module imports no node: API (edge guard list) | unit | The last test walks the imports of `lib/documents/diff.js` and everything they import. It refuses `node:` and other built-ins, react, next and packages, as well as `require`, `process.`, `Buffer` and `__dirname`. It reads static imports anywhere on a line, bare imports, `import()` and `require()`. Adding `import "node:fs"` on its own line, on the same line as another import, or as a dynamic `import("node:crypto")` each makes it fail. It also checks the module has no `await` and no database names |

## Tests

- `scripts/test-doc-diff.js` (`pnpm test:doc-diff`), replacing P3-SCAFFOLD's placeholder: 33 tests, about 0.1 s, no database and no ports.
- Mutation checks, run by hand on a copy of the module. Each change below was applied alone, then put back:
  - no content pairing (pass 2): 2 tests fail;
  - no id-less pairing (pass 3): 1 fails;
  - no equal-body early return: 3 fail;
  - "Slug" in the address words: 2 fail;
  - no moved rows: 3 fail;
  - `accent_label` always compared: 1 fails;
  - an unset brand not compared as the default: 1 fails;
  - hidden sections in `firstPublishRows`: 1 fails;
  - FAQ answers counted as questions: 1 fails;
  - "CTA" in the button words: 2 fail;
  - a `node:` import on its own line, on the same line as another import, or dynamic: 1 fails each.
- `pnpm test`: 81 of 81 suites passed in 134.5 s. `pnpm build` passes.

## Known limits

- **Pass 3 can pair the wrong section.** Say a migrated id-less section is removed and a new section of the same kind is added in the same draft. That reads as one edit ("Banner: title changed") rather than "removed" plus "added". Pass 3 only runs when one side has no id. Bodies saved through the documents service always have ids, so this affects only bodies migrated without ids.
- **Section names are kind labels with a place number**, such as "Banner 2", not the section's own title. This keeps founder text out of the rows. With two banners, the founder must use the place, or the row's `sectionId` anchor in the panel.
- **Edited, hidden and moved are separate rows** for one section, all with the same `sectionId`. A panel that wants one line per section must group by `sectionId`. PUB-09's "Keep the live version of this section" sits on such a group.
- **Values are not quoted.** "Web address changed" does not say the new address, and "Look: a different look chosen" does not name the kit. Showing the new address needs `lib/documents/paths.js` (P3-COMMIT, merging in the same batch), so P3-CHANGES can add it next to the row if wanted.
- **Undefined against a stored default counts as a change.** A setting missing on one side and set to its declared default on the other gives "title added" or "title changed". The renderer may show the same thing for both. Only bodies from adapters can have this; editor saves write every key.
- **Design rows don't yet list affected sections.** The `affects` rows on doc_design changes come from `lib/registry/token-usage.js` (P3-DESIGN, batch 4). This module gives only the token-group rows.
- **Fonts means text size today.** The brand has no font-pairing tokens yet (TOK-06), so the only "Fonts" row is "Fonts: text size changed".
- **"Some details changed" is vague on purpose.** A body key that no declaration covers (a future field) gives this row rather than `[]`, so a changed document never claims to have no changes.
- **Not checked against the old diff vocabulary.** PUB-09 says to reuse it (`components/admin/cms/labels.js`). That file names whole content blocks ("Homepage hero edited"), not fields. These rows use the registry labels instead, which are the labels the new editor shows.

From review:

- I reviewed 5d9d9ef against 407b88a in a detached worktree at /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p3-b1/P3-DIFF/rv0, which I have removed. It only touches its three files: lib/documents/diff.js, scripts/test-doc-diff.js and docs/cms-reviews/P3-DIFF.md. Nothing changed under .github/ or in package.json, and nothing in the app imports the module yet, so legacy tenants, releases, editors and preview can't be affected. Results: test:doc-diff passed 33 of 33. pnpm test passed 81 of 81 suites in 131.6 s, using ports 4720, 4721 and 4722 and the 3720 setting, after pnpm install --offline --frozen-lockfile in the worktree. The edge check is clean: the module imports only lib/registry/index.js, lib/registry/settings.js and lib/brand.js, and has no node:, process, Buffer, require or await. I reproduced every acceptance row: the hero plus banner case, bodies that differ only by ids, moved, hidden, shown and removed, meta, a design token change, and the visible-only filter.
- Pass 3 (pairing sections that have no id) can name the wrong section as removed. This is wrong text a founder sees, not a shopper. Repro: live page [Text A, Text B] with no ids; the draft removes A and edits B (B now has id sec_bbbb). The output is [edited sec_bbbb 'Text: title changed' (A compared against B'), removed 'Text 2: removed'], but Text 1 was the one removed. The Known limits only describe the case of a removal plus an addition. Suggested fix: skip pass 3 when the two sides have different numbers of unmatched sections of that kind, or pair by the most similar content rather than taking the first unused one.
- Two sensitive lines survive mutation, so they are unproven. (a) Replacing pass 3's condition (!validId(x) || !validId(s)) with true still passes all 33 tests. A removed section with an id and an added section with an id, of the same kind, would then read as one edit, and no test catches it. Add a test: from [Banner sec_a 'one'] to [Banner sec_b 'two'] must give 'Banner: added' plus 'Banner: removed'. (b) Deleting the 'some details changed' fallback row also passes, so the builder's claim that a changed body never gives [] is not tested. Other survivors: dropping pass 1's kind check, ignoring image alt changes, ignoring bindings, folding 'Look: applied again' into 'Look: a different look chosen', ignoring extra section settings, and skipping upgradeBody. The suite's other mutations were caught: move direction, hidden and shown, place numbers, title in firstPublishRows, answers, redirects, window end, enabled, button link, reorder, named lists, removed rows.
- A null or sparse body gives false meta rows. diffBodies('page', null, page) and diffBodies('page', page, null) both give 'Search description changed' and 'Old addresses that lead here: reordered' when both sides are empty. The cause: blank('') vs undefined falls through to presence() returning 'changed', and two empty redirect sets fall through to 'reordered'. P3-UNDO's Recently published summary diffBodies(from, to) will have a null side on first-publish and take-offline rows. Its dry run will too when the live body is null (offline). Fix: skip a meta field when both sides are blank, treat a missing redirect_from as [], and say 'reordered' only when both lists are non-empty and have the same length. Duplicate redirects that collapse to one also read 'reordered'.
- firstPublishRows counts only enabled === false as hidden. A section with show {mobile:false, desktop:false} is still listed even though no shopper sees it. diffBodies reports that change as 'now hidden on phones, now hidden on computers' rather than one row saying it is hidden.
- Two small wording problems. Reversing three sections gives 'Banner: moved' with no direction for the middle section, which stayed in place. A design brand that gains only a stored accent_label (for example, a legacy brand validated on save) gives 'Brand: some details changed' for a change the founder did not make.
- Owner checks to carry forward, as the builder lists them: the wording ruling ('Old addresses that lead here', 'Showing dates', 'Look: applied again', 'Banner 2', 'Fonts' standing for text size); confirming the page title is quoted in firstPublishRows; and the 375 px phones drill, which waits for P3-PUBLISHUI and P3-EDITOR.

## Owner checks

- **Wording.** Read the words in the Design section and say whether they suit a founder: "Old addresses that lead here", "Showing dates", "Look: applied again", "Banner 2", and "Fonts" for the text size.
- **Founder text in first publish.** Should the page title be quoted in `firstPublishRows`, as the brief asks? It is the only founder text any row carries.
- **The phones drill** waits for P3-PUBLISHUI and P3-EDITOR: the change rows in the Publish panel and the Undo confirm at 375 px.
- **No CI change.** Nothing under `.github/` changed. This suite needs no sqld.
