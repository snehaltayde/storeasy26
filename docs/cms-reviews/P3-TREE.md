# P3 · TREE · The section tree: add, move, hide, copy, delete

Branch `cms/p3-tree`, cut from `64d3d07`. Plan: `docs/cms-reviews/P3-PLAN.md` (batch 3, "FORMS is split into INSPECTOR and TREE, both prop-driven with no store import") and `P3-BATCHES.json`. Requirements it serves: ED-02 (add from a library, select, move up or down, hide, duplicate, delete), AU-04 (added sections start good), ED-04 (a section added before its first save is selectable, because the client mints its id). No migration.

It adds three new files under `components/admin/editor/tree/` and replaces the placeholder `scripts/test-editor-tree.js`. Nothing in the app imports the tree yet: P3-EDITOR (batch 4) mounts it in the new editor. No tenant changes mode. Legacy tenants, today's releases, the legacy editors and preview are untouched, and a shopper sees nothing new.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:editor-tree`: 18 passed, 0 failed, in about 0.4 s. `pnpm test`: 81 of 81 suites passed in 133.3 s. `pnpm build` passes |
| Browser verified | **NOT DONE.** The tree has no host page until P3-EDITOR, so there is nothing to open in a browser. The rendered acceptance is proved by server rendering (the plan's "rendered" kind). No server ran; ports 6140 and 7140 to 7149 were not used |
| Staging verified | **NOT DONE.** Nothing here touches a database |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

ED-02 asks for one editor in which the founder can add a section from a library, select it, move it up or down, hide it, copy it and delete it. US-16 adds "within limits that keep it looking right". AU-04 asks that every added section starts good, and that a product rail added to a store with collections picks a real one. ED-04 asks that a section added before its first save can be selected in the preview straight away.

The tree is the part of the editor that does this. Its rules live in a pure model so they can be tested in node without a browser (plan critique B6).

## Design

### `treeModel.js` (pure)

Imports only `lib/registry/index.js` and `lib/registry/validate.js`, which are edge-safe. No React, no store, no `node:` API. Every operation takes the sections and returns a new list. It never changes the list it was given. Each answers `{ok: true, sections, selectedId, id?}` or `{ok: false, code, message}`, with the message in plain words.

- `add(sections, kind, index, {type, collections})` makes the section with `starterSection(kind, {collections, id})` (P3-VALIDATE). The id is minted on the client, so the new section can be selected at once (ED-04), and it is never an id the document already uses. It goes at `index` (the end when left out). When the rules refuse that place, it goes to the kind's allowed position (the hero goes to the top), else the end, else the top. The answer's `index` says where. A product rail given `collections` is bound to one with available products.
- `move(sections, id, toIndex)`, `moveUp`, `moveDown`: the same section objects, reordered. Ids never change.
- `hide` sets `enabled: false`. `show` sets `enabled: true` and also clears "hidden on both screens" (TREE-05 says hiding on both screens is the normal Hide).
- `duplicate`: a deep copy right below the original, with a fresh section id and a fresh id for every nested block. None of them is already used anywhere in the document.
- `remove` (also exported as `delete`). The answer selects the next section, or the one before it when the last is deleted.
- **The rules are the registry's, not a copy.** Before an operation is answered ok, the result is checked with `validateDocument` in draft mode. It is refused if it would add a "structure" issue the list did not have before. That covers a second hero, a hero moved off the top, the product details hidden, removed or copied, too many sections above them, and a kind the document does not take. Because `saveDraft` answers 422 for any structure issue (plan decision 9), every ok answer gives a body that saves. The check runs on a copy whose sections carry their kind's defaults instead of the founder's settings. Settings never decide where a section may go, and this keeps the check cheap: the buttons of a 30-section home are worked out in about 14 ms.
- Refusals use words about the action, not validate's "fix the saved body" words. Examples: "The home page already has a hero. It can have only one." "The hero can only go at the top of the home page." "Only one section can sit above the product details and buy button." "The product details and buy button can't be hidden: shoppers need it to buy."
- `addOptions(type, sections, index)` returns every registered kind the document type takes (`allowedKinds`), each with its label, its hint (placeholder), and whether it can be added there. When it can't, the reason is given.
- `rowActions(sections, id, type)` says which of move up, move down, hide or show, copy and delete are allowed, each with its reason when not.
- `rowState(section, issues)` gives the row's label, its own title (cut at 48 characters), and its marks: `hidden`, `unfinished` (an "incomplete" issue in the section) and `problem` (an "error"). `groupIssues(issues)` turns a flat list into `{[sectionId]: issues}`.

### `SectionTree.js` (prop-driven)

`{type, sections, selectedId, onChange, onSelect, issuesBySection, collections}`. No store import. Each row shows the kind's label and the section's title. Its marks:
- **Selected:** `aria-current="true"`, a bar on the left and a sunken background.
- **Unfinished:** a warning badge when the section has an incomplete issue.
- **Needs a fix:** when it has an error.
- **Hidden:** when it is hidden.

The buttons are move up, move down, hide or show, copy and delete. Each is disabled when the rules would refuse it, and the reason shows as its tooltip. The accessible name stays the action, for example "Move Hero down". Delete asks once, in the row ("Delete this section?", with Delete and Keep it). `onChange(next, {op, id, selectedId})` gets the new list. `onSelect(id)` is called when a row is picked, and when the selection moves after an add, a copy or a delete.

### `AddSection.js` (prop-driven)

A button, "Add a section", opens the picker. The picker lists every kind from `addOptions`, each with its label and hint. A kind that can't be added is greyed out and shows its reason instead of its hint. The tree adds below the selected section ("Adds below the hero"), or at the end when nothing is selected. Picking a kind calls `add`, then `onChange` and `onSelect` with the new id.

## Acceptance, with evidence

At the base commit `64d3d07`, `scripts/test-editor-tree.js` is the scaffold placeholder and the three tree files do not exist. So every test below fails without this change. I also broke the code on purpose in 13 ways, one at a time (listed under Tests).

| Acceptance | Kind | Status | Evidence |
|---|---|---|---|
| Add, move, hide, duplicate and delete give bodies that validate in draft mode with no structure issue | unit | Done | "every allowed add, move, hide, show, duplicate and delete on each type's draft…": over 200 results, on all 7 types that hold sections (home, product_layout, collection_layout, page, campaign, journal, product_content). Each is validated as a whole body with `validateDocument(…, {mode: "draft"})`: `ok`, and no structure issue. "a random walk of 400 operations per type…": every ok answer has no structure issue, and a refused operation never changes the list it was given (the input is deep-frozen and compared). "composition refusals…" checks each refusal and its words. Removing the check (`addedIssue`) fails 9 tests |
| Duplicate never reuses an id | unit | Done | "duplicate never reuses an id…": 30 copies in a row, of a throwaway kind that holds blocks plus a text section. Every section id and block id is fresh, well formed and unique in the document. The copy sits right below the original, and its content equals the original's. "a minted id that is already in the document is never used…" forces the random draws to give an id already in use, and add and duplicate mint again |
| Ids are stable across moves | unit | Done | "ids are stable across moves…": four moves keep the same ids and the same section objects, and the moved section stays selected |
| Add of every registered kind for each type works | unit | Done | "add of every registered kind for each type that holds sections works…": 50 or more adds, to the empty body and to a filled one. Each has a new, well-formed, unused id, is selected, and the draft is clean. A kind that starts incomplete has only incomplete issues or warnings. "the picker lists every registered kind…": the options are exactly `allowedKinds(type)` with the registry labels |
| product_rail add picks a collection with products when given collections | unit | Done | "product_rail add picks a collection…": given an empty collection, a sold-out one and `tees` with 7 available, the rail binds `{handle: "tees", id: …}` on every type that takes rails, and publishes with no error in the rail. Without collections, it is an unfinished rail asking for a collection |
| Rendered: the tree marks unfinished sections and the selected one | rendered | Done | "the tree marks the unfinished sections and the selected one (and only those)": the real `SectionTree`, compiled with Next's SWC and rendered with react-dom/server. The issues come from the real `validateDocument`. Exactly one row has `aria-current="true"`, and only the empty banner and the empty rich text show "Unfinished". The hidden row says Hidden and offers Show. The hero's "Move down" is disabled, with the reason. Also: nothing selected marks no row; the product details row has hide, copy and delete disabled; the open picker lists every kind of each type, with its label, and a second hero disabled with its reason |

## Tests

`pnpm test:editor-tree` (18 tests, about 0.4 s):

- operations: the samples are clean; every operation on every type; the random walk; the composition refusals; the hero going to the top, the selection after a delete, hide then show; duplicate ids; a minted id already in use; ids across moves.
- add: every kind on every type; the picker list; the product rail; `rowState` and `groupIssues`; the time for `rowActions` on 30 rows; edge safety (the imports, and a walk of every file the model imports, finding no `node:` import).
- rendered: the selected and unfinished marks; no selection and the empty tree; the protected row; the picker.

Does the suite catch real breakage? I made each change below, one at a time, and ran the suite:

| Broken on purpose | Caught |
|---|---|
| duplicate keeps the original id | yes |
| duplicate keeps the block ids | yes |
| the composition check removed | yes (9 tests) |
| `unfinished` always false | yes (2 tests) |
| add ignores `collections` | yes |
| a minted id already in use is kept | yes |
| move copies the section objects | yes |
| the tree drops `aria-current` | yes |
| the tree drops the Unfinished badge | yes |
| the picker leaves one kind out | yes (2 tests) |
| delete selects nothing | yes |
| the composition copy forgets `enabled` | no. No behaviour changes: the product details' hide is refused before the check, and no other rule reads `enabled` in draft mode |

`pnpm test`: 81 of 81 suites passed in 133.3 s. `pnpm build` passes. The build does not compile the tree yet, because no page imports it; the rendered tests compile it with Next's SWC and the `@/` imports.

## Known limits

- **No host page yet.** The tree is not mounted anywhere until P3-EDITOR. Clicks, focus and the inline delete confirm have not been tried in a browser. P3-EDITOR's drill covers them (plan B6).
- **The section id minter** is the registry's (`mintSectionId` in `lib/registry/body.js`, Web Crypto), not `lib/documents/ids.js`, which the brief names. `ids.js` mints document, version, release and log ids; it has no section or block id minter, and this item does not own it. Both are edge-safe.
- **Where a refused add goes.** When the place asked for is refused (for example a banner at the top of the product layout, which already has a section above the product details), the section goes to the end instead. The answer's `index` says so, but the tree shows no note about it. P3-EDITOR may show one.
- **Composition only.** The check before an ok answer covers structure issues (composition, ids, kinds). A copy of a section with broken settings copies them. Such a draft could not have been saved in the first place (saveDraft refuses any structure issue), so this only matters for a body the server already refused.
- **Hidden on one screen.** A section hidden on phones only (or computers only) shows no mark in the tree. TREE-05 (P1) owns per-screen hiding.
- **Product rail counts.** As P3-VALIDATE and P3-FIX1 record, the rail picks well only when the caller passes a real `available_count`. No repo function returns one today. P3-EDITOR or INSPECTOR must pass it.
- **No drag and drop.** AU-07 (P1). The arrow buttons stay.
- **Delete has no undo here.** The confirm is the only guard. The editor's draft history and "Go back to the live version" (P3-STORE and P3-EDITOR) are the way back.

From review:

- The reason a button is disabled never reaches the founder, and the enabled icon buttons have no hover label. SectionTree passes title={can.X.reason || undefined} to IconButton. IconButton (components/console/Button.js:47-61) sets title={label} and then spreads {...rest}, so an explicit title: undefined replaces the label. I reproduced this with SSR: on an enabled row, the Move up, Move down, Hide, Copy and Delete buttons render with aria-label and no title. A sighted founder sees bare icons with no tooltip. On a disabled button the reason is only a title attribute, so keyboard and screen-reader users never get it either (a disabled button can't take focus). Fix: pass title={reason || label}, or show the reason in visible text. Hand this to P3-EDITOR.
- Copy can be allowed for a body that then can't be saved. The composition check looks only at structure issues, on a copy of the sections that has no settings. I copied a rich_text section holding 20,000 characters on a page: copies 1 to 40 were all answered ok, but from copy 26 on, validateDocument in draft mode gives DRAFT_TOO_LARGE as an error, so saveDraft answers 422. Copying a section that has an unknown setting or a bad 'mobile' key is also allowed, and doubles the structure issue (the Known limits cover this case). Nothing is lost silently, provided the P3-STORE save shows the 422. Still, the tree could check the draft caps (or the full draft-mode ok) before it allows a copy.
- Several of the component's wiring paths are untested. I changed each one on its own and the 18 tests still passed: SectionTree stops calling onSelect after a delete, copy or move; AddSection stops calling onSelect(r.id), which is the ED-04 'selected at once' path; AddSection stops passing collections to add, so a rail added from the picker gets no collection even though the model test passes; AddSection adds at selectedIndex instead of selectedIndex+1, so the new section lands above the selected one, not below; the Move up button is never disabled; Delete skips the in-row confirm; the 'Needs a fix' badge is dropped. In the model, duplicate minting block ids against an empty set (so a block id could repeat) also survives, because no registered kind holds blocks today (blocks.max is 0). The acceptance lines are still met at the model level, but P3-EDITOR's drill should cover these, or the SSR tests should call the handlers directly.
- Four of my changes made no difference to behaviour, so they are not test gaps: dropping allowedPositions from candidateIndexes (index 0 is tried last anyway), ignoring counts in addedIssue, skipping the guard in hide, and removing add's own allowedKinds pre-check (the guard reports KIND_NOT_ALLOWED with the same words). The suite caught the other changes: the neighbour order after a delete, 'unfinished' also counting warnings, a copy placed at the end, show not clearing 'hidden on both screens', the guard ignoring TOO_MANY_BEFORE_PROTECTED or POSITION_NOT_ALLOWED, problem always false, a minted id not redrawn, the Hidden badge dropped, the picker not disabling a refused kind, and the picker showing the kind name instead of its label.
- Selection jumps when a row the founder has not selected is changed. Using move or delete on a different row moves the selection to that row, or to the deleted row's neighbour (SectionTree's run calls onSelect whenever r.selectedId differs). After a delete, the founder may expect the selection to stay where it was. Raise this as a UX ruling for P3-EDITOR.
- A gap in validate, outside this item: a product_main section with show {mobile:false, desktop:false} gets no issue in validateDocument. The protected product details could be hidden on both screens, and shoppers would lose the buy button. The tree doesn't create this (hide refuses protected sections and only sets enabled), but rowActions does offer Show for it, so the tree handles it if it appears. Worth an owner note for P1 TREE-05, which owns per-screen hiding.
- Documentation mismatch: the builder report says the code was broken on purpose in 12 ways, while the packet says 13 ways and its table lists 12 rows. Using lib/registry/body.js mintSectionId and mintBlockId instead of lib/documents/ids.js is justified (ids.js has no section or block minter), edge-safe (Web Crypto), and written in Known limits. The SectionTree props add type and collections beyond the brief, which the work needs.
- Builder claims reproduced: pnpm test:editor-tree gives 18 passed, 0 failed. pnpm test gives 81 of 81 suites passed in 142.0 s (exit 0); the mutation script ran in parallel with this run, but the same suite was clean when run alone. The diff touches only the 5 listed files (no .github, package.json, lockfile or env change). Nothing in app/, components/ or lib/ imports the tree yet, so legacy tenants, releases, editors and preview are unaffected. The treeModel import graph (lib/registry, lib/cms/issues.js) has no node: imports or require calls, so it is edge-safe. I started no server; ports 6340 and 7340 to 7349 were not used and nothing is listening on them. The review worktree is removed.

## Owner checks

- **Desktop Chrome, once P3-EDITOR mounts the tree**, on the design harness: add each kind to the home page and to a page, move, hide, show, copy and delete sections, and check that each new section is selected in the preview at once (ED-04). Check that the disabled buttons' tooltips read well.
- **Wording:** the refusal sentences above, and the badges "Unfinished", "Needs a fix" and "Hidden".
- **Phones:** the tree in the editor's drawer below 1280 px (ED-01, once mounted).

## Files

New `components/admin/editor/tree/treeModel.js`, `components/admin/editor/tree/SectionTree.js` and `components/admin/editor/tree/AddSection.js`. `scripts/test-editor-tree.js` replaces the placeholder. Also this packet. Nothing outside the plan's file list was changed. No `.github/` change, no new dependency, no env var.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:editor-tree
pnpm test
pnpm build
```
