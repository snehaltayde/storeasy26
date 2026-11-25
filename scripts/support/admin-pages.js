// The merchant console's pages (Phase 0 line 2), as plain data: one row per
// app/(console)/admin/(authed)/**/page.js with the authz action its data needs.
// scripts/test-support-reads.js fails when a page has no row or a row no page,
// wants a server-side roleAllows(actor.role, "<action>") gate in every page whose
// action a read-only role lacks, and runs every page as support (the prop sweep).
//
// Row fields:
//   page    the folder under app/(console)/admin/(authed)/ ("" is the index)
//   action  the authz string the page's data belongs to
//   params  route params for a dynamic page ("$order" is the fixture order's id)
//   note    why a page is shaped as it is, when it is not obvious

export const ADMIN_PAGES = Object.freeze([
  { page: "", action: "storefront.read", note: "redirects to onboarding while the store is closed, else to the dashboard (Phase 1 line 3)" },
  { page: "analytics", action: "orders.read" },
  { page: "automations", action: "settings.read" },
  { page: "billing", action: "settings.read" },
  { page: "bundles", action: "offers.read" },
  { page: "bundles/[id]", action: "offers.read", params: { id: "bun-missing" }, note: "an unknown id is a not-found (Phase 2 line 4)" },
  { page: "catalog", action: "storefront.read" },
  { page: "dashboard", action: "storefront.read" },
  { page: "editor", action: "storefront.read" },
  { page: "editor/templates", action: "storefront.read" },
  { page: "experiments", action: "storefront.read" },
  { page: "insights", action: "storefront.read" },
  { page: "integrations", action: "settings.read" },
  { page: "media", action: "storefront.read" },
  { page: "offers", action: "offers.read" },
  { page: "offers/[id]", action: "offers.read", params: { id: "off_missing" }, note: "an unknown id is a not-found; \"new\" is the create form (Phase 2 line 4)" },
  { page: "onboarding", action: "storefront.read", note: "the four onboarding steps (Phase 1 lines 1 and 3); every role reads it, controls a role can't use are disabled" },
  { page: "orders", action: "orders.read" },
  { page: "orders/[id]", action: "orders.read", params: { id: "$order" } },
  { page: "releases", action: "storefront.read" },
  { page: "settings", action: "settings.read" },
]);
