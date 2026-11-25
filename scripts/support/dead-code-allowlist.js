// The dead-code guard's allowlist (scripts/test-no-dead-code.js, check 2):
// files nothing reaches through a literal the walk can read. Every entry says
// why it stays; a path ending in "/" covers everything under it. An entry
// fails once its file is gone or the walk reaches it, so remove it then.
// Kept apart from the guard so parallel lines each append rows (Phase 2:
// one row per old component a page stops importing, reason "removed by
// Phase 2 line 10"); when appends conflict, keep both sides.
export const ALLOWLIST = [
  { path: "components/console/README.md", reason: "the folder's notes for people (which console parts to use); Markdown is read, never imported" },
  { path: "components/ui/README.md", reason: "the folder's notes for people (the shadcn copy-in rules); Markdown is read, never imported" },
  { path: "lib/types/", reason: "TypeScript contracts that pnpm typecheck checks through tsconfig.json's include; JS modules adopt them one at a time, so nothing imports them yet" },
  // Phase 2 line 0: the shared parts lines 1-5 build on; the first new-UI page imports them
  { path: "components/kit/data-table.js", reason: "a Phase 2 line 0 shared console part for lines 1-5; remove this row when the first page imports it" },
  { path: "components/kit/empty-state.js", reason: "a Phase 2 line 0 shared console part for lines 1-5; remove this row when the first page imports it" },
  { path: "components/kit/money-cell.js", reason: "a Phase 2 line 0 shared console part for lines 1-5; remove this row when the first page imports it" },
  { path: "components/kit/page-header.js", reason: "a Phase 2 line 0 shared console part for lines 1-5; remove this row when the first page imports it" },
  { path: "components/kit/role-gate.js", reason: "a Phase 2 line 0 shared console part for lines 1-5; remove this row when the first page imports it" },
  { path: "components/kit/status-badge.js", reason: "a Phase 2 line 0 shared console part for lines 1-5; remove this row when the first page imports it" },
  { path: "components/ui/card.js", reason: "added in Phase 2 line 0 for lines 1-5; remove this row when the first page imports it" },
  { path: "components/ui/tabs.js", reason: "added in Phase 2 line 0 for lines 1-5; remove this row when the first page imports it" },
  { path: "components/ui/select.js", reason: "added in Phase 2 line 0 for lines 1-5; remove this row when the first page imports it" },
  { path: "components/ui/switch.js", reason: "added in Phase 2 line 0 for lines 1-5; remove this row when the first page imports it" },
  { path: "components/ui/checkbox.js", reason: "added in Phase 2 line 0 for lines 1-5; remove this row when the first page imports it" },
  { path: "components/ui/popover.js", reason: "added in Phase 2 line 0 for lines 1-5; remove this row when the first page imports it" },
  { path: "app/fonts/geist/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "app/fonts/geist-mono/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "app/fonts/fraunces/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
];
