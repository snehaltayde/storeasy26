# P2-SECTIONS: the hero is a real section, and every section renders through one map

Branch `cms/p2-sections`, cut from `f893710`. Plan: `docs/cms-reviews/P2-PLAN.md` (batch 5, sections 0, 3, 4 and 6). Spec: DOC-03 and DOC-07 (section 7), section 8.5. Builds on P2-REG (the registry and its legacy adapters), P2-READ (`resolvedHomePage()`, the v4 reader), P2-PREVIEW (unfinished sections in a preview), P2-WRITERS (`heroVariantSettings`) and P1-IMAGES (`StoreImage`). No migration.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:sections-render` 30 passed, 0 failed (about 1 s in the gate). `pnpm test`: 66 of 66 suites passed in 116.8 s. 13 deliberate breaks, all caught (see "Do the tests bite?"). `pnpm build` passed; the only warnings are the `next.config.mjs` trace warnings through `lib/platform/migrate.js` that were already there |
| Browser verified | Yes, on the design harness on this Mac (ports 3600 and 4600 to 4602), storefront on the edge runtime (`x-edge-runtime: 1`). Legacy: `drill:edge` in headless desktop Chrome, 150 passed. v4: the Claude desktop app's built-in browser (Chromium) at 1440 x 900. Not Safari, not a phone. See "Browser evidence" |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real store changed mode |

## What and why

Until now the hero was hard-coded in `app/(storefront)/page.js`, the home sections were a chain of `if (kind === …)` branches in `HomeSections.js`, and content pages had their own chain in `ContentPage.js`. A v4 home page whose founder hid the hero made `resolvedHero()` return null, and the page then failed on `hero.subtitle` (a 500). The home rails read the legacy pin table on every store, v4 included, against plan decision 9. And the DOC-03 shopper states (sold out, too few products, missing images, an empty page) were not built.

This item:
- makes the hero a section component, with an optional image;
- renders every section, on the home page and on content pages, through one renderer map keyed by the registry's section kinds;
- moves the home page to `resolvedHomePage()`, with the hero experiment applied through `heroVariantSettings`;
- closes both batch-3 gates from plan section 6;
- builds the DOC-03 shopper state table.

## Design

### The renderer map (`components/sections/index.js`)

One component per registered kind: `hero`, `collections`, `new`, `banner`, `rich_text`, `image_with_text`, `product_rail`, `text`, `faq`, `product_main`. Each lives in its own file under `components/sections/`; shared bits (the image fallback, the empty-page note, link and image readers) are in `parts.js`.

- `SectionView({ section, data, ctx })` finds the component by kind and hands it `attrs = { data-section-id, data-section-kind }`. Every component spreads `attrs` on its root element. An unknown kind renders nothing.
- `checkSectionComponents(kinds)` is the contract check: it lists a registered kind with no component and a component with no registered kind. `registerSectionComponent` exists for the test's throwaway kind.
- A component may carry a static `shows(section, data, ctx)`. Pages use it to know when nothing rendered.
- `ctx.surface` is `"home"` or `"page"`. Kinds that appear on both keep each page's old markup (a rich text section on a policy page looks as it always did; on the home page likewise). `text` and `faq` on the home page (new: v4 can put them there) use the home page's spacing.
- `components/FaqSection.js` now passes any extra props to its root, so the attributes reach it.

### The hero (`components/sections/HeroSection.js`)

Moved out of `page.js` with the same markup and the same rules (the GEN-03 empty-store words, the hidden `#new` button on an empty store, the badge, the highlight, PV-08's experiment note). It reads a registry hero section and turns the settings back into the flat hero with `settingsToLegacyHero`, so typed button links become hrefs.

New: `settings.image = { media, alt }`. When `media` is a non-empty string, the hero becomes two columns (words left, image right from `md` up, stacked below on a phone). The image goes through `StoreImage` (`fill`, `priority`), so a library photo is served as its own `/api/media/<id>` url and a Shopify photo still goes through the optimizer. With no image, an empty `media`, or no `image` key, the markup is the old hero's, byte for byte.

A v4 hero missing a key gets today's fallback under it (`defaultHero(siteName())`, as `resolvedHero()` always gave). A legacy hero already holds every key, so nothing changes there.

