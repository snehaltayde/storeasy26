# P3 · INSPECTOR · The inspector's forms: settings, menu, design, rich text field, ED-12 checklist

Branch `cms/p3-inspector`, cut from `64d3d07`. Plan: `docs/cms-reviews/P3-PLAN.md` (batch 3, decision 14, critique B5, "FORMS is split", "focusRequest {path, offset}", "The ED-12 checklist is an INSPECTOR deliverable") and `P3-BATCHES.json`. Requirements: ED-12, AU-02, TOK-03, AU-01, ED-04. No migration. No new dependency.

No real store changes mode, and nothing a shopper or a legacy screen uses is touched. Every file here is new except the inspector suite, which replaces P3-SCAFFOLD's placeholder. No page imports these components yet: P3-EDITOR mounts them in batch 4.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 140.9 s. `pnpm test:editor-inspector`: 33 passed in 0.5 s (1,076 issues checked at their fields, 24 issue codes, 79 checklist rows against 72 legacy controls). `pnpm build` passes (its 2 Turbopack warnings were there on the base commit too) |
| Browser verified | **NOT DONE.** There is no page that hosts these forms until P3-EDITOR (batch 4), so no desktop Chrome drill ran. Every acceptance item is proved by a unit or rendered (SSR) test below. No server was started; ports 6120 and 7120 to 7129 were not used |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed |

## What and why

The new editor needs a form for every section kind and every document type, so that a store moved to documents mode can still change everything it can change today (ED-12), with each problem shown in plain words at its field (AU-02), and with a field that a click in the preview can focus (ED-04). Phase 3 splits the old FORMS item in two: TREE owns the section list, and this item owns the forms. Both are prop-driven, with no store import, and keep their logic in a pure model, so node tests drive them without a browser (critique B5).

Files (all in `components/admin/editor/fields/`):

- `inspectorModel.js`: the pure logic. It maps kinds to controls, types to forms, and fields to anchors, places issues, and holds the menu edits, the design edits, the pickers' options and the focus helpers. Its only imports are `lib/registry` and `lib/brand.js`, so it is edge-safe.
- `SettingsForm.js`: the registry-driven form for one section or one document's own settings and details.
- `controls.js`: one control per setting kind, plus the route details' controls.
- `MenuControl.js`: the header and footer menu, ported by behaviour from `NavigationEditor`.
- `DesignForm.js`: the `doc_design` form (brand tokens and the look). It also holds the brand and look controls.
- `RichTextField.js`: the final interface, with a fallback implementation behind it.
- `docs/cms-reviews/P3-ED12-CHECKLIST.md`: every control on today's screens mapped to its new field, or marked as waiting.
- `scripts/test-editor-inspector.js`: the suite.

## Design

### Props, and no store

Every form and control takes `{ value, onChange, issues, focusRequest? }` plus what it needs to know (`kind` and `sectionId`, or `type`; `context` with the catalog rows; `readOnlyReason`). None of them imports a store, `fetch` or `documentsApi`. Tests render them with `react-dom/server` and call the model directly.

- `SettingsForm { kind, sectionId, value: section.settings }` edits a section. `SettingsForm { type, value: body }` edits a document's settings and, for a page, campaign or journal post, its details (title, web address, description, shown, start and end dates, old addresses). `type: "design"` hands over to `DesignForm`.
- `onChange(next, { path, value })`: `next` is the whole new settings object (for a section) or body (for a document). `path` uses validate.js's words (`title`, `primary`, `items`, `meta.title`), so P3-STORE can record field-path operations directly.
- `issues` is the document's whole list (from `validateDocument` or the save and publish answers). Each form keeps the ones that belong to it: a section's by `sectionId`, the document's where there is none.

### Field ids are anchors, and each message sits at its field (AU-02, ED-04)

