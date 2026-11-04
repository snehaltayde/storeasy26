# P3-FIX5: batch 5 review findings (design preview label, rte drill, theme pin hardening, refusal words, backup wording, P2 flip guard)

Requirements: TOK-03, PV-01, AU-01, ED-03. Branch `cms/p3-fix5`, cut from `cms/phase-1` at `552e6f3`. No migration. No new dependency. Nothing under `.github/` or `package.json` changed. No tenant changes mode. Legacy tenants, today's releases, the legacy editors and the legacy preview behave as before.

This is the author's own report. Reviewers should re-read the code and the results files.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 134.4 s, and again on the committed code in 170.4 s (`PORT=6100 DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 SHOPIFY_OAUTH_PORT=7107 TEST_PUBLISH_PORTS=7103,7104 TEST_PUBLISH_SERVICE_PORTS=7105,7106 TEST_PUBLISH_UNDO_PORTS=7108`). `pnpm build` passed; its 3 warnings are the old `lib/platform/migrate.js` NFT trace (`next.config.mjs`), none from this item's files. 21 mutations, each caught (see "Mutations") |
| Browser verified | Yes. Desktop Chrome (headless, `playwright-core`) on the design harness from this worktree (`DESIGN_PORT=6100`, `DESIGN_SQLD_PORT=7100`, `DRILL_HTTPS_PORT=7106`, `next dev`). Every stage of `node scripts/drills/p3/run.mjs` passed (two stages needed a second run; see "Runs"). Not Safari, not a phone, not a production build |
| Staging verified | **NOT DONE.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

### 1. Finding D1: the design preview said "Up to date" with the old colours (blocker)

The browser has one `_preview` cookie, so the frame renders whichever session was confirmed last. The editor turned the design's colours on in its own session. With a second editor tab, or React strict mode's double effect in `next dev` (one tab, two sessions), the frame used another session with the colours off, and the label still said "Up to date". Fixed at the root, in three places:

