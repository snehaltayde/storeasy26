// The admin API route table (Phase 0 line 1): one row per route × method ×
// action variant, as plain data. scripts/test-permissions.js calls every gated
// row as every caller and derives the expected answer from roleAllows(); its
// guard fails when a route file, method or requireAdmin action is missing here.
//
// Row fields:
//   path         under app/api/admin/ ("offers/[id]")
//   method       GET | POST | PUT | PATCH | DELETE
//   action       the authz string requireAdmin is asked for
//   variant      names a body-selected variant (rows of one path+method differ by it)
//   probe        { body } | { form } | { params }: a call that clears the gate and
//                then fails validation or finds nothing, so an allowed caller
//                changes nothing outside the throwaway databases
//   asks         what requireAdmin itself is asked for, when the route adds a
//                second check of `action` after it (team owner targets, F1)
//   via          the lib file holding the requireAdmin call, when the route delegates
//   crossOrigin  "read": a read action on a mutating method; after F2 it is
//                still refused cross-origin
//   allowStatus  [status, reason] when an allowed caller gets a 5xx for the
//                route's own reason past the gate (never 401 or 403); any other
//                status but 401/403 already counts as allowed
// "$owner", "$admin", … in a probe are swapped for that user's id.

const MISSING_ORDER = { params: { id: "ord_missing" } };
const MISSING_OFFER = { params: { id: "off_missing" } };
const DOCS = "lib/admin/documents-api.js";
const PREVIEW = "lib/admin/preview-session-api.js";
const RELEASES = "lib/admin/releases-api.js";
const SID = "ps_0000000000000000";

