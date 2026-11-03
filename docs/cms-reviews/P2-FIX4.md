# P2-FIX4: fixes from the batch 4 reviews (publish, writers, preview)

Branch `cms/p2-fix4`, cut from `f893710`. Plan: `docs/cms-reviews/P2-PLAN.md` (sections 0, 3, 4 and 6). Spec: PUB-03, DOC-05, PV-03 and PUB-01 (section 7), section 8.6 and 8.8. Builds on P2-PUBLISH, P2-WRITERS and P2-PREVIEW, and answers the "From review" lists in their packets. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 66 of 66 suites passed in 116.6 s. `test:publish-service` 34 passed (13 new), 1.5 s. `test:preview-overlay` 25 passed (5 new), 1.1 s. `test:writers` 21 passed (1 new), 0.7 s. `test:registry-contract` 22 passed (1 new), 0.5 s. `pnpm build` passed |
| Browser verified | **NOT DONE.** Every acceptance item is proven by a unit test that fails without the change (see the mutation table). No Chrome drill was run; see owner check OC-F1 |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No tenant changed mode |

## What and why

The batch 4 reviews found one security hole that was already there before phase 2, one overclaimed rule, one false message on a rare publish race, one false message on a theme race, and a list of correct-but-untested behaviour. This item fixes the first four and pins all of them with tests.

1. **Open redirect (security).** `/api/preview?to=/%5Cevil.com` sent any visitor to `https://evil.com/`, even with no token at all. The old check only refused values that start with `//`. The URL parser turns `/\evil.com`, `/\t/evil.com` and `/\n/evil.com` into `//evil.com`.
2. **Structure was downgraded at publish.** The inherited rule decided "always blocks" by a list of codes. The validator also reports `INVALID_VALUE`, `LINK_INVALID`, `TOO_DEEP` and `SECTIONS_NOT_ALLOWED` as structure, so a hidden section with a non-string `html`, or an unchanged section with `title: 42`, published with a warning and the raw object went into the published version.
3. **A publish that went live could be reported as "Someone else published…".** If a batch committed after `commitPublishBatch`'s read-back, the service rebuilt, saw its own earlier entry in the new list, and answered 409 `PUBLISHED_ELSEWHERE` while the content was live.
4. **Untested publish rules** R1, R2, R4, R5, R6, R11, R15, R16, R19, R20 and the `redirect_from` claim (DOC-10).
5. **Theme route false message.** `applyKit` saves the theme pin and brand, then the hero preset with a revision check. On a hero race the route said "nothing was saved", although the theme and brand were saved.
6. **Untested preview branches** in `contentSource`, and `inPreview` was only checked by a grep.

## Design

### 1. `app/api/preview/route.js`: `destination(to, origin)`

`safePath` is replaced by `destination(p, origin)`, which returns the URL to redirect to. It is used by both GET (token and exit) and the preview bar's POST. A value is kept only when all of these hold; otherwise the answer is `/` on the request's own origin:

- it is a string that starts with `/` and not with `//`;
- it holds no backslash and no control character (tab, newline, carriage return, any of U+0000 to U+001F, and U+007F);
- its path part (before `?` or `#`) holds no `%2F`, `%5C` or `%25` (an encoded slash, backslash, or percent sign, which covers double encoding), in either case;
- `new URL(p, origin)` parses, and its origin equals the request origin.

The query and fragment are kept (`/products/x?y=1#z`, `/search?q=a%2Fb`). The function is not exported, because a Next route file should export only handlers. The tests go through the real `GET` and `POST`.

### 2. `lib/registry/validate.js`: each issue's class; `lib/documents/publish.js`: never downgrade structure