### The home page (`app/(storefront)/page.js`)

- It renders from `resolvedHomePage()`: the hero as section 0 plus the rest, registry-shaped, for every store.
- The first `hero` section is rendered at the top, outside the content container, as before. The rest go to `HomeSections`.
- No hero shown (a v4 home that hides it): no hero, no experiment assignment, no exposure ping, and the sections render. If nothing else shows either, the neutral empty-page note appears.
- The hero experiment: `heroVariantFor(…, { preview: src.preview, founder })` still decides assignment, the preview note and the founder rules (the PV-08 guards still hold). When a visitor gets a variant, `heroVariantSettings(settings, payload)` merges it at the settings level, so the image, the badge and any button the variant doesn't name stay.
- `resolveHomeSectionData(…, { documents: src.v === DOCUMENTS_RELEASE_VERSION })`.

`lib/content/resolve.js` (one line): in the legacy branch of `resolvedHomePage()`, a section from an old live snapshot that has no id carries `legacyKey: "i-<n>"`. That keeps its `data-sec` (the preview's click target) exactly as before; without it, v1 and v2 pages would change from `data-sec="i-0"` to `"sec_l0"`.

### Section data (`lib/cms/section-data.js`)

- It still takes the old flat sections (test:sections keeps passing unchanged), and now takes registry sections too. Their bindings and defaults come from the new registry (`sources[0]`, the setting defaults); a rail's `collection` is `{ handle, id }`.
- Keys: `legacyKey`, else the id, else `i-<index>`.
- Rails and pins:
  - **Legacy store:** the pins are read as before. One `collection_overrides` read per rail collection, now made just before the products query and passed in as `pins`, so the statements and the order are the same. The rail's data says `handPicked: true` when pins exist.
  - **v4 store** (`documents: true`): pins are `[]`. `collection_overrides` is never read, and the rail uses the collection's own order. This is plan decision 9: neutral empties until OVL.

### Content pages (`components/ContentPage.js`)

Page sections arrive in the page shape (from the legacy tables, or from a v4 body through `pageFromBody`). They are adapted with `legacyPageSectionsToSections`, so the merged names apply (`rich` → `rich_text`, `image` → `image_with_text`, `heading` → `title`). A section whose kind is not one of the four page kinds renders as text, as it always did. Each section then renders through `SectionView` with `surface: "page"`.

### The DOC-03 shopper state table

| Row | Shopper sees now | Where |
|---|---|---|
| Rail with some sold-out products | Each card says "Sold out" (ProductCard, as before). They move to the end, keeping their order among themselves. If the collection's order is hand-picked (the founder pinned products, legacy only), the order is kept | `ProductRailSection` (`soldOutLast`, `data.handPicked`) |
| Rail with every product sold out | The rail stays, every card labelled | same |
| Rail below `minItems` | The rail is left out entirely: no heading, no empty slots. The minimum is the registry's `minItems` (3), or the founder's own smaller `limit` (a rail of 2 they chose still shows, matching the registry's FEW_ITEMS warning "Shoppers will still see what you chose") | `ProductRailSection.shows`, `railMinimum` |
| Rail bound to an empty collection, or to none | Left out | same, and section-data gives `[]` |
| Any image missing | The brand gradient (`from-sf-media-from to-sf-media-to`, the collection card's own fallback), with the alt text as `role="img"` when there is one. Image-with-text keeps its words. Collection cards and product cards already had token fallbacks; tested | `parts.js` `MediaFallback`, `ImageWithTextSection` |
| Hero button linked to a sold-out product | The hero stays exactly as it is, and the button opens the product page (which says sold out). Nothing reads stock | `HeroSection` |
| A page that renders no sections | "There’s nothing on this page yet." and a "Browse our collections" link to `/collections`. Content pages: when no section renders and nothing of the page's own follows (the contact page's form does). Home: when there is no hero and no section shows | `parts.js` `EmptyPageNote`, `ContentPage`, `HomeSections` |

Founder notes in preview (the third column of the spec table) are PV-02 and PV-09, not this item.

### Deliberate changes from a6d028e (shopper-visible, legacy stores included)

The equivalence fixtures are all in stock, with every rail above its minimum, so none of these show there. They are the state table, applied to every store:

1. **A product rail with fewer products than its minimum is hidden.** The minimum is 3, or the founder's own smaller limit. Before, a legacy rail with 1 or 2 products rendered them. **A live legacy store with a 1- or 2-product rail (and a limit of 3 or more) loses that rail on deploy.** The design harness shows this: its `serums` collection has 2 products. Owner check below.
2. **Sold-out products in a rail move to the end** unless the collection has pins. Before, they stayed in the collection's order.
3. **Image-with-text with no image now shows**, with the gradient where the photo goes. Before, on the home page the whole section was left out. On a content page, an image section with an empty `src` rendered a broken `<img src="">`; it now renders the gradient.
4. **A content page with no sections, and nothing below** (a campaign or post saved empty), shows the neutral message and the link. Before, it showed an empty area.
5. Every section root carries `data-section-id` and `data-section-kind`. The hero keeps `data-sec="hero"` and home sections keep their `data-sec`.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Every registered kind has exactly one component in the map; a fake kind registered in the test renders through the map with data-section-id and data-section-kind | **Done** | `test:sections-render` §1, four tests: the contract check is `[]` and the map's kinds equal the registry's; NEGATIVE: a registered kind with no component and a component with no kind are each reported; a `fake_quote` kind defined in the registry plus one map entry renders on the home page and on a content page with both attributes; every kind's root carries both attributes on both surfaces. Fails without the change: no map exists at f893710; break B10 (no attrs) fails 13 tests |
| 2 | The home page HTML for v1, v2 and v3 fixtures, legacy drafts, an S59 candidate preview and a running hero experiment equals a6d028e's output (data-section-* normalized) | **Done** | `scripts/support/home-render-outputs.js` renders the real `page.js` and `ContentPage` (Next's SWC, react-dom/server, real next/image) for 10 states: drafts, the experiment (variant b, control, a console sign-in, the founder's preview with the PV-08 note), an S59 candidate, v1, v2, v3 and an empty store, plus 4 content pages each (text, rich with an effective date, FAQ, images). Recorded inside an a6d028e checkout to `scripts/fixtures/home-render-outputs.a6d028e.json`. `test:sections-render` §2 re-runs it here and compares each page after removing ` data-section-id="…"` and ` data-section-kind="…"` (11 tests). Breaks B11 (one class changed) and B12 (no legacyKey) fail them |
| 3 | A v4 doc_home with a hero image renders the image with its alt through StoreImage; without an image the markup equals the legacy hero | **Done** | §3: a doc_home published through the real service renders `<img src="/api/media/…" alt="A jar on linen">` with no srcset; a Shopify image goes through `/_next/image`. Without an image (null, `media: ""`, no key) the hero equals the a6d028e drafts hero byte for byte. Break B9 fails it. Browser: screenshot below |
| 4 | Sold-out rail products are labelled and sorted last, but keep their order when hand-picked | **Done** | §4, two tests (some sold out, all sold out, hand-picked); §3 shows a legacy rail following its pin. Breaks B4 and B5 |
| 5 | A rail below minItems and a rail bound to an empty collection render nothing (no empty slots) | **Done** | §4, two tests: 2 of 8 renders `""` and leaves no trace in a full `HomeSections`; limit 2 with 2 products still shows; an empty collection and no collection, through the real data path on a legacy store, render `""`. Break B6. Browser: the harness's 2-product `serums` rail is left out |
| 6 | A section with a missing image renders the token-coloured fallback | **Done** | §4: image with text (home, with and without alt), a page image, a collection with no photo, a product with no photo. Break B7 |
| 7 | A hero button linked to a sold-out product behaves per the spec row | **Done** | §4: a v4 hero whose button links to a product that is sold out in the catalog renders unchanged, the button `<a href="/products/glow-serum">`. Nothing to break: the row asks that nothing changes. It passes at f893710 too for a legacy hero; it is a guard |
| 8 | A content page with no sections shows the neutral message and a link to collections | **Done** | §4: the message and the link; not with the contact form below; not with a section; the home page with no hero and nothing showing gets it too. Break B8 |
| 9 | An experiment variant merged via heroVariantSettings changes only the variant's fields | **Done** | §3: at the settings level only title, highlight, subtitle and primary change (the button becomes a typed link). Rendered on a published v4 home with a running test, variant b shows the variant's words and button. Both b and control keep the image, the badge and the other button, and b pings. Legacy: the exp_b fixture equals a6d028e. Break B3 fails both. Note: `cleanVariantPayload` always stores title, highlight and subtitle, so a variant that leaves the subtitle out blanks it (as before, on legacy too) |
| 10 | A v4 home with its hero hidden renders without a hero and no error; a v4 home's rails never read collection_overrides (legacy still does) | **Done** | §3: the hidden hero renders the sections, no `<h1>`, no ping. Break B2 (the old "always a hero" read) throws. Rails: watching the tenant's statements while the real page renders, v4 issues 0 `collection_overrides` statements and shows the collection's own order. Legacy issues exactly 1 and shows the pinned product first. The section-data unit test checks the same with a spy repo. Breaks B1 and B13. `test:release-readers` had pinned the old read (exactly 1 on v4); it now asserts 0 |

## Tests

New: `scripts/test-sections-render.js` (replaces the P2-ATOM placeholder): 30 tests, about 1 s. It uses two real tenants (one v4 published through `lib/documents/service.js` and `publish.js`, one legacy), the real page and components, and spawns the recorder for §2.

New: `scripts/support/home-render-outputs.js` (the recorder; runs in any checkout) and `scripts/fixtures/home-render-outputs.a6d028e.json` (recorded in a detached a6d028e worktree; the recorder took 1.9 s there).

Changed (they load `page.js` or `ContentPage` with stubs, and the imports moved):
- `scripts/test-copy.js`: stubs for the map (the real `HeroSection`), `@/lib/releases`, `@/lib/registry/legacy`, `@/lib/site`, and `resolvedHomePage`.
- `scripts/test-page-editor.js`: compiles the section components behind `ContentPage` (lib modules through `require`).
- `scripts/test-release-readers.js`: the v4 home rail pin reads go from "exactly 1 (known limit)" to 0.

`test:preview-experiments`, `test:tokens`, `test:sections`, `test:images` and `test:releases` pass unchanged.

### Do the tests bite?

Each break was applied alone, `test:sections-render` was run, then the break was reverted.

| # | Break | Result |
|---|---|---|
| B1 | page.js passes `documents: false` | caught (rails test) |
| B2 | page.js assumes a hero (`heroWithDefaults(page[at])` always) | caught (hidden hero) |
| B3 | page.js never applies the variant | caught (2: exp_b equivalence, v4 variant) |
| B4 | no sold-out sort | caught |
| B5 | hand-picked order ignored | caught |
| B6 | no minItems check | caught |
| B7 | image fallback replaced by `<img src="">` | caught |
| B8 | no empty-page note | caught |
| B9 | hero image dropped | caught (2) |
| B10 | no section attributes | caught (13) |
| B11 | one class changed in TextSection | caught (9 equivalence tests) |
| B12 | `legacyKey` dropped in resolve.js | caught (v1, v2) |
| B13 | pins read on v4 in section-data | caught (2) |

## Browser evidence

The design harness at `DESIGN_PORT=3600 DESIGN_SQLD_PORT=4600`, started and stopped by me. Screenshots are in `docs/cms-reviews/drills/P2-SECTIONS/`.

- **Legacy** (the harness's own store: a v3 release, a running hero test). `node scripts/drill.js harness-edge` in headless desktop Chrome: 150 passed, 4 known (finding 5, maintenance HTML, unchanged). The 1 failure was its own check "git diff HEAD -- app is empty", which fails only because this item's `page.js` change wasn't committed yet. The drill writes into `drills/P1-HARNESS/`; I copied the home (1440, 768, 375), CMS page (1440, 375) and Designer screenshots, plus `results.json`, to `drills/P2-SECTIONS/legacy-*`, and restored P1-HARNESS's files. Home, CMS page, Designer preview (draft title, no `POST /api/exp` from the preview) are all 200 on the edge runtime.
- **v4** (the harness tenant only). A scratch script, kept outside the repo, did four things on the harness's own test database only: set `cms_state.mode = 'documents'`, cleared the seed's legacy live pointer, saved the repo's `public/icons/icon-512.png` as a library photo, and published a doc_home through the real service. The built-in browser at 1440 x 900, after "No thanks" on the cookie banner:
  - `v4-hero-image-variant-b-1440.jpg`: the hero with the library photo on the right. This browser is in the harness test's variant b, so it shows the variant's title and subtitle, and the founder's "Shop serums" button is kept.
  - `v4-hero-hidden-1440.jpg`: the same home with the hero hidden. It shows no hero and no error; "New in" and the text section render. The `serums` rail (2 products, limit 4) is left out by the minItems rule.
  - `curl`: 200 with `x-edge-runtime: 1`; the section attributes are on every root.

## Known limits

- **The minItems rule hides small rails on legacy stores too** (change 1 above). This follows the brief. The spec's table says "renders with no empty slots", which can also be read as "show what there is". The owner should confirm (owner check).
- **"Hand-picked" means the collection has pins** in `collection_overrides`, on a legacy store. On v4, pins are empty until OVL, so a v4 rail always sorts sold-out last. When OVL brings v4 pins, section-data must pass them and set `handPicked`.
- **The sold-out sort works within the fetched products** (the first `limit` in the collection's order). It does not fetch extra in-stock products to replace sold-out ones.
- **Content pages still receive the page shape**, so on a v4 page only text, rich text, image and FAQ reach the map; `pageFromBody` (P2-READ) still drops `banner`, `collections`, `new` and `product_rail` there. The map renders them, but page routes need data binding (section-data for pages) first. DOC-06's "a campaign can hold a rail" is not done here.
- **`product_main` places only what the route hands in** (`ctx.productMain`). The product page doesn't render its layout through the map yet (SURF items).
- **No field attribute per editable text** (DOC-03's "a field attribute for each editable text") yet. That is ED-04's click-to-select. Only the section attributes are here.
- The hero image has no aspect or focal setting (DOC-11 and MED items); it fills a 4:3 frame with `object-cover`.
- Rendered tests are react-dom/server, not the RSC renderer. Real Next rendering was checked only on the harness (above), in Chromium.
- Hero experiments that target the section id, and translating running payloads at cutover, are MIG's (plan section 4).

## Owner checks

- **Rails below 3 products disappear on legacy stores after deploy.** Before deploying, check whether any live store has a product rail bound to a collection with 1 or 2 in-stock products (and a limit of 3 or more). Decide whether hiding it is what you want for legacy stores, or whether it should wait for cutover.
- Look at a real store's home and a policy page after deploy, in desktop and phone browsers: they must look exactly as before (the equivalence covers the HTML, not the CSS a browser applies).
- A hero with an image on a phone (it stacks under the words) and on Safari: not checked.
- **CI sqld** (unchanged from P2-ATOM): `.github/` was not touched. `test:publish` needs sqld, so CI stays red until the owner approves the pinned, checksum-verified sqld download.
- DR-1 and DR-2 stand.

## Files

- New: `components/sections/index.js`, `HeroSection.js`, `CollectionsSection.js`, `NewProductsSection.js`, `BannerSection.js`, `RichTextSection.js`, `ImageWithTextSection.js`, `ProductRailSection.js`, `TextSection.js`, `FaqListSection.js`, `ProductMainSection.js`, `parts.js`
- Changed: `components/sections/HomeSections.js`, `components/ContentPage.js`, `components/FaqSection.js` (root props), `app/(storefront)/page.js`, `lib/cms/section-data.js`, `lib/content/resolve.js` (one line, `legacyKey`)
- Tests: `scripts/test-sections-render.js`, `scripts/support/home-render-outputs.js`, `scripts/fixtures/home-render-outputs.a6d028e.json`, `scripts/test-copy.js`, `scripts/test-page-editor.js`, `scripts/test-release-readers.js`
- `docs/cms-reviews/P2-SECTIONS.md`, `docs/cms-reviews/drills/P2-SECTIONS/*`

## Commands

```
pnpm test:sections-render
pnpm test
pnpm build
node scripts/support/home-render-outputs.js out.json   # re-record (inside any checkout)
```
