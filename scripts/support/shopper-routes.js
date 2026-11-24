// Every route outside app/api/admin/ and every storefront page (Phase 0 line 3),
// as plain data. scripts/test-shopper-reads.js fails when a route file, a method
// or a storefront page/layout has no row here, or a row has no file.
//
// Route classes (who may call it, and what proves the caller):
//   shopper      account, cart, checkout: the caller is the _customer cookie or
//                the cart cookie, never an id in the body or the query
//   public-read  catalog reads any visitor may make; nothing shopper-owned
//   collector    write-only intake from the storefront (events, forms, errors)
//   token        proven by a signed token or an OAuth state, not a session
//   operator     the platform console (lib/platform/admin-auth.js)
//   webhook      signed provider callbacks
//   job          cron / health, behind the job secret
// Page classes: shopper (reads the shopper's cookies or an order link) or public.
//
// suite: the suite that owns the route's behaviour (null: no suite calls the
// route itself yet; its class is still guarded here).

export const SHOPPER_ROUTES = Object.freeze([
  { path: "account", methods: ["GET", "POST"], class: "shopper", suite: "test-shopper-reads.js" },
  { path: "cart", methods: ["GET", "POST"], class: "shopper", suite: "test-shopper-reads.js" },
  { path: "checkout", methods: ["POST"], class: "shopper", suite: "test-shopper-reads.js" },
  { path: "search", methods: ["GET"], class: "public-read", suite: "test-shopper-reads.js" },
  { path: "upsell", methods: ["GET"], class: "public-read", suite: "test-shopper-reads.js" },
  { path: "wishlist", methods: ["POST"], class: "public-read", suite: "test-shopper-reads.js", note: "resolves a guest's local handles against the catalog; no account data" },
  { path: "media/[id]", methods: ["GET"], class: "public-read", suite: "test-shopper-reads.js" },
  { path: "track", methods: ["POST"], class: "collector", suite: null },
  { path: "exp", methods: ["POST"], class: "collector", suite: null },
  { path: "contact", methods: ["POST"], class: "collector", suite: "test-commerce.js" },
  { path: "leads", methods: ["POST"], class: "collector", suite: "test-commerce.js" },
  { path: "quiz/[slug]", methods: ["POST"], class: "collector", suite: "test-commerce.js" },
  { path: "errors", methods: ["POST"], class: "collector", suite: null },
  { path: "preview", methods: ["GET", "POST"], class: "token", suite: "test-logout-preview.js" },
  { path: "connect/shopify/start", methods: ["GET"], class: "token", suite: null },
  { path: "connect/shopify/callback", methods: ["GET"], class: "token", suite: "test-first-sync.js" },
  { path: "platform/billing", methods: ["GET", "POST"], class: "operator", suite: "test-billing.js" },
  { path: "platform/case-studies", methods: ["GET", "POST"], class: "operator", suite: "test-case-studies.js" },
  { path: "platform/costs", methods: ["GET", "POST"], class: "operator", suite: "test-platform-ops.js" },
  { path: "platform/domains", methods: ["GET", "POST"], class: "operator", suite: "test-platform-ops.js" },
  { path: "platform/flags", methods: ["GET", "POST"], class: "operator", suite: "test-platform-ops.js" },
  { path: "platform/incidents", methods: ["GET", "POST"], class: "operator", suite: "test-platform-ops.js" },
  { path: "platform/login", methods: ["POST"], class: "operator", suite: "test-identity.js" },
  { path: "platform/logout", methods: ["POST"], class: "operator", suite: "test-logout-preview.js" },
  { path: "platform/overview", methods: ["GET"], class: "operator", suite: "test-platform-ops.js" },
  { path: "platform/privacy", methods: ["GET", "POST"], class: "operator", suite: "test-privacy.js" },
  { path: "platform/provisions", methods: ["GET", "POST"], class: "operator", suite: "test-provision.js" },
  { path: "platform/queues", methods: ["GET", "POST"], class: "operator", suite: "test-jobs.js" },
  { path: "platform/support", methods: ["GET", "POST"], class: "operator", suite: "test-platform-ops.js" },
  { path: "platform/tenants", methods: ["GET", "POST"], class: "operator", suite: "test-tenant-ops.js" },
  { path: "platform/tenants/[id]", methods: ["GET", "PATCH", "POST"], class: "operator", suite: "test-tenant-ops.js" },
  { path: "platform/tenants/[id]/export", methods: ["GET", "POST"], class: "operator", suite: "test-tenant-ops.js" },
  { path: "platform/tenants/[id]/handoff", methods: ["POST"], class: "operator", suite: "test-tenant-ops.js" },
  { path: "platform/tenants/[id]/offboard", methods: ["POST"], class: "operator", suite: "test-tenant-ops.js" },
  { path: "platform/themes", methods: ["GET"], class: "operator", suite: "test-platform-ops.js" },
  { path: "shopify/webhooks", methods: ["POST"], class: "webhook", suite: null },
  { path: "razorpay/webhook", methods: ["POST"], class: "webhook", suite: "test-payment-recovery.js" },
  { path: "platform/billing/webhook", methods: ["POST"], class: "webhook", suite: "test-billing.js" },
  { path: "jobs/forward-events", methods: ["GET", "POST"], class: "job", suite: null },
  { path: "jobs/sync-catalog", methods: ["GET", "POST"], class: "job", suite: "test-first-sync.js" },
  { path: "jobs/sync-shopify", methods: ["GET", "POST"], class: "job", suite: null },
  { path: "jobs/tick", methods: ["GET", "POST"], class: "job", suite: "test-first-sync.js" },
  { path: "health", methods: ["GET"], class: "job", suite: null },
]);

