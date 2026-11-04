# P5 · SETTING · Bundle setting kinds: choose a bundle by id

Branch `cms/p5-setting`, cut from `b09f342` (`cms/phase-1` with the phase 5 plan). Plan: `docs/cms-reviews/P5-PLAN.md` (decision 3, section 0) and `P5-BATCHES.json` (batch 1). Requirements: COM-01, COM-02, TREE-01.

Migrations owned: none. Files touched are only the ones this item owns: `lib/registry/settings.js`, `lib/registry/issue-words.js`, `lib/documents/diff.js`, `lib/documents/refs.js`, `lib/registry/fixtures.js`, `scripts/test-registry-contract.js`, `scripts/test-documents.js`, `scripts/test-editor-inspector.js`, `scripts/test-doc-diff.js` and this file. Not touched: `package.json`, `lib/registry/index.js`, `lib/registry/validate.js`, `lib/registry/sections.js`, `lib/cms/*`, the editor components, anything under `.github/`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No section kind is declared here (that is P5-BLOCKS). Legacy tenants are untouched: `lib/cms/registry.js`, HOME_LEGACY and the legacy home kinds do not change. No store changed mode, nothing ran against a hosted store, `--hosted` was never passed, nothing was sent to Typesense or Shopify.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 195.7 s (the sqld suites pinned to ports 7120 to 7129, the web port to 6120). `pnpm build` passes (one existing warning about the edge runtime on `/api/errors`). Single suites: test-registry-contract 38 passed, test-editor-inspector 37, test-documents 43, test-doc-diff 44 |
| Browser verified | **NOT DONE, not applicable to this item.** Nothing here renders: the bundle kinds have no editor control yet (P5-EDITOR) and no section uses them (P5-BLOCKS). Every acceptance item is proved by a suite |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

Phase 5 adds a bundle card and a bundle grid to the home page (P5-BLOCKS). A section has to say which bundle it shows. Plan decision 3: it holds the bundle's id and nothing else. The title, price and stock are read live when the page renders (P5-SOURCES `bundle_by_id` / `bundles_by_ids`), so a published version can never carry a stale price (TREE-01: "a version body never holds a price, title snapshot or stock value").

This item adds the two setting kinds, the words that go with them (issues, publish diffs), the reference rows, the worst-case fixtures, and makes the editor inspector suite ready for kinds whose controls arrive later.

## Design

### The kinds (`lib/registry/settings.js`)

- `bundle`: `{ id }` or `null`. `id` must match `BUNDLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/`, which takes `bun-<hex>` from `lib/bundles.js rid()` and older raw ids such as the drills' `bnd_p1c`. Any other key (`title`, `slug`, `price`, `bundle_price`, `items`, `available`, …) is `UNKNOWN_FIELD`, class `structure`: an error in a draft and at publish, so nothing holding it is ever saved. A value that is not an object, or an id that is not a string matching the pattern, is `INVALID_VALUE`, class `structure` ("The bundle couldn't be read. Choose the bundle again."): ids are picked, never typed, so a bad one is a wrong shape. `empty()` is `v == null`; a required bundle left `null` is `REQUIRED`, `incomplete` in a draft and an error at publish. Control `bundle`.
- `bundle_list`: `[{ id }]`, in order. At most the setting's `max`, or `BUNDLE_LIST_MAX = 12` when it declares none. More is `INVALID_VALUE` "A grid shows at most <max> bundles." (class `invalid`). The same id twice is `INVALID_VALUE` "This bundle is already in the grid." on the second one (class `invalid`). Each item is checked like a `bundle` value (unknown keys `UNKNOWN_FIELD` structure). Not a list: `INVALID_VALUE` structure. `empty()` is `null` or `[]`. Control `bundle_list`.
- `refsOfSetting` gives `{ field, ref: "bundle", id }` for both (`bundles.2` for the third grid entry).
- Labels come from each declaration (P5-BLOCKS declares "Bundle" and "Bundles to show").

Why `invalid` and not `structure` for the duplicate and the over-max: they are a founder's choice that breaks a rule, like `TOO_MANY` on the other lists. In a draft, inside a section, they are kept as `incomplete` (PV-02) and publish refuses them. The brief names the code `INVALID_VALUE` for both, so the code is not `TOO_MANY` / `DUPLICATE`.

### Words

- `lib/registry/issue-words.js`: `ITEM_NOUN.bundle_list = "bundle"`, so an issue on the third grid entry reads "Bundle grid · Bundles to show · bundle 3".
- `lib/documents/diff.js`: `ITEM_NOUNS.bundle_list = "bundle"`, and `settingPhrases` words the two kinds by what happened, ids only and no title lookup:
  - `bundle`: "added a bundle", "removed a bundle", "changed the bundle";
  - `bundle_list`: "added a bundle", "removed 2 bundles", "changed a bundle" (one swapped for another), "reordered the bundles".

  These are verb first ("Bundle grid: added a bundle"), as the acceptance item words them, where other lists read noun first ("FAQ: a question added"). `bundle_list` is deliberately **not** in `NAMED_LISTS`: a grid holds one list and the row already starts with the section's name; naming it would read "added a bundle to bundles to show".

