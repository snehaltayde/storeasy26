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
  // Phase 4 line 4: API access
  { path: "components/admin/apps/ApiAccessCard.js", reason: "Try again re-asks GET /api/admin/apps/[id]/tokens after a failed read", marks: 1 },
  { path: "components/admin/apps/CallLog.js", reason: "Refresh re-asks GET /api/admin/apps/[id]/calls", marks: 1 },
  // Phase 4 line 3: webhooks
  { path: "components/admin/apps/DeliveriesTable.js", reason: "the Status and Event filters re-ask GET /api/admin/apps/[id]/webhooks with a query, and View opens the delivery's payload (already read) in a dialog; no write", marks: 3 },
  { path: "components/admin/apps/WebhooksCard.js", reason: "Try again re-asks GET /api/admin/apps/[id]/webhooks after a failed read", marks: 1 },
  // Phase 4 line 1: Apps
  // Phase 5 line 1
  { path: "components/admin/themes/ThemeDetail.js", reason: "Download package is a link to GET /api/admin/themes/[id]?download (storefront.read); no write", marks: 1 },
  { path: "components/admin/themes/ThemeLibrary.js", reason: "the Installed / Archived filter is a pair of links to /admin/themes with a ?status query; no write", marks: 2 },
  { path: "components/admin/apps/AppsList.js", reason: "the Installed / Browse tabs (and their list, which Radix makes focusable) only switch the shown tab, and Browse apps switches to the Browse tab; no write", marks: 4 },
  { path: "components/admin/apps/AppCatalog.js", reason: "Open is a link to an installed app's page (a GET)", marks: 1 },
  // Phase 4 line 2: an app's "Where it shows" card
  { path: "components/admin/apps/PlacementsCard.js", reason: "Try again re-reads the card's own GET (apps.read); Preview on store opens the founder preview (POST /api/admin/preview-session, storefront.read, which writes no store content) at a page with that slot", marks: 2 },
  // Phase 3 line 1: the operator Stores list and store page
  { path: "components/platform/stores/StoresTable.js", reason: "Refresh, Try again and Clear filters only re-ask GET /api/platform/tenants (or change the list's address); nothing is sent", marks: 3 },
  { path: "components/platform/stores/FleetStrip.js", reason: "Try again re-asks GET /api/platform/overview", marks: 1 },
  { path: "components/platform/stores/HealthCard.js", reason: "Try again re-asks GET /api/platform/tenants?health=<id>", marks: 1 },
  { path: "components/platform/stores/StoreDetail.js", reason: "Open storefront and the onboarding-sheet and billing links are GETs", marks: 3 },
  // Phase 3 line 6: the operator Operations tabs
  { path: "components/platform/operations/OperationsTabs.js", reason: "the tab triggers only switch the shown tab (and ?tab=), no write", marks: 1 },
  // Phase 3 line 4: the operator Incidents list
  { path: "components/platform/incidents/IncidentsScreen.js", reason: "each incident row only opens its detail sheet (a client view, no write)", marks: 1 },
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
  // Phase 2 line 8: the team screen
  { path: "components/admin/team/TeamPage.js", reason: "Try again re-reads GET /api/admin/team after a failed load", marks: 1 },
  // Phase 2 line 9: analytics and insights
  { path: "components/admin/analytics/AnalyticsTables.js", reason: "the 7/30/90-day links only change ?days= on the analytics page, and Try again reloads it (GETs)", marks: 2 },
  { path: "components/admin/analytics/CsvButton.js", reason: "CSV builds a file in the browser from the aggregated rows on screen; nothing is sent", marks: 1 },
  { path: "components/admin/insights/InsightsList.js", reason: "Try again re-reads GET /api/admin/insights; \"Show the numbers\" opens a <details>; \"Open in editor\" is a link to the editor", marks: 3 },
  { path: "components/admin/experiments/ExperimentsList.js", reason: "the status tabs (and their list, which Radix makes focusable) filter the loaded experiments; Try again re-renders the page (router.refresh(), a GET)", marks: 3 },
  { path: "components/admin/experiments/AnalysisPanel.js", reason: "\"Open in editor\" after keeping a variant is a link to the editor", marks: 1 },
  // Phase 2 line 10 (quizzes)
  { path: "components/admin/quizzes/QuizList.js", reason: "the search box and Clear search filter the quizzes already on the page; nothing is sent", marks: 2 },
  { path: "components/admin/quizzes/QuizEditor.js", reason: "Open on the store (the quiz's public page in a new tab) and Back to quizzes / Cancel (a link to the list): navigation only", marks: 2 },
  { path: "components/admin/quizzes/QuizTry.js", reason: "\"Try it\": each question's radio group (Radix makes the group itself focusable), the answer radios, Show the picks and Start again score in the page (scoreQuiz) and ask GET /api/admin/quiz?view=try (storefront.read) for the picks; nothing is saved", marks: 4 },
  // Phase 2 line 7: settings, integrations and billing
  { path: "components/admin/settings/NoAccess.js", reason: "the no-access page's link to the dashboard (a GET)", marks: 1 },
  { path: "components/admin/settings/SettingsNav.js", reason: "the section nav: the phone's section select and each tab's link only open another settings page (GETs)", marks: 2 },
  { path: "components/admin/settings/SaveBar.js", reason: "Try again on a tab that reads in the browser asks its GET again", marks: 1 },
  { path: "components/admin/settings/CheckoutForm.js", reason: "\"Test keys\" asks POST /api/admin/integrations { action: \"test\" } (settings.read): it checks the saved keys with Razorpay and stores nothing", marks: 1 },
  { path: "components/admin/settings/DomainsList.js", reason: "Copy puts a domain's TXT value on the clipboard; nothing is sent", marks: 1 },
  { path: "components/admin/settings/AuditTable.js", reason: "the who and what selects, the two dates, Try again, Clear filters and Load more only ask GET /api/admin/audit for another page", marks: 7 },
  { path: "components/admin/settings/HelpPanel.js", reason: "Copy diagnostics (the clipboard) and the mailto link to Storeasy's team send nothing from the page", marks: 2 },
  { path: "components/admin/integrations/IntegrationsList.js", reason: "Test asks POST /api/admin/integrations { action: \"test\" } (settings.read): the cheapest provider check, it stores nothing", marks: 1 },
  // Phase 6 step 0: the studio shell
  { path: "components/admin/studio/Studio.js", reason: "the Sections and Design tab buttons only switch the shown rail", marks: 1 },
  { path: "components/admin/studio/DesignRail.js", reason: "Open the design opens doc_design in the studio (getDocument, a read)", marks: 1 },
  { path: "app/(console)/admin/(authed)/studio/error.js", reason: "Try again re-renders the page (a re-read, no write)", marks: 1 },
  // Phase 2 line 6 (6a): the editor frame, the page list, the tree, templates
  { path: "components/admin/editor/DocumentEditor.js", reason: "the page-list toggle, the phone tabs (Sections, Edit, Preview, and their group, which Radix makes focusable), the tablet preview toggle, the writing view's preview toggle, Earlier versions (listHistory, a document read), \"Edit the page's details\" (a selection) and Try again (getDocument) only show, select or read", marks: 8 },
  { path: "components/admin/editor/Switcher.js", reason: "the search box, Show archived pages (listDocuments with includeArchived, a read), the product filters, Show more products (listProductContent) and each page, product and collection row (opens it in the editor, a GET) only read", marks: 7 },
  { path: "components/admin/editor/StatusLine.js", reason: "Try the preview again asks for a new preview session (POST /api/admin/preview-session, storefront.read)", marks: 1 },
  { path: "components/admin/editor/tree/SectionTree.js", reason: "a row's own button selects the section (nothing is sent); a section's blocks open and close", marks: 2 },
  { path: "components/admin/editor/templates/TemplatesList.js", reason: "Open it in the editor is a link to the new page (a GET)", marks: 1 },
  { path: "app/(console)/admin/(authed)/editor/error.js", reason: "Try again re-renders the editor segment (reset(), a re-read, no write)", marks: 1 },
  // Phase 2 line 6 (6c): the preview and Publishing
  { path: "components/admin/editor/PreviewPane.js", reason: "the device widths (and their group, which Radix makes focusable) only resize the frame; Show design changes (and its label) is setShowDesign on the preview session (POST /api/admin/preview-session, storefront.read); Reload reloads the frame or opens an ended session again (the same POST); Open in a new tab is a GET of the store page", marks: 6 },
  { path: "components/admin/editor/publish/RecentlyPublished.js", reason: "Open in the editor is a link to that page in the editor (a GET)", marks: 1 },
  { path: "components/admin/releases/WaitingList.js", reason: "Open in the editor is a link to that page in the editor (a GET)", marks: 1 },
  { path: "components/admin/releases/PublishingPage.js", reason: "Try again reads the pages waiting to publish again (listDocuments, a document read)", marks: 1 },
  // Phase 2 line 11: the console's own error page
  { path: "app/(console)/admin/(authed)/error.js", reason: "Try again re-renders the failed page's segment (reset(), a re-read, no write)", marks: 1 },
];

