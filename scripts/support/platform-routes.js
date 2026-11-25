// The operator API route table (Phase 3 line 0): one row per route × method ×
// body action, as plain data. scripts/test-platform-permissions.js calls every
// gated row as every caller; its guard fails when a route file or exported
// method under app/api/platform has no row here, or a gated route stops calling
// requireOperator. Each line edits only its own routes' rows.
//
// Row fields:
//   path      under app/api/platform/ ("tenants/[id]")
//   method    GET | POST | PATCH | …
//   write     true for a write: cross-origin calls must get 403 before auth
//   variant   names a body-selected action (rows of one path+method differ by it)
//   probe     { body } | { params } | { query }: a call that clears the gate and
//             then fails validation or finds nothing, so an allowed caller
//             changes nothing that matters outside the throwaway databases
// An allowed caller gets anything but 401 or 403; every other caller 401.

const NO_STORE = { id: "missing-store" };
const SUBJECT = "tenant:missing-store";

const onboarding = (action) => ({ path: "onboarding", method: "POST", write: true, variant: action, probe: { body: { action, subject: SUBJECT } } });

export const PLATFORM_ROUTES = Object.freeze([
  { path: "billing", method: "GET", write: false },
  { path: "billing", method: "POST", write: true, variant: "override", probe: { body: { action: "override", tenant: "" } } },
  { path: "billing", method: "POST", write: true, variant: "clear_override", probe: { body: { action: "clear_override", tenant: "missing-store" } } },
  { path: "billing", method: "POST", write: true, variant: "plan_version", probe: { body: { action: "plan_version", plan: "" } } },
  // Phase 3 line 3: the billing screen's lists and its plan and subscription writes
  { path: "billing", method: "GET", write: false, variant: "subscriptions", probe: { query: "view=subscriptions" } },
  { path: "billing", method: "GET", write: false, variant: "events", probe: { query: "view=events&store=missing-store" } },
  { path: "billing", method: "POST", write: true, variant: "retire", probe: { body: { action: "retire", plan: "missing-plan", version: 1 } } },
  { path: "billing", method: "POST", write: true, variant: "start", probe: { body: { action: "start", tenant: "missing-store", plan: "free" } } },
  { path: "billing", method: "POST", write: true, variant: "grace", probe: { body: { action: "grace", subscription: "sub_missing", days: 1, reason: "probe" } } },
  { path: "billing", method: "POST", write: true, variant: "cancel", probe: { body: { action: "cancel", subscription: "sub_missing" } } },
  { path: "case-studies", method: "GET", write: false },
  { path: "case-studies", method: "POST", write: true, variant: "case_study", probe: { body: { case_study: {} } } },
  { path: "case-studies", method: "POST", write: true, variant: "publish_case", probe: { body: { publish_case: { slug: "missing-case", published: false } } } },
  { path: "case-studies", method: "POST", write: true, variant: "delete_case", probe: { body: { delete_case: { slug: "missing-case" } } } },
  { path: "costs", method: "GET", write: false },
  { path: "costs", method: "POST", write: true, variant: "inputs", probe: { body: { inputs: { month: "not-a-month" } } } },
  { path: "costs", method: "POST", write: true, variant: "budget", probe: { body: { budget: { tenant: "missing-store", amount: 1 } } } },
  { path: "domains", method: "GET", write: false },
  { path: "domains", method: "POST", write: true, variant: "claim", probe: { body: { action: "claim", host: "", tenant: "missing-store" } } },
  { path: "domains", method: "POST", write: true, variant: "verify", probe: { body: { action: "verify", host: "" } } },
  { path: "domains", method: "POST", write: true, variant: "remove", probe: { body: { action: "remove", host: "missing.example.test" } } },
  { path: "domains", method: "POST", write: true, variant: "primary", probe: { body: { action: "primary", host: "missing.example.test" } } },
  { path: "flags", method: "GET", write: false },
  { path: "flags", method: "GET", write: false, variant: "history", probe: { query: "history=ff_missing" } },
  { path: "flags", method: "POST", write: true, variant: "flag", probe: { body: { flag: { key: "not a key" } } } },
  { path: "flags", method: "POST", write: true, variant: "override", probe: { body: { override: { key: "ff_missing", tenant: "missing-store", on: true } } } },
  { path: "flags", method: "POST", write: true, variant: "disable", probe: { body: { disable: { key: "not a key" } } } },
  { path: "flags", method: "POST", write: true, variant: "remove", probe: { body: { remove: { key: "ff_missing" } } } },
  { path: "incidents", method: "GET", write: false },
  { path: "incidents", method: "GET", write: false, variant: "timeline", probe: { query: "timeline=inc_missing" } },
  { path: "incidents", method: "POST", write: true, variant: "open", probe: { body: { action: "open", title: "" } } },
  { path: "incidents", method: "POST", write: true, variant: "update", probe: { body: { action: "update", id: "inc_missing" } } },
  { path: "incidents", method: "POST", write: true, variant: "note", probe: { body: { action: "note", id: "inc_missing", internalNote: "probe" } } },
  { path: "incidents", method: "POST", write: true, variant: "resolve", probe: { body: { action: "resolve", id: "inc_missing" } } },
  { path: "onboarding", method: "GET", write: false },
  ...["resume", "resend_code", "signin_help", "owner_invite", "support_open", "support_revoke", "release", "cancel_store", "note"].map(onboarding),
  { path: "overview", method: "GET", write: false },
  { path: "privacy", method: "GET", write: false },
  { path: "privacy", method: "POST", write: true, variant: "redact", probe: { body: { action: "redact", tenant: "missing-store", requestId: "missing" } } },
  { path: "provisions", method: "GET", write: false },
  { path: "provisions", method: "POST", write: true, variant: "resume", probe: { body: { action: "resume", run: "" } } },
  { path: "provisions", method: "POST", write: true, variant: "compensate", probe: { body: { action: "compensate", run: "run_missing" } } },
  { path: "queues", method: "GET", write: false },
  { path: "queues", method: "POST", write: true, variant: "replay-job", probe: { body: { action: "replay", kind: "job", id: "job_missing" } } },
  { path: "queues", method: "POST", write: true, variant: "replay-inbox", probe: { body: { action: "replay", kind: "inbox", id: "inbox_missing" } } },
  { path: "queues", method: "POST", write: true, variant: "discard-job", probe: { body: { action: "discard", kind: "job", id: "job_missing" } } },
  { path: "queues", method: "POST", write: true, variant: "discard-inbox", probe: { body: { action: "discard", kind: "inbox", id: "inbox_missing" } } },
  { path: "queues", method: "POST", write: true, variant: "tick", probe: { body: { action: "tick" } } },
  { path: "stores", method: "GET", write: false, probe: { query: "check=1&slug=probe-slug" } },
  { path: "stores", method: "POST", write: true, probe: { body: {} } },
  { path: "support", method: "GET", write: false },
  { path: "support", method: "POST", write: true, variant: "grant", probe: { body: { action: "grant" } } },
  { path: "support", method: "POST", write: true, variant: "revoke", probe: { body: { action: "revoke", id: "sg_missing" } } },
  { path: "tenants", method: "GET", write: false },
  { path: "tenants", method: "GET", write: false, variant: "health", probe: { query: "health=missing-store" } },
  { path: "tenants", method: "GET", write: false, variant: "legacy", probe: { query: "legacy=1" } },
  { path: "tenants/[id]", method: "GET", write: false, probe: { params: NO_STORE } },
  { path: "tenants/[id]", method: "PATCH", write: true, variant: "update", probe: { params: NO_STORE, body: { update: {} } } },
  { path: "tenants/[id]", method: "PATCH", write: true, variant: "maintenance", probe: { params: NO_STORE, body: { maintenance: { enabled: false } } } },
  { path: "tenants/[id]", method: "PATCH", write: true, variant: "status", probe: { params: NO_STORE, body: { status: "not-a-status" } } },
  { path: "tenants/[id]", method: "PATCH", write: true, variant: "rotate", probe: { params: NO_STORE, body: { rotate: { keys: ["order_link_secret"] } } } },
  { path: "tenants/[id]", method: "POST", write: true, variant: "sync", probe: { params: NO_STORE } },
  { path: "tenants/[id]/export", method: "POST", write: true, probe: { params: NO_STORE } },
  { path: "tenants/[id]/offboard", method: "POST", write: true, probe: { params: NO_STORE, body: { confirm: "not-this-store" } } },
  { path: "themes", method: "GET", write: false },
]);

// Routes that do not take an operator session, each with its own auth (kind).
export const EXEMPT_PLATFORM_ROUTES = Object.freeze([
  { path: "login", method: "POST", kind: "login" }, // the sign-in itself (origin-checked, rate-limited)
  { path: "logout", method: "POST", kind: "logout" }, // origin-checked; revokes whatever session it is given
  { path: "billing/webhook", method: "POST", kind: "webhook" }, // the payment provider's signed callback
  { path: "tenants/[id]/export", method: "GET", kind: "token" }, // the expiring, store-bound export link is the auth
]);
