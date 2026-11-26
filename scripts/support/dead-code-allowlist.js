// The dead-code guard's allowlist (scripts/test-no-dead-code.js, check 2):
// files nothing reaches through a literal the walk can read. Every entry says
// why it stays; a path ending in "/" covers everything under it. An entry
// fails once its file is gone or the walk reaches it, so remove it then.
// Kept apart from the guard so parallel lines each append rows; when appends
// conflict, keep both sides.
export const ALLOWLIST = [
  { path: "scripts/fixtures/ai/", reason: "the stub AI provider's answers for drill:plugins (Phase 9 line 5): lib/ai/provider.js reads AI_STUB_DIR/<task>.json, a path drillEnv builds at run time, which the walk cannot see" },
  { path: "components/ui/README.md", reason: "the folder's notes for people (the shadcn copy-in rules); Markdown is read, never imported" },
  { path: "lib/types/", reason: "TypeScript contracts that pnpm typecheck checks through tsconfig.json's include; JS modules adopt them one at a time, so nothing imports them yet" },
  { path: "app/fonts/geist/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "app/fonts/geist-mono/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "app/fonts/fraunces/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "scripts/fixtures/themes/", reason: "theme package fixtures read by name through a template literal (fixture(name) in test-theme-format.js, and lines 1-3's suites and drill), which the walk cannot resolve" },
  { path: "scripts/fixtures/shiprocket/", reason: "Phase 9 line 4: recorded Shiprocket answers read by name through a template literal (lib/couriers/stub.js fixture(name), test-shiprocket.js and drill:plugins stage-shiprocket), which the walk cannot resolve" },
];