- The validator already knew each issue's class (`structure`, `invalid`, `incomplete`, `warning`). It now attaches the class to every issue it makes as a **non-enumerable** property `cls`, and exports `issueClass(issue)` (null for an issue made elsewhere) and `STRUCTURE`. The DOC-04 shape does not change: `Object.keys(issue)` and the JSON sent to the editor are the same as before. That is why the class is non-enumerable rather than a new key: `test-registry-contract`, `test-failure-matrix` and `test-page-editor` pin the exact key list.
- `classify()` in publish now asks `alwaysBlocks(i)`, which is true when `issueClass(i) === "structure"` or the code is in `STRUCTURE_CODES`. The code list stays as a second guard for issues made outside the validator. The sanitizer refusals (`WORDS_LOST` and the others) are reported with class `structure`, so they block too. A structure issue now blocks whether the section is hidden or unchanged from live. The minimal inherited rule still downgrades other problems (an incomplete banner that was already live still only warns; tested).
- `classify` reads the class before it copies an issue with spread (a spread copy drops a non-enumerable property).

### 3. `lib/documents/publish.js`: a late commit is our own success

The publish loop keeps `sent`, a map from every published version id this call has built (on every attempt) to its build. On `{lost}`, before any conflict check, `ownBuildIn(next.list)` looks at each document's entry in the new list M'. If an entry's version id belongs to one of this call's builds, that batch committed. A batch writes all its entries together, so one entry proves the whole build. The service then answers success with that build's release, versions and warnings, and logs `documents_publish` with `reconciled: true, lateCommit: true`. The API then audits it as it does any success. Ids are still minted fresh for every build, so a version id can only match this call's own batch.

The `{ok}` path and this path share one `done()` helper, so the answer has the same shape either way.

### 4. Publish rules that were untested

No code changed for these. Each one already behaved as the packet claimed, and now each has a test. `publish_log.from_version_id` was already filled (R15), so it did not need fixing.

### 5. `lib/themes/kits.js` and `app/api/admin/theme/route.js`: the hero race

`applyKit` catches `ContentWriteConflictError` from the hero preset write and returns success: `{ theme, brand, presets: [], note }`, where `note` is `HERO_RACE_NOTE`, "Your theme and brand were applied. The hero wasn't changed, because someone else edited it just now." It logs `theme_hero_conflict` and records `heroSkipped: "conflict"` in the audit diff. Any other error is still thrown as before. The route answers 200 with `note` at the top level, as well as inside `applied`. The colleague's hero is kept.

### 6. Preview tests

There is no code change in `lib/content/resolve.js` or `lib/tenant-request.js`. Five tests pin today's behaviour (next section). One of them pins a behaviour that changed silently in P2-PREVIEW and is recorded here on purpose:

> **When `getCmsMode` throws, a valid preview token gets live content, not drafts.** Before P2-PREVIEW, a legacy store's founder got the draft preview however the mode read went. Now an unreadable `cms_state` gives no preview at all: live content, or the error page when the live path itself needs the mode. This is founder-only and fails safe (it never shows drafts on a guess), but it is a change, and the test pins it.

## Acceptance, with evidence

"Mutation" means the change was applied alone, the named suite was run, and the file was restored. The runner is `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p2-b5/P2-FIX4/mutate.py`, on ports 4642 and 4643. All 21 mutations were caught.