### References (`lib/documents/refs.js`)

`rowOf` turns a `bundle` setting ref into `['bundle', id]`. `fromHref`'s `/bundles/<slug>` link stays `['bundle', slug]`. The header comment now says so: block refs are keyed by id, link refs by slug (known limit below). `document_refs` (0023) already allows `ref_type 'bundle'`; no migration.

### Fixtures (`lib/registry/fixtures.js`)

`isList` knows `bundle_list`; `fill` gives `{ id: "bun-worst" }` for `bundle` and `bun-worst-1` … `bun-worst-N` for `bundle_list`; `listMax` uses `BUNDLE_LIST_MAX` (12) for a bundle list with no declared max, so the `max_items` case holds 12 ids. The render data a bound bundle gets (`catalog()`) is P5-BLOCKS'.

### The inspector suite (`scripts/test-editor-inspector.js`)

Batch 2 registers `bundle_card` and `bundle_grid` before P5-EDITOR adds their controls, and BLOCKS may not edit this suite. So, now:

- `bundle` and `bundle_list` are in `WAITING_KINDS` (comment: P5-EDITOR removes them).
- `WAITING_PROBLEMS` became `waitingProblems()`, worked out when asked: the waiting kinds, the fixed document-type lines (unchanged), and for every `Reg.sectionKinds()` kind, every setting whose kind waits: `section kind "<kind>": setting "<key>" has no control` (what `inspectorCoverage` reports at `inspectorModel.js` line 182). In batch 1 that adds nothing; in batch 2 it absorbs `bundle_card.bundle` and `bundle_grid.bundles`.
- The section-field loop of `renderAll` now skips waiting fields for the anchors check (as the document loop already did), and `checkPlacement` for a section gets the issues minus only those whose field is a waiting setting of that section (`placeableIssues`). Nothing else is skipped.

### The contract suite (`scripts/test-registry-contract.js`)

