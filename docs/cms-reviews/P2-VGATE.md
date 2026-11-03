# P2-VGATE: the reader version gate, shipped before any v4 writer exists

Plan: `docs/cms-reviews/P2-PLAN.md` (decisions 4 and 5, batch 1). Spec: PUB-01 and PERF-01 (section 7), section 8. Branch `cms/p2-vgate`, cut from `4992670`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. After fix round 1: `pnpm test` 57 of 57 suites passed in 104.8 s, `test:releases` 35 passed, 0 failed. First round: 57 of 57 in 107.1 s, `test:releases` 34 passed, 1.1 s in the gate (2.7 s on its own). Nine deliberate breaks, eight caught (see "Do the tests bite?"). `pnpm build` passed. Its 2 warnings are the ones that were already there (`next.config.mjs`, traced through `lib/platform/migrate.js`), not from this item |
| Browser verified | Yes, on the design harness on this Mac (ports 3420 and 4420 to 4422), in the Claude desktop app's built-in browser at 1440 x 900. Not Safari, not a phone. See "Browser evidence" |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No tenant changed mode. No migration |

## What and why

Phase 2 will store a release as a version 4 list of document versions (PUB-01). The code at `a6d028e` checks only that `content.v` is truthy. It would read a v4 row as a legacy snapshot with no blocks, and shoppers would get the empty default site with no error. So the reader must refuse v4 before any writer can make one. A deploy that rolls back to a commit without this gate cannot be protected (DR-1).

## The design

**`lib/releases.js`, `getLiveReleaseState`.**
- One statement reads the pointer and its release: `release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1` (PERF-01, plan decision 5). It was two statements before.
- The states stay distinct, as before:
  - no `release_state` table: `none` (only "no such table: release_state" counts, as before);
  - no pointer: `none`;
  - a pointer with no row, bad JSON, content that isn't an object (an array included), or no `v`: `error`.
- Then the envelope version, exact numbers only:
  - 1, 2 or 3: `live`, read by the legacy reader;
  - 4: `live`, with `release.v` 4;
  - anything else (0, 5, 99, the string `"3"`, 3.0001, `true`): `error`.
- `release` gains one field, `v`, so callers branch without re-reading content. Exports `LEGACY_RELEASE_VERSIONS` ([1, 2, 3]) and `DOCUMENTS_RELEASE_VERSION` (4).

**`listReleases`** leaves out rows where `published_at` and `scheduled_for` are both null. Those are leftovers of a publish that lost its race or failed between the insert and the flip. The row the live pointer names is always listed, because today's flip and stamp are two statements and the live row can be unstamped.

**`lib/content/resolve.js`, `contentSource`.** A live release whose `v` isn't 1, 2 or 3 throws `ContentUnavailableError` with `detail.code` `READER_NOT_READY` for v4 (`UNKNOWN_VERSION` otherwise, which `getLiveReleaseState` already prevents). Every `resolved*` getter goes through `contentSource`, so no legacy helper ever sees a v4 row. P2-READ replaces this branch. Also exported: `isContentUnavailable(e)`, which also accepts the error's `code` in case a bundler loads the module twice.

**`app/(storefront)/layout.js`.**
- `chromeData`'s catch: on `ContentUnavailableError` it returns the neutral chrome with `navHeader: []` and `navFooter: []`. Announcement off, `brandCss` "", footer pages empty, name "Store", kit `pulse-1`. Before, the nav was `null`, and `null` makes Header and Footer list the catalog's collections. Any other error returns the same neutral chrome as before, nav `null` included.
- The maintenance page: brand and theme are now awaited inside `tfetch`. Before, the array held their promises, so the `.catch` never saw a failure. On a v4 release the curtain showed the store's name and the rejection went unhandled (in the unit test it crashed the Node process). Now any failure gives the neutral curtain: "Store", no brand, default kit. The catch itself is unchanged.

