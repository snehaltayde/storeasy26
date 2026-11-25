# Playbook: what this project has learned

Written by the `steelthread:phase-retro` skill at the end of each phase. Read it before
orchestrating a phase. Keep it under about 80 lines: merge, reword or delete before adding.

## Building

- Agents never run `pnpm seed:design` (it wipes `.design-data/`) or `pnpm seed:roles --reset` (it deletes
  `.design-data-roles/`) without asking the owner first. A store to sign in to comes from `pnpm seed:roles`,
  which refuses rather than overwrite.

- A plan that assumes something runs (a seed, a drill, a script) lists running it once as a first check;
  Phase 0's drill line read the code and missed a seed that crashed on retired modules, costing three rounds.
- While a builder works on a branch and runs drills, the session edits no tracked file in that checkout
  (the drill runner refuses a dirty tree); queue doc edits and commit them on the branch afterwards.

- A slice that adds a guard (dead-code, stray-control) gets a reviewer pass aimed at how it could pass
  while the bad thing exists: in Phase 1 the dead-code guard first counted test-only code as used, and
  the support read-control marker exempted whole subtrees. Each guard's self-test has a case per escape.
- Plan disjoint file lists for parallel builders and name the shared files with append-only anchors
  (`package.json`, `run-isolated.mjs`, `admin-routes.js`); Phase 1's conflicts were all in shared files
  and were resolved by keeping both sides, never by loosening a test.

## Tests

- Every builder's neighbour step includes `test:shopify-boundary` and `test:security`: a console URL
  literal (`/admin/dashboard`, `http://x/admin/login`) in a drill or test tripped the Admin-REST scanner
  three times in Phase 0 and twice more in Phase 1, each time only in the full run. Split such literals.

- Guards and allowlists read the real thing, never a hand list or a regex over source: route methods come
  from importing the module, animation utilities from the package's CSS, imports from a walk of the files.
  Reviewers found a blind spot in every hand-written guard in Phase 0.
- Tests wait on a real signal (a port listening, a pid file gone), never a fixed delay: a 300 ms sleep
  passed alone and failed under the full suite's load.

- Browser drills reseed and wipe the checkout they run in, so they run only through `pnpm drill:<name>`
  (a throwaway worktree at HEAD, its own ports and data; the drills refuse anywhere else). Commit before
  a drill run: uncommitted code is not what it tests.
- The drill guard (`DRILL_ISOLATED_ROOT`) only stops accidents: anyone can set it by hand, and then a
  drill or `seed-design-documents.js` wipes that checkout's `.design-data`. Always use `pnpm drill:<name>`.
- Keep the main checkout on `main` whenever the owner may start their own server: a branch that changes the harness is worked in its own worktree, or the session switches back to `main` before handing over (2026-11-24: the owner's own `dev:design` ran phase1/provision's new harness and made `.design-data/fake-turso/`). `runHarness` also refuses any root other than `DRILL_ISOLATED_ROOT` when that is set.

- A drill that fails only in a concurrent full run is rerun alone and its `server.log` (in
  `.drill-results/<stamp>/<drill>/`) is read before it is called a flake: Phase 1's "sign-in 500 under
  load" was Turbopack failing one boot's `next/font/google` build, found only once logs were kept.

## Migrations

## Going live
