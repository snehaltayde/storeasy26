// Files outside components/kit/ that may mark a control data-read-control
// (support's stray-control rule on a new-UI route lets a marked control pass).
// test:console-kit fails a mark outside components/kit/ without a row here,
// and any mark on a submit button or inside a form that is not method="get".
// Each row: { path, reason, marks } (the reads the controls perform, and how
// many data-read-control marks the file holds: a new mark in a listed file
// fails until its row says why and the count is raised). Phase 2 lines
// append rows; when appends conflict, keep both sides.
export const READ_CONTROLS = [
  // Phase 2 line 1: the dashboard
  { path: "components/admin/dashboard/RangeSwitch.js", reason: "the 7/30/90-day links only change ?days= on the dashboard (a GET)", marks: 1 },
  { path: "components/admin/dashboard/SalesSummary.js", reason: "a link to the onboarding page on a store with no orders (a GET)", marks: 1 },
  { path: "components/admin/dashboard/ActionQueue.js", reason: "each row links to the filtered orders list, an order, or Integrations (GETs)", marks: 2 },
  { path: "components/admin/dashboard/StoreStatus.js", reason: "links to onboarding, the storefront and Publishing (GETs)", marks: 3 },
  { path: "app/(console)/admin/(authed)/dashboard/error.js", reason: "Try again re-renders the dashboard segment (reset(), a re-read, no write)", marks: 1 },
  // Phase 2 line 4 (offers and bundles)
  { path: "components/admin/offers/OffersList.js", reason: "the state tabs (and their list, which Radix makes focusable) and the name-or-code search filter the loaded offers; \"Try again\" re-reads GET /api/admin/offers; \"Part of bundle\" links to the bundle's page", marks: 5 },
  { path: "components/admin/offers/OfferEditor.js", reason: "Cancel / Back to offers is a link to the offers list", marks: 1 },
  { path: "components/admin/offers/SimulatePanel.js", reason: "\"Try it\" asks POST /api/admin/offers/simulate (offers.read, it writes nothing: lib/offers/simulate.js) for example carts", marks: 1 },
  { path: "components/admin/bundles/BundleEditor.js", reason: "Cancel / Back to bundles is a link to the bundles list", marks: 1 },
];

// Reads sent as a non-GET request: { page, method, path, reason }, an exact
// match (the shell drill's readPost; scripts/drills/offers/run.mjs reads a
// page's [id] as one path segment). Phase 2 lines append rows; keep both sides.
export const READ_POSTS = [
  { page: "/admin/offers/[id]", method: "POST", path: "/api/admin/offers/simulate", reason: "the offer simulator (Phase 2 line 4): offers.read, example carts worked out in memory, nothing stored (scripts/support/admin-routes.js marks it a read)" },
];
