# S61 — Header & footer structural variants (audit "Core" chrome contract)

Scope: the audit's customization contract row for header/footer —
"At least two structural variants; logos, menu/search arrangement, footer
groups". Ranked assignment RULES were deliberately deferred this run: the
audit instructs adding them only after explicit assignment proves reliable,
and explicit assignment shipped one day ago, unreviewed by Codex.

## What was built

- surface_templates grows two FAMILY-LEVEL surfaces (chrome has no
  entities, so no exception maps): header standard|centered and footer
  columns|minimal. Same block, so the variants are draft → preview →
  publish → rollback governed like every template, and the choices
  validate/normalize through the existing surface_templates case untouched.
- components/Header.js: the original layout is "standard", byte-identical
  (markup extracted into shared pieces — announcement bar, wordmark, icon
  links, nav strip — and reassembled verbatim). "centered" is a materially
  different arrangement: three-zone grid with the wordmark centered between
  the Shop-all link and the icons, search ALWAYS on its own centered row,
  nav strip centered on desktop. Announcement bar (data-sec kept), dropdown
  behavior, wishlist/account/cart identical in both.
- components/Footer.js: "columns" = the original four-group grid, verbatim.
  "minimal" = one centered band — wordmark + tagline, a single link row
  built from the same existence-checked pages logic (about/contact/
  policies), inline support contacts, legal line.
- Storefront layout: chromeData resolves surface templates once
  (release-governed) and passes headerVariant/footerVariant; the error
  fallback pins standard/columns.
- Theme → Page templates card: two new selects with structural hints; the
  exceptions UI stays products/collections-only.

## Verification

- test-sections 15/15 (chrome defaults merge; centered/minimal validate;
  unknown variant rejected); full CMS suite set green; `pnpm build` ✓
  (an intermittent Turbopack "next/font/google queries" failure reproduced
  WITHOUT changes and cleared permanently after `rm -rf .next` — stale
  build cache, not this change; two consecutive clean builds after).
- Browser (design harness, temporary Node-runtime flip reverted after):
  set {header: centered, footer: minimal} as a draft → the Designer's
  cookie-gated preview rendered the centered header (three-zone grid,
  search on its own row, announcement bar intact with its data-sec) and
  the minimal footer (centered band, single link row with All collections/
  Contact/Shipping policy, support email, legal line); DOM asserted the
  four-column grid absent. Draft reset afterwards.
- Staging/production: UNVERIFIED.

## Remaining roadmap after this item

1. Ranked assignment rules + ambiguity rejection — gated on explicit
   assignment proving out (audit ordering) and Codex's review of S57–S61.
2. Editorial role split (approve-without-publish), approval enforcement
   knob, broader section models for non-home families — later slices.
