# Phase 7 least-trusted audit

Date: 2026-11-26. Audited on `main` at `b63aed9d` (Phase 7 lines 1, 2 and 3; `bacf2cda..main`, plan `docs/plans/phase-7.md`), read-only, by the reviewer agent.

**Suites run** through `heavy`, one at a time: `test-flagship-themes` 28/0, `test-search-facets` 24/0 (SQL facets at 5,000 products about 120 ms), `test-offer-progress` 32/0, `test-mobile-buy` 12/0, `test-support-reads` 38/0, `test-permissions` 149/0, `test-shopper-reads` 35/0. No drills were run during the audit.

**Callers:** `support` and an operator under a support grant (both act as `support`); the anonymous shopper; a signed-in shopper; the signed-out visitor; another store's owner (a store B session on A's host, and store B's own `thm_` ids).

## Entry points

| Entry point | Check | Support / operator support | Shopper / signed out | Other store's owner | Proof (suite) |
|---|---|---|---|---|---|
| `GET /api/admin/themes` `flagships` | `storefront.read`; host store's `source='storeasy'` rows; card data from code | 200, keys allowlisted; reading installs nothing | 401 | 401 | test-support-reads, test-flagship-themes |
| `GET /api/admin/themes/<slug>` (+ `?download`) | `storefront.read`; 5-slug allowlist, else the host store's `thm_` row | 200 (first-party data) | 401 | 401; B's `thm_` id 404 | test-support-reads, test-flagship-themes |
| `POST /api/admin/themes/<slug or thm_> {apply}` | key allowlist; `storefront.write` + origin; `ensureFlagship` (INSERT OR IGNORE, deterministic id) → `applyPackage`; audit `themes.apply` | 403, nothing installed | 401 | 401; A's flagship id on B 404 | test-flagship-themes, test-permissions |
| Archive a flagship | `themes.manage`; refused by slug and row source (409 `STOREASY_THEME`) | 403 | 401 | 401 | test-flagship-themes |
| Upload with a flagship slug | `themes.manage`; `RESERVED_ID` before insert; uploads never get `source='storeasy'` | 403 | 401 | 401 | test-flagship-themes |
| Kill switch `ff_theme-packages` | skipped only for rows whose stored `source` is `storeasy` | n/a | live flagship renders, upload doesn't | n/a | test-flagship-themes |
| `GET /api/admin/brand-step` (`themes`, `current.themeId`, `themeLayouts`) | `storefront.read`; host store | 200, keys allowlisted | 401 | 401 | test-support-reads |
| `POST /api/admin/brand-step {themeId}` | `storefront.write` + origin; flagship slug or null; drafts only | 403 | 401 | 401 | test-flagship-themes |
| Themes pages, onboarding picker, Design rail font | `storefront.read`; Use / Update behind `storefront.write`; read-only inputs disabled; no Archive on flagships | read-only; Preview and Details are listed reads | redirect to sign-in | redirect | test-support-reads (now including `/admin/themes/bloom`, P7-B), test-flagship-themes |
| `GET /api/platform/themes` `package.source` | `requireOperator` | operator read | 401 | n/a | test-flagship-themes |
| `/search` with facets (Edge) | `parseFacetParams` (backticks, `\`, control chars stripped; caps; numeric min/max; sort and page allowlisted); bound SQL over the host store's active products and effective values; Typesense in the store's own namespace with every value in backticks; tags never a facet | same as anonymous | 200, own store only; filtered pages noindex | B's values, counts and results never on A | test-search-facets |
| Cart read `progress` | built inside `getCart` from engine lines and the store's active offers; only the shopper's own coupon code; offer and gift titles and money only, never tags, productType or targets | n/a | own cart cookie; unknown id gives an empty cart | n/a | test-mobile-buy, test-offer-progress, test-shopper-reads |
| `POST /api/cart`, checkout POST | body `progress`, `discount`, `discountTotal`, `total` ignored; checkout recomputes; confirm-the-total 409 kept | n/a | server numbers only | n/a | test-mobile-buy |
| `StickyBuyBar`, `OfferProgress`, `CartDrawer`, `FacetSheet` | client components on props and the cart payload; no new fetch; `data-protected="buy-bar"` | n/a | no new data | n/a | test-mobile-buy, test-theme-render |

## Attacks

- **Another store's flagship or package id:** 404 on GET and apply; the slug path serves first-party code data. Held.
- **Support or op-support installing or applying:** 403; nothing installed; no GET installs. Held.
- **Facets revealing other stores', inactive or draft data, or tags:** per-store database, active products only, published values, no tags group. Held.
- **Facet injection** (`` ` ``, `&&`, `||`, `)`, 5,000-char values, 100 repeated keys): stripped or capped, never raw in `filter_by`; SQL binds every value. Held.
- **Cart payload leaking tags or productType, or another shopper's cart:** engine-only fields stripped; cart id from the cookie only. Held.
- **Client-supplied progress or discount:** ignored; the 409 still fires on a tampered total. Held.
- **Nudge copy revealing targets or other shoppers' codes:** titles only; only the code the shopper typed; inactive offers never load. Held.
- **Error text revealing existence:** fixed words. Held.

## Gaps (fixed on `phase7/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P7-A | Low (integrity) | A brand step with a `themeId` writes the design draft, then layout drafts, then config; if a later step failed (a teammate's layout save between read and write, or a config failure), the route wrote no `audit_log` row although the design draft already named the flagship. | The refusal carries the partial state and the route audits `brand-step` with `partial: true`, as `applyPackage` does; suite case with a stubbed layout 409. |
| P7-B | Low (test) | `/admin/themes/<flagship slug>` was never rendered as support or operator support; only a source regex guarded its Use / Update / no-Archive controls. | `test-support-reads` renders `/admin/themes/bloom` for both callers: 200, no use, update or archive controls, only listed read-controls. |

## Accepted

- The flagship row id is the same on every store (deterministic by design); it names first-party data.
- `ensureFlagship` runs before the design revision check, so a stale-revision 409 can still leave a flagship row installed; it is idempotent, changes no content, and is logged.
- Free-text search matching on raw tags predates Phase 7; facets add no tag surface.
- Filters with no query list the store's active products, which are public.
- Nudges carry offer ids, as `appliedOffers` already did.
- A spend-goal gift not yet reached is named by the offer's stored gift title.
- The cart cookie is a bearer UUID (earlier design).
- Operator Themes is visible to every operator role, as before.

## Not checked

- Real Typesense `multi_search` and price stats (stubbed `fetch` only; in `MANUAL-CHECKS.md`).
- Browser markup (covered by the Phase 7 `drill:all`).
