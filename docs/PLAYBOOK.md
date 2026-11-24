# Playbook: what this project has learned

Written by the `steelthread:phase-retro` skill at the end of each phase. Read it before
orchestrating a phase. Keep it under about 80 lines: merge, reword or delete before adding.

## Building

- Agents never run `pnpm seed:design` (it wipes `.design-data/`) or `pnpm seed:roles --reset` (it deletes
  `.design-data-roles/`) without asking the owner first. A store to sign in to comes from `pnpm seed:roles`,
  which refuses rather than overwrite.

## Tests

- Browser drills reseed and wipe the checkout they run in, so they run only through `pnpm drill:<name>`
  (a throwaway worktree at HEAD, its own ports and data; the drills refuse anywhere else). Commit before
  a drill run: uncommitted code is not what it tests.
- The drill guard (`DRILL_ISOLATED_ROOT`) only stops accidents: anyone can set it by hand, and then a
  drill or `seed-design-documents.js` wipes that checkout's `.design-data`. Always use `pnpm drill:<name>`.

## Migrations

## Going live
