// The merchant console's pages (Phase 0 line 2), as plain data: one row per
// app/(console)/admin/(authed)/**/page.js with the authz action its data needs.
// scripts/test-support-reads.js fails when a page has no row or a row no page,
// wants a server-side roleAllows(actor.role, "<action>") gate in every page whose
// action a read-only role lacks, and runs every page as support (the prop sweep).
//
// Row fields:
//   page    the folder under app/(console)/admin/(authed)/ ("" is the index)
//   action  the authz string the page's data belongs to
//   params  route params for a dynamic page ("$order", "$offer", "$bundle",
//           "$experiment" and "$quiz" are the fixture's rows, P2-D)
//   note    why a page is shaped as it is, when it is not obvious

export const ADMIN_PAGES = Object.freeze([
  { page: "", action: "storefront.read", note: "redirects to onboarding while the store is closed, else to the dashboard (Phase 1 line 3)" },
  { page: "analytics", action: "orders.read" },
  // Phase 4 line 1
  { page: "apps", action: "apps.read" },
  // Phase 5 line 1
  { page: "themes", action: "storefront.read" },
  { page: "themes/[id]", action: "storefront.read", params: { id: "$theme" }, note: "the fixture's Aurora package; an unknown id is a not-found (Phase 5 line 1)" },
  { page: "apps/[id]", action: "apps.read", params: { id: "$app" }, note: "the fixture's Trust badges install; an unknown or uninstalled id is a not-found (Phase 4 line 1)" },
  { page: "automations", action: "settings.read" },
  { page: "billing", action: "settings.read" },
  { page: "bundles", action: "offers.read" },
  { page: "bundles/[id]", action: "offers.read", params: { id: "$bundle" }, note: "the fixture bundle; an unknown id is a not-found (Phase 2 line 4)" },
  { page: "catalog", action: "storefront.read" },
  { page: "dashboard", action: "storefront.read" },
  { page: "editor", action: "storefront.read" },
  { page: "editor/templates", action: "storefront.read" },
  { page: "experiments", action: "storefront.read" },
  { page: "experiments/[slug]", action: "storefront.read", params: { slug: "$experiment" }, note: "the fixture experiment; an unknown slug is a not-found (Phase 2 line 9)" },
  { page: "insights", action: "storefront.read" },
  { page: "copilot", action: "storefront.read", note: "the AI copilot (Phase 9 line 5); run buttons follow storefront.write and offers.write, support gets none" },
  { page: "integrations", action: "settings.read" },
  { page: "media", action: "storefront.read" },
  { page: "offers", action: "offers.read" },
  { page: "offers/[id]", action: "offers.read", params: { id: "$offer" }, note: "the fixture offer; an unknown id is a not-found; \"new\" is the create form (Phase 2 line 4)" },
  { page: "onboarding", action: "storefront.read", note: "the four onboarding steps (Phase 1 lines 1 and 3); every role reads it, controls a role can't use are disabled" },
  { page: "orders", action: "orders.read" },
  { page: "orders/[id]", action: "orders.read", params: { id: "$order" } },
  // Phase 2 line 10
  { page: "quizzes", action: "storefront.read" },
  { page: "quizzes/[slug]", action: "storefront.read", params: { slug: "$quiz" }, note: "the fixture quiz; an unknown slug is a not-found; \"new\" is the create form, writers only (Phase 2 line 10)" },
  { page: "releases", action: "storefront.read" },
  // Phase 6 step 0: the studio (every role reads; controls follow storefront.write / storefront.publish)
  { page: "studio", action: "storefront.read", note: "product and collection content redirect to /admin/editor; a writer's store with no home page goes to /admin/editor first" },
  { page: "settings/team", action: "team.manage", note: "staff and support get the no-access page; the team is never read for them (Phase 2 line 8)" },
  { page: "settings", action: "settings.read", note: "Details; every settings tab renders the no-access words for a role without settings.read (Phase 2 line 7)" },
  { page: "settings/audit", action: "audit.read" },
  { page: "settings/checkout", action: "settings.read" },
  { page: "settings/domains", action: "settings.read" },
  { page: "settings/help", action: "settings.read" },
  { page: "settings/privacy", action: "settings.read" },
  { page: "settings/shipping", action: "settings.read" },
  { page: "settings/markets", action: "settings.write" }, // Phase 8 line 4: admin and owner only
  { page: "settings/sync", action: "settings.read" },
  { page: "settings/tracking", action: "settings.read" },
]);
