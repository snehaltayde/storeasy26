# P1-CONTRAST: two hard-to-read texts, and the colour pairs TOK missed

Branch `cms/p1-contrast`, cut from `d890d80` (the `cms/phase-1` head after batch C). Inputs: batch C findings 2 and 4 (`docs/cms-reviews/P1-DRILLS-C.md`), and the TOK review's open items (`docs/cms-reviews/P1-TOK-01-02.md`, "From review").

This is the builder's own report. Reviewers should re-read the code and look at the screenshots.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: **55 of 55 suites passed**. `test:tokens` **64 passed, 0 failed** (55 on `d890d80`). `pnpm build` passed. 26 deliberate breaks, 26 caught (`drills/CONTRAST/mutations.txt`) |
| Browser verified | Yes, on the design harness on this Mac (`next dev`, edge runtime, local `sqld`), desktop Chrome 156.0.8078.80 headless. Batch C's `c-rest-themes` now **85 passed, 0 failed** (81 and 4 in batch C); `c-pulse-brand` passes its link check and fails only its pixel-equality check, which is the brand's own lime ladder (see "Not fixed here"). Not Safari, not a phone |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What was wrong

1. **The wishlist's missing-photo "?"** was the `mark` role on the sunken surface: `#d4d4d8` on `#f4f4f5`, **1.34:1** on the default look; `#777471` on `#f5f3ee`, **4.19:1** on the light test theme; `#797d83` on `#151921`, **4.25:1** on the dark one (batch C finding 4).
2. **The content page's "Home" and "Contact us" links** had no colour of their own. They inherited the faint grey of the words around them: `#9f9fa9` on white, **2.62:1**, on a store with the Pulse kit's own brand and on every store with no brand (batch C finding 2).
3. **`PAIRS` didn't list every pair a renderer draws**, and the coverage test only checked that each text role appeared in some pair. The TOK review named four gaps. A pair-level scan (below) found three more.
4. **Mutants R12 and R2** from the TOK review, and the layout line for a store with no brand that no unit test read.

Found on the way, and fixed because it is the same kind of fault a shopper sees: **the words "Coupon" and "Remove" on an applied coupon** were subtle grey on the accent's palest tint. For an accent-only brand such as `#2563eb` (white page, `#0a0a0b` text) that is `#71717b` on `#e5ecfd`, **4.08:1**. Measured in Chrome below.

## Cause

- **1 and 2:** each renderer picked a role made for decoration (`mark`: arrows and separators) or for captions (`text-faint`), and used it for something a shopper must read. TOK keeps the default look's own greys on purpose (an owner decision), and a brand with the platform's own white and `#0a0a0b` keeps them too, so no derivation could reach these.
- **3:** the coverage test looked at roles, not at which background each text role sits on.
- **The coupon:** the pair `text-subtle` on `accent-subtle` was never in `PAIRS`, so nothing measured it.

## The fix

**Renderer roles (three files).** Each now uses a role whose pair with its background is already enforced at 4.5:1 for every derived brand, and already passes on the default look:

