# P2-REG: the document registry, as a new pure module

Plan: `docs/cms-reviews/P2-PLAN.md` (decisions 6, 7, 8, 11; batch 2). Spec: DOC-01 to DOC-05 and DOC-07 (section 7.1), sections 8.3 to 8.5. Branch `cms/p2-reg`, cut from `319a20f`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch. New files only, plus the placeholder suite replaced. No migration, no `package.json` change, nothing under `.github/` |
| Locally tested | Yes. After fix round 1: `test:registry-contract` 21 passed, 0 failed, and `pnpm test` 66 of 66 suites passed in 117.3 s. Before that round: `test:registry-contract` 20 passed, 0 failed, in about 0.7 s. `pnpm test` 66 of 66 suites passed in 115.7 s (`test:registry-contract` 0.5 s in the gate). 19 deliberate breaks: 18 caught on their own, and the 19th is a second line behind a check that does catch it (see "Do the tests bite?"). `pnpm build` passed, with only the 2 warnings that were already there (`next.config.mjs` traced through `lib/platform/migrate.js`) |
| Edge runtime | Proven locally: a temporary edge route importing `lib/registry/index.js` was built and called on port 3500 (see "Edge evidence"). The route was removed before the commit and the build re-run |
| Browser verified | **NOT DONE.** Nothing in this item renders. Every section kind at 375, 768 and 1440 wide against `worstCase(kind)` is P2-DRILLS, after P2-SECTIONS adds the renderers |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing imports `lib/registry/` yet. No tenant changed mode. Legacy tenants, today's releases, editors and preview are untouched |

## What and why

`lib/cms/registry.js` claims to be the single source of truth, but `validate.js`, `HomeSections.js` and `ContentPage.js` each branch per kind, defaults fail their own rules, over-long text is cut, and unknown fields are dropped (spec DOC-03 evidence). Documents mode needs one declaration per section kind and per document type that validation, editor controls, link checks, reference scans and worst-case fixtures all derive from.

Plan decision 6: this is a **new** module, `lib/registry/`. The legacy `lib/cms/registry.js`, `validate.js`, `schemas.js` and `store.js` are unchanged and stay on the legacy path. `test-sections` is unchanged.

## The design

All files are pure ES modules: no React, no Next, no `node:`. They import only each other, `lib/cms/issues.js` (and through it `lib/cms/registry.js` and `lib/schema-shape.js`), `lib/sanitize.js` and `lib/brand.js`, all import-free. A test walks the whole import graph.

| File | What it holds |
|---|---|
| `index.js` | The engine: `defineSection`, `defineDocumentType`, lookups (`sectionType`, `documentType`, `allowedKinds`, `protectedKinds`), `singletonTypes()` for `emptyList`, `newSection`, `emptyBody`, `controlsFor`, `controlsForDocument`, `refsOf`, the contract check (`checkSectionContract`, `checkRegistry`). Registers the declarations at load and re-exports everything below |
| `settings.js` | Every setting kind (text, number, boolean, choice, rich_text, paragraphs, qa_list, link, cta, image, collection, product, collection_list, product_list, nav_items, brand, theme, entries): how it is checked, its editor control, the references it holds. Typed links and `isStorefrontHref` |
| `sections.js` | The section declarations: hero, collections, new, banner, rich_text, image_with_text, product_rail, text, faq, plus `product_main` (see below). `LEGACY_KIND_NAMES` |
| `document-types.js` | The document types: announcement, header, footer, design, home, collections_index, product_layout, collection_layout, cart, page, campaign, journal, journal_index, product_content. `HOME_EMPTY_MESSAGE` |
| `validate.js` | `validateDocument(body, {mode, live, documentId})` |
| `body.js` | `ensureIds`, `stripIds`, `documentHash`, `upgradeBody`, `stableStringify`, id minting |
| `text.js` | `sanitize`, `lostBySanitizing`, `isBlank`, `isBlankHtml`, copied from `store.js` |
| `legacy.js` | The pure adapters |
| `fixtures.js` | `worstCase(kind)`, `fixtureDocument(type, sections)`, `WORST_CASE_ASSETS`, `LEGACY_HERO_FIXTURES` |

