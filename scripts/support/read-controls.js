// A READ_POSTS row's page is a route pattern: a [name] segment matches one
// path segment (/admin/offers/[id] matches /admin/offers/ofr_1, never
// /admin/offers or /admin/offers/a/b); every other part matches exactly.
export function routeMatches(pattern, path) {
  if (typeof pattern !== "string" || typeof path !== "string") return false;
  const re = pattern.split(/(\[[^\]/]+\])/).map((part) => (/^\[[^\]/]+\]$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${re}$`).test(path);
}

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
  // Phase 2 line 5: the media screen
  { path: "components/admin/media/MediaToolbar.js", reason: "the Active / Archived tabs, the search box, the tab list itself (focusable), the type and sort selects and the grid / list toggle only ask GET /api/admin/media?view=library for another page", marks: 7 },
  { path: "components/admin/media/MediaGrid.js", reason: "a file's card (and its name in the list) opens the details sheet; nothing is sent", marks: 2 },
  { path: "components/admin/media/MediaLibrary.js", reason: "Clear search, Try again and Load more ask GET /api/admin/media?view=library again", marks: 3 },
  { path: "components/admin/media/MediaSheet.js", reason: "Close, Copy URL (the clipboard) and Open full size send nothing; Where it's used is PUT /api/admin/media, a read gated on storefront.read (scripts/support/admin-routes.js) that writes nothing", marks: 4 },
  // Phase 2 line 2: the orders screens
  { path: "components/admin/orders/OrderFilters.js", reason: "view, status and payment links and the GET search form (with its hidden filter fields) only change the list's address", marks: 7 },
  { path: "components/admin/orders/OrdersList.js", reason: "Clear filters links to the unfiltered list; Try again re-runs the GET that loads more orders", marks: 2 },
  { path: "components/admin/orders/ReturnsList.js", reason: "each return's order id links to that order's page", marks: 1 },
  { path: "components/admin/orders/OrderHeader.js", reason: "Copy writes the order id to the clipboard; nothing is sent", marks: 1 },
  { path: "components/admin/orders/OrderTimeline.js", reason: "a shipment's tracking number opens the carrier's tracking page", marks: 1 },
  { path: "app/(console)/admin/(authed)/orders/[id]/page.js", reason: "View in Shopify opens the order in the store's Shopify admin", marks: 1 },
  { path: "app/(console)/admin/(authed)/orders/[id]/not-found.js", reason: "Back to orders links to the orders list", marks: 1 },
  { path: "app/(console)/admin/(authed)/orders/error.js", reason: "Try again re-renders the page, which only reads", marks: 1 },
  // Phase 2 line 3 (Catalog)
  { path: "app/(console)/admin/(authed)/catalog/page.js", reason: "links to the editor's Products list (writers only) and to the Bundles page: navigation only", marks: 2 },
  { path: "components/admin/catalog/CatalogTabs.js", reason: "the Products and Collections tabs switch what is shown; nothing is written", marks: 2 },
  { path: "components/admin/catalog/ProductsTable.js", reason: "the search box, the content and stock filter buttons, a row's name opening the product sheet, Clear, Try again and the onboarding link: GET reads and navigation", marks: 6 },
  { path: "components/admin/catalog/ProductSheet.js", reason: "the editor link (View content for support), View on store, View in Shopify and the sheet's close button: navigation only", marks: 4 },
  { path: "components/admin/catalog/CollectionsTable.js", reason: "a collection's title opens its products in a sheet, and Try again re-reads the list: GET reads", marks: 2 },
];

// Reads sent as a non-GET request: { page, method, path, reason }. page is a
// route pattern (routeMatches above); method and path match exactly (the
// shell drill's readPost). test:console-kit refuses a row without a reason, a
// GET row, and one whose path is the page itself (that would let a Server
// Action POST to the page through). Phase 2 lines append rows; keep both sides.
// test:media-library proves the media row is the usage read: storefront.read, writes nothing.
export const READ_POSTS = [
  { page: "/admin/offers/[id]", method: "POST", path: "/api/admin/offers/simulate", reason: "the offer simulator (Phase 2 line 4): offers.read, example carts worked out in memory, nothing stored (scripts/support/admin-routes.js marks it a read)" },
  // Phase 2 line 5
  { page: "/admin/media", method: "PUT", path: "/api/admin/media", reason: "\"Where it's used\" in a file's details: the usage list (mediaUsage), gated on storefront.read; it writes nothing" },
];