| Where | Was | Now | Pair (already in `PAIRS`) |
|---|---|---|---|
| `components/WishlistPage.js`, the missing-photo "?" | `text-sf-mark` | `text-sf-text-muted` | `text-muted-sunken` |
| `components/ContentPage.js`, "Home" and "Contact us" | inherited `text-sf-text-faint` | `text-sf-text-subtle` (hover `text-sf-text-muted`, as before) | `text-subtle` |
| `components/cart/CartDrawer.js`, "Coupon" and "Remove" on an applied coupon | `text-sf-text-subtle` | `text-sf-text-muted` (Remove's hover `text-sf-text-soft`, as before) | `text-muted-accent-subtle` (new) |

The words around the links ("/", "Operated by …", "Questions?") stay faint; that is the default-look decision TOK already listed.

**Why no change to `roleCssLines` was needed.** The other route was to correct `text-faint` (and `mark`) for any set brand, the Pulse kit's own included. That repaints every caption, old price and product type on those stores, which is more than the fix needs, and stores with no brand would still show the links at 2.62:1. The role swap fixes the links on every look and moves no other pixel.

**`PAIRS` (`lib/brand.js`), seven new pairs, all `text`:**

| Pair | Drawn by |
|---|---|
| `text-body-panel`: body copy on the muted surface | search page and collection page no-results panels; the search box's recent searches on hover; cart drawer and cookie banner buttons on hover |
| `accent-text-sunken`: links on the sunken surface | search box "View all results" on hover |
| `accent-text-subtle`: accent text on the palest accent tint | the saving on an applied coupon |
| `text-muted-accent-subtle` | "Coupon" and "Remove" on an applied coupon |
| `text-soft-accent-subtle` | "Remove" on an applied coupon, on hover |
| `danger-panel`: red on the muted surface | "cancelled" on a shipment, order page |
| `on-overlay-media`: white on the collection card's dark fill | collection names on their cards |

`mark` on `surface-sunken` is **not** added: after the fix no renderer draws it, and the pair scan proves that. Listing a pair nothing draws would also tighten `mark` for every derived brand for nothing.

**Effect of the new pairs on colours.** For the default look on both kits, the Pulse and Glow kits' own brands, both test themes, the seeded brand and a dark brand on Glow, `brandCssVars` writes byte-for-byte the same CSS as on `d890d80`, and the same pairs fail. Over 9,000 random brand and kit checks: 592 change a derived role (`accent-text` 334, `danger` 202, `text-muted` 104, `text-soft` 68), each by a step to pass a pair it was failing; 4 (two brands, both kits) that published before would now be refused. Both have mid-tone green text on a dark background, where the coupon's words fail at 4.23 and 4.28:1. A store that already shows such a brand gets a warning, not a refusal, because the check compares with the live store.

**Pair-level coverage (`scripts/token-pairs.js`, new, plain node, no dependency).** It reads every storefront file the lint reads and lists each text role drawn over a background role:
- on one element: in one string, in a template's fixed text plus one `${…}` branch, or through a same-file constant such as `activeCls`;
- nested: an element's text over the nearest background around it in the same file;
- inherited: an element's own background under the text colour around it, when it holds words.

`hover:`, `focus:` and `group-hover:` backgrounds count as backgrounds; `disabled:` and `placeholder:` classes are left out. Branches of a ternary are never paired with each other. It finds 238 drawn pairs. Two are false (the collection filter chip's count, whose colour follows the same `active` test as the chip); they are listed in `PAIR_SCAN_EXEMPT` in `scripts/test-tokens.js` with the reason, and an entry the scan no longer finds fails the test.

**Tests added to `test:tokens`** (`scripts/test-tokens.js`, already in `pnpm test`):

| Test | What it proves |
|---|---|
| the pair scan finds a pair on one element, across a template's branches, through a same-file constant, nested, and under inherited text | the scanner itself, on a written source, with four pairs it must **not** find |
| the pair scan finds each pair the TOK review found missing, in the real files | search no-results, the drawer's hover, the search box's hover, collection cards |
| every pair a storefront renderer draws is in PAIRS (pairs, not just roles) | the coverage check, pair by pair |
| each pair the scan is excused from has a reason and is still found | the exemption list can only shrink |
| FINDING 4: the wishlist's missing-photo "?" is 4.5:1 or better on every look | reads the "?" element's classes from `WishlistPage.js`; six looks |
| FINDING 2: the content page's links are 4.5:1 or better on every look | reads both links' classes from `ContentPage.js`; six looks |
| R12: every accent correction and tint brandRoles makes is a `--sf-` line in brandCssVars | 205 brands (200 random, five named, no brand) on both kits; at least 100 corrections exercised |
| the storefront layout's chrome calls brandCssVars for a store with no brand | takes the `brandCss:` expression out of `chromeData` in `app/(storefront)/layout.js` and runs it as written: no brand on Glow must carry the corrected accents, no brand and no theme writes nothing, brands match `brandCssVars`; and the page must write `chrome.brandCss` into `<style id="brand-vars">` |
| R2, real routes: a store with no brand that only changes its theme kit is checked at Publish now, and refused | through `handleReleasesPost` on a real tenant database: publish no brand on Pulse (200), switch only the theme to a stand-in kit with an unreadable hero subtitle, Publish now answers 422 naming "Hero subtitle" |

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | The wishlist "?" reads at 4.5:1 or better on both test themes | **Pass** | Chrome: light `#615f5c` on `#f5f3ee` **5.74:1**, dark `#abafb4` on `#151921` **7.98:1** (`drills/CONTRAST/x-fixed-pairs/contrast.json`). `c-rest-themes` wishlist rows pass at 375 and 1440. Unit: FINDING 4 |
| 1a | …and on the default look (1.34:1 before) | **Pass** | Chrome: `#52525c` on `#f4f4f5` **7.02:1**, no brand on Pulse and on Glow, the Pulse brand and the blue-accent brand. Before, the same run on `d890d80`'s components: 1.34:1 on all four (`results-x-fixed-pairs-before.json`) |
| 2 | On the Pulse kit's own brand, the policy page's "Home" and "Contact us" are 4.5:1 or better | **Pass** | `c-pulse-brand`: "links measure 4.5:1 or better": both `#71717b` on white, **4.83:1** (was 2.62:1). Also on every other look in `x-fixed-pairs` (light 5.8:1, dark 6.21:1, no brand 4.83:1) |
| 3 | Fixed through the semantic roles, no hard-coded colour | **Pass** | `THE LINT` passes; the three renderers use `text-sf-*` roles only |
| 4 | No other page's pixels change beyond what the fix needs | **Pass**, with the scope below | Role CSS is byte-identical on eight named looks (above). `c-pulse-brand`'s pixel comparison against no brand on Pulse gives the same numbers and boxes as batch C on 11 of 12 shots, and the CMS page's diff box is still only the top 58 px (the announcement bar), so the link fix moved both looks alike. Home differs by 2,267 px from batch C's run, all in the animated hero (noise seen in batch C too). Default-look pixels that do change: the "?", the two links, and "Coupon" and "Remove" on an applied coupon. No screenshot set covered those three spots before, so none of TOK's 30 default-look baseline shots is affected |
| 5 | `PAIRS` holds the four pairs the review named: text-body on surface-muted, accent-text on surface-sunken, mark on surface-sunken, on-overlay on media | **Pass for three; the fourth is gone** | `text-body-panel`, `accent-text-sunken`, `on-overlay-media` added. `mark` on `surface-sunken` was the wishlist "?", which no longer draws it; the scan finds no renderer that does |
| 6 | The coverage test checks pairs, not just roles | **Pass** | "every pair a storefront renderer draws is in PAIRS". Fails on `d890d80`, listing `text-body` on `surface-muted` (seven places), `accent-text` on `surface-sunken`, `mark` on `surface-sunken`, `on-overlay` on `media`, `danger` on `surface-muted` and the coupon's pairs. Each of the seven new pairs, removed alone, is caught (P1 to P7) |
| 7 | A unit test that the layout's chrome calls brandCssVars for a null brand | **Pass** | Putting back `brand ? brandCssVars(...) : ""` fails it (L1), as do dropping the kit (L2) and guarding the `<style>` tag (L3) |
| 8 | R12 killed | **Pass** | Six forms of R12 (all corrections, ladder only, tint only, set brands only, no brand only, `brandCssVars` dropping `roleCssLines`), each caught by the new R12 test |
| 9 | R2 killed | **Pass** | R2 and R2a (the kit ignored at publish) caught by the new real-route test as well as TOK's `validateRelease` one |
| 10 | `tokc.mjs c-pulse-brand` and `c-rest-themes` pass except the documented decisions | **Pass** | `c-rest-themes` 85/0. `c-pulse-brand` 5/1: the one failure is pixel equality with the no-brand look, from the brand's own lime ladder (`#a3e635`→`#a8eb43`) and the documented link correction (`#4d7c0f`→`#456c09`). Same pixels as batch C |
| 11 | `pnpm test` and `pnpm build` | **Pass** | 55 of 55 suites; build passed with the one Turbopack NFT warning about `next.config.mjs` that earlier packets record |
| 12 | Edge runtime | **Pass** | No storefront route gained an import. The renderer changes are class names; `lib/brand.js` gained data only. `scripts/token-pairs.js` is test-only and uses no node API |

### Tests that fail on the base

Run on a copy of `d890d80` with only the new `scripts/test-tokens.js` and `scripts/token-pairs.js`: **61 passed, 3 failed**:
- "every pair a storefront renderer draws is in PAIRS" (`text-body` on `surface-muted` in seven places, `accent-text` on `surface-sunken`, `mark` on `surface-sunken`, `on-overlay` on `media`, `danger` on `surface-muted`, and the coupon's pairs);
- FINDING 4 ("mark #d4d4d8 on surface-sunken #f4f4f5 is 1.34:1");
- FINDING 2 ("Home sets its own text role … got 0").

The R12, R2 and layout tests pass on the base, because the base code is right; they exist to catch the mutants, and they do.

### Do the tests bite?

26 breaks, each applied alone, `test:tokens` run, the file put back (`drills/CONTRAST/mutations.txt`). All 26 caught: R12 ×6, R2 ×2, layout ×3, the three renderer fixes put back or weakened ×5 (the "?" on subtle grey, 4.39:1 on the default look, included), each new pair removed ×7, and the scanner weakened ×3 (no nested pairs, hover backgrounds ignored, template branches not joined to the fixed text).

## Browser evidence (`docs/cms-reviews/drills/CONTRAST/`)

Harness: `DESIGN_PORT=3271 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js seed`, then the same without `seed`. Runner: `DESIGN_PORT=3271 node scripts/drills/p1c/run.mjs contrast <part>`. `scripts/drills/p1c/contrast.mjs` (new) is a journey with id `CONTRAST`, so its output lands here and batch C's TOK-01-02 evidence is untouched. Its `c-pulse-brand` and `c-rest-themes` parts are batch C's own, unchanged.

| Part | Result | What happened | Evidence |
|---|---|---|---|
| `x-fixed-pairs` (new) | **Pass, 72/0** | Six looks (no brand on Pulse, no brand on Glow, the Pulse kit's brand, accent-only `#2563eb`, light and dark test themes), at 375 and 1440. Each: the wishlist "?", the policy page's two links, and "Coupon", the code, the saving and "Remove" on an applied coupon, measured from computed styles. Lowest values: "?" 5.74:1, links 4.83:1, coupon words 4.82:1 (the saving, `#4d7c0f` on `#f7fee7`, no brand) | `x-fixed-pairs/*.png` (36), `x-fixed-pairs/contrast.json`, `results-x-fixed-pairs.json` |
| `x-fixed-pairs` on `d890d80`'s three components | **50 passed, 22 failed**, as expected | The same run with `ContentPage.js`, `WishlistPage.js` and `CartDrawer.js` put back to the base (hot reload, then restored). "?" 1.34:1 on four looks, 4.19:1 light, 4.25:1 dark; links 2.62:1 on four looks; "Coupon" and "Remove" 4.08:1 on the blue brand | `x-fixed-pairs-before/*.png`, `results-x-fixed-pairs-before.json` |
| `c-rest-themes` (batch C's) | **Pass, 85/0** (batch C: 81/4) | 1,623 text and icon pairs over the account, orders, order page, confirmation, wishlist, quiz, bundle, shipping policy and checkout review and payment, on both test themes at 375 and 1440. The disabled "Pay online" label is exempt, as in batch C | `c-rest-themes/` (40 shots), `c-rest-themes/contrast.json`, `results-c-rest-themes.json` |
| `c-pulse-brand` (batch C's) | **5 passed, 1 failed** (batch C: 4/2) | Links: "Home" and "Contact us" 4.83:1, "View all →" 6.17:1, footer links 4.62:1. Pixel equality fails on the brand ladder, as in batch C | `c-pulse-brand/home-1440.png`, `c-pulse-brand/pixel-diff.json`, `c-pulse-brand/diff-*.png`, `results-c-pulse-brand.json` |

Setup the drills did on the harness, all local:
- `c-rest-themes` placed one Cash on Delivery order as **snehal@mediastic.in** (through `DRILL_ORDER_EMAIL`, a new optional setting in `tokc.mjs`; without it the drill uses its own `@design.test` address as before) and signed that shopper in with the code read from the local notifications table. Email, Razorpay and Shopify keys are blank on the harness, so nothing left this Mac. The order is in this worktree's local harness database only, and a re-seed wipes it.
- `x-fixed-pairs` inserted a coupon `CONTRAST10` into the local `offers` table (the seed's FESTIVE10 starts in five days) and deleted it afterwards.
- Each part put the live release back.

The harness stopped by itself at 17:29:40, seven seconds after the last drill finished: its platform `sqld` logged a SIGTERM (`.design-data/platform.log`) that none of this session's commands sent, as far as I can tell, and the harness then stopped Next and the other two. No drill was running. Nothing from this worktree is left running; ports 3271 and 18320 to 18322 are free.

## Not fixed here

- **The Pulse kit's own brand is not pixel-equal to no brand.** Its lime surfaces are `#a8eb43`, not `#a3e635`, because a brand builds its own ladder from its accent (`accentShades`), and its links are the documented `#456c09`. A shopper can't see the first. Closing it means using `DEFAULT_ACCENT_LADDER` whenever the accent is exactly `#84cc16`, which would repaint every page of those stores; that is an owner decision (MANUAL-CHECKS), not part of this fix.
- **The default look's own faint pairs stay** (faint grey text 2.6:1, placeholders, wordmark accents, red on its tint): TOK's listed owner decision. This item only moved text a shopper must act on or read to understand the page.

## Known limits

- **The pair scan is static.** It can't see a component's background from the file that renders it (for example a component placed on a muted panel elsewhere), classes built from data at run time, or a ternary whose branches are tied to the parent's by the same condition (the two exemptions). The browser drills measure what is drawn; `c-rest-themes` and `x-fixed-pairs` cover the pages above, not every page.
- **It found more than the review named**, and I added them: the coupon's three pairs, `danger` on the muted surface, and body text on the muted surface in seven places, not two.
- **Four of 9,000 random brand and kit checks now refuse a publish** they allowed before (two odd dark brands; above). That is the coupon pair doing its job; a store already live with such a brand gets a warning.
- **The coupon fix changes the default look** in the drawer's applied-coupon box ("Coupon" and "Remove" from `#71717b` to `#52525c`). It was 4.66:1 on the default lime tint and passed; it changed so blue and other accent-only brands pass.
- **Desktop Chrome headless on macOS, on `next dev`** only. No Safari, no phone, no production build in the browser.
- **The layout test reads the source.** It runs the `brandCss:` expression as written in `chromeData`, with `kitAttr` stood in (`"<kit>-<version>"`), because the layout itself needs Next's request APIs. A rewrite that moves the call out of that line makes the test fail with "update this test", not pass silently.
- **`mutations.txt` was made by a script in the builder's scratch folder**, not committed. Each line names the break and the tests that caught it; each break is a one-line text replacement described by its name.

### From review

Non-blocking findings from the independent review, added at merge.

- Adding the seven pairs to PAIRS changes the colour corrections for a small share of brands, so every page of those stores shifts, not only the three fixed elements. I compared base and head brand.js over 9,000 random brand and kit combinations with a different seed from the builder's. 792 changed at least one role: accent-text 434, danger 292, text-muted 140, text-soft 101. For accent-only brands, the realistic case, 51 of 4,500 moved accent-text, which repaints links on every page. The builder disclosed this (592 in their run), and it follows from the task's request to list the missing pairs. Still, the acceptance item 'No other page's pixels change beyond what the fix needs' is only shown for the 8 named looks.
- Some brands that published at base would now be refused at publish. In my run there were 10 of 9,000, all odd brands with a coloured background, and every one fails only text-muted-accent-subtle, the applied-coupon words pair this branch introduced. The builder reported 4. A store already live with that brand gets a warning, not a refusal: I checked publishBlocked with live set to the same brand and it returned false. These brands already showed the coupon words below 4.5:1 at base, unlisted, so the refusal reports a real problem. The founder should still know about it.
- Mutation gap: changing text-muted-accent-subtle (or any new pair) from kind 'text' to 'large' passes all 64 test:tokens tests (M20). The coverage test matches fg and bg only, not the kind, and no ratio test covers the coupon words the way FINDING 2 and FINDING 4 cover the links and the '?'. A 3:1 regression on the coupon would go unseen.
- Already present at base, not from this branch: the maintenance page in app/(storefront)/layout.js (around line 213) still uses `brand ? brandCssVars(resolveBrand(brand)) : ""` with no kit. A store with no brand on Glow gets no kit corrections there, and a branded store is corrected against Pulse. The new layout test only reads chromeData, so this path is not covered.
- Environment note: `pnpm test` cannot run in a worktree whose node_modules is a symlink. pnpm's dependency check tries to reinstall and purge modules, and it aborted only because there was no TTY. The main node_modules was checked afterwards and is intact. I ran all 55 suites directly with node instead, and all passed.
- What I verified: on base the ratios are mark on surface-sunken 1.34 (default look), 4.19 (light theme), 4.25 (dark theme); text-faint on surface 2.62 (Pulse brand); text-subtle on accent-subtle 4.08 (blue accent). On head the same spots read 7.02, 5.74, 7.98, 4.83 and 6.52. test:tokens passes 64 of 64. 19 of 20 mutations were caught: the '?' back to mark or faint or on a strong background, either link losing its colour or going faint, Coupon and Remove back to subtle, dropping text-body-panel, on-overlay-media or danger-panel, the layout's old ternary or a dropped kit, R12 in two forms, the scan's nested and same-element detection switched off, hover variants ignored, and the coupon background swapped. Edge runtime: token-pairs.js is imported only by scripts/test-tokens.js; the app-side changes are className strings and PAIRS data. Cross-tenant: no tenant data is touched, and the R2 test restores tk's theme and the global KITS and KIT_SURFACES in finally. The browser drills were not rerun. The evidence JSON matches the claims: x-fixed-pairs 72/0, before-run 50/22, c-rest-themes 85/0, c-pulse-brand 5/1. The worktree and the mutation copy are removed and nothing is left running.

## Files

- `lib/brand.js`: seven pairs in `PAIRS`. No role, derivation or CSS emission change.
- `components/WishlistPage.js`, `components/ContentPage.js`, `components/cart/CartDrawer.js`: the role swaps above, each with a short comment.
- `scripts/token-pairs.js` (new): the pair scan.
- `scripts/test-tokens.js`: nine tests and `PAIR_SCAN_EXEMPT`.
- `scripts/drills/p1c/contrast.mjs` (new): the `CONTRAST` journey; `scripts/drills/p1c/tokc.mjs`: optional `DRILL_ORDER_EMAIL`.
- `docs/cms-reviews/drills/CONTRAST/`: the evidence above, 1.4 MB.
- `docs/cms-reviews/MANUAL-CHECKS.md`: a "Phase 1, batch D" section.

## Owner checks

Added to `docs/cms-reviews/MANUAL-CHECKS.md` under "Phase 1, batch D":
- On a phone on staging: the "?", the two links and the coupon's words are easy to read.
- Decision: keep the darker grey for those three spots on the default look?
- Decision: leave the Pulse kit's brand ladder (`#a8eb43`) as it is?

## Commands

```
git worktree add <scratch>/wt d890d80 && git -C <scratch>/wt checkout -B cms/p1-contrast
pnpm install --frozen-lockfile --prefer-offline
node scripts/test-tokens.js
pnpm test
pnpm build
DESIGN_PORT=3271 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js seed
DESIGN_PORT=3271 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js        # left running
DESIGN_PORT=3271 node scripts/drills/p1c/run.mjs contrast x-fixed-pairs
DRILL_ORDER_EMAIL=snehal@mediastic.in DESIGN_PORT=3271 node scripts/drills/p1c/run.mjs contrast c-rest-themes,c-pulse-brand
```
