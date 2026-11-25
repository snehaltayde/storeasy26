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
  { path: "app/fonts/geist/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "app/fonts/geist-mono/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  { path: "app/fonts/fraunces/", reason: "self-hosted woff2 files: loaded by url() in app/fonts/fonts.css and next/font/local src paths in app/fonts/fonts.js, which the walk does not read; test:fonts checks each is referenced and exists" },
  // Phase 2 line 1: the old parts the dashboard stopped importing
  { path: "components/console/charts.js", reason: "removed by Phase 2 line 10" },
  // Phase 2 line 4: the offers page no longer imports these (components/admin/offers/ replaces them)
  { path: "components/admin/OffersAdmin.js", reason: "removed by Phase 2 line 10" },
  { path: "components/admin/OfferForm.js", reason: "removed by Phase 2 line 10" },
  // Phase 2 line 5: the media page stopped importing these
  { path: "components/admin/MediaAdmin.js", reason: "removed by Phase 2 line 10" },
  // Phase 2 line 2: the old orders screens' parts, no longer imported by the new orders pages
  { path: "components/admin/OrdersAdmin.js", reason: "removed by Phase 2 line 10" },
  { path: "components/admin/CancelOrderButton.js", reason: "removed by Phase 2 line 10" },
  { path: "components/admin/ReconcileButton.js", reason: "removed by Phase 2 line 10" },
  { path: "components/admin/RetryPushButton.js", reason: "removed by Phase 2 line 10" },
  { path: "components/console/Tabs.js", reason: "removed by Phase 2 line 10" },
  // Phase 2 line 9: the analytics and insights pages stopped importing these
  { path: "components/admin/ExportCsv.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/InsightsAdmin.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/ExperimentsAdmin.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/AutomationsAdmin.js", reason: "removed by Phase 2 line 11" },
  // Phase 2 line 10: the catalog page stopped importing the old quiz (and bundle) panels
  { path: "components/admin/CommercePanels.js", reason: "removed by Phase 2 line 11" },
  // Phase 2 line 7: settings, integrations and billing stopped importing these
  { path: "components/admin/SettingsAdmin.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/OpsPanels.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/IntegrationsAdmin.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/MessagesPanel.js", reason: "removed by Phase 2 line 11" },
  { path: "components/admin/BillingAdmin.js", reason: "removed by Phase 2 line 11" },
  // Phase 2 line 6 (6a): Saved templates moved to components/admin/editor/templates/TemplatesList.js
  { path: "components/admin/SavedTemplates.js", reason: "removed by Phase 2 line 11" },
  // Phase 2 line 6: the editor no longer imports it; only old screens with rows of their own do
  { path: "components/console/PageHeader.js", reason: "removed by Phase 2 line 11" },
];
