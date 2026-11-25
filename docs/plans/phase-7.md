# Phase 7 plan: flagship themes and storefront UX (roadmap Phase 4)

Architect plan, 2026-11-26 00:20 IST. One tenant migration (0035, additive). No platform migration, no new permission action, no new dependency.

## Findings that shape the plan
1. A Phase 5 package row already gives render, preview, publish, rollback and the operator pin (`theme_packages`, `applyPackage`, `packageFor`, `themePinOf`); rows are immutable, so a first-party package in the same table reuses all of it.
2. The kit heading face is `--display-font` (`app/globals.css:26`, `[data-kit="glow-1"]`); Geist and Fraunces are already self-hosted (`app/fonts/fonts.js`), so a `heading_font` token needs no new font files (the OFL owner item is unchanged).
3. Onboarding's Brand step (`lib/first-run/brand-step.js`, `components/admin/onboarding/BrandStepPanel.js`) picks one of six palettes into the `doc_design` draft and never publishes.
4. Search is free text only: `typesenseSearch` (raw fetch, Edge-safe); SQL fallback `effective.search`. The Typesense schema already marks `product_type`, `vendor`, `tags` as facets. `products` holds only active products. Tags are offer logic tags (`logic_tags`).
5. A sticky mobile bar exists inside `ProductPurchase.js` (S38) with no `data-protected`. The drawer shows the free-shipping nudge (`shipping.remainingForFree`). Offer types: `TIERED_QTY`, `FREE_GIFT` (subtotal strictly over the threshold), `COUPON` (`minSubtotal`), `BXGY`, `BUNDLE`. `lib/cart.js` re-runs `evaluateOffers` on every cart read.

## Order and parallelism
- No step 0. All three lines in parallel, own worktrees under `../storeasy26-wt/`. Merge order: line 1 (holds 0035), then 2, then 3; each later line rebases on the one before.
- Shared append-only (keep both sides): `package.json`, `scripts/drills/run-isolated.mjs` (`DRILLS`), `scripts/support/{admin-routes,support-reads,admin-pages,read-controls}.js` (line 1 only), `docs/UI.md`, `docs/ARCHITECTURE.md` (one sub-heading per line).
- Ownership: **line 1** `lib/brand.js`, `lib/themes/*`, onboarding, studio Design rail, admin and operator Themes. **Line 2** `lib/catalog/effective.js`, `lib/catalog/search-doc.js`, `lib/typesense*.js`, the search page. **Line 3** `lib/cart.js`, `lib/offers/progress.js`, `components/cart/*`, `components/ProductPurchase.js`, `components/pdp/StickyBuyBar.js`, `scripts/test-theme-render.js`.
- Shared client state: `CartContext` belongs to line 3. Line 2 adds only its own sheet's open flag. The `doc_design` store belongs to Phase 6's DesignRail; line 1 only adds a control to it.
- Every builder runs `pnpm test` (shared storefront or registry code; PLAYBOOK). A line adding a page or nav item runs `drill:shell` before merge.