export const ROUTE_CLASSES = Object.freeze(["shopper", "public-read", "collector", "token", "operator", "webhook", "job"]);

// app/(storefront)/**/page.js and layout.js, by folder ("" is the store root).
// sweep: how test-shopper-reads.js covers it ("harness": run through
// scripts/support/page-harness.js as every caller; "public": no shopper data,
// not swept).
export const STOREFRONT_PAGES = Object.freeze([
  { page: "layout.js", class: "shopper", sweep: "harness", note: "initialCart() reads only the cart cookie" },
  { page: "account", class: "shopper", sweep: "harness" },
  { page: "account/orders/[orderId]", class: "shopper", sweep: "harness" },
  { page: "orders/[orderId]", class: "shopper", sweep: "harness" },
  { page: "checkout/confirmation/[orderId]", class: "shopper", sweep: "harness" },
  { page: "checkout", class: "shopper", sweep: "harness", note: "the cart comes from the cart cookie" },
  { page: "wishlist", class: "public", sweep: "public", note: "guest list lives in the browser; the account list comes from /api/account" },
  { page: "", class: "public", sweep: "public" },
  { page: "[...unmatched]", class: "public", sweep: "public" },
  { page: "about", class: "public", sweep: "public" },
  { page: "bundles/[slug]", class: "public", sweep: "public" },
  { page: "campaigns/[slug]", class: "public", sweep: "public" },
  { page: "collections", class: "public", sweep: "public" },
  { page: "collections/[handle]", class: "public", sweep: "public" },
  { page: "contact", class: "public", sweep: "public" },
  { page: "customers", class: "public", sweep: "public", note: "marketing case studies, not shopper accounts" },
  { page: "customers/[slug]", class: "public", sweep: "public" },
  { page: "integrations", class: "public", sweep: "public" },
  { page: "journal", class: "public", sweep: "public" },
  { page: "journal/[slug]", class: "public", sweep: "public" },
  { page: "legal/[doc]", class: "public", sweep: "public" },
  { page: "policies/[slug]", class: "public", sweep: "public" },
  { page: "pricing", class: "public", sweep: "public" },
  { page: "products/[handle]", class: "public", sweep: "public" },
  { page: "quiz/[slug]", class: "public", sweep: "public" },
  { page: "search", class: "public", sweep: "public" },
  { page: "templates", class: "public", sweep: "public" },
  { page: "trust", class: "public", sweep: "public" },
  { page: "verticals/[vertical]", class: "public", sweep: "public" },
]);

// Every other entry file under app/ outside (console)/ and api/admin/: routes
// and metadata files (sitemap, robots, manifest …), by path under app/.
// methods: a route's exported HTTP handlers (a metadata file exports a default).
export const APP_ENTRIES = Object.freeze([
  { file: "(storefront)/offline/route.js", methods: ["GET"], class: "public", note: "the offline fallback page: brand and store name only" },
  { file: "manifest.webmanifest/route.js", methods: ["GET"], class: "public", note: "the PWA manifest: name, tagline, brand colours" },
  { file: "sitemap.js", methods: [], class: "public", note: "published pages and products only; empty for a closed store" },
  { file: "robots.js", methods: [], class: "public" },
]);