export const ADMIN_ROUTES = Object.freeze([
  { path: "audit", method: "GET", action: "audit.read" },
  { path: "automations", method: "GET", action: "settings.read" },
  { path: "automations", method: "POST", action: "settings.write", probe: { body: {} } },
  { path: "billing", method: "GET", action: "settings.read" },
  { path: "billing", method: "POST", action: "settings.write", probe: { body: {} } },
  { path: "brand-step", method: "GET", action: "storefront.read" },
  { path: "brand-step", method: "POST", action: "storefront.write", probe: { body: { bogus: true } } },
  { path: "bundles", method: "GET", action: "offers.read" },
  { path: "bundles", method: "POST", action: "offers.write", probe: { body: {} } },
  { path: "catalog", method: "GET", action: "storefront.read" },
  { path: "catalog", method: "POST", action: "storefront.write", probe: { body: {} } },
  // documents: parsed before it is authorized, so every probe is a valid operation
  { path: "documents", method: "PUT", variant: "listDocuments", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { listDocuments: true } } },
  { path: "documents", method: "PUT", variant: "getDocument", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { getDocument: "doc_missing" } } },
  { path: "documents", method: "PUT", variant: "listHistory", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { listHistory: "doc_missing" } } },
  // line 2 (S6): the four mode-checked reads; the guard wants a row for every DOCUMENT_READS op
  { path: "documents", method: "PUT", variant: "listRecentlyPublished", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { listRecentlyPublished: true } } },
  { path: "documents", method: "PUT", variant: "listChanges", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { listChanges: "doc_missing" } } },
  { path: "documents", method: "PUT", variant: "listProductContent", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { listProductContent: true } } },
  { path: "documents", method: "PUT", variant: "openingChecks", action: "storefront.read", via: DOCS, crossOrigin: "read", probe: { body: { openingChecks: true } } },
  { path: "documents", method: "PUT", variant: "saveDraft", action: "storefront.write", via: DOCS, probe: { body: { saveDraft: { id: "doc_missing", body: {} }, revision: 1 } } },
  { path: "documents", method: "PUT", variant: "archive", action: "storefront.write", via: DOCS, probe: { body: { archive: "doc_missing", revision: 1 } } },
  { path: "documents", method: "PUT", variant: "publish", action: "storefront.publish", via: DOCS, probe: { body: { publish: { id: "doc_missing", draftHash: "x" }, revision: 1 } } },
  { path: "documents", method: "PUT", variant: "publishSet", action: "storefront.publish", via: DOCS, probe: { body: { publishSet: [] } } },
  { path: "domains", method: "GET", action: "settings.read" },
  { path: "domains", method: "POST", action: "settings.write", probe: { body: {} } },
  { path: "experiments", method: "GET", action: "storefront.read" },
  { path: "experiments", method: "POST", action: "storefront.write", probe: { body: {} } },
  { path: "first-run", method: "GET", action: "storefront.read" },
  { path: "first-run", method: "POST", action: "storefront.write", probe: { body: {} } },
  // F3: Help needs settings.read, so staff and support cannot open it (recorded, not changed)
  { path: "help", method: "GET", action: "settings.read" },
  { path: "insights", method: "GET", action: "storefront.read" },
  { path: "insights", method: "POST", action: "storefront.write", probe: { body: {} } },
  { path: "integrations", method: "GET", action: "settings.read" },
  { path: "integrations", method: "POST", variant: "revoke", action: "settings.write", probe: { body: { action: "revoke", provider: "" } } },
  { path: "integrations", method: "POST", variant: "test", action: "settings.read", crossOrigin: "read", probe: { body: { action: "test", provider: "" } } },
  { path: "media", method: "GET", action: "storefront.read" },
  { path: "media", method: "POST", action: "storefront.write", probe: { form: {} } },
  { path: "media", method: "PATCH", action: "storefront.write", probe: { body: { id: "med_missing", archived: true } } },
  { path: "media", method: "DELETE", action: "storefront.write", probe: { body: { id: "med_missing" } } },
  { path: "media", method: "PUT", action: "storefront.read", crossOrigin: "read", probe: { body: { id: "med_missing" } } },
  { path: "offers", method: "GET", action: "offers.read" },
  { path: "offers", method: "POST", action: "offers.write", probe: { body: {} } },
  { path: "offers/[id]", method: "GET", action: "offers.read", probe: MISSING_OFFER },
  { path: "offers/[id]", method: "PUT", action: "offers.write", probe: { ...MISSING_OFFER, body: { enabled: true } } },
  { path: "offers/[id]", method: "DELETE", action: "offers.write", probe: MISSING_OFFER },
  { path: "offers/[id]/revert", method: "POST", action: "offers.write", probe: { ...MISSING_OFFER, body: {} } },
  { path: "offers/simulate", method: "POST", action: "offers.read", crossOrigin: "read", probe: { body: {} } },
  { path: "offers/targets", method: "GET", action: "offers.read" },
  { path: "onboarding", method: "GET", action: "storefront.read" },
  { path: "onboarding", method: "POST", action: "settings.write", probe: { body: { step: "" } } },
  { path: "orders", method: "GET", action: "orders.read" },
  { path: "orders/[id]", method: "GET", action: "orders.read", probe: MISSING_ORDER },
  { path: "orders/[id]", method: "POST", variant: "cancel", action: "orders.cancel", probe: { ...MISSING_ORDER, body: { action: "cancel" } } },
  { path: "orders/[id]", method: "POST", variant: "push", action: "orders.push", probe: { ...MISSING_ORDER, body: { action: "push" } }, allowStatus: [500, "push answers an unknown order with 500 'not found' (the route's own error path, past the gate)"] },
  { path: "orders/[id]", method: "POST", variant: "reconcile", action: "orders.push", probe: { ...MISSING_ORDER, body: { action: "reconcile" } } },
  { path: "policy-start", method: "POST", action: "storefront.write", probe: { body: {} } },
  { path: "preview-session", method: "POST", variant: "create", action: "storefront.read", via: PREVIEW, crossOrigin: "read", probe: { body: { create: true } } },
  { path: "preview-session", method: "POST", variant: "showDesign", action: "storefront.read", via: PREVIEW, crossOrigin: "read", probe: { body: { showDesign: { sid: SID, on: false } } } },
  { path: "preview-session", method: "POST", variant: "revoke", action: "storefront.read", via: PREVIEW, crossOrigin: "read", probe: { body: { revoke: SID } } },
  { path: "privacy", method: "GET", action: "settings.read" },
  { path: "quiz", method: "GET", action: "storefront.read" },
  { path: "quiz", method: "POST", action: "storefront.write", probe: { body: {} } },
  { path: "refs", method: "GET", action: "storefront.read", via: "lib/admin/refs.js" },
  { path: "releases", method: "GET", action: "storefront.read", via: RELEASES },
  { path: "releases", method: "POST", variant: "preview", action: "storefront.read", via: RELEASES, crossOrigin: "read", probe: { body: { action: "preview" } } },
  ...["publish", "schedule", "rollback", "cancel", "approve", "unknown"].map((v) => ({
    path: "releases",
    method: "POST",
    variant: v,
    action: "storefront.publish",
    via: RELEASES,
    probe: { body: { action: v } },
  })),
  { path: "returns", method: "GET", action: "orders.read" },
  { path: "returns", method: "POST", action: "returns.decide", probe: { body: { id: "ret_missing", action: "approve" } } },
  { path: "settings", method: "GET", action: "settings.read" },
  { path: "settings", method: "PUT", action: "settings.write", probe: { body: { bogus_setting: true } } },
  // F3: lists the caller's own memberships (line 2 checks the body)
  { path: "stores", method: "GET", action: "storefront.read" },
  { path: "sync", method: "GET", action: "storefront.read" },
  { path: "sync", method: "POST", action: "sync.run", probe: { body: {} } },
  { path: "team", method: "GET", action: "team.manage" },
  { path: "team", method: "POST", variant: "invite", action: "team.manage", probe: { body: { action: "invite", email: "not-an-email", role: "staff" } } },
  { path: "team", method: "POST", variant: "invite-owner", action: "team.owner", probe: { body: { action: "invite", email: "not-an-email", role: "owner" } } },
  { path: "team", method: "POST", variant: "role", action: "team.manage", probe: { body: { action: "role", userId: "$staff", role: "bogus" } } },
  { path: "team", method: "POST", variant: "null-body", action: "team.manage", probe: { body: null } },
  { path: "team", method: "POST", variant: "remove", action: "team.manage", probe: { body: { action: "remove", userId: "usr_missing" } } },
  // F1: changing or removing an OWNER needs team.owner. Store A has one owner,
  // so the final-owner guard refuses an allowed caller (422) and nothing changes.
  { path: "team", method: "POST", variant: "role-of-owner", action: "team.owner", asks: "team.manage", probe: { body: { action: "role", userId: "$owner", role: "staff" } } },
  { path: "team", method: "POST", variant: "remove-owner", action: "team.owner", asks: "team.manage", probe: { body: { action: "remove", userId: "$owner" } } },
  { path: "theme", method: "GET", action: "storefront.read" },
  { path: "theme", method: "POST", action: "storefront.write", probe: { body: {} } },
]);

// Routes that do not call requireAdmin, each with the rule the suite tests.
export const EXEMPT_ROUTES = Object.freeze([
  { path: "login", method: "POST", kind: "login" },
  { path: "logout", method: "POST", kind: "logout" },
  { path: "accept-invite", method: "POST", kind: "token" },
  { path: "reset", method: "POST", kind: "token" },
  { path: "handoff", method: "POST", kind: "token" },
  { path: "recover", method: "POST", kind: "recover" },
  { path: "maintenance-pass", method: "GET", kind: "maintenance-pass" },
]);
