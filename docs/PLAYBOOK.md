# Playbook: what this project has learned

Written by the `steelthread:phase-retro` skill at the end of each phase. Read it before
orchestrating a phase. Keep it under about 80 lines: merge, reword or delete before adding.

## Building

- A slice that adds a guard gets a reviewer brief with this escape list, and the guard's self-test a case
  per escape: marks on an ancestor, faked marks, content revealed after a click, submits from outside a
  form (`form=`, `formaction`, Enter), test-only reach, stale allowlist rows, folder rows hiding one file.
- Plan disjoint file lists for parallel builders and name the shared files with append-only anchors
  (`package.json`, `run-isolated.mjs`, `admin-routes.js`); conflicts are resolved by keeping both sides,
  never by loosening a test. Tests on a shared list check membership, not position (Phase 3's "nav ends
  with Operations" broke on every later append); one named line pins the final order. After resolving a
  conflicted rebase, rerun lint and the unit suite before the merge.
- A slice that touches shared storefront, order, nav, registry or documents code has `pnpm test` written into
  its builder's brief: Phase 4 (seven render suites, the nav count) and Phase 5 (the nav count again in two
  suites, the documents API shapes) each found these only at the merge check.
- Overlapping lines take main in merge order, and code conflicts are resolved by hand against each side's
  final version; only docs and append lists take "keep both" (Phase 8 broke `test-copy` and a drill list that
  way). A branch with many commits over one file takes one `git merge main`, not a per-commit rebase.
- A drill stage the builder "wrote but did not run" is unverified code: Phase 4's webhooks stage needed
  three rounds (no catalog, checkout's confirm-the-total 409, the sign-in rate limit) at merge time.
- A migration number reserved in the plan goes to whichever branch merges first: Phase 3 reserved 0016
  for line 5, line 3 needed one sooner and took it, line 5 moved to 0017. Never merge a lower number after
  a higher one has run.
- A contract or line that adds a page, nav item or full-screen route runs `drill:shell` before it merges: it
  sweeps every nav page per role and width, and Phase 6's studio contract broke it on main unseen.
- Parallel lines that share client state (one store, one document) get one named owner in the plan and the
  other line reuses it: both Phase 6 reviews found two live `doc_design` stores, once per line.
- A money line's plan lists every read of the money it changes (refunds, returns, reports, webhooks, push),
  not only the charge: Phase 8's markets passed 1,000 carts yet stored refunds in the wrong currency.
- A feature that shows money to shoppers (nudges, totals, prices) gets, in its plan, a brute-force test that
  completes every suggestion the way a shopper would (whole units, real products) and checks the engine:
  Phase 7's cart nudges needed three review rounds because each fix was tested the way it was built.
- First-party content (theme copy, seed pages) runs the banned-copy scan in its suite, and reads of a new
  column go through `hasColumns`: both slipped past Phase 7 line 1's builder and were caught in review.
- Merge only on the verdict: chain `git merge` on `steelthread-verify`'s own exit, never after a `tail` or
  `grep` of its output (Phase 5's contract merged before its one failed suite was read).
- "Drafts only" covers every document a button publishes: a publish that takes more than one document lists
  each with a checkbox, pre-ticks only what this action changed, and the server publishes exactly that set
  (Phase 5's theme Publish first took a stale home draft and unrelated editor edits).
- A "the founder chose this" signal is never a value the system fills in by default: registry defaults on
  `template` made every published header count as a choice, so themes never applied (Phase 5 line 2).

## Tests

- Every builder's own check includes `test:shopify-boundary`, `test:security`, and for any screen
  `test:console-kit` and `test:console-shell`: a console URL literal (even a `?scope=` in a comment)
  tripped the boundary scanner, and an unlisted `data-read-control` failed three Phase 3 merges, each
  time only in the session's full run. Split URL literals; give every read mark a reasoned row.
- Drills use ids, `data-*` hooks or `exact: true`, and wait for the row they read, not the table: after
  design passes, Phase 2 and 3 drills failed six times at merge on two "Open an incident" buttons, a
  label matching two fields, an old 404 wording, a sign split from its amount, and rows still loading.
- Storefront drill stages set the consent cookie and stub `/_next/image` (fixture pictures 404), filter only
  the refusal statuses they cause on purpose, and set up their own starting state, never the previous
  stage's (Phase 5's banner, pictures and 422; Phase 6's open stage changed the accent the design stage read).
- A route with a `loading.js` streams, so `notFound()` arrives with status 200: drills check the not-found
  page's words, not the status (the offers and apps drills both failed on this).
- A new credential or cross-host path runs its browser drill in the builder's own check: the support-access
  entry passed every unit test while real Chromium never posted the form (`rel=noreferrer` sent
  `Origin: null`, and the CSP's `form-action 'self'` blocked the store host).
- While a full verify runs in a worktree, reviewers there run nothing: suites share file databases in the
  worktree root, and a reviewer's `test-copy` run moved them mid-verify (`SQLITE_READONLY_DBMOVED`).
- Guards read the real thing (imports by walking files, routes by importing them), and a failing guard is
  never loosened to pass: Phase 8 line 1 exempted lazy imports and hid an Edge-rule break already on main.
- Load- and date-only failures come from time: order history by time then `rowid`, wait on a real signal,
  and pin the clock in any suite whose fixtures compare against now (`test-billing` failed once 26 Nov came).
- Browser drills reseed and wipe the checkout they run in, so they run only through `pnpm drill:<name>`
  (a throwaway worktree at HEAD, its own ports and data; the drills refuse anywhere else). Commit before
  a drill run: uncommitted code is not what it tests.
- Keep the main checkout on `main` whenever the owner may start their own server: a branch that changes the harness is worked in its own worktree, or the session switches back to `main` before handing over (2026-11-24: the owner's own `dev:design` ran phase1/provision's new harness and made `.design-data/fake-turso/`). `runHarness` also refuses any root other than `DRILL_ISOLATED_ROOT` when that is set.
- A drill that fails only in a concurrent full run is rerun alone and its `server.log` (in
  `.drill-results/<stamp>/<drill>/`) is read before it is called a flake: Phase 1's "sign-in 500 under
  load" was Turbopack failing one boot's `next/font/google` build, found only once logs were kept.

## Migrations

## Going live