**Declarations.** A section declares, as in spec 8.5: `kind`, `version`, `label`, `documentTypes`, `settings` (each with `kind`, `max`, `softMax`, `required`, `default`), `bindings`, `blocks` (reserved, `{allowed: [], max: 0}`), `maxPerDocument`, `allowedPositions`, `minItems`, `rules`, `refs`, `migrate`, `placeholder`, `protected`, and `startsIncomplete` (AU-04: "or be marked as a known incomplete state"). A document type declares `sinceManifest`, `singleton` or `route`, `publishable`, `editable`, `index`, document-level `settings`, `sections` and `maxBeforeProtected`.

**Which section kinds a document type allows** comes from each section's own `documentTypes`, as in spec 8.5. That is what lets one declaration add a kind everywhere it belongs, with no other file changed (the DOC-03 test does exactly this). The document type says only whether it holds sections at all; `allowedKinds(type)` gives the list.

**`product_main`** is a tenth section kind, beyond the nine in the brief: the protected product details and buy button. `maxBeforeProtected` (product_layout: 1) needs a protected module to count against. It is allowed only on `product_layout`, at most one, cannot be hidden, and a product layout without it is an error. P2-SECTIONS needs a renderer for it (the "every registered type has a renderer" test).

**Validation result.** `{ ok, issues, body }`. Each issue comes from `issue()` in `lib/cms/issues.js` and has exactly the DOC-04 keys. Problems have four classes:

| Class | Draft | Publish | Examples |
|---|---|---|---|
| structure | error | error | unknown type, kind or field; bad shape or id; duplicate id; a kind not allowed here; second hero; hero out of place; too many above the buy box; a protected module hidden or missing; words sanitizing would lose |
| invalid | error | error | TOO_LONG, OUT_OF_RANGE, INVALID_CHOICE, LINK_NOT_STOREFRONT, IMAGE_INVALID, SLUG_INVALID, an unreadable brand at publish |
| incomplete | `incomplete` | error | a required field empty, a banner with no title or text, a text section with neither title nor paragraph, an enabled announcement with no text |
| warning | warning | warning | over `softMax`, the highlight not in the title, a rail set below 3 products, a button with a link but no text |

Limits are errors in drafts too, as today's save refuses them (AU-05: "refused, never cut"); only missing content is relaxed. Nothing is stripped or cut: the returned `body` keeps an unknown field, an over-long title and a bad link exactly as sent. The one change is sanitized HTML, and only when sanitizing loses none of the founder's words or addresses; when it would, the raw text stays and a `WORDS_LOST` (or `ADDRESS_LOST`, `MEDIA_LOST`, `PICTURE_LOST`) error says so. A caller must not store a body whose `ok` is false.

`issue()` accepts only "error" and "warning", and `lib/cms/issues.js` is on the legacy path and not in this item's files. So an incomplete issue is built as a warning and then marked `incomplete`. `errorIssues()` still finds only errors. A later item that owns `issues.js` can add `incomplete` there.

**Messages** never carry a position. They name things in plain words ("The home page can have only one hero. Remove this extra one.") and the editor places them from `sectionId` and `field`.

**Typed links** (spec 8.5): `{type: "url", href}`, `{type: "collection", handle, id?}`, `{type: "product", handle, id?}`, `{type: "page", slug, family}`. A url link must be a storefront route: the `KNOWN_PATHS` list from `lib/releases.js`, tightened (a product, policy, campaign, quiz, bundle or order route needs a slug), or a `#anchor`. Refused: other sites, `/admin`, `/api/…`, `//host`, `javascript:`, `mailto:`, any path with whitespace, a backslash, `..` or an encoded dot or slash. The check covers every link field: hero and banner buttons, menus, the announcement bar, and any new kind's `link` settings.

