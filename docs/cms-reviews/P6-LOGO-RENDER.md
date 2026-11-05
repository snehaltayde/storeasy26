# P6 · LOGO-RENDER · The picture logo in the storefront chrome

Branch `cms/p6-logo-render`, cut from `7506c9e` (`cms/phase-1` after the P5-FIX2 merge `441b44d`, the P5-DRILLS merge `211c982` and the batch 1 merges, P6-LOGO-REG `e19dedf` included). Plan: `docs/cms-reviews/P6-PLAN.md` (decision 5) and `P6-BATCHES.json` (batch 2). Requirements: GEN-04, GEN-01.

Migrations owned: none.

Files changed (all in the plan's list):
- `app/(storefront)/layout.js`
- `components/Header.js`
- `components/Footer.js`
- `components/PreviewBanner.js`
- `scripts/test-design-doc.js`
- this file

Not touched: `package.json`, anything under `.github/`, `lib/` (no reader changed), the checkout page, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No store changed mode and `--hosted` was never passed. Nothing was sent to Typesense, Shopify or Razorpay, and no order was placed.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 102 of 102 suites passed in 195.5 s (ports 6180 and 7180 to 7189). `pnpm build` passed |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a rendered test of the real files (SWC, the real layout in a simulated request on real tenant databases). The look on a real screen (sizes on a phone, Safari, an SVG with no size) is an owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing was pushed, merged or deployed |

## What and why

GEN-04's brand step lets a founder add a picture logo. P6-LOGO-REG put it in the design document (`doc_design.settings.logo`) and added `resolvedLogo()`, but nothing showed it: every store still showed the text wordmark. This item shows the logo in the header (both variants) and the footer (both spots) on documents stores. Legacy and migrating stores look exactly as before.

It also fixes the false preview bar sentence found in the batch 0 review of P6-LOGO-REG: on a store with no live design the draft colours are shown, but the bar said "Your new colours are not shown here. Show them".

## Design

### The layout (`app/(storefront)/layout.js`)

- `chromeData` adds `resolvedLogo()` to its one `Promise.all`. It answers `null` for any source that is not v4 and for a closed source, without reading anything (P6-LOGO-REG).
- **Documents store** (`src.v === DOCUMENTS_RELEASE_VERSION`, a live v4 release or a founder's documents preview): `logo = { image: <resolvedLogo()>, name: siteName(), ...siteLogo() }`. `image` is `null` when the design has no logo.
- **Every other store** (legacy, migrating, a v1 to v3 release): `logo = siteLogo()`, the same object as before, with no `image` or `name` key.
- **Closed store, the error chrome and `NEUTRAL_CURTAIN`:** unchanged. A closed store returns StoreClosed before `chromeData` runs. The error chrome's neutral logo has no image. The maintenance curtain shows no wordmark.
- Brand and theme reads are unchanged. The TOK-03 guard passes with the allowlist unchanged.
- `previewOverlay` now also carries `designShown` (from `src.overlay.designShown`, true or false).

### Header and Footer

- When `logo.image?.media` is set, an `<img src={media} alt={image.alt || logo.name}>` replaces the text wordmark. Otherwise the text markup is exactly as before. The text branch sits in a fragment, which adds no markup.
- **The alt:** the founder's alt, else `logo.name`, which is `siteName()`. It is never `text1`, because `text1` can be half of a split wordmark ("BEAST" of BEAST / LIFE).
- `media` can only be a library path (`/api/media/<id>`). `designFromBody` turns anything else into `null`, so the chrome never gets another site's address.
- **Header** (`HEADER_LOGO_CLASS`): `block h-8 max-h-8 w-auto max-w-[180px] object-contain md:h-10 md:max-h-10`. That is 32px tall on a phone and 40px from `md` up, at most 180px wide, with width following the height. The explicit height keeps an SVG with no size of its own from collapsing or growing. The img sits inside the same home link (`<a href="/">`), and the link takes its accessible name from the alt.
- **Footer** (`FOOTER_LOGO_CLASS`): `block h-12 max-h-12 w-auto max-w-full object-contain`, which is 48px tall. The minimal variant adds `mx-auto` so it stays centred. The footer wordmark was never a link, and it still is not.
- All of these classes are in the built CSS (checked in `.next/static` after `pnpm build`).

### The preview bar (`components/PreviewBanner.js`)

The design line now follows what the preview really shows (`overlay.designShown`), not the toggle:

| designShown | toggle | The bar says |
|---|---|---|
| true | off | "Your new colours are shown here." with no button. This is a store with no live design, where the toggle changes nothing |
| true | on | "Your new colours are shown here. Hide them" (as before) |
| false | off | "Your new colours are not shown here. Show them" (as before) |
| false | on | "Your new colours are not shown here. Hide them". This should not happen; the words stay true |

An overlay without `designShown` (older callers) reads the toggle, as before. The two sentences are exported (`DESIGN_SHOWN_LINE`, `DESIGN_HIDDEN_LINE`). test-editor-shell's source pin on the form's Hide/Show button and test-preview-overlay's rendered bar both pass unchanged.

## Acceptance

All rendered tests are in `scripts/test-design-doc.js`, section 10. They compile the real files with Next's SWC and render them with react-dom/server. The layout tests run the real `app/(storefront)/layout.js` inside section 9's simulated request (next/headers stub, request cache) on real file-database tenants. Only fonts, CSS, the client cart, analytics, the bridge and SiteNav are stubbed. The Header is wrapped so the test sees the exact `logo` the layout gave it.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Rendered: the standard and centered Header variants and both Footer spots with logo.image {media:'/api/media/x', alt:'Acme'} render an img with src /api/media/x, alt 'Acme' and the size styles | **DONE** | "P6-LOGO-RENDER rendered: both Header variants and both Footer spots…". Each spot has exactly one img with that src and alt. The header classes h-8, max-h-8, md:h-10, md:max-h-10, max-w-[180px], w-auto, object-contain and block are there. The img is the home link's only content. The footer classes h-12, max-h-12, w-auto, max-w-full, object-contain and block are there, plus mx-auto on the minimal variant. Fails without the change: M1 (header ignores the image) and M2 (footer ignores it). M5 (no explicit desktop height) fails it too |
| 2 | Rendered: with alt '' and a split wordmark (text1 'BEAST', text2 'LIFE', name 'Beast Life Store'), the alt is 'Beast Life Store', not 'BEAST' | **DONE** | "P6-LOGO-RENDER rendered: with alt '' (or no alt) and a split wordmark…". Covers all four spots, for an empty alt and for a missing alt, with no BEAST or LIFE text beside the picture. Fails with M3 and M4 (the alt falls back to text1 in the header or the footer), and with M1 and M2 |
| 3 | Rendered: with no image the text wordmark markup is byte-identical to today in all four spots | **DONE** | "P6-LOGO-RENDER rendered: with no image the text wordmark markup is byte-identical to today…". The whole markup of each of the four spots, for a split and a single wordmark, is pinned by sha-256. The hashes were computed from the `7506c9e` Header.js and Footer.js (compiled the same way) and match this branch's output byte for byte. The same hashes hold with `image: null` plus a name, and with an image that has no media. The two wordmarks are also written out literally |
| 4 | Rendered: the layout on a legacy fixture passes no image even if a design document exists, and its header output is unchanged | **DONE** | "P6-LOGO-RENDER rendered: the layout on a legacy fixture passes no image even when a design document with a logo exists…". The legacy store `dl` gets a `doc_design` document with a logo in its own database (written while it was briefly in documents mode, then put back to legacy; the row is checked). The Header is given exactly `{ text1: "Design Legacy", text2: "" }`, with no image key. The page has no img and no trace of the logo. The `<header>` is the Header rendered with today's logo object, and holds today's wordmark. A migrating store also gets no image. Fails with M6 (every store gets an image key). The open-store test ("…renders its live logo in the header and footer…") fails with M7 (no image) and M8 (no name) |
| 5 | Unit: a closed documents store renders StoreClosed with no logo image and no draft strings (PUB-06 leak tests green); pnpm test passes | **DONE** | "P6-LOGO-RENDER unit: a closed documents store renders StoreClosed…". The real layout on `lgclosed` (never published, a design draft with a logo) renders "Opening soon" and the name. No Header ran. There is no img, no /api/media, no draft media id, no draft alt, no draft accent, and no header, footer or preview bar. This is a guard, not a change: it passes before this item too, because the closed branch is untouched. The PUB-06 suites (test-release-readers, test-preview-overlay, test-preview-frame, test-editor-shell, test-publish-service, test-migrate-documents, test-provision) pass. `pnpm test`: 102 of 102 |
| 6 | Rendered: the preview bar never says the new colours are not shown while they are | **DONE** | "P6-LOGO-RENDER rendered: the preview bar never says the new colours are not shown while they are…". (a) On a closed store's preview, toggle off (designShown true), the real layout's bar says "Your new colours are shown here." with no "not shown" and no "Show them", and the header shows the draft logo. (b) With the toggle on it says "shown here. Hide them". (c) An open store with a live design and a draft still says "not shown here. Show them", with the live logo, and after the toggle "shown here. Hide them", with the draft logo. (d) The banner alone, for designShown true, false and missing against both toggles: "not shown" appears exactly when the colours are not shown. Fails with M9 (the layout drops designShown), M10 (the banner always shows the toggle form) and M11 (the banner reads only the toggle), and with the original PreviewBanner |

**Mutations.** Each was run alone on this branch's files, and each failed the tests named:

| Mutation | What was changed | Tests failed |
|---|---|---|
| M1 | Header ignores the image | 4 |
| M2 | Footer ignores the image | 3 |
| M3 | Header alt falls back to text1 | 1 |
| M4 | Footer alt falls back to text1 | 1 |
| M5 | Header has no explicit desktop height | 1 |
| M6 | The layout gives every store an image key | 1 |
| M7 | The layout passes no image | 2 |
| M8 | The layout passes no name | 1 |
| M9 | The layout drops designShown | 1 |
| M10 | The banner always shows the toggle form | 1 |
| M11 | The banner reads only the toggle | 1 |

## Tests

- `pnpm test`: **102 of 102 suites passed in 195.5 s, exit 0.** Ports were pinned:
  - `TEST_PUBLISH_PORTS=7180,7181`
  - `TEST_PUBLISH_SERVICE_PORTS=7182,7183`
  - `TEST_PUBLISH_UNDO_PORTS=7184`
  - `TEST_PRODUCT_CONTENT_PORTS=7185,7186`
  - `TEST_MIGRATE_MAP_SQLD_PORT=7187`
  - `MIGRATE_DOCUMENTS_TEST_PORTS=7188,7189`
  - `MIGRATE_DOCUMENTS_TEST_WEB_PORT=6180`
- `node scripts/test-design-doc.js`: 33 passed (26 before, plus 7 new).
- Suites that render or pin these files pass unchanged: test-copy, test-preview-overlay, test-editor-shell, test-preview-frame (its edge scan covers PreviewBanner), test-legacy-fixtures and test-release-readers.
- `pnpm build`: passed, exit 0. Its one warning is the existing edge-runtime note about `/api/errors`.
- **Edge runtime:** no new imports. The layout imports one more getter from `lib/content/resolve.js`, and the components import nothing new.

## Known limits

1. **Checkout keeps the text wordmark.** `app/(storefront)/checkout/page.js` (~l.38) passes `siteLogo()` to CheckoutFlow, so the checkout page shows the text pair even on a store with a picture logo. The spec does not ask for the logo there.
2. **The logo's words for an empty alt are the store's name, not the founder's text wordmark.** On a split wordmark the name ("Beast Life Store") is what a screen reader hears, which is by design.
3. **No `width`/`height` attributes on the img.** The size comes from CSS (an explicit height and `w-auto`). Until the picture loads, the header reserves the height but not the width, so the icons may shift sideways once. An SVG with no viewBox and no size of its own gets the browser's default ratio, capped at 180px wide in the header and the column width in the footer.
4. **A store with no live design (closed, or opened on the platform default) shows the bar line with no button.** The toggle changes nothing there (P6-LOGO-REG known limit 1). The editor's own "Show them" control (DocumentEditor) is not changed. This item only changes the storefront bar.
5. **The PWA icons, the favicon and the share image** still do not use the logo (out of scope in the plan).
6. **MEDIA_MISSING's image wording for a deleted logo** (P6-LOGO-REG known limit 2) is still not changed. `checks.js` is not this item's file. If a live logo's file were ever missing, the header would show a broken picture with its alt, not the text wordmark. `deleteMedia` refuses to delete a file while a retained version holds it, and the publish checks warn about a missing file (P6-LOGO-REG), so this needs a file lost outside the media library. The renderer does not check that the file exists (that would be a read per page).

From review:

- Base check passed: 7506c9e contains the P5-FIX2 merge (441b44d) and the P5-DRILLS merge (211c982). The diff touches only the files the plan lists: layout.js, Header.js, Footer.js, PreviewBanner.js, test-design-doc.js and the packet. Nothing under .github/, lib/ or package.json changed.
- Reproduced: pnpm test passed 102 of 102 suites in 206.9 s on ports 6380 and 7380 to 7389, and test-design-doc passed 33 of 33. I ran my own 10 mutations, each alone, and each failed at least one new test: header checks logo.image instead of logo.image.media; header alt uses ?? (so an empty alt stays empty); header loses h-8; header loses max-w-[180px]; footer minimal loses mx-auto; layout gives the image only to previews instead of to any v4 source; layout fallback name becomes text1; the banner's no-button branch is removed; the layout forces designShown to true; header loses its md height. Every file was restored after each run, and git status was clean afterwards.
- Safety checked by reading the code: siteLogo() returns only text1 and text2, so the spread in { image, name, ...siteLogo() } cannot overwrite image or name. logoOf only passes on media that matches ^/api/media/[A-Za-z0-9_-]{1,120}$, so the chrome cannot receive a foreign or javascript: address. /api/media serves with nosniff and a no-script CSP. resolvedLogo reads the same chrome(src) as resolvedBrand and resolvedTheme, so it adds no new way to fall into the error chrome. Header, Footer and PreviewBanner import nothing new, so there is no edge-runtime problem. React escapes the alt.
- Minor: when designShown is false and the toggle is on (only possible when the design draft cannot be read, so it is skipped), the bar says 'Your new colours are not shown here. Hide them'. The sentence is true but the button is odd. The packet's table lists this case as 'should not happen'. Founder-only, so it does not block.
- Minor: the layout turns a missing overlay.designShown into false (=== true) before it reaches the banner. So the banner's fallback for older callers (read the toggle when designShown is missing) is never used from the layout. Today documentsPreview always sets designShown, so this is harmless.
- I could not run ESLint: the worktree has no eslint binary. A plain <img> may trigger Next's no-img-element warning if lint is ever added. pnpm build passed, according to the builder.
- Owner checks the builder already listed and I agree with: real-screen logo sizes (phone 32px, desktop 40px, at most 180px wide, footer 48px) in Chrome and Safari, including an SVG with no size of its own; a screen reader reading the home link's name; the wording of the closed-store bar with no button; checkout keeping the text wordmark. The browser drill is NOT DONE.

## Owner checks

- **The logo on real screens.** On a documents store with a logo (PNG, a large JPEG and an SVG with no width or height), look at the header on a phone and on desktop, and at both footer variants, in Chrome and Safari. The header logo should be 32px tall on a phone and 40px on desktop, never wider than 180px. The footer logo should be 48px tall. Nothing should be cut off or squashed.
- **A screen reader on the header logo** reads the founder's alt, or the store's name when the alt is empty, as the home link.
- **The preview bar on a closed store** now says "Your new colours are shown here." with no button. Confirm the wording is acceptable.
- **The checkout page** keeps the text wordmark on a store with a picture logo (known limit 1). Confirm that is acceptable for now.
