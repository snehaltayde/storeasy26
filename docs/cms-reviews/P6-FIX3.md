# P6 · FIX3 · Batch 3 review findings (GEN-01, PUB-12)

Branch `cms/p6-fix3`, cut from `cms/phase-1` at `60a37b8`. It fixes the "From review" lists of P6-ONBOARD and P6-FIX2 that the batch 4 brief gave to this item.

This is the author's own report. Reviewers should re-read the code.

## Files

All are in the item's list:
- `app/api/admin/first-run/route.js`: passes `homeWritten` through.
- `components/admin/first-run/FirstRun.js`: a "half" view with the half-finished words.
- `app/(console)/admin/(authed)/editor/page.js`: re-lists documents after a half-finished run.
- `lib/admin/onboarding.js`: words for a failed policy read.
- `lib/content/resolve.js`: `closedSource` fails closed.
- `scripts/test-brand-step.js`, `scripts/test-first-run.js`, `scripts/test-provision.js`, `scripts/test-release-readers.js`: the new tests.
- This packet.

`lib/first-run/generate.js` and `components/admin/SetupAdmin.js` needed no change. Their behaviour was already right; only tests were missing.

Not touched: `.github/`, `package.json`, migrations (none), `scripts/drills/**`, `scripts/seed-design-documents.js`, `docs/cms-reviews/MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No new dependency.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` (102 of 102) and `pnpm build`. See Tests |
| Browser verified | NOT DONE. The start page's half view is proved by a Node render (Next's SWC, the suite's hook driver and a fetch mock), not in desktop Chrome. A half-finished run needs a staged race between two writer calls, which the design harness can't set up from a browser. Owner check below |
| Staging | NOT DONE (owner check) |

## What, why and design

### 1. A half-finished first run on the start page and in the editor

**Why:** P6-FIX2 gave the generator honest words for a run that wrote the home page and then stopped before the colours (`FIRST_RUN_HALF_WORDS`, `homeWritten: true`). But the founder never saw them:
- The route dropped `homeWritten` and answered `generated: false`.
- The start page treated a race as a failed POST ("We couldn't make your starting store. Try again."). For legacy, live and migrating it re-read the page instead.
- The editor page re-listed documents only when `r.ran && r.written`. After a half-finished run it opened on the list read before the run, without the new home.

**Design:**
- **Route:** when `generateFirstStore` answers `ran: false` with `homeWritten: true`, the POST answers `200 { ok: true, ran: false, generated: true, homeWritten: true, reason, message }`. `generated` is true because something was stored, which is the field's documented meaning. A refusal that wrote nothing keeps today's shape: `generated: false` and no `homeWritten` key.
- **Start page:** `FirstRun.js` now has a phase called `half`, reached only by a POST answer with `homeWritten: true`.
  - It shows a warning banner with the half-finished words for the reason. `HALF_WORDS` matches `FIRST_RUN_HALF_WORDS` word for word; the generator is Node only, and test-first-run checks that the two match. An unknown reason gets "Your home page was made, but your colours were not. Try again."
  - It never shows "We couldn't make your starting store".
  - It shows "Try again" only where trying again here can help (race, migrating, catalog). For live and legacy there is no retry, because the words already say what is true.
  - It links "Edit the home page" and "Change colours and logo", except on legacy, where the new editor is not in use.
  - "Try again" posts once more. A race that wrote nothing keeps today's "make-failed" view.
- **Editor page:** `firstStoreThen` re-lists when `(r.ran && r.written) || r.homeWritten`, so the editor opens on the home page that was made.

### 2. A failed policy read on the checklist

**Why:** when `readPolicyRows` threw, `documentsPolicies()` returned null. The closed-store step then said "Your store can't open without a privacy page and a returns page. Start each from a template…" with no buttons, even when the pages existed. The open-store step said the open-missing words, also with no buttons.

**Design:** a new hint, `POLICY_HINTS.unreadable`: "We couldn't check your privacy and returns pages just now. Reload this page to try again." It shows on a closed store whenever the read failed, and on an open store whenever the read failed and the published rule isn't met. `actions` is `[]`, the step stays not done, and the label is unchanged. Legacy output is unchanged: legacy stores never read policy rows.

### 3. `closedSource` fails closed

**Why:** P6-FIX2's `closedSource(src)` returned false (open) for a missing source. `contentSource()` always returns an object today, so nothing reached this path, but a guess should never open a store.

**Design:** `closedSource(src)` is true when `src` is missing or not an object (`null`, `undefined`, `false`, `0`, `""`, a string), and otherwise uses the same rule as before. The function is still pure and safe in the edge runtime. The manifest route and `isStoreClosed()` use it unchanged.

