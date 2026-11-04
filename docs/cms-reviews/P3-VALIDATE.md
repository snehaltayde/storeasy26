# P3 · VALIDATE · One broken section never blocks the rest, plain words, good starter sections

Branch `cms/p3-validate`, cut from `407b88a`. Plan: `docs/cms-reviews/P3-PLAN.md` (decision 9, "PV-02 draft mode", "SectionView isolation", "VALIDATE's grep"; batch 1) and `P3-BATCHES.json`. Requirements: PV-02, AU-02, AU-04. No migration. No new dependency. No real tenant changes mode. Legacy editors, releases and preview are unchanged (their suites pass unchanged).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 128.2 s. `pnpm build` passes (the 2 Turbopack warnings about `next.config.mjs` tracing are there on the base commit too) |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a unit or rendered (SSR) test below. No desktop Chrome drill ran: there is no editor page yet to drive (P3-EDITOR, batch 4). No server was started; ports 3680 and 4680 to 4689 were not used |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

1. **PV-02, draft tolerance** (`lib/registry/validate.js`). Before, one half-typed field anywhere (a banner button pointing at another site, a title one character too long) made `saveDraft` answer 422 and store nothing, so the founder's other edits (the hero title they just typed) were not saved either. Now, in draft mode only, these issues get severity `incomplete`: they are stored with the draft, ride along on the 200, the section previews as its unfinished note, and publish still refuses them as errors:
   - any issue of class `invalid` inside a section (it has a `sectionId`);
   - a page's `meta.title` or `meta.description` over its length limit;
   - a link of a menu item (`items.N.link…` and `items.N.children.M.link…` of a `nav_items` setting: header and footer).

   Still errors in a draft (422, nothing stored): every `structure` issue, and `SLUG_INVALID` anywhere (the web address is the uniqueness key in `documents.slug`; P3-STORE sends the last saved address while the field is invalid). Other document-level `invalid` issues (an announcement bar link, a date window, a collection both shown and hidden) also stay errors: the brief names only meta lengths and menu links. Publish mode is unchanged. The issue class (`cls`) is never changed, so publish's `classify()` sees exactly what it saw before, and `test-publish-service` passes untouched.
2. **AU-02, where and anchors** (new `lib/registry/issue-words.js`, exported from `lib/registry/index.js`):
   - `where(issue, body)` gives plain words from the registry labels: `Banner · Button`, `Text · Paragraphs · paragraph 3`, `FAQ · Questions · question 2 · answer`, `Header menu · Menu items · item 1 · sub-item 2`, `Page · Title`, `Page · Web address`. The body is needed to know a section's kind (an issue carries only its `sectionId`). Without it a section issue reads `Section`.
   - `fieldAnchor(issue, { known? })` gives `f-<sectionId|doc>-<field path, "." as "-">`, for example `f-sec_hero-title`, `f-sec_t1-body-2`, `f-doc-meta-title`. With `known` (a Set of anchors or a function) it falls back step by step to the closest field the form renders, down to the top-level setting key (`primary.link.href` gives `f-sec_hero-primary`). `anchorFor(sectionId, field)` is the same without an issue.
3. **AU-02, plain messages** (`lib/registry/settings.js`, `sections.js`): the brand errors came straight from `lib/brand.js` in code words ("type_scale must be one of compact/regular/large", "accent must be a 6-digit hex color (e.g. #84cc16)", with no full stop). They are now plain sentences per setting ("The text size isn't one of the choices. Pick one again."). The list-limit message read "The questions has 31 questions"; it now reads "The questions list has 31 questions, and the limit is 30. Remove one question." The system list message gained "Reload the page and try again.". No other registry message used CTA, href, handle or slug.
   - `HIGHLIGHT_NOT_IN_TITLE` is still a warning, now on the hero's **title** field (where the founder is typing when the words stop matching), with the words "…Pick words from the title to highlight."