## Decisions (schema and permissions first)
1. `theme_packages.source` (tenant 0035): `'upload' | 'storeasy'`, default `'upload'`. Only uploads count toward the 30 limit and only uploads obey the kill switch `ff_theme-packages`.
2. Install and apply of a flagship need `storefront.write` (part of choosing a theme), not `themes.manage`. Publish stays `storefront.publish`. Flagship rows can't be archived. Uploads may not use a flagship slug: "That id belongs to a Storeasy theme. Choose another id."
3. Search facets are anonymous reads: values and counts only from this store's active products and their published (effective) values; counts use the same filter set as results; **tags are never a facet** (logic tags can be internal).
4. Tier progress is computed only on the server inside the cart read; no request accepts it; checkout keeps recomputing with `evaluateOffers`.
5. Five flagships are first-party `storeasy-theme/1` packages as data in `lib/themes/flagships.js`, installed on first use with a deterministic id `thm_` + first 16 hex of sha256(`storeasy:<slug>@<version>`). A new version is a new row plus an "Update available" note. (Rejected: new kits — new CSS blocks, skips the package path.)
6. `heading_font` token `"sans" | "serif"` (Geist | Fraunces); absent means the kit decides, so existing stores render byte-identical; packages may set it. Amends Phase 5's "fonts from the base kit only".
7. Facets: OR within a group, AND across groups; disjunctive counts (Typesense: one `multi_search`, ≤ 7 queries). Option facets are product-level; with "In stock" on, only in-stock variants' values.
8. URL state `/search?q=&type=&type=&vendor=&o=size:M&o=colour:Red&min=&max=&instock=1&sort=relevance|price-asc|price-desc|new&page=`; ≤ 20 values per group, ≤ 6 option groups, ≤ 80 chars per value; backticks and control chars stripped; unknown values match nothing.
9. No new offer type. Nudges cover `TIERED_QTY` (next tier), `FREE_GIFT` threshold, free shipping and a coupon minimum.
10. Every nudge is checked against the engine before it is shown: the nudged cart through `evaluateOffers` must really apply it, else the nudge is dropped.
11. The sticky bar becomes `components/pdp/StickyBuyBar.js` with `data-protected="buy-bar"` (not a theme part); variant state stays in `ProductPurchase`.
12. SQL fallback computes facets live (`json_each` over options and variants), no new table.

