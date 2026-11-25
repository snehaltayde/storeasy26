// The operator console's pages (Phase 3 line 0), as plain data: the unit suite
// (scripts/test-platform-shell.js) checks every app/(console)/platform page has
// a row, and the shell drills read the paths. Each line adds its page paths.
//   path    the URL
//   file    the page under app/(console)/platform
//   signIn  true for the page that IS the sign-in for anyone not signed in;
//           every other page sends them to /platform
export const PLATFORM_PAGES = Object.freeze([
  { path: "/platform", file: "app/(console)/platform/page.js", signIn: true },
  { path: "/platform/onboarding", file: "app/(console)/platform/onboarding/page.js" },
  { path: "/platform/stores/new", file: "app/(console)/platform/stores/new/page.js" },
  { path: "/platform/operations", file: "app/(console)/platform/operations/page.js" },
  { path: "/platform/flags", file: "app/(console)/platform/flags/page.js" },
  { path: "/platform/incidents", file: "app/(console)/platform/incidents/page.js" },
  // line 1: the old console moved here; a store's page (a made-up id: operators get not-found)
  { path: "/platform/legacy", file: "app/(console)/platform/legacy/page.js" },
  { path: "/platform/stores/missing-store", file: "app/(console)/platform/stores/[id]/page.js" },
  { path: "/platform/billing", file: "app/(console)/platform/billing/page.js" },
]);

// the pages a signed-out or merchant visitor must be sent away from
export const OPERATOR_ONLY_PAGES = Object.freeze(PLATFORM_PAGES.filter((p) => !p.signIn).map((p) => p.path));