// Reads sent as a non-GET request: { page, method, path, reason, body? }. page
// is a route pattern (routeMatches above); method and path match exactly (the
// shell drill's readPost). body (Phase 2 line 7): when a path also takes writes
// (POST /api/admin/integrations is Test and Revoke), the fields the request's
// JSON body must carry, compared by bodyMatches below; a request without a
// readable JSON body, or a server-log line, never matches such a row. test:console-kit refuses a row without a reason, a
// GET row, and one whose path is the page itself (that would let a Server
// Action POST to the page through). Phase 2 lines append rows; keep both sides.
// test:media-library proves the media row is the usage read: storefront.read, writes nothing.
export const READ_POSTS = [
  { page: "/admin/offers/[id]", method: "POST", path: "/api/admin/offers/simulate", reason: "the offer simulator (Phase 2 line 4): offers.read, example carts worked out in memory, nothing stored (scripts/support/admin-routes.js marks it a read)" },
  // Phase 2 line 5
  { page: "/admin/media", method: "PUT", path: "/api/admin/media", reason: "\"Where it's used\" in a file's details: the usage list (mediaUsage), gated on storefront.read; it writes nothing" },
  // Phase 2 line 7 (test:settings-ui proves the test action writes nothing)
  { page: "/admin/settings/checkout", method: "POST", path: "/api/admin/integrations", body: { action: "test" }, reason: "\"Test keys\": the integrations test action (settings.read), a provider check that stores nothing" },
  { page: "/admin/integrations", method: "POST", path: "/api/admin/integrations", body: { action: "test" }, reason: "a provider's Test: the integrations test action (settings.read), a provider check that stores nothing" },
  // Phase 2 line 6: the editor's and Publishing's document reads (ops: the
  // body's single top-level key must be one of them; never saveDraft), and
  // the preview session (storefront.read in admin-routes.js)
  { page: "/admin/editor", method: "PUT", path: "/api/admin/documents", ops: ["listDocuments", "getDocument", "listHistory", "listProductContent", "listChanges", "openingChecks"], reason: "the editor's reads: the page list, the open document, Earlier versions, the products in the page list, what changed since live and the opening checks (DOCUMENT_READS; support's store never sends saveDraft)" },
  { page: "/admin/editor", method: "POST", path: "/api/admin/preview-session", reason: "the preview's session (create, showDesign, revoke), storefront.read: it lets this browser see the draft and writes no content" },
  { page: "/admin/releases", method: "PUT", path: "/api/admin/documents", ops: ["listRecentlyPublished", "listDocuments", "getDocument", "listChanges"], reason: "Publishing's reads: recently published, the pages waiting to publish and what changed in each (DOCUMENT_READS)" },
];

// A READ_POSTS row's body rule: no `body` matches any request; otherwise the
// request's body must be JSON and hold every listed field with that exact value.
//   body: the request's raw body (a string), or undefined when it can't be read
export function bodyMatches(row, body) {
  if (!row?.body) return true;
  let parsed;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : null;
  } catch {
    return false;
  }
  return parsed != null && typeof parsed === "object" && Object.entries(row.body).every(([k, v]) => JSON.stringify(parsed[k]) === JSON.stringify(v));
}