| Item | Status | Evidence |
|---|---|---|
| Every hostile redirect input lands on `/` (same origin); good paths are kept; fails before the fix for `/\evil.com` and `/%5Cevil.com` | **Proven** | `test-preview-overlay` "FIX4 open redirect". There are 17 hostile values (`/\evil.com`, `/%5Cevil.com`, `/%5cevil.com`, `//evil.com`, `/%2F%2Fevil.com`, `/%2f/evil.com`, `/%252F%252Fevil.com`, `/\t/evil.com`, `/\n/evil.com`, `/\r\n/evil.com`, `/\/evil.com`, `\\evil.com`, `https://evil.com`, `https:evil.com`, `javascript:alert(1)`, ` //evil.com`, and the empty string). Each is tried four ways: no token, a bad token, a valid token, and exit. Six raw links are also tried, including the review's `?to=/%5Cevil.com` and `?token=bad&to=/%5Cevil.com`, plus the bar's POST, both through its form field and through another site's Referer. Good paths are kept with and without a valid token. **Before the fix** (route.js at HEAD), 45 cases missed: `/\evil.com`, `/\t/evil.com`, `/\n/evil.com`, `/\r\n/evil.com` and `/\/evil.com` went to `https://evil.com/`, and so did the links `?to=/%5Cevil.com`, `?to=/%5cevil.com`, `?to=/%09/evil.com`, `?to=/%0A/evil.com` and `?token=bad&to=/%5Cevil.com`. The literal values `/%5Cevil.com`, `/%2F%2Fevil.com` and the others stayed on the store but were kept rather than sent to `/` |
| A hidden section with non-string html, and an unchanged section with title 42, are refused at publish; nothing goes live | **Proven** | `test-publish-service` "FIX4 structure: a HIDDEN section…" (422, `INVALID_VALUE` on `html` and `title` as errors, storage unchanged, no published version holds the raw object) and "FIX4 structure: an enabled section UNCHANGED from live with title 42…" (422, the live entry unchanged; an inherited incomplete banner still only warns). Mutation "PRE-classify" (decide by code only): both fail. Mutation "class not exposed" (no `cls`): both fail, and so does the registry test |
| A `{lost}` that actually committed is reported as success, never "someone else published" | **Proven** | "FIX4 late commit". The commit hook commits for real, then returns `{lost}` with the old pointer. The answer is 200 with the first build's release and version, the live pointer is that release, there is one log row and one published version, the second batch was refused by the guard, and the release is audited. Mutation "PRE-late": 409 `PUBLISHED_ELSEWHERE`, so the test fails |
| R1, R2, R4, R5, R6/R19, R11, R15, R16, R20 and redirect_from each have a named test that fails under the matching mutation | **Proven** | "FIX4 R1" (mutation: index read once) · "FIX4 R2 and R4" (mutations: old entry kept; `enabled: true` always) · "FIX4 R5" (archived check removed) · "FIX4 R6" (journal entries ignored) · "FIX4 R19" (slug check on attempt 1 only) · "FIX4 R11" (the publish audit line in `lib/admin/documents-api.js` removed; the late-commit test also fails) · "FIX4 R15" (`from_version_id: null`) · "FIX4 R16" (window dropped from the page row) · "FIX4 R20" (a deleted document skipped) · "FIX4 DOC-10" (`redirectsOf` returns `[]`, the review's R3). Each mutation fails its own test |
| A theme apply that loses the hero race answers success with the plain note; theme and brand applied, hero untouched | **Proven** | `test-writers` "P2-FIX4: a kit apply that loses the hero race…". It runs through the real route on a legacy store, with a colleague's hero save landing between the kit's read and its write: 200, `note` with the exact words, `presets: []`, no "nothing was saved", the theme pin `glow` and the glow brand stored, and the colleague's hero kept. The library call answers the same. Mutation "PRE-theme" (the conflict rethrown): fails |
| The four preview branches are pinned by behaviour tests | **Proven** | `test-preview-overlay`: "FIX4: a 'migrating' store…" (mutation: legacy only, fails) · "FIX4: when the store's mode can't be read…" (mutation: unreadable mode treated as legacy, fails) · "FIX4: a documents store whose live release is a legacy (v3) one…" (mutation: the `return null` removed, fails) · "FIX4: inPreview… counts both token formats". The inPreview test raises the cache to 10 minutes, changes the store's row behind the cache, and checks that a session token and an old-format token read the row fresh while no cookie, a bad token and a tampered token don't. The review's own mutation (`token.split(".").length === 3`) fails it. It replaces the grep |
| `pnpm test` passes | **Proven** | 66 of 66 suites passed in 116.6 s |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish-service` | 34 passed (13 new: 2 structure, late commit, R1, R2/R4, R5, R6, R19, R11, R15, R16, R20, DOC-10) | 1.5 s |
| `pnpm test:preview-overlay` | 25 passed (5 new: open redirect, migrating, mode unreadable, legacy pointer, inPreview; the token-format test lost its grep) | 1.1 s |
| `pnpm test:writers` | 21 passed (1 new: hero race) | 0.7 s |
| `pnpm test:registry-contract` | 22 passed (1 new: issue class) | 0.5 s |
| `pnpm test` | 66 of 66 suites | 116.6 s |
| `pnpm build` | passed | |

`pnpm build` printed the "Using edge runtime on a page currently disables static generation" note and three NFT warnings. All three trace to `lib/platform/migrate.js`, imported by `app/api/platform/overview/route.js`; this item touches neither file. I did not run a build on the base to compare the warning count.

`test-preview-overlay` gains a seventh store, `pv` (a documents store with a v3 release live), and cleans up its database file like the others. The publish-service suite used sqld and proxy ports 4640 and 4641; the mutation runs used 4642 and 4643. Every sqld and proxy was stopped by the suite's `finally`.

## Known limits

- **A late commit on the last attempt still reads as busy.** If the third batch commits after its read-back and that read-back still shows the old pointer, the service answers 503 "Publishing is busy… nothing was published", though it went live. A later publish of the same page then sees its own entry and is skipped, so nothing is duplicated. This needs a server commit that lands after the client's read-back on the final attempt.
- **Recognition needs one of our entries in M'.** If someone else republished every document of our set between our late commit and the read, the answer is 409 `PUBLISHED_ELSEWHERE`. That is then true in effect, because their versions are live.
- **The console doesn't show the theme note yet.** `components/admin/ThemeAdmin.js` shows its own "applied as a draft" toast and ignores `note`. `components/*` belongs to other items this batch. The API answers the note, so the console needs a one-line change to show it (OC-F3).
- **Structure in a hidden section now blocks the whole document.** A migrated document whose hidden section holds a malformed value can't be published until that section is fixed or removed. This is what PUB-03 asks for ("structure and sanitizing always block"). It is still a change from P2-PUBLISH's behaviour, so the owner should confirm it (OC-F2).
- **`issueClass` lives on a non-enumerable property.** A copy made with `{...issue}` or through JSON loses it, so a caller must read it from the validator's own issue objects. Publish does.
- **Redirect paths with `%25` in the path part go to `/`.** Storefront paths are slugs, so none should have one. Queries may contain anything.
- **Wording:** the publish-request parse message ("…so nothing was saved…") for a malformed `publish` body is unchanged (P2-PUBLISH review note). It lives in `lib/admin/documents-api.js`, which is not in this item's files.
- The P2-PUBLISH packet's limit text ("the rebuild can then republish on top, leaving duplicates") was inaccurate, as the review said. This item makes that case a success instead. The old packet itself was not edited.

### From review

Non-blocking findings from the independent review, added at merge.

- Test gap, theme race (lib/themes/kits.js): the line `if (!(e instanceof ContentWriteConflictError)) throw e;` is not tested. With it removed (so every hero-write error is caught), test-writers still passes. The code is correct today. But if someone later widens that catch, a database failure during the hero write would answer 200 with 'someone else edited it just now', which is a false message. Add a test where writeContentDrafts throws a non-conflict error and the apply answers the infra error.
- Redirect hardening (app/api/preview/route.js destination): dot segments can still give a same-origin URL whose path starts with '//'. For example '/a/..//evil.com', '/..//evil.com' and '/%2e%2e/%2e%2e//evil.com' all resolve to https://<store>//evil.com. This is not an open redirect: the Location header is absolute and on the store's own origin, and Next 16.2.9 base-server answers a '//' path with normalizeRepeatedSlashes, which gives a relative '/evil.com'. Still, the brief says to refuse protocol-relative values. A one-line extra check (`u.pathname.startsWith('//')` means home) would close it without relying on the framework or host.
- The redirect fix has two layers: the backslash and control-character regex, and the resolved-origin check. Each one alone stops every hostile input in the table, so neither is pinned by itself. Removing just the origin check survives (mutation M5), and so does removing just the backslash/control regex (M6). Removing both is the pre-fix behaviour and is caught. This is acceptable as defence in depth. If both should stay, test each layer on its own (for example, call destination with a mocked origin).
- STRUCTURE_CODES in publish.js is now redundant for every issue the validator makes. Deciding by class only (dropping the code list) survives the publish-service suite (M11). The packet already says the list is a second guard for issues made outside the validator. No test covers such an issue.
- Gate method: in the review worktree, `pnpm test` / `pnpm run` tried to reinstall dependencies (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, because node_modules was a symlink). Nothing was removed. The gate was run instead by calling each test:* script with node directly, the same commands run-tests.js uses: 66 of 66 suites passed. The builder's claim that `pnpm test` passed was therefore checked suite by suite, not through the pnpm wrapper.
- Mutations confirmed caught by this review: resetting `sent` on each attempt breaks 'FIX4 late commit'. Checking hidden sections before structure breaks 'FIX4 structure: a HIDDEN section'. Dropping the %25 check breaks the redirect table. Dropping the route's `note` breaks the theme-race test. The source changes add no node: imports, so they are edge-safe. Legacy suites (themes, releases, content, preview-overlay legacy store PL) pass.
- Owner checks OC-F1 to OC-F6 in the packet stand. The CI sqld download still needs the owner's approval of its source and checksum. Nothing under .github/ changed.
- Merge note (batch 5 integration): merged after P2-PERF, where a journal post has no list.documents entry (PERF-01). The late-commit check in lib/documents/publish.js now finds this call's own build through the post's journal index row, or the journal index entry minted for that build. A new test, 'FIX4 late commit, journal post', covers it; using the list entry alone fails it.

## Owner checks

- **OC-F1 (security, desktop Chrome)** On the design harness with your own ports, open `http://<store host>:<port>/api/preview?to=/%5Cevil.com`, then `?to=/%09/evil.com`, then `?token=bad&to=/%5Cevil.com`. Each must land on the store's home page, never on evil.com. Then `?to=/collections` must land on /collections. Not run.
- **OC-F2** Confirm that structure problems in hidden or inherited sections block the document's publish (PUB-03 as written), including for migrated documents.
- **OC-F3** Confirm the hero-race words: "Your theme and brand were applied. The hero wasn't changed, because someone else edited it just now." Then have ThemeAdmin show `note` when the API sends one.
- **OC-F4** Confirm the pinned preview behaviour: when a store's mode can't be read, a founder's preview shows live content, not drafts.
- **OC-F5** CI's sqld download (source and checksum) still needs your approval. Nothing under `.github/` was changed; `test:publish-service` needs sqld.
- **OC-F6** Hosted Turso, on a staging documents test store: a publish whose response is dropped after commit answers success, with single rows.
- DR-1, DR-2 and DR-3 stand. No real store is in documents mode.

## Files

- `app/api/preview/route.js`, `lib/documents/publish.js`, `lib/registry/validate.js`, `lib/themes/kits.js`, `app/api/admin/theme/route.js`
- `scripts/test-publish-service.js`, `scripts/test-preview-overlay.js`, `scripts/test-writers.js`, `scripts/test-registry-contract.js`
- `docs/cms-reviews/P2-FIX4.md`

## Commands

```
pnpm test:publish-service
TEST_PUBLISH_SERVICE_PORTS=4640,4641 pnpm test:publish-service
pnpm test:preview-overlay
pnpm test:writers
pnpm test:registry-contract
pnpm test
pnpm build
python3 <scratch>/P2-FIX4/mutate.py        # the mutation table (restores every file)
```