**`scripts/support/request-cache.js`** (shared, later items reuse it and must not edit it). A `registerHooks` loader that gives app code a `react` whose `cache()` memoizes per `runRequest(fn)`, with React's rules (same arguments, a rejection is memoized too, nothing memoized outside a request). Also `watchStatements(client, fn)`, which counts the SQL a libSQL client runs. Only ES module imports of `react` from the repo's own files are swapped. `require("react")` and `node_modules` get the real one.

**`scripts/support/legacy-release-outputs.js`** records what `getLiveReleaseState`, `contentSource` and 23 getter calls return for a v1, a v2 and a v3 release on a throwaway tenant. It imports the app by relative paths, so the same file run inside an older checkout records that checkout. `scripts/fixtures/legacy-release-outputs.a6d028e.json` was recorded inside an `a6d028e` checkout, and re-recorded there before this commit: byte-identical.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | v1, v2 and v3 rows give the same `getLiveReleaseState` and `resolved*` outputs as `a6d028e` | **Pass** | `test:releases` "v1, v2 and v3 releases … answer as a6d028e did". Runs the recorder now and compares every output with the fixture. The only difference allowed is the new `release.v`, which must equal the envelope's `v`. Fails without the change: yes for `release.v` (break 4). The rest is a guard that would fail on any change in what legacy rows read |
| 2 | A v4 row makes `contentSource` throw `ContentUnavailableError`; `resolvedHomeSections` never returns `DEFAULT_HOME_SECTIONS`; no getter returns defaults | **Pass** | "a v4 release is live with v 4 …": all 18 getters are called and each must throw (17 with `ContentUnavailableError`; `resolvedContentPageList` throws too). Fails without the change (break 7) |
| 3 | v0, v5, v99, `'3'`, a missing v and non-object content each give `error` | **Pass** | "v0, v5, v99, '3' …": 14 cases, also 3.0001, `true`, `null`, an array, a string, a number, not JSON. Each must also make `contentSource` fail closed. Fails without the change (break 2) |
| 4 | Request-cache stub: one SQL statement for pointer plus release per request with 8 getters in parallel; pointer with no row still `error`; no `release_state` table still `none` | **Pass** | "request-cache stub …": exactly 1 release statement per request, and it is the join. A second request reads once again. Outside `runRequest` the same 8 getters read 8 times, which shows the stub is what makes the count. The pointer-with-no-row and no-tables cases run inside `runRequest`. Fails without the change (break 1: 2 statements) |
| 5 | `listReleases` omits unstamped, unscheduled rows, still lists the live row with `published_at` null, plus past and scheduled rows | **Pass** | "listReleases hides …": lists exactly live, scheduled, past, in that order. With no pointer, both unstamped rows are hidden. Fails without the change (breaks 5 and 6) |
| 6 | Rendered: on `ContentUnavailableError` the chrome holds no nav links, no collections scroller, no announcement, no tenant brand; the maintenance page uses neutral brand; other chrome failures behave as before | **Pass** | Four rendered tests (the real layout, Header and Footer compiled with Next's SWC): a v3 control, v4 and an unreadable release (no catalog or content links, no scroller, no announcement, no brand CSS, kit `pulse-1`, no store name), a non-content bug in a chrome getter (scroller still shows, as before), and the maintenance page on v4 ("Store will be right back.", no brand, kit `pulse-1`). Fails without the change (breaks 8 and 9). Also seen in a browser (below) |

PUB-01 and PERF-01 are only partly delivered here, as the plan intends:
- PUB-01: "an unknown future version number gives the error page" is proved. The v4 branch only fails closed. Reading v4 correctly is P2-READ.
- PERF-01: the pointer and release are one statement per request. The version reads and the post-count tests are P2-READ and P2-PERF.

### Do the tests bite?

Each break was applied to the finished code alone, then `test:releases` was run:

| # | Break | Result |
|---|---|---|
| 1 | Pointer and release read in two statements again | Caught (request-cache test: 2 statements) |
| 2 | No version check in `getLiveReleaseState` | Caught (bad-versions test) |
| 3 | The old envelope check (`!content.v`) instead of the new one | Not caught. It is the same for every content JSON can hold: `!content.v` already refuses 0, and an array stored as JSON has no `v`. The version check after it does the work |
| 4 | No `release.v` | Caught (5 tests) |
| 5 | `listReleases` with no filter | Caught |
| 6 | `listReleases` without the live-row exception | Caught |
| 7 | No v4 gate in `contentSource` | Caught (3 tests) |
| 8 | Chrome nav `null` on `ContentUnavailableError` | Caught (the rendered v4 chrome test) |
| 9 | Maintenance page with brand and theme not awaited | Caught: the unhandled `ContentUnavailableError` stops the suite, exit 1 |

## Browser evidence (`docs/cms-reviews/drills/P2-VGATE/`)

On the design harness (`DESIGN_PORT=3420 DESIGN_SQLD_PORT=4420`), with this branch's code. A helper in my scratch folder put a v4 row live on the harness tenant, then put the old pointer back and deleted the row.

| Page | Live release | What showed |
|---|---|---|
| `/` | v3 (seeded) | Announcement "Festive sale …", "Design Demo Co", the scroller (Bestsellers, Night routine, Serums), the hero (`home-v3-restored-1440.jpg`, taken after restoring) |
| `/` | v4 | "Something went wrong". Header "Store", "Shop all". Footer "Store / All collections / Contact / © Store". Links on the page: `/`, `/collections`, `/wishlist`, `/account`, `/contact` only. No announcement, no brand CSS, kit `pulse-1` (`home-v4-1440.jpg`) |
| `/products/glow-serum` | v4 | The same error page and neutral chrome |
| `/` | v3 again | Back to the seeded store |

## Known limits

- **DR-1.** The gate protects rollbacks only back to this deploy. A rollback to `a6d028e` or earlier while any v4 pointer exists renders the empty default site with no error.
- **DR-2.** Before this deploys, the fleet's live `v` values must be 1, 2 or 3. Any other value is an error page after this deploy (it was served as a snapshot before).
- **The tab title still names the store and product** on a v4 release. `generateMetadata` reads the store's config and the catalog, not the release, and this item doesn't change it. Seen in the drill: "Radiance Glow Serum 30ml · Design Demo Co". The page source also still holds catalog text in the metadata (the harness's finding 5, already recorded).
- **The maintenance page now shows the store's real brand and theme** on a store whose release reads fine. Before, it always used the platform default look, because it got promises, not values. This is what the page was meant to do (S43, "the branded closed page"), but shoppers on a closed store will see a change. Fix round 1: because the curtain now gets the store's real kit, a glow store's curtain has the light hero (#fff1ee). Its "Scheduled maintenance" pill used the raw `accent-400`, and the brand CSS was built without `{ kit }`: lime #a3e635 on #fff1ee with no brand (about 1.37:1), #9e6df2 with the test brand (about 3.22:1). Now the curtain builds its brand CSS with `{ kit }`, also when there is no brand (as `chromeData` does), and the pill and its dot use `text-sf-hero-accent` / `bg-sf-hero-accent`, the role the storefront hero uses. On a glow store with no brand that is #3f6212. On pulse-1 (dark hero) `--sf-hero-accent` defaults to `accent-400`, so the dark curtain looks as before.
- **The fixed chrome links stay** on the error page: the wordmark, "Shop all" / "All collections" (`/collections`), Contact, wishlist, account and cart. They are part of the layout, not the store's nav.
- **The maintenance branch may conflict** with the unmerged `claude/musing-williamson-4c86b3` branch (the closed-store title work), which touches the same part of the layout. Merge with care.
- `getLiveRelease()` (console pages, `releaseDiff`, `brandReadability`) still returns a v4 row as if it were a snapshot. No v4 row can exist until P2-ATOM's writer, and P2-READ and P2-PUBLISH own those readers.
- Unit counts only. Real Next per-request counts come from P2-PERF's `perf-dbcount` runs.

### From review

Non-blocking findings from the independent review, added at merge.

- The earlier blocker is fixed, and I checked it. At c10506a the closed-store page (app/(storefront)/layout.js:228-240) works out the kit once, builds the brand CSS with { kit } even when the store has no brand, and the pill and its dot use text-sf-hero-accent / bg-sf-hero-accent. I computed contrast on the glow-1 hero (#fff1ee) for no brand (#3f6212, 6.43:1) and for accents #7c3aed (5.17), #facc15 (6.35), #0ea5e9 (5.12), #111111 (7.21) and #ffffff (5.21). Every one is 4.5:1 or better. On pulse-1, --sf-hero-accent falls back to accent-400 (globals.css:89), so the dark closed page looks the same as before.
- The new test catches the bug. I made six deliberate breaks to the fix lines and test-releases caught every one: pill text put back to text-accent-400; dot put back to bg-accent-400; { kit } removed; the CSS skipped when there is no brand; the kit forced to glow-1; resolvedTheme no longer awaited. test:releases gives 35 passed, 0 failed. pnpm test, after a frozen offline install in a fresh worktree, gives 57 of 57 suites passed in 106.2 s.
- The packet's browser evidence was not redone for fix round 1. The glow closed page was checked only by the rendered SWC test, not in a browser on the harness. The owner check added in the packet (look at a glow store's closed page) covers this.
- The packet still says 'Nine deliberate breaks, eight caught'. That count does not include the fix-round break described under Tests (the pill text put back to text-accent-400 makes the new test fail). This is a small bookkeeping gap, not a false claim.
- Edge runtime: none of the changes in lib/, app/ or components/ since 4992670 use node: APIs. node: imports appear only in scripts/ tests and support files.

## Tests

`scripts/test-releases.js` (P2-VGATE block, 10 tests). Fix round 1 added "rendered: a glow store's maintenance pill is readable on the light hero, with and without a brand": it renders the real layout for a closed glow store with the test brand and with no brand, checks kit `glow-1`, that the pill and dot use the hero accent role, that `--sf-hero-accent` is in the curtain's CSS and reaches 4.5:1 on the glow hero, and that no brand gives #3f6212. It failed before the fix (pill text was `text-accent-400`). It now imports `scripts/support/request-cache.js` first and stubs `next/headers` per simulated request. One existing test changed: "expectedDraftHash binds the publish …" counted rows through `listReleases`. That now hides unstamped rows, which would have made the check weaker, so it counts the `releases` table directly.

## Owner checks

- **DR-1:** never roll back past the P2-VGATE deploy while any v4 pointer exists.
- **DR-2:** before P2-VGATE deploys, run on every tenant: `SELECT DISTINCT json_extract(r.content,'$.v') FROM release_state s JOIN releases r ON r.id=s.live_release_id`. Confirm the only values are 1, 2 or 3.
- Look at the maintenance page of a closed test store after deploy: it now shows the store's brand and theme (see Known limits). On a glow-kit store, check the "Scheduled maintenance" label is easy to read on the light background.
- On staging, check the console's release list still shows the live release and scheduled releases (`listReleases` filter).

## Files

- `lib/releases.js`, `lib/content/resolve.js`, `app/(storefront)/layout.js`
- `scripts/support/request-cache.js` (new, shared), `scripts/support/legacy-release-outputs.js` (new), `scripts/fixtures/legacy-release-outputs.a6d028e.json` (new)
- `scripts/test-releases.js`
- `docs/cms-reviews/P2-VGATE.md`, `docs/cms-reviews/drills/P2-VGATE/*.jpg`

## Commands

```
pnpm test:releases
pnpm test
pnpm build
node scripts/support/legacy-release-outputs.js out.json   # re-record (inside any checkout)
```
