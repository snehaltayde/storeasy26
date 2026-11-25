# Playbook: what this project has learned

Written by the `steelthread:phase-retro` skill at the end of each phase. Read it before
orchestrating a phase. Keep it under about 80 lines: merge, reword or delete before adding.

## Building

- A plan that assumes something runs (a seed, a drill, a script) lists running it once as a first check;
  Phase 0's drill line read the code and missed a seed that crashed on retired modules, costing three rounds.
- While a builder works on a branch and runs drills, the session edits no tracked file in that checkout
  (the drill runner refuses a dirty tree); queue doc edits and commit them on the branch afterwards.
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
- Lines cut from a sibling's unmerged commit (to overlap work) rebase onto each sibling as it lands, in
  merge order, and a reviewer confirms no sibling fix was dropped (Phase 4 line 4 was cut before line 3's
  review fixes and would have reverted them).
- A drill stage the builder "wrote but did not run" is unverified code: Phase 4's webhooks stage needed
  three rounds (no catalog, checkout's confirm-the-total 409, the sign-in rate limit) at merge time.
- A migration number reserved in the plan goes to whichever branch merges first: Phase 3 reserved 0016
  for line 5, line 3 needed one sooner and took it, line 5 moved to 0017. Never merge a lower number after
  a higher one has run.
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
- Storefront drill stages set the consent cookie and stub `/_next/image` (the roles store's fixture pictures
  404), and each stage filters only the refusal statuses it causes on purpose (Phase 5: the banner covered
  Checkout, missing pictures and the evil upload's 422 each failed the console check).
- A route with a `loading.js` streams, so `notFound()` arrives with status 200: drills check the not-found
  page's words, not the status (the offers and apps drills both failed on this).
- A new credential or cross-host path runs its browser drill in the builder's own check: the support-access
  entry passed every unit test while real Chromium never posted the form (`rel=noreferrer` sent
  `Origin: null`, and the CSP's `form-action 'self'` blocked the store host).
- While a full verify runs in a worktree, reviewers there run nothing: suites share file databases in the
  worktree root, and a reviewer's `test-copy` run moved them mid-verify (`SQLITE_READONLY_DBMOVED`).
- History reads order by time, then insertion order (`rowid`), never a random id: flag history came back
  in either order for same-millisecond rows, and only under the full suite's load.
- Guards and allowlists read the real thing, never a hand list or a regex over source: route methods come
  from importing the module, animation utilities from the package's CSS, imports from a walk of the files.
  Reviewers found a blind spot in every hand-written guard in Phase 0.
- Tests wait on a real signal (a port listening, a pid file gone), never a fixed delay: a 300 ms sleep
  passed alone and failed under the full suite's load.
- Browser drills reseed and wipe the checkout they run in, so they run only through `pnpm drill:<name>`
  (a throwaway worktree at HEAD, its own ports and data; the drills refuse anywhere else). Commit before
  a drill run: uncommitted code is not what it tests.
- Keep the main checkout on `main` whenever the owner may start their own server: a branch that changes the harness is worked in its own worktree, or the session switches back to `main` before handing over (2026-11-24: the owner's own `dev:design` ran phase1/provision's new harness and made `.design-data/fake-turso/`). `runHarness` also refuses any root other than `DRILL_ISOLATED_ROOT` when that is set.
- A drill that fails only in a concurrent full run is rerun alone and its `server.log` (in
  `.drill-results/<stamp>/<drill>/`) is read before it is called a flake: Phase 1's "sign-in 500 under
  load" was Turbopack failing one boot's `next/font/google` build, found only once logs were kept.

## Migrations

## Going live