- The "setting kind ... is declared somewhere" assertion exempts `bundle` and `bundle_list` (`NOT_DECLARED_YET`, commented "declared by bundle_card/bundle_grid in P5-BLOCKS"). Their crafted bad values (`badValues`) are added and run through a throwaway kind, so the batch 2 owner finds them already there.
- The TREE-01 structural test: two tables, `OBJECT_KINDS` (a valid value for every kind whose value is or holds an object: link, cta, image, collection, product, bundle, brand, theme, pairs, overlay, and the items of collection_list, product_list, bundle_list, qa_list, nav_items, gallery) and `PLAIN_KINDS` (text, number, boolean, choice, rich_text, paragraphs, entries, product_ids). Every `SETTING_KINDS` key must be in one of them, so a new kind fails the test until it is placed. There is no `variant` setting kind in the registry (the brief names one): nothing to test, and if one is added it must be placed in a table.

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | test-registry-contract: bundle accepts `{ id: 'bun-…' }` and `{ id: 'bnd_p1c' }`; refuses `{ id, price }`, `{ id, title }` and `{ id, available }` as UNKNOWN_FIELD severity structure; null on a required bundle is incomplete | **DONE** | "P5-SETTING: a bundle setting takes { id } …": `bun-0a1b2c3d4e5f6a7b8c` and `bnd_p1c` give no issue in draft and publish; `price`, `title`, `available` (and `slug`, `bundle_price`, `items`) each give one `UNKNOWN_FIELD` at `bundle.<key>`, class `structure`, severity `error`, in both modes; `null` is `REQUIRED` `incomplete` in a draft (class `incomplete`) and `error` at publish; bad ids are class `structure`; controls and refs. Fails without the change: `section "zz_bundles": setting "bundle" has an unknown kind "bundle"` (run on the base `lib/` with this suite: 5 failed) |
| 2 | test-registry-contract: bundle_list refuses a duplicate id and more than max items, each with the plain message | **DONE** | "P5-SETTING: a bundle list refuses …": duplicate at `bundles.2`, message "This bundle is already in the grid.", error at publish; 13 entries "A grid shows at most 12 bundles."; a declared `max: 3` with 4 "A grid shows at most 3 bundles."; unknown item keys structure; worst cases (12 distinct ids at max) publish clean. Fails without the change (unknown kind) |
| 3 | test-registry-contract: for every object-valued setting kind, a price or stock key is refused as UNKNOWN_FIELD with severity structure in publish mode | **DONE** | "TREE-01: for every object-valued setting kind …": 16 kinds × 7 keys (`price`, `bundle_price`, `compare_at_price`, `inventory`, `available`, `sold_out`, `soldOut`) = 112 cases, each exactly one `UNKNOWN_FIELD` at the right path, class `structure`, severity `error`, on a throwaway home kind validated in publish mode; plus the guard that every kind is placed in a table. Fails without the change (bundle kinds unknown) |
| 4 | test-documents: bundle and bundle_list settings produce document_refs rows ref_type 'bundle' keyed by id; a /bundles/<slug> link still produces ref_id <slug> | **DONE** | "P5-SETTING: a section's bundle and bundle-list settings write document_refs rows …": a throwaway kind plus a banner whose button goes to `/bundles/gym-kit?ref=home`; `refRows` (what the publish build writes) inserted with `refInsertStatements` into the suite's real migrated tenant database; read back: `bnd_p1c`, `bun-0a1b2c3d`, `bun-ffee01`, `gym-kit` (one row per bundle, the repeated id once), and found by target. Fails without the `rowOf` case (checked by reverting it: only `gym-kit` comes back) |
| 5 | test-editor-inspector: bundle and bundle_list are waiting kinds, and the section-field loop skips waiting fields (a throwaway home kind with a bundle setting does not fail the anchors assertion, and inspectorCoverage() for it equals the derived WAITING_PROBLEMS) | **DONE** | "rendered: a throwaway home kind with bundle and bundle-list settings …": `waitingProblems()` names `section kind "zz_bundleprobe": setting "pick" has no control` and `… "grid" …`, and equals `inspectorCoverage()` with the probe registered and after removing it; the probe renders empty, broken (title too long placed, `REQUIRED` on `pick` and the duplicate on `grid.1` not placed) and in every worst case. Fails without the change, each part checked by reverting it: no anchors skip, "pick should render f-sec_bprobe1-pick"; no `placeableIssues`, "no element with id f-sec_bprobe1-pick for REQUIRED on pick"; a fixed list, the coverage `eq` fails. Without the two `WAITING_KINDS` entries the unit coverage test fails (`setting kind "bundle" has no control`) |
| 6 | An issue on bundle_list item 3 says 'bundle 3'; a diff of an added bundle says 'added a bundle' | **DONE** | test-registry-contract (item 2 test): `where()` of the duplicate at `bundles.2` is "Bundle probe · Bundles to show · bundle 3". test-doc-diff "P5-SETTING: a bundle setting and a bundle list give 'added a bundle' …": list add "added a bundle", remove "removed 2 bundles", swap "changed a bundle", reorder "reordered the bundles"; single pick "added a bundle", "removed a bundle", "changed the bundle"; no row holds an id. Fails without the `settingPhrases` cases (checked by reverting them: list add reads "Bundle grid probe: bundles to show changed") |
| 7 | pnpm test is green on the branch (96 suites before SOURCES merges, 98 after) | **DONE** | `pnpm test`: 96 of 96 suites passed on this branch (before SOURCES merges). The 98-suite gate after SOURCES is the integration gate on `cms/phase-1` |

## Tests

- `scripts/test-registry-contract.js`: 3 new tests (bundle, bundle_list, TREE-01) and the bundle bad values in the crafted-values test; every new message also passes the suite's plain-words, shape and code-coverage checks.
- `scripts/test-documents.js`: 1 new test (document_refs rows).
- `scripts/test-editor-inspector.js`: 1 new test (the probe), the derived `waitingProblems()`, the section-loop skips.
- `scripts/test-doc-diff.js`: 1 new test (bundle phrases).

## Known limits

- Block refs and link refs of one bundle are two different keys: a bundle chosen in a section is indexed by its id, a `/bundles/<slug>` link by its slug. Nothing joins the two, and a link to a renamed slug is not followed (plan 3.11, 5).
- The bundle kinds have no editor control yet. Until P5-EDITOR, an issue on a bundle field has an anchor no control renders; the inspector suite leaves exactly those issues out of its placement check.
- Only the id's shape is checked here. Whether the bundle exists, is turned on, or can be bought is P5-CHECKS (publish warnings) and P5-SOURCES / P5-BLOCKS (render states).
- The bundle diff phrases are verb first ("added a bundle"), unlike the other list rows (noun first). Wording sign-off is the owner's.
- `bundle_list` has no hard ceiling on a declared `max`: a declaration could say `max: 50`. P5-BLOCKS declares the grid; 12 is the plan's number.

## From review

(none yet)

## Owner checks

- None that can only be done by the owner for this item alone: nothing here is shopper-visible. The bundle blocks' owner checks are in plan section 4 (P5-DRILLS adds them to MANUAL-CHECKS).
- Sign-off on the wording of the publish diff rows for bundles (verb first, see Known limits).