**Design document.** `settings: {brand, theme}`. The brand goes through `validateBrand` at every save. At publish, `checkBrand` runs against the live version's brand and theme when `live` is given, so a pair the live store already shows is a warning, not a block (TOK-02, the same as `validateRelease`). The theme must name a kit that `lib/brand.js` knows (`pulse 1`, `glow 1`).

**Home.** A draft may hold zero sections. Publishing with no enabled section gives exactly "Your home page is empty. Add a section or restore the last published version." (`HOME_EMPTY`, field `sections`).

**`product_content`** saves, and publish mode gives `PUBLISH_NOT_AVAILABLE` until OVL-02. **`journal_index`** is a system type: `editable: false`, no sections, not a singleton (it is `indexes.journal` in the release list).

**`singletonTypes()`** returns announcement, header, footer, design, home, collections_index, product_layout, collection_layout, cart. `emptyList(m, singletonTypes())` lists each as an explicit null.

**Ids and hashing.** `ensureIds` keeps a valid, unique `sec_`/`blk_` id and mints the rest with Web Crypto. `documentHash` is SHA-256 of the canonical form of `stripIds(body)`, so two bodies that differ only in their ids hash the same, while content and order still count. `upgradeBody` runs each section's pure `migrate` steps (keyed by the version they start from) up to the kind's current version, never changing its input. `validateDocument` validates and returns the upgraded body.

**Adapters** (`legacy.js`). The rule is the brief's: an adapter never drops a legacy field, even one that fails validation; it carries the value and validation reports it.
- `legacyHeroToSettings` turns `{label, href}` buttons into `{label, link: {type: "url", href}}` and carries every other field as it is, including fields nobody declared. `settingsToLegacyHero` reverses it exactly; only the new `image` is left out, since the legacy hero cannot hold one. `legacyHeroToSection` lays the legacy values over the declared defaults with the fixed id `sec_hero`.
- `legacyAnnouncementToSettings`: `href` becomes `link` (an empty href, the legacy "no link", becomes `null`).
- `legacyHomeSectionsToSections`: ids exactly as `lib/cms/schemas.js` stamps them at read (a valid id kept, even a duplicate, which validation then reports; anything else `sec_l<i>` by position in the stored list). Banner and image-with-text buttons, images and the rail's collection change shape; every other field is carried.
- `legacyPageSectionsToSections`: page sections through `LEGACY_KIND_NAMES` (`rich` is `rich_text`, `image` is `image_with_text`, `heading` is `title`), with ids as `normalizePageSections` stamps them.

**`controlsFor(kind)`** gives `[{key, control, kind, label, required, max, softMax, min, options, default, …}]` from the settings. **`refsOf(section)`** gives `[{field, ref: "link" | "media" | "collection" | "product", …}]` from the settings plus the declaration's own `refs`.

**`worstCase(kind)`** gives `{kind, cases: [{name, section, data}]}`, with the cases the kind can have: `long_text` (every text at its limit, long product and collection names), `no_image`, `tall_image` (600 x 2400), `one_item`, `max_items`, `sold_out`. `data` is the catalog data a renderer would get for the section's bindings, with `soldOut` markers (the last product is sold out in every case, so "some sold out" is always shown; `sold_out` marks all). The title is 120 characters where the title allows 120 (hero, rich text, text, FAQ, image with text). Where the declared max is lower (80 on collections, new, banner and rail titles) the fixture uses the max, so every fixture stays valid content. `WORST_CASE_ASSETS` lists the two image paths and their sizes, for P2-DRILLS to serve. `fixtureDocument(type, sections)` wraps sections in a valid body, with the protected module placed within `maxBeforeProtected`.

## Acceptance

