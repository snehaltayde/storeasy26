# Phase 6 least-trusted audit

Date: 2026-11-25. Audited on `main` at `c93f6fd3` (Phase 6 lines 1 and 2; `452966fb..main`, plan `docs/plans/phase-6.md`), read-only, by the reviewer agent. The studio page, the bridge's `storeasy:order` / `storeasy:tokens` and `tokens-css.js` came in with step 0 (`827fa942`) and are audited here as Phase 6 entry points.

**Suites run** through `heavy`, one at a time: `test-studio` 14/0, `test-studio-drag` 22/0, `test-studio-tokens` 17/0, `test-preview-frame` 31/0, `test-support-reads` 37/0, `test-permissions` 149/0. No drills were run during the audit.

**Callers:** `support` and an operator under a support grant (both act as `support`); the anonymous shopper; the signed-out visitor; another store's owner (a store B session on A's host, and store B's own `doc_` and `thm_` ids).

## Entry points

| Entry point | Check | Support / operator support | Signed out / anonymous | Other store's owner | Proof (suite) |
|---|---|---|---|---|---|
| `/admin/studio` (`?doc=`, `?path=`) | actor; host store's `listDocuments`; `can = {write: storefront.write, publish: storefront.publish}` | 200, read-only shell, no write marks; an unknown `?doc=` opens home with fixed words, id never echoed | redirect to sign-in | redirect; B's `doc_` id opens home + note | test-studio, test-support-reads page sweep |
| Studio redirects | entity content and a writer's store with no home go to `/admin/editor` | redirect for entity content, else the studio | sign-in first | sign-in first | test-studio |
| Documents API ops the studio sends | `requireAdmin` with `storefront.read` / `.write` / `.publish`; origin on writes; revision and draftHash required | reads 200; every write 403; the client sends none (read-only api and store, no undo, Space only selects) | 401 | 401 | test-permissions, test-studio, test-studio-drag |
| Bridge `storeasy:order` | v2 hello, `!look`, `ok`, same origin, sender is `window.parent`; ids `ID_RE`, ≤ 200; only `style.order` / `display` change | founder frame only; nothing stored | no bridge for a shopper; a live page with a console cookie has `ok:false` | other origin ignored | test-preview-frame |
| Bridge `storeasy:tokens` | same gates; only `validateBrand` output, then `brandCssVars` with the layout's `look`; never raw CSS | as above | as above | as above | test-preview-frame, test-studio-tokens |
| `GET /api/admin/themes` `state.liveBrand`, `state.liveTheme` | `storefront.read`; host store's published design | 200, `state` keys allowlisted | 401 | 401 | test-support-reads, test-studio-tokens |
| `GET /api/admin/themes/[id]` `tokens` (Reset) | `storefront.read`; host store's row | 200 `ok, package, content, tokens`; B's id 404 | 401 | 401 | test-support-reads, test-studio-tokens |
| Design rail | read-only when `studio.readOnly`, no `can.write`, or a read-only store | values shown, inputs disabled, no Reset or fix buttons | n/a | n/a | test-studio-tokens |
| Publish dialog `publishSet` | shown only with write + publish; server checks `storefront.publish` and each item's revision and draftHash (Other drafts send the revision read when the dialog opened) | no button; API 403 | 401 | 401 | test-studio, test-studio-drag, test-permissions |
| Anonymous storefront HTML | bridge only in the editing frame | n/a | byte-equal to before; a draft token save leaves it unchanged | n/a | test-preview-frame, test-studio-tokens |

## Attacks

- **Another store's `?doc=`:** host store lookup, fixed words, id never echoed. Held; real two-store proof added in P6-A.
- **Support sending a documents write:** 403 at `requireAdmin`; the studio sends none. Held.
- **Bridge from a non-parent, another origin or a live page:** refused before any DOM change. Held.
- **Studio or bridge marks on an anonymous page:** none; shopper HTML byte-equal. Held.
- **New themes fields for support:** the published design (public on the storefront) and tokens derived from package content support could already read; B's id 404. Held.
- **Error text revealing another store's documents:** fixed words. Held.
- **Support sweep coverage:** the `studio` page row, its read-control rows and the new `state` / `tokens` keys are all listed. Held.

## Gaps (fixed on `phase6/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P6-A | Low (test) | Another store's real document id was never tried against store A: `test-studio` used a stubbed `listDocuments`, the sweep ran `/admin/studio` with no `?doc=`, and `getDocument` was probed only on A's id. | `test-support-reads` opens `/admin/studio?doc=<store B's doc id>` as support and operator support (home + note, no B id or canary in the text) and probes `getDocument` on B's id (404, keys `error, code`). |

## Accepted

- The studio page checks a signed-in actor, as `/admin/editor` does; every role holds `storefront.read` today.
- `liveTheme` and `liveBrand` are the raw published settings; they are public on the storefront.
- `storeasy:editor:hello` checks origin, not sender (predates Phase 6); order and tokens check both.
- Support can open the founder preview and see draft tokens after a reload (Phase 4 precedent).
- The bridge only reorders, hides and recolours the founder's own frame; nothing is stored.

## Not checked

- Real `postMessage` between windows (suites use a stand); covered by `drill:studio` in the phase suite.
- A store B owner session on A's `/admin/studio` specifically (relies on the shared `adminActor` host binding).

## Phase 6 browser suite

`drill:all` at `af499918` (2026-11-26, 3,460 s, 30 drills with `studio`): 28 of 30 passed. `support-access` found a real gap: support's studio reads (`listDocuments`, `getDocument`, the preview session) had no reasoned rows for `/admin/studio`, only for `/admin/editor`. Nothing was written. The rows are added. `p6` stopped once on a sign-in button still disabled under load. After the fix, `drill:support-access` and `drill:p6` both passed alone (1,022 s).