### 4. Test gaps (no code change)

- **generate.js, the second try's eligibility refusal:** the home is written and the design loses its race on try 1. A new sync then starts, so try 2's checks find `catalog_not_confirmed`. The test expects `homeWritten: true` and `FIRST_RUN_HALF_WORDS.catalog_not_confirmed`.
- **generate.js, the home-skipped re-check:** the home is written and the design loses its race on try 1. After try 2's checks pass, the founder saves the home and the store goes back to legacy. The writer skips the home (no batch runs), and the re-check finds `legacy`. The test expects `homeWritten: true`, `FIRST_RUN_HALF_WORDS.legacy`, and the founder's home still standing.
- **onboarding (M12, M1, M7, M11):** an open documents store (`onbopen`, opened by a real publish of a home page). With no pages, the step keeps the label "Publish legal pages", shows the open-missing hint and both start buttons. With a starter privacy draft, it shows only the returns start button, with no read link and no "I've read it". With a founder-saved terms draft (not published), it shows the publish hint and no actions.
- **SetupAdmin (M2):** the stale "I've read it" 409 is now followed by `GET /api/admin/setup`, and the stale button is gone after the reload.
- **onboarding (M4):** a `brand_step` object without `at`, or a list, leaves "Start your store" (empty catalog) and the design step open. With `at`, both are done.
- **onboarding (M8):** with the `doc_home` read made to fail (only that statement, on that store's client), "Start your store" stays open with the to-do hint, although the home exists.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| rendered: a half-finished first run says the home was made and the colours were not; the editor re-lists after it | DONE (Node render, not Chrome) | test-brand-step "RENDERED (P6-FIX3): a half-finished first run …": the route's real half shape gives `data-first-run="half"`, the race words, no "We couldn't make your starting store", "Try again" and the edit link; Try again posts again and gives the ready view; each reason checked for its retry and link; the half state is in the banned-copy scan. With FirstRun.js at HEAD: 2 failed. test-first-run "FIX3 (route)": 200, `ran:false`, `generated:true`, `homeWritten:true`, reason race, the half words, and the home really written. With route.js at HEAD: 1 failed. test-first-run "FIX3 (editor page)": two design races, then `docsReads` 2 and the editor opens `doc_home`. With editor/page.js at HEAD: 1 failed. test-first-run "FIX3: the start page's own half-finished words …" checks that FirstRun.js has each generator sentence |
| unit: a failed policy read says the pages couldn't be checked; closedSource(null) is closed | DONE | test-provision "unit (P6-FIX3, M8 and the policy read)": `readPolicyRows`' statement made to fail on a closed store gives "Add your legal pages", not done, `POLICY_HINTS.unreadable`, `actions: []`, never "Start each from a template"; the same on the open store with "Publish legal pages"; the start buttons come back once the read works. With onboarding.js at HEAD: 1 failed. test-release-readers "P6-FIX3: closedSource fails closed": `null`, `undefined`, `false`, `0`, `""` and `"live"` are closed; the six real-source cases are unchanged. With resolve.js at HEAD: 1 failed |
| unit: the two half-finished generate paths and the open-store onboarding mutations (M12, M1, M7, M11, M2, M4, M8) each fail a test | DONE | Each change applied once with `helpers/mut.py`, the suite run, and the file put back. generate.js line "the second try's eligibility refusal" to `refuse(false, el.reason …`: test-first-run 1 failed. The home-skipped re-check to `refuse(false, reason …`: 1 failed. In test-provision: M12 (`&& starters` on the start action) 1 failed; M1 (`{ starters: true }`) 1 failed; M7 (closed label on open stores) 2 failed; M11 (openMissing and openPublish swapped) 1 failed; M2 (the 409 reload line removed from SetupAdmin.js) 1 failed; M4 (`s.at` dropped) 1 failed; M8 (a failed home read returns true) 1 failed |
| unit: pnpm test passes | DONE | 102 of 102 suites (see Tests) |

## Tests

```
node scripts/test-first-run.js          # 50 passed (45 before, plus 5)
node scripts/test-brand-step.js         # 52 passed (51 before, plus 1)
node scripts/test-provision.js          # 42 passed (39 before, plus 3; one rendered test gained the M2 checks)
node scripts/test-release-readers.js    # 48 passed (47 before, plus 1)
TEST_PUBLISH_PORTS=7120,7121 TEST_PUBLISH_SERVICE_PORTS=7122,7123 TEST_PUBLISH_UNDO_PORTS=7124 \
  TEST_PRODUCT_CONTENT_PORTS=7125,7126 TEST_MIGRATE_MAP_SQLD_PORT=7127 MIGRATE_DOCUMENTS_TEST_PORTS=7128,7129 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120 SHOPIFY_OAUTH_PORT=6120 DESIGN_PORT=6120 env -u CHECKOUT_MODE pnpm test   # 102 of 102, exit 0 (199.0 s)
env -u CHECKOUT_MODE pnpm build         # exit 0; only the existing Turbopack trace warning
python3 <scratch>/helpers/mut.py <worktree> <name> <file> <old|@HEAD> <new> <suite>   # one mutation, then the file is put back
```

Every store was a local file database (`scripts/support/tenant-fixture.js` or test-provision's own `.test-prov-*.db` files, now including `onbopen`, `onbm4` and `onbfail`, which the suite removes), or the suites' own sqld on my ports. Typesense was never configured. No tenant was moved to documents mode outside those local files, and nothing was written to Shopify. Nothing was left listening on 6120 or 7120 to 7129.

## Known limits

- **The half view's words live in two places.** FirstRun.js keeps its own copy, because generate.js is Node only. test-first-run fails if they drift apart. The page shows its own copy for the reason, not the server's `message`.
- **A half-finished legacy answer** has no editor link and no retry, because the new editor isn't in use there. The founder goes to the current Storefront editor on their own, which is what the words say.
- **The half view after a page reload** is gone: GET `describeFirstStore` then shows the store as it is (usually "ready" with the generator's home), with no note that the colours were not made. The brand step on the same page still offers the colours.
- **A failed policy read** offers no buttons, because the checklist can't tell which page is missing. The founder reloads the page.
- **The design-alone race** is still narrowed, not closed (P6-FIX1.md, "Two writer calls, not one batch").
- **Open store with an unreviewed starter draft:** unchanged. It gets the publish hint and no read step (P6-ONBOARD known limit; a product question for the owner, carried by P6-DRILLS).

From review:

- Test gap (the founder_started guards on the two half-finished generate paths are untested): in lib/first-run/generate.js, both `refuse(homeWritten && el.reason !== "founder_started", ...)` (the second try's checks) and `refuse(homeWritten && reason !== "founder_started", ...)` (the home-skipped re-check) can be changed to plain `refuse(homeWritten, ...)` and test-first-run still passes (my mutations R10 and R13). In that case a founder who saved their own home between the tries would get the half view, 'Your home page was made, but your colours were not. Try again.', with homeWritten true, instead of 'You've already started your home page, so it was left as it is.' Today's code is right; only the test is missing. Suggest one test: the design loses its race on try 1, the founder saves doc_home, and the answer is founder_started with no homeWritten.
- Test gap (the fallback for an unknown half-finished reason): changing halfWords' fallback in components/admin/first-run/FirstRun.js from "other" to "race" passes test-brand-step (mutation R6). The 'something_new' case only checks the shared opening words, so an unknown reason could show 'because your store changed at the same time' and no test would catch it. Not reachable today: every reason the console route can send has its own HALF_WORDS entry.
- No audit row when a run stops half way: app/api/admin/first-run/route.js writes the storefront.write audit only when r.ran && r.written. A half-finished run wrote doc_home, but it returns before any audit line. This is not a regression (the code before FIX3 skipped it too), but the audit log under-reports what was written.
- Only the start page tells the founder the colours were not made. The editor re-lists after a half-finished run (proved by mutation R9), but it gives no note saying so. After a reload the start page's half view is gone too (the packet already lists this under Known limits). This is for the owner to decide, together with the builder's manual checks.
- What I verified: on my own ports (6320 and 7320 to 7329), pnpm test passed 102 of 102 suites in 208.0 s with exit 0, and pnpm build exited 0. These mutations each failed a test: the closed-store and the open-store unreadable branches in onboarding.js (R1, R2), the unreadable words (R16), closedSource without !src (R3) and without the object check (R4), HALF_RETRY without race (R5), the legacy edit link (R7), the route's homeWritten line (R8), the editor re-list (R9), the race and writer-reason half refusals (R11, R12), the second try's eligibility refusal (R14), and the half branch limited to race only (R15). closedSource is still a pure function, safe on the edge runtime. contentSource() never returns null, so the manifest, the sitemap and legacy stores behave as before. Legacy checklists never read policy rows. The worktree was removed and no port was left listening.

## Owner checks

- **The half-finished start page:** read the six half sentences (`HALF_WORDS` in `components/admin/first-run/FirstRun.js`) and the "Try again" choice per reason as a founder would. A desktop Chrome check needs a staged race, so it was not drilled.
- **The failed-read words** on the Setup checklist ("We couldn't check your privacy and returns pages just now. Reload this page to try again.").
- **CI sqld download:** unchanged. Nothing under `.github/` was touched; its source and checksum still need your approval.