Every test below fails without this change: before it, `lib/registry/` does not exist and the suite was the placeholder. "Bite" names the deliberate breaks (next section) that each test catches.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | A fake section type registered inside the test gets validation, typed-link checks, `controlsFor`, `refsOf`, `worstCase` and document-type selection with no other file changed | **Pass** | "a fake section type registered here …": `defineSection` in the test only; home and page offer it, the product layout refuses it (`KIND_NOT_ALLOWED`); its own max and required apply; a url link to `https://evil.example` gives `LINK_NOT_STOREFRONT`; controls, refs and worst cases come out right; its contract check is clean; it is removed again. Bite: "allow any link", "kind check off", "worst title short" |
| 2 | Every declared default validates clean in publish mode; a fake type whose default breaks its own rules fails the contract check | **Pass** | "every declared default …": `checkRegistry()` is `[]`; each declared default passes its own setting's checks; a new section of every kind not marked `startsIncomplete`, on every document type it names, has zero issues in publish mode; the six marked kinds (banner, rich_text, image_with_text, product_rail, text, faq) save as drafts with only `incomplete` issues; every document type's empty body saves as a draft. "a fake type whose default …": an over-long default, a default its own rule refuses and a choice default outside its options each fail `checkSectionContract` and `checkRegistry`. Bite: "incomplete always error" |
| 3 | An undeclared field gives `UNKNOWN_FIELD` naming the sectionId and field, and the value stays; a 200-character title against max 80 gives `TOO_LONG`, not truncated | **Pass** | "an undeclared field …" (settings, section and body level, both modes, value kept, input untouched) and "a 200-character title …" (both modes, all 200 characters kept; `softMax` is only a warning). Bite: "strip unknown settings", "truncate TOO_LONG" |
| 4 | A hero link to `https://evil.example` or `/admin` gives `LINK_NOT_STOREFRONT`; `/collections/x` passes | **Pass** | "a hero link to …": both, plus `//evil.example`, `javascript:`, `/collections/../admin`, `%2e%2e`, `/api/admin/releases`, `mailto:` and `/products/`, in both modes and on both buttons, value kept; `/collections/x` and 7 other storefront routes publish clean; menus and the announcement bar use the same check. Bite: "allow any link" |
| 5 | A new banner with no text is `incomplete` in draft mode and `error` in publish mode | **Pass** | "a new banner with no text …", also a rail with no collection; `ok` is true for the draft and false at publish; a structure error stays an error in a draft. Bite: "incomplete always error" |
| 6 | A `<script>` in rich_text is removed in both modes, and `lostBySanitizing` reports dropped words | **Pass** | "a <script> in rich_text …": `<p>Hello</p><script>alert(1)</script>` comes back as `<p>Hello</p>` in both modes, FAQ answers too; `Buy 2 < 3 and save > 10%` gives `WORDS_LOST` naming the lost words, in both modes, with the text kept as typed. Bite: "no sanitizing" |
| 7 | A second hero, a hero outside `allowedPositions`, a kind not allowed on the document type, and a product_layout breaking `maxBeforeProtected` each give a structured error with a plain message | **Pass** | "a second hero, …": the exact messages are asserted, each on the offending section's id; no message holds an underscore; the first hero and the first section above the buy box are not flagged; a missing or hidden buy box is also refused. Bite: "hero twice allowed", "drop maxBeforeProtected", "kind check off" |
| 8 | Publish-mode validation of home with zero enabled sections returns the exact "Your home page is empty…" message | **Pass** | "publishing home with zero enabled sections …": no sections, and one disabled section; the draft saves. Bite: "drop home empty rule" |
| 9 | `legacyHeroToSettings` turns the experiment-variant, AI-proposal and agency-kit fixtures and every `kits.js` preset into hero sections; `settingsToLegacyHero` round-trips full heroes; a legacy hero with an invalid link keeps the link value | **Pass** | "legacyHeroToSettings turns …" (3 fixtures plus both kit presets, each publishes with zero issues); "settingsToLegacyHero round-trips …" (agency kit, `defaultHero("Acme")`, both presets and a hero with null buttons come back deep-equal; `javascript:alert(1)` and `https://evil.example` hrefs and an unknown `tagline` field are kept, reported and round-trip). Bite: "adapter drops bad href" |
| 10 | Bodies differing only in `sec_` or `blk_` ids have equal `documentHash`; `legacyHomeSectionsToSections` stamps `sec_l<i>` as `lib/cms/schemas.js` does | **Pass** | "bodies differing only …" (content and order still change the hash) and "legacyHomeSectionsToSections stamps …" (compared with `upgradeBlock("home_sections", …)` on a list with a missing id, a bad id and a duplicate; page sections against `normalizePageSections`). Bite: "hash keeps ids", "legacy ids off by one" |
| 11 | No `lib/registry` file imports react, next/* or node:*; no issue message matches `/Section \d+ \(/` | **Pass** | "no lib/registry file imports …" walks every relative import from `lib/registry/*.js` (it reaches `lib/cms/issues.js` and beyond) and refuses react, next, any Node built-in, any package, `require(`, `process.`, `Buffer` and `__dirname`. "every issue has the DOC-04 shape …" checks all 165 issues the suite produces: exact keys, severity, no position, no `undefined`, `null` or `[object Object]` in a message. Also proven on the real edge runtime (below). Bite: "node import", "react import", "next import", "positional message" |

### Requirements, and what is left for later items

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| DOC-01 | An unregistered type is refused (`UNKNOWN_TYPE`); the body reserves `blocks` in every section; ids mint and stay; the id-stripped hash | Storage, the revision, versions (P2-DOCS); backfill ids (MIG-01) |
| DOC-02 | The pure adapters, by fixture: old-shape experiment, AI and kit payloads give valid hero sections | Moving the four bypass writers to the service, the adopt merge that keeps buttons and badge (P2-WRITERS); the 409 and 428 paths (P2-DOCS) |
| DOC-03 | One declaration is enough (fake type); defaults pass their own rules; unknown fields refused, not stripped; composition guards; `minItems` on the rail (a warning when set below it) | Renderer map and its test, the shopper state table, rendered worst cases (P2-SECTIONS, P2-DRILLS); refusal at add and move (ED-02) |
| DOC-04 | The issue shape on every issue, section id and field named, no positional messages | 5xx for database failures and the failure matrix rows (P2-DOCS, P2-PUBLISH) |
| DOC-05 | Draft `incomplete` versus publish `error`; structure and sanitizing not relaxed; script stripped | Save and publish flows that use it (P2-DOCS, P2-PUBLISH); schedule (PUB-07) |
| DOC-07 | The hero section with an image setting, at most one, first only; the exact empty-home message; an empty home draft saves | Rendering the hero image, migrated hero equivalence (P2-SECTIONS); a running experiment after migration (P2-WRITERS, MIG) |

## Do the tests bite?

Each break was applied alone to the finished code, the suite run, and the file restored (the script is in this item's scratch folder, `breaks/run.py`).

| Break | Caught by |
|---|---|
| truncate an over-long text | the TOO_LONG test |
| `isStorefrontHref` allows anything | fake type, link test, legacy invalid-link test |
| incomplete is always an error | defaults test, contract test, banner test |
| drop the empty-home rule | the empty-home test |
| drop the `maxBeforeProtected` check | the composition test |
| the hash keeps ids | the hash test |
| legacy ids off by one | the adapter test and the `sec_l<i>` test |
| an adapter drops an href that isn't a path | the kit and fixture test, the round-trip test |
| unknown settings stripped | the UNKNOWN_FIELD test and two adapter tests |
| no sanitizing | the script test |
| a message with "Section 1 (Hero)" | the wording test |
| `import "node:fs"`, `import { cache } from "react"`, `export … from "next/navigation"` | the import walk (the first was missed until the walk also read bare `import "x"`; fixed) |
| hero `maxPerDocument` removed | the composition test |
| the kind-allowed check off | fake type and composition tests |
| worst-case titles short | fake type and worst-case tests |
| design ignores the live brand | the document-type test |
| the contract check skips the per-setting default step | not caught alone: the same broken defaults are also caught by the contract's new-section step, so that step is a second line, not the only one |

## Edge evidence

A temporary route, `app/api/p2reg-probe/route.js` with `runtime = "edge"`, imported `lib/registry/index.js`, validated a home body, hashed it and listed kinds, singletons and worst cases. `pnpm build` compiled it into the edge middleware manifest (`/api/p2reg-probe/route`). `next start -p 3500` served it: HTTP 200 with `"edge": true` (the `EdgeRuntime` global), the script stripped (`"html":"<p>Hi</p>"`), `LINK_NOT_STOREFRONT` for an evil link, a 64-character hash, all 10 kinds and the 9 singletons. The server was stopped, the route deleted, and `pnpm build` re-run on the committed tree (no probe route in the output).

## Tests

- `scripts/test-registry-contract.js` replaces the P2-ATOM placeholder (same `test:registry-contract` script, `package.json` unchanged). 20 tests, about 0.7 s. It needs no database: only `lib/themes/kits.js` (for the kit presets) loads the database layer, pointed at a throwaway folder that is removed at the end.
- `pnpm test`: the first run on this branch failed only `test:copy`, because two fixture strings used nutrition words (the copy scan reads `lib/`). They were reworded; `test:copy` then passed 53 of 53, and the full run passed 66 of 66 suites in 115.7 s.

## Fix round 1

The review found that several lookups read a plain object with a name taken from the body, so names that every object inherits (`constructor`, `toString`, `__proto__` and the like) were treated as known:

- A page link with `family: "constructor"` passed publish-mode validation with no issues, and `linkHref` (and so `refsOf`) returned `function Object() { [native code] }x`, which a renderer would have put in a shopper's link.
- A link of type `constructor` or `__proto__`, or a `bindings` key such as `toString`, threw a `TypeError` instead of returning issues (a 5xx where DOC-04 wants a 422).
- In the legacy adapters, a section of kind `toString` had its settings replaced by a string, one of kind `constructor` lost its kind, and a legacy field named `constructor` on a page section threw while renaming fields.

Fix: each file in `lib/registry/` that looks names up in a table now uses a small `own(table, name)` helper (`Object.hasOwn`, strings only). It is used for `PAGE_FAMILIES` and `LINK_KEYS` (in `checkLink` and `linkHref`), the declared `bindings` in `validate.js`, `HOME_MAPPERS`, `LEGACY_KIND_NAMES` and the field renames in `legacy.js`, and the setting-kind check in `defineSetting`. Section kinds and document types were already looked up in `Map`s; a probe confirmed `constructor`, `toString` and `__proto__` as a section kind, a document type or a settings key each come back as one plain issue (`UNKNOWN_KIND`, `UNKNOWN_TYPE`, `UNKNOWN_FIELD`).

Tests, both failing before the fix (`linkHref family constructor expected null, got "function Object() { [native code] }x"`, and `Cannot read properties of undefined (reading 'includes')`):

- in the link test: four inherited names as a page family give `linkHref` null, one `LINK_INVALID` on `primary.link.family`, `ok: false` in publish mode, and nothing function-like from `refsOf`; three as a link type give one `LINK_INVALID`;
- a new test: inherited names (including a real `__proto__` own key) as a `bindings` key give one `UNKNOWN_FIELD`; legacy home and page sections of four inherited kinds keep their kind and their fields; legacy page fields named `constructor` and `toString` are carried as they are.

## Known limits

- **External links are refused in documents mode.** A url link must be a storefront route, so a banner to Instagram or WhatsApp gives `LINK_NOT_STOREFRONT`. This is what the brief asks; today's legacy path allows full https URLs. A migrated section with an external link keeps the link and is reported, so publishing it would be blocked unless the PUB-03 inherited rule covers it. An owner decision (below).
- **Migrated banners with button text but no link** (legacy hides that button) come over as a button with no link, which is `incomplete`, so an error at publish, again unless the inherited rule applies.
- **Positions count hidden sections.** "The hero first" and `maxBeforeProtected` count every section in the list, shown or hidden. Simple and predictable; a hidden section above the buy box still uses the one slot.
- **`incomplete` is set after `issue()`** builds the issue as a warning (see the design). A later item that owns `lib/cms/issues.js` should accept it there.
- **The cart document's settings** (a title and up to 8 suggested products) are a first shape; nothing writes `doc_cart` in phase 2.
- **`product_content` and `journal_index`** have no settings or overlay fields yet (OVL-01, OVL-02).
- **No responsive settings yet.** `mobile` overrides are reserved: any key in `mobile` is reported as `UNKNOWN_FIELD` until a setting is declared responsive (TOK).
- **`worstCase` titles** are at the declared max, which is 80 for collections, new, banner and rail titles, not 120.
- **The brief's "every declared default validates clean in publish mode"** holds for every kind except the six AU-04 lets start incomplete; those are held to "only incomplete issues as a draft", and each of their declared defaults still passes its own checks.

### From review

Non-blocking findings from the independent review, added at merge.

- Earlier blocker resolved, reproduced at e1d51c6. A page link with family 'constructor', 'toString', '__proto__' or 'hasOwnProperty' now gives one LINK_INVALID error and ok:false in publish mode, and linkHref returns null. Link type 'constructor', '__proto__' or 'toString' gives LINK_INVALID with no throw. A bindings key 'toString', '__proto__' or 'constructor' gives UNKNOWN_FIELD with no throw. Section kind, document type, a settings or meta '__proto__' key, and a bad v ('constructor', 0, -5, 1e9) each come back as a plain issue, never a throw. Legacy home and page sections of kind toString, constructor or __proto__ keep their kind and their fields.
- Mutation check on the fix: putting back the plain lookup in each of the 7 body-facing spots (linkHref family, checkLink family, link type, bindings, HOME_MAPPERS, LEGACY_KIND_NAMES, renames) makes test:registry-contract fail. The 8th spot, the setting-kind check in defineSetting, is not covered by a test: the plain lookup survives. It only runs on code declarations, not on founder data, so it is low risk. A test that defines a setting of kind 'constructor' and expects a throw would cover it.
- legacyHeroToSettings and settingsToLegacyHero (lib/registry/legacy.js lines 59 and 68) copy fields with out[k] = v. A legacy hero parsed from JSON with its own '__proto__' key loses that field: the output keeps only 'title', and the value becomes the object's prototype, so its fields can be read through inheritance without being reported. This breaks the never-drop rule only for a key that no real hero holds, and nothing imports lib/registry yet. Fix: build out with Object.defineProperty, or start from Object.create(null), or report the key. renameFields and HOME_MAPPERS outputs use the same out[k] = v pattern.
- Link probes all behave as specified. '//evil', '/\\evil.example', a trailing newline, %2f%2f, '..' traversal, uppercase '/Collections', '/pages/x', '#', a leading space and javascript: are all refused. '/collections/x', with a ?query or a #anchor, and '/cart' pass. Collection handles containing '..', '%2e%2e', '?' or upper case are refused. '/collections/∕∕evil' (Unicode division slashes) passes. It is only a same-site path segment and does not open another site, so it is noted, not a problem.
- Checks run: test:registry-contract 21 of 21 passed. pnpm test 66 of 66 suites passed in 111.9 s; it needed --config.verify-deps-before-run=false because node_modules in the worktree was a symlink. The fix touches only lib/registry/ and its own test and doc (11 files since 319a20f, all new or the placeholder suite). lib/cms, package.json and .github are unchanged, so legacy tenants, releases, editors and preview are not affected. The fix adds only Object.hasOwn, which the edge runtime supports. No build or edge route was re-run in this round. Review worktree rv1 was removed, and ports 3600 and 4600-4609 are free.

## Owner checks

1. Decide whether documents mode should allow links to other sites (social, marketplaces) through an explicit "external link" type, or keep refusing them. Until then, migrated external links block publish unless the inherited rule covers them.
2. `maxBeforeProtected` on the product page is 1, a hypothesis (spec DOC-03). Confirm, or give the number.
3. The `doc_cart` capability ruling (`upsells.write` versus `storefront.*`), already in the plan's list; also confirm the cart settings shape.
4. When P2-DRILLS runs, look at the worst-case screenshots for every kind at 375, 768 and 1440 (this item only supplies the fixtures).