- Every field's element has `id = fieldAnchor` of its path (`lib/registry/issue-words.js`): `f-sec_hero-title`, `f-doc-items-0-children-1-link`, `f-doc-meta-title`. Each part has its own id too: a button's text, a link's target, an image's alt text, each list item and each menu sub-item. `inspectorModel.pathsOf(field, value)` lists exactly the paths a control renders for a value, and the suite checks that every id on that list is rendered, and no id twice.
- `placeIssues(issues, known)` puts each issue at `fieldAnchor(issue, { known })`, where `known` is every id the form renders. So an issue on `primary.link.href` lands on the link's address box when that box is shown, and on the closest rendered part when it is not.
- Each message is shown in an element right under its field, with id `<anchor>--notes` and `data-for=<anchor>`. The field's element names that element in `aria-describedby`, and an error also sets `aria-invalid`. A red border never appears without a message.
- An issue whose field has no control (a section's kind or version, an unknown setting, the section list, an unknown detail) gets a note of its own at the top of the form. That note's element has the issue's anchor as its id, so a publish-panel link still lands on the message.
- Labels are shown exactly as the registry declares them ("FAQ", "Image with text"), never lower-cased. This answers the P3-VALIDATE review note.

### Controls (one per registered kind)

| Setting kind | Control | Ids rendered |
|---|---|---|
| text | text box with a character counter (limits are reported, never cut) | the field |
| number | number box; empty is null, non-numbers stay as typed so the note shows | the field |
| boolean | switch | the field |
| choice | select, options in plain words (`choiceWords`, from today's screens) | the field |
| rich_text | `RichTextField` | the field |
| paragraphs | one text box per paragraph; add, move, remove | the list, each paragraph |
| qa_list | question box and `RichTextField` answer per item; add, move, remove | the list, each item, its question, its answer |
| link | kind (none, collection, product, one of your pages, an address on the store), then its target | the link, its target part |
| cta | button text and its link; add and remove the button | the button, its text, its link and target |
| image | image address, "Choose from your library" when the editor gives `pickImage`, alt text | the image, its address, its alt text |
| collection, product | picker from the catalog rows, or a typed web name when no rows are given | the field |
| collection_list, product_list | ordered list with move and remove; add from the rows or by web name | the list, each item |
| nav_items | `MenuControl` | the menu, each item, label, link, sub-item list, sub-item, its label and link |
| brand, theme | `BrandControl`, `ThemeControl` (DesignForm) | the brand and each token; the look |
| entries | read-only note (system list) | the field |

A link with a kind picked but no target yet is kept in the control's own state and not sent. Autosave never stores a link that points nowhere, and the notes of a part that is hidden while the kind changes are shown at the link.

### The menu (ported from NavigationEditor)

`inspectorModel.menu` holds `add`, `addChild`, `edit`, `move` and `remove` (an item goes with its sub-items), plus `view`, the notes above the rows. The limits are kept from the legacy screen: 12 items and 8 sub-items, one level deep. The modes Automatic and Custom menu stay; the mode and the layout are the document's own choice settings, rendered beside the menu. These changes are deliberate and recorded in the checklist:

- links are typed and stay on the store;
- switching to Automatic keeps the items, with a note, instead of discarding them;
- a custom menu with no items shows no menu, as the documents reader renders it, and the form says so.

The legacy file is untouched.

### The design form (TOK-03)

`DesignForm` edits `doc_design` settings `{ brand, theme }`:

- **Tokens.** The brand tokens are shown in today's brand-screen words: accent, background and text colours, each with a picker; corners; text size; button shape; space between sections.
- **The look.** Pulse or Glow, from `lib/brand.js` `KIT_SURFACES`.
- **The default.** A note shows while the store uses the platform default. "Go back to the platform's default brand" stores no brand.
- **The accent button text.** Every brand change goes through `design.setToken`. That works out `accent_label` (the text colour on accent buttons) again with `validateBrand`, and drops it while a colour is half typed. The storefront uses a stored `accent_label` as it is, so a stale one would keep the old button text colour on a new accent.
- **Readability.** TOK-02 readability issues arrive on the `brand` field at publish and show under the brand group.

Applying a kit, with its brand and hero words, stays with P3-DESIGN's `applyKit`.

### RichTextField (AU-01): final interface, fallback inside

The interface is documented in the file header and is final: `{ value, onChange(html), issues, focusRequest: { path, offset? }, readOnlyReason?, id, label, placeholder?, required? }`. `offset` is a block child index: offset 2 puts the caret at the start of the third top-level block (`inspectorModel.blockStart`).

- **The fallback.** It is a plain text box that shows the stored HTML exactly as it came and sends exactly what is typed. It never sanitizes: the server is the only sanitizer, and P3-RTE's grep test relies on that. A note under the box says that the formatting buttons arrive with the full editor.
- **`readOnlyReason`.** It makes the box read-only and shows the reason, named in `aria-describedby`.
- **P3-RTE.** It replaces the implementation and keeps these props.

### Focus (ED-04)

`focusAnchor(focusRequest, { sectionId, known })` gives the closest rendered field for a request's path. `applyFocus(document, id, caret)` scrolls to it and focuses it, and for a text box puts the caret at `offset`, clamped. It takes the document as a parameter, so the suite drives it with a stub. Rich text fields (a rich text setting, an FAQ answer) get the request themselves through their `focusRequest` prop, and every other field is focused by the form.

### Collection pickers and the rail (P3-VALIDATE review)

Pickers take catalog rows `[{ handle, id, title, available_count?, product_count? }]` from `context`. Option labels show "(N available)" only when a real available count is given. An empty product rail offers "Use <collection>" from `railSuggestion`, which passes `available_count` (or `availableProducts`) to `pickRailCollection` and never `product_count` in its place. A row with no count is "unknown", not "full".

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| unit: inspectorModel maps every registered setting kind to a control and every section kind and singleton type to a form; an unknown kind is a test failure | **Done** | Tests "every registered setting kind maps to a control…", "an unknown setting kind is a coverage failure…" and "every section kind and every document type (every singleton) has a form". `inspectorCoverage()` is `[]`. An extra kind, a kind dropped from the map and a stale map entry are each reported. A document type the test doesn't know fails it. Mutation: dropping `qa_list` from the map fails the coverage test and every rendered type that has an FAQ. On the base commit the suite was a placeholder that proved nothing |
| rendered (SSR): each form renders for a worstCase() body of every registered type; each issue's message appears next to the element whose id equals fieldAnchor(issue) | **Done** | One test per document type renders its document form and every section's form. Three bodies are used: worst case (every allowed kind, every `worstCase()` case); broken (a breaking value for every setting, unknown fields, a kind the type doesn't take, an unknown kind); and, for the menus, Automatic with items. A probe section shows that the `product` kind, which no registered section uses yet, renders through the registry. For each of 1,076 issues (24 codes), the element whose id is `fieldAnchor(issue, { known: the rendered ids })` exists, names `<anchor>--notes` in `aria-describedby`, and that element (`data-for` the anchor) holds the message. Rendered ids are unique, and every id `pathsOf` lists is rendered. Every control was rendered at least once. Mutations caught: the text box losing `aria-describedby`, the image's alt path missing from `pathsOf`, and orphan notes not rendered |
| unit: the menu model adds, reorders, edits and removes items; its output validates; the checklist lists every legacy control with a mapped field or a named wait | **Done** | "the menu model adds, reorders, edits and removes items, and its output validates": blank items save as an incomplete draft, and the finished header and footer menus validate in publish mode with no issue. "the menu limits…": 12 and 8, the notes, and the registry's `ITEMS_NOT_SHOWN`. "the menu control renders every item…": the ids. "the ED-12 checklist…": the test scans the seven legacy screens for every control element and requires a row for each (72 controls, 79 rows). A `field` row's target must be a real field of the named type or kind, and a `waits` row must name what it waits for. Mutations caught: `remove` taking the wrong item, the limit at 13, a checklist row deleted |
| rendered: RichTextField fallback renders value and readOnlyReason; focusRequest is part of its props contract (documented in the file header) | **Done** | "the RichTextField fallback renders its value, and readOnlyReason read-only": exact value, the id, read-only with the reason, notes named in `aria-describedby`. "focusRequest is part of the RichTextField props contract": the header names every prop, says what `offset` means and that the interface is final, and the field calls no sanitizer. "focus goes to the closest rendered field…" covers `focusAnchor`, `blockStart` and `applyFocus` on a stub. Mutations caught: the reason not rendered, the offset ignored |

Review notes from batches 1 and 2, all tested:

- **Labels as written.** "labels are shown as written (FAQ, not faq), with no code words" checks the FAQ heading, and that no form shows CTA, href, handle or slug. Mutation caught: a lower-cased label.
- **Real available counts.** "a rail's suggestion uses real available counts, never product_count". Mutation caught: product_count used as the available count.
- **Ports.** None were used.

TOK-03 has two more tests: "the design form keeps the accent button text in step…" (mutation caught: a stale `accent_label`) and "the design form shows every token, the look, the default note and readability notes at the brand".

## Tests

- `pnpm test:editor-inspector` (`scripts/test-editor-inspector.js`): 33 tests in 0.5 s, no database, no server. It renders with Next's SWC and `react-dom/server`, through the same loader pattern as `test-sections-render`.
- Mutations: 12 mutations of the model, controls, forms, rich text field and checklist were applied one at a time, and each failed the suite. The script is outside the repo, in the scratch folder.
- `pnpm test`: 81 of 81 suites, 140.9 s. `pnpm build`: passes.

## Known limits

- **No host page and no browser drill yet.** P3-EDITOR mounts these forms in batch 4, and its drill is the first time they run in Chrome. `pnpm build` doesn't bundle them yet, because nothing imports them; they compile with Next's SWC in the suite. P3-EDITOR may fix defects its drill finds in these files (except `RichTextField.js`, which P3-RTE owns).
- **AU-01 is not met by the fallback.** Until P3-RTE ships, the rich text box shows HTML tags. The interface is final; only the implementation changes.
- **Pickers show only the rows they are given.** There is no search dialog and no catalog fetch: the editor must pass `collections`, `products` and `pages` in `context`. With none given, the founder types a web name. No repo function returns an available count per collection today, so until P3-EDITOR passes one, every row's count is "unknown". Option labels then show no count, and the rail suggestion falls to the first collection that holds products.
- **Media library.** "Choose from your library" shows only when the editor passes `pickImage`; otherwise the image address is typed.
- **The look.** Choosing a look in the form stores `{ kit, version }` only (no `applied_at`) and doesn't apply the kit's brand or hero words; applying a kit is P3-DESIGN's.
- **A half-typed colour.** It is a brand error at document level, so a draft save of it answers 422 (P3-STORE keeps the text). The form shows a note under the colour while it is half typed.
- **Dates.** Start and end dates are entered in the founder's browser time zone and stored as ISO times. `effective_at` and `window_start` are both called "Start date" (the registry's words in `issue-words.js`); the hint under each says which is which.
- **Page links.** The web address of a page link is typed. `context.pages` is used only to attach the page's document id when the address matches.
- **Still waiting.** Cart (capability ruling), product content (OVL-02) and collection content (no type) are recorded in the checklist.

## Owner checks

- **Phones and desktop, after P3-EDITOR mounts the forms.** At 375 and 1440 wide, check each form: the hero, the menu with sub-items, the collections page, the design form, and a page's details. Each message must sit under its field, nothing may overflow, and keyboard focus must land on the field a preview click names.
- **Rulings on deliberate changes from today's screens** (listed in the checklist):
  - menu and bar links can no longer point at another site;
  - Automatic keeps the menu items;
  - an empty custom menu shows no menu;
  - the collections page has no separate Automatic switch (empty lists are automatic);
  - text limits are reported, not cut.
- **The cart capability ruling** (`upsells.write` or `storefront.*`) before any store moves to this editor.
- **CI.** The sqld download in CI needs the owner's approval of its source and checksum. Nothing under `.github/` was changed.

## Files

New: `components/admin/editor/fields/inspectorModel.js`, `SettingsForm.js`, `controls.js`, `MenuControl.js`, `DesignForm.js`, `RichTextField.js`, `docs/cms-reviews/P3-ED12-CHECKLIST.md`, this packet. Replaced: `scripts/test-editor-inspector.js` (the P3-SCAFFOLD placeholder). No `node:` import in the components. No legacy file, `package.json` or `.github/` change.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:editor-inspector
pnpm test
pnpm build
```
