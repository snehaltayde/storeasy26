// The reads a role without settings.read may make (Phase 0 line 2), as data:
// one probe per call, with the top-level response keys it may answer with.
// scripts/test-support-reads.js makes every probe as every such caller and
// searches the raw response for the fixture's canaries; a key outside `keys`
// fails, so a new field is looked at before it ships.
//
// Probe fields:
//   name    unique label
//   path    under app/api/admin/
//   method  GET | POST | PUT
//   variant the admin-routes.js row variant it covers (body-selected reads)
//   req     (ctx) => { body, params, query }: ctx holds the fixture's ids
//   keys    every top-level key the answer may have
//   inner   { <top-level key>: [every key that object may have] } (optional)
//   status  the status every probe caller must get (default 200)
//   note    why a probe answers a non-200

const DOC = (op, arg) => ({ path: "documents", method: "PUT", variant: op, name: `documents ${op}`, req: (ctx) => ({ body: { [op]: typeof arg === "function" ? arg(ctx) : arg } }) });

export const SUPPORT_PROBES = Object.freeze([
  // Phase 5 line 1: uploaded themes (list, archived list, a package, its file; store B's package is not on A)
  { name: "themes", path: "themes", method: "GET", keys: ["ok", "builtins", "flagships", "packages", "archived", "state"], inner: { state: ["live", "liveBrand", "liveTheme", "liveArchived", "draft", "design", "publishSet"] } },
  { name: "themes ?status=archived", path: "themes", method: "GET", req: () => ({ query: "status=archived" }), keys: ["ok", "builtins", "flagships", "packages", "archived", "state"], inner: { state: ["live", "liveBrand", "liveTheme", "liveArchived", "draft", "design", "publishSet"] } },
  { name: "themes/[id]", path: "themes/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.themeId } }), keys: ["ok", "package", "content", "tokens"], note: "tokens: Phase 6 line 2, the studio's Reset to the theme's" },
  { name: "themes/[id] ?download", path: "themes/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.themeId }, query: "download=1" }), keys: ["format", "id", "name", "version", "author", "description", "base", "tokens", "surfaces", "templates", "styles"], note: "the stored package file itself" },
  { name: "themes/[id] (store B's theme)", path: "themes/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.bThemeId } }), status: 404, keys: ["error", "code"], note: "another store's theme is not on this store" },
  // Phase 4 line 1: the apps list and an install's page (support gets no activity)
  { name: "apps", path: "apps", method: "GET", keys: ["ok", "installs", "catalog"] },
  // Phase 9 line 1: the review queue (support: no email, no order id, no reject reason)
  { name: "reviews", path: "reviews", method: "GET", keys: ["ok", "reviews", "counts", "products"], inner: { counts: ["pending", "approved", "rejected", "hidden"] } },
  { name: "reviews ?status=approved", path: "reviews", method: "GET", req: () => ({ query: "status=approved&rating=5" }), keys: ["ok", "reviews", "counts", "products"], inner: { counts: ["pending", "approved", "rejected", "hidden"] } },
  { name: "apps/[id]", path: "apps/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.appId } }), keys: ["ok", "install", "plugin"] },
  { name: "apps/[id] (secret app)", path: "apps/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.secretAppId } }), keys: ["ok", "install", "plugin"] },
  // Phase 4 line 3: an app's webhooks and deliveries (support gets no payloads,
  // never a secret; store B's app is not found on A)
  { name: "apps/[id]/webhooks", path: "apps/[id]/webhooks", method: "GET", req: (ctx) => ({ params: { id: ctx.webhookAppId } }), keys: ["ok", "endpoint", "topics", "canSeePayloads", "deliveries"] },
  { name: "apps/[id]/webhooks ?status=delivered", path: "apps/[id]/webhooks", method: "GET", req: (ctx) => ({ params: { id: ctx.webhookAppId }, query: "status=delivered&topic=order.created" }), keys: ["ok", "endpoint", "topics", "canSeePayloads", "deliveries"] },
  { name: "apps/[id]/webhooks (store B's app)", path: "apps/[id]/webhooks", method: "GET", req: (ctx) => ({ params: { id: ctx.bWebhookAppId } }), status: 404, keys: ["error", "code"], note: "another store's app is not on this store" },
  // Phase 4 line 4: an app's API access (never a token's secret or hash; calls are audit.read only)
  { name: "apps/[id]/tokens", path: "apps/[id]/tokens", method: "GET", req: (ctx) => ({ params: { id: ctx.webhookAppId } }), keys: ["ok", "scopes", "offered", "tokens", "maxActive", "expiryDays", "defaultExpiryDays"] },
  { name: "apps/[id]/tokens (store B's app)", path: "apps/[id]/tokens", method: "GET", req: (ctx) => ({ params: { id: ctx.bWebhookAppId } }), status: 404, keys: ["error", "code"], note: "another store's app is not on this store" },
  { name: "brand-step", path: "brand-step", method: "GET", keys: ["ok", "brandStep", "palettes", "themes", "current", "themeLayouts", "design", "storeOpen", "canEditDescription", "descriptionMax"], inner: { current: ["themeId", "paletteId", "logo", "description"] }, note: "themes, current.themeId, themeLayouts: Phase 7 line 1, the onboarding theme picker" },
  // Phase 4 line 2: an app's placements (ctx.installId: Trust badges, which test-support-reads installs)
  { name: "apps/[id]/blocks", path: "apps/[id]/blocks", method: "GET", req: (ctx) => ({ params: { id: ctx.installId } }), keys: ["ok", "installStatus", "blocks", "previewPaths"] },
  // Phase 9 line 4: the Shiprocket webhook key's state (never the key or its hash)
  { name: "apps/[id]/parcel-key", path: "apps/[id]/parcel-key", method: "GET", req: (ctx) => ({ params: { id: ctx.installId } }), keys: ["ok", "set", "rotatedAt", "address", "addressWarning"] },
  // Phase 9 line 3: the WhatsApp card (its access token and app secret are canaries; support sees phones masked)
  { name: "apps/[id]/whatsapp", path: "apps/[id]/whatsapp", method: "GET", req: (ctx) => ({ params: { id: ctx.whatsappAppId } }), keys: ["ok", "connection", "templates", "vars", "caps", "log"] },
  { name: "apps/[id]/whatsapp (another app)", path: "apps/[id]/whatsapp", method: "GET", req: (ctx) => ({ params: { id: ctx.appId } }), status: 404, keys: ["error", "code"], note: "only the WhatsApp install has this card" },
  { name: "bundles", path: "bundles", method: "GET", keys: ["ok", "bundles", "currency"] },
  { name: "catalog", path: "catalog", method: "GET", keys: ["ok", "products", "overrides", "collections", "shopify_admin"] },
  // P2-D: Phase 2's catalog views (lines 5 and 6)
  { name: "catalog ?view=products", path: "catalog", method: "GET", req: () => ({ query: "view=products" }), keys: ["ok", "items", "nextCursor", "counts", "total"] },
  { name: "catalog ?view=product", path: "catalog", method: "GET", req: (ctx) => ({ query: `view=product&id=${encodeURIComponent(ctx.productGid)}` }), keys: ["ok", "product", "variants", "collections", "published"] },
  { name: "catalog ?view=collections", path: "catalog", method: "GET", req: () => ({ query: "view=collections" }), keys: ["ok", "items", "published"] },
  { name: "catalog ?view=collection", path: "catalog", method: "GET", req: (ctx) => ({ query: `view=collection&id=${encodeURIComponent(ctx.collectionGid)}` }), keys: ["ok", "collection", "items", "nextCursor", "total"] },
  { name: "catalog ?product=", path: "catalog", method: "GET", req: (ctx) => ({ query: `product=${encodeURIComponent(ctx.productGid)}` }), keys: ["ok", "product", "override", "surface"] },
  { ...DOC("listDocuments", true), keys: ["ok", "documents"] },
  { ...DOC("getDocument", (ctx) => ctx.docId), keys: ["ok", "document"] },
  { ...DOC("getDocument", (ctx) => ctx.bDocId), name: "documents getDocument (store B's document)", status: 404, keys: ["error", "code"], note: "another store's document id is not on this store" },
  { ...DOC("listHistory", (ctx) => ctx.docId), keys: ["ok", "versions"] },
  { ...DOC("listRecentlyPublished", true), keys: ["ok", "rows"] },
  { ...DOC("listChanges", (ctx) => ctx.docId), keys: ["ok", "firstPublish", "rows", "sections"] },
  { ...DOC("listProductContent", true), keys: ["ok", "items", "nextCursor", "counts"] },
  { ...DOC("openingChecks", (ctx) => ({ ids: [ctx.docId] })), keys: ["ok", "opening", "items", "offer"] },
  { name: "experiments", path: "experiments", method: "GET", keys: ["ok", "experiments"] },
  { name: "experiments ?analyze=", path: "experiments", method: "GET", req: () => ({ query: "analyze=home" }), status: 404, keys: ["error"], note: "no experiment by that slug: the miss answers 404" },
  { name: "first-run", path: "first-run", method: "GET", keys: ["ok", "firstRun", "sync"] },
  { name: "onboarding", path: "onboarding", method: "GET", keys: ["ok", "supported", "open", "openKnown", "current", "doneCount", "total", "steps"] },
  { name: "sync", path: "sync", method: "GET", keys: ["ok", "sync"] },
  { name: "theme", path: "theme", method: "GET", keys: ["ok", "kits", "theme", "upgradeAvailable", "design"] },
  { name: "insights", path: "insights", method: "GET", keys: ["ok", "configured", "model", "budget", "insights"] },
  // Phase 9 line 5: the copilot page's data (support gets no run buttons: can is all false)
  { name: "copilot", path: "copilot", method: "GET", keys: ["ok", "state", "can", "products", "history"], inner: { state: ["provider", "model", "configured", "reason", "installed", "enabled", "installId", "killed", "ledgerReady", "usage"], can: ["starter", "product_seo", "offer_ideas"] } },
  { name: "media ?archived=include", path: "media", method: "GET", req: () => ({ query: "archived=include" }), keys: ["ok", "media", "limits"] },
  { name: "media ?view=library", path: "media", method: "GET", req: () => ({ query: "view=library" }), keys: ["ok", "items", "nextCursor", "counts"] },
  { name: "media PUT usage", path: "media", method: "PUT", req: (ctx) => ({ body: { id: ctx.mediaId } }), keys: ["ok", "usage"] },
  { name: "offers", path: "offers", method: "GET", keys: ["ok", "offers", "names", "currency"] },
  { name: "offers/[id]", path: "offers/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.offerId } }), keys: ["ok", "offer"] },
  { name: "offers/simulate", path: "offers/simulate", method: "POST", req: (ctx) => ({ body: { offer: ctx.offer } }), keys: ["ok", "currency", "sentence", "example", "nearMiss", "steps", "missing", "warnings", "facts", "cart", "alone", "combined", "applied", "activeOfferCount", "notes"] },
  { name: "offers/targets", path: "offers/targets", method: "GET", keys: ["ok", "tags", "types", "collections", "currency"] }, // collections: Phase 8 line 5
  { name: "orders", path: "orders", method: "GET", keys: ["ok", "orders", "nextBefore", "counts"] },
  { name: "orders ?q=<email>", path: "orders", method: "GET", req: (ctx) => ({ query: `q=${encodeURIComponent(ctx.orderEmail)}` }), keys: ["ok", "orders", "nextBefore", "counts"] },
  { name: "orders ?q=<phone>", path: "orders", method: "GET", req: (ctx) => ({ query: `q=${encodeURIComponent(ctx.orderPhone)}` }), keys: ["ok", "orders", "nextBefore", "counts"] },
  { name: "orders ?payment=cod", path: "orders", method: "GET", req: () => ({ query: "payment=cod" }), keys: ["ok", "orders", "nextBefore", "counts"] },
  { name: "orders/[id]", path: "orders/[id]", method: "GET", req: (ctx) => ({ params: { id: ctx.orderId } }), keys: ["ok", "order", "refunds", "fulfillments"] },
  { name: "preview-session create", path: "preview-session", method: "POST", variant: "create", req: () => ({ body: { create: true } }), keys: ["ok", "sid", "token", "expiresAt", "showDesign", "previewUrl"] },
  { name: "preview-session revoke (owner's)", path: "preview-session", method: "POST", variant: "revoke", req: (ctx) => ({ body: { revoke: ctx.ownerSid } }), status: 404, keys: ["error", "code"] },
  { name: "preview-session showDesign (owner's)", path: "preview-session", method: "POST", variant: "showDesign", req: (ctx) => ({ body: { showDesign: { sid: ctx.ownerSid, on: true } } }), status: 404, keys: ["error", "code"] },
  { name: "quiz", path: "quiz", method: "GET", keys: ["ok", "quizzes"] },
  { name: "quiz ?slug=", path: "quiz", method: "GET", req: () => ({ query: "slug=fit" }), status: 404, keys: ["error"], note: "no quiz by that slug: the miss answers 404" },
  { name: "quiz ?slug=<fixture>", path: "quiz", method: "GET", req: (ctx) => ({ query: `slug=${encodeURIComponent(ctx.quizSlug)}` }), keys: ["ok", "quiz", "pages"] },
  // Phase 2 line 10: the quiz editor's reads
  { name: "quiz ?view=usage", path: "quiz", method: "GET", variant: "usage", req: () => ({ query: "view=usage&slug=fit" }), keys: ["ok", "pages"] },
  { name: "quiz ?view=tags", path: "quiz", method: "GET", variant: "tags", req: () => ({ query: "view=tags" }), keys: ["ok", "tags"] },
  { name: "quiz ?view=try", path: "quiz", method: "GET", variant: "try", req: () => ({ query: "view=try&tags=fixture" }), keys: ["ok", "topTags", "products"] },
  ...["product", "collection", "variant", "bundle"].map((type) => ({
    name: `refs ${type}`,
    path: "refs",
    method: "GET",
    req: (ctx) => ({ query: `type=${type}${type === "variant" ? `&product=${encodeURIComponent(ctx.productGid)}` : ""}` }),
    keys: ["ok", "items", "nextCursor", "syncedAt"],
  })),
  { name: "releases", path: "releases", method: "GET", keys: ["ok", "documents", "mode", "message", "live", "liveRelease"] },
  { name: "releases preview", path: "releases", method: "POST", variant: "preview", req: () => ({ body: { action: "preview" } }), status: 409, keys: ["error", "code"], note: "a documents store previews from the editor (STORE_USES_DOCUMENTS)" },
  { name: "returns", path: "returns", method: "GET", keys: ["ok", "returns"] },
  { name: "stores", path: "stores", method: "GET", keys: ["ok", "stores", "current"] },
  // Phase 7 line 1: a Storeasy flagship by its slug (first-party data, the same on every store) and its file
  { name: "themes/[id] (a flagship slug)", path: "themes/[id]", method: "GET", req: () => ({ params: { id: "bloom" } }), keys: ["ok", "package", "content", "tokens"] },
  { name: "themes/[id] (a flagship slug) ?download", path: "themes/[id]", method: "GET", req: () => ({ params: { id: "bloom" }, query: "download=1" }), keys: ["format", "id", "name", "version", "author", "description", "base", "tokens", "surfaces", "templates", "styles"], note: "the flagship package file itself" },
]);