- **The controller steers the session the frame renders** (`components/admin/editor/editorModel.js`). Every ready ok carries `state.sid`, the session the layout read from the cookie. The controller adopts it, so `setShowDesign` goes to the frame's session (and so does turning it off on another document).
- **Never "Up to date" while the frame says its new colours are hidden** (`components/admin/editor/previewMachine.js`). While the design is open, a ready whose state lists `doc_design` in `skipped` (the layout's own "not shown" fact) answers `fixDesign`: the controller turns showDesign on in the frame's session and reloads the frame; the label stays "Updating". If the turn-on is refused, it mints a new session of its own with the colours on. After 2 tries in a row it says "Could not update" with "The preview isn't showing your new colours. Try again." (`PREVIEW_WORDS.designHidden`).
- **One editor mount mints one session** (`PreviewPane.js`, `editorModel.js`). PreviewPane keeps its controller in a ref across strict mode's effect, cleanup, effect; `start()` mints once per controller. A dispose parks what arrives meanwhile, and the re-run applies it; a real unmount never starts again, so nothing is applied.
- **The server side too** (`lib/admin/preview-session-api.js`, `app/api/admin/preview-session/route.js`). `showDesign: { sid, on: true }` also turns the colours on in the session the request's `_preview` cookie names, when that token is this store's, not expired, the session is live and it is the same person's (`setShowDesign` with the actor). The answer then carries `frameSid`. `on: false` changes only the named session, so one tab never turns another tab's design preview off.

### 2. rte drill step 7 (blocker)

`scripts/drills/p3/rte.mjs` step 7 now expects P3-FIX4's behaviour: the `<product-info …>` paste saves cleaned (visible text kept, `product-info`, `class=` and `data-section` gone), the field shows the stored text, and there is no refusal and no Edit as HTML offer. A new step 7b keeps a real loss refused: a paste holding `<shop class="x">` (a name with no hyphen) is refused with WORDS_LOST naming the `<shop>` tag and Edit as HTML, nothing is stored, the field offers Edit as HTML, the tag is removed there, and the save goes through cleaned.

### 3. Sanitizer pin and refusal words

- `<p>Hi</p><noscript class="x">Founder note` is in `STILL_REFUSED` (`scripts/test-rich-text.js`). It is refused today; the FIX4 reviewer's surviving mutation (drop the content when nothing closes the tag) is now caught. Its lost words are "Founder note", which hold no tag, so the words say "< or > signs" (see Known limits).
- **The refusal words name a tag only when it reads as markup** (`lib/sanitize.js` `markupTagIn`, used by `lib/registry/text.js` and `lib/cms/store.js`). A tag is named when every attribute is a real one and the name is a known element, a web page's own element (a hyphen) or a Word tag, or it carries at least one attribute with a value. So `<b and c>`, `Size <XL or bigger>`, `Ask for the <founder> today.` and `<sale-ends soon>` keep the "< or > signs" words; `<shop class="x">`, `<link>`, `<product-info>` and `<noscript class="x">` are named. Both copies (documents and legacy) follow the same rule.
- The one judgement call: the brief's rule reads "a real known or custom element with real attributes". Read literally, `<shop class="x">` (no hyphen) would lose its name, though it is plainly pasted markup the founder can't see, and P3-FIX4's owner check names it. So an unknown name with a valued attribute is named too. This is an owner ruling (see Owner checks).

### 4. writeThemePin (`lib/documents/after-commit.js`)

- **A corrupt config is never replaced.** The UPDATE has `AND json_valid(config)`; when nothing changed, one read says why, and a config that isn't valid JSON throws "config is not valid JSON, so theme_pin was not written". The row is left as it was.
- **No row changed is a failure.** A missing tenant throws, so `runAfterCommit` logs `documents_after_commit_failed`, never `theme_pin_written`.
- **The cache refresh is pinned.** The test warms a 60 s tenant cache and reads it after the write; without `getTenant(id, { fresh: true })` it shows the old pin.
- **A late write never replaces a newer pin.** Each write stamps `config.theme_pin_at` with its build's `now` (the publish time). The UPDATE only writes when the stamp already there (or, for a pin written before this item, its `published_at`) is not newer. A late write answers `"newer"`, logs `theme_pin_skipped_newer` and changes nothing, null pins included. The same build again (a retry) still writes.
- **The theme route's DESIGN_ID check is pinned** (`app/api/admin/theme/route.js` itself is unchanged): a test makes the kit apply fail just after the hero's `doc_home` save; the partial answer must name `doc_design` and its revision. Without the check it names `doc_home`.

### 5. The local backup's wording

A version kept from "We found edits that weren't saved" now reads **"Edits this browser kept"**, not "Kept from another tab". The flag has to come from the client, which alone knows the keep is the backup, so:
- `components/admin/editor/store.js` `acceptBackup` sends `keepAsEarlierDraft: { id, body, from: "backup" }`; the conflict and set-Undo keeps send no `from`;
- `lib/admin/documents-api.js` accepts `from: "backup"` only (anything else is 400 MALFORMED);
- `lib/documents/changes.js` passes it to `lib/documents/service.js` `keepEarlierDraft`, which notes the version `BACKUP_NOTE`;
- `lib/documents/versions.js` defines `BACKUP_NOTE`, and both notes count toward the cap of 10 (`keptCount` and the guarded INSERT).
- Shape: `keepAsEarlierDraft.request` carries `from` as an optional key (`requestOptional`).

`matrix.mjs`'s keepalive part now checks that the newest `undo_saved` version holds the text that never reached the server, that its note (stored, listed and in the Earlier versions panel) is "Edits this browser kept", and that the panel does not say "Kept from another tab".

### 6. The P2 flip guard (`scripts/drills/p2/run.mjs`)

`EXPECTED_FLIPS` lists, per part, what the flips must produce: the finding 1 check (preview), the `--drafts-only` note check and the reworded bar check with its screenshot (preview), the finding 2 retirement and its replacement check (unfinished), and both finding 3 note checks (error-chrome). After a part that ran to the end, `missingFlips` adds a failing check "flip guard: … ran in <part>" for each one missing, and for a reworded check whose screenshot never came. A renamed label, note or screenshot now fails the part instead of disappearing.

## Files

Plan list: `app/api/admin/preview-session/route.js` (comment), `lib/admin/preview-session-api.js`, `components/admin/editor/editorModel.js`, `components/admin/editor/PreviewPane.js`, `components/admin/editor/previewMachine.js`, `scripts/test-logout-preview.js`, `scripts/test-editor-shell.js`, `scripts/drills/p3/matrix.mjs`, `scripts/drills/p3/rte.mjs`, `scripts/drills/p2/run.mjs`, `lib/sanitize.js`, `lib/registry/text.js`, `lib/cms/store.js`, `scripts/test-rich-text.js`, `lib/documents/after-commit.js`, `scripts/test-design-doc.js`, `lib/documents/changes.js`, `lib/documents/service.js`, `scripts/test-doc-changes.js`, `lib/admin/documents-api-shapes.js`, this packet, and `docs/cms-reviews/drills/P3-FIX5/` (this item's results).

**Outside the plan list** (item 5 can't be done without them; this item is alone in its batch, so no other owner): `components/admin/editor/store.js` (one line: the backup keep sends `from: "backup"`), `lib/admin/documents-api.js` (the parser accepts it), `lib/documents/versions.js` (`BACKUP_NOTE`, and the cap counts both notes). Reviewers should check these three.

Unchanged though listed: `lib/preview-sessions.js` (`setShowDesign` with the actor already does what the cookie path needs), `app/api/admin/theme/route.js` (already right; pinned), `scripts/test-api-shapes.js` (it already checks `requestOptional` paths and parses every request example, the new `from` included), `scripts/drills/p3/lib.mjs`.

Edge runtime: the only storefront-path files changed are `lib/sanitize.js` and `lib/registry/text.js` (pure, no imports added). `preview-session-api.js` now imports `lib/cms/candidates.js` (for the cookie name); it runs only on the nodejs console route.

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | drill: the design checks in matrix.mjs pass in one tab and two tabs with no 'known D1' escape; the preview never says Up to date while showing old colours | **DONE** | `drills/P3-FIX5/results-design.json` (6 passed, 0 failed, 0 known; the `raced`/`known` escape is gone). One tab: "the editor's preview shows the new accent" (label Up to date, frame `#dc2626`, one session, `show_design` 1) and "one editor tab holds one preview session (React strict mode's double effect mints once)" (1 session, log `mint:false minted …`). Two tabs: "the design tab's preview shows the new colours and never says Up to date while it shows the old ones": samples `Updating|#dc2626`, `Updating|#0d9488`, `Updating|#2563eb`, then `Up to date|#2563eb`, stable for 3 s; controller log `… ready:ok adopt fixDesign refresh frameLoad … ready:ok`. Before this item (at `552e6f3`) the two-tab check failed every run (P3-DRILLS finding D1) and the one-tab check failed about half the runs |
| 2 | unit: one editor mount mints one preview session; showDesign reaches the session the frame renders | **DONE** | `test-editor-shell.js`: "P3-FIX5 unit: one editor mount mints one preview session (start, dispose, start…)" and "P3-FIX5 unit: showDesign reaches the session the frame renders; the preview never says Up to date while the frame says the new colours are hidden". `test-logout-preview.js`: "P3-FIX5 (finding D1): showDesign on reaches the session the request's _preview cookie names…" (the real handler and storage; the storefront request with that cookie then sees showDesign on). Fail without the change: mutations 1, 2, 3, 5, 6, 7, 8 |
| 3 | drill: rte step 7 expects and gets the cleaned save; a real loss is still refused | **DONE** | `drills/P3-FIX5/results-rte.json`: 46 passed, 0 failed. "the web page's paste saves cleaned: the visible text kept, its own tags gone (P3-FIX4)", "the field then shows the stored text, with no refusal and no Edit as HTML offer", then 7b: "a real loss is still refused (WORDS_LOST), and the words name the <shop> tag and Edit as HTML", "nothing was stored", Edit as HTML, "after removing it, the save goes through and is stored cleaned". At `552e6f3` step 7 failed as P3-FIX4's packet says |
| 4 | unit: the unclosed noscript with an attribute is refused; '<b and c>' keeps the '< or > signs' words | **DONE** | `test-rich-text.js` "P3-FIX4 unit: real text loss is still refused…" (now holds `'<p>Hi</p><noscript class="x">Founder note'` and the signs list `<b and c>`, `Size <XL or bigger>`, `<founder>`, `<sale-ends soon>`, plus the legacy copy for the first two). Fail without the change: mutations 9, 10, 11 |
| 5 | unit: writeThemePin refuses a corrupt config, logs rowsAffected 0, refreshes the cache, and a late write never replaces a newer pin | **DONE** | `test-design-doc.js` "P3-FIX5 unit: writeThemePin refuses a corrupt config (writes nothing), a missing row is logged as a failure, the cache is refreshed, and a late write never replaces a newer pin", and "P3-FIX5 unit: the theme route's partial answer names the design's save…". Fail without the change: mutations 12 to 17 |
| 6 | unit: a local-backup version is not called 'Kept from another tab'; drill: the unsent text is in the stored version | **DONE** | Unit: `test-doc-changes.js` "P3-FIX5: a version kept from the local backup (from: 'backup') reads 'Edits this browser kept'…" (stored, listed, shared cap, `from: "tab"` refused); `test-editor-shell.js` "P3-FIX5 unit: 'Keep them as an earlier draft' from the local backup asks for the backup's note…". Fail without: mutations 18 to 22. Drill: `drills/P3-FIX5/results-keepalive.json` "backup: the stored version holds the text that never reached the server, and Earlier versions says 'Edits this browser kept', not 'Kept from another tab'" (`hasText: true`, note and listed note "Edits this browser kept") |
| 7 | drill: p2 run fails when an expected flipped label is missing | **DONE** | `drills/P3-FIX5/p2-flip-guard-proof.txt`: with publish.mjs's finding 3 note reworded in the worktree (not committed; restored at once), `node scripts/drills/p2/run.mjs error-chrome` exited 1 with "flip guard: \"/policies/shipping with only doc_header's version missing gives the error page …\" ran in error-chrome" and the same for "/", 13 passed, 2 failed. Unchanged, the same part passes 15 of 15 (`results-run-legacy-p2-rerun.json`) |
| 8 | unit: pnpm test passes; drill: node scripts/drills/p3/run.mjs passes all stages | **DONE** (two stages on a second run) | `pnpm test` 81 of 81 in 134.4 s. Drills: see "Runs" |

### Mutations

Each applied alone with `mutate.py` in the scratch folder (not committed), each run against its suite. All 21 caught:

1. `start()` mints again on a second start (strict mode) — editor-shell
2. PreviewPane makes a new controller on every effect run — editor-shell
3. the machine ignores a ready that says the design is hidden — editor-shell
5. no adopt of the frame's session — editor-shell
6. server: showDesign ignores the cookie's session — logout-preview
7. server: off also reaches the cookie's session — logout-preview
8. server: the cookie's session changed without the actor check — logout-preview
9. an unclosed noscript's content dropped (FIX4 survivor) — rich-text
10. any tag-like name named in the words — rich-text
11. an unknown name with no valued attribute named — rich-text
12. a corrupt config replaced (FIX4's CASE back) — design-doc
13. rowsAffected 0 not a failure (FIX4 survivor) — design-doc
14. no cache refresh (FIX4 survivor) — design-doc
15. a late write replaces a newer pin — design-doc
16. a late build logged as written — design-doc
17. watchDesignSave without the DESIGN_ID check (FIX4 survivor) — design-doc
18. the backup keep noted "Kept from another tab" (service) — doc-changes
19. the parser drops `from` — doc-changes
20. changes.js drops `from` — doc-changes
21. the store's backup keep sends no `from` — editor-shell
22. backup keeps don't count toward the cap — doc-changes

(Number 4, "fixDesign targets our own session", was dropped: after the adopt the two are the same session, so `fixDesign` now simply uses the adopted one.)

## Runs

1. Full `node scripts/drills/p3/run.mjs` (`results-run-full.json`, on the uncommitted tree): items smoke 26, routes 31, editor 22, design 26, rte 46, all 0 failed. Matrix: task1 3, task4 7, task5 8, closed 10, publish-both 3, offline 4, keep-live 3, conflict 5, keepalive 5, session 4, design 6, error-chrome 4, all 0 failed, 0 known; pv01 stopped with "The harness didn't come up at http://localhost:6100 within 3 minutes." Legacy: drill:edge failed one check, "git diff HEAD -- app is empty", because this item's `app/` change was not committed yet. P2: every part passed except error-chrome, stopped by the same harness start timeout.
2. After the commit: `matrix.mjs pv01` 6 passed, 0 failed (`results-pv01-rerun.json`); `run.mjs legacy,p2`: p2 sections 453, hero-image 32, policy-typo 8, error-chrome 15, edge 25, preview 22, unfinished 9, redirect 115, space 3, legacy 4, all 0 failed, 0 known; the legacy stage stopped once more at the harness start (`results-run-legacy-p2-rerun.json`).
3. `run.mjs legacy` alone: 4 passed, 0 failed (drill:smoke 31 passed, 0 failed; drill:edge 151 passed, 0 failed, the same 4 old known checks, P1-HARNESS finding 5).

The harness start timeouts are the machine (the P3-DRILLS review saw the same once); each stage passed on its next run. The test order `DES-48ADAF6B` (`snehal@mediastic.in`, cash on delivery, local harness) was cancelled at once (`results-run-full.json`, closed part); card details were never entered.

The drills rewrite other items' folders (`P1-HARNESS`, `smoke`, `P2-DRILLS`, `P3-*`, `scripts/drills/p2/results-*.json`); those were restored after the runs. This item's results are in `docs/cms-reviews/drills/P3-FIX5/` (JSON only; the screenshots they name were not kept).

## Tests

| Suite | Time (in `pnpm test`) | New or changed |
|---|---|---|
| `test:editor-shell` | 0.4 s | 3 new tests (strict-mode mint, showDesign to the frame's session, backup `from`) |
| `test:logout-preview` | about 1 s | 1 new test (the cookie's session, real handler) |
| `test:rich-text` | 0.6 s | the still-refused list gains the noscript case and a words-only entry; the signs list gains 4 cases and the legacy copy |
| `test:design-doc` | 1.1 s | 2 new tests |
| `test:doc-changes` | about 0.5 s | 1 new test |
| `test:api-shapes` | 0.4 s | unchanged; checks the new optional `from` |

## Known limits

- **Two editor tabs share one preview.** The fix makes the design tab's frame right. The other tab's session is the same one, so after the design tab turns the colours on, the other tab's frame shows the draft colours too on its next reload. That tab does not turn them off (only the named session is turned off), so the two tabs never fight. A per-tab preview is PV-03's per-tab overlay (phase 4).
- **"Up to date" is judged on the frame's last ready.** Between a save and its acknowledgement the label is about the previous save, as before.
- **A pin's order is the build's wall-clock time** (`build.now`). Two instances whose clocks differ by more than the time between two design publishes could order them wrongly. Hosted serverless clocks are synced; the operator screens only lag, never the store.
- **`config.theme_pin_at` is a new key** in the control-plane config, written beside `theme_pin`. Nothing reads it but `writeThemePin`.
- **The unclosed `<noscript class="x">` refusal says "< or > signs"**: its lost words are the text after it, which hold no tag. It is refused, which is what matters; the words could be better.
- **A concurrent whole-row `patchTenant` can still put an old pin back** (P3-FIX4 known limit, unchanged).
- **`next dev` only**, headless desktop Chrome, macOS.
- **Staging: NOT DONE.**

## Owner checks

- **Ruling: which tags the refusal words name.** As built: a known, web page or Word element, or any name with a valued attribute, and only with real attributes. `<founder>` and `<sale-ends soon>` now get the "< or > signs" words (P3-FIX4 named them).
- **Ruling: the backup note's words**, "Edits this browser kept".
- **Desktop Chrome, two editor tabs** on a staging test tenant: open Brand in tab A after tab B opened the home page, change the accent: A's preview shows it and says Up to date only then.
- **Hosted Turso, staging:** a design publish writes `theme_pin` and `theme_pin_at`; a tenant row with broken config JSON is left as it was and `documents_after_commit_failed` is logged.
- **Production build:** the editor mints one preview session per open (no strict mode double effect there).
- **CI:** the sqld download in CI still needs the owner's approval of its source and checksum. Nothing under `.github/` was touched.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
PORT=6100 DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 SHOPIFY_OAUTH_PORT=7107 TEST_PUBLISH_PORTS=7103,7104 TEST_PUBLISH_SERVICE_PORTS=7105,7106 TEST_PUBLISH_UNDO_PORTS=7108 pnpm test
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 DRILL_HTTPS_PORT=7106 DRILL_TMP=<scratch> DRILL_SCRATCH=<scratch> node scripts/drills/p3/run.mjs
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/matrix.mjs design,keepalive,pv01
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 DRILL_HTTPS_PORT=7106 node scripts/drills/p2/run.mjs error-chrome
pnpm build
```

No server, sqld or proxy was left running. Ports 6100 and 7100 to 7109 are free.