---
## Line 1: a founder can choose one of five flagship themes at onboarding or later
**Features (floor)**
1. Five flagships, each with tokens (incl. `heading_font`), surfaces, templates, a home layout and 8–14 style rules, no assets, passing `parseThemePackage` + `checkBrand` with 0 errors: Volt (nutrition, pulse, sans), Bloom (beauty, glow, serif), Loom (apparel, glow, serif), Harvest (food, pulse, serif), Haven (home, glow, sans).
2. `/admin/themes` opens with "Storeasy themes": five cards (swatch, vertical, description, heading sample), badges "Live" / "In your draft", "Use this theme" / "Preview" / "Details"; uploads follow; flagships have no Archive.
3. `/admin/themes/<slug>` shows a flagship's details in words with "Download package".
4. "Use this theme" runs `ensureFlagship` (idempotent `INSERT OR IGNORE`) then `applyPackage` with the existing options (colours on, home layout off behind a confirm); templates into the layout drafts; revision 409; the per-document publish dialog is reused.
5. A store on an older flagship version sees "Update to Volt 1.1.0", applying the new row as a draft.
6. Onboarding Brand step: a "Theme" picker before Colours (five cards + "Keep the simple look"); the palette row gains "Theme's colours" first, the six palettes override; save writes one `doc_design` draft (`settings.theme.package`, `settings.brand`) plus layout drafts; `BrandPreview` shows the theme's surfaces and heading font; Open Store's first publish lists those layout drafts ticked; Skip writes nothing.
7. Heading font: the studio Design rail gets "Heading font: Sans / Serif / Theme's" with instant preview via `storeasy:tokens` (Reset returns to the theme's); `DesignForm` `BrandControl` gets the same control.
8. Operator Themes shows "Volt 1.0.0 (Storeasy)" or "Aurora 1.2.0 (uploaded)"; `theme_pin.source`.
9. Support and op-support see everything with no apply, update or font controls; staff draft but don't publish.

```sql
-- migrations/tenant/0035_theme_package_source.sql (additive)
ALTER TABLE theme_packages ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'; -- upload | storeasy
CREATE INDEX IF NOT EXISTS idx_theme_packages_source ON theme_packages(source, status);
```
Token: `heading_font?: "sans" | "serif"`; `validateBrand` sets it only when given; `brandCssVars` emits `--display-font` only when set, under `:root[data-kit]` so it beats the kit block.

**Files:** `migrations/tenant/0035_theme_package_source.sql`; `lib/themes/flagships.js` (data, `FLAGSHIP_SLUGS`, `flagshipPackageId`); `lib/themes/packages.js` (`ensureFlagship`, flagship apply, limit counting `source='upload'`, reserved slugs, archive refusal, list with `source`); `lib/themes/package-validate.js` (if token keys are listed by hand); `lib/themes/live-package.js` (kill switch only for uploads); `lib/brand.js`; `lib/documents/after-commit.js`; `lib/types/tenant.ts`; `lib/first-run/brand-step.js`; `app/api/admin/brand-step/route.js`; `app/api/admin/themes/route.js`; `app/api/admin/themes/[id]/route.js` (accepts a flagship slug); the two themes pages; `components/admin/themes/{ThemeLibrary,ThemeDetail,ApplyThemeDialog}.js`; `components/admin/onboarding/{ThemePicker(new),BrandStepPanel,brandModel,BrandPreview,OpenStoreDialog}.js`; `components/admin/studio/{DesignRail,tokensModel}.js`; `components/admin/editor/fields/DesignForm.js`; `app/api/platform/themes/route.js`; `components/platform/operations/Themes.js`; `scripts/test-flagship-themes.js` + `test:flagship-themes`; `scripts/test-studio-tokens.js` (heading font); `scripts/drills/themes/stage-flagship.mjs`; `scripts/drills/p6/brand.mjs`; support rows; `docs/UI.md` ("Themes: Storeasy themes").

| Action | owner | admin | staff | support | op-support | signed out | other store's owner |
|---|---|---|---|---|---|---|---|
| list/detail flagships (`storefront.read`) | 200 | 200 | 200 | 200 read-only | 200 read-only | 401 | 401 |
| use/update a flagship, onboarding theme pick (`storefront.write`) | 200 | 200 | 200 | 403 | 403 | 401 | 401 |
| publish (`storefront.publish`) | 200 | 200 | 403 "Ask an admin" | 403 | 403 | 401 | 401 |
| storefront HTML, anonymous | live flagship only; never drafted; never another store's | | | | | | |

**Tests (`test-flagship-themes`):** all five pass `parseThemePackage`, `checkBrand` (own tokens and all six palettes), `validateStyles`; `ensureFlagship` twice gives one row with the deterministic id; 30 uploads + flagships still allow an upload; an upload with slug `volt` refused; archiving a flagship refused; kill flag: a live flagship renders, an upload doesn't; apply leaves anonymous HTML unchanged, publish writes `publish_log` + audit + `theme_pin.source` in one batch; absent `heading_font` gives byte-identical CSS for an old brand, `"serif"` emits Fraunces, `"comic"` refused; import walk from `layout.js` finds no `node:*`; every matrix row; support's list has no apply actions; another store's package id 404; Brand step with `themeId` writes drafts only, Skip writes none.

**Drill stages:** `themes/stage-flagship` (owner uses Bloom, previews — new tab shows the serif heading, anonymous doesn't — publishes, anonymous sees it; staff no Publish; support no controls); `p6/brand` (pick Harvest + Forest palette, open the store, anonymous sees Harvest with Forest colours).

## Line 2: a shopper can filter search results by several facets
**Features (floor)**
1. Groups: Product type and Brand (effective `display_type`, `display_vendor`); one group per option name (lowercased for grouping, first label shown); Price (min/max); In stock. A group shows with ≥ 2 values or when selected; counts; "Show all" past 8 values.
2. OR within a group, AND across groups; disjunctive counts.
3. Sort: Relevance, Price low to high, Price high to low, Newest; 24 per page with numbered links.
4. Active-filter chips with remove links and "Clear all"; count "12 products"; empty state "No products match these filters." with "Clear all filters".
5. Server-rendered links and GET forms: works without JavaScript; Back/Forward restore filters.
6. Mobile "Filters (3)" opens a full-height sheet (`FacetSheet`: focus trap, Escape, "Show 12 products"); desktop left rail.
7. Typesense: new facet fields `options` (`size:M`) and `options_available` (string arrays); `filter_by` built only from validated values, each in backticks; a missing field (old index) falls back to SQL for that request with slog `search_facets_fallback`.
8. SQL fallback: same semantics in Kysely with bound parameters.
9. `robots: noindex` on filtered search pages; analytics `search` carries `filters: <count>`.
10. Out of scope: header `/api/search` and collection pages unchanged.

**Files:** `lib/catalog/facets.js` (pure `parseFacetParams`, `facetHref`, `typesenseFilter`, plus `facetSearchDb`); `lib/catalog/effective.js` (`indexRows` adds option values); `lib/catalog/search-doc.js`; `lib/typesense.js` (schema); `lib/typesense-search.js` (`typesenseFacetSearch`, `multi_search`); `lib/sync.js` (only if the schema needs an update call); `app/(storefront)/search/page.js`; `components/search/{FacetRail,FacetSheet,ActiveFilters,PriceRange,SearchSort}.js`; `scripts/test-search-facets.js` + `test:search-facets`; `scripts/test-search-effective.js` (document shape); `scripts/drills/search/{run.mjs,lib.mjs,stage-facets.mjs}`, `search` in `DRILLS`, `drill:search`; `docs/UI.md` ("Search filters").

**Permissions:** anonymous and signed-in shoppers 200, own store only; no new console reads; support and op-support see what anonymous sees.

**Tests (`test-search-facets`, anonymous):** store B's products never in A's values or counts; a draft product-type rename absent, the published name present; raw tags never in HTML; a tenant without a Typesense namespace uses SQL; a selected value's count equals the result total; OR/AND results match on both engines (Typesense via stubbed `fetch`, request body checked); `` type=a`,b ``, `&&`, `||`, `)`, 5,000-char values, 100 repeated keys stripped or capped and never raw in `filter_by`; min > max swapped, negative or non-numeric ignored; in-stock option counts honour `options_available`; search page import walk finds no `node:*`; SQL facets on 5,000 seeded products timed and reported.

**Drill `search`:** desktop (two types OR, a brand, size M, price form, sort, page 2, chip removal, Back restores); phone 390×844 (sheet opens, focus trapped, "Show N products"); empty state then Clear.

## Line 3: a shopper on a phone sees a sticky add-to-cart bar and a cart drawer with tiered offers
**Features (floor)**
1. `StickyBuyBar` below `lg`: shows once the main Add button scrolls out and while the drawer is closed; thumbnail, title, chosen variant ("M · Red"), price and compare-at; "Add to cart" / "Adding…" (no double tap) / "View cart" / "Sold out"; "Choose size" scrolls to options and focuses the first unchosen group; safe-area inset; page spacer so the footer isn't covered; under the drawer and consent banner; no slide-in with reduced motion; `data-protected="buy-bar"`, no `data-part`, no plugin slots.
2. Server `offerProgress()` returns up to two nudges: the next spend goal with a progress bar and milestones for gift and free-shipping thresholds ("Add ₹301 more for a free Shaker"; gift needs strictly over, so the smallest whole amount that crosses); the nearest quantity tier ("Add 1 more for 15% off · Whey Tiers") with an "Add 1 more" button on the line it checked; a coupon minimum ("Add ₹200 more to use SAVE10"). Reached goals show "Unlocked" ticks. Copy uses offer and gift titles, never target values. An exclusive coupon suppresses what it suppresses. Inactive offers never show.
3. Progress block at the top of the drawer under the header, sticky, `aria-live="polite"`.
4. Phone drawer: full height (`100dvh`), `aria-modal`, focus moves in and is trapped, Escape closes and returns focus to the opener, page scroll locked, sticky footer with Checkout and a safe-area inset.
5. The drawer total equals checkout's server total; a tampered checkout body still gets the confirm-the-total 409.

**Files:** `lib/offers/progress.js` (pure, Edge-safe, calls `evaluateOffers`); `lib/cart.js` (`progress` in the payload); `components/cart/CartContext.js`; `components/cart/CartDrawer.js`; `components/cart/OfferProgress.js` (new); `components/pdp/StickyBuyBar.js` (new); `components/ProductPurchase.js`; `scripts/test-theme-render.js` (`buy-bar` in the protected scan); `scripts/test-offer-progress.js` + `test:offer-progress`; `scripts/test-mobile-buy.js` + `test:mobile-buy`; `scripts/drills/mobile-cart/{run.mjs,lib.mjs,stage-bar.mjs,stage-drawer.mjs}`, `drill:mobile-cart`; `docs/UI.md` ("Phone buy bar and cart").

**Permissions:** shoppers read only their own cart; another cart's cookie id gets an empty cart; the payload never carries `tags` or `productType`.

**Tests:** `test-offer-progress`: property test over 500 random carts (applying any shown nudge makes the engine apply it); gift at exactly the threshold; a line claimed by a higher-priority offer (no nudge); exclusive coupon; currencies; no target values in the output. `test-mobile-buy`: bar markup per state; `data-protected` and no `data-part`; the cart POST ignores a `progress` or `discount` body field.

**Drill `mobile-cart`** (390×844, touch; seeded `TIERED_QTY` 2+ for 10% and `FREE_GIFT` over ₹999): the bar appears, "Choose size" moves focus to options; Add shows the tier nudge, "Add 1 more" makes the offer line appear and the spend bar move; Tab stays in the drawer, Escape returns focus to the bar; checkout's total equals the drawer's.

---
## Events and side effects
| What | Where | Who reads it |
|---|---|---|
| audit `themes.apply` `{package, flagship, installed, withBrand, withHome}`; existing publish audit | `audit_log` | Audit, operators |
| `config.theme_pin.source` | control plane | operator Themes |
| slog `flagship_installed`, `search_facets {source, groups, ms}`, `search_facets_fallback` | logs | operators |
| analytics `search` with `filters` | shopper events | Growth |

## Checks the builder runs first
- All: `ls migrations/tenant | tail -2 && ls migrations/platform | tail -2`; `node scripts/test-schema-compat.js`; `grep -ln "ALTER TABLE" migrations/tenant/*.sql | head -3`.
- Line 1: `grep -n "data-kit\|Fraunces" "app/(storefront)/layout.js"`; `grep -n "tokens\|validateBrand" lib/themes/package-validate.js`; `grep -n "publishSet\|doc_" components/admin/onboarding/OpenStoreDialog.js | head`; `node scripts/test-brand-step.js && node scripts/test-theme-switch.js && node scripts/test-studio-tokens.js && node scripts/test-fonts.js`.
- Line 2: `grep -n "productsCollectionSchema\|collections()" lib/sync.js`; `grep -n "robots" "app/(storefront)/search/page.js" "app/(storefront)/layout.js"`; `node scripts/test-search-effective.js`.
- Line 3: `grep -n "TARGET_KINDS" lib/offers/match.js`; `grep -rln "consent" components/ | head -3`; `grep -rn "TIERED_QTY\|FREE_GIFT" scripts/seed*.js scripts/drills/offers | head`; `node scripts/test-offers.js && node scripts/test-shipping.js && node scripts/test-theme-render.js`.

## Risks
1. Nudge honesty at the engine's edges (strict `>`, claimed lines, exclusive coupons, net-basis shipping): engine check + property test; the reviewer gets this escape list.
2. The real Typesense path never runs in a drill (old indexes lack new fields until a full sync; `multi_search` and float price stats only against stubs): add to `MANUAL-CHECKS.md`.
3. Heading-font CSS specificity against `[data-kit]` and byte-identical CSS for stores without the token; `check-built-fonts` must still pass.
4. SQL facet cost (`json_each` per request): measured; over ~150 ms at 5,000 products is reported, not silently given a table.
5. Spend-percent tiers ("Add ₹300 more for 10% off") don't exist as an offer type; this plan nudges gifts, shipping and coupons by amount and tiers by quantity. A spend-tier offer type would be a later line.

## Builders
Opus for lines 1, 2 and 3 (migration and permissions; anonymous leak boundaries and filter escaping; money nudges and focus-trap UI). Sonnet for the flagship content in `lib/themes/flagships.js` once line 1 sets its shape, and the `docs/UI.md` sections.