4. **AU-04, starter sections** (new `lib/registry/starter.js`): `starterSection(kind, { collections, id })`. A product rail binds to the first collection with at least `minItems` available products, else the first non-empty one, as `{ handle, id }`, so it shows real products and publishes clean. With no usable collection it is exactly `newSection(kind)`. Every other kind is `newSection(kind)`: the text kinds stay incomplete with their placeholder and carry no made-up copy that could be published. Collections are `[{ handle, id?, available_count?, product_count? }]` (the repo's `product_count` plus an available count).
5. **PV-02, rendering** (`components/sections/index.js`, `lib/cms/section-data.js`):
   - `SectionView` calls a server section's component as a plain function inside `try` (and awaits it when it returns a promise, through an async `SettledSection`). A throw in that section's own render is caught. In the founder's preview the section renders as a note titled "This section couldn't be shown" ("Something went wrong while showing this <kind> section. Only you can see this note in your preview…", `data-unfinished` and `data-section-failed`). Live, the section is left out, every other section renders exactly as without it, and a `section_render_failed` log line names it.
   - `resolveHomeSectionData` settles each binding on its own. A read that throws leaves that binding out and lists it in `data.bindingFailed`, with a `section_binding_failed` log line; the map then treats that section as failed (live: left out; preview: the note). A failed curated-collections read or pins read is never replaced by a guess (the uncurated list, the unpinned order): the sections that needed it fail instead.
   - Preview or live: `ctx.preview` when a caller passes it (P3-FRAME adds it, plan decision 10); otherwise `isPreviewRequest()` (in `section-data.js`) reads the request's `contentSource()` inside `tfetch`, loaded with a dynamic import only when a section has failed. A static import would have pulled `next/headers` into every suite that renders the map (found by `test-page-editor`). Any doubt answers live (leave it out).
   - The hero's exception to the unfinished note now holds only while all the hero lacks is words. A hero draft holding a broken value (a link off the store, an insecure image) previews as its note, so a stored bad link never renders in the preview.
   - A healthy page stays synchronous: no section that renders fine goes through an async component, so `renderToStaticMarkup` output (and the a6d028e equivalence) is unchanged.

## Not caught by SectionView (server rendering has no error boundary)

A throw inside a child component a section renders, or inside a `"use client"` component, still fails the page as before:

| Section kind | Children not covered |
|---|---|
| hero | `StoreImage` (next/image), `ExperimentNote`, next/link |
| collections | `CollectionCard`, next/link |
| new | `ProductGrid` / `ProductCard` |
| product_rail | `ProductGrid` / `ProductCard`, next/link |
| faq | `FaqSection` (a `"use client"` component) |
| banner, image_with_text | next/link, `MediaFallback` |
| product_main | whatever the route hands in as `ctx.productMain` |
| rich_text, text | none |

No section component is itself `"use client"` today. If one becomes one (or a memo/forwardRef wrapper), `SectionView` renders it as an element, uncaught, as before.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| unit (test-documents): saveDraft of a home body with a banner LINK_NOT_STOREFRONT and a hero title edit is 200; hero edit stored; severity incomplete; publish 422 naming the banner | Done | `test-documents` "saveDraft of a home body with a banner link that isn't a store page…": 200, stored title, issue `[sec_bnbad, button.link.href, incomplete]`, `where` = `Banner · Button`; publish 422 whose only errors are on `sec_bnbad`, storage unchanged. Fails on the base `validate.js` (422 at save) |
| unit: too-long page title or nav bad link 200 incomplete; SLUG_INVALID or structure 422 nothing stored | Done | `test-documents` "saveDraft of a page with a too-long title, or a menu item with a bad link…" (also createDocument); `test-registry-contract` "PV-02: in a draft, a page title or description…"; `test-failure-matrix` row "documents: a web address that isn't valid". Fail on the base `validate.js` |
| unit (test-registry-contract): every message from worstCase() plus crafted bad values for every setting kind and rules() is non-empty, a sentence, no position, no CTA/href/handle/slug outside quoted values | Done | "AU-02: every message seen…" over 838 issues and all distinct messages; bad values for every setting kind of every section and document type, and every section and document `rules()`. Fails on the base `settings.js` (the brand messages are not sentences) |
| unit: coverage scan of lib/registry/*.js codes against the corpus | Done | "coverage: every code lib/registry/*.js can report is in this suite's corpus…": 40+ codes scanned (labels taken out), none missing; a planted code is reported, so the scan bites |
| unit: fieldAnchor stable and unique per (section, field); where() names section and field labels for every kind; text paragraphs are body.N | Done | "AU-02: fieldAnchor is f-<section\|doc>-<path>…" (over 100 anchors) and "AU-02: where() names the section and the field…" (every kind, every document type; a 4001-character third paragraph reports `body.2`, `Text · Paragraphs · paragraph 3`, `f-sec_t1-body-2`). Fail without the new module |
| unit (AU-04): every kind's starterSection saved by saveDraft is 200, previewDraftBody plus a render doesn't throw; rail with collections publishes clean; no collections equals newSection | Done | `test-sections-render` "AU-04: every registered kind's starterSection…" (real service, real tenant collections, previewDraftBody, SectionView render; the rail shows real products); `test-registry-contract` "AU-04: starterSection binds a new product rail…". Fail without the new module |
| rendered (test-sections-render): a throwing server section shows the note in preview, others render; live healthy output unchanged, no note; one failing binding doesn't blank the page; a6d028e equivalence passes | Done | "a server section whose own render throws…" (a sync and an async thrower, through the real `page.js`: live HTML equals the page published without them, log lines; the preview shows both notes); "one failing data binding does not blank the page…"; the 10 a6d028e equivalence tests pass unchanged. The first two fail on the base `index.js` and `section-data.js` |
| unit: HIGHLIGHT_NOT_IN_TITLE stays a warning with a plain message on the hero title field; failure-matrix legacy rows unchanged | Done | "AU-02: HIGHLIGHT_NOT_IN_TITLE stays a warning, on the hero's title field…" (fails on the base `sections.js`: the field was `highlight`); no legacy row of `test-failure-matrix.js` was edited, 124 of 124 pass |

Also: "PV-02: a hero draft holding a broken value… previews as its note" (`test-sections-render`; fails on the base `index.js`, which rendered the off-store link in the preview).

## The grep before changing expectations (brief item 6)

`grep` over `scripts/test-*.js` for saveDraft or createDocument cases expecting 422 on an in-section TOO_LONG or LINK_*, a meta length or a nav link. Found only in `test-registry-contract.js` (2 tests: the 200-character title and the hero link, both asserting `error` in draft mode). They now assert `incomplete` in a draft and `error` at publish. The other 422 cases found (`test-documents` structure, `test-writers` structure, `test-failure-matrix`, `test-page-editor`, `test-cms-api` and others) are structure cases or legacy writers, and still pass unchanged. **`test-publish-service.js` needed no change**: it passes as it was.

## Tests

| Suite | Result | Time |
|---|---|---|
| `test:registry-contract` | 31 passed (8 new, 2 changed) | 0.6 s |
| `test:documents` | 40 passed (2 new) | 1.4 s |
| `test:sections-render` | 36 passed (4 new) | 1.2 s |
| `test:writers` | 21 passed (1 extended: an agency kit with an off-store banner link saves, incomplete; publish refuses) | 0.9 s |
| `test:failure-matrix` | 124 passed (2 new documents rows) | 23.1 s |
| `test:publish-service` | unchanged, passes | 1.6 s |
| `pnpm test` | 81 of 81 | 128.2 s |

Do the tests bite: each new test was run with the matching file put back to `407b88a` (`validate.js`, `settings.js`, `sections.js`, `components/sections/index.js` + `lib/cms/section-data.js`) and failed as listed above.

## Known limits

- **A menu item's broken link shows as typed in the founder's preview** (the header and footer have no section note). Only the founder's preview, never shoppers (publish refuses it). A `javascript:` address can't run: React 19 replaces it (a test pins this). An off-store address is clickable in the preview.
- **Field paths are validate's stored keys**, not the names in P3-FRAME's brief: an FAQ's question and answer are `items.N.q` and `items.N.a` (not `question`/`answer`), and the hero's buttons are `primary.label` and `secondary.label` (there is no `buttons.N`). FRAME and INSPECTOR should use these exact paths for `data-field` and the field ids.
- `lib/admin/documents-api-shapes.js` still shows the old example anchor (`doc_home/sec_hero/title`) and where (`Hero, title`). P3-COMMIT owns that file and its brief says to switch it to this format (`f-sec_hero-title`, `Hero · Title`).
- `where()` needs the body to name a section's kind. P3-CHECKS has the bodies at publish.
- A section left out live because it failed still counts as "something rendered" for the empty-page note (`HomeSections` renders the note only when nothing shows). A home whose every section fails and that has no hero shows an empty area, not the DOC-03 message.
- A failing first "newest products" section takes the `#new` anchor with it.
- Children and `"use client"` components are not covered (table above).
- `scripts/drills/p2/results-policy-typo.json` (a recorded drill result) still shows the highlight warning on `highlight`. It is a record of that run, not a test.
- `lib/content/documents-reader.js` `heroFromSection` (the legacy-shaped hero reader) still shows the placeholder for any unfinished hero. No page renders the hero through it today; the home page uses `SectionView`.

## Owner checks

- **Decision 9 ruling:** a draft now stores in-section broken values, over-long page titles and descriptions, and menu items' bad links as incomplete (200), where phase 2 refused them (422). Publish still refuses them.
- **Phones and desktop:** in a documents-mode preview, a banner with an off-store button, a hero with an off-store button and a section that fails to render each show their note, and the live page shows neither the note nor the section.
- **Hosted:** a `section_render_failed` / `section_binding_failed` line appears in the Vercel log search for a forced failure on a staging tenant.

## Files

`lib/registry/validate.js`, `lib/registry/settings.js`, `lib/registry/sections.js`, `lib/registry/index.js`, new `lib/registry/issue-words.js`, new `lib/registry/starter.js`, `components/sections/index.js`, `lib/cms/section-data.js`, `scripts/test-registry-contract.js`, `scripts/test-documents.js`, `scripts/test-sections-render.js`, `scripts/test-writers.js`, `scripts/test-failure-matrix.js` (documents rows only). All edge-safe: no `node:` import (the registry and sections edge checks pass).

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:registry-contract && pnpm test:documents && pnpm test:sections-render
pnpm test:writers && pnpm test:failure-matrix && pnpm test:publish-service
pnpm test
pnpm build
```
