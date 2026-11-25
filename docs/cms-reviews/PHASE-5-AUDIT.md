# Phase 5 least-trusted audit

Date: 2026-11-25. Audited on `main` at `f6646dec` (end of Phase 5 lines 1–3; `5691bfac..main`, plan `docs/plans/phase-5.md`), read-only, by the reviewer agent.

**Suites run** through `heavy`, one at a time: `test-theme-packages` 28/0, `test-theme-render` 12/0 (layout render 3.6 ms with the package, 2.8 ms without), `test-theme-switch` 27/0, `test-support-reads` 36/0, `test-permissions` 149/0, `test-platform-permissions` 102/0. No drills were run during the audit.

**Callers:** `support`, and an operator under a support grant (`__Host-support`, which acts as `support`); the anonymous shopper; the signed-out visitor; another store's owner (a store B session sent to store A's host, and store B's own `thm_` ids).

## Entry points

| Entry point | Check | Support / operator support | Signed out / anonymous | Other store's owner | Proof (suite) |
|---|---|---|---|---|---|
| `GET /api/admin/themes` (`?status=archived`) | `storefront.read`; this store's database, filtered on `status` | 200 with an allowlisted view per package (no `package` column, no `sha256`) | 401 | 401 | test-theme-packages, test-support-reads |
| `POST /api/admin/themes` (upload) | `themes.manage` + origin; the body is read only after auth (256 KB cap on header and stream) | 403, nothing stored | 401 | 401 | test-theme-packages |
| `GET /api/admin/themes/[id]` | `storefront.read`; id pattern, then this store's database | 200 for installed and archived; store B's id is 404 with the same words as an unknown id | 401 | 401 | test-theme-packages, test-support-reads |
| `GET …/[id]?download` | the same `storefront.read`; `attachment`, `nosniff`, `no-store`; filename from the validated slug and version | 200, the stored normalised JSON; B's id 404 | 401 (proved in P5-A) | 401 (proved in P5-A) | test-theme-packages, test-support-reads |
| `POST …/[id] {archive}` | `themes.manage` + origin; 409 while live or in the draft | 403 | 401 | 401; A's id on B 404 | test-theme-packages |
| `POST …/[id] {apply}` | `storefront.write` + origin; strict parse; revision required; drafts only | 403, nothing written | 401 | 401; B's id 404 | test-theme-switch |
| `GET /api/platform/themes` | `requireOperator`; `config.theme_pin` | adds only `{id, slug, version, name}` | 401 | n/a | test-theme-switch |
| Pages `/admin/themes`, `/admin/themes/[id]` | actor + `storefront.read`; Upload/Archive behind `themes.manage`, Use behind `storefront.write`, Publish behind `storefront.publish` | read-only, no canary in props | redirect to sign-in | redirect | test-support-reads page sweep, test-theme-packages |
| Storefront package read (`packageFor` → `cachedTenantRead("theme", ["pkg", id])`) | id from the host's content source (live release; draft only under a valid preview session); host store's database; kill switch; row revalidated; surfaces `#rrggbb` only; styles compiled | n/a | live package only; a draft-only package is absent; B naming A's id renders its base kit; a tampered row can't inject; buy box, cart and checkout byte-identical | n/a | test-theme-render |
| Preview of the draft theme | existing preview session (refuses another store's session); `showDesign` | support can open the founder preview (Phase 4 precedent) | without the preview cookie, live only | n/a | test-theme-switch |
| Publish gate (`themePackageBlockers` in `publish()`) | `storefront.publish`; missing, other-store or archived package refused; `checkBrand` with package surfaces | 403 | 401 | 401 | test-theme-switch |
| Undo (`themeLayoutsWith`) | `undo` is a publish op (`storefront.publish`); members built on the server from this store's `publish_log`; layouts only when the theme changed | 403 | 401 | 401 | test-theme-switch |

## Attacks

- **Another store's `thm_` id:** every read runs on the host store's database; GET, download, archive and apply answer 404 with the unknown-id words; publish refuses it as "isn't on your store any more". Held.
- **Archived package:** support reads it (same store, `storefront.read`); apply 409 `ARCHIVED`, publish 409 `THEME_NOT_PUBLISHABLE`; an Undo to an older release still renders it, as planned. Held.
- **Draft-only package reaching a shopper:** only `contentSource()` picks the design; the draft only with this store's preview cookie. The cache key is `["storeasy", tid, "theme", "pkg", id]` and holds the immutable row; an anonymous request asks only for the live id. Held (real Next incremental cache not exercised).
- **Error text revealing another store's package:** fixed 404 words; duplicate check reads this store only. Held.
- **Audit rows and logs:** `themes.upload {slug, version, sha256}`, `themes.archive {slug, version}`, `themes.apply {package, withBrand, withHome, document, revision, layouts, homeDraftHash?, skipped?, partial?}`; refusal logs hold codes and size only. No package text. Held.
- **Operator Themes view:** only `{id, slug, version, name}`, rendered as text. Held.
- **Upload as a write channel into the storefront:** scanned, validated and normalised on upload, revalidated on render. Held.

## Gaps (fixed on `phase5/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P5-A | Low (test) | The archived list and Download were not proved for the least-trusted callers: the `?status=archived` probe ran on a fixture with no archived package in either store, and Download was never asserted for signed-out or store B's owner. | The support fixture archives one A package and an archived B canary; support and operator support see A's archived theme and never B's, on the route and on the page with `status=archived`; signed-out and store B's owner get 401 on `?download=1`. |

## Accepted

- Support and operator support read and download full package content (`storefront.read`); packages hold no secrets or customer data.
- Support can open the founder preview and so see the draft theme (Phase 4 precedent).
- The kill switch `ff_theme-packages` fails open when the flags can't be read, for render and upload; the package was checked at upload and at publish.
- An archived package still renders after Undo or rollback.
- Staff can name any `thm_` id in a design draft through the documents API; preview renders the base kit for an id not on the store, and publish refuses it.
- `POST /api/admin/themes/[id]` parses the JSON body before auth, so a malformed body from a signed-out caller gets 400, not 401; nothing is revealed (the documents route does the same).

## Not checked

- The Next incremental data cache in a real server (suites read directly).
- Browser markup and the RSC payload of preview versus anonymous pages (covered by the Phase 5 `drill:all`).
- Operator role granularity: any operator reads `/api/platform/themes`, as before.
- `baseMemo` in `lib/brand.js` keys on package surfaces with no size bound (memory, not access).
- Whether the tenant export includes `theme_packages` (completeness).
